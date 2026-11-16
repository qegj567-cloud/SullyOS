import React, { useState, useSyncExternalStore } from 'react';
import MessageItem from '../../components/chat/MessageItem';
import ChatRuntimeStyle from '../../components/chat/ChatRuntimeStyle';
import { PRESET_THEMES } from '../../components/chat/ChatConstants';
import { beginChatSendProgress, getChatSendProgress, subscribeChatSendProgress } from '../../utils/chatSendProgress';
import type { Message } from '../../types';

const message = { id: 501, charId: 'send-preview', role: 'user', type: 'text', content: '等会儿见。', timestamp: 1_800_000_000_000 } as Message;
const noop = () => {};
let send: ReturnType<typeof beginChatSendProgress> | undefined;

/** Real message renderer and progress store; no real API requests or account data. */
export default function SendProgressPreview() {
    const progress = useSyncExternalStore(subscribeChatSendProgress, () => getChatSendProgress(message.charId));
    const [mounted, setMounted] = useState(true);
    const [timestamp, setTimestamp] = useState<'always' | 'never' | 'hover'>('always');
    return <div className="sully-chat-root h-full bg-slate-50 pt-8">
        <ChatRuntimeStyle />
        <div className="flex flex-wrap gap-2 px-4 mb-8 text-xs">
            <button onClick={() => { send = beginChatSendProgress(message.charId, message.id); }}>模拟准备</button>
            <button onClick={() => send?.sending()}>模拟上传</button>
            <button onClick={() => send?.accepted()}>模拟接收</button>
            <button onClick={() => send?.failed()}>模拟失败</button>
            <button onClick={() => send?.cancelled()}>模拟取消</button>
            <button onClick={() => send?.local(true)}>模拟本机生成</button>
            <button onClick={() => setMounted(value => !value)}>切出或返回聊天</button>
            <select aria-label="时间显示" value={timestamp} onChange={event => setTimestamp(event.target.value as typeof timestamp)}><option value="always">显示时间</option><option value="never">隐藏时间</option><option value="hover">悬停时间</option></select>
        </div>
        {mounted && <MessageItem msg={message} isFirstInGroup isLastInGroup activeTheme={PRESET_THEMES.default}
            charAvatar="" userAvatar="" charName="林" onLongPress={noop} onReply={noop} selectionMode={false} isSelected={false} onToggleSelect={noop}
            showTimestamp={timestamp} sendPhase={progress?.phase} />}
    </div>;
}
