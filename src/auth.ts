/**
 * 认证与授权 (EdgeOne Pages + Blob)
 *  - 面向浏览器/后台：Cookie 会话（HMAC 签名）+ 基于角色的访问控制
 *  - 面向 API 调用方：Bearer sk-gw-* API Key（哈希查库）+ IP 白名单 + 模型白名单 + 可选签名校验
 *  - 管理接口强制二次验证（step-up，10 分钟有效期）
 */
import type { HandlerCtx, AuthedKey, RateLimits } from "./types";
import { ApiError, ErrorCode } from "./errors";
import { hmacHex, sha256Hex, timingSafeEqualHex } from "./crypto";
import { getSettings } from "./settings";
import { getSession, getUserById, getApiKeyByHash, updateApiKey, updateUser } from "./storage/db";

export type SessionUser = {
  id: string;
  email: string;
  role: "user" | "vip" | "admin" | "superadmin" | "finance" | "auditor";
  status: string;
};

/* ---------- Cookie 会话 ---------- */

function signedToken(secret: string, sid: string): Promise<string> {
  return hmacHex(secret, `sid:${sid}`).then((sig) => `${sid}.${sig}`);
}

export async function sessionCookie(resp: Response, secret: string, sid: string, maxAge = 604800): Promise<Response> {
  const token = await signedToken(secret, sid);
  const out = new Response(resp.body, resp);
  out.headers.append(
    "set-cookie",
    `gw_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  );
  return out;
}

export function clearCookie(resp: Response): Response {
  const out = new Response(resp.body, resp);
  out.headers.append("set-cookie", "gw_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  return out;
}

export async function getSessionUser(c: HandlerCtx): Promise<SessionUser | null> {
  const cookie = c.req.header("cookie") ?? "";
  const m = cookie.match(/gw_session=([^;]+)/);
  if (!m) return null;
  const [sid, sig] = m[1]!.split(".");
  if (!sid || !sig) return null;
  const secret = String(c.env.SESSION_SECRET || "edgerelay-default-session-secret-32b");
  const expect = await hmacHex(secret, `sid:${sid}`);
  if (!(await timingSafeEqualHex(sig, expect))) return null;

  const session = await getSession(c.env, sid);
  if (!session) return null;

  const user = await getUserById(c.env, session.userId);
  if (!user || user.status !== "active") return null;

  // 创始人账号无条件锁定为 superadmin；普通用户与 VIP 依据余额是否大于 0 自动升降级
  let currentRole = user.role;
  if (user.email.toLowerCase() === "hackerxiaow@gmail.com") {
    currentRole = "superadmin";
    if (user.role !== "superadmin") {
      updateUser(c.env, user.id, { role: "superadmin" }).catch(() => {});
    }
  } else if (currentRole === "user" || currentRole === "vip") {
    const { syncUserVipStatus } = await import("./storage/db");
    currentRole = (await syncUserVipStatus(c.env, user.id)) as SessionUser["role"];
  }

  return {
    id: user.id,
    email: user.email,
    role: currentRole,
    status: user.status,
  };
}

export async function requireUser(c: HandlerCtx): Promise<SessionUser> {
  const u = await getSessionUser(c);
  if (!u) throw new ApiError(401, ErrorCode.AUTH_REQUIRED, "未登录");
  return u;
}

export function requireRole(u: SessionUser, roles: SessionUser["role"][]): void {
  if (!roles.includes(u.role)) throw new ApiError(403, ErrorCode.FORBIDDEN, "权限不足");
}

/** 管理接口二次验证：需要已登录且通过 step-up（支持就地核验管理员密码，或 10 分钟凭证有效） */
export async function requireAdminStepUp(c: HandlerCtx, providedPassword?: string): Promise<SessionUser> {
  const u = await requireUser(c);
  requireRole(u, ["superadmin", "admin"]);
  const settings = await getSettings(c.env);
  if (settings.stepUpDisabled) return u;

  const now = Math.floor(Date.now() / 1000);
  const user = await getUserById(c.env, u.id);
  if (!user) throw new ApiError(401, ErrorCode.AUTH_REQUIRED, "用户不存在");

  // 若前端操作携带了管理员密码，优先校验密码以实现即时二次验证
  if (providedPassword) {
    const { verifyPassword } = await import("./crypto");
    const ok = await verifyPassword(providedPassword, user.passwordHash);
    if (!ok) {
      throw new ApiError(401, ErrorCode.AUTH_INVALID, "管理员密码错误，验证失败");
    }
    const until = now + 600;
    await updateUser(c.env, u.id, { stepUpUntil: until });
    return u;
  }

  if (!user.stepUpUntil || user.stepUpUntil < now) {
    throw new ApiError(403, ErrorCode.STEP_UP_REQUIRED, "管理操作需要验证管理员密码", {
      stepUpUrl: "/api/auth/stepup",
    });
  }
  return u;
}

/* ---------- API Key 认证 ---------- */

export async function authenticateApiKey(c: HandlerCtx): Promise<AuthedKey> {
  const auth = c.req.header("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(sk-gw-\S+)$/i);
  if (!m) throw new ApiError(401, ErrorCode.AUTH_REQUIRED, "缺少 Bearer API Key");
  const plaintext = m[1]!;
  const hash = await sha256Hex(plaintext);
  const now = Math.floor(Date.now() / 1000);

  const row = await getApiKeyByHash(c.env, hash);
  if (!row) throw new ApiError(401, ErrorCode.AUTH_INVALID, "API Key 无效");
  if (row.status === "revoked") throw new ApiError(401, ErrorCode.KEY_REVOKED, "API Key 已撤销");
  if (row.expiresAt && row.expiresAt < now) throw new ApiError(401, ErrorCode.KEY_EXPIRED, "API Key 已过期");
  if (row.quotaUsd !== null && row.quotaUsd !== undefined && row.spentUsd >= row.quotaUsd) {
    throw new ApiError(429, ErrorCode.KEY_QUOTA_EXCEEDED, "该 API Key 额度已用尽");
  }

  const ip = clientIp(c.req);
  if (row.ipWhitelist) {
    try {
      const list = JSON.parse(row.ipWhitelist) as string[];
      if (list.length && !list.includes(ip)) {
        throw new ApiError(403, ErrorCode.FORBIDDEN, `来源 IP ${ip} 不在白名单内`);
      }
    } catch {}
  }

  // 异步记录最后使用时间（不阻塞主链路）
  updateApiKey(c.env, hash, { lastUsedAt: now }).catch(() => {});

  const settings = await getSettings(c.env);
  const limits: RateLimits = {
    rpm: settings.defaultRpm,
    tpm: settings.defaultTpm,
    concurrency: 10,
  };

  let modelWhitelist: string[] | null = null;
  if (row.modelWhitelist) {
    try {
      modelWhitelist = JSON.parse(row.modelWhitelist);
    } catch {}
  }

  let ipWhitelist: string[] | null = null;
  if (row.ipWhitelist) {
    try {
      ipWhitelist = JSON.parse(row.ipWhitelist);
    } catch {}
  }

  const user = await getUserById(c.env, row.userId);
  let userRole = (user?.role as AuthedKey["userRole"]) || "user";
  if (user?.email?.toLowerCase() === "hackerxiaow@gmail.com") {
    userRole = "superadmin";
  } else if (userRole === "user" || userRole === "vip") {
    const { syncUserVipStatus } = await import("./storage/db");
    userRole = (await syncUserVipStatus(c.env, row.userId)) as AuthedKey["userRole"];
  }

  return {
    keyId: row.id,
    userId: row.userId,
    userRole,
    orgId: row.orgId || null,
    requiresSigning: !!row.requiresSigning,
    ipWhitelist,
    modelWhitelist,
    limits,
  };
}

export function billingScope(userId: string, orgId?: string | null): string {
  return orgId ? `org:${orgId}` : `user:${userId}`;
}

export function clientIp(req: HandlerCtx["req"]): string {
  return (
    req.header("cf-connecting-ip") ||
    req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.header("x-real-ip") ||
    "127.0.0.1"
  );
}
