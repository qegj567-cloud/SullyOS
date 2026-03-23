/**
 * Memory Palace — Memory Extraction Pipeline
 * 从聊天记录中提取结构化记忆，调用 LLM 完成分析
 */

import { Message, MemoryNode, MemoryRoom, MemoryProcessBatch, EmbeddingApiConfig } from '../types';
import { safeFetchJson, extractJson } from './safeApi';
import { getEmbeddings } from './memoryEmbedding';
import { findSimilarMemories } from './memorySearch';
import { DB } from './db';

// ============ 提取 Prompt ============

const EXTRACTION_PROMPT = `你是一个记忆整理助手。从以下对话记录中提取值得长期记住的信息。

提取规则：
1. 每条记忆用第三人称陈述句，简短精确（15-40字）
2. 只提取有长期价值的信息（事实、偏好、关系变化、重要事件、情感转折）
3. 忽略日常寒暄、重复内容、临时性话题
4. 如果对话没有值得记住的内容，返回空数组

房间分类：
- living_room: 日常互动、闲聊话题、共同活动
- bedroom: 亲密关系、感情表达、两人之间的承诺
- study: 工作、学习、个人成长、技能
- user_room: 关于用户的个人信息（家庭、习惯、喜好、经历）
- self_room: 角色的自我认知、成长、反思
- attic: 其他杂项

重要性评分 (1-10)：
- 1-3: 普通偏好、日常事实
- 4-6: 有意义的信息（个人经历、明确的喜好）
- 7-8: 重要事件（关系变化、重大决定、强烈情绪）
- 9-10: 核心事件（改变关系本质的事件、关键承诺、重大人生变化）

返回 JSON 格式：
{
  "memories": [
    {
      "content": "记忆内容（第三人称）",
      "room": "房间ID",
      "tags": ["标签1", "标签2"],
      "importance": 数字,
      "mood": "情绪（可选，如 happy/sad/anxious/neutral）"
    }
  ]
}`;

// ============ Pipeline ============

interface ExtractionConfig {
    /** LLM API 配置 */
    apiBaseUrl: string;
    apiKey: string;
    model: string;
    /** Embedding API 配置 */
    embeddingConfig: EmbeddingApiConfig;
    /** 角色名（用于 prompt） */
    charName: string;
    /** 用户名 */
    userName: string;
}

interface ExtractedMemory {
    content: string;
    room: MemoryRoom;
    tags: string[];
    importance: number;
    mood?: string;
}

/**
 * 从聊天消息中提取记忆（调用 LLM）
 */
async function extractMemoriesFromMessages(
    messages: Message[],
    config: ExtractionConfig
): Promise<ExtractedMemory[]> {
    // 格式化聊天记录
    const chatLog = messages.map(m => {
        const name = m.role === 'user' ? config.userName : config.charName;
        return `[${name}]: ${m.content}`;
    }).join('\n');

    const userPrompt = `角色名: ${config.charName}\n用户名: ${config.userName}\n\n对话记录：\n${chatLog}`;

    const data = await safeFetchJson(`${config.apiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
            model: config.model,
            messages: [
                { role: 'system', content: EXTRACTION_PROMPT },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.3,
            max_tokens: 2000,
        }),
    });

    const raw = data?.choices?.[0]?.message?.content || '';
    const parsed = extractJson(raw);

    if (!parsed?.memories || !Array.isArray(parsed.memories)) {
        console.warn('[MemoryExtractor] LLM 返回格式异常:', raw.slice(0, 200));
        return [];
    }

    // 校验并清洗
    return parsed.memories
        .filter((m: any) => m.content && typeof m.content === 'string' && m.content.length > 2)
        .map((m: any) => ({
            content: m.content.trim(),
            room: validateRoom(m.room) || 'attic',
            tags: Array.isArray(m.tags) ? m.tags.filter((t: any) => typeof t === 'string') : [],
            importance: Math.min(10, Math.max(1, Number(m.importance) || 5)),
            mood: typeof m.mood === 'string' ? m.mood : undefined,
        }));
}

function validateRoom(room: string): MemoryRoom | null {
    const valid: MemoryRoom[] = ['living_room', 'bedroom', 'study', 'user_room', 'self_room', 'attic'];
    return valid.includes(room as MemoryRoom) ? room as MemoryRoom : null;
}

/**
 * 完整的记忆整理 Pipeline
 *
 * 1. 获取未处理的聊天记录
 * 2. 分批调用 LLM 提取记忆
 * 3. Embedding 向量化
 * 4. 去重合并
 * 5. 写入 IndexedDB
 */
export async function processMemoryBatch(
    charId: string,
    config: ExtractionConfig,
    options?: {
        batchSize?: number;       // 每批处理的消息数（默认 50）
        skipRecentCount?: number; // 跳过最近 N 条消息（默认 100，避免处理正在进行的对话）
    }
): Promise<MemoryProcessBatch | null> {
    const batchSize = options?.batchSize || 50;
    const skipRecent = options?.skipRecentCount || 100;

    // 1. 确定从哪条消息开始处理
    const batches = await DB.getMemoryBatches(charId);
    const lastProcessedId = batches.length > 0
        ? Math.max(...batches.map(b => b.lastMessageId))
        : 0;

    // 2. 获取所有消息（从上次处理的位置开始）
    const allMessages = await DB.getMessagesByCharId(charId);
    const candidateMessages = allMessages
        .filter(m =>
            m.id > lastProcessedId &&
            m.type === 'text' &&
            (m.role === 'user' || m.role === 'assistant')
        );

    // 跳过最近的消息
    if (candidateMessages.length <= skipRecent) {
        console.log(`[MemoryPalace] 不够消息需要处理 (${candidateMessages.length} <= ${skipRecent} skip threshold)`);
        return null;
    }

    const messagesToProcess = candidateMessages.slice(0, candidateMessages.length - skipRecent);
    const batch = messagesToProcess.slice(0, batchSize);

    if (batch.length === 0) return null;

    console.log(`[MemoryPalace] 开始处理 ${batch.length} 条消息 (ID ${batch[0].id} - ${batch[batch.length - 1].id})`);

    // 3. 调用 LLM 提取记忆
    const extracted = await extractMemoriesFromMessages(batch, config);

    if (extracted.length === 0) {
        // 即使没提取到记忆，也记录批次（避免重复处理）
        const emptyBatch: MemoryProcessBatch = {
            id: `batch_${Date.now()}`,
            charId,
            processedAt: Date.now(),
            lastMessageId: batch[batch.length - 1].id,
            extractedCount: 0,
            mergedCount: 0,
            log: ['未从本批次对话中发现值得记录的记忆'],
        };
        await DB.saveMemoryBatch(emptyBatch);
        return emptyBatch;
    }

    // 4. 创建 MemoryNode 对象
    const now = Date.now();
    const newNodes: MemoryNode[] = extracted.map((e, i) => ({
        id: `mem_${now}_${i}`,
        charId,
        content: e.content,
        source: 'chat' as const,
        sourceMessageIds: batch.map(m => m.id),
        room: e.room,
        tags: e.tags,
        importance: e.importance,
        lastAccessedAt: now,
        createdAt: now,
        embedded: false,
        embeddingVersion: 0,
        mood: e.mood,
        processBatch: `batch_${now}`,
    }));

    // 5. Embedding 向量化
    const texts = newNodes.map(n => n.content);
    let vectors: number[][] = [];
    try {
        vectors = await getEmbeddings(texts, config.embeddingConfig);
    } catch (err) {
        console.error('[MemoryPalace] Embedding 失败:', err);
        // 即使 embedding 失败也保存节点（后续可重试）
        await DB.saveMemoryNodes(newNodes);
        const failBatch: MemoryProcessBatch = {
            id: `batch_${now}`,
            charId,
            processedAt: now,
            lastMessageId: batch[batch.length - 1].id,
            extractedCount: newNodes.length,
            mergedCount: 0,
            log: [
                `提取了 ${newNodes.length} 条记忆`,
                `⚠️ Embedding 失败: ${(err as Error).message}`,
                '记忆已保存但未向量化，下次整理时会重试',
            ],
        };
        await DB.saveMemoryBatch(failBatch);
        return failBatch;
    }

    // 标记为已向量化
    for (let i = 0; i < newNodes.length; i++) {
        newNodes[i].embedded = true;
        newNodes[i].embeddingVersion = 1;
    }

    // 6. 去重检查（与已有记忆比较）
    const existingNodes = await DB.getMemoryNodesByCharId(charId);
    const existingVectors = await DB.getMemoryVectorsByCharId(charId);

    let mergedCount = 0;
    const log: string[] = [];
    const finalNodes: MemoryNode[] = [];
    const finalVectors: { memoryId: string; charId: string; vector: number[]; dimensions: number; version: number }[] = [];

    for (let i = 0; i < newNodes.length; i++) {
        const node = newNodes[i];
        const vec = vectors[i];

        // 检查与已有记忆的相似度
        const similar = findSimilarMemories(vec, existingNodes, existingVectors, node.id, 0.9);

        if (similar.length > 0) {
            // 合并：保留已有的，更新重要性
            const existing = similar[0].memory;
            if (node.importance > existing.importance) {
                existing.importance = node.importance;
                existing.lastAccessedAt = now;
                await DB.saveMemoryNode(existing);
                log.push(`合并: "${node.content}" → "${existing.content}" (提升重要性到 ${node.importance})`);
            } else {
                log.push(`跳过重复: "${node.content}" (已存在类似记忆)`);
            }
            mergedCount++;
        } else {
            finalNodes.push(node);
            finalVectors.push({
                memoryId: node.id,
                charId,
                vector: vec,
                dimensions: vec.length,
                version: 1,
            });

            const roomLabel = ROOM_LABELS[node.room] || node.room;
            log.push(`新记忆 [${roomLabel}] (重要性${node.importance}): "${node.content}"`);
        }
    }

    // 7. 写入
    if (finalNodes.length > 0) {
        await DB.saveMemoryNodes(finalNodes);
        await DB.saveMemoryVectors(finalVectors);
    }

    // 8. 记录批次
    const batchRecord: MemoryProcessBatch = {
        id: `batch_${now}`,
        charId,
        processedAt: now,
        lastMessageId: batch[batch.length - 1].id,
        extractedCount: newNodes.length,
        mergedCount,
        log,
    };
    await DB.saveMemoryBatch(batchRecord);

    console.log(`[MemoryPalace] 完成: 提取 ${newNodes.length}, 新增 ${finalNodes.length}, 合并 ${mergedCount}`);
    return batchRecord;
}

/**
 * 为未向量化的记忆补充 embedding（重试机制）
 */
export async function embedUnprocessedMemories(
    charId: string,
    embeddingConfig: EmbeddingApiConfig
): Promise<number> {
    const unembedded = await DB.getUnembeddedMemories(charId);
    if (unembedded.length === 0) return 0;

    const texts = unembedded.map(n => n.content);
    const vectors = await getEmbeddings(texts, embeddingConfig);

    const updatedNodes: MemoryNode[] = [];
    const newVectors: { memoryId: string; charId: string; vector: number[]; dimensions: number; version: number }[] = [];

    for (let i = 0; i < unembedded.length; i++) {
        const node = { ...unembedded[i], embedded: true, embeddingVersion: 1 };
        updatedNodes.push(node);
        newVectors.push({
            memoryId: node.id,
            charId,
            vector: vectors[i],
            dimensions: vectors[i].length,
            version: 1,
        });
    }

    await DB.saveMemoryNodes(updatedNodes);
    await DB.saveMemoryVectors(newVectors);

    console.log(`[MemoryPalace] 补充向量化 ${updatedNodes.length} 条记忆`);
    return updatedNodes.length;
}

const ROOM_LABELS: Record<string, string> = {
    living_room: '客厅',
    bedroom: '卧室',
    study: '书房',
    user_room: 'TA的房间',
    self_room: '自己的房间',
    attic: '阁楼',
};
