/**
 * Duck.ai 上下文 PDF 溢出（对齐 duckai-cpa 的 context-pdf.js / context-spill.js）。
 *
 * 差异说明：参考实现依赖 pdf-lib + 系统 CJK 字体文件（fs 读取 simhei.ttf）。
 * EdgeOne 边缘运行时没有 fs、也不适合内联数 MB 字体，因此这里用内置的最小 PDF 生成器：
 *  - ASCII 文本：Helvetica 简单字体；
 *  - 含中文：Type0 + 预定义 CJK 字体（STSong-Light / UniGB-UCS2-H），不嵌入字体文件。
 * 生成失败/超页时抛出 DuckAiPdfError，由调用方回退为普通文本历史（与参考实现 font_missing 回退一致）。
 */

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 32;
const FONT_SIZE = 5;
const LINE_HEIGHT = 3.2;
const LINES_PER_PAGE = 250;
export const DEFAULT_PDF_INPUT_CHAR_LIMIT = 20000;
export const DEFAULT_PDF_MAX_PAGES = 15;

export class DuckAiPdfError extends Error {
  code = "context_pdf_capacity_exceeded";
  detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "DuckAiPdfError";
    this.detail = detail;
  }
}

type DuckPdfMessage = { role: string; content: string };

export function messageTextChars(messages: Array<{ content: string }>): number {
  let total = 0;
  for (const message of messages) total += String(message?.content || "").length;
  return total;
}

function hasNonAscii(text: string): boolean {
  return /[^\x00-\x7F]/.test(text);
}

/** 近似字宽：ASCII 0.5em，CJK 1em。 */
function charWidth(char: string): number {
  return char.charCodeAt(0) < 0x80 ? FONT_SIZE * 0.5 : FONT_SIZE;
}

function wrapText(text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const rawLine of String(text || "").replace(/\r\n/g, "\n").split("\n")) {
    if (!rawLine) {
      out.push("");
      continue;
    }
    let line = "";
    let width = 0;
    for (const char of rawLine) {
      const w = charWidth(char);
      if (width + w > maxWidth && line) {
        out.push(line.replace(/\s+$/, ""));
        line = "";
        width = 0;
      }
      line += char;
      width += w;
    }
    if (line) out.push(line.replace(/\s+$/, ""));
  }
  return out;
}

function transcriptLines(messages: DuckPdfMessage[]): string[] {
  const lines: string[] = [
    "=== CONVERSATION CONTEXT (archived) ===",
    "This PDF contains the earlier conversation. Use it as context; the current question follows in the chat text.",
    "",
  ];
  for (const message of messages) {
    const role = message?.role ? String(message.role).toUpperCase() : "USER";
    const text = String(message?.content || "").trim();
    if (!text) continue;
    lines.push(`[${role}]`);
    lines.push(...text.split("\n"));
    lines.push("");
  }
  return lines;
}

function escapeAsciiText(value: string): string {
  return value
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}


function toBase64(binary: string): string {
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(binary, "binary").toString("base64");
}

/**
 * 会话历史 → PDF。
 * 仅支持可安全映射到 WinAnsi 的 ASCII 文本；含中文等非 ASCII 字符时抛错，
 * 由调用方回退为普通文本历史（与参考实现字体缺失时的回退一致）。
 */
export function createContextPdf(
  messages: DuckPdfMessage[],
  options: { maxPages?: number; title?: string } = {},
): { b64: string; pages: number; textChars: number } {
  const maxPages = Math.max(1, Math.trunc(options.maxPages || DEFAULT_PDF_MAX_PAGES));
  const lines = transcriptLines(messages);
  const allText = lines.join("\n");
  if (hasNonAscii(allText)) {
    throw new DuckAiPdfError("context PDF requires a CJK font (not available in edge runtime)", {
      reason: "font_missing",
      textChars: allText.length,
    });
  }
  const maxWidth = A4_WIDTH - MARGIN * 2;

  const wrapped: string[] = [];
  for (const line of lines) wrapped.push(...wrapText(line, maxWidth));

  const pages: string[][] = [];
  let current: string[] = [];
  for (const line of wrapped) {
    if (current.length >= LINES_PER_PAGE) {
      pages.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length) pages.push(current);
  if (pages.length === 0) pages.push([""]);
  if (pages.length > maxPages) {
    throw new DuckAiPdfError(`context PDF exceeds max pages (${maxPages})`, {
      pages: pages.length,
      maxPages,
      textChars: allText.length,
    });
  }

  // 对象编号：1 catalog，2 pages，3 font，之后每页 page+contents 两个对象
  const objects: string[] = [];
  const pageObjectNumbers: number[] = [];
  let objectNumber = 4;
  for (let i = 0; i < pages.length; i += 1) {
    pageObjectNumbers.push(objectNumber);
    objectNumber += 2;
  }

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  for (let i = 0; i < pages.length; i += 1) {
    const pageLines = pages[i];
    let content = `BT\n/F1 ${FONT_SIZE} Tf\n`;
    let y = A4_HEIGHT - MARGIN;
    for (const line of pageLines) {
      if (line) {
        content += `1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm\n(${escapeAsciiText(line)}) Tj\n`;
      }
      y -= LINE_HEIGHT;
    }
    content += "ET\n";
    const pageNumber = pageObjectNumbers[i];
    objects[pageNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_WIDTH} ${A4_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageNumber + 1} 0 R >>`;
    objects[pageNumber + 1] = `<< /Length ${content.length} >>\nstream\n${content}endstream`;
  }

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  const total = objects.length;
  for (let i = 1; i < total; i += 1) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return { b64: toBase64(pdf), pages: pages.length, textChars: allText.length };
}

const SPILL_INSTRUCTION =
  "\n\n[系统提示] 附件 conversation-context.pdf 是更早的会话历史，请先读取全部页面（不要只读第一页/摘要），再结合当前问题回答。";

export type DuckAiFilePart = {
  type: "file";
  content: string;
  encoding: "base64";
  mimeType: string;
  filename: string;
};

export type SpillResult<T extends { role: string; content: string; files: DuckAiFilePart[] }> = {
  messages: T[];
  pdf: { pages: number; textChars: number; bytes: number };
};

/**
 * 文本总字符超阈值时，把「除最后一条 user 消息以外的全部历史」渲染为 PDF，
 * 作为 type:"file" part 挂在当前 user 消息上（对齐 context-spill.js）。
 */
export function spillMessagesToPdf<T extends { role: string; content: string; files: DuckAiFilePart[] }>(
  messages: T[],
  options: { inputCharLimit?: number; maxPages?: number; filename?: string } = {},
): SpillResult<T> | null {
  const inputCharLimit = Number.isFinite(Number(options.inputCharLimit))
    ? Math.max(1000, Math.trunc(Number(options.inputCharLimit)))
    : DEFAULT_PDF_INPUT_CHAR_LIMIT;
  if (messageTextChars(messages) <= inputCharLimit) return null;

  let keepIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      keepIndex = i;
      break;
    }
  }
  if (keepIndex < 0) return null;
  const history = messages.slice(0, keepIndex);
  if (history.length === 0) return null;

  const pdf = createContextPdf(history, {
    maxPages: options.maxPages,
    title: options.filename || "conversation-context.pdf",
  });
  const filename = options.filename || "conversation-context.pdf";
  const file: DuckAiFilePart = {
    type: "file",
    content: pdf.b64,
    encoding: "base64",
    mimeType: "application/pdf",
    filename,
  };

  const keep = messages.slice(keepIndex);
  const attached = keep.map((message, index) =>
    index === 0
      ? { ...message, content: `${message.content}${SPILL_INSTRUCTION}`, files: [...message.files, file] }
      : message
  );

  return {
    messages: attached,
    pdf: { pages: pdf.pages, textChars: pdf.textChars, bytes: Math.floor((pdf.b64.length * 3) / 4) },
  };
}
