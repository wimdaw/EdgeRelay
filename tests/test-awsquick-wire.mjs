/**
 * tests/test-awsquick-wire.mjs
 * Amazon Quick 协议层单元测试（纯函数）。
 *
 * 锁住最容易"本地看起来没问题、上线就空回包"的四类行为：
 *  1. 模型档位 / 思考强度后缀解析
 *  2. OpenAI messages → Quick 单条 user_message 的扁平化
 *  3. AIDP 出站信封与 AWS EventStream 入站帧解码（含跨分片）
 *  4. 凭据 JSON 解析（snake_case / camelCase 兼容）
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = await build({
  entryPoints: [join(root, "src", "oauth", "awsquick-wire.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
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

// ---------- 模型解析 ----------
eq("amazon-smart", mod.resolveAwsquickModel("amazon-smart").slot, "smart");
eq("SMART 大小写", mod.resolveAwsquickModel("SMART").slot, "smart");
eq("aws-quick/balanced 前缀", mod.resolveAwsquickModel("aws-quick/balanced").slot, "balanced");
eq("qw-fast 前缀", mod.resolveAwsquickModel("qw-fast").slot, "fast");
eq("claude-opus → smart", mod.resolveAwsquickModel("claude-opus-4-6").slot, "smart");
eq("claude-sonnet → balanced", mod.resolveAwsquickModel("claude-sonnet-4-5").slot, "balanced");
eq("claude-haiku → fast", mod.resolveAwsquickModel("claude-haiku-4-5").slot, "fast");
eq("思考后缀 high", mod.resolveAwsquickModel("amazon-smart-high").effort, "high");
eq("思考后缀 off", mod.resolveAwsquickModel("amazon-balanced-off").effort, "off");
eq("未知模型回落 smart", mod.resolveAwsquickModel("totally-unknown").slot, "smart");
eq("未知模型 known=false", mod.resolveAwsquickModel("totally-unknown").known, false);
eq("空模型默认 smart", mod.resolveAwsquickModel("").slot, "smart");

// ---------- 提示词扁平化 ----------
const single = mod.flattenQuickPrompt([{ role: "user", content: "你好" }]);
eq("单条 user 直通", single.prompt, "你好");
eq("系统提示词提取", mod.flattenQuickPrompt([
  { role: "system", content: "你是助手" },
  { role: "user", content: "hi" },
]).system, "你是助手");
const multi = mod.flattenQuickPrompt([
  { role: "system", content: "SYS" },
  { role: "user", content: "第一问" },
  { role: "assistant", content: "第一答" },
  { role: "user", content: "第二问" },
]);
eq("多轮前缀", multi.prompt, "User: 第一问\n\nAssistant: 第一答\n\nUser: 第二问");
const toolCall = mod.flattenQuickPrompt([
  { role: "user", content: "查天气" },
  {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: '{"city":"上海"}' } }],
  },
  { role: "tool", tool_call_id: "call_1", name: "get_weather", content: "晴" },
  { role: "user", content: "谢谢" },
]);
eq(
  "工具调用/结果文本化",
  toolCall.prompt,
  'User: 查天气\n\nAssistant tool call (id=call_1, name=get_weather): {"city":"上海"}\n\nTool result (call_id=call_1, name=get_weather): 晴\n\nUser: 谢谢'
);
eq("多模态文本拼接", mod.quickContentText([
  { type: "text", text: "看图" },
  { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
]), "看图[image]");

// ---------- AIDP 出站 ----------
const aidp = JSON.parse(mod.encodeAidp({ type: "ping" }).toString("utf8"));
eq("AIDP eventType", aidp.eventType, "rawInputEvent");
eq("AIDP base64 内层", JSON.parse(Buffer.from(aidp.payload.payload, "base64").toString("utf8")).type, "ping");

// ---------- EventStream 入站 ----------
function eventStreamFrame(inner) {
  const b64 = Buffer.from(JSON.stringify(inner), "utf8").toString("base64");
  const payload = Buffer.from(JSON.stringify({ payload: b64 }), "utf8");
  const total = 12 + payload.length + 4;
  const buf = Buffer.alloc(total);
  buf.writeUInt32BE(total, 0);
  buf.writeUInt32BE(0, 4);
  buf.writeUInt32BE(mod.crc32(buf.subarray(0, 8)), 8);
  payload.copy(buf, 12);
  buf.writeUInt32BE(mod.crc32(buf.subarray(0, total - 4)), total - 4);
  return buf;
}

const dec1 = new mod.QuickWireDecoder();
const frames1 = dec1.feed(eventStreamFrame({ type: "text_delta", payload: { delta: "你" } }));
eq("EventStream 单帧", frames1.length ? JSON.parse(frames1[0]).payload.delta : null, "你");

const dec2 = new mod.QuickWireDecoder();
const wire = eventStreamFrame({ type: "text_delta", payload: { delta: "好" } });
eq("跨分片第 1 段无输出", dec2.feed(wire.subarray(0, 10)).length, 0);
eq("跨分片第 2 段无输出", dec2.feed(wire.subarray(10, 20)).length, 0);
const frames2 = dec2.feed(wire.subarray(20));
eq("跨分片末段补齐", frames2.length ? JSON.parse(frames2[0]).payload.delta : null, "好");

const dec3 = new mod.QuickWireDecoder();
const plain = dec3.feed(Buffer.from(JSON.stringify({ type: "text_delta", payload: { delta: "纯JSON" } })));
eq("纯 JSON 文本帧兜底", plain.length ? JSON.parse(plain[0]).payload.delta : null, "纯JSON");

// ---------- 凭据解析 ----------
const cred = mod.parseAwsquickCredential(JSON.stringify({
  provider: "social",
  access_token: "at",
  refresh_token: "rt",
  tenant_url: "https://cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
  email: "u@example.com",
  uid: "u@example.com",
  ws_host: "cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev",
}));
eq("snake_case 凭据 accessToken", cred?.accessToken, "at");
eq("snake_case 凭据 refreshToken", cred?.refreshToken, "rt");
eq("snake_case 凭据 wsHost", cred?.wsHost, "cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev");
eq("凭据 uid", cred?.uid, "u@example.com");
eq("非 JSON 凭据拒绝", mod.parseAwsquickCredential("rt-only"), null);
eq("缺 token 凭据拒绝", mod.parseAwsquickCredential(JSON.stringify({ tenantUrl: "https://x.amazonaws.com" })), null);

// ---------- 截断 ----------
const cut = mod.middleCutUtf8("汉".repeat(1000), 300);
eq("中段截断后不超限", Buffer.byteLength(cut, "utf8") <= 300, true);
eq("截断标记存在", cut.includes("shortened"), true);

// ---------- 工具桥接 ----------
const toolDefs = mod.extractQuickToolDefs([
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取本地文件",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  { name: "write_file", description: "写入本地文件", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
]);
eq("工具定义数量", toolDefs.length, 2);
eq("工具定义名称", toolDefs.map((d) => d.name).join(","), "read_file,write_file");
const choiceFn = mod.parseQuickToolChoice({ type: "function", function: { name: "read_file" } });
eq("tool_choice function", choiceFn.mode + ":" + choiceFn.name, "function:read_file");
eq("tool_choice none", mod.parseQuickToolChoice("none").mode, "none");
const bridgePrompt = mod.buildQuickToolBridgePrompt(toolDefs, mod.parseQuickToolChoice("auto"), true);
eq("桥接提示含协议标签", bridgePrompt.includes("<client_tool_protocol>") && bridgePrompt.includes("</client_tool_protocol>"), true);
eq("桥接提示含工具名", bridgePrompt.includes("read_file"), true);
eq("桥接提示含标签格式", bridgePrompt.includes("<client_tool_call>"), true);
const requiredPrompt = mod.buildQuickToolBridgePrompt(toolDefs, mod.parseQuickToolChoice("required"), false);
eq("required 声明", requiredPrompt.includes("At least one tool call is required"), true);
eq("单工具限制", requiredPrompt.includes("Emit at most one tool call"), true);
eq("tool_choice=none 不注入", mod.buildQuickToolBridgePrompt(toolDefs, mod.parseQuickToolChoice("none"), true), "");

const allowed = new Set(["read_file", "write_file"]);
const marked = mod.parseQuickClientToolCalls(
  '好的，我来读取文件。<client_tool_call>{"name":"read_file","arguments":{"path":"/tmp/a.txt"}}</client_tool_call>',
  allowed
);
eq("标签解析文本清理", marked.text, "好的，我来读取文件。");
eq("标签解析工具名", marked.calls[0]?.name, "read_file");
eq("标签解析参数", JSON.parse(marked.calls[0]?.arguments || "{}").path, "/tmp/a.txt");
eq("未知工具不解析", mod.parseQuickClientToolCalls('<client_tool_call>{"name":"rm_rf","arguments":{}}</client_tool_call>', allowed).calls.length, 0);
const bare = mod.parseQuickClientToolCalls('```json\n{"name":"write_file","arguments":{"path":"/tmp/b.txt","content":"hi"}}\n```', allowed);
eq("裸 JSON 兜底工具名", bare.calls[0]?.name, "write_file");
eq("裸 JSON 兜底清除正文", bare.text, "");

const emitted = [];
const stream = new mod.QuickBridgeStream(allowed, (t) => emitted.push(t));
stream.push("我来帮你");
stream.push("读取。<client_tool");
stream.push('_call>{"name":"read_file","arguments":{"path":"/tmp/c.txt"}}</client_tool_');
stream.push("call>");
const streamCalls = stream.finish();
eq("流式文本不含标签", emitted.join(""), "我来帮你读取。");
eq("流式解析工具调用", streamCalls[0]?.name, "read_file");
eq("流式工具参数", JSON.parse(streamCalls[0]?.arguments || "{}").path, "/tmp/c.txt");

const emitted2 = [];
const stream2 = new mod.QuickBridgeStream(allowed, (t) => emitted2.push(t));
for (const ch of "普通回答，没有工具调用。") stream2.push(ch);
eq("普通流式无工具调用", stream2.finish().length, 0);
eq("普通流式文本完整", emitted2.join(""), "普通回答，没有工具调用。");

const emitted3 = [];
const stream3 = new mod.QuickBridgeStream(allowed, (t) => emitted3.push(t));
for (const ch of '{"name":"read_file","arguments":{"path":"/tmp/d.txt"}}') stream3.push(ch);
const streamCalls3 = stream3.finish();
eq("流式裸 JSON 工具调用", streamCalls3[0]?.name, "read_file");
eq("流式裸 JSON 不泄漏正文", emitted3.join(""), "");

// ---------- 护栏重试脱敏 ----------
const dirty = [
  "Authorization: Bearer abcdefghijklmnop",
  "API Key: sk-1234567890abcdef",
  "github: ghp_1234567890abcdefghij",
  "password=hunter2hunter2",
  "postgresql://user:secretpass@db.example.com:5432/postgres",
  "JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456",
].join("\n");
const clean = mod.redactQuickSecrets(dirty);
eq("脱敏 Bearer", clean.includes("abcdefghijklmnop"), false);
eq("脱敏 sk", clean.includes("sk-1234567890abcdef"), false);
eq("脱敏 ghp", clean.includes("ghp_1234567890abcdefghij"), false);
eq("脱敏 password", clean.includes("hunter2hunter2"), false);
eq("脱敏 URL 密码", clean.includes("secretpass"), false);
eq("脱敏 JWT", clean.includes("eyJhbGciOiJIUzI1NiJ9"), false);
eq("普通文本不变", mod.redactQuickSecrets("你好，帮我读文件。"), "你好，帮我读文件。");

// ---------- 护栏伪正文识别 ----------
eq("护栏文本尚未完整", mod.couldBeQuickGuardrailText("That content did"), true);
eq("护栏文本完整", mod.isQuickGuardrailText("That content did not pass our automated check. Try asking again."), true);
eq("普通文本不是护栏", mod.couldBeQuickGuardrailText("你好"), false);
eq("护栏前缀不误伤普通英文", mod.isQuickGuardrailText("That sounds good"), false);

console.log(`\n=== awsquick-wire 单元测试：通过 ${pass} 项，失败 ${fail} 项 ===`);
if (fail) process.exit(1);
console.log("🎉 全部通过");
