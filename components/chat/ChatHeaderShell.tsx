import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaretLeft, Lightning } from '@phosphor-icons/react';
import { CharacterBuff, CharacterProfile } from '../../types';

interface TokenBreakdown {
    prompt: number;
    completion: number;
    total: number;
    msgCount: number;
    pass: string;
}

interface ChatHeaderShellProps {
    selectionMode: boolean;
    selectedCount: number;
    onCancelSelection: () => void;
    activeCharacter: CharacterProfile;
    isTyping: boolean;
    isSummarizing: boolean;
    isEmotionEvaluating?: boolean;
    lastTokenUsage: number | null;
    tokenBreakdown?: TokenBreakdown | null;
    onClose: () => void;
    onTriggerAI: () => void;
    onShowCharsPanel: () => void;
    onDeleteBuff?: (buffId: string) => void;
    headerStyle?: 'default' | 'minimal' | 'gradient' | 'wechat' | 'telegram' | 'discord' | 'pixel';
    avatarShape?: 'circle' | 'rounded' | 'square';
    headerAlign?: 'left' | 'center';
    headerDensity?: 'compact' | 'default' | 'airy';
    statusStyle?: 'subtle' | 'pill' | 'dot';
    chromeStyle?: 'soft' | 'flat' | 'floating' | 'pixel';
}

const COLLAPSED_BUFF_MIN = 2;
const COLLAPSED_BUFF_MAX = 3;
const CHIP_GAP_PX = 2;

const normalizeIntensity = (n: number | undefined | null): 1 | 2 | 3 => {
    const parsed = Number.isFinite(n) ? Math.round(Number(n)) : 2;
    if (parsed <= 1) return 1;
    if (parsed >= 3) return 3;
    return 2;
};

const intensityDots = (n: number | undefined | null) => {
    const safe = normalizeIntensity(n);
    return '●'.repeat(safe) + '○'.repeat(3 - safe);
};

const ChatHeaderShell: React.FC<ChatHeaderShellProps> = ({
    selectionMode,
    selectedCount,
    onCancelSelection,
    activeCharacter,
    isEmotionEvaluating,
    lastTokenUsage,
    tokenBreakdown,
    onClose,
    onTriggerAI,
    onShowCharsPanel,
    onDeleteBuff,
    headerStyle = 'default',
    avatarShape = 'circle',
    headerAlign = 'left',
    headerDensity = 'default',
    statusStyle = 'subtle',
    chromeStyle = 'soft',
}) => {
    const buffs: CharacterBuff[] = activeCharacter.activeBuffs || [];
    const [openBuff, setOpenBuff] = useState<CharacterBuff | null>(null);
    const [isBuffListExpanded, setIsBuffListExpanded] = useState(false);
    const [confirmDeleteBuff, setConfirmDeleteBuff] = useState<CharacterBuff | null>(null);
    const [collapsedVisibleCount, setCollapsedVisibleCount] = useState(() => Math.min(COLLAPSED_BUFF_MAX, buffs.length));
    const cardRef = useRef<HTMLDivElement>(null);
    const buffPanelRef = useRef<HTMLDivElement>(null);
    const buffPreviewRef = useRef<HTMLDivElement>(null);
    const measureChipRefs = useRef<Array<HTMLSpanElement | null>>([]);
    const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const visibleBuffs = buffs.slice(0, collapsedVisibleCount);
    const hiddenBuffCount = Math.max(0, buffs.length - collapsedVisibleCount);

    const toggleBuff = (buff: CharacterBuff) => {
        setOpenBuff((prev) => (prev?.id === buff.id ? null : buff));
    };

    const handleLongPressStart = (buff: CharacterBuff) => {
        longPressTimerRef.current = setTimeout(() => {
            longPressTimerRef.current = null;
            setConfirmDeleteBuff(buff);
            setOpenBuff(null);
        }, 600);
    };

    const handleLongPressEnd = () => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    };

    const handleConfirmDelete = () => {
        if (confirmDeleteBuff && onDeleteBuff) {
            onDeleteBuff(confirmDeleteBuff.id);
        }
        setConfirmDeleteBuff(null);
    };

    useEffect(() => {
        if (!openBuff && !isBuffListExpanded) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as Node;
            const clickedInsideCard = !!cardRef.current?.contains(target);
            const clickedInsideBuffPanel = !!buffPanelRef.current?.contains(target);
            if (!clickedInsideCard && !clickedInsideBuffPanel) {
                setOpenBuff(null);
                setIsBuffListExpanded(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [openBuff, isBuffListExpanded]);

    useEffect(() => {
        setIsBuffListExpanded(false);
        setOpenBuff(null);
        setCollapsedVisibleCount(Math.min(COLLAPSED_BUFF_MAX, buffs.length));
    }, [activeCharacter.id, buffs.length]);

    useEffect(() => {
        if (buffs.length <= COLLAPSED_BUFF_MIN) {
            setCollapsedVisibleCount(buffs.length);
            return;
        }

        const updateCollapsedCount = () => {
            const previewNode = buffPreviewRef.current;
            const containerWidth = previewNode?.clientWidth ?? 0;
            const candidateCount = Math.min(COLLAPSED_BUFF_MAX, buffs.length);
            const widths = measureChipRefs.current
                .slice(0, candidateCount)
                .map((node) => node?.offsetWidth ?? 0);

            if (!containerWidth || widths.length < candidateCount || widths.some((width) => width <= 0)) {
                return;
            }

            const hiddenChipWidth = buffs.length > candidateCount ? 30 : 0;
            const totalWidth = widths.reduce((sum, width) => sum + width, 0)
                + CHIP_GAP_PX * Math.max(0, widths.length - 1)
                + hiddenChipWidth
                + (hiddenChipWidth > 0 ? CHIP_GAP_PX : 0);
            const liveOverflow = !!previewNode && previewNode.scrollWidth - previewNode.clientWidth > 1;
            const nextCount = candidateCount >= 3 && (totalWidth > containerWidth || liveOverflow) ? COLLAPSED_BUFF_MIN : candidateCount;
            setCollapsedVisibleCount((prev) => (prev === nextCount ? prev : nextCount));
        };

        updateCollapsedCount();

        const resizeObserver = typeof ResizeObserver !== 'undefined' && buffPreviewRef.current
            ? new ResizeObserver(updateCollapsedCount)
            : null;
        if (resizeObserver && buffPreviewRef.current) {
            resizeObserver.observe(buffPreviewRef.current);
        }
        window.addEventListener('resize', updateCollapsedCount);
        return () => {
            resizeObserver?.disconnect();
            window.removeEventListener('resize', updateCollapsedCount);
        };
    }, [activeCharacter.id, buffs]);

    const isDarkHeader = headerStyle === 'discord';
    const isPixelHeader = headerStyle === 'pixel';
    const useCenteredLayout = headerAlign === 'center' || headerStyle === 'telegram' || headerStyle === 'minimal';
    const avatarRadiusClass = avatarShape === 'square' ? 'rounded-sm' : avatarShape === 'rounded' ? 'rounded-xl' : 'rounded-full';

    const headerToneClass =
        headerStyle === 'gradient'
            ? 'bg-gradient-to-r from-primary/20 via-primary/10 to-white/80 backdrop-blur-xl border-b border-slate-200/60 shadow-sm'
            : headerStyle === 'minimal'
              ? 'bg-white/95 backdrop-blur-md border-b border-slate-200/50 shadow-sm'
              : headerStyle === 'wechat'
                ? 'bg-[#f7f7f7]/95 backdrop-blur-md border-b border-black/5 shadow-none'
                : headerStyle === 'telegram'
                  ? 'bg-white/85 backdrop-blur-xl border-b border-sky-100 shadow-sm'
                  : headerStyle === 'discord'
                    ? 'bg-slate-900/95 backdrop-blur-xl border-b border-white/10 shadow-[0_10px_30px_rgba(15,23,42,0.35)]'
                    : headerStyle === 'pixel'
                      ? 'bg-[#c99872] border-b-[3px] border-[#7b5a40] shadow-[0_4px_0_rgba(123,90,64,0.25)]'
                      : chromeStyle === 'flat'
                        ? 'bg-white border-b border-slate-200 shadow-none'
                        : chromeStyle === 'floating'
                          ? 'bg-white/85 backdrop-blur-xl border-b border-white/70 shadow-sm'
                          : 'bg-white/80 backdrop-blur-xl border-b border-slate-200/60 shadow-sm';
    const headerDensityClass = headerDensity === 'compact' ? 'h-20 px-4 pb-3' : headerDensity === 'airy' ? 'h-28 px-6 pb-5' : 'h-24 px-5 pb-4';
    const primaryTextClass = isDarkHeader ? 'text-white' : isPixelHeader ? 'text-[#fff7ed]' : 'text-slate-800';
    const secondaryTextClass = isDarkHeader ? 'text-slate-400' : isPixelHeader ? 'text-[#f3ddc7]' : 'text-slate-400';
    const iconButtonClass = isDarkHeader
        ? 'text-slate-200 hover:bg-white/10 rounded-full'
        : isPixelHeader
          ? 'text-[#fff7ed] hover:bg-[#f8f0e0]/20 rounded-[4px] border-2 border-[#8f674a] bg-[#f8f0e0]/10'
          : 'text-slate-500 hover:bg-slate-100 rounded-full';
    const actionButtonClass = isDarkHeader
        ? 'text-sky-300 hover:bg-sky-400/10 rounded-full'
        : isPixelHeader
          ? 'text-[#fff7ed] hover:bg-[#f8f0e0]/20 rounded-[4px] border-2 border-[#8f674a] bg-[#f8f0e0]/10'
          : 'text-indigo-500 hover:bg-indigo-50 rounded-full';

    const onlineStatusNode =
        statusStyle === 'pill' ? (
            <div className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold border ${isDarkHeader ? 'bg-emerald-500/20 text-emerald-200 border-emerald-400/20' : isPixelHeader ? 'bg-[#fff7ed] text-[#8f674a] border-[#8f674a]/25' : 'bg-emerald-50 text-emerald-500 border-emerald-100'}`}>
                online
            </div>
        ) : statusStyle === 'dot' ? (
            <div className={`flex items-center gap-1 text-[10px] ${secondaryTextClass}`}>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span>Online</span>
            </div>
        ) : (
            <div className={`text-[10px] uppercase ${secondaryTextClass}`}>Online</div>
        );

    const renderBuffRow = (centered: boolean) => {
        if (buffs.length === 0) return null;
        return (
            <div className={`relative w-full min-w-0 max-w-full ${centered ? 'flex justify-center' : ''}`}>
                <div
                    ref={buffPreviewRef}
                    className={`flex w-full min-w-0 max-w-full items-center gap-0.5 overflow-x-auto whitespace-nowrap pr-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${centered ? 'justify-center' : ''}`}
                >
                    {visibleBuffs.map((buff) => (
                        <button
                            key={buff.id}
                            onClick={(e) => { e.stopPropagation(); toggleBuff(buff); }}
                            onTouchStart={(e) => { e.stopPropagation(); handleLongPressStart(buff); }}
                            onTouchEnd={handleLongPressEnd}
                            onTouchCancel={handleLongPressEnd}
                            onMouseDown={(e) => { if (e.button === 0) handleLongPressStart(buff); }}
                            onMouseUp={handleLongPressEnd}
                            onMouseLeave={handleLongPressEnd}
                            className="shrink-0 max-w-[8.75rem] truncate text-[8px] leading-none px-1 py-[3px] rounded-[10px] font-bold border cursor-pointer transition-colors select-none"
                            style={{ color: buff.color || '#db2777', borderColor: `${buff.color || '#db2777'}40`, background: `${buff.color || '#db2777'}10` }}
                            title={buff.label}
                        >
                            {buff.emoji ? `${buff.emoji} ` : ''}
                            {buff.label}
                        </button>
                    ))}
                    {hiddenBuffCount > 0 && (
                        <button
                            onClick={(e) => { e.stopPropagation(); setIsBuffListExpanded((prev) => !prev); }}
                            className="shrink-0 min-w-[22px] text-[8px] leading-none px-1 py-[3px] rounded-[10px] font-bold border border-slate-300 text-slate-500 bg-slate-100/90 hover:bg-slate-200/80 transition-colors"
                            title="查看全部状态"
                        >
                            +{hiddenBuffCount}
                        </button>
                    )}
                </div>

                <div className="pointer-events-none absolute -z-10 h-0 overflow-hidden opacity-0" aria-hidden>
                    <div className="flex items-center gap-0.5 whitespace-nowrap">
                        {buffs.slice(0, Math.min(COLLAPSED_BUFF_MAX, buffs.length)).map((buff, index) => (
                            <span
                                key={`measure-${buff.id}`}
                                ref={(node) => { measureChipRefs.current[index] = node; }}
                                className="inline-flex shrink-0 max-w-[8.75rem] text-[8px] leading-none px-1 py-[3px] rounded-[10px] font-bold border"
                                style={{ color: buff.color || '#db2777', borderColor: `${buff.color || '#db2777'}40`, background: `${buff.color || '#db2777'}10` }}
                            >
                                {buff.emoji ? `${buff.emoji} ` : ''}
                                {buff.label}
                            </span>
                        ))}
                    </div>
                </div>
            </div>
        );
    };

    const floatingStatusNodes = (lastTokenUsage || isEmotionEvaluating) ? (
        <div className="absolute right-12 top-1/2 -translate-y-1/2 flex items-center gap-1.5 pointer-events-none">
            {lastTokenUsage && (
                <div className={`text-[9px] px-1.5 py-0.5 rounded-md font-mono border ${isDarkHeader ? 'bg-slate-800 text-slate-300 border-white/10' : isPixelHeader ? 'bg-[#fff7ed] text-[#8f674a] border-[#8f674a]/20' : 'bg-slate-100/95 text-slate-400 border-slate-200'}`}>
                    {lastTokenUsage}
                </div>
            )}
            {isEmotionEvaluating && (
                <div className={`text-[9px] px-1.5 py-0.5 rounded-md font-semibold border animate-pulse ${isDarkHeader ? 'bg-violet-500/15 text-violet-200 border-violet-400/20' : isPixelHeader ? 'bg-[#fff7ed] text-[#8f674a] border-[#8f674a]/20' : 'bg-violet-50/95 text-violet-500 border-violet-200'}`}>
                    情绪分析中
                </div>
            )}
        </div>
    ) : null;

    const renderCenteredInfo = () => (
        <div className="flex w-full min-w-0 max-w-full flex-col items-center text-center">
            <img src={activeCharacter.avatar} className={`w-10 h-10 object-cover shadow-sm ${avatarRadiusClass}`} alt="avatar" />
            <div className={`mt-1 font-bold ${primaryTextClass}`}>{activeCharacter.name}</div>
            <div className="mt-1 flex items-center justify-center gap-2 flex-wrap">
                {onlineStatusNode}
            </div>
            <div className="mt-1 h-[18px] w-full">
                {renderBuffRow(true)}
            </div>
        </div>
    );

    const renderStandardInfo = () => (
        <>
            <img src={activeCharacter.avatar} className={`w-10 h-10 object-cover shadow-sm ${avatarRadiusClass}`} alt="avatar" />
            <div className="flex-1 min-w-0 flex flex-col items-start text-left">
                <div className={`font-bold ${primaryTextClass}`}>{activeCharacter.name}</div>
                <div className="flex items-center gap-2 flex-wrap">
                    {onlineStatusNode}
                    {lastTokenUsage && (
                        <div className={`text-[9px] px-1.5 py-0.5 rounded-md font-mono border ${isDarkHeader ? 'bg-slate-800 text-slate-300 border-white/10' : isPixelHeader ? 'bg-[#fff7ed] text-[#8f674a] border-[#8f674a]/20' : 'bg-slate-100 text-slate-400 border-slate-200'}`} title={tokenBreakdown ? `prompt: ${tokenBreakdown.prompt} | completion: ${tokenBreakdown.completion} | msgs: ${tokenBreakdown.msgCount} | pass: ${tokenBreakdown.pass}` : ''}>
                            {lastTokenUsage}
                        </div>
                    )}
                    {isEmotionEvaluating && (
                        <div className={`text-[9px] px-1.5 py-0.5 rounded-md font-semibold border animate-pulse ${isDarkHeader ? 'bg-violet-500/15 text-violet-200 border-violet-400/20' : isPixelHeader ? 'bg-[#fff7ed] text-[#8f674a] border-[#8f674a]/20' : 'bg-violet-50 text-violet-500 border-violet-200'}`}>
                            情绪分析中
                        </div>
                    )}
                </div>
                <div className="mt-1 h-[18px] w-full">
                    {renderBuffRow(false)}
                </div>
            </div>
        </>
    );

    return (
        <div className={`${headerDensityClass} flex items-end shrink-0 z-30 sticky top-0 relative ${headerToneClass}`}>
            {selectionMode ? (
                <div className="flex items-center justify-between w-full">
                    <button onClick={onCancelSelection} className={`text-sm font-bold px-2 py-1 ${secondaryTextClass}`}>取消</button>
                    <span className={`text-sm font-bold ${primaryTextClass}`}>已选 {selectedCount} 项</span>
                    <div className="w-10" />
                </div>
            ) : useCenteredLayout ? (
                <div className="relative w-full min-h-[56px]">
                    <button onClick={onClose} className={`absolute left-0 top-1/2 -translate-y-1/2 p-2 ${iconButtonClass}`}>
                        <CaretLeft className="w-5 h-5" weight="bold" />
                    </button>

                    {floatingStatusNodes}

                    <div
                        onClick={onShowCharsPanel}
                        className="absolute left-1/2 top-1/2 flex w-[calc(100%-7rem)] max-w-[420px] -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center"
                    >
                        {renderCenteredInfo()}
                    </div>

                    <button onClick={onTriggerAI} className={`absolute right-0 top-1/2 -translate-y-1/2 p-2 ${actionButtonClass}`} title="触发 AI">
                        <Lightning className="w-5 h-5" weight="bold" />
                    </button>
                </div>
            ) : (
                <div className="flex items-center gap-3 w-full">
                    <button onClick={onClose} className={`p-2 -ml-2 ${iconButtonClass}`}>
                        <CaretLeft className="w-5 h-5" weight="bold" />
                    </button>

                    <div onClick={onShowCharsPanel} className="flex-1 min-w-0 flex items-center gap-3 cursor-pointer">
                        {renderStandardInfo()}
                    </div>

                    <button onClick={onTriggerAI} className={`p-2 ml-auto ${actionButtonClass}`} title="触发 AI">
                        <Lightning className="w-5 h-5" weight="bold" />
                    </button>
                </div>
            )}

            {isBuffListExpanded && hiddenBuffCount > 0 && (
                <div ref={buffPanelRef} className="absolute top-full left-4 right-4 mt-1 bg-white rounded-xl shadow-lg border border-slate-200 p-3 z-40">
                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">全部状态</div>
                    <div className="max-h-36 overflow-y-auto pr-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        <div className="flex flex-wrap gap-1.5">
                            {buffs.map((buff) => (
                                <button
                                    key={`panel-${buff.id}`}
                                    onClick={(e) => { e.stopPropagation(); toggleBuff(buff); }}
                                    onTouchStart={(e) => { e.stopPropagation(); handleLongPressStart(buff); }}
                                    onTouchEnd={handleLongPressEnd}
                                    onTouchCancel={handleLongPressEnd}
                                    onMouseDown={(e) => { if (e.button === 0) handleLongPressStart(buff); }}
                                    onMouseUp={handleLongPressEnd}
                                    onMouseLeave={handleLongPressEnd}
                                    className="text-[10px] px-2 py-1 rounded-lg font-bold border cursor-pointer transition-colors select-none"
                                    style={{ color: buff.color || '#db2777', borderColor: `${buff.color || '#db2777'}40`, background: `${buff.color || '#db2777'}10` }}
                                >
                                    {buff.emoji ? `${buff.emoji} ` : ''}
                                    {buff.label}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {openBuff && (
                <div ref={cardRef} className="absolute top-full left-4 right-4 mt-1 bg-white rounded-xl shadow-lg border border-slate-200 p-3 z-50">
                    <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-bold" style={{ color: openBuff.color || '#db2777' }}>
                                {openBuff.emoji ? `${openBuff.emoji} ` : ''}
                                {openBuff.label}
                            </span>
                            <div className="text-xs font-bold tracking-wide" style={{ color: openBuff.color || '#db2777' }}>
                                {intensityDots(openBuff.intensity)}{' '}
                                {normalizeIntensity(openBuff.intensity) === 1 ? '轻微' : normalizeIntensity(openBuff.intensity) === 2 ? '中等' : '强烈'}
                            </div>
                        </div>
                        <button onClick={() => setOpenBuff(null)} className="text-slate-300 hover:text-slate-500 text-lg leading-none px-1">
                            {'\u00d7'}
                        </button>
                    </div>
                    {openBuff.description ? (
                        <p className="text-sm text-slate-600 leading-relaxed">{openBuff.description}</p>
                    ) : (
                        <p className="text-xs text-slate-400 italic">暂无详情</p>
                    )}
                </div>
            )}

            {confirmDeleteBuff && typeof document !== 'undefined' && createPortal(
                <div className="fixed inset-0 bg-slate-900/45 backdrop-blur-[1px] z-[100]" onClick={() => setConfirmDeleteBuff(null)}>
                    <div className="absolute left-1/2 top-1/2 w-[min(88vw,360px)] -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-white/40 bg-white/95 p-5 shadow-2xl shadow-slate-900/25" onClick={(e) => e.stopPropagation()}>
                        <div className="text-center mb-4">
                            <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-rose-100 to-red-100 text-xl shadow-inner">
                                {confirmDeleteBuff.emoji || '🗑'}
                            </div>
                            <div className="font-bold text-slate-800 text-sm">删除情绪状态</div>
                            <div className="text-xs text-slate-500 mt-1 leading-relaxed">
                                确定要删除“{confirmDeleteBuff.label}”吗？
                                <br />
                                对应的提示也会一起移除。
                            </div>
                        </div>
                        <div className="flex gap-2.5">
                            <button
                                onClick={() => setConfirmDeleteBuff(null)}
                                className="flex-1 py-2.5 text-sm font-semibold text-slate-600 bg-slate-100 rounded-2xl hover:bg-slate-200 transition-colors"
                            >
                                取消
                            </button>
                            <button
                                onClick={handleConfirmDelete}
                                className="flex-1 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-rose-500 to-red-500 rounded-2xl hover:from-rose-600 hover:to-red-600 shadow-lg shadow-red-200/80 transition-all"
                            >
                                删除
                            </button>
                        </div>
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
};

export default ChatHeaderShell;
