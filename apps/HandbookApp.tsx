/**
 * 手账主编排
 *
 * 视觉/UI 拆分到 components/handbook/*：
 *   - HandbookCover       列表"封面 + 书签"
 *   - HandbookDayView     当日"翻开的活页本"（左侧装订环 + 纸张感）
 *   - HandbookPageCard    单页（胶带 + 倾斜便签）
 *   - HandbookCharPicker  生成前的角色筛选 bottom sheet
 *   - paper.ts            纸张原语 + 装饰小部件
 *
 * 这里只放 state、handlers、整体壳。
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { HandbookEntry, HandbookPage, HandbookLayout, Tracker } from '../types';
import {
    composePageLayout,
    findCharactersWithChatToday, pickLifestreamChars, getLocalDateStr,
    LifestreamDepth,
} from '../utils/handbookGenerator';
import { composePageV2, regenerateCharSlots, recomposeV2Layouts } from '../utils/handbookOrchestrator';
import { ensureSeedTrackers } from '../utils/trackerSeeds';
import HandbookCover from '../components/handbook/HandbookCover';
import HandbookDayView from '../components/handbook/HandbookDayView';
import HandbookCharPicker from '../components/handbook/HandbookCharPicker';
import HandbookSideTabs, { HandbookSection } from '../components/handbook/HandbookSideTabs';
import TrackerSection from '../components/handbook/TrackerSection';
import TrackerCreateSheet from '../components/handbook/TrackerCreateSheet';
import { PAPER_TONES, SERIF_STACK, dayOfWeekZh, monthEn, dayNum } from '../components/handbook/paper';
import { trackEvent } from '../utils/analytics';
import { CaretLeft, Plus, Sparkle } from '@phosphor-icons/react';
import { useConfirmDialog } from '../hooks/useConfirmDialog';

const HandbookApp: React.FC = () => {
    const { closeApp, characters, apiConfig, userProfile, addToast } = useOS();
    const { requestConfirm, confirmDialog } = useConfirmDialog();

    type View = 'list' | 'day';
    const [view, setView] = useState<View>('list');
    const [activeDate, setActiveDate] = useState<string>(getLocalDateStr());
    const [entries, setEntries] = useState<HandbookEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [editingPageId, setEditingPageId] = useState<string | null>(null);
    const [generating, setGenerating] = useState(false);
    const [regenPageId, setRegenPageId] = useState<string | null>(null);

    // 分区(今日 vs 各 tracker)
    const [activeSection, setActiveSection] = useState<HandbookSection>({ kind: 'today' });
    const [trackers, setTrackers] = useState<Tracker[]>([]);
    const [showTrackerCreate, setShowTrackerCreate] = useState(false);

    // 角色选择面板
    const [showCharPicker, setShowCharPicker] = useState(false);
    const [chatCharIds, setChatCharIds] = useState<string[]>([]);
    const [excludedChatChars, setExcludedChatChars] = useState<Set<string>>(new Set());
    const [excludedLifeChars, setExcludedLifeChars] = useState<Set<string>>(new Set());

    // 角色生活流深度档位(localStorage 持久化)
    const [lifestreamDepth, setLifestreamDepth] = useState<LifestreamDepth>(() => {
        try {
            const saved = localStorage.getItem('handbook_lifestream_depth');
            if (saved === 'light' || saved === 'medium' || saved === 'deep') return saved;
        } catch {}
        return 'medium';
    });
    const updateLifestreamDepth = (d: LifestreamDepth) => {
        setLifestreamDepth(d);
        try { localStorage.setItem('handbook_lifestream_depth', d); } catch {}
        trackEvent('切换角色生活流深度', { depth: d });
    };

    // ─── 数据加载 ───────────────────────────────────────
    const refreshEntries = useCallback(async () => {
        const all = await DB.getAllHandbooks();
        setEntries(all.sort((a, b) => b.date.localeCompare(a.date)));
        setLoading(false);
    }, []);

    const refreshTrackers = useCallback(async () => {
        await ensureSeedTrackers(); // 首次自动种"心情"作为示范
        const list = await DB.getAllTrackers();
        list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        setTrackers(list);
    }, []);

    useEffect(() => { refreshEntries(); refreshTrackers(); }, [refreshEntries, refreshTrackers]);

    const activeTracker = useMemo(() => {
        if (activeSection.kind !== 'tracker') return null;
        return trackers.find(t => t.id === activeSection.trackerId) || null;
    }, [activeSection, trackers]);

    const activeEntry = useMemo(
        () => entries.find(e => e.date === activeDate) || null,
        [entries, activeDate],
    );
    const todayEntry = useMemo(
        () => entries.find(e => e.date === getLocalDateStr()) || null,
        [entries],
    );
    const lifestreamCandidates = useMemo(() => pickLifestreamChars(characters), [characters]);

    // ─── 写入 entry 助手 ────────────────────────────────
    const upsertEntry = useCallback(async (date: string, mutate: (e: HandbookEntry) => HandbookEntry) => {
        const existing = await DB.getHandbook(date);
        const base: HandbookEntry = existing || { id: date, date, pages: [], updatedAt: Date.now() };
        const next = { ...mutate(base), updatedAt: Date.now() };
        await DB.saveHandbook(next);
        await refreshEntries();
        return next;
    }, [refreshEntries]);

    // ─── 打开"生成今日"面板 ─────────────────────────
    const openGeneratePicker = async () => {
        const chatted = await findCharactersWithChatToday(characters, activeDate);
        setChatCharIds(chatted);
        setExcludedChatChars(new Set());
        setExcludedLifeChars(new Set());
        setShowCharPicker(true);
        trackEvent('打开生成今日面板');
    };

    // ─── 执行生成 ─────────────────────────────────────
    // 进度提示: "正在写 ${name} (i/N)…"
    const [genProgress, setGenProgress] = useState<{ name: string; i: number; n: number } | null>(null);

    const runGenerate = async () => {
        if (!apiConfig.apiKey || !apiConfig.baseUrl) {
            addToast('请先在设置里配置主 API', 'error');
            return;
        }
        if (activeEntry?.pages.some(p => p.generatedBy === 'llm')) {
            const confirmed = await requestConfirm({
                title: '重新生成今日 AI 手账？',
                message: '今天已生成的 AI 手账页将被替换。',
                confirmText: '重新生成',
                variant: 'warning',
            });
            if (!confirmed) return;
        }
        setShowCharPicker(false);
        setGenerating(true);
        setGenProgress(null);
        trackEvent('生成今日手账');
        try {
            const selectedChat = chatCharIds.filter(id => !excludedChatChars.has(id));
            const selectedLife = lifestreamCandidates.filter(c => !excludedLifeChars.has(c.id));

            // v2 共写编排: 版式优先 + 槽位填空。
            // - user 没今日聊天则跳过 user 步
            // - 每个角色一次 LLM 调用, 一次出 2~5 条 fragment (生活流可造谣自己今天的事)
            // - 默认 cap 6 个角色 (再多 LLM 也容易搞混人设)
            const charIdsSet = new Set<string>([...selectedChat, ...selectedLife.map(c => c.id)]);
            const candidateCharIds = Array.from(charIdsSet);
            console.log(`[Handbook v2] 🔎 picker 选择:`);
            console.log(`[Handbook v2]   今天聊过 selectedChat (${selectedChat.length}): [${selectedChat.map(id => characters.find(c => c.id === id)?.name || id).join(', ')}]`);
            console.log(`[Handbook v2]   也写一笔 selectedLife (${selectedLife.length}): [${selectedLife.map(c => c.name).join(', ')}]`);
            console.log(`[Handbook v2]   去重合并 → 候选 (${candidateCharIds.length}): [${candidateCharIds.map(id => characters.find(c => c.id === id)?.name || id).join(', ')}]`);
            console.log(`[Handbook v2]   excludedChat=[${[...excludedChatChars].map(id => characters.find(c => c.id === id)?.name || id).join(', ')}], excludedLife=[${[...excludedLifeChars].map(id => characters.find(c => c.id === id)?.name || id).join(', ')}]`);

            const result = await composePageV2({
                date: activeDate,
                selectedCharIds: candidateCharIds,
                characters,
                userProfile,
                apiConfig,
                onProgress: ({ name, i, n }) => setGenProgress({ name, i, n }),
            });

            setGenProgress(null);

            if (result.pages.length === 0) {
                // 所有人都 pass 了 + user 也没素材 → 真的"今天空"
                addToast('今天大家都没什么想写的 — 留张白纸吧', 'info');
                return;
            }

            // 写入 entry: 替换所有旧 LLM 生成页 (保留 user 手写/编辑过的),
            // v2 layout 直接用 orchestrator 给的 (不再走 composePageLayout 重排)。
            // user 手写笔记仍然用旧版式引擎补一份兜底 layout, 跟 v2 layout 合并。
            await upsertEntry(activeDate, prev => {
                const kept = prev.pages.filter(p => p.generatedBy !== 'llm');
                const allPages = [...kept, ...result.pages];

                // 旧的 user 笔记走旧 layout 引擎补排 (跟 v2 layout 不冲突 — 不同 page 不同槽)
                const userNotePages = kept.filter(p => p.type === 'user_note');
                const legacyLayouts = userNotePages.length > 0
                    ? composePageLayout({
                        date: activeDate, pages: userNotePages, characters, userProfile,
                    })
                    : [];

                // 合并: v2 layout 是主体 (page 1), 旧笔记 layout 接在后面 (page 2+)
                const merged = [...result.layouts];
                let nextPage = (merged[merged.length - 1]?.pageNumber ?? 0) + 1;
                for (const lay of legacyLayouts) {
                    merged.push({ ...lay, pageNumber: nextPage++ });
                }

                return { ...prev, pages: allPages, layouts: merged, generatedAt: Date.now() };
            });

            setView('day');
            addToast(`共 ${result.pages.length} 人写了今天`, 'success');
        } finally {
            setGenerating(false);
            setGenProgress(null);
        }
    };

    // ─── 单页操作 ───────────────────────────────────────
    // v2: layout 在生成时就定死, mutate 不重洗版式 — 只剔除指向消失 page 的 placement,
    // user_note 单独走老 composePageLayout 拼到后面。
    const recomputeLayouts = (
        prevLayouts: HandbookLayout[] | undefined,
        newPages: HandbookPage[],
    ): HandbookLayout[] => {
        const v2Layouts = recomposeV2Layouts(prevLayouts || [], newPages);
        const userNotes = newPages.filter(p => p.type === 'user_note');
        const noteLayouts = userNotes.length > 0
            ? composePageLayout({ date: activeDate, pages: userNotes, characters, userProfile })
            : [];
        let nextPage = (v2Layouts[v2Layouts.length - 1]?.pageNumber ?? 0) + 1;
        const merged = [...v2Layouts];
        for (const nl of noteLayouts) merged.push({ ...nl, pageNumber: nextPage++ });
        return merged;
    };

    const updatePage = async (pageId: string, mutator: (p: HandbookPage) => HandbookPage) => {
        await upsertEntry(activeDate, prev => {
            const newPages = prev.pages.map(p => p.id === pageId ? mutator(p) : p);
            const layouts = recomputeLayouts(prev.layouts, newPages);
            return { ...prev, pages: newPages, layouts };
        });
    };

    const handleSavePage = async (pageId: string, newContent: string, newPaperStyle?: string) => {
        await updatePage(pageId, p => ({
            ...p,
            content: newContent,
            paperStyle: newPaperStyle ?? p.paperStyle,
            // 编辑后清空碎片 → 回退到段落形态(user 改写之后不再是 LLM 的 fragments 结构)
            fragments: undefined,
            generatedBy: p.generatedBy === 'llm' ? 'user' : p.generatedBy,
        }));
        setEditingPageId(null);
        trackEvent('保存手账页编辑');
    };

    const handleDeletePage = async (pageId: string): Promise<boolean> => {
        const confirmed = await requestConfirm({
            title: '撕掉这页？',
            message: '撕掉后这一页的内容将从当天手账移除，无法恢复。',
            confirmText: '撕掉',
            variant: 'danger',
        });
        if (!confirmed) return false;
        await upsertEntry(activeDate, prev => {
            const newPages = prev.pages.filter(p => p.id !== pageId);
            const layouts = recomputeLayouts(prev.layouts, newPages);
            return { ...prev, pages: newPages, layouts };
        });
        trackEvent('撕掉一页手账');
        return true;
    };

    const handleToggleExclude = async (pageId: string) => {
        await updatePage(pageId, p => ({ ...p, excluded: !p.excluded }));
        trackEvent('标记手账页不入册');
    };

    const handleRegenerateLifestream = async (page: HandbookPage) => {
        if (!page.charId) return;
        const char = characters.find(c => c.id === page.charId);
        if (!char) return;
        setRegenPageId(page.id);
        trackEvent('重新生成角色小生活');
        try {
            const entry = activeEntry;
            if (!entry) return;
            // v2: 重新跑该角色的 turn, 其他人 + user 的 fills 不动
            const result = await regenerateCharSlots({
                date: activeDate,
                charId: page.charId,
                pages: entry.pages,
                layouts: entry.layouts || [],
                characters, userProfile, apiConfig,
            });
            if (!result.newPage) {
                addToast('这次没写出来，再试一次吧。', 'error');
                return;
            }

            await upsertEntry(activeDate, prev => {
                // 删掉该 char 的所有旧 LLM page, 加新的
                const kept = prev.pages.filter(p =>
                    !(p.charId === page.charId && p.generatedBy === 'llm')
                );
                const newPages = [...kept, result.newPage!];
                return { ...prev, pages: newPages, layouts: result.newLayouts };
            });
            addToast(`${char.name} · 小生活已刷新`, 'success');
        } finally {
            setRegenPageId(null);
        }
    };

    const handleAddNote = async () => {
        trackEvent('新增手写页');
        const newPage: HandbookPage = {
            id: `note-${Date.now()}`, type: 'user_note', content: '',
            paperStyle: 'dot', generatedBy: 'user', generatedAt: Date.now(),
        };
        await upsertEntry(activeDate, prev => {
            const newPages = [...prev.pages, newPage];
            const layouts = recomputeLayouts(prev.layouts, newPages);
            return { ...prev, pages: newPages, layouts };
        });
        setEditingPageId(newPage.id);
    };

    // ─── 顶栏 ───────────────────────────────────────────
    // day view 时改成悬浮在本子上方的小药丸 — 可点击展开/折叠
    const [headerExpanded, setHeaderExpanded] = useState(true);

    const handleBack = () => {
        // 在 tracker → 回今日;day → 回封面;封面 → 关 app
        if (activeSection.kind === 'tracker') {
            setActiveSection({ kind: 'today' });
            return;
        }
        if (view === 'day') {
            setView('list');
            return;
        }
        closeApp();
    };

    const renderHeader = () => {
        // day view 走单独的"悬浮药丸"布局 — 不占文档流,飘在画布上方
        if (activeSection.kind === 'today' && view === 'day') return null;

        // tracker / list 视图保留原 header 风格(现在不挤,不需要折叠)
        return (
            <div
                className="flex items-center justify-between px-4 pb-2 shrink-0"
                style={{ background: 'transparent', paddingTop: 'max(3rem, var(--safe-top))' }}
            >
                <button
                    onClick={handleBack}
                    className="w-9 h-9 flex items-center justify-center rounded-full active:scale-95 transition"
                    style={{ background: 'rgba(253,246,231,0.7)', color: PAPER_TONES.ink }}
                >
                    <CaretLeft className="w-4 h-4" weight="bold" />
                </button>
                <div className="text-center" style={SERIF_STACK}>
                    {activeSection.kind === 'tracker' && activeTracker ? (
                        <>
                            <div className="text-[9px] tracking-[0.4em]" style={{ color: PAPER_TONES.inkSoft }}>
                                TRACKER
                            </div>
                            <div className="text-[14px] font-bold" style={{ color: PAPER_TONES.ink }}>
                                {activeTracker.icon ? `${activeTracker.icon} ` : ''}{activeTracker.name}
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="text-[9px] tracking-[0.4em]" style={{ color: PAPER_TONES.inkSoft }}>
                                HANDBOOK
                            </div>
                            <div className="text-[14px] font-bold" style={{ color: PAPER_TONES.ink }}>
                                手账
                            </div>
                        </>
                    )}
                </div>
                <div className="w-9 h-9" />
            </div>
        );
    };

    // ─── 翻页索引(被 DayView 改写,先存在 ref 里) ────
    const [floatingPaperIdx, setFloatingPaperIdx] = useState(0);
    useEffect(() => { setFloatingPaperIdx(0); }, [activeEntry?.id]);

    // ─── 悬浮在本子上方的小药丸(只 day view) ────────
    const renderFloatingDayBar = () => {
        if (activeSection.kind !== 'today' || view !== 'day') return null;
        const layouts = activeEntry?.layouts || [];
        const multi = layouts.length > 1;
        // 多页时点击就 cycle 翻到下一页(到末尾绕回 0)
        const goNext = () => setFloatingPaperIdx(i => layouts.length === 0 ? 0 : (i + 1) % layouts.length);
        return (
            <div
                className="absolute z-30 left-0 right-0 px-3 pointer-events-none"
                style={{ top: 'max(var(--safe-top), 12px)' }}
            >
                <div className="flex items-center justify-between gap-2 pointer-events-auto">
                    <button
                        onClick={handleBack}
                        className="w-8 h-8 flex items-center justify-center rounded-full active:scale-95 transition shrink-0"
                        style={{
                            background: 'rgba(255,248,251,0.92)',
                            color: PAPER_TONES.ink,
                            backdropFilter: 'blur(8px)',
                            boxShadow: '0 2px 8px -2px rgba(122,90,114,0.18)',
                        }}
                    >
                        <CaretLeft className="w-3.5 h-3.5" weight="bold" />
                    </button>

                    {/* 中间日期药丸 — 点击展开/折叠 */}
                    <button
                        onClick={() => setHeaderExpanded(v => !v)}
                        className="px-3 active:scale-[0.98] transition flex items-center gap-1.5 rounded-full overflow-hidden"
                        style={{
                            height: 28,
                            background: headerExpanded ? 'rgba(255,248,251,0.92)' : 'rgba(255,248,251,0.4)',
                            backdropFilter: 'blur(8px)',
                            boxShadow: headerExpanded ? '0 2px 8px -2px rgba(122,90,114,0.18)' : 'none',
                            color: PAPER_TONES.ink,
                            ...SERIF_STACK,
                        }}
                    >
                        {headerExpanded ? (
                            <>
                                <span style={{ fontSize: 9, letterSpacing: '0.3em', color: PAPER_TONES.inkSoft }}>
                                    {monthEn(activeDate)}
                                </span>
                                <span style={{ fontSize: 12, fontWeight: 700 }}>
                                    {dayNum(activeDate)} · 周{dayOfWeekZh(activeDate)}
                                </span>
                                {multi && (
                                    <span
                                        onClick={(e) => { e.stopPropagation(); goNext(); }}
                                        className="ml-1 px-1.5 py-0.5 rounded-full"
                                        style={{
                                            fontSize: 9,
                                            letterSpacing: '0.18em',
                                            color: PAPER_TONES.inkSoft,
                                            background: 'rgba(220,199,213,0.35)',
                                        }}
                                    >
                                        ‹ P {floatingPaperIdx + 1}/{layouts.length} ›
                                    </span>
                                )}
                            </>
                        ) : (
                            <span style={{ fontSize: 10, color: PAPER_TONES.inkSoft }}>♡</span>
                        )}
                    </button>

                    <button
                        onClick={handleAddNote}
                        className="w-8 h-8 flex items-center justify-center rounded-full active:scale-95 transition shrink-0"
                        style={{
                            background: 'rgba(255,248,251,0.92)',
                            color: PAPER_TONES.ink,
                            backdropFilter: 'blur(8px)',
                            boxShadow: '0 2px 8px -2px rgba(122,90,114,0.18)',
                        }}
                    >
                        <Plus className="w-3.5 h-3.5" weight="bold" />
                    </button>
                </div>
            </div>
        );
    };

    // ─── 当日视图底部"书签条" ────────────────────────
    const renderDayBookmarks = () => {
        if (activeSection.kind !== 'today' || view !== 'day') return null;
        return (
            <div className="absolute bottom-5 left-0 right-0 px-5 flex justify-center pointer-events-none">
                <div
                    className="pointer-events-auto flex items-center gap-1 rounded-full px-2 py-2"
                    style={{
                        background: 'rgba(253,246,231,0.96)',
                        boxShadow: '0 4px 14px -4px rgba(58,47,37,0.25), 0 0 0 1px rgba(168,140,100,0.15)',
                        backdropFilter: 'blur(6px)',
                    }}
                >
                    <button
                        onClick={openGeneratePicker}
                        disabled={generating}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[12px] active:scale-95 transition disabled:opacity-50"
                        style={{
                            ...SERIF_STACK,
                            background: PAPER_TONES.cover,
                            color: '#fdf6e7',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
                        }}
                    >
                        <Sparkle weight="fill" className="w-3 h-3" />
                        {generating
                            ? (genProgress
                                ? `${genProgress.name} 正在写… ${genProgress.i}/${genProgress.n}`
                                : '正在落笔…')
                            : (activeEntry ? '再写一份' : '让 AI 替我写')}
                    </button>
                    <button
                        onClick={handleAddNote}
                        className="flex items-center gap-1 px-3 py-2 rounded-full text-[12px] active:scale-95 transition"
                        style={{
                            ...SERIF_STACK,
                            color: PAPER_TONES.ink,
                            border: `1px solid ${PAPER_TONES.spine}`,
                        }}
                    >
                        <Plus className="w-3 h-3" weight="bold" />
                        手写
                    </button>
                </div>
            </div>
        );
    };

    const chatCharObjs = chatCharIds
        .map(id => characters.find(c => c.id === id))
        .filter(Boolean) as typeof characters;

    return (
        <div
            className="absolute inset-0 flex flex-col overflow-hidden"
            style={{ background: PAPER_TONES.paperCool }}
        >
            {renderHeader()}
            {loading ? (
                <div
                    className="flex-1 flex items-center justify-center text-sm"
                    style={{ ...SERIF_STACK, color: PAPER_TONES.inkSoft }}
                >
                    翻开中…
                </div>
            ) : activeSection.kind === 'tracker' && activeTracker ? (
                <TrackerSection
                    tracker={activeTracker}
                    onAddToast={(msg, type) => addToast(msg, type)}
                />
            ) : view === 'list' ? (
                <HandbookCover
                    today={getLocalDateStr()}
                    todayEntry={todayEntry}
                    entries={entries}
                    userName={userProfile.name || '我'}
                    generating={generating}
                    onGenerateToday={() => {
                        setActiveDate(getLocalDateStr());
                        openGeneratePicker();
                    }}
                    onOpenDate={(date) => {
                        setActiveDate(date);
                        setView('day');
                    }}
                />
            ) : (
                <HandbookDayView
                    date={activeDate}
                    entry={activeEntry}
                    characters={characters}
                    userName={userProfile.name || '我'}
                    editingPageId={editingPageId}
                    regenPageId={regenPageId}
                    onStartEdit={setEditingPageId}
                    onSavePage={handleSavePage}
                    onCancelEdit={() => setEditingPageId(null)}
                    onToggleExclude={handleToggleExclude}
                    onDeletePage={handleDeletePage}
                    onRegenerateLifestream={handleRegenerateLifestream}
                    paperIdx={floatingPaperIdx}
                    onPaperIdxChange={setFloatingPaperIdx}
                />
            )}
            {renderFloatingDayBar()}
            {renderDayBookmarks()}

            {/* 右侧活页本侧边 tab */}
            {!loading && (
                <HandbookSideTabs
                    activeSection={activeSection}
                    trackers={trackers}
                    onSwitch={(section) => {
                        setActiveSection(section);
                        // 只报分区类型（今日 / 打卡），tracker 名字是用户自己起的，不带出去
                        trackEvent('切换手账分区', { section: section.kind });
                    }}
                    onAddTracker={() => {
                        setShowTrackerCreate(true);
                        trackEvent('打开新建打卡面板');
                    }}
                />
            )}
            <TrackerCreateSheet
                visible={showTrackerCreate}
                existingTrackers={trackers}
                onCancel={() => setShowTrackerCreate(false)}
                onCreated={async (tracker) => {
                    await refreshTrackers();
                    setShowTrackerCreate(false);
                    setActiveSection({ kind: 'tracker', trackerId: tracker.id });
                    addToast(`「${tracker.name}」已添加 ♡`, 'success');
                    trackEvent('新建一个打卡项');
                }}
            />
            <HandbookCharPicker
                visible={showCharPicker}
                chatChars={chatCharObjs}
                lifeChars={lifestreamCandidates}
                excludedChat={excludedChatChars}
                excludedLife={excludedLifeChars}
                onToggleChat={(id) => setExcludedChatChars(prev => {
                    const n = new Set(prev);
                    if (n.has(id)) n.delete(id); else n.add(id);
                    return n;
                })}
                onToggleLife={(id) => setExcludedLifeChars(prev => {
                    const n = new Set(prev);
                    if (n.has(id)) n.delete(id); else n.add(id);
                    return n;
                })}
                onCancel={() => setShowCharPicker(false)}
                onConfirm={runGenerate}
                generating={generating}
                depth={lifestreamDepth}
                onDepthChange={updateLifestreamDepth}
            />
            {confirmDialog}
        </div>
    );
};

export default HandbookApp;
