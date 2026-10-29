/**
 * 计费与额度 (EdgeOne Pages + Blob)
 *  - 请求前：按 max_tokens 估算冻结额度（hold），余额不足抛 402
 *  - 响应后：按实际 usage 结算（capture），差额解冻（release）
 *  - 全部变动写 ledger 流水，可对账/导出
 *  - Key 级额度在认证层已检查（api_keys.spentUsd）
 *
 * 运行环境适配：EdgeOne 每次请求都是全新进程，余额与账本**必须在本请求内 await 落库**；
 * 余额单键写 + 账本按 scope 分组批量读改写，全部并行，付费调用也只多 1~2 轮往返。
 * 零费用调用（免费模型）完全跳过余额/账本，热路径零计费开销。
 */
import type { HandlerCtx } from "./types";
import { ApiError, ErrorCode } from "./errors";
import { uuid } from "./crypto";
import {
  getAllPricing,
  getOrCreateBalance,
  updateBalance,
  appendLedgerEntries,
  touchApiKeyUsage,
} from "./storage/db";

export type Pricing = {
  publicName: string;
  inputPerMillion: number;
  outputPerMillion: number;
  currency: string;
  rpmLimit?: number | null;
};

export function estimateCost(p: Pricing, promptTokens: number, completionTokens: number): number {
  return (promptTokens / 1_000_000) * p.inputPerMillion + (completionTokens / 1_000_000) * p.outputPerMillion;
}

export async function getPricing(env: any, publicName: string): Promise<Pricing | null> {
  const map = await getAllPricing(env);
  const p = map[publicName];
  return p
    ? {
        publicName: p.publicName,
        inputPerMillion: p.inputPerMillion,
        outputPerMillion: p.outputPerMillion,
        currency: p.currency,
        rpmLimit: p.rpmLimit,
      }
    : null;
}

export async function getBalance(env: any, scope: string): Promise<{ available: number; frozen: number; currency: string }> {
  const b = await getOrCreateBalance(env, scope);
  return { available: b.available, frozen: b.frozen, currency: b.currency };
}

/** 冻结预估额度；超级管理员为铸币方，额度无上限且不做钱包冻结/扣减 */
export async function hold(
  c: HandlerCtx,
  scope: string,
  amount: number,
  requestId: string,
  userRole?: string
): Promise<{ holdId: string }> {
  // 超级管理员不占用钱包额度（调用用量仍会通过 settle 写入账本流水）
  if (userRole === "superadmin") return { holdId: "" };
  if (amount <= 0) return { holdId: "" };
  const bal = await getOrCreateBalance(c.env, scope);

  if (bal.available - bal.frozen < amount) {
    throw new ApiError(402, ErrorCode.INSUFFICIENT_BALANCE, "余额不足，请充值", {
      available: bal.available,
      frozen: bal.frozen,
      required: amount,
    });
  }

  const holdId = uuid();
  const now = Math.floor(Date.now() / 1000);

  bal.frozen += amount;
  // 余额写 + 账本单条，同一请求内并行落库
  await Promise.all([
    updateBalance(c.env, scope, bal),
    appendLedgerEntries(c.env, [
      {
        id: holdId,
        scope,
        type: "hold",
        amount,
        balanceAfter: bal.available - bal.frozen,
        requestId,
        memo: `hold ${amount.toFixed(6)}`,
        createdAt: now,
      },
    ]),
  ]);

  return { holdId };
}

/** 结算：按实际费用 capture，并释放剩余冻结 */
export async function settle(
  c: HandlerCtx,
  args: { scope: string; holdId: string; heldAmount: number; actualCost: number; requestId: string; userId: string; apiKeyId?: string; unlimited?: boolean }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const releaseAmount = Math.max(0, args.heldAmount - args.actualCost);
  // 零费用调用（免费模型）完全跳过余额与账本
  if (args.unlimited ? releaseAmount <= 0 && args.actualCost <= 0 : args.heldAmount <= 0 && args.actualCost <= 0) {
    return;
  }

  const bal = await getOrCreateBalance(c.env, args.scope);
  const entries: {
    id: string;
    scope: string;
    userId?: string | null;
    type: "hold" | "capture" | "release" | "topup" | "adjustment" | "refund";
    amount: number;
    balanceAfter: number;
    requestId?: string | null;
    memo?: string | null;
    createdAt: number;
  }[] = [];

  let extraJobs: Promise<unknown>[] = [];

  if (!args.unlimited) {
    bal.available -= args.actualCost;
    bal.frozen = Math.max(0, bal.frozen - args.heldAmount);
    extraJobs.push(updateBalance(c.env, args.scope, bal));

    // 扣费后若余额归零或为负，自动降级为普通用户 (user)
    if (bal.available <= 0 && args.userId) {
      const { syncUserVipStatus } = await import("./storage/db");
      syncUserVipStatus(c.env, args.userId, bal.available).catch(() => {});
    }
  }

  // 1. 记 capture（超级管理员虽不占用额度，但仍记录真实用量与费用流水，保证账目清晰）
  entries.push({
    id: uuid(),
    scope: args.scope,
    userId: args.userId,
    type: "capture",
    amount: args.actualCost,
    balanceAfter: args.unlimited ? 0 : bal.available,
    requestId: args.requestId,
    memo: args.unlimited ? `capture ${args.actualCost.toFixed(6)}（超管无限额度，仅记流水）` : `capture ${args.actualCost.toFixed(6)}`,
    createdAt: now,
  });

  // 2. 记 release 差额
  if (releaseAmount > 0) {
    entries.push({
      id: uuid(),
      scope: args.scope,
      userId: args.userId,
      type: "release",
      amount: releaseAmount,
      balanceAfter: bal.available,
      requestId: args.requestId,
      memo: `release ${releaseAmount.toFixed(6)}`,
      createdAt: now,
    });
  }

  // 3. 更新 key 的 spentUsd（请求内内存可见，收尾随用量批量落库）
  if (args.apiKeyId && args.actualCost > 0) {
    touchApiKeyUsage(c.env, args.apiKeyId, { spentDelta: args.actualCost });
  }

  await Promise.all([...extraJobs, appendLedgerEntries(c.env, entries)]);
}

/** 请求失败时全额解冻 */
export async function releaseHold(c: HandlerCtx, scope: string, holdId: string, heldAmount: number, requestId: string): Promise<void> {
  if (!holdId || heldAmount <= 0) return;
  const now = Math.floor(Date.now() / 1000);
  const bal = await getOrCreateBalance(c.env, scope);
  bal.frozen = Math.max(0, bal.frozen - heldAmount);

  await Promise.all([
    updateBalance(c.env, scope, bal),
    appendLedgerEntries(c.env, [
      {
        id: uuid(),
        scope,
        type: "release",
        amount: heldAmount,
        balanceAfter: bal.available - bal.frozen,
        requestId,
        memo: `release on failure ${heldAmount.toFixed(6)}`,
        createdAt: now,
      },
    ]),
  ]);
}

/** 充值/调整（管理员或支付回调调用）：立即落库，跨请求立刻可见 */
export async function topup(c: HandlerCtx, scope: string, amount: number, memo: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const bal = await getOrCreateBalance(c.env, scope);
  bal.available += amount;
  await updateBalance(c.env, scope, bal);

  await appendLedgerEntries(c.env, [
    {
      id: uuid(),
      scope,
      type: amount >= 0 ? "topup" : "adjustment",
      amount,
      balanceAfter: bal.available,
      memo,
      createdAt: now,
    },
  ]);
}