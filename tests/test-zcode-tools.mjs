/**
 * tests/test-zcode-tools.mjs
 * ZCode 工具链路回归：
 *  - openAIToAnthropicZcode：body.tools（OpenAI functions）→ Anthropic tools（input_schema）
 *  - assistant 历史 tool_calls → tool_use 内容块（"说一句就断"根因回归）
 *  - tool 角色 → tool_result 块
 *  - completionToSse：合成流必须带 delta.tool_calls（流式 agent 客户端依赖）
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

// 1) tools 透传（OpenAI → Anthropic）
const body = {
  model: "GLM-5.3",
  max_tokens: 1024,
  tools: [{
    type: "function",
    function: {
      name: "get_weather",
      description: "查天气",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  }],
  messages: [
    { role: "system", content: "你是助手" },
    { role: "user", content: "北京天气如何？" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "晴 25 度" },
  ],
};
const req = mod.openAIToAnthropicZcode(body);

check("tools 映射为 Anthropic 形状", Array.isArray(req.tools) && req.tools.length === 1
  && req.tools[0].name === "get_weather"
  && req.tools[0].input_schema?.properties?.city?.type === "string", JSON.stringify(req.tools));
check("description 透传", req.tools?.[0]?.description === "查天气");

const asst = req.messages.find((m) => m.role === "assistant");
check("assistant tool_calls → tool_use 块", Array.isArray(asst?.content)
  && asst.content.some((b) => b.type === "tool_use" && b.id === "call_1" && b.name === "get_weather"), JSON.stringify(asst));
check("tool_use.input 解析为对象", Array.isArray(asst?.content)
  && asst.content.find((b) => b.type === "tool_use")?.input?.city === "北京");

const toolMsg = req.messages.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
check("tool 角色 → tool_result", !!toolMsg && toolMsg.content[0].tool_use_id === "call_1"
  && toolMsg.content[0].content === "晴 25 度");

check("system 抽出", req.system === "你是助手");
check("tools 缺省时不写字段", mod.openAIToAnthropicZcode({ model: "GLM-5.3", messages: [{ role: "user", content: "hi" }] }).tools === undefined);

// 2) 合成流带 tool_calls delta
const completion = {
  id: "chatcmpl-x",
  created: 1,
  model: "GLM-5.3",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_9", type: "function", function: { name: "get_weather", arguments: '{"city":"上海"}' } }],
    },
    finish_reason: "tool_calls",
  }],
  usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
};
const resp = mod.completionToSse ? mod.completionToSse(completion) : null;
check("completionToSse 已导出", !!resp);
if (resp) {
  const text = await resp.text();
  const frames = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  const deltas = frames.filter((f) => f && f !== "[DONE]").map((f) => JSON.parse(f));
  const tcDelta = deltas.find((d) => d.choices?.[0]?.delta?.tool_calls);
  check("流中包含 delta.tool_calls", !!tcDelta, text.slice(0, 200));
  check("tool_calls delta 含名字与参数", !!tcDelta
    && tcDelta.choices[0].delta.tool_calls[0].function.name === "get_weather"
    && tcDelta.choices[0].delta.tool_calls[0].function.arguments.includes("上海"));
  const finish = deltas.find((d) => d.choices?.[0]?.finish_reason);
  check("finish_reason=tool_calls", finish?.choices?.[0]?.finish_reason === "tool_calls");
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
