import { useEffect, useState } from "react";
import { Check, MessageSquare, RefreshCw, X } from "lucide-react";
import { adminAction } from "../lib/api";
import { Button, Card, Dialog, EmptyState, useConfirm, useToast } from "../components/ui";
import { cn } from "../lib/utils";

type Submission = {
  id: string;
  name: string;
  slug: string;
  kind: string;
  baseUrl: string;
  authScheme: string;
  status: "pending" | "approved" | "rejected";
  rejectionReason?: string | null;
  ownerEmail?: string;
  hasKey: boolean;
  providerId?: string | null;
  createdAt: number;
  updatedAt: number;
};

type ThreadMessage = { id: string; fromEmail: string; fromRole: "user" | "admin"; content: string; createdAt: number };

const STATUS_META: Record<Submission["status"], { label: string; cls: string }> = {
  pending: { label: "待审核", cls: "bg-amber-500/10 text-amber-500" },
  approved: { label: "已通过", cls: "bg-emerald-500/10 text-emerald-500" },
  rejected: { label: "已驳回", cls: "bg-red-500/10 text-red-500" },
};

const fmt = (ts?: number) => (ts ? new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false }) : "—");

/** 用户提交供应商审核面板（仅超级管理员）：通过 / 驳回 / 站内信往来 */
export default function ProviderSubmissions() {
  const [subs, setSubs] = useState<Submission[] | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [rejectDlg, setRejectDlg] = useState<{ sub: Submission; reason: string } | null>(null);
  const [thread, setThread] = useState<{ sub: Submission; messages: ThreadMessage[] } | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await adminAction<{ submissions: Submission[]; pendingCount: number }>("list_provider_submissions");
      setSubs(r.submissions || []);
      setPendingCount(r.pendingCount || 0);
    } catch (e) {
      if (!silent) toast((e as Error).message, "err");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const openThread = async (sub: Submission) => {
    try {
      const r = await adminAction<{ messages: ThreadMessage[] }>("provider_submission_thread", { id: sub.id });
      setThread({ sub, messages: r.messages || [] });
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  const sendReply = async () => {
    if (!thread || !reply.trim()) return;
    setSending(true);
    try {
      await adminAction("provider_submission_reply", { id: thread.sub.id, content: reply.trim() });
      setReply("");
      await openThread(thread.sub);
      await load(true);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setSending(false);
    }
  };

  const review = async (sub: Submission, decision: "approved" | "rejected", reason?: string) => {
    setBusy(sub.id);
    try {
      await adminAction("provider_submission_review", { id: sub.id, decision, reason });
      toast(decision === "approved" ? `已通过：渠道「${sub.name}」已创建并进入全站列表` : "已驳回并通知提交用户", "ok");
      setRejectDlg(null);
      await load(true);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy("");
    }
  };

  const approve = async (sub: Submission) => {
    if (await confirm(`通过「${sub.name}」的提交？将创建正式渠道${sub.hasKey ? "并录入用户提交的密钥" : "（无密钥，需手动录入）"}。`)) {
      await review(sub, "approved");
    }
  };

  // 待审核排前，再按时间倒序
  const sorted = (subs || []).slice().sort((a, b) => {
    const pa = a.status === "pending" ? 0 : a.status === "approved" ? 1 : 2;
    const pb = b.status === "pending" ? 0 : b.status === "approved" ? 1 : 2;
    return pa - pb || b.updatedAt - a.updatedAt;
  });

  return (
    <div className="flex flex-col gap-4">
      {confirmEl}
      <div className="rounded-xl border border-line bg-surface2/50 p-3 text-xs text-muted leading-relaxed">
        用户提交的供应商在这里审核：通过后创建正式渠道（进入全站列表与路由），驳回必须填写原因（对提交用户可见）。
        当前待审核 <b className="text-amber-500">{pendingCount}</b> 条。
      </div>

      {subs === null ? (
        <Card className="p-6"><div className="skeleton h-20 rounded-xl2" /></Card>
      ) : sorted.length === 0 ? (
        <Card>
          <EmptyState icon={<Check size={32} />} title="暂无用户提交" hint="普通用户在「个人主页 → 我的供应商」提交渠道后，这里会出现待审核记录。" />
        </Card>
      ) : (
        sorted.map((s) => {
          const meta = STATUS_META[s.status];
          return (
            <Card key={s.id} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-ink">{s.name}</span>
                    <code className="rounded bg-line px-1.5 py-0.5 text-[10px] text-muted font-mono">{s.slug}</code>
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", meta.cls)}>{meta.label}</span>
                    {s.hasKey && <span className="rounded bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand">含密钥</span>}
                    {s.providerId && <code className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-500 font-mono">{s.providerId.slice(0, 8)}…</code>}
                  </div>
                  <div className="mt-1 truncate text-[11px] text-muted font-mono">{s.baseUrl}</div>
                  <div className="mt-1 text-[10px] text-muted">
                    提交人 {s.ownerEmail || "—"} · {fmt(s.createdAt)}
                    {s.status === "rejected" && s.rejectionReason && <span className="text-err"> · 驳回原因：{s.rejectionReason}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="soft" className="!h-7 !px-2 text-[11px]" onClick={() => void openThread(s)}>
                    <MessageSquare size={12} />往来
                  </Button>
                  {s.status === "pending" && (
                    <>
                      <Button variant="soft" className="!h-7 !px-2 text-[11px] !text-emerald-500" disabled={busy === s.id} onClick={() => void approve(s)}>
                        <Check size={12} />通过
                      </Button>
                      <Button variant="soft" className="!h-7 !px-2 text-[11px] !text-err" disabled={busy === s.id} onClick={() => setRejectDlg({ sub: s, reason: "" })}>
                        <X size={12} />驳回
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </Card>
          );
        })
      )}

      {/* 驳回原因 */}
      <Dialog open={!!rejectDlg} onClose={() => setRejectDlg(null)} title={`驳回「${rejectDlg?.sub.name ?? ""}」`} width={480}>
        <p className="mb-3 text-xs text-muted">驳回原因将同步到站内信线程，对提交用户可见。</p>
        <textarea
          rows={3}
          value={rejectDlg?.reason ?? ""}
          onChange={(e) => setRejectDlg((d) => (d ? { ...d, reason: e.target.value } : d))}
          placeholder="例如：Base URL 不可达 / 密钥无效 / 与现有渠道重复…"
          className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-[12px] text-ink outline-none focus:border-brand/60"
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRejectDlg(null)}>取消</Button>
          <Button
            variant="danger"
            disabled={!rejectDlg?.reason.trim() || busy === rejectDlg?.sub.id}
            onClick={() => rejectDlg && void review(rejectDlg.sub, "rejected", rejectDlg.reason.trim())}
          >
            {busy === rejectDlg?.sub.id ? "处理中…" : "确认驳回"}
          </Button>
        </div>
      </Dialog>

      {/* 站内信线程 */}
      <Dialog open={!!thread} onClose={() => setThread(null)} title={`往来消息 · ${thread?.sub.name ?? ""}`} width={560}>
        <div className="max-h-[46vh] space-y-2.5 overflow-y-auto pr-1">
          {(thread?.messages || []).length === 0 && <p className="py-6 text-center text-xs text-muted">暂无消息</p>}
          {(thread?.messages || []).map((m) => (
            <div key={m.id} className={cn("flex", m.fromRole === "admin" ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[80%] rounded-xl2 px-3 py-2 text-[12px] leading-relaxed", m.fromRole === "admin" ? "bg-brand text-white" : "bg-surface2 text-ink")}>
                <div className={cn("mb-1 text-[10px]", m.fromRole === "admin" ? "text-white/70" : "text-muted")}>
                  {m.fromRole === "admin" ? "管理员（我）" : m.fromEmail} · {fmt(m.createdAt)}
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
            placeholder="回复提交用户（处理结果、修改要求等）…"
            className="max-h-28 min-h-[44px] flex-1 resize-y rounded-lg border border-line bg-surface px-3 py-2 text-[12px] text-ink outline-none focus:border-brand/60"
          />
          <Button className="h-11" disabled={sending || !reply.trim()} onClick={() => void sendReply()}>
            <MessageSquare size={14} />{sending ? "发送中…" : "发送"}
          </Button>
        </div>
      </Dialog>

      {/* 顶部悬浮刷新按钮（loading 时转圈） */}
      {loading && (
        <div className="fixed bottom-6 right-6 rounded-full bg-surface p-2 shadow-card text-muted"><RefreshCw size={16} className="animate-spin" /></div>
      )}
    </div>
  );
}
