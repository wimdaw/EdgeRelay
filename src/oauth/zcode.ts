/**
 * ZCode 反代（provider.type = 'zcode'）
 *
 * 上游：智谱 ZCode 桌面客户端的专属额度通道（zcode.z.ai），协议为 Anthropic Messages。
 * 关键约束（来自 angusdevgo/ZCode2api 的逆向结论，MIT）：
 *  1. 上游对请求体 system 做**内容指纹校验**，只接受客户端官方那三段原文；
 *     应用自己的 system 必须降级为 <pi_system_instructions> 塞进首条 user 消息。
 *  2. 必须带 x-device-mid / x-session-id，且按账号稳定派生（同一个号指纹不能漂移）。
 *  3. 签到 = 领取 zcode-plan 的每日/活动额度包（billing/claim），不是简单的打卡接口。
 *
 * 账号归属（国内/国际）是账号级的：邮箱 → 国际，手机号 → 国内，由授权后拉客户档案判定。
 */
import type { Env } from "../types";
import { getBlobStore } from "../storage/blob-store";
import { ZCODE_SYSTEM, ZCODE_DEFAULTS } from "./zcode-profile";
// 登录区域映射（纯函数，见 ./zcode-region；改这里等于改登录落点）
import {
  ZCODE_AUTHORIZE_HOST as AUTHORIZE_HOST,
  zcodeProviderFor,
  type ZcodeProvider,
} from "./zcode-region";

export { zcodeProviderFor };
export type { ZcodeProvider };

const ZCODE_BASE = "https://zcode.z.ai";
const ZAI_BASE = "https://api.z.ai";
const APP_VERSION = "3.16.3";

/**
 * 登录已经搬到 Z.ai 的 OAuth（2026-11-20 实测）：
 *  - 国际版 provider=zai     → https://chat.z.ai/api/oauth/authorize
 *  - 国内版 provider=zai_cn  → https://zchat.z.ai/api/oauth/authorize
 *  - 旧国内版 provider=bigmodel → https://bigmodel.cn/login（微信扫码已下线，仅存量兼容）
 */

const CHAT_PATH = "/api/v1/zcode-plan/anthropic/v1/messages";
const INIT_PATH = "/api/v1/oauth/cli/init";
const pollPath = (id: string) => `/api/v1/oauth/cli/poll/${encodeURIComponent(id)}`;
const BALANCE_PATH = `/api/v1/zcode-plan/billing/balance?app_version=${APP_VERSION}`;
const PREVIEW_PATH = `/api/v1/zcode-plan/billing/preview?app_version=${APP_VERSION}&platform=win32-x64`;
const CLAIM_PATH = "/api/v1/zcode-plan/billing/claim";
const FLOW_KEY = (id: string) => `zcode:flow:${id}`;

export const ZCODE_MODELS = ["GLM-5.3", "GLM-5.3-Flash"];
export const ZCODE_FALLBACK_MODELS = ZCODE_MODELS;

// =====================================================================
// 指纹派生（按账号稳定，不随请求漂移）
// =====================================================================

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** 派生成 UUIDv4 形状的稳定设备号 */
export async function deviceIdFor(uid: string): Promise<string> {
  const h = await sha256Hex(`machine:${uid || "anonymous"}`);
  const patched = `${h.slice(0, 12)}4${h.slice(13, 16)}a${h.slice(17)}`;
  return `${patched.slice(0, 8)}-${patched.slice(8, 12)}-${patched.slice(12, 16)}-${patched.slice(16, 20)}-${patched.slice(20, 32)}`;
}

export async function sessionIdFor(uid: string): Promise<string> {
  return `session_${(await sha256Hex(`session:${uid || "anonymous"}`)).slice(0, 32)}`;
}

function randomHex(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 从 JWT 里取 uid（不校验签名，仅用于派生指纹/展示） */
export function userIdFromJwt(jwt: string): string {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return "";
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return String(json?.user_id ?? json?.uid ?? "");
  } catch {
    return "";
  }
}

function metadataUserId(uid: string, deviceId: string, sessionId: string): string {
  return JSON.stringify({ device_id: deviceId, account_uuid: "", session_id: sessionId });
}

async function upstreamHeaders(rawCred: string, prefer: "access" | "jwt" = "access"): Promise<Record<string, string>> {
  const cred = parseZcodeCredential(rawCred);
  // 不同站点认的令牌不同：bigmodel 用 OAuth access_token，zcode.z.ai 用 CLI JWT
  const bearer = prefer === "jwt" ? cred.jwt || cred.accessToken : cred.accessToken || cred.jwt;
  const uid = userIdFromJwt(cred.jwt);
  const derivedDevice = await deviceIdFor(uid);
  const deviceId = cred.deviceId || derivedDevice;
  const sessionId = await sessionIdFor(uid);
  // 注意：http-referer 固定 zcode.z.ai，不要跟着登录域走。
  // 计费/领额度接口（billing/preview、billing/claim）就在 zcode.z.ai 上，
  // 现有账号一直是这个值且能正常领包，改动属于无依据的风险。
  return {
    ...(ZCODE_DEFAULTS.headers as unknown as Record<string, string>),
    authorization: `Bearer ${bearer}`,
    "x-api-key": bearer,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "mid-conversation-system-2026-04-07",
    "user-agent": `ZCode/${APP_VERSION} ai-sdk/provider-utils/4.0.27 runtime/node.js/24`,
    "http-referer": ZCODE_BASE,
    "x-zcode-app-version": APP_VERSION,
    "x-device-mid": deviceId,
    "x-session-id": sessionId,
    "x-query-id": crypto.randomUUID(),
    "x-request-id": randomHex(16),
    "x-zcode-trace-id": crypto.randomUUID(),
  };
}

/** 凭据格式：`jwt` / `jwt|access_token` / `jwt|access_token|device_id`（后续段保留兼容） */
export function parseZcodeCredential(raw: string): { jwt: string; accessToken: string; deviceId: string; extra: string[] } {
  const parts = (raw || "").split("|").map((x) => x.trim());
  return { jwt: parts[0] || "", accessToken: parts[1] || "", deviceId: parts[2] || "", extra: parts.slice(3) };
}

/**
 * OAuth access_token → 业务 access_token（对齐官方客户端 ZaiBusinessTokenResolver）：
 * POST api.z.ai/api/auth/z/login {"token"} → data.access_token + expires_in。
 * billing/额度体系挂在业务 token 身份上；授权时存的原始 OAuth token 未经这一步，
 * 直接拿去调 billing/对话会 401/3009，余额也显示为空。
 */
export async function fetchZaiBusinessToken(
  oauthAccessToken: string,
  timeoutMs = 15000
): Promise<{ ok: boolean; token?: string; expiresIn?: number; error?: string }> {
  const token = (oauthAccessToken || "").trim();
  if (!token) return { ok: false, error: "凭据中没有 OAuth access_token" };
  try {
    const res = await fetch("https://api.z.ai/api/auth/z/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j: any = await res.json().catch(() => null);
    const codeOk = j?.code == null || Number(j?.code) === 0 || Number(j?.code) === 200;
    const token2 = String(j?.data?.access_token || j?.data?.accessToken || "").trim();
    if (!res.ok || j?.success === false || !codeOk || !token2) {
      return { ok: false, error: `兑换失败 HTTP ${res.status}: ${String(j?.msg || "无 data.access_token").slice(0, 150)}` };
    }
    return { ok: true, token: token2, expiresIn: Number(j?.data?.expires_in) || undefined };
  } catch (e: any) {
    return { ok: false, error: e?.message || "业务 token 兑换异常" };
  }
}

/** 上游 Bearer：优先 OAuth access_token（体验/套餐额度挂在它上面），没有则回退 CLI JWT */
function bearerOf(cred: { jwt: string; accessToken: string }): string {
  return cred.accessToken || cred.jwt;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(message: string, status: number, type = "zcode_error"): Response {
  return jsonResponse({ error: { message, type } }, status);
}

// =====================================================================
// 设备授权
// =====================================================================

export type ZcodeFlow = { state: string; url: string; interval: number; expiresIn?: number; provider?: ZcodeProvider };

/** 发起设备授权：poll token 只保存在服务端，回调由 state(flow_id) 关联 */
export async function startZcodeDeviceFlow(env: Env, baseUrl?: string): Promise<ZcodeFlow> {
  const provider = zcodeProviderFor(baseUrl);
  const pollToken = randomHex(32);
  const res = await fetch(`${ZCODE_BASE}${INIT_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${pollToken}`, "content-type": "application/json" },
    body: JSON.stringify({ provider }),
    signal: AbortSignal.timeout(20000),
  });
  const j: any = await res.json().catch(() => null);
  if (!res.ok || j?.code !== 0) throw new Error(`ZCode 授权初始化失败：${j?.msg || `HTTP ${res.status}`}`);
  const { flow_id, authorize_url, poll_interval_sec, expires_at } = j.data || {};
  if (!flow_id || !authorize_url) throw new Error("ZCode 授权初始化返回缺少 flow_id / authorize_url");
  await getBlobStore(env).setJSON(FLOW_KEY(flow_id), { pollToken, provider, at: Date.now() });
  return {
    state: flow_id,
    url: authorize_url,
    interval: Number(poll_interval_sec) || 5,
    expiresIn: typeof expires_at === "number" ? Math.max(0, expires_at - Math.floor(Date.now() / 1000)) : undefined,
    provider,
  };
}

async function fetchCustomerInfo(accessToken: string): Promise<any | null> {
  try {
    const res = await fetch(`${ZAI_BASE}/api/biz/customer/getCustomerInfo`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

export type ZcodePollResult = {
  status: "pending" | "ok" | "error";
  message?: string;
  refreshToken?: string;
  email?: string;
  account?: { uid?: string; nickname?: string; realm?: "cn" | "intl" | "unknown" };
};

export async function pollZcodeDeviceFlow(env: Env, flowId: string): Promise<ZcodePollResult> {
  const store = getBlobStore(env);
  const flow = (await store.get(FLOW_KEY(flowId), { type: "json", consistency: "strong" })) as
    | { pollToken?: string; provider?: ZcodeProvider }
    | null;
  if (!flow?.pollToken) return { status: "error", message: "授权流程不存在或已过期，请重新发起" };

  const res = await fetch(`${ZCODE_BASE}${pollPath(flowId)}`, {
    headers: { authorization: `Bearer ${flow.pollToken}` },
    signal: AbortSignal.timeout(20000),
  });
  const j: any = await res.json().catch(() => null);
  if (!res.ok || j?.code !== 0) return { status: "error", message: j?.msg || `HTTP ${res.status}` };

  const st = j.data?.status;
  if (st !== "ready") return { status: "pending" };

  const jwt = String(j.data?.token || "");
  if (!jwt) return { status: "error", message: "上游未返回 token" };
  // zai / zai_cn 的 OAuth access_token 都挂在 data.zai 下；bigmodel 老流程字段名不同，
  // 这里按优先级兜底，避免某一路径取不到 access_token 导致余额为空。
  const accessToken = String(
    j.data?.zai?.access_token ||
      j.data?.zai?.accessToken ||
      j.data?.bigmodel?.access_token ||
      j.data?.access_token ||
      ""
  );
  const info = accessToken ? await fetchCustomerInfo(accessToken) : null;

  const email = String(info?.email || j.data?.user?.email || "").trim();
  const phone = String(info?.phoneNumber || "").trim();
  // 归属是账号级的：邮箱 → 国际，手机号 → 国内；
  // 但登录入口本身就是区域信号（zai_cn / bigmodel 一定是国内号），不要被 customerInfo 缺失带偏。
  const provider: ZcodeProvider = flow.provider || "zai";
  const inferred: "cn" | "intl" | "unknown" = email ? "intl" : phone ? "cn" : "unknown";
  const realm: "cn" | "intl" | "unknown" =
    provider === "zai_cn" || provider === "bigmodel" ? "cn" : inferred;
  const uid = userIdFromJwt(jwt);

  await store.delete(FLOW_KEY(flowId)).catch(() => {});
  return {
    status: "ok",
    // 同时保存 CLI JWT 与 OAuth access_token：体验额度（start plan）绑定的是后者，
    // 只用 JWT 会出现 balance 为空、请求 1005 的现象。
    // device_id 在授权时生成一次并随凭据保存：同一账号此后始终用同一台“设备”，
    // 避免每次请求派生不同指纹被上游判为异常（对应参考实现的 account.device_mid）
    refreshToken: [jwt, accessToken, crypto.randomUUID()].filter(Boolean).join("|"),
    // 账号池按 email 展示；只有手机号的国内号用手机号占位
    email: email || phone || undefined,
    account: { uid, nickname: String(info?.nickName || info?.customerName || "").trim() || undefined, realm },
  };
}

// =====================================================================
// 请求 / 响应
// =====================================================================

export type ZcodeCallParams = {
  env: Env;
  providerId: string;
  /** 渠道 baseUrl：bigmodel 站与国际站协议路径不同 */
  baseUrl?: string;
  modelId: string;
  requestedModel: string;
  body: Record<string, any>;
  refreshToken: string;
};

/** 官方 system 固定，应用 system 降级为首条 user 里的 <pi_system_instructions> 块 */
function demoteSystem(messages: any[], systemText: string): any[] {
  const out = JSON.parse(JSON.stringify(messages || []));
  if (!systemText.trim()) return out;
  const banner = `<pi_system_instructions>\n${systemText}\n</pi_system_instructions>`;
  const firstUser = out.find((m: any) => m?.role === "user");
  if (firstUser) {
    if (typeof firstUser.content === "string") firstUser.content = `${banner}\n\n${firstUser.content}`;
    else if (Array.isArray(firstUser.content)) firstUser.content.unshift({ type: "text", text: banner });
  } else {
    out.unshift({ role: "user", content: banner });
  }
  return out;
}

/**
 * OpenAI ChatCompletions → Anthropic Messages。
 * 与 ZCode2API 的 openaiToAnthropic 对齐：纯文本 + tool_calls 主流场景，
 * tool 角色合并成 tool_result，system 单独抽出后由 demoteSystem 降级。
 */
function openAIToAnthropicZcode(body: Record<string, any>): Record<string, any> {
  const msgs: any[] = [];
  let system = "";
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (m?.role === "system" || m?.role === "developer") {
      system += (typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c?.text ?? "").join("\n")) + "\n\n";
    } else if (m?.role === "user" || m?.role === "assistant") {
      const text =
        typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => (c?.type === "text" ? c.text : "")).join("");
      msgs.push({ role: m.role, content: text || " " });
    } else if (m?.role === "tool") {
      msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content ?? "") }] });
    }
  }
  if (!msgs.length) msgs.push({ role: "user", content: " " });

  const out: Record<string, any> = {
    model: body.model,
    max_tokens: body.max_tokens || body.max_completion_tokens || 8192,
    stream: false,
    messages: msgs,
  };
  if (system.trim()) out.system = system.trim();
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  return out;
}

/** Anthropic Messages → OpenAI ChatCompletion（对齐 ZCode2API 的 anthropicToOpenAI） */
function anthropicToOpenAIZcode(env: any, model: string): Record<string, any> {
  const blocks: any[] = Array.isArray(env?.content) ? env.content : [];
  const text = blocks.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
  const toolCalls = blocks
    .filter((b) => b?.type === "tool_use")
    .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const message: Record<string, any> = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const usage = env?.usage || {};
  const prompt = Number(usage.input_tokens) || 0;
  const completion = Number(usage.output_tokens) || 0;
  return {
    id: env?.id || `chatcmpl-${randomHex(8)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: env?.stop_reason === "tool_use" ? "tool_calls" : env?.stop_reason === "max_tokens" ? "length" : "stop",
      },
    ],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}

/** 非流式结果合成 SSE（OpenAI 客户端开 stream 时用，避免依赖上游 SSE 细节） */
function completionToSse(completion: Record<string, any>): Response {
  const enc = new TextEncoder();
  const base = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
  };
  const choice = completion.choices?.[0];
  const deltas = [
    { role: "assistant", content: choice?.message?.content ?? "" },
  ];
  const body =
    deltas
      .map((d) => `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: d, finish_reason: null }] })}\n\n`)
      .join("") +
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason ?? "stop" }] })}\n\n` +
    `data: ${JSON.stringify({ ...base, choices: [], usage: completion.usage })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(enc.encode(body), {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleZcodeRequest(p: ZcodeCallParams): Promise<Response> {
  if (!p.refreshToken) return errorResponse("该 zcode 渠道未配置凭据：请在「API Key」里填入 ZCode 账号的 JWT（可点「用 ZCode 账号授权」获取）", 400, "configuration_error");

  const inbound = openAIToAnthropicZcode({ ...p.body, model: p.modelId });
  // 注意：不要按 JWT 年龄做本地拦截——上游计费网关不按 iat 拒绝（实测 8 天旧 JWT 照常可用），
  // 只有上游真的回 401/3012 时才需要重新授权。误杀会把仍可用的号整个下线。
  const cred = parseZcodeCredential(p.refreshToken);
  const uid = userIdFromJwt(cred.jwt);
  const [deviceId, sessionId] = await Promise.all([deviceIdFor(uid), sessionIdFor(uid)]);

  // 与后台连通性测试（testZcode）保持同一套最小载荷：实测带 metadata / tool_choice 时
  // 上游会回 1005（exceed quota limit），不带则正常；先按能用的形态发。
  const upstreamBody: Record<string, any> = {
    model: p.modelId,
    max_tokens: Math.min(Number(inbound.max_tokens) || 8192, Number(ZCODE_DEFAULTS.max_tokens) || 32000),
    stream: false, // 上游固定非流式，流式由本层合成，避免 SSE 结构差异
    metadata: { user_id: metadataUserId(uid, cred.deviceId || (await deviceIdFor(uid)), await sessionIdFor(uid)) },
    system: ZCODE_SYSTEM,
    messages: demoteSystem(inbound.messages, String(inbound.system || "")),
    thinking: ZCODE_DEFAULTS.thinking ?? { type: "enabled" },
    output_config: ZCODE_DEFAULTS.output_config ?? { effort: "low" },
    ...(inbound.temperature !== undefined ? { temperature: inbound.temperature } : {}),
    ...(inbound.top_p !== undefined ? { top_p: inbound.top_p } : {}),
    ...(inbound.stop_sequences ? { stop_sequences: inbound.stop_sequences } : {}),
  };

  // 注意：上游对单账号并发上限很低（3009），本层**不要**叠加重试，
  // 否则一次客户端调用会连打多次上游，直接把账号打到限流。限流交给上层按 429 退避。
  const isBigmodel = /bigmodel\.cn/i.test(p.baseUrl || "");
  const chatUrl = isBigmodel
    ? `${(p.baseUrl || "").replace(/\/+$/, "")}/v1/messages`
    : `${ZCODE_BASE}${CHAT_PATH}`;
  const res = await fetch(chatUrl, {
    method: "POST",
    headers: await upstreamHeaders(p.refreshToken, isBigmodel ? "access" : "jwt"),
    body: JSON.stringify(upstreamBody),
    // EdgeOne 云函数硬限 120s：上游超时直接对齐平台上限，把可用生成窗口用满。
    // 到点后无论谁先终止，客户端都会看到连接结束并自行重试，不会无限挂起。
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await res.text().catch(() => "");
  let env: any = null;
  try {
    env = JSON.parse(raw);
  } catch {
    return errorResponse(`ZCode 上游返回非 JSON（HTTP ${res.status}）: ${raw.slice(0, 200)}`, 502, "upstream_error");
  }

  // 上游业务错误：顶层 code（ZCode 用 {code,msg,logid} 包）或 error.biz_code
  const rawCode = env?.error?.biz_code ?? env?.biz_code ?? env?.code;
  const biz = rawCode !== undefined && rawCode !== null && Number(rawCode) !== 0 ? Number(rawCode) : undefined;
  if (biz !== undefined) {
    const msg = String(env?.error?.message || env?.msg || "").slice(0, 300);
    // 诊断：把实际发出的请求摘要一并带出（不含凭据），便于和后台直测逐字段比对
    const sent = JSON.stringify({
      model: upstreamBody.model,
      max_tokens: upstreamBody.max_tokens,
      stream: upstreamBody.stream,
      msgs: Array.isArray(upstreamBody.messages) ? upstreamBody.messages.length : -1,
      keys: Object.keys(upstreamBody),
    });
    console.log(`[zcode] upstream ${biz} sent=${sent}`);
    if (biz === 3012) return errorResponse(`ZCode 风控拒绝（3012，system/设备指纹不匹配）: ${msg}`, 403, "upstream_error");
    const lower = msg.toLowerCase();
    if (/captcha|verification_required|security/.test(lower)) {
      return errorResponse(`ZCode 需要人机验证（${biz}）: ${msg}。请在 ZCode 客户端完成一次对话以刷新验证态后重试`, 403, "verification_required");
    }
    if (biz === 1005 || biz === 3009) return errorResponse(`ZCode 账号额度不足或繁忙（${biz}）: ${msg} | sent=${sent}`, 429, "upstream_error");
    return errorResponse(`ZCode 业务错误 ${biz}: ${msg} | sent=${sent}`, 402, "upstream_error");
  }

  if (!res.ok) return errorResponse(`ZCode 上游 HTTP ${res.status}: ${raw.slice(0, 300)}`, res.status, "upstream_error");
  if (!Array.isArray(env?.content)) {
    return errorResponse(`ZCode 上游返回异常结构: ${raw.slice(0, 400)}`, 502, "upstream_error");
  }

  const completion = anthropicToOpenAIZcode(env, p.requestedModel);
  if (p.body?.stream === true) return completionToSse(completion);
  return jsonResponse(completion);
}

// =====================================================================
// 连通性测试 / 模型
// =====================================================================

export async function testZcode(_env: Env, jwt: string, modelId: string, baseUrl?: string): Promise<{ success: boolean; message: string; statusCode?: number }> {
  try {
    const isBigmodel = /bigmodel\.cn/i.test(baseUrl || "");
    const url = isBigmodel ? `${(baseUrl || "").replace(/\/+$/, "")}/v1/messages` : `${ZCODE_BASE}${CHAT_PATH}`;
    const res = await fetch(url, {
      method: "POST",
      headers: await upstreamHeaders(jwt, isBigmodel ? "access" : "jwt"),
      body: JSON.stringify({
        model: modelId,
        max_tokens: 32,
        stream: false,
        system: ZCODE_SYSTEM,
        messages: [{ role: "user", content: "hi" }],
        thinking: ZCODE_DEFAULTS.thinking,
        output_config: ZCODE_DEFAULTS.output_config,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) return { success: false, message: `HTTP ${res.status}: ${text.slice(0, 200)}`, statusCode: res.status };
    // 上游错误也可能是 HTTP 200 + {code,msg}：必须校验响应体，否则会把额度耗尽误报成“连接成功”
    let j: any = null;
    try {
      j = JSON.parse(text);
    } catch {
      return { success: false, message: `返回非 JSON: ${text.slice(0, 150)}`, statusCode: res.status };
    }
    const biz = Number(j?.error?.biz_code ?? j?.biz_code ?? j?.code) || 0;
    if (biz !== 0) return { success: false, message: `业务错误 ${biz}: ${j?.msg || j?.error?.message || ""}`, statusCode: res.status };
    if (!Array.isArray(j?.content)) return { success: false, message: `返回结构异常: ${text.slice(0, 150)}`, statusCode: res.status };
    return { success: true, message: "连接成功", statusCode: res.status };
  } catch (e) {
    return { success: false, message: (e as Error).message || "请求失败" };
  }
}

export async function fetchZcodeModels(_env: Env, _jwt: string): Promise<{ success: boolean; models: string[]; message?: string }> {
  // 上游没有公开模型目录接口，用客户端固定清单
  return { success: true, models: ZCODE_MODELS };
}

// =====================================================================
// 余额（billing 平面认 CLI JWT 身份：balances[] 是真实额度，preview.plans[] 是可领包）
// =====================================================================

export type ZcodeBalanceEntry = {
  showName: string;
  remaining: number;
  total: number;
  used: number;
  unitType?: string;
  expiresAt?: number;
};

export type ZcodeBalanceInfo = {
  ok: boolean;
  error?: string;
  balances: ZcodeBalanceEntry[];
  claimable: Array<{ planId: string; name: string }>;
};

/** 查询账号额度：billing/balance + billing/preview，都带 CLI JWT（对齐 zcode-api 的 quota 口径） */
export async function fetchZcodeBalance(_env: Env, jwt: string): Promise<ZcodeBalanceInfo> {
  const cred = parseZcodeCredential(jwt);
  if (!cred.jwt) return { ok: false, error: "凭据中没有 CLI JWT", balances: [], claimable: [] };
  const headers = await upstreamHeaders(jwt, "jwt");
  const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
  try {
    const [bRes, pRes] = await Promise.all([
      fetch(`${ZCODE_BASE}${BALANCE_PATH}`, { headers, signal: AbortSignal.timeout(15000) }),
      fetch(`${ZCODE_BASE}${PREVIEW_PATH}`, { headers, signal: AbortSignal.timeout(15000) }),
    ]);
    const bj: any = await bRes.json().catch(() => null);
    const pj: any = await pRes.json().catch(() => null);
    if (Number(bj?.code) !== 0) {
      return { ok: false, error: `余额查询失败: ${String(bj?.msg || `HTTP ${bRes.status}`).slice(0, 120)}`, balances: [], claimable: [] };
    }
    const balances: ZcodeBalanceEntry[] = (Array.isArray(bj?.data?.balances) ? bj.data.balances : []).map((b: any) => ({
      showName: String(b?.show_name ?? b?.plan_id ?? "额度"),
      remaining: num(b?.remaining_units ?? b?.remainingUnits),
      total: num(b?.total_units ?? b?.totalUnits),
      used: num(b?.used_units ?? b?.usedUnits),
      ...(b?.unit_type || b?.unitType ? { unitType: String(b.unit_type ?? b.unitType) } : {}),
      ...(num(b?.ends_at ?? b?.expires_at ?? b?.expiresAt) > 0 ? { expiresAt: num(b.ends_at ?? b.expires_at ?? b.expiresAt) } : {}),
    }));
    const claimable = (Array.isArray(pj?.data?.plans) ? pj.data.plans : [])
      .map((p: any) => ({ planId: String(p?.plan_id ?? ""), name: String(p?.name ?? p?.plan_id ?? "") }))
      .filter((p) => p.planId);
    return { ok: true, balances, claimable };
  } catch (e: any) {
    return { ok: false, error: e?.message || "余额查询异常", balances: [], claimable: [] };
  }
}

// =====================================================================
// 诊断：原样返回余额与可领套餐（排查"体验额度没找对套餐"）
// =====================================================================

export async function probeZcode(
  env: Env,
  jwt: string,
  baseUrl?: string
): Promise<{
  claims: Record<string, unknown>;
  login: { provider: ZcodeProvider; authorizeHost: string; note: string };
  matrix: Array<{ host: string; token: string; status: number; body: string }>;
  business: {
    exchange: { ok: boolean; expiresIn?: number | null; tokenPrefix?: string; error?: string };
    balance: { status: number; body: string };
    chat: { status: number; body: string };
  };
  balance: { status: number; body: string };
  preview: { status: number; body: string };
}> {
  const loginProvider = zcodeProviderFor(baseUrl);
  const login = {
    provider: loginProvider,
    authorizeHost: AUTHORIZE_HOST[loginProvider],
    note:
      loginProvider === "bigmodel"
        ? "旧国内入口（bigmodel.cn/login）：微信扫码已下线，建议改用 zchat.z.ai 重新授权"
        : loginProvider === "zai_cn"
        ? "国内版：zchat.z.ai OAuth（手机号登录）"
        : "国际版：chat.z.ai OAuth（邮箱登录）",
  };
  const headers = await upstreamHeaders(jwt, /bigmodel\.cn/i.test(baseUrl || "") ? "access" : "jwt");
  const get = async (url: string, bearer?: string) => {
    const h = bearer ? { ...headers, authorization: `Bearer ${bearer}`, "x-api-key": bearer } : headers;
    const r = await fetch(url, { headers: h, signal: AbortSignal.timeout(20000) });
    const t = await r.text().catch(() => "");
    return { status: r.status, body: t.slice(0, 2000) };
  };
  // JWT 明文声明（不校验签名，仅用于确认凭据属于哪个账号/是否过期）
  let claims: Record<string, unknown> = {};
  try {
    const payload = jwt.split(".")[1] || "";
    claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    const exp = Number(claims.exp) || 0;
    claims = {
      user_id: claims.user_id ?? claims.uid ?? null,
      exp: exp ? new Date(exp * 1000).toISOString() : null,
      expired: exp ? exp * 1000 < Date.now() : null,
      keys: Object.keys(claims).slice(0, 12),
    };
  } catch {
    claims = { error: "jwt 解析失败" };
  }
  // 矩阵：两个站点 × 两种令牌，直接看哪一组能过（返回状态码 + 响应片段）
  const cred = parseZcodeCredential(jwt);
  const baseHeaders = await upstreamHeaders(jwt, "jwt");
  const hosts = [
    { name: "zai", url: `${ZCODE_BASE}${CHAT_PATH}` },
    { name: "bigmodel", url: "https://open.bigmodel.cn/api/anthropic/v1/messages" },
  ];
  const tokens = [
    { name: "jwt", value: cred.jwt },
    { name: "access", value: cred.accessToken },
  ];
  const matrix: Array<{ host: string; token: string; status: number; body: string }> = [];
  for (const h of hosts) {
    for (const t of tokens) {
      if (!t.value) {
        matrix.push({ host: h.name, token: t.name, status: 0, body: "令牌缺失" });
        continue;
      }
      try {
        const r = await fetch(h.url, {
          method: "POST",
          headers: { ...baseHeaders, authorization: `Bearer ${t.value}`, "x-api-key": t.value },
          body: JSON.stringify({
            model: "GLM-5.3",
            max_tokens: 16,
            stream: false,
            system: ZCODE_SYSTEM,
            messages: [{ role: "user", content: "hi" }],
            thinking: ZCODE_DEFAULTS.thinking,
            output_config: ZCODE_DEFAULTS.output_config,
          }),
          signal: AbortSignal.timeout(30000),
        });
        const text = await r.text().catch(() => "");
        matrix.push({ host: h.name, token: t.name, status: r.status, body: text.slice(0, 200) });
      } catch (e) {
        matrix.push({ host: h.name, token: t.name, status: 0, body: (e as Error).message });
      }
    }
  }

  // 业务 token 诊断：官方客户端会先把 OAuth access_token 兑换成业务 token（api.z.ai/api/auth/z/login），
  // billing/套餐挂在业务身份上。这里验证：能否兑换 → 业务 token 查余额 → 业务 token 发起对话。
  const biz = await fetchZaiBusinessToken(cred.accessToken);
  const bizBalance = biz.ok
    ? await get(`${ZCODE_BASE}${BALANCE_PATH}`, biz.token!)
    : { status: 0, body: biz.error || "" };
  let bizChat = { status: 0, body: biz.error || "" };
  if (biz.ok) {
    try {
      const r = await fetch(`${ZCODE_BASE}${CHAT_PATH}`, {
        method: "POST",
        headers: { ...baseHeaders, authorization: `Bearer ${biz.token!}`, "x-api-key": biz.token! },
        body: JSON.stringify({
          model: "GLM-5.3",
          max_tokens: 16,
          stream: false,
          system: ZCODE_SYSTEM,
          messages: [{ role: "user", content: "hi" }],
          thinking: ZCODE_DEFAULTS.thinking,
          output_config: ZCODE_DEFAULTS.output_config,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await r.text().catch(() => "");
      bizChat = { status: r.status, body: text.slice(0, 300) };
    } catch (e: any) {
      bizChat = { status: 0, body: e?.message || "业务 token 对话异常" };
    }
  }

  return {
    claims,
    login,
    matrix,
    business: {
      exchange: biz.ok
        ? { ok: true, expiresIn: biz.expiresIn ?? null, tokenPrefix: `${biz.token!.slice(0, 10)}…` }
        : { ok: false, error: biz.error },
      balance: bizBalance,
      chat: bizChat,
    },
    balance: await get(`${ZCODE_BASE}${BALANCE_PATH}`),
    preview: await get(`${ZCODE_BASE}${PREVIEW_PATH}`),
  };
}

// =====================================================================
// 签到（领取额度包）
// =====================================================================

export type ZcodeCheckinResult = {
  ok: boolean;
  already?: boolean;
  reward?: number;
  remain?: number;
  message?: string;
};

/**
 * 签到 = 领取当前可领的额度包。
 *
 * 枚举两路合并（对齐 zcode-api 的 listPlans）：wk-1030（2026-10-30）起周末包改走
 * marketing banner 下发，plan_id 不再是日期编码——纯猜 id 会整个漏掉，所以：
 *  1. billing/preview：billing 面登记的包（Bearer JWT + X-Device-Mid，缺 UUID 回 3001）
 *  2. marketing/touch：banner/popup 按钮 action=claim_zcode_plan 携带 plan_id，
 *     投递体里的 zcode_plan 对象补充名称/时间窗
 * 领取 POST 头对齐官方客户端 claimManualPlan：Authorization/Content-Type/
 * X-ZCode-App-Version/X-Platform/X-Device-Mid。人机验证：3.16.3 的 captcha 门是关的，
 * 这里不带头；若网关侧开启，失败信息会透出到消息里。
 */
export async function checkinZcode(env: Env, jwt: string): Promise<ZcodeCheckinResult> {
  if (!jwt) return { ok: false, message: "未填写凭据" };
  // billing/preview、billing/claim 都认 CLI JWT。不能用默认 prefer "access"——
  // OAuth access_token 短时效，过期后领包会静默全部失败。
  const cred = parseZcodeCredential(jwt);
  const uid = userIdFromJwt(cred.jwt);
  const deviceMid = cred.deviceId || (await deviceIdFor(uid));
  try {
    // --- 枚举：preview + marketing banner 合并 ---
    const candidates = new Map<string, string>(); // planId -> 展示名

    try {
      const pvRes = await fetch(`${ZCODE_BASE}${PREVIEW_PATH}`, {
        headers: { authorization: `Bearer ${cred.jwt}`, "x-device-mid": deviceMid },
        signal: AbortSignal.timeout(20000),
      });
      const pv: any = await pvRes.json().catch(() => null);
      for (const x of (pv?.data?.plans ?? []) as any[]) {
        const id = String(x?.plan_id || "").trim();
        if (id) candidates.set(id, String(x?.name || id));
      }
    } catch {
      /* preview 失败不阻塞 banner 枚举 */
    }

    // banner 投递体里深度受限地收集 zcode_plan 对象（用于富化名称）
    const collectPlans = (node: unknown, out: any[], depth = 0): void => {
      if (depth > 4 || node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const x of node) collectPlans(x, out, depth + 1);
        return;
      }
      const rec = node as Record<string, unknown>;
      const zp = rec.zcode_plan;
      if (zp && typeof zp === "object" && !Array.isArray(zp)) out.push(zp);
      for (const v of Object.values(rec)) collectPlans(v, out, depth + 1);
    };
    try {
      const mRes = await fetch(`${ZCODE_BASE}/api/v1/marketing/touch?seq=0`, {
        headers: {
          "x-device-mid": deviceMid,
          "x-client-language": "zh-CN",
          "x-zcode-app-version": APP_VERSION,
          authorization: `Bearer ${cred.jwt}`,
        },
        signal: AbortSignal.timeout(20000),
      });
      const m: any = await mRes.json().catch(() => null);
      const deliveries: any[] = (m?.data?.deliveries ?? []) as any[];
      for (const d of deliveries) {
        if (!d || typeof d !== "object") continue;
        const rich: any[] = [];
        collectPlans(d, rich);
        const richById = new Map(rich.map((p) => [String(p?.plan_id ?? ""), p]));
        for (const host of [d.banner, d.popup]) {
          for (const btn of (host?.buttons ?? []) as any[]) {
            if (btn?.action?.type !== "claim_zcode_plan") continue;
            const id = String(btn?.action?.args?.plan_id ?? "").trim();
            if (!id || candidates.has(id)) continue;
            const rp = richById.get(id);
            candidates.set(id, String(rp?.name || id));
          }
        }
      }
    } catch {
      /* banner 失败不阻塞 */
    }

    // 兜底：老日期编码包仍试一下（早期活动形态，preview/banner 都没有时还能捡漏）
    const bjTime = Date.now() + 8 * 3600_000;
    const stamps = [0, -1, 1].map((delta) => {
      const d = new Date(bjTime + delta * 86400_000);
      return `${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    });
    for (const s of stamps) if (!candidates.has(`zcode-v3-start-plan-${s}-wk`)) candidates.set(`zcode-v3-start-plan-${s}-wk`, `周末包 ${s}`);
    if (!candidates.has("zcode-v3-start-plan-0817")) candidates.set("zcode-v3-start-plan-0817", "每日体验包");

    // --- 领取（对齐官方 claimManualPlan 头）---
    const claimHeaders: Record<string, string> = {
      authorization: `Bearer ${cred.jwt}`,
      "content-type": "application/json",
      "x-zcode-app-version": APP_VERSION,
      "x-platform": "win32-x64",
      "x-device-mid": deviceMid,
    };

    let claimed = 0;
    let dup = 0;
    let authFail = 0;
    let lastMsg = "";
    let firstFail = "";
    const claimedNames: string[] = [];
    for (const [planId, name] of candidates) {
      const r = await fetch(`${ZCODE_BASE}${CLAIM_PATH}`, {
        method: "POST",
        headers: claimHeaders,
        body: JSON.stringify({ plan_id: planId }),
        signal: AbortSignal.timeout(15000),
      });
      const j: any = await r.json().catch(() => null);
      lastMsg = String(j?.data?.message || j?.msg || "");
      if (Number(j?.code) === 0) {
        claimed++;
        claimedNames.push(name);
      } else if (Number(j?.code) === 1003) {
        dup++;
      } else {
        if (!r.ok || Number(j?.code) === 1001 || r.status === 401) authFail++;
        if (!firstFail) {
          firstFail = `${planId} HTTP ${r.status} code=${j?.code ?? "?"} msg=${lastMsg.slice(0, 80) || "(空)"}`;
        }
      }
    }

    // 回读余额（展示用）
    let remain: number | undefined;
    try {
      const bRes = await fetch(`${ZCODE_BASE}${BALANCE_PATH}`, {
        headers: { authorization: `Bearer ${cred.jwt}`, "x-device-mid": deviceMid },
        signal: AbortSignal.timeout(15000),
      });
      const bj: any = await bRes.json().catch(() => null);
      const units = (bj?.data?.balances ?? bj?.data?.plans ?? []).map((x: any) => Number(x?.remaining_units) || 0);
      if (units.length) remain = units.reduce((a: number, b: number) => a + b, 0);
    } catch {
      /* 展示用，失败忽略 */
    }

    const listed = candidates.size;
    if (claimed > 0) return { ok: true, reward: claimed, remain, message: `领取 ${claimed} 个额度包（${claimedNames.join("、")}）` };
    if (dup > 0) return { ok: true, already: true, remain, message: lastMsg || `今日额度已领取（枚举 ${listed} 个候选）` };
    const diag = `枚举 ${listed} 个候选（preview+banner）${firstFail ? `；首个失败: ${firstFail}` : ""}`;
    if (authFail > 0) {
      return { ok: false, remain, message: `领包请求被上游鉴权拒绝（JWT 失效或风控）。${diag}` };
    }
    return {
      ok: false,
      remain,
      message: lastMsg || (listed > 0 ? `候选包均不可领（已领完/未开始/资格不符）。${diag}` : "当前没有可领取的额度包"),
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message || "签到失败" };
  }
}
