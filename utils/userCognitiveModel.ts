/**
 * 用户认知模型 (User Cognitive Model)
 *
 * 角色对用户的深层理解，存储在 UserRoom 中
 * 由海马体层和反刍引擎增量更新
 */

import { saveCognitiveModel, loadCognitiveModel } from './emotionStorage';
import type { UserCognitiveModel } from '../types';

// ── Factory ──

export function createEmptyCognitiveModel(charId: string): UserCognitiveModel {
    return {
        charId,
        personality: {
            traits: [],
        },
        relationships: {
            people: [],
        },
        triggers: {
            topics: [],
        },
        communicationPatterns: {
            patterns: [],
            averageMessageLength: 50,
            activeHours: [],
        },
        lastUpdatedAt: Date.now(),
    };
}

// ── Load / Save ──

export async function getOrCreateModel(charId: string): Promise<UserCognitiveModel> {
    const existing = await loadCognitiveModel(charId);
    if (existing) return existing;
    const model = createEmptyCognitiveModel(charId);
    await saveCognitiveModel(model);
    return model;
}

// ── Incremental Updates ──

export interface CognitionUpdate {
    type: 'personality_trait' | 'relationship' | 'trigger' | 'communication_pattern' | 'attachment_style';
    data: Record<string, any>;
}

/**
 * 应用海马体/反刍引擎的认知更新
 */
export async function applyCognitionUpdates(
    charId: string,
    updates: CognitionUpdate[]
): Promise<UserCognitiveModel> {
    const model = await getOrCreateModel(charId);
    const now = Date.now();

    for (const update of updates) {
        switch (update.type) {
            case 'personality_trait':
                mergePersonalityTrait(model, update.data);
                break;
            case 'relationship':
                mergeRelationship(model, update.data);
                break;
            case 'trigger':
                mergeTrigger(model, update.data);
                break;
            case 'communication_pattern':
                mergeCommunicationPattern(model, update.data);
                break;
            case 'attachment_style':
                if (update.data.style && typeof update.data.style === 'string') {
                    model.personality.attachmentStyle = {
                        style: update.data.style,
                        confidence: update.data.confidence ?? 0.3,
                        evidence: update.data.evidence ?? [],
                    };
                }
                break;
        }
    }

    model.lastUpdatedAt = now;
    await saveCognitiveModel(model);
    return model;
}

/**
 * 更新用户消息长度统计
 */
export async function updateMessageStats(
    charId: string,
    messageLength: number,
    hour: number
): Promise<void> {
    const model = await getOrCreateModel(charId);

    // Update average message length (exponential moving average)
    const alpha = 0.05;
    model.communicationPatterns.averageMessageLength =
        model.communicationPatterns.averageMessageLength * (1 - alpha) + messageLength * alpha;

    // Update active hours
    const hourEntry = model.communicationPatterns.activeHours.find(h => h.hour === hour);
    if (hourEntry) {
        hourEntry.frequency += 1;
    } else {
        model.communicationPatterns.activeHours.push({ hour, frequency: 1 });
    }

    model.lastUpdatedAt = Date.now();
    await saveCognitiveModel(model);
}

/**
 * 格式化认知模型为 prompt 注入文本
 */
export function formatCognitiveModelForPrompt(model: UserCognitiveModel): string | null {
    const parts: string[] = [];

    // Personality traits (confidence > 0.4)
    const strongTraits = model.personality.traits.filter(t => t.confidence > 0.4);
    if (strongTraits.length > 0) {
        const traitLines = strongTraits.map(t =>
            `- ${t.trait}（确信度 ${Math.round(t.confidence * 100)}%）`
        );
        parts.push(`**你对 TA 性格的了解：**\n${traitLines.join('\n')}`);
    }

    // Attachment style
    if (model.personality.attachmentStyle && model.personality.attachmentStyle.confidence > 0.5) {
        parts.push(`**TA 的依恋风格：** ${model.personality.attachmentStyle.style}`);
    }

    // Relationships
    if (model.relationships.people.length > 0) {
        const relLines = model.relationships.people
            .filter(p => p.mentions >= 2) // only include people mentioned 2+ times
            .map(p => `- ${p.name}（${p.relation}）`);
        if (relLines.length > 0) {
            parts.push(`**TA 提过的人：**\n${relLines.join('\n')}`);
        }
    }

    // Triggers (sensitive topics)
    const activeTriggers = model.triggers.topics.filter(t => t.intensity > 0.3);
    if (activeTriggers.length > 0) {
        const triggerLines = activeTriggers.map(t =>
            `- ${t.topic} → ${t.reaction}`
        );
        parts.push(`**注意这些话题：**\n${triggerLines.join('\n')}`);
    }

    // Communication patterns from L3 CrossEventLinks
    const patterns = model.communicationPatterns.patterns.filter(p => p.confidence > 0.6);
    if (patterns.length > 0) {
        const patternLines = patterns.map(p => `- ${p.pattern}`);
        parts.push(`**TA 的行为模式：**\n${patternLines.join('\n')}`);
    }

    if (parts.length === 0) return null;
    return `### 你对用户的了解\n${parts.join('\n\n')}`;
}

// ── Merge Helpers ──

function mergePersonalityTrait(model: UserCognitiveModel, data: Record<string, any>): void {
    const trait = data.trait as string;
    if (!trait) return;

    const existing = model.personality.traits.find(t => t.trait === trait);
    if (existing) {
        // Increase confidence slightly
        existing.confidence = Math.min(1.0, existing.confidence + 0.1);
        if (data.evidence) {
            existing.evidence.push(...(Array.isArray(data.evidence) ? data.evidence : [data.evidence]));
            // Keep last 10 evidence items
            existing.evidence = existing.evidence.slice(-10);
        }
        existing.lastUpdated = Date.now();
    } else {
        model.personality.traits.push({
            trait,
            confidence: data.confidence ?? 0.3,
            evidence: Array.isArray(data.evidence) ? data.evidence : [],
            lastUpdated: Date.now(),
        });
    }
}

function mergeRelationship(model: UserCognitiveModel, data: Record<string, any>): void {
    const name = data.name as string;
    if (!name) return;

    const existing = model.relationships.people.find(p => p.name === name);
    if (existing) {
        existing.mentions += 1;
        if (data.relation) existing.relation = data.relation;
        if (typeof data.sentimentToward === 'number') {
            existing.sentimentToward = (existing.sentimentToward + data.sentimentToward) / 2;
        }
    } else {
        model.relationships.people.push({
            name,
            relation: data.relation ?? '未知',
            sentimentToward: data.sentimentToward ?? 0,
            mentions: 1,
        });
    }
}

function mergeTrigger(model: UserCognitiveModel, data: Record<string, any>): void {
    const topic = data.topic as string;
    if (!topic) return;

    const existing = model.triggers.topics.find(t => t.topic === topic);
    if (existing) {
        existing.intensity = Math.min(1.0, (existing.intensity + (data.intensity ?? 0.5)) / 2 + 0.1);
        if (data.reaction) existing.reaction = data.reaction;
        if (data.evidence) {
            existing.evidence.push(...(Array.isArray(data.evidence) ? data.evidence : [data.evidence]));
            existing.evidence = existing.evidence.slice(-10);
        }
    } else {
        model.triggers.topics.push({
            topic,
            reaction: data.reaction ?? '敏感',
            intensity: data.intensity ?? 0.5,
            evidence: Array.isArray(data.evidence) ? data.evidence : [],
        });
    }
}

function mergeCommunicationPattern(model: UserCognitiveModel, data: Record<string, any>): void {
    const pattern = data.pattern as string;
    if (!pattern) return;

    const existing = model.communicationPatterns.patterns.find(p => p.pattern === pattern);
    if (existing) {
        existing.confidence = Math.min(1.0, existing.confidence + 0.1);
        if (data.example) {
            existing.examples.push(data.example);
            existing.examples = existing.examples.slice(-5);
        }
    } else {
        model.communicationPatterns.patterns.push({
            pattern,
            confidence: data.confidence ?? 0.5,
            examples: data.example ? [data.example] : [],
        });
    }
}
