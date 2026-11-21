/**
 * 全站多语言（参照 edgechat i18n 设计）：
 *  - 三语言：简体中文 / 繁體中文 / English
 *  - localStorage 持久化 + 首次访问浏览器语言探测
 *  - t(key, params) 翻译 + {param} 插值；未命中回退 zh-CN，再回退 key 本身
 */
import { useSyncExternalStore } from "react";

export const ZH_CN = "zh-CN";
export const ZH_TW = "zh-TW";
export const EN_US = "en-US";
export type Locale = typeof ZH_CN | typeof ZH_TW | typeof EN_US;

export const LOCALE_OPTIONS: Array<{ value: Locale; label: string }> = [
  { value: ZH_CN, label: "简体中文" },
  { value: ZH_TW, label: "繁體中文" },
  { value: EN_US, label: "English" },
];

const STORAGE_KEY = "gw-locale";

type Dict = Record<string, string>;
type Messages = Record<Locale, Dict>;

const dictionaries: Partial<Messages> = {};
const listeners = new Set<() => void>();

let current: Locale = initialLocale();

function initialLocale(): Locale {
  try {
    const stored = typeof localStorage === "undefined" ? "" : localStorage.getItem(STORAGE_KEY);
    if (stored === ZH_CN || stored === ZH_TW || stored === EN_US) return stored;
    const lang = (typeof navigator === "undefined" ? "" : navigator.language || "").replace("_", "-");
    if (/^zh/i.test(lang)) return /Hant|TW|HK|MO/i.test(lang) ? ZH_TW : ZH_CN;
    if (/^en/i.test(lang)) return EN_US;
  } catch {}
  return ZH_CN;
}

function emit() {
  for (const fn of listeners) fn();
}

/** 注册语言字典（main.tsx 启动时调用一次；重复注册覆盖） */
export function registerMessages(locale: Locale, dict: Dict) {
  dictionaries[locale] = { ...(dictionaries[locale] || {}), ...dict };
  emit();
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(next: Locale) {
  current = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  emit();
}

/** 翻译：key 形如 "nav.dashboard"；zh-CN 未命中时回退 key 本身 */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = dictionaries[current] || {};
  let out = dict[key] ?? (dictionaries[ZH_CN] || {})[key] ?? key;
  if (params) out = out.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
  return out;
}

/** React 订阅钩子：语言切换时强制重渲染 */
export function useLocaleSync(): Locale {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => current
  );
}
