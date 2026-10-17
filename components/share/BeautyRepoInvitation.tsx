import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOS } from '../../context/OSContext';
import { beautyRequest } from '../../utils/beautyShareClient';
import { BEAUTY_USAGE_EVENT, beautyRepoDeviceId, dueBeautyRepo, markBeautyRepoPrompt, readBeautyUsage, setBeautyRepoDisabled } from '../../utils/beautyUsage';
import type { BeautyShare } from '../../utils/beautyShareContract';
import { BEAUTY_REPO_STATUS_EVENT, readBeautyRepoStatus, setBeautyRepoStatus } from '../../utils/beautyRepoStatus';
import './BeautySharePanel.css';

const OPEN = 'sully-open-beauty-repo';
function useRepoStatus(code: string) {
  const [status, setStatus] = useState(() => readBeautyRepoStatus(code));
  useEffect(() => {
    const sync = () => setStatus(readBeautyRepoStatus(code)); sync();
    window.addEventListener(BEAUTY_REPO_STATUS_EVENT, sync); window.addEventListener('storage', sync);
    return () => { window.removeEventListener(BEAUTY_REPO_STATUS_EVENT, sync); window.removeEventListener('storage', sync); };
  }, [code]);
  return status;
}
export function BeautyRepoBadge({ share }: { share: BeautyShare }) {
  const status = useRepoStatus(share.code);
  const [open, setOpen] = useState(false);
  return <><button type="button" className="wardrobe-repo-badge" onClick={() => setOpen(true)} aria-label={`${share.metadata.name}：${status ? '查看 Repo' : '待 Repo'}`}>
    {status === 'submitted' ? '已写 Repo' : status === 'manual' ? '已 Repo' : '待 Repo'}
  </button>{open && <BeautyRepoDialog share={share} onClose={() => setOpen(false)}/>}</>;
}
export function BeautyRepoLibrary() {
  const [state, setState] = useState(readBeautyUsage);
  useEffect(() => { const sync = () => setState(readBeautyUsage()); window.addEventListener(BEAUTY_USAGE_EVENT, sync); return () => window.removeEventListener(BEAUTY_USAGE_EVENT, sync); }, []);
  return <details className="beauty-repo-library"><summary>Repo 提醒设置</summary><p>想分享感受时，点装扮右上角的 Repo 就好。不着急，也不影响使用。</p>
    <label className="beauty-share-check"><input type="checkbox" checked={!state.disabled} onChange={e => setBeautyRepoDisabled(!e.target.checked)}/>使用超过 3 天时提醒我支持作者</label>
  </details>;
}
export default function BeautyRepoInvitation({ ready, blocked }: { ready: boolean; blocked: boolean }) {
  const { characters } = useOS();
  const [share, setShare] = useState<BeautyShare | null>(null);
  useEffect(() => {
    if (!ready) return;
    const open = (event: Event) => { const value = (event as CustomEvent<BeautyShare>).detail; if (value?.metadata && /^S-[A-F0-9]{12}$/.test(value.code)) setShare(value); };
    window.addEventListener(OPEN, open); return () => window.removeEventListener(OPEN, open);
  }, [ready]);
  useEffect(() => {
    if (!ready || blocked || share) return;
    let cancelled = false;
    const check = async () => {
      const claim = () => {
        if (cancelled || document.visibilityState !== 'visible' || document.querySelector('dialog[open], [role="dialog"], .sully-repo-overlay')) return;
        const item = dueBeautyRepo(readBeautyUsage(), Date.now(), ['collaboration', 'appearance', 'appearance:schedule', 'appearance:journal', 'chat:global', ...characters.map(c => 'chat:' + c.id)]);
        if (!item) return;
        try { markBeautyRepoPrompt(item.share.code); setShare(item.share); } catch { /* Without persistence, don't repeatedly prompt. */ }
      };
      if (navigator.locks) await navigator.locks.request('sully-beauty-repo-prompt', claim); else claim();
    };
    const run = () => { void check().catch(() => {}); };
    const timer = window.setTimeout(run, 2500); const interval = window.setInterval(run, 60_000);
    document.addEventListener('visibilitychange', run);
    return () => { cancelled = true; clearTimeout(timer); clearInterval(interval); document.removeEventListener('visibilitychange', run); };
  }, [ready, blocked, share, characters]);
  return share && ready ? <BeautyRepoDialog key={share.code} share={share} onClose={() => setShare(null)}/> : null;
}
export function BeautyRepoDialog({ share, onClose }: { share: BeautyShare; onClose: () => void }) {
  const repoStatus = useRepoStatus(share.code);
  const dialog = useRef<HTMLDialogElement>(null);
  const requestId = useRef(crypto.randomUUID());
  const pendingBody = useRef<unknown>(null);
  const [signature, setSignature] = useState(''); const [message, setMessage] = useState('');
  const [mode, setMode] = useState<'invitation' | 'write' | 'platform' | 'done'>('invitation');
  const [consent, setConsent] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const submit = async () => {
    if (busy) return; setError('');
    if (!consent || !signature.trim() || !message.trim()) { setError('请填写署名和 Repo，并确认人工转达说明。'); return; }
    setBusy(true);
    try {
      // Keep the same payload and idempotency key after an uncertain network result.
      pendingBody.current ||= { code: share.code, revision: share.revision, requestId: requestId.current, deviceId: beautyRepoDeviceId(), signature: signature.trim(), message: message.trim(), consent: true };
      await beautyRequest('/repos', { method: 'POST', body: pendingBody.current });
      try { setBeautyRepoStatus(share.code, 'submitted'); markBeautyRepoPrompt(share.code); } catch { /* Server receipt already succeeded. */ }
      setMode('done');
    } catch (e) { setError(e instanceof Error ? e.message : '提交失败，请重试'); }
    finally { setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} className="beauty-repo-dialog" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }} aria-labelledby="beauty-repo-title">
    <div className="beauty-repo-paper"><header><span>SULLY · 给作者的小纸条</span><button disabled={busy} onClick={onClose} aria-label="关闭 Repo">×</button></header>
      <p className="beauty-repo-eyebrow">{share.metadata.credit} 的作品</p><h2 id="beauty-repo-title">{mode === 'done' ? '心意，已收到。' : mode === 'write' ? '让 Sully 帮你转达' : '喜欢的话，告诉作者吧。'}</h2>
      <p className="beauty-repo-work">{share.metadata.name}</p>
      {mode === 'invitation' && <><p>{repoStatus === 'submitted' ? '你的小纸条已交给管理员，等待人工转达，谢谢你的心意。' : '喜欢这份美化的话，可以留下一点使用感受。不着急，什么时候想说都可以。'}</p><div className="beauty-repo-choices"><button className="primary" onClick={() => setMode('write')}>{repoStatus ? '再留一点感受 · 请 Sully 转达' : '写一份 Repo · 请 Sully 转达'}</button><button onClick={() => setMode('platform')}>自己去作者的平台 Repo</button></div><button className="quiet" onClick={onClose}>先收好，以后再说</button></>}
      {mode === 'platform' && <><p>可以在这些平台找到作者：</p><strong>{share.metadata.platforms.join(' / ')}</strong><p className="beauty-share-message">{share.metadata.contact || '作者没有补充昵称，可凭作品名和署名在发放平台寻找。'}</p><p>署名：{share.metadata.credit}<br/>美化码：{share.code}</p><button onClick={() => setMode('write')}>也可以请 Sully 转达 →</button></>}
      {(mode === 'invitation' || mode === 'platform') && repoStatus !== 'submitted' && <div className="beauty-repo-personal"><label className="beauty-share-check"><input type="checkbox" checked={repoStatus === 'manual'} onChange={e => { try { setBeautyRepoStatus(share.code, e.target.checked ? 'manual' : null); setError(''); } catch { setError('这次没能保存标记，请稍后重试。'); } }}/>我已当面完成 Repo</label><p className="beauty-repo-footnote">只在这台设备记一下，也可以取消勾选。不会通知作者，不影响美化的使用。</p>{repoStatus === 'manual' && <p>心意已经送到，就不再为这份美化提醒你啦。</p>}{error && <p role="alert">{error}</p>}</div>}
      {mode === 'write' && <><p>这是一份私密 Repo。管理员会整理成卡片，再由 Sully 的 QQ 人工转达给作者。</p><fieldset disabled={busy || !!pendingBody.current}><label>你的署名<input autoComplete="off" value={signature} maxLength={60} placeholder="作者会看到这个名字" onChange={e => setSignature(e.target.value)}/></label><label>想对作者说<textarea rows={5} maxLength={1200} value={message} placeholder="喜欢的细节、使用感受，或想说的一声谢谢……" onChange={e => setMessage(e.target.value)}/></label><small>{message.length} / 1200</small><label className="beauty-share-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/>我同意将上述署名和文字交给管理员，并人工转达给这份美化的作者。</label></fieldset><p className="beauty-repo-footnote">不会公开展示，不会读取聊天或自动附带截图；转达需要人工处理，不会立即送达。</p>{error && <p role="alert" className="beauty-share-error">{error}</p>}{pendingBody.current && error && <p>为避免重复，重试会发送同一份内容。</p>}<button className="primary" disabled={busy || !consent || !signature.trim() || !message.trim()} onClick={submit}>{busy ? '正在提交…' : '提交私密 Repo'}</button></>}
      {mode === 'done' && <><p>已交给管理员整理，等待 Sully 人工转达。谢谢你愿意把喜欢告诉作者。</p><button className="primary" onClick={onClose}>好，辛苦 Sully 啦</button></>}
    </div>
  </dialog>, document.body);
}
