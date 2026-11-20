import { useState } from "react";
import type { Me } from "../lib/api";
import VideoTasks from "./VideoTasks";
import CheckinTasks from "./CheckinTasks";

/**
 * 定时任务：后台侧边栏聚合页（选项卡形态与网站设置一致：顶部一条选项卡栏，无页头卡片）
 *  - 视频任务：视频生成任务列表
 *  - 签到任务：OAuth 渠道每日领额度包/签到的开关与手动触发（仅超级管理员）
 */
export default function ScheduledTasks({ me }: { me: Me }) {
  const isSuperadmin = me.user.role === "superadmin";
  const [tab, setTab] = useState<"videos" | "checkin">("videos");

  const tabs: Array<["videos" | "checkin", string]> = [
    ["videos", "视频任务"],
    ...(isSuperadmin ? ([["checkin", "签到任务"]] as Array<["videos" | "checkin", string]>) : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex w-full gap-1 overflow-x-auto rounded-lg bg-surface2 p-0.5 sm:w-fit" role="tablist">
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`rounded-md px-4 py-1.5 text-xs font-medium transition-colors ${tab === k ? "bg-surface text-brand shadow-sm" : "text-muted hover:text-ink"}`}>{l}</button>
        ))}
      </div>

      {tab === "videos" && <VideoTasks me={me} />}
      {tab === "checkin" && isSuperadmin && <CheckinTasks />}
    </div>
  );
}
