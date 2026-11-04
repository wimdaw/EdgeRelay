/**
 * DeepSeekHashV1 + PoW 解算（纯 JS，无 WASM 依赖）
 *
 * DeepSeek 网页版 /api/v0/chat/completion 需要 x-ds-pow-response 头，其中 answer 需满足：
 *   DeepSeekHashV1(`<salt>_<expire_at>_` + str(answer)) === challenge
 * 且 answer ∈ [0, difficulty)（典型 difficulty = 144000）。
 *
 * DeepSeekHashV1 不是标准 SHA3-256：它是 Keccak-f[1600] **跳过 round 0**（只做 rounds 1..23），
 * 其余与 SHA3-256 相同（rate=136 字节、padding 0x06 + 0x80、输出 32 字节）。
 * 参照 CJackHwang/ds2api pow/deepseek_hash.go 与 DeepSeek 官方 sha3_wasm 的行为实现。
 *
 * 注：解算为纯 CPU 计算，实测约 0.005 ms/次哈希（V8），difficulty=144000 最坏约 0.7s、
 * 平均约 0.35s —— Cloudflare Workers 免费版 CPU 上限 10ms 无法完成，需 Workers Paid。
 */

// Keccak round constants，拆成 lo32/hi32（小端 64 位lane）
const RC_LO = new Uint32Array([
  0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001,
  0x80008081, 0x00008009, 0x0000008a, 0x00000088, 0x80008009, 0x8000000a,
  0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002, 0x00000080,
  0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008,
])
const RC_HI = new Uint32Array([
  0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000,
  0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000,
])
// rho 旋转偏移，按 lane 索引 (x + 5y)
const RHO = new Uint8Array([0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14])

const RATE = 136

/**
 * Keccak-f[1600] 置换。startRound=1 即 DeepSeekHashV1（跳过 round 0）；startRound=0 为标准 SHA3-256。
 * 状态用 25 个 64 位 lane 的 lo/hi 32 位对表示（小端）。
 */
export function keccakF(lo: Uint32Array, hi: Uint32Array, startRound = 1): void {
  const cLo = new Uint32Array(5), cHi = new Uint32Array(5)
  const dLo = new Uint32Array(5), dHi = new Uint32Array(5)
  const bLo = new Uint32Array(25), bHi = new Uint32Array(25)

  for (let r = startRound; r < 24; r++) {
    // theta
    for (let x = 0; x < 5; x++) {
      cLo[x] = lo[x] ^ lo[x + 5] ^ lo[x + 10] ^ lo[x + 15] ^ lo[x + 20]
      cHi[x] = hi[x] ^ hi[x + 5] ^ hi[x + 10] ^ hi[x + 15] ^ hi[x + 20]
    }
    for (let x = 0; x < 5; x++) {
      const n = (x + 1) % 5, p = (x + 4) % 5
      dLo[x] = cLo[p] ^ ((cLo[n] << 1) | (cHi[n] >>> 31))
      dHi[x] = cHi[p] ^ ((cHi[n] << 1) | (cLo[n] >>> 31))
    }
    for (let i = 0; i < 25; i++) { lo[i] ^= dLo[i % 5]; hi[i] ^= dHi[i % 5] }

    // rho + pi: dest = y + 5*((2x+3y) mod 5)
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const src = x + 5 * y
        const dest = y + 5 * ((2 * x + 3 * y) % 5)
        const k = RHO[src]
        if (k === 0) { bLo[dest] = lo[src]; bHi[dest] = hi[src] }
        else if (k < 32) {
          bLo[dest] = (lo[src] << k) | (hi[src] >>> (32 - k))
          bHi[dest] = (hi[src] << k) | (lo[src] >>> (32 - k))
        } else {
          const kk = k - 32
          bLo[dest] = kk === 0 ? hi[src] : (hi[src] << kk) | (lo[src] >>> (32 - kk))
          bHi[dest] = kk === 0 ? lo[src] : (lo[src] << kk) | (hi[src] >>> (32 - kk))
        }
      }
    }

    // chi
    for (let y = 0; y < 5; y++) {
      const o = 5 * y
      for (let x = 0; x < 5; x++) {
        const n1 = o + ((x + 1) % 5), n2 = o + ((x + 2) % 5)
        lo[o + x] = bLo[o + x] ^ (~bLo[n1] & bLo[n2])
        hi[o + x] = bHi[o + x] ^ (~bHi[n1] & bHi[n2])
      }
    }

    // iota
    lo[0] ^= RC_LO[r]
    hi[0] ^= RC_HI[r]
  }
}

/** 吸收一个 rate 大小的块并置换 */
function absorbBlock(lo: Uint32Array, hi: Uint32Array, buf: Uint8Array, off: number, startRound: number): void {
  for (let i = 0; i < RATE / 8; i++) {
    const p = off + i * 8
    lo[i] ^= buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)
    hi[i] ^= buf[p + 4] | (buf[p + 5] << 8) | (buf[p + 6] << 16) | (buf[p + 7] << 24)
  }
  keccakF(lo, hi, startRound)
}

/** 通用 sponge 哈希（startRound=1 → DeepSeekHashV1；0 → SHA3-256） */
function spongeHash(data: Uint8Array, outLen: number, startRound: number): Uint8Array {
  const lo = new Uint32Array(25), hi = new Uint32Array(25)
  let off = 0
  while (off + RATE <= data.length) { absorbBlock(lo, hi, data, off, startRound); off += RATE }
  const rem = data.length - off
  const last = new Uint8Array(RATE)
  last.set(data.subarray(off, off + rem))
  last[rem] = 0x06
  last[RATE - 1] |= 0x80
  absorbBlock(lo, hi, last, 0, startRound)

  const out = new Uint8Array(outLen)
  for (let i = 0; i < Math.ceil(outLen / 8); i++) {
    const l = lo[i], h = hi[i]
    const p = i * 8
    if (p < outLen) { out[p] = l & 0xff; if (p + 1 < outLen) out[p + 1] = (l >>> 8) & 0xff; if (p + 2 < outLen) out[p + 2] = (l >>> 16) & 0xff; if (p + 3 < outLen) out[p + 3] = (l >>> 24) & 0xff }
    if (p + 4 < outLen) { out[p + 4] = h & 0xff; if (p + 5 < outLen) out[p + 5] = (h >>> 8) & 0xff; if (p + 6 < outLen) out[p + 6] = (h >>> 16) & 0xff; if (p + 7 < outLen) out[p + 7] = (h >>> 24) & 0xff }
  }
  return out
}

/** DeepSeekHashV1（32 字节） */
export function deepseekHashV1(data: Uint8Array): Uint8Array {
  return spongeHash(data, 32, 1)
}

/** 标准 SHA3-256（仅用于自检对照） */
export function sha3_256(data: Uint8Array): Uint8Array {
  return spongeHash(data, 32, 0)
}

export function toHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

export interface DsPowChallenge {
  algorithm: string
  challenge: string
  salt: string
  expire_at: number
  difficulty?: number
  signature?: string
  target_path?: string
}

export function buildPowPrefix(salt: string, expireAt: number | string): string {
  return `${salt}_${expireAt}_`
}

/**
 * 解算 PoW：搜索 answer ∈ [0, difficulty) 使 DeepSeekHashV1(prefix + str(answer)) === challenge。
 * prefix 预吸收，循环内只做一次置换。maxMs 为 CPU 预算（超时返回 null，避免 Worker 被强杀）。
 */
export function solveDeepseekPow(prefix: string, challengeHex: string, difficulty: number, maxMs = 25000): number | null {
  if (!challengeHex || challengeHex.length !== 64) return null
  const target = new Uint8Array(32)
  for (let i = 0; i < 32; i++) target[i] = parseInt(challengeHex.substr(i * 2, 2), 16)
  const T = new Uint32Array(8)
  for (let i = 0; i < 8; i++) T[i] = target[i * 4] | (target[i * 4 + 1] << 8) | (target[i * 4 + 2] << 16) | (target[i * 4 + 3] << 24)

  const prefixBytes = new TextEncoder().encode(prefix)
  const lo = new Uint32Array(25), hi = new Uint32Array(25)
  let off = 0
  while (off + RATE <= prefixBytes.length) { absorbBlock(lo, hi, prefixBytes, off, 1); off += RATE }
  const tailLen = prefixBytes.length - off
  const tail = prefixBytes.subarray(off)

  const numBuf = new Uint8Array(20)
  const block = new Uint8Array(RATE)
  const sLo = new Uint32Array(25), sHi = new Uint32Array(25)
  const started = Date.now()

  for (let n = 0; n < difficulty; n++) {
    if ((n & 0x3ff) === 0 && Date.now() - started > maxMs) return null
    let v = n, pos = 20
    if (v === 0) { pos--; numBuf[pos] = 48 } else { while (v > 0) { pos--; numBuf[pos] = 48 + (v % 10); v = (v / 10) | 0 } }
    const numLen = 20 - pos

    sLo.set(lo); sHi.set(hi)
    block.fill(0)
    block.set(tail, 0)
    block.set(numBuf.subarray(pos, 20), tailLen)
    const total = tailLen + numLen
    block[total] = 0x06
    block[RATE - 1] |= 0x80
    absorbBlock(sLo, sHi, block, 0, 1)

    if (sLo[0] === T[0] && sHi[0] === T[1] && sLo[1] === T[2] && sHi[1] === T[3] &&
        sLo[2] === T[4] && sHi[2] === T[5] && sLo[3] === T[6] && sHi[3] === T[7]) return n
  }
  return null
}

/** 构造 x-ds-pow-response 头：base64(JSON{算法,challenge,salt,answer,signature,target_path}) */
export function buildPowHeader(c: DsPowChallenge, answer: number): string {
  const payload = JSON.stringify({
    algorithm: c.algorithm,
    challenge: c.challenge,
    salt: c.salt,
    answer,
    signature: c.signature || '',
    target_path: c.target_path || '/api/v0/chat/completion',
  })
  const bytes = new TextEncoder().encode(payload)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** 端到端：challenge → x-ds-pow-response 头值（失败返回 null） */
export function solveAndBuildPowHeader(c: DsPowChallenge, maxMs = 25000): string | null {
  if (c.algorithm !== 'DeepSeekHashV1') return null
  const difficulty = Number(c.difficulty) > 0 ? Number(c.difficulty) : 144000
  const answer = solveDeepseekPow(buildPowPrefix(c.salt, c.expire_at), c.challenge, difficulty, maxMs)
  if (answer === null) return null
  return buildPowHeader(c, answer)
}

/** 自检：DeepSeekHashV1("") 与标准 SHA3-256("") 的已知向量（后台诊断用） */
export function powSelfTest(): { ok: boolean; deepseek: string; sha3: string } {
  const empty = new Uint8Array(0)
  const ds = toHex(deepseekHashV1(empty))
  const s3 = toHex(sha3_256(empty))
  return {
    ok: ds === 'e594808bc5b7151ac160c6d39a02e0a8e261ed588578403099e3561dc40c26b3'
      && s3 === 'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a',
    deepseek: ds,
    sha3: s3,
  }
}
