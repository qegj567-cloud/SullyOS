/**
 * 认知管线编排器 (Cognitive Pipeline)
 *
 * 连接所有认知架构组件：
 * - 感知层 → 管线判断 → (杏仁核 ∥ 记忆检索) → 海马体 → 情绪引擎 → prompt 注入
 *
 * 提供统一接口给 chatPrompts.ts 调用
 */

import { buildPerceptionPacket } from './perceptionBuilder';
import { decidePipelinePath, type TriggerConfig } from './pipelineTrigger';
import { EmotionDynamicsEngine, createEmptyState, restoreEngine } from './emotionDynamics';
import { runAmygdala, generateReunionEmotion, type AmygdalaConfig, type AmygdalaResponse } from './amygdala';
import { runHippocampus, getExistingCognitiveData, type HippocampusConfig } from './hippocampus';
import { loadEmotionState, saveEmotionState, saveEmotionSnapshot } from './emotionStorage';
import { scanEmotionKeywords } from './emotionOntology';
import { updateMessageStats } from './userCognitiveModel';
import type { CharacterProfile, Message, EmotionalTag, EmotionState } from '../types';

// ── Types ──

export interface CognitivePipelineResult {
    /** 走了哪条路径 */
    path: 'fast' | 'full';
    /** 触发原因（完整管线时有值） */
    triggerReasons: string[];
    /** 情绪动力学的自然语言描述（注入 prompt 用） */
    emotionDynamicsDesc: string;
    /** 是否触发了重逢缓冲 */
    reunionTriggered: boolean;
    /** 认知数据（注入 prompt 用） */
    cognitiveInjections: {
        crossEventPatterns: string | null;
        unresolvedTensions: string | null;
        userCognitiveModel: string | null;
    };
    /** debug 数据 */
    amygdalaRaw?: string;
    hippocampusRaw?: string;
}

export interface CognitivePipelineConfig {
    /** 杏仁核 API 配置（复用角色的 emotionConfig.api） */
    amygdalaApi?: AmygdalaConfig;
    /** 海马体 API 配置（可复用同一 API 或用不同模型） */
    hippocampusApi?: HippocampusConfig;
    /** 管线触发配置 */
    triggerConfig?: TriggerConfig;
    /** 用户平均消息长度（用于偏差计算） */
    userAverageMessageLength?: number;
    /** 上次 session 的时间戳 */
    lastSessionTimestamp?: number;
    /** 记忆宫殿检索结果（由外部传入） */
    retrievedMemories?: string;
}

// ── Per-character engine cache ──

const _engineCache = new Map<string, EmotionDynamicsEngine>();

async function getEngine(charId: string): Promise<EmotionDynamicsEngine> {
    let engine = _engineCache.get(charId);
    if (engine) return engine;

    const saved = await loadEmotionState(charId);
    if (saved) {
        engine = restoreEngine(saved);
    } else {
        engine = new EmotionDynamicsEngine(createEmptyState());
    }

    _engineCache.set(charId, engine);
    return engine;
}

async function persistEngine(charId: string, engine: EmotionDynamicsEngine): Promise<void> {
    const state = engine.getState();
    await saveEmotionState(charId, state);
}

// ── Quick local emotion extraction (fast path) ──

function extractLocalEmotionTags(messageText: string): EmotionalTag[] {
    const hits = scanEmotionKeywords(messageText);
    return hits.map(h => ({
        ontologyId: h.ontologyId,
        depth: 'surface' as const,
        intensity: 0.25,
        sourceContext: `关键词检测: ${h.keyword}`,
    }));
}

// ── Main Pipeline ──

/**
 * 运行认知管线
 *
 * 在每条用户消息发送后、主 API 调用前执行
 * 返回结果注入到 PromptRuntimeContext.cognitiveContext
 */
export async function runCognitivePipeline(
    char: CharacterProfile,
    message: string,
    recentMessages: Message[],
    config: CognitivePipelineConfig
): Promise<CognitivePipelineResult> {
    const now = Date.now();

    // 1. Build perception packet
    const perception = buildPerceptionPacket({
        message,
        timestamp: now,
        recentMessages,
        lastSessionTimestamp: config.lastSessionTimestamp,
        userAverageMessageLength: config.userAverageMessageLength,
    });

    // 2. Get emotion engine
    const engine = await getEngine(char.id);
    const currentState = engine.getState();

    // 3. Decide pipeline path
    const trigger = decidePipelinePath(perception, currentState, config.triggerConfig);

    let reunionTriggered = false;
    let amygdalaRaw: string | undefined;
    let hippocampusRaw: string | undefined;
    let cognitiveInjections = {
        crossEventPatterns: null as string | null,
        unresolvedTensions: null as string | null,
        userCognitiveModel: null as string | null,
    };

    // Update message stats (fire-and-forget)
    updateMessageStats(char.id, message.length, new Date(now).getHours()).catch(() => {});

    if (trigger.path === 'full' && config.amygdalaApi) {
        // ── Full Pipeline ──

        // 3a. Reunion buffer (if needed)
        if (trigger.needsReunion) {
            console.log('[CogPipeline] Reunion detected, generating reunion emotions...');
            const reunionTags = await generateReunionEmotion(
                char,
                currentState,
                perception.gapFromLastSessionHours,
                config.amygdalaApi
            );
            if (reunionTags.length > 0) {
                engine.update(reunionTags, now - 1000);
                reunionTriggered = true;
            }
        }

        // 3b. Run amygdala (can run in parallel with memory retrieval)
        console.log(`[CogPipeline] Full pipeline triggered: ${trigger.reasons.join(', ')}`);
        const amygdalaResult = await runAmygdala(
            perception,
            char,
            engine.getState(),
            config.retrievedMemories || '',
            config.amygdalaApi
        );
        amygdalaRaw = amygdalaResult.rawOutput;

        // 3c. Feed amygdala results into emotion dynamics engine
        if (amygdalaResult.emotionalTags.length > 0) {
            engine.update(amygdalaResult.emotionalTags, now);
        }

        // 3d. Run hippocampus (depends on amygdala result)
        if (config.hippocampusApi) {
            const hippoResult = await runHippocampus(
                perception,
                amygdalaResult,
                engine.getState(),
                config.retrievedMemories || '',
                char,
                config.hippocampusApi
            );
            hippocampusRaw = hippoResult.rawOutput;
            cognitiveInjections = hippoResult.promptInjections;
        }
    } else {
        // ── Fast Path ──
        const localTags = extractLocalEmotionTags(message);
        engine.update(localTags.length > 0 ? localTags : [], now);

        // Still load existing cognitive data for prompt injection (no API cost)
        cognitiveInjections = await getExistingCognitiveData(char.id);
    }

    // 4. Generate description for prompt injection
    const emotionDynamicsDesc = engine.describe();

    // 5. Persist state (fire-and-forget)
    persistEngine(char.id, engine).catch(e =>
        console.warn('[CogPipeline] Failed to persist emotion state:', e)
    );

    // 5b. Save snapshot if significant change
    const maxIntensity = engine.getMaxIntensity();
    if (maxIntensity > 0.3 || trigger.path === 'full') {
        saveEmotionSnapshot({
            id: `snap_${now}_${Math.random().toString(36).slice(2, 6)}`,
            charId: char.id,
            timestamp: now,
            state: engine.getState(),
            trigger: trigger.path === 'full' ? trigger.reasons[0] : 'periodic',
        }).catch(() => {});
    }

    return {
        path: trigger.path,
        triggerReasons: trigger.reasons,
        emotionDynamicsDesc,
        reunionTriggered,
        cognitiveInjections,
        amygdalaRaw,
        hippocampusRaw,
    };
}

/**
 * 获取角色当前的情绪状态（用于 UI 展示、debug 等）
 */
export async function getCharacterEmotionState(charId: string): Promise<EmotionState> {
    const engine = await getEngine(charId);
    return engine.getState();
}

/**
 * 获取角色的情绪可视化数据
 */
export async function getCharacterEmotionVisualization(charId: string) {
    const engine = await getEngine(charId);
    return engine.getVisualizationData();
}

/**
 * 重置角色情绪状态（debug / 用户手动重置）
 */
export async function resetCharacterEmotionState(charId: string): Promise<void> {
    const engine = new EmotionDynamicsEngine(createEmptyState());
    _engineCache.set(charId, engine);
    await persistEngine(charId, engine);
}
