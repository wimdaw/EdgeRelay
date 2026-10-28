/**
 * Anthropic Messages 协议翻译（OpenAI chat/completions <-> Anthropic /v1/messages）
 *
 * 将传入的 OpenAI 请求翻译为 Anthropic Messages 格式，
 * 并将 Anthropic 响应（含 SSE 流式）实时翻译回 OpenAI 标准格式。
 */

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

// =====================================================================
// OpenAI -> Anthropic 请求翻译
// =====================================================================

function contentToBlocks(content: unknown): Array<Record<string, any>> {
  const blocks: Array<Record<string, any>> = [];
  if (typeof content === "string") {
    if (content) blocks.push({ type: "text", text: content });
    return blocks;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, any>;
      if (it.type === "text" && typeof it.text === "string") {
        if (it.text) blocks.push({ type: "text", text: it.text });
      } else if (it.type === "image_url") {
        const url = it.image_url?.url;
        if (typeof url !== "string" || !url) continue;
        if (url.startsWith("data:")) {
          const comma = url.indexOf(",");
          const meta = url.slice(5, comma);
          const data = url.slice(comma + 1);
          const mime = meta.split(";")[0] || "image/png";
          if (data) blocks.push({ type: "image", source: { type: "base64", media_type: mime, data } });
        } else if (/^https?:\/\//.test(url)) {
          blocks.push({ type: "image", source: { type: "url", url } });
        }
      }
    }
  } else if (content && typeof content === "object" && typeof (content as any).text === "string") {
    blocks.push({ type: "text", text: (content as any).text });
  }
  return blocks;
}

function translateTools(tools: unknown): Array<Record<string, any>> | undefined {
  if (!Array.isArray(tools)) return undefined;
  const out: Array<Record<string, any>> = [];
  for (const t of tools) {
    const fn = (t as Record<string, any>)?.function;
    if (!fn?.name) continue;
    out.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      input_schema: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object" },
    });
  }
  return out.length > 0 ? out : undefined;
}

function translateToolChoice(body: Record<string, any>): Record<string, any> | undefined {
  const tc = body.tool_choice;
  if (!tc) return undefined;
  if (tc === "auto") return { type: "auto" };
  if (tc === "required") return { type: "any" };
  if (tc === "none") return undefined;
  if (typeof tc === "object") {
    const name = tc.function?.name || tc.name;
    if (name) return { type: "tool", name };
  }
  return undefined;
}

/** OpenAI chat/completions 请求 -> Anthropic Messages 请求 */
export function openAIToAnthropicRequest(body: Record<string, any>): { request: Record<string, any> } {
  const messages: Array<Record<string, any>> = [];
  const systemParts: string[] = [];

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    const role = msg?.role;
    if (role === "system" || role === "developer") {
      const blocks = contentToBlocks(msg.content);
      for (const b of blocks) if (b.type === "text" && b.text) systemParts.push(b.text);
      continue;
    }
    if (role === "user") {
      const blocks = contentToBlocks(msg.content);
      if (blocks.length > 0) messages.push({ role: "user", content: blocks });
      continue;
    }
    if (role === "assistant") {
      const blocks = contentToBlocks(msg.content);
      for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
        const fn = tc?.function;
        if (!fn?.name) continue;
        let input: unknown = {};
        if (typeof fn.arguments === "string" && fn.arguments.trim()) {
          try {
            input = JSON.parse(fn.arguments);
          } catch {
            input = { _raw: fn.arguments };
          }
        }
        blocks.push({
          type: "tool_use",
          id: tc.id || `toolu_${randomId().replace(/-/g, "").slice(0, 20)}`,
          name: fn.name,
          input,
        });
      }
      if (blocks.length > 0) messages.push({ role: "assistant", content: blocks });
      continue;
    }
    if (role === "tool") {
      const toolUseId = msg.tool_call_id || `toolu_${randomId().replace(/-/g, "").slice(0, 20)}`;
      const blocks = contentToBlocks(msg.content);
      const resultContent = blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: resultContent }],
      });
      continue;
    }
  }

  const request: Record<string, any> = {
    model: body.model,
    max_tokens: Number(body.max_completion_tokens ?? body.max_tokens) || 16384,
    messages,
  };
  if (systemParts.length > 0) request.system = systemParts.join("\n\n");
  const tools = translateTools(body.tools);
  if (tools) {
    request.tools = tools;
    const choice = translateToolChoice(body);
    if (choice) request.tool_choice = choice;
  }
  if (typeof body.temperature === "number") request.temperature = Math.max(0, Math.min(1, body.temperature));
  if (typeof body.top_p === "number") request.top_p = body.top_p;
  const stop = body.stop;
  if (typeof stop === "string" && stop) request.stop_sequences = [stop];
  else if (Array.isArray(stop) && stop.length > 0) request.stop_sequences = stop.filter((s: unknown) => typeof s === "string");
  if (body.stream === true) request.stream = true;
  return { request };
}

// =====================================================================
// Anthropic -> OpenAI 响应翻译（非流式）
// =====================================================================

function finishReasonFromAnthropic(stopReason: unknown): string {
  switch (stopReason) {
    case "max_tokens": return "length";
    case "tool_use": return "tool_calls";
    case "refusal": return "content_filter";
    default: return "stop";
  }
}

export interface OpenAIUsage {
  promptTokens: number;
  completionTokens: number;
}

/** Anthropic Messages 响应 -> OpenAI chat.completion 响应 */
export function anthropicResponseToOpenAI(json: any, requestedModel: string): Record<string, any> {
  const blocks: any[] = Array.isArray(json?.content) ? json.content : [];
  let text = "";
  const toolCalls: Array<Record<string, any>> = [];
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") text += b.text;
    else if (b?.type === "tool_use") {
      toolCalls.push({
        id: b.id || `call_${randomId().replace(/-/g, "").slice(0, 24)}`,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      });
    }
  }
  const message: Record<string, any> = { role: "assistant", content: text || null, refusal: null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const usage = json?.usage || {};
  return {
    id: json?.id || `chatcmpl-${randomId()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReasonFromAnthropic(json?.stop_reason),
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: Number(usage.input_tokens) || 0,
      completion_tokens: Number(usage.output_tokens) || 0,
      total_tokens: (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0),
    },
  };
}

// =====================================================================
// Anthropic SSE -> OpenAI SSE 流式翻译
// =====================================================================

interface SseEvent {
  event: string;
  data: string;
}

function createSseParser(): { feed: (chunk: string) => SseEvent[] } {
  let buffer = "";
  let currentEvent = "";
  let currentData = "";
  const finish = (out: SseEvent[]) => {
    if (currentData) out.push({ event: currentEvent, data: currentData });
    currentEvent = "";
    currentData = "";
  };
  return {
    feed(chunk: string): SseEvent[] {
      buffer += chunk;
      const out: SseEvent[] = [];
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line === "") {
          finish(out);
          currentEvent = "";
        } else if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          currentData += (currentData ? "\n" : "") + line.slice(5).trim();
        }
      }
      return out;
    },
  };
}

export function createOpenAIStreamFromAnthropic(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
  onUsage?: (usage: OpenAIUsage) => void
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const parser = createSseParser();
  let firstChunkSent = false;
  let toolIndex = -1;
  let emittedFinish: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;

  const sendChunk = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    delta: Record<string, any>,
    finish: string | null = null,
    withUsage = false
  ) => {
    const chunk: Record<string, any> = {
      id: `chatcmpl-anthropic-${randomId()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    };
    if (withUsage) {
      chunk.usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
    }
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };

  const handleEvent = (controller: ReadableStreamDefaultController<Uint8Array>, ev: SseEvent) => {
    if (!ev.data || ev.data === "[DONE]") return;
    let payload: any;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      return;
    }
    const type = payload?.type || ev.event;

    switch (type) {
      case "message_start": {
        promptTokens = Number(payload?.message?.usage?.input_tokens) || 0;
        completionTokens = Number(payload?.message?.usage?.output_tokens) || 0;
        break;
      }
      case "content_block_start": {
        const block = payload?.content_block || {};
        if (block.type === "tool_use") {
          toolIndex += 1;
          sendChunk(controller, {
            tool_calls: [
              {
                index: toolIndex,
                id: block.id || `call_${randomId().replace(/-/g, "").slice(0, 24)}`,
                type: "function",
                function: { name: block.name || "", arguments: "" },
              },
            ],
          });
        }
        break;
      }
      case "content_block_delta": {
        const delta = payload?.delta || {};
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          sendChunk(controller, { content: delta.text });
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
          sendChunk(controller, { reasoning_content: delta.thinking });
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json && toolIndex >= 0) {
          sendChunk(controller, { tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] });
        }
        break;
      }
      case "message_delta": {
        const stop = payload?.delta?.stop_reason;
        completionTokens = Math.max(completionTokens, Number(payload?.usage?.output_tokens) || 0);
        if (stop) emittedFinish = finishReasonFromAnthropic(stop);
        break;
      }
      case "message_stop": {
        sendChunk(controller, {}, emittedFinish || "stop", true);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        if (onUsage) onUsage({ promptTokens, completionTokens });
        break;
      }
      case "error": {
        const msg = payload?.error?.message || "上游流错误";
        sendChunk(controller, { content: `[claude] ${msg}` }, "stop", true);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        break;
      }
      default:
        break;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = upstream.getReader();
      const pump = () => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              if (!firstChunkSent) sendChunk(controller, { role: "assistant", content: "" }, "stop", true);
              controller.close();
              return;
            }
            const text = decoder.decode(value, { stream: true });
            for (const ev of parser.feed(text)) {
              if (!firstChunkSent) {
                firstChunkSent = true;
                sendChunk(controller, { role: "assistant", content: "" });
              }
              handleEvent(controller, ev);
            }
            pump();
          })
          .catch(() => {
            try {
              controller.close();
            } catch {}
          });
      };
      pump();
    },
  });
}
