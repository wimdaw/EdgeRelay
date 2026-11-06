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

/** 模型列表：普通用户看不到付费模型 */
playgroundRouter.get("/models", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const [models, providers] = await Promise.all([getModels(c.env), getProviders(c.env)]);
    const activeProviders = new Map(providers.filter((p) => p.status === "active").map((p) => [p.id, p]));

    // 操练场只做对话，过滤掉图片/视频/语音/向量等非对话模型
    const NON_CHAT = /(^|[-_/])(image|video|tts|whisper|speech|embedding|embed|rerank|moderation)([-_/]|$)/i;
    const rows: { id: string; provider: string; paid: boolean }[] = [];
    const seen = new Set<string>();
    for (const m of models) {
      if (m.enabled !== 1) continue;
      const p = activeProviders.get(m.providerId);
      if (!p) continue;
      if (seen.has(m.publicName)) continue;
      if (NON_CHAT.test(m.publicName) || NON_CHAT.test(m.upstreamModel)) continue;
      const pricing = await getPricing(c.env, m.publicName);
      const paid = !!pricing && (pricing.inputPerMillion > 0 || pricing.outputPerMillion > 0);
      if (paid && !isAdminRole(user.role)) continue; // 普通用户不给付费模型
      seen.add(m.publicName);
      rows.push({ id: m.publicName, provider: p.name, paid });
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
