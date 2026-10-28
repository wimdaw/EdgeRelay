/**
 * EdgeOne Blob 底层驱动与兼容层
 */
import { getStore as edgeoneGetStore } from "@edgeone/pages-blob";

export interface BlobStore {
  get(key: string, options?: { type?: 'text' | 'json' | 'stream'; consistency?: 'strong' | 'eventual' }): Promise<any>;
  set(key: string, value: string | Buffer | Uint8Array, options?: any): Promise<void>;
  setJSON(key: string, value: any, options?: any): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; paginate?: boolean; consistency?: 'strong' | 'eventual' }): Promise<{
    blobs: Array<{ key: string; size?: number; uploadedAt?: string }>;
    cursor?: string;
  }>;
}

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    cursor?: string;
    list_complete: boolean;
  }>;
}

let cachedBlobStore: BlobStore | null = null;

/** 内存兜底 Store（仅当连不上 Blob 且用于极速测试时使用） */
function createMemoryStore(): BlobStore {
  const map = new Map<string, any>();
  return {
    async get(key: string, opts?: any) {
      const v = map.get(key);
      if (v === undefined) return null;
      if (opts?.type === 'json') {
        return typeof v === 'string' ? JSON.parse(v) : v;
      }
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
    async set(key: string, val: any) {
      map.set(key, val);
    },
    async setJSON(key: string, val: any) {
      map.set(key, JSON.parse(JSON.stringify(val)));
    },
    async delete(key: string) {
      map.delete(key);
    },
    async list(opts?: any) {
      const prefix = opts?.prefix ?? '';
      const blobs: Array<{ key: string }> = [];
      for (const k of map.keys()) {
        if (k.startsWith(prefix)) blobs.push({ key: k });
      }
      return { blobs };
    },
  };
}

/**
 * 获取 EdgeOne Blob Store 单例
 * 强制使用 consistency: "strong"
 */
export function getBlobStore(env?: any): BlobStore {
  if (cachedBlobStore) return cachedBlobStore;

  const storeName = env?.BLOB_STORE_NAME || 'edgerelay-db';

  // 关键：API Token 模式下必须同时提供 projectId 与 token
  const projectId =
    env?.EDGEONE_PROJECT_ID ||
    env?.PAGES_PROJECT_ID ||
    (typeof process !== 'undefined' ? (process.env.EDGEONE_PROJECT_ID || process.env.PAGES_PROJECT_ID) : undefined) ||
    'makers-fdbswhfbvvwm';

  const token =
    env?.EDGEONE_TOKEN_NEW ||
    env?.EDGEONE_TOKEN ||
    env?.EDGEONE_PAGES_API_TOKEN ||
    (typeof process !== 'undefined' ? (process.env.EDGEONE_TOKEN_NEW || process.env.EDGEONE_TOKEN || process.env.EDGEONE_PAGES_API_TOKEN) : undefined) ||
    'cQ7qRdUvqqCTxZx9OyiY0jsmP+qLQjDRCTR0bCYCH/k=';

  try {
    if (typeof edgeoneGetStore === 'function') {
      cachedBlobStore = edgeoneGetStore({
        name: storeName,
        consistency: 'strong',
        projectId,
        token,
      });
      console.log(`[BlobStore] 成功初始化 EdgeOne Blob Store: ${storeName} (ProjectId: ${projectId})`);
      return cachedBlobStore!;
    }
  } catch (err: any) {
    console.error('[BlobStore] 初始化失败，回退到内存存储:', err?.message);
    cachedBlobStore = createMemoryStore();
    return cachedBlobStore;
  }

  cachedBlobStore = createMemoryStore();
  return cachedBlobStore;
}

/**
 * 包装为类似 Cloudflare KV 的通用接口
 */
export function getKV(env?: any): KVLike {
  const store = getBlobStore(env);
  return {
    async get(key: string): Promise<string | null> {
      try {
        const blobKey = `kv/${encodeURIComponent(key)}.json`;
        const item = await store.get(blobKey, { type: 'json', consistency: 'strong' });
        if (!item) return null;
        if (item.expiresAt && item.expiresAt < Math.floor(Date.now() / 1000)) {
          await store.delete(blobKey).catch(() => {});
          return null;
        }
        return typeof item.value === 'string' ? item.value : JSON.stringify(item.value);
      } catch {
        return null;
      }
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      const blobKey = `kv/${encodeURIComponent(key)}.json`;
      const expiresAt = options?.expirationTtl
        ? Math.floor(Date.now() / 1000) + options.expirationTtl
        : null;
      await store.setJSON(blobKey, {
        key,
        value,
        expiresAt,
        updatedAt: Date.now(),
      });
    },
    async delete(key: string): Promise<void> {
      const blobKey = `kv/${encodeURIComponent(key)}.json`;
      await store.delete(blobKey).catch(() => {});
    },
    async list(options?: { prefix?: string; cursor?: string }): Promise<{
      keys: Array<{ name: string }>;
      cursor?: string;
      list_complete: boolean;
    }> {
      const prefix = options?.prefix ?? '';
      const blobPrefix = `kv/${encodeURIComponent(prefix)}`;
      const res = await store.list({
        prefix: blobPrefix,
        cursor: options?.cursor,
        paginate: false,
        consistency: 'strong',
      });
      const keys: Array<{ name: string }> = [];
      for (const b of res.blobs || []) {
        if (!b.key.startsWith('kv/') || !b.key.endsWith('.json')) continue;
        const rawEncoded = b.key.slice(3, -5);
        try {
          keys.push({ name: decodeURIComponent(rawEncoded) });
        } catch {
          keys.push({ name: rawEncoded });
        }
      }
      return {
        keys,
        list_complete: !res.cursor,
        cursor: res.cursor,
      };
    },
  };
}
