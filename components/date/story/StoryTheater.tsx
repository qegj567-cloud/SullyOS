import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readShareFile } from '../../../utils/pngShare';
import { Archive, ArrowLeft, Database, DownloadSimple, FilmSlate, Plus, SpinnerGap, Trash, UploadSimple, UsersThree, X } from '@phosphor-icons/react';
import { useOS } from '../../../context/OSContext';
import TokenImg from '../../os/TokenImg';
import type { StoryTheaterEntry, StoryTheaterMask, StoryTheaterMaskSelection, StoryTheaterPreset } from '../../../types';
import { DB } from '../../../utils/db';
import {
    BUILTIN_NIGHT_SCREENING_PRESET,
    createBlankStoryPreset,
    createStoryTheaterDraft,
    downloadStoryPreset,
    normalizeStoryTheater,
    parseStoryTheaterPreset,
    dedupeTheaterWorldbooks,
    resolveStoryTheaterMask,
    storyTheaterThreadId,
    withBuiltInStoryPresets,
} from '../../../utils/storyTheater';
import StoryMaskBox from './StoryMaskBox';
import StoryPresetMaker from './StoryPresetMaker';
import StoryTheaterEditor from './StoryTheaterEditor';
import StoryTheaterSession from './StoryTheaterSession';
import StoryVectorMemoryPanel from './StoryVectorMemoryPanel';
import StoryArchivePanel from './StoryArchivePanel';
import { StoryAppearanceButton, StoryTheaterThemeProvider } from './StoryTheaterTheme';
import { deleteStoryTheaterData } from '../../../utils/storyTheaterDeletion';

interface Props {
    onSwitchCompanion: () => void;
    onClose: () => void;
}

type View = 'list' | 'editor' | 'session' | 'preset' | 'masks' | 'vectors' | 'archives';

const StoryTheaterContent: React.FC<Props> = ({ onSwitchCompanion, onClose }) => {
    const { characters, userProfile, addToast, remoteVectorConfig } = useOS();
    const [view, setView] = useState<View>('list');
    const [entries, setEntries] = useState<StoryTheaterEntry[]>([]);
    const [customPresets, setCustomPresets] = useState<StoryTheaterPreset[]>([]);
    const [masks, setMasks] = useState<StoryTheaterMask[]>([]);
    const [activeEntry, setActiveEntry] = useState<StoryTheaterEntry | null>(null);
    const [editingPreset, setEditingPreset] = useState<StoryTheaterPreset | null>(null);
    const [maskLocked, setMaskLocked] = useState(false);
    const [deletingEntry, setDeletingEntry] = useState<StoryTheaterEntry | null>(null);
    const [deletingStory, setDeletingStory] = useState(false);
    const importInput = useRef<HTMLInputElement>(null);
    const presets = useMemo(() => withBuiltInStoryPresets(customPresets), [customPresets]);

    const reload = useCallback(async () => {
        const [storedEntries, storedPresets, storedMasks] = await Promise.all([DB.getStoryTheaters(), DB.getStoryTheaterPresets(), DB.getStoryTheaterMasks()]);
        setEntries(storedEntries.map(normalizeStoryTheater).sort((a, b) => b.updatedAt - a.updatedAt));
        setCustomPresets(storedPresets.filter(preset => !preset.builtIn).sort((a, b) => b.updatedAt - a.updatedAt));
        setMasks(storedMasks.sort((a, b) => b.updatedAt - a.updatedAt));
    }, []);

    useEffect(() => { void reload(); }, [reload]);

    const importPreset = useCallback(async (file: File): Promise<StoryTheaterPreset | null> => {
        try {
            const source = await readShareFile(file, 'story');
            const imported = parseStoryTheaterPreset(await source.text(), source.name);
            await DB.saveStoryTheaterPreset(imported);
            setCustomPresets(current => [imported, ...current.filter(item => item.id !== imported.id)]);
            addToast(`已导入糯米机剧情预设「${imported.name}」`, 'success');
            return imported;
        } catch (error: any) {
            addToast(error?.message || '预设导入失败', 'error');
            return null;
        }
    }, [addToast]);

    const saveEntry = useCallback(async (next: StoryTheaterEntry) => {
        const normalized = normalizeStoryTheater(next);
        await DB.saveStoryTheater(normalized);
        setEntries(current => [normalized, ...current.filter(item => item.id !== normalized.id)].sort((a, b) => b.updatedAt - a.updatedAt));
        setActiveEntry(normalized);
        setView('session');
    }, []);

    const persistEntryInSession = useCallback(async (next: StoryTheaterEntry) => {
        const normalized = normalizeStoryTheater(next);
        await DB.saveStoryTheater(normalized);
        setActiveEntry(normalized);
        setEntries(current => [normalized, ...current.filter(item => item.id !== normalized.id)].sort((a, b) => b.updatedAt - a.updatedAt));
    }, []);

    const savePreset = useCallback(async (next: StoryTheaterPreset) => {
        if (next.builtIn) return;
        await DB.saveStoryTheaterPreset(next);
        setCustomPresets(current => [next, ...current.filter(item => item.id !== next.id)]);
        setEditingPreset(next);
        addToast('剧情预设已保存', 'success');
    }, [addToast]);

    const copyPreset = useCallback(async (copy: StoryTheaterPreset) => {
        await DB.saveStoryTheaterPreset(copy);
        setCustomPresets(current => [copy, ...current.filter(item => item.id !== copy.id)]);
        setEditingPreset(copy);
        addToast('已复制为可编辑的糯米机预设', 'success');
    }, [addToast]);

    const deletePreset = useCallback(async (preset: StoryTheaterPreset) => {
        await DB.deleteStoryTheaterPreset(preset.id);
        setCustomPresets(current => current.filter(item => item.id !== preset.id));
        setEditingPreset(null);
        setView(activeEntry ? 'editor' : 'list');
        addToast('预设已删除；使用它的剧情会回退到内置预设', 'info');
    }, [activeEntry, addToast]);

    const saveMask = useCallback(async (mask: StoryTheaterMask) => {
        const next = { ...mask, name: mask.name.trim(), updatedAt: Date.now() };
        await DB.saveStoryTheaterMask(next);
        setMasks(current => [next, ...current.filter(item => item.id !== next.id)]);
        addToast('原创身份已放进面具箱', 'success');
    }, [addToast]);

    const deleteMask = useCallback(async (mask: StoryTheaterMask) => {
        await DB.deleteStoryTheaterMask(mask.id);
        setMasks(current => current.filter(item => item.id !== mask.id));
        if (activeEntry?.mask?.type === 'custom' && activeEntry.mask.id === mask.id) {
            setActiveEntry({ ...activeEntry, mask: { type: 'user' }, updatedAt: Date.now() });
        }
        addToast('原创身份已移出面具箱', 'info');
    }, [activeEntry, addToast]);

    const confirmDeleteEntry = useCallback(async () => {
        if (!deletingEntry || deletingStory) return;
        setDeletingStory(true);
        try {
            const result = await deleteStoryTheaterData(deletingEntry, remoteVectorConfig);
            setEntries(current => current.filter(item => item.id !== deletingEntry.id));
            if (activeEntry?.id === deletingEntry.id) setActiveEntry(null);
            setDeletingEntry(null);
            setView('list');
            addToast(
                result.remoteVectorDeleteFailures > 0
                    ? `剧情已删除；${result.remoteVectorDeleteFailures} 条远端向量暂未同步，请检查网络`
                    : `整个剧情「${deletingEntry.title}」已删除`,
                result.remoteVectorDeleteFailures > 0 ? 'info' : 'success',
            );
        } catch (error: any) {
            addToast(error?.message || '删除整个剧情失败', 'error');
        } finally {
            setDeletingStory(false);
        }
    }, [activeEntry?.id, addToast, deletingEntry, deletingStory, remoteVectorConfig]);

    const selectMask = useCallback((selection: StoryTheaterMaskSelection) => {
        if (maskLocked) return;
        setActiveEntry(current => {
            if (!current || current.writesToCharacterMemory) return current;
            const characterIds = selection.type === 'character'
                ? current.characterIds.filter(id => id !== selection.id)
                : current.characterIds;
            const remainingActors = characters.filter(char => characterIds.includes(char.id));
            const validBookIds = new Set(dedupeTheaterWorldbooks(remainingActors).map(book => book.id));
            const characterContextLimits = { ...current.characterContextLimits };
            if (selection.type === 'character') {
                if (characterContextLimits[selection.id] === undefined) characterContextLimits[selection.id] = 100;
            }
            return {
                ...current,
                mask: selection,
                characterIds,
                selectedWorldbookIds: current.selectedWorldbookIds.filter(id => validBookIds.has(id)),
                characterContextLimits,
                updatedAt: Date.now(),
            };
        });
    }, [characters, maskLocked]);

    const openEntryEditor = useCallback(async (entry: StoryTheaterEntry) => {
        const rows = await DB.getMessagesByCharId(storyTheaterThreadId(entry.id), true);
        setMaskLocked(rows.some(message => message.metadata?.source === 'story_theater'));
        setView('editor');
    }, []);

    if (view === 'preset' && editingPreset) return <StoryPresetMaker key={editingPreset.id}
        preset={editingPreset}
        onBack={() => setView(activeEntry ? 'editor' : 'list')}
        onSave={savePreset}
        onOpenCopy={copyPreset}
        onDelete={editingPreset.builtIn ? undefined : deletePreset}
    />;

    if (view === 'masks' && activeEntry) return <StoryMaskBox
        user={userProfile}
        characters={characters}
        masks={masks}
        selected={activeEntry.mask || { type: 'user' }}
        onSelect={selectMask}
        onSave={saveMask}
        onDelete={deleteMask}
        onBack={() => setView('editor')}
        locked={maskLocked}
    />;

    if (view === 'editor' && activeEntry) return <StoryTheaterEditor key={`${activeEntry.id}:${activeEntry.updatedAt}`}
        initial={activeEntry}
        characters={characters}
        user={userProfile}
        masks={masks}
        maskLocked={maskLocked}
        presets={presets}
        onCancel={() => setView(entries.some(item => item.id === activeEntry.id) ? 'session' : 'list')}
        onSave={saveEntry}
        onImportPreset={importPreset}
        onEditPreset={(preset, draft) => { setActiveEntry(draft); setEditingPreset(preset); setView('preset'); }}
        onOpenMaskBox={draft => { if (maskLocked || draft.writesToCharacterMemory) return; setActiveEntry(draft); setView('masks'); }}
    />;

    if (view === 'vectors' && activeEntry) return <StoryVectorMemoryPanel entry={activeEntry} onBack={() => setView('session')} />;
    if (view === 'archives' && activeEntry) return <StoryArchivePanel entry={activeEntry} masks={masks} onBack={() => setView('session')} onUpdated={next => {setActiveEntry(next);setEntries(current => current.map(item => item.id === next.id ? next : item));}} />;

    if (view === 'session' && activeEntry) {
        const preset = presets.find(item => item.id === activeEntry.presetId) || BUILTIN_NIGHT_SCREENING_PRESET;
        const hasVectorArchive = (!activeEntry.writesToCharacterMemory && activeEntry.archiveStrategy === 'vector') || activeEntry.archives.some(archive => archive.strategy === 'vector');
        return <StoryTheaterSession entry={activeEntry} preset={preset} masks={masks} onBack={() => { setActiveEntry(null); setView('list'); }} onEdit={() => void openEntryEditor(activeEntry)} onOpenArchives={() => setView('archives')} onOpenVectorMemory={hasVectorArchive ? () => setView('vectors') : undefined} onEntryChange={persistEntryInSession} />;
    }

    return <div className='h-full w-full flex flex-col bg-stone-100 text-slate-800'>
        <header className='story-safe-header shrink-0 border-b border-slate-200'>
            <div className='h-16 px-4 flex items-center gap-3'>
                <button onClick={onClose} className='w-9 h-9 rounded-full grid place-items-center'><ArrowLeft size={20} /></button>
                <div><div className='text-[9px] uppercase tracking-[.24em] font-bold text-violet-500'>Meet</div><h1 className='font-semibold'>见面</h1></div>
                <StoryAppearanceButton className='ml-auto bg-white border border-slate-200' />
                <button onClick={() => { setMaskLocked(false); setActiveEntry({ ...createStoryTheaterDraft(), presetId: presets[0]?.id }); setView('editor'); }} className='w-10 h-10 rounded-full bg-slate-900 text-white grid place-items-center'><Plus size={19} /></button>
            </div>
            <div className='mx-5 mb-4 grid grid-cols-2 p-1 rounded-xl bg-slate-200'>
                <button onClick={onSwitchCompanion} className='py-2 rounded-lg text-xs font-bold text-slate-500'>陪伴</button>
                <button className='py-2 rounded-lg bg-white shadow-sm text-xs font-bold text-violet-700'>剧情</button>
            </div>
        </header>

        <main className='story-page-scroll flex-1 overflow-y-auto px-5 py-6 pb-24'>
            <div className='max-w-2xl mx-auto'>
                <section className='story-cinema-rule pb-6 border-b border-slate-200'>
                    <div className='text-[9px] tracking-[.24em] uppercase font-bold text-violet-500'>Your theaters</div>
                    <div className='mt-2 flex items-end justify-between gap-5'><div><h2 className='text-3xl font-serif font-semibold'>很多条剧情，<br />各自拥有一条时间线。</h2><p className='mt-3 text-[11px] leading-5 text-slate-500'>角色在新增时一次选定。世界书、记忆与预设的改动都只发生在这只沙盒里。</p></div><FilmSlate size={48} weight='duotone' className='shrink-0 text-violet-300' /></div>
                </section>

                <section className='py-6'>
                    {entries.length === 0 ? <button onClick={() => { setMaskLocked(false); setActiveEntry({ ...createStoryTheaterDraft(), presetId: presets[0]?.id }); setView('editor'); }} className='w-full py-14 rounded-3xl border border-dashed border-slate-300 text-center'><span className='block text-sm font-semibold'>新增第一条剧情</span><span className='block mt-2 text-[10px] text-slate-400'>选择多位角色、记忆方式、世界书与原生预设</span></button> : <div className='divide-y divide-slate-200'>{entries.map(item => {
                        const cast = characters.filter(char => item.characterIds.includes(char.id));
                        const mask = resolveStoryTheaterMask(item.mask, userProfile, characters, masks);
                        const youLabel = mask.selection.type === 'user' ? '你' : `你（${mask.name}）`;
                        const vectorEnabled = item.archiveStrategy === 'vector' && !item.writesToCharacterMemory;
                        const hasVectorArchive = vectorEnabled || item.archives.some(archive => archive.strategy === 'vector');
                        return <div key={item.id} className='w-full py-5 flex items-center gap-2'>
                            <button onClick={() => { setActiveEntry(item); setView('session'); }} className='min-w-0 flex-1 flex items-center gap-4 text-left'>
                                <div className='flex -space-x-2'>{mask.avatar ? <TokenImg value={mask.avatar} alt='' className='w-10 h-10 rounded-full object-cover border-2 border-slate-800 relative z-10' /> : <span className='w-10 h-10 rounded-full bg-slate-800 text-white grid place-items-center border-2 border-slate-800 relative z-10 text-xs font-serif'>{mask.name.slice(0, 1)}</span>}{cast.slice(0, 2).map(char => <TokenImg key={char.id} value={char.avatar} alt='' className='w-10 h-10 rounded-full object-cover border-2 border-stone-100' />)}{cast.length === 0 && <span className='w-10 h-10 rounded-full bg-slate-200 grid place-items-center'><UsersThree size={18} /></span>}</div>
                                <div className='min-w-0 flex-1'><h3 className='font-serif font-semibold truncate'>{item.title}</h3><p className='mt-1 text-[10px] text-slate-400 truncate'>{youLabel} · 角色：{cast.map(char => char.name).join('、') || '暂无'} · {item.writesToCharacterMemory ? '进入角色记忆' : vectorEnabled ? '独立向量剧场' : '独立事件盒'}</p></div>
                                <time className='text-[9px] text-slate-400'>{new Date(item.updatedAt).toLocaleDateString()}</time>
                            </button>
                            {item.archives.some(archive => archive.strategy === 'summary') && <button onClick={() => { setActiveEntry(item); setView('archives'); }} className='w-10 h-10 shrink-0 rounded-full bg-white border border-slate-200 grid place-items-center text-violet-600' title='查看本剧情事件盒' aria-label='查看本剧情事件盒'><Archive size={17} /></button>}
                            {hasVectorArchive && <button onClick={() => { setActiveEntry(item); setView('vectors'); }} className='w-10 h-10 shrink-0 rounded-full bg-white border border-slate-200 grid place-items-center text-violet-600' title='查看本剧情向量记忆' aria-label='查看本剧情向量记忆'><Database size={17} /></button>}
                            <button onClick={() => setDeletingEntry(item)} className='w-10 h-10 shrink-0 rounded-full grid place-items-center text-rose-400 active:bg-rose-50' title='删除整个剧情' aria-label={`删除剧情 ${item.title}`}><Trash size={17} /></button>
                        </div>;
                    })}</div>}
                </section>

                <section className='pt-6 border-t border-slate-200'>
                    <div className='flex items-center justify-between'><div><div className='text-[9px] tracking-[.22em] uppercase font-bold text-violet-500'>Native presets</div><h2 className='mt-1 text-lg font-semibold'>糯米机预设制作器</h2></div><div className='flex gap-2'><button onClick={() => importInput.current?.click()} className='w-10 h-10 rounded-full bg-white border border-slate-200 grid place-items-center'><UploadSimple size={17} /></button><button onClick={() => { setEditingPreset(createBlankStoryPreset()); setView('preset'); }} className='w-10 h-10 rounded-full bg-white border border-slate-200 grid place-items-center'><Plus size={17} /></button></div></div>
                    <p className='mt-2 text-[10px] leading-5 text-slate-500'>仅支持导入与导出糯米机专属剧情预设文件，不支持其他应用的预设格式。</p>
                    <input ref={importInput} type='file' accept='.json,.png,application/json,image/png' className='hidden' onChange={async event => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) await importPreset(file); }} />
                    <div className='mt-4 divide-y divide-slate-200'>{presets.map(preset => <div key={preset.id} className='flex items-center gap-2'><button onClick={() => { setEditingPreset(preset); setView('preset'); }} className='min-w-0 flex-1 py-3 flex items-center gap-3 text-left'><span className={`w-2 h-2 rounded-full ${preset.builtIn ? 'bg-amber-400' : 'bg-violet-500'}`} /><span className='min-w-0 flex-1 text-xs font-semibold truncate'>{preset.name}</span><span className='text-[9px] text-slate-400'>{preset.builtIn ? '内置只读' : `${preset.document.prompts.length} 条`}</span></button><button onClick={() => { void downloadStoryPreset(preset); }} className='w-9 h-9 shrink-0 rounded-full grid place-items-center text-slate-400' title={`导出 ${preset.name}`}><DownloadSimple size={15} /></button></div>)}</div>
                </section>
            </div>
        </main>
        {deletingEntry && <div className='fixed inset-0 z-[95] flex items-end justify-center overflow-y-auto overscroll-contain bg-slate-950/35' onClick={() => !deletingStory && setDeletingEntry(null)} role='presentation'>
            <div className='story-safe-sheet w-full sm:max-w-sm rounded-t-[28px] bg-stone-100 px-5 pt-5 shadow-2xl' onClick={event => event.stopPropagation()} role='dialog' aria-modal='true' aria-labelledby='delete-story-title'>
                <div className='flex items-start gap-4'><div className='min-w-0 flex-1'><div className='text-[9px] uppercase tracking-[.2em] font-bold text-rose-500'>删除确认</div><h2 id='delete-story-title' className='mt-1 text-lg font-semibold'>删除整个剧情？</h2></div><button disabled={deletingStory} onClick={() => setDeletingEntry(null)} className='w-9 h-9 shrink-0 rounded-full bg-white border border-slate-200 grid place-items-center text-slate-400 disabled:opacity-30' aria-label='关闭删除确认'><X size={16} /></button></div>
                <p className='mt-4 text-[11px] leading-6 text-slate-600'>「{deletingEntry.title}」的楼层、事件盒、关系备注和本剧情专属记忆会一起删除。</p>
                {deletingEntry.writesToCharacterMemory && <p className='mt-2 text-[10px] leading-5 text-amber-700'>同步到角色聊天记录里的剧情陪伴记录也会删除；已经被记忆宫殿总结成长期记忆的内容不会受影响。</p>}
                {deletingEntry.archives.some(archive => Object.keys(archive.memoryConversions || {}).length > 0) && <p className='mt-2 text-[10px] leading-5 text-amber-700'>已通过事件盒手动转入记忆宫殿或神经链接的记忆会保留，可到对应角色的记忆页面管理。</p>}
                <p className='mt-2 text-[10px] leading-5 text-slate-400'>其它剧情、普通聊天与角色原有向量记忆不会受影响。删除后无法恢复。</p>
                <div className='mt-5 grid grid-cols-2 gap-3'><button disabled={deletingStory} onClick={() => setDeletingEntry(null)} className='h-12 rounded-2xl border border-slate-200 bg-white text-xs font-bold text-slate-600 disabled:opacity-30'>取消</button><button disabled={deletingStory} onClick={() => void confirmDeleteEntry()} className='h-12 rounded-2xl bg-rose-600 text-white text-xs font-bold disabled:opacity-40'>{deletingStory ? <SpinnerGap size={17} className='mx-auto animate-spin' /> : '删除整个剧情'}</button></div>
            </div>
        </div>}
    </div>;
};

const StoryTheater: React.FC<Props> = props => <StoryTheaterThemeProvider><StoryTheaterContent {...props} /></StoryTheaterThemeProvider>;

export default StoryTheater;
