/**
 * Qoder COSY 协议工具：请求签名、会话加密与设备指纹派生
 *
 * 参考实现：shuishuipingan/qoder2api-hub（Python）、Zhengyuuuui/qoder2api（Go）。
 * 关键约束：
 *  1. 每次请求的 Authorization 是 `Bearer COSY.<payload>.<md5签名>`；
 *     签名覆盖 payload、cosyKey、时间戳、**编码后的请求体**与去掉 /algo 的路径。
 *  2. 请求体必须用 Qoder 自定义的 base64 变体编码（换表 + 1/3 旋转）。
 *  3. 身份体（9 个字段）用临时密钥 AES-128-CBC 加密，临时密钥再用服务端
 *     固定 RSA 公钥做 PKCS#1 v1.5 加密——WebCrypto 不支持 v1.5 加密，
 *     这里用 BigInt 手写模幂。
 *  4. machineId / machineToken / machineType 必须按账号稳定派生，否则上游
 *     会把同一账号视为频繁换设备。
 */
import { md5Hex } from "../md5";

const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Qoder 服务端 RSA 公钥（1024 位，SPKI 内 n 的十六进制） */
const RSA_N_HEX =
  "c0f22307e5cd362e296bb04470f6de8fbf935ce24e8fcf511a0e2701329769c4a76e499bb938036a52af1eaf818cf79a2600620e3ce87e371d2ca6d85803606a1b3fa5e874643c9ed2db7e85673ef7227fca56e2e7c08f0927609bb896a9f24be1782099a66016a5bfdc3f1ff756bfc9e88d7b5dc5be30bf45a0223a00ebcecf";
const RSA_N = BigInt("0x" + RSA_N_HEX);
const RSA_E = 65537n;
const RSA_BYTES = 128;

export const COSY_VERSION = "1.1.75";
export const COSY_CLIENT_TYPE = "5";
/** 官方客户端上报的 IP 形态；与真实出口无关，仅作身份一致性 */
const COSY_CLIENT_IP = "169.254.198.161";
const COSY_MACHINE_OS = "x86_64_linux";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return BigInt("0x" + (hex || "0"));
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const hex = value.toString(16).padStart(length * 2, "0");
  return hexToBytes(hex);
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** RSA PKCS#1 v1.5 (type 2) 加密：WebCrypto 不支持，手写模幂 */
function rsaPkcs1v15Encrypt(message: Uint8Array): Uint8Array {
  const k = RSA_BYTES;
  if (message.length > k - 11) throw new Error("Qoder RSA: message too long");
  const psLen = k - 3 - message.length;
  const ps = new Uint8Array(psLen);
  let filled = 0;
  while (filled < psLen) {
    const rand = crypto.getRandomValues(new Uint8Array(psLen - filled));
    for (const b of rand) {
      if (b === 0) continue;
      ps[filled++] = b;
      if (filled >= psLen) break;
    }
  }
  const em = new Uint8Array(k);
  em[0] = 0x00;
  em[1] = 0x02;
  em.set(ps, 2);
  em[2 + psLen] = 0x00;
  em.set(message, 3 + psLen);
  const c = modPow(bytesToBigInt(em), RSA_E, RSA_N);
  return bigIntToBytes(c, k);
}

async function aesCbcEncrypt(plain: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  // TS 5.7+ 的 Uint8Array 默认泛型是 ArrayBufferLike，与 DOM 的 BufferSource 不兼容
  const keyBytes = key as unknown as BufferSource;
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: keyBytes },
    cryptoKey,
    plain as unknown as BufferSource
  );
  return new Uint8Array(encrypted);
}

/** Qoder 自定义 base64：标准表 → 换表，并做 1/3 旋转 */
export function qoderEncode(text: string): string {
  const std = bytesToBase64(utf8(text));
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  const map = new Map<string, string>();
  for (let i = 0; i < 64; i++) map.set(STD_ALPHABET[i], CUSTOM_ALPHABET[i]);
  map.set("=", "$");
  let out = "";
  for (const ch of rearranged) out += map.get(ch) ?? ch;
  return out;
}

/** 键排序 + 无空白的紧凑 JSON（服务端签名字节与此强绑定） */
export function sortedJson(obj: Record<string, string>): string {
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k] ?? "")}`).join(",") + "}";
}

function hexToUuidV4(hex: string): string {
  const h = hex.slice(0, 12) + "4" + hex.slice(13, 16) + "a" + hex.slice(17);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** 稳定的伪设备 ID（UUIDv4 形态），与参考实现 derive_id(uid, "machine") 对齐 */
export function deriveMachineId(seed: string): string {
  return hexToUuidV4(md5Hex(`machine:${seed || "anonymous"}`));
}

export function deriveMachineType(seed: string): string {
  // 与参考实现 derive_id(uid, "machinetype") 一致：先整形 UUIDv4 再去横线
  return hexToUuidV4(md5Hex(`machinetype:${seed || "anonymous"}`)).replace(/-/g, "").slice(0, 18);
}

/** machineToken：sha512 → base64url → 43 位 */
export async function deriveMachineToken(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-512",
    utf8(`machinetoken:${seed || "anonymous"}`) as unknown as BufferSource
  );
  return bytesToBase64Url(new Uint8Array(digest)).slice(0, 43);
}

export function deriveMachineHostname(seed: string): string {
  return "DESKTOP-" + md5Hex(`hostname:${seed || "anonymous"}`).slice(0, 7).toUpperCase();
}

export type CosyIdentity = {
  name: string;
  aid: string;
  uid: string;
  yxUid?: string;
  organizationId?: string;
  organizationName?: string;
  userType?: string;
  securityOauthToken: string;
  refreshToken?: string;
};

export type CosySession = {
  uid: string;
  machineId: string;
  machineToken: string;
  machineType: string;
  machineHostname: string;
  cosyKey: string;
  info: string;
};

/** 创建一次 COSY 会话（每账号缓存，token 变化时重建） */
export async function createCosySession(identity: CosyIdentity, seed: string): Promise<CosySession> {
  const machineId = deriveMachineId(seed);
  const machineToken = await deriveMachineToken(seed);
  const machineType = deriveMachineType(seed);
  const machineHostname = deriveMachineHostname(seed);

  // 16 位十六进制字符串 = 16 字节 ASCII，作 AES-128 密钥与 IV
  const tempKey = [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const cosyKey = bytesToBase64(rsaPkcs1v15Encrypt(utf8(tempKey)));

  const identityJson = sortedJson({
    name: identity.name || "",
    aid: identity.aid || "",
    uid: identity.uid || "",
    yx_uid: identity.yxUid || "",
    organization_id: identity.organizationId || "",
    organization_name: identity.organizationName || "",
    user_type: identity.userType || "",
    security_oauth_token: identity.securityOauthToken || "",
    refresh_token: identity.refreshToken || "",
  });
  const info = bytesToBase64(await aesCbcEncrypt(utf8(identityJson), utf8(tempKey)));

  return { uid: identity.uid, machineId, machineToken, machineType, machineHostname, cosyKey, info };
}

function pathForSignature(rawUrl: string): string {
  const path = new URL(rawUrl).pathname || "/";
  return path.startsWith("/algo") ? path.slice("/algo".length) : path;
}

export type CosyHeaderOptions = {
  model?: string;
  sse?: boolean;
  accept?: string;
};

/**
 * 构造一次请求的完整 COSY 头。
 * 注意：body 必须是**已 qoderEncode 的请求体原文**，签名与实际发送必须逐字节一致。
 */
export function cosyHeaders(
  session: CosySession,
  encodedBody: string,
  rawUrl: string,
  opts: CosyHeaderOptions = {}
): Record<string, string> {
  const payload = bytesToBase64(
    utf8(
      sortedJson({
        cosyVersion: COSY_VERSION,
        ideVersion: "",
        info: session.info,
        requestId: crypto.randomUUID(),
        version: "v1",
      })
    )
  );
  const date = String(Math.floor(Date.now() / 1000));
  const sig = md5Hex(
    [payload, session.cosyKey, date, encodedBody, pathForSignature(rawUrl)].join("\n")
  );
  const headers: Record<string, string> = {
    "cosy-data-policy": "agree",
    "content-type": "application/json",
    "cosy-business-product": "cli",
    "cosy-business-type": "agent",
    "cosy-scene": "assistant",
    "cosy-clienttype": COSY_CLIENT_TYPE,
    "cosy-date": date,
    "cosy-user": session.uid,
    "cosy-key": session.cosyKey,
    accept: opts.accept || "text/event-stream",
    authorization: `Bearer COSY.${payload}.${sig}`,
    "accept-encoding": "identity",
    "cosy-version": COSY_VERSION,
    "cosy-machineid": session.machineId,
    "cosy-machinetoken": session.machineToken,
    "cosy-machinetype": session.machineType,
    "cosy-clientip": COSY_CLIENT_IP,
    "login-version": "v2",
    "user-agent": "undici",
    "cosy-machineos": COSY_MACHINE_OS,
  };
  if (opts.sse !== false) {
    headers["cosy-machinehostname"] = session.machineHostname;
    headers["cache-control"] = "no-cache";
  }
  if (opts.model) {
    headers["x-model-key"] = opts.model;
    headers["x-model-source"] = "system";
  }
  return headers;
}

/** 与参考实现一致的空白 response_meta（assistant/tool 消息必带） */
export function blankResponseMeta(): Record<string, unknown> {
  return {
    id: "",
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };
}
