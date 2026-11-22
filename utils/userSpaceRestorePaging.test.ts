/**
 * 多空间备份逐页恢复（docs/backup-pipeline.md「恢复：逐页写库」）的回归守卫：
 * 写库时内存里最多一页、所有检查都在第一次写库之前、清表不丢本机专属行、迁入时编号映射先于写入建好、
 * iOS 挂起页面中止的事务回到前台后重写。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { DB, openSpaceDB } from './db';
import { saveUserSpaces, listUserSpaces } from './userSpaces';
import { commitSpaceRows, readSpaceStore } from './userSpaceData';
import * as spaceData from './userSpaceData';
import { exportUserSpaces, importUserSpaces, lastUserSpaceRestore, type UserSpaceRestoreProgress } from './userSpaceBackup';
import { putSharedImage } from './spaceAssets';

const messages = (count: number, content = '备份里的话') => Array.from({ length: count }, (_, i) => ({ id: i + 1, charId: 'c', role: 'user', type: 'text', content: `${content} ${i}` }));
const exportCurrent = async () => JSZip.loadAsync(await (await exportUserSpaces('full', 'current')).arrayBuffer());
const manifestOf = async (zip: JSZip) => JSON.parse(await zip.file('user-spaces.json')!.async('string'));
const memoryStorage = () => {
    const map = new Map<string, string>();
    return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, String(v)); }, removeItem: (k: string) => { map.delete(k); }, clear: () => map.clear() };
};

beforeEach(async () => {
    localStorage.clear();
    vi.stubGlobal('sessionStorage', memoryStorage());
    saveUserSpaces([{ id: 'default', name: '甲' }]);
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, Object.fromEntries(Array.from(db.objectStoreNames).filter(n => n !== 'blob_assets').map(n => [n, []])), true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('loads each records page right before writing it and never holds more than one page', async () => {
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, { characters: [{ id: 'c', name: '小明', memories: [] }], messages: messages(2500) });
    const zip = await exportCurrent();
    expect((await manifestOf(zip)).spaces[0].stores.messages).toHaveLength(3);
    await commitSpaceRows(db, { messages: [] }, true);

    // 写库阶段：读一页 → 页数 +1；装着这页记录的事务提交 → 这页释放。
    let writing = false, held = 0, maxHeld = 0, loads = 0;
    const tracked = { file: (name: string) => {
        const entry = zip.file(name);
        if (!entry || !name.includes('/messages.')) return entry;
        return { async: async (type: any) => {
            const value = await entry.async(type);
            if (writing) { loads++; held++; maxHeld = Math.max(maxHeld, held); }
            return value;
        } };
    } };
    const putsPerTransaction = new Map<IDBTransaction, number>();
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: any[]) {
        if (writing && this.name === 'messages') {
            const tx = this.transaction;
            if (!putsPerTransaction.has(tx)) tx.addEventListener('complete', () => { held = 0; });
            putsPerTransaction.set(tx, (putsPerTransaction.get(tx) ?? 0) + 1);
        }
        return put.apply(this, args as [any, IDBValidKey?]);
    });

    await importUserSpaces(tracked, false, { onBeforeWrite: () => { writing = true; } });
    expect(loads).toBe(3);
    expect(maxHeld).toBe(1);
    expect([...putsPerTransaction.values()]).toEqual([1000, 1000, 500]);
    expect(await readSpaceStore(db, 'messages')).toHaveLength(2500);
});

it.each([
    ['the last records page', (zip: JSZip, manifest: any) => zip.remove(manifest.spaces[0].stores.messages.at(-1)), '分片缺失'],
    ['a vector file', (zip: JSZip, manifest: any) => zip.remove(Object.keys(zip.files).find(p => p.startsWith('shared/') && !manifest.blobs.some((b: any) => b.path === p))!), '二进制文件缺失'],
    ['a shared picture in the index', (zip: JSZip, manifest: any) => zip.remove(manifest.blobs[0].path), '共享素材索引无效'],
] as const)('rejects a backup missing %s before any write, leaving the database unchanged', async (_name, defect, message) => {
    const db = await openSpaceDB('default');
    const avatar = await putSharedImage(new Blob(['avatar-bytes'], { type: 'image/png' }));
    await commitSpaceRows(db, {
        characters: [{ id: 'c', name: '小明', avatar, memories: [] }], messages: messages(2500),
        memory_vectors: [{ memoryId: 'm', charId: 'c', vector: new Float32Array([0.25, 0.5]) }],
    });
    const zip = await exportCurrent();
    defect(zip, await manifestOf(zip));
    await commitSpaceRows(db, { characters: [{ id: 'c', name: 'live', memories: [] }], messages: messages(1, '本机的话'), memory_vectors: [] }, true);

    const onBeforeWrite = vi.fn();
    await expect(importUserSpaces(zip, false, { onBeforeWrite })).rejects.toThrow(message);
    expect(onBeforeWrite).not.toHaveBeenCalled();
    expect(await readSpaceStore(db, 'characters')).toEqual([{ id: 'c', name: 'live', memories: [] }]);
    expect((await readSpaceStore(db, 'messages')).map(row => row.content)).toEqual(['本机的话 0']);
    expect(await readSpaceStore(db, 'memory_vectors')).toEqual([]);
});

it('surfaces a picture ID conflict before any table or picture is written', async () => {
    const db = await openSpaceDB('default');
    const fresh = await putSharedImage(new Blob(['fresh-bytes'], { type: 'image/png' }));
    await DB.putBlobAsset('img_conflict', new Blob(['backup-bytes'], { type: 'image/png' }));
    await commitSpaceRows(db, { characters: [{ id: 'c', name: '小明', avatar: fresh, chatBackground: 'blobref:img_conflict', memories: [] }], messages: messages(150) });
    const zip = await exportCurrent();
    expect((await manifestOf(zip)).blobs.map((b: any) => b.id)).toEqual([fresh.slice(8), 'img_conflict']);
    await commitSpaceRows(db, { characters: [{ id: 'c', name: 'live', memories: [] }], messages: [] }, true);
    await DB.deleteBlobAsset(fresh.slice(8)); await DB.deleteBlobAsset('img_conflict');
    await DB.putBlobAsset('img_conflict', new Blob(['device-bytes'], { type: 'image/png' }));

    const onBeforeWrite = vi.fn();
    await expect(importUserSpaces(zip, false, { onBeforeWrite })).rejects.toThrow('素材编号冲突');
    expect(onBeforeWrite).not.toHaveBeenCalled();
    expect(await readSpaceStore(db, 'characters')).toEqual([{ id: 'c', name: 'live', memories: [] }]);
    expect(await readSpaceStore(db, 'messages')).toEqual([]);
    expect(await DB.getBlobAsset(fresh.slice(8))).toBeNull();
    expect(await (await DB.getBlobAsset('img_conflict'))!.text()).toBe('device-bytes');
});

it('keeps the device-only asset rows through an interrupted restore and a completed one', async () => {
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, { characters: [{ id: 'c', name: '小明', memories: [] }], assets: [{ id: 'note', data: 'backup' }] });
    const zip = await exportCurrent();
    const mirror = { id: 'ls_mirror_v1', data: { savedAt: 1, data: { os_theme: 'device' } } };
    const catalog = { id: 'user_spaces_catalog_v1', data: JSON.stringify(listUserSpaces()) };
    const deviceRows = async () => (await readSpaceStore(db, 'assets')).filter(row => row.id !== 'note');
    const reset = () => commitSpaceRows(db, { assets: [mirror, catalog, { id: 'note', data: 'live' }] }, true);

    // 清表之后写页失败。
    await reset();
    const original = spaceData.commitSpaceRows;
    const failPage = vi.spyOn(spaceData, 'commitSpaceRows').mockImplementation(async (target, tables, replace) => {
        if (tables.assets) throw new DOMException('满了', 'QuotaExceededError');
        return original(target, tables, replace);
    });
    await expect(importUserSpaces(zip)).rejects.toThrow('满了');
    expect(await deviceRows()).toEqual([mirror, catalog]);
    failPage.mockRestore();

    // 所有表写完之后失败。
    await reset();
    vi.spyOn(spaceData, 'persistSpaceCatalog').mockRejectedValueOnce(new Error('中断'));
    await expect(importUserSpaces(zip)).rejects.toThrow('中断');
    expect(await deviceRows()).toEqual([mirror, catalog]);

    // 正常完成。
    await reset();
    await importUserSpaces(zip);
    expect(await readSpaceStore(db, 'assets')).toEqual([mirror, { id: 'note', data: 'backup' }, catalog]);
});

async function migrationArchive() {
    const zip = new JSZip();
    // 表的顺序和分页故意打乱：链接和聊天排在角色、记忆前面，角色和记忆各分两页。
    const pages: Array<[string, any[][]]> = [
        ['memory_links', [[{ id: 'link', sourceId: 'm2', targetId: 'm1', strength: 1 }]]],
        ['messages', [[{ id: 1, charId: 'b', type: 'text', content: '第二页的角色说的话' }]]],
        ['characters', [[{ id: 'a', name: '小明' }], [{ id: 'b', name: '小红' }]]],
        ['memory_nodes', [[{ id: 'm1', charId: 'a', content: '记忆一' }], [{ id: 'm2', charId: 'b', content: '记忆二' }]]],
        ['memory_vectors', [[{ memoryId: 'm2', charId: 'b', vector: [0.5] }]]],
    ];
    const stores: Record<string, string[]> = {};
    for (const [store, rows] of pages) stores[store] = rows.map((page, i) => {
        const path = `spaces/default/${store}.${i}.json`; zip.file(path, JSON.stringify(page)); return path;
    });
    zip.file('user-spaces.json', JSON.stringify({ format: 'sully-user-spaces', version: 1, mode: 'full',
        spaces: [{ id: 'default', name: '来源用户', stores, local: {} }], settings: {}, blobs: [] }));
    return zip;
}

it('maps every old ID before the first page is written when migrating as a new user', async () => {
    const [space] = await importUserSpaces(await migrationArchive(), false, { asNewUsers: true });
    const db = await openSpaceDB(space.id);
    const chars = Object.fromEntries((await readSpaceStore(db, 'characters')).map(c => [c.name, c.id]));
    const nodes = Object.fromEntries((await readSpaceStore(db, 'memory_nodes')).map(n => [n.content, n]));
    expect(Object.values(chars)).not.toContain('a'); expect(Object.values(chars)).not.toContain('b');
    expect(nodes['记忆一']).toMatchObject({ charId: chars['小明'] });
    expect(nodes['记忆二']).toMatchObject({ charId: chars['小红'] });
    expect(nodes['记忆一'].id).not.toBe('m1');
    expect((await readSpaceStore(db, 'memory_links'))[0]).toMatchObject({ sourceId: nodes['记忆二'].id, targetId: nodes['记忆一'].id });
    expect((await readSpaceStore(db, 'messages'))[0].charId).toBe(chars['小红']);
    expect((await readSpaceStore(db, 'memory_vectors'))[0]).toMatchObject({ memoryId: nodes['记忆二'].id, charId: chars['小红'] });
});

it('removes the new user when migration fails after some pages were written', async () => {
    const databases = new Set((await indexedDB.databases()).map(db => db.name));
    let written = 0;
    const original = spaceData.commitSpaceRows;
    vi.spyOn(spaceData, 'commitSpaceRows').mockImplementation(async (target, tables, replace) => {
        if (target.name.startsWith('AetherOS_Data__u_') && tables.memory_nodes && ++written === 2) throw new DOMException('满了', 'QuotaExceededError');
        return original(target, tables, replace);
    });
    const onBeforeWrite = vi.fn(), onRolledBack = vi.fn();
    await expect(importUserSpaces(await migrationArchive(), false, { asNewUsers: true, onBeforeWrite, onRolledBack })).rejects.toThrow('满了');
    expect(onBeforeWrite).toHaveBeenCalledOnce();
    expect(onRolledBack).toHaveBeenCalledOnce();
    expect(listUserSpaces()).toEqual([{ id: 'default', name: '甲' }]);
    expect((await indexedDB.databases()).filter(db => !databases.has(db.name))).toEqual([]);
});

it.each([
    ['after the page was suspended in the background', true],
    ['not when the page stayed in the foreground', false],
] as const)('rewrites a page whose transaction was aborted without a reason %s', async (_name, suspended) => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
    const setVisibility = (state: DocumentVisibilityState) => { doc.visibilityState = state; doc.dispatchEvent(new Event('visibilitychange')); };
    vi.stubGlobal('document', doc);
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, { characters: [{ id: 'c', name: '小明', memories: [] }], messages: messages(1500) });
    const zip = await exportCurrent();
    await commitSpaceRows(db, { messages: [] }, true);

    // 和 iOS 上一样：事务被中止，transaction.error 为空。
    let aborted = false, attempts = 0;
    const seen = new Set<IDBTransaction>();
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: any[]) {
        const request = put.apply(this, args as [any, IDBValidKey?]);
        if (this.name === 'messages' && !seen.has(this.transaction)) {
            seen.add(this.transaction); attempts++;
            if (!aborted) {
                aborted = true;
                const tx = this.transaction;
                request.addEventListener('success', () => {
                    if (suspended) { setVisibility('hidden'); setTimeout(() => setVisibility('visible'), 20); }
                    tx.abort();
                });
            }
        }
        return request;
    });

    if (suspended) {
        await importUserSpaces(zip);
        expect(attempts).toBe(3); // 第一页重写一次，加上第二页
        expect(lastUserSpaceRestore()?.retries).toBe(1);
        expect(await readSpaceStore(db, 'messages')).toHaveLength(1500);
    } else {
        await expect(importUserSpaces(zip)).rejects.toThrow('用户空间保存失败');
        expect(attempts).toBe(1);
    }
});

it('reports check, pictures, clearing and writing in that order, with page counts and a ratio that never goes back', async () => {
    const db = await openSpaceDB('default');
    // 前面的用例留下过同样字节的图，这里换一份，删掉后本机就真没有了，恢复时会写这张图。
    const avatar = await putSharedImage(new Blob(['progress-avatar-bytes'], { type: 'image/png' }));
    await commitSpaceRows(db, { characters: [{ id: 'c', name: '小明', avatar, memories: [] }], messages: messages(2500) });
    const zip = await exportCurrent();
    await commitSpaceRows(db, { characters: [], messages: [] }, true); // 还有行引用时图删不掉
    await DB.deleteBlobAsset(avatar.slice(8));
    expect(await DB.getBlobAsset(avatar.slice(8))).toBeNull();

    const seen: UserSpaceRestoreProgress[] = [];
    await importUserSpaces(zip, false, { onProgress: progress => seen.push(progress) });
    const stages = seen.map(p => p.stage).filter((stage, i, all) => stage !== all[i - 1]);
    expect(stages.slice(0, 5)).toEqual(['正在检查', '正在核对图片', '正在写入图片', '正在清空', '正在写入']);
    expect(stages.at(-1)).toBe('正在收尾');
    const texts = seen.map(p => p.text);
    expect(texts).toContain('正在检查 甲 · messages（第 2 / 3 页）');
    expect(texts).toContain('正在核对图片（1 / 1）');
    expect(texts).toContain('正在写入图片（1 / 1）');
    const messageWrites = texts.filter(text => text.startsWith('正在写入 甲 · messages'));
    expect(messageWrites).toEqual([1, 2, 3].map(n => `正在写入 甲 · messages（第 ${n} / 3 页）`));
    expect(texts.indexOf('正在清空 甲 · messages')).toBeLessThan(texts.indexOf(messageWrites[0]));
    const ratios = seen.map(p => p.ratio);
    expect(ratios.every((ratio, i) => ratio >= (ratios[i - 1] ?? 0) && ratio <= 1)).toBe(true);
    expect(ratios.at(-1)).toBeGreaterThan(0.9);});

it('leaves a timing summary in sessionStorage after a restore, and marks a failed one with its error', async () => {
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, { characters: [{ id: 'c', name: '小明', memories: [] }], messages: messages(2500) });
    const zip = await exportCurrent();
    // 每次取时间前进 10ms：三页的 messages 稳超 50ms 门槛，一页的小表落在门槛下被滤掉。
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock += 10);

    await importUserSpaces(zip);
    const summary = lastUserSpaceRestore()!;
    expect(summary).toMatchObject({ ok: true, retries: 0 });
    expect(summary.error).toBeUndefined();
    expect(summary.totalMs).toBeGreaterThan(summary.checkMs);
    expect(summary.tables.find(t => t.store === 'messages')).toMatchObject({ space: '甲', pages: 3, rows: 2500 });
    expect(summary.tables.find(t => t.store === 'characters')).toBeUndefined();

    const original = spaceData.commitSpaceRows;
    vi.spyOn(spaceData, 'commitSpaceRows').mockImplementation(async (target, tables, replace) => {
        if (tables.messages) throw new DOMException('满了', 'QuotaExceededError');
        return original(target, tables, replace);
    });
    await expect(importUserSpaces(zip)).rejects.toThrow('满了');
    expect(lastUserSpaceRestore()).toMatchObject({ ok: false, error: { name: 'QuotaExceededError', message: '满了' } });
});
