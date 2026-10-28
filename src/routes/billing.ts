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
