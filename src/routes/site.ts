/**
 * 站点信息、公告与申诉路由
 */
import { Hono } from "hono";
import type { Env, HandlerCtx } from "../types";
import { getSettings, json } from "../settings";
import { requireUser, clientIp } from "../auth";
import { ApiError, ErrorCode, errorResponse } from "../errors";
import { uuid } from "../crypto";
import { appendAppeal, getAppeals } from "../storage/db";

export const siteRouter = new Hono<{ Bindings: Env }>();

/** 站点信息 */
siteRouter.get("/site", async (c) => {
  const s = await getSettings(c.env);
  return json({
    ok: true,
    site: {
      name: s.siteName ?? "EdgeRelay",
      description: s.siteDescription ?? "",
      logoUrl: s.siteLogoUrl ?? "/logo.png",
      homepage: s.siteHomepage ?? "",
      signupsEnabled: s.signupsEnabled,
      requireTosAcceptance: s.requireTosAcceptance,
      privacyPolicyUrl: s.privacyPolicyUrl,
      termsOfServiceUrl: s.termsOfServiceUrl,
    },
  });
});

/** 公告 */
siteRouter.get("/announcements", async (c) => {
  return json({
    ok: true,
    announcements: [
      {
        id: "anno_welcome",
        title: "欢迎使用 EdgeRelay AI API 边缘网关",
        content: "系统已成功迁移并运行于腾讯云 EdgeOne Pages + Blob 强一致性数据库。",
        createdAt: Math.floor(Date.now() / 1000),
      },
    ],
  });
});

/** 申诉 */
siteRouter.get("/appeals", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const list = await getAppeals(c.env);
    const userAppeals = list.filter((a) => a.userId === user.id);
    return json({ ok: true, appeals: userAppeals });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

siteRouter.post("/appeals", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const body = await c.req.json<{ targetType?: string; targetId?: string; reason?: string }>();
    if (!body.reason?.trim()) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "申诉理由不能为空");
    }

    const appeal = {
      id: uuid(),
      userId: user.id,
      targetType: body.targetType || "user_ban",
      targetId: body.targetId,
      reason: body.reason.trim(),
      status: "pending" as const,
      createdAt: Math.floor(Date.now() / 1000),
    };

    await appendAppeal(c.env, appeal);
    return json({ ok: true, appeal });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
