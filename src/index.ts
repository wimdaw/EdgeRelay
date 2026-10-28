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
import { usageRouter } from "./routes/usage";
import { inviteRouter } from "./routes/invite";
import { profileRouter } from "./routes/profile";
import { siteRouter } from "./routes/site";
import { staticRouter } from "./routes/static";

const app = new Hono<{ Bindings: Env }>();

// 1. 全局 CORS 中间件
app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  const allowStr = c.env?.CORS_ORIGINS ?? "";
  const allowList = allowStr.split(",").map((s) => s.trim()).filter(Boolean);

  let allowOrigin = "*";
  if (allowList.length > 0) {
    if (origin && allowList.includes(origin)) {
      allowOrigin = origin;
    } else {
      allowOrigin = allowList[0];
    }
  }

  const corsMiddleware = cors({
    origin: allowOrigin,
    allowHeaders: ["authorization", "content-type", "x-request-id", "x-timestamp", "x-signature"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86400,
    credentials: true,
  });

  return corsMiddleware(c, next);
});

// 2. 健康检查
app.get("/health", (c) => c.json({ status: "ok", engine: "edgeone-pages", storage: "edgeone-blob" }));

// 3. 核心 API 路由
app.route("/v1/chat/completions", chatRouter);
app.route("/v1/models", modelsRouter);
app.route("/api/models", apiModelsRouter);
app.route("/api/auth", authRouter);
app.route("/api/keys", keysRouter);
app.route("/api/billing", billingRouter);
app.route("/api/admin", adminRouter);
app.route("/api/usage", usageRouter);
app.route("/api/invite", inviteRouter);
app.route("/api/user/profile", profileRouter);
app.route("/api", siteRouter);

// 4. 静态资产与 SPA Fallback 路由（最后挂载）
app.route("/", staticRouter);

export default app;
