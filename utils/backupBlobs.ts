// v3 备份的 blob 旁路（纯逻辑，不碰 React / DOM / IndexedDB，node 测试直接测）。
//
// v2 的做法是导出前把 blobref 令牌解析回 data URL、再由 zip 抽取管线解码成 assets/* 文件，
// 一来一回两次 base64 编解码，令牌身份也在恢复端丢失（恢复成 data: 后要靠惰性迁移重新
// 变回 blob，且同一张图的多处引用会各自变成独立副本）。v3 把这条路拆直：
//   · 令牌原样留在 JSON 里（JSON 分片一个字节不用改写）；
//   · 二进制以原文件形态直写 zip 的 blobs/<id> 条目（图片本身已压缩，STORE 不再压）；
//   · blobs/index.json 记 id → { type, size }，导入端用它重建带 mime 的 Blob；
//   · 导入端按原 id 写回（SDK 的 restore），令牌身份保住，零重编码、去重天然保留。
//
// 令牌收集不走对象树扫描，而是从「真正落包的 JSON 文本」里提（backupFormat 的
// onSerialized 钩子 + SDK 的 extractRefs）——和孤儿 GC 的 mark 阶段同一套认字逻辑，
// 令牌藏在嵌套 JSON 字符串里（如 assets 表里的 appearance_preset_* JSON）也逐字可见。
// 这样导出端没有「哪些 store 要处理」的名单可漏：任何字段里的令牌都会被收进来。

import { extractRefs, DEFAULT_PREFIX } from '@rei-standard/blob-store';
import type { ZipFileWriter, ZipFileReader } from './backupFormat';

/** blob 旁路索引在 zip 里的固定文件名。v2 老包没有这个文件（读端以此区分，无需看版本号）。 */
export const BLOBS_INDEX_FILE = 'blobs/index.json';

/** 单个 blob 在 zip 里的条目路径。id 已被字符集校验约束，不会拼出越界路径。 */
export const blobEntryPath = (id: string) => `blobs/${id}`;

/** 与 SDK 令牌 id 的字符集一致（extractRefs / GC 的边界字符集）。 */
const ID_CHARSET = /^[A-Za-z0-9_]+$/;

export interface BackupBlobIndexEntry {
    id: string;
    /** Blob 的 mime（如 image/png）。可能为空串（存入时就没有 type），恢复时原样重建。 */
    type: string;
    /** 字节数。导入端校验 zip 条目实际字节数与它一致，抓截断的包。 */
    size: number;
}

/** 从一段已序列化的 JSON 文本里提取全部 blobref 令牌，去重收进 into。 */
export function collectBlobRefs(serialized: string, into: Set<string>): void {
    for (const ref of extractRefs(serialized)) into.add(ref);
}

/**
 * 把收集到的令牌对应的 Blob 逐个直写 zip（blobs/<id>，STORE 不压缩），
 * 收尾写 blobs/index.json。一个都没写成时不落索引文件，产物与「无 blob 的包」同形。
 *
 * 解析不到的令牌（图已丢）跳过并计入 missing——死令牌会原样留在 JSON 里，恢复端
 * 渲染为空图，与 v2「置空串」的用户可见结果等价，但这里能把丢图数量如实报给调用方。
 * 字符集不合法的「令牌」同样计入 missing：它写不进合法的 zip 路径，而 extractRefs
 * 收集来的令牌结构上不会命中这条，命中即调用方传了未经收集器的裸字符串。
 *
 * 支持 fileBlob 的写入器只排队 Blob 引用，压缩时才读字节；旧写入器仍使用字节旁路。
 */
export async function writeBlobsToZip(
    zip: ZipFileWriter,
    tokens: Iterable<string>,
    getBlob: (token: string) => Promise<Blob | null>,
    opts: {
        onYield?: () => Promise<void>;
        onProgress?: (done: number, total: number) => void;
    } = {},
): Promise<{ written: number; missing: string[] }> {
    // 排序让产物字节稳定（同一份数据两次导出 diff 得出来），也方便测试断言。
    const list = [...tokens].sort();
    const entries: BackupBlobIndexEntry[] = [];
    const missing: string[] = [];
    let done = 0;

    for (const token of list) {
        done++;
        const id = token.startsWith(DEFAULT_PREFIX) ? token.slice(DEFAULT_PREFIX.length) : '';
        if (!ID_CHARSET.test(id)) {
            missing.push(token);
            continue;
        }
        const blob = await getBlob(token);
        if (!blob) {
            missing.push(token);
            continue;
        }
        if (zip.fileBlob) zip.fileBlob(blobEntryPath(id), blob, { compression: 'STORE' });
        else zip.file(blobEntryPath(id), new Uint8Array(await blob.arrayBuffer()), { compression: 'STORE' });
        entries.push({ id, type: blob.type || '', size: blob.size });
        opts.onProgress?.(done, list.length);
        if (opts.onYield) await opts.onYield();
    }

    if (entries.length > 0) {
        zip.file(BLOBS_INDEX_FILE, JSON.stringify(entries));
    }
    return { written: entries.length, missing };
}

/**
 * 读并校验 blobs/index.json。文件不存在返回 []（v2 老包 / 纯文字包）。
 * 所有校验（结构、字符集、声明的条目文件都在）在返回前完成——调用方拿到非空结果时
 * 可以放心开始写回，不会出现「校验到一半才发现缺文件」的半程状态。
 */
export async function readBlobsIndex(zip: ZipFileReader): Promise<BackupBlobIndexEntry[]> {
    const indexFile = zip.file(BLOBS_INDEX_FILE);
    if (!indexFile) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(await indexFile.async('string'));
    } catch {
        throw new Error('损坏的备份包：blobs/index.json 解析失败，已中止导入（数据未改动）。');
    }
    if (!Array.isArray(parsed)) {
        throw new Error('损坏的备份包：blobs/index.json 不是数组，已中止导入（数据未改动）。');
    }

    for (const e of parsed as BackupBlobIndexEntry[]) {
        if (!e || typeof e.id !== 'string' || !ID_CHARSET.test(e.id)
            || typeof e.type !== 'string'
            || !Number.isSafeInteger(e.size) || e.size < 0) {
            throw new Error('损坏的备份包：blobs/index.json 含非法条目，已中止导入（数据未改动）。');
        }
        if (!zip.file(blobEntryPath(e.id))) {
            throw new Error(`损坏的备份包：索引声明了 blobs/${e.id} 但 zip 里没有，已中止导入（数据未改动）。`);
        }
    }
    return parsed as BackupBlobIndexEntry[];
}

/**
 * 把 blobs/* 逐个还原成带 mime 的 Blob，经 restore 按原令牌 id 写回宿主存储。
 * 任何一步失败直接上抛，调用方应中止整个导入——此时主数据（JSON 分片）尚未写库，
 * 已写回的部分 blob 只是暂时的孤儿，由孤儿 GC 收口，不构成数据损坏。
 * 字节数与索引声明不符视为包被截断，同样上抛。
 */
export async function restoreBlobsFromZip(
    zip: ZipFileReader,
    entries: BackupBlobIndexEntry[],
    restore: (token: string, blob: Blob) => Promise<void>,
    opts: {
        onYield?: () => Promise<void>;
        onProgress?: (done: number, total: number, id: string) => void;
    } = {},
): Promise<number> {
    let done = 0;
    for (const entry of entries) {
        const file = zip.file(blobEntryPath(entry.id));
        if (!file) {
            // readBlobsIndex 已验过文件都在；走到这说明调用方传了未经校验的索引。
            throw new Error(`损坏的备份包：缺少 blobs/${entry.id}，已中止导入。`);
        }
        const bytes = await file.async('uint8array');
        if (bytes.byteLength !== entry.size) {
            throw new Error(
                `损坏的备份包：blobs/${entry.id} 实际 ${bytes.byteLength} 字节、索引声明 ${entry.size} 字节，` +
                '备份可能被截断，已中止导入。',
            );
        }
        // zip 读出的视图可能背靠更大的共享 buffer（TS 5.7 起类型上也是 ArrayBufferLike）；
        // slice() 拷出等长独立 ArrayBuffer 再喂 Blob，与 avatarModelBackup 同款处理。
        const buf = bytes.slice().buffer;
        const blob = entry.type ? new Blob([buf], { type: entry.type }) : new Blob([buf]);
        await restore(DEFAULT_PREFIX + entry.id, blob);
        done++;
        opts.onProgress?.(done, entries.length, entry.id);
        if (opts.onYield) await opts.onYield();
    }
    return done;
}
