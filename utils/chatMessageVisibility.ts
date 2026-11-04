import type { Message } from '../types';

/** Media references are storage identifiers, not user-visible message summaries. */
export const chatPreviewText = (message: Pick<Message, 'type' | 'content'>): string => {
    if (message.type === 'image') return '[图片]';
    if (message.type === 'emoji') return '[表情]';
    if (message.type === 'friend_feed_share_card') return '[分享好友圈帖子]';
    if (/^(blobref:|data:image\/|blob:)/i.test(message.content)) return '[图片]';
    return message.content.replace(/\[.*?\]/g, '').trim() || '[消息]';
};

/** 私聊界面的范围；见面/通话记录仍保留在库里，供各自界面和上下文使用。 */
export const isVisibleChatMessage = (message: Message, hideSystemLogs = false): boolean => (
    !message.groupId
    && message.type !== 'secret_note'
    && message.metadata?.source !== 'date'
    && message.metadata?.source !== 'call'
    && message.metadata?.source !== 'home'
    && message.metadata?.source !== 'story_theater_memory'
    && !message.metadata?.proactiveHint
    && !(hideSystemLogs && message.role === 'system' && message.type !== 'score_card' && message.type !== 'friend_feed_card')
);

/** 点击后进入私聊的桌面消息卡，与聊天页共用来源过滤，不展示系统日志。 */
export const isChatPreviewMessage = (message: Message): boolean => (
    message.role !== 'system' && isVisibleChatMessage(message)
);
