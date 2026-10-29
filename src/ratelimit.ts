/**
 * 限流（RPM / TPM / 并发）—— 进程内内存实现
 *
 * 原实现每个请求要对 EdgeOne Blob 做 3~6 次强一致读写（每次 100ms+），
 * 仅限流就吃掉 300~800ms。限流本身是「近似控制」语义，进程内计数完全够用：
 *  - 热路径零网络往返
 *  - 空闲条目由 sweep 定期回收，内存不会膨胀
 *  - 多实例部署时限流按实例生效（与原 Blob 读改写竞态的实际效果一致，但快几个数量级）
 */
import { sha256Hex } from "./crypto";

const MINUTE = 60;

type WindowCounter = { n: number; resetAt: number };

const rpmCounters = new Map<string, WindowCounter>();
const modelRpmCounters = new Map<string, WindowCounter>();
const tpmCounters = new Map<string, WindowCounter>();
/** 并发计数：keyId -> { n, at }，release 时精确递减 */
const concurrency = new Map<string, { n: number; at: number }>();
const nonces = new Map<string, number>();

let lastSweep = 0;

function sweep(nowMs: number): void {
  if (nowMs - lastSweep < 60_000) return;
  lastSweep = nowMs;
  for (const map of [rpmCounters, modelRpmCounters, tpmCounters]) {
    for (const [key, val] of map) {
      if (val.resetAt <= nowMs) map.delete(key);
    }
  }
  for (const [key, val] of concurrency) {
    if (val.n <= 0 || nowMs - val.at > 120_000) concurrency.delete(key);
  }
  for (const [key, exp] of nonces) {
    if (exp <= nowMs) nonces.delete(key);
  }
}

function bump(map: Map<string, WindowCounter>, key: string, delta: number, windowMs: number, nowMs: number): number {
  const cur = map.get(key);
  if (!cur || cur.resetAt <= nowMs) {
    const next = { n: delta, resetAt: nowMs + windowMs };
    map.set(key, next);
    return delta;
  }
  cur.n += delta;
  return cur.n;
}

export type LimitResult = { ok: boolean; retryAfter: number; kind?: "rpm" | "tpm" | "concurrency" | "model_rpm"; reason?: string };

export async function checkRateLimit(
  env: any,
  keyId: string,
  limits: { rpm: number; tpm: number; concurrency: number },
  modelRpm?: number | null,
  modelName?: string
): Promise<LimitResult> {
  const nowMs = Date.now();
  sweep(nowMs);
  const now = Math.floor(nowMs / 1000);
  const retryAfter = MINUTE - (now % MINUTE) + 1;

  // 1. 模型独立 RPM 限流判定
  if (modelRpm === 0) {
    // 显式为 0：该模型完全免除 RPM 限流，直接放行
  } else if (typeof modelRpm === "number" && modelRpm > 0 && modelName) {
    const minute = Math.floor(now / MINUTE);
    const count = bump(modelRpmCounters, `${keyId}:${modelName}:${minute}`, 1, 2 * 60_000, nowMs);
    if (count > modelRpm) {
      return {
        ok: false,
        retryAfter,
        kind: "model_rpm",
        reason: `模型 ${modelName} 触发独立限流 (${modelRpm} RPM)，请稍后重试`,
      };
    }
  } else if (limits.rpm > 0) {
    const minute = Math.floor(now / MINUTE);
    const count = bump(rpmCounters, `${keyId}:${minute}`, 1, 2 * 60_000, nowMs);
    if (count > limits.rpm) {
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
    const cur = concurrency.get(keyId);
    if (!cur || nowMs - cur.at > 120_000) {
      concurrency.set(keyId, { n: 1, at: nowMs });
    } else {
      cur.n += 1;
      cur.at = nowMs;
      if (cur.n > limits.concurrency) {
        cur.n -= 1;
        return { ok: false, retryAfter: 5, kind: "concurrency", reason: "请求并发数超限，请稍后重试" };
      }
    }
  }

  return { ok: true, retryAfter: 0 };
}

export async function reportTokenUsage(env: any, keyId: string, tokens: number): Promise<void> {
  const nowMs = Date.now();
  sweep(nowMs);
  const minute = Math.floor(nowMs / 60_000);
  bump(tpmCounters, `${keyId}:${minute}`, tokens, 2 * 60_000, nowMs);
}

export async function checkTpmBeforeRequest(env: any, keyId: string, limits: { tpm: number }): Promise<boolean> {
  if (limits.tpm <= 0) return true; // <= 0 代表完全不限 TPM
  const nowMs = Date.now();
  sweep(nowMs);
  const minute = Math.floor(nowMs / 60_000);
  const cur = tpmCounters.get(`${keyId}:${minute}`);
  return (cur?.n ?? 0) <= limits.tpm;
}

export async function releaseConcurrency(env: any, keyId: string): Promise<void> {
  const cur = concurrency.get(keyId);
  if (!cur) return;
  cur.n = Math.max(0, cur.n - 1);
  if (cur.n === 0) concurrency.delete(keyId);
}

export async function claimSignatureNonce(env: any, sigHash: string, ts: string): Promise<boolean> {
  const nowMs = Date.now();
  sweep(nowMs);
  const key = `${sigHash}:${ts}`;
  const exp = nonces.get(key);
  if (exp && exp > nowMs) return false;
  nonces.set(key, nowMs + 600_000);
  return true;
}

export async function sigHashOf(sig: string): Promise<string> {
  return (await sha256Hex(sig)).slice(0, 32);
}
