/**
 * POST /v1/chat/completions — OpenAI 兼容对话入口
 */
import { Hono } from "hono";
import type { Env, HandlerCtx } from "../types";
import { authenticateApiKey, billingScope, clientIp } from "../auth";
import { ApiError, ErrorCode, openAiError, errorResponse } from "../errors";
import { checkRateLimit, checkTpmBeforeRequest, reportTokenUsage, releaseConcurrency } from "../ratelimit";
import { moderate } from "../moderation";
import { getSettings } from "../settings";
import { requireRoutes } from "../router";
import { getPricing, hold, settle, releaseHold, estimateCost } from "../billing";
import { buildHeaders, resolveTarget, RETRYABLE_STATUS, estimateTokens } from "../providers";
import { recordKeySuccess, recordKeyFailure } from "../key-health";
import { uuid } from "../crypto";
import { addUsageRecord } from "../storage/db";

export const chatRouter = new Hono<{ Bindings: Env }>();

chatRouter.post("/", async (c) => {
  const env = c.env;
  const requestId = c.req.header("x-request-id") || uuid();
  const started = Date.now();
  let released = false;

  const hCtx: HandlerCtx = {
    env,
    req: {
      url: c.req.url,
      method: c.req.method,
      header: (n) => c.req.header(n),
      text: () => c.req.text(),
      json: <T = unknown>() => c.req.json<T>(),
    },
  };

  try {
    const key = await authenticateApiKey(hCtx);
    const settings = await getSettings(env);

    const body = await c.req.json<{
      model?: string;
      stream?: boolean;
      messages?: { role: string; content: unknown }[];
      max_tokens?: number;
      stream_options?: { include_usage?: boolean };
    }>();

    if (!body.model || !Array.isArray(body.messages)) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 model 或 messages");
    }
    const publicModel = body.model;

    const subModelName = publicModel.includes("/") ? publicModel.slice(publicModel.indexOf("/") + 1) : publicModel;
    if (key.modelWhitelist && !key.modelWhitelist.includes(publicModel) && !key.modelWhitelist.includes(subModelName)) {
      throw new ApiError(403, ErrorCode.MODEL_NOT_ALLOWED, `该 Key 无权调用模型 ${publicModel}`);
    }

    /* ---- 限流与定价预检 ---- */
    const pricing = (await getPricing(env, publicModel)) || (await getPricing(env, subModelName));
    const modelRpm = pricing?.rpmLimit;

    /* ---- 用户角色与模型分级门禁 ---- */
    // 普通用户仅限使用免费模型（0元定价）；VIP 用户与管理员可解锁全量付费模型并真实扣费
    const isPaidModel = !!pricing && (pricing.inputPerMillion > 0 || pricing.outputPerMillion > 0);
    const userRole = key.userRole || "user";
    if (userRole === "user" && isPaidModel) {
      throw new ApiError(
        403,
        ErrorCode.MODEL_NOT_ALLOWED,
        `模型「${publicModel}」为付费高级模型，普通用户仅可调用免费模型池。请联系管理员升级为 VIP 账号解锁全量付费模型！`
      );
    }

    if (!(await checkTpmBeforeRequest(env, key.keyId, key.limits))) {
      return openAiError(429, ErrorCode.RATE_LIMITED, "TPM 超限", { retry_after: 60 });
    }
    const limit = await checkRateLimit(env, key.keyId, key.limits, modelRpm, publicModel);
    if (!limit.ok) {
      return openAiError(429, ErrorCode.RATE_LIMITED, limit.reason || `${limit.kind?.toUpperCase()} 超限，请稍后重试`, {
        retry_after: limit.retryAfter,
      });
    }

    /* ---- 内容安全 ---- */
    const promptText = body.messages
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    const mod = await moderate(hCtx, {
      settings,
      userId: key.userId,
      apiKeyId: key.keyId,
      requestId,
      model: publicModel,
      text: promptText,
    });
    if (mod.flagged) {
      await addUsageRecord(env, {
        id: uuid(),
        requestId,
        userId: key.userId,
        apiKeyId: key.keyId,
        publicModel,
        status: "content_blocked",
        httpStatus: 400,
        latencyMs: Date.now() - started,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        currency: "CNY",
        stream: body.stream ? 1 : 0,
        attempts: 1,
        ip: clientIp(hCtx.req),
        createdAt: Math.floor(Date.now() / 1000),
      });
      throw new ApiError(400, ErrorCode.CONTENT_BLOCKED, "请求内容触发安全策略，已被拦截并进入人工复核", {
        rule: mod.rule,
        request_id: requestId,
      });
    }

    /* ---- 路由与计费预检 ---- */
    const routes = await requireRoutes(env, publicModel);
    const effectivePricing = pricing || (routes[0] ? await getPricing(env, routes[0].upstreamModel) : null);
    const estPrompt = estimateTokens(promptText);
    const estCompletion = body.max_tokens ?? 1024;
    const estCost = effectivePricing ? estimateCost(effectivePricing, estPrompt, estCompletion) : 0;
    const scope = billingScope(key.userId, key.orgId);
    const { holdId } = await hold(hCtx, scope, estCost, requestId, key.userRole);

    /* ---- 依次尝试上游（故障转移与多 Key 容灾） ---- */
    const stream = !!body.stream;
    let attempts = 0;
    let lastUpstreamError = "";
    const candidateRoutes = routes.slice(0, 5);
    for (const route of candidateRoutes) {
      attempts++;
      try {
        const isOpencode = route.providerKind === "opencode" || route.providerSlug === "opencode";
        const isDuckai = route.providerKind === "duckai" || route.providerSlug === "duckai";
        const isAnthropic = route.providerKind === "anthropic" || route.providerSlug === "anthropic";

        let resp: Response | null = null;
        if (isOpencode) {
          const { proxyOpenCodeRequest, resolveOpenCodeUrls, resolveOpenCodeRelay } = await import("../opencode");
          const mirrors = resolveOpenCodeUrls(env);
          const relay = resolveOpenCodeRelay(env);
          resp = await proxyOpenCodeRequest({
            baseUrl: route.baseUrl || "https://opencode.ai/zen/v1",
            apiKeys: [],
            method: "POST",
            subPath: "chat/completions",
            body: JSON.stringify({
              ...body,
              model: route.upstreamModel,
              stream,
            }),
            mirrorUrls: mirrors,
            relay,
          });
        } else if (isDuckai) {
          const { handleDuckAiRequest } = await import("../duckai");
          resp = await handleDuckAiRequest({
            model: route.upstreamModel,
            messages: body.messages,
            stream,
          });
        } else if (isAnthropic) {
          const { openAIToAnthropicRequest } = await import("../anthropic-translate");
          const { request: antRequest } = openAIToAnthropicRequest({ ...body, model: route.upstreamModel, stream });
          const base = route.baseUrl.replace(/\/+$/, "");
          const antUrl = `${base}/v1/messages`;
          const headers = await buildHeaders(env, route);
          headers["anthropic-version"] = "2023-06-01";

          for (let sub = 0; sub < 3; sub++) {
            if (sub > 0) {
              const retryAfter = Number(resp?.headers.get("retry-after"));
              const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 8000) : 1500 * sub;
              await new Promise((r) => setTimeout(r, delay));
            }
            resp = await fetch(antUrl, {
              method: "POST",
              headers,
              body: JSON.stringify(antRequest),
              signal: AbortSignal.timeout(120_000),
            });
            if (resp.status === 429 && sub < 2) continue;
            break;
          }
        } else {
          const { url } = resolveTarget(env, route);
          const headers = await buildHeaders(env, route);
          const upstreamBody: Record<string, unknown> = {
            ...body,
            model: route.upstreamModel,
          };
          if (stream) upstreamBody.stream_options = { include_usage: true };

          for (let sub = 0; sub < 3; sub++) {
            if (sub > 0) {
              const retryAfter = Number(resp?.headers.get("retry-after"));
              const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 8000) : 1500 * sub;
              await new Promise((r) => setTimeout(r, delay));
            }
            resp = await fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify(upstreamBody),
              signal: AbortSignal.timeout(120_000),
            });
            if (resp.status === 429 && sub < 2) continue;
            break;
          }
        }

        if (!resp) throw new Error("no response from upstream");

        if (!resp.ok) {
          lastUpstreamError = `status ${resp.status}`;
          if (route.providerKeyId && route.providerKeyId !== "keyless") {
            const isTerminal = resp.status === 401 || resp.status === 402;
            await recordKeyFailure(env, route.providerId, route.providerKeyId, isTerminal).catch(() => {});
          }
          const isAuthOrQuota = resp.status === 401 || resp.status === 402;
          if (RETRYABLE_STATUS.has(resp.status) || (isAuthOrQuota && attempts < candidateRoutes.length)) {
            continue;
          }
          const errText = await resp.text();
          await releaseHold(hCtx, scope, holdId, estCost, requestId);
          released = true;
          await releaseConcurrency(env, key.keyId);
          await addUsageRecord(env, {
            id: uuid(),
            requestId,
            userId: key.userId,
            apiKeyId: key.keyId,
            publicModel,
            providerId: route.providerId,
            upstreamModel: route.upstreamModel,
            status: "upstream_error",
            httpStatus: resp.status,
            latencyMs: Date.now() - started,
            promptTokens: 0,
            completionTokens: 0,
            costUsd: 0,
            currency: "CNY",
            stream: stream ? 1 : 0,
            errorCode: `http_${resp.status}`,
            attempts,
            ip: clientIp(hCtx.req),
            createdAt: Math.floor(Date.now() / 1000),
          });
          return new Response(errText, { status: resp.status, headers: { "content-type": "application/json" } });
        }

        if (route.providerKeyId && route.providerKeyId !== "keyless") {
          await recordKeySuccess(env, route.providerId, route.providerKeyId).catch(() => {});
        }

        /* ---- Anthropic 协议响应转换 ---- */
        if (isAnthropic) {
          const { createOpenAIStreamFromAnthropic, anthropicResponseToOpenAI } = await import("../anthropic-translate");
          if (stream && resp.body) {
            let promptTokens = estPrompt;
            let completionTokens = 0;
            const antStream = createOpenAIStreamFromAnthropic(resp.body, publicModel, async (u) => {
              promptTokens = u.promptTokens || promptTokens;
              completionTokens = u.completionTokens || completionTokens;
              if (!released) {
                released = true;
                await releaseConcurrency(env, key.keyId);
                const cost = effectivePricing ? estimateCost(effectivePricing, promptTokens, completionTokens) : 0;
                await settle(hCtx, {
                  scope,
                  holdId,
                  heldAmount: estCost,
                  actualCost: cost,
                  requestId,
                  userId: key.userId,
                  apiKeyId: key.keyId,
                });
                await reportTokenUsage(env, key.keyId, promptTokens + completionTokens);
                await addUsageRecord(env, {
                  id: uuid(),
                  requestId,
                  userId: key.userId,
                  apiKeyId: key.keyId,
                  publicModel,
                  providerId: route.providerId,
                  upstreamModel: route.upstreamModel,
                  status: "success",
                  httpStatus: 200,
                  latencyMs: Date.now() - started,
                  promptTokens,
                  completionTokens,
                  costUsd: cost,
                  currency: "CNY",
                  stream: 1,
                  attempts,
                  ip: clientIp(hCtx.req),
                  createdAt: Math.floor(Date.now() / 1000),
                });
              }
            });
            return new Response(antStream, {
              headers: {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache",
                "connection": "keep-alive",
                "x-request-id": requestId,
              },
            });
          }

          // 非流式
          const antJson = await resp.json();
          const openAiData = anthropicResponseToOpenAI(antJson, publicModel);
          const promptTokens = openAiData.usage?.prompt_tokens ?? estPrompt;
          const completionTokens = openAiData.usage?.completion_tokens ?? estCompletion;
          const cost = effectivePricing ? estimateCost(effectivePricing, promptTokens, completionTokens) : 0;
          await settle(hCtx, {
            scope,
            holdId,
            heldAmount: estCost,
            actualCost: cost,
            requestId,
            userId: key.userId,
            apiKeyId: key.keyId,
          });
          released = true;
          await releaseConcurrency(env, key.keyId);
          await reportTokenUsage(env, key.keyId, promptTokens + completionTokens);
          await addUsageRecord(env, {
            id: uuid(),
            requestId,
            userId: key.userId,
            apiKeyId: key.keyId,
            publicModel,
            providerId: route.providerId,
            upstreamModel: route.upstreamModel,
            status: "success",
            httpStatus: 200,
            latencyMs: Date.now() - started,
            promptTokens,
            completionTokens,
            costUsd: cost,
            currency: "CNY",
            stream: 0,
            attempts,
            ip: clientIp(hCtx.req),
            createdAt: Math.floor(Date.now() / 1000),
          });
          return new Response(JSON.stringify(openAiData), {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "x-request-id": requestId,
            },
          });
        }

        /* ---- 成功返回：流式 vs 非流式 ---- */
        if (stream && resp.body) {
          const reader = resp.body.getReader();
          const encoder = new TextEncoder();
          const decoder = new TextDecoder();
          let promptTokens = estPrompt;
          let completionTokens = 0;
          let buffer = "";

          const readable = new ReadableStream({
            async pull(controller) {
              try {
                const { done, value } = await reader.read();
                if (done) {
                  controller.close();
                  if (!released) {
                    released = true;
                    await releaseConcurrency(env, key.keyId);
                    const cost = pricing ? estimateCost(pricing, promptTokens, completionTokens) : 0;
                    await settle(hCtx, {
                      scope,
                      holdId,
                      heldAmount: estCost,
                      actualCost: cost,
                      requestId,
                      userId: key.userId,
                      apiKeyId: key.keyId,
                    });
                    await reportTokenUsage(env, key.keyId, promptTokens + completionTokens);
                    await addUsageRecord(env, {
                      id: uuid(),
                      requestId,
                      userId: key.userId,
                      apiKeyId: key.keyId,
                      publicModel,
                      providerId: route.providerId,
                      upstreamModel: route.upstreamModel,
                      status: "success",
                      httpStatus: 200,
                      latencyMs: Date.now() - started,
                      promptTokens,
                      completionTokens,
                      costUsd: cost,
                      currency: "CNY",
                      stream: 1,
                      attempts,
                      ip: clientIp(hCtx.req),
                      createdAt: Math.floor(Date.now() / 1000),
                    });
                  }
                  return;
                }

                controller.enqueue(value);
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (trimmed.startsWith("data:") && !trimmed.endsWith("[DONE]")) {
                    try {
                      const jsonStr = trimmed.slice(5).trim();
                      const payload = JSON.parse(jsonStr);
                      if (payload.usage) {
                        promptTokens = payload.usage.prompt_tokens ?? promptTokens;
                        completionTokens = payload.usage.completion_tokens ?? completionTokens;
                      } else if (payload.choices?.[0]?.delta?.content) {
                        completionTokens += estimateTokens(payload.choices[0].delta.content);
                      }
                    } catch {}
                  }
                }
              } catch (err) {
                controller.error(err);
                if (!released) {
                  released = true;
                  await releaseHold(hCtx, scope, holdId, estCost, requestId);
                  await releaseConcurrency(env, key.keyId);
                }
              }
            },
            cancel() {
              reader.cancel();
              if (!released) {
                released = true;
                releaseHold(hCtx, scope, holdId, estCost, requestId).catch(() => {});
                releaseConcurrency(env, key.keyId).catch(() => {});
              }
            },
          });

          return new Response(readable, {
            status: 200,
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              connection: "keep-alive",
              "x-request-id": requestId,
            },
          });
        }

        // 非流式
        const data = (await resp.json()) as {
          usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        };
        const promptTokens = data.usage?.prompt_tokens ?? estPrompt;
        const completionTokens = data.usage?.completion_tokens ?? estCompletion;
        const cost = pricing ? estimateCost(pricing, promptTokens, completionTokens) : 0;

        await settle(hCtx, {
          scope,
          holdId,
          heldAmount: estCost,
          actualCost: cost,
          requestId,
          userId: key.userId,
          apiKeyId: key.keyId,
        });
        released = true;
        await releaseConcurrency(env, key.keyId);
        await reportTokenUsage(env, key.keyId, promptTokens + completionTokens);
        await addUsageRecord(env, {
          id: uuid(),
          requestId,
          userId: key.userId,
          apiKeyId: key.keyId,
          publicModel,
          providerId: route.providerId,
          upstreamModel: route.upstreamModel,
          status: "success",
          httpStatus: 200,
          latencyMs: Date.now() - started,
          promptTokens,
          completionTokens,
          costUsd: cost,
          currency: "CNY",
          stream: 0,
          attempts,
          ip: clientIp(hCtx.req),
          createdAt: Math.floor(Date.now() / 1000),
        });

        return new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-request-id": requestId,
          },
        });
      } catch (err: any) {
        lastUpstreamError = err?.message || String(err);
        if (route.providerKeyId && route.providerKeyId !== "keyless") {
          await recordKeyFailure(env, route.providerId, route.providerKeyId, false).catch(() => {});
        }
      }
    }

    // 全部上游重试失败
    if (!released) {
      await releaseHold(hCtx, scope, holdId, estCost, requestId);
      await releaseConcurrency(env, key.keyId);
    }
    await addUsageRecord(env, {
      id: uuid(),
      requestId,
      userId: key.userId,
      apiKeyId: key.keyId,
      publicModel,
      status: "upstream_exhausted",
      httpStatus: 502,
      latencyMs: Date.now() - started,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      currency: "CNY",
      stream: stream ? 1 : 0,
      errorCode: "all_upstreams_failed",
      attempts,
      ip: clientIp(hCtx.req),
      createdAt: Math.floor(Date.now() / 1000),
    });

    return openAiError(502, ErrorCode.UPSTREAM_ERROR, `所有可用上游均调用失败（已尝试 ${attempts} 条路由）：${lastUpstreamError}`);
  } catch (err) {
    if (!released) {
      // 保证并发与冻结额度清理
      releaseConcurrency(env, "unknown").catch(() => {});
    }
    return errorResponse(hCtx, err);
  }
});
