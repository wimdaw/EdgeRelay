/**
 * scripts/build-site-html.mjs
 * 构建时读取线上站点设置，烘焙进前端 HTML 模板。
 *
 * EdgeOne 会优先托管 public/index.html；为了让首页每次都走云函数的
 * no-store 动态渲染（避免部署后仍命中旧 HTML 导致品牌闪烁），构建完成后
 * 把模板改名为 _index.template.html，由 build-assets.mjs 映射为 /index.html
 * 内嵌进云函数。public/ 下不再保留 index.html，根路径自然落到函数。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(root, "public", "index.html");
const fallbackPath = join(root, "public", "_index.template.html");
const templatePath = fallbackPath;
const siteUrl = process.env.SITE_INFO_URL || "https://relay.own.cloudns.nz/api/site";

const DEFAULT_SITE = {
  siteName: "Relay",
  siteDescription: "部署在 EdgeOne 边缘的 AI API 网关，用统一 OpenAI 兼容接口接入、路由和派发多家大模型服务。",
  siteLogoUrl: "/logo.png",
  siteHomepage: "",
  heroBadge: "跑在 EdgeOne 全球边缘节点",
  heroTitle: "部署在 EdgeOne 边缘的合规 AI API 网关",
  heroSubtitle: "用统一 OpenAI 兼容接口，接入、路由和治理多家大模型服务。合法授权上游、透明计费、哈希链审计——面向开发者与企业的正规聚合分发平台。",
  supportEmail: "hackerxiaow@gmail.com",
  oauth: { github: false, google: false },
  smtpEnabled: true,
};

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let site = DEFAULT_SITE;
try {
  const res = await fetch(siteUrl, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const fetched = await res.json();
  if (!fetched?.siteName) throw new Error("invalid site payload");
  site = { ...DEFAULT_SITE, ...fetched };
  console.log(`[build-site-html] 已读取线上站点信息：${site.siteName}`);
} catch (e) {
  console.warn(`[build-site-html] 获取线上站点信息失败，使用 Relay 默认品牌：${e.message}`);
}

const inputPath = existsSync(sourcePath) ? sourcePath : templatePath;
if (!existsSync(inputPath)) {
  console.error(`[build-site-html] 找不到前端 HTML：${inputPath}`);
  process.exit(1);
}

let html = readFileSync(inputPath, "utf8");
const name = site.siteName || "Relay";
const desc = site.siteDescription || DEFAULT_SITE.siteDescription;
const logo = site.siteLogoUrl || "/logo.png";

const titleSuffix = site.heroTitle || DEFAULT_SITE.heroTitle;
html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(name)} — ${esc(titleSuffix)}</title>`);
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

writeFileSync(templatePath, html, "utf8");
// EdgeOne 的根路径仍优先命中静态 index.html；必须保留一份正确品牌的入口，
// 否则 / 会直接 404。函数侧继续使用 _index.template.html 做动态兜底。
writeFileSync(sourcePath, html, "utf8");
console.log(`[build-site-html] 已生成首页入口与动态模板（${name}）`);
