/**
 * 路由与故障转移 (EdgeOne Pages + Blob)
 *  - 一个对外模型可映射多条上游路由（models 表）
 *  - 选择策略：priority 升序（越小越优先）→ cost_weight 升序
 *  - 返回有序候选列表，主路由失败按序 failover
 */
import type { UpstreamRoute } from "./types";
import { ApiError, ErrorCode } from "./errors";
import { getModels, getProviders, getProviderKeys } from "./storage/db";

export async function listRoutes(env: any, publicName: string): Promise<UpstreamRoute[]> {
  const allModels = await getModels(env);
  const matched = allModels.filter((m) => m.publicName === publicName && m.enabled === 1);
  if (!matched.length) return [];

  // 按 priority 升序、cost_weight 升序排序
  matched.sort((a, b) => a.priority - b.priority || a.costWeight - b.costWeight);

  const allProviders = await getProviders(env);
  const providerMap = new Map(allProviders.map((p) => [p.id, p]));

  const routes: UpstreamRoute[] = [];
  for (const m of matched) {
    const p = providerMap.get(m.providerId) || providerMap.get(m.providerId.replace(/^p_/, "")) || providerMap.get("p_" + m.providerId);
    if (!p || p.status !== "active") continue;

    const keys = await getProviderKeys(env, p.id);
    const activeKeys = keys.filter((k) => k.status === "active");
    const isKeyless = p.kind === "opencode" || p.slug === "opencode" || p.kind === "duckai" || p.slug === "duckai" || p.authScheme === "none";
    if (!activeKeys.length && !isKeyless) continue;

    const pk = activeKeys[0];
    let extraHeaders: Record<string, string> = {};
    if (p.extraHeaders) {
      try {
        extraHeaders = JSON.parse(p.extraHeaders);
      } catch {}
    }

    routes.push({
      modelId: m.id,
      providerId: p.id,
      providerSlug: p.slug,
      providerKind: p.kind,
      baseUrl: p.baseUrl,
      authScheme: p.authScheme,
      extraHeaders,
      providerKeyId: pk ? pk.id : "keyless",
      encryptedKey: pk ? pk.encryptedKey : "",
      upstreamModel: m.upstreamModel,
      priority: m.priority,
      costWeight: m.costWeight,
    });
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
  const names = Array.from(new Set(models.filter((m) => m.enabled === 1).map((m) => m.publicName)));
  const created = Math.floor(Date.parse("2026-01-01") / 1000);
  return names.map((name) => ({ id: name, created, owned_by: "gateway" }));
}
