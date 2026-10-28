import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Github, Mail } from "lucide-react";
import { api, type SiteInfo } from "../lib/api";
import { Button, Card, Dialog, Field, Input, useToast } from "../components/ui";

export default function Login({ site, onLogin }: { site: SiteInfo | null; onLogin: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [loginMethod, setLoginMethod] = useState<"password" | "code">("password");
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [loginCode, setLoginCode] = useState("");
  const [loginCountdown, setLoginCountdown] = useState(0);
  const [sendingLoginCode, setSendingLoginCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [regCode, setRegCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [sendingCode, setSendingCode] = useState(false);
  const [reset, setReset] = useState({ email: "", code: "", password: "", stage: 1 as 1 | 2 });
  const [resetMsg, setResetMsg] = useState("");
  const [inviteCode, setInviteCode] = useState(() => new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("invite") ?? "");
  const nav = useNavigate();
  const toast = useToast();

  const submit = async () => {
    setBusy(true);
    try {
      const cleanEmail = email.trim().toLowerCase();
      if (!cleanEmail) return toast("请填写邮箱地址", "err");

      if (mode === "login") {
        if (loginMethod === "code") {
          const cleanCode = loginCode.trim();
          if (!cleanCode) return toast("请输入邮箱验证码", "err");
          if (cleanCode.length !== 6) return toast("请输入完整的 6 位数字验证码", "err");
          await api("/api/auth/login", "POST", { email: cleanEmail, code: cleanCode });
        } else {
          if (!pass) return toast("请输入密码", "err");
          await api("/api/auth/login", "POST", { email: cleanEmail, password: pass });
        }
      } else {
        const cleanCode = regCode.trim();
        if (site?.smtpEnabled) {
          if (!cleanCode) return toast("请输入邮箱验证码", "err");
          if (cleanCode.length !== 6) return toast("请输入完整的 6 位数字验证码", "err");
        }
        await api("/api/auth/register", "POST", {
          email: cleanEmail,
          password: pass,
          code: cleanCode,
          inviteCode: inviteCode?.trim() || undefined,
          tosAccepted: true,
          privacyAccepted: true,
        });
      }
      await onLogin();
      nav("/dashboard");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally { setBusy(false); }
  };

  const sendLoginCode = async () => {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) return toast("请先填写邮箱", "err");
    setSendingLoginCode(true);
    try {
      await api("/api/auth/login", "POST", { action: "send-code", email: cleanEmail });
      toast("登录验证码已发送，10 分钟内有效");
      setLoginCountdown(60);
      const t = setInterval(() => setLoginCountdown((c) => { if (c <= 1) clearInterval(t); return c - 1; }), 1000);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally { setSendingLoginCode(false); }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          {site?.siteLogoUrl ? <img src={site.siteLogoUrl} alt="logo" className="h-10 w-10 rounded-xl2 object-contain shadow-card" /> : <div className="flex h-10 w-10 items-center justify-center rounded-xl2 bg-brand text-lg font-bold text-white shadow-card">E</div>}
          <div><div className="text-lg font-bold">{site?.siteName ?? "Relay"}</div><div className="max-w-[260px] text-xs text-muted">{site?.siteDescription ?? "部署在 EdgeOne 边缘的 AI API 网关"}</div></div>
        </div>
        <Card className="p-6">
          <h1 className="text-base font-semibold">{mode === "login" ? "登录控制台" : "注册账号"}</h1>
          <p className="mt-1 text-xs text-muted">{mode === "login" ? "使用平台账号登录" : "注册即表示已阅读并同意服务条款与隐私政策"}</p>
          <form className="mt-5 flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            {mode === "login" && (
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted">登录方式</span>
                <div className="flex gap-0.5 rounded-lg bg-surface2 p-0.5">
                  <button type="button" onClick={() => setLoginMethod("password")}
                    className={`rounded-md px-3 py-1 text-[11px] font-medium transition-colors ${loginMethod === "password" ? "bg-surface text-brand shadow-sm" : "text-muted hover:text-ink"}`}>密码</button>
                  <button type="button" onClick={() => setLoginMethod("code")} disabled={!site?.smtpEnabled}
                    title={site?.smtpEnabled ? "使用邮箱验证码登录" : "管理员未开启邮箱验证码登录"}
                    className={`rounded-md px-3 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${loginMethod === "code" ? "bg-surface text-brand shadow-sm" : "text-muted hover:text-ink"}`}>验证码</button>
                </div>
              </div>
            )}
            <Field label="邮箱"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" /></Field>
            {mode === "login" && loginMethod === "password" && (
              <Field label="密码"><Input type="password" required minLength={1} value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" /></Field>
            )}
            {mode === "login" && loginMethod === "code" && (
              <Field label="邮箱验证码">
                <div className="flex gap-2">
                  <Input required value={loginCode} onChange={(e) => setLoginCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 位数字验证码" inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
                  <Button type="button" variant="ghost" disabled={!site?.smtpEnabled || loginCountdown > 0 || sendingLoginCode} className="shrink-0 whitespace-nowrap"
                    title={site?.smtpEnabled ? "发送登录验证码" : "管理员未开启邮箱验证码登录"}
                    onClick={sendLoginCode}>{sendingLoginCode ? "发送中…" : loginCountdown > 0 ? `${loginCountdown}s` : "获取验证码"}</Button>
                </div>
              </Field>
            )}
            {mode === "register" && (
              <Field label="密码"><Input type="password" required minLength={10} value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" /></Field>
            )}
            {mode === "register" && site?.smtpEnabled && (
              <Field label="邮箱验证码">
                <div className="flex gap-2">
                  <Input required value={regCode} onChange={(e) => setRegCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 位数字验证码" inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
                  <Button type="button" variant="ghost" disabled={countdown > 0 || sendingCode} className="shrink-0 whitespace-nowrap"
                    onClick={async () => {
                      const cleanEmail = email.trim().toLowerCase();
                      if (!cleanEmail) return toast("请先填写邮箱", "err");
                      setSendingCode(true);
                      try {
                        await api("/api/auth/register", "POST", { action: "send-code", email: cleanEmail });
                        toast("验证码已发送，10 分钟内有效");
                        setCountdown(60);
                        const t = setInterval(() => setCountdown((c) => { if (c <= 1) clearInterval(t); return c - 1; }), 1000);
                      } catch (e) { toast((e as Error).message, "err"); } finally { setSendingCode(false); }
                    }}>{sendingCode ? "发送中…" : countdown > 0 ? `${countdown}s` : "获取验证码"}</Button>
                </div>
              </Field>
            )}
            <Button type="submit" disabled={busy} className="mt-1 w-full !py-2.5">
              {mode === "login" ? "登录" : "注册"}{!busy && <ArrowRight size={14} />}
            </Button>
          </form>
          <div className="my-4 flex items-center gap-3 text-[11px] text-muted"><span className="h-px flex-1 bg-line" />或<span className="h-px flex-1 bg-line" /></div>
          <div className="grid grid-cols-2 gap-2.5">
            <Button variant="ghost" disabled={!site?.oauth.github} title={site?.oauth.github ? "使用 GitHub 账号登录" : "管理员未启用"}
              onClick={() => { location.href = "/api/auth/oauth?provider=github"; }}><Github size={15} />GitHub</Button>
            <Button variant="ghost" disabled={!site?.oauth.google} title={site?.oauth.google ? "使用 Google 账号登录" : "管理员未启用"}
              onClick={() => { location.href = "/api/auth/oauth?provider=google"; }}><Mail size={15} />Google</Button>
          </div>
          {mode === "register" && (
            <div className="mt-4">
              <Field label="邀请码（选填）"><Input value={inviteCode} onChange={(e) => setInviteCode(e.target.value.toUpperCase())} placeholder="有邀请码可获额外奖励" /></Field>
            </div>
          )}
          <button className="mt-3 w-full text-center text-xs text-muted hover:text-brand" onClick={() => setResetOpen(true)}>忘记密码？</button>
          <button className="mt-4 w-full text-center text-xs text-muted hover:text-brand" onClick={() => setMode(mode === "login" ? "register" : "login")}>
            {mode === "login" ? "没有账号？立即注册" : "已有账号？返回登录"}
          </button>
        </Card>
        <p className="mt-4 text-center text-[11px] text-muted">
          登录即表示同意 <a className="underline hover:text-brand" href="/terms.html" target="_blank" rel="noreferrer">服务条款</a> 与 <a className="underline hover:text-brand" href="/privacy.html" target="_blank" rel="noreferrer">隐私政策</a>
        </p>
      </div>

      <Dialog open={resetOpen} onClose={() => setResetOpen(false)} title="重置密码" width={440}>
        <div className="flex flex-col gap-3">
          <Field label="邮箱"><Input type="email" value={reset.email} onChange={(e) => setReset({ ...reset, email: e.target.value })} /></Field>
          {reset.stage === 2 && (<>
            <Field label="验证码（已发送至邮箱，10 分钟有效）"><Input value={reset.code} onChange={(e) => setReset({ ...reset, code: e.target.value.replace(/\D/g, "").slice(0, 6) })} /></Field>
            <Field label="新密码（至少 10 位）"><Input type="password" value={reset.password} onChange={(e) => setReset({ ...reset, password: e.target.value })} /></Field>
          </>)}
          {resetMsg && <p className="text-xs text-muted">{resetMsg}</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setResetOpen(false)}>关闭</Button>
          <Button onClick={async () => {
            setResetMsg("");
            try {
              if (reset.stage === 1) {
                await api("/api/auth/reset", "POST", { action: "request", email: reset.email });
                setReset({ ...reset, stage: 2 }); setResetMsg("验证码已发送，请查收邮箱");
              } else {
                const r = await api<{ message?: string }>("/api/auth/reset", "POST", { action: "confirm", email: reset.email, code: reset.code, password: reset.password });
                setResetMsg(r.message ?? "密码已重置"); toast("密码已重置，请登录");
              }
            } catch (e) { setResetMsg((e as Error).message); }
          }}>{reset.stage === 1 ? "发送验证码" : "确认重置"}</Button>
        </div>
      </Dialog>
    </div>
  );
}
