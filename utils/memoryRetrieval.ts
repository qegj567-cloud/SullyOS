/**
 * Memory Palace — Retrieval & Context Injection
 * 对话时实时检索相关记忆并注入到 prompt 中
 */

import { MemoryNode, EmbeddingApiConfig } from '../types';
import { DB } from './db';
import { getEmbedding } from './memoryEmbedding';
import { searchMemories, SearchResult } from './memorySearch';

const ROOM_LABELS: Record<string, string> = {
    living_room: '客厅',
    bedroom: '卧室',
    study: '书房',
    user_room: 'TA的房间',
    self_room: '自己的房间',
    attic: '阁楼',
};

/**
 * 检索与当前消息相关的记忆，返回格式化后的 prompt 片段
 *
 * @param charId 角色 ID
 * @param recentMessages 最近几条消息（用于构建查询向量）
 * @param embeddingConfig embedding API 配置
 * @param options 检索选项
 * @returns 格式化的记忆注入文本（可直接拼入 system prompt）
 */
export async function retrieveRelevantMemories(
    charId: string,
    recentMessages: string[],
    embeddingConfig: EmbeddingApiConfig,
    options?: {
        topK?: number;
        roomFilter?: string;
        maxTokenBudget?: number; // 大致的 token 预算（按字数估算）
    }
): Promise<{ text: string; results: SearchResult[]; tokenEstimate: number }> {
    const topK = options?.topK || 5;
    const maxBudget = options?.maxTokenBudget || 800; // ~800 字 ≈ ~1500 tokens

    // 1. 获取角色所有记忆和向量
    const [memories, vectors] = await Promise.all([
        DB.getMemoryNodesByCharId(charId),
        DB.getMemoryVectorsByCharId(charId),
    ]);

    if (memories.length === 0 || vectors.length === 0) {
        return { text: '', results: [], tokenEstimate: 0 };
    }

    // 2. 构建查询文本（最近几条消息拼接）
    const queryText = recentMessages.slice(-3).join(' ');
    if (!queryText.trim()) {
        return { text: '', results: [], tokenEstimate: 0 };
    }

    // 3. 获取查询向量
    let queryVector: number[];
    try {
        queryVector = await getEmbedding(queryText, embeddingConfig);
    } catch (err) {
        console.warn('[MemoryRetrieval] Embedding 查询失败:', err);
        return { text: '', results: [], tokenEstimate: 0 };
    }

    // 4. 向量检索（传入 queryText 用于关键词匹配加分）
    const results = searchMemories(queryVector, memories, vectors, {
        topK,
        roomFilter: options?.roomFilter,
        minSimilarity: 0.3,
        queryText,
    });

    if (results.length === 0) {
        return { text: '', results: [], tokenEstimate: 0 };
    }

    // 5. 更新 lastAccessedAt（被检索到 = 被"回忆"）
    const now = Date.now();
    const updatedNodes: MemoryNode[] = results.map(r => ({
        ...r.memory,
        lastAccessedAt: now,
    }));
    // Fire and forget — 不阻塞主流程
    DB.saveMemoryNodes(updatedNodes).catch(err =>
        console.warn('[MemoryRetrieval] 更新 lastAccessedAt 失败:', err)
    );

    // 6. 格式化输出（控制 token 预算）
    let text = '### 相关记忆碎片 (Memory Palace Recall)\n';
    let charCount = text.length;

    for (const r of results) {
        const roomLabel = ROOM_LABELS[r.memory.room] || r.memory.room;
        const age = formatAge(r.memory.createdAt);
        const line = `- [${roomLabel}] ${r.memory.content} (${age}前, 重要性${r.memory.importance})\n`;

        if (charCount + line.length > maxBudget) break;
        text += line;
        charCount += line.length;
    }

    text += '(以上记忆由记忆宫殿自动检索，请自然地融入回复中，不要逐条复述)\n';

    return {
        text,
        results,
        tokenEstimate: Math.ceil(charCount * 1.5), // 粗略估算中文 token
    };
}

/**
 * 获取角色记忆的统计信息（用于 UI 展示）
 */
export async function getMemoryStats(charId: string): Promise<{
    totalCount: number;
    byRoom: Record<string, number>;
    embeddedCount: number;
    avgImportance: number;
}> {
    const memories = await DB.getMemoryNodesByCharId(charId);

    const byRoom: Record<string, number> = {};
    let embeddedCount = 0;
    let totalImportance = 0;

    for (const m of memories) {
        byRoom[m.room] = (byRoom[m.room] || 0) + 1;
        if (m.embedded) embeddedCount++;
        totalImportance += m.importance;
    }

    return {
        totalCount: memories.length,
        byRoom,
        embeddedCount,
        avgImportance: memories.length > 0 ? totalImportance / memories.length : 0,
    };
}

function formatAge(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `${minutes}分钟`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}天`;
    const months = Math.floor(days / 30);
    return `${months}个月`;
}
