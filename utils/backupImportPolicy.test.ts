import { describe, expect, it } from 'vitest';
import {
    assertSupportedSullyBackup, createImportProgressMarker, IMPORT_IN_PROGRESS_KEY,
    RESTORE_DAMAGED_ASSETS_KEY, saveRestoreDamagedAssets, readRestoreDamagedAssets, clearRestoreDamagedAssets,
} from './backupImportPolicy';
import { isSharedSpaceKey } from './userSpaces';

describe('backup import policy', () => {
    it('accepts SullyOS v1-style backup objects', () => {
        expect(() => assertSupportedSullyBackup({
            timestamp: Date.now(),
            version: 1,
            characters: [],
            messages: [],
        })).not.toThrow();
    });

    it.each([
        { vectorMemories: [] },
        { extraLocalStorageConfig: {} },
    ])('rejects unsupported third-party backup markers before import', marker => {
        expect(() => assertSupportedSullyBackup({
            timestamp: Date.now(),
            version: 1,
            characters: [],
            ...marker,
        })).toThrow('不支持导入第三方系统备份');
    });

    it('rejects non-object payloads', () => {
        expect(() => assertSupportedSullyBackup([])).toThrow('备份内容无效');
    });
});

describe('import-in-progress marker', () => {
    const storage = () => {
        const items = new Map<string, string>();
        return { items, setItem: (k: string, v: string) => { items.set(k, v); }, removeItem: (k: string) => { items.delete(k); } };
    };

    it('stays absent while the backup is only being read and validated, even when that fails', () => {
        const store = storage();
        const marker = createImportProgressMarker('backup.zip', store);
        marker.update('parsing', { current: '解析备份文件' });
        marker.update('error', { error: '损坏的备份包' });
        expect(store.items.has(IMPORT_IN_PROGRESS_KEY)).toBe(false);
    });

    it('keeps an earlier interrupted import marker when a new import fails before writing', () => {
        const store = storage();
        store.items.set(IMPORT_IN_PROGRESS_KEY, '{"phase":"database"}');
        createImportProgressMarker('other.zip', store).update('error', { error: 'x' });
        expect(store.items.get(IMPORT_IN_PROGRESS_KEY)).toBe('{"phase":"database"}');
    });

    it('is on disk the moment writing begins, before any progress update', () => {
        const store = storage();
        const marker = createImportProgressMarker('backup.zip', store);
        marker.beginWrite();
        const written = JSON.parse(store.items.get(IMPORT_IN_PROGRESS_KEY)!);
        expect(written).toMatchObject({ phase: 'database', source: 'backup.zip' });
        // 再调一次不重置开始时间，也不盖掉后面的进度。
        marker.update('assets', { current: '图片二进制 1/3' });
        marker.beginWrite();
        expect(JSON.parse(store.items.get(IMPORT_IN_PROGRESS_KEY)!)).toMatchObject({ phase: 'assets', startedAt: written.startedAt, current: '图片二进制 1/3' });
    });

    it('records progress and failures once writing has begun, and clears on success', () => {
        const store = storage();
        const marker = createImportProgressMarker('backup.zip', store);
        marker.beginWrite();
        marker.update('database', { current: '聊天记录' });
        const written = JSON.parse(store.items.get(IMPORT_IN_PROGRESS_KEY)!);
        expect(written).toMatchObject({ phase: 'database', source: 'backup.zip', current: '聊天记录' });
        marker.update('error', { error: '写入失败' });
        expect(JSON.parse(store.items.get(IMPORT_IN_PROGRESS_KEY)!)).toMatchObject({ phase: 'error', startedAt: written.startedAt, error: '写入失败' });
        marker.clear();
        expect(store.items.has(IMPORT_IN_PROGRESS_KEY)).toBe(false);
    });

    it('stays cleared when the failure is reported after a clean rollback', () => {
        const store = storage();
        const marker = createImportProgressMarker('backup.zip', store);
        marker.beginWrite();
        marker.update('database');
        marker.clear();
        marker.update('error', { error: '满了' });
        expect(store.items.has(IMPORT_IN_PROGRESS_KEY)).toBe(false);
    });
});

describe('damaged assets noted for the next start', () => {
    const storage = () => {
        const items = new Map<string, string>();
        return { items, getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v); }, removeItem: (k: string) => { items.delete(k); } };
    };
    const damaged = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `img_${i}`, locations: [], reason: 'damaged' as const }));

    it('round-trips the list once, and nothing is stored when nothing was skipped', () => {
        const store = storage();
        saveRestoreDamagedAssets([], store);
        expect(store.items.size).toBe(0);
        expect(readRestoreDamagedAssets(store)).toBeNull();
        saveRestoreDamagedAssets(damaged(2), store);
        expect(readRestoreDamagedAssets(store)).toEqual({ total: 2, items: damaged(2) });
        clearRestoreDamagedAssets(store);
        expect(readRestoreDamagedAssets(store)).toBeNull();
    });

    it('keeps the real count but only the first 200 entries', () => {
        const store = storage();
        saveRestoreDamagedAssets(damaged(1500), store);
        const read = readRestoreDamagedAssets(store)!;
        expect(read.total).toBe(1500);
        expect(read.items).toHaveLength(200);
    });

    it('ignores unreadable content and a full storage instead of throwing', () => {
        const store = storage();
        store.items.set(RESTORE_DAMAGED_ASSETS_KEY, '{not json');
        expect(readRestoreDamagedAssets(store)).toBeNull();
        expect(() => saveRestoreDamagedAssets(damaged(1), { setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } })).not.toThrow();
    });

    it('is shared by every user space, so it is still readable after migrating in as a new user', () => {
        expect(isSharedSpaceKey(RESTORE_DAMAGED_ASSETS_KEY)).toBe(true);
        // 「导入中」标记是按空间存的：中断时还没切换空间，重启后仍在原空间里。
        expect(isSharedSpaceKey(IMPORT_IN_PROGRESS_KEY)).toBe(false);
    });
});
