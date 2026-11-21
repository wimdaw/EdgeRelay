/**
 * tests/test-trae-handler.mjs
 * Trae 对话链路端到端（mock 上游）：
 *  - 鉴权头：国内 Cloud-IDE-JWT / 国际 Bearer，x-ide-token 与 Authorization 同 token
 *  - 协议体：messages.content 必须是 parts 数组，否则 mock 按上游返回 4001
 *  - 流式：Trae 私有 SSE → OpenAI chunk（含 reasoning_content / usage / [DONE]）
 *  - 非流式：网关内聚合，choices[0].message 与 usage 形状正确
 *  - 路由：模型前缀与渠道区域冲突时 400，不发上游
 *
 * 依赖：esbuild（项目自带 devDependency）+ node:http，无外网请求。
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  entryPoints: [join(root, "src", "oauth", "trae.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
  define: { "process.env.NODE_ENV": '"test"' },
});
const mod = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

const seen = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ url: req.url, headers: req.headers, body });
    if (req.url.includes("/oauth/ExchangeToken")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Result: { Token: "AT-1", RefreshToken: "RT-2", TokenExpireAt: Date.now() + 3600_000 } }));
      return;
    }
    if (req.url.includes("/model_list")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Result: { ModelList: [{ name: "glm-5.3", display_name: "GLM-5.3" }] } }));
      return;
    }
    if (req.url.includes("/llm_raw_chat") || req.url.includes("/llm_utils_chat")) {
      const parsed = JSON.parse(body || "{}");
      if (!Array.isArray(parsed.messages?.[0]?.content)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 4001, message: "content must be array" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: metadata\ndata:{"session_id":"s1"}\n\n`);
      res.write(`event: output\ndata:{"response":"你好","reasoning_content":"思考"}\n\n`);
      res.write(`event: output\ndata:{"response":"，世界"}\n\n`);
      res.write(`event: token_usage\ndata:{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}\n\n`);
      res.write(`event: done\ndata:{"finish_reason":"stop"}\n\n`);
      res.end();
      return;
    }
    res.writeHead(404).end("{}");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const env = { USE_MEMORY_STORE: "1", TRAE_CN_CORE_URL: base, TRAE_CN_ACCOUNT_URL: base };
const cred = mod.serializeTraeCredential({ region: "cn", refreshToken: "RT-1", uid: "u1", machineId: "m1", deviceId: "d1" });
const args = (body, model = "glm-5.3") => ({
  env,
  providerId: "p",
  modelId: model,
  requestedModel: model,
  body,
  refreshTokens: [cred],
  maskedToken: "",
  startedAt: Date.now(),
});

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { console.log(`✅ ${name}`); pass++; }
  else { console.error(`❌ ${name} ${detail}`); fail++; }
};

// 1) 流式
const sres = await mod.handleTraeRequest(args({ messages: [{ role: "user", content: "hi" }], stream: true }), "https://trae-api-cn.mchost.guru");
const stext = await sres.text();
check("流式 200", sres.status === 200, String(sres.status));
check("流式含中文增量", stext.includes("你好") && stext.includes("世界"));
check("流式含 reasoning", stext.includes("reasoning_content"));
check("流式末帧带 usage", stext.includes('"usage"') && stext.includes('"total_tokens":10'));
check("流式以 [DONE] 收尾", stext.trim().endsWith("[DONE]"));
const chatReq = seen.find((r) => r.url.includes("llm_raw_chat"));
check("对话走 llm_raw_chat", !!chatReq);
check("Authorization Cloud-IDE-JWT", chatReq?.headers["authorization"] === "Cloud-IDE-JWT AT-1", chatReq?.headers["authorization"]);
check("x-ide-token 同 token", chatReq?.headers["x-ide-token"] === "AT-1");
check("带 x-machine-id", chatReq?.headers["x-machine-id"] === "m1");
check("content 是 parts 数组", JSON.parse(chatReq.body).messages[0].content[0].type === "text");

// 2) 非流式
const jres = await mod.handleTraeRequest(args({ messages: [{ role: "user", content: "hi" }], stream: false }), "https://trae-api-cn.mchost.guru");
const j = await jres.json();
check("非流式 200", jres.status === 200);
check("非流式聚合内容", j.choices?.[0]?.message?.content === "你好，世界", JSON.stringify(j.choices?.[0]?.message));
check("非流式带 reasoning", j.choices?.[0]?.message?.reasoning_content === "思考");
check("非流式 usage", j.usage?.total_tokens === 10);

// 3) 前缀区域冲突
const bad = await mod.handleTraeRequest(args({ messages: [{ role: "user", content: "hi" }] }, "trae-intl/glm-5.3"), "https://trae-api-cn.mchost.guru");
check("前缀区域冲突 → 400", bad.status === 400, String(bad.status));

// 4) 模型目录
const models = await mod.fetchTraeModels(env, cred, "https://trae-api-cn.mchost.guru");
check("model_list 解析", models.models.includes("glm-5.3"), JSON.stringify(models));

// 5) 国际版头
const glCred = mod.serializeTraeCredential({ region: "global", refreshToken: "RT-G", machineId: "mg", deviceId: "dg" });
const glEp = mod.traeEndpoints(env, "global");
const glH = mod.traeHeaders(glEp, mod.parseTraeCredential(glCred), "ATG", true);
check("国际版 Bearer", glH.Authorization === "Bearer ATG");
check("国际版 store-country-code", glH["store-country-code"] === "us");

// 6) 授权链接（入口）
const cnAuth = await mod.buildTraeAuthUrl(env, "https://trae-api-cn.mchost.guru");
const cnUrl = new URL(cnAuth.url);
check("国内授权页落点", cnUrl.origin === "https://www.trae.cn", cnUrl.origin);
check("授权页路径 /authorization", cnUrl.pathname === "/authorization");
check("带 PKCE S256", cnUrl.searchParams.get("code_challenge_method") === "S256" && !!cnUrl.searchParams.get("code_challenge"));
check("回调指向 127.0.0.1", (cnUrl.searchParams.get("auth_callback_url") || "").startsWith("http://127.0.0.1:"));
check("auth_from=trae / login_channel=native_ide",
  cnUrl.searchParams.get("auth_from") === "trae" && cnUrl.searchParams.get("login_channel") === "native_ide");
check("带 login_trace_id 与 client_id", !!cnUrl.searchParams.get("login_trace_id") && cnUrl.searchParams.get("client_id") === "ono9krqynydwx5");
check("带设备指纹参数", !!cnUrl.searchParams.get("machine_id") && !!cnUrl.searchParams.get("device_id"));
const glAuth = await mod.buildTraeAuthUrl(env, "https://core-normal.traeapi.us");
check("国际授权页落点", new URL(glAuth.url).origin === "https://www.trae.ai", glAuth.url);
check("两区 state 均非空", !!cnAuth.state && !!glAuth.state);

// 7) 完成授权：换票 DeviceInfo 必须与授权会话设备号一致（20403 "Token device not match" 回归），
//    真实设备号只写进凭据 checkin_device_id（签到域专用），不得进入换票 DeviceInfo
{
  const realDeviceId = "3225342868485628";
  const auth = await mod.buildTraeAuthUrl(env, "https://trae-api-cn.mchost.guru", realDeviceId);
  const authUrl = new URL(auth.url);
  const flowDevice = authUrl.searchParams.get("device_id");
  const flowMachine = authUrl.searchParams.get("machine_id");
  check("授权会话设备号是随机号（非真实号）", !!flowDevice && flowDevice !== realDeviceId, flowDevice || "");
  const authCodeInfo = JSON.stringify({ AuthCode: "AC-1", ExpireAt: Date.now() + 600_000, ExpireDuration: 600_000 });
  const userInfo = JSON.stringify({ UserID: "u-9", ScreenName: "皮皮猪影视" });
  const cbUrl = `http://127.0.0.1:18146/authorize?isRedirect=true&scope=trae&authCodeInfo=${encodeURIComponent(authCodeInfo)}&userInfo=${encodeURIComponent(userInfo)}`;
  const before = seen.length;
  const done = await mod.completeTraeOAuth(env, cbUrl, auth.state, "https://trae-api-cn.mchost.guru", realDeviceId);
  const exReq = seen.slice(before).find((r) => r.url.includes("/trae/api/v3/oauth/ExchangeToken"));
  check("换票请求已发出", !!exReq);
  const exBody = JSON.parse(exReq?.body || "{}");
  check("换票 DeviceID == 授权会话 device_id", exBody.DeviceInfo?.DeviceID === flowDevice,
    JSON.stringify({ got: exBody.DeviceInfo?.DeviceID, want: flowDevice }));
  check("换票 MachineID == 授权会话 machine_id", exBody.DeviceInfo?.MachineID === flowMachine,
    JSON.stringify({ got: exBody.DeviceInfo?.MachineID, want: flowMachine }));
  check("换票带 PKCE CodeVerifier", typeof exBody.CodeVerifier === "string" && exBody.CodeVerifier.length >= 43,
    String(exBody.CodeVerifier || "").length);
  const credBack = JSON.parse(done.refreshToken);
  check("凭据 device_id == 会话设备号", credBack.device_id === flowDevice, credBack.device_id);
  check("凭据 machine_id == 会话 machine_id", credBack.machine_id === flowMachine, credBack.machine_id);
  check("凭据 checkin_device_id == 客户端真实设备号", credBack.checkin_device_id === realDeviceId, credBack.checkin_device_id);
  check("签到用真实设备号优先", (() => {
    const cred = mod.parseTraeCredential(done.refreshToken);
    return (cred.checkinDeviceId || cred.deviceId) === realDeviceId && cred.deviceId === flowDevice;
  })());
  check("完成授权返回账号昵称", done.email === "皮皮猪影视", done.email || "");
}

server.close();
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
