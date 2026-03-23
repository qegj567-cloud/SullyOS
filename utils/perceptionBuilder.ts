/**
 * 感官输入层 (Perception Builder)
 *
 * 纯本地计算，从消息和上下文中提取感知数据包
 * 用于管线触发判断 + 杏仁核输入
 */

import { scanEmotionKeywords } from './emotionOntology';
import type { PerceptionPacket } from '../types';
import type { Message } from '../types';

// ── Time of Day ──

type TimeOfDay = 'early_morning' | 'morning' | 'afternoon' | 'evening' | 'night' | 'late_night';

function getTimeOfDay(timestamp: number): TimeOfDay {
    const hour = new Date(timestamp).getHours();
    if (hour >= 5 && hour < 8) return 'early_morning';
    if (hour >= 8 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    if (hour >= 21 || hour < 1) return 'night';
    return 'late_night'; // 1:00 - 4:59
}

// ── Punctuation Analysis ──

interface PunctuationPattern {
    ellipsisCount: number;     // 省略号 …/...
    exclamationCount: number;  // 感叹号 ！/!
    questionCount: number;     // 问号 ？/?
    hasMultiplePunctuation: boolean; // 连续标点如 ！！！
}

function analyzePunctuation(text: string): PunctuationPattern {
    const ellipsisCount = (text.match(/[…]|[.]{3}|[。]{2,}/g) || []).length;
    const exclamationCount = (text.match(/[！!]/g) || []).length;
    const questionCount = (text.match(/[？?]/g) || []).length;
    const hasMultiplePunctuation = /[！!]{2,}|[？?]{2,}|[。]{3,}/.test(text);

    return { ellipsisCount, exclamationCount, questionCount, hasMultiplePunctuation };
}

// ── Rapid-fire Detection ──

function detectRapidFire(
    recentMessages: Message[],
    currentTimestamp: number,
    windowSec: number = 5,
    minCount: number = 3
): boolean {
    // Get recent user messages within window
    const userMsgs = recentMessages
        .filter(m => m.role === 'user')
        .map(m => m.timestamp)
        .filter(t => t > 0)
        .sort((a, b) => b - a); // newest first

    if (userMsgs.length < minCount) return false;

    // Check if minCount messages fall within windowSec
    const windowMs = windowSec * 1000;
    const newest = userMsgs[0];
    let count = 0;
    for (const t of userMsgs) {
        if (newest - t <= windowMs) count++;
    }

    return count >= minCount;
}

// ── Main Builder ──

export interface BuildPerceptionOptions {
    message: string;
    timestamp?: number;
    recentMessages?: Message[];
    lastSessionTimestamp?: number;
    userAverageMessageLength?: number;
}

export function buildPerceptionPacket(opts: BuildPerceptionOptions): PerceptionPacket {
    const {
        message,
        timestamp = Date.now(),
        recentMessages = [],
        lastSessionTimestamp,
        userAverageMessageLength = 50,
    } = opts;

    // Time calculations
    const lastUserMsg = recentMessages
        .filter(m => m.role === 'user')
        .sort((a, b) => b.timestamp - a.timestamp)[0];

    const lastMsgTimestamp = lastUserMsg?.timestamp ?? 0;
    const timeSinceLastMessage = lastMsgTimestamp > 0 ? timestamp - lastMsgTimestamp : 0;

    // Is first message today?
    const today = new Date(timestamp);
    today.setHours(0, 0, 0, 0);
    const todayStart = today.getTime();
    const hasMessageToday = recentMessages.some(m => {
        return m.role === 'user' && m.timestamp >= todayStart && m.timestamp < timestamp;
    });

    // Gap from last session
    const gapFromLastSession = lastSessionTimestamp
        ? (timestamp - lastSessionTimestamp) / (3600 * 1000)
        : 0;

    // Message analysis
    const messageLength = message.length;
    const lengthDelta = userAverageMessageLength > 0
        ? (messageLength - userAverageMessageLength) / userAverageMessageLength
        : 0;

    const punctuation = analyzePunctuation(message);
    const emotionKeywordHits = scanEmotionKeywords(message);
    const isRapidFire = detectRapidFire(recentMessages, timestamp);

    return {
        timestamp,
        timeOfDay: getTimeOfDay(timestamp),
        timeSinceLastMessage,
        isFirstMessageToday: !hasMessageToday,
        gapFromLastSessionHours: gapFromLastSession,

        messageText: message,
        messageLength,
        messageLengthDelta: lengthDelta,

        punctuation,
        emotionKeywordHits: emotionKeywordHits.map(h => h.ontologyId),
        emotionKeywordCount: emotionKeywordHits.length,
        isRapidFire,
    };
}
