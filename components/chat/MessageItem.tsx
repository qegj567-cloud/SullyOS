


import React, { useRef, useState } from 'react';
import { Message, ChatTheme } from '../../types';
import { tryParseLifeSimResetCard } from '../../utils/lifeSimChatCard';

// --- Forward Card with expand/collapse ---
const ForwardCard: React.FC<{
    forwardData: any;
    commonLayout: (content: React.ReactNode) => JSX.Element;
    interactionProps: any;
    selectionMode: boolean;
}> = ({ forwardData, commonLayout, selectionMode }) => {
    const [expanded, setExpanded] = useState(false);

    const handleCardClick = (e: React.MouseEvent) => {
        if (selectionMode) return;
        e.stopPropagation();
        setExpanded(true);
    };

    const formatTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

    return (
        <>
            {commonLayout(
                <div className="w-64 bg-white rounded-2xl overflow-hidden shadow-sm border border-slate-100 active:scale-[0.98] transition-transform cursor-pointer" onClick={handleCardClick}>
                    <div className="px-4 pt-3 pb-2 border-b border-slate-50">
                        <div className="flex items-center gap-2 text-xs font-bold text-slate-700">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 text-primary"><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg>
                            {forwardData.fromUserName} 和 {forwardData.fromCharName} 的聊天记录
                        </div>
                    </div>
                    <div className="px-4 py-2 space-y-1">
                        {(forwardData.preview || []).slice(0, 4).map((line: string, i: number) => (
                            <div key={i} className="text-[11px] text-slate-500 truncate leading-relaxed">{line}</div>
                        ))}
                    </div>
                    <div className="px-4 py-2 border-t border-slate-50 text-[10px] text-slate-400 flex items-center justify-between">
                        <span>共 {forwardData.count || 0} 条聊天记录</span>
                        <span className="text-primary font-medium">点击查看</span>
                    </div>
                </div>
            )}

            {/* Expanded Full-screen Overlay */}
            {expanded && (
                <div className="fixed inset-0 z-[100] bg-slate-50 flex flex-col animate-fade-in" onClick={(e) => e.stopPropagation()}>
                    {/* Header */}
                    <div className="pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3 px-4 bg-white border-b border-slate-100 shrink-0 flex items-center gap-3">
                        <button onClick={() => setExpanded(false)} className="p-2 -ml-2 rounded-full hover:bg-slate-100 text-slate-600">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                        </button>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-bold text-slate-700 truncate">{forwardData.fromUserName} 和 {forwardData.fromCharName} 的聊天记录</div>
                            <div className="text-[10px] text-slate-400">共 {forwardData.count || 0} 条消息</div>
                        </div>
                    </div>

                    {/* Messages List */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-3">
                        {(forwardData.messages || []).map((msg: any, i: number) => {
                            const isUser = msg.role === 'user';
                            const senderName = isUser ? forwardData.fromUserName : forwardData.fromCharName;
                            return (
                                <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`max-w-[80%] ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
                                        <div className="text-[10px] text-slate-400 mb-1 px-1">{senderName} {msg.timestamp ? formatTime(msg.timestamp) : ''}</div>
                                        <div className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-all ${isUser ? 'bg-primary text-white rounded-br-sm' : 'bg-white text-slate-700 rounded-bl-sm shadow-sm border border-slate-100'}`}>
                                            {msg.type === 'image' ? <img src={msg.content} className="max-w-[200px] rounded-xl" /> :
                                             msg.type === 'emoji' ? <img src={msg.content} className="max-w-[100px]" /> :
                                             msg.content}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </>
    );
};

const LifeSimResetCardView: React.FC<{ card: any }> = ({ card }) => {
    const parsed = tryParseLifeSimResetCard(card);
    if (!parsed) return null;

    return (
        <div
            className="w-72 overflow-hidden"
            style={{
                border: '2px solid #8f674a',
                borderRadius: 2,
                background: '#f4ede6',
                boxShadow: '4px 4px 0 rgba(105, 74, 52, 0.28), inset 0 0 0 1px rgba(255,255,255,0.35)',
            }}
        >
            <div
                className="px-3 py-2 flex items-center gap-2"
                style={{
                    borderBottom: '2px solid rgba(96,65,44,0.22)',
                    background: 'linear-gradient(180deg, #c99872, #9a6f52)',
                }}
            >
                {parsed.charAvatar ? (
                    <img src={parsed.charAvatar} className="w-8 h-8 object-cover shrink-0" style={{ borderRadius: 2, border: '2px solid rgba(255,255,255,0.25)' }} />
                ) : (
                    <div className="w-8 h-8 flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ borderRadius: 2, background: 'linear-gradient(135deg, #b86c3d, #d39b62)' }}>
                        {parsed.charName?.[0] || '?'}
                    </div>
                )}
                <div className="flex-1 min-w-0">
                    <div className="text-[8px] font-bold tracking-widest uppercase" style={{ color: 'rgba(255,255,255,0.78)', fontFamily: 'monospace' }}>
                        city-summary.exe
                    </div>
                    <div className="text-[11px] font-bold truncate" style={{ color: 'white' }}>
                        {parsed.headline || parsed.title}
                    </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: '#fbbf24', border: '1px solid rgba(0,0,0,0.12)' }} />
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: '#86efac', border: '1px solid rgba(0,0,0,0.12)' }} />
                </div>
            </div>

            <div
                className="px-3 py-3"
                style={{
                    backgroundImage: 'linear-gradient(rgba(143,103,74,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(143,103,74,0.06) 1px, transparent 1px)',
                    backgroundSize: '8px 8px',
                }}
            >
                <div className="flex items-center justify-between text-[9px] font-bold mb-2" style={{ color: '#8f7968', fontFamily: 'monospace' }}>
                    <span>{parsed.charName}</span>
                    <span>主线 {parsed.mainPlotCount}</span>
                </div>
                <div
                    className="px-3 py-2.5"
                    style={{
                        borderRadius: 2,
                        background: 'rgba(255,255,255,0.82)',
                        border: '2px solid rgba(168,123,91,0.3)',
                        boxShadow: 'inset 1px 1px 0 rgba(255,255,255,0.6)',
                    }}
                >
                    <div className="text-[11px] leading-relaxed whitespace-pre-wrap" style={{ color: '#5b4c42' }}>
                        {parsed.summary}
                    </div>
                </div>

                <div className="mt-3 retro-inset px-2.5 py-2" style={{ borderRadius: 2 }}>
                    <div className="flex items-center justify-between text-[9px] font-bold" style={{ color: '#8f7968', fontFamily: 'monospace' }}>
                        <span>参与者 {parsed.participantNames.length}</span>
                        <span>回合 {parsed.turnCount}</span>
                    </div>
                    <div className="mt-1 text-[9px] leading-relaxed" style={{ color: '#9b8677' }}>
                        {parsed.participantNames.join('、') || '无参与角色'}
                    </div>
                </div>
            </div>

            <div
                className="px-3 py-1.5 flex items-center justify-between"
                style={{
                    borderTop: '2px solid rgba(143,103,74,0.18)',
                    background: 'linear-gradient(180deg, #eadfce, #dfd0bd)',
                    fontFamily: 'monospace',
                    fontSize: 9,
                    color: '#836b5b',
                }}
            >
                <span>memory://lifesim/session-card</span>
                <span>OK</span>
            </div>
        </div>
    );
};

interface MessageItemProps {
    msg: Message;
    isFirstInGroup: boolean;
    isLastInGroup: boolean;
    activeTheme: ChatTheme;
    charAvatar: string;
    charName: string;
    userAvatar: string;
    onLongPress: (m: Message) => void;
    selectionMode: boolean;
    isSelected: boolean;
    onToggleSelect: (id: number) => void;
    // Translation (AI messages only, bilingual content parsed from %%BILINGUAL%%)
    translationEnabled?: boolean;
    isShowingTarget?: boolean;
    onTranslateToggle?: (msgId: number) => void;
    // Voice TTS
    voiceData?: { url: string; originalText: string; spokenText?: string; lang?: string };
    voiceLoading?: boolean;
    isVoicePlaying?: boolean;
    onPlayVoice?: () => void;
    // Chat layout customization
    avatarShape?: 'circle' | 'rounded' | 'square';
    avatarSize?: 'small' | 'medium' | 'large';
    avatarMode?: 'grouped' | 'every_message';
    bubbleVariant?: 'modern' | 'flat' | 'outline' | 'shadow' | 'wechat' | 'ios';
    messageSpacing?: 'compact' | 'default' | 'spacious';
    showTimestamp?: 'always' | 'hover' | 'never';
}

const MessageItem = React.memo(({
    msg: m,
    isFirstInGroup,
    isLastInGroup,
    activeTheme,
    charAvatar,
    charName,
    userAvatar,
    onLongPress,
    selectionMode,
    isSelected,
    onToggleSelect,
    translationEnabled,
    isShowingTarget,
    onTranslateToggle,
    voiceData,
    voiceLoading,
    isVoicePlaying,
    onPlayVoice,
    avatarShape = 'circle',
    avatarSize = 'medium',
    avatarMode = 'grouped',
    bubbleVariant = 'modern',
    messageSpacing = 'default',
    showTimestamp = 'hover',
}: MessageItemProps) => {
    const isUser = m.role === 'user';
    const isSystem = m.role === 'system';
    const spacingClass = messageSpacing === 'compact' ? (isLastInGroup ? 'mb-3' : 'mb-0.5') : messageSpacing === 'spacious' ? (isLastInGroup ? 'mb-8' : 'mb-2.5') : (isLastInGroup ? 'mb-6' : 'mb-1.5');
    const marginBottom = spacingClass;
    const avatarSizeClass = avatarSize === 'small' ? 'w-7 h-7' : avatarSize === 'large' ? 'w-12 h-12' : 'w-9 h-9';
    const avatarRadiusClass = avatarShape === 'square' ? 'rounded-sm' : avatarShape === 'rounded' ? 'rounded-xl' : 'rounded-full';
    const avatarSizePx = avatarSize === 'small' ? 28 : avatarSize === 'large' ? 48 : 36;
    const shouldShowAvatar = avatarMode === 'every_message' || isLastInGroup;
    const effectiveShowTimestamp = m.metadata?.source === 'active_msg_2' ? 'always' : showTimestamp;
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startPos = useRef({ x: 0, y: 0 }); // Track touch start position

    const styleConfig = isUser ? activeTheme.user : activeTheme.ai;
    const [showVoiceText, setShowVoiceText] = useState(false);

    const handleTouchStart = (e: React.TouchEvent | React.MouseEvent) => {
        // Record initial position
        if ('touches' in e) {
            startPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        } else {
            startPos.current = { x: e.clientX, y: e.clientY };
        }
        
        longPressTimer.current = setTimeout(() => {
            if (!selectionMode) {
                onLongPress(m);
            }
        }, 600);
    };

    const handleTouchEnd = () => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    };

    // New handler to cancel long press if user drags/scrolls
    const handleMove = (e: React.TouchEvent | React.MouseEvent) => {
        if (!longPressTimer.current) return;

        let clientX, clientY;
        if ('touches' in e) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }

        const diffX = Math.abs(clientX - startPos.current.x);
        const diffY = Math.abs(clientY - startPos.current.y);

        // If moved more than 10px, assume scrolling and cancel long press
        if (diffX > 10 || diffY > 10) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    };

    const handleClick = (e: React.MouseEvent) => {
        if (selectionMode) {
            e.stopPropagation();
            e.preventDefault();
            onToggleSelect(m.id);
        }
    };

    const interactionProps = {
        onMouseDown: handleTouchStart,
        onMouseUp: handleTouchEnd,
        onMouseLeave: handleTouchEnd,
        onMouseMove: handleMove,
        onTouchStart: handleTouchStart,
        onTouchEnd: handleTouchEnd,
        onTouchMove: handleMove,
        onTouchCancel: handleTouchEnd, // Handle system interruptions
        onContextMenu: (e: React.MouseEvent) => {
            e.preventDefault();
            if (!selectionMode) onLongPress(m);
        },
        onClick: handleClick
    };

    const formatTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

    // Render Avatar with potential decoration/frame
    // Removed mb-5 from here, handled via absolute positioning in parent
    const renderAvatar = (src: string) => (
        <div className={`relative ${avatarSizeClass} z-0`}>
            {shouldShowAvatar && (
                <>
                    <img
                        src={src}
                        className={`w-full h-full ${avatarRadiusClass} object-cover shadow-sm ring-1 ring-black/5 relative z-0`}
                        alt="avatar"
                        loading="lazy"
                        decoding="async"
                    />
                    {styleConfig.avatarDecoration && (
                        <img
                            src={styleConfig.avatarDecoration}
                            className="absolute pointer-events-none z-10 max-w-none"
                            style={{
                                left: `${styleConfig.avatarDecorationX ?? 50}%`,
                                top: `${styleConfig.avatarDecorationY ?? 50}%`,
                                width: `${avatarSizePx * (styleConfig.avatarDecorationScale ?? 1)}px`,
                                height: 'auto',
                                transform: `translate(-50%, -50%) rotate(${styleConfig.avatarDecorationRotate ?? 0}deg)`,
                            }}
                        />
                    )}
                </>
            )}
        </div>
    );

    // --- SYSTEM MESSAGE RENDERING ---
    if (isSystem) {
        const isCallSummary = m.metadata?.source === 'call-end-popup';

        // Guidebook end card — rendered as pretty card, not ugly system pill
        if (m.type === 'score_card') {
            let scoreData: any = null;
            try { scoreData = m.metadata?.scoreCard || JSON.parse(m.content); } catch {}
            if (scoreData?.type === 'lifesim_reset_card') {
                return (
                    <div className={`flex items-center w-full ${selectionMode ? 'pl-8' : ''} animate-fade-in relative transition-[padding] duration-300`}>
                        {selectionMode && (
                            <div className="absolute left-2 top-1/2 -translate-y-1/2 cursor-pointer z-20" onClick={() => onToggleSelect(m.id)}>
                                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-slate-300 bg-white/80'}`}>
                                    {isSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                                </div>
                            </div>
                        )}
                        <div className="w-full px-4 my-3" {...interactionProps}>
                            <div className="mx-auto w-72">
                                <LifeSimResetCardView card={scoreData} />
                            </div>
                        </div>
                    </div>
                );
            }
            if (scoreData?.type === 'guidebook_card') {
                const diff = (scoreData.finalAffinity ?? 0) - (scoreData.initialAffinity ?? 0);
                const isPositive = diff > 0;
                return (
                    <div className={`flex items-center w-full ${selectionMode ? 'pl-8' : ''} animate-fade-in relative transition-[padding] duration-300`}>
                        {selectionMode && (
                            <div className="absolute left-2 top-1/2 -translate-y-1/2 cursor-pointer z-20" onClick={() => onToggleSelect(m.id)}>
                                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-slate-300 bg-white/80'}`}>
                                    {isSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                                </div>
                            </div>
                        )}
                        <div className="w-full px-4 my-3" {...interactionProps}>
                            <div className="w-72 mx-auto rounded-2xl overflow-hidden shadow-md" style={{ border: '1.5px solid rgba(200,185,190,0.4)', background: 'linear-gradient(180deg, #f0ebe8 0%, #fff 25%, #ece6e9 100%)' }}>
                                {/* Header */}
                                <div className="px-4 pt-3 pb-2 flex items-center gap-2.5" style={{ borderBottom: '1px solid rgba(200,185,190,0.2)', background: 'linear-gradient(135deg, rgba(200,185,190,0.2), rgba(190,175,195,0.15))' }}>
                                    {scoreData.charAvatar ? (
                                        <img src={scoreData.charAvatar} className="w-9 h-9 rounded-xl object-cover shadow-sm shrink-0" style={{ boxShadow: '0 0 0 2px rgba(180,165,170,0.4)' }} />
                                    ) : (
                                        <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ background: 'linear-gradient(135deg, #b8909a, #a07880)' }}>{scoreData.charName?.[0] || '?'}</div>
                                    )}
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[9px] font-bold tracking-widest uppercase" style={{ color: '#9b8a8e' }}>攻略本 · 结算报告</div>
                                        <div className="text-xs font-bold truncate" style={{ color: '#5a4a50' }}>「{scoreData.title}」</div>
                                    </div>
                                    <div className={`text-lg font-black shrink-0 ${isPositive ? 'text-emerald-500' : diff < 0 ? 'text-red-400' : 'text-slate-400'}`}>
                                        {isPositive ? '+' : ''}{diff}
                                    </div>
                                </div>
                                {/* Body */}
                                <div className="px-4 py-3 space-y-2.5">
                                    <div className="flex items-center gap-2">
                                        <span className="text-[9px] font-bold shrink-0" style={{ color: '#9b8a8e' }}>好感度</span>
                                        <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(230,220,225,0.6)' }}>
                                            <div className="h-full rounded-full" style={{ width: `${Math.min(Math.max((scoreData.finalAffinity + 100) / 200 * 100, 2), 100)}%`, background: isPositive ? 'linear-gradient(90deg, #c9b1bd, #b8909a)' : 'linear-gradient(90deg, #c8a0a8, #b87880)' }} />
                                        </div>
                                        <span className="text-[9px] font-mono font-bold shrink-0" style={{ color: '#8b7a7e' }}>{scoreData.finalAffinity}</span>
                                    </div>
                                    {scoreData.charVerdict && (
                                        <div className="text-xs leading-relaxed italic" style={{ color: '#5a4a50' }}>"{scoreData.charVerdict}"</div>
                                    )}
                                    {scoreData.charNewInsight && (
                                        <div className="rounded-xl px-3 py-2" style={{ background: 'linear-gradient(135deg, rgba(215,230,248,0.6), rgba(200,220,245,0.45))', border: '1px solid rgba(150,185,225,0.35)' }}>
                                            <div className="text-[9px] font-bold mb-1" style={{ color: '#4a6a92' }}>◆ 这局游戏让我发现的你</div>
                                            <div className="text-xs leading-relaxed italic" style={{ color: '#2a4a68' }}>{scoreData.charNewInsight}</div>
                                        </div>
                                    )}
                                    <div className="flex items-center justify-between pt-1" style={{ borderTop: '1px solid rgba(200,185,190,0.15)' }}>
                                        <span className="text-[9px]" style={{ color: '#c0b0b5' }}>{scoreData.rounds} 回合</span>
                                        <span className="text-[9px] font-bold" style={{ color: '#9b8a8e' }}>攻略本 ♥</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                );
            }
        }

        // Clean up text: remove [System:] or [系统:] prefix for display
        const displayText = m.content.replace(/^\[(System|系统|System Log|系统记录)\s*[:：]?\s*/i, '').replace(/\]$/, '').trim();

        if (isCallSummary) {
            const durationSec = Math.max(1, Number(m.metadata?.durationSec || 0));
            const turnCount = Math.max(1, Number(m.metadata?.turnCount || 1));
            const durationText = `${String(Math.floor(durationSec / 60)).padStart(2, '0')}:${String(durationSec % 60).padStart(2, '0')}`;
            const callMemo = String(m.metadata?.keepsakeLine || `“今天这通电话，我会记很久。” —— ${m.metadata?.characterName || charName}`);
            const memoTitle = m.metadata?.characterName || charName;
            const memoAvatar = m.metadata?.characterAvatar || charAvatar;
            const timeHint = durationSec <= 240 ? '差不多是一杯咖啡的时间' : '像听完一首喜欢的歌再多一点';

            return (
                <div className={`flex items-center w-full ${selectionMode ? 'pl-8' : ''} animate-fade-in relative transition-[padding] duration-300`}>
                    {selectionMode && (
                        <div className="absolute left-2 top-1/2 -translate-y-1/2 cursor-pointer z-20" onClick={() => onToggleSelect(m.id)}>
                            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-slate-300 bg-white/80'}`}>
                                {isSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                            </div>
                        </div>
                    )}
                    <div className="w-full px-5 my-3" {...interactionProps}>
                        <div className="rounded-3xl bg-gradient-to-br from-slate-50 to-slate-100/80 border border-slate-200/50 p-4 shadow-sm">
                            <div className="flex items-center gap-3">
                                <img src={memoAvatar} alt={memoTitle} className="h-9 w-9 rounded-full object-cover ring-1 ring-slate-200/80" loading="lazy" decoding="async" />
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium text-slate-600 truncate">和 {memoTitle} 通了电话</div>
                                    <div className="text-xs text-slate-400 mt-0.5">{durationText} · {turnCount}轮对话</div>
                                </div>
                            </div>
                            <div className="mt-3 rounded-2xl bg-white/70 border border-slate-100 px-3.5 py-2.5 text-[13px] italic leading-relaxed text-slate-500">
                                {callMemo}
                            </div>
                        </div>
                    </div>
                </div>
            );
        }

        return (
            <div className={`flex items-center w-full ${selectionMode ? 'pl-8' : ''} animate-fade-in relative transition-[padding] duration-300`}>
                {selectionMode && (
                    <div className="absolute left-2 top-1/2 -translate-y-1/2 cursor-pointer z-20" onClick={() => onToggleSelect(m.id)}>
                        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-slate-300 bg-white/80'}`}>
                            {isSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                        </div>
                    </div>
                )}
                <div className="flex justify-center my-6 px-10 w-full" {...interactionProps}>
                    <div className="flex items-center gap-1.5 bg-slate-200/40 backdrop-blur-md text-slate-500 px-3 py-1 rounded-full shadow-sm border border-white/20 select-none cursor-pointer active:scale-95 transition-transform">
                        {/* Optional Icon based on content */}
                        <img src={displayText.includes('任务') ? 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2728.png' :
                        displayText.includes('纪念日') || displayText.includes('Event') ? 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4c5.png' :
                        displayText.includes('转账') ? 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4b0.png' : 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f514.png'} alt="" className="w-4 h-4" />
                        <span className="text-[10px] font-medium tracking-wide">{displayText}</span>
                    </div>
                </div>
            </div>
        );
    }

    if (m.type === 'interaction') {
        return (
            <div className={`flex flex-col items-center ${marginBottom} w-full animate-fade-in relative transition-[padding] duration-300 ${selectionMode ? 'pl-8' : ''}`}>
                {selectionMode && (
                    <div className="absolute left-2 top-1/2 -translate-y-1/2 cursor-pointer z-20" onClick={() => onToggleSelect(m.id)}>
                        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-slate-300 bg-white/80'}`}>
                            {isSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                        </div>
                    </div>
                )}
                <div className="text-[10px] text-slate-400 mb-1 opacity-70">{formatTime(m.timestamp)}</div>
                <div className="group relative cursor-pointer active:scale-95 transition-transform" {...interactionProps}>
                        <div className="text-[11px] text-slate-500 bg-slate-200/50 backdrop-blur-sm px-4 py-1.5 rounded-full flex items-center gap-1.5 border border-white/40 shadow-sm select-none">
                        <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f449.png" alt="poke" className="w-4 h-4 group-hover:animate-bounce" />
                        <span className="font-medium opacity-80">{isUser ? '你' : charName}</span>
                        <span className="opacity-60">戳了戳</span>
                        <span className="font-medium opacity-80">{isUser ? charName : '你'}</span>
                    </div>
                </div>
            </div>
        );
    }

    const commonLayout = (content: React.ReactNode) => (
            <div className={`flex items-end ${isUser ? 'justify-end' : 'justify-start'} ${marginBottom} px-3 group select-none relative transition-[padding] duration-300 ${selectionMode ? 'pl-12' : ''}`}>
                {selectionMode && (
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 cursor-pointer z-20" onClick={() => onToggleSelect(m.id)}>
                        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-slate-300 bg-white/80'}`}>
                            {isSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                        </div>
                    </div>
                )}

                {/* Avatar - Absolute Positioned */}
                {!isUser && (
                    <div className={`absolute bottom-[1.25rem] z-0 ${selectionMode ? 'left-14' : 'left-3'} transition-all duration-300`}>
                        {renderAvatar(charAvatar)}
                    </div>
                )}
                
                {/* 
                    UPDATED: Limit bubble max-width to 72% for better spacing. 
                    Added min-w-0 to prevent flexbox overflow issues.
                    Added explicit margins to clear absolute avatars.
                */}
                <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} max-w-[72%] min-w-0 ${!isUser ? 'ml-12' : 'mr-12'}`} {...interactionProps}>
                    <div className={selectionMode ? 'pointer-events-none' : ''}>
                        {content}
                    </div>
                    {isLastInGroup && effectiveShowTimestamp !== 'never' && (
                        <div className={`text-[9px] text-slate-400/80 px-1 mt-1 font-medium ${effectiveShowTimestamp === 'hover' ? 'opacity-0 group-hover:opacity-100 transition-opacity' : ''}`}>{formatTime(m.timestamp)}</div>
                    )}
                </div>

                {/* User Avatar - Absolute Positioned */}
                {isUser && (
                    <div className="absolute right-3 bottom-[1.25rem] z-0">
                        {renderAvatar(userAvatar)}
                    </div>
                )}
            </div>
    );

    // [New] Social Card Rendering
    // --- Chat Forward Card ---
    if (m.type === 'chat_forward') {
        let forwardData: any = null;
        try { forwardData = JSON.parse(m.content); } catch {}
        if (forwardData) {
            return <ForwardCard forwardData={forwardData} commonLayout={commonLayout} interactionProps={interactionProps} selectionMode={selectionMode} />;
        }
    }

    // --- XHS Card Rendering (小红书笔记卡片) ---
    if (m.type === 'xhs_card' && m.metadata?.xhsNote) {
        const note = m.metadata.xhsNote;
        return commonLayout(
            <div className="w-64 bg-white rounded-xl overflow-hidden shadow-sm border border-slate-100 cursor-pointer active:opacity-90 transition-opacity">
                {/* Cover image */}
                {note.coverUrl ? (
                    <div className="relative w-full h-36 bg-slate-100 overflow-hidden">
                        <img
                            src={note.coverUrl}
                            alt=""
                            className="w-full h-full object-cover"
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            crossOrigin="anonymous"
                            onError={(e: any) => {
                                // 图片加载失败时显示占位图（保持卡片高度）
                                const img = e.target;
                                const container = img.parentElement;
                                if (!container) return;
                                img.style.display = 'none';
                                // 避免重复插入占位
                                if (container.querySelector('.xhs-cover-fallback')) return;
                                const fallback = document.createElement('div');
                                fallback.className = 'xhs-cover-fallback w-full h-full bg-gradient-to-br from-red-50 to-pink-100 flex items-center justify-center';
                                fallback.innerHTML = `<div class="text-center"><div class="mb-1"><img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4d5.png" alt="" class="w-6 h-6 mx-auto" /></div><div class="text-[10px] text-red-300 font-medium">${note.title ? '封面加载失败' : '小红书笔记'}</div></div>`;
                                container.appendChild(fallback);
                            }}
                        />
                        {note.type === 'video' && (
                            <div className="absolute top-2 right-2 bg-black/50 rounded-full px-1.5 py-0.5 flex items-center gap-0.5">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-white"><path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" /></svg>
                                <span className="text-[9px] text-white font-medium">视频</span>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="h-14 bg-gradient-to-r from-red-400 to-pink-500 flex items-center justify-center">
                        <span className="text-white/80 text-xs font-medium tracking-wide">小红书笔记</span>
                    </div>
                )}
                <div className="p-3">
                    {/* Title */}
                    <div className="font-bold text-sm text-slate-800 line-clamp-2 leading-snug mb-1.5">{note.title || '无标题笔记'}</div>
                    {/* Description */}
                    {note.desc && <p className="text-xs text-slate-500 line-clamp-3 leading-relaxed mb-2">{note.desc}</p>}
                    {/* Author + Likes */}
                    <div className="flex items-center justify-between pt-2 border-t border-slate-50">
                        <div className="flex items-center gap-1.5">
                            <div className="w-4 h-4 rounded-full bg-gradient-to-br from-red-400 to-pink-400 flex items-center justify-center text-[8px] text-white font-bold">{(note.author || '?')[0]}</div>
                            <span className="text-[10px] text-slate-500 truncate max-w-[100px]">{note.author || '小红书用户'}</span>
                        </div>
                        <div className="flex items-center gap-1 text-[10px] text-slate-400">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-red-300"><path d="m9.653 16.915-.005-.003-.019-.01a20.759 20.759 0 0 1-1.162-.682 22.045 22.045 0 0 1-2.582-1.9C4.045 12.733 2 10.352 2 7.5a4.5 4.5 0 0 1 8-2.828A4.5 4.5 0 0 1 18 7.5c0 2.852-2.044 5.233-3.885 6.82a22.049 22.049 0 0 1-3.744 2.582l-.019.01-.005.003h-.002a.723.723 0 0 1-.692 0l-.003-.002Z" /></svg>
                            <span>{note.likes || 0}</span>
                        </div>
                    </div>
                    {/* Footer label */}
                    <div className="mt-2 pt-1.5 flex items-center gap-1 text-[9px] text-slate-300">
                        <span className="text-red-400 font-bold">小红书</span> <span>·</span> <span>{note.type === 'video' ? '视频' : '笔记'}{isUser ? '分享' : '推荐'}</span>
                    </div>
                </div>
            </div>
        );
    }

    if (m.type === 'social_card' && m.metadata?.post) {
        const post = m.metadata.post;
        return commonLayout(
            <div className="w-64 bg-white rounded-xl overflow-hidden shadow-sm border border-slate-100 cursor-pointer active:opacity-90 transition-opacity">
                <div className="h-32 w-full flex items-center justify-center text-6xl relative overflow-hidden" style={{ background: post.bgStyle || '#fce7f3' }}>
                    {post.images?.[0] || <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4c4.png" alt="document" className="w-12 h-12" />}
                    <div className="absolute bottom-0 left-0 w-full p-2 bg-gradient-to-t from-black/30 to-transparent">
                        <div className="text-white text-xs font-bold line-clamp-1">{post.title}</div>
                    </div>
                </div>
                <div className="p-3">
                    <div className="flex items-center gap-2 mb-2">
                        <img src={post.authorAvatar} className="w-4 h-4 rounded-full" />
                        <span className="text-[10px] text-slate-500">{post.authorName}</span>
                    </div>
                    <p className="text-xs text-slate-600 line-clamp-2 leading-relaxed">{post.content}</p>
                    <div className="mt-2 pt-2 border-t border-slate-50 flex items-center gap-1 text-[10px] text-slate-400">
                        <span className="text-red-400">Spark</span> • 笔记分享
                    </div>
                </div>
            </div>
        );
    }

    // --- Score Card Rendering (Songwriting & Quiz) ---
    if (m.type === 'score_card') {
        let scoreData: any = null;
        try { scoreData = m.metadata?.scoreCard || JSON.parse(m.content); } catch {}

        if (scoreData?.type === 'lifesim_reset_card') {
            return commonLayout(<LifeSimResetCardView card={scoreData} />);
        }

        // Guidebook End Card
        if (scoreData?.type === 'guidebook_card') {
            const diff = scoreData.finalAffinity - scoreData.initialAffinity;
            const isPositive = diff > 0;
            return commonLayout(
                <div className="w-72 rounded-2xl overflow-hidden shadow-md" style={{ border: '1.5px solid rgba(200,185,190,0.4)', background: 'linear-gradient(180deg, #f0ebe8 0%, #fff 25%, #ece6e9 100%)' }} {...interactionProps}>
                    {/* Header bar */}
                    <div className="px-4 pt-3 pb-2 flex items-center gap-2.5" style={{ borderBottom: '1px solid rgba(200,185,190,0.2)', background: 'linear-gradient(135deg, rgba(200,185,190,0.2), rgba(190,175,195,0.15))' }}>
                        {scoreData.charAvatar ? (
                            <img src={scoreData.charAvatar} className="w-9 h-9 rounded-xl object-cover shadow-sm shrink-0" style={{ boxShadow: '0 0 0 2px rgba(180,165,170,0.4)' }} />
                        ) : (
                            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ background: 'linear-gradient(135deg, #b8909a, #a07880)' }}>{scoreData.charName?.[0] || '?'}</div>
                        )}
                        <div className="flex-1 min-w-0">
                            <div className="text-[9px] font-bold tracking-widest uppercase" style={{ color: '#9b8a8e' }}>攻略本 · 结算报告</div>
                            <div className="text-xs font-bold truncate" style={{ color: '#5a4a50' }}>「{scoreData.title}」</div>
                        </div>
                        <div className={`text-lg font-black shrink-0 ${isPositive ? 'text-emerald-500' : diff < 0 ? 'text-red-400' : 'text-slate-400'}`}>
                            {isPositive ? '+' : ''}{diff}
                        </div>
                    </div>

                    {/* Body */}
                    <div className="px-4 py-3 space-y-2.5">
                        {/* Affinity bar */}
                        <div className="flex items-center gap-2">
                            <span className="text-[9px] font-bold shrink-0" style={{ color: '#9b8a8e' }}>好感度</span>
                            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(230,220,225,0.6)' }}>
                                <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(Math.max((scoreData.finalAffinity + 100) / 200 * 100, 2), 100)}%`, background: isPositive ? 'linear-gradient(90deg, #c9b1bd, #b8909a)' : 'linear-gradient(90deg, #c8a0a8, #b87880)' }} />
                            </div>
                            <span className="text-[9px] font-mono font-bold shrink-0" style={{ color: '#8b7a7e' }}>{scoreData.finalAffinity}</span>
                        </div>

                        {/* Verdict */}
                        {scoreData.charVerdict && (
                            <div className="text-xs leading-relaxed italic" style={{ color: '#5a4a50' }}>
                                "{scoreData.charVerdict}"
                            </div>
                        )}

                        {/* New Insight (the juicy part) */}
                        {scoreData.charNewInsight && (
                            <div className="rounded-xl px-3 py-2" style={{ background: 'linear-gradient(135deg, rgba(215,230,248,0.6), rgba(200,220,245,0.45))', border: '1px solid rgba(150,185,225,0.35)' }}>
                                <div className="text-[9px] font-bold mb-1 flex items-center gap-1" style={{ color: '#4a6a92' }}>
                                    <span>◆</span> 这局游戏让我发现的你
                                </div>
                                <div className="text-xs leading-relaxed italic" style={{ color: '#2a4a68' }}>
                                    {scoreData.charNewInsight}
                                </div>
                            </div>
                        )}

                        {/* Rounds info */}
                        <div className="flex items-center justify-between pt-1" style={{ borderTop: '1px solid rgba(200,185,190,0.15)' }}>
                            <span className="text-[9px]" style={{ color: '#c0b0b5' }}>{scoreData.rounds} 回合</span>
                            <span className="text-[9px] font-bold" style={{ color: '#9b8a8e' }}>攻略本 ♥</span>
                        </div>
                    </div>
                </div>
            );
        }

        // White Day Quiz Card
        if (scoreData?.type === 'whiteday_card') {
            const passed = scoreData.passed;
            return commonLayout(
                <div className="w-72 rounded-2xl overflow-hidden shadow-md" style={{ background: 'linear-gradient(180deg, #fff8f0 0%, #fff 30%, #fdf3e8 100%)', border: '1.5px solid rgba(251,191,110,0.4)' }} {...interactionProps}>
                    {/* Header */}
                    <div className="px-4 pt-3 pb-2.5 flex items-center gap-2.5" style={{ background: 'linear-gradient(135deg, rgba(251,191,110,0.25), rgba(249,168,96,0.15))', borderBottom: '1px solid rgba(251,191,110,0.2)' }}>
                        {scoreData.charAvatar ? (
                            <img src={scoreData.charAvatar} className="w-9 h-9 rounded-xl object-cover shadow-sm shrink-0" style={{ boxShadow: '0 0 0 2px rgba(251,191,110,0.4)' }} />
                        ) : (
                            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)' }}>{scoreData.charName?.[0] || '?'}</div>
                        )}
                        <div className="flex-1 min-w-0">
                            <div className="text-[9px] font-bold tracking-widest" style={{ color: '#b45309' }}>白色情人节 · 默契测验</div>
                            <div className="text-xs font-bold truncate" style={{ color: '#78350f' }}>{scoreData.charName}</div>
                        </div>
                        <div className="shrink-0 text-right">
                            <div className={`text-lg font-black ${passed ? 'text-amber-500' : 'text-slate-400'}`}>
                                {scoreData.score}<span className="text-xs opacity-60">/{scoreData.total}</span>
                            </div>
                            <div className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${passed ? 'bg-amber-100 text-amber-600' : 'bg-slate-100 text-slate-500'}`}>
                                {passed ? '解锁 🍫' : '未达标'}
                            </div>
                        </div>
                    </div>
                    {/* Questions list */}
                    <div className="px-3 py-2.5 flex flex-col gap-2">
                        {scoreData.questions?.map((q: any, i: number) => (
                            <div key={i} className="flex items-start gap-2">
                                <span className={`text-xs font-bold shrink-0 mt-0.5 ${q.isCorrect ? 'text-emerald-500' : 'text-red-400'}`}>
                                    {q.isCorrect ? '✓' : '✗'}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-[11px] font-medium leading-tight" style={{ color: '#4a3520' }}>{q.question}</p>
                                    <p className="text-[10px] mt-0.5" style={{ color: q.isCorrect ? '#6b7280' : '#dc2626' }}>
                                        你选：{q.userAnswer}
                                    </p>
                                    {!q.isCorrect && (
                                        <p className="text-[10px]" style={{ color: '#059669' }}>正确：{q.correctAnswer}</p>
                                    )}
                                    {q.review && (
                                        <p className="text-[10px] italic mt-0.5" style={{ color: '#92400e' }}>「{q.review}」</p>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                    {/* Final dialogue */}
                    {scoreData.finalDialogue && (
                        <div className="px-3 pb-3">
                            <div className="text-[11px] rounded-xl px-3 py-2 leading-relaxed" style={{ background: passed ? 'rgba(251,191,110,0.15)' : 'rgba(0,0,0,0.04)', color: '#78350f', border: '1px solid rgba(251,191,110,0.2)' }}>
                                {scoreData.finalDialogue}
                            </div>
                        </div>
                    )}
                    <div className="px-3 pb-2.5 flex justify-end">
                        <span className="text-[9px]" style={{ color: '#d97706' }}>2026.3.14 白色情人节 🍫</span>
                    </div>
                </div>
            );
        }

        // Quiz Card
        if (scoreData?.type === 'quiz_card') {
            const pct = scoreData.scorePercent || 0;
            const gradientClass = pct === 100 ? 'from-emerald-400 to-teal-500' : pct >= 60 ? 'from-amber-400 to-orange-500' : 'from-red-400 to-rose-500';
            return commonLayout(
                <div className="w-64 bg-white rounded-xl overflow-hidden shadow-sm border border-slate-100" {...interactionProps}>
                    <div className={`h-24 w-full bg-gradient-to-br ${gradientClass} flex flex-col items-center justify-center text-white relative`}>
                        <div className="text-3xl font-bold">{scoreData.score}<span className="text-lg opacity-70">/{scoreData.total}</span></div>
                        <div className="text-[10px] opacity-80 mt-1">{pct}%</div>
                    </div>
                    <div className="p-3">
                        <div className="text-xs font-bold text-slate-800 truncate">{scoreData.courseTitle}</div>
                        <div className="text-[10px] text-slate-500 truncate mt-0.5">{scoreData.chapterTitle}</div>
                        <div className="mt-2 pt-2 border-t border-slate-50 flex items-center gap-1 text-[10px] text-emerald-500">
                            <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4dd.png" alt="" className="w-3 h-3 inline-block" /> 刷题报告
                        </div>
                    </div>
                </div>
            );
        }

        if (scoreData) {
            const coverGradients: Record<string, string> = {
                sunset: 'from-orange-400 via-pink-500 to-purple-600',
                ocean: 'from-cyan-400 via-blue-500 to-indigo-600',
                forest: 'from-emerald-400 via-green-500 to-teal-600',
                midnight: 'from-slate-700 via-indigo-900 to-black',
                cherry: 'from-pink-300 via-rose-400 to-red-500',
                lavender: 'from-purple-300 via-violet-400 to-fuchsia-500',
                golden: 'from-yellow-300 via-amber-400 to-orange-500',
                monochrome: 'from-slate-200 via-slate-300 to-slate-400',
            };
            const gradient = coverGradients[scoreData.coverStyle] || coverGradients.sunset;
            return commonLayout(
                <div className="w-64 bg-white rounded-xl overflow-hidden shadow-sm border border-slate-100 cursor-pointer active:opacity-90 transition-opacity" {...interactionProps}>
                    <div className={`h-28 w-full bg-gradient-to-br ${gradient} flex flex-col items-center justify-center text-white relative`}>
                        <div className="text-3xl mb-1">{scoreData.genreIcon || <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f3b5.png" alt="music" className="w-8 h-8" />}</div>
                        <div className="font-bold text-sm">{scoreData.title}</div>
                        {scoreData.subtitle && <div className="text-[10px] opacity-80">{scoreData.subtitle}</div>}
                        {scoreData.status === 'completed' && (
                            <div className="absolute top-2 right-2 bg-white/20 backdrop-blur-sm px-1.5 py-0.5 rounded text-[9px]">已完成</div>
                        )}
                    </div>
                    <div className="p-3">
                        <div className="flex items-center gap-2 mb-2 text-[10px] text-slate-500">
                            <span>{scoreData.genre}</span>
                            <span>·</span>
                            <span>{scoreData.moodIcon} {scoreData.mood}</span>
                            <span>·</span>
                            <span>{scoreData.lineCount} 行</span>
                        </div>
                        {scoreData.lyrics && (
                            <p className="text-xs text-slate-600 line-clamp-3 leading-relaxed whitespace-pre-wrap">{scoreData.lyrics.substring(0, 100)}</p>
                        )}
                        <div className="mt-2 pt-2 border-t border-slate-50 flex items-center gap-1 text-[10px] text-fuchsia-500">
                            <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f3b5.png" alt="" className="w-3 h-3 inline-block" /> 乐谱分享
                        </div>
                    </div>
                </div>
            );
        }
    }

    if (m.type === 'transfer') {
        return commonLayout(
            <div className="w-64 bg-gradient-to-br from-amber-400 to-orange-500 rounded-2xl p-4 text-white shadow-lg relative overflow-hidden group active:scale-[0.98] transition-transform">
                    <div className="absolute top-0 right-0 p-4 opacity-20"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-12 h-12"><path d="M10.464 8.746c.227-.18.497-.311.786-.394v2.795a2.252 2.252 0 0 1-.786-.393c-.394-.313-.546-.681-.546-1.004 0-.324.152-.691.546-1.004ZM12.75 15.662v-2.824c.347.085.664.228.921.421.427.32.579.686.579.991 0 .305-.152.671-.579.991a2.534 2.534 0 0 1-.921.42Z" /><path fillRule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25ZM12.75 6a.75.75 0 0 0-1.5 0v.816a3.836 3.836 0 0 0-1.72.756c-.712.566-1.112 1.35-1.112 2.178 0 .829.4 1.612 1.113 2.178.502.4 1.102.647 1.719.756v2.978a2.536 2.536 0 0 1-.921-.421l-.879-.66a.75.75 0 0 0-.9 1.2l.879.66c.533.4 1.169.645 1.821.75V18a.75.75 0 0 0 1.5 0v-.81a4.124 4.124 0 0 0 1.821-.749c.745-.559 1.179-1.344 1.179-2.191 0-.847-.434-1.632-1.179-2.191a4.122 4.122 0 0 0-1.821-.75V8.354c.29.082.559.213.786.393l.415.33a.75.75 0 0 0 .933-1.175l-.415-.33a3.836 3.836 0 0 0-1.719-.755V6Z" clipRule="evenodd" /><path d="M2.25 18a.75.75 0 0 0 0 1.5c5.4 0 10.63.722 15.6 2.075 1.19.324 2.4-.558 2.4-1.82V18.75a.75.75 0 0 0-.75-.75H2.25Z" /></svg></div>
                    <div className="flex items-center gap-3 mb-2">
                        <div className="p-2 bg-white/20 rounded-full"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path d="M12 7.5a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5Z" /><path fillRule="evenodd" d="M1.5 4.875C1.5 3.839 2.34 3 3.375 3h17.25c1.035 0 1.875.84 1.875 1.875v9.75c0 1.036-.84 1.875-1.875 1.875H3.375A1.875 1.875 0 0 1 1.5 14.625v-9.75ZM8.25 9.75a3.75 3.75 0 1 1 7.5 0 3.75 3.75 0 0 1-7.5 0ZM18.75 9a.75.75 0 0 0-.75.75v.008c0 .414.336.75.75.75h.008a.75.75 0 0 0 .75-.75V9.75a.75.75 0 0 0-.75-.75h-.008ZM4.5 9.75A.75.75 0 0 1 5.25 9h.008a.75.75 0 0 1 .75.75v.008a.75.75 0 0 1-.75-.75H5.25a.75.75 0 0 1-.75-.75V9.75Z" clipRule="evenodd" /><path d="M2.25 18a.75.75 0 0 0 0 1.5c5.4 0 10.63.722 15.6 2.075 1.19.324 2.4-.558 2.4-1.82V18.75a.75.75 0 0 0-.75-.75H2.25Z" /></svg></div>
                        <span className="font-medium text-white/90">Sully Pay</span>
                    </div>
                    <div className="text-2xl font-bold tracking-tight mb-1">₩ {m.metadata?.amount}</div>
                    <div className="text-[10px] text-white/70">转账给{isUser ? charName : '你'}</div>
            </div>
        );
    }

    if (m.type === 'emoji') {
        return commonLayout(
            <img src={m.content} className="max-w-[160px] max-h-[160px] hover:scale-105 transition-transform drop-shadow-md active:scale-95" loading="lazy" decoding="async" />
        );
    }

    if (m.type === 'image') {
        return commonLayout(
            <div className="relative group">
                <img src={m.content} className="max-w-[200px] max-h-[300px] rounded-2xl shadow-sm border border-black/5" alt="Uploaded" loading="lazy" decoding="async" />
            </div>
        );
    }

    // --- Dynamic Style Generation for Bubble ---
    const radius = styleConfig.borderRadius;
    let borderObj: React.CSSProperties = {};
    
    // Border Radius Logic
    if (!isFirstInGroup && !isLastInGroup) {
        borderObj = isUser 
            ? { borderRadius: `${radius}px`, borderTopRightRadius: '4px', borderBottomRightRadius: '4px' }
            : { borderRadius: `${radius}px`, borderTopLeftRadius: '4px', borderBottomLeftRadius: '4px' };
    } else if (isFirstInGroup && !isLastInGroup) {
        borderObj = isUser
            ? { borderRadius: `${radius}px`, borderBottomRightRadius: '4px' }
            : { borderRadius: `${radius}px`, borderBottomLeftRadius: '4px' };
    } else if (!isFirstInGroup && isLastInGroup) {
        borderObj = isUser
            ? { borderRadius: `${radius}px`, borderTopRightRadius: '4px' }
            : { borderRadius: `${radius}px`, borderTopLeftRadius: '4px' };
    } else {
            borderObj = isUser
            ? { borderRadius: `${radius}px`, borderBottomRightRadius: '2px' }
            : { borderRadius: `${radius}px`, borderBottomLeftRadius: '2px' };
    }

    // Container style (BackgroundColor + Opacity) with bubble variant
    const containerStyle: React.CSSProperties = {
        backgroundColor: bubbleVariant === 'outline' ? 'transparent' : styleConfig.backgroundColor,
        opacity: styleConfig.opacity,
        ...borderObj,
        ...(bubbleVariant === 'outline' ? { border: `2px solid ${styleConfig.backgroundColor}`, boxShadow: 'none' } : {}),
        ...(bubbleVariant === 'shadow' ? { boxShadow: '0 4px 12px rgba(0,0,0,0.12)' } : {}),
        ...(bubbleVariant === 'flat' ? { boxShadow: 'none' } : {}),
        ...(bubbleVariant === 'wechat' ? { boxShadow: 'none', border: '1px solid rgba(15,23,42,0.05)' } : {}),
        ...(bubbleVariant === 'ios' ? { boxShadow: '0 10px 24px rgba(148,163,184,0.16)', border: '1px solid rgba(255,255,255,0.75)', backdropFilter: 'blur(12px)' } : {}),
    };

    // --- Inline formatting parser: code → bold → italic → plain ---
    const renderInline = (text: string): React.ReactNode[] => {
        // Pre-clean: markdown links [text](url) → just text
        let cleaned = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
        // Pre-clean: stray backticks
        cleaned = cleaned.replace(/``+/g, '').replace(/(^|\s)`(\s|$)/g, '$1$2');

        const nodes: React.ReactNode[] = [];
        let nodeKey = 0;

        // Step 1: Split by inline code (`code`)
        const codeParts = cleaned.split(/(`[^`]+`)/g);
        for (const codePart of codeParts) {
            if (codePart.startsWith('`') && codePart.endsWith('`') && codePart.length > 2) {
                nodes.push(<code key={nodeKey++} className="bg-black/10 px-1 py-0.5 rounded text-[13px] font-mono">{codePart.slice(1, -1)}</code>);
                continue;
            }
            // Step 2: Split by bold (**text**)
            const boldParts = codePart.split(/(\*\*[^*]+\*\*)/g);
            for (const boldPart of boldParts) {
                if (boldPart.startsWith('**') && boldPart.endsWith('**') && boldPart.length > 4) {
                    nodes.push(<strong key={nodeKey++} className="font-bold">{boldPart.slice(2, -2)}</strong>);
                    continue;
                }
                // Strip orphaned ** that didn't form a valid bold pair
                const cleanedBold = boldPart.replace(/\*\*/g, '');
                // Step 3: Split by italic (*text*) — safe because ** already stripped
                const italicParts = cleanedBold.split(/(\*[^*]+\*)/g);
                for (const italicPart of italicParts) {
                    if (italicPart.startsWith('*') && italicPart.endsWith('*') && italicPart.length > 2) {
                        nodes.push(<em key={nodeKey++} className="italic opacity-80">{italicPart.slice(1, -1)}</em>);
                        continue;
                    }
                    // Strip orphaned * that didn't form a valid italic pair
                    const cleanedItalic = italicPart.replace(/\*/g, '');
                    if (cleanedItalic) nodes.push(cleanedItalic);
                }
            }
        }
        return nodes;
    };

    // --- Enhanced Text Rendering (Markdown Lite) ---
    const renderContent = (text: string) => {
        // 1. Split by Code Blocks (triple backtick)
        const parts = text.split(/(```[\s\S]*?```)/g);
        return parts.map((part, index) => {
            // Render Code Block
            if (part.startsWith('```') && part.endsWith('```')) {
                const codeContent = part.replace(/^```\w*\n?/, '').replace(/```$/, '');
                return (
                    <pre key={index} className="bg-black/80 text-gray-100 p-3 rounded-lg text-xs font-mono overflow-x-auto my-2 whitespace-pre shadow-inner border border-white/10">
                        {codeContent}
                    </pre>
                );
            }

            // Clean stray backtick artifacts from non-code text
            let cleanedPart = part
                .replace(/``+/g, '')
                .replace(/(^|\s)`(\s|$)/gm, '$1$2');

            // Render Regular Text (split by newlines for paragraph spacing)
            return cleanedPart.split('\n').map((line, lineIdx) => {
                const key = `${index}-${lineIdx}`;

                // Quote Format "> text"
                if (line.trim().startsWith('>')) {
                    const quoteText = line.trim().substring(1).trim();
                    if (!quoteText) return null;
                    return (
                        <div key={key} className="my-1 pl-2.5 border-l-[3px] border-current opacity-70 italic text-[13px]">
                            {renderInline(quoteText)}
                        </div>
                    );
                }

                // Markdown Header "# text" → render as bold text (strip the #)
                const headerMatch = line.match(/^#{1,6}\s+(.+)$/);
                if (headerMatch) {
                    return <div key={key} className="min-h-[1.2em] font-bold">{renderInline(headerMatch[1])}</div>;
                }

                return <div key={key} className="min-h-[1.2em]">{renderInline(line)}</div>;
            });
        });
    };

    // Robust content cleanup: strip legacy markers, separators, bilingual tags, stray formatting
    const stripJunk = (s: string) => s
        .replace(/%%TRANS%%[\s\S]*/gi, '')           // legacy translation marker
        .replace(/%%BILINGUAL%%/gi, '\n')            // raw bilingual marker → newline
        .replace(/<\/?翻译>|<\/?原文>|<\/?译文>/g, '')  // stray bilingual XML tags
        .replace(/\s*\[(?:聊天|通话|约会)\]\s*/g, '\n')   // source tags leaked from history context
        .replace(/\[\[(?:QU[OA]TE|引用)[：:][\s\S]*?\]\]/g, '')  // residual double-bracket quotes (incl. typos & Chinese)
        .replace(/\[(?:QU[OA]TE|引用)[：:][^\]]*\]/g, '')     // residual single-bracket quotes (incl. typos & Chinese)
        .replace(/\[回复\s*[""\u201C][^""\u201D]*?[""\u201D](?:\.{0,3})\]\s*[：:]?\s*/g, '')  // [回复 "content"]: format
        // Residual action/system tags that may have leaked through
        .replace(/\[\[(?:ACTION|RECALL|SEARCH|DIARY|READ_DIARY|FS_DIARY|FS_READ_DIARY|SEND_EMOJI|DIARY_START|DIARY_END|FS_DIARY_START|FS_DIARY_END)[:\s][\s\S]*?\]\]/g, '')
        .replace(/\[schedule_message[^\]]*\]/g, '')
        .replace(/<[语語]音>[\s\S]*?<\/[语語]音>/g, '')  // strip <语音>...</语音> voice tags
        .replace(/^\s*---\s*$/gm, '')                // standalone --- lines
        .replace(/``+/g, '')                          // empty/stray backtick pairs
        .replace(/(^|\s)`(\s|$)/gm, '$1$2')         // lone backticks at boundaries
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')    // markdown links → just text
        .replace(/\n{3,}/g, '\n\n')                  // collapse excess newlines
        .trim();

    const rawContent = m.content;

    // Parse %%BILINGUAL%% for bilingual display (langA = "选" language, langB = "译" language)
    const bilingualIdx = rawContent.toLowerCase().indexOf('%%bilingual%%');
    const hasBilingual = bilingualIdx !== -1;
    const langAContent = hasBilingual ? stripJunk(rawContent.substring(0, bilingualIdx)) : stripJunk(rawContent);
    const langBContent = hasBilingual ? stripJunk(rawContent.substring(bilingualIdx + '%%BILINGUAL%%'.length)) : '';

    // Display: "选" language by default, "译" language when toggled
    const displayContent = (isShowingTarget && langBContent) ? langBContent : langAContent;
    const showTranslateButton = translationEnabled && hasBilingual && langBContent;

    // Check if raw content has a <语音> tag (voice-only message that hasn't been TTS'd yet)
    const hasVoiceTag = !isUser && /<[语語]音>[\s\S]*?<\/[语語]音>/.test(m.content);
    const hasVoiceContent = voiceData?.url || voiceLoading || hasVoiceTag;
    // Don't render empty bubbles (e.g. messages that were just "---"), unless voice data exists or pending
    if (!displayContent && !hasVoiceContent) return null;

    // Voice-only messages (no display text, only voice bar): skip bubble styling
    const isVoiceOnlyMsg = !displayContent && hasVoiceContent && !isUser && m.type === 'text';

    return commonLayout(
        <div className={isVoiceOnlyMsg
            ? 'relative animate-fade-in'
            : `relative ${bubbleVariant === 'flat' || bubbleVariant === 'outline' || bubbleVariant === 'wechat' ? '' : 'shadow-sm '}px-5 py-3 animate-fade-in ${bubbleVariant === 'outline' ? '' : 'border border-black/5 '}active:scale-[0.98] transition-transform overflow-visible ${isUser ? 'sully-bubble-user' : 'sully-bubble-ai'}`}
            style={isVoiceOnlyMsg ? undefined : containerStyle}>

            {/* Layer 1: Background Image with Independent Opacity */}
            {styleConfig.backgroundImage && (
                <div
                    className="absolute inset-0 bg-cover bg-center pointer-events-none z-0"
                    style={{
                        backgroundImage: `url(${styleConfig.backgroundImage})`,
                        opacity: styleConfig.backgroundImageOpacity ?? 0.5,
                        borderRadius: 'inherit'
                    }}
                />
            )}

            {/* Layer 2: Decoration Sticker (Custom Position) */}
            {styleConfig.decoration && (
                <img
                    src={styleConfig.decoration}
                    className="absolute z-10 w-8 h-8 object-contain drop-shadow-sm pointer-events-none"
                    style={{
                        left: `${styleConfig.decorationX ?? (isUser ? 90 : 10)}%`,
                        top: `${styleConfig.decorationY ?? -10}%`,
                        transform: `translate(-50%, -50%) scale(${styleConfig.decorationScale ?? 1}) rotate(${styleConfig.decorationRotate ?? 0}deg)`
                    }}
                    alt=""
                />
            )}

            {/* Layer 3: Reply/Quote Block */}
            {m.replyTo && (
                <div className="relative z-10 mb-1 text-[10px] bg-black/5 p-1.5 rounded-md border-l-2 border-current opacity-60 flex flex-col gap-0.5 max-w-full overflow-hidden">
                    <span className="font-bold opacity-90 truncate">{m.replyTo.name}</span>
                    <span className="truncate italic">"{m.replyTo.content.length > 10 ? m.replyTo.content.slice(0, 10) + '...' : m.replyTo.content}"</span>
                </div>
            )}

            {/* Layer 4: Text Content — shown when there's visible text after stripping voice tags */}
            {displayContent && (
            <div className="relative z-10 text-[15px] leading-relaxed whitespace-pre-wrap break-all select-text" style={{ color: styleConfig.textColor }}>
                {renderContent(displayContent)}
            </div>
            )}

            {/* Layer 5: Per-bubble Translate Toggle (AI bilingual messages only) */}
            {showTranslateButton && displayContent && (
                <div className="relative z-10 mt-2 flex justify-end">
                    <button
                        onClick={(e) => { e.stopPropagation(); e.preventDefault(); onTranslateToggle?.(m.id); }}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-medium transition-all active:scale-95 select-none"
                        style={{
                            color: styleConfig.textColor,
                            opacity: 0.45,
                            backgroundColor: isShowingTarget ? 'rgba(0,0,0,0.06)' : 'transparent',
                        }}
                    >
                        {isShowingTarget ? (
                            <>
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path fillRule="evenodd" d="M7.793 2.232a.75.75 0 0 1-.025 1.06L3.622 7.25h10.003a5.375 5.375 0 0 1 0 10.75H10.75a.75.75 0 0 1 0-1.5h2.875a3.875 3.875 0 0 0 0-7.75H3.622l4.146 3.957a.75.75 0 0 1-1.036 1.085l-5.5-5.25a.75.75 0 0 1 0-1.085l5.5-5.25a.75.75 0 0 1 1.06.025Z" clipRule="evenodd" /></svg>
                                <span>原文</span>
                            </>
                        ) : (
                            <>
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M7.75 2.75a.75.75 0 0 0-1.5 0v1.258a32.987 32.987 0 0 0-3.599.278.75.75 0 1 0 .198 1.487A31.545 31.545 0 0 1 8.7 5.545 19.381 19.381 0 0 1 7.257 9.04a19.391 19.391 0 0 1-1.727-2.29.75.75 0 1 0-1.29.77 20.9 20.9 0 0 0 2.023 2.684 19.549 19.549 0 0 1-3.158 2.57.75.75 0 1 0 .86 1.229A21.056 21.056 0 0 0 7.5 11.03c1.1.95 2.3 1.79 3.593 2.49a.75.75 0 1 0 .69-1.331A19.545 19.545 0 0 1 8.46 9.89a20.893 20.893 0 0 0 1.91-4.644h2.38a.75.75 0 0 0 0-1.5h-3v-1a.75.75 0 0 0-.75-.75Z" /><path d="M12.75 10a.75.75 0 0 1 .692.462l2.5 6a.75.75 0 1 1-1.384.576l-.532-1.278h-3.052l-.532 1.278a.75.75 0 1 1-1.384-.576l2.5-6A.75.75 0 0 1 12.75 10Zm-1.018 4.26h2.036L12.75 11.6l-1.018 2.66Z" /></svg>
                                <span>译</span>
                            </>
                        )}
                    </button>
                </div>
            )}

            {/* Layer 6: Voice Bar */}
            {(voiceData?.url || voiceLoading || hasVoiceTag) && !isUser && m.type === 'text' && (() => {
                const vbBg = styleConfig.voiceBarBg;
                const vbActiveBg = styleConfig.voiceBarActiveBg;
                const vbBtn = styleConfig.voiceBarBtnColor;
                const vbWave = styleConfig.voiceBarWaveColor;
                const vbText = styleConfig.voiceBarTextColor;
                // Voice-only mode: no visible text, voice bar is primary content
                const isVoiceOnly = !!voiceData?.url && !displayContent;
                return (
                <div className={`relative z-10 ${isVoiceOnly ? '' : 'mt-2.5'}`}>
                    {voiceData?.url ? (
                        <div className="max-w-[260px]">
                            <button
                                onClick={(e) => { e.stopPropagation(); e.preventDefault(); onPlayVoice?.(); }}
                                className="group flex items-center gap-2.5 w-full px-3 py-2 rounded-2xl transition-all duration-300 active:scale-[0.97] select-none"
                                style={{
                                    background: isVoicePlaying
                                        ? (vbActiveBg || 'linear-gradient(135deg, rgba(16,185,129,0.12) 0%, rgba(52,211,153,0.08) 100%)')
                                        : (vbBg || 'linear-gradient(135deg, rgba(0,0,0,0.03) 0%, rgba(0,0,0,0.06) 100%)'),
                                    border: isVoicePlaying
                                        ? `1px solid ${vbBtn ? vbBtn + '33' : 'rgba(16,185,129,0.2)'}`
                                        : '1px solid rgba(0,0,0,0.05)',
                                }}
                            >
                                {/* Play/Pause circle */}
                                <div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-all duration-300"
                                    style={{
                                        backgroundColor: isVoicePlaying ? (vbBtn || '#10b981') : (vbBg ? 'rgba(255,255,255,0.25)' : 'rgba(148,163,184,0.2)'),
                                        boxShadow: isVoicePlaying ? `0 2px 8px ${vbBtn ? vbBtn + '4D' : 'rgba(16,185,129,0.3)'}` : 'none',
                                    }}
                                >
                                    {isVoicePlaying ? (
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-white"><path d="M5.75 3a.75.75 0 0 0-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 0 0 .75-.75V3.75A.75.75 0 0 0 7.25 3h-1.5ZM12.75 3a.75.75 0 0 0-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 0 0 .75-.75V3.75a.75.75 0 0 0-.75-.75h-1.5Z" /></svg>
                                    ) : (
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill={vbBtn || '#64748b'} className="w-3 h-3 ml-0.5"><path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.841Z" /></svg>
                                    )}
                                </div>
                                {/* Waveform bars */}
                                <div className="flex-1 flex items-center gap-[3px] h-5 overflow-hidden">
                                    {[4, 10, 6, 14, 8, 12, 5, 11, 7, 13, 4, 9, 6, 11, 5, 8, 10, 7, 12, 6].map((h, i) => (
                                        <div
                                            key={i}
                                            className={`w-[2.5px] rounded-full transition-all duration-150 ${isVoicePlaying ? 'animate-pulse' : ''}`}
                                            style={{
                                                height: isVoicePlaying ? `${Math.max(3, h + Math.sin(i * 0.8) * 3)}px` : `${Math.max(2, h * 0.4)}px`,
                                                backgroundColor: isVoicePlaying
                                                    ? (vbWave || `rgba(16, 185, 129, ${0.4 + (h / 14) * 0.5})`)
                                                    : (vbWave ? vbWave + '60' : `rgba(148, 163, 184, ${0.25 + (h / 14) * 0.35})`),
                                                animationDelay: `${i * 60}ms`,
                                                animationDuration: `${600 + (i % 3) * 200}ms`,
                                            }}
                                        />
                                    ))}
                                </div>
                                {/* Text toggle button — always available so user can read the text */}
                                <div
                                    className={`shrink-0 ml-0.5 px-1.5 py-0.5 rounded-lg text-[9px] font-medium transition-all ${showVoiceText ? 'ring-1 ring-current/20' : ''}`}
                                    style={{
                                        color: vbText || 'rgba(100,116,139,0.7)',
                                        backgroundColor: showVoiceText ? 'rgba(0,0,0,0.08)' : 'rgba(0,0,0,0.04)',
                                    }}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        e.preventDefault();
                                        setShowVoiceText(v => !v);
                                    }}
                                >
                                    {showVoiceText ? '收起' : '转文字'}
                                </div>
                            </button>
                            {/* Expandable text area — shows spoken text + Chinese translation */}
                            {showVoiceText && (
                                <div>
                                    <div className="mt-1.5 px-3 py-2 rounded-xl text-[11px] leading-relaxed space-y-1"
                                        style={{
                                            backgroundColor: vbBg || 'rgba(0,0,0,0.02)',
                                            color: vbText || '#475569',
                                            border: '1px solid rgba(0,0,0,0.04)',
                                        }}
                                    >
                                        {/* When foreign lang voice: show spoken text first, then Chinese translation */}
                                        {voiceData.lang && voiceData.spokenText ? (
                                            <>
                                                <div className="whitespace-pre-wrap">{voiceData.spokenText}</div>
                                                {(voiceData.originalText || displayContent) && (
                                                    <div
                                                        style={{ opacity: 0.65 }}
                                                        className="whitespace-pre-wrap text-[10px] mt-1 pt-1 border-t border-current/10"
                                                    >
                                                        {voiceData.originalText || displayContent}
                                                    </div>
                                                )}
                                            </>
                                        ) : (
                                            <>
                                                {/* Default: show original text */}
                                                {(voiceData.originalText || displayContent) && (
                                                    <div className="whitespace-pre-wrap">{voiceData.originalText || displayContent}</div>
                                                )}
                                                {voiceData.spokenText && (
                                                    <div
                                                        style={{ opacity: (voiceData.originalText || displayContent) ? 0.55 : 1 }}
                                                        className={`whitespace-pre-wrap ${(voiceData.originalText || displayContent) ? 'text-[10px] mt-1 pt-1 border-t border-current/10' : ''}`}
                                                    >
                                                        {voiceData.spokenText}
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : voiceLoading ? (
                        <div className="flex items-center gap-2 px-3 py-2 max-w-[200px] rounded-2xl" style={{ background: vbBg || 'linear-gradient(135deg, rgba(0,0,0,0.02) 0%, rgba(0,0,0,0.04) 100%)', border: '1px solid rgba(0,0,0,0.04)' }}>
                            <div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center" style={{ backgroundColor: vbBg ? 'rgba(255,255,255,0.2)' : '#f1f5f9' }}>
                                <svg className="animate-spin h-3.5 w-3.5" style={{ color: vbBtn || '#94a3b8' }} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3.5"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                            </div>
                            <div className="flex-1 flex items-center gap-[3px] h-5 overflow-hidden">
                                {[...Array(14)].map((_, i) => (
                                    <div key={i} className="w-[2.5px] rounded-full animate-pulse" style={{ height: `${3 + (i % 3) * 2}px`, backgroundColor: vbWave ? vbWave + '40' : '#e2e8f0', animationDelay: `${i * 100}ms` }} />
                                ))}
                            </div>
                            <span className="text-[10px] shrink-0 animate-pulse" style={{ color: vbText || '#94a3b8' }}>合成中</span>
                        </div>
                    ) : hasVoiceTag ? (
                        /* Voice tag exists in content but TTS hasn't been generated yet (e.g. app restart, or auto-TTS pending) */
                        <button
                            onClick={(e) => { e.stopPropagation(); e.preventDefault(); onPlayVoice?.(); }}
                            className="flex items-center gap-2 px-3 py-2 max-w-[200px] rounded-2xl active:scale-[0.97] transition-transform"
                            style={{ background: vbBg || 'linear-gradient(135deg, rgba(0,0,0,0.03) 0%, rgba(0,0,0,0.06) 100%)', border: '1px solid rgba(0,0,0,0.05)' }}
                        >
                            <div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center" style={{ backgroundColor: vbBg ? 'rgba(255,255,255,0.25)' : 'rgba(148,163,184,0.2)' }}>
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill={vbBtn || '#64748b'} className="w-3 h-3 ml-0.5"><path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.841Z" /></svg>
                            </div>
                            <div className="flex-1 flex items-center gap-[3px] h-5 overflow-hidden">
                                {[4, 10, 6, 14, 8, 12, 5, 11, 7, 13, 4, 9, 6, 11, 5, 8, 10, 7, 12, 6].map((h, i) => (
                                    <div key={i} className="w-[2.5px] rounded-full" style={{ height: `${Math.max(2, h * 0.4)}px`, backgroundColor: vbWave ? vbWave + '60' : `rgba(148, 163, 184, ${0.25 + (h / 14) * 0.35})` }} />
                                ))}
                            </div>
                            <span className="text-[9px] shrink-0" style={{ color: vbText || 'rgba(100,116,139,0.7)' }}>语音</span>
                        </button>
                    ) : null}
                </div>
                );
            })()}
        </div>
    );
}, (prev, next) => {
    return prev.msg.id === next.msg.id &&
           prev.msg.content === next.msg.content &&
           prev.isFirstInGroup === next.isFirstInGroup &&
           prev.isLastInGroup === next.isLastInGroup &&
           prev.activeTheme === next.activeTheme &&
           prev.charAvatar === next.charAvatar &&
           prev.charName === next.charName &&
           prev.userAvatar === next.userAvatar &&
           prev.selectionMode === next.selectionMode &&
           prev.isSelected === next.isSelected &&
           prev.translationEnabled === next.translationEnabled &&
           prev.isShowingTarget === next.isShowingTarget &&
           prev.avatarShape === next.avatarShape &&
           prev.avatarSize === next.avatarSize &&
           prev.avatarMode === next.avatarMode &&
           prev.bubbleVariant === next.bubbleVariant &&
           prev.messageSpacing === next.messageSpacing &&
           prev.showTimestamp === next.showTimestamp &&
           prev.voiceData?.url === next.voiceData?.url &&
           prev.voiceLoading === next.voiceLoading &&
           prev.isVoicePlaying === next.isVoicePlaying;
});

export default MessageItem;
