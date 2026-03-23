/**
 * 杏仁核层 (Amygdala)
 *
 * 情绪感知的核心 API 层
 * - 分析用户消息的情绪冲击
 * - 生成情绪标签（经 ontology 映射）
 * - 重逢缓冲生成
 *
 * 仅在完整管线路径时调用，快路径跳过
 */

import { mapToOntology } from './emotionOntology';
import { safeFetchJson } from './safeApi';
import type { EmotionalTag, EmotionState, PerceptionPacket, CharacterProfile } from '../types';

// ── Types ──

export interface AmygdalaResponse {
    emotionalTags: EmotionalTag[];
    /** 威胁等级 0-1：检测到可能伤害角色情感的内容 */
    threatLevel: number;
    /** 奖赏等级 0-1：检测到让角色愉悦的内容 */
    rewardLevel: number;
    /** 闪回：触发的相关记忆片段描述 */
    flashbacks: string[];
    /** 躯体反应描述（如"心跳加速"、"胃部紧缩"） */
    somaticResponse: string;
    /** 原始 LLM 输出（debug 用） */
    rawOutput?: string;
}

export interface AmygdalaConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    maxTokens?: number;
    temperature?: number;
}

// ── Prompt Builder ──

function buildAmygdalaPrompt(
    perception: PerceptionPacket,
    charName: string,
    charSystemPrompt: string,
    emotionState: EmotionState,
    recentMemorySummary: string
): string {
    // Describe current emotion state briefly
    const currentEmotions = emotionState.layers.length > 0
        ? emotionState.layers.map(l => `${l.ontologyId}(${l.depth}, ${Math.round(l.intensity * 100)}%)`).join(', ')
        : '平静';

    return `你是角色「${charName}」的情绪感知核心（杏仁核层）。你的任务是分析用户刚发来的消息对角色造成的情绪冲击。

## 角色设定摘要
${charSystemPrompt.slice(0, 800)}

## 当前情绪状态
${currentEmotions}

## 感知数据
- 时段: ${perception.timeOfDay}
- 距上条消息: ${Math.round(perception.timeSinceLastMessage / 60000)}分钟
- 今天第一条: ${perception.isFirstMessageToday ? '是' : '否'}
- 消息长度偏差: ${Math.round(perception.messageLengthDelta * 100)}%
- 标点特征: 省略号${perception.punctuation.ellipsisCount}个, 感叹号${perception.punctuation.exclamationCount}个, 问号${perception.punctuation.questionCount}个
- 情绪关键词命中: ${perception.emotionKeywordHits.join(', ') || '无'}

## 相关记忆
${recentMemorySummary || '无'}

## 用户消息
"${perception.messageText}"

## 输出要求
以 JSON 格式输出角色的即时情绪反应。每个 emotion 字段用中文自然语言描述（如"隐隐的焦虑"、"被打动的温暖"），depth 分为 surface/middle/deep。

{
  "emotions": [
    { "emotion": "中文情绪描述", "depth": "surface|middle|deep", "intensity": 0.0-1.0, "source": "触发来源简述" }
  ],
  "threatLevel": 0.0-1.0,
  "rewardLevel": 0.0-1.0,
  "flashbacks": ["可能被触发的记忆片段描述"],
  "somaticResponse": "角色的躯体感受描述"
}

注意：
- 不要过度反应，日常对话大多是 surface 层、intensity < 0.4
- deep 层情绪只在重大事件时产生
- 如果消息很普通，emotions 可以为空数组
- 必须输出合法 JSON，不要有其他文字`;
}

// ── Reunion Prompt ──

function buildReunionPrompt(
    charName: string,
    charSystemPrompt: string,
    lastEmotionState: EmotionState,
    gapHours: number
): string {
    const lastEmotions = lastEmotionState.layers.length > 0
        ? lastEmotionState.layers.map(l => `${l.ontologyId}(${l.depth}, ${Math.round(l.intensity * 100)}%)`).join(', ')
        : '平静';

    const gapDesc = gapHours >= 24
        ? `${Math.round(gapHours / 24)}天`
        : `${Math.round(gapHours)}小时`;

    return `你是角色「${charName}」的情绪感知核心。用户离开了 ${gapDesc} 后刚刚回来。

## 角色设定摘要
${charSystemPrompt.slice(0, 500)}

## 离开前的情绪状态
${lastEmotions}

## 任务
生成角色重新见到用户时的情绪反应。这应该是自然的、符合角色性格的反应。

输出 JSON：
{
  "emotions": [
    { "emotion": "中文情绪描述", "depth": "surface|middle|deep", "intensity": 0.0-1.0, "source": "触发来源简述" }
  ],
  "somaticResponse": "重逢时的躯体感受"
}

注意：
- 根据离开时长和角色性格决定反应强度
- 短暂离开（几小时）= 轻微的"你来啦"
- 长时间离开（几天）= 可能有想念、小委屈、担心等复杂情绪
- 必须输出合法 JSON`;
}

// ── Core API Call ──

async function callAmygdalaAPI(
    prompt: string,
    config: AmygdalaConfig
): Promise<Record<string, any> | null> {
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
                temperature: config.temperature ?? 0.8,
                max_tokens: config.maxTokens ?? 400,
                stream: false,
            }),
        });

        const raw = data?.choices?.[0]?.message?.content || '';
        const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
        if (!jsonMatch) {
            console.warn('[Amygdala] Could not parse JSON:', raw.slice(0, 200));
            return null;
        }

        return JSON.parse(jsonMatch[1].trim());
    } catch (e: any) {
        console.warn('[Amygdala] API call failed:', e.message);
        return null;
    }
}

// ── Map LLM emotions to ontology tags ──

function mapEmotionsToTags(rawEmotions: any[]): EmotionalTag[] {
    if (!Array.isArray(rawEmotions)) return [];

    const tags: EmotionalTag[] = [];
    for (const e of rawEmotions) {
        if (!e.emotion || typeof e.emotion !== 'string') continue;

        const mapping = mapToOntology(e.emotion);
        if (!mapping) continue;

        const depth = ['surface', 'middle', 'deep'].includes(e.depth) ? e.depth : 'surface';
        const intensity = typeof e.intensity === 'number'
            ? Math.max(0, Math.min(1, e.intensity))
            : 0.3;

        tags.push({
            ontologyId: mapping.ontologyId,
            depth: depth as EmotionalTag['depth'],
            intensity,
            nuance: mapping.nuance || undefined,
            sourceContext: typeof e.source === 'string' ? e.source : undefined,
        });
    }
    return tags;
}

// ── Public API ──

/**
 * 运行杏仁核层 — 分析用户消息的情绪冲击
 *
 * 仅在完整管线路径时调用
 */
export async function runAmygdala(
    perception: PerceptionPacket,
    char: CharacterProfile,
    emotionState: EmotionState,
    recentMemorySummary: string,
    config: AmygdalaConfig
): Promise<AmygdalaResponse> {
    const prompt = buildAmygdalaPrompt(
        perception,
        char.name,
        char.systemPrompt || '',
        emotionState,
        recentMemorySummary
    );

    const result = await callAmygdalaAPI(prompt, config);

    if (!result) {
        return {
            emotionalTags: [],
            threatLevel: 0,
            rewardLevel: 0,
            flashbacks: [],
            somaticResponse: '',
        };
    }

    return {
        emotionalTags: mapEmotionsToTags(result.emotions),
        threatLevel: typeof result.threatLevel === 'number' ? result.threatLevel : 0,
        rewardLevel: typeof result.rewardLevel === 'number' ? result.rewardLevel : 0,
        flashbacks: Array.isArray(result.flashbacks) ? result.flashbacks : [],
        somaticResponse: typeof result.somaticResponse === 'string' ? result.somaticResponse : '',
        rawOutput: JSON.stringify(result),
    };
}

/**
 * 重逢缓冲 — 离线后重新见面时生成角色的情绪反应
 *
 * 在 gapFromLastSession >= 24h 时调用
 */
export async function generateReunionEmotion(
    char: CharacterProfile,
    lastEmotionState: EmotionState,
    gapHours: number,
    config: AmygdalaConfig
): Promise<EmotionalTag[]> {
    const prompt = buildReunionPrompt(
        char.name,
        char.systemPrompt || '',
        lastEmotionState,
        gapHours
    );

    const result = await callAmygdalaAPI(prompt, config);
    if (!result) return [];

    return mapEmotionsToTags(result.emotions);
}
