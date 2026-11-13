/**
 * 媒体类接口（视频 / 图片）共用的 API Key 认证
 *
 * 与 /v1/chat/completions 的校验口径保持一致：
 * Bearer sk-gw-* → 哈希查库 → 状态/过期/额度 → IP 白名单 → 记录 lastUsedAt
 * 返回限流所需的默认配额（RPM / TPM / 并发）。
 */
import type { Env } from "./types";
import { clientIp } from "./auth";
import { ApiError, ErrorCode } from "./errors";
import { getSettings } from "./settings";
import { sha256Hex } from "./crypto";
import { getApiKeyByHash, touchApiKeyUsage } from "./storage/db";

export type ApiKeyAuth = {
  keyId: string;
  userId: string;
  row: { modelWhitelist?: string | null };
  limits: { rpm: number; tpm: number; concurrency: number };
  ip: string;
};

export async function authenticateSkGwKey(c: any): Promise<ApiKeyAuth> {
  const env = c.env as Env;
  const authHeader = c.req.header("authorization") ?? "";
  const am = authHeader.match(/^Bearer\s+(sk-gw-\S+)$/i);
  if (!am) throw new ApiError(401, ErrorCode.AUTH_REQUIRED, "缺少 Bearer API Key");

  const keyHash = await sha256Hex(am[1]!);
  const nowSec = Math.floor(Date.now() / 1000);
  const [row, settings] = await Promise.all([getApiKeyByHash(env, keyHash), getSettings(env)]);
  if (!row) throw new ApiError(401, ErrorCode.AUTH_INVALID, "API Key 无效");
  if (row.status === "revoked") throw new ApiError(401, ErrorCode.KEY_REVOKED, "API Key 已撤销");
  if (row.expiresAt && row.expiresAt < nowSec) throw new ApiError(401, ErrorCode.KEY_EXPIRED, "API Key 已过期");
  if (row.quotaUsd !== null && row.quotaUsd !== undefined && row.spentUsd >= row.quotaUsd) {
    throw new ApiError(429, ErrorCode.KEY_QUOTA_EXCEEDED, "该 API Key 额度已用尽");
  }

  const ip = clientIp({
    url: c.req.url,
    method: c.req.method,
    header: (n: string) => c.req.header(n),
    text: () => c.req.text(),
    json: () => c.req.json(),
  });

  if (row.ipWhitelist) {
    try {
      const list = JSON.parse(row.ipWhitelist) as string[];
      if (list.length && !list.includes(ip)) {
        throw new ApiError(403, ErrorCode.FORBIDDEN, `来源 IP ${ip} 不在白名单内`);
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
    }
  }

  touchApiKeyUsage(env, row.id, { lastUsedAt: nowSec });

  return {
    keyId: row.id,
    userId: row.userId,
    row,
    limits: { rpm: settings.defaultRpm, tpm: settings.defaultTpm, concurrency: 10 },
    ip,
  };
}

/** 模型白名单校验（支持 slug/model 定向写法；大小写不敏感） */
export function assertModelAllowed(row: { modelWhitelist?: string | null }, publicModel: string): void {
  if (!row.modelWhitelist) return;
  try {
    const whitelist = JSON.parse(row.modelWhitelist) as string[];
    const sub = publicModel.includes("/") ? publicModel.slice(publicModel.indexOf("/") + 1) : publicModel;
    // 大小写不敏感比较：用户写 GLM-4.7-Flash 而白名单登记的是 glm-4.7-flash 时也应放行
    const allowed = whitelist.some(
      (w) => w === publicModel || w === sub || w.toLowerCase() === publicModel.toLowerCase() || w.toLowerCase() === sub.toLowerCase()
    );
    if (Array.isArray(whitelist) && whitelist.length && !allowed) {
      throw new ApiError(403, ErrorCode.MODEL_NOT_ALLOWED, `该 Key 无权调用模型 ${publicModel}`);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
  }
}
