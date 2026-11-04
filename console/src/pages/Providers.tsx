import { useEffect, useRef, useState } from "react";
import {
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Key,
  Pencil,
  Power,
  CheckCircle2,
  AlertTriangle,
  ShieldAlert,
  ShieldCheck,
  LogIn,
  Copy,
  ExternalLink,
  Users,
  Globe,
} from "lucide-react";
import { adminAction, type Provider } from "../lib/api";
import { Button, Card, Dialog, EmptyState, Field, Input, Select, StatusTag, useConfirm, useToast } from "../components/ui";
import { cn } from "../lib/utils";

const PRESETS: Record<string, { name: string; slug: string; kind: string; url: string }> = {
  deepseek: { name: "DeepSeek", slug: "deepseek", kind: "openai_compat", url: "https://api.deepseek.com" },
  openai: { name: "OpenAI", slug: "openai", kind: "openai_compat", url: "https://api.openai.com" },
  anthropic: { name: "Anthropic", slug: "anthropic", kind: "anthropic", url: "https://api.anthropic.com" },
  google: { name: "Google Gemini", slug: "google", kind: "openai_compat", url: "https://generativelanguage.googleapis.com/v1beta/openai" },
  kilo: { name: "Kilo (免Key)", slug: "kilo", kind: "openai_compat", url: "https://api.kilo.ai/api/gateway" },
  opencode: { name: "OpenCode (免Key)", slug: "opencode", kind: "openai_compat", url: "https://opencode.ai/zen/v1" },
  duckai: { name: "Duck.ai (免Key)", slug: "duckai", kind: "openai_compat", url: "https://duck.ai" },
};

const isKeylessSlug = (slug?: string) => slug === "opencode" || slug === "duckai" || slug === "kilo";
const isOAuthKind = (kind?: string | null) => !!kind && kind.startsWith("oauth:");
const isWebKind = (kind?: string | null) => !!kind && kind.startsWith("web:");
const isOAuthProvider = (p?: Provider | null) => isOAuthKind(p?.kind);
const isWebProvider = (p?: Provider | null) => isWebKind(p?.kind);

/** OAuth 渠道目录（与后端 src/oauth/index.ts 保持一致） */
type OAuthMeta = {
  type: string;
  name: string;
  slug: string;
  baseUrl: string;
  mode: "redirect" | "device" | "redirect-poll";
  desc: string;
  models: string[];
};

const OAUTH_CATALOG: OAuthMeta[] = [
  {
    type: "claude",
    name: "Claude (Anthropic)",
    slug: "claude-oauth",
    baseUrl: "https://api.anthropic.com",
    mode: "redirect" as const,
    desc: "Claude Code OAuth 授权，自动翻译为 Anthropic Messages 协议。",
    models: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
  },
  {
    type: "codex",
    name: "ChatGPT (Codex)",
    slug: "codex-oauth",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    mode: "redirect" as const,
    desc: "ChatGPT 账号授权（Codex CLI），自动翻译为 Responses 协议。",
    models: ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex"],
  },
  {
    type: "antigravity",
    name: "Antigravity (Google)",
    slug: "antigravity-oauth",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    mode: "redirect" as const,
    desc: "Google 账号授权（Antigravity 客户端），自动翻译为 Gemini 协议。",
    models: ["gemini-3.7-flash", "gemini-3.1-pro"],
  },
  {
    type: "kimi",
    name: "Kimi (Moonshot)",
    slug: "kimi-oauth",
    baseUrl: "https://api.kimi.ai/coding",
    mode: "device" as const,
    desc: "Kimi 设备码授权，OpenAI 兼容协议直通（国际站/中国站自动识别）。",
    models: ["kimi-for-coding", "kimi-for-coding-highspeed"],
  },
  {
    type: "qwen",
    name: "Qwen (通义千问)",
    slug: "qwen-oauth",
    baseUrl: "https://portal.qwen.ai/v1",
    mode: "device" as const,
    desc: "Qwen 设备码授权，OpenAI 兼容协议直通。",
    models: ["coder-model", "qwen3-coder-plus"],
  },
  {
    type: "grok",
    name: "Grok (xAI)",
    slug: "grok-oauth",
    baseUrl: "https://cli-chat-proxy.grok.com/v1",
    mode: "device" as const,
    desc: "xAI 设备码授权，自动翻译为 Responses 协议。",
    models: ["grok-4.6", "grok-4.5"],
  },
  {
    type: "codebuddy",
    name: "CodeBuddy 国内版",
    slug: "codebuddy-oauth",
    baseUrl: "https://copilot.tencent.com",
    mode: "redirect-poll",
    desc: "腾讯 CodeBuddy 国内版账号授权（copilot.tencent.com / codebuddy.cn），OpenAI 兼容协议直通。",
    models: ["deepseek-v4.1-flash"],
  },
  {
    type: "codebuddy",
    name: "CodeBuddy 国际版",
    slug: "codebuddy-global-oauth",
    baseUrl: "https://www.workbuddy.ai",
    mode: "redirect-poll",
    desc: "WorkBuddy 国际版账号授权（workbuddy.ai），与国内版账号体系完全独立。",
    models: ["deepseek-v4.1-flash"],
  },
  {
    type: "cline",
    name: "Cline",
    slug: "cline-oauth",
    baseUrl: "https://api.cline.bot",
    mode: "device",
    desc: "Cline 账号 WorkOS 设备码授权，自动适配免费通道与「账号×模型」冷却。",
    models: ["cline-free/mimo-v2.6-flash", "cline-free/nemotron-3.5-super-vl", "nvidia/nemotron-3.5-lightning:free"],
  },
];

type OAuthDialogState = {
  meta: OAuthMeta;
  provider: Provider | null;
  mode: "redirect" | "device" | "redirect-poll";
  baseUrl: string;
  url: string;
  state: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  interval?: number;
  step: "loading" | "ready" | "polling" | "error";
  message?: string;
  codeInput: string;
  busy?: boolean;
};

/** Web 反代渠道目录（与后端 src/web/index.ts 保持一致） */
type WebMeta = {
  type: string;
  name: string;
  slug: string;
  baseUrl: string;
  desc: string;
  credHint: string;
  models: string[];
};

const WEB_CATALOG: WebMeta[] = [
  {
    type: "deepseek",
    name: "DeepSeek 网页版",
    slug: "deepseek-web",
    baseUrl: "https://chat.deepseek.com/api/v0",
    desc: "网页 userToken 反代，自动解 PoW；token 约 24h 有效。",
    credHint: "userToken（chat.deepseek.com 登录后 localStorage 里的 JWT）或官方 API Key（sk- 开头）",
    models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-search"],
  },
  {
    type: "kimiweb",
    name: "Kimi 网页版",
    slug: "kimi-web",
    baseUrl: "https://www.kimi.ai",
    desc: "Kimi 网页 Connect-RPC 协议反代，refresh_token 自动续期。",
    credHint: "access_token(JWT) 或 refresh_token（www.kimi.ai 登录后 Local Storage）",
    models: ["k3", "k3-agent-ultra", "k2d6", "k2d6-search"],
  },
  {
    type: "geminiweb",
    name: "Gemini 网页版",
    slug: "gemini-web",
    baseUrl: "https://gemini.google.com",
    desc: "Gemini 网页 Cookie 反代（SAPISIDHASH 鉴权）。",
    credHint: "Cookie 字符串（含 __Secure-1PSID / __Secure-3PSID / SAPISID）",
    models: ["gemini-3.7-flash", "gemini-3.1-pro", "gemini-3.5-flash-thinking"],
  },
  {
    type: "minimaxweb",
    name: "MiniMax Agent 网页版",
    slug: "minimax-web",
    baseUrl: "https://agent.minimaxi.com",
    desc: "MiniMax Agent 网页 SSE 反代，需要网页会话签名参数。",
    credHint: "token|agentId|uuid|deviceId|userId（token 为 JWT，其余可从 HAR 取，至少填 token）",
    models: ["MiniMax-M3", "MiniMax-M3-thinking", "MiniMax-M2.1"],
  },
  {
    type: "lingxi",
    name: "灵犀网页版（中国移动）",
    slug: "lingxi-web",
    baseUrl: "https://ai.yun.139.com",
    desc: "中国移动灵犀网页反代，Basic 授权 + userId。",
    credHint: "authorization|userId|sourceChannel（authorization 形如 Basic xxx）",
    models: ["lingxi-default", "qwen-3.7-plus", "deepseek-4.0-pro"],
  },
  {
    type: "chatgptweb",
    name: "ChatGPT 网页版",
    slug: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    desc: "ChatGPT 网页/App 协议反代（sentinel + PoW），适合 Free 账号。",
    credHint: "refresh_token（rt_xxx / rt.1.xxx；也支持发货整行自动提取）",
    models: ["gpt-5-5", "gpt-5-4", "gpt-5-3"],
  },
];

type WebDialogState = {
  meta: WebMeta;
  provider: Provider | null;
  name: string;
  slug: string;
  baseUrl: string;
  credential: string;
  saving?: boolean;
};

export default function Providers() {
  const [rows, setRows] = useState<Provider[] | null>(null);
  const [tab, setTab] = useState<"direct" | "oauth" | "web">("direct");
  const [dlg, setDlg] = useState(false);
  const [form, setForm] = useState({ id: "", name: "DeepSeek", slug: "deepseek", kind: "openai_compat", url: "https://api.deepseek.com", key: "" });
  const [saving, setSaving] = useState(false);
  const [keyDlg, setKeyDlg] = useState<Provider | null>(null);
  const [keyVal, setKeyVal] = useState("");
  const [newKeyLabel, setNewKeyLabel] = useState("prod");
  // 模型导入流程
  const [importStep, setImportStep] = useState<{ providerId: string; providerName: string; models: string[]; picked: Set<string>; loading: boolean; error?: string } | null>(null);
  const [customModelInput, setCustomModelInput] = useState("");
  // OAuth 授权流程
  const [oauthDlg, setOauthDlg] = useState<OAuthDialogState | null>(null);
  const oauthTimer = useRef<number | null>(null);
  // Web 反代接入流程
  const [webDlg, setWebDlg] = useState<WebDialogState | null>(null);
  const { confirm, confirmEl } = useConfirm();
  const toast = useToast();

  const load = () => adminAction<{ providers: Provider[] }>("list_providers").then((d) => setRows(d.providers)).catch((e) => toast(e.message, "err"));
  useEffect(() => { load(); }, []);
  useEffect(() => () => stopOAuthPoll(), []);

  const openNew = () => {
    setForm({ id: "", name: "DeepSeek", slug: "deepseek", kind: "openai_compat", url: "https://api.deepseek.com", key: "" });
    setDlg(true);
  };
  const openEdit = (p: Provider) => {
    setForm({
      id: p.id,
      name: p.name,
      slug: p.slug,
      kind: p.kind || (p.slug === "anthropic" ? "anthropic" : "openai_compat"),
      url: p.base_url,
      key: "",
    });
    setDlg(true);
  };

  const applyPreset = (key: string) => {
    const pre = PRESETS[key];
    if (pre) {
      setForm((f) => ({ ...f, name: pre.name, slug: pre.slug, kind: pre.kind, url: pre.url }));
    }
  };

  /** 保存供应商；成功后自动拉取上游模型列表进入导入步骤 */
  const save = async () => {
    if (!form.name.trim()) return toast("请填写供应商名称", "err");
    if (!form.slug.trim()) return toast("请填写渠道标识符 (Slug)", "err");
    const isKeyless = isKeylessSlug(form.slug);
    if (!form.id && !form.key.trim() && !isKeyless) return toast("添加供应商必须录入上游密钥", "err");
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        slug: form.slug.trim().toLowerCase(),
        kind: form.kind,
        baseUrl: form.url.trim(),
      };
      if (form.id) payload.id = form.id;
      if (form.key.trim()) payload.key = form.key.trim();
      await adminAction("upsert_provider", payload);
      const providerId = form.id || (await adminAction<{ providers: Provider[] }>("list_providers")).providers.find((x) => x.name === form.name)?.id || "";
      toast("供应商已保存");
      setDlg(false); load();
      if (providerId) {
        setImportStep({ providerId, providerName: form.name, models: [], picked: new Set(), loading: true });
        await pullModels(providerId, form.name, form.url, form.key.trim());
      }
    } catch (e) { toast((e as Error).message, "err"); } finally { setSaving(false); }
  };

  /** 各供应商最近一次录入的明文密钥（仅存内存，用于重试时浏览器直拉；不落 localStorage） */
  const keyMemo = useRef<Record<string, string>>({});

  /** 浏览器直拉上游 /v1/models（CORS 已开放）；失败回退后端代理 */
  const pullModels = async (providerId: string, providerName: string, baseUrl: string, key: string) => {
    if (key) keyMemo.current[providerId] = key;
    const effectiveKey = key || keyMemo.current[providerId] || "";
    let models: string[] | null = null;
    if (effectiveKey && baseUrl) {
      try {
        const resp = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`, {
          headers: { authorization: `Bearer ${effectiveKey}` },
          signal: AbortSignal.timeout(20000),
        });
        if (resp.ok) {
          const d = await resp.json() as { data?: { id?: string }[] };
          models = (d.data ?? []).map((m) => m.id).filter((x): x is string => !!x).sort();
        }
        // 401/403（密钥无效）与其他非 200：都回退后端兜底
      } catch { /* 回退后端 */ }
    }
    if (models === null) {
      try {
        const r = await adminAction<{ models: string[] }>("list_upstream_models", { providerId });
        models = r.models;
      } catch (e) {
        setImportStep({ providerId, providerName, models: [], picked: new Set(), loading: false, error: (e as Error).message });
        return;
      }
    }
    setImportStep({ providerId, providerName, models: models ?? [], picked: new Set(models ?? []), loading: false });
  };

  const openManualAdd = (providerId: string, providerName: string) => {
    // 直接打开空清单弹窗，走下方「手动输入模型名」流程
    setCustomModelInput("");
    setImportStep({ providerId, providerName, models: [], picked: new Set(), loading: false });
  };

  const fetchModels = async (providerId: string, providerName: string) => {
    const p = (rows ?? []).find((x) => x.id === providerId);
    // 弹窗内先切到 loading，避免旧列表残留；有本会话内存密钥时优先浏览器直拉，否则自动回退后端
    setImportStep({ providerId, providerName, models: [], picked: new Set(), loading: true });
    await pullModels(providerId, providerName, p?.base_url ?? "", "");
  };

  const addCustomModel = () => {
    if (!customModelInput.trim() || !importStep) return;
    const names = customModelInput.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (!names.length) return;
    const newModels = Array.from(new Set([...importStep.models, ...names]));
    const newPicked = new Set(importStep.picked);
    names.forEach((n) => newPicked.add(n));
    setImportStep({ ...importStep, models: newModels, picked: newPicked });
    setCustomModelInput("");
    toast(`已添加 ${names.length} 个模型到勾选列表`);
  };

  const importPicked = async () => {
    if (!importStep) return;
    const picked = [...importStep.picked];
    if (!picked.length) return toast("请至少选择一个模型", "err");
    try {
      const r = await adminAction<{ result?: { imported?: number } }>("import_models", { providerId: importStep.providerId, models: picked, priority: 10 });
      toast(`已导入 ${r.result?.imported ?? picked.length} 个模型，可在「模型与定价」调整定价`);
      setImportStep(null); load();
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const saveKey = async () => {
    if (!keyVal.trim() || !keyDlg) return;
    try {
      const r = await adminAction<{ result?: { fingerprint?: string } }>("upsert_provider_key", {
        providerId: keyDlg.id,
        key: keyVal.trim(),
        label: newKeyLabel.trim() || (isOAuthProvider(keyDlg) || isWebProvider(keyDlg) ? `account-${(keyDlg.key_count ?? 0) + 1}` : "prod"),
      });
      toast(isOAuthProvider(keyDlg) || isWebProvider(keyDlg) ? `账号凭据已加密入库（指纹 ${r.result?.fingerprint ?? ""}）` : `密钥已加密入库（指纹 ${r.result?.fingerprint ?? ""}）`);
      const keyInput = keyVal.trim();
      setKeyVal("");
      const updated = await adminAction<{ providers: Provider[] }>("list_providers");
      setRows(updated.providers);
      const targetP = updated.providers.find((x) => x.id === keyDlg.id);
      if (targetP) setKeyDlg(targetP);
      // 首次录入后自动尝试拉取上游模型列表
      if (!isOAuthProvider(keyDlg) && (!targetP || (targetP.keys && targetP.keys.length <= 1))) {
        setImportStep({ providerId: keyDlg.id, providerName: keyDlg.name, models: [], picked: new Set(), loading: true });
        await pullModels(keyDlg.id, keyDlg.name, keyDlg.base_url, isWebProvider(keyDlg) ? "" : keyInput);
      }
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const delKey = async (providerId: string, keyId: string) => {
    if (!(await confirm("确认删除该凭据？该凭据将从多 Key 调度池中彻底移除。"))) return;
    try {
      await adminAction("delete_provider_key", { providerId, keyId });
      toast("凭据已从池中删除");
      const updated = await adminAction<{ providers: Provider[] }>("list_providers");
      setRows(updated.providers);
      const targetP = updated.providers.find((x) => x.id === providerId);
      if (targetP) setKeyDlg(targetP);
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const toggleKey = async (providerId: string, keyId: string, currentStatus: "active" | "disabled") => {
    const nextStatus = currentStatus === "active" ? "disabled" : "active";
    try {
      await adminAction("toggle_provider_key", { providerId, keyId, status: nextStatus });
      toast(`账号已${nextStatus === "active" ? "启用" : "停用"}`);
      const updated = await adminAction<{ providers: Provider[] }>("list_providers");
      setRows(updated.providers);
      const targetP = updated.providers.find((x) => x.id === providerId);
      if (targetP) setKeyDlg(targetP);
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const toggleProvider = async (p: Provider) => {
    const nextStatus = p.status === "active" ? "disabled" : "active";
    try {
      await adminAction("toggle_provider", { id: p.id, status: nextStatus });
      toast(`已${nextStatus === "active" ? "启用" : "停用"}渠道「${p.name}」`);
      load();
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const del = async (p: Provider) => {
    if (!(await confirm(`删除供应商「${p.name}」？其模型映射与上游凭据将一并删除，不可恢复。`))) return;
    try {
      await adminAction("delete_provider", { id: p.id });
      toast("已删除"); load();
    } catch (e) { toast((e as Error).message, "err"); }
  };

  /* ---------------- OAuth 授权流程 ---------------- */

  const stopOAuthPoll = () => {
    if (oauthTimer.current !== null) {
      window.clearTimeout(oauthTimer.current);
      oauthTimer.current = null;
    }
  };

  const closeOAuth = () => { stopOAuthPoll(); setOauthDlg(null); };

  const copyText = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast("已复制到剪贴板"); }
    catch { toast("复制失败，请手动选择复制", "err"); }
  };

  /** 渠道默认 Base URL（CodeBuddy 国内版/国际版各有独立目录项与 baseUrl） */
  const oauthBaseUrl = (meta: OAuthMeta, existing?: Provider | null) => existing?.base_url || meta.baseUrl;

  /** 授权成功后：按需创建渠道 + 加密保存 refresh_token + 自动拉取模型 */
  const finishOAuth = async (meta: OAuthMeta, existing: Provider | null, baseUrl: string, refreshToken: string) => {
    setOauthDlg((d) => (d ? { ...d, busy: true, message: "正在保存账号凭据…" } : d));
    try {
      let providerId = existing?.id || "";
      if (!providerId) {
        await adminAction("upsert_provider", {
          name: meta.name,
          slug: meta.slug,
          kind: `oauth:${meta.type}`,
          baseUrl,
        });
        const d = await adminAction<{ providers: Provider[] }>("list_providers");
        providerId = d.providers.find((x) => x.slug === meta.slug)?.id || "";
        setRows(d.providers);
      }
      if (!providerId) throw new Error("OAuth 渠道创建失败");
      const r = await adminAction<{ result?: { fingerprint?: string } }>("upsert_provider_key", {
        providerId,
        key: refreshToken,
        label: `account-${(existing?.key_count ?? 0) + 1}`,
      });
      toast(`授权成功，账号已加密入库（指纹 ${r.result?.fingerprint ?? ""}）`);
      stopOAuthPoll();
      setOauthDlg(null);
      const updated = await adminAction<{ providers: Provider[] }>("list_providers");
      setRows(updated.providers);
      setImportStep({ providerId, providerName: meta.name, models: [], picked: new Set(), loading: true });
      await pullModels(providerId, meta.name, baseUrl, "");
    } catch (e) {
      const msg = (e as Error).message;
      toast(msg, "err");
      setOauthDlg((d) => (d ? { ...d, step: "error", message: msg, busy: false } : d));
    }
  };

  const startOAuthPoll = (meta: OAuthMeta, existing: Provider | null, baseUrl: string, state: string, intervalSec: number) => {
    const poll = async () => {
      try {
        const r = await adminAction<any>("oauth_poll", { provider: meta.type, state });
        const res = r.result ?? r;
        const token = res.refresh_token || res.refreshToken;
        if (res.status === "ok" && token) {
          await finishOAuth(meta, existing, baseUrl, token as string);
          return;
        }
        if (res.status === "error") {
          setOauthDlg((d) => (d ? { ...d, step: "error", message: res.message || "授权失败" } : d));
          return;
        }
        setOauthDlg((d) => (d ? { ...d, message: "等待你在浏览器中确认授权…" } : d));
        oauthTimer.current = window.setTimeout(poll, Math.max(2, intervalSec) * 1000);
      } catch (e) {
        setOauthDlg((d) => (d ? { ...d, step: "error", message: (e as Error).message } : d));
      }
    };
    oauthTimer.current = window.setTimeout(poll, Math.max(2, intervalSec) * 1000);
  };

  const beginOAuth = async (meta: OAuthMeta, existing?: Provider) => {
    stopOAuthPoll();
    const baseUrl = oauthBaseUrl(meta, existing ?? null);
    setOauthDlg({
      meta,
      provider: existing ?? null,
      mode: meta.mode,
      baseUrl,
      url: "",
      state: "",
      step: "loading",
      codeInput: "",
    });
    try {
      const r = await adminAction<any>("oauth_start", { provider: meta.type, baseUrl });
      const d = r.result ?? {};
      const mode = (d.mode as "redirect" | "device" | "redirect-poll") || meta.mode;
      setOauthDlg({
        meta,
        provider: existing ?? null,
        mode,
        baseUrl,
        url: d.url ?? "",
        state: d.state ?? "",
        userCode: d.user_code,
        verificationUri: d.verification_uri,
        verificationUriComplete: d.verification_uri_complete,
        interval: Number(d.interval) || 5,
        step: mode === "redirect" ? "ready" : "polling",
        codeInput: "",
        message: mode === "device" ? "等待你在浏览器中确认授权…" : mode === "redirect-poll" ? "等待你在浏览器中完成登录…" : undefined,
      });
      if (mode !== "redirect" && d.state) {
        startOAuthPoll(meta, existing ?? null, baseUrl, d.state as string, Number(d.interval) || 5);
      }
    } catch (e) {
      setOauthDlg((d) => (d ? { ...d, step: "error", message: (e as Error).message } : d));
    }
  };

  const completeOAuthNow = async () => {
    if (!oauthDlg) return;
    if (!oauthDlg.codeInput.trim()) return toast("请粘贴授权返回的 code 或整段回调地址", "err");
    setOauthDlg({ ...oauthDlg, busy: true, message: "正在换取 access_token…" });
    try {
      const r = await adminAction<any>("oauth_complete", {
        provider: oauthDlg.meta.type,
        code: oauthDlg.codeInput.trim(),
        state: oauthDlg.state,
      });
      const token = r.result?.refreshToken;
      if (!token) throw new Error("上游未返回 refresh_token");
      await finishOAuth(oauthDlg.meta, oauthDlg.provider, oauthDlg.baseUrl, token);
    } catch (e) {
      toast((e as Error).message, "err");
      setOauthDlg((d) => (d ? { ...d, step: "error", message: (e as Error).message, busy: false } : d));
    }
  };

  const retryOAuth = () => {
    if (!oauthDlg) return;
    beginOAuth(oauthDlg.meta, oauthDlg.provider ?? undefined);
  };

  /* ---------------- Web 反代接入流程 ---------------- */

  const beginWebAdd = (meta: WebMeta, existing?: Provider) => {
    setWebDlg({
      meta,
      provider: existing ?? null,
      name: existing?.name ?? meta.name,
      slug: existing?.slug ?? meta.slug,
      baseUrl: existing?.base_url ?? meta.baseUrl,
      credential: "",
    });
  };

  const saveWeb = async () => {
    if (!webDlg) return;
    const d = webDlg;
    if (!d.credential.trim()) return toast("请粘贴账号凭据", "err");
    if (!d.provider) {
      if (!d.name.trim()) return toast("请填写渠道名称", "err");
      if (!d.slug.trim()) return toast("请填写渠道 Slug", "err");
      if (!d.baseUrl.trim()) return toast("请填写 Base URL", "err");
    }
    setWebDlg({ ...d, saving: true });
    try {
      let providerId = d.provider?.id || "";
      if (providerId) {
        await adminAction("upsert_provider_key", {
          providerId,
          key: d.credential.trim(),
          label: `account-${(d.provider?.key_count ?? 0) + 1}`,
        });
      } else {
        await adminAction("upsert_provider", {
          name: d.name.trim(),
          slug: d.slug.trim().toLowerCase(),
          kind: `web:${d.meta.type}`,
          baseUrl: d.baseUrl.trim(),
          key: d.credential.trim(),
        });
        const list = await adminAction<{ providers: Provider[] }>("list_providers");
        providerId = list.providers.find((x) => x.slug === d.slug.trim().toLowerCase())?.id || "";
        setRows(list.providers);
      }
      if (!providerId) throw new Error("Web 渠道创建失败");
      toast("Web 渠道凭据已加密入库");
      setWebDlg(null);
      load();
      setImportStep({ providerId, providerName: d.name, models: [], picked: new Set(), loading: true });
      await pullModels(providerId, d.name, d.baseUrl, "");
    } catch (e) {
      toast((e as Error).message, "err");
      setWebDlg((s) => (s ? { ...s, saving: false } : s));
    }
  };

  /* ---------------- 渲染 ---------------- */

  const oauthProviderOf = (meta: OAuthMeta) => (rows ?? []).find((x) => x.slug === meta.slug);
  const webProviderOf = (meta: WebMeta) => (rows ?? []).find((x) => x.slug === meta.slug);
  const webMetaOf = (p?: Provider | null) => (p ? WEB_CATALOG.find((m) => m.slug === p.slug) : undefined);
  const keyWebMeta = webMetaOf(keyDlg);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex w-full gap-1 overflow-x-auto rounded-lg bg-surface2 p-0.5 sm:w-fit" role="tablist">
        {([
          ["direct", "API 直连"],
          ["oauth", "OAuth 授权"],
          ["web", "Web 反代"],
        ] as const).map(([k, l]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn(
              "rounded-md px-4 py-1.5 text-xs font-medium transition-colors",
              tab === k ? "bg-surface text-brand shadow-sm" : "text-muted hover:text-ink"
            )}
          >
            {l}
          </button>
        ))}
      </div>

      {tab === "direct" && (
        <>
          <div className="flex justify-end">
            <Button onClick={openNew}><Plus size={14} />添加供应商</Button>
          </div>

          {rows === null ? (
            <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {[...Array(8)].map((_, i) => <div key={i} className="skeleton h-36 rounded-xl2" />)}
            </div>
          ) : rows.filter((p) => !isOAuthProvider(p) && !isWebProvider(p)).length === 0 ? (
            <Card><EmptyState icon={<Server size={32} />} title="还没有上游供应商" hint="添加你持有授权的供应商并录入密钥，即可一键导入模型列表。" action={<Button className="mt-2" onClick={openNew}>添加供应商</Button>} /></Card>
          ) : (
            <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {rows.filter((p) => !isOAuthProvider(p) && !isWebProvider(p)).map((p) => (
                <Card key={p.id} className={cn("p-4 flex flex-col justify-between transition-all", p.status === "disabled" && "opacity-75 border-dashed bg-surface/50")}>
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-sm font-bold text-brand">{p.name[0]}</div>
                        <div className="min-w-0">
                          <div className="truncate text-xs font-semibold leading-tight">{p.name}</div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <code className="text-[10px] text-muted font-mono">{p.slug}</code>
                            <span className="text-[9px] rounded bg-line px-1 text-muted">
                              {p.slug === "anthropic" || p.kind === "anthropic" ? "Anthropic 原生" : isKeylessSlug(p.slug) ? "免 Key" : "OpenAI 兼容"}
                            </span>
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleProvider(p)}
                        title={`点击${p.status === "active" ? "停用" : "启用"}该渠道（停用后相应模型在模型池与定价中隐藏）`}
                        className="cursor-pointer transition-transform hover:scale-105 shrink-0"
                      >
                        <StatusTag value={p.status} />
                      </button>
                    </div>
                    <dl className="mt-3 space-y-1.5 text-[11px] text-muted">
                      <div className="flex min-w-0 justify-between gap-2">
                        <span className="shrink-0 text-muted">端点</span>
                        <code className="truncate text-ink max-w-[140px]" title={p.base_url}>{p.base_url}</code>
                      </div>
                      <div className="flex justify-between items-center">
                        <span>密钥</span>
                        <span className="text-ink truncate">
                          {isKeylessSlug(p.slug) ? (
                            <span className="text-emerald-500 font-medium">免 Key</span>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              {p.key_count} 个
                              {p.key_count === 0 ? (
                                <span className="text-warn">（未录）</span>
                              ) : p.keys?.some((k) => k.health_status === "demoted") ? (
                                <span className="text-err font-medium text-[10px]">有熔断</span>
                              ) : (
                                <span className="text-emerald-500 font-medium text-[10px]">就绪</span>
                              )}
                            </span>
                          )}
                        </span>
                      </div>
                      {p.authorization_expires_at && (
                        <div className="flex justify-between">
                          <span>授权到期</span>
                          <span className="text-ink">{new Date(p.authorization_expires_at * 1000).toLocaleDateString("zh-CN")}</span>
                        </div>
                      )}
                    </dl>
                  </div>

                  <div className="mt-3.5 flex items-center gap-1.5 border-t border-line pt-2.5">
                    <Button variant="soft" className="!h-7 !w-7 !px-0" onClick={() => fetchModels(p.id, p.name)} title="从上游导入或手动添加模型" aria-label="导入模型">
                      <RefreshCw size={13} />
                    </Button>
                    <Button variant="soft" className="!h-7 !w-7 !px-0" onClick={() => openManualAdd(p.id, p.name)} title="手动添加模型" aria-label="手动添加模型">
                      <Plus size={13} />
                    </Button>
                    {!isKeylessSlug(p.slug) && (
                      <Button variant="soft" className="!h-7 !w-7 !px-0" onClick={() => { setKeyDlg(p); setKeyVal(""); setNewKeyLabel("prod"); }} title={`管理多 Key 轮换池（当前 ${p.key_count} 个）`} aria-label="密钥池">
                        <Key size={13} />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      className={cn("!h-7 !w-7 !px-0", p.status === "active" ? "!text-muted hover:!text-err" : "!text-emerald-500 font-semibold")}
                      onClick={() => toggleProvider(p)}
                      title={`切换渠道启用/停用状态（当前${p.status === "active" ? "启用" : "停用"}）`}
                      aria-label={p.status === "active" ? "停用渠道" : "启用渠道"}
                    >
                      <Power size={13} />
                    </Button>
                    <Button variant="ghost" className="!h-7 !w-7 !px-0" onClick={() => openEdit(p)} title="编辑供应商" aria-label="编辑供应商"><Pencil size={13} /></Button>
                    <Button variant="ghost" className="!h-7 !w-7 !px-0 !text-err" onClick={() => del(p)} title="删除供应商" aria-label={`删除 ${p.name}`}><Trash2 size={13} /></Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "oauth" && (
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-line bg-surface2/50 p-3 text-xs text-muted leading-relaxed">
            OAuth 渠道通过账号授权接入（实现移植自 CLIProxyAPI）：refresh_token 经 AES-256-GCM 加密后存入渠道凭据池，
            access_token 自动刷新；同一渠道可授权多个账号，自动轮换、遇 429/401 自动熔断冷却。
          </div>

          {rows === null ? (
            <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {[...Array(8)].map((_, i) => <div key={i} className="skeleton h-40 rounded-xl2" />)}
            </div>
          ) : (
            <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {OAUTH_CATALOG.map((meta) => {
                const p = oauthProviderOf(meta);
                return (
                  <Card key={meta.slug} className={cn("p-4 flex flex-col justify-between transition-all", p?.status === "disabled" && "opacity-75 border-dashed bg-surface/50")}>
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
                            <ShieldCheck size={16} />
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-xs font-semibold leading-tight">{meta.name}</div>
                            <div className="mt-0.5 flex items-center gap-1.5">
                              <code className="text-[10px] text-muted font-mono">{meta.slug}</code>
                              <span className="rounded bg-brand/10 px-1 text-[9px] font-medium text-brand">OAuth</span>
                            </div>
                          </div>
                        </div>
                        {p ? (
                          <button type="button" onClick={() => toggleProvider(p)} title="点击切换启用/停用" className="shrink-0 cursor-pointer transition-transform hover:scale-105">
                            <StatusTag value={p.status} />
                          </button>
                        ) : (
                          <span className="shrink-0 rounded bg-line px-1.5 py-0.5 text-[10px] text-muted">未接入</span>
                        )}
                      </div>

                      <p className="mt-2.5 text-[11px] leading-relaxed text-muted">{meta.desc}</p>

                      <dl className="mt-2.5 space-y-1.5 text-[11px] text-muted">
                        <div className="flex min-w-0 justify-between gap-2">
                          <span className="shrink-0">授权方式</span>
                          <span className="text-ink">
                            {meta.mode === "device" ? "设备码轮询" : meta.mode === "redirect-poll" ? "授权链接 + 轮询" : "PKCE 授权链接"}
                          </span>
                        </div>
                        <div className="flex min-w-0 justify-between gap-2">
                          <span className="shrink-0">账号</span>
                          <span className="inline-flex items-center gap-1 text-ink">
                            <Users size={11} className="text-muted" />
                            {p ? `${p.key_count} 个` : "—"}
                            {p && p.key_count > 0 && (
                              p.keys?.some((k) => k.health_status === "demoted")
                                ? <span className="text-[10px] font-medium text-err">有熔断</span>
                                : <span className="text-[10px] font-medium text-emerald-500">就绪</span>
                            )}
                          </span>
                        </div>
                        <div className="flex min-w-0 justify-between gap-2">
                          <span className="shrink-0">候选模型</span>
                          <code className="truncate text-ink max-w-[170px]" title={meta.models.join(", ")}>{meta.models[0]} 等 {meta.models.length} 个</code>
                        </div>
                      </dl>
                    </div>

                    <div className="mt-3.5 flex items-center gap-1.5 border-t border-line pt-2.5">
                      <Button variant="soft" className="!h-7 !px-2.5 text-[11px]" onClick={() => beginOAuth(meta, p)}>
                        <LogIn size={12} />{p ? "授权新账号" : "授权并添加"}
                      </Button>
                      {p && (
                        <>
                          <Button variant="soft" className="!h-7 !w-7 !px-0" onClick={() => fetchModels(p.id, p.name)} title="拉取/导入模型" aria-label="模型管理">
                            <RefreshCw size={13} />
                          </Button>
                          <Button variant="soft" className="!h-7 !w-7 !px-0" onClick={() => { setKeyDlg(p); setKeyVal(""); setNewKeyLabel(`account-${p.key_count + 1}`); }} title="管理授权账号" aria-label="账号管理">
                            <Key size={13} />
                          </Button>
                          <Button
                            variant="ghost"
                            className={cn("!h-7 !w-7 !px-0 ml-auto", p.status === "active" ? "!text-muted hover:!text-err" : "!text-emerald-500 font-semibold")}
                            onClick={() => toggleProvider(p)}
                            title={p.status === "active" ? "停用渠道" : "启用渠道"}
                            aria-label={p.status === "active" ? "停用渠道" : "启用渠道"}
                          >
                            <Power size={13} />
                          </Button>
                          <Button variant="ghost" className="!h-7 !w-7 !px-0 !text-err" onClick={() => del(p)} title="删除渠道" aria-label="删除渠道"><Trash2 size={13} /></Button>
                        </>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "web" && (
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-line bg-surface2/50 p-3 text-xs text-muted leading-relaxed">
            Web 反代渠道使用浏览器网页会话凭据（Cookie / userToken / refresh_token），无需官方 API Key；
            凭据经 AES-256-GCM 加密后存入渠道凭据池，多账号自动轮换，遇 401/429 自动熔断。
          </div>

          {rows === null ? (
            <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {[...Array(6)].map((_, i) => <div key={i} className="skeleton h-40 rounded-xl2" />)}
            </div>
          ) : (
            <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {WEB_CATALOG.map((meta) => {
                const p = webProviderOf(meta);
                return (
                  <Card key={meta.slug} className={cn("p-4 flex flex-col justify-between transition-all", p?.status === "disabled" && "opacity-75 border-dashed bg-surface/50")}>
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
                            <Globe size={16} />
                          </div>
                          <div className="min-w-0">
                            <div className="truncate text-xs font-semibold leading-tight">{meta.name}</div>
                            <div className="mt-0.5 flex items-center gap-1.5">
                              <code className="text-[10px] text-muted font-mono">{meta.slug}</code>
                              <span className="rounded bg-amber-500/10 px-1 text-[9px] font-medium text-amber-500">Web</span>
                            </div>
                          </div>
                        </div>
                        {p ? (
                          <button type="button" onClick={() => toggleProvider(p)} title="点击切换启用/停用" className="shrink-0 cursor-pointer transition-transform hover:scale-105">
                            <StatusTag value={p.status} />
                          </button>
                        ) : (
                          <span className="shrink-0 rounded bg-line px-1.5 py-0.5 text-[10px] text-muted">未接入</span>
                        )}
                      </div>

                      <p className="mt-2.5 text-[11px] leading-relaxed text-muted">{meta.desc}</p>

                      <dl className="mt-2.5 space-y-1.5 text-[11px] text-muted">
                        <div className="flex min-w-0 justify-between gap-2">
                          <span className="shrink-0">凭据</span>
                          <code className="truncate text-ink max-w-[190px]" title={meta.credHint}>{meta.credHint}</code>
                        </div>
                        <div className="flex min-w-0 justify-between gap-2">
                          <span className="shrink-0">账号</span>
                          <span className="inline-flex items-center gap-1 text-ink">
                            <Users size={11} className="text-muted" />
                            {p ? `${p.key_count} 个` : "—"}
                            {p && p.key_count > 0 && (
                              p.keys?.some((k) => k.health_status === "demoted")
                                ? <span className="text-[10px] font-medium text-err">有熔断</span>
                                : <span className="text-[10px] font-medium text-emerald-500">就绪</span>
                            )}
                          </span>
                        </div>
                        <div className="flex min-w-0 justify-between gap-2">
                          <span className="shrink-0">候选模型</span>
                          <code className="truncate text-ink max-w-[170px]" title={meta.models.join(", ")}>{meta.models[0]} 等 {meta.models.length} 个</code>
                        </div>
                      </dl>
                    </div>

                    <div className="mt-3.5 flex items-center gap-1.5 border-t border-line pt-2.5">
                      <Button variant="soft" className="!h-7 !px-2.5 text-[11px]" onClick={() => beginWebAdd(meta, p)}>
                        <Plus size={12} />{p ? "添加账号" : "接入并添加"}
                      </Button>
                      {p && (
                        <>
                          <Button variant="soft" className="!h-7 !w-7 !px-0" onClick={() => fetchModels(p.id, p.name)} title="拉取/导入模型" aria-label="模型管理">
                            <RefreshCw size={13} />
                          </Button>
                          <Button variant="soft" className="!h-7 !w-7 !px-0" onClick={() => { setKeyDlg(p); setKeyVal(""); setNewKeyLabel(`account-${p.key_count + 1}`); }} title="管理账号凭据" aria-label="账号管理">
                            <Key size={13} />
                          </Button>
                          <Button
                            variant="ghost"
                            className={cn("!h-7 !w-7 !px-0 ml-auto", p.status === "active" ? "!text-muted hover:!text-err" : "!text-emerald-500 font-semibold")}
                            onClick={() => toggleProvider(p)}
                            title={p.status === "active" ? "停用渠道" : "启用渠道"}
                            aria-label={p.status === "active" ? "停用渠道" : "启用渠道"}
                          >
                            <Power size={13} />
                          </Button>
                          <Button variant="ghost" className="!h-7 !w-7 !px-0 !text-err" onClick={() => del(p)} title="删除渠道" aria-label="删除渠道"><Trash2 size={13} /></Button>
                        </>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 添加/编辑供应商 */}
      <Dialog open={dlg} onClose={() => setDlg(false)} title={form.id ? "编辑供应商" : "添加供应商"} width={560}>
        <div className="space-y-3.5">
          {!form.id && (
            <Field label="快速载入预设模板（可选，点击快速填入）">
              <Select onChange={(e) => applyPreset(e.target.value)} defaultValue="">
                <option value="">自定义或选择常见预设...</option>
                {Object.entries(PRESETS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.name}（{v.kind === "anthropic" ? "Anthropic 官方" : "OpenAI 兼容"}）
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="供应商名称">
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如: DeepSeek 或 OpenAI"
              />
            </Field>
            <Field label="渠道标识 (Slug)">
              <Input
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                placeholder="例如: deepseek"
              />
            </Field>
            <div className="col-span-1 sm:col-span-2">
              <Field label="接口协议类型 (Protocol)">
                <Select
                  value={form.kind}
                  onChange={(e) => {
                    const nextKind = e.target.value;
                    setForm({
                      ...form,
                      kind: nextKind,
                      url: nextKind === "anthropic" ? "https://api.anthropic.com" : form.url,
                    });
                  }}
                >
                  <option value="openai_compat">OpenAI 兼容协议 (OpenAI / DeepSeek / Kilo / OpenCode / Google 等)</option>
                  <option value="anthropic">Anthropic 官方协议 (Claude 原生 Messages)</option>
                </Select>
              </Field>
            </div>
            <div className="col-span-1 sm:col-span-2">
              <Field label={form.kind === "anthropic" ? "Base URL（Anthropic 官方端点）" : "Base URL（OpenAI 兼容端点）"}>
                <Input
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder={form.kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com"}
                />
              </Field>
            </div>
            <div className="col-span-1 sm:col-span-2">
              <Field label={isKeylessSlug(form.slug) ? "上游密钥（免 Key 渠道，无需填写）" : form.id ? "追加新密钥（留空保持不变，支持多行批量录入）" : "上游密钥（必填，支持粘贴多个一行一个）"}>
                <textarea
                  value={form.key}
                  onChange={(e) => setForm({ ...form, key: e.target.value })}
                  placeholder={isKeylessSlug(form.slug) ? "该渠道完全免费免 Key，直接保存即可" : "sk-xxxxxxxxxxxxxxxx\nsk-yyyyyyyyyyyyyyyy (支持粘贴多个Key一行一个，自动进入多Key轮换池)"}
                  rows={2}
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs font-mono text-ink placeholder:text-muted/60 focus:border-brand focus:outline-none"
                />
              </Field>
            </div>
          </div>

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2 border-t border-line">
            <Button variant="ghost" className="flex-1 sm:flex-initial" onClick={() => setDlg(false)}>取消</Button>
            <Button className="flex-1 sm:flex-initial" disabled={saving} onClick={save}>{saving ? "保存中…" : "保存并获取模型列表"}</Button>
          </div>
        </div>
      </Dialog>

      {/* 模型导入 / 手动添加 */}
      <Dialog open={!!importStep} onClose={() => setImportStep(null)} title={`渠道模型管理 — ${importStep?.providerName ?? ""}`} width={540}>
        {importStep?.loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted"><RefreshCw size={16} className="animate-spin" />正在从上游拉取模型列表…</div>
        ) : importStep?.error ? (
          <div className="py-4">
            <p className="text-[13px] text-err mb-3">{importStep.error}</p>
            <div className="rounded-lg border border-dashed border-line p-3 bg-surface2/30 mb-4">
              <div className="text-xs font-semibold text-ink mb-1.5">手动添加模型（跳过自动发现）</div>
              <div className="flex gap-2">
                <Input
                  className="!py-1 text-xs"
                  value={customModelInput}
                  onChange={(e) => setCustomModelInput(e.target.value)}
                  placeholder="如: deepseek-chat, deepseek-reasoner"
                />
                <Button variant="soft" className="!h-[34px] !px-3 shrink-0 text-xs" onClick={addCustomModel}>
                  加入
                </Button>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setImportStep(null)}>关闭</Button>
              <Button onClick={() => fetchModels(importStep.providerId, importStep.providerName)}><RefreshCw size={14} />重试上游发现</Button>
              {importStep.picked.size > 0 && <Button onClick={importPicked}>导入已加模型 ({importStep.picked.size})</Button>}
            </div>
          </div>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs text-muted">候选模型清单（已勾选 {importStep?.picked.size ?? 0} 个）：</span>
              <div className="flex shrink-0 items-center gap-2">
                <button className="text-xs text-brand hover:underline" onClick={() => importStep && setImportStep({ ...importStep, picked: new Set(importStep.models) })}>全选</button>
                <Button variant="ghost" className="!h-6 !px-2 text-xs" title="重新从上游拉取模型列表"
                  onClick={() => importStep && fetchModels(importStep.providerId, importStep.providerName)}>
                  <RefreshCw size={12} />重新拉取模型
                </Button>
              </div>
            </div>
            <div className="max-h-60 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
              {importStep?.models.length === 0 && <p className="py-6 text-center text-xs text-muted">未发现上游模型，可在下方手动输入模型名称添加</p>}
              {importStep?.models.map((m) => (
                <label key={m} className={cn("flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-1.5 text-xs transition-colors", importStep.picked.has(m) ? "bg-brand/10 text-ink" : "hover:bg-surface2")}>
                  <input type="checkbox" className="h-4 w-4 accent-[#F38020]" checked={importStep.picked.has(m)}
                    onChange={() => { const p = new Set(importStep.picked); if (p.has(m)) p.delete(m); else p.add(m); setImportStep({ ...importStep, picked: p }); }} />
                  <code className="font-mono">{m}</code>
                </label>
              ))}
            </div>

            {/* 手动添加模型栏 */}
            <div className="mt-2.5 rounded-lg border border-dashed border-line p-2.5 bg-surface2/30">
              <div className="text-[11px] font-semibold text-ink mb-1">手动输入模型名（如上游未返回，或自定义模型）</div>
              <div className="flex gap-2">
                <Input
                  className="!py-1 text-xs"
                  value={customModelInput}
                  onChange={(e) => setCustomModelInput(e.target.value)}
                  placeholder="例如: deepseek-chat 或 gpt-5 (支持逗号/换行输入多个)"
                />
                <Button variant="soft" className="!h-[34px] !px-3 shrink-0 text-xs" onClick={addCustomModel}>
                  加入清单
                </Button>
              </div>
            </div>

            <p className="mt-2.5 text-[11px] text-muted">导入后模型即刻上架；对外模型名默认与上游一致，可在「模型与定价」修改或配置自定义别名。</p>
            <div className="mt-3.5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setImportStep(null)}>取消</Button>
              <Button onClick={importPicked} disabled={!importStep?.picked.size}>导入所选模型 ({importStep?.picked.size ?? 0})</Button>
            </div>
          </>
        )}
      </Dialog>

      {/* 凭据池 / 授权账号管理 */}
      <Dialog open={!!keyDlg} onClose={() => setKeyDlg(null)} title={`${isOAuthProvider(keyDlg) ? "授权账号管理" : isWebProvider(keyDlg) ? "Web 账号凭据管理" : "密钥池管理"} — ${keyDlg?.name ?? ""}`} width={560}>
        <div className="space-y-4">
          <p className="text-xs text-muted">
            {isOAuthProvider(keyDlg)
              ? "每个账号对应一条 refresh_token（AES-256-GCM 加密存储），网关自动刷新 access_token 并随机轮换；遇 429/401 自动降权冷却，到期自动恢复。"
              : isWebProvider(keyDlg)
              ? `${keyWebMeta?.credHint ?? "网页会话凭据"}。每个账号一条凭据（AES-256-GCM 加密存储），随机轮换；遇 401/429 自动熔断冷却。`
              : "已开启多 Key 负载均衡与健康熔断。网关使用 Fisher-Yates 随机打散实现均匀轮换分流；遇 429 自动降权跳过并轮换下一个 Key，60 秒后自动试用自愈。"}
          </p>

          {isOAuthProvider(keyDlg) && (
            <Button className="w-full" variant="soft" onClick={() => {
              const p = keyDlg;
              const meta = OAUTH_CATALOG.find((m) => m.slug === p?.slug);
              if (!p || !meta) return;
              setKeyDlg(null);
              beginOAuth(meta, p);
            }}>
              <LogIn size={13} />授权新账号
            </Button>
          )}

          <div className="space-y-2">
            <div className="text-xs font-semibold text-ink flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Key size={13} className="text-brand" />
                {isOAuthProvider(keyDlg) ? `已授权账号（${keyDlg?.keys?.length ?? 0} 个）` : isWebProvider(keyDlg) ? `已接入账号（${keyDlg?.keys?.length ?? 0} 个）` : `当前轮换 Key 列表（${keyDlg?.keys?.length ?? 0} 个）`}
              </span>
              <span className="text-[11px] text-muted">{isOAuthProvider(keyDlg) || isWebProvider(keyDlg) ? "支持多账号自动轮换" : "支持无缝挂载任意多个 Key"}</span>
            </div>

            {(!keyDlg?.keys || keyDlg.keys.length === 0) ? (
              <div className="rounded-lg border border-line p-3 text-center text-xs text-muted">
                {isOAuthProvider(keyDlg) ? "暂无已授权账号，请点击上方「授权新账号」" : isWebProvider(keyDlg) ? "暂无账号凭据，请在下方粘贴" : "暂无密钥，请在下方录入或批量粘贴 Key"}
              </div>
            ) : (
              <div className="max-h-52 space-y-1.5 overflow-y-auto rounded-lg border border-line p-2">
                {keyDlg.keys.map((k) => (
                  <div key={k.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 rounded-lg bg-surface2/60 p-2 sm:px-2.5 sm:py-1.5 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                      <code className="text-ink font-mono font-medium truncate max-w-[120px] sm:max-w-[140px]">{k.fingerprint}...</code>
                      <span className="rounded bg-line px-1 py-0.5 text-[10px] text-muted">{k.label || "prod"}</span>
                      {k.status === "disabled" ? (
                        <span className="rounded bg-zinc-500/10 px-1 py-0.5 text-[10px] text-zinc-400">已停用</span>
                      ) : k.health_status === "demoted" ? (
                        <span className="flex items-center gap-0.5 rounded bg-red-500/10 px-1 py-0.5 text-[10px] font-medium text-red-500">
                          <ShieldAlert size={10} /> 熔断冷却
                        </span>
                      ) : k.health_status === "unhealthy" ? (
                        <span className="flex items-center gap-0.5 rounded bg-amber-500/10 px-1 py-0.5 text-[10px] font-medium text-amber-500">
                          <AlertTriangle size={10} /> 异常({k.failures}次)
                        </span>
                      ) : (
                        <span className="flex items-center gap-0.5 rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] font-medium text-emerald-500">
                          <CheckCircle2 size={10} /> {isOAuthProvider(keyDlg) || isWebProvider(keyDlg) ? "账号就绪" : "轮换就绪"}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-end gap-1 shrink-0 self-end sm:self-auto pt-0.5 sm:pt-0">
                      <Button
                        variant="ghost"
                        className="!h-6 !px-2 text-[11px]"
                        onClick={() => toggleKey(keyDlg.id, k.id, k.status)}
                      >
                        {k.status === "active" ? "停用" : "启用"}
                      </Button>
                      <Button
                        variant="ghost"
                        className="!h-6 !px-2 text-[11px] !text-err"
                        onClick={() => delKey(keyDlg.id, k.id)}
                      >
                        <Trash2 size={11} className="mr-0.5" />删除
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-dashed border-line p-3 space-y-2.5 bg-surface/50">
            <div className="text-xs font-semibold text-ink">{isOAuthProvider(keyDlg) ? "手动追加 refresh_token" : isWebProvider(keyDlg) ? "追加账号凭据" : "批量追加新密钥"}</div>
            <div className="space-y-1">
              <textarea
                value={keyVal}
                onChange={(e) => setKeyVal(e.target.value)}
                placeholder={isOAuthProvider(keyDlg) ? "粘贴 refresh_token，一行一个，例如：\nrt_xxxxxxxxxxxxxxxx\nrt_yyyyyyyyyyyyyyyy" : isWebProvider(keyDlg) ? `每行一个账号凭据，格式：\n${keyWebMeta?.credHint ?? ""}` : "支持单个或批量粘贴多个 Key，一行一个，例如：\nsk-xxxxxxxxxxxxxxxx\nsk-yyyyyyyyyyyyyyyy"}
                rows={3}
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs font-mono text-ink placeholder:text-muted/60 focus:border-brand focus:outline-none"
              />
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted shrink-0">标签</span>
                <Input
                  className="!py-1 flex-1 sm:!w-28 text-xs"
                  value={newKeyLabel}
                  onChange={(e) => setNewKeyLabel(e.target.value)}
                  placeholder={isOAuthProvider(keyDlg) ? "如 account-2" : "如 prod-2"}
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" className="flex-1 sm:flex-initial" onClick={() => setKeyDlg(null)}>关闭</Button>
                <Button className="flex-1 sm:flex-initial" onClick={saveKey} disabled={!keyVal.trim()}>{isOAuthProvider(keyDlg) ? "保存账号凭据" : isWebProvider(keyDlg) ? "保存账号凭据" : "保存并追加至池"}</Button>
              </div>
            </div>
          </div>
        </div>
      </Dialog>

      {/* Web 反代接入 / 追加账号 */}
      <Dialog open={!!webDlg} onClose={() => setWebDlg(null)} title={`${webDlg?.provider ? "添加账号" : "接入 Web 反代"} — ${webDlg?.meta.name ?? ""}`} width={560}>
        <div className="space-y-4">
          <div className="rounded-lg border border-line bg-surface2/50 p-3 text-[11px] text-muted leading-relaxed">
            凭据从浏览器网页会话获取：<span className="text-ink">{webDlg?.meta.credHint}</span><br />
            每行一个账号，粘贴多个会自动进入轮换池；凭据仅加密存储，不会回显。
          </div>

          {!webDlg?.provider && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="渠道名称">
                <Input value={webDlg?.name ?? ""} onChange={(e) => webDlg && setWebDlg({ ...webDlg, name: e.target.value })} />
              </Field>
              <Field label="渠道 Slug">
                <Input value={webDlg?.slug ?? ""} onChange={(e) => webDlg && setWebDlg({ ...webDlg, slug: e.target.value })} />
              </Field>
              <div className="col-span-1 sm:col-span-2">
                <Field label="Base URL">
                  <Input value={webDlg?.baseUrl ?? ""} onChange={(e) => webDlg && setWebDlg({ ...webDlg, baseUrl: e.target.value })} />
                </Field>
              </div>
            </div>
          )}

          <Field label={webDlg?.provider ? "追加账号凭据（一行一个）" : "账号凭据（必填，一行一个）"}>
            <textarea
              value={webDlg?.credential ?? ""}
              onChange={(e) => webDlg && setWebDlg({ ...webDlg, credential: e.target.value })}
              rows={4}
              placeholder={webDlg?.meta.credHint}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs font-mono text-ink placeholder:text-muted/60 focus:border-brand focus:outline-none"
            />
          </Field>

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2 border-t border-line">
            <Button variant="ghost" className="flex-1 sm:flex-initial" onClick={() => setWebDlg(null)}>取消</Button>
            <Button className="flex-1 sm:flex-initial" onClick={saveWeb} disabled={!!webDlg?.saving || !webDlg?.credential.trim()}>
              {webDlg?.saving ? "保存中…" : webDlg?.provider ? "保存并追加" : "保存并接入"}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* OAuth 授权弹窗 */}
      <Dialog open={!!oauthDlg} onClose={closeOAuth} title={`OAuth 授权 — ${oauthDlg?.meta.name ?? ""}`} width={560}>
        {oauthDlg?.step === "loading" ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <RefreshCw size={16} className="animate-spin" />正在向 {oauthDlg.meta.name} 发起授权请求…
          </div>
        ) : oauthDlg?.step === "error" ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-err/30 bg-err/5 p-3 text-xs text-err leading-relaxed">{oauthDlg.message}</div>
            <p className="text-[11px] text-muted">
              提示：授权链接有效期约 10 分钟；若使用了代理/无痕窗口，请保持同一浏览器完成授权。也可在下方手动粘贴 refresh_token。
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={closeOAuth}>关闭</Button>
              <Button onClick={retryOAuth}><RefreshCw size={14} />重新发起授权</Button>
            </div>
          </div>
        ) : oauthDlg?.mode === "redirect-poll" ? (
          <div className="space-y-4">
            <p className="text-xs leading-relaxed text-muted">
              请在浏览器中打开下方授权页，登录 {oauthDlg.meta.name} 账号并确认授权。完成后本弹窗会自动获取并保存凭据。
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={oauthDlg.url} className="!py-1 flex-1 text-[11px] font-mono" />
              <Button variant="soft" className="!h-[34px] !px-2.5 shrink-0" onClick={() => copyText(oauthDlg.url)} title="复制授权链接"><Copy size={12} /></Button>
              <Button className="!h-[34px] !px-3 shrink-0" onClick={() => window.open(oauthDlg.url, "_blank", "noopener,noreferrer")}>
                <ExternalLink size={12} />打开授权页
              </Button>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-line bg-surface p-3 text-xs text-muted">
              <RefreshCw size={13} className="animate-spin text-brand" />
              <span>{oauthDlg.message || "等待你在浏览器中完成登录…"}</span>
              <span className="ml-auto text-[10px]">每 {oauthDlg.interval || 5}s 轮询</span>
            </div>
            <p className="text-[11px] text-muted">
              授权链接由 {oauthDlg.meta.name} 官方签发，有效期约 1 小时。如需为同一渠道添加第二个账号，建议使用无痕窗口打开授权页。
            </p>
            <div className="flex justify-end">
              <Button variant="ghost" onClick={closeOAuth}>取消授权</Button>
            </div>
          </div>
        ) : oauthDlg?.mode === "device" ? (
          <div className="space-y-4">
            <p className="text-xs text-muted leading-relaxed">
              请在浏览器中打开下方授权页，登录 {oauthDlg.meta.name} 账号并确认设备码：
            </p>
            <div className="rounded-xl border border-line bg-surface2/60 p-3 text-center">
              <div className="text-[11px] text-muted">设备码 / User Code</div>
              <div className="mt-1 font-mono text-2xl font-bold tracking-widest text-brand">{oauthDlg.userCode || "—"}</div>
              <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                <Button variant="soft" className="!h-7 !px-2.5 text-[11px]" onClick={() => copyText(oauthDlg.userCode || "")}>
                  <Copy size={11} />复制设备码
                </Button>
                <Button
                  className="!h-7 !px-2.5 text-[11px]"
                  onClick={() => window.open(oauthDlg.verificationUriComplete || oauthDlg.verificationUri || oauthDlg.url, "_blank", "noopener,noreferrer")}
                >
                  <ExternalLink size={11} />打开授权页
                </Button>
              </div>
              {(oauthDlg.verificationUriComplete || oauthDlg.verificationUri) && (
                <div className="mt-2 truncate text-[10px] text-muted" title={oauthDlg.verificationUriComplete || oauthDlg.verificationUri}>
                  {oauthDlg.verificationUriComplete || oauthDlg.verificationUri}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-line bg-surface p-3 text-xs text-muted">
              <RefreshCw size={13} className="animate-spin text-brand" />
              <span>{oauthDlg.message || "等待你在浏览器中确认授权…"}</span>
              {oauthDlg.interval ? <span className="ml-auto text-[10px]">每 {oauthDlg.interval}s 轮询</span> : null}
            </div>
            <p className="text-[11px] text-muted">
              如需为同一渠道添加第二个账号，请使用无痕窗口打开授权页，避免浏览器复用已登录会话。
            </p>
            <div className="flex justify-end">
              <Button variant="ghost" onClick={closeOAuth}>取消授权</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-xs leading-relaxed text-muted">
              1. 点击下方按钮打开 {oauthDlg?.meta.name} 授权页并登录；<br />
              2. 授权后浏览器会跳转到 <code className="rounded bg-line px-1">localhost</code> 回调地址（页面打不开属正常现象）；<br />
              3. 复制地址栏 <code className="rounded bg-line px-1">code=</code> 后的整段内容（或整段回调 URL）粘贴到下方。
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={oauthDlg?.url ?? ""} className="!py-1 flex-1 text-[11px] font-mono" />
              <Button variant="soft" className="!h-[34px] !px-2.5 shrink-0" onClick={() => copyText(oauthDlg?.url ?? "")} title="复制授权链接"><Copy size={12} /></Button>
              <Button className="!h-[34px] !px-3 shrink-0" onClick={() => window.open(oauthDlg?.url ?? "", "_blank", "noopener,noreferrer")}>
                <ExternalLink size={12} />打开
              </Button>
            </div>
            <Field label="授权 code 或整段回调地址">
              <textarea
                value={oauthDlg?.codeInput ?? ""}
                onChange={(e) => oauthDlg && setOauthDlg({ ...oauthDlg, codeInput: e.target.value })}
                rows={3}
                placeholder="粘贴 code 或 http://localhost:xxxxx/callback?code=..."
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs font-mono text-ink placeholder:text-muted/60 focus:border-brand focus:outline-none"
              />
            </Field>
            {oauthDlg?.message && <div className="text-[11px] text-muted">{oauthDlg.message}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={closeOAuth}>取消</Button>
              <Button onClick={completeOAuthNow} disabled={oauthDlg?.busy || !oauthDlg?.codeInput.trim()}>
                {oauthDlg?.busy ? "正在验证…" : "完成授权"}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
      {confirmEl}
    </div>
  );
}
