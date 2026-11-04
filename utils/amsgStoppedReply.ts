import type { AmsgSelfLog } from './amsgFirePack';

export const STOPPED_REPLY_KEY_PREFIX = 'chat_stop:';
export const stoppedReplyKey = (uuid: string): string => `${STOPPED_REPLY_KEY_PREFIX}${uuid}`;

/** 云端角色命名空间最多保留的停止回执条数（与 self_log.entries 上限 8 条对齐）。 */
export const MAX_CLOUD_STOPPED_REPLY_KEYS = 8;

/** 云端停止回执过期时间（24 小时）：远超单轮即时对话最大时长（10 分钟），过期后不再有任何并发任务需要它。 */
export const STOPPED_REPLY_CLOUD_TTL_MS = 24 * 60 * 60 * 1000;

/** Separate per-round receipts also cover a worker finishing its log write after cancellation. */
export function reconcileStoppedReplies(log: AmsgSelfLog | null, rows: Array<{ key: string; value: string }>): AmsgSelfLog | null {
    if (!log) return log;
    const kept = new Map<string, string>();
    for (const row of rows) {
        if (!row.key.startsWith(STOPPED_REPLY_KEY_PREFIX)) continue;
        try {
            const value = JSON.parse(row.value);
            if (typeof value.text === 'string') kept.set(row.key.slice(STOPPED_REPLY_KEY_PREFIX.length), value.text);
        } catch { /* Invalid state cannot delete unrelated history. */ }
    }
    if (kept.size === 0) return log;
    let changed = false;
    const entries = log.entries.flatMap(entry => {
        if (!entry.taskUuid || !kept.has(entry.taskUuid)) return [entry];
        const text = kept.get(entry.taskUuid)!;
        if (!text) {
            changed = true;
            return [];
        }
        if (text !== entry.text) changed = true;
        return [{ ...entry, text }];
    });
    return changed ? { ...log, entries } : log;
}

/**
 * 挑出云端角色命名空间里已经过期或超出保留上限的 `chat_stop:<uuid>` 键，供 fire 收尾顺手清理。
 */
export function pickStaleStoppedReplyKeys(
    rows: ReadonlyArray<{ key: string; updatedAt?: number }>,
    nowMs = Date.now(),
    protectKey?: string | null,
): string[] {
    const stopRows = rows
        .map((row, index) => ({ key: row.key, updatedAt: row.updatedAt, index }))
        .filter(row => row.key.startsWith(STOPPED_REPLY_KEY_PREFIX) && row.key !== protectKey);
    if (stopRows.length === 0) return [];

    const cutoff = nowMs - STOPPED_REPLY_CLOUD_TTL_MS;
    const stale = new Set<string>();
    const fresh: typeof stopRows = [];
    for (const row of stopRows) {
        if (typeof row.updatedAt === 'number' && row.updatedAt > 0 && row.updatedAt < cutoff) {
            stale.add(row.key);
        } else {
            fresh.push(row);
        }
    }
    if (fresh.length > MAX_CLOUD_STOPPED_REPLY_KEYS) {
        fresh.sort((a, b) => {
            const ta = typeof a.updatedAt === 'number' ? a.updatedAt : 0;
            const tb = typeof b.updatedAt === 'number' ? b.updatedAt : 0;
            return ta !== tb ? ta - tb : a.index - b.index;
        });
        const overflow = fresh.length - MAX_CLOUD_STOPPED_REPLY_KEYS;
        for (let i = 0; i < overflow; i += 1) {
            stale.add(fresh[i].key);
        }
    }
    return [...stale];
}
