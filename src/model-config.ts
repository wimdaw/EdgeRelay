/**
 * 模型配置规范化与上游同步（纯函数，无 I/O）
 *
 * 三条硬规则：
 *  1. 对外模型名默认取上游真实模型名；只有在定价配置里显式改过对外名的模型才沿用自定义名；
 *  2. 所有模型路由的优先级统一为 10（UNIFIED_MODEL_PRIORITY）；
 *  3. 供应商刷新以上游当前列表为准：上游没有的移除、上游新增的补齐、已有的保留自定义定价。
 *
 * 定价表以 publicName 为键。改名时把旧键上的自定义定价迁到新键上，
 * 若新键已有更完整的定价（非零价格 / 独立限流）则保留新键，避免覆盖人工配置。
 */
import type { ModelPricingRecord, ModelRouteRecord } from "./types";

/** 全站统一的模型路由优先级（数字越小越优先，统一后同层按 costWeight 排序） */
export const UNIFIED_MODEL_PRIORITY = 10;

/**
 * 渠道免费模型白名单：这些渠道只上架可免费调用的模型。
 *  - cline：零扣费模型（`cline-free/` 前缀或 `:free` 后缀）；`~` 前缀是赠金通道，其余为付费
 *  - bigmodel：免费 Flash 系列（`-flash`），排除付费的 FlashX
 * 其余渠道原样返回。
 */
export function filterProviderModels(slug: string, kind: string, models: string[]): string[] {
  const key = slug || "";
  if (key === "cline" || key === "cline-oauth" || kind === "oauth:cline") {
    return models.filter((m) => m.startsWith("cline-free/") || m.endsWith(":free"));
  }
  if (key === "bigmodel") {
    return models.filter((m) => {
      const s = m.toLowerCase();
      return s.includes("flash") && !s.includes("flashx");
    });
  }
  return models;
}

export type NormalizeSummary = {
  /** 因对外名为空/等于旧上游名而被对齐到最新上游名的条数 */
  renamed: number;
  /** 保留了定价中自定义对外名的条数 */
  customKept: number;
  /** 优先级不是 10 而被修正的条数 */
  priorityFixed: number;
  /** 同一渠道内 (providerId, upstreamModel) 重复而被合并的条数 */
  deduped: number;
};

export type SyncSummary = NormalizeSummary & {
  /** 本次新增的上游模型名 */
  added: string[];
  /** 本次移除的、上游已不存在的模型名 */
  removed: string[];
  /** 同步后该渠道的模型总数 */
  total: number;
};

export type NormalizeResult = {
  models: ModelRouteRecord[];
  pricing: Record<string, ModelPricingRecord>;
  summary: NormalizeSummary;
};

export type SyncResult = NormalizeResult & { summary: SyncSummary };

type RenamePair = { from: string; to: string };

/** 定价"完整度"：非零价格 > 独立限流 > 空记录。用于改名时决定保留哪份配置 */
function pricingWeight(record?: ModelPricingRecord): number {
  if (!record) return -1;
  const hasPrice = (Number(record.inputPerMillion) || 0) > 0 || (Number(record.outputPerMillion) || 0) > 0;
  if (hasPrice) return 2;
  if (record.rpmLimit !== null && record.rpmLimit !== undefined) return 1;
  return 0;
}

/** 把改名前的定价迁移到新键；旧键若已无任何模型使用则删除 */
function migratePricing(
  source: Record<string, ModelPricingRecord>,
  pairs: RenamePair[],
  models: ModelRouteRecord[]
): Record<string, ModelPricingRecord> {
  if (!pairs.length) return source;
  const next: Record<string, ModelPricingRecord> = { ...source };
  const usedNames = new Set(models.map((m) => m.publicName));

  for (const { from, to } of pairs) {
    if (!from || from === to) continue;
    const oldPricing = source[from];
    if (!oldPricing) {
      if (!usedNames.has(from)) delete next[from];
      continue;
    }
    const current = next[to];
    if (!current || pricingWeight(oldPricing) > pricingWeight(current)) {
      next[to] = { ...oldPricing, publicName: to };
    }
    if (!usedNames.has(from) && from !== to) delete next[from];
  }
  return next;
}

/**
 * 全量规范化：名称对齐上游、优先级统一为 10、同渠道重复项合并。
 * 不改动 enabled / costWeight / maxContext 等既有业务字段。
 */
export function normalizeModels(input: {
  models: ModelRouteRecord[];
  pricing: Record<string, ModelPricingRecord>;
}): NormalizeResult {
  const kept: ModelRouteRecord[] = [];
  const byKey = new Map<string, ModelRouteRecord>();
  const renamePairs: RenamePair[] = [];
  let renamed = 0;
  let customKept = 0;
  let priorityFixed = 0;
  let deduped = 0;

  for (const raw of input.models) {
    const upstreamModel = String(raw.upstreamModel ?? "").trim();
    // 没有上游模型名的脏数据无法路由，直接丢弃
    if (!upstreamModel) continue;

    const rawName = String(raw.publicName ?? "").trim();
    // 与上游名（忽略大小写）不同 → 说明对外名是在定价里手工改过的，按定价为准保留；
    // 其余（空名、仅大小写差异、与上游同名）一律跟随上游真实模型名。
    const isCustom = !!rawName && rawName.toLowerCase() !== String(raw.upstreamModel ?? "").trim().toLowerCase();
    const publicName = isCustom ? rawName : upstreamModel;

    const key = `${raw.providerId}::${upstreamModel}`;
    const dup = byKey.get(key);
    if (dup) {
      deduped++;
      // 去重时保留启用态，避免把唯一可用的那条合并掉
      if (raw.enabled === 1) dup.enabled = 1;
      // 被合并那条的定价迁移到保留记录的名字上
      if (rawName && rawName !== dup.publicName) renamePairs.push({ from: rawName, to: dup.publicName });
      continue;
    }

    if (isCustom) customKept++;
    if (rawName !== publicName) {
      renamed++;
      if (rawName) renamePairs.push({ from: rawName, to: publicName });
    }
    if (raw.priority !== UNIFIED_MODEL_PRIORITY) priorityFixed++;

    const record: ModelRouteRecord = {
      ...raw,
      upstreamModel,
      publicName,
      priority: UNIFIED_MODEL_PRIORITY,
    };
    byKey.set(key, record);
    kept.push(record);
  }

  return {
    models: kept,
    pricing: migratePricing(input.pricing, renamePairs, kept),
    summary: { renamed, customKept, priorityFixed, deduped },
  };
}

/**
 * 供应商模型同步：
 *  - 以上游列表为唯一事实来源，上游已不存在的模型移除；
 *  - 上游新增的模型自动补齐，名称默认取上游真实名，优先级 10；
 *  - 已存在的模型保留自定义定价/限流，并在定价里改过对外名的保留自定义名；
 *  - 新增模型若命中了既有同名定价配置，沿用该配置而不是清零。
 */
export function planProviderSync(input: {
  models: ModelRouteRecord[];
  pricing: Record<string, ModelPricingRecord>;
  providerId: string;
  upstreamModels: string[];
  now: number;
  newModelId: () => string;
  newPricingId: () => string;
}): SyncResult {
  const base = normalizeModels({ models: input.models, pricing: input.pricing });

  const upstream: string[] = [];
  const upstreamSet = new Set<string>();
  for (const raw of input.upstreamModels) {
    const name = String(raw ?? "").trim();
    if (!name || upstreamSet.has(name)) continue;
    upstreamSet.add(name);
    upstream.push(name);
  }

  const providerModels = base.models.filter((m) => m.providerId === input.providerId);
  const existingUpstream = new Set(providerModels.map((m) => m.upstreamModel));

  const removedRecords = providerModels.filter((m) => !upstreamSet.has(m.upstreamModel));
  const removed = removedRecords.map((m) => m.upstreamModel);
  const removedSet = new Set(removed);
  const added = upstream.filter((name) => !existingUpstream.has(name));

  const nextModels = base.models.filter(
    (m) => m.providerId !== input.providerId || !removedSet.has(m.upstreamModel)
  );

  for (const name of added) {
    nextModels.push({
      id: input.newModelId(),
      publicName: name,
      providerId: input.providerId,
      upstreamModel: name,
      priority: UNIFIED_MODEL_PRIORITY,
      costWeight: 1,
      maxContext: null,
      enabled: 1,
      createdAt: input.now,
    });
  }

  const pricing: Record<string, ModelPricingRecord> = { ...base.pricing };
  // 新增模型：已有同名定价配置（人工改过价/限流）则原样保留，否则建一条零价记录
  for (const name of added) {
    if (!pricing[name]) {
      pricing[name] = {
        id: input.newPricingId(),
        publicName: name,
        inputPerMillion: 0,
        outputPerMillion: 0,
        currency: "CNY",
        rpmLimit: null,
        createdAt: input.now,
      };
    }
  }
  // 移除模型后清理不再被任何模型引用的孤儿定价（按对外名清理，自定义名同样覆盖）
  const usedNames = new Set(nextModels.map((m) => m.publicName));
  for (const record of removedRecords) {
    if (!usedNames.has(record.publicName)) delete pricing[record.publicName];
  }

  return {
    models: nextModels,
    pricing,
    summary: {
      ...base.summary,
      added,
      removed,
      total: nextModels.filter((m) => m.providerId === input.providerId).length,
    },
  };
}
