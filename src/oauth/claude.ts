/**
 * Claude OAuth 反代 (provider.type = 'claude')
 *
 * 复刻 CLIProxyAPI 的 Claude OAuth + executor：
 *  1. Claude Code 客户端 OAuth（PKCE，loopback 回调 http://localhost:54545/callback）
 *     授权端点 claude.ai/oauth/authorize，换/刷 token 走 platform.claude.com/v1/oauth/token
 *  2. 请求发到 api.anthropic.com/v1/messages（Anthropic Messages 协议），
 *     头像原生 Claude Code：anthropic-beta: claude-code-20250219,oauth-2025-04-20 + claude-cli UA
 *  3. OpenAI 请求 -> Anthropic 请求翻译，响应（含 SSE）翻译回 OpenAI
 *  4. 原生 Anthropic 协议的 /v1/messages 直接透传（仅替换鉴权头），方便 Claude Code 客户端直连
 *
 * 渠道 apiKeys 里每行一个 Anthropic OAuth refresh_token。
 */

import type { Env } from '../types'
import { getKV } from '../storage/blob-store'
import {
  type OAuthCallParams,
  createPkcePair,
  oauthErrorResponse,
  randomHex,
  readErrorBody,
  recordOAuthUsage,
  defer,
  resolveAccessToken,
} from './common'
import { openAIToAnthropicRequest, anthropicResponseToOpenAI, createOpenAIStreamFromAnthropic } from '../anthropic-translate'

// ===== OAuth 客户端（来自 CLIProxyAPI internal/auth/claude） =====
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_AUTH_URL = 'https://claude.ai/oauth/authorize'
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLAUDE_REDIRECT_URI = 'http://localhost:54545/callback'
const CLAUDE_SCOPE = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'
// 原生客户端的 OAuth 控制面请求都带 axios UA；API 请求带 claude-cli UA
const OAUTH_UA = 'axios/1.15.2'
const CLAUDE_CLI_UA = 'claude-cli/2.1.258 (external, cli)'

const CLAUDE_API_BASE = 'https://api.anthropic.com'
const CLAUDE_BETAS = 'claude-code-20250219,oauth-2025-04-20'

const AT_PREFIX = 'claude:at:'
const STATE_PREFIX = 'claude:oauth:'

interface ClaudeTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string | { message?: string }
}

function oauthHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': OAUTH_UA,
  }
}

// =====================================================================
// 内置 OAuth 授权（PKCE，loopback 回调）
// =====================================================================

/** 生成授权链接。登录后浏览器会跳到 localhost:54545（打不开是正常的），从地址栏复制 code。 */
export async function buildClaudeAuthUrl(env: Env): Promise<{ url: string; state: string }> {
  const state = randomHex(16)
  const { verifier, challenge } = await createPkcePair()
  await getKV(env).put(STATE_PREFIX + state, JSON.stringify({ verifier }), { expirationTtl: 600 }).catch(() => {})
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: CLAUDE_REDIRECT_URI,
    scope: CLAUDE_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })
  return { url: `${CLAUDE_AUTH_URL}?${params.toString()}`, state }
}

/** 从用户粘贴的内容里取 code：接受纯 code（可带 #state 片段）或整段回调 URL */
function extractCodeAndState(input: string): { code: string; state?: string } {
  const text = (input || '').trim()
  const urlMatch = text.match(/[?&]code=([^&\s]+)/)
  let raw = urlMatch ? decodeURIComponent(urlMatch[1]) : text
  let state: string | undefined
  const hashIndex = raw.indexOf('#')
  if (hashIndex !== -1) {
    state = raw.slice(hashIndex + 1)
    raw = raw.slice(0, hashIndex)
  }
  return { code: raw, state }
}

export async function exchangeClaudeCode(env: Env, codeOrUrl: string, state: string): Promise<{ refreshToken: string; accessToken: string; expiresIn: number }> {
  const raw = await getKV(env).get(STATE_PREFIX + state)
  if (!raw) throw new Error('授权会话不存在或已过期（10 分钟），请重新点击「用 Claude 账号授权」')
  await getKV(env).delete(STATE_PREFIX + state).catch(() => {})
  const { verifier } = JSON.parse(raw) as { verifier: string }
  const { code, state: codeState } = extractCodeAndState(codeOrUrl)
  if (!code) throw new Error('未识别到 code，请粘贴 Claude 返回的 code 或整段回调地址')
  // 与原生 Claude Code 相同的 JSON 字段顺序
  const body = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: CLAUDE_REDIRECT_URI,
    client_id: CLAUDE_CLIENT_ID,
    code_verifier: verifier,
    state: codeState || state,
  }
  const res = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: oauthHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json: ClaudeTokenResponse
  try { json = JSON.parse(text) } catch { throw new Error(`换取 token 返回非 JSON: ${text.slice(0, 200)}`) }
  if (!res.ok || !json.access_token) {
    const msg = typeof json.error === 'object' ? json.error?.message : (json.error || text)
    throw new Error(`换取 token 失败 HTTP ${res.status}: ${String(msg).slice(0, 300)}`)
  }
  if (!json.refresh_token) throw new Error('Claude 未返回 refresh_token，请重新授权')
  return { refreshToken: json.refresh_token, accessToken: json.access_token, expiresIn: Number(json.expires_in) || 3600 }
}

// =====================================================================
// access_token 刷新（KV 缓存）
// =====================================================================

async function refreshClaudeToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number; refreshToken?: string }> {
  const res = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: oauthHeaders(),
    body: JSON.stringify({
      client_id: CLAUDE_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: CLAUDE_SCOPE,
    }),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json: ClaudeTokenResponse
  try { json = JSON.parse(text) } catch { throw new Error(`Claude OAuth 刷新返回非 JSON: ${text.slice(0, 200)}`) }
  if (!res.ok || !json.access_token) {
    const msg = typeof json.error === 'object' ? json.error?.message : (json.error || text)
    throw new Error(`Claude OAuth 刷新失败 HTTP ${res.status}: ${String(msg).slice(0, 300)}`)
  }
  return { accessToken: json.access_token, expiresIn: Number(json.expires_in) || 3600, refreshToken: json.refresh_token || undefined }
}

async function getAccessToken(env: Env, refreshToken: string): Promise<string> {
  const token = await resolveAccessToken(env, AT_PREFIX, refreshToken, refreshClaudeToken)
  return token.accessToken
}

// =====================================================================
// 上游请求头（仿原生 Claude Code）
// =====================================================================

function apiHeaders(accessToken: string, stream: boolean): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'Accept': stream ? 'text/event-stream' : 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': CLAUDE_BETAS,
    'anthropic-dangerous-direct-browser-access': 'true',
    'User-Agent': CLAUDE_CLI_UA,
    'X-App': 'cli',
  }
}

// =====================================================================
// 对外入口
// =====================================================================

function extractUsage(body: any): { promptTokens: number; completionTokens: number } {
  const usage = body?.usage || {}
  return { promptTokens: Number(usage.input_tokens) || 0, completionTokens: Number(usage.output_tokens) || 0 }
}

export async function handleClaudeRequest(p: OAuthCallParams, subPath: string): Promise<Response> {
  const tokens = (p.refreshTokens || []).filter((t) => t && t.trim())
  if (tokens.length === 0) {
    return oauthErrorResponse('该 claude 渠道未配置凭据：请在「API Key」里每行填入一个 Anthropic OAuth refresh_token（可点「用 Claude 账号授权」获取）', 400, 'configuration_error')
  }
  const wantStream = p.body?.stream === true

  // 原生 Anthropic 协议透传（/v1/messages，方便 Claude Code 等客户端直连）
  if (subPath === 'messages-passthrough') {
    return forwardAnthropicNative(p, tokens[0].trim(), wantStream)
  }

  // 上游只认裸模型 ID(带 providerId/ 前缀会被拒绝)
  const { request } = openAIToAnthropicRequest({ ...p.body, model: p.modelId })
  let lastError = ''
  let lastStatus = 502

  for (const refreshToken of tokens) {
    try {
      const accessToken = await getAccessToken(p.env, refreshToken)
      const upstream = await fetch(`${CLAUDE_API_BASE}/v1/messages`, {
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
        const stream = createOpenAIStreamFromAnthropic(upstream.body, p.requestedModel, (usage) => {
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
      const openai = anthropicResponseToOpenAI(json, p.requestedModel)
      defer(p, recordOAuthUsage(p, extractUsage(json), true, 200))
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
  return oauthErrorResponse(`所有 Claude 账号均失败，最后一次错误: ${lastError || '未知'}`, lastStatus, 'key_exhausted')
}

/** /v1/messages 原生协议透传：请求体已是 Anthropic 格式，仅替换鉴权/标识头 */
async function forwardAnthropicNative(p: OAuthCallParams, refreshToken: string, wantStream: boolean): Promise<Response> {
  try {
    const accessToken = await getAccessToken(p.env, refreshToken)
    const upstream = await fetch(`${CLAUDE_API_BASE}/v1/messages`, {
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
// 后台：连通性测试 / 可用模型
// =====================================================================

export async function testClaude(env: Env, refreshToken: string, modelId: string): Promise<{ success: boolean; message: string; statusCode?: number }> {
  if (!refreshToken) return { success: false, message: '未填写 refresh_token', statusCode: 0 }
  try {
    const accessToken = await getAccessToken(env, refreshToken)
    const { request } = openAIToAnthropicRequest({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, model: modelId })
    const res = await fetch(`${CLAUDE_API_BASE}/v1/messages`, {
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

/** 拉取 Claude 可用模型（官方 /v1/models，OAuth Bearer 可读） */
export async function fetchClaudeModels(env: Env, refreshToken: string): Promise<{ success: boolean; models: string[]; message?: string }> {
  try {
    const accessToken = await getAccessToken(env, refreshToken)
    const res = await fetch(`${CLAUDE_API_BASE}/v1/models?limit=100`, {
      method: 'GET',
      headers: apiHeaders(accessToken, false),
      signal: AbortSignal.timeout(30000),
    })
    const text = await res.text()
    if (!res.ok) return { success: false, models: [], message: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    let json: any
    try { json = JSON.parse(text) } catch { return { success: false, models: [], message: '返回非 JSON' } }
    const rows: any[] = Array.isArray(json?.data) ? json.data : []
    const models = rows
      .map((m: any) => String(m?.id || ''))
      .filter((id: string) => id && /^[\w.:-]+$/.test(id))
    return { success: true, models: [...new Set(models)] }
  } catch (err) {
    return { success: false, models: [], message: (err as Error).message || '拉取失败' }
  }
}
