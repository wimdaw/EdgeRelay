/**
 * 全站聊天室 /api/chatroom
 *
 *  - 所有注册用户可畅聊；消息保留 30 天（读/写时 opportunistic 清理），上限 500 条
 *  - 内置机器人（Agnes / agnes-3.0-flash）：带最近 16 条上下文记忆，主要回答平台使用问题；
 *    机器人判定需要人工介入时输出 [ESCALATE] 行 → 本层剥离标记并通过全站 SMTP 邮件转达管理员
 *  - 机器人回复在发送请求内同步完成（EdgeOne 云函数无 waitUntil/实例不复用）
 *  - 限流：每用户每分钟 10 条（KV 计数）
 */
import { Hono } from "hono";
import type { Env, HandlerCtx } from "../types";
import { requireUser, clientIp } from "../auth";
import { ApiError, ErrorCode, errorResponse } from "../errors";
import { json, getSettings } from "../settings";
import { getBlobStore, listAllUsers } from "../storage/db";
import { getKV } from "../storage/blob-store";
import { uuid, decryptSecret } from "../crypto";
import { sendMail } from "../smtp";

export const chatroomRouter = new Hono<{ Bindings: Env }>();

const CHAT_KEY = "chatroom:messages";
const MAX_MESSAGES = 500;
const RETAIN_SECONDS = 30 * 86400; // 30 天
const CONTEXT_MESSAGES = 16; // 机器人记忆条数
const RATE_LIMIT_PER_MIN = 10;
const CHARS_LIMIT = 500;

export type ChatMessage = {
  id: string;
  userId: string;
  email: string;
  nickname?: string;
  role: "user" | "bot" | "system";
  content: string;
  createdAt: number;
};

/** 读取并 opportunistic 清理：超过 30 天的消息丢弃，总量超 500 时裁剪到最新 500 条 */
async function loadChatMessages(env: Env): Promise<ChatMessage[]> {
  const store = getBlobStore(env);
  const list = ((await store.get(CHAT_KEY, { type: "json", consistency: "strong" })) || []) as ChatMessage[];
  const cutoff = Math.floor(Date.now() / 1000) - RETAIN_SECONDS;
  let trimmed = list.filter((m) => (m.createdAt || 0) >= cutoff);
  let changed = trimmed.length !== list.length;
  if (trimmed.length > MAX_MESSAGES) {
    trimmed = trimmed.slice(trimmed.length - MAX_MESSAGES);
    changed = true;
  }
  if (changed) await store.setJSON(CHAT_KEY, trimmed);
  return trimmed;
}

async function appendChatMessage(env: Env, msg: ChatMessage): Promise<ChatMessage[]> {
  const list = await loadChatMessages(env);
  list.push(msg);
  const trimmed = list.length > MAX_MESSAGES ? list.slice(list.length - MAX_MESSAGES) : list;
  const store = getBlobStore(env);
  await store.setJSON(CHAT_KEY, trimmed);
  return trimmed;
}

/** 每用户每分钟限流（KV 计数） */
async function checkRate(env: Env, userId: string): Promise<boolean> {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `chatroom:rl:${userId}:${minute}`;
  try {
    const kv = getKV(env);
    const n = Number((await kv.get(key)) || 0) + 1;
    await kv.put(key, String(n), { expirationTtl: 120 });
    return n <= RATE_LIMIT_PER_MIN;
  } catch {
    return true;
  }
}

/** 超级管理员邮箱列表（机器人邮件升级的收件人） */
async function adminEmails(env: Env): Promise<string[]> {
  try {
    const users = await listAllUsers(env);
    return users.filter((u) => u.role === "superadmin" && u.email).map((u) => String(u.email));
  } catch {
    return [];
  }
}

/** 组装 SMTP 配置（复用全站发件） */
async function smtpReady(env: Env): Promise<{ to: string[]; send: (subject: string, text: string) => Promise<void> } | null> {
  const settings = await getSettings(env);
  if (!(settings.smtpEnabled && settings.smtpHost && settings.smtpPassEnc)) return null;
  const password = await decryptSecret(env, settings.smtpPassEnc);
  const cfg = {
    host: settings.smtpHost,
    port: settings.smtpPort || 465,
    username: settings.smtpUsername || settings.smtpFrom || "",
    password,
    from: settings.smtpFrom || settings.smtpUsername || "",
    fromName: "Relay AI",
  };
  const to = await adminEmails(env);
  if (!to.length) return null;
  return {
    to,
    send: async (subject, text) => {
      for (const addr of to) {
        await sendMail(cfg, { to: addr, subject, text, fromName: "Relay AI" }).catch(() => {});
      }
    },
  };
}

/** 机器人被 @ 提及的判定：内置别名 + 后台自定义名字（转义后匹配），大小写不敏感 */
function isBotMentioned(content: string, botName: string): boolean {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@(relay助手|机器人|小r|bot|assistant|${escaped})`, "i").test(content);
}

/** 聊天室机器人默认系统提示词（后台「聊天室机器人系统提示词」可覆盖） */
export const CHATBOT_DEFAULT_SYSTEM =
  "你是 Relay 平台（EdgeOne 边缘 AI API 网关）聊天室里的官方助手「Relay 助手」，用简体中文、简短友好地回答平台使用问题：" +
  "如何注册登录、创建 API Key、查看模型与定价、在操练场试用模型、账号池/渠道的含义、额度与计费方式等。" +
  "遇到你无法确定的问题、用户投诉、请求人工处理或要求联系管理员时，先正常简短回应，然后在回复末尾另起一行输出：[ESCALATE] 需要人工处理的原因。" +
  "不要编造平台不存在的功能。聊天室内容所有人可见，不要让用户发送密码等敏感信息。" +
  "当消息 @ 的是其他用户而非你时，只在能补充平台使用相关帮助时简短插话，不要代替该用户对话或纠正其称呼。";

/** 调用配置的机器人模型生成回复（带记忆）；模型/提示词/名字后台可配 */
async function botReply(env: Env, history: ChatMessage[]): Promise<{ content: string; model: string }> {
  const settings = await getSettings(env);
  const rawModel = String(settings.chatBotModel || "agnes-3.0-flash").trim();
  // 支持 渠道/模型 规范格式：取渠道前缀之后的模型名（当前固定走 Agnes 密钥池）
  const model = rawModel.includes("/") ? rawModel.slice(rawModel.indexOf("/") + 1) : rawModel;
  const botName = String(settings.chatBotName || "Relay 助手").trim();
  const systemPrompt = String(settings.chatBotSystemPrompt || "").trim() || CHATBOT_DEFAULT_SYSTEM.replace("「Relay 助手」", `「${botName}」`);
  const { getProviders, getProviderKeys, getProviderKeysAll } = await import("../storage/db");
  const providers = await getProviders(env);
  const agnes = providers.find((p) => p.slug === "agnes" && p.status === "active");
  if (!agnes) throw new Error("Agnes 渠道未配置");
  const keys = await (await import("../storage/db")).getProviderKeysAll(env, agnes.id).catch(() => []);
  const activeKey = keys.find((k) => k.status === "active") || keys[0];
  if (!activeKey) throw new Error("Agnes 渠道无可用密钥");
  const key = await decryptSecret(env, activeKey.encryptedKey);

  const system =
    systemPrompt +
    "\n（你当前实际使用的上游模型：" + model + "。回答与平台功能相关的问题；与模型选择无关的请求正常应答。）";
  const context = history.slice(-CONTEXT_MESSAGES).map((m) => ({
    role: m.role === "bot" ? "assistant" : m.role === "system" ? "assistant" : "user",
    content: m.role === "system" ? `[系统提示] ${m.content}` : m.content,
  }));
  // 末尾若不是用户消息，补一个空 user 防止上游报错
  if (!context.length || context[context.length - 1].role !== "user") context.push({ role: "user", content: "（请继续）" });

  const res = await fetch(`${agnes.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, ...context],
      max_tokens: 1024,
      temperature: 0.7,
      stream: false,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Agnes 上游 HTTP ${res.status}: ${text.slice(0, 160)}`);
  const j = JSON.parse(text);
  const content = j?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("Agnes 上游未返回内容");
  return { content: content.trim(), model };
}

/** 拍一拍：系统消息 + 机器人俏皮回应（微信式轻互动） */
chatroomRouter.post("/pat", async (c) => {
  const env = c.env as Env;
  const hCtx: HandlerCtx = { env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    if (!(await checkRate(env, user.id))) {
      throw new ApiError(429, ErrorCode.RATE_LIMITED, "操作太频繁，稍后再试");
    }
    const now = Math.floor(Date.now() / 1000);
    const list = await appendChatMessage(env, {
      id: uuid(),
      userId: user.id,
      email: user.email,
      role: "system",
      content: `"${user.email.split("@")[0]}" 拍了拍「${(await getSettings(env)).chatBotName || "Relay 助手"}」`,
      createdAt: now,
    });
    // 机器人简短回应（带上下文）
    try {
      const history: ChatMessage[] = [...list, { id: uuid(), userId: user.id, email: user.email, role: "user", content: "[拍一拍] 用户刚刚拍了拍你，请用不超过 20 字简短俏皮地回应。", createdAt: now }];
      const { content: reply } = await botReply(env, history);
      await appendChatMessage(env, {
        id: uuid(), userId: "bot", email: "bot", nickname: String((await getSettings(env)).chatBotName || "Relay 助手"), role: "bot",
        content: reply.slice(0, 60), createdAt: Math.floor(Date.now() / 1000),
      });
    } catch {}
    const finalList = await loadChatMessages(env);
    return json({ ok: true, messages: finalList.slice(-200), botName: String((await getSettings(env)).chatBotName || "Relay 助手") });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 拉取消息列表；最后一条是 @ 机器人的用户消息时，借本次轮询生成机器人回复（伪异步，KV 锁防并发重复生成） */
chatroomRouter.get("/messages", async (c) => {
  const env = c.env as Env;
  const hCtx: HandlerCtx = { env, req: c.req as any };
  try {
    await requireUser(hCtx);
    let messages = await loadChatMessages(env);
    const settings = await getSettings(env);
    const botName = String(settings.chatBotName || "Relay 助手").trim();

    const last = messages[messages.length - 1];
    if (last && last.role === "user" && isBotMentioned(last.content, botName)) {
      const kv = getKV(env);
      const lockKey = "chatroom:botlock";
      let mine = false;
      try {
        mine = (await kv.get(lockKey)) !== "1";
        if (mine) await kv.put(lockKey, "1", { expirationTtl: 30 });
      } catch {}
      if (mine) {
        try {
          const { content: reply } = await botReply(env, messages);
          let botContent = reply;
          // 升级邮件：机器人输出 [ESCALATE] 原因 → 剥离标记 + SMTP 邮件给超级管理员
          const m = botContent.match(/\[ESCALATE\]\s*(.+)/i);
          if (m) {
            botContent = botContent.replace(/\[ESCALATE\][^\n]*\n?/i, "").trim();
            const mailer = await smtpReady(env);
            if (mailer) {
              // 同一用户 10 分钟内最多升级一封，防刷
              const guardKey = `chatroom:esc:${last.userId}:${Math.floor(Date.now() / 600_000)}`;
              let recent = false;
              try {
                recent = (await kv.get(guardKey)) === "1";
                if (!recent) await kv.put(guardKey, "1", { expirationTtl: 600 });
              } catch {}
              if (recent) {
                botContent += "\n（你的问题已记录，管理员会尽快回复，请勿短时间重复催促。）";
              } else {
                await mailer.send(
                  `[聊天室转达] ${last.email} 需要人工处理`,
                  `聊天室用户 ${last.email} 的问题需要人工处理：\n\n「${last.content}」\n\n升级原因：${(m[1] || "").trim()}\n\n时间：${new Date(last.createdAt * 1000).toLocaleString("zh-CN")}`,
                );
                messages = await appendChatMessage(env, {
                  id: uuid(), userId: "system", email: "system", role: "system",
                  content: "已将你的问题通过邮件转达管理员，请留意后续回复。",
                  createdAt: Math.floor(Date.now() / 1000),
                });
              }
            }
          }
          messages = await appendChatMessage(env, {
            id: uuid(), userId: "bot", email: "bot", nickname: botName, role: "bot",
            content: botContent, createdAt: Math.floor(Date.now() / 1000),
          });
        } catch (e: any) {
          messages = await appendChatMessage(env, {
            id: uuid(), userId: "system", email: "system", role: "system",
            content: `机器人暂时不可用：${(e?.message || "未知错误").slice(0, 120)}`,
            createdAt: Math.floor(Date.now() / 1000),
          });
        } finally {
          await kv.delete(lockKey).catch(() => {});
        }
      }
    }

    return json({ ok: true, messages: messages.slice(-200), retainedDays: 30, botName });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 发送消息：仅落库即回（秒发）。@ 机器人时由下一次轮询生成回复（见 GET /messages） */
chatroomRouter.post("/messages", async (c) => {
  const env = c.env as Env;
  const hCtx: HandlerCtx = { env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const body = (await c.req.json().catch(() => ({}))) as { content?: string };
    const content = String(body.content || "").trim();
    if (!content) throw new ApiError(400, ErrorCode.BAD_REQUEST, "消息不能为空");
    if (content.length > CHARS_LIMIT) throw new ApiError(400, ErrorCode.BAD_REQUEST, `单条消息不超过 ${CHARS_LIMIT} 字`);

    if (!(await checkRate(env, user.id))) {
      throw new ApiError(429, ErrorCode.RATE_LIMITED, `聊天室每分钟最多 ${RATE_LIMIT_PER_MIN} 条，稍后再试`);
    }

    const now = Math.floor(Date.now() / 1000);
    const userMsg: ChatMessage = {
      id: uuid(),
      userId: user.id,
      email: user.email,
      role: "user",
      content,
      createdAt: now,
    };
    const list = await appendChatMessage(env, userMsg);
    const settings = await getSettings(env);
    return json({ ok: true, messages: list.slice(-200), botName: String(settings.chatBotName || "Relay 助手") });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 拍一拍：系统消息 + 机器人俏皮回应（微信式轻互动） */
chatroomRouter.post("/pat", async (c) => {
  const env = c.env as Env;
  const hCtx: HandlerCtx = { env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    if (!(await checkRate(env, user.id))) {
      throw new ApiError(429, ErrorCode.RATE_LIMITED, "操作太频繁，稍后再试");
    }
    const now = Math.floor(Date.now() / 1000);
    const list = await appendChatMessage(env, {
      id: uuid(),
      userId: user.id,
      email: user.email,
      role: "system",
      content: `"${user.email.split("@")[0]}" 拍了拍「${(await getSettings(env)).chatBotName || "Relay 助手"}」`,
      createdAt: now,
    });
    // 机器人简短回应（带上下文）
    try {
      const history: ChatMessage[] = [...list, { id: uuid(), userId: user.id, email: user.email, role: "user", content: "[拍一拍] 用户刚刚拍了拍你，请用不超过 20 字简短俏皮地回应。", createdAt: now }];
      const { content: reply } = await botReply(env, history);
      await appendChatMessage(env, {
        id: uuid(), userId: "bot", email: "bot", nickname: String((await getSettings(env)).chatBotName || "Relay 助手"), role: "bot",
        content: reply.slice(0, 60), createdAt: Math.floor(Date.now() / 1000),
      });
    } catch {}
    const finalList = await loadChatMessages(env);
    return json({ ok: true, messages: finalList.slice(-200), botName: String((await getSettings(env)).chatBotName || "Relay 助手") });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 拉取消息列表；最后一条是 @ 机器人的用户消息时，借本次轮询生成机器人回复（伪异步，KV 锁防并发重复生成） */
chatroomRouter.get("/messages", async (c) => {
  const env = c.env as Env;
  const hCtx: HandlerCtx = { env, req: c.req as any };
  try {
    await requireUser(hCtx);
    let messages = await loadChatMessages(env);
    const settings = await getSettings(env);
    const botName = String(settings.chatBotName || "Relay 助手").trim();

    const last = messages[messages.length - 1];
    if (last && last.role === "user" && isBotMentioned(last.content, botName)) {
      const kv = getKV(env);
      const lockKey = "chatroom:botlock";
      let mine = false;
      try {
        mine = (await kv.get(lockKey)) !== "1";
        if (mine) await kv.put(lockKey, "1", { expirationTtl: 30 });
      } catch {}
      if (mine) {
        try {
          const { content: reply } = await botReply(env, messages);
          let botContent = reply;
          // 升级邮件：机器人输出 [ESCALATE] 原因 → 剥离标记 + SMTP 邮件给超级管理员
          const m = botContent.match(/\[ESCALATE\]\s*(.+)/i);
          if (m) {
            botContent = botContent.replace(/\[ESCALATE\][^\n]*\n?/i, "").trim();
            const mailer = await smtpReady(env);
            if (mailer) {
              // 同一用户 10 分钟内最多升级一封，防刷
              const guardKey = `chatroom:esc:${last.userId}:${Math.floor(Date.now() / 600_000)}`;
              let recent = false;
              try {
                recent = (await kv.get(guardKey)) === "1";
                if (!recent) await kv.put(guardKey, "1", { expirationTtl: 600 });
              } catch {}
              if (recent) {
                botContent += "\n（你的问题已记录，管理员会尽快回复，请勿短时间重复催促。）";
              } else {
                await mailer.send(
                  `[聊天室转达] ${last.email} 需要人工处理`,
                  `聊天室用户 ${last.email} 的问题需要人工处理：\n\n「${last.content}」\n\n升级原因：${(m[1] || "").trim()}\n\n时间：${new Date(last.createdAt * 1000).toLocaleString("zh-CN")}`,
                );
                messages = await appendChatMessage(env, {
                  id: uuid(), userId: "system", email: "system", role: "system",
                  content: "已将你的问题通过邮件转达管理员，请留意后续回复。",
                  createdAt: Math.floor(Date.now() / 1000),
                });
              }
            }
          }
          messages = await appendChatMessage(env, {
            id: uuid(), userId: "bot", email: "bot", nickname: botName, role: "bot",
            content: botContent, createdAt: Math.floor(Date.now() / 1000),
          });
        } catch (e: any) {
          messages = await appendChatMessage(env, {
            id: uuid(), userId: "system", email: "system", role: "system",
            content: `机器人暂时不可用：${(e?.message || "未知错误").slice(0, 120)}`,
            createdAt: Math.floor(Date.now() / 1000),
          });
        } finally {
          await kv.delete(lockKey).catch(() => {});
        }
      }
    }

    return json({ ok: true, messages: messages.slice(-200), retainedDays: 30, botName });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});

/** 发送消息：落库用户消息 → 同步生成机器人回复 → 返回最新列表 */
chatroomRouter.post("/messages", async (c) => {
  const env = c.env as Env;
  const hCtx: HandlerCtx = { env, req: c.req as any };
  try {
    const user = await requireUser(hCtx);
    const body = (await c.req.json().catch(() => ({}))) as { content?: string };
    const content = String(body.content || "").trim();
    if (!content) throw new ApiError(400, ErrorCode.BAD_REQUEST, "消息不能为空");
    if (content.length > CHARS_LIMIT) throw new ApiError(400, ErrorCode.BAD_REQUEST, `单条消息不超过 ${CHARS_LIMIT} 字`);

    if (!(await checkRate(env, user.id))) {
      throw new ApiError(429, ErrorCode.RATE_LIMITED, `聊天室每分钟最多 ${RATE_LIMIT_PER_MIN} 条，稍后再试`);
    }

    const now = Math.floor(Date.now() / 1000);
    const userMsg: ChatMessage = {
      id: uuid(),
      userId: user.id,
      email: user.email,
      role: "user",
      content,
      createdAt: now,
    };
    let list = await appendChatMessage(env, userMsg);

    // 触发条件：@ 机器人名字，或 @ 任意房间用户（@某人提问，机器人跟进回答）
    const botName = String((await getSettings(env)).chatBotName || "Relay 助手").trim();
    const mentionsUser = ((): boolean => {
      const lower = content.toLowerCase();
      for (const m of list) {
        if (m.role !== "user" || !m.userId) continue;
        const name = (m.nickname || m.email.split("@")[0] || "").toLowerCase();
        if (name && lower.includes("@" + name)) return true;
      }
      return false;
    })();
    if (!isBotMentioned(content, botName) && !mentionsUser) {
      return json({ ok: true, messages: list.slice(-200), botName });
    }

    // 机器人回复（同步生成；失败则落一条系统提示，不影响用户消息）
    try {
      const { content: reply } = await botReply(env, list);
      let botContent = reply;
      // 升级邮件：机器人输出 [ESCALATE] 原因 → 剥离标记 + SMTP 邮件给超级管理员
      const m = botContent.match(/\[ESCALATE\]\s*(.+)/i);
      if (m) {
        botContent = botContent.replace(/\[ESCALATE\][^\n]*\n?/i, "").trim();
        const mailer = await smtpReady(env);
        if (mailer) {
          // 同一用户 10 分钟内最多升级一封，防刷
          const guardKey = `chatroom:esc:${user.id}:${Math.floor(Date.now() / 600_000)}`;
          let recent = false;
          try {
            const kv = getKV(env);
            recent = (await kv.get(guardKey)) === "1";
            if (!recent) await kv.put(guardKey, "1", { expirationTtl: 600 });
          } catch {}
          if (recent) {
            botContent += "\n（你的问题已记录，管理员会尽快回复，请勿短时间重复催促。）";
          } else {
            await mailer.send(
              `[聊天室转达] ${user.email} 需要人工处理`,
              `聊天室用户 ${user.email} 的问题需要人工处理：\n\n「${content}」\n\n升级原因：${(m[1] || "").trim()}\n\n时间：${new Date(now * 1000).toLocaleString("zh-CN")}`,
            );
            list = await appendChatMessage(env, {
              id: uuid(),
              userId: "system",
              email: "system",
              role: "system",
              content: "已将你的问题通过邮件转达管理员，请留意后续回复。",
              createdAt: Math.floor(Date.now() / 1000),
            });
          }
        }
      }
      list = await appendChatMessage(env, {
        id: uuid(),
        userId: "bot",
        email: "bot",
        nickname: botName,
        role: "bot",
        content: botContent,
        createdAt: Math.floor(Date.now() / 1000),
      });
    } catch (e: any) {
      list = await appendChatMessage(env, {
        id: uuid(),
        userId: "system",
        email: "system",
        role: "system",
        content: `机器人暂时不可用：${(e?.message || "未知错误").slice(0, 120)}`,
        createdAt: Math.floor(Date.now() / 1000),
      });
    }

    return json({ ok: true, messages: list.slice(-200) });
  } catch (err) {
    return errorResponse(hCtx, err);
  }
});
