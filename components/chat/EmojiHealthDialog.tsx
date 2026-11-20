import { trackEvent } from '../../utils/analytics';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Emoji } from '../../types';
import { scanEmojiLibrary, type EmojiScan } from '../../utils/emojiHealth';
import Modal from '../os/Modal';

type Props = {
    emojis: Emoji[];
    onClose: () => void;
    onRemove: (items: Emoji[]) => Promise<number>;
    onRefreshed: () => void;
};

export default function EmojiHealthDialog({ emojis, onClose, onRemove, onRefreshed }: Props) {
    const [progress, setProgress] = useState(0);
    const [report, setReport] = useState<EmojiScan>();
    const [confirming, setConfirming] = useState(false);
    const [removing, setRemoving] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        scanEmojiLibrary(emojis, controller.signal, setProgress).then(result => {
            if (!controller.signal.aborted) {
                setReport(result);
                onRefreshed();
            }
        });
        return () => controller.abort();
    }, [emojis, onRefreshed]);
    const problemCount = report ? report.missing.length + report.unavailable.length : 0;
    const remove = async () => {
        if (!report || !problemCount || removing) return;
        setRemoving(true);
        setError('');
        try {
            const checked = await scanEmojiLibrary([...report.missing, ...report.unavailable], new AbortController().signal, () => {});
            const failed = [...checked.missing, ...checked.unavailable];
            const count = failed.length ? await onRemove(failed) : 0;
            if (count > 0) trackEvent('清除失效表情');
            setReport({ usable: report.usable.concat(checked.usable), unknown: report.unknown.concat(checked.unknown), missing: [], unavailable: [] });
            setMessage(`已从表情库清除 ${count} 张。` + (count < problemCount ? `其余 ${problemCount - count} 张已跳过。` : ''));
            setConfirming(false);
            onRefreshed();
        } catch { setError('未能完成清除，请重试。'); }
        finally { setRemoving(false); }
    };
    const close = () => { if (!removing) onClose(); };
    const secondary = 'flex-1 rounded-2xl bg-slate-100 py-3 text-sm font-medium text-slate-600';
    const footer = <>
        <button className={secondary} disabled={removing} onClick={confirming ? () => setConfirming(false) : close}>{confirming ? '返回' : report ? '完成' : '停止排查'}</button>
        {problemCount > 0 && <button className="flex-1 rounded-2xl bg-red-50 py-3 text-sm font-semibold text-red-600 disabled:opacity-50" disabled={removing}
            onClick={confirming ? remove : () => setConfirming(true)}>{removing ? '正在复查并清除…' : confirming ? `确认清除 ${problemCount} 张` : `一键清理（${problemCount} 张）`}</button>}
    </>;
    return createPortal(<Modal isOpen title="刷新与排查表情包" onClose={close} footer={footer}>
        <div className="space-y-3 text-sm leading-relaxed text-slate-600">
            <p>检查当前用户的全部分类，含其他角色的专属分类。</p>
            {!report ? <div role="status">正在检查 {progress} / {emojis.length} 张…</div> : <>
                <p role="status">{message || `可用 ${report.usable.length} 张 · 可清理 ${problemCount} 张 · 待重试 ${report.unknown.length} 张`}</p>
                {!!report.missing.length && <details open>
                    <summary className="font-medium text-slate-800">确认失效（{report.missing.length}）</summary>
                    <p className="mt-1 break-words">{report.missing.map(e => e.name).join('、')}</p>
                </details>}
                {!!report.unavailable.length && <details open>
                    <summary className="font-medium text-slate-800">当前无法显示（{report.unavailable.length}）</summary>
                    <p className="mt-1 break-words">{report.unavailable.map(e => e.name).join('、')}</p>
                    <p className="mt-1 text-xs">这些图片打开失败。图床恢复后可能重新可用。</p>
                </details>}
                {!!report.unknown.length && <details>
                    <summary className="font-medium text-slate-800">待重试（{report.unknown.length}）</summary>
                    <p className="mt-1 break-words">{report.unknown.map(e => e.name).join('、')}</p>
                    <p className="mt-1 text-xs">网络、权限或图床响应暂时无法确认，稍后可以再排查。</p>
                </details>}
                {!!report.usable.length && <details>
                    <summary className="font-medium text-slate-800">可用（{report.usable.length}）</summary>
                    <p className="mt-1 break-words">{report.usable.map(e => e.name).join('、')}</p>
                </details>}
                {confirming && <p className="text-red-600">将复查这 {problemCount} 张表情，从当前用户的表情库移除仍然打不开的条目。</p>}
                {error && <p role="alert" className="text-red-600">{error}</p>}
            </>}
        </div>
    </Modal>, document.body);
}
