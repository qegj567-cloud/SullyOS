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

/** 时间衰减因子（每小时衰减 0.999^1 — 比原 0.995 慢很多） */
const DECAY_FACTOR = 0.999;

/**
 * 计算时间衰减分数
 * 改进：使用 0.999 衰减 → 1天后≈0.976，7天后≈0.845，30天后≈0.487，90天后≈0.115
 * 比原来的 0.995（30天→0.03）慢很多，让老记忆有机会浮现
 */
function recencyScore(lastAccessedAt: number, now: number): number {
    const hoursSince = (now - lastAccessedAt) / (1000 * 60 * 60);
    return Math.pow(DECAY_FACTOR, Math.max(0, hoursSince));
}

/**
 * 重要性非线性映射
 * 原来 importance/10 线性映射 → 5和9的差距太小（0.5 vs 0.9，差0.4×0.2=0.08）
 * 改为指数映射 → 高重要性有显著更强的拉力
 * 1→0.10, 3→0.22, 5→0.39, 7→0.59, 9→0.84, 10→1.0
 */
function importanceScore(importance: number): number {
    const normalized = Math.min(10, Math.max(1, importance)) / 10;
    return Math.pow(normalized, 0.7); // 0.7次幂 — 让高分更突出
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
    const importance = importanceScore(memory.importance);
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

    // 房间多样性保证：如果结果≥3条，确保至少覆盖2个不同房间
    // 策略：贪心选取，已有房间的第3+条记忆会被后面不同房间的记忆替换
    if (!roomFilter && results.length > topK) {
        const selected: SearchResult[] = [];
        const roomCount: Record<string, number> = {};
        const maxPerRoom = Math.max(2, Math.ceil(topK * 0.6)); // 单房间上限 60%

        for (const r of results) {
            if (selected.length >= topK) break;
            const room = r.memory.room;
            const count = roomCount[room] || 0;
            if (count >= maxPerRoom) continue; // 跳过已满的房间
            selected.push(r);
            roomCount[room] = count + 1;
        }

        // 如果多样性筛选后不够 topK，回填分数最高的
        if (selected.length < topK) {
            const selectedIds = new Set(selected.map(s => s.memory.id));
            for (const r of results) {
                if (selected.length >= topK) break;
                if (!selectedIds.has(r.memory.id)) selected.push(r);
            }
        }

        return selected;
    }

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
