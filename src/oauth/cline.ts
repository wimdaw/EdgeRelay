/**
 * Cline (cline.bot) 网页反代 (provider.type = 'cline')
 *
 * 参考 https://github.com/Patrick-mufeng/cline-free (MIT) 的上游协议实现，
 * 上游链路：cline-free ← pingmike2/cline2api-workers ← luawei1/cline2api (Go)。
 *
 * 1. 凭据：渠道 apiKeys 每行一个 Cline 账号的 refreshToken（可点后台「授权登录」
 *    走 WorkOS 设备码流程自动获取：WorkOS device_code → authenticate → Cline /auth/register）。
 * 2. accessToken：POST /api/v1/auth/refresh {refreshToken, grantType:'refresh_token'} 换取，
 *    结果按 refreshToken 哈希缓存进 KV（resolveAccessToken 共享逻辑）。
 * 3. 对话：POST /api/v1/chat/completions（OpenAI SSE），Authorization: Bearer workos:<accessToken>，
 *    并带 Cline 客户端指纹头 —— 缺头会被 403:
 *    "deepseek/deepseek-v4-flash is only available via Cline product surfaces"。
 * 4. 上游风控（都实测自 cline-free，不遵守直接失败）：
 *    - 请求体带 max_tokens 字段：免费模型一律 500 "empty response content" → 整体不发送该字段
 *      （代价：finish_reason=stop 的完整生成无法在网关侧提前截断）。
 *    - 免费通道（上游 `~` 前缀的 -latest 别名，如 ~anthropic/claude-sonnet-latest）
 *      非流式被限流 → 强制 stream:true，非流式请求由网关本地聚合为单条响应。
 *    - 并发 > 1 会返回空响应 → 模块级串行队列 + 最小间隔（隔离实例内并发；跨实例由上游兜底）。
 *    - 429 "Try again in 2h 51m" → 解析冷却时长，按「账号 × 模型」粒度冷却（与上游
 *      计额粒度一致：某账号的 deepseek 到上限不影响同账号的 glm），冷却中的组合轮换时跳过。
 * 5. 上游 SSE 偶尔包一层 {data:{...}} → 流式/非流式统一剥壳后吐给客户端。
 */

import type { Env } from '../types'
import { getKV } from '../storage/blob-store'
import {
  type OAuthCallParams,
  oauthErrorResponse,
  randomId,
  readErrorBody,
  recordOAuthUsage,
  resolveAccessToken,
  defer,
  sha256Hex,
} from './common'

// =====================================================================
// 上游常量
// =====================================================================

const CLINE_API_BASE = 'https://api.cline.bot/api/v1'
/** WorkOS 设备授权（逆向自 cline2api/auth.go，client_id 为 Cline 官方应用） */
const WORKOS_DEVICE_URL = 'https://api.workos.com/user_management/authorize/device'
const WORKOS_AUTH_URL = 'https://api.workos.com/user_management/authenticate'
const WORKOS_CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR'

/** 官方客户端指纹（版本随 Cline 客户端升级可能需要更新，缺任一头都可能 403） */
const CLINE_FINGERPRINT_HEADERS: Record<string, string> = {
  'User-Agent': 'Cline/3.0.47',
  'HTTP-Referer': 'https://cline.bot',
  'X-Title': 'Cline',
  'X-IS-MULTIROOT': 'false',
  'X-CLIENT-TYPE': 'cline-sdk',
  'X-CLIENT-VERSION': '3.0.47',
  'X-PLATFORM': 'terminal',
  'X-PLATFORM-VERSION': '3.0.47',
  'X-CORE-VERSION': '0.0.66',
}

/** KV 前缀：accessToken 缓存 / 设备码授权会话 */
const CLINE_AT_PREFIX = 'cline:at:'
const CLINE_DEVICE_PREFIX = 'cline:dev:'

/** 免费通道判定：非流式被上游限流，必须强制 stream 后由网关聚合。
 *  注意这是「上游通道形态」判定（deepseek/、cline-free/、cline-pass/ 前缀），与是否零扣费无关 */
function isFreeClineModel(modelId: string): boolean {
  return (
    modelId.endsWith(':free') ||
    modelId === 'deepseek/deepseek-v4-flash' ||
    modelId.startsWith('deepseek/') ||
    modelId.startsWith('cline-free/') ||
    modelId.startsWith('cline-pass/')
  )
}

/** 默认模型（官方 cline-free 免费额度，实测 cost=0、不扣余额） */
export const CLINE_DEFAULT_MODEL = 'cline-free/mimo-v2.6-flash'

/**
 * 后台「获取模型列表」返回的内置清单。
 * 全部实测 cost=0（官方 cline-free 免费额度 + :free 后缀模型），不扣账户余额。
 * 注意：deepseek/deepseek-v4-flash 自 2026-10 起按量计费，已不再列入。
 */
export const CLINE_BUILTIN_MODELS = [
  'cline-free/mimo-v2.6-flash',
  'cline-free/nemotron-3.5-super-vl',
  'cline-free/muse-spark-1.3-contributor',
  'cline-free/solar-mini4',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
  'cohere/north-mini-code:free',
  'dots-studio/dots-3-note-preview:free',
  'liquid/lfm-2.5-2.6b:free',
  'nvidia/nemotron-3.5-content-safety:free',
]

// =====================================================================
// accessToken（KV 缓存）与「账号 × 模型」冷却
// =====================================================================

async function refreshClineToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetch(CLINE_API_BASE + '/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken, grantType: 'refresh_token' }),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    throw new Error(`refresh HTTP ${res.status}: ${(await readErrorBody(res)).slice(0, 200)}`)
  }
  const json = await res.json().catch(() => null) as any
  const accessToken = json?.data?.accessToken
  if (!accessToken) throw new Error('refresh 响应未包含 accessToken')
  // 过期时间：优先服务端 expiresAt（ms 时间戳或 ISO），兜底 10 分钟；统一留 60s 余量
  let expiresIn = 600
  const exp = json?.data?.expiresAt
  if (typeof exp === 'number' && exp > Date.now()) expiresIn = Math.floor((exp - Date.now()) / 1000)
  else if (typeof exp === 'string') {
    const t = Date.parse(exp)
    if (!Number.isNaN(t) && t > Date.now()) expiresIn = Math.floor((t - Date.now()) / 1000)
  }
  return { accessToken, expiresIn: Math.max(60, expiresIn - 60) }
}

function getClineAccess(env: Env, refreshToken: string) {
  return resolveAccessToken(env, CLINE_AT_PREFIX, refreshToken, async () => {
    const { accessToken, expiresIn } = await refreshClineToken(refreshToken)
    return { accessToken, expiresIn }
  })
}

/** 冷却表（实例内存）：key = refreshToken哈希|模型ID，value = 冷却到期时间戳 */
const cooldowns = new Map<string, number>()

/** KV 前缀：按账号持久化的冷却表 / 今日用量（额度页数据源，重启与多实例共享） */
const COOL_PREFIX = 'cline:cool:'
const USAGE_PREFIX = 'cline:usage:'
/** 本 isolate 已从 KV 装载过冷却表的账号（避免每请求重复读） */
const coolLoaded = new Set<string>()

async function clineKeyHash16(refreshToken: string): Promise<string> {
  return (await sha256Hex(refreshToken)).slice(0, 16)
}

/** 免费额度按自然日重置；用量记账以北京时间日期为准 */
function clineDateKey(): string {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10)
}

/** 首次遇到某账号时，把 KV 里的持久化冷却表合并进内存（重启后冷却不丢） */
async function loadCoolIntoMemory(env: Env, hash: string): Promise<void> {
  if (coolLoaded.has(hash)) return
  coolLoaded.add(hash)
  try {
    const raw = await getKV(env).get(COOL_PREFIX + hash)
    if (!raw) return
    const map = JSON.parse(raw) as Record<string, number>
    for (const [model, until] of Object.entries(map)) {
      const k = hash + '|' + model
      if (!cooldowns.has(k) || (cooldowns.get(k) || 0) < until) cooldowns.set(k, until)
    }
  } catch { /* 冷却表加载失败按无冷却处理 */ }
}

/** 冷却写穿 KV（尽力而为，失败只影响额度页展示） */
async function persistCooldown(env: Env, hash: string, modelId: string, until: number): Promise<void> {
  try {
    const raw = await getKV(env).get(COOL_PREFIX + hash)
    const map = raw ? (JSON.parse(raw) as Record<string, number>) : {}
    map[modelId] = until
    await getKV(env).put(COOL_PREFIX + hash, JSON.stringify(map)).catch(() => {})
  } catch { /* ignore */ }
}

interface ClineUsageEntry { requests: number; promptTokens: number; completionTokens: number }

/** 按「账号 × 模型」累加今日用量（北京时间自然日；KV 读改写为尽力而为） */
async function recordClineUsage(env: Env, hash: string, modelId: string, u: { promptTokens: number; completionTokens: number }): Promise<void> {
  try {
    const date = clineDateKey()
    const raw = await getKV(env).get(USAGE_PREFIX + hash)
    const prev = raw ? (JSON.parse(raw) as { date?: string; models?: Record<string, ClineUsageEntry> }) : null
    const models = prev && prev.date === date && prev.models ? prev.models : {}
    const cur = models[modelId] || { requests: 0, promptTokens: 0, completionTokens: 0 }
    cur.requests += 1
    cur.promptTokens += u.promptTokens
    cur.completionTokens += u.completionTokens
    models[modelId] = cur
    await getKV(env).put(USAGE_PREFIX + hash, JSON.stringify({ date, models })).catch(() => {})
  } catch { /* 统计尽力而为 */ }
}

/** 从上游错误文本解析等待时长："Try again in 2h 51m" / "30m" / "15s" → 毫秒（上限 6h） */
function parseCooldownMs(text: string, status: number): number {
  const m = (text || '').match(/try again in (?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i)
  if (m) {
    const ms = ((parseInt(m[1] || '0', 10) * 3600 + parseInt(m[2] || '0', 10) * 60 + parseInt(m[3] || '0', 10)) * 1000)
    if (ms > 0) return Math.min(ms, 6 * 3600 * 1000)
  }
  if (status === 429) return 5 * 60 * 1000
  return 60 * 1000
}

// =====================================================================
// 上游请求体改写与指纹头
// =====================================================================

function rewriteClinePayload(body: Record<string, any>, modelId: string, wantStream: boolean): Record<string, any> {
  const upstream: Record<string, any> = {
    model: modelId,
    session_id: 'sess_' + Date.now(),
    reasoning_effort: body.reasoning_effort || body.reasoningEffort || 'high',
    messages: body.messages || [],
  }
  // ⚠️ 免费模型带 max_tokens 一律 500 "empty response content"，整体不发送（见文件头注释）。
  // 免费通道非流式被限流 → 强制上游 stream，非流式由网关本地聚合。
  const forceStream = isFreeClineModel(modelId)
  if (wantStream || forceStream) upstream.stream = true
  for (const k of ['temperature', 'top_p', 'tools', 'tool_choice', 'stop', 'presence_penalty', 'frequency_penalty', 'response_format', 'user', 'n', 'seed']) {
    if (body[k] !== undefined) upstream[k] = body[k]
  }
  return upstream
}

function clineChatHeaders(accessToken: string, sessionId: string): Record<string, string> {
  return {
    Authorization: 'Bearer workos:' + accessToken,
    'Content-Type': 'application/json',
    ...CLINE_FINGERPRINT_HEADERS,
    'X-Task-ID': sessionId,
  }
}

// =====================================================================
// 并发限流队列：免费通道并发 > 1 会空响应，实例内强制串行 + 最小间隔
// =====================================================================

let queueTail: Promise<unknown> = Promise.resolve()
const MIN_GAP_MS = 800

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail
    .then(() => new Promise((r) => setTimeout(r, MIN_GAP_MS)))
    .then(fn) as Promise<T>
  queueTail = run.catch(() => {})
  return run
}

// =====================================================================
// 响应处理：剥 {data:{...}} 包装（流式 Transform / 非流式聚合）
// =====================================================================

function unwrapData(obj: any): any {
  if (obj && typeof obj === 'object' && obj.data && typeof obj.data === 'object') {
    const d = obj.data
    if (d.choices || d.id || d.usage || d.model) return d
  }
  return obj
}

interface ClineUsage { promptTokens: number; completionTokens: number }

/**
 * 流式透传：跨块缓冲出完整行后，逐行剥 {data:{...}} 包装再重发，done 在流结束时汇总 usage。
 * ⚠️ 必须缓冲：上游单个 SSE 事件是多 KB 大行，网络分块边界会切在 JSON 行中间——
 * 若按收到的分块直接解析/转发，半截 JSON 会原样漏给客户端（表现为
 * "Expected ',' or ']' after array element"）。与 codebuddy.normalizeCodebuddyStream 同构，
 * EdgeOne 运行时上 TransformStream 逐块转发已实测可靠；禁止整段缓冲后再回吐（客户端会超时重连）。
 */
function normalizeClineStream(src: ReadableStream<Uint8Array>): { stream: ReadableStream<Uint8Array>; done: Promise<ClineUsage> } {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const usage: ClineUsage = { promptTokens: 0, completionTokens: 0 }
  let resolveDone!: (u: ClineUsage) => void
  const done = new Promise<ClineUsage>((r) => { resolveDone = r })
  let buf = ''

  const handleLine = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line.startsWith('data:')) {
      // 非 data 行（含 SSE 事件分隔空行）原样保序透传
      controller.enqueue(encoder.encode(line + '\n'))
      return
    }
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') {
      controller.enqueue(encoder.encode(line + '\n\n'))
      return
    }
    try {
      const obj = unwrapData(JSON.parse(payload))
      const u = obj?.usage
      if (u) {
        usage.promptTokens = Number(u.prompt_tokens ?? 0) || 0
        usage.completionTokens = Number(u.completion_tokens ?? 0) || 0
      }
      controller.enqueue(encoder.encode('data: ' + JSON.stringify(obj) + '\n\n'))
    } catch {
      // 行已按 \n 完整缓冲，正常不会再有半截 JSON；保底原样透传
      controller.enqueue(encoder.encode(line + '\n'))
    }
  }

  const stream = src.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        handleLine(line, controller)
      }
    },
    flush(controller) {
      if (buf) handleLine(buf, controller)
      resolveDone(usage)
    },
  }))

  return { stream, done }
}

/** 把上游 SSE 流聚合成 OpenAI 非流式响应（客户端要非流式但免费通道只能流式时用） */
async function aggregateClineStream(body: ReadableStream<Uint8Array>, fallbackModel: string): Promise<{ response: any; usage: ClineUsage }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  let reasoning = ''
  let finishReason: string | null = null
  let id = ''
  let model = ''
  let usage: any = null

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const obj = unwrapData(JSON.parse(payload))
        const choice = obj?.choices?.[0]
        if (!choice) {
          if (obj?.usage) usage = obj.usage
          continue
        }
        const delta = choice.delta || {}
        if (delta.content) content += delta.content
        if (delta.reasoning) reasoning += delta.reasoning
        if (choice.finish_reason) finishReason = choice.finish_reason
        if (obj.id) id = obj.id
        if (obj.model) model = obj.model
        if (obj.usage) usage = obj.usage
      } catch { /* 忽略非 JSON 行 */ }
    }
  }

  const message: Record<string, any> = { role: 'assistant', content }
  if (reasoning) message.reasoning = reasoning
  return {
    response: {
      id: id || 'gen_' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || fallbackModel,
      choices: [{
        index: 0,
        message,
        finish_reason: finishReason || 'stop',
        logprobs: null,
        native_finish_reason: finishReason || 'stop',
      }],
      usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
    usage: {
      promptTokens: Number(usage?.prompt_tokens ?? 0) || 0,
      completionTokens: Number(usage?.completion_tokens ?? 0) || 0,
    },
  }
}

// =====================================================================
// 主入口：多账号轮换 + 冷却 + 串行队列
// =====================================================================

export async function handleClineRequest(p: OAuthCallParams): Promise<Response> {
  const tokens = (p.refreshTokens || []).filter((t) => t && t.trim())
  if (tokens.length === 0) {
    return oauthErrorResponse(
      '该 cline 渠道未配置凭据：请在「API Keys」里每行填入一个 Cline refreshToken（可点「授权登录」自动获取）',
      400,
      'configuration_error',
    )
  }

  const wantStream = (p.body as any)?.stream === true
  const upstreamBody = rewriteClinePayload(p.body, p.modelId, wantStream)

  const hashByKey = new Map<string, string>()
  for (const t of tokens) hashByKey.set(t, await clineKeyHash16(t))
  for (const t of tokens) await loadCoolIntoMemory(p.env, hashByKey.get(t) as string)
  // 负载均衡：可用账号随机洗牌后按序尝试（用量在账号间摊平，与通用渠道的健康 key 洗牌同风格）；
  // 冷却中的账号保持原顺序垫底兜底（冷却到期会被直接试用）
  const available: string[] = []
  const cooling: string[] = []
  for (const t of tokens) {
    const until = cooldowns.get((hashByKey.get(t) as string) + '|' + p.modelId) || 0
    ;(until <= Date.now() ? available : cooling).push(t)
  }
  for (let i = available.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[available[i], available[j]] = [available[j], available[i]]
  }
  const ordered = [...available, ...cooling]

  let lastError = ''
  let lastStatus = 502

  for (const refreshToken of ordered) {
    const hash = hashByKey.get(refreshToken) as string
    const key = hash + '|' + p.modelId
    try {
      const { accessToken } = await getClineAccess(p.env, refreshToken)
      const upstream = await enqueue(() => fetch(CLINE_API_BASE + '/chat/completions', {
        method: 'POST',
        headers: clineChatHeaders(accessToken, upstreamBody.session_id),
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(600000),
      }))

      if (!upstream.ok) {
        const errText = await readErrorBody(upstream)
        lastStatus = upstream.status
        lastError = `HTTP ${upstream.status}: ${errText.slice(0, 300)}`
        // 鉴权失效：作废缓存的 accessToken，短冷却后换号
        if (upstream.status === 401 || upstream.status === 403) {
          const until401 = Date.now() + 60 * 1000
          cooldowns.set(key, until401)
          void persistCooldown(p.env, hash, p.modelId, until401)
          continue
        }
        // 额度/限流/上游空响应：按上游提示冷却该「账号×模型」组合，换下一个号
        if (upstream.status === 429 || upstream.status >= 500 || errText.includes('empty response content')) {
          const untilCool = Date.now() + parseCooldownMs(errText, upstream.status)
          cooldowns.set(key, untilCool)
          void persistCooldown(p.env, hash, p.modelId, untilCool)
          continue
        }
        return oauthErrorResponse(lastError, upstream.status, 'upstream_error')
      }
      if (!upstream.body) {
        lastError = '上游未返回响应体'
        lastStatus = 502
        continue
      }

      if (wantStream) {
        const { stream, done } = normalizeClineStream(upstream.body)
        defer(p, done.then((u) => Promise.all([
          recordOAuthUsage(p, u, true, 200),
          recordClineUsage(p.env, hash, p.modelId, u),
        ])))
        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          },
        })
      }

      // 非流式：免费通道被强制走了 stream，这里本地聚合；付费通道直接 JSON
      const contentType = upstream.headers.get('content-type') || ''
      if (contentType.includes('text/event-stream')) {
        const agg = await aggregateClineStream(upstream.body, p.modelId)
        defer(p, recordOAuthUsage(p, agg.usage, true, 200).then(() => recordClineUsage(p.env, hash, p.modelId, agg.usage)))
        return new Response(JSON.stringify(agg.response), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        })
      }
      const raw = await upstream.json().catch(() => null)
      if (!raw) {
        lastError = '上游返回非 JSON 响应'
        lastStatus = 502
        continue
      }
      const normalized = unwrapData(raw)
      const u = normalized?.usage
      const parsedUsage = {
        promptTokens: Number(u?.prompt_tokens ?? 0) || 0,
        completionTokens: Number(u?.completion_tokens ?? 0) || 0,
      }
      defer(p, recordOAuthUsage(p, parsedUsage, true, 200).then(() => recordClineUsage(p.env, hash, p.modelId, parsedUsage)))
      return new Response(JSON.stringify(normalized), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    } catch (err) {
      lastError = (err as Error).message || '未知错误'
      lastStatus = 502
      continue
    }
  }

  return oauthErrorResponse(`所有 Cline 账号均失败，最后一次错误: ${lastError || '未知'}`, lastStatus, 'key_exhausted')
}

// =====================================================================
// 后台：账号身份/余额查询（「账号与余额」按钮，参照 cline-free 的官方查询链路）
// =====================================================================

export interface ClineAccountStatus {
  /** 凭据前 8 位（脱敏展示） */
  keyPreview: string
  ok: boolean
  /** 账号邮箱（/users/me） */
  email?: string
  /** 官方 Credit 余额（原始微单位 ÷ 1e6，与 app.cline.bot 显示对齐） */
  balance?: number
  error?: string
}

/** 查询单个 refreshToken 对应的账号邮箱与 Credit 余额（打官方 /users/me 与 /users/{id}/balance） */
export async function fetchClineAccountStatus(env: Env, refreshToken: string): Promise<ClineAccountStatus> {
  const keyPreview = refreshToken.slice(0, 8) + '***'
  try {
    const { accessToken } = await getClineAccess(env, refreshToken)
    const headers = clineChatHeaders(accessToken, '')
    const meRes = await fetch(CLINE_API_BASE + '/users/me', {
      headers,
      signal: AbortSignal.timeout(30000),
    })
    if (!meRes.ok) {
      return { keyPreview, ok: false, error: `HTTP ${meRes.status}: ${(await readErrorBody(meRes)).slice(0, 160)}` }
    }
    const me = ((await meRes.json().catch(() => null)) as any)?.data
    const email = String(me?.email || '')
    let balance: number | undefined
    if (me?.id) {
      const balRes = await fetch(CLINE_API_BASE + '/users/' + encodeURIComponent(String(me.id)) + '/balance', {
        headers,
        signal: AbortSignal.timeout(30000),
      })
      if (balRes.ok) {
        const b = ((await balRes.json().catch(() => null)) as any)?.data
        if (b?.balance !== undefined && b?.balance !== null) {
          balance = Number(b.balance) / 1_000_000
        }
      }
    }
    return { keyPreview, ok: true, email, balance }
  } catch (err) {
    return { keyPreview, ok: false, error: (err as Error).message || '查询失败' }
  }
}

/** 额度页单凭据数据：账号身份/余额 + 各模型今日用量（网关记账）+ 429 冷却状态（KV 持久化） */
export interface ClineKeyQuota {
  keyPreview: string
  ok: boolean
  email?: string
  balance?: number
  error?: string
  usage: Record<string, ClineUsageEntry>
  cooldowns: Record<string, number>
}

export async function fetchClineKeyQuota(env: Env, refreshToken: string): Promise<ClineKeyQuota> {
  const hash = await clineKeyHash16(refreshToken)
  const [status, usageRaw, coolRaw] = await Promise.all([
    fetchClineAccountStatus(env, refreshToken),
    getKV(env).get(USAGE_PREFIX + hash).catch(() => null),
    getKV(env).get(COOL_PREFIX + hash).catch(() => null),
  ])
  let usage: Record<string, ClineUsageEntry> = {}
  try {
    const u = JSON.parse(usageRaw || 'null') as { date?: string; models?: Record<string, ClineUsageEntry> }
    if (u && u.date === clineDateKey() && u.models) usage = u.models
  } catch { /* ignore */ }
  let cooldowns: Record<string, number> = {}
  try {
    cooldowns = (JSON.parse(coolRaw || '{}') as Record<string, number>) || {}
  } catch { /* ignore */ }
  return {
    keyPreview: status.keyPreview,
    ok: status.ok,
    email: status.email,
    balance: status.balance,
    error: status.error,
    usage,
    cooldowns,
  }
}

// =====================================================================
// 后台：连通性测试 / 模型列表 / WorkOS 设备码授权
// =====================================================================

type ClineProbeVerdict =
  | { kind: 'content'; bytes: number }
  | { kind: 'error'; detail: string }
  | { kind: 'empty'; reasoning: boolean; detail?: string }

/**
 * 读上游 SSE 判定是否「真通」。
 * 上游对已下架/不可用的模型会返回 HTTP 200，但流内只有
 * `{"error":{"code":"stream_initialization_failed", ...}}` 且全程无 content
 * —— 只看状态码会把这类模型误报为「连接成功」。判定规则：出现正式 content 即成功
 * （提前退出，不必读完）；出现 error 事件、或读到流尾仍无 content，即失败。
 */
async function probeClineStream(body: ReadableStream<Uint8Array> | null, maxBytes = 2 * 1024 * 1024): Promise<ClineProbeVerdict> {
  if (!body) return { kind: 'empty', reasoning: false, detail: '无响应体' }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let bytes = 0
  let sawReasoning = false
  let sawError = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        bytes += value.length
        buf += decoder.decode(value, { stream: true })
      }
      // 上游单个事件可能是多 KB 的大行，必须跨块缓冲到完整 \n 再解析
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let obj: any
        try { obj = JSON.parse(payload) } catch { continue }
        const errObj = obj?.error || obj?.data?.error
        if (errObj) {
          sawError = String(errObj.message || errObj.code || '未知错误')
          continue
        }
        const delta = unwrapData(obj)?.choices?.[0]?.delta
        const text = delta?.content
        if (typeof text === 'string' && text.length > 0) return { kind: 'content', bytes }
        if (delta?.reasoning_content || delta?.reasoning) sawReasoning = true
      }
      if (bytes >= maxBytes) break
    }
  } catch (err) {
    if (sawError) return { kind: 'error', detail: sawError }
    return { kind: 'empty', reasoning: sawReasoning, detail: (err as Error).message || '读取响应流失败' }
  } finally {
    try { await reader.cancel() } catch { /* 提前退出时的取消异常忽略 */ }
  }
  if (sawError) return { kind: 'error', detail: sawError }
  return { kind: 'empty', reasoning: sawReasoning }
}

export async function testCline(env: Env, refreshToken: string, modelId: string): Promise<{ success: boolean; message: string; statusCode?: number }> {
  if (!refreshToken) return { success: false, message: '未填写 refreshToken', statusCode: 0 }
  const model = modelId || CLINE_DEFAULT_MODEL
  try {
    const { accessToken } = await getClineAccess(env, refreshToken)
    // 最小真实请求（免费通道强制 stream）。空流可能是单次概率性空响应，给第二次机会
    let verdict: ClineProbeVerdict | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      const sessionId = 'sess_' + Date.now()
      const res = await fetch(CLINE_API_BASE + '/chat/completions', {
        method: 'POST',
        headers: clineChatHeaders(accessToken, sessionId),
        body: JSON.stringify({
          model,
          session_id: sessionId,
          reasoning_effort: 'high',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
        signal: AbortSignal.timeout(60000),
      })
      if (!res.ok) {
        return { success: false, message: `HTTP ${res.status}: ${(await readErrorBody(res)).slice(0, 200)}`, statusCode: res.status }
      }
      verdict = await probeClineStream(res.body)
      if (verdict.kind !== 'empty') break
    }
    if (verdict?.kind === 'content') return { success: true, message: '连接成功（已收到内容）', statusCode: 200 }
    if (verdict?.kind === 'error') return { success: false, message: `上游流内错误：${verdict.detail}`, statusCode: 200 }
    const tail = verdict?.reasoning ? '，只收到 reasoning 无正式内容' : ''
    return { success: false, message: `上游返回 200 但未产生内容${tail}${verdict?.detail ? '（' + verdict.detail + '）' : ''}`, statusCode: 200 }
  } catch (err) {
    return { success: false, message: (err as Error).message || '连接失败' }
  }
}

/**
 * 模型列表：调上游 GET /v1/models 实时拉取（2026-10 实测可用，共 400+ 条）。
 * 免费通道为 `~` 前缀的 -latest 别名，付费模型也在返回里，由用户在后台自行勾选。
 * 拉取失败时回退到内置清单，保证「获取模型」按钮始终可用。
 */
export async function fetchClineModels(env: Env, refreshToken: string): Promise<{ success: boolean; models: string[]; message?: string }> {
  if (!refreshToken) {
    return { success: true, models: CLINE_BUILTIN_MODELS.slice(), message: '未填写 refreshToken，返回内置免费通道清单' }
  }
  try {
    const { accessToken } = await getClineAccess(env, refreshToken)
    const res = await fetch(CLINE_API_BASE + '/models', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer workos:' + accessToken,
        ...CLINE_FINGERPRINT_HEADERS,
      },
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await readErrorBody(res)).slice(0, 200)}`)
    const json = await res.json().catch(() => null) as any
    const list: string[] = Array.isArray(json?.data)
      ? json.data.map((m: any) => String(m?.id || '')).filter(Boolean)
      : Array.isArray(json?.models)
        ? json.models.map((m: any) => String(typeof m === 'string' ? m : (m?.id || ''))).filter(Boolean)
        : []
    if (!list.length) throw new Error('上游返回的模型列表为空')
    // 排序：
    // 1. 零扣费模型（官方 cline-free 前缀与 :free 后缀）排第一梯队（实测 cost=0）
    const isZeroCost = (m: string) => m.startsWith('cline-free/') || m.endsWith(':free')
    const zeroCost = list.filter(isZeroCost)
    // 2. 赠金通道模型（~ 前缀）排第二梯队（消耗账号赠金的顶级模型）
    const tilde = list.filter((m) => m.startsWith('~'))
    // 3. 普通付费模型排后面供用户自由勾选
    const paid = list.filter((m) => !isZeroCost(m) && !m.startsWith('~'))
    return { success: true, models: [...zeroCost, ...tilde, ...paid] }
  } catch (err) {
    return {
      success: false,
      models: CLINE_BUILTIN_MODELS.slice(),
      message: `上游拉取失败（${(err as Error).message || err}），已返回内置免费通道清单`,
    }
  }
}

export interface ClineDeviceFlow {
  state: string
  verificationUri: string
  verificationUriComplete?: string
  userCode: string
  expiresIn: number
  interval: number
}

/** WorkOS 设备码授权：发起（后台「授权登录」按钮） */
export async function startClineDeviceFlow(env: Env): Promise<ClineDeviceFlow> {
  const form = new URLSearchParams({ client_id: WORKOS_CLIENT_ID })
  const res = await fetch(WORKOS_DEVICE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { throw new Error(`设备码请求返回非 JSON: ${text.slice(0, 200)}`) }
  if (!res.ok || !json.device_code) throw new Error(`设备码请求失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
  const state = randomId()
  try {
    await getKV(env).put(CLINE_DEVICE_PREFIX + state, JSON.stringify({
      deviceCode: json.device_code,
    }), { expirationTtl: Math.max(300, Number(json.expires_in) || 600) })
  } catch (e) {
    console.error('[cline] start store failed', state.slice(0, 8), String(e))
    throw new Error('设备码会话写入失败(存储异常)，请重试')
  }
  // ⚠️ 追加 prompt=login & max_age=0（OIDC 标准强制重登参数，AuthKit 前端参数白名单里识别）。
  // 实测 Cline 的 AuthKit 配置为「Stale Account Allowed」：设备页会复用浏览器已有会话、
  // 无视这两个参数，且设备页无切换账号入口、authkit 域无登出端点（已全量 404 探测）——
  // 因此添加第二个账号的 100% 可靠路径是无痕窗口打开完整授权链接（前端弹窗有指引）。
  const withFreshLogin = (u: string) => u + (u.includes('?') ? '&' : '?') + 'prompt=login&max_age=0'
  return {
    state,
    verificationUri: withFreshLogin(String(json.verification_uri || 'https://authkit.cline.bot/device')),
    verificationUriComplete: json.verification_uri_complete ? withFreshLogin(String(json.verification_uri_complete)) : undefined,
    userCode: String(json.user_code || ''),
    expiresIn: Number(json.expires_in) || 600,
    interval: Math.max(5, Number(json.interval) || 5),
  }
}

export interface ClinePollResult {
  status: 'pending' | 'ok' | 'error'
  message?: string
  refreshToken?: string
  /** 授权返回的 Cline 账号邮箱（register 响应的 userInfo.email），用于前端提示拿到的是哪个账号 */
  email?: string
}

/** WorkOS 设备码授权：轮询。WorkOS 用 HTTP 400 + JSON body 表达 pending，属正常等待 */
export async function pollClineDeviceFlow(env: Env, state: string): Promise<ClinePollResult> {
  const raw = await getKV(env).get(CLINE_DEVICE_PREFIX + state)
  if (!raw) return { status: 'error', message: '设备码会话不存在或已过期，请重新发起授权' }
  const session = JSON.parse(raw) as { deviceCode: string; done?: boolean; refreshToken?: string; email?: string }
  // 幂等：已换取成功过的会话直接复用结果
  if (session.done && session.refreshToken) {
    return { status: 'ok', refreshToken: session.refreshToken, email: session.email }
  }
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: session.deviceCode,
    client_id: WORKOS_CLIENT_ID,
  })
  const res = await fetch(WORKOS_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { return { status: 'error', message: `轮询返回非 JSON: ${text.slice(0, 200)}` } }
  if (json.error) {
    if (json.error === 'authorization_pending' || json.error === 'slow_down') return { status: 'pending' }
    await getKV(env).delete(CLINE_DEVICE_PREFIX + state).catch(() => {})
    if (json.error === 'access_denied') return { status: 'error', message: '用户拒绝了授权' }
    if (json.error === 'expired_token' || json.error === 'invalid_grant') return { status: 'error', message: '设备码已过期，请重新发起授权' }
    return { status: 'error', message: `WorkOS 错误: ${json.error} ${json.error_description || ''}`.trim() }
  }
  if (!json.access_token) return { status: 'error', message: 'WorkOS 未返回 access_token' }

  // WorkOS token → Cline refreshToken
  const regRes = await fetch(CLINE_API_BASE + '/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: json.access_token, refreshToken: json.refresh_token }),
    signal: AbortSignal.timeout(30000),
  })
  const regText = await regRes.text()
  let reg: any
  try { reg = JSON.parse(regText) } catch { return { status: 'error', message: `Cline 注册返回非 JSON: ${regText.slice(0, 200)}` } }
  const rt = reg?.data?.refreshToken
  if (!rt) return { status: 'error', message: `Cline 注册失败: ${regText.slice(0, 200)}` }
  const email = String(reg?.data?.userInfo?.email || '')
  // 标记完成并保留结果：后续重复轮询仍返回同一 refreshToken
  await getKV(env).put(CLINE_DEVICE_PREFIX + state, JSON.stringify({
    deviceCode: session.deviceCode, done: true, refreshToken: rt, email,
  }), { expirationTtl: 3600 }).catch(() => {})
  return { status: 'ok', refreshToken: rt, email }
}
