/**
 * tests/test-trae-region.mjs
 * Trae 国内版 / 国际版双区接入单元测试。
 *
 * 重点锁住三类容易"看起来没问题、上线就 401"的行为：
 *  1. 区域判定：baseUrl 决定走 trae.cn 还是 trae.ai 两套账号体系
 *  2. 鉴权头：国内 Cloud-IDE-JWT，国际 Bearer（混用会直接 4015）
 *  3. 协议体：messages.content 必须是 parts 数组，模型名不能带 trae-cn/ 前缀
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  entryPoints: [join(root, "src", "oauth", "trae.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
  // 只需要纯函数与协议转换，存储层用内存实现即可；
  // 把 @edgeone/pages-blob 一起打进来，避免 data: URL 里解析裸模块名
  define: { "process.env.NODE_ENV": '"test"' },
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
);

let pass = 0;
let fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`✅ PASS: ${name}`);
    pass++;
  } else {
    console.error(`❌ FAIL: ${name}\n  actual:   ${a}\n  expected: ${e}`);
    fail++;
  }
}
function ok(name, cond, detail = "") {
  if (cond) {
    console.log(`✅ PASS: ${name}`);
    pass++;
  } else {
    console.error(`❌ FAIL: ${name}${detail ? `\n  ${detail}` : ""}`);
    fail++;
  }
}

/* ---------------- 1. 区域判定 ---------------- */
eq("国内 mchost", mod.regionFromBaseUrl("https://trae-api-cn.mchost.guru"), "cn");
eq("国内 www.trae.cn", mod.regionFromBaseUrl("https://www.trae.cn"), "cn");
eq("国内 api.trae.com.cn", mod.regionFromBaseUrl("https://api.trae.com.cn"), "cn");
eq("国内带路径", mod.regionFromBaseUrl("https://trae-api-cn.mchost.guru/api/ide/v1"), "cn");
eq("大小写不敏感", mod.regionFromBaseUrl("HTTPS://TRAE-API-CN.MCHOST.GURU"), "cn");
eq("国际 traeapi.us", mod.regionFromBaseUrl("https://core-normal.traeapi.us"), "global");
eq("国际 trae.ai", mod.regionFromBaseUrl("https://coresg-normal.trae.ai"), "global");
eq("空 baseUrl 默认国际", mod.regionFromBaseUrl(""), "global");
eq("未传 baseUrl 默认国际", mod.regionFromBaseUrl(undefined), "global");
eq("空白容错", mod.regionFromBaseUrl("  https://trae-api-cn.mchost.guru  "), "cn");

/* ---------------- 2. 端点表（改这里等于改落点，必须逐字核对） ---------------- */
const cn = mod.traeEndpoints({}, "cn");
const gl = mod.traeEndpoints({}, "global");
eq("国内数据面", cn.core, "https://trae-api-cn.mchost.guru");
eq("国内账号面", cn.account, "https://api.trae.com.cn");
eq("国内授权页", cn.authorizeHost, "https://www.trae.cn");
eq("国内鉴权方案", cn.authScheme, "cloudide");
eq("国际数据面", gl.core, "https://core-normal.traeapi.us");
eq("国际账号面", gl.account, "https://grow-normal.trae.ai");
eq("国际授权页", gl.authorizeHost, "https://www.trae.ai");
eq("国际鉴权方案", gl.authScheme, "bearer");
eq("两区 client_id 默认一致", [cn.clientId, gl.clientId], ["ono9krqynydwx5", "ono9krqynydwx5"]);
ok("国际有备选数据面", gl.coreFallbacks.length >= 2, `fallbacks=${JSON.stringify(gl.coreFallbacks)}`);
ok("两区数据面不重叠", !gl.coreFallbacks.includes(cn.core));

/* 环境变量覆盖 */
const overridden = mod.traeEndpoints({ TRAE_CN_CORE_URL: "https://cn.example.com/", TRAE_CLIENT_ID: "cid-x" }, "cn");
eq("覆盖国内数据面并去尾斜杠", overridden.core, "https://cn.example.com");
eq("覆盖 client_id", overridden.clientId, "cid-x");
const glOverridden = mod.traeEndpoints({ TRAE_GLOBAL_CORE_URL: "https://gl.example.com" }, "global");
eq("覆盖国际数据面", glOverridden.core, "https://gl.example.com");

/* ---------------- 3. 鉴权头 ---------------- */
const cred = JSON.parse(
  mod.serializeTraeCredential({
    region: "cn",
    refreshToken: "rt-abc",
    uid: "uid-1",
    machineId: "m-1",
    deviceId: "d-1",
    clientId: "ono9krqynydwx5",
  })
);
eq("凭据序列化字段名", Object.keys(cred).filter((k) => ["refresh_token", "machine_id", "device_id"].includes(k)).sort(), ["device_id", "machine_id", "refresh_token"]);
const cnHeaders = mod.traeHeaders(cn, cred, "AT", true);
eq("国内 Authorization 前缀", cnHeaders["Authorization"], "Cloud-IDE-JWT AT");
eq("国内 x-ide-token 同 token", cnHeaders["x-ide-token"], "AT");
eq("国内带 uid 头", cnHeaders["X-Uid"], "uid-1");
ok("国内不写 store-country-code", !cnHeaders["store-country-code"]);
ok("国内带 app-id", !!cnHeaders["X-App-Id"]);

const glHeaders = mod.traeHeaders(gl, cred, "AT", true);
eq("国际 Authorization 用 Bearer", glHeaders["Authorization"], "Bearer AT");
eq("国际带 store-country-code", glHeaders["store-country-code"], "us");
ok("国际 UA 是 TraeClient", String(glHeaders["User-Agent"]).startsWith("TraeClient"));
eq("流式 Accept", glHeaders["Accept"], "text/event-stream");
eq("非流式 Accept", mod.traeHeaders(gl, cred, "AT", false)["Accept"], "application/json");

/* ---------------- 4. 模型名归一化 ---------------- */
eq("trae-cn 前缀剥离", mod.normalizeTraeModel("trae-cn/glm-5.3"), { model: "glm-5.3", forcedRegion: "cn" });
eq("trae-intl 前缀剥离", mod.normalizeTraeModel("trae-intl/Claude-Sonnet-4.6"), { model: "Claude-Sonnet-4.6", forcedRegion: "global" });
eq("无前缀不改写", mod.normalizeTraeModel("Gemini-3.1-Pro-Preview"), { model: "Gemini-3.1-Pro-Preview" });
eq("去显示名尾巴", mod.normalizeTraeModel("DeepSeek-V4-Pro (深度求索)"), { model: "DeepSeek-V4-Pro" });
eq("前缀大小写不敏感", mod.normalizeTraeModel("TRAE-CN/glm-5.3"), { model: "glm-5.3", forcedRegion: "cn" });
eq("空模型名", mod.normalizeTraeModel(""), { model: "" });

/* ---------------- 5. 消息体：content 必须是 parts 数组 ---------------- */
const messages = mod.toTraeMessages([
  { role: "system", content: "sys" },
  { role: "user", content: "hi" },
  { role: "assistant", content: [{ type: "text", text: "hello" }] },
  { role: "tool", content: "result" },
]);
eq("system 原样", messages[0], { role: "system", content: [{ type: "text", text: "sys" }] });
eq("字符串转 parts 数组", messages[1], { role: "user", content: [{ type: "text", text: "hi" }] });
eq("数组保持", messages[2], { role: "assistant", content: [{ type: "text", text: "hello" }] });
eq("tool 归一为 user", messages[3].role, "user");
ok(
  "所有 content 都是数组",
  messages.every((m) => Array.isArray(m.content) && m.content.every((part) => part.type === "text")),
  JSON.stringify(messages)
);
eq("空消息兜底一个空 text part", mod.toTraeMessages([{ role: "user", content: [] }])[0].content, [{ type: "text", text: "" }]);

/* ---------------- 6. 请求体 ---------------- */
const body = mod.buildTraeChatBody(
  { messages: [{ role: "user", content: "hi" }], temperature: 0.2, max_tokens: 16, tools: [{ type: "function" }], model: "x" },
  "glm-5.3",
  "raw"
);
eq("上游模型字段是 model_name", body.model_name, "glm-5.3");
eq("采样参数透传 temperature", body.temperature, 0.2);
eq("采样参数透传 max_tokens", body.max_tokens, 16);
ok("raw 通道不发 function", !("function" in body));
ok("raw 通道不发 tools（未验证的字段一律不发）", !("tools" in body));
eq("上游永远 stream", body.stream, true);
const utilsBody = mod.buildTraeChatBody({ messages: [] }, "glm-5.3", "utils");
eq("utils 通道 function=chat_v3", utilsBody.function, "chat_v3");
ok("utils 通道带 session_id", typeof utilsBody.session_id === "string" && utilsBody.session_id.length > 0);
ok("utils 通道带 request_id", typeof utilsBody.request_id === "string" && utilsBody.request_id.length > 0);
ok("utils 通道不带 config_name（会 4001）", !("config_name" in utilsBody));

/* ---------------- 7. 回调解析 ---------------- */
const cbUrl =
  "http://127.0.0.1:18123/authorize?refreshToken=rt-1&userInfo=" +
  encodeURIComponent(JSON.stringify({ UserID: "u-9", ScreenName: "张三" })) +
  "&loginTraceID=tr-1";
const cb = mod.parseTraeCallback(cbUrl);
eq("回调 refreshToken", cb.refreshToken, "rt-1");
eq("回调 userInfo.uid", cb.uid, "u-9");
eq("回调 userInfo.name", cb.name, "张三");

const cbJwt = mod.parseTraeCallback(
  "http://127.0.0.1:18080/authorize?userJwt=" +
    encodeURIComponent(JSON.stringify({ Token: "AT-1", RefreshToken: "RT-1" }))
);
eq("userJwt.Token", cbJwt.accessToken, "AT-1");
eq("userJwt.RefreshToken", cbJwt.refreshToken, "RT-1");

const cbCode = mod.parseTraeCallback(
  "http://127.0.0.1:18080/authorize?authCodeInfo=" + encodeURIComponent(JSON.stringify({ AuthCode: "AC-1", ExpireAt: Date.now() + 600000 }))
);
eq("authCodeInfo.AuthCode", cbCode.authCode, "AC-1");
eq("裸 code 当 authCode", mod.parseTraeCallback("AC-2").authCode, "AC-2");
eq("纯 query 串", mod.parseTraeCallback("?refresh_token=rt-2").refreshToken, "rt-2");
eq("错误回调", mod.parseTraeCallback("http://127.0.0.1:18080/authorize?error=access_denied").error, "access_denied");
eq("空输入", mod.parseTraeCallback("   "), {});

/* ---------------- 8. 凭据解析 ---------------- */
const parsed = mod.parseTraeCredential(JSON.stringify({ refresh_token: "rt-x", region: "cn", uid: "u" }), "https://core-normal.traeapi.us");
eq("凭据自带 region 优先于 baseUrl", parsed.region, "cn");
eq("凭据 refreshToken", parsed.refreshToken, "rt-x");
ok("凭据补出稳定机器指纹", !!parsed.machineId && !!parsed.deviceId);
const rawCred = mod.parseTraeCredential("rt-plain", "https://trae-api-cn.mchost.guru");
eq("裸 refresh_token 按 baseUrl 定区", rawCred.region, "cn");
eq("非法凭据返回 null", mod.parseTraeCredential(""), null);
const roundtrip = mod.parseTraeCredential(mod.serializeTraeCredential(rawCred), "https://trae-api-cn.mchost.guru");
eq("序列化往返 refreshToken", roundtrip.refreshToken, "rt-plain");
eq("序列化往返设备指纹", [roundtrip.machineId, roundtrip.deviceId], [rawCred.machineId, rawCred.deviceId]);
const other = mod.parseTraeCredential("rt-plain", "https://core-normal.traeapi.us");
eq("同 refresh_token 设备指纹稳定", other.machineId, rawCred.machineId);

/* ---------------- 9. 错误码映射 ---------------- */
eq("1001 → 401", mod.mapTraeErrorCode(1001, "no token").status, 401);
eq("4001 → 400", mod.mapTraeErrorCode("4001", "param").status, 400);
eq("4008 额度 → 429", mod.mapTraeErrorCode(4008, "quota").status, 429);
eq("1005 额度 → 429", mod.mapTraeErrorCode(1005, "quota").status, 429);
eq("4015 风控 → 403", mod.mapTraeErrorCode(4015, "risk").status, 403);
eq("4023 模型 → 400", mod.mapTraeErrorCode(4023, "model").status, 400);
eq("未知码 → 502", mod.mapTraeErrorCode("", "boom").status, 502);
eq("无业务码时 HTTP 429 兜底", mod.mapTraeErrorCode("", "slow down", 429).status, 429);
eq("无业务码时 HTTP 401 兜底", mod.mapTraeErrorCode("", "no auth", 401).status, 401);

/* ---------------- 10. model_list 解析 ---------------- */
eq(
  "Result.ModelList + display_name",
  mod.parseTraeModelList({ Result: { ModelList: [{ name: "glm-5.3", display_name: "GLM-5.3" }, { name: "kimi-k3" }] } }),
  ["glm-5.3", "kimi-k3"]
);
eq("裸 data 数组", mod.parseTraeModelList({ data: [{ id: "a" }, { id: "b" }] }), ["a", "b"]);
eq("字符串数组", mod.parseTraeModelList({ models: ["x", "y"] }), ["x", "y"]);
eq("去重", mod.parseTraeModelList([{ name: "x" }, { name: "x" }]), ["x"]);
eq("空结构", mod.parseTraeModelList({ Result: {} }), []);

console.log(`\n=== trae-region 单元测试：通过 ${pass} 项，失败 ${fail} 项 ===`);
if (fail) process.exit(1);
console.log("🎉 全部通过");
