/**
 * 视频任务管理接口 /api/video/*
 *
 * 面向控制台登录用户（Cookie 会话），与对外 API（/v1/videos，API Key）分开：
 *  - GET    /api/video/tasks      任务列表；管理员看全部，普通用户只看自己
 *  - DELETE /api/video/tasks/:id  删除任务记录（管理员可删任意，普通用户仅限自己）
 *
 * 列表接口顺带刷新未完成任务（每轮最多 6 个），保证面板轮询时状态是活的。
 */
import { Hono } from "hono";
import type { Env, HandlerCtx } from "../types";
import { requireUser } from "../auth";
import { ApiError, ErrorCode, errorResponse } from "../errors";
import { json } from "../settings";
import {
  listVideoTasks,
  refreshVideoTask,
  deleteVideoTask,
  loadVideoTask,
  isTerminalVideoStatus,
  type VideoTaskRecord,
} from "../video";

export const videoManageRouter = new Hono<{ Bindings: Env }>();

/** 每轮刷新上限：避免管理员页面在任务多时把请求拖到超时 */
const MAX_REFRESH_PER_POLL = 6;

function canManageAll(role: string): boolean {
  return role === "superadmin" || role === "admin";
}

function toRow(t: VideoTaskRecord) {
  return {
    id: t.id,
    model: t.model,
    upstream_model: t.upstreamModel,
    status: t.status,
    progress: t.progress,
    url: t.url ?? null,
    error: t.error ?? null,
    seconds: t.seconds ?? null,
    size: t.size ?? null,
    user_id: t.userId,
    user_email: t.userEmail ?? null,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

/** 任务列表：管理员全部，普通用户仅自己；顺带刷新未完成的 */
videoManageRouter.get("/tasks", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const admin = canManageAll(user.role);
    const url = new URL(c.req.url);
    const limitParam = Number(url.searchParams.get("limit") ?? 50);
    const limit = Math.min(200, Math.max(1, Number.isFinite(limitParam) ? limitParam : 50));

    // 默认只看自己的任务；只有管理员显式传 scope=all 才放开全量
    const wantAll = url.searchParams.get("scope") === "all";
    if (wantAll && !admin) {
      throw new ApiError(403, ErrorCode.FORBIDDEN, "仅管理员可查看全部任务");
    }
    const tasks = await listVideoTasks(c.env, { userId: wantAll ? undefined : user.id, limit });

    // 刷新未完成任务（并发上限 3，总量上限 6）
    const pending = tasks.filter((t) => !isTerminalVideoStatus(t.status)).slice(0, MAX_REFRESH_PER_POLL);
    if (pending.length) {
      const chunks: VideoTaskRecord[][] = [];
      for (let i = 0; i < pending.length; i += 3) chunks.push(pending.slice(i, i + 3));
      for (const group of chunks) {
        await Promise.allSettled(group.map((t) => refreshVideoTask(c.env, t)));
      }
    }

    return json({
      ok: true,
      scope: wantAll ? "all" : "own",
      can_view_all: admin,
      role: user.role,
      refreshed_at: Math.floor(Date.now() / 1000),
      tasks: tasks.map(toRow),
    });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 删除任务记录：管理员可删任意，普通用户只能删自己的 */
videoManageRouter.delete("/tasks/:id", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const id = c.req.param("id");
    const rec = await loadVideoTask(c.env, id);
    if (!rec) throw new ApiError(404, ErrorCode.NOT_FOUND, "视频任务不存在或已过期");

    const admin = canManageAll(user.role);
    if (!admin && rec.userId !== user.id) {
      throw new ApiError(403, ErrorCode.FORBIDDEN, "仅能删除自己发起的视频任务");
    }

    await deleteVideoTask(c.env, id);
    return json({ ok: true, deleted: id });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
