/**
 * Local Context Analyzer + 预留的 Recall Resolver 协议。
 *
 * Analyzer 不调 LLM、不做检索，只回答：当前话语在这一刻像什么交流动作。
 * 关键词只是一组加分证据，最终连续信号还会同时看长度、论元是否完整、
 * 近邻上下文是否已有明确先行词、整句是否自足，以及表面的互动能量。
 * 主回复管线只消费本地分析；下方轻量 Resolver 协议暂时保留，但不在回复前调用。
 */

import type { Message } from '../../types';
import { extractContent, extractJson, safeFetchJson } from '../safeApi';
import { sanitizeQuerySourceMessages } from './querySanitizer';

export type RecallQueryScope = 'memory' | 'event_box';
export type RecallQuerySource = 'reference' | 'event_update' | 'continuation';

export interface RecallQuery {
    text: string;
    scope: RecallQueryScope;
    weight: number;
    /** 只用于 Trace / 调试解释，不参与检索排序逻辑。 */
    source?: RecallQuerySource;
}

export interface RecallPlan {
    route: boolean;
    confidence: number;
    queries: RecallQuery[];
}

export interface RecallRouterLLMConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

export type RecallRouterExecutionStatus =
    | 'routed'
    | 'model_declined'
    | 'low_confidence'
    | 'invalid_response'
    | 'timeout'
    | 'error';

export interface RecallRouterExecutionResult {
    status: RecallRouterExecutionStatus;
    plan: RecallPlan;
    durationMs: number;
}

export type RecallGateReason =
    | 'no_current_user_text'
    | 'short_message'
    | 'reference_signal'
    | 'result_predicate'
    | 'missing_explicit_arguments'
    | 'recent_context_insufficient'
    | 'recent_context_sufficient'
    | 'self_contained_structure';

export interface RecallGateFeatures {
    meaningfulLength: number;
    shortMessage: boolean;
    hasReferenceSignal: boolean;
    hasResultPredicate: boolean;
    hasExplicitArgumentStructure: boolean;
    explicitAnchorCount: number;
    missingExplicitArguments: boolean;
    recentContextAnchorCount: number;
    recentContextSufficient: boolean;
    selfContained: boolean;
}

/**
 * 0..1 的结构信号快照。它们共同贡献 Gate 分数；任何单一正则信号都没有否决权。
 */
export interface RecallGateContributions {
    shortness: number;
    missingArguments: number;
    resultPredicate: number;
    deicticReference: number;
    explicitEntity: number;
    recentAntecedent: number;
    querySelfSufficiency: number;
}

export interface ContextSignals {
    /** 当前话语依赖刚才对话或既有事件才能成立的程度。 */
    continuationNeed: number;
    /** 当前话语存在多个可能承接对象的程度。 */
    ambiguity: number;
    /** 当前话语不借助前情也能独立理解的程度。 */
    selfSufficiency: number;
    /** 当前话语像一次结果落地或进展更新的程度。 */
    resultUpdate: number;
    /** 当前话语是否已给出明确、可直接查找的实体。 */
    explicitEntity: number;
    /** 纯表面统计：短促程度。 */
    brevity: number;
    /** 纯表面统计：感叹、重复字符、emoji 与连续气泡共同形成的能量。 */
    energy: number;
}

export interface LocalContextAnalysis {
    analyzable: boolean;
    /** 兼容旧 Gate 调试字段；现在只表示“值得给主模型语境提示”，不再触发副 API。 */
    shouldRoute: boolean;
    shouldGuide: boolean;
    score: number;
    reasons: RecallGateReason[];
    features: RecallGateFeatures;
    gateContributions: RecallGateContributions;
    signals: ContextSignals;
}

/** @deprecated 请使用 LocalContextAnalysis。 */
export type LocalRecallGateResult = LocalContextAnalysis;

export type RecallRouterTraceStatus =
    | 'disabled'
    | 'out_of_scope'
    | 'bypassed_explicit_entity'
    | 'no_current_user_text'
    | 'not_triggered'
    | 'gate_triggered'
    | 'unconfigured'
    | RecallRouterExecutionStatus;

export interface RecallRouterPlanTrace {
    /** 不记录 query 原文，只记录安全的结构信息。 */
    route: boolean;
    confidence: number;
    queryCount: number;
    scopes: RecallQueryScope[];
    sources: RecallQuerySource[];
}

export interface RecallRouterTrace {
    status: RecallRouterTraceStatus;
    gate?: LocalContextAnalysis;
    durationMs?: number;
    plan?: RecallRouterPlanTrace;
}

export const RECALL_ROUTER_TIMEOUT_MS = 1_800;
export const RECALL_ROUTER_MIN_CONFIDENCE = 0.55;
export const RECALL_GATE_ROUTE_THRESHOLD = 0.62;

const REFERENCE_SIGNAL_RE = /(?:那个|这个|那些|这些|那件事|这件事|之前那个|之前的|还是那个|这样|那样|怎么又|果然|又来|又是|\bta\b|她|他|它)/iu;
const RESULT_PREDICATE_RE = /(?:过了|通过了|成了|没成|成功了|失败了|好了|搞定了|结束了|出来了|到了|来了|走了|没了|赢了|输了|批了|拒了|录取了|挂了|崩了|修好了|办好了)(?:[!！?？。…]*)$/u;
// 弱词根只是一名“证人”：允许口语尾缀降低确定度，但绝不作为 Router 的前置门票。
const RESULT_PREDICATE_ROOT_RE = /(?:通过|成功|失败|搞定|结束|出来|录取|修好|办好|没成|过|成|赢|输|批|拒|挂|崩)/u;
const CONCRETE_ANCHOR_RE = /(?:考试|成绩|面试|申请|审核|项目|文件|方案|报告|论文|比赛|证书|驾照|订单|快递|手术|检查|作业|任务|账号|数据|照片|视频|合同|工作|学校|公司|医院|课程|活动|会议|行程|车票|机票|房子|租约|offer)/giu;
const QUOTED_ANCHOR_RE = /[「『《“"【]([^」』》”"】]{2,40})[」』》”"】]/gu;
const ALNUM_ANCHOR_RE = /(?:[A-Za-z][A-Za-z0-9._-]{1,30}|\d{2,}(?:[-/.年月日号]\d{1,4})*)/gu;
const DETERMINED_NOUN_RE = /(?:这个|那个|这份|那份|这场|那场|这次|那次)([\p{Script=Han}]{2,6})(?=$|[，。！？、\s]|给|发|交|放|拿|做|改|删|传|提|处|完|好|坏|成)/gu;
const EXPLICIT_ARGUMENT_RE = /(?:我|你|他|她|它|[\p{Script=Han}]{2,8})(?:今天|昨天|刚才|已经|终于|后来|又)?把.{2,24}(?:给|发给|交给|放到|拿到|提交|处理|改完|删掉|传给)/u;
const EXPLICIT_LOCATION_ACTION_RE = /(?:去|来|到|在)[\p{Script=Han}]{2,10}(?:开会|出差|上班|上课|考试|面试|找人|见面|办事|学习|工作)/u;
const COMPETING_ANTECEDENT_RE = /(?:和|还是|或者|或是|以及|、|分别|两个|几个)/u;

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function meaningfulLength(text: string): number {
    return Array.from(text.replace(/[\s\p{P}\p{S}]/gu, '')).length;
}

function collectExplicitAnchors(text: string): string[] {
    const anchors = new Set<string>();
    for (const match of text.matchAll(CONCRETE_ANCHOR_RE)) anchors.add(match[0].toLowerCase());
    for (const match of text.matchAll(QUOTED_ANCHOR_RE)) anchors.add(match[1].trim().toLowerCase());
    for (const match of text.matchAll(ALNUM_ANCHOR_RE)) anchors.add(match[0].toLowerCase());
    for (const match of text.matchAll(DETERMINED_NOUN_RE)) anchors.add(match[1].toLowerCase());
    return [...anchors];
}

function emptyFeatures(): RecallGateFeatures {
    return {
        meaningfulLength: 0,
        shortMessage: false,
        hasReferenceSignal: false,
        hasResultPredicate: false,
        hasExplicitArgumentStructure: false,
        explicitAnchorCount: 0,
        missingExplicitArguments: true,
        recentContextAnchorCount: 0,
        recentContextSufficient: false,
        selfContained: false,
    };
}

function emptyContributions(): RecallGateContributions {
    return {
        shortness: 0,
        missingArguments: 0,
        resultPredicate: 0,
        deicticReference: 0,
        explicitEntity: 0,
        recentAntecedent: 0,
        querySelfSufficiency: 1,
    };
}

function emptySignals(): ContextSignals {
    return {
        continuationNeed: 0,
        ambiguity: 0,
        selfSufficiency: 1,
        resultUpdate: 0,
        explicitEntity: 0,
        brevity: 0,
        energy: 0,
    };
}

function splitCurrentUserBurst(messages: Message[]): { current: Message[]; context: Message[] } {
    if (messages.length === 0) return { current: [], context: [] };
    let end = messages.length - 1;
    // 允许末尾夹一两条隐藏 system 标记，但不跨过 assistant 冒充当前 user 轮。
    while (end >= 0 && messages[end].role === 'system') end -= 1;
    if (end < 0 || messages[end].role !== 'user') return { current: [], context: messages };

    let start = end;
    while (start > 0 && messages[start - 1].role === 'user') start -= 1;
    return {
        current: messages.slice(start, end + 1),
        context: messages.slice(0, start),
    };
}

/**
 * 纯本地闸门。返回值不含原句，所以可以安全写进 Recall Trace。
 */
export function analyzeLocalContext(
    messages: Message[],
    charName?: string,
    userName?: string,
    explicitEntityPresent: boolean = false,
): LocalContextAnalysis {
    const { current, context } = splitCurrentUserBurst(messages);
    const safeCurrent = sanitizeQuerySourceMessages(current, charName, userName);
    const currentText = safeCurrent.map(message => message.content.trim()).filter(Boolean).join('\n');
    if (!currentText) {
        return {
            analyzable: false,
            shouldRoute: false,
            shouldGuide: false,
            score: 0,
            reasons: ['no_current_user_text'],
            features: emptyFeatures(),
            gateContributions: emptyContributions(),
            signals: emptySignals(),
        };
    }

    const length = meaningfulLength(currentText);
    const shortMessage = length <= 12;
    const hasReferenceSignal = REFERENCE_SIGNAL_RE.test(currentText);
    const hasResultPredicate = RESULT_PREDICATE_RE.test(currentText);
    const explicitAnchors = collectExplicitAnchors(currentText);
    const hasExplicitArgumentStructure = EXPLICIT_ARGUMENT_RE.test(currentText)
        || EXPLICIT_LOCATION_ACTION_RE.test(currentText);
    const selfContained = hasExplicitArgumentStructure
        || (explicitAnchors.length > 0 && length >= 7);
    const missingExplicitArguments = !selfContained;

    const safeContext = sanitizeQuerySourceMessages(context.slice(-6), charName, userName);
    const contextText = safeContext.map(message => message.content.trim()).filter(Boolean).join('\n');
    const contextAnchors = collectExplicitAnchors(contextText);
    // 有明确对象但同时列了多个备选，仍然不足以本地消歧，应交给 Router。
    const hasCompetingAntecedents = contextAnchors.length > 1
        && COMPETING_ANTECEDENT_RE.test(contextText);
    const recentContextSufficient = contextAnchors.length > 0 && !hasCompetingAntecedents;

    const resultPredicate = hasResultPredicate
        ? 1
        : RESULT_PREDICATE_ROOT_RE.test(currentText) ? 0.45 : 0;
    const deicticReference = hasReferenceSignal ? 1 : 0;
    const explicitEntity = explicitEntityPresent ? 1 : clamp01(explicitAnchors.length);
    const recentAntecedent = recentContextSufficient
        ? 1
        : contextAnchors.length > 0 ? 0.35 : 0;

    // 极短的完整寒暄/反应通常无需检索；一旦有承接证据，就不应用长度把它挡掉。
    const bareShortUtterance = length <= 3 && resultPredicate === 0 && deicticReference === 0;
    const querySelfSufficiency = selfContained
        ? 1
        : explicitAnchors.length > 0 ? 0.55
        : bareShortUtterance ? 0.85
        : length >= 10 ? 0.35
        : 0.15;
    const gateContributions: RecallGateContributions = {
        shortness: clamp01((18 - length) / 16),
        missingArguments: missingExplicitArguments ? 1 : 0,
        resultPredicate,
        deicticReference,
        explicitEntity,
        recentAntecedent,
        querySelfSufficiency,
    };

    // 正则只提供加分。即使没有命中结果词，短、缺参、低自足度的结构组合也能进入 Router。
    const score = clamp01(
        gateContributions.shortness * 0.22
        + gateContributions.missingArguments * 0.22
        + gateContributions.resultPredicate * 0.18
        + gateContributions.deicticReference * 0.18
        + (1 - gateContributions.querySelfSufficiency) * 0.16
        + (1 - gateContributions.recentAntecedent) * 0.12
        - gateContributions.explicitEntity * 0.22,
    );
    const hasStructuralNeed = gateContributions.missingArguments >= 0.7
        || gateContributions.deicticReference >= 0.35
        || gateContributions.querySelfSufficiency < 0.45;
    const shouldRoute = score >= RECALL_GATE_ROUTE_THRESHOLD
        && !recentContextSufficient
        && hasStructuralNeed;

    const punctuationCount = (currentText.match(/[!！?？]/gu) || []).length;
    const emojiCount = (currentText.match(/\p{Extended_Pictographic}/gu) || []).length;
    const hasRepeatedCharacter = /(.)\1{2,}/u.test(currentText);
    const energy = clamp01(
        punctuationCount * 0.18
        + emojiCount * 0.2
        + (hasRepeatedCharacter ? 0.28 : 0)
        + Math.max(0, current.length - 1) * 0.12
        + (resultPredicate > 0 ? 0.12 : 0),
    );
    const ambiguity = clamp01(
        gateContributions.missingArguments * 0.42
        + gateContributions.deicticReference * 0.24
        + (1 - gateContributions.querySelfSufficiency) * 0.22
        + (hasCompetingAntecedents ? 0.24 : 0)
        - gateContributions.explicitEntity * 0.35
        - gateContributions.recentAntecedent * 0.28,
    );
    const signals: ContextSignals = {
        continuationNeed: score,
        ambiguity,
        selfSufficiency: gateContributions.querySelfSufficiency,
        resultUpdate: gateContributions.resultPredicate,
        explicitEntity: gateContributions.explicitEntity,
        brevity: gateContributions.shortness,
        energy,
    };

    const reasons: RecallGateReason[] = [];
    if (shortMessage) reasons.push('short_message');
    if (hasReferenceSignal) reasons.push('reference_signal');
    if (hasResultPredicate) reasons.push('result_predicate');
    if (missingExplicitArguments) reasons.push('missing_explicit_arguments');
    if (recentContextSufficient) reasons.push('recent_context_sufficient');
    else reasons.push('recent_context_insufficient');
    if (selfContained) reasons.push('self_contained_structure');

    return {
        analyzable: true,
        shouldRoute,
        shouldGuide: shouldRoute,
        score,
        reasons,
        features: {
            meaningfulLength: length,
            shortMessage,
            hasReferenceSignal,
            hasResultPredicate,
            hasExplicitArgumentStructure,
            explicitAnchorCount: explicitAnchors.length,
            missingExplicitArguments,
            recentContextAnchorCount: contextAnchors.length,
            recentContextSufficient,
            selfContained,
        },
        gateContributions,
        signals,
    };
}

/**
 * 兼容旧调用名。Gate 已不再拥有“是否准许 LLM 工作”的权力；返回值只是本地语境分析。
 */
export function evaluateLocalRecallGate(
    messages: Message[],
    charName?: string,
    userName?: string,
): LocalContextAnalysis {
    return analyzeLocalContext(messages, charName, userName);
}

/**
 * 把本地数字翻译成主模型能自然使用的当轮理解提示。只描述应如何读这句话，
 * 不替模型指定具体事件，不改变角色身份、立场或语言人格。
 */
export function renderLocalContextGuidance(analysis: LocalContextAnalysis | undefined): string {
    if (!analysis?.analyzable || !analysis.shouldGuide) return '';

    const lines = [
        '### 此刻这句话怎么接',
        '对方这轮更像是在承接刚才或既有事件，并省略了部分对象。先把它当作当前话题的后续，结合紧邻对话和本轮已经召回的记忆理解；不要因为句子短就把它当成无关的新话题。',
    ];
    if (analysis.signals.resultUpdate >= 0.4) {
        lines.push('这也像一次结果落地或进展更新。先接住结果和对方此刻的情绪，再决定是否追问细节；不要先输出分析报告。');
    }
    if (analysis.signals.ambiguity >= 0.5) {
        lines.push('若现有线索共同指向同一件事，可以自然接住，不必解释检索过程；若线索互相冲突，保留不确定或自然确认，不要擅自补成唯一答案。');
    }
    lines.push('这只影响本轮的理解与反应顺序；你的身份、立场、关系距离和惯用表达仍然属于你自己。');
    return `${lines.join('\n')}\n\n`;
}

const VALID_SCOPES = new Set<RecallQueryScope>(['memory', 'event_box']);
const VALID_SOURCES = new Set<RecallQuerySource>(['reference', 'event_update', 'continuation']);

/**
 * 轻量模型输出进入系统前的唯一归一化入口。V1 明确拒绝 month scope；无有效 query
 * 时 route 会自动降为 false，避免模型只喊“要搜”却不给可执行计划。
 */
export function normalizeRecallPlan(value: unknown): RecallPlan {
    const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const rawQueries = Array.isArray(source.queries) ? source.queries : [];
    const queries: RecallQuery[] = [];

    for (const item of rawQueries) {
        if (!item || typeof item !== 'object') continue;
        const query = item as Record<string, unknown>;
        const text = typeof query.text === 'string' ? query.text.trim().slice(0, 240) : '';
        const scope = query.scope as RecallQueryScope;
        if (text.length < 2 || !VALID_SCOPES.has(scope)) continue;
        const rawWeight = typeof query.weight === 'number' && Number.isFinite(query.weight)
            ? query.weight
            : 1;
        const recallQuery: RecallQuery = {
            text,
            scope,
            weight: clamp01(rawWeight),
        };
        if (VALID_SOURCES.has(query.source as RecallQuerySource)) {
            recallQuery.source = query.source as RecallQuerySource;
        }
        queries.push(recallQuery);
        if (queries.length >= 3) break;
    }

    const rawConfidence = typeof source.confidence === 'number' && Number.isFinite(source.confidence)
        ? source.confidence
        : 0;
    const route = source.route === true && queries.length > 0;
    return {
        route,
        confidence: clamp01(rawConfidence),
        queries: route ? queries : [],
    };
}

function emptyRecallPlan(): RecallPlan {
    return { route: false, confidence: 0, queries: [] };
}

function formatRouterConversation(messages: Message[], charName?: string, userName?: string): string {
    return sanitizeQuerySourceMessages(messages.slice(-8), charName, userName)
        .map(message => {
            const role = message.role === 'assistant'
                ? (charName || '角色')
                : message.role === 'user' ? (userName || '用户') : '系统';
            return `${role}: ${message.content.trim().slice(0, 500)}`;
        })
        .filter(line => line.length > 3)
        .join('\n');
}

/**
 * 预留的轻量 Recall Resolver。它只产出额外检索支路，不回答用户，也不替换原始 query。
 * context-m1.4 暂不从 ChatApp 回复管线调用；等真实失败样本证明旧召回不足时再启用。
 * Chat completion 不自动重试，并由 safeFetchJson 的硬超时中止；任何失败都由上层 fail-open。
 */
export async function runLightRecallRouter(
    messages: Message[],
    config: RecallRouterLLMConfig,
    charName?: string,
    userName?: string,
    timeoutMs: number = RECALL_ROUTER_TIMEOUT_MS,
): Promise<RecallRouterExecutionResult> {
    const startedAt = performance.now();
    const conversation = formatRouterConversation(messages, charName, userName);
    if (!conversation) {
        return { status: 'invalid_response', plan: emptyRecallPlan(), durationMs: 0 };
    }
    const charId = messages[messages.length - 1]?.charId || messages[0]?.charId;

    const systemPrompt = `你是聊天应用的记忆检索路由器，不回答用户，只生成额外检索计划。
本地闸门已认为最后一句可能缺少指代对象。请结合给出的最近对话，判断是否能生成比原句更明确的检索词。

规则：
1. 不得虚构对话里没有依据的人名、事件名或事实。无法可靠补全时 route=false。
2. 原始用户消息会由系统继续检索；这里只补充 1-3 条更明确的 query，不要复述原句。
3. scope 只能是 memory 或 event_box。memory 查人物、事实、经历；event_box 查持续事件或进度变化。不要输出 month。
4. source 只能是 reference、event_update、continuation。
5. weight 与 confidence 都是 0..1。
6. 只输出一个 JSON 对象，不要 Markdown 或解释。

格式：
{"route":true,"confidence":0.82,"queries":[{"text":"雾港观测员成绩","scope":"event_box","weight":0.9,"source":"event_update"}]}`;

    try {
        const data = await safeFetchJson(
            `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify({
                    model: config.model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: `最近对话：\n${conversation}` },
                    ],
                    temperature: 0.1,
                    max_tokens: 320,
                    stream: false,
                }),
            },
            0,
            timeoutMs,
            { appId: 'chat', appName: '消息', ...(charId ? { charId } : {}), ...(charName ? { charName } : {}), purpose: '记忆召回路由' },
        );
        const parsed = extractJson(extractContent(data));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {
                status: 'invalid_response',
                plan: emptyRecallPlan(),
                durationMs: Math.round(performance.now() - startedAt),
            };
        }
        const plan = normalizeRecallPlan(parsed);
        const status: RecallRouterExecutionStatus = !plan.route
            ? 'model_declined'
            : plan.confidence < RECALL_ROUTER_MIN_CONFIDENCE
                ? 'low_confidence'
                : 'routed';
        return {
            status,
            plan,
            durationMs: Math.round(performance.now() - startedAt),
        };
    } catch (error: any) {
        const timeout = error?.name === 'AbortError' || /abort|timeout/i.test(String(error?.message || ''));
        return {
            status: timeout ? 'timeout' : 'error',
            plan: emptyRecallPlan(),
            durationMs: Math.round(performance.now() - startedAt),
        };
    }
}

export function summarizeRecallPlan(plan: RecallPlan): RecallRouterPlanTrace {
    return {
        route: plan.route,
        confidence: plan.confidence,
        queryCount: plan.queries.length,
        scopes: [...new Set(plan.queries.map(query => query.scope))],
        sources: [...new Set(plan.queries.flatMap(query => query.source ? [query.source] : []))],
    };
}
