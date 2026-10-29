/**
 * Duck.ai AI Chat 适配器（免 Key 免费对话）
 * 基于 node:vm 原生微沙箱在 Node.js / EdgeOne 运行时内秒级求解反滥用挑战。
 */
import { createContext, runInContext } from "node:vm";
import { parseFragment, serialize } from "parse5";
import crypto from "node:crypto";

const BASE_URL = "https://duck.ai";
const STATUS_URL = `${BASE_URL}/duckchat/v1/status`;
const CHAT_URL = `${BASE_URL}/duckchat/v1/chat`;
const MODELS_URL = `${BASE_URL}/duckchat/v1/models`;
const FE_VERSION_PATTERN = /serp_\d{8}_\d{6}_[A-Z]{2}-[0-9a-f]{20,40}/;
const DEFAULT_FE_VERSION = "serp_20260424_180649_ET-0bdc33b2a02ebf8f235def65d887787f694720a1";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const DEFAULT_HEADERS: Record<string, string> = {
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Origin: BASE_URL,
  Pragma: "no-cache",
  Referer: `${BASE_URL}/`,
  "Sec-Ch-Ua": '"Chromium";v="149", "Not-A.Brand";v="24", "Google Chrome";v="149"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Linux"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
};

/**
 * Duck.ai 按出口 IP 限流：实测 3 并发仍正常，8 并发约 5/8 返回 429，
 * 且 429 会同时命中 status 与 chat，触发后同一 IP 约 1 分钟内持续 429。
 * 因此单实例内串行处理并保持最小间隔，并对 429 做短退避重试，避免自身突发把整条渠道打挂。
 */
const DUCKAI_MAX_CONCURRENCY = 1;
const DUCKAI_MIN_INTERVAL_MS = 1500;
const DUCKAI_RETRY_DELAYS_MS = [2000, 4000];

let duckActive = 0;
let duckLastStart = 0;
const duckWaiters: Array<() => void> = [];

async function acquireDuckSlot(): Promise<void> {
  if (duckActive < DUCKAI_MAX_CONCURRENCY) {
    duckActive++;
  } else {
    await new Promise<void>((resolve) => duckWaiters.push(resolve));
    duckActive++;
  }
  // 单实例内串行并保持最小请求间隔，避免瞬时并发触发 DuckDuckGo 的 IP 限流。
  const waitMs = duckLastStart + DUCKAI_MIN_INTERVAL_MS - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  duckLastStart = Date.now();
}

function releaseDuckSlot(): void {
  duckActive--;
  const next = duckWaiters.shift();
  if (next) next();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 带限流退避的 fetch：429 时按 Retry-After（上限 8s）或内置退避重试。
 * 每次尝试都新建 AbortSignal，避免共享超时信号在重试期间提前中止。
 */
async function fetchDuckWithRetry(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt <= DUCKAI_RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 429) return res;
    last = res;
    res.body?.cancel().catch(() => {});
    if (attempt < DUCKAI_RETRY_DELAYS_MS.length) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 8000)
          : DUCKAI_RETRY_DELAYS_MS[attempt];
      await sleep(waitMs + Math.floor(Math.random() * 400));
    }
  }
  return last!;
}

export const DUCKAI_MODELS = [
  { id: "gpt-6-luna", name: "GPT-6 Luna (Free)" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 mini (Free)" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5 (Free)" },
  { id: "mistral-small-2603", name: "Mistral Small 4 (Free)" },
  { id: "tinfoil/gpt-oss-120b", name: "gpt-oss 120B (Free)" },
  { id: "tinfoil/gemma4-31b", name: "Gemma 4 31B (Free)" },
] as const;

export const MODEL_ALIASES: Record<string, string> = {
  "gpt-4o-mini": "gpt-5.4-mini",
  "gpt-5-mini": "gpt-5.4-mini",
  "claude-3-haiku-20240307": "claude-haiku-4-5",
  "claude-3-5-haiku-20241022": "claude-haiku-4-5",
  "mistral-small-2501": "mistral-small-2603",
  "gpt-oss-120b": "tinfoil/gpt-oss-120b",
  "gemma4-31b": "tinfoil/gemma4-31b",
};

export const CHALLENGE_STUBS = String.raw`
var __ua = __DDG_REAL_UA__;
var __HTML_LOOKUP = __DDG_HTML_LOOKUP__;
function __nativeFn(fn, name){
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  fn.toString = function(){ return 'function ' + name + '() { [native code] }'; };
  return fn;
}
__nativeFn(parseInt, 'parseInt');
__nativeFn(parseFloat, 'parseFloat');
__nativeFn(isNaN, 'isNaN');
__nativeFn(encodeURIComponent, 'encodeURIComponent');
__nativeFn(decodeURIComponent, 'decodeURIComponent');
function __makeHtmlElement(tag) {
  var state = { _innerHTML: '', _qsaCount: 0, _cssText: '' };
  var el = Object.create(__ctorForTag(tag).prototype);
  Object.assign(el, {
    tagName: String(tag).toUpperCase(), nodeName: String(tag).toUpperCase(), nodeType: 1,
    children: [], childNodes: [], classList: [], dataset: {},
    offsetWidth: 1, offsetHeight: 1, clientWidth: 1, clientHeight: 1, scrollHeight: 1, scrollWidth: 1,
    getBoundingClientRect: function(){ return { x: 0, y: 0, top: 0, left: 0, right: 1, bottom: 1, width: 1, height: 1, toJSON: function(){ return {}; } }; },
    setAttribute: function(){}, removeAttribute: function(){},
    getAttribute: function(a){ if(a==='srcdoc') return state._srcdoc||''; return null; },
    hasAttribute: function(){ return false; }, appendChild: function(c){ return c; }, removeChild: function(c){ return c; },
    addEventListener: function(){}, removeEventListener: function(){}, querySelector: function(){ return null; },
    querySelectorAll: function(s){ if (s === '*') { return __makeNodeList(state._qsaCount); } return __makeNodeList(0); },
    cloneNode: function(){ return __makeHtmlElement(tag); }
  });
  Object.defineProperty(el, 'style', { value: new Proxy({}, { set: function(t, k, v){ t[k] = v; if (k === 'cssText') state._cssText = String(v); return true; }, get: function(t, k){ if (k === 'cssText') return state._cssText; return t[k] || ''; } }), enumerable: true, configurable: true });
  Object.defineProperty(el, 'innerHTML', { get: function(){ return state._innerHTML; }, set: function(v){ var key = String(v); var entry = __HTML_LOOKUP && __HTML_LOOKUP[key]; if (entry) { state._innerHTML = String(entry.html); state._qsaCount = entry.count|0; } else { state._innerHTML = key; state._qsaCount = 0; } }, enumerable: true, configurable: true });
  Object.defineProperty(el, 'outerHTML', { get: function(){ return '<' + tag + '>' + state._innerHTML + '</' + tag + '>'; }, enumerable: true });
  Object.defineProperty(el, 'srcdoc', { get: function(){ return state._srcdoc||''; }, set: function(v){ state._srcdoc = String(v); }, enumerable: true });
  Object.defineProperty(el, 'contentWindow', { get: function(){ var w = {}; w.document = __ifDoc; w.Proxy = Proxy; w.self = w; w.top = w; w.parent = w; w.window = w; return w; }, enumerable: true });
  Object.defineProperty(el, 'contentDocument', { get: function(){ return __ifDoc; }, enumerable: true });
  return el;
}
function __mkObj(name, base) {
  base = base || {};
  return new Proxy(base, {
    get: function(t, k) {
      if (k in t) return t[k];
      if (k === Symbol.toPrimitive) return function(){ return ''; };
      if (k === Symbol.iterator) return undefined;
      if (k === 'then' || k === 'catch' || k === 'finally') return undefined;
      if (k === 'constructor') return Object;
      if (k === 'toString' || k === 'valueOf') return function(){ return '[object ' + name + ']'; };
      if (k === 'length') return 0;
      if (k === 'nodeType') return 1;
      if (k === 'tagName' || k === 'nodeName') return 'DIV';
      if (k === 'innerHTML' || k === 'outerHTML' || k === 'textContent' || k === 'innerText' || k === 'value') return '';
      if (k === 'children' || k === 'childNodes' || k === 'classList') return [];
      if (k === 'offsetWidth' || k === 'offsetHeight' || k === 'clientWidth' || k === 'clientHeight' || k === 'scrollHeight' || k === 'scrollWidth') return 1;
      if (k === 'getBoundingClientRect') return function(){ return { x: 0, y: 0, top: 0, left: 0, right: 1, bottom: 1, width: 1, height: 1, toJSON: function(){ return {}; } }; };
      if (typeof k === 'string' && (k.indexOf('get') === 0 || k.indexOf('query') === 0 || k.indexOf('find') === 0)) return function(){ return k === 'querySelectorAll' || k === 'getElementsByTagName' || k === 'getElementsByClassName' ? [] : null; };
      return function(){ return __mkObj(name + '.' + String(k)); };
    },
    has: function(t, k){ return k in t; }, set: function(t, k, v){ t[k] = v; return true; }
  });
}
function __parseCssDisplay(cssText){ if(!cssText) return ''; var m = String(cssText).match(/(?:^|;)\s*display\s*:\s*([^;]+)/i); return m ? String(m[1]).trim() : ''; }
function __getComputedStyle(el){ var cssText = el && el.style && el.style.cssText || ''; var display = __parseCssDisplay(cssText); return { getPropertyValue: function(name){ if(String(name).toLowerCase()==='display') return display; return ''; }, cssText: cssText, display: display }; }
var __ifMeta = __mkObj('meta', { getAttribute: function(a){ return a==='content' ? "default-src 'none'; script-src 'unsafe-inline';" : null; }, hasAttribute: function(a){ return a==='content'; }, tagName: 'META', nodeName: 'META' });
var __ifDoc = __mkObj('iframeDoc', { querySelector: function(s){ if (s && s.indexOf('Content-Security-Policy') !== -1) return __ifMeta; if (s === 'meta') return __ifMeta; return null; }, querySelectorAll: function(s){ if (s && s.indexOf('Content-Security-Policy') !== -1) return [__ifMeta]; if (s === 'meta') return [__ifMeta]; return []; }, getElementsByTagName: function(t){ return t && t.toLowerCase()==='meta' ? [__ifMeta] : []; }, body: __mkObj('iframeBody'), head: __mkObj('iframeHead'), documentElement: __mkObj('iframeRoot'), createElement: function(){ return __mkObj('elem', {setAttribute:function(){}, appendChild:function(){}, removeChild:function(){}, getAttribute:function(){return null;}, hasAttribute:function(){return false;}}); }, cookie: '', readyState: 'complete' });
var __iframeEl = __mkObj('iframe', { contentDocument: __ifDoc, contentWindow: __mkObj('iframeWin', { document: __ifDoc, top: undefined, parent: undefined }), document: __ifDoc, getAttribute: function(a){ if (a==='sandbox') return 'allow-scripts allow-same-origin'; if (a==='srcdoc') return ''; if (a==='id') return 'jsa'; return null; }, hasAttribute: function(a){ return a==='sandbox'||a==='id'; }, tagName: 'IFRAME', nodeName: 'IFRAME', id: 'jsa' });
var __bodyKids = [];
Object.defineProperty(__bodyKids, 'constructor', { value: HTMLCollection, enumerable: false, configurable: true });
var __body = __mkObj('body', {
  appendChild: function(c){ __bodyKids.push(c); return c; },
  removeChild: function(c){ var i = __bodyKids.indexOf(c); if (i !== -1) __bodyKids.splice(i, 1); return c; },
  contains: function(c){ return __bodyKids.indexOf(c) !== -1; },
  querySelector: function(s){ return s === '#jsa' ? __iframeEl : null; },
  querySelectorAll: function(s){ return s === '#jsa' ? [__iframeEl] : __makeNodeList(0); },
  children: __bodyKids, childNodes: __bodyKids,
  tagName: 'BODY', nodeName: 'BODY', nodeType: 1
});
var document = __mkObj('document', { querySelector: function(s){ if (s === '#jsa') return __iframeEl; if (s && s.indexOf('Content-Security-Policy') !== -1) return __ifMeta; return null; }, querySelectorAll: function(s){ if (s === '#jsa') return [__iframeEl]; if (s && s.indexOf('Content-Security-Policy') !== -1) return [__ifMeta]; return __makeNodeList(__bodyKids.length + 3); }, getElementById: function(id){ return id==='jsa' ? __iframeEl : null; }, getElementsByTagName: function(t){ if(t&&t.toLowerCase()==='iframe') return [__iframeEl]; return []; }, getElementsByClassName: function(){ return []; }, body: __body, head: __mkObj('head'), documentElement: __mkObj('root'), createElement: function(tag){ return __makeHtmlElement(tag||'div'); }, createTextNode: function(t){ return {nodeType:3, nodeValue:String(t||''), textContent:String(t||'')}; }, cookie: '', readyState: 'complete', title: '', addEventListener: function(){}, removeEventListener: function(){} });
var window = __mkObj('window', { document: document, __DDG_BE_VERSION__: 1, __DDG_FE_CHAT_HASH__: 1, navigator: __mkObj('navigator', { userAgent: __ua, webdriver: false, language: 'en-US', languages: ['en-US','en'], platform: 'Linux x86_64', vendor: 'Google Inc.', appVersion: '5.0 (X11)', cookieEnabled: true, onLine: true, hardwareConcurrency: 8, deviceMemory: 8 }), innerWidth: 1280, innerHeight: 800, outerWidth: 1280, outerHeight: 800, devicePixelRatio: 1, screen: __mkObj('screen', { width:1920, height:1080, availWidth:1920, availHeight:1080, colorDepth:24, pixelDepth:24 }), location: __mkObj('location', { href:'https://duck.ai/', origin:'https://duck.ai', host:'duck.ai', hostname:'duck.ai', protocol:'https:', pathname:'/' }), performance: __mkObj('perf', { now: function(){ return 0; }, timeOrigin: 0 }), history: __mkObj('history', { length: 1, state: null }), addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){return true;}, setTimeout: function(fn){ try{fn();}catch(e){} return 0; }, clearTimeout: function(){}, hasOwnProperty: function(k){ if (k==='__DDG_BE_VERSION__'||k==='__DDG_FE_CHAT_HASH__') return true; return Object.prototype.hasOwnProperty.call(this,k); } });
window.top = window; window.self = window; window.window = window; window.parent = window; window.globalThis = window;
try { window[Symbol.toStringTag] = 'Window'; } catch (e) {}
try {
  var __g = (function(){ return this; })();
  if (__g && __g !== window) {
    Object.defineProperty(__g, Symbol.toStringTag, { value: 'Window', configurable: true });
    var __winStub = window;
    for (var __k in __winStub) {
      try { __g[__k] = __winStub[__k]; } catch (e) {}
    }
    try { __g.hasOwnProperty = function(k){ return __winStub.hasOwnProperty(k); }; } catch (e) {}
    window = __g;
    window.top = window; window.self = window; window.window = window; window.parent = window; window.globalThis = window;
  }
} catch (e) {}
var top = window, self = window, parent = window, navigator = window.navigator, location = window.location, screen = window.screen, performance = window.performance, history = window.history;
var __R = null, __E = null;
function __DomClass(name, parent){
  var c = function(){};
  if (parent) c.prototype = Object.create(parent.prototype);
  c.prototype.constructor = c;
  Object.defineProperty(c, 'name', { value: name, configurable: true });
  c.toString = function(){ return 'function ' + name + '() { [native code] }'; };
  return c;
}
var EventTarget = __DomClass('EventTarget', null);
var Node = __DomClass('Node', EventTarget);
var Element = __DomClass('Element', Node);
var HTMLElement = __DomClass('HTMLElement', Element);
var HTMLDivElement = __DomClass('HTMLDivElement', HTMLElement);
var HTMLIFrameElement = __DomClass('HTMLIFrameElement', HTMLElement);
var HTMLLIElement = __DomClass('HTMLLIElement', HTMLElement);
var HTMLUnknownElement = __DomClass('HTMLUnknownElement', HTMLElement);
var Document = __DomClass('Document', Node);
var HTMLCollection = __DomClass('HTMLCollection', null);
var NodeList = __DomClass('NodeList', null);
function __ctorForTag(tag){
  tag = String(tag||'').toLowerCase();
  if (tag==='div') return HTMLDivElement;
  if (tag==='iframe') return HTMLIFrameElement;
  if (tag==='li') return HTMLLIElement;
  return HTMLUnknownElement;
}
function __makeNodeList(length){
  var nl = Object.create(NodeList.prototype);
  var n = length|0;
  for (var i = 0; i < n; i++) nl[i] = __makeHtmlElement('div');
  Object.defineProperty(nl, 'length', { value: n, enumerable: false, configurable: true });
  nl.item = function(i){ return this[i] || null; };
  nl.forEach = function(fn, thisArg){ for (var i = 0; i < n; i++) fn.call(thisArg, this[i], i, this); };
  nl[Symbol.iterator] = function(){ var i = 0, self = this; return { next: function(){ return i < n ? { value: self[i++], done: false } : { value: undefined, done: true }; } }; };
  return nl;
}
function __HTMLClass(name){ var c = function(){}; c.prototype = __mkObj(name+'.proto'); return c; }
var Window = __HTMLClass('Window'), Event = __HTMLClass('Event'), MouseEvent = __HTMLClass('MouseEvent'), KeyboardEvent = __HTMLClass('KeyboardEvent'), TouchEvent = __HTMLClass('TouchEvent'), XMLHttpRequest = __HTMLClass('XMLHttpRequest'), WebSocket = __HTMLClass('WebSocket'), Image = __HTMLClass('Image'), FormData = __HTMLClass('FormData'), Blob = __HTMLClass('Blob'), File = __HTMLClass('File'), FileReader = __HTMLClass('FileReader'), URL = __HTMLClass('URL'), URLSearchParams = __HTMLClass('URLSearchParams'), Headers = __HTMLClass('Headers'), Request = __HTMLClass('Request'), Response = __HTMLClass('Response');
var fetch = function(){ return Promise.resolve(__mkObj('resp', {ok:true, status:200, json:function(){return Promise.resolve({});}, text:function(){return Promise.resolve('');}})); };
var getComputedStyle = __getComputedStyle;
`;

function countHtmlElements(node: any): number {
  let count = 0;
  if (node.nodeName && !node.nodeName.startsWith("#")) count++;
  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) count += countHtmlElements(child);
  }
  return count;
}

function buildHtmlLookup(js: string): Record<string, { html: string; count: number }> {
  const lookup: Record<string, { html: string; count: number }> = {};
  const seen = new Set<string>();
  const pattern = /(['"])(<[^'"]{1,400}?)\1/g;
  for (const match of js.matchAll(pattern)) {
    const html = match[2];
    if (seen.has(html)) continue;
    seen.add(html);
    const fragment = parseFragment(html);
    lookup[html] = {
      html: serialize(fragment),
      count: countHtmlElements(fragment),
    };
  }
  return lookup;
}

export async function solveDuckDuckGoChallenge(challenge: string, userAgent = USER_AGENT): Promise<string> {
  if (!challenge || challenge.length > 262144) throw new Error("Duck.ai challenge is empty or too large");
  const js = Buffer.from(challenge, "base64").toString("utf8");
  if (js.length > 196608) throw new Error("Duck.ai challenge script too large");

  const stubs = CHALLENGE_STUBS.replace("__DDG_REAL_UA__", JSON.stringify(userAgent)).replace(
    "__DDG_HTML_LOOKUP__",
    JSON.stringify(buildHtmlLookup(js))
  );

  const sandbox = {};
  createContext(sandbox);
  runInContext(stubs, sandbox);
  const startedAt = Date.now();
  const resultPromise = runInContext(js, sandbox);
  const result = await resultPromise;
  const elapsedMs = Date.now() - startedAt;

  const clientHashes = Array.isArray(result?.client_hashes) ? result.client_hashes : [];
  if (clientHashes.length === 0) throw new Error("Duck.ai challenge returned empty client_hashes");
  clientHashes[0] = userAgent;

  result.client_hashes = await Promise.all(
    clientHashes.map(async (h: unknown) => crypto.createHash("sha256").update(String(h)).digest("base64"))
  );

  const origin = "https://duck.ai";
  const bundlePath = "/dist/duckai-dist/entry.duckai.js";
  result.meta = {
    ...result.meta,
    origin,
    stack: `Error\nat l (${origin}${bundlePath}:2:1695625)\nat async ${origin}${bundlePath}:2:1519117`,
    duration: String(elapsedMs),
  };

  return Buffer.from(JSON.stringify(result)).toString("base64");
}

let feVersionCache: { version: string; expiresAt: number } | null = null;
async function getFeVersion(): Promise<string> {
  if (feVersionCache && feVersionCache.expiresAt > Date.now()) return feVersionCache.version;
  try {
    const res = await fetchDuckWithRetry(`${BASE_URL}/`, { headers: { "User-Agent": USER_AGENT } }, 10000);
    if (res.ok) {
      const html = await res.text();
      const version = html.match(FE_VERSION_PATTERN)?.[0];
      if (version) {
        feVersionCache = { version, expiresAt: Date.now() + 10 * 60 * 1000 };
        return version;
      }
    }
  } catch {}
  return DEFAULT_FE_VERSION;
}

let cachedPublicKeyPromise: Promise<JsonWebKey> | null = null;
async function getDurablePublicKey(): Promise<JsonWebKey> {
  if (!cachedPublicKeyPromise) {
    cachedPublicKeyPromise = (async () => {
      const pair = (await crypto.subtle.generateKey(
        { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["encrypt", "decrypt"]
      )) as CryptoKeyPair;
      const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      return { ...jwk, alg: "RSA-OAEP-256", ext: true, key_ops: ["encrypt"], use: "enc" };
    })();
  }
  return cachedPublicKeyPromise;
}

function makeDuckDuckGoFeSignals(): string {
  const start = Date.now() - 3000;
  let delta = 80 + Math.floor(Math.random() * 101);
  const events = [{ name: "onboarding_impression_1", delta }];
  delta += 120 + Math.floor(Math.random() * 141);
  events.push({ name: "onboarding_impression_2", delta });
  delta += 200 + Math.floor(Math.random() * 301);
  events.push({ name: "startNewChat", delta });
  const keyEvents = 6 + Math.floor(Math.random() * 13);
  for (let i = 0; i < keyEvents; i++) {
    delta += 40 + Math.floor(Math.random() * 141);
    events.push({ name: "user_input", delta });
  }
  delta += 120 + Math.floor(Math.random() * 231);
  events.push({ name: "user_submit", delta });
  const payload = {
    start,
    events,
    end: Math.max(delta + 20 + Math.floor(Math.random() * 71), 3000),
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function resolveModel(model: string): string {
  const clean = model.startsWith("duckai/") ? model.slice("duckai/".length) : model;
  return MODEL_ALIASES[clean] || clean;
}

function reasoningEffort(model: string): string {
  return model === "claude-haiku-4-5" || model === "tinfoil/gpt-oss-120b" ? "low" : "none";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

function normalizeMessages(value: unknown): Array<{ role: "user" | "assistant"; content: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const message = entry as Record<string, unknown>;
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = contentToText(message.content);
    return content ? [{ role, content }] : [];
  });
}

function openAiChunk(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function streamResponse(upstream: Response, model: string): Response {
  if (!upstream.body) throw new Error("Duck.ai 没有返回响应流");
  const id = `chatcmpl-duckai-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let sentRole = false;
  let sentDone = false;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payloadStr = trimmed.slice(5).trim();
        if (!payloadStr || payloadStr.startsWith("[CHAT_TITLE") || payloadStr === "[PING]") continue;
        if (payloadStr === "[DONE]") {
          if (!sentRole) {
            controller.enqueue(encoder.encode(openAiChunk(id, model, { role: "assistant" })));
            sentRole = true;
          }
          controller.enqueue(encoder.encode(openAiChunk(id, model, {}, "stop")));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          sentDone = true;
          continue;
        }
        try {
          const ev = JSON.parse(payloadStr);
          const textDelta = ev.message || (ev.role !== "reasoning" ? ev.text : undefined);
          if (textDelta) {
            if (!sentRole) {
              controller.enqueue(encoder.encode(openAiChunk(id, model, { role: "assistant" })));
              sentRole = true;
            }
            controller.enqueue(encoder.encode(openAiChunk(id, model, { content: textDelta })));
          }
        } catch {}
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (!sentDone) {
        if (!sentRole) {
          controller.enqueue(encoder.encode(openAiChunk(id, model, { role: "assistant" })));
        }
        controller.enqueue(encoder.encode(openAiChunk(id, model, {}, "stop")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
    },
  });

  return new Response(upstream.body.pipeThrough(transform), {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

async function parseNonStreamingResponse(upstream: Response, model: string): Promise<Response> {
  const text = await upstream.text();
  let content = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payloadStr = trimmed.slice(5).trim();
    if (!payloadStr || payloadStr.startsWith("[CHAT_TITLE")) continue;
    if (payloadStr === "[DONE]") break;
    try {
      const ev = JSON.parse(payloadStr);
      const textDelta = ev.message || (ev.role !== "reasoning" ? ev.text : undefined);
      if (textDelta) content += textDelta;
    } catch {}
  }

  const result = {
    id: `chatcmpl-duckai-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function handleDuckAiRequest(input: {
  model: string;
  messages: unknown;
  stream?: boolean;
}): Promise<Response> {
  const messages = normalizeMessages(input.messages);
  if (messages.length === 0) {
    return new Response(JSON.stringify({ error: { message: "messages 不能为空", type: "invalid_request_error" } }), { status: 400 });
  }

  await acquireDuckSlot();
  try {
  const requestedModel = resolveModel(input.model);
  const statusRes = await fetchDuckWithRetry(STATUS_URL, {
    headers: { ...DEFAULT_HEADERS, "x-vqd-accept": "1", "User-Agent": USER_AGENT },
  }, 15000);
  if (!statusRes.ok) {
    if (statusRes.status === 429) {
      return new Response(JSON.stringify({ error: { message: "Duck.ai 上游按 IP 限流（HTTP 429），请稍后重试", type: "rate_limit_error", code: "rate_limited" } }), {
        status: 429,
        headers: { "Content-Type": "application/json; charset=utf-8", "Retry-After": "5", "Cache-Control": "no-store" },
      });
    }
    throw new Error(`Duck.ai status 返回 HTTP ${statusRes.status}`);
  }
  const challenge = statusRes.headers.get("x-vqd-hash-1");
  if (!challenge) throw new Error("Duck.ai 没有返回挑战令牌");

  const [solvedChallenge, feVersion, publicKey] = await Promise.all([
    solveDuckDuckGoChallenge(challenge, USER_AGENT),
    getFeVersion(),
    getDurablePublicKey(),
  ]);

  const payload = {
    model: requestedModel,
    metadata: { toolChoice: { NewsSearch: false, VideosSearch: false, LocalSearch: false, WeatherForecast: false } },
    messages,
    canUseTools: true,
    reasoningEffort: reasoningEffort(requestedModel),
    canUseApproxLocation: null,
    canDelegateImageGeneration: null,
    durableStream: {
      messageId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      publicKey,
    },
  };

  const upstream = await fetchDuckWithRetry(CHAT_URL, {
    method: "POST",
    headers: {
      ...DEFAULT_HEADERS,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "x-ddg-journey-id": crypto.randomUUID().replaceAll("-", ""),
      "x-fe-signals": makeDuckDuckGoFeSignals(),
      "x-fe-version": feVersion,
      "x-vqd-hash-1": solvedChallenge,
    },
    body: JSON.stringify(payload),
  }, 50000);

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    return new Response(JSON.stringify({ error: { message: `Duck.ai 上游返回 HTTP ${upstream.status}: ${errText.slice(0, 300)}` } }), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  return input.stream ? streamResponse(upstream, input.model) : await parseNonStreamingResponse(upstream, input.model);
  } finally {
    releaseDuckSlot();
  }
}
