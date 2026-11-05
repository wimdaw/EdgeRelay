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
import { clientIp } from "../auth";
import { ApiError, ErrorCode, openAiError, errorResponse } from "../errors";
import { getSettings } from "../settings";
import { planModelRoutes, buildRoutesFromPlan } from "../router";
import { getPricing } from "../billing";
import { checkRateLimit, releaseConcurrency, commitRateLimits } from "../ratelimit";
import { readKeyHealth, recordKeySuccess, recordKeyFailure } from "../key-health";
import { uuid, sha256Hex, decryptSecret } from "../crypto";
import {
  getApiKeyByHash,
  getProviderKeys,
  addUsageRecord,
  touchApiKeyUsage,
  commitApiKeyUsage,
} from "../storage/db";
import {
  isAgnesVideoRoute,
  isTerminalVideoStatus,
  isQueueFullError,
  submitAgnesVideo,
  pollAgnesVideo,
  saveVideoTask,
  loadVideoTask,
  getKeyCooldown,
  setKeyCooldown,
  toOpenAiVideoObject,
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

type AuthCtx = {
  keyId: string;
  userId: string;
  row: { modelWhitelist?: string | null };
  limits: { rpm: number; tpm: number; concurrency: number };
  ip: string;
};

/** API Key 认证（与 /v1/chat/completions 同一套校验口径） */
async function authenticate(c: any): Promise<AuthCtx> {
  const env = c.env as Env;
  const authHeader = c.req.header("authorization") ?? "";
  const am = authHeader.match(/^Bearer\s+(sk-gw-\S+)$/i);
  if (!am) throw new ApiError(401, ErrorCode.AUTH_REQUIRED, "缺少 Bearer API Key");

  const keyHash = await sha256Hex(am[1]!);
  const nowSec = Math.floor(Date.now() / 1000);
  const [row, settings] = await Promise.all([getApiKeyByHash(env, keyHash), getSettings(env)]);
  if (!row) throw new ApiError(401, ErrorCode.AUTH_INVALID, "API Key 无效");
  if (row.status === "revoked") throw new ApiError(401, ErrorCode.KEY_REVOKED, "API Key 已撤销");
  if (row.expiresAt && row.expiresAt < nowSec) throw new ApiError(401, ErrorCode.KEY_EXPIRED, "API Key 已过期");
  if (row.quotaUsd !== null && row.quotaUsd !== undefined && row.spentUsd >= row.quotaUsd) {
    throw new ApiError(429, ErrorCode.KEY_QUOTA_EXCEEDED, "该 API Key 额度已用尽");
  }

  const ip = clientIp({
    url: c.req.url,
    method: c.req.method,
    header: (n: string) => c.req.header(n),
    text: () => c.req.text(),
    json: <T = unknown>() => c.req.json<T>(),
  });
  if (row.ipWhitelist) {
    try {
      const list = JSON.parse(row.ipWhitelist) as string[];
      if (list.length && !list.includes(ip)) {
        throw new ApiError(403, ErrorCode.FORBIDDEN, `来源 IP ${ip} 不在白名单内`);
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
    }
  }
  touchApiKeyUsage(env, row.id, { lastUsedAt: nowSec });

  return {
    keyId: row.id,
    userId: row.userId,
    row,
    limits: { rpm: settings.defaultRpm, tpm: settings.defaultTpm, concurrency: 10 },
    ip,
  };
}

/** 模型白名单校验（与对话链路一致，支持 slug/model 形式） */
function assertModelAllowed(row: AuthCtx["row"], publicModel: string): void {
  if (!row.modelWhitelist) return;
  try {
    const whitelist = JSON.parse(row.modelWhitelist) as string[];
    const sub = publicModel.includes("/") ? publicModel.slice(publicModel.indexOf("/") + 1) : publicModel;
    if (Array.isArray(whitelist) && whitelist.length && !whitelist.includes(publicModel) && !whitelist.includes(sub)) {
      throw new ApiError(403, ErrorCode.MODEL_NOT_ALLOWED, `该 Key 无权调用模型 ${publicModel}`);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
  }
}

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
  const raw = body.wait;
  if (raw === undefined || raw === null || raw === false) return DEFAULT_WAIT_MS;
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
    const keys = await getProviderKeys(env, rec.providerId);
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
    const auth = await authenticate(c);
    const body = (await c.req.json<VideoBody>().catch(() => ({}))) as VideoBody;
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
    let record: VideoTaskRecord | null = null;

    for (const route of routes) {
      attempts++;
      const upstreamKey = route.encryptedKey ? await decryptSecret(env, route.encryptedKey) : "";
      const submit = await submitAgnesVideo(route.baseUrl, upstreamKey, { ...body, model: route.upstreamModel });

      if (!submit.ok) {
        // 排队已满属于平台侧的全局限制，换账号也没用，且不能计入 Key 健康度
        if (isQueueFullError(submit.code, submit.error)) {
          queueFull = true;
          lastStatus = 429;
          lastError = "上游视频队列已满，请稍后重试";
          break;
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
        publicModel,
        status: "upstream_error",
        httpStatus: lastStatus || 502,
        latencyMs: Date.now() - started,
        errorCode: queueFull ? "video_queue_full" : lastStatus ? `http_${lastStatus}` : "upstream_error",
        attempts,
        ip: auth.ip,
      });
      if (queueFull) {
        return openAiError(429, ErrorCode.RATE_LIMITED, lastError, { retry_after: 60, code: "video_queue_full" });
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
        const poll = await pollAgnesVideo(record.baseUrl, upstreamKey, record.upstreamTaskId);
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

    if (waitMs > 0) {
      // one-api 风格：data[0].url
      return new Response(
        JSON.stringify({
          created: record.createdAt,
          id: record.id,
          status: record.status,
          progress: record.progress,
          ...(record.url ? { data: [{ url: record.url }] } : { data: [] }),
          ...(record.error ? { error: { message: record.error } } : {}),
        }),
        { headers: { "content-type": "application/json; charset=utf-8" } }
      );
    }

    return new Response(JSON.stringify(toOpenAiVideoObject(record)), {
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

/** 查询任务：终态直接返回缓存，未完成则实时回查上游 */
videoRouter.get("/:id", async (c) => {
  const env = c.env;
  try {
    const auth = await authenticate(c);
    const rec = await loadVideoTask(env, c.req.param("id"));
    if (!rec || rec.userId !== auth.userId) throw new ApiError(404, ErrorCode.NOT_FOUND, "视频任务不存在或已过期");

    if (!isTerminalVideoStatus(rec.status)) {
      const upstreamKey = await keyOf(env, rec);
      if (upstreamKey) {
        const poll = await pollAgnesVideo(rec.baseUrl, upstreamKey, rec.upstreamTaskId);
        if (poll.ok) {
          rec.status = poll.status;
          rec.progress = poll.progress;
          if (poll.url) rec.url = poll.url;
          if (poll.error) rec.error = poll.error;
        }
        rec.updatedAt = Math.floor(Date.now() / 1000);
        await saveVideoTask(env, rec);
      }
    }

    return new Response(JSON.stringify(toOpenAiVideoObject(rec)), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    return errorResponse(c, err);
  }
});

/** 视频文件：直接 302 到上游地址，避免云函数中转大文件 */
videoRouter.get("/:id/content", async (c) => {
  const env = c.env;
  try {
    const auth = await authenticate(c);
    const rec = await loadVideoTask(env, c.req.param("id"));
    if (!rec || rec.userId !== auth.userId) throw new ApiError(404, ErrorCode.NOT_FOUND, "视频任务不存在或已过期");
    if (!rec.url) throw new ApiError(409, ErrorCode.BAD_REQUEST, "视频尚未生成完成");
    return new Response(null, { status: 302, headers: { location: rec.url, "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(c, err);
  }
});
