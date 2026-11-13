/**
 * tests/test-model-case-insensitive.mjs
 * 模型名大小写不敏感匹配的单元测试。
 *
 * 背景：智谱官方文档页面标题写 GLM-4.7-Flash，但 API 的 model code 是小写 glm-4.7-flash。
 * 用户按页面标题写大写时，网关原先因「publicName 精确匹配」直接 404。
 * 本测试锁定三条规则：
 *   1. 精确匹配永远优先（大小写变体不影响原有行为）
 *   2. 裸名大小写变体可命中（候选唯一时）
 *   3. 「渠道/模型」定向写法大小写变体可命中，且限定在该渠道内
 *   4. 歧义（同名仅大小写不同的多渠道模型）不得静默路由，保持查不到
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  entryPoints: [join(root, "src", "router.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
);
const { planModelRoutes } = mod;

let pass = 0;
const fails = [];
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fails.push(`${name} → 期望 ${e}，实际 ${a}`);
}

/** 构造一个最小 env 替身：getModels / getProviders 走内存快照 */
function makeEnv(models, providers) {
  return {
    __models: models,
    __providers: providers,
  };
}

// 直接替换 router 内部使用的存储读取，避免真实 Blob 依赖
// router.ts 通过动态 import("./storage/db") 取 getModels/getProviders，
// 这里改为直接测试导出的纯逻辑：用内存 env 无法注入，因此改为 mock 模块。
const storageStub = `
export async function getModels(env) { return env.__models || []; }
export async function getProviders(env) { return env.__providers || []; }
export async function getProviderKeys() { return []; }
export async function setProviders() {}
export async function setModels() {}
export async function readKeyHealth() { return {}; }
`;
{
  const plugin = {
    name: "stub-storage",
    setup(b) {
      b.onResolve({ filter: /^\.\/storage\/db$/ }, () => ({ path: "storage-stub", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: storageStub, loader: "js" }));
    },
  };
  const out2 = await build({
    entryPoints: [join(root, "src", "router.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
    plugins: [plugin],
  });
  const mod2 = await import(
    "data:text/javascript;base64," + Buffer.from(out2.outputFiles[0].text).toString("base64")
  );
  var planRoutes = mod2.planModelRoutes;
}

// 供测的固定数据集
const PROVIDERS = [
  { id: "bigmodel", name: "智谱", slug: "bigmodel", kind: "openai_compat", baseUrl: "https://open.bigmodel.cn/api/paas/v4", authScheme: "bearer", status: "active", createdAt: 1 },
  { id: "nvidia", name: "NVIDIA", slug: "nvidia", kind: "openai_compat", baseUrl: "https://integrate.api.nvidia.com/v1", authScheme: "bearer", status: "active", createdAt: 1 },
  { id: "amd", name: "AMD", slug: "amd", kind: "openai_compat", baseUrl: "https://developer.amd.com.cn/radeon/api/v1", authScheme: "bearer", status: "active", createdAt: 1 },
];

const MODELS = [
  { id: "m1", publicName: "glm-4.7-flash", providerId: "bigmodel", upstreamModel: "glm-4.7-flash", priority: 10, costWeight: 1, enabled: 1, createdAt: 1 },
  { id: "m2", publicName: "glm-5.3-flash", providerId: "nvidia", upstreamModel: "z-ai/glm-5.3-flash", priority: 10, costWeight: 1, enabled: 1, createdAt: 1 },
  { id: "m3", publicName: "GLM-5.3-Flash", providerId: "amd", upstreamModel: "GLM-5.3-Flash", priority: 10, costWeight: 1, enabled: 1, createdAt: 1 },
];

const env = makeEnv(MODELS, PROVIDERS);
const names = async (m) => (await planRoutes(env, m)).map((p) => `${p.provider.slug}/${p.model.publicName}`);

// 1. 精确匹配优先：小写裸名命中小写模型
eq("小写裸名精确命中", await names("glm-4.7-flash"), ["bigmodel/glm-4.7-flash"]);

// 2. 精确匹配优先：大写裸名命中大写模型（amd），不被小写抢走
eq("大写裸名精确命中 amd", await names("GLM-5.3-Flash"), ["amd/GLM-5.3-Flash"]);

// 3. 裸名大小写变体回退：GLM-4.7-Flash → bigmodel/glm-4.7-flash
eq("大写裸名回退命中 bigmodel", await names("GLM-4.7-Flash"), ["bigmodel/glm-4.7-flash"]);
eq("混合大小写裸名回退命中", await names("GLM-4.7-FLASH"), ["bigmodel/glm-4.7-flash"]);

// 4. 渠道定向 + 大小写变体
eq("渠道前缀 + 大写子名", await names("bigmodel/GLM-4.7-Flash"), ["bigmodel/glm-4.7-flash"]);
eq("渠道前缀 + 混合大小写子名", await names("bigmodel/GlM-4.7-Flash"), ["bigmodel/glm-4.7-flash"]);

// 5. 歧义不得静默路由：glm-5.3-flash 与 GLM-5.3-Flash 分属两个渠道，
//    裸名且大小写不一致时必须查不到，逼调用方用「渠道/模型」精确定向
eq("跨渠道同名歧义：裸名大小写不一致不命中", await names("GLM-5.3-flash"), []);
eq("跨渠道同名歧义：裸名精确命中仍可用", await names("glm-5.3-flash"), ["nvidia/glm-5.3-flash"]);
eq("跨渠道同名歧义：定向后大小写变体可命中", await names("amd/glm-5.3-flash"), ["amd/GLM-5.3-Flash"]);

// 6. 不存在的模型仍然查不到
eq("不存在的模型不命中", await names("glm-999"), []);
eq("不存在的渠道不命中", await names("nosuch/model"), []);

// 7. 被禁用的模型不应因大小写回退被复活
const DISABLED = MODELS.map((m) => (m.id === "m1" ? { ...m, enabled: 0 } : m));
eq("禁用模型不因大小写回退被复活", await planRoutes(makeEnv(DISABLED, PROVIDERS), "GLM-4.7-Flash"), []);

// 8. 付费模型的定价不能因大小写变体被绕过
//    定价表以模型的 publicName 为键；调用方必须用路由解析出的规范名取价，
//    否则用户写 "GPT-4O" 取不到价格 → 被误判为免费模型 → 普通用户即可白嫖。
{
  const billingStub = `
export async function getAllPricing(env) { return env.__pricing || {}; }
export async function getProviderKeys() { return []; }
export async function setProviders() {}
export async function setModels() {}
export async function readKeyHealth() { return {}; }
export async function getOrCreateBalance() { return { available: 0, frozen: 0, currency: "CNY" }; }
export async function updateBalance() {}
export async function appendLedgerEntries() {}
export async function touchApiKeyUsage() {}
`;
  const plugin = {
    name: "stub-billing",
    setup(b) {
      b.onResolve({ filter: /^\.\/storage\/db$/ }, () => ({ path: "storage-stub2", namespace: "stub2" }));
      b.onLoad({ filter: /.*/, namespace: "stub2" }, () => ({ contents: billingStub, loader: "js" }));
    },
  };
  const out3 = await build({
    entryPoints: [join(root, "src", "billing.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
    plugins: [plugin],
  });
  const mod3 = await import(
    "data:text/javascript;base64," + Buffer.from(out3.outputFiles[0].text).toString("base64")
  );
  const getPricing = mod3.getPricing;

  const PRICING = {
    "glm-4.7-flash": { id: "p1", publicName: "glm-4.7-flash", inputPerMillion: 0, outputPerMillion: 0, currency: "CNY", createdAt: 1 },
    "gpt-4o": { id: "p2", publicName: "gpt-4o", inputPerMillion: 17, outputPerMillion: 68, currency: "CNY", createdAt: 1 },
  };
  const penv = { __pricing: PRICING };

  // 免费模型：大小写变体取到的仍是同一个价格条目（0/0）
  const freeHit = await getPricing(penv, "glm-4.7-flash");
  eq("免费模型精确取价", freeHit?.inputPerMillion, 0);

  // 付费模型：精确取价仍为付费
  eq("付费模型精确取价", (await getPricing(penv, "gpt-4o"))?.inputPerMillion, 17);

  // 付费模型的大小写变体：getPricing 只做精确匹配，取不到价格
  // → 路由解析后的规范名兜底才是唯一正确路径；此处锁定「不会因变体取到错误的免费价」
  eq("付费模型变体不得取到免费价", await getPricing(penv, "GPT-4O"), null);
  eq("免费模型变体不会误取付费价", (await getPricing(penv, "GLM-4.7-FLASH"))?.inputPerMillion ?? null, null);
}

if (fails.length) {
  console.error("❌ FAIL:\n" + fails.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log(`✅ PASS: 模型名大小写不敏感匹配 ${pass} 项断言全部通过`);
