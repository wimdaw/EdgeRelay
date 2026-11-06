/**
 * CodeBuddy (腾讯) OAuth 反代 (provider.type = 'codebuddy')
 *
 * 移植自 https://github.com/Sliverkiss/workbuddy2api 的上游协议实现（MIT）。
 * 上游是标准 OpenAI 兼容协议，但有几条硬性改写规则，不遵守会直接 400。
 *
 * 1. 授权（设备流，服务端签发 state，无 PKCE）：
 *      POST {base}/v2/plugin/auth/state?platform=CLI   → {data:{state, authUrl}}
 *      浏览器打开 authUrl 完成登录
 *      GET  {base}/v2/plugin/auth/token?state=X        → {data:{accessToken, refreshToken, expiresIn, domain}}
 *      GET  {base}/v2/plugin/login/account?state=X     → {data:{uid, enterpriseId, nickname}}（带 Bearer）
 * 2. access_token 续期：POST {base}/v2/plugin/auth/token/refresh（X-Refresh-Token 头）
 * 3. 对话：POST {base}/v2/chat/completions（OpenAI SSE），**强制 stream:true**；
 *    非流式请求由网关本地聚合为单条响应。
 * 4. 出站 body 必须改写（见 rewriteCodebuddyPayload），出站头必须伪装官方桌面端（见 cbChatHeaders）。
 *
 * 双域：CN     → chat copilot.tencent.com / billing www.codebuddy.cn（Origin/Referer = www.codebuddy.cn）
 *       Global → chat & billing 均为 www.workbuddy.ai（Origin/Referer = www.workbuddy.ai）
 * 区域由渠道 region 字段（cn | global）显式指定；留空时回退按 baseUrl 是否含 workbuddy.ai 判定。
 * 两套账号体系完全独立，凭据不可混用。
 *
 * 渠道 apiKeys 里每行一个 refresh_token（可点后台「授权登录」自动获取）。
 */

import type { Env } from '../types'
import { getKV } from '../storage/blob-store'
import {
  type OAuthCallParams,
  oauthErrorResponse,
  randomHex,
  readErrorBody,
  recordOAuthUsage,
  defer,
  resolveAccessToken,
  putCachedToken,
  sha256Hex,
} from './common'

// =====================================================================
// 上游常量
// =====================================================================

/** 区域标识，与渠道 Provider.region 字段同值 */
export type CbRealm = 'cn' | 'global'

interface CbRegion {
  /** 对话 / 授权 / 模型目录端点基址 */
  base: string
  /** 积分·套餐（billing）端点基址 —— CN 与 chat 不同域，不能混用 */
  billingBase: string
  /** Origin / Referer，同时也作为账号 domain 的兜底值来源 */
  origin: string
  global: boolean
}

const CB_CN: CbRegion = {
  base: 'https://copilot.tencent.com',
  billingBase: 'https://www.codebuddy.cn',
  origin: 'https://www.codebuddy.cn',
  global: false,
}
const CB_GLOBAL: CbRegion = {
  base: 'https://www.workbuddy.ai',
  billingBase: 'https://www.workbuddy.ai',
  origin: 'https://www.workbuddy.ai',
  global: true,
}

/** 官方桌面端客户端版本（UA 的 WorkBuddy/<ver> 段与 X-IDE-Version） */
const CB_CLIENT_VERSION = '5.5.4'
/** 官方内置 CLI 版本（UA 的 CLI/<ver> 段） */
const CB_CLI_VERSION = '2.137.1'
/** 授权类端点（state / token / account）使用的官方 CLI UA */
const CB_LOGIN_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

const CB_STATE_PATH = '/v2/plugin/auth/state?platform=CLI'
const CB_TOKEN_PATH = '/v2/plugin/auth/token'
const CB_ACCOUNT_PATH = '/v2/plugin/login/account'
const CB_REFRESH_PATH = '/v2/plugin/auth/token/refresh'
const CB_CHAT_PATH = '/v2/chat/completions'
/** CN 的模型目录端点；Global 走 /v2/enterprises/personal/models */
const CB_MODELS_PATH_CN = '/console/enterprises/personal/models'
const CB_MODELS_PATH_GLOBAL = '/v2/enterprises/personal/models'
/** 双域通用的模型目录端点（fallback） */
const CB_V3_CONFIG_PATH = '/v3/config'
/**
 * billing 域端点候选，按序尝试（404 或非业务成功则换下一个）。
 * CN：billing 走独立域 www.codebuddy.cn，再兜底回 chat 域；
 * Global：以无 /v2 前缀为主，404 时回退带前缀形态。
 */
interface CbBillingTarget {
  base: string
  path: string
}
/**
 * 按区域生成某个 billing 端点的候选列表。
 * `path` 传 `/meter/xxx` 这样的后缀，函数负责补 `/billing` 与 `/v2/billing` 前缀。
 */
function cbBillingTargets(region: CbRegion, path: string): CbBillingTarget[] {
  if (region.global) {
    return [
      { base: 'https://www.workbuddy.ai', path: '/billing' + path },
      { base: 'https://www.workbuddy.ai', path: '/v2/billing' + path },
    ]
  }
  return [
    { base: 'https://www.codebuddy.cn', path: '/v2/billing' + path },
    { base: 'https://copilot.tencent.com', path: '/v2/billing' + path },
  ]
}
const CB_METER_PATH = '/meter/get-user-resource'
const CB_CHECKIN_PATH = '/meter/daily-checkin'
const CB_METER_CANDIDATES_CN = cbBillingTargets(CB_CN, CB_METER_PATH)
const CB_METER_CANDIDATES_GLOBAL = cbBillingTargets(CB_GLOBAL, CB_METER_PATH)
const CB_CHECKIN_CANDIDATES_CN = cbBillingTargets(CB_CN, CB_CHECKIN_PATH)
const CB_CHECKIN_CANDIDATES_GLOBAL = cbBillingTargets(CB_GLOBAL, CB_CHECKIN_PATH)

/** 定时签到令牌的派生标签（改这个值会让已下发的令牌全部失效） */
const CB_CRON_TOKEN_LABEL = 'codebuddy-checkin-cron-v1'

/** KV key 前缀 */
const CB_AT_PREFIX = 'codebuddy:at:'
const CB_AUTH_PREFIX = 'codebuddy:auth:'
const CB_ACCT_PREFIX = 'codebuddy:acct:'

/** 授权会话有效期（秒） */
const CB_AUTH_TTL = 3600
/** 账号信息缓存有效期（秒） */
const CB_ACCT_TTL = 90 * 24 * 3600

/**
 * 解析渠道区域。显式 region 优先（'global' | 'cn'）；
 * 留空时回退按 baseUrl 判定：含 workbuddy.ai 走 Global，其余（含留空）走 CN（与上游一致）。
 */
export function cbRegion(baseUrl?: string, region?: string): CbRegion {
  if (region === 'global') return CB_GLOBAL
  if (region === 'cn') return CB_CN
  return /workbuddy\.ai/i.test(baseUrl || '') ? CB_GLOBAL : CB_CN
}

/** 区域 → 该区域账号 domain 的兜底值（上游不回 domain 时写入，保证跨会话判定稳定） */
function cbFallbackDomain(region: CbRegion): string {
  return region.global ? 'www.workbuddy.ai' : 'copilot.tencent.com'
}

/** 官方桌面端出站 UA：`WorkBuddy/<cv> <platform>/<cv> CLI/<cli>`（global 平台段为 `WorkBuddy AI`） */
function cbUA(region: CbRegion): string {
  const platform = region.global ? 'WorkBuddy AI' : 'WorkBuddy'
  return `WorkBuddy/${CB_CLIENT_VERSION} ${platform}/${CB_CLIENT_VERSION} CLI/${CB_CLI_VERSION}`
}

/** 授权类端点的通用头（Origin/Referer 随域切换） */
function cbLoginHeaders(origin: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': origin,
    'Referer': origin + '/',
    'User-Agent': CB_LOGIN_UA,
  }
}

/**
 * 按 uid 稳定派生 36 位十六进制设备/会话标识（跨重启恒定、账号间互异）。
 * purpose: 'machine' → X-Machine-ID；'session' → X-Session-ID。
 * 上游按设备指纹缺失/漂移做风控关联，必须每号一台固定虚拟设备。
 */
async function cbStableId(uid: string, purpose: string): Promise<string> {
  return (await sha256Hex(`wb2a:${purpose}:${uid}`)).slice(0, 36)
}

// =====================================================================
// 账号信息（uid / enterpriseId / nickname / domain）
// =====================================================================

export interface CbAccount {
  uid?: string
  enterpriseId?: string
  nickname?: string
  domain?: string
}

async function saveCbAccount(env: Env, refreshToken: string, acct: CbAccount): Promise<void> {
  await getKV(env)
    .put(CB_ACCT_PREFIX + (await sha256Hex(refreshToken)), JSON.stringify(acct), { expirationTtl: CB_ACCT_TTL })
    .catch(() => {})
}

async function getCbAccount(env: Env, refreshToken: string): Promise<CbAccount> {
  const raw = await getKV(env).get(CB_ACCT_PREFIX + (await sha256Hex(refreshToken))).catch(() => null)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as CbAccount
  } catch {
    return {}
  }
}

// =====================================================================
// OAuth 设备流（发起 / 轮询）
// =====================================================================

export interface CbDeviceFlow {
  state: string
  authUrl: string
  realm: CbRealm
}

/** 发起授权：取授权链接并把 state 落 KV（轮询时据此还原域与 base） */
export async function startCodebuddyDeviceFlow(env: Env, baseUrl?: string, region?: string): Promise<CbDeviceFlow> {
  const reg = cbRegion(baseUrl, region)
  const res = await fetch(reg.base + CB_STATE_PATH, {
    method: 'POST',
    headers: cbLoginHeaders(reg.origin),
    body: '{}',
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`授权发起返回非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  const state = String(json?.data?.state || '')
  // 上游偶发不返回 authUrl（国际版更常见），此时按 base 兜底拼一个登录页，避免整个授权流程直接失败
  let authUrl = String(json?.data?.authUrl || '')
  if (json?.code !== 0 || !state) {
    throw new Error(`授权发起失败 code=${json?.code} msg=${json?.msg || text.slice(0, 200)}`)
  }
  if (!authUrl) authUrl = `${reg.base}/login?state=${encodeURIComponent(state)}&platform=CLI`
  const realm: CbRealm = reg.global ? 'global' : 'cn'
  try {
    await getKV(env).put(
      CB_AUTH_PREFIX + state,
      JSON.stringify({ realm, base: reg.base, origin: reg.origin, fallbackDomain: cbFallbackDomain(reg) }),
      { expirationTtl: CB_AUTH_TTL },
    )
  } catch (e) {
    // 存不上后续轮询必然报「会话不存在」，不静默
    console.error('[codebuddy] start store failed', String(e))
    throw new Error('授权会话写入失败(存储异常)，请重试')
  }
  return { state, authUrl, realm }
}

export interface CbPollResult {
  status: 'pending' | 'ok' | 'error'
  message?: string
  refreshToken?: string
  account?: CbAccount
}

/**
 * 轮询授权结果。上游 pending 时业务 code 非 0（"login ing"），HTTP 仍为 200，
 * 故「code != 0」判为 pending；HTTP 5xx / 网络错误才判 error。
 * 成功后顺带取账号信息并把 access_token 预热进缓存（省一次刷新）。
 */
export async function pollCodebuddyDeviceFlow(env: Env, state: string): Promise<CbPollResult> {
  const raw = await getKV(env).get(CB_AUTH_PREFIX + state).catch(() => null)
  if (!raw) return { status: 'error', message: '授权会话不存在或已过期，请重新发起授权' }
  let sess: { realm: string; base: string; origin: string; fallbackDomain?: string; done?: boolean; refreshToken?: string; account?: CbAccount }
  try {
    sess = JSON.parse(raw)
  } catch {
    return { status: 'error', message: '授权会话数据损坏，请重新发起授权' }
  }
  // 幂等：已成功过的会话直接复用结果（避免响应丢失后重试导致 token 丢失）
  if (sess.done && sess.refreshToken) {
    return { status: 'ok', refreshToken: sess.refreshToken, account: sess.account }
  }

  let res: Response
  try {
    res = await fetch(`${sess.base}${CB_TOKEN_PATH}?state=${encodeURIComponent(state)}`, {
      headers: cbLoginHeaders(sess.origin),
      signal: AbortSignal.timeout(30000),
    })
  } catch (e) {
    return { status: 'error', message: `轮询请求失败: ${(e as Error).message}` }
  }
  const text = await res.text()
  if (res.status >= 500) return { status: 'error', message: `上游错误 HTTP ${res.status}: ${text.slice(0, 200)}` }
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    return { status: 'error', message: `轮询返回非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}` }
  }
  if (json?.code !== 0) return { status: 'pending' }
  const data = json?.data || {}
  const accessToken = String(data.accessToken || '')
  const refreshToken = String(data.refreshToken || '')
  if (!accessToken || !refreshToken) return { status: 'pending' }

  // 账号信息（尽力而为，失败不影响授权）
  const account: CbAccount = { domain: String(data.domain || '') }
  // 上游（尤其国际版）常不回 domain：按发起授权时记录的区域兜底，保证后续区域判定与 billing 头稳定
  if (!account.domain) account.domain = sess.fallbackDomain || ''
  try {
    const ar = await fetch(`${sess.base}${CB_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`, {
      headers: { ...cbLoginHeaders(sess.origin), Authorization: 'Bearer ' + accessToken },
      signal: AbortSignal.timeout(20000),
    })
    const aj: any = await ar.json().catch(() => null)
    if (aj && aj.code === 0 && aj.data) {
      account.uid = String(aj.data.uid || '')
      account.enterpriseId = String(aj.data.enterpriseId || '')
      account.nickname = String(aj.data.nickname || '')
    }
  } catch { /* 尽力而为 */ }
  await saveCbAccount(env, refreshToken, account)

  // 预热 access_token 缓存：登录拿到的 token 本身就能用于 chat
  const expiresIn = Number(data.expiresIn) || 0
  if (expiresIn > 0) {
    await putCachedToken(env, CB_AT_PREFIX, refreshToken, {
      accessToken,
      expiresAt: Date.now() + expiresIn * 1000,
      currentRefreshToken: refreshToken,
    }, expiresIn).catch(() => {})
  }

  await getKV(env)
    .put(CB_AUTH_PREFIX + state, JSON.stringify({ ...sess, done: true, refreshToken, account }), { expirationTtl: CB_AUTH_TTL })
    .catch(() => {})
  return { status: 'ok', refreshToken, account }
}

// =====================================================================
// access_token 刷新（KV 缓存 + 链式续期）
// =====================================================================

async function refreshCodebuddyToken(
  region: CbRegion,
  refreshToken: string,
  acct: CbAccount,
): Promise<{ accessToken: string; expiresIn: number; refreshToken?: string }> {
  const headers = cbLoginHeaders(region.origin)
  headers['X-Refresh-Token'] = refreshToken
  headers['X-Auth-Refresh-Source'] = 'plugin'
  if (acct.enterpriseId) headers['X-Enterprise-Id'] = acct.enterpriseId
  const res = await fetch(region.base + CB_REFRESH_PATH, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  if (res.status === 401 || res.status === 403) {
    throw new Error(`refresh_token 已失效 (HTTP ${res.status})，请重新授权`)
  }
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`刷新返回非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`)
  }
  if (json?.code !== 0) throw new Error(`刷新失败 code=${json?.code} msg=${json?.msg || text.slice(0, 160)}`)
  const d = json?.data || {}
  if (!d.accessToken) throw new Error('刷新未返回 accessToken，请重新授权')
  return {
    accessToken: String(d.accessToken),
    expiresIn: Number(d.expiresIn) || 3600,
    refreshToken: d.refreshToken ? String(d.refreshToken) : undefined,
  }
}

/** 取可用的 access_token（命中 KV 缓存则免刷新） */
async function getCbAccess(env: Env, refreshToken: string, region: CbRegion): Promise<{ accessToken: string; account: CbAccount }> {
  const account = await getCbAccount(env, refreshToken)
  const tok = await resolveAccessToken(env, CB_AT_PREFIX, refreshToken, (t) => refreshCodebuddyToken(region, t, account))
  return { accessToken: tok.accessToken, account }
}

// =====================================================================
// 出站请求头
// =====================================================================

/**
 * chat 出站头。除鉴权外还要伪装官方桌面端指纹，否则上游风控会拒：
 *  - X-CodeBuddy-Request: 1 必带
 *  - X-Machine-ID / X-Session-ID 按 uid 稳定派生（每号一台固定虚拟设备）
 *  - X-Agent-Purpose / X-IDE-* / X-Product 用量归属头
 *  - 会话头族（X-Conversation-Request-ID 等）供上游后台按对话轮聚合
 *  - 安全红线：chat 请求绝不携带 X-Refresh-Token
 */
async function cbChatHeaders(
  region: CbRegion,
  accessToken: string,
  acct: CbAccount,
  stream: boolean,
): Promise<Record<string, string>> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': stream ? 'application/json, text/event-stream' : 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': region.origin,
    'Referer': region.origin + '/',
    'User-Agent': cbUA(region),
    'X-CodeBuddy-Request': '1',
    'Accept-Language': region.global ? 'en-US' : 'zh-CN',
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Version': CB_CLIENT_VERSION,
    'X-Product': 'WorkBuddy',
  }
  if (accessToken) h['Authorization'] = 'Bearer ' + accessToken
  else h['X-No-Authorization'] = '1'

  if (acct.uid) {
    h['X-User-Id'] = acct.uid
    h['X-Machine-ID'] = await cbStableId(acct.uid, 'machine')
    h['X-Session-ID'] = await cbStableId(acct.uid, 'session')
  } else {
    h['X-No-User-Id'] = '1'
  }

  if (region.global) {
    // 国际版个人账号无企业 ID，显式声明
    h['X-No-Enterprise-Id'] = '1'
    h['X-Domain'] = 'www.workbuddy.ai'
  } else {
    if (acct.enterpriseId) h['X-Enterprise-Id'] = acct.enterpriseId
    else h['X-No-Enterprise-Id'] = '1'
    if (acct.domain) h['X-Domain'] = acct.domain
    else h['X-No-Department-Info'] = '1'
  }

  // 会话头族：X-Conversation-Request-ID 为对话轮级聚合主键（必发）
  const convReqId = randomHex(16) // 32 hex
  const messageId = randomHex(16)
  h['X-Conversation-Request-ID'] = convReqId
  h['X-Conversation-Message-ID'] = messageId
  h['X-Request-ID'] = messageId
  h['X-Root-Request-ID'] = convReqId
  h['X-Trace-ID'] = convReqId
  h['X-B3-TraceId'] = convReqId
  h['X-B3-SpanId'] = messageId.slice(0, 16)
  h['X-B3-Sampled'] = '1'
  return h
}

/** billing 域（余额/签到）出站头：UA 为单段 `WorkBuddy/<cv>`（官方白名单接口形态） */
function cbBillingHeaders(region: CbRegion, accessToken: string, acct: CbAccount): Record<string, string> {
  const h: Record<string, string> = {
    'Authorization': 'Bearer ' + accessToken,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-CodeBuddy-Request': '1',
    'Accept-Language': region.global ? 'en-US' : 'zh-CN',
    'User-Agent': `WorkBuddy/${CB_CLIENT_VERSION}`,
  }
  if (acct.uid) h['X-User-Id'] = acct.uid
  if (acct.enterpriseId) {
    h['X-Enterprise-Id'] = acct.enterpriseId
    h['X-Tenant-Id'] = acct.enterpriseId
  }
  if (acct.domain) h['X-Domain'] = acct.domain
  return h
}

// =====================================================================
// 出站请求体改写（上游硬性要求，不改会 400）
// =====================================================================

const DEEPSEEK_DEFAULT_EFFORT = 'high'

function isDeepSeekModel(model: unknown): boolean {
  return String(model || '').trim().toLowerCase().startsWith('deepseek')
}

/**
 * 改写发往上游的 chat 请求体：
 *  1. 强制 stream:true（上游拒绝非流式）
 *  2. max_completion_tokens → max_tokens（上游只认旧名）
 *  3. 补 stream_options.include_usage（上游据此在末帧回传 usage）
 *  4. tool_choice 归一（上游该字段是 string，对象形态会 400）
 *  5. developer 角色归一为 system（上游 role 白名单）
 *  6. image_url 字符串 → OpenAI 对象形态（上游只认对象）
 *  7. tool_call ↔ tool 结果配对修复（孤儿项会让整条会话报废）
 *  8. DeepSeek 系模型注入思维链开关
 */
export function rewriteCodebuddyPayload(body: Record<string, any>, modelId: string): Record<string, any> {
  const obj: Record<string, any> = { ...(body || {}), model: modelId }
  obj.stream = true
  translateMaxCompletionTokens(obj)
  if (!('stream_options' in obj)) obj.stream_options = { include_usage: true }
  normalizeToolChoice(obj)
  normalizeRoles(obj)
  normalizeImageUrl(obj)
  if (Array.isArray(obj.messages)) {
    // 先重排（把插在 tool 结果中间的消息挪后），再清理孤儿配对
    obj.messages = cleanupOrphanToolCalls(repackToolResultBlocks(obj.messages))
  }
  injectThinking(obj)
  backfillReasoningContent(obj)
  return obj
}

/** 把 OpenAI 新别名 max_completion_tokens 译为上游认的 max_tokens（显式 max_tokens 优先，别名只删不译） */
function translateMaxCompletionTokens(obj: Record<string, any>): void {
  if (!('max_completion_tokens' in obj)) return
  const alias = obj.max_completion_tokens
  delete obj.max_completion_tokens
  if ('max_tokens' in obj) return
  if (typeof alias === 'number' && alias > 0 && Number.isInteger(alias)) obj.max_tokens = alias
}

/** tool_choice 归一：上游 Go struct 是 string 类型，对象形态会 400 code=11101 */
function normalizeToolChoice(obj: Record<string, any>): void {
  if (!('tool_choice' in obj)) return
  const tc = obj.tool_choice
  const suppress = () => {
    delete obj.tools
    delete obj.functions
  }
  if (typeof tc === 'string') {
    if (tc.trim().toLowerCase() === 'none') {
      delete obj.tool_choice
      suppress()
    }
    return
  }
  if (tc && typeof tc === 'object' && !Array.isArray(tc)) {
    const typ = String(tc.type || '').trim().toLowerCase()
    if (typ === 'none') {
      delete obj.tool_choice
      suppress()
      return
    }
    if (typ === 'auto' || typ === 'required') {
      obj.tool_choice = typ
      return
    }
    if (typ === 'function') {
      const name = String(tc?.function?.name || tc.name || '').trim()
      obj.tool_choice = name || 'auto'
      return
    }
  }
  delete obj.tool_choice
}

/** developer 角色归一为 system（上游 role 白名单不含 developer，命中即 400 code=11128） */
function normalizeRoles(obj: Record<string, any>): void {
  if (!Array.isArray(obj.messages)) return
  for (const m of obj.messages) {
    if (!m || typeof m !== 'object') continue
    if (typeof m.role === 'string' && m.role.trim().toLowerCase() === 'developer') m.role = 'system'
  }
}

/** image_url 字符串形态 → {"url": "..."}（上游只接受对象，字符串会 400 code=11101） */
function normalizeImageUrl(obj: Record<string, any>): void {
  if (!Array.isArray(obj.messages)) return
  for (const m of obj.messages) {
    if (!m || typeof m !== 'object' || !Array.isArray(m.content)) continue
    for (const part of m.content) {
      if (!part || typeof part !== 'object' || part.type !== 'image_url') continue
      if (typeof part.image_url === 'string' && part.image_url) part.image_url = { url: part.image_url }
    }
  }
}

/**
 * 把插在 assistant.tool_calls 与其 tool 结果之间的非 tool 消息挪到整组之后。
 * 并行工具调用时某些客户端会把 notice 类消息插在两份结果中间，上游判
 * 11148（tool_call_sequence_broken）顶死整条会话。只调顺序，不改内容。
 */
function repackToolResultBlocks(messages: any[]): any[] {
  if (!Array.isArray(messages) || messages.length < 3) return messages
  const out: any[] = []
  let changed = false
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    if (!m || typeof m !== 'object' || m.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) {
      out.push(messages[i])
      i++
      continue
    }
    const want = new Set<string>()
    for (const tc of m.tool_calls) {
      if (tc && typeof tc === 'object' && typeof tc.id === 'string' && tc.id) want.add(tc.id)
    }
    out.push(messages[i])
    i++
    const results: any[] = []
    const between: any[] = []
    let sawNonTool = false
    while (i < messages.length) {
      const mm = messages[i]
      if (!mm || typeof mm !== 'object') break
      const role = typeof mm.role === 'string' ? mm.role : ''
      if (role === 'tool') {
        const id = typeof mm.tool_call_id === 'string' ? mm.tool_call_id : ''
        if (!want.has(id)) break
        results.push(messages[i])
        if (sawNonTool) changed = true
        i++
        continue
      }
      if (results.length === 0) break // assistant 后没有结果：交给 cleanupOrphanToolCalls
      // 下一组 assistant.tool_calls 是新组头，不能当插入物吞掉
      if (role === 'assistant' && Array.isArray(mm.tool_calls) && mm.tool_calls.length > 0) break
      between.push(messages[i])
      sawNonTool = true
      i++
    }
    out.push(...results)
    out.push(...between)
  }
  return changed ? out : messages
}

/**
 * 剔除无法配对的 tool_call / tool 结果。
 * OpenAI 兼容协议要求 assistant.tool_calls[].id 与 role:tool 的 tool_call_id 两侧齐全，
 * 缺任一侧上游都 400；而客户端工具执行失败时常把调用写进历史却写不回结果，
 * 导致这条坏历史被反复重放、整条会话报废。这里按 id 对称裁剪让会话自愈。
 */
function cleanupOrphanToolCalls(messages: any[]): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages
  const callIDs = new Set<string>()
  const resultIDs = new Set<string>()
  let hasTraffic = false
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    if (m.role === 'tool') {
      if (typeof m.tool_call_id === 'string' && m.tool_call_id) {
        resultIDs.add(m.tool_call_id)
        hasTraffic = true
      }
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc && typeof tc === 'object' && typeof tc.id === 'string' && tc.id) {
          callIDs.add(tc.id)
          hasTraffic = true
        }
      }
    }
  }
  if (!hasTraffic) return messages
  const keep = new Set<string>()
  for (const id of callIDs) if (resultIDs.has(id)) keep.add(id)

  let changed = false
  // 1) assistant.tool_calls：只留有结果的调用，过滤后为空则删键
  for (const m of messages) {
    if (!m || typeof m !== 'object' || m.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue
    const kept = m.tool_calls.filter((tc: any) => tc && typeof tc === 'object' && typeof tc.id === 'string' && keep.has(tc.id))
    if (kept.length === m.tool_calls.length) continue
    changed = true
    if (kept.length === 0) delete m.tool_calls
    else m.tool_calls = kept
  }
  // 2) role:tool 结果：对应调用被保留才保留
  const keptMsgs: any[] = []
  for (const m of messages) {
    if (m && typeof m === 'object' && m.role === 'tool') {
      const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : ''
      if (!keep.has(id)) {
        changed = true
        continue
      }
    }
    keptMsgs.push(m)
  }
  return changed ? keptMsgs : messages
}

/** 缺 effort 档位时补默认档（已有任一 effort 不覆盖） */
function ensureDeepSeekEffort(obj: Record<string, any>): void {
  if ('reasoning_effort' in obj || 'reasoningEffort' in obj) return
  obj.reasoning_effort = DEEPSEEK_DEFAULT_EFFORT
}

/**
 * DeepSeek 系模型思维链开关：官方客户端「开思考」= thinking.type=enabled + 某档 effort，
 * 缺任一上游都按不思考应答（reasoning_content 为空）。
 */
function injectThinking(obj: Record<string, any>): void {
  if (!isDeepSeekModel(obj.model)) return
  const th = obj.thinking
  const isObj = !!th && typeof th === 'object' && !Array.isArray(th)
  const typ = isObj ? String((th as any).type || '').trim() : ''
  if (typ) {
    if (typ.toLowerCase() === 'disabled') {
      delete obj.reasoning_effort
      delete obj.reasoningEffort
      return
    }
    ensureDeepSeekEffort(obj)
    return
  }
  if (!isObj) obj.thinking = { type: 'enabled' }
  else (th as any).type = 'enabled'
  ensureDeepSeekEffort(obj)
}

/**
 * DeepSeek 多轮一致性：带思维痕迹时保证每条 assistant 消息都有非空
 * reasoning / reasoning_content（部分租户校验 len>0，缺失即 400）。
 */
function backfillReasoningContent(obj: Record<string, any>): void {
  if (!isDeepSeekModel(obj.model)) return
  const msgs = obj.messages
  if (!Array.isArray(msgs) || msgs.length === 0) return
  let thinkingEnabled = false
  if (obj.thinking && typeof obj.thinking === 'object') {
    if (String(obj.thinking.type || '').trim().toLowerCase() === 'enabled') thinkingEnabled = true
  }
  let hasTrace = false
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    if (typeof m.reasoning === 'string' && m.reasoning) { hasTrace = true; break }
    if ('reasoning_content' in m) { hasTrace = true; break }
  }
  if (!thinkingEnabled && !hasTrace) return
  for (const m of msgs) {
    if (!m || typeof m !== 'object' || m.role !== 'assistant') continue
    let rc: string
    if (typeof m.reasoning_content === 'string') rc = m.reasoning_content
    else if (typeof m.reasoning === 'string') { rc = m.reasoning; m.reasoning_content = rc }
    else { rc = ''; m.reasoning_content = rc }
    if (typeof m.reasoning === 'string' && m.reasoning) continue
    m.reasoning = rc || ' '
  }
}

// =====================================================================
// SSE 处理：非流式聚合 / 流式帧规范化
// =====================================================================

interface CbUsage {
  promptTokens: number
  completionTokens: number
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** usage 缺 total_tokens 时按 prompt+completion 补齐（严格校验 schema 的客户端需要） */
function ensureUsageTotal(u: any): any {
  if (!u || typeof u !== 'object') return u
  if ('total_tokens' in u) return u
  if ('prompt_tokens' in u && 'completion_tokens' in u) {
    return { ...u, total_tokens: num(u.prompt_tokens) + num(u.completion_tokens) }
  }
  return u
}

/** 流被截断时 tool_call 的 arguments 是残缺 JSON，下发会让客户端解析卡死 */
function dropTruncatedToolCalls(calls: any[]): any[] {
  return calls.filter((c) => {
    const a = c?.function?.arguments
    if (typeof a !== 'string' || a === '') return true
    try { JSON.parse(a); return true } catch { return false }
  })
}

/**
 * 读取完整上游 SSE 流，聚合为单条 OpenAI chat.completion 响应（非流式请求用）。
 * tool_calls 以流式 delta 到达，按 index 合并（首片带 id/type/name，后续只带 arguments 片段）。
 */
async function aggregateCodebuddyStream(body: ReadableStream<Uint8Array>): Promise<{ response: any; usage: CbUsage }> {
  const text = await new Response(body).text()
  let id = ''
  let model = ''
  let created = 0
  let content = ''
  let reasoning = ''
  let role = 'assistant'
  let finishReason = 'stop'
  let usage: any = null
  let gotAnyContent = false
  let validEvents = 0
  let sawDone = false
  const toolCalls = new Map<number, any>()
  const toolOrder: number[] = []
  let toolSeq = 0
  const idIndex = new Map<string, number>()

  const nextToolIndex = (): number => {
    for (;;) {
      const i = toolSeq++
      if (!toolCalls.has(i)) return i
    }
  }
  const appendContent = (t: string): void => {
    if (!t) return
    content += t
    gotAnyContent = true
  }
  const mergeToolCallDelta = (merged: any, delta: any): void => {
    if (typeof delta.id === 'string' && delta.id) merged.id = delta.id
    if (typeof delta.type === 'string' && delta.type) merged.type = delta.type
    const df = delta.function
    if (!df || typeof df !== 'object') return
    if (!merged.function || typeof merged.function !== 'object') merged.function = {}
    const mf = merged.function
    if (typeof df.name === 'string' && df.name) mf.name = df.name
    if (typeof df.arguments === 'string' && df.arguments) mf.arguments = (mf.arguments || '') + df.arguments
  }
  // 缺 index 的 tool_call 按「id 优先、最近分配兜底」归位，避免多调用被合并进同一槽位
  const mergeToolCallsChunk = (tcs: any[]): void => {
    for (const call of tcs) {
      if (!call || typeof call !== 'object') continue
      let idx = -1
      if (typeof call.index === 'number') idx = call.index
      else if (typeof call.id === 'string' && call.id) {
        if (idIndex.has(call.id)) idx = idIndex.get(call.id) as number
        else idx = nextToolIndex()
      } else if (toolOrder.length > 0) idx = toolOrder[toolOrder.length - 1]
      else idx = nextToolIndex()

      let merged = toolCalls.get(idx)
      if (!merged) {
        merged = { index: idx }
        toolCalls.set(idx, merged)
        toolOrder.push(idx)
      }
      if (typeof call.id === 'string' && call.id) idIndex.set(call.id, idx)
      if (typeof merged.id === 'string' && merged.id) idIndex.set(merged.id, idx)
      mergeToolCallDelta(merged, call)
    }
  }
  const mergeMessageFields = (msg: any): void => {
    if (typeof msg.role === 'string' && msg.role) role = msg.role
    if (typeof msg.content === 'string') appendContent(msg.content)
    if (typeof msg.reasoning_content === 'string') reasoning += msg.reasoning_content
    if (Array.isArray(msg.tool_calls)) mergeToolCallsChunk(msg.tool_calls)
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6)
    if (payload === '[DONE]') {
      sawDone = true
      break
    }
    let chunk: any
    try { chunk = JSON.parse(payload) } catch { continue }
    validEvents++
    if (typeof chunk.id === 'string' && chunk.id && !id) id = chunk.id
    if (typeof chunk.model === 'string' && chunk.model && !model) model = chunk.model
    if (typeof chunk.created === 'number' && !created) created = chunk.created
    if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage
    if (Array.isArray(chunk.choices)) {
      for (const c of chunk.choices) {
        if (!c || typeof c !== 'object') continue
        if (typeof c.finish_reason === 'string' && c.finish_reason) finishReason = c.finish_reason
        if (c.delta && typeof c.delta === 'object') {
          if (typeof c.delta.role === 'string' && c.delta.role) role = c.delta.role
          if (typeof c.delta.content === 'string') appendContent(c.delta.content)
          if (typeof c.delta.reasoning_content === 'string') reasoning += c.delta.reasoning_content
          if (Array.isArray(c.delta.tool_calls)) mergeToolCallsChunk(c.delta.tool_calls)
        }
        // 部分上游把整条 message 放在非 delta 分支（delta 已取过正文则跳过，避免重复拼接）
        if (c.message && typeof c.message === 'object' && !gotAnyContent) mergeMessageFields(c.message)
      }
    }
  }

  if (validEvents === 0) throw new Error('上游返回空流（无有效 SSE 数据帧）')

  const message: any = { role, content }
  if (reasoning) message.reasoning_content = reasoning
  if (toolOrder.length > 0) {
    toolOrder.sort((a, b) => a - b)
    let calls = toolOrder.map((i) => toolCalls.get(i)).filter(Boolean)
    if (finishReason === 'length' || !sawDone) calls = dropTruncatedToolCalls(calls)
    if (calls.length > 0) message.tool_calls = calls
  }
  const resp: any = {
    id: id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(created || Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  }
  if (usage) resp.usage = ensureUsageTotal(usage)
  return {
    response: resp,
    usage: { promptTokens: num(usage?.prompt_tokens ?? usage?.input_tokens), completionTokens: num(usage?.completion_tokens ?? usage?.output_tokens) },
  }
}

/** 每个 index 的 tool_call 只保留首片 name，后续分片删 name 键（对齐 OpenAI 官方流形态） */
function stripToolCallNames(obj: any, seen: Set<number>): void {
  if (!Array.isArray(obj?.choices)) return
  for (const c of obj.choices) {
    const tcs = c?.delta?.tool_calls
    if (!Array.isArray(tcs)) continue
    for (const tc of tcs) {
      if (!tc || typeof tc !== 'object') continue
      const idx = typeof tc.index === 'number' ? tc.index : 0
      if (seen.has(idx)) {
        if (tc.function && typeof tc.function === 'object') delete tc.function.name
        continue
      }
      seen.add(idx)
    }
  }
}

/** 按 OpenAI 流式规范白名单重建帧，剔除上游噪声（空 delta 键、finish_reason:"" 等） */
function normalizeFrame(obj: any): any {
  const out: any = {}
  for (const k of ['id', 'object', 'created', 'model', 'system_fingerprint', 'service_tier']) {
    if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k]
  }
  if (!out.object) out.object = 'chat.completion.chunk'
  if (!out.id) out.id = 'chatcmpl-codebuddy'
  if (Array.isArray(obj.choices)) {
    out.choices = obj.choices.map((c: any) => {
      const nc: any = {}
      if (c?.index !== undefined) nc.index = c.index
      const delta: any = {}
      const d = c?.delta
      if (d && typeof d === 'object') {
        if (typeof d.role === 'string' && d.role) delta.role = d.role
        if (typeof d.content === 'string' && d.content) delta.content = d.content
        if (typeof d.reasoning_content === 'string' && d.reasoning_content) delta.reasoning_content = d.reasoning_content
        if (typeof d.refusal === 'string' && d.refusal) delta.refusal = d.refusal
        if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) delta.tool_calls = d.tool_calls
        if (d.function_call != null) {
          const fc = d.function_call
          const keep = typeof fc === 'object'
            ? !!(fc.name || fc.arguments)
            : true
          if (keep) delta.function_call = fc
        }
      }
      nc.delta = delta
      nc.finish_reason = typeof c?.finish_reason === 'string' && c.finish_reason ? c.finish_reason : null
      return nc
    })
  }
  out.usage = obj.usage !== undefined ? obj.usage : null
  return out
}

/**
 * 逐帧规范化透传上游 SSE，并保证恰好写出一个 [DONE]。
 * 返回规范化后的流 + 一个在流结束时兑现的 usage Promise（供用量记录）。
 */
function normalizeCodebuddyStream(src: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>
  done: Promise<CbUsage>
} {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buf = ''
  const toolSeen = new Set<number>()
  let firstId = ''
  let validFrames = 0
  let sawDone = false
  let usage: CbUsage = { promptTokens: 0, completionTokens: 0 }
  let resolveDone: (u: CbUsage) => void = () => {}
  const done = new Promise<CbUsage>((res) => { resolveDone = res })

  const handleLine = (line: string): string => {
    if (sawDone) return ''
    if (line.startsWith('data: [DONE]')) {
      sawDone = true
      return '' // [DONE] 统一在 flush 阶段写出，保证恰好一个
    }
    if (line.startsWith('data: ')) {
      const payload = line.slice(6)
      let obj: any
      try {
        obj = JSON.parse(payload)
      } catch {
        return 'data: ' + payload + '\n\n'
      }
      // 上游错误帧（限流/审核拦截）原样透传，白名单会剥掉 error 字段
      if (obj && typeof obj === 'object' && obj.error) {
        validFrames++
        return 'data: ' + payload + '\n\n'
      }
      if (obj?.usage && typeof obj.usage === 'object') {
        usage = {
          promptTokens: num(obj.usage.prompt_tokens ?? obj.usage.input_tokens),
          completionTokens: num(obj.usage.completion_tokens ?? obj.usage.output_tokens),
        }
      }
      stripToolCallNames(obj, toolSeen)
      // id 续传：首帧非空真实 id 缓存，后续缺 id 的帧复用，避免同一流 id 分裂
      if (!firstId) {
        if (typeof obj?.id === 'string' && obj.id) firstId = obj.id
      } else if (typeof obj?.id !== 'string' || !obj.id) {
        obj.id = firstId
      }
      validFrames++
      return 'data: ' + JSON.stringify(normalizeFrame(obj)) + '\n\n'
    }
    if (line !== '') return line + '\n' // 注释/其他行原样透传
    return ''
  }

  const stream = src.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buf += decoder.decode(chunk, { stream: true })
        let nl = buf.indexOf('\n')
        while (nl >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          const out = handleLine(line)
          if (out) controller.enqueue(encoder.encode(out))
          nl = buf.indexOf('\n')
        }
      },
      flush(controller) {
        if (buf) {
          const out = handleLine(buf.replace(/\r$/, ''))
          if (out) controller.enqueue(encoder.encode(out))
          buf = ''
        }
        // 空流兜底：先补一帧 error（绕过白名单保留 error 字段），再补 [DONE]
        if (validFrames === 0) {
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({
            error: { message: 'empty upstream stream', type: 'upstream_error', code: 'upstream_parse' },
          }) + '\n\n'))
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        resolveDone(usage)
      },
    }),
  )
  return { stream, done }
}

// =====================================================================
// 对外入口：chat 反代
// =====================================================================

/** regionCode: 渠道配置的区域（'cn' | 'global'）；留空则回退按 baseUrl 判定 */
export async function handleCodebuddyRequest(p: OAuthCallParams, baseUrl?: string, regionCode?: string): Promise<Response> {
  const tokens = (p.refreshTokens || []).filter((t) => t && t.trim())
  if (tokens.length === 0) {
    return oauthErrorResponse(
      '该 codebuddy 渠道未配置凭据：请在「API Keys」里每行填入一个 refresh_token（可点「授权登录」自动获取）',
      400,
      'configuration_error',
    )
  }

  const region = cbRegion(baseUrl, regionCode)
  const wantStream = (p.body as any)?.stream === true
  const upstreamBody = rewriteCodebuddyPayload(p.body, p.modelId)

  let lastError = ''
  let lastStatus = 502

  for (const refreshToken of tokens) {
    try {
      const { accessToken, account } = await getCbAccess(p.env, refreshToken, region)
      const headers = await cbChatHeaders(region, accessToken, account, wantStream)
      const upstream = await fetch(region.base + CB_CHAT_PATH, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(600000),
      })
      if (!upstream.ok) {
        lastStatus = upstream.status
        lastError = `HTTP ${upstream.status}: ${(await readErrorBody(upstream)).slice(0, 300)}`
        // 鉴权失效 / 限流 / 上游故障 → 换下一个凭据
        if ([401, 403, 429].includes(upstream.status) || upstream.status >= 500) continue
        return oauthErrorResponse(lastError, upstream.status, 'upstream_error')
      }
      if (!upstream.body) {
        lastError = '上游未返回响应体'
        lastStatus = 502
        continue
      }

      if (wantStream) {
        const { stream, done } = normalizeCodebuddyStream(upstream.body)
        defer(p, done.then((u) => recordOAuthUsage(p, u, true, 200)))
        return new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          },
        })
      }

      // 非流式：上游强制 stream，这里本地聚合为单条响应
      const agg = await aggregateCodebuddyStream(upstream.body)
      defer(p, recordOAuthUsage(p, agg.usage, true, 200))
      return new Response(JSON.stringify(agg.response), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    } catch (err) {
      lastError = (err as Error).message || '未知错误'
      lastStatus = 502
      continue
    }
  }

  return oauthErrorResponse(`所有 CodeBuddy 账号均失败，最后一次错误: ${lastError || '未知'}`, lastStatus, 'key_exhausted')
}

// =====================================================================
// 后台：连通性测试 / 模型列表 / 账号状态
// =====================================================================

export async function testCodebuddy(
  env: Env,
  refreshToken: string,
  modelId: string,
  baseUrl?: string,
  regionCode?: string,
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  if (!refreshToken) return { success: false, message: '未填写 refresh_token', statusCode: 0 }
  const region = cbRegion(baseUrl, regionCode)
  try {
    const { accessToken, account } = await getCbAccess(env, refreshToken, region)
    const headers = await cbChatHeaders(region, accessToken, account, true)
    const res = await fetch(region.base + CB_CHAT_PATH, {
      method: 'POST',
      headers,
      body: JSON.stringify(rewriteCodebuddyPayload({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }, modelId)),
      signal: AbortSignal.timeout(60000),
    })
    if (res.ok) {
      // 消费掉 body 避免连接悬挂
      await res.text().catch(() => '')
      return { success: true, message: '连接成功', statusCode: 200 }
    }
    return { success: false, message: `HTTP ${res.status}: ${(await readErrorBody(res)).slice(0, 200)}`, statusCode: res.status }
  } catch (err) {
    return { success: false, message: (err as Error).message || '连接失败' }
  }
}

/** 拉取可用模型：CN 走 /console/enterprises/personal/models，Global 走 /v2/...，失败回退 /v3/config */
export async function fetchCodebuddyModels(
  env: Env,
  refreshToken: string,
  baseUrl?: string,
  regionCode?: string,
): Promise<{ success: boolean; models: string[]; message?: string }> {
  const region = cbRegion(baseUrl, regionCode)
  try {
    const { accessToken, account } = await getCbAccess(env, refreshToken, region)
    const headers = await cbChatHeaders(region, accessToken, account, false)
    const primary = region.global ? CB_MODELS_PATH_GLOBAL : CB_MODELS_PATH_CN
    const tried = [primary, CB_V3_CONFIG_PATH]
    let lastMsg = ''
    for (const path of tried) {
      const res = await fetch(region.base + path, { method: 'GET', headers, signal: AbortSignal.timeout(30000) })
      const text = await res.text()
      if (!res.ok) {
        lastMsg = `HTTP ${res.status}: ${text.slice(0, 160)}`
        continue
      }
      let json: any
      try { json = JSON.parse(text) } catch { lastMsg = '返回非 JSON'; continue }
      const models = extractModelIds(json)
      if (models.length > 0) return { success: true, models }
      lastMsg = '上游未返回模型列表'
    }
    return { success: false, models: [], message: `${lastMsg}，请手动填写模型 ID（如 deepseek-v4.1-flash）` }
  } catch (err) {
    return { success: false, models: [], message: (err as Error).message || '拉取失败' }
  }
}

/**
 * 从模型目录响应里提取模型 ID。
 * 优先用 data.agents[name='cli'].models（官方 CLI 的权威对话模型清单），
 * 再用 data.models 里的条目补全；都不匹配时兜底扫 data.models[].id。
 */
function extractModelIds(json: any): string[] {
  const data = json?.data
  if (!data || typeof data !== 'object') return []
  const out: string[] = []
  const push = (v: unknown) => {
    const s = String(v ?? '').trim()
    if (s && !out.includes(s)) out.push(s)
  }
  const agents = Array.isArray(data.agents) ? data.agents : []
  const cli = agents.find((a: any) => a && typeof a === 'object' && a.name === 'cli')
  if (cli && Array.isArray(cli.models)) for (const m of cli.models) push(m)
  const models = Array.isArray(data.models) ? data.models : []
  const disabled = new Set<string>()
  for (const m of models) {
    if (m && typeof m === 'object' && m.disabled) {
      const id = String(m.id ?? m.model ?? m.name ?? '').trim()
      if (id) disabled.add(id)
    }
  }
  for (const m of models) {
    const id = typeof m === 'string' ? m : String(m?.id ?? m?.model ?? m?.modelName ?? m?.name ?? '').trim()
    if (id && !disabled.has(id)) push(id)
  }
  return out
}

// =====================================================================
// 后台：账号状态（积分/套餐余额）
// =====================================================================

export interface CbPackageInfo {
  name: string
  remain: number
  used: number
  size: number
  endTime: string
}

export interface CbAccountStatus {
  ok: boolean
  message?: string
  nickname?: string
  uid?: string
  enterpriseId?: string
  realm?: string
  /** 剩余可用积分 */
  remain?: number
  /** 已用积分 */
  used?: number
  /** 总量 */
  size?: number
  /** 套餐数 */
  packs?: number
  packages?: CbPackageInfo[]
}

/** 单套餐的 remain/used/size 聚合：周期型套餐优先用 Cycle 字段（与上游口径一致） */
function packageRemainUsed(a: {
  CapacityRemain?: number; CapacityUsed?: number; CapacitySize?: number
  CycleCapacityRemain?: number; CycleCapacityUsed?: number; CycleCapacitySize?: number
}): { remain: number; used: number; size: number } {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const cycleSize = n(a.CycleCapacitySize)
  if (cycleSize > 0) {
    let remain = n(a.CycleCapacityRemain)
    const size = cycleSize
    if (remain < 0) remain = 0
    if (remain > size) remain = size
    let used = size - remain
    const cycleUsed = n(a.CycleCapacityUsed)
    if (cycleUsed > used) {
      used = cycleUsed
      if (size >= used) remain = size - used
    }
    return { remain, used, size }
  }
  const remain = n(a.CapacityRemain)
  let used = n(a.CapacityUsed)
  const size = n(a.CapacitySize)
  if (used === 0 && size > remain) used = size - remain
  return { remain, used, size }
}

/** 查询账号积分/套餐余额（后台展示用）。 */
export async function fetchCodebuddyStatus(env: Env, refreshToken: string, baseUrl?: string, regionCode?: string): Promise<CbAccountStatus> {
  if (!refreshToken) return { ok: false, message: '未填写 refresh_token' }
  const region = cbRegion(baseUrl, regionCode)
  try {
    const { accessToken, account } = await getCbAccess(env, refreshToken, region)
    const headers = cbBillingHeaders(region, accessToken, account)

    const now = new Date()
    const pad = (x: number) => String(x).padStart(2, '0')
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    const body = {
      PageNumber: 1,
      PageSize: 100,
      ProductCode: 'p_tcaca',
      Status: [0, 3],
      PackageEndTimeRangeBegin: fmt(now),
      PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
    }

    const targets = region.global ? CB_METER_CANDIDATES_GLOBAL : CB_METER_CANDIDATES_CN
    let lastMsg = ''
    for (const target of targets) {
      const res = await fetch(target.base + target.path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      const text = await res.text()
      if (res.status === 404) {
        lastMsg = `HTTP 404: ${text.slice(0, 120)}`
        continue // 该域/前缀不存在：CN 的 billing 独立域、Global 的 /v2 前缀差异，换下一个候选
      }
      let json: any
      try { json = JSON.parse(text) } catch {
        return { ok: false, message: `返回非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}` }
      }
      if (!res.ok || json?.code !== 0) {
        return { ok: false, message: `HTTP ${res.status} code=${json?.code} msg=${json?.msg || text.slice(0, 160)}` }
      }
      // 上游信封：data.Response.Data.{TotalDosage, Accounts[]}
      const inner = json?.data?.Response?.Data || json?.data?.data || json?.data || {}
      const accounts: any[] = Array.isArray(inner.Accounts) ? inner.Accounts : []
      let remain = 0
      let used = 0
      let size = 0
      const packages: CbPackageInfo[] = []
      for (const a of accounts) {
        const r = packageRemainUsed(a)
        remain += r.remain
        used += r.used
        size += r.size
        packages.push({
          name: String(a?.PackageName || '套餐'),
          remain: r.remain,
          used: r.used,
          size: r.size,
          endTime: String(a?.CycleEndTime || ''),
        })
      }
      // TotalDosage 作 size 下限（已消耗的不该比总剂量小）
      const dosage = Number(inner.TotalDosage) || 0
      if (size > 0 && size - remain > used) used = size - remain
      if (dosage > size) {
        size = dosage
        if (size - remain > used) used = size - remain
      }
      return {
        ok: true,
        nickname: account.nickname,
        uid: account.uid,
        enterpriseId: account.enterpriseId,
        realm: region.global ? 'global' : 'cn',
        remain,
        used,
        size,
        packs: packages.length,
        packages: packages.slice(0, 20),
      }
    }
    return { ok: false, message: lastMsg || '查询失败' }
  } catch (err) {
    return { ok: false, message: (err as Error).message || '查询失败' }
  }
}

// =====================================================================
// 每日签到
// =====================================================================

export interface CbCheckinResult {
  ok: boolean
  message?: string
  /** 今日已签到（上游把它当业务错误返回，这里识别为成功状态） */
  already?: boolean
  realm?: string
  nickname?: string
  uid?: string
  /** 上游回传的本次奖励积分（拿不到就不带） */
  reward?: number
  /** 签到后顺带刷出的剩余积分（拿不到就不带） */
  remain?: number
}

/** 「今日已签到」判定：上游把重复签到当业务错误返回，需识别为正常状态。 */
function isAlreadyCheckedIn(msg: string): boolean {
  const s = (msg || '').toLowerCase()
  return ['已签到', '签到过', '重复签到', 'already', 'code=10001'].some((m) => s.includes(m.toLowerCase()))
}

/** 签到后顺带刷新余额（失败不影响签到结论）。 */
async function attachBalance(
  env: Env,
  refreshToken: string,
  baseUrl: string | undefined,
  regionCode: string | undefined,
  res: CbCheckinResult,
): Promise<CbCheckinResult> {
  try {
    const st = await fetchCodebuddyStatus(env, refreshToken, baseUrl, regionCode)
    if (st.ok) {
      if (typeof st.remain === 'number') res.remain = st.remain
      if (!res.nickname && st.nickname) res.nickname = st.nickname
      if (!res.uid && st.uid) res.uid = st.uid
    }
  } catch {
    /* 余额刷新失败不影响签到结论 */
  }
  return res
}

/**
 * 每日签到（billing 域 `POST {billingBase}/v2/billing/meter/daily-checkin`，body 为 `{}`）。
 * 与积分查询同域同头，走 `cbBillingHeaders`。
 * 「今日已签到」不算失败；签到成功后顺带刷一次余额，方便后台直接展示最新积分。
 */
export async function checkinCodebuddy(
  env: Env,
  refreshToken: string,
  baseUrl?: string,
  regionCode?: string,
): Promise<CbCheckinResult> {
  if (!refreshToken) return { ok: false, message: '未填写 refresh_token' }
  const region = cbRegion(baseUrl, regionCode)
  const realm = region.global ? 'global' : 'cn'
  try {
    const { accessToken, account } = await getCbAccess(env, refreshToken, region)
    const headers = cbBillingHeaders(region, accessToken, account)
    const targets = region.global ? CB_CHECKIN_CANDIDATES_GLOBAL : CB_CHECKIN_CANDIDATES_CN

    let lastMsg = ''
    for (const target of targets) {
      const res = await fetch(target.base + target.path, {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(30000),
      })
      const text = await res.text()
      if (res.status === 404) {
        lastMsg = `HTTP 404: ${text.slice(0, 120)}`
        continue // 该域/前缀不存在：CN 的 billing 独立域、Global 的 /v2 前缀差异，换下一个候选
      }
      let json: any = null
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      const bizMsg = String(json?.msg || json?.message || '')

      if (!res.ok || (json && json.code !== 0)) {
        // 「已签到」是正常状态，不当失败
        if (isAlreadyCheckedIn(bizMsg) || isAlreadyCheckedIn(text)) {
          return attachBalance(env, refreshToken, baseUrl, regionCode, {
            ok: true,
            already: true,
            message: '今日已签到',
            realm,
            nickname: account.nickname,
            uid: account.uid,
          })
        }
        return { ok: false, message: `HTTP ${res.status} code=${json?.code} msg=${bizMsg || text.slice(0, 160)}` }
      }

      const inner = json?.data?.Response?.Data || json?.data?.data || json?.data || {}
      const reward = Number(inner?.Reward ?? inner?.Dosage ?? inner?.Credit ?? json?.data?.reward ?? 0) || 0
      return attachBalance(env, refreshToken, baseUrl, regionCode, {
        ok: true,
        message: reward > 0 ? `签到成功，获得 ${reward} 积分` : '签到成功',
        realm,
        nickname: account.nickname,
        uid: account.uid,
        ...(reward > 0 ? { reward } : {}),
      })
    }
    return { ok: false, message: lastMsg || '签到失败' }
  } catch (err) {
    return { ok: false, message: (err as Error).message || '签到失败' }
  }
}

/**
 * 定时签到专用令牌：由 `ADMIN_PASSWORD` **单向派生**（HMAC-SHA256）。
 *
 * 为什么这么设计（而不是直接把管理员密码给定时任务）：
 *  1. 本仓库是 public，把管理员密码写进 GitHub Secrets 风险过大 —— 尤其该密码常被复用到别处；
 *  2. 派生值不可反推原密码，泄露也拿不到管理员凭据；
 *  3. 权限最小化：令牌只能触发签到，拿不到任何渠道配置或 Key；
 *  4. 无需新增 Cloudflare 环境变量（改 env_vars 会覆盖掉不可读的既有 secret）。
 *
 * ⚠️ 副作用：**改管理员密码会使令牌同步失效**，需重新更新 GitHub Secret（见 README）。
 * 未配置 `ADMIN_PASSWORD` 时返回空串，调用方必须**失败关闭**。
 */
export async function codebuddyCronToken(env: Env): Promise<string> {
  const secret = String(env.ADMIN_PASSWORD || '')
  if (!secret) return ''
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(CB_CRON_TOKEN_LABEL))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
