/**
 * Duck.ai 图片生成输出
 * 对齐 LandmineHQ/duckai-cpa（src/duck/sse.js:382、src/openai/chat.js:610-750）：
 * - 上游事件 role:"generated-image"，base64 在 result，格式在 format（默认 jpeg）
 * - 对客户端按 message.images = [{ type:"image_url", image_url:{ url:"data:image/<fmt>;base64,..." } }] 暴露
 */

export type DuckAiGeneratedImage = {
  b64: string;
  format: string;
  width?: number;
  height?: number;
  /** true 表示上游仍在生成中的分片图，最终图到达后应被替换 */
  partial?: boolean;
};

export type DuckAiChatImage = {
  type: "image_url";
  image_url: { url: string };
};

const IMAGE_TOOL_TYPES = new Set(["image_generation", "image_generation_preview", "generate_image"]);

/** 是否显式请求图片生成：tools[type=image_generation] 或 image_generation 快捷字段，或模型名称具生图特征。 */
export function isImageGenerationEnabled(tools: unknown, imageGeneration: unknown, model?: unknown): boolean {
  if (imageGeneration === true) return true;
  if (typeof model === "string" && /gpt-image|dall-e|^image-|duckai-image/i.test(model)) return true;
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => {
    if (!tool || typeof tool !== "object") return false;
    const type = typeof (tool as Record<string, unknown>).type === "string"
      ? ((tool as Record<string, unknown>).type as string).trim().toLowerCase()
      : "";
    return IMAGE_TOOL_TYPES.has(type);
  });
}

export function extractGeneratedImage(ev: Record<string, unknown>): DuckAiGeneratedImage | null {
  // 旧形态：role:"generated-image"，base64 在 result
  if (ev.role === "generated-image") {
    const b64 = typeof ev.result === "string" ? ev.result.trim() : "";
    if (!b64) return null;
    const format = typeof ev.format === "string" && ev.format ? ev.format.toLowerCase() : "jpeg";
    const image: DuckAiGeneratedImage = { b64, format };
    if (typeof ev.width === "number") image.width = ev.width;
    if (typeof ev.height === "number") image.height = ev.height;
    return image;
  }
  // 当前形态（2026-11 实测）：ui-component + name:"generate-image"
  if (ev.role === "ui-component" && ev.name === "generate-image" && ev.state === "data") {
    const data = ev.data;
    if (!data || typeof data !== "object") return null;
    const record = data as Record<string, unknown>;
    const b64 = typeof record.b64Image === "string" ? record.b64Image.trim() : "";
    if (!b64) return null;
    const format = typeof record.format === "string" && record.format ? record.format.toLowerCase() : "jpeg";
    const image: DuckAiGeneratedImage = { b64, format, partial: record.status !== "success" };
    if (typeof record.width === "number") image.width = record.width;
    if (typeof record.height === "number") image.height = record.height;
    return image;
  }
  return null;
}

export function mimeFor(format: string): string {
  const normalized = String(format || "").toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") return "image/jpeg";
  if (normalized === "png" || normalized === "webp" || normalized === "gif") return `image/${normalized}`;
  return `image/${normalized || "png"}`;
}

/**
 * 用魔数探测真实图片格式（对齐 duckai-cpa src/duck/image-format.js）：
 * duck.ai 实际返回 JPEG，SSE 帧里的 format 可能缺失或写错，不能直接信。
 */
export function detectImageFormat(b64: string, fallback = "png"): string {
  const normalizedFallback = String(fallback || "png").toLowerCase().replace(/^image\//, "");
  const head = String(b64 || "").trim().slice(0, 24);
  if (!head) return normalizedFallback;
  let bytes: Uint8Array;
  try {
    const bin = atob(head.length % 4 === 0 ? head : head.slice(0, head.length - (head.length % 4)));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return normalizedFallback;
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "webp";
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif";
  return normalizedFallback;
}

export function toChatImage(image: DuckAiGeneratedImage): DuckAiChatImage {
  const format = detectImageFormat(image.b64, image.format || "png");
  return {
    type: "image_url",
    image_url: { url: `data:${mimeFor(format)};base64,${image.b64}` },
  };
}
