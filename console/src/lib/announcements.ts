/** 公告已读状态：按用户记录已看过的公告 id，存 localStorage 跨会话保留 */
const keyFor = (userId: string) => `gw-ann-seen-${userId}`;

export function getSeenAnnouncementIds(userId: string): Set<string> {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

export function markAnnouncementsSeen(userId: string, ids: string[]): void {
  if (!ids.length) return;
  try {
    const seen = getSeenAnnouncementIds(userId);
    for (const id of ids) seen.add(String(id));
    // 只保留最近 200 条，避免 localStorage 无限增长
    localStorage.setItem(keyFor(userId), JSON.stringify(Array.from(seen).slice(-200)));
  } catch {}
}
