/**
 * tests/test-antigravity-translate.mjs
 * Antigravity（Gemini Code Assist）翻译层单元测试。
 *
 * 覆盖：
 *  1. 常规文本 / token 截断 / 安全拦截的 finish_reason 映射
 *  2. 工具调用 -> tool_calls 且 finish_reason=tool_calls
 *  3. 零可见输出 + 畸形结束原因（MALFORMED_FUNCTION_CALL 等）按可重试错误处理
 *     —— 对齐 CLIProxyAPI 的 gemini_zero_output 兜底，避免把空回复伪装成成功
 *  4. 有可见输出时不受影响；仅有 thought 仍视为零输出
 *  5. 流式：零输出时下发 error 帧而非正常收尾
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  entryPoints: [join(root, "src", "gemini-translate.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const mod = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
const { geminiResponseToOpenAI, createOpenAIStream, isAbnormalFinishReason, GeminiZeroOutputError } = mod;

let pass = 0;
const fails = [];
const eq = (name, got, want) => {
  if (got === want) pass++;
  else fails.push(`${name}\n      实际: ${JSON.stringify(got)}\n      期望: ${JSON.stringify(want)}`);
};

const resp = (candidate, extra = {}) => ({ responseId: "r1", modelVersion: "gemini-3-pro", candidates: [candidate], ...extra });

// 1) 常规映射
{
  const r = geminiResponseToOpenAI(
    resp({ index: 0, content: { parts: [{ text: "你好" }] }, finishReason: "STOP" }),
    "gemini-3-pro", {},
  );
  eq("正常文本内容", r.choices[0].message.content, "你好");
  eq("STOP -> stop", r.choices[0].finish_reason, "stop");
  eq("回显请求模型", r.model, "gemini-3-pro");
}
{
  const r = geminiResponseToOpenAI(
    resp({ index: 0, content: { parts: [{ text: "半句话" }] }, finishReason: "MAX_TOKENS" }),
    "m", {},
  );
  eq("MAX_TOKENS -> length", r.choices[0].finish_reason, "length");
}
{
  const r = geminiResponseToOpenAI(
    resp({ index: 0, content: { parts: [{ text: "" }] }, finishReason: "SAFETY" }),
    "m", {},
  );
  eq("SAFETY -> content_filter", r.choices[0].finish_reason, "content_filter");
}

// 2) 工具调用（含 thought_signature 编码进 id）
{
  const r = geminiResponseToOpenAI(
    resp({
      index: 0,
      content: { parts: [{ functionCall: { name: "get_weather", args: { city: "北京" }, id: "call_1" } }] },
      finishReason: "STOP",
    }),
    "m", {},
  );
  eq("工具调用数量", r.choices[0].message.tool_calls.length, 1);
  eq("工具名", r.choices[0].message.tool_calls[0].function.name, "get_weather");
  eq("工具结束原因", r.choices[0].finish_reason, "tool_calls");
  eq("工具调用时 content 为 null", r.choices[0].message.content, null);
}

// 3) 零输出 + 畸形结束 -> 抛可重试错误
for (const reason of ["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "MALFORMED_RESPONSE"]) {
  let thrown = null;
  try {
    geminiResponseToOpenAI(resp({ index: 0, content: { parts: [] }, finishReason: reason }), "m", {});
  } catch (e) { thrown = e; }
  eq(`${reason} 抛 GeminiZeroOutputError`, thrown instanceof GeminiZeroOutputError, true);
  eq(`${reason} 携带结束原因`, thrown?.finishReason, reason);
}
eq("isAbnormalFinishReason 识别", isAbnormalFinishReason("malformed_function_call"), true);
eq("isAbnormalFinishReason 不误判 STOP", isAbnormalFinishReason("STOP"), false);
eq("isAbnormalFinishReason 不误判空", isAbnormalFinishReason(undefined), false);

// 4) 有可见输出 -> 不抛；仅 thought -> 仍视为零输出
{
  let thrown = null;
  try {
    geminiResponseToOpenAI(
      resp({ index: 0, content: { parts: [{ text: "正文" }] }, finishReason: "MALFORMED_FUNCTION_CALL" }),
      "m", {},
    );
  } catch (e) { thrown = e; }
  eq("有正文时不抛错", thrown, null);
}
{
  let thrown = null;
  try {
    geminiResponseToOpenAI(
      resp({ index: 0, content: { parts: [{ text: "思考过程", thought: true }] }, finishReason: "MALFORMED_RESPONSE" }),
      "m", {},
    );
  } catch (e) { thrown = e; }
  eq("仅 thought 视为零输出", thrown instanceof GeminiZeroOutputError, true);
}

// 5) 流式：零输出下发 error 帧
const sse = (frames) => new ReadableStream({
  start(controller) {
    const enc = new TextEncoder();
    for (const f of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
    controller.close();
  },
});
const collect = async (stream) => {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return text;
};

{
  const text = await collect(createOpenAIStream(
    sse([resp({ index: 0, content: { parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL" })]),
    "m", {}, () => {},
  ));
  eq("流式零输出包含 error 帧", text.includes('"code":"zero_output"'), true);
  eq("流式零输出仍以 [DONE] 收尾", text.trimEnd().endsWith("data: [DONE]"), true);
  eq("流式零输出不发正常 finish", text.includes('"finish_reason":"stop"'), false);
}

{
  const text = await collect(createOpenAIStream(
    sse([resp({ index: 0, content: { parts: [{ text: "你好" }] }, finishReason: "STOP" })]),
    "m", {}, () => {},
  ));
  eq("流式正常输出无 error 帧", text.includes("zero_output"), false);
  eq("流式正常输出含正文", text.includes("你好"), true);
  eq("流式正常输出以 stop 收尾", text.includes('"finish_reason":"stop"'), true);
}

if (fails.length) {
  console.error("❌ FAIL:\n" + fails.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log(`✅ PASS: Antigravity 翻译层 ${pass} 项断言全部通过`);
