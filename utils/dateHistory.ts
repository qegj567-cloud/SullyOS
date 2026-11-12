import type { Message } from '../types';
import { stripDateVoiceTranslations } from './dateVoiceText';

export type DateHistoryView = 'encounter' | 'date';
export type DateHistorySortOrder = 'newest' | 'oldest';

export interface DateHistoryGroup {
    id: string;
    dateKey: string;
    startAt: number;
    endAt: number;
    messages: Message[];
    /** 按日期查看时，表示当天能识别到的见面次数。 */
    encounterCount: number;
    /** 有场次 ID 或旧版开场锚点；否则 UI 提示这是兼容分组。 */
    hasOpeningAnchor: boolean;
}

const pad2 = (value: number) => String(value).padStart(2, '0');

export const getLocalDateKey = (timestamp: number): string => {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
};

export const formatDateHistoryDate = (timestamp: number): string => {
    const date = new Date(timestamp);
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${date.toLocaleDateString('zh-CN', { weekday: 'short' })}`;
};

export const formatDateHistoryTime = (timestamp: number, withDate = false): string => {
    const date = new Date(timestamp);
    const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    return withDate ? `${getLocalDateKey(timestamp)} ${time}` : time;
};

const sortMessagesChronologically = (messages: Message[]): Message[] => (
    [...messages].sort((left, right) => left.timestamp - right.timestamp || left.id - right.id)
);

/**
 * 按“真实的一次见面”切分。
 *
 * 新记录按 dateEncounterId 分组，直接见面无需开场白也有独立边界。
 * 旧记录以 isOpening 作为可靠开场锚点：从该开场到下一条开场，无论相隔多久、
 * 是否跨过午夜，都仍属于同一次见面。旧版没有锚点的记录只能按自然日期兼容分组，
 * 但不会再使用 30 分钟等容易误拆的间隔阈值。
 */
export function splitDateEncounters(messages: Message[]): DateHistoryGroup[] {
    const ordered = sortMessagesChronologically(messages);
    const groups: DateHistoryGroup[] = [];
    let current: Message[] = [];
    let currentHasOpening = false;
    const encounters = new Map<string, Message[]>();

    const flush = () => {
        if (current.length === 0) return;
        const first = current[0];
        const last = current[current.length - 1];
        groups.push({
            id: currentHasOpening ? `encounter-${first.id}` : `legacy-${getLocalDateKey(first.timestamp)}-${first.id}`,
            dateKey: getLocalDateKey(first.timestamp),
            startAt: first.timestamp,
            endAt: last.timestamp,
            messages: current,
            encounterCount: currentHasOpening ? 1 : 0,
            hasOpeningAnchor: currentHasOpening,
        });
        current = [];
        currentHasOpening = false;
    };

    for (const message of ordered) {
        const encounterId = message.metadata?.dateEncounterId;
        if (typeof encounterId === 'string' && encounterId) {
            flush();
            const bucket = encounters.get(encounterId) || [];
            bucket.push(message);
            encounters.set(encounterId, bucket);
            continue;
        }
        const isOpening = message.metadata?.isOpening === true;
        if (isOpening) {
            flush();
            current = [message];
            currentHasOpening = true;
            continue;
        }

        if (current.length === 0) {
            current = [message];
            continue;
        }

        // 没有开场锚点的旧记录按自然日期兜底；已锚定的一次见面不会因跨日被拆开。
        if (!currentHasOpening && getLocalDateKey(message.timestamp) !== getLocalDateKey(current[0].timestamp)) {
            flush();
        }
        current.push(message);
    }

    flush();
    for (const [id, bucket] of encounters) {
        groups.push({
            id: `encounter-${id}`, dateKey: getLocalDateKey(bucket[0].timestamp),
            startAt: bucket[0].timestamp, endAt: bucket[bucket.length - 1].timestamp,
            messages: bucket, encounterCount: 1, hasOpeningAnchor: true,
        });
    }
    return groups.sort((a, b) => a.startAt - b.startAt || a.messages[0].id - b.messages[0].id);
}

export function groupDateMessagesByDate(messages: Message[]): DateHistoryGroup[] {
    const ordered = sortMessagesChronologically(messages);
    const byDate = new Map<string, Message[]>();
    for (const message of ordered) {
        const key = getLocalDateKey(message.timestamp);
        const bucket = byDate.get(key) || [];
        bucket.push(message);
        byDate.set(key, bucket);
    }

    return Array.from(byDate.entries()).map(([dateKey, bucket]) => ({
        id: `date-${dateKey}`,
        dateKey,
        startAt: bucket[0].timestamp,
        endAt: bucket[bucket.length - 1].timestamp,
        messages: bucket,
        encounterCount: new Set(bucket.map(message => message.metadata?.dateEncounterId).filter(Boolean)).size
            + bucket.filter(message => !message.metadata?.dateEncounterId && message.metadata?.isOpening === true).length,
        hasOpeningAnchor: bucket.some(message => message.metadata?.dateEncounterId || message.metadata?.isOpening === true),
    }));
}

export function buildDateHistoryGroups(
    messages: Message[],
    view: DateHistoryView,
    sortOrder: DateHistorySortOrder,
): DateHistoryGroup[] {
    const groups = view === 'encounter'
        ? splitDateEncounters(messages)
        : groupDateMessagesByDate(messages);
    return sortOrder === 'newest' ? groups.reverse() : groups;
}

const exportedContent = (message: Message): string => {
    if (message.type === 'image') {
        const description = typeof message.metadata?.visionDescription === 'string'
            ? message.metadata.visionDescription.trim()
            : '';
        return description ? `[图片：${description}]` : '[图片]';
    }
    if (message.type === 'emoji') return message.content?.trim() ? `[表情] ${message.content.trim()}` : '[表情]';
    if (message.type === 'voice') return message.content?.trim() ? `[语音] ${message.content.trim()}` : '[语音]';
    return stripDateVoiceTranslations(message.content || '') || '(无内容)';
};

export function formatDateHistoryExport(
    characterName: string,
    groups: DateHistoryGroup[],
    view: DateHistoryView,
): string {
    const lines: string[] = [
        `见面记录 · ${characterName}`,
        `整理方式：${view === 'encounter' ? '按次' : '按日期'}`,
        `导出时间：${formatDateHistoryTime(Date.now(), true)}`,
        '',
    ];

    groups.forEach((group, index) => {
        const heading = view === 'encounter'
            ? `第 ${index + 1} 段 · ${formatDateHistoryTime(group.startAt, true)}`
            : formatDateHistoryDate(group.startAt);
        lines.push(`===== ${heading} =====`);
        for (const message of group.messages) {
            const speaker = message.role === 'user'
                ? '我'
                : message.role === 'assistant' ? characterName : '系统';
            lines.push(`[${formatDateHistoryTime(message.timestamp, true)}] ${speaker}：${exportedContent(message)}`);
        }
        if (index < groups.length - 1) lines.push('');
    });

    return `\uFEFF${lines.join('\n')}`;
}

export function makeDateHistoryFileName(characterName: string, scope: string): string {
    const safeName = characterName.replace(/[\\/:*?"<>|]/g, '_').trim() || '角色';
    return `${safeName}_见面记录_${scope}_${getLocalDateKey(Date.now())}.txt`;
}
