/**
 * 豆包工作版（Doubao 客户端「工作模式」）OAuth 反代 (provider kind = 'oauth:doubao')
 *
 * 协议移植自开源项目 doubao2api（github.com/yyydsz/doubao2api，MIT）：
 *  - 凭据：豆包 Web/客户端 Cookie（sessionid、sid_tt、ttwid、s_v_web_id、odin_tt、
 *    passport_csrf_token 等），整段粘贴进渠道 Key 池，AES-256-GCM 加密存储
 *  - 对话：POST https://www.doubao.com/chat/completion?aid=582478&...（工作模式 agent_mode=1），
 *    上游是私有 SSE 事件流（CHUNK_DELTA / STREAM_CHUNK / SSE_ACK / SSE_REPLY_END），
 *    这里翻译为 OpenAI 兼容流式 / JSON；正文增量优先 CHUNK_DELTA.text，
 *    兜底 STREAM_CHUNK block_type=10000 的 text_block.text，
 *    block_type=10040 thinking_block 为思考标题（→ reasoning_content）
 *  - 模型：内置 10 个工作模式模型（公开名 → 上游 model_item_key 别名）
 *  - 签到：POST /alice/ug/campaign/landing/checkin（scene=pc_incentive_task_mvp_v3，
 *    即工作模式「每日签到」活动），biz_params 必须是对象
 *
 * 说明：
 *  - 上游需要 Cookie 鉴权（无官方 API Key），device_id 由 Cookie 哈希稳定派生
 *  - 会话上下文：首轮把历史压成一段拼接文本（flatten），避免丢上下文
 *  - Token 用量上游不返回，按字符长度估算（与 Trae 渠道同策略）
 */
import type { Env } from "../types";
import { sha256Hex, randomHex, oauthErrorResponse, defer, recordOAuthUsage, type OAuthCallParams } from "./common";

/* =====================================================================
 * 常量与模型表
 * ===================================================================== */

const CHAT_URL = "https://www.doubao.com/chat/completion";
const CHECKIN_URL = "https://www.doubao.com/alice/ug/campaign/landing/checkin";
/** 实测：工作模式「每日签到」活动场景 */
const CHECKIN_SCENE = "pc_incentive_task_mvp_v3";
/** 无可用签到活动（账号未命中活动/无签到任务） */
const CODE_NO_CAMPAIGN = 710010702;

/** 豆包桌面客户端 UA（doubao2api 默认值，缺它上游可能识别为风控流量） */
const DOUBAO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/2.30.1";

/** /chat/completion 的固定查询参数（doubao2api 桌面客户端实抓） */
const CHAT_QUERY: Record<string, string> = {
  aid: "582478",
  real_aid: "582478",
  channel: "win",
  client_platform: "pc_client",
  device_platform: "web",
  doubao_device_platform: "desktop",
  doubao_pc_version: "2.30.1",
  pc_version: "2.30.1",
  pkg_type: "release_version",
  language: "zh",
  region: "CN",
  sys_region: "CN",
  runtime: "web",
  runtime_version: "3.37.4",
  samantha_web: "1",
  "use-olympus-account": "1",
  version_code: "20800",
  web_platform: "desktop",
  chromium_version: "147.0.7727.149",
};

/** 工作模式会话参数（doubao2api work_mode 默认值） */
const WORK_BOT_ID = "7338286299411103781";
const WORK_MODE_ID = "3";
const WORK_REASONING_EFFORT = 4;

export type DoubaoModelSpec = {
  /** 对外模型名 */
  name: string;
  /** 上游 model_item_key */
  itemKey: string;
  memoryProfile: string;
  totalWindowSize: string;
  display: string;
};

/** 豆包工作模式内置模型（glm-5.3 系上游偶发报错，保留可试） */
export const DOUBAO_MODELS: DoubaoModelSpec[] = [
  { name: "auto", itemKey: "9", memoryProfile: "256k", totalWindowSize: "256000", display: "自动" },
  { name: "doubao-2.1-lite", itemKey: "seed-lite-7b", memoryProfile: "256k", totalWindowSize: "256000", display: "豆包 2.1 Lite" },
  { name: "doubao-2.1-pro", itemKey: "5", memoryProfile: "256k", totalWindowSize: "256000", display: "豆包 2.1 Pro" },
  { name: "deepseek-v4-flash", itemKey: "person-deepseek-v4-1-flash-261017", memoryProfile: "300k_230", totalWindowSize: "300000", display: "DeepSeek V4.1 Flash" },
  { name: "deepseek-v4-pro", itemKey: "person-deepseek-v4-pro-ga-260813", memoryProfile: "300k_230", totalWindowSize: "300000", display: "DeepSeek V4 Pro" },
  { name: "kimi-k3", itemKey: "person-kimi-k3-261111", memoryProfile: "300k_230", totalWindowSize: "300000", display: "Kimi K3" },
  { name: "kimi-k3.1-pro", itemKey: "person-kimi-k3-1-pro-261111", memoryProfile: "300k_230", totalWindowSize: "300000", display: "Kimi K3.1 Pro" },
  { name: "kimi-k3.1-pro-fast", itemKey: "person-kimi-k3-1-pro-highspeed-261111", memoryProfile: "300k_230", totalWindowSize: "300000", display: "Kimi K3.1 Pro 高速" },
  { name: "glm-5.3", itemKey: "person-glm-5-3-261111", memoryProfile: "300k_230", totalWindowSize: "300000", display: "GLM 5.3" },
  { name: "glm-5.3-flash", itemKey: "person-glm-5-3-flash-261111", memoryProfile: "300k_230", totalWindowSize: "300000", display: "GLM 5.3 Flash" },
];

export const DOUBAO_MODEL_NAMES = DOUBAO_MODELS.map((m) => m.name);

function resolveModelSpec(modelId: string): DoubaoModelSpec {
  const found = DOUBAO_MODELS.find((m) => m.name === (modelId || "").trim());
  // 未收录的模型名按上游 item_key 直传，方便上游上新后无需发版即可试用
  return found ?? { name: modelId, itemKey: modelId, memoryProfile: "300k_230", totalWindowSize: "300000", display: modelId };
}

/* =====================================================================
 * Cookie 与设备指纹
 * ===================================================================== */

/** 校验 Cookie 至少包含 sessionid（豆包登录态核心字段） */
export function parseDoubaoCookie(raw: string): string | null {
  const cookie = (raw || "").trim();
  if (!cookie || !/sessionid\s*=/i.test(cookie)) return null;
  // 用户可能整行粘贴 "Cookie: xxx" 请求头，剥掉前缀
  return cookie.replace(/^cookie\s*:\s*/i, "").trim();
}

/** 由 Cookie 稳定派生 device_id（同一账号每次请求一致，降低风控扰动） */
async function deriveDeviceId(cookie: string): Promise<string> {
  const hex = await sha256Hex(cookie);
  return hex.slice(0, 16);
}

/* =====================================================================
 * 请求体构造（doubao2api BuildBody 的 TypeScript 移植，WorkMode + Flatten）
 * ===================================================================== */

function uuidV4(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  const h = randomHex(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function randomDigits(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

/** 抽取消息纯文本（content 为字符串或 OpenAI 分段数组） */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
      .join("")
      .trim();
  }
  return "";
}

export async function buildDoubaoChatBody(
  body: Record<string, any>,
  spec: DoubaoModelSpec
): Promise<string> {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length) throw new Error("messages 不能为空");

  // 最后一条 user 文本
  let lastUser = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUser = messageText(messages[i]?.content);
      break;
    }
  }
  if (!lastUser.trim()) throw new Error("缺少 user 消息");

  // 首轮（无会话续接）：把历史压成一段，避免丢上下文
  let text = lastUser;
  const lastIdx = messages.length - 1;
  const parts: string[] = [];
  for (let i = 0; i < lastIdx; i++) {
    const t = messageText(messages[i]?.content).trim();
    if (!t) continue;
    const role = messages[i]?.role === "assistant" ? "助手" : messages[i]?.role === "user" ? "用户" : String(messages[i]?.role || "system");
    parts.push(`${role}：${t}`);
  }
  if (parts.length) text = `${parts.join("\n")}\n用户：${lastUser}`;

  const msgId = uuidV4();
  const localConv = `local_${randomDigits(16)}`;
  const nowMs = Date.now();

  const block = {
    block_type: 10000,
    content: {
      text_block: { text, icon_url: "", icon_url_dark: "", summary: "" },
      pc_event_block: "",
    },
    block_id: uuidV4(),
    parent_id: "",
    meta_info: [],
    append_fields: [],
  };

  const taskParam = {
    runtime_type: 2,
    sandbox_auth_type: 1,
    device_name: "",
    folder_name: "",
    local_app_id: "582478",
    local_device_id: "",
    workspace: "",
  };

  const clientOption = {
    enable_sandbox: false,
    os: "Windows",
    shared_folder_path: [],
    agent_workspace: { agent_workspace: "", local_skill_paths: [] },
    client_env_id: uuidV4(),
    sandbox_id: `sandbox-${uuidV4()}`,
    sandbox_auth_type: 1,
  };

  const generalTaskParam = {
    action: 0,
    thread_local_message_id: [msgId],
    client_option: clientOption,
    runtime_type: 2,
    agent_task_param: taskParam,
    agent_task_param_change: { runtime_changed: false, device_changed: false, sandbox_auth_type_changed: false },
    need_modify_conversation: false,
    task_input_json: JSON.stringify({
      agents_md: { files: [], state: 2 },
      schema_version: 1,
      home_dir: "",
      project_context: {},
      localConnectors: [],
    }),
  };

  const option: Record<string, unknown> = {
    create_time_ms: nowMs,
    answer_with_suggest: false,
    agent_mode: 1,
    need_deep_think: 10001,
    unique_key: uuidV4(),
    start_seq: 0,
    need_create_conversation: true,
    conversation_init_option: { need_ack_conversation: true },
    sse_recv_event_options: { support_chunk_delta: true },
    support_lazy_fetch_stream: true,
    is_old_user: true,
    message_storage_type: 0,
    conversation_mode: 2,
    conversation_init_ext: {
      model_item_key: spec.itemKey,
      reasoning_effort: String(WORK_REASONING_EFFORT),
      mode_id: WORK_MODE_ID,
      agent_task_param: JSON.stringify(taskParam),
    },
    model_config: {
      model_item_key: spec.itemKey,
      model_extra_params: {
        memory_profile: spec.memoryProfile,
        total_window_size: spec.totalWindowSize,
      },
      reasoning_effort: WORK_REASONING_EFFORT,
    },
    aggregate_params: {
      mention_skill_list: "[]",
      mention_plugin_list: "[]",
      mention_ext: "[{}]",
      conversation_mode: "2",
      mode_id: WORK_MODE_ID,
      model_item_key: spec.itemKey,
      agent_mode: "1",
      reasoning_effort: String(WORK_REASONING_EFFORT),
      provider_id: "",
    },
    general_task_param: generalTaskParam,
    ext: {
      general_task_param: JSON.stringify(generalTaskParam),
      use_deep_think: "10001",
      agent_mode: "1",
      is_finish: "1",
      conversation_init_option: '{"need_ack_conversation":true}',
      commerce_credit_config_enable: "0",
    },
  };

  const payload = {
    client_meta: {
      local_conversation_id: localConv,
      conversation_id: "",
      bot_id: WORK_BOT_ID,
      last_section_id: "",
      last_message_index: null,
      local_permissions: [
        { permission_name: "ACCESS_COARSE_LOCATION", status: 1 },
        { permission_name: "ACCESS_FINE_LOCATION", status: 1 },
        { permission_name: "ACCESS_BACKGROUND_LOCATION", status: 1 },
      ],
    },
    messages: [{ local_message_id: msgId, content_block: [block], message_status: 0 }],
    option,
    user_context: [],
    ext: { use_deep_think: "10001", is_finish: "1" },
  };
  return JSON.stringify(payload);
}

/* =====================================================================
 * 上游 SSE 解析
 * ===================================================================== */

type DoubaoSink = {
  onText: (t: string) => void;
  onReasoning: (t: string) => void;
};

export type DoubaoAggregate = {
  content: string;
  reasoning: string;
  conversationId: string;
  endType: number | null;
  brief: string;
  error?: { code?: string | number; message: string };
};

/** 逐行解析豆包私有 SSE 事件流（event:/data: 结构，空行分发） */
async function pumpDoubaoSSE(
  stream: ReadableStream<Uint8Array>,
  sink: DoubaoSink & { onConversation?: (convId: string) => void; onFinish?: (endType: number, brief: string) => void }
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  const dataLines: string[] = [];
  let sawChunkDelta = false;

  const dispatch = () => {
    const payload = dataLines.join("\n").trim();
    const ev = event;
    event = "";
    dataLines.length = 0;
    if (!payload) return;
    try {
      const json = JSON.parse(payload);
      if (ev === "") {
        // data-only 帧：部分网关会剥掉 event 行，按字段特征识别
        if (typeof json?.text === "string" && json.text) {
          sawChunkDelta = true;
          sink.onText(json.text);
          return;
        }
      }
      switch (ev) {
        case "CHUNK_DELTA": {
          if (typeof json?.text === "string" && json.text) {
            sawChunkDelta = true;
            sink.onText(json.text);
          }
          break;
        }
        case "STREAM_CHUNK": {
          const ops = json?.patch_op || [];
          for (const op of ops) {
            const blocks = op?.patch_value?.content_block || [];
            for (const b of blocks) {
              if (b?.block_type === 10000) {
                const t = b?.content?.text_block?.text;
                if (!sawChunkDelta && typeof t === "string" && t) sink.onText(t);
              } else if (b?.block_type === 10040) {
                const th = b?.content?.thinking_block;
                const t = th?.streaming_title || th?.finish_title;
                if (typeof t === "string" && t) sink.onReasoning(t);
              }
            }
          }
          break;
        }
        case "SSE_ACK": {
          const conv = json?.ack_client_meta?.conversation_id;
          if (typeof conv === "string" && conv) sink.onConversation?.(conv);
          break;
        }
        case "SSE_REPLY_END": {
          sink.onFinish?.(Number(json?.end_type ?? 0), String(json?.msg_finish_attr?.brief ?? ""));
          break;
        }
      }
    } catch {
      /* 非 JSON 帧忽略 */
    }
  };

  const handleLine = (line: string) => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    } else if (line.startsWith(":")) {
      /* 注释帧 */
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      handleLine(line);
    }
  }
  if (buf.trim()) handleLine(buf.trim());
  dispatch();
}

/** 聚合豆包 SSE（非流式 / 连通性测试用） */
export async function consumeDoubaoStream(
  stream: ReadableStream<Uint8Array>,
  onEvent?: (text: string, reasoning: string) => void
): Promise<DoubaoAggregate> {
  const agg: DoubaoAggregate = { content: "", reasoning: "", conversationId: "", endType: null, brief: "" };
  await pumpDoubaoSSE(stream, {
    onText: (t) => {
      agg.content += t;
      onEvent?.(t, "");
    },
    onReasoning: (t) => {
      agg.reasoning += t;
      onEvent?.("", t);
    },
    onConversation: (c) => {
      agg.conversationId = c;
    },
    onFinish: (endType, brief) => {
      agg.endType = endType;
      agg.brief = brief;
    },
  });
  return agg;
}

/* =====================================================================
 * 上游调用
 * ===================================================================== */

async function buildChatUrl(deviceId: string): Promise<string> {
  const q = new URLSearchParams(CHAT_QUERY);
  q.set("device_id", deviceId);
  q.set("fp", `verify_${deviceId}`);
  q.set("tea_uuid", deviceId);
  q.set("web_tab_id", uuidV4());
  return `${CHAT_URL}?${q.toString()}`;
}

function chatHeaders(cookie: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "*/*",
    "agw-js-conv": "str, str",
    "last-event-id": "undefined",
    "x-flow-trace": "04-0000000000000000000000000000000-0000000000000000-01",
    "User-Agent": DOUBAO_UA,
    Referer: "https://www.doubao.com/",
    Cookie: cookie,
  };
}

/** 估算 Token 用量（上游不返回，按中英文混合 4 字符/token 粗估） */
function estimateUsage(promptChars: number, completionChars: number) {
  const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
  const completionTokens = Math.max(1, Math.ceil(completionChars / 4));
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
}

function openAiChunk(model: string, delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, number>): string {
  return `data: ${JSON.stringify({
    id: `chatcmpl-${randomHex(8)}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

function promptCharsOf(body: Record<string, any>): number {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.reduce((n: number, m: any) => n + messageText(m?.content).length, 0);
}

/* =====================================================================
 * OpenAI 兼容入口
 * ===================================================================== */

export async function handleDoubaoRequest(p: OAuthCallParams): Promise<Response> {
  const cookie = parseDoubaoCookie(p.refreshTokens?.[0] || "");
  if (!cookie) {
    return oauthErrorResponse(
      "该豆包渠道未配置有效凭据：请粘贴豆包 Web/客户端的整段 Cookie（需含 sessionid=...）",
      400,
      "configuration_error"
    );
  }
  const spec = resolveModelSpec(p.modelId || "deepseek-v4-flash");
  const stream = p.body?.stream === true;
  const requestedModel = p.requestedModel;
  const deviceId = await deriveDeviceId(cookie);

  let upstreamBody: string;
  try {
    upstreamBody = await buildDoubaoChatBody(p.body || {}, spec);
  } catch (err) {
    return oauthErrorResponse((err as Error).message || "请求体构造失败", 400, "invalid_request_error");
  }

  let upstream: Response;
  try {
    upstream = await fetch(await buildChatUrl(deviceId), {
      method: "POST",
      headers: chatHeaders(cookie),
      body: upstreamBody,
      signal: AbortSignal.timeout(300_000),
    });
  } catch (err) {
    return oauthErrorResponse(`豆包上游连接失败：${(err as Error).message}`, 502, "upstream_error");
  }

  if (!upstream.ok || !upstream.body) {
    const raw = await upstream.text().catch(() => "");
    let message = raw.slice(0, 300) || `HTTP ${upstream.status}`;
    try {
      const j = JSON.parse(raw);
      message = String(j?.message || j?.msg || message);
    } catch { /* 保持原文 */ }
    if (upstream.status === 401 || upstream.status === 403) {
      return oauthErrorResponse(`豆包 Cookie 失效或无权限（HTTP ${upstream.status}）：${message}，请更新渠道 Cookie`, 401, "authentication_error");
    }
    return oauthErrorResponse(`豆包上游错误（HTTP ${upstream.status}）：${message}`, upstream.status >= 500 ? 502 : upstream.status, "upstream_error");
  }

  if (stream) {
    return new Response(doubaoStreamToOpenAI(upstream.body, requestedModel, p, promptCharsOf(p.body || {})), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  }

  // 非流式：上游始终是 SSE，聚合后一次性返回
  const agg = await consumeDoubaoStream(upstream.body);
  if (!agg.content && !agg.brief) {
    return oauthErrorResponse(agg.error?.message || "豆包上游返回空内容", 502, "upstream_error");
  }
  const content = agg.brief && agg.endType === 1 ? agg.brief : agg.content;
  const usage = estimateUsage(promptCharsOf(p.body || {}), content.length + agg.reasoning.length);
  const message: Record<string, unknown> = { role: "assistant", content };
  if (agg.reasoning) message.reasoning_content = agg.reasoning;
  defer(p, recordOAuthUsage(p, { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }, true, 200));
  return new Response(
    JSON.stringify({
      id: `chatcmpl-${randomHex(8)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{ index: 0, message, finish_reason: "stop" }],
      usage,
    }),
    { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
  );
}

/** 豆包 SSE → 标准 OpenAI SSE（chat.ts 的用量旁路只认 OpenAI 格式） */
function doubaoStreamToOpenAI(
  body: ReadableStream<Uint8Array>,
  requestedModel: string,
  p: OAuthCallParams,
  promptChars: number
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let emittedRole = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          /* 下游已断开 */
        }
      };
      let content = "";
      let reasoning = "";
      try {
        await pumpDoubaoSSE(body, {
          onText: (t) => {
            content += t;
            const delta: Record<string, unknown> = {};
            if (!emittedRole) {
              delta.role = "assistant";
              emittedRole = true;
            }
            delta.content = t;
            push(openAiChunk(requestedModel, delta, null));
          },
          onReasoning: (t) => {
            reasoning += t;
            push(openAiChunk(requestedModel, emittedRole ? {} : { role: "assistant", reasoning_content: t }, null));
            emittedRole = true;
          },
        });
        const usage = estimateUsage(promptChars, content.length + reasoning.length);
        defer(p, recordOAuthUsage(p, { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }, true, 200));
        if (!content && !reasoning) {
          push(`data: ${JSON.stringify({ error: { message: "豆包上游返回空内容", type: "upstream_error" } })}\n\n`);
        }
        push(openAiChunk(requestedModel, {}, "stop", usage));
        push("data: [DONE]\n\n");
        controller.close();
      } catch (err) {
        try {
          push(`data: ${JSON.stringify({ error: { message: (err as Error).message || "豆包流解析失败", type: "upstream_error" } })}\n\n`);
          push("data: [DONE]\n\n");
        } catch { /* ignore */ }
        controller.close();
      }
    },
  });
}

/* =====================================================================
 * 连通性测试 / 模型清单
 * ===================================================================== */

export async function testDoubao(
  _env: Env,
  refreshToken: string,
  modelId: string
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const cookie = parseDoubaoCookie(refreshToken);
  if (!cookie) return { success: false, message: "凭据格式无效：需要包含 sessionid= 的整段豆包 Cookie", statusCode: 0 };
  const spec = resolveModelSpec(modelId || "deepseek-v4-flash");
  const deviceId = await deriveDeviceId(cookie);
  try {
    const body = await buildDoubaoChatBody({ messages: [{ role: "user", content: "hi" }] }, spec);
    const res = await fetch(await buildChatUrl(deviceId), {
      method: "POST",
      headers: chatHeaders(cookie),
      body,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        return { success: false, message: `Cookie 失效或无权限（HTTP ${res.status}），请更新豆包 Cookie`, statusCode: res.status };
      }
      return { success: false, message: `上游错误（HTTP ${res.status}）：${raw.slice(0, 160)}`, statusCode: res.status };
    }
    const agg = await consumeDoubaoStream(res.body);
    if (!agg.content && !agg.brief) return { success: false, message: "上游返回空内容", statusCode: 200 };
    return {
      success: true,
      message: `连接成功：${(agg.content || agg.brief).slice(0, 60)}`,
      statusCode: 200,
    };
  } catch (err) {
    return { success: false, message: (err as Error).message || "连接失败", statusCode: 0 };
  }
}

export async function fetchDoubaoModels(): Promise<{ models: string[]; message?: string }> {
  return { models: DOUBAO_MODEL_NAMES };
}

/* =====================================================================
 * 每日签到（工作模式「每日签到」活动）
 * ===================================================================== */

export type DoubaoCheckinResult = {
  ok: boolean;
  already?: boolean;
  reward?: number;
  message: string;
};

export async function checkinDoubao(env: Env, refreshToken: string): Promise<DoubaoCheckinResult> {
  void env;
  const cookie = parseDoubaoCookie(refreshToken);
  if (!cookie) return { ok: false, message: "凭据格式无效：需要包含 sessionid= 的整段豆包 Cookie" };
  const deviceId = await deriveDeviceId(cookie);
  const q = new URLSearchParams({ device_id: deviceId });
  try {
    const res = await fetch(`${CHECKIN_URL}?${q.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Referer: "https://www.doubao.com/",
        "User-Agent": DOUBAO_UA,
        Cookie: cookie,
      },
      // biz_params 必须是对象，传字符串会 400（doubao2api 实测注释）
      body: JSON.stringify({ scene: CHECKIN_SCENE, biz_params: {} }),
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, message: `签到返回无法解析（HTTP ${res.status}）：${raw.slice(0, 120)}` };
    }
    const code = Number(json?.code ?? -1);
    const msg = String(json?.message || json?.msg || "");
    const data = json?.data || {};

    if (code === CODE_NO_CAMPAIGN) return { ok: false, message: "当前账号无可用签到活动（未命中工作模式签到任务）" };
    if (res.status !== 200 || code !== 0) {
      if (/已签到|already/i.test(msg)) return { ok: true, already: true, message: "今日已签到" };
      return { ok: false, message: `签到未成功：${msg || `code ${code}`}（HTTP ${res.status}）` };
    }
    const reward = Number(data?.reward_amount ?? 0) || 0;
    const days = Number(data?.continuous_days ?? 0) || 0;
    if (data?.idempotent) {
      return { ok: true, already: true, reward: reward || undefined, message: reward > 0 ? `今日已签到（${reward} 积分，连签 ${days} 天）` : "今日已签到（幂等命中）" };
    }
    if (data?.checked_in) {
      return { ok: true, reward: reward || undefined, message: reward > 0 ? `签到成功，+${reward} 积分${days ? `（连签 ${days} 天）` : ""}` : "签到成功" };
    }
    if (/已签到|already/i.test(msg)) return { ok: true, already: true, message: "今日已签到" };
    return { ok: false, message: `签到返回异常：${msg || JSON.stringify(data).slice(0, 120)}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message || "签到异常" };
  }
}
