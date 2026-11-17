import React from 'react';
import type { ChatSendPhase } from '../../utils/chatSendProgress';
import { showInstantChatSendHelp } from '../../utils/instantChatSendHelp';
import './chatSendProgress.css';

/** CSS-only motion. No timers or per-message subscriptions; the parent updates only at phase changes. */
const ChatSendProgress: React.FC<{ phase: ChatSendPhase }> = ({ phase }) => {
    if (phase === 'accepted' || phase === 'cancelled') return null;
    const working = phase === 'preparing' || phase === 'sending';
    const title = working ? '发送中' : phase === 'local' ? '本机生成' : '发送未确认';
    return <button type="button" className="sully-chat-send-progress" data-working={working || undefined}
        aria-label={`${title}，查看说明`}
        onPointerDown={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); showInstantChatSendHelp(phase === 'local' ? 'local' : phase === 'failed' ? 'failed' : 'cloud'); }}>
        <span>{title}</span>{working && <span className="sully-send-dots" aria-hidden="true"><i /><i /><i /></span>}
    </button>;
};

export default React.memo(ChatSendProgress);
