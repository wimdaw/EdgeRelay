/**
 * OpenAI Responses 协议翻译（chat/completions <-> /responses）
 *
 * ChatGPT(Codex) 与 Grok(xAI) 的 OAuth 上游都只接受 Responses 协议：
 * 请求翻译成 Responses 格式，响应（含 SSE 流式）翻译回 OpenAI chat/completions。
 * 纯函数，不依赖存储或运行时环境。参照 CLIProxyAPI 的 translator/codex 实现。
 */

function randomId(): string {
  try { return crypto.randomUUID() } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` }
}

export interface OpenAIUsage {
  promptTokens: number
  completionTokens: number
}

/** 推理模型（不接受 temperature 等采样参数，支持 reasoning.effort） */
export function isReasoningModel(model: string): boolean {
  return /gpt-5|gpt-6|codex|^o[134]/i.test(model || '')
}

// =====================================================================
// OpenAI -> Responses 请求翻译
// =====================================================================

/** OpenAI 消息 content -> Responses 输入 parts */
function contentToInputParts(content: unknown, role: string): Array<Record<string, any>> {
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  if (typeof content === 'string') {
    return content ? [{ type: textType, text: content }] : []
  }
  const parts: Array<Record<string, any>> = []
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const it = item as Record<string, any>
      if (it.type === 'text' && typeof it.text === 'string' && it.text) {
        parts.push({ type: textType, text: it.text })
      } else if (it.type === 'image_url') {
        const url = it.image_url?.url
        if (typeof url === 'string' && url) parts.push({ type: 'input_image', image_url: url })
      }
    }
  } else if (content && typeof content === 'object' && typeof (content as any).text === 'string') {
    parts.push({ type: textType, text: (content as any).text })
  }
  return parts
}

/** OpenAI chat/completions 请求 -> Responses 请求 */
export function openAIToResponsesRequest(body: Record<string, any>, opts?: { defaultInstructions?: string }): { request: Record<string, any> } {
  const input: Array<Record<string, any>> = []
  const systemParts: string[] = []

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    const role = msg?.role
    if (role === 'system' || role === 'developer') {
      const parts = contentToInputParts(msg.content, 'user')
      for (const p of parts) if (p.text) systemParts.push(p.text)
      continue
    }
    if (role === 'user') {
      const parts = contentToInputParts(msg.content, 'user')
      input.push({ role: 'user', content: parts.length > 0 ? parts : [{ type: 'input_text', text: '' }] })
      continue
    }
    if (role === 'assistant') {
      const parts = contentToInputParts(msg.content, 'assistant')
      if (parts.length > 0) input.push({ role: 'assistant', content: parts })
      for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
        const fn = tc?.function
        if (!fn?.name) continue
        input.push({
          type: 'function_call',
          call_id: tc.id || `call_${randomId().replace(/-/g, '').slice(0, 24)}`,
          name: fn.name,
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        })
      }
      continue
    }
    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id || `call_${randomId().replace(/-/g, '').slice(0, 24)}`,
        output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
      })
      continue
    }
  }

  const model = String(body.model || '')
  const request: Record<string, any> = {
    model,
    input,
    // Codex 后端要求 instructions 字段存在；系统消息合并进来
    instructions: systemParts.length > 0 ? systemParts.join('\n\n') : (opts?.defaultInstructions ?? ''),
    store: false,
  }

  // 工具
  const tools: Array<Record<string, any>> = []
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    const fn = (t as Record<string, any>)?.function
    if (!fn?.name) continue
    tools.push({
      type: 'function',
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object' },
      strict: false,
    })
  }
  if (tools.length > 0) request.tools = tools
  const tc = body.tool_choice
  if (tc === 'auto' || tc === 'none' || tc === 'required') request.tool_choice = tc
  else if (tc && typeof tc === 'object' && (tc.function?.name || tc.name)) request.tool_choice = { type: 'function', name: tc.function?.name || tc.name }
  if (body.parallel_tool_calls !== undefined && tools.length > 0) request.parallel_tool_calls = !!body.parallel_tool_calls

  // 采样参数：推理模型不接受
  if (!isReasoningModel(model)) {
    if (typeof body.temperature === 'number') request.temperature = body.temperature
    if (typeof body.top_p === 'number') request.top_p = body.top_p
  } else {
    const effort = body.reasoning_effort
    request.reasoning = {
      effort: ['minimal', 'low', 'medium', 'high'].includes(effort) ? effort : 'medium',
      summary: 'auto',
    }
  }

  const maxTokens = Number(body.max_completion_tokens ?? body.max_tokens)
  if (maxTokens > 0) request.max_output_tokens = maxTokens

  const stop = body.stop
  if (typeof stop === 'string' && stop) request.stop = [stop]
  else if (Array.isArray(stop) && stop.length > 0) request.stop = stop

  if (body.stream === true) {
    request.stream = true
  }
  return { request }
}

// =====================================================================
// Responses -> OpenAI 响应翻译（非流式）
// =====================================================================

/** Responses 响应 -> OpenAI chat.completion 响应 */
export function responsesResponseToOpenAI(json: any, requestedModel: string): Record<string, any> {
  const output: any[] = Array.isArray(json?.output) ? json.output : []
  let text = ''
  const toolCalls: Array<Record<string, any>> = []
  for (const item of output) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text
      }
    } else if (item?.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id || `call_${randomId().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: { name: item.name || '', arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) },
      })
    }
  }
  const message: Record<string, any> = { role: 'assistant', content: text || null, refusal: null }
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  const usage = json?.usage || {}
  const promptTokens = Number(usage.input_tokens) || 0
  const completionTokens = Number(usage.output_tokens) || 0
  let finish = 'stop'
  if (toolCalls.length > 0) finish = 'tool_calls'
  else if (json?.status === 'incomplete' && json?.incomplete_details?.reason === 'max_output_tokens') finish = 'length'
  return {
    id: json?.id || `chatcmpl-${randomId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, message, finish_reason: finish, logprobs: null }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: Number(usage.total_tokens) || promptTokens + completionTokens,
    },
  }
}

// =====================================================================
// Responses SSE -> OpenAI SSE 流式翻译
// =====================================================================

/**
 * 把 Responses API 的 SSE 流翻译成 OpenAI chat.completion.chunk SSE 流。
 * 兼容两种分帧：`event: <name>` + `data: {json...}`（type 字段优先）与纯 data 行。
 * onUsage 在流结束时回调。
 */
export function createOpenAIStreamFromResponses(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
  onUsage?: (usage: OpenAIUsage) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const parser = createSseParser()
  let firstChunkSent = false
  let toolIndex = -1
  // output_index -> 该 item 是否已登记为 tool call
  const toolItems = new Set<number>()
  let promptTokens = 0
  let completionTokens = 0
  let streamError = ''

  const sendChunk = (controller: ReadableStreamDefaultController<Uint8Array>, delta: Record<string, any>, finish: string | null = null, withUsage = false) => {
    const chunk: Record<string, any> = {
      id: `chatcmpl-resp-${randomId()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    }
    if (withUsage) chunk.usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
  }

  const handleEvent = (controller: ReadableStreamDefaultController<Uint8Array>, ev: SseEvent) => {
    if (!ev.data || ev.data === '[DONE]') return
    let payload: any
    try { payload = JSON.parse(ev.data) } catch { return }
    const type = payload?.type || ev.event
    if (!type || !type.startsWith('response.')) return

    switch (type) {
      case 'response.created':
      case 'response.in_progress': {
        break
      }
      case 'response.output_item.added': {
        const item = payload?.item || {}
        if (item.type === 'function_call') {
          toolItems.add(Number(payload.output_index ?? -1))
          toolIndex += 1
          sendChunk(controller, {
            tool_calls: [{
              index: toolIndex,
              id: item.call_id || item.id || `call_${randomId().replace(/-/g, '').slice(0, 24)}`,
              type: 'function',
              function: { name: item.name || '', arguments: '' },
            }],
          })
        }
        break
      }
      case 'response.output_text.delta': {
        if (typeof payload.delta === 'string' && payload.delta) sendChunk(controller, { content: payload.delta })
        break
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        if (typeof payload.delta === 'string' && payload.delta) sendChunk(controller, { reasoning_content: payload.delta })
        break
      }
      case 'response.function_call_arguments.delta': {
        if (typeof payload.delta === 'string' && payload.delta && toolItems.has(Number(payload.output_index ?? -1))) {
          sendChunk(controller, { tool_calls: [{ index: toolIndex, function: { arguments: payload.delta } }] })
        }
        break
      }
      case 'response.completed':
      case 'response.incomplete': {
        const usage = payload?.response?.usage || {}
        promptTokens = Number(usage.input_tokens) || 0
        completionTokens = Number(usage.output_tokens) || 0
        const finish = type === 'response.incomplete' ? 'length' : 'stop'
        sendChunk(controller, {}, toolIndex >= 0 ? 'tool_calls' : finish, true)
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        if (onUsage) onUsage({ promptTokens, completionTokens })
        break
      }
      case 'response.failed': {
        const msg = payload?.response?.error?.message || '上游响应失败'
        sendChunk(controller, { content: `[codex] ${msg}` }, 'stop', true)
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        break
      }
      case 'error': {
        streamError = payload?.message || payload?.error?.message || '上游流错误'
        break
      }
      default:
        break
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = upstream.getReader()
      const pump = () => {
        reader.read().then(({ done, value }) => {
          if (done) {
            if (streamError) sendChunk(controller, { content: `[codex] ${streamError}` }, 'stop', true)
            if (!firstChunkSent) sendChunk(controller, { role: 'assistant', content: '' }, 'stop', true)
            controller.close()
            return
          }
          const text = decoder.decode(value, { stream: true })
          for (const ev of parser.feed(text)) {
            if (!firstChunkSent) {
              firstChunkSent = true
              sendChunk(controller, { role: 'assistant', content: '' })
            }
            handleEvent(controller, ev)
          }
          pump()
        }).catch(() => {
          try { controller.close() } catch { /* already closed */ }
        })
      }
      pump()
    },
  })
}

interface SseEvent { event: string; data: string }

/**
 * 消费 Responses SSE 流并聚合为单个 OpenAI chat.completion 响应。
 * Codex 等上游强制 stream=true，客户端要非流式时在这里本地聚合（含文本、推理摘要、工具调用与用量）。
 */
export async function collectResponsesStreamToOpenAI(
  upstream: ReadableStream<Uint8Array>,
  requestedModel: string,
): Promise<Record<string, any>> {
  const decoder = new TextDecoder()
  const parser = createSseParser()
  const reader = upstream.getReader()

  let text = ''
  let reasoning = ''
  const toolCalls: Array<{ id: string; name: string; args: string }> = []
  const toolIndexByOutput = new Map<number, number>()
  let promptTokens = 0
  let completionTokens = 0
  let finish = 'stop'
  let failed = ''

  const handle = (ev: SseEvent) => {
    if (!ev.data || ev.data === '[DONE]') return
    let payload: any
    try { payload = JSON.parse(ev.data) } catch { return }
    const type = payload?.type || ev.event
    if (!type || !type.startsWith('response.')) return

    switch (type) {
      case 'response.output_item.added': {
        const item = payload?.item || {}
        if (item.type === 'function_call') {
          toolIndexByOutput.set(Number(payload.output_index ?? -1), toolCalls.length)
          toolCalls.push({
            id: item.call_id || item.id || `call_${randomId().replace(/-/g, '').slice(0, 24)}`,
            name: item.name || '',
            args: '',
          })
        }
        break
      }
      case 'response.output_text.delta': {
        if (typeof payload.delta === 'string') text += payload.delta
        break
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        if (typeof payload.delta === 'string') reasoning += payload.delta
        break
      }
      case 'response.function_call_arguments.delta': {
        const idx = toolIndexByOutput.get(Number(payload.output_index ?? -1))
        if (idx !== undefined && typeof payload.delta === 'string') toolCalls[idx].args += payload.delta
        break
      }
      case 'response.completed':
      case 'response.incomplete': {
        const usage = payload?.response?.usage || {}
        promptTokens = Number(usage.input_tokens) || 0
        completionTokens = Number(usage.output_tokens) || 0
        if (toolCalls.length > 0) finish = 'tool_calls'
        else if (type === 'response.incomplete') finish = 'length'
        break
      }
      case 'response.failed': {
        failed = payload?.response?.error?.message || '上游响应失败'
        break
      }
      case 'error': {
        failed = payload?.message || payload?.error?.message || '上游流错误'
        break
      }
      default:
        break
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    for (const ev of parser.feed(decoder.decode(value, { stream: true }))) handle(ev)
  }
  if (failed) throw new Error(failed)

  const message: Record<string, any> = { role: 'assistant', content: text || null, refusal: null }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((t) => ({
      id: t.id,
      type: 'function',
      function: { name: t.name, arguments: t.args || '{}' },
    }))
  }
  return {
    id: `chatcmpl-resp-${randomId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, message, finish_reason: finish, logprobs: null }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }
}

function createSseParser(): { feed: (chunk: string) => SseEvent[] } {
  let buffer = ''
  let currentEvent = ''
  let currentData = ''
  const finish = (out: SseEvent[]) => {
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
        if (line === '') {
          finish(out)
          currentEvent = ''
        } else if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          currentData += (currentData ? '\n' : '') + line.slice(5).trim()
        }
      }
      return out
    },
  }
}
