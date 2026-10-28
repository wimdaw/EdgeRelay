/**
 * 用户认证与会话路由 /api/auth/*
 */
import { Hono } from "hono";
import type { Env, HandlerCtx, UserRecord } from "../types";
import { ApiError, ErrorCode, errorResponse } from "../errors";
import { uuid, hashPassword, verifyPassword } from "../crypto";
import { getSettings, assertTosAccepted, json } from "../settings";
import { audit } from "../audit";
import { clientIp, sessionCookie, clearCookie, requireUser, requireRole } from "../auth";
import {
  getUserByEmail,
  getUserById,
  createUser,
  updateUser,
  createSession,
  deleteSession,
  getOrCreateBalance,
} from "../storage/db";
import { topup } from "../billing";

export const authRouter = new Hono<{ Bindings: Env }>();

/** 注册 */
authRouter.post("/register", async (c) => {
  const env = c.env;
  const hCtx: HandlerCtx = { env, req: c.req as any };

  try {
    const settings = await getSettings(env);
    const body = await c.req.json<{
      email?: string;
      password?: string;
      inviteCode?: string;
      tosAccepted?: boolean;
      privacyAccepted?: boolean;
    }>();

    if (!body.email || !/^\S+@\S+\.\S+$/.test(body.email)) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "邮箱格式不正确");
    }
    if (!body.password || body.password.length < 10) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "密码至少 10 位");
    }

    assertTosAccepted(body, settings);

    const existing = await getUserByEmail(env, body.email);
    if (existing) {
      throw new ApiError(409, ErrorCode.BAD_REQUEST, "邮箱已注册");
    }

    const now = Math.floor(Date.now() / 1000);
    const id = uuid();

    const newUser: UserRecord = {
      id,
      email: body.email.trim().toLowerCase(),
      passwordHash: await hashPassword(body.password),
      role: "user", // createUser 内部会自动将第 1 个用户升为 admin
      status: "active",
      tosAcceptedAt: body.tosAccepted ? now : undefined,
      privacyAcceptedAt: body.privacyAccepted ? now : undefined,
      createdAt: now,
      updatedAt: now,
    };

    newUser.inviteCode = id.slice(0, 8).toUpperCase();

    await createUser(env, newUser);

    // 发放新用户注册奖励
    const regReward = settings.inviteRegisterReward ?? 0;
    if (regReward > 0) {
      await topup(hCtx, `user:${id}`, regReward, "新人注册奖励");
    }

    // 自动登录
    const sid = uuid();
    const maxAge = settings.persistentSession ? 315360000 : 604800; // 10年 or 7天
    await createSession(env, {
      id: sid,
      userId: id,
      createdAt: now,
      expiresAt: now + maxAge,
      ip: clientIp(hCtx.req),
      userAgent: c.req.header("user-agent"),
    });

    await audit(hCtx, {
      actorUserId: id,
      actorIp: clientIp(hCtx.req),
      action: "auth.register",
      targetType: "user",
      targetId: id,
      meta: { email: body.email, role: newUser.role },
    });

    const secret = String(env.SESSION_SECRET || "edgerelay-default-session-secret-32b");
    // 严格对齐前端期望的返回格式：{ id, email }
    const resp = json({ id, email: newUser.email }, 201);
    return await sessionCookie(resp, secret, sid, maxAge);
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 登录 */
authRouter.post("/login", async (c) => {
  const env = c.env;
  const hCtx: HandlerCtx = { env, req: c.req as any };

  try {
    const body = await c.req.json<{ email?: string; password?: string }>();
    if (!body.email || !body.password) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少邮箱或密码");
    }

    const user = await getUserByEmail(env, body.email);
    if (!user) {
      throw new ApiError(401, ErrorCode.AUTH_INVALID, "邮箱或密码错误");
    }
    if (user.status === "banned") {
      throw new ApiError(403, ErrorCode.FORBIDDEN, "账号已被封禁");
    }

    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) {
      throw new ApiError(401, ErrorCode.AUTH_INVALID, "邮箱或密码错误");
    }

    const settings = await getSettings(env);
    const sid = uuid();
    const now = Math.floor(Date.now() / 1000);
    const maxAge = settings.persistentSession ? 315360000 : 604800;

    await createSession(env, {
      id: sid,
      userId: user.id,
      createdAt: now,
      expiresAt: now + maxAge,
      ip: clientIp(hCtx.req),
      userAgent: c.req.header("user-agent"),
    });

    await audit(hCtx, {
      actorUserId: user.id,
      actorIp: clientIp(hCtx.req),
      action: "auth.login",
      targetType: "user",
      targetId: user.id,
      meta: { email: user.email },
    });

    const secret = String(env.SESSION_SECRET || "edgerelay-default-session-secret-32b");
    // 严格对齐前端期望的返回格式：{ id, email }
    const resp = json({ id: user.id, email: user.email });
    return await sessionCookie(resp, secret, sid, maxAge);
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 登出 */
authRouter.post("/logout", async (c) => {
  const cookie = c.req.header("cookie") ?? "";
  const m = cookie.match(/gw_session=([^;]+)/);
  if (m) {
    const [sid] = m[1]!.split(".");
    if (sid) {
      await deleteSession(c.env, sid);
    }
  }
  return clearCookie(json({ ok: true }));
});

/** 当前登录态与余额：严格对齐前端 Me 结构 */
authRouter.get("/me", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const u = await requireUser(hCtx);
    const full = await getUserById(c.env, u.id);
    const bal = await getOrCreateBalance(c.env, `user:${u.id}`);
    return json({
      user: {
        id: u.id,
        email: u.email,
        role: u.role,
      },
      nickname: full?.nickname ?? null,
      bio: full?.bio ?? null,
      avatarUrl: full?.avatarUrl ?? null,
      balance: {
        available: bal.available ?? 0,
        frozen: bal.frozen ?? 0,
        currency: bal.currency ?? "CNY",
      },
    });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 管理接口二次验证 Step-up */
authRouter.post("/stepup", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const u = await requireUser(hCtx);
    requireRole(u, ["admin"]);
    const body = await c.req.json<{ password?: string }>();
    if (!body.password) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "请输入当前密码完成二次验证");
    }
    const full = await getUserById(c.env, u.id);
    if (!full) throw new ApiError(401, ErrorCode.AUTH_REQUIRED, "用户不存在");

    const ok = await verifyPassword(body.password, full.passwordHash);
    if (!ok) throw new ApiError(401, ErrorCode.AUTH_INVALID, "密码错误");

    const until = Math.floor(Date.now() / 1000) + 600; // 10 分钟
    await updateUser(c.env, u.id, { stepUpUntil: until });

    await audit(hCtx, {
      actorUserId: u.id,
      actorIp: clientIp(hCtx.req),
      action: "auth.stepup_success",
      targetType: "user",
      targetId: u.id,
    });

    return json({ ok: true, stepUpUntil: until });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
