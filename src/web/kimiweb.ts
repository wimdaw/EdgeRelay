/**
 * Kimi Web 网页反代 (provider.type = 'kimiweb')
 *
 * 参考 chopper1026/kimi2api 的协议实现（Python 版，已实测可用），按网关既有 OAuth 渠道
 * 结构改写为 Cloudflare Workers 版本：
 *  1. 凭据是 www.kimi.ai 网页登录后的 access_token(JWT) 或 refresh_token，
 *     从浏览器 Local Storage 里取。渠道 apiKeys 每行一个，可放多账号自动轮换。
 *  2. refresh_token 自动换 access_token（GET /api/auth/token/refresh），
 *     access_token 缓存进 KV 并按 JWT exp 提前 5 分钟续期；轮换出的新 refresh_token
 *     同样回写，保证上游 refresh_token 一次性轮换后不失效。
 *  3. 上游聊天是 Connect-RPC 私有协议：POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat，
 *     请求体 = 5 字节帧头(0x00 + 大端长度) + JSON 信封；响应是同格式的二进制帧流。
 *  4. 响应帧里 mask 字段区分 block.think(思考) / block.text(回答)，
 *     翻译成 OpenAI SSE：思考走 reasoning_content，回答走 content。
 *
 * 区域：默认国际站 www.kimi.ai（实测 kimi.ai 不带 www 会 405，务必带 www）；
 *       baseUrl 含 kimi.com 时切到中国站。
 *
 * ⚠️ 与 type=kimi（Kimi Coding OAuth 反代，api.kimi.ai/coding）是两套独立体系：
 *    凭据不通用、模型名不同（Web 侧叫 k3/k2d6，Coding 侧叫 kimi-for-coding）。
 */

import type { Env } from '../types'
import {
  type OAuthCallParams,
  oauthErrorResponse,
  randomId,
  readErrorBody,
  recordOAuthUsage,
  defer,
  resolveAccessToken,
} from '../oauth/common'

const KIMI_WEB_DEFAULT_BASE = 'https://www.kimi.ai'
const AT_PREFIX = 'kimiweb:at:'

const CHAT_PATH = '/apiv2/kimi.gateway.chat.v1.ChatService/Chat'
const MODELS_PATH = '/apiv2/kimi.gateway.config.v1.ConfigService/GetAvailableModels'
const REFRESH_PATH = '/api/auth/token/refresh'

/** 上游超时：K3 是慢思考模型，给足 10 分钟 */
const KIMI_WEB_TIMEOUT_MS = 600000

// ===== 浏览器指纹池(参照 gemini-web2api 的多指纹轮换, 降低被上游识别为爬虫的概率) =====
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
]
const ACCEPT_LANGUAGE_POOL = [
  'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'zh-CN,zh;q=0.9,en;q=0.8',
  'en-US,en;q=0.9',
]

interface WebFingerprint {
  baseUrl: string
  userAgent: string
  acceptLanguage: string
  deviceId: string
  sessionId: string
  acceptEncoding: string
}

function randomDigits(min: number, max: number): string {
  return String(Math.floor(Math.random() * (max - min)) + min)
}

/** 每个请求生成一份独立指纹：绝不存全局可变状态(Isolate 热启动会串味) */
function buildFingerprint(baseUrl?: string): WebFingerprint {
  return {
    baseUrl: (baseUrl || KIMI_WEB_DEFAULT_BASE).replace(/\/+$/, ''),
    userAgent: UA_POOL[Math.floor(Math.random() * UA_POOL.length)],
    acceptLanguage: ACCEPT_LANGUAGE_POOL[Math.floor(Math.random() * ACCEPT_LANGUAGE_POOL.length)],
    deviceId: randomDigits(7000000000000000000, 7999999999999999999),
    sessionId: randomDigits(1700000000000000000, 1799999999999999999),
    acceptEncoding: 'gzip, deflate, br, zstd',
  }
}

function webHeaders(fp: WebFingerprint, token: string, extra?: Record<string, string>): Record<string, string> {
  return {
    'Accept': 'application/json',
    'Accept-Encoding': fp.acceptEncoding,
    'Accept-Language': fp.acceptLanguage,
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Authorization': `Bearer ${token}`,
    'Origin': fp.baseUrl,
    'Referer': `${fp.baseUrl}/`,
    'User-Agent': fp.userAgent,
    'X-Msh-Platform': 'web',
    'X-Msh-Device-Id': fp.deviceId,
    'X-Msh-Session-Id': fp.sessionId,
    ...(extra || {}),
  }
}

// =====================================================================
// 帧编解码：Connect-RPC 用 [0x00][4 字节大端长度][JSON body]
// =====================================================================

function encodeFrame(payload: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(payload))
  const out = new Uint8Array(5 + body.length)
  out[0] = 0x00
  new DataView(out.buffer).setUint32(1, body.length, false)
  out.set(body, 5)
  return out
}

/** 从字节流里逐帧切出 JSON 事件；返回 null 表示数据还不够，等下次 feed */
function createFrameParser(): { feed: (chunk: Uint8Array) => Array<Record<string, any>> } {
  let buffer = new Uint8Array(0)

  return {
    feed(chunk: Uint8Array): Array<Record<string, any>> {
      const merged = new Uint8Array(buffer.length + chunk.length)
      merged.set(buffer, 0)
      merged.set(chunk, buffer.length)
      buffer = merged

      const out: Array<Record<string, any>> = []
      let offset = 0
      while (offset + 5 <= buffer.length) {
        // 高位 flag 非 0 的压缩帧本渠道不会出现；遇到就跳过整帧避免死循环
        if (buffer[offset] !== 0x00) {
          offset += 5
          continue
        }
        const view = new DataView(buffer.buffer, buffer.byteOffset + offset + 1, 4)
        const length = view.getUint32(0, false)
        const frameEnd = offset + 5 + length
        if (frameEnd > buffer.length) break
        const text = new TextDecoder().decode(buffer.subarray(offset + 5, frameEnd))
        try {
          const parsed = JSON.parse(text)
          if (parsed && typeof parsed === 'object') out.push(parsed)
        } catch { /* 非 JSON 帧跳过 */ }
        offset = frameEnd
      }
      buffer = offset === 0 ? buffer : buffer.subarray(offset)
      return out
    },
  }
}

// =====================================================================
// access_token 解析与续期
// =====================================================================

function parseJwtExp(token: string): number {
  const parts = token.split('.')
  if (parts.length !== 3) return 0
  try {
    const payload = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4)
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return Number(json.exp) || 0
  } catch {
    return 0
  }
}

function isJwtAccessToken(token: string): boolean {
  return token.startsWith('eyJ') && token.split('.').length === 3
}

async function fetchWebAccessToken(fp: WebFingerprint, rawToken: string): Promise<{ accessToken: string; expiresIn: number; refreshToken?: string }> {
  // 直接给了 access_token(JWT)：按 exp 推算有效期，不做无谓刷新
  if (isJwtAccessToken(rawToken)) {
    const exp = parseJwtExp(rawToken)
    const expiresIn = exp ? Math.max(60, Math.floor((exp * 1000 - Date.now()) / 1000)) : 3600
    return { accessToken: rawToken, expiresIn }
  }

  const res = await fetch(`${fp.baseUrl}${REFRESH_PATH}`, {
    method: 'GET',
    headers: webHeaders(fp, rawToken),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Kimi token 已失效 (HTTP ${res.status})，请重新登录 www.kimi.ai 获取`)
  }
  if (!res.ok) {
    throw new Error(`Kimi token 续期失败 HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  let json: any
  try { json = JSON.parse(text) } catch { throw new Error('Kimi token 续期返回非 JSON') }
  const accessToken = json?.access_token || json?.token
  if (!accessToken) throw new Error('Kimi token 续期未返回 access_token')
  const exp = parseJwtExp(accessToken)
  const expiresIn = exp ? Math.max(60, Math.floor((exp * 1000 - Date.now()) / 1000)) : Number(json?.expires_in) || 3600
  return { accessToken, expiresIn, refreshToken: json?.refresh_token || undefined }
}

async function getWebAccessToken(env: Env, fp: WebFingerprint, rawToken: string): Promise<string> {
  const cached = await resolveAccessToken(env, AT_PREFIX, rawToken, (token) => fetchWebAccessToken(fp, token))
  return cached.accessToken
}

// =====================================================================
// 模型目录
// =====================================================================

interface KimiWebModelSpec {
  key: string
  displayName: string
  scenario: string
  agentMode: string
  kimiPlusId: string
  thinking: boolean
  supportsWebSearch: boolean
}

/**
 * 拉取上游可用模型。目录接口对未登录请求也会返回基础列表，
 * 因此没配 token 时用它也能拿到基础清单(便于后台展示)。
 */
export async function fetchKimiWebModels(
  env: Env,
  rawToken: string,
  baseUrl?: string,
): Promise<{ success: boolean; models: string[]; message?: string }> {
  const fp = buildFingerprint(baseUrl)
  let token = ''
  if (rawToken) {
    try {
      token = await getWebAccessToken(env, fp, rawToken)
    } catch (err) {
      return { success: false, models: [], message: (err as Error).message || 'token 续期失败' }
    }
  }

  try {
    // 实测：模型目录接口只吃裸 JSON + application/json，
    // 加 5 字节帧头或换 application/proto+json 都会被判 415/400。
    const res = await fetch(`${fp.baseUrl}${MODELS_PATH}`, {
      method: 'POST',
      headers: webHeaders(fp, token || 'anonymous', { 'Content-Type': 'application/json' }),
      body: '{}',
      signal: AbortSignal.timeout(30000),
    })
    const text = await res.text()
    if (!res.ok) {
      return { success: false, models: [], message: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    }
    let catalog: Record<string, any>
    try { catalog = JSON.parse(text) } catch { return { success: false, models: [], message: '上游返回非 JSON' } }
    const specs = parseModelSpecs([catalog])
    if (specs.length === 0) {
      return { success: false, models: [], message: '上游未返回模型列表' }
    }
    return { success: true, models: specs.map((s) => s.key) }
  } catch (err) {
    return { success: false, models: [], message: (err as Error).message || '拉取失败' }
  }
}

/** 从目录响应里抽出模型定义(含 -search 联网别名，与 kimi2api 一致) */
function parseModelSpecs(catalog: Record<string, any>[]): KimiWebModelSpec[] {
  const rows: any[] = []
  for (const frame of catalog) {
    const models = frame?.availableModels || frame?.available_models
    if (Array.isArray(models)) rows.push(...models)
  }
  const specs: KimiWebModelSpec[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const key = String(raw.key || raw.id || '')
    if (!key) continue
    const scenario = String(raw.scenario || '')
    specs.push({
      key,
      displayName: String(raw.displayName || raw.display_name || key),
      scenario,
      agentMode: String(raw.agentMode || raw.agent_mode || ''),
      kimiPlusId: String(raw.kimiPlusId || raw.kimi_plus_id || ''),
      thinking: Boolean(raw.thinking),
      supportsWebSearch: scenario === 'SCENARIO_K2D5',
    })
  }
  // 联网别名：上游支持 search 的模型补一个 -search 后缀
  const withSearch: KimiWebModelSpec[] = [...specs]
  for (const s of specs) {
    if (s.supportsWebSearch && !s.key.endsWith('-search')) {
      withSearch.push({ ...s, key: `${s.key}-search`, supportsWebSearch: true })
    }
  }
  return withSearch
}

/** 兜底模型清单：上游目录接口不可用时至少让渠道可用 */
export const KIMI_WEB_FALLBACK_MODELS = ['k3', 'k3-agent-ultra', 'k2d6', 'k2d6-search']

// =====================================================================
// 聊天：OpenAI 请求 -> Kimi 信封
// =====================================================================

interface OpenAIMessage {
  role: string
  content: any
}

function messageText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part
        if (part?.type === 'text') return String(part.text || '')
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content === null || content === undefined) return ''
  return String(content)
}

/**
 * Kimi Web 只接受单条扁平 prompt（kimi2api 的 _format_messages 同款做法）：
 * 按角色拼成 "role:内容" 的多行文本塞进一个 user block。
 * 这样不依赖上游的多轮 message 数组，多轮上下文由网关侧拼接。
 */
function flattenMessages(messages: OpenAIMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const text = messageText(m.content).trim()
    if (!text) continue
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user'
    lines.push(`${role}:${text}`)
  }
  return lines.join('\n')
}

function buildChatPayload(model: string, prompt: string, enableWebSearch: boolean): Record<string, any> {
  const spec = resolveSpec(model)
  const payload: Record<string, any> = {
    scenario: spec.scenario,
    tools: enableWebSearch || spec.forceWebSearch ? [{ type: 'TOOL_TYPE_SEARCH', search: {} }] : [],
    message: {
      role: 'user',
      blocks: [{ message_id: '', text: { content: prompt } }],
      scenario: spec.scenario,
    },
    options: { thinking: spec.thinking },
  }
  if (spec.kimiPlusId) payload.kimiplusId = spec.kimiPlusId
  if (spec.agentMode) payload.agentMode = spec.agentMode
  return payload
}

/** 模型名 -> scenario/能力。model 可为 k3 / k3-search / k3-agent-ultra / k2d6 等 */
interface ResolvedSpec {
  scenario: string
  thinking: boolean
  kimiPlusId: string
  agentMode: string
  forceWebSearch: boolean
}

function resolveSpec(model: string): ResolvedSpec {
  const raw = (model || '').trim().toLowerCase()
  const forceWebSearch = raw.endsWith('-search')
  const base = forceWebSearch ? raw.slice(0, -'-search'.length) : raw

  if (base === 'k3') {
    return { scenario: 'SCENARIO_OK_COMPUTER', thinking: false, kimiPlusId: 'ok-computer', agentMode: 'TYPE_NORMAL', forceWebSearch }
  }
  if (base === 'k3-agent-ultra' || base === 'k3-swarm') {
    return { scenario: 'SCENARIO_OK_COMPUTER', thinking: false, kimiPlusId: 'ok-computer', agentMode: 'TYPE_ULTRA', forceWebSearch }
  }
  // k2d6 = 官网 "Instant"(SCENARIO_K2D5)，该场景原生支持联网
  return { scenario: 'SCENARIO_K2D5', thinking: base.includes('thinking'), kimiPlusId: '', agentMode: '', forceWebSearch }
}

/** 客户端可能用 kimi-k3 / moonshot 之类前缀，统一收敛 */
export function normalizeKimiWebModel(model: string): string {
  const raw = (model || '').trim().toLowerCase()
  const base = raw.replace(/^kimi-/, '').replace(/\[1m\]$/, '')
  if (base.startsWith('k3')) return base
  if (base.startsWith('k2')) return base
  return base || raw
}

// =====================================================================
// 上游事件 -> OpenAI 增量
// =====================================================================

interface KimiDelta {
  content?: string
  reasoning?: string
  done?: boolean
  error?: string
}

/**
 * 从一帧事件里抽增量。协议要点（见 kimi2api/app/kimi/events.py）：
 *  - mask 含 block.think  => 思考内容在 block.think.content
 *  - mask 含 block.text   => 回答内容在 block.text.content
 *  - block.text.flags 为 thinking 时，同一份 text 内容算思考不算回答
 *  - block.multiStage.stages[0].name == STAGE_NAME_THINKING 用于区分阶段
 */
function extractDelta(event: Record<string, any>): KimiDelta {
  if (!event || typeof event !== 'object') return {}
  if (event.error || event.errorMessage) {
    return { error: String(event.error || event.errorMessage), done: true }
  }

  const mask = String(event.mask || '')
  const block = (event.block || {}) as Record<string, any>

  let phase: string | null = null
  const stages = block.multiStage?.stages
  if (Array.isArray(stages) && stages.length > 0 && stages[0]?.name === 'STAGE_NAME_THINKING') {
    phase = stages[0]?.status === 'completed' ? 'answer' : 'thinking'
  }
  const flags = block.text?.flags
  if (flags === 'thinking') phase = 'thinking'
  else if (flags === 'answer') phase = 'answer'

  if (mask.includes('block.think')) {
    const content = block.think?.content
    return typeof content === 'string' && content ? { reasoning: content } : {}
  }

  const text = block.text?.content
  if (typeof text !== 'string' || !text) {
    // 结束信号：event finished / block 类型为 empty
    if (event.event === 'finished' || block.type === 'empty') return { done: true }
    return {}
  }
  if (phase === 'thinking') return { reasoning: text }
  return { content: text }
}

// =====================================================================
// OpenAI SSE 输出
// =====================================================================

function createSseSender(controller: ReadableStreamDefaultController<Uint8Array>, state: {
  id: string
  model: string
  encoder: TextEncoder
}) {
  return (delta: Record<string, any>, finish: string | null = null, usage?: { prompt: number; completion: number }) => {
    const chunk: Record<string, any> = {
      id: state.id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    }
    if (usage) {
      chunk.usage = {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion,
      }
    }
    controller.enqueue(state.encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
  }
}

function kimiEventsToOpenAIStream(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void,
): ReadableStream<Uint8Array> {
  const parser = createFrameParser()
  const state = { id: `chatcmpl-kimiweb-${randomId()}`, model: requestedModel, encoder: new TextEncoder() }
  let roleSent = false
  let finished = false
  // 上游 usage 偶尔出现在帧里，取不到就按输出字符数粗估，保证客户端有 usage 可读
  let completionTokens = 0

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = createSseSender(controller, state)
      const reader = upstream.getReader()

      const finish = (reason: string | null) => {
        if (finished) return
        finished = true
        send({}, reason || 'stop', { prompt: 0, completion: completionTokens })
        controller.enqueue(state.encoder.encode('data: [DONE]\n\n'))
        if (onUsage) onUsage({ promptTokens: 0, completionTokens })
        try { controller.close() } catch { /* already closed */ }
      }

      const handleEvent = (event: Record<string, any>) => {
        // token 用量帧
        const usage = event.usage || event.tokenUsage
        if (usage && typeof usage === 'object') {
          const n = Number((usage as any).completion_tokens ?? (usage as any).output_tokens ?? 0)
          if (n > 0) completionTokens = n
        }
        const d = extractDelta(event)
        if (!roleSent && (d.content || d.reasoning)) {
          roleSent = true
          send({ role: 'assistant', content: '' })
        }
        if (d.reasoning) {
          if (!roleSent) { roleSent = true; send({ role: 'assistant', content: '' }) }
          send({ reasoning_content: d.reasoning })
        }
        if (d.content) {
          if (!roleSent) { roleSent = true; send({ role: 'assistant', content: '' }) }
          send({ content: d.content })
          if (completionTokens === 0) completionTokens += Math.ceil(d.content.length / 4)
        }
        if (d.error) {
          send({ content: `[kimiweb] ${d.error}` }, 'stop', { prompt: 0, completion: completionTokens })
          if (onUsage) onUsage({ promptTokens: 0, completionTokens })
          controller.enqueue(state.encoder.encode('data: [DONE]\n\n'))
          finished = true
          try { controller.close() } catch { /* already closed */ }
          return
        }
        if (d.done) finish('stop')
      }

      const pump = () => {
        reader.read().then(({ done, value }) => {
          if (done) {
            if (!roleSent) send({ role: 'assistant', content: '' })
            finish('stop')
            return
          }
          for (const event of parser.feed(value)) {
            if (finished) return
            handleEvent(event)
          }
          if (!finished) pump()
        }).catch((err) => {
          if (!finished) {
            try {
              send({ content: `[kimiweb] ${(err as Error)?.message || '上游流中断'}` }, 'stop')
              controller.enqueue(state.encoder.encode('data: [DONE]\n\n'))
              controller.close()
            } catch { /* closed */ }
          }
          finished = true
        })
      }

      pump()
    },
  })
}

/** 非流式：把上游流读完再聚合成一个完整 OpenAI 响应 */
async function kimiEventsToOpenAIJson(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
): Promise<Record<string, any>> {
  const reader = upstream.getReader()
  const parser = createFrameParser()
  let content = ''
  let reasoning = ''
  let finishReason = 'stop'
  let completionTokens = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    for (const event of parser.feed(value)) {
      const d = extractDelta(event)
      if (d.reasoning) reasoning += d.reasoning
      if (d.content) content += d.content
      if (d.error) {
        return oauthErrorResponse(`Kimi Web 上游错误: ${d.error}`, 502, 'upstream_error')
      }
      if (d.done) finishReason = 'stop'
    }
  }

  if (completionTokens === 0) completionTokens = Math.ceil((content.length + reasoning.length) / 4)

  return {
    id: `chatcmpl-kimiweb-${randomId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: completionTokens,
      total_tokens: completionTokens,
    },
  }
}

// =====================================================================
// 对外入口
// =====================================================================

export async function handleKimiWebRequest(p: OAuthCallParams, baseUrl?: string): Promise<Response> {
  const tokens = (p.refreshTokens || []).map((t) => (t || '').trim()).filter(Boolean)
  if (tokens.length === 0) {
    return oauthErrorResponse(
      '该 kimiweb 渠道未配置凭据：请登录 https://www.kimi.ai 后，在浏览器 Local Storage 里取 access_token 或 refresh_token，每行一个填入「API Keys」',
      400,
      'configuration_error',
    )
  }

  const model = normalizeKimiWebModel(p.requestedModel || p.modelId)
  const messages = Array.isArray(p.body?.messages) ? (p.body.messages as OpenAIMessage[]) : []
  const prompt = flattenMessages(messages)
  if (!prompt) {
    return oauthErrorResponse('messages 内容为空，无法转发', 400, 'invalid_request_error')
  }

  const stream = p.body?.stream === true
  const enableWebSearch = Boolean(p.body?.web_search || p.body?.enable_web_search)
  const payload = buildChatPayload(model, prompt, enableWebSearch)
  const body = encodeFrame(payload)

  let lastError = ''
  let lastStatus = 502

  // 多凭据轮询：任一账号 401/403/429/5xx 就换下一个
  for (const rawToken of tokens) {
    const fp = buildFingerprint(baseUrl)
    try {
      const accessToken = await getWebAccessToken(p.env, fp, rawToken)
      const upstream = await fetch(`${fp.baseUrl}${CHAT_PATH}`, {
        method: 'POST',
        headers: webHeaders(fp, accessToken, {
          'Content-Type': 'application/connect+json',
        }),
        body: body as unknown as BodyInit,
        signal: AbortSignal.timeout(KIMI_WEB_TIMEOUT_MS),
      })

      if (!upstream.ok) {
        lastStatus = upstream.status
        lastError = `HTTP ${upstream.status}: ${(await readErrorBody(upstream)).slice(0, 300)}`
        if ([401, 403, 429].includes(upstream.status) || upstream.status >= 500) continue
        return oauthErrorResponse(lastError, upstream.status, 'upstream_error')
      }

      if (!upstream.body) {
        return oauthErrorResponse('Kimi Web 上游未返回响应体', 502, 'upstream_error')
      }

      if (stream && upstream.body) {
        // 流式必须原样透传：任何缓冲都会让客户端表现为长时间无响应后重连
        const [toClient, forUsage] = upstream.body.tee()
        const reader = forUsage.getReader()
        defer(p, (async () => {
          // 后台把流读完，只为记 usage；不阻塞客户端
          let completion = 0
          const parser = createFrameParser()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            for (const ev of parser.feed(value)) {
              const usage = (ev.usage || ev.tokenUsage) as any
              const n = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0)
              if (n > 0) completion = n
            }
          }
          await recordOAuthUsage(p, { promptTokens: 0, completionTokens: completion }, true, 200)
        })().catch(() => {}))

        const sse = kimiEventsToOpenAIStream(toClient, p.requestedModel)
        return new Response(sse, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          },
        })
      }

      const json = await kimiEventsToOpenAIJson(upstream.body, p.requestedModel)
      defer(p, recordOAuthUsage(p, {
        promptTokens: Number(json.usage?.prompt_tokens) || 0,
        completionTokens: Number(json.usage?.completion_tokens) || 0,
      }, true, 200))
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    } catch (err) {
      lastError = (err as Error).message || '未知错误'
      lastStatus = 502
      continue
    }
  }

  return oauthErrorResponse(
    `所有 Kimi 账号均失败，最后一次错误: ${lastError || '未知'}`,
    lastStatus,
    'key_exhausted',
  )
}

// =====================================================================
// 后台：连通性测试
// =====================================================================

export async function testKimiWeb(
  env: Env,
  rawToken: string,
  modelId: string,
  baseUrl?: string,
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  if (!rawToken) return { success: false, message: '未填写 token', statusCode: 0 }
  const fp = buildFingerprint(baseUrl)
  try {
    const accessToken = await getWebAccessToken(env, fp, rawToken)
    const res = await fetch(`${fp.baseUrl}${CHAT_PATH}`, {
      method: 'POST',
      headers: webHeaders(fp, accessToken, {
        'Content-Type': 'application/connect+json',
      }),
      body: encodeFrame(buildChatPayload(modelId, 'hi', false)) as unknown as BodyInit,
      signal: AbortSignal.timeout(120000),
    })
    if (res.ok) {
      // 读完丢弃，避免连接悬挂
      try { await res.arrayBuffer() } catch { /* ignore */ }
      return { success: true, message: '连接成功', statusCode: 200 }
    }
    return { success: false, message: `HTTP ${res.status}: ${(await readErrorBody(res)).slice(0, 200)}`, statusCode: res.status }
  } catch (err) {
    return { success: false, message: (err as Error).message || '连接失败' }
  }
}