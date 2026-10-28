/**
 * 用户资料路由 /api/user/profile
 */
import { Hono } from "hono";
import type { Env, HandlerCtx } from "../types";
import { requireUser, clientIp } from "../auth";
import { ApiError, ErrorCode, errorResponse } from "../errors";
import { hashPassword, verifyPassword } from "../crypto";
import { json } from "../settings";
import { audit } from "../audit";
import { getUserById, updateUser, getBlobStore } from "../storage/db";

export const profileRouter = new Hono<{ Bindings: Env }>();

/** 获取资料 */
profileRouter.get("/", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const u = await requireUser(hCtx);
    const full = await getUserById(c.env, u.id);
    if (!full) throw new ApiError(404, ErrorCode.NOT_FOUND, "用户不存在");

    return json({
      profile: {
        id: full.id,
        email: full.email,
        role: full.role,
        nickname: full.nickname ?? null,
        bio: full.bio ?? null,
        avatarUrl: full.avatarUrl ?? null,
        createdAt: full.createdAt,
      },
    });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 更新昵称/简介 */
profileRouter.patch("/", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const u = await requireUser(hCtx);
    const body = await c.req.json<{ nickname?: string; bio?: string }>();
    const nickname = (body.nickname ?? "").trim();
    const bio = (body.bio ?? "").trim();

    if (nickname.length > 32) throw new ApiError(400, ErrorCode.BAD_REQUEST, "昵称最长 32 字");
    if (bio.length > 200) throw new ApiError(400, ErrorCode.BAD_REQUEST, "简介最长 200 字");

    await updateUser(c.env, u.id, {
      nickname: nickname || undefined,
      bio: bio || undefined,
    });

    await audit(hCtx, {
      actorUserId: u.id,
      actorIp: clientIp(hCtx.req),
      action: "profile.update",
      targetType: "user",
      targetId: u.id,
    });

    return json({ ok: true });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 修改密码 */
profileRouter.put("/", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const u = await requireUser(hCtx);
    const body = await c.req.json<{ oldPassword?: string; newPassword?: string }>();
    if (!body.oldPassword || !body.newPassword) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少旧密码或新密码");
    }
    if (body.newPassword.length < 10) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "新密码至少 10 位");
    }

    const full = await getUserById(c.env, u.id);
    if (!full) throw new ApiError(404, ErrorCode.NOT_FOUND, "用户不存在");

    const ok = await verifyPassword(body.oldPassword, full.passwordHash);
    if (!ok) {
      throw new ApiError(401, ErrorCode.AUTH_INVALID, "旧密码错误");
    }

    const newHash = await hashPassword(body.newPassword);
    await updateUser(c.env, u.id, { passwordHash: newHash });

    await audit(hCtx, {
      actorUserId: u.id,
      actorIp: clientIp(hCtx.req),
      action: "profile.change_password",
      targetType: "user",
      targetId: u.id,
    });

    return json({ ok: true, message: "密码已更新" });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 上传头像（Base64 存入 Blob） */
profileRouter.post("/", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const u = await requireUser(hCtx);
    const body = await c.req.json<{ dataBase64?: string }>();
    if (!body.dataBase64) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少图片数据");

    const store = getBlobStore(c.env);
    const avatarKey = `avatar:${u.id}`;
    await store.set(avatarKey, body.dataBase64);

    const avatarUrl = body.dataBase64;
    await updateUser(c.env, u.id, { avatarUrl });

    return json({ ok: true, avatarUrl });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
