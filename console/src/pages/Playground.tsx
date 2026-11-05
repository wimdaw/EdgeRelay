import { useEffect, useRef, useState } from "react";
import { Bot, Copy, Eraser, Play, Send, Square, User } from "lucide-react";
import { api, type Me } from "../lib/api";
import { Button, Card, Select, useToast } from "../components/ui";
import { cn } from "../lib/utils";

type ModelItem = { id: string; provider: string; paid: boolean };
type Msg = { id: string; role: "user" | "assistant"; content: string; error?: string; model?: string };

const uid = () => Math.random().toString(36).slice(2, 10);

export default function Playground({ me }: { me: Me }) {
  const [models, setModels] = useState<ModelItem[]>([]);
  const [model, setModel] = useState("");
  const [system, setSystem] = useState("");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const toast = useToast();

  useEffect(() => {
    api<{ models: ModelItem[] }>("/api/playground/models")
      .then((d) => {
        setModels(d.models);
        if (d.models.length) setModel((m) => m || d.models[0].id);
      })
      .catch((e) => toast((e as Error).message, "err"));
  }, []);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [msgs]);

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!model) {
      toast("请先选择模型", "err");
      return;
    }

    const userMsg: Msg = { id: uid(), role: "user", content: text };
    const assistantId = uid();
    const history = [...msgs, userMsg].map((m) => ({ role: m.role, content: m.content }));

    setMsgs((prev) => [...prev, userMsg, { id: assistantId, role: "assistant", content: "", model }]);
    setInput("");
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const patch = (fn: (m: Msg) => Msg) =>
      setMsgs((prev) => prev.map((m) => (m.id === assistantId ? fn(m) : m)));

    try {
      const resp = await fetch("/api/playground/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: history,
          system,
          temperature,
          max_tokens: maxTokens,
          stream: true,
        }),
        signal: ctrl.signal,
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => null);
        patch((m) => ({ ...m, error: data?.error?.message ?? `请求失败 (${resp.status})` }));
        return;
      }

      const reader = resp.body?.getReader();
      if (!reader) throw new Error("浏览器不支持流式读取");
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload && payload !== "[DONE]") {
              try {
                const j = JSON.parse(payload);
                const delta = j?.choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta) {
                  patch((m) => ({ ...m, content: m.content + delta }));
                }
              } catch {
                // 忽略无法解析的心跳帧
              }
            }
          }
          nl = buffer.indexOf("\n");
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        patch((m) => ({ ...m, error: (e as Error).message || "请求失败" }));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制");
    } catch {
      toast("复制失败", "err");
    }
  };

  const clear = () => {
    stop();
    setMsgs([]);
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <Play size={18} />
            </div>
            <div>
              <h1 className="text-base font-bold text-ink">操练场</h1>
              <p className="mt-0.5 text-xs text-muted">
                直接在控制台里试模型，走网关同一套路由与 Key 池，不需要 API Key；每分钟最多 20 次，不计量。
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" className="h-9" onClick={clear} disabled={!msgs.length}>
              <Eraser size={14} /> 清空
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[300px,1fr]">
        {/* 参数面板 */}
        <Card className="h-fit p-4">
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted">模型</label>
              <Select value={model} onChange={(e) => setModel(e.target.value)} className="w-full">
                {models.length === 0 && <option value="">加载中…</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                    {m.paid ? "（付费）" : ""}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-[10px] text-muted">
                {me.user.role === "superadmin" || me.user.role === "admin"
                  ? "管理员可见全部模型（含付费）"
                  : "普通用户仅显示免费模型"}
              </p>
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted">系统提示词（可选）</label>
              <textarea
                value={system}
                onChange={(e) => setSystem(e.target.value)}
                rows={3}
                placeholder="例如：你是一个简洁的助手，回答不超过三句话。"
                className="w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-2 text-[12px] text-ink outline-none focus:border-brand/60"
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <label className="text-[11px] font-medium text-muted">温度</label>
              <span className="font-mono text-[11px] text-ink">{temperature.toFixed(1)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              className="w-full accent-brand"
            />

            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted">最大输出 tokens</label>
              <input
                type="number"
                min={16}
                max={8192}
                value={maxTokens}
                onChange={(e) => setMaxTokens(Math.max(16, Math.min(8192, Number(e.target.value) || 1024)))}
                className="w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-[12px] text-ink outline-none focus:border-brand/60"
              />
            </div>
          </div>
        </Card>

        {/* 对话区 */}
        <Card className="flex min-h-[520px] flex-col overflow-hidden">
          <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-4">
            {msgs.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
                <Bot size={30} className="text-muted" />
                <p className="text-[13px] text-muted">选个模型，随便问点什么</p>
                <p className="text-[11px] text-muted">Enter 发送 · Shift + Enter 换行</p>
              </div>
            ) : (
              msgs.map((m) => (
                <div key={m.id} className={cn("flex gap-2.5", m.role === "user" && "flex-row-reverse")}>
                  <div
                    className={cn(
                      "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                      m.role === "user" ? "bg-brand/15 text-brand" : "bg-surface2 text-muted"
                    )}
                  >
                    {m.role === "user" ? <User size={14} /> : <Bot size={14} />}
                  </div>
                  <div className={cn("max-w-[85%] space-y-1", m.role === "user" && "text-right")}>
                    <div
                      className={cn(
                        "inline-block whitespace-pre-wrap break-words rounded-xl2 px-3.5 py-2.5 text-left text-[13px] leading-relaxed",
                        m.role === "user" ? "bg-brand text-white" : "bg-surface2 text-ink"
                      )}
                    >
                      {m.content || (busy ? "…" : "")}
                      {m.error && <span className="mt-1 block text-[11px] text-err">{m.error}</span>}
                    </div>
                    <div className={cn("flex items-center gap-2 text-[10px] text-muted", m.role === "user" && "justify-end")}>
                      {m.role === "assistant" && m.model && <span>{m.model}</span>}
                      {m.content && (
                        <button type="button" className="hover:text-ink" onClick={() => copy(m.content)}>
                          <Copy size={10} className="mr-0.5 inline" />复制
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="border-t border-line p-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={2}
                placeholder="输入内容…"
                className="max-h-40 min-h-[46px] flex-1 resize-y rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-brand/60"
              />
              {busy ? (
                <Button variant="danger" className="h-11" onClick={stop}>
                  <Square size={14} /> 停止
                </Button>
              ) : (
                <Button className="h-11" onClick={send} disabled={!input.trim() || !model}>
                  <Send size={14} /> 发送
                </Button>
              )}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
