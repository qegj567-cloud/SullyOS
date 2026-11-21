/**
 * Memory Palace — 向量搜索（Web Worker 加速版）
 *
 * 查询文本 → 向量化 → 与该角色的 memory_vectors 做余弦相似度 → 阈值过滤
 *
 * 优化：
 * 1. 使用 charId 索引直查，不再全表扫描
 * 2. Float32Array 减少内存占用
 * 3. Web Worker 执行 cosine similarity，不阻塞主线程
 * 4. 回退：Worker 不可用时在主线程计算
 */

import type { MemoryNode, MemoryVector, RemoteVectorConfig } from './types';
import { MemoryNodeDB, MemoryVectorDB, ensureFloat32 } from './db';
import { cosineSimilarity } from './embedding';
import { remoteCoversLocal, searchVectors as remoteSearch } from './supabaseVector';

export interface VectorSearchResult {
    node: MemoryNode;
    similarity: number;
}

// Worker 单例（懒初始化）
let worker: Worker | null = null;
let workerFailed = false;

const rpcCooldown = new Map<string, number>();
const configKey = (config: RemoteVectorConfig) => JSON.stringify([config.supabaseUrl, config.supabaseAnonKey]);

export async function canSearchRemote(config: RemoteVectorConfig | undefined, charId: string): Promise<boolean> {
    if (!config?.enabled || !config.initialized || (rpcCooldown.get(configKey(config)) ?? 0) > Date.now()) return false;
    return remoteCoversLocal(config, charId);
}

/** 把 worker 标记为坏掉并终止，确保不再被 getWorker() 拿到。 */
function markWorkerBroken(reason: string): void {
    if (workerFailed) return;
    console.warn(`[vectorSearch] disabling worker for this session: ${reason}`);
    workerFailed = true;
    if (worker) {
        try { worker.terminate(); } catch { /* ignore */ }
        worker = null;
    }
    // 同时清空等待中的 worker 请求，免得 Promise 挂死
    for (const resolve of workerPending.values()) resolve([]);
    workerPending.clear();
}

// Worker 多路复用：以 requestId 分发响应，避免并发时后一个 onmessage
// 覆盖前一个 handler、导致前面的 Promise 永挂。
const workerPending = new Map<number, (results: { memoryId: string; similarity: number }[]) => void>();
let nextWorkerRequestId = 1;

function attachWorkerHandlers(w: Worker): void {
    w.onmessage = (e: MessageEvent) => {
        const { requestId, results } = e.data || {};
        if (typeof requestId !== 'number') return;
        const resolve = workerPending.get(requestId);
        if (resolve) {
            workerPending.delete(requestId);
            resolve(results || []);
        }
    };
    w.onerror = () => markWorkerBroken('worker.onerror fired');
}

function getWorker(): Worker | null {
    if (workerFailed) return null;
    if (worker) return worker;
    try {
        worker = new Worker(
            new URL('./vectorSearchWorker.ts', import.meta.url),
            { type: 'module' }
        );
        attachWorkerHandlers(worker);
        return worker;
    } catch {
        workerFailed = true;
        return null;
    }
}

/**
 * 向量搜索：在指定角色的所有已向量化记忆中搜索
 *
 * @param queryVector 查询向量（已向量化）
 * @param charId 角色 ID
 * @param threshold 相似度阈值，默认 0.3
 * @param topK 返回最多 topK 条，默认 20
 * @param remoteConfig 远程向量存储配置（可选，有配置时优先走远程）
 */
export async function vectorSearch(
    queryVector: number[] | Float32Array,
    charId: string,
    threshold: number = 0.3,
    topK: number = 20,
    remoteConfig?: RemoteVectorConfig,
    /**
     * 可选：预取好的向量列表（角色全量）。
     * 同次 retrieve 内多路并行检索时，上游预取一次传下来避免 K 次 getAllByCharId。
     * 远程路径不消费这个字段。
     */
    prefetchedVectors?: MemoryVector[],
): Promise<VectorSearchResult[]> {
    // ─── 远程路径：Supabase pgvector ─────────────────
    // 注意：远程 RPC 已内置 archived=false 过滤
    if (remoteConfig && await canSearchRemote(remoteConfig, charId)) {
        try {
            return await remoteSearch(remoteConfig, queryVector, charId, threshold, topK);
        } catch (error) {
            rpcCooldown.set(configKey(remoteConfig), Date.now() + 60000);
            console.warn('[vectorSearch] 远程检索暂不可用，本次使用本地向量', error);
        }
    }

    // ─── 本地路径：IndexedDB + Worker ────────────────
    const vectors = prefetchedVectors ?? await MemoryVectorDB.getAllByCharId(charId);
    if (vectors.length === 0) return [];

    // 尝试使用 Worker 计算
    let scored: { memoryId: string; similarity: number }[];
    const w = getWorker();

    if (w) {
        // 当 vectors 来自 prefetch 时，同一份数组会被 K 路 vectorSearch 并发
        // 消费；Transfer list 会 neuter 首个调用的 buffer，后续调用读到全 0
        // 静默返空。这种情况下禁止把候选向量 buffer 列入 transfer list，
        // 改走 postMessage 的 structured clone（内部 memcpy）。query 向量
        // 是单路独占，始终可以 transfer。
        const canTransferCandidates = !prefetchedVectors;
        scored = await runInWorker(w, queryVector, vectors, threshold, topK, canTransferCandidates);
    } else {
        scored = mainThreadSearch(queryVector, vectors, threshold, topK);
    }

    // 加载对应的 MemoryNode（过滤 archived 节点）
    //
    // 性能：原来是 for-await 串行 getById，30 条候选 × 每次一个 IDB 事务
    // ≈ 300–900ms。改成 Promise.all 让所有 get 并发入队，浏览器可以在
    // 同一个事件循环内把它们调度到 IDB，主线程等待从 O(N) 降到 O(1)。
    // 顺序通过 map 的 index 天然保留，过滤 archived 后仍是 similarity 降序。
    const nodes = await Promise.all(scored.map(item => MemoryNodeDB.getById(item.memoryId)));
    const results: VectorSearchResult[] = [];
    for (let i = 0; i < scored.length; i++) {
        const node = nodes[i];
        if (node && !node.archived) {
            results.push({ node, similarity: scored[i].similarity });
        }
    }

    return results;
}

/** Worker 通信 — 支持并发多路复用（用 requestId 区分响应） */
function runInWorker(
    w: Worker,
    queryVector: number[] | Float32Array | Uint8Array,
    vectors: { memoryId: string; vector: number[] | Float32Array | Uint8Array }[],
    threshold: number,
    topK: number,
    canTransferCandidates: boolean = true,
): Promise<{ memoryId: string; similarity: number }[]> {
    return new Promise((resolve) => {
        // 全部归一到 Float32Array，准备走 transfer list 零拷贝。
        // 注意：transfer 后主线程这些 buffer 会被 neuter，所以 timeout 兜底
        // 不能再用 mainThreadSearch（会读到全 0 buffer 静默返空）。
        // 策略：超时时 resolve([]) 让当次查询退化成 BM25-only，同时把 worker
        // 标记为坏掉 —— 下一次 vectorSearch 在 getWorker() 处拿到 null，
        // 走主线程正确路径（无 transfer，无 neuter）。这样单次 worker 故障
        // 不会变成"永远静默少结果"的长期状态。
        // ensureFloat32 兼容三种存储形态（number[] / Float32Array / Uint8Array）。
        // 即使上游 DB 改了存储格式也不会因为 `new Float32Array(uint8)` 把字节
        // 当成 number 误读出 4× 长的错误向量。
        const qv = ensureFloat32(queryVector);
        const fvs = vectors.map(v => ({
            memoryId: v.memoryId,
            vector: ensureFloat32(v.vector),
        }));

        const requestId = nextWorkerRequestId++;
        const timeout = setTimeout(() => {
            if (!workerPending.has(requestId)) return; // 已完成
            workerPending.delete(requestId);
            markWorkerBroken('timeout 10s — buffers neutered, cannot run mainThreadSearch on this call; subsequent calls will use main thread');
            resolve([]);
        }, 10000);

        workerPending.set(requestId, (results) => {
            clearTimeout(timeout);
            resolve(results);
        });

        // Transfer list：query 向量是本次调用独占的一次性 buffer，始终 transfer。
        // 候选向量仅在上游确认它们不会被并发复用时才 transfer——否则 K 路并发
        // vectorSearch 共享同一份 prefetched 向量数组时，首个 transfer 会 neuter
        // buffer 让后续路径读到全 0 静默返空。
        const transfers: Transferable[] = [qv.buffer];
        if (canTransferCandidates) {
            for (const v of fvs) transfers.push((v.vector as Float32Array).buffer);
        }
        try {
            w.postMessage({ requestId, queryVector: qv, vectors: fvs, threshold, topK }, transfers);
        } catch (e: any) {
            clearTimeout(timeout);
            workerPending.delete(requestId);
            markWorkerBroken(`postMessage failed: ${e?.message || e}`);
            resolve([]);
        }
    });
}

/** 主线程回退计算 */
function mainThreadSearch(
    queryVector: number[] | Float32Array | Uint8Array,
    vectors: { memoryId: string; vector: number[] | Float32Array | Uint8Array }[],
    threshold: number,
    topK: number,
): { memoryId: string; similarity: number }[] {
    const scored: { memoryId: string; similarity: number }[] = [];

    const qv = ensureFloat32(queryVector);
    for (const vec of vectors) {
        const sim = cosineSimilarity(qv, ensureFloat32(vec.vector));
        if (sim >= threshold) {
            scored.push({ memoryId: vec.memoryId, similarity: sim });
        }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
}
