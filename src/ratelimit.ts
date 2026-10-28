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

export type LimitResult = { ok: boolean; retryAfter: number; kind?: "rpm" | "tpm" | "concurrency" };

export async function checkRateLimit(
  env: any,
  keyId: string,
  limits: { rpm: number; tpm: number; concurrency: number }
): Promise<LimitResult> {
  const kv = getKV(env);
  const now = Math.floor(Date.now() / 1000);
  const rpm = await incrKV(kv, windowKey(keyId, "rpm", now), 1, MINUTE * 2);
  if (rpm > limits.rpm) return { ok: false, retryAfter: MINUTE - (now % MINUTE) + 1, kind: "rpm" };

  const concKey = `rl:conc:${keyId}:${Math.floor(now / 30)}`;
  const conc = await incrKV(kv, concKey, 1, 60);
  if (conc > limits.concurrency) {
    return { ok: false, retryAfter: 5, kind: "concurrency" };
  }
  return { ok: true, retryAfter: 0 };
}

export async function reportTokenUsage(env: any, keyId: string, tokens: number): Promise<void> {
  const kv = getKV(env);
  const now = Math.floor(Date.now() / 1000);
  await incrKV(kv, windowKey(keyId, "tpm", now), tokens, MINUTE * 2);
}

export async function checkTpmBeforeRequest(env: any, keyId: string, limits: { tpm: number }): Promise<boolean> {
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
