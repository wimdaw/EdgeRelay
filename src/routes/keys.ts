/**
 * API Key 管理路由 /api/keys/*
 */
import { Hono } from "hono";
import type { Env, HandlerCtx, ApiKeyRecord } from "../types";
import { requireUser, clientIp } from "../auth";
import { ApiError, ErrorCode, errorResponse } from "../errors";
import { generateApiKey, uuid } from "../crypto";
import { audit } from "../audit";
import { json } from "../settings";
import { createApiKey, listUserApiKeys, updateApiKey } from "../storage/db";

export const keysRouter = new Hono<{ Bindings: Env }>();

/** 获取当前用户的 key 列表（对齐前端 KeyRow 字段格式） */
keysRouter.get("/", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const keys = await listUserApiKeys(c.env, user.id);
    const safeKeys = keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      status: k.status,
      quota_usd: k.quotaUsd ?? null,
      spent_usd: k.spentUsd ?? 0,
      expires_at: k.expiresAt ?? null,
      model_whitelist: k.modelWhitelist ?? null,
      ip_whitelist: k.ipWhitelist ?? null,
      requires_signing: k.requiresSigning ?? 0,
      created_at: k.createdAt,
      last_used_at: k.lastUsedAt ?? null,
    }));
    return json({ keys: safeKeys });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 创建新 Key（明文仅返回一次，对齐前端字段） */
keysRouter.post("/", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const body = await c.req.json<{
      name?: string;
      quotaUsd?: number;
      expiresAt?: number;
      ipWhitelist?: string[];
      modelWhitelist?: string[];
      requiresSigning?: boolean;
    }>();

    const { plaintext, prefix, hashPromise } = generateApiKey();
    const keyHash = await hashPromise;
    const now = Math.floor(Date.now() / 1000);
    const id = uuid();

    const keyRecord: ApiKeyRecord = {
      id,
      userId: user.id,
      name: body.name?.trim() || "default",
      keyHash,
      prefix,
      status: "active",
      quotaUsd: typeof body.quotaUsd === "number" ? body.quotaUsd : null,
      spentUsd: 0,
      expiresAt: typeof body.expiresAt === "number" ? body.expiresAt : null,
      ipWhitelist: body.ipWhitelist ? JSON.stringify(body.ipWhitelist) : null,
      modelWhitelist: body.modelWhitelist ? JSON.stringify(body.modelWhitelist) : null,
      requiresSigning: body.requiresSigning ? 1 : 0,
      createdAt: now,
    };

    await createApiKey(c.env, keyRecord);

    await audit(hCtx, {
      actorUserId: user.id,
      actorIp: clientIp(hCtx.req),
      action: "key.create",
      targetType: "api_key",
      targetId: id,
      meta: { name: keyRecord.name, prefix },
    });

    return json(
      {
        id,
        name: keyRecord.name,
        prefix,
        key: plaintext, // 仅此一次返回明文
        warning: "请立即保存此 Key，之后将无法再次查看。",
      },
      201
    );
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** Key 操作：撤销、轮换（对齐 rotate / roll） */
keysRouter.post("/actions", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const body = await c.req.json<{ action?: string; keyId?: string }>();
    const action = body.action;
    const keyId = body.keyId;

    if (!keyId) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 keyId");

    const userKeys = await listUserApiKeys(c.env, user.id);
    const target = userKeys.find((k) => k.id === keyId);
    if (!target) throw new ApiError(404, ErrorCode.NOT_FOUND, "未找到该 Key");

    const now = Math.floor(Date.now() / 1000);

    if (action === "revoke") {
      await updateApiKey(c.env, target.keyHash, {
        status: "revoked",
        revokedAt: now,
      });

      await audit(hCtx, {
        actorUserId: user.id,
        actorIp: clientIp(hCtx.req),
        action: "key.revoke",
        targetType: "api_key",
        targetId: keyId,
      });

      return json({ ok: true, revoked: keyId });
    }

    if (action === "rotate" || action === "roll") {
      // 撤销旧 key，创建同名新 key
      await updateApiKey(c.env, target.keyHash, {
        status: "revoked",
        revokedAt: now,
      });

      const { plaintext, prefix, hashPromise } = generateApiKey();
      const newKeyHash = await hashPromise;
      const newId = uuid();

      const newRecord: ApiKeyRecord = {
        id: newId,
        userId: user.id,
        name: target.name,
        keyHash: newKeyHash,
        prefix,
        status: "active",
        quotaUsd: target.quotaUsd,
        spentUsd: 0,
        expiresAt: target.expiresAt,
        ipWhitelist: target.ipWhitelist,
        modelWhitelist: target.modelWhitelist,
        requiresSigning: target.requiresSigning,
        createdAt: now,
      };

      await createApiKey(c.env, newRecord);

      await audit(hCtx, {
        actorUserId: user.id,
        actorIp: clientIp(hCtx.req),
        action: "key.rotate",
        targetType: "api_key",
        targetId: `${keyId}->${newId}`,
      });

      return json({
        ok: true,
        revoked: keyId,
        created: {
          id: newId,
          prefix,
          key: plaintext,
          warning: "请立即保存此 Key，之后将无法再次查看。",
        },
      });
    }

    throw new ApiError(400, ErrorCode.BAD_REQUEST, `未知操作: ${action}`);
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
