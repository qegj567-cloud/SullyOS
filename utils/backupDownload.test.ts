import { beforeEach, describe, expect, it, vi } from 'vitest';

// 假临时文件：写入要隔一拍才落盘（模拟磁盘 IO），落盘时复制一份，原片即可释放。
const temp = vi.hoisted(() => ({
    supported: true,
    space: null as { enough: boolean; available: number } | null,
    quotaFull: false,
    extraBytes: 0, // 模拟浏览器往文件里多写了数据
    files: [] as Array<{ chunks: Uint8Array[]; closed: boolean; removed: boolean }>,
    onPersist: undefined as (() => void) | undefined,
}));
vi.mock('./backupTempFile', () => ({
    isBackupTempFileSupported: async () => temp.supported,
    checkBackupSpace: async () => temp.space,
    createBackupTempFile: async () => {
        const state = { chunks: [] as Uint8Array[], closed: false, removed: false };
        temp.files.push(state);
        return {
            name: 'download-test.tmp',
            async openWritable() {
                return new WritableStream<Uint8Array>({
                    async write(chunk) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                        if (temp.quotaFull) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
                        state.chunks.push(chunk.slice());
                        temp.onPersist?.();
                    },
                    close() { state.closed = true; },
                });
            },
            async getFile() {
                if (!state.closed) throw new Error('getFile before close');
                return new File([...state.chunks, new Uint8Array(temp.extraBytes)] as BlobPart[], 'download-test.tmp');
            },
            async remove() { state.removed = true; },
        };
    },
}));

import { type BackupDownloadSink, receiveBackupDownload, verifyBackupPart } from './backupDownload';

const parts = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];
const sha256 = async (bytes: Uint8Array) =>
    'sha256:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)),
        b => b.toString(16).padStart(2, '0')).join('');
const bytesOf = async (blob: Blob) => Array.from(new Uint8Array(await blob.arrayBuffer()));

beforeEach(() => {
    temp.supported = true;
    temp.space = null;
    temp.quotaFull = false;
    temp.extraBytes = 0;
    temp.files = [];
    temp.onPersist = undefined;
});

describe('receiveBackupDownload 写磁盘', () => {
    it('等上一片落盘才收下一片，内存里同时持有的分片不超过一片', async () => {
        let held = 0;
        let peak = 0;
        temp.onPersist = () => { held--; };

        const backup = await receiveBackupDownload(async sink => {
            for (const part of parts) {
                held++;
                peak = Math.max(peak, held);
                await sink.write(part.slice());
            }
        }, 6);

        expect(peak).toBe(1);
        expect(await bytesOf(backup.blob)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('成功后 dispose 删除临时文件', async () => {
        const backup = await receiveBackupDownload(async sink => { await sink.write(parts[0].slice()); });
        expect(temp.files[0].removed).toBe(false);
        await backup.dispose();
        expect(temp.files[0].removed).toBe(true);
    });

    it('某片摘要不符时报错，临时文件已删除', async () => {
        const wrong = await sha256(new Uint8Array([9]));
        await expect(receiveBackupDownload(async sink => {
            await sink.write(parts[0].slice());
            await verifyBackupPart(parts[1].slice(), { label: '第 2/3 片', size: 2, digest: wrong });
        })).rejects.toThrow('第 2/3 片校验和不符');
        expect(temp.files[0]).toMatchObject({ removed: true, closed: false });
    });

    it('某片大小不符时报错，临时文件已删除', async () => {
        await expect(receiveBackupDownload(async () => {
            await verifyBackupPart(parts[0].slice(), { label: '第 1/3 片', size: 4 });
        })).rejects.toThrow('第 1/3 片大小不符（应为 4 字节，实际 3 字节）');
        expect(temp.files[0].removed).toBe(true);
    });

    it('总大小与期望不符时报错，不提交文件并删除', async () => {
        await expect(receiveBackupDownload(async sink => {
            await sink.write(parts[0].slice());
        }, 10)).rejects.toThrow('应为 10 字节，实际 3 字节');
        expect(temp.files[0]).toMatchObject({ removed: true, closed: false });
    });
});

describe('receiveBackupDownload 配额', () => {
    const writeAll = async (sink: BackupDownloadSink) => {
        for (const part of parts) await sink.write(part.slice());
    };

    it('已知大小且预判空间不够时写内存', async () => {
        temp.space = { enough: false, available: 2 };
        const backup = await receiveBackupDownload(writeAll, 6);

        expect(temp.files).toHaveLength(0);
        expect(await bytesOf(backup.blob)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('估算说放不下、但文件大到内存里放不下时，仍然写磁盘', async () => {
        temp.space = { enough: false, available: 2 };
        const size = 300 * 1024 * 1024;
        // 只核对走了哪条路：写入内容对不上总大小会报错，临时文件已经建出来就说明选的是磁盘
        await expect(receiveBackupDownload(writeAll, size)).rejects.toThrow('大小不符');
        expect(temp.files).toHaveLength(1);
    });

    it('落盘后的文件比收到的字节多时报错并删除临时文件', async () => {
        temp.extraBytes = 3;
        await expect(receiveBackupDownload(writeAll, 6)).rejects.toThrow('落盘的备份大小不符（应为 6 字节，实际 9 字节）');
        expect(temp.files[0].removed).toBe(true);
    });

    it('配额估算未知时照样写磁盘', async () => {
        temp.space = null;
        await receiveBackupDownload(writeAll, 6);
        expect(temp.files).toHaveLength(1);
    });

    it('写到一半配额不足：整次失败、删掉临时文件，提示是中文的空间不足', async () => {
        temp.quotaFull = true;
        const failure = receiveBackupDownload(async sink => { await sink.write(parts[0].slice()); }, 3);

        await expect(failure).rejects.toThrow('设备存储空间不足');
        await expect(failure).rejects.not.toThrow('quota');
        expect(temp.files[0].removed).toBe(true);
    });
});

describe('receiveBackupDownload 内存降级', () => {
    it('OPFS 不可用时字节留在内存，结果一致，dispose 不出错', async () => {
        temp.supported = false;
        const backup = await receiveBackupDownload(async sink => {
            for (const part of parts) await sink.write(part.slice());
        }, 6);

        expect(temp.files).toHaveLength(0);
        expect(await bytesOf(backup.blob)).toEqual([1, 2, 3, 4, 5, 6]);
        await expect(backup.dispose()).resolves.toBeUndefined();
    });
});

describe('verifyBackupPart', () => {
    it('摘要一致时通过', async () => {
        await expect(verifyBackupPart(parts[0].slice(), { label: 'x', size: 3, digest: await sha256(parts[0]) }))
            .resolves.toBeUndefined();
    });

    it('摘要缺失或不是 sha256 时只核对大小', async () => {
        await expect(verifyBackupPart(parts[0].slice(), { label: 'x', size: 3, digest: null })).resolves.toBeUndefined();
        await expect(verifyBackupPart(parts[0].slice(), { label: 'x', size: 3, digest: 'md5:abc' })).resolves.toBeUndefined();
    });
});
