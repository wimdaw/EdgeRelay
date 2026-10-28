/**
 * 普通用户个人用量统计路由 /api/usage/*
 */
import { Hono } from "hono";
import type { Env, HandlerCtx } from "../types";
import { requireUser } from "../auth";
import { errorResponse } from "../errors";
import { json } from "../settings";
import { getDailyUsage, getUserUsageRecords } from "../storage/db";

export const usageRouter = new Hono<{ Bindings: Env }>();

/** 个人用量概览：对齐前端 Stats 结构 */
usageRouter.get("/summary", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const today = new Date().toISOString().slice(0, 10);
    const records = await getUserUsageRecords(c.env, user.id, today);

    const totalN = records.length;
    const successN = records.filter((r) => r.status === "success").length;
    const errorN = totalN - successN;
    const pt = records.reduce((a, r) => a + (r.promptTokens || 0), 0);
    const ct = records.reduce((a, r) => a + (r.completionTokens || 0), 0);
    const cost = records.reduce((a, r) => a + (r.costUsd || 0), 0);

    const byModelMap: Record<string, { n: number; cost: number }> = {};
    for (const r of records) {
      const m = r.publicModel || "unknown";
      byModelMap[m] = byModelMap[m] || { n: 0, cost: 0 };
      byModelMap[m].n += 1;
      byModelMap[m].cost += r.costUsd || 0;
    }

    const byModelList = Object.entries(byModelMap).map(([public_model, data]) => ({
      public_model,
      n: data.n,
      cost: data.cost,
    }));

    return json({
      requests: totalN,
      errorRate: totalN ? +(errorN / totalN).toFixed(4) : 0,
      promptTokens: pt,
      completionTokens: ct,
      cost,
      currency: "CNY",
      pendingContentFlags: 0,
      byStatus: [
        { status: "success", n: successN },
        { status: "error", n: errorN },
      ],
      byModel: byModelList,
    });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 个人用量走势图：对齐前端 { points: TrendPoint[] } */
usageRouter.get("/trend", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const days = Math.min(Number(c.req.query("days")) || 7, 30);
    const points = [];
    const now = Date.now();

    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 86400 * 1000).toISOString().slice(0, 10);
      const records = await getUserUsageRecords(c.env, user.id, d);
      const requests = records.length;
      const tokens = records.reduce((a, r) => a + (r.promptTokens || 0) + (r.completionTokens || 0), 0);
      const errors = records.filter((r) => r.status !== "success").length;
      const cost = records.reduce((a, r) => a + (r.costUsd || 0), 0);

      points.push({
        date: d,
        requests,
        tokens,
        errors,
        cost,
      });
    }

    return json({ days, points });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 个人用量日志列表：对齐前端 { logs: UsageLog[] } */
usageRouter.get("/logs", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const today = new Date().toISOString().slice(0, 10);
    const records = await getUserUsageRecords(c.env, user.id, today);

    const logs = records.slice(0, 50).map((r) => ({
      id: r.id,
      request_id: r.requestId,
      user_id: r.userId,
      public_model: r.publicModel,
      status: r.status,
      latency_ms: r.latencyMs ?? 0,
      prompt_tokens: r.promptTokens ?? 0,
      completion_tokens: r.completionTokens ?? 0,
      cost_usd: r.costUsd ?? 0,
      stream: r.stream ?? 0,
      error_code: r.errorCode ?? null,
      attempts: r.attempts ?? 1,
      ip: r.ip ?? "",
      created_at: r.createdAt,
    }));

    return json({ logs });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
