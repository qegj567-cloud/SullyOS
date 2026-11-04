import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CaretLeft, CaretRight, Database, DotsThree, PencilSimple, SpinnerGap, Trash, X } from '@phosphor-icons/react';
import type { StoryTheaterEntry } from '../../../types';
import type { MemoryNode } from '../../../utils/memoryPalace/types';
import { useOS } from '../../../context/OSContext';
import { deleteStoryVectorMemory, listStoryVectorMemories, updateStoryVectorMemory } from '../../../utils/storyTheaterVectorMemory';
import { StoryAppearanceButton } from './StoryTheaterTheme';

interface Props {
    entry: StoryTheaterEntry;
    onBack: () => void;
}

const PAGE_SIZE = 10;

const StoryVectorMemoryPanel: React.FC<Props> = ({ entry, onBack }) => {
    const { memoryPalaceConfig, remoteVectorConfig, addToast } = useOS();
    const [nodes, setNodes] = useState<MemoryNode[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [page, setPage] = useState(0);
    const [menuNode, setMenuNode] = useState<MemoryNode | null>(null);
    const [editing, setEditing] = useState<MemoryNode | null>(null);
    const [deleting, setDeleting] = useState<MemoryNode | null>(null);
    const [draft, setDraft] = useState('');
    const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const addToastRef = useRef(addToast);

    useEffect(() => { addToastRef.current = addToast; }, [addToast]);
    useEffect(() => {
        let active = true;
        setLoading(true);
        void listStoryVectorMemories(entry.id).then(rows => {
            if (active) setNodes(rows);
        }).catch((error: any) => {
            if (active) addToastRef.current(error?.message || '读取剧情向量记忆失败', 'error');
        }).finally(() => {
            if (active) setLoading(false);
        });
        return () => { active = false; };
    }, [entry.id]);
    useEffect(() => {
        const maxPage = Math.max(0, Math.ceil(nodes.length / PAGE_SIZE) - 1);
        if (page > maxPage) setPage(maxPage);
    }, [nodes.length, page]);
    useEffect(() => () => {
        if (pressTimer.current) clearTimeout(pressTimer.current);
    }, []);

    const pageCount = Math.max(1, Math.ceil(nodes.length / PAGE_SIZE));
    const visibleNodes = useMemo(() => nodes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [nodes, page]);

    const cancelLongPress = () => {
        if (pressTimer.current) clearTimeout(pressTimer.current);
        pressTimer.current = null;
    };

    const beginLongPress = (node: MemoryNode) => {
        cancelLongPress();
        pressTimer.current = setTimeout(() => {
            setMenuNode(node);
            pressTimer.current = null;
            if ('vibrate' in navigator) navigator.vibrate?.(12);
        }, 520);
    };

    const openEdit = (node: MemoryNode) => {
        setMenuNode(null);
        setEditing(node);
        setDraft(node.content);
    };

    const saveEdit = async () => {
        if (!editing || !draft.trim() || saving) return;
        setSaving(true);
        try {
            const updated = await updateStoryVectorMemory(entry.id, editing.id, draft, memoryPalaceConfig.embedding, remoteVectorConfig);
            setNodes(current => current.map(node => node.id === updated.id ? updated : node));
            setEditing(null);
            addToast('剧情记忆与向量已同步更新', 'success');
        } catch (error: any) {
            addToast(error?.message || '剧情记忆修改失败', 'error');
        } finally {
            setSaving(false);
        }
    };

    const confirmDelete = async () => {
        if (!deleting || saving) return;
        setSaving(true);
        try {
            const result = await deleteStoryVectorMemory(entry.id, deleting.id, remoteVectorConfig);
            setNodes(current => current.filter(node => node.id !== deleting.id));
            setDeleting(null);
            addToast(result.remoteDeleted === false ? '本地已删除；远端暂未同步，请检查网络' : '已从本剧情向量分区删除', result.remoteDeleted === false ? 'info' : 'success');
        } catch (error: any) {
            addToast(error?.message || '剧情记忆删除失败', 'error');
        } finally {
            setSaving(false);
        }
    };

    return <div className='h-full w-full flex flex-col bg-stone-100 text-slate-800'>
        <header className='story-safe-header shrink-0 border-b border-slate-200 bg-stone-100/95 backdrop-blur z-10'>
            <div className='h-16 px-4 flex items-center gap-3'>
                <button onClick={onBack} className='w-9 h-9 rounded-full grid place-items-center'><ArrowLeft size={20} /></button>
                <div className='min-w-0 flex-1'><div className='text-[9px] uppercase tracking-[.22em] font-bold text-violet-500'>Vector archive</div><h1 className='font-semibold truncate'>{entry.title}</h1></div>
                <StoryAppearanceButton className='bg-white border border-slate-200' />
            </div>
        </header>

        <main className='story-page-scroll flex-1 overflow-y-auto px-5 py-6 pb-24'>
            <div className='max-w-2xl mx-auto'>
                <section className='story-cinema-rule pb-6 border-b border-slate-200'>
                    <Database size={34} weight='duotone' className='text-violet-500' />
                    <h2 className='mt-4 text-2xl font-serif font-semibold'>本剧情的向量记忆</h2>
                    <p className='mt-2 text-[11px] leading-5 text-slate-500'>这里只有「{entry.title}」的独立分区，共 {nodes.length} 条。长按任意一条可以编辑或删除；操作不会进入角色记忆，也不会触碰其它剧情。</p>
                </section>

                {loading ? <div className='py-20 grid place-items-center text-slate-400'><SpinnerGap size={24} className='animate-spin' /></div> : nodes.length === 0 ? <div className='py-16 text-center'><div className='text-sm font-semibold'>还没有向量归档</div><p className='mt-2 text-[10px] leading-5 text-slate-500'>推进达到归档条数后，旧正文会被提炼并写入这里。</p></div> : <>
                    <div className='divide-y divide-slate-200'>{visibleNodes.map((node, index) => <article
                        key={node.id}
                        onPointerDown={() => beginLongPress(node)}
                        onPointerUp={cancelLongPress}
                        onPointerCancel={cancelLongPress}
                        onPointerLeave={cancelLongPress}
                        onContextMenu={event => { event.preventDefault(); cancelLongPress(); setMenuNode(node); }}
                        className='select-none py-5 flex items-start gap-4'
                    >
                        <div className='shrink-0 pt-0.5 text-[10px] font-serif text-violet-500'>{String(page * PAGE_SIZE + index + 1).padStart(2, '0')}</div>
                        <div className='min-w-0 flex-1'><p className='whitespace-pre-wrap text-[12px] leading-6'>{node.content}</p><div className='mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-slate-400'><span>{new Date(node.createdAt).toLocaleString()}</span><span>重要度 {node.importance}/10</span><span>{node.embedded ? '向量已就绪' : '等待向量化'}</span>{node.tags?.slice(0, 3).map(tag => <span key={tag}>#{tag}</span>)}</div></div>
                        <button onClick={() => setMenuNode(node)} onPointerDown={event => event.stopPropagation()} className='w-9 h-9 shrink-0 rounded-full grid place-items-center text-slate-400' aria-label='记忆操作'><DotsThree size={18} weight='bold' /></button>
                    </article>)}</div>
                    {pageCount > 1 && <nav className='pt-6 border-t border-slate-200 flex items-center justify-between'><button disabled={page === 0} onClick={() => setPage(current => Math.max(0, current - 1))} className='w-10 h-10 rounded-full bg-white border border-slate-200 grid place-items-center disabled:opacity-25'><CaretLeft size={15} /></button><span className='text-[10px] text-slate-500'>第 {page + 1} / {pageCount} 页</span><button disabled={page + 1 >= pageCount} onClick={() => setPage(current => Math.min(pageCount - 1, current + 1))} className='w-10 h-10 rounded-full bg-white border border-slate-200 grid place-items-center disabled:opacity-25'><CaretRight size={15} /></button></nav>}
                </>}
            </div>
        </main>

        {menuNode && <div className='fixed inset-0 z-[80] bg-slate-950/35 flex items-end justify-center' onClick={() => setMenuNode(null)}><div className='story-safe-sheet w-full sm:max-w-sm rounded-t-[28px] bg-stone-100 px-5 pt-5 shadow-2xl' onClick={event => event.stopPropagation()}><div className='flex items-center justify-between'><div><div className='text-[9px] uppercase tracking-[.2em] text-violet-500 font-bold'>剧情记忆</div><h3 className='mt-1 font-semibold'>这条剧情记忆</h3></div><button onClick={() => setMenuNode(null)} className='w-9 h-9 rounded-full bg-white border border-slate-200 grid place-items-center'><X size={15} /></button></div><div className='mt-5 border-t border-slate-200'><button onClick={() => openEdit(menuNode)} className='w-full py-4 flex items-center gap-3 text-sm font-semibold'><PencilSimple size={18} className='text-violet-500' />编辑记忆内容</button><button onClick={() => { setDeleting(menuNode); setMenuNode(null); }} className='w-full py-4 border-t border-slate-200 flex items-center gap-3 text-sm font-semibold text-rose-600'><Trash size={18} />删除这条记忆</button></div></div></div>}

        {editing && <div className='fixed inset-0 z-[80] bg-slate-950/35 flex items-end justify-center' onClick={() => !saving && setEditing(null)}><div className='story-safe-sheet story-keyboard-sheet w-full sm:max-w-lg rounded-t-[28px] bg-stone-100 px-5 pt-5 shadow-2xl' onClick={event => event.stopPropagation()}><div className='flex items-start justify-between gap-3'><div><div className='text-[9px] uppercase tracking-[.2em] text-violet-500 font-bold'>直接修改</div><h3 className='mt-1 font-semibold'>编辑剧情记忆</h3><p className='mt-1 text-[10px] text-slate-500'>修改后会直接更新原记忆，不会产生重复记录。</p></div><button disabled={saving} onClick={() => setEditing(null)} className='w-9 h-9 rounded-full bg-white border border-slate-200 grid place-items-center'><X size={15} /></button></div><textarea autoFocus value={draft} onChange={event => setDraft(event.target.value)} className='mt-5 w-full min-h-40 resize-none rounded-2xl border border-slate-200 bg-white p-4 text-sm leading-6 outline-none focus:border-violet-400' /><button disabled={saving || !draft.trim()} onClick={() => void saveEdit()} className='mt-4 w-full h-12 rounded-2xl bg-slate-900 text-white font-semibold disabled:opacity-40'>{saving ? <SpinnerGap size={18} className='mx-auto animate-spin' /> : '保存修改'}</button></div></div>}

        {deleting && <div className='fixed inset-0 z-[80] bg-slate-950/35 flex items-end justify-center' onClick={() => !saving && setDeleting(null)}><div className='story-safe-sheet w-full sm:max-w-sm rounded-t-[28px] bg-stone-100 px-5 pt-5 shadow-2xl' onClick={event => event.stopPropagation()}><div className='text-[9px] uppercase tracking-[.2em] text-rose-500 font-bold'>删除确认</div><h3 className='mt-1 text-lg font-semibold'>删除后无法恢复</h3><p className='mt-2 text-[11px] leading-5 text-slate-500'>只会删除当前剧情里的这一条记忆，不影响其它剧本和日常聊天。</p><div className='mt-5 grid grid-cols-2 gap-3'><button disabled={saving} onClick={() => setDeleting(null)} className='h-11 rounded-2xl bg-white border border-slate-200 text-xs font-bold'>取消</button><button disabled={saving} onClick={() => void confirmDelete()} className='h-11 rounded-2xl bg-rose-600 text-white text-xs font-bold'>{saving ? '删除中…' : '确认删除'}</button></div></div></div>}
    </div>;
};

export default StoryVectorMemoryPanel;
