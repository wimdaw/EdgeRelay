/**
 * 站点信息、公告与申诉路由
 */
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Env, HandlerCtx } from "../types";
import { getSettings, json } from "../settings";
import { requireUser } from "../auth";
import { ApiError, ErrorCode, errorResponse } from "../errors";
import { uuid } from "../crypto";
import { appendAppeal, getAppeals, getAnnouncements } from "../storage/db";

export const siteRouter = new Hono<{ Bindings: Env }>();

/** 站点信息：前端直接解构使用，格式严格对齐原版 SiteInfo */
siteRouter.get("/site", async (c) => {
  // 一次性清掉旧版浏览器缓存：旧客户端会先渲染 EdgeRelay 再被 /api/site 改成 Relay。
  // 用 Cookie 保证每个浏览器只清一次，避免每次访问都丢掉静态资源缓存。
  c.header("Cache-Control", "no-store");
  if (!getCookie(c, "gw_cache_reset_v1")) {
    setCookie(c, "gw_cache_reset_v1", "1", { path: "/", maxAge: 31536000, sameSite: "Lax" });
    c.header("Clear-Site-Data", '"cache"');
  }
  const s = await getSettings(c.env);
  return json({
    siteName: s.siteName ?? "Relay",
    siteDescription: s.siteDescription ?? "部署在 EdgeOne 边缘的 AI API 网关",
    siteLogoUrl: s.siteLogoUrl ?? "/logo.png",
    siteHomepage: s.siteHomepage ?? "",
    heroBadge: s.heroBadge ?? "跑在 EdgeOne 全球边缘节点",
    heroTitle: s.heroTitle ?? "部署在 EdgeOne 边缘的合规 AI API 网关",
    heroSubtitle: s.heroSubtitle ?? "用统一 OpenAI 兼容接口，接入、路由和治理多家大模型服务。合法授权上游、透明计费、哈希链审计——面向开发者与企业的正规聚合分发平台。",
    supportEmail: s.supportEmail ?? "hackerxiaow@gmail.com",
    icpNumber: s.icpNumber ?? "待办理",
    copyrightText: s.copyrightText ?? "",
    githubUrl: s.githubUrl ?? "https://github.com/wimdaw/EdgeRelay",
    oauth: {
      github: !!s.oauthGithubEnabled,
      google: !!s.oauthGoogleEnabled,
    },
    smtpEnabled: !!s.smtpEnabled,
  });
});

/** 公告：读取后台真实公告（仅启用项，按时间倒序） */
siteRouter.get("/announcements", async (c) => {
  const list = await getAnnouncements(c.env);
  const announcements = list
    .filter((a) => a.enabled === 1)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 20)
    .map((a) => ({ id: a.id, title: a.title, content: a.content, popup: a.popup, created_at: a.created_at }));
  return json({ announcements });
});

/** 申诉 */
siteRouter.get("/appeals", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const list = await getAppeals(c.env);
    const userAppeals = list.filter((a) => a.userId === user.id);
    return json({ appeals: userAppeals });
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
