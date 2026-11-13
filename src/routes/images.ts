/**
 * 图片生成接口 /v1/images/generations（OpenAI 兼容）
 *
 *  - 同步转发到 agnes /images/generations，成功响应原样透传（data[].url / b64_json）
 *  - 复用 API Key 认证、模型白名单、RPM/并发限流与 Key 池健康熔断
 *  - 只对图片模型（agnes-image-*）开放，避免对话模型被误投递
 *  - 图片按张计费尚未定价，usage_logs 记 0 token / 0 费用，仅做审计与限流计数
 */
import { Hono } from "hono";
import type { Env, UpstreamRoute } from "../types";
import { ApiError, ErrorCode, openAiError, errorResponse } from "../errors";
import { authenticateSkGwKey, assertModelAllowed } from "../api-auth";
import { planModelRoutes, buildRoutesFromPlan } from "../router";
import { getPricing } from "../billing";
import { checkRateLimit, releaseConcurrency, commitRateLimits } from "../ratelimit";
import { readKeyHealth, recordKeySuccess, recordKeyFailure } from "../key-health";
import { uuid, decryptSecret } from "../crypto";
import { getProviderKeys, addUsageRecord, commitApiKeyUsage } from "../storage/db";
import { isQueueFullError } from "../video";
import { isSupportedImageRoute, generateImageByRoute, countGeneratedImages } from "../images";

export const imagesRouter = new Hono<{ Bindings: Env }>();

const MAX_IMAGE_ROUTES = 3;

type ImageBody = {
  model?: string;
  prompt?: string;
  input?: string;
  n?: number;
  size?: string;
  response_format?: "url" | "b64_json";
};

async function resolveRoutes(env: Env, publicModel: string): Promise<UpstreamRoute[]> {
  const plans = await planModelRoutes(env, publicModel);
  if (!plans.length) return [];
  const routes: UpstreamRoute[] = [];
  for (const plan of plans) {
    const [keys, health] = await Promise.all([getProviderKeys(env, plan.provider.id), readKeyHealth(env, plan.provider.id)]);
    routes.push(...buildRoutesFromPlan(env, plan, keys, health));
  }
  return routes;
}

async function logUsage(
  env: Env,
  args: {
    requestId: string;
    userId: string;
    apiKeyId: string;
    publicModel: string;
    providerId?: string | null;
    upstreamModel?: string | null;
    status: string;
    httpStatus: number;
    latencyMs: number;
    errorCode?: string | null;
    attempts: number;
    ip: string;
  }
): Promise<void> {
  await Promise.all([
    addUsageRecord(env, {
      id: uuid(),
      requestId: args.requestId,
      userId: args.userId,
      apiKeyId: args.apiKeyId,
      publicModel: args.publicModel,
      providerId: args.providerId ?? null,
      upstreamModel: args.upstreamModel ?? null,
      status: args.status,
      httpStatus: args.httpStatus,
      latencyMs: args.latencyMs,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      currency: "CNY",
      stream: 0,
      errorCode: args.errorCode ?? null,
      attempts: args.attempts,
      ip: args.ip,
      createdAt: Math.floor(Date.now() / 1000),
    }),
    commitApiKeyUsage(env),
  ]).catch(() => {});
}

imagesRouter.post("/generations", async (c) => {
  const env = c.env as Env;
  const requestId = c.req.header("x-request-id") || uuid();
  const started = Date.now();
  let concKeyId: string | null = null;

  try {
    const auth = await authenticateSkGwKey(c);
    const body = (await c.req.json<ImageBody>().catch(() => ({}))) as ImageBody;

    if (!body.model) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 model");
    const prompt = typeof body.prompt === "string" ? body.prompt : typeof body.input === "string" ? body.input : "";
    if (!prompt.trim()) throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 prompt");

    const publicModel = body.model;
    assertModelAllowed(auth.row, publicModel);

    // 定价取路由解析后的规范名（用户可能用大小写变体请求），用于取该模型的 RPM 限额
    const plans = await planModelRoutes(env, publicModel);
    const canonicalName = plans[0]?.model.publicName;
    const pricing = (canonicalName ? await getPricing(env, canonicalName) : null) ?? (await getPricing(env, publicModel)) ?? null;
    const limitResult = await checkRateLimit(env, auth.keyId, auth.limits, pricing?.rpmLimit, publicModel);
    if (!limitResult.ok) {
      await commitRateLimits(env);
      return openAiError(429, ErrorCode.RATE_LIMITED, limitResult.reason || "RPM 超限，请稍后重试", {
        retry_after: limitResult.retryAfter,
      });
    }
    if (auth.limits.concurrency > 0) concKeyId = auth.keyId;

    const routes = (await resolveRoutes(env, publicModel)).filter(isSupportedImageRoute).slice(0, MAX_IMAGE_ROUTES);
    if (!routes.length) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, `模型 ${publicModel} 不支持图片生成（当前支持 agnes-image / Codex / ChatGPT / Duck.ai 渠道）`);
    }

    let attempts = 0;
    let lastStatus = 0;
    let lastError = "";
    let lastIsQueueFull = false;

    for (const route of routes) {
      attempts++;
      const upstreamKey = route.encryptedKey ? await decryptSecret(env, route.encryptedKey) : "";
      const result = await generateImageByRoute(env, route, upstreamKey, body);

      if (result.ok) {
        if (route.providerKeyId !== "keyless") {
          await recordKeySuccess(env, route.providerId, route.providerKeyId).catch(() => {});
        }
        await logUsage(env, {
          requestId,
          userId: auth.userId,
          apiKeyId: auth.keyId,
          publicModel,
          providerId: route.providerId,
          upstreamModel: route.upstreamModel,
          status: "success",
          httpStatus: 200,
          latencyMs: Date.now() - started,
          attempts,
          ip: auth.ip,
        });
        const images = countGeneratedImages(result.body);
        return new Response(result.body ?? "", {
          status: 200,
          headers: {
            "content-type": result.contentType || "application/json; charset=utf-8",
            "x-images-generated": String(images),
          },
        });
      }

      lastStatus = result.httpStatus;
      lastError = result.error || "上游图片生成失败";
      lastIsQueueFull = isQueueFullError(result.code, result.error);

      if (route.providerKeyId !== "keyless") {
        // 排队满 / 参数错误不算账号问题，只有鉴权类与限流才记失败
        const shouldPenalize = !lastIsQueueFull && (result.httpStatus === 401 || result.httpStatus === 402 || result.httpStatus === 429 || result.httpStatus >= 500);
        if (shouldPenalize) {
          await recordKeyFailure(env, route.providerId, route.providerKeyId, result.httpStatus === 401 || result.httpStatus === 402).catch(() => {});
        }
      }

      // 4xx（参数/尺寸等）换账号也没意义，直接透传
      if (!lastIsQueueFull && result.httpStatus < 500 && result.httpStatus !== 429) break;
    }

    await logUsage(env, {
      requestId,
      userId: auth.userId,
      apiKeyId: auth.keyId,
      publicModel,
      status: "upstream_error",
      httpStatus: lastStatus || 502,
      latencyMs: Date.now() - started,
      errorCode: lastIsQueueFull ? "image_queue_full" : lastStatus ? `http_${lastStatus}` : "upstream_error",
      attempts,
      ip: auth.ip,
    });

    if (lastIsQueueFull) {
      return openAiError(429, ErrorCode.RATE_LIMITED, "上游图片队列已满，请稍后重试", {
        retry_after: 60,
        code: "image_queue_full",
      });
    }
    const status = lastStatus === 401 || lastStatus === 402 || (lastStatus >= 400 && lastStatus < 500) ? lastStatus : 502;
    return openAiError(status, ErrorCode.UPSTREAM_ERROR, lastError || "图片生成失败", { attempts });
  } catch (err) {
    return errorResponse(c, err);
  } finally {
    if (concKeyId) await releaseConcurrency(env, concKeyId).catch(() => {});
    await commitRateLimits(env).catch(() => {});
  }
});
