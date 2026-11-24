/**
 * tests/test-web-tool-bridge.mjs
 * Web 反代渠道通用工具桥接单元测试。
 *
 * 覆盖：
 *  1. 请求侧：工具定义注入 system、工具历史折平（ChatGPT/Kimi/MiniMax/灵犀）
 *  2. 响应侧（非流式）：<client_tool_call> -> OpenAI tool_calls
 *  3. 响应侧（流式）：跨 chunk 标签检测、文本不泄漏、[DONE] 收尾
 *  4. 已有原生工具桥的渠道（DeepSeek/Gemini）不被重复包装
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  entryPoints: [join(root, "src", "web", "tool-bridge.ts")],
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

const tools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取本地文件",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];

// ---------- 请求侧 ----------
eq("DeepSeek 已有原生桥，不重复包装", mod.prepareWebToolBody("deepseek", { tools, messages: [] }).enabled, false);
eq("Gemini 已有原生桥，不重复包装", mod.prepareWebToolBody("geminiweb", { tools, messages: [] }).enabled, false);
eq("无 tools 不启用", mod.prepareWebToolBody("chatgptweb", { messages: [{ role: "user", content: "hi" }] }).enabled, false);
eq("tool_choice=none 不启用", mod.prepareWebToolBody("chatgptweb", { tools, tool_choice: "none", messages: [] }).enabled, false);

const prepared = mod.prepareWebToolBody("chatgptweb", {
  tools,
  messages: [
    { role: "system", content: "原有系统提示" },
    { role: "user", content: "读取 /tmp/a.txt" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"/tmp/a.txt"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", name: "read_file", content: "hello" },
  ],
});
eq("ChatGPT web 启用桥接", prepared.enabled, true);
eq("工具白名单", [...prepared.allowed].sort().join(","), "read_file");
const sys = prepared.body.messages.find((m) => m.role === "system");
eq("system 保留原提示", String(sys?.content).includes("原有系统提示"), true);
eq("system 注入工具协议", String(sys?.content).includes("<client_tool_call>"), true);
eq("助手 tool_calls 折成文本", String(prepared.body.messages.find((m) => m.role === "assistant")?.content).includes("Assistant tool call"), true);
const toolMsg = prepared.body.messages.find((m) => String(m.content || "").includes("[Tool result"));
eq("工具结果改 user 角色", toolMsg?.role, "user");
eq("工具结果保留内容", String(toolMsg?.content).includes("hello"), true);

// ---------- 响应侧：非流式 ----------
const jsonResp = new Response(
  JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "gpt-test",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: '我先读取文件。<client_tool_call>{"name":"read_file","arguments":{"path":"/tmp/a.txt"}}</client_tool_call>',
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }),
  { status: 200, headers: { "content-type": "application/json" } }
);
const wrappedJson = await (await mod.wrapWebToolResponse(jsonResp, new Set(["read_file"]))).json();
eq("非流式 finish_reason", wrappedJson.choices[0].finish_reason, "tool_calls");
eq("非流式 tool_calls 名称", wrappedJson.choices[0].message.tool_calls?.[0]?.function?.name, "read_file");
eq("非流式正文清理", wrappedJson.choices[0].message.content, "我先读取文件。");

const plainResp = new Response(
  JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "普通回答" }, finish_reason: "stop" }] }),
  { headers: { "content-type": "application/json" } }
);
const wrappedPlain = await (await mod.wrapWebToolResponse(plainResp, new Set(["read_file"]))).json();
eq("非流式普通回答不变", wrappedPlain.choices[0].message.content, "普通回答");
eq("非流式普通 finish", wrappedPlain.choices[0].finish_reason, "stop");

// ---------- 响应侧：流式 ----------
function sse(chunks) {
  return new Response(chunks.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}
function chunk(delta, finish = null, id = "chatcmpl-test") {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

const streamResp = sse([
  chunk({ role: "assistant" }),
  chunk({ content: "我来查" }),
  chunk({ content: '<client_tool' }),
  chunk({ content: '_call>{"name":"read_file","arguments":{"path":"/tmp/b.txt"}}</client_tool_call>' }),
  chunk({}, "stop"),
  "data: [DONE]\n\n",
]);
const wrappedStream = await mod.wrapWebToolResponse(streamResp, new Set(["read_file"]));
const text = await wrappedStream.text();
eq("流式包含 tool_calls", text.includes('"tool_calls"'), true);
eq("流式包含 finish tool_calls", text.includes('"finish_reason":"tool_calls"'), true);
eq("流式不泄漏标签", text.includes("<client_tool_call>"), false);
eq("流式保留前置正文", text.includes("我来查"), true);
eq("流式以 DONE 收尾", text.trimEnd().endsWith("data: [DONE]"), true);
const callJson = text
  .split("\n")
  .filter((l) => l.startsWith("data: {"))
  .map((l) => JSON.parse(l.slice(6)))
  .find((j) => j.choices?.[0]?.delta?.tool_calls);
eq("流式 tool_calls 名称", callJson?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name, "read_file");

const plainStream = sse([
  chunk({ role: "assistant" }),
  chunk({ content: "普通流式回答" }),
  chunk({}, "stop"),
  "data: [DONE]\n\n",
]);
const wrappedPlainStream = await mod.wrapWebToolResponse(plainStream, new Set(["read_file"]));
const plainText = await wrappedPlainStream.text();
eq("流式普通回答保留", plainText.includes("普通流式回答"), true);
eq("流式普通 finish stop", plainText.includes('"finish_reason":"stop"'), true);
eq("流式普通不含 tool_calls", plainText.includes('"tool_calls"'), false);

console.log(`\n=== web-tool-bridge 单元测试：通过 ${pass} 项，失败 ${fail} 项 ===`);
if (fail) process.exit(1);
console.log("🎉 全部通过");
