import { useEffect, useState } from "react";
import { Check, Coins, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useOutletContext } from "react-router-dom";
import { adminAction, type Me, type UserRow, type Flag, type Appeal } from "../lib/api";
import { Button, Card, DataTable, Dialog, Field, Input, Select, StatusTag, useConfirm, useToast, type Col } from "../components/ui";
import { fmtTime } from "../lib/utils";

const ROLE_MAP: Record<string, { label: string; color: string; desc: string; lvl: number }> = {
  superadmin: { label: "超级管理员", color: "bg-red-500/10 text-red-500 font-bold border border-red-500/30", desc: "最高站长权限，全站管理，额度无限真实扣费", lvl: 100 },
  admin: { label: "管理员", color: "bg-brand/10 text-brand font-semibold border border-brand/20", desc: "可调用全量模型，可管理下级用户并转账充值", lvl: 50 },
  finance: { label: "财务人员", color: "bg-purple-500/10 text-purple-400 border border-purple-500/20", desc: "财务与账单核对权限", lvl: 30 },
  auditor: { label: "审计员", color: "bg-blue-500/10 text-blue-400 border border-blue-500/20", desc: "审计日志只读权限", lvl: 20 },
  vip: { label: "VIP 账号", color: "bg-amber-500/10 text-amber-500 font-semibold border border-amber-500/20", desc: "余额大于 0 自动获得，解锁全量付费模型并按量扣费", lvl: 10 },
  user: { label: "普通用户", color: "bg-zinc-500/10 text-zinc-400 border border-zinc-500/20", desc: "余额归零状态，仅限免费模型池，免充值不扣费", lvl: 1 },
};

type RedeemCodeItem = {
  id: string;
  code: string;
  amount: number;
  currency: string;
  autoVip: boolean;
  status: "unused" | "used" | "revoked";
  usedByEmail?: string | null;
  usedAt?: number | null;
  createdAt: number;
  note?: string | null;
};

export default function Users() {
  const { me } = useOutletContext<{ me: Me }>();
  const isSuperadmin = me?.user.role === "superadmin";

  const [tab, setTab] = useState<"users" | "codes" | "flags" | "appeals">("users");
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [codes, setCodes] = useState<RedeemCodeItem[] | null>(null);
  const [flags, setFlags] = useState<Flag[] | null>(null);
  const [appeals, setAppeals] = useState<Appeal[] | null>(null);
  const [invite, setInvite] = useState<{ open: boolean; email: string; role: string }>({ open: false, email: "", role: "member" });
  const [roleDlg, setRoleDlg] = useState<{ open: boolean; user: UserRow | null; role: string }>({ open: false, user: null, role: "user" });
  const [topupDlg, setTopupDlg] = useState<{ open: boolean; user: UserRow | null; amount: string; memo: string; password: string }>({
    open: false,
    user: null,
    amount: "50",
    memo: "管理员转账充值",
    password: "",
  });
  const [genDlg, setGenDlg] = useState({ open: false, amount: "50", count: "10", autoVip: true, note: "", password: "" });
  const [batchResult, setBatchResult] = useState<string[] | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const { confirm, confirmEl } = useConfirm();
  const toast = useToast();

  const loadUsers = () => adminAction<{ users: UserRow[] }>("list_users").then((d) => setUsers(d.users)).catch((e) => toast(e.message, "err"));
  const loadCodes = () => adminAction<{ codes: RedeemCodeItem[] }>("list_redeem_codes").then((d) => setCodes(d.codes)).catch(() => setCodes([]));
  const loadFlags = () => adminAction<{ flags: Flag[] }>("flags_queue").then((d) => setFlags(d.flags)).catch(() => setFlags([]));
  const loadAppeals = () => adminAction<{ appeals: Appeal[] }>("appeals_list").then((d) => setAppeals(d.appeals)).catch(() => setAppeals([]));

  useEffect(() => { loadUsers(); }, []);

  const changeRole = async () => {
    if (!roleDlg.user) return;
    try {
      await adminAction("set_role", { userId: roleDlg.user.id, role: roleDlg.role });
      toast(`已将「${roleDlg.user.email}」角色更新为 ${ROLE_MAP[roleDlg.role]?.label || roleDlg.role}`);
      setRoleDlg({ open: false, user: null, role: "user" });
      loadUsers();
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const openTopup = (u: UserRow) => {
    setTopupDlg({
      open: true,
      user: u,
      amount: "50",
      memo: `管理员转账充值`,
      password: "",
    });
  };

  const submitTopup = async () => {
    if (!topupDlg.user) return;
    const amt = parseFloat(topupDlg.amount);
    if (isNaN(amt) || amt <= 0) return toast("请输入大于 0 的充值金额", "err");
    if (!topupDlg.password.trim()) return toast("请输入管理员密码确认充值操作", "err");
    try {
      await adminAction("topup", {
        scope: `user:${topupDlg.user.id}`,
        amount: amt,
        memo: topupDlg.memo.trim() || undefined,
        password: topupDlg.password.trim(),
      });
      toast(`转账充值成功！已为「${topupDlg.user.email}」充值 ¥${amt.toFixed(2)}${!isSuperadmin ? "（已扣除您等额余额）" : ""}`);
      setTopupDlg({ open: false, user: null, amount: "50", memo: "", password: "" });
      loadUsers();
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const deleteUser = async (u: UserRow) => {
    if (!(await confirm(`危险操作：确认永久删除用户「${u.email}」？该用户的个人账户、数据与全部 API Key 将被物理销毁且无法恢复！`))) return;
    try {
      await adminAction("delete_user", { userId: u.id });
      toast(`已彻底删除用户「${u.email}」`);
      loadUsers();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  const copyStr = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCode(text);
      toast(`已复制 ${label}`);
      setTimeout(() => setCopiedCode(null), 1800);
    } catch {
      toast("复制失败，请手动选择复制", "err");
    }
  };

  const generateCodes = async () => {
    const amt = parseFloat(genDlg.amount);
    const cnt = parseInt(genDlg.count, 10);
    if (isNaN(amt) || amt <= 0) return toast("卡密面额必须大于 0", "err");
    if (isNaN(cnt) || cnt <= 0 || cnt > 100) return toast("每次生成数量需在 1 到 100 张之间", "err");
    if (!genDlg.password.trim()) return toast("请输入管理员密码确认操作", "err");
    try {
      const res = await adminAction<{ codes: RedeemCodeItem[]; count: number }>("generate_redeem_codes", {
        amount: amt,
        count: cnt,
        autoVip: genDlg.autoVip,
        note: genDlg.note.trim() || undefined,
        password: genDlg.password.trim(),
      });
      toast(`已成功生成 ${res.count || cnt} 张卡密！`);
      setBatchResult((res.codes || []).map((c) => c.code));
      setGenDlg({ open: false, amount: "50", count: "10", autoVip: true, note: "", password: "" });
      loadCodes();
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const deleteCode = async (c: RedeemCodeItem) => {
    if (!(await confirm(`确认删除/作废卡密「${c.code}」？`))) return;
    try {
      await adminAction("delete_redeem_code", { codeId: c.id });
      toast("卡密已删除");
      loadCodes();
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const userCols: Col<UserRow>[] = [
    { key: "email", label: "邮箱", sortVal: (r) => r.email, render: (r) => <span className="font-medium text-ink">{r.email}</span> },
    { key: "id", label: "用户 ID", render: (r) => <code className="text-xs text-muted font-mono">{r.id.slice(0, 8)}…</code> },
    {
      key: "role",
      label: "账号等级",
      render: (r) => {
        const item = ROLE_MAP[r.role] || { label: r.role, color: "bg-surface2 text-muted", desc: "" };
        const actorLvl = ROLE_MAP[me?.user.role ?? "user"]?.lvl ?? 1;
        const targetLvl = ROLE_MAP[r.role]?.lvl ?? 1;
        const canEditRole = isSuperadmin || (actorLvl > targetLvl && r.id !== me?.user.id);

        return (
          <button
            type="button"
            disabled={!canEditRole}
            onClick={() => canEditRole && setRoleDlg({ open: true, user: r, role: r.role })}
            className={`rounded-full px-2.5 py-0.5 text-[11px] transition-all ${canEditRole ? "hover:scale-105 cursor-pointer" : "cursor-default opacity-85"} ${item.color}`}
            title={canEditRole ? "点击修改用户角色等级与权限" : "同级或高权限账号不可直接修改角色"}
          >
            {item.label}
          </button>
        );
      },
    },
    {
      key: "balance",
      label: "可用余额",
      sortVal: (r) => r.balance ?? 0,
      render: (r) => (
        <span className="font-mono text-xs font-semibold text-emerald-500">
          ¥{(r.balance ?? 0).toFixed(2)}
        </span>
      ),
    },
    { key: "status", label: "状态", render: (r) => <StatusTag value={r.status} /> },
    { key: "created", label: "注册时间", sortVal: (r) => r.created_at, render: (r) => <span className="text-xs text-muted">{fmtTime(r.created_at)}</span> },
    { key: "ops", label: "操作", render: (r) => {
      const actorLvl = ROLE_MAP[me?.user.role ?? "user"]?.lvl ?? 1;
      const targetLvl = ROLE_MAP[r.role]?.lvl ?? 1;
      const isSelf = r.id === me?.user.id;
      const canManage = isSuperadmin || (actorLvl > targetLvl && !isSelf);

      if (!canManage) {
        return <span className="text-xs text-muted/60">—</span>;
      }

      return (
        <span className="flex items-center gap-1.5 shrink-0">
          <Button variant="soft" className="!h-7 !px-2 text-xs !text-emerald-500 font-medium" onClick={() => openTopup(r)}>
            <Coins size={12} className="mr-0.5" />充值
          </Button>
          <Button variant="soft" className="!h-7 !px-2 text-xs" onClick={() => setRoleDlg({ open: true, user: r, role: r.role })}>调整角色</Button>
          {r.status === "active"
            ? <Button variant="ghost" className="!h-7 !px-2 text-xs !text-err" onClick={async (e) => { e.stopPropagation(); if (await confirm(`封禁 ${r.email}？将同时撤销其全部 Key 并强制下线。`)) { await adminAction("ban_user", { userId: r.id }); toast("已封禁"); loadUsers(); } }}>封禁</Button>
            : <Button variant="ghost" className="!h-7 !px-2 text-xs" onClick={async (e) => { e.stopPropagation(); await adminAction("unban_user", { userId: r.id }); toast("已解封"); loadUsers(); }}>解封</Button>}
          <Button variant="ghost" className="!h-7 !px-1.5 text-xs !text-err" onClick={() => deleteUser(r)} title="物理删除该用户"><Trash2 size={12} /></Button>
        </span>
      );
    } },
  ];

  const codeCols: Col<RedeemCodeItem>[] = [
    {
      key: "code",
      label: "卡密代码",
      render: (r) => (
        <button
          type="button"
          onClick={() => copyStr(r.code, "卡密代码")}
          className="flex items-center gap-1.5 font-mono text-xs font-bold text-ink hover:text-brand transition-colors"
          title="点击一键复制卡密"
        >
          <span>{r.code}</span>
          {copiedCode === r.code ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} className="text-muted/60" />}
        </button>
      ),
    },
    {
      key: "amount",
      label: "充值面额",
      sortVal: (r) => r.amount,
      render: (r) => <span className="font-mono text-xs font-bold text-emerald-500">¥{r.amount.toFixed(2)}</span>,
    },
    {
      key: "autoVip",
      label: "权益属性",
      render: (r) => <span className="rounded bg-amber-500/10 text-amber-500 text-[10px] font-semibold px-2 py-0.5">余额大于0自动VIP</span>,
    },
    {
      key: "status",
      label: "状态",
      render: (r) => (
        r.status === "unused" ? (
          <span className="rounded bg-emerald-500/10 text-emerald-500 text-[11px] font-semibold px-2 py-0.5">未兑换</span>
        ) : r.status === "used" ? (
          <span className="rounded bg-zinc-500/10 text-zinc-400 text-[11px] px-2 py-0.5">已使用</span>
        ) : (
          <span className="rounded bg-red-500/10 text-red-500 text-[11px] px-2 py-0.5">已作废</span>
        )
      ),
    },
    {
      key: "usedBy",
      label: "兑换记录",
      render: (r) => r.usedByEmail ? (
        <div className="flex flex-col text-[11px]">
          <span className="text-ink font-medium">{r.usedByEmail}</span>
          <span className="text-muted">{r.usedAt ? fmtTime(r.usedAt) : ""}</span>
        </div>
      ) : <span className="text-xs text-muted">—</span>,
    },
    {
      key: "note",
      label: "生成备注",
      render: (r) => <span className="text-xs text-muted truncate max-w-[140px]">{r.note || "—"}</span>,
    },
    {
      key: "created",
      label: "生成时间",
      sortVal: (r) => r.createdAt,
      render: (r) => <span className="text-xs text-muted">{fmtTime(r.createdAt)}</span>,
    },
    {
      key: "ops",
      label: "操作",
      render: (r) => (
        <span className="flex items-center gap-1.5 shrink-0">
          <Button variant="soft" className="!h-7 !px-2 text-xs" onClick={() => copyStr(r.code, "卡密代码")}>复制</Button>
          <Button variant="ghost" className="!h-7 !px-1.5 text-xs !text-err" onClick={() => deleteCode(r)} title="删除/作废卡密"><Trash2 size={12} /></Button>
        </span>
      ),
    },
  ];

  const TABS = isSuperadmin
    ? ([["users", "用户与权限"], ["codes", "卡密管理"], ["flags", "内容复核队列"], ["appeals", "申诉"]] as const)
    : ([["users", "用户与权限"], ["flags", "内容复核队列"], ["appeals", "申诉"]] as const);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex w-full gap-1 overflow-x-auto rounded-lg bg-surface2 p-0.5 sm:w-fit" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => { setTab(k as any); (k === "flags" ? loadFlags : k === "appeals" ? loadAppeals : k === "codes" ? loadCodes : loadUsers)(); }}
            className={`rounded-md px-4 py-1.5 text-xs font-medium transition-colors ${tab === k ? "bg-surface text-brand shadow-sm" : "text-muted hover:text-ink"}`}>{l}</button>
        ))}
      </div>

      {tab === "users" && (
        <Card className="p-4 sm:p-5 flex flex-col gap-3.5">
          {/* 用户等级与权限说明条 */}
          <div className="rounded-xl border border-line bg-surface2/50 p-3 text-xs text-muted space-y-1.5">
            <div className="font-semibold text-ink text-[13px] mb-1">👑 权限继承与动态会员等级规则（superadmin &gt; admin &gt; vip &gt; user）：</div>
            <div className="flex items-start gap-2">
              <span className="shrink-0 rounded bg-red-500/10 text-red-500 px-1.5 py-0.5 text-[10px] font-bold">超级管理员 (superadmin)</span>
              <span>最高站长权限，独占全站设置与渠道治理；<b>余额额度无限（照常按量扣费记账）</b>；可管理/充值/封禁/删除所有下级账号。</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="shrink-0 rounded bg-brand/10 text-brand px-1.5 py-0.5 text-[10px] font-bold">管理员 (admin)</span>
              <span>拥有全模型调用权限；可在权限范围内管理下级并<b>实打实扣除自身余额为下级转账充值</b>；仅限超级管理员后台任命。</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="shrink-0 rounded bg-amber-500/10 text-amber-500 px-1.5 py-0.5 text-[10px] font-bold">VIP 账号 (vip)</span>
              <span><b>只要可用余额 &gt; 0 自动晋升为 VIP</b>；解锁全量付费大模型并按真实 Token 扣除账户余额。</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="shrink-0 rounded bg-zinc-500/10 text-zinc-400 px-1.5 py-0.5 text-[10px] font-bold">普通用户 (user)</span>
              <span><b>只要可用余额等于 0 自动降级为普通用户</b>；仅可免费使用 0 元模型池（免充值免扣费），付费模型拦截引导充值。</span>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted">共计 {users?.length ?? 0} 位注册用户</span>
            <Button onClick={() => setInvite({ open: true, email: "", role: "member" })}><Plus size={14} />邀请成员</Button>
          </div>

          {users === null ? <div className="flex flex-col gap-2">{[...Array(5)].map((_, i) => <div key={i} className="skeleton h-9" />)}</div> : <DataTable cols={userCols} rows={users} />}
        </Card>
      )}

      {tab === "codes" && isSuperadmin && (
        <div className="flex flex-col gap-4">
          {/* 统计指标卡片 */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card className="p-3.5 flex flex-col justify-between">
              <span className="text-xs text-muted">生成卡密总计</span>
              <span className="text-xl font-bold font-mono text-ink mt-1">{codes?.length ?? 0} 张</span>
            </Card>
            <Card className="p-3.5 flex flex-col justify-between">
              <span className="text-xs text-muted">未兑换有效卡密</span>
              <span className="text-xl font-bold font-mono text-emerald-500 mt-1">{codes?.filter((c) => c.status === "unused").length ?? 0} 张</span>
            </Card>
            <Card className="p-3.5 flex flex-col justify-between">
              <span className="text-xs text-muted">已核销兑换</span>
              <span className="text-xl font-bold font-mono text-muted mt-1">{codes?.filter((c) => c.status === "used").length ?? 0} 张</span>
            </Card>
            <Card className="p-3.5 flex flex-col justify-between">
              <span className="text-xs text-muted">总卡密加款面额</span>
              <span className="text-xl font-bold font-mono text-amber-500 mt-1">¥{(codes?.reduce((acc, c) => acc + c.amount, 0) ?? 0).toFixed(2)}</span>
            </Card>
          </div>

          <Card className="p-4 sm:p-5 flex flex-col gap-3.5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-ink">卡密列表</h3>
                <p className="text-xs text-muted mt-0.5">支持批量生成兑换卡密，用户可在前台自助手填卡密加款并自动升级 VIP。</p>
              </div>
              <Button onClick={() => setGenDlg({ open: true, amount: "50", count: "10", autoVip: true, note: "", password: "" })}>
                <Plus size={14} />批量生成卡密
              </Button>
            </div>

            {codes === null ? (
              <div className="flex flex-col gap-2">{[...Array(5)].map((_, i) => <div key={i} className="skeleton h-9" />)}</div>
            ) : codes.length === 0 ? (
              <div className="py-12 text-center text-xs text-muted">暂无卡密，请点击右上角「批量生成卡密」开始创建。</div>
            ) : (
              <DataTable cols={codeCols} rows={codes} />
            )}
          </Card>
        </div>
      )}

      {tab === "flags" && (
        <Card className="p-4">
          {flags === null ? <div className="skeleton h-40" /> : flags.length === 0 ? <p className="py-8 text-center text-xs text-muted">✓ 复核队列为空。开启内容审核后，命中规则的请求会进入这里。</p> : (
            <DataTable cols={[
              { key: "id", label: "ID", render: (f) => <code className="text-xs font-mono">{f.id.slice(0, 8)}…</code> },
              { key: "model", label: "模型", render: (f) => f.public_model ?? "—" },
              { key: "rule", label: "命中规则", render: (f) => <code className="text-xs">{f.rule}</code> },
              { key: "hash", label: "内容摘要", render: (f) => <code className="text-xs text-muted font-mono">{(f.excerpt_hash ?? "").slice(0, 16)}…</code> },
              { key: "status", label: "状态", render: (f) => <StatusTag value={f.status} /> },
              { key: "ops", label: "操作", render: (f) => (
                <span className="flex gap-1.5">
                  <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={async () => { await adminAction("resolve_flag", { flagId: f.id, decision: "cleared", note: "" }); toast("已放行"); loadFlags(); }}>放行</Button>
                  <Button variant="ghost" className="!px-2 !py-1 text-xs !text-err" onClick={async () => { await adminAction("resolve_flag", { flagId: f.id, decision: "confirmed", note: "" }); toast("已确认违规"); loadFlags(); }}>确认违规</Button>
                </span>
              ) },
            ] as Col<Flag>[]} rows={flags} />
          )}
        </Card>
      )}

      {tab === "appeals" && (
        <Card className="p-4">
          {appeals === null ? <div className="skeleton h-40" /> : appeals.length === 0 ? <p className="py-8 text-center text-xs text-muted">暂无待处理申诉</p> : (
            <DataTable cols={[
              { key: "id", label: "ID", render: (a) => <code className="text-xs font-mono">{a.id.slice(0, 8)}…</code> },
              { key: "type", label: "类型", render: (a) => a.target_type },
              { key: "reason", label: "申诉理由", render: (a) => <span className="line-clamp-1 max-w-md">{a.reason}</span> },
              { key: "status", label: "状态", render: (a) => <StatusTag value={a.status} /> },
              { key: "time", label: "时间", render: (a) => <span className="text-xs text-muted">{fmtTime(a.created_at)}</span> },
              { key: "ops", label: "操作", render: (a) => (
                <span className="flex gap-1.5">
                  <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={async () => { await adminAction("resolve_appeal", { appealId: a.id, decision: "accepted", note: "" }); toast("已受理"); loadAppeals(); }}>受理</Button>
                  <Button variant="ghost" className="!px-2 !py-1 text-xs !text-err" onClick={async () => { await adminAction("resolve_appeal", { appealId: a.id, decision: "rejected", note: "" }); toast("已驳回"); loadAppeals(); }}>驳回</Button>
                </span>
              ) },
            ] as Col<Appeal>[]} rows={appeals} />
          )}
        </Card>
      )}

      {/* 充值加款弹窗 */}
      <Dialog open={topupDlg.open} onClose={() => setTopupDlg({ open: false, user: null, amount: "50", memo: "", password: "" })} title={`为用户充值加款 — ${topupDlg.user?.email ?? ""}`} width={460}>
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg bg-surface2/60 p-3 text-xs">
            <span className="text-muted">目标用户当前余额</span>
            <span className="font-mono text-sm font-bold text-emerald-500">¥{(topupDlg.user?.balance ?? 0).toFixed(2)}</span>
          </div>

          <Field label="充值加款金额 (元)">
            <Input
              type="number"
              min="0.01"
              step="0.01"
              value={topupDlg.amount}
              onChange={(e) => setTopupDlg({ ...topupDlg, amount: e.target.value })}
              placeholder="50"
            />
          </Field>

          {/* 转账扣费规则说明 */}
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-2.5 text-xs text-amber-600 dark:text-amber-400 space-y-1">
            <div className="font-semibold">💡 转账扣款与自动 VIP 晋升机制：</div>
            <div>
              {isSuperadmin
                ? "超级管理员拥有无限调用额度，为下级充值将照常记入系统转账扣减流水。"
                : `本次充值将从您的账户余额中实打实扣除 ¥${topupDlg.amount || "0"}（您当前可用余额为 ¥${(me?.balance.available ?? 0).toFixed(2)}）。`}
            </div>
            <div>用户充值后只要可用余额大于 0，系统将自动晋升其为 VIP 账号！</div>
          </div>

          <Field label="充值备注 (可选)">
            <Input
              value={topupDlg.memo}
              onChange={(e) => setTopupDlg({ ...topupDlg, memo: e.target.value })}
              placeholder="管理员手动转账充值"
            />
          </Field>

          <Field label="管理员密码确认" hint="账户加款属于高危财务操作，需核验密码">
            <Input
              type="password"
              value={topupDlg.password}
              onChange={(e) => setTopupDlg({ ...topupDlg, password: e.target.value })}
              placeholder="请输入当前操作者的密码"
              autoComplete="current-password"
            />
          </Field>

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2 border-t border-line">
            <Button variant="ghost" className="flex-1 sm:flex-initial" onClick={() => setTopupDlg({ open: false, user: null, amount: "50", memo: "", password: "" })}>取消</Button>
            <Button className="flex-1 sm:flex-initial" onClick={submitTopup}>确认转账充值</Button>
          </div>
        </div>
      </Dialog>

      {/* 批量生成卡密弹窗 */}
      <Dialog open={genDlg.open} onClose={() => setGenDlg({ open: false, amount: "50", count: "10", autoVip: true, note: "", password: "" })} title="批量生成充值卡密" width={480}>
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="卡密面值 (元)">
              <Input
                type="number"
                step="0.01"
                value={genDlg.amount}
                onChange={(e) => setGenDlg({ ...genDlg, amount: e.target.value })}
                placeholder="50"
              />
            </Field>
            <Field label="生成数量 (张)" hint="单次最多 100 张">
              <Input
                type="number"
                min="1"
                max="100"
                value={genDlg.count}
                onChange={(e) => setGenDlg({ ...genDlg, count: e.target.value })}
                placeholder="10"
              />
            </Field>
            <div className="col-span-1 sm:col-span-2">
              <Field label="卡密批次备注 (可选)">
                <Input
                  value={genDlg.note}
                  onChange={(e) => setGenDlg({ ...genDlg, note: e.target.value })}
                  placeholder="例如: 客户批量采购、新用户福利卡"
                />
              </Field>
            </div>
            <div className="col-span-1 sm:col-span-2">
              <p className="text-xs text-muted">
                💡 用户兑换后账户余额 &gt; 0 将自动获得 VIP 身份；超级管理员生成的卡密为系统铸币加款。
              </p>
            </div>
            <div className="col-span-1 sm:col-span-2">
              <Field label="管理员密码确认" hint="生成有效货币卡密属于财务敏感操作，需核验管理员密码">
                <Input
                  type="password"
                  value={genDlg.password}
                  onChange={(e) => setGenDlg({ ...genDlg, password: e.target.value })}
                  placeholder="请输入当前管理员密码"
                  autoComplete="current-password"
                />
              </Field>
            </div>
          </div>

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2 border-t border-line">
            <Button variant="ghost" className="flex-1 sm:flex-initial" onClick={() => setGenDlg({ open: false, amount: "50", count: "10", autoVip: true, note: "", password: "" })}>取消</Button>
            <Button className="flex-1 sm:flex-initial" onClick={generateCodes}>确认批量生成</Button>
          </div>
        </div>
      </Dialog>

      {/* 生成结果弹窗 */}
      <Dialog open={!!batchResult} onClose={() => setBatchResult(null)} title="卡密生成成功" width={480}>
        <div className="space-y-3">
          <p className="text-xs text-muted">已成功生成 {batchResult?.length ?? 0} 张卡密。您可以一键复制并直接发给客户或导入发卡系统：</p>
          <textarea
            readOnly
            value={(batchResult || []).join("\n")}
            rows={6}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs font-mono text-ink focus:outline-none"
          />
          <div className="flex justify-end gap-2 pt-2 border-t border-line">
            <Button variant="ghost" onClick={() => setBatchResult(null)}>关闭</Button>
            <Button onClick={() => copyStr((batchResult || []).join("\n"), "全部卡密")}>一键复制全部卡密</Button>
          </div>
        </div>
      </Dialog>

      {/* 调整用户角色弹窗 */}
      <Dialog open={roleDlg.open} onClose={() => setRoleDlg({ open: false, user: null, role: "user" })} title={`调整账号等级 — ${roleDlg.user?.email ?? ""}`} width={500}>
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg bg-surface2/60 p-3 text-xs">
            <span className="text-muted">目标用户当前可用余额</span>
            <span className="font-mono text-sm font-bold text-emerald-500">¥{(roleDlg.user?.balance ?? 0).toFixed(2)}</span>
          </div>

          <Field label="账号角色等级">
            <Select value={roleDlg.role} onChange={(e) => setRoleDlg({ ...roleDlg, role: e.target.value })}>
              {isSuperadmin && <option value="superadmin">超级管理员 (superadmin) — 最高站长权限，全站管理</option>}
              {isSuperadmin && <option value="admin">管理员 (admin) — 拥有下级用户管理与转账充值权限（余额为0不影响任命）</option>}
              <option value="vip">VIP 账号 (vip) — 解锁全量付费大模型，按量扣费</option>
              <option value="user">普通用户 (user) — 仅限免费模型池，免充值不扣费</option>
              {isSuperadmin && <option value="finance">财务人员 (finance)</option>}
              {isSuperadmin && <option value="auditor">审计员 (auditor)</option>}
            </Select>
          </Field>

          <div className="rounded-xl border border-line bg-surface2/60 p-3 text-xs text-muted space-y-1.5">
            <div>• <b>管理员 (admin)</b>：由超级管理员在后台任命。管理员余额可以为 0，但余额为 0 时无法向下级转账加款。</div>
            <div>• <b>自动 VIP 机制</b>：普通用户只要余额 &gt; 0 自动晋升为 VIP；余额等于 0 自动降为普通用户。若需开通 VIP，直接使用「充值」加款即可。</div>
            <div>• <b>权限层级继承</b>：只允许管理与充值权限严格低于自身的下级用户。</div>
          </div>

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2 border-t border-line">
            <Button variant="ghost" className="flex-1 sm:flex-initial" onClick={() => setRoleDlg({ open: false, user: null, role: "user" })}>取消</Button>
            <Button className="flex-1 sm:flex-initial" onClick={changeRole}>确认修改角色</Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={invite.open} onClose={() => setInvite({ ...invite, open: false })} title="邀请组织成员" width={440}>
        <div className="flex flex-col gap-3">
          <Field label="成员邮箱"><Input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></Field>
          <Field label="备注">组织成员需先自行注册账号，管理员在此登记后分配组织与角色（MVP 阶段以用户角色为准）。</Field>
        </div>
        <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" onClick={() => setInvite({ ...invite, open: false })}>取消</Button><Button onClick={() => { toast("已记录邀请（MVP 占位）"); setInvite({ ...invite, open: false }); }}>发送邀请</Button></div>
      </Dialog>
      {confirmEl}
    </div>
  );
}
