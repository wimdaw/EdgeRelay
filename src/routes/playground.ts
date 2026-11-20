/**
 * 操练场（Playground）/api/playground/*
 *
 * 面向控制台登录用户（Cookie 会话），对话必须绑定当前账户自己的 API Key：
 *  - GET  /api/playground/models  可用模型列表（普通用户隐藏付费模型）
 *  - POST /api/playground/chat    对话转发，支持 SSE 流式（body.key_id 指定，缺省取当前账户最新可用 Key）
 *
 * 说明：
 *  - 只允许使用当前登录用户名下的 Key，绝不跨账户取用
 *  - 复用网关的路由规划与 Key 池（含健康排序），与 /v1/chat/completions 同一套上游
 *  - 与 /v1 共用同一套计费/用量记录：写入 usage_logs、扣减 Key 用量（免费模型零费用）
 *  - 按 API Key 做每分钟次数限制（KV 计数），并更新 Key 的 last_used_at
 */
import { Hono } from "hono";
import type { ApiKeyRecord, Env, HandlerCtx } from "../types";
import { clientIp, requireUser } from "../auth";
import { assertModelAllowed } from "../api-auth";
import { ApiError, ErrorCode, errorResponse } from "../errors";
import { getSettings, json } from "../settings";
import { getPricing } from "../billing";
import { getApiKeyById, getModels, getProviders, listUserApiKeys, touchApiKeyUsage } from "../storage/db";
import { getBlobStore } from "../storage/blob-store";
import { uuid } from "../crypto";
import { runChatPipeline, type ChatBody, type ChatRequestAuth } from "./chat";
import { runImagesGenerations, type MediaAuthContext } from "./images";
import { runVideoCreate } from "./video";
import { loadVideoTask, refreshVideoTask, signVideoToken, toOpenAiVideoObject } from "../video";
import { handleAzureTtsSpeech, AZURE_TTS_VOICES_GROUPED } from "../azure-tts";
import { publicOrigin } from "../public-url";

export const playgroundRouter = new Hono<{ Bindings: Env }>();

/** 每分钟每 Key 最多对话次数 */
const RPM_LIMIT = 20;

function isAdminRole(role: string): boolean {
  return role === "superadmin" || role === "admin";
}

/** 简单的分钟级限流（KV 计数，按 Key 维度） */
async function checkKeyRpm(env: Env, keyId: string): Promise<{ ok: boolean; used: number }> {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `pg:rl:key:${keyId}:${minute}`;
  try {
    const store = getBlobStore(env);
    const raw = (await store.get(key, { type: "json", consistency: "strong" })) as { n?: number } | null;
    const used = (raw?.n ?? 0) + 1;
    await store.setJSON(key, { n: used });
    return { ok: used <= RPM_LIMIT, used };
  } catch {
    return { ok: true, used: 0 };
  }
}

/** 校验 Key 可用性（过期 / 撤销 / 额度） */
function assertKeyUsable(key: ApiKeyRecord, nowSec: number): void {
  if (key.status === "revoked") throw new ApiError(400, ErrorCode.KEY_REVOKED, "该 API Key 已撤销，请更换或重新创建");
  if (key.expiresAt && key.expiresAt < nowSec) throw new ApiError(400, ErrorCode.KEY_EXPIRED, "该 API Key 已过期，请更换或重新创建");
  if (key.quotaUsd !== null && key.quotaUsd !== undefined && key.spentUsd >= key.quotaUsd) {
    throw new ApiError(429, ErrorCode.KEY_QUOTA_EXCEEDED, "该 API Key 额度已用尽，请更换或重新创建");
  }
}

/**
 * 解析当前账户的 Key：指定 key_id 时必须属于当前登录用户；
 * 未指定时取当前用户名下最新创建且可用的 Key（绝不跨账户）。
 */
async function resolveAccountKey(env: Env, userId: string, keyId?: string): Promise<ApiKeyRecord> {
  const nowSec = Math.floor(Date.now() / 1000);

  if (keyId) {
    const key = await getApiKeyById(env, keyId);
    if (!key || key.userId !== userId) {
      throw new ApiError(403, ErrorCode.FORBIDDEN, "该 API Key 不属于当前账户，不能使用他人的 Key");
    }
    assertKeyUsable(key, nowSec);
    return key;
  }

  const active = (await listUserApiKeys(env, userId))
    .filter((k) => k.status === "active")
    .sort((a, b) => b.createdAt - a.createdAt);
  if (!active.length) {
    throw new ApiError(400, ErrorCode.BAD_REQUEST, "当前账户还没有可用的 API Key，请先在「API 密钥」页创建");
  }
  const usable = active.find(
    (k) => (!k.expiresAt || k.expiresAt >= nowSec) && (k.quotaUsd === null || k.quotaUsd === undefined || k.spentUsd < k.quotaUsd)
  );
  if (usable) return usable;
  assertKeyUsable(active[0], nowSec);
  return active[0];
}

/**
 * 模型分类：返回 chat / image / video / audio，前端据此做端点选项卡与自动匹配。
 * 判定依据（对齐 images.ts / video.ts 的路由过滤口径）：
 *  - video：provider kind 为 agnes_video 或 upstream 以 agnes-video 开头，或名称含视频模型特征
 *  - image：provider kind 为 agnes_image 或 upstream 以 agnes-image 开头，或名称含图片模型特征
 *  - audio：名称含 tts/speech 特征（走内置 Edge TTS，免费）
 *  - 其余归入 chat；embedding/rerank/moderation 等既非对话也非媒体的不进操练场
 */
function classifyPlaygroundModel(publicName: string, upstreamModel: string, providerKind: string | null): "chat" | "image" | "video" | "audio" {
  const kind = (providerKind || "").toLowerCase();
  const up = (upstreamModel || "").toLowerCase();
  const name = (publicName || "").toLowerCase();
  // 检测/审核类模型名字里常带 video/image 字样，但它们不是生成端点，归入 chat
  const isDetector = /detect|detector|moderation|guard/i.test(name);
  if (!isDetector && (kind === "agnes_video" || kind === "agnes-video" || /^agnes-video/.test(up) || /(video|veo|kling|runway|sora|pika|hailuo|vidu)/i.test(name))) {
    return "video";
  }
  if (kind === "agnes_image" || kind === "agnes-image" || /^agnes-image/.test(up) || /(dall-e|dalle|flux|sdxl|stable-diffusion|image|imagen|midjourney|seedream|banana)/i.test(name)) {
    return "image";
  }
  if (/(^|[-_/])(tts|speech|voice|text-to-speech)([-_/]|$)/i.test(name) || /edge-tts/i.test(name)) {
    return "audio";
  }
  return "chat";
}

/** 模型列表：普通用户看不到付费模型；带分类供前端做端点选项卡 */
playgroundRouter.get("/models", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const [models, providers] = await Promise.all([getModels(c.env), getProviders(c.env)]);
    const activeProviders = new Map(providers.filter((p) => p.status === "active").map((p) => [p.id, p]));

    // embedding/rerank/moderation 等既非对话也非媒体端点，操练场不提供
    const UNSUPPORTED = /(^|[-_/])(embedding|embed|rerank|moderation|whisper|transcription)([-_/]|$)/i;
    const rows: { id: string; provider: string; slug: string; paid: boolean; kind: "chat" | "image" | "video" | "audio" }[] = [];
    const seen = new Set<string>();
    for (const m of models) {
      if (m.enabled !== 1) continue;
      const p = activeProviders.get(m.providerId);
      if (!p) continue;
      // 同名模型可存在于多个渠道（如 glm-5.3-flash 分属 nvidia/amd）：按 渠道/模型 规范格式各自保留，
      // 前端展示带渠道前缀即可精确路由，不再跨渠道去重
      const dedupeKey = `${p.slug}/${m.publicName}`;
      if (seen.has(dedupeKey)) continue;
      if (UNSUPPORTED.test(m.publicName) || UNSUPPORTED.test(m.upstreamModel)) continue;
      const kind = classifyPlaygroundModel(m.publicName, m.upstreamModel, p.kind);
      const pricing = await getPricing(c.env, m.publicName);
      const paid = !!pricing && (pricing.inputPerMillion > 0 || pricing.outputPerMillion > 0);
      if (paid && !isAdminRole(user.role)) continue; // 普通用户不给付费模型
      seen.add(dedupeKey);
      rows.push({ id: m.publicName, provider: p.name, slug: p.slug, paid, kind });
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return json({ ok: true, models: rows, rpm_limit: RPM_LIMIT, can_use_paid: isAdminRole(user.role) });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 对话：默认流式，stream=false 时返回完整 JSON */
playgroundRouter.post("/chat", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const body = (await c.req.json().catch(() => ({}))) as {
      model?: string;
      messages?: { role: string; content: unknown }[];
      temperature?: number;
      top_p?: number;
      max_tokens?: number;
      system?: string;
      stream?: boolean;
      key_id?: string;
    };

    const model = String(body.model || "");
    const messages = Array.isArray(body.messages) ? body.messages.filter((m) => m && m.role) : [];
    if (!model) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 model");
    if (!messages.length) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 messages");

    // 只认当前账户自己的 Key：指定则校验归属，未指定则取最新可用一条
    const accountKey = await resolveAccountKey(c.env, user.id, String(body.key_id || "") || undefined);
    assertModelAllowed(accountKey, model);

    const pricing = await getPricing(c.env, model);
    const paid = !!pricing && (pricing.inputPerMillion > 0 || pricing.outputPerMillion > 0);
    if (paid && !isAdminRole(user.role)) {
      throw new ApiError(403, ErrorCode.MODEL_NOT_ALLOWED, `模型 ${model} 为付费模型，普通用户不可在操练场使用`);
    }

    const rpm = await checkKeyRpm(c.env, accountKey.id);
    if (!rpm.ok) {
      throw new ApiError(429, ErrorCode.RATE_LIMITED, `操练场每分钟最多 ${RPM_LIMIT} 次，请稍后再试`);
    }
    touchApiKeyUsage(c.env, accountKey.id, { lastUsedAt: Math.floor(Date.now() / 1000) });

    const stream = body.stream !== false;
    const systemText = typeof body.system === "string" ? body.system.trim() : "";
    const outboundMessages = systemText ? [{ role: "system", content: systemText }, ...messages] : messages;

    // 复用 /v1 同一套流水线：路由规划、限流、计费冻结/结算、usage_logs、断开兜底
    const outboundBody: Record<string, unknown> = { ...body, messages: outboundMessages, model, stream };
    delete outboundBody.key_id;
    delete outboundBody.system;

    const settings = await getSettings(c.env);
    const auth: ChatRequestAuth = {
      requestId: c.req.header("x-request-id") || uuid(),
      started: Date.now(),
      keyId: accountKey.id,
      userId: user.id,
      orgId: accountKey.orgId || null,
      limits: { rpm: settings.defaultRpm, tpm: settings.defaultTpm, concurrency: 10 },
      ip: clientIp(hCtx.req),
      keyRow: accountKey,
    };
    return await runChatPipeline(c, auth, outboundBody as ChatBody);
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/* =====================================================================
 * 媒体端点：图片 / 视频 / 语音（与 /v1 共用同一套上游管线与计费审计）
 * ===================================================================== */

/** 会话鉴权 + Key 解析 + RPM 限制的公共前置，返回管线所需的鉴权上下文 */
async function prepareMediaCall(c: any, keyId?: string): Promise<{ auth: MediaAuthContext; origin: string; user: { id: string } }> {
  const env = c.env as Env;
  const hCtx: HandlerCtx = { env, req: c.req as any };
  const user = await requireUser(hCtx);
  const accountKey = await resolveAccountKey(env, user.id, keyId);
  const rpm = await checkKeyRpm(env, accountKey.id);
  if (!rpm.ok) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, `操练场每分钟最多 ${RPM_LIMIT} 次，请稍后再试`);
  }
  touchApiKeyUsage(env, accountKey.id, { lastUsedAt: Math.floor(Date.now() / 1000) });
  const settings = await getSettings(env);
  return {
    auth: {
      userId: user.id,
      keyId: accountKey.id,
      ip: clientIp(hCtx.req),
      row: accountKey,
      limits: { rpm: settings.defaultRpm, tpm: settings.defaultTpm, concurrency: 10 },
    },
    origin: publicOrigin(c, env),
    user,
  };
}

/** 图片生成：POST /api/playground/images（body 与 /v1/images/generations 一致 + key_id） */
playgroundRouter.post("/images", async (c) => {
  const env = c.env as Env;
  const requestId = c.req.header("x-request-id") || uuid();
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    const { auth } = await prepareMediaCall(c, typeof body.key_id === "string" ? body.key_id : undefined);
    delete body.key_id;
    return await runImagesGenerations(env, auth, body as never, requestId, Date.now());
  } catch (err) {
    return errorResponse({ env, req: c.req as any } as HandlerCtx, err);
  }
});

/** 视频任务提交：POST /api/playground/videos（body 与 /v1/videos/generations 一致 + key_id） */
playgroundRouter.post("/videos", async (c) => {
  const env = c.env as Env;
  const requestId = c.req.header("x-request-id") || uuid();
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    const { auth, origin } = await prepareMediaCall(c, typeof body.key_id === "string" ? body.key_id : undefined);
    delete body.key_id;
    return await runVideoCreate(env, auth, body as never, 0, requestId, Date.now(), origin);
  } catch (err) {
    return errorResponse({ env, req: c.req as any } as HandlerCtx, err);
  }
});

/** 视频任务查询（会话鉴权，只能看自己的任务）：GET /api/playground/videos/:id */
playgroundRouter.get("/videos/:id", async (c) => {
  const env = c.env as Env;
  const hCtx: HandlerCtx = { env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const rec = await loadVideoTask(env, c.req.param("id"));
    if (!rec || rec.userId !== user.id) throw new ApiError(404, ErrorCode.NOT_FOUND, "视频任务不存在或已过期");
    const updated = await refreshVideoTask(env, rec);
    const origin = publicOrigin(c, env);
    const token = await signVideoToken(env, rec.id);
    return json({
      ok: true,
      task: {
        ...toOpenAiVideoObject(updated),
        poll_url: `${origin}/v1/videos/${rec.id}`,
        watch_url: `${origin}/v1/videos/${rec.id}/watch?token=${encodeURIComponent(token)}`,
      },
    });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 语音合成（内置免费 Edge TTS）：POST /api/playground/speech */
playgroundRouter.post("/speech", async (c) => {
  const env = c.env as Env;
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    const input = typeof body.input === "string" ? body.input : typeof body.prompt === "string" ? body.prompt : "";
    if (!input.trim()) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 input 文本");
    await prepareMediaCall(c, typeof body.key_id === "string" ? body.key_id : undefined);
    return await handleAzureTtsSpeech({ ...body, input });
  } catch (err) {
    return errorResponse({ env, req: c.req as any } as HandlerCtx, err);
  }
});

/** 音色清单（操练场下拉用） */
playgroundRouter.get("/voices", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    await requireUser(hCtx);
    return json({ ok: true, voices: AZURE_TTS_VOICES_GROUPED });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
