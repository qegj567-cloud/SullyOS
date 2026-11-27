import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import React, { useEffect, useRef, useState } from 'react';
import Modal from '../os/Modal';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { countChatRecords, importChatRecordText, parseChatRecordText, readChatRecordPage, type RecordOwner } from '../../utils/chatRecordManagement';
import { formatChatTextExport } from '../../utils/chatTextExport';
import { shareOrDownloadFile } from '../../utils/shareExport';
import { trackEvent } from '../../utils/analytics';
import type { Message } from '../../types';

export default function ChatRecordManager({ owner, name, onClose, onImported }: { owner: RecordOwner; name: string; onClose: () => void; onImported: () => void }) {
    const [view, setView] = useState(false), [rows, setRows] = useState<Message[]>([]);
    const [bounds, setBounds] = useState<Array<number | undefined>>([undefined]);
    const [page, setPage] = useState(0), [more, setMore] = useState(false), [total, setTotal] = useState<number | null>(null);
    const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [status, setStatus] = useState(''), [revision, setRevision] = useState(0);
    useLocalBackHandler(() => { if (!busy) { if (view) setView(false); else onClose(); } return true; }, 70, true);
    const fileInput = useRef<HTMLInputElement>(null);
    const { requestConfirm, confirmDialog } = useConfirmDialog({ portal: true });
    useEffect(() => { let cancelled = false; setTotal(null); countChatRecords(owner).then(n => { if (!cancelled) setTotal(n); }).catch(() => { if (!cancelled) setStatus('总数读取失败'); }); return () => { cancelled = true; }; }, [owner.id, owner.group, revision]);
    useEffect(() => {
        if (!view) return;
        let cancelled = false; setLoading(true); setRows([]);
        readChatRecordPage(owner, bounds[page]).then(result => { if (!cancelled) { setRows(result.messages); setMore(result.hasMore); } }).catch(() => { if (!cancelled) setStatus('读取失败，请重新打开'); }).finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [view, page, owner.id, owner.group, revision]);
    return <>{confirmDialog}<Modal isOpen title={view ? '查看聊天记录' : '聊天记录管理'} onClose={() => { if (!busy) onClose(); }}>
        <div className="space-y-4 text-slate-800 [color-scheme:light]">
            <p className="text-sm">{name} · 共 {total === null ? '…' : total} 条</p>
            {status && <p role="status" className="text-sm text-violet-700">{status}</p>}
            {!view ? <div className="flex flex-col gap-3">
                <button disabled={busy} onClick={() => fileInput.current?.click()} className="p-3 rounded-xl bg-slate-100">导入聊天记录</button>
                <p className="text-xs text-slate-500">支持本应用导出的 TXT，追加到当前会话，不覆盖原记录、不自动生成回复。重复导入会产生重复记录；图片、表情和语音附件只能还原文字占位。时间按本机时区解释。</p>
                <button disabled={busy} className="p-3 rounded-xl bg-slate-100" onClick={async () => {
                    setBusy(true); setStatus('正在导出…');
                    try {
                        const chunks: string[] = []; let before: number | undefined;
                        for (;;) { const result = await readChatRecordPage(owner, before); if (!result.messages.length) break; chunks.unshift(formatChatTextExport(result.messages).replace(/^\uFEFF/, '')); if (!result.hasMore) break; before = result.messages[0].id; }
                        if (!chunks.length) { setStatus('暂无可导出的记录'); return; }
                        const result: string = await shareOrDownloadFile({ content: '\uFEFF' + chunks.join('\n\n'), fileName: `${name.replace(/[\\/:*?"<>|]/g, '_')}_聊天原文.txt`, mimeType: 'text/plain;charset=utf-8', shareTitle: '聊天记录' });
                        setStatus(String(result) === 'cancelled' ? '已取消导出' : '聊天记录已导出');
                    } catch { setStatus('导出失败，请重试'); } finally { setBusy(false); }
                }}>导出聊天记录</button>
                <button disabled={busy} className="p-3 rounded-xl bg-violet-600 text-white" onClick={() => { setView(true); trackEvent('查看聊天记录'); }}>查看聊天记录</button>
                <input ref={fileInput} type="file" accept=".txt,text/plain" className="hidden" onChange={async e => {
                    const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
                    setBusy(true); setStatus('');
                    try {
                        if (file.size > 50 * 1024 * 1024) throw new Error('文件超过 50MB，请分批导入');
                        const text = await file.text(), count = parseChatRecordText(text).length;
                        if (!await requestConfirm({ title: '导入聊天记录', message: `向「${name}」追加 ${count} 条记录，不覆盖现有记录。重复导入会产生重复记录。`, confirmText: '确认导入', variant: 'warning' })) return;
                        await importChatRecordText(owner, text); setStatus(`已导入 ${count} 条`); setBounds([undefined]); setPage(0); setRevision(n => n + 1); onImported(); trackEvent('导入聊天记录完成');
                    } catch (e) { setStatus(e instanceof Error ? e.message : '导入失败'); trackEvent('导入聊天记录失败'); } finally { setBusy(false); }
                }} />
            </div> : <>
                <div className="flex items-center gap-3 text-sm"><button disabled={loading || page === 0} onClick={() => setPage(p => p - 1)}>上一页</button><span>第 {page + 1} 页 · 每页 50 条</span><button disabled={loading || !more} onClick={() => { setBounds(b => [...b.slice(0, page + 1), rows[0].id]); setPage(p => p + 1); }}>下一页</button><button onClick={() => setView(false)}>返回管理</button></div>
                <div className="max-h-[55vh] overflow-y-auto space-y-3" key={page}>
                    {loading ? <p>正在读取…</p> : !rows.length ? <p>暂无记录</p> : rows.map(m => <article key={m.id} className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">{m.role === 'user' ? '我' : m.role === 'assistant' ? name : '系统'} · {new Date(m.timestamp).toLocaleString()}</p><p className="whitespace-pre-wrap break-words text-sm mt-2">{m.content.slice(0, 2000)}</p>{m.content.length > 2000 && <details><summary>展开余下正文</summary><p className="whitespace-pre-wrap break-words text-sm">{m.content.slice(2000)}</p></details>}</article>)}
                </div>
            </>}
        </div>
    </Modal></>;
}
