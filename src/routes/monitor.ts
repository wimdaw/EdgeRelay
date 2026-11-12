/**
 * 外部监控入口 /api/monitor/video
 *
 * 给 cron-job.org / UptimeRobot 这类外部定时器直接调用的免凭据接口：
 *  - 用签名 token 鉴权（GET /api/monitor/video?token=xxx），token 由后台生成，默认 30 天
 *  - 每次调用扫描未完成的视频任务，实时回查上游并落库
 *  - 返回本轮「新完成」的任务（含视频地址），便于监控端做告警/通知
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { ApiError, ErrorCode, errorResponse } from "../errors";
import { verifyVideoToken } from "../video";
import { listVideoTasks, refreshVideoTask, isTerminalVideoStatus, isWaitingSlot } from "../video";
import { retryQueuedVideoTask } from "./video";

export const monitorRouter = new Hono<{ Bindings: Env }>();

/** 监控 token 的签名主体（复用视频 token 的 HMAC 方案） */
export const VIDEO_MONITOR_SUBJECT = "__video_monitor__";

monitorRouter.get("/video", async (c) => {
  const env = c.env;
  try {
    if (!(await verifyVideoToken(env, VIDEO_MONITOR_SUBJECT, c.req.query("token")))) {
      throw new ApiError(403, ErrorCode.FORBIDDEN, "监控链接无效或已过期");
    }

    const all = await listVideoTasks(env, { limit: 50 });
    const pending = all.filter((t) => !isTerminalVideoStatus(t.status)).slice(0, 15);
    const completed: any[] = [];
    const refreshed: any[] = [];
    let retried = 0;

    for (const t of pending) {
      // 排队等空位的任务没有上游任务号，回查没意义：由这里负责按 60s 节奏重投，
      // 外部定时器（cron-job / UptimeRobot 打这个地址）就是整站的心跳。
      const beforeRetry = t.retryCount ?? 0;
      const r = isWaitingSlot(t) ? await retryQueuedVideoTask(env, t) : await refreshVideoTask(env, t);
      if ((r.retryCount ?? 0) > beforeRetry) retried++;
      refreshed.push({
        id: r.id,
        model: r.model,
        status: r.status,
        progress: r.progress,
        url: r.url ?? null,
        error: r.error ?? null,
        waiting_slot: isWaitingSlot(r),
        retry_count: r.retryCount ?? 0,
        next_retry_at: r.nextRetryAt ?? null,
        created_at: r.createdAt,
      });
      if (isTerminalVideoStatus(r.status)) {
        completed.push({
          id: r.id,
          status: r.status,
          model: r.model,
          url: r.url ?? null,
          error: r.error ?? null,
          created_at: r.createdAt,
        });
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        scanned: all.length,
        pending: pending.length - completed.length,
        queue_waiting: refreshed.filter((x) => x.waiting_slot).length,
        retried,
        newly_completed: completed,
        tasks: all.slice(0, 20).map((t) => {
          const fresh = refreshed.find((x) => x.id === t.id);
          return (
            fresh ?? {
              id: t.id,
              model: t.model,
              status: t.status,
              progress: t.progress,
              url: t.url ?? null,
              error: t.error ?? null,
              created_at: t.createdAt,
            }
          );
        }),
        checked_at: Math.floor(Date.now() / 1000),
      }),
      { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }
    );
  } catch (err) {
    return errorResponse(c, err);
  }
});
