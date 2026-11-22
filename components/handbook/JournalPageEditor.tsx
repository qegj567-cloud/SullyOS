/**
 * 单页操作覆盖层
 *
 * 用户在画布上点了某个 fragment → 弹这个面板:
 *   - 看到该 page 的完整文本(可能含多个 fragment)
 *   - 改写 / 删除整页 / 不入册 / 重新生成(角色页)
 *
 * 注:粒度是 page,不是 fragment。fragment 是 LLM 一次性产出的"碎片",
 *    用户编辑 = 改整页 (改完会清空 fragments,回退到 plain content)。
 */

import React, { useState, useEffect } from 'react';
import { HandbookPage, CharacterProfile } from '../../types';
import {
    PAPER_TONES, SERIF_STACK, CUTE_STACK, MONO_STACK, PAPERS,
} from './paper';
import {
    PencilSimple, Trash, Eye, EyeSlash, ArrowsClockwise,
    FloppyDisk, X,
} from '@phosphor-icons/react';
import TokenImg from '../os/TokenImg';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';

interface Props {
    page: HandbookPage;
    char?: CharacterProfile;
    isRegenerating?: boolean;
    onClose: () => void;
    onSave: (newContent: string, newPaperStyle?: string) => void;
    onToggleExclude: () => void;
    onDelete: () => void | Promise<void>;
    onRegenerate?: () => void | Promise<void>;
}

const PAPER_OPTIONS: { kind: keyof typeof PAPERS; label: string }[] = [
    { kind: 'plain', label: '素' },
    { kind: 'lined', label: '横线' },
    { kind: 'grid', label: '方格' },
    { kind: 'dot', label: '点阵' },
    { kind: 'cream', label: '奶油' },
    { kind: 'mint', label: '薄荷' },
    { kind: 'rose', label: '樱粉' },
    { kind: 'sky', label: '雾蓝' },
];

const JournalPageEditor: React.FC<Props> = ({
    page, char, isRegenerating, onClose, onSave,
    onToggleExclude, onDelete, onRegenerate,
}) => {
    const { requestConfirm, confirmDialog } = useConfirmDialog({ portal: true });
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(page.content);
    const [draftPaper, setDraftPaper] = useState<string>(page.paperStyle || 'plain');

    useEffect(() => {
        setDraft(page.content);
        setDraftPaper(page.paperStyle || 'plain');
    }, [page.id, page.content, page.paperStyle]);

    const titleParts = (() => {
        switch (page.type) {
            case 'user_diary':     return { kicker: 'MY · DIARY',     title: '我 的 一 天' };
            case 'character_life': return { kicker: 'CO · LIFESTREAM', title: char ? `${char.name} · 的 今 天` : '小生活' };
            case 'user_note':      return { kicker: 'NOTE',           title: '便 笺' };
            case 'free':           return { kicker: 'FREE',           title: '便 签' };
        }
    })();

    return (
        <div
            className="absolute inset-0 z-50 flex items-end justify-center"
            style={{ background: 'rgba(122,90,114,0.4)', backdropFilter: 'blur(6px)' }}
            onClick={onClose}
        >
            <div
                className="w-full max-h-[90%] overflow-y-auto rounded-t-3xl relative"
                style={{
                    background: PAPER_TONES.paper,
                    boxShadow: '0 -8px 28px rgba(122,90,114,0.25)',
                }}
                onClick={e => e.stopPropagation()}
            >
                {/* 顶把手 */}
                <div className="flex justify-center pt-3 pb-1">
                    <div style={{ width: 40, height: 4, borderRadius: 2, background: PAPER_TONES.accentRose, opacity: 0.5 }} />
                </div>

                {/* 标题 */}
                <div className="px-5 pt-2 pb-3 flex items-center gap-3">
                    {char?.avatar && (
                        <TokenImg
                            value={char.avatar}
                            alt={char.name}
                            className="rounded-full object-cover shrink-0"
                            style={{ width: 38, height: 38, boxShadow: '0 0 0 2.5px #fff, 0 1px 3px rgba(0,0,0,0.15)' }}
                        />
                    )}
                    <div className="flex-1 min-w-0">
                        <div
                            className="truncate"
                            style={{
                                ...MONO_STACK,
                                fontSize: 9.5,
                                letterSpacing: '0.3em',
                                color: PAPER_TONES.inkSoft,
                            }}
                        >
                            {titleParts.kicker}
                        </div>
                        <div
                            className="truncate"
                            style={{ ...CUTE_STACK, fontSize: 16, fontWeight: 700, color: PAPER_TONES.ink }}
                        >
                            {titleParts.title}
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-8 h-8 flex items-center justify-center rounded-full active:scale-95 transition shrink-0"
                        style={{ background: 'rgba(253,246,231,0.8)', color: PAPER_TONES.ink }}
                    >
                        <X className="w-4 h-4" weight="bold" />
                    </button>
                </div>

                {/* 内容 */}
                <div className="px-5 pb-3">
                    {editing ? (
                        <>
                            <div className="flex items-center gap-1.5 mb-2 overflow-x-auto no-scrollbar">
                                <span
                                    className="text-[10px] tracking-widest shrink-0 mr-1"
                                    style={{ ...CUTE_STACK, color: PAPER_TONES.inkSoft }}
                                >
                                    ◆ 纸
                                </span>
                                {PAPER_OPTIONS.map(opt => {
                                    const p = PAPERS[opt.kind];
                                    const active = draftPaper === opt.kind;
                                    return (
                                        <button
                                            key={opt.kind}
                                            onClick={() => setDraftPaper(opt.kind)}
                                            className="shrink-0 flex flex-col items-center active:scale-95 transition"
                                        >
                                            <div
                                                className="rounded"
                                                style={{
                                                    width: 22, height: 22,
                                                    background: p.bg,
                                                    ...p.style,
                                                    border: active ? `2px solid ${PAPER_TONES.accentLavender}` : `1px solid ${PAPER_TONES.spine}`,
                                                }}
                                            />
                                            <span
                                                className="text-[8px] mt-0.5"
                                                style={{
                                                    ...CUTE_STACK,
                                                    color: active ? PAPER_TONES.accentLavender : PAPER_TONES.inkFaint,
                                                }}
                                            >
                                                {opt.label}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                            <textarea
                                value={draft}
                                onChange={e => setDraft(e.target.value)}
                                autoFocus
                                className="w-full p-3 rounded-lg outline-none resize-none text-[14px] leading-[24px] min-h-[160px]"
                                style={{
                                    ...SERIF_STACK,
                                    color: PAPER_TONES.ink,
                                    background: PAPERS[draftPaper as keyof typeof PAPERS]?.bg ?? '#fff',
                                    ...(PAPERS[draftPaper as keyof typeof PAPERS]?.style ?? {}),
                                    border: `1px solid ${PAPER_TONES.spine}`,
                                }}
                            />
                        </>
                    ) : page.fragments && page.fragments.length > 0 ? (
                        <div className="space-y-2">
                            {page.fragments.map(f => (
                                <div
                                    key={f.id}
                                    className="rounded-lg px-3 py-2.5"
                                    style={{
                                        background: '#fff',
                                        border: `1px solid ${PAPER_TONES.spine}`,
                                    }}
                                >
                                    {f.time && (
                                        <div
                                            className="mb-1"
                                            style={{
                                                ...MONO_STACK,
                                                fontSize: 9,
                                                letterSpacing: '0.2em',
                                                color: PAPER_TONES.inkFaint,
                                            }}
                                        >
                                            {f.time}
                                        </div>
                                    )}
                                    <p
                                        className="whitespace-pre-wrap break-words"
                                        style={{ ...SERIF_STACK, fontSize: 13.5, lineHeight: '23px', color: PAPER_TONES.ink, margin: 0 }}
                                    >
                                        {f.text}
                                    </p>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p
                            className="whitespace-pre-wrap break-words rounded-lg px-3 py-3"
                            style={{
                                ...SERIF_STACK,
                                fontSize: 14,
                                lineHeight: '24px',
                                color: PAPER_TONES.ink,
                                background: '#fff',
                                border: `1px solid ${PAPER_TONES.spine}`,
                            }}
                        >
                            {page.content || (
                                <span style={{ color: PAPER_TONES.inkSoft, fontStyle: 'italic', opacity: 0.6 }}>
                                    这一页还是空白的…
                                </span>
                            )}
                        </p>
                    )}
                </div>

                {/* 操作行 */}
                <div
                    className="sticky bottom-0 px-5 py-3 flex flex-wrap gap-2"
                    style={{
                        background: PAPER_TONES.paper,
                        borderTop: `1.5px solid ${PAPER_TONES.accentRose}`,
                    }}
                >
                    {editing ? (
                        <>
                            <button
                                onClick={() => { setEditing(false); setDraft(page.content); }}
                                className="px-3 py-2 rounded-full text-[12px] active:scale-95 transition flex items-center gap-1"
                                style={{ ...CUTE_STACK, color: PAPER_TONES.inkSoft, background: '#fff', border: `1.5px solid ${PAPER_TONES.spine}` }}
                            >
                                <X className="w-3 h-3" /> 取消
                            </button>
                            <button
                                onClick={() => { onSave(draft, draftPaper); setEditing(false); }}
                                className="flex-1 px-3 py-2 rounded-full text-[12px] font-bold active:scale-95 transition flex items-center justify-center gap-1.5"
                                style={{
                                    ...CUTE_STACK,
                                    background: PAPER_TONES.accentBlush,
                                    color: '#fff',
                                    boxShadow: '0 1px 3px rgba(122,90,114,0.18)',
                                }}
                            >
                                <FloppyDisk className="w-3.5 h-3.5" /> 收下 ♡
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                onClick={() => setEditing(true)}
                                className="flex-1 px-3 py-2 rounded-full text-[12px] active:scale-95 transition flex items-center justify-center gap-1.5"
                                style={{
                                    ...CUTE_STACK, color: '#fff',
                                    background: PAPER_TONES.accentBlush,
                                    boxShadow: '0 1px 3px rgba(122,90,114,0.18)',
                                }}
                            >
                                <PencilSimple className="w-3.5 h-3.5" weight="bold" /> 改写
                            </button>
                            {onRegenerate && (
                                <button
                                    onClick={async () => {
                                        const confirmed = await requestConfirm({
                                            title: '再写一次这一页？',
                                            message: `将重新生成${char ? ` ${char.name}` : '这一页'}的今日手账内容，当前这一页会被替换。`,
                                            confirmText: '再写一次',
                                            variant: 'warning',
                                        });
                                        if (confirmed) void onRegenerate();
                                    }}
                                    disabled={isRegenerating}
                                    className="px-3 py-2 rounded-full text-[12px] active:scale-95 transition disabled:opacity-50 flex items-center gap-1.5"
                                    style={{ ...CUTE_STACK, color: PAPER_TONES.ink, background: '#fff', border: `1.5px solid ${PAPER_TONES.spine}` }}
                                >
                                    <ArrowsClockwise className={`w-3.5 h-3.5 ${isRegenerating ? 'animate-spin' : ''}`} weight="bold" />
                                    {isRegenerating ? '正在写…' : '再写一次'}
                                </button>
                            )}
                            <button
                                onClick={onToggleExclude}
                                className="px-3 py-2 rounded-full text-[12px] active:scale-95 transition flex items-center gap-1.5"
                                style={{ ...CUTE_STACK, color: PAPER_TONES.ink, background: '#fff', border: `1.5px solid ${PAPER_TONES.spine}` }}
                            >
                                {page.excluded
                                    ? <><EyeSlash className="w-3.5 h-3.5" weight="bold" /> 不入册</>
                                    : <><Eye className="w-3.5 h-3.5" weight="bold" /> 入册</>
                                }
                            </button>
                            <button
                                onClick={onDelete}
                                className="px-3 py-2 rounded-full text-[12px] active:scale-95 transition flex items-center gap-1.5"
                                style={{
                                    ...CUTE_STACK, color: '#c4708a',
                                    background: '#fff', border: `1.5px solid #f5d0d8`,
                                }}
                            >
                                <Trash className="w-3.5 h-3.5" weight="bold" /> 撕掉
                            </button>
                        </>
                    )}
                </div>
            </div>
            {confirmDialog}
        </div>
    );
};

export default JournalPageEditor;
