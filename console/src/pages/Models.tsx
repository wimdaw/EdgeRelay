import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { adminAction, api, type Me, type ModelRow, type Provider } from "../lib/api";
import { Button, Card, Dialog, DataTable, Field, Input, Select, StatusTag, useConfirm, useToast, type Col } from "../components/ui";

export default function Models({ me }: { me: Me }) {
  const isAdmin = me.user.role === "admin";
  const [rows, setRows] = useState<ModelRow[] | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [dlg, setDlg] = useState(false);
  const [form, setForm] = useState({
    publicName: "",
    providerId: "",
    upstream: "",
    priority: "10",
    cost: "1",
    inputPerMillion: "0",
    outputPerMillion: "0",
    password: "",
  });
  const [editDlg, setEditDlg] = useState<ModelRow | null>(null);
  const [editPassword, setEditPassword] = useState("");
  const [editForm, setEditForm] = useState({
    id: "",
    publicName: "",
    oldPublicName: "",
    providerId: "",
    upstreamModel: "",
    priority: "10",
    costWeight: "1",
    inputPerMillion: "0",
    outputPerMillion: "0",
    enabled: true,
  });
  const { confirm, confirmEl } = useConfirm();
  const toast = useToast();

  const load = () => api<{ models: ModelRow[] }>("/api/models").then((d) => setRows(d.models)).catch((e) => toast(e.message, "err"));
  useEffect(() => {
    load();
    if (isAdmin) adminAction<{ providers: Provider[] }>("list_providers").then((d) => setProviders(d.providers)).catch(() => {});
  }, [isAdmin]);

  const save = async () => {
    if (!form.publicName.trim()) return toast("请填写对外统一模型名", "err");
    if (!form.providerId) return toast("请选择所属供应商渠道", "err");
    if (!form.upstream.trim()) return toast("请填写上游真实模型名", "err");
    if (!form.password.trim()) return toast("请输入管理员密码确认操作", "err");
    const inPrice = parseFloat(form.inputPerMillion);
    const outPrice = parseFloat(form.outputPerMillion);
    if (isNaN(inPrice) || isNaN(outPrice) || inPrice < 0 || outPrice < 0) {
      return toast("请输入合法的输入/输出价格", "err");
    }
    try {
      await adminAction("upsert_model", {
        publicName: form.publicName.trim(),
        providerId: form.providerId,
        upstreamModel: form.upstream.trim(),
        priority: +form.priority || 10,
        costWeight: +form.cost || 1,
        inputPerMillion: inPrice,
        outputPerMillion: outPrice,
        password: form.password.trim(),
      });
      toast("模型映射已保存并上架");
      setDlg(false);
      setForm({ publicName: "", providerId: "", upstream: "", priority: "10", cost: "1", inputPerMillion: "0", outputPerMillion: "0", password: "" });
      load();
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const openEdit = (m: ModelRow) => {
    setEditDlg(m);
    setEditPassword("");
    setEditForm({
      id: m.id,
      publicName: m.public_name,
      oldPublicName: m.public_name,
      providerId: m.provider_id || "",
      upstreamModel: m.upstream_model,
      priority: String(m.priority ?? 10),
      costWeight: String(m.cost_weight ?? 1),
      inputPerMillion: String(m.input_per_million ?? 0),
      outputPerMillion: String(m.output_per_million ?? 0),
      enabled: m.enabled === 1,
    });
  };

  const saveEdit = async () => {
    if (!editForm.publicName.trim()) return toast("请填写对外统一模型名", "err");
    if (!editForm.providerId) return toast("请选择所属供应商渠道", "err");
    if (!editForm.upstreamModel.trim()) return toast("请填写上游真实模型名", "err");
    if (!editPassword.trim()) return toast("请输入管理员密码确认修改", "err");
    const inPrice = parseFloat(editForm.inputPerMillion);
    const outPrice = parseFloat(editForm.outputPerMillion);
    if (isNaN(inPrice) || isNaN(outPrice) || inPrice < 0 || outPrice < 0) {
      return toast("请输入合法的输入/输出价格", "err");
    }
    try {
      await adminAction("upsert_model", {
        id: editForm.id,
        publicName: editForm.publicName.trim(),
        oldPublicName: editForm.oldPublicName,
        providerId: editForm.providerId,
        upstreamModel: editForm.upstreamModel.trim(),
        priority: +editForm.priority || 10,
        costWeight: +editForm.costWeight || 1,
        inputPerMillion: inPrice,
        outputPerMillion: outPrice,
        enabled: editForm.enabled,
        password: editPassword.trim(),
      });
      toast(`「${editForm.publicName}」模型映射与定价已更新`);
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

  const cols: Col<ModelRow>[] = [
    {
      key: "public",
      label: "对外模型名",
      sortVal: (r) => r.public_name,
      render: (r) => (
        <div className="flex flex-col">
          <span className="font-medium text-ink">{r.public_name}</span>
          {r.provider_slug && !r.public_name.startsWith(`${r.provider_slug}/`) && (
            <code className="text-[10px] text-muted/70 font-mono mt-0.5" title="显式强制定向调用该渠道的模型名称">
              定向: {r.provider_slug}/{r.public_name}
            </code>
          )}
        </div>
      ),
    },
    { key: "upstream", label: "上游真实模型", render: (r) => <code className="text-xs font-mono">{r.upstream_model}</code> },
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
        <div className="flex justify-end">
          <Button onClick={() => setDlg(true)}><Plus size={14} />新增映射</Button>
        </div>
      )}
      <Card className="p-4">
        {rows === null ? <div className="flex flex-col gap-2">{[...Array(5)].map((_, i) => <div key={i} className="skeleton h-9" />)}</div> : <DataTable cols={cols} rows={rows} />}
      </Card>

      {/* 新增模型映射 */}
      <Dialog open={dlg} onClose={() => setDlg(false)} title="新增模型映射" width={540}>
        <div className="space-y-4">
          <p className="text-xs text-muted">
            为上游供应商关联对外模型名并设定调用单价。多个供应商可配置相同的对外模型名，网关将按优先级自动故障转移与容灾。
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="所属供应商">
              <Select value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })}>
                <option value="">请选择供应商</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}（{p.slug}）</option>)}
              </Select>
            </Field>
            <Field label="优先级（数字越小越优先）">
              <Input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} placeholder="10" />
            </Field>
            <Field label="上游真实模型名">
              <Input
                value={form.upstream}
                onChange={(e) => {
                  const val = e.target.value;
                  setForm({
                    ...form,
                    upstream: val,
                    publicName: form.publicName ? form.publicName : val,
                  });
                }}
                placeholder="例如: deepseek-chat 或 gpt-4o"
              />
            </Field>
            <Field label="对外统一模型名">
              <Input
                value={form.publicName}
                onChange={(e) => setForm({ ...form, publicName: e.target.value })}
                placeholder="例如: deepseek-chat"
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
            修改模型映射与调用定价。修改对外统一模型名后，系统会自动同步更新对应定价配置并热重载路由。
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
            <Field label="优先级（数字越小越优先）">
              <Input
                type="number"
                value={editForm.priority}
                onChange={(e) => setEditForm({ ...editForm, priority: e.target.value })}
                placeholder="10"
              />
            </Field>
            <Field label="上游真实模型名">
              <Input
                value={editForm.upstreamModel}
                onChange={(e) => setEditForm({ ...editForm, upstreamModel: e.target.value })}
                placeholder="例如: deepseek-chat"
              />
            </Field>
            <Field label="对外统一模型名">
              <Input
                value={editForm.publicName}
                onChange={(e) => setEditForm({ ...editForm, publicName: e.target.value })}
                placeholder="例如: deepseek-chat"
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
