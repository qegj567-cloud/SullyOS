/**
 * 当日视图 — 一张固定比例的"纸"
 *
 * - 整页 = 一张纸,瘦长比例,尽量铺满移动端可视区
 * - 所有 fragment(user diary + 各 char lifestream + user_note) 散落在同一张纸上
 * - 位置由 composePageLayout (确定性版式引擎) 同步算出, 存进 entry.layouts
 * - 一张装不下 → entry.layouts 有多张,顶部悬浮 bar 翻页
 */

import React, { useState, useEffect } from 'react';
import { HandbookEntry, HandbookPage, CharacterProfile } from '../../types';
import JournalCanvas from './JournalCanvas';
import JournalPageEditor from './JournalPageEditor';
import { PAPER_TONES, CUTE_STACK } from './paper';
import { Notebook } from '@phosphor-icons/react';

interface DayViewProps {
    date: string;
    entry: HandbookEntry | null;
    characters: CharacterProfile[];
    userName: string;
    editingPageId: string | null;
    regenPageId: string | null;
    onStartEdit: (pageId: string) => void;
    onSavePage: (pageId: string, content: string, paperStyle?: string) => void;
    onCancelEdit: () => void;
    onToggleExclude: (pageId: string) => void;
    onDeletePage: (pageId: string) => Promise<boolean> | void;
    onRegenerateLifestream: (page: HandbookPage) => void;
    /** 翻页索引由父级控制(顶部悬浮 bar 也要切),非受控时内部维护 */
    paperIdx?: number;
    onPaperIdxChange?: (idx: number) => void;
}

const HandbookDayView: React.FC<DayViewProps> = ({
    date, entry, characters, userName, editingPageId, regenPageId,
    onStartEdit, onSavePage, onCancelEdit, onToggleExclude, onDeletePage, onRegenerateLifestream,
    paperIdx: paperIdxProp, onPaperIdxChange,
}) => {
    const allPages = entry?.pages || [];
    const layouts = entry?.layouts || [];

    const [internalPaperIdx, setInternalPaperIdx] = useState(0);
    const paperIdx = paperIdxProp ?? internalPaperIdx;
    const setPaperIdx = (idx: number) => {
        setInternalPaperIdx(idx);
        onPaperIdxChange?.(idx);
    };

    // entry / layouts 切换 → 回到第一张纸
    useEffect(() => { setPaperIdx(0); /* eslint-disable-next-line */ }, [entry?.id, layouts.length]);

    const activeLayout = layouts[paperIdx] || null;

    // 编辑某页时:取出 page
    const editingPage = editingPageId ? allPages.find(p => p.id === editingPageId) : null;
    const editingChar = editingPage?.charId ? characters.find(c => c.id === editingPage.charId) : undefined;

    return (
        <div
            className="flex-1 flex flex-col overflow-hidden relative"
            style={{
                background: `${PAPER_TONES.paperWarm} radial-gradient(circle at 15% 8%, rgba(251,184,200,0.16) 0%, transparent 35%), radial-gradient(circle at 85% 70%, rgba(185,211,224,0.16) 0%, transparent 35%)`,
            }}
        >
            {/* 主画布区 — 自适应填满, 顶部留出悬浮 bar 的位置 */}
            <div
                className="flex-1 px-3 pb-3 min-h-0"
                style={{ paddingTop: 'calc(max(env(safe-area-inset-top, 12px), 12px) + 40px)' }}
            >
                {allPages.length === 0 || !activeLayout ? (
                    <EmptyDay />
                ) : (
                    <JournalCanvas
                        date={date}
                        layout={activeLayout}
                        pages={allPages}
                        characters={characters}
                        userName={userName}
                        showHeader={paperIdx === 0}
                        pageNumberLabel={layouts.length > 1 ? `${paperIdx + 1} / ${layouts.length}` : undefined}
                        onPickPlacement={(pageId) => onStartEdit(pageId)}
                    />
                )}
            </div>

            {/* 单页编辑覆盖层 */}
            {editingPage && (
                <JournalPageEditor
                    page={editingPage}
                    char={editingChar}
                    isRegenerating={regenPageId === editingPage.id}
                    onClose={onCancelEdit}
                    onSave={(content, paperStyle) => onSavePage(editingPage.id, content, paperStyle)}
                    onToggleExclude={() => onToggleExclude(editingPage.id)}
                    onDelete={async () => { const deleted = await onDeletePage(editingPage.id); if (deleted !== false) onCancelEdit(); }}
                    onRegenerate={editingPage.type === 'character_life'
                        ? () => onRegenerateLifestream(editingPage)
                        : undefined}
                />
            )}
        </div>
    );
};

// ─── 空状态 ──────────────────────────────────────
const EmptyDay: React.FC = () => (
    <div
        className="h-full w-full flex flex-col items-center justify-center text-center"
        style={{ color: PAPER_TONES.inkSoft }}
    >
        <Notebook className="w-12 h-12 mb-3 opacity-40" weight="thin" />
        <div className="text-[14px]" style={CUTE_STACK}>这一页 · 还是空白 ♡</div>
        <div className="text-[11px] mt-2 opacity-70 leading-relaxed px-8" style={CUTE_STACK}>
            点下方书签让 AI 替你写一份草稿<br />
            或者按 + 自己写一页
        </div>
    </div>
);

export default HandbookDayView;
