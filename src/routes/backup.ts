/**
 * 全站备份 / 恢复路由 /api/admin/backup/*
 *
 * 仅超级管理员可用；导出、导入、快照生成与恢复均要求二次验证。
 * 快照保存在 EdgeOne Blob 内（backup:snapshot:*），不依赖 R2。
 */
import { Hono } from "hono";
import type { Env, HandlerCtx } from "../types";
import { requireUser, requireRole, requireAdminStepUp, clientIp } from "../auth";
import { ApiError, ErrorCode, errorResponse } from "../errors";
import { json } from "../settings";
import { audit } from "../audit";
import {
  buildBackup,
  restoreBackupData,
  createBackupSnapshot,
  listBackupSnapshots,
  restoreBackupSnapshot,
  deleteBackupSnapshot,
  type BackupFile,
} from "../backup";

export const backupRouter = new Hono<{ Bindings: Env }>();

async function requireSuperadmin(hCtx: HandlerCtx) {
  const user = await requireUser(hCtx);
  requireRole(user, ["superadmin"]);
  return user;
}

async function requireSuperadminStepUp(hCtx: HandlerCtx) {
  await requireSuperadmin(hCtx);
  return await requireAdminStepUp(hCtx);
}

function currentSessionId(hCtx: HandlerCtx): string | undefined {
  // Cookie 形如 gw_session=<sid>.<hmac>
  const cookie = hCtx.req.header("cookie") ?? "";
  return cookie.match(/gw_session=([^;.]+)/)?.[1];
}

async function readJsonBody<T>(c: { req: { json<T>(): Promise<T> } }): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new ApiError(400, ErrorCode.BAD_REQUEST, "请求体不是合法的 JSON");
  }
}

/** 导出全站备份为 JSON 文件 */
backupRouter.get("/export", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const admin = await requireSuperadminStepUp(hCtx);
    const data = await buildBackup(c.env);
    const filename = `edgerelay-backup-${data.exportedAt.replace(/[:.]/g, "-")}.json`;

    await audit(hCtx, {
      actorUserId: admin.id,
      actorIp: clientIp(hCtx.req),
      action: "admin.backup_export",
      targetType: "backup",
      meta: { entries: data.entries.length, exportedAt: data.exportedAt },
    });

    return new Response(JSON.stringify(data), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 站内快照列表（只读元数据，不要求二次验证） */
backupRouter.get("/list", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    await requireSuperadmin(hCtx);
    const snapshots = await listBackupSnapshots(c.env);
    return json({ ok: true, snapshots });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 生成站内快照 */
backupRouter.post("/snapshot", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const admin = await requireSuperadminStepUp(hCtx);
    const { snapshot, message } = await createBackupSnapshot(c.env);

    await audit(hCtx, {
      actorUserId: admin.id,
      actorIp: clientIp(hCtx.req),
      action: "admin.backup_snapshot",
      targetType: "backup",
      targetId: snapshot.id,
      meta: { entries: snapshot.entries, size: snapshot.size },
    });

    return json({ ok: true, message, snapshot });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 上传备份文件并覆盖恢复 */
backupRouter.post("/import", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const admin = await requireSuperadminStepUp(hCtx);
    const data = await readJsonBody<BackupFile>(c);
    const result = await restoreBackupData(c.env, data, {
      currentUserId: admin.id,
      currentSessionId: currentSessionId(hCtx),
    });

    await audit(hCtx, {
      actorUserId: admin.id,
      actorIp: clientIp(hCtx.req),
      action: "admin.backup_import",
      targetType: "backup",
      meta: { entries: result.entries, counts: result.counts },
    });

    return json({ ok: true, message: `导入成功：已恢复 ${result.entries} 项数据`, summary: result });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 恢复指定站内快照 */
backupRouter.post("/restore", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const admin = await requireSuperadminStepUp(hCtx);
    const body = await readJsonBody<{ id?: string }>(c);
    const result = await restoreBackupSnapshot(c.env, body.id ?? "", {
      currentUserId: admin.id,
      currentSessionId: currentSessionId(hCtx),
    });

    await audit(hCtx, {
      actorUserId: admin.id,
      actorIp: clientIp(hCtx.req),
      action: "admin.backup_restore",
      targetType: "backup",
      targetId: body.id,
      meta: { entries: result.entries, counts: result.counts },
    });

    return json({ ok: true, message: `快照恢复成功：已恢复 ${result.entries} 项数据`, summary: result });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 删除指定站内快照 */
backupRouter.post("/delete", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const admin = await requireSuperadminStepUp(hCtx);
    const body = await readJsonBody<{ id?: string }>(c);
    await deleteBackupSnapshot(c.env, body.id ?? "");

    await audit(hCtx, {
      actorUserId: admin.id,
      actorIp: clientIp(hCtx.req),
      action: "admin.backup_delete",
      targetType: "backup",
      targetId: body.id,
    });

    return json({ ok: true, message: "快照已删除" });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
