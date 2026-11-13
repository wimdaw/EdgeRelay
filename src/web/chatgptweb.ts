/**
 * ChatGPT 网页版反代（provider.type = 'chatgptweb'）
 *
 * 与 codex 渠道的区别：
 *  - codex 走 Codex CLI 的 OAuth 客户端 + /backend-api/codex/responses，账号必须有 Codex 权限；
 *  - 本渠道走 ChatGPT **网页/App** 的 OAuth 客户端 + /backend-api/conversation，
 *    适合「未接手机号、不能 Codex，但可网页反代」的 Free 账号。
 *
 * 凭据：apiKeys 里每行一个 refresh_token（商品页发货的 rt_xxx）。
 * 刷新：POST auth.openai.com/oauth/token（JSON），client_id 必须与签发 RT 的客户端一致；
 *       先试商品页给的 app_2SK…，失败再回退旧 iOS 客户端 pdlLIX…。
 *
 * 上游链路（2026-07 版协议）：
 *  1. GET chatgpt.com/ 取 data-build 与 script src（PoW 指纹素材，失败则用默认值）
 *  2. POST /backend-api/sentinel/chat-requirements/prepare  {p}
 *  3. 按 proofofwork 要求解 PoW（SHA3-512），按 turnstile 要求解 XOR 令牌
 *  4. POST /backend-api/sentinel/chat-requirements/finalize {prepare_token, proof_token, turnstile_token}
 *  5. POST /backend-api/conversation（SSE），逐条翻译成 OpenAI chat.completion.chunk
 *
 * 注意：网页协议属于非公开接口，上游随时可能改；本实现按 chatgpt2api v1.8.0 的协议复刻。
 */

import type { Env } from '../types'
import {
  type OAuthCallParams,
  oauthErrorResponse,
  readErrorBody,
  recordOAuthUsage,
  defer,
  resolveAccessToken,
  sha256Hex,
  randomId,
} from '../oauth/common'
import { getKV } from '../storage/blob-store'
import { isImageIntentRequest } from '../image-intent'

// =====================================================================
// 常量
// =====================================================================

const BASE_URL = 'https://chatgpt.com'
const DEFAULT_POW_SCRIPT = 'https://chatgpt.com/backend-api/sentinel/sdk.js'

/** ChatGPT App（iOS）当前使用的 web OAuth 客户端（商品页明确要求与 RT 对应） */
const PRIMARY_CLIENT_ID = 'app_2SKx67EdpoN0G6j64rFvigXD'
/** 旧版 chat2api 使用的 iOS 客户端，作为兼容回退 */
const LEGACY_CLIENT_ID = 'pdlLIX2Y72MIl2rhLhTE9VV9bN905kBh'
const OAUTH_REDIRECT_URI = 'com.openai.chat://auth0.openai.com/ios/com.openai.chat/callback'

const CLIENT_VERSION = 'prod-a194cd50d4416d3c0b47c740f206b12ce60f5887'
const CLIENT_BUILD_NUMBER = '6708908'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
const SEC_CH_UA = '"Chromium";v="145", "Google Chrome";v="145", "Not/A)Brand";v="99"'

const AT_PREFIX = 'chatgptweb:at:'
const HEALTH_PREFIX = 'chatgptweb:health:'
const POW_CACHE_KEY = 'chatgptweb:pow'
const POW_CACHE_TTL = 3600

const BOOTSTRAP_TIMEOUT_MS = 15_000
const REQUIREMENTS_TIMEOUT_MS = 30_000
const TOKEN_REFRESH_TIMEOUT_MS = 20_000
/** EdgeOne 云函数 maxDuration=120s，留 10s 余量 */
const CONVERSATION_TIMEOUT_MS = 110_000

const COOLDOWN_QUOTA_MS = 30 * 60 * 1000
const COOLDOWN_AUTH_MS = 60 * 60 * 1000
const COOLDOWN_TRANSIENT_MS = 5 * 60 * 1000
const COOLDOWN_MAX_MS = 6 * 60 * 60 * 1000

const WEB_MODELS = ['gpt-5-5', 'gpt-5-5-thinking', 'gpt-5-4', 'gpt-4o', 'auto']

// =====================================================================
// 错误类型
// =====================================================================

/** 凭据刷新/鉴权失败（按 401 语义返回） */
class WebAuthError extends Error {}

/** 上游 HTTP 错误（携带状态码与响应体摘要） */
class WebHttpError extends Error {
  status: number
  body: string
  constructor(message: string, status: number, body = '') {
    super(message)
    this.status = status
    this.body = body
  }
}

// =====================================================================
// 基础工具
// =====================================================================

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function jsonToBase64(value: unknown): string {
  return bytesToBase64(encodeUtf8(JSON.stringify(value)))
}

function randomOf<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

function base64UrlDecode(data: string): string {
  const pad = data.length % 4 === 0 ? '' : '='.repeat(4 - (data.length % 4))
  return atob(data.replace(/-/g, '+').replace(/_/g, '/') + pad)
}

function parseJwtClaim(token: string, claim: string): string {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return ''
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>
    const value = payload?.[claim]
    return typeof value === 'string' ? value : ''
  } catch { return '' }
}

function isJwt(token: string): boolean {
  return token.split('.').length === 3 && token.startsWith('eyJ')
}

/**
 * 从一行凭据里提取 refresh_token。
 * 商品发货格式：账号----GPT密码----邮箱密码----rt.1.xxxx（或旧式 rt_xxxx）
 * 也兼容只填 RT，或直接填整行（自动取最后一段）。
 */
function extractRefreshToken(input: string): string {
  const line = String(input || '').trim()
  if (!line) return ''
  // 先按发货格式切段，优先取最后一段，避免邮箱/密码里恰好含 rt
  const parts = line.split(/\s*----\s*/).map((part) => part.trim()).filter(Boolean)
  if (parts.length > 1) {
    const last = parts[parts.length - 1]
    if (/^rt[._]/i.test(last) || isJwt(last)) return last
    const rtMatch = line.match(/\brt[._][^\s"'，,;；]+/i)
    if (rtMatch) return rtMatch[0]
    return last
  }
  const rtMatch = line.match(/\brt[._][^\s"'，,;；]+/i)
  if (rtMatch) return rtMatch[0]
  if (isJwt(line)) return line
  return line
}

/** 由 RT 哈希稳定派生设备 ID：避免每次请求都像新设备，减少风控触发 */
function deviceIdFromHash(hash: string): string {
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

interface Fingerprint {
  deviceId: string
  sessionId: string
  ua: string
}

async function buildFingerprint(rawToken: string): Promise<Fingerprint> {
  const hash = await sha256Hex(rawToken || 'anonymous')
  return { deviceId: deviceIdFromHash(hash), sessionId: randomId(), ua: USER_AGENT }
}

// =====================================================================
// SHA3-512（WebCrypto 不提供 SHA3；PoW 需要）
// 32 位双字实现，约 20k hash/s，足够解 1/65536 难度
// =====================================================================

const RC_BIG = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]
const RC_LO = RC_BIG.map((v) => Number(v & 0xffffffffn) >>> 0)
const RC_HI = RC_BIG.map((v) => Number(v >> 32n) >>> 0)
const RHO = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]

function keccakF(s: Uint32Array): void {
  const c = new Uint32Array(10)
  const b = new Uint32Array(50)
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      const i = x * 2
      c[i] = s[i] ^ s[i + 10] ^ s[i + 20] ^ s[i + 30] ^ s[i + 40]
      c[i + 1] = s[i + 1] ^ s[i + 11] ^ s[i + 21] ^ s[i + 31] ^ s[i + 41]
    }
    for (let x = 0; x < 5; x++) {
      const prev = ((x + 4) % 5) * 2
      const next = ((x + 1) % 5) * 2
      const nl = c[next]
      const nh = c[next + 1]
      const dLo = (nl << 1) | (nh >>> 31)
      const dHi = (nh << 1) | (nl >>> 31)
      for (let y = 0; y < 25; y += 5) {
        const i = (x + y) * 2
        s[i] ^= c[prev] ^ dLo
        s[i + 1] ^= c[prev + 1] ^ dHi
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const src = (x + 5 * y) * 2
        let lo = s[src]
        let hi = s[src + 1]
        const n = RHO[x + 5 * y]
        if (n < 32) {
          if (n) {
            const a = (lo << n) | (hi >>> (32 - n))
            const bb = (hi << n) | (lo >>> (32 - n))
            lo = a
            hi = bb
          }
        } else if (n === 32) {
          const t = lo
          lo = hi
          hi = t
        } else {
          const m = n - 32
          const a = (hi << m) | (lo >>> (32 - m))
          const bb = (lo << m) | (hi >>> (32 - m))
          lo = a
          hi = bb
        }
        const dst = (y + 5 * ((2 * x + 3 * y) % 5)) * 2
        b[dst] = lo
        b[dst + 1] = hi
      }
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = (x + 5 * y) * 2
        const i1 = (((x + 1) % 5) + 5 * y) * 2
        const i2 = (((x + 2) % 5) + 5 * y) * 2
        s[i] = b[i] ^ (~b[i1] & b[i2])
        s[i + 1] = b[i + 1] ^ (~b[i1 + 1] & b[i2 + 1])
      }
    }
    s[0] ^= RC_LO[round]
    s[1] ^= RC_HI[round]
  }
}

function sha3_512(data: Uint8Array): Uint8Array {
  const rate = 72
  const padLen = rate - (data.length % rate)
  const msg = new Uint8Array(data.length + padLen)
  msg.set(data)
  msg[data.length] ^= 0x06
  msg[msg.length - 1] ^= 0x80
  const s = new Uint32Array(50)
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate; i++) s[i >> 2] ^= msg[off + i] << ((i & 3) * 8)
    keccakF(s)
  }
  const out = new Uint8Array(64)
  for (let i = 0; i < 64; i++) out[i] = (s[i >> 2] >>> ((i & 3) * 8)) & 0xff
  return out
}

// =====================================================================
// Sentinel / PoW（复刻 chatgpt2api utils/pow.py 的 Build25 指纹）
// =====================================================================

const NAVIGATOR_KEYS = [
  'registerProtocolHandler−function registerProtocolHandler() { [native code] }',
  'storage−[object StorageManager]', 'locks−[object LockManager]', 'appCodeName−Mozilla',
  'permissions−[object Permissions]', 'share−function share() { [native code] }',
  'webdriver−false', 'managed−[object NavigatorManagedData]', 'canShare−function canShare() { [native code] }',
  'vendor−Google Inc.', 'mediaDevices−[object MediaDevices]', 'vibrate−function vibrate() { [native code] }',
  'storageBuckets−[object StorageBucketManager]', 'mediaCapabilities−[object MediaCapabilities]',
  'cookieEnabled−true', 'virtualKeyboard−[object VirtualKeyboard]', 'product−Gecko',
  'presentation−[object Presentation]', 'onLine−true', 'mimeTypes−[object MimeTypeArray]',
  'credentials−[object CredentialsContainer]', 'serviceWorker−[object ServiceWorkerContainer]',
  'keyboard−[object Keyboard]', 'gpu−[object GPU]', 'doNotTrack', 'serial−[object Serial]',
  'pdfViewerEnabled−true', 'language−zh-CN', 'geolocation−[object Geolocation]',
  'userAgentData−[object NavigatorUAData]', 'getUserMedia−function getUserMedia() { [native code] }',
  'sendBeacon−function sendBeacon() { [native code] }', 'hardwareConcurrency−32',
  'windowControlsOverlay−[object WindowControlsOverlay]',
]
const DOCUMENT_KEYS = ['__reactContainer$fzelfjyxej8', '_reactListening5dehydibo78', 'location']
const WINDOW_KEYS = [
  '0', 'window', 'self', 'document', 'name', 'location', 'customElements', 'history', 'navigation',
  'innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'visualViewport', 'screenX', 'screenY',
  'outerWidth', 'outerHeight', 'devicePixelRatio', 'screen', 'chrome', 'navigator', 'onresize',
  'performance', 'crypto', 'indexedDB', 'sessionStorage', 'localStorage', 'scheduler', 'alert',
  'atob', 'btoa', 'fetch', 'matchMedia', 'postMessage', 'queueMicrotask', 'requestAnimationFrame',
  'setInterval', 'setTimeout', 'caches', '__NEXT_DATA__', '__BUILD_MANIFEST', '__NEXT_PRELOADREADY',
]
const SCREEN_RESOLUTIONS = [[1920, 1080], [1440, 900], [2560, 1440], [3840, 2160]]
const CORES = [8, 16, 24, 32]

function legacyTimeString(): string {
  const now = new Date(Date.now() - 5 * 3600 * 1000)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${days[now.getUTCDay()]} ${months[now.getUTCMonth()]} ${p(now.getUTCDate())} ${now.getUTCFullYear()} `
    + `${p(now.getUTCHours())}:${p(now.getUTCMinutes())}:${p(now.getUTCSeconds())} GMT-0500 (Eastern Standard Time)`
}

function buildPowConfig(ua: string, scripts: string[], build: string): any[] {
  const resolution = randomOf(SCREEN_RESOLUTIONS)
  const perf = performance.now()
  return [
    resolution[0] + resolution[1],
    legacyTimeString(),
    4294705152,
    1,
    ua,
    scripts.length ? randomOf(scripts) : DEFAULT_POW_SCRIPT,
    build,
    'en-US',
    'en-US,es-US,en,es',
    Math.random(),
    randomOf(NAVIGATOR_KEYS),
    randomOf(DOCUMENT_KEYS),
    randomOf(WINDOW_KEYS),
    perf,
    randomId(),
    '',
    randomOf(CORES),
    Date.now() - perf,
    0, 0, 0, 0, 0, 0,
    0,
  ]
}

function buildRequirementsToken(ua: string, scripts: string[], build: string): string {
  return 'gAAAAAC' + jsonToBase64(buildPowConfig(ua, scripts, build))
}

function hexPrefixLte(hash: Uint8Array, target: Uint8Array): boolean {
  for (let i = 0; i < target.length; i++) {
    if (hash[i] < target[i]) return true
    if (hash[i] > target[i]) return false
  }
  return true
}

function buildProofToken(seed: string, difficulty: string, ua: string, scripts: string[], build: string): string {
  const diff = String(difficulty || '0')
  if (!/^[0-9a-f]+$/i.test(diff) || diff.length % 2 !== 0) {
    throw new Error(`上游返回了无法解析的 PoW 难度: ${diff.slice(0, 32)}`)
  }
  const target = new Uint8Array(diff.length / 2)
  for (let i = 0; i < target.length; i++) target[i] = parseInt(diff.slice(i * 2, i * 2 + 2), 16)
  const seedBytes = encodeUtf8(String(seed || ''))
  const config = buildPowConfig(ua, scripts, build)
  const static1 = JSON.stringify(config.slice(0, 3)).slice(0, -1) + ','
  const static2 = ',' + JSON.stringify(config.slice(4, 9)).slice(1, -1) + ','
  const static3 = ',' + JSON.stringify(config.slice(10)).slice(1)
  const start = Date.now()
  for (let i = 0; i < 500000; i++) {
    config[3] = i
    config[9] = Date.now() - start
    const finalJson = static1 + i + static2 + (i >> 1) + static3
    const payload = bytesToBase64(encodeUtf8(finalJson))
    const hash = sha3_512(concatBytes(seedBytes, encodeUtf8(payload)))
    if (hexPrefixLte(hash, target)) return 'gAAAAAB' + payload
  }
  throw new Error('PoW 求解超过 500000 次仍未命中，已放弃')
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

// =====================================================================
// Turnstile 令牌求解（上游下发的 xor + 小虚拟机，纯计算）
// =====================================================================

function xorStrings(text: string, key: string): string {
  if (!key) return text
  const keyChars = [...key]
  let out = ''
  let i = 0
  for (const ch of text) {
    const a = ch.codePointAt(0) || 0
    const b = keyChars[i % keyChars.length].codePointAt(0) || 0
    out += String.fromCodePoint(a ^ b)
    i++
  }
  return out
}

function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'undefined'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value)
  if (typeof value === 'string') {
    const special: Record<string, string> = {
      'window.Math': '[object Math]',
      'window.Reflect': '[object Reflect]',
      'window.performance': '[object Performance]',
      'window.localStorage': '[object Storage]',
      'window.Object': 'function Object() { [native code] }',
      'window.Reflect.set': 'function set() { [native code] }',
      'window.performance.now': 'function () { [native code] }',
      'window.Object.create': 'function create() { [native code] }',
      'window.Object.keys': 'function keys() { [native code] }',
      'window.Math.random': 'function random() { [native code] }',
    }
    return special[value] ?? value
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(',')
  return String(value)
}

class OrderedMap {
  keys: string[] = []
  values: Record<string, unknown> = {}
  add(key: string, value: unknown): void {
    if (!(key in this.values)) this.keys.push(key)
    this.values[key] = value
  }
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const k of this.keys) out[k] = this.values[k]
    return out
  }
}

function solveTurnstileToken(dx: string, p: string): string {
  try {
    const decoded = new TextDecoder().decode(base64ToBytes(dx))
    const tokenList = JSON.parse(xorStrings(decoded, p)) as any[]
    if (!Array.isArray(tokenList)) return ''
    const processMap = new Map<any, any>()
    const startMs = Date.now()
    let result = ''

    const toStr = pyStr
    const funcs: Record<number, (...args: any[]) => void> = {
      1: (e: number, t: number) => { processMap.set(e, xorStrings(toStr(processMap.get(e)), toStr(processMap.get(t)))) },
      2: (e: number, t: any) => { processMap.set(e, t) },
      3: (e: string) => { result = bytesToBase64(encodeUtf8(String(e))) },
      5: (e: number, t: number) => {
        const cur = processMap.get(e)
        const incoming = processMap.get(t)
        if (Array.isArray(cur)) processMap.set(e, [...cur, incoming])
        else if (typeof cur === 'number' && typeof incoming === 'number') processMap.set(e, cur + incoming)
        else if (typeof cur === 'string' || typeof cur === 'number' || typeof incoming === 'string' || typeof incoming === 'number') {
          processMap.set(e, toStr(cur) + toStr(incoming))
        } else processMap.set(e, 'NaN')
      },
      6: (e: number, t: number, n: number) => {
        const tv = processMap.get(t)
        const nv = processMap.get(n)
        if (typeof tv === 'string' && typeof nv === 'string') {
          const value = `${tv}.${nv}`
          processMap.set(e, value === 'window.document.location' ? 'https://chatgpt.com/' : value)
        }
      },
      7: (e: number, ...args: number[]) => {
        const target = processMap.get(e)
        const values = args.map((a) => processMap.get(a))
        if (target === 'window.Reflect.set') {
          const obj = values[0] as OrderedMap
          if (obj && typeof obj.add === 'function') obj.add(String(values[1]), values[2])
        } else if (typeof target === 'function') target(...values)
      },
      8: (e: number, t: number) => { processMap.set(e, processMap.get(t)) },
      14: (e: number, t: number) => { processMap.set(e, JSON.parse(processMap.get(t))) },
      15: (e: number, t: number) => { processMap.set(e, JSON.stringify(processMap.get(t))) },
      17: (e: number, t: number, ...args: number[]) => {
        const callArgs = args.map((a) => processMap.get(a))
        const target = processMap.get(t)
        if (target === 'window.performance.now') {
          processMap.set(e, (Date.now() - startMs) + Math.random())
        } else if (target === 'window.Object.create') {
          processMap.set(e, new OrderedMap())
        } else if (target === 'window.Object.keys') {
          if (callArgs[0] === 'window.localStorage') {
            processMap.set(e, [
              'STATSIG_LOCAL_STORAGE_INTERNAL_STORE_V4', 'STATSIG_LOCAL_STORAGE_STABLE_ID',
              'client-correlated-secret', 'oai/apps/capExpiresAt', 'oai-did',
              'STATSIG_LOCAL_STORAGE_LOGGING_REQUEST', 'UiState.isNavigationCollapsed.1',
            ])
          }
        } else if (target === 'window.Math.random') {
          processMap.set(e, Math.random())
        } else if (typeof target === 'function') {
          processMap.set(e, target(...callArgs))
        }
      },
      18: (e: number) => { processMap.set(e, new TextDecoder().decode(base64ToBytes(toStr(processMap.get(e))))) },
      19: (e: number) => { processMap.set(e, bytesToBase64(encodeUtf8(toStr(processMap.get(e))))) },
      20: (e: number, t: number, n: number, ...args: number[]) => {
        if (processMap.get(e) === processMap.get(t)) {
          const target = processMap.get(n)
          if (typeof target === 'function') target(...args.map((a) => processMap.get(a)))
        }
      },
      21: () => {},
      23: (e: number, t: number, ...args: number[]) => {
        if (processMap.get(e) !== null && processMap.get(e) !== undefined) {
          const target = processMap.get(t)
          if (typeof target === 'function') target(...args)
        }
      },
      24: (e: number, t: number, n: number) => {
        const tv = processMap.get(t)
        const nv = processMap.get(n)
        if (typeof tv === 'string' && typeof nv === 'string') processMap.set(e, `${tv}.${nv}`)
      },
    }

    processMap.set(9, tokenList)
    processMap.set(10, 'window')
    processMap.set(16, p)
    for (const [id, fn] of Object.entries(funcs)) processMap.set(Number(id), fn)

    for (const token of tokenList) {
      try {
        const fn = processMap.get(token[0])
        if (typeof fn === 'function') fn(...token.slice(1))
      } catch { /* 单步失败不影响整体 */ }
    }
    return result || ''
  } catch {
    return ''
  }
}

// =====================================================================
// OAuth / access_token
// =====================================================================

async function refreshWebToken(refreshToken: string): Promise<{
  accessToken: string
  expiresIn: number
  refreshToken?: string
  extra?: Record<string, string>
}> {
  const attempts = [
    { url: 'https://auth.openai.com/oauth/token', clientId: PRIMARY_CLIENT_ID },
    { url: 'https://auth0.openai.com/oauth/token', clientId: LEGACY_CLIENT_ID },
  ]
  const errors: string[] = []
  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: attempt.clientId,
          grant_type: 'refresh_token',
          redirect_uri: OAUTH_REDIRECT_URI,
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS),
      })
      const text = await res.text()
      let json: any = null
      try { json = JSON.parse(text) } catch { /* keep raw */ }
      if (res.ok && json?.access_token) {
        const accessToken = String(json.access_token)
        const accountId = parseJwtClaim(accessToken, 'chatgpt_account_id')
        return {
          accessToken,
          expiresIn: Number(json.expires_in) || 3600,
          refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
          extra: accountId ? { accountId } : undefined,
        }
      }
      errors.push(`[${attempt.clientId.slice(0, 10)}] HTTP ${res.status}: ${text.slice(0, 180)}`)
    } catch (err) {
      errors.push(`[${attempt.clientId.slice(0, 10)}] ${(err as Error).message || '网络错误'}`)
    }
  }
  throw new WebAuthError(`refresh_token 刷新失败: ${errors.join(' | ') || '未知错误'}`)
}

async function resolveAccountToken(env: Env, rawToken: string): Promise<{ token: string; accountId: string }> {
  const raw = extractRefreshToken(rawToken)
  if (!raw) return { token: '', accountId: '' }
  // 兼容用户直接粘贴 access_token（JWT）
  if (isJwt(raw)) {
    return { token: raw, accountId: parseJwtClaim(raw, 'chatgpt_account_id') }
  }
  const cached = await resolveAccessToken(env, AT_PREFIX, raw, refreshWebToken)
  const accountId = cached.extra?.accountId || parseJwtClaim(cached.accessToken, 'chatgpt_account_id')
  return { token: cached.accessToken, accountId }
}

/** 账号池：读取账号邮箱 / 套餐（只读本地 access_token JWT，不触发刷新/轮换） */
export async function fetchChatgptWebAccountInfo(
  env: Env,
  rawToken: string,
): Promise<{ ok: boolean; email?: string; name?: string; plan?: string; accountId?: string; note?: string; error?: string }> {
  try {
    const raw = extractRefreshToken(rawToken)
    if (!raw) return { ok: false, error: '凭据为空' }
    let token = ''
    if (isJwt(raw)) {
      token = raw
    } else {
      const cachedRaw = await getKV(env).get(AT_PREFIX + (await sha256Hex(raw))).catch(() => null)
      if (cachedRaw) {
        try { token = JSON.parse(cachedRaw).accessToken || '' } catch { /* ignore */ }
      }
    }
    if (!token) return { ok: true, note: '首次调用后显示账号信息' }

    let payload: any = {}
    try {
      const parts = token.split('.')
      if (parts.length >= 2) payload = JSON.parse(base64UrlDecode(parts[1]))
    } catch { return { ok: true, note: '账号信息解析失败' } }

    const profile = payload?.['https://api.openai.com/profile'] || {}
    const auth = payload?.['https://api.openai.com/auth'] || {}
    return {
      ok: true,
      email: typeof profile?.email === 'string' ? profile.email : (typeof payload?.email === 'string' ? payload.email : ''),
      name: typeof profile?.name === 'string' ? profile.name : '',
      plan: typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : '',
      accountId: typeof auth?.user_id === 'string' ? auth.user_id : '',
    }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message || '账号信息查询失败' }
  }
}

// =====================================================================
// 请求头
// =====================================================================

function bootstrapHeaders(fp: Fingerprint): Record<string, string> {
  return {
    'User-Agent': fp.ua,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Ch-Ua': SEC_CH_UA,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  }
}

function browserHeaders(fp: Fingerprint, path: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
    'Oai-Device-Id': fp.deviceId,
    'Oai-Language': 'en-US',
    'Oai-Session-Id': fp.sessionId,
    'Oai-Client-Version': CLIENT_VERSION,
    'Oai-Client-Build-Number': CLIENT_BUILD_NUMBER,
    Origin: BASE_URL,
    Priority: 'u=1, i',
    Referer: BASE_URL + '/',
    'Sec-Ch-Ua': SEC_CH_UA,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': fp.ua,
    'X-OpenAI-Target-Path': path,
    'X-OpenAI-Target-Route': path,
    ...extra,
  }
}

// =====================================================================
// PoW 素材缓存（bootstrap）
// =====================================================================

interface PowResources {
  scripts: string[]
  build: string
  at: number
}

function parsePowResources(html: string): { scripts: string[]; build: string } {
  const scripts: string[] = []
  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    const src = match[1]
    if (!src) continue
    try {
      scripts.push(new URL(src, BASE_URL).toString())
    } catch { /* ignore malformed */ }
  }
  const buildMatch = html.match(/<html[^>]*data-build="([^"]*)"/)
  return {
    scripts: scripts.length ? scripts : [DEFAULT_POW_SCRIPT],
    build: buildMatch ? buildMatch[1] : '',
  }
}

async function getPowResources(env: Env, fp: Fingerprint): Promise<PowResources> {
  try {
    const raw = await getKV(env).get(POW_CACHE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as PowResources
      if (parsed && Array.isArray(parsed.scripts) && Date.now() - Number(parsed.at || 0) < POW_CACHE_TTL * 1000) {
        return parsed
      }
    }
  } catch { /* 缓存不可用则重新抓 */ }

  try {
    const res = await fetch(BASE_URL + '/', {
      headers: bootstrapHeaders(fp),
      signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
    })
    if (res.ok) {
      const html = await res.text()
      const parsed = parsePowResources(html)
      const value: PowResources = { ...parsed, at: Date.now() }
      await getKV(env).put(POW_CACHE_KEY, JSON.stringify(value), { expirationTtl: POW_CACHE_TTL }).catch(() => {})
      return value
    }
  } catch { /* 首页抓不到时使用默认 sdk.js */ }

  return { scripts: [DEFAULT_POW_SCRIPT], build: '', at: 0 }
}

// =====================================================================
// Sentinel chat requirements
// =====================================================================

interface ChatRequirements {
  token: string
  proofToken: string
  turnstileToken: string
  soToken: string
}

async function getChatRequirements(
  fp: Fingerprint,
  accessToken: string,
  accountId: string,
  resources: PowResources,
): Promise<ChatRequirements> {
  const basePath = accessToken ? '/backend-api' : '/backend-anon'
  const authHeaders: Record<string, string> = {}
  if (accessToken) authHeaders.Authorization = `Bearer ${accessToken}`
  if (accountId) authHeaders['Chatgpt-Account-Id'] = accountId

  const pToken = buildRequirementsToken(fp.ua, resources.scripts, resources.build)
  const preparePath = `${basePath}/sentinel/chat-requirements/prepare`
  const prepareRes = await fetch(BASE_URL + preparePath, {
    method: 'POST',
    headers: browserHeaders(fp, preparePath, authHeaders),
    body: JSON.stringify({ p: pToken }),
    signal: AbortSignal.timeout(REQUIREMENTS_TIMEOUT_MS),
  })
  if (!prepareRes.ok) {
    const body = await readErrorBody(prepareRes)
    throw new WebHttpError(`chat-requirements/prepare 失败 HTTP ${prepareRes.status}: ${body.slice(0, 300)}`, prepareRes.status, body)
  }
  const prepare = await prepareRes.json() as Record<string, any>

  if (prepare?.arkose?.required) {
    throw new WebHttpError('上游要求 Arkose 人机校验，当前实现未接第三方打码服务', 403, 'arkose_required')
  }

  let proofToken = ''
  if (prepare?.proofofwork?.required) {
    proofToken = buildProofToken(
      String(prepare.proofofwork.seed || ''),
      String(prepare.proofofwork.difficulty || '0'),
      fp.ua,
      resources.scripts,
      resources.build,
    )
  }

  let turnstileToken = ''
  if (prepare?.turnstile?.required && prepare.turnstile.dx) {
    turnstileToken = solveTurnstileToken(String(prepare.turnstile.dx), pToken)
  }

  const finalizePath = `${basePath}/sentinel/chat-requirements/finalize`
  const finalizeRes = await fetch(BASE_URL + finalizePath, {
    method: 'POST',
    headers: browserHeaders(fp, finalizePath, authHeaders),
    body: JSON.stringify({
      prepare_token: prepare?.prepare_token || '',
      proof_token: proofToken,
      turnstile_token: turnstileToken,
    }),
    signal: AbortSignal.timeout(REQUIREMENTS_TIMEOUT_MS),
  })
  if (!finalizeRes.ok) {
    const body = await readErrorBody(finalizeRes)
    throw new WebHttpError(`chat-requirements/finalize 失败 HTTP ${finalizeRes.status}: ${body.slice(0, 300)}`, finalizeRes.status, body)
  }
  const finalize = await finalizeRes.json() as Record<string, any>
  const token = String(finalize?.token || '')
  if (!token) {
    throw new WebHttpError(`finalize 未返回 chat requirements token: ${JSON.stringify(finalize).slice(0, 300)}`, 502, 'missing_token')
  }
  return {
    token,
    proofToken,
    turnstileToken,
    soToken: String(finalize?.so_token || ''),
  }
}

// =====================================================================
// 会话请求体 / SSE 解析
// =====================================================================

interface OpenAIMessage {
  role?: string
  content?: unknown
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (typeof content === 'number' || typeof content === 'boolean') return String(content)
  if (Array.isArray(content)) {
    let text = ''
    for (const part of content) {
      if (typeof part === 'string') { text += part; continue }
      if (typeof part === 'number' || typeof part === 'boolean') { text += String(part); continue }
      if (!part || typeof part !== 'object') continue
      const item = part as Record<string, any>
      if (typeof item.text === 'string') { text += item.text; continue }
      if (item.type === 'image_url' || item.type === 'input_image') {
        // 网页 conversation 支持图片，但需要先 upload；首版只处理文本
        text += '[图片已省略：当前渠道仅支持文本]'
        continue
      }
      try { text += JSON.stringify(item) } catch { /* ignore */ }
    }
    return text
  }
  if (content && typeof content === 'object') {
    const item = content as Record<string, any>
    if (typeof item.text === 'string') return item.text
    try { return JSON.stringify(content) } catch { return '' }
  }
  return ''
}

/** 把 assistant.tool_calls 折成文本，避免整条消息因为没有 content 被丢掉 */
function toolCallsToText(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls)) return ''
  const lines: string[] = []
  for (const call of toolCalls) {
    if (!call || typeof call !== 'object') continue
    const fn = (call as Record<string, any>).function || {}
    const name = String(fn.name || 'tool')
    let args = ''
    if (typeof fn.arguments === 'string') args = fn.arguments
    else if (fn.arguments !== undefined) {
      try { args = JSON.stringify(fn.arguments) } catch { args = String(fn.arguments) }
    }
    lines.push(`[tool_call ${name}${args ? `(${args})` : ''}]`)
  }
  return lines.join('\n')
}

function messageToText(message: OpenAIMessage): string {
  const text = contentToText(message?.content)
  const calls = toolCallsToText((message as Record<string, any>)?.tool_calls)
  const role = String(message?.role || '').toLowerCase()
  const toolCallId = (message as Record<string, any>)?.tool_call_id
  const prefix = role === 'tool' && toolCallId ? `[tool_result ${toolCallId}]` : ''
  return [prefix, text, calls].filter(Boolean).join('\n')
}

function toWebMessages(messages: OpenAIMessage[]): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = []
  for (const message of messages) {
    const text = messageToText(message)
    if (!text) continue
    let role = String(message?.role || 'user').toLowerCase()
    if (role === 'tool' || role === 'function') role = 'user'
    if (role !== 'assistant' && role !== 'system') role = 'user'
    out.push({
      id: randomId(),
      author: { role },
      content: { content_type: 'text', parts: [text] },
    })
  }
  return out
}

/** 422 兜底：把整段上下文压成一条 user 消息，绕开网页端对复杂 messages 结构的限制 */
function buildFlatConversationPayload(
  model: string,
  messages: OpenAIMessage[],
  body: Record<string, any>,
): Record<string, any> | null {
  const blocks: string[] = []
  for (const message of messages) {
    const text = messageToText(message)
    if (!text) continue
    const role = String(message?.role || 'user').toLowerCase()
    blocks.push(`[${role}]\n${text}`)
  }
  const flat = blocks.join('\n\n').trim()
  if (!flat) return null
  // 兜底重试不带推理强度，避免非法 thinking_effort 再次触发 422
  return buildConversationPayload(model, [{ role: 'user', content: flat }], {
    ...body,
    thinking_effort: '',
    reasoning_effort: '',
    reasoning: undefined,
  })
}

export function isWebImageGenerationRequest(body: Record<string, any>, model: string): boolean {
  return isImageIntentRequest(body, model)
}

function buildConversationPayload(
  model: string,
  messages: OpenAIMessage[],
  body: Record<string, any>,
): Record<string, any> {
  const isImageMode = isWebImageGenerationRequest(body, model)
  // picture_v2 生图走 auto 模型，与 chatgpt 网页端行为一致；
  // 否则上游可能把 gpt-6-luna 之类的展示名当模型 slug 拒掉。
  const actualModel = isImageMode ? 'auto' : model
  const payload: Record<string, any> = {
    action: 'next',
    messages: toWebMessages(messages),
    model: actualModel,
    parent_message_id: randomId(),
    conversation_mode: { kind: 'primary_assistant' },
    conversation_origin: null,
    force_paragen: false,
    force_paragen_model_slug: '',
    force_rate_limit: false,
    force_use_sse: true,
    // 临时对话（history_and_training_disabled=true）不支持生图，上游会直接回
    // “image generation isn’t available in this temporary chat”；生图模式必须走常规会话。
    history_and_training_disabled: !isImageMode,
    reset_rate_limits: false,
    suggestions: [],
    supported_encodings: [],
    system_hints: isImageMode ? ['picture_v2'] : [],
    timezone: 'Asia/Shanghai',
    timezone_offset_min: -480,
    variant_purpose: 'comparison_implicit',
    websocket_request_id: randomId(),
    client_contextual_info: {
      is_dark_mode: false,
      time_since_loaded: 120,
      page_height: 900,
      page_width: 1400,
      pixel_ratio: 2,
      screen_height: 1440,
      screen_width: 2560,
    },
  }
  const effort = String(
    body?.thinking_effort || body?.reasoning_effort || body?.reasoning?.effort || '',
  ).trim().toLowerCase()
  // 网页端 thinking_effort 只认 standard / extended / max；
  // low/medium/high 原样透传会直接 422 Invalid conversation body（ZCode 默认发 medium）。
  const effortMap: Record<string, string> = {
    minimal: 'standard',
    low: 'standard',
    medium: 'standard',
    high: 'extended',
    xhigh: 'max',
    standard: 'standard',
    extended: 'extended',
    max: 'max',
  }
  if (effortMap[effort]) payload.thinking_effort = effortMap[effort]
  return payload
}

function isVisibleAssistantMessage(message: Record<string, any>): boolean {
  const author = message?.author
  if (!author || String(author.role || '').toLowerCase() !== 'assistant') return false
  const metadata = message?.metadata
  if (metadata && metadata.is_visually_hidden_from_conversation === true) return false
  const recipient = String(message?.recipient || '').trim().toLowerCase()
  if (recipient && recipient !== 'all') return false
  const channel = String(message?.channel || '').trim().toLowerCase()
  if (channel && channel !== 'final') return false
  return true
}

function assistantMessageText(message: Record<string, any>): string {
  const content = message?.content
  if (!content) return ''
  const parts = content.parts
  if (Array.isArray(parts)) {
    const text = parts.filter((p: unknown) => typeof p === 'string').join('')
    if (text) return text
  }
  if (typeof content.text === 'string') return content.text
  return ''
}

function visibleAssistantText(event: Record<string, any>): string | null {
  for (const candidate of [event, event?.v]) {
    if (!candidate || typeof candidate !== 'object') continue
    const message = candidate.message
    if (!message || typeof message !== 'object') continue
    if (!isVisibleAssistantMessage(message)) continue
    const text = assistantMessageText(message)
    if (text) return text
  }
  return null
}

function applyTextOperation(event: Record<string, any>, current: string): string {
  const op = String(event?.o || '')
  const value = typeof event?.v === 'string' ? event.v : ''
  if (op === 'append') return current + value
  if (op === 'replace') return value
  return current
}

function nextAssistantText(event: Record<string, any>, current: string): string {
  const visible = visibleAssistantText(event)
  if (visible !== null) return visible

  if (event?.p === '/message/content/parts/0') {
    return applyTextOperation(event, current)
  }
  if (event?.o === 'patch' && Array.isArray(event.v)) {
    let text = current
    for (const item of event.v) {
      if (item && typeof item === 'object') text = nextAssistantText(item, text)
    }
    return text
  }
  if (typeof event?.v === 'string' && !event?.p && !event?.o && current) {
    return current + event.v
  }
  return current
}

function sanitizeOutputText(text: string): string {
  if (!text) return ''
  const isInternal = (part: string): boolean => {
    const value = part.trim()
    if (!value) return true
    const lower = value.toLowerCase()
    return /^turn\d+[a-z]*\d*$/.test(lower) || /^turn\d+\w*$/.test(lower)
      || lower.startsWith('turn') || lower.startsWith('source') || lower.startsWith('sources')
  }
  const readable = (parts: string[]): string => {
    for (const part of parts) {
      const value = part.trim()
      if (value && !isInternal(value)) return value
    }
    return ''
  }
  const annotationText = (payload: string): string => {
    const parts = payload.split('\ue202').map((s) => s.trim())
    const kind = (parts[0] || '').toLowerCase()
    const data = parts.slice(1)
    if (kind === 'url') {
      const label = data[0] || ''
      const url = data[1] || ''
      if (label && /^https?:\/\//.test(url)) return `${label} (${url})`
      return label || url
    }
    return readable(data)
  }

  return text
    .replace(/(\s*)\ue200([^\ue201]*)\ue201(?=[.,;:!?])/g, (_m, lead: string, payload: string) => {
      const value = annotationText(payload)
      return value ? `${lead}${value}` : ''
    })
    .replace(/\ue200([^\ue201]*)\ue201/g, (_m, payload: string) => annotationText(payload))
    .replace(/\ue200[^\ue201]*$/, '')
}

function estimateTokens(text: string): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0
}

/** 上游偶尔会把历史 assistant 文本拼在流开头，按参考实现剥掉前缀 */
function stripHistory(text: string, historyText: string): string {
  let out = text || ''
  const history = historyText || ''
  while (history && out.startsWith(history)) out = out.slice(history.length)
  return out
}

// =====================================================================
// 账号健康 / 冷却（与 antigravity / codex 同策略）
// =====================================================================

interface WebAccountHealth {
  cooldownUntil: number
  reason?: string
}
type WebHealthMap = Record<string, WebAccountHealth>

async function readHealth(env: Env, providerId: string): Promise<WebHealthMap> {
  try {
    const raw = await getKV(env).get(HEALTH_PREFIX + providerId)
    return raw ? JSON.parse(raw) as WebHealthMap : {}
  } catch { return {} }
}

async function writeHealth(env: Env, providerId: string, health: WebHealthMap): Promise<void> {
  const now = Date.now()
  const kept: WebHealthMap = {}
  for (const [key, value] of Object.entries(health)) {
    if (value && value.cooldownUntil > now) kept[key] = value
  }
  try {
    if (Object.keys(kept).length) await getKV(env).put(HEALTH_PREFIX + providerId, JSON.stringify(kept))
    else await getKV(env).delete(HEALTH_PREFIX + providerId)
  } catch { /* 冷却状态写失败不影响本次转发 */ }
}

function orderByCooldown<T extends { hash: string }>(accounts: T[], health: WebHealthMap): T[] {
  const now = Date.now()
  const healthy: T[] = []
  const probation: T[] = []
  const cooling: T[] = []
  for (const account of accounts) {
    const entry = health[account.hash]
    if (!entry?.cooldownUntil) healthy.push(account)
    else if (now >= entry.cooldownUntil) probation.push(account)
    else cooling.push(account)
  }
  const shuffle = (list: T[]): void => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = list[i]
      list[i] = list[j]
      list[j] = tmp
    }
  }
  shuffle(healthy)
  shuffle(probation)
  shuffle(cooling)
  return [...healthy, ...probation, ...cooling]
}

// =====================================================================
// 网页图片提取与下载工具
// =====================================================================

function extractImagePointers(rawText: string): Array<{ pointer: string }> {
  const pointers: Array<{ pointer: string }> = []
  const seen = new Set<string>()
  const matches = rawText.matchAll(/(?:file-service:\/\/|sediment:\/\/)([A-Za-z0-9_-]+)/g)
  for (const m of matches) {
    const p = m[0]
    if (!seen.has(p)) {
      seen.add(p)
      pointers.push({ pointer: p })
    }
  }
  return pointers
}

async function fetchWebImageDownloadUrl(
  fp: Fingerprint,
  token: string,
  accountId: string,
  pointer: string,
  conversationId?: string,
): Promise<string> {
  let url = ''
  if (pointer.startsWith('file-service://')) {
    const fid = pointer.slice('file-service://'.length)
    url = `${BASE_URL}/backend-api/files/${encodeURIComponent(fid)}/download`
  } else if (pointer.startsWith('sediment://')) {
    const fid = pointer.slice('sediment://'.length)
    if (conversationId) {
      url = `${BASE_URL}/backend-api/conversation/${encodeURIComponent(conversationId)}/attachment/${encodeURIComponent(fid)}/download`
    } else {
      url = `${BASE_URL}/backend-api/files/download/${encodeURIComponent(fid)}`
    }
  } else {
    url = `${BASE_URL}/backend-api/files/${encodeURIComponent(pointer)}/download`
  }

  const path = new URL(url).pathname
  const headers = browserHeaders(fp, path, {
    Accept: 'application/json, text/plain, */*',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(accountId ? { 'Chatgpt-Account-Id': accountId } : {}),
  })

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    })

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (loc) return loc
    }

    if (res.ok) {
      const data = await res.json() as any
      return String(data?.download_url || data?.url || '')
    }
  } catch {}
  return ''
}

async function downloadImageAsBase64(
  url: string,
  fp: Fingerprint,
  token: string,
  accountId: string,
): Promise<{ b64: string; mime: string } | null> {
  if (!url) return null
  const needAuth = url.startsWith(BASE_URL)
  const headers: Record<string, string> = {
    'User-Agent': fp.ua,
    Accept: 'image/*,*/*;q=0.8',
    ...(needAuth ? {
      Authorization: `Bearer ${token}`,
      ...(accountId ? { 'Chatgpt-Account-Id': accountId } : {}),
    } : {}),
  }

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return null
    const mime = (res.headers.get('content-type') || 'image/png').split(';')[0].trim()
    const buf = await res.arrayBuffer()
    const bytes = new Uint8Array(buf)
    const b64 = bytesToBase64(bytes)
    return { b64, mime }
  } catch {
    return null
  }
}

async function pollConversationForPointers(
  fp: Fingerprint,
  token: string,
  accountId: string,
  conversationId: string,
): Promise<Array<{ pointer: string }>> {
  const path = `/backend-api/conversation/${conversationId}`
  const headers = browserHeaders(fp, path, {
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(accountId ? { 'Chatgpt-Account-Id': accountId } : {}),
  })
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const res = await fetch(BASE_URL + path, { headers, signal: AbortSignal.timeout(15000) })
      if (res.ok) {
        const text = await res.text()
        const ptrs = extractImagePointers(text)
        if (ptrs.length > 0) return ptrs
      }
    } catch {}
  }
  return []
}

// =====================================================================
// 对外入口
// =====================================================================

export async function handleChatgptWebRequest(p: OAuthCallParams): Promise<Response> {
  const tokens = [...new Set(
    (p.refreshTokens || []).map(extractRefreshToken).filter(Boolean),
  )]
  if (!tokens.length) {
    return oauthErrorResponse(
      '该 chatgptweb 渠道未配置凭据：一行一个账号，直接粘贴发货整行「账号----GPT密码----邮箱密码----rt.1.xxx」，或只填 rt.1.xxx / rt_xxx',
      400,
      'configuration_error',
    )
  }

  const messages = Array.isArray(p.body?.messages) ? (p.body.messages as OpenAIMessage[]) : []
  if (!messages.length) {
    return oauthErrorResponse('messages 内容为空，无法转发', 400, 'invalid_request_error')
  }
  const stream = p.body?.stream === true

  let lastError = ''
  let lastStatus = 502
  const attempts = await Promise.all(tokens.map(async (raw, index) => ({
    raw,
    index: index + 1,
    hash: await sha256Hex(raw),
  })))
  const health = await readHealth(p.env, p.providerId)
  const ordered = orderByCooldown(attempts, health)
  let healthChanged = false
  const coolingCount = ordered.filter((a) => {
    const entry = health[a.hash]
    return !!entry?.cooldownUntil && Date.now() < entry.cooldownUntil
  }).length

  const markFailed = (hash: string, reason: string, cooldownMs: number): void => {
    health[hash] = { cooldownUntil: Date.now() + Math.min(cooldownMs, COOLDOWN_MAX_MS), reason: reason.slice(0, 160) }
    healthChanged = true
  }
  const markOk = (hash: string): void => {
    if (health[hash]) {
      delete health[hash]
      healthChanged = true
    }
  }
  const persist = async (): Promise<void> => {
    if (!healthChanged) return
    healthChanged = false
    await writeHealth(p.env, p.providerId, health)
  }

  // bootstrap 与账号无关，只做一次
  const bootstrapFp = await buildFingerprint(tokens[0])
  const resources = await getPowResources(p.env, bootstrapFp)

  for (const attempt of ordered) {
    const fp = await buildFingerprint(attempt.raw)
    try {
      const { token, accountId } = await resolveAccountToken(p.env, attempt.raw)
      const requirements = await getChatRequirements(fp, token, accountId, resources)
      const path = token ? '/backend-api/conversation' : '/backend-anon/conversation'
      const headers = browserHeaders(fp, path, {
        Accept: 'text/event-stream',
        'OpenAI-Sentinel-Chat-Requirements-Token': requirements.token,
        ...(requirements.proofToken ? { 'OpenAI-Sentinel-Proof-Token': requirements.proofToken } : {}),
        ...(requirements.turnstileToken ? { 'OpenAI-Sentinel-Turnstile-Token': requirements.turnstileToken } : {}),
        ...(requirements.soToken ? { 'OpenAI-Sentinel-SO-Token': requirements.soToken } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(accountId ? { 'Chatgpt-Account-Id': accountId } : {}),
      })
      const payload = buildConversationPayload(p.modelId, messages, p.body || {})
      if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
        return oauthErrorResponse(
          '客户端请求中没有可转换的文本内容（可能是纯 tool_calls / 图片消息）；当前 chatgptweb 渠道只支持文本',
          400,
          'invalid_request_error',
        )
      }
      const sendConversation = async (requestBody: Record<string, any>): Promise<Response> => fetch(BASE_URL + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(CONVERSATION_TIMEOUT_MS),
      })
      let upstream = await sendConversation(payload)

      if (!upstream.ok) {
        let errorText = await readErrorBody(upstream)
        // 网页端对复杂 messages（tool_calls/超长历史等）偶尔直接 422；
        // 用扁平单条 user 消息重试一次，保住 Agent 类客户端的这一轮请求。
        if (upstream.status === 422 && /invalid conversation body/i.test(errorText)) {
          const flatPayload = buildFlatConversationPayload(p.modelId, messages, p.body || {})
          if (flatPayload) {
            upstream = await sendConversation(flatPayload)
            if (!upstream.ok) errorText = await readErrorBody(upstream)
          }
        }
        if (!upstream.ok) {
          lastStatus = upstream.status
          lastError = `HTTP ${upstream.status}: ${errorText.slice(0, 300)}`
          const challenge = /cf_chl_opt|challenge-platform|<!DOCTYPE html/i.test(lastError)
          if (upstream.status === 429) {
            const retryAfter = Number(upstream.headers.get('retry-after'))
            const reset = (retryAfter > 0 ? retryAfter * 1000 : 0) || 0
            markFailed(attempt.hash, `429 ${lastError.slice(0, 120)}`, reset > 0 ? reset + 60_000 : COOLDOWN_QUOTA_MS)
            continue
          }
          if (upstream.status === 401 || upstream.status === 403) {
            markFailed(
              attempt.hash,
              challenge ? `egress challenge` : lastError.slice(0, 120),
              challenge ? COOLDOWN_TRANSIENT_MS : COOLDOWN_AUTH_MS,
            )
            continue
          }
          if (upstream.status >= 500) {
            markFailed(attempt.hash, lastError.slice(0, 120), COOLDOWN_TRANSIENT_MS)
            continue
          }
          // 400/404/422 等请求级错误：换账号通常也无济于事，直接返回上游原因
          await persist()
          return oauthErrorResponse(lastError, upstream.status, 'upstream_error')
        }
      }

      markOk(attempt.hash)
      defer(p, persist())
      const extraHeaders: Record<string, string> = {
        'x-chatgptweb-account': String(attempt.index),
        'x-chatgptweb-cooldown': String(coolingCount),
      }

      if (!upstream.body) {
        return oauthErrorResponse('上游未返回响应体', 502, 'upstream_error')
      }

      const isImageMode = isWebImageGenerationRequest(p.body || {}, p.modelId)
      const streamOpts: WebStreamOptions = { fp, token, accountId, isImageMode }

      if (stream) {
        const sse = createOpenAIStream(upstream.body, p.requestedModel, p, messages, streamOpts)
        return new Response(sse, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            ...extraHeaders,
          },
        })
      }

      const result = await collectSseToJson(upstream.body, p.requestedModel, messages, streamOpts)
      defer(p, recordOAuthUsage(p, {
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
      }, true, 200))
      return new Response(JSON.stringify(result.json), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
      })
    } catch (err) {
      const authFailed = err instanceof WebAuthError
      const httpErr = err instanceof WebHttpError ? err : null
      lastStatus = authFailed ? 401 : httpErr?.status || 502
      lastError = (err as Error).message || '未知错误'
      const challenge = /cf_chl_|challenge-platform|<!DOCTYPE html/i.test(lastError)
      const cooldown = authFailed || (httpErr && (httpErr.status === 401 || httpErr.status === 403))
        ? (challenge ? COOLDOWN_TRANSIENT_MS : COOLDOWN_AUTH_MS)
        : COOLDOWN_TRANSIENT_MS
      markFailed(attempt.hash, `exception ${lastError.slice(0, 120)}`, cooldown)
      continue
    }
  }

  await persist()
  return oauthErrorResponse(
    `所有 ChatGPT 网页版账号均失败，最后一次错误: ${lastError || '未知'}`,
    lastStatus === 401 ? 401 : lastStatus,
    lastStatus === 401 ? 'authentication_error' : 'key_exhausted',
  )
}

// =====================================================================
// SSE → OpenAI
// =====================================================================

function sseChunk(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: { id: string; model: string },
  delta: Record<string, any>,
  finishReason: string | null = null,
  usage?: { prompt: number; completion: number },
): void {
  const chunk: Record<string, any> = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  }
  if (usage) {
    chunk.usage = {
      prompt_tokens: usage.prompt,
      completion_tokens: usage.completion,
      total_tokens: usage.prompt + usage.completion,
    }
  }
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
}

export interface WebStreamOptions {
  fp?: Fingerprint
  token?: string
  accountId?: string
  isImageMode?: boolean
}

function createOpenAIStream(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
  p: OAuthCallParams,
  messages: OpenAIMessage[],
  options?: WebStreamOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const state = { id: `chatcmpl-chatgptweb-${randomId()}`, model: requestedModel }
  const reader = upstream.getReader()
  const promptTokens = estimateTokens(messages.map((m) => contentToText(m.content)).join('\n'))
  const historyText = messages
    .filter((m) => String(m.role || '').toLowerCase() === 'assistant')
    .map((m) => contentToText(m.content))
    .join('')

  let buffer = ''
  let text = ''
  let roleSent = false
  let finished = false
  let completionTokens = 0
  const imagePointers: string[] = []
  let conversationId = ''

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = (reason = 'stop'): void => {
        if (finished) return
        finished = true
        if (!roleSent) sseChunk(controller, encoder, state, { role: 'assistant', content: '' })
        completionTokens = completionTokens || estimateTokens(text)
        sseChunk(controller, encoder, state, {}, reason, { prompt: promptTokens, completion: completionTokens })
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        defer(p, recordOAuthUsage(p, { promptTokens, completionTokens }, true, 200))
        try { controller.close() } catch { /* closed */ }
      }

      const handle = (payload: string): void => {
        if (finished) return
        if (payload === '[DONE]') { finish('stop'); return }
        let event: Record<string, any>
        try { event = JSON.parse(payload) as Record<string, any> } catch { return }
        if (!event || typeof event !== 'object') return
        if (!conversationId && event.conversation_id) conversationId = String(event.conversation_id)
        if (!conversationId && event.v?.conversation_id) conversationId = String(event.v.conversation_id)
        const matches = payload.matchAll(/(?:file-service:\/\/|sediment:\/\/)([A-Za-z0-9_-]+)/g)
        for (const m of matches) {
          if (!imagePointers.includes(m[0])) imagePointers.push(m[0])
        }
        if (event.type === 'moderation' && event.moderation_response?.blocked === true) {
          if (!roleSent) { roleSent = true; sseChunk(controller, encoder, state, { role: 'assistant', content: '' }) }
          sseChunk(controller, encoder, state, { content: '\n[内容被上游审核拦截]' })
          finish('content_filter')
          return
        }
        const next = sanitizeOutputText(stripHistory(nextAssistantText(event, text), historyText))
        if (next === text) return
        const delta = next.startsWith(text) ? next.slice(text.length) : next
        text = next
        if (!delta) return
        if (!roleSent) {
          roleSent = true
          sseChunk(controller, encoder, state, { role: 'assistant', content: '' })
        }
        sseChunk(controller, encoder, state, { content: delta })
        completionTokens = estimateTokens(text)
      }

      const pump = (): void => {
        reader.read().then(({ done, value }) => {
          if (done) {
            if (buffer.trim()) handle(buffer.trim())
            const wrapFinish = async () => {
              // 不依赖 isImageMode：上游自发返回图片指针时也要下载，否则客户端只看到空消息
              if (options?.token && options?.fp && imagePointers.length > 0) {
                const images: Array<{ type: 'image_url'; image_url: { url: string } }> = []
                for (const ptr of imagePointers.slice(0, 4)) {
                  const dlUrl = await fetchWebImageDownloadUrl(options.fp, options.token, options.accountId || '', ptr, conversationId)
                  if (dlUrl) {
                    const downloaded = await downloadImageAsBase64(dlUrl, options.fp, options.token, options.accountId || '')
                    if (downloaded) {
                      images.push({
                        type: 'image_url',
                        image_url: { url: `data:${downloaded.mime};base64,${downloaded.b64}` },
                      })
                    }
                  }
                }
                if (images.length > 0) {
                  sseChunk(controller, encoder, state, { images })
                }
              }
              finish('stop')
            }
            void wrapFinish()
            return
          }
          buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '')
          let index = buffer.indexOf('\n\n')
          while (index >= 0 && !finished) {
            const block = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            const data = block.split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n')
            if (data) handle(data)
            index = buffer.indexOf('\n\n')
          }
          if (!finished) pump()
        }).catch((err) => {
          if (finished) return
          if (!roleSent) { roleSent = true; sseChunk(controller, encoder, state, { role: 'assistant', content: '' }) }
          sseChunk(controller, encoder, state, { content: `\n[chatgptweb] ${(err as Error).message || '上游流中断'}` })
          finish('stop')
        })
      }
      pump()
    },
    cancel() {
      finished = true
      reader.cancel().catch(() => {})
    },
  })
}

async function collectSseToJson(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
  messages: OpenAIMessage[],
  options?: WebStreamOptions,
): Promise<{ json: Record<string, any>; promptTokens: number; completionTokens: number }> {
  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  const promptTokens = estimateTokens(messages.map((m) => contentToText(m.content)).join('\n'))
  const historyText = messages
    .filter((m) => String(m.role || '').toLowerCase() === 'assistant')
    .map((m) => contentToText(m.content))
    .join('')
  let buffer = ''
  let text = ''
  let blocked = false
  let done = false
  const imagePointers: string[] = []
  let conversationId = ''

  const handle = (payload: string): void => {
    if (payload === '[DONE]') { done = true; return }
    let event: Record<string, any>
    try { event = JSON.parse(payload) as Record<string, any> } catch { return }
    if (!event || typeof event !== 'object') return
    if (!conversationId && event.conversation_id) conversationId = String(event.conversation_id)
    if (!conversationId && event.v?.conversation_id) conversationId = String(event.v.conversation_id)
    const matches = payload.matchAll(/(?:file-service:\/\/|sediment:\/\/)([A-Za-z0-9_-]+)/g)
    for (const m of matches) {
      if (!imagePointers.includes(m[0])) imagePointers.push(m[0])
    }
    if (event.type === 'moderation' && event.moderation_response?.blocked === true) blocked = true
    const next = sanitizeOutputText(stripHistory(nextAssistantText(event, text), historyText))
    if (next) text = next
  }

  while (!done) {
    const { done: streamDone, value } = await reader.read()
    if (streamDone) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '')
    let index = buffer.indexOf('\n\n')
    while (index >= 0 && !done) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const data = block.split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data) handle(data)
      index = buffer.indexOf('\n\n')
    }
  }
  if (!done && buffer.trim()) handle(buffer.trim())
  try { await reader.cancel() } catch { /* ignore */ }

  const images: Array<{ type: 'image_url'; image_url: { url: string } }> = []
  // 不依赖 isImageMode：只要上游返回图片指针就解析下载
  if (options?.token && options?.fp) {
    if (imagePointers.length === 0 && conversationId) {
      const polled = await pollConversationForPointers(options.fp, options.token, options.accountId || '', conversationId)
      for (const p of polled) {
        if (!imagePointers.includes(p.pointer)) imagePointers.push(p.pointer)
      }
    }
    for (const ptr of imagePointers.slice(0, 4)) {
      const dlUrl = await fetchWebImageDownloadUrl(options.fp, options.token, options.accountId || '', ptr, conversationId)
      if (dlUrl) {
        const downloaded = await downloadImageAsBase64(dlUrl, options.fp, options.token, options.accountId || '')
        if (downloaded) {
          images.push({
            type: 'image_url',
            image_url: { url: `data:${downloaded.mime};base64,${downloaded.b64}` },
          })
        }
      }
    }
  }

  const completionTokens = estimateTokens(text)
  const content = blocked && !text ? '[内容被上游审核拦截]' : text
  const messageChoice: Record<string, any> = { role: 'assistant', content }
  if (images.length > 0) {
    messageChoice.images = images
  }

  return {
    promptTokens,
    completionTokens,
    json: {
      id: `chatcmpl-chatgptweb-${randomId()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{
        index: 0,
        message: messageChoice,
        finish_reason: blocked ? 'content_filter' : 'stop',
        logprobs: null,
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    },
  }
}

// =====================================================================
// 后台：模型清单 / 连通性测试
// =====================================================================

export function listChatgptWebModels(): { models: string[] } {
  return { models: [...WEB_MODELS] }
}

/** 实时拉取网页端模型目录（凭据走网关自己的 AT 缓存，避免在别处刷新 RT） */
export async function fetchChatgptWebModels(
  env: Env,
  refreshToken: string,
): Promise<{
  success: boolean
  models: string[]
  details?: Array<Record<string, any>>
  message?: string
}> {
  const raw = extractRefreshToken(refreshToken)
  if (!raw) return { success: false, models: [], message: '未填写 refresh_token（rt.1.xxx / rt_xxx）' }
  const fp = await buildFingerprint(raw)
  try {
    const { token, accountId } = await resolveAccountToken(env, raw)
    const path = '/backend-api/models?history_and_training_disabled=false'
    const res = await fetch(BASE_URL + path, {
      headers: browserHeaders(fp, path, {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(accountId ? { 'Chatgpt-Account-Id': accountId } : {}),
      }),
      signal: AbortSignal.timeout(REQUIREMENTS_TIMEOUT_MS),
    })
    if (!res.ok) {
      return {
        success: false,
        models: [],
        message: `HTTP ${res.status}: ${(await readErrorBody(res)).slice(0, 200)}`,
      }
    }
    const payload = await res.json() as Record<string, any>
    const items: any[] = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
    const models = items
      .map((item) => String(item?.id || item?.slug || item?.model_slug || '').trim())
      .filter((id, index, list) => id && list.indexOf(id) === index)
    const details = items
      .map((item) => ({
        id: String(item?.id || item?.slug || item?.model_slug || '').trim(),
        title: String(item?.title || item?.display_name || item?.name || '').trim(),
        max_tokens: item?.max_tokens ?? item?.max_output_tokens ?? null,
        context_window: item?.context_window ?? item?.context_length ?? null,
        description: String(item?.description || '').slice(0, 240),
      }))
      .filter((item, index, list) => item.id && list.findIndex((x) => x.id === item.id) === index)
    return {
      success: true,
      models,
      details,
      message: models.length ? `获取到 ${models.length} 个模型` : '上游返回的模型目录为空',
    }
  } catch (err) {
    return { success: false, models: [], message: (err as Error).message || '获取模型失败' }
  }
}

export async function testChatgptWeb(
  env: Env,
  refreshToken: string,
  modelId: string,
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const raw = extractRefreshToken(refreshToken)
  if (!raw) return { success: false, message: '未填写 refresh_token（rt.1.xxx / rt_xxx）', statusCode: 0 }
  const fp = await buildFingerprint(raw)
  try {
    const { token, accountId } = await resolveAccountToken(env, raw)
    const resources = await getPowResources(env, fp)
    const requirements = await getChatRequirements(fp, token, accountId, resources)
    const path = token ? '/backend-api/conversation' : '/backend-anon/conversation'
    const headers = browserHeaders(fp, path, {
      Accept: 'text/event-stream',
      'OpenAI-Sentinel-Chat-Requirements-Token': requirements.token,
      ...(requirements.proofToken ? { 'OpenAI-Sentinel-Proof-Token': requirements.proofToken } : {}),
      ...(requirements.turnstileToken ? { 'OpenAI-Sentinel-Turnstile-Token': requirements.turnstileToken } : {}),
      ...(requirements.soToken ? { 'OpenAI-Sentinel-SO-Token': requirements.soToken } : {}),
      Authorization: `Bearer ${token}`,
      ...(accountId ? { 'Chatgpt-Account-Id': accountId } : {}),
    })
    const payload = buildConversationPayload(modelId || 'gpt-5-5', [{ role: 'user', content: 'hi' }], {})
    const res = await fetch(BASE_URL + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    })
    if (res.ok) {
      try { await res.body?.cancel() } catch { /* ignore */ }
      return { success: true, message: '连接成功', statusCode: 200 }
    }
    return {
      success: false,
      message: `HTTP ${res.status}: ${(await readErrorBody(res)).slice(0, 200)}`,
      statusCode: res.status,
    }
  } catch (err) {
    return {
      success: false,
      message: (err as Error).message || '连接失败',
      statusCode: err instanceof WebAuthError ? 401 : (err instanceof WebHttpError ? err.status : 0),
    }
  }
}

// =====================================================================
// /v1/images/generations 生图接口支持
// =====================================================================

async function generateChatgptWebImageWithToken(
  env: Env,
  accessToken: string,
  accountId: string,
  fingerprintSeed: string,
  body: Record<string, any>,
  timeoutMs = 110_000,
): Promise<{ ok: boolean; httpStatus: number; body?: string; contentType?: string; error?: string; code?: string }> {
  const prompt = String(body.prompt ?? body.input ?? '').trim()
  if (!prompt) {
    return { ok: false, httpStatus: 400, error: '缺少 prompt 参数' }
  }
  if (!accessToken) {
    return { ok: false, httpStatus: 401, error: '未配置可用的 ChatGPT 网页版凭据' }
  }

  const fp = await buildFingerprint(fingerprintSeed)
  try {
    const resources = await getPowResources(env, fp)
    const requirements = await getChatRequirements(fp, accessToken, accountId, resources)
    const path = accessToken ? '/backend-api/conversation' : '/backend-anon/conversation'
    const headers = browserHeaders(fp, path, {
      Accept: 'text/event-stream',
      'OpenAI-Sentinel-Chat-Requirements-Token': requirements.token,
      ...(requirements.proofToken ? { 'OpenAI-Sentinel-Proof-Token': requirements.proofToken } : {}),
      ...(requirements.turnstileToken ? { 'OpenAI-Sentinel-Turnstile-Token': requirements.turnstileToken } : {}),
      ...(requirements.soToken ? { 'OpenAI-Sentinel-SO-Token': requirements.soToken } : {}),
      Authorization: `Bearer ${accessToken}`,
      ...(accountId ? { 'Chatgpt-Account-Id': accountId } : {}),
    })

    const payload = buildConversationPayload('auto', [{ role: 'user', content: prompt }], {
      ...body,
      image_generation: true,
    })

    const res = await fetch(BASE_URL + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.min(timeoutMs, 90_000)),
    })

    if (!res.ok) {
      const errText = await readErrorBody(res)
      return {
        ok: false,
        httpStatus: res.status,
        error: `ChatGPT 网页版生图失败 HTTP ${res.status}: ${errText.slice(0, 300)}`,
        code: res.status === 429 ? 'rate_limit_exceeded' : undefined,
      }
    }

    const text = await res.text()
    let conversationId = ''
    const matchConv = text.match(/"conversation_id"\s*:\s*"([^"]+)"/)
    if (matchConv) conversationId = matchConv[1]

    let pointers = extractImagePointers(text)
    if (!pointers.length && conversationId) {
      pointers = await pollConversationForPointers(fp, accessToken, accountId, conversationId)
    }

    if (!pointers.length) {
      return {
        ok: false,
        httpStatus: 502,
        error: 'ChatGPT 网页版未返回图片数据（可能由于生图限额或内容审核拦截）',
      }
    }

    const count = Math.max(1, Math.min(4, Number(body.n) || 1))
    const selected = pointers.slice(0, count)
    const data: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> = []

    for (const ptr of selected) {
      const dlUrl = await fetchWebImageDownloadUrl(fp, accessToken, accountId, ptr.pointer, conversationId)
      if (dlUrl) {
        const downloaded = await downloadImageAsBase64(dlUrl, fp, accessToken, accountId)
        if (downloaded) {
          const row: Record<string, any> = { b64_json: downloaded.b64 }
          if (body.response_format === 'url') {
            row.url = `data:${downloaded.mime};base64,${downloaded.b64}`
          }
          data.push(row)
        }
      }
    }

    if (!data.length) {
      return {
        ok: false,
        httpStatus: 502,
        error: 'ChatGPT 网页版图片下载失败',
      }
    }

    return {
      ok: true,
      httpStatus: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        created: Math.floor(Date.now() / 1000),
        data,
      }),
    }
  } catch (err) {
    return {
      ok: false,
      httpStatus: 504,
      error: `ChatGPT 网页版生图超时或异常: ${(err as Error).message}`,
    }
  }
}

/** 用已解析的 ChatGPT access_token 直接生图（Codex 账号也可复用网页协议） */
export async function generateChatgptWebImageWithAccessToken(
  env: Env,
  accessToken: string,
  accountId: string,
  body: Record<string, any>,
  timeoutMs = 110_000,
): Promise<{ ok: boolean; httpStatus: number; body?: string; contentType?: string; error?: string; code?: string }> {
  return generateChatgptWebImageWithToken(env, accessToken, accountId, accessToken, body, timeoutMs)
}

/** 用 refresh_token / 凭据行生图（先刷新成 access_token） */
export async function generateChatgptWebImage(
  env: Env,
  rawToken: string,
  body: Record<string, any>,
  timeoutMs = 110_000,
): Promise<{ ok: boolean; httpStatus: number; body?: string; contentType?: string; error?: string; code?: string }> {
  const tokenInfo = await resolveAccountToken(env, rawToken)
  if (!tokenInfo.token) {
    return { ok: false, httpStatus: 401, error: '未配置可用的 ChatGPT 网页版凭据' }
  }
  return generateChatgptWebImageWithToken(env, tokenInfo.token, tokenInfo.accountId, rawToken, body, timeoutMs)
}
