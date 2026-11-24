/**
 * tests/test-awsquick-retry.mjs
 * 护栏重试链路：用本地 WebSocket 假上游验证
 *  1. 第一次连接先发护栏伪正文 + guardrail_blocked，第二次连接发正常回答 → 客户端只看到正常回答
 *  2. 已经输出部分正文后再触发护栏 → 不重试，直接报错
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";
import { WebSocketServer } from "ws";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = join(root, "tests", ".tmp-awsquick-retry.mjs");
await build({
  entryPoints: [join(root, "src", "oauth", "awsquick.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: true,
  outfile: tmp,
  external: ["ws"],
  logLevel: "silent",
});
let mod;
try {
  mod = await import(pathToFileURL(tmp).href + "?t=" + Date.now());
} finally {
  try { fs.unlinkSync(tmp); } catch {}
}

const GUARDRAIL = "That content did not pass our automated check. Try asking again - a small rephrase usually helps.";

let pass = 0;
let fail = 0;
function ok(name, cond, detail = "") {
  if (cond) {
    console.log(`✅ PASS: ${name}`);
    pass++;
  } else {
    console.error(`❌ FAIL: ${name}${detail ? "\n  " + detail : ""}`);
    fail++;
  }
}

function startServer(script) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => resolve(wss));
    let connections = 0;
    wss.on("connection", (ws) => {
      connections++;
      const frames = script(connections);
      setTimeout(() => {
        for (const frame of frames) ws.send(JSON.stringify(frame));
      }, 50);
    });
    wss.connectionCount = () => connections;
  });
}

function closeServer(wss) {
  return new Promise((resolve) => wss.close(() => resolve()));
}

async function runCase(name, script, withCallbacks, expected) {
  const wss = await startServer(script);
  const port = wss.address().port;
  const emitted = [];
  const cred = {
    provider: "social",
    wsHost: `ws://127.0.0.1:${port}`,
    wsPath: "/",
    deviceId: "test-device",
    actorArn: "",
  };
  let result = null;
  let error = null;
  try {
    result = await mod.runQuickTurn(cred, "test-bearer", {
      prompt: "hi",
      system: "",
      slot: "smart",
      effort: "high",
      timeoutMs: 8000,
      idleMs: 8000,
      ...(withCallbacks ? { onText: (d) => emitted.push(d) } : {}),
    });
  } catch (err) {
    error = err;
  }
  await closeServer(wss);
  ok(`${name}：连接次数`, wss.connectionCount() === expected.connections, `actual=${wss.connectionCount()} expected=${expected.connections}`);
  ok(`${name}：客户端文本`, emitted.join("") === expected.emitted, `actual=${JSON.stringify(emitted.join(""))} expected=${JSON.stringify(expected.emitted)}`);
  if (expected.error) {
    ok(`${name}：错误码`, error?.code === expected.error, `actual=${error?.code}`);
  } else {
    ok(`${name}：返回文本`, result?.text === expected.result, `actual=${JSON.stringify(result?.text)}`);
    ok(`${name}：无错误`, !error, `error=${error?.message}`);
  }
}

// 1) 护栏伪正文只在第一次连接出现，重试后应透明成功
await runCase(
  "护栏后重试",
  (n) =>
    n === 1
      ? [
          { type: "text_delta", payload: { text: GUARDRAIL } },
          { type: "guardrail_blocked", payload: { message: GUARDRAIL } },
        ]
      : [
          { type: "text_delta", payload: { text: "OK" } },
          { type: "message_complete", payload: {} },
        ],
  true,
  { connections: 2, emitted: "OK", result: "OK" }
);

// 2) 非流式（无回调）同样应重试
await runCase(
  "非流式护栏重试",
  (n) =>
    n === 1
      ? [
          { type: "text_delta", payload: { text: GUARDRAIL } },
          { type: "guardrail_blocked", payload: { message: GUARDRAIL } },
        ]
      : [
          { type: "text_delta", payload: { text: "OK" } },
          { type: "message_complete", payload: {} },
        ],
  false,
  { connections: 2, emitted: "", result: "OK" }
);

// 3) 已经输出部分正文后再触发护栏，不重试
await runCase(
  "已输出后不重试",
  () => [
    { type: "text_delta", payload: { text: "partial" } },
    { type: "guardrail_blocked", payload: { message: GUARDRAIL } },
  ],
  true,
  { connections: 1, emitted: "partial", error: "guardrail_blocked" }
);

console.log(`\n=== awsquick 护栏重试测试：通过 ${pass} 项，失败 ${fail} 项 ===`);
if (fail) process.exit(1);
console.log("🎉 全部通过");
