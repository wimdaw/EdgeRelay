import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, MessagesSquare, Send, User } from "lucide-react";
import { api, type Me } from "../lib/api";
import { Button, Card, useToast } from "../components/ui";
import { cn } from "../lib/utils";

type ChatroomUser = { id: string; name: string };
type ChatMessage = {
  id: string;
  userId: string;
  email: string;
  nickname?: string;
  role: "user" | "bot" | "system";
  content: string;
  createdAt: number;
};

const POLL_MS = 5000;
const CHARS_LIMIT = 500;

const fmtTime = (ts?: number) => (ts ? new Date(ts * 1000).toLocaleTimeString("zh-CN", { hour12: false }) : "");

/** 全站聊天室：所有注册用户可畅聊；消息保留 30 天；内置 Relay 助手（Agnes agnes-3.0-flash）答疑与邮件升级 */
export default function ChatRoom({ me }: { me: Me }) {
  const [msgs, setMsgs] = useState<ChatMessage[] | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  /** 长按/右键菜单：定位到机器人消息 */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);
  const lastTapRef = useRef<{ time: number } | null>(null);
  const patBusyRef = useRef(false);
  const [mentionIdx, setMentionIdx] = useState(0);
  /** 打字机显现（纯时间驱动）：revealStart[id] = 显现开始时刻，进度 = 时间差的纯函数，无定时器竞争 */
  const revealStartRef = useRef<Record<string, number>>({});
  const [, setRevealTick] = useState(0);
  /** 页面装载时刻：只有装载之后新到达的消息才做打字机显现（历史消息直接完整显示） */
  const loadedAtRef = useRef(Date.now());
  /** @ 提及候选：输入 @ 后弹出房间内所有用户 */
  const [mention, setMention] = useState<{ query: string } | null>(null);
  /** 机器人名字：后台「网站设置 → 站点信息 → 聊天室机器人名字」可配 */
  const [botName, setBotName] = useState("Relay 助手");
  const [roomUsers, setRoomUsers] = useState<ChatroomUser[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const toast = useToast();

  const TYPING_REVEAL_MS = 1600;

  /** 消息入状态的统一入口：新到达的 bot 消息启动打字机显现（记开始时刻），历史消息直接完整 */
  const applyMsgs = (list: ChatMessage[]) => {
    for (const m of list) {
      if (m.role !== "bot") continue;
      // 只对「装载之后新到达」的 bot 消息做打字机显现；历史消息（created 早于装载前 5 秒）直接完整
      if (m.createdAt * 1000 < loadedAtRef.current - 5000) continue;
      if (revealStartRef.current[m.id] !== undefined) continue;
      revealStartRef.current[m.id] = Date.now();
    }
    setMsgs(list);
    setRevealTick((t) => t + 1);
  };

  const poll = async () => {
    try {
      const r = await api<{ messages: ChatMessage[]; botName?: string }>("/api/chatroom/messages");
      // 首次装载是历史消息：直接完整显示，不做打字机显现
      applyMsgs(r.messages || []);
      if (r.botName) setBotName(r.botName);
    } catch {
      // 轮询失败静默，下个周期重试
    }
  };

  useEffect(() => {
    void poll();
    const tick = window.setInterval(() => { if (!document.hidden) void poll(); }, POLL_MS);
    const onVisible = () => { if (!document.hidden) void poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [msgs]);

  // 打字机显现的重绘节拍：仅在有显现进行中时触发（进度本身是时间的纯函数）
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (Object.keys(revealStartRef.current).length) setRevealTick((t) => t + 1);
    }, 50);
    return () => window.clearInterval(timer);
  }, []);

  /** 拍一拍：后端落系统消息 + 机器人俏皮回应 */
  const pat = async () => {
    if (patBusyRef.current) return;
    patBusyRef.current = true;
    setMenu(null);
    try {
      const r = await api<{ messages: ChatMessage[]; botName?: string; users?: ChatroomUser[] }>("/api/chatroom/pat", "POST", {});
      applyMsgs(r.messages || []);
      if (r.botName) setBotName(r.botName);
      if (r.users) setRoomUsers(r.users);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      patBusyRef.current = false;
    }
  };

  /** 把 @ 助手 插进输入框 */
  const mentionBot = () => {
    setMenu(null);
    setInput((v) => (v.includes(`@${botName}`) ? v : `${v ? v + " " : ""}@${botName} `));
  };

  /** 长按计时（移动端）：480ms 触发菜单；期间松手取消 */
  const startLongPress = (x: number, y: number) => {
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
    longPressFired.current = false;
    longPressTimer.current = window.setTimeout(() => { longPressFired.current = true; setMenu({ x, y }); }, 480);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) { window.clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };
  /** 触摸双击（双触）拍一拍：两次点击间隔 <320ms；长按已触发菜单则跳过 */
  const handleTouchTap = () => {
    const now = Date.now();
    const last = lastTapRef.current;
    if (longPressFired.current) { lastTapRef.current = null; return; }
    if (last && now - last.time < 320) { lastTapRef.current = null; void pat(); }
    else lastTapRef.current = { time: now };
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    try {
      // 发送响应即含最新消息（含机器人回复），随后轮询兜底
      const r = await api<{ messages: ChatMessage[]; botName?: string; users?: ChatroomUser[] }>("/api/chatroom/messages", "POST", { content: text });
      applyMsgs(r.messages || []);
      if (r.botName) setBotName(r.botName);
      if (r.users) setRoomUsers(r.users);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  const displayEmail = (m: ChatMessage) => (m.role === "bot" ? m.nickname || botName : m.role === "system" ? "系统" : m.nickname || m.email);
  const isMine = (m: ChatMessage) => m.role === "user" && m.userId === me.user.id;

  /** 机器人回复等待中：最后一条是 @ 机器人的用户消息，但 bot 回复尚未经轮询落库 */
  const botTyping = !!msgs && msgs.length > 0 && (() => {
    const last = msgs[msgs.length - 1];
    if (last.role !== "user") return false;
    return new RegExp(`@(relay助手|机器人|小r|bot|assistant|${botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i").test(last.content);
  })();

  /** @ 提及候选：全站注册用户 + 机器人置顶，自己排最后 */
  const participants = useMemo(() => {
    const meEntry: ChatroomUser = { id: me.user.id, name: me.nickname || me.user.email.split("@")[0] };
    const others = roomUsers.filter((u) => u.id !== me.user.id);
    const bot: ChatroomUser = { id: "bot", name: botName };
    const list = [bot, ...others, ...(meEntry.name ? [meEntry] : [])];
    const q = (mention?.query || "").toLowerCase();
    const hit = q ? list.filter((x) => x.name.toLowerCase().includes(q)) : list;
    if (q) {
      const bi = hit.findIndex((x) => x.id === "bot");
      if (bi > 0) { const [b] = hit.splice(bi, 1); hit.unshift(b); }
    }
    return hit;
  }, [roomUsers, botName, mention, me]);

  /** 输入检测：末尾是 @xxx（@ 后无空格）时打开提及候选 */
  const onInputChange = (v: string) => {
    setInput(v);
    const at = v.lastIndexOf("@");
    setMention(at >= 0 && !v.slice(at).includes(" ") ? { query: v.slice(at + 1) } : null);
    setMentionIdx(0);
  };

  /** 点选候选：替换末尾 @片段 为 @名字  */
  const pickMention = (name: string) => {
    const at = input.lastIndexOf("@");
    setInput(at >= 0 ? input.slice(0, at) + `@${name} ` : input + `@${name} `);
    setMention(null);
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
            <MessagesSquare size={18} />
          </div>
          <div>
            <h1 className="text-base font-bold text-ink">聊天室</h1>
            <p className="mt-0.5 text-xs text-muted">
              全站用户畅聊区，所有人可见；消息保留 30 天自动清理。「Relay 助手」机器人在线答疑，需要人工处理的问题可通过它邮件转达管理员。
            </p>
          </div>
        </div>
      </Card>

      <Card className="flex h-[calc(100vh-320px)] min-h-[460px] flex-col overflow-hidden">
        <div ref={listRef} className="flex-1 space-y-2.5 overflow-y-auto p-4">
          {msgs === null ? (
            <div className="flex h-full items-center justify-center text-xs text-muted">加载中…</div>
          ) : msgs.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <MessagesSquare size={30} className="text-muted" />
              <p className="text-[13px] text-muted">还没有消息，来说第一句吧</p>
            </div>
          ) : (
            msgs.map((m) =>
              m.role === "system" ? (
                <div key={m.id} className="text-center">
                  <span className="rounded bg-surface2 px-2 py-0.5 text-[10px] text-muted">{m.content}</span>
                </div>
              ) : (
                <div className={cn("flex gap-2", isMine(m) ? "flex-row-reverse" : "flex-row")}>
                  <div
                    className={cn(
                      "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                      m.role === "bot" ? "bg-emerald-500/15 text-emerald-500" : isMine(m) ? "bg-brand/15 text-brand" : "bg-surface2 text-muted",
                      m.role === "bot" && "cursor-context-menu select-none"
                    )}
                    onContextMenu={m.role === "bot" ? (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); } : undefined}
                    onTouchStart={m.role === "bot" ? (e) => { const t = e.touches[0]; if (t) startLongPress(t.clientX, t.clientY); } : undefined}
                    onTouchEnd={m.role === "bot" ? () => { cancelLongPress(); handleTouchTap(); } : undefined}
                    onTouchMove={m.role === "bot" ? () => cancelLongPress() : undefined}
                    title={m.role === "bot" ? "右键 / 长按：菜单（@ 助手、拍一拍）；双触：拍一拍" : undefined}
                  >
                    {m.role === "bot" ? <Bot size={14} /> : isMine(m) ? <User size={14} /> : (m.email[0] || "?").toUpperCase()}
                  </div>
                  <div
                    className={cn("max-w-[75%] space-y-0.5", isMine(m) && "flex flex-col items-end")}
                  >
                    <div className="flex items-center gap-1.5 text-[10px] text-muted">
                      <span className="font-medium text-ink">{displayEmail(m)}</span>
                      {m.role === "bot" && <span className="rounded bg-emerald-500/10 px-1 text-[9px] text-emerald-500">机器人</span>}
                      <span>{fmtTime(m.createdAt)}</span>
                    </div>
                    <div
                      className={cn(
                        "inline-block whitespace-pre-wrap break-words rounded-xl2 px-3 py-2 text-left text-[13px] leading-relaxed",
                        isMine(m) ? "bg-brand text-white" : m.role === "bot" ? "bg-emerald-500/10 text-ink" : "bg-surface2 text-ink"
                      )}
                    >
                      {(() => {
                        // 打字机光标只属于 bot 消息；用户消息纯文本无光标
                        if (m.role !== "bot") return m.content;
                        const start = revealStartRef.current[m.id];
                        const streaming = start !== undefined && Date.now() - start < TYPING_REVEAL_MS;
                        const progress = streaming ? Math.min(1, (Date.now() - start) / TYPING_REVEAL_MS) : 1;
                        const shown = m.content.slice(0, Math.round(m.content.length * progress));
                        return (
                          <>
                            {shown}
                            <span
                              className={cn("msg-stream-caret", !streaming && "msg-stream-caret--idle")}
                              aria-hidden="true"
                            />
                          </>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              )
            )
          )}
          {botTyping && (
            <div className="flex gap-2">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
                <Bot size={14} />
              </div>
              <div className="max-w-[75%] space-y-0.5">
                <div className="flex items-center gap-1.5 text-[10px] text-muted">
                  <span className="font-medium text-ink">{botName}</span>
                  <span className="rounded bg-emerald-500/10 px-1 text-[9px] text-emerald-500">机器人</span>
                </div>
                <div
                  className="inline-flex items-center gap-1 rounded-xl2 px-3 py-3"
                  style={{ borderRadius: "14px 14px 14px 4px" }}
                >
                  <span className="typing-dot" aria-hidden="true" />
                  <span className="typing-dot" aria-hidden="true" />
                  <span className="typing-dot" aria-hidden="true" />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="relative border-t border-line p-3">
          {mention && (
            <div className="absolute bottom-full left-3 right-3 mb-2 max-h-56 overflow-y-auto rounded-xl border border-line bg-surface shadow-card">
              <div className="border-b border-line/70 px-3 py-1.5 text-[10px] text-muted">选择要 @ 的用户</div>
              {participants.map((u, i) => (
                <button
                  key={u.id}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-ink transition-colors",
                    i === mentionIdx ? "bg-brand/10" : "hover:bg-surface2"
                  )}
                  onClick={() => pickMention(u.name)}
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface2 text-[10px] text-muted">{u.name[0]?.toUpperCase()}</span>
                  <span className="truncate">{u.name}</span>
                </button>
              ))}
              {participants.length === 0 && <p className="px-3 py-3 text-center text-xs text-muted">还没有可 @ 的用户</p>}
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => onInputChange(e.target.value.slice(0, CHARS_LIMIT))}
              onKeyDown={(e) => {
                // 中文输入法选词时的 Enter（isComposing / keyCode 229）不触发发送
                if (e.key === "Escape" && mention) { setMention(null); return; }
                if (mention && participants.length) {
                  // @ 候选打开：上下选择、Enter 选中（不发送），关闭后再 Enter 才发送
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    setMentionIdx((i) => (e.key === "ArrowDown" ? i + 1 : i - 1 + participants.length) % participants.length);
                    return;
                  }
                  if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                    e.preventDefault();
                    const u = participants[Math.max(0, Math.min(mentionIdx, participants.length - 1))];
                    pickMention(u.name);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder={botTyping ? "机器人正在回复…" : `输入消息，Enter 发送（${CHARS_LIMIT} 字以内）…`}
              className="max-h-32 min-h-[46px] flex-1 resize-y rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-brand/60"
            />
            <Button className="h-11" disabled={busy || !input.trim()} onClick={() => void send()}>
              <Send size={14} />{busy ? "发送中…" : "发送"}
            </Button>
          </div>
          <p className="mt-1 text-right text-[10px] text-muted">{input.length}/{CHARS_LIMIT}</p>
        </div>
      </Card>

      {/* 长按/右键菜单（微信式） */}
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            className="fixed z-50 w-40 overflow-hidden rounded-xl border border-line bg-surface shadow-card"
            style={{ left: Math.min(menu.x, window.innerWidth - 170), top: Math.min(menu.y, window.innerHeight - 110) }}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] text-ink transition-colors hover:bg-surface2"
              onClick={() => mentionBot()}
            >
              <span className="font-medium">@ 助手</span>
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[13px] text-ink transition-colors hover:bg-surface2"
              onClick={() => void pat()}
            >
              <span className="font-medium">拍一拍</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
