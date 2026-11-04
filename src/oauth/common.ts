/**
 * OAuth 反代共享工具（claude / codex / kimi / grok 渠道复用）
 *
 * 与 antigravity.ts 相同的模式：
 *  - 渠道 apiKeys 里每行一个 refresh_token（或设备码流程产出的凭据）
 *  - access_token 刷新后缓存在 KV（按 refresh_token 哈希为 key）
 *  - 上游返回 401/403/429/5xx 时轮换下一个凭据重试
 */

import type { Env } from '../types'
import { getKV } from '../storage/blob-store'

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function randomId(): string {
  try { return crypto.randomUUID() } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` }
}

export function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** base64url 编码（PKCE 用） */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 生成 PKCE code_verifier / code_challenge(S256) */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) }
}

export function oauthErrorResponse(message: string, status: number, type = 'oauth_error'): Response {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

export async function readErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
    if (typeof json.error === 'string') return json.error
    return json.error?.message || json.message || text
  } catch { return text }
}

// =====================================================================
// access_token KV 缓存（支持上游轮换 refresh_token 的链式续期）
// =====================================================================

export interface CachedToken {
  accessToken: string
  expiresAt: number
  /** 上游轮换后的最新 refresh_token（apiKeys 里存的旧 token 仍作为入口 key） */
  currentRefreshToken?: string
  /** 附加信息（如 Codex 的 chatgpt_account_id） */
  extra?: Record<string, string>
}

/** 进程内 access_token 缓存：EdgeOne 热实例复用，避免每个请求都读一次 Blob */
const memTokenCache = new Map<string, CachedToken>()
const MEM_TOKEN_CACHE_MAX = 500

export async function getCachedToken(env: Env, prefix: string, refreshToken: string): Promise<CachedToken | null> {
  const cacheKey = prefix + (await sha256Hex(refreshToken))
  const mem = memTokenCache.get(cacheKey)
  if (mem?.accessToken) return mem
  const raw = await getKV(env).get(cacheKey)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as CachedToken
    // 即使 access_token 已过期也要返回：里面存着上游轮换后的 refresh_token，
    // 丢掉它就只能拿 apiKeys 里的旧 token 去刷新，会被上游判定为重放并作废整条会话
    if (parsed.accessToken) {
      if (memTokenCache.size >= MEM_TOKEN_CACHE_MAX) memTokenCache.clear()
      memTokenCache.set(cacheKey, parsed)
      return parsed
    }
  } catch { /* re-refresh */ }
  return null
}

export async function putCachedToken(env: Env, prefix: string, refreshToken: string, value: CachedToken, expiresIn: number): Promise<void> {
  const cacheKey = prefix + (await sha256Hex(refreshToken))
  if (memTokenCache.size >= MEM_TOKEN_CACHE_MAX) memTokenCache.clear()
  memTokenCache.set(cacheKey, value)
  // 存活时间必须长于 access_token，否则轮换后的 refresh_token 会随访问令牌一起过期
  const ttl = Math.min(30 * 24 * 3600, Math.max(expiresIn * 2, 24 * 3600))
  await getKV(env).put(cacheKey, JSON.stringify(value), {
    expirationTtl: ttl,
  }).catch(() => {})
}

/**
 * 统一的 token 刷新入口：先查缓存，未命中/已过期则用「最近一次轮换后的」refresh_token 调
 * refresher，结果写回 KV。refresher 返回 {accessToken, expiresIn, refreshToken?, extra?}。
 */
export async function resolveAccessToken(
  env: Env,
  prefix: string,
  refreshToken: string,
  refresher: (token: string) => Promise<{ accessToken: string; expiresIn: number; refreshToken?: string; extra?: Record<string, string> }>,
): Promise<CachedToken> {
  const cached = await getCachedToken(env, prefix, refreshToken)
  if (cached && (cached.expiresAt || 0) - 300_000 > Date.now()) return cached
  // 续期必须用轮换后的 token：重放 apiKeys 里的入口 token 会触发上游重用检测
  const effective = cached?.currentRefreshToken || refreshToken
  const refreshed = await refresher(effective)
  const value: CachedToken = {
    accessToken: refreshed.accessToken,
    expiresAt: Date.now() + refreshed.expiresIn * 1000,
    currentRefreshToken: refreshed.refreshToken || effective,
    extra: refreshed.extra,
  }
  // 仍以入口 token 为 key，保证 apiKeys 里的原值可继续作为查询入口
  await putCachedToken(env, prefix, refreshToken, value, refreshed.expiresIn)
  return value
}

// =====================================================================
// 多凭据轮换请求 + 用量记录
// =====================================================================

export interface OAuthCallParams {
  env: Env
  providerId: string
  modelId: string
  requestedModel: string
  body: Record<string, any>
  refreshTokens: string[]
  maskedToken: string
  startedAt: number
  waitUntil?: (promise: Promise<unknown>) => void
}

/** 用量由 routes/chat.ts 统一记账，这里保留空实现以兼容上游移植代码 */
export async function recordOAuthUsage(_p: OAuthCallParams, _usage: { promptTokens: number; completionTokens: number }, _ok: boolean, _status: number): Promise<void> {}

export function defer(p: OAuthCallParams, task: Promise<unknown>): void {
  if (p.waitUntil) {
    try { p.waitUntil(task) } catch { task.catch(() => {}) }
  } else {
    task.catch(() => {})
  }
}
