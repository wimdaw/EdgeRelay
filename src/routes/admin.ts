/**
 * 管理后台统一路由 /api/admin/*
 */
import { Hono } from "hono";
import type { Env, HandlerCtx, PlatformSettings, ProviderRecord, UserRole } from "../types";
import { ROLE_HIERARCHY } from "../types";
import { requireAdminStepUp, requireUser, requireRole, clientIp } from "../auth";
import { ApiError, ErrorCode, errorResponse } from "../errors";
import { uuid, encryptSecret, decryptSecret, sha256Hex } from "../crypto";
import { getSettings, updateSettings, json } from "../settings";
import { audit, verifyAuditChain } from "../audit";
import { topup } from "../billing";
import { joinApiPath, normalizeUpstreamModel } from "../providers";
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
  getProviderKeysAll,
  bulkUpsertProviderKeys,
  deleteProviderKey,
  updateProviderKeyStatus,
  getModels,
  upsertModel,
  deleteModel,
  deletePricing,
  getAllPricing,
  setPricing,
  getAuditLogs,
  deleteAuditLog,
  clearAuditLogs,
  getContentFlags,
  getAppeals,
  getDailyUsage,
  getRecentUsageRecords,
  getAnnouncements,
  saveAnnouncements,
  getBlobStore,
  getProviderSubmissions,
  upsertProviderSubmission,
  appendProviderSubmissionMessage,
  getProviderSubmissionThread,
} from "../storage/db";
import { readKeyHealth } from "../key-health";
import { mapLimit } from "../storage/cache";

export const adminRouter = new Hono<{ Bindings: Env }>();

/**
 * 渠道 Key 写入串行化队列（按 providerId 分桶）
 *
 * 双击「保存凭据」会在极短时间内打两个 upsert_provider_key；前端禁用按钮存在
 * 同一事件循环内的空窗，必须由服务端兜底。串行化后，后一个请求一定能读到前一个
 * 刚写入的 Key，再配合指纹去重即可避免重复入库。
 */
const providerKeyWriteTails = new Map<string, Promise<void>>();

async function withProviderKeyWriteLock<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
  const prev = providerKeyWriteTails.get(providerId) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.catch(() => {}).then(() => current);
  providerKeyWriteTails.set(providerId, tail);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (providerKeyWriteTails.get(providerId) === tail) providerKeyWriteTails.delete(providerId);
  }
}

/** 与落库字段一致的 Key 指纹（sha256 前 16 位十六进制） */
async function fingerprintProviderKeys(rawKeys: string[]): Promise<string[]> {
  return mapLimit(rawKeys, 8, async (plaintext) => (await sha256Hex(plaintext)).slice(0, 16));
}

/**
 * 保存凭据的共享实现（upsert_provider_key 与 oauth_add_account 复用）：
 * 写锁内按既有指纹去重，OAuth 渠道按账号身份覆盖旧凭据（同号重新授权不重复入库）。
 * precomputed 传入预加密凭据（单 key 场景）：调用方先把「可能失败的加密」做完再写库，
 * 保证添加失败时一个字节都没落库。
 */
async function addProviderKeys(
  env: Env,
  providerId: string,
  opts: {
    rawKeys: string[];
    email?: string;
    identity?: string;
    label?: string;
    keyId?: string;
    status?: "active" | "disabled";
    now: number;
    precomputed?: { encryptedKey: string; fingerprint: string };
  }
): Promise<{ added: { id: string; fingerprint: string }[]; skipped: string[]; replaced?: number }> {
  const { rawKeys, email, identity, label, keyId, status, now, precomputed } = opts;
  return withProviderKeyWriteLock(providerId, async () => {
    // 以库内既有指纹为准做幂等：重复点击、刷新重提、同批粘贴重复都不会新增记录
    const existing = await getProviderKeysAll(env, providerId);
    const known = new Set(existing.map((k) => k.keyFingerprint).filter(Boolean));
    const fingerprints = precomputed && rawKeys.length === 1 ? [precomputed.fingerprint] : await fingerprintProviderKeys(rawKeys);

    // 同一账号重新授权：凭据内容变了（如新增 access_token），指纹也会变。
    // 先按账号身份找到旧记录并原地覆盖，避免出现两个“同号”账号。
    if (identity && rawKeys.length === 1) {
      const providers = await getProviders(env);
      const prov = providers.find((x) => x.id === providerId);
      // 各 OAuth 渠道的账号身份提取方式不同：凭据内容变了（指纹随之变化）时，
      // 必须按账号 uid 找到旧记录原地覆盖，否则会出现两个“同号”账号。
      let extractUid: ((raw: string) => string) | null = null;
      if (prov?.kind === "oauth:zcode") {
        const { parseZcodeCredential, userIdFromJwt } = await import("../oauth/zcode");
        extractUid = (raw) => userIdFromJwt(parseZcodeCredential(raw).jwt);
      } else if (prov?.kind === "oauth:qoder") {
        const { parseQoderCredential } = await import("../oauth/qoder");
        extractUid = (raw) => parseQoderCredential(raw)?.uid || "";
      } else if (prov?.kind === "oauth:trae") {
        const { parseTraeCredential } = await import("../oauth/trae");
        extractUid = (raw) => parseTraeCredential(raw, prov?.baseUrl)?.uid || "";
      }
      if (extractUid) {
        for (const k of existing) {
          try {
            const rawOld = await decryptSecret(env, k.encryptedKey);
            if (extractUid(rawOld) === identity) {
              await bulkUpsertProviderKeys(env, providerId, [
                {
                  ...k,
                  encryptedKey: precomputed?.encryptedKey ?? (await encryptSecret(env, rawKeys[0]!)),
                  keyFingerprint: fingerprints[0]!,
                  ...(email ? { email } : {}),
                  status: "active",
                  createdAt: k.createdAt,
                },
              ]);
              return { added: [{ id: k.id, fingerprint: fingerprints[0]! }], skipped: [], replaced: 1 };
            }
          } catch {
            /* 单条解密失败不影响其它记录 */
          }
        }
      }
    }
    const picked: { plaintext: string; index: number; fingerprint: string }[] = [];
    const skipped: string[] = [];
    rawKeys.forEach((plaintext, i) => {
      const fp = fingerprints[i]!;
      if (known.has(fp)) {
        skipped.push(fp);
        return;
      }
      known.add(fp); // 同一次 payload 内的重复也只保留一条
      picked.push({ plaintext, index: i, fingerprint: fp });
    });

    const added: { id: string; fingerprint: string }[] = [];
    const records = await mapLimit(picked, 8, async ({ plaintext, index, fingerprint }) => {
      const encryptedKey = rawKeys.length === 1 && precomputed ? precomputed.encryptedKey : await encryptSecret(env, plaintext);
      const id = rawKeys.length === 1 && keyId ? keyId : uuid();
      const recLabel = rawKeys.length > 1 && !label ? `key-${index + 1}` : String(label ?? "prod");
      added.push({ id, fingerprint });
      return {
        id,
        providerId,
        label: recLabel,
        encryptedKey,
        keyFingerprint: fingerprint,
        ...(email ? { email } : {}),
        status: (status ?? "active") as "active" | "disabled",
        createdAt: now,
      };
    });
    if (records.length) await bulkUpsertProviderKeys(env, providerId, records);
    return { added, skipped };
  });
}

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
      "get_epay",
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
    } else if (action === "oauth_poll") {
      // 授权轮询不要求二次验证，但仅限超级管理员
      requireRole(user, ["superadmin"]);
    } else if (
      action === "account_pool" ||
      action === "checkin_status" ||
      action === "list_provider_submissions" ||
      action === "provider_submission_thread" ||
      action === "provider_submission_review" ||
      action === "provider_submission_reply" ||
      action === "provider_submission_delete" ||
      action === "provider_submission_test" ||
      action === "codebuddy_checkin" ||
      action === "codebuddy_checkin_link" ||
      action === "checkin_config" ||
      action === "zcode_probe" ||
      action === "zcode_set_device" ||
      action === "qoder_probe" ||
      action === "set_checkin"
    ) {
      // 账号池会解密凭据并查询上游额度；签到同样要解密 refresh_token，仅限超级管理员
      requireRole(user, ["superadmin"]);
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
        "delete_pricing",
        "set_settings",
        "set_smtp",
        "delete_audit_log",
        "clear_audit_logs",
        "upsert_site_logo",
        "generate_redeem_codes",
        "delete_redeem_code",
        "save_announcements",
        "oauth_start",
        "oauth_complete",
        "oauth_add_account",
        "oauth_test",
      ]);
      if (SUPERADMIN_ONLY_ACTIONS.has(action)) {
        requireRole(admin, ["superadmin"]);
      }
    }

    // 审计元数据脱敏：禁止把管理员密码等敏感字段写入不可篡改的审计链
    const REDACT_KEYS = new Set(["password", "apiKey", "key", "keys", "secret", "token", "code"]);
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
        // 有界并发读取钱包，避免一次性打爆 Blob
        const safe = await mapLimit(users, 8, async (u) => {
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
        });
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
        // 万级 Key 池（如 agnes 1w+）全量返回会把后台响应推到 2MB / 15s，
        // 这里只回传前 500 条用于展示与健康标记，完整数量走 key_count。
        const KEY_LIST_CAP = 500;
        const details = await Promise.all(
          providers.map(async (pr) => {
            const [keys, health] = await Promise.all([getProviderKeysAll(env, pr.id), readKeyHealth(env, pr.id)]);
            return { pr, keys, health };
          })
        );
        const out = details.map(({ pr, keys, health }) => ({
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
          keys_truncated: keys.length > KEY_LIST_CAP,
          extraHeaders: pr.extraHeaders ? JSON.parse(pr.extraHeaders) : {},
          keys: keys.slice(0, KEY_LIST_CAP).map((k) => {
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
        }));
        return json({ ok: true, providers: out });
      }
      case "upsert_provider": {
        const isNew = !p.id;
        const kind = String(p.kind ?? (p.slug === "anthropic" ? "anthropic" : "openai_compat"));
        const isOAuth = kind.startsWith("oauth:");
        // Web 反代渠道允许零凭据创建（如 geminiweb 的匿名模式），凭据可以之后再补
        // OAuth 渠道同样先建渠道、授权成功后再通过 upsert_provider_key 存入 refresh_token
        const isWebKind = kind.startsWith("web:");
        const isKeyless = isOAuth || isWebKind || p.slug === "opencode" || p.slug === "duckai" || p.slug === "kilo" || p.kind === "opencode" || p.kind === "duckai" || p.kind === "kilo" || p.authScheme === "none";
        if (isNew && !p.key && !isKeyless) throw new ApiError(400, ErrorCode.BAD_REQUEST, "添加供应商必须同时录入上游密钥");
        const id = (p.id as string) || uuid();

        const isAnthropic = kind === "anthropic" || p.slug === "anthropic";
        // Web 渠道的 authScheme 不参与上游鉴权（凭据由各渠道自行拼 header），保持 bearer 以免
        // 被当成「免 Key 渠道」而忽略已配置的凭据
        const authScheme = String(p.authScheme ?? (isOAuth ? "oauth" : isAnthropic ? "x-api-key" : isKeyless && !isWebKind ? "none" : "bearer"));
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
          await withProviderKeyWriteLock(id, async () => {
            // 新建渠道时同样按指纹去重：防止「添加渠道」按钮连点或同批粘贴重复
            const existing = await getProviderKeysAll(env, id);
            const known = new Set(existing.map((k) => k.keyFingerprint).filter(Boolean));
            const fingerprints = await fingerprintProviderKeys(rawKeys);
            const picked: { plaintext: string; index: number; fingerprint: string }[] = [];
            rawKeys.forEach((plaintext, i) => {
              const fp = fingerprints[i]!;
              if (known.has(fp)) return;
              known.add(fp);
              picked.push({ plaintext, index: i, fingerprint: fp });
            });
            // 批量加密 + 一次读写落库（万级 Key 导入从 N 轮往返降为 1 轮）
            const records = await mapLimit(picked, 8, async ({ plaintext, index, fingerprint }) => {
              const encryptedKey = await encryptSecret(env, plaintext);
              return {
                id: uuid(),
                providerId: id,
                label: rawKeys.length > 1 ? `key-${index + 1}` : "default",
                encryptedKey,
                keyFingerprint: fingerprint,
                status: "active" as const,
                createdAt: now,
              };
            });
            if (records.length) await bulkUpsertProviderKeys(env, id, records);
          });
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
        const providerId = String(p.providerId);
        const rawKeys = (Array.isArray(p.keys) ? p.keys.map(String) : String(p.key).split(/[\r\n,]+/))
          .map((s) => s.trim())
          .filter(Boolean);
        if (!rawKeys.length) throw new ApiError(400, ErrorCode.BAD_REQUEST, "请提供有效的 API Key");

        const email = typeof p.email === "string" && p.email.trim() ? p.email.trim() : undefined;
        /** 账号身份（如 oauth 渠道的 uid）：重新授权同一账号时用它覆盖旧凭据，而不是新增一条 */
        const identity = typeof p.identity === "string" ? p.identity.trim() : "";

        const outcome = await addProviderKeys(env, providerId, {
          rawKeys,
          email,
          identity,
          label: p.label === undefined ? undefined : String(p.label),
          keyId: p.id === undefined ? undefined : String(p.id),
          status: p.status === undefined ? undefined : (p.status as "active" | "disabled"),
          now,
        });

        return done(
          {
            added: outcome.added,
            count: outcome.added.length,
            skipped: outcome.skipped.length,
            replaced: (outcome as { replaced?: number }).replaced ?? 0,
            duplicate: outcome.skipped.length > 0,
            fingerprint: outcome.added[0]?.fingerprint ?? outcome.skipped[0],
          },
          "provider_key",
          providerId
        );
      }

      case "oauth_add_account": {
        // OAuth 授权收口：渠道 + 凭据一次性落库。「没添加成功就不要落库」——
        // 指纹/加密等可能失败的步骤全部在写库前完成；写库阶段先建渠道、再存凭据，
        // 凭据保存失败立即回滚刚建的渠道，任何失败路径都不会残留 0 账号的空渠道。
        const type = String(p.provider || "");
        const { isOAuthType, OAUTH_PROVIDERS } = await import("../oauth");
        if (!isOAuthType(type)) throw new ApiError(400, ErrorCode.BAD_REQUEST, `不支持的 OAuth 渠道: ${type}`);
        const refreshToken = String(p.refreshToken ?? p.key ?? "").trim();
        if (!refreshToken) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 refreshToken");

        const meta = OAUTH_PROVIDERS[type];
        const slug = String(p.slug || "").trim() || meta.slug;
        const name = String(p.name || "").trim() || meta.name;
        const baseUrl = String(p.baseUrl || "").trim() || meta.baseUrl;
        const email = typeof p.email === "string" && p.email.trim() ? p.email.trim() : undefined;
        const identity = typeof p.identity === "string" ? p.identity.trim() : "";

        // ① 写库前完成全部可能失败的准备
        const fingerprints = await fingerprintProviderKeys([refreshToken]);
        const encryptedKey = await encryptSecret(env, refreshToken);

        // ② 解析渠道：同 slug 已存在则复用（双域渠道的区域变体 slug 由前端按区域定好传上来）
        const providers = await getProviders(env);
        const found = providers.find((x) => x.slug === slug);
        if (found && found.kind !== `oauth:${type}`) {
          throw new ApiError(400, ErrorCode.BAD_REQUEST, `渠道 slug "${slug}" 已被 ${found.kind} 渠道占用，请换一个 slug`);
        }
        const created: ProviderRecord | null = found
          ? null
          : {
              id: uuid(),
              name,
              slug,
              kind: `oauth:${type}`,
              baseUrl,
              authScheme: "oauth",
              extraHeaders: null,
              status: "active",
              authorizationRef: null,
              authorizationExpiresAt: null,
              createdAt: now,
            };
        const providerId = found?.id ?? created!.id;
        const keyCount = found ? (await getProviderKeysAll(env, providerId)).length : 0;
        const label = `account-${keyCount + 1}`;

        // ③ 写库：凭据保存失败回滚刚建的渠道；复用的渠道不动（里面已有其他账号）
        try {
          if (created) await setProviders(env, [...providers, created]);
          const outcome = await addProviderKeys(env, providerId, {
            rawKeys: [refreshToken],
            email,
            identity,
            label,
            now,
            precomputed: { encryptedKey, fingerprint: fingerprints[0]! },
          });
          return done(
            {
              providerId,
              created: !!created,
              added: outcome.added,
              count: outcome.added.length,
              skipped: outcome.skipped.length,
              replaced: outcome.replaced ?? 0,
              duplicate: outcome.skipped.length > 0,
              fingerprint: outcome.added[0]?.fingerprint ?? outcome.skipped[0],
            },
            "provider",
            providerId
          );
        } catch (err) {
          if (created) await deleteProvider(env, providerId).catch(() => {});
          throw err;
        }
      }

      /* ---- 生成外部监控链接（免凭据，可贴到 cron-job.org / UptimeRobot） ---- */
      case "video_monitor_link": {
        const { signVideoToken } = await import("../video");
        const { VIDEO_MONITOR_SUBJECT } = await import("./monitor");
        // days=0（或不传 never=1）→ 签发永不过期的链接：exp=0，只校验签名
        const rawDays = p.days === undefined || p.days === null || p.days === "" ? 30 : Number(p.days);
        const days = Number.isFinite(rawDays) ? Math.max(0, Math.min(3650, rawDays)) : 30;
        const forever = days === 0;
        const ttl = forever ? 0 : days * 86_400;
        const token = await signVideoToken(env, VIDEO_MONITOR_SUBJECT, ttl);
        const { publicOrigin } = await import("../public-url");
        const origin = publicOrigin({ req: { header: (n: string) => hCtx.req.header(n) } }, env);
        return json({
          ok: true,
          result: {
            url: `${origin}/api/monitor/video?token=${encodeURIComponent(token)}`,
            never_expires: forever,
            expires_at: forever ? null : Math.floor(Date.now() / 1000) + ttl,
            interval_hint: "建议每 60 秒调用一次",
          },
        });
      }

      /* ---- 视频任务巡检（外部监控用）：刷新未完成任务并返回本轮新完成的 ---- */
      case "video_tasks": {
        const { listVideoTasks, refreshVideoTask, isTerminalVideoStatus } = await import("../video");
        const limit = Math.min(100, Math.max(1, Number(p.limit ?? 30) || 30));
        const all = await listVideoTasks(env, { limit });
        const pending = all.filter((t) => !isTerminalVideoStatus(t.status)).slice(0, 15);
        const newlyCompleted: any[] = [];
        const progress: any[] = [];
        for (const t of pending) {
          const r = await refreshVideoTask(env, t);
          progress.push({ id: r.id, status: r.status, progress: r.progress, model: r.model });
          if (r.status === "completed") {
            newlyCompleted.push({ id: r.id, url: r.url, model: r.model, created_at: r.createdAt, user_id: r.userId });
          } else if (r.status === "failed" || r.status === "cancelled") {
            newlyCompleted.push({ id: r.id, status: r.status, error: r.error, model: r.model, created_at: r.createdAt });
          }
        }
        return json({
          ok: true,
          result: {
            scanned: all.length,
            pending: pending.length,
            newly_completed: newlyCompleted,
            progress,
          },
        });
      }

      /* ---- Key 池分片迁移（万级 Key 渠道一次性迁移，幂等） ---- */
      case "migrate_provider_keys": {
        const providerId = String(p.providerId || "");
        if (!providerId) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 providerId");
        const { migrateProviderKeysToShards } = await import("../storage/db");
        const result = await migrateProviderKeysToShards(env, providerId);
        return json({ ok: true, result });
      }

      /* ---- 账号池 ---- */
      case "account_pool": {        const providers = await getProviders(env);
        const providerId = String(p.providerId || "");
        const list = providers
          .filter((pr) => (pr.kind || "").startsWith("oauth:") || (pr.kind || "").startsWith("web:"))
          .filter((pr) => !providerId || pr.id === providerId || pr.slug === providerId);
        const { buildAccountPool } = await import("../account-pool");
        // quota=0：跳过解密与上游额度查询，进页快速列表（额度由各渠道按需刷新）
        const rows = await buildAccountPool(env, list, { skipQuota: p.quota === 0 || p.quota === "0" });
        return json({ ok: true, providers: rows });
      }

      /* ---- CodeBuddy（WorkBuddy）每日签到 ---- */
      case "codebuddy_checkin": {
        // 控制台手动触发：force 跳过去重；不传 type 时跑所有已开启渠道
        const { runCheckins } = await import("../checkin");
        const types = typeof p.type === "string" && p.type ? [String(p.type)] : undefined;
        const run = await runCheckins(env, { force: true, types });
        return done(run, "checkin", types ? types.join(",") : "all");
      }

      /* ---- 用户提交供应商：审核流 ---- */
      case "list_provider_submissions": {
        const subs = await getProviderSubmissions(env);
        const pendingCount = subs.filter((x) => x.status === "pending").length;
        return done(
          {
            ok: true,
            pendingCount,
            // 审核列表不透出加密凭据
            submissions: subs.map(({ encryptedKey, ...rest }) => ({ ...rest, hasKey: !!encryptedKey })),
          },
          "provider_submission",
          "list"
        );
      }
      case "provider_submission_thread": {
        const id = String(p.id || "");
        const subs = await getProviderSubmissions(env);
        const sub = subs.find((x) => x.id === id);
        if (!sub) throw new ApiError(404, ErrorCode.NOT_FOUND, "提交记录不存在");
        const messages = await getProviderSubmissionThread(env, id);
        return done({ ok: true, submission: { ...sub, encryptedKey: undefined }, messages }, "provider_submission", id);
      }
      case "provider_submission_review": {
        const id = String(p.id || "");
        const decision = String(p.decision || "");
        if (!["approved", "rejected"].includes(decision)) throw new ApiError(400, ErrorCode.BAD_REQUEST, "decision 必须是 approved / rejected");
        const subs = await getProviderSubmissions(env);
        const sub = subs.find((x) => x.id === id);
        if (!sub) throw new ApiError(404, ErrorCode.NOT_FOUND, "提交记录不存在");
        if (sub.status !== "pending") throw new ApiError(400, ErrorCode.BAD_REQUEST, `该提交已是 ${sub.status} 状态，不能重复审核`);

        const now = Math.floor(Date.now() / 1000);
        const reason = String(p.reason || "").trim();
        if (decision === "rejected" && !reason) throw new ApiError(400, ErrorCode.BAD_REQUEST, "驳回必须填写原因");

        let providerId: string | null = sub.providerId ?? null;
        if (decision === "approved") {
          // 审核内容覆盖（可选）：通过前允许修正名称/BaseURL/密钥
          if (p.name) sub.name = String(p.name).trim();
          if (p.baseUrl) sub.baseUrl = String(p.baseUrl).trim();
          // 落地正式渠道（独立 uuid，带归属与审核溯源）
          providerId = uuid();
          await upsertProvider(env, {
            id: providerId,
            name: sub.name,
            slug: sub.slug,
            kind: sub.kind,
            baseUrl: sub.baseUrl,
            authScheme: sub.authScheme,
            extraHeaders: sub.extraHeaders ?? null,
            status: "active",
            createdAt: now,
            ownerUserId: sub.ownerUserId,
            submissionId: sub.id,
          });
          // 密钥：审核时可替换，缺省用用户提交的
          let encryptedKey = sub.encryptedKey ?? null;
          let keyFingerprint = sub.keyFingerprint ?? null;
          if (p.key) {
            encryptedKey = await encryptSecret(env, String(p.key).trim());
            const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(p.key).trim()));
            keyFingerprint = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
          }
          if (encryptedKey) {
            await bulkUpsertProviderKeys(env, providerId, [
              {
                id: uuid(),
                providerId,
                label: "user-submitted",
                encryptedKey,
                keyFingerprint,
                status: "active",
                createdAt: now,
              },
            ]);
          }
        }

        sub.status = decision as "approved" | "rejected";
        sub.rejectionReason = decision === "rejected" ? reason : null;
        sub.reviewerUserId = admin.id;
        sub.reviewedAt = now;
        sub.providerId = providerId;
        sub.updatedAt = now;
        await upsertProviderSubmission(env, sub);

        // 审核结果同步进站内信线程（提交用户可见）
        await appendProviderSubmissionMessage(env, {
          id: uuid(),
          submissionId: sub.id,
          fromUserId: admin.id,
          fromEmail: admin.email,
          fromRole: "admin",
          content:
            decision === "approved"
              ? `审核通过：已创建正式渠道「${sub.name}」（${sub.slug}）。${reason ? `备注：${reason}` : ""}`
              : `审核驳回：${reason}`,
          createdAt: now,
        });

        return done({ ok: true, submission: { ...sub, encryptedKey: undefined }, providerId }, "provider_submission", id);
      }
      case "provider_submission_reply": {
        const id = String(p.id || "");
        const content = String(p.content || "").trim();
        if (!content || content.length > 1000) throw new ApiError(400, ErrorCode.BAD_REQUEST, "请填写 1000 字以内的回复");
        const subs = await getProviderSubmissions(env);
        const sub = subs.find((x) => x.id === id);
        if (!sub) throw new ApiError(404, ErrorCode.NOT_FOUND, "提交记录不存在");
        const msg = {
          id: uuid(),
          submissionId: sub.id,
          fromUserId: admin.id,
          fromEmail: admin.email,
          fromRole: "admin" as const,
          content,
          createdAt: Math.floor(Date.now() / 1000),
        };
        await appendProviderSubmissionMessage(env, msg);
        return done({ ok: true }, "provider_submission", id);
      }

      case "provider_submission_test": {
        // 连通性测试：解密用户提交的密钥访问上游 /models，只读不落库
        const id = String(p.id || "");
        const subs = await getProviderSubmissions(env);
        const sub = subs.find((x) => x.id === id);
        if (!sub) throw new ApiError(404, ErrorCode.NOT_FOUND, "提交记录不存在");
        const key = sub.encryptedKey ? await decryptSecret(env, sub.encryptedKey) : "";
        const { testUpstreamConnectivity } = await import("../provider-test");
        const r = await testUpstreamConnectivity({ baseUrl: sub.baseUrl, kind: sub.kind, authScheme: sub.authScheme, key });
        return done({ ok: true, result: r }, "provider_submission", id);
      }
      case "provider_submission_delete": {
        // 清理提交记录（测试残留 / 用户请求撤回且已处理完毕时使用）
        const id = String(p.id || "");
        const subs = await getProviderSubmissions(env);
        const sub = subs.find((x) => x.id === id);
        if (!sub) throw new ApiError(404, ErrorCode.NOT_FOUND, "提交记录不存在");
        const { deleteProviderSubmission } = await import("../storage/db");
        await deleteProviderSubmission(env, id);
        return done({ ok: true }, "provider_submission", id);
      }

      /* ---- 签到任务总览（定时任务页）：渠道注册表 + 开关 + 各渠道账号数 ---- */
      case "checkin_status": {
        const { listCheckinChannels, readCheckinConfig } = await import("../checkin");
        const [channels, cfg, providers] = await Promise.all([
          Promise.resolve(listCheckinChannels()),
          readCheckinConfig(env),
          getProviders(env),
        ]);
        const rows = [];
        for (const pr of providers) {
          const type = (pr.kind || "").replace(/^oauth:/, "");
          const meta = channels.find((x) => x.type === type);
          if (!meta) continue;
          const keys = await getProviderKeysAll(env, pr.id).catch(() => []);
          rows.push({
            id: pr.id,
            name: pr.name,
            slug: pr.slug,
            type,
            label: meta.label,
            action: meta.action,
            enabled: !cfg.disabled.includes(type),
            status: pr.status,
            accounts: keys.length,
          });
        }
        return done({ ok: true, channels, providers: rows }, "checkin", "status");
      }

      /* ---- ZCode：把客户端真实 device_mid 写回凭据（无需重新授权） ---- */
      case "zcode_set_device": {
        const providerId = String(p.providerId || "");
        const deviceId = String(p.deviceId || "").trim();
        if (!deviceId) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 deviceId");
        const providers = await getProviders(env);
        const prov = providers.find((x) => x.id === providerId || x.slug === providerId);
        if (!prov) throw new ApiError(404, ErrorCode.NOT_FOUND, "渠道不存在");
        const keys = await getProviderKeysAll(env, prov.id);
        const key = keys.find((k) => k.status === "active") || keys[0];
        if (!key) throw new ApiError(400, ErrorCode.BAD_REQUEST, "该渠道还没有已授权的账号");
        const { parseZcodeCredential } = await import("../oauth/zcode");
        const raw = await decryptSecret(env, key.encryptedKey);
        const cred = parseZcodeCredential(raw);
        const next = [cred.jwt, cred.accessToken, deviceId].filter(Boolean).join("|");
        await bulkUpsertProviderKeys(env, prov.id, [
          { ...key, encryptedKey: await encryptSecret(env, next) },
        ]);
        return done({ deviceId }, "oauth_account", key.id);
      }

      /* ---- ZCode 诊断：余额 + 可领套餐原始返回 ---- */
      case "zcode_probe": {
        const providerId = String(p.providerId || "");
        const providers = await getProviders(env);
        const prov = providers.find((x) => x.id === providerId || x.slug === providerId);
        if (!prov) throw new ApiError(404, ErrorCode.NOT_FOUND, "渠道不存在");
        const keys = await getProviderKeysAll(env, prov.id);
        const key = keys.find((k) => k.status === "active") || keys[0];
        if (!key) throw new ApiError(400, ErrorCode.BAD_REQUEST, "该渠道还没有已授权的账号");
        const { probeZcode } = await import("../oauth/zcode");
        const token = await decryptSecret(env, key.encryptedKey);
        return done(await probeZcode(env, token, prov.baseUrl), "oauth_account", key.id);
      }

      /* ---- Qoder 诊断：凭据元信息 + 额度/活动候选路径矩阵 ---- */
      case "qoder_probe": {
        const providerId = String(p.providerId || "");
        const providers = await getProviders(env);
        const prov = providers.find((x) => x.id === providerId || x.slug === providerId);
        if (!prov) throw new ApiError(404, ErrorCode.NOT_FOUND, "渠道不存在");
        const keys = await getProviderKeysAll(env, prov.id);
        const key = keys.find((k) => k.status === "active") || keys[0];
        if (!key) throw new ApiError(400, ErrorCode.BAD_REQUEST, "该渠道还没有已授权的账号");
        const { probeQoder } = await import("../oauth/qoder");
        const raw = await decryptSecret(env, key.encryptedKey);
        return done(await probeQoder(env, raw, prov.baseUrl), "oauth_account", key.id);
      }

      /* ---- Trae 诊断：凭据元信息 + 区域端点 + model_list 可达性 ---- */
      case "trae_probe": {
        const providerId = String(p.providerId || "");
        const providers = await getProviders(env);
        const prov = providers.find((x) => x.id === providerId || x.slug === providerId);
        if (!prov) throw new ApiError(404, ErrorCode.NOT_FOUND, "渠道不存在");
        const keys = await getProviderKeysAll(env, prov.id);
        const key = keys.find((k) => k.status === "active") || keys[0];
        if (!key) throw new ApiError(400, ErrorCode.BAD_REQUEST, "该渠道还没有已授权的账号");
        const { probeTrae } = await import("../oauth/trae");
        const raw = await decryptSecret(env, key.encryptedKey);
        return done(await probeTrae(env, raw, prov.baseUrl), "oauth_account", key.id);
      }

      /* ---- 自动签到开关（按渠道，默认开启） ---- */
      case "checkin_config": {
        const { listCheckinChannels, readCheckinConfig } = await import("../checkin");
        const cfg = await readCheckinConfig(env);
        return json({
          ok: true,
          result: {
            channels: listCheckinChannels().map((c) => ({
              type: c.type,
              label: c.label,
              action: c.action,
              enabled: !cfg.disabled.includes(c.type),
            })),
          },
        });
      }

      case "set_checkin": {
        const type = String(p.type || "");
        if (!type || typeof p.enabled !== "boolean") {
          throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 type 或 enabled");
        }
        const { listCheckinChannels, readCheckinConfig, writeCheckinConfig } = await import("../checkin");
        if (!listCheckinChannels().some((c) => c.type === type)) {
          throw new ApiError(400, ErrorCode.BAD_REQUEST, `渠道 "${type}" 不支持自动签到`);
        }
        const cfg = await readCheckinConfig(env);
        const set = new Set(cfg.disabled);
        if (p.enabled) set.delete(type);
        else set.add(type);
        await writeCheckinConfig(env, { disabled: [...set] });
        return done({ type, enabled: p.enabled }, "checkin", type);
      }

      case "codebuddy_checkin_link": {
        // 签发外部定时链接（免登录，仅能触发签到），默认 30 天，days=0 表示永久
        const { signVideoToken } = await import("../video");
        const { CODEBUDDY_CHECKIN_SUBJECT } = await import("./monitor");
        const rawDays = p.days === undefined || p.days === null || p.days === "" ? 30 : Number(p.days);
        const days = Number.isFinite(rawDays) ? Math.max(0, Math.min(3650, rawDays)) : 30;
        const forever = days === 0;
        const ttl = forever ? 0 : days * 86_400;
        const token = await signVideoToken(env, CODEBUDDY_CHECKIN_SUBJECT, ttl);
        const { publicOrigin } = await import("../public-url");
        const origin = publicOrigin({ req: { header: (n: string) => hCtx.req.header(n) } }, env);
        return json({
          ok: true,
          result: {
            url: `${origin}/api/monitor/checkin?token=${encodeURIComponent(token)}`,
            never_expires: forever,
            expires_at: forever ? null : Math.floor(Date.now() / 1000) + ttl,
            interval_hint: "建议每天调用一次（09:00 前后）",
          },
        });
      }

      /* ---- OAuth 渠道授权 ---- */
      case "oauth_start": {
        const type = String(p.provider || "");
        const { startOAuth, isOAuthType } = await import("../oauth");
        if (!isOAuthType(type)) throw new ApiError(400, ErrorCode.BAD_REQUEST, `不支持的 OAuth 渠道: ${type}`);
        const result = await startOAuth(env, type, p.baseUrl ? String(p.baseUrl) : undefined);
        return done(result, "oauth", type);
      }
      case "oauth_complete": {
        const type = String(p.provider || "");
        const { completeOAuth, isOAuthType } = await import("../oauth");
        if (!isOAuthType(type)) throw new ApiError(400, ErrorCode.BAD_REQUEST, `不支持的 OAuth 渠道: ${type}`);
        if (!p.code || !p.state) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 code 或 state");
        const result = await completeOAuth(
          env,
          type,
          String(p.code),
          String(p.state),
          p.baseUrl ? String(p.baseUrl) : undefined
        );
        return done({ refreshToken: result.refreshToken, email: result.email, account: result.account }, "oauth", type);
      }
      case "oauth_poll": {
        const type = String(p.provider || "");
        const { pollOAuth, isOAuthType } = await import("../oauth");
        if (!isOAuthType(type)) throw new ApiError(400, ErrorCode.BAD_REQUEST, `不支持的 OAuth 渠道: ${type}`);
        if (!p.state) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 state");
        const r = await pollOAuth(env, type, String(p.state));
        return json({ ok: true, result: r, status: r.status, refresh_token: r.refreshToken ?? null, message: r.message ?? null });
      }
      case "oauth_test": {
        const providerId = String(p.providerId || "");
        const providers = await getProviders(env);
        const prov = providers.find((x) => x.id === providerId || x.slug === providerId);
        if (!prov) throw new ApiError(404, ErrorCode.NOT_FOUND, "渠道不存在");
        const { parseOAuthKind, testOAuth, OAUTH_PROVIDERS } = await import("../oauth");
        const type = parseOAuthKind(prov.kind);
        if (!type) throw new ApiError(400, ErrorCode.BAD_REQUEST, "该渠道不是 OAuth 渠道");
        const keys = await getProviderKeysAll(env, prov.id);
        const keyId = String(p.keyId || "");
        const key = keyId ? keys.find((k) => k.id === keyId) : keys.find((k) => k.status === "active") || keys[0];
        if (!key) throw new ApiError(400, ErrorCode.BAD_REQUEST, "该渠道还没有已授权的账号");
        const token = await decryptSecret(env, key.encryptedKey);
        const model = String(p.model || OAUTH_PROVIDERS[type].defaultModels[0]);
        const result = await testOAuth(env, type, token, model, prov.baseUrl);
        return done(result, "oauth_account", key.id);
      }

      /* ---- 模型管理 ---- */
      case "list_upstream_models": {
        const providerId = String(p.providerId || "");
        const providers = await getProviders(env);
        const prov = providers.find((x) => x.id === providerId || x.slug === providerId);
        const provKind = prov?.kind || "";
        if (provKind.startsWith("web:")) {
          const type = provKind.slice("web:".length);
          const { fetchWebModels, WEB_PROVIDERS } = await import("../web");
          const keys = prov ? await getProviderKeysAll(env, prov.id) : [];
          const activeKey = keys.find((k) => k.status === "active") || keys[0];
          if (activeKey && type !== "geminiweb") {
            try {
              const credential = await decryptSecret(env, activeKey.encryptedKey);
              const r = await fetchWebModels(env, type as any, credential, prov?.baseUrl);
              return json({ ok: true, models: r.models, note: r.message });
            } catch {}
          }
          const meta = WEB_PROVIDERS[type as keyof typeof WEB_PROVIDERS];
          return json({ ok: true, models: meta?.defaultModels ?? [] });
        }
        if (provKind.startsWith("oauth:")) {
          const type = provKind.slice("oauth:".length);
          const { fetchOAuthModels, OAUTH_PROVIDERS } = await import("../oauth");
          const keys = prov ? await getProviderKeysAll(env, prov.id) : [];
          const activeKey = keys.find((k) => k.status === "active") || keys[0];
          if (activeKey) {
            try {
              const token = await decryptSecret(env, activeKey.encryptedKey);
              const r = await fetchOAuthModels(env, type as any, token, prov?.baseUrl);
              return json({ ok: true, models: r.models, note: r.message, degraded: r.degraded === true });
            } catch {}
          }
          const meta = OAUTH_PROVIDERS[type as keyof typeof OAUTH_PROVIDERS];
          return json({ ok: true, models: meta?.defaultModels ?? [] });
        }
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
            const keys = await getProviderKeysAll(env, prov?.id || "anthropic");
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
          const keys = await getProviderKeysAll(env, prov.id);
          const activeKey = keys.find((k) => k.status === "active");
          if (activeKey) {
            try {
              const plainKey = await decryptSecret(env, activeKey.encryptedKey);
              const mRes = await fetch(joinApiPath(prov.baseUrl, "/v1/models"), {
                headers: { authorization: `Bearer ${plainKey}` },
                signal: AbortSignal.timeout(15000),
              });
              if (mRes.ok) {
                const data = (await mRes.json()) as { data?: { id?: string }[] };
                // Google 兼容列表返回 models/xxx，对话接口只认裸名，导入时统一剥前缀
                const mList = (data.data ?? [])
                  .map((m) => m.id)
                  .filter((x): x is string => !!x)
                  .map((id) => normalizeUpstreamModel(prov.slug, prov.baseUrl, id));
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
      case "delete_pricing": {
        // 支持单个 publicName 或批量 publicNames，用于清理已删模型遗留的孤儿定价
        const names = Array.isArray(p.publicNames)
          ? p.publicNames.map(String)
          : p.publicName
          ? [String(p.publicName)]
          : [];
        if (!names.length) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 publicName");
        let removed = 0;
        for (const name of names) {
          if (await deletePricing(env, name)) removed++;
        }
        return done({ removed, total: names.length }, "pricing", `${removed}/${names.length}`);
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
      case "get_epay": {
        const s = await getSettings(env);
        return json({
          ok: true,
          epay: {
            enabled: !!s.epayEnabled,
            gateway: s.epayGateway ?? "",
            pid: s.epayPid ?? "",
            hasKey: !!s.epayKeyEnc,
            channels: Array.isArray(s.epayChannels) && s.epayChannels.length ? s.epayChannels : ["alipay", "wxpay", "qqpay"],
            minAmount: Number(s.epayMinAmount ?? 1),
            maxAmount: Number(s.epayMaxAmount ?? 5000),
            productName: s.epayProductName ?? "API 额度充值",
          },
        });
      }
      case "set_epay": {
        const ALLOWED = ["alipay", "wxpay", "qqpay", "usdt"];
        const rawChannels = Array.isArray(p.channels)
          ? (p.channels as unknown[]).map(String)
          : typeof p.channels === "string"
          ? String(p.channels).split(/[\s,，]+/)
          : [];
        const channels = rawChannels.map((c) => c.trim().toLowerCase()).filter((c) => ALLOWED.includes(c));
        if (!channels.length) throw new ApiError(400, ErrorCode.BAD_REQUEST, "至少启用一种支付方式");

        const minAmount = Number(p.minAmount ?? 1);
        const maxAmount = Number(p.maxAmount ?? 5000);
        if (!Number.isFinite(minAmount) || minAmount <= 0) throw new ApiError(400, ErrorCode.BAD_REQUEST, "最低金额不合法");
        if (!Number.isFinite(maxAmount) || maxAmount < minAmount) throw new ApiError(400, ErrorCode.BAD_REQUEST, "最高金额不能小于最低金额");

        const gateway = String(p.gateway ?? "").trim().replace(/\/+$/, "");
        if (gateway && !/^https?:\/\//i.test(gateway)) throw new ApiError(400, ErrorCode.BAD_REQUEST, "网关地址必须是 http(s) 开头");

        const patch: Partial<PlatformSettings> = {
          epayEnabled: !!p.enabled,
          epayGateway: gateway,
          epayPid: String(p.pid ?? "").trim(),
          epayChannels: channels,
          epayMinAmount: Math.round(minAmount * 100) / 100,
          epayMaxAmount: Math.round(maxAmount * 100) / 100,
          epayProductName: String(p.productName ?? "API 额度充值").trim() || "API 额度充值",
        };
        if (p.key) {
          patch.epayKeyEnc = await encryptSecret(env, String(p.key).trim());
        }
        if (p.enabled && (!gateway || !patch.epayPid)) {
          throw new ApiError(400, ErrorCode.BAD_REQUEST, "启用在线支付必须填写网关地址与商户 PID");
        }
        if (p.enabled && !patch.epayKeyEnc && !(await getSettings(env)).epayKeyEnc) {
          throw new ApiError(400, ErrorCode.BAD_REQUEST, "启用在线支付必须填写商户密钥");
        }
        await updateSettings(env, patch);
        return done(null, "settings", "epay");
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
    const now = Date.now();
    const dates = Array.from({ length: days }, (_, i) => new Date(now - (days - 1 - i) * 86400 * 1000).toISOString().slice(0, 10));
    const summaries = await Promise.all(dates.map((d) => getDailyUsage(c.env, d)));
    const points = dates.map((d, idx) => {
      const s = summaries[idx];
      return {
        date: d,
        requests: s?.requests || 0,
        tokens: (s?.promptTokens || 0) + (s?.completionTokens || 0),
        errors: (s?.requests || 0) - (s?.successRequests || 0),
        cost: s?.totalCostUsd || 0,
      };
    });

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

    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
    const status = (c.req.query("status") || "").trim();
    const model = (c.req.query("model") || "").trim();
    const userId = (c.req.query("userId") || "").trim();

    let records: any[] = [];
    records = await getRecentUsageRecords(c.env);
    if (!records.length) {
      // 兼容历史数据：旧版本没有最近索引，扫描记录 key 并按写入时间倒序
      const store = getBlobStore(c.env);
      const res = await store.list({ prefix: "usage:record:", paginate: false, consistency: "strong" });
      const loaded = await Promise.all(
        (res.blobs || []).slice(0, 300).map((b) => store.get(b.key, { type: "json", consistency: "strong" }).catch(() => null))
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
