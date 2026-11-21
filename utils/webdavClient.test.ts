// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CloudBackupConfig } from '../types';

// 原生 / 网页两条传输路径靠 Capacitor.isNativePlatform() 分流，这里把它和 CapacitorHttp 换成可控的假实现。
const cap = vi.hoisted(() => ({
    native: false,
    request: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => cap.native },
    CapacitorHttp: { request: cap.request },
}));

// 默认没有 OPFS（走内存）；配额用例打开 supported，让写入报 QuotaExceededError。
const tmp = vi.hoisted(() => ({ supported: false, removed: 0 }));
vi.mock('./backupTempFile', () => ({
    isBackupTempFileSupported: async () => tmp.supported,
    checkBackupSpace: async () => null,
    createBackupTempFile: async () => ({
        name: 'download-test.tmp',
        openWritable: async () => new WritableStream({
            write() { throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' }); },
        }),
        getFile: async () => new File([], 'download-test.tmp'),
        remove: async () => { tmp.removed++; },
    }),
}));

import { uploadBackup, cleanupOldBackups, listBackups, downloadBackup } from './webdavClient';

const config: CloudBackupConfig = {
    webdavUrl: 'https://example.invalid/dav',
    remotePath: '/backups',
    username: 'u',
    password: 'p',
} as CloudBackupConfig;

type Call = { method: string; url: string };

const propfindSizeXml = (size: number) =>
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/backups/x.zip</d:href>`
    + `<d:propstat><d:prop><d:getcontentlength>${size}</d:getcontentlength></d:prop></d:propstat></d:response></d:multistatus>`;

// size 为 null 表示服务器没给 getcontentlength。
const listingXml = (files: Array<{ name: string; size: number | null }>) =>
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">`
    + `<d:response><d:href>/dav/backups/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`
    + files.map(f => `<d:response><d:href>/dav/backups/${f.name}</d:href><d:propstat><d:prop>`
        + (f.size === null ? '' : `<d:getcontentlength>${f.size}</d:getcontentlength>`)
        + `<d:resourcetype/></d:prop></d:propstat></d:response>`).join('')
    + `</d:multistatus>`;

// 网页端所有非上传请求都 POST 到 Worker，真实方法在 X-WebDAV-Method 里。
const stubWorkerFetch = (calls: Call[], handle: (method: string) => { status: number; body?: string }) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        const method = (init.headers as Record<string, string>)['X-WebDAV-Method'];
        calls.push({ method, url: decodeURIComponent(url) });
        const { status, body = '' } = handle(method);
        return { status, text: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
    }));
};

// 网页端上传走 XHR，服务端照回 201，不管实际存下多少字节。
class FakeXhr {
    status = 0;
    upload: { onprogress?: unknown } = {};
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    ontimeout?: () => void;
    static calls: Call[] = [];
    private url = '';
    open(_method: string, url: string) { this.url = url; }
    setRequestHeader() {}
    send() {
        FakeXhr.calls.push({ method: 'PUT', url: decodeURIComponent(this.url) });
        this.status = 201;
        queueMicrotask(() => this.onload?.());
    }
}

beforeEach(() => {
    cap.native = false;
    tmp.supported = false;
    tmp.removed = 0;
    cap.request.mockReset();
    FakeXhr.calls = [];
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('uploadBackup 大小预检', () => {
    it('超过 Worker 上传上限：直接报错且提示改用本地导出 / GitHub，不发起上传', async () => {
        // 只读 blob.size，造一个声明超大的假 blob，避免真分配几百 MB
        const oversized = { size: 200 * 1024 * 1024 } as Blob;
        const res = await uploadBackup(config, oversized, 'backup.zip');
        expect(res.ok).toBe(false);
        expect(res.message).toMatch(/超过云端代理上传上限/);
        expect(res.message).toMatch(/本地导出|GitHub/);
    });
});

const noSizeXml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/backups/x.zip</d:href>`
    + `<d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>`;

// 重试之间有真实的 setTimeout 间隔，用假定时器跳过等待。上传前的 base64 编码要走真实的事件循环，
// 所以每推进一段时间就让出一次 setImmediate，直到上传结束。
const runWithFakeTimers = async <T>(fn: () => Promise<T>): Promise<T> => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
        let settled = false;
        const pending = fn().finally(() => { settled = true; });
        for (let i = 0; i < 50 && !settled; i++) {
            await vi.advanceTimersByTimeAsync(1000);
            await new Promise(r => setImmediate(r));
        }
        return await pending;
    } finally {
        vi.useRealTimers();
    }
};

describe('uploadBackup 上传后核对远端大小（网页端）', () => {
    it('远端大小与本地不符：上传算失败，并只删掉本次上传的那个文件', async () => {
        const calls: Call[] = [];
        stubWorkerFetch(calls, (m) => (m === 'PROPFIND' ? { status: 207, body: propfindSizeXml(0) } : { status: 204 }));

        const res = await runWithFakeTimers(() => uploadBackup(config, new Blob(['hello']), 'Sully_Backup_full_1.zip'));

        expect(res.ok).toBe(false);
        expect(res.message).toMatch(/大小不符/);
        // 始终不符：按读不到大小时的节奏重读满三次才判失败。
        expect(calls.filter(c => c.method === 'PROPFIND')).toHaveLength(3);
        const deletes = calls.filter(c => c.method === 'DELETE');
        expect(deletes).toHaveLength(1);
        expect(deletes[0].url).toContain('/dav/backups/Sully_Backup_full_1.zip');
    });

    it('远端大小一致：上传成功，不删任何文件', async () => {
        const calls: Call[] = [];
        stubWorkerFetch(calls, (m) => (m === 'PROPFIND' ? { status: 207, body: propfindSizeXml(5) } : { status: 204 }));

        const res = await uploadBackup(config, new Blob(['hello']), 'Sully_Backup_full_2.zip');

        expect(res.ok).toBe(true);
        expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    });

    it('刚传完先报 0 字节：重读到一致大小就算成功，不删文件', async () => {
        const calls: Call[] = [];
        let propfinds = 0;
        stubWorkerFetch(calls, (m) => {
            if (m !== 'PROPFIND') return { status: 204 };
            propfinds++;
            return { status: 207, body: propfindSizeXml(propfinds < 2 ? 0 : 5) };
        });

        const res = await runWithFakeTimers(() => uploadBackup(config, new Blob(['hello']), 'Sully_Backup_full_11.zip'));

        expect(res.ok).toBe(true);
        expect(propfinds).toBe(2);
        expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    });

    it('刚传完短暂读不到：重试后读到一致大小就算成功', async () => {
        const calls: Call[] = [];
        let propfinds = 0;
        stubWorkerFetch(calls, (m) => {
            if (m !== 'PROPFIND') return { status: 204 };
            propfinds++;
            return propfinds < 3 ? { status: 404 } : { status: 207, body: propfindSizeXml(5) };
        });

        const res = await runWithFakeTimers(() => uploadBackup(config, new Blob(['hello']), 'Sully_Backup_full_3.zip'));

        expect(res.ok).toBe(true);
        expect(propfinds).toBe(3);
    });

    it('重试后仍确认不了文件在不在：不当作成功，也不删文件', async () => {
        const calls: Call[] = [];
        stubWorkerFetch(calls, () => ({ status: 500 }));

        const res = await runWithFakeTimers(() => uploadBackup(config, new Blob(['hello']), 'Sully_Backup_full_3.zip'));

        expect(res.ok).toBe(false);
        expect(calls.filter(c => c.method === 'PROPFIND')).toHaveLength(3);
        expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    });

    it('文件在但服务器不报大小：无从核对，按成功处理且不删文件', async () => {
        const calls: Call[] = [];
        stubWorkerFetch(calls, (m) => (m === 'PROPFIND' ? { status: 207, body: noSizeXml } : { status: 204 }));

        const res = await uploadBackup(config, new Blob(['hello']), 'Sully_Backup_full_6.zip');

        expect(res.ok).toBe(true);
        expect(calls.some(c => c.method === 'DELETE')).toBe(false);
    });
});

// 原生端 PUT / HEAD / DELETE 走 CapacitorHttp，HEAD 的响应头键名大小写随服务器。
const stubNative = (head: () => { status: number; headers?: Record<string, string> } | Promise<never>) => {
    cap.native = true;
    cap.request.mockImplementation(async (o: { method: string }) => {
        if (o.method === 'HEAD') return { ...(await head()), data: '' };
        return { status: o.method === 'DELETE' ? 204 : 201, headers: {}, data: '' };
    });
};
const nativeCalls = (method: string) => cap.request.mock.calls.map(c => c[0]).filter(o => o.method === method);

describe('uploadBackup 原生壳', () => {
    it('二进制以 base64 加 dataType:file 交给 CapacitorHttp，而不是 ArrayBuffer', async () => {
        stubNative(() => ({ status: 200, headers: { 'Content-Length': '5' } }));
        stubWorkerFetch([], () => ({ status: 500 }));

        const res = await uploadBackup(config, new Blob(['hello']), 'Sully_Backup_full_4.zip');

        expect(res.ok).toBe(true);
        const [put] = nativeCalls('PUT');
        expect(put.data).toBe(btoa('hello'));
        expect(put.dataType).toBe('file');
    });

    it('HEAD 直连读到一致大小：成功，不经过 Worker', async () => {
        const calls: Call[] = [];
        stubNative(() => ({ status: 200, headers: { 'content-length': '5' } }));
        stubWorkerFetch(calls, () => ({ status: 500 }));

        const res = await uploadBackup(config, new Blob(['hello']), 'Sully_Backup_full_7.zip');

        expect(res.ok).toBe(true);
        expect(calls).toHaveLength(0);
    });

    it('HEAD 读到大小不符：失败，用 CapacitorHttp 删掉本次上传的文件', async () => {
        stubNative(() => ({ status: 200, headers: { 'Content-Length': '2' } }));
        stubWorkerFetch([], () => ({ status: 500 }));

        const res = await runWithFakeTimers(() => uploadBackup(config, new Blob(['hello']), 'Sully_Backup_full_5.zip'));

        expect(res.ok).toBe(false);
        expect(nativeCalls('HEAD')).toHaveLength(3);
        const del = nativeCalls('DELETE');
        expect(del).toHaveLength(1);
        expect(del[0].url).toBe('https://example.invalid/dav/backups/Sully_Backup_full_5.zip');
    });

    it('HEAD 失败：退回 PROPFIND 读到一致大小就算成功', async () => {
        stubNative(() => Promise.reject(new Error('HEAD not allowed')));
        stubWorkerFetch([], () => ({ status: 207, body: propfindSizeXml(5) }));

        const res = await uploadBackup(config, new Blob(['hello']), 'Sully_Backup_full_8.zip');

        expect(res.ok).toBe(true);
    });

    it('HEAD 200 但没有 Content-Length、PROPFIND 又够不着：文件在，按成功处理且不删', async () => {
        stubNative(() => ({ status: 200, headers: {} }));
        stubWorkerFetch([], () => ({ status: 502 }));

        const res = await uploadBackup(config, new Blob(['hello']), 'Sully_Backup_full_9.zip');

        expect(res.ok).toBe(true);
        expect(nativeCalls('DELETE')).toHaveLength(0);
    });

    it('HEAD 与 PROPFIND 重试后都失败：失败，不删文件', async () => {
        stubNative(() => ({ status: 404 }));
        stubWorkerFetch([], () => ({ status: 502 }));

        const res = await runWithFakeTimers(() => uploadBackup(config, new Blob(['hello']), 'Sully_Backup_full_10.zip'));

        expect(res.ok).toBe(false);
        expect(nativeCalls('HEAD')).toHaveLength(3);
        expect(nativeCalls('DELETE')).toHaveLength(0);
    });
});

describe('downloadBackup 网页端', () => {
    // 只能按流读一次的响应：整块读取的方法一调就挂。
    const stubStreamedGet = (bytes: number[]) => {
        const wholeRead = vi.fn(async () => { throw new Error('whole-body read'); });
        vi.stubGlobal('fetch', vi.fn(async () => ({
            status: 200,
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
                    controller.close();
                },
            }),
            arrayBuffer: wholeRead,
            blob: wholeRead,
            text: wholeRead,
        })));
        return wholeRead;
    };
    const file = (size: number) => ({ name: 'Sully_Backup_full_1.zip', size, lastModified: '', href: '/backups/Sully_Backup_full_1.zip' });
    // jsdom 的 Blob 没有 arrayBuffer()，走 FileReader 读回。
    const bytesOf = (blob: Blob) => new Promise<number[]>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(Array.from(new Uint8Array(reader.result as ArrayBuffer)));
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(blob);
    });

    it('响应体按流逐块写入，不整块读进内存', async () => {
        const wholeRead = stubStreamedGet([1, 2, 3, 4]);
        const backup = await downloadBackup(config, file(4));

        expect(wholeRead).not.toHaveBeenCalled();
        expect(await bytesOf(backup!.blob)).toEqual([1, 2, 3, 4]);
        await backup!.dispose();
    });

    it('服务器报的大小与实际不符时失败', async () => {
        stubStreamedGet([1, 2, 3, 4]);
        await expect(downloadBackup(config, file(6))).rejects.toThrow('应为 6 字节，实际 4 字节');
    });

    it('服务器没报大小时不核对，照常成功', async () => {
        stubStreamedGet([1, 2, 3]);
        const backup = await downloadBackup(config, file(0));
        expect(await bytesOf(backup!.blob)).toEqual([1, 2, 3]);
    });
});

describe('downloadBackup 分段', () => {
    const CHUNK = 8 * 1024 * 1024;
    const pattern = (length: number) => {
        const data = new Uint8Array(length);
        for (let i = 0; i < length; i++) data[i] = i % 251;
        return data;
    };
    const file = (size: number) => ({ name: 'Sully_Backup_full_2.zip', size, lastModified: '', href: '/backups/Sully_Backup_full_2.zip' });
    const readBytes = (blob: Blob) => new Promise<Uint8Array>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(blob);
    });
    const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

    /** 网页端经 Worker 的 GET：带 Range 的回 206 那一段（ignoreRange 时回 200 整包），不带的回 200 整包流。 */
    const stubDownload = (data: Uint8Array, opts: { ignoreRange?: boolean; shortChunkAt?: number } = {}) => {
        const log = { ranges: [] as string[], full: 0, cancelled: 0 };
        const fullStream = () => {
            const step = Math.max(1, Math.ceil(data.length / 8));
            let offset = 0;
            return new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (offset >= data.length) return controller.close();
                    controller.enqueue(data.slice(offset, offset + step));
                    offset += step;
                },
                cancel() { log.cancelled++; },
            });
        };
        const wholeRead = async () => { throw new Error('whole-body read'); };
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
            const range = (init.headers as Record<string, string>)['X-WebDAV-Range'];
            if (range) log.ranges.push(range);
            else log.full++;
            if (range && !opts.ignoreRange) {
                const [start, end] = range.slice('bytes='.length).split('-').map(Number);
                const slice = data.slice(start + (opts.shortChunkAt === start ? 1 : 0), end + 1);
                return { status: 206, body: null, arrayBuffer: async () => slice.buffer, text: wholeRead };
            }
            return { status: 200, body: fullStream(), arrayBuffer: wholeRead, text: wholeRead };
        }));
        return log;
    };

    it('206 正常分段：拼出的字节与原始一致', async () => {
        const data = pattern(CHUNK + 5);
        const log = stubDownload(data);
        const backup = await downloadBackup(config, file(data.length));

        expect(log.ranges).toEqual([`bytes=0-${CHUNK - 1}`, `bytes=${CHUNK}-${CHUNK + 4}`]);
        expect(log.full).toBe(0);
        expect(sameBytes(await readBytes(backup!.blob), data)).toBe(true);
    });

    it('服务器不理 Range 回 200：不重试，取消那条响应，只发一次整包请求', async () => {
        const data = pattern(CHUNK + 5);
        const log = stubDownload(data, { ignoreRange: true });
        const backup = await downloadBackup(config, file(data.length));

        expect(log.ranges).toHaveLength(1);
        expect(log.cancelled).toBe(1);
        expect(log.full).toBe(1);
        expect(sameBytes(await readBytes(backup!.blob), data)).toBe(true);
    });

    it('某一段长度不符：这段重试三次后改走整包下载，坏段不进结果', async () => {
        const data = pattern(CHUNK + 5);
        const log = stubDownload(data, { shortChunkAt: CHUNK });
        const backup = await runWithFakeTimers(() => downloadBackup(config, file(data.length)));

        expect(log.ranges.filter(r => r.startsWith(`bytes=${CHUNK}-`))).toHaveLength(3);
        expect(log.full).toBe(1);
        expect(sameBytes(await readBytes(backup!.blob), data)).toBe(true);
    });

    it('整包下载中途断流：失败，不返回残缺的备份', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            status: 200,
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array([1, 2]));
                    controller.error(new TypeError('network error'));
                },
            }),
            arrayBuffer: async () => { throw new Error('whole-body read'); },
            text: async () => '',
        })));

        await expect(downloadBackup(config, file(4))).rejects.toThrow('network error');
    });

    it('原生壳按 Range 分段直连，CapacitorHttp 的 base64 段拼出原始字节，不经过 Worker', async () => {
        const data = pattern(CHUNK + 5);
        cap.native = true;
        cap.request.mockImplementation(async (o: { method: string; headers: Record<string, string> }) => {
            const [start, end] = o.headers.Range.slice('bytes='.length).split('-').map(Number);
            return { status: 206, headers: {}, data: Buffer.from(data.slice(start, end + 1)).toString('base64') };
        });
        const workerFetch = vi.fn();
        vi.stubGlobal('fetch', workerFetch);

        const backup = await downloadBackup(config, file(data.length));

        expect(cap.request.mock.calls.map(c => c[0].headers.Range)).toEqual([`bytes=0-${CHUNK - 1}`, `bytes=${CHUNK}-${CHUNK + 4}`]);
        expect(workerFetch).not.toHaveBeenCalled();
        expect(sameBytes(await readBytes(backup!.blob), data)).toBe(true);
    });

    it('分段写盘时配额不足：中文报空间不足，不再整包重下，临时文件已删', async () => {
        tmp.supported = true;
        const log = stubDownload(pattern(CHUNK + 5));

        await expect(downloadBackup(config, file(CHUNK + 5))).rejects.toThrow('设备存储空间不足');
        expect(log.full).toBe(0);
        expect(tmp.removed).toBe(1);
    });

    it('整包流式写盘时配额不足：断开响应流，临时文件已删', async () => {
        tmp.supported = true;
        const log = stubDownload(pattern(4));

        await expect(downloadBackup(config, file(4))).rejects.toThrow('设备存储空间不足');
        expect(log.cancelled).toBe(1);
        expect(tmp.removed).toBe(1);
    });
});

const deletedNames = (calls: Call[]) =>
    calls.filter(c => c.method === 'DELETE').map(c => c.url.split('/').pop());

describe('cleanupOldBackups', () => {
    it('小到不可能是备份的文件不占保留名额，也不被删除', async () => {
        const files = [
            { name: 'Sully_Backup_full_9.zip', size: 0 },
            { name: 'Sully_Backup_full_8.zip', size: 2 },
            { name: 'Sully_Backup_full_7.zip', size: 100 },
            { name: 'Sully_Backup_full_6.zip', size: 100 },
            { name: 'Sully_Backup_full_5.zip', size: 100 },
            { name: 'Sully_Backup_full_4.zip', size: 100 },
            { name: 'Sully_Backup_full_3.zip', size: 100 },
            { name: 'Sully_Backup_full_2.zip', size: 100 },
        ];
        const calls: Call[] = [];
        stubWorkerFetch(calls, (m) => (m === 'PROPFIND' ? { status: 207, body: listingXml(files) } : { status: 204 }));

        const deleted = await cleanupOldBackups(config, 5);

        expect(deleted).toBe(1);
        expect(deletedNames(calls)).toEqual(['Sully_Backup_full_2.zip']);
    });

    it('按时间戳而不是 mode 排序：最新的 full 不会被较旧的 text_only 挤掉', async () => {
        const files = [
            { name: 'Sully_Backup_full_1763200000006.zip', size: 100 },
            { name: 'Sully_Backup_text_only_1763200000005.zip', size: 100 },
            { name: 'Sully_Backup_text_only_1763200000004.zip', size: 100 },
            { name: 'Sully_Backup_text_only_1763200000003.zip', size: 100 },
            { name: 'Sully_Backup_text_only_1763200000002.zip', size: 100 },
            { name: 'Sully_Backup_text_only_1763200000001.zip', size: 100 },
        ];
        const calls: Call[] = [];
        stubWorkerFetch(calls, (m) => (m === 'PROPFIND' ? { status: 207, body: listingXml(files) } : { status: 204 }));

        const deleted = await cleanupOldBackups(config, 5);

        expect(deleted).toBe(1);
        expect(deletedNames(calls)).toEqual(['Sully_Backup_text_only_1763200000001.zip']);
    });

    it('列表也按时间戳新到旧排；不是本应用命名的文件排在后面', async () => {
        const files = [
            { name: 'my_notes.zip', size: 100 },
            { name: 'Sully_Backup_text_only_1763200000001.zip', size: 100 },
            { name: 'Sully_Backup_full_1763200000006.zip', size: 100 },
        ];
        stubWorkerFetch([], () => ({ status: 207, body: listingXml(files) }));

        const listed = await listBackups(config);

        expect(listed.map(f => f.name)).toEqual([
            'Sully_Backup_full_1763200000006.zip',
            'Sully_Backup_text_only_1763200000001.zip',
            'my_notes.zip',
        ]);
    });

    it('不是本应用命名的文件分不出新旧：不占保留名额，也不被删除', async () => {
        const files = [
            { name: 'my_notes.zip', size: 100 },
            ...[6, 5, 4, 3, 2, 1].map(n => ({ name: `Sully_Backup_full_176320000000${n}.zip`, size: 100 })),
        ];
        const calls: Call[] = [];
        stubWorkerFetch(calls, (m) => (m === 'PROPFIND' ? { status: 207, body: listingXml(files) } : { status: 204 }));

        await cleanupOldBackups(config, 5);

        expect(deletedNames(calls)).toEqual(['Sully_Backup_full_1763200000001.zip']);
    });

    it('服务器没报大小的文件照常参与清理', async () => {
        const files = [7, 6, 5, 4, 3, 2, 1].map(n => ({ name: `Sully_Backup_full_176320000000${n}.zip`, size: null }));
        const calls: Call[] = [];
        stubWorkerFetch(calls, (m) => (m === 'PROPFIND' ? { status: 207, body: listingXml(files) } : { status: 204 }));

        const deleted = await cleanupOldBackups(config, 5);

        expect(deleted).toBe(2);
        expect(deletedNames(calls)).toEqual(['Sully_Backup_full_1763200000002.zip', 'Sully_Backup_full_1763200000001.zip']);
    });
});
