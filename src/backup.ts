/**
 * EdgeRelay 全站备份 / 恢复（EdgeOne Blob 原生实现，无 R2 依赖）
 *
 * 备份以 Blob key 为粒度导出，后续新增的数据类型会自动被覆盖。
 * 排除项：
 *  - session:*  登录会话（恢复后仅保留当前管理员会话）
 *  - backup:*   站内快照索引与快照文件，避免递归备份
 *  - kv/*       邮箱验证码、限流等瞬时状态
 */
import type { Env, UserRecord } from "./types";
import { getBlobStore, type BlobStore } from "./storage/blob-store";
import { getSession, getUserById, invalidateStorageCaches, flushUsageWrites } from "./storage/db";
import { ApiError, ErrorCode } from "./errors";

export const BACKUP_FORMAT = "edgerelay-backup";
export const BACKUP_VERSION = 1;

const SNAPSHOT_INDEX_KEY = "backup:index";
const SNAPSHOT_PREFIX = "backup:snapshot:";
const SNAPSHOT_LIMIT = 10;

const EXCLUDED_PREFIXES = ["session:", "backup:", "kv/"];

export type BackupEntry = { key: string; value: unknown; raw?: true };

export type BackupFile = {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  counts: Record<string, number>;
  entries: BackupEntry[];
};

export type BackupSnapshotMeta = {
  id: string;
  key: string;
  createdAt: string;
  size: number;
  entries: number;
  counts: Record<string, number>;
};

export type ImportResult = { entries: number; counts: Record<string, number> };

function isExcluded(key: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** 小并发池：Blob 没有批量读写接口，串行会非常慢，并发太高又容易触发限流 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) break;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 150 * (i + 1)));
    }
  }
  throw lastError;
}

async function listAllKeys(store: BlobStore): Promise<string[]> {
  const res = await store.list({ paginate: true, consistency: "strong" });
  return (res.blobs || []).map((blob) => blob.key);
}

/** 读取单条数据：JSON 原样保留；头像等纯文本以 raw 形式保存 */
async function readEntry(store: BlobStore, key: string): Promise<BackupEntry | null> {
  const text = await store.get(key, { type: "text", consistency: "strong" });
  if (text === null || text === undefined) return null;
  if (typeof text !== "string") return { key, value: text };
  try {
    return { key, value: JSON.parse(text) };
  } catch {
    return { key, value: text, raw: true };
  }
}

function countEntries(entries: BackupEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
  };

  for (const entry of entries) {
    const key = entry.key;
    if (key.startsWith("user:")) bump("users");
    else if (key.startsWith("key:")) bump("apiKeys");
    else if (key === "providers:all" || key.startsWith("provider_keys:")) bump("providers");
    else if (key === "models:all" || key === "pricing:all") bump("models");
    else if (key.startsWith("usage:")) bump("usage");
    else if (key.startsWith("balance:") || key.startsWith("ledger:")) bump("billing");
    else if (key === "audit:chain") bump("audit");
    else if (key.startsWith("avatar:")) bump("avatars");
    else if (key === "settings:platform") bump("settings");
    else if (key.startsWith("idx:")) bump("indexes");
    else if (key.startsWith("redeem_codes:")) bump("redeemCodes");
    else if (key === "announcements:all" || key === "content_flags:all" || key === "appeals:all") bump("ops");
    else bump("other");
  }
  return counts;
}

/** 全量导出：Blob 中的全部业务数据，排除会话、快照自身与瞬时 KV */
export async function buildBackup(env: Env): Promise<BackupFile> {
  // 先把内存缓冲中的用量/账本潮写落库，保证导出包含最新数据
  await flushUsageWrites(env).catch(() => {});
  const store = getBlobStore(env);
  const keys = (await listAllKeys(store)).filter((key) => !isExcluded(key));
  const entries = (await mapLimit(keys, 10, (key) => readEntry(store, key))).filter(Boolean) as BackupEntry[];
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    counts: countEntries(entries),
    entries,
  };
}

/** 覆盖式恢复：清空业务数据后写入备份；保留站内快照、当前超级管理员与当前会话 */
export async function restoreBackupData(
  env: Env,
  data: BackupFile,
  options: { currentUserId?: string; currentSessionId?: string } = {}
): Promise<ImportResult> {
  if (!data || data.format !== BACKUP_FORMAT || Number(data.version) !== BACKUP_VERSION || !Array.isArray(data.entries)) {
    throw new ApiError(400, ErrorCode.BAD_REQUEST, "不是有效的 EdgeRelay 备份文件");
  }

  const entries = data.entries.filter(
    (entry): entry is BackupEntry =>
      !!entry && typeof entry.key === "string" && entry.key.length > 0 && !isExcluded(entry.key)
  );
  if (entries.length === 0) {
    throw new ApiError(400, ErrorCode.BAD_REQUEST, "备份文件不包含任何数据");
  }

  const store = getBlobStore(env);

  // 清空前的现场：当前管理员与会话在导入后要原样恢复，避免恢复完无法登录
  const currentUser = options.currentUserId ? await getUserById(env, options.currentUserId) : null;
  const currentSession = options.currentSessionId ? await getSession(env, options.currentSessionId) : null;

  // 1. 清空全部业务数据（保留 backup: 前缀的站内快照）
  const existingKeys = await listAllKeys(store);
  await mapLimit(
    existingKeys.filter((key) => !key.startsWith("backup:")),
    10,
    (key) => withRetry(() => store.delete(key)).catch(() => undefined)
  );

  // 2. 写入备份数据
  await mapLimit(entries, 10, (entry) =>
    withRetry(() => (entry.raw ? store.set(entry.key, String(entry.value)) : store.setJSON(entry.key, entry.value)))
  );

  // 恢复后立即清空进程内缓存，后续读取一律以刚写入的 Blob 数据为准
  invalidateStorageCaches();

  // 3. 恢复当前超级管理员：保留当前密码与二次验证状态，避免恢复后无法登录；
  //    昵称、简介等资料仍以备份中的记录为准。
  if (currentUser) {
    const restoredAdmin = await getUserById(env, currentUser.id);
    const admin: UserRecord = restoredAdmin
      ? {
          ...restoredAdmin,
          role: "superadmin",
          status: "active",
          passwordHash: currentUser.passwordHash,
          stepUpUntil: currentUser.stepUpUntil,
        }
      : { ...currentUser, role: "superadmin", status: "active" };

    await store.setJSON(`user:${admin.id}`, admin);
    await store.setJSON(`idx:user:email:${encodeURIComponent(admin.email.trim().toLowerCase())}`, { userId: admin.id });

    const rawIndex = await store.get("idx:users:all", { type: "json", consistency: "strong" });
    const userIds: string[] = Array.isArray(rawIndex) ? rawIndex.filter((id): id is string => typeof id === "string") : [];
    if (!userIds.includes(admin.id)) {
      userIds.unshift(admin.id);
      await store.setJSON("idx:users:all", userIds);
    }
  }

  // 4. 其它设备的会话在清空时已全部删除，这里只恢复当前浏览器会话
  if (currentSession) {
    await store.setJSON(`session:${currentSession.id}`, currentSession);
  }

  invalidateStorageCaches();
  return { entries: entries.length, counts: countEntries(entries) };
}

export async function listBackupSnapshots(env: Env): Promise<BackupSnapshotMeta[]> {
  const store = getBlobStore(env);
  const raw = await store.get(SNAPSHOT_INDEX_KEY, { type: "json", consistency: "strong" });
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is BackupSnapshotMeta =>
      !!item && typeof item.id === "string" && typeof item.key === "string" && typeof item.createdAt === "string"
  );
}

/** 生成站内快照：数据保存在 EdgeOne Blob 的 backup:snapshot:* 键下，最多保留 10 份 */
export async function createBackupSnapshot(env: Env): Promise<{ snapshot: BackupSnapshotMeta; message: string }> {
  const store = getBlobStore(env);
  const data = await buildBackup(env);
  const json = JSON.stringify(data);
  const id = data.exportedAt.replace(/[:.]/g, "-");
  const key = `${SNAPSHOT_PREFIX}${id}`;

  await withRetry(() => store.set(key, json));

  const snapshot: BackupSnapshotMeta = {
    id,
    key,
    createdAt: data.exportedAt,
    size: new TextEncoder().encode(json).byteLength,
    entries: data.entries.length,
    counts: data.counts,
  };

  const current = await listBackupSnapshots(env);
  const next = [snapshot, ...current.filter((item) => item.id !== snapshot.id)];
  const pruned = next.slice(SNAPSHOT_LIMIT);
  await store.setJSON(SNAPSHOT_INDEX_KEY, next.slice(0, SNAPSHOT_LIMIT));
  for (const old of pruned) {
    await withRetry(() => store.delete(old.key)).catch(() => undefined);
  }

  return { snapshot, message: `快照已生成（${snapshot.entries} 项数据）` };
}

export async function restoreBackupSnapshot(
  env: Env,
  id: string,
  options: { currentUserId?: string; currentSessionId?: string } = {}
): Promise<ImportResult> {
  if (!id) throw new ApiError(400, ErrorCode.BAD_REQUEST, "未指定要恢复的快照");
  const snapshot = (await listBackupSnapshots(env)).find((item) => item.id === id);
  if (!snapshot) throw new ApiError(404, ErrorCode.NOT_FOUND, "快照不存在或已被清理");

  const data = await getBlobStore(env).get(snapshot.key, { type: "json", consistency: "strong" });
  if (!data) throw new ApiError(404, ErrorCode.NOT_FOUND, "快照文件已丢失");
  return await restoreBackupData(env, data as BackupFile, options);
}

export async function deleteBackupSnapshot(env: Env, id: string): Promise<void> {
  if (!id) throw new ApiError(400, ErrorCode.BAD_REQUEST, "未指定要删除的快照");
  const store = getBlobStore(env);
  const snapshots = await listBackupSnapshots(env);
  const snapshot = snapshots.find((item) => item.id === id);
  if (!snapshot) throw new ApiError(404, ErrorCode.NOT_FOUND, "快照不存在或已被清理");

  await withRetry(() => store.delete(snapshot.key)).catch(() => undefined);
  await store.setJSON(SNAPSHOT_INDEX_KEY, snapshots.filter((item) => item.id !== id));
}
