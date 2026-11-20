import { useEffect, useState } from "react";
import { CalendarCheck, Play, RefreshCw } from "lucide-react";
import { adminAction } from "../lib/api";
import { Button, Card, EmptyState, useToast } from "../components/ui";
import { cn } from "../lib/utils";

type CheckinChannel = { type: string; label: string; action: string };
type CheckinProvider = {
  id: string;
  name: string;
  slug: string;
  type: string;
  label: string;
  action: string;
  enabled: boolean;
  status: string;
  accounts: number;
};

/** 签到任务面板：渠道注册表 + 开关 + 手动触发（数据来自 checkin_status，仅超级管理员可见） */
export default function CheckinTasks() {
  const [providers, setProviders] = useState<CheckinProvider[] | null>(null);
  const [channels, setChannels] = useState<CheckinChannel[]>([]);
  const [busy, setBusy] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await adminAction<{ channels: CheckinChannel[]; providers: CheckinProvider[] }>("checkin_status");
      setChannels(r.channels || []);
      setProviders(r.providers || []);
    } catch (e) {
      if (!silent) toast((e as Error).message, "err");
      setProviders([]);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const toggle = async (type: string, enabled: boolean, label: string) => {
    setBusy(`toggle-${type}`);
    try {
      await adminAction("set_checkin", { type, enabled });
      toast(`${enabled ? "已开启" : "已关闭"}${label}自动任务`, "ok");
      await load(true);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy("");
    }
  };

  const runNow = async (type: string, name: string, action: string) => {
    setBusy(`run-${type}`);
    try {
      const r = await adminAction<{ result?: { channels?: Array<{ accounts?: Array<{ ok: boolean; message?: string }> }> } }>("codebuddy_checkin", { type });
      const accounts = (r.result?.channels || []).flatMap((ch) => ch.accounts || []);
      const okN = accounts.filter((a) => a.ok).length;
      if (accounts.length === 0) toast(`${name}：暂无可执行${action}的账号`, "err");
      else if (okN === accounts.length) toast(`${name} ${action}：${okN}/${accounts.length} 全部成功`, "ok");
      else toast(`${name} ${action}：成功 ${okN}/${accounts.length}，${accounts.find((a) => !a.ok)?.message || "存在失败"}`, okN > 0 ? "ok" : "err");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy("");
    }
  };

  // 按渠道类型聚合（同一类型可能有多个 provider，如 codebuddy 国内/国际）
  const byType = new Map<string, CheckinProvider[]>();
  for (const p of providers || []) {
    const arr = byType.get(p.type) || [];
    arr.push(p);
    byType.set(p.type, arr);
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <CalendarCheck size={18} />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink">签到任务</h2>
              <p className="mt-0.5 text-xs text-muted">
                每日 09:00 后全站首次访问时自动执行一次（当日去重）；也可在此手动立即执行。开关按渠道类型全局生效。
              </p>
            </div>
          </div>
          <Button variant="soft" className="h-9" onClick={() => load()} disabled={loading}>
            <RefreshCw size={14} className={cn(loading && "animate-spin")} />
            {loading ? "刷新中…" : "刷新"}
          </Button>
        </div>
      </Card>

      {providers === null ? (
        <Card className="p-6">
          <div className="skeleton h-20 rounded-xl2" />
        </Card>
      ) : byType.size === 0 ? (
        <Card>
          <EmptyState icon={<CalendarCheck size={30} />} title="暂无支持签到的渠道" hint="接入 CodeBuddy / ZCode / Qoder 等 OAuth 渠道后，这里会出现对应的定时签到任务。" />
        </Card>
      ) : (
        [...byType.entries()].map(([type, provs]) => {
          const meta = channels.find((ch) => ch.type === type);
          const enabled = provs[0]?.enabled ?? true;
          const label = meta?.label || type;
          const action = meta?.action || "签到";
          const totalAccounts = provs.reduce((n, p) => n + p.accounts, 0);
          return (
            <Card key={type} className="p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-ink">{label}每日{action}</h3>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-medium",
                        enabled ? "bg-emerald-500/10 text-emerald-500" : "bg-zinc-500/10 text-zinc-400"
                      )}
                    >
                      {enabled ? "已开启" : "已关闭"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {provs.map((p) => `${p.name}（${p.accounts} 个账号${p.status === "disabled" ? " · 渠道停用" : ""}）`).join("、") || "无账号"}
                    {totalAccounts === 0 && " —— 先到「供应商」页给渠道授权账号"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 cursor-pointer accent-[var(--brand)]"
                      checked={enabled}
                      disabled={busy === `toggle-${type}`}
                      onChange={(e) => toggle(type, e.target.checked, label)}
                    />
                    自动执行
                  </label>
                  <Button variant="soft" className="h-8" disabled={busy === `run-${type}`} onClick={() => runNow(type, label, action)}>
                    <Play size={12} />
                    {busy === `run-${type}` ? `${action}中…` : `立即${action}`}
                  </Button>
                </div>
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}
