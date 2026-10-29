/**
 * 进程内 TTL 缓存（EdgeOne Blob 热路径加速）
 *
 * 设计目标：
 *  - 每次 Blob 强一致读写都有 100ms 级网络往返，热路径必须尽量零 I/O
 *  - single-flight：并发冷启动只触发一次远端加载，避免缓存击穿
 *  - stale-while-revalidate：TTL 过期后先返回旧值并后台刷新，请求永远不等待刷新
 *  - 写入后显式 set/delete 立即生效（配合 storage/db.ts 的写路径）
 */

type Entry<V> = { val: V; at: number };

export class TtlCache<V> {
  private map = new Map<string, Entry<V>>();
  private inflight = new Map<string, Promise<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs: number, maxEntries = 5000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  peek(key: string): V | undefined {
    return this.map.get(key)?.val;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  async get(key: string, loader: () => Promise<V>): Promise<V> {
    const now = Date.now();
    const entry = this.map.get(key);

    if (entry) {
      if (now - entry.at <= this.ttlMs) return entry.val;
      // 已过期：先返回旧值，后台刷新（不阻塞请求）
      if (!this.inflight.has(key)) {
        this.load(key, loader).catch(() => {});
      }
      return entry.val;
    }

    const pending = this.inflight.get(key);
    if (pending) return pending;
    return this.load(key, loader);
  }

  set(key: string, val: V): void {
    this.map.delete(key);
    this.map.set(key, { val, at: Date.now() });
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done && oldest.value !== key) this.map.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.inflight.clear();
  }

  private load(key: string, loader: () => Promise<V>): Promise<V> {
    const p = (async () => {
      try {
        const val = await loader();
        this.set(key, val);
        return val;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}

/** 有界并发 map：把 N 次串行 Blob 读压成 N/limit 轮往返 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Math.min(Math.max(1, limit), items.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const idx = cursor++;
        if (idx >= items.length) return;
        results[idx] = await fn(items[idx]!, idx);
      }
    })
  );
  return results;
}
