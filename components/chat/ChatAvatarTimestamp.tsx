import React from 'react';
import { formatChatTimestamp } from '../../utils/chatMessageGrouping';

/** The caption occupies space in the avatar slot, including when a location pin follows it. */
export const AVATAR_TIMESTAMP_HEIGHT = 14;

export default function ChatAvatarTimestamp({ timestamp, hover }: { timestamp: number; hover: boolean }) {
    return (
        <span className={`sully-chat-avatar-timestamp sully-chat-timestamp block w-full pt-0.5 text-center text-[9px] leading-3 tabular-nums text-slate-500 whitespace-nowrap pointer-events-none ${hover ? 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100' : ''}`}>
            {formatChatTimestamp(timestamp)}
        </span>
    );
}
