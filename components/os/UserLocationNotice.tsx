import React, { useEffect, useId, useRef } from 'react';
import { MapPin, X } from '@phosphor-icons/react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import './NavigationBallNotice.css';

export const USER_LOCATION_NOTICE_KEY = 'sullyos_real_location_intro_v1_seen';

/** Opening this announcement never enables the feature or requests a location. */
export default function UserLocationNotice({ onDone, onConfigure }: { onDone: () => void; onConfigure: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), finished = useRef(false);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current; node?.showModal();
    return () => node?.close();
  }, []);
  const finish = (action: () => void) => {
    if (finished.current) return;
    finished.current = true;
    try { localStorage.setItem(USER_LOCATION_NOTICE_KEY, '1'); } catch { /* Closing must remain usable. */ }
    action();
  };
  useLocalBackHandler(() => { finish(onDone); return true; }, 100);
  return <dialog ref={dialog} className="navigation-ball-notice" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); finish(onDone); }}>
    <button type="button" className="navigation-ball-notice-close" aria-label="关闭真实定位介绍" onClick={() => finish(onDone)}><X size={20} /></button>
    <div className="navigation-ball-notice-symbol" aria-hidden="true"><MapPin size={30} color="white" /></div>
    <p className="navigation-ball-notice-eyebrow">糯米机 · 实时感知</p>
    <h2 id={titleId}>真实定位来了</h2>
    <p>让角色知道你现在在哪。默认关闭，可在「设置 → 实时感知 → 真实定位」开启。</p>
    <ul>
      <li>不用 Key 也能定位到区镇；想显示街道、附近地点，可配置高德 Key，申请时请选择 <strong>Web服务</strong>。</li>
      <li>API 中转站理论上能看到你发给角色的聊天内容。地址不想发出去，就设置隐藏地点：<br /><b>具体地址 → 在家附近</b>。</li>
    </ul>
    <footer><button type="button" onClick={() => finish(onDone)}>知道了</button><button type="button" onClick={() => finish(onConfigure)}>去设置</button></footer>
  </dialog>;
}
