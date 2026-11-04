/**
 * Gemini 网页版反代 (provider.type = 'geminiweb')
 *
 * 移植本机 gw2a-original（goehou/gemini-web2api）的 cloudflare/worker.js 协议实现，
 * 按网关既有 OAuth 渠道结构改写：
 *  1. 凭据是 gemini.google.com 网页会话的 Cookie（__Secure-1PSID / __Secure-3PSID / SAPISID）。
 *     渠道 apiKeys 每行一个账号，可放多账号轮换。没 Cookie 也能走匿名（模型受限）。
 *  2. 鉴权用 Google Web 的 SAPISIDHASH：SHA-1(时间戳 + ' ' + SAPISID + ' ' + origin)，
 *     格式 `SAPISIDHASH {ts}_{hex}`，每请求重新计算。
 *  3. 请求体是 Gemini 前端的私有双层数组协议（外层 [null, 内层JSON字符串]，
 *     URL 编码进 f.req 参数）；模型靠 inner[79] 的 MODE_CATEGORY 数字选择。
 *  4. 响应是一行行 `)]}'` + 嵌套数组，文本藏在 arr[0][2] 解析后的 inner[4][*][1][] 里，
 *     且是累积快照 —— 靠「当前全量 - 上次全量」算增量，转成 OpenAI SSE。
 *  5. BL(build label) 会过期（405/400），从 /app 页面自动抓取并缓存，失败自动刷新重试。
 *
 * 与 type=antigravity（Google Antigravity OAuth，走官方 daily-cloudcode-pa）是两套独立体系，
 * 凭据不通用：本渠道用网页 Cookie，antigravity 用 OAuth refresh_token。
 */

import type { Env } from '../types'
import { getKV } from '../storage/blob-store'
import { rawFetch } from './socket'
import {
  type OAuthCallParams,
  oauthErrorResponse,
  randomId,
  recordOAuthUsage,
  defer,
} from '../oauth/common'

const GEMINI_BASE = 'https://gemini.google.com'
const BL_PAGE_URL = `${GEMINI_BASE}/app`
const STREAM_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'
/** 兜底 BL：页面抓取失败时先用这个，能省掉一次额外请求 */
const BL_FALLBACK = 'boq_gemini-web-uiserver_20261007.01_p0'
const BL_TTL_MS = 60 * 60 * 1000
const GEMINI_TIMEOUT_MS = 120000

const BL_KV_KEY = 'geminiweb:bl'

// ===== 浏览器指纹池（对齐 worker.js 的多指纹轮换） =====
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
]
const LANG_POOL = ['en-US,en;q=0.9', 'en', 'en-GB,en;q=0.9']
const BL_REGEX_PRIMARY = /boq_assistant-bard-web-server_\d{8}\.\d+(_p\d+)?/
const BL_REGEX_CFB2H = /"cfb2h"\s*:\s*"(boq_[a-z0-9\-]+_\d{8}\.\d+(_p\d+)?)"/

// =====================================================================
// 模型表：mode 即 Gemini 前端的 MODE_CATEGORY
//   1=FAST 2=THINKING 3=PRO 4=AUTO 5=FAST_DYNAMIC_THINKING 6=FLASH_LITE
//   think: 0=关 4=自动（数值越大思考越深）
// =====================================================================

export interface GeminiWebModelSpec {
  mode: number
  think: number
  desc: string
}

export const GEMINI_WEB_MODELS: Record<string, GeminiWebModelSpec> = {
  'gemini-3.7-flash': { mode: 1, think: 4, desc: 'Latest all-around model' },
  'gemini-3.6-flash': { mode: 1, think: 4, desc: 'All-around model' },
  'gemini-3.5-flash': { mode: 1, think: 4, desc: 'Alias of 3.6-flash' },
  'gemini-3.5-flash-thinking': { mode: 2, think: 0, desc: 'Deep thinking, longest output' },
  'gemini-3.1-pro': { mode: 3, think: 4, desc: 'Pro model (needs cookie for real routing)' },
  'gemini-auto': { mode: 4, think: 4, desc: 'Auto model selection' },
  'gemini-3.5-flash-thinking-lite': { mode: 5, think: 0, desc: 'Dynamic thinking, adaptive depth' },
  'gemini-flash-lite': { mode: 6, think: 4, desc: 'Lightweight fast model' },
}

/**
 * 模型名解析，支持 `@think=N` 覆盖思考深度（沿用 worker.js 的约定）。
 * 未知模型退回 gemini-auto，避免整条渠道因一个模型名不可用而瘫掉。
 */
export function resolveGeminiWebModel(modelName: string): { model: string; spec: GeminiWebModelSpec; error?: string } {
  const raw = (modelName || '').trim()
  let actual = raw
  let thinkOverride: number | null = null
  if (raw.includes('@think=')) {
    const idx = raw.indexOf('@think=')
    actual = raw.slice(0, idx)
    const parsed = parseInt(raw.slice(idx + '@think='.length), 10)
    if (Number.isNaN(parsed)) {
      return { model: actual, spec: GEMINI_WEB_MODELS['gemini-auto'], error: `无效的 think 参数: ${raw.slice(idx + 7)}` }
    }
    thinkOverride = parsed
  }
  const spec = GEMINI_WEB_MODELS[actual]
  if (!spec) {
    return { model: actual, spec: GEMINI_WEB_MODELS['gemini-auto'] }
  }
  return {
    model: actual,
    spec: thinkOverride === null ? spec : { ...spec, think: thinkOverride },
  }
}

// =====================================================================
// 凭据：Cookie 字符串 + SAPISID
// =====================================================================

interface Account {
  cookie: string
  sapisid: string
}

/** 从 Cookie 串里抠出 SAPISID（用户常直接粘整串 Cookie） */
function extractSapisid(cookie: string): string {
  const m = cookie.match(/SAPISID=([^;]+)/)
  return m ? m[1].trim() : ''
}

/**
 * 解析渠道 apiKeys。每行一个账号，支持三种写法：
 *   1) 纯 Cookie 串（含 SAPISID=xxx）
 *   2) Cookie 串 + '|' + SAPISID（cookie 里没带 SAPISID 时）
 *   3) 只有 SAPISID（网关只拿它算 hash，不带 Cookie，走半匿名）
 */
function parseAccounts(entries: string[]): Account[] {
  const out: Account[] = []
  for (const raw of entries) {
    const line = (raw || '').trim()
    if (!line) continue
    const [cookiePart, sapisidPart] = line.split('|')
    const cookie = (cookiePart || '').trim()
    const sapisid = (sapisidPart || extractSapisid(cookie)).trim()
    if (cookie || sapisid) out.push({ cookie, sapisid })
  }
  return out
}

/** Google Web 的时间戳哈希鉴权 */
async function makeSapisidHash(sapisid: string): Promise<string> {
  const ts = Math.floor(Date.now() / 1000)
  const input = `${ts} ${sapisid} ${GEMINI_BASE}`
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input))
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `SAPISIDHASH ${ts}_${hex}`
}

// =====================================================================
// BL(build label) 抓取与缓存
// =====================================================================

async function fetchLatestBL(cookie?: string): Promise<string> {
  const headers: Record<string, string> = {
    'User-Agent': UA_POOL[Math.floor(Math.random() * UA_POOL.length)],
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': LANG_POOL[Math.floor(Math.random() * LANG_POOL.length)],
  }
  // 带 Cookie 抓：匿名抓 /app 可能被重定向到人机验证页
  if (cookie) headers['Cookie'] = cookie

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    // /app 页面同样走裸 socket：标准 fetch 会被重定向到人机验证页
    const resp = await rawFetch(BL_PAGE_URL, { headers, timeoutMs: 8000, signal: ctrl.signal })
    const html = await resp.text()
    // 登录态页面直接暴露 bard-web-server 标签；匿名页只有 cfb2h 字段（实测同样能当 bl 用）
    const primary = html.match(BL_REGEX_PRIMARY)
    if (primary) return primary[0]
    const cfb2h = html.match(BL_REGEX_CFB2H)
    if (cfb2h && cfb2h[1]) return cfb2h[1]
    return BL_FALLBACK
  } catch {
    return BL_FALLBACK
  } finally {
    clearTimeout(timer)
  }
}

async function getBL(env: Env, cookie?: string, force = false): Promise<string> {
  const kv = getKV(env)
  if (!force) {
    const cached = await kv.get(BL_KV_KEY)
    if (cached) return cached
  }
  const bl = await fetchLatestBL(cookie)
  await kv.put(BL_KV_KEY, bl, { expirationTtl: Math.floor(BL_TTL_MS / 1000) }).catch(() => {
    // KV 不可用时退化为每次重抓，不影响功能
  })
  return bl
}

// =====================================================================
// 请求体：Gemini 前端私有双层数组协议
// =====================================================================

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16)
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function buildFormBody(prompt: string, mode: number, think: number): string {
  const inner: unknown[] = new Array(80).fill(null)
  inner[0] = [prompt, 0, null, null, null, null, 0]  // 用户消息
  inner[1] = ['en']                                  // 语言
  inner[2] = ['', '', '', null, null, null, null, null, null, '']  // 上下文（空=新对话）
  inner[6] = [0]                                    // 连续对话标志
  inner[7] = 1                                      // 流式
  inner[10] = 1
  inner[11] = 0                                     // 安全过滤级别
  inner[17] = [[think]]                             // 思考深度
  inner[18] = 0
  inner[27] = 1
  inner[30] = [4]
  inner[41] = [2]
  inner[53] = 0
  inner[59] = generateUUID()
  inner[61] = []
  inner[68] = 1
  inner[79] = mode                                  // ⭐ 模型选择

  const params = new URLSearchParams()
  params.append('f.req', JSON.stringify([null, JSON.stringify(inner)]))
  return params.toString()
}

function buildStreamUrl(bl: string, prefix: string): string {
  const reqid = Math.floor(Date.now() / 1000) % 1000000
  return `${GEMINI_BASE}${prefix}${STREAM_PATH}?bl=${encodeURIComponent(bl)}&hl=en&_reqid=${reqid}&rt=c`
}

/** 多账号：Google 允许一个浏览器登录多个账号，URL 带 /u/N 前缀 */
function accountPrefix(cookie: string): string {
  const m = cookie.match(/__Secure-1PSID\s*=\s*(\d+)/)
  if (!m) return ''
  const sid = m[1]
  // sid 以 "0" 开头的是默认账号（Google 用 0/1/2 索引多账号）
  return sid.startsWith('0') ? '' : `/u/${sid.charAt(0)}`
}

// =====================================================================
// 响应解析
// =====================================================================

/** 提取一行里的累积文本；取不到返回 null */
function extractLineText(line: string): string | null {
  if (!line.includes('"wrb.fr"') || line.length < 60) return null
  try {
    const arr = JSON.parse(line)
    const innerStr = arr?.[0]?.[2]
    if (!innerStr || typeof innerStr !== 'string' || innerStr.length < 20) return null
    const inner = JSON.parse(innerStr)
    if (!Array.isArray(inner) || inner.length <= 4 || !inner[4]) return null
    const parts = inner[4]
    const texts: string[] = []
    for (const part of parts) {
      const items = part?.[1]
      if (Array.isArray(items)) {
        for (const t of items) {
          if (typeof t === 'string' && t.length > 0) texts.push(t)
        }
      }
    }
    if (texts.length === 0) return null
    // 响应是累积快照，最后一段即当前全量
    for (let i = texts.length - 1; i >= 0; i--) {
      if (texts[i].trim()) return texts[i]
    }
    return null
  } catch {
    return null
  }
}

/** 上游明确报错时（BardErrorInfo）抛出可读错误 */
function checkUpstreamError(raw: string): string | null {
  // 该错误载荷在出口 IP 被 Google 判定为自动化流量时出现，与 Cookie、bl 无关
  // xsrf 载荷的两种成因（实测均会返回它，且无法在单次响应里区分）：
  // 1) 渠道 Cookie 会话未登录/已被登出 —— 最常见。Google 只对登录态下发
  //    SNlM0e，会话失效后 StreamGenerate 就会要 xsrf；此时 /app 抓得到但页面
  //    没有 SNlM0e。需要重新登录 Google 重新抓 Cookie。
  // 2) 出口 IP 被判定为自动化流量 —— 换住宅/非机房出口可解。
  if (/"xsrf"/.test(raw)) {
    return 'Gemini 拒绝请求（xsrf）。常见原因按概率排序：① 渠道 Cookie 会话已失效/未登录' +
      '（重新登录 gemini.google.com 抓新 Cookie 即可）；② 出口 IP 被判定为自动化流量（换住宅/非机房出口）。'
  }
  const m = raw.match(/BardErrorInfo\s*\[(\d+)\]/)
  if (m) return `Gemini 上游拒绝请求: BardErrorInfo [${m[1]}]`
  const html = raw.match(/<title>([^<]+)<\/title>/i)
  if (html && /Just a moment|Attention Required/i.test(html[1])) {
    return 'Gemini 返回人机验证页：出口 IP 被风控，请配置 Cookie 或更换部署区域'
  }
  return null
}

/** 去掉 Gemini 输出里的代码执行残留 */
function cleanText(text: string): string {
  return text
    .replace(/```(?:python|py)?\s*print\((.*?)\)\s*```/gs, '$1')
    .replace(/\s+$/, '')
}

// =====================================================================
// OpenAI SSE
// =====================================================================

function createGeminiSseStream(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const state = { id: `chatcmpl-geminiweb-${randomId()}`, model: requestedModel }
  let buffer = ''
  let previous = ''
  let roleSent = false
  let finished = false
  let toolMode = false

  const send = (delta: Record<string, any>, finish: string | null = null, withUsage = false) => {
    const chunk: Record<string, any> = {
      id: state.id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    }
    if (withUsage) {
      chunk.usage = {
        prompt_tokens: 0,
        completion_tokens: Math.ceil(previous.length / 4),
        total_tokens: Math.ceil(previous.length / 4),
      }
    }
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
  }

  let controller!: ReadableStreamDefaultController<Uint8Array>

  const finish = (reason: string | null) => {
    if (finished) return
    finished = true
    // tool_calls 是原子的：正文流式吐完后，统一把 ```tool_call``` 块发成一个 delta
    const parsed = parseToolCallBlocks(previous)
    if (parsed.toolCalls.length) {
      if (!roleSent) {
        roleSent = true
        send({ role: 'assistant', content: '' })
      }
      parsed.toolCalls.forEach((tc, i) => {
        send({ tool_calls: [{ index: i, id: tc.id, type: 'function', function: tc.function }] })
      })
      send({}, 'tool_calls', true)
    } else {
      send({}, reason || 'stop', true)
    }
    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
    if (onUsage) onUsage({ promptTokens: 0, completionTokens: Math.ceil(previous.length / 4) })
    try { controller.close() } catch { /* already closed */ }
  }

  const handleLine = (line: string) => {
    const full = extractLineText(line)
    if (full === null) return
    // 上游给的是累积快照，取增量避免重复吐字
    const delta = full.startsWith(previous) ? full.slice(previous.length) : full
    previous = full
    if (!delta) return
    // 一旦模型开始输出 ```tool_call，剩余内容不能当正文吐出去，改为收尾时统一解析
    if (toolMode) return
    if (previous.includes('```tool_call')) {
      toolMode = true
      return
    }
    if (!roleSent) {
      roleSent = true
      send({ role: 'assistant', content: '' })
    }
    send({ content: cleanText(delta) })
  }

  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl
      const reader = upstream.getReader()

      const pump = () => {
        reader.read().then(({ done, value }) => {
          if (done) {
            if (!roleSent) send({ role: 'assistant', content: '' })
            finish('stop')
            return
          }
          buffer += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).replace(/\r$/, '')
            buffer = buffer.slice(idx + 1)
            if (finished) return
            handleLine(line)
          }
          if (!finished) pump()
        }).catch((err) => {
          if (finished) return
          finished = true
          try {
            send({ content: `[geminiweb] ${(err as Error)?.message || '上游流中断'}` }, 'stop')
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
// OpenAI messages -> prompt（对齐 worker.js 的 messagesToPrompt）
// =====================================================================

interface OpenAIMessage {
  role: string
  content: any
  name?: string
  tool_calls?: any[]
  tool_call_id?: string
}

interface ToolDef {
  name: string
  description?: string
  parameters?: any
}

/**
 * Gemini 网页私有协议没有暴露原生的 functionDeclarations 通道，
 * 所以按上游 worker.js 的做法：把工具声明渲染成一段文本提示，
 * 模型回 ```tool_call``` 代码块，再从文本里解析回 OpenAI tool_calls。
 */
function extractToolDefs(tools: any): ToolDef[] {
  const out: ToolDef[] = []
  if (!Array.isArray(tools)) return out
  for (const t of tools) {
    const fn = t?.function || t
    if (!fn || typeof fn.name !== 'string' || !fn.name) continue
    out.push({ name: fn.name, description: fn.description, parameters: fn.parameters })
  }
  return out
}

function toolChoiceInstruction(toolChoice: any, toolDefs: ToolDef[]): string {
  const tc = typeof toolChoice === 'object' && toolChoice ? toolChoice : { type: toolChoice }
  const mode = String(tc?.type || 'auto').toLowerCase()
  const names = Array.isArray(tc?.function?.name) ? tc.function.name : (tc?.function?.name ? [tc.function.name] : [])
  if (mode === 'none') return '\n\nIMPORTANT: Do NOT call any tools. Respond with text only.'
  if (mode === 'required' || mode === 'any') {
    if (names.length) {
      const list = names.map((n: string) => `"${n}"`).join(', ')
      return `\n\nIMPORTANT: You MUST call one of these tools: ${list}. Do not respond with text only.`
    }
    return '\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.'
  }
  if (names.length) {
    const list = names.map((n: string) => `"${n}"`).join(', ')
    return `\n\nIMPORTANT: You may only call these tools: ${list}.`
  }
  return ''
}

function buildToolPrompt(toolDefs: ToolDef[], toolChoice: any): string {
  const spec = JSON.stringify(toolDefs.map((d) => ({ name: d.name, description: d.description || '', parameters: d.parameters || {} })), null, 2)
  return (
    '# Tool Use\n\n' +
    'You can call the following tools to help accomplish tasks. ' +
    'These tools connect to the user\'s local environment and will execute when called.\n\n' +
    'Call format (use this exact format):\n' +
    '```tool_call\n' +
    '{"name": "<tool_name>", "arguments": {<arguments>}}\n' +
    '```\n\n' +
    'When calling tools:\n' +
    '- Output ONLY the tool_call block(s), nothing else\n' +
    '- You may call multiple tools with multiple blocks\n' +
    '- After receiving a [Tool result for ...], use that data to answer the user\n\n' +
    `Available tools:\n${spec}` +
    toolChoiceInstruction(toolChoice, toolDefs)
  )
}

function messageText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === 'string' ? part : part?.type === 'text' ? String(part.text || '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (content === null || content === undefined) return ''
  return String(content)
}

function messagesToPrompt(
  messages: OpenAIMessage[],
  toolDefs: ToolDef[] = [],
  toolChoice?: any,
): string {
  const parts: string[] = []
  for (const m of messages) {
    const text = messageText(m.content).trim()
    if (m.role === 'system') {
      if (text) parts.push(`[System instruction]: ${text}`)
      continue
    }
    if (m.role === 'tool') {
      // 工具结果必须保留：模型靠它才能接着回答
      const nm = m.name || m.tool_call_id || 'tool'
      parts.push(`[Tool result for ${nm}]: ${text}`)
      continue
    }
    if (m.role === 'assistant') {
      // 助手历史里的 tool_calls 要按 tool_call 代码块回放，否则模型不知道调过什么
      const blocks = Array.isArray(m.tool_calls) && m.tool_calls.length
        ? m.tool_calls.map((tc: any) => {
            const fn = tc?.function || {}
            const args = typeof fn.arguments === 'string' && fn.arguments ? fn.arguments : '{}'
            return '```tool_call\n{"name": "' + String(fn.name || '') + '", "arguments": ' + args + '}\n```'
          }).join('\n')
        : ''
      const head = text || ''
      parts.push(blocks ? `[Assistant]: ${head}\n${blocks}`.trim() : `[Assistant]: ${head}`.trim())
      continue
    }
    if (text) parts.push(text)
  }

  const head = toolDefs.length ? buildToolPrompt(toolDefs, toolChoice) : ''
  const body = parts.filter((p) => p).join('\n\n')
  return head ? (body ? `${head}\n\n${body}` : head) : body
}

// =====================================================================
// 工具调用：解析模型回传的 ```tool_call``` 代码块
// =====================================================================

interface ParsedToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

function parseToolCallBlocks(text: string): { text: string; toolCalls: ParsedToolCall[] } {
  const toolCalls: ParsedToolCall[] = []
  const cleanParts: string[] = []
  const re = /```tool_call\s*\n([\s\S]*?)\n```/g
  let lastEnd = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    cleanParts.push(text.slice(lastEnd, m.index))
    lastEnd = m.index + m[0].length
    try {
      const data = JSON.parse(m[1].trim())
      if (data?.name === undefined) continue
      toolCalls.push({
        id: `call_${randomId()}`,
        type: 'function',
        function: {
          name: String(data.name),
          arguments: JSON.stringify(data.arguments ?? {}),
        },
      })
    } catch {
      // 格式错误的块直接跳过，不影响其余内容
    }
  }
  cleanParts.push(text.slice(lastEnd))
  return { text: cleanParts.join('').trim(), toolCalls }
}

// =====================================================================
// 上游调用
// =====================================================================

interface UpstreamResult {
  ok: boolean
  status: number
  body: ReadableStream<Uint8Array> | null
  text: string
}

async function callUpstream(
  env: Env,
  prompt: string,
  mode: number,
  think: number,
  account: Account,
): Promise<UpstreamResult> {
  let bl = await getBL(env, account.cookie || undefined)

  for (let attempt = 0; attempt < 2; attempt++) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': GEMINI_BASE,
      'Referer': `${GEMINI_BASE}${accountPrefix(account.cookie)}/app`,
      'X-Same-Domain': '1',
      'User-Agent': UA_POOL[Math.floor(Math.random() * UA_POOL.length)],
      'Accept': '*/*',
      'Accept-Language': LANG_POOL[Math.floor(Math.random() * LANG_POOL.length)],
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    }
    if (account.cookie) headers['Cookie'] = account.cookie
    if (account.sapisid) headers['Authorization'] = await makeSapisidHash(account.sapisid)

    // 走裸 socket 自拼 HTTP/1.1：标准 fetch 的 HTTP/2 + gzip 特征头会被 Gemini 判为自动化流量
    const resp = await rawFetch(buildStreamUrl(bl, accountPrefix(account.cookie)), {
      method: 'POST',
      headers,
      body: buildFormBody(prompt, mode, think),
      timeoutMs: GEMINI_TIMEOUT_MS,
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    })

    if (resp.ok && resp.body) {
      return { ok: true, status: resp.status, body: resp.body, text: '' }
    }

    const text = await resp.text().catch(() => '')

    // 400/405 = BL 过期，强制刷新后重试一次（不消耗账号轮换）
    if ((resp.status === 405 || resp.status === 400) && attempt === 0) {
      const fresh = await getBL(env, account.cookie || undefined, true)
      if (fresh && fresh !== bl) {
        bl = fresh
        continue
      }
    }

    return { ok: false, status: resp.status, body: null, text }
  }

  return { ok: false, status: 502, body: null, text: 'BL 刷新后仍失败' }
}

// =====================================================================
// 对外入口
// =====================================================================

export async function handleGeminiWebRequest(p: OAuthCallParams): Promise<Response> {
  const rawEntries = (p.refreshTokens || []).map((t) => (t || '').trim()).filter(Boolean)
  const accounts = parseAccounts(rawEntries)
  // 匿名模式：没配凭据也允许跑，只是模型受限、限流严
  const useList: Account[] = accounts.length > 0 ? accounts : [{ cookie: '', sapisid: '' }]

  const resolved = resolveGeminiWebModel(p.requestedModel || p.modelId)
  if (resolved.error) {
    return oauthErrorResponse(resolved.error, 400, 'invalid_request_error')
  }

  const messages = Array.isArray(p.body?.messages) ? (p.body.messages as OpenAIMessage[]) : []
  const toolDefs = extractToolDefs(p.body?.tools)
  const prompt = messagesToPrompt(messages, toolDefs, p.body?.tool_choice)
  if (!prompt) {
    return oauthErrorResponse('messages 内容为空，无法转发', 400, 'invalid_request_error')
  }

  const stream = p.body?.stream === true
  let lastError = '未知错误'
  let lastStatus = 502

  for (const account of useList) {
    let upstream: UpstreamResult
    try {
      upstream = await callUpstream(p.env, prompt, resolved.spec.mode, resolved.spec.think, account)
    } catch (err) {
      lastError = (err as Error).message || '上游请求失败'
      lastStatus = 502
      continue
    }

    if (!upstream.ok || !upstream.body) {
      lastStatus = upstream.status
      lastError = `HTTP ${upstream.status}: ${(upstream.text || '').slice(0, 300)}`
      const explicit = checkUpstreamError(upstream.text)
      if (explicit) lastError = explicit
      // 401/403/429/5xx 换下一个账号；4xx 其他直接回给客户端
      if ([401, 403, 429].includes(upstream.status) || upstream.status >= 500) continue
      return oauthErrorResponse(lastError, upstream.status, 'upstream_error')
    }

    if (stream) {
      // 流式必须原样透传，不做整体缓冲
      const [toClient, forUsage] = upstream.body.tee()
      const usageReader = forUsage.getReader()
      defer(p, (async () => {
        let chars = 0
        for (;;) {
          const { done, value } = await usageReader.read()
          if (done) break
          chars += value.byteLength
        }
        await recordOAuthUsage(p, { promptTokens: 0, completionTokens: Math.ceil(chars / 4) }, true, 200)
      })().catch(() => {}))

      const sse = createGeminiSseStream(toClient, p.requestedModel)
      return new Response(sse, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        },
      })
    }

    // 非流式：读完整响应再聚合
    const raw = await new Response(upstream.body).text()
    const explicit = checkUpstreamError(raw)
    if (explicit) {
      lastError = explicit
      continue
    }
    let content = ''
    for (const line of raw.split('\n')) {
      const full = extractLineText(line)
      if (full) content = full
    }
    const completionTokens = Math.ceil(content.length / 4)
    // 模型可能回的是 ```tool_call``` 代码块，剥出来转成 OpenAI tool_calls
    const parsed = parseToolCallBlocks(content)
    const message: Record<string, any> = {
      role: 'assistant',
      content: parsed.text ? cleanText(parsed.text) : null,
    }
    if (parsed.toolCalls.length) message.tool_calls = parsed.toolCalls
    const json = {
      id: `chatcmpl-geminiweb-${randomId()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: p.requestedModel,
      choices: [{
        index: 0,
        message,
        finish_reason: parsed.toolCalls.length ? 'tool_calls' : 'stop',
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
    `所有 Gemini 账号均失败，最后一次错误: ${lastError}`,
    lastStatus,
    'key_exhausted',
  )
}

// =====================================================================
// 后台：连通性测试 / 模型清单
// =====================================================================

export async function testGeminiWeb(
  env: Env,
  rawCookie: string,
  modelId: string,
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  const accounts = parseAccounts([rawCookie])
  const account = accounts[0] || { cookie: '', sapisid: '' }
  const resolved = resolveGeminiWebModel(modelId)
  try {
    const upstream = await callUpstream(env, 'hi', resolved.spec.mode, resolved.spec.think, account)
    if (upstream.ok && upstream.body) {
      try { await upstream.body.cancel() } catch { /* ignore */ }
      return { success: true, message: '连接成功', statusCode: 200 }
    }
    const explicit = checkUpstreamError(upstream.text)
    return {
      success: false,
      message: explicit || `HTTP ${upstream.status}: ${(upstream.text || '').slice(0, 200)}`,
      statusCode: upstream.status,
    }
  } catch (err) {
    return { success: false, message: (err as Error).message || '连接失败' }
  }
}

/** 模型清单是本地维护的（Gemini 网页版没有模型目录接口） */
export function listGeminiWebModels(): { success: true; models: string[] } {
  return { success: true, models: Object.keys(GEMINI_WEB_MODELS) }
}