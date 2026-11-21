/**
 * 用户提交供应商（审核流）/api/user/providers
 *
 *  - POST  /                 提交新供应商（敏感操作：内联校验账户密码，通过才写入；提交后不可自行修改/删除）
 *  - GET   /                 我的提交列表（含审核状态与驳回原因；绝不返回他人提交）
 *  - GET   /:id/messages     与管理员的站内信往来（仅本人线程）
 *  - POST  /:id/messages     向管理员发起站内信（请求修改信息、补充说明等）
 *
 * 权限模型：
 *  - 提交/查看/发信均要求登录 + 归属校验（只能操作 ownerUserId === 当前用户的提交）
 *  - 审核/编辑/删除只在超级管理员侧（src/routes/admin.ts 的 provider_submission_* 动作）
 *  - 提交独立存放于 provider_submissions，审核通过才落地为正式 ProviderRecord，
 *    未审核记录物理上不可能被路由/模型/操练场等消费方读到
 */
import { Hono } from "hono";
import type { Env, HandlerCtx, ProviderSubmission, ProviderSubmissionMessage } from "../types";
import { requireUser } from "../auth";
import { ApiError, ErrorCode, errorResponse } from "../errors";
import { json } from "../settings";
import { uuid, verifyPassword, encryptSecret } from "../crypto";
import { getUserById, getProviders, getProviderSubmissions, upsertProviderSubmission, appendProviderSubmissionMessage, getProviderSubmissionThread } from "../storage/db";

export const userProvidersRouter = new Hono<{ Bindings: Env }>();

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** 提交的对外形状：剥离加密凭据 */
function publicSubmission(s: ProviderSubmission) {
  const { encryptedKey, ...rest } = s;
  return { ...rest, hasKey: !!encryptedKey };
}

/** 归属校验：只能操作自己的提交 */
async function requireOwnSubmission(env: Env, hCtx: HandlerCtx, userId: string, id: string): Promise<ProviderSubmission> {
  const all = await getProviderSubmissions(env);
  const sub = all.find((x) => x.id === id);
  if (!sub || sub.ownerUserId !== userId) {
    throw new ApiError(404, ErrorCode.NOT_FOUND, "提交记录不存在");
  }
  void hCtx;
  return sub;
}

/** 提交新供应商（敏感操作：必须校验账户密码） */
userProvidersRouter.post("/", async (c) => {
  const env = c.env as Env;
  const hCtx: HandlerCtx = { env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string; slug?: string; baseUrl?: string; kind?: string; authScheme?: string; key?: string; password?: string;
    };

    // 敏感操作门禁：校验当前账户密码（不缓存、不可跳过）
    const full = await getUserById(env, user.id);
    if (!full) throw new ApiError(401, ErrorCode.AUTH_REQUIRED, "用户不存在");
    const ok = await verifyPassword(String(body.password || ""), full.passwordHash);
    if (!ok) throw new ApiError(401, ErrorCode.AUTH_INVALID, "密码校验未通过，提交已阻止");

    const name = String(body.name || "").trim();
    const slug = String(body.slug || "").trim().toLowerCase();
    const baseUrl = String(body.baseUrl || "").trim();
    const kind = String(body.kind || "openai_compat").trim();
    const authScheme = String(body.authScheme || "bearer").trim();
    const key = String(body.key || "").trim();
    if (!name || name.length > 64) throw new ApiError(400, ErrorCode.BAD_REQUEST, "供应商名称必填且不超过 64 字");
    if (!SLUG_RE.test(slug)) throw new ApiError(400, ErrorCode.BAD_REQUEST, "渠道标识符仅限小写字母/数字/短横线（2-32 位）");
    if (!/^https:\/\//i.test(baseUrl)) throw new ApiError(400, ErrorCode.BAD_REQUEST, "Base URL 必须是 https:// 开头的完整地址");
    if (!["openai_compat", "anthropic"].includes(kind)) throw new ApiError(400, ErrorCode.BAD_REQUEST, "不支持的渠道类型");
    if (!["bearer", "x-api-key"].includes(authScheme)) throw new ApiError(400, ErrorCode.BAD_REQUEST, "不支持的鉴权方式");

    // slug 唯一性：不得与正式渠道、在途提交重复
    const [providers, existingSubs] = await Promise.all([getProviders(env), getProviderSubmissions(env)]);
    const taken = new Set<string>([...providers.map((p) => p.slug), ...existingSubs.map((x) => x.slug)]);
    if (taken.has(slug)) throw new ApiError(400, ErrorCode.BAD_REQUEST, `渠道标识符 ${slug} 已存在，请换一个`);

    const now = Math.floor(Date.now() / 1000);
    const sub: ProviderSubmission = {
      id: uuid(),
      ownerUserId: user.id,
      ownerEmail: user.email,
      name,
      slug,
      kind,
      baseUrl,
      authScheme,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    if (key) {
      sub.encryptedKey = await encryptSecret(env, key);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
      sub.keyFingerprint = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
    }
    await upsertProviderSubmission(env, sub);

    // 线程首条消息（系统向管理员同步提交意图）
    const first: ProviderSubmissionMessage = {
      id: uuid(),
      submissionId: sub.id,
      fromUserId: user.id,
      fromEmail: user.email,
      fromRole: "user",
      content: `提交了供应商「${name}」（${slug} → ${baseUrl}）${key ? "，含上游密钥" : "，未提供密钥"}，等待审核。`,
      createdAt: now,
    };
    await appendProviderSubmissionMessage(env, first);

    return json({ ok: true, submission: publicSubmission(sub) });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 我的提交列表（含审核状态与驳回原因） */
userProvidersRouter.get("/", async (c) => {
  const env = c.env as Env;
  const hCtx: HandlerCtx = { env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const all = await getProviderSubmissions(env);
    const mine = all
      .filter((x) => x.ownerUserId === user.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicSubmission);
    return json({ ok: true, submissions: mine });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 站内信往来（仅本人线程） */
userProvidersRouter.get("/:id/messages", async (c) => {
  const env = c.env as Env;
  const hCtx: HandlerCtx = { env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const sub = await requireOwnSubmission(env, hCtx, user.id, c.req.param("id"));
    const messages = await getProviderSubmissionThread(env, sub.id);
    return json({ ok: true, messages });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 向管理员发信（请求修改信息、补充说明；管理员回复与审核结果也会出现在线程里） */
userProvidersRouter.post("/:id/messages", async (c) => {
  const env = c.env as Env;
  const hCtx: HandlerCtx = { env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const sub = await requireOwnSubmission(env, hCtx, user.id, c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as { content?: string };
    const content = String(body.content || "").trim();
    if (!content || content.length > 1000) throw new ApiError(400, ErrorCode.BAD_REQUEST, "请填写 1000 字以内的内容");

    const msg: ProviderSubmissionMessage = {
      id: uuid(),
      submissionId: sub.id,
      fromUserId: user.id,
      fromEmail: user.email,
      fromRole: "user",
      content,
      createdAt: Math.floor(Date.now() / 1000),
    };
    await appendProviderSubmissionMessage(env, msg);
    return json({ ok: true });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
