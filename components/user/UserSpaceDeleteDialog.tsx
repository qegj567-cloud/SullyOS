import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UserSpace } from '../../utils/userSpaces';
import { deleteUserSpace } from '../../utils/userSpaceDeletion';
import { setVisibleTimeout } from '../../utils/visibleTimeout';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';

export default function UserSpaceDeleteDialog({ space, onClose, onDeleted }: {
    space: UserSpace;
    onClose: () => void;
    onDeleted: (result: Awaited<ReturnType<typeof deleteUserSpace>>) => void;
}) {
    const [stage, setStage] = useState(1);
    const [remaining, setRemaining] = useState(10);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState('');
    const [error, setError] = useState('');
    useEffect(() => {
        if (remaining > 0 && !busy) return setVisibleTimeout(() => setRemaining(n => n - 1), 1000);
    }, [remaining, stage, busy]);
    useLocalBackHandler(() => { if (!busy) onClose(); return true; }, 80, true);
    return createPortal(<div className="fixed inset-0 z-[260] bg-black/45 flex items-center justify-center p-5">
        <div role="alertdialog" aria-modal="true" aria-labelledby="delete-user-title" aria-describedby="delete-user-description" className="bg-white w-full max-w-sm rounded-2xl p-5 space-y-4">
            <p className="text-xs font-medium text-red-500">删除用户 · {stage} / 2</p>
            <h2 id="delete-user-title" className="text-lg font-bold break-words">{stage === 1 ? '删除' : '最后确认：删除'}「{space.name}」？</h2>
            <div id="delete-user-description" className="text-sm text-slate-600 leading-relaxed space-y-2">
                {stage === 1 ? <><p>这个用户的角色、聊天、记忆、桌面和各 App 存档都会清空。</p><p>其他用户和共用设置会保留。其他用户还在使用的素材也会保留。</p></>
                    : <><p className="text-red-600 font-medium">删除后无法撤销。请确认已导出需要保留的内容。</p><p>此用户角色的主动消息会停用，关联的云端数据也会清理。已导出的备份不会被删除。</p><p>若清理中断，请回到这里继续删除；已经停用的角色不会自动恢复。</p></>}
            </div>
            {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
            {busy && <p role="status" className="text-xs text-slate-500">{progress || '正在删除，请稍候…'}</p>}
            <div className="flex gap-3">
                <button autoFocus disabled={busy} onClick={onClose} className="flex-1 rounded-xl py-3 text-sm bg-slate-100 disabled:opacity-40">取消</button>
                <button disabled={busy || remaining > 0} className="flex-1 rounded-xl py-3 text-sm bg-red-600 text-white disabled:opacity-40" onClick={async () => {
                    if (remaining > 0 || busy) return;
                    if (stage === 1) { setStage(2); setRemaining(10); return; }
                    setBusy(true); setError('');
                    try { onDeleted(await deleteUserSpace(space.id, setProgress)); }
                    catch (failure) { setError(failure instanceof Error ? failure.message : '删除失败，请重试'); setStage(1); setRemaining(10); setBusy(false); }
                }}>{busy ? '正在删除…' : `${stage === 1 ? '继续' : '永久删除'}${remaining > 0 ? `（${remaining}s）` : ''}`}</button>
            </div>
        </div>
    </div>, document.body);
}
