/**
 * CodeBuddy（WorkBuddy）多账号每日签到编排
 *
 * 单个账号的签到逻辑在 src/oauth/codebuddy.ts（checkinCodebuddy），这里只负责：
 *  - 枚举所有 oauth:codebuddy 渠道下的 active 账号
 *  - 解密 refresh_token 并发签到（并发 3，避免触发上游风控）
 *  - 当日去重：同一天重复调用直接返回 skipped，外部定时器即使每分钟打也不会重复签到
 *
 * 触发入口有两个：
 *  - 外部定时器 GET /api/monitor/checkin?token=…（token 由后台签发，建议每天一次）
 *  - 控制台账号池「立即签到」（force=true，跳过去重，便于人工核对）
 */
import type { Env } from "./types";
import { getProviders, getProviderKeysAll } from "./storage/db";
import { decryptSecret } from "./crypto";
import { mapLimit } from "./storage/cache";
import { getBlobStore } from "./storage/blob-store";

export type CheckinAccountResult = {
  keyId: string;
  email?: string;
  fingerprint: string;
  ok: boolean;
  already?: boolean;
  reward?: number;
  remain?: number;
  message?: string;
};

export type CheckinRunResult = {
  ran: boolean;
  day: string;
  skipped?: string;
  providers: Array<{ providerId: string; name: string; accounts: CheckinAccountResult[] }>;
  total: number;
  success: number;
};

const DAY_KEY = "codebuddy:checkin_day";

/** 北京时间日期（签到窗口按东八区算，避免 UTC 跨日重复） */
function cstDay(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

export async function runCodebuddyCheckinAll(
  env: Env,
  opts: { force?: boolean } = {}
): Promise<CheckinRunResult> {
  const day = cstDay();
  const store = getBlobStore(env);

  if (!opts.force) {
    try {
      const last = (await store.get(DAY_KEY, { type: "json", consistency: "strong" })) as { day?: string } | null;
      if (last?.day === day) {
        return { ran: false, day, skipped: `今日（${day}）已签到`, providers: [], total: 0, success: 0 };
      }
    } catch {
      /* 读取失败按未签到处理，宁可多签一次 */
    }
  }

  const providers = (await getProviders(env)).filter((p) => (p.kind || "") === "oauth:codebuddy");
  const { checkinCodebuddy } = await import("./oauth/codebuddy");

  const result: CheckinRunResult = { ran: true, day, providers: [], total: 0, success: 0 };

  for (const provider of providers) {
    const keys = (await getProviderKeysAll(env, provider.id)).filter((k) => k.status === "active");
    if (!keys.length) continue;

    const rows = await mapLimit(keys, 3, async (k): Promise<CheckinAccountResult> => {
      const base = {
        keyId: k.id,
        email: k.email,
        fingerprint: k.keyFingerprint || k.id.slice(0, 8),
      };
      try {
        const token = await decryptSecret(env, k.encryptedKey);
        const r = await checkinCodebuddy(env, token, provider.baseUrl);
        return {
          ...base,
          ok: r.ok,
          already: r.already,
          reward: r.reward,
          remain: r.remain,
          message: r.message,
        };
      } catch (err) {
        return { ...base, ok: false, message: (err as Error).message || "签到异常" };
      }
    });

    result.providers.push({ providerId: provider.id, name: provider.name, accounts: rows });
    result.total += rows.length;
    result.success += rows.filter((r) => r.ok).length;
  }

  // 只有真的跑到了账号才记为「今日已签」，避免空池把当天锁死
  if (result.total > 0) {
    try {
      await store.setJSON(DAY_KEY, { day, at: Date.now(), total: result.total, success: result.success });
    } catch {
      /* 落盘失败不影响签到结果 */
    }
  }
  return result;
}
