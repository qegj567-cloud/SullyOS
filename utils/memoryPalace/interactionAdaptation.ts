/**
 * M2 — ChatApp Interaction Adaptation
 *
 * 只统计用户消息的表面节奏，不分析角色回复，也不更新角色基线：
 * - impulse：当前连续 user 气泡，下一轮自然消失
 * - trend：此前最近 20 个 user 轮次的加权趋势；一轮可包含任意数量的连续气泡
 * - policy：角色独立的靠近意愿，分维度 0..1
 */

import type { CharacterAccommodationPolicy, Message } from '../../types';
import { sanitizeQuerySourceMessages } from './querySanitizer';

export interface InteractionSurfaceState {
    /** 平均消息长度，0=极短，1=很长。 */
    length: number;
    /** 气泡连续、发送间隔和短句共同形成的节奏速度。 */
    rhythm: number;
    /** 感叹、重复字符、emoji、连续气泡共同形成的表面能量。 */
    energy: number;
    punctuation: number;
    emoji: number;
}

export interface ResolvedAccommodationPolicy {
    length: number;
    rhythm: number;
    energy: number;
    punctuation: number;
    emoji: number;
}

export interface UserInteractionAnalysis {
    analyzable: boolean;
    hasTrend: boolean;
    impulse: InteractionSurfaceState;
    trend: InteractionSurfaceState;
    target: InteractionSurfaceState;
    policy: ResolvedAccommodationPolicy;
    /** 各维度最终相对中性步伐的偏移；已经乘过角色 policy。 */
    shifts: InteractionSurfaceState;
}

export const DEFAULT_CHARACTER_ACCOMMODATION: Readonly<ResolvedAccommodationPolicy> = Object.freeze({
    length: 0.25,
    rhythm: 0.28,
    energy: 0.22,
    punctuation: 0.12,
    emoji: 0.08,
});

export const INTERACTION_TREND_TURN_LIMIT = 20;
export const INTERACTION_TREND_MESSAGE_SCAN_LIMIT = 200;

const EMPTY_STATE: Readonly<InteractionSurfaceState> = Object.freeze({
    length: 0.5,
    rhythm: 0.5,
    energy: 0.15,
    punctuation: 0,
    emoji: 0,
});

// “没有感叹号/emoji”通常只是普通聊天，不等于低落。各维度使用自己的
// 中性点，避免把每条平静短句都渲染成需要降温的情绪信号。
const NEUTRAL_TARGET: Readonly<InteractionSurfaceState> = Object.freeze({
    length: 0.5,
    rhythm: 0.5,
    energy: 0.15,
    punctuation: 0,
    emoji: 0,
});

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function resolveAccommodationPolicy(
    source?: CharacterAccommodationPolicy,
): ResolvedAccommodationPolicy {
    const resolve = (key: keyof ResolvedAccommodationPolicy): number => {
        const value = source?.[key];
        return typeof value === 'number' && Number.isFinite(value)
            ? clamp01(value)
            : DEFAULT_CHARACTER_ACCOMMODATION[key];
    };
    return {
        length: resolve('length'),
        rhythm: resolve('rhythm'),
        energy: resolve('energy'),
        punctuation: resolve('punctuation'),
        emoji: resolve('emoji'),
    };
}

function splitCurrentUserBurst(messages: Message[]): { current: Message[]; earlier: Message[] } {
    let end = messages.length - 1;
    while (end >= 0 && messages[end].role === 'system') end -= 1;
    if (end < 0 || messages[end].role !== 'user') return { current: [], earlier: messages };
    let start = end;
    while (start > 0 && messages[start - 1].role === 'user') start -= 1;
    return { current: messages.slice(start, end + 1), earlier: messages.slice(0, start) };
}

function meaningfulLength(text: string): number {
    return Array.from(text.replace(/[\s\p{P}\p{S}]/gu, '')).length;
}

function measure(messages: Message[]): InteractionSurfaceState | null {
    if (messages.length === 0) return null;
    const texts = messages.map(message => message.content.trim()).filter(Boolean);
    if (texts.length === 0) return null;

    const lengths = texts.map(meaningfulLength);
    const totalChars = Math.max(1, lengths.reduce((sum, value) => sum + value, 0));
    const averageLength = totalChars / texts.length;
    const joined = texts.join('\n');
    const punctuationCount = (joined.match(/[，。！？!?；;：:、…]/gu) || []).length;
    const emphaticCount = (joined.match(/[!！?？]/gu) || []).length;
    const emojiCount = (joined.match(/\p{Extended_Pictographic}/gu) || []).length;
    const repeatedCount = (joined.match(/(.)\1{2,}/gu) || []).length;

    const timestamps = messages
        .map(message => message.timestamp)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    let speed = 0.5;
    if (timestamps.length >= 2) {
        const gaps = timestamps.slice(1).map((value, index) => Math.max(0, value - timestamps[index]));
        const averageGapSeconds = gaps.reduce((sum, value) => sum + value, 0) / gaps.length / 1000;
        speed = clamp01(1 - averageGapSeconds / 90);
    }
    const bubbleBurst = clamp01((texts.length - 1) / 3);
    const brevity = 1 - clamp01(averageLength / 72);
    const punctuation = clamp01(punctuationCount / Math.max(2, totalChars * 0.22));
    const emoji = clamp01(emojiCount / Math.max(1, texts.length * 1.5));
    const energy = clamp01(
        emphaticCount * 0.16
        + repeatedCount * 0.24
        + emoji * 0.24
        + bubbleBurst * 0.18,
    );
    const rhythm = clamp01(bubbleBurst * 0.42 + speed * 0.28 + brevity * 0.3);

    return {
        length: clamp01(averageLength / 72),
        rhythm,
        energy,
        punctuation,
        emoji,
    };
}

function collectUserTurns(messages: Message[]): Message[][] {
    const turns: Message[][] = [];
    let currentTurn: Message[] = [];
    const flush = () => {
        if (currentTurn.length > 0) turns.push(currentTurn);
        currentTurn = [];
    };

    messages.slice(-INTERACTION_TREND_MESSAGE_SCAN_LIMIT).forEach(message => {
        if (message.role === 'user') {
            currentTurn.push(message);
        } else {
            flush();
        }
    });
    flush();
    return turns.slice(-INTERACTION_TREND_TURN_LIMIT);
}

function weightedTrend(messages: Message[]): InteractionSurfaceState | null {
    const states = collectUserTurns(messages)
        .map(turn => measure(turn))
        .filter((state): state is InteractionSurfaceState => Boolean(state));
    if (states.length === 0) return null;

    const totals: InteractionSurfaceState = { length: 0, rhythm: 0, energy: 0, punctuation: 0, emoji: 0 };
    let totalWeight = 0;
    states.forEach((state, index) => {
        // 20 轮窗口需要比旧版 8 条消息更慢地衰减，否则远端样本名义存在、实际没权重。
        const weight = Math.pow(0.9, states.length - index - 1);
        totalWeight += weight;
        (Object.keys(totals) as Array<keyof InteractionSurfaceState>).forEach(key => {
            totals[key] += state[key] * weight;
        });
    });
    (Object.keys(totals) as Array<keyof InteractionSurfaceState>).forEach(key => {
        totals[key] = clamp01(totals[key] / totalWeight);
    });
    return totals;
}

export function analyzeUserInteraction(
    messages: Message[],
    policySource?: CharacterAccommodationPolicy,
    charName?: string,
    userName?: string,
): UserInteractionAnalysis {
    const safe = sanitizeQuerySourceMessages(messages, charName, userName);
    const { current, earlier } = splitCurrentUserBurst(safe);
    const impulse = measure(current);
    const policy = resolveAccommodationPolicy(policySource);
    if (!impulse) {
        return {
            analyzable: false,
            hasTrend: false,
            impulse: { ...EMPTY_STATE },
            trend: { ...EMPTY_STATE },
            target: { ...EMPTY_STATE },
            policy,
            shifts: { length: 0, rhythm: 0, energy: 0, punctuation: 0, emoji: 0 },
        };
    }

    const measuredTrend = weightedTrend(earlier);
    const trend = measuredTrend || impulse;
    const keys = Object.keys(impulse) as Array<keyof InteractionSurfaceState>;
    const target = { ...impulse };
    const shifts = { ...impulse };
    keys.forEach(key => {
        // impulse 只影响当轮；trend 提供最近 20 轮的慢背景。
        // 当前回应以 impulse 为主；trend 只负责让长期相处节奏缓慢延续。
        target[key] = clamp01(trend[key] * 0.35 + impulse[key] * 0.65);
        shifts[key] = (target[key] - NEUTRAL_TARGET[key]) * policy[key];
    });

    return {
        analyzable: true,
        hasTrend: Boolean(measuredTrend),
        impulse,
        trend,
        target,
        policy,
        shifts,
    };
}

export function renderInteractionAdaptationGuidance(
    analysis: UserInteractionAnalysis | undefined,
    charName = '你',
): string {
    if (!analysis?.analyzable) return '';
    if (!Object.values(analysis.policy).some(value => value > 0.001)) return '';

    const signals: Array<{ text: string; strength: number }> = [];
    const { impulse, trend, shifts, policy } = analysis;
    const impulseLengthDelta = impulse.length - trend.length;
    const impulseEnergyDelta = impulse.energy - trend.energy;
    const impulseRhythmDelta = impulse.rhythm - trend.rhythm;
    const noticeableLengthImpulse = analysis.hasTrend
        && Math.abs(impulseLengthDelta) * policy.length >= 0.08;
    const noticeableEnergyImpulse = analysis.hasTrend
        && Math.abs(impulseEnergyDelta) * policy.energy >= 0.07;
    const noticeableRhythmImpulse = analysis.hasTrend
        && Math.abs(impulseRhythmDelta) * policy.rhythm >= 0.07;

    if (Math.abs(shifts.length) >= 0.045 || noticeableLengthImpulse) {
        const direction = noticeableLengthImpulse ? impulseLengthDelta : shifts.length;
        signals.push({
            text: `回复长度：${direction < 0 ? '明显变短' : '明显展开变长'}`,
            strength: noticeableLengthImpulse ? Math.abs(impulseLengthDelta) * policy.length / 0.08 : Math.abs(shifts.length) / 0.045,
        });
    }
    if (Math.abs(shifts.rhythm) >= 0.045 || noticeableRhythmImpulse) {
        const direction = noticeableRhythmImpulse ? impulseRhythmDelta : shifts.rhythm;
        signals.push({
            text: `来回节奏：${direction > 0 ? '偏快' : '偏慢'}`,
            strength: noticeableRhythmImpulse ? Math.abs(impulseRhythmDelta) * policy.rhythm / 0.07 : Math.abs(shifts.rhythm) / 0.045,
        });
    }
    if (Math.abs(shifts.energy) >= 0.04 || noticeableEnergyImpulse) {
        const direction = noticeableEnergyImpulse ? impulseEnergyDelta : shifts.energy;
        signals.push({
            text: `情绪能量：${direction > 0 ? '明显升高' : '明显偏低'}`,
            strength: noticeableEnergyImpulse ? Math.abs(impulseEnergyDelta) * policy.energy / 0.07 : Math.abs(shifts.energy) / 0.04,
        });
    }

    const hasImpulse = analysis.hasTrend && (
        Math.abs(impulseLengthDelta) >= 0.25
        || Math.abs(impulseEnergyDelta) >= 0.25
        || Math.abs(impulseRhythmDelta) >= 0.25
    );
    // 保留原检测阈值和角色维度开关；最多呈现两个最显著信号，不再指导标点/emoji。
    // 没有可报告信号时仍不注入，避免仅凭稳定状态占用上下文。
    if (signals.length === 0) return '';

    const intro = hasImpulse
        ? '对方这一轮的步伐和最近几轮有明显变化（以下为客观观察）：'
        : '对方这一阵的交流步伐平稳。';
    return [
        '### 【此刻的交流节奏】',
        intro,
        ...signals.sort((a, b) => b.strength - a.strength).slice(0, 2).map(signal => `- ${signal.text}`),
        `提示：察觉到这些变化即可，是否顺着对方调整语速和长度、怎么接住这个能量，完全按 ${charName} 自己的性格来，不要机械复制对方措辞。`,
        '',
    ].join('\n');
}
