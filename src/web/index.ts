/**
 * Web 反代渠道注册表与统一入口
 *
 * 这些渠道没有官方 OAuth：凭据需要用户从浏览器网页会话中复制（Cookie / JWT / refresh_token），
 * 实现均移植自 ai-gateway-edgeone 的网页反代模块：
 *  - deepseek：网页 userToken + PoW 解算
 *  - kimiweb：Kimi 网页 Connect-RPC 协议
 *  - geminiweb：Gemini 网页 Cookie + SAPISIDHASH
 *  - minimaxweb：MiniMax Agent 网页 SSE
 *  - lingxi：中国移动灵犀网页 Basic 鉴权
 *  - chatgptweb：ChatGPT 网页 sentinel/PoW 协议
 *
 * 凭据沿用渠道 Key 池加密存储（AES-256-GCM），多账号自动轮换。
 */
import type { Env } from "../types";
import type { OAuthCallParams } from "../oauth/common";
import { handleDeepSeekRequest, fetchDeepSeekModels, DEEPSEEK_DEFAULT_MODELS } from "./deepseek";
import { handleKimiWebRequest, fetchKimiWebModels, KIMI_WEB_FALLBACK_MODELS } from "./kimiweb";
import { handleGeminiWebRequest, listGeminiWebModels, GEMINI_WEB_MODELS } from "./geminiweb";
import { handleMiniMaxWebRequest, listMiniMaxWebModels, MINIMAX_WEB_MODELS } from "./minimaxweb";
import { handleLingxiRequest, listLingxiModels, LINGXI_MODELS } from "./lingxiweb";
import { handleChatgptWebRequest, listChatgptWebModels } from "./chatgptweb";

export type WebProviderType = "deepseek" | "kimiweb" | "geminiweb" | "minimaxweb" | "lingxi" | "chatgptweb";

export type WebProviderMeta = {
  type: WebProviderType;
  name: string;
  slug: string;
  baseUrl: string;
  desc: string;
  /** 凭据格式说明（前端弹窗提示） */
  credHint: string;
  defaultModels: string[];
};

export const WEB_PROVIDERS: Record<WebProviderType, WebProviderMeta> = {
  deepseek: {
    type: "deepseek",
    name: "DeepSeek 网页版",
    slug: "deepseek-web",
    baseUrl: "https://chat.deepseek.com/api/v0",
    desc: "网页 userToken 反代，自动解 PoW；凭据约 24h 有效，失效后需重新复制。",
    credHint: "userToken（chat.deepseek.com 登录后 localStorage 里的 JWT）或官方 API Key（sk- 开头）",
    defaultModels: DEEPSEEK_DEFAULT_MODELS,
  },
  kimiweb: {
    type: "kimiweb",
    name: "Kimi 网页版",
    slug: "kimi-web",
    baseUrl: "https://www.kimi.ai",
    desc: "Kimi 网页 Connect-RPC 协议反代，refresh_token 自动续期。",
    credHint: "access_token(JWT) 或 refresh_token（www.kimi.ai 登录后 Local Storage）",
    defaultModels: KIMI_WEB_FALLBACK_MODELS,
  },
  geminiweb: {
    type: "geminiweb",
    name: "Gemini 网页版",
    slug: "gemini-web",
    baseUrl: "https://gemini.google.com",
    desc: "Gemini 网页 Cookie 反代（SAPISIDHASH 鉴权）；留空凭据可走匿名模式。",
    credHint: "Cookie 字符串（含 __Secure-1PSID / __Secure-3PSID / SAPISID）",
    defaultModels: Object.keys(GEMINI_WEB_MODELS),
  },
  minimaxweb: {
    type: "minimaxweb",
    name: "MiniMax Agent 网页版",
    slug: "minimax-web",
    baseUrl: "https://agent.minimaxi.com",
    desc: "MiniMax Agent 网页 SSE 反代，需要网页会话签名参数。",
    credHint: "token|agentId|uuid|deviceId|userId（token 为 JWT，其余可从 HAR 取；至少填 token）",
    defaultModels: MINIMAX_WEB_MODELS,
  },
  lingxi: {
    type: "lingxi",
    name: "灵犀网页版（中国移动）",
    slug: "lingxi-web",
    baseUrl: "https://ai.yun.139.com",
    desc: "中国移动灵犀网页反代，Basic 授权 + userId。",
    credHint: "authorization|userId|sourceChannel（authorization 形如 Basic xxx；sourceChannel 默认 10175）",
    defaultModels: LINGXI_MODELS,
  },
  chatgptweb: {
    type: "chatgptweb",
    name: "ChatGPT 网页版",
    slug: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    desc: "ChatGPT 网页/App 协议反代（sentinel + PoW），适合 Free 账号。",
    credHint: "refresh_token（rt_xxx / rt.1.xxx；也支持发货整行，自动提取最后一段）",
    defaultModels: listChatgptWebModels().models,
  },
};

export const WEB_KIND_PREFIX = "web:";

export function parseWebKind(kind?: string | null): WebProviderType | null {
  if (!kind || !kind.startsWith(WEB_KIND_PREFIX)) return null;
  const type = kind.slice(WEB_KIND_PREFIX.length) as WebProviderType;
  return WEB_PROVIDERS[type] ? type : null;
}

export function isWebType(value: string): value is WebProviderType {
  return !!WEB_PROVIDERS[value as WebProviderType];
}

export type WebChatArgs = {
  env: Env;
  type: WebProviderType;
  providerId: string;
  baseUrl: string;
  upstreamModel: string;
  requestedModel: string;
  body: Record<string, any>;
  credential: string;
};

/** 对话入口：返回 OpenAI 兼容 JSON 或 SSE（用量由 chat.ts 统一结算） */
export async function handleWebChat(args: WebChatArgs): Promise<Response> {
  const p: OAuthCallParams = {
    env: args.env,
    providerId: args.providerId,
    modelId: args.upstreamModel,
    requestedModel: args.requestedModel,
    body: { ...args.body, model: args.upstreamModel },
    refreshTokens: [args.credential],
    maskedToken: "",
    startedAt: Date.now(),
  };

  switch (args.type) {
    case "deepseek":
      return handleDeepSeekRequest(p, "");
    case "kimiweb":
      return handleKimiWebRequest(p, args.baseUrl);
    case "geminiweb":
      return handleGeminiWebRequest(p);
    case "minimaxweb":
      return handleMiniMaxWebRequest(p);
    case "lingxi":
      return handleLingxiRequest(p);
    case "chatgptweb":
      return handleChatgptWebRequest(p);
    default:
      return new Response(JSON.stringify({ error: { message: `未知 Web 反代渠道: ${args.type}` } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
  }
}

/** 拉取可用模型（失败时回退内置清单） */
export async function fetchWebModels(
  env: Env,
  type: WebProviderType,
  credential: string,
  baseUrl?: string
): Promise<{ models: string[]; message?: string }> {
  const fallback = WEB_PROVIDERS[type].defaultModels;
  try {
    if (type === "deepseek") {
      const r = fetchDeepSeekModels();
      return r.success && r.models.length ? { models: r.models } : { models: fallback };
    }
    if (type === "kimiweb") {
      const r = await fetchKimiWebModels(env, credential, baseUrl);
      return r.success && r.models.length ? { models: r.models } : { models: fallback, message: r.message };
    }
    if (type === "geminiweb") {
      return { models: listGeminiWebModels().models };
    }
    if (type === "minimaxweb") {
      return { models: listMiniMaxWebModels().models };
    }
    if (type === "lingxi") {
      return { models: listLingxiModels().models };
    }
    if (type === "chatgptweb") {
      const r = await import("./chatgptweb").then((m) => m.fetchChatgptWebModels(env, credential));
      return r.success && r.models.length ? { models: r.models } : { models: fallback, message: r.message };
    }
  } catch (err: any) {
    return { models: fallback, message: err?.message || String(err) };
  }
  return { models: fallback };
}
