import { DB, openDB } from '../db';

const LOCAL_KEY = (charId: string) => `mp_lastMsgId_${charId}`;
const MIRROR_KEY = (charId: string) => `mp_hwm_v1_${charId}`;

interface HighWaterMarkMirror {
    version: 1;
    charId: string;
    msgId: number;
    updatedAt: number;
}

function normalizeMessageId(value: unknown): number {
    const parsed = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

/** 同步读取供聊天上下文过滤使用；后台管线会再用 IndexedDB 镜像校准。 */
export function getLocalMemoryPalaceHighWaterMark(charId: string): number {
    try {
        return normalizeMessageId(localStorage.getItem(LOCAL_KEY(charId)));
    } catch {
        return 0;
    }
}

/**
 * 读取 localStorage 与 IndexedDB 中较新的水位线。
 *
 * 部分第三方移动浏览器会只清理/隔离 localStorage，却保留 IndexedDB 中的消息。
 * 水位线是单调递增值，因此取两者最大值既能修复这种驱逐，也不会覆盖更新的数据。
 */
export async function getReliableMemoryPalaceHighWaterMark(charId: string): Promise<number> {
    try {
        const db = await openDB();
        // 与 saveMessage 的镜像自愈共享 assets 事务锁。不能在 await 前缓存本地旧值，
        // 也不能读完后再另开事务写回：中间可能已经落入新消息并清掉失效水位。
        return await new Promise<number>((resolve, reject) => {
            const tx = db.transaction('assets', 'readwrite');
            const assets = tx.objectStore('assets');
            const request = assets.get(MIRROR_KEY(charId));
            let reliableValue = 0;
            request.onsuccess = () => {
                const mirror = request.result?.data as Partial<HighWaterMarkMirror> | number | null;
                const mirroredValue = normalizeMessageId(typeof mirror === 'number' ? mirror : mirror?.msgId);
                const localValue = getLocalMemoryPalaceHighWaterMark(charId);
                reliableValue = Math.max(localValue, mirroredValue);
                if (reliableValue > mirroredValue) {
                    assets.put({ id: MIRROR_KEY(charId), data: {
                        version: 1, charId, msgId: reliableValue, updatedAt: Date.now(),
                    } satisfies HighWaterMarkMirror });
                }
            };
            tx.oncomplete = () => {
                if (reliableValue > getLocalMemoryPalaceHighWaterMark(charId)) {
                    try { localStorage.setItem(LOCAL_KEY(charId), String(reliableValue)); } catch { /* 镜像仍可用 */ }
                }
                resolve(reliableValue);
            };
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('水位读取事务中止'));
        });
    } catch {
        // 失败后读取当前本地值，不恢复进入函数前的旧快照。
        return getLocalMemoryPalaceHighWaterMark(charId);
    }
}

/** 成功处理消息后同时写两份；任意一份幸存即可避免旧消息被整批重复提取。 */
export async function setReliableMemoryPalaceHighWaterMark(charId: string, msgId: number): Promise<void> {
    const normalized = normalizeMessageId(msgId);

    try {
        localStorage.setItem(LOCAL_KEY(charId), String(normalized));
    } catch {
        // 继续尝试 IndexedDB。
    }

    try {
        await DB.saveAssetRaw(MIRROR_KEY(charId), {
            version: 1,
            charId,
            msgId: normalized,
            updatedAt: Date.now(),
        } satisfies HighWaterMarkMirror);
    } catch {
        // 与旧行为一致：持久化故障不抹掉已经成功写入的记忆。
    }
}
