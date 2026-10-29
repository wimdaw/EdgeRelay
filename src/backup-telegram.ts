/**
 * Telegram 机器人备份
 *
 * 配置保存在 Blob 的 backup:telegram（不在全站备份/恢复范围内），
 * Bot Token 使用平台 ENCRYPTION_KEY 做 AES-256-GCM 加密后落盘。
 */
import type { Env } from "./types";
import { getBlobStore } from "./storage/blob-store";
import { encryptSecret, decryptSecret } from "./crypto";
import { ApiError, ErrorCode } from "./errors";
import { buildBackup } from "./backup";

const CONFIG_KEY = "backup:telegram";

export type TelegramStatus = {
  configured: boolean;
  chatId: string;
  botTokenMasked: string;
};

type StoredTelegramConfig = {
  chatId: string;
  botTokenEnc: string;
  updatedAt: number;
};

async function readConfig(env: Env): Promise<StoredTelegramConfig | null> {
  const raw = await getBlobStore(env).get(CONFIG_KEY, { type: "json", consistency: "strong" });
  if (!raw || typeof raw.chatId !== "string" || typeof raw.botTokenEnc !== "string") return null;
  return raw as StoredTelegramConfig;
}

function maskToken(token: string): string {
  if (token.length <= 12) return "••••••";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export async function getTelegramStatus(env: Env): Promise<TelegramStatus> {
  const config = await readConfig(env);
  if (!config) return { configured: false, chatId: "", botTokenMasked: "" };

  let botTokenMasked = "••••••";
  try {
    botTokenMasked = maskToken(await decryptSecret(env, config.botTokenEnc));
  } catch {
    // 加密密钥变更等情况下仍允许展示"已配置"，用户重新保存 Token 即可恢复
  }
  return { configured: true, chatId: config.chatId, botTokenMasked };
}

export async function saveTelegramConfig(
  env: Env,
  input: { botToken?: string; chatId?: string }
): Promise<TelegramStatus> {
  const chatId = (input.chatId ?? "").trim();
  const botToken = (input.botToken ?? "").trim();
  if (!chatId) throw new ApiError(400, ErrorCode.BAD_REQUEST, "请填写 Chat ID");

  const existing = await readConfig(env);
  if (!botToken && !existing) throw new ApiError(400, ErrorCode.BAD_REQUEST, "请填写 Bot Token");
  if (botToken && !botToken.includes(":")) {
    throw new ApiError(400, ErrorCode.BAD_REQUEST, "Bot Token 格式不正确，应形如 123456789:AA...");
  }

  const botTokenEnc = botToken ? await encryptSecret(env, botToken) : existing!.botTokenEnc;
  await getBlobStore(env).setJSON(CONFIG_KEY, {
    chatId,
    botTokenEnc,
    updatedAt: Math.floor(Date.now() / 1000),
  } satisfies StoredTelegramConfig);

  return await getTelegramStatus(env);
}

export async function clearTelegramConfig(env: Env): Promise<void> {
  await getBlobStore(env).delete(CONFIG_KEY);
}

async function resolveConfig(
  env: Env,
  override?: { botToken?: string; chatId?: string }
): Promise<{ botToken: string; chatId: string }> {
  const saved = await readConfig(env);

  let savedToken = "";
  if (saved) {
    try {
      savedToken = await decryptSecret(env, saved.botTokenEnc);
    } catch {
      throw new ApiError(500, ErrorCode.INTERNAL, "Bot Token 解密失败，请重新保存 Telegram 配置");
    }
  }

  const botToken = (override?.botToken ?? "").trim() || savedToken;
  const chatId = (override?.chatId ?? "").trim() || saved?.chatId || "";
  if (!botToken) throw new ApiError(400, ErrorCode.BAD_REQUEST, "未配置 Bot Token，请先保存配置");
  if (!chatId) throw new ApiError(400, ErrorCode.BAD_REQUEST, "未配置 Chat ID，请先保存配置");
  return { botToken, chatId };
}

type TelegramApiResponse = {
  ok?: boolean;
  description?: string;
  result?: unknown;
};

async function callTelegram(
  token: string,
  method: string,
  init: { body: BodyInit; headers?: Record<string, string> }
): Promise<TelegramApiResponse> {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: init.headers,
      body: init.body,
    });
  } catch (err) {
    throw new ApiError(
      502,
      ErrorCode.UPSTREAM_ERROR,
      `无法连接 Telegram：${err instanceof Error ? err.message : String(err)}`
    );
  }

  let data: TelegramApiResponse | null = null;
  try {
    data = (await response.json()) as TelegramApiResponse;
  } catch {
    // Telegram 偶尔返回非 JSON（网关错误页），下面统一按 HTTP 状态处理
  }

  if (!response.ok || !data?.ok) {
    const detail = data?.description || `HTTP ${response.status}`;
    throw new ApiError(400, ErrorCode.BAD_REQUEST, `Telegram 返回错误：${detail}`);
  }
  return data;
}

export async function sendTelegramTest(
  env: Env,
  override?: { botToken?: string; chatId?: string }
): Promise<string> {
  const config = await resolveConfig(env, override);
  await callTelegram(config.botToken, "sendMessage", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: config.chatId,
      text: `Relay 数据备份测试\n时间：${new Date().toISOString()}\n如果你收到这条消息，说明 Telegram 机器人配置成功 ✅`,
    }),
  });
  return "测试消息已发送，请到 Telegram 查看";
}

export async function pushBackupToTelegram(env: Env): Promise<{ message: string; entries: number }> {
  const config = await resolveConfig(env);
  const data = await buildBackup(env);
  const json = JSON.stringify(data);
  const size = new TextEncoder().encode(json).byteLength;
  const filename = `edgerelay-backup-${data.exportedAt.replace(/[:.]/g, "-")}.json`;

  const form = new FormData();
  form.append("chat_id", config.chatId);
  form.append(
    "caption",
    `Relay 全站备份\n时间：${data.exportedAt}\n数据条目：${data.entries.length}\n大小：${(size / 1024).toFixed(1)} KB`
  );
  form.append("document", new Blob([json], { type: "application/json" }), filename);

  await callTelegram(config.botToken, "sendDocument", { body: form });
  return { message: `备份已推送到 Telegram（${data.entries.length} 项数据）`, entries: data.entries.length };
}
