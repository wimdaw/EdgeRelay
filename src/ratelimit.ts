/**
 * 限流（RPM / TPM / 并发）—— 单键 Blob 计数 + 请求内合并提交
 *
 * EdgeOne 云函数每次请求都是全新进程，纯内存计数会完全失效，因此回退为 Blob 持久计数；
 * 但同时把所有指标（RPM / TPM / 并发 / 模型 RPM）合并进**同一个键**：
 *  - 一次读取 + 一次写入（收尾时随用量批量提交），把原先 3~6 次读写压成 1 轮
 *  - 变更先记在请求内缓存，由 commitRateLimits 在请求生命周期内 await 落库
 *  - 分钟窗口过期后自动从零开始（新进程读到旧分钟键会被忽略）
 */
import { getBlobStore } from "./storage/blob-store";
import { sha256Hex } from "./crypto";

type RlState = {
  rpm: number;
  tpm: number;
  conc: number;
  modelRpm: Record<string, number>;
};

type RlEntry = { keyId: string; state: RlState; minute: number; dirty: boolean };

/** 请求内状态缓存：keyId -> 当前分钟计数（同请求内多次读写共享） */
const states = new Map<string, RlEntry>();

function rlKey(keyId: string, minute: number): string {
  return `rl:${keyId}:${minute}`;
}

function currentMinute(): number {
  return Math.floor(Date.now() / 60_000);
}

async function loadState(env: any, keyId: string, minute: number): Promise<RlEntry> {
  const cached = states.get(keyId);
  if (cached && cached.minute === minute) return cached;
  const store = getBlobStore(env);
  const raw = await store.get(rlKey(keyId, minute), { type: "json", consistency: "strong" });
  const entry: RlEntry = {
    keyId,
    state:
      raw && typeof raw === "object" && typeof (raw as RlState).rpm === "number"
        ? (raw as RlState)
        : { rpm: 0, tpm: 0, conc: 0, modelRpm: {} },
    minute,
    dirty: false,
  };
  states.set(keyId, entry);
  return entry;
}

/** 把本请求内变更过的限流计数批量落库（收尾时调用，必须 await） */
export async function commitRateLimits(env: any): Promise<void> {
  const entries = Array.from(states.values()).filter((e) => e.dirty);
  if (entries.length === 0) return;
  const store = getBlobStore(env);
  await Promise.all(
    entries.map((e) => store.setJSON(rlKey(e.keyId, e.minute), e.state).catch(() => {}))
  );
  for (const e of entries) e.dirty = false;
}

export type LimitResult = { ok: boolean; retryAfter: number; kind?: "rpm" | "tpm" | "concurrency" | "model_rpm"; reason?: string };

export async function checkRateLimit(
  env: any,
  keyId: string,
  limits: { rpm: number; tpm: number; concurrency: number },
  modelRpm?: number | null,
  modelName?: string
): Promise<LimitResult> {
  const minute = currentMinute();
  const entry = await loadState(env, keyId, minute);
  const retryAfter = 60 - Math.floor((Date.now() % 60_000) / 1000) + 1;

  // 1. 模型独立 RPM 限流判定
  if (modelRpm === 0) {
    // 显式为 0：该模型完全免除 RPM 限流，直接放行
  } else if (typeof modelRpm === "number" && modelRpm > 0 && modelName) {
    entry.dirty = true;
    entry.state.modelRpm[modelName] = (entry.state.modelRpm[modelName] || 0) + 1;
    if (entry.state.modelRpm[modelName] > modelRpm) {
      return {
        ok: false,
        retryAfter,
        kind: "model_rpm",
        reason: `模型 ${modelName} 触发独立限流 (${modelRpm} RPM)，请稍后重试`,
      };
    }
  } else if (limits.rpm > 0) {
    entry.dirty = true;
    entry.state.rpm += 1;
    if (entry.state.rpm > limits.rpm) {
      return {
        ok: false,
        retryAfter,
        kind: "rpm",
        reason: `全局 RPM 超限 (${limits.rpm} RPM)，请稍后重试`,
      };
    }
  }

  // 2. 并发限流（limits.concurrency <= 0 代表不限制）
  if (limits.concurrency > 0) {
    entry.dirty = true;
    entry.state.conc += 1;
    if (entry.state.conc > limits.concurrency) {
      entry.state.conc -= 1;
      return { ok: false, retryAfter: 5, kind: "concurrency", reason: "请求并发数超限，请稍后重试" };
    }
  }

  return { ok: true, retryAfter: 0 };
}

export async function reportTokenUsage(env: any, keyId: string, tokens: number): Promise<void> {
  const minute = currentMinute();
  const entry = await loadState(env, keyId, minute);
  entry.dirty = true;
  entry.state.tpm += tokens;
}

export async function checkTpmBeforeRequest(env: any, keyId: string, limits: { tpm: number }): Promise<boolean> {
  if (limits.tpm <= 0) return true; // <= 0 代表完全不限 TPM
  const minute = currentMinute();
  const entry = await loadState(env, keyId, minute);
  return entry.state.tpm <= limits.tpm;
}

export async function releaseConcurrency(env: any, keyId: string): Promise<void> {
  const minute = currentMinute();
  const entry = await loadState(env, keyId, minute);
  entry.dirty = true;
  entry.state.conc = Math.max(0, entry.state.conc - 1);
}

/** 签名 nonce（请求体签名防重放）：需要跨请求生效，直接走 Blob 单键+过期 */
export async function claimSignatureNonce(env: any, sigHash: string, ts: string): Promise<boolean> {
  const key = `nonce:${sigHash}:${ts}`;
  const store = getBlobStore(env);
  const existing = await store.get(key, { type: "json", consistency: "strong" });
  if (existing) return false;
  await store.setJSON(key, { v: 1, expiresAt: Math.floor(Date.now() / 1000) + 600 });
  return true;
}

export async function sigHashOf(sig: string): Promise<string> {
  return (await sha256Hex(sig)).slice(0, 32);
}
