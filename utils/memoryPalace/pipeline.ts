import { isChatConversationEntry } from './trace';

import { readMaintenanceSettings } from './maintenanceMode';
import { loadRangeMessageContents } from './rangeMessagePage';
import { loadCharacterContextMessages } from '../chatContextRange';
/**
 * Memory Palace — 集成管线 (Pipeline)
 *
 * 对外暴露两个主要函数：
 * 1. retrieveMemories() — 检索管线，AI 回复前调用
 * 2. processNewMessages() — 缓冲区机制，AI 回复后后台调用
 *
 * 缓冲区机制（替代旧的 TopicLoom + 封盒方案）：
 * - 热区：按角色档位保留最近一段消息在聊天上下文
 * - 缓冲区：热区之前、高水位之后的消息
 * - 缓冲区达到角色档位阈值时触发：LLM 提取记忆 → Embedding → 更新高水位
 * - 保留缓冲区尾部 15% 作为下次提取的上下文衔接
 *
 * LLM 调用策略：
 * - 记忆提取 → 用 LightLLMConfig（来自 memoryPalaceConfig.lightLLM 全局副 API，
 *   与情绪 API emotionConfig.api 完全独立）
 * - retrieveMemories() 本身仍是纯检索；ChatApp 每轮只做纯本地 Context Analyzer，
 *   帮主模型理解当下话语的承接方式，不额外调用 LLM，也不改变旧召回排序
 */

import type { CharacterAccommodationPolicy, MemoryPalaceWaterlineConfig, Message } from '../../types';
import type { EmbeddingConfig, EventBox, MemoryNode, PersonalityStyle, RemoteVectorConfig, ScoredMemory } from './types';
import {
    countOneShotPendingMessages,
    countUnprocessedBufferMessages,
    getOneShotTargetHighWaterMark,
} from './bufferCount';
import {
    DEFAULT_MEMORY_PALACE_WATERLINE,
    resolveMemoryPalaceWaterline,
} from './waterline';

/** 从 localStorage 读取远程向量配置（避免在每个调用点都传参） */
function getRemoteVectorConfig(): RemoteVectorConfig | undefined {
    try {
        const raw = localStorage.getItem('os_remote_vector_config');
        if (!raw) return undefined;
        const config = JSON.parse(raw) as RemoteVectorConfig;
        return (config.enabled && config.initialized) ? config : undefined;
    } catch { return undefined; }
}

/** 从 localStorage 读取 rerank 配置。关闭或未配齐时返回 undefined，调用方跳过。 */
interface StoredRerankConfig {
    enabled?: boolean;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    topN?: number;
}
function getRerankConfig(): { baseUrl: string; apiKey: string; model: string; topN: number } | undefined {
    try {
        const raw = localStorage.getItem('os_memory_palace_config');
        if (!raw) return undefined;
        const parsed = JSON.parse(raw);
        const r: StoredRerankConfig | undefined = parsed?.rerank;
        if (!r?.enabled || !r.baseUrl || !r.apiKey || !r.model) return undefined;
        return {
            baseUrl: r.baseUrl,
            apiKey: r.apiKey,
            model: r.model,
            topN: Math.max(1, Math.min(20, r.topN ?? 5)),
        };
    } catch { return undefined; }
}
import { extractMemoriesFromBuffer } from './extraction';
import type { RelatedMemoryRef, PinnedMemoryRef } from './extraction';
import { fetchRelatedMemoriesForExtraction, sampleSnippetsFromMessages, splitMessagesToSpikes } from './relatedMemories';
import { getReceiptIdsInRange } from './recallReceipts';
import { vectorizeAndStore, checkModelConsistency, rebuildAllVectors } from './vectorStore';
import { buildLinks, strengthenCoActivated } from './links';
import { hybridSearch } from './hybridSearch';
import { getEmbeddings } from './embedding';
import { isRemoteSearchBroken } from './vectorSearch';
import { spreadActivation } from './activation';
import { applyPriming, checkRumination } from './priming';
import { expandAndFormat } from './formatter';
import { runConsolidation } from './consolidation';
import { rerankDocuments } from './rerank';
// 认知消化由用户在记忆宫殿 App 手动触发，不在聊天管线中自动运行
import { MemoryNodeDB, MemoryVectorDB, MemoryLinkDB, AnticipationDB, EventBoxDB } from './db';
import { DB } from '../db';
import { isMessageSemanticallyRelevant, formatMessageForPrompt } from '../messageFormat';
import { sanitizeQuerySourceMessages } from './querySanitizer';
import { getLocalDateKey } from '../localDate';
import { extractExternalMemoryText } from './externalMemory';
import {
    analyzeLocalContext,
    RECALL_GATE_ROUTE_THRESHOLD,
    type RecallPlan,
} from './recallRouter';
import {
    analyzeExplicitEntitySignals,
    lookupExplicitEntityCandidates,
    mergeExplicitEntityCandidates,
    type ExplicitEntityAnalysis,
} from './explicitEntityRecall';
import {
    buildEventBoxLightIndex,
    lookupEventBoxLightCandidates,
    mergeEventBoxLightCandidates,
} from './eventBoxLightIndex';
import { analyzeUserInteraction } from './interactionAdaptation';
import { analyzeDeepEngagement } from './deepEngagement';
import {
    analyzeConversationEngagement,
    clearConversationEngagementState,
    shouldUseLegacyDeepEngagement,
} from './conversationEngagement';
import {
    createRecallTrace,
    finishRecallTrace,
    type RecallEntryPoint,
    type RecallRetrievalTelemetry,
    type RecallTrace,
    type RecallTraceStage,
} from './trace';
import {
    getLocalMemoryPalaceHighWaterMark,
    getReliableMemoryPalaceHighWaterMark,
    setReliableMemoryPalaceHighWaterMark,
} from './highWaterMark';

// ─── 轻量 LLM 配置类型 ───────────────────────────────

/**
 * 轻量 LLM 配置，用于记忆提取等后台任务。
 * 来源是 memoryPalaceConfig.lightLLM（全局副 API），与情绪 API（emotionConfig.api）独立。
 * 这样可以用便宜快速的小模型（如 DeepSeek-V2-Lite、GLM-4-Flash）
 * 而不是主聊天模型。
 */
export interface LightLLMConfig {
    /** Manual wizard: compression must not start another plate request. */
    deferPlateMaintenance?: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
}

// ─── 日期区间记忆加载 ────────────────────────────────

/**
 * 按 createdAt 区间从本地取记忆节点。
 * - 过滤当前 charId、仅 embedded、非 summary
 * - archived 节点也参与匹配（它们保留原事件的 createdAt）；命中后路由到其 EventBox 的 summary
 * - 每个 range 最多返回 5 条，整体去重
 */
async function loadMemoriesByDateRanges(
    charId: string,
    ranges: Array<{ start: number; end: number }>,
): Promise<import('./types').MemoryNode[]> {
    if (ranges.length === 0) return [];
    const all = await MemoryNodeDB.getByCharId(charId);
    const out: import('./types').MemoryNode[] = [];
    const seen = new Set<string>();
    for (const range of ranges) {
        const inRange = all.filter(n => n.createdAt >= range.start && n.createdAt < range.end && n.embedded !== false);
        const sorted = inRange.sort((a, b) => b.importance - a.importance).slice(0, 5);
        for (const n of sorted) {
            // archived 节点 → 路由到其 box 的 summary（如果有）
            if (n.archived && n.eventBoxId) {
                const { EventBoxDB } = await import('./db');
                const box = await EventBoxDB.getById(n.eventBoxId);
                if (box?.summaryNodeId) {
                    if (seen.has(box.summaryNodeId)) continue;
                    const sum = await MemoryNodeDB.getById(box.summaryNodeId);
                    if (sum && !sum.archived) {
                        seen.add(sum.id);
                        out.push(sum);
                        continue;
                    }
                }
                // 没有 summary 就跳过（archived 独行条不该返回）
                continue;
            }
            if (seen.has(n.id)) continue;
            seen.add(n.id);
            out.push(n);
        }
    }
    return out;
}

// ─── 自动归档建议构造 ────────────────────────────────

/**
 * 把一批 MemoryNode 按 createdAt 日期 group，合成 YAML bullets 格式的 MemoryFragment 候选。
 *
 * 格式：
 *   date: "2026-04-17"
 *   summary: "- 我今天看 user 跟朋友吵架，心里担了好一会儿\n- 我今晚和 user 聊到了编程"
 *   mood: 'palace'
 *
 * 同日期多条记忆会合并成一条 MemoryFragment（summary 里多行 bullets）。
 * caller 拿到后还要和 char.memories 里已存在的同日期 'palace' 条目 merge，
 * 避免一天多次 buffer 触发产生重复条目。
 *
 * 返回 null：memories 为空（没有新记忆，不需要归档动作）。
 */
export function buildAutoArchiveFragments(
    memories: { id: string; content: string; createdAt: number }[],
    hideBeforeMessageId: number,
    linkToPalace = false,
): NonNullable<PipelineResult['autoArchive']> | null {
    if (memories.length === 0) return null;
    if (linkToPalace) return {
        hideBeforeMessageId,
        fragments: memories.map(memory => ({
            id: `mp_link_${memory.id}`,
            date: getLocalDateKey(new Date(memory.createdAt)),
            summary: memory.content,
            mood: 'palace',
            palaceMemoryId: memory.id,
        })),
    };

    const fmtDate = (ts: number): string => {
        const d = new Date(ts);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    // 按日期 group；同一天内按 createdAt 升序
    // 零 LLM 调用：palace extraction 那 1 次已经按"基础规则 + 用户追加风格"产出了
    // 第一人称、控制字数的 content（见 extraction.ts 的 buildRulesBlock + 追加风格），
    // 这里直接拼 bullets 就行。想要自定义风格 → 在"记忆归档设置"里选模板即可，
    // extraction 阶段就会把用户模板作为额外风格偏好塞进 palace LLM 系统提示词。
    const byDate = new Map<string, string[]>();
    const sortedMems = [...memories].sort((a, b) => a.createdAt - b.createdAt);
    for (const m of sortedMems) {
        const date = fmtDate(m.createdAt);
        const arr = byDate.get(date) || [];
        arr.push(`- ${m.content.replace(/\n/g, ' ').trim()}`);
        byDate.set(date, arr);
    }

    const fragments: { id: string; date: string; summary: string; mood: string }[] = [];
    for (const [date, bullets] of byDate) {
        fragments.push({
            id: `mp_auto_${date}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            date,
            summary: bullets.join('\n'),
            mood: 'palace',
        });
    }

    fragments.sort((a, b) => a.date.localeCompare(b.date));
    return { fragments, hideBeforeMessageId };
}


/**
 * 把新产出的 palace MemoryFragment 合并进已有 char.memories。
 *
 * 策略：
 *  - 已有同日期的 mood='palace' 条目 → 把新的 bullets 追加到它的 summary 里（合并）
 *  - 没有同日期的 mood='palace' → 作为新条目追加
 *  - 其它 mood（手动归档 'archive' 等）的同日期条目不碰，让它们并存
 *
 * 好处：同一天多次 buffer 触发不会产生多条 palace 记录；手动归档和自动归档互不冲突。
 */
export function mergePalaceFragmentsIntoMemories(
    existing: import('../../types').MemoryFragment[],
    incoming: { id: string; date: string; summary: string; mood: string; palaceMemoryId?: string }[],
): import('../../types').MemoryFragment[] {
    if (incoming.length === 0) return existing;

    // 先按 date 建 index：只关心 mood='palace' 的
    const palaceByDate = new Map<string, number>(); // date → index in result
    const result = existing.slice();
    for (let i = 0; i < result.length; i++) {
        const m = result[i];
        if (m.mood === 'palace' && !m.palaceMemoryId) palaceByDate.set(m.date, i);
    }

    for (const frag of incoming) {
        if (result.some(memory => memory.id === frag.id)) continue;
        if (frag.palaceMemoryId) {
            // Never merge a new link into a pre-upgrade daily snapshot, even on the same date.
            if (!result.some(memory => memory.palaceMemoryId === frag.palaceMemoryId)) result.push(frag);
            continue;
        }
        const existingIdx = frag.mood === 'palace' ? palaceByDate.get(frag.date) : undefined;
        if (existingIdx !== undefined) {
            // merge：把新 bullets 直接追加到 summary。
            // 不做字符串去重——LLM 偶尔写出相同短句的合法情况会被误杀，
            // high-water-mark 已保证消息不会被重复处理；尾部 15% 回滚那几条
            // 即使被重提，多一条 bullet 比丢数据强。
            const old = result[existingIdx];
            const existingBullets = old.summary.split('\n').map(s => s.trim()).filter(Boolean);
            const newBullets = frag.summary.split('\n').map(s => s.trim()).filter(Boolean);
            result[existingIdx] = {
                ...old,
                summary: [...existingBullets, ...newBullets].join('\n'),
            };
        } else {
            result.push(frag);
            if (frag.mood === 'palace') palaceByDate.set(frag.date, result.length - 1);
        }
    }

    return result;
}

// ─── 检索管线（AI 回复前） ────────────────────────────

/**
 * 从消息列表末尾拆分"当前一轮"的两个语义部分：
 *
 * 调用时机是 AI 回复前，所以消息末尾通常是：
 *   ... [user] [user] [assistant] [user] [user] [user]
 *                                     └─── userIntent ───┘
 *                   └──────── contextTurns ────────┘
 *
 * - userIntent：末尾连续 user 消息 —— 用户刚说的话，是本次检索的真正主语。
 *   作为**主 query**，短而关键的词（"外公"、"2025年11月29日"）不会被
 *   char 的长回复稀释。
 *
 * - contextTurns：更早的 assistant 回复 + 上一轮 user 消息 —— 话题延续语境。
 *   作为**副 query**，提供背景召回，但分数会被折扣，永远不会压过 userIntent。
 *
 * 总计 cap 在 15 条，user 最多占 10 条留出 context 预算。
 */
function splitLastTurnQueries(messages: Message[]): {
    userIntent: Message[];
    contextTurns: Message[];
    /** 旧版拼接形式，仅用于兜底（userIntent 为空时） */
    fallbackAll: Message[];
} {
    if (messages.length === 0) return { userIntent: [], contextTurns: [], fallbackAll: [] };

    const MAX = 15;
    const USER_CAP = 10;
    const userIntent: Message[] = [];
    const contextTurns: Message[] = [];
    let i = messages.length - 1;

    // Phase 1: 末尾连续 user 消息（用户刚发的）→ userIntent
    while (i >= 0 && messages[i].role === 'user' && userIntent.length < USER_CAP) {
        userIntent.unshift(messages[i]);
        i--;
    }

    const contextBudget = MAX - userIntent.length;

    // Phase 2: 紧邻的 assistant 回复（上一轮角色回答）→ contextTurns
    while (i >= 0 && messages[i].role === 'assistant' && contextTurns.length < contextBudget) {
        contextTurns.unshift(messages[i]);
        i--;
    }

    // Phase 3: 再往回收集连续 user 消息（上一轮用户输入）→ contextTurns
    while (i >= 0 && messages[i].role === 'user' && contextTurns.length < contextBudget) {
        contextTurns.unshift(messages[i]);
        i--;
    }

    const fallbackAll = [...contextTurns, ...userIntent];
    return {
        userIntent,
        contextTurns,
        fallbackAll: fallbackAll.length > 0 ? fallbackAll : messages.slice(-3),
    };
}

/**
 * 检索记忆并格式化为可注入 System Prompt 的 Markdown
 *
 * 注意：检索管线全程纯计算 + Embedding API，不调 LLM。
 *
 * @param queryOverride App 自定义上下文（场景、题目等），会与最近一轮对话拼接后一起检索
 */
export interface RecallRetrievalOptions {
    explicitEntityAnalysis?: ExplicitEntityAnalysis;
    /** 预留 Resolver 补救 query：只增加检索支路，不替换原始 user spikes。 */
    recallPlan?: RecallPlan;
    /** 调用方专用的最终召回/格式化上限；默认聊天仍保持 15。 */
    formatterMaxOutputItems?: number;
    /** 隐去召回结果上的现实日期与「今天/距今X天」标注（用于虚构剧场与关掉线下时间感知的见面）。 */
    omitDates?: boolean;
}

export async function retrieveMemories(
    recentMessages: Message[],
    charId: string,
    embeddingConfig: EmbeddingConfig,
    currentMood?: string,
    personalityStyle: PersonalityStyle = 'emotional',
    ruminationTendency: number = 0.3,
    queryOverride?: string,
    userName?: string,
    remoteVectorConfig?: RemoteVectorConfig,
    charName?: string,
    onTelemetry?: (telemetry: RecallRetrievalTelemetry) => void,
    recallOptions?: RecallRetrievalOptions,
): Promise<string> {
    // ── 分段计时：定位 memoryPalace 到底是网络慢还是计算慢 ──
    // tag: NET = 远端 API RTT；IDB = IndexedDB 读写；CPU = 纯本地计算
    const perfRetrieveT0 = performance.now();
    const retrieveTimings: Array<{ label: string; ms: number; kind: 'NET' | 'IDB' | 'CPU' }> = [];
    const tRetrieve = async <T>(label: string, kind: 'NET' | 'IDB' | 'CPU', p: Promise<T>): Promise<T> => {
        const t0 = performance.now();
        try { return await p; }
        finally { retrieveTimings.push({ label, kind, ms: Math.round(performance.now() - t0) }); }
    };
    let explicitEntityTelemetry: RecallRetrievalTelemetry['explicitEntity'];
    let eventBoxMetadataTelemetry: RecallRetrievalTelemetry['eventBoxMetadata'];
    try {
        // 1. 构建查询 —— per-message 多路检索策略：
        //
        //    问题：任何形式的"把多条 user 消息 join 成一段 embedding"都会出现
        //          稀释问题。无论真正的意图在 burst 的开头、中间还是结尾，
        //          短而精的信号都会被周围的闲语/寒暄/语气词淹没。
        //
        //    方案：每条有意义的 user 消息（≥ 4 字，去重）独立跑一次 hybridSearch。
        //          合并时同一条记忆取所有 per-msg 搜索中的最高分，这样：
        //          - "今天我要回家看家人啦" 作为独立 query 时 embedding 质心
        //            直接落在"家/家人"语义空间，命中家庭类记忆
        //          - "晚上好" / "你在做什么" 这些独立 query 只会命中寒暄类
        //            记忆（分数低），不会干扰真正意图的召回
        //
        //    context query：assistant 回复 + 更早 user 消息 + queryOverride。
        //                  （背景话题延续，分数 × 0.5 折扣，不会压过 user 意图）
        //
        //    query 源清洗（querySanitizer）：图片/表情包/语音不进 query——
        //    图片 content 是几万字符的 base64 data URI，URL_RE 剥不掉，
        //    切进 spike/rerank/context 会把 Embedding 批量请求顶爆
        //    （硅基流动 400 code 20015）。卡片类翻成可读文本再参与检索。
        const querySourceMessages = sanitizeQuerySourceMessages(recentMessages, charName, userName);
        const { userIntent, contextTurns, fallbackAll } = splitLastTurnQueries(querySourceMessages);

        // 抽取每条有意义的 user 消息作为独立 spike + 二次拆分子 spike
        //
        // 过滤原则：
        // 1. 剥离 URL（表情包/图片/外链 URL 在 embedding 里是随机噪声，没有语义）
        // 2. 剥离 URL 后，再剥掉所有标点和空白来计算"有意义字符数"
        // 3. 有意义字符数 < MIN_SPIKE_LEN 的 pass（纯标点/单字语气词/"……"等）
        // 4. 同内容去重
        //
        // MIN_SPIKE_LEN=2 而不是 4：中文里 2 字已经可以成词（"晚安""回家""想你"
        // "外公""生气"），如果阈值设 4 会误伤大量短而关键的中文测试性输入。
        // 被过滤的只有 1 字的"嗯""好""?""哦""哈"类纯语气词，以及"……""。。。"
        // 这类纯标点输入——它们 embedding 方向随机，BM25 也匹配不上任何东西。
        //
        // 注意：query 文本仍然用"剥 URL 后"的原始 trim 版本（保留标点），
        // 只在判长度时才看"剥光标点的有意义字符数"。这样"晚安……"这种
        // 带尾随省略号的合法输入能进池，且 query 里完整保留上下文。
        //
        // 二次拆分（sub-spike）：
        //   一条消息内部如果有标点/空格分隔多段语义（DateApp 见面模式的
        //   叙述格式 `"对白" 旁白 "对白"`、或者用户在一条消息里用逗号/
        //   句号串了多件事），单一 spike 会让真实意图被气泡内的其他片段
        //   稀释。把消息按 [\s\p{P}]+ 拆成子片段，每个 ≥ MIN_SPIKE_LEN 的
        //   子片段也作为独立 spike 入池（label 后缀 a/b/c/...）。原消息
        //   仍保留作 u<N>，捕获跨片段的整体语境。
        //
        //   这不是"扩搜索面"——子 spike 比原 spike 更短更专注，每路 query
        //   质心更精准（不是更宽），所以不会出现 joined / 候选池扩大那种
        //   "泛情感记忆借宽匹配反超"的问题。机制方向相反。
        const MIN_SPIKE_LEN = 2;
        const MAX_SPIKES = 10;
        const MAX_SUB_SPIKES_PER_MSG = 5;
        const URL_RE = /https?:\/\/\S+/gi;
        const PUNCT_WS_RE = /[\s\p{P}]/gu;
        const SPLIT_RE = /[\s\p{P}]+/gu;
        const seenSpike = new Set<string>();
        const userSpikes: { label: string; text: string; originalIdx: number }[] = [];
        userIntent.forEach((m, idx) => {
            const stripped = m.content.replace(URL_RE, ' ').trim();
            const text = stripped.slice(0, 2000);
            const meaningfulChars = text.replace(PUNCT_WS_RE, '');
            if (meaningfulChars.length < MIN_SPIKE_LEN) return;
            if (seenSpike.has(text)) return;
            seenSpike.add(text);
            const baseLabel = `u${idx + 1}`;
            userSpikes.push({ label: baseLabel, text, originalIdx: idx });

            // 二次拆分：消息内部有多段语义时，每段也作为子 spike
            const segments = text.split(SPLIT_RE)
                .map(s => s.trim())
                .filter(s => s.length > 0 && s !== text && s.replace(PUNCT_WS_RE, '').length >= MIN_SPIKE_LEN);
            let subIdx = 0;
            for (const seg of segments) {
                if (subIdx >= MAX_SUB_SPIKES_PER_MSG) break;
                if (seenSpike.has(seg)) continue;
                seenSpike.add(seg);
                subIdx++;
                const subLabel = `${baseLabel}${String.fromCharCode(96 + subIdx)}`; // a,b,c,...
                userSpikes.push({ label: subLabel, text: seg, originalIdx: idx });
            }
        });
        // 保留最后 MAX_SPIKES 条（如果超过上限，优先保留最近的）
        const effectiveSpikes = userSpikes.slice(-MAX_SPIKES);
        const routerSpikes = recallOptions?.recallPlan?.route
            ? recallOptions.recallPlan.queries.map((query, index) => ({
                label: `r${index + 1}`,
                text: query.text,
                scope: query.scope,
                weight: query.weight,
                source: query.source,
            }))
            : [];
        const eventBoxRouterSpikes = routerSpikes.filter(spike => spike.scope === 'event_box');

        const contextQuery = [queryOverride, contextTurns.map(m => m.content).join('\n')]
            .filter(Boolean)
            .join('\n')
            .slice(0, 2000);
        const userQueryJoined = userIntent.map(m => m.content).join('\n'); // 仅用于日志显示原始 userIntent 文本

        // 兜底：极端情况下末尾没有任何可用的 user spike（如冷启动首轮，或全是语气词）
        const fallbackQuery = effectiveSpikes.length > 0
            ? ''
            : [queryOverride, fallbackAll.map(m => m.content).join('\n')]
                  .filter(Boolean)
                  .join('\n')
                  .slice(0, 2000);

        if (effectiveSpikes.length === 0 && !contextQuery.trim() && !fallbackQuery.trim()) {
            onTelemetry?.({ outcome: 'empty', reason: 'no_effective_query' });
            return '';
        }

        // ─── 调试日志：打印所有 query ─────────────────────────
        console.groupCollapsed(`🏰 [Retrieve] ═══ 检索开始 ═══`);
        console.log(`👤 userIntent: ${userIntent.length} 条消息，其中 ${effectiveSpikes.length} 条进入 per-msg 搜索`);
        if (userQueryJoined && effectiveSpikes.length < userIntent.length) {
            console.log(`   (被过滤的 ${userIntent.length - effectiveSpikes.length} 条：长度 < ${MIN_SPIKE_LEN} 字或重复内容)`);
        }
        effectiveSpikes.forEach(s => {
            console.log(`  🎯 ${s.label} (${s.text.length} 字): ${s.text.replace(/\n/g, ' ↵ ')}`);
        });
        routerSpikes.forEach(s => {
            console.log(`  🧭 ${s.label} [${s.scope}|w=${s.weight.toFixed(2)}${s.source ? `|${s.source}` : ''}] (${s.text.length} 字): ${s.text.replace(/\n/g, ' ↵ ')}`);
        });
        console.log(`📄 context query (${contextQuery.length} 字，${contextTurns.length} 条 context 消息):`);
        console.log(contextQuery || '(空)');
        if (fallbackQuery) {
            console.log(`⚠️  fallback query (${fallbackQuery.length} 字):`);
            console.log(fallbackQuery);
        }
        console.groupEnd();

        // 2. 混合搜索（并行）
        //    - 每条 user spike：原样打分（权重 1.0）
        //    - context：分数 × CONTEXT_DISCOUNT 折扣
        //    合并时同一条记忆取 max(所有 spike 分, context 分×折扣)
        //
        //    per-query 返回 30 条，最终合并按调用方上限裁剪（普通聊天 15）。
        //    原因：如果每路只返回最终上限，同一类主题（如"外公"）的多条
        //    记忆中，排名较低的几条会在 per-query 阶段就被切掉，永远
        //    进不到合并池。扩大 per-query 容量让"同主题的次要记忆"
        //    也有机会竞争最终名次。
        const CONTEXT_DISCOUNT = 0.5;
        const PER_QUERY_TOP_K = 30;
        const FINAL_TOP_K = Math.max(1, Math.min(30, Math.floor(recallOptions?.formatterMaxOutputItems ?? 15)));

        // 辅助：把 ScoredMemory 格式化成一行摘要
        const now = Date.now();
        const fmt = (r: ScoredMemory, prefix: string = '') => {
            const ageDays = Math.floor((now - r.node.createdAt) / (1000 * 60 * 60 * 24));
            const preview = r.node.content.slice(0, 50).replace(/\n/g, ' ');
            return `${prefix}[${r.node.room}|imp=${r.node.importance}|${ageDays}d前] `
                + `sim=${r.similarity.toFixed(3)} bm25=${r.bm25Score.toFixed(3)} `
                + `→ final=${r.finalScore.toFixed(3)}  "${preview}${r.node.content.length > 50 ? '...' : ''}"`;
        };

        let results: ScoredMemory[] = [];
        let explicitNodesSnapshot: MemoryNode[] | undefined;
        let explicitEventBoxesSnapshot: EventBox[] | undefined;
        // 记录每条记忆被哪些 spike / context 命中以及各自分数
        type TraceEntry = {
            spikeScores: Map<string, number>; // label → finalScore
            contextScore?: number; // 原始分（未折扣）
        };
        const sourceTrace = new Map<string, TraceEntry>();

        // ── Rerank 并行准备 ──
        // Rerank 原本是主召回彻底跑完才串行启动的独立管线，拖后腿严重。
        // 现在把 rerank 的 embedding 塞进主 prefetch 批、pool hybridSearch 塞进主 Promise.all、
        // rerankDocuments 在 pool 就绪时立即 fire，只在最后 tail 等一下 dedup。
        // 这样 rerank 几乎整段都跟主路后半段并行跑。
        const rerankConfig = getRerankConfig();
        const joinedUserQuery = (rerankConfig && userIntent.length > 0)
            ? userIntent.map(m => m.content).join(' ').trim().slice(0, 2000)
            : '';
        const doRerank = !!(rerankConfig && joinedUserQuery);
        const RERANK_POOL_SIZE = 50;
        type RerankApiResult = {
            pool: ScoredMemory[];
            rrResults: Array<{ index: number; relevance_score: number }>;
        };
        // 由下面的 spike / fallback 分支各自赋值；tail 只 await 这个拿最终结果
        let rerankApiPromise: Promise<RerankApiResult | null> = Promise.resolve(null);

        if (effectiveSpikes.length > 0) {
            // 并行：每条 spike + context
            //
            // 历史教训：曾经加过 joined query 路径（所有 spike 拼成一条长 query
            // 并行检索）期望"BM25 跨气泡叠加"能提升主题收敛场景的召回。但
            // 实测反而变差——长 query 的 BM25 会被**泛情感高 imp 记忆**的
            // 随机 token 碰撞累积到虚高分，挤掉 per-message 本来精准的焦点
            // 命中。这和之前候选池 30→60 被回滚是同一类错误：任何"扩大
            // 搜索面"的机制都让泛情感记忆凭 imp/recency 反超 topic-specific
            // 记忆。回滚。

            // ─── Prefetch：把 K 路 hybridSearch 各自会做的公共 IO 抽上来一次性做完 ───
            //
            // 原实现：每路 hybridSearch 各自 ①调一次 embedding API ②扫一遍
            //         memory_nodes 索引 ③扫一遍 memory_vectors 索引。
            //         K 路 = 3K 倍重复 IO，Embedding API 还每路一次 RTT。
            //
            // 优化：
            //   1. 所有 query 文本合批一次 getEmbeddings → 省 (K-1) 次 RTT。
            //      Embedding API 对 input: [] 数组里的每条独立打向量，数学上等价。
            //   2. allNodes / allVectors 在 pipeline 一次性预取，透传给每路
            //      hybridSearch → K 路看同一份快照，retrieve 内部一致性反而更好。
            //   3. 远程向量路径不消费 allVectors，所以远程开启且没熔断时跳过
            //      allVectors 预取，避免无效 IO。
            const contextQueryTrimmed = contextQuery.trim();
            const searchPaths = [
                ...effectiveSpikes.map(spike => ({
                    label: spike.label,
                    text: spike.text,
                    kind: 'user' as const,
                    scope: 'memory' as const,
                    multiplier: 1,
                })),
                ...routerSpikes.map(spike => ({
                    label: spike.label,
                    text: spike.text,
                    kind: 'router' as const,
                    scope: spike.scope,
                    // Resolver 是补充信号：高权重时接近原始支路，低权重时仍保守降权。
                    multiplier: 0.65 + 0.35 * spike.weight,
                })),
            ];
            // 把 rerank 的 joined query 也塞进同一次 getEmbeddings，共享 embedding RTT
            const queriesToEmbed: string[] = [
                ...searchPaths.map(path => path.text),
                ...(contextQueryTrimmed ? [contextQuery] : []),
                ...(doRerank ? [joinedUserQuery] : []),
            ];
            const useRemoteVector = !!(
                remoteVectorConfig?.enabled && remoteVectorConfig.initialized && !isRemoteSearchBroken()
            );
            const [queryVectors, allNodes, allVectors, allEventBoxes] = await Promise.all([
                tRetrieve(`getEmbeddings(${queriesToEmbed.length})`, 'NET', getEmbeddings(queriesToEmbed, embeddingConfig)),
                tRetrieve('MemoryNodeDB.getByCharId', 'IDB', MemoryNodeDB.getByCharId(charId)),
                useRemoteVector
                    ? Promise.resolve(undefined)
                    : tRetrieve('MemoryVectorDB.getAllByCharId', 'IDB', MemoryVectorDB.getAllByCharId(charId)),
                recallOptions?.explicitEntityAnalysis?.hasSignals || eventBoxRouterSpikes.length > 0
                    ? tRetrieve('EventBoxDB.getByCharId(recall)', 'IDB', EventBoxDB.getByCharId(charId))
                    : Promise.resolve(undefined),
            ]);
            explicitNodesSnapshot = allNodes;
            explicitEventBoxesSnapshot = allEventBoxes;

            const pathPromises = searchPaths.map((path, i) =>
                hybridSearch(path.text, charId, embeddingConfig, PER_QUERY_TOP_K, remoteVectorConfig, {
                    queryVector: queryVectors[i],
                    allNodes,
                    allVectors,
                }).then(pathResults => path.scope === 'event_box'
                    ? pathResults.filter(result => Boolean(result.node.eventBoxId || result.node.isBoxSummary))
                    : pathResults)
            );
            const contextPromise = contextQueryTrimmed
                ? hybridSearch(contextQuery, charId, embeddingConfig, PER_QUERY_TOP_K, remoteVectorConfig, {
                    queryVector: queryVectors[searchPaths.length],
                    allNodes,
                    allVectors,
                })
                : Promise.resolve([] as ScoredMemory[]);

            // Rerank 的 pool hybridSearch 跟主路一起发（共享 backend RTT）
            // 不放进主 Promise.all —— 我们要把 pool 回来这事做成独立管线，
            // pool 一到就 fire rerankDocuments，不被主路 post-search 阻塞。
            //
            // ⚠️ 隐式契约：这里和 spikePromises / contextPromise 复用同一份
            //    prefetched allVectors，N 路并发共享一个 ArrayBuffer 池。
            //    这能成立是因为 vectorSearch.ts 的 canTransferCandidates =
            //    !prefetchedVectors 守卫在 prefetch 场景下禁用了 postMessage
            //    的 Transferable 路径，避免首个路径 transfer 把 buffer neuter
            //    成全 0 让后续路径静默返空。如果动 vectorSearch 那段逻辑，
            //    grep 这条注释 —— rerank pool 会是第一个崩的。
            const rerankPoolPromise: Promise<ScoredMemory[]> = doRerank
                ? hybridSearch(joinedUserQuery, charId, embeddingConfig, RERANK_POOL_SIZE, remoteVectorConfig, {
                    queryVector: queryVectors[queriesToEmbed.length - 1],
                    allNodes,
                    allVectors,
                }).catch(e => {
                    console.warn(`🎯 [Rerank] pool 检索失败（主召回不受影响）: ${e?.message || e}`);
                    return [] as ScoredMemory[];
                })
                : Promise.resolve([] as ScoredMemory[]);

            if (doRerank) {
                rerankApiPromise = (async (): Promise<RerankApiResult | null> => {
                    const rrT0 = performance.now();
                    try {
                        const pool = await rerankPoolPromise;
                        if (pool.length === 0) {
                            console.log(`🎯 [Rerank] 独立检索候选池为空，跳过 rerank`);
                            retrieveTimings.push({ label: 'rerankDocuments(skip)', kind: 'NET', ms: Math.round(performance.now() - rrT0) });
                            return null;
                        }
                        const rerankWanted = rerankConfig!.topN;
                        const rerankAskForN = Math.min(pool.length, rerankWanted + 10);
                        const rrResults = await rerankDocuments(
                            { baseUrl: rerankConfig!.baseUrl, apiKey: rerankConfig!.apiKey, model: rerankConfig!.model },
                            joinedUserQuery,
                            pool.map(p => p.node.content),
                            rerankAskForN,
                        );
                        retrieveTimings.push({ label: 'rerankDocuments', kind: 'NET', ms: Math.round(performance.now() - rrT0) });
                        return { pool, rrResults };
                    } catch (e: any) {
                        console.warn(`🎯 [Rerank] 失败（主召回不受影响）: ${e?.message || e}`);
                        retrieveTimings.push({ label: 'rerankDocuments(err)', kind: 'NET', ms: Math.round(performance.now() - rrT0) });
                        return null;
                    }
                })();
            }

            const hybridKind: 'NET' | 'CPU' = useRemoteVector ? 'NET' : 'CPU';
            const [contextResults, ...spikeResultsArr] = await tRetrieve(
                `hybridSearch×${pathPromises.length + (contextQueryTrimmed ? 1 : 0)}`,
                hybridKind,
                Promise.all([contextPromise, ...pathPromises]),
            );

            // ─── 调试日志：每条 spike 的完整结果 ─────────────────
            spikeResultsArr.forEach((spikeResults, idx) => {
                const s = searchPaths[idx];
                const icon = s.kind === 'router' ? '🧭' : '🎯';
                console.groupCollapsed(`🏰 [Retrieve] ${icon} ${s.label} 搜命中 ${spikeResults.length} 条 ("${s.text.slice(0, 30).replace(/\n/g, ' ')}${s.text.length > 30 ? '...' : ''}")`);
                spikeResults.forEach((r, i) => console.log(fmt(r, `#${i + 1} `)));
                console.groupEnd();
            });

            if (contextResults.length > 0) {
                console.groupCollapsed(`🏰 [Retrieve] 📄 context 搜命中 ${contextResults.length} 条（下方为折扣前原始分）`);
                contextResults.forEach((r, i) => {
                    console.log(fmt(r, `#${i + 1} `) + `  → 折扣后=${(r.finalScore * CONTEXT_DISCOUNT).toFixed(3)}`);
                });
                console.groupEnd();
            } else {
                console.log(`🏰 [Retrieve] context 搜跳过（context query 为空）`);
            }

            // 合并：每条记忆取 max(所有 spike 分, context 分×折扣)
            const merged = new Map<string, ScoredMemory>();
            spikeResultsArr.forEach((spikeResults, idx) => {
                const path = searchPaths[idx];
                const label = path.label;
                for (const r of spikeResults) {
                    const weighted = path.multiplier === 1 ? r : {
                        ...r,
                        finalScore: r.finalScore * path.multiplier,
                        roomScore: r.roomScore * path.multiplier,
                    };
                    const trace = sourceTrace.get(r.node.id) ?? { spikeScores: new Map<string, number>() } as TraceEntry;
                    trace.spikeScores.set(label, weighted.finalScore);
                    sourceTrace.set(r.node.id, trace);
                    const existing = merged.get(r.node.id);
                    if (!existing || weighted.finalScore > existing.finalScore) {
                        merged.set(r.node.id, weighted);
                    }
                }
            });
            for (const r of contextResults) {
                const trace = sourceTrace.get(r.node.id) ?? { spikeScores: new Map<string, number>() } as TraceEntry;
                trace.contextScore = r.finalScore;
                sourceTrace.set(r.node.id, trace);
                const discounted: ScoredMemory = {
                    ...r,
                    finalScore: r.finalScore * CONTEXT_DISCOUNT,
                    roomScore: r.roomScore * CONTEXT_DISCOUNT,
                };
                const existing = merged.get(r.node.id);
                if (!existing || discounted.finalScore > existing.finalScore) {
                    merged.set(r.node.id, discounted);
                }
            }

            results = [...merged.values()]
                .sort((a, b) => b.finalScore - a.finalScore)
                .slice(0, FINAL_TOP_K);

            // ─── 调试日志：合并后最终 top K ───────────────────
            console.groupCollapsed(`🏰 [Retrieve] 合并后 top ${results.length}（扩散激活/启动效应前）`);
            results.forEach((r, i) => {
                const t = sourceTrace.get(r.node.id) ?? { spikeScores: new Map<string, number>() } as TraceEntry;
                const spikeLabels = [...t.spikeScores.keys()];
                const srcTags = spikeLabels.map(l => `🎯${l}`);
                if (t.contextScore !== undefined) srcTags.push('📄');
                const tag = srcTags.join('+');
                const details: string[] = [];
                for (const [label, score] of t.spikeScores) {
                    details.push(`${label}=${score.toFixed(3)}`);
                }
                if (t.contextScore !== undefined) {
                    details.push(`ctx=${t.contextScore.toFixed(3)}×0.5=${(t.contextScore * CONTEXT_DISCOUNT).toFixed(3)}`);
                }
                console.log(fmt(r, `#${i + 1} [${tag}] `) + ` (${details.join(', ')})`);
            });
            console.groupEnd();

            console.log(`🏰 [Retrieve] 多路检索汇总：${effectiveSpikes.length} 个原始 spike + ${routerSpikes.length} 个 Resolver 补救 query + ${contextResults.length > 0 ? 'context' : '无 context'} → 合并 top ${results.length}`);
        } else {
            // 冷启动兜底：仅用 fallback 单 query
            const useRemoteVector = !!(
                remoteVectorConfig?.enabled && remoteVectorConfig.initialized && !isRemoteSearchBroken()
            );
            // 先 fire fallback 主搜 + rerank pipeline，两个独立管线并行
            const fallbackSearchPromise = hybridSearch(fallbackQuery, charId, embeddingConfig, FINAL_TOP_K, remoteVectorConfig);
            if (doRerank) {
                rerankApiPromise = (async (): Promise<RerankApiResult | null> => {
                    const rrT0 = performance.now();
                    try {
                        const pool = await hybridSearch(joinedUserQuery, charId, embeddingConfig, RERANK_POOL_SIZE, remoteVectorConfig, undefined);
                        if (pool.length === 0) {
                            console.log(`🎯 [Rerank] 独立检索候选池为空，跳过 rerank`);
                            retrieveTimings.push({ label: 'rerankDocuments(skip)', kind: 'NET', ms: Math.round(performance.now() - rrT0) });
                            return null;
                        }
                        const rerankWanted = rerankConfig!.topN;
                        const rerankAskForN = Math.min(pool.length, rerankWanted + 10);
                        const rrResults = await rerankDocuments(
                            { baseUrl: rerankConfig!.baseUrl, apiKey: rerankConfig!.apiKey, model: rerankConfig!.model },
                            joinedUserQuery,
                            pool.map(p => p.node.content),
                            rerankAskForN,
                        );
                        retrieveTimings.push({ label: 'rerankDocuments', kind: 'NET', ms: Math.round(performance.now() - rrT0) });
                        return { pool, rrResults };
                    } catch (e: any) {
                        console.warn(`🎯 [Rerank] 失败（主召回不受影响）: ${e?.message || e}`);
                        retrieveTimings.push({ label: 'rerankDocuments(err)', kind: 'NET', ms: Math.round(performance.now() - rrT0) });
                        return null;
                    }
                })();
            }
            results = await tRetrieve(
                'hybridSearch(fallback)',
                useRemoteVector ? 'NET' : 'CPU',
                fallbackSearchPromise,
            );
            console.groupCollapsed(`🏰 [Retrieve] 单 query 兜底命中 ${results.length} 条（无末尾 user 消息）`);
            results.forEach((r, i) => console.log(fmt(r, `#${i + 1} `)));
            console.groupEnd();
        }

        // 2.4 EventBox 本地轻索引：Resolver 的 event_box query 已经走完上面的旧 hybrid recall，
        //     这里再补查 box.name/tags/summary/live metadata。两路合流，不替换旧结果、不额外调 API。
        if (eventBoxRouterSpikes.length > 0) {
            const eventBoxT0 = performance.now();
            try {
                if (!explicitNodesSnapshot || !explicitEventBoxesSnapshot) {
                    [explicitNodesSnapshot, explicitEventBoxesSnapshot] = await Promise.all([
                        MemoryNodeDB.getByCharId(charId),
                        EventBoxDB.getByCharId(charId),
                    ]);
                }
                const index = buildEventBoxLightIndex(explicitNodesSnapshot, explicitEventBoxesSnapshot);
                const lookup = lookupEventBoxLightCandidates(index, eventBoxRouterSpikes);
                results = mergeEventBoxLightCandidates(
                    results,
                    lookup.candidates,
                    recallOptions?.recallPlan?.confidence ?? 0,
                );
                eventBoxMetadataTelemetry = {
                    status: lookup.candidates.length > 0 ? 'hit' : 'miss',
                    durationMs: Math.round(performance.now() - eventBoxT0),
                    queryCount: eventBoxRouterSpikes.length,
                    indexedBoxCount: index.indexedBoxCount,
                    matchedBoxCount: lookup.matchedBoxCount,
                    candidateCount: lookup.candidates.length,
                    matchSources: [...new Set(lookup.candidates.map(candidate => candidate.matchSource))],
                };
                console.log(
                    `📦 [EventBoxRecall] ${eventBoxMetadataTelemetry.status}: `
                    + `${index.indexedBoxCount} indexed / ${lookup.matchedBoxCount} matched → `
                    + `${lookup.candidates.length} additive candidates`,
                );
            } catch (e: any) {
                eventBoxMetadataTelemetry = {
                    status: 'error',
                    durationMs: Math.round(performance.now() - eventBoxT0),
                    queryCount: eventBoxRouterSpikes.length,
                    indexedBoxCount: 0,
                    matchedBoxCount: 0,
                    candidateCount: 0,
                    matchSources: [],
                };
                console.warn(`📦 [EventBoxRecall] 本地索引失败（旧召回不受影响）: ${e?.message || e}`);
            }
        }

        // 2.5 明确实体路径：精确查找独立于 vector/BM25 分数，命中项保底进入 formatter。
        //     旧节点没有 entities 时，lookup 会回退到 tags/content；EventBox 同时查 name/tags。
        const explicitAnalysis = recallOptions?.explicitEntityAnalysis;
        if (explicitAnalysis?.hasSignals) {
            const explicitT0 = performance.now();
            try {
                if (!explicitNodesSnapshot || !explicitEventBoxesSnapshot) {
                    [explicitNodesSnapshot, explicitEventBoxesSnapshot] = await Promise.all([
                        MemoryNodeDB.getByCharId(charId),
                        EventBoxDB.getByCharId(charId),
                    ]);
                }
                const lookup = lookupExplicitEntityCandidates(
                    explicitAnalysis,
                    explicitNodesSnapshot,
                    explicitEventBoxesSnapshot,
                );
                results = mergeExplicitEntityCandidates(results, lookup.candidates);
                explicitEntityTelemetry = {
                    status: lookup.candidates.length > 0 ? 'hit' : 'miss',
                    durationMs: Math.round(performance.now() - explicitT0),
                    signalCount: explicitAnalysis.signals.length,
                    matchedMemoryCount: lookup.matchedMemoryCount,
                    matchedEventBoxCount: lookup.matchedEventBoxCount,
                    guaranteedCount: lookup.candidates.length,
                };
                console.log(
                    `🔎 [EntityRecall] ${explicitEntityTelemetry.status}: `
                    + `${lookup.matchedMemoryCount} memory / ${lookup.matchedEventBoxCount} box → `
                    + `${lookup.candidates.length} guaranteed`,
                );
            } catch (e: any) {
                explicitEntityTelemetry = {
                    status: 'error',
                    durationMs: Math.round(performance.now() - explicitT0),
                    signalCount: explicitAnalysis.signals.length,
                    matchedMemoryCount: 0,
                    matchedEventBoxCount: 0,
                    guaranteedCount: 0,
                };
                console.warn(`🔎 [EntityRecall] 精确查找失败（普通召回不受影响）: ${e?.message || e}`);
            }
        }

        // 2.6 日期引用路径：从 user 意图里抽"去年12月""3月4号""上周"这类
        //     日期引用，直接按 createdAt 捞对应区间的记忆（vector/BM25 都对不准日期）。
        //     archived 节点参与日期匹配 → 路由到其 EventBox summary 返回。
        const dateT0 = performance.now();
        try {
            const { resolveDateReferences } = await import('./dateResolver');
            const queryForDates = [userQueryJoined, contextQuery, fallbackQuery].filter(Boolean).join('\n');
            const ranges = resolveDateReferences(queryForDates);
            if (ranges.length > 0) {
                console.log(`📅 [Retrieve] 检测到日期引用 ${ranges.length} 个：${ranges.map(r => `${r.label}→[${new Date(r.start).toLocaleDateString('zh-CN')}..${new Date(r.end - 1).toLocaleDateString('zh-CN')}]`).join('、')}`);
                const dateHits = await loadMemoriesByDateRanges(charId, ranges);
                const DATE_BOOST = 0.3;
                const DATE_BASE = 0.5;
                const resultIdx = new Map(results.map((r, i) => [r.node.id, i]));
                let boosted = 0, added = 0;
                for (const node of dateHits) {
                    const idx = resultIdx.get(node.id);
                    if (idx !== undefined) {
                        results[idx].finalScore += DATE_BOOST;
                        results[idx].roomScore += DATE_BOOST;
                        boosted++;
                    } else {
                        results.push({
                            node,
                            finalScore: DATE_BASE + DATE_BOOST,
                            similarity: 0,
                            bm25Score: 0,
                            roomScore: DATE_BASE + DATE_BOOST,
                        });
                        added++;
                    }
                }
                if (boosted + added > 0) {
                    console.log(`📅 [Retrieve] 日期命中加权：${boosted} 条已命中 +${DATE_BOOST}，${added} 条新增`);
                }
            }
        } catch (e: any) {
            console.warn(`📅 [Retrieve] 日期解析失败（不影响常规召回）: ${e?.message || e}`);
        }
        retrieveTimings.push({ label: 'dateResolver', kind: 'IDB', ms: Math.round(performance.now() - dateT0) });

        if (results.length === 0) {
            console.log(`🏰 [Retrieve] 混合搜索 + 日期路径均无结果，跳过记忆注入`);
            onTelemetry?.({
                outcome: 'empty',
                reason: 'no_results',
                explicitEntity: explicitEntityTelemetry,
                eventBoxMetadata: eventBoxMetadataTelemetry,
            });
            return '';
        }

        // 3. 扩散激活
        const beforeActivation = results.length;
        results = await tRetrieve('spreadActivation', 'IDB', spreadActivation(results, charId, personalityStyle));
        if (results.length !== beforeActivation) {
            console.log(`🏰 [Retrieve] 扩散激活后：${beforeActivation} → ${results.length} 条`);
        }

        // 4. 启动效应
        if (currentMood) {
            results = applyPriming(results, currentMood);
            console.log(`🏰 [Retrieve] 启动效应（mood=${currentMood}）已应用`);
        }

        // 重新排序
        results.sort((a, b) => b.finalScore - a.finalScore);

        // ─── 调试日志：扩散+启动后的候选排序
        //    formatter 会按调用方上限再砍一刀；普通聊天默认 15，活动可单独覆盖。
        //    多出来的会被标 "✂️ cut"。
        let formatterCap = FINAL_TOP_K;
        const FORMATTER_CUT = formatterCap;
        console.groupCollapsed(
            `🏰 [Retrieve] 扩散+启动后 ${results.length} 条候选（formatter 只注入前 ${Math.min(FORMATTER_CUT, results.length)} 条）`
        );
        results.forEach((r, i) => {
            const marker = i < FORMATTER_CUT ? '✅ 注入' : '✂️ cut';
            console.log(fmt(r, `#${i + 1} [${marker}] `));
        });
        console.groupEnd();

        // 5. 反刍
        const ruminatedNode = await tRetrieve('checkRumination', 'IDB', checkRumination(charId, ruminationTendency));
        if (ruminatedNode) {
            const avgScore = results.length > 0
                ? results.reduce((s, r) => s + r.finalScore, 0) / results.length
                : 0.5;
            results.push({
                node: ruminatedNode,
                finalScore: avgScore * 0.8,
                similarity: 0,
                bm25Score: 0,
                roomScore: avgScore * 0.8,
            });
        }

        // 6+7. 更新访问记录 + 共同激活加强（并发写 IDB）
        const writeT0 = performance.now();
        const retrievedIds = results.map(r => r.node.id);
        await Promise.all([
            ...retrievedIds.map(id => MemoryNodeDB.touchAccess(id)),
            retrievedIds.length >= 2 ? strengthenCoActivated(retrievedIds.slice(0, 5)) : Promise.resolve(),
        ]);
        retrieveTimings.push({ label: `idbWrites(${retrievedIds.length})`, kind: 'IDB', ms: Math.round(performance.now() - writeT0) });

        // 8. Rerank 通道（独立检索 + cross-encoder 二次排序，可选）
        //
        //   Rerank 的 pool hybridSearch 和 rerankDocuments 已经在前面跟主路
        //   一起发射了（见上文 rerankApiPromise）。tail 这里只等它并做最后的
        //   dedup / merge，绝大多数情况下 rerank 已经先主路完成了。
        //
        //   注入层面不做特别对待：rerank 追加的几条直接混入主 results，formatter
        //   按 finalScore 排序渲染。用户/LLM 不会感知是 rerank 推荐的，F12 里能看。
        if (doRerank) {
            const rerankTailT0 = performance.now();
            const rrData = await rerankApiPromise;
            if (rrData) {
                const { pool, rrResults } = rrData;
                const rerankWanted = rerankConfig!.topN;
                const mainIds = new Set(results.map(r => r.node.id));
                const rerankPicks: Array<{ sm: typeof pool[number]; rerankScore: number }> = [];
                for (const rr of rrResults) {
                    const cand = pool[rr.index];
                    if (!cand || mainIds.has(cand.node.id)) continue;
                    rerankPicks.push({ sm: cand, rerankScore: rr.relevance_score });
                    if (rerankPicks.length >= rerankWanted) break;
                }

                // F12 调试日志：能看到 rerank 选了哪几条、模型打的相关性分、
                // 以及它们原本在 hybrid 里的 finalScore
                console.groupCollapsed(
                    `🎯 [Rerank] ${rerankConfig!.model} · 独立检索池 ${pool.length} 条 · 去重后追加 ${rerankPicks.length} 条 ("${joinedUserQuery.slice(0, 40).replace(/\n/g, ' ')}${joinedUserQuery.length > 40 ? '…' : ''}")`
                );
                rerankPicks.forEach((p, i) => {
                    const preview = p.sm.node.content.slice(0, 50).replace(/\n/g, ' ');
                    const ageDays = Math.floor((Date.now() - p.sm.node.createdAt) / (1000 * 60 * 60 * 24));
                    console.log(
                        `#${i + 1} [${p.sm.node.room}|imp=${p.sm.node.importance}|${ageDays}d前] `
                        + `rerank=${p.rerankScore.toFixed(3)} hybrid=${p.sm.finalScore.toFixed(3)}  `
                        + `"${preview}${p.sm.node.content.length > 50 ? '...' : ''}"`
                    );
                });
                if (rerankPicks.length === 0) {
                    console.log('（rerank 返回的全部 top N 都已在主召回 15 条里，无新增）');
                }
                console.groupEnd();

                // touch 一下让 rerank 选中的也走 accessCount / lastAccessedAt 更新（并发）
                await Promise.all(rerankPicks.map(p => MemoryNodeDB.touchAccess(p.sm.node.id)));

                // 追加到 results；formatter 的 MAX_OUTPUT_ITEMS 上调到 15 + N
                // 不改 finalScore：保留 rerank pick 自己 hybridSearch 里的原始分，
                // 排序自然落位；但通过 formatterCap 保证它们不被切掉。
                if (rerankPicks.length > 0) {
                    results = [...results, ...rerankPicks.map(p => p.sm)];
                    formatterCap = Math.max(formatterCap, 15 + rerankPicks.length);
                }
            }
            // rerank_tail = 等 rerankApiPromise 落地 + dedup + touch，理想值接近 0
            retrieveTimings.push({ label: 'rerank_tail', kind: 'NET', ms: Math.round(performance.now() - rerankTailT0) });
        }

        // 9. 获取期盼
        const anticipations = await tRetrieve('AnticipationDB.getByCharId', 'IDB', AnticipationDB.getByCharId(charId));

        // 10. 格式化
        const formatted = await tRetrieve('expandAndFormat', 'IDB', expandAndFormat(results, charId, anticipations, userName, formatterCap, { omitDates: recallOptions?.omitDates }));

        // ── 汇总打印 ──
        const perfTotal = Math.round(performance.now() - perfRetrieveT0);
        const byKind: Record<'NET' | 'IDB' | 'CPU', number> = { NET: 0, IDB: 0, CPU: 0 };
        retrieveTimings.forEach(t => { byKind[t.kind] += t.ms; });
        const detail = retrieveTimings
            .sort((a, b) => b.ms - a.ms)
            .map(t => `${t.label}[${t.kind}]=${t.ms}ms`)
            .join(' ');
        console.log(`⏱ [retrieveMemories] total=${perfTotal}ms | NET=${byKind.NET}ms IDB=${byKind.IDB}ms CPU=${byKind.CPU}ms | ${detail}`);

        onTelemetry?.({
            outcome: formatted ? 'success' : 'empty',
            reason: formatted ? undefined : 'formatted_empty',
            explicitEntity: explicitEntityTelemetry,
            eventBoxMetadata: eventBoxMetadataTelemetry,
        });
        return formatted;

    } catch (err: any) {
        console.error(`❌ [Retrieve] 检索记忆失败:`, err.message);
        onTelemetry?.({
            outcome: 'error',
            reason: 'exception',
            explicitEntity: explicitEntityTelemetry,
            eventBoxMetadata: eventBoxMetadataTelemetry,
        });
        return '';
    }
}

/**
 * 便捷函数：检索记忆并挂到 char.memoryPalaceInjection 上。
 *
 * 各 App 在构建 System Prompt 前调用一次即可，
 * 之后 buildCoreContext 会自动读取并注入。
 *
 * @param recentMessages 可选，不传则自动从 DB 加载
 * @param queryHint 可选，App 自定义检索词（如场景描述、游戏叙事）。
 *                  传了就直接用这个检索，不走 getLastTurnMessages。
 */
/**
 * 获取全局记忆宫殿 embedding 配置。
 * 优先使用全局配置（localStorage），如果没有则回退到角色级别配置。
 */
function getEmbeddingConfig(charEmbeddingConfig?: any): EmbeddingConfig | null {
    try {
        const raw = localStorage.getItem('os_memory_palace_config');
        if (raw) {
            const global = JSON.parse(raw);
            if (global.embedding?.baseUrl && global.embedding?.apiKey) {
                return global.embedding as EmbeddingConfig;
            }
        }
    } catch {}
    // 回退到角色级别（兼容旧数据）
    if (charEmbeddingConfig?.baseUrl && charEmbeddingConfig?.apiKey) {
        return charEmbeddingConfig as EmbeddingConfig;
    }
    return null;
}

export async function injectMemoryPalace(
    char: { memoryPalaceEnabled?: boolean; embeddingConfig?: any; activeBuffs?: any[]; personalityStyle?: string; ruminationTendency?: number; interactionAccommodation?: CharacterAccommodationPolicy; id: string; name?: string; memoryPalaceInjection?: string; roomPlatesInjection?: string },
    recentMessages?: Message[],
    queryHint?: string,
    userName?: string,
    traceContext?: { entryPoint?: RecallEntryPoint; formatterMaxOutputItems?: number; omitDates?: boolean },
): Promise<RecallTrace> {
    const hadPreviousMemory = Boolean(char.memoryPalaceInjection);
    const hadPreviousRoomPlates = Boolean(char.roomPlatesInjection);
    const trace = createRecallTrace({
        charId: char.id,
        entryPoint: traceContext?.entryPoint,
        recentMessageCount: recentMessages?.length ?? null,
        hasQueryHint: Boolean(queryHint?.trim()),
        clearedPreviousMemory: false,
        clearedPreviousRoomPlates: false,
    });
    const legacyCompatibilityMode = !trace.featureFlagsSnapshot.recallRouter
        && !trace.featureFlagsSnapshot.interactionAdaptation
        && !trace.featureFlagsSnapshot.deepEngagement;

    // 总开关关闭时保留 master 的覆盖语义：只有本轮真的召回到内容才替换临时注入。
    // 新管线开启后才主动归零，避免新分析失败时复用上一轮的上下文。
    if (!legacyCompatibilityMode) {
        const clearStartedAt = performance.now();
        char.memoryPalaceInjection = '';
        char.roomPlatesInjection = '';
        trace.injection.clearedPreviousMemory = hadPreviousMemory;
        trace.injection.clearedPreviousRoomPlates = hadPreviousRoomPlates;
        trace.stages.push({
            name: 'clear_previous_injection',
            durationMs: Math.round(performance.now() - clearStartedAt),
            outcome: 'ok',
        });
    }

    let explicitEntityAnalysis: ExplicitEntityAnalysis | undefined;
    const interactiveRecall = isChatConversationEntry(trace.entryPoint) || trace.entryPoint === 'collaboration';
    if (!trace.featureFlagsSnapshot.recallRouter) {
        trace.explicitEntityRecall = { status: 'disabled' };
        trace.eventBoxMetadataRecall = { status: 'disabled' };
        trace.recallResolver = { status: 'disabled' };
    } else if (!interactiveRecall) {
        trace.explicitEntityRecall = { status: 'out_of_scope' };
        trace.eventBoxMetadataRecall = { status: 'out_of_scope' };
        trace.recallResolver = { status: 'out_of_scope' };
    } else {
        trace.eventBoxMetadataRecall = { status: 'no_query' };
        const explicitStartedAt = performance.now();
        explicitEntityAnalysis = analyzeExplicitEntitySignals(recentMessages || [], char.name, userName);
        trace.stages.push({
            name: 'explicit_signal',
            durationMs: Math.round(performance.now() - explicitStartedAt),
            outcome: 'ok',
        });
        if (explicitEntityAnalysis.hasSignals) {
            trace.recallIntent = 'explicit_entity';
            trace.explicitEntityRecall = {
                status: 'signaled',
                signalCount: explicitEntityAnalysis.signals.length,
                signalSources: [...new Set(explicitEntityAnalysis.signals.map(signal => signal.source))],
            };
        } else {
            trace.explicitEntityRecall = { status: 'no_signal' };
        }

        const analyzerStartedAt = performance.now();
        const analysis = analyzeLocalContext(
            recentMessages || [],
            char.name,
            userName,
            explicitEntityAnalysis.hasSignals,
        );
        trace.contextAnalyzer = analysis;
        trace.recallResolver = { status: 'deferred' };
        if (!explicitEntityAnalysis.hasSignals) {
            trace.recallIntent = analysis.shouldGuide ? 'implicit_reference' : 'semantic';
        }
        console.log(
            `🧭 [ContextAnalyzer] ${analysis.shouldGuide ? 'guide' : 'observe'}: `
            + `continuation=${analysis.signals.continuationNeed.toFixed(2)} `
            + `ambiguity=${analysis.signals.ambiguity.toFixed(2)} `
            + `self=${analysis.signals.selfSufficiency.toFixed(2)} `
            + `result=${analysis.signals.resultUpdate.toFixed(2)} `
            + `energy=${analysis.signals.energy.toFixed(2)} | `
            + `threshold=${RECALL_GATE_ROUTE_THRESHOLD.toFixed(2)} reasons=${analysis.reasons.join(',')}`,
        );
        trace.stages.push({
            name: 'context_analyzer',
            durationMs: Math.round(performance.now() - analyzerStartedAt),
            outcome: analysis.analyzable ? 'ok' : 'empty',
        });
    }

    if (!trace.featureFlagsSnapshot.interactionAdaptation) {
        trace.interactionAdaptation = { status: 'disabled' };
    } else if (!interactiveRecall) {
        trace.interactionAdaptation = { status: 'out_of_scope' };
    } else {
        const interactionStartedAt = performance.now();
        const interaction = analyzeUserInteraction(
            recentMessages || [],
            char.interactionAccommodation,
            char.name,
            userName,
        );
        trace.interactionAdaptation = {
            status: interaction.analyzable ? 'observed' : 'no_signal',
            analysis: interaction,
        };
        console.log(
            `🎚️ [InteractionAdaptation] ${interaction.analyzable ? 'observed' : 'no_signal'}: `
            + `impulse=${JSON.stringify(interaction.impulse)} `
            + `trend=${JSON.stringify(interaction.trend)} `
            + `policy=${JSON.stringify(interaction.policy)}`,
        );
        trace.stages.push({
            name: 'interaction_adaptation',
            durationMs: Math.round(performance.now() - interactionStartedAt),
            outcome: interaction.analyzable ? 'ok' : 'empty',
        });
    }

    if (!trace.featureFlagsSnapshot.deepEngagement) {
        trace.deepEngagement = { status: 'disabled' };
    } else if (!interactiveRecall) {
        trace.deepEngagement = { status: 'out_of_scope' };
    } else {
        const depthStartedAt = performance.now();
        const legacyRequested = shouldUseLegacyDeepEngagement();
        let engine: 'conversation_v2' | 'legacy_depth' = legacyRequested ? 'legacy_depth' : 'conversation_v2';
        let depth: ReturnType<typeof analyzeDeepEngagement> | ReturnType<typeof analyzeConversationEngagement>;
        try {
            depth = legacyRequested
                ? analyzeDeepEngagement(recentMessages || [], char.name, userName)
                : analyzeConversationEngagement(char.id, recentMessages || [], char.name, userName);
        } catch (error) {
            // M3 是质量增强层。v2 状态损坏或边界输入出错时，当轮回退旧分析，不能阻断聊天。
            console.warn('[ConversationEngagement] v2 failed, falling back to legacy depth:', error);
            clearConversationEngagementState(char.id);
            engine = 'legacy_depth';
            depth = analyzeDeepEngagement(recentMessages || [], char.name, userName);
        }
        trace.deepEngagement = {
            status: depth.analyzable ? 'observed' : 'no_signal',
            engine,
            analysis: depth,
        };
        if (engine === 'conversation_v2') {
            const engagement = depth as ReturnType<typeof analyzeConversationEngagement>;
            console.log(
                `🧭 [ConversationEngagement] core=on overlay=${engagement.shouldGuide ? 'on' : 'off'} ${engagement.conversationAct}: `
                + `${engagement.previousEngagementState}->${engagement.engagementState} `
                + `mode=${engagement.interactionMode} `
                + `act=${engagement.responsePlan.primary}${engagement.responsePlan.secondary ? `+${engagement.responsePlan.secondary}` : ''} `
                + `subject=${engagement.subject.active ? 'active' : 'idle'} `
                + `openness=${engagement.subject.openness.toFixed(2)} `
                + `stance=${engagement.stance.confidence.toFixed(2)} `
                + `reasons=${engagement.reasons.join(',')}`,
            );
        } else {
            const legacy = depth as ReturnType<typeof analyzeDeepEngagement>;
            console.log(
                `🪞 [DeepEngagement:legacy] ${legacy.analyzable ? legacy.mode : 'no_signal'}: `
                + `depth=${legacy.state.analyticalDepth.toFixed(2)} `
                + `confidence=${legacy.confidence.toFixed(2)}`,
            );
        }
        trace.stages.push({
            name: 'deep_engagement',
            durationMs: Math.round(performance.now() - depthStartedAt),
            outcome: depth.analyzable ? 'ok' : 'empty',
        });
    }

    if (!char.memoryPalaceEnabled) {
        trace.stages.push({ name: 'finalize', durationMs: 0, outcome: 'skipped' });
        return finishRecallTrace(trace, 'skipped_palace_disabled');
    }
    // 调用方没显式传 userName 时，兜底从全局用户档案取，保证各入口
    // （群聊/通话/事件/学习等）召回的房间名都统一显示「{用户名}的房间」，
    // 而不是回退成「用户房间」。
    let resolvedUserName = userName;
    if (!resolvedUserName) {
        try { resolvedUserName = (await DB.getUserProfile())?.name || undefined; } catch {}
    }

    // 门牌（常驻语义层）：纯 IDB 读 + 格式化，不调 LLM。
    // 无条件赋值（包括 ''）—— 门牌被清空/删除后，persist 过的旧注入必须被冲掉。
    const roomPlatesStartedAt = performance.now();
    let roomPlateOutcome: RecallTraceStage['outcome'] = 'ok';
    try {
        const { buildRoomPlatesInjection } = await import('./roomPlates');
        char.roomPlatesInjection = await buildRoomPlatesInjection(char.id, resolvedUserName);
    } catch {
        char.roomPlatesInjection = '';
        roomPlateOutcome = 'error';
    }
    trace.injection.roomPlateChars = char.roomPlatesInjection.length;
    trace.stages.push({
        name: 'room_plates',
        durationMs: Math.round(performance.now() - roomPlatesStartedAt),
        outcome: roomPlateOutcome,
    });

    const embeddingConfig = getEmbeddingConfig(char.embeddingConfig);
    if (!embeddingConfig) {
        trace.stages.push({ name: 'finalize', durationMs: 0, outcome: 'skipped' });
        return finishRecallTrace(trace, 'skipped_embedding_unconfigured');
    }
    try {
        const loadStartedAt = performance.now();
        const msgs = recentMessages ?? await loadCharacterContextMessages(char.id);
        trace.stages.push({
            name: 'load_messages',
            durationMs: Math.round(performance.now() - loadStartedAt),
            outcome: 'ok',
        });
        const currentMood = char.activeBuffs?.[0]?.name;
        const retrieveStartedAt = performance.now();
        let retrievalTelemetry: RecallRetrievalTelemetry | undefined;
        const context = await retrieveMemories(
            msgs, char.id, embeddingConfig,
            currentMood,
            (char.personalityStyle as PersonalityStyle) || 'emotional',
            char.ruminationTendency ?? 0.3,
            queryHint,
            resolvedUserName,
            getRemoteVectorConfig(),
            char.name,
            telemetry => { retrievalTelemetry = telemetry; },
            { explicitEntityAnalysis, formatterMaxOutputItems: traceContext?.formatterMaxOutputItems, omitDates: traceContext?.omitDates },
        );
        if (context || !legacyCompatibilityMode) {
            char.memoryPalaceInjection = context || '';
        }
        trace.retrievalReason = retrievalTelemetry?.reason;
        if (retrievalTelemetry?.explicitEntity) {
            const entity = retrievalTelemetry.explicitEntity;
            trace.explicitEntityRecall = {
                ...trace.explicitEntityRecall,
                status: entity.status,
                signalCount: entity.signalCount,
                matchedMemoryCount: entity.matchedMemoryCount,
                matchedEventBoxCount: entity.matchedEventBoxCount,
                guaranteedCount: entity.guaranteedCount,
            };
            trace.stages.push({
                name: 'entity_lookup',
                durationMs: entity.durationMs,
                outcome: entity.status === 'error' ? 'error' : entity.status === 'miss' ? 'empty' : 'ok',
            });
        }
        if (retrievalTelemetry?.eventBoxMetadata) {
            const eventBox = retrievalTelemetry.eventBoxMetadata;
            trace.eventBoxMetadataRecall = {
                status: eventBox.status,
                queryCount: eventBox.queryCount,
                indexedBoxCount: eventBox.indexedBoxCount,
                matchedBoxCount: eventBox.matchedBoxCount,
                candidateCount: eventBox.candidateCount,
                matchSources: eventBox.matchSources,
            };
            trace.stages.push({
                name: 'event_box_lookup',
                durationMs: eventBox.durationMs,
                outcome: eventBox.status === 'error' ? 'error' : eventBox.status === 'miss' ? 'empty' : 'ok',
            });
        }
        trace.injection.memoryChars = char.memoryPalaceInjection?.length ?? 0;
        trace.stages.push({
            name: 'retrieve',
            durationMs: Math.round(performance.now() - retrieveStartedAt),
            outcome: context ? 'ok' : retrievalTelemetry?.outcome === 'error' ? 'error' : 'empty',
        });
        const finalStageOutcome: RecallTraceStage['outcome'] = context
            ? 'ok'
            : retrievalTelemetry?.outcome === 'error' ? 'error' : 'empty';
        trace.stages.push({ name: 'finalize', durationMs: 0, outcome: finalStageOutcome });
        if (retrievalTelemetry?.outcome === 'error') {
            return finishRecallTrace(trace, 'error', 'retrieval_exception');
        }
        return finishRecallTrace(trace, context ? 'success' : 'empty');
    } catch (e: any) {
        console.warn(`🏰 [MemoryPalace] injectMemoryPalace failed: ${e.message}`);
        if (!legacyCompatibilityMode) char.memoryPalaceInjection = '';
        trace.injection.memoryChars = 0;
        trace.injection.roomPlateChars = char.roomPlatesInjection?.length ?? 0;
        trace.stages.push({ name: 'finalize', durationMs: 0, outcome: 'error' });
        return finishRecallTrace(trace, 'error', 'injection_exception');
    }
}

// ─── 外部摘要 / 日记一次性吞吐 ────────────────────────

/**
 * 把"交换日记"一次性塞进记忆宫殿。
 * 跟 processNewMessages 用的同一套抽取 + 向量化逻辑（lightLLM 副 API、extractMemoriesFromBuffer、
 * vectorizeAndStore），但不走缓冲区/高水位机制 —— 因为日记不是普通聊天消息，
 * 是一篇独立的、用户主动触发的归档。
 *
 * 关键差异（对比 chat 自动归档）：
 *  - 时间戳来自 diary.date，不是 Date.now() —— 这样向量记忆按 createdAt 排序时
 *    日记会落在它真正发生的那天而不是归档的那天
 *  - 不动 mp_lastMsgId_ 高水位 —— 防止把后续聊天处理跳过
 *  - 不写 EventBox 跨时间链接（日记是孤立事件，绑链接需要再过一遍消息流，价值不大）
 *
 * @param char 至少要 id / name / memoryPalaceEnabled / embeddingConfig
 * @param dateStr 日记日期 YYYY-MM-DD，决定 MemoryNode.createdAt
 * @param userDiaryText 用户那页的正文
 * @param charDiaryText 角色那页的正文（可空）
 * @param lightLLMConfig 记忆宫殿副 API
 * @param userName 用户昵称
 */
/** 一次日记归档对宫殿的具体影响, 用 status 区分各种"为什么没入宫"的情况, 供 UI 弹窗直接展示 */
export type DiaryIngestResult =
    | { status: 'palace_disabled' }
    | { status: 'lightllm_missing' }
    | { status: 'embedding_missing' }
    | { status: 'empty_input' }
    | { status: 'extracted_none'; stored: 0; skipped: 0 }
    | {
        status: 'done';
        stored: number;
        skipped: number;
        nodes: { content: string; room: import('./types').MemoryRoom; importance: number; mood: string; tags: string[] }[];
    };

export async function ingestDiaryToPalace(
    char: { id: string; name: string; memoryPalaceEnabled?: boolean; embeddingConfig?: any; systemPrompt?: string; worldview?: string },
    dateStr: string,
    userDiaryText: string,
    charDiaryText: string,
    lightLLMConfig: LightLLMConfig | null | undefined,
    userName: string,
): Promise<DiaryIngestResult> {
    if (!char.memoryPalaceEnabled) return { status: 'palace_disabled' };
    if (!lightLLMConfig?.baseUrl || !lightLLMConfig?.apiKey) {
        console.warn(`🏰 [DiaryIngest] 跳过：lightLLM 未配置`);
        return { status: 'lightllm_missing' };
    }
    const embeddingConfig = getEmbeddingConfig(char.embeddingConfig);
    if (!embeddingConfig) {
        console.warn(`🏰 [DiaryIngest] 跳过：embedding 配置未就绪`);
        return { status: 'embedding_missing' };
    }

    // 构造时间戳：YYYY-MM-DD → 当地中午 12:00（避免时区把日期撇到前一天）
    let createdAt = Date.now();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (m) {
        const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), 12, 0, 0);
        if (!isNaN(d.getTime())) createdAt = d.getTime();
    }

    // 把日记伪装成两条 Message 喂给 extractMemoriesFromBuffer（id 给负数，不入库不冲突）
    const fakeMessages: Message[] = [];
    if (userDiaryText?.trim()) {
        fakeMessages.push({
            id: -Math.floor(Math.random() * 1e9),
            charId: char.id,
            role: 'user',
            type: 'text',
            content: `【交换日记 ${dateStr}】我今天写道：\n${userDiaryText.trim()}`,
            timestamp: createdAt,
        } as Message);
    }
    if (charDiaryText?.trim()) {
        fakeMessages.push({
            id: -Math.floor(Math.random() * 1e9),
            charId: char.id,
            role: 'assistant',
            type: 'text',
            content: `【交换日记 ${dateStr}】我（${char.name}）的回复日记：\n${charDiaryText.trim()}`,
            timestamp: createdAt + 1000,
        } as Message);
    }
    if (fakeMessages.length === 0) return { status: 'empty_input' };

    // 角色 / 用户档案给 LLM 当上下文
    let charContext = `[角色档案]\n名字: ${char.name}\n核心设定:\n${char.systemPrompt || '无'}\n`;
    if (char.worldview?.trim()) charContext += `世界观: ${char.worldview}\n`;
    charContext += `\n[用户档案]\n名字: ${userName || '用户'}\n\n[来源说明]\n这是来自【交换日记】app 的一次归档，不是普通聊天，是一篇双方各写一页的正式日记。\n`;

    const extracted = await extractMemoriesFromBuffer(
        fakeMessages,
        char.id,
        char.name,
        lightLLMConfig,
        charContext,
        userName || '用户',
        [], // 不喂相关记忆，避免一次归档把 LLM 拉去做跨时间纠正
        [], // 不喂便利贴
    );

    if (extracted.memories.length === 0) {
        console.log(`🏰 [DiaryIngest] LLM 未提取出记忆节点`);
        return { status: 'extracted_none', stored: 0, skipped: 0 };
    }

    // 把 createdAt 改成日记日期，origin 标 system（用户主动触发的归档）
    for (const node of extracted.memories) {
        node.createdAt = createdAt;
        node.lastAccessedAt = createdAt;
        node.origin = 'system';
    }

    const remoteConfig = getRemoteVectorConfig();
    const result = await vectorizeAndStore(extracted.memories, embeddingConfig, remoteConfig);
    console.log(`🏰 [DiaryIngest] 日记 ${dateStr} 入宫：提取 ${extracted.memories.length} 条，存储 ${result.stored}，去重跳过 ${result.skipped}`);
    return {
        status: 'done',
        stored: result.stored,
        skipped: result.skipped,
        nodes: extracted.memories.map(n => ({
            content: n.content,
            room: n.room,
            importance: n.importance,
            mood: n.mood,
            tags: n.tags,
        })),
    };
}

// ─── 输入管线（AI 回复后，后台） ──────────────────────

// ─── 高水位标记：记录每个角色处理到的最后消息 ID ────────


/** 获取当前高水位标记（供外部上下文过滤使用） */
export function getMemoryPalaceHighWaterMark(charId: string): number {
    return getLocalMemoryPalaceHighWaterMark(charId);
}

// ─── 缓冲区配置 ─────────────────────────────────────

/** 处理比例：取缓冲区前 85%，保留尾部 15% 作为下次总结的上下文 */
const PROCESS_RATIO = 0.85;

/**
 * 水位节奏的唯一读取入口。配置跟随 CharacterProfile 存在 IndexedDB；调用方无需
 * 判断消息来自私聊、见面、通话还是剧情，整个 charId 时间线统一使用同一份档位。
 */
async function loadCharacterWaterline(
    charId: string,
    override?: MemoryPalaceWaterlineConfig,
) {
    if (override) return resolveMemoryPalaceWaterline(override);
    try {
        const characters = await DB.getAllCharacters();
        const character = characters.find(item => item.id === charId);
        return resolveMemoryPalaceWaterline(character?.memoryPalaceWaterline);
    } catch (error) {
        console.warn('🏰 [Pipeline] 读取角色水位档位失败，回退默认 200/100', error);
        return { ...DEFAULT_MEMORY_PALACE_WATERLINE };
    }
}

/**
 * 计算当前"真正可被 pipeline 处理"的缓冲区消息数。
 *
 * 与 processNewMessages 的口径完全一致：
 *   - 只数语义相关消息（排除纯图片/表情和无转写的纯音频；保留有文字的语音与卡片）
 *   - 排除角色档位指定的最后 N 条（热区永远不会被处理）
 *   - 只数 id > 高水位标记的部分
 *
 * 切勿用"id > hwm"裸过滤——那会把当前热区也算进未同步，
 * 导致 UI 显示的"未同步条数"远大于 pipeline 实际能处理的量
 * （表现：弹窗说有几百条未同步，点立即追平却跑不出新 hwm）。
 */
export async function getMemoryPalaceUnprocessedBufferCount(
    charId: string,
    waterlineOverride?: MemoryPalaceWaterlineConfig,
): Promise<number> {
    const allMessages = await DB.getMessagesByCharId(charId, true);
    const semantic = allMessages.filter(m => !m.groupId && isMessageSemanticallyRelevant(m));
    const highWaterMark = await getReliableMemoryPalaceHighWaterMark(charId);
    const waterline = await loadCharacterWaterline(charId, waterlineOverride);
    return countUnprocessedBufferMessages(semantic, highWaterMark, waterline.hotZoneSize);
}

/**
 * 聊天设置「一键存入」专用统计。与日常后台管线不同，它允许把热区也纳入本次处理，
 * 并按全部原文精确保留 0 或 10 条。
 */
export async function getMemoryPalaceOneShotPendingCount(
    charId: string,
    retainRecentMessages: number = 0,
): Promise<number> {
    const allMessages = await DB.getMessagesByCharId(charId, true);
    const privateMessages = allMessages.filter(message => !message.groupId);
    const semantic = privateMessages.filter(message => isMessageSemanticallyRelevant(message));
    const highWaterMark = await getReliableMemoryPalaceHighWaterMark(charId);
    return countOneShotPendingMessages(
        semantic,
        privateMessages,
        highWaterMark,
        retainRecentMessages,
    );
}

/** 并发锁：防止多次 AI 回复同时触发 processNewMessages 产生竞态 */
const processingLocks = new Set<string>();

/**
 * 缓冲区机制处理聊天消息：
 *
 * 1. 热区 = 角色档位指定的最近 N 条消息（留在聊天上下文，不处理）
 * 2. 缓冲区 = 高水位标记之后、热区之前的消息
 * 3. 缓冲区 >= 阈值时：取前 85% → LLM 提取记忆 → Embedding → 更新高水位
 * 4. 保留尾部 15%，避免下次总结时事件没有起因
 *
 * 相比旧方案（每轮 TopicLoom + 封盒），LLM 调用频率大幅降低：
 * 只在缓冲区满时触发，且只需 1 次 LLM 提取 + Embedding。
 */
/** Pipeline 处理结果 */
export interface PipelineResult {
    stored: number;
    skipped: number;
    /** 本轮 pipeline 从缓冲区取出处理的消息条数（caller 用于进度展示） */
    processedMessages?: number;
    memories: { content: string; room: string; importance: number; mood: string; tags: string[] }[];
    batches: { index: number; total: number; extracted: number; ok: boolean; error?: string }[];
    /**
     * 自动归档建议（供 React 层调用 updateCharacter 应用到 char.memories + hideBeforeMessageId）。
     * null = 本轮没产出新记忆或没更新水位线，caller 不需要做任何事。
     */
    autoArchive?: {
        /** 按日期切好的新 MemoryFragment 列表，id 已生成，mood='palace' */
        fragments: { id: string; date: string; summary: string; mood: string; palaceMemoryId?: string }[];
        /** 这一批 buffer 处理完后的水位线（= 最后一条被处理 Message.id），应设到 char.hideBeforeMessageId */
        hideBeforeMessageId: number;
    } | null;
    /**
     * 软跳过原因（非错误）：LLM 根本没跑，原因可能是缓冲区未到阈值 / 热区还没被挤出 / 已有任务在跑。
     * caller 看到这个字段就应当提示"聊天还不够，继续聊"，而不是报"LLM 提取失败"。
     */
    skipReason?: 'lock' | 'hot_zone' | 'threshold' | 'manual';
}

/** 构造一个"软跳过"结果，统一 caller 的分支处理 */
function makeSkipResult(reason: 'lock' | 'hot_zone' | 'threshold' | 'manual'): PipelineResult {
    return { stored: 0, skipped: 0, memories: [], batches: [], skipReason: reason };
}

/** extractAndStoreMemories 的产出：供 caller 决定是否更新水位线 / 跑副作用 */
interface ExtractCoreResult {
    /** 向量化真正存库的条数 */
    stored: number;
    /** 因语义去重跳过的条数 */
    skipped: number;
    /** 本轮提取出的全部记忆节点（去重命中的不入库，但仍在此数组里——建链按库实存过滤，安全） */
    memories: import('./types').MemoryNode[];
    batches: PipelineResult['batches'];
    crossTimeLinks: { newMemoryId: string; existingMemoryId: string }[];
    eventBoxHints: import('./extraction').EventBoxHint[];
    corrections: { targetId: string; note: string }[];
}

/**
 * 核心：把一批消息 → 构建上下文 → LLM 提取 → 向量化入库。
 *
 * 从 processNewMessages 抽出，供「自动缓冲区总结」与「手动区间总结」两条路径共用。
 * **不碰水位线、不做自动归档**——这些是 caller（路径专属）的职责。
 *
 * @param skipDedup true=不去重（自动路径：消息靠水位线保证不重复处理，cosine 去重误伤大）；
 *                  false=去重（手动保底路径：用户可能重复总结同一区间，靠去重避免刷出重复记忆）
 */
async function extractAndStoreMemories(
    toProcess: Message[],
    charId: string,
    charName: string,
    embeddingConfig: EmbeddingConfig,
    llmConfig: LightLLMConfig,
    userName: string,
    onProgress: ((stage: string) => void) | undefined,
    skipDedup: boolean,
    requireAllBatches: boolean = false,
): Promise<ExtractCoreResult> {
        // 5. 构建精简上下文：角色档案 + 用户档案 + 相关已有记忆
        let charContext = '';
        let relatedMemoryRefs: RelatedMemoryRef[] = [];
        try {
            const chars = await DB.getAllCharacters();
            const charProfile = chars.find(c => c.id === charId);
            const userProfile = await DB.getUserProfile();

            // 5a. 精简角色档案（姓名、设定、世界观）
            if (charProfile) {
                charContext += `[角色档案]\n`;
                charContext += `名字: ${charProfile.name}\n`;
                charContext += `核心设定:\n${charProfile.systemPrompt || '无'}\n`;
                if (charProfile.worldview?.trim()) {
                    charContext += `世界观: ${charProfile.worldview}\n`;
                }
                charContext += `\n`;
            }

            // 5b. 精简用户档案（姓名、设定）
            if (userProfile) {
                charContext += `[用户档案]\n`;
                charContext += `名字: ${userProfile.name}\n`;
                charContext += `设定: ${userProfile.bio || '无'}\n\n`;
            }

            // 5c. 向量检索相关已有记忆，用于两个目的：
            //     ① 为 LLM 提取提供上下文（防止误解隐式指代）
            //     ② 收集结构化引用供 LLM 标注 relatedTo → EventBox 绑定
            //     细粒度策略：每条 ≥4 字的 user 消息独立 query（和 retrieval spike 对齐，避免把
            //     一整段 chat 揉成 3 段 embed 导致语义平均稀释）；消息太少时 fallback 3 段切法
            let snippets = splitMessagesToSpikes(toProcess);
            let strategy = 'per-msg';
            if (snippets.length === 0) {
                snippets = sampleSnippetsFromMessages(toProcess, 5, 300);
                strategy = 'fallback-3seg';
            }
            relatedMemoryRefs = await fetchRelatedMemoriesForExtraction(snippets, charId, embeddingConfig);
            if (relatedMemoryRefs.length > 0) {
                console.log(`🏰 [Pipeline] 检索到 ${relatedMemoryRefs.length} 条相关记忆作为提取上下文（${strategy}，${snippets.length} 段 query）`);
            }

            // 5d. 召回回执补强：路径①召回时被实际注入 prompt 的 memoryId 一定
            //     参与了角色这段对话——这是判断"用户纠正了哪条旧记忆"的可靠线索。
            //     向量召回经常漏掉这类目标（纠正话题离原记忆语义已偏移），所以用
            //     回执查表保底。配额 5 条优先，剩余格子留给向量召回。
            try {
                const RECEIPT_QUOTA = 5;
                const RECEIPT_TIME_TOLERANCE_MS = 10 * 60 * 1000; // 消息 ts 与 receipt ts 的容差
                const tsList = toProcess.map(m => m.timestamp).filter(t => t > 0);
                if (tsList.length > 0) {
                    const fromTs = Math.min(...tsList) - RECEIPT_TIME_TOLERANCE_MS;
                    const toTs = Math.max(...tsList) + RECEIPT_TIME_TOLERANCE_MS;
                    const receiptIds = getReceiptIdsInRange(charId, fromTs, toTs, RECEIPT_QUOTA);
                    if (receiptIds.length > 0) {
                        // 已经在向量召回里出现的就不重复加
                        const existingIds = new Set(relatedMemoryRefs.map(r => r.id));
                        const receiptRefs: RelatedMemoryRef[] = [];
                        for (const id of receiptIds) {
                            if (existingIds.has(id)) continue;
                            const node = await MemoryNodeDB.getById(id);
                            // 不喂 archived 节点（早被压缩归档了，纠正它没意义；该纠正
                            // 的是 box 的 summary，summary 是非 archived，能正常进来）
                            if (!node || node.archived) continue;
                            receiptRefs.push({
                                id: node.id,
                                room: node.room,
                                content: (node.content || '').slice(0, 100),
                            });
                        }
                        if (receiptRefs.length > 0) {
                            // 回执优先放前面（O0..On），向量召回继续往后排
                            relatedMemoryRefs = [...receiptRefs, ...relatedMemoryRefs];
                            console.log(`🧾 [Pipeline] 召回回执补强：从最近注入历史拉回 ${receiptRefs.length} 条记忆作为高优先级 relatedMemories`);
                        }
                    }
                }
            } catch (e: any) {
                console.warn(`🧾 [Pipeline] 召回回执查询失败（不影响提取）: ${e.message}`);
            }
        } catch (e: any) {
            console.warn(`🏰 [Pipeline] 加载角色上下文失败（不影响提取）: ${e.message}`);
        }

        // 6. 收集当前便利贴（供 LLM 判断是否需要提前摘除）
        const now = Date.now();
        const allCharNodes = await MemoryNodeDB.getByCharId(charId);
        const pinnedRefs: PinnedMemoryRef[] = allCharNodes
            .filter(n => n.pinnedUntil && n.pinnedUntil > now)
            .map(n => ({ id: n.id, content: n.content.slice(0, 80) }));

        // 7. LLM 提取记忆 — 大缓冲区分批处理（每批 ~250 条消息）
        //    避免一次喂太多消息导致 LLM 偷懒只提取几条
        const CHUNK_SIZE = 250;
        const chunks: Message[][] = [];
        for (let i = 0; i < toProcess.length; i += CHUNK_SIZE) {
            chunks.push(toProcess.slice(i, i + CHUNK_SIZE));
        }

        console.log(`🏰 [Pipeline] 开始提取记忆：${toProcess.length} 条消息，分 ${chunks.length} 批（每批 ~${CHUNK_SIZE} 条）`);

        const allMemories: import('./types').MemoryNode[] = [];
        const allCrossTimeLinks: { newMemoryId: string; existingMemoryId: string }[] = [];
        const allEventBoxHints: import('./extraction').EventBoxHint[] = [];
        const allCorrections: { targetId: string; note: string }[] = [];
        const allUnpinIds = new Set<string>();
        const batchResults: PipelineResult['batches'] = [];

        for (let ci = 0; ci < chunks.length; ci++) {
            const chunk = chunks[ci];
            onProgress?.(`正在提取记忆 (${ci + 1}/${chunks.length})...`);
            console.log(`🏰 [Pipeline] 调用 LLM 提取 batch ${ci + 1}/${chunks.length}（${chunk.length} 条消息 → ${llmConfig.model}）`);

            try {
                const extractionResult = await extractMemoriesFromBuffer(
                    chunk, charId, charName, llmConfig, charContext, userName, relatedMemoryRefs, pinnedRefs,
                );
                allMemories.push(...extractionResult.memories);
                allCrossTimeLinks.push(...extractionResult.crossTimeLinks);
                allEventBoxHints.push(...extractionResult.eventBoxHints);
                allCorrections.push(...extractionResult.corrections);
                extractionResult.unpinIds.forEach(id => allUnpinIds.add(id));
                batchResults.push({ index: ci + 1, total: chunks.length, extracted: extractionResult.memories.length, ok: true });
            } catch (e: any) {
                console.warn(`🏰 [Pipeline] batch ${ci + 1} 提取失败: ${e.message}（继续下一批）`);
                batchResults.push({ index: ci + 1, total: chunks.length, extracted: 0, ok: false, error: e.message });
            }
        }

        if (requireAllBatches && batchResults.some(batch => !batch.ok)) {
            console.warn('🏰 [Pipeline] 一键存入存在失败批次：不写向量、不推进水位线，保留原文供下次重试');
            return {
                stored: 0,
                skipped: 0,
                memories: [],
                batches: batchResults,
                crossTimeLinks: [],
                eventBoxHints: [],
                corrections: [],
            };
        }

        // 所有需要保留的批次均提取成功后再摘除便利贴；严格模式下避免半成功副作用。
        for (const unpinId of allUnpinIds) {
            const node = allCharNodes.find(n => n.id === unpinId);
            if (node) {
                node.pinnedUntil = null;
                await MemoryNodeDB.save(node);
            }
        }
        if (allUnpinIds.size > 0) {
            console.log(`📌 [Pipeline] 摘除 ${allUnpinIds.size} 条便利贴`);
        }

        const memories = allMemories;

        if (memories.length === 0) {
            console.warn(`🏰 [Pipeline] 所有批次共提取 0 条记忆（${toProcess.length} 条消息），不更新高水位，下次重试`);
            return { stored: 0, skipped: 0, memories: [], batches: batchResults, crossTimeLinks: allCrossTimeLinks, eventBoxHints: allEventBoxHints, corrections: allCorrections };
        }

        console.log(`🏰 [Pipeline] 提取完成：${chunks.length} 批共 ${memories.length} 条记忆`);

        // 7b. 检测 embedding 模型是否变更，如果变了则重建所有已有向量
        try {
            const consistency = await checkModelConsistency(charId, embeddingConfig.model);
            if (consistency === 'mismatch') {
                console.warn(`🔄 [Pipeline] 检测到 embedding 模型变更，开始重建已有向量...`);
                const result = await rebuildAllVectors(charId, embeddingConfig, getRemoteVectorConfig());
                console.log(`🔄 [Pipeline] 重建完成：${result.rebuilt} 条向量已更新`);
            }
        } catch (e: any) {
            console.warn(`🔄 [Pipeline] 模型一致性检查失败（不影响新记忆存储）: ${e.message}`);
        }

        // 8. 向量化（Embedding API，按批次）。向量化失败 → stored=0，caller 据此决定不更新水位。
        console.log(`🏰 [Pipeline] 开始向量化 ${memories.length} 条记忆...`);
        onProgress?.(`正在向量化 ${memories.length} 条记忆...`);
        const vectorResult = await vectorizeAndStore(memories, embeddingConfig, getRemoteVectorConfig(), { skipDedup });
        console.log(`🏰 [Pipeline] 向量化完成：${vectorResult.stored} 条存储, ${vectorResult.skipped} 条去重跳过`);

        return {
            stored: vectorResult.stored,
            skipped: vectorResult.skipped,
            memories,
            batches: batchResults,
            crossTimeLinks: allCrossTimeLinks,
            eventBoxHints: allEventBoxHints,
            corrections: allCorrections,
        };
}

/**
 * 核心：记忆入库后的副作用——建链 / EventBox 绑定+压缩 / 应用纠正 / 巩固。
 *
 * 从 processNewMessages 抽出，自动路径与手动路径共用。每一步独立 try/catch，
 * 失败不影响已保存的记忆。
 */
async function applyMemorySideEffects(
    charId: string,
    charName: string,
    memories: import('./types').MemoryNode[],
    crossTimeLinks: { newMemoryId: string; existingMemoryId: string }[],
    eventBoxHints: import('./extraction').EventBoxHint[],
    corrections: { targetId: string; note: string }[],
    embeddingConfig: EmbeddingConfig,
    llmConfig: LightLLMConfig,
    userName: string,
): Promise<void> {
        // 10. 建关联（仅规则，不调 LLM，省钱）— 失败不影响已保存的记忆
        try {
            const existingNodes = await MemoryNodeDB.getByCharId(charId);
            const justStored = existingNodes.filter(n => memories.some(nn => nn.id === n.id));
            const others = existingNodes.filter(n => !memories.some(nn => nn.id === n.id));
            await buildLinks(justStored, others);
            console.log(`🏰 [Pipeline] 关联建立完成（${justStored.length} 新节点 vs ${Math.min(others.length, 50)} 已有节点）`);
        } catch (e: any) {
            console.warn(`🏰 [Pipeline] 关联建立失败（不影响已保存记忆）: ${e.message}`);
        }

        // 10b. EventBox 绑定：把 LLM 标注的 relatedTo 转为 EventBox 收纳
        //      （旧逻辑：转 causal MemoryLink 已废弃，让位给更强的 EventBox 机制）
        const touchedBoxIds = new Set<string>();
        if (crossTimeLinks.length > 0) {
            try {
                const { bindMemoriesIntoEventBox } = await import('./eventBox');
                const touched = await bindMemoriesIntoEventBox(charId, crossTimeLinks, eventBoxHints);
                for (const id of touched) touchedBoxIds.add(id);
                console.log(`📦 [Pipeline] EventBox 绑定：${crossTimeLinks.length} 条关联 → 触达 ${touched.size} 个事件盒`);
            } catch (e: any) {
                console.warn(`📦 [Pipeline] EventBox 绑定失败（不影响已保存记忆）: ${e.message}`);
            }
        }

        // 10c. EventBox 压缩：扫描刚被触达的盒，活节点 ≥ 4 → LLM 二次总结
        if (touchedBoxIds.size > 0 && !llmConfig.deferPlateMaintenance && !readMaintenanceSettings().enabled) {
            try {
                const { maybeCompressEventBoxes } = await import('./eventBoxCompression');
                await maybeCompressEventBoxes(touchedBoxIds, llmConfig, embeddingConfig, charName, userName);
            } catch (e: any) {
                console.warn(`🗜️ [Pipeline] EventBox 压缩失败（不影响已保存记忆）: ${e.message}`);
            }
        }

        // 10d. 应用纠正：把 LLM 标的"用户纠正了 OX"翻译成对原节点 content 的追加。
        //     设计：不新增节点、不动 EventBox 结构、不删原内容——只在 content 末尾
        //     追加一行"（YYYY-MM-DD 纠正：xxx）"，重新向量化即可。下次召回时 LLM
        //     看到带纠正标签的内容会自然采用新版本。
        //     放在压缩之后：避免刚改完 content 的节点被同轮压缩当 live 节点吞掉。
        if (corrections.length > 0) {
            try {
                // 同一目标多次纠正：合并成一条多分号 note，避免追加多次
                const merged = new Map<string, string[]>();
                for (const c of corrections) {
                    const arr = merged.get(c.targetId) || [];
                    arr.push(c.note);
                    merged.set(c.targetId, arr);
                }

                const dateStr = getLocalDateKey();
                const toRevectorize: import('./types').MemoryNode[] = [];
                for (const [targetId, notes] of merged) {
                    const node = await MemoryNodeDB.getById(targetId);
                    if (!node) {
                        console.warn(`✏️ [Pipeline] 纠正目标 ${targetId} 已不存在，跳过`);
                        continue;
                    }
                    if (node.archived) {
                        // archived 节点不参与召回，纠正它没意义
                        console.warn(`✏️ [Pipeline] 纠正目标 ${targetId} 已归档，跳过`);
                        continue;
                    }
                    const noteText = notes.map(n => n.trim()).filter(Boolean).join('；');
                    if (!noteText) continue;
                    node.content = `${node.content}\n（${dateStr} 纠正：${noteText}）`;
                    node.embedded = false; // 触发重新向量化
                    node.lastAccessedAt = Date.now();
                    await MemoryNodeDB.save(node);
                    toRevectorize.push(node);
                    console.log(`✏️ [Pipeline] 纠正应用 ${targetId}: "${noteText.slice(0, 40)}…"`);
                }

                if (toRevectorize.length > 0) {
                    // skipDedup：内容刚改的节点必然和原向量"很像"，去重会误杀自己
                    await vectorizeAndStore(toRevectorize, embeddingConfig, getRemoteVectorConfig(), { skipDedup: true });
                    console.log(`✏️ [Pipeline] ${toRevectorize.length} 条纠正记忆已重新向量化`);
                }
            } catch (e: any) {
                console.warn(`✏️ [Pipeline] 应用纠正失败（不影响已保存记忆）: ${e.message}`);
            }
        }

        // 11. 巩固（纯计算）— 失败不影响已保存的记忆
        //     传 remoteConfig 让 room 变更同步到 Supabase，跨设备一致
        try {
            await runConsolidation(charId, getRemoteVectorConfig());
        } catch (e: any) {
            console.warn(`🏰 [Pipeline] 巩固失败（不影响已保存记忆）: ${e.message}`);
        }
}

export interface ProcessNewMessagesOptions {
    /** Explicit user step may run while automatic maintenance is paused. */
    manualMaintenanceStep?: boolean;
    /** 一键存入后仍保留为聊天原文的最近消息数；只在 drainBuffer=true 时生效。 */
    retainRecentMessages?: number;
    /** 处理水位线到目标边界之间的全部内容，不套用日常档位热区与 85% 尾部保留。 */
    drainBuffer?: boolean;
    /** 任一 LLM 提取批次失败时整轮不写向量、不推进水位线。 */
    requireAllBatches?: boolean;
    /** 测试或刚完成设置写入时可显式覆盖；常规路径会按 charId 从 IndexedDB 读取。 */
    waterline?: MemoryPalaceWaterlineConfig;
}

export async function processNewMessages(
    _allRecentMessages: Message[], // 保留参数兼容，但内部直接从 DB 加载
    charId: string,
    charName: string,
    embeddingConfig: EmbeddingConfig,
    llmConfig: LightLLMConfig,
    userName: string = '',
    /** 强制模式：跳过缓冲区阈值检查，用于一键向量化 */
    force: boolean = false,
    /** 进度回调：通知调用方当前阶段 */
    onProgress?: (stage: string) => void,
    options: ProcessNewMessagesOptions = {},
): Promise<PipelineResult | null> {
    if (!force && !options.manualMaintenanceStep && readMaintenanceSettings().enabled) return makeSkipResult('manual');
    // 并发锁：同一角色同时只能跑一次
    if (processingLocks.has(charId)) {
        console.log(`🏰 [Pipeline] 跳过：${charName} 已有处理任务在运行`);
        return makeSkipResult('lock');
    }
    processingLocks.add(charId);

    try {
        // 1. 加载全部消息（含已处理的），计算热区和缓冲区
        //    过滤：保留任何有语义的消息类型（文字、带转写的语音、卡片、系统事件等），
        //    只排除纯视觉资源和无转写的纯音频，避免 URL / base64 污染 LLM。
        const allMessages = await DB.getMessagesByCharId(charId, true, options.drainBuffer === true);
        const privateMessages = allMessages
            .filter(message => !message.groupId)
            .sort((a, b) => a.id - b.id);
        const textMessages = privateMessages
            .filter(m => isMessageSemanticallyRelevant(m))
            .sort((a, b) => a.id - b.id);

        const totalCount = textMessages.length;
        const lastProcessedId = await getReliableMemoryPalaceHighWaterMark(charId);
        const drainBuffer = options.drainBuffer === true;
        const waterline = await loadCharacterWaterline(charId, options.waterline);
        const hotZoneSize = waterline.hotZoneSize;
        const bufferThreshold = waterline.bufferThreshold;
        const retainedCount = Math.max(0, Math.floor(options.retainRecentMessages || 0));
        const targetHighWaterMark = drainBuffer
            ? getOneShotTargetHighWaterMark(privateMessages, retainedCount)
            : 0;

        let buffer: Message[];
        let hotZoneSizeForLog = hotZoneSize;

        if (drainBuffer) {
            // 一键存入的边界按全部原文计算，真正送给记忆提取的仍只包含有语义的内容。
            // 目标水位可能落在图片/卡片消息上，这是刻意的：原文范围必须精确保留 0/10 条。
            buffer = textMessages.filter(message => (
                message.id > lastProcessedId && message.id <= targetHighWaterMark
            ));
            hotZoneSizeForLog = retainedCount;

            if (targetHighWaterMark <= lastProcessedId) {
                console.log(`🏰 [Pipeline] 一键存入无需处理：目标水位 ${targetHighWaterMark} <= 当前水位 ${lastProcessedId}`);
                return {
                    stored: 0,
                    skipped: 0,
                    processedMessages: 0,
                    memories: [],
                    batches: [],
                    autoArchive: null,
                };
            }

            // 边界内只有纯媒体/系统壳时没有内容需要送 LLM，但这些原文本身也无需继续注入。
            if (buffer.length === 0) {
                await setReliableMemoryPalaceHighWaterMark(charId, targetHighWaterMark);
                onProgress?.('聊天原文边界已同步');
                return {
                    stored: 0,
                    skipped: 0,
                    processedMessages: 0,
                    memories: [],
                    batches: [],
                    autoArchive: null,
                };
            }
        } else {
            if (totalCount <= hotZoneSize) {
                console.log(`🏰 [Pipeline] 跳过：消息总数 ${totalCount} <= 热区 ${hotZoneSize}（${waterline.preset}），无需处理`);
                return makeSkipResult('hot_zone');
            }

            // 日常后台路径：热区 = 角色档位指定的最近 N 条。
            const hotZoneStartIdx = totalCount - hotZoneSize;
            const hotZoneStartId = textMessages[hotZoneStartIdx].id;
            buffer = textMessages.filter(m => m.id > lastProcessedId && m.id < hotZoneStartId);
        }

        const minThreshold = drainBuffer ? 1 : (force ? 10 : bufferThreshold);
        if (buffer.length < minThreshold) {
            console.log(`🏰 [Pipeline] 跳过：缓冲区 ${buffer.length} 条 < 阈值 ${minThreshold}（hwm=${lastProcessedId}）`);
            return makeSkipResult('threshold');
        }

        // 日常路径保留尾部 15% 衔接；一键存入严格处理到选定边界。
        const processCount = drainBuffer
            ? buffer.length
            : Math.ceil(buffer.length * PROCESS_RATIO);
        const toProcess = buffer.slice(0, processCount);
        const keptTail = buffer.length - processCount;

        if (toProcess.length === 0) return makeSkipResult('threshold');

        console.log(`🏰 [Pipeline] 开始处理缓冲区：${toProcess.length} 条消息（保留尾部 ${keptTail} 条）`);
        console.log(`🏰 [Pipeline]   消息ID范围: ${toProcess[0].id} ~ ${toProcess[toProcess.length - 1].id}`);
        console.log(`🏰 [Pipeline]   总消息: ${totalCount}, 热区: ${hotZoneSizeForLog}, 缓冲区: ${buffer.length}, hwm: ${lastProcessedId}`);
        // 全局广播：聊天/见面/通话共用同一条消息流与水位线，触发整理的可能是
        // 任何一个入口。OS 层监听此事件统一弹「xx正在整理记忆」，用户不管在哪个
        // App 都能立刻看到。只在真正进入处理路径后才广播——skip 不打扰。
        try {
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('memory-palace-processing', {
                    detail: { charId, charName, count: toProcess.length },
                }));
            }
        } catch { /* 非浏览器环境（测试）无 window */ }
        onProgress?.(`正在整理 ${toProcess.length} 条对话...`);

        // 5–8. 构建上下文 → LLM 提取 → 向量化（共用 extractAndStoreMemories）。
        //       skipDedup=true：聊天总结里"上周担心工作 / 这周担心工作"cosine 完全可能 > 0.9
        //       但是两件不同时间的事，cosine 去重会精准误杀；而 high-water-mark 已保证
        //       消息不会被重复处理，去重在这条路径上收益小、误伤大。
        const core = await extractAndStoreMemories(
            toProcess, charId, charName, embeddingConfig, llmConfig, userName, onProgress, true,
            true, // A failed batch must never be hidden by another batch's successful waterline advance.
        );

        if (core.memories.length === 0) {
            const allBatchesSucceeded = core.batches.length > 0 && core.batches.every(batch => batch.ok);
            if (drainBuffer && options.requireAllBatches && allBatchesSucceeded) {
                // LLM 成功读完但判断没有值得长期保存的记忆，仍可视为完成了本次记忆处理。
                await setReliableMemoryPalaceHighWaterMark(charId, targetHighWaterMark);
                onProgress?.('记忆整理完成，本段没有新增长期记忆');
                return {
                    stored: 0,
                    skipped: 0,
                    processedMessages: toProcess.length,
                    memories: [],
                    batches: core.batches,
                    autoArchive: null,
                };
            }
            // helper 内已打印"提取 0 条"或失败批次日志；严格模式不会推进水位线。
            return { stored: 0, skipped: 0, processedMessages: toProcess.length, memories: [], batches: core.batches };
        }

        // 9. 只有真的存成功了才更新高水位
        if (core.stored === 0) {
            console.warn(`🏰 [Pipeline] 向量化后 0 条存储成功，不更新高水位`);
            return { stored: 0, skipped: core.skipped, memories: [], batches: core.batches };
        }
        const newHighWaterMark = drainBuffer
            ? targetHighWaterMark
            : toProcess[toProcess.length - 1].id;
        // Resolve committed nodes before advancing the waterline; read failures must not hide messages.
        const storedNodes = (await Promise.all(core.memories.map(memory => MemoryNodeDB.getById(memory.id))))
            .filter((node): node is import('./types').MemoryNode => !!node);
        const autoArchive = buildAutoArchiveFragments(storedNodes, newHighWaterMark, true);
        await setReliableMemoryPalaceHighWaterMark(charId, newHighWaterMark);
        console.log(`✅ [Pipeline] 缓冲区处理完成：${core.stored} 条记忆, hwm ${lastProcessedId} → ${newHighWaterMark}`);
        onProgress?.(`记忆整理完成！新增 ${core.stored} 条记忆`);

        // 自动归档只关联实际落库的节点；去重跳过的候选不会生成悬空链接。
        // 读取与建议构造在推进水位前完成，不额外调用 LLM / Embedding。

        // 构建返回结果
        const pipelineResult: PipelineResult = {
            stored: core.stored,
            skipped: core.skipped,
            processedMessages: toProcess.length,
            memories: core.memories.map(m => ({ content: m.content, room: m.room, importance: m.importance, mood: m.mood, tags: m.tags })),
            batches: core.batches,
            autoArchive,
        };

        // 10–11. 建链 / EventBox / 纠正 / 巩固（共用 applyMemorySideEffects）
        await applyMemorySideEffects(
            charId, charName, core.memories, core.crossTimeLinks, core.eventBoxHints, core.corrections,
            embeddingConfig, llmConfig, userName,
        );

        return pipelineResult;

    } catch (err: any) {
        console.error(`❌ [Pipeline] processNewMessages 失败 (charId=${charId}):`, err.message, err.stack?.split('\n')[1] || '');
        return null;
    } finally {
        processingLocks.delete(charId);
    }
}

/** 手动区间总结的结果 */
export interface RangeProcessResult {
    stored: number;
    skipped: number;
    /** 区间内实际送 LLM 的消息条数 */
    processedMessages: number;
    memories: { content: string; room: string; importance: number; mood: string; tags: string[] }[];
    batches: PipelineResult['batches'];
    /**
     * 失败/空跑原因：
     * - 'lock'        该角色已有处理任务在跑（自动总结或另一次手动总结）
     * - 'empty'       选定区间没有可处理的语义消息
     * - 'no_memories' LLM 一条记忆都没提取出来
     * - 其它字符串    异常信息
     */
    error?: 'lock' | 'empty' | 'no_memories' | string;
}

/** 外部文本搬家到记忆宫殿的结果。 */
export interface ExternalMemoryImportResult {
    stored: number;
    skipped: number;
    extracted: number;
    /** 与本次真正写入向量库的节点完全同源，供 caller 回写神经链接里的传统记忆档案。 */
    archiveFragments: NonNullable<PipelineResult['autoArchive']>['fragments'];
    /** 记忆宫殿内部的节点关联边；不要和“神经链接 App”混为一谈。 */
    links: number;
    batches: import('./externalMemory').ExternalMemoryBatchResult[];
    error?: 'lock' | 'empty' | 'no_memories' | string;
}

/**
 * 把其它应用/设备导出的原始记忆文字直接迁入当前角色的记忆宫殿。
 *
 * 与聊天缓冲区不同，这条路径不碰消息水位线：
 * 外部文本 → 保真清洗/整理时间 → 分配房间 → embedding 入库 → 宫殿内部建链/巩固
 *          → 同源 MemoryFragment 回写神经链接角色档案（不推进聊天水位线）。
 */
export async function importExternalMemoryText(
    rawText: string,
    charId: string,
    charName: string,
    embeddingConfig: EmbeddingConfig,
    llmConfig: LightLLMConfig,
    userName: string = '',
    onProgress?: (stage: string) => void,
): Promise<ExternalMemoryImportResult> {
    if (processingLocks.has(charId)) {
        return { stored: 0, skipped: 0, extracted: 0, archiveFragments: [], links: 0, batches: [], error: 'lock' };
    }
    processingLocks.add(charId);

    try {
        if (!rawText.trim()) {
            return { stored: 0, skipped: 0, extracted: 0, archiveFragments: [], links: 0, batches: [], error: 'empty' };
        }

        const existingBefore = await MemoryNodeDB.getByCharId(charId);
        const extraction = await extractExternalMemoryText(
            rawText,
            charId,
            charName,
            userName,
            llmConfig,
            onProgress,
        );
        const failedBatch = extraction.batches.find(batch => !batch.ok);
        if (failedBatch) {
            return {
                stored: 0,
                skipped: 0,
                extracted: 0,
                archiveFragments: [],
                links: 0,
                batches: extraction.batches,
                error: `第 ${failedBatch.index}/${failedBatch.total} 批未能无损清洗：${failedBatch.error || '完整性校验失败'}。本次没有写入任何记忆`,
            };
        }
        if (extraction.memories.length === 0) {
            return {
                stored: 0,
                skipped: 0,
                extracted: 0,
                archiveFragments: [],
                links: 0,
                batches: extraction.batches,
                error: 'no_memories',
            };
        }

        try {
            const consistency = await checkModelConsistency(charId, embeddingConfig.model);
            if (consistency === 'mismatch') {
                onProgress?.('检测到向量模型已更换，正在重建已有向量…');
                await rebuildAllVectors(charId, embeddingConfig, getRemoteVectorConfig());
            }
        } catch (error: any) {
            console.warn(`🏰 [ExternalImport] 模型一致性检查失败（继续导入）: ${error?.message || error}`);
        }

        onProgress?.(`正在生成 ${extraction.memories.length} 条向量记忆…`);
        const vectorResult = await vectorizeAndStore(
            extraction.memories,
            embeddingConfig,
            getRemoteVectorConfig(),
            { skipDedup: false },
        );

        // 只拿本次真正写入的节点建链；被向量去重跳过的候选不能留下悬空边。
        const storedIdSet = new Set(extraction.memories.map(memory => memory.id));
        const allAfter = await MemoryNodeDB.getByCharId(charId);
        const justStored = allAfter.filter(node => storedIdSet.has(node.id));

        // 神经链接桥接只依赖真正写入的同批节点；先生成，避免可选关联步骤失败时丢掉双写。
        const archiveFragments = buildAutoArchiveFragments(justStored, 0)?.fragments || [];
        onProgress?.(`正在建立 ${justStored.length} 条记忆的宫殿内部关联…`);
        let links: Awaited<ReturnType<typeof buildLinks>> = [];
        try {
            links = await buildLinks(justStored, existingBefore, llmConfig);
        } catch (error: any) {
            console.warn(`🏰 [ExternalImport] 建立关联失败，记忆与神经链接双写仍继续: ${error?.message || error}`);
        }
        try {
            await runConsolidation(charId, getRemoteVectorConfig());
        } catch (error: any) {
            console.warn(`🏰 [ExternalImport] 巩固失败，已写入记忆不受影响: ${error?.message || error}`);
        }
        // 与全自动总结水位线共用同一个桥接器：同一批 MemoryNode 按日期组成
        // mood='palace' 的 MemoryFragment，交给 UI 合并进当前角色的神经链接档案。
        // 外部导入没有聊天 Message ID，因此这里只双写记忆，不推进/伪造聊天水位线。
        onProgress?.(`搬家完成：新增 ${vectorResult.stored} 条向量记忆`);

        return {
            stored: vectorResult.stored,
            skipped: vectorResult.skipped,
            extracted: extraction.memories.length,
            archiveFragments,
            links: links.length,
            batches: extraction.batches,
        };
    } catch (error: any) {
        console.error(`❌ [ExternalImport] ${charName} 外部记忆导入失败:`, error);
        return {
            stored: 0,
            skipped: 0,
            extracted: 0,
            archiveFragments: [],
            links: 0,
            batches: [],
            error: error?.message || String(error),
        };
    } finally {
        processingLocks.delete(charId);
    }
}

/**
 * 手动区间总结与向量化（保底机制）。
 *
 * 用户在「手动总结与向量化」面板里圈定 [fromMsgId, toMsgId] 区间，这条路径：
 *   - **完全不读、不写水位线**（mp_lastMsgId_*）—— 和自动总结井水不犯河水，
 *     重复跑同一区间也不会"吃掉"消息、不会打乱自动总结进度；
 *   - **开启去重**（skipDedup=false）—— 用户可能重复总结已总结过的区间（"不知道上次成没成"），
 *     去重保证不会刷出一堆重复记忆，stored/skipped 也如实反馈"这次新增几条 / 几条早就有了"；
 *   - 不做自动归档（buildAutoArchiveFragments）—— 那条路径会推聊天水位线/隐藏消息，与"不碰水位线"冲突。
 *
 * 与 processNewMessages 共用 extractAndStoreMemories + applyMemorySideEffects，
 * 提取质量、建链、EventBox、巩固逻辑完全一致。
 */
export async function processMessageRange(
    charId: string,
    charName: string,
    embeddingConfig: EmbeddingConfig,
    llmConfig: LightLLMConfig,
    fromMsgId: number,
    toMsgId: number,
    userName: string = '',
    onProgress?: (stage: string) => void,
): Promise<RangeProcessResult> {
    // 复用同一把并发锁：避免和自动总结 / 另一次手动总结同时写同角色记忆产生竞态
    if (processingLocks.has(charId)) {
        console.log(`🏰 [Pipeline] 手动区间总结跳过：${charName} 已有处理任务在运行`);
        return { stored: 0, skipped: 0, processedMessages: 0, memories: [], batches: [], error: 'lock' };
    }
    processingLocks.add(charId);

    try {
        const lo = Math.min(fromMsgId, toMsgId);
        const hi = Math.max(fromMsgId, toMsgId);

        // 只加载用户选区内的正文，含已处理消息，不推进水位线。
        const allMessages = await loadRangeMessageContents(charId, lo, hi);
        const toProcess = allMessages
            .filter(m => isMessageSemanticallyRelevant(m))
            .filter(m => m.id >= lo && m.id <= hi)
            .sort((a, b) => a.id - b.id);

        if (toProcess.length === 0) {
            console.log(`🏰 [Pipeline] 手动区间总结：区间 [${lo}, ${hi}] 内没有可处理的消息`);
            return { stored: 0, skipped: 0, processedMessages: 0, memories: [], batches: [], error: 'empty' };
        }

        console.log(`🏰 [Pipeline] 手动区间总结开始：${toProcess.length} 条消息（id ${toProcess[0].id} ~ ${toProcess[toProcess.length - 1].id}），不碰水位线`);
        onProgress?.(`正在整理 ${toProcess.length} 条对话...`);

        // 提取 + 向量化（去重开启）
        const core = await extractAndStoreMemories(
            toProcess, charId, charName, embeddingConfig, llmConfig, userName, onProgress, false,
        );

        if (core.memories.length === 0) {
            return { stored: 0, skipped: 0, processedMessages: toProcess.length, memories: [], batches: core.batches, error: 'no_memories' };
        }

        // 关键：不更新水位线、不做自动归档。只跑入库后的副作用。
        await applyMemorySideEffects(
            charId, charName, core.memories, core.crossTimeLinks, core.eventBoxHints, core.corrections,
            embeddingConfig, llmConfig, userName,
        );

        console.log(`✅ [Pipeline] 手动区间总结完成：新增 ${core.stored} 条，去重跳过 ${core.skipped} 条（水位线未改动）`);
        onProgress?.(`完成！新增 ${core.stored} 条记忆${core.skipped > 0 ? `，${core.skipped} 条因重复跳过` : ''}`);

        return {
            stored: core.stored,
            skipped: core.skipped,
            processedMessages: toProcess.length,
            memories: core.memories.map(m => ({ content: m.content, room: m.room, importance: m.importance, mood: m.mood, tags: m.tags })),
            batches: core.batches,
        };
    } catch (err: any) {
        console.error(`❌ [Pipeline] processMessageRange 失败 (charId=${charId}):`, err.message, err.stack?.split('\n')[1] || '');
        return { stored: 0, skipped: 0, processedMessages: 0, memories: [], batches: [], error: err.message || '未知错误' };
    } finally {
        processingLocks.delete(charId);
    }
}
