/**
 * MiniMax Agent 网页反代 (provider.type = 'minimaxweb')
 *
 * 移植 snake-aabb-wtf/minimaxM3-web2api 的协议实现（Python，已实测可用）：
 *  1. 端点：agent.minimaxi.com 建会话，agent-stream.minimaxi.com 发消息（SSE）
 *  2. 三个签名头由前端 Webpack 模块 97516 生成：
 *       x-signature = MD5(秒级时间戳 + 'I*7Cf%WZ#S&%1RlZJ&C2' + 请求体)
 *       yy          = MD5(encodeURIComponent(完整URL含参数) + '_' + 请求体
 *                        + MD5(毫秒时间戳) + 'ooui')
 *       token       = 登录 JWT
 *  3. 先 POST /archon/api/v1/agent/{agentId}/session 拿 session_id，
 *     再 POST /archon/api/v1/session/{sessionId}/message 发消息。
 *  4. 响应是 SSE，文本在 type=6 的 agent_message_chunk.msg_content。
 *
 * 凭据：渠道 apiKeys 每行一个账号，格式 `token|agentId|uuid|deviceId|userId`
 *      （从浏览器 agent.minimaxi.com 的 HAR 里取，token 是 JWT）。
 *      允许只写 token，agentId 等从渠道 project 字段或默认取值。
 */

import type { Env } from '../types'
import { md5Hex } from '../md5'
import {
  type OAuthCallParams,
  oauthErrorResponse,
  randomId,
  recordOAuthUsage,
  defer,
} from '../oauth/common'

const MINIMAX_BASE = 'https://agent.minimaxi.com'
const MINIMAX_STREAM_BASE = 'https://agent-stream.minimaxi.com'
const X_SIG_SECRET = 'I*7Cf%WZ#S&%1RlZJ&C2'
const TIMEOUT_MS = 180000

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
]

/** 模型清单：MiniMax Agent 网页端当前主推 M3（thinking / 非 thinking 两个变体） */
export const MINIMAX_WEB_MODELS = [
  'MiniMax-M3',
  'MiniMax-M3-thinking',
  'MiniMax-M2.1',
  'MiniMax-M2',
]

// MD5 统一用 src/md5.ts 的实现（Web Crypto 不支持 MD5）

/** 匹配 JS 的 encodeURIComponent：A-Za-z0-9 - _ . ! ~ * ' ( ) 不转义 */
function jsEncodeUriComponent(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

// =====================================================================
// 凭据
// =====================================================================

interface MiniMaxAccount {
  token: string
  agentId: string
  uuid: string
  deviceId: string
  userId: string
}

/**
 * 解析渠道 apiKeys。每行一个账号，格式：
 *   token|agentId|uuid|deviceId|userId
 * 允许省略后面的字段（agentId 从渠道 project 取，uuid/deviceId 随机生成）。
 */
function parseAccounts(entries: string[], fallbackAgentId?: string): MiniMaxAccount[] {
  const out: MiniMaxAccount[] = []
  for (const raw of entries) {
    const line = (raw || '').trim()
    if (!line) continue
    const [token, agentId, uuid, deviceId, userId] = line.split('|').map((s) => (s || '').trim())
    if (!token) continue
    out.push({
      token,
      agentId: agentId || fallbackAgentId || '',
      uuid: uuid || randomHexId(32),
      deviceId: deviceId || randomHexId(32),
      userId: userId || '0',
    })
  }
  return out
}

function randomHexId(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// =====================================================================
// 签名
// =====================================================================

function computeXSignature(tsSec: number, body: string): string {
  return md5Hex(`${tsSec}${X_SIG_SECRET}${body || ''}`)
}

function computeYY(fullUrl: string, body: string, tsMs: number): string {
  const inner = `${jsEncodeUriComponent(fullUrl)}_${body}${md5Hex(String(tsMs))}ooui`
  return md5Hex(inner)
}

/** 客户端元数据：必须按 JS 的插入顺序拼，签名与 URL 都会用到 */
function clientMetadata(acc: MiniMaxAccount, tsMs: number): Array<[string, string]> {
  const tz = -new Date().getTimezoneOffset() / 60
  const pairs: Array<[string, string]> = [
    ['device_platform', 'web'],
    ['biz_id', '3'],
    ['app_id', '3001'],
    ['version_code', '22201'],
    ['unix', String(tsMs)],
    ['timezone_offset', String(tz)],
    ['sys_language', 'zh'],
    ['lang', 'zh'],
    ['uuid', acc.uuid],
    ['device_id', acc.deviceId],
    ['os_name', 'Windows'],
    ['browser_name', 'Chrome'],
    ['user_id', acc.userId],
    ['screen_width', '1536'],
    ['screen_height', '864'],
    ['unix', String(tsMs)],
    ['token', acc.token],
  ]
  return pairs
}

function buildSignedRequest(
  urlPath: string,
  body: string,
  acc: MiniMaxAccount,
  streamHost = false,
): { url: string; headers: Record<string, string> } {
  const tsSec = Math.floor(Date.now() / 1000)
  const tsMs = Date.now()
  const host = streamHost ? MINIMAX_STREAM_BASE : MINIMAX_BASE

  const qs = clientMetadata(acc, tsMs)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  const fullUrl = `${host}${urlPath}?${qs}`

  return {
    url: fullUrl,
    headers: {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'Origin': MINIMAX_BASE,
      'Referer': `${MINIMAX_BASE}/`,
      'User-Agent': UA_POOL[Math.floor(Math.random() * UA_POOL.length)],
      'token': acc.token,
      'x-timestamp': String(tsSec),
      'x-signature': computeXSignature(tsSec, body),
      'yy': computeYY(fullUrl, body, tsMs),
    },
  }
}

// =====================================================================
// 模型配置
// =====================================================================

function modelConfig(model: string): { provider_id: string; model_id: string; model_variant: string } {
  const raw = (model || '').trim()
  const thinking = /thinking/i.test(raw)
  const id = raw.replace(/-thinking$/i, '')
  return { provider_id: 'minimax', model_id: id || 'MiniMax-M3', model_variant: thinking ? 'thinking' : 'fast' }
}

// =====================================================================
// 消息体
// =====================================================================

interface OpenAIMessage {
  role: string
  content: any
}

function messageText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p === 'string' ? p : p?.type === 'text' ? String(p.text || '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (content === null || content === undefined) return ''
  return String(content)
}

/** MiniMax 只吃最后一条用户消息，历史与 system 拼进前缀 */
function buildMsgBody(messages: OpenAIMessage[], model: string): string {
  const ctx: string[] = []
  for (const m of messages.slice(0, -1)) {
    const text = messageText(m.content).trim()
    if (!text) continue
    if (m.role === 'system') ctx.push(`系统指令: ${text}`)
    else if (m.role === 'assistant') ctx.push(`助手: ${text}`)
    else ctx.push(`用户: ${text}`)
  }
  const last = messages[messages.length - 1]
  let lastContent = last ? messageText(last.content).trim() : ''
  const prefix = ctx.join('\n\n')
  if (prefix) lastContent = `${prefix}\n\n用户说: ${lastContent}`

  return JSON.stringify({
    content: lastContent,
    model: modelConfig(model),
    turn_id: crypto.randomUUID(),
    worktreeMode: false,
  })
}

// =====================================================================
// SSE 解析
// =====================================================================

function createSseParser(): { feed(chunk: string): Array<Record<string, any>> } {
  let buffer = ''
  return {
    feed(chunk: string): Array<Record<string, any>> {
      buffer += chunk
      const out: Array<Record<string, any>> = []
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        for (const line of block.split('\n')) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const raw = t.slice(5).trim()
          if (!raw || raw === '[DONE]') continue
          try {
            const j = JSON.parse(raw)
            if (j && typeof j === 'object') out.push(j)
          } catch { /* 非 JSON 行跳过 */ }
        }
      }
      return out
    },
  }
}

function minimaxEventDelta(ev: Record<string, any>): { content?: string; done?: boolean; error?: string } {
  if (!ev || typeof ev !== 'object') return {}
  if (ev.base_resp && ev.base_resp.status_code && ev.base_resp.status_code !== 0) {
    return { error: String(ev.base_resp.status_msg || `上游错误码 ${ev.base_resp.status_code}`), done: true }
  }
  // 错误事件
  if (ev.event === 'error' || ev.type === 'error') {
    return { error: String(ev.message || ev.msg || '上游返回错误'), done: true }
  }
  // 流式文本分片
  if (ev.type === 6) {
    const chunk = ev.agent_message_chunk || {}
    const out: { content?: string; done?: boolean } = {}
    if (typeof chunk.msg_content === 'string' && chunk.msg_content) out.content = chunk.msg_content
    if (chunk.finish === true) out.done = true
    return out
  }
  // 整体消息结束
  if (ev.type === 2) {
    const msg = ev.agent_message || {}
    if (msg.finish_reason) {
      const out: { content?: string; done?: boolean } = {}
      if (!msg.content) out.done = true
      return out
    }
  }
  return {}
}

function createOpenAIStream(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void,
): ReadableStream<Uint8Array> {
  const parser = createSseParser()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const state = { id: `chatcmpl-minimaxweb-${randomId()}`, model: requestedModel }
  let roleSent = false
  let finished = false
  let completionChars = 0
  let controller!: ReadableStreamDefaultController<Uint8Array>

  const send = (delta: Record<string, any>, finish: string | null = null) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
      id: state.id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    })}\n\n`))
  }

  const finish = () => {
    if (finished) return
    finished = true
    send({}, 'stop')
    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
    const completionTokens = Math.ceil(completionChars / 4)
    if (onUsage) onUsage({ promptTokens: 0, completionTokens })
    try { controller.close() } catch { /* closed */ }
  }

  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl
      const reader = upstream.getReader()
      const pump = () => {
        reader.read().then(({ done, value }) => {
          if (done) {
            if (!roleSent) send({ role: 'assistant', content: '' })
            finish()
            return
          }
          for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
            if (finished) return
            const d = minimaxEventDelta(ev)
            if (d.content) {
              if (!roleSent) { roleSent = true; send({ role: 'assistant', content: '' }) }
              completionChars += d.content.length
              send({ content: d.content })
            }
            if (d.error) {
              send({ content: `[minimaxweb] ${d.error}` }, 'stop')
              finished = true
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              try { controller.close() } catch { /* closed */ }
              return
            }
            if (d.done) finish()
          }
          if (!finished) pump()
        }).catch((err) => {
          if (finished) return
          finished = true
          try {
            send({ content: `[minimaxweb] ${(err as Error)?.message || '上游流中断'}` }, 'stop')
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          } catch { /* closed */ }
        })
      }
      pump()
    },
  })
}

// =====================================================================
// 上游调用
// =====================================================================

interface UpstreamCall {
  ok: boolean
  status: number
  body: ReadableStream<Uint8Array> | null
  text: string
}

async function callMiniMax(acc: MiniMaxAccount, model: string, messages: OpenAIMessage[]): Promise<UpstreamCall> {
  if (!acc.agentId) {
    return { ok: false, status: 400, body: null, text: '缺少 agentId：请按 `token|agentId` 格式填写，或在渠道 project 字段填 agentId' }
  }

  // 1. 建会话
  const sessionBody = JSON.stringify({
    team_mode_off: true,
    model: `${modelConfig(model).provider_id}/${modelConfig(model).model_id}`,
  })
  const sessionReq = buildSignedRequest(`/archon/api/v1/agent/${acc.agentId}/session`, sessionBody, acc)
  const sessionResp = await fetch(sessionReq.url, {
    method: 'POST',
    headers: sessionReq.headers,
    body: sessionBody,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!sessionResp.ok) {
    return { ok: false, status: sessionResp.status, body: null, text: await sessionResp.text().catch(() => '') }
  }
  let sessionJson: any
  try { sessionJson = await sessionResp.json() } catch { return { ok: false, status: 502, body: null, text: '会话响应非 JSON' } }
  if (sessionJson?.base_resp?.status_code && sessionJson.base_resp.status_code !== 0) {
    return {
      ok: false,
      status: 401,
      body: null,
      text: `会话创建失败: ${sessionJson.base_resp.status_msg || sessionJson.base_resp.status_code}`,
    }
  }
  const sessionId = sessionJson?.session_id
  if (!sessionId) {
    return { ok: false, status: 502, body: null, text: `会话响应缺少 session_id: ${JSON.stringify(sessionJson).slice(0, 200)}` }
  }

  // 2. 发消息（走 stream 域）
  const msgBody = buildMsgBody(messages, model)
  const msgReq = buildSignedRequest(`/archon/api/v1/session/${sessionId}/message`, msgBody, acc, true)
  const msgResp = await fetch(msgReq.url, {
    method: 'POST',
    headers: msgReq.headers,
    body: msgBody,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!msgResp.ok) {
    return { ok: false, status: msgResp.status, body: null, text: await msgResp.text().catch(() => '') }
  }
  return { ok: true, status: 200, body: msgResp.body, text: '' }
}

// =====================================================================
// 对外入口
// =====================================================================

export async function handleMiniMaxWebRequest(
  p: OAuthCallParams,
  project?: string,
): Promise<Response> {
  const rawEntries = (p.refreshTokens || []).map((t) => (t || '').trim()).filter(Boolean)
  const accounts = parseAccounts(rawEntries, project)
  if (accounts.length === 0) {
    return oauthErrorResponse(
      '该 minimaxweb 渠道未配置凭据：请登录 https://agent.minimaxi.com 后从浏览器 Network 里取 token（JWT），按 `token|agentId` 格式填入「API Keys」',
      400,
      'configuration_error',
    )
  }

  const messages = Array.isArray(p.body?.messages) ? (p.body.messages as OpenAIMessage[]) : []
  if (messages.length === 0) {
    return oauthErrorResponse('messages 内容为空，无法转发', 400, 'invalid_request_error')
  }

  const model = p.requestedModel || p.modelId
  const stream = p.body?.stream === true
  let lastError = '未知错误'
  let lastStatus = 502

  for (const acc of accounts) {
    let up: UpstreamCall
    try {
      up = await callMiniMax(acc, model, messages)
    } catch (err) {
      lastError = (err as Error).message || '上游请求失败'
      lastStatus = 502
      continue
    }

    if (!up.ok || !up.body) {
      lastStatus = up.status
      lastError = `HTTP ${up.status}: ${(up.text || '').slice(0, 300)}`
      if ([401, 403, 409, 429].includes(up.status) || up.status >= 500) continue
      return oauthErrorResponse(lastError, up.status, 'upstream_error')
    }

    if (stream) {
      const [toClient, forUsage] = up.body.tee()
      const usageReader = forUsage.getReader()
      defer(p, (async () => {
        let bytes = 0
        for (;;) {
          const { done, value } = await usageReader.read()
          if (done) break
          bytes += value.byteLength
        }
        await recordOAuthUsage(p, { promptTokens: 0, completionTokens: Math.ceil(bytes / 4) }, true, 200)
      })().catch(() => {}))

      return new Response(createOpenAIStream(toClient, p.requestedModel), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        },
      })
    }

    // 非流式：读完整响应再聚合
    const raw = await new Response(up.body).text()
    const parser = createSseParser()
    let content = ''
    for (const ev of parser.feed(raw)) {
      const d = minimaxEventDelta(ev)
      if (d.content) content += d.content
      if (d.error) return oauthErrorResponse(`MiniMax 上游错误: ${d.error}`, 502, 'upstream_error')
    }
    const completionTokens = Math.ceil(content.length / 4)
    const json = {
      id: `chatcmpl-minimaxweb-${randomId()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: p.requestedModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: content || null },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: completionTokens, total_tokens: completionTokens },
    }
    defer(p, recordOAuthUsage(p, { promptTokens: 0, completionTokens }, true, 200))
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }

  return oauthErrorResponse(
    `所有 MiniMax 账号均失败，最后一次错误: ${lastError}`,
    lastStatus,
    'key_exhausted',
  )
}

// =====================================================================
// 后台
// =====================================================================

export async function testMiniMaxWeb(
  env: Env,
  rawToken: string,
  modelId: string,
  project?: string,
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const accounts = parseAccounts([rawToken], project)
  if (accounts.length === 0) return { success: false, message: '未填写 token', statusCode: 0 }
  try {
    const up = await callMiniMax(accounts[0], modelId, [{ role: 'user', content: 'hi' }])
    if (up.ok && up.body) {
      try { await up.body.cancel() } catch { /* ignore */ }
      return { success: true, message: '连接成功', statusCode: 200 }
    }
    return { success: false, message: `HTTP ${up.status}: ${(up.text || '').slice(0, 200)}`, statusCode: up.status }
  } catch (err) {
    return { success: false, message: (err as Error).message || '连接失败' }
  }
}

export function listMiniMaxWebModels(): { success: true; models: string[] } {
  return { success: true, models: MINIMAX_WEB_MODELS }
}