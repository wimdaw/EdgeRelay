/**
 * tests/test-model-config.mjs
 * 模型配置规范化与上游同步的单元测试。
 *
 * 锁住三条产品规则：
 *  1. 对外模型名默认等于上游真实模型名；定价里显式改过的自定义名保留；
 *  2. 所有模型优先级统一为 10；
 *  3. 供应商刷新以上游列表为准：多的删、缺的补，已有自定义定价不丢。
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  entryPoints: [join(root, "src", "model-config.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
  logLevel: "silent",
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
);

let pass = 0;
let fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`✅ PASS: ${name}`);
    pass++;
  } else {
    console.error(`❌ FAIL: ${name}\n  actual:   ${a}\n  expected: ${e}`);
    fail++;
  }
}

let seq = 0;
const model = (over = {}) => ({
  id: `m_${++seq}`,
  publicName: "",
  providerId: "p1",
  upstreamModel: "",
  priority: 0,
  costWeight: 1,
  maxContext: null,
  enabled: 1,
  createdAt: 1,
  ...over,
});
const pricing = (name, over = {}) => ({
  id: `pr_${name}`,
  publicName: name,
  inputPerMillion: 0,
  outputPerMillion: 0,
  currency: "CNY",
  rpmLimit: null,
  createdAt: 1,
  ...over,
});
const idFactory = (prefix) => () => `${prefix}_${++seq}`;

/* ---------------- 1. 规范化：默认名与优先级 ---------------- */
{
  const r = mod.normalizeModels({
    models: [model({ publicName: "", upstreamModel: "gpt-4o", priority: 3 })],
    pricing: {},
  });
  eq("空对外名回落到上游真实名", r.models[0].publicName, "gpt-4o");
  eq("优先级统一为 10", r.models[0].priority, 10);
  eq("优先级修正计数", r.summary.priorityFixed, 1);
  eq("无自定义名时 customKept=0", r.summary.customKept, 0);
}

/* ---------------- 2. 规范化：定价里的自定义名保留 ---------------- */
{
  const r = mod.normalizeModels({
    models: [model({ publicName: "my-gpt", upstreamModel: "gpt-4o" })],
    pricing: { "my-gpt": pricing("my-gpt", { inputPerMillion: 3 }) },
  });
  eq("自定义对外名保留", r.models[0].publicName, "my-gpt");
  eq("自定义定价保留", r.pricing["my-gpt"].inputPerMillion, 3);
  eq("customKept=1", r.summary.customKept, 1);
  eq("没有产生改名", r.summary.renamed, 0);
}

/* ---------------- 3. 规范化：仅大小写差异跟随上游 ---------------- */
{
  const r = mod.normalizeModels({
    models: [model({ publicName: "GPT-4O", upstreamModel: "gpt-4o" })],
    pricing: { "GPT-4O": pricing("GPT-4O", { inputPerMillion: 1 }) },
  });
  eq("仅大小写差异不算自定义名", r.models[0].publicName, "gpt-4o");
  eq("大小写改名时定价跟随迁移", r.pricing["gpt-4o"].inputPerMillion, 1);
  eq("旧的大小写键被清理", r.pricing["GPT-4O"], undefined);
}

/* ---------------- 4. 规范化：同渠道重复合并 ---------------- */
{
  const r = mod.normalizeModels({
    models: [
      model({ publicName: "x", upstreamModel: "x", enabled: 0 }),
      model({ publicName: "x", upstreamModel: "x", enabled: 1 }),
    ],
    pricing: {},
  });
  eq("同渠道同上游合并为一条", r.models.length, 1);
  eq("合并后保留启用态", r.models[0].enabled, 1);
  eq("deduped=1", r.summary.deduped, 1);
}

/* ---------------- 5. 同步：多的删、缺的补 ---------------- */
{
  const r = mod.planProviderSync({
    models: [
      model({ publicName: "a", upstreamModel: "a", priority: 2 }),
      model({ publicName: "x", upstreamModel: "x" }),
    ],
    pricing: { a: pricing("a", { inputPerMillion: 5 }), x: pricing("x", { inputPerMillion: 7 }) },
    providerId: "p1",
    upstreamModels: ["a", "b"],
    now: 100,
    newModelId: idFactory("m"),
    newPricingId: idFactory("pr"),
  });
  eq("新增上游模型", r.summary.added, ["b"]);
  eq("移除上游已不存在的模型", r.summary.removed, ["x"]);
  eq("已有模型的自定义定价保留", r.pricing.a.inputPerMillion, 5);
  eq("被移除模型的孤儿定价清理", r.pricing.x, undefined);
  eq("新增模型默认零价", r.pricing.b.inputPerMillion, 0);
  eq("新增模型名称取上游真实名", r.models.find((m) => m.upstreamModel === "b").publicName, "b");
  eq("同步后优先级为 10", r.models.every((m) => m.priority === 10), true);
  eq("渠道模型总数", r.summary.total, 2);
}

/* ---------------- 6. 同步：自定义对外名不被覆盖 ---------------- */
{
  const r = mod.planProviderSync({
    models: [model({ publicName: "alias", upstreamModel: "gpt-4o" })],
    pricing: { alias: pricing("alias", { inputPerMillion: 9 }) },
    providerId: "p1",
    upstreamModels: ["gpt-4o"],
    now: 100,
    newModelId: idFactory("m"),
    newPricingId: idFactory("pr"),
  });
  eq("上游仍在的自定义名模型不算移除", r.summary.removed, []);
  eq("自定义名保持不变", r.models[0].publicName, "alias");
  eq("自定义定价保持不变", r.pricing.alias.inputPerMillion, 9);
  eq("总数仍为 1", r.summary.total, 1);
}

/* ---------------- 7. 同步：新增命中已有定价配置 ---------------- */
{
  const r = mod.planProviderSync({
    models: [],
    pricing: { n: pricing("n", { inputPerMillion: 2, outputPerMillion: 4 }) },
    providerId: "p1",
    upstreamModels: ["n"],
    now: 100,
    newModelId: idFactory("m"),
    newPricingId: idFactory("pr"),
  });
  eq("新增模型沿用已有定价", [r.pricing.n.inputPerMillion, r.pricing.n.outputPerMillion], [2, 4]);
  eq("新增模型名称", r.models[0].publicName, "n");
  eq("新增计数", r.summary.added, ["n"]);
}

/* ---------------- 8. 渠道免费模型白名单 ---------------- */
{
  eq(
    "cline 只保留零扣费模型",
    mod.filterProviderModels("cline-oauth", "oauth:cline", ["a/b:free", "~c/d", "e/f:batch", "cline-free/x"]),
    ["a/b:free", "cline-free/x"]
  );
  eq(
    "bigmodel 只保留免费 Flash（排除 FlashX）",
    mod.filterProviderModels("bigmodel", "openai_compat", ["glm-5.3-flash", "glm-5.3-flashx", "glm-5", "glm-4.5-air"]),
    ["glm-5.3-flash"]
  );
  eq("其他渠道不做过滤", mod.filterProviderModels("google", "openai_compat", ["a", "b"]), ["a", "b"]);
  eq(
    "agnes 只保留 flash 免费档",
    mod.filterProviderModels("agnes", "openai_compat", ["agnes-3.0-flash", "agnes-2.5-pro", "agnes-image-2.5-flash", "agnes-video-2.5"]),
    ["agnes-3.0-flash", "agnes-image-2.5-flash"]
  );
  eq(
    "trae 排除手工追加的 agnes 模型",
    mod.filterProviderModels("trae-cn-oauth", "oauth:trae", ["deepseek-V3", "agnes/agnes-3.0-flash"]),
    ["deepseek-V3"]
  );
  eq(
    "chatgpt-web 排除灰度占位模型",
    mod.filterProviderModels("chatgpt-web", "web:chatgptweb", ["gpt-6", "chatgpt_alpha_model_external_access_reserved_gate_12"]),
    ["gpt-6"]
  );
  eq(
    "antigravity 排除 disabled 占位模型",
    mod.filterProviderModels("antigravity-oauth", "oauth:antigravity", ["gemini-4-hydrogen-high", "gemini-4-neon-disabled"]),
    ["gemini-4-hydrogen-high"]
  );
}

/* ---------------- 9. bigmodel 目录补齐 ---------------- */
{
  const a = mod.augmentProviderModels("bigmodel", "openai_compat", ["glm-5.3-flash", "glm-5.4"]);
  eq("bigmodel 补齐目录遗漏的免费 flash", a.length, 9);
  eq("补齐项包含 glm-4.7-flash", a.includes("glm-4.7-flash"), true);
  eq("补齐不产生重复", new Set(a.map((x) => x.toLowerCase())).size, a.length);
  eq("其他渠道不补齐", mod.augmentProviderModels("google", "openai_compat", ["a"]), ["a"]);
}

console.log(`\n${fail === 0 ? "🎉 全部通过" : "❌ 存在失败"}：成功 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
