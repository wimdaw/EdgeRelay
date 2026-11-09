/**
 * Duck.ai 低价值元数据解析（对齐 duckai-cpa 的 sse.js / compact.js）。
 *
 * 这些事件不参与正文，但可能对调试/用量观测有用：
 *  - `[CHAT_TITLE:...]` 会话标题；
 *  - `[DONE]` 尾部 `[FIXED_COST_WINDOW_USAGE:...]`（配额窗口）、`[ADS:...]`、`[WARN_CONVERSATION_LIMIT:n]`；
 *  - `role:"skill-references"` 技能引用；
 *  - `type:"quota"` / `type:"ad-window"` 独立事件。
 * 仅在出现时以 `message.duckai` / 末尾 delta 透传，普通请求的行为不变。
 */

export type DuckAiMetadata = {
  title?: string;
  quota_windows?: unknown;
  ads?: unknown;
  conversation_limit_percent?: number;
  skill_references?: unknown[];
};

const TITLE_RE = /\[CHAT_TITLE:([\s\S]*?)\]/;
const FIXED_COST_RE = /\[FIXED_COST_WINDOW_USAGE:([^\]]+)\]/;
const ADS_RE = /\[ADS:([^\]]+)\]/;
const WARN_LIMIT_RE = /\[WARN_CONVERSATION_LIMIT:(\d+)\]/;

function decodeMarker(value: string): unknown {
  try {
    return JSON.parse(decodeURIComponent(String(value || "")));
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 解析完整帧文本（含 [CHAT_TITLE] 与 [DONE] 尾部标记）。 */
export function parseDuckMetadataFrame(payload: string): DuckAiMetadata | null {
  const text = String(payload || "");
  if (!text) return null;
  const meta: DuckAiMetadata = {};

  const title = text.match(TITLE_RE);
  if (title && title[1].trim()) meta.title = title[1].trim().slice(0, 300);

  const fixed = text.match(FIXED_COST_RE);
  if (fixed) {
    const payloadValue = decodeMarker(fixed[1]);
    const windows = isObject(payloadValue) && Array.isArray(payloadValue.windows) ? payloadValue.windows : payloadValue;
    if (windows !== null && windows !== undefined) meta.quota_windows = windows;
  }

  const ads = text.match(ADS_RE);
  if (ads) {
    const payloadValue = decodeMarker(ads[1]);
    if (payloadValue !== null && payloadValue !== undefined) meta.ads = payloadValue;
  }

  const warn = text.match(WARN_LIMIT_RE);
  if (warn) {
    const percent = Number(warn[1]);
    if (Number.isFinite(percent)) meta.conversation_limit_percent = percent;
  }

  return Object.keys(meta).length ? meta : null;
}

/** 解析单个上游 JSON 事件里的元数据（skill-references / quota / ad-window）。 */
export function readDuckEventMetadata(ev: unknown): DuckAiMetadata | null {
  if (!isObject(ev)) return null;
  const meta: DuckAiMetadata = {};

  if (ev.role === "skill-references" && Array.isArray(ev.skills) && ev.skills.length) {
    meta.skill_references = ev.skills.slice(0, 50);
  }

  if (ev.type === "quota" && (Array.isArray(ev.windows) || isObject(ev.windows))) {
    meta.quota_windows = ev.windows;
  }

  if (ev.type === "ad-window" && (Array.isArray(ev.payload) || isObject(ev.payload))) {
    meta.ads = ev.payload;
  }

  return Object.keys(meta).length ? meta : null;
}

/** 浅合并（后出现的事件覆盖同名字段）。 */
export function mergeDuckMetadata(target: DuckAiMetadata, patch: DuckAiMetadata | null): DuckAiMetadata {
  if (!patch) return target;
  if (patch.title !== undefined) target.title = patch.title;
  if (patch.quota_windows !== undefined) target.quota_windows = patch.quota_windows;
  if (patch.ads !== undefined) target.ads = patch.ads;
  if (patch.conversation_limit_percent !== undefined) {
    target.conversation_limit_percent = patch.conversation_limit_percent;
  }
  if (patch.skill_references !== undefined) {
    target.skill_references = (target.skill_references || []).concat(patch.skill_references).slice(0, 50);
  }
  return target;
}
