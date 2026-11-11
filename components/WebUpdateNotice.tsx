import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useOS } from '../context/OSContext';
import { UPDATE_READY_MESSAGE, webUpdateSession } from '../utils/webUpdateSession';
import './WebUpdateNotice.css';

export default function WebUpdateNotice() {
  const state = useSyncExternalStore(webUpdateSession.subscribe, webUpdateSession.getSnapshot, webUpdateSession.getSnapshot);
  const { sysOperation, suspendedCall, suspendedDate, activeApp } = useOS();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    webUpdateSession.setBlocked(sysOperation.status === 'processing' || Boolean(suspendedCall) || Boolean(suspendedDate) || activeApp === 'call');
    return () => webUpdateSession.setBlocked(false);
  }, [sysOperation.status, suspendedCall, suspendedDate, activeApp]);
  if (!state.available || state.dismissed) return null;
  return createPortal(
    <aside className="sully-web-update" role="region" aria-label="网页更新">
      <strong>{confirming ? '更新并刷新页面？' : '新版本已准备好'}</strong>
      <p>{confirming ? '请先保存正在编辑的内容。聊天记录和角色数据会保留。' : '可以现在更新，也可以忙完后到设置里点「检查网页更新」。'}</p>
      {state.message && state.message !== UPDATE_READY_MESSAGE && <p role="status">{state.message}</p>}
      <div>
        <button type="button" disabled={state.working} onClick={() => confirming ? void webUpdateSession.apply() : setConfirming(true)}>{state.working ? '正在更新…' : confirming ? '保存好了，刷新' : '立即更新'}</button>
        <button type="button" disabled={state.working} onClick={() => { setConfirming(false); webUpdateSession.dismiss(); }}>稍后</button>
      </div>
    </aside>, document.body,
  );
}
