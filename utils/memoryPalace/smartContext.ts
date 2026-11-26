import type { CharacterProfile, Message } from '../../types';
import type { RecallTrace } from './trace';
import { isChatConversationEntry, readRecallRuntimeSnapshot, RECALL_PIPELINE_VERSION } from './trace';
import { sanitizeQuerySourceMessages } from './querySanitizer';
import { renderLocalContextGuidance } from './recallRouter';
import { renderInteractionAdaptationGuidance } from './interactionAdaptation';
import { renderDeepEngagementGuidance, type DeepEngagementAnalysis } from './deepEngagement';
import {
    renderConversationEngagementGuidance,
    shouldUseLegacyDeepEngagement,
    type ConversationEngagementAnalysis,
} from './conversationEngagement';

/** 只在本次请求内传递；不保存到角色，也不把 Trace 上传到云端。 */
export interface PreparedPalaceRecall extends Pick<CharacterProfile, 'memoryPalaceInjection' | 'roomPlatesInjection'> {
    trace?: RecallTrace;
    inputKey?: string;
}

/** 同一份可见历史、角色召回设置和查询才能复用；只保留指纹，不复制原文。 */
export function palaceRecallInputKey(
    char: CharacterProfile,
    messages: Message[],
    userName?: string,
    queryHint?: string,
): string {
    const text = JSON.stringify([
        char.id, char.name, userName || '', queryHint || '', char.memoryPalaceEnabled,
        char.personalityStyle, char.ruminationTendency, char.activeBuffs?.[0]?.name,
        char.interactionAccommodation, shouldUseLegacyDeepEngagement(),
        // 图片/表情虽不进检索文本，仍会改变用户轮次边界，不能从指纹里一起丢掉。
        messages.map(m => [m.id, m.role, m.type, m.timestamp, !!m.metadata?.proactiveHint]),
        sanitizeQuerySourceMessages(messages, char.name, userName)
            .map(m => [m.id, m.content]),
    ]);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(16);
}

export function canReusePalaceRecall(
    prepared: PreparedPalaceRecall | undefined,
    char: CharacterProfile,
    messages: Message[],
    userName?: string,
): prepared is PreparedPalaceRecall {
    if (!prepared) return false;
    const runtime = readRecallRuntimeSnapshot();
    // 兼容只带两段正文的旧内部调用；启用智能语境时必须有本轮完整分析。
    if (!prepared.trace) return !Object.values(runtime.featureFlagsSnapshot).some(Boolean);
    // 普通请求按当前用户轮分析，主动消息会回看最后一轮真实用户发言。
    // 原请求已经以角色回复/主动提示收尾时，分析范围不同，不能沿用它的无信号结果。
    const lastConversationMessage = [...messages].reverse().find(m => m.role !== 'system');
    if (lastConversationMessage && (lastConversationMessage.role !== 'user'
        || lastConversationMessage.metadata?.proactiveHint)) return false;
    return prepared.trace.charId === char.id
        && isChatConversationEntry(prepared.trace.entryPoint)
        && prepared.trace.pipelineVersion === RECALL_PIPELINE_VERSION
        && prepared.trace.configSnapshotHash === runtime.configSnapshotHash
        && prepared.inputKey === palaceRecallInputKey(char, messages, userName);
}

/** 普通消息、即时对话和主动消息使用同一套智能语境提示词。 */
export function renderSmartContextGuidance(trace: RecallTrace | undefined, proactive = false, charName = '你'): string {
    if (!trace) return '';
    let text = renderLocalContextGuidance(trace.contextAnalyzer);
    text += renderInteractionAdaptationGuidance(trace.interactionAdaptation?.analysis, charName);
    const engagement = trace.deepEngagement;
    if (engagement?.engine === 'legacy_depth') {
        text += renderDeepEngagementGuidance(engagement.analysis as DeepEngagementAnalysis | undefined);
    } else if (engagement?.engine === 'conversation_v2') {
        text += renderConversationEngagementGuidance(engagement.analysis as ConversationEngagementAnalysis | undefined, charName);
    }
    if (!text || !proactive) return text;
    return [
        '【智能语境：最近对话的分析】',
        '以下分析针对上面最近一次对话；其中“此刻”“这轮”“刚刚”均指那次对话，不是用户现在又发来了一条消息。用于理解已聊过的事情、交流节奏和未完话题，不能据此认定对方当前仍处于相同情绪或状态。',
        text,
        '【主动联系时的使用方式】',
        '结合最近对话、记忆以及之后已经发出的消息，判断这次主动联系是否值得承接之前的事。已经回应过的不再当作新问题重答，已经结束的话题不要强行重开；未知的进展保持未知，不根据记忆编造结果。这份分析不代表对方刚发了新消息，不要求对方立即接话；是否开口及这次说什么，仍以本次任务和开口规则为准。',
        '',
    ].join('\n');
}
