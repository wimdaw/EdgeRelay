import { useEffect, useState } from "react";
import { Download, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { adminAction, api, type AuditLog, type Me, type UsageLog } from "../lib/api";
import { Button, Card, DataTable, Field, Input, Select, StatusTag, useConfirm, useToast, type Col } from "../components/ui";
import { downloadCsv, fmtTime } from "../lib/utils";

type Tab = "usage" | "audit";

/** 系统日志：用量日志 + 审计日志合并为一个入口，使用与「用户与组织」一致的选项卡 + 卡片布局。 */
export default function Logs({ me }: { me: Me }) {
  const canAudit = me.user.role === "superadmin" || me.user.role === "auditor";
  const [tab, setTab] = useState<Tab>("usage");
  const [usage, setUsage] = useState<UsageLog[] | null>(null);
  const [usageTotal, setUsageTotal] = useState(0);
  const [audit, setAudit] = useState<AuditLog[] | null>(null);
  const [auditLoaded, setAuditLoaded] = useState(false);
  const [f, setF] = useState({ status: "", model: "", userId: "", days: "7" });
  const { confirm, confirmEl } = useConfirm();
  const toast = useToast();

  const loadUsage = () => {
    setUsage(null);
    const since = Math.floor(Date.now() / 1000) - parseInt(f.days, 10) * 86400;
    const q = new URLSearchParams({ limit: "200", ...(f.status && { status: f.status }), ...(f.model && { model: f.model }), ...(f.userId && { userId: f.userId }) });
    api<{ logs: UsageLog[]; total: number }>(`/api/admin/usage/logs?${q}`).then((d) => {
      setUsageTotal(d.total);
      setUsage(d.logs.filter((r) => r.created_at > since));
    }).catch(() => setUsage([]));
  };

  const loadAudit = () => {
    setAudit(null);
    adminAction<{ logs: AuditLog[] }>("list_audit", { limit: 300 })
      .then((d) => { setAudit(d.logs); setAuditLoaded(true); })
      .catch((e) => toast((e as Error).message, "err"));
  };

  useEffect(() => { loadUsage(); }, []);
  useEffect(() => { if (tab === "audit" && !auditLoaded) loadAudit(); }, [tab]);

  const verifyChain = async () => {
    try {
      const r = await adminAction<{ result: { ok: boolean; brokenAt?: string } }>("verify_audit_chain");
      toast(r.result.ok ? "✓ 哈希链完整，未检测到篡改" : `✗ 链断裂于 ${r.result.brokenAt}`, r.result.ok ? "ok" : "err");
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const usageCols: Col<UsageLog>[] = [
    { key: "time", label: "时间", sortVal: (r) => r.created_at, render: (r) => <span className="text-xs text-muted">{fmtTime(r.created_at)}</span> },
    { key: "user", label: "用户", render: (r) => <code className="text-xs">{r.user_id.slice(0, 8)}…</code> },
    { key: "key", label: "API Key", render: (r) => <code className="text-xs text-muted">{(r as unknown as { api_key_id: string }).api_key_id?.slice(0, 8) ?? "—"}…</code> },
    { key: "model", label: "模型", sortVal: (r) => r.public_model, render: (r) => <span className="font-medium">{r.public_model}</span> },
    { key: "status", label: "状态", render: (r) => <StatusTag value={r.status} /> },
    { key: "http", label: "HTTP", render: (r) => <span className="text-xs">{r.http_status}</span> },
    { key: "latency", label: "耗时", sortVal: (r) => r.latency_ms, render: (r) => <span className="tabular-nums">{r.latency_ms} ms</span> },
    { key: "tokens", label: "Tokens", sortVal: (r) => r.prompt_tokens + r.completion_tokens, render: (r) => <span className="tabular-nums">{r.prompt_tokens} + {r.completion_tokens}</span> },
    { key: "cost", label: "费用", sortVal: (r) => r.cost_usd, render: (r) => r.cost_usd.toFixed(4) },
  ];

  const auditCols: Col<AuditLog>[] = [
    { key: "time", label: "时间", sortVal: (r) => r.created_at, render: (r) => <span className="text-xs text-muted">{fmtTime(r.created_at)}</span> },
    { key: "actor", label: "操作人", render: (r) => r.actor_email ?? <code className="text-xs">{r.actor_user_id ?? "系统"}</code> },
    { key: "action", label: "动作", render: (r) => <code className="rounded bg-surface2 px-1.5 py-0.5 text-xs">{r.action}</code> },
    { key: "target", label: "目标", render: (r) => <code className="text-xs text-muted">{r.target_type ? `${r.target_type}:${(r.target_id ?? "").slice(0, 12)}` : "—"}</code> },
    { key: "ip", label: "IP", render: (r) => <code className="text-xs">{r.actor_ip ?? "—"}</code> },
    { key: "ops", label: "操作", render: (r) => (
      <Button variant="ghost" className="!px-2 !py-1 text-xs !text-err" onClick={async (e) => {
        e.stopPropagation();
        if (!(await confirm("删除这条审计日志？删除后将自动重建哈希链。"))) return;
        try { await adminAction("delete_audit_log", { id: r.id }); toast("已删除并重建哈希链"); loadAudit(); } catch (err) { toast((err as Error).message, "err"); }
      }}><Trash2 size={12} />删除</Button>
    ) },
  ];

  const TABS = (canAudit
    ? ([["usage", "用量日志"], ["audit", "审计日志"]] as const)
    : ([["usage", "用量日志"]] as const));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex w-full gap-1 overflow-x-auto rounded-lg bg-surface2 p-0.5 sm:w-fit" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k as Tab)}
            className={`rounded-md px-4 py-1.5 text-xs font-medium transition-colors ${tab === k ? "bg-surface text-brand shadow-sm" : "text-muted hover:text-ink"}`}>{l}</button>
        ))}
      </div>

      {tab === "usage" && (
        <Card className="p-4 sm:p-5 flex flex-col gap-3.5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">用量日志</h3>
              <p className="mt-0.5 text-xs text-muted">按请求记录模型调用、Token 与费用明细，支持筛选与导出。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={loadUsage}>查询</Button>
              <Button variant="ghost" onClick={() => usage && downloadCsv(`usage-${Date.now()}.csv`,
                ["time", "user", "model", "status", "http", "latency_ms", "prompt_tokens", "completion_tokens", "cost", "request_id"],
                usage.map((r) => [fmtTime(r.created_at), r.user_id, r.public_model, r.status, r.http_status, r.latency_ms, r.prompt_tokens, r.completion_tokens, r.cost_usd, r.request_id]))}>
                <Download size={14} />导出 CSV
              </Button>
              <Button variant="ghost" className="!text-err" onClick={async () => {
                if (!(await confirm("清空全部用量日志？此操作不可恢复（账单流水不受影响）。"))) return;
                try { await adminAction("clear_usage_logs", {}); toast("已清空"); loadUsage(); } catch (e) { toast((e as Error).message, "err"); }
              }}><Trash2 size={14} />清空全部</Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="时间范围">
              <Select value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })}>
                <option value="1">近 24 小时</option><option value="7">近 7 天</option><option value="30">近 30 天</option>
              </Select>
            </Field>
            <Field label="状态">
              <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
                <option value="">全部</option>{["success", "upstream_error", "content_blocked", "no_route", "insufficient_balance"].map((s) => <option key={s}>{s}</option>)}
              </Select>
            </Field>
            <Field label="模型名">
              <Input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder="deepseek-chat" />
            </Field>
            <Field label="用户 ID">
              <Input value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} placeholder="用户 ID" />
            </Field>
          </div>

          {usage === null ? (
            <div className="flex flex-col gap-2">{[...Array(8)].map((_, i) => <div key={i} className="skeleton h-9" />)}</div>
          ) : (
            <>
              <div className="text-xs text-muted">最近 {usage.length} 条 / 命中 {usageTotal} 条（时间倒序）</div>
              <DataTable cols={usageCols} rows={usage} page={14} expand={(r) => (
                <div className="grid grid-cols-2 gap-2 font-mono text-xs text-muted">
                  <span>请求 ID：<span className="text-ink">{r.request_id}</span></span>
                  <span>Key：{(r as unknown as { api_key_id: string }).api_key_id ?? "—"}</span>
                  <span>错误码：{r.error_code ?? "—"}</span>
                  <span>重试/切换：{r.attempts} 次{r.stream ? " · 流式" : ""}</span>
                  <span>IP：{r.ip}</span>
                  <span>供应商：{(r as unknown as { provider_id: string }).provider_id ?? "—"}</span>
                  <span className="sm:col-span-2">
                    <Button variant="ghost" className="!px-2 !py-1 text-xs !text-err" onClick={async () => {
                      if (!(await confirm("删除这条用量日志？"))) return;
                      try { await adminAction("delete_usage_log", { id: r.id }); toast("已删除"); loadUsage(); } catch (e) { toast((e as Error).message, "err"); }
                    }}>删除该条</Button>
                  </span>
                </div>
              )} />
            </>
          )}
        </Card>
      )}

      {tab === "audit" && canAudit && (
        <Card className="p-4 sm:p-5 flex flex-col gap-3.5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-ink">审计日志</h3>
              <p className="mt-0.5 text-xs text-muted">记录后台敏感操作，哈希链可校验完整性；仅展示保留期内的日志（30–180 天，默认 30 天）。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" onClick={loadAudit}><RefreshCw size={14} />刷新</Button>
              <Button variant="ghost" onClick={verifyChain}><ShieldCheck size={14} />校验链完整性</Button>
              <Button variant="ghost" className="!text-err" onClick={async () => {
                if (!(await confirm("清空全部审计日志？此操作不可恢复（哈希链将重新从 GENESIS 开始）。"))) return;
                try { await adminAction("clear_audit_logs", {}); toast("已清空"); loadAudit(); } catch (e) { toast((e as Error).message, "err"); }
              }}><Trash2 size={14} />清空全部</Button>
            </div>
          </div>

          {audit === null ? (
            <div className="flex flex-col gap-2">{[...Array(8)].map((_, i) => <div key={i} className="skeleton h-9" />)}</div>
          ) : (
            <DataTable cols={auditCols} rows={audit} page={20} expand={(r) => <pre className="max-h-40 overflow-auto text-xs">{JSON.stringify(JSON.parse(r.meta ?? "{}"), null, 2)}</pre>} />
          )}
        </Card>
      )}

      {confirmEl}
    </div>
  );
}
