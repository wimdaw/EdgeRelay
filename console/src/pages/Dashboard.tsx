import { useEffect, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, Coins, ShieldQuestion, Zap } from "lucide-react";
import { api, type Me, type Stats, type TrendPoint, type UsageLog } from "../lib/api";
import { Button, Card, DataTable, Dialog, Field, Input, Skeleton, StatusTag, useToast, type Col } from "../components/ui";
import { fmtInt, fmtMoney, fmtTime } from "../lib/utils";
import { useOutletContext } from "react-router-dom";

const RANGES = [
  { key: 1, label: "24h" }, { key: 7, label: "7d" }, { key: 30, label: "30d" },
];

const fmtAxis = (v: number) => {
  if (v >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(1)}k`;
  return String(v);
};

const shortModel = (v: string) => (v.length > 18 ? `${v.slice(0, 17)}…` : v);

export default function Dashboard() {
  const { me } = useOutletContext<{ me: Me }>();
  const isSuperadmin = me.user.role === "superadmin";
  const isAdmin = ["superadmin", "admin", "auditor"].includes(me.user.role);
  const [stats, setStats] = useState<Stats | null>(null);
  const [trend, setTrend] = useState<TrendPoint[] | null>(null);
  const [range, setRange] = useState(7);
  const [recent, setRecent] = useState<UsageLog[] | null>(null);
  const [balance, setBalance] = useState(me.balance.available);
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [redeemCode, setRedeemCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  // 在线充值（易支付）
  const [pay, setPay] = useState<{ epayEnabled: boolean; channels: string[]; minAmount: number; maxAmount: number } | null>(null);
  const [onlineOpen, setOnlineOpen] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payChannel, setPayChannel] = useState("");
  const [creating, setCreating] = useState(false);
  const [order, setOrder] = useState<{ outTradeNo: string; amount: number; payUrl: string; qrCode: string } | null>(null);
  const toast = useToast();

  const CHANNEL_LABEL: Record<string, string> = { alipay: "支付宝", wxpay: "微信支付", qqpay: "QQ 钱包", usdt: "USDT" };

  useEffect(() => {
    api<{ payment?: { epayEnabled: boolean; channels: string[]; minAmount: number; maxAmount: number } }>("/api/site")
      .then((d) => {
        if (!d.payment?.epayEnabled) return setPay(null);
        setPay(d.payment);
        setPayChannel((prev) => prev || d.payment!.channels[0] || "alipay");
        setPayAmount((prev) => prev || String(d.payment!.minAmount || 10));
      })
      .catch(() => setPay(null));
  }, []);

  const createOrder = async () => {
    if (!pay) return;
    const amount = Number(payAmount);
    if (!Number.isFinite(amount) || amount < pay.minAmount || amount > pay.maxAmount) {
      return toast(`金额需在 ¥${pay.minAmount} ~ ¥${pay.maxAmount} 之间`, "err");
    }
    setCreating(true);
    try {
      const res = await api<{ outTradeNo: string; amount: number; payUrl: string; qrCode: string }>("/api/pay/epay/create", "POST", {
        amount,
        type: payChannel,
      });
      setOrder({ outTradeNo: res.outTradeNo, amount: res.amount, payUrl: res.payUrl, qrCode: res.qrCode });
      if (res.payUrl) window.open(res.payUrl, "_blank", "noopener");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setCreating(false);
    }
  };

  // 下单后轮询订单状态，到账即刷新余额
  useEffect(() => {
    if (!order) return;
    let stopped = false;
    const tick = async () => {
      try {
        const d = await api<{ order: { status: string; paidAt: number | null } }>(`/api/pay/epay/order/${order.outTradeNo}`);
        if (stopped) return;
        if (d.order.status === "paid") {
          stopped = true;
          const bal = await api<{ balance: { available: number; currency: string } }>("/api/billing/balance").catch(() => null);
          if (bal) setBalance(bal.balance.available);
          toast(`充值成功，已到账 ¥${order.amount.toFixed(2)}`);
          setOrder(null);
          setOnlineOpen(false);
        }
      } catch {
        /* 订单未生成或网络抖动，下一轮再试 */
      }
    };
    const timer = window.setInterval(tick, 3000);
    tick();
    return () => { stopped = true; window.clearInterval(timer); };
  }, [order]);

  const handleRedeem = async () => {
    if (!redeemCode.trim()) return toast("请输入卡密兑换码", "err");
    setRedeeming(true);
    try {
      const res = await api<{ ok: boolean; amount: number; balance: number; currency: string; message: string }>("/api/billing/redeem", "POST", { code: redeemCode.trim() });
      toast(res.message || `成功充值 ¥${res.amount.toFixed(2)}！`);
      setBalance(res.balance);
      setRedeemCode("");
      setRedeemOpen(false);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setRedeeming(false);
    }
  };

  // 管理员看全局数据，普通用户看自己的数据
  useEffect(() => { api<Stats>(isAdmin ? "/api/admin/stats" : "/api/usage/summary").then(setStats).catch(() => setStats(null)); }, [isAdmin]);
  useEffect(() => {
    setTrend(null);
    api<{ points: TrendPoint[] }>(`${isAdmin ? "/api/admin/usage/trend" : "/api/usage/trend"}?days=${range}`).then((d) => setTrend(d.points)).catch(() => setTrend([]));
  }, [range, isAdmin]);
  useEffect(() => {
    api<{ logs: UsageLog[] }>(`${isAdmin ? "/api/admin/usage/logs" : "/api/usage/logs"}?limit=10`).then((d) => setRecent(d.logs)).catch(() => setRecent([]));
  }, [isAdmin]);

  const cards = [
    { label: "我的请求数（24h）", value: stats ? fmtInt(stats.requests) : "", icon: Zap, color: "text-brand bg-brand/10" },
    { label: "我的 Token 消耗（24h）", value: stats ? fmtInt(stats.promptTokens + stats.completionTokens) : "", icon: Coins, color: "text-info bg-info/10" },
    { label: "我的成功率（24h）", value: stats ? `${((1 - stats.errorRate) * 100).toFixed(2)}%` : "", icon: Activity, color: "text-ok bg-ok/10" },
    {
      label: isSuperadmin ? "当前余额 (超管无限)" : "当前余额",
      value: isSuperadmin ? "∞ 无限额度" : fmtMoney(balance, me.balance.currency),
      icon: ShieldQuestion,
      color: "text-brand bg-brand/10",
    },
  ];

  const cols: Col<UsageLog>[] = [
    { key: "time", label: "时间", sortVal: (r) => r.created_at, render: (r) => <span className="text-xs text-muted">{fmtTime(r.created_at)}</span> },
    { key: "user", label: "用户", render: (r) => <code className="text-xs">{r.user_id.slice(0, 8)}…</code> },
    { key: "model", label: "模型", render: (r) => <span className="font-medium">{r.public_model}</span> },
    { key: "status", label: "状态", render: (r) => <StatusTag value={r.status} /> },
    { key: "latency", label: "耗时", sortVal: (r) => r.latency_ms, render: (r) => `${r.latency_ms} ms` },
    { key: "tokens", label: "Tokens", sortVal: (r) => r.prompt_tokens + r.completion_tokens, render: (r) => `${r.prompt_tokens} + ${r.completion_tokens}` },
    { key: "cost", label: "费用", render: (r) => r.cost_usd.toFixed(4) },
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* 统计卡片 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">{label}</span>
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${color}`}><Icon size={16} /></span>
            </div>
            {stats || label === "当前余额" ? <div className="mt-2 truncate text-xl font-bold tabular-nums sm:text-2xl" title={String(value)}>{value}</div> : <Skeleton className="mt-3 h-7 w-24" />}
            <div className="mt-1 text-[11px] text-muted flex items-center justify-between">
              <span>{label.includes("余额") ? (isSuperadmin ? "超管不卡额度 · 真实扣费记账" : "按量真实结算") : "较昨日 —"}</span>
              {label.includes("余额") && (
                <span className="flex items-center gap-1">
                  {pay?.epayEnabled && (
                    <button
                      type="button"
                      onClick={() => setOnlineOpen(true)}
                      className="rounded bg-ok/10 hover:bg-ok/20 px-2 py-0.5 text-[11px] font-semibold text-ok transition-colors cursor-pointer"
                    >
                      在线充值
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setRedeemOpen(true)}
                    className="rounded bg-brand/10 hover:bg-brand/20 px-2 py-0.5 text-[11px] font-semibold text-brand transition-colors cursor-pointer"
                  >
                    卡密充值
                  </button>
                </span>
              )}
            </div>
          </Card>
        ))}
      </div>

      {/* 趋势图 */}
      <Card className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">请求量与 Token 趋势</h2>
          <div className="flex gap-1 rounded-lg bg-surface2 p-0.5" role="tablist" aria-label="时间范围">
            {RANGES.map((r) => (
              <button key={r.key} role="tab" aria-selected={range === r.key} onClick={() => setRange(r.key)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${range === r.key ? "bg-surface text-brand shadow-sm" : "text-muted hover:text-ink"}`}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <div className="h-64">
          {trend === null ? <Skeleton className="h-full" /> : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="gReq" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#F38020" stopOpacity={0.35} /><stop offset="100%" stopColor="#F38020" stopOpacity={0} /></linearGradient>
                  <linearGradient id="gTok" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2563EB" stopOpacity={0.3} /><stop offset="100%" stopColor="#2563EB" stopOpacity={0} /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--c-line))" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "rgb(var(--c-muted))" }} tickLine={false} axisLine={false} />
                <YAxis width={44} tickFormatter={fmtAxis} tick={{ fontSize: 11, fill: "rgb(var(--c-muted))" }} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ background: "rgb(var(--c-surface))", border: "1px solid rgb(var(--c-line))", borderRadius: 10, fontSize: 12 }} />
                <Area type="monotone" dataKey="requests" name="请求数" stroke="#F38020" strokeWidth={2} fill="url(#gReq)" />
                <Area type="monotone" dataKey="tokens" name="Tokens" stroke="#2563EB" strokeWidth={2} fill="url(#gTok)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-5">
        {/* 模型占比 */}
        <Card className="min-w-0 p-5 xl:col-span-2">
          <h2 className="mb-4 text-sm font-semibold">我的各模型调用占比（24h）</h2>
          <div className="h-56">
            {stats === null ? <Skeleton className="h-full" /> : stats.byModel.length === 0 ? <div className="flex h-full items-center justify-center text-xs text-muted">暂无调用数据</div> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.byModel} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--c-line))" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: "rgb(var(--c-muted))" }} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="public_model" width={128} tickFormatter={shortModel} tick={{ fontSize: 10, fill: "rgb(var(--c-muted))" }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ background: "rgb(var(--c-surface))", border: "1px solid rgb(var(--c-line))", borderRadius: 10, fontSize: 12 }} />
                  <Bar dataKey="n" name="请求数" radius={[0, 6, 6, 0]} fill="#F38020" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        {/* 最近请求 */}
        <Card className="min-w-0 p-5 xl:col-span-3">
          <h2 className="mb-4 text-sm font-semibold">我的最近请求</h2>
          {recent === null ? <div className="flex flex-col gap-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-9" />)}</div> : (
            <DataTable cols={cols} rows={recent.map((r) => ({ ...r, id: r.id }))} page={10}
              expand={(r) => (
                <div className="grid grid-cols-2 gap-2 text-xs text-muted">
                  <span>请求 ID：<code>{r.request_id}</code></span>
                  <span>上游尝试：{r.attempts} 次{r.stream ? "（流式）" : ""}</span>
                  <span>HTTP {r.http_status} · {r.error_code ?? "—"}</span>
                  <span>IP：{r.ip}</span>
                </div>
              )} />
          )}
        </Card>
      </div>

      {/* 卡密兑换与加款弹窗 */}
      <Dialog open={redeemOpen} onClose={() => setRedeemOpen(false)} title="卡密兑换充值" width={440}>
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg bg-surface2/60 p-3 text-xs">
            <span className="text-muted">当前可用余额</span>
            <span className="font-mono text-sm font-bold text-emerald-500">
              {isSuperadmin ? "∞ 无限额度" : fmtMoney(balance, me.balance.currency)}
            </span>
          </div>

          <Field label="卡密兑换码" hint="输入获得的 16~20 位卡密代码">
            <Input
              value={redeemCode}
              onChange={(e) => setRedeemCode(e.target.value)}
              placeholder="例如: CARD-7K9A-2X4B-9PQW"
              autoFocus
            />
          </Field>

          <p className="text-xs text-muted">
            输入有效卡密后点击兑换，系统将实时为您的账户增加对应面额资金；若您当前为普通用户，支持的卡密还将自动为您升级为 VIP 账号！
          </p>

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2 border-t border-line">
            <Button variant="ghost" className="flex-1 sm:flex-initial" onClick={() => setRedeemOpen(false)}>取消</Button>
            <Button className="flex-1 sm:flex-initial" disabled={redeeming || !redeemCode.trim()} onClick={handleRedeem}>
              {redeeming ? "核销中…" : "立即兑换加款"}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* 在线充值（易支付） */}
      <Dialog open={onlineOpen} onClose={() => { setOnlineOpen(false); setOrder(null); }} title="在线充值" width={480}>
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg bg-surface2/60 p-3 text-xs">
            <span className="text-muted">当前可用余额</span>
            <span className="font-mono text-sm font-bold text-emerald-500">
              {isSuperadmin ? "∞ 无限额度" : fmtMoney(balance, me.balance.currency)}
            </span>
          </div>

          {order ? (
            <>
              <div className="rounded-lg border border-line p-4 text-center">
                <p className="text-xs text-muted">订单号 {order.outTradeNo} · 应付 ¥{order.amount.toFixed(2)}</p>
                {order.qrCode && /^https?:\/\//i.test(order.qrCode) ? (
                  <img src={order.qrCode} alt="支付二维码" className="mx-auto mt-3 h-44 w-44 rounded-lg bg-white p-1" />
                ) : null}
                <p className="mt-3 text-xs text-muted">已在新窗口打开收银台，支付完成后本页会自动到账，请勿关闭。</p>
                {order.payUrl ? (
                  <a href={order.payUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs font-medium text-brand underline">
                    收银台没能打开？点此重新前往
                  </a>
                ) : null}
                <div className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-muted">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />等待支付结果…
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-line">
                <Button variant="ghost" onClick={() => { setOrder(null); }}>换个金额重下</Button>
              </div>
            </>
          ) : (
            <>
              <Field label={`充值金额（¥${pay?.minAmount ?? 1} ~ ¥${pay?.maxAmount ?? 5000}）`} hint="到账后可用于所有按量计费模型">
                <Input type="number" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="10" autoFocus />
              </Field>

              <Field label="支付方式">
                <div className="flex flex-wrap gap-2 pt-1">
                  {(pay?.channels ?? []).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setPayChannel(c)}
                      className={`cursor-pointer rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${payChannel === c ? "border-brand/40 bg-brand/10 text-brand" : "border-line text-muted hover:text-ink"}`}
                    >
                      {CHANNEL_LABEL[c] ?? c}
                    </button>
                  ))}
                </div>
              </Field>

              <p className="text-xs text-muted">
                由第三方易支付平台收款，支付成功后由平台异步回调入账；若长时间未到账，请携带订单号联系客服。
              </p>

              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2 border-t border-line">
                <Button variant="ghost" className="flex-1 sm:flex-initial" onClick={() => setOnlineOpen(false)}>取消</Button>
                <Button className="flex-1 sm:flex-initial" disabled={creating || !payAmount} onClick={createOrder}>
                  {creating ? "下单中…" : "前往支付"}
                </Button>
              </div>
            </>
          )}
        </div>
      </Dialog>
    </div>
  );
}
