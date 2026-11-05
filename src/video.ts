/**
 * 视频生成适配层（agnes 异步任务模式）
 *
 * agnes 的视频接口与 OpenAI Sora 不同，是「提交 + 轮询」两段式：
 *   1) POST {base}/videos             → { task_id | video_id | id, status }
 *   2) GET  {base}/videos/{task_id}   → { status, progress, metadata.url }
 *
 * 本模块把两段式包装成 OpenAI 兼容的视频对象，并负责：
 *  - 上游状态 → OpenAI 状态（queued / in_progress / completed / failed / cancelled）的归一
 *  - 任务映射落 KV（video:task:{id}，24h 过期），让 GET /v1/videos/{id} 能反查上游任务
 *  - 与 ai-gateway-edgeone 的 video-proxy 保持同一套字段口径（task_id / metadata.url）
 */
import type { Env, UpstreamRoute } from "./types";
import { getKV } from "./storage/blob-store";

/** 提交与轮询的超时（毫秒）；单次请求不能超过云函数 120s 上限 */
const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 20_000;
/** 任务映射保留时长（秒） */
const TASK_TTL_SECONDS = 86_400;

export type VideoTaskStatus = "queued" | "in_progress" | "completed" | "failed" | "cancelled";

export type VideoTaskRecord = {
  id: string;
  providerId: string;
  providerKeyId: string;
  providerSlug: string;
  baseUrl: string;
  /** 对外模型名（客户端传入的 model） */
  model: string;
  /** 上游模型名（可能是 agnes-video-2.5 等） */
  upstreamModel: string;
  upstreamTaskId: string;
  status: VideoTaskStatus;
  progress: number;
  url?: string;
  error?: string;
  seconds?: number;
  size?: string;
  userId: string;
  apiKeyId: string;
  createdAt: number;
  updatedAt: number;
};

/** 该路由是否走 agnes 异步视频协议：渠道显式声明 agnes_video，或上游模型名以 agnes-video 开头
 *
 * 注意：不能只看渠道 slug 是否为 agnes —— agnes 同时提供对话/图片/视频模型，
 * 用 slug 判定会把 agnes-2.5-flash 这类对话模型也送进 /videos 接口（上游会 400）。
 */
export function isAgnesVideoRoute(route: Pick<UpstreamRoute, "providerKind" | "providerSlug" | "upstreamModel">): boolean {
  const kind = (route.providerKind || "").toLowerCase();
  const model = (route.upstreamModel || "").toLowerCase();
  if (kind === "agnes_video" || kind === "agnes-video") return true;
  return /^agnes-video/.test(model);
}

/** 上游状态归一（agnes 同一状态可能返回多种写法） */
export function mapVideoStatus(raw?: string | null): VideoTaskStatus {
  const s = (raw || "").toLowerCase();
  if (["completed", "complete", "succeeded", "success", "saved", "done", "finished"].includes(s)) return "completed";
  if (["failed", "failure", "error", "cancelled", "canceled"].includes(s)) return s.startsWith("cancel") ? "cancelled" : "failed";
  if (["processing", "running", "in_progress", "generating", "started"].includes(s)) return "in_progress";
  return "queued";
}

/** 从上游响应里尽可能提取视频地址 */
export function extractVideoUrl(payload: any): string {
  if (!payload) return "";
  const candidates = [
    payload?.metadata?.url,
    payload?.metadata?.video_url,
    payload?.url,
    payload?.video_url,
    payload?.output?.url,
    payload?.output?.[0]?.url,
    payload?.data?.[0]?.url,
    payload?.result?.url,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  return "";
}

/** 常见客户端尺寸 → 宽高比（agnes 只接受 aspect_ratio，不接受任意 WxH） */
const SIZE_TO_RATIO: Record<string, string> = {
  "1280x720": "16:9",
  "1920x1080": "16:9",
  "1792x1024": "16:9",
  "720x1280": "9:16",
  "1080x1920": "9:16",
  "1024x1792": "9:16",
  "1024x1024": "1:1",
  "720x720": "1:1",
};

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** 把客户端请求体裁剪成 agnes 认识的提交参数
 *
 * agnes 的真实字段约束（2026-11 实测）：
 *  - 必填：model、prompt、mode（文生视频固定 "text"）
 *  - 可选：seconds（整数秒）、aspect_ratio（如 "16:9"）、size（仅接受 "720P"）
 *  - 不接受：duration、resolution —— 传了会直接 400
 */
export function buildAgnesVideoBody(body: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  if (body.model) out.model = String(body.model);
  const prompt = body.prompt ?? body.input;
  if (typeof prompt === "string") out.prompt = prompt;

  // mode 必填：默认文生视频；客户端显式传 image 类模式时原样透传
  const mode = typeof body.mode === "string" && body.mode ? body.mode : "text";
  out.mode = mode;

  const rawSeconds = body.seconds ?? body.duration;
  if (rawSeconds !== undefined && rawSeconds !== null && rawSeconds !== "") {
    const n = typeof rawSeconds === "number" ? rawSeconds : parseInt(String(rawSeconds), 10);
    if (Number.isFinite(n) && n > 0) out.seconds = Math.round(n);
  }

  // size 只认 "720P"；OpenAI Sora 风格的 "1280x720" 等按宽高换算成 aspect_ratio
  if (typeof body.size === "string" && body.size) {
    const raw = body.size.trim();
    if (/^720p$/i.test(raw)) {
      out.size = "720P";
    } else if (SIZE_TO_RATIO[raw.toLowerCase()]) {
      out.aspect_ratio = SIZE_TO_RATIO[raw.toLowerCase()];
    } else if (/^\d+\s*[x×]\s*\d+$/i.test(raw)) {
      const [w, h] = raw.split(/[x×]/i).map((s) => parseInt(s.trim(), 10));
      if (w > 0 && h > 0) {
        const g = gcd(w, h);
        out.aspect_ratio = `${w / g}:${h / g}`;
      }
    } else {
      out.aspect_ratio = raw;
    }
  }
  if (typeof body.aspect_ratio === "string" && body.aspect_ratio) out.aspect_ratio = body.aspect_ratio;
  if (typeof body.image === "string" && body.image) out.image = body.image;
  if (typeof body.negative_prompt === "string" && body.negative_prompt) out.negative_prompt = body.negative_prompt;
  if (typeof body.seed === "number") out.seed = body.seed;
  return out;
}

/** 提交 agnes 视频任务 */
export async function submitAgnesVideo(
  baseUrl: string,
  apiKey: string,
  body: Record<string, any>
): Promise<{
  ok: boolean;
  httpStatus: number;
  taskId?: string;
  status?: VideoTaskStatus;
  url?: string;
  error?: string;
  /** 上游业务错误码，如 video_queue_full */
  code?: string;
  raw?: any;
}> {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  try {
    const resp = await fetch(`${cleanBase}/videos`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildAgnesVideoBody(body)),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
    const text = await resp.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!resp.ok) {
      return {
        ok: false,
        httpStatus: resp.status,
        code: payload?.code || payload?.error?.code || undefined,
        error: payload?.message || payload?.error?.message || text.slice(0, 500) || `上游提交失败 (${resp.status})`,
        raw: payload,
      };
    }
    const taskId = payload?.task_id || payload?.video_id || payload?.id || payload?.data?.task_id || payload?.data?.id || "";
    if (!taskId) {
      // 少数情况下上游直接同步返回视频地址
      const url = extractVideoUrl(payload);
      if (url) {
        return { ok: true, httpStatus: 200, taskId: "", status: "completed", url, raw: payload };
      }
      return { ok: false, httpStatus: 502, error: "上游未返回 task_id", raw: payload };
    }
    return {
      ok: true,
      httpStatus: 200,
      taskId: String(taskId),
      status: mapVideoStatus(payload?.status),
      url: extractVideoUrl(payload),
      raw: payload,
    };
  } catch (err) {
    return { ok: false, httpStatus: 504, error: (err as Error)?.message || "视频任务提交超时" };
  }
}

/** 轮询 agnes 视频任务 */
export async function pollAgnesVideo(
  baseUrl: string,
  apiKey: string,
  taskId: string
): Promise<{ ok: boolean; httpStatus: number; status: VideoTaskStatus; progress: number; url?: string; error?: string; raw?: any }> {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  try {
    const resp = await fetch(`${cleanBase}/videos/${encodeURIComponent(taskId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    const text = await resp.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!resp.ok) {
      return { ok: false, httpStatus: resp.status, status: "failed", progress: 0, error: text.slice(0, 500) || `上游查询失败 (${resp.status})` };
    }
    const status = mapVideoStatus(payload?.status);
    const progressRaw = Number(payload?.progress);
    const progress = Number.isFinite(progressRaw) ? Math.max(0, Math.min(100, Math.round(progressRaw))) : status === "completed" ? 100 : 0;
    return {
      ok: true,
      httpStatus: 200,
      status,
      progress,
      url: extractVideoUrl(payload) || undefined,
      error: status === "failed" ? JSON.stringify(payload?.error || payload?.message || "上游生成失败").slice(0, 500) : undefined,
      raw: payload,
    };
  } catch (err) {
    return { ok: false, httpStatus: 504, status: "in_progress", progress: 0, error: (err as Error)?.message || "视频任务查询超时" };
  }
}

/** 归一为 OpenAI 兼容视频对象（Sora 的 GET /v1/videos/{id} 口径） */
export function toOpenAiVideoObject(rec: VideoTaskRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: rec.id,
    object: "video",
    model: rec.model,
    status: rec.status,
    progress: rec.progress,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
  };
  if (rec.seconds) out.seconds = String(rec.seconds);
  if (rec.size) out.size = rec.size;
  if (rec.url) out.url = rec.url;
  if (rec.error) out.error = { message: rec.error };
  return out;
}

function taskKey(id: string): string {
  return `video:task:${id}`;
}

export async function saveVideoTask(env: Env, rec: VideoTaskRecord): Promise<void> {
  try {
    await getKV(env).put(taskKey(rec.id), JSON.stringify(rec), { expirationTtl: TASK_TTL_SECONDS });
  } catch {
    // 映射写入失败不影响本次提交结果，仅影响后续状态回查
  }
}

export async function loadVideoTask(env: Env, id: string): Promise<VideoTaskRecord | null> {
  try {
    const raw = await getKV(env).get(taskKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as VideoTaskRecord;
  } catch {
    return null;
  }
}

/** 状态机：completed / failed / cancelled 为终态，不再轮询上游 */
export function isTerminalVideoStatus(status: VideoTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/* ==================================================================== */
/* 免费账号额度节流：1 次/分钟/账号                                           */
/* ==================================================================== */

/** 单个账号两次提交之间的最小间隔（秒），与 agnes 免费层限制对齐 */
export const VIDEO_KEY_COOLDOWN_SECONDS = 60;

function cooldownKey(providerId: string, keyId: string): string {
  return `video:cooldown:${providerId}:${keyId}`;
}

/** 返回该账号剩余冷却秒数（0 表示可用） */
export async function getKeyCooldown(env: Env, providerId: string, keyId: string): Promise<number> {
  try {
    const raw = await getKV(env).get(cooldownKey(providerId, keyId));
    if (!raw) return 0;
    const expiresAt = Number(raw);
    if (!Number.isFinite(expiresAt)) return 0;
    return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  } catch {
    return 0;
  }
}

/** 提交成功后写入冷却，避免同一账号一分钟内重复提交被上游拒绝 */
export async function setKeyCooldown(
  env: Env,
  providerId: string,
  keyId: string,
  seconds = VIDEO_KEY_COOLDOWN_SECONDS
): Promise<void> {
  try {
    await getKV(env).put(cooldownKey(providerId, keyId), String(Date.now() + seconds * 1000), {
      expirationTtl: seconds + 5,
    });
  } catch {
    // 冷却写入失败只影响节流精度，不阻断请求
  }
}

/** 上游「排队已满」：不是账号问题，不能计入 Key 健康度 */
export function isQueueFullError(code?: string, message?: string): boolean {
  const c = (code || "").toLowerCase();
  const m = (message || "").toLowerCase();
  return c.includes("queue_full") || m.includes("queue is full") || m.includes("queue_full");
}
