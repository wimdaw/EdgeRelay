/**
 * tests/test-auth-policy.mjs
 * 认证策略判定的单元测试。重点锁定「字段缺失 = 强制验证」这一 fail-closed 语义：
 * 老部署的配置快照没有该字段，任何改成真值判断的"简化"都必须在这里被拦住。
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  entryPoints: [join(root, "src", "auth-policy.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
);
const { isEmailVerificationRequired } = mod;

let pass = 0;
const fails = [];
function eq(name, actual, expected) {
  if (actual === expected) { pass++; return; }
  fails.push(`${name} → 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// 1. 历史配置：完全没有该字段时必须是「强制验证」
eq("settings 为空对象时强制验证", isEmailVerificationRequired({}), true);
eq("字段为 undefined 时强制验证", isEmailVerificationRequired({ requireEmailVerification: undefined }), true);
eq("settings 为 null 时强制验证", isEmailVerificationRequired(null), true);
eq("不传参数时强制验证", isEmailVerificationRequired(), true);

// 2. 显式开关
eq("显式开启时强制验证", isEmailVerificationRequired({ requireEmailVerification: true }), true);
eq("显式关闭时不强制验证", isEmailVerificationRequired({ requireEmailVerification: false }), false);

// 3. 不能被其他字段的存在带偏
eq(
  "无关字段不影响判定",
  isEmailVerificationRequired({ signupsEnabled: false, requireTosAcceptance: true }),
  true
);

console.log(`\n=== auth-policy 单元测试：通过 ${pass} 项 ===`);
if (fails.length) {
  for (const f of fails) console.error("❌ " + f);
  process.exit(1);
}
console.log("🎉 全部通过");
