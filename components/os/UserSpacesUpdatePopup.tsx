import React, { useEffect, useId, useRef } from 'react';
import { Users, X } from '@phosphor-icons/react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import './NavigationBallNotice.css';

export const USER_SPACES_UPDATE_KEY = 'sullyos_update_user_spaces_v1_seen';

/** A shared, explicit acknowledgement; opening the notice never creates or switches a user. */
export default function UserSpacesUpdatePopup({ onDone, onVisit }: { onDone: () => void; onVisit: () => void }) {
    const dialog = useRef<HTMLDialogElement>(null), finished = useRef(false);
    const titleId = useId();
    useEffect(() => {
        const node = dialog.current; node?.showModal();
        return () => node?.close();
    }, []);
    const finish = (action: () => void) => {
        if (finished.current) return;
        finished.current = true;
        try { localStorage.setItem(USER_SPACES_UPDATE_KEY, '1'); } catch { /* Storage failure must not trap the user. */ }
        action();
    };
    useLocalBackHandler(() => { finish(onDone); return true; }, 100);
    return <dialog ref={dialog} className="navigation-ball-notice" aria-labelledby={titleId}
        onCancel={event => { event.preventDefault(); finish(onDone); }}>
        <button type="button" className="navigation-ball-notice-close" aria-label="关闭多用户空间介绍" onClick={() => finish(onDone)}><X size={20} /></button>
        <div className="navigation-ball-notice-symbol" aria-hidden="true"><Users size={30} color="white" /></div>
        <p className="navigation-ball-notice-eyebrow">糯米机 · 本次更新</p>
        <h2 id={titleId}>多用户空间来了</h2>
        <p>不同的身份，各有自己的生活。<br />在「档案 → 用户空间」新建或切换。</p>
        <ul>
            <li><strong>角色和经历分开。</strong>每个用户拥有自己的角色、桌面、聊天和记忆；系统设置共用，不用重新配。</li>
            <li><strong>在 TA 面前的我。</strong>同一个人，只想补充不同侧面？在档案里为每位角色设置专属头像、称呼、外貌和额外信息；换一个身份，就新建用户。</li>
            <li><strong>熟悉的角色，也能重新认识。</strong>在神经链接从其他用户载入角色，可按分组全选。复制设定和配置，不带聊天、记忆与相处记录；素材共用，不重复占空间。</li>
            <li><strong>主动消息照常来。</strong>切换用户不会暂停其他角色，点通知会自动进入对应用户的聊天。</li>
            <li><strong>备份与删除可按用户管理。</strong>整合导出可选当前或所有用户；删除用户会清空其专属存档，需两次 10 秒确认，其他用户仍在使用的素材会保留。</li>
        </ul>
        <footer><button type="button" onClick={() => finish(onDone)}>知道了</button><button type="button" onClick={() => finish(onVisit)}>去档案看看</button></footer>
    </dialog>;
}
