/**
 * Amazon Quick 协议层（纯函数，移植自 xiangwen-ctrl/awsquick2api，MIT）
 *
 * 包含：
 *  - 模型档位解析（amazon-smart / balanced / fast / auto / advanced + 思考强度后缀）
 *  - OpenAI messages → Quick 单条 user_message 的提示词扁平化
 *  - AIDP 出站信封（base64 JSON）与 AWS EventStream 入站帧解码
 *  - 账号凭据 JSON 解析
 *
 * 与网络/存储无关，便于单测直接引用。
 */

export type AwsquickProvider = "social" | "enterprise";

export type AwsquickCredential = {
  v: 1;
  provider: AwsquickProvider;
  stage: string;
  region: string;
  idcRegion?: string;
  tenantUrl: string;
  wsHost: string;
  wsPath?: string;
  actorArn?: string;
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt?: number;
  tokenEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  resource?: string;
  issuerUrl?: string;
  email?: string;
  uid: string;
  awsAccountId?: string;
  accountName?: string;
};

export const AWSQUICK_MODELS = [
  "amazon-smart",
  "amazon-balanced",
  "amazon-fast",
  "amazon-auto",
  "amazon-advanced",
];

export const AWSQUICK_DEFAULT_MODELS = AWSQUICK_MODELS.slice(0, 4);

export const AWSQUICK_DEFAULT_WSPATH = "/streaming/quickwork-chat-bidirectional-stream";

export type QuickSlot = "smart" | "balanced" | "fast" | "auto" | "advanced";
export type QuickEffort = "off" | "low" | "medium" | "high";

const SLOT_IDS: Record<QuickSlot, string> = {
  smart: "amazon-smart",
  balanced: "amazon-balanced",
  fast: "amazon-fast",
  auto: "amazon-auto",
  advanced: "amazon-advanced",
};

/** 归一化思考强度（对齐 awsquick2api NormalizeEffort） */
export function normalizeQuickEffort(raw: unknown): QuickEffort {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return "off";
  if (v === "off" || v === "none" || v === "disabled" || v === "false" || v === "0") return "off";
  if (v === "minimal" || v === "low") return "low";
  if (v === "high" || v === "max" || v === "xhigh" || v === "enabled" || v === "adaptive") return "high";
  return "medium";
}

/**
 * 解析请求模型 → Quick agent_mode 档位。
 * 支持 amazon-smart / smart / qw-smart / aws-quick/smart，后缀 -off/-low/-medium/-high，
 * 以及 claude-opus/sonnet/haiku 别名（与上游目录保持一致）。
 */
export function resolveAwsquickModel(requested: string): { slot: QuickSlot; modelId: string; effort: QuickEffort; known: boolean } {
  const cleaned = String(requested || "").trim().replace(/\[[^\]]*\]/g, "");
  let key = cleaned.toLowerCase();
  if (!key) return { slot: "smart", modelId: SLOT_IDS.smart, effort: "off", known: true };
  if (key.includes("/")) key = key.slice(key.lastIndexOf("/") + 1);
  if (key.startsWith("qw-")) key = key.slice(3);

  let effort: QuickEffort = "off";
  for (const suffix of ["-off", "-low", "-medium", "-high"] as const) {
    if (key.endsWith(suffix) && key.length > suffix.length) {
      key = key.slice(0, -suffix.length);
      effort = normalizeQuickEffort(suffix.slice(1));
      break;
    }
  }

  const direct: Record<string, QuickSlot> = {
    "amazon-smart": "smart",
    smart: "smart",
    "amazon-balanced": "balanced",
    balanced: "balanced",
    "amazon-fast": "fast",
    fast: "fast",
    "amazon-auto": "auto",
    auto: "auto",
    "amazon-advanced": "advanced",
    advanced: "advanced",
  };
  if (direct[key]) return { slot: direct[key], modelId: direct[key], effort, known: true };

  if (key.startsWith("claude-")) {
    const slot: QuickSlot = key.includes("haiku") ? "fast" : key.includes("opus") ? "smart" : "balanced";
    return { slot, modelId: slot, effort, known: true };
  }

  return { slot: "smart", modelId: "smart", effort, known: false };
}

/** 提取消息内容为纯文本（图片只保留占位符，v1 不上传附件） */
export function quickContentText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      parts.push(raw);
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const part = raw as Record<string, any>;
    const type = String(part.type || "");
    if (type === "text" || type === "input_text" || type === "output_text") {
      if (typeof part.text === "string") parts.push(part.text);
    } else if (type === "image_url" || type === "input_image") {
      parts.push("[image]");
    } else if (type === "input_audio") {
      parts.push("[audio]");
    } else if (type === "file") {
      parts.push("[file]");
    } else if (typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("");
}

export function quickArgumentString(raw: unknown): string {
  if (raw == null) return "{}";
  if (typeof raw === "string") return raw.trim() || "{}";
  try {
    return JSON.stringify(raw);
  } catch {
    return "{}";
  }
}

function messageRole(m: Record<string, any>): string {
  return String(m?.role ?? "user").trim().toLowerCase() || "user";
}

function isSystemRole(role: string): boolean {
  return role === "system" || role === "developer";
}

/** 系统提示词（system + developer 顺序拼接） */
export function quickSystemText(messages: any[]): string {
  const out: string[] = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== "object") continue;
    if (!isSystemRole(messageRole(m))) continue;
    const text = quickContentText((m as Record<string, any>).content).trim();
    if (text) out.push(text);
  }
  return out.join("\n\n");
}

/**
 * OpenAI messages → Quick user_message 文本。
 * 单条 user 消息直接透传；多轮对话按角色加前缀，工具调用/结果转成文本行。
 */
export function flattenQuickPrompt(messages: any[]): { prompt: string; system: string } {
  const list = Array.isArray(messages) ? messages : [];
  const system = quickSystemText(list);
  const blocks: string[] = [];
  let turnCount = 0;
  let onlyUserText: string | null = null;

  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, any>;
    const role = messageRole(m);
    if (isSystemRole(role)) continue;
    turnCount++;
    const content = quickContentText(m.content);
    const hasContent = content.trim() !== "";
    if (role !== "user") onlyUserText = null;
    if (role === "user") onlyUserText = content;

    switch (role) {
      case "assistant": {
        if (hasContent) blocks.push(`Assistant: ${content}`);
        const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
        for (const item of toolCalls) {
          const tc = item as Record<string, any>;
          const fn = (tc?.function ?? {}) as Record<string, any>;
          const id = String(tc?.id ?? "").trim() || "unknown";
          const name = String(fn?.name ?? "").trim() || "unknown";
          blocks.push(`Assistant tool call (id=${id}, name=${name}): ${quickArgumentString(fn?.arguments)}`);
        }
        break;
      }
      case "tool": {
        const id = String(m.tool_call_id ?? "").trim();
        const name = String(m.name ?? "").trim();
        const meta = [id ? `call_id=${id}` : "", name ? `name=${name}` : ""].filter(Boolean);
        const body = hasContent ? content : "(empty)";
        blocks.push(meta.length ? `Tool result (${meta.join(", ")}): ${body}` : `Tool result: ${body}`);
        break;
      }
      case "function": {
        const name = String(m.name ?? "").trim();
        const body = hasContent ? content : "(empty)";
        blocks.push(name ? `Function result (name=${name}): ${body}` : `Function result: ${body}`);
        break;
      }
      case "user":
        if (hasContent) blocks.push(`User: ${content}`);
        break;
      default:
        if (hasContent) blocks.push(`${role.slice(0, 1).toUpperCase()}${role.slice(1)}: ${content}`);
    }
  }

  if (!blocks.length) return { prompt: "", system };
  if (turnCount === 1 && onlyUserText !== null) return { prompt: onlyUserText, system };
  return { prompt: blocks.join("\n\n"), system };
}

/** 按 UTF-8 字节数做中段截断，避免超过 Quick 的 64 KB 单帧上限 */
export function middleCutUtf8(text: string, maxBytes: number, note = "\n…[shortened to fit 64 KB message limit]…\n"): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const noteBytes = Buffer.byteLength(note, "utf8");
  const room = Math.max(0, maxBytes - noteBytes);
  const head = Math.floor(room / 2);
  const tail = room - head;
  // 按字符边界裁剪，避免截断多字节字符
  const chars = [...text];
  let headText = "";
  let used = 0;
  for (const ch of chars) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > head) break;
    headText += ch;
    used += n;
  }
  let tailText = "";
  used = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const n = Buffer.byteLength(chars[i]!, "utf8");
    if (used + n > tail) break;
    tailText = chars[i] + tailText;
    used += n;
  }
  return headText + note + tailText;
}

/** 解析凭据 JSON；非 JSON 或缺少关键字段返回 null */
export function parseAwsquickCredential(raw: string): AwsquickCredential | null {
  const text = String(raw ?? "").trim();
  if (!text.startsWith("{")) return null;
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const accessToken = String(j.accessToken ?? j.access_token ?? "").trim();
  const refreshToken = String(j.refreshToken ?? j.refresh_token ?? "").trim();
  const tenantUrl = String(j.tenantUrl ?? j.tenant_url ?? "").trim();
  const wsHost = String(j.wsHost ?? j.ws_host ?? "").trim() || (tenantUrl ? tenantUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : "");
  if (!accessToken && !refreshToken) return null;
  if (!wsHost && !tenantUrl) return null;
  const providerRaw = String(j.provider ?? "social").toLowerCase();
  const provider: AwsquickProvider = providerRaw === "enterprise" ? "enterprise" : "social";
  const identity = String(j.email ?? j.actorArn ?? j.actor_arn ?? j.uid ?? "").trim();
  return {
    v: 1,
    provider,
    stage: String(j.stage ?? "prod"),
    region: String(j.region ?? "us-east-1"),
    idcRegion: j.idcRegion ?? j.idc_region,
    tenantUrl: tenantUrl || `https://${wsHost}`,
    wsHost,
    wsPath: j.wsPath ?? j.ws_path,
    actorArn: j.actorArn ?? j.actor_arn,
    deviceId: String(j.deviceId ?? j.device_id ?? ""),
    accessToken,
    refreshToken,
    idToken: j.idToken ?? j.id_token,
    expiresAt: Number(j.expiresAt ?? j.expires_at ?? 0) || undefined,
    tokenEndpoint: j.tokenEndpoint ?? j.token_endpoint,
    clientId: j.clientId ?? j.client_id,
    clientSecret: j.clientSecret ?? j.client_secret,
    redirectUri: j.redirectUri ?? j.redirect_uri,
    resource: j.resource,
    issuerUrl: j.issuerUrl ?? j.issuer_url,
    email: j.email,
    uid: String(j.uid ?? identity),
    awsAccountId: j.awsAccountId ?? j.aws_account_id,
    accountName: j.accountName ?? j.account_name,
  };
}

// =====================================================================
// AWS EventStream 解码（入站 WebSocket 二进制帧）
// =====================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export type EventStreamMessage = {
  headers: Record<string, string | number | boolean | Uint8Array>;
  payload: Uint8Array;
};

function readU16(b: Uint8Array, i: number): number {
  return (b[i]! << 8) | b[i + 1]!;
}
function readU32(b: Uint8Array, i: number): number {
  return ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
}

function decodeEventHeaders(b: Uint8Array): Record<string, string | number | boolean | Uint8Array> {
  const out: Record<string, string | number | boolean | Uint8Array> = {};
  let i = 0;
  while (i < b.length) {
    const nameLen = b[i]!;
    i++;
    if (!nameLen || i + nameLen > b.length) throw new Error("invalid event header name");
    const name = Buffer.from(b.subarray(i, i + nameLen)).toString("utf8");
    i += nameLen;
    if (i >= b.length) throw new Error("truncated event header type");
    const type = b[i]!;
    i++;
    switch (type) {
      case 0:
        out[name] = true;
        break;
      case 1:
        out[name] = false;
        break;
      case 2:
        out[name] = b[i]!;
        i += 1;
        break;
      case 3:
        out[name] = readU16(b, i);
        i += 2;
        break;
      case 4:
        out[name] = readU32(b, i);
        i += 4;
        break;
      case 5:
      case 8: {
        const hi = readU32(b, i);
        const lo = readU32(b, i + 4);
        out[name] = hi * 0x100000000 + lo;
        i += 8;
        break;
      }
      case 6:
      case 7: {
        const n = readU16(b, i);
        i += 2;
        if (i + n > b.length) throw new Error("truncated event header value");
        const val = b.subarray(i, i + n);
        out[name] = type === 7 ? Buffer.from(val).toString("utf8") : val;
        i += n;
        break;
      }
      case 9:
        if (i + 16 > b.length) throw new Error("truncated event uuid header");
        out[name] = b.subarray(i, i + 16);
        i += 16;
        break;
      default:
        throw new Error(`unsupported event header type ${type}`);
    }
  }
  return out;
}

/** 解码一段完整的 AWS EventStream 帧集合 */
export function decodeEventStreamAll(data: Uint8Array): EventStreamMessage[] {
  const msgs: EventStreamMessage[] = [];
  let pos = 0;
  while (data.length - pos >= 12) {
    const total = readU32(data, pos);
    const headersLen = readU32(data, pos + 4);
    const preludeCrc = readU32(data, pos + 8);
    if (total < 16 || total > 16 * 1024 * 1024 || headersLen > total - 16) {
      throw new Error(`invalid event-stream lengths (total=${total} headers=${headersLen})`);
    }
    if (crc32(data, pos, pos + 8) !== preludeCrc) throw new Error("event-stream prelude CRC mismatch");
    if (data.length - pos < total) break;
    if (crc32(data, pos, pos + total - 4) !== readU32(data, pos + total - 4)) {
      throw new Error("event-stream message CRC mismatch");
    }
    const headers = decodeEventHeaders(data.subarray(pos + 12, pos + 12 + headersLen));
    const payload = data.subarray(pos + 12 + headersLen, pos + total - 4);
    msgs.push({ headers, payload: payload.slice() });
    pos += total;
  }
  return msgs;
}

/** 出站 AIDP 信封：{"eventType":"rawInputEvent","payload":{"payload":"<base64>"}} */
export function encodeAidp(value: unknown): Buffer {
  const json = JSON.stringify(value);
  return Buffer.from(
    JSON.stringify({ eventType: "rawInputEvent", payload: { payload: Buffer.from(json, "utf8").toString("base64") } }),
    "utf8"
  );
}

function headerString(headers: Record<string, any>, key: string): string {
  const v = headers[key];
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  return "";
}

/** 增量解码器：跨 WebSocket 分片拼接 EventStream / 纯 JSON 文本帧 */
export class QuickWireDecoder {
  private buf = Buffer.alloc(0);

  feed(chunk: Buffer | Uint8Array | string): string[] {
    const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;

    const raw = this.buf;
    if (raw.length >= 4) {
      const total = readU32(raw, 0);
      if (total >= 16 && total <= 16 * 1024 * 1024 && raw.length >= 12) {
        const headersLen = readU32(raw, 4);
        if (headersLen <= total - 16 && crc32(raw, 0, 8) === readU32(raw, 8)) {
          if (raw.length < total) return [];
          let msgs: EventStreamMessage[];
          try {
            msgs = decodeEventStreamAll(raw.subarray(0, total));
          } catch (err) {
            this.buf = Buffer.alloc(0);
            throw err;
          }
          this.buf = raw.subarray(total);
          const out: string[] = [];
          for (const msg of msgs) {
            const type = headerString(msg.headers, ":message-type");
            if (type === "error" || type === "exception") {
              const code = headerString(msg.headers, ":error-code") || headerString(msg.headers, ":exception-type");
              const message = headerString(msg.headers, ":error-message");
              throw new Error(`upstream error [${code}] ${message}`);
            }
            const evType = headerString(msg.headers, ":event-type");
            if (evType && evType !== "rawOutputEvent") continue;
            try {
              const outer = JSON.parse(Buffer.from(msg.payload).toString("utf8")) as { payload?: string };
              if (!outer?.payload) continue;
              out.push(Buffer.from(outer.payload, "base64").toString("utf8"));
            } catch {
              continue;
            }
          }
          return out;
        }
      }
    }

    // 兼容上游直接回纯 JSON 文本帧
    const text = raw.toString("utf8").trim();
    if (text.startsWith("{")) {
      try {
        JSON.parse(text);
        this.buf = Buffer.alloc(0);
        return [text];
      } catch {
        return [];
      }
    }
    return [];
  }
}

/** 构造 user_message 帧（对齐 awsquick2api buildUserMessageFrame） */
export function buildQuickUserMessageFrame(opts: {
  text: string;
  systemPrompt?: string;
  slot: QuickSlot;
  effort: QuickEffort;
  surface: string;
  outpostId: string;
  threadId: string;
  appVersion: string;
  timezone: string;
  locale: string;
}): Record<string, any> {
  let agentMode = opts.slot;
  let autoRouting = false;
  if (agentMode === "auto") {
    agentMode = "smart";
    autoRouting = true;
  }
  return {
    type: "user_message",
    payload: {
      text: opts.text,
      send_origin: "programmatic",
      had_physical_input: false,
      surfaceType: opts.surface,
      outpostId: opts.outpostId,
      appVersion: opts.appVersion,
      acp_first_text: 1,
      user_notification: 1,
      subtask_progress: 1,
      external_agent_sign_in: 1,
      recents_promotion: 1,
      traceId: randomUuid(),
      message_id: randomUuid(),
      thread_id: opts.threadId,
      agent_mode: agentMode,
      user_timezone: opts.timezone,
      user_locale: opts.locale,
      chat_agent_id: null,
      auto_routing: autoRouting,
      web_search_enabled: false,
      direct_chat: false,
      voice_mode: false,
      pre_approved_tools: [],
      preload_skills: [],
      panel_edits: [],
      custom_prompt: opts.systemPrompt?.trim() ? opts.systemPrompt : null,
      incognito: true,
      thinking_effort: opts.effort === "off" ? "off" : opts.effort,
    },
  };
}

export function randomUuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

export function quickSlotLabel(slot: QuickSlot): string {
  return SLOT_IDS[slot];
}

// =====================================================================
// 客户端工具桥接（prompt-based）
//
// Quick 原生只认自己的 Agent 工具；要让 Cline / Roo / OpenCode 等客户端
// 在本地执行 read_file / write_file 等工具，需要把客户端 tools 定义注入
// custom_prompt，并解析模型输出的 <client_tool_call> 标签，翻译成
// OpenAI 的 tool_calls。
// =====================================================================

export const QUICK_TOOL_OPEN = "<client_tool_call>";
export const QUICK_TOOL_CLOSE = "</client_tool_call>";

export type QuickToolDef = { name: string; description?: string; parameters?: any };
export type QuickToolChoice = { mode: "auto" | "none" | "required" | "function"; name?: string };
export type QuickToolCall = { id: string; name: string; arguments: string };

export function newQuickCallId(): string {
  return "call_" + randomUuid().replace(/-/g, "");
}

/** 从 OpenAI tools / functions 提取函数定义 */
export function extractQuickToolDefs(toolsRaw: any, funcsRaw?: any): QuickToolDef[] {
  const defs: QuickToolDef[] = [];
  const add = (fn: any) => {
    if (!fn || typeof fn !== "object") return;
    const name = String(fn.name ?? "").trim();
    if (!name) return;
    defs.push({
      name,
      ...(typeof fn.description === "string" && fn.description.trim() ? { description: fn.description.trim() } : {}),
      ...(fn.parameters != null ? { parameters: fn.parameters } : {}),
    });
  };
  if (Array.isArray(toolsRaw)) {
    for (const item of toolsRaw) {
      if (!item || typeof item !== "object") continue;
      if (item.function && typeof item.function === "object") add(item.function);
      else if (item.name != null) add(item);
    }
  }
  if (Array.isArray(funcsRaw)) {
    for (const item of funcsRaw) add(item);
  }
  return defs;
}

/** 归一化 tool_choice / function_call */
export function parseQuickToolChoice(raw: any): QuickToolChoice {
  if (typeof raw === "string") {
    const mode = raw.trim().toLowerCase();
    if (mode) return { mode: mode as QuickToolChoice["mode"] };
  } else if (raw && typeof raw === "object") {
    const fn = raw.function && typeof raw.function === "object" ? raw.function : null;
    const name = String(fn?.name ?? raw.name ?? "").trim();
    if (name) return { mode: "function", name };
    const typ = String(raw.type ?? "").trim().toLowerCase();
    if (typ) return { mode: typ as QuickToolChoice["mode"] };
  }
  return { mode: "auto" };
}

function compactQuickSchema(schema: any, depth = 0): string {
  if (!schema || typeof schema !== "object") return "any";
  if (Array.isArray(schema.enum) && schema.enum.length && schema.enum.length <= 8) {
    return schema.enum.map((v: any) => JSON.stringify(v)).join("|");
  }
  let type = "";
  if (typeof schema.type === "string") type = schema.type;
  else if (Array.isArray(schema.type)) {
    const found = schema.type.find((t: any) => typeof t === "string" && t !== "null");
    if (found) type = found;
  }
  if (type === "array") return compactQuickSchema(schema.items, depth + 1) + "[]";
  if (type === "object" || schema.properties) {
    const props = schema.properties;
    if (!props || typeof props !== "object" || depth >= 2) return "object";
    const keys = Object.keys(props).sort();
    if (!keys.length) return "object";
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    return "{" + keys.map((k) => `${k}${required.has(k) ? "*" : ""}: ${compactQuickSchema(props[k], depth + 1)}`).join(", ") + "}";
  }
  return type || "any";
}

function formatQuickToolListing(defs: QuickToolDef[]): string {
  const full = JSON.stringify(defs, null, 2);
  if (full.length <= 20_000) return full;
  const lines = defs.map((d) => {
    const params = d.parameters && typeof d.parameters === "object" ? d.parameters : null;
    const props = params?.properties && typeof params.properties === "object" ? params.properties : null;
    const required = new Set(Array.isArray(params?.required) ? params.required : []);
    const args = props
      ? Object.keys(props)
          .sort()
          .map((k) => `${k}${required.has(k) ? "*" : ""}: ${compactQuickSchema(props[k], 1)}`)
          .join(", ")
      : "";
    const desc = String(d.description || "").replace(/\s+/g, " ").slice(0, 160);
    return `- ${d.name}(${args})${desc ? ": " + desc : ""}`;
  });
  return "(name(arguments): description; * marks a required argument)\n" + lines.join("\n");
}

/** 构造工具调用协议提示词 */
export function buildQuickToolBridgePrompt(defs: QuickToolDef[], choice: QuickToolChoice, parallel = true): string {
  if (!defs.length || choice.mode === "none") return "";
  const lines = [
    "<client_tool_protocol>",
    "Available client-side tools:",
    formatQuickToolListing(defs),
    "",
    "Invoke a client tool by emitting a raw tag containing JSON (no Markdown fences):",
    `<client_tool_call>{"name":"TOOL_NAME","arguments":{...}}</client_tool_call>`,
    "Wait for the caller to return each tool result before continuing.",
    "IMPORTANT: If the user's request can be fulfilled by one of these tools, you MUST emit a tool call instead of answering from memory or using built-in web search. Do not fabricate tool results.",
  ];
  if (choice.mode === "function" && choice.name) lines.push(`Required tool: ${JSON.stringify(choice.name)}.`);
  if (choice.mode === "required") lines.push("At least one tool call is required in this response.");
  if (!parallel) lines.push("Emit at most one tool call in this turn.");
  lines.push("</client_tool_protocol>");
  return lines.join("\n");
}

function parseQuickToolEnvelopes(payload: string): Record<string, any>[] {
  const text = payload.trim();
  if (!text) return [];
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (Array.isArray(value)) return value.filter((x) => x && typeof x === "object");
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.tool_calls) && value.tool_calls.length) {
    return value.tool_calls.filter((x: any) => x && typeof x === "object");
  }
  return [value];
}

function quickToolCallsFromEnvelopes(envs: Record<string, any>[], allowed: Set<string>): QuickToolCall[] {
  const out: QuickToolCall[] = [];
  for (const env of envs) {
    const name = String(env.name ?? "").trim();
    if (!name || !allowed.has(name)) continue;
    out.push({ id: newQuickCallId(), name, arguments: quickArgumentString(env.arguments) });
  }
  return out;
}

/** 解析 <client_tool_call>...</client_tool_call>，保留无法识别的原始文本 */
export function extractQuickMarkedToolCalls(text: string, allowed: Set<string>): { text: string; calls: QuickToolCall[] } {
  if (!allowed.size) return { text, calls: [] };
  let clean = "";
  const calls: QuickToolCall[] = [];
  let rest = text;
  for (;;) {
    const start = rest.indexOf(QUICK_TOOL_OPEN);
    if (start < 0) break;
    const closeRel = rest.indexOf(QUICK_TOOL_CLOSE, start + QUICK_TOOL_OPEN.length);
    if (closeRel < 0) break;
    const end = closeRel;
    clean += rest.slice(0, start);
    const inner = rest.slice(start + QUICK_TOOL_OPEN.length, end);
    const parsed = quickToolCallsFromEnvelopes(parseQuickToolEnvelopes(inner), allowed);
    if (parsed.length) calls.push(...parsed);
    else clean += rest.slice(start, end + QUICK_TOOL_CLOSE.length);
    rest = rest.slice(end + QUICK_TOOL_CLOSE.length);
  }
  if (!calls.length) return { text, calls: [] };
  clean += rest;
  return { text: clean.trim(), calls };
}

/** 兜底：模型直接输出裸 JSON（可带 Markdown 围栏）而不是标签 */
export function extractQuickBareToolCalls(text: string, allowed: Set<string>): { text: string; calls: QuickToolCall[] } {
  if (!allowed.size) return { text, calls: [] };
  let trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    const nl = trimmed.indexOf("\n");
    if (nl >= 0) {
      trimmed = trimmed.slice(nl + 1).trim();
      if (trimmed.endsWith("```")) trimmed = trimmed.slice(0, -3).trim();
    }
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return { text, calls: [] };
  const calls = quickToolCallsFromEnvelopes(parseQuickToolEnvelopes(trimmed), allowed);
  return calls.length ? { text: "", calls } : { text, calls: [] };
}

export function parseQuickClientToolCalls(text: string, allowed: Set<string>): { text: string; calls: QuickToolCall[] } {
  const marked = extractQuickMarkedToolCalls(text, allowed);
  if (marked.calls.length) return marked;
  return extractQuickBareToolCalls(text, allowed);
}

/**
 * 流式工具桥：实时放行普通文本，但扣住可能的工具标签 / 裸 JSON，
 * 结束时统一解析为 tool_calls，避免把标签泄漏给客户端。
 */
export class QuickBridgeStream {
  private pending = "";
  private mode: "start" | "text" | "held" = "start";
  private emitted = false;

  constructor(
    private readonly allowed: Set<string>,
    private readonly onText?: (text: string) => void
  ) {}

  private emit(text: string): void {
    if (!text) return;
    if (!this.emitted && !text.trim()) {
      this.pending = text + this.pending;
      return;
    }
    this.emitted = true;
    this.onText?.(text);
  }

  push(delta: string): void {
    if (!delta) return;
    this.pending += delta;
    if (this.mode === "held") return;
    if (this.mode === "start") {
      const lead = this.pending.replace(/^[\s]+/, "");
      if (!lead) return;
      const first = lead[0]!;
      if (first === "{" || first === "[" || first === "`") {
        this.mode = "held";
        return;
      }
      this.mode = "text";
    }
    const idx = this.pending.indexOf(QUICK_TOOL_OPEN);
    if (idx >= 0) {
      const before = this.pending.slice(0, idx);
      this.pending = this.pending.slice(idx);
      this.mode = "held";
      this.emit(before);
      return;
    }
    let keep = 0;
    const maxPrefix = Math.min(QUICK_TOOL_OPEN.length - 1, this.pending.length);
    for (let n = maxPrefix; n > 0; n--) {
      if (QUICK_TOOL_OPEN.startsWith(this.pending.slice(this.pending.length - n))) {
        keep = n;
        break;
      }
    }
    const ready = this.pending.slice(0, this.pending.length - keep);
    this.pending = this.pending.slice(this.pending.length - keep);
    this.emit(ready);
  }

  finish(): QuickToolCall[] {
    const rest = this.pending;
    this.pending = "";
    const parsed = this.emitted
      ? extractQuickMarkedToolCalls(rest, this.allowed)
      : parseQuickClientToolCalls(rest, this.allowed);
    if (parsed.calls.length) {
      if (parsed.text.trim()) {
        this.emitted = true;
        this.onText?.(parsed.text);
      }
      return parsed.calls;
    }
    if (rest.trim() || this.emitted) this.emit(rest);
    return [];
  }
}

