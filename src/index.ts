/**
 * EdgeRelay 主应用入口 (Hono + EdgeOne Pages)
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { chatRouter } from "./routes/chat";
import { modelsRouter, apiModelsRouter } from "./routes/models";
import { authRouter } from "./routes/auth";
import { keysRouter } from "./routes/keys";
import { billingRouter } from "./routes/billing";
import { adminRouter } from "./routes/admin";
import { backupRouter } from "./routes/backup";
import { usageRouter } from "./routes/usage";
import { inviteRouter } from "./routes/invite";
import { profileRouter } from "./routes/profile";
import { siteRouter } from "./routes/site";
import { staticRouter } from "./routes/static";

const app = new Hono<{ Bindings: Env }>();

// 1. 全局 CORS 中间件（单例，避免每个请求重复构造中间件闭包）
const corsMiddleware = cors({
  origin: (origin, c) => {
    const allowStr = (c.env as any)?.CORS_ORIGINS ?? "";
    const allowList = allowStr.split(",").map((s: string) => s.trim()).filter(Boolean);
    if (allowList.length === 0) return origin || "*";
    return origin && allowList.includes(origin) ? origin : allowList[0];
  },
  allowHeaders: ["authorization", "content-type", "x-request-id", "x-timestamp", "x-signature"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  maxAge: 86400,
  credentials: true,
});
app.use("*", corsMiddleware);

// 2. 健康检查（附带实例探针：同一 Node 进程内 instance 不变、requests 递增，便于确认热复用）
const INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let instanceRequests = 0;
app.get("/health", (c) =>
  c.json({
    status: "ok",
    engine: "edgeone-pages",
    storage: "edgeone-blob",
    instance: INSTANCE_ID,
    requests: ++instanceRequests,
    ctxKeys: (globalThis as any).__EO_CTX_KEYS ?? null,
    waitUntil: (globalThis as any).__EO_CTX_WAITUNTIL ?? null,
    envKeys: (globalThis as any).__EO_CTX_ENV_KEYS ?? null,
  })
);

// 3. 核心 API 路由
app.route("/v1/chat/completions", chatRouter);
app.route("/v1/models", modelsRouter);
app.route("/api/models", apiModelsRouter);
app.route("/api/auth", authRouter);
app.route("/api/keys", keysRouter);
app.route("/api/billing", billingRouter);
app.route("/api/admin", adminRouter);
app.route("/api/admin/backup", backupRouter);
app.route("/api/usage", usageRouter);
app.route("/api/invite", inviteRouter);
app.route("/api/user/profile", profileRouter);
app.route("/api", siteRouter);

// 4. 静态资产与 SPA Fallback 路由（最后挂载）
app.route("/", staticRouter);

export default app;
