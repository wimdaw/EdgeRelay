/**
 * Duck.ai 结束标记、拒答与推理内容的解析
 * 对齐 LandmineHQ/duckai-cpa（src/duck/sse.js parseDoneFrame、src/openai/errors.js mapUpstreamError）：
 * - [LIMIT_*] 出现在 [DONE] 帧尾部，映射为对应 HTTP 错误
 * - [STOP_REASON:x] 映射为 OpenAI finish_reason
 * - role:"refusal" 表示模型拒答，映射为 403 content_filter
 * - role:"reasoning" 的 text-delta 是思维链增量，done 帧的 summaryText 只作为兜底
 */

export type DuckAiLimit = {
  status: number;
  code: string;
  type: string;
  message: string;
};

export type DuckAiMarkers = {
  done: boolean;
  limit: DuckAiLimit | null;
  stopReason: string | null;
};

const LIMIT_RULES: Array<{ marker: string; limit: DuckAiLimit }> = [
  {
    marker: "[LIMIT_ACCOUNT]",
    limit: { status: 403, code: "upstream_subscription_required", type: "model_unavailable", message: "Duck.ai 上游提示当前账号额度用尽，需要订阅" },
  },
  {
    marker: "[LIMIT_ENTITY]",
    limit: { status: 429, code: "user_limit_exceeded", type: "rate_limit_exceeded", message: "Duck.ai 上游对该身份的请求已达上限，请稍后重试" },
  },
  {
    marker: "[LIMIT_CONVERSATION]",
    // 参考实现用 409，但 EdgeRelay 网关把 409 视为可重试上游故障并改写成 502，故改用 400（客户端语义等价）
    limit: { status: 400, code: "conversation_limit_reached", type: "invalid_request_error", message: "会话过长，已达到 Duck.ai 上游限制" },
  },
  {
    marker: "[LIMIT_IMAGE_GENERATIONS]",
    limit: { status: 429, code: "image_generation_limit_exceeded", type: "rate_limit_exceeded", message: "Duck.ai 上游图片生成次数已达上限" },
  },
];

/** 解析 [DONE] 帧尾部携带的伪标记。 */
export function parseDuckMarkers(payload: string): DuckAiMarkers {
  const matched = LIMIT_RULES.find((rule) => payload.includes(rule.marker));
  const stopMatch = /\[STOP_REASON:(\w+)\]/.exec(payload);
  return {
    done: payload.includes("[DONE]"),
    limit: matched ? matched.limit : null,
    stopReason: stopMatch ? stopMatch[1] : null,
  };
}

/** 与 duckai-cpa 的 normalizeFinishReason 一致。 */
export function normalizeDuckFinishReason(reason: string | null): "stop" | "length" | "content_filter" {
  const value = (reason || "").trim().toLowerCase();
  if (value === "length" || value === "max_tokens" || value === "max_output_tokens") return "length";
  if (value === "content_filter") return "content_filter";
  return "stop";
}

/** 取 reasoning 事件的增量文本；done 帧的 summaryText 仅作为兜底返回。 */
export function extractReasoningDelta(ev: Record<string, unknown>): { text: string; fallback: string } {
  if (ev.role !== "reasoning") return { text: "", fallback: "" };
  if (ev.state === "done") {
    const summary = Array.isArray(ev.summaryText)
      ? ev.summaryText.filter((part) => typeof part === "string").join("")
      : typeof ev.summaryText === "string"
        ? ev.summaryText
        : "";
    return { text: "", fallback: summary };
  }
  if (typeof ev.text === "string") return { text: ev.text, fallback: "" };
  if (typeof ev.message === "string") return { text: ev.message, fallback: "" };
  return { text: "", fallback: "" };
}

export function isRefusalEvent(ev: Record<string, unknown>): boolean {
  return ev.role === "refusal";
}

/** 流已开始后无法改状态码，按 OpenAI 约定以 error 事件收尾（与 cpa sendStreamError 一致）。 */
export function streamErrorEvent(error: { status?: number; code: string; type: string; message: string }): string {
  return `data: ${JSON.stringify({
    error: {
      message: error.message,
      type: error.type,
      code: error.code,
      status: error.status,
    },
  })}\n\n`;
}

export const REFUSAL_ERROR: DuckAiLimit = {
  status: 403,
  code: "content_filter",
  type: "content_filter",
  message: "模型拒绝回答该请求（Duck.ai 上游拒答）",
};
