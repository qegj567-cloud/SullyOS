import { DB } from './db';
import { createV2ArrayFieldWriter, type ZipFileWriter } from './backupFormat';
import { compactMemoryLink } from './memoryPalace/linkPrecision';

/** One snapshot transaction per store, one record at a time. Transform must be
 * synchronous: waiting for external I/O inside an IDB cursor closes its tx.
 * Finished shards immediately leave the object heap through the Blob writer. */
export async function streamBackupArrayStore(
    zip: ZipFileWriter,
    storeName: string,
    field: string,
    options: {
        transform?: (item: any, index: number) => any;
        onSerialized?: (json: string) => void;
    } = {},
): Promise<{ parts: number; count: number }> {
    const writer = createV2ArrayFieldWriter(zip, field, {
        limits: { maxLen: 4 * 1024 * 1024, maxItems: 500, hardMaxLen: 256 * 1024 * 1024 },
        onSerialized: options.onSerialized,
    });
    let index = 0;
    await DB.streamRawStoreData(storeName, item => {
        const row = storeName === 'memory_links' ? compactMemoryLink(item) : item;
        writer.appendSync([options.transform ? options.transform(row, index++) : row]);
    });
    return writer.finish();
}
