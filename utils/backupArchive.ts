import type { ZipFileWriter } from './backupFormat';

type FileOptions = Parameters<ZipFileWriter['file']>[2];
const OUTPUT_PART_BYTES = 1024 * 1024;

/** Stage inputs as browser-owned Blobs, then read/compress one entry at a time.
 * The final archive is composed of Blob parts, never concatenated into one huge
 * Uint8Array. Blob storage still costs memory/disk; this bounds JS byte buffers,
 * not total browser memory. The ZIP contents remain readable by old importers. */
export function createBackupArchive() {
    const entries = new Map<string, { blob: Blob; options?: FileOptions }>();
    let started = false;

    const fileBlob = (name: string, blob: Blob, options?: FileOptions) => {
        if (started) throw new Error('备份已开始压缩，不能继续添加文件');
        if (entries.has(name)) throw new Error(`备份文件重复：${name}`);
        entries.set(name, { blob, options });
    };
    const file: ZipFileWriter['file'] = (name, data, options) => {
        if (options?.base64 && typeof data === 'string') {
            // Decode in aligned 64 KiB pieces instead of materializing a complete
            // image as a binary string and a second Uint8Array at the same time.
            const pieces: Blob[] = [];
            for (let offset = 0; offset < data.length; offset += 65536) {
                const decoded = atob(data.slice(offset, offset + 65536));
                const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
                pieces.push(new Blob([bytes]));
            }
            fileBlob(name, new Blob(pieces), options);
        } else {
            fileBlob(name, new Blob([data as BlobPart]), options);
        }
    };

    return {
        file,
        fileBlob,
        folder: (prefix: string) => ({
            file: (name: string, data: string | Uint8Array, options?: FileOptions) => file(`${prefix}/${name}`, data, options),
        }),
        async generateBlob(onProgress?: (metadata: { percent: number }) => void): Promise<Blob> {
            if (started) throw new Error('这份备份已生成，不能重复压缩');
            started = true;
            const parts: Blob[] = [];
            let pending: Uint8Array[] = [];
            let pendingBytes = 0;
            const flush = () => {
                if (pendingBytes) parts.push(new Blob(pending as BlobPart[]));
                pending = [];
                pendingBytes = 0;
            };
            try {
                const { ZipWriter, BlobReader, configure } = await import('@zip.js/zip.js');
                // Explicit bundled URL also supports browsers without native raw
                // DEFLATE. No CDN, worker script, or relative runtime fetch needed.
                const { default: wasmURI } = await import('@zip.js/zip.js/dist/zip-module.wasm?url');
                configure({ wasmURI });
                const output = new WritableStream<Uint8Array>({
                    write(chunk) {
                        for (let offset = 0; offset < chunk.byteLength;) {
                            const length = Math.min(OUTPUT_PART_BYTES - pendingBytes, chunk.byteLength - offset);
                            // Own the bytes: compression libraries may reuse their output buffers.
                            pending.push(chunk.slice(offset, offset + length));
                            pendingBytes += length;
                            offset += length;
                            if (pendingBytes === OUTPUT_PART_BYTES) flush();
                        }
                    },
                });
                const writer = new ZipWriter(output, { useWebWorkers: false, bufferedWrite: false, level: 6 });
                const total = [...entries.values()].reduce((sum, entry) => sum + Math.max(1, entry.blob.size), 0);
                let done = 0;
                try {
                    for (const [name, entry] of entries) {
                        entries.delete(name);
                        const size = Math.max(1, entry.blob.size);
                        await writer.add(name, new BlobReader(entry.blob), {
                            level: entry.options?.compression === 'STORE' ? 0 : 6,
                            onprogress: (loaded, maximum) => {
                                onProgress?.({ percent: total ? 100 * (done + size * (maximum ? loaded / maximum : 1)) / total : 100 });
                            },
                        });
                        done += size;
                        // Give UI/GC a chance between files without parallel compression buffers.
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                    await writer.close();
                } catch (error) {
                    await writer.close().catch(() => {});
                    throw error;
                }
                flush();
                onProgress?.({ percent: 100 });
                return new Blob(parts, { type: 'application/zip' });
            } finally {
                entries.clear();
                parts.length = 0;
                pending = [];
            }
        },
    };
}
