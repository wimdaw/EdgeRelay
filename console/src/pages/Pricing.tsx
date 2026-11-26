import { useEffect, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { adminAction, api, type Me, type ModelRow, type Provider } from "../lib/api";
import { Button, Card, Dialog, DataTable, Field, Input, Select, StatusTag, useConfirm, useToast, type Col } from "../components/ui";

export default function Pricing({ me }: { me: Me }) {
  const isAdmin = me.user.role === "superadmin";
  const [rows, setRows] = useState<ModelRow[] | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [dlg, setDlg] = useState(false);
  const [form, setForm] = useState({
    providerId: "",
    upstream: "",
    publicName: "",
    cost: "1",
    inputPerMillion: "0",
    outputPerMillion: "0",
    rpmLimit: "",
    password: "",
  });
  const [editDlg, setEditDlg] = useState<ModelRow | null>(null);
  const [editPassword, setEditPassword] = useState("");
  const [editForm, setEditForm] = useState({
    id: "",
    oldPublicName: "",
    publicName: "",
    providerId: "",
    upstreamModel: "",
    costWeight: "1",
    inputPerMillion: "0",
    outputPerMillion: "0",
    rpmLimit: "",
    enabled: true,
  });
  const [normalizing, setNormalizing] = useState(false);
  const { confirm, confirmEl } = useConfirm();
  const toast = useToast();

  const load = () => api<{ models: ModelRow[] }>("/api/models").then((d) => setRows(d.models)).catch((e) => toast(e.message, "err"));
  useEffect(() => {
    load();
    if (isAdmin) adminAction<{ providers: Provider[] }>("list_providers").then((d) => setProviders(d.providers)).catch(() => {});
  }, [isAdmin]);

  const save = async () => {
    if (!form.providerId) return toast("请选择所属供应商渠道", "err");
    if (!form.upstream.trim()) return toast("请填写上游真实模型名", "err");
    if (!form.password.trim()) return toast("请输入管理员密码确认操作", "err");
    const inPrice = parseFloat(form.inputPerMillion);
    const outPrice = parseFloat(form.outputPerMillion);
    if (isNaN(inPrice) || isNaN(outPrice) || inPrice < 0 || outPrice < 0) {
      return toast("请输入合法的输入/输出价格", "err");
    }
    const rpmVal = form.rpmLimit.trim() === "" ? null : parseInt(form.rpmLimit.trim(), 10);
    if (rpmVal !== null && (isNaN(rpmVal) || rpmVal < 0)) {
      return toast("RPM 限流请输入大于等于 0 的整数（0 代表不限）", "err");
    }
    try {
      await adminAction("upsert_model", {
        publicName: form.publicName.trim(),
        providerId: form.providerId,
        upstreamModel: form.upstream.trim(),
        priority: 10,
        costWeight: +form.cost || 1,
        inputPerMillion: inPrice,
        outputPerMillion: outPrice,
        rpmLimit: rpmVal,
        password: form.password.trim(),
      });
      toast("模型已保存上架（对外名默认取上游真实名）");
      setDlg(false);
      setForm({ providerId: "", upstream: "", publicName: "", cost: "1", inputPerMillion: "0", outputPerMillion: "0", rpmLimit: "", password: "" });
      load();
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const openEdit = (m: ModelRow) => {
    setEditDlg(m);
    setEditPassword("");
    setEditForm({
      id: m.id,
      oldPublicName: m.public_name,
      publicName: m.public_name.toLowerCase() === m.upstream_model.toLowerCase() ? "" : m.public_name,
      providerId: m.provider_id || "",
      upstreamModel: m.upstream_model,
      costWeight: String(m.cost_weight ?? 1),
      inputPerMillion: String(m.input_per_million ?? 0),
      outputPerMillion: String(m.output_per_million ?? 0),
      rpmLimit: m.rpm_limit != null ? String(m.rpm_limit) : "",
      enabled: m.enabled === 1,
    });
  };

  const saveEdit = async () => {
    if (!editForm.providerId) return toast("请选择所属供应商渠道", "err");
    if (!editForm.upstreamModel.trim()) return toast("请填写上游真实模型名", "err");
    if (!editPassword.trim()) return toast("请输入管理员密码确认修改", "err");
    const inPrice = parseFloat(editForm.inputPerMillion);
    const outPrice = parseFloat(editForm.outputPerMillion);
    if (isNaN(inPrice) || isNaN(outPrice) || inPrice < 0 || outPrice < 0) {
      return toast("请输入合法的输入/输出价格", "err");
    }
    const rpmVal = editForm.rpmLimit.trim() === "" ? null : parseInt(editForm.rpmLimit.trim(), 10);
    if (rpmVal !== null && (isNaN(rpmVal) || rpmVal < 0)) {
      return toast("RPM 限流请输入大于等于 0 的整数（0 代表不限）", "err");
    }
    try {
      await adminAction("upsert_model", {
        id: editForm.id,
        publicName: editForm.publicName.trim(),
        oldPublicName: editForm.oldPublicName,
        providerId: editForm.providerId,
        upstreamModel: editForm.upstreamModel.trim(),
        priority: 10,
        costWeight: +editForm.costWeight || 1,
        inputPerMillion: inPrice,
        outputPerMillion: outPrice,
        rpmLimit: rpmVal,
        enabled: editForm.enabled,
        password: editPassword.trim(),
      });
      toast(`「${editForm.upstreamModel}」已更新`);
      setEditDlg(null);
      setEditPassword("");
      load();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };

  const remove = async (m: ModelRow) => {
    if (!(await confirm(`删除模型映射「${m.public_name} → ${m.upstream_model}」？`))) return;
    try { await adminAction("delete_model", { id: m.id }); toast("已删除"); load(); } catch (e) { toast((e as Error).message, "err"); }
  };

  /** 存量配置一次性拉回基线：未自定义的对外名对齐上游、优先级统一 10、同渠道重复合并 */
  const normalizeAll = async () => {
    if (normalizing) return;
    if (!(await confirm("将把所有模型优先级统一为 10，并把未自定义的对外名对齐上游真实名（定价里显式改过的名称与定价保留）。继续？"))) return;
    setNormalizing(true);
    try {
      const r = await adminAction<{ result?: { renamed?: number; customKept?: number; priorityFixed?: number; deduped?: number; total?: number } }>("normalize_models", {});
      const s = r.result ?? {};
      toast(`已规范化：名称对齐 ${s.renamed ?? 0}、保留自定义名 ${s.customKept ?? 0}、优先级修正 ${s.priorityFixed ?? 0}、去重 ${s.deduped ?? 0}，共 ${s.total ?? 0} 个模型`);
      load();
    } catch (e) { toast((e as Error).message, "err"); } finally { setNormalizing(false); }
  };

  const cols: Col<ModelRow>[] = [
    {
      key: "public",
      label: "对外模型名",
      sortVal: (r) => r.public_name,
      render: (r) => (
        <span className="font-medium text-ink truncate max-w-[140px] sm:max-w-[200px] inline-block" title={r.public_name}>
          {r.public_name}
        </span>
      ),
    },
    {
      key: "upstream",
      label: "上游真实模型",
      sortVal: (r) => `${r.provider_slug || ""}/${r.upstream_model}`,
      render: (r) => {
        const fullUpstream = r.provider_slug && !r.upstream_model.startsWith(`${r.provider_slug}/`)
          ? `${r.provider_slug}/${r.upstream_model}`
          : r.upstream_model;
        return (
          <code
            className="text-xs font-mono text-muted hover:text-ink truncate max-w-[140px] sm:max-w-[200px] md:max-w-[260px] inline-block"
            title={fullUpstream}
          >
            {fullUpstream}
          </code>
        );
      },
    },
    { key: "provider", label: "供应商渠道", render: (r) => r.provider_name ?? "—" },
    { key: "priority", label: "优先级", sortVal: (r) => r.priority, render: (r) => <span className="text-xs">{r.priority}（小=优先）</span> },
    {
      key: "in",
      label: "输入价 / 1M",
      sortVal: (r) => r.input_per_million ?? 0,
      render: (r) => (
        <span className="font-mono text-xs font-medium text-ink">
          {r.input_per_million != null ? `¥${Number(r.input_per_million).toFixed(2)}` : "未定价"}
        </span>
      ),
    },
    {
      key: "out",
      label: "输出价 / 1M",
      sortVal: (r) => r.output_per_million ?? 0,
      render: (r) => (
        <span className="font-mono text-xs font-medium text-ink">
          {r.output_per_million != null ? `¥${Number(r.output_per_million).toFixed(2)}` : "未定价"}
        </span>
      ),
    },
    {
      key: "rpm",
      label: "RPM 限流",
      sortVal: (r) => (r.rpm_limit === 0 ? -1 : r.rpm_limit ?? 999999),
      render: (r) => (
        r.rpm_limit === 0 ? (
          <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500 whitespace-nowrap">
            不限流
          </span>
        ) : typeof r.rpm_limit === "number" && r.rpm_limit > 0 ? (
          <span className="rounded bg-brand/10 px-1.5 py-0.5 text-[10px] font-mono font-medium text-brand whitespace-nowrap">
            {r.rpm_limit} RPM
          </span>
        ) : (
          <span className="text-[11px] text-muted whitespace-nowrap">继承全局</span>
        )
      ),
    },
    {
      key: "status",
      label: "状态",
      render: (r) => <StatusTag value={r.enabled ? "active" : "pending"} />,
    },
    ...(isAdmin ? [{
      key: "ops",
      label: "操作",
      render: (r: ModelRow) => (
        <span className="flex items-center gap-1.5 shrink-0">
          <Button variant="soft" className="!h-7 !px-2.5 text-xs" onClick={() => openEdit(r)}>编辑</Button>
          <Button variant="ghost" className="!h-7 !px-2 text-xs !text-err" onClick={() => remove(r)}>删除</Button>
        </span>
      ),
    }] : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      {isAdmin && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="soft" onClick={normalizeAll} disabled={normalizing}>
            <RefreshCw size={14} className={normalizing ? "animate-spin" : undefined} />
            {normalizing ? "规范化中…" : "规范化全部模型"}
          </Button>
          <Button onClick={() => setDlg(true)}><Plus size={14} />新增映射与定价</Button>
        </div>
      )}
      <Card className="p-4">
        {rows === null ? <div className="flex flex-col gap-2">{[...Array(5)].map((_, i) => <div key={i} className="skeleton h-9" />)}</div> : <DataTable cols={cols} rows={rows} />}
      </Card>

      {/* 新增模型映射 */}
      <Dialog open={dlg} onClose={() => setDlg(false)} title="新增模型映射与定价" width={540}>
        <div className="space-y-4">
          <p className="text-xs text-muted">
            登记上游模型并设定调用单价与限流。对外模型名默认取上游真实名，只有需要改名时才填写；所有模型优先级统一为 10。
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="所属供应商">
              <Select value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })}>
                <option value="">请选择供应商</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}（{p.slug}）</option>)}
              </Select>
            </Field>
            <Field label="上游真实模型名">
              <Input
                value={form.upstream}
                onChange={(e) => setForm({ ...form, upstream: e.target.value })}
                placeholder="例如: deepseek-chat 或 gpt-4o"
              />
            </Field>
            <Field label="对外模型名" hint="留空 = 上游真实名">
              <Input
                value={form.publicName}
                onChange={(e) => setForm({ ...form, publicName: e.target.value })}
                placeholder={form.upstream.trim() || "留空则直接使用上游真实名"}
              />
            </Field>
            <Field label="输入价格 (元 / 1M Tokens)">
              <Input
                type="number"
                step="0.01"
                value={form.inputPerMillion}
                onChange={(e) => setForm({ ...form, inputPerMillion: e.target.value })}
                placeholder="0"
              />
            </Field>
            <Field label="输出价格 (元 / 1M Tokens)">
              <Input
                type="number"
                step="0.01"
                value={form.outputPerMillion}
                onChange={(e) => setForm({ ...form, outputPerMillion: e.target.value })}
                placeholder="0"
              />
            </Field>
            <div className="col-span-1 sm:col-span-2">
              <Field label="模型独立 RPM 限流" hint="填 0 为该模型绝对不限；留空自动继承全局设置">
                <Input
                  type="number"
                  min="0"
                  value={form.rpmLimit}
                  onChange={(e) => setForm({ ...form, rpmLimit: e.target.value })}
                  placeholder="留空继承全局默认（填 0 代表完全不限流）"
                />
              </Field>
            </div>
            <div className="col-span-1 sm:col-span-2">
              <Field label="管理员密码确认" hint="创建新模型映射需核验管理员密码确认身份">
                <Input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="请输入当前管理员密码"
                  autoComplete="current-password"
                />
              </Field>
            </div>
          </div>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-3 border-t border-line">
            <Button variant="ghost" className="flex-1 sm:flex-initial" onClick={() => setDlg(false)}>取消</Button>
            <Button className="flex-1 sm:flex-initial" onClick={save}>保存并上架</Button>
          </div>
        </div>
      </Dialog>

      {/* 编辑模型与定价 */}
      <Dialog open={!!editDlg} onClose={() => setEditDlg(null)} title={`编辑模型与定价 — ${editDlg?.public_name ?? ""}`} width={540}>
        <div className="space-y-4">
          <p className="text-xs text-muted">
            修改上游模型与调用定价。对外模型名默认取上游真实名，只有显式填写才作为自定义名保留；改名后原定价会自动跟随迁移。
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="所属供应商渠道">
              <Select
                value={editForm.providerId}
                onChange={(e) => setEditForm({ ...editForm, providerId: e.target.value })}
              >
                <option value="">请选择供应商</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}（{p.slug}）</option>)}
              </Select>
            </Field>
            <Field label="上游真实模型名">
              <Input
                value={editForm.upstreamModel}
                onChange={(e) => setEditForm({ ...editForm, upstreamModel: e.target.value })}
                placeholder="例如: deepseek-chat"
              />
            </Field>
            <Field label="对外模型名" hint="留空 = 上游真实名">
              <Input
                value={editForm.publicName}
                onChange={(e) => setEditForm({ ...editForm, publicName: e.target.value })}
                placeholder={editForm.upstreamModel.trim() || "留空则直接使用上游真实名"}
              />
            </Field>
            <Field label="输入价格 (元 / 1M Tokens)">
              <Input
                type="number"
                step="0.01"
                value={editForm.inputPerMillion}
                onChange={(e) => setEditForm({ ...editForm, inputPerMillion: e.target.value })}
                placeholder="0"
              />
            </Field>
            <Field label="输出价格 (元 / 1M Tokens)">
              <Input
                type="number"
                step="0.01"
                value={editForm.outputPerMillion}
                onChange={(e) => setEditForm({ ...editForm, outputPerMillion: e.target.value })}
                placeholder="0"
              />
            </Field>
            <div className="col-span-1 sm:col-span-2">
              <Field label="模型独立 RPM 限流" hint="填 0 为该模型绝对不限；留空自动继承全局设置">
                <Input
                  type="number"
                  min="0"
                  value={editForm.rpmLimit}
                  onChange={(e) => setEditForm({ ...editForm, rpmLimit: e.target.value })}
                  placeholder="留空继承全局默认（填 0 代表完全不限流）"
                />
              </Field>
            </div>
            <div className="col-span-1 sm:col-span-2">
              <Field label="管理员密码确认" hint="修改模型映射与定价属核心敏感操作，需验证管理员密码确认身份">
                <Input
                  type="password"
                  value={editPassword}
                  onChange={(e) => setEditPassword(e.target.value)}
                  placeholder="请输入当前管理员密码"
                  autoComplete="current-password"
                />
              </Field>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[#F38020]"
                checked={editForm.enabled}
                onChange={(e) => setEditForm({ ...editForm, enabled: e.target.checked })}
              />
              启用该模型上架调度
            </label>
          </div>

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-3 border-t border-line">
            <Button variant="ghost" className="flex-1 sm:flex-initial" onClick={() => setEditDlg(null)}>取消</Button>
            <Button className="flex-1 sm:flex-initial" onClick={saveEdit}>保存修改</Button>
          </div>
        </div>
      </Dialog>
      {confirmEl}
    </div>
  );
}
