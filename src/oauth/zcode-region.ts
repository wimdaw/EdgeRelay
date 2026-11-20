/**
 * ZCode 登录区域映射（纯函数，无运行时依赖，便于单测锁住）
 *
 * 2026-11-20 实测：登录已从 bigmodel 搬到 Z.ai 的 OAuth
 *  - 国际版 provider=zai     → https://chat.z.ai/api/oauth/authorize
 *  - 国内版 provider=zai_cn  → https://zchat.z.ai/api/oauth/authorize
 *  - 旧国内版 provider=bigmodel → https://bigmodel.cn/login（微信扫码已下线）
 *
 * 三者 client_id 相同，callback 分别是 /callback/{zai|zai_cn|bigmodel}。
 * 改动这里等于改登录落点，务必同步 tests/test-zcode-region.mjs。
 */
export type ZcodeProvider = "zai" | "zai_cn" | "bigmodel";

export const ZCODE_AUTHORIZE_HOST: Record<ZcodeProvider, string> = {
  zai: "https://chat.z.ai",
  zai_cn: "https://zchat.z.ai",
  bigmodel: "https://bigmodel.cn",
};

/** 渠道 baseUrl → 登录 provider。baseUrl 为空时按国际版处理（历史默认） */
export function zcodeProviderFor(baseUrl?: string): ZcodeProvider {
  const b = (baseUrl || "").trim();
  if (/zchat\.z\.ai/i.test(b)) return "zai_cn";
  if (/bigmodel\.cn/i.test(b)) return "bigmodel";
  return "zai";
}

/** 旧 bigmodel 渠道：微信扫码已下线，只能靠粘贴 access_token 续命 */
export function isLegacyBigmodel(baseUrl?: string): boolean {
  return zcodeProviderFor(baseUrl) === "bigmodel";
}
