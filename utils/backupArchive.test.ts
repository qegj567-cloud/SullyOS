import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { createBackupArchive } from './backupArchive';

it('跨 1 MiB 输出块保留所有媒体字节，JSON 有压缩，中文路径可由旧 ZIP 引擎读取', async () => {
    const zip = createBackupArchive();
    const data = Uint8Array.from({ length: 2200000 }, (_, i) => (i * 13 + (i >>> 8)) & 255);
    zip.file('assets/测试.bin', data, { compression: 'STORE' });
    zip.folder('assets').file('base64.bin', Buffer.from(data).toString('base64'), { base64: true, compression: 'STORE' });
    const json = JSON.stringify({ text: '保留全部记忆'.repeat(10000) });
    zip.file('stores/test.json', json);
    data[0] = 255; // queued bytes must own a snapshot
    const progress: number[] = [];
    const output = await zip.generateBlob(meta => progress.push(meta.percent));
    expect(output.type).toBe('application/zip');
    expect(output.size).toBeLessThan(4500000);
    const read = await JSZip.loadAsync(await output.arrayBuffer(), { checkCRC32: true });
    const bytes = await read.file('assets/测试.bin')!.async('uint8array');
    expect(bytes.length).toBe(2200000);
    expect(bytes[0]).toBe(0);
    expect(await read.file('assets/base64.bin')!.async('uint8array')).toEqual(bytes);
    expect(await read.file('stores/test.json')!.async('string')).toBe(json);
    expect(progress.at(-1)).toBe(100);
    expect(progress.every((p, i) => !i || p >= progress[i - 1])).toBe(true);
});

it('文件路径冲突不能静默覆盖，生成后不能再写入或返回空的第二份备份', async () => {
    const zip = createBackupArchive();
    zip.file('x', 'original');
    expect(() => zip.file('x', 'overwritten')).toThrow(/重复/);
    await zip.generateBlob();
    expect(() => zip.file('y', 'late')).toThrow(/开始压缩/);
    await expect(zip.generateBlob()).rejects.toThrow(/重复压缩/);
});
