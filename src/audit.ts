/**
 * 审计日志（哈希链防篡改，EdgeOne Pages + Blob）
 */
import type { HandlerCtx } from "./types";
import { appendAuditLog, verifyAuditChain as dbVerifyAuditChain, getAuditLogs } from "./storage/db";

export type AuditInput = {
  actorUserId?: string | null;
  actorIp?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  meta?: Record<string, unknown>;
};

export async function audit(c: HandlerCtx, input: AuditInput): Promise<void> {
  await appendAuditLog(c.env, input);
}

/** 校验审计链完整性（管理后台可定期执行） */
export async function verifyAuditChain(env: any, limit = 1000): Promise<{ ok: boolean; brokenAt?: string }> {
  const res = await dbVerifyAuditChain(env);
  return { ok: res.valid, brokenAt: res.brokenAt };
}
