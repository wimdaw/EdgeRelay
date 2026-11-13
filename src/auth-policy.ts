/**
 * 认证策略判定
 *
 * 单独成模块的原因：这类判断散落在路由里时极易被"顺手简化"成真值判断，
 * 而它们恰恰依赖「字段缺失」这一状态，必须集中并有测试盯着。
 */
import type { PlatformSettings } from "./types";

/**
 * 注册是否强制邮箱验证。
 *
 * 注意这里必须是 `!== false`，不能写成真值判断：
 * `loadConfigSnapshot` 命中已有快照时**不会**与 DEFAULT_SETTINGS 合并，
 * 因此老部署里的 settings 根本没有 requireEmailVerification 字段（undefined）。
 * 若用 `if (settings.requireEmailVerification)`，升级瞬间就等同于把注册敞开。
 */
export function isEmailVerificationRequired(
  settings?: Partial<PlatformSettings> | null
): boolean {
  return settings?.requireEmailVerification !== false;
}
