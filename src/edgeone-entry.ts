/**
 * EdgeOne Makers 云函数入口 onRequest
 */
import crypto from "node:crypto";

// 确保 Node 运行时环境提供标准 Web Crypto
if (typeof globalThis.crypto === "undefined") {
  // @ts-ignore
  globalThis.crypto = crypto;
} else {
  if (!globalThis.crypto.randomUUID && crypto.randomUUID) {
    globalThis.crypto.randomUUID = crypto.randomUUID.bind(crypto);
  }
  if (!globalThis.crypto.subtle && (crypto as any).webcrypto) {
    // @ts-ignore
    globalThis.crypto.subtle = (crypto as any).webcrypto.subtle;
  }
}

import app from "./index";

/**
 * EdgeOne 标准入口
 */
export async function onRequest(context: any) {
  const incoming: Request = context.request;

  // 诊断：记录本次调用上下文中可用的能力（waitUntil 等），供 /health 探针读取
  const ctx: any = context || {};
  const g: any = globalThis as any;
  g.__EO_CTX_KEYS = Object.keys(ctx);
  g.__EO_CTX_WAITUNTIL = typeof ctx.waitUntil === "function";
  g.__EO_CTX_ENV_KEYS = Object.keys(ctx.env || {});

  const env = {
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || "edgerelay-default-encryption-secret-32b",
    SESSION_SECRET: process.env.SESSION_SECRET || "edgerelay-default-session-secret-32b",
    ...process.env,
    ...(context?.env || {}),
  };

  const method = (incoming.method || "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  let request = incoming;
  if (hasBody) {
    try {
      const buf = await incoming.arrayBuffer();
      request = new Request(incoming.url, {
        method,
        headers: incoming.headers,
        body: buf.byteLength > 0 ? buf : undefined,
      });
    } catch (err: any) {
      console.error("[Entry] Failed to materialize request body:", err?.message);
      request = incoming;
    }
  }

  return await app.fetch(request, env, context);
}

export default app;
