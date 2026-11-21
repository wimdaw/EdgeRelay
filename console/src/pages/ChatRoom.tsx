import { useEffect, useRef, useState } from "react";
import { Bot, MessagesSquare, Send, User } from "lucide-react";
import { api, type Me } from "../lib/api";
import { Button, Card, useToast } from "../components/ui";
import { cn } from "../lib/utils";

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
  const listRef = useRef<HTMLDivElement | null>(null);
  const toast = useToast();

  const poll = async () => {
    try {
      const r = await api<{ messages: ChatMessage[] }>("/api/chatroom/messages");
      setMsgs(r.messages || []);
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

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    try {
      // 发送响应即含最新消息（含机器人回复），随后轮询兜底
      const r = await api<{ messages: ChatMessage[] }>("/api/chatroom/messages", "POST", { content: text });
      setMsgs(r.messages || []);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };

  const displayEmail = (m: ChatMessage) => (m.role === "bot" ? "Relay 助手" : m.role === "system" ? "系统" : m.nickname || m.email);
  const isMine = (m: ChatMessage) => m.role === "user" && m.userId === me.user.id;

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
                      m.role === "bot" ? "bg-emerald-500/15 text-emerald-500" : isMine(m) ? "bg-brand/15 text-brand" : "bg-surface2 text-muted"
                    )}
                  >
                    {m.role === "bot" ? <Bot size={14} /> : isMine(m) ? <User size={14} /> : (m.email[0] || "?").toUpperCase()}
                  </div>
                  <div className={cn("max-w-[75%] space-y-0.5", isMine(m) && "flex flex-col items-end")}>
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
                      {m.content}
                    </div>
                  </div>
                </div>
              )
            )
          )}
        </div>

        <div className="border-t border-line p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value.slice(0, CHARS_LIMIT))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder={`输入消息，Enter 发送（${CHARS_LIMIT} 字以内）…`}
              className="max-h-32 min-h-[46px] flex-1 resize-y rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-brand/60"
            />
            <Button className="h-11" disabled={busy || !input.trim()} onClick={() => void send()}>
              <Send size={14} />{busy ? "发送中…" : "发送"}
            </Button>
          </div>
          <p className="mt-1 text-right text-[10px] text-muted">{input.length}/{CHARS_LIMIT}</p>
        </div>
      </Card>
    </div>
  );
}
