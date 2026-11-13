/**
 * ChatGPT (Codex) OAuth 反代 (provider.type = 'codex')
 *
 * 复刻 CLIProxyAPI 的 Codex OAuth + executor：
 *  1. Codex CLI 客户端 OAuth（PKCE，loopback 回调 http://localhost:1455/auth/callback），
 *     授权/换/刷 token 走 auth.openai.com，form-encoded
 *  2. account_id 从 access_token（JWT）的 chatgpt_account_id claim 解析，
 *     请求头带 Chatgpt-Account-Id + Originator + codex-tui UA
 *  3. OpenAI 请求 -> Responses 请求翻译，发到 chatgpt.com/backend-api/codex/responses，
 *     响应（含 SSE）翻译回 OpenAI；/v1/responses 原生协议同样支持透传
 *
 * 渠道 apiKeys 里每行一个 OpenAI OAuth refresh_token。
 */

import type { Env } from '../types'
import { getKV } from '../storage/blob-store'
import {
  type OAuthCallParams,
  createPkcePair,
  oauthErrorResponse,
  randomHex,
  randomId,
  readErrorBody,
  recordOAuthUsage,
  defer,
  resolveAccessToken,
} from './common'
import { openAIToResponsesRequest, createOpenAIStreamFromResponses, collectResponsesStreamToOpenAI, isImageGenerationRequest } from '../responses-translate'
import { lastUserText } from '../image-intent'

// ===== OAuth 客户端（来自 CLIProxyAPI internal/auth/codex） =====
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_AUTH_URL = 'https://auth.openai.com/oauth/authorize'
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback'
const CODEX_SCOPE = 'openid email profile offline_access'

const CODEX_API_BASE = 'https://chatgpt.com/backend-api/codex'
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_MODELS_URL = CODEX_API_BASE + '/models'
const CODEX_UA = 'codex-tui/0.156.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.156.1)'
const CODEX_ORIGINATOR = 'codex-tui'

const AT_PREFIX = 'codex:at:'
const STATE_PREFIX = 'codex:oauth:'

/**
 * 上游中继配置(存于 kv_store 的 codex:upstream):
 *   {"url": "https://<网关>/v1", "key": "sk_cf_..."}
 * 用于本机出口被 chatgpt.com 拦截的部署(如 Cloudflare Workers)，把 Responses 请求
 * 转交给能直连的出网网关，由对端完成鉴权与转发。留空则直连 chatgpt.com。
 */
const UPSTREAM_RELAY_KEY = 'codex:upstream'

/** 凭据刷新/鉴权失败(区别于网络错误)：需要按 401 语义返回 */
class CodexAuthError extends Error {}

export interface CodexUpstreamRelay {
  /** 对端网关根地址，如 https://api.example.com */
  url: string
  /** 对端网关的转发 Key(Bearer) */
  key: string
}

export async function getCodexUpstreamRelay(env: Env): Promise<CodexUpstreamRelay | null> {
  try {
    const raw = await getKV(env).get(UPSTREAM_RELAY_KEY)
    if (!raw) return null
    const cfg = JSON.parse(raw) as { url?: string; key?: string }
    const url = String(cfg?.url || '').trim().replace(/\/+$/, '')
    const key = String(cfg?.key || '').trim()
    return url && key ? { url, key } : null
  } catch {
    return null
  }
}

/** 中继请求头: 鉴权交给对端网关，本机不参与 OAuth */
function relayHeaders(relay: CodexUpstreamRelay, stream: boolean): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${relay.key}`,
    'Accept': stream ? 'text/event-stream' : 'application/json',
  }
}

/** 中继按 providerId/modelId 路由，故需带上渠道前缀 */
function relayModelId(p: OAuthCallParams): string {
  return `${p.providerId}/${p.modelId}`
}

// =====================================================================
// JWT 解析（取 chatgpt_account_id）
// =====================================================================

function base64UrlDecode(data: string): string {
  const pad = data.length % 4 === 0 ? '' : '='.repeat(4 - (data.length % 4))
  return atob(data.replace(/-/g, '+').replace(/_/g, '/') + pad)
}

function parseJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    return JSON.parse(base64UrlDecode(parts[1])) as Record<string, any>
  } catch { return null }
}

function parseJwtClaim(token: string, claim: string): string {
  const value = parseJwtPayload(token)?.[claim]
  return typeof value === 'string' ? value : ''
}

/** 邮箱：优先根级 email，其次嵌套 https://api.openai.com/profile.email（与 chatgptweb 一致） */
function parseJwtEmail(token: string): string {
  const payload = parseJwtPayload(token)
  if (!payload) return ''
  const profile = payload['https://api.openai.com/profile']
  const nested = profile && typeof profile === 'object' ? profile.email : ''
  if (typeof nested === 'string' && nested.trim()) return nested.trim()
  const root = payload.email
  return typeof root === 'string' ? root.trim() : ''
}

function looksLikeJwt(value: string): boolean {
  return value.split('.').length === 3 && value.startsWith('eyJ')
}

/**
 * 从 API Key 行里提取 Codex refresh_token，兼容：
 *  1. 纯 refresh_token（rt_xxx / rt.1.xxx）
 *  2. 四段发货行：账号----GPT密码----邮箱密码----refreshToken
 *  3. CPA JSON（refresh_token / tokens.refresh_token / source_line）
 */
export function extractCodexRefreshToken(input: string): string {
  const raw = String(input || '').trim()
  if (!raw) return ''

  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as any
      const root = Array.isArray(parsed) ? parsed[0] : parsed
      const candidates = [
        root?.refresh_token, root?.refreshToken, root?.rt, root?.refresh,
        root?.tokens?.refresh_token, root?.tokens?.refreshToken,
        root?.token?.refresh_token,
      ]
      for (const value of candidates) {
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
      if (typeof root?.source_line === 'string') return extractCodexRefreshToken(root.source_line)
      if (root?.source_line && typeof root.source_line === 'object') {
        return extractCodexRefreshToken(JSON.stringify(root.source_line))
      }
    } catch { /* 不是 JSON，继续按字符串解析 */ }
  }

  const parts = raw.split(/\s*----\s*/).map((part) => part.trim()).filter(Boolean)
  if (parts.length > 1) {
    const last = parts[parts.length - 1]
    if (/^rt[._]/i.test(last) || looksLikeJwt(last)) return last
    const rt = raw.match(/\brt[._][^\s"'，,;；]+/i)
    if (rt) return rt[0]
    return last
  }

  const rt = raw.match(/\brt[._][^\s"'，,;；]+/i)
  if (rt) return rt[0]
  return raw
}

// =====================================================================
// 内置 OAuth 授权（PKCE，loopback 回调）
// =====================================================================

/** 生成授权链接。登录后浏览器会跳到 localhost:1455（打不开是正常的），从地址栏复制 code。 */
export async function buildCodexAuthUrl(env: Env): Promise<{ url: string; state: string }> {
  const state = randomHex(16)
  const { verifier, challenge } = await createPkcePair()
  await getKV(env).put(STATE_PREFIX + state, JSON.stringify({ verifier }), { expirationTtl: 600 }).catch(() => {})
  const params = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    response_type: 'code',
    redirect_uri: CODEX_REDIRECT_URI,
    scope: CODEX_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'login',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  })
  return { url: `${CODEX_AUTH_URL}?${params.toString()}`, state }
}

function extractCode(input: string): string {
  const text = (input || '').trim()
  const match = text.match(/[?&]code=([^&\s]+)/)
  return match ? decodeURIComponent(match[1]) : text
}

export async function exchangeCodexCode(env: Env, codeOrUrl: string, state: string): Promise<{ refreshToken: string; accessToken: string; expiresIn: number; accountId: string; email?: string }> {
  const raw = await getKV(env).get(STATE_PREFIX + state)
  if (!raw) throw new Error('授权会话不存在或已过期（10 分钟），请重新点击「授权新账号」')
  await getKV(env).delete(STATE_PREFIX + state).catch(() => {})
  const { verifier } = JSON.parse(raw) as { verifier: string }
  const code = extractCode(codeOrUrl)
  if (!code) throw new Error('未识别到 code，请粘贴 OpenAI 返回的 code 或整段回调地址')
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX_CLIENT_ID,
    code,
    redirect_uri: CODEX_REDIRECT_URI,
    code_verifier: verifier,
  })
  const res = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { throw new Error(`换取 token 返回非 JSON: ${text.slice(0, 200)}`) }
  if (!res.ok || !json.access_token) throw new Error(`换取 token 失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
  if (!json.refresh_token) throw new Error('OpenAI 未返回 refresh_token，请重新授权')
  const accessToken = json.access_token as string
  const accountId = parseJwtClaim(accessToken, 'chatgpt_account_id')
  // 邮箱只用于管理端展示：优先 id_token（通常带嵌套 profile claim），回退 access_token
  const idToken = typeof json.id_token === 'string' ? json.id_token : ''
  const email = parseJwtEmail(idToken) || parseJwtEmail(accessToken)
  return { refreshToken: json.refresh_token, accessToken, expiresIn: Number(json.expires_in) || 3600, accountId, email: email || undefined }
}

// =====================================================================
// access_token 刷新（KV 缓存）
// =====================================================================

async function refreshCodexToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number; refreshToken?: string; extra?: Record<string, string> }> {
  const form = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: CODEX_SCOPE,
  })
  const res = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { throw new CodexAuthError(`Codex OAuth 刷新返回非 JSON: ${text.slice(0, 200)}`) }
  if (!res.ok || !json.access_token) throw new CodexAuthError(`Codex OAuth 刷新失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
  const accountId = parseJwtClaim(json.access_token, 'chatgpt_account_id')
  // 刷新响应可能带 id_token，解析出的邮箱随 extra 缓存，供额度查询回填老账号
  const idToken = typeof json.id_token === 'string' ? json.id_token : ''
  const email = parseJwtEmail(idToken) || parseJwtEmail(json.access_token)
  const extra: Record<string, string> = {}
  if (accountId) extra.accountId = accountId
  if (email) extra.email = email
  return {
    accessToken: json.access_token,
    expiresIn: Number(json.expires_in) || 3600,
    refreshToken: json.refresh_token || undefined,
    extra: Object.keys(extra).length ? extra : undefined,
  }
}

async function getAccessToken(env: Env, refreshToken: string): Promise<{ token: string; accountId: string; email: string }> {
  const cached = await resolveAccessToken(env, AT_PREFIX, refreshToken, refreshCodexToken)
  const accountId = cached.extra?.accountId || ''
  const email = cached.extra?.email || ''
  return { token: cached.accessToken, accountId, email }
}

// =====================================================================
// 上游请求头
// =====================================================================

function apiHeaders(accessToken: string, accountId: string, stream: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'Accept': stream ? 'text/event-stream' : 'application/json',
    'User-Agent': CODEX_UA,
    'Originator': CODEX_ORIGINATOR,
    'Version': '0.156.1',
    'Session_id': randomId(),
  }
  if (accountId) headers['Chatgpt-Account-Id'] = accountId
  return headers
}

// =====================================================================
// 额度与模型目录（只读，不消耗模型额度）
// =====================================================================

export type CodexQuotaWindow = {
  label: string
  usedPercent: number
  remainPercent: number
  windowMinutes?: number
  resetTime?: string
}

export type CodexQuotaResult = {
  ok: boolean
  plan?: string
  email?: string
  windows: CodexQuotaWindow[]
  credits?: { hasCredits: boolean; balance?: number; unlimited?: boolean }
  error?: string
}

/** 窗口长度 → 标签：300→5 小时、1440→日、10080→周、≥25920（18 天）→月；未知长度用中性文案 */
function formatWindowLabel(minutes?: number): string {
  if (!minutes || !Number.isFinite(minutes) || minutes <= 0) return '额度窗口'
  if (minutes >= 25920) return '月窗口'
  if (minutes >= 1440) {
    const days = Math.round(minutes / 1440)
    if (days === 1) return '日窗口'
    return days === 7 ? '周窗口' : `${days} 天窗口`
  }
  return `${Math.max(1, Math.round(minutes / 60))} 小时窗口`
}

function pickQuotaWindow(raw: any): CodexQuotaWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const used = Number(raw.used_percent ?? raw.usedPercent)
  if (!Number.isFinite(used)) return null
  const usedPercent = Math.max(0, Math.min(100, used))
  const minutes = Number(
    raw.window_minutes ??
    raw.windowMinutes ??
    (raw.limit_window_seconds != null ? Math.round(Number(raw.limit_window_seconds) / 60) : NaN)
  )
  let resetTime: string | undefined
  const resetAt = Number(raw.reset_at ?? raw.resetAt)
  if (Number.isFinite(resetAt) && resetAt > 0) {
    resetTime = new Date(resetAt * 1000).toISOString()
  } else {
    const afterSeconds = Number(raw.reset_after_seconds ?? raw.resetAfterSeconds)
    if (Number.isFinite(afterSeconds) && afterSeconds >= 0) {
      resetTime = new Date(Date.now() + afterSeconds * 1000).toISOString()
    }
  }
  const windowMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : undefined
  const win: CodexQuotaWindow = { label: formatWindowLabel(windowMinutes), usedPercent, remainPercent: Math.max(0, 100 - usedPercent) }
  if (windowMinutes) win.windowMinutes = windowMinutes
  if (resetTime) win.resetTime = resetTime
  return win
}

/** 查询 Codex/ChatGPT 账号额度（GET wham/usage），任何失败都降级为 ok:false，不抛异常 */
export async function fetchCodexQuota(env: Env, refreshToken: string): Promise<CodexQuotaResult> {
  try {
    // 存储的 Key 可能是纯 RT，也可能是四段发货行 / CPA JSON，先统一提取
    const parsedRefreshToken = extractCodexRefreshToken(refreshToken)
    if (!parsedRefreshToken) return { ok: false, windows: [], error: '未从凭据中识别到 refresh_token' }
    const { token, accountId, email: cachedEmail } = await getAccessToken(env, parsedRefreshToken)
    if (!token) return { ok: false, windows: [], error: '账号缺少可用的 access_token' }
    const res = await fetch(CODEX_USAGE_URL, {
      headers: apiHeaders(token, accountId, false),
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) {
      return { ok: false, windows: [], error: `额度接口返回 HTTP ${res.status}` }
    }
    const text = await res.text()
    let body: any
    try {
      body = JSON.parse(text)
    } catch {
      // 上游非 JSON 时不把响应体透出，避免泄露 HTML/调试信息
      return { ok: false, windows: [], error: `额度接口返回非 JSON（HTTP ${res.status}）` }
    }
    const rateLimit = body?.rate_limit ?? body?.rateLimit ?? {}
    const windows: CodexQuotaWindow[] = []
    const primary = pickQuotaWindow(rateLimit.primary_window ?? rateLimit.primaryWindow)
    if (primary) windows.push(primary)
    const secondary = pickQuotaWindow(rateLimit.secondary_window ?? rateLimit.secondaryWindow)
    if (secondary) windows.push(secondary)

    const creditsRaw = body?.credits
    let credits: CodexQuotaResult['credits']
    if (creditsRaw && typeof creditsRaw === 'object') {
      const balance = Number(creditsRaw.balance ?? creditsRaw.remaining)
      credits = { hasCredits: Boolean(creditsRaw.has_credits ?? creditsRaw.hasCredits) }
      if (Number.isFinite(balance)) credits.balance = balance
      if (creditsRaw.unlimited != null) credits.unlimited = Boolean(creditsRaw.unlimited)
    }

    return {
      ok: true,
      plan: String(body?.plan_type ?? body?.planType ?? '') || undefined,
      email: parseJwtEmail(token) || cachedEmail || undefined,
      windows,
      credits,
    }
  } catch {
    return { ok: false, windows: [], error: '额度查询失败（凭据刷新或网络异常）' }
  }
}

/** 拉取 Codex 当前可用模型目录（GET backend-api/codex/models），失败返回 ok:false 供调用方回退 */
export async function fetchCodexModels(env: Env, refreshToken: string): Promise<{ ok: boolean; models: string[]; error?: string }> {
  try {
    // 存储的 Key 可能是纯 RT，也可能是四段发货行 / CPA JSON，先统一提取
    const parsedRefreshToken = extractCodexRefreshToken(refreshToken)
    if (!parsedRefreshToken) return { ok: false, models: [], error: '未从凭据中识别到 refresh_token' }
    const { token, accountId } = await getAccessToken(env, parsedRefreshToken)
    if (!token) return { ok: false, models: [], error: '账号缺少可用的 access_token' }
    const res = await fetch(`${CODEX_MODELS_URL}?client_version=0.156.1`, {
      headers: apiHeaders(token, accountId, false),
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return { ok: false, models: [], error: `模型目录接口返回 HTTP ${res.status}` }
    const text = await res.text()
    let body: any
    try {
      body = JSON.parse(text)
    } catch {
      return { ok: false, models: [], error: `模型目录接口返回非 JSON（HTTP ${res.status}）` }
    }
    const rows = Array.isArray(body?.models) ? body.models : []
    const slugs: string[] = rows
      .filter((m: any) => m && typeof m.slug === 'string' && m.slug && m.visibility !== 'hide')
      .map((m: any) => String(m.slug))
    const models = [...new Set<string>(slugs)]
    if (models.length === 0) return { ok: false, models: [], error: '上游未返回可用模型' }
    return { ok: true, models }
  } catch {
    return { ok: false, models: [], error: '模型目录查询失败（凭据刷新或网络异常）' }
  }
}

// =====================================================================
// 账号负载均衡与冷却（与 antigravity 渠道同策略）
// =====================================================================
// 原实现按配置顺序依次尝试账号（顺序故障转移）：流量永远先压第一个账号，
// 把它打到 429 后才轮到下一个，账号被逐个抽干。这里改为：健康账号间随机轮换
// 摊薄用量；配额耗尽(429)/凭据失效(401/403)的账号记入冷却并排到队尾兜底——
// 其余账号全失败时仍会尝试它们，故障转移能力不下降；冷却到期自动回池。
// 冷却状态按 refresh_token 的 sha256 记在 KV，不落明文凭据。

type CodexAccountHealth = { cooldownUntil: number; reason?: string }
type CodexHealthMap = Record<string, CodexAccountHealth>

const CODEX_HEALTH_PREFIX = 'codex:health:'
/** 配额耗尽(429)且上游未给重置时间时的兜底冷却时长（Codex 为 5 小时滚动窗口，到期自动重探） */
const CODEX_COOLDOWN_QUOTA_MS = 30 * 60 * 1000
/** 凭据/权限问题（401/403，如 refresh_token 失效）不会在几分钟内自愈 */
const CODEX_COOLDOWN_AUTH_MS = 60 * 60 * 1000
/** 5xx、网络异常等瞬时故障，短冷却即可 */
const CODEX_COOLDOWN_TRANSIENT_MS = 5 * 60 * 1000
/** 单账号冷却上限，防止上游给了离谱的重置时间 */
const CODEX_COOLDOWN_MAX_MS = 6 * 60 * 60 * 1000

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function readCodexHealth(env: Env, providerId: string): Promise<CodexHealthMap> {
  try {
    const raw = await getKV(env).get(CODEX_HEALTH_PREFIX + providerId)
    return raw ? (JSON.parse(raw) as CodexHealthMap) : {}
  } catch {
    return {}
  }
}

async function writeCodexHealth(env: Env, providerId: string, health: CodexHealthMap): Promise<void> {
  const now = Date.now()
  // 只保留仍在冷却期的账号，避免 KV 膨胀
  const kept: CodexHealthMap = {}
  for (const [k, v] of Object.entries(health)) {
    if (v && v.cooldownUntil > now) kept[k] = v
  }
  try {
    if (Object.keys(kept).length > 0) {
      await getKV(env).put(CODEX_HEALTH_PREFIX + providerId, JSON.stringify(kept))
    } else {
      await getKV(env).delete(CODEX_HEALTH_PREFIX + providerId)
    }
  } catch { /* 冷却状态写失败不影响本次转发 */ }
}

/** 从上游错误文本解析重置倒计时，如 "Resets in 23h52m40s" / "Resets in 15m"。 */
export function parseQuotaResetMs(text: string): number | null {
  const m = /reset[s]?\s+in\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i.exec(text || '')
  if (!m) return null
  const h = Number(m[1] || 0)
  const mi = Number(m[2] || 0)
  const s = Number(m[3] || 0)
  const ms = ((h * 60 + mi) * 60 + s) * 1000
  return ms > 0 ? ms : null
}

/** 按冷却状态重排账号：可用（洗牌）→ 冷却已到期（试用）→ 仍在冷却（队尾兜底）。只改顺序，不减账号。 */
export function orderByCooldown<T extends { hash: string }>(accounts: T[], health: CodexHealthMap): T[] {
  const now = Date.now()
  const healthy: T[] = []
  const probation: T[] = []
  const cooling: T[] = []
  for (const a of accounts) {
    const h = health[a.hash]
    if (!h?.cooldownUntil) healthy.push(a)
    else if (now >= h.cooldownUntil) probation.push(a)
    else cooling.push(a)
  }
  const shuffle = (arr: T[]): void => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = arr[i]
      arr[i] = arr[j]
      arr[j] = tmp
    }
  }
  shuffle(healthy)
  shuffle(probation)
  shuffle(cooling)
  return [...healthy, ...probation, ...cooling]
}

// =====================================================================
// 中继生图：走对端网关的标准 /v1/images/generations，绕开其 Responses
// 翻译层可能丢弃 image_generation 工具的问题
// =====================================================================

export type RelayImageResult = {
  ok: boolean
  status: number
  images?: Array<{ b64?: string; url?: string; revised_prompt?: string }>
  error?: string
}

function imageMimeFromBase64(b64: string): string {
  if (/^iVBORw0KGgo/.test(b64)) return 'image/png'
  if (/^\/9j\//.test(b64)) return 'image/jpeg'
  if (/^UklGR/.test(b64)) return 'image/webp'
  return 'image/png'
}

function relayImageToDataUrl(image: { b64?: string; url?: string }): string {
  if (image.url) return image.url
  const b64 = String(image.b64 || '').replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')
  return `data:${imageMimeFromBase64(b64)};base64,${b64}`
}

function imagesToChatMessages(images: Array<{ b64?: string; url?: string; revised_prompt?: string }>): Array<Record<string, any>> {
  return images.map((image) => ({
    type: 'image_url',
    image_url: { url: relayImageToDataUrl(image) },
  }))
}

/** 调对端网关的 /v1/images/generations（OpenAI 标准图片协议） */
export async function callRelayImageGeneration(
  relay: CodexUpstreamRelay,
  model: string,
  prompt: string,
  body: Record<string, any>,
  timeoutMs = 120_000,
): Promise<RelayImageResult> {
  const payload: Record<string, any> = {
    model,
    prompt,
    n: Math.max(1, Math.min(4, Number(body.n) || 1)),
    response_format: 'b64_json',
  }
  if (body.size) payload.size = body.size
  if (body.quality) payload.quality = body.quality
  try {
    const res = await fetch(`${relay.url}/v1/images/generations`, {
      method: 'POST',
      headers: relayHeaders(relay, false),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    if (!res.ok) {
      return { ok: false, status: res.status, error: `中继生图 HTTP ${res.status}: ${text.slice(0, 300)}` }
    }
    let json: any = null
    try { json = JSON.parse(text) } catch { /* ignore */ }
    const rows = Array.isArray(json?.data) ? json.data : []
    const images = rows.map((row: any) => ({
      b64: typeof row?.b64_json === 'string' ? row.b64_json : typeof row?.b64 === 'string' ? row.b64 : undefined,
      url: typeof row?.url === 'string' ? row.url : undefined,
      revised_prompt: typeof row?.revised_prompt === 'string' ? row.revised_prompt : undefined,
    })).filter((img: any) => img.b64 || img.url)
    if (!images.length) {
      return { ok: false, status: 502, error: '中继生图未返回图片数据' }
    }
    return { ok: true, status: res.status, images }
  } catch (err) {
    return { ok: false, status: 504, error: `中继生图失败: ${(err as Error).message}` }
  }
}

/** 把中继图片结果包装成 OpenAI chat.completion（非流式 / 流式） */
function relayImagesToChatResponse(
  images: Array<{ b64?: string; url?: string; revised_prompt?: string }>,
  requestedModel: string,
  promptTokens: number,
  stream: boolean,
): Response {
  const id = `chatcmpl-codex-img-${randomId()}`
  const created = Math.floor(Date.now() / 1000)
  const chatImages = imagesToChatMessages(images)
  if (!stream) {
    const json = {
      id,
      object: 'chat.completion',
      created,
      model: requestedModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '', images: chatImages },
        finish_reason: 'stop',
        logprobs: null,
      }],
      usage: { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: promptTokens },
    }
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }
  const encoder = new TextEncoder()
  const sse = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (delta: Record<string, any>, finish: string | null = null, usage?: { prompt: number; completion: number }) => {
        const chunk: Record<string, any> = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: requestedModel,
          choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
        }
        if (usage) chunk.usage = { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }
      send({ role: 'assistant', content: '' })
      send({ images: chatImages })
      send({}, 'stop', { prompt: promptTokens, completion: 0 })
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
  return new Response(sse, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' },
  })
}

// =====================================================================
// 对外入口
// =====================================================================

export async function handleCodexRequest(p: OAuthCallParams, subPath: string): Promise<Response> {
  const relay = await getCodexUpstreamRelay(p.env)
  const tokens = [...new Set((p.refreshTokens || []).map(extractCodexRefreshToken).filter(Boolean))]
  // 走中继时凭据由对端网关持有，本渠道无需配置 refresh_token
  if (tokens.length === 0 && !relay) {
    return oauthErrorResponse('该 codex 渠道未配置凭据：请在「API Key」里每行填入一个 OpenAI OAuth refresh_token、四段发货行或 CPA JSON（可点「授权新账号」获取）', 400, 'configuration_error')
  }
  const wantStream = p.body?.stream === true
  // 中继网关可能丢弃 image_generation 工具（Responses 翻译层不支持），导致
  // “Tool choice 'image_generation' not found in 'tools'”。生图请求在本机有凭据时优先直连
  // chatgpt.com；EdgeOne 出口可直连（chatgptweb 渠道已验证），无需依赖中继。
  const isImageMode = isImageGenerationRequest(p.body || {})
  const activeRelay = isImageMode && tokens.length > 0 ? null : relay

  // 中继模式下的生图：优先走对端标准 /v1/images/generations。
  // 对端 Responses 翻译层可能不认识 image_generation 工具，直接走 /v1/responses 会
  // 报 “Tool choice 'image_generation' not found in 'tools' parameter”。
  if (isImageMode && activeRelay) {
    const prompt = lastUserText(p.body?.messages)
    if (prompt) {
      const relayImages = await callRelayImageGeneration(activeRelay, relayModelId(p), prompt, p.body || {})
      if (relayImages.ok && relayImages.images?.length) {
        return relayImagesToChatResponse(
          relayImages.images,
          p.requestedModel,
          Math.max(1, Math.ceil(prompt.length / 4)),
          wantStream,
        )
      }
      // 对端图片接口不可用时直接返回其错误，便于定位（Responses 路径已知会丢生图工具）
      return oauthErrorResponse(relayImages.error || '中继生图失败', relayImages.status || 502, 'upstream_error')
    }
  }

  // 原生 Responses 协议透传（/v1/responses）
  if (subPath === 'responses-passthrough') {
    return forwardResponsesNative(p, tokens[0]?.trim() || '', wantStream, relay)
  }

  // 直连时上游只认裸模型 ID(带 providerId/ 前缀会被 Codex 后端拒绝)；走中继则靠前缀路由
  const { request } = openAIToResponsesRequest({ ...p.body, model: activeRelay ? relayModelId(p) : p.modelId })
  // Codex 后端不接受 max_output_tokens(传了直接 400: Unsupported parameter)
  delete request.max_output_tokens
  // Codex 后端强制 stream=true：客户端要非流式时先取 SSE，再本地聚合
  request.stream = true
  // Codex 后端不接受 gpt-5.4-mini（ChatGPT 账号会报 model not supported），
  // 生图主模型沿用路由模型。部分账号对显式 tool_choice 校验严格，改为 auto 让模型自行调用。
  if (isImageMode && !activeRelay) request.tool_choice = 'auto'
  let lastError = ''
  let lastStatus = 502

  // 走中继时凭据轮换由对端负责，本机只发一次；直连时多账号随机打散 + 冷却排序
  const attempts: Array<{ token: string; index: number; hash: string }> = activeRelay
    ? [{ token: '', index: 0, hash: '' }]
    : await Promise.all(tokens.map(async (raw, i) => ({ token: raw, index: i + 1, hash: await sha256Hex(raw) })))
  const health: CodexHealthMap = activeRelay ? {} : await readCodexHealth(p.env, p.providerId)
  const ordered = activeRelay ? attempts : orderByCooldown(attempts, health)
  let healthChanged = false
  const markFailed = (hash: string, reason: string, cooldownMs: number): void => {
    if (!hash) return
    health[hash] = { cooldownUntil: Date.now() + Math.min(cooldownMs, CODEX_COOLDOWN_MAX_MS), reason }
    healthChanged = true
  }
  const markOk = (hash: string): void => {
    if (hash && health[hash]) {
      delete health[hash]
      healthChanged = true
    }
  }
  const persistHealth = async (): Promise<void> => {
    if (!healthChanged) return
    healthChanged = false
    await writeCodexHealth(p.env, p.providerId, health)
  }
  const coolingCount = ordered.filter((a) => {
    const h = health[a.hash]
    return !!h?.cooldownUntil && Date.now() < h.cooldownUntil
  }).length
  if (coolingCount > 0) {
    console.log(`[codex] ${p.providerId}: ${coolingCount}/${ordered.length} account(s) in cooldown, tried last`)
  }

  for (const { token: refreshToken, index: accountIndex, hash } of ordered) {
    try {
      let endpoint = `${CODEX_API_BASE}/responses`
      let headers: Record<string, string>
      if (activeRelay) {
        endpoint = `${activeRelay.url}/v1/responses`
        headers = relayHeaders(activeRelay, true)
      } else {
        const { token, accountId } = await getAccessToken(p.env, refreshToken)
        headers = {
          ...apiHeaders(token, accountId, true),
          ...(isImageMode ? { 'OpenAI-Beta': 'responses=experimental' } : {}),
        }
      }
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(600000),
      })
      if (!upstream.ok) {
        lastStatus = upstream.status
        const toolTypes = Array.isArray(request.tools) ? request.tools.map((t: any) => t?.type).join(',') : 'none'
        lastError = `[codex ${activeRelay ? 'relay' : 'direct'} tokens=${tokens.length} img=${isImageMode ? 1 : 0} model=${request.model} tools=${toolTypes} tc=${typeof request.tool_choice === 'object' ? request.tool_choice?.type : request.tool_choice}] HTTP ${upstream.status}: ${(await readErrorBody(upstream)).slice(0, 300)}`
        if (upstream.status === 429) {
          // 配额耗尽按账号冷却：优先取上游重置时间（Retry-After 头或文本里的 Resets in），别让后续请求白撞
          const retryAfter = Number(upstream.headers.get('retry-after'))
          const reset = (retryAfter > 0 ? retryAfter * 1000 : 0) || parseQuotaResetMs(lastError) || 0
          markFailed(hash, `429 ${lastError.slice(0, 120)}`, reset > 0 ? reset + 60_000 : CODEX_COOLDOWN_QUOTA_MS)
          continue
        }
        if (upstream.status === 401 || upstream.status === 403) {
          markFailed(hash, lastError.slice(0, 120), CODEX_COOLDOWN_AUTH_MS)
          continue
        }
        if (upstream.status >= 500) {
          markFailed(hash, lastError.slice(0, 120), CODEX_COOLDOWN_TRANSIENT_MS)
          continue
        }
        await persistHealth()
        return oauthErrorResponse(lastError, upstream.status, 'upstream_error')
      }

      markOk(hash)
      defer(p, persistHealth())
      const extraHeaders: Record<string, string> = activeRelay ? {} : { 'x-codex-account': String(accountIndex), 'x-codex-cooldown': String(coolingCount) }

      if (wantStream && upstream.body) {
        const stream = createOpenAIStreamFromResponses(upstream.body, p.requestedModel, (usage) => {
          defer(p, recordOAuthUsage(p, usage, true, 200))
        })
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...extraHeaders },
        })
      }

      // 非流式：上游给的是 SSE，本地聚合成 OpenAI JSON
      if (!upstream.body) return oauthErrorResponse('上游未返回响应体', 502, 'upstream_error')
      let openai: Record<string, any>
      try {
        openai = await collectResponsesStreamToOpenAI(upstream.body, p.requestedModel)
      } catch (err) {
        return oauthErrorResponse((err as Error).message || '上游流解析失败', 502, 'upstream_error')
      }
      defer(p, recordOAuthUsage(p, {
        promptTokens: Number(openai.usage?.prompt_tokens) || 0,
        completionTokens: Number(openai.usage?.completion_tokens) || 0,
      }, true, 200))
      return new Response(JSON.stringify(openai), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
      })
    } catch (err) {
      lastError = (err as Error).message || '未知错误'
      // 凭据失效按 401 返回：Cloudflare 边缘会吞掉 5xx 的响应体，用 4xx 才能把原因透给调用方
      lastStatus = err instanceof CodexAuthError ? 401 : 502
      markFailed(hash, `exception ${lastError.slice(0, 120)}`, err instanceof CodexAuthError ? CODEX_COOLDOWN_AUTH_MS : CODEX_COOLDOWN_TRANSIENT_MS)
      continue
    }
  }
  await persistHealth()
  return oauthErrorResponse(`所有 Codex 账号均失败，最后一次错误: ${lastError || '未知'}`, lastStatus, lastStatus === 401 ? 'authentication_error' : 'key_exhausted')
}

/** /v1/responses 原生协议透传：请求体已是 Responses 格式，仅替换鉴权头并强制 store=false */
async function forwardResponsesNative(p: OAuthCallParams, refreshToken: string, wantStream: boolean, relay: CodexUpstreamRelay | null): Promise<Response> {
  try {
    const body = { ...(p.body as Record<string, any>) }
    if (body.store === undefined) body.store = false
    let endpoint = `${CODEX_API_BASE}/responses`
    let headers: Record<string, string>
    if (relay) {
      endpoint = `${relay.url}/v1/responses`
      headers = relayHeaders(relay, wantStream)
      body.model = relayModelId(p)
    } else {
      const { token, accountId } = await getAccessToken(p.env, refreshToken)
      headers = apiHeaders(token, accountId, wantStream)
    }
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600000),
    })
    if (!upstream.ok) {
      return oauthErrorResponse(`HTTP ${upstream.status}: ${(await readErrorBody(upstream)).slice(0, 300)}`, upstream.status, 'upstream_error')
    }
    const responseHeaders: Record<string, string> = {
      'Content-Type': upstream.headers.get('Content-Type') || (wantStream ? 'text/event-stream' : 'application/json'),
      'Cache-Control': 'no-store',
    }
    return new Response(upstream.body, { status: 200, headers: responseHeaders })
  } catch (err) {
    // 凭据失效按 401 返回，避免 Cloudflare 边缘吞掉 5xx 响应体
    const authFailed = err instanceof CodexAuthError
    return oauthErrorResponse((err as Error).message || '透传失败', authFailed ? 401 : 502, authFailed ? 'authentication_error' : 'proxy_error')
  }
}

// =====================================================================
// 后台：连通性测试
// =====================================================================

export async function testCodex(env: Env, refreshToken: string, modelId: string, providerId?: string): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const relay = await getCodexUpstreamRelay(env)
  // 走中继时本渠道不需要 refresh_token，凭据在中继侧
  if (relay) {
    if (!providerId) return { success: false, message: '未确定渠道 ID，无法经中继测试', statusCode: 0 }
    try {
      const res = await fetch(`${relay.url}/v1/responses`, {
        method: 'POST',
        headers: relayHeaders(relay, true),
        body: JSON.stringify({
          model: `${providerId}/${modelId}`,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
          instructions: '',
          store: false,
          stream: true,
        }),
        signal: AbortSignal.timeout(30000),
      })
      if (res.ok) return { success: true, message: '连接成功（经中继）', statusCode: 200 }
      return { success: false, message: `HTTP ${res.status}: ${(await readErrorBody(res)).slice(0, 200)}`, statusCode: res.status }
    } catch (err) {
      return { success: false, message: (err as Error).message || '中继连接失败' }
    }
  }

  if (!refreshToken) return { success: false, message: '未填写 refresh_token', statusCode: 0 }
  const parsedRefreshToken = extractCodexRefreshToken(refreshToken)
  if (!parsedRefreshToken) return { success: false, message: '未从输入中识别到 refresh_token', statusCode: 0 }
  try {
    const { token, accountId } = await getAccessToken(env, parsedRefreshToken)
    const { request } = openAIToResponsesRequest({ model: modelId, messages: [{ role: 'user', content: 'hi' }], stream: true })
    request.stream = true
    let res = await fetch(`${CODEX_API_BASE}/responses`, {
      method: 'POST',
      headers: apiHeaders(token, accountId, true),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) {
      const altRequest = { ...request }
      delete altRequest.stream
      const altRes = await fetch(`${CODEX_API_BASE}/responses`, {
        method: 'POST',
        headers: apiHeaders(token, accountId, false),
        body: JSON.stringify(altRequest),
        signal: AbortSignal.timeout(30000),
      }).catch(() => null)
      if (altRes && altRes.ok) res = altRes
    }
    if (res.ok) return { success: true, message: '连接成功', statusCode: 200 }
    return { success: false, message: `HTTP ${res.status}: ${(await readErrorBody(res)).slice(0, 200)}`, statusCode: res.status }
  } catch (err) {
    return { success: false, message: (err as Error).message || '连接失败' }
  }
}

// =====================================================================
// /v1/images/generations 生图接口支持
// =====================================================================

export async function generateCodexImage(
  env: Env,
  refreshToken: string,
  body: Record<string, any>,
  timeoutMs = 120_000
): Promise<{ ok: boolean; httpStatus: number; body?: string; contentType?: string; error?: string; code?: string }> {
  const prompt = String(body.prompt ?? body.input ?? '').trim()
  if (!prompt) {
    return { ok: false, httpStatus: 400, error: '缺少 prompt 参数' }
  }

  const relay = await getCodexUpstreamRelay(env)
  const parsedRefreshToken = extractCodexRefreshToken(refreshToken)
  if (!parsedRefreshToken && !relay) {
    return { ok: false, httpStatus: 401, error: '未配置可用的 Codex refresh_token' }
  }

  const requestedModel = String(body.model || '')
  const isImageModel = /gpt-image|dall-e|^image-/i.test(requestedModel)
  const imageModel = isImageModel ? requestedModel : 'gpt-image-2'
  // 主模型必须是能调用 image_generation 工具的文本模型：
  // 路由配置的是 gpt-6-luna / gpt-5.5 等文本模型时直接复用，生图模型名则回退默认文本模型。
  const mainModel = requestedModel && !isImageModel ? requestedModel : 'gpt-5.4-mini'
  const tool: Record<string, any> = {
    type: 'image_generation',
    action: 'generate',
    model: imageModel,
  }
  if (body.size) tool.size = String(body.size)
  if (body.quality) tool.quality = String(body.quality)

  const request = {
    model: mainModel,
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: prompt }],
    }],
    stream: true,
    store: false,
    parallel_tool_calls: true,
    tool_choice: { type: 'image_generation' },
    tools: [tool],
    instructions: '',
  }

  let endpoint = `${CODEX_API_BASE}/responses`
  let headers: Record<string, string>
  if (relay) {
    // 中继生图优先走标准图片接口；对端 Responses 翻译层可能丢弃 image_generation 工具
    const relayModel = body.providerId
      ? `${body.providerId}/${requestedModel || mainModel}`
      : (requestedModel || mainModel)
    const relayImages = await callRelayImageGeneration(relay, relayModel, prompt, body, timeoutMs)
    if (relayImages.ok && relayImages.images?.length) {
      const data = relayImages.images.map((image) => ({
        ...(image.b64 ? { b64_json: image.b64 } : {}),
        ...(image.url ? { url: image.url } : {}),
        ...(image.revised_prompt ? { revised_prompt: image.revised_prompt } : {}),
      }))
      return {
        ok: true,
        httpStatus: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ created: Math.floor(Date.now() / 1000), data }),
      }
    }
    if (relayImages.status !== 400 && relayImages.status !== 404 && relayImages.status !== 405) {
      return { ok: false, httpStatus: relayImages.status || 502, error: relayImages.error || '中继生图失败' }
    }
    endpoint = `${relay.url}/v1/responses`
    headers = relayHeaders(relay, true)
    request.model = body.providerId ? `${body.providerId}/${request.model}` : request.model
  } else {
    try {
      const { token, accountId } = await getAccessToken(env, parsedRefreshToken)
      headers = {
        ...apiHeaders(token, accountId, true),
        'OpenAI-Beta': 'responses=experimental',
      }
    } catch (err) {
      return { ok: false, httpStatus: 401, error: `Codex Token 刷新失败: ${(err as Error).message}` }
    }
  }

  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!upstream.ok) {
      const errText = await readErrorBody(upstream)
      return {
        ok: false,
        httpStatus: upstream.status,
        error: `Codex 生图失败 HTTP ${upstream.status}: ${errText.slice(0, 300)}`,
        code: upstream.status === 429 ? 'rate_limit_exceeded' : undefined,
      }
    }

    const text = await upstream.text()
    const images: Array<{ b64: string; revised_prompt?: string }> = []

    const consumeItem = (item: any) => {
      if (!item || typeof item !== 'object') return
      if (item.type === 'image_generation_call') {
        const b64 = String(item.result || item.b64_json || item.image_base64 || '').trim()
        if (b64) {
          images.push({
            b64,
            revised_prompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
          })
        }
      }
    }

    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const dataStr = trimmed.slice(5).trim()
      if (!dataStr || dataStr === '[DONE]') continue
      try {
        const payload = JSON.parse(dataStr)
        if (payload?.item) consumeItem(payload.item)
        if (Array.isArray(payload?.response?.output)) {
          for (const it of payload.response.output) consumeItem(it)
        }
      } catch {}
    }

    // 兜底直接解析整个 JSON（若上游非流式返回）
    if (!images.length) {
      try {
        const whole = JSON.parse(text)
        if (Array.isArray(whole?.output)) {
          for (const it of whole.output) consumeItem(it)
        }
      } catch {}
    }

    if (!images.length) {
      return {
        ok: false,
        httpStatus: 502,
        error: 'Codex 上游未返回图片数据（可能被审核拦截或模型拒答）',
      }
    }

    const count = Math.max(1, Math.min(4, Number(body.n) || 1))
    const selected = images.slice(0, count)
    const formattedData = selected.map((item) => {
      const cleanB64 = item.b64.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').trim()
      const mime = cleanB64.startsWith('iVBORw0KGgo') ? 'image/png' : (cleanB64.startsWith('/9j/') ? 'image/jpeg' : 'image/png')
      const row: Record<string, any> = {
        b64_json: cleanB64,
      }
      if (body.response_format === 'url') {
        row.url = `data:${mime};base64,${cleanB64}`
      }
      if (item.revised_prompt) {
        row.revised_prompt = item.revised_prompt
      }
      return row
    })

    return {
      ok: true,
      httpStatus: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        created: Math.floor(Date.now() / 1000),
        data: formattedData,
      }),
    }
  } catch (err) {
    return {
      ok: false,
      httpStatus: 504,
      error: `Codex 生图请求超时或网络异常: ${(err as Error).message}`,
    }
  }
}
