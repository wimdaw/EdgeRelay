/**
 * 管理后台统一路由 /api/admin/*
 */
import { Hono } from "hono";
import type { Env, HandlerCtx, PlatformSettings, UserRole } from "../types";
import { ROLE_HIERARCHY } from "../types";
import { requireAdminStepUp, requireUser, requireRole, clientIp } from "../auth";
import { ApiError, ErrorCode, errorResponse } from "../errors";
import { uuid, encryptSecret, decryptSecret, sha256Hex } from "../crypto";
import { getSettings, updateSettings, json } from "../settings";
import { audit, verifyAuditChain } from "../audit";
import { topup } from "../billing";
import {
  listAllUsers,
  getUserById,
  updateUser,
  listAllApiKeys,
  updateApiKey,
  getProviders,
  setProviders,
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
  deleteAuditLog,
  clearAuditLogs,
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
      "list_redeem_codes",
    ]);

    const user = await requireUser(hCtx);
    let admin = user;
    if (action === "list_audit" || action === "flags_queue" || action === "appeals_list") {
      requireRole(user, ["superadmin", "auditor"]);
    } else if (action === "list_pricing") {
      requireRole(user, ["superadmin", "finance", "auditor"]);
    } else if (READ_ACTIONS.has(action)) {
      requireRole(user, ["superadmin", "admin", "auditor"]);
    } else {
      admin = await requireAdminStepUp(hCtx, typeof p.password === "string" ? p.password : undefined);

      // 网站根级管理配置仅限超级管理员 (superadmin)
      const SUPERADMIN_ONLY_ACTIONS = new Set([
        "upsert_provider",
        "delete_provider",
        "upsert_provider_key",
        "delete_provider_key",
        "toggle_provider",
        "upsert_model",
        "delete_model",
        "import_models",
        "set_pricing",
        "set_settings",
        "set_smtp",
        "delete_audit_log",
        "clear_audit_logs",
        "upsert_site_logo",
        "generate_redeem_codes",
        "delete_redeem_code",
        "save_announcements",
      ]);
      if (SUPERADMIN_ONLY_ACTIONS.has(action)) {
        requireRole(admin, ["superadmin"]);
      }
    }

    // 审计元数据脱敏：禁止把管理员密码等敏感字段写入不可篡改的审计链
    const REDACT_KEYS = new Set(["password", "apiKey", "key", "secret", "token"]);
    const auditMeta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) {
      if (REDACT_KEYS.has(k)) {
        auditMeta[k] = "***redacted***";
      } else if (typeof v === "string" && v.length > 200) {
        auditMeta[k] = `${v.slice(0, 200)}…(${v.length} chars)`;
      } else {
        auditMeta[k] = v;
      }
    }

    const done = async (result: unknown, targetType?: string, targetId?: string) => {
      try {
        await audit(hCtx, {
          actorUserId: admin.id,
          actorIp: clientIp(hCtx.req),
          action: `admin.${action}`,
          targetType,
          targetId,
          meta: auditMeta,
        });
      } catch (err: any) {
        // 审计写失败不得影响主业务结果，仅记录日志
        console.error("[audit] append failed:", err?.message);
      }
      return json({ ok: true, result });
    };

    switch (action) {
      /* ---- 用户管理 ---- */
      case "list_users": {
        const users = await listAllUsers(env);
        const { getBalance } = await import("../billing");
        const safe = await Promise.all(
          users.map(async (u) => {
            const bal = await getBalance(env, `user:${u.id}`);
            return {
              id: u.id,
              email: u.email,
              role: u.role,
              status: u.status,
              balance: bal.available ?? 0,
              frozen: bal.frozen ?? 0,
              currency: bal.currency ?? "CNY",
              unlimited: u.role === "superadmin",
              created_at: u.createdAt,
            };
          })
        );
        return json({ ok: true, users: safe });
      }
      case "set_role": {
        const role = String(p.role) as UserRole;
        if (!["user", "vip", "admin", "superadmin", "finance", "auditor"].includes(role)) {
          throw new ApiError(400, ErrorCode.BAD_REQUEST, "非法角色");
        }
        const target = await getUserById(env, String(p.userId));
        if (!target) throw new ApiError(404, ErrorCode.NOT_FOUND, "目标用户不存在");
        if (target.email.toLowerCase() === "hackerxiaow@gmail.com" && role !== "superadmin") {
          throw new ApiError(403, ErrorCode.FORBIDDEN, "创始人超级管理员账号不可被降权");
        }
        // 权限上下继承：只能修改权限等级比自身低的用户
        const actorLvl = ROLE_HIERARCHY[admin.role as UserRole] || 0;
        const targetLvl = ROLE_HIERARCHY[target.role as UserRole] || 0;
        if (actorLvl <= targetLvl && target.id !== admin.id) {
          throw new ApiError(403, ErrorCode.FORBIDDEN, "无权调整同级或更高权限用户的角色");
        }
        // 管理员任命保护：管理员必须由超级管理员在后台添加/任命，不支持直接升级
        if ((role === "admin" || role === "superadmin") && admin.role !== "superadmin") {
          throw new ApiError(403, ErrorCode.FORBIDDEN, "只有超级管理员可在后台任命管理员");
        }

        // VIP 身份由余额自动驱动（只要余额 > 0 自动生效）：余额为 0 时提示直接使用充值功能
        if (role === "vip") {
          const { getOrCreateBalance } = await import("../storage/db");
          const targetBal = await getOrCreateBalance(env, `user:${target.id}`);
          if (targetBal.available <= 0) {
            throw new ApiError(
              400,
              ErrorCode.BAD_REQUEST,
              "VIP 身份由余额自动驱动。若需为该用户开通 VIP，请直接点击该用户的「充值」按钮加款，充值到账后系统将全自动生效 VIP 身份！"
            );
          }
        }

        await updateUser(env, String(p.userId), { role });
        return done(null, "user", String(p.userId));
      }
      case "ban_user": {
        const target = await getUserById(env, String(p.userId));
        if (!target) throw new ApiError(404, ErrorCode.NOT_FOUND, "用户不存在");
        const actorLvl = ROLE_HIERARCHY[admin.role as UserRole] || 0;
        const targetLvl = ROLE_HIERARCHY[target.role as UserRole] || 0;
        if (actorLvl <= targetLvl) {
          throw new ApiError(403, ErrorCode.FORBIDDEN, "无权封禁同级或更高权限的用户");
        }
        await updateUser(env, String(p.userId), { status: "banned" });
        return done(null, "user", String(p.userId));
      }
      case "unban_user": {
        const target = await getUserById(env, String(p.userId));
        if (!target) throw new ApiError(404, ErrorCode.NOT_FOUND, "用户不存在");
        const actorLvl = ROLE_HIERARCHY[admin.role as UserRole] || 0;
        const targetLvl = ROLE_HIERARCHY[target.role as UserRole] || 0;
        if (actorLvl <= targetLvl) {
          throw new ApiError(403, ErrorCode.FORBIDDEN, "无权解封同级或更高权限的用户");
        }
        await updateUser(env, String(p.userId), { status: "active" });
        return done(null, "user", String(p.userId));
      }
      case "delete_user": {
        const target = await getUserById(env, String(p.userId));
        if (!target) throw new ApiError(404, ErrorCode.NOT_FOUND, "用户不存在");
        const actorLvl = ROLE_HIERARCHY[admin.role as UserRole] || 0;
        const targetLvl = ROLE_HIERARCHY[target.role as UserRole] || 0;
        if (actorLvl <= targetLvl) {
          throw new ApiError(403, ErrorCode.FORBIDDEN, "无权删除同级或更高权限的用户");
        }
        const { deleteUser } = await import("../storage/db");
        await deleteUser(env, target.id);
        return done(null, "user", target.id);
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

        const kind = String(p.kind ?? (p.slug === "anthropic" ? "anthropic" : "openai_compat"));
        const isAnthropic = kind === "anthropic" || p.slug === "anthropic";
        const authScheme = String(p.authScheme ?? (isAnthropic ? "x-api-key" : isKeyless ? "none" : "bearer"));
        const extraHeaders = p.extraHeaders
          ? JSON.stringify(p.extraHeaders)
          : isAnthropic
          ? JSON.stringify({ "anthropic-version": "2023-06-01", "content-type": "application/json" })
          : null;

        await upsertProvider(env, {
          id,
          name: String(p.name),
          slug: String(p.slug),
          kind,
          baseUrl: String(p.baseUrl),
          authScheme,
          extraHeaders,
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
      case "toggle_provider": {
        if (!p.id || !p.status) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少渠道 id 或状态");
        const providers = await getProviders(env);
        const target = providers.find((pr) => pr.id === String(p.id));
        if (!target) throw new ApiError(404, ErrorCode.NOT_FOUND, "渠道不存在");
        target.status = p.status as "active" | "disabled";
        await setProviders(env, providers);
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
            rpm_limit: prc?.rpmLimit ?? null,
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

        // 若携带定价或限流数据，或该模型尚未配置定价，自动维护定价表
        const pricing = await getAllPricing(env);
        const existingPricing = pricing[publicName] || (p.oldPublicName ? pricing[String(p.oldPublicName)] : undefined);
        const inputPerMillion = p.inputPerMillion !== undefined ? Number(p.inputPerMillion) : (existingPricing?.inputPerMillion ?? 0);
        const outputPerMillion = p.outputPerMillion !== undefined ? Number(p.outputPerMillion) : (existingPricing?.outputPerMillion ?? 0);
        const rpmLimit = p.rpmLimit !== undefined
          ? (p.rpmLimit === null || p.rpmLimit === "" ? null : Number(p.rpmLimit))
          : (existingPricing?.rpmLimit ?? null);
        const prId = existingPricing?.id || `pr_${uuid().slice(0, 8)}`;
        await setPricing(env, {
          id: prId,
          publicName,
          inputPerMillion,
          outputPerMillion,
          currency: String(p.currency ?? existingPricing?.currency ?? "CNY"),
          rpmLimit,
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
          rpm_limit: pr.rpmLimit ?? null,
        }));
        return json({ ok: true, pricing: rows });
      }
      case "set_pricing": {
        const publicName = String(p.publicName);
        const id = (p.id as string) || uuid();
        const pricing = await getAllPricing(env);
        const existing = pricing[publicName];
        const rpmLimit = p.rpmLimit !== undefined
          ? (p.rpmLimit === null || p.rpmLimit === "" ? null : Number(p.rpmLimit))
          : (existing?.rpmLimit ?? null);
        await setPricing(env, {
          id,
          publicName,
          inputPerMillion: Number(p.inputPerMillion),
          outputPerMillion: Number(p.outputPerMillion),
          currency: String(p.currency ?? "CNY"),
          rpmLimit,
          createdAt: existing?.createdAt ?? now,
        });
        return done({ id, publicName }, "pricing", id);
      }

      /* ---- 计费充值 ---- */
      case "topup": {
        const scope = String(p.scope);
        const amount = Number(p.amount);
        if (!Number.isFinite(amount) || amount === 0) throw new ApiError(400, ErrorCode.BAD_REQUEST, "金额不合法");

        let targetUser = null;
        if (scope.startsWith("user:")) {
          const targetUserId = scope.slice(5);
          targetUser = await getUserById(env, targetUserId);
          if (!targetUser) throw new ApiError(404, ErrorCode.NOT_FOUND, "目标用户不存在");

          // 权限上下继承：只能给权限比自己低的用户充值
          const actorLvl = ROLE_HIERARCHY[admin.role as UserRole] || 0;
          const targetLvl = ROLE_HIERARCHY[targetUser.role as UserRole] || 0;
          if (actorLvl <= targetLvl && targetUser.id !== admin.id) {
            throw new ApiError(403, ErrorCode.FORBIDDEN, "只能给比自身权限等级低的用户充值加款");
          }
        }

        // 资金流转：
        //  · 普通管理员：实打实从自身余额转出（余额为 0 或不足直接拒绝）
        //  · 超级管理员：作为铸币方，不扣自身余额，仅在 system:mint 账本留下发款流水用于对账
        if (amount > 0 && admin.id) {
          const { getOrCreateBalance } = await import("../storage/db");
          if (admin.role === "superadmin") {
            await topup(hCtx, "system:mint", -amount, `超级管理员 [${admin.email}] 向 [${targetUser?.email || scope}] 铸币发款`);
          } else {
            const actorBal = await getOrCreateBalance(env, `user:${admin.id}`);
            if (actorBal.available <= 0) {
              throw new ApiError(
                402,
                ErrorCode.INSUFFICIENT_BALANCE,
                `您的管理员账户当前可用余额为 ¥0.00，无法向下级用户转账加款。请联系超级管理员为您的账户注资！`
              );
            }
            if (actorBal.available < amount) {
              throw new ApiError(
                402,
                ErrorCode.INSUFFICIENT_BALANCE,
                `您的管理员账户可用余额不足 (当前 ¥${actorBal.available.toFixed(2)})，无法为下级用户充值 ¥${amount.toFixed(2)}`
              );
            }
            await topup(hCtx, `user:${admin.id}`, -amount, `给下级用户 [${targetUser?.email || scope}] 充值转账扣减`);
          }
        }

        // 记账加款到目标用户
        const memo = (p.memo as string) || `由管理员 [${admin.email}] 充值加款到账`;
        await topup(hCtx, scope, amount, memo);

        // 动态 VIP 规则：普通用户只要余额 > 0 自动晋升为 VIP，归 0 降级为 user
        if (targetUser) {
          const { syncUserVipStatus } = await import("../storage/db");
          await syncUserVipStatus(env, targetUser.id);
        }

        return done(null, "balance", scope);
      }

      /* ---- 卡密兑换与管理 ---- */
      case "list_redeem_codes": {
        const { getRedeemCodes } = await import("../storage/db");
        const codes = await getRedeemCodes(env);
        return json({ ok: true, codes });
      }
      case "generate_redeem_codes": {
        const count = Math.min(Math.max(1, Number(p.count) || 1), 100);
        const amount = Number(p.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new ApiError(400, ErrorCode.BAD_REQUEST, "卡密面额必须大于 0");
        }
        const autoVip = p.autoVip !== false;
        const note = (p.note as string) || null;
        const { getRedeemCodes, saveRedeemCodes } = await import("../storage/db");
        const list = await getRedeemCodes(env);
        const newCodes: any[] = [];

        function randomCardCode(): string {
          const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
          const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
          return `CARD-${seg()}-${seg()}-${seg()}`;
        }

        for (let i = 0; i < count; i++) {
          const id = uuid();
          const code = randomCardCode();
          newCodes.push({
            id,
            code,
            amount,
            currency: "CNY",
            autoVip,
            status: "unused",
            createdAt: now,
            createdById: admin.id,
            note,
          });
        }

        const updated = [...newCodes, ...list];
        await saveRedeemCodes(env, updated);
        return done({ codes: newCodes, count: newCodes.length }, "redeem_codes", "batch");
      }
      case "delete_redeem_code": {
        if (!p.codeId) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少卡密 id");
        const { deleteRedeemCode } = await import("../storage/db");
        await deleteRedeemCode(env, String(p.codeId));
        return done(null, "redeem_code", String(p.codeId));
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
      case "delete_audit_log": {
        if (!p.id) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少审计日志 id");
        const remaining = await deleteAuditLog(env, String(p.id));
        return done({ remaining }, "audit_log", String(p.id));
      }
      case "clear_audit_logs": {
        await clearAuditLogs(env);
        return done(null, "audit_logs", "all");
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
  } catch (err: any) {
    // 运维排障：superadmin 主动携带 x-relay-debug: 1 时回传真实错误信息（默认不回传，避免泄露内部细节）
    if (c.req.header("x-relay-debug") === "1") {
      try {
        const u = await requireUser(hCtx);
        if (u.role === "superadmin") {
          console.error("[admin/actions] debug failure:", err?.stack || err);
          return json(
            {
              error: {
                message: String(err?.message || err),
                type: ErrorCode.INTERNAL,
                code: ErrorCode.INTERNAL,
                details: { stack: String(err?.stack || "").split("\n").slice(0, 6).join("\n") },
              },
            },
            500
          );
        }
      } catch {}
    }
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
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
    const status = (c.req.query("status") || "").trim();
    const model = (c.req.query("model") || "").trim();
    const userId = (c.req.query("userId") || "").trim();

    let records: any[] = [];
    const recent = await store.get("usage:recent", { type: "json", consistency: "strong" });
    if (Array.isArray(recent) && recent.length > 0) {
      records = recent;
    } else {
      // 兼容历史数据：旧版本没有最近索引，扫描记录 key 并按写入时间倒序
      const res = await store.list({ prefix: "usage:record:", paginate: false, consistency: "strong" });
      const loaded = await Promise.all(
        (res.blobs || []).map((b) => store.get(b.key, { type: "json", consistency: "strong" }).catch(() => null))
      );
      records = loaded.filter(Boolean).sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0));
    }

    const matched = records.filter((r: any) =>
      (!status || r.status === status) &&
      (!model || String(r.publicModel || "").includes(model)) &&
      (!userId || r.userId === userId)
    );

    const logs = matched.slice(0, limit).map((r: any) => ({
      id: r.id,
      request_id: r.requestId,
      user_id: r.userId,
      api_key_id: r.apiKeyId ?? null,
      provider_id: r.providerId ?? null,
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
    }));
    return json({ logs, total: matched.length });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
