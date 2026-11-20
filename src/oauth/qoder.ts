/**
 * Qoder 反代（provider.type = 'qoder'）
 *
 * 上游：Qoder 客户端的 agent_chat_generation 通道（国内 qoder.com.cn /
 * 国际 qoder.com），协议是 OpenAI 兼容 SSE，但请求必须走 COSY 签名。
 *
 * 参考实现：
 *  - shuishuipingan/qoder2api-hub（Python，签到与 COSY 细节）
 *  - Zhengyuuuui/qoder2api（Go，OAuth 设备授权与请求体模板）
 *
 * 关键约束：
 *  1. 设备授权是 PKCE + 浏览器登录 + /deviceToken/poll 轮询；国内/国际的
 *     client_id、redirect_uri、nonce 形态不同。
 *  2. 请求体必须带 request_id / session_id / chat_context / model_config /
 *     business 等字段，且请求体要用 qoderEncode 编码后参与签名。
 *  3. 对话与签到共用同一套按账号稳定派生的设备指纹；签到走 OpenAPI 的
 *     campaigns 活动接口（每日 100 Credits）。
 */
import type { Env } from "../types";
import { getBlobStore } from "../storage/blob-store";
import { randomHex } from "./common";
import {
  COSY_VERSION,
  blankResponseMeta,
  cosyHeaders,
  createCosySession,
  deriveMachineHostname,
  deriveMachineId,
  deriveMachineToken,
  deriveMachineType,
  qoderEncode,
  type CosySession,
} from "./qoder-cosy";

// =====================================================================
// 常量与区域
// =====================================================================

export type QoderRegion = "cn" | "global";

const CLIENT_ID_CN = "1c5e33e1-364d-4ce6-b02c-acaa81274a5c";
const CLIENT_ID_GLOBAL = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";
const REDIRECT_CN = "qoder-work-cn://";
const FLOW_KEY = (state: string) => `qoder:flow:${state}`;
const FLOW_TTL = 10 * 60 * 1000;

const CHAT_PATH =
  "/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";

const ENDPOINTS: Record<
  QoderRegion,
  {
    website: string;
    openapi: string;
    userAgent: string;
    chatUrl: string;
  }
> = {
  cn: {
    website: "https://qoder.com.cn",
    openapi: "https://openapi.qoder.com.cn",
    userAgent: "QoderWork/1.1.75",
    chatUrl: "https://gateway.qoder.com.cn" + CHAT_PATH,
  },
  global: {
    website: "https://qoder.com",
    openapi: "https://openapi.qoder.sh",
    userAgent: "Qoder/1.1.75",
    chatUrl: "https://api3.qoder.sh" + CHAT_PATH,
  },
};

/** 国际版推理集群候选（签名只覆盖 path，换主机不影响签名） */
const GLOBAL_CHAT_CANDIDATES = ["https://api3.qoder.sh", "https://api2.qoder.sh", "https://api1.qoder.sh"].map(
  (h) => h + CHAT_PATH
);

/** 国内版模型目录（官方 QoderWork 清单） */
export const QODER_CN_MODELS = [
  "auto",
  "qmodel_38max",
  "qfmodel",
  "qmodel_latest",
  "qmodel",
  "q37fmodel",
  "dmodel",
  "dfmodel",
  "gmodel",
  "gfmodel",
  "gm51model",
  "kmodel_latest",
  "kmodel",
  "mmodel",
  "lmodel",
];

/** 国际版模型目录（账号实际可见清单由上游下发，这里作兜底） */
export const QODER_MODELS = [
  "auto",
  "qmodel_38max",
  "qfmodel",
  "qmodel_latest",
  "qmodel",
  "dmodel",
  "dfmodel",
  "gmodel",
  "gfmodel",
  "kmodel_latest",
  "kmodel",
  "mmodel",
  "lmodel",
  "ultimate",
  "performance",
  "efficient",
  "fast",
  "smodel",
  "cmodel",
];

export function regionFromBaseUrl(baseUrl?: string): QoderRegion {
  return /qoder\.com\.cn/i.test(baseUrl || "") ? "cn" : "global";
}

export function qoderModelsFor(baseUrl?: string): string[] {
  return regionFromBaseUrl(baseUrl) === "cn" ? QODER_CN_MODELS : QODER_MODELS;
}

// =====================================================================
// 凭据
// =====================================================================

export type QoderCredential = {
  v?: number;
  deviceToken: string;
  refreshToken: string;
  uid: string;
  name: string;
  userType: string;
  orgId: string;
  orgName: string;
  region: QoderRegion;
  issuedAt?: number;
};

/**
 * 凭据格式：JSON（授权时落库）；也兼容直接粘贴 `dt-...` 设备令牌。
 * JSON 字段与参考实现的 Account 对齐，便于后续迁移。
 */
export function parseQoderCredential(raw: string): QoderCredential | null {
  const text = (raw || "").trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text);
      const deviceToken = String(j.device_token || j.deviceToken || "");
      if (!deviceToken) return null;
      return {
        v: 1,
        deviceToken,
        refreshToken: String(j.refresh_token || j.refreshToken || ""),
        uid: String(j.uid || ""),
        name: String(j.name || j.nickname || ""),
        userType: String(j.user_type || j.userType || "personal_standard"),
        orgId: String(j.org_id || j.organizationId || ""),
        orgName: String(j.org_name || j.organizationName || ""),
        region: j.region === "cn" ? "cn" : "global",
        issuedAt: Number(j.issued_at || j.issuedAt || 0) || undefined,
      };
    } catch {
      return null;
    }
  }
  // 纯设备令牌：区域由渠道 baseUrl 决定，账号身份稍后从 userinfo 补
  if (text.startsWith("dt-")) {
    return {
      deviceToken: text,
      refreshToken: "",
      uid: "",
      name: "",
      userType: "personal_standard",
      orgId: "",
      orgName: "",
      region: "global",
    };
  }
  return null;
}

export function serializeQoderCredential(cred: QoderCredential): string {
  return JSON.stringify({
    v: 1,
    device_token: cred.deviceToken,
    refresh_token: cred.refreshToken,
    uid: cred.uid,
    name: cred.name,
    user_type: cred.userType,
    org_id: cred.orgId,
    org_name: cred.orgName,
    region: cred.region,
    issued_at: cred.issuedAt || Date.now(),
  });
}

// =====================================================================
// 设备授权（PKCE + 轮询）
// =====================================================================

export type QoderFlow = { state: string; url: string; interval: number };

export async function startQoderDeviceFlow(env: Env, baseUrl?: string): Promise<QoderFlow> {
  const region = regionFromBaseUrl(baseUrl);
  const ep = ENDPOINTS[region];
  // PKCE：Qoder 的 verifier 只接受 32 字节随机数的 base64url
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = btoa(String.fromCharCode(...verifierBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const nonce = region === "cn" ? crypto.randomUUID() : randomHex(16);
  const machineId = crypto.randomUUID();
  const params = new URLSearchParams({
    challenge,
    challenge_method: "S256",
    nonce,
    client_id: region === "cn" ? CLIENT_ID_CN : CLIENT_ID_GLOBAL,
    machine_id: machineId,
  });
  if (region === "cn") params.set("redirect_uri", REDIRECT_CN);
  const url = `${ep.website}/device/selectAccounts?${params.toString()}`;

  const state = `qd-${Date.now().toString(36)}-${randomHex(6)}`;
  await getBlobStore(env).setJSON(FLOW_KEY(state), {
    verifier,
    nonce,
    region,
    at: Date.now(),
  });
  return { state, url, interval: 3 };
}

async function fetchQoderUserInfo(
  deviceToken: string,
  region: QoderRegion
): Promise<Record<string, any> | null> {
  const ep = ENDPOINTS[region];
  try {
    const res = await fetch(`${ep.openapi}/api/v1/userinfo`, {
      headers: {
        authorization: `Bearer ${deviceToken}`,
        accept: "application/json",
        "user-agent": ep.userAgent,
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const j: any = await res.json().catch(() => null);
    return j?.data && typeof j.data === "object" ? j.data : j;
  } catch {
    return null;
  }
}

export type QoderPollResult = {
  status: "pending" | "ok" | "error";
  message?: string;
  refreshToken?: string;
  email?: string;
  account?: { uid?: string; nickname?: string; domain?: string };
};

export async function pollQoderDeviceFlow(env: Env, state: string): Promise<QoderPollResult> {
  const store = getBlobStore(env);
  const flow = (await store.get(FLOW_KEY(state), { type: "json", consistency: "strong" })) as {
    verifier?: string;
    nonce?: string;
    region?: QoderRegion;
    at?: number;
  } | null;
  if (!flow?.verifier || !flow?.nonce) {
    return { status: "error", message: "授权流程不存在或已过期，请重新发起" };
  }
  if (Date.now() - (flow.at || 0) > FLOW_TTL) {
    await store.delete(FLOW_KEY(state)).catch(() => {});
    return { status: "error", message: "授权已超时，请重新发起" };
  }
  const region = flow.region === "cn" ? "cn" : "global";
  const ep = ENDPOINTS[region];
  const qs = new URLSearchParams({
    nonce: flow.nonce,
    verifier: flow.verifier,
    challenge_method: "S256",
  });
  const res = await fetch(`${ep.openapi}/api/v1/deviceToken/poll?${qs.toString()}`, {
    headers: { accept: "application/json", "user-agent": "QoderWork" },
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  if (!res) return { status: "pending", message: "等待浏览器完成 Qoder 设备授权…" };
  if (res.status === 404 || res.status === 202) {
    return { status: "pending", message: "等待浏览器完成 Qoder 设备授权…" };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { status: "error", message: `授权轮询失败 HTTP ${res.status}: ${body.slice(0, 200)}` };
  }
  const j: any = await res.json().catch(() => null);
  const deviceToken = String(j?.token || j?.device_token || "");
  if (!deviceToken) return { status: "pending", message: "等待浏览器完成 Qoder 设备授权…" };

  const info = await fetchQoderUserInfo(deviceToken, region);
  const uid = String(info?.id || info?.userId || j?.user_id || "");
  const nickname = String(info?.name || info?.nickname || "");
  const email = String(info?.email || j?.email || "").trim();
  const cred: QoderCredential = {
    v: 1,
    deviceToken,
    refreshToken: String(j?.refresh_token || ""),
    uid,
    name: nickname,
    userType: String(info?.user_type || info?.userType || "personal_standard"),
    orgId: String(info?.organization_id || info?.organizationId || ""),
    orgName: String(info?.organization_name || info?.organizationName || ""),
    region,
    issuedAt: Date.now(),
  };
  await store.delete(FLOW_KEY(state)).catch(() => {});
  return {
    status: "ok",
    refreshToken: serializeQoderCredential(cred),
    email: email || undefined,
    account: {
      uid: uid || undefined,
      nickname: nickname || undefined,
      domain: region === "cn" ? "qoder.com.cn" : "qoder.com",
    },
  };
}

// =====================================================================
// COSY 会话缓存
// =====================================================================

const sessionCache = new Map<string, CosySession>();
const SESSION_CACHE_MAX = 50;

async function getCosySession(cred: QoderCredential): Promise<CosySession> {
  const cacheKey = `${cred.region}|${cred.uid || cred.deviceToken.slice(0, 24)}|${cred.deviceToken.slice(-8)}`;
  const hit = sessionCache.get(cacheKey);
  if (hit) return hit;
  const seed = cred.uid || `cred:${cred.deviceToken}`;
  const session = await createCosySession(
    {
      name: cred.name,
      aid: cred.uid,
      uid: cred.uid,
      organizationId: cred.orgId,
      organizationName: cred.orgName,
      userType: cred.userType,
      securityOauthToken: cred.deviceToken,
      refreshToken: cred.refreshToken,
    },
    seed
  );
  if (sessionCache.size >= SESSION_CACHE_MAX) sessionCache.clear();
  sessionCache.set(cacheKey, session);
  return session;
}

// =====================================================================
// 消息与请求体
// =====================================================================

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (p?.type === "text" ? String(p.text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function collectImages(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content as any[]) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "image_url" || part.type === "input_image") {
      const url =
        typeof part.image_url === "string"
          ? part.image_url
          : part.image_url?.url || part.url || "";
      if (typeof url === "string" && (url.startsWith("data:") || /^https?:\/\//.test(url))) {
        out.push(url);
      }
    } else if (part.type === "image" && part.source) {
      if (part.source.type === "base64" && part.source.data) {
        out.push(`data:${part.source.media_type || "image/png"};base64,${part.source.data}`);
      } else if (part.source.type === "url" && part.source.url) {
        out.push(String(part.source.url));
      }
    }
  }
  return out;
}

function nowBlankMeta() {
  return blankResponseMeta();
}

/** OpenAI Chat Completions 消息 → Qoder 模板消息（对齐参考实现的 BuildQoderMessages） */
function toQoderMessages(messages: any[]): any[] {
  const out: any[] = [];
  let systemText = "";
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "");
    if (role === "system" || role === "developer") {
      systemText += (systemText ? "\n\n" : "") + contentText(m.content);
      continue;
    }
    if (role === "user") {
      const text = contentText(m.content);
      const images = collectImages(m.content);
      const contents: any[] = images.map((url) => ({
        type: "image_url",
        image_url: { url },
      }));
      if (text || !contents.length) contents.push({ type: "text", text });
      out.push({
        role: "user",
        content: "",
        contents,
        response_meta: nowBlankMeta(),
        reasoning_content_signature: "",
      });
      continue;
    }
    if (role === "assistant") {
      const msg: any = {
        role: "assistant",
        content: contentText(m.content),
        response_meta: nowBlankMeta(),
        reasoning_content_signature: "",
      };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) msg.tool_calls = m.tool_calls;
      out.push(msg);
      continue;
    }
    if (role === "tool" || role === "function") {
      const msg: any = {
        role: "tool",
        content: contentText(m.content),
        response_meta: nowBlankMeta(),
        reasoning_content_signature: "",
      };
      if (m.tool_call_id) msg.tool_call_id = String(m.tool_call_id);
      if (m.name) msg.name = String(m.name);
      out.push(msg);
    }
  }
  if (systemText.trim()) out.unshift({ role: "system", content: systemText.trim() });
  if (!out.length) {
    out.push({
      role: "user",
      content: "",
      contents: [{ type: "text", text: "hi" }],
      response_meta: nowBlankMeta(),
      reasoning_content_signature: "",
    });
  }
  return out;
}

function latestUserPrompt(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (Array.isArray(m.contents)) {
      const text = m.contents
        .filter((p: any) => p?.type === "text")
        .map((p: any) => String(p.text ?? ""))
        .join("\n");
      if (text) return text;
    }
    const text = contentText(m.content);
    if (text) return text;
  }
  return "";
}

function normalizeTools(tools: unknown): any[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t: any) => {
      if (!t || typeof t !== "object") return null;
      if (t.type === "function" && t.function) return t;
      const name = t.name || t.function?.name;
      if (!name) return null;
      return {
        type: "function",
        function: {
          name,
          description: t.description || t.function?.description || "",
          parameters: t.parameters || t.input_schema || { type: "object", properties: {} },
        },
      };
    })
    .filter(Boolean);
}

type ModelMeta = { display: string; ctx: number; vl: boolean; reasoning: boolean };

const MODEL_META: Record<string, ModelMeta> = {
  auto: { display: "Auto", ctx: 200000, vl: true, reasoning: false },
  ultimate: { display: "Ultimate", ctx: 1000000, vl: true, reasoning: true },
  performance: { display: "Performance", ctx: 1000000, vl: true, reasoning: false },
  efficient: { display: "Efficient", ctx: 200000, vl: true, reasoning: false },
  fast: { display: "Fast", ctx: 200000, vl: true, reasoning: false },
  smodel: { display: "Sonus", ctx: 180000, vl: true, reasoning: true },
  cmodel: { display: "Cantus", ctx: 180000, vl: true, reasoning: true },
  qmodel_38max: { display: "Qwen3.8-Max", ctx: 180000, vl: true, reasoning: false },
  qfmodel: { display: "Qwen3.8-Flash", ctx: 180000, vl: true, reasoning: false },
  qmodel_latest: { display: "Qwen3.7-Max", ctx: 180000, vl: true, reasoning: true },
  qmodel: { display: "Qwen3.7-Plus", ctx: 180000, vl: true, reasoning: false },
  q37fmodel: { display: "Qwen3.7-Flash", ctx: 180000, vl: true, reasoning: false },
  dmodel: { display: "DeepSeek-V4-Pro", ctx: 96000, vl: false, reasoning: true },
  dfmodel: { display: "DeepSeek-Flash", ctx: 180000, vl: false, reasoning: true },
  gmodel: { display: "GLM-5.3", ctx: 180000, vl: false, reasoning: true },
  gfmodel: { display: "GLM-5.3-Flash", ctx: 1000000, vl: false, reasoning: true },
  gm51model: { display: "GLM-5.2", ctx: 180000, vl: false, reasoning: true },
  kmodel_latest: { display: "Kimi-K3", ctx: 180000, vl: true, reasoning: true },
  kmodel: { display: "Kimi-K2.8-Preview", ctx: 180000, vl: true, reasoning: true },
  mmodel: { display: "MiniMax-M3", ctx: 180000, vl: true, reasoning: true },
  lmodel: { display: "QoDuck", ctx: 180000, vl: true, reasoning: false },
};

function modelMeta(model: string): ModelMeta {
  return (
    MODEL_META[model] || {
      display: model,
      ctx: 180000,
      vl: true,
      reasoning: false,
    }
  );
}

function requestedEffort(body: Record<string, any>): string {
  const raw =
    body?.reasoning_effort ||
    body?.reasoning?.effort ||
    body?.thinking?.effort ||
    body?.thinking?.level ||
    "";
  const text = String(raw || "").toLowerCase();
  if (!text) return "";
  if (["low", "minimal"].includes(text)) return "low";
  if (["high", "xhigh", "max"].includes(text)) return "high";
  if (text === "medium") return "medium";
  return "";
}

function buildQoderBody(
  cred: QoderCredential,
  model: string,
  body: Record<string, any>,
  messages: any[]
): Record<string, any> {
  const prompt = latestUserPrompt(messages);
  const nid = crypto.randomUUID();
  const meta = modelMeta(model);
  const effort = requestedEffort(body);
  // 只有客户端显式要求推理时才打开，避免普通请求被动进入思考模式
  const isReasoning = !!effort;
  const modelConfig = {
    key: model,
    display_name: meta.display,
    model: "",
    format: "openai",
    is_vl: meta.vl,
    is_reasoning: isReasoning,
    api_key: "",
    url: "",
    source: "system",
    max_input_tokens: meta.ctx,
  };
  const maxTokens = Math.min(
    32768,
    Math.max(1, Number(body?.max_tokens || body?.max_completion_tokens) || 32768)
  );
  const parameters: Record<string, unknown> = { max_tokens: maxTokens };
  if (effort) parameters.reasoning_effort = effort;

  return {
    request_id: nid,
    request_set_id: crypto.randomUUID(),
    chat_record_id: nid,
    stream: true,
    chat_task: "FREE_INPUT",
    chat_context: {
      chatPrompt: "",
      extra: {
        context: [],
        modelConfig: { ...modelConfig },
        originalContent: { type: "text", text: prompt },
      },
      features: [],
      imageUrls: null,
      text: { type: "text", text: prompt },
    },
    image_urls: null,
    is_reply: true,
    is_retry: false,
    session_id: crypto.randomUUID(),
    code_language: "",
    source: 1,
    version: "3",
    chat_prompt: "",
    parameters,
    aliyun_user_type: cred.userType || "personal_standard",
    session_type: "qoder",
    agent_id: "agent_common",
    task_id: "common",
    model_config: modelConfig,
    messages,
    tools: normalizeTools(body?.tools),
    business: {
      product: "cli",
      version: COSY_VERSION,
      type: "agent",
      id: crypto.randomUUID(),
      name: (prompt || "chat").slice(0, 30),
      begin_at: Date.now(),
      stage: "start",
      model_key: model,
    },
  };
}

// =====================================================================
// 上游调用与 SSE 解析
// =====================================================================

type ToolCallAcc = {
  id?: string;
  type?: string;
  function: { name: string; arguments: string };
};

type UpstreamResult = {
  ok: boolean;
  status: number;
  content: string;
  reasoning: string;
  toolCalls: ToolCallAcc[];
  finishReason: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  error?: string;
  errorType?: string;
};

function mergeToolCall(acc: ToolCallAcc[], tc: any): void {
  if (!tc || typeof tc !== "object") return;
  const idx = Number.isInteger(tc.index) ? tc.index : acc.length;
  const slot = acc[idx] || (acc[idx] = { type: "function", function: { name: "", arguments: "" } });
  if (tc.id) slot.id = String(tc.id);
  if (tc.type) slot.type = String(tc.type);
  const fn = tc.function || {};
  if (fn.name) slot.function.name = String(fn.name);
  if (fn.arguments) slot.function.arguments += String(fn.arguments);
}

/** 解析上游 SSE 信封；返回聚合后的内容与错误 */
function parseUpstreamSse(text: string): UpstreamResult {
  const result: UpstreamResult = {
    ok: true,
    status: 200,
    content: "",
    reasoning: "",
    toolCalls: [],
    finishReason: "stop",
  };
  let sawAny = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let wrapper: any;
    try {
      wrapper = JSON.parse(payload);
    } catch {
      continue;
    }
    if (wrapper?.statusCodeValue !== undefined && Number(wrapper.statusCodeValue) !== 200) {
      return {
        ...result,
        ok: false,
        status: Number(wrapper.statusCodeValue) || 502,
        error: String(wrapper.body || "").slice(0, 400) || "上游信封错误",
      };
    }
    let inner: any = wrapper;
    if (typeof wrapper?.body === "string") {
      try {
        inner = JSON.parse(wrapper.body);
      } catch {
        continue;
      }
    } else if (wrapper?.body && typeof wrapper.body === "object") {
      inner = wrapper.body;
    }
    sawAny = true;
    if (inner?.usage && typeof inner.usage === "object") {
      result.usage = {
        prompt_tokens: Number(inner.usage.prompt_tokens) || 0,
        completion_tokens: Number(inner.usage.completion_tokens) || 0,
        total_tokens: Number(inner.usage.total_tokens) || 0,
      };
    }
    if (inner?.code !== undefined && String(inner.code) !== "" && String(inner.code) !== "0") {
      return {
        ...result,
        ok: false,
        status: 502,
        error: `Qoder 业务错误 ${inner.code}: ${String(inner.message || inner.msg || "").slice(0, 300)}`,
      };
    }
    const choices = Array.isArray(inner?.choices) ? inner.choices : [];
    for (const choice of choices) {
      if (choice?.finish_reason) {
        const fr = String(choice.finish_reason);
        result.finishReason = fr === "tool_calls" ? "tool_calls" : fr === "length" ? "length" : "stop";
      }
      const delta = choice?.delta;
      if (!delta || typeof delta !== "object") continue;
      if (typeof delta.content === "string") result.content += delta.content;
      if (typeof delta.reasoning_content === "string") result.reasoning += delta.reasoning_content;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) mergeToolCall(result.toolCalls, tc);
      }
    }
  }
  if (!sawAny) {
    const preview = text.trim().slice(0, 300);
    return {
      ...result,
      ok: false,
      status: 502,
      error: preview ? `上游返回非 SSE 响应: ${preview}` : "上游返回空响应",
    };
  }
  if (result.toolCalls.length) result.finishReason = "tool_calls";
  result.toolCalls = result.toolCalls.filter(Boolean);
  return result;
}

function errorResponse(message: string, status: number, type = "qoder_error"): Response {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function classifyError(status: number, detail: string): { message: string; type: string; status: number } {
  const raw = (detail || "").slice(0, 400);
  if (/TOKEN_EXPIRE|token expired|login_expired|unauthorized/i.test(raw)) {
    return {
      message: `Qoder 登录已过期，请重新授权该账号：${raw}`,
      type: "login_expired",
      status: 401,
    };
  }
  if (status === 401) return { message: `Qoder 鉴权失败：${raw}`, type: "authentication_error", status: 401 };
  if (status === 429 || /rate.?limit|too many|frequency|queue|busy/i.test(raw)) {
    return { message: `Qoder 账号繁忙或触发限流：${raw}`, type: "rate_limit_error", status: 429 };
  }
  if (status === 403) return { message: `Qoder 拒绝访问：${raw}`, type: "permission_error", status: 403 };
  return { message: `Qoder 上游错误 ${status}: ${raw}`, type: "upstream_error", status: 502 };
}

async function callQoderUpstream(
  cred: QoderCredential,
  model: string,
  body: Record<string, any>,
  messages: any[]
): Promise<UpstreamResult> {
  const session = await getCosySession(cred);
  const upstreamBody = buildQoderBody(cred, model, body, messages);
  const encoded = qoderEncode(JSON.stringify(upstreamBody));
  const candidates =
    cred.region === "cn" ? [ENDPOINTS.cn.chatUrl] : GLOBAL_CHAT_CANDIDATES;

  let lastError = "";
  let lastStatus = 0;
  for (const url of candidates) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: cosyHeaders(session, encoded, url, { model, sse: true }),
        body: encoded,
        signal: AbortSignal.timeout(300000),
      });
    } catch (err) {
      lastError = (err as Error).message || "请求失败";
      lastStatus = 0;
      continue;
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      lastStatus = res.status;
      lastError = text.slice(0, 400) || `HTTP ${res.status}`;
      // 5xx / 传输层故障才换集群；4xx 是账号或参数问题
      if (res.status >= 500) continue;
      const mapped = classifyError(res.status, lastError);
      return {
        ok: false,
        status: mapped.status,
        content: "",
        reasoning: "",
        toolCalls: [],
        finishReason: "stop",
        error: mapped.message,
        errorType: mapped.type,
      };
    }
    return parseUpstreamSse(text);
  }
  const mapped = classifyError(lastStatus, lastError);
  return {
    ok: false,
    status: mapped.status,
    content: "",
    reasoning: "",
    toolCalls: [],
    finishReason: "stop",
    error: mapped.message,
    errorType: mapped.type,
  };
}

// =====================================================================
// 对话入口
// =====================================================================

export type QoderCallParams = {
  env: Env;
  providerId: string;
  baseUrl?: string;
  modelId: string;
  requestedModel: string;
  body: Record<string, any>;
  refreshToken: string;
};

function toOpenAIToolCalls(acc: ToolCallAcc[]): any[] {
  return acc.map((tc, i) => ({
    id: tc.id || `call_${i}`,
    type: "function",
    function: {
      name: tc.function.name,
      arguments: tc.function.arguments || "{}",
    },
  }));
}

function synthesizeSse(
  requestedModel: string,
  content: string,
  reasoning: string,
  toolCalls: any[],
  finishReason: string,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): Response {
  const id = `chatcmpl-${randomHex(12)}`;
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: "chat.completion.chunk", created, model: requestedModel };
  const first: any = { role: "assistant" };
  if (content) first.content = content;
  if (reasoning) first.reasoning_content = reasoning;
  if (toolCalls.length) first.tool_calls = toolCalls.map((tc, i) => ({ ...tc, index: i }));
  const frames: string[] = [];
  frames.push(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: first, finish_reason: null }] })}\n\n`);
  frames.push(
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    })}\n\n`
  );
  if (usage) {
    frames.push(`data: ${JSON.stringify({ ...base, choices: [], usage })}\n\n`);
  }
  frames.push("data: [DONE]\n\n");
  return new Response(frames.join(""), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function handleQoderRequest(p: QoderCallParams): Promise<Response> {
  const cred = parseQoderCredential(p.refreshToken);
  if (!cred) {
    return errorResponse(
      "该 qoder 渠道未配置有效凭据：请点「用 Qoder 账号授权」完成设备授权",
      400,
      "configuration_error"
    );
  }
  if (!cred.region) cred.region = regionFromBaseUrl(p.baseUrl);
  if (!cred.uid && p.baseUrl) cred.region = regionFromBaseUrl(p.baseUrl);

  const messages = toQoderMessages(Array.isArray(p.body?.messages) ? p.body.messages : []);
  const result = await callQoderUpstream(cred, p.modelId, p.body || {}, messages);
  if (!result.ok) {
    return errorResponse(result.error || "Qoder 请求失败", result.status, result.errorType);
  }

  const toolCalls = toOpenAIToolCalls(result.toolCalls);
  const message: any = {
    role: "assistant",
    content: result.content || (toolCalls.length ? null : ""),
  };
  if (result.reasoning) message.reasoning_content = result.reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  if (p.body?.stream === true) {
    return synthesizeSse(
      p.requestedModel,
      result.content,
      result.reasoning,
      toolCalls,
      result.finishReason,
      result.usage
    );
  }

  const completion: any = {
    id: `chatcmpl-${randomHex(12)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: p.requestedModel,
    choices: [{ index: 0, message, finish_reason: result.finishReason }],
  };
  if (result.usage) completion.usage = result.usage;
  return jsonResponse(completion);
}

// =====================================================================
// 连通性测试 / 模型
// =====================================================================

export async function testQoder(
  _env: Env,
  refreshToken: string,
  modelId: string,
  baseUrl?: string
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const cred = parseQoderCredential(refreshToken);
  if (!cred) return { success: false, message: "凭据格式无效" };
  if (!cred.uid) cred.region = regionFromBaseUrl(baseUrl);
  try {
    const r = await callQoderUpstream(
      cred,
      modelId,
      { messages: [{ role: "user", content: "hi" }], max_tokens: 32 },
      toQoderMessages([{ role: "user", content: "hi" }])
    );
    if (!r.ok) return { success: false, message: r.error || "请求失败", statusCode: r.status };
    if (!r.content && !r.toolCalls.length) {
      return { success: false, message: "上游返回空内容", statusCode: 200 };
    }
    return {
      success: true,
      message: r.content ? `连接成功：${r.content.slice(0, 60)}` : "连接成功（工具调用）",
      statusCode: 200,
    };
  } catch (err) {
    return { success: false, message: (err as Error).message || "请求失败" };
  }
}

/**
 * 诊断探针：授权后不确认「有没有额度 / 是不是登录态」时用。
 *
 * 为什么是一个路径矩阵：参考实现实测国际版 openapi 上的 /api/v2/quota/usage
 * 经常 404/403，而 /sash/api/v1/me/* 才有数据，且国内/国际不是同一套。
 * 与其猜，不如把候选路径全打一遍，把状态码和响应片段原样回给控制台。
 */
export type QoderProbeEntry = { path: string; status: number; body: string };

export type QoderProbeResult = {
  credential: {
    region: QoderRegion;
    host: string;
    uid: string;
    name: string;
    userType: string;
    orgName: string;
    hasRefreshToken: boolean;
    refreshTokenPrefix: string;
    issuedAt: string | null;
    ageDays: number | null;
  };
  probes: QoderProbeEntry[];
  credits: number | null;
  hint: string;
};

const PROBE_PATHS = [
  "/api/v1/userinfo",
  "/api/v2/user/plan",
  "/api/v2/quota/usage",
  "/api/v1/quota/usage",
  "/sash/api/v1/me/quota",
  "/sash/api/v1/me/credits",
  "/sash/api/v1/me/campaigns",
];

/** 从任意结构的 JSON 里捞第一个像「剩余额度」的数字 */
function findCreditNumber(node: unknown, depth = 0): number | null {
  if (depth > 4 || node == null) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findCreditNumber(item, depth + 1);
      if (hit != null) return hit;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === "number" && /credit|remain|balance|available|total/i.test(k)) return v;
    if (v && typeof v === "object") {
      const hit = findCreditNumber(v, depth + 1);
      if (hit != null) return hit;
    }
  }
  return null;
}

export async function probeQoder(_env: Env, raw: string, baseUrl?: string): Promise<QoderProbeResult> {
  const cred = parseQoderCredential(raw);
  if (!cred) throw new Error("凭据格式无效");
  const region: QoderRegion = cred.region || regionFromBaseUrl(baseUrl);
  const host = ENDPOINTS[region].openapi;
  const headers: Record<string, string> = {
    authorization: `Bearer ${cred.deviceToken}`,
    accept: "application/json",
    "user-agent": ENDPOINTS[region].userAgent,
  };

  const probes: QoderProbeEntry[] = [];
  for (const path of PROBE_PATHS) {
    try {
      const r = await fetch(host + path, { headers, signal: AbortSignal.timeout(15000) });
      const text = await r.text().catch(() => "");
      probes.push({ path, status: r.status, body: text.slice(0, 600) });
    } catch (err) {
      probes.push({ path, status: 0, body: (err as Error).message || "请求失败" });
    }
  }

  let credits: number | null = null;
  for (const p of probes) {
    if (p.status < 200 || p.status >= 300) continue;
    try {
      const hit = findCreditNumber(JSON.parse(p.body));
      if (hit != null) {
        credits = hit;
        break;
      }
    } catch {
      /* 非 JSON 直接跳过 */
    }
  }

  const userinfo = probes.find((p) => p.path === "/api/v1/userinfo");
  const campaigns = probes.find((p) => p.path === "/sash/api/v1/me/campaigns");
  const allUnauthorized = probes.every((p) => p.status === 401 || p.status === 403);
  const hint = allUnauthorized
    ? "全部探测均为 401/403：设备令牌已失效，请重新授权该账号"
    : userinfo && userinfo.status >= 200 && userinfo.status < 300
    ? campaigns && campaigns.status === 404
      ? "凭据有效；该区域未开放活动接口，签到会提示「无可用签到活动」"
      : "凭据有效"
    : "用户信息接口未通过，先核对区域选择（国内/国际）是否与账号一致";

  const issuedAt = cred.issuedAt ? new Date(cred.issuedAt).toISOString() : null;
  return {
    credential: {
      region,
      host,
      uid: cred.uid,
      name: cred.name,
      userType: cred.userType,
      orgName: cred.orgName,
      hasRefreshToken: Boolean(cred.refreshToken),
      refreshTokenPrefix: cred.refreshToken ? cred.refreshToken.slice(0, 4) : "",
      issuedAt,
      ageDays: cred.issuedAt ? Math.floor((Date.now() - cred.issuedAt) / 86400000) : null,
    },
    probes,
    credits,
    hint,
  };
}

export async function fetchQoderModels(
  _env: Env,
  _refreshToken: string,
  baseUrl?: string
): Promise<{ success: boolean; models: string[]; message?: string }> {
  // 上游模型目录是「带 body 的 GET」，Workers/EdgeOne 的 fetch 不允许 GET body；
  // 这里直接使用官方客户端目录做兜底，避免每次导入模型都先吃一个 403。
  return {
    success: true,
    models: qoderModelsFor(baseUrl),
    message: "使用 Qoder 官方模型目录（动态目录需带 body 的 GET，边缘运行时不可用）",
  };
}

// =====================================================================
// 签到（每日 100 Credits）
// =====================================================================

export type QoderCheckinResult = {
  ok: boolean;
  already?: boolean;
  reward?: number;
  message?: string;
};

async function checkinHeaders(cred: QoderCredential): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${cred.deviceToken}`,
    accept: "application/json",
    "accept-language": "zh-CN",
    "user-agent": "Qoder",
    "cosy-clienttype": "10",
  };
  // 国内版刻意不发指纹头（发了反而可能不下发活动）；
  // 国际版需要指纹头，这里用按账号派生的身份尽力而为。
  if (cred.region === "global") {
    const seed = cred.uid || `cred:${cred.deviceToken}`;
    headers["cosy-version"] = "0.4.4";
    headers["cosy-machineid"] = deriveMachineId(seed);
    headers["cosy-machinetoken"] = await deriveMachineToken(seed);
    headers["cosy-machinetype"] = deriveMachineType(seed);
    headers["cosy-machinehostname"] = deriveMachineHostname(seed);
    headers["cosy-machineos"] = "x86_64_linux";
  }
  return headers;
}

export async function checkinQoder(
  _env: Env,
  raw: string,
  baseUrl?: string
): Promise<QoderCheckinResult> {
  const cred = parseQoderCredential(raw);
  if (!cred) return { ok: false, message: "凭据格式无效" };
  // 手工粘贴的设备令牌没有区域信息，按渠道 baseUrl 判定
  if (baseUrl) cred.region = regionFromBaseUrl(baseUrl);
  const host = cred.region === "cn" ? "openapi.qoder.com.cn" : "openapi.qoder.sh";
  const headers = await checkinHeaders(cred);
  try {
    const listRes = await fetch(`https://${host}/sash/api/v1/me/campaigns`, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
    const listText = await listRes.text().catch(() => "");
    if (!listRes.ok) {
      return { ok: false, message: `查询活动失败 HTTP ${listRes.status}: ${listText.slice(0, 200)}` };
    }
    let list: any = null;
    try {
      list = JSON.parse(listText);
    } catch {
      return { ok: false, message: `活动列表非 JSON：${listText.slice(0, 160)}` };
    }
    const campaigns: any[] = Array.isArray(list?.campaigns)
      ? list.campaigns
      : Array.isArray(list?.data?.campaigns)
      ? list.data.campaigns
      : [];
    if (!campaigns.length) {
      return {
        ok: false,
        message:
          cred.region === "global"
            ? "无可用签到活动（国际版需要客户端真实设备指纹，派生指纹可能不下发活动）"
            : "无可用签到活动",
      };
    }
    let target: any = null;
    let alreadyClaimed = false;
    for (const c of campaigns) {
      if (String(c?.actionType || "") !== "CLAIM_BENEFIT") continue;
      if (String(c?.claimStatus || "") === "CLAIMABLE") target = c;
      else if (String(c?.claimStatus || "") === "CLAIMED") alreadyClaimed = true;
    }
    if (!target) {
      if (alreadyClaimed) return { ok: true, already: true, message: "今日已领取" };
      return { ok: false, message: "无可领取的签到活动" };
    }
    const campaignId = String(target.campaignId || "");
    if (!campaignId) return { ok: false, message: "活动缺少 campaignId" };
    const claimRes = await fetch(
      `https://${host}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`,
      {
        method: "POST",
        headers: { ...headers, origin: `https://${host}` },
        signal: AbortSignal.timeout(20000),
      }
    );
    const claimText = await claimRes.text().catch(() => "");
    if (!claimRes.ok) {
      return { ok: false, message: `领取失败 HTTP ${claimRes.status}: ${claimText.slice(0, 200)}` };
    }
    let claim: any = null;
    try {
      claim = JSON.parse(claimText);
    } catch {
      return { ok: false, message: `领取响应非 JSON：${claimText.slice(0, 160)}` };
    }
    const status = String(claim?.status || "").toUpperCase();
    if (status === "CLAIMED") {
      if (claim?.replayed === true) return { ok: true, already: true, message: "今日已领取" };
      const reward = Number(claim?.benefit?.amount ?? claim?.amount ?? claim?.credits ?? 0) || 0;
      return {
        ok: true,
        reward: reward || undefined,
        message: reward ? `领取成功 +${reward} Credits` : "领取成功",
      };
    }
    return { ok: false, message: `未知领取状态：${status || claimText.slice(0, 120)}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "签到失败" };
  }
}
