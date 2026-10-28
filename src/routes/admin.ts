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
  deleteProvider,
  getProviderKeys,
  upsertProviderKey,
  deleteProviderKey,
  updateProviderKeyStatus,
  getModels,
  upsertModel,
  deleteModel,
  getAllPricing,
  setPricing,
  getAuditLogs,
  getContentFlags,
  getAppeals,
  getDailyUsage,
  getAnnouncements,
  saveAnnouncements,
  getBlobStore,
} from "../storage/db";
import { readKeyHealth } from "../key-health";

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
      "list_upstream_models",
    ]);

    const user = await requireUser(hCtx);
    let admin = user;
    if (READ_ACTIONS.has(action)) {
      requireRole(user, ["admin", "auditor"]);
    } else {
      admin = await requireAdminStepUp(hCtx, typeof p.password === "string" ? p.password : undefined);
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
          const health = await readKeyHealth(env, pr.id);
          out.push({
            id: pr.id,
            name: pr.name,
            slug: pr.slug,
            kind: pr.kind || (pr.slug === "anthropic" ? "anthropic" : "openai_compat"),
            auth_scheme: pr.authScheme || (pr.slug === "anthropic" ? "x-api-key" : "bearer"),
            base_url: pr.baseUrl,
            status: pr.status,
            authorization_ref: pr.authorizationRef ?? null,
            authorization_expires_at: pr.authorizationExpiresAt ?? null,
            key_count: keys.length,
            extraHeaders: pr.extraHeaders ? JSON.parse(pr.extraHeaders) : {},
            keys: keys.map((k) => {
              const h = health[k.id] || health[k.keyFingerprint];
              return {
                id: k.id,
                label: k.label,
                fingerprint: k.keyFingerprint,
                status: k.status,
                health_status: h?.demotedAt ? "demoted" : (h?.failures ? "unhealthy" : "healthy"),
                failures: h?.failures || 0,
                demoted_at: h?.demotedAt || null,
                created_at: k.createdAt,
              };
            }),
          });
        }
        return json({ ok: true, providers: out });
      }
      case "upsert_provider": {
        const isNew = !p.id;
        const isKeyless = p.slug === "opencode" || p.slug === "duckai" || p.slug === "kilo" || p.kind === "opencode" || p.kind === "duckai" || p.kind === "kilo" || p.authScheme === "none";
        if (isNew && !p.key && !isKeyless) throw new ApiError(400, ErrorCode.BAD_REQUEST, "添加供应商必须同时录入上游密钥");
        const id = (p.id as string) || uuid();

        await upsertProvider(env, {
          id,
          name: String(p.name),
          slug: String(p.slug),
          kind: String(p.kind ?? (isKeyless ? p.slug : "openai_compat")),
          baseUrl: String(p.baseUrl),
          authScheme: String(p.authScheme ?? (isKeyless ? "none" : "bearer")),
          extraHeaders: p.extraHeaders ? JSON.stringify(p.extraHeaders) : null,
          status: (p.status as "active" | "disabled") ?? "active",
          authorizationRef: (p.authorizationRef as string) ?? null,
          authorizationExpiresAt: (p.authorizationExpiresAt as number) ?? null,
          createdAt: now,
        });

        if (p.key) {
          const rawKeys = String(p.key).split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
          for (let i = 0; i < rawKeys.length; i++) {
            const plaintext = rawKeys[i];
            const encryptedKey = await encryptSecret(env, plaintext);
            const keyFingerprint = (await sha256Hex(plaintext)).slice(0, 16);
            await upsertProviderKey(env, {
              id: uuid(),
              providerId: id,
              label: rawKeys.length > 1 ? `key-${i + 1}` : "default",
              encryptedKey,
              keyFingerprint,
              status: "active",
              createdAt: now,
            });
          }
        }
        return done({ id }, "provider", id);
      }
      case "delete_provider": {
        if (!p.id) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少渠道 id");
        await deleteProvider(env, String(p.id));
        return done(null, "provider", String(p.id));
      }
      case "delete_provider_key": {
        if (!p.providerId || !p.keyId) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 providerId 或 keyId");
        await deleteProviderKey(env, String(p.providerId), String(p.keyId));
        return done(null, "provider_key", String(p.keyId));
      }
      case "toggle_provider_key": {
        if (!p.providerId || !p.keyId || !p.status) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少参数");
        await updateProviderKeyStatus(env, String(p.providerId), String(p.keyId), p.status as "active" | "disabled");
        return done(null, "provider_key", String(p.keyId));
      }
      case "upsert_provider_key": {
        if (!p.providerId || (!p.key && !p.keys)) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 providerId 或 key");
        const rawKeys = Array.isArray(p.keys)
          ? p.keys.map(String)
          : String(p.key).split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
        if (!rawKeys.length) throw new ApiError(400, ErrorCode.BAD_REQUEST, "请提供有效的 API Key");

        const added: { id: string; fingerprint: string }[] = [];
        for (let i = 0; i < rawKeys.length; i++) {
          const plaintext = rawKeys[i];
          const encryptedKey = await encryptSecret(env, plaintext);
          const keyFingerprint = (await sha256Hex(plaintext)).slice(0, 16);
          const id = rawKeys.length === 1 && p.id ? String(p.id) : uuid();
          const label = rawKeys.length > 1 && !p.label ? `key-${i + 1}` : String(p.label ?? "prod");
          await upsertProviderKey(env, {
            id,
            providerId: String(p.providerId),
            label,
            encryptedKey,
            keyFingerprint,
            status: (p.status as "active" | "disabled") ?? "active",
            createdAt: now,
          });
          added.push({ id, fingerprint: keyFingerprint });
        }
        return done({ added, count: added.length, fingerprint: added[0]?.fingerprint }, "provider_key", String(p.providerId));
      }

      /* ---- 模型管理 ---- */
      case "list_upstream_models": {
        const providerId = String(p.providerId || "");
        const providers = await getProviders(env);
        const prov = providers.find((x) => x.id === providerId || x.slug === providerId);
        const slug = prov?.slug || prov?.kind || providerId;
        if (slug === "opencode") {
          // 对齐 ai-gateway-edgeone 原理：请求 OpenCode /models 端点并通过 filterOpenCodeModels 严格筛选免费层模型
          // 免费模型特征：以 -free 结尾，或特定白名单（如 big-pickle）
          try {
            const { fetchOpenCodeModels, resolveOpenCodeUrls, resolveOpenCodeRelay } = await import("../opencode");
            const mirrors = resolveOpenCodeUrls(env);
            const relay = resolveOpenCodeRelay(env);
            const res = await fetchOpenCodeModels(prov?.baseUrl || "https://opencode.ai/zen/v1", [], mirrors, undefined, relay);
            if (res.success && res.data?.data && Array.isArray(res.data.data)) {
              const freeList = res.data.data
                .map((m: any) => m.id)
                .filter((id: string) => typeof id === "string" && (id === "big-pickle" || id.endsWith("-free")));
              if (freeList.length) return json({ ok: true, models: freeList });
            }
          } catch {}
          return json({
            ok: true,
            models: [
              "deepseek-v4.1-flash-free",
              "big-pickle",
              "beam-free",
              "flint-40b-free",
              "mimo-v2.6-flash-free",
              "nemotron-3.5-super-vl-free",
              "nemotron-3.5-lightning-free",
              "jev-1.13-free",
              "glm-5.3-flash-free",
            ],
          });
        }
        if (slug === "duckai") {
          return json({
            ok: true,
            models: [
              "gpt-6-luna",
              "gpt-5.4-mini",
              "claude-haiku-4-5",
              "mistral-small-2603",
              "tinfoil/gpt-oss-120b",
              "tinfoil/gemma4-31b",
            ],
          });
        }
        if (slug === "kilo") {
          try {
            const res = await fetch("https://api.kilo.ai/api/gateway/models", {
              headers: { "user-agent": "Relay/1.0" },
              signal: AbortSignal.timeout(10000),
            });
            if (res.ok) {
              const d = (await res.json()) as { data?: { id?: string }[] };
              const freeList = (d.data ?? [])
                .map((m) => m.id)
                .filter((id): id is string => typeof id === "string" && (id.includes(":free") || id === "kilo-auto/free" || id === "openrouter/free"));
              if (freeList.length) return json({ ok: true, models: freeList });
            }
          } catch {}
          return json({
            ok: true,
            models: [
              "kilo-auto/free",
              "openrouter/free",
              "nvidia/nemotron-3.5-super-vl:free",
              "nvidia/nemotron-3.5-lightning:free",
              "reflection/beam-free",
              "xingchen-agi/xing4.0-29b-a4b:free",
              "dots-studio/dots-3-note-preview:free",
              "liquid/lfm-2.5-2.6b:free",
              "cohere/north-mini-code:free",
              "nvidia/nemotron-3-ultra-550b-a55b:free",
              "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
            ],
          });
        }
        if (slug === "anthropic") {
          try {
            const keys = await getProviderKeys(env, prov?.id || "anthropic");
            const activeKey = keys.find((k) => k.status === "active");
            if (activeKey) {
              const plainKey = await decryptSecret(env, activeKey.encryptedKey);
              const res = await fetch("https://api.anthropic.com/v1/models", {
                headers: {
                  "x-api-key": plainKey,
                  "anthropic-version": "2023-06-01",
                },
                signal: AbortSignal.timeout(10000),
              });
              if (res.ok) {
                const d = (await res.json()) as { data?: { id?: string }[] };
                const mList = (d.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
                if (mList.length) return json({ ok: true, models: mList });
              }
            }
          } catch {}
          return json({
            ok: true,
            models: [
              "claude-3-5-sonnet-20241022",
              "claude-3-5-haiku-20241022",
              "claude-3-opus-20240229",
              "claude-3-sonnet-20240229",
              "claude-3-haiku-20240307",
            ],
          });
        }
        if (prov?.baseUrl) {
          const keys = await getProviderKeys(env, prov.id);
          const activeKey = keys.find((k) => k.status === "active");
          if (activeKey) {
            try {
              const plainKey = await decryptSecret(env, activeKey.encryptedKey);
              const mRes = await fetch(`${prov.baseUrl.replace(/\/+$/, "")}/v1/models`, {
                headers: { authorization: `Bearer ${plainKey}` },
                signal: AbortSignal.timeout(15000),
              });
              if (mRes.ok) {
                const data = (await mRes.json()) as { data?: { id?: string }[] };
                const mList = (data.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
                if (mList.length) return json({ ok: true, models: mList });
              }
            } catch {}
          }
        }
        return json({ ok: true, models: [] });
      }

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
            provider_id: m.providerId,
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
        const publicName = String(p.publicName);
        await upsertModel(env, {
          id,
          publicName,
          providerId: String(p.providerId),
          upstreamModel: String(p.upstreamModel),
          priority: Number(p.priority ?? 10),
          costWeight: Number(p.costWeight ?? 1),
          maxContext: (p.maxContext as number) ?? null,
          enabled: p.enabled === false ? 0 : 1,
          createdAt: now,
        });

        // 若携带定价数据或该模型尚未配置定价，自动维护定价表
        const pricing = await getAllPricing(env);
        const existingPricing = pricing[publicName] || (p.oldPublicName ? pricing[String(p.oldPublicName)] : undefined);
        const inputPerMillion = p.inputPerMillion !== undefined ? Number(p.inputPerMillion) : (existingPricing?.inputPerMillion ?? 0);
        const outputPerMillion = p.outputPerMillion !== undefined ? Number(p.outputPerMillion) : (existingPricing?.outputPerMillion ?? 0);
        const prId = existingPricing?.id || `pr_${uuid().slice(0, 8)}`;
        await setPricing(env, {
          id: prId,
          publicName,
          inputPerMillion,
          outputPerMillion,
          currency: String(p.currency ?? existingPricing?.currency ?? "CNY"),
          createdAt: existingPricing?.createdAt ?? now,
        });
        return done({ id }, "model", id);
      }
      case "import_models": {
        const providerId = String(p.providerId || "");
        const rawModels = Array.isArray(p.models)
          ? p.models.map(String)
          : typeof p.models === "string"
          ? p.models.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean)
          : [];
        if (!providerId || !rawModels.length) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 providerId 或 models 列表");
        const priority = Number(p.priority ?? 10);
        const costWeight = Number(p.costWeight ?? 1);
        const existingModels = await getModels(env);
        let imported = 0;
        for (const mName of rawModels) {
          const trimmed = mName.trim();
          if (!trimmed) continue;
          const existing = existingModels.find((em) => em.providerId === providerId && em.upstreamModel === trimmed);
          if (!existing) {
            const id = `m_${uuid().slice(0, 8)}`;
            await upsertModel(env, {
              id,
              publicName: trimmed,
              providerId,
              upstreamModel: trimmed,
              priority,
              costWeight,
              maxContext: null,
              enabled: 1,
              createdAt: now,
            });
            const pricing = await getAllPricing(env);
            if (!pricing[trimmed]) {
              await setPricing(env, {
                id: `pr_${uuid().slice(0, 8)}`,
                publicName: trimmed,
                inputPerMillion: 0,
                outputPerMillion: 0,
                currency: "CNY",
                createdAt: now,
              });
            }
            imported++;
          }
        }
        return done({ imported, total: rawModels.length }, "models", providerId);
      }
      case "delete_model": {
        if (!p.id) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少模型 id");
        await deleteModel(env, String(p.id));
        return done(null, "model", String(p.id));
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
      case "get_smtp": {
        const s = await getSettings(env);
        return json({
          ok: true,
          smtp: {
            enabled: !!s.smtpEnabled,
            host: s.smtpHost ?? "",
            port: s.smtpPort ?? 465,
            username: s.smtpUsername ?? "",
            from: s.smtpFrom ?? "",
            hasPassword: !!s.smtpPassEnc,
          },
        });
      }
      case "set_smtp": {
        const patch: Partial<PlatformSettings> = {
          smtpEnabled: !!p.enabled,
          smtpHost: String(p.host ?? ""),
          smtpPort: Number(p.port) || 465,
          smtpUsername: String(p.username ?? ""),
          smtpFrom: String(p.from ?? ""),
        };
        if (p.password) {
          patch.smtpPassEnc = await encryptSecret(env, String(p.password));
        }
        await updateSettings(env, patch);
        return done(null, "settings", "smtp");
      }
      case "get_oauth": {
        const s = await getSettings(env);
        return json({
          ok: true,
          oauth: {
            github: {
              enabled: !!s.oauthGithubEnabled,
              clientId: s.oauthGithubClientId ?? "",
              hasSecret: !!s.oauthGithubSecretEnc,
            },
            google: {
              enabled: !!s.oauthGoogleEnabled,
              clientId: s.oauthGoogleClientId ?? "",
              hasSecret: !!s.oauthGoogleSecretEnc,
            },
          },
        });
      }
      case "set_oauth": {
        const patch: Partial<PlatformSettings> = {};
        if (p.github) {
          const gh = p.github as any;
          patch.oauthGithubEnabled = !!gh.enabled;
          patch.oauthGithubClientId = String(gh.clientId ?? "");
          if (gh.clientSecret) patch.oauthGithubSecretEnc = await encryptSecret(env, String(gh.clientSecret));
        }
        if (p.google) {
          const gg = p.google as any;
          patch.oauthGoogleEnabled = !!gg.enabled;
          patch.oauthGoogleClientId = String(gg.clientId ?? "");
          if (gg.clientSecret) patch.oauthGoogleSecretEnc = await encryptSecret(env, String(gg.clientSecret));
        }
        await updateSettings(env, patch);
        return done(null, "settings", "oauth");
      }

      /* ---- 公告管理 ---- */
      case "list_announcements": {
        const list = await getAnnouncements(env);
        return json({ ok: true, announcements: list });
      }
      case "create_announcement": {
        const list = await getAnnouncements(env);
        const aid = uuid();
        const item = {
          id: aid,
          title: String(p.title ?? ""),
          content: String(p.content ?? ""),
          popup: p.popup ? 1 : 0,
          enabled: p.enabled === false ? 0 : 1,
          created_at: now,
          updated_at: now,
        };
        list.unshift(item);
        await saveAnnouncements(env, list);
        return done({ id: aid }, "announcement", aid);
      }
      case "update_announcement": {
        const list = await getAnnouncements(env);
        const idx = list.findIndex((a) => a.id === String(p.id));
        if (idx >= 0) {
          list[idx] = {
            ...list[idx],
            title: String(p.title ?? list[idx].title),
            content: String(p.content ?? list[idx].content),
            popup: p.popup !== undefined ? (p.popup ? 1 : 0) : list[idx].popup,
            enabled: p.enabled !== undefined ? (p.enabled ? 1 : 0) : list[idx].enabled,
            updated_at: now,
          };
          await saveAnnouncements(env, list);
        }
        return done(null, "announcement", String(p.id));
      }
      case "delete_announcement": {
        const list = await getAnnouncements(env);
        const filtered = list.filter((a) => a.id !== String(p.id));
        await saveAnnouncements(env, filtered);
        return done(null, "announcement", String(p.id));
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

    const store = getBlobStore(c.env);
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
