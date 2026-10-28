/**
 * 账单与余额路由 /api/billing/*
 */
import { Hono } from "hono";
import type { Env, HandlerCtx } from "../types";
import { requireUser } from "../auth";
import { errorResponse } from "../errors";
import { json } from "../settings";
import { getBalance } from "../billing";
import { getLedgerEntries } from "../storage/db";

export const billingRouter = new Hono<{ Bindings: Env }>();

/** 查询余额 */
billingRouter.get("/balance", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const bal = await getBalance(c.env, `user:${user.id}`);
    return json({ ok: true, balance: bal });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 账单流水（支持 CSV 导出） */
billingRouter.get("/ledger", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const scope = `user:${user.id}`;
    const limit = Math.min(Number(c.req.query("limit")) || 100, 500);
    const format = c.req.query("format") || "json";

    const entries = await getLedgerEntries(c.env, scope, limit);

    if (format === "csv") {
      let csv = "时间,类型,金额,变动后余额,请求ID,备注\n";
      for (const e of entries) {
        const timeStr = new Date(e.createdAt * 1000).toISOString();
        csv += `"${timeStr}","${e.type}",${e.amount},${e.balanceAfter},"${e.requestId || ""}","${e.memo || ""}"\n`;
      }
      return new Response(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="ledger-${user.id}.csv"`,
        },
      });
    }

    return json({ ok: true, entries });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 用户卡密兑换加款 */
billingRouter.post("/redeem", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const body = await c.req.json<{ code?: string }>();
    const codeStr = (body.code || "").trim().toUpperCase();
    if (!codeStr) {
      throw new (await import("../errors")).ApiError(400, (await import("../errors")).ErrorCode.BAD_REQUEST, "请输入卡密兑换码");
    }

    const { redeemCodeAtomic, updateUser, getUserById } = await import("../storage/db");
    const { topup } = await import("../billing");
    const result = await redeemCodeAtomic(c.env, codeStr, user.id, user.email);

    // 1. 记账加款
    await topup(hCtx, `user:${user.id}`, result.amount, `使用卡密 [${codeStr}] 兑换充值`);

    // 2. 若卡密设置了自动升级 VIP，且当前用户角色为普通用户 (user)，自动升级为 VIP
    const currentUser = await getUserById(c.env, user.id);
    let role = currentUser?.role || user.role;
    let upgraded = false;
    if (result.autoVip && role === "user") {
      await updateUser(c.env, user.id, { role: "vip" });
      role = "vip";
      upgraded = true;
    }

    const bal = await getBalance(c.env, `user:${user.id}`);

    const { audit } = await import("../audit");
    const { clientIp } = await import("../auth");
    await audit(hCtx, {
      actorUserId: user.id,
      actorIp: clientIp(hCtx.req),
      action: "billing.redeem",
      targetType: "redeem_code",
      targetId: result.id,
      meta: { code: codeStr, amount: result.amount, autoVip: result.autoVip, upgraded },
    }).catch(() => {});

    return json({
      ok: true,
      amount: result.amount,
      balance: bal.available,
      currency: bal.currency,
      role,
      upgraded,
      message: `恭喜！已成功兑换充值 ¥${result.amount.toFixed(2)}${upgraded ? "，并已为您自动升级为 VIP 账号！" : "！"}`,
    });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
