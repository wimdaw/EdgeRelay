/**
 * Duck.ai 联网搜索来源与引用处理
 * 逻辑对齐 LandmineHQ/duckai-cpa（src/duck/sse.js、src/openai/chat.js）：
 * - 来源取自 tool-invocation(result).data.citations，缺失时用 data.urls / role:"source" 事件兜底
 * - 按 url 去重，最多 50 条
 * - 正文里的 <citation src="N"></citation> 清成 [N]，流式下需跨 delta 缓冲
 */

export type DuckAiSource = {
  url: string;
  title: string;
  id?: number | string;
  snippet?: string;
  domain?: string;
  rootDomain?: string;
  siteName?: string;
  published?: unknown;
};

export type DuckAiAnnotation = {
  type: "url_citation";
  url_citation: { url: string; title: string };
};

export const MAX_DUCK_SOURCES = 50;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 把一条来源归一化为 {url,title,...}；没有 url 的条目丢弃。 */
export function normalizeSource(raw: unknown): DuckAiSource | null {
  if (typeof raw === "string") {
    return raw ? { url: raw, title: raw } : null;
  }
  const item = asRecord(raw);
  if (!item) return null;
  const url =
    typeof item.url === "string" && item.url
      ? item.url
      : typeof item.href === "string" && item.href
        ? item.href
        : typeof item.link === "string"
          ? item.link
          : "";
  if (!url) return null;
  const title =
    typeof item.title === "string" && item.title
      ? item.title
      : typeof item.site === "string" && item.site
        ? item.site
        : typeof item.site_name === "string" && item.site_name
          ? item.site_name
          : url;
  const source: DuckAiSource = { url, title };
  if (typeof item.id === "number" || typeof item.id === "string") source.id = item.id;
  if (typeof item.snippet === "string") source.snippet = item.snippet;
  else if (typeof item.description === "string") source.snippet = item.description;
  if (typeof item.domain === "string") source.domain = item.domain;
  if (typeof item.root_domain === "string") source.rootDomain = item.root_domain;
  if (typeof item.site_name === "string") source.siteName = item.site_name;
  else if (typeof item.site === "string") source.siteName = item.site;
  if (item.published !== undefined) source.published = item.published;
  return source;
}

export function normalizeSources(list: unknown): DuckAiSource[] {
  if (!Array.isArray(list)) return [];
  const out: DuckAiSource[] = [];
  for (const item of list) {
    const source = normalizeSource(item);
    if (source) out.push(source);
  }
  return out;
}

/** 合并多路来源，按 url 去重并限制总数。 */
export function mergeSources(...lists: unknown[]): DuckAiSource[] {
  const byUrl = new Map<string, DuckAiSource>();
  for (const list of lists) {
    const items = Array.isArray(list)
      ? list
      : asRecord(list)?.citations ?? asRecord(list)?.urls ?? asRecord(list)?.results ?? [];
    for (const source of normalizeSources(items)) {
      if (!byUrl.has(source.url)) byUrl.set(source.url, source);
    }
  }
  return [...byUrl.values()].slice(0, MAX_DUCK_SOURCES);
}

/** 从 tool-invocation(result).data 里取来源：citations 优先，urls 兜底。 */
export function extractCitations(data: unknown): DuckAiSource[] {
  const record = asRecord(data);
  if (!record) return [];
  if (Array.isArray(record.citations)) return normalizeSources(record.citations);
  if (Array.isArray(record.urls)) return normalizeSources(record.urls);
  if (Array.isArray(record.results)) return normalizeSources(record.results);
  return [];
}

/** OpenAI 的 url_citation 注解（与 duckai-cpa 一致）。 */
export function buildAnnotations(sources: DuckAiSource[]): DuckAiAnnotation[] {
  return sources
    .filter((source) => Boolean(source?.url))
    .map((source) => ({
      type: "url_citation" as const,
      url_citation: { url: source.url, title: source.title || source.url },
    }));
}

const COMPLETE_CITATION_RE = /<citation\b[^>]*?src\s*=\s*["']?([^"'\s>]+)["']?[^>]*>\s*<\/citation>/gi;
const EMPTY_CITATION_RE = /<citation\b[^>]*>\s*<\/citation>/gi;
const LOOSE_CITATION_TAG_RE = /<\/?citation\b[^>]*>/gi;
const CITATION_PREFIX = "<citation";

/** 清理完整文本里的引用标记：<citation src="1,3"></citation> → [1,3]。 */
export function cleanCitationText(text: string): string {
  if (!text) return "";
  return text
    .replace(COMPLETE_CITATION_RE, (_match, src: string) => (src ? `[${src}]` : ""))
    .replace(EMPTY_CITATION_RE, "")
    .replace(LOOSE_CITATION_TAG_RE, "");
}

export type CitationFilter = {
  /** 传入一段增量，返回可立即下发的文本；flush=true 时冲刷缓冲。 */
  process(delta: string, options?: { flush?: boolean }): string;
};

/**
 * 流式引用过滤器：上游可能把 <citation src="5"></citation> 拆成任意多个 delta，
 * 因此把疑似标记开头的尾部片段暂扣到下一段（与 duckai-cpa 的 createCitationFilter 等价）。
 */
export function createCitationFilter(): CitationFilter {
  let pending = "";

  function findHold(text: string): number {
    let searchFrom = 0;
    for (;;) {
      const openIndex = text.indexOf(CITATION_PREFIX, searchFrom);
      if (openIndex === -1) break;
      const closeIndex = text.indexOf("</citation>", openIndex);
      if (closeIndex === -1) return text.length - openIndex;
      searchFrom = closeIndex + "</citation>".length;
    }
    for (let len = CITATION_PREFIX.length - 1; len > 0; len -= 1) {
      if (text.endsWith(CITATION_PREFIX.slice(0, len))) return len;
    }
    return 0;
  }

  return {
    process(delta: string, options?: { flush?: boolean }): string {
      if (delta) pending += delta;
      if (!pending) return "";
      if (options?.flush) {
        const flushed = cleanCitationText(pending);
        pending = "";
        return flushed;
      }
      let cleaned = pending.replace(COMPLETE_CITATION_RE, (_match, src: string) => (src ? `[${src}]` : ""));
      cleaned = cleaned.replace(EMPTY_CITATION_RE, "");
      const hold = findHold(cleaned);
      if (hold > 0) {
        const out = cleaned.slice(0, cleaned.length - hold);
        pending = cleaned.slice(cleaned.length - hold);
        return out;
      }
      pending = "";
      return cleaned;
    },
  };
}
