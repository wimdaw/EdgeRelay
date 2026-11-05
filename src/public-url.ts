/**
 * 拼对外可访问的站点地址
 *
 * EdgeOne 云函数内部拿到的 `c.req.url` 是内网地址
 * （如 http://pages-pro-5-e238.pages-scf-tyo-pro.qcloudteo.com），
 * 直接用它拼 poll_url / watch_url 会得到外部打不开的链接。
 * 因此按以下优先级取公网地址：
 *   1. x-forwarded-host（含协议头 x-forwarded-proto）
 *   2. host（排除内网域名）
 *   3. 环境变量 PUBLIC_BASE_URL
 *   4. 站点配置的 siteHomepage（由调用方传入）
 *   5. 兜底常量
 */
const INTERNAL_HOST_RE = /(^|\.)qcloudteo\.com$|(^|\.)tencentcloud|^localhost$|^127\.0\.0\.1$|(^|\.)internal$/i;

const FALLBACK_ORIGIN = "https://relay.own.cloudns.nz";

function isInternalHost(host?: string | null): boolean {
  if (!host) return true;
  return INTERNAL_HOST_RE.test(host.split(":")[0] || "");
}

export function publicOrigin(c: any, env: any, siteHomepage?: string | null): string {
  const proto = (c.req.header("x-forwarded-proto") || "https").split(",")[0].trim();
  const xfHost = c.req.header("x-forwarded-host");
  if (xfHost && !isInternalHost(xfHost)) {
    return `${proto}://${xfHost.split(",")[0].trim()}`;
  }
  const host = c.req.header("host");
  if (host && !isInternalHost(host)) {
    return `${proto}://${host.split(",")[0].trim()}`;
  }
  const configured = String((env as any)?.PUBLIC_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (configured) return configured;
  if (siteHomepage && /^https?:\/\//i.test(siteHomepage)) return siteHomepage.replace(/\/+$/, "");
  return FALLBACK_ORIGIN;
}
