/**
 * 写后置（write-behind）缓冲：把热路径上的用量/账本落库改成「内存聚合 + 批量潮写」
 *
 * 背景：EdgeOne Blob 每次强一致写约 100~200ms。原实现每完成一次对话要串行写
 * 单条记录、日汇总、最近列表、用户日列表、账本等 6~10 个 key，直接拖慢响应。
 * 现在：内存里合并计数，600ms 窗口内的所有请求合并成一轮并行写，且完全不阻塞响应。
 *
 * 一致性策略：
 *  - 读取接口叠加「缓冲中 / 正在写」两条数据，后台刚产生的用量立刻可见
 *  - 潮写失败的数据重新入队，最多重试 3 轮，避免持续故障时无限膨胀
 */
import type { UsageRecord, DailyUsageSummary, LedgerEntryRecord } from "../types";
import { getBlobStore } from "./blob-store";
import { mapLimit } from "./cache";

const FLUSH_DELAY_MS = 600;
const FLUSH_DELAY_MAX_MS = 5000;
const MAX_BUFFERED_RECORDS = 200;
const MAX_RETRIES = 3;
const MAX_RECENT_RECORDS = 200;
const MAX_LEDGER_ENTRIES = 500;
/** 单次潮写最多并发 6 个远端写，避免瞬时打爆 Blob 触发限流 */
const WRITE_CONCURRENCY = 6;

/** 自适应潮写间隔：写入变慢时自动拉长窗口，避免后台任务与前台争抢 Blob */
let flushDelayMs = FLUSH_DELAY_MS;

export type UsageDelta = {
  requests: number;
  successRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  byModel: Record<string, { requests: number; promptTokens: number; completionTokens: number; costUsd: number }>;
  byProvider: Record<string, { requests: number; promptTokens: number; completionTokens: number }>;
};

function emptyDelta(): UsageDelta {
  return {
    requests: 0,
    successRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalCostUsd: 0,
    totalLatencyMs: 0,
    byModel: {},
    byProvider: {},
  };
}

export function dateOf(createdAtSeconds: number): string {
  return new Date(createdAtSeconds * 1000).toISOString().slice(0, 10);
}

function applyRecordToDelta(delta: UsageDelta, record: UsageRecord): void {
  delta.requests += 1;
  if (record.status === "success") delta.successRequests += 1;
  delta.promptTokens += record.promptTokens || 0;
  delta.completionTokens += record.completionTokens || 0;
  delta.totalCostUsd += record.costUsd || 0;
  delta.totalLatencyMs += record.latencyMs || 0;

  const model = record.publicModel || "unknown";
  const m = (delta.byModel[model] = delta.byModel[model] || { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 });
  m.requests += 1;
  m.promptTokens += record.promptTokens || 0;
  m.completionTokens += record.completionTokens || 0;
  m.costUsd += record.costUsd || 0;

  const provider = record.providerId || "unknown";
  const p = (delta.byProvider[provider] = delta.byProvider[provider] || { requests: 0, promptTokens: 0, completionTokens: 0 });
  p.requests += 1;
  p.promptTokens += record.promptTokens || 0;
  p.completionTokens += record.completionTokens || 0;
}

function mergeDelta(target: UsageDelta, extra: UsageDelta): void {
  target.requests += extra.requests;
  target.successRequests += extra.successRequests;
  target.promptTokens += extra.promptTokens;
  target.completionTokens += extra.completionTokens;
  target.totalCostUsd += extra.totalCostUsd;
  target.totalLatencyMs += extra.totalLatencyMs;
  for (const [name, v] of Object.entries(extra.byModel)) {
    const m = (target.byModel[name] = target.byModel[name] || { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 });
    m.requests += v.requests;
    m.promptTokens += v.promptTokens;
    m.completionTokens += v.completionTokens;
    m.costUsd += v.costUsd;
  }
  for (const [name, v] of Object.entries(extra.byProvider)) {
    const p = (target.byProvider[name] = target.byProvider[name] || { requests: 0, promptTokens: 0, completionTokens: 0 });
    p.requests += v.requests;
    p.promptTokens += v.promptTokens;
    p.completionTokens += v.completionTokens;
  }
}

/* ---------- 缓冲区状态 ---------- */

let bufferedRecords: UsageRecord[] = [];
let bufferedDaily = new Map<string, UsageDelta>();
let bufferedLedger = new Map<string, LedgerEntryRecord[]>();

let inflightRecords: UsageRecord[] = [];
let inflightDaily = new Map<string, UsageDelta>();
let inflightLedger = new Map<string, LedgerEntryRecord[]>();

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;
let retries = 0;

function newDeltaFor(): UsageDelta {
  return emptyDelta();
}

/** 与远端日汇总合并；date 由调用方保证一致 */
export function mergeUsageDeltaInto(summary: DailyUsageSummary, delta: UsageDelta): DailyUsageSummary {
  const out: DailyUsageSummary = {
    ...summary,
    byModel: { ...summary.byModel },
    byProvider: { ...summary.byProvider },
  };
  out.requests += delta.requests;
  out.successRequests += delta.successRequests;
  out.promptTokens += delta.promptTokens;
  out.completionTokens += delta.completionTokens;
  out.totalCostUsd += delta.totalCostUsd;
  out.totalLatencyMs += delta.totalLatencyMs;
  for (const [name, v] of Object.entries(delta.byModel)) {
    const m = (out.byModel[name] = { ...(out.byModel[name] || { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }) });
    m.requests += v.requests;
    m.promptTokens += v.promptTokens;
    m.completionTokens += v.completionTokens;
    m.costUsd += v.costUsd;
  }
  for (const [name, v] of Object.entries(delta.byProvider)) {
    const p = (out.byProvider[name] = { ...(out.byProvider[name] || { requests: 0, promptTokens: 0, completionTokens: 0 }) });
    p.requests += v.requests;
    p.promptTokens += v.promptTokens;
    p.completionTokens += v.completionTokens;
  }
  return out;
}

export function pendingDailyDelta(date: string): UsageDelta | null {
  const a = inflightDaily.get(date);
  const b = bufferedDaily.get(date);
  if (!a && !b) return null;
  const out = emptyDelta();
  if (a) mergeDelta(out, a);
  if (b) mergeDelta(out, b);
  return out;
}

/** 后台刚写入、尚未落库的记录（倒序：最新在前） */
export function pendingUsageRecords(userId?: string, date?: string): UsageRecord[] {
  if (!inflightRecords.length && !bufferedRecords.length) return [];
  const all = [...inflightRecords, ...bufferedRecords];
  const filtered = all.filter((r) => {
    if (userId && r.userId !== userId) return false;
    if (date && dateOf(r.createdAt) !== date) return false;
    return true;
  });
  return filtered.reverse();
}

export function pendingLedgerEntries(scope: string): LedgerEntryRecord[] {
  const a = inflightLedger.get(scope) || [];
  const b = bufferedLedger.get(scope) || [];
  if (!a.length && !b.length) return [];
  return [...a, ...b].reverse();
}

/* ---------- 入队 ---------- */

export function enqueueUsageWrite(env: any, record: UsageRecord): void {
  bufferedRecords.push(record);
  // 极端流量下的内存保护：只保留最新 2000 条待写记录
  if (bufferedRecords.length > 2000) bufferedRecords.splice(0, bufferedRecords.length - 2000);
  const date = dateOf(record.createdAt);
  const delta = bufferedDaily.get(date) || newDeltaFor();
  applyRecordToDelta(delta, record);
  bufferedDaily.set(date, delta);
  scheduleFlush(env);
  if (bufferedRecords.length >= MAX_BUFFERED_RECORDS) void flushWriteBehind(env);
}

export function enqueueLedgerWrite(env: any, entry: LedgerEntryRecord): void {
  const list = bufferedLedger.get(entry.scope) || [];
  list.push(entry);
  bufferedLedger.set(entry.scope, list);
  scheduleFlush(env);
}

function hasPending(): boolean {
  return bufferedRecords.length > 0 || bufferedDaily.size > 0 || bufferedLedger.size > 0;
}

function scheduleFlush(env: any): void {
  if (flushTimer || flushing) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushWriteBehind(env);
  }, flushDelayMs);
}

/* ---------- 落库 ---------- */

function groupUserDay(records: UsageRecord[]): Map<string, UsageRecord[]> {
  const groups = new Map<string, UsageRecord[]>();
  for (const r of records) {
    const key = `${r.userId}|${dateOf(r.createdAt)}`;
    const list = groups.get(key) || [];
    list.push(r);
    groups.set(key, list);
  }
  return groups;
}

async function writeDaily(env: any, date: string, delta: UsageDelta): Promise<void> {
  const store = getBlobStore(env);
  const key = `usage:daily:${date}`;
  const cur: DailyUsageSummary = (await store.get(key, { type: "json", consistency: "strong" })) || {
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
  await store.setJSON(key, mergeUsageDeltaInto(cur, delta));
}

async function writeRecent(env: any, records: UsageRecord[]): Promise<void> {
  const store = getBlobStore(env);
  const key = "usage:recent";
  const cur: UsageRecord[] = (await store.get(key, { type: "json", consistency: "strong" })) || [];
  // 按 requestId 去重，保证重试/多实例并发写入幂等
  const seen = new Set(cur.map((r) => r.requestId));
  const fresh = records.filter((r) => !seen.has(r.requestId));
  const merged = fresh.slice(-MAX_RECENT_RECORDS).reverse().concat(cur).slice(0, MAX_RECENT_RECORDS);
  await store.setJSON(key, merged);
}

async function writeUserDay(env: any, userId: string, date: string, records: UsageRecord[]): Promise<void> {
  const store = getBlobStore(env);
  const key = `usage:user:${userId}:${date}`;
  const cur: UsageRecord[] = (await store.get(key, { type: "json", consistency: "strong" })) || [];
  const seen = new Set(cur.map((r) => r.requestId));
  const fresh = records.filter((r) => !seen.has(r.requestId));
  const merged = fresh.slice(-MAX_RECENT_RECORDS).reverse().concat(cur).slice(0, MAX_RECENT_RECORDS);
  await store.setJSON(key, merged);
}

async function writeLedger(env: any, scope: string, entries: LedgerEntryRecord[]): Promise<void> {
  const store = getBlobStore(env);
  const key = `ledger:${scope}`;
  const cur: LedgerEntryRecord[] = (await store.get(key, { type: "json", consistency: "strong" })) || [];
  const seen = new Set(cur.map((e) => e.id));
  const fresh = entries.filter((e) => !seen.has(e.id));
  const merged = fresh.slice(-MAX_LEDGER_ENTRIES).reverse().concat(cur).slice(0, MAX_LEDGER_ENTRIES);
  await store.setJSON(key, merged);
}

export function flushWriteBehind(env: any): Promise<void> {
  if (flushing) return flushing;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!hasPending() && inflightRecords.length === 0 && inflightDaily.size === 0 && inflightLedger.size === 0) {
    return Promise.resolve();
  }

  // 快照换出：新请求继续写新的 buffer
  inflightRecords = bufferedRecords;
  inflightDaily = bufferedDaily;
  inflightLedger = bufferedLedger;
  bufferedRecords = [];
  bufferedDaily = new Map();
  bufferedLedger = new Map();

  const records = inflightRecords;
  const daily = inflightDaily;
  const ledger = inflightLedger;

  flushing = (async () => {
    const startedAt = Date.now();
    const store = getBlobStore(env);
    const jobs: Promise<unknown>[] = [];

    // 单条记录并发上限 6，避免万级写入瞬时触发 Blob 限流（尽力而为，失败不阻塞汇总）
    if (records.length > 0) {
      jobs.push(mapLimit(records, WRITE_CONCURRENCY, (r) => store.setJSON(`usage:record:${r.requestId}`, r).catch(() => {})));
      jobs.push(writeRecent(env, records));
      for (const [group, list] of groupUserDay(records)) {
        const sep = group.lastIndexOf("|");
        jobs.push(writeUserDay(env, group.slice(0, sep), group.slice(sep + 1), list));
      }
    }
    // 日汇总/账本非幂等：写成功后立刻从 in-flight 移除，读取叠加时不会重复计数，重试也不会重复累加
    for (const [date, delta] of daily) {
      jobs.push(
        writeDaily(env, date, delta).then(() => {
          inflightDaily.delete(date);
        })
      );
    }
    for (const [scope, entries] of ledger) {
      jobs.push(
        writeLedger(env, scope, entries).then(() => {
          inflightLedger.delete(scope);
        })
      );
    }

    try {
      const results = await Promise.allSettled(jobs);
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length > 0) throw new Error(`${failed.length} 个写入失败`);
      retries = 0;
      // 自适应：写入耗时超过 1.5s 说明后台压力大，拉长窗口让前台优先
      const elapsed = Date.now() - startedAt;
      flushDelayMs = elapsed > 1500 ? Math.min(FLUSH_DELAY_MAX_MS, Math.round(flushDelayMs * 2)) : FLUSH_DELAY_MS;
      inflightRecords = [];
      inflightDaily = new Map();
      inflightLedger = new Map();
    } catch {
      flushDelayMs = Math.min(FLUSH_DELAY_MAX_MS, Math.round(flushDelayMs * 2));
      // 失败重试：只把尚未成功写入的数据并回缓冲（最多 3 轮，之后丢弃，避免堵塞内存）
      if (retries < MAX_RETRIES) {
        retries++;
        if (records.length > 0) {
          bufferedRecords = inflightRecords.concat(bufferedRecords).slice(-MAX_BUFFERED_RECORDS * 2);
        }
        for (const [date, delta] of inflightDaily) {
          const target = bufferedDaily.get(date) || newDeltaFor();
          mergeDelta(target, delta);
          bufferedDaily.set(date, target);
        }
        for (const [scope, entries] of inflightLedger) {
          const target = bufferedLedger.get(scope) || [];
          bufferedLedger.set(scope, entries.concat(target));
        }
      }
      inflightRecords = [];
      inflightDaily = new Map();
      inflightLedger = new Map();
    } finally {
      flushing = null;
    }
  })();

  return flushing.finally(() => {
    if (hasPending()) scheduleFlush(env);
  });
}
