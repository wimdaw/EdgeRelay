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

const ZCODE_BASE = "https://zcode.z.ai";
const ZAI_BASE = "https://api.z.ai";
const APP_VERSION = "3.16.3";
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

async function upstreamHeaders(jwt: string): Promise<Record<string, string>> {
  const uid = userIdFromJwt(jwt);
  const [deviceId, sessionId] = await Promise.all([deviceIdFor(uid), sessionIdFor(uid)]);
  return {
    ...(ZCODE_DEFAULTS.headers as unknown as Record<string, string>),
    authorization: `Bearer ${jwt}`,
    "x-api-key": jwt,
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

export type ZcodeFlow = { state: string; url: string; interval: number; expiresIn?: number };

/** 发起设备授权：poll token 只保存在服务端，回调由 state(flow_id) 关联 */
export async function startZcodeDeviceFlow(env: Env): Promise<ZcodeFlow> {
  const pollToken = randomHex(32);
  const res = await fetch(`${ZCODE_BASE}${INIT_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${pollToken}`, "content-type": "application/json" },
    body: JSON.stringify({ provider: "zai" }),
    signal: AbortSignal.timeout(20000),
  });
  const j: any = await res.json().catch(() => null);
  if (!res.ok || j?.code !== 0) throw new Error(`ZCode 授权初始化失败：${j?.msg || `HTTP ${res.status}`}`);
  const { flow_id, authorize_url, poll_interval_sec, expires_at } = j.data || {};
  if (!flow_id || !authorize_url) throw new Error("ZCode 授权初始化返回缺少 flow_id / authorize_url");
  await getBlobStore(env).setJSON(FLOW_KEY(flow_id), { pollToken, at: Date.now() });
  return {
    state: flow_id,
    url: authorize_url,
    interval: Number(poll_interval_sec) || 5,
    expiresIn: typeof expires_at === "number" ? Math.max(0, expires_at - Math.floor(Date.now() / 1000)) : undefined,
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
  const flow = (await store.get(FLOW_KEY(flowId), { type: "json", consistency: "strong" })) as { pollToken?: string } | null;
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
  const accessToken = String(j.data?.zai?.access_token || j.data?.zai?.accessToken || "");
  const info = accessToken ? await fetchCustomerInfo(accessToken) : null;

  const email = String(info?.email || j.data?.user?.email || "").trim();
  const phone = String(info?.phoneNumber || "").trim();
  // 归属是账号级的：邮箱 → 国际，手机号 → 国内
  const realm: "cn" | "intl" | "unknown" = email ? "intl" : phone ? "cn" : "unknown";
  const uid = userIdFromJwt(jwt);

  await store.delete(FLOW_KEY(flowId)).catch(() => {});
  return {
    status: "ok",
    refreshToken: jwt,
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
  const uid = userIdFromJwt(p.refreshToken);
  const [deviceId, sessionId] = await Promise.all([deviceIdFor(uid), sessionIdFor(uid)]);

  const upstreamBody: Record<string, any> = {
    model: p.modelId,
    max_tokens: Math.min(Number(inbound.max_tokens) || 8192, Number(ZCODE_DEFAULTS.max_tokens) || 32000),
    stream: false, // 上游固定非流式，流式由本层合成，避免 SSE 结构差异
    metadata: { user_id: metadataUserId(uid, deviceId, sessionId) },
    system: ZCODE_SYSTEM,
    messages: demoteSystem(inbound.messages, String(inbound.system || "")),
    tool_choice: ZCODE_DEFAULTS.tool_choice ?? { type: "auto" },
    thinking: ZCODE_DEFAULTS.thinking ?? { type: "enabled" },
    output_config: ZCODE_DEFAULTS.output_config ?? { effort: "low" },
    ...(inbound.temperature !== undefined ? { temperature: inbound.temperature } : {}),
    ...(inbound.top_p !== undefined ? { top_p: inbound.top_p } : {}),
    ...(inbound.stop_sequences ? { stop_sequences: inbound.stop_sequences } : {}),
  };

  // 上游对单账号有并发/频控（3009 / 1005），既可能是 HTTP 429，也可能是 200 + code。
  // 统一在这里做短退避重试，避免把「等一下就好」误判成渠道故障。
  let res!: Response;
  let raw = "";
  let env: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(`${ZCODE_BASE}${CHAT_PATH}`, {
      method: "POST",
      headers: await upstreamHeaders(p.refreshToken),
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(300000),
    });
    raw = await res.text().catch(() => "");
    try {
      env = JSON.parse(raw);
    } catch {
      return errorResponse(`ZCode 上游返回非 JSON（HTTP ${res.status}）: ${raw.slice(0, 200)}`, 502, "upstream_error");
    }
    const c = Number(env?.error?.biz_code ?? env?.biz_code ?? env?.code) || 0;
    const connBusy = c === 1005 || c === 3009;
    if (res.ok && !connBusy) break;
    if (!connBusy) break;
    if (attempt < 2) await new Promise((ok) => setTimeout(ok, 800 * (attempt + 1)));
  }

  // 上游业务错误：顶层 code（ZCode 用 {code,msg,logid} 包）或 error.biz_code
  const rawCode = env?.error?.biz_code ?? env?.biz_code ?? env?.code;
  const biz = rawCode !== undefined && rawCode !== null && Number(rawCode) !== 0 ? Number(rawCode) : undefined;
  if (biz !== undefined) {
    const msg = String(env?.error?.message || env?.msg || "").slice(0, 300);
    if (biz === 3012) return errorResponse(`ZCode 风控拒绝（3012，system/设备指纹不匹配）: ${msg}`, 403, "upstream_error");
    if (biz === 1005 || biz === 3009) return errorResponse(`ZCode 账号额度不足或繁忙（${biz}）: ${msg}`, 429, "upstream_error");
    return errorResponse(`ZCode 业务错误 ${biz}: ${msg}`, 402, "upstream_error");
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

export async function testZcode(_env: Env, jwt: string, modelId: string): Promise<{ success: boolean; message: string; statusCode?: number }> {
  try {
    const res = await fetch(`${ZCODE_BASE}${CHAT_PATH}`, {
      method: "POST",
      headers: await upstreamHeaders(jwt),
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
    if (!res.ok) {
      const t = (await res.text().catch(() => "")).slice(0, 200);
      return { success: false, message: `HTTP ${res.status}: ${t}`, statusCode: res.status };
    }
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
 * preview 只覆盖「当前正在发放」的包；新号的注册礼包/周活动包要靠 id 推算兜底
 * （对齐 ZCode2API 的 claimFor）：活动包 id 带日期编码 `zcode-v3-start-plan-<MMDD>-wk`，
 * 北京时间 0 点跳日，所以候选要跨 ±1 天；每日体验包是固定 id `-0817`，领过即 1003。
 */
export async function checkinZcode(env: Env, jwt: string): Promise<ZcodeCheckinResult> {
  if (!jwt) return { ok: false, message: "未填写凭据" };
  const headers = await upstreamHeaders(jwt);
  try {
    // 当前生效的包类型，避免重复领同一类
    const activeKinds = new Set<string>();
    let remain: number | undefined;
    try {
      const bRes = await fetch(`${ZCODE_BASE}${BALANCE_PATH}`, { headers, signal: AbortSignal.timeout(15000) });
      const bj: any = await bRes.json().catch(() => null);
      const now = Date.now() / 1000;
      const plans: any[] = (bj?.data?.plans ?? []).filter((p: any) => p?.status === "active" && (p?.ends_at ?? 0) > now);
      for (const p of plans) {
        const s = `${p?.plan_id ?? ""} ${p?.name ?? ""}`.toUpperCase();
        if (s.includes("WEEKEND") || /(^|[-_ ])WK($|[-_ ])/.test(s)) activeKinds.add("promo");
        if (s.includes("START-PLAN") || s.includes("START PLAN")) activeKinds.add("daily");
      }
      const units = (bj?.data?.plans ?? []).map((x: any) => Number(x?.remaining_units) || 0);
      if (units.length) remain = units.reduce((a: number, b: number) => a + b, 0);
    } catch {
      /* 余额读取失败不阻塞领取 */
    }

    const candidates: string[] = [];
    try {
      const pvRes = await fetch(`${ZCODE_BASE}${PREVIEW_PATH}`, { headers, signal: AbortSignal.timeout(20000) });
      const pv: any = await pvRes.json().catch(() => null);
      for (const x of pv?.data?.plans ?? []) {
        const id = String(x?.plan_id || "");
        if (id) candidates.push(id);
      }
    } catch {
      /* preview 失败仍可用兜底 id */
    }

    const bj = Date.now() + 8 * 3600_000;
    const stamps = [0, -1, 1].map((delta) => {
      const d = new Date(bj + delta * 86400_000);
      return `${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    });
    if (!activeKinds.has("promo")) for (const s of stamps) candidates.push(`zcode-v3-start-plan-${s}-wk`);
    if (!activeKinds.has("daily")) candidates.push("zcode-v3-start-plan-0817");

    let claimed = 0;
    let dup = 0;
    let lastMsg = "";
    const seen = new Set<string>();
    for (const planId of candidates) {
      if (seen.has(planId)) continue;
      seen.add(planId);
      const r = await fetch(`${ZCODE_BASE}${CLAIM_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ plan_id: planId }),
        signal: AbortSignal.timeout(15000),
      });
      const j: any = await r.json().catch(() => null);
      lastMsg = String(j?.data?.message || j?.msg || "");
      if (Number(j?.code) === 0) claimed++;
      else if (Number(j?.code) === 1003) dup++;
    }

    if (claimed > 0) return { ok: true, reward: claimed, remain, message: `领取 ${claimed} 个额度包` };
    if (dup > 0) return { ok: true, already: true, remain, message: lastMsg || "今日额度已领取" };
    return { ok: false, remain, message: lastMsg || (candidates.length ? "无可领取额度" : "当前没有可领取的额度包") };
  } catch (e) {
    return { ok: false, message: (e as Error).message || "签到失败" };
  }
}
