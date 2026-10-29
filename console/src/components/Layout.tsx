import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Bell, Boxes, CircleUser, Coins, DatabaseBackup, Gauge, Gift, KeyRound, Layers, LogOut, Megaphone, Menu, Monitor, Moon, PanelLeftClose, PanelLeftOpen, ScrollText, Server, Settings as SettingsIcon, ShieldCheck, Sun, Users, X } from "lucide-react";
import { api, type Me, type SiteInfo } from "../lib/api";
import { getSeenAnnouncementIds, markAnnouncementsSeen } from "../lib/announcements";
import { cn, fmtMoney } from "../lib/utils";
import { Button, useToast } from "./ui";

const ALL_ROLES = ["user", "vip", "admin", "superadmin", "finance", "auditor"];

const NAV = [
  { to: "/dashboard", label: "仪表盘", icon: Gauge, roles: ALL_ROLES },
  { to: "/dashboard/keys", label: "API Keys", icon: KeyRound, roles: ALL_ROLES },
  { to: "/dashboard/providers", label: "供应商", icon: Server, roles: ["superadmin"] },
  { to: "/dashboard/models", label: "模型池", icon: Layers, roles: ALL_ROLES },
  { to: "/dashboard/pricing", label: "定价", icon: Coins, roles: ["superadmin"] },
  { to: "/dashboard/users", label: "用户与组织", icon: Users, roles: ["superadmin", "admin"] },
  { to: "/dashboard/invite", label: "邀请", icon: Gift, roles: ALL_ROLES },
  { to: "/dashboard/announcements", label: "公告", icon: Megaphone, roles: ["superadmin"] },
  { to: "/dashboard/usage", label: "用量日志", icon: ScrollText, roles: ALL_ROLES },
  { to: "/dashboard/audit", label: "审计日志", icon: ShieldCheck, roles: ["superadmin", "auditor"] },
  { to: "/dashboard/profile", label: "个人主页", icon: CircleUser, roles: ALL_ROLES },
  { to: "/dashboard/backup", label: "数据备份", icon: DatabaseBackup, roles: ["superadmin"] },
  { to: "/dashboard/settings", label: "设置", icon: SettingsIcon, roles: ["superadmin"] },
];

export function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorage.getItem("gw-theme") as "light" | "dark") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("gw-theme", theme);
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")), system: () => { localStorage.removeItem("gw-theme"); setTheme(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); } };
}

type Ann = { id: string; title: string; content: string; popup: number; created_at: number };
export default function Layout({ me, site, onLogout }: { me: Me; site: SiteInfo | null; onLogout: () => void }) {
  const [drawer, setDrawer] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [anns, setAnns] = useState<Ann[]>([]);
  // 公告被"下次再说/不再提示"后重新过滤列表；打开铃铛/看过弹窗后重新计算红点
  const [annTick, setAnnTick] = useState(0);
  useEffect(() => {
    const h = () => setAnnTick((t) => t + 1);
    window.addEventListener("gw:ann-changed", h);
    return () => window.removeEventListener("gw:ann-changed", h);
  }, []);
  useEffect(() => { api<{ announcements: Ann[] }>("/api/announcements").then((d) => setAnns(d.announcements)).catch(() => setAnns([])); }, []);
  const meKey = me.user.id;
  void annTick; // 事件触发时强制重算
  const visibleAnns = anns.filter((a) => !localStorage.getItem(`ann-never-${a.id}-${meKey}`) && !sessionStorage.getItem(`ann-later-${a.id}-${meKey}`));
  // 红点只统计还没看过的公告；打开铃铛或弹窗展示后会写入已读，不再显示 1
  const seenAnnIds = getSeenAnnouncementIds(meKey);
  const bellCount = anns.filter((a) => !seenAnnIds.has(a.id)).length;
  const toggleBell = () => setBellOpen((v) => !v);
  // 铃铛打开即视为看过列表（含晚到的公告数据），写入已读后红点消失
  useEffect(() => {
    if (!bellOpen || anns.length === 0) return;
    markAnnouncementsSeen(meKey, anns.map((a) => a.id));
    setAnnTick((t) => t + 1);
  }, [bellOpen, anns, meKey]);
  const { theme, toggle } = useTheme();
  const loc = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  useEffect(() => setDrawer(false), [loc.pathname]);

  // 顶栏标题按最长路径匹配，避免 /dashboard 前缀把子页面全显示成"仪表盘"
  const activeLabel =
    NAV.filter((n) => n.roles.includes(me.user.role))
      .filter((n) => loc.pathname === n.to || loc.pathname.startsWith(`${n.to}/`))
      .sort((a, b) => b.to.length - a.to.length)[0]?.label ?? "仪表盘";

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("gw-sidebar-collapsed") === "1";
    } catch {
      return false;
    }
  });

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("gw-sidebar-collapsed", next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  const renderNav = (isCollapsed: boolean) => (
    <nav className={cn("flex flex-col gap-1 transition-all", isCollapsed ? "px-2" : "px-3")} aria-label="主导航">
      {NAV.filter((n) => n.roles.includes(me.user.role)).map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/dashboard"}
          title={isCollapsed ? label : undefined}
          className={({ isActive }) =>
            cn(
              "relative flex items-center rounded-lg text-[13px] font-medium transition-all",
              isCollapsed ? "justify-center py-2.5 px-0" : "gap-2.5 px-3 py-2",
              isActive ? "bg-brand/10 text-brand font-semibold" : "text-sidebar-ink hover:bg-surface2 hover:text-ink"
            )
          }
        >
          {({ isActive }) => (
            <>
              {isActive && (
                <span
                  className={cn(
                    "absolute top-1/2 -translate-y-1/2 rounded-full bg-brand",
                    isCollapsed ? "left-0.5 h-4 w-[2.5px]" : "left-0 h-5 w-[3px]"
                  )}
                  aria-hidden
                />
              )}
              <Icon size={isCollapsed ? 18 : 16} className="shrink-0" />
              {!isCollapsed && <span className="truncate">{label}</span>}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="flex h-screen">
      {/* 桌面侧边栏（支持平滑收缩/展开） */}
      <aside
        style={{
          width: collapsed ? 68 : 224,
          minWidth: collapsed ? 68 : 224,
          maxWidth: collapsed ? 68 : 224,
        }}
        className="hidden shrink-0 flex-col border-r border-line bg-sidebar transition-all duration-200 ease-in-out overflow-x-hidden lg:flex"
      >
        <Link
          to="/"
          className={cn(
            "flex items-center transition-all",
            collapsed ? "justify-center py-4 px-0" : "gap-2.5 px-4 py-4"
          )}
          title={`返回官网 (${site?.siteName ?? "Relay"})`}
        >
          {site?.siteLogoUrl ? (
            <img src={site.siteLogoUrl} alt="logo" className="h-7 w-7 rounded-lg object-contain shrink-0" />
          ) : (
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white">
              E
            </div>
          )}
          {!collapsed && (
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[13px] font-semibold text-ink">{site?.siteName ?? "Relay"}</div>
              <div className="text-[10px] text-muted">控制台</div>
            </div>
          )}
        </Link>

        <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
          {renderNav(collapsed)}
        </div>

        {/* 底部折叠切换与用户信息 */}
        <div className={cn("mt-auto border-t border-line transition-all", collapsed ? "p-2" : "px-3 py-2.5")}>
          <button
            type="button"
            onClick={toggleCollapsed}
            className={cn(
              "flex items-center rounded-lg text-xs text-muted transition-colors hover:bg-surface2 hover:text-ink",
              collapsed ? "h-9 w-full justify-center" : "h-8 w-full gap-2 px-2.5"
            )}
            title={collapsed ? "展开侧边栏" : "收缩侧边栏"}
            aria-label={collapsed ? "展开侧边栏" : "收缩侧边栏"}
          >
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={15} />}
            {!collapsed && <span>收缩侧边栏</span>}
          </button>
          {!collapsed && (
            <div className="mt-2 space-y-1 px-2 text-[11px] text-muted">
              <div className="flex items-center justify-between gap-1">
                <span className="truncate">{me.user.email}</span>
                <span className="shrink-0 text-[10px] rounded bg-brand/10 text-brand px-1.5 py-0.2 font-medium">
                  {me.user.role === "superadmin" ? "超级管理" : me.user.role === "vip" ? "VIP" : me.user.role === "admin" ? "Admin" : "普通用户"}
                </span>
              </div>
              <div className="font-medium text-ink flex items-center justify-between">
                <span>{me.unlimited ? "∞ 无限额度" : fmtMoney(me.balance.available, me.balance.currency)}</span>
                {me.unlimited && (
                  <span className="text-[10px] text-muted font-normal">铸币方</span>
                )}
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* 移动端抽屉 */}
      {drawer && (
        <div className="anim-fade fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden" onClick={() => setDrawer(false)}>
          <aside className="h-full w-60 bg-sidebar p-3 shadow-pop" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between px-2"><span className="text-sm font-semibold">{site?.siteName ?? "Relay"}</span>
              <button onClick={() => setDrawer(false)} aria-label="关闭菜单" className="p-1 text-muted"><X size={18} /></button></div>
            {renderNav(false)}
            <Button variant="ghost" className="mt-4 w-full" onClick={onLogout}><LogOut size={14} />退出登录</Button>
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶部栏 */}
        <header className="flex h-14 items-center gap-2.5 border-b border-line bg-surface px-4 lg:px-6">
          <button className="rounded-lg p-1.5 text-muted hover:bg-surface2 lg:hidden" onClick={() => setDrawer(true)} aria-label="打开菜单"><Menu size={18} /></button>
          <button
            type="button"
            onClick={toggleCollapsed}
            className="hidden rounded-lg p-1.5 text-muted hover:bg-surface2 hover:text-ink lg:flex"
            title={collapsed ? "展开侧边栏" : "收缩侧边栏"}
            aria-label={collapsed ? "展开侧边栏" : "收缩侧边栏"}
          >
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
          <div className="text-sm font-medium">{activeLabel}</div>
          <div className="flex-1" />
          <span className="hidden text-xs text-muted sm:block">
            {me.unlimited
              ? "∞ 无限额度（铸币方）"
              : `${fmtMoney(me.balance.available, me.balance.currency)}（冻结 ${me.balance.frozen.toFixed(4)}）`}
          </span>
          <span className="rounded-full bg-brand/10 px-2.5 py-1 text-[11px] font-medium text-brand">{me.user.role}</span>
          <button className="rounded-lg p-2 text-muted hover:bg-surface2 hover:text-ink" onClick={toggle} aria-label={theme === "dark" ? "切换浅色模式" : "切换深色模式"}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button className="hidden rounded-lg p-2 text-muted hover:bg-surface2 hover:text-ink sm:block" onClick={followSystem} aria-label="跟随系统主题">
            <Monitor size={16} />
          </button>
          <button className="relative rounded-lg p-2 text-muted hover:bg-surface2 hover:text-ink" onClick={toggleBell} aria-label="站内通知">
            <Bell size={16} />
            {bellCount > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-err px-1 text-[10px] font-medium text-white">{bellCount}</span>}
          </button>
          <button className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-xs font-semibold text-brand" title="个人主页"
            onClick={() => navigate("/dashboard/profile")} aria-label="个人主页">
            {me.avatarUrl ? <img src={me.avatarUrl} alt="头像" className="h-full w-full object-cover" /> : me.user.email[0]?.toUpperCase()}
          </button>
          <Button variant="ghost" className="hidden !px-2.5 lg:inline-flex" onClick={onLogout}><LogOut size={14} />退出</Button>
        </header>

        {bellOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setBellOpen(false)} />
            <div className="anim-pop absolute right-4 top-16 z-40 w-80 rounded-xl2 border border-line bg-surface shadow-pop lg:right-6">
              <div className="border-b border-line px-4 py-3 text-sm font-semibold">站内通知</div>
              <div className="max-h-80 overflow-y-auto">
                {visibleAnns.length === 0 ? <p className="py-8 text-center text-xs text-muted">暂无通知</p> : visibleAnns.map((a) => (
                  <div key={a.id} className="border-b border-line/60 px-4 py-3 last:border-0">
                    <div className="text-[13px] font-medium">{a.title}</div>
                    <p className="mt-1 line-clamp-3 text-xs text-muted">{a.content}</p>
                    <div className="mt-1 text-right text-[10px] text-muted">{new Date(a.created_at * 1000).toLocaleString("zh-CN")}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
        <main className="mx-auto w-full max-w-[1280px] flex-1 overflow-auto p-4 sm:p-6">
          <Outlet context={{ me }} />
        </main>
      </div>
    </div>
  );
}
function followSystem() {
  localStorage.removeItem("gw-theme");
  document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  location.reload();
}
