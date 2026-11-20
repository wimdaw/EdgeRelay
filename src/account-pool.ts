/**
 * 账号池：聚合 OAuth / Web 反代渠道的账号与额度信息
 *
 * 额度查询按渠道能力区分：
 *  - antigravity：Google 官方 fetchAvailableModels，返回各模型剩余配额
 *  - cline：官方 /users/me + balance，返回 Credit 余额与今日调用量
 *  - codebuddy：官方积分接口，返回剩余/已用/总量
 *  - chatgptweb：读取 access_token JWT，返回账号邮箱与套餐
 *  - codex：ChatGPT wham/usage，返回套餐、按上游 window_minutes 换算的窗口与 Credits
 *  - 其余渠道：无额度接口，仅展示账号与健康状态
 */
import type { Env, ProviderRecord } from "./types";
import { getProviderKeysAll, updateProviderKeyEmail } from "./storage/db";
import { readKeyHealth } from "./key-health";
import { decryptSecret } from "./crypto";
import { mapLimit } from "./storage/cache";
import { WEB_PROVIDERS, type WebProviderType } from "./web";

export type AccountQuota = {
  type: "antigravity" | "cline" | "codebuddy" | "chatgptweb" | "codex" | "zcode" | "unknown";
  ok: boolean;
  email?: string;
  name?: string;
  plan?: string;
  note?: string;
  error?: string;
  balance?: number;
  remain?: number;
  used?: number;
  size?: number;
  requestsToday?: number;
  models?: Array<{ id: string; name?: string; remaining: number | null; resetTime?: string; recommended?: boolean }>;
  windows?: Array<{ label: string; usedPercent: number; remainPercent: number; windowMinutes?: number; resetTime?: string }>;
  credits?: { hasCredits: boolean; balance?: number; unlimited?: boolean };
  /** zcode：billing/balance 的额度列表（balances 平面，JWT 身份可见的部分） */
  zcodeBalances?: Array<{ showName: string; remaining: number; total: number; used: number; unitType?: string; expiresAt?: number }>;
  /** zcode：当前可领取的套餐包数量 */
  claimableCount?: number;
};

export type AccountPoolAccount = {
  id: string;
  label: string;
  fingerprint: string;
  status: "active" | "disabled";
  health: "healthy" | "unhealthy" | "demoted";
  failures: number;
  quota: AccountQuota | null;
};

export type AccountPoolProvider = {
  id: string;
  name: string;
  slug: string;
  kind: string;
  status: "active" | "disabled";
  accounts: AccountPoolAccount[];
  /** 该渠道是否支持自动签到，以及当前是否开启（未注册签到的渠道为 undefined） */
  checkin?: { supported: boolean; enabled: boolean; label?: string; action?: string };
};

function kindType(kind?: string | null): { scope: "oauth" | "web"; type: string } | null {
  if (!kind) return null;
  if (kind.startsWith("oauth:")) return { scope: "oauth", type: kind.slice(6) };
  if (kind.startsWith("web:")) return { scope: "web", type: kind.slice(4) };
  return null;
}

export async function buildAccountPool(env: Env, providers: ProviderRecord[]): Promise<AccountPoolProvider[]> {
  const out: AccountPoolProvider[] = [];
  // 签到能力与开关：由 src/checkin.ts 的注册表统一提供，账号池只负责展示
  const { listCheckinChannels, readCheckinConfig } = await import("./checkin");
  const checkinChannels = listCheckinChannels();
  const checkinCfg = await readCheckinConfig(env);
  const checkinState = (type: string) => {
    const meta = checkinChannels.find((c) => c.type === type);
    if (!meta) return undefined;
    return { supported: true, enabled: !checkinCfg.disabled.includes(type), label: meta.label, action: meta.action };
  };

  for (const provider of providers) {
    const info = kindType(provider.kind);
    if (!info) continue;
    const keys = await getProviderKeysAll(env, provider.id);

    // 匿名 Web 渠道（如 geminiweb）不使用账号凭据，零 Key 时不进账号池；
    // 一旦补了凭据则照常展示
    if (info.scope === "web" && keys.length === 0 && WEB_PROVIDERS[info.type as WebProviderType]?.anonymous) {
      continue;
    }

    const health = await readKeyHealth(env, provider.id);

    // 解密凭据（同进程内有明文缓存）
    const plaintexts: string[] = [];
    for (const k of keys) {
      try {
        plaintexts.push(await decryptSecret(env, k.encryptedKey));
      } catch {
        plaintexts.push("");
      }
    }

    let quotas: (AccountQuota | null)[] = keys.map(() => null);
    try {
      if (info.type === "antigravity") {
        const { fetchAntigravityQuota } = await import("./oauth/antigravity");
        const pairs = keys.map((k, i) => ({ key: k, token: plaintexts[i]! })).filter((x) => x.token);
        const rows = await fetchAntigravityQuota(env, pairs.map((x) => x.token));
        const byId = new Map(pairs.map((x, idx) => [x.key.id, rows[idx]]));
        quotas = keys.map((k) => {
          const r = byId.get(k.id);
          if (!r) return null;
          return {
            type: "antigravity" as const,
            ok: r.ok,
            email: r.email,
            plan: r.paidTier && r.paidTierId !== "free-tier" ? r.paidTier : r.tier,
            note: r.ineligible || r.tierNote,
            error: r.error,
            models: r.models.map((m) => ({ id: m.id, name: m.name, remaining: m.remaining, resetTime: m.resetTime, recommended: m.recommended })),
          };
        });
      } else if (info.type === "cline") {
        const { fetchClineKeyQuota } = await import("./oauth/cline");
        const pairs = keys.map((k, i) => ({ key: k, token: plaintexts[i]! })).filter((x) => x.token);
        const rows = await mapLimit(pairs, 4, async (x) => fetchClineKeyQuota(env, x.token));
        const byId = new Map(pairs.map((x, idx) => [x.key.id, rows[idx]]));
        quotas = keys.map((k) => {
          const r = byId.get(k.id);
          if (!r) return null;
          const requestsToday = Object.values(r.usage || {}).reduce((n, u) => n + (u.requests || 0), 0);
          return {
            type: "cline" as const,
            ok: r.ok,
            email: r.email,
            balance: r.balance,
            requestsToday,
            error: r.error,
          };
        });
      } else if (info.type === "codebuddy") {
        const { fetchCodebuddyStatus } = await import("./oauth/codebuddy");
        const pairs = keys.map((k, i) => ({ key: k, token: plaintexts[i]! })).filter((x) => x.token);
        const rows = await mapLimit(pairs, 4, async (x) => fetchCodebuddyStatus(env, x.token, provider.baseUrl));
        const byId = new Map(pairs.map((x, idx) => [x.key.id, rows[idx]]));
        quotas = keys.map((k) => {
          const r = byId.get(k.id);
          if (!r) return null;
          return {
            type: "codebuddy" as const,
            ok: r.ok,
            email: r.nickname || r.uid || undefined,
            remain: r.remain,
            used: r.used,
            size: r.size,
            note: r.packs ? `${r.packs} 个套餐` : undefined,
            error: r.ok ? undefined : r.message || "查询失败",
          };
        });
      } else if (info.type === "codex") {
        const { fetchCodexQuota } = await import("./oauth/codex");
        const pairs = keys.map((k, i) => ({ key: k, token: plaintexts[i]! })).filter((x) => x.token);
        const rows = await mapLimit(pairs, 4, async (x) => fetchCodexQuota(env, x.token));
        const byId = new Map(pairs.map((x, idx) => [x.key.id, rows[idx]]));
        quotas = keys.map((k) => {
          const r = byId.get(k.id);
          if (!r) return null;
          return {
            type: "codex" as const,
            ok: r.ok,
            email: k.email || r.email,
            plan: r.plan,
            error: r.error,
            windows: r.windows,
            credits: r.credits,
          };
        });
        // 老账号（授权时未存邮箱）在本次额度查询拿到邮箱后回填一次，后续直接读记录
        for (const k of keys) {
          const email = byId.get(k.id)?.email;
          if (email && !k.email) await updateProviderKeyEmail(env, provider.id, k.id, email);
        }
      } else if (info.type === "chatgptweb") {
        const { fetchChatgptWebAccountInfo } = await import("./web/chatgptweb");
        const pairs = keys.map((k, i) => ({ key: k, token: plaintexts[i]! })).filter((x) => x.token);
        const rows = await mapLimit(pairs, 5, async (x) => fetchChatgptWebAccountInfo(env, x.token));
        const byId = new Map(pairs.map((x, idx) => [x.key.id, rows[idx]]));
        quotas = keys.map((k) => {
          const r = byId.get(k.id);
          if (!r) return null;
          return {
            type: "chatgptweb" as const,
            ok: r.ok,
            email: r.email,
            name: r.name,
            plan: r.plan,
            note: r.note,
            error: r.error,
          };
        });
      } else if (info.type === "zcode") {
        // billing 平面认 CLI JWT：balances[] 展示真实额度，顺带报告可领包数量
        const { fetchZcodeBalance } = await import("./oauth/zcode");
        const pairs = keys.map((k, i) => ({ key: k, token: plaintexts[i]! })).filter((x) => x.token);
        const rows = await mapLimit(pairs, 4, async (x) => fetchZcodeBalance(env, x.token));
        const byId = new Map(pairs.map((x, idx) => [x.key.id, rows[idx]]));
        quotas = keys.map((k) => {
          const r = byId.get(k.id);
          if (!r) return null;
          return {
            type: "zcode" as const,
            ok: r.ok,
            error: r.error,
            zcodeBalances: r.balances,
            claimableCount: r.claimable.length,
          };
        });
      }
    } catch (err) {
      const error = (err as Error)?.message || "额度查询失败";
      quotas = keys.map(() => ({ type: "unknown" as const, ok: false, error }));
    }

    const accounts: AccountPoolAccount[] = keys.map((k, i) => {
      const h = health[k.id] || health[k.keyFingerprint];
      return {
        id: k.id,
        label: k.label,
        fingerprint: k.keyFingerprint || "—",
        status: k.status,
        health: h?.demotedAt ? "demoted" : h?.failures ? "unhealthy" : "healthy",
        failures: h?.failures || 0,
        quota: quotas[i] ?? null,
      };
    });

    out.push({
      id: provider.id,
      name: provider.name,
      slug: provider.slug,
      kind: provider.kind,
      status: provider.status,
      accounts,
      checkin: checkinState(info.scope === "oauth" ? info.type : ""),
    });
  }

  return out;
}
