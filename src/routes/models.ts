/**
 * 模型与路由接口 (OpenAI 兼容 /v1/models 与 控制台 /api/models)
 */
import { Hono } from "hono";
import type { Env, HandlerCtx } from "../types";
import { listPublicModels } from "../router";
import { requireUser } from "../auth";
import { errorResponse } from "../errors";
import { json } from "../settings";
import { getModels, getAllPricing, getProviders } from "../storage/db";

export const modelsRouter = new Hono<{ Bindings: Env }>();

/** OpenAI 兼容 /v1/models */
modelsRouter.get("/", async (c) => {
  const models = await listPublicModels(c.env);
  return c.json({ object: "list", data: models });
});

/** 面向控制台登录用户的 /api/models */
export const apiModelsRouter = new Hono<{ Bindings: Env }>();

apiModelsRouter.get("/", async (c) => {
  const hCtx: HandlerCtx = { env: c.env, req: c.req as any };
  try {
    await requireUser(hCtx);
    const models = await getModels(c.env);
    const pricing = await getAllPricing(c.env);
    const providers = await getProviders(c.env);
    const providerMap = new Map(providers.map((p) => [p.id, p]));

    const rows = models.map((m) => {
      const pr = providerMap.get(m.providerId);
      const prc = pricing[m.publicName];
      return {
        id: m.id,
        public_name: m.publicName,
        upstream_model: m.upstreamModel,
        priority: m.priority,
        cost_weight: m.costWeight,
        enabled: m.enabled,
        provider_id: m.providerId,
        provider_name: pr?.name ?? null,
        provider_slug: pr?.slug ?? null,
        input_per_million: prc?.inputPerMillion ?? null,
        output_per_million: prc?.outputPerMillion ?? null,
        currency: prc?.currency ?? "CNY",
      };
    });

    return json({ ok: true, models: rows });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
