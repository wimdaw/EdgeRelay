/**
 * 中国移动灵犀网页反代 (provider.type = 'lingxi')
 *
 * 移植 janejanejana/lingxi_web2api 的协议实现（Python，已实测可用）：
 *  1. 端点：ai.yun.139.com/api/outer/assistant/chat/v2/add（SSE 一次性长连接）
 *     Origin 却是 appmail.mail.10086.cn（跨站请求），这两个必须一致
 *  2. 鉴权只要两个值：Authorization(Basic ...) + userId，都来自中国移动邮箱网页 Cookie
 *  3. 请求体是灵犀的 dialogueInput 结构，对话内容放在 dialogue 字段，
 *     整段历史用 System:/User:/Assistant: 标签拼在一处
 *
 * 凭据：渠道 apiKeys 每行一个账号，格式 `authorization|userId|sourceChannel`
 *      （不写 userId 时从渠道 project 取；sourceChannel 默认 10175）
 */

import type { Env } from '../types'
import {
  type OAuthCallParams,
  oauthErrorResponse,
  randomId,
  recordOAuthUsage,
  defer,
} from '../oauth/common'

const LINGXI_HOST = 'https://ai.yun.139.com'
const LINGXI_ORIGIN = 'https://appmail.mail.10086.cn'
const CHAT_PATH = '/api/outer/assistant/chat/v2/add'
const TIMEOUT_MS = 120000

/** 灵犀网页端当前提供的模型（网页/APP 侧可切换） */
export const LINGXI_MODELS = [
  'lingxi-default',
  'qwen-3.7-plus',
  'deepseek-4.0-pro',
]

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

// =====================================================================
// 凭据
// =====================================================================

interface LingxiAccount {
  authorization: string
  userId: string
  sourceChannel: string
}

/**
 * 解析渠道 apiKeys。每行一个账号：
 *   authorization|userId|sourceChannel
 * 也允许直接粘整条 Cookie（从里面正则抠出 authorization 与 user_id）。
 */
function parseAccounts(entries: string[], fallbackUserId?: string): LingxiAccount[] {
  const out: LingxiAccount[] = []
  for (const raw of entries) {
    const line = (raw || '').trim()
    if (!line) continue
    const [auth, uid, channel] = line.split('|').map((s) => (s || '').trim())

    let authorization = auth
    let userId = uid || fallbackUserId || ''

    // 兼容直接粘 Cookie 串：authorization=Basic%20xxx 或 authorization=Basic xxx
    if (!authorization.includes('Basic')) {
      const mAuth = line.match(/authorization=([^;]+)/i)
      if (mAuth) authorization = decodeURIComponent(mAuth[1].trim())
    }
    if (!userId) {
      const mUid = line.match(/user_?id=([^;]+)/i)
      if (mUid) userId = decodeURIComponent(mUid[1].trim())
    }
    // 只填了 userId 没填 authorization 时，允许裸传（部分账号只要 userId）
    if (!authorization && !userId) continue

    out.push({ authorization, userId, sourceChannel: channel || '10175' })
  }
  return out
}

// =====================================================================
// 请求体
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

/** 灵犀只吃单条 dialogue 文本，多轮历史拼成带标签的一段 */
function buildDialogue(messages: OpenAIMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    const text = messageText(m.content).trim()
    if (!text) continue
    if (m.role === 'system') parts.push(`System: ${text}`)
    else if (m.role === 'assistant') parts.push(`Assistant: ${text}`)
    else parts.push(`User: ${text}`)
  }
  return parts.join('\n\n')
}

/** 北京时间 ISO 串，与 Python 的 strftime('%Y-%m-%dT%H:%M:%S+08:00') 对齐 */
function beijingIsoNow(): string {
  const now = new Date()
  const bj = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${bj.getFullYear()}-${p(bj.getMonth() + 1)}-${p(bj.getDate())}T${p(bj.getHours())}:${p(bj.getMinutes())}:${p(bj.getSeconds())}+08:00`
}

function buildPayload(
  dialogue: string,
  acc: LingxiAccount,
  enableSearch: boolean,
): Record<string, any> {
  const extInfo = { pcVersion: '1.7.0', h5Version: '3.2.0', dialogueType: 'noAiEditDialogue' }
  return {
    applicationType: 'chat',
    sessionId: '',
    dialogueInput: {
      dialogue,
      prompt: '',
      inputTime: beijingIsoNow(),
      command: null,
      resourceType: '0',
      resourceId: '',
      dialogueType: '0',
      commandType: 1,
      enableForceNetworkSearch: enableSearch,
      enableAllNetworkSearch: false,
      enableAiSearch: false,
      extInfo: JSON.stringify(extInfo),
      versionInfo: { pcVersion: '1.7.0', h5Version: '3.2.0' },
      toolSetting: { imageToolSetting: { enableLlmDescribe: false } },
      attachment: {},
      aiWritingSetting: {},
      enableModelThinking: false,
      enableKnowledgeAndNetworkSearch: false,
    },
    sourceChannel: acc.sourceChannel,
    userId: acc.userId,
    continuationInfo: null,
  }
}

function buildHeaders(acc: LingxiAccount): Record<string, string> {
  const h: Record<string, string> = {
    'Host': 'ai.yun.139.com',
    'User-Agent': UA,
    'sec-ch-ua-platform': '"Windows"',
    'sec-ch-ua': '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"',
    'sec-ch-ua-mobile': '?0',
    'x-yun-client-info': '4g||30|||||||1536/864|zh-CN||||',
    'x-yun-api-version': 'v1',
    'x-yun-app-channel': acc.sourceChannel,
    'accept': 'text/event-stream',
    'DNT': '1',
    'Content-Type': 'application/json',
    'x-yun-tid': crypto.randomUUID(),
    'Origin': LINGXI_ORIGIN,
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Referer': `${LINGXI_ORIGIN}/`,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,zh-TW;q=0.7',
  }
  if (acc.authorization) h['Authorization'] = acc.authorization
  return h
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

/**
 * 从灵犀事件里抽文本增量。上游把增量文本放在 resultType=1 的块里，
 * resultType=4 是图片（先占位后出图），本模块只透传文本。
 */
function lingxiEventDelta(ev: Record<string, any>): { content?: string; done?: boolean; error?: string } {
  if (!ev || typeof ev !== 'object') return {}

  const err = ev.error || ev.errorMsg || (ev.result && ev.result.errorMsg)
  if (err) return { error: String(err), done: true }

  const out: { content?: string; done?: boolean } = {}
  const blocks = ev.result || ev.resultList || ev.flow || (Array.isArray(ev) ? ev : null)
  const list = Array.isArray(blocks)
    ? blocks
    : Array.isArray(blocks?.result)
      ? blocks.result
      : Array.isArray(ev.resultList)
        ? ev.resultList
        : null

  if (list) {
    const texts: string[] = []
    for (const b of list) {
      const type = Number(b?.resultType ?? b?.type ?? 0)
      if (type === 1) {
        const content = b?.content ?? b?.text ?? b?.delta
        if (typeof content === 'string' && content) texts.push(content)
      }
    }
    if (texts.length > 0) {
      out.content = texts.join('')
      return out
    }
  }

  // 顶层直给 content 的简化形态
  if (typeof ev.content === 'string' && ev.content) return { content: ev.content }
  if (ev.finish === true || ev.done === true || ev.isEnd === true) return { done: true }

  return out
}

function createOpenAIStream(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void,
): ReadableStream<Uint8Array> {
  const parser = createSseParser()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const state = { id: `chatcmpl-lingxi-${randomId()}`, model: requestedModel }
  let roleSent = false
  let finished = false
  let chars = 0
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
    if (onUsage) onUsage({ promptTokens: 0, completionTokens: Math.ceil(chars / 4) })
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
            const d = lingxiEventDelta(ev)
            if (d.content) {
              if (!roleSent) { roleSent = true; send({ role: 'assistant', content: '' }) }
              chars += d.content.length
              send({ content: d.content })
            }
            if (d.error) {
              send({ content: `[lingxi] ${d.error}` }, 'stop')
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
            send({ content: `[lingxi] ${(err as Error)?.message || '上游流中断'}` }, 'stop')
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

async function callLingxi(
  acc: LingxiAccount,
  dialogue: string,
  enableSearch: boolean,
): Promise<UpstreamCall> {
  const payload = JSON.stringify(buildPayload(dialogue, acc, enableSearch))
  const resp = await fetch(`${LINGXI_HOST}${CHAT_PATH}`, {
    method: 'POST',
    headers: buildHeaders(acc),
    body: payload,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!resp.ok) {
    return { ok: false, status: resp.status, body: null, text: await resp.text().catch(() => '') }
  }
  if (!resp.body) {
    return { ok: false, status: 502, body: null, text: '上游未返回响应体' }
  }
  return { ok: true, status: 200, body: resp.body, text: '' }
}

// =====================================================================
// 对外入口
// =====================================================================

export async function handleLingxiRequest(
  p: OAuthCallParams,
  project?: string,
): Promise<Response> {
  const rawEntries = (p.refreshTokens || []).map((t) => (t || '').trim()).filter(Boolean)
  const accounts = parseAccounts(rawEntries, project)
  if (accounts.length === 0) {
    return oauthErrorResponse(
      '该 lingxi 渠道未配置凭据：登录中国移动邮箱网页版后，从浏览器请求头里取 Authorization(Basic ...) 与 user_id，按 `authorization|userId` 填入「API Keys」',
      400,
      'configuration_error',
    )
  }

  const messages = Array.isArray(p.body?.messages) ? (p.body.messages as OpenAIMessage[]) : []
  if (messages.length === 0) {
    return oauthErrorResponse('messages 内容为空，无法转发', 400, 'invalid_request_error')
  }

  const dialogue = buildDialogue(messages)
  if (!dialogue) {
    return oauthErrorResponse('messages 内容为空，无法转发', 400, 'invalid_request_error')
  }

  const stream = p.body?.stream === true
  const enableSearch = Boolean(p.body?.web_search || p.body?.enable_web_search)
  let lastError = '未知错误'
  let lastStatus = 502

  for (const acc of accounts) {
    let up: UpstreamCall
    try {
      up = await callLingxi(acc, dialogue, enableSearch)
    } catch (err) {
      lastError = (err as Error).message || '上游请求失败'
      lastStatus = 502
      continue
    }

    if (!up.ok || !up.body) {
      lastStatus = up.status
      lastError = `HTTP ${up.status}: ${(up.text || '').slice(0, 300)}`
      if ([401, 403, 429].includes(up.status) || up.status >= 500) continue
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

    const raw = await new Response(up.body).text()
    const parser = createSseParser()
    let content = ''
    for (const ev of parser.feed(raw)) {
      const d = lingxiEventDelta(ev)
      if (d.content) content += d.content
      if (d.error) return oauthErrorResponse(`灵犀上游错误: ${d.error}`, 502, 'upstream_error')
    }
    const completionTokens = Math.ceil(content.length / 4)
    const json = {
      id: `chatcmpl-lingxi-${randomId()}`,
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
    `所有灵犀账号均失败，最后一次错误: ${lastError}`,
    lastStatus,
    'key_exhausted',
  )
}

// =====================================================================
// 后台
// =====================================================================

export async function testLingxi(
  env: Env,
  rawAuth: string,
  project?: string,
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const accounts = parseAccounts([rawAuth], project)
  if (accounts.length === 0) return { success: false, message: '未填写凭据', statusCode: 0 }
  try {
    const up = await callLingxi(accounts[0], '你好', false)
    if (up.ok && up.body) {
      try { await up.body.cancel() } catch { /* ignore */ }
      return { success: true, message: '连接成功', statusCode: 200 }
    }
    return { success: false, message: `HTTP ${up.status}: ${(up.text || '').slice(0, 200)}`, statusCode: up.status }
  } catch (err) {
    return { success: false, message: (err as Error).message || '连接失败' }
  }
}

export function listLingxiModels(): { success: true; models: string[] } {
  return { success: true, models: LINGXI_MODELS }
}