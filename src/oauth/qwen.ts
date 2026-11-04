/**
 * Qwen (通义千问) OAuth 反代 (provider.type = 'qwen')
 *
 * 复刻 CLIProxyAPI v6 的 Qwen 实现（internal/auth/qwen + qwen_executor）与 Qwen Code CLI：
 *  1. 设备码授权（RFC 8628）+ PKCE(S256)：client_id f0304373b74a44d2b584a3fb70ca9e56，
 *     端点在 chat.qwen.ai/api/v1/oauth2/{device/code,token}，scope: openid profile email model.completion
 *  2. 上游为 OpenAI 兼容接口，基址取自 token 响应的 resource_url（默认 portal.qwen.ai/v1），
 *     路径 /chat/completions，Bearer access_token 直连
 *  3. 上游不提供 /v1/models，模型列表在网关本地维护
 *
 * 渠道 apiKeys 里每行一个 Qwen OAuth refresh_token。
 */

import type { Env } from '../types'
import { getKV } from '../storage/blob-store'
import {
  type OAuthCallParams,
  createPkcePair,
  oauthErrorResponse,
  randomId,
  readErrorBody,
  recordOAuthUsage,
  defer,
  resolveAccessToken,
} from './common'

const QWEN_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56'
const QWEN_DEVICE_URL = 'https://chat.qwen.ai/api/v1/oauth2/device/code'
const QWEN_TOKEN_URL = 'https://chat.qwen.ai/api/v1/oauth2/token'
const QWEN_SCOPE = 'openid profile email model.completion'
const QWEN_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
// OAuth 层上游基址（token 响应里的 resource_url 若存在则覆盖）
const QWEN_DEFAULT_BASE = 'https://portal.qwen.ai/v1'
// 上游不提供 /v1/models，本地维护可用模型
export const QWEN_DEFAULT_MODELS = ['coder-model', 'qwen3-coder-plus', 'qwen3-coder-flash', 'vision-model']

// 阿里云 WAF 会拦截没有 User-Agent 的请求，OAuth 端点也必须带 UA
const QWEN_UA = 'QwenCode/0.9.1 (darwin; arm64)'
const AT_PREFIX = 'qwen:at:'
const DEVICE_PREFIX = 'qwen:device:'

function qwenApiHeaders(accessToken: string, stream: boolean): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'Accept': stream ? 'text/event-stream' : 'application/json',
    'User-Agent': QWEN_UA,
    'X-DashScope-AuthType': 'qwen-oauth',
    'X-DashScope-CacheControl': 'enable',
    'X-DashScope-UserAgent': QWEN_UA,
  }
}

/** 归一化 resource_url -> API 基址（补 https:// 与 /v1） */
function normalizeResourceBase(resourceUrl?: string): string {
  const raw = (resourceUrl || '').trim()
  if (!raw) return QWEN_DEFAULT_BASE
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return withScheme.replace(/\/$/, '').endsWith('/v1') ? withScheme.replace(/\/$/, '') : `${withScheme.replace(/\/$/, '')}/v1`
}

// =====================================================================
// 设备码授权（开始 / 轮询）
// =====================================================================

export interface QwenDeviceFlow {
  state: string
  verificationUri: string
  verificationUriComplete?: string
  userCode: string
  expiresIn: number
  interval: number
}

export async function startQwenDeviceFlow(env: Env): Promise<QwenDeviceFlow> {
  const state = randomId()
  const { verifier, challenge } = await createPkcePair()
  const form = new URLSearchParams({
    client_id: QWEN_CLIENT_ID,
    scope: QWEN_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  const res = await fetch(QWEN_DEVICE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': QWEN_UA },
    body: form.toString(),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { throw new Error(`Qwen 设备码返回非 JSON: ${text.slice(0, 200)}`) }
  if (!res.ok || !json.device_code) throw new Error(`Qwen 设备码请求失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
  await getKV(env).put(DEVICE_PREFIX + state, JSON.stringify({ deviceCode: json.device_code, verifier }), {
    expirationTtl: Math.max(300, Number(json.expires_in) || 900),
  }).catch(() => {})
  return {
    state,
    verificationUri: String(json.verification_uri || 'https://chat.qwen.ai/authorize'),
    verificationUriComplete: json.verification_uri_complete ? String(json.verification_uri_complete) : undefined,
    userCode: String(json.user_code || ''),
    expiresIn: Number(json.expires_in) || 900,
    // Qwen 设备码响应不含 interval，官方客户端按 2s 轮询
    interval: Number(json.interval) || 2,
  }
}

export interface QwenPollResult {
  status: 'pending' | 'ok' | 'error'
  message?: string
  refreshToken?: string
}

export async function pollQwenDeviceFlow(env: Env, state: string): Promise<QwenPollResult> {
  const raw = await getKV(env).get(DEVICE_PREFIX + state)
  if (!raw) return { status: 'error', message: '设备码会话不存在或已过期，请重新发起授权' }
  const { deviceCode, verifier } = JSON.parse(raw) as { deviceCode: string; verifier: string }
  const form = new URLSearchParams({
    grant_type: QWEN_DEVICE_GRANT,
    client_id: QWEN_CLIENT_ID,
    device_code: deviceCode,
    code_verifier: verifier,
  })
  const res = await fetch(QWEN_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': QWEN_UA },
    body: form.toString(),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch {
    return { status: 'error', message: `Qwen 授权服务不可用：token 端点返回 HTTP ${res.status} 非 JSON（官方免费 OAuth 可能已停止，社区反馈 2026 年免费额度已下线）。如仍需要 Qwen，请改用「OpenAI 兼容」渠道 + DashScope API Key。` }
  }
  if (json.error) {
    if (json.error === 'authorization_pending' || json.error === 'slow_down') return { status: 'pending' }
    if (json.error === 'expired_token') {
      await getKV(env).delete(DEVICE_PREFIX + state).catch(() => {})
      return { status: 'error', message: '设备码已过期，请重新发起授权' }
    }
    if (json.error === 'access_denied') {
      await getKV(env).delete(DEVICE_PREFIX + state).catch(() => {})
      return { status: 'error', message: '用户拒绝了授权' }
    }
    return { status: 'error', message: `Qwen OAuth 错误: ${json.error} ${json.error_description || ''}`.trim() }
  }
  if (!json.access_token) return { status: 'error', message: 'Qwen 未返回 access_token' }
  if (!json.refresh_token) return { status: 'error', message: 'Qwen 未返回 refresh_token，请重新授权' }
  await getKV(env).delete(DEVICE_PREFIX + state).catch(() => {})
  return { status: 'ok', refreshToken: json.refresh_token }
}

// =====================================================================
// access_token 刷新（KV 缓存，resource_url 一并缓存）
// =====================================================================

async function refreshQwenToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number; refreshToken?: string; extra?: Record<string, string> }> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: QWEN_CLIENT_ID,
  })
  const res = await fetch(QWEN_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': QWEN_UA },
    body: form.toString(),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch {
    throw new Error(`Qwen 授权服务不可用：token 端点返回 HTTP ${res.status} 非 JSON（官方免费 OAuth 可能已停止）。如仍需要 Qwen，请改用「OpenAI 兼容」渠道 + DashScope API Key。`)
  }
  if (res.status === 400 || res.status === 401) throw new Error(`Qwen refresh_token 已失效 (HTTP ${res.status})，请重新授权`)
  if (!res.ok || !json.access_token) throw new Error(`Qwen OAuth 刷新失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
  return {
    accessToken: json.access_token,
    expiresIn: Number(json.expires_in) || 3600,
    refreshToken: json.refresh_token || undefined,
    extra: json.resource_url ? { resourceUrl: String(json.resource_url) } : undefined,
  }
}

async function getAccessTokenWithBase(env: Env, refreshToken: string): Promise<{ token: string; base: string }> {
  const cached = await resolveAccessToken(env, AT_PREFIX, refreshToken, refreshQwenToken)
  const base = normalizeResourceBase(cached.extra?.resourceUrl)
  return { token: cached.accessToken, base }
}

// =====================================================================
// 对外入口（OpenAI 兼容直通）
// =====================================================================

export async function handleQwenRequest(p: OAuthCallParams): Promise<Response> {
  const tokens = (p.refreshTokens || []).filter((t) => t && t.trim())
  if (tokens.length === 0) {
    return oauthErrorResponse('该 qwen 渠道未配置凭据：请在「API Key」里每行填入一个 Qwen OAuth refresh_token（可点「授权登录」用设备码获取）', 400, 'configuration_error')
  }
  const wantStream = p.body?.stream === true
  let lastError = ''
  let lastStatus = 502

  for (const refreshToken of tokens) {
    try {
      const { token, base } = await getAccessTokenWithBase(p.env, refreshToken)
      const upstream = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: qwenApiHeaders(token, wantStream),
        // 上游只认裸模型 ID(带 providerId/ 前缀会被拒绝)
        body: JSON.stringify({ ...p.body, model: p.modelId }),
        signal: AbortSignal.timeout(600000),
      })
      if (!upstream.ok) {
        lastStatus = upstream.status
        lastError = `HTTP ${upstream.status}: ${(await readErrorBody(upstream)).slice(0, 300)}`
        if ([401, 403, 429].includes(upstream.status) || upstream.status >= 500) continue
        return oauthErrorResponse(lastError, upstream.status, 'upstream_error')
      }
      // OpenAI 兼容：透传响应；流式用 tee 在后台提取 usage
      if (wantStream && upstream.body) {
        const [toClient, forUsage] = upstream.body.tee()
        defer(p, scanOpenAiStreamUsage(forUsage, (usage) => recordOAuthUsage(p, usage, true, 200)))
        return new Response(toClient, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' },
        })
      }
      const rawText = await upstream.text()
      let json: any
      try { json = JSON.parse(rawText) } catch { return oauthErrorResponse(`上游返回非 JSON: ${rawText.slice(0, 200)}`, 502, 'upstream_error') }
      defer(p, recordOAuthUsage(p, {
        promptTokens: Number(json?.usage?.prompt_tokens) || 0,
        completionTokens: Number(json?.usage?.completion_tokens) || 0,
      }, true, 200))
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    } catch (err) {
      lastError = (err as Error).message || '未知错误'
      lastStatus = 502
      continue
    }
  }
  return oauthErrorResponse(`所有 Qwen 账号均失败，最后一次错误: ${lastError || '未知'}`, lastStatus, 'key_exhausted')
}

/** 后台扫描 OpenAI SSE 流，提取最后出现的 usage（不阻塞响应） */
async function scanOpenAiStreamUsage(stream: ReadableStream<Uint8Array>, onUsage: (u: { promptTokens: number; completionTokens: number }) => Promise<void>): Promise<void> {
  try {
    const text = await new Response(stream).text()
    let usage = { promptTokens: 0, completionTokens: 0 }
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload)
        if (json?.usage) {
          usage = { promptTokens: Number(json.usage.prompt_tokens) || 0, completionTokens: Number(json.usage.completion_tokens) || 0 }
        }
      } catch { /* ignore */ }
    }
    await onUsage(usage)
  } catch { /* ignore */ }
}

// =====================================================================
// 后台：连通性测试 / 可用模型（本地清单）
// =====================================================================

export async function testQwen(env: Env, refreshToken: string, modelId: string): Promise<{ success: boolean; message: string; statusCode?: number }> {
  if (!refreshToken) return { success: false, message: '未填写 refresh_token', statusCode: 0 }
  try {
    const { token, base } = await getAccessTokenWithBase(env, refreshToken)
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: qwenApiHeaders(token, false),
      body: JSON.stringify({ model: modelId || 'coder-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(30000),
    })
    if (res.ok) return { success: true, message: `连接成功（${base}）`, statusCode: 200 }
    return { success: false, message: `HTTP ${res.status}: ${(await readErrorBody(res)).slice(0, 200)}`, statusCode: res.status }
  } catch (err) {
    return { success: false, message: (err as Error).message || '连接失败' }
  }
}

/** 上游不提供 /v1/models，返回本地维护的模型清单 */
export function fetchQwenModels(): { success: boolean; models: string[]; message?: string } {
  return { success: true, models: [...QWEN_DEFAULT_MODELS] }
}
