// v2/v3 备份格式：分片读写的纯逻辑，刻意不碰 React / DOM / Capacitor，只依赖一个最小的
// zip 读写接口，好在 node 测试环境里拿真 jszip 单测往返。
//
// v3 与 v2 的分片布局完全相同，区别只有一件事：图片的 blobref 令牌不再在导出前解析回
// data URL，而是原样留在 JSON 里，二进制走 zip 的 blobs/<id> 旁路（见 utils/backupBlobs.ts）。
// 本文件对 blobs 旁路唯一的参与是 onSerialized 钩子——把每段真正落包的 JSON 文本吐给
// 调用方，供其收集令牌。读端同时接受 2 和 3：两个版本的分片组装逻辑一字不差。
//
// 设计主线（见 notes/backup-streaming-refactor-plan.md）：
//   大数组表由 backupStoreStreaming 逐条处理后直接写 stores/<field>.NNN.json，
//   不整表驻留 backupData；其余设置/单例仍由这里写分片或 metadata.json。
//   prewrittenStores 合入相同 manifest，三个模式的还原语义保持兼容。
//   导入端读 manifest，把各片拼回「与 v1 完全相同的 data 对象」，再喂给原封不动的
//   importFullData——还原语义（clear-and-add / merge / 单例 / media_only 补丁……）全部
//   留在 importFullData 里，这里不重写，所以不会出现「两套语义彼此漂移」。
//
// 为什么单根 data.json 会崩：对单个超大数组或整包做 JSON.stringify，文本长度逼近 JS
// 单字符串 ~512M（2^29）上限会确定性抛 RangeError。分片后每片字符串长度有界，永不触上限。

export const BACKUP_FORMAT_VERSION = 3;

/**
 * 备份包里的内容本身坏了：目录读不出、条目 CRC 不符、解压失败。读取适配层（backupZipReader）抛它。
 * 读文件失败（DOMException）和内存不足（RangeError）不属于这一类，调用方不能把它们当成「这一项坏了」跳过。
 * 定义在这里是为了让判断它的模块不必引入 zip.js。
 */
export class BackupCorruptError extends Error {
    name = 'BackupCorruptError';
}

/** 文件头是不是 zip 的 PK 魔数。只读前 4 个字节。 */
export async function isZipFile(file: Blob): Promise<boolean> {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07);
}

/**
 * 备份文件按什么格式读。看文件头而不是文件名：云端下载落盘的临时文件叫 download-….tmp，内容是 zip。
 * 名字以 .zip 结尾但文件头不是 PK 的仍按 zip 读，由读包那一步报「不是 zip 文件」——按 JSON 读会先把整个文件读进内存。
 */
export async function detectBackupFileKind(file: Blob & { name?: string }): Promise<'zip' | 'json'> {
    return await isZipFile(file) || !!file.name?.endsWith('.zip') ? 'zip' : 'json';
}

/** 读端接受的版本：v2（令牌已解析成 data:）与 v3（令牌 + blobs/* 旁路）分片布局相同。 */
export const SUPPORTED_IMPORT_FORMAT_VERSIONS: readonly number[] = [2, 3];

/** 分片阈值。注意这里的「Len」量的是 JS 字符串长度（UTF-16 码元数），正是 RangeError 盯的那个量，
 *  不是 UTF-8 字节数——用它当阈值刚好守住「单根字符串别逼近 512M」。 */
export interface ShardLimits {
    /** 单片字符串长度软上限：攒到这个长度就 flush 一片 */
    maxLen: number;
    /** 单片条数软上限：攒到这么多条就 flush 一片（防超多小记录挤进一片） */
    maxItems: number;
    /** 单条记录序列化硬上限：单条就超它 → 干净报错中止导出，绝不退回 RangeError */
    hardMaxLen: number;
}

export const DEFAULT_SHARD_LIMITS: ShardLimits = {
    maxLen: 32 * 1024 * 1024,        // 32M 码元，远低于 ~512M 上限
    maxItems: 5000,
    hardMaxLen: 256 * 1024 * 1024,   // 256M 码元
};

/** 向量 bin 的索引项：每条向量在 memory_vectors.bin 里的位置 + 重建所需元数据 */
export interface VectorIndexEntry {
    memoryId: string;
    charId: string;
    dimensions: number;
    model?: string;
    byteOffset: number;
    byteLength: number;
}

export interface BackupManifest {
    formatVersion: number;
    mode?: string;
    createdAt?: number;
    /** key = backupData 字段名（如 messages / galleryImages / memoryNodes），value = 分片数 + 总条数 */
    stores: Record<string, { parts: number; count: number }>;
    /** 向量走二进制旁路（memory_vectors.bin + .index.json），不进 stores。无向量时省略。 */
    vectors?: { count: number; byteLength: number };
    assetCount?: number;
}

/** 写端：往 zip 里塞文本文件，或二进制（Uint8Array）文件。二进制直写，绝不经 base64 大字符串。 */
export interface ZipFileWriter {
    /** Optional native Blob path: keep large media out of the JS byte heap. */
    fileBlob?(name: string, data: Blob, options?: { compression?: 'STORE' | 'DEFLATE' }): void;
    file(name: string, data: string | Uint8Array, options?: {
        base64?: boolean;
        compression?: 'STORE' | 'DEFLATE';
        compressionOptions?: { level?: number };
    }): void;
}

/** 读端：按名取文件，能按类型 async 出文本或字节；取不到返回 null */
export interface ZipFileReader {
    file(name: string): {
        async(type: 'string'): Promise<string>;
        async(type: 'uint8array'): Promise<Uint8Array>;
    } | null;
    /** 重读压缩包目录，确认文件本身还读得到；内存里的假包不用实现。 */
    verify?(): Promise<void>;
}

/**
 * 确认备份文件本身还读得到：重读一个开包时已经校验通过的小条目（清单），v1 没有清单就重读压缩包目录。
 * 读不出来说明是文件失效（被系统收回、移走），不是包里某一项坏了，按读文件失败抛出。
 */
export async function assertBackupStillReadable(zip: ZipFileReader): Promise<void> {
    try {
        const probe = zip.file('manifest.json') ?? zip.file('user-spaces.json');
        if (probe) await probe.async('uint8array');
        else await zip.verify?.();
    } catch (error) {
        if (!(error instanceof BackupCorruptError)) throw error;
        throw new DOMException('备份文件已经读不出来了（可能被系统收回或移走），恢复已中止，请重新选择备份文件再导入。', 'NotReadableError');
    }
}

/**
 * 「单张图片损坏按缺图处理」的共用判断：read 抛 BackupCorruptError 时返回 null，其余错误原样抛出。
 * 一次恢复里第一次遇到时先确认备份文件本身还读得到——有的环境在文件失效后不报错而是给出错的数据，
 * 那样每张图看起来都「损坏」，恢复会带着几千张空图照常完成。
 */
export function createDamagedPictureGuard(zip: ZipFileReader) {
    let confirmed = false;
    return async <T,>(read: () => Promise<T>): Promise<T | null> => {
        try {
            return await read();
        } catch (error) {
            if (!(error instanceof BackupCorruptError)) throw error;
            if (!confirmed) {
                await assertBackupStillReadable(zip);
                confirmed = true;
            }
            return null;
        }
    };
}

/** 向量 bin / index 在 zip 里的固定文件名 */
export const VECTOR_BIN_FILE = 'stores/memory_vectors.bin';
export const VECTOR_INDEX_FILE = 'stores/memory_vectors.index.json';

/** 分片文件名：stores/<field>.NNN.json。写读两端用同一个公式，靠数字下标对齐，不靠文件名字典序。 */
export function shardFileName(field: string, index: number): string {
    return `stores/${field}.${String(index).padStart(3, '0')}.json`;
}

export interface WriteV2Options {
    mode?: string;
    createdAt?: number;
    assetCount?: number;
    limits?: ShardLimits;
    /** React 端传 `() => new Promise(r => setTimeout(r, 0))` 让出主线程；测试端可不传 */
    onYield?: () => Promise<void>;
    /** 向量二进制旁路：调用方（OSContext）已把 memory_vectors 归一化拼成 bin + index 时传进来。
     *  写进 memory_vectors.bin（二进制直写）+ .index.json，并在 manifest.vectors 记 count/byteLength。
     *  传了这个就不要再把 memoryVectors 放进 backupData（否则会被当普通数组又分片一遍）。 */
    vectors?: { bin: Uint8Array; index: VectorIndexEntry[] };
    /**
     * 已由调用方增量写进 zip 的数组字段。大数据量导出可用 createV2ArrayFieldWriter 一批批写，
     * 不必先把整个 store 攒进 backupData；writeV2Backup 收尾时会把这些统计合进 manifest。
     */
    prewrittenStores?: Record<string, { parts: number; count: number }>;
    /**
     * 通用文本钩子：每段真正落包的 JSON 文本（分片里的每条记录 + metadata.json）都过一遍。
     * v3 导出方靠它收集 blobref 令牌——只有这一层见得到「实际写进包里的字符串」，在上游
     * 对象树上另扫一遍既贵又可能与真实序列化结果不一致（令牌可能藏在嵌套 JSON 字符串里，
     * 序列化后逐字可见）。manifest / 向量 bin·index 不含用户字段值，不过钩。
     */
    onSerialized?: (json: string) => void;
}

export interface V2ArrayFieldWriter {
    /** 同步追加，供单个 IndexedDB 游标事务内使用；不能在事务回调里 await。 */
    appendSync(items: any[]): void;
    /** 追加一批记录；调用返回后，调用方即可释放这批原始对象。 */
    append(items: any[]): Promise<void>;
    /** 冲掉最后不足一片的缓冲并返回 manifest 统计；每个 writer 只能 finish 一次。 */
    finish(): Promise<{ parts: number; count: number }>;
}

/**
 * 增量数组分片写入器。与 writeV2Backup 的普通数组路径使用同一套序列化/阈值规则，
 * 但允许调用方从 IndexedDB 游标分批喂数据，峰值内存只与单批和单片大小有关。
 */
export function createV2ArrayFieldWriter(
    zip: ZipFileWriter,
    field: string,
    options: Pick<WriteV2Options, 'limits' | 'onYield' | 'onSerialized'> = {},
): V2ArrayFieldWriter {
    const limits = options.limits || DEFAULT_SHARD_LIMITS;
    const onYield = options.onYield;
    const onSerialized = options.onSerialized;
    let buf: string[] = [];
    let bufLen = 0;
    let parts = 0;
    let writtenCount = 0;
    let inputIndex = 0;
    let finished = false;

    const flush = () => {
        if (buf.length === 0) return;
        zip.file(shardFileName(field, parts), '[' + buf.join(',') + ']');
        parts++;
        buf = [];
        bufLen = 0;
    };

    const pushOne = (item: any): number => {
        if (finished) throw new Error(`备份分片 ${field} 已结束，不能继续写入。`);
        let s: string;
        try {
            s = JSON.stringify(item);
        } catch (e: any) {
            throw new Error(`备份序列化失败（${field} 第 ${inputIndex} 条）：${e?.message || e}`);
        }
        inputIndex++;
        // JSON.stringify(undefined) === undefined；与旧 v1 JSON 语义一致地跳过空洞。
        if (s === undefined) return 0;
        onSerialized?.(s);
        if (s.length > limits.hardMaxLen) {
            throw new Error(
                `备份中有单条记录过大（${field}，约 ${Math.round(s.length / 1048576)}M 字符），` +
                `超出安全上限，已中止导出以免生成损坏的备份包。`,
            );
        }
        let flushes = 0;
        // 单条超过软上限时让它独占一片，避免与前一批记录粘成更大的临时字符串。
        if (s.length >= limits.maxLen && buf.length > 0) { flush(); flushes++; }
        buf.push(s);
        bufLen += s.length;
        writtenCount++;
        if (bufLen >= limits.maxLen || buf.length >= limits.maxItems) { flush(); flushes++; }
        return flushes;
    };

    const appendSync = (items: any[]) => {
        for (const item of items) pushOne(item);
    };

    const append = async (items: any[]) => {
        for (const item of items) {
            const flushes = pushOne(item);
            if (flushes > 0 && onYield) await onYield();
        }
    };

    const finish = async () => {
        if (finished) throw new Error(`备份分片 ${field} 被重复结束。`);
        const hadBufferedItems = buf.length > 0;
        flush();
        if (hadBufferedItems && onYield) await onYield();
        finished = true;
        return { parts, count: writtenCount };
    };

    return { appendSync, append, finish };
}

/**
 * 把已攒好的 backupData 写成 v2 分片布局，返回 manifest。
 *
 * 会「消费」backupData：数组字段写完即把该字段置 undefined 释放引用，方便大数组尽早被 GC。
 * 调用方不应在调用后再读 backupData。
 */
export async function writeV2Backup(
    zip: ZipFileWriter,
    backupData: Record<string, any>,
    options: WriteV2Options = {},
): Promise<BackupManifest> {
    const limits = options.limits || DEFAULT_SHARD_LIMITS;
    const onYield = options.onYield;
    const manifestStores: Record<string, { parts: number; count: number }> = {
        ...(options.prewrittenStores || {}),
    };

    const shardArrayField = async (field: string, arr: any[]) => {
        if (Object.prototype.hasOwnProperty.call(manifestStores, field)) {
            throw new Error(`备份字段 ${field} 同时走了增量写入和普通写入，已中止以免生成重复分片。`);
        }
        const writer = createV2ArrayFieldWriter(zip, field, { limits, onYield, onSerialized: options.onSerialized });
        await writer.append(arr);
        // count 用「实际写入条数」而非 arr.length：writer 会跳过 JSON.stringify(undefined)
        // 得到的空洞，避免导入端「拼出条数 === count」校验误判损坏。
        manifestStores[field] = await writer.finish();
    };

    // 一遍扫 backupData：数组字段分片（写完释放），其余非数组字段进 metadata。
    const metaFields: Record<string, any> = {};
    for (const key of Object.keys(backupData)) {
        const value = backupData[key];
        if (Array.isArray(value)) {
            await shardArrayField(key, value);
            backupData[key] = undefined; // 释放引用，已落 zip
        } else {
            metaFields[key] = value;
        }
    }

    const metaJson = JSON.stringify(metaFields);
    options.onSerialized?.(metaJson);
    zip.file('metadata.json', metaJson);

    // 向量二进制旁路：bin 直写 Uint8Array（不经 base64，bin 多大都不会撞字符串上限），
    // index 是小 JSON。manifest.vectors 记 count/byteLength 供导入端校验。
    let vectorsMeta: { count: number; byteLength: number } | undefined;
    if (options.vectors) {
        // embedding 浮点字节近似随机数据，DEFLATE 几乎压不小，却会在手机上消耗大量 CPU/内存。
        // 直接 STORE 保持字节无损，索引和其它 JSON 仍走外层压缩。
        zip.file(VECTOR_BIN_FILE, options.vectors.bin, { compression: 'STORE' });
        zip.file(VECTOR_INDEX_FILE, JSON.stringify(options.vectors.index));
        vectorsMeta = { count: options.vectors.index.length, byteLength: options.vectors.bin.byteLength };
    }

    const manifest: BackupManifest = {
        formatVersion: BACKUP_FORMAT_VERSION,
        mode: options.mode,
        createdAt: options.createdAt,
        stores: manifestStores,
        vectors: vectorsMeta,
        assetCount: options.assetCount,
    };
    zip.file('manifest.json', JSON.stringify(manifest));
    return manifest;
}

export interface AssembleV2Options {
    /** React 端传让出主线程的函数；测试端可不传 */
    onYield?: () => Promise<void>;
    /** 进度回调：当前字段、已处理字段序号、字段总数 */
    onShardProgress?: (field: string, fieldIndex: number, fieldTotal: number) => void;
    /** 每读出一个数组字段都过一遍（写库前校验时一次，真正用到时再一次），可就地改写；抛错即中止 */
    onFieldRead?: (field: string, rows: any[]) => Promise<void> | void;
}

const pendingFields = new WeakMap<object, { field: string; read: () => Promise<any[]> }>();

// 占位只有 length 能读（清单里的条数），够回答「有没有这个字段」「有多少条」；
// 读内容直接抛错，漏接的使用点不会把它当成空数组写库。
const createPendingField = (field: string, count: number, read: () => Promise<any[]>): any[] => {
    const fail = (): never => { throw new Error(`备份字段 ${field} 尚未读入`); };
    const placeholder = new Proxy<any[]>([], {
        get: (_target, key) => (key === 'length' ? count : key === 'then' ? undefined : fail()),
        ownKeys: fail,
    });
    pendingFields.set(placeholder, { field, read });
    return placeholder;
};

/** value 是还没读入的分片字段时，返回它的字段名和读取函数；否则返回 undefined。 */
export const pendingBackupField = (value: unknown): { field: string; read: () => Promise<any[]> } | undefined => (
    value !== null && typeof value === 'object' ? pendingFields.get(value) : undefined
);

/** 占位就读出真数组（不写回 data，调用方用完即弃），其余原样返回。 */
export async function readBackupField<T>(value: T): Promise<T> {
    const pending = pendingBackupField(value);
    return pending ? await pending.read() as T : value;
}

/** 把 data 里的占位全部读成真数组，给需要整份数据同时在手的调用方用。 */
export async function loadAllBackupFields<T extends object>(data: T): Promise<T> {
    for (const key of Object.keys(data)) (data as any)[key] = await readBackupField((data as any)[key]);
    return data;
}

/** 一次读全：返回「与 v1 完全相同的 data 对象」，整份数据同时在内存里。 */
export async function assembleV2Backup(
    zip: ZipFileReader,
    manifest: BackupManifest,
    options: AssembleV2Options = {},
): Promise<Record<string, any>> {
    return loadAllBackupFields(await openV2Backup(zip, manifest, options));
}

/**
 * 读 v2/v3 备份，返回喂给 importFullData 的 data：非数组字段已就位，分片字段是占位，
 * 用到时经 readBackupField / pendingBackupField 才读它的分片，恢复峰值是最大的一个字段而不是全部。
 *
 * 全程只读 zip，不碰数据库。返回前每个字段都完整读过一遍并校验（读完即弃），所以任何校验不过
 * 直接抛错时，DB 一字未动，调用方应在调用 importFullData 之前先 await 本函数。
 *
 * 校验三档（都在写库前）：① formatVersion 在支持清单里；② manifest 声明的每个分片文件都在
 * （缺则 abort）；③ 每字段组装后条数 === manifest count、每片必须是数组（抓我们自己导出的 bug，
 * 不是防用户篡改）。素材文件 assets/* 不进这道硬边界——缺图维持 warn+skip（缺图只可能来自
 * 篡改，真丢了也无从恢复，为它拒绝整个导入没意义）。
 */
async function openV2Backup(
    zip: ZipFileReader,
    manifest: BackupManifest,
    options: AssembleV2Options = {},
): Promise<Record<string, any>> {
    if (!manifest || typeof manifest !== 'object') {
        throw new Error('损坏的备份包：manifest.json 无法解析。');
    }
    if (!SUPPORTED_IMPORT_FORMAT_VERSIONS.includes(manifest.formatVersion)) {
        throw new Error(
            `不支持的备份格式版本：${manifest.formatVersion}（本版本只能导入 formatVersion ` +
            `${SUPPORTED_IMPORT_FORMAT_VERSIONS.join(' / ')} 的备份），已中止导入（数据未改动）。`,
        );
    }

    const metaFile = zip.file('metadata.json');
    if (!metaFile) throw new Error('损坏的备份包：有 manifest 但缺 metadata.json，已中止导入（数据未改动）。');
    let data: Record<string, any>;
    // 读取放在 try 外面：读文件失败、内存不足原样抛出，不改写成「备份损坏」。下面几处同理。
    const metaText = await metaFile.async('string');
    try {
        data = JSON.parse(metaText);
    } catch {
        throw new Error('损坏的备份包：metadata.json 解析失败，已中止导入（数据未改动）。');
    }

    const stores = manifest.stores || {};
    const fields = Object.keys(stores);

    // 先一遍校验所有声明的分片文件都在（缺则 abort，此时还没拼任何数据、DB 未动）
    for (const field of fields) {
        const { parts } = stores[field];
        for (let p = 0; p < parts; p++) {
            const name = shardFileName(field, p);
            if (!zip.file(name)) {
                throw new Error(`损坏的备份包：manifest 声明了 ${name} 但 zip 里没有，已中止导入（数据未改动）。`);
            }
        }
    }

    // 校验那一遍发生在写库前，「数据未改动」成立；之后同一批读取函数在写库途中被调用，改说另一句。
    let aborted = '已中止导入（数据未改动）。';

    // 逐片拼回一个字段的完整数组；parse 完一片即释放该片字符串；组装后条数必须等于 manifest count
    const readField = async (field: string): Promise<any[]> => {
        const { parts, count } = stores[field];
        const arr: any[] = [];
        for (let p = 0; p < parts; p++) {
            const name = shardFileName(field, p);
            let str = await zip.file(name)!.async('string');
            let chunk: any;
            try {
                chunk = JSON.parse(str);
            } catch {
                throw new Error(`损坏的备份包：${name} 解析失败，${aborted}`);
            }
            str = ''; // 释放该片字符串
            if (!Array.isArray(chunk)) {
                throw new Error(`损坏的备份包：${name} 不是数组，${aborted}`);
            }
            for (const item of chunk) arr.push(item);
            if (options.onYield) await options.onYield();
        }
        if (arr.length !== count) {
            throw new Error(
                `损坏的备份包：${field} 实际拼出 ${arr.length} 条、manifest 声明 ${count} 条，对不上，${aborted}`,
            );
        }
        await options.onFieldRead?.(field, arr);
        return arr;
    };

    // 向量二进制旁路：从 bin + index 重建 MemoryVector[]，塞进 data.memoryVectors，
    // 跟其它 store 一样走那一次 importFullData（clear-once），不走 saveMany 旁路。
    const readVectors = async (vectorsMeta: { count: number; byteLength: number }): Promise<any[]> => {
        const idxFile = zip.file(VECTOR_INDEX_FILE);
        const binFile = zip.file(VECTOR_BIN_FILE);
        if (!idxFile || !binFile) {
            throw new Error(`损坏的备份包：manifest 声明了向量但缺 index/bin 文件，${aborted}`);
        }
        let index: VectorIndexEntry[];
        const indexText = await idxFile.async('string');
        try {
            index = JSON.parse(indexText);
        } catch {
            throw new Error(`损坏的备份包：memory_vectors.index.json 解析失败，${aborted}`);
        }
        const bin = await binFile.async('uint8array');
        if (!Array.isArray(index) || index.length !== vectorsMeta.count) {
            throw new Error(`损坏的备份包：向量条数与 manifest 不符，${aborted}`);
        }
        if (bin.byteLength !== vectorsMeta.byteLength) {
            throw new Error(`损坏的备份包：向量 bin 字节数与 manifest 不符，${aborted}`);
        }
        const okInt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
        const vectors = index.map((e) => {
            // 偏移/长度/维度必须是非负安全整数，且字节区间落在 bin 内。少了这道校验，坏 byteOffset
            // 会被 Uint8Array.slice() 钳制成空/截断的字节（不报错），组装照样过，importFullData 清旧
            // 存新 → 本该 abort 的损坏变成丢数据。这里把它挡在写库前（也顺带抓自家 offset 算错的 bug）。
            if (!okInt(e.byteOffset) || !okInt(e.byteLength) || !okInt(e.dimensions)) {
                throw new Error(`损坏的备份包：向量 ${e.memoryId} 的偏移/长度/维度非法，${aborted}`);
            }
            if (e.byteLength !== e.dimensions * 4) {
                throw new Error(`损坏的备份包：向量 ${e.memoryId} 的字节数与维度对不上，${aborted}`);
            }
            if (e.byteOffset + e.byteLength > bin.byteLength) {
                throw new Error(`损坏的备份包：向量 ${e.memoryId} 的字节区间越过 bin 末尾，${aborted}`);
            }
            // slice 切出独立 buffer（不是 subarray 视图）：否则 IndexedDB 结构化克隆会把整根 bin
            // 给每条向量各复制一遍。importFullData 的 memory_vectors 段对 Uint8Array 形态原样存。
            const vector = bin.slice(e.byteOffset, e.byteOffset + e.byteLength);
            if (vector.byteLength !== e.byteLength) {
                throw new Error(`损坏的备份包：向量 ${e.memoryId} 切片长度异常，${aborted}`);
            }
            return { memoryId: e.memoryId, charId: e.charId, dimensions: e.dimensions, model: e.model, vector };
        });
        await options.onFieldRead?.('memoryVectors', vectors);
        return vectors;
    };

    // 先把每个字段完整读一遍、验完就丢：CRC、解析、条数的问题都在写库前暴露，期间内存里只有一个字段。
    for (let fi = 0; fi < fields.length; fi++) {
        await readField(fields[fi]);
        options.onShardProgress?.(fields[fi], fi, fields.length);
    }
    const vectorsMeta = manifest.vectors;
    if (vectorsMeta) {
        await readVectors(vectorsMeta);
        options.onShardProgress?.('memoryVectors', fields.length, fields.length + 1);
    }

    aborted = '恢复已中断，请重新导入这份备份。';

    // 没有分片的字段就是空数组，不用占位。
    for (const field of fields) {
        data[field] = stores[field].parts > 0 ? createPendingField(field, stores[field].count, () => readField(field)) : [];
    }
    if (vectorsMeta) data.memoryVectors = createPendingField('memoryVectors', vectorsMeta.count, () => readVectors(vectorsMeta));

    return data;
}

/**
 * 打开单空间旧格式备份，返回喂给 importFullData 的 data。
 * 有 manifest.json 的是 v2/v3，分片字段用到时才读；只有 data.json 的是 v1，单个 JSON 没法按字段拆，整个读入。
 */
export async function openLegacyBackup(zip: ZipFileReader, options: AssembleV2Options = {}): Promise<Record<string, any>> {
    const manifestFile = zip.file('manifest.json');
    if (manifestFile) {
        let manifest: BackupManifest;
        const manifestText = await manifestFile.async('string');
        try {
            manifest = JSON.parse(manifestText);
        } catch {
            throw new Error('损坏的备份包：manifest.json 解析失败');
        }
        return openV2Backup(zip, manifest, options);
    }
    const dataFile = zip.file('data.json');
    if (!dataFile) throw new Error('损坏的备份包: 缺少 data.json');
    const data = JSON.parse(await dataFile.async('string'));
    if (data && typeof data === 'object') {
        for (const [field, rows] of Object.entries(data)) if (Array.isArray(rows)) await options.onFieldRead?.(field, rows);
    }
    return data;
}
