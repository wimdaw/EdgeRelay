/**
 * Antigravity 反代 (provider.type = 'antigravity')
 *
 * Google 已停用 Gemini CLI / Code Assist 的个人免费额度（loadCodeAssist 直接把 free-tier 标记为
 * ineligible，generateContent 返回 403 SUBSCRIPTION_REQUIRED），官方指定迁移到 Antigravity。
 * 本模块复刻 CLIProxyAPI 的 Antigravity executor：
 *
 *  1. Antigravity OAuth（独立客户端/scope，loopback 回调 http://localhost:51121/oauth-callback）换 refresh_token
 *  2. loadCodeAssist(ideType=ANTIGRAVITY) 解析 project；没有则 onboardUser（走 daily 端点轮询）
 *  3. OpenAI 请求 -> Gemini 请求（复用 gemini-cli 的翻译），再套 Antigravity 信封
 *     { model, project, userAgent, requestType, requestId, request:{...} }（并删除 request.safetySettings）
 *  4. 响应（同样是 { response: {...} } 包装）翻译回 OpenAI，含 SSE 流式
 *
 * 渠道 apiKeys 里每行一个 Google 账号的 Antigravity refresh_token；需要给某个账号单独指定
 * 项目 ID 时写成 `refresh_token|项目ID`（不写则用渠道级 project），见 parseAgAccount。
 */

import type { Env } from '../types'
import { getKV } from '../storage/blob-store'
import { resolveAccessToken } from './common'
import { openAIToGeminiRequest, geminiResponseToOpenAI, createOpenAIStream } from '../gemini-translate'

const AG_HEALTH_PREFIX = 'ag:health:'

// ===== Antigravity OAuth 客户端（来自 CLIProxyAPI internal/auth/antigravity） =====
// 凭据不入库: 通过 EdgeOne 项目环境变量注入 AG_CLIENT_ID / AG_CLIENT_SECRET
function agClientCredential(env: Env, key: 'AG_CLIENT_ID' | 'AG_CLIENT_SECRET'): string {
  // 客户端凭据通过环境变量注入（EdgeOne 项目环境变量），不入库、不写死进仓库
  const value = env[key]
  if (!value) throw new Error(`未配置 ${key}，请先在部署环境设置 Antigravity OAuth 客户端凭据`)
  return String(value)
}
const AG_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]
const AG_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
// Antigravity 是桌面客户端：loopback 回调，端口固定 51121，路径 /oauth-callback（Google 对 loopback 允许任意端口但路径需匹配）
const AG_REDIRECT_URI = 'http://localhost:51121/oauth-callback'

// 请求端点：生成走 daily，loadCodeAssist 走 prod（与 CLIProxyAPI 一致）
const AG_GEN_BASE = 'https://daily-cloudcode-pa.googleapis.com'
const AG_PROD_BASE = 'https://cloudcode-pa.googleapis.com'
const AG_API_VERSION = 'v1internal'
// Cloud Code 会拒绝低于 2.9.0 版本客户端请求较新模型，故 UA 版本不低于此
const AG_UA = 'antigravity/hub/2.9.1 darwin/arm64'
const AG_IDE_VERSION = '2.9.1'
const AG_GOOG_API_CLIENT = 'gl-node/22.21.1'

const AG_AT_PREFIX = 'antigravity:at:'
const AG_PJ_PREFIX = 'antigravity:pj:'
const AG_STATE_PREFIX = 'antigravity:oauth:'

interface AgUsage {
  promptTokens: number
  completionTokens: number
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomId(): string {
  try { return crypto.randomUUID() } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` }
}

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

function errorResponse(message: string, status: number, type = 'antigravity_error'): Response {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

function agHeaders(accessToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    Accept: '*/*',
    'User-Agent': AG_UA,
    'X-Goog-Api-Client': AG_GOOG_API_CLIENT,
  }
}

// =====================================================================
// 内置 OAuth 授权（Antigravity 客户端，无 PKCE，loopback 回调）
// =====================================================================

/** 生成授权链接。登录后浏览器会尝试打开 localhost:51121（打不开是正常的），从地址栏复制 code。 */
export async function buildAntigravityAuthUrl(env: Env): Promise<{ url: string; state: string }> {
  const state = randomHex(32)
  await getKV(env).put(AG_STATE_PREFIX + state, '1', { expirationTtl: 600 })
  const params = new URLSearchParams({
    access_type: 'offline',
    client_id: agClientCredential(env, 'AG_CLIENT_ID'),
    prompt: 'consent',
    redirect_uri: AG_REDIRECT_URI,
    response_type: 'code',
    scope: AG_SCOPES.join(' '),
    state,
  })
  return { url: `${AG_AUTH_ENDPOINT}?${params.toString()}`, state }
}

/** 从用户粘贴的内容里取 code：既接受纯 code，也接受整段回调 URL */
function extractCode(input: string): string {
  const text = (input || '').trim()
  const match = text.match(/[?&]code=([^&\s]+)/)
  if (match) return decodeURIComponent(match[1])
  return text
}

export async function exchangeAntigravityCode(env: Env, codeOrUrl: string, state: string): Promise<{ refreshToken: string }> {
  const kv = getKV(env)
  const marker = await kv.get(AG_STATE_PREFIX + state)
  if (!marker) {
    throw new Error('授权会话不存在或已过期（10 分钟），请重新点击「用 Google 账号授权」')
  }
  const code = extractCode(codeOrUrl)
  if (!code) throw new Error('未识别到 code，请粘贴 Google 返回的 code 或整段回调地址')
  const form = new URLSearchParams({
    code,
    client_id: agClientCredential(env, 'AG_CLIENT_ID'),
    client_secret: agClientCredential(env, 'AG_CLIENT_SECRET'),
    redirect_uri: AG_REDIRECT_URI,
    grant_type: 'authorization_code',
  })
  const res = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`换取 token 失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
  let json: { refresh_token?: string }
  try { json = JSON.parse(text) } catch { throw new Error(`换取 token 返回非 JSON: ${text.slice(0, 200)}`) }
  if (!json.refresh_token) throw new Error('Google 未返回 refresh_token，请重新授权并在同意页确认')
  await kv.delete(AG_STATE_PREFIX + state).catch(() => {})
  return { refreshToken: json.refresh_token }
}

// =====================================================================
// access_token 刷新（KV 缓存）
// =====================================================================

async function getAccessToken(env: Env, refreshToken: string): Promise<string> {
  const cached = await resolveAccessToken(env, AG_AT_PREFIX, refreshToken, (token) => refreshAntigravityToken(env, token))
  return cached.accessToken
}

/** 刷新 access_token；上游若轮换 refresh_token 也一并回传，由 resolveAccessToken 链式保存 */
async function refreshAntigravityToken(
  env: Env,
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number; refreshToken?: string }> {
  const form = new URLSearchParams({
    client_id: agClientCredential(env, 'AG_CLIENT_ID'),
    client_secret: agClientCredential(env, 'AG_CLIENT_SECRET'),
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  const res = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Antigravity OAuth 刷新失败 HTTP ${res.status}: ${text.slice(0, 300)}`)
  let json: { access_token?: string; expires_in?: number; refresh_token?: string }
  try { json = JSON.parse(text) } catch { throw new Error(`OAuth 刷新返回非 JSON: ${text.slice(0, 200)}`) }
  if (!json.access_token) throw new Error(`OAuth 刷新未返回 access_token: ${text.slice(0, 200)}`)
  return {
    accessToken: json.access_token,
    expiresIn: Number(json.expires_in) || 3600,
    refreshToken: json.refresh_token || undefined,
  }
}

// =====================================================================
// 项目解析：loadCodeAssist(prod) -> 无则 onboardUser(daily)
// =====================================================================

function extractProject(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (value && typeof value === 'object') {
    const id = (value as Record<string, unknown>).id
    if (typeof id === 'string' && id.trim()) return id.trim()
  }
  return ''
}

function extractProjectFromLoad(load: any): string {
  for (const key of ['cloudaicompanionProject', 'projectId', 'project']) {
    const found = extractProject(load?.[key])
    if (found) return found
  }
  return ''
}

function defaultTierId(load: any): string {
  const tiers: any[] = Array.isArray(load?.allowedTiers) ? load.allowedTiers : []
  const preferred = tiers.find((t) => t?.isDefault) || tiers[0]
  if (preferred?.id) return String(preferred.id)
  if (load?.currentTier?.id) return String(load.currentTier.id)
  return 'free-tier'
}

async function resolveProjectId(env: Env, accessToken: string, tokenHash: string, hint?: string): Promise<string> {
  if (hint) return hint
  const kv = getKV(env)
  const cacheKey = AG_PJ_PREFIX + tokenHash
  const cached = await kv.get(cacheKey)
  if (cached) return cached

  const loadRes = await fetch(`${AG_PROD_BASE}/${AG_API_VERSION}:loadCodeAssist`, {
    method: 'POST',
    headers: agHeaders(accessToken),
    body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
    signal: AbortSignal.timeout(30000),
  })
  const loadText = await loadRes.text()
  if (!loadRes.ok) throw new Error(`loadCodeAssist 失败 HTTP ${loadRes.status}: ${loadText.slice(0, 200)}`)
  let load: any
  try { load = JSON.parse(loadText) } catch { throw new Error(`loadCodeAssist 返回非 JSON: ${loadText.slice(0, 200)}`) }

  let projectId = extractProjectFromLoad(load)
  if (!projectId) {
    const tierId = defaultTierId(load)
    let op: any = await fetch(`${AG_GEN_BASE}/${AG_API_VERSION}:onboardUser`, {
      method: 'POST',
      headers: agHeaders(accessToken),
      body: JSON.stringify({ tier_id: tierId, metadata: { ide_type: 'ANTIGRAVITY', ide_version: AG_IDE_VERSION, ide_name: 'antigravity' } }),
      signal: AbortSignal.timeout(30000),
    }).then((r) => r.json()).catch(() => null)
    for (let i = 0; i < 5 && op && op.done !== true; i++) {
      await sleep(800)
      // 轮询用同一端点重试
      op = await fetch(`${AG_GEN_BASE}/${AG_API_VERSION}:onboardUser`, {
        method: 'POST',
        headers: agHeaders(accessToken),
        body: JSON.stringify({ tier_id: tierId, metadata: { ide_type: 'ANTIGRAVITY', ide_version: AG_IDE_VERSION, ide_name: 'antigravity' } }),
        signal: AbortSignal.timeout(30000),
      }).then((r) => r.json()).catch(() => null)
    }
    projectId = extractProject(op?.response?.cloudaicompanionProject)
  }
  if (!projectId) throw new Error('未能解析 Antigravity 项目 ID（可在渠道配置里手动填写 project）')
  await kv.put(cacheKey, projectId, { expirationTtl: 86400 }).catch(() => {})
  return projectId
}

// =====================================================================
// 请求信封
// =====================================================================

function firstUserText(request: Record<string, any>): string {
  const contents: any[] = Array.isArray(request?.contents) ? request.contents : []
  for (const c of contents) {
    if (c?.role === 'user' && Array.isArray(c.parts)) {
      for (const p of c.parts) if (typeof p?.text === 'string' && p.text) return p.text
    }
  }
  return ''
}

/** 把 Gemini 请求套进 Antigravity 信封（删除 safetySettings，补 userAgent / requestType / requestId / sessionId） */
function buildEnvelope(modelId: string, projectId: string, geminiRequest: Record<string, any>): Record<string, unknown> {
  const request: Record<string, any> = { ...geminiRequest }
  delete request.safetySettings
  const isImage = /image/i.test(modelId)
  // sessionId：Stable 派生自首条用户文本（利于上游会话缓存）
  request.sessionId = isImage ? undefined : `-${randomHex(8)}`
  if (request.sessionId === undefined) delete request.sessionId
  return {
    model: modelId,
    project: projectId,
    userAgent: 'antigravity',
    requestType: isImage ? 'image_gen' : 'agent',
    requestId: isImage ? `image_gen/${Date.now()}/${randomId()}/12` : `agent-${randomId()}`,
    request,
  }
}

// =====================================================================
// 对外入口
// =====================================================================

export interface AntigravityCallParams {
  env: Env
  providerId: string
  modelId: string
  requestedModel: string
  body: Record<string, any>
  refreshTokens: string[]
  project?: string
  maskedToken: string
  startedAt: number
  waitUntil?: (promise: Promise<unknown>) => void
}

async function readErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const json = JSON.parse(text) as { error?: { message?: string }; message?: string }
    return json.error?.message || json.message || text
  } catch { return text }
}

async function recordUsage(p: AntigravityCallParams, usage: AgUsage, ok: boolean, status: number): Promise<void> {
  // 用量由 routes/chat.ts 统一记账
}

/** 解析渠道 apiKeys 里的一行账号：`refresh_token` 或 `refresh_token|project`。
 *  Google 的 refresh_token 是 URL-safe 字符集、不含 `|`，故 `|` 作分隔符是安全的。
 *  单独指定了 project 的账号优先用它，未指定的回落到渠道级 project。 */
export function parseAgAccount(raw: string): { token: string; project?: string } {
  const text = (raw || '').trim()
  const sep = text.indexOf('|')
  if (sep < 0) return { token: text }
  const project = text.slice(sep + 1).trim()
  return { token: text.slice(0, sep).trim(), project: project || undefined }
}

/** 随机打散账号顺序(负载均衡): 每个请求先用随机账号, 失败再依次尝试其余账号。
 *  避免所有请求都压在第一个账号上, 让多账号的免费额度均匀消耗。
 *  返回的 index 是账号在渠道配置里的原始序号(1 起), 用于 x-ag-account 观测头。 */
function shuffleAccounts(list: string[]): Array<{ token: string; project?: string; index: number }> {
  const arr = list
    .map((raw, i) => {
      const { token, project } = parseAgAccount(raw)
      return { token, project, index: i + 1 }
    })
    .filter((a) => a.token)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

// ===== 账号冷却：避免每个请求都在「已知没额度」的账号上白等 =====
//
// 背景：Google 按账号计配额，耗尽后该账号对任何请求都只会返 429。原先的纯随机顺序
// 会让每个请求都先撞上这些账号，逐个重试几分钟量级的失败才轮到能用的账号 —— 实测一次
// 请求仅响应头就要等 6~12 秒，客户端表现为「卡住/重连」。
//
// 做法：把「仍在冷却期」的账号排到队尾（不是剔除！）。健康账号之间照旧随机轮换，
// 配额消耗依旧摊开；冷却账号在其余账号都失败时仍会被尝试，所以不会出现「本来能成功
// 的请求因为跳过而失败」；冷却到期自动回到正常轮换池。冷却时长优先取上游报的重置时间。

export type AgAccountHealth = {
  /** 冷却截止时间戳(Date.now())，早于当前时间即视为已恢复 */
  cooldownUntil: number
  /** 最近一次被冷却的原因，便于排查 */
  reason?: string
}

export type AgHealthMap = Record<string, AgAccountHealth>

const AG_HEALTH_KEY = (providerId: string) => AG_HEALTH_PREFIX + providerId

/** 配额耗尽但上游没给重置时间时的兜底冷却时长 */
const AG_COOLDOWN_QUOTA_MS = 30 * 60 * 1000
/** 凭据/权限问题（401/403）不会在几分钟内自愈 */
const AG_COOLDOWN_AUTH_MS = 60 * 60 * 1000
/** 5xx、网络错误等瞬时故障，短冷却即可 */
const AG_COOLDOWN_TRANSIENT_MS = 5 * 60 * 1000

async function readAgHealth(env: Env, providerId: string): Promise<AgHealthMap> {
  try {
    const raw = await getKV(env).get(AG_HEALTH_KEY(providerId))
    return raw ? (JSON.parse(raw) as AgHealthMap) : {}
  } catch {
    return {}
  }
}

async function writeAgHealth(env: Env, providerId: string, health: AgHealthMap): Promise<void> {
  const now = Date.now()
  // 只留仍在冷却中的账号，避免 KV 膨胀
  const kept: AgHealthMap = {}
  for (const [k, v] of Object.entries(health)) {
    if (v && v.cooldownUntil > now) kept[k] = v
  }
  try {
    if (Object.keys(kept).length > 0) {
      await getKV(env).put(AG_HEALTH_KEY(providerId), JSON.stringify(kept))
    } else {
      await getKV(env).delete(AG_HEALTH_KEY(providerId))
    }
  } catch { /* 冷却状态写失败不影响本次转发 */ }
}

/** 从上游错误文本里解析重置倒计时，如 "Resets in 23h52m40s" / "Resets in 2h" / "Resets in 15m"。 */
export function parseQuotaResetMs(text: string): number | null {
  const m = /reset[s]?\s+in\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i.exec(text || '')
  if (!m) return null
  const h = Number(m[1] || 0)
  const mi = Number(m[2] || 0)
  const s = Number(m[3] || 0)
  const ms = ((h * 60 + mi) * 60 + s) * 1000
  return ms > 0 ? ms : null
}

/**
 * 按冷却状态重排账号：可用（洗牌）→ 冷却已到期（试用）→ 仍在冷却（队尾兜底）。
 * 三组都会参与尝试，只改顺序，保证故障转移能力不下降。
 */
export function orderByCooldown<T extends { hash: string }>(accounts: T[], health: AgHealthMap): T[] {
  const now = Date.now()
  const healthy: T[] = []
  const probation: T[] = []
  const cooling: T[] = []
  for (const a of accounts) {
    const h = health[a.hash]
    if (!h?.cooldownUntil) healthy.push(a)
    else if (now >= h.cooldownUntil) probation.push(a)
    else cooling.push(a)
  }
  const shuffle = (arr: T[]): void => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = arr[i]
      arr[i] = arr[j]
      arr[j] = tmp
    }
  }
  shuffle(healthy)
  shuffle(probation)
  shuffle(cooling)
  return [...healthy, ...probation, ...cooling]
}

export async function handleAntigravityRequest(p: AntigravityCallParams): Promise<Response> {
  const parsed = shuffleAccounts((p.refreshTokens || []).filter((t) => t && t.trim()))
  if (parsed.length === 0) {
    return errorResponse('该 antigravity 渠道未配置凭据：请在「API Key」里每行填入一个 Google 账号的 Antigravity refresh_token（可点「用 Google 账号授权」获取；需要给某个账号单独指定项目 ID 时写成 refresh_token|项目ID）', 400, 'configuration_error')
  }
  // 账号以 refresh_token 的 sha256 作为健康状态键，避免把凭据明文写进 KV
  const accounts = await Promise.all(
    parsed.map(async (a) => ({ ...a, hash: await sha256Hex(a.token) })),
  )
  const health = await readAgHealth(p.env, p.providerId)
  const ordered = orderByCooldown(accounts, health)
  let healthChanged = false
  const coolingCount = ordered.filter((a) => {
    const h = health[a.hash]
    return !!h?.cooldownUntil && Date.now() < h.cooldownUntil
  }).length
  if (coolingCount > 0) {
    console.log(`[antigravity] ${p.providerId}: ${coolingCount}/${ordered.length} account(s) in cooldown, tried last`)
  }
  /** 记录一次失败并写入冷却（成功则清除该账号的冷却） */
  const markFailed = (hash: string, reason: string, cooldownMs: number): void => {
    health[hash] = { cooldownUntil: Date.now() + cooldownMs, reason }
    healthChanged = true
  }
  const markOk = (hash: string): void => {
    if (health[hash]) {
      delete health[hash]
      healthChanged = true
    }
  }
  const persistHealth = async (): Promise<void> => {
    if (healthChanged) {
      healthChanged = false
      await writeAgHealth(p.env, p.providerId, health)
    }
  }
  const wantStream = p.body?.stream === true
  const translateOpts = { modelId: p.modelId }
  const { request: geminiRequest, nameMap } = openAIToGeminiRequest(p.body, translateOpts)
  let lastError = ''
  let lastStatus = 502


  for (let i = 0; i < ordered.length; i++) {
    const { token: refreshToken, project: accountProject, index: accountIndex, hash } = ordered[i]
    try {
      const accessToken = await getAccessToken(p.env, refreshToken)
      // 账号自己带的 project 优先，其次才是渠道级 project
      const projectId = await resolveProjectId(p.env, accessToken, hash, accountProject || p.project)
      const envelope = buildEnvelope(p.modelId, projectId, geminiRequest)
      const url = `${AG_GEN_BASE}/${AG_API_VERSION}:${wantStream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
      const upstream = await fetch(url, {
        method: 'POST',
        headers: agHeaders(accessToken),
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(300000),
      })

      if (!upstream.ok) {
        lastStatus = upstream.status
        const detail = (await readErrorBody(upstream)).slice(0, 300)
        lastError = `HTTP ${upstream.status}: ${detail}`
        if ([401, 403, 429].includes(upstream.status) || upstream.status >= 500) {
          // 429 通常是按账号的配额耗尽：冷却到上游给出的重置时间，别再让后续请求白撞
          if (upstream.status === 429) {
            const reset = parseQuotaResetMs(detail)
            markFailed(hash, `429 ${detail.slice(0, 120)}`, reset ? reset + 60_000 : AG_COOLDOWN_QUOTA_MS)
          } else if (upstream.status === 401 || upstream.status === 403) {
            markFailed(hash, `${upstream.status} ${detail.slice(0, 120)}`, AG_COOLDOWN_AUTH_MS)
          } else {
            markFailed(hash, `${upstream.status} ${detail.slice(0, 120)}`, AG_COOLDOWN_TRANSIENT_MS)
          }
          continue
        }
        await persistHealth()
        return errorResponse(lastError, upstream.status, 'upstream_error')
      }

      markOk(hash)
      await persistHealth()

      if (wantStream && upstream.body) {
        const stream = createOpenAIStream(upstream.body, p.requestedModel, nameMap, () => {}, (finalUsage) => {
          const task = recordUsage(p, finalUsage as AgUsage, true, 200)
          if (p.waitUntil) { try { p.waitUntil(task) } catch { task.catch(() => {}) } } else { task.catch(() => {}) }
        }, translateOpts)
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'x-ag-account': String(accountIndex), 'x-ag-cooldown': String(coolingCount) },
        })
      }

      const rawText = await upstream.text()
      let json: unknown
      try { json = JSON.parse(rawText) } catch { return errorResponse(`上游返回非 JSON: ${rawText.slice(0, 200)}`, 502, 'upstream_error') }
      const openai = geminiResponseToOpenAI(json, p.requestedModel, nameMap, translateOpts)
      const usage = extractUsage(json)
      await recordUsage(p, usage, true, 200)
      return new Response(JSON.stringify(openai), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'x-ag-account': String(accountIndex), 'x-ag-cooldown': String(coolingCount) },
      })
    } catch (err) {
      lastError = (err as Error).message || '未知错误'
      lastStatus = 502
      markFailed(hash, `exception ${lastError.slice(0, 120)}`, AG_COOLDOWN_TRANSIENT_MS)
      continue
    }
  }
  await persistHealth()
  return errorResponse(`所有 Antigravity 账号均失败，最后一次错误: ${lastError || '未知'}`, lastStatus, 'key_exhausted')
}

function extractUsage(body: unknown): AgUsage {
  const data = (body && typeof body === 'object' && 'response' in (body as Record<string, unknown>))
    ? (body as { response: Record<string, unknown> }).response
    : (body as Record<string, unknown>)
  const meta = (data?.usageMetadata || {}) as Record<string, unknown>
  const n = (v: unknown) => Number(v) || 0
  return { promptTokens: n(meta.promptTokenCount), completionTokens: n(meta.candidatesTokenCount) }
}

// =====================================================================
// 后台：连通性测试 / 可用模型
// =====================================================================

export async function testAntigravity(
  env: Env,
  refreshToken: string,
  modelId: string,
  project?: string,
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  if (!refreshToken) return { success: false, message: '未填写 refresh_token', statusCode: 0 }
  try {
    const { token, project: accountProject } = parseAgAccount(refreshToken)
    if (!token) return { success: false, message: '未填写 refresh_token', statusCode: 0 }
    const hash = await sha256Hex(token)
    const accessToken = await getAccessToken(env, token)
    const projectId = await resolveProjectId(env, accessToken, hash, accountProject || project)
    const { request: geminiRequest } = openAIToGeminiRequest({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 })
    const envelope = buildEnvelope(modelId, projectId, geminiRequest)
    const res = await fetch(`${AG_GEN_BASE}/${AG_API_VERSION}:generateContent`, {
      method: 'POST',
      headers: agHeaders(accessToken),
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(30000),
    })
    if (res.ok) return { success: true, message: `连接成功（project: ${projectId}）`, statusCode: 200 }
    return { success: false, message: `HTTP ${res.status}: ${(await readErrorBody(res)).slice(0, 200)}`, statusCode: res.status }
  } catch (err) {
    return { success: false, message: (err as Error).message || '连接失败' }
  }
}

export async function testAntigravityRotating(
  env: Env,
  refreshTokens: string[],
  modelId: string,
  project?: string,
): Promise<{ success: boolean; message: string; statusCode?: number; keyIndex?: number }> {
  const list = (refreshTokens || []).filter((t) => t && t.trim())
  if (list.length === 0) return { success: false, message: '该渠道未配置任何 refresh_token', statusCode: 0 }
  let last: { success: boolean; message: string; statusCode?: number } = { success: false, message: '连接失败', statusCode: 0 }
  for (let i = 0; i < list.length; i++) {
    const r = await testAntigravity(env, list[i].trim(), modelId, project)
    if (r.success) {
      return { ...r, keyIndex: i, message: list.length > 1 ? `${r.message} (账号 #${i + 1}/${list.length})` : r.message }
    }
    last = r
    const st = r.statusCode || 0
    if (st === 429 || st === 401 || st === 403 || st >= 500) continue
    break
  }
  return last
}

/** 拉取 Antigravity 可用模型（fetchAvailableModels），尽力从多种响应结构里提取模型名 */
export async function fetchAntigravityModels(
  env: Env,
  refreshToken: string,
): Promise<{ success: boolean; models: string[]; message?: string; raw?: unknown }> {
  try {
    const { token } = parseAgAccount(refreshToken)
    if (!token) return { success: false, models: [], message: '未填写 refresh_token' }
    const accessToken = await getAccessToken(env, token)
    const res = await fetch(`${AG_GEN_BASE}/${AG_API_VERSION}:fetchAvailableModels`, {
      method: 'POST',
      headers: agHeaders(accessToken),
      body: '{}',
      signal: AbortSignal.timeout(30000),
    })
    const text = await res.text()
    if (!res.ok) return { success: false, models: [], message: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    let json: any
    try { json = JSON.parse(text) } catch { return { success: false, models: [], message: '返回非 JSON' } }
    const ids = new Set<string>()
    // 主结构: { "models": { "<modelId>": { displayName, quotaInfo, ... } } } —— 模型名是对象的 key
    const modelsObj = json?.models
    if (modelsObj && typeof modelsObj === 'object' && !Array.isArray(modelsObj)) {
      for (const key of Object.keys(modelsObj)) {
        if (/^(chat_|tab_)/i.test(key)) continue
        if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) ids.add(key)
      }
    }
    // 兜底：递归查找 id/name/model 等字段（兼容其他结构）
    if (ids.size === 0) {
      const visit = (node: any, depth = 0) => {
        if (depth > 6 || node == null) return
        if (Array.isArray(node)) { for (const v of node) visit(v, depth + 1); return }
        if (typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) {
            if (typeof v === 'string' && /^(id|name|model|modelId|model_id)$/.test(k) && /^[a-z0-9][a-z0-9._-]*$/i.test(v) && /gemini|claude|gpt|image|flash|pro/i.test(v)) {
              ids.add(v)
            } else {
              visit(v, depth + 1)
            }
          }
        }
      }
      visit(json)
    }
    return { success: true, models: [...ids].sort(), raw: ids.size === 0 ? json : undefined }
  } catch (err) {
    return { success: false, models: [], message: (err as Error).message || '拉取失败' }
  }
}

// =====================================================================
// 额度查看（参照 CLIProxyAPI 的 quota 视图）
//   - loadCodeAssist 取层级与项目
//   - fetchAvailableModels 取每个模型的 quotaInfo.remainingFraction / resetTime
// =====================================================================

export interface AgQuotaModel {
  id: string
  name?: string
  /** 剩余配额比例 0~1，null 表示上游未提供 */
  remaining: number | null
  resetTime?: string
  recommended?: boolean
  supportsThinking?: boolean
}

export interface AgQuotaAccount {
  index: number
  ok: boolean
  error?: string
  /** 当前配置层（currentTier），如 "Antigravity"；免费账号一律是 free-tier */
  tier?: string
  tierId?: string
  /** 订阅层（paidTier）—— Google 把套餐信息放在这里，与 currentTier 是两回事：
   *  `g1-pro-tier` = Google AI Pro 已生效；`free-tier`/「Antigravity Starter Quota」= 没有套餐加成 */
  paidTier?: string
  paidTierId?: string
  /** Google 关于该账号订阅/资格的原话（未生效时才有），tierNoteUrl 是它给的说明链接 */
  tierNote?: string
  tierNoteUrl?: string
  /** 不具备某个层资格的原因（如 UNSUPPORTED_LOCATION = 所在地区不支持） */
  ineligible?: string
  /** 账号邮箱（读 userinfo 得到，用于确认这一行 token 属于哪个 Google 账号） */
  email?: string
  project?: string
  models: AgQuotaModel[]
}

/** 从 loadCodeAssist 响应里提取层级/订阅/资格信息（纯函数，便于单测） */
export function agTierInfo(load: any): {
  tier?: string
  tierId?: string
  paidTier?: string
  paidTierId?: string
  tierNote?: string
  tierNoteUrl?: string
  ineligible?: string
} {
  const cur = load?.currentTier
  const paid = load?.paidTier
  const allowed: any[] = Array.isArray(load?.allowedTiers) ? load.allowedTiers : []
  const fallback = allowed.find((t) => t?.isDefault) || allowed[0]
  const inelig: any = Array.isArray(load?.ineligibleTiers) ? load.ineligibleTiers[0] : undefined
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

  const tierId = str(cur?.id) || str(fallback?.id)
  const paidTierId = str(paid?.id)
  // paidTier 与当前层相同 = 没有生效的套餐加成，此时 Google 会给一句解释
  const subscribed = !!paidTierId && paidTierId !== 'free-tier' && paidTierId !== tierId

  return {
    tier: str(cur?.name) || str(fallback?.name),
    tierId,
    paidTier: str(paid?.name),
    paidTierId,
    tierNote: subscribed ? undefined : str(paid?.upgradeSubscriptionText),
    tierNoteUrl: subscribed ? undefined : str(paid?.upgradeSubscriptionUri),
    ineligible: inelig ? `${str(inelig.reasonCode) || 'INELIGIBLE'}: ${str(inelig.reasonMessage) || ''}`.trim() : undefined,
  }
}

/** 查询渠道各账号的额度使用情况（账号数不设上限，与后台面板列出的账号数一致）。
 *  账号多时按 5 个一组并发，避免逐个串行把请求拖长。 */
export async function fetchAntigravityQuota(
  env: Env,
  refreshTokens: string[],
  project?: string,
): Promise<AgQuotaAccount[]> {
  const entries = (refreshTokens || []).map((raw) => parseAgAccount(raw)).filter((e) => e.token)
  // 层级/订阅/邮箱每个账号要额外两次上游调用；账号多时省掉它们（只少显示身份信息，不影响额度数据）
  const withIdentity = entries.length <= 10
  const out: AgQuotaAccount[] = new Array(entries.length)
  const CHUNK = 5
  for (let start = 0; start < entries.length; start += CHUNK) {
    const group = entries.slice(start, start + CHUNK)
    const results = await Promise.all(group.map((entry, k) => fetchOneAgQuota(env, entry, start + k, project, withIdentity)))
    results.forEach((r, k) => { out[start + k] = r })
  }
  return out
}

async function fetchOneAgQuota(
  env: Env,
  entry: { token: string; project?: string },
  index: number,
  channelProject: string | undefined,
  withIdentity: boolean,
): Promise<AgQuotaAccount> {
  const account: AgQuotaAccount = { index, ok: false, models: [] }
  try {
    const accessToken = await getAccessToken(env, entry.token)
    const hash = await sha256Hex(entry.token)

    // 层级 / 订阅 / 资格（best-effort，失败不影响配额查询）
    if (withIdentity) {
      try {
        const loadRes = await fetch(`${AG_PROD_BASE}/${AG_API_VERSION}:loadCodeAssist`, {
          method: 'POST',
          headers: agHeaders(accessToken),
          body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
          signal: AbortSignal.timeout(30000),
        })
        if (loadRes.ok) {
          Object.assign(account, agTierInfo(await loadRes.json().catch(() => null)))
        }
      } catch { /* 忽略 */ }

      // 邮箱：用于确认这一行 token 是哪个 Google 账号（Antigravity 授权带 userinfo.email scope）
      try {
        const ui = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(15000),
        })
        if (ui.ok) {
          const info: any = await ui.json().catch(() => null)
          if (typeof info?.email === 'string' && info.email.trim()) account.email = info.email.trim()
        }
      } catch { /* 忽略 */ }
    }

    // 账号自带的 project 优先，其次才是渠道级 project
    account.project = await resolveProjectId(env, accessToken, hash, entry.project || channelProject).catch(() => undefined)

    const res = await fetch(`${AG_GEN_BASE}/${AG_API_VERSION}:fetchAvailableModels`, {
      method: 'POST',
      headers: agHeaders(accessToken),
      body: '{}',
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 150)}`)
    const json: any = JSON.parse(await res.text())
    const modelsObj = json?.models
    if (modelsObj && typeof modelsObj === 'object' && !Array.isArray(modelsObj)) {
      for (const [id, m] of Object.entries<any>(modelsObj)) {
        if (/^(chat_|tab_)/i.test(id)) continue
        const qi = m?.quotaInfo || {}
        account.models.push({
          id,
          name: typeof m?.displayName === 'string' ? m.displayName : undefined,
          remaining: typeof qi.remainingFraction === 'number' ? qi.remainingFraction : null,
          resetTime: typeof qi.resetTime === 'string' ? qi.resetTime : undefined,
          recommended: !!m?.recommended,
          supportsThinking: !!m?.supportsThinking,
        })
      }
      account.models.sort((a, b) => a.id.localeCompare(b.id))
    }
    account.ok = true
  } catch (err) {
    account.error = (err as Error).message || '查询失败'
  }
  return account
}
