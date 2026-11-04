/**
 * Gemini 协议翻译（OpenAI <-> Gemini）
 *
 * 从原 gemini-cli 模块抽出：Antigravity 反代复用这套请求/响应翻译。
 * 纯函数，不依赖存储或运行时环境。
 */

const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
]

interface GeminiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  reasoningTokens: number
  cachedTokens: number
}

interface GeminiPart {
  text?: string
  thought?: boolean
  inlineData?: { mime_type?: string; mimeType?: string; data?: string }
  functionCall?: { id?: string; name?: string; args?: unknown }
  functionResponse?: { id?: string; name?: string; response?: unknown }
  thoughtSignature?: string
}

interface GeminiCandidate {
  index?: number
  content?: { role?: string; parts?: GeminiPart[] }
  finishReason?: string
}

interface GeminiResponseBody {
  candidates?: GeminiCandidate[]
  usageMetadata?: Record<string, unknown>
  modelVersion?: string
  responseId?: string
  promptFeedback?: unknown
}

function randomId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

// =====================================================================
// OpenAI -> Gemini 请求翻译
// =====================================================================

/** Gemini 函数名只允许 [A-Za-z_][A-Za-z0-9_.:$-]{0,63}，此处做保守替换并记录反查表 */
function sanitizeToolName(name: string): string {
  const cleaned = (name || '').replace(/[^A-Za-z0-9_]/g, '_')
  if (!cleaned) return 'tool'
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `t_${cleaned}`
}

/** 递归剔除 Gemini 不接受的 JSON Schema 关键字 */
function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema)
  if (!schema || typeof schema !== 'object') return schema
  const drop = new Set(['$schema', '$id', '$defs', 'definitions', 'additionalProperties', 'strict', 'title', 'examples', 'default', 'const'])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (drop.has(k)) continue
    // properties 的键是属性名(用户数据), 不能当关键字剔除
    if (k === 'properties' && isPlainObject(v)) {
      const props: Record<string, unknown> = {}
      for (const [pk, pv] of Object.entries(v)) props[pk] = cleanSchema(pv)
      out.properties = props
      continue
    }
    out[k] = cleanSchema(v)
  }
  return out
}

// =====================================================================
// 编程 Agent(如 ZCode / Claude Code)兼容处理, 默认开启:
// Agent 的工具 Schema 常带 Gemini / Vertex 上游不接受的 JSON Schema 关键字,
// 且 Gemini 3.x 严格校验 required/properties 与 functionCall 的 thought_signature。
// 此段逻辑在本地中继与线上渠道上用真实 ZCode 载荷(53 工具)验证过。
// =====================================================================

export interface GeminiTranslateOptions {
  /** 上游真实模型 id，用于判断生成配置兼容性（如 gpt-oss 不支持 thinkingConfig） */
  modelId?: string
}

/** thought_signature 编码进工具调用 id 的前缀(客户端把 id 视为不透明令牌原样回传) */
const SIG_ID_PREFIX = 'csg1_'

function encodeSigId(sig: string): string {
  return SIG_ID_PREFIX + encodeURIComponent(sig)
}

function decodeSigId(id: string): string | null {
  if (!id.startsWith(SIG_ID_PREFIX)) return null
  try { return decodeURIComponent(id.slice(SIG_ID_PREFIX.length)) } catch { return null }
}

/** Gemini Schema proto 不认识的关键字(剔除后语义无损或 Gemini 无法校验) */
const ZCODE_STRIP = new Set([
  '$schema', '$id', '$ref', '$defs', 'definitions', '$comment', '$anchor',
  '$dynamicRef', '$dynamicAnchor', '$vocabulary',
  'propertyNames', 'patternProperties', 'unevaluatedProperties', 'unevaluatedItems',
  'contains', 'dependencies', 'dependentSchemas', 'dependentRequired',
  'if', 'then', 'else', 'not', 'allOf', 'oneOf',
  'additionalItems', 'prefixItems', 'uniqueItems',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'contentEncoding', 'contentMediaType', 'contentSchema',
  'title', 'examples', 'example', 'default', 'const',
  'deprecated', 'readOnly', 'writeOnly', 'additionalProperties',
])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** antigravity 渠道上游不接受的 JSON Schema 关键字(实测), 递归剥离:
 *  - gpt-oss(Vertex 托管开源模型): minItems/maxItems/minLength/maxLength 报 400 invalid argument
 *  - claude(Vertex Claude): oneOf/anyOf 被判为非法 2020-12 子集, 报 input_schema is invalid
 *  Gemini 侧容忍这些关键字, 剥离后仅丢失约束提示, 不影响调用语义 */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  'minItems', 'maxItems', 'minLength', 'maxLength',
  'oneOf', 'anyOf', 'allOf', 'not',
])

function stripUnsupportedSchemaKeys(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripUnsupportedSchemaKeys)
  if (!isPlainObject(schema)) return schema
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(k)) continue
    if (k === 'properties' && isPlainObject(v)) {
      const props: Record<string, unknown> = {}
      for (const [pk, pv] of Object.entries(v)) props[pk] = stripUnsupportedSchemaKeys(pv)
      out.properties = props
      continue
    }
    out[k] = stripUnsupportedSchemaKeys(v)
  }
  return out
}

/** antigravity 渠道各模型流式输出硬上限(实测): 超出后上游报 400 invalid argument。
 *  客户端会把模型声明的 output 上限作为 max_tokens 发来(如 128000), 故按模型钳制:
 *  - gpt-oss(Vertex 托管开源模型): 32768
 *  - 3.6/3.7/3.8 系列与 3-flash / 3.1-flash-image: 65536
 *  - 其余(claude、2.5 系列、3.1/3.5 的 lite 与 pro、pro-agent): 64000 */
const AG_STREAM_MAX_OUTPUT: Array<[RegExp, number]> = [
  [/gpt-oss/i, 32768],
  [/gemini-3\.(6|7|8)-flash/i, 65536],
  [/gemini-3-flash|gemini-3\.1-flash-image/i, 65536],
  [/claude|gemini/i, 64000],
]

/** 按模型取流式输出上限, 未匹配的模型不做限制 */
function streamMaxOutputTokens(modelId?: string): number | undefined {
  const id = modelId || ''
  for (const [re, cap] of AG_STREAM_MAX_OUTPUT) if (re.test(id)) return cap
  return undefined
}

/** claude(Vertex Claude): 历史里的 thinking 块必须带 thoughtSignature, 否则报
 *  messages.N.content.0.thinking.signature: Field required。
 *  签名只能经工具调用 id 携带(csg1_), 纯 thinking 文本无法恢复, 故历史中直接丢弃 */
function requiresSignedThinking(modelId?: string): boolean {
  return /claude/i.test(modelId || '')
}

/**
 * 递归把 JSON Schema 规范化为 Gemini function_declarations 可接受的形状。
 * - allOf 分支合并进主节点(直接删除会让顶层 required 引用不存在的属性 -> "property is not defined")
 * - oneOf -> anyOf;type: ["string","null"] -> type + nullable;元组式 items -> anyOf
 * - 剔除 ZCODE_STRIP 关键字;过滤 required 中不在 properties 里的引用
 */
function compatSanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compatSanitize)
  if (!isPlainObject(node)) return node

  let merged: Record<string, unknown> = { ...node }

  // allOf 合并(保留分支的 properties/required/items/type/description)
  if (Array.isArray(merged.allOf)) {
    const branches = (merged.allOf as unknown[]).map(compatSanitize).filter(isPlainObject)
    const props = { ...(isPlainObject(merged.properties) ? merged.properties : {}) }
    const req = new Set(Array.isArray(merged.required) ? (merged.required as unknown[]) : [])
    let hasProps = isPlainObject(merged.properties)
    for (const b of branches) {
      if (isPlainObject(b.properties)) { Object.assign(props, b.properties); hasProps = true }
      if (Array.isArray(b.required)) for (const r of b.required as unknown[]) req.add(r)
      if (merged.items === undefined && b.items !== undefined) merged.items = b.items
      if (merged.type === undefined && b.type !== undefined) merged.type = b.type
      if (merged.description === undefined && b.description !== undefined) merged.description = b.description
    }
    delete merged.allOf
    if (hasProps) merged.properties = props
    if (req.size > 0) merged.required = [...req]
    else delete merged.required
  }

  // oneOf 在 Gemini proto 中不存在, anyOf 支持
  if (Array.isArray(merged.oneOf) && merged.anyOf === undefined) merged.anyOf = merged.oneOf
  delete merged.oneOf

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(merged)) {
    if (ZCODE_STRIP.has(key)) continue

    // properties 的键是用户数据(属性名), 不能当关键字剔除:
    // 属性名可以就叫 title / default / const, 只清洗它们的 schema 值。
    if (key === 'properties' && isPlainObject(value)) {
      const props: Record<string, unknown> = {}
      for (const [pk, pv] of Object.entries(value)) props[pk] = compatSanitize(pv)
      out.properties = props
      continue
    }

    if (key === 'type' && Array.isArray(value)) {
      // ["string","null"] -> type + nullable
      const nonNull = (value as unknown[]).filter((t) => t !== 'null')
      if ((value as unknown[]).includes('null')) out.nullable = true
      out.type = nonNull[0] ?? 'string'
      continue
    }

    if (key === 'items' && Array.isArray(value)) {
      // 元组式 items: [schemaA, schemaB] -> anyOf
      if (out.anyOf === undefined) out.anyOf = (value as unknown[]).map(compatSanitize)
      continue
    }

    out[key] = isPlainObject(value) || Array.isArray(value) ? compatSanitize(value) : value
  }

  if (out.type === undefined && isPlainObject(out.properties)) out.type = 'object'
  if (out.type === undefined && isPlainObject(out.items)) out.type = 'array'

  // Gemini 校验 required 必须都在 properties 中
  if (Array.isArray(out.required)) {
    const known = isPlainObject(out.properties) ? out.properties : {}
    const filtered = (out.required as unknown[]).filter((r) => typeof r === 'string' && r in known)
    if (filtered.length > 0) out.required = filtered
    else delete out.required
  }
  return out
}

/** OpenAI 消息 content -> Gemini parts */
function contentToParts(content: unknown): GeminiPart[] {
  const parts: GeminiPart[] = []
  if (typeof content === 'string') {
    if (content) parts.push({ text: content })
    return parts
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const it = item as Record<string, any>
      switch (it.type) {
        case 'text':
          if (typeof it.text === 'string' && it.text) parts.push({ text: it.text })
          break
        case 'image_url': {
          const url = it.image_url?.url
          if (typeof url === 'string' && url.startsWith('data:')) {
            const comma = url.indexOf(',')
            const meta = url.slice(5, comma)
            const data = url.slice(comma + 1)
            const mime = meta.split(';')[0] || 'image/png'
            if (data) parts.push({ inlineData: { mime_type: mime, data } })
          }
          break
        }
        case 'input_audio': {
          const data = it.input_audio?.data
          if (typeof data === 'string' && data) {
            const fmt = String(it.input_audio?.format || 'wav')
            const mime = fmt === 'mp3' ? 'audio/mpeg' : `audio/${fmt}`
            parts.push({ inlineData: { mime_type: mime, data } })
          }
          break
        }
      }
    }
  } else if (content && typeof content === 'object' && typeof (content as any).text === 'string') {
    parts.push({ text: (content as any).text })
  }
  return parts
}

function generationConfigFrom(body: Record<string, any>, modelId?: string): Record<string, unknown> {
  const cfg: Record<string, unknown> = {}
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const temperature = num(body.temperature)
  const topP = num(body.top_p)
  const topK = num(body.top_k)
  const maxTokens = num(body.max_tokens) ?? num(body.max_completion_tokens)
  if (temperature !== undefined) cfg.temperature = temperature
  if (topP !== undefined) cfg.topP = topP
  if (topK !== undefined) cfg.topK = topK
  if (maxTokens !== undefined) {
    const cap = streamMaxOutputTokens(modelId)
    cfg.maxOutputTokens = cap !== undefined ? Math.min(maxTokens, cap) : maxTokens
  }
  const n = num(body.n)
  if (n !== undefined && n > 1) cfg.candidateCount = n

  // reasoning_effort -> thinkingConfig
  // gpt-oss 等托管开源模型不接受 thinkingConfig(上游报 400 invalid argument),
  // 其推理档位已由模型名后缀(-low/-medium/-high)表达, 跳过该映射
  if (!/gpt-oss/i.test(modelId || '')) {
    const effort = body.reasoning_effort
    if (typeof effort === 'number') {
      cfg.thinkingConfig = { thinkingBudget: effort }
    } else if (typeof effort === 'string' && effort.trim()) {
      const e = effort.trim().toLowerCase()
      cfg.thinkingConfig = e === 'auto' ? { thinkingBudget: -1 } : { thinkingLevel: e }
    }
  }

  // response_format -> responseMimeType / responseSchema
  const rf = body.response_format
  if (rf && typeof rf === 'object') {
    const type = String((rf as any).type || '').toLowerCase()
    if (type === 'json_object') {
      cfg.responseMimeType = 'application/json'
    } else if (type === 'json_schema') {
      cfg.responseMimeType = 'application/json'
      const schema = (rf as any).json_schema?.schema
      if (schema) cfg.responseSchema = compatSanitize(schema)
    }
  }
  return cfg
}

function toolConfigFrom(body: Record<string, any>): Record<string, unknown> | undefined {
  const tc = body.tool_choice
  if (!tc) return undefined
  if (typeof tc === 'string') {
    const mode = tc === 'none' ? 'NONE' : tc === 'required' ? 'ANY' : 'AUTO'
    return { functionCallingConfig: { mode } }
  }
  if (typeof tc === 'object' && (tc as any).type === 'function' && (tc as any).function?.name) {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [sanitizeToolName(String((tc as any).function.name))],
      },
    }
  }
  return undefined
}

function toolsFrom(body: Record<string, any>, nameMap: Record<string, string>): unknown[] | undefined {
  const tools = body.tools
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const declarations: Record<string, unknown>[] = []
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue
    const tt = t as Record<string, any>
    if (tt.type === 'function' && tt.function?.name) {
      const original = String(tt.function.name)
      const sanitized = sanitizeToolName(original)
      if (sanitized !== original) nameMap[sanitized] = original
      const decl: Record<string, unknown> = { name: sanitized }
      if (tt.function.description) decl.description = String(tt.function.description)
      if (tt.function.parameters) {
        const cleaned = compatSanitize(tt.function.parameters)
        decl.parameters = stripUnsupportedSchemaKeys(cleaned)
      }
      declarations.push(decl)
    }
  }
  const out: unknown[] = []
  if (declarations.length > 0) out.push({ functionDeclarations: declarations })
  for (const t of tools) {
    const tt = t as Record<string, any>
    if (tt?.google_search) out.push({ googleSearch: {} })
    if (tt?.code_execution) out.push({ codeExecution: {} })
    if (tt?.url_context) out.push({ urlContext: {} })
  }
  return out.length > 0 ? out : undefined
}

interface TranslatedRequest {
  request: Record<string, unknown>
  nameMap: Record<string, string>
}

/** OpenAI Chat Completions 请求体 -> Gemini 请求体（含 tools / 多模态 / 工具调用） */
export function openAIToGeminiRequest(body: Record<string, any>, opts?: GeminiTranslateOptions): TranslatedRequest {
  const messages: any[] = Array.isArray(body.messages) ? body.messages : []
  const nameMap: Record<string, string> = {}

  // claude / gpt-oss 上游把 functionCall 翻成 tool_use 时强制要求带 id; 而客户端回传的
  // csg1_* id 承载的是 thought_signature(已单独回填), 不能兼作 tool_use.id,
  // 故为这类 id 生成配对替代 id。Gemini 上游不需要 id, 保持原行为不做回填。
  const needsToolId = /claude|gpt-oss/i.test(opts?.modelId || '')
  const altToolIds = new Map<string, string>()
  let altToolSeq = 0
  const upstreamToolId = (rawId: unknown): string | undefined => {
    if (typeof rawId !== 'string' || !rawId) return undefined
    const sig = decodeSigId(rawId)
    if (!sig) return rawId
    if (!needsToolId) return undefined
    let id = altToolIds.get(rawId)
    if (!id) {
      altToolSeq += 1
      id = `toolu_${altToolSeq.toString(36).padStart(2, '0')}`
      altToolIds.set(rawId, id)
    }
    return id
  }

  // 第一遍：assistant.tool_calls 的 id -> 原始函数名
  const id2name = new Map<string, string>()
  for (const m of messages) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.type === 'function' && tc.id && tc.function?.name) {
          id2name.set(String(tc.id), String(tc.function.name))
        }
      }
    }
  }

  const systemParts: GeminiPart[] = []
  const contents: Array<{ role: string; parts: GeminiPart[] }> = []
  const handledToolIds = new Set<string>()
  let encounteredConversation = false

  for (const m of messages) {
    const role = m?.role
    if ((role === 'system' || role === 'developer') && messages.length > 1 && !encounteredConversation) {
      for (const p of contentToParts(m.content)) {
        if (typeof p.text === 'string') systemParts.push({ text: p.text })
      }
      continue
    }

    if (role === 'user' || role === 'system' || role === 'developer') {
      encounteredConversation = true
      const parts = contentToParts(m.content)
      if (parts.length > 0) contents.push({ role: 'user', parts })
      continue
    }

    if (role === 'assistant') {
      encounteredConversation = true
      const parts: GeminiPart[] = []
      if (!requiresSignedThinking(opts?.modelId) && typeof m.reasoning_content === 'string' && m.reasoning_content) {
        parts.push({ text: m.reasoning_content, thought: true })
      }
      parts.push(...contentToParts(m.content))

      const toolCalls: any[] = Array.isArray(m.tool_calls) ? m.tool_calls : []
      for (const tc of toolCalls) {
        if (tc?.type !== 'function') continue
        const original = String(tc.function?.name || '')
        if (!original) continue
        const sanitized = sanitizeToolName(original)
        if (sanitized !== original) nameMap[sanitized] = original
        let args: unknown = {}
        try {
          args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {})
        } catch {
          args = {}
        }
        const part: GeminiPart = { functionCall: { name: sanitized, args } }
        // 从客户端回传的工具调用 id 里解码 thought_signature, 附加到 functionCall
        const sig = typeof tc.id === 'string' ? decodeSigId(tc.id) : null
        if (sig) part.thoughtSignature = sig
        // claude / gpt-oss 上游要求 tool_use 必须带 id(签名占用原 id 时用配对替代 id)
        const toolId = upstreamToolId(tc.id)
        if (toolId) part.functionCall!.id = toolId
        parts.push(part)
      }
      if (parts.length > 0) contents.push({ role: 'model', parts })

      // 紧随其后的 tool 结果 -> 单个 user functionResponse 节点
      if (toolCalls.length > 0) {
        const responseParts: GeminiPart[] = []
        for (const tc of toolCalls) {
          if (tc?.type !== 'function') continue
          const original = id2name.get(String(tc.id)) || String(tc.function?.name || '')
          if (!original) continue
        const toolMsg = messages.find((x) => x?.role === 'tool' && String(x.tool_call_id) === String(tc.id))
        if (toolMsg) handledToolIds.add(String(tc.id))
        const raw = toolMsg ? toolMsg.content : '{}'
        const result = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {})
        const respPart: GeminiPart = {
          functionResponse: { name: sanitizeToolName(original), response: { result } },
        }
        // 与 functionCall 配对: 回传同一个 id, 上游据此关联 tool_use / tool_result
        const respToolId = upstreamToolId(tc.id)
        if (respToolId) respPart.functionResponse!.id = respToolId
        responseParts.push(respPart as unknown as GeminiPart)
        }
        if (responseParts.length > 0) contents.push({ role: 'user', parts: responseParts })
      }
      continue
    }

    if (role === 'tool') {
      // 已由 assistant.tool_calls 关联处理过的跳过；孤立的 tool 消息作为 user functionResponse 兜底
      if (m.tool_call_id && handledToolIds.has(String(m.tool_call_id))) continue
      const name = sanitizeToolName(String(m.name || 'tool'))
      const raw = m.content
      const result = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {})
      const orphan: GeminiPart = { functionResponse: { name, response: { result } } }
      if (typeof m.tool_call_id === 'string' && m.tool_call_id) orphan.functionResponse!.id = m.tool_call_id
      contents.push({ role: 'user', parts: [orphan as unknown as GeminiPart] })
    }
  }

  // generateContent 要求首条为 user
  if (contents.length > 0 && contents[0].role !== 'user') {
    contents.unshift({ role: 'user', parts: [{ text: '' }] })
  }

  const request: Record<string, unknown> = { contents }
  if (systemParts.length > 0) request.systemInstruction = { role: 'user', parts: systemParts }
  const generationConfig = generationConfigFrom(body, opts?.modelId)
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig
  const tools = toolsFrom(body, nameMap)
  if (tools) request.tools = tools
  const toolConfig = toolConfigFrom(body)
  if (toolConfig) request.toolConfig = toolConfig
  request.safetySettings = SAFETY_SETTINGS

  return { request, nameMap }
}

// =====================================================================
// Gemini -> OpenAI 响应翻译
// =====================================================================

function unwrap(body: unknown): GeminiResponseBody {
  if (body && typeof body === 'object' && 'response' in (body as Record<string, unknown>)) {
    return (body as { response: GeminiResponseBody }).response
  }
  return (body || {}) as GeminiResponseBody
}

function extractUsage(meta: Record<string, unknown> | undefined): GeminiUsage {
  const n = (v: unknown) => Number(v) || 0
  return {
    promptTokens: n(meta?.promptTokenCount),
    completionTokens: n(meta?.candidatesTokenCount),
    totalTokens: n(meta?.totalTokenCount),
    reasoningTokens: n(meta?.thoughtsTokenCount),
    cachedTokens: n(meta?.cachedContentTokenCount),
  }
}

function usageToOpenAI(u: GeminiUsage): Record<string, unknown> {
  const usage: Record<string, unknown> = {
    prompt_tokens: u.promptTokens,
    completion_tokens: u.completionTokens,
    total_tokens: u.totalTokens || u.promptTokens + u.completionTokens,
  }
  if (u.reasoningTokens > 0) usage.completion_tokens_details = { reasoning_tokens: u.reasoningTokens }
  if (u.cachedTokens > 0) usage.prompt_tokens_details = { cached_tokens: u.cachedTokens }
  return usage
}

function finishReasonToOpenAI(reason: string | undefined, hasToolCall: boolean): string {
  if (hasToolCall) return 'tool_calls'
  switch ((reason || '').toUpperCase()) {
    case 'MAX_TOKENS':
    case 'MAX_OUTPUT_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'content_filter'
    case '':
    case 'STOP':
    case 'FINISH_REASON_UNSPECIFIED':
    default:
      return 'stop'
  }
}

function restoreName(nameMap: Record<string, string>, name: string | undefined): string {
  if (!name) return ''
  return nameMap[name] || name
}

/** 非流式：Gemini 响应 -> OpenAI ChatCompletion */
export function geminiResponseToOpenAI(
  body: unknown,
  requestedModel: string,
  nameMap: Record<string, string>,
  opts?: GeminiTranslateOptions,
): Record<string, unknown> {
  const data = unwrap(body)
  const candidate = Array.isArray(data.candidates) ? data.candidates[0] : undefined
  const parts: GeminiPart[] = candidate?.content?.parts || []

  let content = ''
  let reasoning = ''
  const toolCalls: Record<string, unknown>[] = []
  let hasToolCall = false

  for (const part of parts) {
    if (typeof part.text === 'string') {
      if (part.thought) reasoning += part.text
      else content += part.text
    } else if (part.functionCall) {
      hasToolCall = true
      const name = restoreName(nameMap, part.functionCall.name)
      let args = ''
      try {
        args = JSON.stringify(part.functionCall.args ?? {})
      } catch {
        args = '{}'
      }
      // thought_signature 编码进 id, 客户端原样回传后由请求侧解码;
      // 无签名时优先沿用上游自己的 id(claude/gpt-oss 要求 id 前后一致)
      const id = part.thoughtSignature
        ? encodeSigId(part.thoughtSignature)
        : (part.functionCall.id || `call_${randomId().replace(/-/g, '').slice(0, 24)}`)
      toolCalls.push({
        id,
        type: 'function',
        function: { name, arguments: args },
      })
    }
  }

  const usage = extractUsage(data.usageMetadata)
  const message: Record<string, unknown> = { role: 'assistant', content: content || (toolCalls.length > 0 ? null : '') }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  return {
    id: data.responseId || `chatcmpl-${randomId().replace(/-/g, '').slice(0, 24)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data.modelVersion || requestedModel,
    choices: [
      {
        index: candidate?.index ?? 0,
        message,
        finish_reason: finishReasonToOpenAI(candidate?.finishReason, hasToolCall),
        native_finish_reason: (candidate?.finishReason || '').toLowerCase() || null,
      },
    ],
    usage: usageToOpenAI(usage),
  }
}

/** 流式：把 Code Assist SSE 流翻译成 OpenAI SSE 流 */
export function createOpenAIStream(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
  nameMap: Record<string, string>,
  onUsage: (u: GeminiUsage) => void,
  onEnd?: (u: GeminiUsage) => void,
  opts?: GeminiTranslateOptions,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let sentRole = false
  let toolIndex = 0
  let finishReason = ''
  let hasToolCall = false
  let model = requestedModel
  let id = `chatcmpl-${randomId().replace(/-/g, '').slice(0, 24)}`
  let usage: GeminiUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedTokens: 0 }

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, payload: Record<string, unknown>) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
  }

  const emitDelta = (controller: TransformStreamDefaultController<Uint8Array>, delta: Record<string, unknown>, finish: string | null) => {
    if (!sentRole && !('role' in delta)) delta = { role: 'assistant', ...delta }
    if ('role' in delta) sentRole = true
    emit(controller, {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })
  }

  const handleChunk = (controller: TransformStreamDefaultController<Uint8Array>, raw: string) => {
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    const data = unwrap(parsed)
    if (data.responseId) id = data.responseId
    if (data.modelVersion) model = data.modelVersion
    if (data.usageMetadata) {
      usage = extractUsage(data.usageMetadata)
      onUsage(usage)
    }
    const candidate = Array.isArray(data.candidates) ? data.candidates[0] : undefined
    if (!candidate) return
    if (candidate.finishReason) finishReason = candidate.finishReason

    const parts: GeminiPart[] = candidate.content?.parts || []
    for (const part of parts) {
      if (typeof part.text === 'string' && part.text) {
        if (part.thought) emitDelta(controller, { reasoning_content: part.text }, null)
        else emitDelta(controller, { content: part.text }, null)
      } else if (part.functionCall) {
        hasToolCall = true
        const name = restoreName(nameMap, part.functionCall.name)
        let args = ''
        try {
          args = JSON.stringify(part.functionCall.args ?? {})
        } catch {
          args = '{}'
        }
        // thought_signature 编码进 id, 客户端原样回传后由请求侧解码;
        // 无签名时优先沿用上游自己的 id(claude/gpt-oss 要求 id 前后一致)
        const id = part.thoughtSignature
          ? encodeSigId(part.thoughtSignature)
          : (part.functionCall.id || `call_${randomId().replace(/-/g, '').slice(0, 24)}`)
        emitDelta(controller, {
          tool_calls: [
            {
              index: toolIndex++,
              id,
              type: 'function',
              function: { name, arguments: args },
            },
          ],
        }, null)
      }
    }
  }

  const processLine = (controller: TransformStreamDefaultController<Uint8Array>, line: string) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(':')) return
    if (!trimmed.startsWith('data:')) return
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    handleChunk(controller, payload)
  }

  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) processLine(controller, line)
      },
      flush(controller) {
        if (buffer) processLine(controller, buffer)
        // 结束块：finish_reason + usage
        emit(controller, {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReasonToOpenAI(finishReason, hasToolCall) }],
        })
        emit(controller, {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [],
          usage: usageToOpenAI(usage),
        })
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        if (onEnd) onEnd(usage)
      },
    }),
  )
}
