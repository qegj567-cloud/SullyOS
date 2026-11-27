// 导出时按字节封页读一张表：每页一个独立的只读事务，游标逐条读，到预算就结束事务，下一页从上一页最后一个主键接着读。
// 只读事务跨不过异步写盘（一回到事件循环就自动提交），所以没有整表快照；代价见 docs/backup-pipeline.md「取舍」第 1 条。

/** 一页的字节预算。单条超过预算时独占一页。 */
export const PAGE_BYTE_BUDGET = 4 * 1024 * 1024;
/** 一页的条数上限。内存由字节预算管住，这条只防小记录很多的表一页塞进几十万条；
 * 设得太小，上百万行的表（如记忆关联）会分出上万页：导出上万个只读事务和压缩包条目，恢复上万个写事务。 */
export const PAGE_ROW_LIMIT = 1000;

/** 记录体积的粗估，只用来封页：字符串按码元数，二进制按字节数，其余每项按 8 字节。 */
export function approxRecordBytes(value: unknown): number {
    if (typeof value === 'string') return value.length;
    if (value instanceof Blob) return value.size;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
    if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + approxRecordBytes(item), 8);
    if (value && typeof value === 'object') {
        let sum = 8;
        for (const [key, item] of Object.entries(value)) sum += key.length + approxRecordBytes(item);
        return sum;
    }
    return 8;
}

export interface StorePage {
    rows: any[]; /** 表读完了 */ done: boolean; firstKey?: IDBValidKey; lastKey?: IDBValidKey;
    /** 这一页的粗估字节数，以及最大的一条有多大、主键是什么；导出留痕和概况用来定位特别大的行 */
    bytes: number; maxRowBytes: number; maxRowKey?: IDBValidKey;
}

/** 读主键大于 after 的下一页。放不下的那一条留给下一页（游标不前进），所以页数超预算只会出现在单条独占时。 */
export function readStorePage(db: IDBDatabase, table: string, after?: IDBValidKey): Promise<StorePage> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(table);
        const request = tx.objectStore(table).openCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true));
        const page: StorePage = { rows: [], done: false, bytes: 0, maxRowBytes: 0 };
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) { page.done = true; return; }
            if (page.rows.length >= PAGE_ROW_LIMIT) return;
            const size = approxRecordBytes(cursor.value);
            if (page.rows.length && page.bytes + size > PAGE_BYTE_BUDGET) return;
            if (!page.rows.length) page.firstKey = cursor.primaryKey;
            page.rows.push(cursor.value);
            page.bytes += size;
            if (size > page.maxRowBytes) { page.maxRowBytes = size; page.maxRowKey = cursor.primaryKey; }
            page.lastKey = cursor.primaryKey;
            cursor.continue();
        };
        request.onerror = () => reject(request.error ?? tx.error ?? new Error(`读取 ${table} 失败`));
        tx.oncomplete = () => resolve(page);
        tx.onerror = tx.onabort = () => reject(request.error ?? tx.error ?? new Error(`读取 ${table} 失败`));
    });
}

/** 翻页护栏用：导出前取的总条数和报错里称呼这张表的名字。 */
export interface StorePageGuard { total: number; label: string }

const RETRY_HINT = '请刷新页面后重试；如果还是这样，请把这条信息发给开发者。';

/**
 * 逐页读整张表，上一页处理完（含异步写盘）才开下一页的事务。
 * 两道闸只拦「翻页走不到头」：下一页必须从上一页之后开始；给了 guard 时，读到的条数不能远超开读前的总数。
 * 导出期间表会被并发写入，条数略有出入是正常的，所以阈值放宽到两倍再加 1000。
 */
export async function forEachStorePage(db: IDBDatabase, table: string, visit: (rows: any[], index: number, page: StorePage) => Promise<void> | void, guard?: StorePageGuard): Promise<void> {
    let after: IDBValidKey | undefined;
    let read = 0;
    for (let index = 0; ; index++) {
        const page = await readStorePage(db, table, after);
        read += page.rows.length;
        const label = guard?.label ?? table;
        if (after !== undefined && page.firstKey !== undefined && indexedDB.cmp(page.firstKey, after) <= 0) {
            throw new Error(`导出备份时读取「${label}」的顺序出错：第 ${index + 1} 页没有接在上一页之后（已读 ${read} 条）。${RETRY_HINT}`);
        }
        if (guard && read > guard.total * 2 + 1000) {
            throw new Error(`导出备份时读取「${label}」没能结束：已读 ${read} 条，表里只有 ${guard.total} 条。${RETRY_HINT}`);
        }
        await visit(page.rows, index, page);
        if (page.done) return;
        after = page.lastKey;
    }
}
