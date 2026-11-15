// 真机探针：OPFS 能不能用，以及 OPFS 文件上传会不会被 WebKit 319985 吃成 0 字节。见 docs/backup-pipeline.md「第零期」。

import type { CloudBackupConfig } from '../types';

const PROBE_FILE = 'sullyos-opfs-probe';
const PROBE_SIZE = 4 * 1024 * 1024;
const PARTIAL_SIZE = 1024 * 1024;
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
    estimate: ProbeStep;
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
        estimate: skipped('未执行'),
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
