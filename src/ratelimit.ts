/**
 * 限流（RPM / TPM / 并发，基于 EdgeOne Blob KV 驱动）
 */
import { getKV, type KVLike } from "./storage/blob-store";
import { sha256Hex } from "./crypto";

const MINUTE = 60;

function windowKey(subject: string, kind: "rpm" | "tpm", ts: number): string {
  const epochMinute = Math.floor(ts / MINUTE);
  return `rl:${kind}:${subject}:${epochMinute}`;
}

async function incrKV(kv: KVLike, key: string, delta: number, ttlSeconds: number): Promise<number> {
  const cur = parseInt((await kv.get(key)) ?? "0", 10);
  const next = cur + delta;
  await kv.put(key, String(next), { expirationTtl: ttlSeconds });
  return next;
}

export type LimitResult = { ok: boolean; retryAfter: number; kind?: "rpm" | "tpm" | "concurrency" | "model_rpm"; reason?: string };

export async function checkRateLimit(
  env: any,
  keyId: string,
  limits: { rpm: number; tpm: number; concurrency: number },
  modelRpm?: number | null,
  modelName?: string
): Promise<LimitResult> {
  const kv = getKV(env);
  const now = Math.floor(Date.now() / 1000);

  // 1. 模型独立 RPM 限流判定
  if (modelRpm === 0) {
    // 显式为 0：该模型完全免除 RPM 限流，直接放行
  } else if (typeof modelRpm === "number" && modelRpm > 0 && modelName) {
    // 模型单独设置了限流阈值
    const mRpmKey = `rl:mrpm:${keyId}:${modelName}:${Math.floor(now / MINUTE)}`;
    const mRpm = await incrKV(kv, mRpmKey, 1, MINUTE * 2);
    if (mRpm > modelRpm) {
      return {
        ok: false,
        retryAfter: MINUTE - (now % MINUTE) + 1,
        kind: "model_rpm",
        reason: `模型 ${modelName} 触发独立限流 (${modelRpm} RPM)，请稍后重试`,
      };
    }
  } else if (limits.rpm > 0) {
    // 未单独设置时，若全局配置了大于 0 的限制，则检查全局 RPM；0 为不限
    const rpm = await incrKV(kv, windowKey(keyId, "rpm", now), 1, MINUTE * 2);
    if (rpm > limits.rpm) {
      return {
        ok: false,
        retryAfter: MINUTE - (now % MINUTE) + 1,
        kind: "rpm",
        reason: `全局 RPM 超限 (${limits.rpm} RPM)，请稍后重试`,
      };
    }
  }

  // 2. 并发限流（若 limits.concurrency <= 0 则代表不限制并发）
  if (limits.concurrency > 0) {
    const concKey = `rl:conc:${keyId}:${Math.floor(now / 30)}`;
    const conc = await incrKV(kv, concKey, 1, 60);
    if (conc > limits.concurrency) {
      return { ok: false, retryAfter: 5, kind: "concurrency", reason: "请求并发数超限，请稍后重试" };
    }
  }

  return { ok: true, retryAfter: 0 };
}

export async function reportTokenUsage(env: any, keyId: string, tokens: number): Promise<void> {
  const kv = getKV(env);
  const now = Math.floor(Date.now() / 1000);
  await incrKV(kv, windowKey(keyId, "tpm", now), tokens, MINUTE * 2);
}

export async function checkTpmBeforeRequest(env: any, keyId: string, limits: { tpm: number }): Promise<boolean> {
  if (limits.tpm <= 0) return true; // <= 0 代表完全不限 TPM
  const kv = getKV(env);
  const now = Math.floor(Date.now() / 1000);
  const used = parseInt((await kv.get(windowKey(keyId, "tpm", now))) ?? "0", 10);
  return used <= limits.tpm;
}

export async function releaseConcurrency(env: any, keyId: string): Promise<void> {
  const kv = getKV(env);
  const now = Math.floor(Date.now() / 1000);
  const key = `rl:conc:${keyId}:${Math.floor(now / 30)}`;
  const cur = parseInt((await kv.get(key)) ?? "0", 10);
  if (cur > 0) await kv.put(key, String(cur - 1), { expirationTtl: 60 });
}

export async function claimSignatureNonce(env: any, sigHash: string, ts: string): Promise<boolean> {
  const kv = getKV(env);
  const key = `nonce:${sigHash}:${ts}`;
  const existing = await kv.get(key);
  if (existing) return false;
  await kv.put(key, "1", { expirationTtl: 600 });
  return true;
}

export async function sigHashOf(sig: string): Promise<string> {
  return (await sha256Hex(sig)).slice(0, 32);
}
