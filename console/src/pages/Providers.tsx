import { useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Server, Trash2, Key, CheckCircle2, AlertTriangle, ShieldAlert } from "lucide-react";
import { adminAction, type Provider } from "../lib/api";
import { Button, Card, Dialog, EmptyState, Field, Input, Select, StatusTag, useConfirm, useToast } from "../components/ui";
import { cn } from "../lib/utils";

const SLUGS = ["openai", "anthropic", "google", "deepseek", "opencode", "duckai", "kilo"];
const SLUG_URL: Record<string, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  deepseek: "https://api.deepseek.com",
  opencode: "https://opencode.ai/zen/v1",
  duckai: "https://duck.ai",
  kilo: "https://api.kilo.ai/api/gateway",
};

const isKeylessSlug = (slug?: string) => slug === "opencode" || slug === "duckai" || slug === "kilo";

export default function Providers() {
  const [rows, setRows] = useState<Provider[] | null>(null);
  const [dlg, setDlg] = useState(false);
  const [form, setForm] = useState({ id: "", name: "", slug: "deepseek", url: SLUG_URL.deepseek, key: "" });
  const [saving, setSaving] = useState(false);
  const [keyDlg, setKeyDlg] = useState<Provider | null>(null);
  const [keyVal, setKeyVal] = useState("");
  const [newKeyLabel, setNewKeyLabel] = useState("prod");
  // 模型导入流程
  const [importStep, setImportStep] = useState<{ providerId: string; providerName: string; models: string[]; picked: Set<string>; loading: boolean; error?: string } | null>(null);
  const [customModelInput, setCustomModelInput] = useState("");
  const { confirm, confirmEl } = useConfirm();
  const toast = useToast();

  const load = () => adminAction<{ providers: Provider[] }>("list_providers").then((d) => setRows(d.providers)).catch((e) => toast(e.message, "err"));
  useEffect(() => { load(); }, []);

  const openNew = () => { setForm({ id: "", name: "", slug: "deepseek", url: SLUG_URL.deepseek, key: "" }); setDlg(true); };
  const openEdit = (p: Provider) => { setForm({ id: p.id, name: p.name, slug: p.slug, url: p.base_url, key: "" }); setDlg(true); };

  /** 保存供应商；成功后自动拉取上游模型列表进入导入步骤 */
  const save = async () => {
    if (!form.name.trim()) return toast("请填写供应商名称", "err");
    const isKeyless = isKeylessSlug(form.slug);
    if (!form.id && !form.key.trim() && !isKeyless) return toast("添加供应商必须录入上游密钥", "err");
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { name: form.name, slug: form.slug, baseUrl: form.url };
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

  const fetchModels = async (providerId: string, providerName: string) => {
    const p = (rows ?? []).find((x) => x.id === providerId);
    const isKeyless = isKeylessSlug(p?.slug);
    if (!keyMemo.current[providerId] && !isKeyless) {
      setImportStep({ providerId, providerName, models: [], picked: new Set(), loading: false,
        error: "浏览器直拉需要密钥（服务端不保存明文）。请点供应商卡片的「密钥池」重新输入一次，即可直连上游获取模型列表。" });
      return;
    }
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
        label: newKeyLabel.trim() || "prod",
      });
      toast(`密钥已加密入库（指纹 ${r.result?.fingerprint ?? ""}）`);
      const keyInput = keyVal.trim();
      setKeyVal("");
      const updated = await adminAction<{ providers: Provider[] }>("list_providers");
      setRows(updated.providers);
      const targetP = updated.providers.find((x) => x.id === keyDlg.id);
      if (targetP) setKeyDlg(targetP);
      // 首次录入后自动尝试拉取上游模型列表
      if (!targetP || (targetP.keys && targetP.keys.length <= 1)) {
        setImportStep({ providerId: keyDlg.id, providerName: keyDlg.name, models: [], picked: new Set(), loading: true });
        await pullModels(keyDlg.id, keyDlg.name, keyDlg.base_url, keyInput);
      }
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const delKey = async (providerId: string, keyId: string) => {
    if (!(await confirm("确认删除该密钥？该密钥将从多 Key 调度池中彻底移除。"))) return;
    try {
      await adminAction("delete_provider_key", { providerId, keyId });
      toast("密钥已从池中删除");
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
      toast(`密钥已${nextStatus === "active" ? "启用" : "停用"}`);
      const updated = await adminAction<{ providers: Provider[] }>("list_providers");
      setRows(updated.providers);
      const targetP = updated.providers.find((x) => x.id === providerId);
      if (targetP) setKeyDlg(targetP);
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const del = async (p: Provider) => {
    if (!(await confirm(`删除供应商「${p.name}」？其模型映射与上游密钥将一并删除，不可恢复。`))) return;
    try {
      await adminAction("delete_provider", { id: p.id });
      toast("已删除"); load();
    } catch (e) { toast((e as Error).message, "err"); }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={openNew}><Plus size={14} />添加供应商</Button>
      </div>

      {rows === null ? (
        <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[...Array(8)].map((_, i) => <div key={i} className="skeleton h-36 rounded-xl2" />)}
        </div>
      ) : rows.length === 0 ? (
        <Card><EmptyState icon={<Server size={32} />} title="还没有上游供应商" hint="添加你持有授权的供应商并录入密钥，即可一键导入模型列表。" action={<Button className="mt-2" onClick={openNew}>添加供应商</Button>} /></Card>
      ) : (
        <div className="grid gap-3.5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {rows.map((p) => (
            <Card key={p.id} className="p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-sm font-bold text-brand">{p.name[0]}</div>
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold leading-tight">{p.name}</div>
                      <code className="text-[10px] text-muted">{p.slug}</code>
                    </div>
                  </div>
                  <StatusTag value={p.status} />
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
                <Button variant="soft" className="flex-1 !h-7 !px-2 text-xs" onClick={() => fetchModels(p.id, p.name)} title="从上游导入或手动添加模型">
                  <RefreshCw size={12} className="mr-1" />导入/添加模型
                </Button>
                {!isKeylessSlug(p.slug) && (
                  <Button variant="soft" className="!h-7 !px-2 text-xs" onClick={() => { setKeyDlg(p); setKeyVal(""); setNewKeyLabel("prod"); }} title="管理多 Key 轮换池">
                    <Key size={12} className="mr-1 text-muted" />密钥 ({p.key_count})
                  </Button>
                )}
                <Button variant="ghost" className="!h-7 !px-2 text-xs" onClick={() => openEdit(p)}>编辑</Button>
                <Button variant="ghost" className="!h-7 !px-1.5 text-xs !text-err" onClick={() => del(p)} aria-label={`删除 ${p.name}`}><Trash2 size={13} /></Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* 添加/编辑供应商 */}
      <Dialog open={dlg} onClose={() => setDlg(false)} title={form.id ? "编辑供应商" : "添加供应商"} width={560}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="名称"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="DeepSeek" /></Field>
          <Field label="Slug"><Select value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value, url: SLUG_URL[e.target.value] ?? form.url })}>{SLUGS.map((s) => <option key={s}>{s}</option>)}</Select></Field>
          <div className="col-span-2"><Field label="Base URL（OpenAI 兼容端点）"><Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://..." /></Field></div>
          <div className="col-span-2">
            <Field label={isKeylessSlug(form.slug) ? "上游密钥（免 Key 渠道，无需填写）" : form.id ? "追加新密钥（留空保持不变，支持多行批量录入）" : "上游密钥（必填，支持粘贴多个，一行一个）"}>
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
        
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDlg(false)}>取消</Button>
          <Button disabled={saving} onClick={save}>{saving ? "保存中…" : "保存并获取模型列表"}</Button>
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
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-muted">候选模型清单（已勾选 {importStep?.picked.size ?? 0} 个）：</span>
              <button className="text-xs text-brand hover:underline" onClick={() => importStep && setImportStep({ ...importStep, picked: new Set(importStep.models) })}>全选</button>
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

      {/* 密钥池管理 */}
      <Dialog open={!!keyDlg} onClose={() => setKeyDlg(null)} title={`密钥池管理 — ${keyDlg?.name ?? ""}`} width={560}>
        <div className="space-y-4">
          <p className="text-xs text-muted">
            已开启多 Key 负载均衡与健康熔断。网关使用 Fisher-Yates 随机打散实现均匀轮换分流；遇 429 自动降权跳过并轮换下一个 Key，60 秒后自动试用自愈。
          </p>

          <div className="space-y-2">
            <div className="text-xs font-semibold text-ink flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Key size={13} className="text-brand" />
                当前轮换 Key 列表（{keyDlg?.keys?.length ?? 0} 个）
              </span>
              <span className="text-[11px] text-muted">支持无缝挂载任意多个 Key</span>
            </div>

            {(!keyDlg?.keys || keyDlg.keys.length === 0) ? (
              <div className="rounded-lg border border-line p-3 text-center text-xs text-muted">
                暂无密钥，请在下方录入或批量粘贴 Key
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
                          <CheckCircle2 size={10} /> 轮换就绪
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
            <div className="text-xs font-semibold text-ink">批量追加新密钥</div>
            <div className="space-y-1">
              <textarea
                value={keyVal}
                onChange={(e) => setKeyVal(e.target.value)}
                placeholder={"支持单个或批量粘贴多个 Key，一行一个，例如：\nsk-xxxxxxxxxxxxxxxx\nsk-yyyyyyyyyyyyyyyy"}
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
                  placeholder="如 prod-2"
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" className="flex-1 sm:flex-initial" onClick={() => setKeyDlg(null)}>关闭</Button>
                <Button className="flex-1 sm:flex-initial" onClick={saveKey} disabled={!keyVal.trim()}>保存并追加至池</Button>
              </div>
            </div>
          </div>
        </div>
      </Dialog>
      {confirmEl}
    </div>
  );
}
