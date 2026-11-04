/**
 * DeepSeek 网页版反代 (provider.type = 'deepseek')
 *
 * DeepSeek 没有官方 OAuth：这里复刻 GitHub 上 deepseek 网页反代的通行做法（参照
 * NIyueeE/ds-free-api、CJackHwang/ds2api、xiaoY233/Chat2API）：
 *  1. 凭据是 chat.deepseek.com 网页会话的 userToken（浏览器 localStorage 里的 JWT，约 24h 有效）
 *  2. 每次请求：创建会话 -> 取 PoW challenge -> 解 DeepSeekHashV1 PoW -> 带
 *     x-ds-pow-response 头请求 /chat/completion（SSE）
 *  3. 把 DeepSeek 的 delta 事件流（p/o/v 协议，THINK/RESPONSE fragment）翻译成 OpenAI 格式
 *
 * 重要限制（务必知悉）：
 *  - PoW 解算为纯 CPU 计算（约 0.3~0.7s），Cloudflare Workers **免费版 CPU 上限 10ms 无法完成**，
 *    必须 Workers Paid（默认 30s CPU）；否则会被运行时以 CPU 超时终止。
 *  - DeepSeek 网页接口有 CloudFront WAF，数据中心出口 IP（含 Cloudflare Workers 出口）可能被拦截。
 *  - 网页接口非官方 API，存在账号风控风险；如可用，官方 api.deepseek.com（OpenAI 兼容渠道）更稳。
 *
 * 渠道 apiKeys 里每行一个 userToken。
 */

import type { Env } from '../types'
import { getKV } from '../storage/blob-store'
import {
  type OAuthCallParams,
  sha256Hex,
  oauthErrorResponse,
  randomId,
  recordOAuthUsage,
  defer,
} from '../oauth/common'
import { solveAndBuildPowHeader, type DsPowChallenge } from './pow'
import {
  injectTools,
  parseToolCalls,
  composeSystemSections,
  formatResponseFormatText,
  ToolCallDetector,
  type DetectOut,
  type ParsedToolCall,
} from './tools'
import type { OpenAIUsage } from '../responses-translate'

const DS_BASE = 'https://chat.deepseek.com/api/v0'
// PoW 解算 CPU 预算（毫秒），超时则返回明确错误而不是被运行时强杀
const DS_POW_MAX_MS = 20000
const SESSION_PREFIX = 'deepseek:sess:'

export const DEEPSEEK_DEFAULT_MODELS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash-search',
  'deepseek-v4-pro-search',
]

function dsHeaders(userToken: string, powHeader?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'Authorization': `Bearer ${userToken}`,
    'User-Agent': 'DeepSeek/2.0.4 Android/35',
    'x-client-platform': 'android',
    'x-client-version': '2.0.4',
    'x-client-locale': 'zh_CN',
    'x-app-version': '2.0.4',
  }
  if (powHeader) h['x-ds-pow-response'] = powHeader
  return h
}

// =====================================================================
// 消息 -> prompt（网页接口只接受单条 prompt）
// =====================================================================

function renderPrompt(messages: unknown, extraSystem?: string): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    return extraSystem ? `系统指令：${extraSystem}` : ''
  }
  const text = (c: unknown): string => {
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c.map((p) => (p && typeof p === 'object' && typeof (p as any).text === 'string' ? (p as any).text : '')).join('')
    }
    return ''
  }
  const users = messages.filter((m: any) => m?.role === 'user')
  const single = messages.length === 1 || (users.length === 1 && messages.every((m: any) => m?.role === 'user' || m?.role === 'system'))
  if (single && users.length === 1 && !messages.some((m: any) => m?.role === 'system') && !extraSystem) {
    return text(users[0].content)
  }
  const parts: string[] = []
  // 工具定义/格式规范作为普通系统指令注入一次（照 ds-free-api：不用未闭合 <think> 那套）
  if (extraSystem) parts.push(`系统指令：${extraSystem}`)
  for (const m of messages as any[]) {
    const body = text(m?.content)
    if (!body) continue
    if (m.role === 'system' || m.role === 'developer') parts.push(`系统指令：${body}`)
    else if (m.role === 'assistant') parts.push(`助手：${body}`)
    else if (m.role === 'tool') parts.push(`工具结果：${body}`)
    else parts.push(`用户：${body}`)
  }
  return parts.join('\n\n')
}

/** 模型名 -> 网页接口参数（model_type / thinking / search） */
export function modelOptions(modelId: string): { modelType: string; thinking: boolean; search: boolean } {
  const m = (modelId || '').toLowerCase()
  return {
    modelType: /pro|expert|reasoner/.test(m) ? 'expert' : 'default',
    thinking: !/nothinking|no-think|-fast-|noreason/.test(m),
    search: /search/.test(m),
  }
}

// =====================================================================
// DeepSeek delta 事件解析（p/o/v 协议）
// =====================================================================

interface DsFragment { type: string; content: string }

interface DsDelta {
  /** 文本增量（RESPONSE fragment） */
  content?: string
  /** 思考增量（THINK fragment） */
  reasoning?: string
  /** 状态变为 FINISHED / INCOMPLETE */
  done?: boolean
  /** 累计 token */
  tokens?: number
  /** 错误提示 */
  error?: string
}

/** 解析器：p/o 跨事件持久化，BATCH 递归展开，fragments 以 -1 指代最后一个 */
class DeepSeekDeltaParser {
  private op = 'SET'
  private path = ''
  private fragments: DsFragment[] = []
  usageTokens = 0
  error = ''
  done = false

  private lastFragment(): DsFragment | undefined {
    return this.fragments[this.fragments.length - 1]
  }

  private appendContent(path: string, value: unknown): DsDelta {
    if (typeof value !== 'string') return {}
    const m = /^response\/fragments\/(-?\d+)\/content$/.exec(path)
    if (!m) return {}
    const idxRaw = Number(m[1])
    const idx = idxRaw < 0 ? this.fragments.length + idxRaw : idxRaw
    const frag = this.fragments[idx]
    if (!frag) return {}
    frag.content += value
    return frag.type === 'THINK' ? { reasoning: value } : { content: value }
  }

  /** 处理一条已解析的事件；返回需要下发的内容增量 */
  apply(eventName: string, payload: any): DsDelta {
    if (eventName === 'hint' && payload) {
      if (payload.type === 'error') {
        this.error = payload.content || payload.finish_reason || '上游提示错误'
        this.done = true
        return { error: this.error, done: true }
      }
      return {}
    }
    if (!payload || typeof payload !== 'object') return {}

    // 初始快照：{"v":{"response":{"fragments":[...]}}}
    if (payload.v !== undefined && isPlainObject(payload.v) && (payload.v as any).response) {
      const frags = (payload.v as any).response.fragments
      if (Array.isArray(frags)) {
        this.fragments = frags.map((f: any) => ({ type: String(f?.type || 'RESPONSE'), content: String(f?.content || '') }))
      }
      return {}
    }

    // p / o 持久化
    const path: string = typeof payload.p === 'string' ? (this.path = payload.p) : this.path
    const op: string = typeof payload.o === 'string' ? (this.op = payload.o) : this.op

    if (op === 'BATCH') {
      const out: DsDelta = {}
      if (Array.isArray(payload.v)) {
        const savedPath = this.path, savedOp = this.op
        for (const item of payload.v) {
          const sub = { ...item }
          if (typeof sub.p === 'string' && path) sub.p = `${path}/${sub.p}`
          const d = this.apply('', sub)
          mergeDelta(out, d)
        }
        this.path = savedPath
        this.op = savedOp
      }
      return out
    }

    if (!path) return {}

    if (path === 'response/status' || path === 'response/quasi_status') {
      const v = String(payload.v || '')
      if (v === 'FINISHED' || v === 'INCOMPLETE') {
        this.done = true
        return { done: true }
      }
      return {}
    }
    if (path === 'response/accumulated_token_usage') {
      const n = Number(payload.v) || 0
      if (n > this.usageTokens) this.usageTokens = n
      return { tokens: this.usageTokens }
    }
    if (path === 'response/fragments' && Array.isArray(payload.v)) {
      for (const f of payload.v) this.fragments.push({ type: String(f?.type || 'RESPONSE'), content: String(f?.content || '') })
      return {}
    }
    if (/^response\/fragments\/-?\d+\/content$/.test(path)) {
      return this.appendContent(path, payload.v)
    }
    return {}
  }
}

function isPlainObject(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function mergeDelta(target: DsDelta, add: DsDelta): void {
  if (add.content) target.content = (target.content || '') + add.content
  if (add.reasoning) target.reasoning = (target.reasoning || '') + add.reasoning
  if (add.tokens) target.tokens = add.tokens
  if (add.error) target.error = add.error
  if (add.done) target.done = true
}

interface SseEvent { event: string; data: string }

function createSseParser(): { feed: (chunk: string) => SseEvent[] } {
  let buffer = ''
  let currentEvent = ''
  let currentData = ''
  const flush = (out: SseEvent[]) => {
    if (currentData) out.push({ event: currentEvent, data: currentData })
    currentEvent = ''
    currentData = ''
  }
  return {
    feed(chunk: string): SseEvent[] {
      buffer += chunk
      const out: SseEvent[] = []
      let idx: number
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        if (line === '') { flush(out); currentEvent = '' }
        else if (line.startsWith('event:')) currentEvent = line.slice(6).trim()
        else if (line.startsWith('data:')) currentData += (currentData ? '\n' : '') + line.slice(5).trim()
      }
      return out
    },
  }
}

// =====================================================================
// SSE -> OpenAI 流式翻译
// =====================================================================

function createOpenAIStreamFromDeepSeek(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
  onUsage?: (usage: OpenAIUsage) => void,
  useTools = false,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const parser = createSseParser()
  const state = new DeepSeekDeltaParser()
  // 工具检测器：只在请求带 tools 时启用。开启后 content 增量要先过一遍标签检测，
  // 避免把 `<|tool▁calls▁begin|>...` 这种控制标签泄漏给客户端。
  const detector = useTools ? new ToolCallDetector() : null
  let firstSent = false
  let finished = false
  let promptTokens = 0
  let toolCallIndex = 0
  const chatcmplId = `chatcmpl-ds-${randomId()}`

  const send = (controller: ReadableStreamDefaultController<Uint8Array>, delta: Record<string, any>, finish: string | null = null, withUsage = false) => {
    const chunk: Record<string, any> = {
      id: chatcmplId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    }
    if (withUsage) chunk.usage = { prompt_tokens: promptTokens, completion_tokens: state.usageTokens, total_tokens: promptTokens + state.usageTokens }
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
  }

  /** 把检测器的输出落成 SSE：文本照常发，工具块解析成 tool_calls 分片 */
  const emitDetect = (controller: ReadableStreamDefaultController<Uint8Array>, outs: DetectOut[]) => {
    for (const o of outs) {
      if (o.kind === 'content') {
        if (o.text) send(controller, { content: o.text })
        continue
      }
      // tool_block：解析 -> 逐条发 tool_calls 增量（OpenAI 流式要求先发 name，再分片发 arguments）
      const { calls, failed } = parseToolCalls(o.raw)
      if (failed.length) {
        // 解析不出来的片段当普通文本吐出去，宁可让客户端看到原文，也不要静默吞掉
        send(controller, { content: `\n[tool-call 解析失败] ${failed.join('\n')}\n` })
      }
      for (const call of calls) {
        const idx = toolCallIndex++
        send(controller, { tool_calls: [{ index: idx, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] })
        // arguments 一次性发出（DeepSeek 侧没有真正的增量 arguments，协议上允许整段发）
        send(controller, { tool_calls: [{ index: idx, function: { arguments: call.function.arguments } }] })
      }
      if (calls.length) {
        send(controller, {}, 'tool_calls', true)
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        finished = true
        if (onUsage) onUsage({ promptTokens, completionTokens: state.usageTokens })
      }
    }
  }

  const handle = (controller: ReadableStreamDefaultController<Uint8Array>, ev: SseEvent) => {
    if (!ev.data || ev.data === '[DONE]') return
    let payload: any
    try { payload = JSON.parse(ev.data) } catch { return }
    const d = state.apply(ev.event, payload)
    if (d.reasoning) send(controller, { reasoning_content: d.reasoning })
    if (d.content) {
      if (detector) emitDetect(controller, detector.push(d.content))
      else send(controller, { content: d.content })
    }
    if (d.error) {
      send(controller, { content: `[deepseek] ${d.error}` }, 'stop', true)
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      finished = true
      if (onUsage) onUsage({ promptTokens, completionTokens: state.usageTokens })
    } else if (d.done && !finished) {
      // 上游结束前先冲掉检测器缓冲（可能是未闭合的工具块，兜底当文本发）
      if (detector && !detector.isDone) emitDetect(controller, detector.flush())
      if (finished) return
      finished = true
      send(controller, {}, 'stop', true)
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      if (onUsage) onUsage({ promptTokens, completionTokens: state.usageTokens })
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = upstream.getReader()
      const pump = () => {
        reader.read().then(({ done, value }) => {
          if (done) {
            if (detector && !detector.isDone) emitDetect(controller, detector.flush())
            if (!firstSent) send(controller, { role: 'assistant', content: '' }, 'stop', true)
            else if (!finished) {
              send(controller, {}, 'stop', true)
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            }
            controller.close()
            return
          }
          for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
            if (!firstSent) { firstSent = true; send(controller, { role: 'assistant', content: '' }) }
            handle(controller, ev)
          }
          pump()
        }).catch(() => { try { controller.close() } catch { /* closed */ } })
      }
      pump()
    },
  })
}

/** 非流式：解析完整 SSE 文本，聚合成 OpenAI 响应 */
function deepseekTextToOpenAI(text: string, requestedModel: string, promptTokens: number, useTools = false): { body: Record<string, any>; usage: OpenAIUsage } {
  const parser = createSseParser()
  const state = new DeepSeekDeltaParser()
  const detector = useTools ? new ToolCallDetector() : null
  let content = ''
  let reasoning = ''
  let error = ''
  const toolCalls: ParsedToolCall[] = []
  const failedBlocks: string[] = []
  let toolParsed = false

  const collect = (raw: string) => {
    const { calls, failed } = parseToolCalls(raw)
    if (calls.length) { toolCalls.push(...calls); toolParsed = true }
    failedBlocks.push(...failed)
  }

  for (const ev of parser.feed(text)) {
    if (!ev.data || ev.data === '[DONE]') continue
    let payload: any
    try { payload = JSON.parse(ev.data) } catch { continue }
    const d = state.apply(ev.event, payload)
    if (d.content) {
      if (detector) {
        for (const o of detector.push(d.content)) {
          if (o.kind === 'content') content += o.text
          else collect(o.raw)
        }
      } else content += d.content
    }
    if (d.reasoning) reasoning += d.reasoning
    if (d.error) error = d.error
  }
  if (detector && !detector.isDone) {
    for (const o of detector.flush()) {
      if (o.kind === 'content') content += o.text
      else collect(o.raw)
    }
  }
  if (failedBlocks.length) content += `\n[tool-call 解析失败] ${failedBlocks.join('\n')}\n`

  const message: Record<string, any> = { role: 'assistant', content: error ? `[deepseek] ${error}` : (content || null), refusal: null }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) message.tool_calls = toolCalls
  return {
    body: {
      id: `chatcmpl-ds-${randomId()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{ index: 0, message, finish_reason: toolParsed ? 'tool_calls' : 'stop', logprobs: null }],
      usage: { prompt_tokens: promptTokens, completion_tokens: state.usageTokens, total_tokens: promptTokens + state.usageTokens },
    },
    usage: { promptTokens, completionTokens: state.usageTokens },
  }
}

// =====================================================================
// 会话缓存（避免每次请求都在账号里新建会话）
// =====================================================================

async function getOrCreateSession(env: Env, userToken: string, forceNew = false): Promise<string> {
  const cacheKey = SESSION_PREFIX + (await sha256Hex(userToken))
  const kv = getKV(env)
  if (!forceNew) {
    const cached = await kv.get(cacheKey).catch(() => null)
    if (cached) return cached
  }
  const res = await fetch(`${DS_BASE}/chat_session/create`, {
    method: 'POST',
    headers: dsHeaders(userToken),
    body: '{}',
    signal: AbortSignal.timeout(30000),
  })
  const json: any = await res.json().catch(() => null)
  const id = json?.data?.biz_data?.chat_session?.id
  if (!id) throw new Error(`创建 DeepSeek 会话失败: ${JSON.stringify(json).slice(0, 200)}`)
  await kv.put(cacheKey, String(id), { expirationTtl: 3600 }).catch(() => {})
  return String(id)
}

async function fetchPowChallenge(userToken: string, targetPath: string): Promise<DsPowChallenge> {
  const res = await fetch(`${DS_BASE}/chat/create_pow_challenge`, {
    method: 'POST',
    headers: dsHeaders(userToken),
    body: JSON.stringify({ target_path: targetPath }),
    signal: AbortSignal.timeout(30000),
  })
  const json: any = await res.json().catch(() => null)
  const challenge = json?.data?.biz_data?.challenge
  if (!challenge?.challenge) throw new Error(`获取 PoW challenge 失败: ${JSON.stringify(json).slice(0, 200)}`)
  return challenge as DsPowChallenge
}

// =====================================================================
// 对外入口
// =====================================================================

/** DeepSeek 官方 API Key（sk- 开头）与网页 userToken（JWT）走不同通道 */
function isOfficialApiKey(credential: string): boolean {
  return /^sk-[A-Za-z0-9]/.test(credential.trim())
}

const DS_OFFICIAL_BASE = 'https://api.deepseek.com'

/** 官方 API（OpenAI 兼容）直通：无需 PoW，Workers 免费版也能用 */
async function handleOfficialApiRequest(p: OAuthCallParams, credential: string): Promise<Response> {
  const wantStream = p.body?.stream === true
  const upstream = await fetch(`${DS_OFFICIAL_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential}`,
      Accept: wantStream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify({ ...p.body, model: p.modelId }),
    signal: AbortSignal.timeout(600000),
  })
  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 300)
    return oauthErrorResponse(`HTTP ${upstream.status}: ${detail}`, upstream.status, 'upstream_error')
  }
  if (wantStream && upstream.body) {
    const [toClient, forUsage] = upstream.body.tee()
    defer(p, (async () => {
      let usage = { promptTokens: 0, completionTokens: 0 }
      try {
        const text = await new Response(forUsage).text()
        for (const line of text.split('\n')) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const payload = t.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            const j = JSON.parse(payload)
            if (j?.usage) usage = { promptTokens: Number(j.usage.prompt_tokens) || 0, completionTokens: Number(j.usage.completion_tokens) || 0 }
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      await recordOAuthUsage(p, usage, true, 200)
    })())
    return new Response(toClient, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' },
    })
  }
  const raw = await upstream.text()
  let json: any
  try { json = JSON.parse(raw) } catch { return oauthErrorResponse(`上游返回非 JSON: ${raw.slice(0, 200)}`, 502, 'upstream_error') }
  defer(p, recordOAuthUsage(p, {
    promptTokens: Number(json?.usage?.prompt_tokens) || 0,
    completionTokens: Number(json?.usage?.completion_tokens) || 0,
  }, true, 200))
  return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

export async function handleDeepSeekRequest(p: OAuthCallParams, _subPath: string): Promise<Response> {
  const tokens = (p.refreshTokens || []).filter((t) => t && t.trim())
  if (tokens.length === 0) {
    return oauthErrorResponse('该 deepseek 渠道未配置凭据：可填 DeepSeek 官方 API Key（sk- 开头，走官方 API，免费版可用）或 chat.deepseek.com 的 userToken（网页反代，需 Workers Paid）', 400, 'configuration_error')
  }
  // 官方 API Key：OpenAI 兼容直通，无需 PoW
  const apiKey = tokens.find(isOfficialApiKey)
  if (apiKey) return handleOfficialApiRequest(p, apiKey.trim())

  // 工具调用：DeepSeek 网页接口不支持原生 function calling，
  // 把 tools/tool_choice/response_format 降级成提示词注入一次（照 ds-free-api）。
  const toolCtx = injectTools(p.body || {})
  const extraSystem = composeSystemSections(toolCtx, formatResponseFormatText(p.body?.response_format))
  const useTools = !!(toolCtx.defsText || toolCtx.formatBlock)

  const prompt = renderPrompt(p.body?.messages, extraSystem)
  if (!prompt) return oauthErrorResponse('请求缺少可用内容（messages 为空）', 400, 'invalid_request_error')
  const wantStream = p.body?.stream === true
  const { modelType, thinking, search } = modelOptions(p.modelId)
  const promptTokens = Math.ceil(prompt.length / 4)
  // 工具模式下强制开启思考：实测深度思考能显著提升标签遵循度、减少幻觉
  const thinkingFinal = useTools ? true : thinking
  let lastError = ''
  let lastStatus = 502

  for (const userToken of tokens) {
    try {
      let sessionId = await getOrCreateSession(p.env, userToken)
      const runCompletion = async (sid: string) => {
        const challenge = await fetchPowChallenge(userToken, '/api/v0/chat/completion')
        const powHeader = solveAndBuildPowHeader(challenge, DS_POW_MAX_MS)
        if (!powHeader) {
          throw new Error('PoW 解算超时（CPU 预算不足）：DeepSeek 网页反代需要 Cloudflare Workers Paid 套餐（免费版 CPU 上限 10ms），或降低难度/稍后重试')
        }
        return fetch(`${DS_BASE}/chat/completion`, {
          method: 'POST',
          headers: dsHeaders(userToken, powHeader),
          body: JSON.stringify({
            chat_session_id: sid,
            parent_message_id: null,
            model_type: modelType,
            prompt,
            ref_file_ids: [],
            thinking_enabled: thinkingFinal,
            search_enabled: search,
            preempt: false,
          }),
          signal: AbortSignal.timeout(600000),
        })
      }

      let upstream = await runCompletion(sessionId)
      // 会话失效时重建一次
      if (!upstream.ok && (upstream.status === 400 || upstream.status === 404)) {
        sessionId = await getOrCreateSession(p.env, userToken, true)
        upstream = await runCompletion(sessionId)
      }
      if (!upstream.ok) {
        lastStatus = upstream.status
        lastError = `HTTP ${upstream.status}: ${(await upstream.text().catch(() => '')).slice(0, 300)}`
        if ([401, 403, 429].includes(upstream.status) || upstream.status >= 500) continue
        return oauthErrorResponse(lastError, upstream.status, 'upstream_error')
      }

      if (wantStream && upstream.body) {
        const stream = createOpenAIStreamFromDeepSeek(upstream.body, p.requestedModel, (usage) => {
          defer(p, recordOAuthUsage(p, usage, true, 200))
        }, useTools)
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' },
        })
      }

      const text = await upstream.text()
      if (/value="captcha"|__cf_chl|CloudFront|Request blocked/i.test(text.slice(0, 500))) {
        return oauthErrorResponse('上游返回拦截页面（WAF/风控）：当前 Worker 出口 IP 可能被 DeepSeek 拦截', 502, 'waf_blocked')
      }
      const { body, usage } = deepseekTextToOpenAI(text, p.requestedModel, promptTokens, useTools)
      defer(p, recordOAuthUsage(p, usage, true, 200))
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    } catch (err) {
      lastError = (err as Error).message || '未知错误'
      lastStatus = 502
      continue
    }
  }
  return oauthErrorResponse(`所有 DeepSeek 账号均失败，最后一次错误: ${lastError || '未知'}`, lastStatus, 'key_exhausted')
}

// =====================================================================
// 后台：凭据校验 / 可用模型
// =====================================================================

export async function testDeepSeek(_env: Env, userToken: string, modelId: string): Promise<{ success: boolean; message: string; statusCode?: number }> {
  if (!userToken) return { success: false, message: '未填写凭据', statusCode: 0 }
  // 官方 API Key：用 /models 校验
  if (isOfficialApiKey(userToken)) {
    try {
      const res = await fetch(`${DS_OFFICIAL_BASE}/models`, {
        headers: { Authorization: `Bearer ${userToken.trim()}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      })
      if (res.ok) return { success: true, message: '官方 API Key 有效（走 api.deepseek.com，免费版可用）', statusCode: 200 }
      return { success: false, message: `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`, statusCode: res.status }
    } catch (err) {
      return { success: false, message: (err as Error).message || '连接失败' }
    }
  }
  try {
    const res = await fetch(`${DS_BASE}/users/current`, {
      method: 'GET',
      headers: dsHeaders(userToken),
      signal: AbortSignal.timeout(30000),
    })
    const json: any = await res.json().catch(() => null)
    if (json?.code === 0 && json?.data?.biz_data) {
      const user = json.data.biz_data
      const name = user?.email || user?.mobile_number || user?.id || '未知账号'
      return { success: true, message: `凭据有效（${name}），模型 ${modelId || DEEPSEEK_DEFAULT_MODELS[0]}；注意 PoW 需要 Workers Paid 套餐`, statusCode: 200 }
    }
    return { success: false, message: `凭据无效: ${JSON.stringify(json).slice(0, 200)}`, statusCode: res.status }
  } catch (err) {
    return { success: false, message: (err as Error).message || '连接失败' }
  }
}

/** 上游无模型清单接口，返回本地维护的模型 */
export function fetchDeepSeekModels(): { success: boolean; models: string[] } {
  return { success: true, models: [...DEEPSEEK_DEFAULT_MODELS] }
}
