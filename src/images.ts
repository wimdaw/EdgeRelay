/**
 * 图片生成适配层（agnes / OpenAI 兼容 /v1/images/generations）
 *
 * agnes 实测（2026-11）：
 *  - POST {base}/images/generations 为**同步**接口，约 10~20s 直接返回图片地址
 *  - 响应：{ data:[{ url, b64_json, revised_prompt }], created, task_id }
 *  - size 只接受 "1K" / "2K" / "3K" / "4K" / WIDTHxHEIGHT
 *  - response_format 只接受 url | b64_json
 *  - quality / style 等 OpenAI 常见字段会被上游拒绝，必须过滤
 */
import type { UpstreamRoute } from "./types";

/** 该路由是否走 agnes 图片协议：模型名以 agnes-image 开头，或渠道显式声明 agnes_image */
export function isAgnesImageRoute(route: Pick<UpstreamRoute, "providerKind" | "upstreamModel">): boolean {
  const kind = (route.providerKind || "").toLowerCase();
  const model = (route.upstreamModel || "").toLowerCase();
  if (kind === "agnes_image" || kind === "agnes-image") return true;
  return /^agnes-image/.test(model);
}

/** 只保留上游认识的字段，避免 quality/style 这类字段触发 400 */
export function buildAgnesImageBody(body: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  if (body.model) out.model = String(body.model);

  const prompt = body.prompt ?? body.input;
  if (typeof prompt === "string") out.prompt = prompt;

  if (body.size !== undefined && body.size !== null && body.size !== "") {
    const s = String(body.size).trim();
    if (/^\d+k$/i.test(s)) {
      out.size = s.toUpperCase();
    } else if (/^\d{2,5}\s*[x×]\s*\d{2,5}$/i.test(s)) {
      out.size = s.replace(/\s*[×]\s*/i, "x").toLowerCase();
    }
    // 其它取值直接丢弃，交给上游用默认尺寸，避免 400
  }

  const fmt = body.response_format;
  if (fmt === "url" || fmt === "b64_json") out.response_format = fmt;

  const n = Number(body.n);
  if (Number.isFinite(n) && n >= 1) out.n = Math.min(4, Math.round(n));

  return out;
}

export type ImageResult = {
  ok: boolean;
  httpStatus: number;
  /** 上游原始响应体（已文本化），成功时原样透传 */
  body?: string;
  contentType?: string;
  error?: string;
  code?: string;
};

/** 调用上游图片生成（同步） */
export async function generateAgnesImage(
  baseUrl: string,
  apiKey: string,
  body: Record<string, any>,
  timeoutMs = 100_000
): Promise<ImageResult> {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  try {
    const resp = await fetch(`${cleanBase}/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildAgnesImageBody(body)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await resp.text();
    if (!resp.ok) {
      let payload: any = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      return {
        ok: false,
        httpStatus: resp.status,
        code: payload?.code || payload?.error?.code || undefined,
        error: payload?.message || payload?.error?.message || text.slice(0, 500) || `上游返回 ${resp.status}`,
      };
    }
    return {
      ok: true,
      httpStatus: resp.status,
      body: text,
      contentType: resp.headers.get("content-type") || "application/json; charset=utf-8",
    };
  } catch (err) {
    return { ok: false, httpStatus: 504, error: (err as Error)?.message || "图片生成超时" };
  }
}

/** 从上游响应里数出图片张数，用于用量记录 */
export function countGeneratedImages(raw?: string | null): number {
  if (!raw) return 0;
  try {
    const payload = JSON.parse(raw);
    if (Array.isArray(payload?.data)) return payload.data.length;
  } catch {
    // ignore
  }
  return 0;
}
