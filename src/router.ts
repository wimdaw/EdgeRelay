/**
 * 路由与故障转移 (EdgeOne Pages + Blob)
 *  - 一个对外模型可映射多条上游路由（models 表）
 *  - 选择策略：priority 升序（越小越优先）→ cost_weight 升序
 *  - 返回有序候选列表，主路由失败按序 failover
 */
import type { UpstreamRoute } from "./types";
import { ApiError, ErrorCode } from "./errors";
import { getModels, getProviders, getProviderKeys } from "./storage/db";
import { readKeyHealth, sortKeysByHealth } from "./key-health";

export async function listRoutes(env: any, publicName: string): Promise<UpstreamRoute[]> {
  const allModels = await getModels(env);
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

  const routes: UpstreamRoute[] = [];
  for (const m of matched) {
    const p = providerMap.get(m.providerId) || providerMap.get(m.providerId.replace(/^p_/, "")) || providerMap.get("p_" + m.providerId);
    if (!p || p.status !== "active") continue;

    const keys = await getProviderKeys(env, p.id);
    const activeKeys = keys.filter((k) => k.status === "active");
    const isKeyless = p.kind === "opencode" || p.slug === "opencode" || p.kind === "duckai" || p.slug === "duckai" || p.kind === "kilo" || p.slug === "kilo" || p.authScheme === "none";
    if (!activeKeys.length && !isKeyless) continue;

    let extraHeaders: Record<string, string> = {};
    if (p.extraHeaders) {
      try {
        extraHeaders = JSON.parse(p.extraHeaders);
      } catch {}
    }

    if (activeKeys.length === 0) {
      // 免 Key 渠道（如 opencode, duckai, kilo）
      routes.push({
        modelId: m.id,
        providerId: p.id,
        providerSlug: p.slug,
        providerKind: p.kind,
        baseUrl: p.baseUrl,
        authScheme: p.authScheme,
        extraHeaders,
        providerKeyId: "keyless",
        encryptedKey: "",
        upstreamModel: m.upstreamModel,
        priority: m.priority,
        costWeight: m.costWeight,
      });
    } else {
      // 多 Key 渠道：读取健康度并按健康/洗牌/试用/降权排序
      const health = await readKeyHealth(env, p.id);
      const sortedKeys = sortKeysByHealth(activeKeys, health);
      for (const pk of sortedKeys) {
        routes.push({
          modelId: m.id,
          providerId: p.id,
          providerSlug: p.slug,
          providerKind: p.kind,
          baseUrl: p.baseUrl,
          authScheme: p.authScheme,
          extraHeaders,
          providerKeyId: pk.id,
          encryptedKey: pk.encryptedKey,
          upstreamModel: m.upstreamModel,
          priority: m.priority,
          costWeight: m.costWeight,
        });
      }
    }
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
