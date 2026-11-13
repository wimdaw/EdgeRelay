/**
 * 邮箱验证码存取与校验
 *
 * 从 auth 路由中抽出的独立单元，便于直接单测。约定：
 *  - 键按用途隔离（register / login / reset），**不存在跨用途回退**：
 *    重置码不能拿去登录，登录码也不能拿去重置
 *  - 校验通过即消费，令牌不可复用
 *  - 同一验证码累计输错 5 次即作废，避免 6 位数字被在线枚举
 */
import type { KVLike } from "./storage/blob-store";

export const CODE_TTL_SECONDS = 600;
export const CODE_MAX_ATTEMPTS = 5;

export type CodePurpose = "register" | "login" | "reset";

export type CodeErrorReason = "absent" | "mismatch" | "locked";

// 注：服务端 tsconfig strict=false，无法用可辨识联合收窄，这里用可选字段表达失败原因
export type CodeCheck = { ok: boolean; reason?: CodeErrorReason };

/** 用途段名：register 沿用历史键名 reg，保证上线瞬间未过期的验证码仍然可读 */
const PURPOSE_SEGMENT: Record<string, string> = { register: "reg" };
const segmentOf = (purpose: string) => PURPOSE_SEGMENT[purpose] || purpose;

/** 验证码本体键：验证码 10 分钟后由 KV 自动过期 */
export const codeKey = (purpose: string, email: string) => `emailcode:${segmentOf(purpose)}:${email}`;
/** 失败计数键：与验证码同生命周期 */
export const attemptKey = (purpose: string, email: string) => `emailcode:try:${segmentOf(purpose)}:${email}`;

/** 下发新验证码。旧码同键覆盖，因此同一时刻只有最新一条有效 */
export async function putCode(
  kv: KVLike,
  purpose: CodePurpose | string,
  email: string,
  code: string
): Promise<void> {
  await kv.put(codeKey(purpose, email), code, { expirationTtl: CODE_TTL_SECONDS });
  // 新码重开一轮计数，避免上一轮的失败次数把新码直接锁死
  await kv.delete(attemptKey(purpose, email)).catch(() => {});
}

/** 校验并消费验证码；不论成功失败，都会在返回前完成状态落盘 */
export async function checkCode(
  kv: KVLike,
  purpose: CodePurpose | string,
  email: string,
  input: string | undefined | null
): Promise<CodeCheck> {
  const stored = await kv.get(codeKey(purpose, email));
  if (!stored) return { ok: false, reason: "absent" };

  if (stored !== String(input ?? "").trim()) {
    const attempts = Number((await kv.get(attemptKey(purpose, email))) ?? 0) + 1;
    if (attempts >= CODE_MAX_ATTEMPTS) {
      // 达上限即整体作废，用户必须重新获取
      await kv.delete(codeKey(purpose, email)).catch(() => {});
      await kv.delete(attemptKey(purpose, email)).catch(() => {});
      return { ok: false, reason: "locked" };
    }
    await kv.put(attemptKey(purpose, email), String(attempts), {
      expirationTtl: CODE_TTL_SECONDS,
    });
    return { ok: false, reason: "mismatch" };
  }

  await kv.delete(codeKey(purpose, email)).catch(() => {});
  await kv.delete(attemptKey(purpose, email)).catch(() => {});
  return { ok: true };
}

/** 面向用户的统一错误文案 */
export const CODE_ERROR_MESSAGE: Record<CodeErrorReason, string> = {
  absent: "验证码已过期或未获取，请点击重新获取",
  mismatch: "验证码输入错误，请仔细核对邮件中的 6 位数字",
  locked: "验证码错误次数过多，请重新获取",
};
