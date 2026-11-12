/**
 * 视频生成接口 /v1/videos（OpenAI 兼容）
 *
 * 端点：
 *  - POST /v1/videos                     创建任务，立即返回视频对象（status=queued/in_progress）
 *  - GET  /v1/videos/{id}               查询任务进度；agnes 异步任务在此实时回查上游
 *  - GET  /v1/videos/{id}/content       302 跳转到上游视频文件
 *  - POST /v1/videos/generations        旧版 one-api 风格的「同步等待」端点（默认等 60s，上限 100s）
 *
 * 说明：
 *  - 复用对话链路的 API Key 认证、模型白名单、RPM/并发限流与上游 Key 池健康熔断
 *  - 视频任务映射写入 KV（video:task:{id}，24h），GET 时按 id 反查上游渠道与凭据
 *  - 视频按次计费尚未定价，usage_logs 记 0 token / 0 费用，仅做审计与限流计数
 */
import { Hono } from "hono";
import type { Env, UpstreamRoute } from "../types";
import { ApiError, ErrorCode, openAiError, errorResponse } from "../errors";
import { authenticateSkGwKey, assertModelAllowed } from "../api-auth";
import { publicOrigin } from "../public-url";
import { planModelRoutes, buildRoutesFromPlan } from "../router";
import { getPricing } from "../billing";
import { checkRateLimit, releaseConcurrency, commitRateLimits } from "../ratelimit";
import { readKeyHealth, recordKeySuccess, recordKeyFailure } from "../key-health";
import { uuid, decryptSecret } from "../crypto";
import { getProviderKeys, getProviderKeysAll, addUsageRecord, commitApiKeyUsage, getUserById } from "../storage/db";
import {
  isAgnesVideoRoute,
  refreshVideoTask,
  listVideoTasks,
  isTerminalVideoStatus,
  isQueueFullError,
  isQuotaError,
  isWaitingSlot,
  QUEUE_RETRY_INTERVAL_SECONDS,
  MAX_QUEUE_RETRIES,
  submitAgnesVideo,
  pollAgnesVideo,
  saveVideoTask,
  loadVideoTask,
  getKeyCooldown,
  setKeyCooldown,
  toOpenAiVideoObject,
  signVideoToken,
  verifyVideoToken,
  renderVideoWatchPage,
  type VideoTaskRecord,
} from "../video";

export const videoRouter = new Hono<{ Bindings: Env }>();

/** 单次请求最多尝试的上游路由数（与对话链路一致） */
const MAX_VIDEO_ROUTES = 3;
/** /v1/videos/generations 同步等待上限，留出云函数 120s 的余量 */
const MAX_WAIT_MS = 100_000;
const DEFAULT_WAIT_MS = 60_000;
const POLL_INTERVAL_MS = 4_000;

type VideoBody = {
  model?: string;
  prompt?: string;
  input?: string;
  seconds?: number | string;
  duration?: number | string;
  size?: string;
  image?: string;
  negative_prompt?: string;
  seed?: number;
  wait?: number | boolean;
};

/** 按优先级/成本展开候选路由，并带上 Key 池与健康度 */
async function resolveRoutes(env: Env, publicModel: string): Promise<UpstreamRoute[]> {
  const plans = await planModelRoutes(env, publicModel);
  if (!plans.length) return [];
  const routes: UpstreamRoute[] = [];
  for (const plan of plans) {
    const [keys, health] = await Promise.all([getProviderKeys(env, plan.provider.id), readKeyHealth(env, plan.provider.id)]);
    routes.push(...buildRoutesFromPlan(env, plan, keys, health));
  }
  return routes;
}

function waitMsFromBody(body: VideoBody): number {
  // 默认立即返回任务 + poll_url，由客户端自行轮询；只有显式传 wait 才同步等待
  const raw = body.wait;
  if (raw === undefined || raw === null || raw === false) return 0;
  if (raw === true) return DEFAULT_WAIT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WAIT_MS;
  // 允许按秒传入，也兼容毫秒级大数
  const ms = n > 1000 ? n : n * 1000;
  return Math.min(MAX_WAIT_MS, Math.max(0, Math.round(ms)));
}

async function logUsage(
  env: Env,
  args: {
    requestId: string;
    userId: string;
    userEmail?: string | null;
    apiKeyId: string;
    publicModel: string;
    providerId?: string | null;
    upstreamModel?: string | null;
    status: string;
    httpStatus: number;
    latencyMs: number;
    errorCode?: string | null;
    attempts: number;
    ip: string;
  }
): Promise<void> {
  await Promise.all([
    addUsageRecord(env, {
      id: uuid(),
      requestId: args.requestId,
      userId: args.userId,
      userEmail: args.userEmail ?? null,
      apiKeyId: args.apiKeyId,
      publicModel: args.publicModel,
      providerId: args.providerId ?? null,
      upstreamModel: args.upstreamModel ?? null,
      status: args.status,
      httpStatus: args.httpStatus,
      latencyMs: args.latencyMs,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      currency: "CNY",
      stream: 0,
      errorCode: args.errorCode ?? null,
      attempts: args.attempts,
      ip: args.ip,
      createdAt: Math.floor(Date.now() / 1000),
    }),
    commitApiKeyUsage(env),
  ]).catch(() => {});
}

/** 取指定任务对应的上游明文 Key */
async function keyOf(env: Env, rec: VideoTaskRecord): Promise<string> {
  try {
    const keys = await getProviderKeysAll(env, rec.providerId);
    const k = keys.find((x) => x.id === rec.providerKeyId);
    if (!k) return "";
    return await decryptSecret(env, k.encryptedKey);
  } catch {
    return "";
  }
}

/** 创建视频任务（POST /v1/videos 与 POST /v1/videos/generations 共用） */
async function createVideo(c: any, waitMs: number): Promise<Response> {
  const env = c.env as Env;
  const requestId = c.req.header("x-request-id") || uuid();
  const started = Date.now();
  let concKeyId: string | null = null;

  try {
    const auth = await authenticateSkGwKey(c);
    const body = (await c.req.json().catch(() => ({}))) as VideoBody;
    if (!body.model) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 model");
    const prompt = typeof body.prompt === "string" ? body.prompt : typeof body.input === "string" ? body.input : "";
    if (!prompt.trim()) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 prompt");

    const publicModel = body.model;
    assertModelAllowed(auth.row, publicModel);

    const pricing = (await getPricing(env, publicModel)) ?? null;
    const limitResult = await checkRateLimit(env, auth.keyId, auth.limits, pricing?.rpmLimit, publicModel);
    if (!limitResult.ok) {
      await commitRateLimits(env);
      return openAiError(429, ErrorCode.RATE_LIMITED, limitResult.reason || "RPM 超限，请稍后重试", {
        retry_after: limitResult.retryAfter,
      });
    }
    if (auth.limits.concurrency > 0) concKeyId = auth.keyId;

    const candidates = (await resolveRoutes(env, publicModel)).filter(isAgnesVideoRoute);
    if (!candidates.length) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, `模型 ${publicModel} 不支持视频生成（当前仅支持 agnes-video 系列）`);
    }

    /* ---- 免费账号额度节流：每个账号 1 次/分钟，跳过冷却中的账号 ---- */
    const routes: UpstreamRoute[] = [];
    let minCooldown = Number.POSITIVE_INFINITY;
    for (const r of candidates) {
      if (r.providerKeyId === "keyless") {
        routes.push(r);
        continue;
      }
      const cd = await getKeyCooldown(env, r.providerId, r.providerKeyId);
      if (cd <= 0) routes.push(r);
      else minCooldown = Math.min(minCooldown, cd);
      if (routes.length >= MAX_VIDEO_ROUTES) break;
    }
    if (!routes.length) {
      const wait = Number.isFinite(minCooldown) ? Math.max(1, minCooldown) : 60;
      return openAiError(429, ErrorCode.RATE_LIMITED, `视频账号仍在冷却（免费账号 1 次/分钟），请 ${wait} 秒后重试`, {
        retry_after: wait,
        code: "video_key_cooldown",
      });
    }

    let attempts = 0;
    let lastStatus = 0;
    let lastError = "";
    let queueFull = false;
    let quotaError = "";
    let record: VideoTaskRecord | null = null;

    for (const route of routes) {
      attempts++;
      const upstreamKey = route.encryptedKey ? await decryptSecret(env, route.encryptedKey) : "";
      const submit = await submitAgnesVideo(route.baseUrl, upstreamKey, { ...body, model: route.upstreamModel });

      if (!submit.ok) {
        // 排队已满属于平台侧的全局限制，换账号也没用，且不能计入 Key 健康度
        if (isQueueFullError(submit.code, submit.error)) {
          queueFull = true;
          lastStatus = 503;
          lastError = "上游视频队列已满，请稍后重试";
          break;
        }
        // 上游账户余额不足：余额属于账号而非 Key，不记 Key 健康度；换下一个 Key 可能换到有余额的账号
        if (isQuotaError(submit.code, submit.error)) {
          quotaError = submit.error || "上游账户余额不足";
          lastStatus = 402;
          continue;
        }
        lastStatus = submit.httpStatus;
        lastError = submit.error || "上游提交失败";
        if (route.providerKeyId !== "keyless") {
          await recordKeyFailure(env, route.providerId, route.providerKeyId, submit.httpStatus === 401 || submit.httpStatus === 402).catch(() => {});
        }
        continue;
      }

      if (route.providerKeyId !== "keyless") {
        await recordKeySuccess(env, route.providerId, route.providerKeyId).catch(() => {});
        await setKeyCooldown(env, route.providerId, route.providerKeyId);
      }

      const secondsRaw = body.seconds ?? body.duration;
      const secondsNum = secondsRaw === undefined ? NaN : Number(secondsRaw);
      record = {
        id: `video_${uuid().replace(/-/g, "").slice(0, 20)}`,
        providerId: route.providerId,
        providerKeyId: route.providerKeyId,
        providerSlug: route.providerSlug,
        baseUrl: route.baseUrl,
        model: publicModel,
        upstreamModel: route.upstreamModel,
        upstreamTaskId: submit.taskId || "",
        status: submit.status || "queued",
        progress: submit.status === "completed" ? 100 : 0,
        url: submit.url || undefined,
        seconds: Number.isFinite(secondsNum) ? secondsNum : undefined,
        size: body.size,
        userId: auth.userId,
        apiKeyId: auth.keyId,
        userEmail: (await getUserById(env, auth.userId).catch(() => null))?.email,
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      };
      await saveVideoTask(env, record);
      break;
    }

    if (!record) {
      await logUsage(env, {
        requestId,
        userId: auth.userId,
        apiKeyId: auth.keyId,
        userEmail: (await getUserById(env, auth.userId).catch(() => null))?.email,
        publicModel,
        status: "upstream_error",
        httpStatus: lastStatus || 502,
        latencyMs: Date.now() - started,
        errorCode: queueFull ? "video_queue_full" : quotaError ? "upstream_quota_exhausted" : lastStatus ? `http_${lastStatus}` : "upstream_error",
        attempts,
        ip: auth.ip,
      });
      if (queueFull) {
        // 上游是"容量不足"而不是"你请求太快"：503 更准确，仍带 retry_after 方便客户端退避。
        // 同时把这次请求挂进排队表：之后每分钟自动重投一次，挤到空位就转正常轮询，
        // 客户端即使放弃轮询，后台也能把这个视频跑出来。
        const first = candidates[0];
        const nowSec = Math.floor(Date.now() / 1000);
        const secRaw = body.seconds ?? body.duration;
        const secNum = secRaw === undefined ? NaN : Number(secRaw);
        const waiting: VideoTaskRecord = {
          id: `video_${uuid().replace(/-/g, "").slice(0, 20)}`,
          providerId: first?.providerId ?? "",
          providerKeyId: first?.providerKeyId ?? "",
          providerSlug: first?.providerSlug ?? "",
          baseUrl: first?.baseUrl ?? "",
          model: publicModel,
          upstreamModel: first?.upstreamModel ?? publicModel,
          upstreamTaskId: "",
          status: "queued",
          progress: 0,
          error: "等待上游队列空位（每分钟自动重试一次）",
          seconds: Number.isFinite(secNum) ? secNum : undefined,
          size: typeof body.size === "string" ? body.size : undefined,
          userId: auth.userId,
          apiKeyId: auth.keyId,
          userEmail: (await getUserById(env, auth.userId).catch(() => null))?.email,
          createdAt: nowSec,
          updatedAt: nowSec,
          requestBody: queueRequestBody(body as Record<string, any>),
          nextRetryAt: nowSec + QUEUE_RETRY_INTERVAL_SECONDS,
          retryCount: 0,
        };
        await saveVideoTask(env, waiting);
        return openAiError(503, ErrorCode.UPSTREAM_ERROR, lastError, {
          retry_after: QUEUE_RETRY_INTERVAL_SECONDS,
          code: "video_queue_full",
          task_id: waiting.id,
          poll_url: `/v1/videos/${waiting.id}`,
          queue_waiting: true,
        });
      }
      if (quotaError) {
        return openAiError(402, ErrorCode.INSUFFICIENT_BALANCE, `上游账户余额不足，无法创建视频任务：${quotaError}`, {
          code: "upstream_quota_exhausted",
        });
      }
      return openAiError(lastStatus === 401 ? 401 : 502, ErrorCode.UPSTREAM_ERROR, lastError || "视频任务提交失败", {
        attempts,
      });
    }

    /* ---- 旧版同步端点：在时限内轮询到完成，尽量一次返回可播放地址 ---- */
    if (waitMs > 0 && !isTerminalVideoStatus(record.status)) {
      const deadline = Math.min(started + waitMs, started + MAX_WAIT_MS);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const upstreamKey = await keyOf(env, record);
        if (!upstreamKey) break;
        const poll = await pollAgnesVideo(record.baseUrl, upstreamKey, record.upstreamTaskId, record.upstreamModel);
        if (poll.ok) {
          record.status = poll.status;
          record.progress = poll.progress;
          if (poll.url) record.url = poll.url;
          if (poll.error) record.error = poll.error;
        }
        record.updatedAt = Math.floor(Date.now() / 1000);
        await saveVideoTask(env, record);
        if (isTerminalVideoStatus(record.status)) break;
      }
    }

    await logUsage(env, {
      requestId,
      userId: auth.userId,
      apiKeyId: auth.keyId,
      publicModel,
      providerId: record.providerId,
      upstreamModel: record.upstreamModel,
      status: record.status === "failed" ? "upstream_error" : "success",
      httpStatus: record.status === "failed" ? 502 : 200,
      latencyMs: Date.now() - started,
      errorCode: record.status === "failed" ? "video_generation_failed" : null,
      attempts,
      ip: auth.ip,
    });

    const origin = publicOrigin(c, env);
    const pollUrl = `${origin}/v1/videos/${record.id}`;
    const watchToken = await signVideoToken(env, record.id);
    const watchUrl = `${origin}/v1/videos/${record.id}/watch?token=${encodeURIComponent(watchToken)}`;

    if (waitMs > 0) {
      // one-api 风格：data[0].url
      return new Response(
        JSON.stringify({
          created: record.createdAt,
          id: record.id,
          status: record.status,
          progress: record.progress,
          poll_url: pollUrl,
          watch_url: watchUrl,
          ...(record.url ? { data: [{ url: record.url }] } : { data: [] }),
          ...(record.error ? { error: { message: record.error } } : {}),
        }),
        { headers: { "content-type": "application/json; charset=utf-8" } }
      );
    }

    return new Response(JSON.stringify({ ...toOpenAiVideoObject(record), poll_url: pollUrl, watch_url: watchUrl }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    return errorResponse(c, err);
  } finally {
    if (concKeyId) await releaseConcurrency(env, concKeyId).catch(() => {});
    await commitRateLimits(env).catch(() => {});
  }
}

videoRouter.post("/", async (c) => createVideo(c, 0));

videoRouter.post("/generations", async (c) => {
  const body = (await c.req.json<VideoBody>().catch(() => ({}))) as VideoBody;
  return createVideo(c, waitMsFromBody(body));
});

function taskUrls(c: any, id: string, watchToken?: string): { poll_url: string; watch_url?: string } {
  const origin = publicOrigin(c, c.env);
  const out: { poll_url: string; watch_url?: string } = { poll_url: `${origin}/v1/videos/${id}` };
  if (watchToken) out.watch_url = `${origin}/v1/videos/${id}/watch?token=${encodeURIComponent(watchToken)}`;
  return out;
}

/** 任务列表（需 API Key）：当前账号最近的视频任务 */
videoRouter.get("/", async (c) => {
  const env = c.env;
  try {
    const auth = await authenticateSkGwKey(c);
    const limit = Number(c.req.query("limit") ?? 20);
    const tasks = await listVideoTasks(env, { userId: auth.userId, limit });
    const origin = publicOrigin(c, env);
    return new Response(
      JSON.stringify({
        object: "list",
        data: tasks.map((t) => ({
          ...toOpenAiVideoObject(t),
          poll_url: `${origin}/v1/videos/${t.id}`,
        })),
      }),
      { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** 查询任务（需 API Key）：终态直接返回缓存，未完成则实时回查上游 */
videoRouter.get("/:id", async (c) => {
  const env = c.env;
  try {
    const auth = await authenticateSkGwKey(c);
    const id = c.req.param("id");
    const rec = await loadVideoTask(env, id);
    if (!rec || rec.userId !== auth.userId) throw new ApiError(404, ErrorCode.NOT_FOUND, "视频任务不存在或已过期");

    const updated = await refreshVideoTask(env, await advanceIfWaiting(env, rec));
    const token = await signVideoToken(env, id);
    return new Response(JSON.stringify({ ...toOpenAiVideoObject(updated), ...taskUrls(c, id, token) }), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/**
 * 自动轮询到完成（需 API Key）
 * GET /v1/videos/{id}/wait?timeout=100
 *  - 完成：200 + url
 *  - 超时未完成：202 + 当前状态 + poll_url（继续调用即可，任务不会丢）
 */
videoRouter.get("/:id/wait", async (c) => {
  const env = c.env;
  try {
    const auth = await authenticateSkGwKey(c);
    const id = c.req.param("id");
    const rec = await loadVideoTask(env, id);
    if (!rec || rec.userId !== auth.userId) throw new ApiError(404, ErrorCode.NOT_FOUND, "视频任务不存在或已过期");

    // 云函数上限 120s，留出收尾余量
    const timeoutSec = Math.min(110, Math.max(5, Number(c.req.query("timeout") ?? 100) || 100));
    const deadline = Date.now() + timeoutSec * 1000;
    let current = rec;

    while (!isTerminalVideoStatus(current.status)) {
      current = await refreshVideoTask(env, current);
      if (isTerminalVideoStatus(current.status)) break;
      if (Date.now() + 3000 >= deadline) break;
      await new Promise((r) => setTimeout(r, 3000));
    }

    const token = await signVideoToken(env, id);
    const body = JSON.stringify({ ...toOpenAiVideoObject(current), ...taskUrls(c, id, token) });
    return new Response(body, {
      status: isTerminalVideoStatus(current.status) ? 200 : 202,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** 生成免 Key 分享链接（需 API Key）：浏览器直接打开，页面自己轮询到完成 */
videoRouter.post("/:id/share", async (c) => {
  const env = c.env;
  try {
    const auth = await authenticateSkGwKey(c);
    const id = c.req.param("id");
    const rec = await loadVideoTask(env, id);
    if (!rec || rec.userId !== auth.userId) throw new ApiError(404, ErrorCode.NOT_FOUND, "视频任务不存在或已过期");

    const ttlSec = Math.min(86_400, Math.max(60, Number(c.req.query("ttl") ?? 86_400) || 86_400));
    const token = await signVideoToken(env, id, ttlSec);
    const origin = publicOrigin(c, env);
    return new Response(
      JSON.stringify({
        id,
        watch_url: `${origin}/v1/videos/${id}/watch?token=${encodeURIComponent(token)}`,
        status_url: `${origin}/v1/videos/${id}/status?token=${encodeURIComponent(token)}`,
        expires_at: Math.floor(Date.now() / 1000) + ttlSec,
      }),
      { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** 免 Key 状态查询（凭签名 token）：页面轮询用 */
videoRouter.get("/:id/status", async (c) => {
  const env = c.env;
  try {
    const id = c.req.param("id");
    if (!(await verifyVideoToken(env, id, c.req.query("token")))) {
      throw new ApiError(403, ErrorCode.FORBIDDEN, "分享链接无效或已过期");
    }
    const rec = await loadVideoTask(env, id);
    if (!rec) throw new ApiError(404, ErrorCode.NOT_FOUND, "视频任务不存在或已过期");
    const updated = await refreshVideoTask(env, await advanceIfWaiting(env, rec));
    return new Response(JSON.stringify(toOpenAiVideoObject(updated)), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** 免 Key 观看页（凭签名 token）：自动轮询并在完成后直接播放 */
videoRouter.get("/:id/watch", async (c) => {
  const env = c.env;
  try {
    const id = c.req.param("id");
    if (!(await verifyVideoToken(env, id, c.req.query("token")))) {
      throw new ApiError(403, ErrorCode.FORBIDDEN, "分享链接无效或已过期");
    }
    const rec = await loadVideoTask(env, id);
    if (!rec) throw new ApiError(404, ErrorCode.NOT_FOUND, "视频任务不存在或已过期");
    const updated = await refreshVideoTask(env, rec);
    const html = renderVideoWatchPage(id, {
      ...toOpenAiVideoObject(updated),
    } as Record<string, unknown>);
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** 视频文件：直接 302 到上游地址，避免云函数中转大文件 */
videoRouter.get("/:id/content", async (c) => {
  const env = c.env;
  try {
    const auth = await authenticateSkGwKey(c);
    const id = c.req.param("id");
    const rec = await loadVideoTask(env, id);
    if (!rec || rec.userId !== auth.userId) throw new ApiError(404, ErrorCode.NOT_FOUND, "视频任务不存在或已过期");
    if (!rec.url) throw new ApiError(409, ErrorCode.BAD_REQUEST, "视频尚未生成完成");
    return new Response(null, { status: 302, headers: { location: rec.url, "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/* ==================================================================== */
/* 排队等空位：上游队列满时挂着，每分钟自动重投一次                          */
/* ==================================================================== */

/** 存进排队表的请求体：去掉 wait（那是本次请求的语义），超长字符串截断，控制 KV 体积 */
function queueRequestBody(body: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (k === "wait" || v === undefined || v === null) continue;
    if (typeof v === "string") {
      out[k] = v.length > 4000 ? v.slice(0, 4000) : v;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * 重投一条排队中的任务：重新解析路由（可能换到别的 Key/渠道），
 * 成功则转成正常任务，仍是队列满就顺延一分钟，余额不足直接判失败。
 */
export async function retryQueuedVideoTask(env: Env, rec: VideoTaskRecord): Promise<VideoTaskRecord> {
  if (!isWaitingSlot(rec)) return rec;
  const nowSec = Math.floor(Date.now() / 1000);
  if ((rec.nextRetryAt ?? 0) > nowSec) return rec;

  if ((rec.retryCount ?? 0) >= MAX_QUEUE_RETRIES) {
    rec.status = "failed";
    rec.error = `排队超时：重试 ${rec.retryCount} 次仍未等到上游空位，请稍后重新提交`;
    rec.nextRetryAt = undefined;
    rec.updatedAt = nowSec;
    await saveVideoTask(env, rec);
    return rec;
  }

  const body = rec.requestBody || {};
  const candidates = (await resolveRoutes(env, rec.model)).filter(isAgnesVideoRoute);
  let queueFull = false;
  let quotaError = "";
  let lastError = "";

  for (const route of candidates.slice(0, MAX_VIDEO_ROUTES)) {
    const upstreamKey = route.encryptedKey ? await decryptSecret(env, route.encryptedKey) : "";
    const submit = await submitAgnesVideo(route.baseUrl, upstreamKey, { ...body, model: route.upstreamModel });

    if (!submit.ok) {
      if (isQueueFullError(submit.code, submit.error)) {
        queueFull = true;
        break;
      }
      if (isQuotaError(submit.code, submit.error)) {
        quotaError = submit.error || "上游账户余额不足";
        continue;
      }
      lastError = submit.error || "上游提交失败";
      continue;
    }

    rec.providerId = route.providerId;
    rec.providerKeyId = route.providerKeyId;
    rec.providerSlug = route.providerSlug;
    rec.baseUrl = route.baseUrl;
    rec.upstreamModel = route.upstreamModel;
    rec.upstreamTaskId = submit.taskId || "";
    rec.status = submit.status || "queued";
    rec.progress = submit.status === "completed" ? 100 : 0;
    if (submit.url) rec.url = submit.url;
    rec.error = undefined;
    rec.retryCount = (rec.retryCount ?? 0) + 1;
    rec.nextRetryAt = undefined;
    rec.updatedAt = Math.floor(Date.now() / 1000);
    if (route.providerKeyId !== "keyless") {
      await recordKeySuccess(env, route.providerId, route.providerKeyId).catch(() => {});
      await setKeyCooldown(env, route.providerId, route.providerKeyId);
    }
    await saveVideoTask(env, rec);
    return rec;
  }

  rec.retryCount = (rec.retryCount ?? 0) + 1;
  rec.updatedAt = Math.floor(Date.now() / 1000);
  if (queueFull) {
    rec.status = "queued";
    rec.nextRetryAt = Math.floor(Date.now() / 1000) + QUEUE_RETRY_INTERVAL_SECONDS;
    rec.error = `等待上游队列空位（已重试 ${rec.retryCount} 次，每分钟自动再试）`;
  } else if (quotaError) {
    rec.status = "failed";
    rec.error = `上游账户余额不足：${quotaError}`;
    rec.nextRetryAt = undefined;
  } else {
    rec.status = "failed";
    rec.error = lastError || "重投失败";
    rec.nextRetryAt = undefined;
  }
  await saveVideoTask(env, rec);
  return rec;
}

/** 批量重投到期的排队任务（调用方负责控制频率：控制台轮询/状态查询时顺带触发） */
export async function retryQueuedVideoTasks(env: Env, tasks: VideoTaskRecord[], limit = 3): Promise<number> {
  const nowSec = Math.floor(Date.now() / 1000);
  const due = tasks
    .filter((t) => isWaitingSlot(t) && (t.nextRetryAt ?? 0) <= nowSec)
    // 先来先投：列表是按创建时间倒序给的，这里反过来，避免老任务被新任务一直挤在后面饿死
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, limit);
  for (const t of due) {
    await retryQueuedVideoTask(env, t).catch(() => {});
  }
  return due.length;
}

/** 状态查询时顺带推进排队任务：到期就重投一次，客户端轮询即可驱动，不依赖控制台 */
async function advanceIfWaiting(env: Env, rec: VideoTaskRecord): Promise<VideoTaskRecord> {
  if (!isWaitingSlot(rec)) return rec;
  return await retryQueuedVideoTask(env, rec);
}
