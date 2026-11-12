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
import { decryptSecret } from "./crypto";
import { getProviderKeysAll } from "./storage/db";

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
  /** 发起人邮箱（创建时冗余一份，便于管理员列表直接展示，避免逐条查库） */
  userEmail?: string;
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

/** agnes 支持的画幅（官方文档：21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16） */
const VALID_ASPECT_RATIOS = new Set(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);

/** 把任意 WxH 映射到最接近的合法画幅 */
function nearestAspectRatio(w: number, h: number): string {
  if (!(w > 0 && h > 0)) return "16:9";
  const ratio = w / h;
  let best = "16:9";
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const key of VALID_ASPECT_RATIOS) {
    const [rw, rh] = key.split(":").map(Number);
    const diff = Math.abs(ratio - rw / rh);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = key;
    }
  }
  return best;
}

/** 把客户端请求体裁剪成 agnes 认识的提交参数
 *
 * 官方文档（Agnes Video 2.5 / 2.5 Flash，2026-11）：
 *  - 必填：model、prompt、mode（text / keyframe / reference）
 *  - seconds：**字符串** "4"–"12"，默认 "5"
 *  - size：Flash 固定 "720P"；2.5 另支持 1080P / 1K / 2K
 *  - aspect_ratio：21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16，默认 16:9
 *  - n：当前仅支持 1
 *  - keyframe 模式需 first_frame / last_frame；reference 模式需 images / audios
 *  - 不接受 duration、resolution 等非标字段（上游直接 400）
 */
export function buildAgnesVideoBody(body: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  if (body.model) out.model = String(body.model);
  const prompt = body.prompt ?? body.input;
  if (typeof prompt === "string") out.prompt = prompt;

  // mode 必填：默认文生视频
  const mode = typeof body.mode === "string" && body.mode ? body.mode : "text";
  out.mode = mode;

  // seconds 必须是字符串，且限制在 4~12
  const rawSeconds = body.seconds ?? body.duration;
  if (rawSeconds !== undefined && rawSeconds !== null && rawSeconds !== "") {
    const n = typeof rawSeconds === "number" ? rawSeconds : parseInt(String(rawSeconds), 10);
    if (Number.isFinite(n) && n > 0) out.seconds = String(Math.min(12, Math.max(4, Math.round(n))));
  }

  // size：只透传合法分辨率档位；WxH 之类的按画幅换算
  if (typeof body.size === "string" && body.size) {
    const raw = body.size.trim();
    if (/^(720P|1080P|1K|2K)$/i.test(raw)) {
      out.size = raw.toUpperCase().replace(/^1K$/, "1K").replace(/^2K$/, "2K");
    } else if (SIZE_TO_RATIO[raw.toLowerCase()]) {
      out.aspect_ratio = SIZE_TO_RATIO[raw.toLowerCase()];
    } else if (/^\d+\s*[x×]\s*\d+$/i.test(raw)) {
      const [w, h] = raw.split(/[x×]/i).map((s) => parseInt(s.trim(), 10));
      out.aspect_ratio = nearestAspectRatio(w, h);
    }
  }

  const ratio = typeof body.aspect_ratio === "string" ? body.aspect_ratio.trim() : "";
  if (ratio && VALID_ASPECT_RATIOS.has(ratio)) out.aspect_ratio = ratio;

  // Flash 只有 720P 一档，传 1080P/1K/2K 会被上游 400，这里直接归一
  if (/flash/i.test(String(out.model || ""))) out.size = "720P";

  // 首尾帧 / 参考素材（按官方字段名透传，数量按 Flash 限制截断）
  if (typeof body.first_frame === "string" && body.first_frame) out.first_frame = body.first_frame;
  if (typeof body.last_frame === "string" && body.last_frame) out.last_frame = body.last_frame;
  if (Array.isArray(body.images)) {
    const images = body.images.filter((x: unknown) => typeof x === "string" && x).slice(0, 5);
    if (images.length) out.images = images;
  }
  if (Array.isArray(body.audios)) {
    const audios = body.audios.filter((x: unknown) => typeof x === "string" && x).slice(0, 3);
    if (audios.length) out.audios = audios;
  }

  // seed 为官方支持的可选参数
  if (typeof body.seed === "number" && Number.isFinite(body.seed)) out.seed = Math.trunc(body.seed);

  // n 当前仅支持 1
  out.n = 1;
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
    // 官方文档：video_id 才是用于查询的 ID，id / task_id 只是任务 ID
    const taskId =
      payload?.video_id ||
      payload?.data?.video_id ||
      payload?.task_id ||
      payload?.id ||
      payload?.data?.task_id ||
      payload?.data?.id ||
      "";
    if (!taskId) {
      // 少数情况下上游直接同步返回视频地址
      const url = extractVideoUrl(payload);
      if (url) {
        return { ok: true, httpStatus: 200, taskId: "", status: "completed", url, raw: payload };
      }
      return { ok: false, httpStatus: 502, error: "上游未返回 video_id", raw: payload };
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

/** baseUrl（https://apihub.agnes-ai.com/v1）→ 查询接口根地址（https://apihub.agnes-ai.com） */
function agnesRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/**
 * 轮询 agnes 视频任务
 *
 * 官方推荐：GET /agnesapi?video_id=<VIDEO_ID>&model_name=<MODEL>
 * 兼容回退：GET /v1/videos/<ID>（旧路径，部分账号仍可用）
 */
export async function pollAgnesVideo(
  baseUrl: string,
  apiKey: string,
  videoId: string,
  modelName?: string
): Promise<{ ok: boolean; httpStatus: number; status: VideoTaskStatus; progress: number; url?: string; error?: string; raw?: any }> {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const query = new URLSearchParams({ video_id: videoId });
  if (modelName) query.set("model_name", modelName);
  const urls = [`${agnesRoot(baseUrl)}/agnesapi?${query.toString()}`, `${cleanBase}/videos/${encodeURIComponent(videoId)}`];

  let lastError = "";
  let lastStatus = 0;

  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      });
      const text = await resp.text();
      if (!resp.ok) {
        lastStatus = resp.status;
        lastError = text.slice(0, 500) || `上游查询失败 (${resp.status})`;
        continue;
      }
      let payload: any = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
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
      lastError = (err as Error)?.message || "视频任务查询超时";
      lastStatus = 504;
    }
  }

  return { ok: false, httpStatus: lastStatus || 502, status: "in_progress", progress: 0, error: lastError || "视频任务查询失败" };
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

/** 上游账户额度不足（如 Agnes 的 insufficient_user_quota / pre-consume quota 失败） */
export function isQuotaError(code?: string, message?: string): boolean {
  const c = (code || "").toLowerCase();
  const m = (message || "").toLowerCase();
  if (c.includes("insufficient") && (c.includes("quota") || c.includes("balance"))) return true;
  return m.includes("insufficient_user_quota") || m.includes("pre-consume quota") || m.includes("insufficient quota");
}

/* ==================================================================== */
/* 免 Key 分享链接：签名 token（浏览器可直接打开，24h 有效）                 */
/* ==================================================================== */

function tokenEncoder(): TextEncoder {
  return new TextEncoder();
}

async function hmacHex(env: Env, payload: string): Promise<string> {
  const secret = String((env as any).SESSION_SECRET || "edgerelay-default-session-secret-32b");
  const key = await crypto.subtle.importKey(
    "raw",
    tokenEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, tokenEncoder().encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 生成视频查询 token：{exp}.{hmac} */
export async function signVideoToken(env: Env, videoId: string, ttlSeconds = TASK_TTL_SECONDS): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await hmacHex(env, `${videoId}|${exp}`);
  return `${exp}.${sig}`;
}

/** 校验 token（过期或签名不符一律 false） */
export async function verifyVideoToken(env: Env, videoId: string, token?: string | null): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expect = await hmacHex(env, `${videoId}|${exp}`);
  if (expect.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/** 浏览器端「自动轮询」页面：不依赖任何外部资源，5s 拉一次状态，完成后直接播放 */
export function renderVideoWatchPage(videoId: string, initial: Record<string, unknown>): string {
  const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, "");
  const bootstrap = JSON.stringify(initial).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>视频任务 ${safeId}</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0b0b0f;color:#e7e7ea;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;justify-content:center;padding:24px}
  .card{width:100%;max-width:720px;background:#14141a;border:1px solid #23232c;border-radius:14px;padding:20px}
  h1{font-size:15px;margin:0 0 4px}
  .muted{color:#8b8b96;font-size:12px}
  .row{display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap}
  .pill{padding:2px 8px;border-radius:999px;font-size:11px;background:#23232c;color:#b9b9c4}
  .pill.ok{background:rgba(16,185,129,.15);color:#34d399}
  .pill.err{background:rgba(239,68,68,.15);color:#f87171}
  .bar{height:6px;background:#23232c;border-radius:999px;overflow:hidden;margin-top:12px}
  .bar>i{display:block;height:100%;width:0;background:#6366f1;transition:width .4s}
  video{width:100%;border-radius:10px;margin-top:14px;background:#000}
  a.btn{display:inline-block;margin-top:12px;padding:8px 14px;border-radius:8px;background:#6366f1;color:#fff;text-decoration:none;font-size:13px}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#9ca3af;word-break:break-all}
</style></head>
<body><div class="card">
  <h1>视频生成任务</h1>
  <div class="muted"><code>${safeId}</code></div>
  <div class="row"><span id="status" class="pill">加载中…</span><span id="progressText" class="muted">0%</span></div>
  <div class="bar"><i id="bar"></i></div>
  <div id="err" class="muted" style="margin-top:10px"></div>
  <div id="media"></div>
  <div class="muted" id="hint" style="margin-top:14px">页面每 5 秒自动刷新，生成完成后会直接显示视频与下载链接，可以保持打开。</div>
</div>
<script>
const ID=${JSON.stringify(safeId)};
const state=${bootstrap};
const token=new URLSearchParams(location.search).get('token')||'';
const $=(id)=>document.getElementById(id);
function paint(v){
  const st=v.status||'queued';
  const pill=$('status');
  pill.textContent=({queued:'排队中',in_progress:'生成中',completed:'已完成',failed:'生成失败',cancelled:'已取消'})[st]||st;
  pill.className='pill'+(st==='completed'?' ok':(st==='failed'||st==='cancelled')?' err':'');
  const p=Math.max(0,Math.min(100,Number(v.progress)||0));
  $('bar').style.width=p+'%';
  $('progressText').textContent=p+'%';
  if(v.error&&v.error.message){$('err').textContent='错误：'+v.error.message}
  if(v.url&&!$('media').dataset.done){
    $('media').dataset.done='1';
    $('media').innerHTML='<video controls autoplay muted playsinline src="'+v.url+'"></video><a class="btn" href="'+v.url+'" target="_blank" rel="noopener">打开 / 下载视频</a>';
    $('hint').textContent='生成完成，链接可能有时效，请及时保存。';
  }
}
paint(state);
async function tick(){
  try{
    const r=await fetch('/v1/videos/'+encodeURIComponent(ID)+'/status?token='+encodeURIComponent(token),{cache:'no-store'});
    if(r.ok){const v=await r.json();paint(v);if(v.status==='completed'||v.status==='failed'||v.status==='cancelled'){return}}
  }catch(e){}
  setTimeout(tick,5000);
}
if(state.status!=='completed'&&state.status!=='failed'&&state.status!=='cancelled'){setTimeout(tick,3000)}
</script></body></html>`;
}

/* ==================================================================== */
/* 任务列表（管理端巡检 / 客户端查询）                                      */
/* ==================================================================== */

/** 列出视频任务：可按用户过滤，按创建时间倒序 */
export async function listVideoTasks(
  env: Env,
  opts: { userId?: string; limit?: number } = {}
): Promise<VideoTaskRecord[]> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 20));
  let names: string[] = [];
  try {
    const res = await getKV(env).list({ prefix: "video:task:" });
    names = res.keys.map((k) => k.name);
  } catch {
    return [];
  }

  const ids = names.map((n) => n.slice("video:task:".length)).slice(0, 300);
  const records: VideoTaskRecord[] = [];
  for (const id of ids) {
    const rec = await loadVideoTask(env, id);
    if (!rec) continue;
    if (opts.userId && rec.userId !== opts.userId) continue;
    records.push(rec);
  }
  records.sort((a, b) => b.createdAt - a.createdAt);
  return records.slice(0, limit);
}

/** 取任务对应上游明文 Key */
export async function videoTaskKey(env: Env, rec: VideoTaskRecord): Promise<string> {
  try {
    const keys = await getProviderKeysAll(env, rec.providerId);
    const k = keys.find((x) => x.id === rec.providerKeyId);
    if (!k) return "";
    return await decryptSecret(env, k.encryptedKey);
  } catch {
    return "";
  }
}

/** 刷新单个任务：未完成时回查上游并落库（终态直接返回） */
export async function refreshVideoTask(env: Env, rec: VideoTaskRecord): Promise<VideoTaskRecord> {
  if (isTerminalVideoStatus(rec.status)) return rec;
  const upstreamKey = await videoTaskKey(env, rec);
  if (!upstreamKey) return rec;
  const poll = await pollAgnesVideo(rec.baseUrl, upstreamKey, rec.upstreamTaskId, rec.upstreamModel);
  if (poll.ok) {
    rec.status = poll.status;
    rec.progress = poll.progress;
    if (poll.url) rec.url = poll.url;
    if (poll.error) rec.error = poll.error;
  }
  rec.updatedAt = Math.floor(Date.now() / 1000);
  await saveVideoTask(env, rec);
  return rec;
}

/** 删除任务记录（仅影响本地 KV，不会取消上游任务） */
export async function deleteVideoTask(env: Env, id: string): Promise<void> {
  await getKV(env).delete(taskKey(id)).catch(() => {});
}
