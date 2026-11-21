/**
 * 全站多语言（参照 edgechat i18n 设计）：
 *  - 三语言：简体中文 / 繁體中文 / English
 *  - localStorage 持久化 + 首次访问浏览器语言探测
 *  - t(key, params) 翻译 + {param} 插值；未命中回退 zh-CN，再回退 key 本身
 */
import { useSyncExternalStore } from "react";
import { s2t } from "./s2t";

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
  // 繁體模式：未收录于繁體字典的简体文案（含页面未迁移的硬编码文案回退值）做字符级转换
  if (current === ZH_TW) out = s2t(out);
  return out;
}

/** React 订阅钩子：语言切换时强制重渲染 */
export function useLocaleSync(): Locale {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => current
  );
}


/* =====================================================================
 * zh-TW DOM 转换层：全站硬编码中文文案的繁体覆盖
 *  - 页面尚未迁移 t() 的部分，由 MutationObserver 对文本节点做字符级转换
 *  - 排除输入框/文本域（用户输入原样保留）与 code/pre（命令、模型名不转换）
 *  - 已转换节点打 data-s2t 标记避免重复处理
 * ===================================================================== */
const S2T_SKIP_TAGS = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA", "INPUT", "SELECT", "NOSCRIPT"]);

function s2tElement(root: Element) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("[data-s2t-done],[contenteditable],input,textarea,code,pre")) return NodeFilter.FILTER_REJECT;
      if (!/[\u4e00-\u9fff]/.test(node.nodeValue || "")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const converted = s2t(node.nodeValue || "");
    if (converted !== node.nodeValue) {
      node.nodeValue = converted;
      (node.parentElement as Element).setAttribute("data-s2t-done", "1");
    }
  }
}

function startS2TDom() {
  const run = () => s2tElement(document.body);
  run();
  const observer = new MutationObserver((muts) => {
    for (const mu of muts) {
      for (const node of mu.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && !(node as Element).closest("[data-s2t-done]")) s2tElement(node as Element);
        else if (node.nodeType === Node.TEXT_NODE && node.parentElement && !node.parentElement.closest("[data-s2t-done]")) {
          const converted = s2t(node.nodeValue || "");
          if (converted !== node.nodeValue) node.nodeValue = converted;
        }
      }
      if (mu.type === "characterData" && mu.target.parentElement) {
        const p = mu.target.parentElement;
        if (!p.closest("[data-s2t-done],input,textarea,code,pre")) {
          const converted = s2t(mu.target.nodeValue || "");
          if (converted !== mu.target.nodeValue) mu.target.nodeValue = converted;
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

/** en-US 短语替换（按长度降序最长匹配，单遍扫描文本节点） */
let enPhraseRes: RegExp | null = null;
let enPhraseMap: Record<string, string> | null = null;

function enPhraseRe(): RegExp | null {
  if (!enPhraseMap) return null;
  if (enPhraseRes) return enPhraseRes;
  const keys = Object.keys(enPhraseMap).sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  enPhraseRes = keys.length ? new RegExp(keys.join("|"), "g") : null;
  return enPhraseRes;
}

function enPhraseReplace(text: string): string {
  const re = enPhraseRe();
  if (!re) return text;
  return text.replace(re, (m) => enPhraseMap![m] || m);
}

function translateElementEn(root: Element) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("[data-i18n-done],input,textarea,code,pre")) return NodeFilter.FILTER_REJECT;
      if (!/[\u4e00-\u9fff]/.test(node.nodeValue || "")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const converted = enPhraseReplace(node.nodeValue || "");
    if (converted !== node.nodeValue) {
      node.nodeValue = converted;
      (node.parentElement as Element).setAttribute("data-i18n-done", "1");
    }
  }
}

function startEnDom() {
  const run = () => translateElementEn(document.body);
  run();
  const observer = new MutationObserver((muts) => {
    for (const mu of muts) {
      for (const node of mu.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && !(node as Element).closest("[data-i18n-done]")) translateElementEn(node as Element);
        else if (node.nodeType === Node.TEXT_NODE && node.parentElement && !node.parentElement.closest("[data-i18n-done]")) {
          const converted = enPhraseReplace(node.nodeValue || "");
          if (converted !== node.nodeValue) node.nodeValue = converted;
        }
      }
      if (mu.type === "characterData" && mu.target.parentElement) {
        const p = mu.target.parentElement;
        if (!p.closest("[data-i18n-done],input,textarea,code,pre")) {
          const converted = enPhraseReplace(mu.target.nodeValue || "");
          if (converted !== mu.target.nodeValue) mu.target.nodeValue = converted;
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

export function applyLocaleDom(locale: Locale) {
  if (locale === ZH_TW) {
    // 等待首帧渲染完成再转换
    requestAnimationFrame(() => startS2TDom());
  } else if (locale === EN_US && enPhraseMap) {
    requestAnimationFrame(() => startEnDom());
  }
}

/** 注册 en-US 短语字典并触发 DOM 层（Settings/模型加载后调用） */
export function registerEnPhrases(map: Record<string, string>) {
  enPhraseMap = map;
  enPhraseRes = null;
  if (current === EN_US) {
    requestAnimationFrame(() => startEnDom());
  }
}
