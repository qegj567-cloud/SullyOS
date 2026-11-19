import React from 'react';
import { formatChatTimestamp } from '../../utils/chatMessageGrouping';
import { getLocalDateKey } from '../../utils/localDate';

export function ChatDayDivider({ timestamp, now = new Date() }: { timestamp: number; now?: Date }) {
    const day = new Date(timestamp);
    const dayKey = getLocalDateKey(day);
    const prefix = dayKey === getLocalDateKey(now) ? '今日 · ' : day.getFullYear() !== now.getFullYear() ? day.getFullYear() + '年' : '';
    return <div className="sully-chat-day-divider" style={{display: 'var(--sully-chat-day-divider-display, none)'}}>
        <time dateTime={dayKey}>{prefix}{day.getMonth() + 1}月{day.getDate()}日</time>
    </div>;
}

/** The caption occupies space in the avatar slot, including when a location pin follows it. */
export const AVATAR_TIMESTAMP_HEIGHT = 14;

export default function ChatAvatarTimestamp({ timestamp, hover }: { timestamp: number; hover: boolean }) {
    return (
        <span className={`sully-chat-avatar-timestamp sully-chat-timestamp block w-full pt-0.5 text-center text-[9px] leading-3 tabular-nums text-slate-500 whitespace-nowrap pointer-events-none ${hover ? 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100' : ''}`}>
            {formatChatTimestamp(timestamp)}
        </span>
    );
}
