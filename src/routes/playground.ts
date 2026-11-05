/**
 * 操练场（Playground）/api/playground/*
 *
 * 面向控制台登录用户（Cookie 会话），无需 API Key：
 *  - GET  /api/playground/models  可用模型列表（普通用户隐藏付费模型）
 *  - POST /api/playground/chat    对话转发，支持 SSE 流式
 *
 * 说明：
 *  - 复用网关的路由规划与 Key 池（含健康排序），与 /v1/chat/completions 同一套上游
 *  - 按会话用户做每分钟次数限制（KV 计数），避免被当成免费额度刷
 *  - 操练场调用不计费、不写 usage_logs（仅用于调试预览）
 */
import { Hono } from "hono";
import type { Env, HandlerCtx } from "../types";
import { requireUser } from "../auth";
import { ApiError, ErrorCode, errorResponse } from "../errors";
import { json } from "../settings";
import { getPricing } from "../billing";
import { planModelRoutes, buildRoutesFromPlan } from "../router";
import { getModels, getProviders, getProviderKeys } from "../storage/db";
import { readKeyHealth } from "../key-health";
import { buildHeaders, resolveTarget, sanitizeUpstreamBody } from "../providers";
import { getBlobStore } from "../storage/blob-store";

export const playgroundRouter = new Hono<{ Bindings: Env }>();

/** 每分钟每用户最多对话次数 */
const RPM_LIMIT = 20;
/** 单次请求最多尝试的上游路由数 */
const MAX_ROUTES = 3;

function isAdminRole(role: string): boolean {
  return role === "superadmin" || role === "admin";
}

/** 简单的分钟级限流（KV 计数） */
async function checkUserRpm(env: Env, userId: string): Promise<{ ok: boolean; used: number }> {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `pg:rl:${userId}:${minute}`;
  try {
    const store = getBlobStore(env);
    const raw = (await store.get(key, { type: "json", consistency: "strong" })) as { n?: number } | null;
    const used = (raw?.n ?? 0) + 1;
    await store.setJSON(key, { n: used });
    return { ok: used <= RPM_LIMIT, used };
  } catch {
    return { ok: true, used: 0 };
  }
}

/** 模型列表：普通用户看不到付费模型 */
playgroundRouter.get("/models", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const [models, providers] = await Promise.all([getModels(c.env), getProviders(c.env)]);
    const activeProviders = new Map(providers.filter((p) => p.status === "active").map((p) => [p.id, p]));

    // 操练场只做对话，过滤掉图片/视频/语音/向量等非对话模型
    const NON_CHAT = /(^|[-_/])(image|video|tts|whisper|speech|embedding|embed|rerank|moderation)([-_/]|$)/i;
    const rows: { id: string; provider: string; paid: boolean }[] = [];
    const seen = new Set<string>();
    for (const m of models) {
      if (m.enabled !== 1) continue;
      const p = activeProviders.get(m.providerId);
      if (!p) continue;
      if (seen.has(m.publicName)) continue;
      if (NON_CHAT.test(m.publicName) || NON_CHAT.test(m.upstreamModel)) continue;
      const pricing = await getPricing(c.env, m.publicName);
      const paid = !!pricing && (pricing.inputPerMillion > 0 || pricing.outputPerMillion > 0);
      if (paid && !isAdminRole(user.role)) continue; // 普通用户不给付费模型
      seen.add(m.publicName);
      rows.push({ id: m.publicName, provider: p.name, paid });
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return json({ ok: true, models: rows, rpm_limit: RPM_LIMIT, can_use_paid: isAdminRole(user.role) });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 对话：默认流式，stream=false 时返回完整 JSON */
playgroundRouter.post("/chat", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const body = (await c.req.json().catch(() => ({}))) as {
      model?: string;
      messages?: { role: string; content: unknown }[];
      temperature?: number;
      top_p?: number;
      max_tokens?: number;
      system?: string;
      stream?: boolean;
    };

    const model = String(body.model || "");
    const messages = Array.isArray(body.messages) ? body.messages.filter((m) => m && m.role) : [];
    if (!model) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 model");
    if (!messages.length) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 messages");

    const pricing = await getPricing(c.env, model);
    const paid = !!pricing && (pricing.inputPerMillion > 0 || pricing.outputPerMillion > 0);
    if (paid && !isAdminRole(user.role)) {
      throw new ApiError(403, ErrorCode.MODEL_NOT_ALLOWED, `模型 ${model} 为付费模型，普通用户不可在操练场使用`);
    }

    const rpm = await checkUserRpm(c.env, user.id);
    if (!rpm.ok) {
      throw new ApiError(429, ErrorCode.RATE_LIMITED, `操练场每分钟最多 ${RPM_LIMIT} 次，请稍后再试`);
    }

    const plans = await planModelRoutes(c.env, model);
    if (!plans.length) throw new ApiError(404, ErrorCode.MODEL_NOT_FOUND, `模型 ${model} 不存在或暂无可用上游`);

    const routes = [];
    for (const plan of plans) {
      const [keys, health] = await Promise.all([getProviderKeys(c.env, plan.provider.id), readKeyHealth(c.env, plan.provider.id)]);
      routes.push(...buildRoutesFromPlan(c.env, plan, keys, health));
    }
    if (!routes.length) throw new ApiError(404, ErrorCode.MODEL_NOT_FOUND, "暂无可用上游 Key");

    const stream = body.stream !== false;
    const systemText = typeof body.system === "string" ? body.system.trim() : "";
    const outboundMessages = systemText ? [{ role: "system", content: systemText }, ...messages] : messages;

    const upstreamBody = {
      model: "",
      messages: outboundMessages,
      stream,
      ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
      ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
      ...(typeof body.max_tokens === "number" ? { max_tokens: body.max_tokens } : {}),
    };

    let lastError = "上游请求失败";
    let lastStatus = 502;

    for (const route of routes.slice(0, MAX_ROUTES)) {
      try {
        const { url } = resolveTarget(c.env, route);
        const headers = await buildHeaders(c.env, route);
        const payload = sanitizeUpstreamBody(
          { ...upstreamBody, model: route.upstreamModel } as Record<string, unknown>,
          route,
          stream
        );
        const resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(120_000),
        });

        if (!resp.ok) {
          lastStatus = resp.status;
          lastError = (await resp.text().catch(() => "")).slice(0, 300) || `上游返回 ${resp.status}`;
          continue;
        }

        if (!stream || !resp.body) {
          const text = await resp.text();
          return new Response(text, {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
          });
        }

        return new Response(resp.body, {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          },
        });
      } catch (err) {
        lastStatus = 504;
        lastError = (err as Error)?.message || "上游请求超时";
      }
    }

    return json(
      { error: { message: lastError, type: "upstream_error", code: "upstream_error" } },
      lastStatus >= 400 && lastStatus < 600 ? lastStatus : 502
    );
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
