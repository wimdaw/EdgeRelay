/**
 * 生图意图识别（各渠道共享）
 *
 * ZCode / Cherry Studio 等客户端通常不会发送非标准的 `image_generation` 字段，
 * 只会把「生成一张小猫图片」当作普通 user 文本。这里统一做两层判断：
 *  1. 显式信号：image_generation / enable_image_generation / image_generation 工具 / 生图模型名
 *  2. 自然语言意图：中英文「画/生成 + 图片类名词」
 *
 * 注意：自然语言判断保持保守，避免把「用 Python 生成图片的代码」这类技术讨论误判为必须生图。
 */

const IMAGE_TOOL_TYPES = new Set([
  "image_generation",
  "image_generation_preview",
  "generate_image",
]);

export function isImageTool(tool: unknown): boolean {
  if (!tool || typeof tool !== "object") return false;
  const type = typeof (tool as Record<string, unknown>).type === "string"
    ? ((tool as Record<string, unknown>).type as string).trim().toLowerCase()
    : "";
  return IMAGE_TOOL_TYPES.has(type);
}

export function hasImageTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;
  return tools.some(isImageTool);
}

/** 模型名本身是否表示生图模型（gpt-image-2 / dall-e-3 / duckai-image 等） */
export function isImageModelName(model: unknown): boolean {
  const value = String(model || "").toLowerCase();
  return /gpt-image|dall-e|^image-|duckai-image/.test(value);
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const record = part as Record<string, unknown>;
        if (typeof record.text === "string") return record.text;
        if (record.type === "input_text" && typeof record.input_text === "string") return record.input_text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
  }
  return "";
}

/** 取最后一条 user 消息的文本（兼容 string / parts 数组 / Responses input） */
export function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown> | null;
    if (!msg || typeof msg !== "object") continue;
    const role = String(msg.role || "").toLowerCase();
    if (role !== "user") continue;
    const text = contentToText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

const ZH_IMAGE_INTENT = /(?:画|绘制|生成|做|来|给我|帮我)[\s\S]{0,12}(?:一张|一幅|一个|张|幅|个)?[\s\S]{0,8}(?:图片|图像|照片|插画|海报|头像|壁纸|表情包|动图|图)/;
const EN_IMAGE_INTENT = /\b(?:draw|paint|generate|create|make)\b[\s\S]{0,30}\b(?:image|picture|photo|illustration|artwork|wallpaper|avatar|poster)\b/i;

/** 是否从最后一条 user 文本里识别到生图意图 */
export function looksLikeImageGenerationPrompt(messages: unknown): boolean {
  const text = lastUserText(messages);
  if (!text) return false;
  // 技术讨论（写代码/调 API/实现方案）不按生图处理，避免把「生成图片的代码怎么写」误判
  if (/(?:代码|脚本|接口|函数|实现|报错|错误|教程)/.test(text) || /\b(?:code|api|script|function|implementation|how\s+to|python|javascript|typescript)\b/i.test(text)) {
    return false;
  }
  return ZH_IMAGE_INTENT.test(text) || EN_IMAGE_INTENT.test(text);
}

/**
 * 综合判断一次对话请求是否要按「生图模式」处理：
 * 显式字段 / 生图工具 / 生图模型名 / 自然语言意图，任一命中即可。
 */
export function isImageIntentRequest(body: Record<string, any> | null | undefined, model?: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  if (body.image_generation === true || body.enable_image_generation === true) return true;
  if (isImageModelName(model ?? body.model)) return true;
  if (hasImageTool(body.tools)) return true;
  return looksLikeImageGenerationPrompt(body.messages ?? body.input);
}
