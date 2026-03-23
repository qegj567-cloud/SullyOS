/**
 * 人格结晶器 (Personality Crystallizer)
 *
 * 定时任务（每 3-7 天）：
 * 从长期互动中提炼涌现的人格特质
 *
 * 三重保护：
 * 1. reinforcementCount + 衰减：连续 3 周期未强化 → strength × 0.7
 * 2. provisional 标记：新特质前 2 周期为 provisional，不注入主 prompt
 * 3. 自审：每次运行时展示上一轮结果，允许修正
 *
 * 用户否决：Settings UI 标记特质为 rejected，永不再出现
 */

import { safeFetchJson } from './safeApi';
import { getCrystals, saveCrystal } from './emotionStorage';
import { getMonologues } from './emotionStorage';
import { getOrCreateModel } from './userCognitiveModel';
import type { PersonalityCrystal, CharacterProfile } from '../types';

// ── Types ──

export interface CrystallizerConfig {
    baseUrl: string;
    apiKey: string;
    model: string;      // recommend Sonnet
    maxTokens?: number;
    temperature?: number;
}

export interface CrystallizationResult {
    newCrystals: PersonalityCrystal[];
    reinforced: PersonalityCrystal[];
    decayed: PersonalityCrystal[];
    rejected: PersonalityCrystal[];
}

// ── Constants ──

const DECAY_MULTIPLIER = 0.7;
const DECAY_AFTER_PERIODS = 3;
const PROVISIONAL_PERIODS = 2;

// ── Core Logic ──

/**
 * 运行人格结晶
 */
export async function runCrystallization(
    char: CharacterProfile,
    config: CrystallizerConfig
): Promise<CrystallizationResult> {
    const charId = char.id;
    const now = Date.now();

    // Load existing crystals
    const existing = await getCrystals(charId);
    const activeCrystals = existing.filter(c => c.status !== 'rejected');

    // Load recent monologues + cognitive model for context
    const [monologues, model] = await Promise.all([
        getMonologues(charId),
        getOrCreateModel(charId),
    ]);

    // Last 7 days of monologues
    const recentMonologues = monologues
        .filter(m => m.timestamp > now - 7 * 24 * 3600 * 1000)
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(m => `[${new Date(m.timestamp).toLocaleDateString()}] ${m.content}`)
        .join('\n---\n');

    const existingTraits = activeCrystals.map(c => ({
        trait: c.trait,
        strength: c.strength,
        status: c.status,
        periodsSurvived: c.periodsSurvived,
        evidence: c.evidence.slice(-3),
    }));

    const prompt = `你是角色「${char.name}」的自我审视系统。通过回顾最近的内心独白和互动模式，提炼角色涌现的人格特质。

## 角色设定
${(char.systemPrompt || '').slice(0, 500)}

## 最近 7 天的内心独白
${recentMonologues || '（无独白记录）'}

## 对用户的了解
性格: ${model.personality.traits.map(t => t.trait).join(', ') || '未知'}
行为模式: ${model.communicationPatterns.patterns.map(p => p.pattern).join(', ') || '未发现'}

## 上一轮结晶的特质
${existingTraits.length > 0 ? JSON.stringify(existingTraits, null, 2) : '（首次结晶）'}

## 任务
1. 审视上一轮的特质——哪些被本周的互动验证了？哪些应该修正？
2. 发现新的涌现特质（如果有的话）

输出 JSON：
{
  "reinforced": ["被验证的特质名"],
  "corrections": [
    { "oldTrait": "原特质名", "correction": "修正后的描述或'remove'" }
  ],
  "newTraits": [
    { "trait": "新特质描述", "evidence": ["支撑证据1", "证据2"], "strength": 0.3-0.7 }
  ],
  "selfReflection": "你对自己这些特质变化的思考（第一人称，1-2句话）"
}

注意：
- 人格特质应该是超越单次对话的持续性特征
- 不要描述情绪状态，描述行为模式和价值倾向
- 新特质的 strength 初始值不应超过 0.5（需要时间验证）
- 可以说"我之前的判断有误"并修正
- 如果没有新发现，各数组留空`;

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
                temperature: config.temperature ?? 0.5,
                max_tokens: config.maxTokens ?? 800,
                stream: false,
            }),
        });

        const raw = data?.choices?.[0]?.message?.content || '';
        const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
        if (!jsonMatch) {
            console.warn('[Crystallizer] Could not parse JSON');
            return { newCrystals: [], reinforced: [], decayed: [], rejected: [] };
        }

        const result = JSON.parse(jsonMatch[1].trim());

        // Save self-reflection as monologue
        if (result.selfReflection) {
            const { persistMonologue } = await import('./innerMonologue');
            await persistMonologue(charId, result.selfReflection, 'reflection');
        }

        return await applyResults(charId, activeCrystals, result, now);
    } catch (e: any) {
        console.warn('[Crystallizer] Failed:', e.message);
        return { newCrystals: [], reinforced: [], decayed: [], rejected: [] };
    }
}

// ── Apply LLM results ──

async function applyResults(
    charId: string,
    existing: PersonalityCrystal[],
    result: {
        reinforced?: string[];
        corrections?: { oldTrait: string; correction: string }[];
        newTraits?: { trait: string; evidence: string[]; strength: number }[];
    },
    now: number
): Promise<CrystallizationResult> {
    const reinforced: PersonalityCrystal[] = [];
    const decayed: PersonalityCrystal[] = [];
    const rejected: PersonalityCrystal[] = [];
    const newCrystals: PersonalityCrystal[] = [];

    const reinforcedSet = new Set(result.reinforced || []);

    for (const crystal of existing) {
        if (crystal.status === 'rejected') continue;

        // Check for corrections
        const correction = (result.corrections || []).find(c => c.oldTrait === crystal.trait);
        if (correction) {
            if (correction.correction === 'remove') {
                crystal.status = 'rejected';
                rejected.push(crystal);
                await saveCrystal(crystal);
                continue;
            }
            // Update trait description
            crystal.trait = correction.correction;
        }

        // Check if reinforced
        if (reinforcedSet.has(crystal.trait)) {
            crystal.reinforcementCount += 1;
            crystal.lastReinforcedAt = now;
            crystal.strength = Math.min(1.0, crystal.strength + 0.1);
            crystal.periodsSurvived += 1;

            // Promote provisional → active if survived enough periods
            if (crystal.status === 'provisional' && crystal.periodsSurvived >= PROVISIONAL_PERIODS) {
                crystal.status = 'active';
            }

            reinforced.push(crystal);
        } else {
            // Not reinforced this period
            crystal.periodsSurvived += 1;

            // Count consecutive non-reinforcement periods
            const periodsWithoutReinforcement = crystal.periodsSurvived - crystal.reinforcementCount;
            if (periodsWithoutReinforcement >= DECAY_AFTER_PERIODS) {
                crystal.strength *= DECAY_MULTIPLIER;
                decayed.push(crystal);

                // Remove if strength too low
                if (crystal.strength < 0.1) {
                    crystal.status = 'rejected';
                    rejected.push(crystal);
                }
            }
        }

        await saveCrystal(crystal);
    }

    // Create new crystals (always start as provisional)
    for (const raw of (result.newTraits || [])) {
        const crystal: PersonalityCrystal = {
            id: `crystal_${now}_${Math.random().toString(36).slice(2, 8)}`,
            charId,
            trait: raw.trait,
            evidence: raw.evidence || [],
            strength: Math.min(0.5, raw.strength || 0.3), // cap initial strength
            reinforcementCount: 0,
            status: 'provisional',
            createdAt: now,
            lastReinforcedAt: now,
            periodsSurvived: 0,
        };
        await saveCrystal(crystal);
        newCrystals.push(crystal);
    }

    return { newCrystals, reinforced, decayed, rejected };
}

// ── Prompt Formatting ──

/**
 * 格式化人格结晶为 prompt 注入文本
 * 只注入 active 特质（provisional 放在低权重区）
 */
export function formatCrystalsForPrompt(crystals: PersonalityCrystal[]): string | null {
    const active = crystals.filter(c => c.status === 'active');
    const provisional = crystals.filter(c => c.status === 'provisional');

    if (active.length === 0 && provisional.length === 0) return null;

    const parts: string[] = [];

    if (active.length > 0) {
        const lines = active.map(c =>
            `- ${c.trait}（强度 ${Math.round(c.strength * 100)}%，验证 ${c.reinforcementCount} 次）`
        );
        parts.push(`### 你涌现的人格特质\n以下是你在长期互动中逐渐形成的独特特质：\n${lines.join('\n')}`);
    }

    if (provisional.length > 0) {
        const lines = provisional.map(c => `- ${c.trait}（试验中）`);
        parts.push(`### 正在形成的特质（参考）\n${lines.join('\n')}`);
    }

    return parts.join('\n\n');
}

// ── User Rejection ──

/**
 * 用户否决特质（从 Settings UI 触发）
 */
export async function rejectCrystal(charId: string, crystalId: string): Promise<void> {
    const crystals = await getCrystals(charId);
    const crystal = crystals.find(c => c.id === crystalId);
    if (crystal) {
        crystal.status = 'rejected';
        await saveCrystal(crystal);
    }
}

/**
 * 获取角色的活跃人格结晶（用于 UI + prompt 注入）
 */
export async function getActiveCrystals(charId: string): Promise<PersonalityCrystal[]> {
    const crystals = await getCrystals(charId);
    return crystals.filter(c => c.status !== 'rejected');
}
