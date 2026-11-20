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
import {
  openAIToAnthropicRequest,
  anthropicResponseToOpenAI,
  createOpenAIStreamFromAnthropic,
} from "../anthropic-translate";
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

export async function handleZcodeRequest(p: ZcodeCallParams): Promise<Response> {
  if (!p.refreshToken) return errorResponse("该 zcode 渠道未配置凭据：请在「API Key」里填入 ZCode 账号的 JWT（可点「用 ZCode 账号授权」获取）", 400, "configuration_error");

  const { request } = openAIToAnthropicRequest(p.body);
  const systemText =
    typeof request.system === "string"
      ? request.system
      : Array.isArray(request.system)
      ? request.system.map((b: any) => b?.text || "").filter(Boolean).join("\n\n")
      : "";

  const uid = userIdFromJwt(p.refreshToken);
  const [deviceId, sessionId] = await Promise.all([deviceIdFor(uid), sessionIdFor(uid)]);
  const wantStream = p.body?.stream === true;

  const upstreamBody: Record<string, any> = {
    model: p.modelId,
    max_tokens: Math.min(Number(request.max_tokens) || Number(ZCODE_DEFAULTS.max_tokens) || 32000, Number(ZCODE_DEFAULTS.max_tokens) || 32000),
    stream: wantStream,
    metadata: { user_id: metadataUserId(uid, deviceId, sessionId) },
    system: ZCODE_SYSTEM,
    messages: demoteSystem(request.messages, systemText),
    tool_choice: ZCODE_DEFAULTS.tool_choice ?? { type: "auto" },
    thinking: ZCODE_DEFAULTS.thinking ?? { type: "enabled" },
    output_config: ZCODE_DEFAULTS.output_config ?? { effort: "low" },
    ...(Array.isArray(request.tools) && request.tools.length ? { tools: request.tools } : {}),
  };

  const res = await fetch(`${ZCODE_BASE}${CHAT_PATH}`, {
    method: "POST",
    headers: await upstreamHeaders(p.refreshToken),
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(300000),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    return errorResponse(`ZCode 上游 HTTP ${res.status}: ${detail}`, res.status, "upstream_error");
  }

  if (wantStream && res.body) {
    return new Response(createOpenAIStreamFromAnthropic(res.body, p.requestedModel), {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const body = await res.json().catch(() => null);
  if (!body) return errorResponse("ZCode 上游返回非 JSON", 502, "upstream_error");
  return jsonResponse(anthropicResponseToOpenAI(body, p.requestedModel));
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
 * 签到 = 领取当前可领的额度包：
 *  preview 给出可领 plan_id → 逐个 claim；1003 表示已领过。
 */
export async function checkinZcode(env: Env, jwt: string): Promise<ZcodeCheckinResult> {
  if (!jwt) return { ok: false, message: "未填写凭据" };
  const headers = await upstreamHeaders(jwt);
  try {
    const pvRes = await fetch(`${ZCODE_BASE}${PREVIEW_PATH}`, { headers, signal: AbortSignal.timeout(20000) });
    const pv: any = await pvRes.json().catch(() => null);
    const plans: string[] = (pv?.data?.plans ?? []).map((x: any) => String(x?.plan_id || "")).filter(Boolean);

    let claimed = 0;
    let dup = 0;
    let lastMsg = "";
    for (const planId of plans) {
      const r = await fetch(`${ZCODE_BASE}${CLAIM_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ plan_id: planId }),
        signal: AbortSignal.timeout(15000),
      });
      const j: any = await r.json().catch(() => null);
      const code = Number(j?.code);
      lastMsg = String(j?.data?.message || j?.msg || "");
      if (code === 0) claimed++;
      else if (code === 1003) dup++;
    }

    // 顺带回读余额，便于账号池展示
    let remain: number | undefined;
    try {
      const bRes = await fetch(`${ZCODE_BASE}${BALANCE_PATH}`, { headers, signal: AbortSignal.timeout(15000) });
      const bj: any = await bRes.json().catch(() => null);
      const units = (bj?.data?.plans ?? []).map((x: any) => Number(x?.remaining_units) || 0);
      if (units.length) remain = units.reduce((a: number, b: number) => a + b, 0);
    } catch {
      /* 余额失败不影响签到结论 */
    }

    if (claimed > 0) return { ok: true, reward: claimed, remain, message: `领取 ${claimed} 个额度包` };
    if (dup > 0) return { ok: true, already: true, remain, message: lastMsg || "今日额度已领取" };
    return { ok: false, remain, message: plans.length ? lastMsg || "无可领取额度" : "当前没有可领取的额度包" };
  } catch (e) {
    return { ok: false, message: (e as Error).message || "签到失败" };
  }
}
