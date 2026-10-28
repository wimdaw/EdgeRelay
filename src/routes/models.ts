/**
 * GET /v1/models — OpenAI 兼容模型列表
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { listPublicModels } from "../router";

export const modelsRouter = new Hono<{ Bindings: Env }>();

modelsRouter.get("/", async (c) => {
  const models = await listPublicModels(c.env);
  return c.json({ object: "list", data: models });
});
