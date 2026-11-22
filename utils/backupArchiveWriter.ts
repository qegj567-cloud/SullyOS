// 备份压缩包的流式写入：打开 → 一项一项顺序加入 → 关闭。每项交给 zip.js 压完写出就释放，不攒到最后；
// 输出直接写进 OPFS 临时文件，不可用时退回内存里的 Blob 片段。设计见 docs/backup-pipeline.md「写入：顺序写进临时文件」。
import { checkBackupSpace, createBackupTempFile, isBackupTempFileSupported, type BackupTempFile } from './backupTempFile';

export type BackupArchiveEntryData = string | Uint8Array | Blob;

export interface BackupArchiveEntryOptions {
    /** 与 createBackupArchive 的 compression 同义：STORE 不压缩，默认 DEFLATE（级别 6）。 */
    compression?: 'STORE' | 'DEFLATE';
}

export interface BackupArchiveProgress {
    /** 已写完的条目数 */
    entries: number;
    /** 已写出的压缩包字节数 */
    bytes: number;
}

/** 写完的压缩包。blob 是磁盘上临时文件的 File，或降级时内存里的 Blob。用完必须 dispose。 */
export interface BackupArchiveFile {
    blob: Blob;
    size: number;
    /** 删临时文件、放锁；内存降级时什么都不做。可重复调用。 */
    dispose(): Promise<void>;
}

export interface BackupArchiveWriter {
    /** 这次写的是 OPFS 临时文件（true）还是内存（false），打开时定下，之后不变。 */
    readonly onDisk: boolean;
    /** 加入一项，写完才返回。上一项没返回前不能加下一项；重名报错。写出失败时整次作废并删掉临时文件。 */
    add(name: string, data: BackupArchiveEntryData, options?: BackupArchiveEntryOptions): Promise<void>;
    /** 写末尾目录、关流、交回文件。之后不能再加入。 */
    close(): Promise<BackupArchiveFile>;
    /** 调用方自己中途出错时收场：作废这次写入、删掉临时文件。已关闭后调用无效（用 dispose）。 */
    abort(): Promise<void>;
}

export interface OpenBackupArchiveWriterOptions {
    /** 预估的压缩包大小，只用来决定小文件在估算放不下时改写内存；不给就按大文件处理。 */
    estimatedSize?: number;
    onProgress?: (progress: BackupArchiveProgress) => void;
}

/** 估算说放不下时，不超过这个大小的备份才退回内存（与 backupDownload 同一口径）。 */
const MEMORY_FALLBACK_LIMIT = 256 * 1024 * 1024;
/** 内存降级时的输出片段大小，与 createBackupArchive 一致。 */
const OUTPUT_PART_BYTES = 1024 * 1024;

export async function openBackupArchiveWriter(options: OpenBackupArchiveWriterOptions = {}): Promise<BackupArchiveWriter> {
    const { estimatedSize, onProgress } = options;
    const { ZipWriter, BlobReader, Uint8ArrayReader, configure } = await import('@zip.js/zip.js');
    // 显式给出打包进来的 wasm 地址，没有原生 raw DEFLATE 的浏览器也能压缩，不需要 CDN 或 worker 脚本。
    const { default: wasmURI } = await import('@zip.js/zip.js/dist/zip-module.wasm?url');
    configure({ wasmURI });

    // estimate() 在 Safari 上是随写入次数虚增的账面数，只用来把小文件挪进内存，不用来拦大文件；
    // 大文件真放不下，由写入时的配额错误报出（见 docs/backup-pipeline.md「平台事实」）。
    const onDisk = await isBackupTempFileSupported()
        && (estimatedSize === undefined
            || estimatedSize > MEMORY_FALLBACK_LIMIT
            || (await checkBackupSpace(estimatedSize))?.enough !== false);

    let written = 0;
    let temp: BackupTempFile | undefined;
    let output: WritableStream<Uint8Array<ArrayBuffer>>;
    let parts: Blob[] = [];
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const flush = () => {
        if (pendingBytes) parts.push(new Blob(pending as BlobPart[]));
        pending = [];
        pendingBytes = 0;
    };

    if (onDisk) {
        temp = await createBackupTempFile('export');
        let sink: WritableStreamDefaultWriter<BufferSource | Blob>;
        try {
            sink = (await temp.openWritable()).getWriter();
        } catch (error) {
            await temp.remove().catch(() => undefined);
            throw error;
        }
        // 等这块落盘才算写完：zip.js 等 write 返回才送下一块，内存里只有在途的几块。
        output = new WritableStream<Uint8Array<ArrayBuffer>>({
            async write(chunk) {
                await sink.write(chunk);
                written += chunk.byteLength;
            },
            close: () => sink.close(),
            abort: reason => sink.abort(reason),
        });
    } else {
        output = new WritableStream<Uint8Array<ArrayBuffer>>({
            write(chunk) {
                written += chunk.byteLength;
                for (let offset = 0; offset < chunk.byteLength;) {
                    const length = Math.min(OUTPUT_PART_BYTES - pendingBytes, chunk.byteLength - offset);
                    // 压缩库可能复用输出缓冲，留下的必须是自己的一份。
                    pending.push(chunk.slice(offset, offset + length));
                    pendingBytes += length;
                    offset += length;
                    if (pendingBytes === OUTPUT_PART_BYTES) flush();
                }
            },
        });
    }

    // bufferedWrite 关着、条目又是一项一项加，zip.js 才直接写进 output 并遵守背压；
    // 开缓冲或并发加入时它会改走一个没有上限的内存缓冲。
    const zip = new ZipWriter(output, { useWebWorkers: false, bufferedWrite: false, level: 6 });
    const names = new Set<string>();
    const encoder = new TextEncoder();
    let state: 'open' | 'busy' | 'closed' | 'failed' = 'open';
    let entries = 0;

    const fail = async () => {
        state = 'failed';
        parts = [];
        pending = [];
        pendingBytes = 0;
        await temp?.remove().catch(() => undefined);
    };
    const assertOpen = () => {
        if (state === 'busy') throw new Error('上一项还没写完，备份条目必须一项一项加入');
        if (state === 'closed') throw new Error('备份已写完，不能继续添加文件');
        if (state === 'failed') throw new Error('这次备份写入已失败，不能继续添加文件');
    };

    return {
        onDisk,
        async add(name, data, entryOptions) {
            assertOpen();
            if (names.has(name)) throw new Error(`备份文件重复：${name}`);
            names.add(name);
            state = 'busy';
            // 文字先编码成字节：JSZip 那样按码元切块编码会把跨块的 emoji 写成两半（见「平台事实」）。
            // Blob 直接作数据源，由 zip.js 边读边压，不读成 ArrayBuffer。
            const reader = data instanceof Blob
                ? new BlobReader(data)
                : new Uint8ArrayReader(typeof data === 'string' ? encoder.encode(data) : data);
            try {
                await zip.add(name, reader, { level: entryOptions?.compression === 'STORE' ? 0 : 6 });
            } catch (error) {
                await fail();
                throw error;
            }
            if (state !== 'busy') throw new Error('这次备份写入已中止');
            state = 'open';
            entries++;
            onProgress?.({ entries, bytes: written });
        },
        async close() {
            assertOpen();
            state = 'busy';
            try {
                await zip.close(); // 写末尾目录并关掉 output；不关流 OPFS 不会提交内容
                let blob: Blob;
                if (temp) {
                    blob = await temp.getFile();
                    // 以磁盘上的实际大小为准：Safari 写视图时出过多写数据的问题，只数写出的字节发现不了。
                    if (blob.size !== written) throw new Error(`写出的备份大小不符（应为 ${written} 字节，实际 ${blob.size} 字节）。`);
                } else {
                    flush();
                    blob = new Blob(parts, { type: 'application/zip' });
                    parts = [];
                }
                state = 'closed';
                onProgress?.({ entries, bytes: written });
                const own = temp;
                return { blob, size: blob.size, dispose: async () => { await own?.remove(); } };
            } catch (error) {
                await fail();
                throw error;
            }
        },
        async abort() {
            if (state === 'closed' || state === 'failed') return;
            await fail();
        },
    };
}
