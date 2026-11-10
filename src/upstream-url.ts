/**
 * 上游接口地址拼接
 *
 * 供应商的「Base URL（OpenAI 兼容端点）」两种写法都有人填：
 *   - 裸域名        https://api.openai.com
 *   - 带版本路径    https://apihub.agnes-ai.com/v1
 *                   https://generativelanguage.googleapis.com/v1beta/openai
 *
 * 旧实现一律再补一层 `/v1`，带版本路径的写法会拼成
 * `…/v1/v1/chat/completions`，上游直接 404（Agnes 返回
 * `Invalid URL (POST /v1/v1/chat/completions)`）：
 * 既拉不到模型列表，也发不出对话，这类供应商因此在网关上「配了但用不了」。
 *
 * 这里统一判定一次：Base URL 的路径里已经有版本段就不再补。
 */

/** Base URL 的路径里已经带 API 版本段（/v1、/v1beta、/v2 …） */
export function hasVersionPath(baseUrl: string): boolean {
  const raw = baseUrl.trim();
  let path = raw;
  try {
    path = new URL(raw).pathname;
  } catch {
    // 不是完整 URL：按路径处理
  }
  return /(?:^|\/)v\d+(?:[a-z]+\d*)?(?:\/|$)/i.test(path);
}

/** 去掉多余的斜杠，以及误填成完整接口地址时多出来的尾段（…/v1/chat/completions） */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(?:chat\/completions|completions|models)$/i, "")
    .replace(/\/+$/, "");
}

/**
 * 上游接口地址：`{base}{/v1?}{path}`
 *
 * `upstreamUrl("https://api.openai.com", "/models")`            → https://api.openai.com/v1/models
 * `upstreamUrl("https://apihub.agnes-ai.com/v1", "/models")`    → https://apihub.agnes-ai.com/v1/models
 * `upstreamUrl("…/v1beta/openai", "/chat/completions")`         → …/v1beta/openai/chat/completions
 */
export function upstreamUrl(baseUrl: string, path: string): string {
  const base = normalizeBaseUrl(baseUrl);
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return hasVersionPath(base) ? `${base}${suffix}` : `${base}/v1${suffix}`;
}
