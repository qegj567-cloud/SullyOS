import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

// 假临时文件：每次写入隔一拍才落盘（模拟磁盘 IO），可整体暂停；落盘时复制一份，原片即可释放。
const temp = vi.hoisted(() => ({
    supported: true,
    space: null as { enough: boolean; available: number } | null,
    failAfterWrites: Infinity,
    gate: null as Promise<void> | null,
    persisted: 0,
    files: [] as Array<{ chunks: Uint8Array[]; closed: boolean; removed: boolean }>,
    onWrite: undefined as (() => void) | undefined,
}));
vi.mock('./backupTempFile', () => ({
    isBackupTempFileSupported: async () => temp.supported,
    checkBackupSpace: async () => temp.space,
    createBackupTempFile: async () => {
        const state = { chunks: [] as Uint8Array[], closed: false, removed: false };
        temp.files.push(state);
        let writes = 0;
        return {
            name: 'export-test.tmp',
            async openWritable() {
                return new WritableStream<Uint8Array>({
                    async write(chunk) {
                        temp.onWrite?.();
                        if (temp.gate) await temp.gate;
                        await new Promise(resolve => setTimeout(resolve, 0));
                        if (++writes > temp.failAfterWrites) {
                            throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
                        }
                        state.chunks.push(chunk.slice());
                        temp.persisted += chunk.byteLength;
                    },
                    close() { state.closed = true; },
                });
            },
            async getFile() {
                if (!state.closed) throw new Error('getFile before close');
                return new File(state.chunks as BlobPart[], 'export-test.tmp');
            },
            async remove() { state.removed = true; },
        };
    },
}));

import { openBackupArchiveWriter } from './backupArchiveWriter';
import { openBackupZip } from './backupZipReader';

/**
 * 数据源：记录 zip.js 实际从里面拉走了多少字节、第一次被拉是什么时候。
 * 按 64KB 一块往外给，和浏览器的 Blob.stream() 相当；Node 的 Blob.stream() 会把整段缓冲一次给出，量不出背压。
 */
class CountingBlob extends Blob {
    pulled = 0;
    onFirstPull?: () => void;
    stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
        return new ReadableStream<Uint8Array<ArrayBuffer>>({
            pull: async controller => {
                if (!this.pulled) this.onFirstPull?.();
                if (this.pulled >= this.size) { controller.close(); return; }
                const piece = new Uint8Array(await this.slice(this.pulled, this.pulled + 64 * 1024).arrayBuffer());
                this.pulled += piece.byteLength;
                controller.enqueue(piece);
            },
        }, { highWaterMark: 0 });
    }
}

const MB = 1024 * 1024;
const macrotask = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
    temp.supported = true;
    temp.space = null;
    temp.failAfterWrites = Infinity;
    temp.gate = null;
    temp.persisted = 0;
    temp.files = [];
    temp.onWrite = undefined;
});

describe('写入器有界', () => {
    // 读走但还没落盘的字节 = zip.js 内部各级缓冲 + 交给输出未写完的部分。无上限缓冲时，
    // 输出一暂停它就会把整个 16MB 数据源读进内存；守住背压时只差几块。
    const IN_FLIGHT_LIMIT = 2 * MB;

    it.each(['STORE', 'DEFLATE'] as const)('%s：输出暂停或变慢时，读走未落盘的字节不超过上限', async compression => {
        const writer = await openBackupArchiveWriter();
        const source = new CountingBlob([randomBytes(16 * MB)]); // 随机数据压不动，DEFLATE 输入输出也近似等长
        let peak = 0;
        // 先放它写过 4MB 再卡住输出：一开始就卡的话 zip.js 停在写本地头那一步，还没开始读数据源。
        let release!: () => void;
        let paused!: () => void;
        const pausedOnce = new Promise<void>(resolve => { paused = resolve; });
        temp.onWrite = () => {
            peak = Math.max(peak, source.pulled - temp.persisted);
            if (temp.persisted > 4 * MB && !release) {
                temp.gate = new Promise<void>(resolve => { release = resolve; });
                paused();
            }
        };
        const adding = writer.add('big.bin', source, { compression });
        await pausedOnce;
        const pulledAtPause = source.pulled;
        for (let i = 0; i < 50; i++) await macrotask(); // 输出卡住期间给 zip.js 足够多的机会往前读
        const pulledWhilePaused = source.pulled - temp.persisted;
        temp.gate = null;
        release();
        await adding;

        expect(pulledAtPause).toBeGreaterThan(4 * MB);
        expect(pulledWhilePaused).toBeLessThan(IN_FLIGHT_LIMIT);
        expect(peak).toBeLessThan(IN_FLIGHT_LIMIT);
        expect(source.pulled).toBe(16 * MB);
        await (await writer.close()).dispose();
    }, 60_000);
});

describe('条目顺序加入', () => {
    it('上一项没写完时加下一项直接报错；下一项开始读时上一项已全部落盘', async () => {
        const writer = await openBackupArchiveWriter();
        const first = new CountingBlob([randomBytes(3 * MB)]);
        const second = new CountingBlob([randomBytes(MB)]);
        let persistedWhenSecondStarted = -1;
        second.onFirstPull = () => { persistedWhenSecondStarted = temp.persisted; };

        const adding = writer.add('a.bin', first, { compression: 'STORE' });
        await expect(writer.add('b.bin', second, { compression: 'STORE' })).rejects.toThrow('一项一项');
        await adding;
        const afterFirst = temp.persisted;
        await writer.add('b.bin', second, { compression: 'STORE' });

        expect(afterFirst).toBeGreaterThan(3 * MB);
        // 后一项开始读数据时，前一项的数据和描述符都已落盘（中间只多了后一项自己的本地头）
        expect(persistedWhenSecondStarted).toBeGreaterThanOrEqual(afterFirst);
        const archive = await writer.close();
        const reader = await openBackupZip(archive.blob);
        expect(Object.keys(reader.files)).toEqual(['a.bin', 'b.bin']);
    }, 30_000);
});

describe('往返', () => {
    const FOUR_MB = 4 * MB;
    // 多字节字符跨在 4MB（按 UTF-8 字节）边界上；另有一个 emoji 跨在 JSZip 的 16K 码元切块边界上。
    const straddling = 'a'.repeat(FOUR_MB - 1) + '中' + 'b'.repeat(10) + '😀';
    const chunkEdge = 'x'.repeat(16 * 1024 - 1) + '😀👍🏽' + '小明的备份';

    it.each(['STORE', 'DEFLATE'] as const)('%s：文字与二进制逐字节一致，压缩包可由读取适配层读回', async compression => {
        const progress: Array<{ entries: number; bytes: number }> = [];
        const writer = await openBackupArchiveWriter({ onProgress: p => progress.push(p) });
        expect(writer.onDisk).toBe(true);
        const bytes = Uint8Array.from({ length: 2 * MB + 7 }, (_, i) => (i * 13 + (i >>> 8)) & 255);
        const blobBytes = randomBytes(MB + 3);

        await writer.add('spaces/a/messages.0.json', straddling, { compression });
        await writer.add('stores/中文路径.json', chunkEdge, { compression });
        await writer.add('shared/u8.bin', bytes, { compression });
        await writer.add('shared/blob.bin', new Blob([blobBytes]), { compression });
        await writer.add('empty.txt', '', { compression });
        const archive = await writer.close();

        expect(temp.files).toHaveLength(1);
        expect(archive.size).toBe(archive.blob.size);
        expect(archive.size).toBe(temp.persisted);
        const reader = await openBackupZip(archive.blob);
        expect(await reader.file('spaces/a/messages.0.json')!.async('string')).toBe(straddling);
        expect(await reader.file('stores/中文路径.json')!.async('string')).toBe(chunkEdge);
        expect(await reader.file('shared/u8.bin')!.async('uint8array')).toEqual(bytes);
        expect(Buffer.from(await reader.file('shared/blob.bin')!.async('uint8array')).equals(blobBytes)).toBe(true);
        expect(await reader.file('empty.txt')!.async('string')).toBe('');
        if (compression === 'DEFLATE') expect(reader.files['spaces/a/messages.0.json'].compressedSize).toBeLessThan(FOUR_MB / 10);
        else expect(reader.files['shared/u8.bin'].compressedSize).toBe(bytes.byteLength);

        expect(progress.map(p => p.entries)).toEqual([1, 2, 3, 4, 5, 5]);
        expect(progress.every((p, i) => !i || p.bytes >= progress[i - 1].bytes)).toBe(true);
        expect(progress.at(-1)!.bytes).toBe(archive.size);

        expect(temp.files[0].removed).toBe(false);
        await archive.dispose();
        expect(temp.files[0].removed).toBe(true);
    }, 60_000);
});

describe('写到一半出错', () => {
    it('输出报错：add 抛出原始错误，临时文件被删，之后不能再加入或关闭', async () => {
        temp.failAfterWrites = 3;
        const writer = await openBackupArchiveWriter();
        const failure = writer.add('big.bin', new Blob([randomBytes(2 * MB)]), { compression: 'STORE' });

        await expect(failure).rejects.toMatchObject({ name: 'QuotaExceededError', message: 'The quota has been exceeded.' });
        expect(temp.files[0].removed).toBe(true);
        await expect(writer.add('next.json', '{}')).rejects.toThrow('已失败');
        await expect(writer.close()).rejects.toThrow('已失败');
    }, 30_000);

    it('调用方自己出错时 abort 删掉临时文件', async () => {
        const writer = await openBackupArchiveWriter();
        await writer.add('a.json', '{}');
        await writer.abort();
        expect(temp.files[0].removed).toBe(true);
        await expect(writer.add('b.json', '{}')).rejects.toThrow('已失败');
    });
});

describe('降级判定', () => {
    const writeSmall = async () => {
        const writer = await openBackupArchiveWriter({ estimatedSize: 1000 });
        await writer.add('user-spaces.json', '{"format":"sully-user-spaces","name":"小明😀"}');
        await writer.add('shared/x.bin', new Blob([new Uint8Array([1, 2, 3])]), { compression: 'STORE' });
        return { writer, archive: await writer.close() };
    };

    it('OPFS 不可用时写内存，结果可读，dispose 不出错', async () => {
        temp.supported = false;
        const { writer, archive } = await writeSmall();

        expect(writer.onDisk).toBe(false);
        expect(temp.files).toHaveLength(0);
        expect(archive.blob.type).toBe('application/zip');
        const reader = await openBackupZip(archive.blob);
        expect(JSON.parse(await reader.file('user-spaces.json')!.async('string')).name).toBe('小明😀');
        expect(Array.from(await reader.file('shared/x.bin')!.async('uint8array'))).toEqual([1, 2, 3]);
        await expect(archive.dispose()).resolves.toBeUndefined();
    });

    it('估算放不下的小文件写内存，放不下的大文件照样写磁盘，估算未知写磁盘', async () => {
        temp.space = { enough: false, available: 10 };
        expect((await writeSmall()).writer.onDisk).toBe(false);
        expect(temp.files).toHaveLength(0);

        const big = await openBackupArchiveWriter({ estimatedSize: 300 * MB });
        expect(big.onDisk).toBe(true);
        await big.abort();

        temp.space = null;
        expect((await writeSmall()).writer.onDisk).toBe(true);
    });
});

it('重名条目报错，不影响继续写', async () => {
    const writer = await openBackupArchiveWriter();
    await writer.add('x.json', 'original');
    await expect(writer.add('x.json', 'overwritten')).rejects.toThrow('备份文件重复：x.json');
    await writer.add('y.json', 'next');
    const reader = await openBackupZip((await writer.close()).blob);
    expect(await reader.file('x.json')!.async('string')).toBe('original');
    expect(await reader.file('y.json')!.async('string')).toBe('next');
    await expect(writer.add('z.json', 'late')).rejects.toThrow('已写完');
});
