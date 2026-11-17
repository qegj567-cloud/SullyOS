import type { MemoryPalaceFeatureFlags } from '../../types';
import { appendDevDebugMemoryPalaceLog } from '../devDebug';
import type { LocalContextAnalysis, RecallRouterTrace } from './recallRouter';
import type { ExplicitEntitySignalSource } from './explicitEntityRecall';
import type { EventBoxLightMatchSource } from './eventBoxLightIndex';
import type { UserInteractionAnalysis } from './interactionAdaptation';
import type { DeepEngagementAnalysis } from './deepEngagement';
import type { ConversationEngagementAnalysis } from './conversationEngagement';

/**
 * 任何会改变召回输出含义的实现都要升级这个版本。
 * Trace 不依赖构建 commit：同一 commit 做 A/B 时仍能看出实际跑的是哪代管线。
 */
export const RECALL_PIPELINE_VERSION = 'context-m3.3';

export const DEFAULT_MEMORY_PALACE_FEATURE_FLAGS: MemoryPalaceFeatureFlags = Object.freeze({
    recallRouter: false,
    interactionAdaptation: false,
    deepEngagement: false,
    epistemicState: false,
});

export type RecallEntryPoint =
    | 'chat_app'
    | 'home_3d'
    | 'collaboration'
    | 'emotion_eval'
    | 'proactive_chat'
    | 'vr_world'
    | 'world_home'
    | 'chat_payload'
    | 'direct';

/** Direct conversation surfaces share recall and conversational guidance. */
export const isChatConversationEntry = (entry?: RecallEntryPoint): boolean =>
    entry === 'chat_app' || entry === 'home_3d';

export type RecallOutcome =
    | 'success'
    | 'empty'
    | 'skipped_palace_disabled'
    | 'skipped_embedding_unconfigured'
    | 'error';

export type RecallIntent =
    | 'explicit_entity'
    | 'explicit_event'
    | 'implicit_reference'
    | 'semantic'
    | 'date';

export interface ExplicitEntityRecallTrace {
    status: 'disabled' | 'out_of_scope' | 'no_signal' | 'signaled' | 'hit' | 'miss' | 'error';
    signalCount?: number;
    signalSources?: ExplicitEntitySignalSource[];
    matchedMemoryCount?: number;
    matchedEventBoxCount?: number;
    guaranteedCount?: number;
}

export interface EventBoxMetadataRecallTrace {
    status: 'disabled' | 'out_of_scope' | 'no_query' | 'planned' | 'hit' | 'miss' | 'error';
    queryCount?: number;
    indexedBoxCount?: number;
    matchedBoxCount?: number;
    candidateCount?: number;
    matchSources?: EventBoxLightMatchSource[];
}

export type RecallFailureReason = 'retrieval_exception' | 'injection_exception';

export interface RecallTraceStage {
    name: 'clear_previous_injection' | 'explicit_signal' | 'context_analyzer' | 'interaction_adaptation' | 'deep_engagement' | 'recall_gate' | 'recall_router' | 'load_messages' | 'room_plates' | 'entity_lookup' | 'event_box_lookup' | 'retrieve' | 'finalize';
    durationMs: number;
    outcome: 'ok' | 'empty' | 'skipped' | 'error';
}

export interface RecallTrace {
    id: string;
    pipelineVersion: string;
    startedAt: string;
    finishedAt?: string;
    durationMs?: number;
    charId: string;
    entryPoint: RecallEntryPoint;
    featureFlagsSnapshot: Readonly<MemoryPalaceFeatureFlags>;
    configSnapshotHash: string;
    request: {
        recentMessageCount: number | null;
        hasQueryHint: boolean;
    };
    injection: {
        clearedPreviousMemory: boolean;
        clearedPreviousRoomPlates: boolean;
        memoryChars: number;
        roomPlateChars: number;
    };
    stages: RecallTraceStage[];
    recallIntent?: RecallIntent;
    explicitEntityRecall?: ExplicitEntityRecallTrace;
    eventBoxMetadataRecall?: EventBoxMetadataRecallTrace;
    /** ChatApp 当轮的纯本地语境分析；不含用户原文。 */
    contextAnalyzer?: LocalContextAnalysis;
    /** LLM 解析器当前只保留架构位置，尚不参与回复。 */
    recallResolver?: { status: 'disabled' | 'out_of_scope' | 'deferred' };
    interactionAdaptation?: {
        status: 'disabled' | 'out_of_scope' | 'no_signal' | 'observed';
        analysis?: UserInteractionAnalysis;
    };
    /** ChatApp 当轮的参与状态；v2 只含枚举、分数和计数，不含用户原文。 */
    deepEngagement?: {
        status: 'disabled' | 'out_of_scope' | 'no_signal' | 'observed';
        engine?: 'conversation_v2' | 'legacy_depth';
        analysis?: ConversationEngagementAnalysis | DeepEngagementAnalysis;
    };
    /** @deprecated context-m1.4 前的旧 Trace 字段。 */
    recallRouter?: RecallRouterTrace;
    outcome?: RecallOutcome;
    retrievalReason?: RecallRetrievalTelemetry['reason'];
    failureReason?: RecallFailureReason;
}

export interface RecallRetrievalTelemetry {
    outcome: 'success' | 'empty' | 'error';
    reason?: 'no_effective_query' | 'no_results' | 'formatted_empty' | 'exception';
    explicitEntity?: {
        status: 'hit' | 'miss' | 'error';
        durationMs: number;
        signalCount: number;
        matchedMemoryCount: number;
        matchedEventBoxCount: number;
        guaranteedCount: number;
    };
    eventBoxMetadata?: {
        status: 'hit' | 'miss' | 'error';
        durationMs: number;
        queryCount: number;
        indexedBoxCount: number;
        matchedBoxCount: number;
        candidateCount: number;
        matchSources: EventBoxLightMatchSource[];
    };
}

interface SafeRuntimeConfigSnapshot {
    pipelineVersion: string;
    featureFlags: MemoryPalaceFeatureFlags;
    embedding: { configured: boolean; model: string; dimensions: number | null };
    lightLLM: { configured: boolean; model: string };
    rerank: { enabled: boolean; configured: boolean; model: string; topN: number | null };
    remoteVector: { enabled: boolean; initialized: boolean };
}

function fnv1a32Hex(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeFeatureFlags(value: unknown): MemoryPalaceFeatureFlags {
    const source = value && typeof value === 'object'
        ? value as Partial<MemoryPalaceFeatureFlags>
        : {};
    return {
        recallRouter: source.recallRouter === true,
        interactionAdaptation: source.interactionAdaptation === true,
        deepEngagement: source.deepEngagement === true,
        epistemicState: source.epistemicState === true,
    };
}

function readJsonStorage(key: string): any {
    try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

/**
 * 只保留会影响管线行为、但不含秘密的字段。baseUrl / apiKey / 对话原文永不进入 Trace。
 */
export function readRecallRuntimeSnapshot(): {
    featureFlagsSnapshot: Readonly<MemoryPalaceFeatureFlags>;
    configSnapshotHash: string;
    safeConfig: SafeRuntimeConfigSnapshot;
} {
    const memoryConfig = readJsonStorage('os_memory_palace_config');
    const remoteConfig = readJsonStorage('os_remote_vector_config');
    const featureFlags = Object.freeze(normalizeFeatureFlags(memoryConfig?.featureFlags));
    const safeConfig: SafeRuntimeConfigSnapshot = {
        pipelineVersion: RECALL_PIPELINE_VERSION,
        featureFlags: { ...featureFlags },
        embedding: {
            configured: Boolean(memoryConfig?.embedding?.baseUrl && memoryConfig?.embedding?.apiKey),
            model: String(memoryConfig?.embedding?.model || ''),
            dimensions: Number.isFinite(memoryConfig?.embedding?.dimensions) ? Number(memoryConfig.embedding.dimensions) : null,
        },
        lightLLM: {
            configured: Boolean(memoryConfig?.lightLLM?.baseUrl && memoryConfig?.lightLLM?.apiKey && memoryConfig?.lightLLM?.model),
            model: String(memoryConfig?.lightLLM?.model || ''),
        },
        rerank: {
            enabled: memoryConfig?.rerank?.enabled === true,
            configured: Boolean(memoryConfig?.rerank?.baseUrl && memoryConfig?.rerank?.apiKey && memoryConfig?.rerank?.model),
            model: String(memoryConfig?.rerank?.model || ''),
            topN: Number.isFinite(memoryConfig?.rerank?.topN) ? Number(memoryConfig.rerank.topN) : null,
        },
        remoteVector: {
            enabled: remoteConfig?.enabled === true,
            initialized: remoteConfig?.initialized === true,
        },
    };
    return {
        featureFlagsSnapshot: featureFlags,
        configSnapshotHash: fnv1a32Hex(JSON.stringify(safeConfig)),
        safeConfig,
    };
}

export function createRecallTrace(input: {
    charId: string;
    entryPoint?: RecallEntryPoint;
    recentMessageCount: number | null;
    hasQueryHint: boolean;
    clearedPreviousMemory: boolean;
    clearedPreviousRoomPlates: boolean;
}): RecallTrace {
    const runtime = readRecallRuntimeSnapshot();
    return {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        pipelineVersion: RECALL_PIPELINE_VERSION,
        startedAt: new Date().toISOString(),
        charId: input.charId,
        entryPoint: input.entryPoint ?? 'direct',
        featureFlagsSnapshot: runtime.featureFlagsSnapshot,
        configSnapshotHash: runtime.configSnapshotHash,
        request: {
            recentMessageCount: input.recentMessageCount,
            hasQueryHint: input.hasQueryHint,
        },
        injection: {
            clearedPreviousMemory: input.clearedPreviousMemory,
            clearedPreviousRoomPlates: input.clearedPreviousRoomPlates,
            memoryChars: 0,
            roomPlateChars: 0,
        },
        stages: [],
    };
}

export function finishRecallTrace(
    trace: RecallTrace,
    outcome: RecallOutcome,
    failureReason?: RecallFailureReason,
): RecallTrace {
    trace.outcome = outcome;
    trace.finishedAt = new Date().toISOString();
    trace.durationMs = Math.max(0, Date.parse(trace.finishedAt) - Date.parse(trace.startedAt));
    if (failureReason) trace.failureReason = failureReason;
    appendDevDebugMemoryPalaceLog({
        label: `recall:${trace.entryPoint}:${outcome}`,
        data: trace,
    });
    return trace;
}
