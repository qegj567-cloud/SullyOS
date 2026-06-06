/**
 * Group Memory Palace — 群聊记忆提取（第三人称版本，独立于私聊）
 *
 * 与 extraction.ts 的区别：
 * - 视角是"群聊观察者"而非角色本人 → 第三人称叙事，主语是具体的角色名
 * - 内容前缀统一为 "在【XXX群】里，..."，便于该记忆后续平等地分发给每个成员
 * - 不参与便利贴系统（pinDays），不参与 relatedTo / EventBox 跨时间链接（v1 简化）
 *
 * 私聊路径完全不感知本文件存在。
 */
import type { Message } from '../../types';
import type { MemoryRoom } from './types';
import type { LightLLMConfig } from './pipeline';
import { safeFetchJson } from '../safeApi';
import { safeParseJsonArray } from './jsonUtils';

/** 群记忆草稿——尚未指派 charId（一份记忆稍后会复制给每个成员持久化） */
export interface GroupMemoryDraft {
    content: string;
    room: MemoryRoom;
    tags: string[];
    importance: number;
    mood: string;
    valence?: number;
    arousal?: number;
    /** 这批草稿对应的群消息时间窗中点（用于 createdAt） */
    createdAt: number;
}

const VALID_ROOMS: MemoryRoom[] = [
    'living_room', 'bedroom', 'study', 'user_room',
    'self_room', 'attic', 'windowsill',
];

function clampVA(x: number): number {
    if (Number.isNaN(x)) return 0;
    if (x > 1) return 1;
    if (x < -1) return -1;
    return x;
}

function buildGroupRulesBlock(groupName: string, memberNames: string[], userLabel: string): string {
    const memberList = memberNames.join('、');
    return `## 规则

1. **第三人称叙事**：你是【${groupName}】的群聊观察者，记录"群里发生了什么"。
   - 用户称呼为"${userLabel}"，群成员名字直接用：${memberList}
   - **绝对不要用"我"** —— 这条记忆会平等地发给群里每个成员，所以不能站在某一个人的视角
   - 内容前缀统一为："在【${groupName}】里，..."
   例：
   - "在【${groupName}】里，${memberNames[0] || 'A'} 提起了最近在追的剧，${memberNames[1] || 'B'} 跟着安利，${userLabel} 表示已经被种草了。"
   - "在【${groupName}】里，${memberNames[0] || 'A'} 抱怨了周末加班的事，大家分别支了一招，${memberNames[1] || 'B'} 让 ta 直接拒绝，${memberNames[2] || 'C'} 让 ta 先观望。"

2. **重要性分级控制文字长度**：
   - 重要性 1–5：20–60字，事实为主
   - 重要性 6–7：60–140字，包含群里的氛围描写
   - 重要性 8–10：120–220字，完整叙事（起因→经过→群里的反应）

3. **房间分配**（注意视角是群整体）：
   - living_room：群里的日常闲聊、玩梗、复读、无关紧要的活跃气氛
   - bedroom：群里的暖心瞬间、深度互动、彼此关心或起哄逗 ${userLabel} 的时刻
   - study：群里讨论工作 / 学习 / 兴趣 / 技能 / 新闻话题
   - user_room：群里发生的、关于 ${userLabel} 的事——${userLabel} 在群里的状态、情绪、提到的家人朋友、被起哄等
   - self_room：群成员之间的关系演变、群整体氛围的变化、谁和谁关系变好/变差
   - attic：群里没解决的矛盾、尴尬冷场、被搁置的话题、暗流涌动的修罗场
   - windowsill：群里立下的约定、共同期盼、群体目标（线下聚会、集体计划等）

4. **情绪标签**（mood）：happy, sad, angry, anxious, tender, excited, peaceful, confused, hurt, grateful, nostalgic, neutral
5. **情感坐标**（valence, arousal）：
   - valence：-1（极痛苦）→ +1（极愉悦）
   - arousal：-1（极平静）→ +1（极激烈）
6. **标签**（tags）：提取 2-5 个关键词标签，最好包含涉及的角色名
7. **不要遗漏值得记的事，但也不要把每句话都变成记忆**。一段群聊通常提取 1–5 条记忆。
8. **不需要 pinDays / relatedTo / sameAs / eventName / eventTags** —— 群记忆 v1 不参与便利贴和事件盒系统。`;
}

function buildGroupConversationText(messages: Message[], speakerNameOf: (m: Message) => string): string {
    return messages.map(m => {
        const name = speakerNameOf(m);
        const time = new Date(m.timestamp).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        let content: string;
        if (m.type === 'image') content = '[图片]';
        else if (m.type === 'emoji') content = `[表情包]`;
        else if (m.type === 'transfer') content = `[红包: ${m.metadata?.amount ?? ''}]`;
        else content = (m.content || '').slice(0, 600);
        return `[${time}] ${name}: ${content}`;
    }).join('\n');
}

export interface GroupExtractionResult {
    drafts: GroupMemoryDraft[];
}

/**
 * 从群消息缓冲区提取记忆草稿。caller 拿到 drafts 后再为每个成员各持久化一份。
 *
 * 任何 LLM / 网络异常都吞掉，返回空 drafts 供 caller 跳过本轮——绝不抛到上层。
 */
export async function extractGroupMemoriesFromBuffer(
    messages: Message[],
    groupName: string,
    memberNames: string[],
    userLabel: string,
    speakerNameOf: (m: Message) => string,
    llmConfig: LightLLMConfig,
): Promise<GroupExtractionResult> {
    if (messages.length === 0) return { drafts: [] };

    const conversationText = buildGroupConversationText(messages, speakerNameOf);
    const memberList = memberNames.join('、');

    const systemPrompt = `你是【${groupName}】的群聊观察者，请从以下群聊记录中提取值得记住的群聊记忆。
群成员：${memberList}
用户：${userLabel}

${buildGroupRulesBlock(groupName, memberNames, userLabel)}

## 输出格式

严格 JSON 数组，不要 markdown 包裹：
[
  {
    "content": "在【${groupName}】里，...",
    "room": "living_room",
    "importance": 5,
    "mood": "neutral",
    "valence": 0,
    "arousal": 0,
    "tags": ["标签1", "标签2"]
  }
]

如果群聊过于琐碎无值得记忆的内容，返回空数组 []。`;

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
                        { role: 'user', content: `群聊记录：\n${conversationText}` },
                    ],
                    temperature: 0.4,
                    max_tokens: 12000,
                    stream: false,
                }),
            },
            2, 0, { appName: '记忆宫殿', purpose: '群记忆提取' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
        const parsed = safeParseJsonArray(reply);

        if (parsed.length === 0 && reply.trim().length > 0) {
            console.warn(`🏰 [GroupExtraction] LLM 返回了内容但 JSON 解析为空数组。原始回复前200字: ${reply.slice(0, 200)}`);
        }

        const msgTimestamps = messages.map(m => m.timestamp).filter(t => t > 0);
        const midTime = msgTimestamps.length > 0
            ? Math.round((msgTimestamps[0] + msgTimestamps[msgTimestamps.length - 1]) / 2)
            : Date.now();

        const drafts: GroupMemoryDraft[] = parsed
            .filter((item: any) => item && typeof item.content === 'string' && item.content.trim() && item.room)
            .map((item: any): GroupMemoryDraft => ({
                content: item.content,
                room: (VALID_ROOMS.includes(item.room as MemoryRoom) ? item.room : 'living_room') as MemoryRoom,
                tags: Array.isArray(item.tags) ? item.tags : [],
                importance: Math.max(1, Math.min(10, Math.round(item.importance || 5))),
                mood: typeof item.mood === 'string' ? item.mood : 'neutral',
                valence: typeof item.valence === 'number' ? clampVA(item.valence) : undefined,
                arousal: typeof item.arousal === 'number' ? clampVA(item.arousal) : undefined,
                createdAt: midTime,
            }));

        console.log(`🏰 [GroupExtraction] 从 ${messages.length} 条群消息提取 ${drafts.length} 条群记忆草稿`);
        return { drafts };
    } catch (err: any) {
        console.warn(`❌ [GroupExtraction] 群记忆提取失败 (${messages.length} 条消息): ${err.message}`);
        return { drafts: [] };
    }
}
