// 备份临时文件的生命周期：OPFS 的 backup-tmp/ 目录、同名 Web Lock、残留清理、配额预判、屏幕常亮。
// 约定：临时文件从创建起一直持锁，直到 remove() 或页面关闭（浏览器自动放锁）；没被锁住的文件一律视为残留，清理直接删。
// 调用方写完必须先关流再 getFile()，否则 OPFS 不会提交内容。设计见 docs/backup-pipeline.md「临时文件」。

const DIR = 'backup-tmp';

export type BackupTempPurpose = 'export' | 'download';

export interface BackupTempFile {
    readonly name: string;
    /** 顺序写入用的流（交给 zip.js 或分片下载）。只能调用一次。 */
    openWritable(): Promise<WritableStream<BufferSource | Blob>>;
    /** 关流后读回，供 ZipReader 按需读或切片上传。 */
    getFile(): Promise<File>;
    /** 中止没关的流、删文件、放锁。用完或写到一半出错都用它收场。 */
    remove(): Promise<void>;
}

const lockName = (name: string) => `${DIR}/${name}`;
const hasOpfsAndLocks = () =>
    typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory && !!navigator.locks?.request;

let support: Promise<boolean> | undefined;

/** 页面里能否写 OPFS 临时文件：实际建、写、读、删一个小文件。结果在页面生命周期内缓存。 */
export function isBackupTempFileSupported(): Promise<boolean> {
    support ??= probe();
    return support;
}

async function probe(): Promise<boolean> {
    // 没有 Web Locks 就当不支持：没锁的文件会被清理当成残留删掉（有 createWritable 的浏览器实际都有 locks）。
    if (!hasOpfsAndLocks()) return false;
    let temp: BackupTempFile | undefined;
    try {
        temp = await createTempFile('probe');
        const writer = (await temp.openWritable()).getWriter();
        await writer.write(new Uint8Array(4));
        await writer.close();
        return (await temp.getFile()).size === 4;
    } catch {
        return false;
    } finally {
        await temp?.remove().catch(() => undefined);
    }
}

/** 在 backup-tmp/ 新建临时文件并持有同名锁。先用 isBackupTempFileSupported 探测。 */
export function createBackupTempFile(purpose: BackupTempPurpose): Promise<BackupTempFile> {
    return createTempFile(purpose);
}

async function createTempFile(prefix: string): Promise<BackupTempFile> {
    const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
    // 先拿锁再建文件：否则别的标签页的清理可能在两步之间把它当残留删掉。
    let unlock!: () => void;
    await new Promise<void>((acquired, fail) => {
        navigator.locks.request(lockName(name), () => {
            acquired();
            return new Promise<void>(resolve => { unlock = resolve; });
        }).catch(fail);
    });

    let dir: FileSystemDirectoryHandle;
    let fileHandle: FileSystemFileHandle;
    try {
        dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
        fileHandle = await dir.getFileHandle(name, { create: true });
    } catch (error) {
        unlock();
        throw error;
    }

    let writer: WritableStreamDefaultWriter<FileSystemWriteChunkType> | undefined;
    return {
        name,
        async openWritable() {
            if (writer) throw new Error('backup temp file is already open for writing');
            writer = (await fileHandle.createWritable()).getWriter();
            const own = writer;
            // 自己握着底层 writer：zip.js 会锁住交给它的流，任务在别处失败时只有这样还能 abort 掉它、放开文件。
            return new WritableStream<BufferSource | Blob>({
                write: chunk => own.write(chunk),
                close: () => own.close(),
                abort: reason => own.abort(reason),
            });
        },
        getFile: () => fileHandle.getFile(),
        async remove() {
            try {
                await writer?.abort().catch(() => undefined);
                await dir.removeEntry(name).catch(() => undefined);
            } finally {
                unlock();
            }
        },
    };
}

/** 删掉 backup-tmp/ 里所有此刻没被任何标签页锁住的文件。供启动时调用，可多个标签页同时跑。 */
export async function cleanupBackupTempFiles(): Promise<void> {
    // 没有 locks 就判断不了文件是否在用，一个都不删。
    if (!hasOpfsAndLocks()) return;
    let dir: FileSystemDirectoryHandle;
    try {
        dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR);
    } catch {
        return;
    }
    // lib.dom 没带 DOM.AsyncIterable，目录遍历的类型手动补。
    const entries = (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values();
    const names: string[] = [];
    for await (const entry of entries) if (entry.kind === 'file') names.push(entry.name);

    for (const name of names) {
        try {
            await navigator.locks.request(lockName(name), { ifAvailable: true }, async lock => {
                if (lock) await dir.removeEntry(name);
            });
        } catch {
            // 另一个标签页的清理先删了（NotFound）或单个文件删不掉，都不影响其他文件。
        }
    }
}

/** 预判剩余配额够不够 neededBytes。estimate 只是配额减已用量，不是磁盘真实剩余；接口不可用时返回 null（未知）。 */
export async function checkBackupSpace(neededBytes: number): Promise<{ enough: boolean; available: number } | null> {
    try {
        const { quota, usage } = (await navigator.storage?.estimate?.()) ?? {};
        if (quota === undefined || usage === undefined) return null;
        const available = Math.max(0, quota - usage);
        return { enough: available >= neededBytes, available };
    } catch {
        return null;
    }
}

/** 长任务期间保持屏幕常亮，切回前台时重新申请；结束（含抛错）后释放。不支持或被拒就照常执行。 */
export async function withScreenWakeLock<T>(task: () => Promise<T>): Promise<T> {
    let sentinel: WakeLockSentinel | undefined;
    let finished = false;
    const acquire = async () => {
        if (sentinel && !sentinel.released) return;
        try {
            const next = await navigator.wakeLock?.request('screen');
            if (finished) await next?.release();
            else sentinel = next;
        } catch {
            // 页面不可见、权限策略拒绝等，静默继续。
        }
    };
    // 页面进后台时系统会收回 wake lock，回到可见要重新申请。
    const onVisibilityChange = () => {
        if (document.visibilityState === 'visible') void acquire();
    };
    const doc = typeof document !== 'undefined' ? document : undefined;
    await acquire();
    doc?.addEventListener('visibilitychange', onVisibilityChange);
    try {
        return await task();
    } finally {
        finished = true;
        doc?.removeEventListener('visibilitychange', onVisibilityChange);
        await sentinel?.release().catch(() => undefined);
    }
}
