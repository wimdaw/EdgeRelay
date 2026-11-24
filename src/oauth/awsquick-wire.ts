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
