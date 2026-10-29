/**
 * POST /v1/chat/completions — OpenAI 兼容对话入口
 *
 * 性能要点（热路径）：
 *  - 认证 / 配置 / 路由 / 限流全部走进程内缓存，正常情况下 0 次 Blob 往返
 *  - 定价与路由并发加载，moderation 与限流并发执行
 *  - 流式响应 tee 后直接透传给客户端，记账在旁路完成，不阻塞首字与尾包
 *  - 用量与账本只做内存入队，批量落库（storage/write-behind.ts）
 */
import { Hono } from "hono";
import type { Env, HandlerCtx, UpstreamRoute } from "../types";
import { authenticateApiKey, billingScope, clientIp } from "../auth";
import { ApiError, ErrorCode, openAiError, errorResponse } from "../errors";
import { checkRateLimit, checkTpmBeforeRequest, reportTokenUsage, releaseConcurrency } from "../ratelimit";
import { moderate } from "../moderation";
import { getSettings } from "../settings";
import { requireRoutes } from "../router";
import { getPricing, hold, settle, releaseHold, estimateCost, type Pricing } from "../billing";
import { buildHeaders, resolveTarget, RETRYABLE_STATUS, estimateTokens } from "../providers";
import { recordKeySuccess, recordKeyFailure } from "../key-health";
import { uuid } from "../crypto";
import { addUsageRecord } from "../storage/db";

export const chatRouter = new Hono<{ Bindings: Env }>();

type ChatBody = {
  model?: string;
  stream?: boolean;
  messages?: { role: string; content: unknown }[];
  max_tokens?: number;
  stream_options?: { include_usage?: boolean };
};

/**
 * 旁路消费上游 SSE：只解析 usage 与 content 长度，不参与客户端数据通路。
 * 上游均已开启 stream_options.include_usage；缺失时按字符数粗略估算。
 */
async function drainStreamForUsage(
  body: ReadableStream<Uint8Array>,
  fallbackPrompt: number,
  onDone: (promptTokens: number, completionTokens: number) => Promise<void>
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let estimatedChars = 0;
  let sawUsage = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 2_000_000) buffer = buffer.slice(-500_000);
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload && payload !== "[DONE]") {
            if (payload.includes('"usage"')) {
              try {
                const json = JSON.parse(payload);
                if (json?.usage) {
                  promptTokens = json.usage.prompt_tokens ?? promptTokens;
                  completionTokens = json.usage.completion_tokens ?? completionTokens;
                  sawUsage = true;
                }
              } catch {}
            } else if (payload.includes('"delta"')) {
              try {
                const json = JSON.parse(payload);
                const text = json?.choices?.[0]?.delta?.content;
                if (typeof text === "string") estimatedChars += text.length;
              } catch {}
            }
          }
        }
        nl = buffer.indexOf("\n");
      }
    }
  } catch {
    // 上游中断：用已统计的数据结算
  }

  const finalPrompt = sawUsage && promptTokens > 0 ? promptTokens : fallbackPrompt;
  const finalCompletion = sawUsage && completionTokens > 0 ? completionTokens : Math.ceil(estimatedChars / 4);
  await onDone(finalPrompt, finalCompletion);
}

/** 单条路由最多重试次数（429 退避） */
const PER_ROUTE_RETRIES = 3;

async function fetchWithRetry(
  doFetch: () => Promise<Response>,
  maxRetries: number
): Promise<Response> {
  let resp: Response | null = null;
  for (let sub = 0; sub < maxRetries; sub++) {
    if (sub > 0 && resp) {
      const retryAfter = Number(resp.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 8000) : 1500 * sub;
      await new Promise((r) => setTimeout(r, delay));
    }
    resp = await doFetch();
    if (resp.status === 429 && sub < maxRetries - 1) continue;
    break;
  }
  return resp!;
}

chatRouter.post("/", async (c) => {
  const env = c.env;
  const requestId = c.req.header("x-request-id") || uuid();
  const started = Date.now();
  let released = false;
  let activeKeyId: string | null = null;

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
    activeKeyId = key.keyId;
    const body = await c.req.json<ChatBody>();

    if (!body.model || !Array.isArray(body.messages)) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 model 或 messages");
    }
    const publicModel = body.model;
    const stream = !!body.stream;
    const subModelName = publicModel.includes("/") ? publicModel.slice(publicModel.indexOf("/") + 1) : publicModel;

    if (key.modelWhitelist && !key.modelWhitelist.includes(publicModel) && !key.modelWhitelist.includes(subModelName)) {
      throw new ApiError(403, ErrorCode.MODEL_NOT_ALLOWED, `该 Key 无权调用模型 ${publicModel}`);
    }

    const promptText = body.messages
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");

    /* ---- 定价 / 路由 / 内容安全 并发加载 ---- */
    const settings = await getSettings(env);
    const [pricingDirect, routes, mod] = await Promise.all([
      getPricing(env, publicModel),
      requireRoutes(env, publicModel),
      moderate(hCtx, {
        settings,
        userId: key.userId,
        apiKeyId: key.keyId,
        requestId,
        model: publicModel,
        text: promptText,
      }),
    ]);

    const pricing = pricingDirect || (subModelName !== publicModel ? await getPricing(env, subModelName) : null);
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
        stream: stream ? 1 : 0,
        attempts: 1,
        ip: clientIp(hCtx.req),
        createdAt: Math.floor(Date.now() / 1000),
      });
      throw new ApiError(400, ErrorCode.CONTENT_BLOCKED, "请求内容触发安全策略，已被拦截并进入人工复核", {
        rule: mod.rule,
        request_id: requestId,
      });
    }

    /* ---- 计费预检 ---- */
    const effectivePricing: Pricing | null = pricing || (routes[0] ? await getPricing(env, routes[0].upstreamModel) : null);
    const estPrompt = estimateTokens(promptText);
    const estCompletion = body.max_tokens ?? 1024;
    const estCost = effectivePricing ? estimateCost(effectivePricing, estPrompt, estCompletion) : 0;
    const scope = billingScope(key.userId, key.orgId);
    const { holdId } = await hold(hCtx, scope, estCost, requestId, key.userRole);

    /* ---- 依次尝试上游（故障转移与多 Key 容灾） ---- */
    let attempts = 0;
    let lastUpstreamError = "";
    const candidateRoutes = routes.slice(0, 5);

    const recordFailure = async (route: UpstreamRoute, status?: number) => {
      if (route.providerKeyId && route.providerKeyId !== "keyless") {
        const isTerminal = status === 401 || status === 402;
        await recordKeyFailure(env, route.providerId, route.providerKeyId, isTerminal).catch(() => {});
      }
    };

    const recordSuccess = async (route: UpstreamRoute) => {
      if (route.providerKeyId && route.providerKeyId !== "keyless") {
        await recordKeySuccess(env, route.providerId, route.providerKeyId).catch(() => {});
      }
    };

    const finalize = async (args: {
      route: UpstreamRoute;
      promptTokens: number;
      completionTokens: number;
      streamFlag: 0 | 1;
      status: string;
      httpStatus: number;
    }) => {
      if (released) return;
      released = true;
      const cost = effectivePricing ? estimateCost(effectivePricing, args.promptTokens, args.completionTokens) : 0;
      await releaseConcurrency(env, key.keyId);
      await settle(hCtx, {
        scope,
        holdId,
        heldAmount: estCost,
        actualCost: cost,
        requestId,
        userId: key.userId,
        apiKeyId: key.keyId,
        unlimited: key.userRole === "superadmin",
      });
      await reportTokenUsage(env, key.keyId, args.promptTokens + args.completionTokens);
      await addUsageRecord(env, {
        id: uuid(),
        requestId,
        userId: key.userId,
        apiKeyId: key.keyId,
        publicModel,
        providerId: args.route.providerId,
        upstreamModel: args.route.upstreamModel,
        status: args.status,
        httpStatus: args.httpStatus,
        latencyMs: Date.now() - started,
        promptTokens: args.promptTokens,
        completionTokens: args.completionTokens,
        costUsd: cost,
        currency: "CNY",
        stream: args.streamFlag,
        attempts,
        ip: clientIp(hCtx.req),
        createdAt: Math.floor(Date.now() / 1000),
      });
    };

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

          resp = await fetchWithRetry(
            () =>
              fetch(antUrl, {
                method: "POST",
                headers,
                body: JSON.stringify(antRequest),
                signal: AbortSignal.timeout(120_000),
              }),
            PER_ROUTE_RETRIES
          );
        } else {
          const { url } = resolveTarget(env, route);
          const headers = await buildHeaders(env, route);
          const upstreamBody: Record<string, unknown> = {
            ...body,
            model: route.upstreamModel,
          };
          if (stream) upstreamBody.stream_options = { include_usage: true };

          resp = await fetchWithRetry(
            () =>
              fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(upstreamBody),
                signal: AbortSignal.timeout(120_000),
              }),
            PER_ROUTE_RETRIES
          );
        }

        if (!resp) throw new Error("no response from upstream");

        if (!resp.ok) {
          lastUpstreamError = `status ${resp.status}`;
          await recordFailure(route, resp.status);
          const isAuthOrQuota = resp.status === 401 || resp.status === 402;
          if (RETRYABLE_STATUS.has(resp.status) || (isAuthOrQuota && attempts < candidateRoutes.length)) {
            continue;
          }
          const errText = await resp.text();
          if (!released) {
            released = true;
            await releaseHold(hCtx, scope, holdId, estCost, requestId);
            await releaseConcurrency(env, key.keyId);
          }
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

        await recordSuccess(route);

        /* ---- Anthropic 协议响应转换 ---- */
        if (isAnthropic) {
          const { createOpenAIStreamFromAnthropic, anthropicResponseToOpenAI } = await import("../anthropic-translate");
          if (stream && resp.body) {
            let promptTokens = estPrompt;
            let completionTokens = 0;
            const antStream = createOpenAIStreamFromAnthropic(resp.body, publicModel, async (u) => {
              promptTokens = u.promptTokens || promptTokens;
              completionTokens = u.completionTokens || completionTokens;
              await finalize({ route, promptTokens, completionTokens, streamFlag: 1, status: "success", httpStatus: 200 });
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
          await finalize({ route, promptTokens, completionTokens, streamFlag: 0, status: "success", httpStatus: 200 });
          return new Response(JSON.stringify(openAiData), {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "x-request-id": requestId,
            },
          });
        }

        /* ---- 成功返回：流式 tee 直通 + 旁路记账 ---- */
        if (stream && resp.body) {
          const [clientBody, tapBody] = resp.body.tee();
          void drainStreamForUsage(tapBody, estPrompt, async (promptTokens, completionTokens) => {
            await finalize({ route, promptTokens, completionTokens, streamFlag: 1, status: "success", httpStatus: 200 });
          }).catch(async () => {
            if (!released) {
              released = true;
              await releaseHold(hCtx, scope, holdId, estCost, requestId);
              await releaseConcurrency(env, key.keyId);
            }
          });

          return new Response(clientBody, {
            status: 200,
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache, no-transform",
              connection: "keep-alive",
              "x-request-id": requestId,
              "x-accel-buffering": "no",
            },
          });
        }

        // 非流式
        const data = (await resp.json()) as {
          usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        };
        const promptTokens = data.usage?.prompt_tokens ?? estPrompt;
        const completionTokens = data.usage?.completion_tokens ?? estCompletion;
        await finalize({ route, promptTokens, completionTokens, streamFlag: 0, status: "success", httpStatus: 200 });

        return new Response(JSON.stringify(data), {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "x-request-id": requestId,
          },
        });
      } catch (err: any) {
        lastUpstreamError = err?.message || String(err);
        await recordFailure(route);
      }
    }

    // 全部上游重试失败
    if (!released) {
      released = true;
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
    if (!released && activeKeyId) {
      // 保证并发与冻结额度清理
      releaseConcurrency(env, activeKeyId).catch(() => {});
    }
    return errorResponse(hCtx, err);
  }
});
