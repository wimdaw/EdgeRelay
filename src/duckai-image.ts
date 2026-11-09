import { deflateSync } from "node:zlib";
import * as jpeg from "jpeg-js";

/** Duck.ai 上游只接受的图片类型（实测 JPEG data URL 会被 400 拒绝） */
export type DuckAiImagePart = { type: "image"; mimeType: string; image: string };

/** 单张图片的最大尺寸（上游对超大图不稳定，按参考实现缩到 512px） */
const MAX_EDGE = 512;
/** 单次请求最多携带的图片数量 */
const MAX_IMAGES = 8;
/** 单张图片 base64 体积上限（约 4MB 原始数据） */
const MAX_BASE64_CHARS = 6 * 1024 * 1024;

const DATA_URL_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i;

/**
 * 从 OpenAI 风格的 message.content 中提取图片，转换成 Duck.ai 上游的 image part。
 * 支持 part.type 为 image_url / input_image / image，也支持 Anthropic 风格的 base64 source。
 * 无法识别或不支持的格式会被静默跳过，不影响同一条消息里的文本部分。
 */
export function extractImageParts(content: unknown): DuckAiImagePart[] {
  if (!Array.isArray(content)) return [];
  const parts: DuckAiImagePart[] = [];
  for (const entry of content) {
    if (parts.length >= MAX_IMAGES) break;
    const part = toImagePart(entry);
    if (part) parts.push(part);
  }
  return parts;
}

function toImagePart(entry: unknown): DuckAiImagePart | null {
  if (!entry || typeof entry !== "object") return null;
  const part = entry as Record<string, unknown>;
  const type = typeof part.type === "string" ? part.type : "";
  if (type !== "image_url" && type !== "input_image" && type !== "image") return null;

  const dataUrl = resolveDataUrl(part);
  if (!dataUrl) return null;
  return normalizeToUpstream(dataUrl);
}

function resolveDataUrl(part: Record<string, unknown>): string | null {
  const raw = part.image_url;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const url = (raw as Record<string, unknown>).url;
    if (typeof url === "string") return url;
  }
  const source = part.source;
  if (source && typeof source === "object") {
    const record = source as Record<string, unknown>;
    if (record.type === "base64" && typeof record.data === "string") {
      const mediaType = typeof record.media_type === "string" ? record.media_type : "image/png";
      return `data:${mediaType};base64,${record.data}`;
    }
  }
  if (typeof part.image === "string") return part.image;
  return null;
}

/** 把任意 data URL 归一成上游可接受的形式：PNG/WebP 直通，JPEG 转 PNG */
function normalizeToUpstream(dataUrl: string): DuckAiImagePart | null {
  const match = DATA_URL_PATTERN.exec(dataUrl.trim());
  if (!match) return null;
  const base64 = match[2].replace(/\s+/g, "");
  if (base64.length > MAX_BASE64_CHARS) return null;

  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0) return null;

  const sniffed = sniffMime(bytes);
  const declared = normalizeMime(match[1]);
  const mime = sniffed || declared;

  if (mime === "image/png" || mime === "image/webp") {
    return { type: "image", mimeType: mime, image: `data:${mime};base64,${base64}` };
  }
  if (mime === "image/jpeg") {
    const png = convertJpegToPng(bytes);
    if (!png) return null;
    return { type: "image", mimeType: "image/png", image: png };
  }
  return null;
}

function normalizeMime(value: string): string {
  const mime = value.toLowerCase();
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** JPEG 解码 -> 最近邻缩放到 MAX_EDGE -> 重新编码为 PNG data URL */
function convertJpegToPng(bytes: Uint8Array): string | null {
  try {
    const decoded = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: true,
      maxResolutionInMP: 40,
      maxMemoryUsageInMB: 256,
    });
    if (!decoded || !decoded.width || !decoded.height) return null;
    const scaled = downscale(decoded.width, decoded.height, decoded.data as Uint8Array, MAX_EDGE);
    const png = encodePng(scaled.width, scaled.height, scaled.data);
    return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  } catch {
    return null;
  }
}

function downscale(width: number, height: number, rgba: Uint8Array, maxEdge: number) {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height, data: rgba };
  const scale = maxEdge / longest;
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y++) {
    const srcY = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < targetWidth; x++) {
      const srcX = Math.min(width - 1, Math.floor(x / scale));
      const srcIndex = (srcY * width + srcX) * 4;
      const dstIndex = (y * targetWidth + x) * 4;
      out[dstIndex] = rgba[srcIndex];
      out[dstIndex + 1] = rgba[srcIndex + 1];
      out[dstIndex + 2] = rgba[srcIndex + 2];
      out[dstIndex + 3] = rgba[srcIndex + 3];
    }
  }
  return { width: targetWidth, height: targetHeight, data: out };
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[i] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, "ascii");
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.length);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return new Uint8Array(out);
}

/** 极简 PNG 编码器：RGBA8 + filter 0 + zlib deflate（避免引入 pngjs 依赖） */
function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = deflateSync(raw, { level: 6 });
  return new Uint8Array(Buffer.concat([
    signature,
    Buffer.from(pngChunk("IHDR", new Uint8Array(ihdr))),
    Buffer.from(pngChunk("IDAT", new Uint8Array(idat))),
    Buffer.from(pngChunk("IEND", new Uint8Array(0))),
  ]));
}
