/**
 * tests/test-zcode-region.mjs
 * ZCode 登录区域映射单元测试。
 *
 * 背景：2026-11 智谱把 ZCode 登录从 bigmodel 微信扫码迁到了 Z.ai OAuth
 * （国际 chat.z.ai / 国内 zchat.z.ai）。provider 参数写错会直接导致
 * authorize_url 指向错误站点（实测 provider=cn/zhipu/zchat 全部 code:1000），
 * 而这类错误在本地只能靠这层映射拦住。
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  entryPoints: [join(root, "src", "oauth", "zcode-region.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
);

let pass = 0;
let fail = 0;
function eq(name, actual, expected) {
  if (actual === expected) {
    console.log(`✅ PASS: ${name}`);
    pass++;
  } else {
    console.error(`❌ FAIL: ${name}\n  actual:   ${actual}\n  expected: ${expected}`);
    fail++;
  }
}

// baseUrl → provider
eq("国际版 chat.z.ai", mod.zcodeProviderFor("https://chat.z.ai"), "zai");
eq("国内版 zchat.z.ai", mod.zcodeProviderFor("https://zchat.z.ai"), "zai_cn");
eq("国内版带路径", mod.zcodeProviderFor("https://zchat.z.ai/api/oauth"), "zai_cn");
eq("网关 zcode.z.ai 归国际版", mod.zcodeProviderFor("https://zcode.z.ai"), "zai");
eq("旧国内版 bigmodel", mod.zcodeProviderFor("https://open.bigmodel.cn/api/anthropic"), "bigmodel");
eq("空 baseUrl 默认国际版", mod.zcodeProviderFor(""), "zai");
eq("未传 baseUrl 默认国际版", mod.zcodeProviderFor(undefined), "zai");
eq("大小写不敏感", mod.zcodeProviderFor("HTTPS://ZCHAT.Z.AI"), "zai_cn");
eq("空白字符容错", mod.zcodeProviderFor("  https://zchat.z.ai  "), "zai_cn");

// 登录落点（改这里等于改登录地址，必须逐字核对）
eq("zai 落点", mod.ZCODE_AUTHORIZE_HOST.zai, "https://chat.z.ai");
eq("zai_cn 落点", mod.ZCODE_AUTHORIZE_HOST.zai_cn, "https://zchat.z.ai");
eq("bigmodel 落点", mod.ZCODE_AUTHORIZE_HOST.bigmodel, "https://bigmodel.cn");

// 只有 zai / zai_cn / bigmodel 三个合法值
eq("provider 取值集合", Object.keys(mod.ZCODE_AUTHORIZE_HOST).sort().join(","), "bigmodel,zai,zai_cn");

console.log(`\n=== zcode-region 单元测试：通过 ${pass} 项，失败 ${fail} 项 ===`);
if (fail) process.exit(1);
console.log("🎉 全部通过");
