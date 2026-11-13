/**
 * tests/test-email-code.mjs
 * 邮箱验证码单元测试：用 esbuild 即时转译 src/email-code.ts，配一个内存 KV，
 * 直接验证「用途隔离 / 一次性 / 错误计数 / 新码覆盖」这些不依赖 SMTP 的规则。
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  entryPoints: [join(root, "src", "email-code.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
);
const { putCode, checkCode, codeKey, attemptKey, CODE_TTL_SECONDS, CODE_MAX_ATTEMPTS } = mod;

/** 内存 KV，语义对齐 EdgeOne Blob 包装层 */
function makeKV() {
  const map = new Map();
  return {
    map,
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async put(k, v) { map.set(k, String(v)); },
    async delete(k) { map.delete(k); },
  };
}

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(`${name}${detail ? " → " + detail : ""}`);
}
const eq = (name, a, b) => ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);

// 1. 正常校验并消费
{
  const kv = makeKV();
  await putCode(kv, "register", "a@x.com", "123456");
  eq("正确验证码通过", (await checkCode(kv, "register", "a@x.com", "123456")).ok, true);
  eq("验证码用后即失效", (await checkCode(kv, "register", "a@x.com", "123456")).reason, "absent");
  eq("成功消费后不留计数键", kv.map.has(attemptKey("register", "a@x.com")), false);
}

// 2. 用途隔离：重置码不能拿去登录，登录码不能拿去注册
{
  const kv = makeKV();
  await putCode(kv, "reset", "b@x.com", "654321");
  eq("重置码在登录用途不可用", (await checkCode(kv, "login", "b@x.com", "654321")).reason, "absent");
  eq("重置码在注册用途不可用", (await checkCode(kv, "register", "b@x.com", "654321")).reason, "absent");
  eq("重置码在重置用途可用", (await checkCode(kv, "reset", "b@x.com", "654321")).ok, true);

  const kv2 = makeKV();
  await putCode(kv2, "login", "c@x.com", "111111");
  eq("登录码在重置用途不可用", (await checkCode(kv2, "reset", "c@x.com", "111111")).reason, "absent");
}

// 3. 错误计数与锁定
{
  const kv = makeKV();
  await putCode(kv, "login", "d@x.com", "222222");
  for (let i = 1; i < CODE_MAX_ATTEMPTS; i++) {
    const r = await checkCode(kv, "login", "d@x.com", "000000");
    eq(`第 ${i} 次输错返回 mismatch`, r.reason, "mismatch");
  }
  const locked = await checkCode(kv, "login", "d@x.com", "000000");
  eq("达到上限返回 locked", locked.reason, "locked");
  eq("锁定后验证码被作废", await kv.get(codeKey("login", "d@x.com")), null);
  eq("锁定后即使输入正确码也不可用", (await checkCode(kv, "login", "d@x.com", "222222")).reason, "absent");
}

// 4. 新码覆盖旧码并重置计数
{
  const kv = makeKV();
  await putCode(kv, "login", "e@x.com", "333333");
  await checkCode(kv, "login", "e@x.com", "000000");
  await putCode(kv, "login", "e@x.com", "444444");
  eq("新码下发清空错误计数", await kv.get(attemptKey("login", "e@x.com")), null);
  eq("新码下发后旧码失效", (await checkCode(kv, "login", "e@x.com", "333333")).reason, "mismatch");
  eq("新码本身可用", (await checkCode(kv, "login", "e@x.com", "444444")).ok, true);
}

// 5. 空输入按不匹配处理，且不会误判为通过
{
  const kv = makeKV();
  await putCode(kv, "register", "f@x.com", "555555");
  eq("空验证码不通过", (await checkCode(kv, "register", "f@x.com", "")).reason, "mismatch");
  eq("undefined 验证码不通过", (await checkCode(kv, "register", "f@x.com", undefined)).reason, "mismatch");
  eq("前后空格被忽略", (await checkCode(kv, "register", "f@x.com", " 555555 ")).ok, true);
}

// 6. 有效期常量
eq("验证码有效期 10 分钟", CODE_TTL_SECONDS, 600);

console.log(`\n=== email-code 单元测试：通过 ${pass} 项 ===`);
if (fails.length) {
  for (const f of fails) console.error("❌ " + f);
  process.exit(1);
}
console.log("🎉 全部通过");
