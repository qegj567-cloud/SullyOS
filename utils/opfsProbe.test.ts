import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOpfsProbe, type ProbeStep } from './opfsProbe';

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
});
