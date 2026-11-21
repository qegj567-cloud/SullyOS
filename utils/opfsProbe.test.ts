import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureFileReads, runOpfsAppendStress, runOpfsProbe, type ProbeStep } from './opfsProbe';

function fakeStorage(readBack: (written: Uint8Array<ArrayBuffer>) => Blob) {
    let written = new Uint8Array();
    const handle = {
        createWritable: async () => ({
            write: async (data: Uint8Array<ArrayBuffer>) => { written = data; },
            close: async () => undefined,
        }),
        getFile: async () => readBack(written),
    };
    const removeEntry = vi.fn(async () => undefined);
    return {
        removeEntry,
        storage: {
            estimate: async () => ({ quota: 1000, usage: 10 }),
            getDirectory: async () => ({
                getFileHandle: async () => handle,
                removeEntry,
                getDirectoryHandle: async () => ({
                    async *entries() { yield ['download-1-abc.tmp', { kind: 'file', getFile: async () => new Blob(['12345']) }]; },
                }),
            }),
        },
    };
}

afterEach(() => vi.unstubAllGlobals());

describe('runOpfsProbe', () => {
    it('环境里没有 OPFS 时返回不可用而不抛错', async () => {
        vi.stubGlobal('navigator', { userAgent: 'test', storage: {} });
        const result = await runOpfsProbe();
        expect(result.getDirectory.ok).toBe(false);
        expect(result.getDirectory.error).toContain('getDirectory 不存在');
        expect(result.write.ok).toBe(false);
    });

    it('读回内容和写入不一致时如实标出', async () => {
        // 模拟读回被截成一半
        const { storage, removeEntry } = fakeStorage((written) => new Blob([written.slice(0, written.length / 2)]));
        vi.stubGlobal('navigator', { userAgent: 'test', storage });
        const result = await runOpfsProbe();
        expect(result.write.ok).toBe(true);
        expect(result.readBack.ok).toBe(false);
        expect(result.readBack.size).toBe((result.readBack.expectedSize as number) / 2);
        expect(result.readBack.checksum).not.toBe(result.readBack.expectedChecksum);
        expect(removeEntry).toHaveBeenCalled();
    });

    it('读回一致时通过，没给上传方式就不发请求', async () => {
        const { storage } = fakeStorage((written) => new Blob([written]));
        vi.stubGlobal('navigator', { userAgent: 'test', storage });
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const result = await runOpfsProbe();
        expect(result.readBack.ok).toBe(true);
        expect((result.upload as ProbeStep).skipped).toBe(true);
        expect(result.backupTmp.entries).toEqual([{ name: 'download-1-abc.tmp', size: 5 }]);
        expect(result.appendWrites).toMatchObject({ ok: true, writes: 16, written: 16 * 1024 * 1024, exact: { usageGrowth: 0 }, view: { usageGrowth: 0 } });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('原文件、整段切片、部分切片各交给上传方式一次，结果各记各的', async () => {
        const { storage } = fakeStorage((written) => new Blob([written]));
        vi.stubGlobal('navigator', { userAgent: 'test', storage });
        const sent: Array<[string, number]> = [];
        const result = await runOpfsProbe({
            via: 'fake',
            send: async (mode, body) => {
                sent.push([mode, body.size]);
                // 模拟 319985：原文件对象发出去是 0 字节
                return mode === 'file' ? { ok: false, message: '云端 0 字节' } : { ok: true };
            },
        });
        const size = result.readBack.expectedSize as number;
        expect(sent).toEqual([['file', size], ['slice-whole', size], ['slice-part', 1024 * 1024]]);
        const upload = result.upload as Record<string, ProbeStep>;
        expect(upload.file.ok).toBe(false);
        expect(upload.sliceWhole.ok).toBe(true);
        expect(result.uploadVia).toBe('fake');
    });

    it('压力测试写满指定次数后删掉文件；写入被拒绝时停下并记下原因', async () => {
        const { storage, removeEntry } = fakeStorage((written) => new Blob([written]));
        vi.stubGlobal('navigator', { userAgent: 'test', storage });
        const full = await runOpfsAppendStress(3);
        expect(full).toMatchObject({ ok: true, writes: 3, target: 3 });
        expect(removeEntry).toHaveBeenCalledWith('sullyos-opfs-probe-stress');

        let calls = 0;
        const handle = {
            createWritable: async () => ({
                write: async () => { if (++calls > 2) throw new DOMException('quota', 'QuotaExceededError'); },
                close: async () => undefined,
            }),
            getFile: async () => new Blob(['ab']),
        };
        vi.stubGlobal('navigator', { userAgent: 'test', storage: { ...storage, getDirectory: async () => ({ getFileHandle: async () => handle, removeEntry }) } });
        const refused = await runOpfsAppendStress(5);
        expect(refused).toMatchObject({ ok: false, writes: 2, fileSize: 2 });
        expect(refused.writeError).toContain('QuotaExceededError');
    });
});

describe('measureFileReads', () => {
    it('读文件末尾、八个位置的正反两遍和开头的顺序读，各段读到的字节数如实记录', async () => {
        const size = 40 * 1024 * 1024;
        const result = await measureFileReads(new Blob([new Uint8Array(size)]));
        expect(result).toMatchObject({ ok: true, size, tail: { offset: size - 65536, bytes: 65536 } });
        const forward = result.forward as Array<{ offset: number; bytes: number }>;
        const backward = result.backward as Array<{ offset: number; bytes: number }>;
        expect(forward.map(read => read.offset)).toEqual(Array.from({ length: 8 }, (_, i) => (size * i) / 8));
        expect(forward.every(read => read.bytes === 1024 * 1024)).toBe(true);
        expect(backward[0].offset).toBe(forward[7].offset + 1024 * 1024);
        expect(result.sequential).toMatchObject({ bytes: 32 * 1024 * 1024 });
    });

    it('文件读不了时不抛错，记下原因', async () => {
        const broken = { size: 10, slice: () => ({ arrayBuffer: async () => { throw new DOMException('gone', 'NotReadableError'); } }) };
        const result = await measureFileReads(broken as unknown as Blob);
        expect(result.ok).toBe(false);
        expect(result.error).toContain('NotReadableError');
    });
});
