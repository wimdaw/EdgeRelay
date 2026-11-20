/**
 * tests/test-qoder-cosy.mjs
 * Qoder COSY 协议单元测试：自定义 base64、设备指纹派生、签名头形态。
 *
 * 关键向量来自参考实现 shuishuipingan/qoder2api-hub 的 qoder_sign.py，
 * 逐字节对齐换表、1/3 旋转与 sha512/base64url 截断规则。签名错误会直接
 * 导致上游 401/403，这类回归必须在本地拦住。
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  entryPoints: [join(root, "src", "oauth", "qoder-cosy.ts")],
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

eq("qoderEncode 纯文本", mod.qoderEncode("hello {}"), "mkw$uHq&PHFr");
eq("qoderEncode JSON", mod.qoderEncode('{"a":"1","b":"2"}'), "l*BYBEw$V,BrBOB*mYKiBMn*");
eq(
  "qoderEncode 消息体",
  mod.qoderEncode('{"messages":[{"role":"user","content":"hi"}]}'),
  "u(QwDSQwBMn*PHz*eF.WNOWrD,ByBEF^DxB*GoKMmYKtDxj^#SJLNYBySkr*"
);
eq("qoderEncode UTF-8", mod.qoderEncode("中文测试"), "GycAF)PZQUSQG*tQ");

eq("machineId", mod.deriveMachineId("uid123"), "1687c6e4-8dc1-45b5-a579-f6b7d6945f02");
eq("machineToken", await mod.deriveMachineToken("uid123"), "jCBgj_51eQtrwVkjCoGuKX5vNea5OhTy4DFOQndvVLG");
eq("machineType", mod.deriveMachineType("uid123"), "bbd9e301f4704fefa6");
eq("hostname", mod.deriveMachineHostname("uid123"), "DESKTOP-F0F09BC");

eq("sortedJson", mod.sortedJson({ b: "2", a: "1" }), '{"a":"1","b":"2"}');

const session = await mod.createCosySession(
  {
    name: "tester",
    aid: "uid123",
    uid: "uid123",
    userType: "personal_standard",
    securityOauthToken: "dt-abc",
    refreshToken: "drt-abc",
  },
  "uid123"
);
eq("cosyKey 为 128 字节 RSA 密文", Buffer.from(session.cosyKey, "base64").length, 128);
eq("info 非空", session.info.length > 20, true);

const headers = mod.cosyHeaders(
  session,
  mod.qoderEncode('{"x":1}'),
  "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1",
  { model: "auto", sse: true }
);
const bearer = /^Bearer COSY\.([^.]+)\.([0-9a-f]{32})$/.exec(headers.authorization);
eq("Authorization 形态", !!bearer, true);
eq("payload 为 base64", Buffer.from(bearer[1], "base64").length > 0, true);
eq("SSE 带 machinehostname", !!headers["cosy-machinehostname"], true);
eq("模型头", headers["x-model-key"], "auto");
eq("协议版本", headers["cosy-version"], "1.1.75");

console.log(`\n=== qoder-cosy 单元测试：通过 ${pass} 项，失败 ${fail} 项 ===`);
if (fail) process.exit(1);
console.log("🎉 全部通过");
