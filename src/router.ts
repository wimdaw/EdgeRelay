/**
 * 路由与故障转移 (EdgeOne Pages + Blob)
 *  - 一个对外模型可映射多条上游路由（models 表）
 *  - 选择策略：priority 升序（越小越优先）→ cost_weight 升序
 *  - 返回有序候选列表，主路由失败按序 failover
 *  - 路由规划拆成两步：planModelRoutes 只读配置（memif 内已缓存，零 I/O），
 *    拿到渠道与模型后，调用方把该渠道的 Key 池与健康度合并读（一轮并行），再交给 buildRoutes
 */
import type { UpstreamRoute, ProviderRecord, ModelRouteRecord, ProviderKeyRecord } from "./types";
import { ApiError, ErrorCode } from "./errors";
import { getModels, getProviders } from "./storage/db";
import { sortKeysByHealth, type HealthMap } from "./key-health";

/** 单渠道每次请求最多参与调度的 Key 数（万级 Key 池只做随机抽样，避免全量洗牌开销） */
export const MAX_KEY_CANDIDATES = 64;

export type RoutePlan = { model: ModelRouteRecord; provider: ProviderRecord };

function sampleKeys<T>(keys: T[], size: number): T[] {
  const pool = keys.slice();
  for (let i = 0; i < size; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, size);
}

/**
 * 只读配置规划路由（不涉及 Key 池 I/O）：
 * 返回「模型 x 渠道」的候选计划，调用方随后按 providerId 并行读取 Key 池与健康度。
 * 渠道无可用 Key 且非免 Key 渠道时，该计划会被标记为不可行（由 buildRoutes 丢弃）。
 */
export async function planModelRoutes(env: any, publicName: string): Promise<RoutePlan[]> {
  const allModels = await getModels(env); // config:all 已缓存，零额外 I/O
  let matched = allModels.filter((m) => m.publicName === publicName && m.enabled === 1);

  // 若未直接精确匹配，支持通过 "渠道标识/模型名" 精准定向指定提供商（如 deepseek/deepseek-chat）
  if (!matched.length && publicName.includes("/")) {
    const slashIdx = publicName.indexOf("/");
    const targetSlug = publicName.slice(0, slashIdx);
    const subName = publicName.slice(slashIdx + 1);
    const allProviders = await getProviders(env);
    const targetProvider = allProviders.find((p) => p.slug === targetSlug || p.id === targetSlug);
    if (targetProvider) {
      matched = allModels.filter(
        (m) =>
          m.providerId === targetProvider.id &&
          (m.publicName === subName || m.upstreamModel === subName) &&
          m.enabled === 1
      );
    }
  }
  if (!matched.length) return [];

  // 按 priority 升序、cost_weight 升序排序
  matched.sort((a, b) => a.priority - b.priority || a.costWeight - b.costWeight);

  const allProviders = await getProviders(env);
  const providerMap = new Map(allProviders.map((p) => [p.id, p]));

  const plans: RoutePlan[] = [];
  for (const m of matched) {
    const p = providerMap.get(m.providerId) || providerMap.get(m.providerId.replace(/^p_/, "")) || providerMap.get("p_" + m.providerId);
    if (!p || p.status !== "active") continue;
    plans.push({ model: m, provider: p });
  }
  return plans;
}

export function isKeylessProvider(provider: ProviderRecord): boolean {
  return (
    provider.kind === "opencode" ||
    provider.slug === "opencode" ||
    provider.kind === "duckai" ||
    provider.slug === "duckai" ||
    provider.kind === "kilo" ||
    provider.slug === "kilo" ||
    provider.authScheme === "none"
  );
}

/** 从规划 + 已读取的 Key 池/健康度构建最终路由候选（纯内存） */
export function buildRoutesFromPlan(
  env: any,
  plan: RoutePlan,
  keys: ProviderKeyRecord[],
  health: HealthMap
): UpstreamRoute[] {
  const m = plan.model;
  const p = plan.provider;
  if (isKeylessProvider(p)) {
    // 免 Key 渠道（如 opencode, duckai, kilo）
    return [
      {
        modelId: m.id,
        providerId: p.id,
        providerSlug: p.slug,
        providerKind: p.kind,
        baseUrl: p.baseUrl,
        authScheme: p.authScheme,
        extraHeaders: parseExtraHeaders(p.extraHeaders),
        providerKeyId: "keyless",
        encryptedKey: "",
        upstreamModel: m.upstreamModel,
        priority: m.priority,
        costWeight: m.costWeight,
      },
    ];
  }

  const activeKeys = keys.filter((k) => k.status === "active");
  if (!activeKeys.length) return [];

  // 万级 Key 池：先随机抽样再健康排序，避免每请求全量洗牌
  const pool = activeKeys.length > MAX_KEY_CANDIDATES ? sampleKeys(activeKeys, MAX_KEY_CANDIDATES) : activeKeys;
  const ordered = sortKeysByHealth(pool, health);
  const headers = parseExtraHeaders(p.extraHeaders);
  return ordered.map((pk) => ({
    modelId: m.id,
    providerId: p.id,
    providerSlug: p.slug,
    providerKind: p.kind,
    baseUrl: p.baseUrl,
    authScheme: p.authScheme,
    extraHeaders: headers,
    providerKeyId: pk.id,
    encryptedKey: pk.encryptedKey,
    upstreamModel: m.upstreamModel,
    priority: m.priority,
    costWeight: m.costWeight,
  }));
}

function parseExtraHeaders(raw?: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

/** 完整路由（兼容外部调用）：一次把所有 I/O 拉齐后构建 */
export async function listRoutes(env: any, publicName: string): Promise<UpstreamRoute[]> {
  const plans = await planModelRoutes(env, publicName);
  if (!plans.length) return [];

  const { getProviderKeys } = await import("./storage/db");
  const { readKeyHealth } = await import("./key-health");
  // 去重渠道，一轮并行读取所有渠道的 Key 池 + 健康度
  const uniq: RoutePlan[] = [];
  const seen = new Set<string>();
  for (const plan of plans) {
    if (seen.has(plan.provider.id)) continue;
    seen.add(plan.provider.id);
    uniq.push(plan);
  }
  const payloads = await Promise.all(
    uniq.map(async (plan) => [plan, await getProviderKeys(env, plan.provider.id), await readKeyHealth(env, plan.provider.id)] as const)
  );
  const keyMap = new Map<string, ProviderKeyRecord[]>();
  const healthMap = new Map<string, HealthMap>();
  for (const [plan, keys, health] of payloads) {
    keyMap.set(plan.provider.id, keys);
    healthMap.set(plan.provider.id, health);
  }

  const routes: UpstreamRoute[] = [];
  for (const plan of plans) {
    routes.push(...buildRoutesFromPlan(env, plan, keyMap.get(plan.provider.id) || [], healthMap.get(plan.provider.id) || {}));
  }
  return routes;
}

export async function requireRoutes(env: any, publicName: string): Promise<UpstreamRoute[]> {
  const routes = await listRoutes(env, publicName);
  if (!routes.length) {
    throw new ApiError(404, ErrorCode.MODEL_NOT_FOUND, `模型 ${publicName} 不存在或暂无可用上游`);
  }
  return routes;
}

/** 列出对外可见的模型（OpenAI /v1/models 格式） */
export async function listPublicModels(env: any): Promise<{ id: string; created: number; owned_by: string }[]> {
  const models = await getModels(env);
  const providers = await getProviders(env);
  const activeProviders = new Set(providers.filter((p) => p.status === "active").map((p) => p.id));
  const providerMap = new Map(providers.map((p) => [p.id, p]));
  const activeModels = models.filter((m) => m.enabled === 1 && activeProviders.has(m.providerId));
  const names = new Set<string>();

  for (const m of activeModels) {
    names.add(m.publicName);
    const p = providerMap.get(m.providerId);
    if (p?.slug && !m.publicName.startsWith(`${p.slug}/`)) {
      names.add(`${p.slug}/${m.publicName}`);
    }
  }

  const created = Math.floor(Date.parse("2026-01-01") / 1000);
  return Array.from(names).map((name) => ({ id: name, created, owned_by: "gateway" }));
}