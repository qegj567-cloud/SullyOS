/**
 * Memory Palace — 旧记忆迁移工具 (Migration)
 *
 * 按月把旧的 MemoryFragment[] 日度总结送给 LLM，
 * 以角色第一人称视角重新提取为 MemoryNode。
 * 月度总结（refinedMemories）不需要，日度总结信息更完整。
 * 旧数据不删不改。
 */

import type { MemoryFragment } from '../../types';
import type { MemoryNode, MemoryRoom, EmbeddingConfig } from './types';
import type { LightLLMConfig } from './pipeline';
import { MemoryNodeDB } from './db';
import { vectorizeAndStore } from './vectorStore';
import { buildLinks } from './links';
import { runConsolidation } from './consolidation';
import { safeFetchJson } from '../safeApi';
import { safeParseJsonArray } from './jsonUtils';
import {
    buildRelatedMemoriesBlock, buildRelatedToRule, buildRelatedToFormatHint,
    parseRelatedToAndHints,
} from './extraction';
import type { RelatedMemoryRef, EventBoxHint } from './extraction';
import { fetchRelatedMemoriesForExtraction, splitLogsToBullets, sampleSnippetsFromMessages } from './relatedMemories';
import { bindMemoriesIntoEventBox } from './eventBox';
import { maybeCompressEventBoxes } from './eventBoxCompression';

function generateId(): string {
    return `mn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 把 LLM 吐的 v/a 夹到 [-1, 1]，防止它写成 1.5 / -2 之类 */
function clampVA(x: number): number {
    if (Number.isNaN(x)) return 0;
    if (x > 1) return 1;
    if (x < -1) return -1;
    return x;
}

// ─── 按月分组 ────────────────────────────────────────

function groupByMonth(memories: MemoryFragment[]): Map<string, MemoryFragment[]> {
    const groups = new Map<string, MemoryFragment[]>();
    for (const mem of memories) {
        // 日期格式可能是 "2026-01-27", "2026/1/27", "2026年1月27日" 等
        let monthKey = 'unknown';
        try {
            const normalized = mem.date.replace(/[年\/]/g, '-').replace(/[月日]/g, '');
            const parts = normalized.split('-');
            if (parts.length >= 2) {
                monthKey = `${parts[0]}-${parts[1].padStart(2, '0')}`;
            }
        } catch { /* keep unknown */ }

        const existing = groups.get(monthKey) || [];
        existing.push(mem);
        groups.set(monthKey, existing);
    }
    return groups;
}

// ─── LLM 按月提取记忆 ────────────────────────────────

interface ChunkExtractionResult {
    /** 提取出的"待安顿"节点（已带 charId 和 createdAt，待补充 id/embedded 等字段后存盘） */
    items: (Omit<MemoryNode, 'id' | 'charId' | 'embedded' | 'lastAccessedAt' | 'accessCount'> & { _parsedIdx: number })[];
    /** LLM 标注的 relatedTo（指向已有记忆 O0..）/ sameAs（指向本批次内其它新记忆 0-base）引用；binding 阶段映射成真实 id */
    rawRelated: {
        itemIdx: number;
        refs: string[];           // O 编号 → 已有记忆
        sameAsRefs: string[];     // N 或纯数字 → 本批次新记忆（只能指向 itemIdx 之前的条目）
        eventName?: string;
        eventTags?: string[];
    }[];
}

async function extractMonthMemories(
    monthKey: string,
    dailyLogs: MemoryFragment[],
    charName: string,
    charContext: string,
    llmConfig: LightLLMConfig,
    userName: string | undefined,
    relatedMemories: RelatedMemoryRef[],
): Promise<ChunkExtractionResult> {

    // 拼接该月所有日度总结，不截断
    const logsText = dailyLogs
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(m => `[${m.date}] (${m.mood || 'neutral'}): ${m.summary}`)
        .join('\n\n');

    const contextBlock = charContext
        ? `\n## 你的人设\n${charContext}\n`
        : '';

    const userLabel = userName || 'TA';

    const hasRelated = relatedMemories.length > 0;
    const relatedBlock = hasRelated ? buildRelatedMemoriesBlock(relatedMemories) : '';
    const relatedToRule = hasRelated ? buildRelatedToRule() : '';
    const relatedToFormat = hasRelated ? buildRelatedToFormatHint() : '';

    const systemPrompt = `你是 ${charName}。以下是你 ${monthKey} 这个月的日常记录。请以你的第一人称视角（"我"），从中提取值得长期记住的记忆。${contextBlock}${relatedBlock}

## 规则

1. **第一人称叙事**：用"我"的视角记录，用户用"${userLabel}"指代。保持完整事件脉络，不要掐头去尾。
2. **重要性分级**：
   - 1–5：日常琐事（15–50字）
   - 6–7：有情感价值的事件（60–120字），包含我的感受
   - 8–10：重大事件（100–200字），完整因果+我的反应
3. **房间分配**（凡是涉及${userLabel}的家人/朋友/同事等人际关系，**一律进 user_room**，哪怕只是一次具体事件）：
   - living_room：**纯日常琐事**（不涉及重要人际关系、也不涉及深层情感）
   - bedroom：${userLabel}和我之间的亲密情感、深层羁绊、感动时刻
   - study：工作、学习、技能
   - user_room：关于${userLabel}的**一切个人信息和人际事件**——生日/习惯/喜好/性格/成长经历/情绪模式，**以及${userLabel}的家人、亲戚、朋友、同事相关的一切事件**（家人健康、家庭聚会、家庭矛盾、外公外婆/父母/兄弟姐妹的故事、朋友交往、同事冲突等）。这些事件即便是"一次性"的，也应进 user_room 而不是 living_room。
   - self_room：我自身的成长、认同变化
   - attic：未解决的矛盾、困惑、伤害
   - windowsill：期盼、目标、憧憬
4. **情绪标签**：happy, sad, angry, anxious, tender, excited, peaceful, confused, hurt, grateful, nostalgic, neutral
5. **情感坐标**（valence, arousal）：在 mood 之外，还要给出二维情感坐标供后续情感推理。
   - valence（效价）：-1（极痛苦）→ +1（极愉悦）
   - arousal（唤醒度）：-1（极平静）→ +1（极激烈）
   参考："开心"约 (0.7, 0.5)，"平静"约 (0.5, -0.6)，"失落"约 (-0.5, -0.4)，"焦虑"约 (-0.6, 0.7)，"愤怒"约 (-0.7, 0.8)。
6. **不要遗漏任何事件**。这些日度总结本身已经是精华，每一件事都值得保留为独立记忆。一条日度总结里如果有3件事，就提取3条记忆。宁可多提取，不要压缩遗漏。
7. **必须保留精确日期**：date 字段填该事件发生的具体日期（从日志的日期标签读取）。内容中也自然提及时间。${relatedToRule}

## 输出

严格 JSON 数组，不要用 markdown 包裹，直接输出 JSON：
[{"content": "...", "room": "...", "importance": 5, "mood": "...", "valence": 0, "arousal": 0, "tags": ["..."], "date": "YYYY-MM-DD"${relatedToFormat}}]

注意：content 中的引号必须用中文引号（""）而不是英文引号，避免 JSON 解析出错。

date 字段填记忆对应的大概日期。`;

    try {
        const data = await safeFetchJson(
            `${llmConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${llmConfig.apiKey}`,
                },
                body: JSON.stringify({
                    model: llmConfig.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: logsText },
                    ],
                    temperature: 0.5,
                    // 12000 比 16000 留余量，避免 LLM 贴着 cap 产出被截断；
                    // 配合外层 sub-batch 切分（≤6 天/call），输出 token 一般在 3k-6k，12k 充分够
                    max_tokens: 12000,
                    stream: false,
                }),
            },
            1,         // 失败只再试 1 次（整体 3 次 × 5min = 15min 太久）
            5 * 60_000, // 单次 5 分钟硬超时：第一批 142s 就过了，若超过 5min 基本是 provider 卡死，
                       // 继续等只会让用户误以为整页冻住（实际主线程闲着等 fetch），主动 abort 切下一批。
            { appName: '记忆宫殿', purpose: '记忆迁移' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
        const parsed = safeParseJsonArray(reply);

        if (!Array.isArray(parsed) || parsed.length === 0) {
            if (reply.trim().length > 0) {
                console.warn(`🏰 [Migration] ${monthKey}: LLM 返回了内容但解析为空，原始回复前200字: ${reply.slice(0, 200)}`);
            } else {
                console.warn(`🏰 [Migration] ${monthKey}: LLM 返回空内容`);
            }
            return { items: [], rawRelated: [] };
        }

        const validRooms: MemoryRoom[] = [
            'living_room', 'bedroom', 'study', 'user_room',
            'self_room', 'attic', 'windowsill',
        ];

        const items: ChunkExtractionResult['items'] = [];
        const rawRelated: ChunkExtractionResult['rawRelated'] = [];

        let itemIdx = 0;
        for (let parsedIdx = 0; parsedIdx < parsed.length; parsedIdx++) {
            const item = parsed[parsedIdx];
            if (!item || !item.content) continue;

            // 解析日期
            let createdAt = Date.now();
            try {
                if (item.date) {
                    const d = new Date(item.date);
                    if (!isNaN(d.getTime())) createdAt = d.getTime();
                }
            } catch { /* use now */ }

            // (v, a) 非必需：LLM 没给就不写，下游 getEmotionVA 查表兜底
            const vRaw = typeof item.valence === 'number' ? item.valence : undefined;
            const aRaw = typeof item.arousal === 'number' ? item.arousal : undefined;
            const valence = vRaw !== undefined ? clampVA(vRaw) : undefined;
            const arousal = aRaw !== undefined ? clampVA(aRaw) : undefined;

            items.push({
                content: item.content,
                room: (validRooms.includes(item.room as MemoryRoom) ? item.room : 'living_room') as MemoryRoom,
                tags: Array.isArray(item.tags) ? item.tags : [],
                importance: Math.max(1, Math.min(10, Math.round(item.importance || 5))),
                mood: item.mood || 'neutral',
                valence,
                arousal,
                createdAt,
                _parsedIdx: parsedIdx,
            });

            // 收集 relatedTo（跨批次）+ sameAs（本批次内）+ eventName/eventTags
            const relatedTo = Array.isArray(item.relatedTo)
                ? item.relatedTo.map((r: any) => String(r)) : [];
            const sameAsRefs = Array.isArray(item.sameAs)
                ? item.sameAs.map((r: any) => String(r)) : [];
            if (relatedTo.length > 0 || sameAsRefs.length > 0) {
                rawRelated.push({
                    itemIdx,
                    refs: relatedTo,
                    sameAsRefs,
                    eventName: typeof item.eventName === 'string' ? item.eventName.trim() : undefined,
                    eventTags: Array.isArray(item.eventTags)
                        ? item.eventTags.map((t: any) => String(t).trim()).filter(Boolean)
                        : undefined,
                });
            }
            itemIdx++;
        }

        return { items, rawRelated };

    } catch (err: any) {
        console.error(`❌ [Migration] ${monthKey} LLM 提取失败:`, err.message);
        return { items: [], rawRelated: [] };
    }
}

// ─── 主迁移函数 ─────────────────────────────────────

export interface MigrationProgress {
    phase: 'grouping' | 'extracting' | 'vectorizing' | 'linking' | 'done';
    current: number;
    total: number;
    currentMonth?: string;
}

/**
 * 按月把旧记忆送给 LLM 重新提取，然后向量化存入记忆宫殿
 *
 * @param charName 角色名（LLM 用第一人称时需要知道自己是谁）
 * @param memories 旧的 MemoryFragment[]（日度总结）
 * @param llmConfig 轻量 LLM 配置
 * @param embeddingConfig Embedding 配置
 * @param onProgress 进度回调
 */
/**
 * 获取旧记忆的可用月份列表（供 UI 选择）
 */
export function getAvailableMonths(memories: MemoryFragment[]): string[] {
    const monthGroups = groupByMonth(memories);
    return Array.from(monthGroups.keys()).sort();
}

/**
 * 将一个月的日志拆成上旬/中旬/下旬 3 个分块
 */
function splitMonthToThirds(monthKey: string, dailyLogs: MemoryFragment[]): { key: string; logs: MemoryFragment[] }[] {
    const sorted = dailyLogs.sort((a, b) => a.date.localeCompare(b.date));
    const upper: MemoryFragment[] = [];   // 1-10 日
    const middle: MemoryFragment[] = [];  // 11-20 日
    const lower: MemoryFragment[] = [];   // 21-31 日

    for (const log of sorted) {
        let day = 15; // 默认归中旬
        try {
            const normalized = log.date.replace(/[年\/]/g, '-').replace(/[月日]/g, '');
            const parts = normalized.split('-');
            if (parts.length >= 3) day = parseInt(parts[2], 10) || 15;
        } catch { /* default middle */ }

        if (day <= 10) upper.push(log);
        else if (day <= 20) middle.push(log);
        else lower.push(log);
    }

    const result: { key: string; logs: MemoryFragment[] }[] = [];
    if (upper.length > 0) result.push({ key: `${monthKey} 上旬`, logs: upper });
    if (middle.length > 0) result.push({ key: `${monthKey} 中旬`, logs: middle });
    if (lower.length > 0) result.push({ key: `${monthKey} 下旬`, logs: lower });

    // 如果因为日期解析问题全部落入同一个分块或为空，直接返回整月
    if (result.length === 0) result.push({ key: monthKey, logs: sorted });

    return result;
}

/**
 * 获取可用的分块列表（每月拆上旬/中旬/下旬），供 UI 逐块选择
 * 返回 { key: "2026-03 上旬", count: 12 }[]
 */
export function getAvailableChunks(memories: MemoryFragment[]): { key: string; count: number }[] {
    const monthGroups = groupByMonth(memories);
    const months = Array.from(monthGroups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const chunks: { key: string; count: number }[] = [];
    for (const [monthKey, dailyLogs] of months) {
        const parts = splitMonthToThirds(monthKey, dailyLogs);
        for (const part of parts) {
            chunks.push({ key: part.key, count: part.logs.length });
        }
    }
    return chunks;
}

export async function migrateOldMemories(
    charId: string,
    charName: string,
    memories: MemoryFragment[],
    refinedMemories: Record<string, string> | undefined,
    llmConfig: LightLLMConfig,
    embeddingConfig: EmbeddingConfig,
    onProgress?: (p: MigrationProgress) => void,
    charContext?: string,
    selectedMonths?: string[],
    userName?: string,
    /** 可选：传入则迁移尾部的 consolidation room 变更会同步到 Supabase */
    remoteConfig?: import('./types').RemoteVectorConfig,
): Promise<{ migrated: number; skipped: number; months: number }> {

    if (memories.length === 0) return { migrated: 0, skipped: 0, months: 0 };

    // 1. 按月分组
    onProgress?.({ phase: 'grouping', current: 0, total: memories.length });
    const monthGroups = groupByMonth(memories);
    let months = Array.from(monthGroups.entries())
        .sort((a, b) => a[0].localeCompare(b[0]));

    // 2. 每月拆成上旬/中旬/下旬 3 个分块
    const allNodes: MemoryNode[] = [];

    const chunks: { key: string; logs: MemoryFragment[] }[] = [];
    for (const [monthKey, dailyLogs] of months) {
        const parts = splitMonthToThirds(monthKey, dailyLogs);
        chunks.push(...parts);
    }

    // 如果指定了分块，只处理选中的分块
    let filteredChunks = chunks;
    if (selectedMonths && selectedMonths.length > 0) {
        const selected = new Set(selectedMonths);
        filteredChunks = chunks.filter(c => selected.has(c.key));
        console.log(`🏰 [Migration] 已选分块: [${selectedMonths.join(', ')}]，共 ${filteredChunks.length} 个分块`);
    } else {
        console.log(`🏰 [Migration] 全量迁移：${memories.length} 条日度总结 → ${months.length} 个月 → ${filteredChunks.length} 个分块`);
    }

    const total = filteredChunks.length;
    console.log(`🏰 [Migration] 待处理 ${total} 个分块（每月拆上旬/中旬/下旬）`);

    // 累计：所有分块产生的 EventBox 触达 ID（最后统一压缩）
    const allTouchedBoxIds = new Set<string>();
    let migrated = 0;
    let skipped = 0;

    for (let i = 0; i < filteredChunks.length; i++) {
        const { key: chunkKey, logs: allChunkLogs } = filteredChunks[i];
        // 再次切分：避免一次喂给 LLM 太多日度总结导致输出 token 被 cap 截断
        // （16000 max_tokens 听起来很多，但 LLM 要输出 60-80 条 JSON 记忆 + 每条带
        // sameAs/relatedTo/eventName/eventTags 字段，很容易撑爆。thinking 模型还要
        // 额外吞 reasoning tokens。）
        const MAX_LOGS_PER_LLM_CALL = 6;
        const subBatches: { logs: MemoryFragment[]; label: string }[] = [];
        for (let off = 0; off < allChunkLogs.length; off += MAX_LOGS_PER_LLM_CALL) {
            const part = allChunkLogs.slice(off, off + MAX_LOGS_PER_LLM_CALL);
            const label = allChunkLogs.length > MAX_LOGS_PER_LLM_CALL
                ? `${chunkKey} (${off + 1}-${off + part.length}/${allChunkLogs.length})`
                : chunkKey;
            subBatches.push({ logs: part, label });
        }

        for (let sbIdx = 0; sbIdx < subBatches.length; sbIdx++) {
            const { logs: dailyLogs, label: currentLabel } = subBatches[sbIdx];
            onProgress?.({ phase: 'extracting', current: i + 1, total, currentMonth: currentLabel });

        // 1) 取相关旧记忆（含本次迁移已落地的较早 chunk，所以"3 月上旬→3 月中旬"能跨 chunk 关联）
        //    细粒度策略：日志归档是 YAML 列表 (`- 事件X`)，按 bullet 拆成每条事件一个 query；
        //    切不出列表（模板被改过）时 fallback 到旧的 3 段切法
        const sortedLogs = dailyLogs.slice().sort((a, b) => a.date.localeCompare(b.date));
        let logSnippets = splitLogsToBullets(sortedLogs);
        let strategy = 'bullets';
        if (logSnippets.length === 0) {
            logSnippets = buildLogSnippets(sortedLogs);
            strategy = 'per-sentence';
        }
        // 迁移场景：候选池必须够大，LLM 才能在"新记忆 B"旁看到"旧记忆 A"
        // 做匹配。threshold 放松一些，maxTotal 翻倍到 30。
        const relatedRefs = await fetchRelatedMemoriesForExtraction(logSnippets, charId, embeddingConfig, {
            threshold: 0.30,
            perQueryTopK: 3,
            maxTotal: 30,
        });
        if (relatedRefs.length > 0) {
            console.log(`🏰 [Migration] [${i + 1}/${total}] 检索到 ${relatedRefs.length} 条相关已有记忆（${strategy}，${logSnippets.length} 段 query）`);
        } else {
            console.log(`🏰 [Migration] [${i + 1}/${total}] 候选池为空（${strategy}，${logSnippets.length} 段 query） —— 可能本批次是最早的迁移批次，没旧记忆可匹配`);
        }

        // 2) LLM 提取（带 relatedTo 提示）
        console.log(`🏰 [Migration] [${i + 1}/${total}] 开始 LLM 提取 → ${currentLabel}（${dailyLogs.length} 条日度总结），模型: ${llmConfig.model}`);
        const llmStart = Date.now();
        const { items, rawRelated } = await extractMonthMemories(
            currentLabel, dailyLogs, charName, charContext || '', llmConfig, userName, relatedRefs,
        );
        const llmElapsed = ((Date.now() - llmStart) / 1000).toFixed(1);
        console.log(`🏰 [Migration] [${i + 1}/${total}] LLM 提取完成 ← ${currentLabel}: ${items.length} 条记忆，耗时 ${llmElapsed}s`);

        if (items.length === 0) continue;

        // 3) 组装 MemoryNode 并立即向量化（让后续 chunk 能搜到）
        const chunkNodes: MemoryNode[] = [];
        for (const item of items) {
            chunkNodes.push({
                id: generateId(),
                charId,
                content: item.content,
                room: item.room,
                tags: item.tags,
                importance: item.importance,
                mood: item.mood,
                valence: item.valence,
                arousal: item.arousal,
                embedded: false,
                createdAt: item.createdAt,
                lastAccessedAt: item.createdAt,
                accessCount: 0,
                eventBoxId: null,
                origin: 'extraction',
            });
            await new Promise(r => setTimeout(r, 2)); // 避免 ID 碰撞
        }

        onProgress?.({ phase: 'vectorizing', current: i + 1, total, currentMonth: currentLabel });
        const vecStart = Date.now();
        // 走 0.9 cosine 去重：之前迁移路径关去重是因为怀疑加载全量 Float32Array 导致
        // tab 冻死，后来查出真凶是 Supabase RPC CORS 放大 + Worker 并发 handler 覆盖
        //（见 vectorSearch.ts / relatedMemories.ts 的熔断逻辑），跟这里的去重无关。
        // 语义去重能挡掉"7-12 号某天又提到 3 号那件事"这种跨 sub-batch 重复。
        //
        // 远程同步：以前这里传 undefined 导致迁移写入的新节点只落本地 IDB，
        // 跨设备或本地清空后就彻底丢失。现在跟着 pipeline.ts processNewMessages 一样
        // 透传 remoteConfig，让每条新节点的向量也 fire-and-forget upsert 到 Supabase。
        const vecResult = await vectorizeAndStore(chunkNodes, embeddingConfig, remoteConfig);
        const vecElapsed = ((Date.now() - vecStart) / 1000).toFixed(1);
        migrated += vecResult.stored;
        skipped += vecResult.skipped;
        console.log(`🏰 [Migration] [${i + 1}/${total}] 向量化完成：存储 ${vecResult.stored}，跳过 ${vecResult.skipped}，耗时 ${vecElapsed}s`);

        // 4) EventBox 绑定：rawRelated 引用 → 真实 memoryId 链接 + hints
        //    同时处理跨批次 O 引用 (refs) 和本批次 N 引用 (sameAsRefs)
        //    本批次内 A 和 B 同事件（比如 4.5 和 4.9 在同一 chunk 但同一件事）就在这里捕获
        if (rawRelated.length > 0) {
            const crossLinks: { newMemoryId: string; existingMemoryId: string }[] = [];
            const hints: EventBoxHint[] = [];
            for (const r of rawRelated) {
                const newNode = chunkNodes[r.itemIdx];
                if (!newNode) continue;
                // (a) 跨批次 O 引用（指向已有记忆）
                for (const ref of r.refs) {
                    const idx = parseInt(String(ref).replace(/^O/i, ''), 10);
                    if (idx >= 0 && idx < relatedRefs.length) {
                        crossLinks.push({
                            newMemoryId: newNode.id,
                            existingMemoryId: relatedRefs[idx].id,
                        });
                    }
                }
                // (b) 本批次 sameAs 引用（指向 itemIdx 之前的新记忆）
                for (const ref of r.sameAsRefs) {
                    const idx = parseInt(String(ref).replace(/^N/i, ''), 10);
                    if (idx >= 0 && idx < r.itemIdx && chunkNodes[idx]) {
                        crossLinks.push({
                            newMemoryId: newNode.id,
                            existingMemoryId: chunkNodes[idx].id,
                        });
                    }
                }
                if (r.eventName || (r.eventTags && r.eventTags.length > 0)) {
                    hints.push({
                        newMemoryId: newNode.id,
                        eventName: r.eventName || '',
                        eventTags: r.eventTags || [],
                    });
                }
            }
            if (crossLinks.length > 0) {
                try {
                    const touched = await bindMemoriesIntoEventBox(charId, crossLinks, hints);
                    for (const id of touched) allTouchedBoxIds.add(id);
                    console.log(`📦 [Migration] [${i + 1}/${total}] EventBox 绑定：${crossLinks.length} 条 → 触达 ${touched.size} 个事件盒`);
                } catch (e: any) {
                    console.warn(`📦 [Migration] [${i + 1}/${total}] EventBox 绑定失败（不影响已存记忆）: ${e.message}`);
                }
            }
        }
        // 每个 sub-batch 跑完：短暂 idle，让 V8 回收本轮产生的 Float32Array / LLM 响应串
        // （单 chunk 跨多个 sub-batch 时避免堆压力累积导致后面分块崩 tab）
        if (sbIdx < subBatches.length - 1) {
            await new Promise(r => setTimeout(r, 200));
        }
        } // end of inner sub-batch loop

        // 每个 chunk 跑完：更长的 idle，给浏览器充足时间做一次 minor/major GC
        // 观察到"第一 chunk OK 第二 chunk 卡爆"是典型的堆碎片化症状，GC 只要有时间就能回收
        if (i < filteredChunks.length - 1) {
            await new Promise(r => setTimeout(r, 600));
        }
    }

    if (migrated === 0 && skipped === 0) {
        onProgress?.({ phase: 'done', current: 0, total: 0 });
        return { migrated: 0, skipped: 0, months: filteredChunks.length };
    }

    // 5) EventBox 压缩：所有 chunk 处理完后统一扫一遍触达的 box
    if (allTouchedBoxIds.size > 0) {
        console.log(`🗜️ [Migration] 开始压缩 ${allTouchedBoxIds.size} 个被触达的事件盒...`);
        try {
            await maybeCompressEventBoxes(allTouchedBoxIds, llmConfig, embeddingConfig, charName, userName);
        } catch (e: any) {
            console.warn(`🗜️ [Migration] 压缩失败（不影响已存记忆）: ${e.message}`);
        }
    }

    // 6) buildLinks：保留 temporal/co-activation 弱关联（不影响 EventBox）
    console.log(`🏰 [Migration] 开始建立 MemoryLink 弱关联...`);
    const linkStart = Date.now();
    onProgress?.({ phase: 'linking', current: 0, total: migrated });

    const allStored = await MemoryNodeDB.getByCharId(charId);
    const migratedNodes = allStored.filter(n =>
        n.origin === 'extraction' && !n.archived && !n.isBoxSummary
    );

    if (migratedNodes.length >= 2) {
        const linkBatchSize = 30;
        for (let i = 0; i < migratedNodes.length; i += linkBatchSize) {
            const batch = migratedNodes.slice(i, i + linkBatchSize);
            const rest = migratedNodes.filter(n => !batch.some(b => b.id === n.id));
            await buildLinks(batch, rest.slice(0, 50));
        }
    }

    const linkElapsed = ((Date.now() - linkStart) / 1000).toFixed(1);
    console.log(`🏰 [Migration] 弱关联建立完成，耗时 ${linkElapsed}s`);

    // 7) 补跑巩固：迁移写入的节点没经过日常聊天管线的 processNewMessages，
    //    也就没跑过 runConsolidation。高 imp（≥8）和 imp≥6 且年代较老的节点
    //    按规则本应从 living_room 晋升到 bedroom，不做这一步，它们会永远卡在
    //    living_room（similarity 权重 0.50 + recency 几乎归零），导致检索时
    //    高相关老家庭记忆排不上来。失败不影响迁移结果。
    //    remoteConfig 已在 vectorizeAndStore 阶段把新节点推到 Supabase，
    //    这里 consolidation 内部的 bulkSetRoom 会把 room 字段一并同步过去。
    try {
        const consolidationResult = await runConsolidation(charId, remoteConfig);
        if (consolidationResult.promoted.length > 0 || consolidationResult.evicted.length > 0) {
            console.log(`✅ [Migration] 迁移后巩固：${consolidationResult.promoted.length} 条晋升到 bedroom，${consolidationResult.evicted.length} 条因客厅容量转入 attic`);
        }
    } catch (e: any) {
        console.warn(`🏰 [Migration] 巩固失败（不影响已存记忆）: ${e.message}`);
    }

    onProgress?.({ phase: 'done', current: migrated, total: migrated + skipped });

    console.log(`✅ [Migration] 迁移完成：${migrated} 条存储, ${skipped} 条去重跳过, 来自 ${filteredChunks.length} 个分块（${months.length} 个月），触发 ${allTouchedBoxIds.size} 个 EventBox 压缩扫描`);
    return { migrated, skipped, months: filteredChunks.length };
}

/**
 * Fallback query 构造：当 splitLogsToBullets 失败（用户总结不是 YAML 列表）时，
 * 用"按句切分 + 每个句子一个 query"代替原来的"头/中/尾 3 段"。
 * 原因：3 段把几十天的总结压成 3 个质心，召回候选只有 3-9 条，A 常被漏掉。
 * 按句切后 20-40 个 query，每个 top 3 → 候选池丰富，LLM 才有机会发现"B 和 A
 * 是同一件事"。
 */
function buildLogSnippets(sortedLogs: MemoryFragment[]): string[] {
    if (sortedLogs.length === 0) return [];
    const MIN_FRAG_CHARS = 10;   // 过滤"好的"/"嗯"这种无效短句
    const MAX_FRAG_CHARS = 300;  // 单句过长（极少见）截断
    const MAX_SNIPPETS = 20;     // 单 chunk 最多这么多 query，避免并行 vectorSearch 击穿浏览器
    const snippets: string[] = [];
    for (const log of sortedLogs) {
        const summary = (log.summary || '').trim();
        if (!summary) continue;
        // 按中英文句末标点、换行切分；保留标点让语义完整。
        // 不用后行断言 (?<=…): iOS Safari <16.4 的 JSC 不支持, 旧设备 new RegExp 会抛
        // "invalid group specifier name". 改成「句末标点后插哨兵(标点留前句) + 换行换哨兵」再 split,
        // 与原 (?<=[标点])\s*|\n+ 字节等价 (见 utils/lookbehindFree.test.ts)。
        const SPLIT = String.fromCharCode(1);
        const parts = summary
            .replace(/([。！？!?])\s*/g, `$1${SPLIT}`)
            .replace(/\n+/g, SPLIT)
            .split(SPLIT)
            .map(s => s.trim())
            .filter(Boolean);
        for (const p of parts) {
            if (p.replace(/[\s\p{P}]/gu, '').length < MIN_FRAG_CHARS) continue;
            snippets.push(`[${log.date}] ${p.slice(0, MAX_FRAG_CHARS)}`);
            if (snippets.length >= MAX_SNIPPETS) return snippets;
        }
    }
    // 回兜：如果切完一条句子都没有（全是短句语气词），用整段 summary 做 query
    if (snippets.length === 0) {
        for (const log of sortedLogs.slice(0, 10)) {
            const text = `[${log.date}] ${log.summary.slice(0, MAX_FRAG_CHARS)}`;
            if (text.trim()) snippets.push(text);
        }
    }
    return snippets;
}
