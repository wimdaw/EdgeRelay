import { useEffect, useRef, useState } from "react";
import { Bot, DatabaseBackup, Download, RefreshCw, Save, Send, Trash2, Upload } from "lucide-react";
import { api } from "../lib/api";
import { Button, Card, Field, Input, useConfirm, useToast } from "../components/ui";
import { cn, fmtBytes } from "../lib/utils";

type BackupSnapshot = {
  id: string;
  key: string;
  createdAt: string;
  size: number;
  entries: number;
  counts: Record<string, number>;
};

type TelegramStatus = {
  configured: boolean;
  chatId: string;
  botTokenMasked: string;
};

export default function Backup() {
  const [snapshots, setSnapshots] = useState<BackupSnapshot[] | null>(null);
  const [backupBusy, setBackupBusy] = useState<"" | "export" | "import" | "snapshot" | "restore" | "delete">("");
  const [tgStatus, setTgStatus] = useState<TelegramStatus | null>(null);
  const [tgForm, setTgForm] = useState({ botToken: "", chatId: "" });
  const [tgBusy, setTgBusy] = useState<"" | "save" | "test" | "push" | "clear">("");
  const importRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();

  const loadSnapshots = async () => {
    try {
      const r = await api<{ snapshots: BackupSnapshot[] }>("/api/admin/backup/list");
      setSnapshots(r.snapshots ?? []);
    } catch {
      setSnapshots([]);
    }
  };

  const loadTelegram = async () => {
    try {
      const r = await api<TelegramStatus>("/api/admin/backup/telegram");
      setTgStatus(r);
      setTgForm((form) => ({ ...form, chatId: r.chatId ?? "" }));
    } catch {
      setTgStatus({ configured: false, chatId: "", botTokenMasked: "" });
    }
  };

  useEffect(() => {
    void loadSnapshots();
    void loadTelegram();
  }, []);

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

  const saveTelegram = async () => {
    if (tgBusy) return;
    setTgBusy("save");
    try {
      const r = await api<{ message: string; status: TelegramStatus }>("/api/admin/backup/telegram", "POST", {
        botToken: tgForm.botToken.trim() || undefined,
        chatId: tgForm.chatId.trim(),
      });
      setTgStatus(r.status);
      setTgForm({ botToken: "", chatId: r.status.chatId });
      toast(r.message);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setTgBusy("");
    }
  };

  const testTelegram = async () => {
    if (tgBusy) return;
    setTgBusy("test");
    try {
      const r = await api<{ message: string }>("/api/admin/backup/telegram/test", "POST", {
        botToken: tgForm.botToken.trim() || undefined,
        chatId: tgForm.chatId.trim() || undefined,
      });
      toast(r.message);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setTgBusy("");
    }
  };

  const pushTelegram = async () => {
    if (tgBusy || !tgStatus?.configured) return;
    setTgBusy("push");
    try {
      const r = await api<{ message: string }>("/api/admin/backup/telegram/push", "POST", {});
      toast(r.message);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setTgBusy("");
    }
  };

  const clearTelegram = async () => {
    if (tgBusy) return;
    if (!(await confirm("确认清除 Telegram 机器人配置？清除后需要重新填写 Bot Token 和 Chat ID。"))) return;

    setTgBusy("clear");
    try {
      await api("/api/admin/backup/telegram/clear", "POST", {});
      setTgStatus({ configured: false, chatId: "", botTokenMasked: "" });
      setTgForm({ botToken: "", chatId: "" });
      toast("Telegram 配置已清除");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setTgBusy("");
    }
  };

  const tgBusyAny = !!tgBusy;

  return (
    <div className="grid max-w-3xl gap-5">
      {/* 本地备份 */}
      <Card className="p-5">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold"><DatabaseBackup size={15} />本地备份</h2>
        <p className="mb-4 text-xs text-muted">导出全站数据为 JSON 文件，或用备份文件覆盖恢复。备份包含用户、密钥、渠道、模型、计费、用量与审计日志，不含登录会话。</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={exportBackup} disabled={!!backupBusy}><Download size={14} />{backupBusy === "export" ? "导出中…" : "导出数据库"}</Button>
          <Button variant="ghost" onClick={() => importRef.current?.click()} disabled={!!backupBusy}><Upload size={14} />导入数据库文件</Button>
          <input ref={importRef} type="file" accept=".json,application/json" className="hidden"
            onChange={(e) => importBackup(e.target.files?.[0])} />
        </div>
        <div className="mt-4 rounded-lg border border-warn/30 bg-warn/5 px-3.5 py-2.5 text-[11px] leading-relaxed text-muted">
          导入会覆盖现有数据，其他设备将被退出登录；当前登录的超级管理员账号与已保存的站内快照会自动保留。
          备份包含密码哈希、API Key 哈希与供应商密钥密文，请妥善保管；跨环境恢复时需保持相同的
          <code className="mx-1 font-mono text-ink">ENCRYPTION_KEY</code>。
        </div>
      </Card>

      {/* 站内快照 */}
      <Card className="p-5">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold"><RefreshCw size={15} />站内快照</h2>
        <p className="mb-4 text-xs text-muted">快照保存在 EdgeOne Blob 内，最多保留 10 份，不依赖 R2 等外部对象存储。</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="soft" onClick={createSnapshot} disabled={!!backupBusy}><Save size={14} />{backupBusy === "snapshot" ? "生成中…" : "立即生成快照"}</Button>
          <Button variant="ghost" onClick={loadSnapshots} disabled={!!backupBusy}><RefreshCw size={14} />刷新快照</Button>
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <div className="mb-2 flex items-center justify-between text-xs text-muted">
            <span>快照列表</span>
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

      {/* Telegram 机器人备份 */}
      <Card className="p-5">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold"><Bot size={15} />Telegram 机器人备份</h2>
        <p className="mb-4 text-xs text-muted">配置 Telegram Bot 后，可把完整 JSON 备份作为文件推送到指定会话。Bot Token 会加密保存，页面只显示掩码。</p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Bot Token" hint={tgStatus?.configured ? `已配置：${tgStatus.botTokenMasked}` : "向 @BotFather 获取"}>
            <Input
              type="password"
              value={tgForm.botToken}
              onChange={(e) => setTgForm({ ...tgForm, botToken: e.target.value })}
              placeholder={tgStatus?.configured ? "留空则保持现有 Token" : "123456789:AA..."}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Chat ID" hint="私聊 / 群组 / 频道的数字 ID">
            <Input
              value={tgForm.chatId}
              onChange={(e) => setTgForm({ ...tgForm, chatId: e.target.value })}
              placeholder="-1001234567890"
            />
          </Field>
        </div>

        <div className="mt-3 flex items-center gap-2 text-[11px] text-muted">
          <span className={cn("h-2 w-2 rounded-full", tgStatus?.configured ? "bg-ok" : "bg-muted/40")} />
          {tgStatus?.configured ? `已配置（Chat ID：${tgStatus.chatId}）` : "尚未配置"}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={saveTelegram} disabled={tgBusyAny}><Save size={14} />{tgBusy === "save" ? "保存中…" : "保存配置"}</Button>
          <Button variant="ghost" onClick={testTelegram} disabled={tgBusyAny}><Send size={14} />{tgBusy === "test" ? "发送中…" : "发送测试消息"}</Button>
          <Button variant="soft" onClick={pushTelegram} disabled={tgBusyAny || !tgStatus?.configured}><Upload size={14} />{tgBusy === "push" ? "推送中…" : "推送备份到 Telegram"}</Button>
          {tgStatus?.configured && (
            <Button variant="danger" onClick={clearTelegram} disabled={tgBusyAny}><Trash2 size={14} />清除配置</Button>
          )}
        </div>

        <p className="mt-3 text-[11px] leading-relaxed text-muted">
          推送内容与「导出数据库」下载的 JSON 文件一致。Telegram 配置保存在站内且不会写进备份文件；推送前请先保存配置。
        </p>
      </Card>

      {confirmEl}
    </div>
  );
}
