/**
 * 简→繁字符转换（OpenCC STCharacters，3881 对）
 *  - zh-TW 全站文案覆盖：t() 字典值与 DOM 硬编码中文文案统一走本转换
 *  - 字符级转换（非词组级），绝大多数界面文案准确；个别词组（如 内存→記憶體）为简体字形直转
 */
import { S2T_PAIRS } from "./s2t-data";

const MAP: Map<string, string> = new Map();
for (let i = 0; i < S2T_PAIRS.length; i++) {
  const pair = S2T_PAIRS[i];
  MAP.set(pair[0], pair[1]);
}

/** 简体 → 繁體 字符级转换（忽略非中文字符） */
export function s2t(text: string): string {
  let out = "";
  for (const ch of text) out += MAP.get(ch) || ch;
  return out;
}
