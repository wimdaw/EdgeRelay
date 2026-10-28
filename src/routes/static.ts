/**
 * 静态资源与 SPA 路由 / (EdgeOne Pages)
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { EMBEDDED_ASSETS } from "../generated-assets";
import { getSettings } from "../settings";

export const staticRouter = new Hono<{ Bindings: Env }>();

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 注入动态 SEO 元数据到 SPA index.html */
async function renderSpaHtml(env: Env): Promise<string> {
  const s = await getSettings(env);
  const siteName = s.siteName ?? "EdgeRelay";
  const desc = s.siteDescription ?? "";
  const logo = s.siteLogoUrl ?? "/logo.png";

  const rawHtml = EMBEDDED_ASSETS["/index.html"]?.content || "<!DOCTYPE html><html><head><title>EdgeRelay</title></head><body><div id='root'></div></body></html>";
  let html = rawHtml;

  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(siteName)} — AI API 网关控制台</title>`);
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
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
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
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
});
