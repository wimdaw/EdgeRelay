/**
 * Web 反代渠道通用工具桥接
 *
 * ChatGPT 网页版 / Kimi 网页版 / MiniMax Agent / 灵犀这几个网页反代只有文本通道，
 * 上游没有原生 function calling。这里复用 Amazon Quick 的 prompt 工具协议：
 *  1. 把客户端 tools 定义注入 system 提示词
 *  2. 把历史 assistant.tool_calls / tool 结果折成文本，兼容不认识 tool 角色的上游
 *  3. 响应侧把 <client_tool_call> 标签解析回 OpenAI tool_calls（流式同样处理）
 *
 * DeepSeek / Gemini 网页版已有各自的工具桥（tools.ts / geminiweb.ts），不在此处重复包装。
 */
import {
  QuickBridgeStream,
  buildQuickToolBridgePrompt,
  extractQuickToolDefs,
  parseQuickClientToolCalls,
  parseQuickToolChoice,
  quickArgumentString,
  quickContentText,
  type QuickToolCall,
} from "../oauth/awsquick-wire";

export const WEB_TOOL_BRIDGE_TYPES = new Set(["chatgptweb", "kimiweb", "minimaxweb", "lingxi"]);

export type PreparedWebToolBody = {
  body: Record<string, any>;
  allowed: Set<string>;
  enabled: boolean;
};

function appendSystemContent(content: any, addition: string): any {
  if (typeof content === "string") return content.trim() ? `${content}\n\n${addition}` : addition;
  if (Array.isArray(content)) return [...content, { type: "text", text: addition }];
  return addition;
}

/** 把工具调用 / 工具结果历史折成普通文本，兼容只认 user/assistant 的网页上游 */
function normalizeToolHistory(messages: any[]): any[] {
  return messages.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const m = raw as Record<string, any>;
    const role = String(m.role ?? "").toLowerCase();

    if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const lines: string[] = [];
      for (const item of m.tool_calls) {
        const tc = item as Record<string, any>;
        const fn = (tc?.function ?? {}) as Record<string, any>;
        const id = String(tc?.id ?? "").trim() || "unknown";
        const name = String(fn?.name ?? "").trim() || "unknown";
        lines.push(`Assistant tool call (id=${id}, name=${name}): ${quickArgumentString(fn?.arguments)}`);
      }
      const base = quickContentText(m.content).trim();
      return { ...m, content: [base, ...lines].filter(Boolean).join("\n") };
    }

    if (role === "tool" || role === "function") {
      const id = String(m.tool_call_id ?? "").trim();
      const name = String(m.name ?? "").trim();
      const meta = [id ? `call_id=${id}` : "", name ? `name=${name}` : ""].filter(Boolean).join(", ");
      const text = quickContentText(m.content) || "(empty)";
      return { role: "user", content: `[Tool result${meta ? ` (${meta})` : ""}]: ${text}` };
    }

    return m;
  });
}

/** 请求侧：注入工具协议并归一化工具历史 */
export function prepareWebToolBody(type: string, body: Record<string, any>): PreparedWebToolBody {
  const unchanged: PreparedWebToolBody = { body, allowed: new Set(), enabled: false };
  if (!WEB_TOOL_BRIDGE_TYPES.has(type)) return unchanged;

  const defs = extractQuickToolDefs(body?.tools, body?.functions);
  const choice = parseQuickToolChoice(body?.tool_choice ?? body?.function_call);
  if (!defs.length || choice.mode === "none") return unchanged;

  const parallel = body?.parallel_tool_calls !== false;
  const allowed = new Set(defs.map((d) => d.name));
  if (choice.mode === "function" && choice.name) allowed.add(choice.name);
  const prompt = buildQuickToolBridgePrompt(defs, choice, parallel);
  if (!prompt) return unchanged;

  const messages = normalizeToolHistory(Array.isArray(body?.messages) ? body.messages : []);
  const systemIndex = messages.findIndex((m) => {
    const role = String(m?.role ?? "").toLowerCase();
    return role === "system" || role === "developer";
  });
  if (systemIndex >= 0) {
    const current = messages[systemIndex] as Record<string, any>;
    messages[systemIndex] = { ...current, role: "system", content: appendSystemContent(current?.content, prompt) };
  } else {
    messages.unshift({ role: "system", content: prompt });
  }

  return { body: { ...body, messages }, allowed, enabled: true };
}

function jsonHeaders(resp: Response): Headers {
  const headers = new Headers(resp.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return headers;
}

async function wrapJsonResponse(resp: Response, allowed: Set<string>): Promise<Response> {
  const text = await resp.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return new Response(text, { status: resp.status, headers: resp.headers });
  }
  if (!json || typeof json !== "object" || json.error) {
    return new Response(text, { status: resp.status, headers: resp.headers });
  }
  const choices = Array.isArray(json.choices) ? json.choices : [];
  for (const choice of choices) {
    const message = choice?.message;
    if (!message || typeof message !== "object") continue;
    const content = quickContentText(message.content);
    const parsed = parseQuickClientToolCalls(content, allowed);
    if (!parsed.calls.length) continue;
    message.content = parsed.text || null;
    message.tool_calls = parsed.calls.map((c: QuickToolCall) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }));
    choice.finish_reason = "tool_calls";
  }
  return new Response(JSON.stringify(json), { status: resp.status, headers: jsonHeaders(resp) });
}

function wrapSseResponse(resp: Response, allowed: Set<string>): Response {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let buffer = "";
      let template: Record<string, any> | null = null;
      let roleSent = false;
      let finishReason = "stop";
      let usage: any = null;
      let hadError = false;

      const push = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };
      const emitDelta = (delta: Record<string, any>, finish: string | null = null) => {
        const base = template || {};
        push(
          `data: ${JSON.stringify({
            id: base.id,
            object: "chat.completion.chunk",
            created: base.created,
            model: base.model,
            choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
          })}\n\n`
        );
      };
      const ensureRole = () => {
        if (roleSent) return;
        roleSent = true;
        emitDelta({ role: "assistant" });
      };
      const bridge = new QuickBridgeStream(allowed, (text) => {
        if (!text) return;
        ensureRole();
        emitDelta({ content: text });
      });

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          for (;;) {
            const sep = buffer.indexOf("\n\n");
            if (sep < 0) break;
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            for (const rawLine of frame.split("\n")) {
              const line = rawLine.trimEnd();
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data) continue;
              if (data === "[DONE]") continue;
              let json: any;
              try {
                json = JSON.parse(data);
              } catch {
                continue;
              }
              if (json?.error) {
                hadError = true;
                push(`data: ${JSON.stringify(json)}\n\n`);
                continue;
              }
              if (!template && json && typeof json === "object") {
                template = { id: json.id, created: json.created, model: json.model };
              }
              const choice = json?.choices?.[0];
              if (choice) {
                const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};
                if (typeof delta.role === "string" && delta.role && !roleSent) {
                  roleSent = true;
                  emitDelta({ role: delta.role });
                }
                if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
                  ensureRole();
                  emitDelta({ reasoning_content: delta.reasoning_content });
                }
                if (typeof delta.content === "string" && delta.content) bridge.push(delta.content);
                if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
                  ensureRole();
                  emitDelta({ tool_calls: delta.tool_calls });
                }
                if (choice.finish_reason) finishReason = String(choice.finish_reason);
              }
              if (Array.isArray(json?.choices) && json.choices.length === 0 && json.usage) usage = json.usage;
            }
          }
        }

        if (!hadError) {
          const calls = bridge.finish();
          if (calls.length) {
            ensureRole();
            for (let i = 0; i < calls.length; i++) {
              const call = calls[i]!;
              emitDelta({
                tool_calls: [
                  { index: i, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } },
                ],
              });
            }
            emitDelta({}, "tool_calls");
          } else {
            emitDelta({}, finishReason || "stop");
          }
          if (usage) {
            const base = template || {};
            push(
              `data: ${JSON.stringify({
                id: base.id,
                object: "chat.completion.chunk",
                created: base.created,
                model: base.model,
                choices: [],
                usage,
              })}\n\n`
            );
          }
        }
        push("data: [DONE]\n\n");
      } catch (err: any) {
        push(
          `data: ${JSON.stringify({
            error: { message: String(err?.message || err), type: "upstream_error", code: "upstream_error" },
          })}\n\n`
        );
        push("data: [DONE]\n\n");
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  const headers = new Headers(resp.headers);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache, no-transform");
  headers.set("x-accel-buffering", "no");
  return new Response(stream, { status: resp.status, headers });
}

/** 响应侧：把模型输出里的工具标签翻译成 OpenAI tool_calls */
export async function wrapWebToolResponse(resp: Response, allowed: Set<string>): Promise<Response> {
  if (!allowed.size) return resp;
  const contentType = resp.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) return wrapSseResponse(resp, allowed);
  return wrapJsonResponse(resp, allowed);
}
