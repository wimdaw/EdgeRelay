import { useEffect, useState } from "react";
import { MessageSquare, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import { Button, Card, Dialog, EmptyState, Field, Input, Select, useToast } from "../components/ui";
import { cn } from "../lib/utils";

type MySubmission = {
  id: string;
  name: string;
  slug: string;
  kind: string;
  baseUrl: string;
  authScheme: string;
  status: "pending" | "approved" | "rejected";
  rejectionReason?: string | null;
  hasKey: boolean;
  providerId?: string | null;
  created_at?: number;
  createdAt: number;
  updatedAt: number;
};

type ThreadMessage = {
  id: string;
  fromEmail: string;
  fromRole: "user" | "admin";
  content: string;
  createdAt: number;
};

const STATUS_META: Record<MySubmission["status"], { label: string; cls: string }> = {
  pending: { label: "待审核", cls: "bg-amber-500/10 text-amber-500" },
  approved: { label: "已通过", cls: "bg-emerald-500/10 text-emerald-500" },
  rejected: { label: "已驳回", cls: "bg-red-500/10 text-red-500" },
};

const fmt = (ts?: number) => (ts ? new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false }) : "—");

/** 我的供应商：展示当前用户提交的渠道与审核状态；可提交新渠道、与管理员站内信往来 */
export default function MyProviders({ meEmail }: { meEmail: string }) {
  const [subs, setSubs] = useState<MySubmission[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [thread, setThread] = useState<{ sub: MySubmission; messages: ThreadMessage[] } | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const toast = useToast();

  const [form, setForm] = useState({ name: "", slug: "", baseUrl: "", kind: "openai_compat", authScheme: "bearer", key: "", password: "" });

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await api<{ submissions: MySubmission[] }>("/api/user/providers");
      setSubs(r.submissions || []);
    } catch (e) {
      if (!silent) toast((e as Error).message, "err");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const submit = async () => {
    const f = form;
    if (!f.name.trim() || !f.slug.trim() || !f.baseUrl.trim() || !f.password) {
      return toast("名称 / 标识符 / Base URL / 账户密码 均必填", "err");
    }
    setSubmitting(true);
    try {
      await api("/api/user/providers", "POST", { ...f });
      toast("已提交，等待超级管理员审核", "ok");
      setSubmitOpen(false);
      setForm({ name: "", slug: "", baseUrl: "", kind: "openai_compat", authScheme: "bearer", key: "", password: "" });
      await load(true);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setSubmitting(false);
    }
  };

  const openThread = async (sub: MySubmission) => {
    try {
      const r = await api<{ messages: ThreadMessage[] }>(`/api/user/providers/${sub.id}/messages`);
      setThread({ sub, messages: r.messages || [] });
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  const sendReply = async () => {
    if (!thread || !reply.trim()) return;
    setSending(true);
    try {
      await api(`/api/user/providers/${thread.sub.id}/messages`, "POST", { content: reply.trim() });
      setReply("");
      const r = await api<{ messages: ThreadMessage[] }>(`/api/user/providers/${thread.sub.id}/messages`);
      setThread({ sub: thread.sub, messages: r.messages || [] });
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold">我的供应商</h2>
            <p className="mt-0.5 text-xs text-muted">
              提交需校验账户密码；提交后进入待审核状态，不可自行修改或删除。需要调整时通过站内信联系管理员。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="soft" className="h-9" onClick={() => void load(true)} disabled={loading}>
              <RefreshCw size={14} className={cn(loading && "animate-spin")} />{loading ? "刷新中…" : "刷新"}
            </Button>
            <Button className="h-9" onClick={() => setSubmitOpen(true)}>
              <Plus size={14} />提交新供应商
            </Button>
          </div>
        </div>
      </Card>

      {subs === null ? (
        <Card className="p-6"><div className="skeleton h-20 rounded-xl2" /></Card>
      ) : subs.length === 0 ? (
        <Card>
          <EmptyState icon={<ShieldCheck size={32} />} title="还没有提交过供应商" hint="点右上角「提交新供应商」，审核通过后会出现在全站渠道列表中。" />
        </Card>
      ) : (
        subs.map((s) => {
          const meta = STATUS_META[s.status];
          return (
            <Card key={s.id} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-ink">{s.name}</span>
                    <code className="rounded bg-line px-1.5 py-0.5 text-[10px] text-muted font-mono">{s.slug}</code>
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", meta.cls)}>{meta.label}</span>
                  </div>
                  <div className="mt-1 truncate text-[11px] text-muted font-mono">{s.baseUrl}</div>
                  {s.status === "rejected" && s.rejectionReason && (
                    <div className="mt-1.5 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-[11px] text-err">驳回原因：{s.rejectionReason}</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted">{fmt(s.createdAt)}</span>
                  <Button variant="soft" className="!h-7 !px-2 text-[11px]" onClick={() => void openThread(s)}>
                    <MessageSquare size={12} />往来消息
                  </Button>
                </div>
              </div>
            </Card>
          );
        })
      )}

      {/* 提交表单 */}
      <Dialog open={submitOpen} onClose={() => setSubmitOpen(false)} title="提交新供应商（审核制）" width={520}>
        <div className="space-y-3">
          <Field label="供应商名称"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：我的 OpenAI 中转" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="渠道标识符（slug）"><Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} placeholder="my-openai-relay" /></Field>
            <Field label="渠道类型">
              <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className="w-full">
                <option value="openai_compat">OpenAI 兼容</option>
                <option value="anthropic">Anthropic 原生</option>
              </Select>
            </Field>
          </div>
          <Field label="Base URL"><Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></Field>
          <Field label="上游密钥（可选，审核通过后由管理员录入）">
            <Input type="password" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="sk-…" />
          </Field>
          <Field label="账户密码（敏感操作校验）" hint="提交属敏感操作，需验证你的登录密码">
            <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="current-password" />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setSubmitOpen(false)}>取消</Button>
            <Button onClick={() => void submit()} disabled={submitting}>{submitting ? "提交中…" : "提交审核"}</Button>
          </div>
        </div>
      </Dialog>

      {/* 站内信线程 */}
      <Dialog open={!!thread} onClose={() => setThread(null)} title={`往来消息 · ${thread?.sub.name ?? ""}`} width={560}>
        <div className="max-h-[46vh] space-y-2.5 overflow-y-auto pr-1">
          {(thread?.messages || []).length === 0 && <p className="py-6 text-center text-xs text-muted">暂无消息</p>}
          {(thread?.messages || []).map((m) => (
            <div key={m.id} className={cn("flex", m.fromRole === "user" ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[80%] rounded-xl2 px-3 py-2 text-[12px] leading-relaxed", m.fromRole === "user" ? "bg-brand text-white" : "bg-surface2 text-ink")}>
                <div className={cn("mb-1 text-[10px]", m.fromRole === "user" ? "text-white/70" : "text-muted")}>
                  {m.fromRole === "admin" ? "管理员" : meEmail} · {fmt(m.createdAt)}
                </div>
                <div className="whitespace-pre-wrap break-words">{m.content}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-end gap-2 border-t border-line pt-3">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={2}
            placeholder="给管理员留言（如需修改已提交的信息，请说明内容）…"
            className="max-h-28 min-h-[44px] flex-1 resize-y rounded-lg border border-line bg-surface px-3 py-2 text-[12px] text-ink outline-none focus:border-brand/60"
          />
          <Button className="h-11" disabled={sending || !reply.trim()} onClick={() => void sendReply()}>
            <MessageSquare size={14} />{sending ? "发送中…" : "发送"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
