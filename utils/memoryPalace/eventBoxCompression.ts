/**
 * Memory Palace — EventBox 压缩
 *
 * 当 EventBox 的活节点 ≥ COMPRESSION_THRESHOLD (4) 条时触发：
 *   1. LLM 把"旧 summary?(若有) + 所有活节点"整合成一段第一人称连贯回忆
 *   2. 创建/更新 box.summaryNodeId 指向的 MemoryNode（isBoxSummary=true）
 *   3. 总结节点向量化、写入本地+远程
 *   4. 所有活节点 archived=true（本地保存 + 远程 bulkSetArchived）
 *   5. 更新 box.archivedMemoryIds / liveMemoryIds=[] / compressionCount++
 *
 * 触发点：
 *   - pipeline.processNewMessages 在 vectorize 之后扫描 touched boxes
 *   - migration.migrateOldMemories 全部 chunk 处理完后扫描 touched boxes
 *
 * 重压缩：第 N 次时，"旧 summary + 新活节点" 一起送给 LLM 重写，覆盖旧 summary。
 */

import type { EventBox, MemoryNode, EmbeddingConfig, MemoryRoom, RemoteVectorConfig } from './types';
import {
    EVENT_BOX_COMPRESSION_THRESHOLD,
    EVENT_BOX_SEAL_THRESHOLD,
    EVENT_BOX_SUMMARY_TARGET_MIN_CHARS,
    EVENT_BOX_SUMMARY_TARGET_MAX_CHARS,
    EVENT_BOX_SUMMARY_HARD_MAX_CHARS,
} from './types';
import { EventBoxDB, MemoryNodeDB } from './db';
import type { LightLLMConfig } from './pipeline';
import { vectorizeAndStore } from './vectorStore';
import { bulkSetArchived } from './supabaseVector';
import { safeFetchJson, extractContent, extractJson } from '../safeApi';
import { enforceSummaryLengthBudget } from './summaryLengthBudget';
import { buildSARMemoryBoundaryInstruction } from '../messageFormat';
import { hasSummaryReasoningLeak } from '../summaryReasoning';
export { hasSummaryReasoningLeak } from '../summaryReasoning';

const VALID_ROOMS: MemoryRoom[] = [
    'living_room', 'bedroom', 'study', 'user_room',
    'self_room', 'attic', 'windowsill',
];

// Automatic compression and manual regeneration must never publish over each other.
const compressingBoxes = new Set<string>();
async function withEventBoxCompressionLock<T>(boxId: string, work: () => Promise<T>): Promise<T> {
    const busy = () => new Error('这个事件盒正在整合，请等待本次完成后再试');
    if (compressingBoxes.has(boxId)) throw busy();
    compressingBoxes.add(boxId);
    try {
        // Web Locks also coordinate other tabs. The Set covers runtimes without Web Locks.
        if (typeof navigator !== 'undefined' && navigator.locks?.request) {
            return await navigator.locks.request(`sullyos:event-box-compression:${boxId}`, { ifAvailable: true }, lock => {
                if (!lock) throw busy();
                return work();
            });
        }
        return await work();
    } finally { compressingBoxes.delete(boxId); }
}

function generateNodeId(): string {
    return `mn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getRemoteVectorConfig(): RemoteVectorConfig | undefined {
    try {
        const raw = localStorage.getItem('os_remote_vector_config');
        if (!raw) return undefined;
        const c = JSON.parse(raw) as RemoteVectorConfig;
        return (c.enabled && (c as any).initialized) ? c : undefined;
    } catch { return undefined; }
}

interface CompressionLLMResult {
    content: string;
    name: string;
    tags: string[];
    room: MemoryRoom;
    importance: number;
    mood: string;
}

/**
 * 字段级兜底解析：当 LLM 在 content 里塞了未转义的 ASCII "（中文输出高发，
 * 标准 JSON.parse 直接挂），按已知 schema 把六个字段一个一个抠出来。
 *
 * 策略：content 抠到下一个顶层键（name/tags/room/importance/mood）出现之前为止，
 * 其余字段用宽松正则。任何一个字段失败都视为兜底失败，让上层走原 null 路径。
 */
function recoverCompressionFields(raw: string): Partial<CompressionLLMResult> | null {
    if (!raw) return null;
    const text = raw
        .replace(/^```(?:json|JSON)?\s*\n?/gm, '')
        .replace(/\n?```\s*$/gm, '')
        .trim();

    // 找到 content 字段值的起始引号
    const contentStartMatch = text.match(/"content"\s*:\s*"/);
    if (!contentStartMatch || contentStartMatch.index === undefined) return null;
    const valueStart = contentStartMatch.index + contentStartMatch[0].length;

    // content 结束的判据：紧跟着 ", "name"|"tags"|"room"|"importance"|"mood" 这种下一个顶层键
    // 用「最后一个 " + 任意空白/逗号 + 下一个键名」的匹配，能正确跳过中间所有 ASCII "
    const tailMatch = text.slice(valueStart).match(/"\s*,\s*"(?:name|tags|room|importance|mood)"\s*:/);
    if (!tailMatch || tailMatch.index === undefined) return null;
    const rawContent = text.slice(valueStart, valueStart + tailMatch.index);

    // 把抠出来的 raw content 做 JSON 字符串转义还原。\\ 用占位符暂存，
    // 避免 \" 被错误地拆成 \ + \"。残留的裸 " 不动——上层 JSON.parse 已失败，
    // 走到这里说明 LLM 在 content 内就是塞了未转义的 "，保留即可，最终 summary 是普通字符串。
    const BS = '\u0001';
    const normalized = rawContent
        .replace(/\\\\/g, BS)
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"')
        .split(BS).join('\\');

    const findStr = (key: string): string | undefined => {
        const m = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
        return m?.[1];
    };
    const findNum = (key: string): number | undefined => {
        const m = text.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
        return m ? Number(m[1]) : undefined;
    };
    const findTags = (): string[] | undefined => {
        const m = text.match(/"tags"\s*:\s*\[([^\]]*)\]/);
        if (!m) return undefined;
        return m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    };

    return {
        content: normalized,
        name: findStr('name'),
        tags: findTags(),
        room: findStr('room') as MemoryRoom | undefined,
        importance: findNum('importance'),
        mood: findStr('mood'),
    };
}

// ─── 压缩 LLM 调用 ─────────────────────────────────────

async function callCompressionLLM(
    box: EventBox,
    oldSummaryContent: string | null,
    liveNodes: MemoryNode[],
    llmConfig: LightLLMConfig,
    charName: string,
    userName: string | undefined,
): Promise<CompressionLLMResult | null> {
    const userLabel = userName || '用户';

    const formatDate = (ts: number): string => {
        const d = new Date(ts);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    const livesText = liveNodes
        .map(n => `[${formatDate(n.createdAt)}｜重要性${n.importance}｜${n.mood}] ${n.content}`)
        .join('\n\n');

    const oldSummaryBlock = oldSummaryContent
        ? `\n## 你之前已经回忆过这件事一次，那时记下的是：\n${oldSummaryContent}\n\n后来又新增了下面这些：\n`
        : `\n## 关于这件事的零散记忆碎片：\n`;
    const sarMemoryBoundary = buildSARMemoryBoundaryInstruction(`${oldSummaryContent || ''}\n${livesText}`);

    const systemPrompt = `你是 ${charName}。下面这些记忆都属于一件事：「${box.name}」。
请把它们整合成一段连贯的、第一人称（「我」）的回忆。

**要求（严格遵守）**：
1. **第一人称**（用「我」），从 ${charName} 的视角写。${userLabel} 用名字直接称呼。
2. **字数目标 ${EVENT_BOX_SUMMARY_TARGET_MIN_CHARS}-${EVENT_BOX_SUMMARY_TARGET_MAX_CHARS} 字**。紧凑、务实、不口水；事实较多时允许超出，不能为了凑字数省略事实或截断句子。
3. **只保留关键信息**：具体人物、动作、对象、场景、转折、情绪。**去掉所有语气填充、修辞铺陈、重复感慨**（如「真是的」、「怎么说呢」、「不过话说回来」等）。事实先行。
4. **带时间点但不冗余**：每件事标一次日期就够（「3 月 20 日…4 月 5 日…」），不要每句都重复时间。
5. **连贯但简洁**：不套「起因/经过/结果」模板，但要让读者能按顺序看懂事情怎么发展的。
6. **覆盖所有关键词**（这是给向量检索用的）—— 每条新增的旧记忆里出现过的具体名词、地点、人物必须在 content 里出现一次。
7. **content 字符串内严禁使用半角双引号 \`"\`**。要引用人物原话、书名、外号、术语，一律用中文方角引号「」、《》或单引号 \`'\`。否则会破坏外层 JSON 解析、整批记忆白丢。
${sarMemoryBoundary ? `\n${sarMemoryBoundary}` : ''}

附带输出 metadata：
- name：5-12 字的精炼盒名
- tags：5-10 个具体的搜索 tag（具体名词）
- room：${VALID_ROOMS.join(' / ')}
- importance：1-10
- mood：happy / sad / angry / anxious / tender / excited / peaceful / confused / hurt / grateful / nostalgic / neutral

严格 JSON，不要 markdown 包裹（content 里的引用一律用「」/《》/'，不要用 "）：
{
  "content": "（紧凑的第一人称回忆，${EVENT_BOX_SUMMARY_TARGET_MIN_CHARS}-${EVENT_BOX_SUMMARY_TARGET_MAX_CHARS}字）",
  "name": "...",
  "tags": ["...", "..."],
  "room": "...",
  "importance": 7,
  "mood": "..."
}`;

    const userMsg = `${oldSummaryBlock}\n${livesText}`;

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
                        { role: 'user', content: userMsg },
                    ],
                    temperature: 0.5,
                    max_tokens: 8000,
                    stream: false,
                }),
            },
            2, 120_000, { appName: '记忆宫殿', purpose: '事件压缩' }
        );

        if (['length', 'max_tokens', 'content_filter'].includes(data?.choices?.[0]?.finish_reason)) {
            throw new Error('整合回忆输出未完成，原内容已保留');
        }
        // 统一剥除 <think> 块并兼容分段 content / reasoning-only 中转。
        // 未标记的推理泄漏由 hasSummaryReasoningLeak 在手动重整路径继续拦截。
        const reply = extractContent(data);
        let parsed: any = extractJson(reply);
        const parseFailed = !parsed || typeof parsed !== 'object';
        const contentMissing = !parseFailed && (!parsed.content || typeof parsed.content !== 'string');

        if (parseFailed || contentMissing) {
            // 兜底：LLM 在 content 里嵌了未转义的 ASCII "（中文场景高发，破坏 JSON 解析），
            // 按已知 schema 用正则把六个字段单独抠出来——content 抠到下一个顶层键之前为止。
            const recovered = recoverCompressionFields(reply);
            if (recovered && recovered.content) {
                console.warn(`🗜️ [Compression] JSON 解析失败但字段级兜底成功（疑似 content 内含未转义 "）`);
                parsed = recovered;
            } else if (parseFailed) {
                console.warn(`🗜️ [Compression] LLM 输出无法解析为 JSON，原始前 300 字: ${reply.slice(0, 300)}`);
                return null;
            } else {
                console.warn(`🗜️ [Compression] LLM 输出缺少 content 字段，已解析键: ${Object.keys(parsed).join(',')}`);
                return null;
            }
        }
        // 长度只是精简目标；二次压缩失败仍保存完整正文，不能机械截掉事实。
        let content = String(parsed.content);
        if (content.length > EVENT_BOX_SUMMARY_HARD_MAX_CHARS) {
            console.warn(`🗜️ [Compression] LLM summary ${content.length} 字，尝试精简一次；不达标时保留完整正文`);
            content = await enforceSummaryLengthBudget(
                content,
                (t) => recompressSummary(t, EVENT_BOX_SUMMARY_TARGET_MAX_CHARS, llmConfig, charName),
                EVENT_BOX_SUMMARY_HARD_MAX_CHARS,
            );
        }
        // 这种输出即使 JSON 合法、长度也没过硬上限，语义上仍不是回忆正文。
        // 自动压缩同样拒绝，避免以后继续产出截图里的污染 summary；活节点会保留，
        // 下次触发仍可重试。手动重新整合的外层还会立即再试一次。
        if (hasSummaryReasoningLeak(content)) {
            console.error(`🧹 [Compression] 检测到整合回忆混入字数计算/推理过程，已拒绝保存`);
            return null;
        }
        return {
            content,
            name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : box.name,
            tags: Array.isArray(parsed.tags) ? parsed.tags.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 15) : box.tags,
            room: VALID_ROOMS.includes(parsed.room) ? parsed.room : 'living_room',
            importance: Math.max(1, Math.min(10, Math.round(Number(parsed.importance) || 5))),
            mood: typeof parsed.mood === 'string' && parsed.mood.trim() ? parsed.mood.trim() : 'neutral',
        };
    } catch (err: any) {
        console.error(`🗜️ [Compression] LLM 调用失败: ${err?.message || err}`);
        return null;
    }
}

// ─── 整合回忆精简：超长二次压缩，失败保留完整正文 ──────────

/**
 * 让模型把过长的整合回忆压缩回 targetMaxChars 字内（纯文本输出，不走 JSON）。
 * 失败返回 null，由 enforceSummaryLengthBudget 决定兜底。
 */
async function recompressSummary(
    text: string,
    targetMaxChars: number,
    llmConfig: LightLLMConfig,
    charName: string,
): Promise<string | null> {
    const systemPrompt = `你是 ${charName}。下面这段第一人称回忆写得太长了。请在**不丢关键信息**（具体人物、地点、事件、转折、情绪）的前提下，把它压缩到 ${targetMaxChars} 字以内。
要求：保持第一人称（「我」）、连贯通顺；只删语气填充和重复铺陈，不删事实；引用一律用「」《》或单引号，不要用半角双引号。
直接输出压缩后的回忆正文，不要解释、不要 JSON、不要 markdown 包裹。`;
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
                        { role: 'user', content: text },
                    ],
                    temperature: 0.3,
                    max_tokens: 4000,
                    stream: false,
                }),
            },
            2, 90_000, { appName: '记忆宫殿', purpose: '事件压缩-二次压缩' }
        );
        if (['length', 'max_tokens', 'content_filter'].includes(data?.choices?.[0]?.finish_reason)) return null;
        const reply = extractContent(data).trim();
        // 模型偶尔仍会裹 ``` 代码块，剥掉常见包裹
        const cleaned = reply.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
        return cleaned && !hasSummaryReasoningLeak(cleaned) ? cleaned : null;
    } catch (err: any) {
        console.warn(`🗜️ [Compression] 二次压缩 LLM 调用失败: ${err?.message || err}`);
        return null;
    }
}

// ─── 单 box 压缩主流程 ──────────────────────────────────

async function compressEventBox(
    box: EventBox,
    llmConfig: LightLLMConfig,
    embeddingConfig: EmbeddingConfig,
    charName: string,
    userName: string | undefined,
): Promise<boolean> {
    // 1. 加载活节点（按时间升序）
    const liveNodes: MemoryNode[] = [];
    for (const id of box.liveMemoryIds) {
        const n = await MemoryNodeDB.getById(id);
        if (n && !n.archived) liveNodes.push(n);
    }
    if (liveNodes.length === 0) return false;
    liveNodes.sort((a, b) => a.createdAt - b.createdAt);

    // 2. 加载旧 summary 内容（如有）
    let oldSummaryContent: string | null = null;
    if (box.summaryNodeId) {
        const old = await MemoryNodeDB.getById(box.summaryNodeId);
        if (old) oldSummaryContent = old.content;
    }

    console.log(`🗜️ [Compression] 开始压缩 ${box.id} "${box.name}"（${liveNodes.length} 条活节点，第 ${box.compressionCount + 1} 次压缩）`);

    // 3. LLM 整合
    const result = await callCompressionLLM(box, oldSummaryContent, liveNodes, llmConfig, charName, userName);
    if (!result) {
        console.error(`🗜️ [Compression] ${box.id} "${box.name}" LLM 失败，跳过本次压缩 — 活节点 ${liveNodes.length} 条仍未归档，summary 未生成/未向量化`);
        return false;
    }

    // 4. 创建或更新 summary 节点
    const now = Date.now();
    let summaryNode: MemoryNode;
    if (box.summaryNodeId) {
        const existing = await MemoryNodeDB.getById(box.summaryNodeId);
        if (existing) {
            existing.content = result.content;
            existing.room = result.room;
            existing.importance = result.importance;
            existing.mood = result.mood;
            existing.tags = result.tags;
            existing.lastAccessedAt = now;
            existing.embedded = false;  // 重新向量化
            existing.eventBoxId = box.id;
            existing.isBoxSummary = true;
            existing.archived = false;
            existing.origin = 'system';
            summaryNode = existing;
        } else {
            // summaryNodeId 指向的节点丢失，新建
            summaryNode = createSummaryNode(box, result, now);
            box.summaryNodeId = summaryNode.id;
        }
    } else {
        summaryNode = createSummaryNode(box, result, now);
        box.summaryNodeId = summaryNode.id;
    }
    // 先生成向量再保存新摘要；限流/失败时保留旧摘要和全部活节点。
    const remoteCfg = getRemoteVectorConfig();
    const vectorized = await vectorizeAndStore([summaryNode], embeddingConfig, remoteCfg, { skipDedup: true });
    if (vectorized.stored !== 1) throw new Error('摘要向量化未完成，事件盒仍保留原始记忆');

    // 6. 标记活节点 archived（本地）
    const liveIds = box.liveMemoryIds.slice();
    for (const id of liveIds) {
        const n = await MemoryNodeDB.getById(id);
        if (n && !n.archived) {
            n.archived = true;
            await MemoryNodeDB.save(n);  // syncNodeMetadataToRemote 会同步 archived=true
        }
    }
    // 远程批量加速（与上面 per-node sync 重复但幂等）
    if (remoteCfg) {
        await bulkSetArchived(remoteCfg, liveIds, true).catch(() => {});
    }

    // 7. 更新 box 状态
    for (const id of liveIds) {
        if (!box.archivedMemoryIds.includes(id)) box.archivedMemoryIds.push(id);
    }
    box.liveMemoryIds = [];
    box.compressionCount += 1;
    box.lastCompressedAt = now;
    box.updatedAt = now;
    box.name = result.name;
    box.tags = result.tags;

    // 8. 封盒检查：事件总数（archived + live）达到阈值 → sealed，新的相关记忆另开新盒
    const totalEvents = box.archivedMemoryIds.length + box.liveMemoryIds.length;
    if (totalEvents >= EVENT_BOX_SEAL_THRESHOLD && !box.sealed) {
        box.sealed = true;
        console.log(`🔒 [Compression] ${box.id} 事件数 ${totalEvents} 达阈值 ${EVENT_BOX_SEAL_THRESHOLD}，封盒`);
    }

    await EventBoxDB.save(box);

    console.log(`✅ [Compression] ${box.id} → summary ${result.content.length}字 "${result.content.slice(0, 30)}…"，已归档 ${liveIds.length} 条${box.sealed ? '，已封盒' : ''}`);

    // 9. 门牌增量合并：盒子的结论落到有门牌的房间时，顺手沉淀进该房间的门牌。
    //    封盒的沉淀物就是语义事实——这是"情景→语义"固化的即时触发点。
    try {
        const { isPlateRoom, updatePlateFromBoxSummary } = await import('./roomPlates');
        if (!llmConfig.deferPlateMaintenance && isPlateRoom(summaryNode.room)) {
            await updatePlateFromBoxSummary(
                box.charId, summaryNode.room, summaryNode.content,
                llmConfig, charName, userName,
            );
        }
    } catch (e: any) {
        console.warn(`🚪 [Compression] 门牌增量合并失败（不影响压缩结果）: ${e?.message || e}`);
    }

    return true;
}

function createSummaryNode(box: EventBox, result: CompressionLLMResult, now: number): MemoryNode {
    return {
        id: generateNodeId(),
        charId: box.charId,
        content: result.content,
        room: result.room,
        tags: result.tags,
        importance: result.importance,
        mood: result.mood,
        embedded: false,
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 0,
        eventBoxId: box.id,
        isBoxSummary: true,
        archived: false,
        origin: 'system',
    };
}

export interface RegenerateEventBoxSummaryResult {
    box: EventBox;
    summary: MemoryNode;
    sourceCount: number;
}

/**
 * 手动“重新整合全部回忆”。
 *
 * 与自动增量压缩刻意不同：
 * - 原料始终是 archived + live 的全部成员，不使用旧 summary，避免坏总结自我复制；
 * - 成功后归档本次参与的原始节点，新增归档记一次压缩，达到阈值封盒；
 * - 新总结必须先成功生成 Embedding，才会覆盖旧 summary 节点；
 * - 已封盒同样允许执行。
 */
export async function regenerateEventBoxSummary(
    boxId: string,
    llmConfig: LightLLMConfig,
    embeddingConfig: EmbeddingConfig,
    charName: string,
    userName?: string,
    remoteVectorConfig?: RemoteVectorConfig,
): Promise<RegenerateEventBoxSummaryResult> {
    return withEventBoxCompressionLock(boxId, () => regenerateEventBoxSummaryUnlocked(
        boxId, llmConfig, embeddingConfig, charName, userName, remoteVectorConfig,
    ));
}

async function regenerateEventBoxSummaryUnlocked(
    boxId: string,
    llmConfig: LightLLMConfig,
    embeddingConfig: EmbeddingConfig,
    charName: string,
    userName?: string,
    remoteVectorConfig?: RemoteVectorConfig,
): Promise<RegenerateEventBoxSummaryResult> {
    const box = await EventBoxDB.getById(boxId);
    if (!box) throw new Error('这个事件盒已经不存在了');

    const sourceIds = [...new Set([
        ...box.archivedMemoryIds,
        ...box.liveMemoryIds,
    ])].filter(id => id !== box.summaryNodeId);
    const loaded = await Promise.all(sourceIds.map(id => MemoryNodeDB.getById(id)));
    const sourceNodes = loaded
        .filter((node): node is MemoryNode => Boolean(
            node
            && node.charId === box.charId
            && (!node.eventBoxId || node.eventBoxId === box.id)
            && node.id !== box.summaryNodeId
            && !node.isBoxSummary,
        ))
        .sort((a, b) => a.createdAt - b.createdAt);
    if (sourceNodes.length === 0) throw new Error('盒内没有可用于重新整合的原始记忆');

    // 输出结构失败或出现典型推理泄漏时自动重试一次。两次都失败则保持旧总结不动。
    let result: CompressionLLMResult | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const candidate = await callCompressionLLM(
            box,
            null, // 关键：绝不把旧 summary 当原料
            sourceNodes,
            llmConfig,
            charName,
            userName,
        );
        if (candidate && !hasSummaryReasoningLeak(candidate.content)) {
            result = candidate;
            break;
        }
        if (candidate) {
            console.error(`🧹 [Compression] ${box.id} 第 ${attempt} 次重新整合混入推理过程，已拒绝保存`);
        }
    }
    if (!result) {
        throw new Error('副 API 两次都没有返回干净的整合回忆，原内容已保留');
    }

    const now = Date.now();
    const existing = box.summaryNodeId
        ? await MemoryNodeDB.getById(box.summaryNodeId)
        : undefined;
    const summaryNode: MemoryNode = existing
        ? {
            ...existing,
            content: result.content,
            room: result.room,
            importance: result.importance,
            mood: result.mood,
            tags: result.tags,
            lastAccessedAt: now,
            embedded: false,
            eventBoxId: box.id,
            isBoxSummary: true,
            archived: false,
            origin: 'system',
        }
        : createSummaryNode(box, result, now);

    // Embedding 成功后，在同一事务写总结、向量、归档标记和成员列表。
    // 不预存 summaryNode，任何一步失败都保留原内容。
    const remoteCfg = remoteVectorConfig?.enabled && remoteVectorConfig.initialized
        ? remoteVectorConfig
        : getRemoteVectorConfig();
    let committed: { box: EventBox; archived: MemoryNode[] } | undefined;
    const vectorized = await vectorizeAndStore(
        [summaryNode],
        embeddingConfig,
        remoteCfg,
        { skipDedup: true, commit: async entries => {
            if (entries.length !== 1) throw new Error('整合回忆向量不完整，原内容已保留');
            committed = await EventBoxDB.commitRegeneration(box, sourceNodes, entries[0], result.name, now);
        } },
    );
    if (vectorized.stored !== 1 || !committed) {
        throw new Error('整合回忆已生成，但语义向量没有成功写入，原内容已保留');
    }

    const freshBox = committed.box;
    if (remoteCfg) await bulkSetArchived(remoteCfg, committed.archived.map(node => node.id), true).catch(() => {});

    // 与自动压缩保持一致：若总结属于门牌房间，让新的干净结论继续沉淀。
    // 门牌失败不影响已经成功落库的总结与向量。
    try {
        const { isPlateRoom, updatePlateFromBoxSummary } = await import('./roomPlates');
        if (isPlateRoom(summaryNode.room)) {
            await updatePlateFromBoxSummary(
                freshBox.charId,
                summaryNode.room,
                summaryNode.content,
                llmConfig,
                charName,
                userName,
            );
        }
    } catch (e: any) {
        console.warn(`🚪 [Compression] 重新整合后的门牌同步失败（总结与向量已生效）: ${e?.message || e}`);
    }

    return {
        box: freshBox,
        summary: { ...summaryNode, embedded: true },
        sourceCount: sourceNodes.length,
    };
}

// ─── 公共 API：扫描 + 触发压缩 ──────────────────────────

/**
 * 检查一组 box 是否达到压缩阈值，达到的逐个压缩。
 * 调用方：pipeline 处理新消息后 / migration 跑完后。
 */
export async function maybeCompressEventBoxes(
    boxIds: Iterable<string>,
    llmConfig: LightLLMConfig,
    embeddingConfig: EmbeddingConfig,
    charName: string,
    userName?: string,
): Promise<{ compressed: number; skipped: number }> {
    let compressed = 0;
    let skipped = 0;

    for (const id of boxIds) {
        try {
            const ok = await withEventBoxCompressionLock(id, async () => {
                const box = await EventBoxDB.getById(id);
                if (!box || box.liveMemoryIds.length < EVENT_BOX_COMPRESSION_THRESHOLD) return false;
                return compressEventBox(box, llmConfig, embeddingConfig, charName, userName);
            });
            if (ok) compressed++;
            else skipped++;
        } catch (e: any) {
            console.error(`🗜️ [Compression] ${id} 压缩异常: ${e?.message}`);
            skipped++;
        }
    }

    if (compressed > 0) {
        console.log(`🗜️ [Compression] 本轮完成：压缩 ${compressed} 个 box，跳过 ${skipped} 个`);
    }
    return { compressed, skipped };
}

/**
 * 全角色扫一遍，触发所有满足阈值的 box 压缩（手动维护接口）。
 */
export async function compressAllEligibleBoxes(
    charId: string,
    llmConfig: LightLLMConfig,
    embeddingConfig: EmbeddingConfig,
    charName: string,
    userName?: string,
): Promise<{ compressed: number; skipped: number }> {
    const allBoxes = await EventBoxDB.getByCharId(charId);
    const eligible = allBoxes.filter(b => b.liveMemoryIds.length >= EVENT_BOX_COMPRESSION_THRESHOLD);
    return maybeCompressEventBoxes(eligible.map(b => b.id), llmConfig, embeddingConfig, charName, userName);
}
