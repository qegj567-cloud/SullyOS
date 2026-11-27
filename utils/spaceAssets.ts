import { hashBlob } from '@rei-standard/blob-store';
import { openSpaceDB, DB } from './db';
import { listUserSpaces, rawSpaceStorage, SESSION_SPACE_ID, SPACE_DELETIONS_KEY } from './userSpaces';
import { openCollaborationSpace } from '../features/collaboration/store';

/** Scan every persisted space, including nested JSON and private localStorage values. Fail closed. */
export async function* allSpaceReferenceSources(): AsyncGenerator<string> {
    const ids = new Set([...listUserSpaces().map(s => s.id), SESSION_SPACE_ID]);
    // A lost localStorage catalog must not make another surviving database invisible to GC.
    if (indexedDB.databases) for (const db of await indexedDB.databases()) {
        const match = /^(?:AetherOS_Data|SullyOS_Collaboration)__(u_[a-zA-Z0-9_-]+)$/.exec(db.name || '');
        if (match) ids.add(match[1]);
    }
    for (const spaceId of ids) {
        for (const db of [await openSpaceDB(spaceId), await openCollaborationSpace(spaceId)]) {
        for (const store of Array.from(db.objectStoreNames).filter(n => n !== 'blob_assets')) {
            let after: IDBValidKey | undefined;
            for (;;) {
                const page = await new Promise<{ rows: any[]; keys: IDBValidKey[] }>((resolve, reject) => {
                    const tx = db.transaction(store), table = tx.objectStore(store);
                    const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
                    const rows = table.getAll(range, 100), keys = table.getAllKeys(range, 100);
                    tx.oncomplete = () => resolve({ rows: rows.result, keys: keys.result });
                    tx.onerror = tx.onabort = () => reject(tx.error);
                });
                for (const row of page.rows) yield JSON.stringify(row);
                if (page.rows.length < 100) break;
                after = page.keys.at(-1);
            }
        }
        }
    }
    const storage = rawSpaceStorage;
    if (storage) {
        const values = Array.from({ length: storage.length }, (_, i) => storage.key(i)!).filter(key => key !== SPACE_DELETIONS_KEY).map(key => storage.getItem(key));
        for (const value of values) if (value) yield value;
    }
}
export async function isSharedAssetReferenced(id: string): Promise<boolean> {
    for await (const text of allSpaceReferenceSources()) if (text.includes(id)) return true;
    return false;
}

const isIdChar = (code: number) => code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 95;
// 这种 id 才能走下面的快路：全是 [A-Za-z0-9_] 且带下划线。图片池里可删的 id（img_ / b_ 开头）都是。
const isRunMatchable = (id: string) => id.includes('_') && /^[A-Za-z0-9_]+$/.test(id);
// 记过的字符段不重复比对；太长的不记，免得把大段文本钉在内存里。
const SEEN_RUN_MAX_LENGTH = 64;

/**
 * 把 pending 里在 text 中出现的 id 挪进 found。判定与逐个 `text.includes(id)` 完全相同
 * （子串即算，id 是更长字符串的一部分、不带 blobref: 前缀裸出现都算），只是不做「id 数 × 全文」的搜索：
 * 全由 [A-Za-z0-9_] 组成的 id 若在 text 里出现，必然整个落在某一段连续的这类字符里；id 自己带下划线，
 * 那一段也就带下划线。所以只把带下划线的段切出来比对，base64 这类大段文本（没有下划线）一次扫过。
 * 不满足这个形状的 id 老老实实全文 includes。seenRuns 由调用方跨多段文本共用。
 */
export function collectReferencedIds(text: string, pending: Set<string>, found: Set<string>, seenRuns: Set<string> = new Set()): void {
    const hit = (id: string) => { pending.delete(id); found.add(id); };
    for (const id of [...pending]) if (!isRunMatchable(id) && text.includes(id)) hit(id);
    for (let from = 0; pending.size > 0;) {
        const underscore = text.indexOf('_', from);
        if (underscore === -1) return;
        let start = underscore, end = underscore + 1;
        while (start > 0 && isIdChar(text.charCodeAt(start - 1))) start--;
        while (end < text.length && isIdChar(text.charCodeAt(end))) end++;
        from = end; // 这一段里剩下的下划线属于同一段，不用再切一次
        const run = text.slice(start, end);
        // 见过的段不用再比：当时没命中的 id 现在也不会命中，命中的已经不在 pending 里了。
        if (seenRuns.has(run)) continue;
        if (run.length <= SEEN_RUN_MAX_LENGTH) seenRuns.add(run);
        for (const id of [...pending]) if (run.includes(id)) hit(id);
    }
}

/** isSharedAssetReferenced 的批量版：把全部来源过一遍，返回 ids 里仍被引用的那些。读不出来就上抛。 */
export async function findReferencedSharedAssets(ids: readonly string[]): Promise<Set<string>> {
    const pending = new Set(ids), found = new Set<string>(), seenRuns = new Set<string>();
    for await (const text of allSpaceReferenceSources()) {
        if (pending.size === 0) break;
        if (typeof text === 'string') collectReferencedIds(text, pending, found, seenRuns);
    }
    return found;
}
export async function putSharedImage(blob: Blob): Promise<string> {
    const hash = await hashBlob(blob);
    const canonical = `pool_${hash.replace(/[^a-zA-Z0-9_]/g, '')}`;
    const db = await openSpaceDB('default');
    const entry = await new Promise<any>((resolve, reject) => { const req = db.transaction('blob_assets').objectStore('blob_assets').get(canonical); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    if (entry?.preferredId) {
        const preferred = await DB.getBlobAsset(entry.preferredId);
        if (preferred?.type === blob.type && await hashBlob(preferred) === hash) return `blobref:${entry.preferredId}`;
    }
    return (await import('./blobStore')).blobStore.put(blob);
}
