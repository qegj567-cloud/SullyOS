import React, { useEffect, useId, useRef } from 'react';
import { PlugsConnected, X } from '@phosphor-icons/react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { classifyWebDeployment } from '../../utils/deploymentSource';
import './NavigationBallNotice.css';

export const RELAY_UPDATE_KEY = 'sullyos_update_amsg2_relay_v1_seen';

/**
 * 二改网页用不了官方中转（见 docs/amsg2-relay.md「只给官方渠道用」），就别给它们推这条。
 * shortcut: 只按网址同步判断，APK 一律当官方；重签的二改 APK 也会看到，设置里的开关照样拦着
 */
export const shouldOfferRelayNotice = (href: string): boolean => classifyWebDeployment(href) !== 'unofficial';

export default function RelayUpdatePopup({ onDone, onVisit }: { onDone: () => void; onVisit: () => void }) {
    const dialog = useRef<HTMLDialogElement>(null), finished = useRef(false);
    const titleId = useId();
    useEffect(() => {
        const node = dialog.current; node?.showModal();
        return () => node?.close();
    }, []);
    const finish = (action: () => void) => {
        if (finished.current) return;
        finished.current = true;
        try { localStorage.setItem(RELAY_UPDATE_KEY, '1'); } catch { /* 存不进去也得能关掉 */ }
        action();
    };
    useLocalBackHandler(() => { finish(onDone); return true; }, 100);
    return <dialog ref={dialog} className="navigation-ball-notice" aria-labelledby={titleId}
        onCancel={event => { event.preventDefault(); finish(onDone); }}>
        <button type="button" className="navigation-ball-notice-close" aria-label="关闭大陆连接优化介绍" onClick={() => finish(onDone)}><X size={20} /></button>
        <div className="navigation-ball-notice-symbol" aria-hidden="true"><PlugsConnected size={30} color="white" /></div>
        <p className="navigation-ball-notice-eyebrow">糯米机 · 本次更新</p>
        <h2 id={titleId}>大陆连接优化</h2>
        <p>大陆网络连不上自己的 Worker、主动消息收发不了？<br />现在可以经官方中转连过去。</p>
        <ul>
            <li><strong>在群里领令牌。</strong>在 SullyOS 的 Discord 群里领取中转令牌（需要「已验证」身份组）。令牌只显示一次，再领一次就是重置。</li>
            <li><strong>填进设置就能用。</strong>在「设置 → 主动消息 2.0 → 后端 Worker」打开「大陆连接优化」，粘贴令牌。连的还是你自己的 Worker，关掉就恢复直连。</li>
            <li><strong>打开前请读完说明。</strong>中转要解开连接才能转发，技术上能看到经过的内容，但不保存；只按账号记每天用了多少流量，设置里可以查。</li>
            <li><strong>只给官方版本用。</strong>中转由维护者自费搭建，会尽力维护，但不保证一直可用。</li>
        </ul>
        <footer><button type="button" onClick={() => finish(onDone)}>知道了</button><button type="button" onClick={() => finish(onVisit)}>去设置看看</button></footer>
    </dialog>;
}
