/**
 * 管线触发器 (Pipeline Trigger)
 *
 * 判断当前消息应走快路径还是完整管线
 * 纯本地规则引擎，零延迟
 */

import type { PerceptionPacket, EmotionState } from '../types';

// ── Trigger Configuration ──

export interface TriggerConfig {
    /** 每天第一条消息走完整管线 */
    firstMessageToday: boolean;
    /** 距上条消息超过 N 小时走完整管线 */
    gapHoursThreshold: number;
    /** 消息长度偏差超过 N% 走完整管线（正向：比平时长很多） */
    lengthDeltaUpperPercent: number;
    /** 消息长度偏差低于 N%（负向：比平时短很多） */
    lengthDeltaLowerPercent: number;
    /** 当前情绪栈最高强度超过此值走完整管线 */
    emotionIntensityThreshold: number;
    /** N 秒内连发 M 条消息走完整管线 */
    rapidFire: boolean;
    /** 含情绪关键词数量超过此值走完整管线 */
    emotionKeywordMinHits: number;
    /** 离线超过 N 小时触发重逢缓冲 */
    reunionHoursThreshold: number;
}

export const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
    firstMessageToday: true,
    gapHoursThreshold: 4,
    lengthDeltaUpperPercent: 2.0,   // 200% 偏差
    lengthDeltaLowerPercent: -0.7,  // 比平时短 70%
    emotionIntensityThreshold: 0.6,
    rapidFire: true,
    emotionKeywordMinHits: 2,
    reunionHoursThreshold: 24,
};

// ── Trigger Result ──

export type PipelinePath = 'fast' | 'full';

export interface TriggerResult {
    path: PipelinePath;
    reasons: string[];
    needsReunion: boolean;
}

// ── Main Logic ──

export function decidePipelinePath(
    perception: PerceptionPacket,
    emotionState: EmotionState,
    config: TriggerConfig = DEFAULT_TRIGGER_CONFIG
): TriggerResult {
    const reasons: string[] = [];
    let needsReunion = false;

    // Check reunion first
    if (perception.gapFromLastSessionHours >= config.reunionHoursThreshold) {
        reasons.push(`离线 ${Math.round(perception.gapFromLastSessionHours)}h，触发重逢缓冲`);
        needsReunion = true;
    }

    // First message today
    if (config.firstMessageToday && perception.isFirstMessageToday) {
        reasons.push('今天第一条消息');
    }

    // Time gap
    const gapHours = perception.timeSinceLastMessage / (3600 * 1000);
    if (gapHours > config.gapHoursThreshold) {
        reasons.push(`距上条消息 ${Math.round(gapHours)}h`);
    }

    // Message length anomaly
    if (perception.messageLengthDelta > config.lengthDeltaUpperPercent) {
        reasons.push(`消息异常长（偏差 +${Math.round(perception.messageLengthDelta * 100)}%）`);
    }
    if (perception.messageLengthDelta < config.lengthDeltaLowerPercent && perception.messageLength > 0) {
        reasons.push(`消息异常短（偏差 ${Math.round(perception.messageLengthDelta * 100)}%）`);
    }

    // Current emotion intensity
    const maxIntensity = emotionState.layers.length > 0
        ? Math.max(...emotionState.layers.map(l => l.intensity))
        : 0;
    if (maxIntensity > config.emotionIntensityThreshold) {
        reasons.push(`当前情绪强度 ${Math.round(maxIntensity * 100)}% 超阈值`);
    }

    // Rapid fire
    if (config.rapidFire && perception.isRapidFire) {
        reasons.push('检测到连续快速发送');
    }

    // Emotion keywords
    if (perception.emotionKeywordCount >= config.emotionKeywordMinHits) {
        reasons.push(`检测到 ${perception.emotionKeywordCount} 个情绪关键词`);
    }

    const path: PipelinePath = reasons.length > 0 ? 'full' : 'fast';

    return { path, reasons, needsReunion };
}
