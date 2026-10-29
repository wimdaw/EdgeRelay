/**
 * EdgeRelay 数据访问层（基于 EdgeOne Blob 数据库）
 */

import { getBlobStore } from "./blob-store";
export { getBlobStore };
import { TtlCache, mapLimit } from "./cache";
import {
  enqueueUsageWrite,
  enqueueLedgerWrite,
  flushWriteBehind,
  mergeUsageDeltaInto,
  pendingDailyDelta,
  pendingLedgerEntries,
  pendingUsageRecords,
} from "./write-behind";
import {
  type PlatformSettings,
  DEFAULT_SETTINGS,
  clampAuditRetentionDays,
  type UserRecord,
  type SessionRecord,
  type ApiKeyRecord,
  type ProviderRecord,
  type ProviderKeyRecord,
  type ModelRouteRecord,
  type ModelPricingRecord,
  type BalanceRecord,
  type RedeemCodeRecord,
  type LedgerEntryRecord,
  type UsageRecord,
  type DailyUsageSummary,
  type AuditLogRecord,
  type ContentFlagRecord,
  type AppealRecord,
} from "../types";
import { sha256Hex, uuid } from "../crypto";
import { ApiError, ErrorCode } from "../errors";

/**
 * 进程内热缓存（EdgeOne Blob 单次强一致读写约 100~200ms，热路径必须避免重复读）
 *  - 管理端写入会同步 set/delete，本实例立即可见
 *  - 跨实例最多滞后一个 TTL，且过期后 stale-while-revalidate，请求不等待刷新
 */
const SETTINGS_TTL = 60_000;
const CONFIG_TTL = 60_000;
const AUTH_TTL = 30_000;
const USER_TTL = 60_000;
const PROVIDER_KEYS_TTL = 60_000;

const settingsCache = new TtlCache<PlatformSettings>(SETTINGS_TTL, 2);
const providersCache = new TtlCache<ProviderRecord[]>(CONFIG_TTL, 2);
const modelsCache = new TtlCache<ModelRouteRecord[]>(CONFIG_TTL, 2);
const pricingCache = new TtlCache<Record<string, ModelPricingRecord>>(CONFIG_TTL, 2);
const apiKeyCache = new TtlCache<ApiKeyRecord | null>(AUTH_TTL, 5000);
const userCache = new TtlCache<UserRecord | null>(USER_TTL, 2000);
const sessionCache = new TtlCache<SessionRecord | null>(USER_TTL, 2000);
const providerKeysCache = new TtlCache<ProviderKeyRecord[]>(PROVIDER_KEYS_TTL, 200);
const announcementCache = new TtlCache<AnnouncementRecord[]>(60_000, 2);

/** keyId -> keyHash 二级索引，避免按 id 反查时全表扫 Key */
const apiKeyIdIndex = new Map<string, string>();

/** 备份导入/恢复后清空进程内缓存，保证立即读取恢复后的 Blob 数据 */
export function invalidateStorageCaches(): void {
  settingsCache.clear();
  providersCache.clear();
  modelsCache.clear();
  pricingCache.clear();
  apiKeyCache.clear();
  userCache.clear();
  sessionCache.clear();
  providerKeysCache.clear();
  announcementCache.clear();
  apiKeyIdIndex.clear();
  balanceCache.clear();
  apiKeyWriteTimers.clear();
  auditChainCache = null;
  freeChannelsSeeded = false;
}

// ==========================================
// 1. 全局配置 (Settings)
// ==========================================

export async function getSettings(env?: any): Promise<PlatformSettings> {
  return settingsCache.get("platform", async () => {
    const store = getBlobStore(env);
    const stored = await store.get("settings:platform", { type: "json", consistency: "strong" });
    if (!stored) {
      // 首次启动，保存默认设置
      await store.setJSON("settings:platform", DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    }
    const merged: PlatformSettings = { ...DEFAULT_SETTINGS, ...stored };
    merged.auditLogRetentionDays = clampAuditRetentionDays(merged.auditLogRetentionDays);
    return merged;
  });
}

export async function updateSettings(env: any, patch: Partial<PlatformSettings>): Promise<PlatformSettings> {
  const store = getBlobStore(env);
  const cur = await getSettings(env);
  const updated: PlatformSettings = { ...cur, ...patch };
  updated.auditLogRetentionDays = clampAuditRetentionDays(updated.auditLogRetentionDays);
  await store.setJSON("settings:platform", updated);
  settingsCache.set("platform", updated);
  return updated;
}

// ==========================================
// 2. 用户管理 (Users)
// ==========================================

export async function getUserByEmail(env: any, email: string): Promise<UserRecord | null> {
  const store = getBlobStore(env);
  const norm = email.trim().toLowerCase();
  const idx = await store.get(`idx:user:email:${encodeURIComponent(norm)}`, { type: "json", consistency: "strong" });
  if (!idx?.userId) return null;
  return getUserById(env, idx.userId);
}

export async function getUserById(env: any, id: string): Promise<UserRecord | null> {
  return userCache.get(id, async () => {
    const store = getBlobStore(env);
    return await store.get(`user:${id}`, { type: "json", consistency: "strong" });
  });
}

export async function createUser(env: any, user: UserRecord): Promise<UserRecord> {
  const store = getBlobStore(env);
  const norm = user.email.trim().toLowerCase();

  // 检查是否已有用户（如果没有用户，第一位注册者自动赋予 superadmin 角色）
  const allUsersIdx = (await store.get("idx:users:all", { type: "json", consistency: "strong" })) || [];
  if (allUsersIdx.length === 0) {
    user.role = "superadmin";
  }

  await store.setJSON(`user:${user.id}`, user);
  await store.setJSON(`idx:user:email:${encodeURIComponent(norm)}`, { userId: user.id });

  allUsersIdx.unshift(user.id);
  await store.setJSON("idx:users:all", allUsersIdx);
  userCache.set(user.id, user);

  // 初始化个人钱包
  await getOrCreateBalance(env, `user:${user.id}`);

  return user;
}

export async function updateUser(env: any, id: string, updates: Partial<UserRecord>): Promise<UserRecord | null> {
  const store = getBlobStore(env);
  const cur = await getUserById(env, id);
  if (!cur) return null;
  const updated: UserRecord = {
    ...cur,
    ...updates,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  await store.setJSON(`user:${id}`, updated);
  userCache.set(id, updated);
  return updated;
}

export async function listAllUsers(env: any): Promise<UserRecord[]> {
  const store = getBlobStore(env);
  const allIds: string[] = (await store.get("idx:users:all", { type: "json", consistency: "strong" })) || [];
  // 并发读取，把 N 轮串行往返压成 N/12 轮
  const users = await mapLimit(allIds, 12, async (id) => await getUserById(env, id));
  return users.filter((u): u is UserRecord => !!u);
}

export async function deleteUser(env: any, id: string): Promise<boolean> {
  const store = getBlobStore(env);
  const cur = await getUserById(env, id);
  if (!cur) return false;

  // 1. 从用户总索引中移除
  const allIds: string[] = (await store.get("idx:users:all", { type: "json", consistency: "strong" })) || [];
  const filtered = allIds.filter((x) => x !== id);
  await store.setJSON("idx:users:all", filtered);

  // 2. 删除邮箱索引与用户主记录
  const norm = cur.email.trim().toLowerCase();
  await store.delete(`idx:user:email:${encodeURIComponent(norm)}`);
  await store.delete(`user:${id}`);
  userCache.set(id, null);
  userCache.delete(id);

  // 3. 撤销该用户全部生效的 API Key
  try {
    const keys = await listUserApiKeys(env, id);
    for (const k of keys) {
      await updateApiKey(env, k.keyHash, { status: "revoked", revokedAt: Math.floor(Date.now() / 1000) });
    }
  } catch {}

  return true;
}

/**
 * 判定并同步普通用户与 VIP 状态：
 * 只要是普通用户体系（user 或 vip），余额大于 0 自动晋升为 vip；余额归零或为负自动降级为 user
 * 管理员、超级管理员等职能角色保持其身份不变
 */
export async function syncUserVipStatus(env: any, userId: string, availableBalance?: number): Promise<string> {
  const user = await getUserById(env, userId);
  if (!user) return "user";
  if (user.role !== "user" && user.role !== "vip") {
    return user.role;
  }
  let bal = availableBalance;
  if (bal === undefined) {
    const b = await getOrCreateBalance(env, `user:${userId}`);
    bal = b.available;
  }
  const nextRole: "user" | "vip" = bal > 0 ? "vip" : "user";
  if (user.role !== nextRole) {
    user.role = nextRole;
    await updateUser(env, userId, { role: nextRole });
  }
  return nextRole;
}

// ==========================================
// 3. 用户会话 (Sessions)
// ==========================================

export async function createSession(env: any, session: SessionRecord): Promise<void> {
  const store = getBlobStore(env);
  await store.setJSON(`session:${session.id}`, session);
  sessionCache.set(session.id, session);
}

export async function getSession(env: any, id: string): Promise<SessionRecord | null> {
  const s = await sessionCache.get(id, async () => {
    const store = getBlobStore(env);
    return await store.get(`session:${id}`, { type: "json", consistency: "strong" });
  });
  if (!s) return null;
  if (s.expiresAt < Math.floor(Date.now() / 1000)) {
    sessionCache.delete(id);
    getBlobStore(env).delete(`session:${id}`).catch(() => {});
    return null;
  }
  return s;
}

export async function deleteSession(env: any, id: string): Promise<void> {
  sessionCache.delete(id);
  const store = getBlobStore(env);
  await store.delete(`session:${id}`).catch(() => {});
}

// ==========================================
// 4. API 密钥 (API Keys)
// ==========================================

export async function getApiKeyByHash(env: any, keyHash: string): Promise<ApiKeyRecord | null> {
  const row = await apiKeyCache.get(keyHash, async () => {
    const store = getBlobStore(env);
    return await store.get(`key:${keyHash}`, { type: "json", consistency: "strong" });
  });
  if (row?.id) apiKeyIdIndex.set(row.id, row.keyHash);
  return row;
}

/** 按 keyId 取记录（命中 hash 索引时零 I/O），用于扣费/最后使用时间更新 */
async function getApiKeyById(env: any, keyId: string): Promise<ApiKeyRecord | null> {
  const hash = apiKeyIdIndex.get(keyId);
  if (hash) {
    const cached = apiKeyCache.peek(hash);
    if (cached) return cached;
    return await getApiKeyByHash(env, hash);
  }
  const all = await listAllApiKeys(env);
  const found = all.find((k) => k.id === keyId) || null;
  if (found) apiKeyIdIndex.set(found.id, found.keyHash);
  return found;
}

export async function createApiKey(env: any, keyRecord: ApiKeyRecord): Promise<ApiKeyRecord> {
  const store = getBlobStore(env);
  await store.setJSON(`key:${keyRecord.keyHash}`, keyRecord);
  apiKeyCache.set(keyRecord.keyHash, keyRecord);
  apiKeyIdIndex.set(keyRecord.id, keyRecord.keyHash);

  // 用户索引
  const userKeyIds: string[] = (await store.get(`idx:keys:user:${keyRecord.userId}`, { type: "json", consistency: "strong" })) || [];
  userKeyIds.unshift(keyRecord.keyHash);
  await store.setJSON(`idx:keys:user:${keyRecord.userId}`, userKeyIds);

  // 全局索引
  const allKeyIds: string[] = (await store.get("idx:keys:all", { type: "json", consistency: "strong" })) || [];
  allKeyIds.unshift(keyRecord.keyHash);
  await store.setJSON("idx:keys:all", allKeyIds);

  return keyRecord;
}

export async function listUserApiKeys(env: any, userId: string): Promise<ApiKeyRecord[]> {
  const store = getBlobStore(env);
  const hashes: string[] = (await store.get(`idx:keys:user:${userId}`, { type: "json", consistency: "strong" })) || [];
  const list = await mapLimit(hashes, 12, async (h) => await getApiKeyByHash(env, h));
  return list.filter((k): k is ApiKeyRecord => !!k);
}

export async function listAllApiKeys(env: any): Promise<ApiKeyRecord[]> {
  const store = getBlobStore(env);
  const hashes: string[] = (await store.get("idx:keys:all", { type: "json", consistency: "strong" })) || [];
  const list = await mapLimit(hashes, 12, async (h) => await getApiKeyByHash(env, h));
  return list.filter((k): k is ApiKeyRecord => !!k);
}

export async function updateApiKey(env: any, keyHash: string, updates: Partial<ApiKeyRecord>): Promise<ApiKeyRecord | null> {
  const store = getBlobStore(env);
  const cur = (await getApiKeyByHash(env, keyHash)) || null;
  if (!cur) return null;
  const updated: ApiKeyRecord = { ...cur, ...updates };
  await store.setJSON(`key:${keyHash}`, updated);
  apiKeyCache.set(keyHash, updated);
  apiKeyIdIndex.set(updated.id, keyHash);
  return updated;
}

/**
 * 热路径专用：在内存里更新 Key 的 lastUsedAt / spentUsd，落库做 4 秒节流合并。
 * 配额判定读的是内存记录，因此扣费立即可见。
 */
export function touchApiKeyUsage(
  env: any,
  keyId: string,
  patch: { lastUsedAt?: number; spentDelta?: number }
): void {
  const hash = apiKeyIdIndex.get(keyId);
  if (!hash) {
    // 索引缺失时异步补一次（不影响主流程）
    void getApiKeyById(env, keyId).catch(() => {});
    return;
  }
  const rec = apiKeyCache.peek(hash);
  if (!rec) return;
  if (patch.lastUsedAt) rec.lastUsedAt = patch.lastUsedAt;
  if (patch.spentDelta) rec.spentUsd = (rec.spentUsd || 0) + patch.spentDelta;
  scheduleApiKeyPersist(env, hash);
}

const apiKeyWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleApiKeyPersist(env: any, keyHash: string): void {
  if (apiKeyWriteTimers.has(keyHash)) return;
  const timer = setTimeout(() => {
    apiKeyWriteTimers.delete(keyHash);
    const rec = apiKeyCache.peek(keyHash);
    if (!rec) return;
    getBlobStore(env)
      .setJSON(`key:${keyHash}`, { ...rec })
      .catch(() => {});
  }, 4000);
  apiKeyWriteTimers.set(keyHash, timer);
}

// ==========================================
// 5. 供应商与密钥 (Providers & Keys)
// ==========================================

let freeChannelsSeeded = false;
let freeChannelsSeedPromise: Promise<void> | null = null;

/** 冷启动自举：single-flight，避免并发首请求各自跑一轮全量读取 */
export function ensureFreeChannelsSeeded(env: any): Promise<void> {
  if (freeChannelsSeeded) return Promise.resolve();
  if (!freeChannelsSeedPromise) {
    freeChannelsSeedPromise = seedFreeChannels(env)
      .catch((err: any) => {
        console.error("[ensureFreeChannelsSeeded] error:", err?.message);
      })
      .finally(() => {
        freeChannelsSeedPromise = null;
      });
  }
  return freeChannelsSeedPromise;
}

async function seedFreeChannels(env: any): Promise<void> {
  const store = getBlobStore(env);
  const now = Math.floor(Date.now() / 1000);

  try {
    // 三份配置一次性并发读取，冷启动从 3 轮串行往返压成 1 轮
    const [rawProviders, rawModels, rawPricing] = await Promise.all([
      store.get("providers:all", { type: "json", consistency: "strong" }),
      store.get("models:all", { type: "json", consistency: "strong" }),
      store.get("pricing:all", { type: "json", consistency: "strong" }),
    ]);
    let providers = rawProviders || [];
    let pChanged = false;
    if (!providers.some((p: any) => p.id === "opencode" || p.slug === "opencode")) {
      providers.push({
        id: "opencode",
        name: "OpenCode",
        slug: "opencode",
        kind: "opencode",
        baseUrl: "https://opencode.ai/zen/v1",
        authScheme: "none",
        status: "active",
        authorizationRef: "AUTH-OPENCODE-FREE-2026",
        createdAt: now,
      });
      pChanged = true;
    }
    if (!providers.some((p: any) => p.id === "duckai" || p.slug === "duckai")) {
      providers.push({
        id: "duckai",
        name: "Duck.ai",
        slug: "duckai",
        kind: "duckai",
        baseUrl: "https://duck.ai",
        authScheme: "none",
        status: "active",
        authorizationRef: "AUTH-DUCKAI-FREE-2026",
        createdAt: now,
      });
      pChanged = true;
    }
    if (!providers.some((p: any) => p.id === "kilo" || p.slug === "kilo")) {
      providers.push({
        id: "kilo",
        name: "Kilo",
        slug: "kilo",
        kind: "kilo",
        baseUrl: "https://api.kilo.ai/api/gateway",
        authScheme: "none",
        status: "active",
        authorizationRef: "AUTH-KILO-FREE-2026",
        createdAt: now,
      });
      pChanged = true;
    }
    // 自动修正 Anthropic 协议与鉴权类型
    const anthropicP = providers.find((p: any) => p.id === "anthropic" || p.slug === "anthropic");
    if (anthropicP && (anthropicP.kind === "openai_compat" || anthropicP.authScheme !== "x-api-key")) {
      anthropicP.kind = "anthropic";
      anthropicP.authScheme = "x-api-key";
      anthropicP.extraHeaders = JSON.stringify({ "anthropic-version": "2023-06-01", "content-type": "application/json" });
      pChanged = true;
    }
    if (pChanged) {
      await store.setJSON("providers:all", providers);
      providersCache.set("all", providers);
    }

    // 自动将首选站长 hackerxiaow@gmail.com 升级为 superadmin 超级管理员
    try {
      const allUsers = await listAllUsers(env);
      const targetUser = allUsers.find(
        (u) => u.email.toLowerCase() === "hackerxiaow@gmail.com"
      );
      if (targetUser && targetUser.role !== "superadmin") {
        await updateUser(env, targetUser.id, { role: "superadmin" });
      }

      // 超级管理员是铸币方，额度无限：历史「给下级转账扣减」留下的负余额无实际意义，归零并留痕
      const su = allUsers.find((u) => u.role === "superadmin" || u.email.toLowerCase() === "hackerxiaow@gmail.com");
      if (su) {
        const suBal = await getOrCreateBalance(env, `user:${su.id}`);
        if (suBal.available < 0) {
          const delta = -suBal.available;
          suBal.available = 0;
          await updateBalance(env, `user:${su.id}`, suBal);
          await appendLedgerEntry(env, {
            id: uuid(),
            scope: `user:${su.id}`,
            userId: su.id,
            type: "adjustment",
            amount: delta,
            balanceAfter: 0,
            memo: "超级管理员额度无限：历史负余额归零（铸币方不计透支）",
            createdAt: now,
          });
        }
      }
    } catch {}

    let models = rawModels || [];
    
    // 严格按规范清洗：OpenCode 仅保留官方免费层模型（全部带 -free 结尾，特例为 big-pickle）
    // 移除不带 -free 的别名项
    const rawLen = models.length;
    models = models.filter((m: any) => {
      const pId = m.providerId || "";
      if (pId === "opencode" || pId === "p_opencode") {
        return m.publicName === "big-pickle" || m.publicName.endsWith("-free");
      }
      return true;
    });
    let mChanged = models.length !== rawLen;

    const existingNames = new Set(models.map((m: any) => m.publicName));
    const newModels: ModelRouteRecord[] = [
      // OpenCode 官方免费层模型（9 个）
      { id: "m_oc_mimo_f", publicName: "mimo-v2.6-flash-free", providerId: "opencode", upstreamModel: "mimo-v2.6-flash-free", priority: 10, costWeight: 1, maxContext: 32000, enabled: 1, createdAt: now },
      { id: "m_oc_ds41_f", publicName: "deepseek-v4.1-flash-free", providerId: "opencode", upstreamModel: "deepseek-v4.1-flash-free", priority: 10, costWeight: 1, maxContext: 64000, enabled: 1, createdAt: now },
      { id: "m_oc_flint_f", publicName: "flint-40b-free", providerId: "opencode", upstreamModel: "flint-40b-free", priority: 10, costWeight: 1, maxContext: 32000, enabled: 1, createdAt: now },
      { id: "m_oc_nemo_vl_f", publicName: "nemotron-3.5-super-vl-free", providerId: "opencode", upstreamModel: "nemotron-3.5-super-vl-free", priority: 10, costWeight: 1, maxContext: 32000, enabled: 1, createdAt: now },
      { id: "m_oc_nemo_lt_f", publicName: "nemotron-3.5-lightning-free", providerId: "opencode", upstreamModel: "nemotron-3.5-lightning-free", priority: 10, costWeight: 1, maxContext: 32000, enabled: 1, createdAt: now },
      { id: "m_oc_glm53_f", publicName: "glm-5.3-flash-free", providerId: "opencode", upstreamModel: "glm-5.3-flash-free", priority: 10, costWeight: 1, maxContext: 64000, enabled: 1, createdAt: now },
      { id: "m_oc_pickle", publicName: "big-pickle", providerId: "opencode", upstreamModel: "big-pickle", priority: 10, costWeight: 1, maxContext: 32000, enabled: 1, createdAt: now },
      { id: "m_oc_beam_f", publicName: "beam-free", providerId: "opencode", upstreamModel: "beam-free", priority: 10, costWeight: 1, maxContext: 32000, enabled: 1, createdAt: now },
      { id: "m_oc_jev_f", publicName: "jev-1.13-free", providerId: "opencode", upstreamModel: "jev-1.13-free", priority: 10, costWeight: 1, maxContext: 32000, enabled: 1, createdAt: now },
      // Duck.ai models
      { id: "m_dk_luna", publicName: "gpt-6-luna", providerId: "duckai", upstreamModel: "gpt-6-luna", priority: 10, costWeight: 1, maxContext: 128000, enabled: 1, createdAt: now },
      { id: "m_dk_mini", publicName: "gpt-5.4-mini", providerId: "duckai", upstreamModel: "gpt-5.4-mini", priority: 10, costWeight: 1, maxContext: 128000, enabled: 1, createdAt: now },
      { id: "m_dk_haiku", publicName: "claude-haiku-4-5", providerId: "duckai", upstreamModel: "claude-haiku-4-5", priority: 10, costWeight: 1, maxContext: 200000, enabled: 1, createdAt: now },
      { id: "m_dk_mistral", publicName: "mistral-small-2603", providerId: "duckai", upstreamModel: "mistral-small-2603", priority: 10, costWeight: 1, maxContext: 32000, enabled: 1, createdAt: now },
      { id: "m_dk_oss120b", publicName: "tinfoil/gpt-oss-120b", providerId: "duckai", upstreamModel: "tinfoil/gpt-oss-120b", priority: 10, costWeight: 1, maxContext: 64000, enabled: 1, createdAt: now },
      { id: "m_dk_gemma31b", publicName: "tinfoil/gemma4-31b", providerId: "duckai", upstreamModel: "tinfoil/gemma4-31b", priority: 10, costWeight: 1, maxContext: 32000, enabled: 1, createdAt: now },
      { id: "m_dk_oss120b_s", publicName: "gpt-oss-120b", providerId: "duckai", upstreamModel: "tinfoil/gpt-oss-120b", priority: 10, costWeight: 1, maxContext: 64000, enabled: 1, createdAt: now },
      { id: "m_dk_gemma31b_s", publicName: "gemma4-31b", providerId: "duckai", upstreamModel: "tinfoil/gemma4-31b", priority: 10, costWeight: 1, maxContext: 32000, enabled: 1, createdAt: now },
      // Kilo free models (11 个实测验证全通模型)
      { id: "m_kl_auto_f", publicName: "kilo-auto/free", providerId: "kilo", upstreamModel: "kilo-auto/free", priority: 10, costWeight: 1, maxContext: 128000, enabled: 1, createdAt: now },
      { id: "m_kl_or_f", publicName: "openrouter/free", providerId: "kilo", upstreamModel: "openrouter/free", priority: 10, costWeight: 1, maxContext: 128000, enabled: 1, createdAt: now },
      { id: "m_kl_nemo_vl_f", publicName: "nvidia/nemotron-3.5-super-vl:free", providerId: "kilo", upstreamModel: "nvidia/nemotron-3.5-super-vl:free", priority: 10, costWeight: 1, maxContext: 1000000, enabled: 1, createdAt: now },
      { id: "m_kl_nemo_lt_f", publicName: "nvidia/nemotron-3.5-lightning:free", providerId: "kilo", upstreamModel: "nvidia/nemotron-3.5-lightning:free", priority: 10, costWeight: 1, maxContext: 128000, enabled: 1, createdAt: now },
      { id: "m_kl_beam_f", publicName: "reflection/beam-free", providerId: "kilo", upstreamModel: "reflection/beam-free", priority: 10, costWeight: 1, maxContext: 64000, enabled: 1, createdAt: now },
      { id: "m_kl_xing_f", publicName: "xingchen-agi/xing4.0-29b-a4b:free", providerId: "kilo", upstreamModel: "xingchen-agi/xing4.0-29b-a4b:free", priority: 10, costWeight: 1, maxContext: 32000, enabled: 1, createdAt: now },
      { id: "m_kl_dots_f", publicName: "dots-studio/dots-3-note-preview:free", providerId: "kilo", upstreamModel: "dots-studio/dots-3-note-preview:free", priority: 10, costWeight: 1, maxContext: 64000, enabled: 1, createdAt: now },
      { id: "m_kl_lfm_f", publicName: "liquid/lfm-2.5-2.6b:free", providerId: "kilo", upstreamModel: "liquid/lfm-2.5-2.6b:free", priority: 10, costWeight: 1, maxContext: 32000, enabled: 1, createdAt: now },
      { id: "m_kl_north_f", publicName: "cohere/north-mini-code:free", providerId: "kilo", upstreamModel: "cohere/north-mini-code:free", priority: 10, costWeight: 1, maxContext: 64000, enabled: 1, createdAt: now },
      { id: "m_kl_nemo_u550_f", publicName: "nvidia/nemotron-3-ultra-550b-a55b:free", providerId: "kilo", upstreamModel: "nvidia/nemotron-3-ultra-550b-a55b:free", priority: 10, costWeight: 1, maxContext: 128000, enabled: 1, createdAt: now },
      { id: "m_kl_nemo_nano_f", publicName: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", providerId: "kilo", upstreamModel: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", priority: 10, costWeight: 1, maxContext: 128000, enabled: 1, createdAt: now },
    ];
    for (const nm of newModels) {
      if (!existingNames.has(nm.publicName)) {
        models.push(nm);
        mChanged = true;
      }
    }
    if (mChanged) {
      await store.setJSON("models:all", models);
      modelsCache.set("all", models);
    }

    let pricing = rawPricing || {};
    let prChanged = false;
    // 清理废弃模型的 pricing 键
    const validPublicNames = new Set(models.map((m: any) => m.publicName));
    for (const k of Object.keys(pricing)) {
      if (!validPublicNames.has(k)) {
        delete pricing[k];
        prChanged = true;
      }
    }
    for (const nm of newModels) {
      if (!pricing[nm.publicName]) {
        pricing[nm.publicName] = {
          id: `pr_${nm.publicName.replace(/[^a-zA-Z0-9]/g, "_")}`,
          publicName: nm.publicName,
          inputPerMillion: 0,
          outputPerMillion: 0,
          currency: "CNY",
          createdAt: now,
        };
        prChanged = true;
      }
    }
    if (prChanged) {
      await store.setJSON("pricing:all", pricing);
      pricingCache.set("all", pricing);
    }

    // 自举时已经读到最新数据，直接回填缓存，冷启动少一轮读取
    providersCache.set("all", providers);
    modelsCache.set("all", models);
    pricingCache.set("all", pricing);

    freeChannelsSeeded = true;
  } catch (err: any) {
    console.error("[ensureFreeChannelsSeeded] error:", err?.message);
  }
}

export async function getProviders(env: any): Promise<ProviderRecord[]> {
  await ensureFreeChannelsSeeded(env);
  return providersCache.get("all", async () => {
    const store = getBlobStore(env);
    let list = await store.get("providers:all", { type: "json", consistency: "strong" });
    if (!list) {
      await seedInitialData(env);
      list = (await store.get("providers:all", { type: "json", consistency: "strong" })) || [];
    }
    return list;
  });
}

export async function setProviders(env: any, list: ProviderRecord[]): Promise<void> {
  const store = getBlobStore(env);
  await store.setJSON("providers:all", list);
  providersCache.set("all", list);
}

export async function upsertProvider(env: any, provider: ProviderRecord): Promise<void> {
  const list = await getProviders(env);
  const idx = list.findIndex((p) => p.id === provider.id);
  if (idx >= 0) {
    list[idx] = provider;
  } else {
    list.push(provider);
  }
  await setProviders(env, list);
}

export async function getProviderKeys(env: any, providerId: string): Promise<ProviderKeyRecord[]> {
  return providerKeysCache.get(providerId, async () => {
    const store = getBlobStore(env);
    return (await store.get(`provider_keys:${providerId}`, { type: "json", consistency: "strong" })) || [];
  });
}

export async function setProviderKeys(env: any, providerId: string, keys: ProviderKeyRecord[]): Promise<void> {
  const store = getBlobStore(env);
  await store.setJSON(`provider_keys:${providerId}`, keys);
  providerKeysCache.set(providerId, keys);
}

export async function upsertProviderKey(env: any, key: ProviderKeyRecord): Promise<void> {
  const keys = await getProviderKeys(env, key.providerId);
  const idx = keys.findIndex((k) => k.id === key.id);
  const next = keys.slice();
  if (idx >= 0) {
    next[idx] = key;
  } else {
    next.push(key);
  }
  await setProviderKeys(env, key.providerId, next);
}

/** 批量写入上游 Key：一次读 + 一次写，避免批量导入时 N 轮往返 */
export async function bulkUpsertProviderKeys(env: any, providerId: string, incoming: ProviderKeyRecord[]): Promise<void> {
  if (!incoming.length) return;
  const keys = await getProviderKeys(env, providerId);
  const byId = new Map(keys.map((k) => [k.id, k]));
  for (const k of incoming) byId.set(k.id, k);
  await setProviderKeys(env, providerId, Array.from(byId.values()));
}

export async function deleteProviderKey(env: any, providerId: string, keyId: string): Promise<void> {
  const keys = await getProviderKeys(env, providerId);
  const filtered = keys.filter((k) => k.id !== keyId && k.keyFingerprint !== keyId);
  await setProviderKeys(env, providerId, filtered);
}

export async function updateProviderKeyStatus(env: any, providerId: string, keyId: string, status: "active" | "disabled"): Promise<void> {
  const keys = await getProviderKeys(env, providerId);
  const idx = keys.findIndex((k) => k.id === keyId || k.keyFingerprint === keyId);
  if (idx >= 0) {
    const next = keys.slice();
    next[idx] = { ...next[idx], status };
    await setProviderKeys(env, providerId, next);
  }
}

// ==========================================
// 6. 模型与路由 (Models & Pricing)
// ==========================================

export async function getModels(env: any): Promise<ModelRouteRecord[]> {
  await ensureFreeChannelsSeeded(env);
  return modelsCache.get("all", async () => {
    const store = getBlobStore(env);
    let list = await store.get("models:all", { type: "json", consistency: "strong" });
    if (!list) {
      await seedInitialData(env);
      list = (await store.get("models:all", { type: "json", consistency: "strong" })) || [];
    }
    return list;
  });
}

export async function setModels(env: any, list: ModelRouteRecord[]): Promise<void> {
  const store = getBlobStore(env);
  await store.setJSON("models:all", list);
  modelsCache.set("all", list);
}

export async function upsertModel(env: any, model: ModelRouteRecord): Promise<void> {
  const list = await getModels(env);
  const idx = list.findIndex((m) => m.id === model.id);
  if (idx >= 0) {
    const prev = list[idx];
    list[idx] = {
      ...prev,
      ...model,
      providerId: model.providerId || prev.providerId,
      publicName: model.publicName || prev.publicName,
      upstreamModel: model.upstreamModel || prev.upstreamModel,
    };
  } else {
    list.push(model);
  }
  await setModels(env, list);
}

export async function getAllPricing(env: any): Promise<Record<string, ModelPricingRecord>> {
  return pricingCache.get("all", async () => {
    const store = getBlobStore(env);
    let map = await store.get("pricing:all", { type: "json", consistency: "strong" });
    if (!map) {
      await seedInitialData(env);
      map = (await store.get("pricing:all", { type: "json", consistency: "strong" })) || {};
    }
    return map;
  });
}

export async function setPricing(env: any, pricing: ModelPricingRecord): Promise<void> {
  const store = getBlobStore(env);
  const map = await getAllPricing(env);
  const next = { ...map, [pricing.publicName]: pricing };
  await store.setJSON("pricing:all", next);
  pricingCache.set("all", next);
}

// ==========================================
// 7. 钱包与记账 (Balances & Ledger)
// ==========================================

/**
 * 钱包写穿透缓存：
 *  - 首次读取后常驻内存，冻结/扣费在内存里原子完成（同一实例内不会丢更新）
 *  - 落库 800ms 防抖合并，一次对话原本 2~6 次余额写变成一次
 *  - 空闲 60s 后后台对齐远端，避免长期实例余额过旧
 */
type BalanceEntry = {
  bal: BalanceRecord;
  at: number;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
  writing: boolean;
};
const balanceCache = new Map<string, BalanceEntry>();
const balanceLoads = new Map<string, Promise<BalanceRecord>>();
const BALANCE_REFRESH_MS = 30_000;
const BALANCE_WRITE_DELAY_MS = 800;

function balanceStoreKey(scope: string): string {
  return `balance:${scope}`;
}

export async function getOrCreateBalance(env: any, scope: string): Promise<BalanceRecord> {
  const cached = balanceCache.get(scope);
  if (cached) {
    if (!cached.dirty && !cached.writing && Date.now() - cached.at > BALANCE_REFRESH_MS) {
      void refreshBalanceFromRemote(env, scope, cached);
    }
    return cached.bal;
  }

  const pending = balanceLoads.get(scope);
  if (pending) return pending;

  const load = (async () => {
    const store = getBlobStore(env);
    const b = await store.get(balanceStoreKey(scope), { type: "json", consistency: "strong" });
    if (b) {
      balanceCache.set(scope, { bal: b, at: Date.now(), dirty: false, writing: false });
      return b as BalanceRecord;
    }
    const initial: BalanceRecord = {
      id: uuid(),
      scope,
      available: 0,
      frozen: 0,
      currency: "CNY",
      updatedAt: Math.floor(Date.now() / 1000),
    };
    balanceCache.set(scope, { bal: initial, at: Date.now(), dirty: true, writing: false });
    scheduleBalancePersist(env, scope);
    return initial;
  })();

  balanceLoads.set(scope, load);
  try {
    return await load;
  } finally {
    balanceLoads.delete(scope);
  }
}

async function refreshBalanceFromRemote(env: any, scope: string, entry: BalanceEntry): Promise<void> {
  if (entry.writing || entry.dirty) return;
  try {
    const store = getBlobStore(env);
    const fresh = (await store.get(balanceStoreKey(scope), { type: "json", consistency: "strong" })) as BalanceRecord | null;
    if (!fresh || entry.dirty) return;
    entry.bal.available = fresh.available;
    entry.bal.frozen = fresh.frozen;
    entry.bal.currency = fresh.currency;
    entry.at = Date.now();
  } catch {
    // 后台刷新失败不影响请求
  }
}

/** 标记余额变更并合并落库（热路径调用，不阻塞） */
export async function updateBalance(env: any, scope: string, balance: BalanceRecord): Promise<void> {
  const entry = balanceCache.get(scope);
  balance.updatedAt = Math.floor(Date.now() / 1000);
  if (entry) {
    entry.bal = balance;
    entry.dirty = true;
  } else {
    balanceCache.set(scope, { bal: balance, at: Date.now(), dirty: true, writing: false });
  }
  scheduleBalancePersist(env, scope);
}

/** 立即落库（充值/管理操作需要跨实例立刻可见） */
export async function persistBalanceNow(env: any, scope: string, balance: BalanceRecord): Promise<void> {
  const entry = balanceCache.get(scope);
  balance.updatedAt = Math.floor(Date.now() / 1000);
  if (entry) {
    entry.bal = balance;
    entry.dirty = false;
  } else {
    balanceCache.set(scope, { bal: balance, at: Date.now(), dirty: false, writing: false });
  }
  await getBlobStore(env).setJSON(balanceStoreKey(scope), { ...balance });
  const e = balanceCache.get(scope);
  if (e) e.at = Date.now();
}

function scheduleBalancePersist(env: any, scope: string): void {
  const entry = balanceCache.get(scope);
  if (!entry || entry.timer || entry.writing) return;
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    void persistBalance(env, scope);
  }, BALANCE_WRITE_DELAY_MS);
}

async function persistBalance(env: any, scope: string): Promise<void> {
  const entry = balanceCache.get(scope);
  if (!entry || !entry.dirty || entry.writing) return;
  entry.dirty = false;
  entry.writing = true;
  try {
    await getBlobStore(env).setJSON(balanceStoreKey(scope), { ...entry.bal });
    entry.at = Date.now();
  } catch {
    entry.dirty = true;
  } finally {
    entry.writing = false;
    if (entry.dirty) scheduleBalancePersist(env, scope);
  }
}

/** 热路径账本写入：进内存缓冲，随用量一起批量落库 */
export function appendLedgerEntryBuffered(env: any, entry: LedgerEntryRecord): void {
  enqueueLedgerWrite(env, entry);
}

export async function appendLedgerEntry(env: any, entry: LedgerEntryRecord): Promise<void> {
  const store = getBlobStore(env);
  const list: LedgerEntryRecord[] = (await store.get(`ledger:${entry.scope}`, { type: "json", consistency: "strong" })) || [];
  list.unshift(entry);
  if (list.length > 500) list.length = 500; // 保留最新 500 条
  await store.setJSON(`ledger:${entry.scope}`, list);
}

export async function getLedgerEntries(env: any, scope: string, limit = 50): Promise<LedgerEntryRecord[]> {
  const store = getBlobStore(env);
  const list: LedgerEntryRecord[] = (await store.get(`ledger:${scope}`, { type: "json", consistency: "strong" })) || [];
  const pending = pendingLedgerEntries(scope);
  if (!pending.length) return list.slice(0, limit);
  const seen = new Set<string>();
  const merged: LedgerEntryRecord[] = [];
  for (const e of [...pending, ...list]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    merged.push(e);
    if (merged.length >= limit) break;
  }
  return merged;
}

// ==========================================
// 7.5. 卡密兑换与管理 (Redeem Codes)
// ==========================================

export async function getRedeemCodes(env: any): Promise<RedeemCodeRecord[]> {
  const store = getBlobStore(env);
  return (await store.get("redeem_codes:all", { type: "json", consistency: "strong" })) || [];
}

export async function saveRedeemCodes(env: any, list: RedeemCodeRecord[]): Promise<void> {
  const store = getBlobStore(env);
  await store.setJSON("redeem_codes:all", list);
}

export async function deleteRedeemCode(env: any, codeId: string): Promise<void> {
  const list = await getRedeemCodes(env);
  const filtered = list.filter((c) => c.id !== codeId && c.code !== codeId);
  await saveRedeemCodes(env, filtered);
}

export async function redeemCodeAtomic(
  env: any,
  rawCode: string,
  userId: string,
  userEmail: string
): Promise<RedeemCodeRecord> {
  const cleanCode = rawCode.trim().toUpperCase();
  const list = await getRedeemCodes(env);
  const target = list.find((c) => c.code.toUpperCase() === cleanCode);
  if (!target) {
    throw new ApiError(404, ErrorCode.NOT_FOUND, "卡密兑换码不存在，请仔细核对");
  }
  if (target.status === "used") {
    throw new ApiError(400, ErrorCode.BAD_REQUEST, "该卡密已被使用，无法重复兑换");
  }
  if (target.status === "revoked") {
    throw new ApiError(400, ErrorCode.BAD_REQUEST, "该卡密已作废");
  }

  const now = Math.floor(Date.now() / 1000);
  target.status = "used";
  target.usedByUserId = userId;
  target.usedByEmail = userEmail;
  target.usedAt = now;

  await saveRedeemCodes(env, list);
  return target;
}

// ==========================================
// 8. 用量日志与聚合统计 (Usage Logs)
// ==========================================

/**
 * 热路径写入：只做内存聚合，600ms 窗口内合并成一轮并行写，不阻塞对话响应。
 * 读取接口会叠加尚未落库的缓冲数据，后台立刻能看到刚产生的用量。
 */
export async function addUsageRecord(env: any, record: UsageRecord): Promise<void> {
  enqueueUsageWrite(env, record);
}

export async function getDailyUsage(env: any, date: string): Promise<DailyUsageSummary | null> {
  const store = getBlobStore(env);
  const raw = (await store.get(`usage:daily:${date}`, { type: "json", consistency: "strong" })) as DailyUsageSummary | null;
  const delta = pendingDailyDelta(date);
  if (!delta) return raw;
  const base: DailyUsageSummary = raw || {
    date,
    requests: 0,
    successRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalCostUsd: 0,
    totalLatencyMs: 0,
    byModel: {},
    byProvider: {},
  };
  return mergeUsageDeltaInto(base, delta);
}

export async function getUserUsageRecords(env: any, userId: string, date: string): Promise<UsageRecord[]> {
  const store = getBlobStore(env);
  const stored: UsageRecord[] = (await store.get(`usage:user:${userId}:${date}`, { type: "json", consistency: "strong" })) || [];
  const pending = pendingUsageRecords(userId, date);
  if (!pending.length) return stored;
  const seen = new Set(pending.map((r) => r.requestId));
  return pending.concat(stored.filter((r) => !seen.has(r.requestId)));
}

/** 最近用量记录（含内存缓冲），供后台用量日志使用 */
export async function getRecentUsageRecords(env: any): Promise<UsageRecord[]> {
  const store = getBlobStore(env);
  const stored: UsageRecord[] = (await store.get("usage:recent", { type: "json", consistency: "strong" })) || [];
  const pending = pendingUsageRecords();
  if (!pending.length) return stored;
  const seen = new Set(pending.map((r) => r.requestId));
  return pending.concat(stored.filter((r) => !seen.has(r.requestId)));
}

/** 立即把缓冲的用量/账本落库（备份、退出前检查等场景） */
export async function flushUsageWrites(env: any): Promise<void> {
  await flushWriteBehind(env);
}

// ==========================================
// 9. 哈希链防篡改审计日志 (Audit Logs)
// ==========================================

const AUDIT_GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

/** 审计链进程内缓存：管理操作原本每次都要读整条链（可能 1000 条）+ 写回 */
let auditChainCache: AuditLogRecord[] | null = null;
let auditChainLoad: Promise<AuditLogRecord[]> | null = null;

async function loadAuditChain(env: any): Promise<AuditLogRecord[]> {
  if (auditChainCache) return auditChainCache;
  if (!auditChainLoad) {
    auditChainLoad = (async () => {
      const store = getBlobStore(env);
      const chain: AuditLogRecord[] = (await store.get("audit:chain", { type: "json", consistency: "strong" })) || [];
      auditChainCache = chain;
      return chain;
    })().finally(() => {
      auditChainLoad = null;
    });
  }
  return auditChainLoad;
}

/** 从最旧一条开始向新一条推进，重算整条链的 prevHash 与 hash */
async function rebuildAuditChain(chain: AuditLogRecord[]): Promise<AuditLogRecord[]> {
  let prevHash = AUDIT_GENESIS_HASH;
  const rebuilt = chain.slice();
  for (let i = rebuilt.length - 1; i >= 0; i--) {
    const metaStr = rebuilt[i].meta || "";
    const hash = await sha256Hex(`${prevHash}|${rebuilt[i].id}|${rebuilt[i].action}|${metaStr}|${rebuilt[i].createdAt}`);
    rebuilt[i] = { ...rebuilt[i], prevHash, hash };
    prevHash = hash;
  }
  return rebuilt;
}

/** 删除单条审计日志并重建哈希链，返回剩余条数 */
export async function deleteAuditLog(env: any, id: string): Promise<number> {
  const store = getBlobStore(env);
  const chain = await loadAuditChain(env);
  const filtered = chain.filter((l) => l.id !== id);
  if (filtered.length === chain.length) return chain.length;
  const rebuilt = await rebuildAuditChain(filtered);
  await store.setJSON("audit:chain", rebuilt);
  auditChainCache = rebuilt;
  return rebuilt.length;
}

/** 清空全部审计日志（下一次写入将从 GENESIS 重新开始） */
export async function clearAuditLogs(env: any): Promise<void> {
  const store = getBlobStore(env);
  await store.setJSON("audit:chain", []);
  auditChainCache = [];
}

/**
 * 按后台配置的保留天数裁剪最旧的审计日志。
 * 只从链尾（最旧一端）删除，保留段内的 prevHash 链接关系不受影响。
 */
async function trimAuditChainByRetention(env: any, chain: AuditLogRecord[]): Promise<AuditLogRecord[]> {
  if (chain.length === 0) return chain;
  const settings = await getSettings(env);
  const days = clampAuditRetentionDays(settings.auditLogRetentionDays);
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  let keep = chain.length;
  while (keep > 0 && chain[keep - 1].createdAt < cutoff) keep--;
  return keep === chain.length ? chain : chain.slice(0, keep);
}

export async function appendAuditLog(
  env: any,
  data: {
    actorUserId?: string | null;
    actorIp?: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    meta?: any;
  }
): Promise<AuditLogRecord> {
  const store = getBlobStore(env);
  const cached = await loadAuditChain(env);
  const chain = cached.slice();
  const prev = chain.length > 0 ? chain[0] : null;
  const prevHash = prev ? prev.hash : AUDIT_GENESIS_HASH;

  const id = uuid();
  const createdAt = Math.floor(Date.now() / 1000);
  const metaStr = data.meta ? JSON.stringify(data.meta) : "";

  // 密码学哈希链：hash = SHA-256(prevHash | id | action | meta | ts)
  const hashMaterial = `${prevHash}|${id}|${data.action}|${metaStr}|${createdAt}`;
  const hash = await sha256Hex(hashMaterial);

  const log: AuditLogRecord = {
    id,
    actorUserId: data.actorUserId,
    actorIp: data.actorIp,
    action: data.action,
    targetType: data.targetType,
    targetId: data.targetId,
    meta: metaStr || null,
    prevHash,
    hash,
    createdAt,
  };

  chain.unshift(log);
  const retained = await trimAuditChainByRetention(env, chain);
  if (retained.length > 1000) retained.length = 1000;
  await store.setJSON("audit:chain", retained);
  auditChainCache = retained;
  return log;
}

export async function getAuditLogs(env: any, limit = 100): Promise<AuditLogRecord[]> {
  const store = getBlobStore(env);
  const raw = await loadAuditChain(env);
  const chain = await trimAuditChainByRetention(env, raw);
  if (chain !== raw) {
    await store.setJSON("audit:chain", chain);
    auditChainCache = chain;
  }
  return chain.slice(0, limit);
}

export async function verifyAuditChain(env: any): Promise<{ valid: boolean; total: number; brokenAt?: string }> {
  const logs = await getAuditLogs(env, 1000);
  if (logs.length <= 1) return { valid: true, total: logs.length };

  for (let i = 0; i < logs.length - 1; i++) {
    const cur = logs[i];
    const prev = logs[i + 1];
    if (cur.prevHash !== prev.hash) {
      return { valid: false, total: logs.length, brokenAt: cur.id };
    }
    const metaStr = cur.meta || "";
    const expected = await sha256Hex(`${cur.prevHash}|${cur.id}|${cur.action}|${metaStr}|${cur.createdAt}`);
    if (cur.hash !== expected) {
      return { valid: false, total: logs.length, brokenAt: cur.id };
    }
  }
  return { valid: true, total: logs.length };
}

// ==========================================
// 10. 申诉与审核标记 (Appeals & ContentFlags)
// ==========================================

export async function appendContentFlag(env: any, flag: ContentFlagRecord): Promise<void> {
  const store = getBlobStore(env);
  const list: ContentFlagRecord[] = (await store.get("content_flags:all", { type: "json", consistency: "strong" })) || [];
  list.unshift(flag);
  if (list.length > 500) list.length = 500;
  await store.setJSON("content_flags:all", list);
}

export async function getContentFlags(env: any): Promise<ContentFlagRecord[]> {
  const store = getBlobStore(env);
  return (await store.get("content_flags:all", { type: "json", consistency: "strong" })) || [];
}

export async function appendAppeal(env: any, appeal: AppealRecord): Promise<void> {
  const store = getBlobStore(env);
  const list: AppealRecord[] = (await store.get("appeals:all", { type: "json", consistency: "strong" })) || [];
  list.unshift(appeal);
  if (list.length > 500) list.length = 500;
  await store.setJSON("appeals:all", list);
}

export async function getAppeals(env: any): Promise<AppealRecord[]> {
  const store = getBlobStore(env);
  return (await store.get("appeals:all", { type: "json", consistency: "strong" })) || [];
}

export async function deleteModel(env: any, modelId: string): Promise<void> {
  const models = await getModels(env);
  const filtered = models.filter((m) => m.id !== modelId);
  await setModels(env, filtered);
}

export async function deleteProvider(env: any, providerId: string): Promise<void> {
  const providers = await getProviders(env);
  const filtered = providers.filter((p) => p.id !== providerId);
  await setProviders(env, filtered);
}

export interface AnnouncementRecord {
  id: string;
  title: string;
  content: string;
  popup: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export async function getAnnouncements(env: any): Promise<AnnouncementRecord[]> {
  return announcementCache.get("all", async () => {
    const store = getBlobStore(env);
    const existing = (await store.get("announcements:all", { type: "json", consistency: "strong" })) as AnnouncementRecord[] | null;
    if (existing) return existing;
    // 首次读取时把欢迎公告落库，避免兜底数据的创建时间每次请求都变成"刚刚"
    const now = Math.floor(Date.now() / 1000);
    const seeded: AnnouncementRecord[] = [
      {
        id: "anno_welcome",
        title: "欢迎使用 Relay AI API 边缘网关",
        content: "系统已成功迁移并运行于腾讯云 EdgeOne Pages + Blob 强一致性数据库。",
        popup: 0,
        enabled: 1,
        created_at: now,
        updated_at: now,
      },
    ];
    await store.setJSON("announcements:all", seeded);
    return seeded;
  });
}

export async function saveAnnouncements(env: any, list: AnnouncementRecord[]): Promise<void> {
  const store = getBlobStore(env);
  await store.setJSON("announcements:all", list);
  announcementCache.set("all", list);
}

// ==========================================
// 11. 初始引导数据 Seed
// ==========================================

export async function seedInitialData(env: any): Promise<void> {
  const store = getBlobStore(env);
  const now = Math.floor(Date.now() / 1000);

  // 1. 默认 Providers
  const initialProviders: ProviderRecord[] = [
    {
      id: "openai",
      name: "OpenAI",
      slug: "openai",
      kind: "openai_compat",
      baseUrl: "https://api.openai.com",
      authScheme: "bearer",
      status: "active",
      authorizationRef: "AUTH-OPENAI-OFFICIAL-2026",
      createdAt: now,
    },
    {
      id: "anthropic",
      name: "Anthropic",
      slug: "anthropic",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      authScheme: "x-api-key",
      extraHeaders: JSON.stringify({ "anthropic-version": "2023-06-01", "content-type": "application/json" }),
      status: "active",
      authorizationRef: "AUTH-ANTHROPIC-OFFICIAL-2026",
      createdAt: now,
    },
    {
      id: "google",
      name: "Google",
      slug: "google",
      kind: "openai_compat",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      authScheme: "bearer",
      status: "active",
      authorizationRef: "AUTH-GOOGLE-OFFICIAL-2026",
      createdAt: now,
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      slug: "deepseek",
      kind: "openai_compat",
      baseUrl: "https://api.deepseek.com",
      authScheme: "bearer",
      status: "active",
      authorizationRef: "AUTH-DEEPSEEK-OFFICIAL-2026",
      createdAt: now,
    },
    {
      id: "opencode",
      name: "OpenCode",
      slug: "opencode",
      kind: "opencode",
      baseUrl: "https://opencode.ai/zen/v1",
      authScheme: "none",
      status: "active",
      authorizationRef: "AUTH-OPENCODE-FREE-2026",
      createdAt: now,
    },
    {
      id: "duckai",
      name: "Duck.ai",
      slug: "duckai",
      kind: "duckai",
      baseUrl: "https://duck.ai",
      authScheme: "none",
      status: "active",
      authorizationRef: "AUTH-DUCKAI-FREE-2026",
      createdAt: now,
    },
  ];

  // 2. 默认 Models
  const initialModels: ModelRouteRecord[] = [
    { id: "m_gpt4o_1", publicName: "gpt-4o", providerId: "openai", upstreamModel: "gpt-4o", priority: 10, costWeight: 1.0, maxContext: 128000, enabled: 1, createdAt: now },
    { id: "m_gpt4o_mini", publicName: "gpt-4o-mini", providerId: "openai", upstreamModel: "gpt-4o-mini", priority: 10, costWeight: 1.0, maxContext: 128000, enabled: 1, createdAt: now },
    { id: "m_sonnet_1", publicName: "claude-sonnet", providerId: "anthropic", upstreamModel: "claude-sonnet-4-5", priority: 10, costWeight: 1.0, maxContext: 200000, enabled: 1, createdAt: now },
    { id: "m_gemini_1", publicName: "gemini-flash", providerId: "google", upstreamModel: "gemini-2.0-flash", priority: 10, costWeight: 1.0, maxContext: 1000000, enabled: 1, createdAt: now },
    { id: "m_deepseek_1", publicName: "deepseek-chat", providerId: "deepseek", upstreamModel: "deepseek-chat", priority: 10, costWeight: 1.0, maxContext: 64000, enabled: 1, createdAt: now },
    { id: "m_deepseek_2", publicName: "deepseek-reasoner", providerId: "deepseek", upstreamModel: "deepseek-reasoner", priority: 10, costWeight: 1.0, maxContext: 64000, enabled: 1, createdAt: now },
  ];

  // 3. 默认 Pricing
  const initialPricing: Record<string, ModelPricingRecord> = {
    "gpt-4o": { id: "pr_1", publicName: "gpt-4o", inputPerMillion: 17.0, outputPerMillion: 68.0, currency: "CNY", createdAt: now },
    "gpt-4o-mini": { id: "pr_2", publicName: "gpt-4o-mini", inputPerMillion: 1.0, outputPerMillion: 4.0, currency: "CNY", createdAt: now },
    "claude-sonnet": { id: "pr_3", publicName: "claude-sonnet", inputPerMillion: 21.0, outputPerMillion: 105.0, currency: "CNY", createdAt: now },
    "gemini-flash": { id: "pr_4", publicName: "gemini-flash", inputPerMillion: 1.0, outputPerMillion: 4.0, currency: "CNY", createdAt: now },
    "deepseek-chat": { id: "pr_5", publicName: "deepseek-chat", inputPerMillion: 1.0, outputPerMillion: 4.0, currency: "CNY", createdAt: now },
    "deepseek-reasoner": { id: "pr_6", publicName: "deepseek-reasoner", inputPerMillion: 3.0, outputPerMillion: 12.0, currency: "CNY", createdAt: now },
  };

  const existingProviders = await store.get("providers:all", { type: "json", consistency: "strong" });
  if (!existingProviders) {
    await store.setJSON("providers:all", initialProviders);
  }
  const existingModels = await store.get("models:all", { type: "json", consistency: "strong" });
  if (!existingModels) {
    await store.setJSON("models:all", initialModels);
  }
  const existingPricing = await store.get("pricing:all", { type: "json", consistency: "strong" });
  if (!existingPricing) {
    await store.setJSON("pricing:all", initialPricing);
  }
}
