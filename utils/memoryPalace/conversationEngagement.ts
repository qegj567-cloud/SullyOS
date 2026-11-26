/**
 * M3 v2 — Conversation Engagement / Subject Tracking
 *
 * 这一层不再判断“话有多深”，而是判断用户这一轮在谈话里做了什么、当前主题
 * 是否仍在展开，以及角色本轮应该怎样参与。所有检测和状态转移都在本地完成；
 * 不调用 LLM，也不把状态写回角色人格。
 */

import type { Message } from '../../types';
import { analyzeExplicitEntitySignals } from './explicitEntityRecall';
import { sanitizeQuerySourceMessages } from './querySanitizer';

export const CONVERSATION_ENGAGEMENT_VERSION = 2;
export const CONVERSATION_ENGAGEMENT_ENGINE_KEY = 'os_conversation_engagement_engine';
export const CONVERSATION_ENGAGEMENT_STORAGE_PREFIX = 'os_conversation_engagement_v2:';

const SUBJECT_STALE_MS = 12 * 60 * 60 * 1000;
const MAX_KNOWN_FACTS = 6;
const MAX_UNRESOLVED_HOOKS = 5;

export type ConversationAct =
    | 'open_disclosure'
    | 'elaborate'
    | 'update'
    | 'answer'
    | 'ask_stance'
    | 'seek_support'
    | 'joke'
    | 'status_update'
    | 'close'
    | 'shift';

export type EngagementState = 'idle' | 'opening' | 'engaged' | 'resolving' | 'closing';

export type ConversationInteractionMode =
    | 'reactive'
    | 'playful'
    | 'supportive'
    | 'exploratory'
    | 'analytical';

export type ResponseAct =
    | 'acknowledge'
    | 'invite'
    | 'follow'
    | 'clarify'
    | 'reflect'
    | 'evaluate'
    | 'close'
    | 'shift';

export type SubjectHookKind =
    | 'missing_detail'
    | 'relation_to_prior'
    | 'changed_arrangement'
    | 'causal_question'
    | 'unfinished_disclosure';

export type ConversationEngagementReason =
    | 'disclosure_opening'
    | 'open_ended_statement'
    | 'personal_load'
    | 'narrative_lead'
    | 'incomplete_proposition'
    | 'explicit_support_request'
    | 'emotional_pressure'
    | 'prior_subject_continuation'
    | 'result_update'
    | 'stance_request'
    | 'analysis_invitation'
    | 'closure_signal'
    | 'topic_shift'
    | 'assistant_question_answer'
    | 'playful_surface'
    | 'repeated_low_information_turn';

export interface GroundedConversationFact {
    /** 只在本地 subject state 中保存；Trace 和 prompt guidance 都不复制原文。 */
    text: string;
    sourceMessageIds: number[];
    confidence: number;
    status: 'stated' | 'inferred';
}

export interface SubjectHook {
    kind: SubjectHookKind;
    sourceMessageIds: number[];
    confidence: number;
}

export interface ActiveConversationSubject {
    id: string;
    label?: string;
    entities: string[];
    startedAtTurn: number;
    lastUpdatedAtTurn: number;
    openness: number;
    salience: number;
    confidence: number;
    knownFacts: GroundedConversationFact[];
    unresolvedHooks: SubjectHook[];
    lastUserAct: ConversationAct;
}

export interface ProgressiveConversationStance {
    impression?: string;
    confidence: number;
    basisMessageIds: number[];
    openAlternatives: string[];
}

export interface ResponsePlan {
    primary: ResponseAct;
    secondary?: ResponseAct;
    explicitQuestionBudget: 0 | 1;
}

/**
 * 每个角色各自持有的本地临时谈话状态。knownFacts 只保存在用户设备上，
 * 不进入 RecallTrace；它们有严格数量与长度上限，也会随 subject 关闭而淘汰。
 */
export interface StoredConversationEngagementState {
    version: 2;
    charId: string;
    lastProcessedMessageId?: number;
    lastProcessedAt?: number;
    activeSubject?: ActiveConversationSubject;
    engagementState: EngagementState;
    interactionMode: ConversationInteractionMode;
    stance: ProgressiveConversationStance;
    lastConversationAct: ConversationAct;
    lastResponseActs: ResponseAct[];
    lastAnalysis?: ConversationEngagementAnalysis;
}

/**
 * 可安全进入 Trace / Prompt renderer 的脱敏分析。这里只保留枚举、分数和计数，
 * 不包含用户原句、subject label、实体名、事实文本或 hook 文本。
 */
export interface ConversationEngagementAnalysis {
    version: 2;
    analyzable: boolean;
    shouldGuide: boolean;
    conversationAct: ConversationAct;
    secondaryActs: ConversationAct[];
    previousEngagementState: EngagementState;
    engagementState: EngagementState;
    interactionMode: ConversationInteractionMode;
    responsePlan: ResponsePlan;
    subject: {
        active: boolean;
        created: boolean;
        resumed: boolean;
        changed: boolean;
        openness: number;
        salience: number;
        confidence: number;
        knownFactCount: number;
        unresolvedHookKinds: SubjectHookKind[];
    };
    stance: {
        confidence: number;
        basisCount: number;
    };
    signals: {
        opening: number;
        continuation: number;
        supportNeed: number;
        analysisReadiness: number;
        closure: number;
        shift: number;
        /** 仅用于当轮条件提醒；旧临时状态可能没有这两个字段。 */
        negativeEmotion?: boolean;
        previousGenericComfort?: boolean;
    };
    reasons: ConversationEngagementReason[];
}

export interface ConversationEngagementAdvanceResult {
    analysis: ConversationEngagementAnalysis;
    state: StoredConversationEngagementState;
}

interface DetectedConversationAct {
    primary: ConversationAct;
    secondary: ConversationAct[];
    reasons: ConversationEngagementReason[];
    opening: number;
    continuation: number;
    supportNeed: number;
    analysisReadiness: number;
    closure: number;
    shift: number;
    salience: number;
    incomplete: boolean;
    hasMeaningfulDetail: boolean;
    hasContradiction: boolean;
    currentText: string;
    currentMessageIds: number[];
}

const OPENING_RE = /(?:有件事|发生了(?:一件|点)?事|出了点事|有(?:个|些)事|事情(?:很多|好多|有点多)|好多事|之前.{0,18}(?:事|人|那个).{0,10}(?:后续|后来|又)|有后续|又有后续|刚(?:看到|听说|发现|想到)|突然想到|不知道怎么说|不知(?:道)?该怎么说|是不是我想多了|可能是我想多了|今天.{0,14}(?:奇怪|离谱|突然)|那个人又|那个事情又)/u;
const PERSONAL_LOAD_RE = /(?:我|最近|这几天|今天).{0,10}(?:很累|好累|有点累|太累|心累|很烦|好烦|有点烦|压力(?:很|好|有点)?大|忙不过来|喘不过气|乱糟糟|事情很多|事情好多)|事情(?:很多|好多|有点多)/u;
const NARRATIVE_LEAD_RE = /^(?:主要是|就是|其实|然后|后来|结果|那个|关于|说起来|对了|你还记得|还记得|之前说的)/u;
const UPDATE_RE = /(?:后续|后来|结果|进展|又|再次|突然|居然|现在变成|改口|换人|改变安排|今天.{0,10}(?:叫|说|通知|决定))/u;
const STANCE_REQUEST_RE = /(?:你怎么看|你怎么想|你的看法|你觉得呢|你觉得|你同意吗|如果是你|你说.{0,10}(?:是不是|算不算)|所以.{0,8}(?:是不是|为什么|意味着))/u;
const ANALYSIS_RE = /(?:认真(?:聊|分析)|一起(?:想|分析)|深入(?:聊|分析)|分析一下|拆开看看|想明白|可以反驳|哪里不对|往深了聊|为什么|原因|背后|机制|逻辑|矛盾|不一致|意味着)/u;
const EXPLICIT_ANALYSIS_REQUEST_RE = /(?:请.{0,8}分析|认真(?:聊|分析)|一起(?:想|分析)|深入(?:聊|分析)|分析一下|拆开看看|可以反驳|往深了聊)/u;
const SUPPORT_RE = /(?:先别分析|不想讲道理|陪陪我|陪着我|抱抱我|哄哄我|听我说|让我哭|现在只想|别急着给建议|先听我说)/u;
const EMOTIONAL_PRESSURE_RE = /(?:很累|好累|心累|事情很多|事情好多|压力(?:很|好|有点)?大|好难受|受不了|崩溃|撑不住|害怕|好痛苦|喘不过气|想哭|不知道怎么办|乱得很|很烦|好烦)/u;
const CLOSURE_RE = /(?:准备睡|先睡|睡觉了|睡觉啦|晚安|先休息|改天再说|以后再说|不想(?:说|聊|想)这个|先不(?:说|聊|想)了|算了.{0,8}(?:不说|不聊|不想)|到这(?:吧|了)|就这样吧|不用管(?:了|我)|别问了|没事了|先这样)/u;
const SHIFT_RE = /(?:换个话题|说点别的|不说这个了.{0,12}(?:给你看|说说)|给你看|看我(?:刚|今天)|对了.{0,8}(?:还有|给你|我刚)|话说回来|说起来.{0,8}(?:另一个|还有))/u;
const PLAYFUL_RE = /(?:哈哈|笑死|嘿嘿|好玩|逗你|开玩笑|乐死|绷不住)/u;
const CONTRADICTION_RE = /(?:但是|可是|然而|却|反而|明明|矛盾|说不通|不一致|之前.{0,24}(?:现在|今天|后来)|一边.{0,24}一边)/u;
const INCOMPLETE_END_RE = /(?:[…….…]{2,}|(?:然后|就是|主要是|那个人|那个事情|其实|可是|但是|又))\s*$/u;
const LOW_INFORMATION_RE = /^(?:嗯+|唔+|哦+|啊+|对|是|就是|然后呢|没错|差不多|不知道|可能吧|算是吧)[。.!！?？…]*$/u;
// 这三组只排除明显不需要 subject tracking 的交流行为。开放陈述本身不依赖
// 情绪/事件关键词：词表负责调节参与方式，不再决定一句话“值不值得听”。
const DIRECT_QUESTION_RE = /(?:[?？]\s*$|^(?:什么|怎么|为什么|为何|哪|谁|多少|几点|是不是|有没有|能不能|可不可以))/u;
const DIRECT_REQUEST_RE = /^(?:请|麻烦|帮我|能否|可以帮我|给我|替我|告诉我|解释|写一?|生成|做一?|查一下|搜索|翻译)/u;
const SOCIAL_ONLY_RE = /^(?:你?好|早上好|早安|中午好|下午好|晚上好|晚安|在吗|收到|知道了|好的?|好吧|行吧?|谢谢|谢啦|拜拜|回头见)[呀啊哦啦吧。.!！?？～~]*$/u;
const SELF_ANCHOR_RE = /(?:我|自己|咱们|我们)/u;

// 表面情绪信号，不分析角色人格，也不把“想要抱抱”一律视为负面情绪。
const NEGATIVE_EMOTION_RE = /(?:难过|伤心|委屈|生气|愤怒|烦死|烦透|气死|郁闷|沮丧|焦虑|担心|恐惧|好怕|很怕|有点怕|不开心|不高兴)/u;
// 只匹配独立的泛化安慰短句，避免“不要再说抱抱”“他只会说抱抱”等提及触发。
const GENERIC_COMFORT_CLAUSE_RE = /^(?:(?:来|先|给你|给你一个|过来)\s*)?(?:抱抱(?:你)?|别难过(?:了)?|不要难过(?:了)?|别伤心(?:了)?|不要伤心(?:了)?|没关系(?:的)?|我(?:会)?一直(?:都)?在|我在(?:呢)?|都会过去的|一切都会过去的)[呀啊哦啦呢吧~～\s]*$/u;

type EngagementGuardSignals = {
    negativeEmotion: boolean;
    previousGenericComfort: boolean;
};

function detectEngagementGuardSignals(messages: Message[], charName?: string, userName?: string): EngagementGuardSignals {
    // 先按原消息切轮，避免图片/表情被清洗掉后跨过一个用户轮去读更早的安慰。
    const { current, context } = splitCurrentUserBurst(messages);
    const currentText = sanitizeQuerySourceMessages(current, charName, userName)
        .map(message => message.content).join('\n');
    let previousGenericComfort = false;
    for (let index = context.length - 1; index >= 0; index -= 1) {
        const message = context[index];
        if (message.role === 'system') continue;
        if (message.role !== 'assistant') break;
        if (message.type !== 'text' && message.type !== 'voice') continue;
        const text = sanitizeQuerySourceMessages([message], charName, userName)
            .map(item => item.content).join('\n');
        if (text.split(/[。！？!?；;，,\n]+/u).some(clause => GENERIC_COMFORT_CLAUSE_RE.test(clause.trim()))) {
            previousGenericComfort = true;
            break;
        }
    }
    return {
        negativeEmotion: EMOTIONAL_PRESSURE_RE.test(currentText) || NEGATIVE_EMOTION_RE.test(currentText),
        previousGenericComfort,
    };
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function meaningfulLength(text: string): number {
    return Array.from(text.replace(/[\s\p{P}\p{S}]/gu, '')).length;
}

function unique<T>(items: T[]): T[] {
    return [...new Set(items)];
}

function splitCurrentUserBurst(messages: Message[]): { current: Message[]; context: Message[] } {
    let end = messages.length - 1;
    while (end >= 0 && messages[end].role === 'system') end -= 1;
    if (end < 0 || messages[end].role !== 'user') return { current: [], context: messages };
    let start = end;
    while (start > 0 && messages[start - 1].role === 'user') start -= 1;
    return { current: messages.slice(start, end + 1), context: messages.slice(0, start) };
}

function previousAssistantAsked(context: Message[]): boolean {
    for (let index = context.length - 1; index >= 0; index -= 1) {
        const message = context[index];
        if (message.role === 'system') continue;
        if (message.role !== 'assistant') return false;
        return /[?？]\s*$/u.test(message.content.trim());
    }
    return false;
}

function detectConversationAct(
    messages: Message[],
    previous?: StoredConversationEngagementState,
): DetectedConversationAct {
    const { current, context } = splitCurrentUserBurst(messages);
    const currentText = current.map(message => message.content.trim()).filter(Boolean).join('\n');
    const currentMessageIds = current.map(message => message.id);
    const length = meaningfulLength(currentText);
    const hasPreviousSubject = Boolean(previous?.activeSubject)
        && previous?.engagementState !== 'idle'
        && previous?.engagementState !== 'closing';
    const closureSignal = CLOSURE_RE.test(currentText);
    const shiftSignal = SHIFT_RE.test(currentText);
    const explicitSupport = SUPPORT_RE.test(currentText);
    const emotionalPressure = EMOTIONAL_PRESSURE_RE.test(currentText);
    const analysisInvitation = ANALYSIS_RE.test(currentText);
    // “这背后的逻辑是什么？”本身就是要求角色参与判断，不必强制出现“你怎么看”。
    const stanceRequest = STANCE_REQUEST_RE.test(currentText)
        || (analysisInvitation && /[?？]/u.test(currentText))
        || (!explicitSupport && EXPLICIT_ANALYSIS_REQUEST_RE.test(currentText));
    const playful = PLAYFUL_RE.test(currentText);
    const update = UPDATE_RE.test(currentText);
    const narrativeLead = NARRATIVE_LEAD_RE.test(currentText);
    const personalLoad = PERSONAL_LOAD_RE.test(currentText);
    const incomplete = INCOMPLETE_END_RE.test(currentText)
        || /(?:有件事|事情很多|事情好多|不知道怎么说|有后续)/u.test(currentText);
    const lowInformation = length <= 4 || LOW_INFORMATION_RE.test(currentText);
    const answeredQuestion = previousAssistantAsked(context);
    const contradiction = CONTRADICTION_RE.test(currentText);
    const explicitOpeningSignal = OPENING_RE.test(currentText) || personalLoad || incomplete;
    const directQuestion = DIRECT_QUESTION_RE.test(currentText);
    const directRequest = DIRECT_REQUEST_RE.test(currentText) && !stanceRequest && !explicitSupport;
    const socialOnly = SOCIAL_ONLY_RE.test(currentText);
    const openEndedStatement = !explicitOpeningSignal
        && !closureSignal
        && !shiftSignal
        && !directQuestion
        && !directRequest
        && !socialOnly
        && !playful
        && !lowInformation
        && (length >= 5 || SELF_ANCHOR_RE.test(currentText) || /[。！!…]\s*$/u.test(currentText));
    const openingSignal = explicitOpeningSignal || openEndedStatement;

    const reasons: ConversationEngagementReason[] = [];
    if (explicitOpeningSignal) reasons.push('disclosure_opening');
    if (openEndedStatement) reasons.push('open_ended_statement');
    if (personalLoad) reasons.push('personal_load');
    if (narrativeLead) reasons.push('narrative_lead');
    if (incomplete) reasons.push('incomplete_proposition');
    if (explicitSupport) reasons.push('explicit_support_request');
    if (emotionalPressure) reasons.push('emotional_pressure');
    if (hasPreviousSubject && !closureSignal && !shiftSignal) reasons.push('prior_subject_continuation');
    if (update) reasons.push('result_update');
    if (stanceRequest) reasons.push('stance_request');
    if (analysisInvitation) reasons.push('analysis_invitation');
    if (closureSignal) reasons.push('closure_signal');
    if (shiftSignal) reasons.push('topic_shift');
    if (answeredQuestion) reasons.push('assistant_question_answer');
    if (playful) reasons.push('playful_surface');
    if (hasPreviousSubject && lowInformation) reasons.push('repeated_low_information_turn');

    let primary: ConversationAct = 'status_update';
    const secondary: ConversationAct[] = [];
    if (shiftSignal) {
        primary = 'shift';
        if (closureSignal) secondary.push('close');
        secondary.push('open_disclosure');
    } else if (closureSignal) {
        primary = 'close';
    } else if (stanceRequest) {
        primary = 'ask_stance';
        if (hasPreviousSubject) secondary.push('elaborate');
    } else if (explicitSupport) {
        primary = 'seek_support';
        if (openingSignal || !hasPreviousSubject) secondary.push('open_disclosure');
    } else if (hasPreviousSubject) {
        primary = update ? 'update' : answeredQuestion ? 'answer' : 'elaborate';
        if (playful) secondary.push('joke');
    } else if (openingSignal || narrativeLead || update) {
        primary = update ? 'update' : 'open_disclosure';
        if (openingSignal && update) secondary.push('open_disclosure');
    } else if (playful) {
        primary = 'joke';
    } else if (answeredQuestion) {
        primary = 'answer';
    }

    const opening = closureSignal && !shiftSignal
        ? 0
        : clamp01(
            (explicitOpeningSignal ? 0.62 : openEndedStatement ? 0.48 : 0)
            + (narrativeLead ? 0.18 : 0)
            + (incomplete ? 0.2 : 0)
            + (personalLoad ? 0.18 : 0),
        );
    const continuation = clamp01(
        (hasPreviousSubject ? 0.62 : 0)
        + (narrativeLead ? 0.18 : 0)
        + (update ? 0.18 : 0)
        + (answeredQuestion ? 0.12 : 0)
        + (lowInformation && hasPreviousSubject ? 0.08 : 0),
    );
    const supportNeed = closureSignal
        ? 0
        : clamp01((explicitSupport ? 0.9 : 0) + (emotionalPressure ? 0.54 : 0) + (personalLoad ? 0.16 : 0));
    const analysisReadiness = clamp01(
        (stanceRequest ? 0.58 : 0)
        + (analysisInvitation ? 0.35 : 0)
        + (contradiction ? 0.18 : 0)
        + (hasPreviousSubject && previous!.stance.confidence >= 0.45 ? 0.1 : 0),
    );
    const closure = closureSignal ? (shiftSignal ? 0.82 : 1) : 0;
    const shift = shiftSignal ? 1 : 0;
    const salience = clamp01(
        Math.max(opening, continuation * 0.82)
        + (update ? 0.12 : 0)
        + (stanceRequest ? 0.16 : 0)
        + (emotionalPressure ? 0.1 : 0),
    );

    return {
        primary,
        secondary: unique(secondary.filter(act => act !== primary)),
        reasons: unique(reasons),
        opening,
        continuation,
        supportNeed,
        analysisReadiness,
        closure,
        shift,
        salience,
        incomplete,
        hasMeaningfulDetail: length >= 5 && !LOW_INFORMATION_RE.test(currentText),
        hasContradiction: contradiction,
        currentText,
        currentMessageIds,
    };
}

function extractSubjectLabel(text: string): string | undefined {
    const shifted = text.match(/(?:给你看|说点别的|换个话题)[：:，,\s]*(.{2,36})/u)?.[1];
    const led = text.match(/(?:主要是|就是|关于|之前说的|那个事情|那个人)[：:，,\s]*(.{2,32})/u)?.[1];
    const selected = (shifted || led || '').split(/[。！？!?\n]/u)[0]?.trim();
    if (selected) return selected.slice(0, 36);
    if (/(?:单位|公司|工作|主任|领导)/u.test(text)) return '工作中正在展开的事情';
    if (/(?:朋友|同事|同学|那个人)/u.test(text)) return '用户提到的那个人和相关事情';
    if (/(?:很累|事情很多|事情好多|压力)/u.test(text)) return '用户尚未展开的近况和压力';
    if (/(?:规则|逻辑|矛盾|分析)/u.test(text)) return '正在讨论的问题';
    return undefined;
}

function createFact(detection: DetectedConversationAct): GroundedConversationFact | undefined {
    if (!detection.hasMeaningfulDetail || detection.currentMessageIds.length === 0) return undefined;
    const text = detection.currentText.replace(/\s+/gu, ' ').trim().slice(0, 240);
    if (!text) return undefined;
    return {
        text,
        sourceMessageIds: detection.currentMessageIds.slice(-4),
        confidence: 1,
        status: 'stated',
    };
}

function mergeFacts(
    existing: GroundedConversationFact[],
    next: GroundedConversationFact | undefined,
): GroundedConversationFact[] {
    if (!next) return existing.slice(-MAX_KNOWN_FACTS);
    const firstId = next.sourceMessageIds[0];
    const withoutDuplicate = existing.filter(fact => fact.sourceMessageIds[0] !== firstId);
    return [...withoutDuplicate, next].slice(-MAX_KNOWN_FACTS);
}

function updateHooks(
    existing: SubjectHook[],
    detection: DetectedConversationAct,
): SubjectHook[] {
    const additions: SubjectHook[] = [];
    const sourceMessageIds = detection.currentMessageIds.slice(-4);
    const add = (kind: SubjectHookKind, confidence: number) => additions.push({ kind, sourceMessageIds, confidence });
    if (detection.opening >= 0.5) add('missing_detail', 0.72);
    if (detection.incomplete) add('unfinished_disclosure', 0.82);
    if (detection.primary === 'update' || detection.continuation >= 0.7) add('relation_to_prior', 0.68);
    if (detection.hasContradiction) add('changed_arrangement', 0.74);
    if (detection.analysisReadiness >= 0.5) add('causal_question', 0.72);

    const merged = new Map<SubjectHookKind, SubjectHook>();
    existing.forEach(hook => merged.set(hook.kind, hook));
    additions.forEach(hook => merged.set(hook.kind, hook));
    return [...merged.values()].slice(-MAX_UNRESOLVED_HOOKS);
}

function initialState(charId: string): StoredConversationEngagementState {
    return {
        version: CONVERSATION_ENGAGEMENT_VERSION,
        charId,
        engagementState: 'idle',
        interactionMode: 'reactive',
        stance: { confidence: 0, basisMessageIds: [], openAlternatives: [] },
        lastConversationAct: 'status_update',
        lastResponseActs: [],
    };
}

function createSubject(
    charId: string,
    detection: DetectedConversationAct,
    charName?: string,
    userName?: string,
): ActiveConversationSubject {
    const startedAtTurn = detection.currentMessageIds[0] || Date.now();
    const fact = createFact(detection);
    const syntheticMessages: Message[] = detection.currentMessageIds.map<Message>((id, index) => ({
        id,
        charId,
        role: 'user',
        type: 'text',
        content: index === detection.currentMessageIds.length - 1 ? detection.currentText : '',
        timestamp: Date.now(),
    })).filter(message => Boolean(message.content));
    const entities = analyzeExplicitEntitySignals(syntheticMessages, charName, userName)
        .signals.map(signal => signal.value)
        .slice(0, 4);
    return {
        id: `${charId}:${startedAtTurn}`,
        label: extractSubjectLabel(detection.currentText),
        entities,
        startedAtTurn,
        lastUpdatedAtTurn: detection.currentMessageIds.at(-1) || startedAtTurn,
        openness: Math.max(0.62, detection.opening),
        salience: Math.max(0.58, detection.salience),
        confidence: Math.max(0.58, detection.opening, detection.continuation),
        knownFacts: fact ? [fact] : [],
        unresolvedHooks: updateHooks([], detection),
        lastUserAct: detection.primary,
    };
}

function resolveInteractionMode(
    detection: DetectedConversationAct,
    engagementState: EngagementState,
): ConversationInteractionMode {
    if (engagementState === 'closing') return 'reactive';
    if (detection.supportNeed >= 0.5) return 'supportive';
    if (detection.analysisReadiness >= 0.72) return 'analytical';
    if (detection.analysisReadiness >= 0.35 || engagementState === 'opening' || engagementState === 'engaged') {
        return detection.primary === 'joke' || detection.secondary.includes('joke') ? 'playful' : 'exploratory';
    }
    if (detection.primary === 'joke') return 'playful';
    return 'reactive';
}

function chooseResponsePlan(
    detection: DetectedConversationAct,
    engagementState: EngagementState,
    stanceConfidence: number,
    previousActs: ResponseAct[],
    hadPreviousSubject: boolean,
): ResponsePlan {
    if (detection.primary === 'shift') {
        return hadPreviousSubject
            ? { primary: 'close', secondary: 'shift', explicitQuestionBudget: 0 }
            : { primary: 'shift', explicitQuestionBudget: 0 };
    }
    if (engagementState === 'closing' || detection.primary === 'close') {
        return { primary: 'close', explicitQuestionBudget: 0 };
    }
    if (detection.primary === 'ask_stance') {
        return stanceConfidence >= 0.45
            ? { primary: 'evaluate', secondary: 'reflect', explicitQuestionBudget: 0 }
            : { primary: 'reflect', secondary: 'evaluate', explicitQuestionBudget: 0 };
    }
    if (engagementState === 'opening') {
        const repeatedInvite = previousActs.includes('invite');
        return repeatedInvite
            ? { primary: 'acknowledge', secondary: 'follow', explicitQuestionBudget: 0 }
            : { primary: 'acknowledge', secondary: 'invite', explicitQuestionBudget: 1 };
    }
    if (engagementState === 'engaged' || engagementState === 'resolving') {
        if (detection.hasContradiction || detection.primary === 'update') {
            return { primary: 'reflect', secondary: 'follow', explicitQuestionBudget: 0 };
        }
        if (!detection.hasMeaningfulDetail) {
            return { primary: 'acknowledge', secondary: 'follow', explicitQuestionBudget: 0 };
        }
        const repeatedFollow = previousActs.includes('follow');
        return repeatedFollow
            ? { primary: 'reflect', secondary: 'clarify', explicitQuestionBudget: 1 }
            : { primary: 'follow', secondary: 'reflect', explicitQuestionBudget: 0 };
    }
    return { primary: 'acknowledge', explicitQuestionBudget: 0 };
}

function advanceStance(
    previous: ProgressiveConversationStance,
    detection: DetectedConversationAct,
    facts: GroundedConversationFact[],
    subjectChanged: boolean,
): ProgressiveConversationStance {
    if (detection.primary === 'close') return previous;
    const base = subjectChanged ? 0.08 : previous.confidence;
    const confidence = clamp01(
        base
        + (detection.hasMeaningfulDetail ? 0.08 : 0)
        + (detection.primary === 'update' ? 0.1 : 0)
        + (detection.hasContradiction ? 0.12 : 0)
        + (detection.primary === 'ask_stance' ? 0.18 : 0),
    );
    return {
        impression: subjectChanged ? undefined : previous.impression,
        confidence: Math.min(0.9, confidence),
        basisMessageIds: unique(facts.flatMap(fact => fact.sourceMessageIds)).slice(-12),
        openAlternatives: subjectChanged ? [] : previous.openAlternatives.slice(0, 3),
    };
}

function makeAnalysis(input: {
    detection: DetectedConversationAct;
    guardSignals: EngagementGuardSignals;
    previousEngagementState: EngagementState;
    engagementState: EngagementState;
    interactionMode: ConversationInteractionMode;
    responsePlan: ResponsePlan;
    subject?: ActiveConversationSubject;
    stance: ProgressiveConversationStance;
    subjectCreated: boolean;
    subjectResumed: boolean;
    subjectChanged: boolean;
    shouldGuide: boolean;
}): ConversationEngagementAnalysis {
    const { detection, subject } = input;
    return {
        version: CONVERSATION_ENGAGEMENT_VERSION,
        analyzable: Boolean(detection.currentText),
        shouldGuide: input.shouldGuide,
        conversationAct: detection.primary,
        secondaryActs: [...detection.secondary],
        previousEngagementState: input.previousEngagementState,
        engagementState: input.engagementState,
        interactionMode: input.interactionMode,
        responsePlan: { ...input.responsePlan },
        subject: {
            active: Boolean(subject),
            created: input.subjectCreated,
            resumed: input.subjectResumed,
            changed: input.subjectChanged,
            openness: subject?.openness ?? 0,
            salience: subject?.salience ?? 0,
            confidence: subject?.confidence ?? 0,
            knownFactCount: subject?.knownFacts.length ?? 0,
            unresolvedHookKinds: unique(subject?.unresolvedHooks.map(hook => hook.kind) || []),
        },
        stance: {
            confidence: input.stance.confidence,
            basisCount: input.stance.basisMessageIds.length,
        },
        signals: {
            opening: detection.opening,
            continuation: detection.continuation,
            supportNeed: detection.supportNeed,
            analysisReadiness: detection.analysisReadiness,
            closure: detection.closure,
            shift: detection.shift,
            ...input.guardSignals,
        },
        reasons: [...detection.reasons],
    };
}

export function advanceConversationEngagement(
    charId: string,
    messages: Message[],
    previousState?: StoredConversationEngagementState,
    charName?: string,
    userName?: string,
): ConversationEngagementAdvanceResult {
    const guardSignals = detectEngagementGuardSignals(messages, charName, userName);
    const safeMessages = sanitizeQuerySourceMessages(messages, charName, userName);
    const { current } = splitCurrentUserBurst(safeMessages);
    const lastMessageId = current.at(-1)?.id;
    const storedPrevious = previousState?.version === CONVERSATION_ENGAGEMENT_VERSION
        && previousState.charId === charId
        ? previousState
        : initialState(charId);

    // charId 相同不代表仍是同一个聊天窗口。若上一轮消息已经不在当前历史里，
    // 说明会话被清空/替换；此时不能把旧 subject 带进新的寒暄。
    const historyDisconnected = Boolean(storedPrevious.activeSubject)
        && storedPrevious.lastProcessedMessageId != null
        && !safeMessages.some(message => message.id === storedPrevious.lastProcessedMessageId);
    const previous = historyDisconnected ? initialState(charId) : storedPrevious;

    if (lastMessageId != null
        && previous.lastProcessedMessageId === lastMessageId
        && previous.lastAnalysis) {
        // 同一轮重建时重读这两个信号：兼容旧缓存，也让上一轮回复的编辑即时生效。
        return {
            analysis: { ...previous.lastAnalysis, signals: { ...previous.lastAnalysis.signals, ...guardSignals } },
            state: previous,
        };
    }

    const now = Date.now();
    const stale = Boolean(previous.activeSubject)
        && Boolean(previous.lastProcessedAt)
        && now - (previous.lastProcessedAt || 0) > SUBJECT_STALE_MS;
    const effectivePrevious = stale
        ? { ...initialState(charId), lastProcessedMessageId: previous.lastProcessedMessageId }
        : previous;
    const previousEngagementState = effectivePrevious.engagementState;
    const detection = detectConversationAct(safeMessages, effectivePrevious);

    if (!detection.currentText) {
        const responsePlan: ResponsePlan = { primary: 'acknowledge', explicitQuestionBudget: 0 };
        const analysis = makeAnalysis({
            detection,
            guardSignals,
            previousEngagementState,
            engagementState: previousEngagementState,
            interactionMode: effectivePrevious.interactionMode,
            responsePlan,
            subject: effectivePrevious.activeSubject,
            stance: effectivePrevious.stance,
            subjectCreated: false,
            subjectResumed: false,
            subjectChanged: false,
            shouldGuide: false,
        });
        const state = { ...effectivePrevious, lastAnalysis: analysis };
        return { analysis, state };
    }

    let subject = effectivePrevious.activeSubject;
    let engagementState: EngagementState = effectivePrevious.engagementState;
    let subjectCreated = false;
    let subjectChanged = false;
    let subjectResumed = false;

    if (detection.primary === 'shift') {
        subject = createSubject(charId, detection, charName, userName);
        engagementState = 'opening';
        subjectCreated = true;
        subjectChanged = true;
    } else if (detection.primary === 'close') {
        if (subject) {
            subject = { ...subject, openness: 0, lastUserAct: 'close' };
            engagementState = 'closing';
        } else {
            engagementState = 'idle';
        }
    } else if (effectivePrevious.engagementState === 'closing') {
        // closing 是旧 subject 的终态。下一条普通消息不能把它无条件复活；只有明确的新
        // opening/update/stance/support 才建立新 subject，旧故事的余味不会黏到闲聊上。
        if (
            detection.primary === 'open_disclosure'
            || detection.primary === 'update'
            || detection.primary === 'ask_stance'
            || detection.primary === 'seek_support'
        ) {
            subject = createSubject(charId, detection, charName, userName);
            engagementState = detection.primary === 'ask_stance' ? 'resolving' : 'opening';
            subjectCreated = true;
            subjectChanged = true;
        } else {
            subject = undefined;
            engagementState = 'idle';
        }
    } else if (!subject && (
        detection.opening >= 0.45
        || detection.primary === 'ask_stance'
        || detection.primary === 'seek_support'
        || detection.primary === 'update'
    )) {
        subject = createSubject(charId, detection, charName, userName);
        engagementState = detection.primary === 'ask_stance' ? 'resolving' : 'opening';
        subjectCreated = true;
        subjectChanged = true;
    } else if (subject) {
        const fact = createFact(detection);
        const facts = mergeFacts(subject.knownFacts, fact);
        subject = {
            ...subject,
            label: subject.label || extractSubjectLabel(detection.currentText),
            lastUpdatedAtTurn: lastMessageId || subject.lastUpdatedAtTurn,
            openness: clamp01(subject.openness * 0.72 + Math.max(detection.opening, detection.continuation) * 0.38),
            salience: clamp01(subject.salience * 0.76 + detection.salience * 0.34),
            confidence: clamp01(subject.confidence + (detection.hasMeaningfulDetail ? 0.07 : 0.025)),
            knownFacts: facts,
            unresolvedHooks: updateHooks(subject.unresolvedHooks, detection),
            lastUserAct: detection.primary,
        };
        engagementState = detection.primary === 'ask_stance' || detection.analysisReadiness >= 0.72
            ? 'resolving'
            : 'engaged';
        subjectResumed = previousEngagementState === 'opening' || stale;
    } else {
        engagementState = 'idle';
    }

    const facts = subject?.knownFacts || [];
    const stance = subject
        ? advanceStance(effectivePrevious.stance, detection, facts, subjectChanged)
        : { confidence: 0, basisMessageIds: [], openAlternatives: [] };
    const interactionMode = resolveInteractionMode(detection, engagementState);
    const responsePlan = chooseResponsePlan(
        detection,
        engagementState,
        stance.confidence,
        effectivePrevious.lastResponseActs,
        Boolean(effectivePrevious.activeSubject) && effectivePrevious.engagementState !== 'idle',
    );
    const shouldGuide = engagementState !== 'idle'
        || detection.primary === 'shift'
        || (detection.primary === 'close' && Boolean(effectivePrevious.activeSubject));
    const analysis = makeAnalysis({
        detection,
        guardSignals,
        previousEngagementState,
        engagementState,
        interactionMode,
        responsePlan,
        subject,
        stance,
        subjectCreated,
        subjectResumed,
        subjectChanged,
        shouldGuide,
    });
    const state: StoredConversationEngagementState = {
        version: CONVERSATION_ENGAGEMENT_VERSION,
        charId,
        lastProcessedMessageId: lastMessageId,
        lastProcessedAt: now,
        activeSubject: subject,
        engagementState,
        interactionMode,
        stance,
        lastConversationAct: detection.primary,
        lastResponseActs: unique([responsePlan.primary, responsePlan.secondary].filter(Boolean) as ResponseAct[]),
        lastAnalysis: analysis,
    };
    return { analysis, state };
}

function storageKey(charId: string): string {
    return `${CONVERSATION_ENGAGEMENT_STORAGE_PREFIX}${charId}`;
}

export function loadConversationEngagementState(charId: string): StoredConversationEngagementState | undefined {
    try {
        if (typeof localStorage === 'undefined') return undefined;
        const raw = localStorage.getItem(storageKey(charId));
        if (!raw) return undefined;
        const parsed = JSON.parse(raw) as StoredConversationEngagementState;
        if (parsed?.version !== CONVERSATION_ENGAGEMENT_VERSION || parsed.charId !== charId) return undefined;
        return parsed;
    } catch {
        return undefined;
    }
}

export function saveConversationEngagementState(state: StoredConversationEngagementState): void {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(storageKey(state.charId), JSON.stringify(state));
    } catch {
        // 状态只是质量增强层；存储失败不能阻断聊天。
    }
}

export function clearConversationEngagementState(charId: string): void {
    try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(storageKey(charId));
    } catch {}
}

export function analyzeConversationEngagement(
    charId: string,
    messages: Message[],
    charName?: string,
    userName?: string,
    options?: { persist?: boolean },
): ConversationEngagementAnalysis {
    const result = advanceConversationEngagement(
        charId,
        messages,
        loadConversationEngagementState(charId),
        charName,
        userName,
    );
    // 主动消息打包会被同步重试反复调用，只读取/推演同一份语境，不推进聊天状态。
    if (options?.persist !== false) saveConversationEngagementState(result.state);
    return result.analysis;
}

export function shouldUseLegacyDeepEngagement(): boolean {
    try {
        return typeof localStorage !== 'undefined'
            && localStorage.getItem(CONVERSATION_ENGAGEMENT_ENGINE_KEY) === 'legacy';
    } catch {
        return false;
    }
}

const BASE_ENGAGEMENT_RULE = `### 【谈话参与底线】
既关注对方此刻的感受，也关注事情本身发生了什么；不要把聊天变成连续审讯或心理咨询。`;

const ENGAGEMENT_ANCHORS = {
    opening: '对方正在开启一件还没讲完的事。先接住刚刚出现的信息，落在事情本身，自然留出对方继续说的空间，不必固定用“发生什么了”“然后呢”这类机械问句。',
    engaged: '对方正在继续同一件事。把这轮补充接回前文，别像重新开场；留意新信息与前文之间的联系、变化或反常之处，自然说出你的察觉。',
    resolving: '这件事已展开到可以表态的阶段。联系前文已经出现的事实，直接回应事情本身并给出属于你的看法，而不只是泛泛安慰情绪。',
    closing: '对方正在收束这件事。顺着对方的节奏停下来，不强迫继续，也不要在结尾突然补上一串追问。',
    shift: '对方切换了新主题。自然接住新话题，不要把旧话题的沉重语气机械地带过来。',
} as const;

const ENGAGEMENT_GUARDS = {
    unfinishedNegative: '目前没有结束信号，不要用“别想了”“都会过去的”这类话提前盖住这件事，也不要替对方概括还没说清的部分。',
    playful: '你可以保持轻松或锐评，但别让玩笑使你丢掉正在发生的事，仍然要接住它的新进展。',
    repeatedComfort: '本轮优先回应具体事实本身，不要再重复“抱抱”“别难过”这类泛化安抚。',
} as const;

export function renderConversationEngagementGuidance(
    analysis: ConversationEngagementAnalysis | undefined,
    charName = '你',
): string {
    if (!analysis?.analyzable || !analysis.shouldGuide || analysis.engagementState === 'idle') return '';

    // TOPIC_SWITCH 必须先于内部已经切入的新话题 opening。
    const phase = analysis.conversationAct === 'shift' ? 'shift' : analysis.engagementState;
    const anchor = ENGAGEMENT_ANCHORS[phase];
    const continuing = phase === 'opening' || phase === 'engaged';
    let guard = '';
    if (continuing && analysis.signals.negativeEmotion && analysis.signals.closure === 0) {
        guard = ENGAGEMENT_GUARDS.unfinishedNegative;
    } else if (phase !== 'closing'
        && (analysis.interactionMode === 'playful' || analysis.reasons.includes('playful_surface'))) {
        guard = ENGAGEMENT_GUARDS.playful;
    } else if (continuing && analysis.signals.previousGenericComfort) {
        guard = ENGAGEMENT_GUARDS.repeatedComfort;
    }

    return [
        BASE_ENGAGEMENT_RULE,
        anchor,
        ...(guard ? [guard] : []),
        `（以上仅供你把握当前聊到了哪一步，严禁提及这些状态或策略；具体是护短、追问、调侃还是沉稳分析，完全由 ${charName} 自己的性格决定。）`,
        '',
    ].join('\n');
}
