import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';

export default function PhotoSendDialog({ file, onSend, onClose }: { file: File; onSend: (original: boolean) => void; onClose: () => void }) {
    const [original, setOriginal] = useState(false);
    const [busy, setBusy] = useState(false);
    const { requestConfirm, confirmDialog } = useConfirmDialog({ portal: true });
    useLocalBackHandler(() => { if (!busy) onClose(); return true; }, 70, true);
    return createPortal(<>{confirmDialog}<div role="dialog" aria-modal="true" aria-label="发送相册图片" className="fixed inset-0 z-[9999] bg-black/40 flex items-center justify-center p-5 text-slate-800">
        <div className="bg-white rounded-2xl p-5 w-full max-w-sm space-y-4 [color-scheme:light]">
            <h2 className="font-bold">发送相册图片</h2><p className="text-sm break-all">{file.name}</p>
            <label className="flex gap-2"><input type="checkbox" checked={original} disabled={busy} onChange={e => setOriginal(e.target.checked)} />发送原图</label>
            <p className="text-xs text-slate-500">默认压缩后发送，原图保留文件原始画质。</p>
            <div className="flex gap-3"><button disabled={busy} onClick={onClose} className="flex-1 py-2 rounded-xl bg-slate-100">取消</button><button disabled={busy} className="flex-1 py-2 rounded-xl bg-violet-600 text-white" onClick={async () => {
                setBusy(true);
                let skip = false;
                try { skip = localStorage.getItem('chat_original_photo_notice_dismissed') === '1'; } catch { /* Optional preference. */ }
                if (original && !skip) {
                    let remember = false;
                    const accepted = await requestConfirm({ title: '发送原图提醒', variant: 'warning', confirmText: '仍然发送原图', message: <div className="space-y-3"><p>原图可能造成模型识图 Token 用量暴增，存储占用可能翻倍甚至更多。实际用量取决于图片和模型。</p><label className="flex gap-2"><input type="checkbox" onChange={e => { remember = e.target.checked; }} />不再提示</label></div> });
                    if (!accepted) { setBusy(false); return; }
                    if (remember) try { localStorage.setItem('chat_original_photo_notice_dismissed', '1'); } catch { /* Send still works. */ }
                }
                onSend(original);
            }}>发送</button></div>
        </div>
    </div></>, document.body);
}
