/**
 * EdgeRelay 数据访问层（基于 EdgeOne Blob 数据库）
 */

import { getBlobStore, type BlobStore } from "./blob-store";
export { getBlobStore };
import {
  type PlatformSettings,
  DEFAULT_SETTINGS,
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

// 内存热缓存（优化频繁读取的全局配置和供应商列表，30s TTL）
const CACHE_TTL_MS = 30_000;
let cachedSettings: { val: PlatformSettings; at: number } | null = null;
let cachedProviders: { val: ProviderRecord[]; at: number } | null = null;
let cachedModels: { val: ModelRouteRecord[]; at: number } | null = null;
let cachedPricing: { val: Record<string, ModelPricingRecord>; at: number } | null = null;

// ==========================================
// 1. 全局配置 (Settings)
// ==========================================

export async function getSettings(env?: any): Promise<PlatformSettings> {
  const now = Date.now();
  if (cachedSettings && now - cachedSettings.at < CACHE_TTL_MS) {
    return cachedSettings.val;
  }
  const store = getBlobStore(env);
  const stored = await store.get("settings:platform", { type: "json", consistency: "strong" });
  if (!stored) {
    // 首次启动，保存默认设置
    await store.setJSON("settings:platform", DEFAULT_SETTINGS);
    cachedSettings = { val: DEFAULT_SETTINGS, at: now };
    return DEFAULT_SETTINGS;
  }
  const merged: PlatformSettings = { ...DEFAULT_SETTINGS, ...stored };
  cachedSettings = { val: merged, at: now };
  return merged;
}

export async function updateSettings(env: any, patch: Partial<PlatformSettings>): Promise<PlatformSettings> {
  const store = getBlobStore(env);
  const cur = await getSettings(env);
  const updated: PlatformSettings = { ...cur, ...patch };
  await store.setJSON("settings:platform", updated);
  cachedSettings = { val: updated, at: Date.now() };
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
  const store = getBlobStore(env);
  return await store.get(`user:${id}`, { type: "json", consistency: "strong" });
}

export async function createUser(env: any, user: UserRecord): Promise<UserRecord> {
  const store = getBlobStore(env);
  const norm = user.email.trim().toLowerCase();

  // 检查是否已有用户（如果没有用户，第一位注册者自动赋予 admin 角色）
  const allUsersIdx = (await store.get("idx:users:all", { type: "json", consistency: "strong" })) || [];
  if (allUsersIdx.length === 0) {
    user.role = "admin";
  }

  await store.setJSON(`user:${user.id}`, user);
  await store.setJSON(`idx:user:email:${encodeURIComponent(norm)}`, { userId: user.id });

  allUsersIdx.unshift(user.id);
  await store.setJSON("idx:users:all", allUsersIdx);

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
  return updated;
}

export async function listAllUsers(env: any): Promise<UserRecord[]> {
  const store = getBlobStore(env);
  const allIds: string[] = (await store.get("idx:users:all", { type: "json", consistency: "strong" })) || [];
  const users: UserRecord[] = [];
  for (const id of allIds) {
    const u = await getUserById(env, id);
    if (u) users.push(u);
  }
  return users;
}

// ==========================================
// 3. 用户会话 (Sessions)
// ==========================================

export async function createSession(env: any, session: SessionRecord): Promise<void> {
  const store = getBlobStore(env);
  await store.setJSON(`session:${session.id}`, session);
}

export async function getSession(env: any, id: string): Promise<SessionRecord | null> {
  const store = getBlobStore(env);
  const s = await store.get(`session:${id}`, { type: "json", consistency: "strong" });
  if (!s) return null;
  if (s.expiresAt < Math.floor(Date.now() / 1000)) {
    await store.delete(`session:${id}`).catch(() => {});
    return null;
  }
  return s;
}

export async function deleteSession(env: any, id: string): Promise<void> {
  const store = getBlobStore(env);
  await store.delete(`session:${id}`).catch(() => {});
}

// ==========================================
// 4. API 密钥 (API Keys)
// ==========================================

export async function getApiKeyByHash(env: any, keyHash: string): Promise<ApiKeyRecord | null> {
  const store = getBlobStore(env);
  return await store.get(`key:${keyHash}`, { type: "json", consistency: "strong" });
}

export async function createApiKey(env: any, keyRecord: ApiKeyRecord): Promise<ApiKeyRecord> {
  const store = getBlobStore(env);
  await store.setJSON(`key:${keyRecord.keyHash}`, keyRecord);

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
  const list: ApiKeyRecord[] = [];
  for (const h of hashes) {
    const k = await getApiKeyByHash(env, h);
    if (k) list.push(k);
  }
  return list;
}

export async function listAllApiKeys(env: any): Promise<ApiKeyRecord[]> {
  const store = getBlobStore(env);
  const hashes: string[] = (await store.get("idx:keys:all", { type: "json", consistency: "strong" })) || [];
  const list: ApiKeyRecord[] = [];
  for (const h of hashes) {
    const k = await getApiKeyByHash(env, h);
    if (k) list.push(k);
  }
  return list;
}

export async function updateApiKey(env: any, keyHash: string, updates: Partial<ApiKeyRecord>): Promise<ApiKeyRecord | null> {
  const store = getBlobStore(env);
  const cur = await getApiKeyByHash(env, keyHash);
  if (!cur) return null;
  const updated: ApiKeyRecord = { ...cur, ...updates };
  await store.setJSON(`key:${keyHash}`, updated);
  return updated;
}

// ==========================================
// 5. 供应商与密钥 (Providers & Keys)
// ==========================================

let freeChannelsSeeded = false;

export async function ensureFreeChannelsSeeded(env: any): Promise<void> {
  if (freeChannelsSeeded) return;
  const store = getBlobStore(env);
  const now = Math.floor(Date.now() / 1000);

  try {
    let providers = (await store.get("providers:all", { type: "json", consistency: "strong" })) || [];
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
      cachedProviders = { val: providers, at: Date.now() };
    }

    let models = (await store.get("models:all", { type: "json", consistency: "strong" })) || [];
    
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
      cachedModels = { val: models, at: Date.now() };
    }

    let pricing = (await store.get("pricing:all", { type: "json", consistency: "strong" })) || {};
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
      cachedPricing = { val: pricing, at: Date.now() };
    }

    freeChannelsSeeded = true;
  } catch (err: any) {
    console.error("[ensureFreeChannelsSeeded] error:", err?.message);
  }
}

export async function getProviders(env: any): Promise<ProviderRecord[]> {
  await ensureFreeChannelsSeeded(env);
  const now = Date.now();
  if (cachedProviders && now - cachedProviders.at < CACHE_TTL_MS) {
    return cachedProviders.val;
  }
  const store = getBlobStore(env);
  let list = await store.get("providers:all", { type: "json", consistency: "strong" });
  if (!list) {
    await seedInitialData(env);
    list = await store.get("providers:all", { type: "json", consistency: "strong" }) || [];
  }
  cachedProviders = { val: list, at: now };
  return list;
}

export async function setProviders(env: any, list: ProviderRecord[]): Promise<void> {
  const store = getBlobStore(env);
  await store.setJSON("providers:all", list);
  cachedProviders = { val: list, at: Date.now() };
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
  const store = getBlobStore(env);
  return (await store.get(`provider_keys:${providerId}`, { type: "json", consistency: "strong" })) || [];
}

export async function setProviderKeys(env: any, providerId: string, keys: ProviderKeyRecord[]): Promise<void> {
  const store = getBlobStore(env);
  await store.setJSON(`provider_keys:${providerId}`, keys);
}

export async function upsertProviderKey(env: any, key: ProviderKeyRecord): Promise<void> {
  const keys = await getProviderKeys(env, key.providerId);
  const idx = keys.findIndex((k) => k.id === key.id);
  if (idx >= 0) {
    keys[idx] = key;
  } else {
    keys.push(key);
  }
  await setProviderKeys(env, key.providerId, keys);
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
    keys[idx].status = status;
    await setProviderKeys(env, providerId, keys);
  }
}

// ==========================================
// 6. 模型与路由 (Models & Pricing)
// ==========================================

export async function getModels(env: any): Promise<ModelRouteRecord[]> {
  await ensureFreeChannelsSeeded(env);
  const now = Date.now();
  if (cachedModels && now - cachedModels.at < CACHE_TTL_MS) {
    return cachedModels.val;
  }
  const store = getBlobStore(env);
  let list = await store.get("models:all", { type: "json", consistency: "strong" });
  if (!list) {
    await seedInitialData(env);
    list = await store.get("models:all", { type: "json", consistency: "strong" }) || [];
  }
  cachedModels = { val: list, at: now };
  return list;
}

export async function setModels(env: any, list: ModelRouteRecord[]): Promise<void> {
  const store = getBlobStore(env);
  await store.setJSON("models:all", list);
  cachedModels = { val: list, at: Date.now() };
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
  const now = Date.now();
  if (cachedPricing && now - cachedPricing.at < CACHE_TTL_MS) {
    return cachedPricing.val;
  }
  const store = getBlobStore(env);
  let map = await store.get("pricing:all", { type: "json", consistency: "strong" });
  if (!map) {
    await seedInitialData(env);
    map = await store.get("pricing:all", { type: "json", consistency: "strong" }) || {};
  }
  cachedPricing = { val: map, at: now };
  return map;
}

export async function setPricing(env: any, pricing: ModelPricingRecord): Promise<void> {
  const store = getBlobStore(env);
  const map = await getAllPricing(env);
  map[pricing.publicName] = pricing;
  await store.setJSON("pricing:all", map);
  cachedPricing = { val: map, at: Date.now() };
}

// ==========================================
// 7. 钱包与记账 (Balances & Ledger)
// ==========================================

export async function getOrCreateBalance(env: any, scope: string): Promise<BalanceRecord> {
  const store = getBlobStore(env);
  const b = await store.get(`balance:${scope}`, { type: "json", consistency: "strong" });
  if (b) return b;
  const initial: BalanceRecord = {
    id: uuid(),
    scope,
    available: 0,
    frozen: 0,
    currency: "CNY",
    updatedAt: Math.floor(Date.now() / 1000),
  };
  await store.setJSON(`balance:${scope}`, initial);
  return initial;
}

export async function updateBalance(env: any, scope: string, balance: BalanceRecord): Promise<void> {
  const store = getBlobStore(env);
  balance.updatedAt = Math.floor(Date.now() / 1000);
  await store.setJSON(`balance:${scope}`, balance);
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
  return list.slice(0, limit);
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

export async function addUsageRecord(env: any, record: UsageRecord): Promise<void> {
  const store = getBlobStore(env);
  const date = new Date(record.createdAt * 1000).toISOString().slice(0, 10);

  // 1. 保存单次记录
  await store.setJSON(`usage:record:${record.requestId}`, record);

  // 2. 累加日统计
  const dailyKey = `usage:daily:${date}`;
  const daily: DailyUsageSummary = (await store.get(dailyKey, { type: "json", consistency: "strong" })) || {
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
  daily.byModel[mName] = daily.byModel[mName] || { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  daily.byModel[mName].requests += 1;
  daily.byModel[mName].promptTokens += record.promptTokens || 0;
  daily.byModel[mName].completionTokens += record.completionTokens || 0;
  daily.byModel[mName].costUsd += record.costUsd || 0;

  const pName = record.providerId || "unknown";
  daily.byProvider[pName] = daily.byProvider[pName] || { requests: 0, promptTokens: 0, completionTokens: 0 };
  daily.byProvider[pName].requests += 1;
  daily.byProvider[pName].promptTokens += record.promptTokens || 0;
  daily.byProvider[pName].completionTokens += record.completionTokens || 0;

  await store.setJSON(dailyKey, daily);

  // 3. 用户/日期日用量列表追加（用于前端明细展示）
  const userDailyKey = `usage:user:${record.userId}:${date}`;
  const userList: UsageRecord[] = (await store.get(userDailyKey, { type: "json", consistency: "strong" })) || [];
  userList.unshift(record);
  if (userList.length > 200) userList.length = 200;
  await store.setJSON(userDailyKey, userList);
}

export async function getDailyUsage(env: any, date: string): Promise<DailyUsageSummary | null> {
  const store = getBlobStore(env);
  return await store.get(`usage:daily:${date}`, { type: "json", consistency: "strong" });
}

export async function getUserUsageRecords(env: any, userId: string, date: string): Promise<UsageRecord[]> {
  const store = getBlobStore(env);
  return (await store.get(`usage:user:${userId}:${date}`, { type: "json", consistency: "strong" })) || [];
}

// ==========================================
// 9. 哈希链防篡改审计日志 (Audit Logs)
// ==========================================

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
  const chain: AuditLogRecord[] = (await store.get("audit:chain", { type: "json", consistency: "strong" })) || [];
  const prev = chain.length > 0 ? chain[0] : null;
  const prevHash = prev ? prev.hash : "0000000000000000000000000000000000000000000000000000000000000000";

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
  if (chain.length > 1000) chain.length = 1000;
  await store.setJSON("audit:chain", chain);
  return log;
}

export async function getAuditLogs(env: any, limit = 100): Promise<AuditLogRecord[]> {
  const store = getBlobStore(env);
  const chain: AuditLogRecord[] = (await store.get("audit:chain", { type: "json", consistency: "strong" })) || [];
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
  const store = getBlobStore(env);
  return (await store.get("announcements:all", { type: "json", consistency: "strong" })) || [
    {
      id: "anno_welcome",
      title: "欢迎使用 Relay AI API 边缘网关",
      content: "系统已成功迁移并运行于腾讯云 EdgeOne Pages + Blob 强一致性数据库。",
      popup: 0,
      enabled: 1,
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
    },
  ];
}

export async function saveAnnouncements(env: any, list: AnnouncementRecord[]): Promise<void> {
  const store = getBlobStore(env);
  await store.setJSON("announcements:all", list);
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
