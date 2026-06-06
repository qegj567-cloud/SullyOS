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
    EVENT_BOX_SUMMARY_TARGET_CHARS,
    EVENT_BOX_SUMMARY_HARD_MAX_CHARS,
} from './types';
import { EventBoxDB, MemoryNodeDB } from './db';
import type { LightLLMConfig } from './pipeline';
import { vectorizeAndStore } from './vectorStore';
import { bulkSetArchived } from './supabaseVector';
import { safeFetchJson, extractJson } from '../safeApi';

const VALID_ROOMS: MemoryRoom[] = [
    'living_room', 'bedroom', 'study', 'user_room',
    'self_room', 'attic', 'windowsill',
];

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

    const systemPrompt = `你是 ${charName}。下面这些记忆都属于一件事：「${box.name}」。
请把它们整合成一段连贯的、第一人称（「我」）的回忆。

**要求（严格遵守）**：
1. **第一人称**（用「我」），从 ${charName} 的视角写。${userLabel} 用名字直接称呼。
2. **字数目标 ${EVENT_BOX_SUMMARY_TARGET_CHARS} 字以内，绝对上限 ${EVENT_BOX_SUMMARY_HARD_MAX_CHARS} 字**。紧凑、务实、不口水。
3. **只保留关键信息**：具体人物、动作、对象、场景、转折、情绪。**去掉所有语气填充、修辞铺陈、重复感慨**（如「真是的」、「怎么说呢」、「不过话说回来」等）。事实先行。
4. **带时间点但不冗余**：每件事标一次日期就够（「3 月 20 日…4 月 5 日…」），不要每句都重复时间。
5. **连贯但简洁**：不套「起因/经过/结果」模板，但要让读者能按顺序看懂事情怎么发展的。
6. **覆盖所有关键词**（这是给向量检索用的）—— 每条新增的旧记忆里出现过的具体名词、地点、人物必须在 content 里出现一次。
7. **content 字符串内严禁使用半角双引号 \`"\`**。要引用人物原话、书名、外号、术语，一律用中文方角引号「」、《》或单引号 \`'\`。否则会破坏外层 JSON 解析、整批记忆白丢。

附带输出 metadata：
- name：5-12 字的精炼盒名
- tags：5-10 个具体的搜索 tag（具体名词）
- room：${VALID_ROOMS.join(' / ')}
- importance：1-10
- mood：happy / sad / angry / anxious / tender / excited / peaceful / confused / hurt / grateful / nostalgic / neutral

严格 JSON，不要 markdown 包裹（content 里的引用一律用「」/《》/'，不要用 "）：
{
  "content": "（紧凑的第一人称回忆，${EVENT_BOX_SUMMARY_TARGET_CHARS}字内）",
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
            2, 0, { appName: '记忆宫殿', purpose: '事件压缩' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
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
        // 硬截断安全网：LLM 超限时截断并追加提示，避免单盒 summary 无限膨胀
        let content = String(parsed.content);
        if (content.length > EVENT_BOX_SUMMARY_HARD_MAX_CHARS) {
            console.warn(`🗜️ [Compression] LLM summary ${content.length} 字超过硬上限 ${EVENT_BOX_SUMMARY_HARD_MAX_CHARS}，截断`);
            content = content.slice(0, EVENT_BOX_SUMMARY_HARD_MAX_CHARS) + '……';
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
    await MemoryNodeDB.save(summaryNode);

    // 5. 向量化 summary（跳过去重，因为内容必然和 live 节点重叠）
    const remoteCfg = getRemoteVectorConfig();
    try {
        await vectorizeAndStore([summaryNode], embeddingConfig, remoteCfg, { skipDedup: true });
    } catch (e: any) {
        console.warn(`🗜️ [Compression] summary 向量化失败（继续后续步骤）: ${e?.message}`);
    }

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
        const box = await EventBoxDB.getById(id);
        if (!box) { skipped++; continue; }
        if (box.liveMemoryIds.length < EVENT_BOX_COMPRESSION_THRESHOLD) {
            skipped++;
            continue;
        }
        try {
            const ok = await compressEventBox(box, llmConfig, embeddingConfig, charName, userName);
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
