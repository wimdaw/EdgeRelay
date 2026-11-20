/**
 * Trae（字节跳动 AI IDE）反代 —— 国内版 / 国际版双区
 *
 * 与 CodeBuddy / Qoder 一样，Trae 的两个版本是**两套完全独立的账号体系**：
 *   - 国内版：www.trae.cn 授权 → 数据面 trae-api-cn.mchost.guru，鉴权头 Cloud-IDE-JWT
 *   - 国际版：www.trae.ai 授权 → 数据面 core-normal.traeapi.us / coresg-normal.trae.ai，鉴权头 Bearer
 * 因此渠道按区域分成两条（baseUrl 决定区域），授权时先选区域。
 *
 * 上游协议要点（2026-11 实测口径，参考 trae2api-hub / trae-api-proxy / cockpit）：
 *  1. 对话：POST {core}/api/ide/v1/llm_raw_chat
 *     body = { model_name, messages:[{role,content:[{type:"text",text}]}], stream, ...采样参数 }
 *     **content 必须是 parts 数组**，直接传字符串上游返回 400 (code 4001)。
 *     服务端永远回 SSE，即使 stream=false。
 *  2. 兼容通道：POST {core}/api/agent/v3/llm_utils_chat
 *     body 增加 function:"chat_v3" / session_id / request_id；llm_raw_chat 不可用时兜底。
 *  3. 模型目录：GET {core}/api/ide/v1/model_list（仅国内版开放；国际版返回 403，走内置快照）。
 *  4. 授权：浏览器授权码 + PKCE(S256)，回调固定为 http://127.0.0.1:<port>/authorize。
 *     云端函数收不到 loopback 回调，所以采用「打开授权页 → 粘贴地址栏完整回调 URL」的流程，
 *     与 claude / codex 的 redirect 模式一致。
 *  5. 续期：POST {account}/cloudide/api/v3/trae/oauth/ExchangeToken
 *     body = { ClientID, RefreshToken, ClientSecret:"-", UserID:"" }
 *     上游每次换发新 refresh_token 并消费旧的，必须用 common.resolveAccessToken 的链式缓存。
 *
 * 合规：仅使用用户本人已登录的 Trae 账号，凭据 AES-256-GCM 加密入库，不进日志。
 */
import type { Env } from "../types";
import { getKV } from "../storage/blob-store";
import {
  type OAuthCallParams,
  base64UrlEncode,
  defer,
  oauthErrorResponse,
  randomHex,
  randomId,
  recordOAuthUsage,
  resolveAccessToken,
} from "./common";

// =====================================================================
// 区域与端点
// =====================================================================

export type TraeRegion = "cn" | "global";

/** 渠道 baseUrl → 区域。国内版三个域都归 CN，其余（trae.ai / traeapi.us）归国际版 */
export function regionFromBaseUrl(baseUrl?: string): TraeRegion {
  const b = (baseUrl || "").trim();
  if (/trae\.com\.cn|trae\.cn|mchost\.guru/i.test(b)) return "cn";
  return "global";
}

/**
 * 区域裁决：渠道 baseUrl 是权威来源（授权时写入）；
 * 手工粘贴凭据、baseUrl 留空时才回落到凭据里记录的区域。
 */
function resolveRegion(baseUrl: string | undefined, cred?: TraeCredential | null): TraeRegion {
  return (baseUrl || "").trim() ? regionFromBaseUrl(baseUrl) : cred?.region || "global";
}

export type TraeEndpoint = {
  key: TraeRegion;
  label: string;
  /** 数据面（对话 / 模型目录） */
  core: string;
  coreFallbacks: string[];
  /** 账号面（OAuth 换票 / GetUserInfo） */
  account: string;
  accountFallbacks: string[];
  /** 授权页宿主 */
  authorizeHost: string;
  clientId: string;
  pluginVersion: string;
  ideVersion: string;
  ideVersionCode: string;
  userAgent: string;
  /** 对话鉴权方案：国内 Cloud-IDE-JWT / 国际 Bearer */
  authScheme: "cloudide" | "bearer";
  storeCountryCode?: string;
  /** 账号归属区域，回填给上游头 */
  regionCode: "CN" | "US";
};

const DEFAULT_ENDPOINTS: Record<TraeRegion, TraeEndpoint> = {
  cn: {
    key: "cn",
    label: "国内版",
    core: "https://trae-api-cn.mchost.guru",
    // 国内数据面只有 mchost 一处；api.trae.com.cn 只承接 CloudIDE/OAuth，打 /api/ide/* 会 404
    coreFallbacks: [],
    account: "https://api.trae.com.cn",
    accountFallbacks: ["https://api.trae.cn"],
    authorizeHost: "https://www.trae.cn",
    clientId: "ono9krqynydwx5",
    pluginVersion: "2.3.24254",
    ideVersion: "3.4.3",
    ideVersionCode: "20260212",
    userAgent: "Trae CN/3.4.3",
    authScheme: "cloudide",
    regionCode: "CN",
  },
  global: {
    key: "global",
    label: "国际版",
    core: "https://core-normal.traeapi.us",
    coreFallbacks: ["https://core-normal.trae.ai", "https://coresg-normal.trae.ai"],
    account: "https://grow-normal.trae.ai",
    accountFallbacks: ["https://grow-normal.traeapi.us"],
    authorizeHost: "https://www.trae.ai",
    clientId: "ono9krqynydwx5",
    pluginVersion: "2.3.62834",
    ideVersion: "3.6.2",
    ideVersionCode: "20260924",
    userAgent: "TraeClient/TTNet",
    authScheme: "bearer",
    storeCountryCode: "us",
    regionCode: "US",
  },
};

const APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
const PLUGIN_CHANNEL = "icube-ai";

/** 可由环境变量覆盖的端点（缺省用内置默认值，便于上游改域时热修） */
export function traeEndpoints(env: Env, region: TraeRegion): TraeEndpoint {
  const base = DEFAULT_ENDPOINTS[region];
  const override = (key: string, fallback: string): string => {
    const v = env?.[key];
    return typeof v === "string" && v.trim() ? v.trim().replace(/\/+$/, "") : fallback;
  };
  const clientId = override(
    region === "cn" ? "TRAE_CN_CLIENT_ID" : "TRAE_GLOBAL_CLIENT_ID",
    override("TRAE_CLIENT_ID", base.clientId)
  );
  return {
    ...base,
    core: override(region === "cn" ? "TRAE_CN_CORE_URL" : "TRAE_GLOBAL_CORE_URL", base.core),
    account: override(region === "cn" ? "TRAE_CN_ACCOUNT_URL" : "TRAE_GLOBAL_ACCOUNT_URL", base.account),
    clientId,
  };
}

// =====================================================================
// 模型目录（实时 model_list 不可用时的兜底快照）
// =====================================================================

/**
 * 国际版不开放 /api/ide/v1/model_list（403 no schema found），必须有静态目录。
 * 国内版优先实时拉取，这份只作为拉取失败时的兜底。
 * 名称按官方展示名收录，导入渠道后可在「模型池」里改成实际 upstream 名。
 */
export const TRAE_GLOBAL_MODELS = [
  "Gemini-3.1-Pro-Preview",
  "Gemini-3-Flash-Preview",
  "Gemini-2.5-Pro",
  "Gemini-2.5-Flash",
  "Kimi-K2-0905",
  "Grok-4",
  "Claude-Opus-4.7",
  "Claude-Sonnet-4.6",
  "GPT-5.5",
  "GPT-6-Astra",
];

export const TRAE_CN_MODELS = [
  "auto",
  "glm-5.3",
  "glm-5.2",
  "kimi-k3",
  "deepseek-V3",
  "deepseek-R1",
  "Doubao-Seed-2.1-Turbo",
];

export function defaultModelsFor(region: TraeRegion): string[] {
  return region === "cn" ? [...TRAE_CN_MODELS] : [...TRAE_GLOBAL_MODELS];
}

/** 双区同名的模型（如 glm-5.3 / minimax-m3）用前缀显式选边，避免路由到另一区 */
const MODEL_PREFIX: Record<string, TraeRegion> = {
  "trae-cn/": "cn",
  "trae-intl/": "global",
  "trae-global/": "global",
};

/**
 * 归一化公开模型名：
 *  - 去掉 trae-cn/ trae-intl/ trae/ 前缀（前缀只用于选边，不进上游）
 *  - 去空白、去掉 " (显示名)" 尾巴
 * 返回 { model, forcedRegion }，forcedRegion 仅在显式前缀时存在。
 */
export function normalizeTraeModel(model: string): { model: string; forcedRegion?: TraeRegion } {
  let m = (model || "").trim();
  let forcedRegion: TraeRegion | undefined;
  for (const [prefix, region] of Object.entries(MODEL_PREFIX)) {
    if (m.toLowerCase().startsWith(prefix)) {
      forcedRegion = region;
      m = m.slice(prefix.length).trim();
      break;
    }
  }
  m = m.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return { model: m, forcedRegion };
}

// =====================================================================
// 凭据
// =====================================================================

export type TraeCredential = {
  v?: number;
  region: TraeRegion;
  refreshToken: string;
  /** 回调里直接带回的 access_token（可省一次换票） */
  accessToken?: string;
  accessExpiresAt?: number;
  uid?: string;
  name?: string;
  /** 设备身份（上游风控按账号+设备绑定，必须稳定） */
  machineId: string;
  deviceId: string;
  clientId?: string;
  issuedAt?: number;
};

/** 由 refresh_token 稳定派生设备指纹：同一账号多次刷新不会漂移 */
function deviceIdentity(refreshToken: string): { machineId: string; deviceId: string } {
  // 同步不可用 sha256Hex（异步），这里用轻量稳定散列即可：设备头只要求"同账号稳定"
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const seed = `trae:${refreshToken}`;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193 >>> 0;
    h2 = (h2 + c * 0x85ebca6b) >>> 0;
  }
  const pad = (n: number) => n.toString(16).padStart(8, "0");
  const machineId = (pad(h1) + pad(h2) + pad((h1 ^ h2) >>> 0) + pad((h1 + h2) >>> 0)).slice(0, 32);
  const deviceId = (pad((h1 * 3) >>> 0) + pad((h2 * 7) >>> 0) + pad((h1 ^ h2 ^ 0x5bf03635) >>> 0) + pad((h1 + h2 * 5) >>> 0)).slice(0, 32);
  return { machineId, deviceId };
}

/**
 * 凭据格式：授权时写入的 JSON；也兼容直接粘贴纯 refresh_token（手工导入场景）。
 * region 缺省时由渠道 baseUrl 决定，不在这里猜测。
 */
export function parseTraeCredential(raw: string, baseUrl?: string): TraeCredential | null {
  const text = (raw || "").trim();
  if (!text) return null;
  const fallbackRegion = regionFromBaseUrl(baseUrl);
  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text);
      const refreshToken = String(j.refresh_token || j.refreshToken || "");
      if (!refreshToken) return null;
      const region: TraeRegion = j.region === "cn" ? "cn" : j.region === "global" ? "global" : fallbackRegion;
      const id = deviceIdentity(refreshToken);
      return {
        v: 1,
        region,
        refreshToken,
        accessToken: j.access_token || j.accessToken || undefined,
        accessExpiresAt: Number(j.access_expires_at || j.accessExpiresAt || 0) || undefined,
        uid: String(j.uid || ""),
        name: String(j.name || j.screen_name || j.screenName || ""),
        machineId: String(j.machine_id || j.machineId || id.machineId),
        deviceId: String(j.device_id || j.deviceId || id.deviceId),
        clientId: j.client_id || j.clientId || undefined,
        issuedAt: Number(j.issued_at || j.issuedAt || 0) || undefined,
      };
    } catch {
      return null;
    }
  }
  // 纯 refresh_token
  const id = deviceIdentity(text);
  return {
    v: 1,
    region: fallbackRegion,
    refreshToken: text,
    machineId: id.machineId,
    deviceId: id.deviceId,
  };
}

export function serializeTraeCredential(cred: TraeCredential): string {
  return JSON.stringify({
    v: 1,
    region: cred.region,
    refresh_token: cred.refreshToken,
    access_token: cred.accessToken || undefined,
    access_expires_at: cred.accessExpiresAt || undefined,
    uid: cred.uid || undefined,
    name: cred.name || undefined,
    machine_id: cred.machineId,
    device_id: cred.deviceId,
    client_id: cred.clientId || undefined,
    issued_at: cred.issuedAt || Date.now(),
  });
}

// =====================================================================
// 授权流程（PKCE + 粘贴回调）
// =====================================================================

const FLOW_PREFIX = "trae:flow:";
const FLOW_TTL = 10 * 60; // 秒
const CALLBACK_PATH = "/authorize";

type TraeFlow = {
  region: TraeRegion;
  verifier: string;
  traceId: string;
  machineId: string;
  deviceId: string;
  callbackUrl: string;
  createdAt: number;
};

function buildCallbackUrl(): string {
  // 官方客户端用随机空闲端口；云端无法监听，端口只需"看起来合法"，用户粘贴整段 URL
  const port = 18080 + Math.floor(Math.random() * 120);
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

/**
 * PKCE：官方客户端用 48 字节随机数（base64url 后 64 字符），
 * 这里逐字节对齐，避免个别网关校验 verifier 长度。
 */
async function createTraePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

/**
 * 生成授权链接。参数顺序与官方客户端一致（部分网关会校验 query 完整性）：
 * login_version / auth_from / login_channel / plugin_version / auth_type /
 * client_id / redirect / login_trace_id / auth_callback_url / machine_id /
 * device_id / x_* / code_challenge / code_challenge_method
 */
export async function buildTraeAuthUrl(
  env: Env,
  baseUrl?: string
): Promise<{ url: string; state: string; region: TraeRegion }> {
  const region = regionFromBaseUrl(baseUrl);
  const ep = traeEndpoints(env, region);
  const pkce = await createTraePkce();
  const state = randomId();
  const traceId = randomId();
  const machineId = randomHex(16);
  const deviceId = randomHex(16);
  const callbackUrl = buildCallbackUrl();

  const q = new URLSearchParams();
  q.set("login_version", "1");
  q.set("auth_from", "trae");
  q.set("login_channel", "native_ide");
  q.set("plugin_version", ep.pluginVersion);
  q.set("auth_type", "local");
  q.set("client_id", ep.clientId);
  q.set("redirect", "0");
  q.set("login_trace_id", traceId);
  q.set("auth_callback_url", callbackUrl);
  q.set("machine_id", machineId);
  q.set("device_id", deviceId);
  q.set("x_device_id", deviceId);
  q.set("x_machine_id", machineId);
  q.set("x_device_brand", "PC");
  q.set("x_device_type", "windows");
  q.set("x_os_version", "Windows 10");
  q.set("x_env", "");
  q.set("x_app_version", ep.ideVersion);
  q.set("x_app_type", "stable");
  q.set("code_challenge", pkce.challenge);
  q.set("code_challenge_method", "S256");

  const flow: TraeFlow = {
    region,
    verifier: pkce.verifier,
    traceId,
    machineId,
    deviceId,
    callbackUrl,
    createdAt: Date.now(),
  };
  await getKV(env)
    .put(FLOW_PREFIX + state, JSON.stringify(flow), { expirationTtl: FLOW_TTL })
    .catch((e) => {
      console.error("[trae] flow store failed", state.slice(0, 8), String(e));
      throw new Error("授权会话写入失败（存储异常），请重试");
    });

  return { url: `${ep.authorizeHost}/authorization?${q.toString()}`, state, region };
}

/** 从粘贴内容里解析回调参数：支持完整 URL、纯 query、JSON、裸 code */
export function parseTraeCallback(input: string): {
  refreshToken?: string;
  authCode?: string;
  accessToken?: string;
  uid?: string;
  name?: string;
  error?: string;
} {
  const text = (input || "").trim();
  if (!text) return {};

  const fromParams = (params: URLSearchParams) => {
    const get = (...keys: string[]) => {
      for (const k of keys) {
        const v = params.get(k);
        if (v) return v;
      }
      return "";
    };
    const out: ReturnType<typeof parseTraeCallback> = {};
    const err = get("error", "error_code", "errorCode");
    if (err) out.error = `${err} ${get("error_description", "errorDescription", "message")}`.trim();
    const refresh = get("refreshToken", "refresh_token", "RefreshToken", "refresh-token");
    if (refresh) out.refreshToken = refresh;
    const code = get("authCode", "auth_code", "AuthCode", "authorization_code", "code");
    if (code) out.authCode = code;
    const token = get("accessToken", "access_token", "Token", "x-cloudide-token", "cloudideToken");
    if (token) out.accessToken = token;

    // authCodeInfo 是 JSON 字符串（含 AuthCode / ExpireAt）
    const info = get("authCodeInfo", "auth_code_info", "AuthCodeInfo");
    if (info) {
      try {
        const j = JSON.parse(info);
        const c = j.AuthCode || j.authCode || j.Code;
        if (c && !out.authCode) out.authCode = String(c);
      } catch {
        /* 非法 JSON 忽略 */
      }
    }
    // userJwt 是 JSON 字符串（含 Token / RefreshToken / TokenExpireAt）
    const jwtRaw = get("userJwt", "user_jwt", "userJWT");
    if (jwtRaw) {
      try {
        const j = JSON.parse(jwtRaw);
        if (!out.accessToken && j.Token) out.accessToken = String(j.Token);
        if (!out.refreshToken && j.RefreshToken) out.refreshToken = String(j.RefreshToken);
      } catch {
        /* 忽略 */
      }
    }
    // userInfo 是 JSON 字符串（含 UserID / ScreenName）
    const userInfo = get("userInfo", "user_info");
    if (userInfo) {
      try {
        const j = JSON.parse(userInfo);
        out.uid = String(j.UserID || j.userId || j.UID || "");
        out.name = String(j.ScreenName || j.screenName || j.Name || "");
      } catch {
        /* 忽略 */
      }
    }
    return out;
  };

  if (text.startsWith("http://") || text.startsWith("https://")) {
    try {
      return fromParams(new URL(text).searchParams);
    } catch {
      return {};
    }
  }
  if (text.startsWith("?")) return fromParams(new URLSearchParams(text.slice(1)));
  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text);
      return {
        refreshToken: j.RefreshToken || j.refreshToken || undefined,
        authCode: j.AuthCode || j.authCode || undefined,
        accessToken: j.Token || j.accessToken || undefined,
        uid: j.UserID || j.uid || undefined,
        name: j.ScreenName || j.screenName || undefined,
      };
    } catch {
      return {};
    }
  }
  // 裸值：Trae 的回调 code 就是 authCode
  return { authCode: text };
}

// =====================================================================
// Token 交换 / 续期
// =====================================================================

function pickString(obj: any, paths: string[][]): string {
  for (const path of paths) {
    let cur: any = obj;
    for (const key of path) {
      if (cur == null || typeof cur !== "object") { cur = null; break; }
      cur = cur[key];
    }
    if (typeof cur === "string" && cur.trim()) return cur.trim();
  }
  return "";
}

function pickNumber(obj: any, paths: string[][]): number {
  for (const path of paths) {
    let cur: any = obj;
    for (const key of path) {
      if (cur == null || typeof cur !== "object") { cur = null; break; }
      cur = cur[key];
    }
    const n = Number(cur);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/** 秒/毫秒归一化 */
function normalizeExpiry(raw: number): number {
  if (!raw) return 0;
  return raw < 1e12 ? raw * 1000 : raw;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
}

/** 依次尝试主选与备选账号主机，只有网络错误/5xx（可选 404）才切换 */
async function postAccountJson(
  ep: TraeEndpoint,
  path: string,
  headers: Record<string, string>,
  body: unknown,
  retryOn404 = false
): Promise<{ res: Response; text: string; host: string }> {
  const hosts = [ep.account, ...ep.accountFallbacks];
  let lastErr = "";
  for (const host of hosts) {
    try {
      const res = await postJson(host + path, headers, body);
      const retryable = res.status >= 500 || (retryOn404 && res.status === 404);
      if (retryable && host !== hosts[hosts.length - 1]) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      return { res, text: await res.text(), host };
    } catch (err) {
      lastErr = (err as Error).message || "network error";
    }
  }
  throw new Error(`账号主机不可用：${lastErr}`);
}

/** P-256 公钥（SPKI PEM），AuthCode 换票的 DeviceInfo 需要 */
async function generateDevicePublicKeyPem(): Promise<string> {
  try {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
    const lines = b64.match(/.{1,64}/g) || [b64];
    return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
  } catch {
    return "";
  }
}

/** 刷新：ExchangeToken(RefreshToken) —— 上游会轮换 refresh_token */
async function refreshTraeToken(
  env: Env,
  cred: TraeCredential
): Promise<{ accessToken: string; expiresIn: number; refreshToken?: string; extra?: Record<string, string> }> {
  const ep = traeEndpoints(env, cred.region);
  const body = {
    ClientID: cred.clientId || ep.clientId,
    RefreshToken: cred.refreshToken,
    ClientSecret: "-",
    UserID: "",
  };
  const { res, text } = await postAccountJson(ep, "/cloudide/api/v3/trae/oauth/ExchangeToken", { "x-cloudide-token": "" }, body);
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Trae refresh_token 已失效 (HTTP ${res.status})，请重新授权`);
  }
  let json: any;
  try { json = JSON.parse(text); } catch { throw new Error(`Trae 换票返回非 JSON: ${text.slice(0, 200)}`); }
  const errCode = json?.code ?? json?.error?.code;
  const token = pickString(json, [
    ["Result", "Token"], ["Result", "AccessToken"], ["Result", "accessToken"],
    ["data", "accessToken"], ["data", "Token"], ["Token"], ["accessToken"], ["token"],
  ]);
  if (!res.ok || !token) {
    const msg = pickString(json, [["message"], ["error", "message"], ["Message"]]) || text.slice(0, 300);
    throw new Error(`Trae 换票失败 HTTP ${res.status}${errCode ? ` code=${errCode}` : ""}: ${msg}`);
  }
  const refresh = pickString(json, [
    ["Result", "RefreshToken"], ["Result", "refreshToken"], ["data", "refreshToken"],
    ["RefreshToken"], ["refreshToken"],
  ]);
  const expiresAt = normalizeExpiry(pickNumber(json, [
    ["Result", "TokenExpireAt"], ["Result", "ExpiresAt"], ["Result", "expiresAt"],
    ["data", "expiresAt"], ["TokenExpireAt"], ["ExpiresAt"], ["expires_at"],
  ]));
  const expiresIn = expiresAt ? Math.max(60, Math.floor((expiresAt - Date.now()) / 1000)) : 12 * 3600;
  return { accessToken: token, expiresIn, refreshToken: refresh || undefined };
}

async function getAccessToken(env: Env, cred: TraeCredential): Promise<string> {
  const cached = await resolveAccessToken(env, "trae:at:", cred.refreshToken, async (token) => {
    const next = { ...cred, refreshToken: token };
    return refreshTraeToken(env, next);
  });
  return cached.accessToken;
}

/**
 * AuthCode 换票（回调只带 authCodeInfo 时使用）。
 * 走 /trae/api/v3/oauth/ExchangeToken，必须带 DeviceInfo（含 P-256 公钥）。
 */
async function exchangeTraeAuthCode(
  env: Env,
  ep: TraeEndpoint,
  flow: TraeFlow | null,
  authCode: string
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
  const machineId = flow?.machineId || randomHex(16);
  const deviceId = flow?.deviceId || randomHex(16);
  const publicKey = await generateDevicePublicKeyPem();
  const body = {
    ClientID: ep.clientId,
    AuthCode: authCode,
    CodeVerifier: flow?.verifier || "",
    DeviceInfo: {
      DeviceID: deviceId,
      MachineID: machineId,
      PlatformCode: "IDE_PC",
      DeviceType: "PC",
      DeviceName: "Trae",
      DeviceModel: "PC",
      ClientVersion: ep.ideVersion,
      DevicePublicKey: publicKey,
      DeviceBrand: "PC",
      DeviceCPU: "",
      OSInfo: "windows",
      OSVersion: "Windows 10",
    },
    IDEVersion: ep.ideVersion,
  };
  const { res, text } = await postAccountJson(ep, "/trae/api/v3/oauth/ExchangeToken", { "x-cloudide-token": "" }, body, true);
  let json: any;
  try { json = JSON.parse(text); } catch { throw new Error(`Trae 授权码换票返回非 JSON: ${text.slice(0, 200)}`); }
  const accessToken = pickString(json, [
    ["Result", "Token"], ["Result", "AccessToken"], ["Result", "accessToken"],
    ["data", "accessToken"], ["Token"], ["accessToken"],
  ]);
  const refreshToken = pickString(json, [
    ["Result", "RefreshToken"], ["Result", "refreshToken"], ["data", "refreshToken"], ["RefreshToken"], ["refreshToken"],
  ]);
  if (!res.ok || !refreshToken) {
    const msg = pickString(json, [["message"], ["error", "message"], ["Message"]]) || text.slice(0, 300);
    throw new Error(`Trae 授权码换票失败 HTTP ${res.status}: ${msg}`);
  }
  const expiresAt = normalizeExpiry(pickNumber(json, [
    ["Result", "TokenExpireAt"], ["Result", "ExpiresAt"], ["data", "expiresAt"], ["TokenExpireAt"], ["ExpiresAt"],
  ]));
  return { accessToken, refreshToken, expiresAt };
}

/** 取账号身份（uid / 昵称），失败不阻断 */
async function fetchTraeUserInfo(
  env: Env,
  ep: TraeEndpoint,
  accessToken: string
): Promise<{ uid: string; name: string }> {
  try {
    const { res, text } = await postAccountJson(ep, "/cloudide/api/v3/trae/GetUserInfo", { "x-cloudide-token": accessToken }, {});
    if (!res.ok) return { uid: "", name: "" };
    const json = JSON.parse(text);
    const uid = pickString(json, [
      ["Result", "UserInfo", "UserID"], ["Result", "UserInfo", "UserId"], ["Result", "UserID"],
      ["Result", "Uid"], ["data", "uid"], ["UserID"], ["uid"],
    ]);
    const name = pickString(json, [
      ["Result", "UserInfo", "ScreenName"], ["Result", "UserInfo", "UserName"], ["Result", "ScreenName"],
      ["data", "name"], ["ScreenName"], ["name"],
    ]);
    return { uid, name };
  } catch {
    return { uid: "", name: "" };
  }
}

/**
 * 完成授权：粘贴回调 URL / query / JSON / 裸 code 都能处理。
 * 返回的 refreshToken 字段实际是**序列化后的凭据 JSON**（与 qoder / zcode 一致），
 * 这样机器指纹、uid、区域能随账号一起入库。
 */
export async function completeTraeOAuth(
  env: Env,
  input: string,
  state: string,
  baseUrl?: string
): Promise<{ refreshToken: string; email?: string; account?: { uid?: string } }> {
  let flow: TraeFlow | null = null;
  try {
    const raw = await getKV(env).get(FLOW_PREFIX + state);
    if (raw) flow = JSON.parse(raw) as TraeFlow;
  } catch {
    /* 流程状态可缺失：回调里带 refreshToken 时无需 verifier */
  }

  const parsed = parseTraeCallback(input);
  if (parsed.error) throw new Error(`Trae 授权失败：${parsed.error}`);
  if (!parsed.refreshToken && !parsed.authCode && !parsed.accessToken) {
    throw new Error("未在粘贴内容中找到 refreshToken / authCode / accessToken，请粘贴浏览器地址栏的完整回调 URL");
  }

  const region = flow?.region || regionFromBaseUrl(baseUrl);
  const ep = traeEndpoints(env, region);

  let refreshToken = parsed.refreshToken || "";
  let accessToken = parsed.accessToken || "";
  let expiresAt = 0;

  if (!refreshToken) {
    if (!parsed.authCode) {
      throw new Error("回调只包含 access_token，缺少 refresh_token；请重新授权并粘贴完整回调 URL");
    }
    const ex = await exchangeTraeAuthCode(env, ep, flow, parsed.authCode);
    refreshToken = ex.refreshToken;
    accessToken = ex.accessToken || accessToken;
    expiresAt = ex.expiresAt;
  } else if (!accessToken) {
    // 只有 refresh_token：换一次票，同时验证凭据有效并拿到轮换后的 refresh_token
    const tmp: TraeCredential = {
      v: 1,
      region,
      refreshToken,
      machineId: flow?.machineId || deviceIdentity(refreshToken).machineId,
      deviceId: flow?.deviceId || deviceIdentity(refreshToken).deviceId,
      clientId: ep.clientId,
    };
    const refreshed = await refreshTraeToken(env, tmp);
    refreshToken = refreshed.refreshToken || refreshToken;
    accessToken = refreshed.accessToken;
    expiresAt = Date.now() + refreshed.expiresIn * 1000;
  }

  const id = deviceIdentity(refreshToken);
  let uid = parsed.uid || "";
  let name = parsed.name || "";
  if (!uid && accessToken) {
    const info = await fetchTraeUserInfo(env, ep, accessToken);
    uid = info.uid;
    name = name || info.name;
  }

  const cred: TraeCredential = {
    v: 1,
    region,
    refreshToken,
    accessToken: accessToken || undefined,
    accessExpiresAt: expiresAt || undefined,
    uid: uid || undefined,
    name: name || undefined,
    machineId: flow?.machineId || id.machineId,
    deviceId: flow?.deviceId || id.deviceId,
    clientId: ep.clientId,
    issuedAt: Date.now(),
  };

  await getKV(env).delete(FLOW_PREFIX + state).catch(() => {});
  return {
    refreshToken: serializeTraeCredential(cred),
    email: name || uid || undefined,
    // 供控制台按 uid 覆盖同一账号的旧凭据，避免重复账号
    account: uid ? { uid } : undefined,
  };
}

// =====================================================================
// 请求头 / 消息体
// =====================================================================

export function traeHeaders(ep: TraeEndpoint, cred: TraeCredential, accessToken: string, stream: boolean): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "X-App-Id": APP_ID,
    "x-plugin-channel": PLUGIN_CHANNEL,
    "x-ide-token": accessToken,
    "x-ide-version": ep.ideVersion,
    "x-ide-version-code": ep.ideVersionCode,
    "x-ide-version-type": "stable",
    "x-app-version": ep.ideVersion,
    "x-app-version-code": ep.ideVersionCode,
    "x-device-id": cred.deviceId,
    "x-machine-id": cred.machineId,
    "x-request-id": randomId(),
    "User-Agent": ep.userAgent,
  };
  if (cred.uid) h["X-Uid"] = cred.uid;
  if (ep.authScheme === "cloudide") {
    // 国内版：Cloud-IDE-JWT 前缀，且 x-ide-token 与 Authorization 必须是同一个 token
    h["Authorization"] = `Cloud-IDE-JWT ${accessToken}`;
    h["Accept"] = stream ? "text/event-stream" : "application/json";
  } else {
    // 国际版：Bearer（用 Cloud-IDE-JWT 会 4015），并且必须带当前客户端版本头
    h["Authorization"] = `Bearer ${accessToken}`;
    h["Accept"] = stream ? "text/event-stream" : "application/json";
    h["Cache-Control"] = "no-cache";
    if (ep.storeCountryCode) h["store-country-code"] = ep.storeCountryCode;
  }
  return h;
}

/** OpenAI messages → Trae parts 数组（content 必须是数组，字符串会 4001） */
export function toTraeMessages(messages: unknown): Array<{ role: string; content: Array<{ type: string; text: string }> }> {
  const rows = Array.isArray(messages) ? messages : [];
  const out: Array<{ role: string; content: Array<{ type: string; text: string }> }> = [];
  for (const m of rows) {
    if (!m || typeof m !== "object") continue;
    const src = m as Record<string, any>;
    const roleRaw = String(src.role || "user").toLowerCase();
    const role = roleRaw === "assistant" || roleRaw === "system" ? roleRaw : roleRaw === "tool" ? "user" : "user";
    const content = src.content;
    const parts: Array<{ type: string; text: string }> = [];
    if (typeof content === "string") {
      parts.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (typeof item === "string") parts.push({ type: "text", text: item });
        else if (item && typeof item === "object") {
          const it = item as Record<string, any>;
          if (it.type === "text" || typeof it.text === "string") {
            parts.push({ type: "text", text: String(it.text ?? "") });
          }
        }
      }
    } else if (content != null) {
      parts.push({ type: "text", text: String(content) });
    }
    // 工具结果 / 图片等非文本 part 目前不做转换：llm_raw_chat 只验证过文本，硬塞会 4001
    if (parts.length === 0) parts.push({ type: "text", text: "" });
    out.push({ role, content: parts });
  }
  return out;
}

export const TRAE_SAMPLING_KEYS = ["temperature", "top_p", "max_tokens", "stop", "presence_penalty", "frequency_penalty"] as const;

export function buildTraeChatBody(body: Record<string, any>, upstreamModel: string, mode: "raw" | "utils"): Record<string, unknown> {
  const base: Record<string, unknown> = {
    model_name: upstreamModel,
    messages: toTraeMessages(body?.messages),
    stream: true,
  };
  for (const key of TRAE_SAMPLING_KEYS) {
    if (body?.[key] !== undefined && body?.[key] !== null) base[key] = body[key];
  }
  if (mode === "utils") {
    // llm_utils_chat 需要 function 与请求标识；config_name 不支持（会 4001）
    base.function = "chat_v3";
    base.model = upstreamModel;
    base.request_id = randomId();
    base.session_id = randomId();
  }
  return base;
}

// =====================================================================
// SSE → OpenAI
// =====================================================================

type TraeUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

type TraeAggregate = {
  content: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage?: TraeUsage;
  finishReason: string;
  error?: { code: string | number; message: string };
  sawOutput: boolean;
};

function newAggregate(): TraeAggregate {
  return { content: "", reasoning: "", toolCalls: [], finishReason: "", sawOutput: false };
}

function mergeToolCalls(target: TraeAggregate["toolCalls"], raw: unknown): void {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const tc = item as Record<string, any>;
    const fn = (tc.function || {}) as Record<string, any>;
    const name = String(fn.name || tc.name || "");
    const argsRaw = fn.arguments ?? tc.arguments ?? "";
    const args = typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw ?? {});
    const id = String(tc.id || "");
    // 上游分片下发：有 index 时按 index 合并，否则按 id/name 合并
    const idx = Number.isInteger(tc.index) ? Number(tc.index) : -1;
    let slot = idx >= 0 ? target[idx] : target.find((t) => (id && t.id === id) || (!id && name && t.name === name));
    if (idx >= 0 && !slot) {
      while (target.length < idx) target.push({ id: "", name: "", arguments: "" });
      slot = { id: "", name: "", arguments: "" };
      target[idx] = slot;
    }
    if (!slot) {
      slot = { id: "", name: "", arguments: "" };
      target.push(slot);
    }
    if (id) slot.id = id;
    if (name) slot.name = name;
    if (args) slot.arguments += args;
  }
}

function applyTraeEvent(agg: TraeAggregate, event: string, data: any): void {
  if (event === "output") {
    agg.sawOutput = true;
    const text = data?.response ?? data?.content ?? data?.text;
    if (typeof text === "string" && text) agg.content += text;
    const reasoning = data?.reasoning_content ?? data?.reasoningContent;
    if (typeof reasoning === "string" && reasoning) agg.reasoning += reasoning;
    if (data?.tool_calls || data?.toolCalls) mergeToolCalls(agg.toolCalls, data.tool_calls ?? data.toolCalls);
    return;
  }
  if (event === "token_usage" || event === "usage") {
    const p = Number(data?.prompt_tokens ?? data?.promptTokens ?? 0) || 0;
    const c = Number(data?.completion_tokens ?? data?.completionTokens ?? 0) || 0;
    const t = Number(data?.total_tokens ?? data?.totalTokens ?? 0) || p + c;
    if (p || c || t) agg.usage = { prompt_tokens: p, completion_tokens: c, total_tokens: t };
    return;
  }
  if (event === "done") {
    agg.finishReason = String(data?.finish_reason || data?.finishReason || "stop");
    return;
  }
  if (event === "error") {
    agg.error = {
      code: data?.code ?? "upstream_error",
      message: String(data?.message || data?.error || "Trae 上游返回错误帧"),
    };
  }
}

/** 解析 SSE 帧（event: X / data: {...}），兼容只有 data 的帧 */
function parseSseFrame(frame: string): { event: string; data: string } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  return { event, data: dataLines.join("\n") };
}

/** 逐事件读取上游 SSE（兼容 \n\n 与 \r\n\r\n 两种帧分隔） */
async function consumeTraeStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (agg: TraeAggregate, event: string, data: any) => void
): Promise<TraeAggregate> {
  const agg = newAggregate();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const SEP = /\r?\n\r?\n/;
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let m = SEP.exec(buffer);
      while (m) {
        const frame = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        const parsed = parseSseFrame(frame);
        if (parsed) {
          if (parsed.data === "[DONE]") {
            agg.finishReason = agg.finishReason || "stop";
          } else {
            try {
              const json = JSON.parse(parsed.data);
              applyTraeEvent(agg, parsed.event, json);
              onEvent(agg, parsed.event, json);
            } catch {
              /* 非 JSON 帧（心跳/调试信息）忽略 */
            }
          }
        }
        m = SEP.exec(buffer);
      }
    }
    // 末尾残帧
    const tail = parseSseFrame(buffer);
    if (tail && tail.data !== "[DONE]") {
      try {
        const json = JSON.parse(tail.data);
        applyTraeEvent(agg, tail.event, json);
        onEvent(agg, tail.event, json);
      } catch { /* ignore */ }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return agg;
}

function openAiChunk(model: string, delta: Record<string, unknown>, finishReason: string | null, usage?: TraeUsage): string {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${randomHex(8)}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

/** 把 Trae 事件流转成标准 OpenAI SSE（chat.ts 的用量旁路只认 OpenAI 格式） */
function traeStreamToOpenAI(body: ReadableStream<Uint8Array>, requestedModel: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let emittedRole = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (s: string) => controller.enqueue(encoder.encode(s));
      try {
        const agg = await consumeTraeStream(body, (state, event, data) => {
          if (event !== "output") return;
          const delta: Record<string, unknown> = {};
          if (!emittedRole) { delta.role = "assistant"; emittedRole = true; }
          const text = data?.response ?? data?.content ?? data?.text;
          if (typeof text === "string" && text) delta.content = text;
          const reasoning = data?.reasoning_content ?? data?.reasoningContent;
          if (typeof reasoning === "string" && reasoning) delta.reasoning_content = reasoning;
          if (data?.tool_calls || data?.toolCalls) {
            const list = (data.tool_calls ?? data.toolCalls) as any[];
            if (Array.isArray(list) && list.length) {
              delta.tool_calls = list.map((tc, i) => ({
                index: Number.isInteger(tc?.index) ? tc.index : i,
                id: tc?.id || undefined,
                type: "function",
                function: {
                  name: tc?.function?.name || tc?.name || undefined,
                  arguments: typeof (tc?.function?.arguments ?? tc?.arguments) === "string"
                    ? (tc.function?.arguments ?? tc.arguments)
                    : JSON.stringify(tc?.function?.arguments ?? tc?.arguments ?? {}),
                },
              }));
            }
          }
          if (Object.keys(delta).length) push(openAiChunk(requestedModel, delta, null));
        });

        if (agg.error && !agg.content) {
          push(`data: ${JSON.stringify({ error: { message: agg.error.message, type: "upstream_error", code: String(agg.error.code) } })}\n\n`);
          push("data: [DONE]\n\n");
          controller.close();
          return;
        }
        const finalUsage: TraeUsage = agg.usage || {
          prompt_tokens: 0,
          completion_tokens: Math.ceil((agg.content.length + agg.reasoning.length) / 4),
          total_tokens: 0,
        };
        finalUsage.total_tokens = finalUsage.total_tokens || finalUsage.prompt_tokens + finalUsage.completion_tokens;
        push(openAiChunk(requestedModel, {}, agg.finishReason || "stop", finalUsage));
        push("data: [DONE]\n\n");
        controller.close();
      } catch (err) {
        try {
          push(`data: ${JSON.stringify({ error: { message: (err as Error).message || "Trae 流解析失败", type: "upstream_error" } })}\n\n`);
          push("data: [DONE]\n\n");
        } catch { /* ignore */ }
        controller.close();
      }
    },
  });
}

// =====================================================================
// 错误码
// =====================================================================

/** Trae 业务错误码 → OpenAI 风格 (HTTP status, type, 提示) */
export function mapTraeErrorCode(
  code: string | number | undefined,
  message: string,
  httpStatus?: number
): { status: number; type: string; message: string } {
  const c = String(code ?? "");
  const msg = message || "";
  if (["1001", "401", "403", "20101", "10101"].includes(c)) {
    return { status: 401, type: "authentication_error", message: `Trae 鉴权失败（code ${c}）：${msg || "access token 失效，请重新授权"}` };
  }
  if (["4001", "400", "2001"].includes(c)) {
    return { status: 400, type: "invalid_request_error", message: `Trae 参数非法（code ${c}）：${msg || "检查 messages parts 数组与 model_name"}` };
  }
  if (["4008", "1005", "4011", "4029"].includes(c)) {
    return { status: 429, type: "quota_exceeded", message: `Trae 额度不足（code ${c}）：${msg || "账号积分/免费额度已用尽"}` };
  }
  if (["4015", "4019"].includes(c)) {
    return { status: 403, type: "risk_control", message: `Trae 上游拒绝（code ${c}）：${msg || "账号风控或模型权限不足"}` };
  }
  if (["4023", "3003"].includes(c)) {
    return { status: 400, type: "model_error", message: `Trae 模型不可用（code ${c}）：${msg || "模型名不在 model_list 中"}` };
  }
  // 没有业务码时按 HTTP 状态兜底，避免把 401/429 一律说成 502
  if (!c && httpStatus && [400, 401, 403, 429].includes(httpStatus)) {
    const type =
      httpStatus === 401 ? "authentication_error"
      : httpStatus === 403 ? "risk_control"
      : httpStatus === 429 ? "quota_exceeded"
      : "invalid_request_error";
    return { status: httpStatus, type, message: `Trae 上游 HTTP ${httpStatus}：${msg || "无错误详情"}` };
  }
  return { status: 502, type: "upstream_error", message: `Trae 上游错误${c ? `（code ${c}）` : ""}：${msg}` };
}

/** 从非 SSE 的错误响应体里提取 code/message */
async function readTraeError(res: Response): Promise<{ code: string; message: string }> {
  const text = await res.text().catch(() => "");
  try {
    const json = JSON.parse(text);
    const code = json?.code ?? json?.error?.code ?? json?.Error?.Code ?? json?.ResponseMetadata?.Error?.Code ?? "";
    const message =
      json?.message || json?.error?.message || json?.Error?.Message || json?.ResponseMetadata?.Error?.Message || text.slice(0, 300);
    return { code: String(code || ""), message: String(message || "").slice(0, 300) };
  } catch {
    return { code: "", message: text.slice(0, 300) };
  }
}

// =====================================================================
// 对话入口
// =====================================================================

async function postTraeChat(
  ep: TraeEndpoint,
  headers: Record<string, string>,
  mode: "raw" | "utils",
  body: Record<string, unknown>
): Promise<Response> {
  const path = mode === "raw" ? "/api/ide/v1/llm_raw_chat" : "/api/agent/v3/llm_utils_chat";
  const hosts = [ep.core, ...ep.coreFallbacks];
  let lastErr = "";
  for (const host of hosts) {
    try {
      const res = await fetch(host + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600000),
      });
      // 只有连不上/网关 5xx 才换主机；业务错误原样交给上层分类
      if (res.status >= 500 && host !== hosts[hosts.length - 1]) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      return res;
    } catch (err) {
      lastErr = (err as Error).message || "network error";
    }
  }
  throw new Error(`Trae 数据面不可用：${lastErr}`);
}

export async function handleTraeRequest(p: OAuthCallParams, baseUrl?: string): Promise<Response> {
  const cred = parseTraeCredential(p.refreshTokens?.[0] || "", baseUrl);
  if (!cred) {
    return oauthErrorResponse(
      "该 Trae 渠道未配置有效凭据：请点「用 Trae 账号授权」完成授权，或粘贴含 refreshToken 的回调 URL",
      400,
      "configuration_error"
    );
  }
  // 渠道 baseUrl 是区域权威来源；凭据里的 region 只作为导入时的补充
  const region = resolveRegion(baseUrl, cred);
  const ep = traeEndpoints(p.env, region);
  const normalized = normalizeTraeModel(p.modelId || "");
  if (normalized.forcedRegion && normalized.forcedRegion !== region) {
    return oauthErrorResponse(
      `模型前缀与本渠道区域不一致：该渠道是${ep.label}，模型 ${p.modelId} 指向${normalized.forcedRegion === "cn" ? "国内版" : "国际版"}。请改走对应区域的渠道`,
      400,
      "invalid_request_error"
    );
  }
  const upstreamModel = normalized.model || p.modelId;
  const stream = p.body?.stream === true;

  let accessToken = "";
  try {
    accessToken = await getAccessToken(p.env, cred);
  } catch (err) {
    return oauthErrorResponse((err as Error).message || "Trae 凭据刷新失败", 401, "authentication_error");
  }
  const headers = traeHeaders(ep, cred, accessToken, true);
  const requestedModel = p.requestedModel;

  let lastError = "";
  let lastStatus = 502;
  // 主通道 llm_raw_chat；失败（404/405 或未知路径）时退到 llm_utils_chat
  for (const mode of ["raw", "utils"] as const) {
    const body = buildTraeChatBody(p.body || {}, upstreamModel, mode);
    let upstream: Response;
    try {
      upstream = await postTraeChat(ep, headers, mode, body);
    } catch (err) {
      lastError = (err as Error).message;
      lastStatus = 502;
      continue;
    }

    if (!upstream.ok) {
      const { code, message } = await readTraeError(upstream);
      const mapped = mapTraeErrorCode(code, message, upstream.status);
      lastStatus = mapped.status;
      lastError = mapped.message;
      // 路径不存在 → 换兼容通道再试；其余业务错误直接上抛
      if ((upstream.status === 404 || upstream.status === 405) && mode === "raw") continue;
      if (mode === "raw" && code === "4001") continue;
      return oauthErrorResponse(mapped.message, mapped.status, mapped.type);
    }

    if (!upstream.body) {
      lastError = "上游无响应体";
      continue;
    }

    if (stream) {
      return new Response(traeStreamToOpenAI(upstream.body, requestedModel), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    }

    // 非流式：上游始终回 SSE，这里聚合后一次性返回
    const agg = await consumeTraeStream(upstream.body, () => {});
    if (agg.error && !agg.content) {
      const mapped = mapTraeErrorCode(agg.error.code, agg.error.message);
      return oauthErrorResponse(mapped.message, mapped.status, mapped.type);
    }
    const usage: TraeUsage = agg.usage || {
      prompt_tokens: 0,
      completion_tokens: Math.ceil((agg.content.length + agg.reasoning.length) / 4),
      total_tokens: 0,
    };
    usage.total_tokens = usage.total_tokens || usage.prompt_tokens + usage.completion_tokens;
    const message: Record<string, unknown> = { role: "assistant", content: agg.content };
    if (agg.reasoning) message.reasoning_content = agg.reasoning;
    if (agg.toolCalls.length) {
      message.tool_calls = agg.toolCalls.map((t, i) => ({
        id: t.id || `call_${i}`,
        type: "function",
        function: { name: t.name, arguments: t.arguments || "{}" },
      }));
    }
    defer(p, recordOAuthUsage(p, { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }, true, 200));
    return new Response(
      JSON.stringify({
        id: `chatcmpl-${randomHex(8)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [{ index: 0, message, finish_reason: agg.finishReason || "stop" }],
        usage,
      }),
      { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
    );
  }

  return oauthErrorResponse(`Trae 所有通道均失败：${lastError || "未知错误"}`, lastStatus, "upstream_error");
}

// =====================================================================
// 模型目录 / 连通性测试
// =====================================================================

/** 解析 model_list 的多种返回形态（Result.ModelList / Data / 裸数组） */
export function parseTraeModelList(json: any): string[] {
  const candidates: any[] = [
    json?.Result?.ModelList,
    json?.Result?.modelList,
    json?.Result?.Models,
    json?.model_list,
    json?.modelList,
    json?.Data,
    json?.data,
    json?.Models,
    json?.models,
  ];
  let rows: any[] = [];
  for (const c of candidates) {
    if (Array.isArray(c)) { rows = c; break; }
    if (c && Array.isArray(c.ModelList)) { rows = c.ModelList; break; }
  }
  if (!rows.length && Array.isArray(json)) rows = json;
  const out: string[] = [];
  for (const r of rows) {
    if (typeof r === "string") { if (r.trim()) out.push(r.trim()); continue; }
    if (!r || typeof r !== "object") continue;
    const name = String(r.name || r.model_name || r.modelName || r.id || r.model || "").trim();
    if (name) out.push(name);
  }
  return [...new Set(out)];
}

export async function fetchTraeModels(
  env: Env,
  refreshToken: string,
  baseUrl?: string
): Promise<{ models: string[]; message?: string }> {
  const cred = parseTraeCredential(refreshToken, baseUrl);
  const region = resolveRegion(baseUrl, cred);
  const ep = traeEndpoints(env, region);
  const fallback = defaultModelsFor(region);
  if (!cred) return { models: fallback, message: "凭据格式无效，已回退内置目录" };

  try {
    const accessToken = await getAccessToken(env, cred);
    const headers = traeHeaders(ep, cred, accessToken, false);
    const res = await fetch(`${ep.core}/api/ide/v1/model_list`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    if (!res.ok) {
      // 国际版固定 403（no schema found），这属于预期行为，不当成错误刷屏
      return {
        models: fallback,
        message:
          region === "global"
            ? "国际版不开放 model_list（403），已使用内置目录；如需新模型请手动添加"
            : `model_list 拉取失败 HTTP ${res.status}，已回退内置目录`,
      };
    }
    const models = parseTraeModelList(JSON.parse(text));
    if (!models.length) return { models: fallback, message: "model_list 为空，已回退内置目录" };
    return { models };
  } catch (err) {
    return { models: fallback, message: `model_list 拉取异常：${(err as Error).message}` };
  }
}

export async function testTrae(
  env: Env,
  refreshToken: string,
  modelId: string,
  baseUrl?: string
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const cred = parseTraeCredential(refreshToken, baseUrl);
  if (!cred) return { success: false, message: "凭据格式无效，请重新授权", statusCode: 0 };
  const region = resolveRegion(baseUrl, cred);
  const ep = traeEndpoints(env, region);
  try {
    const accessToken = await getAccessToken(env, cred);
    const headers = traeHeaders(ep, cred, accessToken, true);
    const model = normalizeTraeModel(modelId || "").model || defaultModelsFor(region)[0]!;
    const res = await postTraeChat(ep, headers, "raw", buildTraeChatBody({ messages: [{ role: "user", content: "hi" }], max_tokens: 16 }, model, "raw"));
    if (!res.ok) {
      const { code, message } = await readTraeError(res);
      const mapped = mapTraeErrorCode(code, message, res.status);
      return { success: false, message: mapped.message, statusCode: mapped.status };
    }
    const agg = await consumeTraeStream(res.body!, () => {});
    if (agg.error && !agg.content) {
      const mapped = mapTraeErrorCode(agg.error.code, agg.error.message);
      return { success: false, message: mapped.message, statusCode: mapped.status };
    }
    if (!agg.content && !agg.toolCalls.length) return { success: false, message: "上游返回空内容", statusCode: 200 };
    return {
      success: true,
      message: agg.content ? `连接成功：${agg.content.slice(0, 60)}` : "连接成功（工具调用）",
      statusCode: 200,
    };
  } catch (err) {
    return { success: false, message: (err as Error).message || "连接失败" };
  }
}

/**
 * 诊断探针：凭据元信息 + 数据面可达性，供后台「探针」按钮使用。
 * 不返回 token，只返回区域、uid、设备指纹前缀与各端点探测结果。
 */
export async function probeTrae(
  env: Env,
  raw: string,
  baseUrl?: string
): Promise<Record<string, unknown>> {
  const cred = parseTraeCredential(raw, baseUrl);
  if (!cred) return { ok: false, message: "凭据无法解析" };
  const region = resolveRegion(baseUrl, cred);
  const ep = traeEndpoints(env, region);
  const out: Record<string, unknown> = {
    ok: true,
    region,
    label: ep.label,
    core: ep.core,
    account: ep.account,
    uid: cred.uid || "",
    name: cred.name || "",
    machine_id_prefix: cred.machineId.slice(0, 8),
    device_id_prefix: cred.deviceId.slice(0, 8),
    refresh_ok: false,
    model_list: null as unknown,
  };
  try {
    await getAccessToken(env, cred);
    out.refresh_ok = true;
  } catch (err) {
    out.refresh_error = (err as Error).message;
    return out;
  }
  try {
    const m = await fetchTraeModels(env, raw, baseUrl);
    out.model_list = { count: m.models.length, message: m.message || "", sample: m.models.slice(0, 5) };
  } catch (err) {
    out.model_list = { error: (err as Error).message };
  }
  return out;
}

/** 供单测覆写用的常量导出 */
export const TRAE_CONSTANTS = { APP_ID, PLUGIN_CHANNEL, CALLBACK_PATH, DEFAULT_ENDPOINTS };
