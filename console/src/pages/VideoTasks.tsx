import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock, Copy, ExternalLink, Film, RefreshCw, Trash2, Users, XCircle } from "lucide-react";
import { api, type Me } from "../lib/api";
import { Button, Card, EmptyState, useConfirm, useToast } from "../components/ui";
import { cn, fmtTime } from "../lib/utils";

type VideoTaskRow = {
  id: string;
  model: string;
  upstream_model: string;
  status: "queued" | "in_progress" | "completed" | "failed" | "cancelled";
  progress: number;
  url: string | null;
  error: string | null;
  seconds: number | null;
  size: string | null;
  user_id: string;
  user_email: string | null;
  created_at: number;
  updated_at: number;
};

type TasksResp = { ok: boolean; scope: "all" | "own"; role: string; refreshed_at: number; tasks: VideoTaskRow[] };

const POLL_MS = 60_000;

const STATUS_TEXT: Record<string, string> = {
  queued: "队列中",
  in_progress: "生成中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "completed"
      ? "bg-emerald-500/10 text-emerald-500"
      : status === "failed" || status === "cancelled"
      ? "bg-red-500/10 text-red-500"
      : status === "in_progress"
      ? "bg-amber-500/10 text-amber-500"
      : "bg-zinc-500/10 text-zinc-400";
  const Icon = status === "completed" ? CheckCircle2 : status === "failed" || status === "cancelled" ? XCircle : Clock;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium", cls)}>
      <Icon size={10} />
      {STATUS_TEXT[status] ?? status}
    </span>
  );
}

function Progress({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(value || 0)));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-line/70">
        <div
          className={cn("h-full rounded-full", pct >= 100 ? "bg-emerald-500" : pct > 0 ? "bg-brand" : "bg-muted/40")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-9 text-right font-mono text-[10px] text-muted">{pct}%</span>
    </div>
  );
}

export default function VideoTasks({ me }: { me: Me }) {
  const [data, setData] = useState<TasksResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);
  const [countdown, setCountdown] = useState(POLL_MS / 1000);
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const timer = useRef<number | null>(null);

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await api<TasksResp>("/api/video/tasks?limit=100");
      setData(r);
    } catch (e) {
      if (!silent) toast((e as Error).message, "err");
    } finally {
      if (!silent) setLoading(false);
      setCountdown(POLL_MS / 1000);
    }
  };

  useEffect(() => {
    load();
    // 自动轮询：页面隐藏时暂停，回到前台立即刷新一次
    const tick = window.setInterval(() => {
      if (!auto || document.hidden) return;
      setCountdown((n) => {
        if (n <= 1) {
          load(true);
          return POLL_MS / 1000;
        }
        return n - 1;
      });
    }, 1000);
    const onVisible = () => {
      if (!document.hidden && auto) load(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [auto]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label}已复制`);
    } catch {
      toast("复制失败，请手动选择", "err");
    }
  };

  const remove = async (row: VideoTaskRow) => {
    if (!(await confirm(`删除任务 ${row.id} 的记录？仅清理本地记录，不会取消上游任务。`))) return;
    try {
      await api(`/api/video/tasks/${row.id}`, "DELETE");
      toast("已删除");
      load();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  const tasks = data?.tasks ?? [];
  const isAdminView = data?.scope === "all";
  const running = tasks.filter((t) => t.status === "in_progress" || t.status === "queued").length;
  const done = tasks.filter((t) => t.status === "completed").length;
  const failed = tasks.filter((t) => t.status === "failed" || t.status === "cancelled").length;

  return (
    <div className="flex flex-col gap-4">
      {confirmEl}
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <Film size={18} />
            </div>
            <div>
              <h1 className="text-base font-bold text-ink">视频任务</h1>
              <p className="mt-0.5 text-xs text-muted">
                {isAdminView
                  ? "管理员视图：可查看全部用户发起的视频任务，并清理任意任务记录。"
                  : "仅显示你通过 API 发起的视频任务，生成完成后可直接播放或下载。"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium",
                isAdminView ? "bg-brand/10 text-brand" : "bg-surface2 text-muted"
              )}
            >
              {isAdminView ? <Users size={11} /> : <Film size={11} />}
              {isAdminView ? "全部任务" : "我的任务"}
            </span>
            <Button variant="soft" onClick={() => load()} disabled={loading}>
              <RefreshCw size={14} className={cn(loading && "animate-spin")} />
              {loading ? "刷新中…" : "刷新"}
            </Button>
            <Button
              variant={auto ? "soft" : "ghost"}
              onClick={() => setAuto((v) => !v)}
              title="每 60 秒自动刷新未完成任务（与状态站监控同频）"
              className="!px-2.5"
            >
              {auto ? `自动 ${countdown}s` : "已暂停"}
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted">
          <span>共 <b className="font-mono text-ink">{tasks.length}</b> 个</span>
          <span>进行中 <b className="font-mono text-ink">{running}</b></span>
          <span>已完成 <b className="font-mono text-emerald-500">{done}</b></span>
          <span>失败 <b className="font-mono text-red-500">{failed}</b></span>
          {data && <span className="ml-auto">上次刷新 {fmtTime(data.refreshed_at)}</span>}
        </div>
      </Card>

      {data === null ? (
        <Card className="p-6">
          <div className="skeleton h-24 rounded-xl2" />
        </Card>
      ) : tasks.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Film size={32} />}
            title="暂无视频任务"
            hint="调用 POST /v1/videos 创建任务后，这里会自动出现，并按 60 秒间隔轮询进度。"
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {tasks.map((t) => (
            <Card key={t.id} className="p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={t.status} />
                <span className="text-sm font-semibold text-ink">{t.model}</span>
                {isAdminView && (
                  <span className="rounded bg-surface2 px-1.5 py-0.5 text-[10px] text-muted">
                    {t.user_email ?? t.user_id.slice(0, 8)}
                  </span>
                )}
                {t.seconds ? <span className="rounded bg-surface2 px-1.5 py-0.5 text-[10px] text-muted">{t.seconds}s</span> : null}
                {t.size ? <span className="rounded bg-line/70 px-1.5 py-0.5 text-[10px] text-muted">{t.size}</span> : null}
                <span className="ml-auto flex items-center gap-1.5">
                  {t.url && (
                    <a
                      className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] text-brand hover:bg-brand/10"
                      href={t.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={11} /> 播放 / 下载
                    </a>
                  )}
                  <Button variant="ghost" className="!px-2 !py-1 text-[11px]" onClick={() => copy(t.id, "任务 ID")}>
                    <Copy size={11} className="mr-1" />ID
                  </Button>
                  <Button
                    variant="ghost"
                    className="!px-2 !py-1 text-[11px] !text-err"
                    onClick={() => remove(t)}
                  >
                    <Trash2 size={11} className="mr-1" />删除
                  </Button>
                </span>
              </div>

              <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
                <Progress value={t.progress} />
                <code className="text-[11px] font-mono text-muted">{t.id}</code>
                <span className="text-[10px] text-muted">创建 {fmtTime(t.created_at)}</span>
                {t.updated_at > t.created_at && <span className="text-[10px] text-muted">更新 {fmtTime(t.updated_at)}</span>}
              </div>

              {t.error && (
                <p className="mt-2 break-all text-[11px] text-err">{t.error}</p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
