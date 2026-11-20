/**
 * 音频接口 /v1/audio/speech（OpenAI 兼容 TTS）
 *
 * 内置免费微软 Edge TTS（azure-tts.ts，无需上游 Key）：
 *  - 请求体 { model, input, voice?, rate?, volume?, pitch? } → audio/mpeg
 *  - 与操练场 /api/playground/speech 共用同一实现
 *  - 复用 API Key 认证与 last_used_at 维护；TTS 免费不计量
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { authenticateSkGwKey } from "../api-auth";
import { errorResponse } from "../errors";
import { handleAzureTtsSpeech } from "../azure-tts";
import { touchApiKeyUsage } from "../storage/db";

export const audioRouter = new Hono<{ Bindings: Env }>();

audioRouter.post("/speech", async (c) => {
  const env = c.env as Env;
  try {
    const auth = await authenticateSkGwKey(c);
    touchApiKeyUsage(env, auth.keyId, { lastUsedAt: Math.floor(Date.now() / 1000) });
    const body = await c.req.json().catch(() => ({}));
    return await handleAzureTtsSpeech(body);
  } catch (err) {
    return errorResponse(c, err);
  }
});
