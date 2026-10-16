import React, { useEffect, useRef, useState } from 'react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import type { DeploymentSource } from '../../utils/deploymentSource';
import './deployment-notice.css';

export default function DeploymentNotice({ source, onAccept }: {
  source: Exclude<DeploymentSource, 'official'>;
  onAccept: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const startedAt = useRef<number | null>(null);
  const accepted = useRef(false);
  const [remaining, setRemaining] = useState(10);
  useLocalBackHandler(() => true, 100);

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    title.current?.focus();
    startedAt.current = performance.now();
    const timer = window.setInterval(() => {
      const seconds = Math.max(0, Math.ceil((10_000 - (performance.now() - startedAt.current!)) / 1000));
      setRemaining(seconds);
      if (seconds === 0) window.clearInterval(timer);
    }, 100);
    return () => {
      window.clearInterval(timer);
      startedAt.current = null;
      element?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const confirm = () => {
    if (accepted.current || startedAt.current === null || performance.now() - startedAt.current < 10_000) return;
    accepted.current = true;
    onAccept();
  };

  return <dialog ref={dialog} className="deployment-notice" aria-labelledby="deployment-notice-title"
    onCancel={event => { event.preventDefault(); event.stopPropagation(); }}>
    <header>
      <p className="deployment-notice-brand">SullyOS · 糯米机</p>
      <h2 ref={title} tabIndex={-1} id="deployment-notice-title">版本来源提醒</h2>
    </header>
    <div className="deployment-notice-content">
      <p className="deployment-notice-source">{source === 'unknown'
        ? '无法确认当前使用的糯米机是否为官方版本。'
        : '当前使用的糯米机版本是非官方／二改版本。'}</p>
      <p>请确保您已确认该来源可信、代码可靠。</p>
      <p className="deployment-notice-risk">非官方版本可能存在<strong className="text-red-700">全部聊天记录、API 密钥</strong>等敏感数据泄漏，以及<strong className="text-red-700">欺诈、恶意代码或病毒</strong>等严重风险。</p>
      <p>糯米机官方不为使用{source === 'unknown' ? '非官方版本' : '此版本'}产生的任何问题负责。</p>
    </div>
    <footer><button type="button" disabled={remaining > 0} onClick={confirm}>
      {remaining > 0 ? `确定（${remaining} 秒）` : '确定'}
    </button></footer>
  </dialog>;
}
