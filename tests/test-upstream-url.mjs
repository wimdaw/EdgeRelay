/**
 * tests/test-upstream-url.mjs
 * 上游 API 路径拼接（joinApiPath）单元测试。
 *
 * 背景：Google Gemini 的 OpenAI 兼容端点 Base URL 是
 *   https://generativelanguage.googleapis.com/v1beta/openai
 * 版本段（/v1beta）不在路径末尾。旧实现只识别「结尾是版本段」的 Base URL，
 * 于是又把 /v1 补了一遍，实际请求变成
 *   /v1beta/openai/v1/chat/completions  → 上游 404
 * 结果 Google 渠道在控制台配得上、却发不出对话，也拉不到模型列表。
 *
 * 本测试锁定：Base URL 已含版本段时（无论在结尾还是中段）都不再重复补 /v1，
 * 同时保证其它渠道的拼接口径完全不变。
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  entryPoints: [join(root, "src", "providers.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
);
const { joinApiPath } = mod;
const { normalizeUpstreamModel } = mod;

let pass = 0;
const fails = [];
const eq = (name, got, want) => {
  if (got === want) {
    pass++;
  } else {
    fails.push(`${name}\n      实际: ${got}\n      期望: ${want}`);
  }
};

// Google：版本段在中段（本次修复的核心场景）
eq(
  "Google 对话路径不重复 /v1",
  joinApiPath("https://generativelanguage.googleapis.com/v1beta/openai", "/v1/chat/completions"),
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
);
eq(
  "Google 模型列表路径不重复 /v1",
  joinApiPath("https://generativelanguage.googleapis.com/v1beta/openai", "/v1/models"),
  "https://generativelanguage.googleapis.com/v1beta/openai/models"
);
eq(
  "Google Base URL 带结尾斜杠",
  joinApiPath("https://generativelanguage.googleapis.com/v1beta/openai/", "/v1/chat/completions"),
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
);

// 既有渠道：拼接口径必须保持原样
eq(
  "OpenAI 无版本段补 /v1",
  joinApiPath("https://api.openai.com", "/v1/chat/completions"),
  "https://api.openai.com/v1/chat/completions"
);
eq(
  "DeepSeek 无版本段补 /v1",
  joinApiPath("https://api.deepseek.com", "/v1/chat/completions"),
  "https://api.deepseek.com/v1/chat/completions"
);
eq(
  "DeepSeek Base URL 带 /v1 不重复",
  joinApiPath("https://api.deepseek.com/v1", "/v1/chat/completions"),
  "https://api.deepseek.com/v1/chat/completions"
);
eq(
  "Anthropic 原生 Messages 路径不变",
  joinApiPath("https://api.anthropic.com", "/v1/messages"),
  "https://api.anthropic.com/v1/messages"
);
eq(
  "智谱 BigModel /v4 不重复补版本",
  joinApiPath("https://open.bigmodel.cn/api/paas/v4", "/v1/chat/completions"),
  "https://open.bigmodel.cn/api/paas/v4/chat/completions"
);
eq(
  "Kilo 网关路径不变",
  joinApiPath("https://api.kilo.ai/api/gateway", "/v1/chat/completions"),
  "https://api.kilo.ai/api/gateway/v1/chat/completions"
);
eq(
  "OpenCode /zen/v1 不重复",
  joinApiPath("https://opencode.ai/zen/v1", "/v1/chat/completions"),
  "https://opencode.ai/zen/v1/chat/completions"
);
eq(
  "NVIDIA 无版本段补 /v1",
  joinApiPath("https://integrate.api.nvidia.com", "/v1/chat/completions"),
  "https://integrate.api.nvidia.com/v1/chat/completions"
);
eq(
  "AMD 无版本段补 /v1",
  joinApiPath("https://developer.amd.com.cn", "/v1/chat/completions"),
  "https://developer.amd.com.cn/v1/chat/completions"
);
eq(
  "通用 /v2 版本段",
  joinApiPath("https://api.example.com/v2", "/v1/chat/completions"),
  "https://api.example.com/v2/chat/completions"
);
// 版本的相似前缀不能被误判为版本段（如 /v1abc 不是版本段）
eq(
  "非版本段路径不误判",
  joinApiPath("https://api.example.com/v1abc", "/v1/chat/completions"),
  "https://api.example.com/v1abc/v1/chat/completions"
);

/* ---- 模型名归一化：Google 列表返回 models/xxx，对话接口只认裸名 ---- */
const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
eq(
  "Google 剥离 models/ 前缀",
  normalizeUpstreamModel("google", GOOGLE_BASE, "models/gemini-3.5-flash"),
  "gemini-3.5-flash"
);
eq(
  "Google 裸名保持不变",
  normalizeUpstreamModel("google", GOOGLE_BASE, "gemini-3.5-flash"),
  "gemini-3.5-flash"
);
eq(
  "Google 按 Base URL 识别（slug 非 google）",
  normalizeUpstreamModel("my-google", GOOGLE_BASE, "models/gemini-3.5-flash"),
  "gemini-3.5-flash"
);
eq(
  "非 Google 渠道不剥前缀",
  normalizeUpstreamModel("nvidia", "https://integrate.api.nvidia.com", "google/codegemma-7b"),
  "google/codegemma-7b"
);
eq(
  "其它渠道的 models/ 字面名原样保留",
  normalizeUpstreamModel("custom", "https://api.example.com/v1", "models/custom-model"),
  "models/custom-model"
);

if (fails.length) {
  console.error("❌ FAIL:\n" + fails.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log(`✅ PASS: 上游路径拼接 ${pass} 项断言全部通过`);
