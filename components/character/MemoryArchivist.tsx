
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { MemoryFragment } from '../../types';
import Modal from '../../components/os/Modal';
import { DEFAULT_REFINE_PROMPTS } from '../../components/chat/ChatConstants';
import { buildMemoryArchiveIndex } from '../../utils/memoryArchiveIndex';

interface MemoryArchivistProps {
    memories: MemoryFragment[];
    refinedMemories: Record<string, string>;
    activeMemoryMonths: string[];
    charName: string;
    userName: string;
    onRefine: (year: string, month: string, summary: string, formattedPrompt?: string) => Promise<void>;
    onDeleteMemories: (ids: string[]) => void;
    onUpdateMemory: (id: string, newSummary: string) => void | Promise<void>;
    linkedMemoryEnabled?: boolean;
    onToggleActiveMonth: (year: string, month: string) => void;
    onUpdateRefinedMemory: (year: string, month: string, newContent: string) => void;
    onDeleteRefinedMemory: (year: string, month: string) => void;
    /**
     * 按日期强制从原始聊天重总结（忽略 hideBefore）。日期格式 YYYY-MM-DD。
     * overridePromptId 可选——用户在重总结小弹窗里选的模板 id。不提供则走调用方默认。
     */
    onForceArchiveDate?: (dateStr: string, overridePromptId?: string) => Promise<void>;
    /** 可选：传入归档模板列表 + 默认选中 id，用于重总结前让用户选模板（避开和内部月度精炼模板 state 同名） */
    forceArchiveTemplates?: { id: string; name: string; content: string }[];
    forceArchiveDefaultPromptId?: string;
}

const MemoryArchivist: React.FC<MemoryArchivistProps> = ({ memories, refinedMemories, activeMemoryMonths, charName, userName, onRefine, onDeleteMemories, onUpdateMemory, linkedMemoryEnabled, onToggleActiveMonth, onUpdateRefinedMemory, onDeleteRefinedMemory, onForceArchiveDate, forceArchiveTemplates, forceArchiveDefaultPromptId }) => {
    // 每个日期的"强制重总结"运行状态
    const [forcingDate, setForcingDate] = useState<string | null>(null);
    // 重总结前弹出模板选择器：把 date 存起来打开 modal
    const [forcePickerDate, setForcePickerDate] = useState<string | null>(null);
    const [forcePickerPromptId, setForcePickerPromptId] = useState<string>(forceArchiveDefaultPromptId || '');

    const openForcePicker = (date: string) => {
        if (!onForceArchiveDate || forcingDate) return;
        // 如果没有模板数据，就退回到原行为——直接跑
        if (!forceArchiveTemplates || forceArchiveTemplates.length === 0) {
            setForcingDate(date);
            onForceArchiveDate(date).finally(() => setForcingDate(null));
            return;
        }
        setForcePickerPromptId(forceArchiveDefaultPromptId || forceArchiveTemplates[0].id);
        setForcePickerDate(date);
    };
    const confirmForcePicker = async () => {
        if (!forcePickerDate || !onForceArchiveDate) return;
        const date = forcePickerDate;
        const promptId = forcePickerPromptId;
        setForcePickerDate(null);
        setForcingDate(date);
        try { await onForceArchiveDate(date, promptId); } finally { setForcingDate(null); }
    };
    const [viewState, setViewState] = useState<{
        level: 'root' | 'year' | 'month';
        selectedYear: string | null;
        selectedMonth: string | null;
    }>({ level: 'root', selectedYear: null, selectedMonth: null });
    const [isRefining, setIsRefining] = useState(false);
    const [isManageMode, setIsManageMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [editMemory, setEditMemory] = useState<MemoryFragment | null>(null);
    const [savingMemory, setSavingMemory] = useState(false);
    const [memorySaveError, setMemorySaveError] = useState('');
    useEffect(() => { setMemorySaveError(''); }, [editMemory?.id]);
    const saveEditedMemory = async () => {
        if (!editMemory || savingMemory) return;
        setSavingMemory(true); setMemorySaveError('');
        try { await onUpdateMemory(editMemory.id, editMemory.summary); setEditMemory(null); }
        catch (error) { setMemorySaveError(error instanceof Error ? error.message : '保存失败，请重试'); }
        finally { setSavingMemory(false); }
    };
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [expandedMemoryIds, setExpandedMemoryIds] = useState<Set<string>>(new Set());

    // Core Memory Edit State
    const [editingCore, setEditingCore] = useState<{year: string, month: string, content: string} | null>(null);
    const [showCoreDeleteConfirm, setShowCoreDeleteConfirm] = useState(false);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Monthly refinement prompt selection (character-specific, independent from Chat app)
    const [archivePrompts, setArchivePrompts] = useState<{id: string, name: string, content: string}[]>(DEFAULT_REFINE_PROMPTS);
    const [selectedPromptId, setSelectedPromptId] = useState<string>('refine_atmosphere');
    const [showPromptPanel, setShowPromptPanel] = useState(false);

    useEffect(() => {
        const savedPrompts = localStorage.getItem('character_refine_prompts');
        if (savedPrompts) {
            try {
                const parsed = JSON.parse(savedPrompts);
                const merged = [...DEFAULT_REFINE_PROMPTS, ...parsed.filter((p: any) => !p.id.startsWith('refine_'))];
                setArchivePrompts(merged);
            } catch(e) {}
        }
        const savedId = localStorage.getItem('character_active_refine_prompt_id');
        if (savedId) setSelectedPromptId(savedId);
    }, []);

    const { tree, stats } = useMemo(
        () => buildMemoryArchiveIndex(memories, refinedMemories, activeMemoryMonths),
        [memories, refinedMemories, activeMemoryMonths],
    );

    const handleYearClick = (year: string) => setViewState({ level: 'year', selectedYear: year, selectedMonth: null });
    const handleMonthClick = (month: string) => {
        setExpandedMemoryIds(new Set());
        setViewState(prev => ({ ...prev, level: 'month', selectedMonth: month }));
    };
    const handleBack = () => {
        if (viewState.level === 'month') setViewState(prev => ({ ...prev, level: 'year', selectedMonth: null }));
        else if (viewState.level === 'year') setViewState({ level: 'root', selectedYear: null, selectedMonth: null });
    };

    const triggerRefine = async () => {
        if (!viewState.selectedYear || !viewState.selectedMonth) return;
        setIsRefining(true);
        const monthMems = tree[viewState.selectedYear][viewState.selectedMonth];
        const combinedText = monthMems.map(m => `${m.date}: ${m.summary} (${m.mood || '无'})`).join('\n');

        // Build formatted prompt if a template is selected
        let formattedPrompt: string | undefined;
        const templateObj = archivePrompts.find(p => p.id === selectedPromptId);
        if (templateObj) {
            const dateStr = `${viewState.selectedYear}-${viewState.selectedMonth}`;
            // ${rawLog} 不再当场替换成 combinedText：rawText 由 handleRefineMonth 以
            // role:user 单独投喂（Gemini 3.1 preview 对"规则/身份 → 迟到 rawLog"
            // 的 all-in-one user 消息会静默拒答，拆开再发能解决）。这里只留占位提示。
            formattedPrompt = templateObj.content
                .replace(/\$\{dateStr\}/g, dateStr)
                .replace(/\$\{char\.name\}/g, charName)
                .replace(/\$\{userProfile\.name\}/g, userName)
                .replace(/\$\{rawLog.*?\}/g, '<见 user 消息里的本月日记原件>');
            formattedPrompt = `[角色记忆精炼: ${charName} - ${dateStr}]\n${formattedPrompt}`;
        }

        try { await onRefine(viewState.selectedYear, viewState.selectedMonth, combinedText, formattedPrompt); } finally { setIsRefining(false); }
    };

    const toggleSelection = (id: string) => {
        const next = new Set(selectedIds);
        if (next.has(id)) next.delete(id); else next.add(id);
        setSelectedIds(next);
    };



    const toggleMemoryExpanded = (id: string) => {
        setExpandedMemoryIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };
    const requestDelete = () => { if (selectedIds.size > 0) setShowDeleteConfirm(true); };
    const performDelete = () => { onDeleteMemories(Array.from(selectedIds)); setSelectedIds(new Set()); setIsManageMode(false); setShowDeleteConfirm(false); };

    // Core Memory Interaction
    const handleCoreTouchStart = (content: string) => {
        if (!viewState.selectedYear || !viewState.selectedMonth) return;
        const y = viewState.selectedYear;
        const m = viewState.selectedMonth;
        longPressTimer.current = setTimeout(() => {
            setEditingCore({ year: y, month: m, content });
        }, 600);
    };

    const handleCoreTouchEnd = () => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    };

    const saveCoreEdit = () => {
        if (editingCore) {
            onUpdateRefinedMemory(editingCore.year, editingCore.month, editingCore.content);
            setEditingCore(null);
        }
    };

    const confirmCoreDelete = () => {
        if (editingCore) {
            onDeleteRefinedMemory(editingCore.year, editingCore.month);
            setEditingCore(null);
            setShowCoreDeleteConfirm(false);
        }
    };

    if (Object.keys(tree).length === 0) return <div className="flex flex-col items-center justify-center h-48 text-slate-400"><p className="text-xs">暂无记忆档案</p></div>;

    const renderYears = () => (
        <div className="grid grid-cols-2 gap-3 animate-fade-in">
            {Object.keys(tree).map(year => (
                <div key={year} onClick={() => handleYearClick(year)} className="bg-white/60 backdrop-blur-sm p-4 rounded-2xl border border-white/50 shadow-sm active:scale-95 transition-all flex flex-col justify-between h-28 group cursor-pointer hover:bg-white/80">
                    <div className="flex justify-between items-start">
                         <div className="p-2 bg-amber-100/50 rounded-lg text-amber-600"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" /></svg></div>
                         <span className="text-[10px] bg-slate-100 px-2 py-1 rounded-full text-slate-500 font-mono">
                             {Object.values(tree[year]).reduce((acc, curr) => acc + curr.length, 0)}日度
                             {Object.keys(tree[year]).some(month => !!refinedMemories?.[`${year}-${month}`])
                                 ? ` · ${Object.keys(tree[year]).filter(month => !!refinedMemories?.[`${year}-${month}`]).length}核心`
                                 : ''}
                         </span>
                    </div>
                    <div><h3 className="text-xl font-light text-slate-800 tracking-tight">{year}</h3><p className="text-[10px] text-slate-400">年度档案归档</p></div>
                </div>
            ))}
        </div>
    );

    const renderMonths = () => viewState.selectedYear && tree[viewState.selectedYear] && (
        <div className="grid grid-cols-3 gap-3 animate-fade-in">
            {Object.keys(tree[viewState.selectedYear]).map(month => {
                const monthKey = `${viewState.selectedYear}-${month}`;
                const isActive = activeMemoryMonths.includes(monthKey);
                return (
                    <div key={month} className="relative group">
                         <div onClick={() => handleMonthClick(month)} className="bg-white/50 backdrop-blur-sm p-3 rounded-2xl border border-white/40 shadow-sm active:scale-95 transition-all flex flex-col justify-center items-center gap-2 aspect-square cursor-pointer hover:bg-white/70 relative overflow-hidden">
                            {refinedMemories?.[monthKey] && <div className="absolute top-0 right-0 w-3 h-3 bg-indigo-500 rounded-bl-lg shadow-sm"></div>}
                            <span className="text-2xl font-light text-slate-700">{parseInt(month)}<span className="text-xs ml-0.5 text-slate-400">月</span></span>
                            <div className="h-0.5 w-4 bg-primary/30 rounded-full"></div>
                            <span className="text-[10px] text-slate-400">
                                {tree[viewState.selectedYear!][month].length > 0
                                    ? `${tree[viewState.selectedYear!][month].length} 条日度`
                                    : (refinedMemories?.[monthKey] ? '仅月度核心' : '无日度记录')}
                            </span>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); onToggleActiveMonth(viewState.selectedYear!, month); }} className={`absolute -top-2 -right-2 p-1.5 rounded-full shadow-md z-10 transition-colors ${isActive ? 'bg-primary text-white' : 'bg-white text-slate-300 border border-slate-100'}`}>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /><path fillRule="evenodd" d="M1.323 11.447C2.811 6.976 7.028 3.75 12.001 3.75c4.97 0 9.185 3.223 10.675 7.69.12.362.12.752 0 1.113-1.487 4.471-5.705 7.697-10.677 7.697-4.97 0-9.186-3.223-10.675-7.69a1.762 1.762 0 0 1 0-1.113ZM17.25 12a5.25 5.25 0 1 1-10.5 0 5.25 5.25 0 0 1 10.5 0Z" clipRule="evenodd" /></svg>
                        </button>
                    </div>
                );
            })}
        </div>
    );

    const renderMemories = () => {
        if (!viewState.selectedYear || !viewState.selectedMonth) return null;
        const key = `${viewState.selectedYear}-${viewState.selectedMonth}`;
        const refinedContent = refinedMemories?.[key];
        const rawMemories = tree[viewState.selectedYear]?.[viewState.selectedMonth] || [];
        const isActive = activeMemoryMonths.includes(key);

        const groupedByDay: Record<string, MemoryFragment[]> = {};
        rawMemories.forEach(m => { if (!groupedByDay[m.date]) groupedByDay[m.date] = []; groupedByDay[m.date].push(m); });

        return (
            <div className="space-y-6 animate-fade-in pb-8">
                <div className="bg-indigo-50/50 rounded-2xl p-4 border border-indigo-100 relative group">
                    <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center gap-2 text-indigo-700"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M14.615 1.595a.75.75 0 0 1 .359.852L12.982 9.75h7.268a.75.75 0 0 1 .548 1.262l-10.5 11.25a.75.75 0 0 1-1.272-.71l1.992-7.302H3.75a.75.75 0 0 1-.548-1.262l10.5-11.25a.75.75 0 0 1 .914-.143Z" clipRule="evenodd" /></svg><h4 className="text-xs font-bold tracking-wide uppercase">月度核心记忆</h4></div>
                        <div className="flex gap-2">
                             <button onClick={() => onToggleActiveMonth(viewState.selectedYear!, viewState.selectedMonth!)} className={`text-[10px] px-3 py-1 rounded-full border shadow-sm transition-colors flex items-center gap-1 ${isActive ? 'bg-primary text-white border-primary' : 'bg-white text-slate-500 border-slate-200'}`}>{isActive ? '详细回忆已开启' : '仅使用核心记忆'}</button>
                             <button onClick={() => setShowPromptPanel(!showPromptPanel)} className="text-[10px] bg-white text-slate-500 px-2 py-1 rounded-full border border-slate-200 shadow-sm hover:bg-slate-50 transition-colors">
                                 <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75" /></svg>
                             </button>
                             <button
                                 onClick={triggerRefine}
                                 disabled={isRefining || rawMemories.length === 0}
                                 title={rawMemories.length === 0 ? '没有日度记录，无法重新精炼' : undefined}
                                 className="text-[10px] bg-white text-indigo-600 px-3 py-1 rounded-full border border-indigo-200 shadow-sm hover:bg-indigo-500 hover:text-white transition-colors flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                             >
                                 {isRefining ? '...' : (refinedContent ? '重新精炼' : '生成')}
                             </button>
                        </div>
                    </div>
                    {/* Prompt Selection Panel */}
                    {showPromptPanel && (
                        <div className="mb-3 bg-white/70 p-3 rounded-xl border border-indigo-100 animate-fade-in">
                            <label className="text-[9px] font-bold text-indigo-400 uppercase mb-2 block">选择总结提示词</label>
                            <div className="flex flex-col gap-1.5">
                                {archivePrompts.map(p => (
                                    <div key={p.id} onClick={() => { setSelectedPromptId(p.id); localStorage.setItem('character_active_refine_prompt_id', p.id); }} className={`px-3 py-2 rounded-lg border cursor-pointer text-xs font-bold transition-all ${selectedPromptId === p.id ? 'bg-indigo-50 border-indigo-400 text-indigo-700 shadow-sm' : 'bg-white/50 border-indigo-100 text-slate-500 hover:bg-white'}`}>
                                        {p.name}
                                    </div>
                                ))}
                            </div>
                            <p className="text-[8px] text-indigo-300 mt-2 leading-tight">角色月度精炼专用提示词，与聊天归档独立。</p>
                        </div>
                    )}
                    {/* Display Refined Memory Content if exists */}
                    {refinedContent && (
                        <div 
                            className="text-sm text-indigo-900 leading-relaxed bg-white/60 p-3 rounded-xl border border-indigo-50 cursor-pointer active:scale-[0.99] transition-transform select-none"
                            onTouchStart={() => handleCoreTouchStart(refinedContent)}
                            onTouchEnd={handleCoreTouchEnd}
                            onMouseDown={() => handleCoreTouchStart(refinedContent)}
                            onMouseUp={handleCoreTouchEnd}
                            onMouseLeave={handleCoreTouchEnd}
                            onContextMenu={(e) => { e.preventDefault(); setEditingCore({year: viewState.selectedYear!, month: viewState.selectedMonth!, content: refinedContent}); }}
                            title="长按编辑/删除"
                        >
                            {refinedContent}
                        </div>
                    )}
                    {rawMemories.length === 0 && refinedContent && (
                        <p className="mt-2 text-[10px] leading-relaxed text-indigo-500">
                            本月没有日度记录，但这条月度核心记忆仍会发送给角色。长按上方内容可编辑或删除。
                        </p>
                    )}
                </div>
                
                <div className="flex items-center justify-between px-1">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest">日度记忆记录</h4>
                    <div className="flex gap-2">
                        {isManageMode && selectedIds.size > 0 && <button onClick={(e) => { e.stopPropagation(); requestDelete(); }} className="text-[10px] bg-red-500 text-white px-3 py-1 rounded-full font-bold shadow-sm active:scale-95 transition-transform">删除 ({selectedIds.size})</button>}
                        {rawMemories.length > 0 && <button onClick={() => { setIsManageMode(!isManageMode); setSelectedIds(new Set()); }} className={`text-[10px] px-3 py-1 rounded-full border transition-colors ${isManageMode ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-500 border-slate-200'}`}>{isManageMode ? '完成' : '管理'}</button>}
                    </div>
                </div>

                <div className="mt-2 pl-2">
                    {rawMemories.length === 0 && (
                        <div className="rounded-xl border border-dashed border-slate-200 bg-white/40 px-4 py-6 text-center text-xs text-slate-400">
                            本月没有日度记录
                        </div>
                    )}
                    {Object.entries(groupedByDay).map(([date, dayMemories]) => (
                        <div key={date} className="relative pl-8 pb-8 last:pb-0 border-l-[2px] border-slate-100 last:border-l-0 last:border-image-source-none">
                            <div className="absolute left-[-2px] top-0 bottom-0 w-[2px] bg-slate-100"></div>
                            <div className="absolute left-[-7px] top-0 w-3.5 h-3.5 bg-slate-300 rounded-full border-4 border-slate-50 z-10"></div>
                            <div className="mb-3 -mt-1.5 flex items-center gap-2">
                                <span className="text-xs font-bold text-slate-500 font-mono tracking-tight">{date}</span>
                                {dayMemories.length > 1 && <span className="text-[9px] px-1.5 py-0.5 bg-slate-100 rounded-md text-slate-400 font-normal">{dayMemories.length} 记录</span>}
                                {onForceArchiveDate && (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); openForcePicker(date); }}
                                        disabled={forcingDate === date}
                                        title={`从原始聊天重新总结 ${date}（忽略已隐藏状态）`}
                                        className="ml-auto text-[10px] font-normal text-slate-400 hover:text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-md px-2 py-0.5 transition-colors disabled:opacity-50"
                                    >
                                        {forcingDate === date ? '总结中…' : '重新总结'}
                                    </button>
                                )}
                            </div>
                            <div className="bg-white rounded-xl rounded-tl-none border border-slate-100 shadow-sm divide-y divide-slate-100">
                                {dayMemories.map((mem) => (
                                    <div 
                                        key={mem.id} 
                                        className={`relative group transition-all duration-300 ${isManageMode ? 'cursor-pointer' : ''}`} 
                                        onClick={() => { if (isManageMode) toggleSelection(mem.id); }}
                                    >
                                        {isManageMode && <div className={`absolute -left-[38px] top-1/2 -translate-y-1/2 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors z-20 ${selectedIds.has(mem.id) ? 'bg-primary border-primary' : 'bg-white border-slate-300'}`}>{selectedIds.has(mem.id) && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}</div>}
                                        <div className={`p-4 hover:bg-slate-50/50 transition-all relative ${isManageMode && selectedIds.has(mem.id) ? 'ring-2 ring-primary ring-offset-2' : ''}`} onClick={(e) => { if (!isManageMode) { e.stopPropagation(); toggleMemoryExpanded(mem.id); } }}>
                                            
                                            {/* Explicit Edit Button - Visible always on desktop, touchable on mobile */}
                                            {!isManageMode && (
                                                <button 
                                                    onClick={(e) => { e.stopPropagation(); setEditMemory(mem); }}
                                                    className="absolute top-2 right-2 p-1.5 text-slate-300 hover:text-primary bg-transparent hover:bg-slate-50 rounded-full transition-colors z-10"
                                                    title="编辑"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                                                        <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
                                                    </svg>
                                                </button>
                                            )}

                                            {mem.mood && <div className="mb-1 pr-6"><span className="text-[10px] px-1.5 py-0.5 bg-primary/5 text-primary rounded-md font-medium">#{mem.mood}</span></div>}
                                            <p className="text-sm text-slate-700 leading-relaxed text-justify whitespace-pre-wrap">{expandedMemoryIds.has(mem.id) ? mem.summary : (mem.summary.length > 120 ? `${mem.summary.slice(0, 120)}...` : mem.summary)}</p>
                                            {!isManageMode && mem.summary.length > 120 && <div className="mt-2 text-[10px] text-slate-400">{expandedMemoryIds.has(mem.id) ? '点击收起' : '点击展开'}</div>}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full relative">
            <div className="flex justify-between items-center mb-6 px-1">
                <div className="flex gap-4">
                    <div><span className="block text-[10px] text-slate-400 uppercase tracking-widest">总字数</span><span className="text-lg font-medium text-slate-700 font-mono">{stats.totalChars.toLocaleString()}</span></div>
                    <div><span className="block text-[10px] text-slate-400 uppercase tracking-widest">总条目</span><span className="text-lg font-medium text-slate-700 font-mono">{stats.count}</span></div>
                </div>
                <div className="flex items-center gap-1 text-xs font-medium text-slate-500 bg-white/50 px-3 py-1.5 rounded-full border border-white/50 shadow-sm">
                    {viewState.level === 'root' ? <span>档案室</span> : (
                        <>
                            <button onClick={() => setViewState({level: 'root', selectedYear: null, selectedMonth: null})} className="hover:text-primary">档案</button><span className="text-slate-300">/</span>
                            {viewState.level === 'year' ? <span className="text-slate-800">{viewState.selectedYear}</span> : (<><button onClick={() => setViewState(prev => ({...prev, level: 'year', selectedMonth: null}))} className="hover:text-primary">{viewState.selectedYear}</button><span className="text-slate-300">/</span><span className="text-slate-800">{parseInt(viewState.selectedMonth!)}月</span></>)}
                        </>
                    )}
                </div>
            </div>
            {viewState.level === 'root' && renderYears()}
            {viewState.level === 'year' && <><div className="mb-4 flex items-center gap-2"><button onClick={handleBack} className="p-1.5 bg-white rounded-full text-slate-400 hover:text-slate-600 shadow-sm"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z" clipRule="evenodd" /></svg></button><h3 className="text-sm font-medium text-slate-600">选择月份</h3></div>{renderMonths()}</>}
            {viewState.level === 'month' && <><div className="mb-4 flex items-center gap-2"><button onClick={handleBack} className="p-1.5 bg-white rounded-full text-slate-400 hover:text-slate-600 shadow-sm"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z" clipRule="evenodd" /></svg></button><h3 className="text-sm font-medium text-slate-600">本月记忆 (点击眼睛图标激活详细回忆)</h3></div>{renderMemories()}</>}

            <Modal isOpen={!!editMemory} title="编辑记忆" onClose={() => { if (!savingMemory) setEditMemory(null); }} footer={<button disabled={savingMemory || !editMemory?.summary.trim()} onClick={() => void saveEditedMemory()} className="w-full py-3 bg-primary text-white font-bold rounded-2xl disabled:opacity-50">{savingMemory ? '保存中…' : '保存修改'}</button>}>
                {editMemory && <div className="space-y-3"><div className="text-xs text-slate-400">日期: {editMemory.date}</div>{linkedMemoryEnabled && editMemory.palaceMemoryId && <p className="text-xs text-violet-600">此条关联记忆宫殿。修改正文会同步修改宫殿并更新向量，可能产生 Embedding API 费用。</p>}<textarea disabled={savingMemory} value={editMemory.summary} onChange={e => setEditMemory({...editMemory, summary: e.target.value})} className="w-full h-40 bg-slate-100 rounded-xl p-3 text-sm resize-none focus:outline-primary"/>{memorySaveError && <p role="alert" className="text-xs text-red-500">{memorySaveError}</p>}</div>}
            </Modal>
            
            <Modal isOpen={showDeleteConfirm} title="确认删除" onClose={() => setShowDeleteConfirm(false)} footer={<div className="flex gap-2 w-full"><button onClick={() => setShowDeleteConfirm(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">取消</button><button onClick={performDelete} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200">确认删除</button></div>}>
                <p className="text-sm text-slate-600 text-center py-4">确定删除选中的 {selectedIds.size} 条记忆吗？<br/><span className="text-xs text-red-400 mt-1 block">此操作不可恢复。</span></p>
                {memories.some(memory => selectedIds.has(memory.id) && memory.palaceMemoryId) && <p className="text-xs text-slate-500">这里只删除神经链接的档案记录，关联的宫殿记忆仍保留。</p>}
            </Modal>

            {/* Core Memory Edit Modal */}
            <Modal 
                isOpen={!!editingCore} 
                title="编辑核心记忆" 
                onClose={() => setEditingCore(null)}
                footer={
                    <div className="flex gap-2 w-full">
                        <button onClick={() => setShowCoreDeleteConfirm(true)} className="flex-1 py-3 bg-red-50 text-red-500 font-bold rounded-2xl">删除</button>
                        <button onClick={saveCoreEdit} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl shadow-lg">保存</button>
                    </div>
                }
            >
                {editingCore && (
                    <div className="space-y-2">
                        <div className="text-xs text-slate-400">{editingCore.year}年{editingCore.month}月</div>
                        <textarea 
                            value={editingCore.content} 
                            onChange={e => setEditingCore({...editingCore, content: e.target.value})} 
                            className="w-full h-48 bg-slate-100 rounded-xl p-3 text-sm resize-none focus:outline-primary leading-relaxed"
                        />
                    </div>
                )}
            </Modal>

            {/* Core Memory Delete Confirm */}
            <Modal isOpen={showCoreDeleteConfirm} title="删除确认" onClose={() => setShowCoreDeleteConfirm(false)} footer={<div className="flex gap-2 w-full"><button onClick={() => setShowCoreDeleteConfirm(false)} className="flex-1 py-3 bg-slate-100 font-bold rounded-2xl">取消</button><button onClick={confirmCoreDelete} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl">确认删除</button></div>}>
                <p className="text-center text-sm text-slate-600 py-4">确定要删除该月的核心记忆吗？<br/><span className="text-xs text-red-400">删除后会丢失该月给角色用的核心记忆摘要。</span></p>
            </Modal>

            {/* 重新总结 —— 模板选择弹窗 */}
            <Modal
                isOpen={!!forcePickerDate}
                title="重新总结"
                onClose={() => setForcePickerDate(null)}
                footer={<div className="flex gap-2 w-full">
                    <button onClick={() => setForcePickerDate(null)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">取消</button>
                    <button onClick={confirmForcePicker} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl">开始总结</button>
                </div>}
            >
                <div className="space-y-3">
                    <p className="text-xs text-slate-500 leading-relaxed">
                        即将从原始聊天重新总结 <b className="text-slate-700">{forcePickerDate}</b> 这一天。
                        此操作忽略隐藏起点，直接读当天全部原始消息。选择你想用的提示词风格：
                    </p>
                    <div className="space-y-1.5 max-h-[40vh] overflow-y-auto">
                        {(forceArchiveTemplates || []).map(p => (
                            <div
                                key={p.id}
                                onClick={() => setForcePickerPromptId(p.id)}
                                className={`p-3 rounded-xl border cursor-pointer transition-colors ${forcePickerPromptId === p.id ? 'bg-primary/5 border-primary ring-1 ring-primary/30' : 'bg-white border-slate-200 hover:bg-slate-50'}`}
                            >
                                <div className={`text-xs font-bold ${forcePickerPromptId === p.id ? 'text-primary' : 'text-slate-600'}`}>
                                    {p.name}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </Modal>
        </div>
    );
};

export default MemoryArchivist;
