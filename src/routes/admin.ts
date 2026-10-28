/**
 * 管理后台统一路由 /api/admin/*
 */
import { Hono } from "hono";
import type { Env, HandlerCtx, PlatformSettings } from "../types";
import { requireAdminStepUp, requireUser, requireRole, clientIp } from "../auth";
import { ApiError, ErrorCode, errorResponse } from "../errors";
import { uuid, encryptSecret, sha256Hex } from "../crypto";
import { getSettings, updateSettings, json } from "../settings";
import { audit, verifyAuditChain } from "../audit";
import { topup } from "../billing";
import {
  listAllUsers,
  updateUser,
  listAllApiKeys,
  updateApiKey,
  getProviders,
  upsertProvider,
  getProviderKeys,
  upsertProviderKey,
  getModels,
  upsertModel,
  getAllPricing,
  setPricing,
  getAuditLogs,
  getContentFlags,
  getAppeals,
  getDailyUsage,
  getBlobStore,
} from "../storage/db";

export const adminRouter = new Hono<{ Bindings: Env }>();

/** 管理操作统一入口 */
adminRouter.post("/actions", async (c) => {
  const env = c.env;
  const hCtx: HandlerCtx = { env, req: c.req as any };

  try {
    const body = await c.req.json<{ action?: string; payload?: Record<string, unknown> }>();
    const action = body.action ?? "";
    const p = body.payload ?? {};
    const now = Math.floor(Date.now() / 1000);

    const READ_ACTIONS = new Set([
      "list_users",
      "list_all_keys",
      "list_providers",
      "list_models",
      "list_pricing",
      "get_settings",
      "flags_queue",
      "appeals_list",
      "list_audit",
      "get_smtp",
      "get_oauth",
      "list_announcements",
    ]);

    const user = await requireUser(hCtx);
    let admin = user;
    if (READ_ACTIONS.has(action)) {
      requireRole(user, ["admin", "auditor"]);
    } else {
      admin = await requireAdminStepUp(hCtx);
    }

    const done = async (result: unknown, targetType?: string, targetId?: string) => {
      await audit(hCtx, {
        actorUserId: admin.id,
        actorIp: clientIp(hCtx.req),
        action: `admin.${action}`,
        targetType,
        targetId,
        meta: p,
      });
      return json({ ok: true, result });
    };

    switch (action) {
      /* ---- 用户管理 ---- */
      case "list_users": {
        const users = await listAllUsers(env);
        const safe = users.map((u) => ({
          id: u.id,
          email: u.email,
          role: u.role,
          status: u.status,
          created_at: u.createdAt,
        }));
        return json({ ok: true, users: safe });
      }
      case "set_role": {
        const role = String(p.role);
        if (!["user", "admin", "finance", "auditor"].includes(role)) {
          throw new ApiError(400, ErrorCode.BAD_REQUEST, "非法角色");
        }
        await updateUser(env, String(p.userId), { role: role as any });
        return done(null, "user", String(p.userId));
      }
      case "ban_user": {
        await updateUser(env, String(p.userId), { status: "banned" });
        return done(null, "user", String(p.userId));
      }
      case "unban_user": {
        await updateUser(env, String(p.userId), { status: "active" });
        return done(null, "user", String(p.userId));
      }

      /* ---- Key 管理 ---- */
      case "list_all_keys": {
        const keys = await listAllApiKeys(env);
        const safe = keys.map((k) => ({
          id: k.id,
          user_id: k.userId,
          name: k.name,
          prefix: k.prefix,
          status: k.status,
          quota_usd: k.quotaUsd ?? null,
          spent_usd: k.spentUsd ?? 0,
          created_at: k.createdAt,
        }));
        return json({ ok: true, keys: safe });
      }
      case "revoke_any_key": {
        const allKeys = await listAllApiKeys(env);
        const target = allKeys.find((k) => k.id === String(p.keyId));
        if (target) {
          await updateApiKey(env, target.keyHash, { status: "revoked", revokedAt: now });
        }
        return done(null, "api_key", String(p.keyId));
      }

      /* ---- 供应商管理 ---- */
      case "list_providers": {
        const providers = await getProviders(env);
        const out = [];
        for (const pr of providers) {
          const keys = await getProviderKeys(env, pr.id);
          out.push({
            id: pr.id,
            name: pr.name,
            slug: pr.slug,
            base_url: pr.baseUrl,
            status: pr.status,
            authorization_ref: pr.authorizationRef ?? null,
            authorization_expires_at: pr.authorizationExpiresAt ?? null,
            key_count: keys.length,
            extraHeaders: pr.extraHeaders ? JSON.parse(pr.extraHeaders) : {},
            keys: keys.map((k) => ({
              id: k.id,
              label: k.label,
              fingerprint: k.keyFingerprint,
              status: k.status,
              created_at: k.createdAt,
            })),
          });
        }
        return json({ ok: true, providers: out });
      }
      case "upsert_provider": {
        const isNew = !p.id;
        if (isNew && !p.key) throw new ApiError(400, ErrorCode.BAD_REQUEST, "添加供应商必须同时录入上游密钥");
        const id = (p.id as string) || uuid();

        await upsertProvider(env, {
          id,
          name: String(p.name),
          slug: String(p.slug),
          kind: String(p.kind ?? "openai_compat"),
          baseUrl: String(p.baseUrl),
          authScheme: String(p.authScheme ?? "bearer"),
          extraHeaders: p.extraHeaders ? JSON.stringify(p.extraHeaders) : null,
          status: (p.status as "active" | "disabled") ?? "active",
          authorizationRef: (p.authorizationRef as string) ?? null,
          authorizationExpiresAt: (p.authorizationExpiresAt as number) ?? null,
          createdAt: now,
        });

        if (p.key) {
          const plaintext = String(p.key);
          const encryptedKey = await encryptSecret(env, plaintext);
          const keyFingerprint = (await sha256Hex(plaintext)).slice(0, 16);
          await upsertProviderKey(env, {
            id: uuid(),
            providerId: id,
            label: "default",
            encryptedKey,
            keyFingerprint,
            status: "active",
            createdAt: now,
          });
        }
        return done({ id }, "provider", id);
      }
      case "upsert_provider_key": {
        if (!p.providerId || !p.key) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 providerId 或 key");
        const plaintext = String(p.key);
        const encryptedKey = await encryptSecret(env, plaintext);
        const keyFingerprint = (await sha256Hex(plaintext)).slice(0, 16);
        const id = (p.id as string) || uuid();
        await upsertProviderKey(env, {
          id,
          providerId: String(p.providerId),
          label: String(p.label ?? "default"),
          encryptedKey,
          keyFingerprint,
          status: (p.status as "active" | "disabled") ?? "active",
          createdAt: now,
        });
        return done({ id, fingerprint: keyFingerprint }, "provider_key", id);
      }

      /* ---- 模型管理 ---- */
      case "list_models": {
        const models = await getModels(env);
        const pricing = await getAllPricing(env);
        const providers = await getProviders(env);
        const providerMap = new Map(providers.map((pr) => [pr.id, pr]));

        const rows = models.map((m) => {
          const pr = providerMap.get(m.providerId);
          const prc = pricing[m.publicName];
          return {
            id: m.id,
            public_name: m.publicName,
            upstream_model: m.upstreamModel,
            priority: m.priority,
            cost_weight: m.costWeight,
            enabled: m.enabled,
            provider_name: pr?.name ?? null,
            provider_slug: pr?.slug ?? null,
            input_per_million: prc?.inputPerMillion ?? null,
            output_per_million: prc?.outputPerMillion ?? null,
            currency: prc?.currency ?? "CNY",
          };
        });
        return json({ ok: true, models: rows });
      }
      case "upsert_model": {
        const id = (p.id as string) || uuid();
        await upsertModel(env, {
          id,
          publicName: String(p.publicName),
          providerId: String(p.providerId),
          upstreamModel: String(p.upstreamModel),
          priority: Number(p.priority ?? 100),
          costWeight: Number(p.costWeight ?? 1),
          maxContext: (p.maxContext as number) ?? null,
          enabled: p.enabled === false ? 0 : 1,
          createdAt: now,
        });
        return done({ id }, "model", id);
      }
      case "list_pricing": {
        const pricing = await getAllPricing(env);
        const rows = Object.values(pricing).map((pr) => ({
          id: pr.id,
          public_name: pr.publicName,
          input_per_million: pr.inputPerMillion,
          output_per_million: pr.outputPerMillion,
          currency: pr.currency,
        }));
        return json({ ok: true, pricing: rows });
      }
      case "set_pricing": {
        const publicName = String(p.publicName);
        const id = (p.id as string) || uuid();
        await setPricing(env, {
          id,
          publicName,
          inputPerMillion: Number(p.inputPerMillion),
          outputPerMillion: Number(p.outputPerMillion),
          currency: String(p.currency ?? "CNY"),
          createdAt: now,
        });
        return done({ id, publicName }, "pricing", id);
      }

      /* ---- 计费充值 ---- */
      case "topup": {
        const scope = String(p.scope);
        const amount = Number(p.amount);
        if (!Number.isFinite(amount) || amount === 0) throw new ApiError(400, ErrorCode.BAD_REQUEST, "金额不合法");
        await topup(hCtx, scope, amount, `管理员 ${admin.email} 手动充值`);
        return done(null, "balance", scope);
      }

      /* ---- 平台设置 ---- */
      case "get_settings": {
        const s = await getSettings(env);
        return json({ ok: true, settings: s });
      }
      case "set_settings": {
        const updated = await updateSettings(env, p as Partial<PlatformSettings>);
        return done({ settings: updated }, "settings", "platform");
      }

      /* ---- 审计与合规 ---- */
      case "list_audit": {
        const logs = await getAuditLogs(env, Number(p.limit) || 100);
        const safe = logs.map((l) => ({
          id: l.id,
          actor_user_id: l.actorUserId ?? undefined,
          actor_email: null,
          actor_ip: l.actorIp ?? null,
          action: l.action,
          target_type: l.targetType ?? null,
          target_id: l.targetId ?? null,
          meta: l.meta ?? null,
          created_at: l.createdAt,
        }));
        return json({ ok: true, logs: safe });
      }
      case "verify_audit_chain": {
        const res = await verifyAuditChain(env);
        return done(res, "audit_chain", "verify");
      }
      case "flags_queue": {
        const flags = await getContentFlags(env);
        return json({ ok: true, flags });
      }
      case "appeals_list": {
        const appeals = await getAppeals(env);
        return json({ ok: true, appeals });
      }

      default:
        throw new ApiError(400, ErrorCode.BAD_REQUEST, `未知管理操作: ${action}`);
    }
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 实时统计概览：严格对齐前端 Stats 结构 */
adminRouter.get("/stats", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    requireRole(user, ["admin", "auditor"]);

    const today = new Date().toISOString().slice(0, 10);
    const summary = await getDailyUsage(c.env, today);

    const totalN = summary?.requests || 0;
    const successN = summary?.successRequests || 0;
    const errorN = totalN - successN;

    const byModelList = [];
    if (summary?.byModel) {
      for (const [m, data] of Object.entries(summary.byModel)) {
        byModelList.push({ public_model: m, n: data.requests, cost: data.costUsd });
      }
    }

    return json({
      requests: totalN,
      errorRate: totalN ? +(errorN / totalN).toFixed(4) : 0,
      promptTokens: summary?.promptTokens || 0,
      completionTokens: summary?.completionTokens || 0,
      cost: summary?.totalCostUsd || 0,
      currency: "CNY",
      pendingContentFlags: 0,
      byStatus: [
        { status: "success", n: successN },
        { status: "error", n: errorN },
      ],
      byModel: byModelList,
    });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 用量走势图表：对齐前端 { points: TrendPoint[] } */
adminRouter.get("/usage/trend", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    requireRole(user, ["admin", "auditor"]);

    const days = Math.min(Number(c.req.query("days")) || 7, 30);
    const points = [];
    const now = Date.now();

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 86400 * 1000).toISOString().slice(0, 10);
      const s = await getDailyUsage(c.env, d);
      points.push({
        date: d,
        requests: s?.requests || 0,
        tokens: (s?.promptTokens || 0) + (s?.completionTokens || 0),
        errors: (s?.requests || 0) - (s?.successRequests || 0),
        cost: s?.totalCostUsd || 0,
      });
    }

    return json({ days, points });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 用量日志：对齐前端 { logs: UsageLog[] } */
adminRouter.get("/usage/logs", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    requireRole(user, ["admin", "auditor"]);

    const today = new Date().toISOString().slice(0, 10);
    const store = getBlobStore(c.env);
    // 从每日记录列表获取
    const res = await store.list({ prefix: "usage/record/", paginate: false, consistency: "strong" });
    const logs = [];
    for (const b of (res.blobs || []).slice(0, 50)) {
      const r = await store.get(b.key, { type: "json" });
      if (r) {
        logs.push({
          id: r.id,
          request_id: r.requestId,
          user_id: r.userId,
          public_model: r.publicModel,
          status: r.status,
          http_status: r.httpStatus ?? 200,
          latency_ms: r.latencyMs ?? 0,
          prompt_tokens: r.promptTokens ?? 0,
          completion_tokens: r.completionTokens ?? 0,
          cost_usd: r.costUsd ?? 0,
          stream: r.stream ?? 0,
          error_code: r.errorCode ?? null,
          attempts: r.attempts ?? 1,
          ip: r.ip ?? "",
          created_at: r.createdAt,
        });
      }
    }
    return json({ logs });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
