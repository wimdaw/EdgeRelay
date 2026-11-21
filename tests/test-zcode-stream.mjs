/**
 * tests/test-zcode-stream.mjs
 * ZCode 上游流式链路回归：Anthropic SSE → OpenAI chunk 翻译
 *  - thinking_delta → delta.reasoning_content（"思考过程"可见性）
 *  - text_delta → delta.content
 *  - tool_use 块 → delta.tool_calls（start 带 id/name，input_json_delta 追加参数）
 *  - message_delta → finish_reason / usage
 *  - 错误帧 → error 块 + [DONE]
 *
 * 依赖：esbuild（项目自带 devDependency），无外网请求。
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  entryPoints: [join(root, "src", "oauth", "zcode.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
  define: { "process.env.NODE_ENV": '"test"' },
});
const mod = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { console.log(`✅ ${name}`); pass++; }
  else { console.error(`❌ ${name} ${detail}`); fail++; }
};

const fakeUpstream = (frames) =>
  new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(f));
      c.close();
    },
  });

const collect = async (resp) => {
  const text = await resp.text();
  const frames = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  return {
    chunks: frames.filter((f) => f && f !== "[DONE]").map((f) => JSON.parse(f)),
    done: frames.includes("[DONE]"),
    text,
  };
};

// 1) 正常流：思考 → 文本 → 工具调用
const sse = [
  `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":42}}}\n\n`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先想"}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"一下"}}\n\n`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"你好"}}\n\n`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather"}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\"北京\\"}"}}\n\n`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":57}}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
];
const r1 = await collect(mod.anthropicSseToOpenAIStream(fakeUpstream(sse), "GLM-5.3"));
const deltas = r1.chunks.map((c) => c.choices?.[0]?.delta || {});
check("首帧带 role", deltas[0]?.role === "assistant");
const reasoning = deltas.map((d) => d.reasoning_content || "").join("");
check("thinking_delta → reasoning_content", reasoning === "先想一下", JSON.stringify(reasoning));
const content = deltas.map((d) => d.content || "").join("");
check("text_delta → content", content === "你好", JSON.stringify(content));
const tcStart = deltas.find((d) => Array.isArray(d.tool_calls) && d.tool_calls[0]?.function?.name);
check("tool_use start → delta.tool_calls(id/name)", !!tcStart
  && tcStart.tool_calls[0].id === "tu_1" && tcStart.tool_calls[0].function.name === "get_weather");
const tcArgs = deltas.filter((d) => Array.isArray(d.tool_calls) && d.tool_calls[0]?.function?.arguments).map((d) => d.tool_calls[0].function.arguments).join("");
check("input_json_delta → arguments 追加", tcArgs === '{"city":"北京"}', JSON.stringify(tcArgs));
const finish = r1.chunks.find((c) => c.choices?.[0]?.finish_reason);
check("stop_reason=tool_use → finish_reason=tool_calls", finish?.choices?.[0]?.finish_reason === "tool_calls");
const usageChunk = r1.chunks.find((c) => Array.isArray(c.choices) && c.choices.length === 0 && c.usage);
check("usage 汇总", !!usageChunk && usageChunk.usage.prompt_tokens === 42 && usageChunk.usage.completion_tokens === 57, JSON.stringify(usageChunk));
check("以 [DONE] 收尾", r1.done);

// 2) 错误帧
const r2 = await collect(mod.anthropicSseToOpenAIStream(
  fakeUpstream([`event: error\ndata: {"code":3009,"message":"busy"}\n\n`]),
  "GLM-5.3"
));
const errChunk = r2.chunks.find((c) => c.error);
check("错误帧 → error 块", !!errChunk && String(errChunk.error.message).includes("busy"), JSON.stringify(r2.chunks));
check("错误后仍收尾 [DONE]", r2.done);

// 3) \r\n\r\n 帧分隔兼容
const r3 = await collect(mod.anthropicSseToOpenAIStream(
  fakeUpstream([`event: content_block_start\r\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\r\n\r\n`,
    `event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\r\n\r\n`,
    `event: message_delta\r\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\r\n\r\n`,
    `event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n`]),
  "GLM-5.3"
));
check("CRLF 帧分隔兼容", r3.chunks.some((c) => c.choices?.[0]?.delta?.content === "hi")
  && r3.chunks.some((c) => c.choices?.[0]?.finish_reason === "stop"));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
