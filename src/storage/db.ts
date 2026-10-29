/**
 * EdgeRelay 数据访问层（基于 EdgeOne Blob 数据库）
 *
 * 运行环境结论（2026-10 实测）：EdgeOne 云函数**每次请求都是全新进程**（无 waitUntil、
 * 实例不复用），因此：
 *  - 进程内缓存只在单个请求内去重（同键多次读只走一次 I/O）
 *  - 所有写入必须在请求生命周期内 await 完成，绝不能依赖后台定时器
 *  - settings/providers/models/pricing 合并为单键 config:all，一次读取替代四次
 */
import { getBlobStore } from "./blob-store";
export { getBlobStore };
import { TtlCache, mapLimit } from "./cache";
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

/** 请求内 TTL 缓存：同一请求内同键只读一次 Blob */
const apiKeyCache = new TtlCache<ApiKeyRecord | null>(30_000, 5000);
const userCache = new TtlCache<UserRecord | null>(30_000, 2000);
const sessionCache = new TtlCache<SessionRecord | null>(30_000, 2000);
const providerKeysCache = new TtlCache<ProviderKeyRecord[]>(30_000, 200);
const announcementCache = new TtlCache<AnnouncementRecord[]>(30_000, 2);
const configCache = new TtlCache<ConfigSnapshot>(30_000, 2);

/** keyId -> keyHash 二级索引，避免按 id 反查时全表扫 Key */
const apiKeyIdIndex = new Map<string, string>();

/** 备份导入/恢复后清空进程内缓存，保证立即读取恢复后的 Blob 数据 */
export function invalidateStorageCaches(): void {
  configCache.clear();
  apiKeyCache.clear();
  userCache.clear();
  sessionCache.clear();
  providerKeysCache.clear();
  announcementCache.clear();
  apiKeyIdIndex.clear();
  apiKeyDirty.clear();
  balanceCache.clear();
  auditChainCache = null;
}

// ==========================================
// 1. 全局配置快照 (Config Snapshot)
//    settings + providers + models + pricing 合并为单键，热路径一次读取
// ==========================================

export type ConfigSnapshot = {
  settings: PlatformSettings;
  providers: ProviderRecord[];
  models: ModelRouteRecord[];
  pricing: Record<string, ModelPricingRecord>;
};

async function loadConfigSnapshot(env: any): Promise<ConfigSnapshot> {
  return configCache.get("snapshot", async () => {
    const store = getBlobStore(env);
    const snap = (await store.get("config:all", { type: "json", consistency: "strong" })) as Partial<ConfigSnapshot> | null;
    if (
      snap?.settings &&
      Array.isArray(snap.providers) &&
      Array.isArray(snap.models) &&
      snap.pricing &&
      typeof snap.pricing === "object"
    ) {
      snap.settings.auditLogRetentionDays = clampAuditRetentionDays(snap.settings.auditLogRetentionDays);
      return snap as ConfigSnapshot;
    }

    // 首次（或旧版本遗留）：从独立键并发重建快照并写回，之后热路径只需读单键
    const [rawSettings, rawProviders, rawModels, rawPricing] = await Promise.all([
      store.get("settings:platform", { type: "json", consistency: "strong" }),
      store.get("providers:all", { type: "json", consistency: "strong" }),
      store.get("models:all", { type: "json", consistency: "strong" }),
      store.get("pricing:all", { type: "json", consistency: "strong" }),
    ]);
    if (!rawProviders || !rawModels || !rawPricing) {
      await seedInitialData(env);
    }
    const [, providers2, models2, pricing2] = await Promise.all([
      store.get("settings:platform", { type: "json", consistency: "strong" }),
      store.get("providers:all", { type: "json", consistency: "strong" }),
      store.get("models:all", { type: "json", consistency: "strong" }),
      store.get("pricing:all", { type: "json", consistency: "strong" }),
    ]);
    const mergedSettings: PlatformSettings = { ...DEFAULT_SETTINGS, ...(rawSettings || {}) };
    mergedSettings.auditLogRetentionDays = clampAuditRetentionDays(mergedSettings.auditLogRetentionDays);
    const built: ConfigSnapshot = {
      settings: mergedSettings,
      providers: (providers2 || []) as ProviderRecord[],
      models: (models2 || []) as ModelRouteRecord[],
      pricing: ((pricing2 || {}) as Record<string, ModelPricingRecord>),
    };
    await store.setJSON("config:all", built);
    return built;
  });
}

/** 把补丁写回 config:all（同时保持独立遗留键同步，便于回滚旧版本代码） */
async function saveConfigSnapshot(
  env: any,
  patch: Partial<ConfigSnapshot>
): Promise<ConfigSnapshot> {
  const store = getBlobStore(env);
  const cur = await loadConfigSnapshot(env);
  const next: ConfigSnapshot = { ...cur, ...patch };
  await store.setJSON("config:all", next);
  configCache.set("snapshot", next);
  // 同步遗留键（备份/旧版兼容）
  const jobs: Promise<unknown>[] = [];
  if (patch.settings) jobs.push(store.setJSON("settings:platform", patch.settings));
  if (patch.providers) jobs.push(store.setJSON("providers:all", patch.providers));
  if (patch.models) jobs.push(store.setJSON("models:all", patch.models));
  if (patch.pricing) jobs.push(store.setJSON("pricing:all", patch.pricing));
  await Promise.all(jobs);
  return next;
}

export async function getSettings(env?: any): Promise<PlatformSettings> {
  return (await loadConfigSnapshot(env)).settings;
}

export async function updateSettings(env: any, patch: Partial<PlatformSettings>): Promise<PlatformSettings> {
  const cur = await getSettings(env);
  const updated: PlatformSettings = { ...cur, ...patch };
  updated.auditLogRetentionDays = clampAuditRetentionDays(updated.auditLogRetentionDays);
  await saveConfigSnapshot(env, { settings: updated });
  return updated;
}

export async function getProviders(env: any): Promise<ProviderRecord[]> {
  return (await loadConfigSnapshot(env)).providers;
}

export async function setProviders(env: any, list: ProviderRecord[]): Promise<void> {
  await saveConfigSnapshot(env, { providers: list });
}

export async function upsertProvider(env: any, provider: ProviderRecord): Promise<void> {
  const list = await getProviders(env);
  const idx = list.findIndex((p) => p.id === provider.id);
  const next = list.slice();
  if (idx >= 0) {
    next[idx] = provider;
  } else {
    next.push(provider);
  }
  await setProviders(env, next);
}

export async function deleteProvider(env: any, providerId: string): Promise<void> {
  const providers = await getProviders(env);
  await setProviders(
    env,
    providers.filter((p) => p.id !== providerId)
  );
}

export async function getModels(env: any): Promise<ModelRouteRecord[]> {
  return (await loadConfigSnapshot(env)).models;
}

export async function setModels(env: any, list: ModelRouteRecord[]): Promise<void> {
  await saveConfigSnapshot(env, { models: list });
}

export async function upsertModel(env: any, model: ModelRouteRecord): Promise<void> {
  const list = await getModels(env);
  const idx = list.findIndex((m) => m.id === model.id);
  const next = list.slice();
  if (idx >= 0) {
    const prev = list[idx]!;
    next[idx] = {
      ...prev,
      ...model,
      providerId: model.providerId || prev.providerId,
      publicName: model.publicName || prev.publicName,
      upstreamModel: model.upstreamModel || prev.upstreamModel,
    };
  } else {
    next.push(model);
  }
  await setModels(env, next);
}

export async function deleteModel(env: any, modelId: string): Promise<void> {
  const models = await getModels(env);
  await setModels(
    env,
    models.filter((m) => m.id !== modelId)
  );
}

export async function getAllPricing(env: any): Promise<Record<string, ModelPricingRecord>> {
  return (await loadConfigSnapshot(env)).pricing;
}

export async function setPricing(env: any, pricing: ModelPricingRecord): Promise<void> {
  const map = await getAllPricing(env);
  await saveConfigSnapshot(env, { pricing: { ...map, [pricing.publicName]: pricing } });
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

export async function getApiKeyById(env: any, keyId: string): Promise<ApiKeyRecord | null> {
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
  const cur = await getApiKeyByHash(env, keyHash);
  if (!cur) return null;
  const updated: ApiKeyRecord = { ...cur, ...updates };
  await store.setJSON(`key:${keyHash}`, updated);
  apiKeyCache.set(keyHash, updated);
  apiKeyIdIndex.set(updated.id, keyHash);
  return updated;
}

/**
 * 热路径专用：在请求内内存里更新 Key 的 lastUsedAt / spentUsd，标记为待写。
 * 对话收尾时由 commitApiKeyUsage 随用量一起批量落库（同一轮并行写）。
 */
const apiKeyDirty = new Set<string>();

export function touchApiKeyUsage(env: any, keyId: string, patch: { lastUsedAt?: number; spentDelta?: number }): void {
  const hash = apiKeyIdIndex.get(keyId);
  if (!hash) return;
  const rec = apiKeyCache.peek(hash);
  if (!rec) return;
  if (patch.lastUsedAt) rec.lastUsedAt = patch.lastUsedAt;
  if (patch.spentDelta) rec.spentUsd = (rec.spentUsd || 0) + patch.spentDelta;
  apiKeyDirty.add(hash);
}

/** 把本请求内变更过的 Key 记录批量落库（必须 await，进程生命周期内完成） */
export async function commitApiKeyUsage(env: any): Promise<void> {
  if (apiKeyDirty.size === 0) return;
  const hashes = Array.from(apiKeyDirty);
  apiKeyDirty.clear();
  const store = getBlobStore(env);
  await Promise.all(
    hashes.map(async (hash) => {
      const rec = apiKeyCache.peek(hash);
      if (rec) await store.setJSON(`key:${hash}`, { ...rec });
    })
  );
}

// ==========================================
// 5. 供应商与密钥 (Providers & Keys)
// ==========================================

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
    next[idx] = { ...next[idx]!, status };
    await setProviderKeys(env, providerId, next);
  }
}

// ==========================================
// 6. 钱包与记账 (Balances & Ledger)
// ==========================================

/** 请求内余额缓存：同一请求内重复读只走一次 I/O；任何变更立即落库 */
const balanceCache = new Map<string, BalanceRecord>();
const balanceLoads = new Map<string, Promise<BalanceRecord>>();

export async function getOrCreateBalance(env: any, scope: string): Promise<BalanceRecord> {
  const cached = balanceCache.get(scope);
  if (cached) return cached;
  const pending = balanceLoads.get(scope);
  if (pending) return pending;

  const load = (async () => {
    const store = getBlobStore(env);
    const b = (await store.get(`balance:${scope}`, { type: "json", consistency: "strong" })) as BalanceRecord | null;
    if (!b) {
      const initial: BalanceRecord = {
        id: uuid(),
        scope,
        available: 0,
        frozen: 0,
        currency: "CNY",
        updatedAt: Math.floor(Date.now() / 1000),
      };
      await store.setJSON(`balance:${scope}`, initial);
      balanceCache.set(scope, initial);
      return initial;
    }
    balanceCache.set(scope, b);
    return b;
  })();

  balanceLoads.set(scope, load);
  try {
    return await load;
  } finally {
    balanceLoads.delete(scope);
  }
}

/** 立即落库（请求内必须 await，保证余额变更在进程生命周期内持久化） */
export async function updateBalance(env: any, scope: string, balance: BalanceRecord): Promise<void> {
  balance.updatedAt = Math.floor(Date.now() / 1000);
  balanceCache.set(scope, balance);
  await getBlobStore(env).setJSON(`balance:${scope}`, { ...balance });
}

export async function persistBalanceNow(env: any, scope: string, balance: BalanceRecord): Promise<void> {
  await updateBalance(env, scope, balance);
}

/** 批量写入账本：按 scope 分组并发读改写（hold/capture/release 多条一次落盘） */
export async function appendLedgerEntries(env: any, entries: LedgerEntryRecord[]): Promise<void> {
  if (!entries.length) return;
  const store = getBlobStore(env);
  const byScope = new Map<string, LedgerEntryRecord[]>();
  for (const entry of entries) {
    const list = byScope.get(entry.scope) || [];
    list.push(entry);
    byScope.set(entry.scope, list);
  }
  await Promise.all(
    Array.from(byScope.entries()).map(async ([scope, list]) => {
      const key = `ledger:${scope}`;
      const cur: LedgerEntryRecord[] = (await store.get(key, { type: "json", consistency: "strong" })) || [];
      const seen = new Set(cur.map((e) => e.id));
      const fresh = list.filter((e) => !seen.has(e.id));
      const merged = fresh.reverse().concat(cur).slice(0, 500);
      await store.setJSON(key, merged);
    })
  );
}

export async function appendLedgerEntry(env: any, entry: LedgerEntryRecord): Promise<void> {
  await appendLedgerEntries(env, [entry]);
}

export async function getLedgerEntries(env: any, scope: string, limit = 50): Promise<LedgerEntryRecord[]> {
  const store = getBlobStore(env);
  const list: LedgerEntryRecord[] = (await store.get(`ledger:${scope}`, { type: "json", consistency: "strong" })) || [];
  return list.slice(0, limit);
}

// ==========================================
// 7. 卡密兑换与管理 (Redeem Codes)
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
 * 热路径写入：一次性四路并行的「写单条 + 日汇总 + 最近列表 + 用户日列表」，
 * 全部在本请求生命周期内 await 完成（EdgeOne 进程不跨请求复用，不能依赖后台定时器）。
 * 可选携带本请求待提交的 Key 记录（lastUsedAt/spentUsd）一起落库。
 */
export async function addUsageRecord(
  env: any,
  record: UsageRecord,
  extra?: { apiKeyWrite?: { keyHash: string; record: ApiKeyRecord } }
): Promise<void> {
  const store = getBlobStore(env);
  const date = new Date(record.createdAt * 1000).toISOString().slice(0, 10);

  const jobs: Promise<unknown>[] = [
    store.setJSON(`usage:record:${record.requestId}`, record),
    updateDailyUsage(env, store, date, record),
    updateRecentUsage(env, store, record),
    updateUserDailyUsage(env, store, record, date),
  ];
  if (extra?.apiKeyWrite) {
    jobs.push(store.setJSON(`key:${extra.apiKeyWrite.keyHash}`, extra.apiKeyWrite.record));
  }
  await Promise.all(jobs);
}

async function updateDailyUsage(env: any, store: any, date: string, record: UsageRecord): Promise<void> {
  const key = `usage:daily:${date}`;
  const daily: DailyUsageSummary = (await store.get(key, { type: "json", consistency: "strong" })) || {
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

  daily.requests += 1;
  if (record.status === "success") daily.successRequests += 1;
  daily.promptTokens += record.promptTokens || 0;
  daily.completionTokens += record.completionTokens || 0;
  daily.totalCostUsd += record.costUsd || 0;
  daily.totalLatencyMs += record.latencyMs || 0;

  const mName = record.publicModel || "unknown";
  const m = (daily.byModel[mName] = daily.byModel[mName] || { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 });
  m.requests += 1;
  m.promptTokens += record.promptTokens || 0;
  m.completionTokens += record.completionTokens || 0;
  m.costUsd += record.costUsd || 0;

  const pName = record.providerId || "unknown";
  const p = (daily.byProvider[pName] = daily.byProvider[pName] || { requests: 0, promptTokens: 0, completionTokens: 0 });
  p.requests += 1;
  p.promptTokens += record.promptTokens || 0;
  p.completionTokens += record.completionTokens || 0;

  await store.setJSON(key, daily);
}

async function updateRecentUsage(env: any, store: any, record: UsageRecord): Promise<void> {
  const key = "usage:recent";
  const cur: UsageRecord[] = (await store.get(key, { type: "json", consistency: "strong" })) || [];
  // 按 requestId 去重，保证并发/重试写入幂等
  const seen = new Set(cur.map((r) => r.requestId));
  const merged = (seen.has(record.requestId) ? cur.slice() : [record].concat(cur)).slice(0, 200);
  await store.setJSON(key, merged);
}

async function updateUserDailyUsage(env: any, store: any, record: UsageRecord, date: string): Promise<void> {
  const key = `usage:user:${record.userId}:${date}`;
  const cur: UsageRecord[] = (await store.get(key, { type: "json", consistency: "strong" })) || [];
  const seen = new Set(cur.map((r) => r.requestId));
  const merged = (seen.has(record.requestId) ? cur.slice() : [record].concat(cur)).slice(0, 200);
  await store.setJSON(key, merged);
}

export async function getDailyUsage(env: any, date: string): Promise<DailyUsageSummary | null> {
  const store = getBlobStore(env);
  return await store.get(`usage:daily:${date}`, { type: "json", consistency: "strong" });
}

export async function getUserUsageRecords(env: any, userId: string, date: string): Promise<UsageRecord[]> {
  const store = getBlobStore(env);
  return (await store.get(`usage:user:${userId}:${date}`, { type: "json", consistency: "strong" })) || [];
}

/** 最近用量记录，供后台用量日志使用 */
export async function getRecentUsageRecords(env: any): Promise<UsageRecord[]> {
  const store = getBlobStore(env);
  return (await store.get("usage:recent", { type: "json", consistency: "strong" })) || [];
}

// ==========================================
// 9. 哈希链防篡改审计日志 (Audit Logs)
// ==========================================

const AUDIT_GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

/** 审计链请求内缓存：单次管理操作只需读一次整条链 */
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

// ==========================================
// 11. 公告 (Announcements)
// ==========================================

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
// 12. 初始引导数据 Seed
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
