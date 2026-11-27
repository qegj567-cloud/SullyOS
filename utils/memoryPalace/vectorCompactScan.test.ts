import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDB } from '../db';
import { createSpaceStorage, saveUserSpaces } from '../userSpaces';
import { MemoryVectorDB, VECTOR_COMPACT_SCAN_KEY, invalidateVectorCompactScan } from './db';
import { privateLocalExcluded } from '../userSpaceBackup';

const DAY = 24 * 60 * 60 * 1000;
const realStorage = globalThis.localStorage;

const withStore = async <T,>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('memory_vectors', mode);
        const request = run(tx.objectStore('memory_vectors'));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
    });
};
const putLegacy = (memoryId: string) =>
    withStore('readwrite', store => store.put({ memoryId, charId: 'c1', vector: [0.1, 0.2, 0.3, 0.4], dimensions: 4, model: 'm' }));
const isLegacy = async (memoryId: string) => Array.isArray((await withStore<any>('readonly', store => store.get(memoryId))).vector);

afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as any).localStorage = realStorage;
    realStorage.clear();
});

describe('开机向量扫描：扫完一轮后不重复扫', () => {
    it('完整扫完后再次调用直接跳过；手动入口照常整表扫', async () => {
        await putLegacy('a');
        expect(await MemoryVectorDB.scanAndMigrateLegacyIfNeeded()).toBe(1);
        expect(await isLegacy('a')).toBe(false);

        await putLegacy('b');
        const scan = vi.spyOn(MemoryVectorDB, 'scanAndMigrateLegacy');
        expect(await MemoryVectorDB.scanAndMigrateLegacyIfNeeded()).toBe(0);
        expect(scan).not.toHaveBeenCalled();
        expect(await isLegacy('b')).toBe(true);
        scan.mockRestore();

        expect(await MemoryVectorDB.scanAndMigrateLegacy()).toBe(1);
        expect(await isLegacy('b')).toBe(false);
    });

    it('扫描失败不留记录，下次照常再扫', async () => {
        vi.spyOn(MemoryVectorDB, 'scanAndMigrateLegacy').mockRejectedValueOnce(new Error('磁盘满了'));
        await expect(MemoryVectorDB.scanAndMigrateLegacyIfNeeded()).rejects.toThrow('磁盘满了');
        expect(localStorage.getItem(VECTOR_COMPACT_SCAN_KEY)).toBeNull();

        await putLegacy('c');
        expect(await MemoryVectorDB.scanAndMigrateLegacyIfNeeded()).toBe(1);
    });

    it('一个用户空间扫完，别的空间不跳过', async () => {
        await MemoryVectorDB.scanAndMigrateLegacyIfNeeded();
        expect(realStorage.getItem(VECTOR_COMPACT_SCAN_KEY)).not.toBeNull();

        // 换成另一个空间的 localStorage 视图，相当于在那个空间里开机
        (globalThis as any).localStorage = createSpaceStorage(realStorage, 'u_other');
        const scan = vi.spyOn(MemoryVectorDB, 'scanAndMigrateLegacy');
        await MemoryVectorDB.scanAndMigrateLegacyIfNeeded();
        expect(scan).toHaveBeenCalledTimes(1);
        await MemoryVectorDB.scanAndMigrateLegacyIfNeeded();
        expect(scan).toHaveBeenCalledTimes(1);
    });

    it('恢复备份让所有空间的记录作废', async () => {
        saveUserSpaces([{ id: 'default', name: '默认用户' }, { id: 'u_other', name: '小明' }]);
        const other = createSpaceStorage(realStorage, 'u_other');
        await MemoryVectorDB.scanAndMigrateLegacyIfNeeded();
        other.setItem(VECTOR_COMPACT_SCAN_KEY, String(Date.now()));

        invalidateVectorCompactScan();

        expect(localStorage.getItem(VECTOR_COMPACT_SCAN_KEY)).toBeNull();
        expect(other.getItem(VECTOR_COMPACT_SCAN_KEY)).toBeNull();
        await putLegacy('d');
        expect(await MemoryVectorDB.scanAndMigrateLegacyIfNeeded()).toBe(1);
    });

    it('扫描途中开始恢复，这一轮不留记录', async () => {
        vi.spyOn(MemoryVectorDB, 'scanAndMigrateLegacy').mockImplementationOnce(async () => {
            invalidateVectorCompactScan();
            return 0;
        });
        await MemoryVectorDB.scanAndMigrateLegacyIfNeeded();
        expect(localStorage.getItem(VECTOR_COMPACT_SCAN_KEY)).toBeNull();
    });

    it.each([
        ['超过 7 天', () => Date.now() - 8 * DAY],
        ['时间戳在未来', () => Date.now() + DAY],
        ['内容不是时间戳', () => 'done'],
    ])('记录%s时重新扫', async (_label, value) => {
        localStorage.setItem(VECTOR_COMPACT_SCAN_KEY, String(value()));
        await putLegacy('e');
        expect(await MemoryVectorDB.scanAndMigrateLegacyIfNeeded()).toBe(1);
    });

    it('这条记录不进备份导出', () => {
        expect(privateLocalExcluded(VECTOR_COMPACT_SCAN_KEY)).toBe(true);
    });
});
