/**
 * Memory Palace — 向量化 + 存储 + 去重
 *
 * 将提取出的 MemoryNode 批量向量化，
 * 与已有向量做去重（余弦 > 0.9 跳过），
 * 然后存入 memory_nodes 和 memory_vectors。
 */

import type { EmbeddingConfig, MemoryNode, MemoryVector, RemoteVectorConfig } from './types';
import { MemoryNodeDB, MemoryVectorDB, ensureFloat32 } from './db';
import { cosineSimilarity } from './embedding';
import { getMemoryEmbeddings } from './memoryEmbeddings';
import { upsertVector as remoteUpsert } from './supabaseVector';

const DEDUP_THRESHOLD = 0.9;

/**
 * 向量化并存储记忆节点
 *
 * 流程：
 * 1. 批量向量化 nodes 的 content
 * 2. 与已有向量做去重（cosine > 0.9 的跳过）
 * 3. 保存 MemoryNode (embedded=true) + MemoryVector
 *
 * skipDedup 保留给那些"入口就保证不会重"的路径用（比如 EventBox 压缩后写回
 * summary 节点 —— summary 是 LLM 新合成的唯一结果，不会和已有记忆撞）。
 * 迁移路径**不要**传 skipDedup —— 语义去重能挡掉 sub-batch 之间对同一件事的
 * 重复提取（比如"7-12 号某天回忆起 3 号那件事"）。
 */
export async function vectorizeAndStore(
    nodes: MemoryNode[],
    embeddingConfig: EmbeddingConfig,
    remoteVectorConfig?: RemoteVectorConfig,
    options: {
        skipDedup?: boolean;
        /** Commit related state in the same local transaction; remote publish still follows success only. */
        commit?: (entries: { node: MemoryNode; vector: MemoryVector }[]) => Promise<void>;
    } = {},
): Promise<{ stored: number; skipped: number }> {
    if (nodes.length === 0) return { stored: 0, skipped: 0 };

    // 1. 批量向量化
    const vectors = await getMemoryEmbeddings(nodes, embeddingConfig);
    if (vectors.length !== nodes.length || vectors.some(vector => !vector.length || !Array.from(vector).every(Number.isFinite))) {
        throw new Error('Embedding 返回的向量不完整或无效，本次没有写入记忆');
    }

    // 2. 加载已有向量用于去重（EventBox summary / 迁移等场景跳过）
    const charId = nodes[0].charId;
    const existingVectors = options.skipDedup ? [] : await MemoryVectorDB.getAllByCharId(charId);

    let stored = 0;
    let skipped = 0;
    const entries: { node: MemoryNode; vector: MemoryVector }[] = [];

    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const vector = vectors[i];

        // 去重检查 — ensureFloat32 兼容三种存储形态（number[] / Float32Array
        // / Uint8Array），同时保护 cosineSimilarity 不被 Uint8Array 误读字节当数。
        const queryF32 = ensureFloat32(vector);
        const isDuplicate = !options.skipDedup && existingVectors.some(
            ev => cosineSimilarity(queryF32, ensureFloat32(ev.vector)) > DEDUP_THRESHOLD
        );

        if (isDuplicate) {
            console.log(`♻️ [VectorStore] Skipping duplicate memory: "${node.content.slice(0, 30)}..."`);
            skipped++;
            continue;
        }

        // 3. 保存
        const memoryVector: MemoryVector = {
            memoryId: node.id,
            charId: node.charId,
            vector,
            dimensions: embeddingConfig.dimensions,
            model: embeddingConfig.model,
        };
        entries.push({ node: { ...node, embedded: true }, vector: memoryVector });

        // 将新向量也加入已有列表，后续去重时可以检测同批次内的重复
        existingVectors.push(memoryVector);

        stored++;
    }

    if (options.commit) await options.commit(entries);
    else await MemoryNodeDB.saveVectorizedMany(entries);
    const committedIds = new Set(entries.map(entry => entry.node.id));
    for (const node of nodes) if (committedIds.has(node.id)) node.embedded = true;
    // Only publish remote state after the local batch committed successfully.
    if (remoteVectorConfig?.enabled && remoteVectorConfig.initialized) {
        for (const { node, vector } of entries) {
            remoteUpsert(remoteVectorConfig, node.id, node.charId, ensureFloat32(vector.vector), node, embeddingConfig.dimensions, embeddingConfig.model).catch(() => {});
        }
    }

    console.log(`✅ [VectorStore] Stored ${stored}, skipped ${skipped} duplicates`);
    return { stored, skipped };
}

export interface UpdateStoredMemoryNodeResult {
    node: MemoryNode;
    /** 只有正文发生变化时才会为 true。 */
    reembedded: boolean;
}

/**
 * 统一的记忆节点编辑保存入口。
 *
 * - 正文未变化：只保存 room/tags/importance/mood 等 metadata，不调用 Embedding API。
 * - 正文发生变化：沿用原 memoryId 重新生成并覆盖向量，避免“新文字 + 旧向量”。
 */
export async function updateStoredMemoryNode(
    nodeId: string,
    updates: Partial<MemoryNode>,
    embeddingConfig?: EmbeddingConfig,
    remoteVectorConfig?: RemoteVectorConfig,
): Promise<UpdateStoredMemoryNodeResult> {
    const existing = await MemoryNodeDB.getById(nodeId);
    if (!existing) throw new Error('这条记忆已经不存在了');

    const updated: MemoryNode = { ...existing, ...updates, id: existing.id, charId: existing.charId };
    if (!updated.content.trim()) throw new Error('记忆内容不能为空');
    const contentChanged = updated.content !== existing.content;

    if (!contentChanged) {
        await MemoryNodeDB.save(updated);
        return { node: updated, reembedded: false };
    }

    if (!embeddingConfig?.baseUrl || !embeddingConfig.apiKey || !embeddingConfig.model) {
        throw new Error('请先配置 Embedding API，修改正文后需要同步更新向量');
    }

    updated.embedded = false;
    await vectorizeAndStore(
        [updated],
        embeddingConfig,
        remoteVectorConfig,
        { skipDedup: true },
    );
    return { node: { ...updated, embedded: true }, reembedded: true };
}

/**
 * 归一化模型名，用于「是否同一个底层模型」的比对。
 *
 * 去掉计费档位前缀 `Pro/`（硅基流动的付费独占算力档，底层权重与免费版
 * 完全相同：`Pro/BAAI/bge-m3` 与 `BAAI/bge-m3` 是同一个 bge-m3）。
 *
 * 这样硅基 `Pro/BAAI/bge-m3` → 火山 `BAAI/bge-m3` 这类「同一开源模型、
 * 仅换服务商/档位」的切换不会触发无谓重建（向量空间一致）。
 */
function normalizeModelName(model: string): string {
    return model
        .replace(/^Pro\//i, '')   // 硅基付费档前缀
        .trim()
        .toLowerCase();
}

/**
 * 检测当前 embedding 模型是否与已有向量的模型一致。
 * 如果不一致，说明用户换了模型，需要重新向量化。
 *
 * 注意：只比对「模型本体」，`Pro/BAAI/bge-m3` 与 `BAAI/bge-m3` 视为同一个模型，
 * 跨服务商切换同一开源模型（如硅基 → 火山的 bge-m3）不会触发无谓重建。
 *
 * @returns 'match' | 'mismatch' | 'empty' (无已有向量)
 */
export async function checkModelConsistency(
    charId: string,
    currentModel: string,
): Promise<'match' | 'mismatch' | 'empty'> {
    const existing = await MemoryVectorDB.getAllByCharId(charId);
    if (existing.length === 0) return 'empty';

    // 取第一条有 model 字段的向量做比对（旧数据可能没有 model 字段）
    const sample = existing.find(v => v.model);
    if (!sample) return 'match'; // 旧数据无 model 字段，不触发重建，兼容过渡

    return normalizeModelName(sample.model!) === normalizeModelName(currentModel)
        ? 'match'
        : 'mismatch';
}

/**
 * 重新向量化：用新模型重新 embedding 所有已有记忆。
 * 保留 MemoryNode 不动，只替换 MemoryVector。
 */
export async function rebuildAllVectors(
    charId: string,
    embeddingConfig: EmbeddingConfig,
    remoteVectorConfig?: RemoteVectorConfig,
): Promise<{ rebuilt: number }> {
    const nodes = await MemoryNodeDB.getByCharId(charId);
    const embeddedNodes = nodes.filter(n => n.embedded);

    if (embeddedNodes.length === 0) return { rebuilt: 0 };

    console.log(`🔄 [VectorStore] 开始重建 ${embeddedNodes.length} 条向量（${embeddingConfig.model}）...`);

    // 批量 embedding
    const vectors = await getMemoryEmbeddings(embeddedNodes, embeddingConfig);

    // 逐条替换
    for (let i = 0; i < embeddedNodes.length; i++) {
        const mv: MemoryVector = {
            memoryId: embeddedNodes[i].id,
            charId,
            vector: vectors[i],
            dimensions: embeddingConfig.dimensions,
            model: embeddingConfig.model,
        };
        await MemoryVectorDB.save(mv);

        // 同步到远程
        if (remoteVectorConfig?.enabled && remoteVectorConfig.initialized) {
            remoteUpsert(remoteVectorConfig, embeddedNodes[i].id, charId, vectors[i], embeddedNodes[i], embeddingConfig.dimensions, embeddingConfig.model).catch(() => {});
        }
    }

    console.log(`✅ [VectorStore] 重建完成：${embeddedNodes.length} 条向量已更新为 ${embeddingConfig.model}`);
    return { rebuilt: embeddedNodes.length };
}
