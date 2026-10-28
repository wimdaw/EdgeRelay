/**
 * 静态资源与 SPA 路由 / (EdgeOne Pages)
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { EMBEDDED_ASSETS } from "../generated-assets";
import { getSettings } from "../settings";

export const staticRouter = new Hono<{ Bindings: Env }>();

const HTML_CACHE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  pragma: "no-cache",
  expires: "0",
  "cdn-cache-control": "no-store",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 注入动态 SEO 元数据到 SPA index.html */
async function renderSpaHtml(env: Env): Promise<string> {
  const s = await getSettings(env);
  const siteName = s.siteName ?? "Relay";
  const desc = s.siteDescription ?? "";
  const logo = s.siteLogoUrl ?? "/logo.png";

  const rawHtml = EMBEDDED_ASSETS["/index.html"]?.content || "<!DOCTYPE html><html><head><title>Relay</title></head><body><div id='root'></div></body></html>";
  let html = rawHtml;

  // 把站点信息同步注入首屏 HTML，前端首次渲染直接使用，
  // 避免先显示默认站点名、再等 /api/site 返回后才切换的闪烁。
  const initialSite = {
    siteName,
    siteDescription: desc,
    siteLogoUrl: logo,
    siteHomepage: s.siteHomepage ?? "",
    heroBadge: s.heroBadge ?? "跑在 EdgeOne 全球边缘节点",
    heroTitle: s.heroTitle ?? "部署在 EdgeOne 边缘的合规 AI API 网关",
    heroSubtitle: s.heroSubtitle ?? "用统一 OpenAI 兼容接口，接入、路由和治理多家大模型服务。合法授权上游、透明计费、哈希链审计——面向开发者与企业的正规聚合分发平台。",
    supportEmail: s.supportEmail ?? "hackerxiaow@gmail.com",
    icpNumber: s.icpNumber ?? "待办理",
    copyrightText: s.copyrightText ?? "",
    githubUrl: s.githubUrl ?? "https://github.com/wimdaw/EdgeRelay",
    oauth: {
      github: !!s.oauthGithubEnabled,
      google: !!s.oauthGoogleEnabled,
    },
    smtpEnabled: !!s.smtpEnabled,
  };
  const initialJson = JSON.stringify(initialSite)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  const titleSuffix = s.heroTitle ?? "部署在 EdgeOne 边缘的合规 AI API 网关";
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(siteName)} — ${esc(titleSuffix)}</title>`);
  html = html.replace(/<meta\s+name="description"[^>]*>/gi, "");
  html = html.replace(/<meta\s+property="og:[^"]*"[^>]*>/gi, "");
  html = html.replace(
    /<\/head>/i,
    [
      `<meta name="description" content="${esc(desc)}">`,
      `<meta property="og:title" content="${esc(siteName)}">`,
      `<meta property="og:description" content="${esc(desc)}">`,
      `<meta property="og:image" content="${esc(logo)}">`,
      `<meta property="og:type" content="website">`,
      `<link rel="icon" href="${esc(logo)}">`,
      `<link rel="apple-touch-icon" href="${esc(logo)}">`,
    ].join("\n") + "\n</head>"
  );

  // 放在 head 末尾，避免把 charset 推到 1024 字节之后；
  // 内联经典脚本会在 defer 的 module 脚本之前执行。
  html = html.replace(/<script>window\.__EDGERELAY_SITE__=[\s\S]*?<\/script>\n?/g, "");
  html = html.replace(/<\/head>/i, `<script>window.__EDGERELAY_SITE__=${initialJson};</script>\n</head>`);

  return html;
}

/** 统一资产与页面分发 */
staticRouter.get("*", async (c) => {
  const url = new URL(c.req.url);
  const pathname = url.pathname;

  // 1. 精确匹配内嵌资源（/assets/*, /logo.png, /terms.html 等）
  const asset = EMBEDDED_ASSETS[pathname];
  if (asset) {
    if (pathname === "/index.html") {
      const html = await renderSpaHtml(c.env);
      return new Response(html, { headers: HTML_CACHE_HEADERS });
    }
    const headers: Record<string, string> = {
      "content-type": asset.type,
      "cache-control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    };
    if (asset.isBase64) {
      const binaryStr = atob(asset.content);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);
      return new Response(bytes, { headers });
    }
    return new Response(asset.content, { headers });
  }

  // 2. SPA Fallback（前端路由如 /login, /dashboard/*, /privacy 等）
  const html = await renderSpaHtml(c.env);
  return new Response(html, { headers: HTML_CACHE_HEADERS });
});
