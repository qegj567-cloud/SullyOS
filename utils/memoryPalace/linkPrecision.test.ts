import { beforeEach, describe, expect, it } from 'vitest';
import { DB, openDB } from '../db';
import { MemoryLinkDB } from './db';
import { strengthenCoActivated } from './links';
import { spreadActivation } from './activation';

async function seed(rows: any[]) {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('memory_links', 'readwrite');
        for (const row of rows) tx.objectStore('memory_links').put(row);
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error);
    });
}
beforeEach(async () => {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['memory_links', 'memory_nodes'], 'readwrite');
        tx.objectStore('memory_links').clear();
        tx.objectStore('memory_nodes').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
});
const link = (id: string, strength: number) => ({ id, sourceId: 'a', targetId: id, type: 'emotional' as const, strength });

describe('连接权重收敛，不删边、不改关联', () => {
    it('旧备份导入也收敛精度，不把冗长小数重新写回库', async () => {
        await DB.importFullData({ memoryLinks: [link('b', 0.2789476291284245)] } as any);
        expect(await DB.getRawStoreData('memory_links')).toEqual([link('b', 0.27895)]);
    });
    it('单条和批量写入缩短长小数；不改调用方对象或其它字段', async () => {
        const first = { ...link('b', 0.2789476291284245), extra: '旧字段保留' };
        await MemoryLinkDB.save(first);
        await MemoryLinkDB.saveMany([link('c', 0.30000000000000004), link('d', 1)]);
        const rows = await DB.getRawStoreData('memory_links');
        expect(rows).toEqual([{ ...first, strength: 0.27895 }, link('c', 0.3), link('d', 1)]);
        expect(first.strength).toBe(0.2789476291284245);
    });

    it('旧库跨批整理幂等，完整保留每条边及扩展字段', async () => {
        const rows = Array.from({ length: 1203 }, (_, i) => ({ ...link(`l${String(i).padStart(4, '0')}`, 0.2789476291284245), note: i }));
        await seed(rows);
        expect(await MemoryLinkDB.compactStrengths()).toBe(1203);
        expect(await DB.getRawStoreData('memory_links')).toEqual(rows.map(row => ({ ...row, strength: 0.27895 })));
        expect(await MemoryLinkDB.compactStrengths()).toBe(0);
    });

    it('共同激活的 +0.05 不积累长尾小数，也不丢连接', async () => {
        await MemoryLinkDB.save(link('b', 0.2789476291284245));
        for (let i = 0; i < 10; i++) await strengthenCoActivated(['a', 'b']);
        expect(await DB.getRawStoreData('memory_links')).toEqual([link('b', 0.77895)]);
    });

    it('精度整理前后，具有明确分差的实际联想 top3 保持一致', async () => {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('memory_nodes', 'readwrite');
            for (const id of ['b', 'c', 'd', 'e']) tx.objectStore('memory_nodes').put({ id, charId: 'c', content: id });
            tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
        });
        await seed([link('b', 0.2789476291284245), link('c', 0.5123456789), link('d', 0.4567891234), link('e', 0.2000012345)]);
        const seeds: any[] = [{ node: { id: 'a', charId: 'c' }, finalScore: 0.8 }];
        const before = await spreadActivation(seeds, 'c');
        await MemoryLinkDB.compactStrengths();
        const after = await spreadActivation(seeds, 'c');
        expect(after.map(row => row.node.id)).toEqual(['a', 'c', 'd', 'b']);
        after.forEach((row, i) => expect(Math.abs(row.finalScore - before[i].finalScore)).toBeLessThanOrEqual(0.0000015));
    });
});
