import { useState } from "react";
import { CalendarClock, CalendarCheck, Film } from "lucide-react";
import type { Me } from "../lib/api";
import { Card } from "../components/ui";
import { cn } from "../lib/utils";
import VideoTasks from "./VideoTasks";
import CheckinTasks from "./CheckinTasks";

/**
 * 定时任务：后台侧边栏聚合页
 *  - 视频任务：原有视频生成任务列表（内嵌模式，去大标题）
 *  - 签到任务：OAuth 渠道每日领额度包/签到的开关与手动触发（仅超级管理员）
 */
export default function ScheduledTasks({ me }: { me: Me }) {
  const isSuperadmin = me.user.role === "superadmin";
  const [tab, setTab] = useState<"videos" | "checkin">("videos");

  const tabs: { key: "videos" | "checkin"; label: string; icon: typeof Film }[] = [
    { key: "videos", label: "视频任务", icon: Film },
    ...(isSuperadmin ? [{ key: "checkin" as const, label: "签到任务", icon: CalendarCheck }] : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
              <CalendarClock size={18} />
            </div>
            <div>
              <h1 className="text-base font-bold text-ink">定时任务</h1>
              <p className="mt-0.5 text-xs text-muted">视频生成任务与渠道签到任务的统一入口；自动执行与手动触发都在这里。</p>
            </div>
          </div>
          <div className="flex w-full gap-1 overflow-x-auto rounded-lg bg-surface2 p-0.5 sm:w-fit" role="tablist">
            {tabs.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-4 py-1.5 text-xs font-medium transition-colors",
                  tab === key ? "bg-surface text-brand shadow-sm" : "text-muted hover:text-ink"
                )}
              >
                <Icon size={13} />
                {label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {tab === "videos" && <VideoTasks me={me} embedded />}
      {tab === "checkin" && isSuperadmin && <CheckinTasks />}
    </div>
  );
}
