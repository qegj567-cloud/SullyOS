// 云端备份下载的落盘：字节顺序写进临时文件（OPFS 不可用时留在内存），GitHub 与 WebDAV 共用。
// 设计见 docs/backup-pipeline.md「传输：一个上传器，两种底层传输」里的「下载」。
import { checkBackupSpace, createBackupTempFile, isBackupTempFileSupported } from './backupTempFile';

/** 一份下载好的备份。blob 可能是磁盘上临时文件的 File，也可能是内存里的 Blob（降级时）。用完必须 dispose。 */
export interface DownloadedBackup {
    blob: Blob;
    dispose(): Promise<void>;
}

export interface BackupDownloadSink {
    /** 顺序写入一段字节，写进去才返回，调用方等它返回再取下一片。 */
    write(bytes: Uint8Array<ArrayBuffer>): Promise<void>;
}

/** 写临时文件时空间不足。换一种方式重新下载也救不了，调用方应直接报给用户。 */
export class BackupSpaceError extends Error {
    constructor() {
        super('设备存储空间不足，备份没能下载完整。请清理空间后重试。');
    }
}

/** 估算说磁盘放不下时，不超过这个大小的下载才退回内存。 */
const MEMORY_FALLBACK_LIMIT = 256 * 1024 * 1024;

const sizeMismatch = (label: string, expected: number, actual: number) =>
    new Error(`${label}大小不符（应为 ${expected} 字节，实际 ${actual} 字节）。`);

/**
 * 开一个下载汇交给 fill 顺序写入，写完核对总字节数（给了 expectedSize 才核对）。
 * 写磁盘还是写内存在开始前定好：OPFS 不可用、或文件不大且估算放不下时写内存；
 * fill 或核对失败时删掉临时文件、丢掉已收的字节，再把错误抛出去。
 */
export async function receiveBackupDownload(
    fill: (sink: BackupDownloadSink) => Promise<void>,
    expectedSize?: number,
): Promise<DownloadedBackup> {
    let received = 0;
    const checkTotal = () => {
        if (expectedSize !== undefined && received !== expectedSize) {
            throw sizeMismatch('下载的备份', expectedSize, received);
        }
    };

    // 配额估算只用来把小文件挪进内存：估算说放不下、文件又小到内存里放得下时才写内存。
    // 估算不能用来拦大文件：Safari 报的用量是随写入次数虚增的账面数（见 docs/backup-pipeline.md「平台事实」），
    // 信了它会把上 GB 的下载退回内存。大文件一律写磁盘，真放不下会在下面按空间不足报错。
    const useDisk = await isBackupTempFileSupported()
        && (expectedSize === undefined
            || expectedSize > MEMORY_FALLBACK_LIMIT
            || (await checkBackupSpace(expectedSize))?.enough !== false);
    if (!useDisk) {
        const parts: Uint8Array<ArrayBuffer>[] = [];
        await fill({
            async write(bytes) {
                parts.push(bytes);
                received += bytes.byteLength;
            },
        });
        checkTotal();
        return { blob: new Blob(parts, { type: 'application/zip' }), dispose: async () => undefined };
    }

    const temp = await createBackupTempFile('download');
    try {
        const writer = (await temp.openWritable()).getWriter();
        await fill({
            async write(bytes) {
                await writer.write(bytes);
                received += bytes.byteLength;
            },
        });
        // 先核对再关流：对不上就不提交，remove() 会中止这条流。
        checkTotal();
        await writer.close();
        // 以磁盘上的实际大小为准：浏览器的写入实现出过把多余数据写进文件的问题，只数收到的字节发现不了。
        const file = await temp.getFile();
        if (file.size !== received) throw sizeMismatch('落盘的备份', received, file.size);
        return { blob: file, dispose: () => temp.remove() };
    } catch (error: any) {
        await temp.remove().catch(() => undefined);
        throw error?.name === 'QuotaExceededError' ? new BackupSpaceError() : error;
    }
}

const toHex = (buffer: ArrayBuffer) =>
    Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');

/** 核对一片的大小和摘要，对不上就抛出写明期望值和实际值的错误。digest 缺失或不是 sha256:… 时只核对大小。 */
export async function verifyBackupPart(
    bytes: Uint8Array<ArrayBuffer>,
    expected: { label: string; size?: number; digest?: string | null },
): Promise<void> {
    if (expected.size !== undefined && bytes.byteLength !== expected.size) {
        throw sizeMismatch(expected.label, expected.size, bytes.byteLength);
    }
    const want = /^sha256:([0-9a-f]{64})$/i.exec(expected.digest || '')?.[1].toLowerCase();
    // 非安全上下文（局域网 http 调试）没有 crypto.subtle，只能核对大小。
    if (!want || !globalThis.crypto?.subtle) return;
    const actual = toHex(await crypto.subtle.digest('SHA-256', bytes));
    if (actual !== want) {
        throw new Error(`${expected.label}校验和不符（应为 sha256:${want}，实际 sha256:${actual}）。`);
    }
}
