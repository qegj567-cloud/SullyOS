import React, { useEffect, useRef } from 'react';
import { trackEvent } from '../utils/analytics';
import { formatCanaryChangelogDate, markCanaryChangelogSeen, takeCanaryChangelog, type CanaryChangelogDay } from '../utils/canaryChangelog';
import { CanaryBird } from './CanaryBird';
import { WELCOME_ON_BOOT } from './CanaryDot';
import './CanaryChangelog.css';

/**
 * canary 更新后第一次打开时，按天列出没看过的改动（docs/canary-channel.md「更新日志」）。
 * 正式版这里永远是空的。
 */
// 模块加载时算一次：和落地动画同一个判断时机，StrictMode 双跑也不会把「刚加入」读丢。
export const CANARY_CHANGELOG_ON_BOOT = takeCanaryChangelog(WELCOME_ON_BOOT);

export default function CanaryChangelog({ days, onClose, preview = false }: {
    days: CanaryChangelogDay[];
    onClose: () => void;
    /** 预览页用：不计数、不写已读。 */
    preview?: boolean;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        dialog.current?.showModal();
        if (!preview) trackEvent('弹出版本更新提醒', { 版本: 'canary-changelog' });
        return () => dialog.current?.close();
    }, [preview]);
    const close = () => {
        if (!preview) markCanaryChangelogSeen();
        onClose();
    };

    return (
        <dialog ref={dialog} className="canary-changelog" aria-labelledby="canary-changelog-title"
            onCancel={(event) => { event.preventDefault(); close(); }}>
            <CanaryBird size={34} mode="idle" className="canary-changelog-bird" />
            <p className="canary-changelog-eyebrow">canary</p>
            <h2 id="canary-changelog-title">这次更新了这些</h2>
            <div className="canary-changelog-body">
                {days.map((day) => (
                    <section key={day.date}>
                        <h3>{formatCanaryChangelogDate(day.date)}</h3>
                        <ul>{day.items.map((item) => <li key={item}>{item}</li>)}</ul>
                    </section>
                ))}
            </div>
            <button type="button" onClick={close}>知道啦</button>
        </dialog>
    );
}
