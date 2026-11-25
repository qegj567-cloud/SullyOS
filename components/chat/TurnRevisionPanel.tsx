import HtmlCard from './HtmlCard';
import { renderContent } from './renderChatText';
import type { Message } from '../../types';
import React, { useEffect, useRef, useState } from 'react';
import type { DraftBubble, RevisionMode, TurnPreview } from '../../utils/chatTurnRevision';
import { trackEvent } from '../../utils/analytics';
import { useBlobRefUrl } from '../../utils/blobRef';

export interface TurnRevisionControls {
    roundRows?: Message[];
    canRevise: boolean;
    onPreview: (mode: RevisionMode, guidance: string, signal: AbortSignal, targetIds?: number[]) => Promise<TurnPreview>;
    onAccept: (preview: TurnPreview) => Promise<void>;
}

function BubbleContent({ row }: { row: DraftBubble }) {
    const url = useBlobRefUrl(row.type === 'emoji' ? row.content : undefined);
    if (row.type === 'emoji') return <img src={url || undefined} alt={row.metadata?.stickerName || '表情包'} className="h-16 w-16 object-contain" />;
    if (row.type === 'html_card' && row.metadata?.htmlSource) return <HtmlCard html={row.metadata.htmlSource}/>;
    const displayText = row.metadata?.sarModuleSurface?.surface || row.content;
    const [original, translation] = displayText.split(/\s*%%BILINGUAL%%\s*/);
    return <div className="whitespace-pre-wrap break-words rounded-xl bg-white/10 px-3 py-2">
        {row.replyTo && <small className="block opacity-65">回复 {row.replyTo.name} · {row.replyTo.content}</small>}
        {renderContent(original.replace(/<语音[^>]*>([\s\S]*?)<\/语音>/g, '♫ $1').replace(/<字幕>([\s\S]*?)<\/字幕>/g, '\n$1'))}{translation && <span className="block mt-1 pt-1 border-t border-white/20 text-violet-200">{renderContent(translation)}</span>}
    </div>;
}

export function Bubble({ row }: { row: DraftBubble }) {
    return <li><BubbleContent row={row}/></li>;
}

export default function TurnRevisionPanel({ mode, roundRows = [], canRevise, onPreview, onAccept, onDone, setSaving }: TurnRevisionControls & {
    mode: RevisionMode; onDone: () => void; setSaving: (saving: boolean) => void;
}) {
    const [targetIds, setTargetIds] = useState<number[]>([]);
    const [guidance, setGuidance] = useState('');
    const [preview, setPreview] = useState<TurnPreview>();
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState('');
    const running = useRef<AbortController | null>(null);
    const saving = useRef(false);
    useEffect(() => () => running.current?.abort(), []);
    const generate = async () => {
        if (running.current || !canRevise) return;
        const controller = new AbortController();
        running.current = controller;
        setBusy(true);
        setNotice('');
        try {
            const result = await onPreview(mode, guidance, controller.signal, targetIds.length ? targetIds : undefined);
            if (controller.signal.aborted) return;
            if (mode === 'format' && result.originals.every((row, i) => row === result.bubbles[i]) && result.originals.length === result.bubbles.length) {
                setNotice('自查完成，本轮没有需要修复的格式。');
            } else setPreview(result);
        } catch (error) {
            if (!controller.signal.aborted) {
                setNotice(error instanceof Error ? error.message : '生成失败，请重试。');
                trackEvent('对话校准预览失败');
            }
        } finally {
            if (!controller.signal.aborted) setBusy(false);
            running.current = null;
        }
    };
    const accept = async () => {
        if (!preview || saving.current) return;
        saving.current = true;
        setSaving(true);
        setBusy(true);
        try { await onAccept(preview); onDone(); }
        catch (error) { setNotice(error instanceof Error ? error.message : '未能采用新版，请重试。'); trackEvent('对话校准采用失败'); }
        finally { saving.current = false; setSaving(false); setBusy(false); }
    };
    return <section className="mt-6 space-y-4 text-sm text-white/90">
        {preview ? <>
            <details className="rounded-xl border border-white/15 p-3"><summary>查看原版 · {preview.originals.length} 个气泡</summary>
                <ul className="mt-2 space-y-2">{preview.originals.map(row => <Bubble key={row.id} row={row}/>)}</ul>
            </details>
            <h2 className="font-semibold">候选新版</h2>
            {!preview.bubbles.length && <p>清理后没有对白。采用新版会移除本轮全部待修气泡。</p>}
            <ul className="space-y-2">{preview.bubbles.map((row, i) => <Bubble key={i} row={row}/>)}</ul>
            <div className="flex gap-2">
                <button className="memory-action-quiet flex-1" disabled={busy} onClick={onDone}>保留原版</button>
                <button className="memory-action-primary flex-1" disabled={busy || !canRevise} onClick={accept}>{busy ? '正在保存…' : '采用新版'}</button>
            </div>
            <button className="underline" disabled={busy} onClick={() => { setPreview(undefined); setNotice(''); }}>调整说明并重试</button>
        </> : <>
            <div className="flex items-center justify-between gap-3">
                <h2 className="font-semibold">本轮回复</h2>
                {mode === 'reroll' && <button type="button" disabled={busy} aria-pressed={targetIds.length === 0}
                    className="rounded-full border border-white/20 px-3 py-1.5 text-xs aria-pressed:border-violet-200 aria-pressed:bg-violet-200/15"
                    onClick={() => setTargetIds([])}>整轮重写</button>}
            </div>
            {mode === 'reroll' && <p className="text-xs text-white/70">点选想重写的气泡，可多选，再点一下取消。</p>}
            <ul className="space-y-2">{roundRows.map((row, i) => {
                if (mode !== 'reroll' || !['text', 'html_card', 'emoji'].includes(row.type)) return <Bubble key={row.id} row={row}/>;
                const selected = targetIds.includes(row.id);
                return <li key={row.id} className={`relative rounded-xl border pr-9 transition-colors ${selected ? 'border-violet-200 bg-violet-300/20' : 'border-white/15 bg-white/5'}`}>
                    <div {...{ inert: '' }} className="pointer-events-none"><BubbleContent row={row}/></div>
                    <button type="button" aria-label={`选择第 ${i + 1} 个气泡：${row.metadata?.stickerName || row.content.slice(0, 60)}`} aria-pressed={selected} disabled={busy}
                        onClick={() => setTargetIds(ids => ids.includes(row.id) ? ids.filter(id => id !== row.id) : [...ids, row.id])} className="absolute inset-0 flex w-full items-center justify-end rounded-xl px-3 focus-visible:outline-violet-200">
                        <span aria-hidden="true" className={`grid h-5 w-5 place-items-center rounded-full border text-xs ${selected ? 'border-violet-200 bg-violet-200 text-violet-950' : 'border-white/40'}`}>{selected && '✓'}</span>
                    </button>
                </li>;
            })}</ul>
            <label className="block space-y-2"><span>{mode === 'format' ? '本轮哪里显示不对？' : targetIds.length === 0 ? '希望这一轮怎么重写？' : '希望选中的气泡怎么重写？'}</span>
                <textarea className="w-full min-h-24 rounded-xl border border-white/20 bg-black/25 px-3 py-2 text-white placeholder:text-white/45" value={guidance} disabled={busy}
                    onChange={e => setGuidance(e.target.value)} placeholder={mode === 'format' ? '例如「第二句的译文跑到了气泡外」。留空可自动检查。' : '可写方向和原因，例如「我刚在说告别，希望 TA 回应这件事」。'}/>
            </label>
            <p className="text-xs leading-relaxed text-white/65">{mode === 'format' ? '只校对本轮回复的显示格式，保留原话和原意。' : '按本轮回复前的聊天上下文生成候选，可与原版对照。'}</p>
            <button className="memory-action-primary disabled:opacity-50" disabled={busy || !canRevise} onClick={generate}>{busy ? '正在生成候选…' : mode === 'format' ? '检查并修复本轮' : targetIds.length === 0 ? '生成候选回复' : `重写选中的 ${targetIds.length} 条`}</button>
        </>}
        {!canRevise && <p className="text-sm text-violet-200">请等当前回复完成，并在聊天末尾为角色回复时使用。</p>}
        {notice && <p role="status" className="text-sm text-violet-200">{notice}</p>}
    </section>;
}
