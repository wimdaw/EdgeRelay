/**
 * Gemini 网页版反代的裸 socket HTTP 客户端
 *
 * 为什么不用 fetch：
 * Workers/Node 的 fetch 会自动协商 HTTP/2、加上 `Accept-Encoding: br, gzip`
 * 之类的特征头，且子请求走平台的共享出口。Gemini 的网页前端协议对这一点很敏感，
 * 用标准 fetch 发过去会被判为自动化流量并返回 400（错误载荷里带 ["xsrf", ...]）。
 * 这里改为自行拼接 HTTP/1.1 请求头并控制编码，行为更接近真实浏览器。
 *
 * 移植自 goehou/gemini-web2api 的 socketHttp 实现（MIT）。
 */

/** 与 fetch 的 Response 子集，保持调用方代码不用改 */
export interface SocketResponse {
  status: number
  ok: boolean
  headers: Headers
  body: ReadableStream<Uint8Array> | null
  text(): Promise<string>
}

export interface SocketRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array<ArrayBuffer> | null
  timeoutMs?: number
}

type ConnectFn = (
  addr: { hostname: string; port: number },
  opts: { secureTransport: string; allowHalfOpen: boolean },
) => {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  close(): void
}

let _connect: ConnectFn | null | undefined

/**
 * 解析当前运行时能不能拿到 connect()。
 * Cloudflare Workers/Pages 走 cloudflare:sockets；Node 走 node:tls 自己拼一个
 * 同形状的 connect()。两边都拿不到才返回 null，调用方回退 fetch。
 * 用 new Function 包一层是为了让 esbuild 不要静态解析 node:tls（Pages 是
 * platform=neutral 打的，解析不到也不该被打进去）。
 */
async function resolveConnect(): Promise<ConnectFn | null> {
  if (_connect !== undefined) return _connect

  try {
    const mod: { connect?: ConnectFn } = await import('cloudflare:sockets')
    if (mod.connect) {
      _connect = mod.connect
      return _connect
    }
  } catch {
    // 非 Workers 运行时，走下面的 Node 分支
  }

  _connect = await createNodeConnect()
  return _connect
}

/** Node 运行时：用 node:tls 建一个和 cloudflare:sockets 同形状的 connect() */
async function createNodeConnect(): Promise<ConnectFn | null> {
  let tls: any
  try {
    const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>
    tls = await dynamicImport('node:tls')
  } catch {
    return null
  }
  if (!tls?.connect) return null

  const connect: ConnectFn = (addr, opts) => {
    const sock = tls.connect({
      host: addr.hostname,
      port: addr.port,
      servername: opts.secureTransport === 'on' ? addr.hostname : undefined,
      ALPNProtocols: ['http/1.1'],
    })
    sock.setNoDelay?.(true)

    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        sock.on('data', (c: Uint8Array) => controller.enqueue(new Uint8Array(c)))
        sock.on('end', () => { try { controller.close() } catch { /* 已关闭 */ } })
        sock.on('error', (e: Error) => { try { controller.error(e) } catch { /* 已关闭 */ } })
      },
      cancel() { sock.destroy() },
    })

    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise((resolve, reject) => {
          sock.write(chunk, (err?: Error | null) => (err ? reject(err) : resolve()))
        })
      },
      close() { sock.end() },
      abort() { sock.destroy() },
    })

    return { readable, writable, close: () => sock.destroy() }
  }
  return connect
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(a.length + b.length))
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function findCRLF(buf: Uint8Array, from: number): number {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i
  }
  return -1
}

function findDoubleCRLF(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i
  }
  return -1
}

/** 裸 socket 发一个 HTTP/1.1 请求，返回解完 chunked 的类 Response 对象 */
export async function socketHttp(
  connect: ConnectFn,
  url: string,
  init: SocketRequestInit = {},
): Promise<SocketResponse> {
  const { method = 'GET', headers = {}, body = null, timeoutMs = 180000 } = init
  const u = new URL(url)
  const secure = u.protocol !== 'http:'
  const port = u.port ? Number(u.port) : secure ? 443 : 80
  const socket = connect(
    { hostname: u.hostname, port },
    { secureTransport: secure ? 'on' : 'off', allowHalfOpen: false },
  )

  let timer: ReturnType<typeof setTimeout> | null = null
  if (timeoutMs) timer = setTimeout(() => { try { socket.close() } catch { /* 已关闭 */ } }, timeoutMs)

  const enc = new TextEncoder()
  const bodyBytes =
    body == null ? null : typeof body === 'string' ? enc.encode(body) : new Uint8Array(body)

  // Host / Accept-Encoding / Connection / Content-Length 全部自管，不让平台代填
  const reqHeaders: Record<string, string> = {
    Host: u.hostname,
    'Accept-Encoding': 'identity',
    Connection: 'close',
  }
  for (const [k, v] of Object.entries(headers)) {
    if (/^(host|connection|accept-encoding|content-length)$/i.test(k)) continue
    reqHeaders[k] = v
  }
  if (bodyBytes) reqHeaders['Content-Length'] = String(bodyBytes.length)

  let head = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n`
  for (const [k, v] of Object.entries(reqHeaders)) head += `${k}: ${v}\r\n`
  head += '\r\n'

  const writer = socket.writable.getWriter()
  await writer.write(enc.encode(head))
  if (bodyBytes) await writer.write(bodyBytes)
  try { writer.releaseLock() } catch { /* 已释放 */ }

  const reader = socket.readable.getReader()
  let buf = new Uint8Array(0)
  let he = -1
  while (he < 0) {
    const { done, value } = await reader.read()
    if (done) break
    buf = concatBytes(buf, value)
    he = findDoubleCRLF(buf)
  }
  if (he < 0) {
    if (timer) clearTimeout(timer)
    throw new Error('socket: HTTP 响应头不完整')
  }

  const headerText = new TextDecoder().decode(buf.slice(0, he))
  let pending = buf.slice(he + 4)
  const hlines = headerText.split('\r\n')
  const status = parseInt((hlines[0] || '').split(' ')[1], 10) || 0
  const respHeaders = new Headers()
  for (let i = 1; i < hlines.length; i++) {
    const c = hlines[i].indexOf(':')
    if (c > 0) {
      try {
        respHeaders.append(hlines[i].slice(0, c).trim(), hlines[i].slice(c + 1).trim())
      } catch { /* 非法头名，跳过 */ }
    }
  }

  const chunked = /chunked/i.test(respHeaders.get('transfer-encoding') || '')
  const clen = respHeaders.has('content-length')
    ? parseInt(respHeaders.get('content-length') as string, 10)
    : null

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const pull = async (): Promise<boolean> => {
        const { done, value } = await reader.read()
        if (done) return false
        pending = concatBytes(pending, value)
        return true
      }
      try {
        if (chunked) {
          for (;;) {
            let nl = findCRLF(pending, 0)
            while (nl < 0) {
              if (!(await pull())) { controller.close(); return }
              nl = findCRLF(pending, 0)
            }
            const size = parseInt(new TextDecoder().decode(pending.slice(0, nl)).trim().split(';')[0], 16)
            pending = pending.slice(nl + 2)
            if (!size || Number.isNaN(size)) { controller.close(); return }
            while (pending.length < size + 2) {
              if (!(await pull())) break
            }
            controller.enqueue(pending.slice(0, size))
            pending = pending.slice(size + 2)
          }
        } else if (clen != null) {
          let got = 0
          if (pending.length) {
            const t = pending.slice(0, clen)
            controller.enqueue(t)
            got += t.length
            pending = pending.slice(t.length)
          }
          while (got < clen) {
            const { done, value } = await reader.read()
            if (done) break
            const need = clen - got
            const t = value.length > need ? value.slice(0, need) : value
            controller.enqueue(t)
            got += t.length
          }
          controller.close()
        } else {
          if (pending.length) controller.enqueue(pending)
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            controller.enqueue(value)
          }
          controller.close()
        }
      } catch (err) {
        controller.error(err)
      } finally {
        if (timer) clearTimeout(timer)
        try { reader.releaseLock() } catch { /* 已释放 */ }
        try { socket.close() } catch { /* 已关闭 */ }
      }
    },
    cancel() {
      if (timer) clearTimeout(timer)
      try { socket.close() } catch { /* 已关闭 */ }
    },
  })

  const res: SocketResponse = {
    status,
    ok: status >= 200 && status < 300,
    headers: respHeaders,
    body: stream,
    text: async () => {
      const r = stream.getReader()
      let acc = new Uint8Array(0)
      for (;;) {
        const { done, value } = await r.read()
        if (done) break
        acc = concatBytes(acc, value)
      }
      return new TextDecoder().decode(acc)
    },
  }
  return res
}

/**
 * 统一出口：能拿到裸 socket 就走 socket（行为接近浏览器），否则回退 fetch。
 * socket 侧失败时也回退一次，避免单点故障直接打死整条渠道。
 */
export async function rawFetch(
  url: string,
  init: SocketRequestInit & { signal?: AbortSignal } = {},
): Promise<SocketResponse | Response> {
  const connect = await resolveConnect()
  if (connect) {
    try {
      return await socketHttp(connect, url, init)
    } catch {
      // socket 不可用/中途断开，落到下面的 fetch
    }
  }
  const { signal, ...rest } = init
  return fetch(url, { ...rest, signal })
}