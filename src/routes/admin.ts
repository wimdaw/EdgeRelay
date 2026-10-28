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
          createdAt: u.createdAt,
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
          userId: k.userId,
          name: k.name,
          prefix: k.prefix,
          status: k.status,
          quotaUsd: k.quotaUsd,
          spentUsd: k.spentUsd,
          createdAt: k.createdAt,
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
            ...pr,
            extraHeaders: pr.extraHeaders ? JSON.parse(pr.extraHeaders) : {},
            keys: keys.map((k) => ({
              id: k.id,
              label: k.label,
              fingerprint: k.keyFingerprint,
              status: k.status,
              createdAt: k.createdAt,
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
        return json({ ok: true, models });
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
        return json({ ok: true, pricing: Object.values(pricing) });
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
        return json({ ok: true, logs });
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

/** 实时统计概览 */
adminRouter.get("/stats", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    requireRole(user, ["admin", "auditor"]);

    const today = new Date().toISOString().slice(0, 10);
    const summary = await getDailyUsage(c.env, today);

    return json({
      ok: true,
      stats: {
        todayRequests: summary?.requests || 0,
        todaySuccess: summary?.successRequests || 0,
        todayTokens: (summary?.promptTokens || 0) + (summary?.completionTokens || 0),
        todayCostUsd: summary?.totalCostUsd || 0,
        avgLatencyMs: summary?.requests ? Math.round(summary.totalLatencyMs / summary.requests) : 0,
      },
    });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 用量走势图表 */
adminRouter.get("/usage/trend", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    requireRole(user, ["admin", "auditor"]);

    const days = Math.min(Number(c.req.query("days")) || 7, 30);
    const trend = [];
    const now = Date.now();

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 86400 * 1000).toISOString().slice(0, 10);
      const s = await getDailyUsage(c.env, d);
      trend.push({
        date: d,
        requests: s?.requests || 0,
        promptTokens: s?.promptTokens || 0,
        completionTokens: s?.completionTokens || 0,
        costUsd: s?.totalCostUsd || 0,
      });
    }

    return json({ ok: true, trend });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
