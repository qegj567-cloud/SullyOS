import type { Message } from '../types';
import { getCalendarDayDifference, getLocalDateKey } from './localDate';

export const CHAT_TIME_SEGMENT_GAP_MS = 5 * 60 * 1000;

/** 消息气泡上的收发时间使用绝对时间差，和角色时区无关。 */
export function startsNewMessageGroup(previous: Pick<Message, 'role' | 'timestamp'> | null, current: Pick<Message, 'role' | 'timestamp'>): boolean {
    return !previous || previous.role !== current.role || Math.abs(current.timestamp - previous.timestamp) >= CHAT_TIME_SEGMENT_GAP_MS;
}

/**
 * 微信式顶部时间条分段：只按相邻消息的绝对时间差（≥ 5 分钟）切分，不因双方轮流发言切碎对话段。
 */
export function startsNewTimeSegment(previous: Pick<Message, 'timestamp'> | null, current: Pick<Message, 'timestamp'>): boolean {
    return !previous || Math.abs(current.timestamp - previous.timestamp) >= CHAT_TIME_SEGMENT_GAP_MS;
}

/**
 * 计算整串消息里哪些条目需要在顶部渲染独立时间条。
 * 系统提示（role === 'system'）自带独立版式，本身不挂对话时间条，也不吞掉其后首条对话的时间条。
 */
export function computeTimeSegmentStarts(messages: ReadonlyArray<Pick<Message, 'role' | 'timestamp'>>): boolean[] {
    const starts: boolean[] = new Array(messages.length).fill(false);
    let lastNonSystem: Pick<Message, 'role' | 'timestamp'> | null = null;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'system') continue;
        starts[i] = startsNewTimeSegment(lastNonSystem, msg);
        lastNonSystem = msg;
    }
    return starts;
}

/** 界面上的消息收发时间代表用户自己的时间，统一使用设备本地时区（见 docs/character-timezone.md）。 */
export function formatChatTimestamp(timestamp: number): string {
    const d = new Date(timestamp);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

/**
 * 顶部时间分隔条文案：今天显示 HH:mm，昨天显示「昨天 HH:mm」，同年显示「M月D日 HH:mm」，跨年带年份。
 * 统一按用户设备本地日历日判断，不混入角色自定义时区。
 */
export function formatChatTimeDivider(timestamp: number, now: Date = new Date()): string {
    const d = new Date(timestamp);
    const timePart = formatChatTimestamp(timestamp);
    const msgKey = getLocalDateKey(d);
    const nowKey = getLocalDateKey(now);
    if (msgKey === nowKey) return timePart;
    if (getCalendarDayDifference(msgKey, nowKey) === 1) return `昨天 ${timePart}`;
    const monthDay = `${d.getMonth() + 1}月${d.getDate()}日 ${timePart}`;
    return d.getFullYear() === now.getFullYear() ? monthDay : `${d.getFullYear()}年${monthDay}`;
}
