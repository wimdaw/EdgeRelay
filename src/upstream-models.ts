/**
 * 上游模型目录发现（供「拉取模型」与「按上游同步」共用同一套解析逻辑）
 *
 * 不同渠道的模型来源差异很大：
 *  - web:* / oauth:* 走各自协议的 fetchModels，失败回退内置兜底清单；
 *  - opencode / kilo 只保留免费层的模型；
 *  - 其余 OpenAI 兼容渠道直接请求 {baseUrl}/v1/models，并剥掉 Google 的 models/ 前缀。
 */
import type { Env, ProviderRecord } from "./types";
import { getProviders, getProviderKeysAll } from "./storage/db";
import { decryptSecret } from "./crypto";
import { joinApiPath, normalizeUpstreamModel } from "./providers";

export type UpstreamModelList = {
  models: string[];
  note?: string;
  degraded?: boolean;
};

function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = String(raw ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export async function fetchProviderUpstreamModels(
  env: Env,
  providerIdOrSlug: string
): Promise<{ provider: ProviderRecord | null; list: UpstreamModelList }> {
  const providerId = String(providerIdOrSlug || "");
  const providers = await getProviders(env);
  const prov = providers.find((x) => x.id === providerId || x.slug === providerId) ?? null;
  const provKind = prov?.kind || "";

  /* ---- Web 反代渠道 ---- */
  if (provKind.startsWith("web:")) {
    const type = provKind.slice("web:".length);
    const { fetchWebModels, WEB_PROVIDERS } = await import("./web");
    const keys = prov ? await getProviderKeysAll(env, prov.id) : [];
    const activeKey = keys.find((k) => k.status === "active") || keys[0];
    if (activeKey && type !== "geminiweb") {
      try {
        const credential = await decryptSecret(env, activeKey.encryptedKey);
        const r = await fetchWebModels(env, type as any, credential, prov?.baseUrl);
        return { provider: prov, list: { models: dedupe(r.models), note: r.message } };
      } catch {
        /* 回退内置清单 */
      }
    }
    // 拉取失败时只有内置兜底清单，标记 degraded：可用于展示，但不允许据此做增删同步
    const meta = WEB_PROVIDERS[type as keyof typeof WEB_PROVIDERS];
    return { provider: prov, list: { models: dedupe(meta?.defaultModels ?? []), degraded: true } };
  }

  /* ---- OAuth 渠道 ---- */
  if (provKind.startsWith("oauth:")) {
    const type = provKind.slice("oauth:".length);
    const { fetchOAuthModels, OAUTH_PROVIDERS } = await import("./oauth");
    const keys = prov ? await getProviderKeysAll(env, prov.id) : [];
    const activeKey = keys.find((k) => k.status === "active") || keys[0];
    if (activeKey) {
      try {
        const token = await decryptSecret(env, activeKey.encryptedKey);
        const r = await fetchOAuthModels(env, type as any, token, prov?.baseUrl);
        return {
          provider: prov,
          list: { models: dedupe(r.models), note: r.message, degraded: r.degraded === true },
        };
      } catch {
        /* 回退内置清单 */
      }
    }
    const meta = OAUTH_PROVIDERS[type as keyof typeof OAUTH_PROVIDERS];
    return { provider: prov, list: { models: dedupe(meta?.defaultModels ?? []), degraded: true } };
  }

  /* ---- 免 Key 渠道：OpenCode 只收免费层 ---- */
  const slug = prov?.slug || prov?.kind || providerId;
  if (slug === "opencode") {
    try {
      const { fetchOpenCodeModels, resolveOpenCodeUrls, resolveOpenCodeRelay } = await import("./opencode");
      const mirrors = resolveOpenCodeUrls(env);
      const relay = resolveOpenCodeRelay(env);
      const res = await fetchOpenCodeModels(prov?.baseUrl || "https://opencode.ai/zen/v1", [], mirrors, undefined, relay);
      if (res.success && res.data?.data && Array.isArray(res.data.data)) {
        const freeList = res.data.data
          .map((m: any) => m.id)
          .filter((id: string) => typeof id === "string" && (id === "big-pickle" || id.endsWith("-free")));
        if (freeList.length) return { provider: prov, list: { models: dedupe(freeList) } };
      }
    } catch {
      /* 回退内置清单 */
    }
    return {
      provider: prov,
      list: {
        degraded: true,
        models: [
          "deepseek-v4.1-flash-free",
          "big-pickle",
          "beam-free",
          "flint-40b-free",
          "mimo-v2.6-flash-free",
          "nemotron-3.5-super-vl-free",
          "nemotron-3.5-lightning-free",
          "jev-1.13-free",
          "glm-5.3-flash-free",
        ],
      },
    };
  }

  /* ---- 免 Key 渠道：DuckAI 静态清单 ---- */
  if (slug === "duckai") {
    return {
      provider: prov,
      list: {
        models: ["gpt-6-luna", "gpt-5.4-mini", "claude-haiku-4-5", "mistral-small-2603", "tinfoil/gpt-oss-120b", "tinfoil/gemma4-31b"],
      },
    };
  }

  /* ---- 免 Key 渠道：Kilo 只收免费层 ---- */
  if (slug === "kilo") {
    try {
      const res = await fetch("https://api.kilo.ai/api/gateway/models", {
        headers: { "user-agent": "Relay/1.0" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const d = (await res.json()) as { data?: { id?: string }[] };
        const freeList = (d.data ?? [])
          .map((m) => m.id)
          .filter((id): id is string => typeof id === "string" && (id.includes(":free") || id === "kilo-auto/free" || id === "openrouter/free"));
        if (freeList.length) return { provider: prov, list: { models: dedupe(freeList) } };
      }
    } catch {
      /* 回退内置清单 */
    }
    return {
      provider: prov,
      list: {
        degraded: true,
        models: [
          "kilo-auto/free",
          "openrouter/free",
          "nvidia/nemotron-3.5-super-vl:free",
          "nvidia/nemotron-3.5-lightning:free",
          "reflection/beam-free",
          "xingchen-agi/xing4.0-29b-a4b:free",
          "dots-studio/dots-3-note-preview:free",
          "liquid/lfm-2.5-2.6b:free",
          "cohere/north-mini-code:free",
          "nvidia/nemotron-3-ultra-550b-a55b:free",
          "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
        ],
      },
    };
  }

  /* ---- Anthropic 官方协议 ---- */
  if (slug === "anthropic") {
    try {
      const keys = await getProviderKeysAll(env, prov?.id || "anthropic");
      const activeKey = keys.find((k) => k.status === "active");
      if (activeKey) {
        const plainKey = await decryptSecret(env, activeKey.encryptedKey);
        const res = await fetch("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": plainKey, "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const d = (await res.json()) as { data?: { id?: string }[] };
          const mList = (d.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
          if (mList.length) return { provider: prov, list: { models: dedupe(mList) } };
        }
      }
    } catch {
      /* 回退内置清单 */
    }
    return {
      provider: prov,
      list: {
        degraded: true,
        models: [
          "claude-3-5-sonnet-20241022",
          "claude-3-5-haiku-20241022",
          "claude-3-opus-20240229",
          "claude-3-sonnet-20240229",
          "claude-3-haiku-20240307",
        ],
      },
    };
  }

  /* ---- 通用 OpenAI 兼容渠道 ---- */
  if (prov?.baseUrl) {
    const keys = await getProviderKeysAll(env, prov.id);
    const activeKey = keys.find((k) => k.status === "active");
    if (activeKey) {
      try {
        const plainKey = await decryptSecret(env, activeKey.encryptedKey);
        const mRes = await fetch(joinApiPath(prov.baseUrl, "/v1/models"), {
          headers: { authorization: `Bearer ${plainKey}` },
          signal: AbortSignal.timeout(15000),
        });
        if (mRes.ok) {
          const data = (await mRes.json()) as { data?: { id?: string }[] };
          // Google 兼容列表返回 models/xxx，对话接口只认裸名，导入时统一剥前缀
          const mList = (data.data ?? [])
            .map((m) => m.id)
            .filter((x): x is string => !!x)
            .map((id) => normalizeUpstreamModel(prov.slug, prov.baseUrl, id));
          if (mList.length) return { provider: prov, list: { models: dedupe(mList) } };
        }
      } catch {
        /* 无模型可返回 */
      }
    }
  }

  return { provider: prov, list: { models: [] } };
}
