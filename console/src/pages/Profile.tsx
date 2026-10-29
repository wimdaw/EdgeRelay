import { useEffect, useRef, useState } from "react";
import { Camera, DatabaseBackup, Download, KeyRound, RefreshCw, Save, Trash2, Upload } from "lucide-react";
import { api, type Me } from "../lib/api";
import { Button, Card, Field, Input, useConfirm, useToast } from "../components/ui";
import { fmtBytes } from "../lib/utils";

type BackupSnapshot = {
  id: string;
  key: string;
  createdAt: string;
  size: number;
  entries: number;
  counts: Record<string, number>;
};

export default function Profile({ me, onRefresh }: { me: Me; onRefresh: () => void }) {
  const [nickname, setNickname] = useState(me.nickname ?? "");
  const [bio, setBio] = useState(me.bio ?? "");
  const [avatarUrl, setAvatarUrl] = useState(me.avatarUrl ?? "");
  const [pw, setPw] = useState({ old: "", next: "", confirm: "" });
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPw, setSavingPw] = useState(false);
  const [snapshots, setSnapshots] = useState<BackupSnapshot[] | null>(null);
  const [backupBusy, setBackupBusy] = useState<"" | "export" | "import" | "snapshot" | "restore" | "delete">("");
  const importRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const isSuperadmin = me.user.role === "superadmin";

  // 刷新后同步最新资料
  useEffect(() => { setNickname(me.nickname ?? ""); setBio(me.bio ?? ""); setAvatarUrl(me.avatarUrl ?? ""); }, [me]);

  const loadSnapshots = async () => {
    try {
      const r = await api<{ snapshots: BackupSnapshot[] }>("/api/admin/backup/list");
      setSnapshots(r.snapshots ?? []);
    } catch {
      setSnapshots([]);
    }
  };

  useEffect(() => {
    if (isSuperadmin) void loadSnapshots();
  }, [isSuperadmin]);

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      await api("/api/user/profile", "PATCH", { nickname, bio });
      toast("资料已保存"); onRefresh();
    } catch (e) { toast((e as Error).message, "err"); } finally { setSavingProfile(false); }
  };

  /** 压缩为 256×256 以内的 PNG（自动处理任意尺寸/格式的照片） */
  const compressAvatar = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const size = 256;
        const scale = Math.min(1, size / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("无法读取该图片，请换一张（支持 JPG/PNG/WebP）")); };
      img.src = url;
    });

  const uploadAvatar = async (file: File) => {
    try {
      const b64 = await compressAvatar(file);
      const r = await api<{ avatarUrl: string }>("/api/user/profile", "POST", { dataBase64: b64 });
      setAvatarUrl(r.avatarUrl); toast("头像已更新"); onRefresh();
    } catch (e) { toast((e as Error).message, "err"); }
  };

  const changePw = async () => {
    if (pw.next !== pw.confirm) return toast("两次输入的新密码不一致", "err");
    setSavingPw(true);
    try {
      const r = await api<{ message?: string }>("/api/user/profile", "PUT", { oldPassword: pw.old, newPassword: pw.next });
      toast(r.message ?? "密码已更新"); setPw({ old: "", next: "", confirm: "" });
    } catch (e) { toast((e as Error).message, "err"); } finally { setSavingPw(false); }
  };

  /** 下载全站 JSON 备份（二次验证失败时唤起全局验证弹窗） */
  const exportBackup = async () => {
    if (backupBusy) return;
    setBackupBusy("export");
    try {
      const res = await fetch("/api/admin/backup/export", { credentials: "same-origin" });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
        if (payload?.error?.code === "step_up_required") window.dispatchEvent(new CustomEvent("gw:stepup"));
        throw new Error(payload?.error?.message || "导出失败");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const filename = (disposition.match(/filename="?([^";]+)/) || [])[1] || `edgerelay-backup-${Date.now()}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("备份文件已开始下载");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBackupBusy("");
    }
  };

  const importBackup = async (file?: File) => {
    if (!file || backupBusy) return;
    try {
      const text = await file.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error("备份文件不是合法 JSON");
      }
      const backup = data as { format?: string; version?: number; entries?: unknown[] };
      if (backup?.format !== "edgerelay-backup" || backup.version !== 1 || !Array.isArray(backup.entries)) {
        throw new Error("不是有效的 EdgeRelay 备份文件");
      }
      const ok = await confirm(`确认用「${file.name}」覆盖当前全部数据？其他设备会被退出登录。`);
      if (!ok) return;

      setBackupBusy("import");
      const r = await api<{ message: string }>("/api/admin/backup/import", "POST", backup);
      toast(r.message);
      onRefresh();
      await loadSnapshots();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBackupBusy("");
      if (importRef.current) importRef.current.value = "";
    }
  };

  const createSnapshot = async () => {
    if (backupBusy) return;
    setBackupBusy("snapshot");
    try {
      const r = await api<{ message: string }>("/api/admin/backup/snapshot", "POST", {});
      toast(r.message);
      await loadSnapshots();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBackupBusy("");
    }
  };

  const restoreSnapshot = async (snapshot: BackupSnapshot) => {
    if (backupBusy) return;
    const time = new Date(snapshot.createdAt).toLocaleString("zh-CN", { hour12: false });
    if (!(await confirm(`确认恢复到 ${time} 的快照？当前数据将被覆盖，其他设备会被退出登录。`))) return;

    setBackupBusy("restore");
    try {
      const r = await api<{ message: string }>("/api/admin/backup/restore", "POST", { id: snapshot.id });
      toast(r.message);
      onRefresh();
      await loadSnapshots();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBackupBusy("");
    }
  };

  const removeSnapshot = async (snapshot: BackupSnapshot) => {
    if (backupBusy) return;
    const time = new Date(snapshot.createdAt).toLocaleString("zh-CN", { hour12: false });
    if (!(await confirm(`确认删除 ${time} 的快照？删除后不可恢复。`))) return;

    setBackupBusy("delete");
    try {
      await api("/api/admin/backup/delete", "POST", { id: snapshot.id });
      toast("快照已删除");
      await loadSnapshots();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBackupBusy("");
    }
  };

  return (
    <div className="grid max-w-3xl gap-5">
      {/* 资料卡 */}
      <Card className="p-5">
        <h2 className="mb-1 text-sm font-semibold">个人资料</h2>
        <p className="mb-5 text-xs text-muted">昵称与介绍会展示在你的账号信息中。</p>
        <div className="flex items-center gap-5">
          <label className="group relative cursor-pointer">
            <span className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-brand/15 text-xl font-semibold text-brand">
              {avatarUrl ? <img src={avatarUrl} alt="头像" className="h-full w-full object-cover" /> : me.user.email[0]?.toUpperCase()}
            </span>
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
              <Camera size={18} className="text-white" />
            </span>
            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAvatar(f); }} />
          </label>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{me.user.email}</div>
            <div className="text-xs text-muted">角色：{me.user.role} · 点击头像更换（自动压缩为 256×256）</div>
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Field label="昵称（最长 32 字）"><Input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="未设置" /></Field>
          <Field label="注册邮箱（不可修改）"><Input value={me.user.email} disabled /></Field>
          <div className="sm:col-span-2"><Field label="个人介绍（最长 200 字）">
            <textarea className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-ink focus:border-brand focus:outline-none" rows={3}
              value={bio} onChange={(e) => setBio(e.target.value)} placeholder="介绍一下自己…" />
          </Field></div>
        </div>
        <div className="mt-4"><Button disabled={savingProfile} onClick={saveProfile}>{savingProfile ? "保存中…" : "保存资料"}</Button></div>
      </Card>

      {/* 密码卡 */}
      <Card className="p-5">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold"><KeyRound size={15} />修改密码</h2>
        <p className="mb-5 text-xs text-muted">修改成功后其他设备将退出登录，当前会话保持。</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="当前密码"><Input type="password" value={pw.old} onChange={(e) => setPw({ ...pw, old: e.target.value })} autoComplete="current-password" /></Field>
          <Field label="新密码（至少 10 位）"><Input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" /></Field>
          <Field label="确认新密码"><Input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" /></Field>
        </div>
        <div className="mt-4"><Button disabled={savingPw} onClick={changePw}>{savingPw ? "提交中…" : "修改密码"}</Button></div>
      </Card>

      {/* 备份卡（仅超级管理员可见） */}
      {isSuperadmin && (
        <Card className="p-5">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold"><DatabaseBackup size={15} />数据备份与恢复</h2>
          <p className="mb-4 text-xs text-muted">导出/导入全站 JSON 备份，或生成保存在 EdgeOne Blob 的站内快照（最多 10 份）。备份包含用户、密钥、渠道、模型、计费、用量与审计日志，不含登录会话。</p>

          <div className="flex flex-wrap gap-2">
            <Button onClick={exportBackup} disabled={!!backupBusy}><Download size={14} />{backupBusy === "export" ? "导出中…" : "导出数据库"}</Button>
            <Button variant="ghost" onClick={() => importRef.current?.click()} disabled={!!backupBusy}><Upload size={14} />导入数据库文件</Button>
            <Button variant="soft" onClick={createSnapshot} disabled={!!backupBusy}><Save size={14} />{backupBusy === "snapshot" ? "生成中…" : "立即生成快照"}</Button>
            <Button variant="ghost" onClick={loadSnapshots} disabled={!!backupBusy}><RefreshCw size={14} />刷新快照</Button>
            <input ref={importRef} type="file" accept=".json,application/json" className="hidden"
              onChange={(e) => importBackup(e.target.files?.[0])} />
          </div>

          <div className="mt-4 rounded-lg border border-warn/30 bg-warn/5 px-3.5 py-2.5 text-[11px] leading-relaxed text-muted">
            导入或恢复会覆盖现有数据，其他设备将被退出登录；当前登录的超级管理员账号与已保存的站内快照会自动保留。
            备份包含密码哈希、API Key 哈希与供应商密钥密文，请妥善保管；跨环境恢复时需保持相同的
            <code className="mx-1 font-mono text-ink">ENCRYPTION_KEY</code>。
          </div>

          <div className="mt-5 border-t border-line pt-4">
            <div className="mb-2 flex items-center justify-between text-xs text-muted">
              <span>站内快照</span>
              <span>{snapshots === null ? "加载中…" : `${snapshots.length} / 10 份`}</span>
            </div>
            {snapshots === null ? (
              <div className="flex flex-col gap-2">{[0, 1].map((i) => <div key={i} className="skeleton h-12" />)}</div>
            ) : snapshots.length === 0 ? (
              <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-muted">还没有快照，点击「立即生成快照」创建第一份。</p>
            ) : (
              <div className="flex flex-col gap-2">
                {snapshots.map((snapshot) => (
                  <div key={snapshot.id} className="flex flex-col gap-2 rounded-lg border border-line bg-surface2/40 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-medium">{new Date(snapshot.createdAt).toLocaleString("zh-CN", { hour12: false })}</div>
                      <div className="text-[11px] text-muted">{snapshot.entries} 项 · {fmtBytes(snapshot.size)}</div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button variant="ghost" className="!px-2.5 !py-1 !text-xs" onClick={() => restoreSnapshot(snapshot)} disabled={!!backupBusy}>恢复</Button>
                      <Button variant="danger" className="!px-2.5 !py-1 !text-xs" onClick={() => removeSnapshot(snapshot)} disabled={!!backupBusy} aria-label="删除快照"><Trash2 size={12} /></Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      {confirmEl}
    </div>
  );
}
