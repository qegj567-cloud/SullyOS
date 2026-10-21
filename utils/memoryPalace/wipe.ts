/**
 * Memory Palace — 一键清空
 *
 * 把本地所有记忆宫殿数据清零；可选同步清空用户自己的 Supabase memory_vectors。
 *
 * 使用场景：
 *  - 用户想"重来"（比如改了 embedding 模型、或希望应用新版 boxId 体系）
 *  - 开发/测试重置
 */

import { openDB } from '../db';
import type { RemoteVectorConfig } from './types';
import { bm25Index } from './bm25Index';

const MP_STORES = [
    'memory_nodes',
    'memory_vectors',
    'memory_links',
    'memory_batches',
    'topic_boxes',
    'anticipations',
    'event_boxes',
    'room_plates',
    'digest_reports',
];

/** 清空 localStorage 中所有 mp_lastMsgId_<charId> 高水位标记 */
function clearHighWatermarks(): number {
    let n = 0;
    try {
        const toRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('mp_lastMsgId_')) toRemove.push(key);
        }
        for (const key of toRemove) {
            localStorage.removeItem(key);
            n++;
        }
    } catch { /* ignore */ }
    return n;
}

/** 清空本地 IndexedDB 的所有记忆宫殿表 */
async function clearLocalStores(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const db = await openDB();

    // 只对实际存在的 store 操作（兼容旧版本未建 event_boxes 的情况）
    const presentStores = MP_STORES.filter(name => db.objectStoreNames.contains(name));
    if (presentStores.length === 0) return counts;

    return await new Promise<Record<string, number>>((resolve, reject) => {
        const tx = db.transaction(presentStores, 'readwrite');

        // 先异步收集每张表的行数，再清空；用嵌套 onsuccess 串起来
        let pending = presentStores.length;
        const checkDone = () => {
            if (pending === 0) {
                // 所有 count 回调完成，这里发起 clear
                for (const name of presentStores) {
                    try { tx.objectStore(name).clear(); } catch { /* ignore */ }
                }
            }
        };

        for (const name of presentStores) {
            const req = tx.objectStore(name).count();
            req.onsuccess = () => {
                counts[name] = req.result || 0;
                pending--;
                checkDone();
            };
            req.onerror = () => {
                counts[name] = 0;
                pending--;
                checkDone();
            };
        }

        tx.oncomplete = () => resolve(counts);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

/** 同步清理 IndexedDB assets 表中的 mp_hwm_v1_* 水位镜像 */
async function clearMirroredHighWatermarks(): Promise<void> {
    try {
        const db = await openDB();
        if (!db.objectStoreNames.contains('assets')) return;
        await new Promise<void>((resolve) => {
            const tx = db.transaction('assets', 'readwrite');
            const store = tx.objectStore('assets');
            const range = IDBKeyRange.bound('mp_hwm_v1_', 'mp_hwm_v1_\uffff');
            store.delete(range);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        });
    } catch { /* ignore */ }
}

/** 清空远程 Supabase 向量表（全表删除，跨所有角色） */
async function clearRemoteVectors(config: RemoteVectorConfig): Promise<number> {
    if (!config.enabled || !config.initialized) return 0;
    try {
        const headers = {
            'apikey': config.supabaseAnonKey,
            'Authorization': `Bearer ${config.supabaseAnonKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'count=exact,return=minimal',
        };
        const base = `${config.supabaseUrl.replace(/\/+$/, '')}/rest/v1/memory_vectors`;

        // 先查总数（用 HEAD + count=exact）
        let total = 0;
        try {
            const head = await fetch(`${base}?select=memory_id`, {
                method: 'HEAD',
                headers: { ...headers, 'Prefer': 'count=exact' },
            });
            const range = head.headers.get('content-range');
            if (range) {
                const m = range.match(/\/(\d+)/);
                if (m) total = parseInt(m[1], 10);
            }
        } catch { /* ignore */ }

        // PostgREST 要求 DELETE 必须带过滤条件；用 "memory_id=not.is.null" 匹配全部行
        const delRes = await fetch(`${base}?memory_id=not.is.null`, {
            method: 'DELETE',
            headers,
        });
        if (!delRes.ok) {
            console.warn(`🗑️ [Wipe] 远程删除返回 ${delRes.status}: ${await delRes.text().catch(() => '')}`);
            return 0;
        }
        return total;
    } catch (e: any) {
        console.warn(`🗑️ [Wipe] 远程删除异常: ${e?.message || e}`);
        return 0;
    }
}

export interface WipeResult {
    local: Record<string, number>;
    localRowsTotal: number;
    highWatermarks: number;
    remote: number;
    remoteAttempted: boolean;
}

/**
 * 一键清空记忆宫殿数据。
 *
 * @param options.remoteConfig 若提供，会同时清空远程 Supabase memory_vectors（全表）
 * @param options.skipRemote  即使有 remoteConfig 也跳过远程（仅清本地）
 */
export async function wipeAllMemoryPalace(options: {
    remoteConfig?: RemoteVectorConfig;
    skipRemote?: boolean;
} = {}): Promise<WipeResult> {
    console.log(`🗑️ [Wipe] 开始一键清空记忆宫殿...`);

    const local = await clearLocalStores();
    const localRowsTotal = Object.values(local).reduce((s, v) => s + v, 0);
    const hwm = clearHighWatermarks();
    await clearMirroredHighWatermarks();

    // 同步清空内存中的 BM25 倒排索引（否则下次查询会拿到孤儿 nodeId）
    bm25Index.dropAll();

    let remote = 0;
    let remoteAttempted = false;
    if (options.remoteConfig && !options.skipRemote) {
        remoteAttempted = true;
        remote = await clearRemoteVectors(options.remoteConfig);
    }

    console.log(`🗑️ [Wipe] 完成：本地 ${localRowsTotal} 行、高水位 ${hwm} 条、远程 ${remoteAttempted ? remote : '跳过'}`);
    return { local, localRowsTotal, highWatermarks: hwm, remote, remoteAttempted };
}
