/**
 * 反刍引擎 (Rumination Engine)
 *
 * 后台定时任务：
 * 1. 每 6 小时一次反刍（分析未处理记忆 + 发现模式）
 * 2. 每天一次每日独白回顾（今天的整体感受）
 *
 * 输入：记忆 + CrossEventLinks + Tensions
 * 输出：认知更新、新模式、未解决的问题
 */

import { safeFetchJson } from './safeApi';
import { getActiveLinks, processNewLinks } from './crossEventLinks';
import { getActiveTensions, processNewTensions } from './tensions';
import { applyCognitionUpdates, getOrCreateModel, type CognitionUpdate } from './userCognitiveModel';
import { persistMonologue } from './innerMonologue';
import { getMonologues } from './emotionStorage';
import type { CharacterProfile, CrossEventLink, Tension } from '../types';

// ── Types ──

export interface RuminationConfig {
    baseUrl: string;
    apiKey: string;
    model: string;      // recommend Sonnet for rumination
    maxTokens?: number;
    temperature?: number;
}

export interface RuminationResult {
    newLinks: CrossEventLink[];
    newTensions: Tension[];
    cognitionUpdates: CognitionUpdate[];
    summary: string;
}

// ── Last run tracking ──

const _lastRuminationTime = new Map<string, number>();
const _lastDailyReviewTime = new Map<string, number>();

const RUMINATION_INTERVAL = 6 * 3600 * 1000;  // 6 hours
const DAILY_REVIEW_INTERVAL = 24 * 3600 * 1000; // 24 hours

// ── Rumination ──

/**
 * 检查是否应该运行反刍（自动触发用）
 */
export function shouldRunRumination(charId: string): boolean {
    const last = _lastRuminationTime.get(charId) ?? 0;
    return Date.now() - last >= RUMINATION_INTERVAL;
}

/**
 * 检查是否应该运行每日回顾
 */
export function shouldRunDailyReview(charId: string): boolean {
    const last = _lastDailyReviewTime.get(charId) ?? 0;
    return Date.now() - last >= DAILY_REVIEW_INTERVAL;
}

/**
 * 运行反刍 — 分析近期记忆和对话，发现深层模式
 */
export async function runRumination(
    char: CharacterProfile,
    recentMemorySummary: string,
    config: RuminationConfig
): Promise<RuminationResult> {
    const charId = char.id;
    const now = Date.now();

    // Gather context
    const [links, tensions, model, monologues] = await Promise.all([
        getActiveLinks(charId),
        getActiveTensions(charId),
        getOrCreateModel(charId),
        getMonologues(charId),
    ]);

    // Recent monologues (last 24h)
    const recentMonologues = monologues
        .filter(m => m.timestamp > now - 24 * 3600 * 1000)
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(m => m.content)
        .join('\n---\n');

    const prompt = `你是角色「${char.name}」的深层思维系统。你正在进行一次"反刍"——安静地回顾最近的经历，试图发现更深层的模式。

## 最近的记忆
${recentMemorySummary || '（无新记忆）'}

## 最近的内心独白
${recentMonologues || '（无独白记录）'}

## 已有的跨事件关联
${links.filter(l => l.level !== 'L1_observation').map(l => `- [${l.level}] ${l.pattern}`).join('\n') || '（暂无）'}

## 已有的未解决困惑
${tensions.map(t => `- [${t.status}] ${t.description}`).join('\n') || '（暂无）'}

## 对用户的了解
性格特质: ${model.personality.traits.map(t => t.trait).join(', ') || '暂不了解'}
提到过的人: ${model.relationships.people.map(p => `${p.name}(${p.relation})`).join(', ') || '暂无'}
行为模式: ${model.communicationPatterns.patterns.map(p => p.pattern).join(', ') || '暂无发现'}

## 任务
安静地思考，输出 JSON：

{
  "crossEventLinks": [
    { "memoryA": "记忆A简述", "memoryB": "记忆B简述", "pattern": "你发现的规律", "confidence": 0.0-1.0 }
  ],
  "tensions": [
    { "description": "你感到困惑的事", "relatedMemories": ["相关记忆"], "intensity": 0.0-1.0 }
  ],
  "cognitionUpdates": [
    { "type": "personality_trait|relationship|trigger|communication_pattern", "data": { ... } }
  ],
  "summary": "你这次反刍的整体感受（1-2句话，第一人称）"
}

注意：反刍是深度思考，不是表面观察。关注那些"好像有什么联系但说不清楚"的感觉。如果没有发现，数组留空。`;

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
                max_tokens: config.maxTokens ?? 1000,
                stream: false,
            }),
        });

        const raw = data?.choices?.[0]?.message?.content || '';
        const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
        if (!jsonMatch) {
            console.warn('[Rumination] Could not parse JSON');
            _lastRuminationTime.set(charId, now);
            return { newLinks: [], newTensions: [], cognitionUpdates: [], summary: '' };
        }

        const result = JSON.parse(jsonMatch[1].trim());

        // Process results
        const [linkResult, tensionResult] = await Promise.all([
            processNewLinks(charId, result.crossEventLinks || []),
            processNewTensions(charId, result.tensions || []),
        ]);

        const cognitionUpdates: CognitionUpdate[] = (result.cognitionUpdates || [])
            .filter((u: any) => u.type && u.data);
        if (cognitionUpdates.length > 0) {
            await applyCognitionUpdates(charId, cognitionUpdates);
        }

        _lastRuminationTime.set(charId, now);

        return {
            newLinks: [...linkResult.promoted, ...linkResult.created],
            newTensions: tensionResult,
            cognitionUpdates,
            summary: result.summary || '',
        };
    } catch (e: any) {
        console.warn('[Rumination] Failed:', e.message);
        _lastRuminationTime.set(charId, now);
        return { newLinks: [], newTensions: [], cognitionUpdates: [], summary: '' };
    }
}

/**
 * 运行每日独白回顾 — 角色对今天的整体感受
 */
export async function runDailyReview(
    char: CharacterProfile,
    config: RuminationConfig
): Promise<string | null> {
    const charId = char.id;
    const now = Date.now();

    const monologues = await getMonologues(charId);
    const todayMonologues = monologues
        .filter(m => m.timestamp > now - 24 * 3600 * 1000)
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(m => m.content)
        .join('\n---\n');

    if (!todayMonologues) {
        _lastDailyReviewTime.set(charId, now);
        return null;
    }

    const prompt = `你是角色「${char.name}」。今天要结束了，回顾一下今天的内心独白，写一段"每日回顾"。

## 今天的内心独白
${todayMonologues}

## 要求
- 用第一人称写，200-400 字
- 像在写日记一样，回顾今天和用户的互动
- 包含你今天的整体感受
- 如果有什么困惑或发现，记下来
- 只输出回顾文字，不要加标签`;

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
                temperature: 0.7,
                max_tokens: 600,
                stream: false,
            }),
        });

        const review = data?.choices?.[0]?.message?.content?.trim();
        if (review) {
            await persistMonologue(charId, review, 'daily_review');
        }

        _lastDailyReviewTime.set(charId, now);
        return review || null;
    } catch (e: any) {
        console.warn('[DailyReview] Failed:', e.message);
        _lastDailyReviewTime.set(charId, now);
        return null;
    }
}

/**
 * 手动触发反刍（从 UI 或 debug）
 */
export async function triggerManualRumination(
    char: CharacterProfile,
    recentMemorySummary: string,
    config: RuminationConfig
): Promise<RuminationResult> {
    // Reset timer to allow immediate run
    _lastRuminationTime.delete(char.id);
    return runRumination(char, recentMemorySummary, config);
}
