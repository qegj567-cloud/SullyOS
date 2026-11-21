import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Module = typeof import('./backupTempFile');

const domError = (name: string) => Object.assign(new Error(name), { name });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

// 假 OPFS：文件有打开的可写流时 removeEntry 失败；写入出错时像 Chromium 那样自动放开文件。
let writableMode: 'ok' | 'missing' | 'throws' = 'ok';
let afterFileCreated: (() => Promise<unknown>) | undefined;

class FakeFile {
    data: Uint8Array[] = [];
    openWriters = 0;
    failWritesAfter = Infinity;
}

class FakeFileHandle {
    readonly kind = 'file';
    constructor(readonly name: string, readonly file: FakeFile) {}
    async getFile() {
        return new File(this.file.data as BlobPart[], this.name);
    }
    async createWritable() {
        if (writableMode === 'missing') throw new TypeError('createWritable is not a function');
        if (writableMode === 'throws') throw domError('NotAllowedError');
        const file = this.file;
        const pending: Uint8Array[] = [];
        file.openWriters++;
        let writes = 0;
        return new WritableStream<Uint8Array>({
            write(chunk) {
                if (++writes > file.failWritesAfter) {
                    file.openWriters--;
                    throw domError('QuotaExceededError');
                }
                // 像 Safari 27.2 那样：收到视图就把背后的整块缓冲写出去
                pending.push(new Uint8Array(chunk.buffer));
            },
            close() {
                file.data = pending;
                file.openWriters--;
            },
            abort() {
                file.openWriters--;
            },
        });
    }
}

class FakeDir {
    files = new Map<string, FakeFile>();
    dirs = new Map<string, FakeDir>();
    /** 目录列表里还在、实际已被别的标签页删掉的文件。 */
    ghosts: string[] = [];
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        if (!this.dirs.has(name)) {
            if (!options?.create) throw domError('NotFoundError');
            this.dirs.set(name, new FakeDir());
        }
        return this.dirs.get(name)!;
    }
    async getFileHandle(name: string, options?: { create?: boolean }) {
        if (!this.files.has(name)) {
            if (!options?.create) throw domError('NotFoundError');
            this.files.set(name, new FakeFile());
            await afterFileCreated?.();
        }
        return new FakeFileHandle(name, this.files.get(name)!);
    }
    async removeEntry(name: string) {
        const file = this.files.get(name);
        if (!file) throw domError('NotFoundError');
        if (file.openWriters > 0) throw domError('NoModificationAllowedError');
        this.files.delete(name);
    }
    async *values() {
        for (const name of this.ghosts) yield { kind: 'file', name };
        for (const [name, file] of [...this.files]) yield new FakeFileHandle(name, file);
    }
}

// 假 Web Locks：只实现独占锁和 ifAvailable，所有「标签页」共享同一份 held。
class FakeLocks {
    held = new Set<string>();
    private queues = new Map<string, Promise<unknown>>();
    request(name: string, ...args: unknown[]) {
        const callback = args.pop() as (lock: { name: string } | null) => unknown;
        const options = (args[0] ?? {}) as { ifAvailable?: boolean };
        if (options.ifAvailable && this.held.has(name)) return Promise.resolve(callback(null));
        const run = (this.queues.get(name) ?? Promise.resolve()).then(async () => {
            this.held.add(name);
            try {
                return await callback({ name });
            } finally {
                this.held.delete(name);
            }
        });
        this.queues.set(name, run.catch(() => undefined));
        return run;
    }
}

let mod: Module;
let root: FakeDir;
let locks: FakeLocks;
const tmpDir = () => root.dirs.get('backup-tmp')!;
const opfs = () => ({ storage: { getDirectory: vi.fn(async () => root) }, locks });

/** 模拟崩溃残留：文件在，锁早已随页面消失。 */
function leaveResidue(...names: string[]) {
    if (!root.dirs.has('backup-tmp')) root.dirs.set('backup-tmp', new FakeDir());
    for (const name of names) tmpDir().files.set(name, new FakeFile());
}

beforeEach(async () => {
    vi.resetModules();
    mod = await import('./backupTempFile');
    root = new FakeDir();
    locks = new FakeLocks();
    writableMode = 'ok';
    afterFileCreated = undefined;
    vi.stubGlobal('navigator', opfs());
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('isBackupTempFileSupported', () => {
    it('writes, reads back and deletes a probe file, even if a cleanup runs meanwhile', async () => {
        afterFileCreated = () => mod.cleanupBackupTempFiles();
        expect(await mod.isBackupTempFileSupported()).toBe(true);
        expect(tmpDir().files.size).toBe(0);
        expect(locks.held.size).toBe(0);
    });

    it('caches the result for the page lifetime, including failures', async () => {
        const nav = opfs();
        vi.stubGlobal('navigator', nav);
        expect(await mod.isBackupTempFileSupported()).toBe(true);
        expect(await mod.isBackupTempFileSupported()).toBe(true);
        expect(nav.storage.getDirectory).toHaveBeenCalledTimes(1);

        vi.resetModules();
        mod = await import('./backupTempFile');
        writableMode = 'throws';
        expect(await mod.isBackupTempFileSupported()).toBe(false);
        writableMode = 'ok';
        expect(await mod.isBackupTempFileSupported()).toBe(false);
    });

    it.each([
        ['no OPFS', () => vi.stubGlobal('navigator', { locks })],
        ['getDirectory rejects', () => vi.stubGlobal('navigator', { storage: { getDirectory: async () => { throw domError('SecurityError'); } }, locks })],
        ['no createWritable', () => { writableMode = 'missing'; }],
        ['createWritable throws', () => { writableMode = 'throws'; }],
        ['no Web Locks', () => vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } })],
    ])('reports unavailable without throwing: %s', async (_label, setup) => {
        setup();
        expect(await mod.isBackupTempFileSupported()).toBe(false);
        expect(root.dirs.get('backup-tmp')?.files.size ?? 0).toBe(0);
        expect(locks.held.size).toBe(0);
    });
});

describe('createBackupTempFile', () => {
    it('holds the lock until remove(), which deletes the file', async () => {
        const temp = await mod.createBackupTempFile('export');
        expect(temp.name).toMatch(/^export-\d+-\w+\.tmp$/);
        const writer = (await temp.openWritable()).getWriter();
        await writer.write(new TextEncoder().encode('hello'));
        await writer.close();
        expect(await (await temp.getFile()).text()).toBe('hello');
        expect(locks.held.has(`backup-tmp/${temp.name}`)).toBe(true);

        await temp.remove();
        expect(tmpDir().files.has(temp.name)).toBe(false);
        expect(locks.held.size).toBe(0);
    });

    it('takes the lock before creating the file, so a concurrent cleanup cannot delete it', async () => {
        afterFileCreated = () => mod.cleanupBackupTempFiles();
        const temp = await mod.createBackupTempFile('download');
        expect(tmpDir().files.has(temp.name)).toBe(true);
        await temp.remove();
    });

    it('writes exactly the bytes of a view, not the whole buffer behind it', async () => {
        const temp = await mod.createBackupTempFile('download');
        const writer = (await temp.openWritable()).getWriter();
        const big = new Uint8Array([9, 9, 1, 2, 3, 9, 9, 9]);
        await writer.write(big.subarray(2, 5));
        await writer.write(new Uint8Array([4, 5]));
        await writer.close();
        expect(Array.from(new Uint8Array(await (await temp.getFile()).arrayBuffer()))).toEqual([1, 2, 3, 4, 5]);
        await temp.remove();
    });

    it('allows only one writable; remove() still cleans up after a second attempt', async () => {
        const temp = await mod.createBackupTempFile('export');
        await temp.openWritable();
        await expect(temp.openWritable()).rejects.toThrow('already open');
        await temp.remove();
        expect(tmpDir().files.has(temp.name)).toBe(false);
        expect(locks.held.size).toBe(0);
    });

    it('cleans up fully after a write fails midway', async () => {
        const temp = await mod.createBackupTempFile('export');
        tmpDir().files.get(temp.name)!.failWritesAfter = 1;
        const writer = (await temp.openWritable()).getWriter();
        await writer.write(new Uint8Array([1]));
        await expect(writer.write(new Uint8Array([2]))).rejects.toThrow('QuotaExceededError');

        await temp.remove();
        expect(tmpDir().files.has(temp.name)).toBe(false);
        expect(locks.held.size).toBe(0);
    });

    it('cleans up when the task fails elsewhere while the writer still holds the stream', async () => {
        const temp = await mod.createBackupTempFile('export');
        const writer = (await temp.openWritable()).getWriter();
        await writer.write(new Uint8Array([1]));

        await temp.remove();
        expect(tmpDir().files.has(temp.name)).toBe(false);
        expect(locks.held.size).toBe(0);
    });
});

describe('cleanupBackupTempFiles', () => {
    it('deletes every unlocked file and keeps the locked one', async () => {
        const inUse = await mod.createBackupTempFile('export');
        leaveResidue('export-1-a.tmp', 'download-2-b.tmp');
        await mod.cleanupBackupTempFiles();
        expect([...tmpDir().files.keys()]).toEqual([inUse.name]);
        await inUse.remove();
    });

    it('tolerates concurrent cleanups and entries another tab already deleted', async () => {
        leaveResidue('export-1-a.tmp', 'download-2-b.tmp');
        tmpDir().ghosts = ['export-0-gone.tmp'];
        await expect(Promise.all([mod.cleanupBackupTempFiles(), mod.cleanupBackupTempFiles()])).resolves.toBeDefined();
        expect(tmpDir().files.size).toBe(0);
    });

    it('does nothing when the directory does not exist or locks are unavailable', async () => {
        await expect(mod.cleanupBackupTempFiles()).resolves.toBeUndefined();

        leaveResidue('export-1-a.tmp');
        vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
        await mod.cleanupBackupTempFiles();
        expect(tmpDir().files.has('export-1-a.tmp')).toBe(true);
    });
});

describe('checkBackupSpace', () => {
    it('compares quota minus usage with the needed bytes', async () => {
        vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 1000, usage: 400 }) } });
        expect(await mod.checkBackupSpace(500)).toEqual({ enough: true, available: 600 });
        expect(await mod.checkBackupSpace(700)).toEqual({ enough: false, available: 600 });
    });

    it('returns null (unknown) when estimate is missing', async () => {
        vi.stubGlobal('navigator', {});
        expect(await mod.checkBackupSpace(1)).toBeNull();
        vi.stubGlobal('navigator', { storage: {} });
        expect(await mod.checkBackupSpace(1)).toBeNull();
    });
});

describe('withScreenWakeLock', () => {
    const fakeSentinel = () => {
        const sentinel = { released: false, release: vi.fn(async () => { sentinel.released = true; }) };
        return sentinel;
    };

    it('re-acquires when the page becomes visible again, then stops listening and releases at the end', async () => {
        const sentinels: ReturnType<typeof fakeSentinel>[] = [];
        const request = vi.fn(async () => { const s = fakeSentinel(); sentinels.push(s); return s; });
        const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
        vi.stubGlobal('navigator', { wakeLock: { request } });
        vi.stubGlobal('document', doc);
        const setVisibility = async (state: string) => {
            doc.visibilityState = state;
            doc.dispatchEvent(new Event('visibilitychange'));
            await flush();
        };

        let finish!: () => void;
        const run = mod.withScreenWakeLock(() => new Promise<void>(resolve => { finish = resolve; }));
        await flush();
        expect(request).toHaveBeenCalledTimes(1);

        await setVisibility('visible');
        expect(request).toHaveBeenCalledTimes(1); // still held, no duplicate

        sentinels[0].released = true; // system takes it back while hidden
        await setVisibility('hidden');
        expect(request).toHaveBeenCalledTimes(1);
        await setVisibility('visible');
        expect(request).toHaveBeenCalledTimes(2);

        finish();
        await run;
        expect(sentinels[1].release).toHaveBeenCalledTimes(1);
        sentinels[1].released = true;
        await setVisibility('visible');
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('releases the wake lock when the task throws', async () => {
        const sentinel = fakeSentinel();
        vi.stubGlobal('navigator', { wakeLock: { request: vi.fn(async () => sentinel) } });
        await expect(mod.withScreenWakeLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(sentinel.release).toHaveBeenCalledTimes(1);
    });

    it('runs the task when wake lock is unsupported or denied', async () => {
        vi.stubGlobal('navigator', {});
        expect(await mod.withScreenWakeLock(async () => 1)).toBe(1);
        vi.stubGlobal('navigator', { wakeLock: { request: async () => { throw domError('NotAllowedError'); } } });
        expect(await mod.withScreenWakeLock(async () => 2)).toBe(2);
    });
});
