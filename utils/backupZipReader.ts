/**
 * 备份压缩包的按需读取：只读末尾目录，之后按字节范围读用到的条目。
 * 接口与 JSZip 的读法同形（file(name)?.async(type)、files 遍历），恢复代码换底层时几乎不用改。
 * 设计见 docs/backup-pipeline.md「读取：按需读」。
 */
import {
    BlobReader,
    BlobWriter,
    Data64URIWriter,
    Uint8ArrayWriter,
    ZipReader,
    ERR_EOCDR_NOT_FOUND,
    type Entry,
} from '@zip.js/zip.js';
import { BackupCorruptError } from './backupFormat';

export interface BackupZipEntry {
    name: string;
    dir: boolean;
    uncompressedSize: number;
    compressedSize: number;
    async(type: 'string' | 'base64'): Promise<string>;
    async(type: 'uint8array'): Promise<Uint8Array>;
    async(type: 'blob'): Promise<Blob>;
}

export interface BackupZipReader {
    /** 含目录项，键是条目全名；与 JSZip 的 zip.files 一样可 Object.values 遍历 */
    files: Record<string, BackupZipEntry>;
    /** 目录项和不存在的条目都返回 null，与 JSZip 一致 */
    file(name: string): BackupZipEntry | null;
    /** 重读压缩包目录，确认文件本身还读得到、目录没变。读不出来按损坏抛出，读文件失败原样抛出。 */
    verify(): Promise<void>;
    close(): Promise<void>;
}

/** 包尾允许的多余数据。只有末尾目录不在文件最末时 zip.js 才会多读这么一段，正常包不受影响。 */
const MAX_APPENDED_BYTES = 1024 * 1024;

// 读文件本身失败（DOMException）和内存不足（RangeError）不是包坏了，原样抛出。
const asCorrupted = (error: unknown, what: string): unknown => (
    error instanceof DOMException || error instanceof RangeError
        ? error
        : new BackupCorruptError(`损坏的备份包：${what}`, { cause: error })
);

const describeOpenError = (error: unknown): string => {
    const { message, reason } = (error ?? {}) as { message?: string; reason?: string };
    if (reason === 'appended data') return '文件末尾有超过 1MB 的多余数据';
    if (message === ERR_EOCDR_NOT_FOUND) return '找不到压缩包目录（不是 zip 文件，或文件末尾有超过 1MB 的多余数据）';
    return '无法读取压缩包目录';
};

/** 与 JSZip 读包时的 utils.resolve 一致：去掉 `.` 和中间的空段，`..` 回退一级；目录项补尾斜杠。 */
const normalizeName = (path: string, dir: boolean): string => {
    const parts = path.split('/');
    const result: string[] = [];
    parts.forEach((part, index) => {
        if (part === '.' || (part === '' && index !== 0 && index !== parts.length - 1)) return;
        if (part === '..') result.pop();
        else result.push(part);
    });
    const name = result.join('/');
    return dir && !name.endsWith('/') ? `${name}/` : name;
};

// 代理对 CESU-8 写法的 6 个字节：高代理 ED A0-AF 80-BF，紧跟低代理 ED B0-BF 80-BF。
const PAIR_BYTE_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0xed, 0xed], [0xa0, 0xaf], [0x80, 0xbf], [0xed, 0xed], [0xb0, 0xbf], [0x80, 0xbf],
];
const pairBytesMatch = (data: Uint8Array, at: number, count: number): boolean => {
    for (let k = 0; k < count; k++) {
        const [min, max] = PAIR_BYTE_RANGES[k];
        if (data[at + k] < min || data[at + k] > max) return false;
    }
    return true;
};

/**
 * 浏览器里 JSZip 按 16K 码元切块编码字符串，跨块的 emoji 会被写成两段 3 字节的代理半（CESU-8）。
 * JSZip 读回时能拼好，严格的 TextDecoder 不能，所以解码前把这 6 字节换成标准的 4 字节 UTF-8。
 * write 逐块喂入，emit 交出修好的字节（可能是传入块的视图，须当场消费）；end 交出留着的尾巴。
 */
export const createSurrogatePairRepair = () => {
    let tail: Uint8Array | null = null;
    return {
        write(chunk: Uint8Array, emit: (part: Uint8Array) => void): void {
            let data = chunk;
            if (tail) {
                data = new Uint8Array(tail.length + chunk.length);
                data.set(tail);
                data.set(chunk, tail.length);
                tail = null;
            }
            let last = 0;
            // 正常文本里 0xED 只出现在 U+D000–U+D7FF（韩文音节等），跳着找，没命中的大段不复制。
            for (let i = data.indexOf(0xed); i !== -1; i = data.indexOf(0xed, i)) {
                const available = data.length - i;
                if (available < 6) {
                    if (pairBytesMatch(data, i, available)) {
                        if (i > last) emit(data.subarray(last, i));
                        tail = data.slice(i); // 下一块要用，必须复制
                        return;
                    }
                    i += 1;
                    continue;
                }
                if (!pairBytesMatch(data, i, 6)) { i += 1; continue; }
                const high = 0xd000 | ((data[i + 1] & 0x3f) << 6) | (data[i + 2] & 0x3f);
                const low = 0xd000 | ((data[i + 4] & 0x3f) << 6) | (data[i + 5] & 0x3f);
                const cp = 0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00);
                if (i > last) emit(data.subarray(last, i));
                emit(Uint8Array.of(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)));
                i += 6;
                last = i;
            }
            if (last < data.length) emit(last ? data.subarray(last) : data);
        },
        end(emit: (part: Uint8Array) => void): void {
            if (tail) emit(tail);
            tail = null;
        },
    };
};

/**
 * 边解压边解码，只攒字符串分片，不先拼出整块 Blob。ignoreBOM 让开头的 BOM 和 JSZip 一样保留。
 * 不成对的代理半交给 TextDecoder 变成替换字符（JSZip 会留下孤立码元，两者都不是原字符）。
 */
const readText = async (entry: Entry & { directory: false }): Promise<string> => {
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    const repair = createSurrogatePairRepair();
    const parts: string[] = [];
    const decode = (part: Uint8Array) => { parts.push(decoder.decode(part, { stream: true })); };
    await entry.getData(new WritableStream<Uint8Array>({
        write(chunk) { repair.write(chunk, decode); },
        close() { repair.end(decode); parts.push(decoder.decode()); },
    }));
    return parts.join('');
};

const readEntry = async (entry: Entry, type: 'string' | 'base64' | 'uint8array' | 'blob'): Promise<string | Uint8Array | Blob> => {
    if (entry.directory) throw new Error(`${entry.filename} 是目录`);
    try {
        switch (type) {
            case 'string': return await readText(entry);
            case 'uint8array': return await entry.getData(new Uint8ArrayWriter());
            case 'blob': return await entry.getData(new BlobWriter());
            case 'base64': {
                const uri = await entry.getData(new Data64URIWriter());
                return uri.slice(uri.indexOf(',') + 1);
            }
        }
    } catch (error) {
        throw asCorrupted(error, `${entry.filename} 读取失败或校验不符`);
    }
    throw new Error(`不支持的读取类型 ${type}`);
};

/** 必须传 File/Blob：zip.js 接到流会先把整个流缓冲进内存。 */
export async function openBackupZip(blob: Blob): Promise<BackupZipReader> {
    const options = {
        useWebWorkers: false, // 与 live2dModelStore 一致
        checkSignature: true, // 每个条目读完都核对 CRC
        filenameEncoding: 'utf-8', // 没置 UTF-8 标志位的文件名，JSZip 按 UTF-8 解，zip.js 默认是 CP437
        maxAppendedDataSize: MAX_APPENDED_BYTES,
    };
    const reader = new ZipReader(new BlobReader(blob), options);
    let entries: Entry[];
    try {
        entries = await reader.getEntries();
    } catch (error) {
        await reader.close().catch(() => {});
        throw asCorrupted(error, describeOpenError(error));
    }
    // 并发读安全（zip.js 2.8.43）：每次 getData 按自己的偏移新建一条读取流，读取器没有共享游标，超出上限的解压任务在 codec-pool 里排队。
    const files: Record<string, BackupZipEntry> = Object.create(null);
    for (const entry of entries) {
        const name = normalizeName(entry.filename, entry.directory);
        // 归一后重名时后者覆盖前者，与 JSZip 逐个 zip.file(name, …) 写入的结果一致。
        files[name] = {
            name,
            dir: entry.directory,
            uncompressedSize: entry.uncompressedSize,
            compressedSize: entry.compressedSize,
            async: ((type: 'string' | 'base64' | 'uint8array' | 'blob') => readEntry(entry, type)) as BackupZipEntry['async'],
        };
    }
    return {
        files,
        file: name => {
            const entry = files[name];
            return entry && !entry.dir ? entry : null;
        },
        verify: async () => {
            const again = new ZipReader(new BlobReader(blob), options);
            try {
                if ((await again.getEntries()).length !== entries.length) throw new Error('entry count changed');
            } catch (error) {
                throw asCorrupted(error, '压缩包目录和打开时不一致');
            } finally {
                await again.close().catch(() => {});
            }
        },
        close: () => reader.close(), // 2.8.43 里是空函数，关闭后再读也正常
    };
}
