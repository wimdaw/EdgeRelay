/**
 * 用户认证与会话路由 /api/auth/*
 * 支持：邮箱密码注册/登录、SMTP 邮件验证码注册/免密登录、密码重置
 */
import { Hono } from "hono";
import type { Env, HandlerCtx, UserRecord } from "../types";
import { ApiError, ErrorCode, errorResponse } from "../errors";
import { uuid, hashPassword, verifyPassword, decryptSecret } from "../crypto";
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
  hasAnyUser,
} from "../storage/db";
import { topup } from "../billing";
import { sendMail } from "../smtp";
import { verifyCodeEmailHtml } from "../email-templates";
import { getKV } from "../storage/blob-store";
import { checkCode, putCode, CODE_ERROR_MESSAGE } from "../email-code";
import { isEmailVerificationRequired } from "../auth-policy";

export const authRouter = new Hono<{ Bindings: Env }>();

/** 注册与验证码发送 */
authRouter.post("/register", async (c) => {
  const env = c.env;
  const hCtx: HandlerCtx = { env, req: c.req as any };

  try {
    const settings = await getSettings(env);
    const body = await c.req.json<{
      action?: "send-code";
      email?: string;
      password?: string;
      code?: string;
      inviteCode?: string;
      tosAccepted?: boolean;
      privacyAccepted?: boolean;
    }>();

    if (!body.email || !/^\S+@\S+\.\S+$/.test(body.email)) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "邮箱格式不正确");
    }

    const emailNorm = body.email.trim().toLowerCase();
    const kv = getKV(env);
    const smtpReady = settings.smtpEnabled && settings.smtpHost && settings.smtpPassEnc;

    /* ---- 1. 发送注册验证码 ---- */
    if (body.action === "send-code") {
      if (!smtpReady) throw new ApiError(503, ErrorCode.INTERNAL, "邮箱发信服务未启用或未配置");
      const exists = await getUserByEmail(env, emailNorm);
      if (exists) throw new ApiError(409, ErrorCode.BAD_REQUEST, "该邮箱已注册，请直接登录");

      if (await kv.get(`emailcode:sent:${emailNorm}`)) {
        throw new ApiError(429, ErrorCode.RATE_LIMITED, "发送过于频繁，请 1 分钟后再试");
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));
      const password = await decryptSecret(env, settings.smtpPassEnc!);

      try {
        await sendMail(
          {
            host: settings.smtpHost!,
            port: settings.smtpPort || 465,
            username: settings.smtpUsername || settings.smtpFrom || "wimdaw@163.com",
            password,
            from: settings.smtpFrom || settings.smtpUsername || "wimdaw@163.com",
          },
          {
            to: emailNorm,
            fromName: "Relay AI",
            subject: `${settings.siteName ?? "Relay"} 注册验证码`,
            text: `你正在注册 ${settings.siteName ?? "Relay"} 账号。\n\n验证码：${code}\n\n10 分钟内有效。若非本人操作，请忽略本邮件。`,
            html: verifyCodeEmailHtml(settings.siteName ?? "Relay", code, 10),
          }
        );

        await putCode(kv, "register", emailNorm, code);
        await kv.put(`emailcode:sent:${emailNorm}`, "1", { expirationTtl: 60 });
      } catch (e: any) {
        throw new ApiError(502, ErrorCode.UPSTREAM_ERROR, `邮件发送失败：${e?.message}（请检查 SMTP 配置）`);
      }

      await audit(hCtx, {
        actorIp: clientIp(hCtx.req),
        action: "auth.register_code_sent",
        targetType: "user",
        meta: { email: emailNorm },
      });

      return json({ ok: true, message: "验证码已发送（10 分钟内有效）" });
    }

    /* ---- 2. 提交注册 ---- */
    if (!body.password || body.password.length < 10) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "密码至少 10 位");
    }

    assertTosAccepted(body, settings);

    const existing = await getUserByEmail(env, emailNorm);
    if (existing) {
      throw new ApiError(409, ErrorCode.BAD_REQUEST, "邮箱已注册");
    }

    // 注册邮箱验证：由后台开关显式控制，**不再根据 smtpReady 隐式决定**。
    // 历史配置里没有该字段时按「开启」处理（undefined → 强制验证），避免升级后静默失效。
    if (isEmailVerificationRequired(settings)) {
      // 首位管理员自举：此时系统内还没有任何用户，也就没人能配置 SMTP，必须放行一次
      const bootstrapping = !(await hasAnyUser(env));
      if (!bootstrapping) {
        if (!smtpReady) {
          throw new ApiError(
            503,
            ErrorCode.INTERNAL,
            "已开启注册邮箱验证，但邮件服务当前不可用，请联系管理员"
          );
        }
        const checked = await checkCode(kv, "register", emailNorm, body.code);
        if (!checked.ok) {
          throw new ApiError(400, ErrorCode.BAD_REQUEST, CODE_ERROR_MESSAGE[checked.reason ?? "absent"]);
        }
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const id = uuid();

    const newUser: UserRecord = {
      id,
      email: emailNorm,
      passwordHash: await hashPassword(body.password),
      role: "user",
      status: "active",
      tosAcceptedAt: body.tosAccepted ? now : undefined,
      privacyAcceptedAt: body.privacyAccepted ? now : undefined,
      createdAt: now,
      updatedAt: now,
    };

    newUser.inviteCode = id.slice(0, 8).toUpperCase();
    await createUser(env, newUser);

    const regReward = settings.inviteRegisterReward ?? 0;
    if (regReward > 0) {
      await topup(hCtx, `user:${id}`, regReward, "新人注册奖励");
    }

    const sid = uuid();
    const maxAge = settings.persistentSession ? 315360000 : 604800;
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
      meta: { email: emailNorm, role: newUser.role },
    });

    const secret = String(env.SESSION_SECRET || "edgerelay-default-session-secret-32b");
    const resp = json({ id, email: newUser.email }, 201);
    return await sessionCookie(resp, secret, sid, maxAge);
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 登录：支持密码登录与邮箱验证码免密登录 */
authRouter.post("/login", async (c) => {
  const env = c.env;
  const hCtx: HandlerCtx = { env, req: c.req as any };

  try {
    const settings = await getSettings(env);
    const body = await c.req.json<{
      action?: "send-code";
      email?: string;
      password?: string;
      code?: string;
    }>();

    if (!body.email) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少邮箱");
    }
    const emailNorm = body.email.trim().toLowerCase();
    const kv = getKV(env);
    const smtpReady = settings.smtpEnabled && settings.smtpHost && settings.smtpPassEnc;

    /* ---- 1. 发送登录验证码 ---- */
    if (body.action === "send-code") {
      if (!smtpReady) throw new ApiError(503, ErrorCode.INTERNAL, "邮箱发件服务未启用");
      const user = await getUserByEmail(env, emailNorm);
      if (!user) throw new ApiError(404, ErrorCode.NOT_FOUND, "该邮箱尚未注册");

      if (await kv.get(`emailcode:sent:${emailNorm}`)) {
        throw new ApiError(429, ErrorCode.RATE_LIMITED, "发送过于频繁，请 1 分钟后再试");
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));
      const password = await decryptSecret(env, settings.smtpPassEnc!);

      try {
        await sendMail(
          {
            host: settings.smtpHost!,
            port: settings.smtpPort || 465,
            username: settings.smtpUsername || settings.smtpFrom || "wimdaw@163.com",
            password,
            from: settings.smtpFrom || settings.smtpUsername || "wimdaw@163.com",
          },
          {
            to: emailNorm,
            fromName: "Relay AI",
            subject: `${settings.siteName ?? "Relay"} 登录验证码`,
            text: `你正在登录 ${settings.siteName ?? "Relay"} 控制台。\n\n验证码：${code}\n\n10 分钟内有效。若非本人操作，请尽快确认账号安全。`,
            html: verifyCodeEmailHtml(settings.siteName ?? "Relay", code, 10),
          }
        );

        await putCode(kv, "login", emailNorm, code);
        await kv.put(`emailcode:sent:${emailNorm}`, "1", { expirationTtl: 60 });
      } catch (e: any) {
        throw new ApiError(502, ErrorCode.UPSTREAM_ERROR, `邮件发送失败：${e?.message}`);
      }

      return json({ ok: true, message: "登录验证码已发送（10 分钟内有效）" });
    }

    /* ---- 2. 执行登录校验 ---- */
    const user = await getUserByEmail(env, emailNorm);
    if (!user) {
      throw new ApiError(401, ErrorCode.AUTH_INVALID, "邮箱或密码错误");
    }
    if (user.status === "banned") {
      throw new ApiError(403, ErrorCode.FORBIDDEN, "账号已被封禁");
    }

    // 模式 A: 验证码登录
    if (body.code) {
      const checked = await checkCode(kv, "login", emailNorm, body.code);
      if (!checked.ok) {
        const status = checked.reason === "locked" ? 429 : 401;
        const code = checked.reason === "locked" ? ErrorCode.RATE_LIMITED : ErrorCode.AUTH_INVALID;
        throw new ApiError(status, code, CODE_ERROR_MESSAGE[checked.reason ?? "absent"]);
      }
    }
    // 模式 B: 密码登录
    else if (body.password) {
      const ok = await verifyPassword(body.password, user.passwordHash);
      if (!ok) {
        throw new ApiError(401, ErrorCode.AUTH_INVALID, "邮箱或密码错误");
      }
    } else {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "请输入密码或验证码");
    }

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
      meta: { email: user.email, via: body.code ? "code" : "password" },
    });

    const secret = String(env.SESSION_SECRET || "edgerelay-default-session-secret-32b");
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

/** 当前登录态与余额 */
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
      // 超级管理员为铸币方，额度无上限（负余额无实际意义，前端展示为 ∞）
      unlimited: u.role === "superadmin",
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
    requireRole(u, ["superadmin"]);
    const body = await c.req.json<{ password?: string }>();
    if (!body.password) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "请输入当前密码完成二次验证");
    }
    const full = await getUserById(c.env, u.id);
    if (!full) throw new ApiError(401, ErrorCode.AUTH_REQUIRED, "用户不存在");

    const ok = await verifyPassword(body.password, full.passwordHash);
    if (!ok) throw new ApiError(401, ErrorCode.AUTH_INVALID, "密码错误");

    const until = Math.floor(Date.now() / 1000) + 600;
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

/** 密码重置接口：验证码重置密码 */
authRouter.post("/reset", async (c) => {
  const env = c.env;
  const hCtx: HandlerCtx = { env, req: c.req as any };

  try {
    const settings = await getSettings(env);
    const body = await c.req.json<{
      stage?: number;
      action?: "request" | "confirm";
      email?: string;
      code?: string;
      password?: string;
    }>();

    if (!body.email) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少邮箱");
    const emailNorm = body.email.trim().toLowerCase();
    const kv = getKV(env);
    const smtpReady = settings.smtpEnabled && settings.smtpHost && settings.smtpPassEnc;

    if (!smtpReady) throw new ApiError(503, ErrorCode.INTERNAL, "邮件服务未启用，无法重置密码");

    // 阶段 1: 发送重置验证码（兼容 stage / action 两套入参）
    if (body.stage === 1 || body.action === "request" || !body.code) {
      const user = await getUserByEmail(env, emailNorm);
      if (!user) throw new ApiError(404, ErrorCode.NOT_FOUND, "该邮箱尚未注册");

      if (await kv.get(`emailcode:sent:${emailNorm}`)) {
        throw new ApiError(429, ErrorCode.RATE_LIMITED, "发送过于频繁，请 1 分钟后再试");
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));
      const password = await decryptSecret(env, settings.smtpPassEnc!);

      try {
        await sendMail(
          {
            host: settings.smtpHost!,
            port: settings.smtpPort || 465,
            username: settings.smtpUsername || settings.smtpFrom || "wimdaw@163.com",
            password,
            from: settings.smtpFrom || settings.smtpUsername || "wimdaw@163.com",
          },
          {
            to: emailNorm,
            fromName: "Relay AI",
            subject: `${settings.siteName ?? "Relay"} 密码重置验证码`,
            text: `你的密码重置验证码为：${code}，10 分钟内有效。`,
            html: verifyCodeEmailHtml(settings.siteName ?? "Relay", code),
          }
        );
      } catch (e: any) {
        throw new ApiError(502, ErrorCode.UPSTREAM_ERROR, `邮件发送失败：${e?.message}（请检查 SMTP 配置）`);
      }

      await putCode(kv, "reset", emailNorm, code);
      await kv.put(`emailcode:sent:${emailNorm}`, "1", { expirationTtl: 60 });

      return json({ ok: true, message: "重置验证码已发送" });
    }

    // 阶段 2: 校验验证码并更新密码。先校验密码强度，避免一次手误白白烧掉验证码
    if (!body.password || body.password.length < 10) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "新密码至少 10 位");
    }

    const checked = await checkCode(kv, "reset", emailNorm, body.code);
    if (!checked.ok) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, CODE_ERROR_MESSAGE[checked.reason ?? "absent"]);
    }

    const user = await getUserByEmail(env, emailNorm);
    if (!user) throw new ApiError(404, ErrorCode.NOT_FOUND, "用户不存在");

    const newHash = await hashPassword(body.password);
    await updateUser(env, user.id, {
      passwordHash: newHash,
      passwordChangedAt: Math.floor(Date.now() / 1000),
    });

    await audit(hCtx, {
      actorUserId: user.id,
      actorIp: clientIp(hCtx.req),
      action: "auth.reset_password_success",
      targetType: "user",
      targetId: user.id,
    });

    return json({ ok: true, message: "密码已成功重置，请使用新密码登录" });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
