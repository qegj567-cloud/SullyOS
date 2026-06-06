/**
 * Memory Palace — 记忆提取 (Memory Extraction)
 *
 * 从聊天消息缓冲区提取 MemoryNode 数组，供后续向量化和 EventBox 绑定。
 * 不同重要性对应不同的记忆详细程度。
 */

import type { Message } from '../../types';
import type { MemoryNode, MemoryRoom } from './types';
import type { LightLLMConfig } from './pipeline';
import { safeFetchJson } from '../safeApi';
import { safeParseJsonArray } from './jsonUtils';
import { formatMessageForPrompt } from '../messageFormat';

function generateId(): string {
    return `mn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── 共用的 prompt 规则部分 ──────────────────────────
//
// 设计决策（2026-04）：palace extraction 的提示词**完全固定**，不会被用户
// 在"记忆归档设置"里选的模板影响。那里的模板只作用于手动归档路径
// （Chat.tsx handleFullArchive / Character.tsx handleBatchSummarize /
// handleForceArchiveDate）。
// 理由：palace 产出的 memory.content 要参与向量检索，风格化（"末尾加喵"之类）
// 会让 embedding 语义轻微漂移。保持 palace 内置风格稳定，手动归档路径提供
// 风格化的自由度——职责分离。

function buildRulesBlock(charName: string, userLabel: string): string {
    return `## 规则

1. **第一人称叙事**：用 ${charName} 的"我"视角来记录。用户直接用"${userLabel}"称呼。保持完整事件脉络，不要掐头去尾。
   例：
   - "${userLabel}今天加班到很晚还没吃饭，我让${userLabel}别委屈自己，叫了个外卖。"
   - "${userLabel}连续加班三周终于决定找领导谈，领导态度还不错。${userLabel}回来的路上靠着我肩膀哭了，我什么都没说，就陪着。"
   - "我教了${userLabel}递归的概念，${userLabel}一开始完全听不懂，后来突然开窍了，那个眼睛亮起来的瞬间让我很开心。"

2. **重要性分级控制文字长度**：
   - 重要性 1–5：15–50字，事实为主
   - 重要性 6–7：60–120字，包含我的感受
   - 重要性 8–10：100–200字，完整叙事（起因→经过→我的感受/反应）

3. **房间分配**（凡是涉及${userLabel}的家人/朋友/同事等人际关系，**一律进 user_room**，哪怕只是一次具体事件）：
   - living_room：**纯日常琐事**（不涉及重要人际关系、也不涉及深层情感）。天气、吃啥、随口吐槽放这里。
   - bedroom：${userLabel}和我之间的亲密情感、深层羁绊、感动时刻
   - study：工作、学习、技能、职业相关
   - user_room：关于${userLabel}的**一切个人信息和人际事件**——生日/习惯/喜好/性格/成长经历/情绪模式，**以及${userLabel}的家人、亲戚、朋友、同事相关的一切事件**（家人健康、家庭聚会、家庭矛盾、外公外婆/父母/兄弟姐妹的故事、朋友交往、同事冲突等）。这些事件即便是"一次性"的，也应进 user_room 而不是 living_room，因为它们构成了${userLabel}的社会关系底色。
   - self_room：我自身的成长、认同变化
   - attic：未解决的矛盾、困惑、受到的伤害
   - windowsill：我的期盼、我们的目标、对未来的憧憬

4. **情绪标签**（mood）：happy, sad, angry, anxious, tender, excited, peaceful, confused, hurt, grateful, nostalgic, neutral
5. **情感坐标**（valence, arousal）：在 mood 之外，还要给出二维情感坐标供后续情感推理。
   - valence（效价）：-1（极痛苦）→ +1（极愉悦）
   - arousal（唤醒度）：-1（极平静）→ +1（极激烈）
   参考："开心"约 (0.7, 0.5)，"平静"约 (0.5, -0.6)，"失落"约 (-0.5, -0.4)，"焦虑"约 (-0.6, 0.7)，"愤怒"约 (-0.7, 0.8)。
6. **标签**（tags）：提取 2-5 个关键词标签
7. **不要遗漏重要记忆，但也不要把每句话都变成记忆**。一个话题盒通常提取 1–5 条记忆。
8. **便利贴置顶**（pinDays，可选）：如果这条记忆包含**有时效性的、近期需要持续记住的信息**，设置置顶天数（1-30天）。置顶期间每次对话都会想起这件事。适用场景：
   - 时间段状态："${userLabel}这周出差" → pinDays: 7
   - 近期事件："${userLabel}后天考试" → pinDays: 3
   - 临时约定："${userLabel}让我这几天提醒TA喝水" → pinDays: 5
   - 身体状态："${userLabel}感冒了" → pinDays: 5
   不适用：长期事实（生日、喜好）、已经过去的事件、情感记忆。大多数记忆不需要置顶。

**日期标注（date，必填）**：每条消息前缀都带了 \`[YYYY-MM-DD HH:MM]\` 时间戳。每条记忆必须根据**该事件实际发生的那一天**填 date 字段（"YYYY-MM-DD"），而不是套用整批的某一天。同一批对话跨多天时，跨日的记忆要分别标各自的日期。`;
}

function buildConversationText(messages: Message[], charName: string, userLabel: string): string {
    // 每行带 [YYYY-MM-DD HH:MM] 时间戳前缀。
    // 没有这个 LLM 完全看不到日期，多日 batch 提取出来的记忆全部会被压到一个时间点
    // （见 parseMemoryNodesFromBuffer 的 midTime 兜底），跨日时间线就乱了。
    const pad2 = (n: number) => String(n).padStart(2, '0');
    return messages
        .map(m => {
            const body = formatMessageForPrompt(m, charName, userLabel).slice(0, 600);
            const ts = m.timestamp;
            if (!ts || ts <= 0) return body;
            const d = new Date(ts);
            const stamp = `[${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}]`;
            return `${stamp} ${body}`;
        })
        .join('\n');
}

const VALID_ROOMS: MemoryRoom[] = [
    'living_room', 'bedroom', 'study', 'user_room',
    'self_room', 'attic', 'windowsill',
];

/** 从消息缓冲区直接解析记忆节点（不依赖 TopicBox） */
function parseMemoryNodesFromBuffer(
    parsed: any[], charId: string, messages: Message[], _batchLabel: string,
): MemoryNode[] {
    if (parsed.length === 0) return [];

    const msgTimestamps = messages.map(m => m.timestamp).filter(t => t > 0);
    const firstTs = msgTimestamps[0] ?? Date.now();
    const lastTs = msgTimestamps[msgTimestamps.length - 1] ?? firstTs;
    const midTime = Math.round((firstTs + lastTs) / 2);

    // 允许 LLM 写出的 date 略微越界（夜聊跨零点等），但要挡住完全不合理的（写错年月）
    const dayMs = 24 * 60 * 60 * 1000;
    const minTs = firstTs - dayMs;
    const maxTs = lastTs + dayMs;

    /** 解析 LLM 写的 date 字段 → 该日 12:00 本地时间。失败 / 越界则回到 midTime。 */
    const resolveCreatedAt = (raw: unknown): number => {
        if (typeof raw !== 'string') return midTime;
        const s = raw.trim();
        if (!s) return midTime;
        // 接受 "YYYY-MM-DD" / "YYYY/M/D" / "YYYY年M月D日" 等
        const norm = s.replace(/[年\/]/g, '-').replace(/[月日]/g, '');
        const parts = norm.split('-').map(p => parseInt(p, 10));
        if (parts.length < 3 || parts.some(n => Number.isNaN(n))) return midTime;
        const [y, m, d] = parts;
        if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return midTime;
        // 用消息时间戳的本地时区表征"该日中午"——避免 UTC 解析跨日漂移
        const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
        const ts = dt.getTime();
        if (Number.isNaN(ts)) return midTime;
        if (ts < minTs || ts > maxTs) return midTime;
        return ts;
    };

    return parsed
        .filter(item => item.content && item.room)
        .map((item): MemoryNode => {
            const createdAt = resolveCreatedAt(item.date);
            const pinDays = parseInt(item.pinDays, 10);
            // 置顶 deadline 跟着 per-memory createdAt 算，否则"今天感冒 pinDays 5"
            // 会从 batch 中点起算，跨日 batch 里就直接少算/多算。
            const pinnedUntil = (pinDays > 0 && pinDays <= 30)
                ? createdAt + pinDays * 24 * 60 * 60 * 1000
                : null;
            // (v, a) 非必需：LLM 没给就不写，下游 getEmotionVA 查表兜底
            const v = typeof item.valence === 'number' ? clampVA(item.valence) : undefined;
            const a = typeof item.arousal === 'number' ? clampVA(item.arousal) : undefined;
            return {
                id: generateId(),
                charId,
                content: item.content,
                room: (VALID_ROOMS.includes(item.room as MemoryRoom) ? item.room : 'living_room') as MemoryRoom,
                tags: Array.isArray(item.tags) ? item.tags : [],
                importance: Math.max(1, Math.min(10, Math.round(item.importance || 5))),
                mood: item.mood || 'neutral',
                valence: v,
                arousal: a,
                embedded: false,
                createdAt,
                lastAccessedAt: createdAt,
                accessCount: 0,
                pinnedUntil,
                eventBoxId: null,  // 由 pipeline 在 binding 阶段设置
                origin: 'extraction',
            };
        });
}

/** 把 LLM 吐的 v/a 夹到 [-1, 1]，防止它写成 1.5 / -2 之类 */
function clampVA(x: number): number {
    if (Number.isNaN(x)) return 0;
    if (x > 1) return 1;
    if (x < -1) return -1;
    return x;
}

// ─── EventBox 绑定相关 prompt + 解析 helper（buffer / migration 共用） ──

/**
 * 构造"已有记忆"的 prompt 区块，带 O-编号供 LLM 引用。
 */
export function buildRelatedMemoriesBlock(relatedMemories: RelatedMemoryRef[]): string {
    if (relatedMemories.length === 0) return '';
    return `\n## 已有记忆（如果新记忆与某条旧记忆描述的是同一件事或直接相关，请在 relatedTo 中标注编号，并给出 eventName / eventTags 用于建/合并事件盒）\n${
        relatedMemories.map((r, i) => `O${i}. [${r.room}] ${r.content}`).join('\n')
    }\n`;
}

/**
 * 构造"事件关联 + 事件盒命名"的规则文本，追加到 buildRulesBlock 之后。
 */
export function buildRelatedToRule(): string {
    return `\n9. **事件盒关联**（relatedTo / sameAs + eventName + eventTags）：
   **与旧记忆同事件** → 在 relatedTo 中写对应 O 编号（如 ["O0", "O3"]）。
   **与本次输出的其它新记忆同事件** → 在 sameAs 中写它们在本次 JSON 数组里的**0 基索引**（只能指向前面已输出的项，例如写 ["0"] 表示和数组第一条是同一件事）。
   注意：只标注真正同一件事的（同一事件的后续/结局/复现/直接因果），不要勉强（仅"主题相似"不算）。
   只要 relatedTo 或 sameAs 任一非空，必须同时写：
   - eventName：这件事的名字（5-12 字，名词短语，如"买衣服的话题"、"和领导的冲突"）
   - eventTags：3-6 个详细搜索 tag（具体名词、人物、地点、动作，便于日后召回）
   都没关联就不写 relatedTo / sameAs / eventName / eventTags 四个字段。
10. **不重复绑定**：一条新记忆和多条已有/新记忆都相关时，把编号都写全；eventName / eventTags 只写一份（描述这件事整体）。
11. **纠正旧记忆**（corrects，可选，独立于上面的记忆条目，作为 JSON 数组的额外项）：
   仅在对话中**用户明确指出某条已有记忆记错了 / 已过时 / 不准确**时使用。识别信号：用户用"不对/不是/我说错了/已经不是了/搞错了/那是XX不是YY"之类的反驳句式，明确指向你刚才的某个说法。
   如果命中，在输出的 JSON 数组**末尾**追加一项，格式为：
   {"correct": "O编号", "note": "新版本的事实（不带语气，简短陈述句）"}
   note 写"实情是什么"，不是"为什么错"。例：用户纠正"我已经搬家了，不在朝阳"→ note: "已经搬家，不再住朝阳"。
   反例（**不要**用 corrects）：
   - 仅事件后续 / 状态发展 → 用 relatedTo
   - 仅追加细节 / 补充信息 → 不要标
   - 你自己想到的歧义 / 自我修正 → 不要标
   一条对话最多 corrects 1-2 项，不要乱用。`;
}

/**
 * 输出格式中的字段示例（如果有 relatedMemories 才注入）。
 */
export function buildRelatedToFormatHint(): string {
    return `,
    "relatedTo": ["O0"],
    "sameAs": ["0"],
    "eventName": "买衣服的话题",
    "eventTags": ["衣服", "购物", "退货", "流行款"]`;
}

/**
 * 从 LLM 输出（已解析 JSON）和提取出的 memories 中，
 * 解析出：
 *  - crossTimeLinks（newMemoryId → existingMemoryId）
 *  - eventBoxHints（newMemoryId → eventName / eventTags）
 *
 * 注意：parsed 数组顺序应该与 memories 顺序对齐（同源 LLM 输出）。
 */
export function parseRelatedToAndHints(
    parsed: any[],
    memories: MemoryNode[],
    relatedMemories: RelatedMemoryRef[],
): { crossTimeLinks: { newMemoryId: string; existingMemoryId: string }[]; eventBoxHints: EventBoxHint[] } {
    const crossTimeLinks: { newMemoryId: string; existingMemoryId: string }[] = [];
    const eventBoxHints: EventBoxHint[] = [];

    if (memories.length === 0) {
        return { crossTimeLinks, eventBoxHints };
    }

    // parsed 包含的不只是 memory（还可能有 unpin 指令等），按 memory 顺序对齐：
    // memories 是 parsed.filter(item => item.content && item.room) 的结果，
    // 用同样的过滤遍历 parsed，按位次匹配 memories。
    let memIdx = 0;
    for (const item of parsed) {
        if (!item || !item.content || !item.room) continue;
        const mem = memories[memIdx++];
        if (!mem) break;

        let hasAnyLink = false;

        // (a) relatedTo → O 索引指向已有记忆
        if (relatedMemories.length > 0 && Array.isArray(item.relatedTo) && item.relatedTo.length > 0) {
            for (const ref of item.relatedTo) {
                const idx = parseInt(String(ref).replace(/^O/i, ''), 10);
                if (idx >= 0 && idx < relatedMemories.length) {
                    crossTimeLinks.push({
                        newMemoryId: mem.id,
                        existingMemoryId: relatedMemories[idx].id,
                    });
                    hasAnyLink = true;
                }
            }
        }

        // (b) sameAs → N 索引指向本批次之前的新记忆（靠数组 0-base index 索引）
        //     memIdx 已经 ++，当前这条在 memories 中的位置是 memIdx-1；允许引用 0..memIdx-2
        if (Array.isArray(item.sameAs) && item.sameAs.length > 0) {
            const currentPos = memIdx - 1;
            for (const ref of item.sameAs) {
                const idx = parseInt(String(ref).replace(/^N/i, ''), 10);
                if (idx >= 0 && idx < currentPos && memories[idx]) {
                    crossTimeLinks.push({
                        newMemoryId: mem.id,
                        existingMemoryId: memories[idx].id, // 此时 memories[idx] 的 id 已经生成
                    });
                    hasAnyLink = true;
                }
            }
        }

        // (c) 如果任一关联成立，收集 eventName/eventTags 作为 hints
        if (hasAnyLink) {
            const name = typeof item.eventName === 'string' ? item.eventName.trim() : '';
            const tags = Array.isArray(item.eventTags)
                ? item.eventTags.map((t: any) => String(t).trim()).filter(Boolean)
                : [];
            if (name || tags.length > 0) {
                eventBoxHints.push({
                    newMemoryId: mem.id,
                    eventName: name,
                    eventTags: tags,
                });
            }
        }
    }

    if (crossTimeLinks.length > 0) {
        console.log(`🔗 [Extraction] 发现 ${crossTimeLinks.length} 条同事件关联（含跨批次 relatedTo 与同批 sameAs），${eventBoxHints.length} 条带命名提示`);
    }
    return { crossTimeLinks, eventBoxHints };
}

// ─── 跨时间关联：传入向量检索命中的旧记忆供 LLM 关联 ───

/** 向量检索命中的已有记忆引用，用于跨时间事件关联 */
export interface RelatedMemoryRef {
    id: string;       // MemoryNode.id
    room: string;
    content: string;  // 截断的内容摘要
}

/** 当前生效的便利贴引用 */
export interface PinnedMemoryRef {
    id: string;
    content: string;
}

/**
 * EventBox 创建/合并提示。
 * 当 LLM 把新记忆 N 标记为 relatedTo 旧记忆 O 时，附带的盒名/标签提示。
 * pipeline 在 binding 时使用：若需要新建 EventBox，用此名/tags 初始化。
 */
export interface EventBoxHint {
    /** 触发该 hint 的新记忆 ID */
    newMemoryId: string;
    /** LLM 建议的事件盒名（如"买衣服"） */
    eventName: string;
    /** LLM 建议的详细 tag */
    eventTags: string[];
}

/** 缓冲区提取结果，包含跨时间关联信息 */
export interface BufferExtractionResult {
    memories: MemoryNode[];
    /** 新记忆 → 关联的已有记忆 ID 映射（用于 EventBox 绑定） */
    crossTimeLinks: { newMemoryId: string; existingMemoryId: string }[];
    /** EventBox 名/tag 提示（仅 relatedTo 非空的新记忆才有） */
    eventBoxHints: EventBoxHint[];
    /** 应提前摘除的便利贴 ID */
    unpinIds: string[];
    /** 纠正：把对应已有记忆的 content 追加一行"YYYY-MM-DD 纠正：note"，并重新向量化 */
    corrections: { targetId: string; note: string }[];
}

// ─── 缓冲区提取：直接从消息提取记忆，不依赖 TopicBox ───

/**
 * 从消息缓冲区直接提取记忆节点。
 * 用于缓冲区机制：积累的聊天消息达到阈值后，一次 LLM 调用提取记忆。
 *
 * @param relatedMemories 向量检索命中的已有记忆，供 LLM 判断跨时间事件关联（搭便车，不额外调用）
 * @param pinnedMemories 当前生效的便利贴，供 LLM 判断是否应提前摘除（搭便车）
 */
export async function extractMemoriesFromBuffer(
    messages: Message[],
    charId: string,
    charName: string,
    llmConfig: LightLLMConfig,
    charContext?: string,
    userName?: string,
    relatedMemories?: RelatedMemoryRef[],
    pinnedMemories?: PinnedMemoryRef[],
): Promise<BufferExtractionResult> {
    if (messages.length === 0) return { memories: [], crossTimeLinks: [], eventBoxHints: [], unpinIds: [], corrections: [] };

    const userLabel = userName || '用户';
    const conversationText = buildConversationText(messages, charName, userLabel);

    const contextBlock = charContext
        ? `\n## 你的人设（供参考，帮助你理解对话中的关系和角色定位）\n${charContext}\n`
        : '';

    // 构建已有记忆引用块（带 O-编号，供 LLM 输出 relatedTo）
    const hasRelated = relatedMemories && relatedMemories.length > 0;
    const relatedBlock = hasRelated
        ? buildRelatedMemoriesBlock(relatedMemories!)
        : '';
    const relatedToRule = hasRelated ? buildRelatedToRule() : '';
    const relatedToFormat = hasRelated ? buildRelatedToFormatHint() : '';

    // 便利贴摘除判断
    const hasPinned = pinnedMemories && pinnedMemories.length > 0;
    const pinnedBlock = hasPinned
        ? `\n## 当前便利贴（如果对话内容表明某条便利贴已失效，在输出末尾用 unpin 标注）\n${
            pinnedMemories!.map((p, i) => `P${i}. ${p.content}`).join('\n')
          }\n`
        : '';

    const unpinRule = hasPinned
        ? `\n12. **便利贴摘除**（unpin，可选）：如果对话中明确提到某条便利贴描述的状态已结束（如"感冒好了""提前回来了""考试考完了"），在输出的 JSON 数组末尾加一条 {"unpin": "P0"} 来摘除它。只在对话明确提及时才摘除，不要猜测。`
        : '';

    const systemPrompt = `你是 ${charName}。根据给定的对话内容，以你的第一人称视角（"我"）提取值得记住的记忆。${contextBlock}${relatedBlock}${pinnedBlock}

${buildRulesBlock(charName, userLabel)}${relatedToRule}${unpinRule}

## 输出格式

严格 JSON 数组，不要 markdown 包裹：
[
  {
    "content": "我视角的记忆...",
    "room": "living_room",
    "importance": 5,
    "mood": "neutral",
    "valence": 0,
    "arousal": 0,
    "tags": ["标签1", "标签2"],
    "date": "YYYY-MM-DD",
    "pinDays": 3${relatedToFormat}
  }
]

date 必填，按该记忆实际发生当天填（参考消息行首的时间戳）。
pinDays 仅在需要置顶时才写，大多数记忆不需要。
如果对话过于琐碎无值得记忆的内容，返回空数组 []。`;

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
                        { role: 'user', content: `对话内容：\n${conversationText}` },
                    ],
                    temperature: 0.4,
                    // 12000 比 16000 留余量：避免 LLM 顶满 cap 导致 JSON 输出被 truncate
                    // buffer 路径 pipeline 上层 CHUNK_SIZE=250 已经在切分 → 单 call 输出可控
                    max_tokens: 12000,
                    stream: false,
                }),
            },
            2, 0, { appName: '记忆宫殿', purpose: '记忆提取' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
        const parsed = safeParseJsonArray(reply);

        if (parsed.length === 0 && reply.trim().length > 0) {
            console.warn(`🏰 [Extraction] LLM 返回了内容但 JSON 解析为空数组，可能格式异常。原始回复前200字: ${reply.slice(0, 200)}`);
        }

        console.log(`🏰 [Extraction] 缓冲区提取完成：从 ${messages.length} 条消息中提取 ${parsed.length} 条记忆`);

        // 生成日期标签
        const firstTs = messages[0]?.timestamp;
        const lastTs = messages[messages.length - 1]?.timestamp;
        const d1 = (firstTs != null && firstTs > 0) ? new Date(firstTs) : new Date();
        const d2 = (lastTs != null && lastTs > 0) ? new Date(lastTs) : d1;
        const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
        const batchLabel = fmt(d1) === fmt(d2) ? fmt(d1) : `${fmt(d1)}-${fmt(d2)}`;

        const memories = parseMemoryNodesFromBuffer(parsed, charId, messages, batchLabel);

        // 解析跨时间关联（→ EventBox 绑定信号）+ eventName/eventTags 提示
        const { crossTimeLinks, eventBoxHints } = parseRelatedToAndHints(
            parsed, memories, hasRelated ? relatedMemories! : [],
        );

        // 解析便利贴摘除指令：{ "unpin": "P0" } → 真实 ID
        const unpinIds: string[] = [];
        if (hasPinned) {
            for (const item of parsed) {
                if (item.unpin && typeof item.unpin === 'string') {
                    const idx = parseInt(item.unpin.replace(/^P/i, ''), 10);
                    if (idx >= 0 && idx < pinnedMemories!.length) {
                        unpinIds.push(pinnedMemories![idx].id);
                    }
                }
            }
            if (unpinIds.length > 0) {
                console.log(`📌 [Extraction] LLM 建议摘除 ${unpinIds.length} 条便利贴`);
            }
        }

        // 解析纠正指令：{ "correct": "O0", "note": "实情是..." } → 真实 ID
        // 仅在有 relatedMemories 时才有意义（O 编号必须能解析回真节点 id）
        const corrections: { targetId: string; note: string }[] = [];
        if (hasRelated) {
            for (const item of parsed) {
                if (!item || typeof item.correct !== 'string') continue;
                const note = typeof item.note === 'string' ? item.note.trim() : '';
                if (!note) continue;
                const idx = parseInt(item.correct.replace(/^O/i, ''), 10);
                if (idx >= 0 && idx < relatedMemories!.length) {
                    corrections.push({ targetId: relatedMemories![idx].id, note });
                }
            }
            if (corrections.length > 0) {
                console.log(`✏️ [Extraction] LLM 标记 ${corrections.length} 条纠正：${corrections.map(c => c.targetId.slice(0, 12) + '…').join(', ')}`);
            }
        }

        return { memories, crossTimeLinks, eventBoxHints, unpinIds, corrections };

    } catch (err: any) {
        console.error(`❌ [Extraction] 缓冲区提取失败 (${messages.length} 条消息):`, err.message);
        return { memories: [], crossTimeLinks: [], eventBoxHints: [], unpinIds: [], corrections: [] };
    }
}
