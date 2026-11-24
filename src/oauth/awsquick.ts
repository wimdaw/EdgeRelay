/**
 * Amazon Quick 渠道（provider.kind = 'oauth:awsquick'）
 *
 * 协议移植自 xiangwen-ctrl/awsquick2api（MIT）：
 *  - 个人账号：Quick 授权发现（quick.aws.com/sn）→ AWS IdC 动态注册公共客户端 → PKCE 换票
 *  - 企业账号：授权发现返回 authEndpoint / tokenEndpoint / clientId，走标准 OAuth 表单换票
 *  - 对话：Amazon Quick AIDP WebSocket（Base64 JSON 出站 + AWS EventStream 入站）
 *
 * 与桌面版不同，云端收不到 127.0.0.1 / localhost 回调，因此采用两段粘贴：
 *  1. 粘贴第一次回调地址（含 nonce）→ 返回第二步 authorize URL
 *  2. 粘贴第二次回调地址（含 code/state）→ 换取凭据
 *
 * v1 不含附件上传、工具桥接、Gateway CBOR 传输与状态化线程复用。
 */
import WebSocket from "ws";
import type { Env } from "../types";
import { getKV } from "../storage/blob-store";
import { resolveAccessToken } from "./common";
import {
  AWSQUICK_DEFAULT_MODELS,
  AWSQUICK_DEFAULT_WSPATH,
  AWSQUICK_MODELS,
  QuickBridgeStream,
  QuickWireDecoder,
  buildQuickToolBridgePrompt,
  buildQuickUserMessageFrame,
  couldBeQuickGuardrailText,
  encodeAidp,
  extractQuickToolDefs,
  flattenQuickPrompt,
  isQuickGuardrailText,
  middleCutUtf8,
  normalizeQuickEffort,
  parseAwsquickCredential,
  parseQuickClientToolCalls,
  parseQuickToolChoice,
  quickSlotLabel,
  randomUuid,
  redactQuickSecrets,
  resolveAwsquickModel,
  type AwsquickCredential,
  type AwsquickProvider,
  type QuickEffort,
  type QuickSlot,
  type QuickToolCall,
} from "./awsquick-wire";

export { AWSQUICK_MODELS, parseAwsquickCredential };

const DISCOVERY_URL = "https://quick.aws.com/sn";
const SOCIAL_DATA_PLANE = "https://cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev";
const APP_VERSION = "1.2.4660";
const SURFACE = "QUICK_WORK_DESKTOP_WINDOWS";
const CALLBACK_PORT = 18080;
const FLOW_TTL = 900;
const FLOW_PREFIX = "awsquick:flow:";
const TOKEN_CACHE_PREFIX = "awsquick:at:";
const TURN_TIMEOUT_MS = 110_000;
const IDLE_TIMEOUT_MS = 60_000;
const COMPLETE_GRACE_MS = 2_500;

const TRUSTED_SUFFIXES = [
  ".amazonaws.com",
  ".amazoncognito.com",
  ".aws.amazon.com",
  ".quick.aws.com",
  ".signin.aws",
  ".awsapps.com",
  ".api.aws",
  ".quicksuite.aws.dev",
  ".plato.ai.aws.dev",
  ".amazon.com",
];
const PLATO_CELL_RE = /^(?:qbs-)?cell[0-9a-f-]+\.dp\.appintegrations\.[a-z]{2}(?:-[a-z]+)+-\d\.(?:prod|beta)\.plato\.ai\.aws\.dev$/;

export class QuickError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 502, code = "upstream_error") {
    super(message);
    this.name = "QuickError";
    this.status = status;
    this.code = code;
  }
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return base64Url(b);
}

async function sha256Bytes(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function assertTrustedUrl(raw: string): URL {
  const text = String(raw || "").trim();
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new QuickError("授权端点格式无效", 400, "invalid_request");
  }
  if (u.protocol !== "https:") throw new QuickError("授权端点必须使用 HTTPS", 400, "invalid_request");
  if (u.port && u.port !== "443") throw new QuickError(`授权端点端口不受支持 (${u.host})`, 400, "invalid_request");
  const host = u.hostname.toLowerCase();
  const ok =
    host === "quick.aws.com" ||
    host === "accounts.google.com" ||
    host === "oauth2.googleapis.com" ||
    PLATO_CELL_RE.test(host) ||
    TRUSTED_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (!ok) throw new QuickError(`授权端点不受支持 (${host})`, 400, "invalid_request");
  return u;
}

function decodeJwt(token?: string): Record<string, any> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, any>;
  } catch {
    return null;
  }
}

function pickString(params: URLSearchParams, ...keys: string[]): string {
  for (const key of keys) {
    const v = String(params.get(key) ?? "").trim();
    if (v) return v;
  }
  return "";
}

type LoginFlow = {
  state: string;
  nonce: string;
  verifier: string;
  port: number;
  stage: string;
  region: string;
  createdAt: number;
  provider?: AwsquickProvider;
  namespace?: string;
  issuerUrl?: string;
  idcRegion?: string;
  tenantUrl?: string;
  authEndpoint?: string;
  tokenEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  resource?: string;
};

async function loadFlow(env: Env, state: string): Promise<LoginFlow | null> {
  const raw = await getKV(env).get(FLOW_PREFIX + state);
  if (!raw) return null;
  try {
    const flow = JSON.parse(raw) as LoginFlow;
    if (!flow?.state || Date.now() - (flow.createdAt || 0) > FLOW_TTL * 1000) return null;
    return flow;
  } catch {
    return null;
  }
}

async function saveFlow(env: Env, flow: LoginFlow): Promise<void> {
  await getKV(env).put(FLOW_PREFIX + flow.state, JSON.stringify(flow), { expirationTtl: FLOW_TTL });
}

/** 发起授权：返回 Quick 授权发现链接 */
export async function startAwsquickFlow(env: Env, baseUrl?: string): Promise<{ url: string; state: string }> {
  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(48);
  const region = "us-east-1";
  const flow: LoginFlow = {
    state,
    nonce,
    verifier,
    port: CALLBACK_PORT,
    stage: "prod",
    region,
    createdAt: Date.now(),
  };
  await saveFlow(env, flow);
  const q = new URLSearchParams({ qwSurface: `desktop:${nonce}:${CALLBACK_PORT}:${APP_VERSION}` });
  return { url: `${DISCOVERY_URL}?${q.toString()}`, state };
}

function parsePastedCallback(input: string): URL {
  const text = String(input || "").trim();
  if (!text) throw new QuickError("请粘贴授权回调地址", 400, "invalid_request");
  if (text.startsWith("http://") || text.startsWith("https://")) return new URL(text);
  if (text.startsWith("?")) return new URL("http://127.0.0.1/oauth/callback" + text);
  return new URL(`http://127.0.0.1/oauth/callback?code=${encodeURIComponent(text)}`);
}

async function postJson(url: string, body: unknown, timeoutMs = 30_000): Promise<Record<string, any>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    throw new QuickError(`请求 ${new URL(url).host} 失败: ${err?.message || err}`, 502, "upstream_error");
  }
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 错误体 */
  }
  if (!res.ok) {
    const code = String(json?.error ?? json?.code ?? "").trim();
    throw new QuickError(`HTTP ${res.status}${code ? ` (${code})` : ""}: ${text.slice(0, 240)}`, res.status || 502, "upstream_error");
  }
  if (!json || typeof json !== "object") throw new QuickError(`上游返回非 JSON: ${text.slice(0, 200)}`, 502, "upstream_error");
  return json as Record<string, any>;
}

async function postForm(url: string, form: Record<string, string>, timeoutMs = 30_000): Promise<Record<string, any>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    throw new QuickError(`请求 ${new URL(url).host} 失败: ${err?.message || err}`, 502, "upstream_error");
  }
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const code = String(json?.error ?? json?.code ?? "").trim();
    throw new QuickError(`HTTP ${res.status}${code ? ` (${code})` : ""}: ${text.slice(0, 240)}`, res.status || 502, "upstream_error");
  }
  if (!json || typeof json !== "object") throw new QuickError(`上游返回非 JSON: ${text.slice(0, 200)}`, 502, "upstream_error");
  return json as Record<string, any>;
}

/** 第一步：处理授权发现回调，返回第二步 authorize URL */
async function processDiscovery(flow: LoginFlow, params: URLSearchParams): Promise<string> {
  const nonce = params.get("nonce") ?? "";
  if (nonce !== flow.nonce) throw new QuickError("授权发现 nonce 校验失败", 400, "invalid_request");
  const err = pickString(params, "error");
  if (err) throw new QuickError(`登录失败: ${err} ${pickString(params, "error_description")}`, 400, "invalid_request");

  const namespace = pickString(params, "namespace");
  if (namespace) {
    // 企业 Gateway 走 CBOR bidi，v1 未移植
    throw new QuickError("该 Amazon Quick 账号属于企业 Gateway 传输（CBOR），当前渠道暂不支持，请使用个人/标准企业账号", 400, "unsupported_transport");
  }

  const issuerUrl = pickString(params, "issuerUrl", "issuer_url", "issuer");
  if (issuerUrl) {
    // 个人 Social IdC：动态注册公共客户端
    const idcRegion = pickString(params, "idcRegion", "idc_region") || flow.region || "us-east-1";
    const tenantUrl = pickString(params, "tenantUrl", "tenant_url");
    if (tenantUrl) assertTrustedUrl(tenantUrl);
    assertTrustedUrl(issuerUrl);
    const redirectUri = `http://127.0.0.1:${flow.port}`;
    const oidcBase = `https://oidc.${idcRegion}.amazonaws.com`;
    const reg = await postJson(`${oidcBase}/client/register`, {
      clientName: "AmazonQuick-Desktop",
      clientType: "public",
      scopes: ["quicksight:read_write"],
      grantTypes: ["authorization_code", "refresh_token"],
      redirectUris: [redirectUri],
      issuerUrl,
    });
    const clientId = String(reg.clientId ?? reg.client_id ?? "").trim();
    const clientSecret = String(reg.clientSecret ?? reg.client_secret ?? "").trim();
    if (!clientId) throw new QuickError("AWS IdC 客户端注册未返回 clientId", 502, "upstream_error");

    const challenge = base64Url(await sha256Bytes(flow.verifier));
    const authorize = new URL(`${oidcBase}/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("scope", "quicksight:read_write");
    authorize.searchParams.set("state", flow.state);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("prompt", "login");

    Object.assign(flow, {
      provider: "social" as AwsquickProvider,
      issuerUrl,
      idcRegion,
      tenantUrl,
      authEndpoint: `${oidcBase}/authorize`,
      tokenEndpoint: `${oidcBase}/token`,
      clientId,
      clientSecret,
      redirectUri,
      resource: "",
    });
    return authorize.toString();
  }

  // 企业 / 标准 OAuth：授权发现直接给出端点
  const authEndpoint = pickString(params, "authEndpoint", "auth_endpoint");
  const tokenEndpoint = pickString(params, "tokenEndpoint", "token_endpoint");
  const tenantUrl = pickString(params, "tenantUrl", "tenant_url");
  const clientId = pickString(params, "clientId", "client_id");
  if (!authEndpoint || !tokenEndpoint) throw new QuickError("授权发现缺少 authEndpoint 或 tokenEndpoint", 400, "invalid_request");
  if (!clientId) throw new QuickError("授权发现缺少 clientId", 400, "invalid_request");
  assertTrustedUrl(authEndpoint);
  assertTrustedUrl(tokenEndpoint);
  if (tenantUrl) assertTrustedUrl(tenantUrl);

  let scope = "openid profile email offline_access";
  try {
    const metaUrl = new URL(authEndpoint);
    const meta = await fetch(`${metaUrl.origin}/.well-known/oauth-authorization-server`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    }).then((r) => (r.ok ? (r.json() as Promise<Record<string, any>>) : null));
    const scopes = Array.isArray(meta?.scopes_supported) ? meta!.scopes_supported.filter((s: any) => typeof s === "string" && s.trim()) : [];
    if (scopes.length && !scopes.includes("openid")) scope = scopes.join(" ");
  } catch {
    /* 元数据探测失败时用默认 scope */
  }

  const clientSecret = pickString(params, "clientSecret", "client_secret");
  const redirectUri = `http://localhost:${flow.port}`;
  const resource = pickString(params, "resource") || (tenantUrl ? new URL(tenantUrl).origin : "");
  const authorize = new URL(authEndpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", scope);
  authorize.searchParams.set("state", flow.state);
  authorize.searchParams.set("code_challenge", base64Url(await sha256Bytes(flow.verifier)));
  authorize.searchParams.set("code_challenge_method", "S256");
  if (clientSecret) {
    authorize.searchParams.set("access_type", "offline");
    authorize.searchParams.set("prompt", "consent");
  }
  if (resource) authorize.searchParams.set("resource", resource);

  Object.assign(flow, {
    provider: "enterprise" as AwsquickProvider,
    tenantUrl,
    authEndpoint,
    tokenEndpoint,
    clientId,
    clientSecret,
    redirectUri,
    resource,
    namespace: "",
  });
  return authorize.toString();
}

function parseTokens(raw: Record<string, any>): { accessToken: string; refreshToken: string; idToken: string; expiresIn: number } {
  const accessToken = String(raw.access_token ?? raw.accessToken ?? "").trim();
  const refreshToken = String(raw.refresh_token ?? raw.refreshToken ?? "").trim();
  const idToken = String(raw.id_token ?? raw.idToken ?? "").trim();
  const expiresIn = Number(raw.expires_in ?? raw.expiresIn ?? 0) || 0;
  return { accessToken, refreshToken, idToken, expiresIn };
}

type UserInfo = { email: string; userName: string; displayName: string; userArn: string; awsAccountId: string; accountName: string };

function normalizeUserInfo(raw: Record<string, any>): UserInfo {
  const src = (raw.userInfo && typeof raw.userInfo === "object" ? raw.userInfo : raw) as Record<string, any>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const v = src[key];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return "";
  };
  return {
    email: pick("email", "emailAddress"),
    userName: pick("userName", "user_name", "username"),
    displayName: pick("displayName", "display_name"),
    userArn: pick("quickSightExternalUserArn", "userArn", "user_arn"),
    awsAccountId: pick("awsAccountId", "aws_account_id", "accountId"),
    accountName: pick("accountName", "account_name"),
  };
}

async function fetchUserInfo(flow: LoginFlow, accessToken: string): Promise<UserInfo> {
  if (!accessToken) throw new QuickError("令牌响应缺少 access_token", 502, "upstream_error");
  const base =
    flow.provider === "enterprise"
      ? String(flow.tenantUrl || "").replace(/\/+$/, "")
      : flow.tenantUrl && flow.tenantUrl.includes("dp.appintegrations")
      ? String(flow.tenantUrl).replace(/\/+$/, "")
      : SOCIAL_DATA_PLANE;
  if (!base) throw new QuickError("授权发现缺少 tenantUrl", 400, "invalid_request");
  assertTrustedUrl(base);

  let res: Response;
  try {
    res = await fetch(`${base}/integration/quick-work/user-info`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err: any) {
    throw new QuickError(`获取用户信息失败: ${err?.message || err}`, 502, "upstream_error");
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new QuickError(`获取用户信息失败 HTTP ${res.status}: ${text.slice(0, 200)}`, 502, "upstream_error");
  let raw: Record<string, any>;
  try {
    raw = JSON.parse(text) as Record<string, any>;
  } catch {
    throw new QuickError(`用户信息非 JSON: ${text.slice(0, 160)}`, 502, "upstream_error");
  }
  return normalizeUserInfo(raw);
}

/** 第二步：处理授权回调 → 换取 tokens → 返回凭据 JSON */
async function exchangeCallback(env: Env, flow: LoginFlow, params: URLSearchParams): Promise<{ refreshToken: string; email?: string; account: { uid: string } }> {
  const err = pickString(params, "error");
  if (err) throw new QuickError(`授权被取消或失败: ${err} ${pickString(params, "error_description")}`, 400, "invalid_request");
  if (!flow.authEndpoint || !flow.tokenEndpoint) throw new QuickError("尚未完成第一步授权发现", 400, "invalid_request");
  const state = params.get("state") ?? "";
  if (state && state !== flow.state) throw new QuickError("OAuth state 校验失败", 400, "invalid_request");
  const code = pickString(params, "code");
  if (!code) throw new QuickError("回调地址缺少 code 参数", 400, "invalid_request");

  let raw: Record<string, any>;
  if (flow.provider === "social") {
    raw = await postJson(flow.tokenEndpoint, {
      clientId: flow.clientId,
      clientSecret: flow.clientSecret,
      grantType: "authorization_code",
      code,
      redirectUri: flow.redirectUri,
      codeVerifier: flow.verifier,
    });
  } else {
    const form: Record<string, string> = {
      grant_type: "authorization_code",
      code,
      redirect_uri: flow.redirectUri || "",
      client_id: flow.clientId || "",
      code_verifier: flow.verifier,
    };
    if (flow.clientSecret) form.client_secret = flow.clientSecret;
    if (flow.resource) form.resource = flow.resource;
    raw = await postForm(flow.tokenEndpoint, form);
  }

  const tokens = parseTokens(raw);
  if (!tokens.accessToken) throw new QuickError("令牌交换未返回 access_token", 502, "upstream_error");

  let info: UserInfo;
  try {
    info = await fetchUserInfo(flow, tokens.accessToken);
  } catch (err: any) {
    // user-info 失败不阻断入库，但要能从 JWT 里补身份
    info = { email: "", userName: "", displayName: "", userArn: "", awsAccountId: "", accountName: "" };
    console.log(`[awsquick] user-info failed: ${err?.message || err}`);
  }

  const claims = decodeJwt(tokens.idToken) || decodeJwt(tokens.accessToken) || {};
  const sub = String(claims.sub ?? "").trim();
  const actorArn = info.userArn || (sub.startsWith("arn:") ? sub : "");
  const email = info.email || String(claims.email ?? "").trim();
  const tenantUrl = flow.tenantUrl || SOCIAL_DATA_PLANE;
  const wsHost = new URL(tenantUrl).host;
  const uid = email || actorArn || info.awsAccountId || randomUuid();
  const expiresAt =
    (tokens.expiresIn > 0 ? Date.now() + tokens.expiresIn * 1000 : 0) ||
    (Number(claims.exp) > 0 ? Number(claims.exp) * 1000 : undefined);

  const cred: AwsquickCredential = {
    v: 1,
    provider: flow.provider || "social",
    stage: flow.stage || "prod",
    region: flow.region || "us-east-1",
    idcRegion: flow.idcRegion,
    tenantUrl,
    wsHost,
    wsPath: AWSQUICK_DEFAULT_WSPATH,
    actorArn,
    deviceId: randomUuid(),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken: tokens.idToken || undefined,
    expiresAt: expiresAt || undefined,
    tokenEndpoint: flow.tokenEndpoint,
    clientId: flow.clientId,
    clientSecret: flow.clientSecret,
    redirectUri: flow.redirectUri,
    resource: flow.resource || undefined,
    issuerUrl: flow.issuerUrl,
    email: email || undefined,
    uid,
    awsAccountId: info.awsAccountId || String(claims.aws_account_id ?? "").trim() || undefined,
    accountName: info.accountName || undefined,
  };

  // 一次性 flow 用后即删
  await getKV(env).delete(FLOW_PREFIX + flow.state).catch(() => {});
  return { refreshToken: JSON.stringify(cred), email: email || undefined, account: { uid } };
}

export type AwsquickCompleteResult =
  | { refreshToken: string; email?: string; account: { uid: string } }
  | { needAuthorizeUrl: true; authorizeUrl: string; state: string };

/** 统一完成入口：第一段回调返回 authorise URL，第二段回调返回凭据 */
export async function completeAwsquickOAuth(env: Env, input: string, state: string): Promise<AwsquickCompleteResult> {
  // 兼容直接粘贴凭据 JSON（迁移/手工导入）
  const direct = parseAwsquickCredential(input);
  if (direct) {
    return { refreshToken: JSON.stringify(direct), email: direct.email, account: { uid: direct.uid } };
  }

  const flow = await loadFlow(env, state);
  if (!flow) throw new QuickError("授权会话不存在或已过期，请重新发起授权", 404, "invalid_request");
  const params = parsePastedCallback(input).searchParams;

  if (params.get("nonce")) {
    const authorizeUrl = await processDiscovery(flow, params);
    await saveFlow(env, flow);
    return { needAuthorizeUrl: true, authorizeUrl, state: flow.state };
  }

  return exchangeCallback(env, flow, params);
}

/** 刷新 access_token（social 走 JSON、enterprise 走表单） */
async function refreshAwsquickToken(cred: AwsquickCredential): Promise<{
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  expiresIn: number;
}> {
  const refreshToken = String(cred.refreshToken || "").trim();
  if (!refreshToken) throw new QuickError("缺少 refresh_token，请重新授权", 401, "invalid_grant");
  const endpoint = String(cred.tokenEndpoint || "").trim();
  if (!endpoint) throw new QuickError("凭据缺少 token_endpoint，请重新授权", 401, "invalid_grant");
  assertTrustedUrl(endpoint);

  let raw: Record<string, any>;
  if (cred.provider === "social") {
    raw = await postJson(endpoint, {
      clientId: cred.clientId,
      clientSecret: cred.clientSecret,
      grantType: "refresh_token",
      refreshToken,
    });
  } else {
    const form: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: cred.clientId || "",
    };
    if (cred.clientSecret) form.client_secret = cred.clientSecret;
    if (cred.resource) form.resource = cred.resource;
    raw = await postForm(endpoint, form);
  }
  const tokens = parseTokens(raw);
  if (!tokens.accessToken) throw new QuickError("令牌刷新响应缺少 access_token", 502, "upstream_error");
  return {
    accessToken: tokens.accessToken,
    idToken: tokens.idToken || undefined,
    refreshToken: tokens.refreshToken || undefined,
    expiresIn: tokens.expiresIn || 3600,
  };
}

/** 取有效 access_token：refresh_token 轮换后写回缓存，避免重放旧 token */
async function resolveQuickAuth(env: Env, raw: string): Promise<{
  cred: AwsquickCredential;
  bearer: string;
  accessToken: string;
}> {
  const cred = parseAwsquickCredential(raw);
  if (!cred) {
    throw new QuickError("该 Amazon Quick 渠道未配置有效凭据：请重新授权（凭据为 JSON，不能只填 refresh_token）", 400, "configuration_error");
  }
  try {
    const cached = await resolveAccessToken(env, TOKEN_CACHE_PREFIX, raw, async () => {
      const refreshed = await refreshAwsquickToken(cred);
      return {
        accessToken: refreshed.accessToken,
        expiresIn: refreshed.expiresIn,
        refreshToken: refreshed.refreshToken,
        extra: refreshed.idToken ? { idToken: refreshed.idToken } : undefined,
      };
    });
    const accessToken = cached.accessToken;
    const idToken = cached.extra?.idToken || cred.idToken;
    const bearer = cred.provider === "enterprise" ? idToken || accessToken : accessToken || idToken || "";
    if (!bearer) throw new QuickError("账号缺少有效访问令牌，请重新授权", 401, "invalid_grant");
    return {
      cred: {
        ...cred,
        accessToken,
        idToken,
        refreshToken: cached.currentRefreshToken || cred.refreshToken,
      },
      bearer,
      accessToken,
    };
  } catch (err: any) {
    // 刷新失败但本地 access_token 尚未过期：先用旧票，避免一次网络抖动把账号下线
    if (cred.accessToken && (!cred.expiresAt || cred.expiresAt - 60_000 > Date.now())) {
      const bearer = cred.provider === "enterprise" ? cred.idToken || cred.accessToken : cred.accessToken;
      return { cred, bearer, accessToken: cred.accessToken };
    }
    throw err;
  }
}

type QuickUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
type TurnResult = { text: string; reasoning: string; usage: QuickUsage };

const QUICK_GUARDRAIL_RETRIES = 2;

/**
 * 执行一次 AIDP 对话，并在 guardrail_blocked 时自动重试。
 * - 只在还没有向客户端输出任何增量时重试，避免重复内容；
 * - 第一次重试保持原文，排除上游偶发误判；
 * - 最后一次重试对 prompt/system 里的凭据做脱敏，降低内容检查命中率。
 */
async function runQuickTurn(
  cred: AwsquickCredential,
  bearer: string,
  opts: {
    prompt: string;
    system: string;
    slot: QuickSlot;
    effort: QuickEffort;
    timeoutMs?: number;
    idleMs?: number;
    onText?: (delta: string) => void;
    onReasoning?: (delta: string) => void;
  }
): Promise<TurnResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= QUICK_GUARDRAIL_RETRIES; attempt++) {
    let emitted = false;
    const redact = attempt === QUICK_GUARDRAIL_RETRIES && attempt > 0;
    const attemptOpts = {
      ...opts,
      prompt: redact ? redactQuickSecrets(opts.prompt) : opts.prompt,
      system: redact ? redactQuickSecrets(opts.system) : opts.system,
      onText: opts.onText
        ? (delta: string) => {
            emitted = true;
            opts.onText?.(delta);
          }
        : undefined,
      onReasoning: opts.onReasoning
        ? (delta: string) => {
            emitted = true;
            opts.onReasoning?.(delta);
          }
        : undefined,
    };
    try {
      return await runQuickTurnOnce(cred, bearer, attemptOpts);
    } catch (err: any) {
      lastErr = err;
      if (err?.code !== "guardrail_blocked" || emitted || attempt === QUICK_GUARDRAIL_RETRIES) throw err;
    }
  }
  throw lastErr;
}

/** 执行一次 AIDP WebSocket 对话（不含护栏重试） */
function runQuickTurnOnce(
  cred: AwsquickCredential,
  bearer: string,
  opts: {
    prompt: string;
    system: string;
    slot: QuickSlot;
    effort: QuickEffort;
    timeoutMs?: number;
    idleMs?: number;
    onText?: (delta: string) => void;
    onReasoning?: (delta: string) => void;
  }
): Promise<TurnResult> {
  const timeoutMs = opts.timeoutMs ?? TURN_TIMEOUT_MS;
  const idleMs = opts.idleMs ?? IDLE_TIMEOUT_MS;
  const host = String(cred.wsHost || "").trim().replace(/\/+$/, "");
  if (!host) return Promise.reject(new QuickError("凭据缺少 wsHost，请重新授权", 400, "configuration_error"));
  const wsBase = /^wss?:\/\//i.test(host) ? host : /^https?:\/\//i.test(host) ? host.replace(/^http/i, "ws") : `wss://${host}`;
  const path = cred.wsPath || AWSQUICK_DEFAULT_WSPATH;
  const target = new URL(path.startsWith("/") ? wsBase + path : `${wsBase}/${path}`);
  const outpostId = cred.deviceId || randomUuid();
  const workingSessionId = randomUuid();
  const threadId = randomUuid();
  target.searchParams.set("surfaceType", SURFACE);
  target.searchParams.set("outpostId", outpostId);
  target.searchParams.set("workingSessionId", workingSessionId);
  if (cred.provider === "social") target.searchParams.set("token", bearer);

  return new Promise<TurnResult>((resolve, reject) => {
    let settled = false;
    let text = "";
    let reasoning = "";
    let pendingText = "";
    let textStarted = false;
    let droppedGuardrailText = false;
    let usage: QuickUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let turnTimer: ReturnType<typeof setTimeout> | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    let completeTimer: ReturnType<typeof setTimeout> | null = null;
    let live = false;
    let completeSeen = false;
    const chunks = new Map<string, { parts: string[]; seen: boolean[]; have: number }>();
    const decoder = new QuickWireDecoder();

    const ws = new WebSocket(target.toString(), {
      headers: {
        Origin: "file://",
        "X-Surface-Type": SURFACE,
        "X-Outpost-Id": outpostId,
        "X-Agent-Service-Type": "UNIFIED_QUICK",
        "X-Working-Session-Id": workingSessionId,
        Authorization: `Bearer ${bearer}`,
      },
      handshakeTimeout: 20_000,
      perMessageDeflate: false,
    });

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (turnTimer) clearTimeout(turnTimer);
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      if (completeTimer) clearTimeout(completeTimer);
      idleTimer = turnTimer = completeTimer = null;
      keepaliveTimer = null;
      try {
        ws.removeAllListeners();
        ws.terminate();
      } catch {
        /* ignore */
      }
    };

    const finish = (err?: Error | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve({ text, reasoning, usage });
    };

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        sendStop();
        finish(new QuickError("Amazon Quick 上游空闲超时", 504, "upstream_timeout"));
      }, idleMs);
    };

    const send = (obj: unknown) => {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeAidp(obj), { binary: true });
      } catch {
        /* ignore */
      }
    };

    const sendStop = () => {
      if (!live) return;
      live = false;
      send({ type: "stop_generation", payload: { thread_id: threadId } });
    };

    const emitText = (delta: string) => {
      if (!delta) return;
      text += delta;
      if (droppedGuardrailText) return;
      if (textStarted) {
        opts.onText?.(delta);
        return;
      }
      // 首次输出先缓冲：Quick 的护栏提示会伪装成普通 text_delta 先到，
      // 识别出来后直接丢弃，让上层按“未输出”处理并重试。
      pendingText += delta;
      if (!pendingText.trim()) return;
      if (couldBeQuickGuardrailText(pendingText)) return;
      if (isQuickGuardrailText(pendingText)) {
        droppedGuardrailText = true;
        pendingText = "";
        return;
      }
      textStarted = true;
      const flush = pendingText;
      pendingText = "";
      opts.onText?.(flush);
    };
    const emitReasoning = (delta: string) => {
      if (!delta) return;
      reasoning += delta;
      opts.onReasoning?.(delta);
    };

    const handleEnvelope = (env: Record<string, any>): boolean => {
      const type = String(env?.type ?? "");
      const payload = (env?.payload && typeof env.payload === "object" ? env.payload : {}) as Record<string, any>;
      switch (type) {
        case "_chunked_frame": {
          const src = Object.keys(payload).length ? payload : env;
          const cid = String(src.chunk_id ?? "");
          const data = String(src.data ?? "");
          const index = Number(src.chunk_index) || 0;
          const total = Number(src.total_chunks) || 0;
          if (!cid || total < 1 || total > 4096 || index < 0 || index >= total) return false;
          let entry = chunks.get(cid);
          if (!entry || entry.parts.length !== total) {
            entry = { parts: new Array(total).fill(""), seen: new Array(total).fill(false), have: 0 };
            chunks.set(cid, entry);
          }
          if (!entry.seen[index]) {
            entry.seen[index] = true;
            entry.have++;
          }
          entry.parts[index] = data;
          if (entry.have < total) return false;
          chunks.delete(cid);
          try {
            return handleEnvelope(JSON.parse(entry.parts.join("")) as Record<string, any>);
          } catch {
            return false;
          }
        }
        case "thinking_delta":
          emitReasoning(extractDelta(payload));
          return false;
        case "text_delta":
          emitText(extractDelta(payload));
          return false;
        case "text_complete":
        case "stream_snapshot": {
          const snap = typeof payload.text === "string" ? payload.text : "";
          if (snap && snap.startsWith(text) && snap.length > text.length) emitText(snap.slice(text.length));
          else if (snap && !text) emitText(snap);
          return false;
        }
        case "turn_usage": {
          const input = Number(payload.input_tokens) || 0;
          const cacheRead = Number(payload.cache_read_tokens) || 0;
          const cacheWrite = Number(payload.cache_write_tokens) || 0;
          if (input || cacheRead || cacheWrite) usage.prompt_tokens = input + cacheRead + cacheWrite;
          usage.completion_tokens += Number(payload.output_tokens) || 0;
          usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
          return false;
        }
        case "message_complete": {
          const continuation = !!payload.continuation_expected;
          if (!continuation) {
            completeSeen = true;
            live = false;
            if (completeTimer) clearTimeout(completeTimer);
            completeTimer = setTimeout(() => finish(null), COMPLETE_GRACE_MS);
          }
          return false;
        }
        case "guardrail_blocked": {
          live = false;
          finish(new QuickError(String(payload.message ?? env.message ?? "Amazon Quick 安全策略拦截了回复"), 400, "guardrail_blocked"));
          return true;
        }
        case "error":
        case "session_error":
        case "stream_error":
        case "turn_failed": {
          live = false;
          const code = String(payload.code ?? payload.error_code ?? env.code ?? "").trim();
          const message = String(payload.message ?? payload.error ?? env.message ?? "unknown upstream error");
          if (code === "FrameTooLarge") finish(new QuickError(message, 400, "context_length_exceeded"));
          else if (code === "ThrottlingException" || code === "rate_limited") finish(new QuickError(message, 429, "rate_limit_exceeded"));
          else finish(new QuickError(`上游 ${type}: ${message}`, 502, "upstream_error"));
          return true;
        }
        case "turn_completed":
        case "turn_aborted":
        case "turn_ended":
        case "stream_ended":
        case "chat_complete":
          live = false;
          finish(null);
          return true;
        default:
          return false;
      }
    };

    const handleFrame = (frame: string) => {
      let env: Record<string, any>;
      try {
        env = JSON.parse(frame) as Record<string, any>;
      } catch {
        return;
      }
      if (!env || typeof env !== "object") return;
      resetIdle();
      if (handleEnvelope(env) && settled) return;
      if (settled) return;
      if (completeSeen && !completeTimer) {
        // 终端事件先把晚到的增量收完
        completeTimer = setTimeout(() => finish(null), COMPLETE_GRACE_MS);
      }
    };

    ws.on("open", () => {
      resetIdle();
      turnTimer = setTimeout(() => {
        sendStop();
        finish(new QuickError("Amazon Quick 上游请求超时", 504, "upstream_timeout"));
      }, timeoutMs);
      send({
        type: "session_connect",
        payload: {
          actor_id: cred.actorArn || "",
          surfaceType: SURFACE,
          outpostId,
          appVersion: APP_VERSION,
          acp_first_text: 1,
          user_notification: 1,
          subtask_progress: 1,
          external_agent_sign_in: 1,
          recents_promotion: 1,
        },
      });
      send({ type: "federate_status", payload: {} });
      send(
        buildQuickUserMessageFrame({
          text: opts.prompt,
          systemPrompt: opts.system,
          slot: opts.slot,
          effort: opts.effort,
          surface: SURFACE,
          outpostId,
          threadId,
          appVersion: APP_VERSION,
          timezone: "UTC",
          locale: "en-US",
        })
      );
      live = true;
      keepaliveTimer = setInterval(() => {
        if (settled) return;
        send({ type: "ping", payload: { timestamp: Date.now() } });
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }, 25_000);
    });

    ws.on("message", (data, isBinary) => {
      try {
        if (!isBinary) {
          const textFrame = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
          if (textFrame.trim().startsWith("{")) handleFrame(textFrame);
          return;
        }
        const frames = decoder.feed(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        for (const frame of frames) {
          handleFrame(frame);
          if (settled) return;
        }
      } catch (err: any) {
        finish(new QuickError(String(err?.message || err), 502, "upstream_error"));
      }
    });

    ws.on("error", (err: Error) => {
      finish(new QuickError(`Amazon Quick WebSocket 连接失败: ${err.message}`, 502, "upstream_error"));
    });

    ws.on("close", (code: number) => {
      if (settled) return;
      if (text || reasoning) finish(null);
      else finish(new QuickError(`Amazon Quick WebSocket 已关闭 (${code})，未返回内容`, 502, "upstream_error"));
    });
  });
}

function extractDelta(payload: any): string {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.delta === "string") return payload.delta;
  if (typeof payload.text === "string") return payload.text;
  return "";
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function errorResponse(message: string, status = 502, type = "upstream_error"): Response {
  return jsonResponse({ error: { message, type, code: type } }, status);
}

export type AwsquickChatParams = {
  env: Env;
  providerId: string;
  baseUrl: string;
  upstreamModel: string;
  requestedModel: string;
  body: Record<string, any>;
  refreshToken: string;
};

/** 对话入口：OpenAI 兼容 JSON / SSE */
export async function handleAwsquickRequest(p: AwsquickChatParams): Promise<Response> {
  let auth: Awaited<ReturnType<typeof resolveQuickAuth>>;
  try {
    auth = await resolveQuickAuth(p.env, p.refreshToken);
  } catch (err: any) {
    return errorResponse(err?.message || "Amazon Quick 凭据无效", err?.status || 401, err?.code || "configuration_error");
  }

  const messages = Array.isArray(p.body?.messages) ? p.body.messages : [];
  const flat = flattenQuickPrompt(messages);
  if (!flat.prompt.trim()) return errorResponse("messages 不能为空", 400, "invalid_request");
  const resolved = resolveAwsquickModel(p.upstreamModel || p.requestedModel);
  const effort = normalizeQuickEffort(p.body?.reasoning_effort ?? p.body?.reasoning?.effort ?? resolved.effort);
  const toolDefs = extractQuickToolDefs(p.body?.tools, p.body?.functions);
  const toolChoice = parseQuickToolChoice(p.body?.tool_choice ?? p.body?.function_call);
  const parallelToolCalls = p.body?.parallel_tool_calls !== false;
  const allowedTools = new Set(toolDefs.map((d) => d.name));
  if (toolChoice.mode === "function" && toolChoice.name) allowedTools.add(toolChoice.name);
  const bridgeEnabled = toolChoice.mode !== "none" && toolDefs.length > 0;
  const bridgePrompt = bridgeEnabled ? buildQuickToolBridgePrompt(toolDefs, toolChoice, parallelToolCalls) : "";
  const systemBase = middleCutUtf8(flat.system, 8_000);
  const system = middleCutUtf8([systemBase, bridgePrompt].filter(Boolean).join("\n\n"), 30_000);
  const promptBudget = Math.max(4_000, 58_000 - Buffer.byteLength(system, "utf8"));
  const prompt = middleCutUtf8(flat.prompt, promptBudget);
  const wantStream = p.body?.stream === true;
  const id = `chatcmpl-${randomUuid().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  try {
    if (!wantStream) {
      const result = await runQuickTurn(auth.cred, auth.bearer, {
        prompt,
        system,
        slot: resolved.slot,
        effort,
      });
      let finalText = result.text;
      let calls: QuickToolCall[] = [];
      if (bridgeEnabled) {
        const parsed = parseQuickClientToolCalls(result.text, allowedTools);
        finalText = parsed.text;
        calls = parsed.calls;
        if (!parallelToolCalls && calls.length > 1) calls = calls.slice(0, 1);
      }
      if (!finalText && !result.reasoning && !calls.length) {
        throw new QuickError("Amazon Quick 未返回文本", 502, "empty_response");
      }
      return jsonResponse({
        id,
        object: "chat.completion",
        created,
        model: p.requestedModel,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: calls.length ? finalText || null : finalText,
              ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
              ...(calls.length
                ? {
                    tool_calls: calls.map((c) => ({
                      id: c.id,
                      type: "function",
                      function: { name: c.name, arguments: c.arguments },
                    })),
                  }
                : {}),
            },
            finish_reason: calls.length ? "tool_calls" : "stop",
          },
        ],
        usage: result.usage,
      });
    }

    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const push = (text: string) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(text));
          } catch {
            closed = true;
          }
        };
        const chunk = (delta: Record<string, any>, finishReason: string | null = null) => {
          push(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: p.requestedModel,
              choices: [{ index: 0, delta, finish_reason: finishReason }],
            })}\n\n`
          );
        };
        const bridge = bridgeEnabled
          ? new QuickBridgeStream(allowedTools, (text) => chunk({ content: text }))
          : null;
        chunk({ role: "assistant" });
        runQuickTurn(auth.cred, auth.bearer, {
          prompt,
          system,
          slot: resolved.slot,
          effort,
          onText: (delta) => (bridge ? bridge.push(delta) : chunk({ content: delta })),
          onReasoning: (delta) => chunk({ reasoning_content: delta }),
        })
          .then((result) => {
            let calls = bridge ? bridge.finish() : [];
            if (!parallelToolCalls && calls.length > 1) calls = calls.slice(0, 1);
            if (calls.length) {
              for (let i = 0; i < calls.length; i++) {
                const call = calls[i]!;
                chunk({
                  tool_calls: [
                    {
                      index: i,
                      id: call.id,
                      type: "function",
                      function: { name: call.name, arguments: call.arguments },
                    },
                  ],
                });
              }
              chunk({}, "tool_calls");
              push(
                `data: ${JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: p.requestedModel,
                  choices: [],
                  usage: result.usage,
                })}\n\n`
              );
            } else if (!result.text && !result.reasoning) {
              push(`data: ${JSON.stringify({ error: { message: "Amazon Quick 未返回文本", type: "upstream_error", code: "empty_response" } })}\n\n`);
            } else {
              chunk({}, "stop");
              push(
                `data: ${JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: p.requestedModel,
                  choices: [],
                  usage: result.usage,
                })}\n\n`
              );
            }
            push("data: [DONE]\n\n");
            closed = true;
            try {
              controller.close();
            } catch {
              /* ignore */
            }
          })
          .catch((err: any) => {
            push(
              `data: ${JSON.stringify({
                error: { message: String(err?.message || err), type: err?.code || "upstream_error", code: err?.code || "upstream_error" },
              })}\n\n`
            );
            push("data: [DONE]\n\n");
            closed = true;
            try {
              controller.close();
            } catch {
              /* ignore */
            }
          });
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (err: any) {
    return errorResponse(err?.message || "Amazon Quick 请求失败", err?.status || 502, err?.code || "upstream_error");
  }
}

/** 单账号连通性测试 */
export async function testAwsquick(
  env: Env,
  raw: string,
  modelId: string,
  _baseUrl?: string
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  try {
    const auth = await resolveQuickAuth(env, raw);
    const resolved = resolveAwsquickModel(modelId || "amazon-fast");
    const result = await runQuickTurn(auth.cred, auth.bearer, {
      prompt: "Reply with OK only.",
      system: "",
      slot: resolved.slot,
      effort: "off",
      timeoutMs: 45_000,
      idleMs: 30_000,
    });
    if (result.text.trim()) return { success: true, message: `连接成功（${result.text.trim().slice(0, 40)}）` };
    return { success: false, message: "上游未返回文本" };
  } catch (err: any) {
    return { success: false, message: err?.message || "连接失败", statusCode: err?.status };
  }
}

/** 上游没有公开模型目录，使用官方档位清单 */
export async function fetchAwsquickModels(_env: Env, _raw: string): Promise<{ success: boolean; models: string[]; message?: string }> {
  return { success: true, models: AWSQUICK_DEFAULT_MODELS };
}

/** 管理端账号身份（按邮箱 / Actor ARN 去重） */
export function awsquickIdentity(raw: string): string {
  const cred = parseAwsquickCredential(raw);
  return cred?.uid || cred?.email || cred?.actorArn || "";
}

export function awsquickModelSlot(modelId: string): QuickSlot {
  return resolveAwsquickModel(modelId).slot;
}

export function awsquickModelLabel(modelId: string): string {
  return quickSlotLabel(resolveAwsquickModel(modelId).slot);
}
