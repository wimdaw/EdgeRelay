/**
 * scripts/build-site-html.mjs
 * 构建时读取线上站点设置，烘焙进 public/index.html。
 * EdgeOne 会优先托管 public/index.html，静态首页首屏必须直接是正确品牌，
 * 否则会先显示默认站点名，再等 /api/site 返回后切换，产生闪烁。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = join(root, "public", "index.html");
const siteUrl = process.env.SITE_INFO_URL || "https://relay.own.cloudns.nz/api/site";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let site;
try {
  const res = await fetch(siteUrl, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  site = await res.json();
  if (!site?.siteName) throw new Error("invalid site payload");
} catch (e) {
  console.warn(`[build-site-html] 获取线上站点信息失败，保留当前 HTML：${e.message}`);
  process.exit(0);
}

let html = readFileSync(htmlPath, "utf8");
const name = site.siteName;
const desc = site.siteDescription || "";
const logo = site.siteLogoUrl || "/logo.png";

html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(name)} — AI API 网关控制台</title>`);
html = html.replace(/<meta\s+name="description"[^>]*>/gi, `<meta name="description" content="${esc(desc)}">`);
html = html.replace(/<meta\s+property="og:title"[^>]*>/gi, `<meta property="og:title" content="${esc(name)}">`);
html = html.replace(/<meta\s+property="og:description"[^>]*>/gi, `<meta property="og:description" content="${esc(desc)}">`);
html = html.replace(/<meta\s+property="og:image"[^>]*>/gi, `<meta property="og:image" content="${esc(logo)}">`);
html = html.replace(/<link\s+rel="icon"[^>]*>/gi, `<link rel="icon" href="${esc(logo)}">`);

// 允许脚本重复执行而不产生重复注入
html = html.replace(/<script>window\.__EDGERELAY_SITE__=[\s\S]*?<\/script>\n?/g, "");
const initialJson = JSON.stringify(site)
  .replace(/</g, "\\u003c")
  .replace(/\u2028/g, "\\u2028")
  .replace(/\u2029/g, "\\u2029");
html = html.replace(/<\/head>/i, `<script>window.__EDGERELAY_SITE__=${initialJson};</script>\n</head>`);

writeFileSync(htmlPath, html, "utf8");
console.log(`[build-site-html] 已注入站点信息：${name}`);
