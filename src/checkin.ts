/**
 * OAuth 渠道每日签到的统一编排
 *
 * 设计目标：新增一个支持签到的渠道时，只需要在 CHANNELS 里注册一个 runner，
 * 控制台开关、全站心跳、手动触发、账号池展示都会自动带上，不用再写一遍调度逻辑。
 *
 * 当前支持：
 *  - codebuddy：CodeBuddy / WorkBuddy（国内版 + 国际版共用）
 *
 * 触发入口：
 *  - 全站心跳 GET /api/monitor/video（09:00 后当日首次，见 maybeRunDailyCheckin）
 *  - 控制台「立即签到」（force，跳过去重）
 *  - 独立补签入口 GET /api/monitor/checkin
 *
 * 每个渠道的开关存在 Blob 的 checkin:config 里，**默认全部开启**；
 * 关闭后心跳与手动触发都会跳过该渠道。
 */
import type { Env, ProviderRecord } from "./types";
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

export type CheckinChannelResult = {
  type: string;
  label: string;
  providerId: string;
  providerName: string;
  accounts: CheckinAccountResult[];
};

export type CheckinRunResult = {
  ran: boolean;
  day: string;
  skipped?: string;
  channels: CheckinChannelResult[];
  /** 兼容旧字段：与 channels 同源 */
  providers: CheckinChannelResult[];
  total: number;
  success: number;
};

const CFG_KEY = "checkin:config";
const dayKey = (type: string) => `checkin:day:${type}`;

export type CheckinConfig = { disabled: string[] };

/** 北京时间日期（签到窗口按东八区算，避免 UTC 跨日重复） */
function cstDay(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 北京时间整点（0-23），用于把签到限定在白天的第一个心跳 */
function cstHour(): number {
  return new Date(Date.now() + 8 * 3600_000).getUTCHours();
}

/** 签到最早触发时间（北京时间）：早于该时刻的心跳不签到，避免零点刚过就撞上游刷新窗口 */
const CHECKIN_START_HOUR = 9;

// =====================================================================
// 渠道注册表
// =====================================================================

type ChannelRunner = {
  label: string;
  /** 动作名（签到 / 领额度），用于按钮与提示文案 */
  action: string;
  /** 该渠道在 provider.kind 里的 oauth 类型（oauth:<type>） */
  oauthType: string;
  run: (env: Env, provider: ProviderRecord) => Promise<CheckinAccountResult[]>;
};

/** CodeBuddy / WorkBuddy：逐账号解密 refresh_token 调官方签到 */
async function runCodebuddyProvider(env: Env, provider: ProviderRecord): Promise<CheckinAccountResult[]> {
  const keys = (await getProviderKeysAll(env, provider.id)).filter((k) => k.status === "active");
  if (!keys.length) return [];
  const { checkinCodebuddy } = await import("./oauth/codebuddy");
  return mapLimit(keys, 3, async (k): Promise<CheckinAccountResult> => {
    const base = { keyId: k.id, email: k.email, fingerprint: k.keyFingerprint || k.id.slice(0, 8) };
    try {
      const token = await decryptSecret(env, k.encryptedKey);
      const r = await checkinCodebuddy(env, token, provider.baseUrl);
      return { ...base, ok: r.ok, already: r.already, reward: r.reward, remain: r.remain, message: r.message };
    } catch (err) {
      return { ...base, ok: false, message: (err as Error).message || "签到异常" };
    }
  });
}

/** ZCode（智谱）：领取每日/活动额度包 */
async function runZcodeProvider(env: Env, provider: ProviderRecord): Promise<CheckinAccountResult[]> {
  const keys = (await getProviderKeysAll(env, provider.id)).filter((k) => k.status === "active");
  if (!keys.length) return [];
  const { checkinZcode } = await import("./oauth/zcode");
  return mapLimit(keys, 2, async (k): Promise<CheckinAccountResult> => {
    const base = { keyId: k.id, email: k.email, fingerprint: k.keyFingerprint || k.id.slice(0, 8) };
    try {
      const token = await decryptSecret(env, k.encryptedKey);
      const r = await checkinZcode(env, token);
      return { ...base, ok: r.ok, already: r.already, reward: r.reward, remain: r.remain, message: r.message };
    } catch (err) {
      return { ...base, ok: false, message: (err as Error).message || "签到异常" };
    }
  });
}

const CHANNELS: Record<string, ChannelRunner> = {
  codebuddy: { label: "CodeBuddy / WorkBuddy", action: "签到", oauthType: "codebuddy", run: runCodebuddyProvider },
  zcode: { label: "ZCode (智谱)", action: "领额度", oauthType: "zcode", run: runZcodeProvider },
};

/** 支持签到的渠道清单（供控制台渲染开关） */
export function listCheckinChannels(): Array<{ type: string; label: string; action: string }> {
  return Object.entries(CHANNELS).map(([type, c]) => ({ type, label: c.label, action: c.action }));
}

// =====================================================================
// 配置读写
// =====================================================================

export async function readCheckinConfig(env: Env): Promise<CheckinConfig> {
  try {
    const raw = (await getBlobStore(env).get(CFG_KEY, { type: "json", consistency: "strong" })) as CheckinConfig | null;
    const disabled = Array.isArray(raw?.disabled) ? raw!.disabled.filter((t) => typeof t === "string") : [];
    return { disabled };
  } catch {
    return { disabled: [] };
  }
}

export async function writeCheckinConfig(env: Env, cfg: CheckinConfig): Promise<void> {
  await getBlobStore(env).setJSON(CFG_KEY, { disabled: cfg.disabled });
}

/** 某渠道是否开启自动签到（默认开启） */
export async function isCheckinEnabled(env: Env, type: string): Promise<boolean> {
  const cfg = await readCheckinConfig(env);
  return !cfg.disabled.includes(type);
}

// =====================================================================
// 执行
// =====================================================================

/**
 * 执行签到。
 *  - types 不传则跑所有「已开启」的渠道
 *  - force=true 时忽略当日去重与开关（控制台手动触发用）
 */
export async function runCheckins(
  env: Env,
  opts: { force?: boolean; types?: string[] } = {}
): Promise<CheckinRunResult> {
  const day = cstDay();
  const cfg = await readCheckinConfig(env);
  const allTypes = Object.keys(CHANNELS);
  const wanted = (opts.types && opts.types.length ? opts.types : allTypes).filter((t) => CHANNELS[t]);
  const types = opts.force ? wanted : wanted.filter((t) => !cfg.disabled.includes(t));

  const result: CheckinRunResult = { ran: true, day, channels: [], providers: [], total: 0, success: 0 };
  if (!types.length) {
    return { ...result, ran: false, skipped: "所有渠道的自动签到均已关闭" };
  }

  const providers = await getProviders(env);
  const store = getBlobStore(env);
  let ranAny = false;

  for (const type of types) {
    const runner = CHANNELS[type]!;
    // 当日去重按渠道分别记录，新增渠道不会因为旧日期戳被整体跳过
    if (!opts.force) {
      try {
        const last = (await store.get(dayKey(type), { type: "json", consistency: "strong" })) as { day?: string } | null;
        if (last?.day === day) continue;
      } catch {
        /* 读取失败按未签到处理 */
      }
    }

    const pool = providers.filter((p) => (p.kind || "") === `oauth:${runner.oauthType}`);
    let channelTotal = 0;
    for (const provider of pool) {
      const accounts = await runner.run(env, provider);
      if (!accounts.length) continue;
      ranAny = true;
      result.channels.push({
        type,
        label: runner.label,
        providerId: provider.id,
        providerName: provider.name,
        accounts,
      });
      channelTotal += accounts.length;
      result.total += accounts.length;
      result.success += accounts.filter((a) => a.ok).length;
    }

    if (channelTotal > 0) {
      try {
        await store.setJSON(dayKey(type), { day, at: Date.now(), total: channelTotal });
      } catch {
        /* 落盘失败不影响签到结果 */
      }
    }
  }

  result.providers = result.channels;
  if (!ranAny) {
    return { ...result, ran: false, skipped: `今日（${day}）已签到或无可签到账号` };
  }
  return result;
}

/** 旧入口：只跑 CodeBuddy（保留给既有调用方） */
export async function runCodebuddyCheckinAll(env: Env, opts: { force?: boolean } = {}): Promise<CheckinRunResult> {
  return runCheckins(env, { force: opts.force, types: ["codebuddy"] });
}

/**
 * 供「全站定时任务」调用：已并入 /api/monitor/video 心跳，不需要额外定时器。
 *  - 09:00 之前直接跳过（几乎零成本）
 *  - 当日已签到由各渠道的日期戳挡掉
 */
export async function maybeRunDailyCheckin(env: Env): Promise<{
  ran: boolean;
  skipped?: string;
  total?: number;
  success?: number;
  channels?: number;
}> {
  if (cstHour() < CHECKIN_START_HOUR) return { ran: false, skipped: "未到签到时间（北京时间 09:00 后）" };
  const r = await runCheckins(env);
  return { ran: r.ran, skipped: r.skipped, total: r.total, success: r.success, channels: r.channels.length };
}
