import { expect, it } from 'vitest';
import { writeBlobsToZip, readBlobsIndex, restoreBlobsFromZip } from './backupBlobs';
import { createBackupArchive } from './backupArchive';
import JSZip from 'jszip';

it('图片直接排队 Blob，压缩时才逐个读取；旧还原器能读回所有原字节', async () => {
    const zip = createBackupArchive();
    const original = new Blob([new Uint8Array([137, 80, 78, 71, 0, 255])], { type: 'image/png' });
    // Calling arrayBuffer on a whole source image would eagerly retain all image bytes.
    original.arrayBuffer = async () => { throw new Error('whole source Blob was materialized'); };
    const token = 'blobref:test_backup_stream';
    await writeBlobsToZip(zip, [token], async () => original);
    const output = await zip.generateBlob();
    const loaded = await JSZip.loadAsync(await output.arrayBuffer(), { checkCRC32: true });
    const entries = await readBlobsIndex(loaded as any);
    const restored: Blob[] = [];
    await restoreBlobsFromZip(loaded as any, entries, async (_, blob) => { restored.push(blob); });
    expect(restored).toHaveLength(1);
    expect(restored[0].type).toBe('image/png');
    expect([...new Uint8Array(await restored[0].arrayBuffer())]).toEqual([137, 80, 78, 71, 0, 255]);
});
