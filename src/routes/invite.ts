/**
 * 邀请系统路由 /api/invite/*
 */
import { Hono } from "hono";
import type { Env, HandlerCtx } from "../types";
import { requireUser, requireRole } from "../auth";
import { errorResponse } from "../errors";
import { getSettings, updateSettings, json } from "../settings";
import { getUserById, listAllUsers } from "../storage/db";

export const inviteRouter = new Hono<{ Bindings: Env }>();

/** 当前用户的邀请信息与明细 */
inviteRouter.get("/me", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const full = await getUserById(c.env, user.id);
    const settings = await getSettings(c.env);

    const allUsers = await listAllUsers(c.env);
    const invitedList = allUsers
      .filter((u) => u.invitedBy === user.id)
      .map((u) => ({
        email: u.email.replace(/(.{2}).+(@.+)/, "$1***$2"),
        nickname: u.nickname ?? null,
        createdAt: u.createdAt,
      }));

    const regReward = settings.inviteRegisterReward ?? 0;
    const invReward = settings.inviteRewardAmount ?? 0;
    const totalReward = invitedList.length * invReward;

    return json({
      inviteCode: full?.inviteCode || user.id.slice(0, 8).toUpperCase(),
      invitedCount: invitedList.length,
      totalReward,
      registerReward: regReward,
      inviteReward: invReward,
      invited: invitedList,
    });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 管理员端全站邀请看板 */
inviteRouter.get("/admin", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    requireRole(user, ["superadmin"]);
    const settings = await getSettings(c.env);

    const allUsers = await listAllUsers(c.env);
    const inviteCountMap: Record<string, number> = {};

    for (const u of allUsers) {
      if (u.invitedBy) {
        inviteCountMap[u.invitedBy] = (inviteCountMap[u.invitedBy] || 0) + 1;
      }
    }

    const ranking = [];
    for (const [uid, count] of Object.entries(inviteCountMap)) {
      const u = allUsers.find((x) => x.id === uid);
      if (u) {
        ranking.push({
          id: u.id,
          email: u.email,
          nickname: u.nickname ?? null,
          invited_count: count,
        });
      }
    }
    ranking.sort((a, b) => b.invited_count - a.invited_count);

    return json({
      totalInvited: allUsers.filter((u) => u.invitedBy).length,
      ranking: ranking.slice(0, 20),
      query: [],
      config: {
        registerReward: settings.inviteRegisterReward ?? 0,
        inviteReward: settings.inviteRewardAmount ?? 0,
        dailyTop1: settings.inviteDailyTop1 ?? 0,
        dailyTop2: settings.inviteDailyTop2 ?? 0,
        dailyTop3: settings.inviteDailyTop3 ?? 0,
      },
    });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 保存邀请配置 */
inviteRouter.post("/admin", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    requireRole(user, ["superadmin"]);
    const body = await c.req.json<{
      registerReward?: number;
      inviteReward?: number;
      dailyTop1?: number;
      dailyTop2?: number;
      dailyTop3?: number;
    }>();

    await updateSettings(c.env, {
      inviteRegisterReward: Number(body.registerReward) || 0,
      inviteRewardAmount: Number(body.inviteReward) || 0,
      inviteDailyTop1: Number(body.dailyTop1) || 0,
      inviteDailyTop2: Number(body.dailyTop2) || 0,
      inviteDailyTop3: Number(body.dailyTop3) || 0,
    });

    return json({ ok: true });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
