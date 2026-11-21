import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import JSZip from 'jszip';
import { BlobReader, BlobWriter, ZipReader, ZipWriter, TextReader, TextWriter } from '@zip.js/zip.js';
import { openBackupZip, createSurrogatePairRepair } from './backupZipReader';
import { BackupCorruptError } from './backupFormat';

/** 记录被真正读走的字节数：zip.js 走 slice，整包读法走 arrayBuffer/stream/text。 */
class CountingBlob extends Blob {
    bytesRead = 0;
    slice(start = 0, end = this.size, contentType?: string): Blob {
        const from = Math.max(0, start < 0 ? this.size + start : start);
        const to = Math.min(this.size, end < 0 ? this.size + end : end);
        this.bytesRead += Math.max(0, to - from);
        return super.slice(start, end, contentType);
    }
    arrayBuffer() { this.bytesRead += this.size; return super.arrayBuffer(); }
    stream() { this.bytesRead += this.size; return super.stream(); }
    text() { this.bytesRead += this.size; return super.text(); }
}

describe('openBackupZip 按需读', () => {
    it('只读一个小条目时读走的字节约等于目录 + 该条目，远小于整包', async () => {
        const zip = new JSZip();
        const bigSize = 8 * 1024 * 1024;
        for (let i = 0; i < 5; i++) zip.file(`blobs/big${i}`, randomBytes(bigSize), { compression: 'STORE' });
        zip.file('manifest.json', JSON.stringify({ hello: '小明' }));
        const bytes = await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' });
        const blob = new CountingBlob([bytes]);
        expect(blob.size).toBeGreaterThan(40 * 1024 * 1024);

        const reader = await openBackupZip(blob);
        expect(JSON.parse(await reader.file('manifest.json')!.async('string'))).toEqual({ hello: '小明' });
        // 目录 + 本地头 + 小条目只有几 KB；zip.js 找末尾目录时会多读一段尾部，给 256KB 余量。
        expect(blob.bytesRead).toBeLessThan(256 * 1024);

        // 反证计数器能看见读取：再读一个大条目，计数至少涨一个条目大小。
        const before = blob.bytesRead;
        expect((await reader.file('blobs/big3')!.async('uint8array')).byteLength).toBe(bigSize);
        expect(blob.bytesRead - before).toBeGreaterThanOrEqual(bigSize);
        await reader.close();
    }, 30_000);
});

describe('openBackupZip 校验', () => {
    const marker = 'TAMPER-ME-0123456789';

    const tamperedZip = async () => {
        const zip = new JSZip();
        zip.file('data.json', JSON.stringify({ marker }), { compression: 'STORE' });
        zip.file('other.txt', 'ok');
        const bytes = new Uint8Array(await zip.generateAsync({ type: 'arraybuffer' }));
        const at = Buffer.from(bytes).indexOf(marker);
        expect(at).toBeGreaterThan(0);
        bytes[at] ^= 0x01;
        return new Blob([bytes]);
    };

    it('条目内容被改过时读取抛出「损坏的备份包」', async () => {
        const reader = await openBackupZip(await tamperedZip());
        await expect(reader.file('data.json')!.async('string')).rejects.toThrow(/损坏的备份包/);
        await expect(reader.file('data.json')!.async('uint8array')).rejects.toThrow(/损坏的备份包/);
        expect(await reader.file('other.txt')!.async('string')).toBe('ok');
    });

    it('同一份篡改包在不开 checkSignature 时能读出来，说明拦下它的是 CRC 校验', async () => {
        const raw = new ZipReader(new BlobReader(await tamperedZip()), { useWebWorkers: false });
        const entry = (await raw.getEntries()).find(e => e.filename === 'data.json')!;
        expect(entry.directory).toBe(false);
        if (!entry.directory) await expect(entry.getData(new TextWriter())).resolves.toContain('UAMPER-ME');
        await raw.close();
    });

    it('不是压缩包时打开就抛出「损坏的备份包」', async () => {
        await expect(openBackupZip(new Blob(['not a zip at all']))).rejects.toThrow(/损坏的备份包/);
    });

    it('包内容坏了抛 BackupCorruptError，调用方用 instanceof 判断，不靠文案', async () => {
        await expect(openBackupZip(new Blob(['not a zip at all']))).rejects.toBeInstanceOf(BackupCorruptError);
        const reader = await openBackupZip(await tamperedZip());
        const error = await reader.file('data.json')!.async('uint8array').catch(e => e);
        expect(error).toBeInstanceOf(BackupCorruptError);
        expect(error.cause).toBeDefined();
    });

    it.each([
        ['读文件失败', () => new DOMException('file is gone', 'NotReadableError')],
        ['内存不足', () => new RangeError('Array buffer allocation failed')],
    ])('%s不算包坏了：原样抛出，不是 BackupCorruptError', async (_name, makeError) => {
        const zip = new JSZip();
        zip.file('data.json', '{"ok":true}');
        const bytes = await zip.generateAsync({ type: 'arraybuffer' });
        const thrown = makeError();
        // 打开时的读取放行，之后读条目的那次失败。
        class FailingBlob extends Blob {
            failing = false;
            slice(start?: number, end?: number, contentType?: string): Blob {
                const part = super.slice(start, end, contentType);
                if (this.failing) part.arrayBuffer = () => Promise.reject(thrown);
                return part;
            }
        }
        const blob = new FailingBlob([bytes]);
        const reader = await openBackupZip(blob);
        blob.failing = true;
        const error = await reader.file('data.json')!.async('string').catch(e => e);
        expect(error).toBe(thrown);
        expect(error).not.toBeInstanceOf(BackupCorruptError);
    });
});

describe('openBackupZip 读 JSZip 写出的包', () => {
    for (const streamFiles of [false, true]) {
        it(`字符串、二进制、Blob、base64、目录项、中文文件名（streamFiles=${streamFiles}）`, async () => {
            const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 128, 7]);
            const zip = new JSZip();
            zip.file('data.json', JSON.stringify({ name: '小明', text: '你好，世界' }));
            zip.folder('assets')!.file('头像 1.png', png);
            zip.file('assets/表情包/开心.webp', png, { compression: 'STORE' });
            const blob = await zip.generateAsync({
                type: 'blob', streamFiles, compression: 'DEFLATE', compressionOptions: { level: 9 },
            });

            const reader = await openBackupZip(blob);
            expect(JSON.parse(await reader.file('data.json')!.async('string'))).toEqual({ name: '小明', text: '你好，世界' });
            expect(await reader.file('assets/头像 1.png')!.async('uint8array')).toEqual(png);
            expect(await reader.file('assets/头像 1.png')!.async('base64')).toBe(Buffer.from(png).toString('base64'));
            const asBlob = await reader.file('assets/表情包/开心.webp')!.async('blob');
            expect(new Uint8Array(await asBlob.arrayBuffer())).toEqual(png);
            expect(reader.file('assets/头像 1.png')!.uncompressedSize).toBe(png.byteLength);

            // 目录项在 files 里、dir 为 true，file() 对它返回 null；遍历写法和 JSZip 的 zip.files 一样。
            expect(reader.files['assets/']?.dir).toBe(true);
            expect(reader.file('assets/')).toBeNull();
            const assetFiles = Object.values(reader.files).filter(f => !f.dir && f.name.startsWith('assets/'));
            expect(assetFiles.map(f => f.name).sort()).toEqual(['assets/头像 1.png', 'assets/表情包/开心.webp']);
            await reader.close();
        });
    }

    it('条目不存在时 file() 返回 null，可走 ?.async(...) ?? null', async () => {
        const zip = new JSZip();
        zip.file('manifest.json', '{}');
        const reader = await openBackupZip(await zip.generateAsync({ type: 'blob' }));
        expect(reader.file('user-spaces.json')).toBeNull();
        expect(await (reader.file('assets/missing.png')?.async('uint8array') ?? null)).toBeNull();
        await reader.close();
    });
});

describe('openBackupZip 读 zip.js 写出的包', () => {
    const text = '你好，小明 👋 '.repeat(2000);
    const write = async (options: ConstructorParameters<typeof ZipWriter>[1]) => {
        const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false, ...options });
        await writer.add('stores/messages.000.json', new TextReader(text));
        await writer.add('blobs/img_1', new BlobReader(new Blob([new Uint8Array([1, 2, 3, 4])])), { level: 0 });
        return writer.close();
    };

    it.each([
        ['zip64', { zip64: true }],
        ['带 data descriptor', { dataDescriptor: true }],
        ['zip64 且带 data descriptor', { zip64: true, dataDescriptor: true }],
    ] as const)('%s 的包能读，内容和大小都对', async (_name, options) => {
        const reader = await openBackupZip(await write(options));
        expect(await reader.file('stores/messages.000.json')!.async('string')).toBe(text);
        expect(await reader.file('blobs/img_1')!.async('uint8array')).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(reader.file('blobs/img_1')!.uncompressedSize).toBe(4);
        await reader.verify();
        await reader.close();
    });
});

describe('openBackupZip verify', () => {
    it('文件还在时通过；文件内容变成全零后按损坏抛出', async () => {
        const zip = new JSZip();
        zip.file('data.json', '{"ok":true}');
        class VanishingBlob extends Blob {
            gone = false;
            slice(start?: number, end?: number, contentType?: string): Blob {
                const part = super.slice(start, end, contentType);
                return this.gone ? new Blob([new Uint8Array(part.size)]) : part;
            }
        }
        const blob = new VanishingBlob([await zip.generateAsync({ type: 'arraybuffer' })]);
        const reader = await openBackupZip(blob);
        await expect(reader.verify()).resolves.toBeUndefined();
        blob.gone = true;
        await expect(reader.verify()).rejects.toBeInstanceOf(BackupCorruptError);
    });
});

describe('openBackupZip 与 JSZip 读包行为对齐', () => {
    it('没置 UTF-8 标志位的中文文件名按 UTF-8 解', async () => {
        const writer = new ZipWriter(new BlobWriter(), { useUnicodeFileNames: false, useWebWorkers: false });
        await writer.add('素材/头像.json', new TextReader('{"ok":true}'));
        const blob = await writer.close();
        // 先确认样本真的没带标志位和 Unicode 路径字段：zip.js 默认（CP437）会解成乱码。
        const raw = new ZipReader(new BlobReader(blob), { useWebWorkers: false });
        expect((await raw.getEntries())[0].filename).not.toBe('素材/头像.json');

        const reader = await openBackupZip(blob);
        expect(Object.keys(reader.files)).toContain('素材/头像.json');
        expect(await reader.file('素材/头像.json')!.async('string')).toBe('{"ok":true}');
    });

    it('条目名按 JSZip 的规则归一（./、重复斜杠、..）', async () => {
        const zip = new JSZip();
        zip.file('./dot/a.json', 'a');
        zip.file('x//y/./z/../b.txt', 'b');
        const bytes = await zip.generateAsync({ type: 'uint8array' });
        const reader = await openBackupZip(new Blob([bytes as Uint8Array<ArrayBuffer>]));
        expect(await reader.file('dot/a.json')!.async('string')).toBe('a');
        expect(await reader.file('x/y/b.txt')!.async('string')).toBe('b');
        expect(Object.keys(reader.files).sort()).toEqual(Object.keys((await JSZip.loadAsync(bytes)).files).sort());
    });

    it('string 保留开头的 BOM，跨分块的多字节字符不被切坏，结果与 JSZip 一致', async () => {
        const text = '﻿' + JSON.stringify({ rows: Array.from({ length: 30000 }, (_, i) => `第${i}条：你好`) });
        // 不放 emoji：Node 下 JSZip 用 Buffer 按 16K 码元切块编码，跨块的代理对直接写成 U+FFFD，读侧无从还原（浏览器路径见下面的用例）。
        const zip = new JSZip();
        zip.file('data.json', text);
        const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
        const reader = await openBackupZip(new Blob([bytes as Uint8Array<ArrayBuffer>]));
        const got = await reader.file('data.json')!.async('string');
        expect(got.charCodeAt(0)).toBe(0xfeff);
        expect(got).toBe(text);
        expect(got).toBe(await (await JSZip.loadAsync(bytes)).file('data.json')!.async('string'));
    });

    const withTail = async (tailBytes: number) => {
        const zip = new JSZip();
        zip.file('manifest.json', '{"v":1}');
        const bytes = await zip.generateAsync({ type: 'arraybuffer' });
        return new Blob([bytes, new Uint8Array(tailBytes).fill(7)]);
    };

    it('包尾追加 200KB 数据仍能打开', async () => {
        const reader = await openBackupZip(await withTail(200 * 1024));
        expect(await reader.file('manifest.json')!.async('string')).toBe('{"v":1}');
    });

    it('包尾多余数据超过 1MB 时拒绝，文案指出末尾有多余数据', async () => {
        await expect(openBackupZip(await withTail(1024 * 1024 + 10 * 1024))).rejects.toThrow(/损坏的备份包：文件末尾有超过 1MB 的多余数据/);
        await expect(openBackupZip(await withTail(3 * 1024 * 1024))).rejects.toThrow(/多余数据/);
    });
});

describe('openBackupZip 错误分类', () => {
    /** 打开之后让条目读取失败，模拟读文件出错或内存分配失败。 */
    class FailingBlob extends Blob {
        failWith: Error | null = null;
        slice(start?: number, end?: number, contentType?: string): Blob {
            const part = super.slice(start, end, contentType);
            const error = this.failWith;
            if (!error) return part;
            return Object.assign(part, {
                arrayBuffer: () => Promise.reject(error),
                stream: () => new ReadableStream({ pull(controller) { controller.error(error); } }),
            });
        }
    }

    const openFailing = async (error: Error) => {
        const zip = new JSZip();
        zip.file('data.json', '{}');
        const blob = new FailingBlob([await zip.generateAsync({ type: 'arraybuffer' })]);
        const reader = await openBackupZip(blob);
        blob.failWith = error;
        return reader.file('data.json')!;
    };

    it('DOMException（文件读不了）原样抛出，不包成损坏', async () => {
        const error = new DOMException('file gone', 'NotReadableError');
        const entry = await openFailing(error);
        await expect(entry.async('string')).rejects.toBe(error);
        await expect(entry.async('uint8array')).rejects.toBe(error);
    });

    it('RangeError（内存不足）原样抛出，不包成损坏', async () => {
        const error = new RangeError('Array buffer allocation failed');
        const entry = await openFailing(error);
        await expect(entry.async('string')).rejects.toBe(error);
        await expect(entry.async('blob')).rejects.toBe(error);
    });
});

describe('JSZip 浏览器写法里跨 16K 块的 emoji', () => {
    it('async(\'string\') 把 CESU-8 代理对还原成原字符，与 JSZip 浏览器路径读出的一致', async () => {
        const original = JSZip.support.nodebuffer;
        // 关掉 Buffer 让 JSZip 走浏览器里的 string2buf / buf2string。
        JSZip.support.nodebuffer = false;
        try {
            let text = '';
            const pool = ['a', '中', '한', '😀', '🙂'];
            for (let n = 0; text.length < 400_000; n++) {
                // 在每个 16K 块的最后一个码元处放 emoji，让代理对正好被切开；其余位置混着普通字符和 emoji。
                text += text.length % 16384 === 16383 ? '😀' : pool[n % pool.length];
            }
            const zip = new JSZip();
            zip.file('data.json', text, { compression: 'STORE' });
            const bytes = await zip.generateAsync({ type: 'uint8array' });
            expect(Buffer.from(bytes).indexOf(Buffer.from([0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80]))).toBeGreaterThan(0);

            const reader = await openBackupZip(new Blob([bytes as Uint8Array<ArrayBuffer>]));
            const got = await reader.file('data.json')!.async('string');
            expect(got === text).toBe(true);
            expect(got === await (await JSZip.loadAsync(bytes)).file('data.json')!.async('string')).toBe(true);
            // 只修 string，字节读法原样返回。
            expect(Buffer.from(await reader.file('data.json')!.async('uint8array')).indexOf(0xed)).toBeGreaterThan(0);
        } finally {
            JSZip.support.nodebuffer = original;
        }
    });

    it('修复器：序列在任何位置被切成两块都能还原，邻近的中文、4 字节 emoji、ED 8x-9x 的韩文不受影响', () => {
        const enc = (s: string) => new TextEncoder().encode(s);
        const cesuPair = Uint8Array.of(0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80); // 😀 的 CESU-8 写法
        const loneHigh = Uint8Array.of(0xed, 0xa0, 0xbd); // 不成对：照常交给 TextDecoder 变替换字符
        const input = new Uint8Array([
            ...enc('中'), ...cesuPair, ...enc('🙂힣'), ...cesuPair, ...cesuPair, ...enc('힣'), ...loneHigh, ...enc('x'),
        ]);
        const expected = new TextDecoder().decode(new Uint8Array([
            ...enc('中😀🙂힣😀😀힣'), ...loneHigh, ...enc('x'),
        ]));
        const run = (chunks: Uint8Array[]) => {
            const repair = createSurrogatePairRepair();
            const out: number[] = [];
            const emit = (part: Uint8Array) => { out.push(...part); };
            for (const chunk of chunks) repair.write(chunk, emit);
            repair.end(emit);
            return new TextDecoder().decode(Uint8Array.from(out));
        };
        expect(run([input])).toBe(expected);
        for (let cut = 0; cut <= input.length; cut++) {
            expect(run([input.slice(0, cut), input.slice(cut)])).toBe(expected);
        }
        // 尾巴跨三块：序列被拆成 1 + 1 + 4 字节。
        const at = enc('中').length;
        expect(run([input.slice(0, at + 1), input.slice(at + 1, at + 2), input.slice(at + 2)])).toBe(expected);
    });
});
