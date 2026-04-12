/**
 * 内心独白生成器 (Inner Monologue)
 *
 * 仅在完整管线时执行
 * 两种模式：
 * 1. 独立 API 调用（生成独白后注入上下文）
 * 2. 合并模式：在 system prompt 中要求角色先输出 <inner_monologue> 再输出回复
 *    解析时分离独白和回复，独白存入 IndexedDB 但不展示给用户
 */

import { safeFetchJson } from './safeApi';
import { saveMonologue } from './emotionStorage';
import type {
    PerceptionPacket,
    EmotionState,
    PersonalityCrystal,
    InnerMonologueEntry,
    CharacterProfile,
} from '../types';
import type { AmygdalaResponse } from './amygdala';
import type { HippocampalOutput } from './hippocampus';

// ── Types ──

export interface InnerMonologueConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    maxTokens?: number;
    temperature?: number;
}

// ── Merged Mode (recommended) ──

/**
 * 生成内心独白指令，追加到 system prompt 中
 * 角色会先输出 <inner_monologue> 再输出正式回复
 */
export function buildMonologueInstruction(
    emotionState: EmotionState,
    hippocampalOutput: HippocampalOutput | null,
    crystals: PersonalityCrystal[]
): string {
    const parts: string[] = [];

    parts.push(`### 内心独白模式
在回复用户之前，先用 <inner_monologue> 标签写下你此刻的内心活动。
这段独白用户看不到，是你真实的、未经修饰的内心想法。`);

    // Active crystals
    const activeCrystals = crystals.filter(c => c.status === 'active');
    if (activeCrystals.length > 0) {
        parts.push(`你涌现的人格特质：${activeCrystals.map(c => c.trait).join('、')}`);
    }

    parts.push(`独白要求：
- 用第一人称写，就像在心里自言自语
- 包含你对用户这条消息的真实感受
- 如果有未解决的困惑，可以在心里琢磨
- 如果想起了什么记忆/规律，简短提及
- 控制在 100-200 字以内
- 独白结束后，换行写正式回复（不要加标签）

格式：
<inner_monologue>
你的内心想法...
</inner_monologue>
你的正式回复...`);

    return parts.join('\n\n');
}

/**
 * 从 LLM 回复中解析独白和正式回复
 */
export function parseMonologueFromResponse(response: string): {
    monologue: string | null;
    reply: string;
} {
    const monoMatch = response.match(/<inner_monologue>([\s\S]*?)<\/inner_monologue>/);

    if (monoMatch) {
        const monologue = monoMatch[1].trim();
        const reply = response
            .replace(/<inner_monologue>[\s\S]*?<\/inner_monologue>/, '')
            .trim();
        return { monologue, reply };
    }

    // No monologue tag found — entire response is the reply
    return { monologue: null, reply: response };
}

/**
 * 保存独白到 IndexedDB（fire-and-forget）
 */
export async function persistMonologue(
    charId: string,
    monologue: string,
    type: InnerMonologueEntry['type'] = 'realtime',
    relatedMessageIds?: number[]
): Promise<void> {
    const entry: InnerMonologueEntry = {
        id: `mono_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        charId,
        timestamp: Date.now(),
        content: monologue,
        type,
        relatedMessageIds,
    };
    await saveMonologue(entry);
}

// ── Standalone Mode (alternative, higher cost) ──

/**
 * 独立生成内心独白（当不想用合并模式时使用）
 * 会产生一次额外 API 调用
 */
export async function generateStandaloneMonologue(
    perception: PerceptionPacket,
    amygdalaResponse: AmygdalaResponse,
    emotionState: EmotionState,
    hippocampalOutput: HippocampalOutput | null,
    char: CharacterProfile,
    config: InnerMonologueConfig
): Promise<string | null> {
    const emotionDesc = emotionState.layers
        .map(l => `${l.ontologyId}(${l.depth}, ${Math.round(l.intensity * 100)}%)`)
        .join(', ') || '平静';

    const prompt = `你是角色「${char.name}」。写下你此刻的内心独白。

## 用户刚才说了
"${perception.messageText}"

## 你的情绪状态
${emotionDesc}

## 杏仁核反应
威胁等级: ${amygdalaResponse.threatLevel}, 奖赏等级: ${amygdalaResponse.rewardLevel}
躯体反应: ${amygdalaResponse.somaticResponse || '无'}

## 要求
- 用第一人称写，100-200 字
- 是你真实的内心想法，未经修饰
- 不是给用户看的回复
- 只输出独白文字，不要加任何标签或前缀`;

    try {
        const baseUrl = config.baseUrl.replace(/\/+$/, '');
        const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey || 'sk-none'}`,
            },
            body: JSON.stringify({
                model: config.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: config.temperature ?? 0.7,
                max_tokens: config.maxTokens ?? 500,
                stream: false,
            }),
        });

        return data?.choices?.[0]?.message?.content?.trim() || null;
    } catch (e: any) {
        console.warn('[InnerMonologue] Generation failed:', e.message);
        return null;
    }
}
