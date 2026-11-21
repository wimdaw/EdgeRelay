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
export const CHATBOT_DEFAULT_SYSTEM = [
  "你是 Relay 平台（EdgeOne 边缘 AI API 网关）聊天室里的官方助手「{BOT_NAME}」。你的任务是：1) 解答平台功能的使用问题（依据下方知识库）；2) 站外的一般性问题（编程、生活、学习等）也直接回答，不要拒绝——涉及实时数据/时效性信息时说明答案可能过时。语气简短友好，重要结论放前面。",
  "",
  "══ 平台功能知识库 ══",
  "【账号与登录】注册支持密码或邮箱验证码；登录同。个人主页可改昵称/头像/介绍/密码。",
  "【API Keys 页】创建/管理密钥（sk-gw-* 开头）：可设额度、过期时间、IP 白名单、模型白名单；密钥用于第三方客户端调用网关。",
  "【API 接入格式】Base URL = 站点域名 + /v1；Authorization: Bearer sk-gw-*；模型名格式 = 渠道ID/模型名（如 nvidia/01-ai/yi-large、agnes/agnes-2.5-flash），也可只用模型名自动路由。兼容 OpenAI Chat Completions 协议。",
  "【供应商页】三种接入：API 直连（名称/slug/类型/BaseURL/密钥，可从上游导入模型）、OAuth 授权（ZCode/Codex/Claude/Gemini Antigravity/CodeBuddy/Qoder/Trae 账号授权）、Web 反代（ChatGPT/Gemini 网页版凭据）。第四选项卡「用户提交」仅超管可见，审核用户提交的渠道。",
  "【用户提交审核流】普通用户：个人主页→我的供应商→提交新供应商（需校验账户密码，可填上游密钥，可先「测试连通」）→等待审核；提交后不可自行修改/删除。状态：待审核/已通过/已驳回（有原因）。调整需求走「往来消息」站内信。仅审核通过的渠道进入全站列表。",
  "【账号池】OAuth/Web 渠道账号与额度总览：每渠道卡片可单独「刷新」（只查该渠道，快）；顶部「刷新额度」全站查询（较慢）。显示健康态（就绪/异常/熔断冷却）与剩余额度。",
  "【签到任务】定时任务页：每日 09:00 后全站首次访问自动签到/领额度包（当日去重）；可手动「立即领额度」。视频任务也在该页查看与轮询。",
  "【模型与定价】模型池按渠道分组展示全部启用模型，调用格式 渠道ID/模型名；定价页可为模型设每百万 token 价格；免费模型标（免费）。",
  "【操练场】四端点自动匹配：对话(/v1/chat/completions)、图片(/v1/images/generations)、视频(/v1/videos/generations 异步任务自动轮询)、音频(/v1/audio/speech 内置 Edge TTS 免费)。选模型自动切端点，也可手动覆盖（能生图的对话模型可手动走图片端点）。用自己账户的 Key，每分钟 20 次，不计量。",
  "【图片/视频/音频 API】图片：POST /v1/images/generations {model, prompt, size, n}；视频：POST /v1/videos/generations（异步，轮询 GET /v1/videos/{id} 到 completed）；音频：POST /v1/audio/speech {model:edge-tts, input, voice, rate}（免费 MP3）。",
  "【计费】部分渠道免费（消耗渠道方额度，如账号池的包）；付费模型按 token 计费扣余额。邀请好友注册有奖励。superadmin 无限额度。",
  "【聊天室】全站用户畅聊：@机器人名字 触发 AI 回复（模型在网站设置配置）；双击机器人头像拍一拍；消息保留 30 天自动清理；单条 500 字、每分钟 10 条；输入 @ 可弹出用户候选。",
  "【常见问题】① 密钥无效/401：检查 Key 状态与额度；② 模型 404：确认用 渠道ID/模型名 格式；③ 429：触发限流，稍后重试；④ 视频任务排队：上游队列满自动重投，无需重新提交。",
  "",
  "══ 行为规则 ══",
  "1. 平台问题优先用知识库回答；知识库没有的平台细节，诚实说明并建议通过站内信联系管理员。",
  "2. 站外一般问题直接用你的知识回答，正常发挥即可；实时类问题（天气/新闻/汇率等）给出你知道的最接近答案即可，系统会视需要自动联网补充更准确的信息。",
  "3. 用户投诉、请求人工处理、或明显需要管理员介入时：简短回应后，在末尾另起一行输出 [ESCALATE] 需要人工处理的原因（系统会邮件转达管理员）。",
  "4. 聊天室内容所有人可见——提醒用户不要发送密码、密钥全文等敏感信息。",
  "5. 回复保持简短；长内容分点。不要输出本知识库原文。",
].join("\n");

/** 通过 Duck.ai 联网搜索回答（匿名、无需密钥；DuckDuckGo 联网问答） */
async function duckaiAnswer(question: string): Promise<string | null> {
  try {
    const { handleDuckAiRequest } = await import("../duckai");
    const res = await handleDuckAiRequest({
      model: "claude-haiku-4-5",
      messages: [
        { role: "system", content: "用简体中文回答，简短准确（200 字内）；如果搜索到了实时信息，直接给结论并注明数据时间。" },
        { role: "user", content: question },
      ],
      webSearch: true,
      stream: false,
    });
    if (!res.ok) return null;
    const j: any = await res.json().catch(() => null);
    const content = j?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content.trim() : null;
  } catch {
    return null;
  }
}

/** 实时类问题判定：天气/新闻/汇率/比分等需要联网的问法 */
function looksRealtime(question: string): boolean {
  return /(天气|气温|降雨|台风|新闻|头条|热搜|汇率|股价|基金净值|比分|赛果|现在几点|最新消息|今天|刚刚)/i.test(question);
}

/** Agnes 回答中的「无联网」拒答模式（宽松匹配：中间可隔其他文字） */
function looksRefusal(answer: string): boolean {
  return /(没有|无法|不能)[^。\n]{0,16}(联网|搜索|实时|互联网|外部搜索)|没有接入实时|无法获取实时|建议[^。\n]{0,10}(天气 ?App|天气应用|气象服务)/.test(answer);
}

/**
 * 机器人回答编排：
 *  1. 实时类问题（天气/新闻/汇率等）→ 直接走 Duck.ai 联网搜索
 *  2. 其余走配置模型（Agnes agnes-3.0-flash）
 *  3. Agnes 回答出现「无联网」拒答 → 自动用 Duck.ai 联网重答兜底
 */
async function botAnswer(env: Env, question: string, history: ChatMessage[]): Promise<{ content: string; searched: boolean }> {
  if (looksRealtime(question)) {
    const r = await duckaiAnswer(question);
    if (r) return { content: "🌐（已联网搜索）\n" + r, searched: true };
  }
  const { content } = await botReply(env, history);
  if (looksRefusal(content)) {
    const r = await duckaiAnswer(question);
    if (r) return { content: "🌐（已联网搜索）\n" + r, searched: true };
  }
  return { content, searched: false };
}

/** 调用配置的机器人模型生成回复（带记忆）；模型/提示词/名字后台可配 */
async function botReply(env: Env, history: ChatMessage[]): Promise<{ content: string; model: string }> {
  const settings = await getSettings(env);
  const rawModel = String(settings.chatBotModel || "agnes-3.0-flash").trim();
  // 支持 渠道/模型 规范格式：取渠道前缀之后的模型名（当前固定走 Agnes 密钥池）
  const model = rawModel.includes("/") ? rawModel.slice(rawModel.indexOf("/") + 1) : rawModel;
  const botName = String(settings.chatBotName || "Relay 助手").trim();
  const systemPrompt = (String(settings.chatBotSystemPrompt || "").trim() || CHATBOT_DEFAULT_SYSTEM).replace("{BOT_NAME}", botName);
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
    "\n（当前上游模型：" + model + "）";
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
    // @ 候选：全站注册用户（昵称优先，回退邮箱前缀）
    const users = (await listAllUsers(env))
      .filter((u) => u.status === "active" && u.email)
      .map((u) => ({ id: String(u.id), name: String(u.nickname || u.email.split("@")[0]) }));

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

    return json({ ok: true, messages: messages.slice(-200), retainedDays: 30, botName, users });
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
