/**
 * DeepSeek 网页版 —— 工具调用（function calling）支持
 *
 * DeepSeek 网页接口（/api/v0/chat/completion）**不支持原生 function calling**：
 * 它只接受单条 prompt 文本，没有 tools 参数。所以这里复刻 NIyueeE/ds-free-api 的做法，
 * 把工具定义与调用规则**降级成提示词注入**，再在响应侧把模型输出的标签块**解析回**结构化 tool_calls。
 *
 * 完整链路：
 *   请求侧  injectTools()  —— 工具定义 + 格式规范 + 规则 + 示例，作为普通 System 内容注入一次
 *   响应侧  ToolCallStream —— 滑动窗口扫标签 -> 收集 JSON -> 三层自修复 -> 吐出 OpenAI tool_calls
 *
 * 标签选型（照抄 ds-free-api 的实验结论，别凭感觉改）：
 *   主标签 `<|tool▁calls▁begin|>` / `<|tool▁calls▁end|>`
 *   —— 注意 `▁` 是 U+2581（不是下划线），`|` 用 **ASCII 竖线**而非全角 `｜`。
 *   实测：全角 `｜` 形式会被 DeepSeek 后端过滤/干扰，模型严重混淆；
 *   换 ASCII `|` 后「既保留类原生标签的结构感，又不触发后端过滤」，遵循度明显提升、幻觉大幅减少。
 *   解析侧仍做模糊匹配（全角｜↔|、▁↔_），兜住模型偶发的变体。
 *
 * 重要设计取舍（来自 ds-free-api 2026-09 的实测）：
 *   ❌ 不要用「未闭合 <think> + 元指令 + 规则重复两遍」的注入方式 —— 实测 token 成本高约 43%，
 *      且「未闭合标签 + 角色扮演式元指令 + 重复块」这三个特征容易被上游滥用检测命中而封号。
 *   ✅ 标准 ChatML 风格，工具信息**只注入一次**，实测模型遵循度一致、token 却省一半。
 */

// =====================================================================
// 常量
// =====================================================================

/** 工具调用起始标签。`▁` 是 U+2581，`|` 是 ASCII 竖线 —— 见文件头说明，别改成全角。 */
export const TOOL_CALL_START = '<|tool▁calls▁begin|>'
/** 工具调用结束标签 */
export const TOOL_CALL_END = '<|tool▁calls▁end|>'
/** 滑动窗口宽度：略大于起始标签长度，够兜住跨 chunk 断裂的标签 */
const SCAN_WINDOW = 71
/** 收集 JSON 时的缓冲区上限，防止模型跑飞后无限占用内存 */
const MAX_XML_BUF_LEN = 64 * 1024
/** 单个工具调用的 JSON 解析上限 */
const MAX_ARG_CHARS = 100_000

// =====================================================================
// 请求侧：工具定义 -> 提示词注入
// =====================================================================

interface ToolFunctionDef {
  name?: string
  description?: string
  parameters?: unknown
}
interface ToolDef {
  type?: string
  function?: ToolFunctionDef
  custom?: { name?: string; description?: string; format?: { type?: string; syntax?: string; grammar?: { syntax?: string } } }
}

export interface ToolContext {
  /** 工具定义清单（自然语言描述） */
  defsText?: string
  /** 格式模板 + 规则 + 正确示例 */
  formatBlock?: string
  /** 依据 tool_choice / parallel_tool_calls 追加的行为指令 */
  instructionText?: string
}

/** 标签字符归一化：全角 `｜`(U+FF5C) -> `|`，`▁`(U+2581) -> `_` */
function normTagChar(c: string): string {
  if (c === '\uFF5C') return '|'
  if (c === '\u2581') return '_'
  return c
}

function eqTagChar(a: string, b: string): boolean {
  return a === b || normTagChar(a) === normTagChar(b)
}

/** 模糊匹配：在 haystack 中查找 partial，支持 `｜`↔`|`、`▁`↔`_` 等价 */
export function fuzzyMatchTag(haystack: string, partial: string): { index: number; text: string } | null {
  const n = [...partial]
  const h = [...haystack]
  if (n.length === 0 || h.length < n.length) return null
  for (let start = 0; start <= h.length - n.length; start++) {
    let matched = true
    for (let j = 0; j < n.length; j++) {
      if (!eqTagChar(n[j], h[start + j])) { matched = false; break }
    }
    if (!matched) continue
    const bytePos = h.slice(0, start).join('').length
    const text = h.slice(start, start + n.length).join('')
    return { index: bytePos, text }
  }
  return null
}

/** 查找起始标签：先精确匹配（去掉尾部 `>` 再 find，兼容标签被截断），再模糊匹配 */
export function findStartTag(s: string, tag = TOOL_CALL_START): { index: number; text: string } | null {
  const partial = tag.replace(/>+$/, '')
  const pos = s.indexOf(partial)
  if (pos >= 0) return { index: pos, text: s.slice(pos, pos + partial.length) }
  return fuzzyMatchTag(s, partial)
}

/** 查找结束标签：先精确，再模糊 */
export function findEndTag(s: string, tag = TOOL_CALL_END): { index: number; text: string } | null {
  const partial = tag.replace(/>+$/, '')
  const pos = s.indexOf(partial)
  if (pos >= 0) return { index: pos, text: s.slice(pos, pos + partial.length) }
  return fuzzyMatchTag(s, partial)
}

// ---- 工具定义格式化 ----

/** 按工具名给一份贴近真实的示例参数，降低模型对参数结构的幻觉 */
function exampleArgs(name: string): string {
  const args: Record<string, string> = {
    Read: '"file_path": "/path/to/file"',
    read_file: '"file_path": "/path/to/file"',
    Bash: '"command": "ls -la"',
    execute_command: '"command": "ls -la"',
    exec_command: '"command": "ls -la"',
    Write: '"file_path": "/path/to/file", "content": "hello"',
    write_to_file: '"file_path": "/path/to/file", "content": "hello"',
    Edit: '"file_path": "/path/to/file", "old_string": "foo", "new_string": "bar"',
    Glob: '"pattern": "**/*.rs", "path": "."',
    search_files: '"query": "TODO", "path": "."',
    list_files: '"path": "."',
    get_weather: '"city": "Beijing"',
    get_time: '"timezone": "Asia/Shanghai"',
  }
  return '{' + (args[name] || '"key": "value"') + '}'
}

/** 参数值本身是嵌套对象/数组时的示例 */
function exampleNestedArgs(name: string): string {
  if (name === 'Edit') {
    return '{"file_path": "/path/to/file", "edits": [{"old_string": "foo", "new_string": "bar"}, {"old_string": "x", "new_string": "y"}]}'
  }
  return '{"config": {"enabled": true, "items": ["a", "b"]}}'
}

function formatFunction(func: ToolFunctionDef): string {
  const name = (func.name || '').trim()
  if (!name) throw new Error("tools 中 function 缺少必填字段 'name'")
  const params = JSON.stringify(func.parameters ?? {})
  const callExample = `${TOOL_CALL_START}[{"name": "${name}", "arguments": ${params}}]${TOOL_CALL_END}`
  const desc = (func.description || '').trim()
  const descBlock = desc ? '~~~markdown\n  ' + desc + '\n~~~\n' : '  无描述'
  return `- **${name}** (function):\n  - 调用方法: \`${callExample}\`\n  - 简要说明:\n${descBlock}`
}

function formatCustom(custom: NonNullable<ToolDef['custom']>): string {
  const name = (custom.name || '').trim()
  const desc = (custom.description || '').trim()
  let method = '无约束'
  const fmt = custom.format
  if (fmt) {
    if (fmt.type === 'text') method = 'text'
    else if (fmt.syntax) method = `grammar(syntax: ${fmt.syntax})`
    else if (fmt.grammar?.syntax) method = `grammar(syntax: ${fmt.grammar.syntax})`
  }
  return `- **${name}** (custom):\n  - 调用方法: \`${method}\`\n  - 简要说明: ${desc || '无描述'}`
}

function formatTool(tool: ToolDef, idx: number): string {
  if (tool.type === 'function') {
    if (!tool.function) throw new Error(`tools[${idx}] 类型为 'function' 时必须提供 function 定义`)
    return formatFunction(tool.function)
  }
  if (tool.type === 'custom') {
    if (!tool.custom) throw new Error(`tools[${idx}] 类型为 'custom' 时必须提供 custom 定义`)
    return formatCustom(tool.custom)
  }
  throw new Error(`tools[${idx}] 不支持的类型: ${tool.type}`)
}

/** 格式模板 + 规则 + 动态正确示例 */
function buildToolInstructionBlock(tools: ToolDef[]): string {
  const L: string[] = []
  L.push('**工具调用格式 — 请严格遵守：**')
  L.push('')
  L.push('将 JSON 数组包裹在工具调用标记中：')
  L.push('')
  L.push(`${TOOL_CALL_START}[{"name": "工具名", "arguments": {参数JSON}}]${TOOL_CALL_END}`)
  L.push('')
  L.push('**规则：**')
  L.push('')
  L.push('**核心：决定调用工具时，你的响应中只允许出现工具调用文本本身，禁止任何解释、前缀、总结、问候语等额外内容。**')
  L.push('')
  L.push(`1. JSON 数组必须以 \`${TOOL_CALL_START}\` 开头、以 \`${TOOL_CALL_END}\` 结尾，将数组**完整包裹**在标记内。`)
  L.push('2. 所有工具调用必须放在**一个** JSON 数组中，多个调用用逗号分隔。')
  L.push(`3. 输出 \`${TOOL_CALL_END}\` 后**立即停止**，不得添加后续文本、XML 标签或说明文字。`)
  L.push('4. 不要将工具调用包裹在 markdown 代码块中。')
  L.push('5. 字符串参数值必须用**双引号**包裹（JSON 标准）。')
  L.push(`6. 决定调用工具时，输出的**第一个非空白字符**必须是 \`${TOOL_CALL_START}\`。`)
  L.push(`7. 整个响应中**只能出现一个 \`${TOOL_CALL_START}\` 块**，不要重复输出多个 \`${TOOL_CALL_START}\` 块。`)
  L.push(`8. **重复：** 整个响应中只能出现一个 \`${TOOL_CALL_START}\` 块，不要重复输出。如果你已经输出了一个 \`${TOOL_CALL_START}\` 块，绝对不要再输出第二个。`)
  L.push(`9. **重复：** 禁止在 \`${TOOL_CALL_START}\` 之前输出任何文字，包括但不限于解释、确认、总结、问候语。`)
  L.push('10. 不要把回复和工具调用置于思考内容中。')
  L.push('11. **重复：** 思考内容（<think> 标签内）仅用于内部推理过程，不要将最终回复或工具调用放在 <think> 标签中。')
  L.push('')

  const names = tools.map((t) => t.function?.name || t.custom?.name || '').filter(Boolean)
  const a = names[0] || 'tool_a'

  L.push('**正确示例：**')
  L.push('')
  L.push('**示例A** — 调用一个工具：')
  L.push(`${TOOL_CALL_START}[{"name": "${a}", "arguments": ${exampleArgs(a)}}]${TOOL_CALL_END}`)
  L.push('')
  if (names.length >= 2) {
    L.push('**示例B** — 同时调用多个工具（一个数组包含全部调用）：')
    L.push(`${TOOL_CALL_START}[${names.slice(0, 2).map((n) => `{"name": "${n}", "arguments": ${exampleArgs(n)}}`).join(', ')}]${TOOL_CALL_END}`)
    L.push('')
  }
  if (names.length >= 3) {
    L.push('**示例C** — 同时调用三个工具（所有调用在一个数组中）：')
    L.push(`${TOOL_CALL_START}[${names.slice(0, 3).map((n) => `{"name": "${n}", "arguments": ${exampleArgs(n)}}`).join(', ')}]${TOOL_CALL_END}`)
    L.push('')
  }
  L.push('**示例D** — 参数值为嵌套对象/数组（仍然是标准 JSON）：')
  L.push(`${TOOL_CALL_START}[{"name": "${a}", "arguments": ${exampleNestedArgs(a)}}]${TOOL_CALL_END}`)
  L.push('')
  return L.join('\n')
}

/** tool_choice -> 行为指令 */
function buildInstructionText(body: Record<string, any>, tools: ToolDef[]): string | undefined {
  const lines: string[] = []
  const tcRaw = body.tool_choice
  const mode = typeof tcRaw === 'string' ? tcRaw : (tcRaw && typeof tcRaw === 'object' ? tcRaw.type : undefined)

  if (mode === 'required') {
    lines.push('**注意：你必须调用一个或多个工具。**')
  } else if (tcRaw && typeof tcRaw === 'object' && (tcRaw.type === 'function' || tcRaw.function)) {
    const name = tcRaw.function?.name || tcRaw.name
    if (name) lines.push(`**注意：你必须调用 '${name}' 工具。**`)
  } else if (tcRaw && typeof tcRaw === 'object' && Array.isArray(tcRaw.allowed_tools)) {
    const allowed = tcRaw.allowed_tools
      .map((t: any) => t?.function?.name || t?.name)
      .filter((s: unknown) => typeof s === 'string' && s)
    if (allowed.length) lines.push(`**注意：**你只能从以下允许的工具中选择：${allowed.join(', ')}。`)
    if (tcRaw.mode === 'required') lines.push('**注意：你必须调用一个或多个工具。**')
  }

  if (body.parallel_tool_calls === false && tools.length > 1) {
    lines.push('**注意：**每次只能调用**一个**工具，不要在一个数组中放多个调用。')
  }
  return lines.length ? lines.join('\n') : undefined
}

/** response_format 降级为文本约束 */
export function formatResponseFormatText(rf: unknown): string {
  if (!rf || typeof rf !== 'object') return ''
  const r = rf as Record<string, any>
  if (r.type === 'json_object') {
    return '**输出格式要求：** 你的回复必须是一个合法的 JSON 对象。不要输出任何 JSON 之外的文字，也不要用 markdown 代码块包裹。'
  }
  if (r.type === 'json_schema' && r.json_schema) {
    const schema = JSON.stringify(r.json_schema.schema ?? r.json_schema, null, 2)
    return `**输出格式要求：** 你的回复必须严格符合下面的 JSON Schema，且不得输出任何额外文字或 markdown 代码块：\n\n\`\`\`json\n${schema}\n\`\`\``
  }
  return ''
}

/**
 * 从请求体提取工具上下文。
 * `tool_choice: "none"` 时返回空上下文（不注入任何东西）。
 */
export function injectTools(body: Record<string, any>): ToolContext {
  const tools: ToolDef[] = Array.isArray(body.tools) ? body.tools : []
  const hasTools = tools.length > 0
  const tcRaw = body.tool_choice
  const mode = typeof tcRaw === 'string' ? tcRaw : (tcRaw && typeof tcRaw === 'object' ? (tcRaw.type ?? tcRaw.mode) : undefined)

  if (!hasTools || mode === 'none') return {}

  const defsLines: string[] = ['你可以使用以下工具：']
  tools.forEach((t, i) => defsLines.push(formatTool(t, i)))

  return {
    defsText: defsLines.join('\n'),
    formatBlock: buildToolInstructionBlock(tools),
    instructionText: buildInstructionText(body, tools),
  }
}

// =====================================================================
// 响应侧：三层 JSON 自修复
// =====================================================================

/**
 * 修复 1：非法转义的反斜杠。
 * 模型常把 Windows 路径写成 `C:\Users\name`（`\U` `\n` 是非法/错误转义，JSON.parse 会抛）。
 * 策略：保留合法转义（`\" \\ \/ \b \f \n \r \t \uXXXX`），其余 `\` 一律双写。
 */
export function repairInvalidBackslashes(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '\\') { out += c; continue }
    const next = s[i + 1]
    if (next === undefined) { out += '\\\\'; continue }
    if ('"\\/bfnrt'.includes(next)) { out += c + next; i++; continue }
    if (next === 'u') {
      const hex = s.slice(i + 2, i + 6)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += s.slice(i, i + 6); i += 5; continue }
      out += '\\\\'; continue
    }
    out += '\\\\'
  }
  return out
}

/**
 * 修复 2：未加引号的 key。
 * 模型偶尔输出 `{name: "x", args: {...}}`（JS 对象字面量风格）。
 * 策略：只在「字符串外」识别 `标识符:` 并补引号。
 */
export function repairUnquotedKeys(s: string): string {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; out += c; continue }
    // 匹配 key 起始：前面是 { 或 , （允许空白），后面是标识符
    if (/[A-Za-z_$]/.test(c)) {
      let j = i
      while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j++
      const word = s.slice(i, j)
      let k = j
      while (k < s.length && /\s/.test(s[k])) k++
      // 仅当紧跟着冒号、且不在字符串里、且上一个有效字符是 { 或 , 时，才认定是 key
      let p = out.length - 1
      while (p >= 0 && /\s/.test(out[p])) p--
      const prevCh = p >= 0 ? out[p] : ''
      if (s[k] === ':' && (prevCh === '{' || prevCh === ',' || prevCh === '')) {
        out += '"' + word + '"'
        i = j - 1
        continue
      }
    }
    out += c
  }
  return out
}

/** 三层修复：原样 -> 反斜杠 -> 无引号 key -> 两者都做 */
export function repairJson(s: string): string | null {
  const trimmed = s.trim()
  if (!trimmed) return null
  const candidates = [
    trimmed,
    repairInvalidBackslashes(trimmed),
    repairUnquotedKeys(trimmed),
    repairUnquotedKeys(repairInvalidBackslashes(trimmed)),
  ]
  for (const c of candidates) {
    try {
      JSON.parse(c)
      return c
    } catch { /* 试下一个 */ }
  }
  return null
}

/** 判断位置是否落在 ``` 代码围栏内（围栏内的标签是示例文本，不该当工具调用） */
export function isInsideCodeFence(xml: string, tagPos: number): boolean {
  const before = xml.slice(0, tagPos)
  const fences = before.match(/```/g)
  return !!fences && fences.length % 2 === 1
}

// =====================================================================
// JSON 片段 -> 结构化 tool_calls
// =====================================================================

export interface ParsedToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ParseResult {
  calls: ParsedToolCall[]
  /** 未能解析的原始片段（交给上层做模型兜底修复） */
  failed: string[]
  /** 标签块之后残留的文本（用于判断是否要吞掉尾巴） */
  trailing: string
}

let callIdCounter = 1
function nextCallId(): string {
  const n = callIdCounter++
  return `call_${n.toString(16).padStart(8, '0')}${Math.random().toString(16).slice(2, 10)}`
}

/** 把 `{name, arguments}` 归一化成结构化调用 */
function normalizeCall(raw: any): ParsedToolCall | null {
  if (!raw || typeof raw !== 'object') return null
  // 兼容几种常见形态
  const name = raw.name ?? raw.function?.name ?? raw.tool ?? raw.tool_name
  if (typeof name !== 'string' || !name.trim()) return null
  let args = raw.arguments ?? raw.function?.arguments ?? raw.parameters ?? raw.args ?? {}
  if (typeof args === 'string') {
    // arguments 是字符串时要保证它是合法 JSON 字符串
    const trimmed = args.trim()
    if (!trimmed) args = '{}'
    else if (trimmed.length > MAX_ARG_CHARS) args = JSON.stringify({ _truncated: true })
    else {
      const fixed = repairJson(trimmed)
      args = fixed ?? JSON.stringify({ _raw: trimmed })
    }
  } else {
    args = JSON.stringify(args ?? {})
  }
  return { id: nextCallId(), type: 'function', function: { name: name.trim(), arguments: args } }
}

/**
 * 解析标签块内部的文本为 tool_calls。
 * 兼容 `[{...}, {...}]` 数组、单个 `{...}` 对象、以及 `{"name":"x","arguments":{...}}`。
 */
export function parseToolCalls(inner: string): ParseResult {
  const trimmed = (inner || '').trim()
  if (!trimmed) return { calls: [], failed: [], trailing: '' }

  const fixed = repairJson(trimmed)
  // 1) 严格/修复后能整体解析
  if (fixed) {
    try {
      const v = JSON.parse(fixed)
      if (Array.isArray(v)) {
        const calls = v.map(normalizeCall).filter(Boolean) as ParsedToolCall[]
        if (calls.length) return { calls, failed: [], trailing: '' }
      } else if (v && typeof v === 'object') {
        // 可能是 {"tool_calls":[...]} 或单个调用
        const arr = (v as any).tool_calls ?? (v as any).calls
        const calls = Array.isArray(arr)
          ? (arr.map(normalizeCall).filter(Boolean) as ParsedToolCall[])
          : ([normalizeCall(v)].filter(Boolean) as ParsedToolCall[])
        if (calls.length) return { calls, failed: [], trailing: '' }
      }
    } catch { /* 继续尝试提取 */ }
  }

  // 2) 从文本里逐个抠出平衡的 JSON 对象
  const calls: ParsedToolCall[] = []
  const failed: string[] = []
  let i = 0
  while (i < trimmed.length) {
    const start = trimmed.indexOf('{', i)
    if (start < 0) break
    const end = findBalancedEnd(trimmed, start)
    if (end < 0) { failed.push(trimmed.slice(start)); break }
    const chunk = trimmed.slice(start, end + 1)
    const fixedChunk = repairJson(chunk)
    if (fixedChunk) {
      try {
        const call = normalizeCall(JSON.parse(fixedChunk))
        if (call) calls.push(call)
        else failed.push(chunk)
      } catch { failed.push(chunk) }
    } else {
      failed.push(chunk)
    }
    i = end + 1
  }
  return { calls, failed, trailing: '' }
}

/** 找到从 start（必须是 `{`）开始、括号配平的结束位置；找不到返回 -1 */
function findBalancedEnd(s: string, start: number): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return i
      if (depth < 0) return -1
    }
  }
  return -1
}

// =====================================================================
// 流式：滑动窗口标签检测 + 增量转换
// =====================================================================

type ToolCallDelta = {
  index: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

export type StreamOut =
  | { kind: 'content'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool_calls'; calls: ToolCallDelta[] }
  | { kind: 'finish'; reason: 'stop' | 'tool_calls' }

/** 检测器输出：要么是可直接透传的文本，要么是待解析的完整工具块 */
export type DetectOut =
  | { kind: 'content'; text: string }
  | { kind: 'tool_block'; raw: string }

/**
 * 增量式标签检测器。
 *
 * 状态机（照 ds-free-api 的 tool_parser）：
 *   detecting  —— 维护 SCAN_WINDOW 扫描缓冲，未命中标签则释放「不可能再构成标签」的安全前缀
 *   collecting —— 已命中起始标签，收集到结束标签为止
 *   done       —— 已发出工具调用，其后内容全部吞掉（防模型继续幻觉）
 *
 * 关键点：**跨 chunk 断裂的标签**必须靠缓冲兜住，不能直接 indexOf ——
 * 上游 SSE 是任意切分的，`<|tool▁cal` + `ls▁begin|>` 这种情况很常见。
 */
export class ToolCallDetector {
  private buf = ''
  private collecting = false
  private collected = ''
  private done = false

  /** 喂入一个文本增量 */
  push(text: string): DetectOut[] {
    if (this.done) return []
    const out: DetectOut[] = []
    this.buf += text

    if (this.collecting) {
      // 收集模式：等结束标签。
      // ⚠️ 必须在 **collected + buf** 上找：起始标签命中时已把紧随其后的文本放进 collected，
      // 若只在 buf 上找，跨 chunk 的结束标签就会永远匹配不到（曾经的 bug）。
      this.collected += this.buf
      this.buf = ''
      const end = findEndTag(this.collected)
      if (end) {
        const raw = this.collected.slice(0, end.index).slice(0, MAX_XML_BUF_LEN)
        this.collected = ''
        this.done = true
        return [{ kind: 'tool_block', raw }]
      }
      if (this.collected.length > MAX_XML_BUF_LEN) {
        // 超限：放弃收集，当普通文本吐出，避免内容丢失/内存膨胀
        const text = this.collected
        this.collected = ''
        this.collecting = false
        this.done = true
        return text ? [{ kind: 'content', text }] : []
      }
      return out
    }

    // 检测模式：找起始标签（跳过代码围栏内的示例）
    let start = findStartTag(this.buf)
    while (start && isInsideCodeFence(this.buf, start.index)) {
      const past = start.index + start.text.length
      const next = findStartTag(this.buf.slice(past))
      start = next ? { index: past + next.index, text: next.text } : null
    }

    if (!start) {
      // 没命中：释放安全前缀，保留可能是不完整标签头的尾巴
      if (this.buf.length > SCAN_WINDOW) {
        const keep = SCAN_WINDOW
        let cut = this.buf.length - keep
        // 不要把可能正在构成标签的字符切出去
        const safe = this.buf.slice(0, cut)
        const lastMark = Math.max(safe.lastIndexOf('|'), safe.lastIndexOf('<'), safe.lastIndexOf('\u2581'))
        if (lastMark >= 0) cut = lastMark
        if (cut > 0) {
          out.push({ kind: 'content', text: this.buf.slice(0, cut) })
          this.buf = this.buf.slice(cut)
        }
      }
      return out
    }

    // 命中起始标签：标签前的文本正常透传
    const before = this.buf.slice(0, start.index)
    if (before) out.push({ kind: 'content', text: before })

    let rest = this.buf.slice(start.index + start.text.length)
    if (rest.startsWith('>')) rest = rest.slice(1)
    this.buf = ''

    // 同一 chunk 内可能已经带着结束标签
    const end = findEndTag(rest)
    if (end) {
      this.done = true
      return out.concat([{ kind: 'tool_block', raw: rest.slice(0, end.index).slice(0, MAX_XML_BUF_LEN) }])
    }
    this.collecting = true
    this.collected = rest
    return out
  }

  /** 流结束时冲掉缓冲 */
  flush(): DetectOut[] {
    if (this.done) return []
    const out: DetectOut[] = []
    if (this.collecting) {
      // 始终没等到结束标签：把已收集内容当普通文本吐出，避免丢失
      const text = this.collected + this.buf
      this.collected = ''
      this.buf = ''
      this.done = true
      if (text.trim()) out.push({ kind: 'content', text })
      return out
    }
    if (this.buf) {
      out.push({ kind: 'content', text: this.buf })
      this.buf = ''
    }
    return out
  }

  get isDone(): boolean { return this.done }
  get isCollecting(): boolean { return this.collecting }
}

// =====================================================================
// 提示词拼装（供 deepseek.ts 使用）
// =====================================================================

/**
 * 把工具上下文拼进已有的系统提示词末尾。
 * 保持「工具定义 -> 格式规范 -> 行为指令 -> 输出格式约束」的顺序（照 ds-free-api）。
 */
export function composeSystemSections(toolCtx: ToolContext, responseFormatText?: string): string {
  const sections: string[] = []
  if (toolCtx.defsText) sections.push(toolCtx.defsText)
  if (toolCtx.formatBlock) sections.push(toolCtx.formatBlock)
  if (toolCtx.instructionText) sections.push(toolCtx.instructionText)
  if (responseFormatText) sections.push(responseFormatText)
  return sections.join('\n\n')
}
