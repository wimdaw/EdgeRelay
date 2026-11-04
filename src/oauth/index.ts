/**
 * OAuth 渠道注册表与统一入口
 *
 * 全部实现移植自 CLIProxyAPI（经 ai-gateway-edgeone 的 OAuth 反代模块）：
 *  - claude / codex / antigravity：PKCE + loopback 回调，用户粘贴 code 完成授权
 *  - kimi / qwen / grok / cline：RFC 8628 设备码授权，前端轮询换取 refresh_token
 *  - codebuddy：服务端签发 state + 授权链接，浏览器登录后前端轮询换取 refresh_token
 *
 * 凭据（refresh_token）沿用渠道的 Key 池加密存储（AES-256-GCM），
 * access_token 由 common.resolveAccessToken 缓存并自动续期。
 */
import type { Env } from "../types";
import type { OAuthCallParams } from "./common";
import { buildClaudeAuthUrl, exchangeClaudeCode, testClaude, fetchClaudeModels, handleClaudeRequest } from "./claude";
import { buildCodexAuthUrl, exchangeCodexCode, testCodex, handleCodexRequest } from "./codex";
import {
  buildAntigravityAuthUrl,
  exchangeAntigravityCode,
  testAntigravity,
  fetchAntigravityModels,
  handleAntigravityRequest,
} from "./antigravity";
import {
  startKimiDeviceFlow,
  pollKimiDeviceFlow,
  testKimi,
  fetchKimiModels,
  handleKimiRequest,
} from "./kimi";
import { startQwenDeviceFlow, pollQwenDeviceFlow, testQwen, fetchQwenModels, handleQwenRequest } from "./qwen";
import { startGrokDeviceFlow, pollGrokDeviceFlow, testGrok, handleGrokRequest } from "./grok";
import {
  startCodebuddyDeviceFlow,
  pollCodebuddyDeviceFlow,
  testCodebuddy,
  fetchCodebuddyModels,
  handleCodebuddyRequest,
} from "./codebuddy";
import { startClineDeviceFlow, pollClineDeviceFlow, testCline, fetchClineModels, handleClineRequest, CLINE_BUILTIN_MODELS } from "./cline";

export type OAuthProviderType = "claude" | "codex" | "antigravity" | "kimi" | "qwen" | "grok" | "codebuddy" | "cline";

export type OAuthProviderMeta = {
  type: OAuthProviderType;
  /** 前端显示名 */
  name: string;
  /** 默认渠道标识 */
  slug: string;
  /** 默认上游基址 */
  baseUrl: string;
  /** 授权模式：redirect = 粘贴 code；device = 设备码轮询；redirect-poll = 授权链接 + 轮询 */
  mode: "redirect" | "device" | "redirect-poll";
  /** 是否需要在授权前选择区域（CodeBuddy 国内版/国际版） */
  regionSelect?: boolean;
  /** 一句话说明 */
  desc: string;
  /** 渠道未配置模型时的兜底模型清单 */
  defaultModels: string[];
};

export const OAUTH_PROVIDERS: Record<OAuthProviderType, OAuthProviderMeta> = {
  claude: {
    type: "claude",
    name: "Claude (Anthropic)",
    slug: "claude-oauth",
    baseUrl: "https://api.anthropic.com",
    mode: "redirect",
    desc: "使用 Claude 账号授权（Claude Code OAuth），请求自动翻译为 Anthropic Messages 协议。",
    defaultModels: ["claude-sonnet-4-5-20250929", "claude-opus-4-5-20251101", "claude-haiku-4-5-20251001"],
  },
  codex: {
    type: "codex",
    name: "ChatGPT (Codex)",
    slug: "codex-oauth",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    mode: "redirect",
    desc: "使用 ChatGPT 账号授权（Codex CLI OAuth），请求翻译为 Responses 协议。",
    defaultModels: ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "codex-mini-latest"],
  },
  antigravity: {
    type: "antigravity",
    name: "Antigravity (Google)",
    slug: "antigravity-oauth",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    mode: "redirect",
    desc: "使用 Google 账号授权（Antigravity 客户端 OAuth），请求自动翻译为 Gemini 协议。",
    defaultModels: ["gemini-3.7-flash", "gemini-3.1-pro", "gemini-3.5-flash"],
  },
  kimi: {
    type: "kimi",
    name: "Kimi (Moonshot)",
    slug: "kimi-oauth",
    baseUrl: "https://api.kimi.ai/coding",
    mode: "device",
    desc: "使用 Kimi 账号设备码授权，OpenAI 兼容协议直通（国际站/中国站按 Base URL 自动识别）。",
    defaultModels: ["kimi-for-coding", "kimi-for-coding-highspeed"],
  },
  qwen: {
    type: "qwen",
    name: "Qwen (通义千问)",
    slug: "qwen-oauth",
    baseUrl: "https://portal.qwen.ai/v1",
    mode: "device",
    desc: "使用 Qwen 账号设备码授权，OpenAI 兼容协议直通。",
    defaultModels: ["coder-model", "qwen3-coder-plus", "qwen3-coder-flash", "vision-model"],
  },
  grok: {
    type: "grok",
    name: "Grok (xAI)",
    slug: "grok-oauth",
    baseUrl: "https://cli-chat-proxy.grok.com/v1",
    mode: "device",
    desc: "使用 xAI 账号设备码授权，请求自动翻译为 Responses 协议。",
    defaultModels: ["grok-4.6", "grok-4.5", "grok-code-fast-1"],
  },
  codebuddy: {
    type: "codebuddy",
    name: "CodeBuddy (腾讯)",
    slug: "codebuddy-oauth",
    baseUrl: "https://copilot.tencent.com",
    mode: "redirect-poll",
    regionSelect: true,
    desc: "腾讯 CodeBuddy / WorkBuddy 账号授权（国内版/国际版双域），OpenAI 兼容协议直通。",
    defaultModels: ["deepseek-v4.1-flash"],
  },
  cline: {
    type: "cline",
    name: "Cline",
    slug: "cline-oauth",
    baseUrl: "https://api.cline.bot",
    mode: "device",
    desc: "Cline 账号 WorkOS 设备码授权，自动适配免费通道与「账号×模型」冷却。",
    defaultModels: CLINE_BUILTIN_MODELS.slice(0, 6),
  },
};

export const OAUTH_KIND_PREFIX = "oauth:";

/** kind -> provider 类型（非 OAuth 渠道返回 null） */
export function parseOAuthKind(kind?: string | null): OAuthProviderType | null {
  if (!kind || !kind.startsWith(OAUTH_KIND_PREFIX)) return null;
  const type = kind.slice(OAUTH_KIND_PREFIX.length) as OAuthProviderType;
  return OAUTH_PROVIDERS[type] ? type : null;
}

export function isOAuthType(value: string): value is OAuthProviderType {
  return !!OAUTH_PROVIDERS[value as OAuthProviderType];
}

export type OAuthStartResult =
  | { mode: "redirect"; url: string; state: string }
  | { mode: "redirect-poll"; url: string; state: string; realm?: string }
  | { mode: "device"; state: string; verification_uri: string; verification_uri_complete?: string; user_code: string; interval: number; expires_in?: number };

/** 发起授权：redirect 返回授权链接，device 返回设备码信息 */
export async function startOAuth(env: Env, type: OAuthProviderType, baseUrl?: string): Promise<OAuthStartResult> {
  if (type === "claude") {
    const { url, state } = await buildClaudeAuthUrl(env);
    return { mode: "redirect", url, state };
  }
  if (type === "codex") {
    const { url, state } = await buildCodexAuthUrl(env);
    return { mode: "redirect", url, state };
  }
  if (type === "antigravity") {
    const { url, state } = await buildAntigravityAuthUrl(env);
    return { mode: "redirect", url, state };
  }
  if (type === "codebuddy") {
    const flow = await startCodebuddyDeviceFlow(env, baseUrl);
    return { mode: "redirect-poll", url: flow.authUrl, state: flow.state, realm: flow.realm };
  }
  const flow =
    type === "kimi"
      ? await startKimiDeviceFlow(env, baseUrl)
      : type === "qwen"
      ? await startQwenDeviceFlow(env)
      : type === "cline"
      ? await startClineDeviceFlow(env)
      : await startGrokDeviceFlow(env);
  return {
    mode: "device",
    state: flow.state,
    verification_uri: flow.verificationUri,
    verification_uri_complete: flow.verificationUriComplete,
    user_code: flow.userCode,
    interval: flow.interval,
    expires_in: flow.expiresIn,
  };
}

/** redirect 模式：用 code + state 换取 refresh_token */
export async function completeOAuth(env: Env, type: OAuthProviderType, code: string, state: string): Promise<{ refreshToken: string }> {
  if (type === "claude") {
    const { refreshToken } = await exchangeClaudeCode(env, code, state);
    return { refreshToken };
  }
  if (type === "codex") {
    const { refreshToken } = await exchangeCodexCode(env, code, state);
    return { refreshToken };
  }
  if (type === "antigravity") {
    return exchangeAntigravityCode(env, code, state);
  }
  throw new Error(`${type} 渠道使用设备码/授权链接轮询，请使用轮询接口`);
}

export type OAuthPollResult = {
  status: "pending" | "ok" | "error";
  message?: string;
  refreshToken?: string;
  /** Cline 授权返回的账号邮箱 */
  email?: string;
  /** CodeBuddy 授权返回的账号信息 */
  account?: { uid?: string; enterpriseId?: string; nickname?: string; domain?: string };
};

/** 设备码 / 授权链接模式：轮询授权状态 */
export async function pollOAuth(env: Env, type: OAuthProviderType, state: string): Promise<OAuthPollResult> {
  if (type === "kimi") return pollKimiDeviceFlow(env, state);
  if (type === "qwen") return pollQwenDeviceFlow(env, state);
  if (type === "grok") return pollGrokDeviceFlow(env, state);
  if (type === "codebuddy") return pollCodebuddyDeviceFlow(env, state);
  if (type === "cline") {
    const r = await pollClineDeviceFlow(env, state);
    return { status: r.status, message: r.message, refreshToken: r.refreshToken, email: r.email };
  }
  throw new Error(`${type} 渠道使用授权链接，请使用 complete 接口`);
}

/** 拉取可用模型（失败时回退内置清单） */
export async function fetchOAuthModels(
  env: Env,
  type: OAuthProviderType,
  refreshToken: string,
  baseUrl?: string
): Promise<{ models: string[]; message?: string }> {
  const fallback = OAUTH_PROVIDERS[type].defaultModels;
  try {
    if (type === "claude") {
      const r = await fetchClaudeModels(env, refreshToken);
      return r.success && r.models.length ? { models: r.models } : { models: fallback, message: r.message };
    }
    if (type === "antigravity") {
      const r = await fetchAntigravityModels(env, refreshToken);
      return r.success && r.models.length ? { models: r.models } : { models: fallback, message: r.message };
    }
    if (type === "kimi") {
      const r = await fetchKimiModels(env, refreshToken, baseUrl);
      return r.success && r.models.length ? { models: r.models } : { models: fallback, message: r.message };
    }
    if (type === "qwen") {
      return { models: fetchQwenModels().models };
    }
    if (type === "codebuddy") {
      const r = await fetchCodebuddyModels(env, refreshToken, baseUrl);
      return r.success && r.models.length ? { models: r.models } : { models: fallback, message: r.message };
    }
    if (type === "cline") {
      const r = await fetchClineModels(env, refreshToken);
      return r.success && r.models.length ? { models: r.models } : { models: fallback, message: r.message };
    }
  } catch (err: any) {
    return { models: fallback, message: err?.message || String(err) };
  }
  return { models: fallback };
}

/** 单账号连通性测试 */
export async function testOAuth(
  env: Env,
  type: OAuthProviderType,
  refreshToken: string,
  modelId: string,
  baseUrl?: string
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  if (type === "claude") return testClaude(env, refreshToken, modelId);
  if (type === "codex") return testCodex(env, refreshToken, modelId);
  if (type === "antigravity") return testAntigravity(env, refreshToken, modelId);
  if (type === "kimi") return testKimi(env, refreshToken, modelId, baseUrl);
  if (type === "qwen") return testQwen(env, refreshToken, modelId);
  if (type === "codebuddy") return testCodebuddy(env, refreshToken, modelId, baseUrl);
  if (type === "cline") return testCline(env, refreshToken, modelId);
  return testGrok(env, refreshToken, modelId);
}

export type OAuthChatArgs = {
  env: Env;
  type: OAuthProviderType;
  providerId: string;
  baseUrl: string;
  /** 上游真实模型 ID */
  upstreamModel: string;
  /** 对外模型名（回填响应体） */
  requestedModel: string;
  body: Record<string, any>;
  refreshToken: string;
};

/** 对话入口：返回 OpenAI 兼容 JSON 或 SSE（用量由 chat.ts 统一结算） */
export async function handleOAuthChat(args: OAuthChatArgs): Promise<Response> {
  const p: OAuthCallParams = {
    env: args.env,
    providerId: args.providerId,
    modelId: args.upstreamModel,
    requestedModel: args.requestedModel,
    body: { ...args.body, model: args.upstreamModel },
    refreshTokens: [args.refreshToken],
    maskedToken: "",
    startedAt: Date.now(),
  };

  switch (args.type) {
    case "claude":
      return handleClaudeRequest(p, "");
    case "codex":
      return handleCodexRequest(p, "");
    case "antigravity":
      return handleAntigravityRequest({ ...p, project: undefined });
    case "kimi":
      return handleKimiRequest(p, args.baseUrl);
    case "qwen":
      return handleQwenRequest(p);
    case "grok":
      return handleGrokRequest(p, "");
    case "codebuddy":
      return handleCodebuddyRequest(p, args.baseUrl);
    case "cline":
      return handleClineRequest(p);
    default:
      return new Response(JSON.stringify({ error: { message: `未知 OAuth 渠道: ${args.type}` } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
  }
}
