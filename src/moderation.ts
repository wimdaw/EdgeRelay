/**
 * 内容安全钩子 (EdgeOne Pages + Blob)
 */
import type { HandlerCtx, PlatformSettings } from "./types";
import { sha256Hex, uuid } from "./crypto";
import { appendContentFlag } from "./storage/db";

export type ModerationResult = { flagged: boolean; rule?: string; maskedExcerpt?: string };

export async function moderate(
  c: HandlerCtx,
  args: { settings: PlatformSettings; userId: string; apiKeyId?: string; requestId: string; model: string; text: string }
): Promise<ModerationResult> {
  const s = args.settings;
  if (!s.contentModerationEnabled) return { flagged: false };

  // 1) 本地规则
  for (const pattern of s.blocklist) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "iu");
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
    }
    if (re.test(args.text)) {
      await recordFlag(c, args, `local:${pattern}`);
      return { flagged: true, rule: `local:${pattern}` };
    }
  }

  // 2) 外部审核 API（可选）
  const moderationUrl = typeof c.env.MODERATION_API_URL === "string" ? c.env.MODERATION_API_URL : undefined;
  if (moderationUrl) {
    try {
      const resp = await fetch(moderationUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: args.text, model: args.model, requestId: args.requestId }),
      });
      const result = (await resp.json()) as { flagged?: boolean; rule?: string };
      if (result.flagged) {
        await recordFlag(c, args, result.rule ?? "external");
        return { flagged: true, rule: result.rule ?? "external" };
      }
    } catch (e) {
      console.error("moderation_api_error", e);
    }
  }
  return { flagged: false };
}

async function recordFlag(
  c: HandlerCtx,
  args: { settings: PlatformSettings; userId: string; apiKeyId?: string; requestId: string; model: string; text: string },
  rule: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const excerptHash = await sha256Hex(args.text);
  const masked = args.settings.logContentEnabled
    ? args.text.slice(0, 120).replace(/[\u4e00-\u9fa5\w]{2,}/g, (w) => (w.length > 2 ? w[0] + "***" : "*"))
    : null;

  await appendContentFlag(c.env, {
    id: uuid(),
    userId: args.userId,
    apiKeyId: args.apiKeyId ?? null,
    requestId: args.requestId,
    publicModel: args.model,
    rule,
    excerptHash,
    excerptMasked: masked,
    status: "pending",
    createdAt: now,
  });
}
