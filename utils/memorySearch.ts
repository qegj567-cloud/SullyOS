/**
 * Memory Palace — Vector Search Engine
 * 余弦相似度 + 三因子加权评分（Stanford Generative Agents）
 */

import { MemoryNode, MemoryVector } from '../types';

// ============ 向量数学 ============

/** 余弦相似度 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

// ============ 三因子评分 ============

/** 评分权重配置 */
export interface ScoringWeights {
    similarity: number;   // 语义相关性权重（默认 0.5）
    recency: number;      // 时间新近性权重（默认 0.3）
    importance: number;   // 重要性权重（默认 0.2）
}

const DEFAULT_WEIGHTS: ScoringWeights = {
    similarity: 0.5,
    recency: 0.3,
    importance: 0.2,
};

/** 时间衰减因子（每小时衰减 0.995^1） */
const DECAY_FACTOR = 0.995;

/**
 * 计算时间衰减分数
 * 基于 Stanford Generative Agents: score = decay^hours_since_last_access
 */
function recencyScore(lastAccessedAt: number, now: number): number {
    const hoursSince = (now - lastAccessedAt) / (1000 * 60 * 60);
    return Math.pow(DECAY_FACTOR, Math.max(0, hoursSince));
}

/**
 * 计算记忆的综合检索分数
 */
function computeScore(
    similarity: number,
    memory: MemoryNode,
    now: number,
    weights: ScoringWeights = DEFAULT_WEIGHTS
): number {
    const recency = recencyScore(memory.lastAccessedAt || memory.createdAt, now);
    const importance = memory.importance / 10; // 归一化到 0-1
    return (
        weights.similarity * similarity +
        weights.recency * recency +
        weights.importance * importance
    );
}

// ============ 检索接口 ============

export interface SearchResult {
    memory: MemoryNode;
    similarity: number;
    score: number;
}

export interface SearchOptions {
    topK?: number;                    // 返回前 K 条（默认 5）
    weights?: ScoringWeights;         // 自定义权重
    roomFilter?: string;              // 只搜索特定房间
    minSimilarity?: number;           // 最低相似度阈值（默认 0.3）
}

/**
 * 向量检索 + 三因子加权排序
 *
 * @param queryVector  查询向量（当前消息的 embedding）
 * @param memories     所有记忆节点
 * @param vectors      所有向量记录（与 memories 通过 memoryId 关联）
 * @param options      检索选项
 */
export function searchMemories(
    queryVector: number[],
    memories: MemoryNode[],
    vectors: MemoryVector[],
    options: SearchOptions = {}
): SearchResult[] {
    const {
        topK = 5,
        weights = DEFAULT_WEIGHTS,
        roomFilter,
        minSimilarity = 0.3,
    } = options;

    const now = Date.now();

    // 建立 memoryId → vector 的映射
    const vectorMap = new Map<string, number[]>();
    for (const v of vectors) {
        vectorMap.set(v.memoryId, v.vector);
    }

    // 过滤 + 评分
    const results: SearchResult[] = [];

    for (const memory of memories) {
        // 房间过滤
        if (roomFilter && memory.room !== roomFilter) continue;

        // 必须有向量
        const vec = vectorMap.get(memory.id);
        if (!vec) continue;

        const similarity = cosineSimilarity(queryVector, vec);
        if (similarity < minSimilarity) continue;

        const score = computeScore(similarity, memory, now, weights);
        results.push({ memory, similarity, score });
    }

    // 按分数降序排列
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, topK);
}

/**
 * 查找与给定记忆相似的其他记忆（用于去重/合并）
 */
export function findSimilarMemories(
    targetVector: number[],
    memories: MemoryNode[],
    vectors: MemoryVector[],
    excludeId: string,
    threshold: number = 0.85
): { memory: MemoryNode; similarity: number }[] {
    const vectorMap = new Map<string, number[]>();
    for (const v of vectors) vectorMap.set(v.memoryId, v.vector);

    const results: { memory: MemoryNode; similarity: number }[] = [];

    for (const memory of memories) {
        if (memory.id === excludeId) continue;
        const vec = vectorMap.get(memory.id);
        if (!vec) continue;

        const sim = cosineSimilarity(targetVector, vec);
        if (sim >= threshold) {
            results.push({ memory, similarity: sim });
        }
    }

    return results.sort((a, b) => b.similarity - a.similarity);
}
