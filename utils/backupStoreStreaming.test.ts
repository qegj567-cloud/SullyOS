import { expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { DB, openDB } from './db';
import { createBackupArchive } from './backupArchive';
import { streamBackupArrayStore } from './backupStoreStreaming';
import { collectBlobRefs } from './backupBlobs';
import { assembleV2Backup, writeV2Backup } from './backupFormat';

it('全备份逐条读连接并收敛精度，跨片零丢失，旧导入器可直接还原', async () => {
    const db = await openDB();
    const count = 1203;
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('memory_links', 'readwrite');
        const store = tx.objectStore('memory_links');
        store.clear();
        for (let i = 0; i < count; i++) store.put({ id: `edge_${String(i).padStart(4, '0')}`, sourceId: 'a', targetId: `b${i}`, type: 'emotional', strength: 0.2789476291284245, extra: i });
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    // A regression to getAll is observable, not inferred from implementation text.
    const forbidden = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(() => { throw new Error('whole-store allocation'); });
    const zip = createBackupArchive();
    let result;
    try { result = await streamBackupArrayStore(zip, 'memory_links', 'memoryLinks'); }
    finally { forbidden.mockRestore(); }
    expect(result.count).toBe(count);
    expect(result.parts).toBeGreaterThan(1);
    await writeV2Backup(zip, { characters: [] }, { mode: 'full', prewrittenStores: { memoryLinks: result } });
    const loaded = await JSZip.loadAsync(await (await zip.generateBlob()).arrayBuffer(), { checkCRC32: true });
    const manifest = JSON.parse(await loaded.file('manifest.json')!.async('string'));
    const restored: any = await assembleV2Backup(loaded as any, manifest);
    expect(restored.memoryLinks).toHaveLength(count);
    expect(restored.memoryLinks[1202]).toEqual({ id: 'edge_1202', sourceId: 'a', targetId: 'b1202', type: 'emotional', strength: 0.27895, extra: 1202 });
    expect((await DB.getRawStoreData('memory_links'))[0].strength).toBe(0.2789476291284245);
    await DB.importFullData(restored);
    expect(await DB.getRawStoreData('memory_links')).toHaveLength(count);
});

it('逐条转换之后的序列化仍收集图片令牌，跳过记录不计入 manifest', async () => {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('gallery', 'readwrite');
        const store = tx.objectStore('gallery'); store.clear();
        store.put({ id: 'g1', url: 'blobref:kept_picture' });
        store.put({ id: 'g2', url: 'blobref:skipped_picture' });
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    const zip = createBackupArchive();
    const tokens = new Set<string>();
    const result = await streamBackupArrayStore(zip, 'gallery', 'galleryImages', {
        transform: item => item.id === 'g1' ? item : undefined,
        onSerialized: json => collectBlobRefs(json, tokens),
    });
    expect(result.count).toBe(1);
    expect([...tokens]).toEqual(['blobref:kept_picture']);
});

it('转换失败直接拒绝整次备份，不把半张表伪装为完成', async () => {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('gallery', 'readwrite');
        tx.objectStore('gallery').put({ id: 'failing-record', url: 'blobref:test_failure' });
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    const zip = createBackupArchive();
    await expect(streamBackupArrayStore(zip, 'gallery', 'galleryImages', {
        transform: () => { throw new Error('test transformation failure'); },
    })).rejects.toThrow('test transformation failure');
});
