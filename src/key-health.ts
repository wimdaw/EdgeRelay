/**
 * 上游 API Key 健康熔断与轮换调度引擎
 *  - 支持单渠道挂载多 Key 的负载均衡与高可用调度
 *  - 健康 Key 采用 Fisher-Yates 洗牌算法打散，请求均匀分流（Round-Robin 效果）
 *  - 连续失败 (429/5xx) 达到阈值时自动进入熔断降权队列 (Demoted)
 *  - 遭遇 401/402 鉴权与欠费错误时立即触发强熔断，避免反复无效调用
 *  - 熔断 Key 经过 60 秒冷却后自动进入试用队列 (Probation) 探测自愈
 */
import type { ProviderKeyRecord } from "./types";
import { getBlobStore } from "./storage/blob-store";

export type KeyHealth = {
  failures: number;
  lastFailed?: number;
  demotedAt?: number;
};

export type HealthMap = Record<string, KeyHealth>;

/** 触发熔断的连续失败次数 */
export const KEY_HEALTH_MAX_FAILURES = 3;
/** 熔断后冷却时间 (毫秒)，60秒后转入试用组探测恢复 */
export const KEY_HEALTH_COOLDOWN_MS = 60_000;

// 进程内短缓存（30 秒，过期后台刷新），大幅减轻 EdgeOne Blob I/O
const healthCache = new Map<string, { val: HealthMap; at: number }>();
const healthVersions = new Map<string, number>();
const healthRefreshing = new Set<string>();
const CACHE_TTL_MS = 30_000;

function cloneHealth(val: HealthMap): HealthMap {
  const out: HealthMap = {};
  for (const [key, v] of Object.entries(val)) out[key] = { ...v };
  return out;
}

export async function readKeyHealth(env: any, providerId: string): Promise<HealthMap> {
  const now = Date.now();
  const cached = healthCache.get(providerId);
  if (cached) {
    if (now - cached.at >= CACHE_TTL_MS && !healthRefreshing.has(providerId)) {
      // 先返回旧值，后台刷新，避免每 30 秒有一个请求多等一次 Blob 往返
      healthRefreshing.add(providerId);
      const version = healthVersions.get(providerId) || 0;
      void (async () => {
        try {
          const store = getBlobStore(env);
          const raw = (await store.get(`key_health:${providerId}`, { type: "json", consistency: "strong" })) as HealthMap | null;
          // 刷新期间有新的失败/成功写入则丢弃本次结果，避免回滚熔断状态
          if ((healthVersions.get(providerId) || 0) === version) {
            healthCache.set(providerId, { val: raw || {}, at: Date.now() });
          }
        } catch {
          // ignore
        } finally {
          healthRefreshing.delete(providerId);
        }
      })();
    }
    return cloneHealth(cached.val);
  }
  try {
    const store = getBlobStore(env);
    const raw = (await store.get(`key_health:${providerId}`, { type: "json", consistency: "strong" })) as HealthMap | null;
    const val = raw || {};
    healthCache.set(providerId, { val, at: now });
    return cloneHealth(val);
  } catch {
    return {};
  }
}

export async function writeKeyHealth(env: any, providerId: string, health: HealthMap): Promise<void> {
  healthVersions.set(providerId, (healthVersions.get(providerId) || 0) + 1);
  healthCache.set(providerId, { val: health, at: Date.now() });
  try {
    const store = getBlobStore(env);
    // 只持久化存在异常/降权的 key，全健康时清理 Blob 条目
    const filtered: HealthMap = {};
    for (const [k, v] of Object.entries(health)) {
      if (v.failures > 0 || (v.demotedAt && Date.now() - v.demotedAt < KEY_HEALTH_COOLDOWN_MS)) {
        filtered[k] = v;
      }
    }
    if (Object.keys(filtered).length > 0) {
      await store.setJSON(`key_health:${providerId}`, filtered);
    } else {
      await store.delete(`key_health:${providerId}`);
    }
  } catch (err: any) {
    console.warn(`[key-health] writeKeyHealth failed for ${providerId}:`, err?.message);
  }
}

/**
 * 按照健康状态对 Key 进行分级并排序：
 * 1. Healthy: 无失败，使用 Fisher-Yates 随机打散实现均匀分流
 * 2. Unhealthy: 失败 < 3 次，排在健康 Key 之后
 * 3. Probation: 熔断已过 60s 冷却期，优先给予单次试用机会探测是否自愈
 * 4. Demoted: 仍在 60s 冷却期内的熔断 Key（兜底备用）
 */
export function sortKeysByHealth(keys: ProviderKeyRecord[], health: HealthMap): ProviderKeyRecord[] {
  if (keys.length <= 1) return [...keys];

  const now = Date.now();
  const healthy: ProviderKeyRecord[] = [];
  const unhealthy: ProviderKeyRecord[] = [];
  const probation: ProviderKeyRecord[] = [];
  const demoted: ProviderKeyRecord[] = [];

  for (const k of keys) {
    const h = health[k.id] || health[k.keyFingerprint];
    if (h && (h.failures >= KEY_HEALTH_MAX_FAILURES || h.demotedAt)) {
      const demotedTime = h.demotedAt || h.lastFailed || now;
      if (now - demotedTime >= KEY_HEALTH_COOLDOWN_MS) {
        probation.push(k);
      } else {
        demoted.push(k);
      }
    } else if (h && h.failures > 0) {
      unhealthy.push(k);
    } else {
      healthy.push(k);
    }
  }

  // 对健康组执行 Fisher-Yates 洗牌
  for (let i = healthy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [healthy[i], healthy[j]] = [healthy[j], healthy[i]];
  }

  const order = [...healthy, ...unhealthy, ...probation];
  // 极端全熔断情况下，降级回退降权组
  if (order.length === 0 && demoted.length > 0) {
    return demoted;
  }
  return order.concat(demoted);
}

/** 请求成功时重置健康指标（自愈） */
export async function recordKeySuccess(env: any, providerId: string, keyId: string): Promise<void> {
  const health = await readKeyHealth(env, providerId);
  if (health[keyId] && (health[keyId].failures > 0 || health[keyId].demotedAt)) {
    delete health[keyId];
    await writeKeyHealth(env, providerId, health);
  }
}

/** 请求失败时记录异常与熔断判定 */
export async function recordKeyFailure(
  env: any,
  providerId: string,
  keyId: string,
  isTerminal = false
): Promise<void> {
  const health = await readKeyHealth(env, providerId);
  const now = Date.now();
  const cur = health[keyId] || { failures: 0 };
  cur.failures = (cur.failures || 0) + 1;
  cur.lastFailed = now;

  // 终态错误（401 Key无效、402/403 欠费封禁）或连续超限，立即强熔断
  if (isTerminal || cur.failures >= KEY_HEALTH_MAX_FAILURES) {
    cur.demotedAt = now;
  }
  health[keyId] = cur;
  await writeKeyHealth(env, providerId, health);
}
