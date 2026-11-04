import React, { useEffect, useId, useRef } from 'react';
import { X } from '@phosphor-icons/react';
import './NavigationBallNotice.css';

export const NAVIGATION_BALL_NOTICE_KEY = 'sullyos_navigation_ball_intro_v1_seen';
/** Use the existing release queue; only an explicit dismissal acknowledges this notice. */
export default function NavigationBallNotice({ onDone, onConfigure }: { onDone: () => void; onConfigure: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), finished = useRef(false);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current; node?.showModal();
    return () => node?.close();
  }, []);
  const finish = (action: () => void) => {
    if (finished.current) return;
    finished.current = true;
    try { localStorage.setItem(NAVIGATION_BALL_NOTICE_KEY, '1'); } catch { /* Closing must remain usable. */ }
    action();
  };
  return <dialog ref={dialog} className="navigation-ball-notice" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); finish(onDone); }}>
    <button type="button" className="navigation-ball-notice-close" aria-label="关闭悬浮球介绍" onClick={() => finish(onDone)}><X size={20} /></button>
    <div className="navigation-ball-notice-symbol" aria-hidden="true"><span /></div>
    <p className="navigation-ball-notice-eyebrow">糯米机 · 快捷导航</p>
    <h2 id={titleId}>悬浮球来了</h2>
    <p>常用入口，放在手边。</p>
    <ul>
      <li>拖动调整位置，点开可回桌面、返回或打开 API 配置。</li>
      <li>4 个自定义槽位，可选 App、角色和分区，直达常用页面。</li>
      <li>默认关闭。在「设置 → 悬浮球设置」开启；找不到球时，可用「悬浮球复位抢救」。</li>
    </ul>
    <footer><button type="button" onClick={() => finish(onDone)}>知道了</button><button type="button" onClick={() => finish(onConfigure)}>去设置</button></footer>
  </dialog>;
}
