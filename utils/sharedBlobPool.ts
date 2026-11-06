import { hashBlob } from '@rei-standard/blob-store';
import { openSpaceDB } from './db';

export async function storeSharedBlob(id: string, blob: Blob): Promise<void> {
    const hash = await hashBlob(blob), canonical = `pool_${hash.replace(/[^a-zA-Z0-9_]/g, '')}`;
    const db = await openSpaceDB('default');
    const old = await readSharedBlob(id);
    if (old && await hashBlob(old) !== hash) {
        throw new Error('素材编号已对应另一份文件，请保存为新素材，不能覆盖共享文件');
    }
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('blob_assets', 'readwrite'), table = tx.objectStore('blob_assets');
        // The file is immutable and content-addressed. Legacy IDs become small aliases.
        const req = table.get(canonical);
        req.onsuccess = () => {
            // Recheck the alias in this write transaction: concurrent writers may
            // both have observed an absent ID before either one committed.
            const alias = table.get(id);
            alias.onsuccess = () => {
                if (alias.result?.sharedBlobId && alias.result.sharedBlobId !== canonical) { tx.abort(); return; }
                if (!req.result) table.put({ id: canonical, blob, preferredId: id });
                if (id !== canonical) table.put({ id, sharedBlobId: canonical, type: blob.type });
            };
        };
        tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error || new Error('共享素材编号冲突，文件未覆盖'));
    });
}

export async function removeSharedBlob(id: string): Promise<void> {
    const db = await openSpaceDB('default');
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('blob_assets', 'readwrite'), table = tx.objectStore('blob_assets'), req = table.get(id);
        req.onsuccess = () => {
            const canonical = req.result?.sharedBlobId;
            table.delete(id);
            if (!canonical) return;
            let referenced = false;
            const cursor = table.openCursor();
            cursor.onsuccess = () => {
                const row = cursor.result;
                if (row) { if (row.value?.sharedBlobId === canonical) referenced = true; row.continue(); }
                else if (!referenced) table.delete(canonical);
            };
        };
        tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
    });
}
export async function readSharedBlob(id: string): Promise<Blob | null> {
    const db = await openSpaceDB('default');
    return new Promise((resolve, reject) => {
        const tx = db.transaction('blob_assets'), table = tx.objectStore('blob_assets');
        const req = table.get(id);
        req.onsuccess = () => {
            if (req.result?.sharedBlobId) {
                const shared = table.get(req.result.sharedBlobId);
                shared.onsuccess = () => {
                    const blob = shared.result?.blob as Blob | undefined;
                    resolve(blob && typeof req.result.type === 'string' && blob.type !== req.result.type ? blob.slice(0, blob.size, req.result.type) : blob || null);
                }; shared.onerror = () => reject(shared.error);
            } else resolve(req.result?.blob || null);
        };
        req.onerror = () => reject(req.error);
    });
}
