// 调试面板用：往当前用户空间的记忆关联表里塞大量测试行，真机上复现「关联表很大时导出」的场景。
// 测试行的编号统一带前缀，清除时按主键范围删，不碰真实关联。
import { openDB } from './db';

const STORE = 'memory_links';
export const SEED_LINK_PREFIX = 'ml_seed_';
const SEED_RANGE = () => IDBKeyRange.bound(SEED_LINK_PREFIX, `${SEED_LINK_PREFIX}\uffff`);
/** 一个事务写多少行：太大的事务在手机上容易被中止。 */
const BATCH = 5000;

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('写入测试关联失败'));
});
const count = (db: IDBDatabase, range?: IDBKeyRange) => new Promise<number>((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).count(range);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

export interface SeedLinksResult { seeded: number; total: number; ms: number }

/** 追加 amount 条测试关联（接在已有测试行后面）。强度保留完整小数位，和没压过精度的旧数据一样。 */
export async function seedMemoryLinks(amount: number, onProgress?: (written: number) => void): Promise<SeedLinksResult> {
    const db = await openDB(), started = Date.now(), offset = await count(db, SEED_RANGE());
    for (let written = 0; written < amount;) {
        const tx = db.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE);
        const end = Math.min(amount, written + BATCH);
        for (; written < end; written++) {
            const index = offset + written;
            store.put({
                id: `${SEED_LINK_PREFIX}${String(index).padStart(9, '0')}`,
                sourceId: `mem_seed_${index % 4000}`, targetId: `mem_seed_${(index * 7 + 1) % 4000}`,
                type: index % 5 ? 'emotional' : 'temporal', strength: 0.25 + Math.random() * 0.3,
            });
        }
        await done(tx);
        onProgress?.(written);
    }
    return { seeded: await count(db, SEED_RANGE()), total: await count(db), ms: Date.now() - started };
}

/** 删掉全部测试关联，真实关联不动。 */
export async function clearSeededMemoryLinks(): Promise<SeedLinksResult> {
    const db = await openDB(), started = Date.now();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(SEED_RANGE());
    await done(tx);
    return { seeded: await count(db, SEED_RANGE()), total: await count(db), ms: Date.now() - started };
}
