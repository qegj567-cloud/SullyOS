// 真机探针：OPFS 能不能用，以及 OPFS 文件上传会不会被 WebKit 319985 吃成 0 字节。见 docs/backup-pipeline.md「第零期」。

import type { CloudBackupConfig } from '../types';

const PROBE_FILE = 'sullyos-opfs-probe';
const PROBE_SIZE = 4 * 1024 * 1024;
const PARTIAL_SIZE = 1024 * 1024;
const APPEND_FILE = `${PROBE_FILE}-append`;
const APPEND_COUNT = 16;
const UPLOAD_TIMEOUT_MS = 60_000;

export interface ProbeStep {
    ok: boolean;
    skipped?: boolean;
    error?: string;
    [key: string]: unknown;
}

export interface OpfsProbeResult {
    userAgent: string;
    protocol: string;
    swControlled: boolean;
    getDirectory: ProbeStep;
    createFile: ProbeStep;
    write: ProbeStep;
    readBack: ProbeStep;
    /**
     * 往同一个文件连续追加写 16 次、每次 1MB，记下文件实际大小和浏览器报的用量涨了多少。做两遍：
     * exact 每次传一块刚好 1MB 的独立缓冲；view 每次传一块 4MB 缓冲上的 1MB 视图。
     * 用量按写入量涨（约 16MB）是正常记账；远超这个数说明每写一次都把整个文件重新算了一遍。
     * view 的文件大小不是 16MB，说明浏览器把视图背后的整块缓冲都写了进去。
     */
    appendWrites: ProbeStep;
    estimate: ProbeStep;
    /** 备份临时目录里现存的文件：恢复或下载结束后应当是空的。 */
    backupTmp: ProbeStep;
    upload: ProbeStep | Record<'file' | 'sliceWhole' | 'slicePart', ProbeStep>;
    uploadVia?: string;
    remove: ProbeStep;
}

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));
const skipped = (reason: string): ProbeStep => ({ ok: false, skipped: true, error: reason });

async function attempt(fn: () => Promise<Record<string, unknown>>): Promise<ProbeStep> {
    try {
        return { ok: true, ...(await fn()) };
    } catch (error) {
        return { ok: false, error: describe(error) };
    }
}

// 按偏移生成，读回时能逐字节复算，不需要把期望内容另存一份。
export function probeBytes(size: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + (i >>> 10)) & 0xff;
    return bytes;
}

// FNV-1a 32 位：够发现截断、错位、全零，不追求抗碰撞。
export function checksum(bytes: Uint8Array): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193);
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 把一段请求体发出去并报告远端实际收到多少；mode 只用来区分三种请求体的文件名。 */
export interface OpfsProbeUploader {
    via: string;
    send(mode: string, body: Blob): Promise<Record<string, unknown>>;
}

/** 匿名可写、允许跨域的 WebDAV 目录或回显地址。 */
export const urlProbeUploader = (base: string): OpfsProbeUploader => ({
    via: 'url',
    async send(mode, body) {
        const target = `${base.replace(/\/+$/, '')}/${PROBE_FILE}-${mode}.bin`;
        const put = await fetch(target, {
            method: 'PUT',
            body,
            headers: { 'Content-Type': 'application/octet-stream' },
            signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
        const response = (await put.text()).slice(0, 200);
        // WebDAV 端点用 HEAD 读回远端实际大小；回显端点看 response 里自己报的字节数。
        const head = await fetch(target, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
        fetch(target, { method: 'DELETE' }).catch(() => undefined);
        return {
            sentSize: body.size,
            putStatus: put.status,
            response,
            headStatus: head?.status ?? null,
            remoteSize: head?.headers.get('content-length') ?? null,
        };
    },
});

/** 走云备份自己的 WebDAV 上传通道，测的就是备份真正走的那条路；上传自带远端大小核对，不符时 message 里有云端字节数。 */
export const webdavProbeUploader = (config: CloudBackupConfig): OpfsProbeUploader => ({
    via: 'webdav-backup-channel',
    async send(mode, body) {
        const { uploadBackup, deleteBackup } = await import('./webdavClient');
        const name = `${PROBE_FILE}-${mode}.bin`;
        const { ok, message } = await uploadBackup(config, body, name);
        if (ok) {
            const href = `${config.remotePath.replace(/\/+$/, '')}/${name}`;
            await deleteBackup(config, { name, size: body.size, lastModified: 0, href });
        }
        return { ok, sentSize: body.size, message };
    },
});

/** 不抛错：每一步各自记录成败，失败了能往后跑的照跑。不传 uploader 就不发任何网络请求。 */
export async function runOpfsProbe(uploader?: OpfsProbeUploader): Promise<OpfsProbeResult> {
    const result: OpfsProbeResult = {
        userAgent: globalThis.navigator?.userAgent ?? '',
        protocol: globalThis.location?.protocol ?? '',
        swControlled: Boolean(globalThis.navigator?.serviceWorker?.controller),
        getDirectory: skipped('未执行'),
        createFile: skipped('未执行'),
        write: skipped('未执行'),
        readBack: skipped('未执行'),
        appendWrites: skipped('未执行'),
        estimate: skipped('未执行'),
        backupTmp: skipped('未执行'),
        upload: skipped('未选择上传方式'),
        remove: skipped('未执行'),
    };
    const storage = globalThis.navigator?.storage;

    result.estimate = typeof storage?.estimate === 'function'
        ? await attempt(async () => {
            const { quota, usage } = await storage.estimate();
            return { quota: quota ?? null, usage: usage ?? null };
        })
        : skipped('navigator.storage.estimate 不存在');

    if (typeof storage?.getDirectory !== 'function') {
        result.getDirectory = { ok: false, error: 'navigator.storage.getDirectory 不存在' };
        return result;
    }
    let dir: FileSystemDirectoryHandle | undefined;
    result.getDirectory = await attempt(async () => {
        dir = await storage.getDirectory();
        return {};
    });
    if (!dir) return result;

    result.backupTmp = await attempt(async () => {
        const entries: Array<{ name: string; size: number | null }> = [];
        let tmp: FileSystemDirectoryHandle;
        try {
            tmp = await dir!.getDirectoryHandle('backup-tmp');
        } catch {
            return { entries };
        }
        // lib.dom 的类型里还没有目录句柄的异步迭代。
        for await (const [name, handle] of (tmp as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
            const size = handle.kind === 'file'
                ? await (handle as FileSystemFileHandle).getFile().then(f => f.size, () => null)
                : null;
            entries.push({ name, size });
        }
        return { entries };
    });

    let handle: FileSystemFileHandle | undefined;
    result.createFile = await attempt(async () => {
        handle = await dir!.getFileHandle(PROBE_FILE, { create: true });
        return {};
    });
    if (!handle) return result;

    const expected = probeBytes(PROBE_SIZE);
    const expectedChecksum = checksum(expected);
    result.write = typeof handle.createWritable !== 'function'
        ? { ok: false, error: 'createWritable 不存在（Safari 26.0 以前页面里没有）' }
        : await attempt(async () => {
            const writable = await handle!.createWritable();
            await writable.write(expected);
            await writable.close();
            return { written: expected.byteLength };
        });

    let file: File | undefined;
    if (result.write.ok) {
        result.readBack = await attempt(async () => {
            file = await handle!.getFile();
            const actual = new Uint8Array(await file.arrayBuffer());
            const actualChecksum = checksum(actual);
            const match = actual.byteLength === PROBE_SIZE && actualChecksum === expectedChecksum;
            return {
                ok: match,
                ...(match ? {} : { error: '读回的大小或校验和与写入不一致' }),
                size: actual.byteLength,
                expectedSize: PROBE_SIZE,
                checksum: actualChecksum,
                expectedChecksum,
            };
        });
    } else {
        result.readBack = skipped('写入没成功');
    }

    result.appendWrites = !result.write.ok ? skipped('写入没成功') : await attempt(async () => {
        const usage = async () => (typeof storage.estimate === 'function' ? (await storage.estimate()).usage ?? null : null);
        const run = async (chunk: Uint8Array<ArrayBuffer>) => {
            const usageBefore = await usage();
            const appendHandle = await dir!.getFileHandle(APPEND_FILE, { create: true });
            const writable = await appendHandle.createWritable();
            try {
                for (let i = 0; i < APPEND_COUNT; i++) await writable.write(chunk);
            } finally {
                await writable.close();
            }
            const fileSize = (await appendHandle.getFile()).size;
            const usageAfter = await usage();
            await dir!.removeEntry(APPEND_FILE);
            return { fileSize, usageGrowth: usageBefore === null || usageAfter === null ? null : usageAfter - usageBefore };
        };
        return {
            writes: APPEND_COUNT,
            written: APPEND_COUNT * PARTIAL_SIZE,
            exact: await run(expected.slice(0, PARTIAL_SIZE)),
            view: await run(expected.subarray(0, PARTIAL_SIZE)),
        };
    });

    if (uploader && file) {
        const source = file;
        const send = (mode: string, body: Blob) => attempt(() => uploader.send(mode, body));
        result.uploadVia = uploader.via;
        // 三种请求体依次发：原文件对象是 319985 的触发形态，slice 是绕法。
        result.upload = {
            file: await send('file', source),
            sliceWhole: await send('slice-whole', source.slice(0, source.size)),
            slicePart: await send('slice-part', source.slice(0, PARTIAL_SIZE)),
        };
    } else if (uploader) {
        result.upload = skipped('没有可上传的 OPFS 文件');
    }

    result.remove = await attempt(async () => {
        await dir!.removeEntry(PROBE_FILE);
        return {};
    });
    return result;
}

const STRESS_FILE = `${PROBE_FILE}-stress`;

/**
 * 往同一个文件连续追加写 1MB，直到写满 count 次或写入被拒绝，然后删掉。
 * 浏览器报的用量会随写入次数成平方增长（见 docs/backup-pipeline.md「平台事实」），这里看的是：
 * 账面用量远超配额、磁盘实际还空着的时候，写入会不会被拒绝。每 128 次记一次用量和配额。
 */
export async function runOpfsAppendStress(count = 2048, onProgress?: (done: number) => void): Promise<ProbeStep> {
    return attempt(async () => {
        const storage = globalThis.navigator.storage;
        const dir = await storage.getDirectory();
        const handle = await dir.getFileHandle(STRESS_FILE, { create: true });
        const writable = await handle.createWritable();
        const chunk = probeBytes(PARTIAL_SIZE);
        const samples: Array<{ writes: number; usage: number | null; quota: number | null }> = [];
        let done = 0;
        const sample = async () => {
            const { usage, quota } = await storage.estimate();
            samples.push({ writes: done, usage: usage ?? null, quota: quota ?? null });
        };
        let writeError: string | undefined;
        let closeError: string | undefined;
        try {
            await sample();
            while (done < count) {
                await writable.write(chunk);
                done++;
                if (done % 128 === 0) {
                    await sample();
                    onProgress?.(done);
                }
            }
        } catch (error) {
            writeError = describe(error);
        }
        try {
            await writable.close();
        } catch (error) {
            closeError = describe(error);
        }
        const fileSize = await handle.getFile().then(f => f.size, () => null);
        await sample();
        await dir.removeEntry(STRESS_FILE).catch(() => undefined);
        return { ok: !writeError && !closeError, target: count, writes: done, fileSize, writeError, closeError, samples };
    });
}

/**
 * 选来的文件按范围读要多久：读文件末尾 64KB，再在 8 个位置由前到后、由后到前各读 1MB，最后顺序读开头 32MB。
 * 耗时和位置无关，说明文件能直接跳到任意位置读；越靠后越慢，说明每次读都要从文件开头跳过去，
 * 这类文件上按需读包会比整个读进内存还慢。不读文件名，也不保留读到的内容。
 */
export async function measureFileReads(file: Blob): Promise<ProbeStep> {
    return attempt(async () => {
        const timed = async (offset: number, length: number) => {
            const started = performance.now();
            const bytes = (await file.slice(offset, Math.min(file.size, offset + length)).arrayBuffer()).byteLength;
            return { offset, bytes, ms: Math.round(performance.now() - started) };
        };
        const tail = await timed(Math.max(0, file.size - 64 * 1024), 64 * 1024);
        const spots = Array.from({ length: 8 }, (_, i) => Math.floor((file.size * i) / 8));
        const forward: Array<Awaited<ReturnType<typeof timed>>> = [];
        for (const offset of spots) forward.push(await timed(offset, PARTIAL_SIZE));
        // 往回读时错开 1MB，不重复读刚读过的那一段
        const backward: typeof forward = [];
        for (const offset of [...spots].reverse()) backward.push(await timed(offset + PARTIAL_SIZE, PARTIAL_SIZE));
        const started = performance.now();
        let bytes = 0;
        for (let offset = 0; offset < Math.min(file.size, 32 * PARTIAL_SIZE); offset += PARTIAL_SIZE) {
            bytes += (await file.slice(offset, offset + PARTIAL_SIZE).arrayBuffer()).byteLength;
        }
        return {
            userAgent: globalThis.navigator?.userAgent ?? '',
            size: file.size,
            tail,
            forward,
            backward,
            sequential: { bytes, ms: Math.round(performance.now() - started) },
        };
    });
}
