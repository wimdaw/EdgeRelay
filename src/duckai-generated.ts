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

/** 是否显式请求图片生成：tools[type=image_generation] 或 image_generation 快捷字段。 */
export function isImageGenerationEnabled(tools: unknown, imageGeneration: unknown): boolean {
  if (imageGeneration === true) return true;
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

function mimeFor(format: string): string {
  const normalized = format.toLowerCase();
  if (normalized === "jpg") return "image/jpeg";
  if (normalized === "jpeg" || normalized === "png" || normalized === "webp") return `image/${normalized}`;
  return `image/${normalized}`;
}

export function toChatImage(image: DuckAiGeneratedImage): DuckAiChatImage {
  return {
    type: "image_url",
    image_url: { url: `data:${mimeFor(image.format)};base64,${image.b64}` },
  };
}
