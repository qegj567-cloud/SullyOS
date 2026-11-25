import { resolveDialogueApi } from '../utils/characterApi';
import { resolveAuxiliaryApi } from '../utils/apiSlots';
import { createReplyRun, withReplyCancellation } from '../utils/chatReplyCancellation';

import { useState, useRef, useEffect, useSyncExternalStore, MutableRefObject } from 'react';
import { CharacterProfile, UserProfile, Message, Emoji, EmojiCategory, GroupProfile, RealtimeConfig, CharacterBuff, Amsg2ExpiredNoticeRecord, DialogueApiConfig } from '../types';
import { DB } from '../utils/db';
import { ChatPrompts } from '../utils/chatPrompts';
import { safeFetchJson, safeResponseJson } from '../utils/safeApi';
import { formatUnknownError } from '../utils/errorSelfCheck';
import type { ApiCallMeta } from '../utils/apiCallLog';
import { KeepAlive } from '../utils/keepAlive';
import { ContextBuilder } from '../utils/context';
import { ChatParser } from '../utils/chatParser';
// 思考链 / HTML / MCD / memoryPalace 注入已下沉到 chatRequestPayload；这里不再直接调用
import { useMusic, loadMusicHooks } from '../context/MusicContext';
import { processNewMessagesWithAutoArchive } from '../utils/memoryPalace/autoArchive';
import { incrementDigestRound, runCognitiveDigestion, detectPersonalityStyle } from '../utils/memoryPalace';
// evolveFlowNarrative 保留为低频深刷新备用，日常意识流由副 API 的情绪评估同轮产出（innerState 字段）
// import { evolveFlowNarrative } from '../utils/scheduleGenerator';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import type { DigestResult } from '../utils/memoryPalace';
// 麦当劳: useChatAI 现在只读 McdMiniApp 当前快照注入 system prompt + 给 LLM 一个
// UI 钩子工具 propose_cart_items。MCP 实际调用都在 McdMiniApp 组件内做, useChatAI
// 不再 import callMcdTool / normalizeMcdToolName / isMcdConfigured / 旧 prompt。
import { MCD_PROPOSE_TOOL, autoFixProposalCodesByName } from '../utils/mcdToolBridge';
// 瑞幸: 与麦当劳同构, 只读 LuckinMiniApp 快照注入 + propose_cart_items UI 钩子工具
import { LUCKIN_PROPOSE_TOOL, autoFixProposalCodesByName as autoFixLuckinProposalCodesByName, fetchOpenAIToolsForLuckin, inferCardKind as inferLuckinCardKind } from '../utils/luckinToolBridge';
import { callLuckinTool } from '../utils/luckinMcpClient';
import { callMcpTool, getMcpUseNativeTools, hasWorkerUnreachableMcpServer } from '../utils/mcpClient';
import { buildMcpOpenAITools, buildMcpRejectedToolsFallbackBody, buildMcpTextFallbackBody, extractTextFakedMcpCalls, formatMcpToolResult, MCP_CHAT_MAX_STALLED_ROUNDS, MCP_CHAT_MAX_TOOL_LOOPS, sanitizeMcpLeadInText, shouldRetryMcpWithoutTools, stripTextFakedMcpCalls, type FakedMcpCall } from '../utils/mcpToolBridge';
import { buildToolResultMessage, normalizeToolCallsForCompat, toolTurnContinuation } from '../utils/toolCallCompat';
import { toolCallFingerprint } from '../utils/agenticToolFeedback';
import { getThinkingChainSettings } from '../utils/thinkingChainPrompt';
import { buildChatRequestPayload } from '../utils/chatRequestPayload';
import { acquireChatReply, isChatReplyActive, subscribeChatReplies } from '../utils/chatReplyLock';
import { beginChatSendProgress } from '../utils/chatSendProgress';
import { prepareInboxBeforeChat } from '../utils/activeMsgRuntime';
import { hasUnansweredUserTurn, withChatContinuation } from '../utils/chatContinuation';
import { assertChatHasDialogue } from '../utils/chatRequestGuard';
import { applyAssistantPostProcessing, type XhsCaches } from '../utils/applyAssistantPostProcessing';
import {
    computeStreamPreviewBubbles,
    extractStreamingEmbeddedThinking,
    findNewStreamPreviewHandoverIds,
} from '../utils/streamPreview';
import { ActiveMsgStore } from '../utils/activeMsgStore';
import { markAmsgStateDirty, startAmsgChatPresence, stopAmsgChatPresence } from '../utils/amsgStateSync';
import { getLastRealUserMessageAt } from '../utils/amsg2ExpireGuard';
import { getLastAwayAnchorAt } from '../utils/awayMessageCore';
import { syncCloudAwayTask } from '../utils/awayMessage';
import { disarmDateLeaveReminder } from '../utils/dateLeaveReminder';
import { getPendingTasks, hasActiveAiTask, isAmsg2EnabledForChar } from '../utils/amsg2Tasks';
import { buildAmsg2NoticesText, buildAmsg2TaskContextText, collectAmsg2TaskContext, insertAmsg2TaskContextBlock } from '../utils/amsg2TaskContext';
import { resolveCharTimeZone } from '../utils/timezone';
import { announceInstantChatRoute, getInstantChatPending, hasWorkerUnreachableXhs, resolveInstantChatReadiness, sendInstantChatTurn, stageInstantChatExpiredNotices } from '../utils/amsgInstantChat';
// worker 模块的常量叶子（零运行时依赖，前端引它不带进 worker 环境）：
// 云端 fire 的总时长上限，安全网超时从它推导，worker 调预算时前端自动跟上。
import { INSTANT_TOTAL_TIMEOUT_MS } from '../worker/amsg/src/instantChat';
import { appendInstantTraceEntry } from '../utils/instantTraceLog';
import { AMSG2_TOOL_NAMES, buildAmsg2Tools, createAmsg2ToolSession, executeAmsg2ToolWithOutcome, isAmsg2GlobalReady, type Amsg2ToolOutcome } from '../utils/amsg2ToolBridge';
import { buildReplyScopeRule } from '../utils/replyScope';
import {
    AMSG2_EMPTY_REPLY_PROMPT,
    buildAmsg2WrapUpPrompt,
    createAmsg2StallTracker,
    extractToolRoundLeadIn,
    formatToolRoundHistoryContent,
    mergeToolRoundLeadIns,
} from '../utils/amsg2ToolLoop';
import { buildLimitsBrief, resolveAmsgLimits } from '../utils/amsgLimits';
import { buildToolLoopWrapUpPrompt, TOOL_LOOP_FINAL_ROUND_PROMPT } from '../utils/toolLoopFinalRound';
import { resolveDialogueLlmParams } from '../utils/dialogueLlmParams';
import { buildEmotionEvalPrompt } from '../utils/activeMsgClient';
import { AMSG_FIRE_SCHEDULE_TOOL, buildFireScheduleHowTo, extractFireScheduleTextCalls, type FireScheduleTextCall, type FireScheduleTimeOpts } from '../utils/amsgFireSchedule';
import { buildClaudeProxyCompatibilityBody, shouldRetryClaudeProxyCompatibility } from '../utils/claudeProxyCompat';
import { routeMiniAppToolCall } from '../utils/miniAppToolRoute';
import { applyEmotionEvalRaw, extractAssistantText } from '../utils/emotionApply';
import { announceChatGen, CHAT_GEN_EVENTS } from '../utils/chatGenEvents';
import {
    advanceSARModuleAfterReply,
    buildAmsgSarModuleSnapshot,
    createSARModuleEventMeta,
    createSARModuleSurfaceMeta,
    findSARTurnUserMessage,
    getSARModuleRuntimePlan,
    parseSARModuleReply,
    parseSARModuleReplyRounds,
} from '../utils/vrWorld/sarModuleRuntime';
import { parseSARUserSurfaces, selectSARUserSurfaceTargets } from '../utils/vrWorld/sarUserSurface';
import { isEmotionEvalSkipped } from '../utils/devDebug';
import {prepareHomeSecretTask,failHomeSecretTask} from '../utils/homeSecrets';
import {prepareFriendFeedEmotionTask, releaseFriendFeedEmotionTask, acknowledgeFriendFeedNotices,stageFriendFeedCloudTask} from '../utils/friendFeedEmotion';
import {prepareFriendFeedMainTask,friendFeedUserDisclosure} from '../utils/friendFeedMain';
import type {SecretNoteOriginPromise} from '../utils/secretNote';
import {
    computeContextRangeSnapshot,
    getMemoryPalaceHighWaterMarkForContext,
    loadCharacterContextRange,
} from '../utils/chatContextRange';

/**
 * 私聊请求体的基础部分（模型、采样温度、输出上限、思考参数）。取值规则住在
 * resolveDialogueLlmParams，云端定时类生成用同一份；这里只负责拼成请求体，键的顺序保持原样。
 * 温度缺省时先回退到主 apiConfig 的温度。api.baseUrl 传去掉末尾斜杠的那份。
 */
export const buildDialogueRequestBase = (input: {
    api: { baseUrl: string; model: string; temperature?: number; maxTokens?: number };
    fallbackTemperature?: number;
    messages: any[];
    stream: boolean;
    thinkingActive: boolean;
    legacyToolModeActive: boolean;
    amsg2ToolsInjected: boolean;
}): any => {
    const params = resolveDialogueLlmParams({
        api: { ...input.api, temperature: input.api.temperature ?? input.fallbackTemperature },
        thinkingActive: input.thinkingActive,
        legacyToolModeActive: input.legacyToolModeActive,
        amsg2ToolsInjected: input.amsg2ToolsInjected,
    });
    return {
        // 没填模型名时原样留空（不写成空串）。
        model: params.model || input.api.model,
        messages: input.messages,
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        max_tokens: params.maxTokens,
        stream: input.stream,
        ...params.extraBody,
    };
};

// ─── 主动消息 2.0 排程工具的两种形态（本地生成路径）───
// 跟着「原生 tools」开关走，与云端同一口径：开关开着以原生工具声明 schedule / cancel / renew；
// 开关关着（用户判断过中转拒 tools）只教 schedule 的正文协议，取消和改期不教——
// 在拒 tools 的中转上语法教多了，模型会把工具名当叙述写进正文。

/** off = 角色或全局没开 2.0；native = 本轮请求带原生排程工具；text = 本轮只教正文协议。 */
export type Amsg2ToolMode = 'off' | 'native' | 'text';

export const resolveAmsg2ToolMode = (scheduleEnabled: boolean, useNativeTools: boolean): Amsg2ToolMode =>
    !scheduleEnabled ? 'off' : useNativeTools ? 'native' : 'text';

/**
 * 排程现状块的正文：正文模式在块尾补语法说明，其余模式原样返回。
 * 最后一轮（finalRound）不允许再调用工具，语法也不教。
 */
export const amsg2TaskContextForMode = (
    text: string, mode: Amsg2ToolMode, time: FireScheduleTimeOpts, finalRound = false,
): string =>
    mode === 'text' && !finalRound ? `${text}\n${buildFireScheduleHowTo('text', time)}` : text;

/** 从一轮正文里抠出排程调用；没有调用时 rest 原样返回。 */
export const takeAmsg2TextScheduleCalls = (content: string): { calls: FireScheduleTextCall[]; rest: string } => {
    const calls = extractFireScheduleTextCalls(content);
    return { calls, rest: calls.length ? stripTextFakedMcpCalls(content, calls) : content };
};

export const stripAmsg2ScheduleSyntax = (content: string): string => takeAmsg2TextScheduleCalls(content).rest;

/**
 * 流式预览用：完整调用剥掉；还没写完的调用从工具名起截掉；末尾刚冒头、可能是工具名开头的
 * 英文片段也先扣住（下一段增量到了自然就分清了）。
 */
export const maskAmsg2ScheduleSyntaxForPreview = (text: string): string => {
    const stripped = stripAmsg2ScheduleSyntax(text);
    const open = stripped.indexOf(AMSG_FIRE_SCHEDULE_TOOL);
    if (open >= 0) return stripped.slice(0, open);
    const tail = /[a-z_]+$/.exec(stripped);
    return tail && AMSG_FIRE_SCHEDULE_TOOL.startsWith(tail[0]) ? stripped.slice(0, tail.index) : stripped;
};

/**
 * 最终正文里还剩的工具调用。正文模式下走到这里的都是最后一轮（或补救那一轮）写出来的；其余模式下
 * 工具阶段收过尾（toolPhaseClosed）时，最后一轮回复里写的 MCP 正文调用同样不再执行。两种都从显示
 * 文本里剥掉，报出个数由调用方留 trace，让这件事查得到。没收过尾的原生 / 未开 2.0 不看。
 */
export const resolveFinalScheduleText = (
    raw: string,
    mode: Amsg2ToolMode,
    mcpResolve: Map<string, any> | null,
    toolPhaseClosed = false,
): { content: string; unexecuted: number; unexecutedMcp: number } => {
    if (mode !== 'text' && !toolPhaseClosed) return { content: raw, unexecuted: 0, unexecutedMcp: 0 };
    const schedule = mode === 'text' ? takeAmsg2TextScheduleCalls(raw) : { calls: [], rest: raw };
    const mcpCalls = mcpResolve?.size ? extractTextFakedMcpCalls(schedule.rest, mcpResolve as any) : [];
    return {
        content: mcpCalls.length ? stripTextFakedMcpCalls(schedule.rest, mcpCalls) : schedule.rest,
        unexecuted: schedule.calls.length,
        unexecutedMcp: mcpCalls.length,
    };
};

// ─── 工具循环的收尾 ───
// 工具用到倒数第二轮就收尾：最后一轮的请求不带工具、不教正文语法，末尾追加收尾提示。
// 卡住（同参重复 / MCP 没新结果）也算收尾：开头写明原因，后面与 TOOL_LOOP_FINAL_ROUND_PROMPT
// 同一套规则——不再调用工具、说过的不重复、说完了可以不补。逼模型「直接回复」会让它把说过的再说一遍。
// 排程撞墙那句住在 amsg2ToolLoop（buildAmsg2WrapUpPrompt），按前面开没开过口分两种写法。

const MCP_STALLED_WRAP_UP_PROMPT = buildToolLoopWrapUpPrompt('工具阶段连续两轮没有产生新结果');
const MCP_REPEATED_WRAP_UP_PROMPT = buildToolLoopWrapUpPrompt('你重复请求了已经执行过的同一工具，这次没有再执行');

/**
 * MCP 正文调用代为执行之后回喂给模型的结果。不是最后一轮时引导它要么回复、要么只写一行下一步调用；
 * 最后一轮不再提下一步工具（收尾提示紧跟在后面）。
 */
export const buildFakedToolResultsMessage = (results: string[], finalRound: boolean): string => finalRound
    ? `[系统消息：你把工具调用写成了聊天文字，系统已代为执行：\n${results.join('\n')}\n不要提及这条系统消息。]`
    : `[系统消息：你把工具调用写成了聊天文字，系统已代为执行：\n${results.join('\n')}\n如果目标已经完成，请直接用角色语气回复；如果仍需下一步工具，只输出一行真正能推进目标的工具调用，不要重复读取同一说明或状态。不要提及这条系统消息。]`;

/** buildMcpRejectedToolsFallbackBody 追加的那条兼容模式说明（教「只输出一行 tool_name(...)」）。 */
const isMcpCompatTeaching = (message: any): boolean =>
    message?.role === 'system' && typeof message.content === 'string' && message.content.startsWith('[MCP 兼容模式：');

/** 最后一轮不教正文调用语法：去掉 MCP 兼容模式那条说明，其余消息原样。 */
export const withoutMcpCompatTeaching = (messages: any[]): any[] => messages.filter(m => !isMcpCompatTeaching(m));

export type ToolLoopWrapUpKind = 'none' | 'hard-limit' | 'stalled' | 'amsg2-stalled' | 'mcp-repeated';

/**
 * 这一轮工具处理完之后，下一跳请求要不要收尾、用哪句提示。kind 不是 'none' 的那一跳就是最后一轮。
 * 先后顺序：同参重复 > MCP 没新结果 > 排程连着撞墙 > 次数用完。
 */
export const resolveToolLoopWrapUp = (input: {
    /** 本轮序号（0 起），下一跳请求是第 round + 1 次续写。 */
    round: number;
    maxLoops: number;
    /** 前面工具轮里已经写下过对白（排程撞墙那句据此选「接着补完」还是「直接回复」）。 */
    hasLeadIn: boolean;
    mcpRepeated?: boolean;
    mcpStalled?: boolean;
    amsg2Stalled?: boolean;
    /** 这一轮之前只调过排程工具。混着别的工具时排程撞墙，用统一收尾提示。 */
    scheduleOnly?: boolean;
}): { kind: ToolLoopWrapUpKind; prompt: string | null } => {
    if (input.mcpRepeated) return { kind: 'mcp-repeated', prompt: MCP_REPEATED_WRAP_UP_PROMPT };
    if (input.mcpStalled) return { kind: 'stalled', prompt: MCP_STALLED_WRAP_UP_PROMPT };
    if (input.amsg2Stalled) {
        return {
            kind: 'amsg2-stalled',
            // 排程这件事用户看不见，照 MCP 那句「如实说明卡在哪一步」写的话，角色会跟用户交代「我的提醒排不上」。
            prompt: input.scheduleOnly ? buildAmsg2WrapUpPrompt(input.hasLeadIn) : TOOL_LOOP_FINAL_ROUND_PROMPT,
        };
    }
    if (input.round + 1 >= input.maxLoops) return { kind: 'hard-limit', prompt: TOOL_LOOP_FINAL_ROUND_PROMPT };
    return { kind: 'none', prompt: null };
};

/**
 * 跑过工具之后要不要补一轮让角色开口。只有整个循环一句正文都没有时才补：最后一轮留空、
 * 前面工具轮写过话的，前面那些就是这次的输出，不算空回、也不算失败。
 */
export const shouldRescueEmptyToolLoop = (input: {
    toolRounds: number;
    /** 工具轮里攒下 / 已落库的开场白条数。 */
    leadInCount: number;
    finalContent: string;
    finalHasToolCalls?: boolean;
}): boolean =>
    input.toolRounds > 0
    && input.leadInCount === 0
    && !extractToolRoundLeadIn(input.finalContent)
    && !input.finalHasToolCalls;

/**
 * 中转拒 tools 时的重试请求体。排程工具不进 MCP 的兼容签名清单：正文模式只认 schedule 的
 * 正文协议（由排程现状块教），把三件套混进 MCP 清单的话，取消和改期会被教出来却没人执行。
 * 只剩 MCP 工具时与 buildMcpRejectedToolsFallbackBody 完全一致。
 */
export const buildRejectedToolsFallbackBody = (body: any): any => {
    const tools = (body.tools || []).filter((tool: any) => !AMSG2_TOOL_NAMES.has(tool?.function?.name || ''));
    return tools.length
        ? buildMcpRejectedToolsFallbackBody({ ...body, tools })
        : buildMcpTextFallbackBody(body, body.messages || []);
};

// ─── 云端情绪评估的安全网定时器（模块级，按角色）───
// 为什么不放 hook 里：结论（emotionDone）是全局事件，用户切了角色、离开聊天页之后
// 照样会到，而 hook 里的监听是跟着当前挂载角色走的——单个 ref 存定时器的话，切走再回来
// 结论到了也没人清，安全网到点就弹「worker 可能是旧版，请重新部署」的假告警；给 B 布防
// 还会静默吞掉 A 的真告警。按 charId 记、模块级监听清，两个都治。
const cloudEmotionTimers = new Map<string, ReturnType<typeof setTimeout>>();
const clearCloudEmotionTimer = (charId: unknown): void => {
    if (typeof charId !== 'string') return;
    const timer = cloudEmotionTimers.get(charId);
    if (timer != null) {
        clearTimeout(timer);
        cloudEmotionTimers.delete(charId);
    }
};
if (typeof window !== 'undefined') {
    // emotionDone 是「这一轮评估有结论了」（成败都发）：flush 落结果、收尾判失败两条路
    // 都会广播。不论哪个角色、Chat 挂没挂载，结论一到就撤掉对应的安全网。
    window.addEventListener(CHAT_GEN_EVENTS.emotionDone, (e) => {
        clearCloudEmotionTimer((e as CustomEvent).detail?.charId);
    });
}

// ─── 情绪评估（副API，fire & forget）───
// 提示词与云端共用 activeMsgClient 的 buildEmotionEvalPrompt。

export async function evaluateEmotionBackground(
    charData: CharacterProfile,
    userProfile: UserProfile,
    mainSystemPrompt: string,
    apiMessages: Array<{ role: string; content: any }>,
    api: { baseUrl: string; apiKey: string; model: string; stream?: boolean },
    signal?: AbortSignal,
    secretOrigin?: SecretNoteOriginPromise,
    metaOverride?: Partial<ApiCallMeta>,
): Promise<string | null> {
    // 全局横幅「xx 正在感受…」（ChatBroadcast）。这里是所有本地评估路径的汇聚点
    // （主链路 fire & forget / OSContext 主动消息），在函数级
    // start/finally 派发一次即可全覆盖；即时对话的 worker 评估另行点灯。
    announceChatGen(CHAT_GEN_EVENTS.emotionStart, { charId: charData.id, charName: charData.name });
    let secretTask: Awaited<ReturnType<typeof prepareHomeSecretTask>> = undefined;
    let friendFeedTask: Awaited<ReturnType<typeof prepareFriendFeedEmotionTask>> = undefined;
    try {
        if (signal?.aborted) return null;
        try { if (secretOrigin) secretTask = await prepareHomeSecretTask(charData, apiMessages); }
        catch (error) {
            console.warn('[Home secrets] Could not prepare task', error);
            announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {charId: charData.id, charName: charData.name, reason: '秘密任务准备失败，本轮继续正常情绪评估'});
        }
        if (signal?.aborted) return null;
        try { friendFeedTask = await prepareFriendFeedEmotionTask(charData.id); }
        catch (error) { console.warn('[Friend feed] Could not prepare browsing task', error); }
        if (signal?.aborted) return null;
        const prompt = buildEmotionEvalPrompt(charData, userProfile, mainSystemPrompt, apiMessages, true,
            (friendFeedTask?.prompt || '') + (secretTask?.prompt || ''));

        const baseUrl = api.baseUrl.replace(/\/+$/, '');
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${api.apiKey || 'sk-none'}`
        };

        const evalBody = {
            model: api.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.85,
            // 显式给足输出额度: 部分代理不传 max_tokens 时默认很小 (1k~2k), eval 的
            // injection+innerState 很长, 会被截断成半截 JSON → buff 静默丢失.
            max_tokens: 8000,
        };
        const evalMeta: ApiCallMeta = {
            appId: 'chat',
            appName: '消息',
            charId: charData.id,
            charName: charData.name,
            purpose: '情绪评估',
            ...metaOverride,
        };
        let data: any;
        try {
            data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                method: 'POST', signal,
                headers,
                body: JSON.stringify({
                    ...evalBody,
                    // 跟随全局流式开关（响应由 safeFetchJson 透明拼装，下游 JSON 解析不变）。
                    // 好处: ①评估动辄生成 4~5k token、跑 30~46s，非流式最容易撞网关超时；
                    // ②中转若按流式/非流式分渠道池，评估与主聊天落同一池，行为可对比。
                    stream: !!api.stream,
                    ...(api.stream ? { stream_options: { include_usage: true } } : {}),
                })
            }, 2, 0, evalMeta);
        } catch (e: any) {
            if (signal?.aborted) return null;
            if (!api.stream) throw e;
            // 流式自愈: 个别中转/模型对 stream / stream_options 直接 4xx。主聊天的透明流式
            // 升级层有「用升级前原 body 重发」的回退 (OSContext), 但评估请求自带 stream:true
            // 不经过升级层, 没有这层兜底 —— 这里补上同等待遇: 非流式重发一次, 行为退回
            // 「评估跟随流式开关」(32c7be7) 之前。评估失败过去被静默吞掉, 用户只看到
            // 情绪徽章闪一下就灭、情绪永不更新 (真实反馈), 这类形状问题必须能自愈。
            console.warn('🎭 [Emotion] streamed eval failed, retrying non-stream:', e?.message);
            data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                method: 'POST', signal,
                headers,
                body: JSON.stringify({ ...evalBody, stream: false })
            }, 1, 0, evalMeta);
        }

        // 排查贩子降级路由用：把评估实际落到的后端和 token 计数打出来，
        // 和主聊天的 🔢 [Token Usage] 一对比就能看出哪个请求被挤进了备用渠道。
        console.log(`🎭 [Emotion] backend=${data?.model || '?'} | prompt=${data?.usage?.prompt_tokens ?? '?'} completion=${data?.usage?.completion_tokens ?? '?'}`);

        // content 可能是分块数组 / 空 content + reasoning_content (个别 Claude 兼容代理), 统一走兜底提取
        if (signal?.aborted) return null;
        const raw = extractAssistantText(data.choices?.[0]?.message);
        if (!raw) {
            console.warn('🎭 [Emotion] Empty eval response:', JSON.stringify({
                finish_reason: data.choices?.[0]?.finish_reason,
                has_message: !!data.choices?.[0]?.message,
            }));
            announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
                charId: charData.id, charName: charData.name,
                reason: `评估模型没有输出内容 (finish_reason: ${data.choices?.[0]?.finish_reason ?? '?'})`,
            });
            return null;
        }
        if (signal?.aborted) return null;
        const origin = secretTask ? await secretOrigin : undefined;
        if (signal?.aborted) return null;
        return await applyEmotionEvalRaw(raw, charData, secretTask?.id, origin);
    } catch (e: any) {
        if (signal?.aborted) return null;
        console.warn('🎭 [Emotion] Evaluation failed:', e.message);
        announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
            charId: charData.id, charName: charData.name,
            reason: e?.message || '请求失败',
        });
        return null;
    } finally {
        if (friendFeedTask) {
            try { await releaseFriendFeedEmotionTask(charData.id, friendFeedTask.id); }
            catch (error) { console.warn('[Friend feed] Could not release unfinished browsing task', error); }
        }
        if (secretTask) {
            try { await failHomeSecretTask(charData.id, secretTask.id); }
            catch (error) { console.warn('[Home secrets] Could not release unfinished task', error); }
        }
        announceChatGen(CHAT_GEN_EVENTS.emotionEnd, { charId: charData.id, charName: charData.name });
    }
}

interface UseChatAIProps {
    homePhoneContext?: () => string;
    char: CharacterProfile | undefined;
    userProfile: UserProfile;
    apiConfig: any;
    groups: GroupProfile[];
    emojis: Emoji[];
    categories: EmojiCategory[];
    addToast: (msg: string, type: 'info'|'success'|'error') => void;
    /** 长报错走弹窗 (toast 一行装不下), 手机用户能看清并复制反馈 */
    showError?: (title: string, details: string, endpoint?: {baseUrl:string; model:string}) => void;
    setMessages: (msgs: Message[]) => void; // Callback to update UI messages
    /** 正式消息接替流式预览前同步登记 id，避免真实气泡重新播放入场动画。 */
    onStreamPreviewHandover?: (charId: string, messageIds: number[]) => void;
    realtimeConfig: RealtimeConfig; // 实时配置（amsg2 工具排程要用，两个调用点都必传）
    translationConfig?: { enabled: boolean; sourceLang: string; targetLang: string };
    memoryPalaceConfig?: { embedding: { baseUrl: string; apiKey: string; model: string; dimensions: number }; lightLLM: DialogueApiConfig };
    /** 从 OSContext 传入，用于 palace 自动归档写 char.memories + hideBeforeMessageId */
    updateCharacter: (id: string, partial: Partial<CharacterProfile> | ((prev: CharacterProfile) => Partial<CharacterProfile>)) => void;
    updateUserProfile: (updates: Partial<UserProfile> | ((prev: UserProfile) => Partial<UserProfile>)) => void;
    /** 麦当劳小程序当前快照 (cart/menu/nutrition); open=true 时把这段实时状态追加到 system prompt 末尾, 让 char 协同选餐 */
    mcdMiniAppRef?: MutableRefObject<import('../utils/mcdToolBridge').McdMiniAppSnapshot | undefined>;
    /** 瑞幸小程序当前快照 (cart/menu); 与麦当劳同构 */
    luckinMiniAppRef?: MutableRefObject<import('../utils/luckinToolBridge').LuckinMiniAppSnapshot | undefined>;
    /** 瑞幸聊天点单模式 (点"瑞一杯"激活): 角色直接调真实 8 工具 + 注入定位/提示词 */
    luckinChatRef?: MutableRefObject<import('../utils/luckinToolBridge').LuckinChatState | undefined>;
}

export const useChatAI = ({
    char,
    userProfile,
    apiConfig,
    groups,
    emojis,
    categories,
    addToast,
    showError,
    setMessages,
    onStreamPreviewHandover,
    realtimeConfig,  // 新增
    translationConfig,
    memoryPalaceConfig,
    updateCharacter,
    updateUserProfile,
    mcdMiniAppRef,
    luckinMiniAppRef,
    luckinChatRef,
    homePhoneContext,
}: UseChatAIProps) => {
    
    // 音乐上下文 — 用于聊天时注入"user 正在听什么 + 当前歌词窗口"
    const music = useMusic();

    const [localTyping, setLocalTyping] = useState(false);
    const characterTyping = useSyncExternalStore(subscribeChatReplies, () => isChatReplyActive(char?.id), () => false);
    // 同一挂载实例仍串行使用流式预览状态；跨页面重进则读取角色的后台占位。
    const isTyping = localTyping || characterTyping;
    // 流式预览气泡：stream 开启时，已完成行与安全尾句随增量以临时气泡上屏。
    // 流结束后由 applyAssistantPostProcessing 正常落库，整轮完成才清预览 —— 只影响展示，不改持久化。
    const [streamingBubbles, setStreamingBubbles] = useState<string[]>([]);
    const [streamingThinking, setStreamingThinking] = useState('');
    // 预览仍在场时，这些已落库消息暂不上屏；每轮单独记录，避免隐藏以前的回复。
    const [streamingHandoverIds, setStreamingHandoverIds] = useState<number[]>([]);
    const [recallStatus, setRecallStatus] = useState<string>('');
    const [inboxWait, setInboxWait] = useState<{ charId: string; token: object } | null>(null);
    const inboxStatus = inboxWait && inboxWait.charId === char?.id ? '正在接收刚到的消息…' : '';
    const [searchStatus, setSearchStatus] = useState<string>('');
    const [diaryStatus, setDiaryStatus] = useState<string>('');
    const [xhsStatus, setXhsStatus] = useState<string>('');
    const [emotionStatus, setEmotionStatus] = useState<string>('');
    const [memoryPalaceStatus, setMemoryPalaceStatus] = useState<string>('');
    const [memoryPalaceResult, setMemoryPalaceResult] = useState<import('../utils/memoryPalace/pipeline').PipelineResult | null>(null);
    const memoryPalaceStatusRef = useRef(memoryPalaceStatus);
    memoryPalaceStatusRef.current = memoryPalaceStatus;

    // triggerAI 的 finally 在 AI 流式回复完后才跑记忆宫殿后台任务。
    // 闭包里捕获的 char 是 hook 调用时那一份，如果用户在流式中途把宫殿关了，
    // 这里读 char.memoryPalaceEnabled 仍然是 true，导致关掉后还会再触发一次
    // LLM 提取（+ 50 轮认知消化）。用 ref 在 finally 里读最新状态。
    const charRef = useRef(char);
    charRef.current = char;

    // beforeunload 保护：记忆宫殿后台处理中时，阻止用户意外关闭页面
    useEffect(() => {
        const handler = (e: BeforeUnloadEvent) => {
            if (memoryPalaceStatusRef.current) {
                e.preventDefault();
            }
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, []);

    const [lastDigestResult, setLastDigestResult] = useState<DigestResult | null>(null);
    const [lastTokenUsage, setLastTokenUsage] = useState<number | null>(null);
    const [tokenBreakdown, setTokenBreakdown] = useState<{ prompt: number; completion: number; total: number; msgCount: number; pass: string } | null>(null);
    const [lastSystemPrompt, setLastSystemPrompt] = useState<string>('');

    // 意识流：由副 API 的情绪评估同轮产出（innerState 字段）
    // 下一轮 system prompt 会把它作为角色的内心状态注入
    const [evolvedNarrative, setEvolvedNarrative] = useState<string>('');

    // 云端情绪评估安全网到点时判断「用户现在看的还是不是布防那个角色」用（防止过期
    // 定时器把当前角色的徽章错熄）。定时器本体在模块级 cloudEmotionTimers（按角色记）。
    const currentCharIdRef = useRef<string | null>(null);
    currentCharIdRef.current = char?.id ?? null;

    // 切换角色时重置
    useEffect(() => {
        setEvolvedNarrative('');
    }, [char?.id]);

    // ─── 云端情绪评估的回程 ───────────────────────────────────────────────────
    //
    // 即时对话的情绪评估在 worker 跑 (副 API)，结果随回复回来后 activeMsgRuntime 落 buff 并广播
    // innerState。这里只把 innerState 喂回 evolvedNarrative (下一轮 system prompt 用)，再熄灭徽章。
    useEffect(() => {
        if (!char?.id) return;
        const charIdAtMount = char.id;

        const innerStateHandler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.charId !== charIdAtMount) return;
            if (typeof detail?.innerState === 'string' && detail.innerState.trim()) {
                setEvolvedNarrative(detail.innerState.trim());
            }
        };
        window.addEventListener('emotion-innerstate-updated', innerStateHandler);

        // 上云的评估有结论了（worker 推回后由 activeMsgRuntime / 收尾判定派发）→ 熄灭 "情绪更新中".
        const emotionDoneHandler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.charId !== charIdAtMount) return;
            // 安全网定时器由模块级监听按 charId 清（切走了也清得到），这里只管当前页的徽章。
            setEmotionStatus('');
        };
        window.addEventListener(CHAT_GEN_EVENTS.emotionDone, emotionDoneHandler);

        return () => {
            window.removeEventListener('emotion-innerstate-updated', innerStateHandler);
            window.removeEventListener(CHAT_GEN_EVENTS.emotionDone, emotionDoneHandler);
        };
    }, [char?.id]);

    // 跨消息持久化的 noteId→xsecToken 缓存，避免 lastXhsNotes 局部变量每次 triggerAI 都重置
    const xsecTokenCacheRef = useRef<Map<string, string>>(new Map());
    // noteId→title 缓存，用于 detail 失败时重新搜索拿新 token
    const noteTitleCacheRef = useRef<Map<string, string>>(new Map());
    // commentId→userId 缓存，reply_comment 需要 user_id 帮助 MCP 服务端定位评论
    const commentUserIdCacheRef = useRef<Map<string, string>>(new Map());
    // commentId→authorName 缓存，reply 降级为顶级评论时用 @authorName 让回复有上下文
    const commentAuthorNameCacheRef = useRef<Map<string, string>>(new Map());
    // commentId→parentCommentId 缓存，供 reply_comment 传递 parent_comment_id（xiaohongshu-mcp PR#440+）
    const commentParentIdCacheRef = useRef<Map<string, string>>(new Map());

    const updateTokenUsage = (data: any, msgCount: number, pass: string) => {
        if (data.usage?.total_tokens) {
            setLastTokenUsage(data.usage.total_tokens);
            const breakdown = {
                prompt: data.usage.prompt_tokens || 0,
                completion: data.usage.completion_tokens || 0,
                total: data.usage.total_tokens,
                msgCount,
                pass
            };
            setTokenBreakdown(breakdown);
            console.log(`🔢 [Token Usage] pass=${pass} | prompt=${breakdown.prompt} completion=${breakdown.completion} total=${breakdown.total} | msgs_in_context=${msgCount}`);
        }
    };

    const triggerAI = async (
        currentMsgs: Message[],
        overrideApiConfig?: { baseUrl: string; apiKey: string; model: string },
        opts?: { skipEmotionInjection?: boolean },
    ) => {
        if (isTyping || !char) return;
        const effectiveApi = resolveDialogueApi(apiConfig, char, overrideApiConfig);
        if (!effectiveApi.baseUrl) { alert("请先在设置中配置 API URL"); return; }

        // 重 roll（回溯重生）时不带入上一轮的情绪余波：清掉 buff 注入（buffInjection/activeBuffs）和
        // 意识流（innerState/evolvedNarrative），让主回复与情绪评估两边都从干净状态独立重新生成——
        // 否则上一次生成留下的情绪 buff 与内心独白会被原样再注入，两次 roll 受同一情绪底色裹挟，失去独立性。
        // charForGen 只是本地浅拷贝（清空 buff 字段），不落 DB，不影响角色持久化的情绪状态——
        // 紧接着重跑的情绪评估会基于新回复覆写出新的 buff/innerState。
        const skipEmotionInjection = !!opts?.skipEmotionInjection;
        const charForGen: CharacterProfile = skipEmotionInjection
            ? { ...char, buffInjection: '', activeBuffs: [] }
            : char;
        // 一轮开始时冻结模块快照：API 飞行期间的 UI 更新不能改变这一轮要不要污染、
        // 也不能让成功结算时多扣/少扣。重掷仍使用效果，但成功后不再次扣回合。
        const sarModulePlan = getSARModuleRuntimePlan(charForGen, userProfile);

        // 工具会话累加本轮新任务；finally 打脏时也要读这一份最新配置。
        const amsg2Session = createAmsg2ToolSession({
            char, userProfile, groups, realtimeConfig, apiConfig, updateCharacter,
        });
        const releaseReply = acquireChatReply(char.id);
        if (!releaseReply) return;
        const replyRun = createReplyRun(char.id);
        const sendAnchor = currentMsgs.at(-1);
        const sendProgress = beginChatSendProgress(char.id,
            sendAnchor?.role === 'user' && typeof sendAnchor.id === 'number' ? sendAnchor.id : null);
        const cancelSendProgress = () => sendProgress.cancelled();
        replyRun.signal.addEventListener('abort', cancelSendProgress, { once: true });
        amsg2Session.signal = replyRun.signal;
        const replyStep = <T>(operation: () => Promise<T>) => withReplyCancellation(replyRun, operation);
        setLocalTyping(true);
        setStreamingBubbles([]);
        setStreamingThinking('');
        setStreamingHandoverIds([]);
        setRecallStatus('');
        // 全局横幅「xx 正在回应…」（ChatBroadcast）。Chat 卸载后，生成占位和这个异步
        // 闭包都会保留并继续落库——横幅靠 window 事件与组件生命周期
        // 解耦，用户切走 Chat 也能看到生成还活着。finally 里派发 end（两条路径都经过）。
        announceChatGen(CHAT_GEN_EVENTS.replyStart, { charId: char.id, charName: char.name });

        // 本轮里角色自己新排出来的任务。排程现状块每轮现算时靠它把这些点名标出来——不标
        // 的话角色分不清清单上哪条是自己刚排的，回头又排一条一模一样的。
        const amsg2CreatedThisTurn = new Set<string>();
        // 工具循环里，模型在调工具的同一轮顺手写下的回话。收尾时跟最后一轮的正文拼成一条
        // （见 utils/amsg2ToolLoop），不然「话写在工具轮、最后一轮空着」就是空回；同时记下
        // 最近一次真正写出对白的响应，供续写轮留空结束时保留对应心象。
        const amsg2LeadIns: string[] = [];
        let lastSpokenData: any = null;
        // 这一轮走的是即时对话、并且云端已经受理：收尾时不要再打脏重传一次 fire_pack。
        // POST 上去的那份就是权威的（还多带了 chat 段），再传一遍是同样内容白走一趟网络。
        let instantChatAccepted = false;
        let friendFeedMainTask: Awaited<ReturnType<typeof prepareFriendFeedMainTask>>;
        // amsg2 工具在三个工具循环（麦当劳 / 瑞幸 / 通用）里都可能出现，执行方式完全一样，
        // 只有各自的 loopMessages 不同。正文协议的排程也走这同一个执行器（同名同参去重、
        // 连发上限都在执行器里判），只是结果不以 tool 消息回喂。
        const executeAmsg2Call = async (
            fname: string, args: any, round: number,
        ): Promise<{ text: string; finalRoundText: string; outcome: Amsg2ToolOutcome }> => {
            replyRun.check();
            setSearchStatus(`正在执行：${fname}...`);
            const taskUuidsBefore = new Set(
                (amsg2Session.getConfig()?.tasks ?? []).map((t) => t.taskUuid),
            );
            const { text: result, finalRoundText, outcome } = await replyStep(() => executeAmsg2ToolWithOutcome(fname, args, amsg2Session));
            // 本地这条路的每次排程都留一条 trace（调试面板 → amsg2 观察窗能看、能导出）：
            // 打回全在浏览器里判，请求到不了 worker，不记这一笔的话事后什么都查不到。
            // 只记工具名和结局枚举，不带参数和聊天内容。
            appendInstantTraceEntry({
                ts: new Date().toISOString(),
                event: 'amsg2-local-tool',
                charId: char.id,
                round,
                ...outcome,
            });
            // 新增了哪几条不看工具回话（那是给模型读的散文），直接比对清单前后差异——
            // schedule 与 renew 都走这里，补发/替换出来的新任务一并算进去。
            for (const task of amsg2Session.getConfig()?.tasks ?? []) {
                if (!taskUuidsBefore.has(task.taskUuid)) amsg2CreatedThisTurn.add(task.taskUuid);
            }
            setSearchStatus('');
            return { text: result, finalRoundText, outcome };
        };
        /**
         * 本轮已经回喂给模型的排程结果。下一跳如果是最后一轮（不再给工具），换成执行器给的最后一轮
         * 版本，免得结果里那句「还需要别的工具时再调用」跟收尾提示打架。下一跳是不是最后一轮要等
         * 这一轮工具全跑完才知道（卡住要看结局），所以先按普通版本回喂、记下来，定了再换。
         */
        const amsg2RoundResults: Array<{ message: any; finalMessage: any }> = [];
        const switchAmsg2ResultsToFinalRound = (): void => {
            for (const { message, finalMessage } of amsg2RoundResults) Object.assign(message, finalMessage);
            amsg2RoundResults.length = 0;
        };
        const runAmsg2ToolCall = async (
            tc: any, fname: string, args: any, loopMessages: any[], round: number,
        ): Promise<Amsg2ToolOutcome> => {
            const { text: result, finalRoundText, outcome } = await executeAmsg2Call(fname, args, round);
            // 带上 name：Gemini 兼容层要求工具结果的 name 非空，缺了会被判 INVALID_ARGUMENT。
            const message = buildToolResultMessage(tc, result) as any;
            loopMessages.push(message);
            amsg2RoundResults.push({ message, finalMessage: buildToolResultMessage(tc, finalRoundText) });
            return outcome;
        };

        try {
            // Include SW readiness in send→API timing; it can be the first request's wait.
            const perfSendT0 = performance.now();
            // 初始化失败也必须经过 finally 释放本轮占位。
            await replyStep(async () => KeepAlive.start());
            const keepAliveMs = Math.round(performance.now() - perfSendT0);
            const baseUrl = effectiveApi.baseUrl.replace(/\/+$/, '');
            const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApi.apiKey || 'sk-none'}` };

            // ── 分段计时（从用户发送到 API 发出）──
            const perfStages: Record<string, number> = { keepAlive: keepAliveMs };
            const stageT = async <T>(label: string, p: Promise<T>): Promise<T> => {
                const t0 = performance.now();
                try { return await replyStep(async () => p); }
                finally { perfStages[label] = Math.round(performance.now() - t0); }
            };

            // 用户消息已经显示。先接收本机已到消息，再读历史；正常处理不闪提示，
            // 真等起来再说明原因。最多等 30 秒，超时后原收件管线继续，不等待重试周期。
            const inboxWaitToken = {};
            const inboxHintTimer = setTimeout(() => setInboxWait({ charId: char.id, token: inboxWaitToken }), 300);
            try {
                const received = await replyStep(async () => stageT('inbox', prepareInboxBeforeChat(char.id)));
                // stalled 不再提示：同一趟收件已经在上一次生成时提示过了。
                if (received === 'pending' || received === 'timeout') addToast('消息接收较慢，先继续回复，收到后会自动补上', 'info');
            } finally {
                clearTimeout(inboxHintTimer);
                setInboxWait(previous => previous?.token === inboxWaitToken ? null : previous);
            }

            // 0.9 历史消息加载：最大范围与记忆宫殿水位线彻底解耦。
            // adaptive 从 HWM 之后开始；manual 忽略 HWM 读取最近 N 条完整原文；
            // 用户断点只可在最大范围内继续收窄，越界后自动失效。
            const contextRange = char.id
                ? await replyStep(async () => stageT('dbHistory', loadCharacterContextRange(char).catch(e => {
                    console.error('Failed to load context range from DB, using React state:', e);
                    // 即便 DB 读取失败，降级路径也必须继续遵守水位线/拉杆硬上限，不能把 React
                    // 缓存里的更早消息意外送回模型。
                    return computeContextRangeSnapshot(
                        currentMsgs,
                        char,
                        getMemoryPalaceHighWaterMarkForContext(char.id),
                    );
                })))
                : null;
            if (contextRange?.userBreakpointExpired && updateCharacter) {
                updateCharacter(char.id, { contextUserStartMessageId: undefined });
            }
            const fullHistory = contextRange?.messages || null;
            const contextMsgs = fullHistory || currentMsgs;
            // 离开后消息（云端）：按最近一次在场互动（用户发言或线下见面/通话记录）把任务往后推。不等它，失败只影响这一条。
            const awayLastUserAt = getLastAwayAnchorAt(contextMsgs);
            if (char.awayMessage?.enabled && awayLastUserAt != null) {
                void syncCloudAwayTask({
                    char, lastUserAt: awayLastUserAt, userProfile, groups, realtimeConfig, apiConfig, updateCharacter,
                });
            }
            // 见面离开提醒：走开后在私聊里跟 TA 说上话了，这次离开就结束了。没有待发的提醒时不发请求。
            void disarmDateLeaveReminder({ char, updateCharacter });
            // 空范围先报可操作的本地错误，避免继续识图/召回和发送 system-only 请求。
            // 原始消息可能是无文字图片或卡片，此处只判角色；正文有效性在格式化后校验。
            assertChatHasDialogue(contextMsgs.map(message => ({
                role: message.role,
                content: 'pending-format',
            })));
            const limit = Math.max(1, contextMsgs.length);
            if (fullHistory) {
                console.log(`📊 [Context] Loaded ${fullHistory.length} msgs from DB (React state had ${currentMsgs.length}, mode=${contextRange?.mode}, maxStart=${contextRange?.maxRangeStartMessageId ?? 'none'}, effectiveStart=${contextRange?.effectiveStartMessageId ?? 'none'})`);
            }

            // 1. 构造完整 chat 请求载荷（memoryPalace 召回 + system prompt + 双语 / HTML / 思考链 / MCD + 历史）
            //    — 主动消息和 emotion eval 走的是同一个 helper，保证三家拿到的"材料"完全一致。
            const mcdMiniSnap = mcdMiniAppRef?.current;
            const mcdMiniOpen = !!mcdMiniSnap?.open;
            const mcdInheritMeta = mcdMiniOpen ? { fromMcdMiniApp: true } : undefined;
            const luckinMiniSnap = luckinMiniAppRef?.current;
            const luckinMiniOpen = !!luckinMiniSnap?.open;

            // ─── 即时对话的路由在构建 payload 之前就定下来 ───
            // 走云端的那份 prompt 不烤前端时效段（时钟/节日/天气/热搜/MCP 说明由 worker
            // fire 时独家供给），本地那份照旧全量。判定材料和下面的 payload.flags 同源：
            // luckinChatActive / mcdActive / luckinActive 就是由这三个值算出来的
            // （skipPromptBuild 那个 dev 开关下 flags 会整片置 false，那时只有这边的 ref 是准的）。
            const luckinChatOn = !!luckinChatRef?.current?.active;
            // 本机 / 内网的 MCP 服务器（docs/mcp-client.md 教用户填的 http://localhost:18061
            // 就是这一类）：上云那一轮前端不注入 MCP 说明块，而 worker 从 CF 那头连不上这类
            // 地址、上云清单里压根没有它——两边都不说，角色这一轮彻底不知道自己有工具。
            // 判据就一句话：这一轮上云会让角色掉能力，那就别上云。留在本地跑，工具照常用。
            // （地址够得着的服务器不受影响，照常上云，worker 自己跑后台 MCP。）
            const mcpWorkerUnreachable = hasWorkerUnreachableMcpServer(char.id);
            // 小红书同理：服务器多半跑在用户自己电脑上，上云的工具配置会把够不着的去掉。
            const xhsWorkerUnreachable = hasWorkerUnreachableXhs(char, realtimeConfig);
            // 带上 char：角色单独关了即时对话（reason char-disabled）时 ready 直接为
            // false，和「全局没开」同一待遇——下面那条 veto trace 的条件够不到它，
            // 静默走本地。那是用户的主动选择，每条消息刷一遍 warn 就成骚扰了。
            //
            // SAR 模块生效期的回复是 <SAR_MODULE_OUTPUT> 信封，要由 worker 在分段之前拆开。
            // 旧 bundle 不认信封，会把它当普通正文切成一串气泡、控制标签直接上屏，比留在本地跑
            // 糟得多。所以这类回合要求确认那台 Worker 是当前 bundle：存量为空（老用户刚更新 App、
            // 握手探测还没回来）就当场探一次（带 3 秒超时），探到旧版 → outdated，探不到 →
            // unverified，两种都留在本地跑。只剩恢复期提示（afterglow）的回合不需要信封，
            // 任何 Worker 都跑得了，不探也不拦。
            const instantChatReadiness = await replyStep(async () => resolveInstantChatReadiness(char, {
                ensureBundleVersion: sarModulePlan.requiresEnvelope,
            }));
            const instantChatOn = instantChatReadiness.ready;
            // 只在 ready 时判：没 ready 的那几档（含 config-unreadable）各有自己的收场，
            // 这里再挂一个否决会把「配置读不出来就明确报错」那档错判成「本来就不走即时对话」。
            const sarWorkerVeto: string | null = !instantChatOn || !sarModulePlan.requiresEnvelope ? null
                : instantChatReadiness.workerBundleCurrent === false ? 'sar-module-worker-outdated'
                    : instantChatReadiness.workerBundleCurrent === undefined ? 'sar-module-worker-unverified'
                        : null;
            const instantChatVeto: string | null = sarWorkerVeto
                ?? (luckinChatOn ? 'luckin-chat'
                : mcdMiniOpen ? 'mcd'
                    : luckinMiniOpen ? 'luckin'
                        : mcpWorkerUnreachable ? 'mcp-worker-unreachable'
                            : xhsWorkerUnreachable ? 'xhs-worker-unreachable' : null);
            const instantChatRoute = instantChatOn && !instantChatVeto;
            // 「即时对话开着、这一轮却没上云」的所有情形都在这一处留痕，都是留在本地跑：
            //   · SAR 模块生效期、但没能确认那台 Worker 是当前 bundle（探到旧版 / 没探到）：
            //     旧 bundle 拆不了回复信封（恢复期回合照常上云，见上面那段）；
            //   · 点单流程否决：瑞幸/麦当劳是客户端交互式循环（选城市、确认单），云端接不了
            //     手，这一轮留在本地跑是对的；
            //   · MCP / 小红书地址 worker 够不着：同上，留在本地才有工具（见上面那段）。
            // 几个原因同时成立时报最前面那个——越靠前越具体，也更可能是用户真正想问的。
            // 不留痕的话，用户看到的是「开关亮着、消息照常出来」，查无可查——静默分流那个坑
            // 就是这么来的。这里只报不拦：拦不拦已经由 instantChatRoute 说了算。
            if (instantChatOn && !instantChatRoute) {
                const skipReason = instantChatVeto;
                console.warn(
                    skipReason === 'sar-module-worker-outdated'
                        ? '[AmsgInstantChat] 这一轮没上云（SAR 模块生效中，那台 Worker 还是旧 bundle、拆不了模块的回复信封），本地生成。去设置页点「更新 Worker」'
                        : skipReason === 'sar-module-worker-unverified'
                        ? '[AmsgInstantChat] 这一轮没上云（SAR 模块生效中，没问到那台 Worker 的版本、确认不了它认得模块的回复信封），本地生成。连上云端探到版本后会自己回到云端'
                        : skipReason === 'mcp-worker-unreachable'
                        ? '[AmsgInstantChat] 这一轮没上云（有 MCP 服务器填的是本机/内网地址，worker 够不着），本地生成，工具照常可用'
                        : skipReason === 'xhs-worker-unreachable'
                        ? '[AmsgInstantChat] 这一轮没上云（小红书服务器填的是本机/内网地址，worker 够不着），本地生成，小红书照常可用'
                        : `[AmsgInstantChat] 这一轮没上云（${skipReason} 点单流程需要客户端交互），本地生成`,
                );
                appendInstantTraceEntry({
                    ts: new Date().toISOString(),
                    event: 'instant-chat-veto',
                    charId: char.id,
                    reason: skipReason,
                });
            } else if (instantChatReadiness.reason === 'worker-outdated' || instantChatReadiness.reason === 'worker-unreachable') {
                // 用户把开关开着，是我们判定这一轮上不了云才让位给本地生成的
                // （见 resolveInstantChatReadiness 的同名门）。上面那条 trace 的条件
                // （instantChatOn）在这里天然为假，所以单独留一条：这一档比别的更需要
                // 查得到——用户的主观意愿是「上云」，实际走的却是本地，不留痕就又是一次
                // 静默分流。拦不拦不用这里管，readiness 已经说了 not ready，
                // 下面照常走本地生成那条路。
                //
                // 两档分开记：worker-outdated 是「问到了、那台 Worker 确实跑不动」（该去更新），
                // worker-unreachable 是「这一刻够不着云端」（多半是网络，会自己好）。
                appendInstantTraceEntry({
                    ts: new Date().toISOString(),
                    event: instantChatReadiness.reason === 'worker-outdated'
                        ? 'instant-chat-worker-outdated'
                        : 'instant-chat-worker-unreachable',
                    charId: char.id,
                });
            } else if (instantChatReadiness.reason === 'config-unreadable') {
                // 配置根本没读出来（IndexedDB 被别的标签页 versionchange 卡住 / iOS 存储压力）。
                // 这不是「用户没开」：开关很可能开着，只是这一刻问不到。上面那条 trace 的条件
                // （instantChatOn）在这里天然为假，所以单独留一条，别让这种情形在观察窗里查无此事。
                // 点单流程否决时例外：配置就算读出来了这一轮也轮不到即时对话（去向由 veto 决定），
                // 照原路走本就是对的，只留痕不拦。
                const configUnreadableFailsTurn = !instantChatVeto;
                appendInstantTraceEntry({
                    ts: new Date().toISOString(),
                    event: 'instant-chat-config-unreadable',
                    charId: char.id,
                    outcome: configUnreadableFailsTurn ? 'turn-failed' : 'other-route',
                });
                if (configUnreadableFailsTurn) {
                    // 悄悄退回本地直连生成的话：用户按「发完就自由」的心智随手锁屏，本地 fetch
                    // 被系统掐掉，回来时既没有回复也没有报错，设置页还写着「已开启」。所以和下面
                    // sendInstantChatTurn 没发出去同一口径：明确落系统消息 + 弹错，这一轮不发起
                    // 本地生成，用户稍后重发即可。**绝不静默退回本地生成**。收尾交给 finally
                    // （熄 isTyping / 停 KeepAlive），和那条失败路径同一段。
                    const reason = '即时对话暂时出了点问题：本地配置这一刻读不出来（可能是存储正忙）。这条没有发出去，稍等几秒重新发一次就好。';
                    console.warn('[AmsgInstantChat] 全局配置读不出来，开没开都不知道：这一轮明确报错等重发，不悄悄退回本地生成');
                    await replyStep(async () => replyRun.saveMessage({ charId: char.id, role: 'system', type: 'text', content: `[${reason}]` }));
                    setMessages(await replyStep(async () => DB.getRecentMessagesByCharId(char.id, 200)));
                    if (showError) showError('即时对话发送失败', reason);
                    else addToast(reason, 'error');
                    return;
                }
                console.warn('[AmsgInstantChat] 全局配置读不出来（开没开都不知道），但这一轮本就不走即时对话，照原路继续');
            }

            // 这一轮到底走了哪条路，播给输入框上方那条小提示。**每轮都发**，包括走成了云端
            // 那一轮（reason=null，提示自己收起来）——只在出问题时发的话，用户会一直盯着一条
            // 早就过期的提示，猜不出来「现在到底恢复了没有」。
            // 否决原因也一并播出去：提示条自己按名单挑「用户想上云、实际没上」的那几档显示
            // （SAR 遇上旧 Worker / 版本没探到），点单流程这类本该留在本地的不在名单里、照旧不出声。
            announceInstantChatRoute({
                charId: char.id,
                reason: instantChatRoute ? null : (instantChatReadiness.reason ?? instantChatVeto),
            });
            if (!instantChatRoute) sendProgress.local(!!instantChatVeto || !['disabled', 'char-disabled'].includes(instantChatReadiness.reason ?? ''));

            const payload = await replyStep(async () => stageT('payload', buildChatRequestPayload({
                char: charForGen, userProfile, groups, emojis, categories,
                homePhoneContext:homePhoneContext?.(),
                historyMsgs: contextMsgs,
                recentMsgsHint: currentMsgs,
                contextLimit: limit,
                contextHighWaterMark: contextRange?.hwm,
                realtimeConfig,
                innerState: skipEmotionInjection ? '' : undefined,
                musicSnapshot: music,
                translationConfig,
                htmlMode: { enabled: !!(char as any).htmlModeEnabled, customPrompt: (char as any).htmlModeCustomPrompt },
                thinkingChain: getThinkingChainSettings(char, userProfile),
                visionApiConfig: apiConfig.visionApi,
                mcdMiniSnap: mcdMiniOpen ? mcdMiniSnap : undefined,
                luckinMiniSnap: luckinMiniOpen ? luckinMiniSnap : undefined,
                luckinChat: luckinChatOn ? luckinChatRef?.current : undefined,
                timelyByWorker: instantChatRoute,
                recallEntryPoint: 'chat_app',
                onPreparationStage:event=>{if(event.status==='end')perfStages['payload.'+event.stage]=event.ms;},
            })));
            const systemPrompt = payload.systemPrompt;
            const cleanedApiMessages = payload.cleanedApiMessages;
            // 在续说补丁和本地/即时对话分流前检查最终历史，不能用补出来的 user 掩盖空上下文。
            assertChatHasDialogue(payload.fullMessages);
            const fullMessages = payload.flags.promptBuildSkipped
                ? payload.fullMessages
                : withChatContinuation(payload.fullMessages, userProfile.name, {
                    // 生成前收进来的主动消息落在用户刚发的那句之后：该回的是用户那句。
                    unansweredUserTurn: hasUnansweredUserTurn(currentMsgs, contextMsgs),
                });
            const promptBuildSkipped = payload.flags.promptBuildSkipped;
            if (!promptBuildSkipped) {
                try {
                    friendFeedMainTask = await prepareFriendFeedMainTask(char.id,friendFeedUserDisclosure(contextMsgs));
                    if (friendFeedMainTask) fullMessages.splice(Math.max(1, payload.volatileTailIndex), 0,
                        {role: 'system', content: friendFeedMainTask.prompt});
                } catch (error) {console.warn('[Friend feed] Main task preparation failed', error);}
            }
            if (payload.flags.mcdActive) {
                console.log(`🍔 [MCD-MiniApp] 注入协同点餐上下文 step=${mcdMiniSnap?.step} cartItems=${mcdMiniSnap?.cart?.length || 0} menuItems=${mcdMiniSnap?.menuMeals ? Object.keys(mcdMiniSnap.menuMeals).length : 0} nutrition=${mcdMiniSnap?.nutritionData ? mcdMiniSnap.nutritionData.length : 0}字`);
            }
            if (payload.flags.luckinActive) {
                console.log(`☕ [Luckin-MiniApp] 注入协同点单上下文 step=${luckinMiniSnap?.step} cartItems=${luckinMiniSnap?.cart?.length || 0} menuItems=${luckinMiniSnap?.menuItems ? Object.keys(luckinMiniSnap.menuItems).length : 0}`);
            }
            const bilingualActive = payload.flags.bilingualActive;

            // Debug: Log context composition
            const systemPromptLength = systemPrompt.length;
            const historyMsgCount = cleanedApiMessages.length;
            const historyTotalChars = cleanedApiMessages.reduce((sum: number, m: any) => sum + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
            console.log(`📊 [Context Debug] system_prompt_chars=${systemPromptLength} | history_msgs=${historyMsgCount} | history_chars=${historyTotalChars} | total_msgs_in_array=${fullMessages.length} | contextLimit=${limit}`);

            // Save for dev debug viewer
            setLastSystemPrompt(systemPrompt);

            // 3. 情绪评估 (副 API). 直接复用已 build 好的 systemPrompt 和 cleanedApiMessages，确保情绪
            //    评估和主 API 看到的上下文完全一致；同时产出 innerState（意识流），注入下一轮 system prompt。
            //    未单独配置情绪 API 时回退到主 apiConfig。
            //    ── 路径分叉 ──
            //    - 本地 fetch 模式: 客户端 fire-and-forget 跑 eval (前端活着).
            //    - 即时对话: 不在客户端跑, 改把 eval prompt + 副 API 凭据一起交给 worker, worker 跑完
            //      把结果推回来, 客户端 flush 时落 buff —— 这样前端被杀也算数, 且不会跟客户端 eval
            //      双跑双扣费. 见下方即时对话分支 + activeMsgRuntime.
            //    走哪条跟着 instantChatRoute（构建 payload 前冻结的同一回合终值）走，这里绝不自己
            //    再判一次，否则可能「按上云把评估打包走了，实际却走本地」，情绪底色悄悄停更。
            const emotionEvalEnabled = !!(!promptBuildSkipped && !isEmotionEvalSkipped() && isScheduleFeatureOn(char) && char.emotionConfig?.enabled);
            // 统一从全局 emotionApi → 角色旧镜像 → 主对话 API 解析（支持预设 ID 实时联动与 Anthropic 原生接口）
            const resolvedEmotionSlot = emotionEvalEnabled
                ? resolveAuxiliaryApi(apiConfig.emotionApi ?? char.emotionConfig?.api, apiConfig)
                : null;
            const emotionApi = resolvedEmotionSlot?.baseUrl
                ? {
                    baseUrl: resolvedEmotionSlot.baseUrl,
                    apiKey: resolvedEmotionSlot.apiKey || '',
                    model: resolvedEmotionSlot.model,
                    apiType: resolvedEmotionSlot.apiType,
                    stream: !!(resolvedEmotionSlot.stream ?? apiConfig.stream ?? false),
                }
                : null;
            // 本地路径的情绪评估：主 fetch 发出后立即发射（见下方调用点）。
            // 历史备注：曾为串行中转做过 1.5s 错峰（评估抢跑会把主回复压后一个评估时长），
            // 用户侧已排查确认当前渠道无该并发问题，2026-07 应用户要求取消延迟。
            // 上云模式不受影响：worker 那边自己安排评估的时机。
            const fireLocalEmotionEval = (emotionEvalEnabled && !instantChatRoute && emotionApi) ? () => {
                setEmotionStatus('evaluating');
                evaluateEmotionBackground(charForGen, userProfile, systemPrompt, cleanedApiMessages, emotionApi, replyRun.signal,
                    replyRun.secretSourceIds.then(ids => ids.length ? {source: 'chat' as const, messageIds: ids} : undefined))
                    .then((innerState) => {
                        if (innerState) setEvolvedNarrative(innerState);
                    })
                    .finally(() => {
                        setEmotionStatus('');
                    });
            } : null;
            // 交给云端跑的那份评估配置（提示词模板 + 副 API 凭据），即时对话把它放进任务
            // metadata.amsgEmotionEval（那份走加密信封）。
            // Cloud callbacks cannot prove ownership of every local reply bubble yet.
            // Do not generate unowned secrets; ordinary cloud emotion evaluation continues.
            let cloudFriendFeedTask: Awaited<ReturnType<typeof prepareFriendFeedEmotionTask>>;
            if (emotionEvalEnabled && instantChatRoute && emotionApi) {
                try { cloudFriendFeedTask = await prepareFriendFeedEmotionTask(charForGen.id); }
                catch (error) { console.warn('[Friend feed] Could not prepare cloud browsing task', error); }
            }
            const cloudEmotionEval = (emotionEvalEnabled && instantChatRoute && emotionApi)
                ? {
                    // includeContext=false: 不嵌 system prompt + 对话历史 (worker 复用本次请求的 messages 作前文),
                    // 把 emotionEval 块压到最小, 不把上下文在请求体里重复一份.
                    prompt: buildEmotionEvalPrompt(
                        charForGen, userProfile, systemPrompt, cleanedApiMessages, false, cloudFriendFeedTask?.prompt
                    ),
                    homeSecretRequestId: undefined,
                    api: { baseUrl: emotionApi.baseUrl, apiKey: emotionApi.apiKey, model: emotionApi.model },
                }
                : undefined;

            // 上云的情绪评估在 worker 跑 (副 API), 客户端看不到 LLM 调用时机, 但仍要给用户一个
            // "情绪更新中" 的可见信号 (header 徽章, 跟本地模式一致), 否则 "发送中" 消失后一片空白像死了.
            //
            // 正常的熄灭信号只有一个: worker 把结论推回来之后派发的 CHAT_GEN_EVENTS.emotionDone
            // (Chat 页的徽章和全局横幅各自监听, 都不依赖本 hook 存活 —— 用户切走 Chat 也能正常熄灭).
            // 剩下两种情况自己收场: 这一轮压根没发出去 —— 下面的失败分支当场调
            // extinguishCloudEmotionBadge; 结论永远没回来 (worker 被杀 / 推送丢了 / 用户部署的是旧版)
            // —— 徽章的 setTimeout 和横幅的 TTL 同时到点, 两边用的是同一个数.
            //
            // 这个数按 worker 最长能跑多久给：worker 那条 fire 的总时长上限是 INSTANT_TOTAL_TIMEOUT_MS
            // （工具循环也算在内），评估结果又是跟着主回复的最后一条推送回来的——直接从 worker 模块
            // import 那个数 + 一分钟推送在途余量，worker 侧调预算时这里自动跟上
            // （ChatBroadcast 的横幅 TTL 同样从它推导，见那边注释）。
            const cloudEvalTimeoutMs = INSTANT_TOTAL_TIMEOUT_MS + 60_000;
            /**
             * 熄灭「情绪更新中」的三件套：撤掉安全网、灭页内徽章、灭全局横幅。
             *
             * 这一轮没发出去时失败分支要调它 —— 云端根本不会跑评估，那个正常的熄灭信号
             * 永远不会来。少调一处的表现是：徽章亮着直到安全网到点，然后弹一句
             * 「worker 可能是旧版」的提示，而真实原因是这条消息压根没发出去。
             */
            const extinguishCloudEmotionBadge = () => {
                clearCloudEmotionTimer(char.id);
                setEmotionStatus('');
                announceChatGen(CHAT_GEN_EVENTS.emotionEnd, { charId: char.id, charName: char.name });
            };
            if (cloudEmotionEval) {
                setEmotionStatus('evaluating');
                // 横幅这一条的存活上限跟徽章同一个数：不带的话横幅按自己那档默认值（本地评估的
                // 量级）扫，即时对话会出现「横幅先没了、徽章还亮着」，看着像出了两次故障。
                announceChatGen(CHAT_GEN_EVENTS.emotionStart, {
                    charId: char.id, charName: char.name, ttlMs: cloudEvalTimeoutMs,
                });
                // 布防按 charId 记进模块级 map。到点先看这一轮死没死透：即时对话的待收
                // 记录还在 = 云端还没给结论（worker 的 2/4/6 分钟重试梯子完全可能把合法
                // 回复拖过这个点）——这不是「无回音」，安静续期一小段再看，别抢在状态机
                // 前面宣判、把一个好端端的 worker 说成旧版让用户白重部署。待收记录没了
                // 而结论（emotionDone）一直没来，才是真的「跑完了但没人回音」。
                const charIdAtArm = char.id;
                const charNameAtArm = char.name;
                const armCloudEmotionSafetyNet = (delayMs: number) => {
                    clearCloudEmotionTimer(charIdAtArm);
                    cloudEmotionTimers.set(charIdAtArm, setTimeout(() => {
                        cloudEmotionTimers.delete(charIdAtArm);
                        if (getInstantChatPending(charIdAtArm)) {
                            armCloudEmotionSafetyNet(60_000);
                            return;
                        }
                        // 徽章只熄「布防那个角色」的：用户已切到别的角色时，这个 setter
                        // 管的是人家的徽章，不能碰。
                        if (currentCharIdRef.current === charIdAtArm) setEmotionStatus('');
                        // 超时无回音最常见的原因是用户部署的 worker 版本过旧（不支持情绪评估、
                        // 压根不会推结果回来），其次是 worker 被杀/推送丢失。过去这里
                        // 静默熄灯, 用户只看到「情绪永远不更新」—— 给一条可操作的提示。
                        announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
                            charId: charIdAtArm, charName: charNameAtArm,
                            reason: '云端情绪评估超时无回音——worker 可能是旧版（不支持情绪评估），请去「设置 → 主动消息 2.0」点一下「更新 Worker」后重试',
                        });
                    }, delayMs));
                };
                armCloudEmotionSafetyNet(cloudEvalTimeoutMs);
            }

            // 发送前汇总计时
            const perfPreApi = Math.round(performance.now() - perfSendT0);
            const stageStr = Object.entries(perfStages)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `${k}=${v}ms`)
                .join(' ');
            console.log(`⏱ [send→API] pre-API=${perfPreApi}ms | ${stageStr}`);

            // 3. API Call (safe parsing: prevents "Unexpected token <" on HTML error pages)
            // 温度 / 流式：优先读 effectiveApi（用户在设置里保存的值或预设值），
            // 缺省时回退到主 apiConfig，再回退默认值（temp=0.85, stream=false）。
            // safeResponseJson 已能透明拼接 SSE 响应，所以打开 stream 后无需改下游。
            const apiT0 = performance.now();
            const userStream = (effectiveApi as any).stream ?? apiConfig.stream ?? false;
            // 思考过程展示开启时显式向后端请求 extended thinking（取值规则见 resolveDialogueLlmParams）。
            // ⚠️ 工具模式(瑞幸点单/麦当劳)下绝不带 thinking/reasoning 参数: "thinking + tools" 同发
            //    Gemini 等会直接 400 INVALID_ARGUMENT —— 表现就是"开了思考链的角色一点单就报错,
            //    换个没开思考链的角色就好"。工具循环优先, 思考链这一轮让步。
            const toolModeActive = payload.flags.luckinChatActive || payload.flags.mcdActive || payload.flags.luckinActive || payload.flags.mcpChatActive;
            // 主动消息 2.0 排程，两个值各管一件事：
            //   · amsg2ScheduleEnabled：角色这一轮有没有排程能力（worker 已配置 + 角色没关）。
            //     排程现状块、回执、聊天租约跟它走，两种形态都要。角色级开关关掉的一律没有——
            //     否则被用户显式关掉的功能会被角色一次工具调用重新打开。
            //   · amsg2ToolMode：这一轮以什么形态给。'native' 才在请求里带原生工具；
            //     'text' 只教正文协议（见 resolveAmsg2ToolMode）。中转拒 tools 降级后会改成 'text'。
            // thinking 门要先知道本轮带不带原生工具（工具在下面才真正拼进 tools，但参数取舍
            // 必须现在就定），所以先把形态算好再拼请求体。
            const amsg2ScheduleEnabled = isAmsg2EnabledForChar(char) && await replyStep(async () => isAmsg2GlobalReady());
            let amsg2ToolMode: Amsg2ToolMode = resolveAmsg2ToolMode(amsg2ScheduleEnabled, getMcpUseNativeTools());
            const amsg2ToolTzId = resolveCharTimeZone(char) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
            const baseReqBody: any = buildDialogueRequestBase({
                api: { ...effectiveApi, baseUrl },
                fallbackTemperature: apiConfig.temperature,
                messages: fullMessages,
                stream: userStream,
                thinkingActive: !!payload.flags.thinkingActive,
                legacyToolModeActive: !!toolModeActive,
                // 正文模式请求里没有 tools，「thinking + tools 同发被打回」无从发生。
                amsg2ToolsInjected: amsg2ToolMode === 'native',
            });
            // 流式时显式要求 usage 统计随末尾 chunk 一起返回，否则 token 徽标拿不到数据
            if (userStream) {
                baseReqBody.stream_options = { include_usage: true };
            }
            // 小程序模式: 给 LLM 一个 UI 钩子工具 propose_cart_items, 推荐时可调用,
            // 工具不真改购物车也不调 MCP, 只是把推荐渲染成 + 加按钮卡片让用户决定
            if (payload.flags.mcdActive) {
                baseReqBody.tools = [MCD_PROPOSE_TOOL];
                baseReqBody.tool_choice = 'auto';
            } else if (payload.flags.luckinActive) {
                baseReqBody.tools = [LUCKIN_PROPOSE_TOOL];
                baseReqBody.tool_choice = 'auto';
            } else if (payload.flags.luckinChatActive) {
                // 瑞幸聊天点单: 给角色真实 8 个 MCP 工具, 自己去查门店/搜商品/定规格/算价
                const luckinTools = await replyStep(async () => fetchOpenAIToolsForLuckin());
                if (luckinTools && luckinTools.length) {
                    baseReqBody.tools = luckinTools;
                    baseReqBody.tool_choice = 'auto';
                }
            }
            // 通用 MCP: 用户自配服务器的已发现工具, 追加而不覆盖(可与瑞幸/麦当劳共存)。
            // 工具清单读的是设置里持久化的发现结果, 不发网络请求。
            let mcpToolResolve: ReturnType<typeof buildMcpOpenAITools>['resolve'] | null = null;
            if (payload.flags.mcpChatActive) {
                const { tools: mcpTools, resolve } = buildMcpOpenAITools(char.id);
                if (mcpTools.length) {
                    mcpToolResolve = resolve;
                    const mcpOnly = !payload.flags.luckinChatActive && !payload.flags.mcdActive && !payload.flags.luckinActive;
                    if (!getMcpUseNativeTools() && mcpOnly) {
                        // 用户已明确判断当前模型/中转不支持 tools：首轮直接走正文兼容模式。
                        const compatibilityBody = buildMcpRejectedToolsFallbackBody({
                            ...baseReqBody,
                            tools: mcpTools,
                            tool_choice: 'auto',
                        });
                        baseReqBody.messages = compatibilityBody.messages;
                    } else {
                        baseReqBody.tools = [...(baseReqBody.tools || []), ...mcpTools];
                        if (!baseReqBody.tool_choice) baseReqBody.tool_choice = 'auto';
                    }
                }
            }
            // 主动消息 2.0 本地工具：原生模式注入 schedule/cancel/renew；两种形态都注入「排程现状」
            // 背景块（常驻能力简介 + 进行中任务 + 到点没发的回执，角色自行判断怎么接），
            // 正文模式在块尾补正文协议的语法（见 withAmsg2TaskContext）。形态在上面 thinking 门那里就算好了。
            let amsg2ExpiredIds: string[] = [];
            let amsg2Notices: Amsg2ExpiredNoticeRecord[] = [];
            if (amsg2ScheduleEnabled) {
                if (amsg2ToolMode === 'native') {
                    baseReqBody.tools = [
                        ...(baseReqBody.tools || []),
                        ...buildAmsg2Tools(resolveAmsgLimits(char.activeMsg2Config), {
                            nowMs: Date.now(),
                            tz: { tzId: amsg2ToolTzId },
                        }),
                    ];
                    if (!baseReqBody.tool_choice) baseReqBody.tool_choice = 'auto';
                }
                try {
                    // 回执这半边一轮只读一次台账；
                    // 进行中任务那半边每次发请求现取（见下面的 withAmsg2TaskContext）。
                    const taskContext = await replyStep(async () => collectAmsg2TaskContext(char, userProfile.name));
                    amsg2ExpiredIds = taskContext.expiredIds;
                    amsg2Notices = taskContext.notices;
                } catch (e) {
                    replyRun.check();
                    // 挂掉的只是回执这半边（它要读台账）。进行中清单在内存里，
                    // 照常渲染——角色至少知道自己名下有哪些任务，不至于一问三不知再排一条。
                    console.warn('[amsg2] 回执读取失败，本轮只带进行中清单', e);
                }
            }

            /**
             * 把排程现状块贴到 messages 末尾，每次发请求都按「此刻」的任务清单现算。
             *
             * 不写死进 baseReqBody.messages、也不进 loopMessages，是因为工具循环里角色会
             * 边聊边排：写死的话第二轮起看到的是**排程前**那份空清单，跟工具刚回的「已创建」
             * 打架，角色于是把同一条再排一遍；攒进历史的话则是好几份互相矛盾的旧清单叠着。
             * 现算 + 只留一份，角色每轮读到的都是自己名下真实的任务，本轮刚排的还会被点名。
             */
            const withAmsg2TaskContext = (messages: any[], finalRound = false): any[] => {
                if (!amsg2ScheduleEnabled) return messages;
                const now = Date.now();
                const liveConfig = amsg2Session.getConfig();
                const pending = getPendingTasks(liveConfig, now);
                // 「用户给你定的规矩」：用户刚开口，连发额度只剩排着还没响的自排任务在占。
                const limitsBrief = buildLimitsBrief({
                    limits: resolveAmsgLimits(liveConfig),
                    committedSends: pending.filter((t) => t.source === 'character').length,
                    activeTasks: pending.length,
                    context: 'chat',
                });
                const text = buildAmsg2TaskContextText(
                    pending,
                    amsg2Notices,
                    now,
                    resolveCharTimeZone(char),
                    amsg2CreatedThisTurn,
                    userProfile.name,
                    limitsBrief,
                    amsg2ToolMode === 'text' ? 'text' : 'native',
                    finalRound,
                );
                // 常驻简介让这一块总是非空：没任务时角色也得知道自己随时能排。
                const block = {
                    role: 'system',
                    content: amsg2TaskContextForMode(text, amsg2ToolMode, { nowMs: now, tz: { tzId: amsg2ToolTzId } }, finalRound),
                };
                // 插在易变尾段**之前**，不贴数组尾巴：「回到你自己」钢印焊在 volatileTail 末尾，
                // 靠 recency 抢模型开口前的最后一眼；一份带 promptHint 原文的清单摆在它后面，
                // 排在今晚的事会被当成本轮就该催的事（「书看到哪了」每轮问一遍的由来）。
                // 插入点在本轮用户消息之后，前缀缓存的断点更靠前，命中率一个 token 都不受影响。
                // 工具循环的 loopMessages 是 baseReqBody.messages 追加尾巴，前缀没动，下标照用。
                return insertAmsg2TaskContextBlock(messages, block, payload.volatileTailIndex);
            };
            // 带工具时说清「这次回复」从哪条消息算起，同样插在易变尾段之前。
            // 即时对话上云用的是 fullMessages，worker 那边自己加，这里不会重复。
            if (baseReqBody.tools?.length || mcpToolResolve) {
                baseReqBody.messages = insertAmsg2TaskContextBlock(
                    baseReqBody.messages,
                    { role: 'system', content: buildReplyScopeRule('user') },
                    payload.volatileTailIndex,
                );
            }

            // ─── 即时对话（主动消息 2.0 云端生成）分支 ───
            // 这一轮的上下文 + 任务一个 POST 上云，云端跑完走推送回来（收件箱同一条管线入库），
            // 客户端发完那一刻就自由了。
            //
            // 走不走这条路，构建 payload 之前的 instantChatRoute 已经算完了，这里只认它
            // 一个值：「这份 prompt 剥没剥时效段」和「这一轮走不走云端」必须是同一个判断，
            // 各算各的话两边总有一天会不同意，剥过的那份 prompt 就落到别的路上去了。
            // 没上云的那些情形（SAR 模块遇上旧版或没确认版本的 Worker / 点单否决 / MCP 地址够不着）在那一段里已经报过 trace，
            // 这边不重复报，也不重复拦。
            //
            // MCP 刻意不在排除名单里：worker fire 时自己解析 tool_config、自己跑后台
            // MCP（这次 POST 顺手把配置传上去了），云端答得了。排掉它的话，只要全局配着
            // 一台 enabled 的 MCP 服务器，即时对话就永远静默走回本地——设置页亮着
            // 「已开启」、界面毫无异样，用户查无可查。
            if (instantChatRoute) {
                // 回执跟着 chat 段上云：台账（collectAmsg2TaskContext）在上面已经读过了。
                // 本地路径靠 withAmsg2TaskContext 注入的排程清单和能力简介，
                // worker 的 instant timely block 现算清单、复用 buildAmsg2ChatScheduleBrief；唯独回执云端没有——
                // 只把这一样单独成块贴上，不带清单不带简介，别和到点渲染的那份撞车。
                const amsg2NoticesBlock = amsg2ScheduleEnabled && amsg2Notices.length
                    ? buildAmsg2NoticesText(amsg2Notices, resolveCharTimeZone(char), userProfile.name)
                    : null;
                const amsgSarSnapshot = buildAmsgSarModuleSnapshot({
                    plan: sarModulePlan,
                    charId: char.id,
                    currentMsgs,
                    historyMsgs: contextMsgs,
                    reroll: skipEmotionInjection,
                });
                sendProgress.sending();
                const instantChatResult = await replyStep(async () => sendInstantChatTurn({
                    signal: replyRun.signal,
                    char,
                    // 云端要发给模型的就是本地这一份，一个字不改（见 fire_pack 的 chat 段）。
                    // 回执块和 worker 时效块都插在易变尾段之前，与本地 withAmsg2TaskContext 同位：
                    // 「回到你自己」钢印留在模型开口前的最后一眼。
                    chatMessages: (amsg2NoticesBlock
                        ? insertAmsg2TaskContextBlock(fullMessages, { role: 'system', content: amsg2NoticesBlock }, payload.volatileTailIndex)
                        : fullMessages) as Array<{ role: string; content: unknown }>,
                    timelyInsertAt: payload.volatileTailIndex,
                    // 凭据用本地这一轮的那份：换成别的等于同一句话由不同模型来答，而用户看不出来。
                    // model / temperature 取 baseReqBody 的终值而不是 effectiveApi 的原始值：
                    // 上面那段已经按本地规则把 thinking 后缀（claude 系 -thinking）拼好、
                    // 开思考时把温度删掉了——云端要的就是「本地这一轮会发出去的那份」。
                    api: { baseUrl: effectiveApi.baseUrl, apiKey: effectiveApi.apiKey, model: baseReqBody.model },
                    ...(typeof baseReqBody.temperature === 'number' ? { temperature: baseReqBody.temperature } : {}),
                    maxTokens: baseReqBody.max_tokens,
                    // 思考链三件套同理取终值：shouldSendThinkingParams 通过时本地会带
                    // thinking / reasoning_effort / extra_body 三个入口（不同代理认不同的），
                    // 云端不带的话，凡是靠请求体参数激活思考的渠道（Anthropic 原生、
                    // OpenAI 系、LiteLLM 桥——即除了 -thinking 模型名后缀之外的全部）
                    // 一开即时对话思考就静默消失，心象卡片跟着没了。
                    ...(baseReqBody.thinking || baseReqBody.reasoning_effort || baseReqBody.extra_body
                        ? {
                            extraBody: {
                                ...(baseReqBody.thinking ? { thinking: baseReqBody.thinking } : {}),
                                ...(baseReqBody.reasoning_effort ? { reasoning_effort: baseReqBody.reasoning_effort } : {}),
                                ...(baseReqBody.extra_body ? { extra_body: baseReqBody.extra_body } : {}),
                            },
                        }
                        : {}),
                    userProfile, groups, realtimeConfig,
                    // 随行的云端快照复用这一轮刚算好的召回，发送前不再多等一轮向量检索。
                    ...(payload.palaceRecall ? { palaceRecall: payload.palaceRecall } : {}),
                    // 情绪评估也交给云端：worker 到点和主回复并行跑，结果随最后一条推送回来
                    // （见 worker/amsg/src/emotionEval.ts）。放在这里而不是本地 fire 一枪，
                    // 是因为用户发完就能关页面——留在本地的话，页面一关情绪底色就停更了。
                    ...(cloudEmotionEval ? { emotionEval: cloudEmotionEval } : {}),
                    // SAR 模块的请求时快照：worker 按它拆信封、逐段带回外显，落库侧按它写事件、
                    // 推进回合（本地路径在回复成功后做的那几件事）。目标消息取自喂给 prompt 的
                    // 同一份 contextMsgs，和模型看到的 USER_SURFACE 列表是同一批 id。
                    ...(amsgSarSnapshot ? { sarModule: amsgSarSnapshot } : {}),
                }));
                if (instantChatResult.ok) {
                    // sendInstantChatTurn only succeeds after a valid 202 + task UUID.
                    sendProgress.accepted();
                    // 这次 POST 已经把权威的那份 fire_pack 传上去了，收尾不必再打脏重传一遍。
                    instantChatAccepted = true;
                    // 202 只说明云端收下了，不说明角色真的读到过这些回执：那一轮可能空输出被
                    // 判 skip-push，也可能 fire 重试打光标 failed。所以这里只记账不销账，等回复
                    // 真的落库那一刻（activeMsgRuntime 认末段到齐）再调
                    // settleInstantChatExpiredNotices 写 notifiedAt；这一轮没成的话
                    // failInstantChatPending 会把它们退回未告知，下一轮重新注入。
                    // 本地路径同一口径：回复 applyAssistantPostProcessing 落库之后才标记。
                    if (amsg2ExpiredIds.length && instantChatResult.uuid) {
                        stageInstantChatExpiredNotices(char.id, instantChatResult.uuid, amsg2ExpiredIds);
                    }
                    if(friendFeedMainTask && instantChatResult.uuid)await stageFriendFeedCloudTask(char.id,friendFeedMainTask.id,instantChatResult.uuid).catch(()=>{});
                } else {
                    sendProgress.failed();
                    // 没发出去就是没发出去：明确落一条系统消息 + 弹错，用户可以直接重发。
                    // **绝不静默退回本地生成** —— 静默分流那种查无可查的坑踩过一次就够了。
                    const reason = instantChatResult.error || '未知错误';
                    await replyStep(async () => replyRun.saveMessage({ charId: char.id, role: 'system', type: 'text', content: `[${reason}]` }));
                    setMessages(await replyStep(async () => DB.getRecentMessagesByCharId(char.id, 200)));
                    if (showError) showError('即时对话发送失败', reason);
                    else addToast(reason, 'error');
                    // 没发出去 → 云端不会跑评估，那个正常的熄灭信号永不到达。当场自己熄，
                    // 否则「情绪更新中」要一直亮到 11 分钟后安全网到点。
                    if (cloudEmotionEval) extinguishCloudEmotionBadge();
                }
                return;
            }

            // 流式预览：仅在用户开了 stream、且非工具/双语模式时启用。
            // 工具模式的首轮响应可能是 tool_calls（无正文可预览）；双语模式正文包在
            // 跨行 <翻译> 标签里。这两类连正文/思考钩子都不挂，完整走原有整包路径。
            // 语音、日记、HTML 等由内容标签动态识别，computeStreamPreviewBubbles 会扣住控制块，
            // 只允许标签外确实属于普通文字的部分预览。
            // 每次 onDelta 基于累计全文全量重算（safeFetchJson 重试会重开流，天然重置）；
            // 正文尾句和思考内容只在累计文本确实变化时触发重渲染。
            // SAR 的正文包在结构化容器里，流式阶段不能把 TRUE/SURFACE 控制标签闪给用户。
            const streamUiEligible = !!userStream && !toolModeActive && !bilingualActive && !sarModulePlan.requiresEnvelope;
            const streamPreviewEligible = streamUiEligible;
            const streamThinkingEligible = streamUiEligible && payload.flags.thinkingActive;
            // 预览真的上过屏才置 true → 后处理落库时跳过拟人打字延迟（instantRender），
            // 否则用户会看到"预览气泡收回去、再一条条慢慢重弹"的二次播放。
            let streamPreviewShown = false;
            let streamThinkingShown = false;
            let latestStreamPreviewBubbles: string[] = [];
            let latestNativeReasoning = '';
            let latestEmbeddedThinking = '';
            const publishStreamingThinking = () => {
                const combined = [latestNativeReasoning, latestEmbeddedThinking]
                    .map(text => text.trim())
                    .filter(Boolean)
                    .join('\n\n');
                if (combined) streamThinkingShown = true;
                setStreamingThinking(prev => prev === combined ? prev : combined);
            };
            const streamHooks = (streamPreviewEligible || streamThinkingEligible) ? {
                onDelta: (_delta: string, fullText: string) => {
                    if (replyRun.signal.aborted) return;
                    if (streamPreviewEligible) {
                        // 正文模式下角色会把排程写成一行调用，预览里不能先闪给用户看。
                        const bubbles = computeStreamPreviewBubbles(
                            amsg2ToolMode === 'text' ? maskAmsg2ScheduleSyntaxForPreview(fullText) : fullText,
                        );
                        latestStreamPreviewBubbles = bubbles;
                        if (bubbles.length > 0) streamPreviewShown = true;
                        setStreamingBubbles(prev =>
                            (prev.length === bubbles.length && prev.every((b, i) => b === bubbles[i])) ? prev : bubbles
                        );
                    }
                    if (streamThinkingEligible) {
                        latestEmbeddedThinking = extractStreamingEmbeddedThinking(fullText);
                        publishStreamingThinking();
                    }
                },
                onReasoningDelta: (_delta: string, fullReasoning: string) => {
                    if (replyRun.signal.aborted) return;
                    if (!streamThinkingEligible) return;
                    latestNativeReasoning = fullReasoning;
                    publishStreamingThinking();
                },
            } : undefined;

            // 主请求即将发出 → 立即并行发射情绪评估（错峰延迟已按用户要求取消，见定义处注释）。
            fireLocalEmotionEval?.();

            // 同角色活跃会话租约：本地 fetch 路径本轮真实消息已落库、模型请求即将发出，
            // 启动心跳告诉 worker「正在和这个角色聊」——到点的 expire AI 任务据此 skip，
            // 别在用户正聊时又弹主动消息。即时对话路径在上方已 return，天然不重复开 lease。
            // 只对已排程 AI 任务的角色开租约：其余角色没有 worker 消费，开了纯浪费还刷 warn。
            const amsg2Cfg = char.activeMsg2Config;
            if (amsg2ScheduleEnabled && amsg2Cfg?.enabled && hasActiveAiTask(amsg2Cfg)) {
                startAmsgChatPresence(char.id, getLastRealUserMessageAt(contextMsgs));
            }

            // 任何一个工具循环发过最后一轮（收尾那一跳）之后，后面的循环不再执行工具。
            let toolPhaseClosed = false;
            let data: any;
            try {
                data = await replyStep(async () => safeFetchJson(`${baseUrl}/chat/completions`, {
                    signal: replyRun.signal,
                    method: 'POST', headers,
                    body: JSON.stringify({ ...baseReqBody, messages: withAmsg2TaskContext(baseReqBody.messages) })
                }, 2, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: '聊天回复' }, streamHooks));
            } catch (e) {
                replyRun.check();
                let requestError: unknown = e;
                const attemptedBody = {
                    ...baseReqBody,
                    messages: withAmsg2TaskContext(baseReqBody.messages),
                };
                // 部分第三方 OpenAI→Claude 中转会把请求形状不兼容包装成 502
                // bad_response_status_code：thinking 三种方言、tools、尾部 system 单独都能收，
                // 组合在一起却在上游适配层失败。只对这一条高度特征化的 502 降级一次：
                // tools 和正文完整保留，system 合到开头，thinking 参数让步。普通网络 502、
                // 非 Claude、没工具的请求一律不重发，避免无依据地重复计费。
                if (shouldRetryClaudeProxyCompatibility(requestError, attemptedBody)) {
                    console.warn('🧩 [Claude compat] 中转拒绝 thinking + tools 组合，使用兼容请求体重试一次');
                    try {
                        data = await replyStep(async () => safeFetchJson(`${baseUrl}/chat/completions`, {
                            signal: replyRun.signal,
                            method: 'POST', headers,
                            body: JSON.stringify(buildClaudeProxyCompatibilityBody(attemptedBody)),
                        }, 0, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: 'Claude 中转兼容重试' }, streamHooks));
                        requestError = null;
                    } catch (compatError) {
                        replyRun.check();
                        requestError = compatError;
                    }
                }

                if (!requestError) {
                    // Claude 兼容重试已成功，继续走下方统一后处理。
                } else {
                // 只有通用 MCP / 主动消息排程这两类工具、没有和点单类工具混用时降级（点单离不开
                // 原生工具）。部分 OpenAI 兼容中转会对携带 tools 的请求直接回 4xx，而不是忽略参数；
                // 去掉 tools 后让正文协议接手：MCP 走正文假调用容错，排程改走正文协议（下面 3.6c）。
                // 真实鉴权失败会在这次重试中再次抛出原样错误。
                const textFallbackAllowed = (payload.flags.mcpChatActive || amsg2ToolMode === 'native')
                    && !payload.flags.luckinChatActive && !payload.flags.mcdActive && !payload.flags.luckinActive;
                if (!textFallbackAllowed || !baseReqBody.tools?.length || !shouldRetryMcpWithoutTools(requestError)) throw requestError;
                console.warn('🔌 [tools] 当前中转拒绝 tools 请求，降级为正文工具调用兼容模式');
                // 先切形态再拼排程现状块，块尾才带得上正文协议的语法。
                if (amsg2ToolMode === 'native') amsg2ToolMode = 'text';
                // 这条路把 tools 全删了；排程现状照样要带——角色得知道自己名下已经有哪些承诺，
                // 否则又会在正文里许一遍。块每次请求现算，不写死进 baseReqBody.messages：
                // 排程开着时这里已切到正文模式，后续由 3.6c 每跳现算；没开排程时现算本就是原样返回。
                const fallbackBody = buildRejectedToolsFallbackBody(baseReqBody);
                data = await replyStep(async () => safeFetchJson(`${baseUrl}/chat/completions`, {
                    signal: replyRun.signal,
                    method: 'POST', headers,
                    body: JSON.stringify({ ...fallbackBody, messages: withAmsg2TaskContext(fallbackBody.messages) })
                }, 0, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: mcpToolResolve ? 'MCP tools 兼容重试' : '排程工具兼容重试' }));
                // 后续正文工具循环必须继续带着兼容协议；只把它放在这次重试请求里，下一跳
                // 又退回原 messages，会让模型忘掉工具签名和「每步只输出一行」的约定。
                baseReqBody.messages = fallbackBody.messages;
                }
            }
            console.log(`⏱ [API call] ${Math.round(performance.now() - apiT0)}ms`);
            updateTokenUsage(data, historyMsgCount, 'initial');

            // MCP 多阶段展示：工具前的角色文字先落库，最终工具结果回复仍走统一后处理。
            const displayedMcpLeadIns = new Set<string>();
            const persistMcpLeadIn = async (raw: string, fakedCalls: FakedMcpCall[] = []): Promise<void> => {
                if (!mcpToolResolve || !raw.trim()) return;
                const withoutCalls = fakedCalls.length ? stripTextFakedMcpCalls(raw, fakedCalls) : raw.trim();
                const display = ChatParser.sanitize(sanitizeMcpLeadInText(withoutCalls), { keepCitations: true }).trim();
                if (!display || !ChatParser.hasDisplayContent(display) || displayedMcpLeadIns.has(display)) return;
                displayedMcpLeadIns.add(display);
                const chunks = ChatParser.chunkText(display).filter(chunk => ChatParser.hasDisplayContent(chunk));
                for (const chunk of chunks) {
                    const cleanChunk = ChatParser.sanitize(chunk, { keepCitations: true }).trim();
                    if (!cleanChunk) continue;
                    await replyStep(async () => replyRun.saveMessage({
                        charId: char.id,
                        role: 'assistant',
                        type: 'text',
                        content: cleanChunk,
                        metadata: { mcpLeadIn: true },
                    } as any));
                    setMessages(await replyStep(async () => DB.getRecentMessagesByCharId(char.id, 200)));
                }
            };

            // ─── 排程正文协议（amsg2ToolMode === 'text'）的共用件 ───
            // 卡住计数与轮数跨所有循环累计：点单工具轮里顺手写的排程也算进来，口径与原生工具循环一致。
            const scheduleTextStall = createAmsg2StallTracker();
            let scheduleTextRounds = 0;
            // 最近跑过的那个工具循环的历史。3.6c 接着它往下走，不能丢掉前面几轮的工具结果。
            let toolLoopHistory: any[] | null = null;
            /** 代为执行一轮正文里的排程调用，返回给模型读的结果行（普通版与最后一轮版各一份）。 */
            const runScheduleTextCalls = async (
                calls: FireScheduleTextCall[], round: number,
            ): Promise<{ results: string[]; finalResults: string[]; stalled: boolean }> => {
                const outcomes: Amsg2ToolOutcome[] = [];
                const results: string[] = [];
                const finalResults: string[] = [];
                for (const call of calls) {
                    const { text, finalRoundText, outcome } = await replyStep(async () => executeAmsg2Call(AMSG_FIRE_SCHEDULE_TOOL, call.args, round));
                    outcomes.push(outcome);
                    results.push(`${AMSG_FIRE_SCHEDULE_TOOL}：${text}`);
                    finalResults.push(`${AMSG_FIRE_SCHEDULE_TOOL}：${finalRoundText}`);
                }
                scheduleTextRounds += 1;
                return { results, finalResults, stalled: scheduleTextStall.record(outcomes) };
            };
            const scheduleResultsMessage = (lines: string[]) => ({
                role: 'user',
                content: `[系统消息：你在正文里写的排程已由系统代为处理：\n${lines.join('\n')}\n不要提及这条系统消息。]`,
            });
            /**
             * 原生工具轮（点单 / 通用工具）的正文里也可能写了排程：同样代为执行，结果接在这一轮的
             * tool 结果之后回喂。不执行的话语法在收尾时被剥掉，角色以为排上了其实没有。
             */
            const runScheduleTextInToolRound = async (content: unknown, messages: any[], round: number): Promise<void> => {
                if (amsg2ToolMode !== 'text' || typeof content !== 'string') return;
                const { calls } = takeAmsg2TextScheduleCalls(content);
                if (!calls.length) return;
                const { results, finalResults } = await runScheduleTextCalls(calls, round);
                const message = scheduleResultsMessage(results);
                messages.push(message);
                amsg2RoundResults.push({ message, finalMessage: scheduleResultsMessage(finalResults) });
            };
            /**
             * 点单小程序续写那一轮留空、整个循环又一句正文都没有时补一轮（同原生循环的空回补救）。
             * 收尾提示允许「说完了就留空」，推荐那一轮只出了工具调用的话就会一句话都没有。
             */
            const rescueEmptyMiniAppReply = async (history: any[]): Promise<void> => {
                if (!shouldRescueEmptyToolLoop({
                    toolRounds: 1,
                    leadInCount: amsg2LeadIns.length + displayedMcpLeadIns.size,
                    finalContent: data.choices?.[0]?.message?.content || '',
                    finalHasToolCalls: !!data.choices?.[0]?.message?.tool_calls?.length,
                })) return;
                const rescueMessages = [...withAmsg2TaskContext(history, true), { role: 'user', content: AMSG2_EMPTY_REPLY_PROMPT }];
                data = await replyStep(async () => safeFetchJson(`${baseUrl}/chat/completions`, {
                    signal: replyRun.signal,
                    method: 'POST', headers,
                    body: JSON.stringify(buildMcpTextFallbackBody(baseReqBody, rescueMessages)),
                }, 2, 0, { appId: 'chat', appName: '消息', charId: char.id, charName: char.name, purpose: '点单后补充回复' }));
                updateTokenUsage(data, historyMsgCount, 'mini-empty-rescue');
            };
            /** 代为执行一个正文里的 MCP 调用（MCP 正文兜底和 3.6c 共用）。 */
            const executeFakedMcpCall = async (call: FakedMcpCall): Promise<string> => {
                let r: any;
                try { r = await replyStep(async () => callMcpTool(call.server, call.toolName, call.args, replyRun.signal)); }
                catch (e: any) { replyRun.check(); r = { success: false, error: e?.message || String(e) }; }
                return r.success
                    ? `工具 ${call.exposedName} 执行成功, 结果: ${formatMcpToolResult(r.data)}`
                    : `工具 ${call.exposedName} 执行失败: ${r.error}`;
            };

            // 3.4 麦当劳小程序 propose_cart_items UI 钩子工具循环
            //     不调 MCP, 只把模型的 args 作为 mcd_card kind=proposal 落库, 让小程序聊天面板渲染
            //     成"+加进购物车"卡片。返回 ack 给模型继续走它的文字 reply。
            if (payload.flags.mcdActive && data.choices?.[0]?.message?.tool_calls?.length) {
                const MAX_PROPOSE_LOOPS = 3;
                let loopMessages = [...baseReqBody.messages];
                for (let it = 0; it < MAX_PROPOSE_LOOPS; it++) {
                    const toolCalls = data.choices?.[0]?.message?.tool_calls;
                    if (!toolCalls || !toolCalls.length) break;
                    loopMessages.push({
                        role: 'assistant',
                        // 空 content + tool_calls 在 Gemini 兼容层会被判 INVALID_ARGUMENT；剥除内联思考后无对白就给占位
                        content: formatToolRoundHistoryContent(data.choices[0].message.content),
                        tool_calls: toolCalls,
                        ...toolTurnContinuation(data.choices[0].message),
                    } as any);
                    for (const tc of toolCalls) {
                        const fname: string = tc.function?.name || '';
                        let args: any = {};
                        try {
                            const raw = tc.function?.arguments ?? tc.arguments;
                            args = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (raw || {});
                        } catch (e) {
                            console.warn('🍔 [MCD-MiniApp] propose 参数解析失败:', e);
                        }
                        // 主动消息 2.0 的排程工具与点单工具会在同一批 tool_calls 里出现:
                        // 先分流执行, 否则会落进下面的「畸形调用」分支被吃掉, 而续写请求
                        // 又不带 tools, 角色「点单时顺手排个提醒」就永远不会生效。
                        const route = routeMiniAppToolCall(fname, args);
                        if (route === 'amsg2') {
                            await replyStep(async () => runAmsg2ToolCall(tc, fname, args, loopMessages, it));
                            continue;
                        }
                        if (route === 'propose') {
                            // 第一步: 菜单还没加载就直接拒, 不能让模型瞎编 code
                            // 这是导致 calculate-price 返回空列表的根因之一: propose 在 pick 步骤被调用,
                            // 此时 menuMeals 是空的, 旧版 menuKeys.length===0 会直接跳过校验, 烂 code 一路到 cart。
                            const menu = mcdMiniSnap?.menuMeals || {};
                            const menuKeys = Object.keys(menu);
                            if (menuKeys.length === 0) {
                                loopMessages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: `菜单还没加载 (用户当前在选模式 / 选地址门店阶段, 还没进入菜单页)。请先用文字陪用户聊, 等用户在小程序里选完地址/门店、菜单加载出来后再调 propose_cart_items。所有 code 必须从加载后的"当前门店在售"清单里挑, 不能凭印象编。`,
                                } as any);
                                continue;
                            }
                            // 第二步: 全局名字匹配自动修 code (char 经常把"板烧鸡腿堡"当 code 传)
                            const { fixed, fixes } = autoFixProposalCodesByName(args.items, menu);
                            if (fixes.length) {
                                console.log(`🍔 [MCD-MiniApp] propose 自动修 ${fixes.length} 个 code:`,
                                    fixes.map(f => `'${f.from}' → '${f.to}' (${f.name})`).join(', '));
                            }
                            args.items = fixed;
                            // 第三步: 修完后还有非法的就退回 char 重提 (严格模式: 任何不在 menu 字典里的 code 都拒)
                            const invalidItems = args.items.filter((it: any) => !it?.code || !(menu as any)[it.code]);
                            if (invalidItems.length > 0) {
                                const sample = menuKeys.slice(0, 20).map(k => `${k}=${(menu as any)[k]?.name || ''}`).join(', ');
                                const bad = invalidItems.map((i: any) => `'${i.code}'(${i.name || '?'})`).join(', ');
                                loopMessages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: `propose_cart_items 里这些 code/name 在菜单里都找不到匹配 (已尝试名字模糊匹配但失败): ${bad}。这些商品本店不卖, 别推。当前菜单可用 code 示例: ${sample}。请只从菜单里挑实际有的, 重新调一次 propose。`,
                                } as any);
                                continue;
                            }
                            try {
                                await replyStep(async () => replyRun.saveMessage({
                                    charId: char.id,
                                    role: 'assistant',
                                    type: 'mcd_card',
                                    content: `${args.items.length} 件推荐`,
                                    metadata: {
                                        mcdCardKind: 'proposal',
                                        mcdProposal: args,
                                        fromMcdMiniApp: true,
                                    },
                                } as any));
                                setMessages(await replyStep(async () => DB.getRecentMessagesByCharId(char.id, 200)));
                            } catch (e) {
                                replyRun.check();
                                console.warn('🍔 [MCD-MiniApp] 保存 proposal 失败:', e);
                            }
                            const ackExtra = fixes.length
                                ? ` (我帮你把 ${fixes.length} 个 code 按名字校准到了菜单里真实的 code, 下次 propose 时直接用菜单字典 key 别传名字, 省一步)`
                                : '';
                            loopMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: `OK 已把推荐展示给用户, 用户可以点 + 加进购物车${ackExtra}`,
                            } as any);
                        } else {
                            // 未知工具 / 空 items, 给个温和的报错让模型自纠
                            loopMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: `工具 ${fname} 调用形态不对, 期望 {items: [{code, name, qty, reason?}]}; 你这次给的是 ${JSON.stringify(args).slice(0, 200)}`,
                            } as any);
                        }
                    }
                    await runScheduleTextInToolRound(data.choices?.[0]?.message?.content, loopMessages, it);
                    const mcdLeadIn = extractToolRoundLeadIn(data.choices?.[0]?.message?.content);
                    if (mcdLeadIn) {
                        amsg2LeadIns.push(mcdLeadIn);
                        lastSpokenData = data;
                    }
                    // 让 char 继续生成文字补充 (不再带 tools, 避免无限调)
                    // 续写不带 tools，就是这个循环的最后一轮：加收尾提示，正文模式下不教排程语法。
                    toolPhaseClosed = true;
                    switchAmsg2ResultsToFinalRound();
                    const followBody = {
                        ...baseReqBody,
                        messages: [...withAmsg2TaskContext(loopMessages, true), { role: 'user', content: TOOL_LOOP_FINAL_ROUND_PROMPT }],
                    };
                    delete followBody.tools;
                    delete followBody.tool_choice;
                    data = await replyStep(async () => safeFetchJson(`${baseUrl}/chat/completions`, {
                        signal: replyRun.signal,
                        method: 'POST', headers,
                        body: JSON.stringify(followBody)
                    }, 2, 0, { appId: 'chat', appName: '消息', charId: char.id, charName: char.name, purpose: '麦当劳点餐回复' }));
                    updateTokenUsage(data, historyMsgCount, `mcd-propose-${it + 1}`);
                    // 第二轮跳过 (我们已经禁用了 tools)
                    if (!data.choices?.[0]?.message?.tool_calls?.length) break;
                }
                await rescueEmptyMiniAppReply(loopMessages);
                toolLoopHistory = loopMessages;
            }

            // 3.5 瑞幸小程序 propose_cart_items UI 钩子工具循环 (与麦当劳同构)
            if (payload.flags.luckinActive && data.choices?.[0]?.message?.tool_calls?.length) {
                const MAX_PROPOSE_LOOPS = 3;
                let loopMessages = [...baseReqBody.messages];
                for (let it = 0; it < MAX_PROPOSE_LOOPS; it++) {
                    const toolCalls = data.choices?.[0]?.message?.tool_calls;
                    if (!toolCalls || !toolCalls.length) break;
                    loopMessages.push({
                        role: 'assistant',
                        // 空 content + tool_calls 在 Gemini 兼容层会被判 INVALID_ARGUMENT；剥除内联思考后无对白就给占位
                        content: formatToolRoundHistoryContent(data.choices[0].message.content),
                        tool_calls: toolCalls,
                        ...toolTurnContinuation(data.choices[0].message),
                    } as any);
                    for (const tc of toolCalls) {
                        const fname: string = tc.function?.name || '';
                        let args: any = {};
                        try {
                            const raw = tc.function?.arguments ?? tc.arguments;
                            args = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (raw || {});
                        } catch (e) {
                            console.warn('☕ [Luckin-MiniApp] propose 参数解析失败:', e);
                        }
                        // 主动消息 2.0 的排程工具与点单工具会在同一批 tool_calls 里出现:
                        // 先分流执行, 否则会落进下面的「畸形调用」分支被吃掉, 而续写请求
                        // 又不带 tools, 角色「点单时顺手排个提醒」就永远不会生效。
                        const route = routeMiniAppToolCall(fname, args);
                        if (route === 'amsg2') {
                            await replyStep(async () => runAmsg2ToolCall(tc, fname, args, loopMessages, it));
                            continue;
                        }
                        if (route === 'propose') {
                            const menu = luckinMiniSnap?.menuItems || {};
                            const menuKeys = Object.keys(menu);
                            if (menuKeys.length === 0) {
                                loopMessages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: `菜单还没加载 (用户当前在选模式 / 选门店阶段)。请先用文字陪用户聊, 等菜单加载出来、出现"当前门店在售"清单后再调 propose_cart_items, code 必须从清单里挑。`,
                                } as any);
                                continue;
                            }
                            const { fixed, fixes } = autoFixLuckinProposalCodesByName(args.items, menu);
                            if (fixes.length) {
                                console.log(`☕ [Luckin-MiniApp] propose 自动修 ${fixes.length} 个 code:`,
                                    fixes.map(f => `'${f.from}' → '${f.to}' (${f.name})`).join(', '));
                            }
                            args.items = fixed;
                            const invalidItems = args.items.filter((it: any) => !it?.code || !(menu as any)[it.code]);
                            if (invalidItems.length > 0) {
                                const sample = menuKeys.slice(0, 20).map(k => `${k}=${(menu as any)[k]?.name || ''}`).join(', ');
                                const bad = invalidItems.map((i: any) => `'${i.code}'(${i.name || '?'})`).join(', ');
                                loopMessages.push({
                                    role: 'tool',
                                    tool_call_id: tc.id,
                                    content: `propose_cart_items 里这些 code/name 在菜单里找不到匹配: ${bad}。这些商品本店不卖, 别推。当前菜单可用 code 示例: ${sample}。请只从菜单里挑实际有的, 重新调一次 propose。`,
                                } as any);
                                continue;
                            }
                            try {
                                await replyStep(async () => replyRun.saveMessage({
                                    charId: char.id,
                                    role: 'assistant',
                                    type: 'luckin_card',
                                    content: `${args.items.length} 件推荐`,
                                    metadata: {
                                        luckinCardKind: 'proposal',
                                        luckinProposal: args,
                                        fromLuckinMiniApp: true,
                                    },
                                } as any));
                                setMessages(await replyStep(async () => DB.getRecentMessagesByCharId(char.id, 200)));
                            } catch (e) {
                                replyRun.check();
                                console.warn('☕ [Luckin-MiniApp] 保存 proposal 失败:', e);
                            }
                            const ackExtra = fixes.length
                                ? ` (我帮你把 ${fixes.length} 个 code 按名字校准到了菜单里真实的 code)`
                                : '';
                            loopMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: `OK 已把推荐展示给用户, 用户可以点 + 加进购物车${ackExtra}`,
                            } as any);
                        } else {
                            loopMessages.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: `工具 ${fname} 调用形态不对, 期望 {items: [{code, name, qty, reason?}]}; 你这次给的是 ${JSON.stringify(args).slice(0, 200)}`,
                            } as any);
                        }
                    }
                    await runScheduleTextInToolRound(data.choices?.[0]?.message?.content, loopMessages, it);
                    const luckinMiniLeadIn = extractToolRoundLeadIn(data.choices?.[0]?.message?.content);
                    if (luckinMiniLeadIn) {
                        amsg2LeadIns.push(luckinMiniLeadIn);
                        lastSpokenData = data;
                    }
                    // 续写不带 tools，就是这个循环的最后一轮：加收尾提示，正文模式下不教排程语法。
                    toolPhaseClosed = true;
                    switchAmsg2ResultsToFinalRound();
                    const followBody = {
                        ...baseReqBody,
                        messages: [...withAmsg2TaskContext(loopMessages, true), { role: 'user', content: TOOL_LOOP_FINAL_ROUND_PROMPT }],
                    };
                    delete followBody.tools;
                    delete followBody.tool_choice;
                    data = await replyStep(async () => safeFetchJson(`${baseUrl}/chat/completions`, {
                        signal: replyRun.signal,
                        method: 'POST', headers,
                        body: JSON.stringify(followBody)
                    }, 2, 0, { appId: 'chat', appName: '消息', charId: char.id, charName: char.name, purpose: '瑞幸点单回复' }));
                    updateTokenUsage(data, historyMsgCount, `luckin-propose-${it + 1}`);
                    if (!data.choices?.[0]?.message?.tool_calls?.length) break;
                }
                await rescueEmptyMiniAppReply(loopMessages);
                toolLoopHistory = loopMessages;
            }

            // 3.6 客户端工具循环 —— 两类共用一个循环骨架:
            //     · 瑞幸聊天点单: 真实 8 工具 (queryShopList → searchProductForMcp →
            //       switchProduct → previewOrder)。结果落 luckin_card; previewOrder 落"结账卡"(可改量+扫码付);
            //       createOrder 被拦截 —— 下单付款必须用户在结账卡上点。
            //     · 通用 MCP: 工具名命中 mcpToolResolve 映射就分发给对应服务器 (utils/mcpClient),
            //       结果只回填循环不落卡片。两类工具可同时在场, 按名字各走各的。
            if ((payload.flags.luckinChatActive || mcpToolResolve || amsg2ToolMode === 'native') && data.choices?.[0]?.message?.tool_calls?.length) {
                // 普通点单/排程维持 6 轮；接了通用 MCP 时允许游戏/论坛类任务自然推进到
                // 12 轮。模型正常给正文会立刻 break，并不是固定多发 12 次请求。
                const MAX_LOOPS = mcpToolResolve ? MCP_CHAT_MAX_TOOL_LOOPS : 6;
                let loopMessages = [...baseReqBody.messages];
                const loc = luckinChatRef?.current;
                const seenMcpOutcomes = new Set<string>();
                let stalledMcpRounds = 0;
                let lastMcpCallSignature: string | null = null;
                const amsg2Stall = createAmsg2StallTracker();
                let amsg2ToolRounds = 0;
                let nonAmsg2ToolCalls = 0;
                let wrapUpKind: ToolLoopWrapUpKind = 'none';
                for (let it = 0; it < MAX_LOOPS; it++) {
                    amsg2RoundResults.length = 0;
                    const toolCalls = normalizeToolCallsForCompat(
                        data.choices?.[0]?.message?.tool_calls,
                        `private_${it}`,
                    );
                    if (!toolCalls || !toolCalls.length) break;
                    if (mcpToolResolve && toolCalls.some((tc: any) => mcpToolResolve?.has(tc.function?.name || ''))) {
                        await replyStep(async () => persistMcpLeadIn(data.choices?.[0]?.message?.content || ''));
                    }
                    loopMessages.push({
                        role: 'assistant',
                        // 空 content + tool_calls 在 Gemini 兼容层会被判 INVALID_ARGUMENT；剥除内联思考后无对白就给占位
                        content: formatToolRoundHistoryContent(data.choices[0].message.content),
                        tool_calls: toolCalls,
                        ...toolTurnContinuation(data.choices[0].message),
                    } as any);
                    let mcpCallsThisRound = 0;
                    let mcpProgressThisRound = false;
                    const amsg2Outcomes: Amsg2ToolOutcome[] = [];
                    for (const tc of toolCalls) {
                        const fname: string = tc.function?.name || '';
                        let args: any = {};
                        try {
                            const raw = tc.function?.arguments ?? tc.arguments;
                            args = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (raw || {});
                        } catch (e) {
                            console.warn('☕ [Luckin-Chat] 工具参数解析失败:', e);
                        }
                        // 通用 MCP 工具: 命中映射直接分发, 不走下面的瑞幸逻辑
                        const mcpHit = mcpToolResolve?.get(fname);
                        if (mcpHit) {
                            mcpCallsThisRound += 1;
                            nonAmsg2ToolCalls += 1;
                            const callSignature = toolCallFingerprint(fname, args);
                            // 连续同名同参通常是模型卡住。先拦再执行，避免发帖 / 下单之类的
                            // 副作用真的重复发生；中间做过其他动作后同参查状态仍会正常放行。
                            if (callSignature === lastMcpCallSignature) {
                                loopMessages.push(buildToolResultMessage(
                                    tc,
                                    `工具 ${fname} 的同一组参数刚刚已经执行过，请不要原地重复；根据已有结果选择能推进目标的下一步，或直接回复。`,
                                ) as any);
                                continue;
                            }
                            lastMcpCallSignature = callSignature;
                            setSearchStatus(`正在调用 MCP 工具：${fname}...`);
                            let mcpResult: any;
                            try { mcpResult = await replyStep(async () => callMcpTool(mcpHit.server, mcpHit.toolName, args, replyRun.signal)); }
                            catch (e: any) { replyRun.check(); mcpResult = { success: false, error: e?.message || String(e) }; }

                            const mcpMsg = mcpResult.success
                                ? `工具 ${fname} 成功。结果: ${formatMcpToolResult(mcpResult.data)}`
                                : `工具 ${fname} 失败: ${mcpResult.error}`;
                            // 同名同参在动作前后可能得到不同状态，结果不同就算仍在推进；只有
                            // 调用和结果都原样重复才算原地打转。
                            let outcomeKey = `${fname}|${JSON.stringify(args)}|${mcpMsg}`;
                            if (outcomeKey.length > 4000) outcomeKey = outcomeKey.slice(0, 4000);
                            if (!seenMcpOutcomes.has(outcomeKey)) {
                                seenMcpOutcomes.add(outcomeKey);
                                mcpProgressThisRound = true;
                            }
                            loopMessages.push(buildToolResultMessage(tc, mcpMsg) as any);
                            continue;
                        }
                        // 主动消息 2.0 工具
                        if (AMSG2_TOOL_NAMES.has(fname)) {
                            amsg2Outcomes.push(await replyStep(async () => runAmsg2ToolCall(tc, fname, args, loopMessages, it)));
                            continue;
                        }
                        nonAmsg2ToolCalls += 1;
                        // 只开了 MCP 没开瑞幸时, 幻觉出的未知工具名直接回错误让模型自我纠正
                        if (!payload.flags.luckinChatActive) {
                            loopMessages.push(buildToolResultMessage(tc, `未知工具 ${fname}, 只能使用系统提供的工具。`) as any);
                            continue;
                        }
                        // 经纬度兜底: 角色漏传就用激活时抓到的定位补上
                        if (/queryShopList|createOrder/i.test(fname) && loc) {
                            if (args.longitude == null && loc.longitude != null) args.longitude = loc.longitude;
                            if (args.latitude == null && loc.latitude != null) args.latitude = loc.latitude;
                        }
                        // 拦截 createOrder: 不真下单, 引导走结账卡
                        if (/create[-_]?order/i.test(fname)) {
                            loopMessages.push(buildToolResultMessage(
                                tc,
                                '下单与支付由用户在结账卡上完成, 你不要调 createOrder。若还没出结账卡, 请先调 previewOrder 把订单算价展示出来, 然后用角色语气让用户去卡片上确认支付。',
                            ) as any);
                            continue;
                        }
                        let result: any;
                        try { result = await replyStep(async () => callLuckinTool(fname, args, replyRun.signal)); }
                        catch (e: any) { replyRun.check(); result = { success: false, error: e?.message || String(e) }; }


                        const isPreview = /preview[-_]?order/i.test(fname);
                        try {
                            await replyStep(async () => replyRun.saveMessage({
                                charId: char.id,
                                role: 'assistant',
                                type: 'luckin_card',
                                content: fname,
                                metadata: {
                                    luckinToolName: fname,
                                    luckinToolArgs: args,
                                    luckinToolResult: result.success ? result.data : undefined,
                                    luckinToolError: result.success ? undefined : result.error,
                                    luckinToolRawText: result.rawText,
                                    luckinCardKind: isPreview ? 'checkout' : inferLuckinCardKind(fname),
                                    luckinLoc: (loc && loc.longitude != null) ? { longitude: loc.longitude, latitude: loc.latitude } : undefined,
                                },
                            } as any));
                            setMessages(await replyStep(async () => DB.getRecentMessagesByCharId(char.id, 200)));
                        } catch (e) { replyRun.check(); console.warn('☕ [Luckin-Chat] 存卡片失败:', e); }


                        const toolMsg = result.success
                            ? `工具 ${fname} 成功。结果(截断): ${(() => { try { return JSON.stringify(result.data).slice(0, 1500); } catch { return String(result.data).slice(0, 800); } })()}`
                            : `工具 ${fname} 失败: ${result.error}`;
                        loopMessages.push(buildToolResultMessage(tc, toolMsg) as any);
                    }
                    await runScheduleTextInToolRound(data.choices?.[0]?.message?.content, loopMessages, it);
                    if (mcpCallsThisRound > 0) {
                        stalledMcpRounds = mcpProgressThisRound ? 0 : stalledMcpRounds + 1;
                    }
                    if (amsg2Outcomes.length > 0) {
                        amsg2ToolRounds += 1;
                        // 这一轮写下的回话留着（MCP 轮的开场白已经由 persistMcpLeadIn 单独落库了）。
                        if (mcpCallsThisRound === 0) {
                            const leadIn = extractToolRoundLeadIn(data.choices?.[0]?.message?.content);
                            if (leadIn) {
                                amsg2LeadIns.push(leadIn);
                                lastSpokenData = data;
                            }
                        }
                    }
                    const amsg2Stalled = amsg2Stall.record(amsg2Outcomes);
                    // 下一跳是不是最后一轮：用到倒数第二轮就收尾，最后一轮不带工具（点单、MCP、排程一视同仁），
                    // 不然转到上限时最后那份响应里只有 tool_calls、没有正文。
                    const wrapUp = resolveToolLoopWrapUp({
                        round: it,
                        maxLoops: MAX_LOOPS,
                        hasLeadIn: amsg2LeadIns.length > 0 || displayedMcpLeadIns.size > 0,
                        mcpStalled: !!mcpToolResolve && stalledMcpRounds >= MCP_CHAT_MAX_STALLED_ROUNDS,
                        amsg2Stalled,
                        scheduleOnly: nonAmsg2ToolCalls === 0,
                    });
                    const forceWrapUp = wrapUp.kind !== 'none';
                    if (forceWrapUp) {
                        wrapUpKind = wrapUp.kind;
                        toolPhaseClosed = true;
                    }
                    if (forceWrapUp) switchAmsg2ResultsToFinalRound();
                    // 继续让角色多步推进 (保留 tools, 允许 query→search→preview 连续走)
                    if (mcpToolResolve) setSearchStatus('正在整理 MCP 工具结果...');
                    // 排程现状现算一次贴上：本轮刚排的任务这时才进得了清单，角色下一轮
                    // 看到的是自己名下真实的排程，不会对着排程前的空清单再排一条。
                    // 收尾那一跳按最后一轮渲染：正文模式下不再教排程语法。
                    const followMessages = withAmsg2TaskContext(loopMessages, forceWrapUp);
                    if (wrapUp.prompt) followMessages.push({ role: 'user', content: wrapUp.prompt });
                    const followBody = { ...baseReqBody, messages: followMessages };
                    if (forceWrapUp) {
                        delete followBody.tools;
                        delete followBody.tool_choice;
                    }
                    const loopPurpose = payload.flags.luckinChatActive
                        ? '瑞幸点单续写'
                        : mcpCallsThisRound > 0
                            ? 'MCP 工具续写'
                            : '排程工具续写';
                    data = await replyStep(async () => safeFetchJson(`${baseUrl}/chat/completions`, {
                        signal: replyRun.signal,
                        method: 'POST', headers,
                        body: JSON.stringify(followBody)
                    }, 2, 0, { appId: 'chat', appName: '消息', charId: char.id, charName: char.name, purpose: loopPurpose }));
                    updateTokenUsage(data, historyMsgCount, `${payload.flags.luckinChatActive ? 'luckin-chat' : 'mcp-chat'}-${it + 1}`);
                    if (forceWrapUp) break;
                }
                // 主动消息工具跑过、整个循环却一句正文都没有（常见于排成功之后：它觉得话在工具轮
                // 已经说完了）——补一轮不带 tools 的请求让它开口。收尾那一轮留空、前面工具轮写过话的
                // 不补：前面那些就是这次的输出。
                let emptyRescued = false;
                if (shouldRescueEmptyToolLoop({
                    toolRounds: amsg2ToolRounds,
                    leadInCount: amsg2LeadIns.length + displayedMcpLeadIns.size,
                    finalContent: data.choices?.[0]?.message?.content || '',
                    finalHasToolCalls: !!data.choices?.[0]?.message?.tool_calls?.length,
                })) {
                    emptyRescued = true;
                    toolPhaseClosed = true;
                    const rescueBody = {
                        ...baseReqBody,
                        messages: [...withAmsg2TaskContext(loopMessages, true), { role: 'user', content: AMSG2_EMPTY_REPLY_PROMPT }],
                    };
                    delete (rescueBody as any).tools;
                    delete (rescueBody as any).tool_choice;
                    data = await replyStep(async () => safeFetchJson(`${baseUrl}/chat/completions`, {
                        signal: replyRun.signal,
                        method: 'POST', headers,
                        body: JSON.stringify(rescueBody),
                    }, 2, 0, { appId: 'chat', appName: '消息', charId: char.id, charName: char.name, purpose: '排程后补充回复' }));
                    updateTokenUsage(data, historyMsgCount, 'amsg2-empty-rescue');
                }
                toolLoopHistory = loopMessages;
                if (amsg2ToolRounds > 0) {
                    // 这一轮工具循环怎么收的尾：几轮工具、有没有被逼收尾、有没有补救空回、
                    // 最后拼出来的回话多长。跟上面每次调用那几条对着看，就知道空回卡在哪一步。
                    appendInstantTraceEntry({
                        ts: new Date().toISOString(),
                        event: 'amsg2-local-tool-loop',
                        charId: char.id,
                        toolRounds: amsg2ToolRounds,
                        wrapUp: wrapUpKind,
                        emptyRescued,
                        leadIns: amsg2LeadIns.length,
                        replyChars: mergeToolRoundLeadIns(amsg2LeadIns, data.choices?.[0]?.message?.content || '').length,
                    });
                }
                if (mcpToolResolve) setSearchStatus('');
            }

            // 3.6b MCP 掉格式容错（第二层, 对标见面观测协议的两层容错）:
            //     不支持 function calling 的模型会把工具调用写成正文文字, 如
            //     ask_question("SullyOS") / ask_question: SullyOS。这里检测出来
            //     系统代为执行, 把结果喂回去让角色重新组织语言, 用户就看不到乱码了。
            //     连续调用指纹防止模型复读同一调用导致副作用工具重复执行；中间若有别的
            //     动作，则允许用同参重新查询已经变化的状态。
            //     正文模式（amsg2ToolMode === 'text'）下由 3.6c 统一处理，这里不跑。
            //     原生循环已经发过最后一轮的话也不跑：那一轮回复里写的调用不执行（收尾时剥掉、留 trace）。
            if (mcpToolResolve && amsg2ToolMode !== 'text' && !toolPhaseClosed) {
                const MAX_TEXT_LOOPS = MCP_CHAT_MAX_TOOL_LOOPS;
                let lastExecutedSig: string | null = null;
                let textLoopMessages: any[] | null = null;
                for (let it = 0; it < MAX_TEXT_LOOPS; it++) {
                    const contentNow: string = data.choices?.[0]?.message?.content || '';
                    // 兼容协议约定每轮只发一行。一次只执行一个，既让 12 轮真正按步骤自适应，
                    // 也避免一段失控正文批量触发多个副作用。
                    const allFaked = extractTextFakedMcpCalls(contentNow, mcpToolResolve).slice(0, 1);
                    const faked = allFaked
                        .filter(c => toolCallFingerprint(c.exposedName, c.args) !== lastExecutedSig);
                    // 兼容模式没有原生 tool_call id，模型重复写同名同参时绝不能再次执行
                    // 副作用工具；给一次强制收尾请求，把已经拿到的结果组织成人话。
                    if (allFaked.length > 0 && faked.length === 0) {
                        if (!textLoopMessages) textLoopMessages = [...baseReqBody.messages];
                        textLoopMessages.push({ role: 'assistant', content: contentNow });
                        textLoopMessages.push({
                            role: 'user',
                            content: MCP_REPEATED_WRAP_UP_PROMPT,
                        });
                        toolPhaseClosed = true;
                        const wrapBody = buildMcpTextFallbackBody(baseReqBody, withoutMcpCompatTeaching(textLoopMessages));
                        data = await replyStep(async () => safeFetchJson(`${baseUrl}/chat/completions`, {
                            signal: replyRun.signal,
                            method: 'POST', headers,
                            body: JSON.stringify(wrapBody)
                        }, 2, 0, { appId: 'chat', appName: '消息', charId: char.id, charName: char.name, purpose: 'MCP 工具收尾回复' }));
                        updateTokenUsage(data, historyMsgCount, `mcp-text-wrap-${it + 1}`);
                        break;
                    }
                    if (!faked.length) break;
                    console.warn(`🔌 [MCP] 检测到 ${faked.length} 个正文假工具调用, 代为执行:`, faked.map(c => c.exposedName).join(', '));
                    await replyStep(async () => persistMcpLeadIn(contentNow, faked));
                    setSearchStatus(`正在调用 MCP 工具：${faked.map(c => c.exposedName).join('、')}...`);
                    const results: string[] = [];
                    for (const call of faked) {
                        lastExecutedSig = toolCallFingerprint(call.exposedName, call.args);
                        results.push(await executeFakedMcpCall(call));
                    }
                    const reachedHardLimit = it + 1 >= MAX_TEXT_LOOPS;
                    if (!textLoopMessages) textLoopMessages = [...baseReqBody.messages];
                    textLoopMessages.push({ role: 'assistant', content: contentNow });
                    textLoopMessages.push({
                        role: 'user',
                        content: buildFakedToolResultsMessage(results, reachedHardLimit),
                    });
                    if (reachedHardLimit) {
                        textLoopMessages.push({
                            role: 'user',
                            content: TOOL_LOOP_FINAL_ROUND_PROMPT,
                        });
                        toolPhaseClosed = true;
                    }
                    setSearchStatus('正在整理 MCP 工具结果...');
                    // 最后一轮不再教正文调用语法。
                    const followBody = buildMcpTextFallbackBody(
                        baseReqBody, reachedHardLimit ? withoutMcpCompatTeaching(textLoopMessages) : textLoopMessages,
                    );
                    data = await replyStep(async () => safeFetchJson(`${baseUrl}/chat/completions`, {
                        signal: replyRun.signal,
                        method: 'POST', headers,
                        body: JSON.stringify(followBody)
                    }, 2, 0, { appId: 'chat', appName: '消息', charId: char.id, charName: char.name, purpose: 'MCP 工具续写' }));
                    updateTokenUsage(data, historyMsgCount, `mcp-text-${it + 1}`);
                    if (reachedHardLimit) break;
                }
                setSearchStatus('');
            }

            // 3.6c 正文模式（「原生 tools」开关关着，或中转拒 tools 降级之后）的正文调用循环。
            //     这一模式下 MCP 也走正文兼容协议，两种调用可能同轮出现，也可能在续写里接着冒出来，
            //     所以由同一个循环一起认（上面 3.6b 不跑）。
            //     排程与云端同一口径：从正文抠出 schedule_active_message({...}) 代为执行、结果回喂；执行器
            //     （同名同参去重、连发上限）、卡住计数、收尾提示与原生工具循环共用，这一轮写下的话作为开场白
            //     留下、调用语法剥掉。MCP 部分照 3.6b：每轮只执行一个，连续同名同参直接收尾。
            if (amsg2ToolMode === 'text') {
                // 带 MCP 时与 3.6b 同一上限，只有排程时与原生排程循环同一上限。
                const maxTextLoops = mcpToolResolve ? MCP_CHAT_MAX_TOOL_LOOPS : 6;
                const textLoopHistory: any[] = [...(toolLoopHistory ?? baseReqBody.messages)];
                let lastMcpSig: string | null = null;
                let usedMcp = false;
                let textWrapUp: ReturnType<typeof resolveToolLoopWrapUp> = { kind: 'none', prompt: null };
                // 前面的原生循环已经发过最后一轮的话，那一轮的回复里写出的调用不再执行（收尾时剥掉、留 trace）。
                for (let it = 0; !toolPhaseClosed && it < maxTextLoops; it++) {
                    const contentNow: string = data.choices?.[0]?.message?.content || '';
                    const scheduleRound = takeAmsg2TextScheduleCalls(contentNow);
                    const mcpAll = mcpToolResolve
                        ? extractTextFakedMcpCalls(scheduleRound.rest, mcpToolResolve).slice(0, 1)
                        : [];
                    const mcpCalls = mcpAll.filter(c => toolCallFingerprint(c.exposedName, c.args) !== lastMcpSig);
                    const mcpRepeated = mcpAll.length > 0 && mcpCalls.length === 0;
                    if (!scheduleRound.calls.length && !mcpAll.length) break;
                    const results: string[] = [];
                    if (mcpCalls.length) {
                        usedMcp = true;
                        // MCP 轮的开场白当场落库（同 3.6b），排程语法先剥掉。
                        await replyStep(async () => persistMcpLeadIn(scheduleRound.rest, mcpCalls));
                        setSearchStatus(`正在调用 MCP 工具：${mcpCalls.map(c => c.exposedName).join('、')}...`);
                        for (const call of mcpCalls) {
                            lastMcpSig = toolCallFingerprint(call.exposedName, call.args);
                            results.push(await executeFakedMcpCall(call));
                        }
                    } else if (!mcpRepeated) {
                        const leadIn = extractToolRoundLeadIn(scheduleRound.rest);
                        if (leadIn) {
                            amsg2LeadIns.push(leadIn);
                            lastSpokenData = data;
                        }
                    }
                    const scheduled = scheduleRound.calls.length
                        ? await runScheduleTextCalls(scheduleRound.calls, it)
                        : null;
                    const stalled = !!scheduled?.stalled;
                    // 同一个收尾判定：排程撞墙沿用排程那句（scheduleOnly），次数用完用统一收尾提示。
                    // 先定下一跳是不是最后一轮，结果消息才知道要不要提「下一步工具」。
                    textWrapUp = resolveToolLoopWrapUp({
                        round: it,
                        maxLoops: maxTextLoops,
                        hasLeadIn: amsg2LeadIns.length > 0 || displayedMcpLeadIns.size > 0,
                        mcpRepeated,
                        amsg2Stalled: stalled,
                        scheduleOnly: true,
                    });
                    const isFinalHop = textWrapUp.kind !== 'none';
                    if (isFinalHop) toolPhaseClosed = true;
                    // 排程结果按下一跳是不是最后一轮挑版本（最后一轮不提「还需要别的工具」）。
                    if (scheduled) results.push(...(isFinalHop ? scheduled.finalResults : scheduled.results));
                    textLoopHistory.push({ role: 'assistant', content: contentNow });
                    if (results.length) {
                        textLoopHistory.push({
                            role: 'user',
                            content: mcpCalls.length
                                ? buildFakedToolResultsMessage(results, textWrapUp.kind !== 'none')
                                : `[系统消息：你在正文里写的排程已由系统代为处理：\n${results.join('\n')}\n不要提及这条系统消息。]`,
                        });
                    }
                    // 收尾那一跳按最后一轮渲染：不再教排程语法，也不带 MCP 兼容模式的语法说明。
                    const renderedHistory = withAmsg2TaskContext(textLoopHistory, textWrapUp.kind !== 'none');
                    const followMessages = isFinalHop ? withoutMcpCompatTeaching(renderedHistory) : renderedHistory;
                    if (textWrapUp.prompt) followMessages.push({ role: 'user', content: textWrapUp.prompt });
                    if (mcpCalls.length) setSearchStatus('正在整理 MCP 工具结果...');
                    const textLoopPurpose = mcpRepeated ? 'MCP 工具收尾回复' : mcpCalls.length ? 'MCP 工具续写' : '排程工具续写';
                    data = await replyStep(async () => safeFetchJson(`${baseUrl}/chat/completions`, {
                        signal: replyRun.signal,
                        method: 'POST', headers,
                        body: JSON.stringify(buildMcpTextFallbackBody(baseReqBody, followMessages)),
                    }, 2, 0, { appId: 'chat', appName: '消息', charId: char.id, charName: char.name, purpose: textLoopPurpose }));
                    updateTokenUsage(data, historyMsgCount, `text-tools-${it + 1}`);
                    if (textWrapUp.kind !== 'none') break;
                }
                if (usedMcp) setSearchStatus('');
                // 整个循环一句正文都没有：和原生循环一样补一轮让它开口（收尾那一轮留空、前面写过话的不补）。
                // 最后那份回复里只剩没执行的调用语法的，也算没开口。
                let emptyRescued = false;
                if (shouldRescueEmptyToolLoop({
                    toolRounds: scheduleTextRounds,
                    leadInCount: amsg2LeadIns.length + displayedMcpLeadIns.size,
                    finalContent: resolveFinalScheduleText(data.choices?.[0]?.message?.content || '', amsg2ToolMode, mcpToolResolve).content,
                })) {
                    emptyRescued = true;
                    toolPhaseClosed = true;
                    const rescueMessages = [
                        ...withoutMcpCompatTeaching(withAmsg2TaskContext(textLoopHistory, true)),
                        { role: 'user', content: AMSG2_EMPTY_REPLY_PROMPT },
                    ];
                    data = await replyStep(async () => safeFetchJson(`${baseUrl}/chat/completions`, {
                        signal: replyRun.signal,
                        method: 'POST', headers,
                        body: JSON.stringify(buildMcpTextFallbackBody(baseReqBody, rescueMessages)),
                    }, 2, 0, { appId: 'chat', appName: '消息', charId: char.id, charName: char.name, purpose: '排程后补充回复' }));
                    updateTokenUsage(data, historyMsgCount, 'amsg2-empty-rescue');
                }
                if (scheduleTextRounds > 0) {
                    appendInstantTraceEntry({
                        ts: new Date().toISOString(),
                        event: 'amsg2-local-tool-loop',
                        charId: char.id,
                        protocol: 'text',
                        toolRounds: scheduleTextRounds,
                        wrapUp: textWrapUp.kind,
                        emptyRescued,
                        leadIns: amsg2LeadIns.length,
                    });
                }
            }

            // DEBUG: Log full API response details for troubleshooting truncation issues
            console.log('🔍 [API Response Debug]', JSON.stringify({
                finish_reason: data.choices?.[0]?.finish_reason,
                usage: data.usage,
                content_length: data.choices?.[0]?.message?.content?.length,
                raw_content: data.choices?.[0]?.message?.content,
                reasoning_content: data.choices?.[0]?.message?.reasoning_content,
                reasoning_content_length: data.choices?.[0]?.message?.reasoning_content?.length,
                model: data.model,
                id: data.id,
            }, null, 2));

            // ─── 后处理管线 (13 步) ───
            // 详见 utils/applyAssistantPostProcessing.ts。本地路径跑完整管线；
            // 云端回复（activeMsgRuntime 冲刷收件箱）也调它，带 skipSecondPassLLM=true 和
            // worker 识别好的 directives 重放。
            // 后处理会逐条写库/刷新，第一条落库并不代表其余气泡已准备好。
            // 整轮结束前保持预览，登记对应正式消息供 UI 暂时隐藏；全部落库后再一起交接。
            const previewHandoverIds = new Set<number>();
            const previewBaselineMaxId = contextMsgs.reduce(
                (maxId, message) => Math.max(maxId, message.id),
                Number.NEGATIVE_INFINITY,
            );
            const setMessagesWithPreviewHandover = (msgs: Message[]) => {
                const newlyHandedOverIds = findNewStreamPreviewHandoverIds(
                    msgs,
                    latestStreamPreviewBubbles,
                    previewBaselineMaxId,
                    previewHandoverIds,
                );
                const handoverIds = new Set(newlyHandedOverIds);
                if (streamThinkingShown) {
                    const thinkingHost = msgs.find(message =>
                        message.id > previewBaselineMaxId && message.role === 'assistant'
                    );
                    if (thinkingHost && !previewHandoverIds.has(thinkingHost.id)) handoverIds.add(thinkingHost.id);
                }
                if (handoverIds.size > 0) {
                    handoverIds.forEach(id => previewHandoverIds.add(id));
                    // ref 在 setMessages 触发渲染前同步更新，首帧就能关掉正式气泡的 fade-in。
                    onStreamPreviewHandover?.(char.id, [...handoverIds]);
                    setStreamingHandoverIds([...previewHandoverIds]);
                }
                setMessages(msgs);
            };
            // 工具轮里说过的话拼在最前面（没有工具轮时 amsg2LeadIns 是空的，原样取最后一轮）；
            // SAR 信封生效期若跨多轮输出了信封，逐轮拆解后再合并去重真意与外显。
            const finalRoundContentRaw: string = data.choices?.[0]?.message?.content || '';
            // 正文模式：工具轮开场白里的排程调用都已代为执行，语法剥掉；最终正文里还剩的是最后一轮
            // （或补救那一轮）写出来的，不执行，同样剥掉，并留 trace 让这件事查得到（见 resolveFinalScheduleText）。
            const finalSchedule = resolveFinalScheduleText(finalRoundContentRaw, amsg2ToolMode, mcpToolResolve, toolPhaseClosed);
            const finalRoundContent = finalSchedule.content;
            if (finalSchedule.unexecuted > 0 || finalSchedule.unexecutedMcp > 0) {
                console.warn(`[amsg2] 最后一轮写出了 ${finalSchedule.unexecuted} 个排程、${finalSchedule.unexecutedMcp} 个 MCP 调用，工具阶段已收尾，不执行、从显示文本剥掉`);
                appendInstantTraceEntry({
                    ts: new Date().toISOString(),
                    event: 'amsg2-text-schedule-unexecuted',
                    charId: char.id,
                    count: finalSchedule.unexecuted,
                    mcpCount: finalSchedule.unexecutedMcp,
                });
            }
            if (amsg2ToolMode === 'text') {
                const cleanedLeadIns = amsg2LeadIns.map(stripAmsg2ScheduleSyntax).filter(leadIn => leadIn.trim());
                amsg2LeadIns.splice(0, amsg2LeadIns.length, ...cleanedLeadIns);
            }
            const sarReply = amsg2LeadIns.length && sarModulePlan.requiresEnvelope
                ? parseSARModuleReplyRounds([...amsg2LeadIns, extractToolRoundLeadIn(finalRoundContent)], sarModulePlan)
                : parseSARModuleReply(
                    amsg2LeadIns.length ? mergeToolRoundLeadIns(amsg2LeadIns, finalRoundContent) : finalRoundContent,
                    sarModulePlan,
                );
            const effectivePostProcessData = extractToolRoundLeadIn(finalRoundContent)
                ? data
                : (lastSpokenData ?? data);
            const latestUserMessage = findSARTurnUserMessage(currentMsgs);
            const sarModuleEvents = createSARModuleEventMeta(sarModulePlan);
            const userSurfaces = parseSARUserSurfaces(sarReply.userSurface,
                selectSARUserSurfaceTargets(contextMsgs, char.id, sarModulePlan.user));
            for (const [messageId, surface] of userSurfaces) {
                const meta = createSARModuleSurfaceMeta(sarModulePlan.user!, surface);
                if (meta) await replyStep(async () => DB.updateMessageMetadata(messageId, previous => ({
                    ...(previous || {}), sarModuleSurface: meta,
                })));
            }
            if (latestUserMessage?.id && sarModuleEvents.length > 0) {
                await replyStep(async () => DB.updateMessageMetadata(latestUserMessage.id, previous => ({
                    ...(previous || {}),
                    ...(sarModuleEvents.length > 0 ? { sarModuleEvents } : {}),
                })));
            }
            const assistantSurfaceMeta = sarModulePlan.character?.phase === 'active' && sarReply.assistantSurface
                ? createSARModuleSurfaceMeta(sarModulePlan.character, sarReply.assistantSurface)
                : undefined;
            const xhsCaches: XhsCaches = {
                xsecTokenCache: xsecTokenCacheRef.current,
                noteTitleCache: noteTitleCacheRef.current,
                commentUserIdCache: commentUserIdCacheRef.current,
                commentAuthorNameCache: commentAuthorNameCacheRef.current,
                commentParentIdCache: commentParentIdCacheRef.current,
            };
            await replyStep(async () => applyAssistantPostProcessing(sarReply.canonical, {
                replyRun,
                char,
                userProfile,
                emojis,
                categories,
                realtimeConfig,
                groups,
                contextMsgs,
                fullMessages,
                initialData: effectivePostProcessData,
                historyMsgCount,
                mcdInheritMeta,
                xhsCaches,
                api: {
                    baseUrl,
                    headers,
                    effectiveApi,
                },
                hooks: {
                    setMessages: setMessagesWithPreviewHandover,
                    addToast,
                    setRecallStatus,
                    setSearchStatus,
                    setDiaryStatus,
                    setXhsStatus,
                    updateTokenUsage,
                    // 整组 musicHooks 由 MusicProvider 注册到模块级 slot, 本地 fetch 路径和
                    // 云端回复的冲刷 (activeMsgRuntime) 共享同一份, 见 MusicContext.loadMusicHooks.
                    musicHooks: loadMusicHooks() ?? undefined,
                },
                // 流式预览已把气泡展示过 → 落库免打字延迟，秒回填（未预览时行为不变）
                instantRender: streamPreviewShown,
                // Phase 0: 本地 fetch 路径保持原逻辑, 不跳 2nd-pass LLM, 也没有结构化 directives。
                skipSecondPassLLM: false,
                directives: [],
                sarModuleSurface: assistantSurfaceMeta,
            }));
            replyRun.markCompleted();
            // 最后一批正式消息已交给 setMessages；同一轮更新撤掉预览，不再逐条补弹。
            setStreamingBubbles([]);
            setStreamingThinking('');

            // 到这里说明正文已成功落库。失败 / 中断不会经过；重掷是替换旧回合，不重复扣寿命。
            if (!skipEmotionInjection) {
                if (sarModulePlan.character) {
                    updateCharacter(char.id, previous => ({
                        vrState: { ...(previous.vrState || { enabled: false, intervalMinutes: 120 }), sarModule: advanceSARModuleAfterReply(previous.vrState?.sarModule, sarModulePlan.character) },
                    }));
                }
                if (sarModulePlan.user) {
                    updateUserProfile(previous => ({
                        vrState: { ...(previous.vrState || { enabled: false }), sarModule: advanceSARModuleAfterReply(previous.vrState?.sarModule, sarModulePlan.user) },
                    }));
                }
            }

            // 本地路径回复已全部落库。OSContext 监听这个事件 bump lastMsgTimestamp——
            // 当前挂载的 Chat（可能是切走又切回后新 mount 的实例，本闭包的 setMessages
            // 对它已失效）会重新 reloadMessages；用户不在该会话时补未读 + toast。
            // 即时对话路径不发：它的落库回落走 'active-msg-received'（activeMsgRuntime）。
            announceChatGen(CHAT_GEN_EVENTS.replyArrived, { charId: char.id, charName: char.name });

            // 防穿帮闸：仅当这轮请求真的成功、回执确实进了模型上下文并产出已落库的
            // 回复，才标记已告知；失败/中断路径不标，下轮重新注入（回执不丢）。
            // 放在 try 成功尾部（回复已 applyAssistantPostProcessing 落库），与 catch/finally 互斥；
            // 即时对话路径在上方已 return，这里只覆盖本地 fetch 路径。
            if (amsg2ExpiredIds.length) {
                void ActiveMsgStore.markExpiredNoticesNotified(char.id, amsg2ExpiredIds);
            }
            if(friendFeedMainTask)await acknowledgeFriendFeedNotices(char.id,friendFeedMainTask.id).catch(()=>{});

        } catch (e: any) {
            if (!replyRun.signal.aborted) sendProgress.failed();
            if (replyRun.signal.aborted) return;
            // 注意: 这个 catch 兜的是「拿到 API 响应之后」的整条后处理管线 (applyAssistantPostProcessing,
            // 13 步)。这里抛错多半不是网络问题, 而是解析/正则/落库异常。别再叫"连接中断"误导排查。
            const errMsg = formatUnknownError(e, '未知处理异常');
            if (showError && ((e as any)?.__sullyUpstreamStreamError || /API Error\b|Failed to fetch|Load failed|NetworkError|API返回了|API流式响应|输出被截断|模型.*格式不正确/i.test(errMsg))) {
                showError('聊天回复失败', errMsg, effectiveApi);
            }
            // 瑞一杯模式下报错: 大概率是聊天模型/中转不支持 function calling(tools) → 带 tools 一发就 400。
            // 在 APK 里看不到控制台, 这里把完整原因 + 解法存成可读消息, 方便排查。
            if (luckinChatRef?.current?.active && /\b400\b|tool|function[_\s-]?call/i.test(errMsg)) {
                await DB.saveMessage({
                    charId: char.id, role: 'system', type: 'text',
                    content: `[瑞一杯失败] ${errMsg}\n\n大概率是你当前聊天用的「模型/中转」不支持函数调用(function calling / tools)——瑞一杯靠角色自己调工具点单, 模型不支持就会直接报 400。\n解决: 换一个支持 tools 的模型/中转 (如官方 OpenAI / Claude / 多数主流中转)。\n另外确认: APK 是全新存储, 你的聊天 API 配置(密钥/地址/模型)在 APK 里填好了吗?`,
                });
            } else {
                await DB.saveMessage({ charId: char.id, role: 'system', type: 'text', content: `[回复处理失败: ${errMsg}]` });
            }
            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
        } finally {
            replyRun.signal.removeEventListener('abort', cancelSendProgress);
            sendProgress.finish(replyRun.signal.aborted);
            try {
                await replyRun.settle();
                if (replyRun.signal.aborted) setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
            } catch (error) {
                console.error('[chat-stop] 回复收尾失败', error);
            } finally { releaseReply(); }
            setLocalTyping(false);
            KeepAlive.stop();
            // 本轮生成结束（成功/失败/中断都经过）→ 停止本地续租；远端靠 45s TTL 自然失效。
            // 未开过租约（即时对话 / 非 amsg2 角色）时是幂等 no-op。
            stopAmsgChatPresence(char.id);
            // 全局横幅熄灭（成功/失败/即时对话均经过这里；OSContext 同时借它兜底刷新，
            // 覆盖 catch 里落库的错误系统消息）。
            announceChatGen(CHAT_GEN_EVENTS.replyEnd, { charId: char.id, charName: char.name });
            setStreamingBubbles([]);  // 错误/中断路径兜底清预览
            setStreamingThinking('');
            setStreamingHandoverIds([]);
            setRecallStatus('');
            setSearchStatus('');
            setDiaryStatus('');
            setXhsStatus('');

            // 满血主动消息：一轮聊完把该角色标脏，fire_pack 随即批量同步到 worker 的
            // client_state（未配 amsg2 任务的角色在 markDirty 内直接忽略，零成本）。
            // 本轮角色自己排过任务时 char 快照上的清单已经过期，得用工具会话里的最新那份
            // 打脏——否则本轮新建的首个任务过不了 markDirty 的 hasActiveAiTask 门，
            // fire_pack 会停在排程那一刻、少掉角色排完之后说的这段。
            // 即时对话受理成功那一轮跳过：那次 POST 已经把这一轮的 fire_pack（还多带了
            // chat 段）传上去了，这里再打脏就是同样的内容再走一趟网络。
            if (friendFeedMainTask && !instantChatAccepted) {
                await releaseFriendFeedEmotionTask(char.id, friendFeedMainTask.id)
                    .catch(error => console.warn('[Friend feed] Main task release failed', error));
            }
            if (!instantChatAccepted) {
                markAmsgStateDirty({
                    char: { ...char, activeMsg2Config: amsg2Session.getConfig() },
                    userProfile, groups, realtimeConfig,
                });
            }

            // Memory Palace — 后台缓冲区处理（不阻塞 UI，内部有并发锁）
            // 使用全局配置（memoryPalaceConfig）。lightLLM 未配置时回退主 apiConfig；
            // embedding 因端点类型特殊（/embeddings），不做回退，必须显式配置。
            const mpEmb = memoryPalaceConfig?.embedding;
            const resolvedMpLLM = resolveAuxiliaryApi(memoryPalaceConfig?.lightLLM, apiConfig);
            const mpLLM = {
                baseUrl: resolvedMpLLM.baseUrl,
                apiKey: resolvedMpLLM.apiKey || '',
                model: resolvedMpLLM.model,
                ...(resolvedMpLLM.apiType ? { apiType: resolvedMpLLM.apiType } : {}),
            };
            // 读 ref 拿到最新的 char 状态；同 id 才信任，否则保守跳过（用户已经切角色了）
            const liveChar = !replyRun.signal.aborted && charRef.current?.id === char.id ? charRef.current : null;
            if (liveChar?.memoryPalaceEnabled && mpEmb?.baseUrl && mpEmb?.apiKey && mpLLM.baseUrl) {
                const charName = char.name;
                // 不再预置"正在回味"状态：pipeline 会在水位线未到时立刻 skip，
                // 预置状态会让"沉思"指示器一闪让用户误以为在干活。
                // onProgress 在 pipeline 真正进入处理路径后（过完 hot_zone/threshold 检查）
                // 才首次触发 setMemoryPalaceStatus，这样 skip 路径下指示器不会亮。

                // 缓冲区处理（LLM提取 + Embedding向量化）
                const recentMsgs = await DB.getRecentMessagesByCharId(char.id, 50);
                processNewMessagesWithAutoArchive(recentMsgs, char.id, charName, mpEmb, mpLLM, userProfile?.name || '', false, (stage) => {
                        setMemoryPalaceStatus(stage);
                    })
                    .then(async (pipelineResult) => {
                        // pipeline 跑的过程中用户可能又关掉了宫殿，跑完后所有"额外动作"
                        // （autoArchive 写 char.memories / 50 轮认知消化的 LLM 调用）都要再 check 一次。
                        const liveAfter = charRef.current?.id === char.id ? charRef.current : null;
                        if (!liveAfter?.memoryPalaceEnabled) return;

                        // 显示结果让用户看到
                        if (pipelineResult && pipelineResult.stored > 0) {
                            setMemoryPalaceResult(pipelineResult);
                        }

                        // 全自动记忆双写已由统一封装完成，React 外的入口也不会再漏接返回值。
                        // 轮数计数 + 自动认知消化（每50轮触发一次）
                        const shouldAutoDigest = incrementDigestRound(char.id);
                        if (shouldAutoDigest) {
                            console.log(`🧠 [AutoDigest] 已达 50 轮，自动触发认知消化...`);
                            setMemoryPalaceStatus(`${charName}闭上眼睛，开始整理内心…`);
                            const persona = [char.systemPrompt || '', char.worldview || ''].filter(Boolean).join('\n');
                            const result = await runCognitiveDigestion(
                                char.id, charName, persona, mpLLM, false, userProfile?.name, mpEmb,
                                // 消化链路可能含多次 LLM 调用（审视→历史回填续传→门牌整理），
                                // 实时刷状态条让用户知道后台在干活、别急着关页面
                                (stage) => setMemoryPalaceStatus(`${charName}${stage}`),
                            );
                            if (result) {
                                // 自我领悟不再追加到 char.selfInsights（只进不出的旧常驻层）——
                                // 归宿已改为 self_room 门牌（digestion 内部提交），这里只负责弹窗昭告
                                const total = result.resolved.length + result.deepened.length + result.faded.length +
                                    result.fulfilled.length + result.disappointed.length + result.internalized.length +
                                    result.synthesizedUser.length + result.selfInsights.length + result.selfConfused.length +
                                    (result.worries?.length || 0) + (result.aspirations?.length || 0) + (result.distilled?.length || 0);
                                if (total > 0) {
                                    setLastDigestResult(result);
                                }
                            }
                        }
                    })
                    .catch(e => { console.error('❌ [MemoryPalace] 后台处理异常:', formatUnknownError(e)); addToast('记忆整理失败', 'error'); })
                    .finally(() => {
                        // 如果状态文本包含"完成"，先让用户看到再清除
                        const current = memoryPalaceStatusRef.current;
                        if (current && current.includes('完成')) {
                            addToast(current, 'success');
                        }
                        setMemoryPalaceStatus('');
                    });
            }

            // 意识流进化现在由副 API 的情绪评估同轮产出（innerState 字段），
            // 不再需要独立的后台 API 调用，也不再分散主 API 注意力。
        }
    };



    return {
        isTyping,
        streamingBubbles,
        streamingThinking,
        streamingHandoverIds,
        inboxStatus,
        recallStatus,
        searchStatus,
        diaryStatus,
        xhsStatus,
        emotionStatus,
        memoryPalaceStatus,
        memoryPalaceResult,
        setMemoryPalaceResult,
        lastDigestResult,
        setLastDigestResult,
        lastTokenUsage,
        tokenBreakdown,
        setLastTokenUsage, // Allow manual reset if needed
        triggerAI,
        lastSystemPrompt,
        evolvedNarrative,
    };
};
