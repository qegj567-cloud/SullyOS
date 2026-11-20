
import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CaretLeft, Lightning } from '@phosphor-icons/react';
import { CharacterProfile, CharacterBuff } from '../../types';
import TokenImg from '../os/TokenImg';
import { chatCharacterDisplayName } from '../../utils/characterRemark';

interface TokenBreakdown {
    prompt: number;
    completion: number;
    total: number;
    msgCount: number;
    pass: string;
}

interface ChatHeaderProps {
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

const normalizeIntensity = (n: number | undefined | null): 1 | 2 | 3 => {
    const parsed = Number.isFinite(n) ? Math.round(Number(n)) : 2;
    if (parsed <= 1) return 1;
    if (parsed >= 3) return 3;
    return 2;
};

const INTENSITY_DOTS = (n: number | undefined | null) => {
    const safe = normalizeIntensity(n);
    return '●'.repeat(safe) + '○'.repeat(3 - safe);
};

const ChatHeader: React.FC<ChatHeaderProps> = ({
    selectionMode,
    selectedCount,
    onCancelSelection,
    activeCharacter,
    isTyping,
    isSummarizing,
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
    const cardRef = useRef<HTMLDivElement>(null);
    const buffPanelRef = useRef<HTMLDivElement>(null);
    const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const collapsedBuffCount = 3;
    const visibleBuffs = buffs.slice(0, collapsedBuffCount);
    const hiddenBuffCount = Math.max(0, buffs.length - collapsedBuffCount);

    const toggleBuff = (buff: CharacterBuff) => {
        setOpenBuff(prev => prev?.id === buff.id ? null : buff);
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

    // Close floating panels when clicking outside
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
    }, [activeCharacter.id]);

    const isDarkHeader = headerStyle === 'discord';
    const isPixelHeader = headerStyle === 'pixel';
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
    const titleWrapClass = headerAlign === 'center' ? 'items-center text-center' : 'items-start text-left';
    const statusRowClass = headerAlign === 'center' ? 'justify-center' : '';
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

    return (
        <div className={`${headerDensityClass} flex items-end shrink-0 z-30 sticky top-0 relative ${headerToneClass}`}>
            {selectionMode ? (
                <div className="flex items-center justify-between w-full">
                    <button onClick={onCancelSelection} className="text-sm font-bold text-slate-500 px-2 py-1">取消</button>
                    <span className="text-sm font-bold text-slate-800">已选 {selectedCount} 项</span>
                    <div className="w-10"></div>
                </div>
            ) : (
                <div className="flex items-center gap-3 w-full">
                    <button onClick={onClose} className="p-2 -ml-2 text-slate-500 hover:bg-slate-100 rounded-full">
                        <CaretLeft className="w-5 h-5" weight="bold" />
                    </button>
                    
                    <div onClick={onShowCharsPanel} className="flex-1 min-w-0 flex items-center gap-3 cursor-pointer">
                        <TokenImg value={activeCharacter.avatar} className={`w-10 h-10 object-cover shadow-sm ${avatarShape === 'square' ? 'rounded-sm' : avatarShape === 'circle' ? 'rounded-full' : 'rounded-xl'}`} alt="avatar" />
                        <div className="flex-1 min-w-0">
                            <div className="font-bold text-slate-800 break-words [overflow-wrap:anywhere]">{chatCharacterDisplayName(activeCharacter)}</div>
                            <div className="flex items-center gap-2">
                                <div className="text-[10px] text-slate-400 uppercase">Online</div>
                                {lastTokenUsage && (
                                    <div className="text-[9px] px-1.5 py-0.5 bg-slate-100 text-slate-400 rounded-md font-mono border border-slate-200" title={tokenBreakdown ? `prompt: ${tokenBreakdown.prompt} | completion: ${tokenBreakdown.completion} | msgs: ${tokenBreakdown.msgCount} | pass: ${tokenBreakdown.pass}` : ''}>
                                        {lastTokenUsage}
                                    </div>
                                )}
                                {isEmotionEvaluating && (
                                    <div className="text-[9px] px-1.5 py-0.5 bg-violet-50 text-violet-500 rounded-md font-semibold border border-violet-200 animate-pulse">
                                        情绪分析中…
                                    </div>
                                )}
                            </div>
                            {buffs.length > 0 && (
                                <div className="mt-1 flex items-center gap-1 min-w-0">
                                    <div className="flex items-center gap-1 min-w-0 overflow-x-auto whitespace-nowrap pr-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                                        {visibleBuffs.map(buff => (
                                            <button
                                                key={buff.id}
                                                onClick={(e) => { e.stopPropagation(); toggleBuff(buff); }}
                                                onTouchStart={(e) => { e.stopPropagation(); handleLongPressStart(buff); }}
                                                onTouchEnd={handleLongPressEnd}
                                                onTouchCancel={handleLongPressEnd}
                                                onMouseDown={(e) => { if (e.button === 0) handleLongPressStart(buff); }}
                                                onMouseUp={handleLongPressEnd}
                                                onMouseLeave={handleLongPressEnd}
                                                className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-md font-bold border cursor-pointer transition-colors select-none"
                                                style={{ color: buff.color || '#db2777', borderColor: `${buff.color || '#db2777'}40`, background: `${buff.color || '#db2777'}10` }}
                                            >
                                                {buff.emoji ? `${buff.emoji} ` : ''}
                                                {buff.label}
                                            </button>
                                        ))}
                                    </div>
                                    {buffs.length > 3 && (
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setIsBuffListExpanded(prev => !prev); }}
                                            className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-md font-bold border border-slate-300 text-slate-500 bg-slate-100/80 hover:bg-slate-200/70 transition-colors"
                                        >
                                            {isBuffListExpanded ? '收起' : `展开 +${hiddenBuffCount}`}
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    <button data-guide="generate" onClick={onTriggerAI} className="p-2 text-indigo-500 hover:bg-indigo-50 rounded-full ml-auto" title="触发AI">
                        <Lightning className="w-5 h-5" weight="bold" />
                    </button>
                </div>
            )}

            {/* Buff list panel */}
            {isBuffListExpanded && buffs.length > collapsedBuffCount && (
                <div ref={buffPanelRef} className="absolute top-full left-4 right-4 mt-1 bg-white text-slate-800 rounded-xl shadow-lg border border-slate-200 p-3 z-40">
                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">全部状态</div>
                    <div className="max-h-36 overflow-y-auto pr-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        <div className="flex flex-wrap gap-1.5">
                            {buffs.map(buff => (
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

            {/* Buff detail card */}
            {openBuff && (
                <div ref={cardRef} className="absolute top-full left-4 right-4 mt-1 bg-white text-slate-800 rounded-xl shadow-lg border border-slate-200 p-3 z-50">
                    <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-bold" style={{ color: openBuff.color || '#db2777' }}>
                                {openBuff.emoji ? `${openBuff.emoji} ` : ''}
                                {openBuff.label}
                            </span>
                            <div className="text-xs font-bold tracking-wide" style={{ color: openBuff.color || '#db2777' }}>
                                {INTENSITY_DOTS(openBuff.intensity)}{' '}
                                {normalizeIntensity(openBuff.intensity) === 1 ? '轻微' : normalizeIntensity(openBuff.intensity) === 2 ? '中等' : '强烈'}
                            </div>
                        </div>
                        <button onClick={() => setOpenBuff(null)} className="text-slate-300 hover:text-slate-500 text-lg leading-none px-1">{'\u00d7'}</button>
                    </div>
                    {openBuff.description ? (
                        <p className="text-sm text-slate-600 leading-relaxed">{openBuff.description}</p>
                    ) : (
                        <p className="text-xs text-slate-400 italic">暂无详情</p>
                    )}
                </div>
            )}

            {/* Delete confirmation dialog */}
            {confirmDeleteBuff && typeof document !== 'undefined' && createPortal(
                <div className="fixed inset-0 bg-slate-900/45 backdrop-blur-[1px] z-[100]" onClick={() => setConfirmDeleteBuff(null)}>
                    <div className="absolute left-1/2 top-1/2 w-[min(88vw,360px)] -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-white/40 bg-white/95 text-slate-800 p-5 shadow-2xl shadow-slate-900/25" onClick={e => e.stopPropagation()}>
                        <div className="text-center mb-4">
                            <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-rose-100 to-red-100 text-xl shadow-inner">
                                {confirmDeleteBuff.emoji || '🗑️'}
                            </div>
                            <div className="font-bold text-slate-800 text-sm">删除情绪状态</div>
                            <div className="text-xs text-slate-500 mt-1 leading-relaxed">
                                确定要删除「{confirmDeleteBuff.label}」吗？<br />
                                对应的情绪提示词也会一并移除。
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
                document.body
            )}
        </div>
    );
};

export default ChatHeader;
