/**
 * Duck.ai 客户端工具协议桥（对齐 duckai-cpa 的 src/openai/tool-protocol.js）。
 *
 * duck.ai 上游没有 tools schema 通道，因此采用「提示词协议 + 输出解析」：
 *  - 客户端可声明 Chat Completions 或 Responses 形态的 function tools；
 *  - 网关归一化后把协议文本注入首条 user 消息；
 *  - 模型按协议输出 {"tool_call":...} / {"tool_calls":[...]} → 网关解析；
 *  - 出口还原为标准 tool_calls，客户端本地执行后再以 role:"tool" 回放。
 *
 * 网关只解析/转发，不执行工具，也不接 MCP。
 */

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const MAX_TOOL_DEFINITIONS = 64;
export const MAX_TOOL_CALLS = 8;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_PROTOCOL_CHARS = 12 * 1024;
const MAX_TOOL_RESULT_CHARS = 32 * 1024;

export type DuckAiTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type DuckAiToolCall = { id: string; name: string; arguments: string };

export type DuckAiChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * 归一化两种协议的 tools 定义：
 * - Chat Completions: [{ type:"function", function:{ name, description, parameters } }]
 * - Responses:        [{ type:"function", name, description, parameters }]
 * 非 function 类型忽略（web_search / image_generation 由原有 flag 处理）。
 */
export function normalizeToolDefinitions(tools: unknown): DuckAiTool[] {
  if (!Array.isArray(tools)) return [];
  const out: DuckAiTool[] = [];
  const seen = new Set<string>();
  for (const raw of tools) {
    if (!isPlainObject(raw)) continue;
    const type = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
    if (type !== "function") continue;
    const fn = isPlainObject(raw.function) ? raw.function : raw;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!NAME_RE.test(name) || seen.has(name)) continue;
    const parameters = isPlainObject(fn.parameters)
      ? fn.parameters
      : isPlainObject(fn.input_schema)
        ? fn.input_schema
        : { type: "object", properties: {} };
    seen.add(name);
    out.push({
      name,
      description: typeof fn.description === "string" ? fn.description.slice(0, 2000) : "",
      parameters,
    });
    if (out.length >= MAX_TOOL_DEFINITIONS) break;
  }
  return out;
}

/** 生成注入首条 user 消息的工具协议文本。 */
export function buildToolProtocol(tools: DuckAiTool[]): string {
  if (!tools.length) return "";
  const lines = [
    "[工具调用协议]",
    "你可以在需要时调用以下外部工具。工具由客户端执行，你只负责输出调用请求，不要说无法调用。",
    "需要调用时，只输出一行 JSON（不要 markdown 代码块、不要额外解释）：",
    '{"tool_call":{"name":"工具名","arguments":{...}}}',
    '一次可以输出多个调用：{"tool_calls":[{"name":"工具名","arguments":{...}},...]}',
    "如果不需要工具，正常回答即可。",
    "",
    "可用工具：",
  ];
  for (const tool of tools) {
    let schema: string;
    try {
      schema = JSON.stringify(tool.parameters || { type: "object", properties: {} });
    } catch {
      schema = '{"type":"object","properties":{}}';
    }
    lines.push(`- ${tool.name}: ${tool.description || "(无描述)"}；参数 schema: ${schema}`);
  }
  return lines.join("\n").slice(0, MAX_PROTOCOL_CHARS);
}

/** 从模型输出中提取工具调用（兼容单调用、多调用、代码块、<tool_call> 标签）。 */
export function parseToolCalls(text: string, tools: DuckAiTool[]): DuckAiToolCall[] {
  const source = typeof text === "string" ? text : "";
  if (!source.trim()) return [];
  const names = new Set(tools.map((tool) => tool.name));
  if (!names.size) return [];

  const candidates: Array<{ name: string; arguments: string }> = [];

  const normalizeCall = (call: unknown): { name: string; arguments: string } | null => {
    if (!isPlainObject(call)) return null;
    const name = typeof call.name === "string" ? call.name : typeof call.tool === "string" ? call.tool : "";
    if (!NAME_RE.test(name) || !names.has(name)) return null;
    let args = call.arguments;
    if (args === undefined) args = call.args;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        return null;
      }
    }
    if (args === undefined || args === null) args = {};
    if (!isPlainObject(args)) return null;
    const serialized = JSON.stringify(args);
    if (byteLength(serialized) > MAX_ARGUMENT_BYTES) return null;
    return { name, arguments: serialized };
  };

  const pushCandidate = (raw: unknown) => {
    if (!isPlainObject(raw)) return;
    // 代码块/标签内容会同时出现在全文里，按 name+arguments 去重避免重复下发
    const add = (normalized: { name: string; arguments: string } | null) => {
      if (!normalized) return;
      if (candidates.some((call) => call.name === normalized.name && call.arguments === normalized.arguments)) return;
      candidates.push(normalized);
    };
    if (Array.isArray(raw.tool_calls)) {
      for (const call of raw.tool_calls) add(normalizeCall(call));
      return;
    }
    if (isPlainObject(raw.tool_call)) {
      add(normalizeCall(raw.tool_call));
      return;
    }
    add(normalizeCall(raw));
  };

  // 1) 整段文本 / 代码块 / <tool_call> 内的 JSON
  const blocks: string[] = [];
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const fence of source.matchAll(fenceRe)) blocks.push(fence[1] ?? "");
  const tagRe = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  for (const tag of source.matchAll(tagRe)) blocks.push(tag[1] ?? "");
  blocks.push(source);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    for (const chunk of extractJsonObjects(trimmed)) {
      try {
        pushCandidate(JSON.parse(chunk));
      } catch {
        // ignore
      }
      if (candidates.length >= MAX_TOOL_CALLS) break;
    }
    if (candidates.length >= MAX_TOOL_CALLS) break;
  }

  return candidates.slice(0, MAX_TOOL_CALLS).map((call, index) => ({
    id: `call_${Date.now().toString(36)}_${index}_${Math.random().toString(16).slice(2, 10)}`,
    name: call.name,
    arguments: call.arguments,
  }));
}

/** 从可能包含前后文本的字符串中提取平衡的 JSON 对象字符串。 */
function extractJsonObjects(text: string): string[] {
  const out: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      if (depth > 0) inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, index + 1));
          start = -1;
        }
      }
    }
  }
  if (out.length === 0) {
    // 上游可能截断/少一个闭合括号，只对明确以 tool_call/tool_calls 开头的片段做容错修复。
    for (const marker of ['{"tool_call"', '{"tool_calls"']) {
      const index = text.indexOf(marker);
      if (index < 0) continue;
      const repaired = repairTruncatedJson(text.slice(index));
      if (repaired) {
        out.push(repaired);
        break;
      }
    }
  }
  return out;
}

/** 补齐被截断 JSON 的字符串/括号；仅用于 tool_call 容错。 */
function repairTruncatedJson(text: string): string {
  const source = String(text || "");
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (const char of source) {
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
    } else if (char === "}" || char === "]") {
      if (stack.length && stack[stack.length - 1] === char) stack.pop();
    }
  }
  if (!stack.length && !inString) return source;
  let repaired = source;
  if (inString) repaired += '"';
  while (stack.length) repaired += stack.pop();
  return repaired;
}

/** 去掉正文中用于工具调用的 JSON，保留普通回答。 */
export function stripToolCallText(content: string, hasToolCalls: boolean): string {
  if (!hasToolCalls || typeof content !== "string") return content;
  return content
    .replace(/```(?:json)?\s*[\s\S]*?```/gi, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/\{[\s\S]*?"tool_calls?"[\s\S]*?\}/gi, "")
    .trim();
}

/** 把客户端回传的工具结果编码为上游可读文本（duck.ai 没有 tool role）。 */
export function formatToolResult(entry: { id?: string; name?: string; result?: unknown } = {}): string {
  const name = typeof entry.name === "string" && entry.name ? entry.name : "tool";
  let result = entry.result;
  if (typeof result !== "string") {
    try {
      result = JSON.stringify(result);
    } catch {
      result = String(result ?? "");
    }
  }
  const text = String(result ?? "").slice(0, MAX_TOOL_RESULT_CHARS);
  return `[tool_result] ${name}: ${text}`;
}

/** 将 assistant 工具调用编码为上游可读文本（用于回放历史）。 */
export function formatToolCallsForHistory(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return "";
  return toolCalls
    .map((call) => {
      const record = isPlainObject(call) ? call : null;
      const fn = record && isPlainObject(record.function) ? record.function : record;
      const name = fn && typeof fn.name === "string" ? fn.name : "tool";
      const args = fn && typeof fn.arguments === "string" ? fn.arguments : "{}";
      return `[tool_call] ${name}(${args})`;
    })
    .join("\n");
}

/** 把协议文本注入首条 user 消息（与参考实现 injectProtocolIntoFirstUser 一致）。 */
export function injectToolProtocol<T extends { role: string; content: string }>(messages: T[], protocol: string): T[] {
  if (!protocol || !messages.length) return messages;
  const index = messages.findIndex((message) => message.role === "user");
  if (index < 0) return messages;
  return messages.map((message, i) =>
    i === index ? { ...message, content: `${message.content}\n\n${protocol}` } : message
  );
}

export function toChatToolCalls(calls: DuckAiToolCall[]): DuckAiChatToolCall[] {
  return calls.map((call) => ({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }));
}
