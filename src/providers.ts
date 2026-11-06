/**
 * 上游适配层
 *  - MVP 统一走 OpenAI 兼容协议（OpenAI / DeepSeek 原生兼容；Anthropic、Google 均提供官方 OpenAI 兼容端点）
 *  - AI Gateway：若配置 CF_ACCOUNT_ID + AI_GATEWAY_ID，自动把上游地址包进 AI Gateway（获得缓存/日志/限速）
 *  - 合规要点：上游密钥仅在内存中短暂解密使用；对外绝不回显 upstreamModel 等上游细节
 */
import type { Env, UpstreamRoute } from "./types";
import { decryptSecret } from "./crypto";

export function aiGatewayUrl(env: Env, providerSlug: string, upstreamUrl: string): string {
  if (!env.CF_ACCOUNT_ID || !env.AI_GATEWAY_ID) return upstreamUrl;
  const slugMap: Record<string, string> = {
    openai: "openai",
    anthropic: "anthropic",
    google: "google-vertexai", // 或 google-ai-studio，按实际接入方式调整
    deepseek: "deepseek",
  };
  const gwSlug = slugMap[providerSlug] ?? providerSlug;
  return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/${gwSlug}`;
}

/**
 * 拼接上游 API 路径，兼容 baseUrl 带不带版本前缀两种写法：
 *  - https://integrate.api.nvidia.com         + /v1/chat/completions => .../v1/chat/completions
 *  - https://integrate.api.nvidia.com/v1      + /v1/chat/completions => .../v1/chat/completions（不重复 /v1）
 * 与 ai-gateway-edgeone 的 baseUrl 口径对齐（该口径下 baseUrl 常带 /v1）。
 */
export function joinApiPath(baseUrl: string, apiPath: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (/\/v\d+(?:beta)?$/i.test(base) && /^\/v\d+(?:beta)?\//i.test(apiPath)) {
    return base + apiPath.replace(/^\/v\d+(?:beta)?/i, "");
  }
  return base + apiPath;
}

export function resolveTarget(env: Env, route: UpstreamRoute, chatPath = "/v1/chat/completions"): { url: string; headers: Record<string, string> } {
  const base = route.baseUrl.replace(/\/+$/, "");
  const url = joinApiPath(aiGatewayUrl(env, route.providerSlug, base), chatPath);
  return { url, headers: {} };
}

export async function buildHeaders(env: Env, route: UpstreamRoute): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // Workers fetch 默认不带 UA，部分上游网关的 WAF 会拦截空 UA（表现为 403/429）
    "user-agent": "Relay/1.0 (+https://api.obitw.cn)",
    ...(route.extraHeaders ?? {}),
  };
  if (route.authScheme === "none" || !route.encryptedKey) {
    return headers;
  }
  const upstreamKey = await decryptSecret(env, route.encryptedKey);
  if (route.authScheme === "x-api-key") {
    headers["x-api-key"] = upstreamKey;
  } else {
    headers["authorization"] = `Bearer ${upstreamKey}`;
  }
  return headers;
}

/** 可重试的 HTTP 错误码 */
export const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** 粗略 token 估算（无法拿到 usage 时的兜底；约 4 字符/token） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 把客户端常见的 thinking 开关/档位映射为 OpenAI 的 reasoning_effort（low/medium/high） */
export function mapThinkingToEffort(thinking: unknown): "low" | "medium" | "high" | undefined {
  if (thinking === true) return "medium";
  if (thinking === false || thinking === null || thinking === undefined) return undefined;
  if (typeof thinking === "number") return thinking >= 3 ? "high" : thinking >= 2 ? "medium" : "low";
  if (typeof thinking === "string") {
    const v = thinking.trim().toLowerCase();
    if (["high", "max", "xhigh", "extended", "deep"].includes(v)) return "high";
    if (["medium", "auto", "default", "standard"].includes(v)) return "medium";
    if (["low", "minimal", "fast", "light", "lite"].includes(v)) return "low";
    return undefined;
  }
  if (typeof thinking === "object") {
    const obj = thinking as Record<string, unknown>;
    const type = String(obj.type ?? "").toLowerCase();
    if (obj.enabled === false || type === "disabled" || type === "off" || type === "none") return undefined;
    const budget = obj.budget_tokens ?? obj.thinking_budget ?? obj.max_thinking_tokens;
    if (typeof budget === "number") return budget >= 4096 ? "high" : budget >= 1024 ? "medium" : "low";
    if (obj.effort !== undefined) return mapThinkingToEffort(obj.effort);
    if (obj.enabled === true || type === "enabled") return "medium";
  }
  return undefined;
}

/**
 * 清理发往 OpenAI 兼容上游的请求体：
 * 针对严格校验参数白名单的上游（如 NVIDIA NIM、AMD Radeon 等），剥离客户端（如 ZCode）注入的非标参数，
 * 避免因 enable_thinking / reasoning / thinking 等字段触发上游 400 Validation 错误。
 */
export function sanitizeUpstreamBody(
  body: Record<string, unknown>,
  route: UpstreamRoute,
  stream?: boolean
): Record<string, unknown> {
  const upstreamBody: Record<string, unknown> = { ...body, model: route.upstreamModel };
  if (stream) upstreamBody.stream_options = { include_usage: true };

  // 顶层 extra_body 是部分客户端 SDK（如 Python/TS openai-sdk）的残留内部字段，所有上游均不接受
  delete upstreamBody.extra_body;

  const isNvidia =
    route.providerSlug === "nvidia" ||
    route.providerId === "nvidia" ||
    (typeof route.baseUrl === "string" && route.baseUrl.includes("nvidia.com"));

  if (isNvidia) {
    // NVIDIA NIM 严格校验 OpenAPI 参数白名单，客户端（如 ZCode）注入的非标思考参数会导致 400：
    // "Validation: Unsupported parameter(s): enable_thinking, reasoning"
    // （底层模型如 MiniMax-M3.1-Flash 已原生默认输出 reasoning_content，无需也不支持这些非标字段）
    delete upstreamBody.enable_thinking;
    delete upstreamBody.reasoning;
    delete upstreamBody.thinking_budget;
    delete upstreamBody.max_thinking_tokens;
    // reasoning_effort 必须为 string（"low" | "medium" | "high"），若为数字或布尔则移除，防止反序列化 400
    if (typeof upstreamBody.reasoning_effort === "number" || typeof upstreamBody.reasoning_effort === "boolean") {
      delete upstreamBody.reasoning_effort;
    }
  }

  const isAmd =
    route.providerSlug === "amd" ||
    route.providerId === "amd" ||
    (typeof route.baseUrl === "string" && route.baseUrl.includes("developer.amd.com.cn"));

  if (isAmd) {
    // AMD Radeon（OpenAI 兼容）不接受 thinking：
    // '"thinking" is not supported on /v1/chat/completions ... Use "reasoning_effort" (or "reasoning.effort")'
    // 只做一次映射，无法映射时丢弃并记非敏感日志，绝不让请求因参数适配失败。
    const thinking = upstreamBody.thinking;
    const rawEffort = upstreamBody.reasoning_effort;
    // 先把已有 reasoning_effort 归一到 low/medium/high（数字/布尔/未知字符串一律丢弃或映射）
    let effort: "low" | "medium" | "high" | undefined;
    if (rawEffort !== undefined) {
      effort = mapThinkingToEffort(rawEffort);
      if (effort) upstreamBody.reasoning_effort = effort;
      else {
        delete upstreamBody.reasoning_effort;
        console.warn(`[sanitize] amd: reasoning_effort 无法识别，已丢弃 (model=${route.upstreamModel})`);
      }
    }
    const mapped = thinking !== undefined ? mapThinkingToEffort(thinking) : undefined;
    if (!effort && mapped) upstreamBody.reasoning_effort = mapped;
    if (thinking !== undefined && !mapped) {
      console.warn(`[sanitize] amd: thinking 无法映射为 reasoning_effort，已丢弃 (model=${route.upstreamModel})`);
    }
    delete upstreamBody.thinking;
    delete upstreamBody.thinking_budget;
    delete upstreamBody.max_thinking_tokens;
    delete upstreamBody.enable_thinking;
    // reasoning 对象：若顶层已有合法 reasoning_effort 则移除，避免与上游要求冲突
    const reasoning = upstreamBody.reasoning;
    if (reasoning !== undefined) {
      if (!upstreamBody.reasoning_effort && reasoning && typeof reasoning === "object") {
        const m = mapThinkingToEffort((reasoning as Record<string, unknown>).effort);
        if (m) upstreamBody.reasoning_effort = m;
        else console.warn(`[sanitize] amd: reasoning.effort 无法映射，已丢弃 (model=${route.upstreamModel})`);
      }
      delete upstreamBody.reasoning;
    }
  }

  return upstreamBody;
}
