import type { ApiKeyEntry, Env } from './types'
import {
  OPENCODE_COMPAT_HEAD,
  OPENCODE_COMPAT_TAIL,
  OPENCODE_TITLE_MARKER,
  OPENCODE_CLI_MARKER,
  OPENCODE_OFFICIAL_TOOLS,
  buildOpenCodeEnvBlock,
} from './opencode-compat'

export const OPENCODE_PROVIDER_ID = 'opencode'

// 上游服务端按 OpenCode 客户端指纹校验免费层请求（FreeTierError）。
// 2026-10-27 第四轮实测定案：免费池有三道门禁 ——
//   1) system 里必须含 <env> 块（Working directory / Workspace root folder 均为 /workspace）；
//   2) body 必须声明官方 11 工具；
//   3) TLS ClientHello 必须是 Bun/BoringSSL 的 17-cipher 列表（JA4 cipher hash 5b57614c22b0）。
// 门禁 3 平台自开 TLS 无法满足，只有 Node/Bun 运行时能控制，故由 Koyeb（Bun）做 TLS 中继。
// UA 为 `opencode/prod/2.1.4/cli`；2.x 已移除 x-opencode-request，会话四件套同值。
const OPENCODE_VERSION = '2.1.4'
const OPENCODE_CHANNEL = 'prod'
// 免费层模型出字慢，流式响应可能持续数分钟；超时过短会在生成中途掐断连接，客户端表现为「重新连接」
const OPENCODE_TIMEOUT_MS = 300000

const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function randomBase62(length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let result = ''
  for (let i = 0; i < length; i++) {
    result += BASE62_CHARS[bytes[i] % 62]
  }
  return result
}

let lastTimestamp = 0
let idCounter = 0

/**
 * 生成 OpenCode 风格 id（对齐官方 packages/schema/src/identifier.ts）：
 * `ses_` 用**倒序**时间戳（按位取反，高位呈 ecb... 特征，用于会话列表最新置顶），
 * `msg_` 用正序时间戳（高位呈 13x... 特征）。上游按前缀校验格式，倒序/正序写反会被判非法客户端。
 */
function createOpenCodeId(prefix: string, descending = false): string {
  const currentTimestamp = Date.now()
  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    idCounter = 0
  }
  idCounter++

  const current = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(idCounter)
  const value = descending ? ~current : current
  let hex = ''
  for (let i = 0; i < 6; i++) {
    const byte = Number((value >> BigInt(40 - 8 * i)) & BigInt(0xff))
    hex += byte.toString(16).padStart(2, '0')
  }

  return `${prefix}_${hex}${randomBase62(14)}`
}

// 免费层内容闸门（详见 opencode-compat.ts）：system 必须含官方 prompt 片段 **且** 含 <env> 块；
// tools 必须以官方 11 工具开头。注入块每次按当前日期重建（<env> 里的 Today's date）。
function buildCompatBlock(marker: string): string {
  return `${OPENCODE_COMPAT_HEAD}\n${marker}\n${buildOpenCodeEnvBlock()}\n${OPENCODE_COMPAT_TAIL}`
}

interface OpenCodeRequestOptions {
  baseUrl: string
  apiKeys: ApiKeyEntry[]
  method: string
  subPath: string
  mirrorUrls: string[]
  search?: string
  body?: string
  fetcher?: typeof fetch
  random?: () => number
  /** 门禁3 中继：平台自开 TLS 时（Pages / EdgeOne）改由能控制 ClientHello 的节点代发。 */
  relay?: OpenCodeRelayConfig | null
}

export interface OpenCodeRelayConfig {
  url: string
  token: string
}

/**
 * TLS 中继令牌。Pages / EdgeOne 的出口 TLS 由平台决定，拿不到 Bun 的 17-cipher
 * 指纹，必然 429；把请求转给跑在 Bun 上的 Koyeb 端代发。可用环境变量覆盖。
 */
export const OPENCODE_RELAY_TOKEN_DEFAULT = 'oc_relay_2f4c8a1d6b9e3f70c5a2d84b1e6f9073'

/** 读取 OPENCODE_RELAY_URL 配置；未配置返回 null（表示直连官方源站）。 */
export function resolveOpenCodeRelay(env: Env): OpenCodeRelayConfig | null {
  const url = (env.OPENCODE_RELAY_URL || '').trim()
  if (!url) return null
  return {
    url: url.replace(/\/+$/, ''),
    token: (env.OPENCODE_RELAY_TOKEN || '').trim() || OPENCODE_RELAY_TOKEN_DEFAULT,
  }
}

interface StoredFailure {
  status: number
  statusText: string
  headers: Headers
  body: ArrayBuffer
}

export interface OpenCodeTestResult {
  success: boolean
  message: string
  statusCode?: number
  data?: unknown
}

export function isOpenCodeProvider(providerId: string): boolean {
  return providerId === OPENCODE_PROVIDER_ID
}

export function filterOpenCodeModels<T extends { id?: unknown }>(models: T[]): T[] {
  return models.filter((model) => (
    typeof model.id === 'string'
    && /^[A-Za-z0-9._:/-]+$/.test(model.id)
    && (model.id === 'big-pickle' || model.id.endsWith('-free'))
  ))
}

function parseMirrorUrlList(items: string[]): string[] {
  const parts = items
    .flatMap(s => typeof s === 'string' ? s.split('\n') : [])
    .flatMap(s => s.split(','))
    .map(s => s.trim())
    .filter(s => Boolean(s) && !s.includes('gcore.cmliussss.net'))
  return [...new Set(parts)]
}

export function resolveOpenCodeUrls(env: Env): string[] {
  const raw = env.OPENCODE_MIRRORS_URL || ''
  return parseMirrorUrlList([raw])
}

/**
 * 解析提供商生效的 OpenCode 镜像地址：
 * 优先使用后台配置的 provider.mirrorUrls, 为空时回退 OPENCODE_MIRRORS_URL 环境变量。
 */
export function resolveProviderMirrorUrls(env: Env, provider?: { mirrorUrls?: string[] }): string[] {
  if (provider?.mirrorUrls && provider.mirrorUrls.length > 0) {
    const urls = parseMirrorUrlList(provider.mirrorUrls)
    if (urls.length > 0) return urls
  }
  return resolveOpenCodeUrls(env)
}

function getMirrorOrder(urls: string[], random: () => number): string[] {
  if (urls.length === 0) return []
  const start = Math.floor(random() * urls.length)
  return [
    ...urls.slice(start),
    ...urls.slice(0, start),
  ]
}

function buildUrl(baseUrl: string, subPath: string, search = ''): string {
  // 官方源站（opencode.ai）最新 2.1.4 体系的 OpenAI 兼容端点在 /inference/openai/v1；
  // 第三方镜像源（如 cmliussss）通常保持 /zen/v1 代理。
  const isOfficial = /https?:\/\/opencode\.ai(?::\d+)?(?=\/|$)/i.test(baseUrl)
  const normalized = isOfficial
    ? baseUrl.replace(/\/zen\/v1(?=\/|$)/, '/inference/openai/v1').replace(/\/inference\/v1(?=\/|$)/, '/inference/openai/v1')
    : baseUrl
  return `${normalized.replace(/\/+$/, '')}/${subPath.replace(/^\/+/, '')}${search}`
}

// 幂等探测：用 marker 前 80 字符判断请求里是否已含对应标记
const OPENCODE_TITLE_PROBE = OPENCODE_TITLE_MARKER.slice(0, 80)
const OPENCODE_CLI_PROBE = OPENCODE_CLI_MARKER.slice(0, 80)

/** 官方工具集比对键：name + parameters（两者是上游校验依据，description 不参与）。 */
function officialToolKey(tool: any): string {
  return `${tool?.function?.name ?? tool?.name}:${JSON.stringify(tool?.function?.parameters)}`
}

/** 幂等地把免费层兼容标记注入 messages（system 文本；缺失 system 时插到最前）。 */
function injectCompatMarker(messages: any[], block: string, probe: string): void {
  const containsProbe = (value: unknown): boolean =>
    typeof value === 'string' && value.includes(probe)

  const already = messages.some((message: any) => {
    if (!message) return false
    if (containsProbe(message.content)) return true
    if (Array.isArray(message.content)) {
      return message.content.some((part: any) => containsProbe(part?.text))
    }
    return false
  })
  if (already) return

  const systemMessage = messages.find((message: any) => message && message.role === 'system')
  if (systemMessage) {
    if (typeof systemMessage.content === 'string') {
      systemMessage.content = `${systemMessage.content}\n\n${block}`
      return
    }
    if (Array.isArray(systemMessage.content)) {
      systemMessage.content.push({ type: 'text', text: block })
      return
    }
  }
  messages.unshift({ role: 'system', content: block })
}

/**
 * 免费层兼容处理（详见 opencode-compat.ts）。上游两道独立闸门，缺一即 429：
 * - 门禁 1：system 含 <env> 块（Working directory / Workspace root folder = /workspace）；
 * - 门禁 2：body 声明 tools，且以官方 11 工具（name + parameters 原样）开头。
 * 因此**所有** chat 请求都注入 CLI 提示词片段 + <env>，并前置官方工具集；
 * 客户端本来不带工具时补 tool_choice='none'，避免模型真去调用这些占位定义。
 * 幂等：重复调用（重试/客户端已注入）不会二次追加。
 */
export function ensureOpenCodeCompat(payload: any): void {
  const messages = Array.isArray(payload?.messages) ? payload.messages : null
  if (!messages || messages.length === 0) return

  const tools = Array.isArray(payload.tools) ? payload.tools as any[] : []
  const hasClientTools = tools.length > 0
  // 客户端工具与官方工具同名时，上游会以 "must not be specified more than once" 400 拒绝，
  // 因此这里剔除客户端的重名项（官方定义必须保留，它是免费层校验依据）。
  const officialNames = new Set(OPENCODE_OFFICIAL_TOOLS.map((tool) => tool.function.name))
  const clientTools = tools.filter((tool) => !officialNames.has(tool?.function?.name ?? tool?.name))
  const alreadyPrepended =
    clientTools.length === tools.length &&
    tools.length >= OPENCODE_OFFICIAL_TOOLS.length &&
    OPENCODE_OFFICIAL_TOOLS.every((official, index) => officialToolKey(tools[index]) === officialToolKey(official))
  if (!alreadyPrepended) {
    payload.tools = [...OPENCODE_OFFICIAL_TOOLS.map((tool) => JSON.parse(JSON.stringify(tool))), ...clientTools]
  }
  if (!hasClientTools && payload.tool_choice === undefined) {
    payload.tool_choice = 'none'
  }

  injectCompatMarker(messages, buildCompatBlock(OPENCODE_CLI_MARKER), OPENCODE_CLI_PROBE)
}

function createRequestHeaders(apiKey: string, sessionId: string, relayToken?: string): Headers {
  // 2.x 客户端指纹：UA = opencode/prod/2.1.4/cli；会话头四件套必须同值
  // （x-opencode-session / x-opencode-session-id / x-session-affinity / x-session-id）；
  // x-opencode-request 在 2.x 已移除，带上反而会被判成非官方客户端。
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'User-Agent': `opencode/${OPENCODE_CHANNEL}/${OPENCODE_VERSION}/cli`,
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
    'x-opencode-session': sessionId,
    'x-opencode-session-id': sessionId,
    'x-session-affinity': sessionId,
    'x-session-id': sessionId,
    'TypeSafe-Danger-Zone-Images': 'true',
  })
  if (relayToken) headers.set('x-opencode-relay-token', relayToken)
  return headers
}

async function storeFailure(response: Response): Promise<StoredFailure> {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
    body: await response.arrayBuffer(),
  }
}

function restoreFailure(failure: StoredFailure): Response {
  return new Response(failure.body, {
    status: failure.status,
    statusText: failure.statusText,
    headers: failure.headers,
  })
}

function transportErrorResponse(error: unknown): Response {
  const message = error instanceof Error && error.message ? error.message : 'OpenCode 上游请求失败'
  return new Response(JSON.stringify({
    error: { message, type: 'proxy_error' },
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

const OPENCODE_CIPHER_LIST = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-ECDSA-AES128-SHA',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-ECDSA-AES256-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA',
].join(':')

let cachedWreq: any = null
let cachedTransport: any = null

async function getWreqModule() {
  if (cachedWreq !== null) return cachedWreq
  try {
    const mod = await import('wreq-js')
    const createTransport = mod.createTransport || mod.default?.createTransport
    const fetchFn = mod.fetch || mod.default?.fetch
    cachedTransport = await createTransport({
      emulation: { tlsOptions: { cipherList: OPENCODE_CIPHER_LIST } },
      readTimeout: 300000,
    })
    cachedWreq = { ...mod, createTransport, fetch: fetchFn }
  } catch {
    cachedWreq = false
  }
  return cachedWreq
}

async function requestUpstream(
  fetcher: typeof fetch,
  url: string,
  apiKey: string,
  options: OpenCodeRequestOptions,
  sessionId: string,
  relayToken?: string
): Promise<Response> {
  const wreq = await getWreqModule()
  if (wreq && !relayToken) {
    // EdgeOne 原生模式：直接在 Node.js 20 容器内下发 Bun 17-cipher ClientHello 直连官方源站
    const reqHeaders: Record<string, string> = {}
    createRequestHeaders(apiKey, sessionId).forEach((val, key) => {
      reqHeaders[key] = val
    })
    const upstream = await wreq.fetch(url, {
      method: options.method,
      headers: reqHeaders,
      body: options.method === 'GET' || options.method === 'HEAD' ? undefined : options.body,
      transport: cachedTransport,
      timeout: OPENCODE_TIMEOUT_MS,
    })
    const respHeaders = new Headers()
    if (upstream.headers && typeof upstream.headers.forEach === 'function') {
      upstream.headers.forEach((val: string, key: string) => {
        const lower = key.toLowerCase()
        if (lower !== 'content-length' && lower !== 'content-encoding') {
          respHeaders.set(key, val)
        }
      })
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    })
  }

  return fetcher(url, {
    method: options.method,
    headers: createRequestHeaders(apiKey, sessionId, relayToken),
    body: options.method === 'GET' || options.method === 'HEAD' ? undefined : options.body,
    signal: AbortSignal.timeout(OPENCODE_TIMEOUT_MS),
  })
}

async function aggregateOpenCodeStream(response: Response, modelId: string): Promise<Response> {
  const rawText = await response.text()
  let content = ''
  let reasoning = ''
  let id = ''
  let finishReason = 'stop'
  let promptTokens = 0
  let completionTokens = 0
  const toolCallsMap = new Map<number, any>()

  for (const rawLine of rawText.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('data:')) continue
    const dataStr = line.slice(5).trim()
    if (!dataStr || dataStr === '[DONE]') continue
    try {
      const chunk = JSON.parse(dataStr)
      if (chunk.id) id = chunk.id
      const choice = chunk.choices?.[0]
      const delta = choice?.delta
      if (delta?.content) content += delta.content
      if (delta?.reasoning_content) reasoning += delta.reasoning_content
      if (choice?.finish_reason) finishReason = choice.finish_reason

      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0
          if (!toolCallsMap.has(idx)) {
            toolCallsMap.set(idx, {
              id: tc.id || `call_${idx}`,
              type: tc.type || 'function',
              function: {
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || '',
              },
            })
          } else {
            const existing = toolCallsMap.get(idx)
            if (tc.id) existing.id = tc.id
            if (tc.function?.name) existing.function.name += tc.function.name
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
          }
        }
      }

      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens || promptTokens
        completionTokens = chunk.usage.completion_tokens || completionTokens
      }
    } catch {}
  }

  const toolCalls = Array.from(toolCallsMap.values())

  const jsonResp = {
    id: id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || null,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }

  return new Response(JSON.stringify(jsonResp), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

function sanitizeFailureResponse(failure: StoredFailure): Response {
  const contentType = failure.headers.get('content-type') || ''
  const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml')

  if (isHtml || failure.status === 404) {
    try {
      const text = new TextDecoder().decode(failure.body).trim()
      if (
        text.startsWith('<!DOCTYPE html>') ||
        text.startsWith('<html') ||
        text.includes('<html') ||
        text.includes('og:image') ||
        text.includes('<title>')
      ) {
        const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i)
        const title = titleMatch ? titleMatch[1].trim() : '页面未找到'
        const friendlyMessage = `OpenCode 上游返回 HTML 页面（HTTP ${failure.status}: ${title}），官方/镜像源站可能暂时抖动或未开放该路径`
        return new Response(JSON.stringify({
          error: {
            message: friendlyMessage,
            type: 'upstream_error',
            status: failure.status,
          },
        }), {
          status: failure.status === 404 ? 502 : failure.status,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        })
      }
    } catch {}
  }

  return restoreFailure(failure)
}

function formatOpenCodeErrorMessage(status: number, rawBody: string): string {
  const text = (rawBody || '').trim()
  if (!text) return `HTTP ${status}: 空响应`

  if (
    text.startsWith('<!DOCTYPE html>') ||
    text.startsWith('<html') ||
    text.includes('<html') ||
    text.includes('og:image') ||
    text.includes('<title>')
  ) {
    const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i)
    const title = titleMatch ? titleMatch[1].trim() : '页面未找到'
    return `HTTP ${status}: 上游返回 HTML 页面（${title}），疑似官方或镜像源站服务抖动`
  }

  try {
    const parsed = JSON.parse(text)
    if (parsed.error?.message) return `HTTP ${status}: ${parsed.error.message}`
    if (parsed.message) return `HTTP ${status}: ${parsed.message}`
  } catch {}

  return `HTTP ${status}: ${text.substring(0, 200)}`
}

function selectRepresentativeFailure(official: StoredFailure | null, mirror: StoredFailure | null): StoredFailure | null {
  if (!mirror) return official
  if (!official) return mirror

  // 如果官方源站返回了具体业务语义的状态码（429 免费额度用尽/限流、401/403 鉴权、400/410 模型下线/弃用），
  // 而镜像返回的是通用的 404/502/HTML 页面，优先使用官方真实错误，避免被反代探测失败覆盖
  const isSpecificCode = (status: number) => [400, 401, 403, 410, 429].includes(status)
  if (isSpecificCode(official.status) && !isSpecificCode(mirror.status)) {
    return official
  }

  return mirror || official
}

export async function proxyOpenCodeRequest(options: OpenCodeRequestOptions): Promise<Response> {
  const fetcher = options.fetcher ?? fetch
  const random = options.random ?? Math.random
  const sessionId = createOpenCodeId('ses', true)
  let officialFailure: StoredFailure | null = null
  let mirrorFailure: StoredFailure | null = null
  let lastTransportError: unknown = null

  // 预处理 POST chat/completions 请求体：适配 OpenCode 免费层规则（强制 stream + 官方指纹注入）
  let clientWantsStream = true
  let upstreamBody = options.body
  let requestedModel = ''

  if (options.body && options.method === 'POST' && options.subPath.includes('chat/completions')) {
    try {
      const parsed = JSON.parse(options.body) as Record<string, any>
      if (parsed && typeof parsed === 'object') {
        requestedModel = typeof parsed.model === 'string' ? parsed.model : ''
        clientWantsStream = parsed.stream !== false && parsed.stream !== undefined
        // 强制开启 stream 与 usage 统计，完全对齐官方客户端
        parsed.stream = true
        if (!parsed.stream_options) {
          parsed.stream_options = { include_usage: true }
        }

        // 免费层内容闸门：system 注入官方 prompt 片段；带 tools 时前置官方工具定义（详见 opencode-compat.ts）
        ensureOpenCodeCompat(parsed)
        upstreamBody = JSON.stringify(parsed)
      }
    } catch {
      // 保持原样
    }
  }

  const upstreamOptions: OpenCodeRequestOptions = {
    ...options,
    body: upstreamBody,
  }

  const enabledKeys = options.apiKeys.filter((entry) => entry.enabled && entry.key)
  const officialUrl = buildUrl(options.baseUrl, options.subPath, options.search)

  // 门禁3：出口 TLS 由平台决定的端（Pages / EdgeOne）走 TLS 中继，交给 Bun 节点代发。
  // 官方源站与镜像在这种出口上必然 429，不再浪费往返。
  if (options.relay && options.relay.url) {
    try {
      const response = await requestUpstream(
        fetcher,
        buildUrl(options.relay.url, options.subPath, options.search),
        'public',
        upstreamOptions,
        sessionId,
        options.relay.token
      )
      if (response.ok) {
        if (!clientWantsStream && (response.headers.get('content-type') || '').includes('text/event-stream')) {
          return aggregateOpenCodeStream(response, requestedModel)
        }
        return response
      }
      return sanitizeFailureResponse(await storeFailure(response))
    } catch (error) {
      return transportErrorResponse(error)
    }
  }

  if (enabledKeys.length > 0) {
    for (const entry of enabledKeys) {
      try {
        const response = await requestUpstream(
          fetcher,
          officialUrl,
          entry.key,
          upstreamOptions,
          sessionId
        )
        if (response.ok) {
          if (!clientWantsStream && (response.headers.get('content-type') || '').includes('text/event-stream')) {
            return aggregateOpenCodeStream(response, requestedModel)
          }
          return response
        }

        officialFailure = await storeFailure(response)
        if (response.status !== 401 && response.status !== 403 && response.status !== 429) break
      } catch (error) {
        lastTransportError = error
        break
      }
    }
  } else {
    // 未配置自定义 Key 时：官方源站（带 'public'）本身也是可用节点，优先尝试官方
    try {
      const response = await requestUpstream(
        fetcher,
        officialUrl,
        'public',
        upstreamOptions,
        sessionId
      )
      if (response.ok) {
        if (!clientWantsStream && (response.headers.get('content-type') || '').includes('text/event-stream')) {
          return aggregateOpenCodeStream(response, requestedModel)
        }
        return response
      }
      officialFailure = await storeFailure(response)
    } catch (error) {
      lastTransportError = error
    }
  }

  for (const mirror of getMirrorOrder(options.mirrorUrls, random)) {
    try {
      const response = await requestUpstream(
        fetcher,
        buildUrl(mirror, options.subPath, options.search),
        'public',
        upstreamOptions,
        sessionId
      )
      if (response.ok) {
        if (!clientWantsStream && (response.headers.get('content-type') || '').includes('text/event-stream')) {
          return aggregateOpenCodeStream(response, requestedModel)
        }
        return response
      }
      mirrorFailure = await storeFailure(response)
    } catch (error) {
      lastTransportError = error
    }
  }

  const finalFailure = selectRepresentativeFailure(officialFailure, mirrorFailure)
  if (finalFailure) return sanitizeFailureResponse(finalFailure)
  return transportErrorResponse(lastTransportError)
}

export async function testOpenCodeModel(
  baseUrl: string,
  apiKeys: ApiKeyEntry[],
  modelId: string,
  mirrorUrls: string[],
  fetcher?: typeof fetch,
  relay?: OpenCodeRelayConfig | null
): Promise<OpenCodeTestResult> {
  const response = await proxyOpenCodeRequest({
    baseUrl,
    apiKeys,
    mirrorUrls,
    method: 'POST',
    subPath: 'chat/completions',
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 32,
    }),
    fetcher,
    relay,
  })

  if (response.ok) {
    return { success: true, message: '连接成功', statusCode: response.status }
  }

  const body = await response.text()
  return {
    success: false,
    message: formatOpenCodeErrorMessage(response.status, body),
    statusCode: response.status,
  }
}

export async function fetchOpenCodeModels(
  baseUrl: string,
  apiKeys: ApiKeyEntry[],
  mirrorUrls: string[],
  fetcher?: typeof fetch,
  relay?: OpenCodeRelayConfig | null
): Promise<OpenCodeTestResult> {
  const response = await proxyOpenCodeRequest({
    baseUrl,
    apiKeys,
    mirrorUrls,
    method: 'GET',
    subPath: 'models',
    fetcher,
    relay,
  })

  if (!response.ok) {
    const body = await response.text()
    return {
      success: false,
      message: formatOpenCodeErrorMessage(response.status, body),
      statusCode: response.status,
    }
  }

  try {
    const data = await response.json() as { data?: Array<{ id?: unknown }> }
    return {
      success: true,
      message: '连接成功',
      statusCode: response.status,
      data: {
        ...data,
        data: Array.isArray(data.data) ? filterOpenCodeModels(data.data) : [],
      },
    }
  } catch (err) {
    return {
      success: false,
      message: `上游返回非 JSON 响应: ${(err as Error).message || '解析失败'}`,
      statusCode: response.status,
    }
  }
}
