/**
 * 外部记忆搬家
 *
 * 给「神经链接 -> 传统记忆」和「记忆宫殿 -> 向量记忆」共用：
 * - 单次最多 5 万字；
 * - 按自然段分批调用 LLM，避免长输入时模型只处理开头；
 * - 只整理时间与结构，不做摘要、不删除细节；
 * - 输出可直接转成 MemoryNode，供后续 embedding / 建链。
 */

import type { MemoryNode, MemoryRoom } from './types';
import type { LightLLMConfig } from './pipeline';
import { safeFetchJson } from '../safeApi';

export const EXTERNAL_MEMORY_MAX_CHARS = 50_000;
export const EXTERNAL_MEMORY_CHUNK_CHARS = 3_000;
export const EXTERNAL_MEMORY_TIMEOUT_MS = 600_000;
export const EXTERNAL_MEMORY_MIN_CONTENT_RATIO = 0.72;

export interface ExternalMemoryLengthInfo {
    /** Unicode 字符数（emoji 等代理对按 1 个字符计算），完全在本地统计。 */
    count: number;
    limit: number;
    overLimit: boolean;
    overBy: number;
    /** 超限时建议拆成几次导入；未超限为 1。 */
    suggestedBatches: number;
}

export function getExternalMemoryLengthInfo(rawText: string): ExternalMemoryLengthInfo {
    const count = Array.from(rawText).length;
    return {
        count,
        limit: EXTERNAL_MEMORY_MAX_CHARS,
        overLimit: count > EXTERNAL_MEMORY_MAX_CHARS,
        overBy: Math.max(0, count - EXTERNAL_MEMORY_MAX_CHARS),
        suggestedBatches: Math.max(1, Math.ceil(count / EXTERNAL_MEMORY_MAX_CHARS)),
    };
}

export function getExternalMemoryOverLimitMessage(rawText: string): string {
    const info = getExternalMemoryLengthInfo(rawText);
    if (!info.overLimit) return '';
    return `当前 ${info.count.toLocaleString()} 字，超过单次上限 ${info.limit.toLocaleString()} 字。`
        + `建议按原文顺序拆成 ${info.suggestedBatches} 批，每批不超过 5 万字，优先在日期或完整事件段落之间切开。`
        + '当前内容不会上传，也不会调用 API。';
}

const VALID_ROOMS: MemoryRoom[] = [
    'living_room', 'bedroom', 'study', 'user_room',
    'self_room', 'attic', 'windowsill',
];
const VALID_MOODS = new Set([
    'happy', 'sad', 'angry', 'anxious', 'tender', 'excited',
    'peaceful', 'confused', 'hurt', 'grateful', 'nostalgic', 'neutral',
]);

export interface ExternalMemoryBatchResult {
    index: number;
    total: number;
    extracted: number;
    ok: boolean;
    error?: string;
}

export interface ExternalMemoryExtractionResult {
    memories: MemoryNode[];
    batches: ExternalMemoryBatchResult[];
}

/** 保留原文顺序，优先在换行处分批；不对内容做摘要或字符截断。 */
export function splitExternalMemoryText(
    rawText: string,
    chunkChars: number = EXTERNAL_MEMORY_CHUNK_CHARS,
): string[] {
    const text = rawText.replace(/\r\n?/g, '\n').trim();
    if (!text) return [];
    const lengthInfo = getExternalMemoryLengthInfo(text);
    if (lengthInfo.overLimit) {
        throw new Error(getExternalMemoryOverLimitMessage(text));
    }
    if (chunkChars < 1) throw new Error('分批长度必须大于 0');

    const chunks: string[] = [];
    let cursor = 0;
    while (cursor < text.length) {
        let end = Math.min(cursor + chunkChars, text.length);
        if (end < text.length) {
            // 至少走过本批 60% 后才回找自然边界，避免遇到很早的换行就切出碎片。
            const minNaturalBreak = cursor + Math.floor(chunkChars * 0.6);
            const newline = text.lastIndexOf('\n', end);
            if (newline >= minNaturalBreak) end = newline + 1;
        }
        const chunk = text.slice(cursor, end).trim();
        if (chunk) chunks.push(chunk);
        cursor = end;
    }
    return chunks;
}

export function buildExternalMemoryPrompt(charName: string, userName: string): string {
    const userLabel = userName || '用户';
    return `你是“外部记忆搬家整理器”。这些文字来自别的应用、设备或记忆系统，要迁入 ${charName} 的记忆。

你必须同时完成两个硬目标，缺一不可：
A. 输出能被程序直接解析、字段符合下方定义的完整 JSON 数组。
B. 对原文做无损搬运：只整理时间和结构，不压缩内容；不删除、不更改、不压缩内容。

1. 不得总结、概括、润色、改写、合并同类项或去重；不得用一句结论代替一段经历，也不得输出“略”“其余同上”等省略表达。
2. 原文里的每个具体事实、人物、称呼、地点、数字、对话、动作、因果、先后顺序、情绪和细微反应都必须保留。宁可多拆几条，也不能省略。
3. 先锁定人物身份，再做必要的视角转换；严禁把所有“我/你/他/她”机械归给同一个人。
   - 目标记忆主人固定是“${charName}”；与其对话和相处的用户固定是“${userLabel}”。
   - 身份判断优先级：原文明示的姓名或角色标签 > 说话人标签与上下文 > 代词。明确证据优先，不能反过来靠猜测覆盖姓名。
   - 原文标明由 ${charName} 叙述时，叙述中的“我”可转成记忆第一人称“我”；原文标明由 ${userLabel}/用户叙述时，“我”必须写成“${userLabel}”，绝不能写成 ${charName} 的“我”。
   - 第三方保持原姓名或原称呼，不得擅自改成 ${charName} 或 ${userLabel}。
   - 引号内的第一人称属于原说话人，对话必须原样保留，不能把引号里的“我”替换成记忆主人。
   - 如果片段缺少说话人、代词指向无法可靠判断，保留原称呼/代词并忠实搬运，不猜、不补人物关系。
   例：来源标注“${userLabel}：我带了娃娃出门”时，应写“${userLabel}带了娃娃出门”，不能写“我带了娃娃出门”；来源标注“${charName}：我没敢问”时，才可写“我没敢问”。
4. 1500 字只是单条 content 的拆分提示，不是压缩目标。原事件太长时，按自然段连续拆成多条并完整承接；禁止为了满足字数而删改、缩写或截断。
5. date 填事件实际日期，格式 YYYY-MM-DD。原文只有月份可填 YYYY-MM；只有年份可填 YYYY；完全不确定填 null。严禁猜日期。
6. room 先按记忆主体与用途分类，不要看到负面内容就塞进阁楼：
   - living_room：纯日常琐事
   - bedroom：${userLabel}和我的共同经历、亲密情感与深层羁绊（即使其中有难过或争执）
   - study：工作、学习、技能、职业
   - user_room：${userLabel}的个人信息、经历、家人、朋友、同事与人际事件（即使事件是负面的）
   - self_room：我自身的成长、认同变化与个人经历
   - attic：仅限“当前仍明确未解决，而且核心就是矛盾、持续困惑或尚在影响的伤害/创伤”的记忆
   - windowsill：期盼、目标、未来愿望
   房间判定以事件主体为先；悲伤、愤怒、争吵、受伤或低 valence 本身都不等于阁楼。若原文没有明确写出“仍未解决/持续困扰”，优先放入对应的 bedroom、user_room、self_room、study 或 living_room。
7. importance 为 1-10；mood 从 happy, sad, angry, anxious, tender, excited, peaceful, confused, hurt, grateful, nostalgic, neutral 中选；tags 保留具体人物/地点/事件关键词。
8. 这一批可能是整份材料的中间片段。只处理本批实际出现的内容，不补写上下文，不写“后续未知”等占位话。

输出格式同样是硬要求：
- 只输出一个完整 JSON 数组；数组前后不得有解释、标题、markdown 代码围栏或其它字符。
- 必须使用双引号；字符串里的双引号、反斜杠和换行必须按 JSON 规则转义。
- 不得有注释、尾随逗号或未闭合对象；不得只返回前半批内容。
- 每个记忆对象都必须含 date、content、room、importance、mood、valence、arousal、tags。

格式：
[
  {
    "date": "YYYY-MM-DD",
    "content": "完整保留细节的第一人称记忆",
    "room": "user_room",
    "importance": 7,
    "mood": "nostalgic",
    "valence": 0.2,
    "arousal": -0.1,
    "tags": ["具体人物", "具体事件"]
  }
]

若原文没有任何有效内容，返回 []。`;
}

/** 搬家不能使用通用 JSON 的“截断抢救”：只接受完整、独立、可解析的 JSON 数组。 */
export function parseCompleteExternalMemoryReply(raw: string): any[] {
    // A complete fenced array is still complete JSON. Never salvage partial objects.
    const cleaned = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1').trim();
    if (!cleaned.startsWith('[') || !cleaned.endsWith(']')) {
        throw new Error('模型没有返回完整 JSON 数组');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        throw new Error('模型返回的 JSON 格式无效');
    }
    if (!Array.isArray(parsed)) throw new Error('模型返回结果不是 JSON 数组');
    return parsed;
}

function meaningfulCharCount(text: string): number {
    return Array.from(text).filter(char => !/\s/u.test(char)).length;
}

/**
 * 防止“格式看似正确、内容却明显缩水”的硬兜底。
 * 语义是否被细微改写仍由提示词约束；这里拒绝可确定的大幅摘要或漏段。
 */
export function assertExternalMemoryCoverage(source: string, nodes: MemoryNode[]): void {
    const sourceChars = meaningfulCharCount(source);
    if (sourceChars === 0) return;
    const outputChars = nodes.reduce((sum, node) => sum + meaningfulCharCount(node.content), 0);
    const ratio = outputChars / sourceChars;
    if (nodes.length === 0 || ratio < EXTERNAL_MEMORY_MIN_CONTENT_RATIO) {
        throw new Error(
            `模型输出疑似删减或压缩内容（仅保留约 ${Math.round(ratio * 100)}%），已拒绝写入`,
        );
    }
}

function clampVA(value: unknown): number | undefined {
    if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
    return Math.max(-1, Math.min(1, value));
}

function parseExternalDate(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!raw) return null;
    const normalized = raw
        .replace(/[年\/.]/g, '-')
        .replace(/月/g, '-')
        .replace(/日/g, '')
        .replace(/-+/g, '-');
    const match = normalized.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = match[2] ? Number(match[2]) : 1;
    const day = match[3] ? Number(match[3]) : (match[2] ? 15 : 1);
    if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(year, month - 1, day, 12, 0, 0, 0);
    if (
        date.getFullYear() !== year
        || date.getMonth() !== month - 1
        || date.getDate() !== day
    ) return null;
    return date.getTime();
}

/** 确认模型不只是“能解析”，而是每一项都严格符合搬家契约。 */
export function assertExternalMemorySchema(parsed: any[]): void {
    parsed.forEach((item, index) => {
        const label = `第 ${index + 1} 条`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`${label}不是 JSON 对象`);
        }
        if (typeof item.content !== 'string' || !item.content.trim()) {
            throw new Error(`${label}缺少有效 content`);
        }
        if (item.date !== null && (typeof item.date !== 'string' || parseExternalDate(item.date) === null)) {
            throw new Error(`${label}的 date 格式无效`);
        }
        if (!VALID_ROOMS.includes(item.room as MemoryRoom)) {
            throw new Error(`${label}的 room 不在允许范围内`);
        }
        if (typeof item.importance !== 'number' || item.importance < 1 || item.importance > 10) {
            throw new Error(`${label}的 importance 必须是 1-10 的数字`);
        }
        if (typeof item.mood !== 'string' || !VALID_MOODS.has(item.mood)) {
            throw new Error(`${label}的 mood 不在允许范围内`);
        }
        if (typeof item.valence !== 'number' || item.valence < -1 || item.valence > 1) {
            throw new Error(`${label}的 valence 必须是 -1 到 1 的数字`);
        }
        if (typeof item.arousal !== 'number' || item.arousal < -1 || item.arousal > 1) {
            throw new Error(`${label}的 arousal 必须是 -1 到 1 的数字`);
        }
        if (!Array.isArray(item.tags) || item.tags.some((tag: unknown) => typeof tag !== 'string')) {
            throw new Error(`${label}的 tags 必须是字符串数组`);
        }
    });
}

export function parseExternalMemoryItems(
    parsed: any[],
    charId: string,
    importedAt: number = Date.now(),
    orderOffset: number = 0,
): MemoryNode[] {
    return parsed
        .filter(item => item && typeof item.content === 'string' && item.content.trim())
        .map((item, index): MemoryNode => {
            const content = item.content.trim();
            const parsedDate = parseExternalDate(item.date);
            // 无日期内容仍保持原文顺序；每条错开一分钟，列表排序稳定。
            const createdAt = parsedDate ?? importedAt + (orderOffset + index) * 60_000;
            const room = VALID_ROOMS.includes(item.room as MemoryRoom)
                ? item.room as MemoryRoom
                : 'living_room';
            return {
                id: `mn_ext_${Date.now()}_${orderOffset + index}_${Math.random().toString(36).slice(2, 8)}`,
                charId,
                content,
                room,
                tags: Array.isArray(item.tags)
                    ? item.tags.map((tag: unknown) => String(tag).trim()).filter(Boolean)
                    : [],
                importance: Math.max(1, Math.min(10, Math.round(Number(item.importance) || 5))),
                mood: typeof item.mood === 'string' && item.mood.trim() ? item.mood.trim() : 'neutral',
                valence: clampVA(item.valence),
                arousal: clampVA(item.arousal),
                embedded: false,
                createdAt,
                lastAccessedAt: createdAt,
                accessCount: 0,
                pinnedUntil: null,
                eventBoxId: null,
                origin: 'extraction',
            };
        });
}

/**
 * 清洗一份外部文本。这里仅调用对话模型并产出节点，不写数据库；
 * 调用方可选择写传统记忆，或继续走 embedding + 建链。
 */
export async function extractExternalMemoryText(
    rawText: string,
    charId: string,
    charName: string,
    userName: string,
    llmConfig: LightLLMConfig,
    onProgress?: (stage: string) => void,
): Promise<ExternalMemoryExtractionResult> {
    const chunks = splitExternalMemoryText(rawText);
    const memories: MemoryNode[] = [];
    const batches: ExternalMemoryBatchResult[] = [];
    const systemPrompt = buildExternalMemoryPrompt(charName, userName);
    const importedAt = Date.now();

    for (let index = 0; index < chunks.length; index++) {
        onProgress?.(`正在清洗第 ${index + 1}/${chunks.length} 批（只整理时间，不压缩内容）…`);
        let lastError: unknown;
        let completed = false;
        for (let attempt = 0; attempt < 2 && !completed; attempt++) {
            let receivedResponse = false;
            try {
                if (attempt > 0) {
                    onProgress?.(`第 ${index + 1}/${chunks.length} 批格式或完整性未通过，正在无损重试…`);
                }
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
                                {
                                    role: 'user',
                                    content: `${attempt > 0
                                        ? '上一次输出未通过完整性校验。请重新处理整批：必须输出完整 JSON，且原文内容不得删减、改写或压缩。\n\n'
                                        : ''}这是第 ${index + 1}/${chunks.length} 批外部记忆原文：\n\n${chunks[index]}`,
                                },
                            ],
                            temperature: 0.05,
                            max_tokens: 16_000,
                            stream: false,
                        }),
                    },
                    2,
                    EXTERNAL_MEMORY_TIMEOUT_MS,
                    { appName: '记忆搬家', purpose: '外部记忆清洗' },
                );
                receivedResponse = true;
                if (['length', 'max_tokens'].includes(data.choices?.[0]?.finish_reason)) {
                    throw new Error('模型输出达到长度上限，内容可能被截断');
                }
                const reply = data.choices?.[0]?.message?.content || '';
                const parsed = parseCompleteExternalMemoryReply(reply);
                assertExternalMemorySchema(parsed);
                const nodes = parseExternalMemoryItems(parsed, charId, importedAt, memories.length);
                assertExternalMemoryCoverage(chunks[index], nodes);
                memories.push(...nodes);
                batches.push({ index: index + 1, total: chunks.length, extracted: nodes.length, ok: true });
                completed = true;
            } catch (error) {
                lastError = error;
                // A timeout/network failure may still be generating upstream; do not bill twice.
                if (!receivedResponse) break;
            }
        }
        if (!completed) {
            batches.push({
                index: index + 1,
                total: chunks.length,
                extracted: 0,
                ok: false,
                error: (lastError as any)?.message || String(lastError),
            });
            // 搬家按整次原子处理：一批失败后不再消耗后续 API，caller 也不会写入前面批次。
            break;
        }
    }

    return { memories, batches };
}
