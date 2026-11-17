import React, { useEffect, useId, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { closeInstantChatSendHelp, getInstantChatSendHelp, subscribeInstantChatSendHelp } from '../../utils/instantChatSendHelp';
import './chatSendProgress.css';

/** One shared, on-demand help dialog; no chat content, credentials or request state are stored here. */
export default function InstantChatSendHelp() {
    const reason = useSyncExternalStore(subscribeInstantChatSendHelp, getInstantChatSendHelp, () => null);
    const dialog = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    useEffect(() => {
        if (!reason) return;
        const element = dialog.current;
        element?.showModal();
        return () => { element?.close(); };
    }, [reason]);
    useLocalBackHandler(() => { closeInstantChatSendHelp(); return true; }, 160, !!reason);
    if (!reason) return null;
    return createPortal(<dialog ref={dialog} className="instant-send-help" aria-labelledby={titleId}
        onCancel={event => { event.preventDefault(); closeInstantChatSendHelp(); }}>
        <h3 id={titleId}>等「发送中」消失后再离开</h3>
        <div className="instant-send-demo" role="img" aria-label="示意：消息下方、时间左侧显示发送中；云端接收后，发送中消失，只留下时间。">
            <div className="instant-send-demo-bubble">等会儿见。</div>
            <div className="instant-send-demo-meta"><span className="instant-send-demo-working">发送中<span>···</span></span><span>12:30</span></div>
            <div className="instant-send-demo-caption">↑ 看到这里，请再等几秒</div>
        </div>
        {reason === 'local' && <p className="instant-send-help-notice">这一轮在本机生成，请保持 App 打开，等待回复完成。</p>}
        {reason === 'failed' && <p className="instant-send-help-notice">尚未确认云端收到，请先检查聊天中的错误提示。</p>}
        <p>每次回复前都需要整理聊天记录和记忆，所以会花几秒准备，<strong>不开启即时聊天也一样</strong>。</p>
        <p><strong>「发送中」消失后，可以直接离开 App，等 TA 回复，不用一直开着。</strong></p>
        <button type="button" className="instant-send-help-close" onClick={closeInstantChatSendHelp}>知道了</button>
    </dialog>, document.body);
}
