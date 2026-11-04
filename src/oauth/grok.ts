/**
 * Grok (xAI) OAuth 反代 (provider.type = 'grok')
 *
 * 复刻 CLIProxyAPI 的 xAI OAuth + executor：
 *  1. OIDC 发现（auth.x.ai/.well-known/openid-configuration）解析设备码/令牌端点
 *  2. RFC 8628 设备码授权（Grok CLI 公开客户端），轮询换 token
 *  3. 请求发到 Grok CLI chat-proxy（cli-chat-proxy.grok.com/v1/responses，Responses 协议），
 *     带 Grok CLI 身份头（X-XAI-Token-Auth 等）；/v1/responses 原生协议支持透传
 *  4. OpenAI 请求 -> Responses 请求翻译，响应（含 SSE）翻译回 OpenAI
 *
 * 渠道 apiKeys 里每行一个 xAI OAuth refresh_token。
 */

import type { Env } from '../types'
import { getKV } from '../storage/blob-store'
import {
  type OAuthCallParams,
  oauthErrorResponse,
  randomId,
  readErrorBody,
  recordOAuthUsage,
  defer,
  resolveAccessToken,
} from './common'
import { openAIToResponsesRequest, responsesResponseToOpenAI, createOpenAIStreamFromResponses } from '../responses-translate'

// ===== OAuth 客户端（来自 CLIProxyAPI internal/auth/xai） =====
const XAI_DISCOVERY_URL = 'https://auth.x.ai/.well-known/openid-configuration'
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access'
const XAI_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

const XAI_CHAT_PROXY_BASE = 'https://cli-chat-proxy.grok.com/v1'
// Grok CLI 身份头（chat-proxy 校验）
const XAI_UA = 'xai-grok-workspace/0.2.120'
const XAI_CLIENT_VERSION = '0.2.120'

const AT_PREFIX = 'grok:at:'
const DEVICE_PREFIX = 'grok:device:'
const EP_PREFIX = 'grok:endpoints:'

interface XaiEndpoints { deviceAuthorization: string; token: string }

async function discoverEndpoints(env: Env): Promise<XaiEndpoints> {
  const kv = getKV(env)
  const cached = await kv.get(EP_PREFIX + 'v1').catch(() => null)
  if (cached) {
    try { return JSON.parse(cached) as XaiEndpoints } catch { /* refetch */ }
  }
  const res = await fetch(XAI_DISCOVERY_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`xAI OIDC 发现失败 HTTP ${res.status}: ${text.slice(0, 200)}`)
  let json: any
  try { json = JSON.parse(text) } catch { throw new Error('xAI OIDC 发现返回非 JSON') }
  const deviceAuthorization = String(json?.device_authorization_endpoint || '')
  const token = String(json?.token_endpoint || '')
  if (!deviceAuthorization || !token) throw new Error('xAI OIDC 发现缺少端点字段')
  const endpoints = { deviceAuthorization, token }
  await kv.put(EP_PREFIX + 'v1', JSON.stringify(endpoints), { expirationTtl: 86400 }).catch(() => {})
  return endpoints
}

// =====================================================================
// 设备码授权（开始 / 轮询）
// =====================================================================

export interface GrokDeviceFlow {
  state: string
  verificationUri: string
  verificationUriComplete?: string
  userCode: string
  expiresIn: number
  interval: number
}

export async function startGrokDeviceFlow(env: Env): Promise<GrokDeviceFlow> {
  const endpoints = await discoverEndpoints(env)
  const form = new URLSearchParams({ client_id: XAI_CLIENT_ID, scope: XAI_SCOPE })
  const res = await fetch(endpoints.deviceAuthorization, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { throw new Error(`设备码请求返回非 JSON: ${text.slice(0, 200)}`) }
  if (!res.ok || !json.device_code) throw new Error(`设备码请求失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
  const state = randomId()
  await getKV(env).put(DEVICE_PREFIX + state, JSON.stringify({ deviceCode: json.device_code }), {
    expirationTtl: Math.max(300, Number(json.expires_in) || 1800),
  }).catch(() => {})
  return {
    state,
    verificationUri: String(json.verification_uri || 'https://x.ai/device'),
    verificationUriComplete: json.verification_uri_complete ? String(json.verification_uri_complete) : undefined,
    userCode: String(json.user_code || ''),
    expiresIn: Number(json.expires_in) || 1800,
    interval: Number(json.interval) || 5,
  }
}

export interface GrokPollResult {
  status: 'pending' | 'ok' | 'error'
  message?: string
  refreshToken?: string
}

export async function pollGrokDeviceFlow(env: Env, state: string): Promise<GrokPollResult> {
  const raw = await getKV(env).get(DEVICE_PREFIX + state)
  if (!raw) return { status: 'error', message: '设备码会话不存在或已过期，请重新发起授权' }
  const { deviceCode } = JSON.parse(raw) as { deviceCode: string }
  const endpoints = await discoverEndpoints(env)
  const form = new URLSearchParams({
    grant_type: XAI_DEVICE_GRANT,
    device_code: deviceCode,
    client_id: XAI_CLIENT_ID,
  })
  const res = await fetch(endpoints.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { return { status: 'error', message: `轮询返回非 JSON: ${text.slice(0, 200)}` } }
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
    return { status: 'error', message: `xAI OAuth 错误: ${json.error} ${json.error_description || ''}`.trim() }
  }
  if (!json.access_token) return { status: 'error', message: 'xAI 未返回 access_token' }
  if (!json.refresh_token) return { status: 'error', message: 'xAI 未返回 refresh_token，请重新授权' }
  await getKV(env).delete(DEVICE_PREFIX + state).catch(() => {})
  return { status: 'ok', refreshToken: json.refresh_token }
}

// =====================================================================
// access_token 刷新（KV 缓存）
// =====================================================================

async function refreshGrokToken(env: Env, refreshToken: string): Promise<{ accessToken: string; expiresIn: number; refreshToken?: string }> {
  const endpoints = await discoverEndpoints(env)
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: XAI_CLIENT_ID,
    refresh_token: refreshToken,
  })
  const res = await fetch(endpoints.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { throw new Error(`Grok OAuth 刷新返回非 JSON: ${text.slice(0, 200)}`) }
  if (!res.ok || !json.access_token) throw new Error(`Grok OAuth 刷新失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
  return { accessToken: json.access_token, expiresIn: Number(json.expires_in) || 3600, refreshToken: json.refresh_token || undefined }
}

async function getAccessToken(env: Env, refreshToken: string): Promise<string> {
  return (await resolveAccessToken(env, AT_PREFIX, refreshToken, (token) => refreshGrokToken(env, token))).accessToken
}

// =====================================================================
// 上游请求头（Grok CLI 身份）
// =====================================================================

function apiHeaders(accessToken: string, stream: boolean): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'Accept': stream ? 'text/event-stream' : 'application/json',
    'User-Agent': XAI_UA,
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-grok-client-version': XAI_CLIENT_VERSION,
    'x-grok-client-identifier': 'grok-shell',
    'x-authenticateresponse': 'authenticate-response',
    'x-grok-conv-id': randomId(),
  }
}

// =====================================================================
// 对外入口
// =====================================================================

export async function handleGrokRequest(p: OAuthCallParams, subPath: string): Promise<Response> {
  const tokens = (p.refreshTokens || []).filter((t) => t && t.trim())
  if (tokens.length === 0) {
    return oauthErrorResponse('该 grok 渠道未配置凭据：请在「API Key」里每行填入一个 xAI OAuth refresh_token（可通过设备码授权获取）', 400, 'configuration_error')
  }
  const wantStream = p.body?.stream === true

  // 原生 Responses 协议透传（/v1/responses）
  if (subPath === 'responses-passthrough') {
    return forwardResponsesNative(p, tokens[0].trim(), wantStream)
  }

  // 上游只认裸模型 ID(带 providerId/ 前缀会被拒绝)
  const { request } = openAIToResponsesRequest({ ...p.body, model: p.modelId })
  let lastError = ''
  let lastStatus = 502

  for (const refreshToken of tokens) {
    try {
      const accessToken = await getAccessToken(p.env, refreshToken)
      const upstream = await fetch(`${XAI_CHAT_PROXY_BASE}/responses`, {
        method: 'POST',
        headers: apiHeaders(accessToken, wantStream),
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(600000),
      })
      if (!upstream.ok) {
        lastStatus = upstream.status
        lastError = `HTTP ${upstream.status}: ${(await readErrorBody(upstream)).slice(0, 300)}`
        if ([401, 403, 429].includes(upstream.status) || upstream.status >= 500) continue
        return oauthErrorResponse(lastError, upstream.status, 'upstream_error')
      }

      if (wantStream && upstream.body) {
        const stream = createOpenAIStreamFromResponses(upstream.body, p.requestedModel, (usage) => {
          defer(p, recordOAuthUsage(p, usage, true, 200))
        })
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' },
        })
      }

      const rawText = await upstream.text()
      let json: unknown
      try { json = JSON.parse(rawText) } catch { return oauthErrorResponse(`上游返回非 JSON: ${rawText.slice(0, 200)}`, 502, 'upstream_error') }
      const openai = responsesResponseToOpenAI(json, p.requestedModel)
      defer(p, recordOAuthUsage(p, {
        promptTokens: Number((json as any)?.usage?.input_tokens) || 0,
        completionTokens: Number((json as any)?.usage?.output_tokens) || 0,
      }, true, 200))
      return new Response(JSON.stringify(openai), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    } catch (err) {
      lastError = (err as Error).message || '未知错误'
      lastStatus = 502
      continue
    }
  }
  return oauthErrorResponse(`所有 Grok 账号均失败，最后一次错误: ${lastError || '未知'}`, lastStatus, 'key_exhausted')
}

async function forwardResponsesNative(p: OAuthCallParams, refreshToken: string, wantStream: boolean): Promise<Response> {
  try {
    const accessToken = await getAccessToken(p.env, refreshToken)
    const upstream = await fetch(`${XAI_CHAT_PROXY_BASE}/responses`, {
      method: 'POST',
      headers: apiHeaders(accessToken, wantStream),
      body: JSON.stringify(p.body),
      signal: AbortSignal.timeout(600000),
    })
    if (!upstream.ok) {
      return oauthErrorResponse(`HTTP ${upstream.status}: ${(await readErrorBody(upstream)).slice(0, 300)}`, upstream.status, 'upstream_error')
    }
    const headers: Record<string, string> = {
      'Content-Type': upstream.headers.get('Content-Type') || (wantStream ? 'text/event-stream' : 'application/json'),
      'Cache-Control': 'no-store',
    }
    return new Response(upstream.body, { status: 200, headers })
  } catch (err) {
    return oauthErrorResponse((err as Error).message || '透传失败', 502, 'proxy_error')
  }
}

// =====================================================================
// 后台：连通性测试
// =====================================================================

export async function testGrok(env: Env, refreshToken: string, modelId: string): Promise<{ success: boolean; message: string; statusCode?: number }> {
  if (!refreshToken) return { success: false, message: '未填写 refresh_token', statusCode: 0 }
  try {
    const accessToken = await getAccessToken(env, refreshToken)
    const { request } = openAIToResponsesRequest({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 })
    const res = await fetch(`${XAI_CHAT_PROXY_BASE}/responses`, {
      method: 'POST',
      headers: apiHeaders(accessToken, false),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30000),
    })
    if (res.ok) return { success: true, message: '连接成功', statusCode: 200 }
    return { success: false, message: `HTTP ${res.status}: ${(await readErrorBody(res)).slice(0, 200)}`, statusCode: res.status }
  } catch (err) {
    return { success: false, message: (err as Error).message || '连接失败' }
  }
}
