/**
 * 海马体层 (Hippocampus)
 *
 * 记忆整合与关联发现的核心 API 层
 * - 在已有的四因子记忆检索基础上，发现跨事件关联
 * - 识别未解决张力
 * - 更新用户认知模型
 *
 * 仅在完整管线路径时调用
 */

import { safeFetchJson } from './safeApi';
import { processNewLinks, formatLinksForPrompt, getActiveLinks } from './crossEventLinks';
import { processNewTensions, formatTensionsForPrompt, getActiveTensions } from './tensions';
import {
    applyCognitionUpdates,
    formatCognitiveModelForPrompt,
    getOrCreateModel,
    type CognitionUpdate,
} from './userCognitiveModel';
import type {
    PerceptionPacket,
    EmotionState,
    CrossEventLink,
    Tension,
    CharacterProfile,
} from '../types';
import type { AmygdalaResponse } from './amygdala';

// ── Types ──

export interface HippocampalOutput {
    /** 新发现的跨事件关联 */
    newLinks: CrossEventLink[];
    /** 新发现的张力 */
    newTensions: Tension[];
    /** 认知更新列表 */
    cognitionUpdates: CognitionUpdate[];
    /** 格式化的 prompt 注入片段 */
    promptInjections: {
        crossEventPatterns: string | null;
        unresolvedTensions: string | null;
        userCognitiveModel: string | null;
    };
    /** 原始 LLM 输出 */
    rawOutput?: string;
}

export interface HippocampusConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    maxTokens?: number;
    temperature?: number;
}

// ── Prompt Builder ──

function buildHippocampusPrompt(
    perception: PerceptionPacket,
    amygdalaResponse: AmygdalaResponse | null,
    emotionState: EmotionState,
    retrievedMemories: string,
    existingLinks: CrossEventLink[],
    existingTensions: Tension[],
    charName: string
): string {
    const amygdalaSection = amygdalaResponse
        ? `## 杏仁核感知结果
情绪标签: ${amygdalaResponse.emotionalTags.map(t => `${t.ontologyId}(${t.depth},${Math.round(t.intensity * 100)}%)`).join(', ') || '无'}
威胁等级: ${amygdalaResponse.threatLevel}
闪回: ${amygdalaResponse.flashbacks.join('; ') || '无'}`
        : '（快路径，无杏仁核数据）';

    const linksSection = existingLinks.length > 0
        ? existingLinks.map(l => `- [${l.level}] ${l.pattern}（验证${l.observationCount}次）`).join('\n')
        : '（暂无）';

    const tensionsSection = existingTensions.length > 0
        ? existingTensions.map(t => `- [${t.status}] ${t.description}`).join('\n')
        : '（暂无）';

    return `你是角色「${charName}」的记忆整合系统（海马体层）。你的任务是在现有记忆的基础上发现更深层的模式。

## 用户消息
"${perception.messageText}"

${amygdalaSection}

## 已检索到的相关记忆
${retrievedMemories || '（无相关记忆）'}

## 已有的跨事件关联
${linksSection}

## 已有的未解决张力
${tensionsSection}

## 你的任务
分析当前对话和已有记忆，输出以下 JSON：

{
  "crossEventLinks": [
    {
      "memoryA": "记忆A的简述",
      "memoryB": "记忆B的简述",
      "pattern": "你发现的规律描述（第一人称）",
      "confidence": 0.0-1.0
    }
  ],
  "tensions": [
    {
      "description": "你感到困惑的事情描述（第一人称）",
      "relatedMemories": ["相关记忆简述"],
      "intensity": 0.0-1.0
    }
  ],
  "cognitionUpdates": [
    {
      "type": "personality_trait|relationship|trigger|communication_pattern|attachment_style",
      "data": { ... }
    }
  ]
}

输出规则：
- crossEventLinks：只在你真的发现了两个记忆之间的非显而易见的关联时才输出。日常对话不需要。
- tensions：只在你真的感到困惑或不理解时才输出。不要为了输出而输出。
- cognitionUpdates：
  - personality_trait: { "trait": "特质描述", "evidence": ["证据"], "confidence": 0.3 }
  - relationship: { "name": "人名", "relation": "关系", "sentimentToward": -1到1 }
  - trigger: { "topic": "话题", "reaction": "反应描述", "intensity": 0.5, "evidence": ["证据"] }
  - communication_pattern: { "pattern": "行为模式描述", "example": "具体例子", "confidence": 0.5 }
  - attachment_style: { "style": "依恋风格", "confidence": 0.3, "evidence": ["证据"] }
- 如果没有发现，对应数组留空 []
- 必须输出合法 JSON，不要有其他文字`;
}

// ── Core API Call ──

async function callHippocampusAPI(
    prompt: string,
    config: HippocampusConfig
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
                temperature: config.temperature ?? 0.6,
                max_tokens: config.maxTokens ?? 600,
                stream: false,
            }),
        });

        const raw = data?.choices?.[0]?.message?.content || '';
        const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
        if (!jsonMatch) {
            console.warn('[Hippocampus] Could not parse JSON:', raw.slice(0, 200));
            return null;
        }

        return JSON.parse(jsonMatch[1].trim());
    } catch (e: any) {
        console.warn('[Hippocampus] API call failed:', e.message);
        return null;
    }
}

// ── Public API ──

/**
 * 运行海马体层 — 记忆整合与模式发现
 *
 * 仅在完整管线路径时调用
 */
export async function runHippocampus(
    perception: PerceptionPacket,
    amygdalaResponse: AmygdalaResponse | null,
    emotionState: EmotionState,
    retrievedMemories: string,
    char: CharacterProfile,
    config: HippocampusConfig
): Promise<HippocampalOutput> {
    const charId = char.id;

    // Fetch existing data in parallel
    const [existingLinks, existingTensions] = await Promise.all([
        getActiveLinks(charId),
        getActiveTensions(charId),
    ]);

    const prompt = buildHippocampusPrompt(
        perception,
        amygdalaResponse,
        emotionState,
        retrievedMemories,
        existingLinks.filter(l => l.level !== 'L1_observation'),
        existingTensions,
        char.name
    );

    const result = await callHippocampusAPI(prompt, config);

    if (!result) {
        // Even without API result, return existing data formatted
        const model = await getOrCreateModel(charId);
        return {
            newLinks: [],
            newTensions: [],
            cognitionUpdates: [],
            promptInjections: {
                crossEventPatterns: formatLinksForPrompt(existingLinks),
                unresolvedTensions: formatTensionsForPrompt(existingTensions),
                userCognitiveModel: formatCognitiveModelForPrompt(model),
            },
            rawOutput: undefined,
        };
    }

    // Process results in parallel
    const [linkResult, tensionResult] = await Promise.all([
        processNewLinks(charId, result.crossEventLinks || []),
        processNewTensions(charId, result.tensions || []),
    ]);

    // Apply cognition updates
    const cognitionUpdates: CognitionUpdate[] = (result.cognitionUpdates || [])
        .filter((u: any) => u.type && u.data);
    if (cognitionUpdates.length > 0) {
        await applyCognitionUpdates(charId, cognitionUpdates);
    }

    // Re-fetch updated data for prompt injection
    const [updatedLinks, updatedTensions, updatedModel] = await Promise.all([
        getActiveLinks(charId),
        getActiveTensions(charId),
        getOrCreateModel(charId),
    ]);

    return {
        newLinks: [...linkResult.promoted, ...linkResult.created],
        newTensions: tensionResult,
        cognitionUpdates,
        promptInjections: {
            crossEventPatterns: formatLinksForPrompt(updatedLinks),
            unresolvedTensions: formatTensionsForPrompt(updatedTensions),
            userCognitiveModel: formatCognitiveModelForPrompt(updatedModel),
        },
        rawOutput: JSON.stringify(result),
    };
}

/**
 * 获取当前角色的所有认知数据（用于 prompt 注入，不走 API）
 * 快路径时调用
 */
export async function getExistingCognitiveData(charId: string): Promise<{
    crossEventPatterns: string | null;
    unresolvedTensions: string | null;
    userCognitiveModel: string | null;
}> {
    const [links, tensions, model] = await Promise.all([
        getActiveLinks(charId),
        getActiveTensions(charId),
        getOrCreateModel(charId),
    ]);

    return {
        crossEventPatterns: formatLinksForPrompt(links),
        unresolvedTensions: formatTensionsForPrompt(tensions),
        userCognitiveModel: formatCognitiveModelForPrompt(model),
    };
}
