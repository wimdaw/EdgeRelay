import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Gauge, Mail, RefreshCw, ShieldAlert, Users, Wallet } from "lucide-react";
import { adminAction } from "../lib/api";
import { Button, Card, EmptyState, useToast } from "../components/ui";
import { cn } from "../lib/utils";

type QuotaModel = { id: string; name?: string; remaining: number | null; resetTime?: string; recommended?: boolean };
type AccountQuota = {
  type: "antigravity" | "cline" | "codebuddy" | "chatgptweb" | "codex" | "unknown";
  ok: boolean;
  email?: string;
  name?: string;
  plan?: string;
  note?: string;
  error?: string;
  balance?: number;
  remain?: number;
  used?: number;
  size?: number;
  requestsToday?: number;
  models?: QuotaModel[];
  windows?: Array<{ label: string; usedPercent: number; remainPercent: number; windowMinutes?: number; resetTime?: string }>;
  credits?: { hasCredits: boolean; balance?: number; unlimited?: boolean };
};
type PoolAccount = {
  id: string;
  label: string;
  fingerprint: string;
  status: "active" | "disabled";
  health: "healthy" | "unhealthy" | "demoted";
  failures: number;
  quota: AccountQuota | null;
};
type PoolProvider = {
  id: string;
  name: string;
  slug: string;
  kind: string;
  status: "active" | "disabled";
  accounts: PoolAccount[];
};

const kindLabel = (kind: string) => (kind.startsWith("oauth:") ? "OAuth 授权" : kind.startsWith("web:") ? "Web 反代" : kind);

function HealthTag({ a }: { a: PoolAccount }) {
  if (a.status === "disabled") return <span className="rounded bg-zinc-500/10 px-1.5 py-0.5 text-[10px] text-zinc-400">已停用</span>;
  if (a.health === "demoted") return <span className="flex items-center gap-0.5 rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-500"><ShieldAlert size={10} />熔断冷却</span>;
  if (a.health === "unhealthy") return <span className="flex items-center gap-0.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500"><AlertTriangle size={10} />异常({a.failures})</span>;
  return <span className="flex items-center gap-0.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500"><CheckCircle2 size={10} />就绪</span>;
}

function Progress({ value, label }: { value: number | null; label?: string }) {
  const pct = value == null ? null : Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className="min-w-[120px]">
      <div className="flex items-center justify-between gap-2 text-[10px] text-muted">
        <span className="truncate">{label}</span>
        <span className={cn("font-mono", pct == null ? "text-muted" : pct <= 10 ? "text-red-500" : pct <= 30 ? "text-amber-500" : "text-emerald-500")}>
          {pct == null ? "—" : `${pct}%`}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-line/70">
        <div
          className={cn("h-full rounded-full", pct == null ? "bg-muted/40" : pct <= 10 ? "bg-red-500" : pct <= 30 ? "bg-amber-500" : "bg-emerald-500")}
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>
    </div>
  );
}

function QuotaView({ q }: { q: AccountQuota | null }) {
  if (!q) {
    return <span className="text-[11px] text-muted">该渠道暂无额度查询接口</span>;
  }
  if (!q.ok) {
    return <span className="text-[11px] text-err break-all">{q.error || "额度查询失败"}</span>;
  }

  if (q.type === "antigravity") {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          {q.email && <span className="inline-flex items-center gap-1 text-ink"><Mail size={11} />{q.email}</span>}
          {q.plan && <span className="rounded bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand">{q.plan}</span>}
          {q.note && <span className="text-[10px] text-amber-500">{q.note}</span>}
        </div>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {(q.models || []).map((m) => (
            <div key={m.id} className="rounded-lg bg-surface2/50 px-2.5 py-1.5">
              <Progress value={m.remaining} label={m.id} />
              {m.resetTime && (
                <div className="mt-1 flex items-center gap-1 text-[10px] text-muted">
                  <Clock size={10} />重置 {new Date(m.resetTime).toLocaleString("zh-CN", { hour12: false })}
                </div>
              )}
            </div>
          ))}
          {(q.models || []).length === 0 && <span className="text-[11px] text-muted">上游未返回模型额度</span>}
        </div>
      </div>
    );
  }

  if (q.type === "cline") {
    return (
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
        {q.email && <span className="inline-flex items-center gap-1 text-ink"><Mail size={11} />{q.email}</span>}
        <span className="rounded bg-surface2 px-2 py-1">
          Credit 余额 <b className="font-mono text-ink">{q.balance == null ? "—" : q.balance.toLocaleString()}</b>
        </span>
        <span className="rounded bg-surface2 px-2 py-1">
          今日请求 <b className="font-mono text-ink">{q.requestsToday ?? 0}</b>
        </span>
      </div>
    );
  }

  if (q.type === "codebuddy") {
    const total = q.size ?? null;
    const remain = q.remain ?? null;
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          {q.email && <span className="inline-flex items-center gap-1 text-ink">{q.email}</span>}
          {q.note && <span className="rounded bg-surface2 px-1.5 py-0.5 text-[10px]">{q.note}</span>}
        </div>
        <div className="flex items-center gap-3">
          {total != null && total > 0 && remain != null ? (
            <div className="min-w-[160px] flex-1">
              <Progress value={remain / total} label={`剩余 ${remain} / ${total}`} />
            </div>
          ) : (
            <span className="text-[11px] text-muted">剩余积分 <b className="font-mono text-ink">{remain ?? "—"}</b></span>
          )}
          {q.used != null && <span className="text-[10px] text-muted">已用 <b className="font-mono text-ink">{q.used}</b></span>}
        </div>
      </div>
    );
  }

  if (q.type === "codex") {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          {q.email && <span className="inline-flex items-center gap-1 text-ink"><Mail size={11} />{q.email}</span>}
          {q.plan && <span className="rounded bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand">{q.plan}</span>}
          {q.credits && (
            <span className="rounded bg-surface2 px-2 py-0.5 text-[10px]">
              Credits {q.credits.unlimited ? "不限" : q.credits.hasCredits ? (q.credits.balance == null ? "可用" : q.credits.balance.toLocaleString()) : "无"}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {(q.windows || []).map((w) => (
            <div key={w.label} className="rounded-lg bg-surface2/50 px-2.5 py-1.5">
              <Progress value={w.remainPercent / 100} label={w.label} />
              <div className="mt-1 flex items-center gap-1 text-[10px] text-muted">
                <Clock size={10} />
                {w.resetTime ? `重置 ${new Date(w.resetTime).toLocaleString("zh-CN", { hour12: false })}` : "未返回重置时间"}
              </div>
            </div>
          ))}
          {(q.windows || []).length === 0 && <span className="text-[11px] text-muted">上游未返回额度窗口</span>}
        </div>
      </div>
    );
  }

  if (q.type === "chatgptweb") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
        {q.email ? <span className="inline-flex items-center gap-1 text-ink"><Mail size={11} />{q.email}</span> : <span className="text-ink">{q.name || "网页账号"}</span>}
        {q.name && q.email && <span className="text-[10px] text-muted">{q.name}</span>}
        {q.plan && <span className="rounded bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand">{q.plan}</span>}
        {q.note && <span className="text-[10px] text-amber-500">{q.note}</span>}
        {!q.note && <span className="text-[10px] text-muted">网页版无额度接口</span>}
      </div>
    );
  }

  return <span className="text-[11px] text-muted">—</span>;
}

export default function AccountPool() {
  const [rows, setRows] = useState<PoolProvider[] | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const r = await adminAction<{ providers: PoolProvider[] }>("account_pool");
      setRows(r.providers);
    } catch (e) {
      toast((e as Error).message, "err");
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const totalAccounts = (rows || []).reduce((n, p) => n + p.accounts.length, 0);

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand"><Wallet size={18} /></div>
            <div>
              <h1 className="text-base font-bold text-ink">账号池</h1>
              <p className="mt-0.5 text-xs text-muted">
                OAuth / Web 反代渠道的账号与额度总览。Antigravity、Cline、CodeBuddy、ChatGPT 网页版会实时查询上游额度，其余渠道展示账号健康状态。
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted"><Users size={12} className="mr-1 inline" />{rows ? `${rows.length} 个渠道 / ${totalAccounts} 个账号` : "加载中…"}</span>
            <Button variant="soft" onClick={load} disabled={loading}>
              <RefreshCw size={14} className={cn(loading && "animate-spin")} />{loading ? "查询中…" : "刷新额度"}
            </Button>
          </div>
        </div>
        <p className="mt-3 rounded-lg border border-line bg-surface2/40 px-3 py-2 text-[11px] text-muted">
          额度查询为实时请求，账号较多时可能需要几秒；查询失败不会影响账号正常调用，只影响本页展示。
        </p>
      </Card>

      {rows === null ? (
        <div className="grid gap-3.5 grid-cols-1 lg:grid-cols-2">
          {[...Array(3)].map((_, i) => <div key={i} className="skeleton h-48 rounded-xl2" />)}
        </div>
      ) : rows.length === 0 ? (
        <Card><EmptyState icon={<Wallet size={32} />} title="暂无 OAuth / Web 账号" hint="先在「供应商」页的 OAuth 授权或 Web 反代选项卡接入渠道账号。" /></Card>
      ) : (
        <div className="flex flex-col gap-3.5">
          {rows.map((p) => (
            <Card key={p.id} className={cn("p-4", p.status === "disabled" && "opacity-75 border-dashed")}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-xs font-bold text-brand">{p.name[0]}</div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-ink">{p.name}</span>
                      <span className="rounded bg-line/70 px-1.5 py-0.5 text-[10px] text-muted">{kindLabel(p.kind)}</span>
                      <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", p.status === "active" ? "bg-emerald-500/10 text-emerald-500" : "bg-zinc-500/10 text-zinc-400")}>
                        {p.status === "active" ? "启用" : "停用"}
                      </span>
                    </div>
                    <code className="text-[10px] text-muted font-mono">{p.slug}</code>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1 text-[11px] text-muted"><Users size={11} />{p.accounts.length} 个账号</span>
              </div>

              <div className="mt-2.5 space-y-2">
                {p.accounts.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted">该渠道暂无账号凭据</p>
                ) : p.accounts.map((a) => (
                  <div key={a.id} className="rounded-lg border border-line/70 bg-surface2/30 p-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <code className="text-[11px] font-mono font-medium text-ink">{a.fingerprint}</code>
                      <span className="rounded bg-line px-1 py-0.5 text-[10px] text-muted">{a.label || "account"}</span>
                      <HealthTag a={a} />
                      {(a.quota?.plan || a.quota?.email) && <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted"><Gauge size={10} />{a.quota?.email || a.quota?.plan}</span>}
                    </div>
                    <div className="mt-2 pl-0.5">
                      <QuotaView q={a.quota} />
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
