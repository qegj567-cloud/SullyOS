import React, { useEffect, useRef, useState } from 'react';
import type { CharacterProfile, Message } from '../../types';
import Modal from '../os/Modal';
import SecretNote from './SecretNote';
import { formatRangeTimestamp, loadRangeMessagePage } from '../../utils/memoryPalace/rangeMessagePage';
import { CHAT_CLEANUP_CONFIRMATION, deleteChatHistoryCleanup, prepareChatHistoryCleanup, type ChatCleanupPlan } from '../../utils/chatHistoryCleanup';

interface Props {
    character: Pick<CharacterProfile, 'id' | 'name'>;
    onClose: () => void;
    onDeleted: (plan: ChatCleanupPlan) => void | Promise<void>;
}
type Phase = 'select' | 'review' | 'confirm' | 'deleting' | 'done';
const sourceLabels: Record<string, string> = { date: '见面', call: '通话', home: '3D 小屋', story_theater_memory: '剧情陪伴' };
const sourceLabel = (message: Message) => sourceLabels[String(message.metadata?.source)] || '聊天';

/** 独立清理入口；不调用总结 API，也不更改 AI 可见范围和记忆水位线。 */
export default function ChatHistoryCleanupModal({ character, onClose, onDeleted }: Props) {
    const [mode, setMode] = useState<'range' | 'keep'>('range');
    const [phase, setPhase] = useState<Phase>('select');
    const [query, setQuery] = useState('');
    const [cursor, setCursor] = useState<{ beforeId?: number; afterId?: number }>({});
    const [rows, setRows] = useState<Message[]>([]);
    const [hasOlder, setHasOlder] = useState(false);
    const [hasNewer, setHasNewer] = useState(false);
    const [loading, setLoading] = useState(false);
    const [start, setStart] = useState<Message | null>(null);
    const [end, setEnd] = useState<Message | null>(null);
    const [keep, setKeep] = useState('200');
    const [plan, setPlan] = useState<ChatCleanupPlan | null>(null);
    const [preparing, setPreparing] = useState(false);
    const [reviewed, setReviewed] = useState(false);
    const [confirmation, setConfirmation] = useState('');
    const [error, setError] = useState('');
    const prepareController = useRef<AbortController | null>(null);
    const deleting = useRef(false);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; prepareController.current?.abort(); };
    }, []);

    useEffect(() => {
        if (phase !== 'select' || mode !== 'range') { setLoading(false); return; }
        const controller = new AbortController();
        setLoading(true);
        const timer = setTimeout(() => {
            void loadRangeMessagePage(character.id, { ...cursor, query, includeEmpty: true, signal: controller.signal })
                .then(page => {
                    if (controller.signal.aborted) return;
                    setRows(page.messages);
                    setHasOlder(cursor.afterId !== undefined || page.hasMore);
                    setHasNewer(cursor.beforeId !== undefined || (cursor.afterId !== undefined && page.hasMore));
                }).catch(reason => {
                    if (controller.signal.aborted) return;
                    setRows([]); setHasOlder(false); setHasNewer(false);
                    setError(`读取失败：${reason?.message || reason}`);
                }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        }, query ? 250 : 0);
        return () => { clearTimeout(timer); controller.abort(); };
    }, [character.id, cursor, query, phase, mode]);

    const close = () => { if (!deleting.current) { prepareController.current?.abort(); onClose(); } };
    const backToSelection = () => {
        setPhase('select'); setPlan(null); setReviewed(false); setConfirmation('');
    };
    const selectEdge = async (edge: 'start' | 'end') => {
        setLoading(true); setError('');
        try {
            const page = await loadRangeMessagePage(character.id, { ...(edge === 'start' ? { afterId: 0 } : {}), limit: 1, includeEmpty: true });
            if (mounted.current) {
                if (!page.messages.length) setError('这个角色还没有聊天记录');
                else (edge === 'start' ? setStart : setEnd)(page.messages[0]);
            }
        } catch (reason: any) { if (mounted.current) setError(reason?.message || '读取失败'); }
        finally { if (mounted.current) setLoading(false); }
    };
    const preview = async () => {
        if (preparing || deleting.current) return;
        const controller = new AbortController();
        prepareController.current?.abort(); prepareController.current = controller;
        setPreparing(true); setError(''); setReviewed(false); setConfirmation(''); setPlan(null);
        try {
            const selection = mode === 'keep' ? { keepRecent: Number(keep) } : { fromId: start!.id, toId: end!.id };
            const result = await prepareChatHistoryCleanup(character.id, selection, controller.signal);
            if (controller.signal.aborted || !mounted.current) return;
            if (!result.ids.length) { setError('没有需要清理的记录；当前记录会全部保留。'); return; }
            setPlan(result); setPhase('review');
        } catch (reason: any) { if (!controller.signal.aborted && mounted.current) setError(reason?.message || '无法读取选区'); }
        finally { if (!controller.signal.aborted && mounted.current) setPreparing(false); }
    };
    const remove = async () => {
        if (!plan || !reviewed || confirmation !== CHAT_CLEANUP_CONFIRMATION || deleting.current) return;
        deleting.current = true; setPhase('deleting'); setError('');
        try {
            await deleteChatHistoryCleanup(plan, { reviewed, text: confirmation });
        } catch (reason: any) {
            if (mounted.current) { backToSelection(); setError(reason?.message || '删除未完成，记录已保留'); }
            deleting.current = false;
            return;
        }
        // 删除已落盘；刷新失败不得把它显示成“删除失败”并诱导重复执行。
        try { await onDeleted(plan); } catch (reason) { console.error('[ChatHistoryCleanup] refresh failed', reason); }
        deleting.current = false;
        if (mounted.current) setPhase('done');
    };

    const summary = plan && <div className='rounded-2xl border border-red-200 bg-red-50 p-4 space-y-2 text-xs text-red-900'>
        <p className='font-bold text-sm'>角色：{character.name} · 永久删除 {plan.ids.length.toLocaleString()} 条</p>
        <p>起点：{formatRangeTimestamp(plan.firstTimestamp)} · #{plan.ids[0]}</p>
        <p>终点：{formatRangeTimestamp(plan.lastTimestamp)} · #{plan.ids.at(-1)}</p>
        <p>包含起点、终点及中间全部记录。搜索只用于定位，删除不限于搜索匹配项。</p>
        {plan.afterWaterlineCount > 0 && <p className='font-bold'>其中 {plan.afterWaterlineCount.toLocaleString()} 条位于记忆水位线之后，可能尚未整理成记忆。</p>}
    </div>;
    const cancelButton = <button type='button' onClick={backToSelection} className='flex-1 rounded-2xl bg-slate-100 p-3 text-sm font-bold text-slate-600'>取消，返回选择</button>;

    return <>
        <Modal isOpen={phase === 'select'} title='清理指定范围的聊天记录' onClose={close} footer={<>
            <button type='button' onClick={close} className='rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-600'>取消</button>
            <button type='button' disabled={preparing || loading || (mode === 'range' ? !start || !end : !Number.isSafeInteger(Number(keep)) || Number(keep) < 1)} onClick={() => void preview()} className='flex-1 rounded-2xl bg-red-50 px-3 py-3 text-sm font-bold text-red-700 disabled:opacity-40'>{preparing ? '正在统计选区…' : '预览清理范围'}</button>
        </>}>
            <div className='space-y-4 text-xs text-slate-600'>
                <p><b>{character.name}</b> 的聊天、见面、通话及剧情陪伴记录。清理会永久删除原文和对应聊天语音缓存；已存入的记忆、收藏及剧情正文保留。</p>
                <div className='flex rounded-xl bg-slate-100 p-1 gap-1'>
                    <button type='button' disabled={preparing} onClick={() => { setMode('range'); setError(''); }} className={`flex-1 rounded-lg p-2 font-bold ${mode === 'range' ? 'bg-white text-slate-800' : ''}`}>指定起止区间</button>
                    <button type='button' disabled={preparing} onClick={() => { setMode('keep'); setError(''); }} className={`flex-1 rounded-lg p-2 font-bold ${mode === 'keep' ? 'bg-white text-slate-800' : ''}`}>保留最近 N 条</button>
                </div>
                {mode === 'keep' ? <label className='block space-y-2'>保留最近多少条记录
                    <input aria-label='保留最近多少条记录' type='number' min='1' step='1' value={keep} disabled={preparing} onChange={event => setKeep(event.target.value)} className='block w-full rounded-xl border border-slate-200 bg-white p-3 text-base' />
                    <span className='block text-slate-500'>仅清理更早的记录。预览后新产生的消息也会保留。</span>
                </label> : <>
                    <div className='rounded-xl border border-slate-200 p-3 space-y-2'>
                        <p>起点：{start ? `${formatRangeTimestamp(start.timestamp)} · #${start.id}` : '未选择'}</p>
                        <p>终点：{end ? `${formatRangeTimestamp(end.timestamp)} · #${end.id}` : '未选择'}</p>
                        <div className='flex flex-wrap gap-3 text-violet-700'>
                            <button type='button' disabled={preparing || loading} onClick={() => void selectEdge('start')}>从最早一条开始</button>
                            <button type='button' disabled={preparing || loading} onClick={() => void selectEdge('end')}>选到最新一条</button>
                            <button type='button' disabled={preparing} onClick={() => { setStart(null); setEnd(null); }}>重选</button>
                        </div>
                    </div>
                    <input aria-label='搜索聊天内容或日期' placeholder='搜索内容或日期，如 生日 / 2026-03' value={query} disabled={preparing} onChange={event => { setQuery(event.target.value); setCursor({}); }} className='w-full rounded-xl border border-slate-200 p-3' />
                    <p className='text-slate-500'>起止之间的全部记录都会选中，搜索仅用于定位。</p>
                    <div className='flex items-center justify-between gap-2'>
                        <button type='button' disabled={preparing || loading || !hasOlder || !rows.length} onClick={() => setCursor({ beforeId: rows[0].id })} className='rounded-lg border px-3 py-2 disabled:opacity-30'>更早</button>
                        <span>{loading ? '读取中…' : `本页 ${rows.length} 条`}</span>
                        <button type='button' disabled={preparing || loading || !hasNewer || !rows.length} onClick={() => setCursor({ afterId: rows.at(-1)!.id })} className='rounded-lg border px-3 py-2 disabled:opacity-30'>更新</button>
                    </div>
                    {!loading && rows.map(message => <div key={message.id} className={`rounded-xl border p-3 space-y-2 ${start && end && message.id >= Math.min(start.id, end.id) && message.id <= Math.max(start.id, end.id) ? 'border-red-200 bg-red-50' : 'border-slate-200'}`}>
                        <div className='text-[10px] text-slate-400'>{message.role === 'user' ? '你' : message.role === 'assistant' ? character.name : '系统'} · {sourceLabel(message)} · {formatRangeTimestamp(message.timestamp)} · #{message.id}</div>
                        {message.type === 'secret_note' ? <SecretNote text={message.content}/> : <p className='whitespace-pre-wrap break-normal [overflow-wrap:anywhere] leading-relaxed'>{message.content}</p>}
                        <div className='flex gap-4 text-violet-700'>
                            <button type='button' disabled={preparing} onClick={() => setStart(message)}>{start?.id === message.id ? '已设为起点' : '设为起点'}</button>
                            <button type='button' disabled={preparing} onClick={() => setEnd(message)}>{end?.id === message.id ? '已设为终点' : '设为终点'}</button>
                        </div>
                    </div>)}
                    {!loading && !rows.length && <p className='text-center py-4'>{query ? '没有匹配的记录' : '没有聊天记录'}</p>}
                </>}
                {error && <p role='alert' className='rounded-xl bg-red-50 p-3 text-red-700'>{error}</p>}
            </div>
        </Modal>

        <Modal isOpen={phase === 'review'} title='第一次确认：检查删除范围' onClose={backToSelection} footer={<>
            {cancelButton}<button type='button' onClick={() => { setReviewed(true); setConfirmation(''); setPhase('confirm'); }} className='flex-1 rounded-2xl bg-red-100 p-3 text-sm font-bold text-red-700'>继续第二次确认</button>
        </>}>
            <div className='space-y-4'>{summary}<p className='text-sm font-bold text-red-700'>这是永久删除，无法撤销。请先确认已备份需要保留的内容。</p><p className='text-xs text-slate-500'>此步不会删除任何记录，下一步还需输入指定文字。</p></div>
        </Modal>

        <Modal isOpen={phase === 'confirm' || phase === 'deleting'} title='第二次确认：永久删除' onClose={() => { if (!deleting.current) backToSelection(); }} footer={<>
            {!deleting.current && cancelButton}<button type='button' disabled={phase === 'deleting' || !reviewed || confirmation !== CHAT_CLEANUP_CONFIRMATION} onClick={() => void remove()} className='flex-1 rounded-2xl bg-red-600 p-3 text-sm font-bold text-white disabled:bg-slate-200 disabled:text-slate-400'>{phase === 'deleting' ? '正在永久删除…' : `永久删除 ${plan?.ids.length.toLocaleString() || 0} 条`}</button>
        </>}>
            <div className='space-y-4'>{summary}<p className='text-sm font-bold text-red-700'>删除后无法恢复。请完整输入以下文字：</p><p className='select-text rounded-xl bg-slate-100 p-3 text-sm font-bold text-slate-800'>{CHAT_CLEANUP_CONFIRMATION}</p><input aria-label='永久删除确认文字' autoComplete='off' value={confirmation} disabled={phase === 'deleting'} onChange={event => setConfirmation(event.target.value)} placeholder='在这里输入确认文字' className='w-full rounded-xl border border-red-200 p-3 text-sm' /></div>
        </Modal>

        <Modal isOpen={phase === 'done'} title='清理完成' onClose={close}><p className='text-sm text-slate-700'>已永久删除 {plan?.ids.length.toLocaleString()} 条选中记录，其余记录保留。</p></Modal>
    </>;
}
