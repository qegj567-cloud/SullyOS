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
