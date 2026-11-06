/**
 * 本机存储用量统计
 *
 * 回答用户两个问题：
 *   1.「我的数据一共多大」—— navigator.storage.estimate()，一次调用就有，进设置页就能显示。
 *   2.「都是些什么占的」—— 翻 IndexedDB 逐表测量，秒级，所以界面上折叠起来、点开才算。
 *
 * 第 2 问的两个现实约束：
 *   · messages 这种表动辄几万条，逐条测量能把主线程卡死几秒 —— 超过采样上限的表改成
 *     「均匀跳着采样再按条数放大」，界面上标个「约」。
 *   · 图片和 VRM / Live2D 模型都塞在同一张 blob_assets 表里，key 是随机 id 分不出类型，
 *     只能看 Blob 的 MIME：image/* 算图片、audio/* 算语音，剩下的（zip / octet-stream）
 *     当模型。猜错的代价只是某一行数字偏了，不影响总量。
 */

import { openDB } from './db';

// ─── 概览：浏览器给了多少、给不给「别清我」的许可 ──────────────────

export interface StorageOverview {
    /** 浏览器提供不提供用量信息。false 时下面两个字节数都是 null，别拿 0 顶上去。 */
    supported: boolean;
    usageBytes: number | null;
    quotaBytes: number | null;
    /**
     * 浏览器实报的 IndexedDB 那一份（Chrome 的 usageDetails 才有，其它家是 null）。
     * 细分校准要用它：我们量的是原始字节，落盘时压过一道，两者天然对不上。
     */
    indexedDbBytes: number | null;
    /** 持久化许可。null = 这个浏览器不支持查询（不等于没有）。 */
    persisted: boolean | null;
}

const getStorageManager = (): StorageManager | null => {
    if (typeof navigator === 'undefined') return null;
    return (navigator as Navigator).storage ?? null;
};

/** 读总量 + 持久化状态。任何一环失败都降级成「读不到」，不抛。 */
export async function readStorageOverview(): Promise<StorageOverview> {
    const sm = getStorageManager();
    const fallback: StorageOverview = {
        supported: false, usageBytes: null, quotaBytes: null, indexedDbBytes: null, persisted: null,
    };
    if (!sm) return fallback;

    let usageBytes: number | null = null;
    let quotaBytes: number | null = null;
    let indexedDbBytes: number | null = null;
    let supported = false;
    if (typeof sm.estimate === 'function') {
        try {
            const est = await sm.estimate() as StorageEstimate & { usageDetails?: Record<string, number> };
            supported = true;
            usageBytes = typeof est.usage === 'number' ? est.usage : null;
            quotaBytes = typeof est.quota === 'number' ? est.quota : null;
            const detail = est.usageDetails?.indexedDB;
            indexedDbBytes = typeof detail === 'number' ? detail : null;
        } catch {
            // 隐私模式 / 权限受限会直接 reject，当成「这浏览器不给看」处理
        }
    }

    let persisted: boolean | null = null;
    if (typeof sm.persisted === 'function') {
        try {
            persisted = await sm.persisted();
        } catch {
            persisted = null;
        }
    }

    return { supported, usageBytes, quotaBytes, indexedDbBytes, persisted };
}

/**
 * 申请持久化许可。
 *
 * 各家给法不一样：Chrome 从不弹框，按站点参与度（装没装到主屏、给没给通知权限）自己判；
 * Firefox 会弹权限框；Safari 看有没有被加到主屏。所以「申请失败」很正常，界面上要给用户
 * 说清楚怎么提高成功率，而不是让他对着一个红字干瞪眼。
 */
export async function requestPersistentStorage(): Promise<boolean> {
    const sm = getStorageManager();
    if (!sm || typeof sm.persist !== 'function') return false;
    try {
        return await sm.persist();
    } catch {
        return false;
    }
}

// ─── 分类 ──────────────────────────────────────────────────────

export type StorageCategoryKey = 'media' | 'chat' | 'characters' | 'memory' | 'activeMsg' | 'other';

export const STORAGE_CATEGORY_LABELS: Record<StorageCategoryKey, string> = {
    media: '图片与媒体',
    chat: '聊天记录',
    characters: '角色与模型',
    memory: '记忆宫殿',
    activeMsg: '主动消息',
    other: '其他 App 数据',
};

/** 显示顺序：大头在前，「其他」永远垫底。 */
export const STORAGE_CATEGORY_ORDER: StorageCategoryKey[] = ['media', 'chat', 'characters', 'memory', 'activeMsg', 'other'];

/**
 * 表名 → 类别。没列进来的表一律落到 other，所以以后新加表不会从统计里消失，
 * 只是暂时归在「其他 App 数据」里 —— 总量永远是对的。
 */
const STORE_CATEGORY: Record<string, StorageCategoryKey> = {
    // 聊天
    messages: 'chat',
    groups: 'chat',
    scheduled_messages: 'chat',
    // 角色
    characters: 'characters',
    character_groups: 'characters',
    worldbooks: 'characters',
    cc_custom_parts: 'characters',
    // 图片 / 外观
    assets: 'media',
    emojis: 'media',
    emoji_categories: 'media',
    gallery: 'media',
    themes: 'media',
    journal_stickers: 'media',
    // 记忆宫殿
    memory_nodes: 'memory',
    memory_vectors: 'memory',
    memory_links: 'memory',
    memory_batches: 'memory',
    topic_boxes: 'memory',
    anticipations: 'memory',
    event_boxes: 'memory',
    room_plates: 'memory',
    digest_reports: 'memory',
};

/** 图片和模型混住的那张表，二进制部分要按 MIME 二次分流。 */
const MIXED_BLOB_STORE = 'blob_assets';

export function categoryOfStore(storeName: string): StorageCategoryKey {
    return STORE_CATEGORY[storeName] ?? 'other';
}

// ─── 单条记录的字节测量 ─────────────────────────────────────────

/** 二进制在 JSON 里的占位符，长度固定，不影响量级判断。 */
const BINARY_PLACEHOLDER = '"~bin~"';

export type BinaryKind = 'image' | 'audio' | 'video' | 'binary';

/** MIME 归一化：只关心「这是图、是声音、还是一坨二进制」。 */
export function binaryKindOfMime(mime: string | undefined | null): BinaryKind {
    const m = (mime || '').toLowerCase();
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('audio/')) return 'audio';
    if (m.startsWith('video/')) return 'video';
    return 'binary';
}

export interface ValueMeasurement {
    bytes: number;
    /** 其中二进制部分按种类拆开，供 blob_assets 二次分流用。 */
    binaryBytes: Partial<Record<BinaryKind, number>>;
}

/**
 * 测一条记录多大。
 *
 * 走 JSON.stringify 的 replacer 一次遍历搞定：文本部分交给原生序列化（比手写递归快得多），
 * 二进制（Blob / ArrayBuffer / TypedArray）在 replacer 里换成占位符并单独累加 —— 否则
 * Float32Array 会被 stringify 成 {"0":..,"1":..} 那种巨型字符串，又慢又把数字撑到天上去。
 */
export function measureValue(value: unknown): ValueMeasurement {
    const binaryBytes: Partial<Record<BinaryKind, number>> = {};
    const addBinary = (kind: BinaryKind, size: number) => {
        binaryBytes[kind] = (binaryBytes[kind] ?? 0) + size;
    };

    let json = '';
    try {
        json = JSON.stringify(value, (_key, val) => {
            if (typeof Blob !== 'undefined' && val instanceof Blob) {
                addBinary(binaryKindOfMime(val.type), val.size);
                return BINARY_PLACEHOLDER;
            }
            if (val instanceof ArrayBuffer) {
                addBinary('binary', val.byteLength);
                return BINARY_PLACEHOLDER;
            }
            if (ArrayBuffer.isView(val)) {
                addBinary('binary', (val as ArrayBufferView).byteLength);
                return BINARY_PLACEHOLDER;
            }
            return val;
        }) ?? '';
    } catch {
        // 循环引用 / 带 getter 抛错的对象：文本部分算不出来就算了，
        // 二进制那部分 replacer 已经数过的仍然作数。
        json = '';
    }

    let textBytes = 0;
    if (json) {
        try {
            textBytes = new TextEncoder().encode(json).length;
        } catch {
            textBytes = json.length;
        }
    }

    const binaryTotal = Object.values(binaryBytes).reduce((a, b) => a + (b ?? 0), 0);
    return { bytes: textBytes + binaryTotal, binaryBytes };
}

// ─── 单张表的测量 ───────────────────────────────────────────────

/** 普通表最多实测多少条，超了就跳着采样。 */
export const SAMPLE_LIMIT = 300;
/** 二进制表（只读 blob.size，很便宜）的全量上限，超了同样退回采样。 */
export const BLOB_FULL_SCAN_LIMIT = 20000;

export interface StoreUsage {
    store: string;
    bytes: number;
    /** 记录条数（精确，来自 count()）。 */
    count: number;
    /** true = 数字是采样放大出来的，界面上要标「约」。 */
    estimated: boolean;
    binaryBytes: Partial<Record<BinaryKind, number>>;
}

const countStore = (db: IDBDatabase, storeName: string): Promise<number> =>
    new Promise((resolve, reject) => {
        const req = db.transaction(storeName, 'readonly').objectStore(storeName).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

/**
 * 测一张表。
 *
 * 采样是「均匀跳着取」而不是「取前 N 条」—— 后者在 messages 上会全采到最早那批短消息，
 * 把带图的长消息整个漏掉，估出来的数能差一个量级。
 */
export async function measureStoreUsage(db: IDBDatabase, storeName: string): Promise<StoreUsage> {
    const empty: StoreUsage = { store: storeName, bytes: 0, count: 0, estimated: false, binaryBytes: {} };
    const count = await countStore(db, storeName);
    if (count === 0) return empty;

    const fullScanLimit = storeName === MIXED_BLOB_STORE ? BLOB_FULL_SCAN_LIMIT : SAMPLE_LIMIT;
    // 步长用 ceil 而不是 floor：floor 会让 step * limit < count，采满上限时游标才走到
    // 表的中段，尾巴整段没被采到 —— 而聊天记录恰恰是越靠后的越大，一漏就低估三成。
    const step = count <= fullScanLimit ? 1 : Math.max(1, Math.ceil(count / fullScanLimit));

    return new Promise<StoreUsage>((resolve, reject) => {
        const binaryBytes: Partial<Record<BinaryKind, number>> = {};
        let sampledBytes = 0;
        let sampled = 0;

        const req = db.transaction(storeName, 'readonly').objectStore(storeName).openCursor();
        const finish = () => {
            if (sampled === 0) { resolve({ ...empty, count }); return; }
            const scale = step === 1 ? 1 : count / sampled;
            const scaled = (n: number) => Math.round(n * scale);
            const scaledBinary: Partial<Record<BinaryKind, number>> = {};
            for (const [kind, bytes] of Object.entries(binaryBytes)) {
                scaledBinary[kind as BinaryKind] = scaled(bytes ?? 0);
            }
            resolve({
                store: storeName,
                bytes: scaled(sampledBytes),
                count,
                estimated: step !== 1,
                binaryBytes: scaledBinary,
            });
        };

        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) { finish(); return; }
            const m = measureValue(cursor.value);
            sampledBytes += m.bytes;
            for (const [kind, bytes] of Object.entries(m.binaryBytes)) {
                binaryBytes[kind as BinaryKind] = (binaryBytes[kind as BinaryKind] ?? 0) + (bytes ?? 0);
            }
            sampled++;
            if (sampled >= fullScanLimit) { finish(); return; }
            try {
                cursor.advance(step);
            } catch {
                finish();
            }
        };
        req.onerror = () => reject(req.error);
    });
}

// ─── 整库遍历 ──────────────────────────────────────────────────

const yieldToMain = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export interface DatabaseUsage {
    stores: StoreUsage[];
    /** 读不出来的表只记名字，不阻断整体统计。 */
    failed: string[];
}

/** 挨张表测过去，表与表之间让出主线程，避免统计过程把界面冻住。 */
export async function collectDatabaseUsage(
    db: IDBDatabase,
    onProgress?: (done: number, total: number) => void,
): Promise<DatabaseUsage> {
    const names = Array.from(db.objectStoreNames);
    const stores: StoreUsage[] = [];
    const failed: string[] = [];
    for (let i = 0; i < names.length; i++) {
        try {
            stores.push(await measureStoreUsage(db, names[i]));
        } catch {
            failed.push(names[i]);
        }
        onProgress?.(i + 1, names.length);
        await yieldToMain();
    }
    return { stores, failed };
}

// ─── 汇总成用户看的那几行 ───────────────────────────────────────

export interface StorageCategoryUsage {
    key: StorageCategoryKey;
    label: string;
    bytes: number;
    estimated: boolean;
    /**
     * 这一类里属于二进制（Blob）的字节数。校准时它原样不动——Blob 在 IndexedDB 里
     * 独立落盘，不跟着 LevelDB 压缩走，量到多少就是多少。
     */
    binaryBytes: number;
}

export interface StorageBreakdown {
    categories: StorageCategoryUsage[];
    totalBytes: number;
    failedStores: string[];
    /** 数字有没有按浏览器实报的用量折算过（见 calibrateBreakdown）。 */
    calibrated: boolean;
}

/** 一个库的逐表结果 + 这个库整体该归哪类（null = 按表名逐个判）。 */
export interface DatabaseUsageInput {
    usage: DatabaseUsage;
    forceCategory?: StorageCategoryKey;
}

/**
 * 把逐表字节数并成用户看的那几行。
 *
 * blob_assets 在这里拆开：图片 / 语音 / 视频算「图片与媒体」，剩下的二进制当模型算
 * 「角色与模型」，那张表自己的文本开销（id 之类）跟着图片走。
 */
export function summarizeUsage(inputs: DatabaseUsageInput[]): StorageBreakdown {
    const bytes: Record<StorageCategoryKey, number> = { media: 0, chat: 0, characters: 0, memory: 0, activeMsg: 0, other: 0 };
    const binary: Record<StorageCategoryKey, number> = { media: 0, chat: 0, characters: 0, memory: 0, activeMsg: 0, other: 0 };
    const estimated: Record<StorageCategoryKey, boolean> = { media: false, chat: false, characters: false, memory: false, activeMsg: false, other: false };
    const failedStores: string[] = [];
    const sumBinary = (b: Partial<Record<BinaryKind, number>>) =>
        Object.values(b).reduce((a: number, v) => a + (v ?? 0), 0);

    for (const { usage, forceCategory } of inputs) {
        failedStores.push(...usage.failed);
        for (const store of usage.stores) {
            if (store.bytes <= 0) continue;
            if (!forceCategory && store.store === MIXED_BLOB_STORE) {
                const bin = store.binaryBytes;
                const modelBytes = bin.binary ?? 0;
                const mediaBytes = store.bytes - modelBytes;
                if (modelBytes > 0) {
                    bytes.characters += modelBytes;
                    binary.characters += modelBytes;
                    estimated.characters ||= store.estimated;
                }
                if (mediaBytes > 0) {
                    bytes.media += mediaBytes;
                    // mediaBytes 里除了图片/语音的二进制，还含这张表自己的文本开销（id 之类）
                    binary.media += Math.min(mediaBytes, sumBinary(bin) - modelBytes);
                    estimated.media ||= store.estimated;
                }
                continue;
            }
            const key = forceCategory ?? categoryOfStore(store.store);
            bytes[key] += store.bytes;
            binary[key] += Math.min(store.bytes, sumBinary(store.binaryBytes));
            estimated[key] ||= store.estimated;
        }
    }

    const categories = STORAGE_CATEGORY_ORDER
        .map(key => ({
            key, label: STORAGE_CATEGORY_LABELS[key],
            bytes: bytes[key], binaryBytes: binary[key], estimated: estimated[key],
        }))
        .filter(c => c.bytes > 0)
        .sort((a, b) => {
            if (a.key === 'other') return 1;
            if (b.key === 'other') return -1;
            return b.bytes - a.bytes;
        });

    return {
        categories,
        totalBytes: categories.reduce((sum, c) => sum + c.bytes, 0),
        failedStores,
        calibrated: false,
    };
}

/**
 * 按浏览器实报的 IndexedDB 用量折算文本部分。
 *
 * 我们量的是数据的原始字节，而 Chrome 的 IndexedDB（LevelDB 后端）落盘时会压一道，
 * 于是细分合计经常比 estimate() 报的总量还大——界面上出现「一共 180 MB、细分加起来
 * 227 MB」纯粹是在误导人。Blob 不参与那道压缩（独立落盘），所以只折算文本那半。
 *
 * 只在我们量得偏大时折算。量出来比实报还小，说明有没扫到的库或别的来源，那该由
 * 界面上的「其他占用」交代，把数字硬放大只是编圆了它。
 */
export function calibrateBreakdown(breakdown: StorageBreakdown, actualBytes: number | null): StorageBreakdown {
    if (actualBytes == null || !Number.isFinite(actualBytes) || actualBytes <= 0) return breakdown;

    const binaryTotal = breakdown.categories.reduce((n, c) => n + c.binaryBytes, 0);
    const textTotal = breakdown.totalBytes - binaryTotal;
    if (textTotal <= 0) return breakdown;

    // 二进制先占掉实报的一部分，剩下的才是文本能分的
    const textActual = actualBytes - binaryTotal;
    if (textActual <= 0) return breakdown;      // 二进制就撑满了：多半是实报口径不同，别硬折
    const ratio = textActual / textTotal;
    if (ratio >= 1) return breakdown;           // 我们没有高估，交给「其他占用」去说

    const categories = breakdown.categories.map(c => {
        const text = Math.max(0, c.bytes - c.binaryBytes);
        return { ...c, bytes: Math.round(c.binaryBytes + text * ratio) };
    });
    return {
        ...breakdown,
        categories,
        totalBytes: categories.reduce((sum, c) => sum + c.bytes, 0),
        calibrated: true,
    };
}

// ─── 字节数格式化 ──────────────────────────────────────────────

/** 给界面用的人话大小。null / 负数一律回「—」，不要显示 0 B 骗人。 */
export function formatBytes(bytes: number | null | undefined): string {
    if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
}

// ─── 编排：把本站所有 IndexedDB 库跑一遍 ────────────────────────

/** 整库归类的库名。没列的库按表名逐表判，最终多半落到「其他 App 数据」。 */
const DATABASE_CATEGORY: Record<string, StorageCategoryKey> = {
    ActiveMsg: 'activeMsg',
};

/** 浏览器不给枚举库列表时的兜底名单（主库单独走 openDB，不在这里）。 */
const FALLBACK_DATABASE_NAMES = ['ActiveMsg'];

const MAIN_DATABASE_NAME = 'AetherOS_Data';

async function listDatabaseNames(): Promise<string[]> {
    if (typeof indexedDB === 'undefined') return [];
    const anyIdb = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
    if (typeof anyIdb.databases !== 'function') return [...FALLBACK_DATABASE_NAMES];
    try {
        const list = await anyIdb.databases();
        return list.map(d => d.name).filter((n): n is string => !!n);
    } catch {
        return [...FALLBACK_DATABASE_NAMES];
    }
}

/**
 * 只连已经存在的库。
 *
 * 不带版本号 open 一个不存在的库会把它凭空建出来 —— 统计功能绝不能有这种副作用，
 * 所以一旦触发 upgradeneeded（说明是新建的）就立刻关掉删掉当没发生过。
 */
function openExistingDatabase(name: string): Promise<IDBDatabase | null> {
    return new Promise(resolve => {
        let created = false;
        let req: IDBOpenDBRequest;
        try {
            req = indexedDB.open(name);
        } catch {
            resolve(null);
            return;
        }
        req.onupgradeneeded = () => { created = true; };
        req.onsuccess = () => {
            const db = req.result;
            if (created) {
                db.close();
                let del: IDBOpenDBRequest | null = null;
                try {
                    del = indexedDB.deleteDatabase(name);
                } catch {
                    resolve(null); // 删不掉就算了，空库无害
                    return;
                }
                // 等删干净再往下走，别让「刚建出来的空库」在调用方眼皮底下一闪而过
                const done = () => resolve(null);
                del.onsuccess = done;
                del.onerror = done;
                del.onblocked = done;
                return;
            }
            resolve(db);
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
    });
}

export interface BreakdownProgress {
    /** 已测完的表数 / 总表数，够界面显示个「计算中 12/68」了。 */
    done: number;
    total: number;
}

/**
 * 跑一遍本站所有 IndexedDB，算出各类别占多少。
 *
 * 注意返回的 totalBytes 只是 IndexedDB 的量，一般会小于 estimate() 报的总用量 ——
 * 差的那部分是 Cache Storage（PWA 离线缓存的 JS / 图片）之类，不归我们管也删不动。
 * 界面上把差额单独交代一句，别让用户以为数字对不上。
 */
export async function computeStorageBreakdown(
    onProgress?: (p: BreakdownProgress) => void,
): Promise<StorageBreakdown> {
    const opened: { db: IDBDatabase; category?: StorageCategoryKey; shouldClose: boolean }[] = [];

    try {
        opened.push({ db: await openDB(), shouldClose: false });
    } catch {
        // 主库都连不上就没什么可统计的了，继续往下走让辅助库有机会被算到
    }

    for (const name of await listDatabaseNames()) {
        if (opened.some(entry => entry.db.name === name)) continue;
        const db = await openExistingDatabase(name);
        if (db) opened.push({ db, category: DATABASE_CATEGORY[name], shouldClose: true });
    }

    const total = opened.reduce((n, e) => n + e.db.objectStoreNames.length, 0);
    onProgress?.({ done: 0, total });

    const inputs: DatabaseUsageInput[] = [];
    let done = 0;
    try {
        for (const entry of opened) {
            const usage = await collectDatabaseUsage(entry.db, d => onProgress?.({ done: done + d, total }));
            done += entry.db.objectStoreNames.length;
            inputs.push({ usage, forceCategory: entry.category });
        }
    } finally {
        for (const entry of opened) {
            if (entry.shouldClose) { try { entry.db.close(); } catch { /* 已经关了 */ } }
        }
    }

    // 折算要用浏览器实报的 IndexedDB 用量；读不到（非 Chrome）就照原始字节显示
    const overview = await readStorageOverview();
    return calibrateBreakdown(summarizeUsage(inputs), overview.indexedDbBytes);
}
