/**
 * 多空间导出按页读、读一页写一页（docs/backup-pipeline.md「写入：顺序写进临时文件」）的回归守卫：
 * 内存里最多一页、按字节封页、往返一致、记忆关联强度截断、出错收场、上一次的临时文件在下一次导出开始时释放。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

// 假临时文件：落盘时复制一份；记下每个文件是否被删、新建时之前的文件删了没有。
const temp = vi.hoisted(() => ({
    supported: false,
    files: [] as Array<{ chunks: Uint8Array[]; closed: boolean; removed: boolean; earlierRemovedAtCreate: boolean[] }>,
}));
vi.mock('./backupTempFile', async importOriginal => ({
    ...await importOriginal<typeof import('./backupTempFile')>(),
    isBackupTempFileSupported: async () => temp.supported,
    checkBackupSpace: async () => null,
    createBackupTempFile: async () => {
        const state = { chunks: [] as Uint8Array[], closed: false, removed: false, earlierRemovedAtCreate: temp.files.map(file => file.removed) };
        temp.files.push(state);
        return {
            name: 'export-test.tmp',
            async openWritable() {
                return new WritableStream<Uint8Array>({
                    write(chunk) { state.chunks.push(chunk.slice()); },
                    close() { state.closed = true; },
                });
            },
            async getFile() { return new File(state.chunks as BlobPart[], 'export-test.tmp'); },
            async remove() { state.removed = true; },
        };
    },
}));

// 包一层真写入器：每项写完隔一拍（模拟慢磁盘），可以让某一项报错，记下写完的条目和 abort 次数。
const writer = vi.hoisted(() => ({
    added: [] as string[],
    aborts: 0,
    failOn: undefined as ((name: string) => Error | undefined) | undefined,
    onAdded: undefined as ((name: string) => void) | undefined,
    /** 返回一个 Promise 时，这一项卡在它上面，用来模拟导出途中页面消失、走不到收尾 */
    holdOn: undefined as ((name: string) => Promise<void> | undefined) | undefined,
}));
vi.mock('./backupArchiveWriter', async importOriginal => {
    const real = await importOriginal<typeof import('./backupArchiveWriter')>();
    return {
        ...real,
        openBackupArchiveWriter: async (options?: Parameters<typeof real.openBackupArchiveWriter>[0]) => {
            const inner = await real.openBackupArchiveWriter(options);
            return {
                onDisk: inner.onDisk,
                async add(name: string, data: any, entryOptions?: any) {
                    const error = writer.failOn?.(name);
                    if (error) throw error;
                    await writer.holdOn?.(name);
                    await new Promise(resolve => setTimeout(resolve, 0));
                    await inner.add(name, data, entryOptions);
                    writer.added.push(name);
                    writer.onAdded?.(name);
                },
                close: () => inner.close(),
                async abort() { writer.aborts++; await inner.abort(); },
            };
        },
    };
});

import { openSpaceDB } from './db';
import { saveUserSpaces, writeSpaceLocal } from './userSpaces';
import { commitSpaceRows, readSpaceStore } from './userSpaceData';
import { exportUserSpaces, importUserSpaces, lastUserSpaceExport } from './userSpaceBackup';
import { PAGE_BYTE_BUDGET } from './backupPageReader';
import { EXPORT_TRACE_KEY, type ExportTrace } from './backupExportTrace';
import { TASK_TRACE_KINDS } from './taskTraceReport';
import { canMigrateLocalKey } from './independentUserRemap';
import { CLOUD_GEN_DONE_KEY, CLOUD_GEN_JOBS_KEY } from './cloudGen/types';
import { RESTORE_DAMAGED_ASSETS_KEY } from './backupImportPolicy';

const messages = (count: number, content = (i: number) => `第 ${i} 句`) =>
    Array.from({ length: count }, (_, i) => ({ id: i + 1, charId: 'c', role: 'user', type: 'text', timestamp: 1_700_000_000_000 + i, content: content(i) }));
const exportCurrent = async () => JSZip.loadAsync(await (await exportUserSpaces('full', 'current')).arrayBuffer());
const manifestOf = async (zip: JSZip) => JSON.parse(await zip.file('user-spaces.json')!.async('string'));
const isMessagesPage = (name: string) => /\/messages\.\d+\.json$/.test(name);

beforeEach(async () => {
    localStorage.clear();
    saveUserSpaces([{ id: 'default', name: '小明' }]);
    temp.supported = false;
    temp.files = [];
    writer.added = [];
    writer.aborts = 0;
    writer.failOn = undefined;
    writer.onAdded = undefined;
    writer.holdOn = undefined;
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, Object.fromEntries(Array.from(db.objectStoreNames).filter(n => n !== 'blob_assets').map(n => [n, []])), true);
    await commitSpaceRows(db, { characters: [{ id: 'c', name: '小红', memories: [] }] });
});
afterEach(() => { vi.restoreAllMocks(); });

// 9500 行的夹具单独跑约 2 秒，和几十个测试文件并行时会超过默认的 5 秒。
it('holds at most one records page between reading it from the database and the writer finishing it', { timeout: 30000 }, async () => {
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, { messages: messages(9500) });
    // 读一页 = 在主库的 messages 上开一个游标（协同库也有一张 messages；开读前取总条数不算读页）；写完一页 = 写入器写完这页的条目。
    let read = 0, written = 0, maxHeld = 0;
    const openCursor = IDBObjectStore.prototype.openCursor;
    vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (this: IDBObjectStore, ...args: any[]) {
        if (this.transaction.db === db && this.name === 'messages') { read++; maxHeld = Math.max(maxHeld, read - written); }
        return (openCursor as any).apply(this, args);
    });
    writer.onAdded = name => { if (isMessagesPage(name)) written++; };

    const zip = await exportCurrent();
    expect(maxHeld).toBe(1);
    expect((await manifestOf(zip)).spaces[0].stores.messages).toHaveLength(10);
    expect(read).toBe(10);
    expect(written).toBe(10);
});

it('reports rows read out of the table total, and lists the slow table in the export summary', async () => {
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, { messages: messages(2500) });
    // 每次取时间前进 60ms，让每张表都过 50ms 门槛。
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock += 60);
    const progress: string[] = [];
    await exportUserSpaces('full', 'current', text => progress.push(text));
    expect(progress.filter(text => text.includes(' · messages'))).toEqual([
        '正在读取 小明 · messages（1000 / 2500 条）',
        '正在读取 小明 · messages（2000 / 2500 条）',
        '正在读取 小明 · messages（2500 / 2500 条）',
    ]);
    expect(lastUserSpaceExport()?.tables.find(t => t.store === 'messages')).toMatchObject({ space: '小明', pages: 3, rows: 2500 });
});

it('seals pages by bytes, and a record larger than the budget gets a page of its own', async () => {
    const db = await openSpaceDB('default');
    const MB = 1_000_000;
    await commitSpaceRows(db, { messages: messages(100, i => `${i}`.padEnd(MB, 'x')) });
    let zip = await exportCurrent();
    let paths: string[] = (await manifestOf(zip)).spaces[0].stores.messages;
    // 旧实现是 100 条一页，这里就是一页 100MB。
    expect(paths.length).toBeGreaterThanOrEqual(25);
    let total = 0;
    for (const path of paths) {
        const text = await zip.file(path)!.async('string');
        expect(text.length, path).toBeLessThan(PAGE_BYTE_BUDGET + 64 * 1024);
        total += JSON.parse(text).length;
    }
    expect(total).toBe(100);

    await commitSpaceRows(db, { messages: [
        ...messages(1),
        { ...messages(2)[1], content: 'y'.repeat(PAGE_BYTE_BUDGET + 1) },
        ...messages(3).slice(2),
    ] }, true);
    zip = await exportCurrent();
    paths = (await manifestOf(zip)).spaces[0].stores.messages;
    const pages = await Promise.all(paths.map(async path => JSON.parse(await zip.file(path)!.async('string')).map((row: any) => row.id)));
    expect(pages).toEqual([[1], [2], [3]]);
}, 120_000);

it('restores a streamed archive written to disk row for row, multi-page tables, Blobs and memory links included', async () => {
    temp.supported = true;
    const db = await openSpaceDB('default');
    const rows = {
        messages: messages(2500),
        gallery: [{ id: 'g1', charId: 'c', blob: new Blob(['picture-bytes'], { type: 'image/png' }), timestamp: 1 }],
        memory_vectors: [{ memoryId: 'm', charId: 'c', vector: new Float32Array([0.25, 0.5]) }],
        memory_links: [{ id: 'l1', sourceId: 'm1', targetId: 'm2', strength: 0.5, type: 'related' }],
    };
    await commitSpaceRows(db, rows);
    const before = await snapshot(db, Object.keys(rows));

    const archive = await exportUserSpaces('full', 'current');
    // 交回的是磁盘文件的切片（WebKit 319985 的绕法），带压缩包类型。
    expect(temp.files).toHaveLength(1);
    expect(archive).not.toBeInstanceOf(File);
    expect(archive.type).toBe('application/zip');
    expect(archive.size).toBe(temp.files[0].chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    expect((await manifestOf(zip)).spaces[0].stores.messages).toHaveLength(3);

    await commitSpaceRows(db, Object.fromEntries(Object.keys(rows).map(store => [store, []])), true);
    await importUserSpaces(zip);
    expect(await snapshot(db, Object.keys(rows))).toEqual(before);
});

it('truncates memory link strength to five decimals and keeps every other field', async () => {
    const db = await openSpaceDB('default');
    const link = { id: 'l1', sourceId: 'm1', targetId: 'm2', strength: 0.123456789, type: 'related', legacy: { note: '旧字段' } };
    await commitSpaceRows(db, { memory_links: [link] });
    const zip = await exportCurrent();
    const [path] = (await manifestOf(zip)).spaces[0].stores.memory_links;
    expect(JSON.parse(await zip.file(path)!.async('string'))).toEqual([{ ...link, strength: 0.12346 }]);
});

it.each([
    ['the writer', (_db: IDBDatabase) => {
        const error = new Error('写入器坏了');
        writer.failOn = name => (name.endsWith('/messages.1.json') ? error : undefined);
        return error;
    }],
    ['the database', (db: IDBDatabase) => {
        const error = new Error('数据库读不出来');
        let reads = 0;
        const transaction = IDBDatabase.prototype.transaction;
        vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, names: any, ...rest: any[]) {
            if (this === db && names === 'messages' && ++reads === 2) throw error;
            return (transaction as any).call(this, names, ...rest);
        });
        return error;
    }],
] as const)('a failure in %s aborts the archive, leaves no temp file and rethrows the original error', async (_name, breakIt) => {
    temp.supported = true;
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, { messages: messages(2500) });
    const error = breakIt(db);
    await expect(exportUserSpaces('full', 'current')).rejects.toBe(error);
    expect(writer.aborts).toBe(1);
    expect(temp.files).toHaveLength(1);
    expect(temp.files[0].removed).toBe(true);
});

it('releases the previous temp file when the next export starts, and keeps the latest one', async () => {
    temp.supported = true;
    const first = await exportUserSpaces('full', 'current');
    expect(temp.files.map(file => file.removed)).toEqual([false]);
    expect((await JSZip.loadAsync(await first.arrayBuffer())).file('user-spaces.json')).toBeTruthy();

    await exportUserSpaces('full', 'current');
    expect(temp.files).toHaveLength(2);
    expect(temp.files[1].earlierRemovedAtCreate).toEqual([true]);
    expect(temp.files.map(file => file.removed)).toEqual([true, false]);
});

// 按主键排序的整表内容；Blob 换成类型加字节，类型数组换成普通数组，便于逐行比较。
async function snapshot(db: IDBDatabase, stores: string[]) {
    const plain = async (value: any): Promise<any> => {
        if (value instanceof Blob) return { blob: value.type, text: await value.text() };
        if (ArrayBuffer.isView(value)) return { [value.constructor.name]: Array.from(value as Float32Array) };
        if (Array.isArray(value)) return Promise.all(value.map(plain));
        if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await plain(v)])));
        return value;
    };
    return Object.fromEntries(await Promise.all(stores.map(async store => [store, await plain(await readSpaceStore(db, store))])));
}

// ---- 导出留痕（backupExportTrace.ts）与翻页护栏 ----
const readTrace = (): ExportTrace | null => JSON.parse(localStorage.getItem(EXPORT_TRACE_KEY) || 'null');
/** 每次取时间前进 600ms，留痕的 500ms 节流不会吞掉任何一次写入。 */
const disableTraceThrottle = () => { let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock += 600); };

it('writes the trace before every page of a table is read, pointing at that table and the rows read so far', async () => {
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, { messages: messages(2500) });
    disableTraceThrottle();
    const seen: Array<Pick<ExportTrace, 'stage'> & { store?: string; rowsRead?: number; total?: number }> = [];
    const openCursor = IDBObjectStore.prototype.openCursor;
    vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (this: IDBObjectStore, ...args: any[]) {
        if (this.transaction.db === db && this.name === 'messages') {
            const trace = readTrace();
            seen.push({ stage: trace!.stage, store: trace!.current?.store, rowsRead: trace!.current?.rowsRead, total: trace!.current?.total });
        }
        return (openCursor as any).apply(this, args);
    });
    await exportUserSpaces('full', 'current');
    expect(seen).toEqual([0, 1000, 2000].map(rowsRead => ({ stage: 'read', store: 'messages', rowsRead, total: 2500 })));
    expect(localStorage.getItem(EXPORT_TRACE_KEY)).toBeNull();
});

it('removes the trace when the export ends with an error', async () => {
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, { messages: messages(2500) });
    const error = new Error('写入器坏了');
    writer.failOn = name => (name.endsWith('/messages.1.json') ? error : undefined);
    let traceAtFailure: ExportTrace | null = null;
    writer.onAdded = name => { if (name.endsWith('/messages.0.json')) traceAtFailure = readTrace(); };
    await expect(exportUserSpaces('full', 'current')).rejects.toBe(error);
    expect(traceAtFailure).not.toBeNull();
    expect(localStorage.getItem(EXPORT_TRACE_KEY)).toBeNull();
});

it('leaves a readable trace behind when the export disappears midway without reaching its cleanup', async () => {
    temp.supported = true;
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, { messages: messages(2500), memory_vectors: [{ memoryId: 'm1', charId: 'c', vector: new Float32Array(600_000) }] });
    disableTraceThrottle();
    let reached!: () => void, release!: (error: Error) => void;
    const stuck = new Promise<void>(resolve => { reached = resolve; });
    writer.holdOn = name => name.endsWith('/messages.1.json') ? (reached(), new Promise<void>((_, reject) => { release = reject; })) : undefined;
    const exporting = exportUserSpaces('full', 'current');
    await stuck;

    const trace = readTrace()!;
    expect(trace).toMatchObject({ version: 1, mode: 'full', scope: 'current', stage: 'pack', onDisk: true });
    expect(trace.current).toMatchObject({ space: '小明', store: 'messages', rowsRead: 2000, total: 2500, pages: 2 });
    expect(trace.current!.pageBytes).toBeGreaterThan(0);
    expect(trace.current!.maxRowBytes).toBeGreaterThan(0);
    expect(trace.current!.maxRowKey).toMatch(/^\d+$/);
    // 表按名字顺序导出，memory_vectors 紧挨在 messages 前面，是「前一张表」，最大的一条就是那条约 2.4MB 的向量。
    expect(trace.previous).toMatchObject({ store: 'memory_vectors', rowsRead: 1, total: 1, pages: 1, maxRowKey: 'm1' });
    expect(trace.previous!.maxRowBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(trace.writtenBytes).toBeGreaterThan(0);

    release(new Error('页面没了'));
    await expect(exporting).rejects.toThrow('页面没了');
});

it('keeps the trace out of every space-local and shared setting in the archive, and out of migration', async () => {
    saveUserSpaces([{ id: 'default', name: '小明' }, { id: 'u_second', name: '小明二号' }]);
    writeSpaceLocal('u_second', { chat_bg: 'blue' });
    // 其余长任务的留痕和这份一样是本机状态：假装它们也还在，同样不能进包。
    const otherKeys = TASK_TRACE_KINDS.map(kind => kind.key).filter(key => key !== EXPORT_TRACE_KEY);
    for (const key of otherKeys) localStorage.setItem(key, '{"version":1,"step":"测试"}');
    let presentDuringExport = false;
    writer.onAdded = () => { presentDuringExport ||= localStorage.getItem(EXPORT_TRACE_KEY) !== null; };
    const zip = await JSZip.loadAsync(await (await exportUserSpaces('full', 'all')).arrayBuffer());
    // 留痕在收集共享设置时还在（导出正在进行），所以这里拦的是真实情形。
    expect(presentDuringExport).toBe(true);
    const manifest = await manifestOf(zip);
    expect(manifest.spaces).toHaveLength(2);
    for (const key of [EXPORT_TRACE_KEY, ...otherKeys]) {
        expect(Object.keys(manifest.settings)).not.toContain(key);
        for (const space of manifest.spaces) expect(Object.keys(space.local)).not.toContain(key);
    }
    const text = await (await exportUserSpaces('full', 'all')).text();
    expect(text).not.toContain('_progress_v1');
    expect(canMigrateLocalKey(EXPORT_TRACE_KEY)).toBe(false);
});

it('keeps the cloud generation registry and done ledger out of the archive and out of migration', async () => {
    saveUserSpaces([{ id: 'default', name: '小明' }, { id: 'u_second', name: '小明二号' }]);
    writeSpaceLocal('u_second', { chat_bg: 'blue', [CLOUD_GEN_JOBS_KEY]: '[]' });
    localStorage.setItem(CLOUD_GEN_JOBS_KEY, '[{"jobId":"j1"}]');
    localStorage.setItem(CLOUD_GEN_DONE_KEY, '["j1"]');
    const manifest = await manifestOf(await JSZip.loadAsync(await (await exportUserSpaces('full', 'all')).arrayBuffer()));
    // 同一份本地设置里的普通键照常进包，说明下面的断言不是空转。
    expect(Object.keys(manifest.spaces.find((space: any) => space.id === 'u_second').local)).toContain('chat_bg');
    for (const key of [CLOUD_GEN_JOBS_KEY, CLOUD_GEN_DONE_KEY]) {
        expect(Object.keys(manifest.settings)).not.toContain(key);
        for (const space of manifest.spaces) expect(Object.keys(space.local)).not.toContain(key);
        expect(canMigrateLocalKey(key)).toBe(false);
    }
});

it('keeps the damaged-picture list from the last restore out of the shared settings', async () => {
    saveUserSpaces([{ id: 'default', name: '小明' }, { id: 'u_second', name: '小明二号' }]);
    // 这份清单描述的是这台设备上一次恢复，重启提示一次就清掉；同样是共用键的普通设置照常进包，证明共享设置确实收集过。
    localStorage.setItem(RESTORE_DAMAGED_ASSETS_KEY, '{"total":1,"items":[{"id":"b1","locations":[],"reason":"damaged"}]}');
    localStorage.setItem('os_api_config', '{"model":"m"}');
    const manifest = await manifestOf(await JSZip.loadAsync(await (await exportUserSpaces('full', 'all')).arrayBuffer()));
    expect(manifest.settings.os_api_config).toBe('{"model":"m"}');
    expect(Object.keys(manifest.settings)).not.toContain(RESTORE_DAMAGED_ASSETS_KEY);
    for (const space of manifest.spaces) expect(Object.keys(space.local)).not.toContain(RESTORE_DAMAGED_ASSETS_KEY);
});

it.each([
    ['the cursor keeps restarting from the first row', (db: IDBDatabase) => {
        const openCursor = IDBObjectStore.prototype.openCursor;
        vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (this: IDBObjectStore, ...args: any[]) {
            // 无视「从上一页之后接着读」的范围，每页都从头读起：翻页永远走不到头。
            return (openCursor as any).apply(this, this.transaction.db === db && this.name === 'messages' ? [] : args);
        });
        return /导出备份时读取「小明 · messages」的顺序出错：第 2 页没有接在上一页之后（已读 2000 条）。请刷新页面后重试/;
    }],
    ['far more rows come back than the table had', (db: IDBDatabase) => {
        const count = IDBObjectStore.prototype.count;
        vi.spyOn(IDBObjectStore.prototype, 'count').mockImplementation(function (this: IDBObjectStore, ...args: any[]) {
            return (count as any).apply(this, this.transaction.db === db && this.name === 'messages' ? [IDBKeyRange.only(-1)] : args);
        });
        return /导出备份时读取「小明 · messages」没能结束：已读 2000 条，表里只有 0 条。请刷新页面后重试/;
    }],
] as const)('stops with a clear error when %s, cleaning up the temp file and the trace', async (_name, breakIt) => {
    temp.supported = true;
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, { messages: messages(2500) });
    const message = breakIt(db);
    await expect(exportUserSpaces('full', 'current')).rejects.toThrow(message);
    expect(temp.files).toHaveLength(1);
    expect(temp.files[0].removed).toBe(true);
    expect(localStorage.getItem(EXPORT_TRACE_KEY)).toBeNull();
});

it('records the largest row of each slow table in the export summary', async () => {
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, { messages: [...messages(2), { ...messages(3)[2], content: 'z'.repeat(50_000) }] });
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock += 60);
    await exportUserSpaces('full', 'current');
    expect(lastUserSpaceExport()?.tables.find(t => t.store === 'messages')?.maxRowBytes).toBeGreaterThan(50_000);
});
