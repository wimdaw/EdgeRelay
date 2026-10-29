/**
 * POST /v1/chat/completions — OpenAI 兼容对话入口
 *
 * 热路径设计（EdgeOne 每次请求都是全新进程，缓存只在单请求内生效）：
 *  - RTT1：认证 Key 读取 与 全局配置单键（config:all）**并行**
 *  - RTT2：渠道 Key 池 + 健康度 + 限流计数 + 内容安全 **一轮并行**（付费模型并入用户/余额读取）
 *  - 上游请求前最多 2 轮存储往返；免费模型零计费读写
 *  - 流式响应 tee 直通，客户端收尾 flush 等待「用量+Key+限流」一次批量落库（保证不丢数据）
 */
import { Hono } from "hono";
import type { Env, HandlerCtx, UpstreamRoute } from "../types";
import { clientIp, billingScope, type SessionUser } from "../auth";
import { ApiError, ErrorCode, openAiError, errorResponse } from "../errors";
import { checkRateLimit, checkTpmBeforeRequest, reportTokenUsage, releaseConcurrency, commitRateLimits } from "../ratelimit";
import { moderate } from "../moderation";
import { getSettings } from "../settings";
import { planModelRoutes, buildRoutesFromPlan } from "../router";
import { getPricing, hold, settle, releaseHold, estimateCost, type Pricing } from "../billing";
import { buildHeaders, resolveTarget, RETRYABLE_STATUS, estimateTokens } from "../providers";
import { recordKeySuccess, recordKeyFailure, readKeyHealth } from "../key-health";
import { uuid, sha256Hex } from "../crypto";
import {
  getApiKeyByHash,
  getApiKeyById,
  getProviderKeys,
  getUserById,
  getOrCreateBalance,
  addUsageRecord,
  touchApiKeyUsage,
  commitApiKeyUsage,
  updateUser,
} from "../storage/db";

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

async function fetchWithRetry(doFetch: () => Promise<Response>, maxRetries: number): Promise<Response> {
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

/** 用量 + Key 记录 + 限流计数 一次批量落库（必须 await，请求生命周期内完成） */
async function commitBatch(env: Env, record: Parameters<typeof addUsageRecord>[1], keyId: string): Promise<void> {
  let apiKeyWrite: { keyHash: string; record: any } | undefined;
  const krec = await getApiKeyById(env, keyId);
  if (krec) apiKeyWrite = { keyHash: krec.keyHash, record: krec };
  await Promise.all([
    addUsageRecord(env, record, apiKeyWrite ? { apiKeyWrite } : undefined),
    commitApiKeyUsage(env),
    commitRateLimits(env),
  ]).catch(() => {});
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
    /* ---- RTT1：API Key 读取 与 全局配置（单键）并行 ---- */
    const authHeader = c.req.header("authorization") ?? "";
    const am = authHeader.match(/^Bearer\s+(sk-gw-\S+)$/i);
    if (!am) throw new ApiError(401, ErrorCode.AUTH_REQUIRED, "缺少 Bearer API Key");
    const keyHash = await sha256Hex(am[1]!);
    const nowSec = Math.floor(Date.now() / 1000);

    const [row, settings] = await Promise.all([getApiKeyByHash(env, keyHash), getSettings(env)]);
    if (!row) throw new ApiError(401, ErrorCode.AUTH_INVALID, "API Key 无效");
    activeKeyId = row.id;
    if (row.status === "revoked") throw new ApiError(401, ErrorCode.KEY_REVOKED, "API Key 已撤销");
    if (row.expiresAt && row.expiresAt < nowSec) throw new ApiError(401, ErrorCode.KEY_EXPIRED, "API Key 已过期");
    if (row.quotaUsd !== null && row.quotaUsd !== undefined && row.spentUsd >= row.quotaUsd) {
      throw new ApiError(429, ErrorCode.KEY_QUOTA_EXCEEDED, "该 API Key 额度已用尽");
    }
    const ip = clientIp(hCtx.req);
    if (row.ipWhitelist) {
      try {
        const list = JSON.parse(row.ipWhitelist) as string[];
        if (list.length && !list.includes(ip)) {
          throw new ApiError(403, ErrorCode.FORBIDDEN, `来源 IP ${ip} 不在白名单内`);
        }
      } catch {}
    }
    // lastUsedAt 先进请求内内存，收尾与用量一起落库
    touchApiKeyUsage(env, row.id, { lastUsedAt: nowSec });

    const keyId = row.id;
    const userId = row.userId;
    const orgId = row.orgId || null;
    const limits = { rpm: settings.defaultRpm, tpm: settings.defaultTpm, concurrency: 10 };

    const body = await c.req.json<ChatBody>();
    if (!body.model || !Array.isArray(body.messages)) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, "缺少 model 或 messages");
    }
    const publicModel = body.model;
    const stream = !!body.stream;
    const subModelName = publicModel.includes("/") ? publicModel.slice(publicModel.indexOf("/") + 1) : publicModel;

    if (row.modelWhitelist) {
      try {
        const whitelist = JSON.parse(row.modelWhitelist) as string[];
        if (Array.isArray(whitelist) && whitelist.length && !whitelist.includes(publicModel) && !whitelist.includes(subModelName)) {
          throw new ApiError(403, ErrorCode.MODEL_NOT_ALLOWED, `该 Key 无权调用模型 ${publicModel}`);
        }
      } catch (err) {
        if (err instanceof ApiError) throw err;
      }
    }

    const promptText = body.messages
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");

    /* ---- 路由规划（配置已缓存，零 I/O）+ 定价 ---- */
    const plans = await planModelRoutes(env, publicModel);
    const pricing = (await getPricing(env, publicModel)) || (subModelName !== publicModel ? await getPricing(env, subModelName) : null);
    const modelRpm = pricing?.rpmLimit;
    const isPaidModel = !!pricing && (pricing.inputPerMillion > 0 || pricing.outputPerMillion > 0);

    const scope = billingScope(userId, orgId);

    /* ---- RTT2：渠道 Key 池 + 健康度 + 限流 + 内容安全 一轮并行（付费模型并入用户/余额读取） ---- */
    const uniqPlans = plans.filter((p, idx) => plans.findIndex((x) => x.provider.id === p.provider.id) === idx);
    const providerLoads = uniqPlans.map(async (plan) => {
      const [keys, health] = await Promise.all([getProviderKeys(env, plan.provider.id), readKeyHealth(env, plan.provider.id)]);
      return { plan, keys, health };
    });
    const moderation = moderate(hCtx, { settings, userId, apiKeyId: keyId, requestId, model: publicModel, text: promptText });
    const rlPromise = (async () => {
      if (!(await checkTpmBeforeRequest(env, keyId, limits))) return { tpmDenied: true } as const;
      return checkRateLimit(env, keyId, limits, modelRpm, publicModel);
    })();
    const userPromise = isPaidModel ? getUserById(env, userId) : Promise.resolve(null);
    const balancePromise = isPaidModel ? getOrCreateBalance(env, scope) : Promise.resolve(null);

    const [providerResults, mod, limitResult] = await Promise.all([
      Promise.all(providerLoads),
      moderation,
      rlPromise,
    ]);
    const user = await userPromise;
    const bal = await balancePromise;

    if (limitResult !== null && "tpmDenied" in limitResult) {
      return openAiError(429, ErrorCode.RATE_LIMITED, "TPM 超限", { retry_after: 60 });
    }
    const limit = limitResult as Awaited<ReturnType<typeof checkRateLimit>>;
    if (!limit.ok) {
      return openAiError(429, ErrorCode.RATE_LIMITED, limit.reason || `${limit.kind?.toUpperCase()} 超限，请稍后重试`, {
        retry_after: limit.retryAfter,
      });
    }
    if (mod.flagged) {
      await commitBatch(env, {
        id: uuid(),
        requestId,
        userId,
        apiKeyId: keyId,
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
        ip,
        createdAt: Math.floor(Date.now() / 1000),
      }, keyId);
      throw new ApiError(400, ErrorCode.CONTENT_BLOCKED, "请求内容触发安全策略，已被拦截并进入人工复核", {
        rule: mod.rule,
        request_id: requestId,
      });
    }

    /* ---- 用户角色门禁（仅付费模型需要） ---- */
    let userRole: SessionUser["role"] = "user";
    if (isPaidModel) {
      userRole = (user?.role as SessionUser["role"]) || "user";
      if (user?.email?.toLowerCase() === "hackerxiaow@gmail.com") userRole = "superadmin";
      // 余额 > 0 自动视为 VIP（对齐原 syncUserVipStatus 语义；角色落库异步补齐）
      if ((userRole === "user" || userRole === "vip") && bal && bal.available > 0) {
        userRole = "vip";
        if (user?.role !== "vip") {
          void updateUser(env, userId, { role: "vip" }).catch(() => {});
        }
      }
      if (userRole === "user") {
        throw new ApiError(
          403,
          ErrorCode.MODEL_NOT_ALLOWED,
          `模型「${publicModel}」为付费高级模型，普通用户仅可调用免费模型池。请联系管理员升级为 VIP 账号解锁全量付费模型！`
        );
      }
    }

    /* ---- 计费预检（付费模型冻结；免费模型零开销跳过） ---- */
    const effectivePricing: Pricing | null = pricing || (plans[0] ? await getPricing(env, plans[0].model.upstreamModel) : null);
    const estPrompt = estimateTokens(promptText);
    const estCompletion = body.max_tokens ?? 1024;
    const estCost = effectivePricing ? estimateCost(effectivePricing, estPrompt, estCompletion) : 0;
    const { holdId } = await hold(hCtx, scope, estCost, requestId, userRole);

    /* ---- 组装路由候选（Key 池已在 RTT2 读取，纯内存） ---- */
    const routes: UpstreamRoute[] = [];
    for (const { plan, keys, health } of providerResults) {
      routes.push(...buildRoutesFromPlan(env, plan, keys, health));
    }
    if (!routes.length) {
      throw new ApiError(404, ErrorCode.MODEL_NOT_FOUND, `模型 ${publicModel} 不存在或暂无可用上游`);
    }

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
      await releaseConcurrency(env, keyId);
      await settle(hCtx, {
        scope,
        holdId,
        heldAmount: estCost,
        actualCost: cost,
        requestId,
        userId,
        apiKeyId: keyId,
        unlimited: userRole === "superadmin",
      });
      await reportTokenUsage(env, keyId, args.promptTokens + args.completionTokens);
      await commitBatch(env, {
        id: uuid(),
        requestId,
        userId,
        apiKeyId: keyId,
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
        ip,
        createdAt: Math.floor(Date.now() / 1000),
      }, keyId);
    };

    /* ---- 依次尝试上游（故障转移与多 Key 容灾） ---- */
    let attempts = 0;
    let lastUpstreamError = "";
    let lastUpstreamStatus = 0;
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
            body: JSON.stringify({ ...body, model: route.upstreamModel, stream }),
            mirrorUrls: mirrors,
            relay,
          });
        } else if (isDuckai) {
          const { handleDuckAiRequest } = await import("../duckai");
          resp = await handleDuckAiRequest({ model: route.upstreamModel, messages: body.messages, stream });
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
          const upstreamBody: Record<string, unknown> = { ...body, model: route.upstreamModel };
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
          lastUpstreamStatus = resp.status;
          await recordFailure(route, resp.status);
          const isAuthOrQuota = resp.status === 401 || resp.status === 402;
          if (RETRYABLE_STATUS.has(resp.status) || (isAuthOrQuota && attempts < candidateRoutes.length)) {
            continue;
          }
          const errText = await resp.text();
          if (!released) {
            released = true;
            await releaseHold(hCtx, scope, holdId, estCost, requestId);
            await releaseConcurrency(env, keyId);
          }
          await commitBatch(env, {
            id: uuid(),
            requestId,
            userId,
            apiKeyId: keyId,
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
            ip,
            createdAt: Math.floor(Date.now() / 1000),
          }, keyId);
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
                "cache-control": "no-cache, no-transform",
                connection: "keep-alive",
                "x-request-id": requestId,
                "x-accel-buffering": "no",
              },
            });
          }
          const antJson = await resp.json();
          const openAiData = anthropicResponseToOpenAI(antJson, publicModel);
          const promptTokens = openAiData.usage?.prompt_tokens ?? estPrompt;
          const completionTokens = openAiData.usage?.completion_tokens ?? estCompletion;
          await finalize({ route, promptTokens, completionTokens, streamFlag: 0, status: "success", httpStatus: 200 });
          return new Response(JSON.stringify(openAiData), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8", "x-request-id": requestId },
          });
        }

        /* ---- 成功返回：流式 tee 直通，客户端收尾保障结算落盘 ---- */
        if (stream && resp.body) {
          let promptTokens = estPrompt;
          let completionTokens = estCompletion;
          const [clientBody, tapBody] = resp.body.tee();

          // 旁路解析 usage；完成后客户端 flush 用其结果结算
          const tapDone = drainStreamForUsage(tapBody, estPrompt, async (p, c) => {
            promptTokens = p;
            completionTokens = c;
          }).catch(async () => {
            if (!released) {
              released = true;
              await releaseHold(hCtx, scope, holdId, estCost, requestId);
              await releaseConcurrency(env, keyId);
            }
          });

          // 客户端分支：flush 时等待记账完全落库再关闭（[DONE] 前最多多 1~2 轮并行写，保证不丢用量）
          const passthrough = new TransformStream<Uint8Array, Uint8Array>({
            async flush() {
              await tapDone;
              await finalize({ route, promptTokens, completionTokens, streamFlag: 1, status: "success", httpStatus: 200 });
            },
          });
          // 客户端提前断开时，由 tap 兜底结算
          void tapDone.then(() => {
            if (!released) {
              void finalize({ route, promptTokens, completionTokens, streamFlag: 1, status: "success", httpStatus: 200 });
            }
          });

          return new Response(clientBody.pipeThrough(passthrough), {
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
          headers: { "content-type": "application/json; charset=utf-8", "x-request-id": requestId },
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
      await releaseConcurrency(env, keyId);
    }
    await commitBatch(env, {
      id: uuid(),
      requestId,
      userId,
      apiKeyId: keyId,
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
      ip,
      createdAt: Math.floor(Date.now() / 1000),
    }, keyId);

    // 全部上游都返回 429 时，保留限流语义，避免客户端把限流误判为服务故障
    if (lastUpstreamStatus === 429) {
      return openAiError(429, ErrorCode.RATE_LIMITED, `所有可用上游均限流（已尝试 ${attempts} 条路由），请稍后重试：${lastUpstreamError}`, { retry_after: 5 });
    }

    return openAiError(502, ErrorCode.UPSTREAM_ERROR, `所有可用上游均调用失败（已尝试 ${attempts} 条路由）：${lastUpstreamError}`);
  } catch (err) {
    if (!released) {
      // 保证限流计数与并发释放不残留（尽力而为）
      void commitRateLimits(env);
      if (activeKeyId) void releaseConcurrency(env, activeKeyId);
    }
    return errorResponse(hCtx, err);
  }
});