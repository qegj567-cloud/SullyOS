import type { Message } from '../types';
import { isVisibleChatMessage } from './chatMessageVisibility';

const TIMESTAMP_VERSION = 1;
export interface StoryTimelineRepairResult {
    repairedCharacterIds: string[];
    unresolvedCount: number;
}
const repairs = new WeakMap<IDBDatabase, Promise<StoryTimelineRepairResult>>();
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** 剧情设定时间不是现实收发时间；旧孤立副本不能冒充现实日期。 */
export const hasReliableMessageTimestamp = (message: Message): boolean => (
    message.metadata?.source !== 'story_theater_memory'
    || (message.metadata.theaterTimestampVersion === TIMESTAMP_VERSION
        && validTime(message.metadata.theaterReceivedAt)
        && message.timestamp === message.metadata.theaterReceivedAt)
);

export const invalidateStoryTimelineRepair = (db: IDBDatabase): void => { repairs.delete(db); };

/** 同事务读取中央原件并修复副本，保留 ID、正文和记忆水位线。失败不缓存，可重试。 */
export const ensureStoryTimelineRepair = (db: IDBDatabase): Promise<StoryTimelineRepairResult> => {
    const cached = repairs.get(db);
    if (cached) return cached;
    const repair = new Promise<StoryTimelineRepairResult>((resolve, reject) => {
        const transaction = db.transaction('messages', 'readwrite');
        const store = transaction.objectStore('messages');
        const repaired = new Set<string>();
        let unresolvedCount = 0;
        let failure: unknown;
        transaction.oncomplete = () => resolve({ repairedCharacterIds: [...repaired], unresolvedCount });
        transaction.onerror = () => reject(failure || transaction.error || new Error('剧情时间校正失败'));
        transaction.onabort = () => reject(failure || transaction.error || new Error('剧情时间校正事务已回滚'));
        const guarded = (action: () => void) => {
            try { action(); } catch (error) {
                failure = error;
                try { transaction.abort(); } catch { /* 已经中止 */ }
            }
        };
        const scanMirrors = (request: IDBRequest<IDBCursorWithValue | null>, done: () => void) => {
            request.onsuccess = () => guarded(() => {
                const cursor = request.result;
                if (!cursor) { done(); return; }
                const mirror = cursor.value as Message;
                if (!mirror || mirror.metadata?.source !== 'story_theater_memory' || hasReliableMessageTimestamp(mirror)) {
                    cursor.continue();
                    return;
                }
                const apply = (receivedAt: number | undefined) => {
                    if (!validTime(receivedAt)) { unresolvedCount++; cursor.continue(); return; }
                    store.put({ ...mirror, timestamp: receivedAt, metadata: { ...mirror.metadata,
                        theaterTimelineTimestamp: mirror.metadata.theaterTimelineTimestamp ?? mirror.timestamp,
                        theaterTimestampVersion: TIMESTAMP_VERSION, theaterReceivedAt: receivedAt } });
                    repaired.add(mirror.charId);
                    cursor.continue();
                };
                if (mirror.metadata.theaterTimestampVersion === TIMESTAMP_VERSION && validTime(mirror.metadata.theaterReceivedAt)) {
                    apply(mirror.metadata.theaterReceivedAt);
                    return;
                }
                const centralId = mirror.metadata.theaterCentralId;
                if (!Number.isInteger(centralId) || centralId <= 0 || !mirror.metadata.theaterId) { apply(undefined); return; }
                const centralRead = store.get(centralId);
                centralRead.onsuccess = () => guarded(() => {
                    const central = centralRead.result as Message | undefined;
                    const sameTheater = central?.metadata?.source === 'story_theater'
                        && central.charId === `story-theater:${mirror.metadata.theaterId}`
                        && central.metadata.theaterId === mirror.metadata.theaterId
                        && central.role === mirror.role;
                    apply(sameTheater ? central?.timestamp : undefined);
                });
            });
        };
        // 按角色的唯一键枚举，再精确读取该角色的剧情副本。普通聊天和图片不逐条扫描。
        if (store.indexNames.contains('charId_source') && store.indexNames.contains('charId')) {
            const characters = store.index('charId').openKeyCursor(undefined, 'nextunique');
            characters.onsuccess = () => guarded(() => {
                const cursor = characters.result;
                if (!cursor) return;
                scanMirrors(store.index('charId_source').openCursor(IDBKeyRange.only([cursor.key, 'story_theater_memory'])), () => cursor.continue());
            });
        } else {
            // 兼容缺少复合索引的旧库；无需升级 schema 或改动其他应用数据。
            scanMirrors(store.openCursor(), () => {});
        }
    });
    repairs.set(db, repair);
    void repair.catch(() => { if (repairs.get(db) === repair) repairs.delete(db); });
    return repair;
};

/** 仅兜底旧剧情副本：按持久化 ID 确认它早于待回复输入，再挪回该轮输入之前。 */
export const protectPendingChatTurn = (messages: Message[]): Message[] => {
    const online = messages.filter(message => (message.role === 'user' || message.role === 'assistant') && isVisibleChatMessage(message)
        && !(message.role === 'assistant' && message.metadata?.activeMsg2?.taskId != null));
    const latest = online.reduce<Message | undefined>((last, message) => !last || message.id > last.id ? message : last, undefined);
    if (latest?.role !== 'user') return messages;
    const lastReplyId = online.reduce((id, message) => message.role === 'assistant' && message.id < latest.id ? Math.max(id, message.id) : id, 0);
    const pendingIndex = messages.findIndex(message => message.role === 'user' && isVisibleChatMessage(message)
        && message.id > lastReplyId && message.id <= latest.id);
    if (pendingIndex < 0) return messages;
    const displaced = messages.slice(pendingIndex).filter(message => message.metadata?.source === 'story_theater_memory' && message.id < latest.id);
    if (!displaced.length) return messages;
    const moved = new Set(displaced);
    const ordered = messages.filter(message => !moved.has(message));
    // 放回原来的轮次，而不是一律贴在最新输入前，避免已回复过的剧情重复触发切换。
    for (const story of [...displaced].sort((left, right) => left.id - right.id)) {
        const nextIndex = ordered.findIndex(message => message.id > story.id);
        ordered.splice(nextIndex < 0 ? ordered.length : nextIndex, 0, story);
    }
    return ordered;
};
