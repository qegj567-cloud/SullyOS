/**
 * Memory Palace — IndexedDB CRUD 操作
 *
 * 封装 6 张表的增删改查，复用主 db.ts 的 openDB()。
 */

import { openDB } from '../db';
import type {
    MemoryNode, MemoryVector, MemoryLink, MemoryBatch,
    TopicBox, Anticipation, MemoryRoom, BoxStatus, AnticipationStatus,
    EventBox, RoomPlate, PlateRoom, DigestReport,
} from './types';
import { DIGEST_REPORT_KEEP, EVENT_BOX_SEAL_THRESHOLD } from './types';
import { bm25Index } from './bm25Index';
import { notifyMemoryNodesChanged } from './nodeChanges';
import { compactMemoryLink } from './linkPrecision';
import type { VectorIndexEntry as VectorBackupIndexEntry } from '../backupFormat';

// ─── Store 名称常量 ────────────────────────────────────

const STORE_MEMORY_NODES   = 'memory_nodes';
const STORE_MEMORY_VECTORS = 'memory_vectors';
const STORE_MEMORY_LINKS   = 'memory_links';
const STORE_MEMORY_BATCHES = 'memory_batches';
const STORE_TOPIC_BOXES    = 'topic_boxes';
const STORE_ANTICIPATIONS  = 'anticipations';
const STORE_EVENT_BOXES    = 'event_boxes';
const STORE_ROOM_PLATES    = 'room_plates';
const STORE_DIGEST_REPORTS = 'digest_reports';

// ─── 通用辅助 ──────────────────────────────────────────

/** 通用 getAll by index */
async function getAllByIndex<T>(
    storeName: string, indexName: string, value: IDBValidKey
): Promise<T[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const index = store.index(indexName);
        const req = index.getAll(IDBKeyRange.only(value));
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

/** 通用 put */
async function put<T>(storeName: string, data: T): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(data);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** 通用 get by key */
async function getByKey<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** 通用 delete by key */
async function deleteByKey(storeName: string, key: IDBValidKey): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** 通用 getAll (全表) */
async function getAll<T>(storeName: string): Promise<T[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

// ─── MemoryNode CRUD ──────────────────────────────────

/** 读取远程向量配置（轻量，仅 localStorage 读取） */
function getRemoteVectorConfig(): { enabled: boolean; supabaseUrl: string; supabaseAnonKey: string; initialized: boolean } | null {
    try {
        const raw = localStorage.getItem('os_remote_vector_config');
        if (!raw) return null;
        const c = JSON.parse(raw);
        return (c.enabled && c.initialized) ? c : null;
    } catch { return null; }
}

/** save 后自动同步已向量化节点的 metadata 到远程 */
function syncNodeMetadataToRemote(node: MemoryNode): void {
    if (!node.embedded) return;
    const rc = getRemoteVectorConfig();
    if (!rc) return;
    // 懒加载 + fire-and-forget
    import('./supabaseVector').then(({ upsertVector }) => {
        // 只更新 metadata（room/importance/tags/mood/content），需要拿到向量
        getByKey<MemoryVector>(STORE_MEMORY_VECTORS, node.id).then(vec => {
            if (!vec) return;
            // ensureFloat32 兼容旧 number[] / 新 Uint8Array / 内存中的 Float32Array
            // 三种形态，都解码成 Float32Array 喂给 supabase。
            const vector = ensureFloat32(vec.vector);
            upsertVector(rc, node.id, node.charId, vector, node, vec.dimensions, vec.model).catch(() => {});
        });
    }).catch(() => {});
}

export const MemoryNodeDB = {
    /** A vectorized batch is all-or-nothing: never expose new text with missing/old vectors. */
    saveVectorizedMany: async (entries: { node: MemoryNode; vector: MemoryVector }[]): Promise<void> => {
        if (!entries.length) return;
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction([STORE_MEMORY_NODES, STORE_MEMORY_VECTORS], 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('记忆和向量保存已回滚'));
            try {
                for (const { node, vector } of entries) {
                    tx.objectStore(STORE_MEMORY_NODES).put(node);
                    tx.objectStore(STORE_MEMORY_VECTORS).put({ ...vector, vector: vecForStorage(vector.vector) });
                }
            } catch (error) { tx.abort(); reject(error); }
        });
        bm25Index.onNodesSaved(entries.map(entry => entry.node));
        for (const charId of new Set(entries.map(entry => entry.node.charId))) notifyMemoryNodesChanged(charId);
    },
    save: async (node: MemoryNode) => {
        await put<MemoryNode>(STORE_MEMORY_NODES, node);
        // 写入验证：确认数据真的持久化了
        const verify = await getByKey<MemoryNode>(STORE_MEMORY_NODES, node.id);
        if (!verify) {
            console.error(`❌ [MemoryNodeDB] WRITE VERIFICATION FAILED for ${node.id}`);
            throw new Error(`Memory node write failed: ${node.id}`);
        }
        // BM25 倒排索引：内部按 contentSig 判断是否需要重新 tokenize，
        // touchAccess 之类只改 metadata 的写入会被自动跳过。
        bm25Index.onNodeSaved(node);
        syncNodeMetadataToRemote(node);
        notifyMemoryNodesChanged(node.charId);
    },

    getById: (id: string) => getByKey<MemoryNode>(STORE_MEMORY_NODES, id),

    delete: async (id: string) => {
        await deleteByKey(STORE_MEMORY_NODES, id);
        bm25Index.onNodeDeleted(id);
        notifyMemoryNodesChanged();
    },

    getByCharId: (charId: string) =>
        getAllByIndex<MemoryNode>(STORE_MEMORY_NODES, 'charId', charId),

    getByRoom: (charId: string, room: MemoryRoom): Promise<MemoryNode[]> =>
        getAllByIndex<MemoryNode>(STORE_MEMORY_NODES, 'charId', charId)
            .then(nodes => nodes.filter(n => n.room === room)),

    getUnembedded: (charId: string): Promise<MemoryNode[]> =>
        getAllByIndex<MemoryNode>(STORE_MEMORY_NODES, 'charId', charId)
            .then(nodes => nodes.filter(n => !n.embedded)),

    /** @deprecated 旧话题盒 ID 查询，保留以兼容残留数据；新代码请用 getByEventBoxId */
    getByBoxId: (boxId: string) =>
        getAllByIndex<MemoryNode>(STORE_MEMORY_NODES, 'boxId', boxId),

    /** 按 EventBox ID 查询所属记忆节点（含 live + archived + summary） */
    getByEventBoxId: (eventBoxId: string) =>
        getAllByIndex<MemoryNode>(STORE_MEMORY_NODES, 'eventBoxId', eventBoxId),

    /** 批量保存 */
    saveMany: async (nodes: MemoryNode[]): Promise<void> => {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_MEMORY_NODES, 'readwrite');
            const store = tx.objectStore(STORE_MEMORY_NODES);
            for (const node of nodes) {
                store.put(node);
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        bm25Index.onNodesSaved(nodes);
        for (const charId of new Set(nodes.map(node => node.charId))) notifyMemoryNodesChanged(charId);
    },

    /** 更新访问记录（检索后调用） */
    touchAccess: async (id: string): Promise<void> => {
        const node = await getByKey<MemoryNode>(STORE_MEMORY_NODES, id);
        if (!node) return;
        node.lastAccessedAt = Date.now();
        node.accessCount += 1;
        await put<MemoryNode>(STORE_MEMORY_NODES, node);
        syncNodeMetadataToRemote(node);
    },
};

// ─── Float32Array 工具 ───────────────────────────────
//
// 历史包袱：早期版本把 Float32Array 用 Array.from() 转成普通 number[] 存进
// IndexedDB，结果每个 number 是 V8 的 boxed double（约 50 字节），1024 维
// 向量在磁盘上膨胀到 ~50 KB / 条，10k 向量就 500 MB+。
//
// 现在改成存 Uint8Array（直接拿 Float32 的底层字节）：4 字节 / 维度无损，
// ~12-13× 缩盘，读取时一行 new Float32Array(buf) 零拷贝转回去，余弦相似度
// 算出来字节级一致 — 召回效果与旧格式完全等同。
//
// 旧 number[] 数据读取时会被透明地转为 Float32Array，下次 saveMany 写回会
// 自动持久化为 Uint8Array；getAllByCharId 还会顺手做批量迁移。

/** 解码任一储存形态为 Float32Array（零拷贝走 Uint8Array.buffer 路径） */
export function ensureFloat32(vec: number[] | Float32Array | Uint8Array): Float32Array {
    if (vec instanceof Float32Array) return vec;
    if (vec instanceof Uint8Array) {
        // IndexedDB 结构化克隆给的是新 ArrayBuffer，可以直接 view 不用复制。
        return new Float32Array(vec.buffer, vec.byteOffset, vec.byteLength >>> 2);
    }
    // 旧 number[] 路径
    return new Float32Array(vec);
}

/**
 * 把 memory_vectors 的原始记录归一化成「Float32 原始字节拼成的一根 bin + 索引」，供 v2 备份的
 * 向量二进制旁路使用（见 utils/backupFormat.ts）。vector 可能是 Uint8Array（已迁移）/ Float32Array /
 * 遗留 number[]，必须先过 ensureFloat32 统一——遗留 number[] 不归一化直接当字节读会写出无效数据（R4·F4）。
 * dimensions 用实际 f32 长度，钉死 byteLength === dimensions*4 不变量（导入端据此校验）。
 */
export function encodeVectorsForBackup(
    rawVectors: Array<{ memoryId?: string; charId?: string; dimensions?: number; model?: string; vector?: unknown }>,
): { bin: Uint8Array; index: VectorBackupIndexEntry[] } {
    const index: VectorBackupIndexEntry[] = [];
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (const v of rawVectors) {
        if (!v || !v.vector || !v.memoryId) continue;
        const f32 = ensureFloat32(v.vector as number[] | Float32Array | Uint8Array);
        const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
        parts.push(bytes);
        index.push({
            memoryId: v.memoryId,
            charId: (v.charId ?? '') as string,
            dimensions: f32.length,
            model: v.model,
            byteOffset: offset,
            byteLength: bytes.byteLength,
        });
        offset += bytes.byteLength;
    }
    const bin = new Uint8Array(offset);
    let p = 0;
    for (const part of parts) { bin.set(part, p); p += part.byteLength; }
    return { bin, index };
}

type RawBackupVector = {
    memoryId?: string;
    charId?: string;
    dimensions?: number;
    model?: string;
    vector?: unknown;
};

/**
 * 低内存向量备份编码：调用方提供一个可重复执行的分批扫描器，本函数第一遍只统计总字节数
 * 和索引，第二遍才把每批字节拷进最终 bin。这样 4500+ 条旧 number[] 向量不会与最终 bin
 * 同时整表驻留；峰值约为「最终紧凑 bin + 一个小批次」，备份格式仍与旧版完全一致。
 *
 * 两遍之间若数据发生变化会中止并给出明确错误，避免生成索引与 bin 错位的损坏备份。
 */
export async function encodeVectorsForBackupChunked(
    scanBatches: (onBatch: (batch: RawBackupVector[]) => void) => Promise<void>,
): Promise<{ bin: Uint8Array; index: VectorBackupIndexEntry[] }> {
    const index: VectorBackupIndexEntry[] = [];
    let totalBytes = 0;

    await scanBatches((batch) => {
        const encoded = encodeVectorsForBackup(batch);
        for (const entry of encoded.index) {
            index.push({ ...entry, byteOffset: entry.byteOffset + totalBytes });
        }
        totalBytes += encoded.bin.byteLength;
    });

    const bin = new Uint8Array(totalBytes);
    let byteCursor = 0;
    let indexCursor = 0;

    await scanBatches((batch) => {
        const encoded = encodeVectorsForBackup(batch);
        if (byteCursor + encoded.bin.byteLength > bin.byteLength) {
            throw new Error('备份期间记忆向量发生变化，请等待记忆宫殿处理完成后重试。');
        }
        for (const entry of encoded.index) {
            const expected = index[indexCursor++];
            if (!expected
                || expected.memoryId !== entry.memoryId
                || expected.charId !== entry.charId
                || expected.dimensions !== entry.dimensions
                || expected.model !== entry.model
                || expected.byteOffset !== byteCursor + entry.byteOffset
                || expected.byteLength !== entry.byteLength) {
                throw new Error('备份期间记忆向量发生变化，请等待记忆宫殿处理完成后重试。');
            }
        }
        bin.set(encoded.bin, byteCursor);
        byteCursor += encoded.bin.byteLength;
    });

    if (byteCursor !== totalBytes || indexCursor !== index.length) {
        throw new Error('备份期间记忆向量发生变化，请等待记忆宫殿处理完成后重试。');
    }
    return { bin, index };
}

/** 编码为 IndexedDB 存储形态（Uint8Array of Float32 raw bytes） */
function vecForStorage(vec: number[] | Float32Array | Uint8Array): Uint8Array {
    if (vec instanceof Uint8Array) return vec;
    const f32 = vec instanceof Float32Array ? vec : new Float32Array(vec);
    return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** 该向量是否还是旧 number[] 形态（用于判断是否需要迁移写回） */
function isLegacyVec(vec: unknown): boolean {
    return Array.isArray(vec);
}

// ─── MemoryVector CRUD ────────────────────────────────

export const MemoryVectorDB = {
    save: async (vec: MemoryVector) => {
        const stored = { ...vec, vector: vecForStorage(vec.vector) };
        await put<MemoryVector>(STORE_MEMORY_VECTORS, stored);
        // 写入验证
        const verify = await getByKey<MemoryVector>(STORE_MEMORY_VECTORS, vec.memoryId);
        if (!verify) {
            console.error(`❌ [MemoryVectorDB] WRITE VERIFICATION FAILED for ${vec.memoryId}`);
            throw new Error(`Memory vector write failed: ${vec.memoryId}`);
        }
    },

    getByMemoryId: async (memoryId: string): Promise<MemoryVector | undefined> => {
        const v = await getByKey<MemoryVector>(STORE_MEMORY_VECTORS, memoryId);
        if (!v) return undefined;
        return { ...v, vector: ensureFloat32(v.vector) };
    },

    delete: (memoryId: string) => deleteByKey(STORE_MEMORY_VECTORS, memoryId),

    /**
     * 获取角色的全部向量 — 优先使用 charId 索引直查，避免全表扫描。
     * 向量出 DB 层一律是 Float32Array。读到旧 number[] 形态会顺手在背景
     * 重写为 Uint8Array，以渐进释放磁盘空间（首次访问后省 ~12×）。
     *
     * 迁移用的是 IDB cursor.update() 而不是先快照再 put — 后者会跟用户
     * 并发的 vec.save() 撞车（快照里是旧向量、save 写入新向量、迁移后再
     * 用旧向量覆盖 = 静默数据丢失）。cursor 在同一个 readwrite tx 里读改
     * 写，IDB 自动顺序化，无论谁先到都能保留最新数据。
     *
     * 兼容旧数据（无 charId 字段）：回退到 memory_nodes 联合查询。
     */
    getAllByCharId: async (charId: string): Promise<MemoryVector[]> => {
        // 后台游标迁移 — 按 charId 索引扫这个角色的向量记录，发现还是
        // number[] 形态的就 cursor.update() 写回 Uint8Array。
        const migrateLegacyByCharId = (charId: string): void => {
            (async () => {
                try {
                    const db = await openDB();
                    const tx = db.transaction(STORE_MEMORY_VECTORS, 'readwrite');
                    const store = tx.objectStore(STORE_MEMORY_VECTORS);
                    const idx = store.index('charId');
                    const req = idx.openCursor(IDBKeyRange.only(charId));
                    req.onsuccess = () => {
                        const cursor = req.result;
                        if (!cursor) return;
                        const v = cursor.value;
                        // 此时 cursor.value 是 IDB 当前最新值，如果用户刚 save
                        // 过，这里读到的已是 Uint8Array，会被下面的检查跳过。
                        if (isLegacyVec(v.vector)) {
                            cursor.update({ ...v, vector: vecForStorage(v.vector) });
                        }
                        cursor.continue();
                    };
                } catch (e) {
                    console.warn('[MemoryVectorDB] cursor migration failed', e);
                }
            })();
        };

        // 尝试通过 charId 索引直查（新数据路径）
        try {
            const indexed = await getAllByIndex<MemoryVector>(STORE_MEMORY_VECTORS, 'charId', charId);
            if (indexed.length > 0) {
                if (indexed.some(v => isLegacyVec(v.vector))) {
                    migrateLegacyByCharId(charId);
                }
                return indexed.map(v => ({ ...v, vector: ensureFloat32(v.vector) }));
            }
        } catch {
            // 索引不存在（旧版本 DB），走兼容路径
        }

        // 兼容旧数据回退：通过 memory_nodes 联合查询
        const nodes = await getAllByIndex<MemoryNode>(STORE_MEMORY_NODES, 'charId', charId);
        const embeddedIds = new Set(nodes.filter(n => n.embedded).map(n => n.id));
        if (embeddedIds.size === 0) return [];

        const allVectors = await getAll<MemoryVector>(STORE_MEMORY_VECTORS);
        const matched = allVectors.filter(v => embeddedIds.has(v.memoryId));

        // 回填 charId + 顺手把旧 number[] 升级到 Uint8Array — 这里也走
        // cursor.update 避免覆盖并发 save。primaryKey 直查每条记录的 cursor。
        if (matched.length > 0) {
            (async () => {
                try {
                    const db = await openDB();
                    const tx = db.transaction(STORE_MEMORY_VECTORS, 'readwrite');
                    const store = tx.objectStore(STORE_MEMORY_VECTORS);
                    for (const m of matched) {
                        const req = store.openCursor(IDBKeyRange.only(m.memoryId));
                        req.onsuccess = () => {
                            const cursor = req.result;
                            if (!cursor) return;
                            const cur = cursor.value;
                            const needsCharId = !cur.charId;
                            const needsMigration = isLegacyVec(cur.vector);
                            if (needsCharId || needsMigration) {
                                cursor.update({
                                    ...cur,
                                    charId: cur.charId || charId,
                                    vector: vecForStorage(cur.vector),
                                });
                            }
                        };
                    }
                } catch (e) {
                    console.warn('[MemoryVectorDB] charId backfill failed', e);
                }
            })();
        }

        return matched.map(v => ({ ...v, charId, vector: ensureFloat32(v.vector) }));
    },

    /** 批量保存 */
    saveMany: async (vectors: MemoryVector[]): Promise<void> => {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_MEMORY_VECTORS, 'readwrite');
            const store = tx.objectStore(STORE_MEMORY_VECTORS);
            for (const vec of vectors) {
                store.put({ ...vec, vector: vecForStorage(vec.vector) });
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    /**
     * 一次性扫描整个向量表，把还停留在 number[] 老格式的记录全部升级为
     * Uint8Array 紧凑存储。OSContext 启动时调用一次；用户首次进 App 后
     * 12× 释放磁盘。已经是新格式的记录会被跳过，重复调用幂等无副作用。
     *
     * 用 cursor.update() 而不是先快照再 put 避免并发 save 数据丢失。
     *
     * 分批 tx：每批 500 条用一个独立 readwrite tx，批间 setTimeout(50)
     * 让其他向量搜索/save tx 有机会插队，避免 10k 向量的重度用户感受到
     * 长达 10s 的全局停顿。
     *
     * @param onProgress 收到 (migrated, scanned) 的回调，用于上层 UI 显示进度
     * @returns 实际被升级的记录数
     */
    scanAndMigrateLegacy: async (
        onProgress?: (migrated: number, scanned: number) => void,
    ): Promise<number> => {
        const BATCH_SIZE = 500;
        let migrated = 0;
        let scanned = 0;
        let lastKey: IDBValidKey | null = null;
        let done = false;

        while (!done) {
            const batch = await new Promise<{
                migrated: number; scanned: number; lastKey: IDBValidKey | null; done: boolean;
            }>(async (resolve, reject) => {
                try {
                    const db = await openDB();
                    const tx = db.transaction(STORE_MEMORY_VECTORS, 'readwrite');
                    const store = tx.objectStore(STORE_MEMORY_VECTORS);
                    const range = lastKey !== null
                        ? IDBKeyRange.lowerBound(lastKey, true)  // exclusive 跳过已扫的
                        : undefined;
                    const req = store.openCursor(range);
                    let bMig = 0, bScan = 0;
                    let bLast: IDBValidKey | null = lastKey;
                    let bDone = false;

                    req.onsuccess = () => {
                        const cursor = req.result;
                        if (!cursor) { bDone = true; return; }
                        if (bScan >= BATCH_SIZE) return; // 不再 continue，等 tx 自己关
                        const v = cursor.value;
                        bScan++;
                        bLast = cursor.primaryKey;
                        if (isLegacyVec(v.vector)) {
                            cursor.update({ ...v, vector: vecForStorage(v.vector) });
                            bMig++;
                        }
                        cursor.continue();
                    };
                    req.onerror = () => reject(req.error);
                    tx.oncomplete = () => resolve({
                        migrated: bMig, scanned: bScan, lastKey: bLast, done: bDone,
                    });
                    tx.onerror = () => reject(tx.error);
                } catch (e) { reject(e); }
            });

            migrated += batch.migrated;
            scanned += batch.scanned;
            lastKey = batch.lastKey;
            done = batch.done;

            if (onProgress) onProgress(migrated, scanned);

            // 让其他 IDB tx 有机会插队
            if (!done) await new Promise(r => setTimeout(r, 50));
        }
        return migrated;
    },
};

// ─── MemoryLink CRUD ──────────────────────────────────

export const MemoryLinkDB = {
    save: (link: MemoryLink) => put<MemoryLink>(STORE_MEMORY_LINKS, compactMemoryLink(link)),

    delete: (id: string) => deleteByKey(STORE_MEMORY_LINKS, id),

    getBySourceId: (sourceId: string) =>
        getAllByIndex<MemoryLink>(STORE_MEMORY_LINKS, 'sourceId', sourceId),

    getByTargetId: (targetId: string) =>
        getAllByIndex<MemoryLink>(STORE_MEMORY_LINKS, 'targetId', targetId),

    /** 获取与某节点相关的所有链接（source 或 target） */
    getByNodeId: async (nodeId: string): Promise<MemoryLink[]> => {
        const [asSource, asTarget] = await Promise.all([
            getAllByIndex<MemoryLink>(STORE_MEMORY_LINKS, 'sourceId', nodeId),
            getAllByIndex<MemoryLink>(STORE_MEMORY_LINKS, 'targetId', nodeId),
        ]);
        // 去重（同一条 link 不会同时出现在两个结果中，因为 sourceId ≠ targetId）
        const seen = new Set<string>();
        const result: MemoryLink[] = [];
        for (const link of [...asSource, ...asTarget]) {
            if (!seen.has(link.id)) {
                seen.add(link.id);
                result.push(link);
            }
        }
        return result;
    },

    /** 批量保存 */
    saveMany: async (links: MemoryLink[]): Promise<void> => {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_MEMORY_LINKS, 'readwrite');
            const store = tx.objectStore(STORE_MEMORY_LINKS);
            for (const link of links) {
                store.put(compactMemoryLink(link));
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    /** Only round weights, never prune edges. Each batch updates the live cursor
     * value in one transaction, so concurrent strengthening is not overwritten
     * by an older snapshot. A failed batch can safely be retried. */
    compactStrengths: async (onProgress?: (changed: number, scanned: number) => void): Promise<number> => {
        let lastKey: IDBValidKey | undefined;
        let changed = 0;
        let scanned = 0;
        for (;;) {
            const db = await openDB();
            const batch = await new Promise<{ count: number; changed: number; lastKey?: IDBValidKey }>((resolve, reject) => {
                const tx = db.transaction(STORE_MEMORY_LINKS, 'readwrite');
                const req = tx.objectStore(STORE_MEMORY_LINKS).openCursor(
                    lastKey === undefined ? undefined : IDBKeyRange.lowerBound(lastKey, true),
                );
                let count = 0;
                let updated = 0;
                let key = lastKey;
                req.onsuccess = () => {
                    const cursor = req.result;
                    if (!cursor) return;
                    const original = cursor.value;
                    const compacted = compactMemoryLink(original);
                    if (compacted !== original) { cursor.update(compacted); updated++; }
                    key = cursor.primaryKey;
                    if (++count < 500) cursor.continue();
                };
                tx.oncomplete = () => resolve({ count, changed: updated, lastKey: key });
                tx.onerror = tx.onabort = () => reject(tx.error || new Error('记忆连接整理未完成'));
            });
            changed += batch.changed;
            scanned += batch.count;
            lastKey = batch.lastKey;
            onProgress?.(changed, scanned);
            if (batch.count < 500) return changed;
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    },
};

// ─── MemoryBatch CRUD ─────────────────────────────────

export const MemoryBatchDB = {
    save: (batch: MemoryBatch) => put<MemoryBatch>(STORE_MEMORY_BATCHES, batch),

    getByCharId: (charId: string) =>
        getAllByIndex<MemoryBatch>(STORE_MEMORY_BATCHES, 'charId', charId),
};

// ─── TopicBox CRUD ────────────────────────────────────

export const TopicBoxDB = {
    save: (box: TopicBox) => put<TopicBox>(STORE_TOPIC_BOXES, box),

    getById: (id: string) => getByKey<TopicBox>(STORE_TOPIC_BOXES, id),

    getByCharId: (charId: string) =>
        getAllByIndex<TopicBox>(STORE_TOPIC_BOXES, 'charId', charId),

    /** 获取角色当前 open 的盒子（最多一个） */
    getOpenBox: async (charId: string): Promise<TopicBox | undefined> => {
        const boxes = await getAllByIndex<TopicBox>(STORE_TOPIC_BOXES, 'charId', charId);
        return boxes.find(b => b.status === 'open');
    },

    /** 按状态过滤 */
    getByStatus: (charId: string, status: BoxStatus): Promise<TopicBox[]> =>
        getAllByIndex<TopicBox>(STORE_TOPIC_BOXES, 'charId', charId)
            .then(boxes => boxes.filter(b => b.status === status)),
};

// ─── EventBox CRUD ────────────────────────────────────

export const EventBoxDB = {
    /** Manual full regeneration: summary/vector, member flags and box lists commit together. */
    commitRegeneration: async (
        snapshot: EventBox,
        sources: MemoryNode[],
        entry: { node: MemoryNode; vector: MemoryVector },
        name: string,
        now: number,
    ): Promise<{ box: EventBox; archived: MemoryNode[] }> => {
        const db = await openDB();
        const committed = await new Promise<{ box: EventBox; archived: MemoryNode[] }>((resolve, reject) => {
            const tx = db.transaction([STORE_EVENT_BOXES, STORE_MEMORY_NODES, STORE_MEMORY_VECTORS], 'readwrite');
            let failure: unknown;
            let result: { box: EventBox; archived: MemoryNode[] };
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(failure || tx.error);
            tx.onabort = () => reject(failure || tx.error || new Error('整合保存失败，原内容已保留'));
            const boxes = tx.objectStore(STORE_EVENT_BOXES);
            const nodes = tx.objectStore(STORE_MEMORY_NODES);
            const boxRequest = boxes.get(snapshot.id);
            const reads = sources.map(source => nodes.get(source.id));
            let pending = reads.length + 1;
            const finish = () => {
                if (--pending) return;
                try {
                    const fresh = boxRequest.result as EventBox | undefined;
                    if (!fresh || fresh.charId !== snapshot.charId) throw new Error('事件盒已删除，整合未保存');
                    if (fresh.summaryNodeId !== snapshot.summaryNodeId || fresh.lastCompressedAt !== snapshot.lastCompressedAt) {
                        throw new Error('事件盒已被其他整合更新，请重新整合');
                    }
                    const members = new Set([...fresh.archivedMemoryIds, ...fresh.liveMemoryIds]);
                    const current = reads.map(read => read.result as MemoryNode | undefined);
                    const contentKey = (node: MemoryNode) => JSON.stringify([
                        node.charId, node.eventBoxId, node.content, node.room, node.createdAt, node.importance, node.mood, node.tags,
                    ]);
                    if (!sources.length || current.some((node, i) => !node || node.isBoxSummary
                        || !members.has(node.id) || contentKey(node) !== contentKey(sources[i]))) {
                        throw new Error('原始记忆已被修改、移出或删除，请重新整合；原总结已保留');
                    }
                    const included = new Set(sources.map(source => source.id));
                    const archived = current.map(node => ({ ...node!, archived: true }));
                    const hasNewArchive = current.some(node => !node!.archived) || fresh.liveMemoryIds.some(id => included.has(id));
                    const archivedMemoryIds = [...new Set([...fresh.archivedMemoryIds, ...included])];
                    const box: EventBox = {
                        ...fresh, name, tags: entry.node.tags, summaryNodeId: entry.node.id,
                        // Members added while the API was running were not summarized: leave them live.
                        liveMemoryIds: fresh.liveMemoryIds.filter(id => !included.has(id)),
                        archivedMemoryIds,
                        compressionCount: fresh.compressionCount + (hasNewArchive ? 1 : 0),
                        sealed: fresh.sealed || archivedMemoryIds.length >= EVENT_BOX_SEAL_THRESHOLD,
                        updatedAt: now, lastCompressedAt: now,
                    };
                    for (const node of archived) nodes.put(node);
                    nodes.put(entry.node);
                    tx.objectStore(STORE_MEMORY_VECTORS).put({ ...entry.vector, vector: vecForStorage(entry.vector.vector) });
                    boxes.put(box);
                    result = { box, archived };
                } catch (error) { failure = error; tx.abort(); }
            };
            boxRequest.onsuccess = finish;
            for (const read of reads) read.onsuccess = finish;
        });
        bm25Index.onNodesSaved([...committed.archived, entry.node]);
        for (const node of committed.archived) syncNodeMetadataToRemote(node);
        notifyMemoryNodesChanged(snapshot.charId);
        return committed;
    },
    save: (box: EventBox) => put<EventBox>(STORE_EVENT_BOXES, box),

    getById: (id: string) => getByKey<EventBox>(STORE_EVENT_BOXES, id),

    delete: (id: string) => deleteByKey(STORE_EVENT_BOXES, id),

    getByCharId: (charId: string) =>
        getAllByIndex<EventBox>(STORE_EVENT_BOXES, 'charId', charId),

    /** 批量保存（merge/compression 场景用） */
    saveMany: async (boxes: EventBox[]): Promise<void> => {
        if (boxes.length === 0) return;
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_EVENT_BOXES, 'readwrite');
            const store = tx.objectStore(STORE_EVENT_BOXES);
            for (const box of boxes) store.put(box);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },
};

// ─── RoomPlate CRUD（房间门牌） ───────────────────────

/** 门牌主键：一角色一房间一块 */
export function plateId(charId: string, room: PlateRoom): string {
    return `${charId}:${room}`;
}

export const RoomPlateDB = {
    save: (plate: RoomPlate) => put<RoomPlate>(STORE_ROOM_PLATES, plate),

    get: (charId: string, room: PlateRoom) =>
        getByKey<RoomPlate>(STORE_ROOM_PLATES, plateId(charId, room)),

    getByCharId: (charId: string) =>
        getAllByIndex<RoomPlate>(STORE_ROOM_PLATES, 'charId', charId),

    delete: (charId: string, room: PlateRoom) =>
        deleteByKey(STORE_ROOM_PLATES, plateId(charId, room)),
};

/**
 * 「门牌被后台改写过了」的窗口事件（`detail: { charId, rooms }`）。
 *
 * 给云端整理用的：结果晚几分钟才回来，那时用户多半正开着记忆宫殿。门牌已经写进
 * IndexedDB，界面却还挂着提交前那份——不派这个事件的话得关掉再打开才看得见，看上去
 * 就像整理压根没跑。名字放在门牌读写这一层，派发方和监听方都别手抄字符串。
 */
export const ROOM_PLATES_UPDATED_EVENT = 'room-plates-updated';

/**
 * 读一块门牌，没有就现造一块空的（不落库，由调用方决定要不要存）。
 *
 * 住在这儿是因为两条整理路径（本地的 roomPlates、上云的 roomPlateCloud）都要它，
 * 而新门牌的初始形态——尤其是 `version: 0` 这个乐观锁起点——两边必须一模一样。
 */
export async function loadOrCreatePlate(charId: string, room: PlateRoom): Promise<RoomPlate> {
    const existing = await RoomPlateDB.get(charId, room);
    if (existing) return existing;
    return {
        id: plateId(charId, room),
        charId,
        room,
        entries: [],
        updatedAt: Date.now(),
        version: 0,
    };
}

/**
 * 每块门牌一条落库队列（见 mutatePlate）。
 *
 * 键是门牌主键，所以上限是「角色数 × 4」，用不着回收；存的也只是一个已 settle 的 Promise。
 */
const plateWriteQueues = new Map<string, Promise<unknown>>();

/**
 * 改一块门牌：**现读一份 → 改 → 整块存回去**，同一块门牌上的改动排队走，不并发。
 *
 * 门牌是「整块对象存回去」的形状，而动它的路有四条，彼此完全不知道对方存在：
 * 云端整理结果落地、本地整理落库、送达保证兜底并入、以及门牌面板上用户手改。任意两条
 * 撞在一起就是后写的把先写的整块盖掉——用户刚敲的字没了，或者一整轮整理的成果没了，
 * 而两边日志都显示成功。各自在自己那条路里排队是不够的（面板原先就是这么做的），
 * 队伍必须是**按门牌**的一条，所有路共用。
 *
 * `change` 要是纯的——只回答「这份门牌该改成什么样」，回 null 表示不用改。要往界面上
 * 说话、要记日志的，在外面等这个 promise 落定之后再说。
 *
 * @returns 存进去的那一份；`change` 回 null（不用改）时是 null。落库出错照常抛。
 */
export async function mutatePlate(
    charId: string,
    room: PlateRoom,
    change: (plate: RoomPlate) => RoomPlate | null,
): Promise<RoomPlate | null> {
    const key = plateId(charId, room);
    const run = async (): Promise<RoomPlate | null> => {
        const fresh = await loadOrCreatePlate(charId, room);
        const next = change(fresh);
        if (!next) return null;
        await RoomPlateDB.save(next);
        return next;
    };
    // 前一次的成败不影响后一次排上队（两个分支都是 run），但队尾要吞掉异常——
    // 不吞的话一次落库失败会变成后面每一次的 unhandled rejection。
    const write = (plateWriteQueues.get(key) ?? Promise.resolve()).then(run, run);
    plateWriteQueues.set(key, write.catch(() => {}));
    return write;
}

// ─── DigestReport CRUD（消化日志） ────────────────────

export const DigestReportDB = {
    /** 保存并修剪：每角色只留最近 DIGEST_REPORT_KEEP 条 */
    save: async (report: DigestReport): Promise<void> => {
        await put<DigestReport>(STORE_DIGEST_REPORTS, report);
        try {
            const all = await getAllByIndex<DigestReport>(STORE_DIGEST_REPORTS, 'charId', report.charId);
            if (all.length > DIGEST_REPORT_KEEP) {
                const overflow = all
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .slice(DIGEST_REPORT_KEEP);
                for (const old of overflow) {
                    await deleteByKey(STORE_DIGEST_REPORTS, old.id);
                }
            }
        } catch { /* 修剪失败不影响本条保存 */ }
    },

    /** 按时间倒序（最新在前） */
    getByCharId: (charId: string): Promise<DigestReport[]> =>
        getAllByIndex<DigestReport>(STORE_DIGEST_REPORTS, 'charId', charId)
            .then(list => list.sort((a, b) => b.createdAt - a.createdAt)),

    delete: (id: string) => deleteByKey(STORE_DIGEST_REPORTS, id),
};

// ─── Anticipation CRUD ────────────────────────────────

export const AnticipationDB = {
    save: (ant: Anticipation) => put<Anticipation>(STORE_ANTICIPATIONS, ant),

    getById: (id: string) => getByKey<Anticipation>(STORE_ANTICIPATIONS, id),

    delete: (id: string) => deleteByKey(STORE_ANTICIPATIONS, id),

    getByCharId: (charId: string) =>
        getAllByIndex<Anticipation>(STORE_ANTICIPATIONS, 'charId', charId),

    getByStatus: (charId: string, status: AnticipationStatus): Promise<Anticipation[]> =>
        getAllByIndex<Anticipation>(STORE_ANTICIPATIONS, 'charId', charId)
            .then(ants => ants.filter(a => a.status === status)),

    getActive: (charId: string) =>
        AnticipationDB.getByStatus(charId, 'active'),
};
