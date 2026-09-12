import { loadCharacterContextMessages } from '../utils/chatContextRange';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { CharacterProfile, GuidebookSession, GuidebookRound, GuidebookOption } from '../types';
import { extractJson } from '../utils/safeApi';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import {
    buildOpeningPrompt,
    buildRoundPrompt,
    buildOptionAssistPrompt,
    buildEndCardPrompt,
} from '../utils/guidebookPrompts';
import { DB } from '../utils/db';
import { trackEvent } from '../utils/analytics';
import {
    ArrowLeft,
    ArrowRight,
    Heart,
    CaretUp,
    CaretDown,
    CaretRight,
    PencilSimple,
    Sparkle,
    FlowerLotus,
    Star,
    Diamond,
    DiamondsFour,
    Cards,
} from '@phosphor-icons/react';
import TokenImg from '../components/os/TokenImg';

// --- Helper: Generate ID ---
const genId = () => Math.random().toString(36).slice(2, 10);

// --- Helper: API Call ---
async function callAPI(apiConfig: { baseUrl: string; apiKey: string; model: string }, prompt: string): Promise<string> {
    const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify({
            model: apiConfig.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.9,
            max_tokens: 4000,
            stream: false,
        }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    let json: any;
    try { json = JSON.parse(text); } catch {
        json = JSON.parse(text.replace(/^data: /, '').trim());
    }
    return json?.choices?.[0]?.message?.content?.trim() || '';
}

// --- Helper: Fetch the shared character context range as text ---
async function fetchRecentMessages(charId: string): Promise<string> {
    try {
        const msgs = await loadCharacterContextMessages(charId);
        const privateMsgs = msgs.filter(m => !m.groupId && (m.type === 'text' || m.type === 'voice'));
        if (privateMsgs.length === 0) return '';
        return privateMsgs.map(m =>
            `[${m.role === 'user' ? 'User' : 'Char'}] ${m.content.replace(/\n/g, ' ').slice(0, 120)}`
        ).join('\n');
    } catch { return ''; }
}

// --- Helper: Extract established world context from opening segments ---
function extractWorldContext(openingSequence?: string): string {
    if (!openingSequence) return '';
    try {
        const segments: { speaker: string; text: string }[] = JSON.parse(openingSequence);
        // Collect GM narrations as the established world/scene
        const gmParts = segments.filter(s => s.speaker === 'gm').map(s => s.text);
        if (gmParts.length === 0) return '';
        return gmParts.join('\n');
    } catch { return ''; }
}

// --- Helper: Format date ---
const fmtDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
};

// --- Long Press Hook ---
function useLongPress(callback: () => void, ms = 500) {
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const movedRef = useRef(false);
    const startPos = useRef({ x: 0, y: 0 });

    const start = useCallback((e: React.TouchEvent | React.MouseEvent) => {
        movedRef.current = false;
        const pos = 'touches' in e ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY };
        startPos.current = pos;
        timerRef.current = setTimeout(() => {
            if (!movedRef.current) callback();
        }, ms);
    }, [callback, ms]);

    const move = useCallback((e: React.TouchEvent | React.MouseEvent) => {
        const pos = 'touches' in e ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY };
        if (Math.abs(pos.x - startPos.current.x) > 10 || Math.abs(pos.y - startPos.current.y) > 10) {
            movedRef.current = true;
            if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        }
    }, []);

    const end = useCallback(() => {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    }, []);

    return { onTouchStart: start, onTouchMove: move, onTouchEnd: end, onMouseDown: start, onMouseMove: move, onMouseUp: end };
}

// ========== THEMED UI COMPONENTS ==========

// Pastel theme wrapper — warm neutral / dusty mauve
const GameFrame: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
    <div className={`w-full h-full flex flex-col overflow-hidden ${className}`}
        style={{
            background: 'linear-gradient(180deg, #f0ebe8 0%, #ece6e9 30%, #e8e4ea 70%, #e5e0e3 100%)',
        }}>
        {children}
    </div>
);

// Header bar — notebook spine style (warm neutral)
const GameHeader: React.FC<{
    title: string;
    subtitle?: string;
    onBack: () => void;
    affinity?: number | null;
    charAvatar?: string;
}> = ({ title, subtitle, onBack, affinity, charAvatar }) => (
    <div className="shrink-0 relative">
        {/* Decorative spiral dots */}
        <div className="absolute left-1 top-0 bottom-0 flex flex-col items-center justify-center gap-1.5 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
            {[0, 1, 2, 3, 4].map(i => (
                <div key={i} className="w-2 h-2 rounded-full" style={{ background: 'rgba(180,165,170,0.4)', border: '1px solid rgba(160,145,150,0.2)' }} />
            ))}
        </div>
        <div className="flex items-center gap-2.5 pl-5 pr-3 py-2.5"
            style={{ background: 'linear-gradient(135deg, rgba(200,185,190,0.3) 0%, rgba(190,175,195,0.2) 100%)', borderBottom: '2px solid rgba(180,165,170,0.2)', paddingTop: 'calc(var(--safe-top) + 0.625rem)' }}>
            <button onClick={onBack} className="w-7 h-7 rounded-full bg-white/60 flex items-center justify-center text-xs font-bold active:scale-90 transition-transform shadow-sm backdrop-blur-sm" style={{ color: '#9b8a8e' }}>
                <ArrowLeft size={14} />
            </button>
            {charAvatar && (
                <TokenImg value={charAvatar} className="w-8 h-8 rounded-full object-cover shadow-md" style={{ boxShadow: '0 0 0 2px rgba(180,165,170,0.4)' }} />
            )}
            <div className="flex-1 min-w-0">
                <div className="text-sm font-bold truncate" style={{ color: '#5a4a50' }}>{title}</div>
                {subtitle && <div className="text-[10px]" style={{ color: '#9b8a8e' }}>{subtitle}</div>}
            </div>
            {affinity != null && (
                <div className="px-2.5 py-1 rounded-full text-xs font-bold shadow-sm" style={{
                    background: affinity >= 0
                        ? 'linear-gradient(135deg, rgba(200,175,175,0.4), rgba(190,160,165,0.3))'
                        : 'linear-gradient(135deg, rgba(170,175,200,0.4), rgba(160,165,190,0.3))',
                    color: affinity >= 0 ? '#8b6a6e' : '#6a6e8b',
                    border: affinity >= 0 ? '1px solid rgba(190,160,165,0.3)' : '1px solid rgba(160,165,190,0.3)',
                }}>
                    <Heart size={10} weight="fill" className="mr-0.5" />{affinity}
                </div>
            )}
        </div>
    </div>
);

// Card wrapper — warm neutral
const Card: React.FC<{ children: React.ReactNode; className?: string; onClick?: () => void }> = ({ children, className = '', onClick }) => (
    <div onClick={onClick}
        className={`bg-white/70 backdrop-blur-sm rounded-2xl shadow-sm ${onClick ? 'active:scale-[0.98] cursor-pointer' : ''} transition-all ${className}`}
        style={{ border: '1px solid rgba(200,185,190,0.3)', boxShadow: '0 2px 8px rgba(160,145,150,0.08), 0 1px 3px rgba(0,0,0,0.04)' }}>
        {children}
    </div>
);

// Stat bar (like HP/MP bar from reference)
const StatBar: React.FC<{ label: string; value: number; max?: number; color?: string }> = ({ label, value, max = 100, color = 'warm' }) => {
    const pct = Math.min(Math.max((value + 100) / 200 * 100, 0), 100);
    const colorMap: Record<string, string> = {
        warm: 'linear-gradient(90deg, #c9b1bd, #b8909a)',
        blue: 'linear-gradient(90deg, #a0b0c8, #8a9ab8)',
        green: 'linear-gradient(90deg, #a0c8b0, #8ab8a0)',
        purple: 'linear-gradient(90deg, #b0a0c8, #9a8ab8)',
    };
    return (
        <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold w-14 text-right shrink-0" style={{ color: '#8b7a7e' }}>{label}</span>
            <div className="flex-1 h-3 rounded-full overflow-hidden shadow-inner" style={{ background: 'rgba(230,220,225,0.6)', border: '1px solid rgba(200,185,190,0.3)' }}>
                <div className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${pct}%`, background: colorMap[color] || colorMap.warm }} />
            </div>
            <span className="text-[10px] font-mono font-bold w-8" style={{ color: '#8b7a7e' }}>{value}</span>
        </div>
    );
};

// --- Animated Text Display ---
const TypewriterSegments: React.FC<{
    segments: { speaker: string; text: string }[];
    charName: string;
    onDone: () => void;
}> = ({ segments, charName, onDone }) => {
    const [visibleCount, setVisibleCount] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (visibleCount < segments.length) {
            const delay = 600 + Math.random() * 800;
            const timer = setTimeout(() => setVisibleCount(v => v + 1), delay);
            return () => clearTimeout(timer);
        } else {
            const timer = setTimeout(onDone, 500);
            return () => clearTimeout(timer);
        }
    }, [visibleCount, segments.length]);

    useEffect(() => {
        containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: 'smooth' });
    }, [visibleCount]);

    return (
        <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-3 no-scrollbar">
            {segments.slice(0, visibleCount).map((seg, i) => (
                <SegmentBubble key={i} seg={seg} charName={charName} />
            ))}
            {visibleCount < segments.length && (
                <div className="flex items-center gap-1.5 text-xs" style={{ color: 'rgba(140,125,130,0.7)' }}>
                    <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: '#b8a0a8' }} />
                    <span>{segments[visibleCount]?.speaker === 'gm' ? 'GM' : charName} 正在说话...</span>
                </div>
            )}
        </div>
    );
};

// --- Segment Bubble (game dialogue style — warm neutral) ---
const SegmentBubble: React.FC<{ seg: { speaker: string; text: string }; charName: string }> = ({ seg, charName }) => (
    <div className="animate-fade-in">
        {seg.speaker === 'gm' ? (
            <div className="rounded-xl px-3 py-2 shadow-sm" style={{ background: 'rgba(235,232,238,0.6)', border: '1px solid rgba(180,175,195,0.25)' }}>
                <span className="text-[10px] font-bold mr-1.5 px-1.5 py-0.5 rounded" style={{ color: '#7a7590', background: 'rgba(180,175,195,0.2)' }}>GM</span>
                <span className="text-xs leading-relaxed" style={{ color: '#5a5570' }}>{seg.text}</span>
            </div>
        ) : (
            <div className="rounded-xl px-3 py-2 shadow-sm ml-4" style={{ background: 'linear-gradient(135deg, rgba(245,238,235,0.7), rgba(240,232,230,0.6))', border: '1px solid rgba(200,180,175,0.25)' }}>
                <span className="text-[10px] font-bold mr-1.5 inline-flex items-center gap-0.5" style={{ color: '#9b7a7e' }}><Heart size={10} weight="fill" /> {charName}</span>
                <span className="text-sm leading-relaxed" style={{ color: '#5a4a4e' }}>{seg.text}</span>
            </div>
        )}
    </div>
);

// --- Round Display ---
const RoundDisplay: React.FC<{
    round: GuidebookRound;
    charName: string;
    isLatest: boolean;
    onLongPress?: () => void;
    isReplay?: boolean;
}> = ({ round, charName, isLatest, onLongPress, isReplay }) => {
    const chosen = round.options[round.charChoice];
    const affinityDiff = round.affinityAfter - round.affinityBefore;
    const longPressHandlers = useLongPress(() => onLongPress?.(), 500);
    const [expanded, setExpanded] = useState(false);

    return (
        <div
            className={`${isLatest && !isReplay ? 'animate-fade-in' : ''}`}
            {...(onLongPress ? longPressHandlers : {})}
        >
            <Card className="p-3 space-y-2.5">
                {/* Round header — tap to toggle expand */}
                <button className="w-full flex items-center gap-2" onClick={() => setExpanded(e => !e)}>
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center text-[10px] text-white font-bold shadow-sm" style={{ background: 'linear-gradient(135deg, #b8909a, #a07880)' }}>
                        {round.roundNumber}
                    </div>
                    <div className="h-px flex-1" style={{ background: 'rgba(200,185,190,0.25)' }} />
                    <div className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                        affinityDiff > 0 ? 'bg-emerald-100/60 text-emerald-600' : affinityDiff < 0 ? 'bg-red-100/60 text-red-500' : 'bg-gray-100 text-gray-500'
                    }`}>
                        {affinityDiff >= 0 ? '+' : ''}{affinityDiff}
                    </div>
                    <span className="text-[10px] shrink-0" style={{ color: 'rgba(160,145,150,0.5)' }}>{expanded ? <CaretUp size={12} /> : <CaretDown size={12} />}</span>
                </button>

                {/* GM Narration — always visible */}
                <div className="rounded-lg px-2.5 py-1.5" style={{ background: 'rgba(235,232,238,0.6)', border: '1px solid rgba(180,175,195,0.2)' }}>
                    <span className="text-[9px] font-bold mr-1" style={{ color: '#7a7590' }}>GM</span>
                    <span className="text-[11px]" style={{ color: '#5a5570' }}>{round.gmNarration}</span>
                </div>

                {/* Collapsed summary: chosen option + reaction */}
                {!expanded && (
                    <div className="space-y-1.5">
                        {/* Only show chosen option */}
                        <div className="text-xs px-2.5 py-2 rounded-xl flex items-center gap-2"
                            style={{
                                background: 'linear-gradient(135deg, rgba(245,238,235,0.8), rgba(240,230,228,0.7))',
                                border: '2px solid rgba(196,139,139,0.4)',
                                color: '#5a4a4e',
                            }}>
                            <span className="w-5 h-5 rounded-full bg-white/80 flex items-center justify-center text-[10px] font-bold shrink-0" style={{ border: '1px solid rgba(200,185,190,0.3)' }}>
                                {String.fromCharCode(65 + round.charChoice)}
                            </span>
                            <span className="flex-1 truncate">{chosen?.text}</span>
                            <span className="text-[9px] text-white px-1.5 py-0.5 rounded-full font-bold shrink-0" style={{ background: '#b8909a' }}>
                                <ArrowLeft size={10} className="inline" /> {charName}
                            </span>
                            <span className={`text-[10px] font-mono font-bold shrink-0 ${(chosen?.affinity || 0) >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
                                {(chosen?.affinity || 0) >= 0 ? '+' : ''}{chosen?.affinity}
                            </span>
                        </div>
                        {/* Brief reaction */}
                        <div className="rounded-lg px-2.5 py-1.5" style={{ background: 'linear-gradient(135deg, rgba(245,238,235,0.6), rgba(240,232,230,0.5))', border: '1px solid rgba(200,180,175,0.2)' }}>
                            <span className="font-bold text-[11px] mr-1 inline-flex items-center gap-0.5" style={{ color: '#9b7a7e' }}><Heart size={11} weight="fill" /> {charName}</span>
                            <span className="text-xs" style={{ color: '#5a4a4e' }}>{round.charReaction}</span>
                        </div>
                    </div>
                )}

                {/* Expanded: full details */}
                {expanded && (
                    <>
                        {/* Options */}
                        <div className="space-y-1.5">
                            {round.options.map((opt, i) => (
                                <div key={i} className="text-xs px-2.5 py-2 rounded-xl transition-all flex items-center gap-2"
                                    style={i === round.charChoice ? {
                                        background: 'linear-gradient(135deg, rgba(245,238,235,0.8), rgba(240,230,228,0.7))',
                                        border: '2px solid rgba(196,139,139,0.4)',
                                        color: '#5a4a4e',
                                    } : {
                                        background: 'rgba(255,255,255,0.5)',
                                        border: '1px solid rgba(200,185,190,0.25)',
                                        color: 'rgba(120,105,110,0.5)',
                                    }}>
                                    <span className="w-5 h-5 rounded-full bg-white/80 flex items-center justify-center text-[10px] font-bold shrink-0" style={{ border: '1px solid rgba(200,185,190,0.3)' }}>
                                        {String.fromCharCode(65 + i)}
                                    </span>
                                    <span className="flex-1">{opt.text}</span>
                                    {i === round.charChoice && (
                                        <span className="text-[9px] text-white px-1.5 py-0.5 rounded-full font-bold shrink-0" style={{ background: '#b8909a' }}>
                                            <ArrowLeft size={10} className="inline" /> {charName}
                                        </span>
                                    )}
                                    <span className={`text-[10px] font-mono font-bold shrink-0 ${opt.affinity >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
                                        {opt.affinity >= 0 ? '+' : ''}{opt.affinity}
                                    </span>
                                </div>
                            ))}
                        </div>

                        {/* Inner Thought (now includes prediction) */}
                        <div className="rounded-lg px-2.5 py-2" style={{ background: 'rgba(230,225,238,0.5)', border: '1px solid rgba(185,175,200,0.25)' }}>
                            <div className="text-[9px] font-bold mb-0.5" style={{ color: '#8a80a0' }}>内心 OS &amp; 预判</div>
                            <div className="text-[11px] italic leading-relaxed" style={{ color: '#6a6080' }}>{round.charInnerThought}</div>
                        </div>

                        {/* Score bar */}
                        <div className="flex items-center gap-2">
                            <span className="text-[10px]" style={{ color: 'rgba(140,125,130,0.6)' }}>好感度</span>
                            <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'rgba(230,220,225,0.5)' }}>
                                <div className={`h-full rounded-full transition-all duration-500 ${
                                    affinityDiff > 0 ? 'bg-gradient-to-r from-emerald-300 to-emerald-400' : affinityDiff < 0 ? 'bg-gradient-to-r from-red-300 to-red-400' : 'bg-gray-300'
                                }`} style={{ width: `${Math.min(Math.abs(affinityDiff) * 3, 100)}%` }} />
                            </div>
                            <span className="text-[10px] font-mono" style={{ color: 'rgba(140,125,130,0.5)' }}>{round.affinityBefore}<ArrowRight size={10} className="inline" />{round.affinityAfter}</span>
                        </div>

                        {/* Reaction */}
                        <div className="rounded-lg px-2.5 py-2" style={{ background: 'linear-gradient(135deg, rgba(245,238,235,0.6), rgba(240,232,230,0.5))', border: '1px solid rgba(200,180,175,0.2)' }}>
                            <span className="font-bold text-[11px] mr-1 inline-flex items-center gap-0.5" style={{ color: '#9b7a7e' }}><Heart size={11} weight="fill" /> {charName}</span>
                            <span className="text-xs" style={{ color: '#5a4a4e' }}>{round.charReaction}</span>
                        </div>

                        {/* Insight — char's reading of what user's scoring reveals */}
                        {round.charInsight && (
                            <div className="rounded-xl px-3 py-2.5" style={{ background: 'linear-gradient(135deg, rgba(220,235,248,0.55), rgba(210,228,245,0.45))', border: '1px solid rgba(160,190,220,0.35)' }}>
                                <div className="text-[9px] font-bold mb-1 flex items-center gap-1" style={{ color: '#5a7a9e' }}>
                                    <Diamond size={12} weight="fill" /> 关于你的发现
                                </div>
                                <div className="text-xs leading-relaxed italic" style={{ color: '#3a5a78' }}>
                                    {round.charInsight}
                                </div>
                            </div>
                        )}

                        {/* Exploration */}
                        {round.charExploration && (
                            <div className="rounded-xl px-3 py-2.5" style={{ background: 'linear-gradient(135deg, rgba(240,235,225,0.6), rgba(238,230,218,0.5))', border: '1px solid rgba(210,195,175,0.3)' }}>
                                <div className="text-[9px] font-bold mb-1 flex items-center gap-1" style={{ color: '#a09070' }}>
                                    <Sparkle size={12} weight="fill" /> 深入探讨
                                </div>
                                <div className="text-xs leading-relaxed" style={{ color: '#6a5a45' }}>
                                    <span className="font-bold mr-1" style={{ color: '#8a7a60' }}>{charName}:</span>{round.charExploration}
                                </div>
                            </div>
                        )}
                    </>
                )}
            </Card>
        </div>
    );
};

// --- End Card ---
const EndCard: React.FC<{
    session: GuidebookSession;
    charName: string;
    charAvatar: string;
    onClose: () => void;
    onSendToChat: () => void;
}> = ({ session, charName, charAvatar, onClose, onSendToChat }) => {
    const [expanded, setExpanded] = useState(false);
    if (!session.endCard) return null;
    const { title, finalAffinity, charVerdict, highlights, charSummary } = session.endCard;
    const diff = finalAffinity - session.initialAffinity;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
            <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
            <div className="relative w-full max-w-sm max-h-[85vh] overflow-y-auto no-scrollbar rounded-3xl shadow-xl"
                style={{ background: 'linear-gradient(180deg, #f0ebe8 0%, #fff 20%, #ece6e9 100%)', border: '2px solid rgba(200,185,190,0.4)' }}>
                {/* Header with character */}
                <div className="text-center pt-5 pb-3 px-5 relative">
                    {/* Decorative corners */}
                    <div className="absolute top-2 left-3 text-lg" style={{ color: 'rgba(180,165,170,0.3)' }}><FlowerLotus size={18} /></div>
                    <div className="absolute top-2 right-3 text-lg" style={{ color: 'rgba(180,165,170,0.3)' }}><FlowerLotus size={18} /></div>

                    {charAvatar ? (
                        <TokenImg value={charAvatar} className="w-16 h-16 rounded-2xl object-cover shadow-lg mx-auto mb-2" style={{ boxShadow: '0 0 0 3px rgba(180,165,170,0.35), 0 4px 12px rgba(0,0,0,0.1)' }} />
                    ) : (
                        <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-white text-2xl font-bold shadow-lg mx-auto mb-2" style={{ background: 'linear-gradient(135deg, #b8909a, #a07880)', boxShadow: '0 0 0 3px rgba(180,165,170,0.35)' }}>
                            {charName[0]}
                        </div>
                    )}
                    <div className="text-[10px] font-bold tracking-widest uppercase mb-1" style={{ color: '#9b8a8e' }}>攻略本 · 结算报告</div>
                    <div className="text-xl font-black" style={{ color: '#5a4a50' }}>「{title}」</div>
                </div>

                <div className="px-4 pb-4 space-y-3">
                    {/* Stats */}
                    <Card className="p-3">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="text-sm font-bold" style={{ color: '#5a4a50' }}>{charName}</div>
                                <div className="text-[10px]" style={{ color: '#9b8a8e' }}>{session.rounds.length} 回合</div>
                            </div>
                            <div className="text-right">
                                <div className={`text-2xl font-black ${diff > 0 ? 'text-emerald-500' : diff < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                                    {finalAffinity}
                                </div>
                                <div className="text-[10px]" style={{ color: '#9b8a8e' }}>
                                    {diff >= 0 ? '+' : ''}{diff} 从 {session.initialAffinity}
                                </div>
                            </div>
                        </div>
                        <StatBar label="好感度" value={finalAffinity} color="warm" />
                    </Card>

                    {/* Verdict */}
                    <Card className="p-3">
                        <div className="text-sm leading-relaxed italic" style={{ color: '#5a4a50' }}>
                            "{charVerdict}"
                        </div>
                    </Card>

                    {/* Highlights */}
                    {highlights.length > 0 && (
                        <Card className="p-3 space-y-1.5">
                            <div className="text-[10px] tracking-wider font-bold flex items-center gap-1" style={{ color: '#9b8a8e' }}>
                                <Star size={12} weight="fill" /> 名场面
                            </div>
                            {highlights.map((h, i) => (
                                <div key={i} className="text-xs flex gap-2 rounded-lg p-2" style={{ color: '#5a4a50', background: 'rgba(245,238,235,0.5)' }}>
                                    <span className="shrink-0" style={{ color: '#b8909a' }}><CaretRight size={12} weight="bold" /></span>
                                    <span>{h}</span>
                                </div>
                            ))}
                        </Card>
                    )}

                    {/* New Insight — the discovery of this session */}
                    {session.endCard?.charNewInsight && (
                        <div className="rounded-2xl p-4" style={{ background: 'linear-gradient(135deg, rgba(215,230,248,0.65), rgba(200,220,245,0.5))', border: '1px solid rgba(150,185,225,0.4)' }}>
                            <div className="text-[10px] font-bold flex items-center gap-1 mb-2" style={{ color: '#4a6a92' }}>
                                <Diamond size={12} weight="fill" /> 这局游戏让我发现的你
                            </div>
                            <div className="text-sm leading-relaxed italic" style={{ color: '#2a4a68' }}>
                                {session.endCard.charNewInsight}
                            </div>
                        </div>
                    )}

                    {/* Character Summary */}
                    {charSummary && (
                        <button onClick={() => setExpanded(!expanded)} className="w-full text-left">
                            <div className="rounded-2xl p-3 backdrop-blur-sm transition-all" style={{ background: 'linear-gradient(135deg, rgba(245,238,235,0.6), rgba(235,228,238,0.5))', border: '1px solid rgba(200,185,190,0.25)' }}>
                                <div className="flex items-center justify-between mb-1">
                                    <div className="text-[10px] font-bold flex items-center gap-1" style={{ color: '#9b7a7e' }}>
                                        <Heart size={12} weight="fill" /> {charName}的真心话
                                    </div>
                                    <span className="text-xs" style={{ color: '#b8a0a8' }}>{expanded ? <CaretUp size={12} /> : <CaretDown size={12} />}</span>
                                </div>
                                <div className={`text-sm leading-relaxed ${expanded ? '' : 'line-clamp-2'}`} style={{ color: '#5a4a50' }}>
                                    {charSummary}
                                </div>
                            </div>
                        </button>
                    )}
                </div>

                {/* Actions */}
                <div className="px-4 pb-4 pt-1 flex gap-2 sticky bottom-0"
                    style={{ background: 'linear-gradient(0deg, #ece6e9 0%, transparent 100%)' }}>
                    <button onClick={onClose}
                        className="flex-1 py-2.5 bg-white/80 text-sm font-bold rounded-xl active:scale-95 transition-transform shadow-sm" style={{ color: '#8b7a7e', border: '1px solid rgba(200,185,190,0.3)' }}>
                        关闭
                    </button>
                    <button onClick={onSendToChat}
                        className="flex-1 py-2.5 text-white text-sm font-bold rounded-xl active:scale-95 transition-transform shadow-md" style={{ background: 'linear-gradient(135deg, #b8909a, #a07880)' }}>
                        发送到聊天
                    </button>
                </div>
            </div>
        </div>
    );
};

// --- Session Card ---
const SessionCard: React.FC<{
    session: GuidebookSession;
    char?: CharacterProfile;
    onTap: () => void;
    onLongPress: () => void;
}> = ({ session, char, onTap, onLongPress }) => {
    const diff = session.currentAffinity - session.initialAffinity;
    const longPressHandlers = useLongPress(onLongPress, 500);
    const tappedRef = useRef(false);

    return (
        <Card className="p-3 active:scale-[0.98]"
            onClick={() => { if (!tappedRef.current) onTap(); }}>
            <div {...longPressHandlers}>
                <div className="flex items-center gap-3">
                    {char?.avatar ? (
                        <TokenImg value={char.avatar} className="w-11 h-11 rounded-xl object-cover shadow-sm" style={{ boxShadow: '0 0 0 2px rgba(200,185,190,0.4)' }} />
                    ) : (
                        <div className="w-11 h-11 rounded-xl flex items-center justify-center text-white font-bold shadow-sm" style={{ background: 'linear-gradient(135deg, #b8909a, #a07880)' }}>
                            {char?.name?.[0] || '?'}
                        </div>
                    )}
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-bold truncate" style={{ color: '#5a4a50' }}>{char?.name || '???'}</span>
                            {session.endCard && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded-full font-bold" style={{ background: 'rgba(200,185,190,0.2)', color: '#8b6a6e', border: '1px solid rgba(200,185,190,0.3)' }}>
                                    「{session.endCard.title}」
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[10px]" style={{ color: '#9b8a8e' }}>{fmtDate(session.createdAt)}</span>
                            <span className="text-[10px]" style={{ color: '#c0b0b5' }}>·</span>
                            <span className="text-[10px]" style={{ color: '#9b8a8e' }}>{session.rounds.length}回合</span>
                            <span className="text-[10px]" style={{ color: '#c0b0b5' }}>·</span>
                            <span className={`text-[10px] font-bold`} style={{ color: session.status === 'ended' ? '#9b8a8e' : '#b89a60' }}>
                                {session.status === 'ended' ? '已结算' : '进行中'}
                            </span>
                        </div>
                    </div>
                    <div className="text-right shrink-0">
                        <div className={`text-lg font-black ${diff > 0 ? 'text-emerald-500' : diff < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                            {session.currentAffinity}
                        </div>
                        <div className="text-[10px]" style={{ color: '#9b8a8e' }}>
                            {diff >= 0 ? '+' : ''}{diff}
                        </div>
                    </div>
                </div>
            </div>
        </Card>
    );
};

// ===== MAIN APP =====
const GuidebookApp: React.FC = () => {
    const { closeApp, characters, userProfile, apiConfig, addToast, updateCharacter } = useOS();

    // View State
    const [view, setView] = useState<'lobby' | 'setup' | 'opening' | 'playing' | 'replay'>('lobby');
    const [session, setSession] = useState<GuidebookSession | null>(null);
    const [savedSessions, setSavedSessions] = useState<GuidebookSession[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');

    // Setup State
    const [selectedCharId, setSelectedCharId] = useState('');
    const [initialAffinity, setInitialAffinity] = useState(50);
    const [maxRounds, setMaxRounds] = useState(5);
    const [scenarioHint, setScenarioHint] = useState('');

    // Tutorial modal
    const [showTutorial, setShowTutorial] = useState(false);

    // Option edit overlay (tap to expand for mobile editing)
    const [editingOptIdx, setEditingOptIdx] = useState<number | null>(null);
    const [editOptText, setEditOptText] = useState('');
    const [editOptScore, setEditOptScore] = useState('');

    // Scenario edit overlay (tap to expand)
    const [editingScenario, setEditingScenario] = useState(false);
    const [editScenarioText, setEditScenarioText] = useState('');

    // Direction hint for next round
    const [nextDirectionHint, setNextDirectionHint] = useState('');

    // Exit confirm (replaces window.confirm on back)
    const [showExitConfirm, setShowExitConfirm] = useState(false);

    // Round Input State (manual mode)
    const [optionTexts, setOptionTexts] = useState(['', '', '']);
    const [optionScores, setOptionScores] = useState([0, 0, 0]);
    const [roundScenario, setRoundScenario] = useState('');

    // Cached recent messages
    const [cachedRecentMsgs, setCachedRecentMsgs] = useState('');

    // Opening segments
    const [openingSegments, setOpeningSegments] = useState<{ speaker: string; text: string }[]>([]);
    const [openingDone, setOpeningDone] = useState(false);

    // End card / warnings
    const [showEndCard, setShowEndCard] = useState(false);
    const [showExceedWarning, setShowExceedWarning] = useState(false);

    // Round context menu
    const [contextMenuRound, setContextMenuRound] = useState<number | null>(null);

    // Delete session confirm
    const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);

    // Input area collapsed
    const [inputCollapsed, setInputCollapsed] = useState(false);

    // Scroll ref
    const logsRef = useRef<HTMLDivElement>(null);

    // Load saved sessions
    useEffect(() => { loadSessions(); }, []);

    const loadSessions = async () => {
        const list = await DB.getAllGuidebookSessions();
        setSavedSessions(list.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt));
    };

    // Auto-scroll
    useEffect(() => {
        if (logsRef.current && (view === 'playing' || view === 'replay')) {
            setTimeout(() => {
                logsRef.current?.scrollTo({ top: logsRef.current.scrollHeight, behavior: 'smooth' });
            }, 100);
        }
    }, [session?.rounds, isLoading, view]);

    // Auto-save session
    const saveSession = useCallback(async (s: GuidebookSession) => {
        await DB.saveGuidebookSession(s);
        loadSessions();
    }, []);

    const selectedChar = characters.find(c => c.id === selectedCharId);

    // --- Start Game ---
    const handleStartGame = async () => {
        if (!selectedCharId) { addToast('请先选择角色', 'error'); return; }

        trackEvent('开始一局攻略');
        setIsLoading(true);
        setError('');

        const char = characters.find(c => c.id === selectedCharId)!;
        const recentMsgs = await fetchRecentMessages(selectedCharId);
        setCachedRecentMsgs(recentMsgs);

        const newSession: GuidebookSession = {
            id: genId(),
            charId: selectedCharId,
            initialAffinity,
            currentAffinity: initialAffinity,
            maxRounds,
            currentRound: 0,
            mode: 'manual' as const,
            scenarioHint: scenarioHint || undefined,
            rounds: [],
            status: 'opening',
            createdAt: Date.now(),
            lastPlayedAt: Date.now(),
        };
        setSession(newSession);

        try {
            await injectMemoryPalace(char, undefined, scenarioHint || undefined);
            const prompt = buildOpeningPrompt(char, userProfile, initialAffinity, scenarioHint, 'manual', recentMsgs, char.guidebookInsights);
            const raw = await callAPI(apiConfig, prompt);
            let data = extractJson(raw);

            // Flexible segment extraction: try multiple paths
            let rawSegs: any[] | null = null;
            if (Array.isArray(data?.segments)) rawSegs = data.segments;
            else if (Array.isArray(data)) rawSegs = data; // bare array
            else if (data && typeof data === 'object') {
                // Look for any array field that looks like segments
                for (const val of Object.values(data)) {
                    if (Array.isArray(val) && val.length >= 2 && val[0] && (val[0].text || val[0].content)) {
                        rawSegs = val;
                        break;
                    }
                }
            }
            // Also try re-parsing raw as array if extractJson returned object without segments
            if (!rawSegs) {
                try {
                    const arrMatch = raw.match(/\[[\s\S]*\]/);
                    if (arrMatch) {
                        const arr = JSON.parse(arrMatch[0]);
                        if (Array.isArray(arr) && arr.length >= 2 && arr[0]?.text) rawSegs = arr;
                    }
                } catch {}
            }

            const segments = rawSegs?.filter((s: any) => s && (typeof s.text === 'string' || typeof s.content === 'string'));
            if (segments && segments.length > 0) {
                // Normalize: accept text or content field, speaker/role field
                const cleaned = segments.map((s: any) => ({
                    speaker: (s.speaker === 'char' || s.role === 'char') ? 'char' : 'gm',
                    text: String(s.text || s.content || ''),
                }));
                setOpeningSegments(cleaned);
                const updated = { ...newSession, openingSequence: JSON.stringify(cleaned) };
                setSession(updated);
                await saveSession(updated);
                setView('opening');
            } else {
                throw new Error('AI 返回格式不正确，请重试');
            }
        } catch (e: any) {
            setError(e.message);
            setView('setup');
        } finally {
            setIsLoading(false);
        }
    };

    // --- Opening Done ---
    const handleOpeningDone = () => {
        setOpeningDone(true);
        if (session) {
            const updated = { ...session, status: 'playing' as const };
            setSession(updated);
            saveSession(updated);
        }
        setView('playing');
    };

    // --- AI Assist ---
    const handleAIAssist = async () => {
        if (!session || !selectedChar) return;
        trackEvent('让 AI 帮写本回合选项');
        setIsLoading(true);
        setError('');
        const wc = extractWorldContext(session.openingSequence);
        try {
            await injectMemoryPalace(selectedChar, undefined, session.scenarioHint || undefined);
            const prompt = buildOptionAssistPrompt(
                selectedChar, userProfile, session.currentAffinity,
                session.currentRound + 1, session.rounds, session.scenarioHint || '',
                cachedRecentMsgs, wc, nextDirectionHint || undefined
            );
            const raw = await callAPI(apiConfig, prompt);
            const data = extractJson(raw);
            // Flexible: try data.options, or any array field with 3+ items that have text
            let opts: any[] | null = null;
            if (Array.isArray(data?.options) && data.options.length >= 3) opts = data.options;
            else if (data && typeof data === 'object') {
                for (const val of Object.values(data)) {
                    if (Array.isArray(val) && val.length >= 3 && (val as any[])[0]?.text) { opts = val as any[]; break; }
                }
            }
            if (opts && opts.length >= 3 && opts.slice(0, 3).every((o: any) => o && (o.text || o.content))) {
                setOptionTexts(opts.slice(0, 3).map((o: any) => String(o.text || o.content || '')));
                setOptionScores(opts.slice(0, 3).map((o: any) => Number(o.affinity || o.score || o.value) || 0));
                if (data.scenario || data.scene) setRoundScenario(String(data.scenario || data.scene));
            } else {
                throw new Error('AI 生成的选项格式不正确，请重试');
            }
        } catch (e: any) { setError(e.message); }
        finally { setIsLoading(false); }
    };

    // --- Submit Round (shared logic) ---
    const processRoundResult = async (data: any, options: GuidebookOption[], roundNum: number) => {
        if (!session) return;
        // Robust choice extraction: handle number, string number, "A"/"B"/"C", letter in text
        let rawChoice: number;
        const c = data.choice;
        if (typeof c === 'number') rawChoice = c;
        else if (typeof c === 'string') {
            const upper = c.trim().toUpperCase();
            if (upper === 'A' || upper.includes('A')) rawChoice = 0;
            else if (upper === 'B' || upper.includes('B')) rawChoice = 1;
            else if (upper === 'C' || upper.includes('C')) rawChoice = 2;
            else rawChoice = parseInt(c, 10);
        } else rawChoice = 0;
        const choiceIdx = Math.min(Math.max(isNaN(rawChoice) ? 0 : Math.round(rawChoice), 0), 2);
        const affinityChange = options[choiceIdx].affinity;
        const newAffinity = session.currentAffinity + affinityChange;

        const round: GuidebookRound = {
            id: genId(),
            roundNumber: roundNum,
            scenario: roundScenario || String(data.gm_narration || ''),
            options,
            gmNarration: String(data.gm_narration || ''),
            charInnerThought: String(data.inner_thought || ''),
            charChoice: choiceIdx,
            charReaction: String(data.reaction || ''),
            charExploration: data.exploration ? String(data.exploration) : undefined,
            charInsight: data.char_insight ? String(data.char_insight) : undefined,
            affinityBefore: session.currentAffinity,
            affinityAfter: newAffinity,
            timestamp: Date.now(),
        };

        const updated: GuidebookSession = {
            ...session,
            currentAffinity: newAffinity,
            currentRound: roundNum,
            rounds: [...session.rounds, round],
            lastPlayedAt: Date.now(),
        };
        setSession(updated);
        await saveSession(updated);

        // Pre-fill next round options from AI suggestions (bundled with round result)
        const nextOpts = data.next_options?.options || data.nextOptions?.options;
        if (Array.isArray(nextOpts) && nextOpts.length >= 3 && nextOpts.slice(0, 3).every((o: any) => o && (o.text || o.content))) {
            setOptionTexts(nextOpts.slice(0, 3).map((o: any) => String(o.text || o.content || '')));
            setOptionScores(nextOpts.slice(0, 3).map((o: any) => Number(o.affinity || o.score || o.value) || 0));
            const nextScenario = data.next_options?.scenario || data.nextOptions?.scenario;
            if (nextScenario) setRoundScenario(String(nextScenario));
        } else {
            setOptionTexts(['', '', '']);
            setOptionScores([0, 0, 0]);
            setRoundScenario('');
        }
        setNextDirectionHint('');

        if (roundNum >= session.maxRounds) setShowExceedWarning(true);
    };

    const handleSubmitRound = async () => {
        if (!session || !selectedChar) return;
        if (optionTexts.some(t => !t.trim())) { addToast('请填写所有选项', 'error'); return; }
        setIsLoading(true);
        setError('');
        const roundNum = session.currentRound + 1;
        const options: GuidebookOption[] = optionTexts.map((text, i) => ({ text: text.trim(), affinity: optionScores[i] }));
        const wc = extractWorldContext(session.openingSequence);

        try {
            await injectMemoryPalace(selectedChar, undefined, roundScenario || session.scenarioHint || undefined);
            const prompt = buildRoundPrompt(
                selectedChar, userProfile, session.currentAffinity,
                roundNum, session.maxRounds, options, session.rounds, session.scenarioHint || '',
                cachedRecentMsgs, wc, nextDirectionHint || undefined, roundScenario || undefined
            );
            const raw = await callAPI(apiConfig, prompt);
            const data = extractJson(raw);
            const choice = data?.choice;
            // Accept number, string number, or letter A/B/C
            const hasChoice = data && (typeof choice === 'number' || (typeof choice === 'string' && choice.trim().length > 0));
            if (hasChoice) {
                await processRoundResult(data, options, roundNum);
            } else throw new Error('AI 返回格式不正确，请重试');
        } catch (e: any) { setError(e.message); }
        finally { setIsLoading(false); }
    };


    // --- Regenerate from round ---
    const handleRegenerateFrom = async (roundIdx: number) => {
        if (!session || !selectedChar) return;
        trackEvent('从某回合重新生成');
        setContextMenuRound(null);

        // Restore input fields from the round being regenerated
        const targetRound = session.rounds[roundIdx];
        if (targetRound) {
            setOptionTexts(targetRound.options.map(o => o.text));
            setOptionScores(targetRound.options.map(o => o.affinity));
            setRoundScenario(targetRound.scenario || '');
        }

        const trimmedRounds = session.rounds.slice(0, roundIdx);
        const prevAffinity = roundIdx > 0 ? session.rounds[roundIdx - 1].affinityAfter : session.initialAffinity;
        const updated: GuidebookSession = {
            ...session,
            rounds: trimmedRounds,
            currentRound: roundIdx,
            currentAffinity: prevAffinity,
            lastPlayedAt: Date.now(),
        };
        setSession(updated);
        await saveSession(updated);
    };

    // --- Delete round ---
    const handleDeleteFrom = async (roundIdx: number) => {
        if (!session) return;
        trackEvent('删掉某回合之后的内容');
        setContextMenuRound(null);

        // Restore input fields from the deleted round
        const targetRound = session.rounds[roundIdx];
        if (targetRound) {
            setOptionTexts(targetRound.options.map(o => o.text));
            setOptionScores(targetRound.options.map(o => o.affinity));
            setRoundScenario(targetRound.scenario || '');
        }

        const trimmedRounds = session.rounds.slice(0, roundIdx);
        const prevAffinity = roundIdx > 0 ? session.rounds[roundIdx - 1].affinityAfter : session.initialAffinity;
        const updated: GuidebookSession = {
            ...session, rounds: trimmedRounds, currentRound: roundIdx,
            currentAffinity: prevAffinity, lastPlayedAt: Date.now(),
        };
        setSession(updated);
        await saveSession(updated);
    };

    // --- End Game ---
    const handleEndGame = async () => {
        if (!session || !selectedChar) return;
        trackEvent('结束本局出结算卡');
        setIsLoading(true);
        setError('');
        setShowExceedWarning(false);

        try {
            await injectMemoryPalace(selectedChar, undefined, session.scenarioHint || undefined);
            const prompt = buildEndCardPrompt(
                selectedChar, userProfile,
                session.initialAffinity, session.currentAffinity, session.rounds,
                cachedRecentMsgs
            );
            const raw = await callAPI(apiConfig, prompt);
            const data = extractJson(raw);

            if (data) {
                const newInsight = String(data.charNewInsight || data.char_new_insight || '') || undefined;
                const rawHighlights = data.highlights;
                const highlights = Array.isArray(rawHighlights) ? rawHighlights.map((h: any) => String(h)) : [];
                const updated: GuidebookSession = {
                    ...session,
                    status: 'ended',
                    endCard: {
                        finalAffinity: session.currentAffinity,
                        charVerdict: String(data.verdict || data.charVerdict || ''),
                        title: String(data.title || '???'),
                        highlights,
                        charSummary: String(data.charSummary || data.char_summary || '') || undefined,
                        charNewInsight: newInsight,
                    },
                    lastPlayedAt: Date.now(),
                };
                setSession(updated);
                await saveSession(updated);

                // Persist insight to character for cross-session awareness
                if (newInsight && selectedChar) {
                    const prev = selectedChar.guidebookInsights || [];
                    updateCharacter(selectedChar.id, {
                        guidebookInsights: [...prev, newInsight].slice(-8), // keep last 8
                    });
                }

                setShowEndCard(true);
            } else throw new Error('AI 返回格式不正确');
        } catch (e: any) { setError(e.message); }
        finally { setIsLoading(false); }
    };

    // --- Send to Chat ---
    const handleSendToChat = async () => {
        if (!session?.endCard || !selectedChar) return;
        const card = session.endCard;

        const cardData = {
            type: 'guidebook_card',
            title: card.title,
            charName: selectedChar.name,
            charAvatar: selectedChar.avatar || '',
            initialAffinity: session.initialAffinity,
            finalAffinity: card.finalAffinity,
            charVerdict: card.charVerdict,
            charNewInsight: card.charNewInsight || '',
            rounds: session.rounds.length,
        };

        try {
            await DB.saveMessage({
                charId: selectedChar.id,
                role: 'system',
                type: 'score_card',
                content: JSON.stringify(cardData),
                metadata: { scoreCard: cardData },
            });
            trackEvent('把结算卡发到聊天');
            addToast('已发送到聊天', 'success');
            setShowEndCard(false);
        } catch (e: any) { addToast('发送失败: ' + e.message, 'error'); }
    };

    // --- Delete Session ---
    const handleDeleteSession = async (id: string) => {
        await DB.deleteGuidebookSession(id);
        trackEvent('删除一份攻略存档');
        setDeleteSessionId(null);
        loadSessions();
        if (session?.id === id) {
            setSession(null);
            setView('lobby');
        }
        addToast('已删除', 'success');
    };

    // --- Open Replay ---
    const openReplay = (s: GuidebookSession) => {
        setSession(s);
        setSelectedCharId(s.charId);
        if (s.openingSequence) {
            try { setOpeningSegments(JSON.parse(s.openingSequence)); } catch { setOpeningSegments([]); }
        } else { setOpeningSegments([]); }

        if (s.status === 'ended') {
            setView('replay');
        } else {
            setCachedRecentMsgs('');
            const resumeChar = characters.find(c => c.id === s.charId);
            fetchRecentMessages(s.charId).then(setCachedRecentMsgs);
            setView('playing');
        }
    };

    // --- Go back to lobby ---
    const backToLobby = () => {
        setSession(null);
        setOpeningDone(false);
        setOpeningSegments([]);
        setError('');
        setView('lobby');
        loadSessions();
    };

    // ============ RENDER: LOBBY ============
    if (view === 'lobby') {
        return (
            <GameFrame>
                {/* Cinematic header - no standard GameHeader */}
                <div className="shrink-0 relative overflow-hidden" style={{ background: 'linear-gradient(135deg, rgba(30,20,40,0.85) 0%, rgba(60,30,50,0.7) 50%, rgba(40,20,50,0.85) 100%)', paddingTop: 'var(--safe-top)' }}>
                    <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'repeating-linear-gradient(90deg, transparent, transparent 3px, rgba(255,255,255,0.03) 3px, rgba(255,255,255,0.03) 4px)' }} />
                    <div className="flex items-center gap-3 px-4 py-3 relative z-10">
                        <button onClick={closeApp} className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-white/60 text-xs active:scale-90 transition-transform backdrop-blur-sm border border-white/10">
                            <ArrowLeft size={14} />
                        </button>
                        <div className="flex-1">
                            <div className="text-xs tracking-[0.3em] text-white/40 font-light" style={{ fontFamily: 'Georgia, serif' }}>CHARACTER SELECT</div>
                            <div className="text-base font-bold text-white/90 tracking-wider mt-0.5">攻略本</div>
                        </div>
                        <button onClick={() => { trackEvent('打开玩法说明'); setShowTutorial(true); }} className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-white/50 text-xs font-bold active:scale-90 transition-transform backdrop-blur-sm border border-white/10">
                            ?
                        </button>
                    </div>
                    {/* Decorative bottom line */}
                    <div className="h-px" style={{ background: 'linear-gradient(90deg, transparent 0%, rgba(244,143,177,0.4) 30%, rgba(167,139,250,0.4) 70%, transparent 100%)' }} />
                </div>

                <div className="flex-1 overflow-y-auto no-scrollbar">
                    {/* Title area */}
                    <div className="px-5 pt-5 pb-2">
                        <div className="text-[9px] tracking-[0.25em] text-pink-400/50 font-light mb-1" style={{ fontFamily: 'Georgia, serif' }}>— SELECT YOUR TARGET —</div>
                        <div className="text-pink-700/70 text-xs">选择攻略你的角色</div>
                    </div>

                    {/* Character Banners */}
                    <div className="px-4 pb-3 space-y-3">
                        {characters.map((c, idx) => {
                            const charSessions = savedSessions.filter(s => s.charId === c.id);
                            const lastSession = charSessions[0];
                            const isEven = idx % 2 === 0;
                            return (
                                <button
                                    key={c.id}
                                    onClick={() => { trackEvent('选择攻略角色进入配置页'); setSelectedCharId(c.id); setView('setup'); }}
                                    className="w-full block relative overflow-hidden active:scale-[0.97] transition-all duration-200 group"
                                    style={{ borderRadius: '4px' }}
                                >
                                    {/* Banner container */}
                                    <div className="relative h-[100px] overflow-hidden" style={{ borderRadius: '4px' }}>
                                        {/* Background - avatar as cinematic crop or gradient */}
                                        {c.avatar ? (
                                            <TokenImg value={c.avatar}
                                                className="absolute inset-0 w-full h-full object-cover"
                                                style={{
                                                    objectPosition: isEven ? 'center 20%' : 'center 30%',
                                                    filter: 'brightness(0.7) contrast(1.1) saturate(1.2)',
                                                }}
                                            />
                                        ) : (
                                            <div className="absolute inset-0" style={{
                                                background: `linear-gradient(${isEven ? '135deg' : '225deg'}, #4a1942 0%, #2d1b4e 40%, #1a1a2e 100%)`
                                            }} />
                                        )}

                                        {/* Gradient overlays */}
                                        <div className="absolute inset-0" style={{
                                            background: isEven
                                                ? 'linear-gradient(90deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.2) 40%, transparent 70%)'
                                                : 'linear-gradient(270deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.2) 40%, transparent 70%)'
                                        }} />
                                        {/* Bottom vignette */}
                                        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.4) 100%)' }} />

                                        {/* Decorative scan line */}
                                        <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.5) 2px, rgba(255,255,255,0.5) 3px)' }} />

                                        {/* Portrait avatar - opposite side of text */}
                                        <div className={`absolute top-1/2 -translate-y-1/2 ${isEven ? 'right-3' : 'left-3'} z-10`}>
                                            {c.avatar ? (
                                                <div className="relative">
                                                    <TokenImg value={c.avatar}
                                                        className="w-[60px] h-[60px] rounded-full object-cover shadow-lg"
                                                        style={{
                                                            border: '2px solid rgba(255,255,255,0.2)',
                                                            boxShadow: '0 4px 16px rgba(0,0,0,0.3), inset 0 0 0 1px rgba(255,255,255,0.1)',
                                                        }}
                                                    />
                                                    {/* Ring glow */}
                                                    <div className="absolute inset-0 rounded-full" style={{
                                                        boxShadow: '0 0 12px rgba(244,143,177,0.25), 0 0 4px rgba(167,139,250,0.15)',
                                                    }} />
                                                </div>
                                            ) : (
                                                <div className="w-[60px] h-[60px] rounded-full flex items-center justify-center text-white/70 text-xl font-bold shadow-lg"
                                                    style={{
                                                        background: 'linear-gradient(135deg, rgba(100,60,120,0.8) 0%, rgba(60,40,80,0.9) 100%)',
                                                        border: '2px solid rgba(255,255,255,0.15)',
                                                        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
                                                    }}>
                                                    {c.name[0]}
                                                </div>
                                            )}
                                        </div>

                                        {/* Content overlay */}
                                        <div className={`absolute inset-0 flex flex-col justify-end p-3 ${isEven ? 'items-start pr-20' : 'items-end text-right pl-20'}`}>
                                            {/* Index number - decorative */}
                                            <div className={`absolute top-2 ${isEven ? 'left-3' : 'right-3'} text-[10px] text-white/20 tracking-widest font-light`} style={{ fontFamily: 'monospace' }}>
                                                {String(idx + 1).padStart(2, '0')}
                                            </div>

                                            {/* Name */}
                                            <div className="text-white font-bold text-lg tracking-wide leading-tight" style={{ textShadow: '0 2px 12px rgba(0,0,0,0.5)' }}>
                                                {c.name}
                                            </div>

                                            {/* Description line */}
                                            <div className="text-white/50 text-[10px] mt-0.5 leading-tight max-w-[85%] truncate">
                                                {c.description ? c.description.slice(0, 25) : '这次，轮到 ta 来攻略你。'}
                                            </div>

                                            {/* Session badge */}
                                            {charSessions.length > 0 && (
                                                <div className={`flex items-center gap-1.5 mt-1 ${isEven ? '' : 'flex-row-reverse'}`}>
                                                    <div className="h-px w-3 bg-pink-300/40" />
                                                    <span className="text-[8px] text-pink-200/50 tracking-wider">
                                                        {charSessions.length}回攻略{lastSession?.endCard ? ` ·「${lastSession.endCard.title}」` : ''}
                                                    </span>
                                                </div>
                                            )}
                                        </div>

                                        {/* Corner accent */}
                                        <div className={`absolute top-0 ${isEven ? 'right-0' : 'left-0'}`}>
                                            <div className="w-6 h-6 border-t border-r border-white/15" style={{ borderRadius: '0 4px 0 0' }} />
                                        </div>

                                        {/* Hover/active glow */}
                                        <div className="absolute inset-0 bg-pink-400/0 group-active:bg-pink-400/10 transition-colors duration-200" style={{ borderRadius: '4px' }} />
                                    </div>

                                    {/* Thin accent line under each card */}
                                    <div className="h-[2px] mt-0.5" style={{
                                        background: isEven
                                            ? 'linear-gradient(90deg, rgba(244,143,177,0.5) 0%, rgba(167,139,250,0.3) 50%, transparent 100%)'
                                            : 'linear-gradient(270deg, rgba(244,143,177,0.5) 0%, rgba(167,139,250,0.3) 50%, transparent 100%)'
                                    }} />
                                </button>
                            );
                        })}
                    </div>

                    {characters.length === 0 && (
                        <div className="text-center py-16 px-6">
                            <div className="text-[10px] tracking-[0.3em] mb-2" style={{ fontFamily: 'Georgia, serif', color: 'rgba(180,165,170,0.3)' }}>NO CHARACTERS FOUND</div>
                            <div className="text-xs" style={{ color: 'rgba(160,145,150,0.5)' }}>还没有角色，先去创建一个吧</div>
                        </div>
                    )}

                    {/* Session History - collapsible section */}
                    {savedSessions.length > 0 && (
                        <div className="px-4 pb-4 mt-2">
                            {/* Section divider */}
                            <div className="flex items-center gap-2 mb-3 px-1">
                                <div className="h-px flex-1" style={{ background: 'linear-gradient(90deg, transparent 0%, rgba(244,143,177,0.25) 50%, transparent 100%)' }} />
                                <span className="text-[8px] tracking-[0.3em] text-pink-400/40" style={{ fontFamily: 'Georgia, serif' }}>HISTORY</span>
                                <div className="h-px flex-1" style={{ background: 'linear-gradient(90deg, transparent 0%, rgba(244,143,177,0.25) 50%, transparent 100%)' }} />
                            </div>
                            <div className="space-y-2">
                                {savedSessions.map(s => (
                                    <SessionCard
                                        key={s.id}
                                        session={s}
                                        char={characters.find(c => c.id === s.charId)}
                                        onTap={() => { trackEvent('回放历史攻略存档'); openReplay(s); }}
                                        onLongPress={() => setDeleteSessionId(s.id)}
                                    />
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Tutorial Modal */}
                {showTutorial && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-5">
                        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setShowTutorial(false)} />
                        <div className="relative w-full max-w-sm rounded-3xl overflow-hidden shadow-2xl" style={{ background: 'linear-gradient(160deg, #2a1a2e 0%, #1a1228 60%, #221530 100%)', border: '1px solid rgba(244,143,177,0.15)' }}>
                            {/* Header */}
                            <div className="px-5 pt-5 pb-3" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                                <div className="text-[9px] tracking-[0.3em] text-pink-400/50 mb-1" style={{ fontFamily: 'Georgia, serif' }}>HOW TO PLAY</div>
                                <div className="text-lg font-bold text-white/90">攻略本 · 玩法说明</div>
                            </div>
                            {/* Content */}
                            <div className="px-5 py-4 space-y-3.5 max-h-[65vh] overflow-y-auto no-scrollbar">
                                {[
                                    { icon: <Sparkle size={14} weight="fill" />, title: '基本概念', desc: '你是出题人，角色是答题者。每回合你设计三个行为选项（含好感度分值），AI角色会根据自己的性格选一个——你需要猜到她会选哪个！' },
                                    { icon: <Heart size={14} weight="fill" />, title: '好感度系统', desc: '每个选项对应一个分值（可以是负数）。角色选择后，分值累加到当前好感度。结局好坏取决于最终好感度。' },
                                    { icon: <FlowerLotus size={14} weight="fill" />, title: 'AI 一键填入', desc: '不知道出什么题？点"AI 一键填入"，AI会根据当前剧情自动帮你生成三个选项和分值，你可以直接用或者修改。' },
                                    { icon: <Star size={14} weight="fill" />, title: '点击选项快速编辑', desc: '游戏过程中，点击任意选项（A/B/C）可以在弹出框里快速编辑内容和分值，手机党友好！' },
                                    { icon: <DiamondsFour size={14} weight="fill" />, title: '幻想场景', desc: '开始时可以设定一个场景背景（比如异世界冒险、校园日常），AI会据此生成开场白并保持世界观一致。' },
                                    { icon: <Cards size={14} weight="fill" />, title: '结算卡片', desc: '游戏结束后生成结算卡，包含角色的真实评语和本局高光时刻，还可以发送到聊天。' },
                                ].map((item, i) => (
                                    <div key={i} className="flex gap-3">
                                        <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs shrink-0 mt-0.5" style={{ background: 'rgba(244,143,177,0.15)', color: '#f48fb1' }}>{item.icon}</div>
                                        <div>
                                            <div className="text-xs font-bold text-white/80 mb-0.5">{item.title}</div>
                                            <div className="text-[11px] leading-relaxed text-white/45">{item.desc}</div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            {/* Close */}
                            <div className="px-5 pb-5 pt-3">
                                <button onClick={() => setShowTutorial(false)} className="w-full py-2.5 rounded-2xl text-sm font-bold active:scale-95 transition-transform" style={{ background: 'linear-gradient(135deg, rgba(244,143,177,0.25), rgba(167,139,250,0.2))', color: '#f48fb1', border: '1px solid rgba(244,143,177,0.2)' }}>
                                    明白了！开始攻略 <ArrowRight size={14} className="inline" />
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Delete Confirm */}
                {deleteSessionId && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
                        <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={() => setDeleteSessionId(null)} />
                        <Card className="relative p-5 max-w-xs w-full space-y-3">
                            <div className="font-bold text-sm text-center" style={{ color: '#5a4a50' }}>删除这条记录？</div>
                            <div className="flex gap-2">
                                <button onClick={() => setDeleteSessionId(null)} className="flex-1 py-2.5 bg-white/80 text-xs font-bold rounded-xl active:scale-95 transition-transform" style={{ color: '#8b7a7e', border: '1px solid rgba(200,185,190,0.3)' }}>取消</button>
                                <button onClick={() => handleDeleteSession(deleteSessionId)} className="flex-1 py-2.5 bg-red-400 text-white text-xs font-bold rounded-xl active:scale-95 transition-transform shadow-sm">删除</button>
                            </div>
                        </Card>
                    </div>
                )}
            </GameFrame>
        );
    }

    // ============ RENDER: SETUP ============
    if (view === 'setup') {
        const setupChar = characters.find(c => c.id === selectedCharId);
        return (
            <GameFrame>
                {/* Cinematic header matching lobby style */}
                <div className="shrink-0 relative overflow-hidden" style={{ background: 'linear-gradient(135deg, rgba(30,20,40,0.85) 0%, rgba(60,30,50,0.7) 50%, rgba(40,20,50,0.85) 100%)', paddingTop: 'var(--safe-top)' }}>
                    <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'repeating-linear-gradient(90deg, transparent, transparent 3px, rgba(255,255,255,0.03) 3px, rgba(255,255,255,0.03) 4px)' }} />
                    <div className="flex items-center gap-3 px-4 py-3 relative z-10">
                        <button onClick={backToLobby} className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-white/60 text-xs active:scale-90 transition-transform backdrop-blur-sm border border-white/10">
                            <ArrowLeft size={14} />
                        </button>
                        <div className="flex-1">
                            <div className="text-xs tracking-[0.3em] text-white/40 font-light" style={{ fontFamily: 'Georgia, serif' }}>GAME SETUP</div>
                            <div className="text-base font-bold text-white/90 tracking-wider mt-0.5">新游戏</div>
                        </div>
                    </div>
                    <div className="h-px" style={{ background: 'linear-gradient(90deg, transparent 0%, rgba(196,139,139,0.4) 30%, rgba(185,163,187,0.4) 70%, transparent 100%)' }} />
                </div>

                <div className="flex-1 overflow-y-auto no-scrollbar">
                    {/* Character Showcase Banner */}
                    {setupChar && (
                        <div className="mx-4 mt-4 relative overflow-hidden" style={{ borderRadius: '16px' }}>
                            <div className="relative h-[88px] overflow-hidden" style={{ borderRadius: '16px' }}>
                                {/* Background - avatar cinematic crop */}
                                {setupChar.avatar ? (
                                    <TokenImg value={setupChar.avatar}
                                        className="absolute inset-0 w-full h-full object-cover"
                                        style={{ objectPosition: 'center 25%', filter: 'brightness(0.6) contrast(1.1) saturate(1.3) blur(1px)' }}
                                    />
                                ) : (
                                    <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, #4a1942 0%, #2d1b4e 40%, #1a1a2e 100%)' }} />
                                )}
                                {/* Overlay gradient */}
                                <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.15) 50%, rgba(0,0,0,0.3) 100%)' }} />
                                <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, transparent 30%, rgba(0,0,0,0.4) 100%)' }} />

                                {/* Content */}
                                <div className="absolute inset-0 flex items-center gap-3 px-4">
                                    {/* Portrait */}
                                    {setupChar.avatar ? (
                                        <TokenImg value={setupChar.avatar} className="w-14 h-14 rounded-full object-cover shrink-0 shadow-lg"
                                            style={{ border: '2px solid rgba(255,255,255,0.25)', boxShadow: '0 4px 16px rgba(0,0,0,0.3), 0 0 12px rgba(196,139,139,0.2)' }} />
                                    ) : (
                                        <div className="w-14 h-14 rounded-full flex items-center justify-center text-white/70 text-xl font-bold shrink-0 shadow-lg"
                                            style={{ background: 'linear-gradient(135deg, rgba(100,60,120,0.8), rgba(60,40,80,0.9))', border: '2px solid rgba(255,255,255,0.15)' }}>
                                            {setupChar.name[0]}
                                        </div>
                                    )}
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[9px] tracking-[0.2em] text-pink-200/40" style={{ fontFamily: 'Georgia, serif' }}>TARGET</div>
                                        <div className="text-white font-bold text-lg tracking-wide" style={{ textShadow: '0 2px 8px rgba(0,0,0,0.4)' }}>
                                            {setupChar.name}
                                        </div>
                                        <div className="text-white/40 text-[10px] truncate mt-0.5">
                                            {setupChar.description ? setupChar.description.slice(0, 30) : '准备被攻略…'}
                                        </div>
                                    </div>
                                </div>
                            </div>
                            {/* Accent line */}
                            <div className="h-[2px]" style={{ background: 'linear-gradient(90deg, rgba(196,139,139,0.5) 0%, rgba(185,163,187,0.4) 50%, transparent 100%)' }} />
                        </div>
                    )}

                    {/* Settings Area - Morandi dusty pink palette */}
                    <div className="px-4 pt-4 pb-3 space-y-3">
                        {/* Initial Affinity */}
                        <div className="relative rounded-2xl overflow-hidden" style={{ background: 'rgba(245,238,235,0.7)', backdropFilter: 'blur(8px)', border: '1.5px solid rgba(200,180,175,0.25)' }}>
                            <div className="p-3.5 space-y-2.5">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-1.5">
                                        <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px]" style={{ background: 'linear-gradient(135deg, #d4a0a0, #c48b8b)', color: 'white' }}><Heart size={12} weight="fill" /></div>
                                        <span className="text-xs font-bold" style={{ color: '#8b6f6f' }}>初始好感度</span>
                                    </div>
                                    <div className="px-2.5 py-0.5 rounded-full text-xs font-bold" style={{ color: '#9b7a7a', background: 'rgba(212,160,160,0.15)', border: '1px solid rgba(200,180,175,0.2)' }}>
                                        {initialAffinity}
                                    </div>
                                </div>
                                <div className="flex items-center gap-2.5">
                                    <div className="flex-1 relative h-7 flex items-center">
                                        {/* Track background */}
                                        <div className="absolute inset-x-0 h-2 rounded-full" style={{ background: 'rgba(212,180,175,0.25)', top: '50%', transform: 'translateY(-50%)' }} />
                                        {/* Fill */}
                                        <div className="absolute h-2 rounded-full" style={{
                                            background: 'linear-gradient(90deg, #c9b1bd, #c48b8b)',
                                            width: `${(initialAffinity + 100) / 200 * 100}%`,
                                            top: '50%', transform: 'translateY(-50%)',
                                        }} />
                                        <input type="range" min={-100} max={100} value={initialAffinity}
                                            onChange={e => setInitialAffinity(Number(e.target.value))}
                                            className="absolute inset-0 w-full opacity-0 cursor-pointer" style={{ zIndex: 2 }} />
                                        {/* Thumb */}
                                        <div className="absolute w-5 h-5 rounded-full bg-white pointer-events-none" style={{
                                            left: `calc(${(initialAffinity + 100) / 200 * 100}% - 10px)`,
                                            top: '50%', transform: 'translateY(-50%)',
                                            border: '2.5px solid #c48b8b',
                                            boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
                                            zIndex: 1,
                                        }} />
                                    </div>
                                    <input type="number" value={initialAffinity}
                                        onChange={e => setInitialAffinity(Number(e.target.value))}
                                        className="w-14 rounded-xl px-2 py-1.5 text-center text-xs font-bold focus:outline-none"
                                        style={{ color: '#8b6f6f', background: 'rgba(255,255,255,0.6)', border: '1px solid rgba(200,180,175,0.2)' }} />
                                </div>
                                <div className="text-[9px]" style={{ color: 'rgba(160,130,130,0.5)' }}>支持负数，随便填（角色会看到并做出反应）</div>
                            </div>
                        </div>

                        {/* Max Rounds */}
                        <div className="rounded-2xl overflow-hidden" style={{ background: 'rgba(245,238,235,0.7)', backdropFilter: 'blur(8px)', border: '1.5px solid rgba(200,180,175,0.25)' }}>
                            <div className="p-3 space-y-2">
                                <div className="flex items-center gap-1.5">
                                    <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px]" style={{ background: 'linear-gradient(135deg, #c9b1bd, #b89aaa)', color: 'white' }}><Sparkle size={12} weight="fill" /></div>
                                    <span className="text-xs font-bold" style={{ color: '#8b6f6f' }}>回合数</span>
                                </div>
                                <div className="grid grid-cols-4 gap-1.5">
                                    {[3, 5, 8, 10].map(n => (
                                        <button key={n} onClick={() => { trackEvent('选择攻略回合数', { rounds: n }); setMaxRounds(n); }}
                                            className="py-2 rounded-xl text-xs transition-all active:scale-90"
                                            style={maxRounds === n ? {
                                                background: 'linear-gradient(135deg, #c9a0a0, #b88a8a)',
                                                color: 'white',
                                                fontWeight: 700,
                                                boxShadow: '0 2px 6px rgba(180,130,130,0.2)',
                                            } : {
                                                background: 'rgba(255,255,255,0.5)',
                                                color: 'rgba(160,130,130,0.6)',
                                                border: '1px solid rgba(200,180,175,0.2)',
                                            }}>{n}</button>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* Fantasy Scenario / World Setting */}
                        <div className="rounded-2xl overflow-hidden" style={{ background: 'rgba(245,238,235,0.7)', backdropFilter: 'blur(8px)', border: '1.5px solid rgba(200,180,175,0.25)' }}>
                            <div className="p-3.5 space-y-2.5">
                                <div className="flex items-center gap-1.5">
                                    <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px]" style={{ background: 'linear-gradient(135deg, #c5b8c9, #b5a3bb)', color: 'white' }}><FlowerLotus size={12} weight="fill" /></div>
                                    <span className="text-xs font-bold" style={{ color: '#8b6f6f' }}>幻想场景</span>
                                    <span className="text-[9px] ml-0.5" style={{ color: 'rgba(160,130,130,0.4)' }}>选一个或自己写</span>
                                </div>
                                {/* Fantasy Presets */}
                                <div className="grid grid-cols-3 gap-1.5">
                                    {[
                                        { label: '游戏世界', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f3ae.png', value: '你们在一起玩的游戏世界里冒险（RPG/开放世界），角色用游戏内的方式攻略用户' },
                                        { label: '小说剧情', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4d6.png', value: '你们是小说里的角色，身处用户喜欢的故事类型中，角色按剧情节奏推进攻略' },
                                        { label: '校园日常', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f3eb.png', value: '校园背景，放学后/午休/社团活动等经典galgame场景' },
                                        { label: '都市奇遇', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f303.png', value: '现代都市奇幻背景，偶然相遇在咖啡馆/书店/雨天的街角' },
                                        { label: '异世界', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2694.png', value: '奇幻异世界冒险，勇者与同伴的旅程，角色在冒险途中制造心动瞬间' },
                                        { label: '自由想象', icon: 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f52e.png', value: '' },
                                    ].map(preset => (
                                        <button key={preset.label} onClick={() => { trackEvent('选择幻想场景预设', { preset: preset.label }); setScenarioHint(preset.value); }}
                                            className="py-2 px-1 rounded-xl text-[10px] transition-all active:scale-90 text-center leading-tight"
                                            style={scenarioHint === preset.value && preset.value ? {
                                                background: 'linear-gradient(135deg, #c9a0a0, #b88a8a)',
                                                color: 'white',
                                                fontWeight: 700,
                                                boxShadow: '0 2px 6px rgba(180,130,130,0.2)',
                                            } : {
                                                background: 'rgba(255,255,255,0.5)',
                                                color: 'rgba(120,100,100,0.6)',
                                                border: '1px solid rgba(200,180,175,0.2)',
                                            }}>
                                            <img src={preset.icon} className="w-4 h-4 inline" alt="" />{' '}{preset.label}
                                        </button>
                                    ))}
                                </div>
                                <input type="text" value={scenarioHint} onChange={e => setScenarioHint(e.target.value)}
                                    placeholder="自由描述: 在某个游戏里/小说背景/咖啡馆偶遇/雨天同伞..."
                                    className="w-full rounded-xl px-3 py-2.5 text-xs focus:outline-none placeholder-stone-300"
                                    style={{ color: '#6b5555', background: 'rgba(255,255,255,0.5)', border: '1px solid rgba(200,180,175,0.2)' }}
                                    />
                                <div className="text-[9px]" style={{ color: 'rgba(160,130,130,0.4)' }}>大胆设想！这是游戏，不用拘束于现实</div>
                            </div>
                        </div>

                        {error && (
                            <div className="rounded-2xl p-3 text-xs" style={{ color: '#a06060', background: 'rgba(240,220,220,0.6)', border: '1px solid rgba(200,160,160,0.3)' }}>
                                {error}
                            </div>
                        )}
                    </div>
                </div>

                {/* Start Button - Morandi rose */}
                <div className="p-4 shrink-0">
                    <button onClick={handleStartGame} disabled={!selectedCharId || isLoading}
                        className="w-full py-3.5 font-bold text-sm tracking-wider active:scale-[0.97] transition-all disabled:opacity-40"
                        style={{
                            background: 'linear-gradient(135deg, #c9a0a0 0%, #b88a8a 50%, #a07878 100%)',
                            color: 'white',
                            borderRadius: '16px',
                            boxShadow: '0 4px 16px rgba(180,130,130,0.3), 0 2px 6px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.15)',
                            border: '1px solid rgba(255,255,255,0.1)',
                        }}>
                        {isLoading ? (
                            <span className="flex items-center justify-center gap-2">
                                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                生成开场白...
                            </span>
                        ) : (
                            <span>开始游戏</span>
                        )}
                    </button>
                </div>
            </GameFrame>
        );
    }

    // ============ RENDER: OPENING ============
    if (view === 'opening' && openingSegments.length > 0 && !openingDone) {
        return (
            <GameFrame>
                <GameHeader
                    title="攻略本 · 开场"
                    subtitle={`${selectedChar?.name} 的攻略之旅`}
                    onBack={handleOpeningDone}
                    affinity={session?.currentAffinity}
                    charAvatar={selectedChar?.avatar}
                />
                <TypewriterSegments segments={openingSegments} charName={selectedChar?.name || '???'} onDone={handleOpeningDone} />
                <div className="p-4 shrink-0">
                    <button onClick={handleOpeningDone}
                        className="w-full py-2.5 bg-white/70 text-sm font-bold rounded-xl active:scale-95 transition-transform shadow-sm" style={{ color: '#8b7a7e', border: '1px solid rgba(200,185,190,0.3)' }}>
                        跳过 <ArrowRight size={14} className="inline" />
                    </button>
                </div>
            </GameFrame>
        );
    }

    // ============ RENDER: PLAYING / REPLAY ============
    const char = characters.find(c => c.id === (session?.charId || selectedCharId));
    const charName = char?.name || '???';
    const isReplay = view === 'replay';

    return (
        <GameFrame>
            {/* Header */}
            <GameHeader
                title={isReplay ? '攻略本 · 回放' : `攻略本 · ${session?.currentRound || 0}/${session?.maxRounds || 0}`}
                subtitle={`${charName} vs ${userProfile.name}`}
                onBack={() => {
                    if (isReplay || !session?.rounds.length || session?.status === 'ended') {
                        backToLobby();
                    } else {
                        setShowExitConfirm(true);
                    }
                }}
                affinity={session?.currentAffinity}
                charAvatar={char?.avatar}
            />

            {/* Log Area */}
            <div ref={logsRef} className="flex-1 overflow-y-auto p-4 space-y-3 no-scrollbar">
                {/* Opening recap */}
                {openingSegments.length > 0 && (
                    <div className="space-y-2 pb-3">
                        {openingSegments.map((seg, i) => (
                            <SegmentBubble key={i} seg={seg} charName={charName} />
                        ))}
                        <div className="flex items-center gap-2 my-2">
                            <div className="h-px flex-1" style={{ background: 'rgba(200,185,190,0.25)' }} />
                            <span className="text-[10px] font-bold" style={{ color: 'rgba(160,145,150,0.5)' }}>游戏开始</span>
                            <div className="h-px flex-1" style={{ background: 'rgba(200,185,190,0.25)' }} />
                        </div>
                    </div>
                )}

                {/* Rounds */}
                {session?.rounds.map((round, i) => (
                    <RoundDisplay
                        key={round.id}
                        round={round}
                        charName={charName}
                        isLatest={i === session.rounds.length - 1}
                        isReplay={isReplay}
                        onLongPress={isReplay ? undefined : () => setContextMenuRound(i)}
                    />
                ))}

                {/* End card inline for replay */}
                {isReplay && session?.endCard && (
                    <Card className="p-4 space-y-3 mt-2">
                        <div className="text-center">
                            <div className="text-[10px] tracking-wider font-bold mb-1 flex items-center justify-center gap-1" style={{ color: '#9b8a8e' }}><Sparkle size={12} weight="fill" /> 结算 <Sparkle size={12} weight="fill" /></div>
                            <div className="text-lg font-black" style={{ color: '#5a4a50' }}>「{session.endCard.title}」</div>
                        </div>
                        <div className="text-sm italic text-center rounded-xl p-2" style={{ color: '#5a4a50', background: 'rgba(245,238,235,0.5)' }}>
                            "{session.endCard.charVerdict}"
                        </div>
                        {session.endCard.highlights.map((h, i) => (
                            <div key={i} className="text-xs flex gap-2 rounded-lg p-2" style={{ color: '#5a4a50', background: 'rgba(245,238,235,0.3)' }}>
                                <span className="shrink-0" style={{ color: '#b8909a' }}><CaretRight size={12} weight="bold" /></span><span>{h}</span>
                            </div>
                        ))}
                        {session.endCard.charSummary && (
                            <div className="rounded-xl p-3" style={{ background: 'linear-gradient(135deg, rgba(245,238,235,0.5), rgba(235,228,238,0.4))', border: '1px solid rgba(200,185,190,0.2)' }}>
                                <div className="text-[10px] font-bold mb-1 flex items-center gap-1" style={{ color: '#9b7a7e' }}>
                                    <Heart size={12} weight="fill" /> {charName}的真心话
                                </div>
                                <div className="text-sm leading-relaxed" style={{ color: '#5a4a50' }}>{session.endCard.charSummary}</div>
                            </div>
                        )}
                    </Card>
                )}

                {/* Loading */}
                {isLoading && (
                    <div className="flex items-center gap-2 text-xs" style={{ color: 'rgba(140,125,130,0.7)' }}>
                        <div className="w-4 h-4 rounded-full animate-spin" style={{ border: '2px solid rgba(200,185,190,0.3)', borderTopColor: '#b8909a' }} />
                        <span>{charName} 正在思考...</span>
                    </div>
                )}

                {error && (
                    // Card 只用自己那套卡片样式，不转发 style，这里原来传的红框/浅红底从来没生效过，就别传了
                    <Card className="p-3">
                        <div className="text-red-500 text-xs">{error}</div>
                    </Card>
                )}
            </div>

            {/* Input Area (playing only) */}
            {!isReplay && session?.status === 'playing' && !isLoading && (
                <div className="shrink-0"
                    style={{ background: 'linear-gradient(0deg, rgba(240,235,232,0.95) 0%, rgba(236,230,233,0.9) 100%)', borderTop: '2px solid rgba(200,185,190,0.15)' }}>

                    {/* Collapse toggle bar */}
                    <button onClick={() => setInputCollapsed(c => !c)}
                        className="w-full flex items-center justify-center gap-1.5 py-2 active:bg-white/30 transition-colors"
                        style={{ borderBottom: inputCollapsed ? 'none' : '1px solid rgba(200,185,190,0.1)' }}>
                        <span className="text-[10px] font-bold" style={{ color: '#9b8a8e' }}>
                            {inputCollapsed ? '展开编辑面板' : '收起编辑面板'}
                        </span>
                        <span className="text-[10px]" style={{ color: 'rgba(160,145,150,0.5)' }}>
                            {inputCollapsed ? <CaretUp size={12} /> : <CaretDown size={12} />}
                        </span>
                    </button>

                    {!inputCollapsed && (
                        <div className="p-3 pt-1.5 space-y-2.5">
                            {/* Tappable scenario row */}
                            <button onClick={() => { setEditingScenario(true); setEditScenarioText(roundScenario); }}
                                className="w-full flex gap-2 items-start active:scale-[0.98] transition-transform"
                                style={{ background: 'rgba(255,255,255,0.7)', border: '1px dashed rgba(200,185,190,0.3)', borderRadius: '12px', padding: '8px 10px' }}>
                                <span className="w-5 h-5 rounded-md flex items-center justify-center text-[10px] shrink-0 mt-0.5" style={{ background: 'rgba(200,185,190,0.2)', color: '#9b8a8e' }}><FlowerLotus size={12} /></span>
                                <span className="flex-1 text-left text-xs leading-relaxed truncate" style={{ color: roundScenario ? '#5a4a50' : 'rgba(160,140,145,0.5)' }}>
                                    {roundScenario || '场景描述 (可选，留空由GM发挥)'}
                                </span>
                                <span className="text-[10px] shrink-0 mt-0.5" style={{ color: 'rgba(160,140,145,0.5)' }}><PencilSimple size={12} /></span>
                            </button>

                            {/* Tappable option rows */}
                            {[0, 1, 2].map(i => (
                                <button key={i} onClick={() => { setEditingOptIdx(i); setEditOptText(optionTexts[i]); setEditOptScore(String(optionScores[i])); }}
                                    className="w-full flex gap-2 items-start active:scale-[0.98] transition-transform"
                                    style={{ background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(200,185,190,0.3)', borderRadius: '12px', padding: '8px 10px' }}>
                                    <span className="w-6 h-6 rounded-lg flex items-center justify-center text-[10px] text-white font-bold shrink-0 shadow-sm mt-0.5" style={{ background: 'linear-gradient(135deg, #b8909a, #a07880)' }}>
                                        {String.fromCharCode(65 + i)}
                                    </span>
                                    <span className="flex-1 text-left text-xs leading-relaxed truncate" style={{ color: optionTexts[i] ? '#5a4a50' : 'rgba(160,140,145,0.5)' }}>
                                        {optionTexts[i] || `${charName}的行为${String.fromCharCode(65 + i)}...`}
                                    </span>
                                    <span className="text-[10px] font-bold shrink-0 px-1.5 py-0.5 rounded-lg" style={{ color: optionScores[i] >= 0 ? '#7a5a5e' : '#5a5a7a', background: optionScores[i] >= 0 ? 'rgba(200,170,175,0.2)' : 'rgba(170,170,200,0.2)' }}>
                                        {optionScores[i] >= 0 ? '+' : ''}{optionScores[i]}
                                    </span>
                                    <span className="text-[10px] shrink-0" style={{ color: 'rgba(160,140,145,0.5)' }}><PencilSimple size={12} /></span>
                                </button>
                            ))}

                            {/* Direction hint for GM */}
                            <input type="text" value={nextDirectionHint} onChange={e => setNextDirectionHint(e.target.value)}
                                placeholder="接下来对GM的剧情方向指导 (选填)"
                                className="w-full rounded-xl px-3 py-2 text-[11px] focus:outline-none"
                                style={{ background: 'rgba(255,255,255,0.5)', border: '1px dashed rgba(200,185,190,0.3)', color: '#5a4a50' }} />

                            <div className="flex gap-2">
                                <button onClick={handleAIAssist} disabled={isLoading}
                                    className="flex-1 py-2 bg-white/70 text-xs font-bold rounded-xl active:scale-95 transition-transform shadow-sm" style={{ color: '#9b8a8e', border: '1px solid rgba(200,185,190,0.3)' }}>
                                    <Sparkle size={12} weight="fill" className="inline" /> AI 一键填入
                                </button>
                                <button onClick={handleSubmitRound} disabled={isLoading || optionTexts.some(t => !t.trim())}
                                    className="flex-1 py-2 text-white text-xs font-bold rounded-xl active:scale-95 transition-transform disabled:opacity-50 shadow-md" style={{ background: 'linear-gradient(135deg, #b8909a, #a07880)' }}>
                                    提交本回合
                                </button>
                            </div>

                            <button onClick={handleEndGame} disabled={isLoading || !session.rounds.length}
                                className="w-full py-2 bg-white/50 text-xs rounded-xl active:scale-95 transition-transform disabled:opacity-30" style={{ color: '#9b8a8e', border: '1px solid rgba(200,185,190,0.2)' }}>
                                就到这吧 · 生成结算卡片
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* Replay footer */}
            {isReplay && (
                <div className="shrink-0 p-3" style={{ background: 'linear-gradient(0deg, rgba(236,230,233,0.9) 0%, transparent 100%)' }}>
                    <button onClick={backToLobby}
                        className="w-full py-2.5 bg-white/70 text-sm font-bold rounded-xl active:scale-95 transition-transform shadow-sm" style={{ color: '#8b7a7e', border: '1px solid rgba(200,185,190,0.3)' }}>
                        返回列表
                    </button>
                </div>
            )}

            {/* End Card Popup */}
            {showEndCard && session?.endCard && char && (
                <EndCard
                    session={session}
                    charName={charName}
                    charAvatar={char.avatar}
                    onClose={() => setShowEndCard(false)}
                    onSendToChat={handleSendToChat}
                />
            )}

            {/* Exceed Warning */}
            {showExceedWarning && (
                <div className="fixed inset-0 z-40 flex items-center justify-center p-6">
                    <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={() => setShowExceedWarning(false)} />
                    <Card className="relative p-5 max-w-xs w-full space-y-3">
                        <div className="font-bold text-sm text-center" style={{ color: '#5a4a50' }}>已达到预设回合数 ({session?.maxRounds})</div>
                        <div className="text-xs text-center" style={{ color: '#9b8a8e' }}>要继续玩还是结算？</div>
                        <div className="flex gap-2">
                            <button onClick={() => setShowExceedWarning(false)}
                                className="flex-1 py-2.5 bg-white/80 text-xs font-bold rounded-xl active:scale-95 transition-transform" style={{ color: '#8b7a7e', border: '1px solid rgba(200,185,190,0.3)' }}>
                                继续玩！
                            </button>
                            <button onClick={handleEndGame}
                                className="flex-1 py-2.5 text-white text-xs font-bold rounded-xl active:scale-95 transition-transform shadow-md" style={{ background: 'linear-gradient(135deg, #b8909a, #a07880)' }}>
                                结算
                            </button>
                        </div>
                    </Card>
                </div>
            )}

            {/* Option Edit Overlay */}
            {editingOptIdx !== null && (
                <div className="fixed inset-0 z-50 flex items-end justify-center p-3 pb-4" style={{ paddingBottom: `calc(1rem + var(--safe-bottom))` }}>
                    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setEditingOptIdx(null)} />
                    <div className="relative w-full max-w-md rounded-3xl overflow-hidden shadow-2xl max-h-[85vh] overflow-y-auto" style={{ background: 'linear-gradient(160deg, #f5f0ee 0%, #ece6e9 100%)', border: '1px solid rgba(200,185,190,0.3)' }}>
                        <div className="px-5 pt-5 pb-3" style={{ borderBottom: '1px solid rgba(200,185,190,0.15)' }}>
                            <div className="flex items-center gap-2">
                                <span className="w-7 h-7 rounded-xl flex items-center justify-center text-sm text-white font-bold shadow-sm" style={{ background: 'linear-gradient(135deg, #b8909a, #a07880)' }}>
                                    {editingOptIdx !== null ? String.fromCharCode(65 + editingOptIdx) : ''}
                                </span>
                                <span className="text-sm font-bold" style={{ color: '#5a4a50' }}>编辑选项</span>
                            </div>
                        </div>
                        <div className="px-5 py-4 space-y-3">
                            <div>
                                <div className="text-[10px] font-bold mb-1.5" style={{ color: '#9b8a8e' }}>选项内容</div>
                                <textarea
                                    autoFocus
                                    value={editOptText}
                                    onChange={e => setEditOptText(e.target.value)}
                                    rows={8}
                                    placeholder={`${charName}的行为...`}
                                    className="w-full rounded-2xl px-3.5 py-3 text-sm focus:outline-none resize-none"
                                    style={{ background: 'rgba(255,255,255,0.8)', border: '1.5px solid rgba(200,185,190,0.4)', color: '#5a4a50', lineHeight: '1.8' }}
                                />
                            </div>
                            <div>
                                <div className="text-[10px] font-bold mb-1.5" style={{ color: '#9b8a8e' }}>好感度变化（支持负数）</div>
                                <input
                                    type="text" inputMode="numeric"
                                    value={editOptScore}
                                    onChange={e => {
                                        const v = e.target.value;
                                        // Allow empty, minus sign, or valid number input
                                        if (v === '' || v === '-' || /^-?\d*$/.test(v)) setEditOptScore(v);
                                    }}
                                    placeholder="0"
                                    className="w-full rounded-2xl px-3 py-2.5 text-sm text-center font-bold focus:outline-none"
                                    style={{ background: 'rgba(255,255,255,0.8)', border: '1.5px solid rgba(200,185,190,0.4)', color: '#5a4a50' }}
                                />
                            </div>
                        </div>
                        <div className="flex gap-2 px-5 pb-5">
                            <button onClick={() => setEditingOptIdx(null)}
                                className="flex-1 py-2.5 bg-white/80 text-xs font-bold rounded-2xl active:scale-95 transition-transform" style={{ color: '#8b7a7e', border: '1px solid rgba(200,185,190,0.3)' }}>
                                取消
                            </button>
                            <button onClick={() => {
                                if (editingOptIdx === null) return;
                                const t = [...optionTexts]; t[editingOptIdx] = editOptText; setOptionTexts(t);
                                const s = [...optionScores]; s[editingOptIdx] = Number(editOptScore) || 0; setOptionScores(s);
                                setEditingOptIdx(null);
                                trackEvent('手动编辑一个选项');
                            }}
                                className="flex-1 py-2.5 text-white text-xs font-bold rounded-2xl active:scale-95 transition-transform shadow-md" style={{ background: 'linear-gradient(135deg, #b8909a, #a07880)' }}>
                                确认
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Scenario Edit Overlay */}
            {editingScenario && (
                <div className="fixed inset-0 z-50 flex items-end justify-center p-3 pb-4" style={{ paddingBottom: `calc(1rem + var(--safe-bottom))` }}>
                    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setEditingScenario(false)} />
                    <div className="relative w-full max-w-md rounded-3xl overflow-hidden shadow-2xl max-h-[85vh] overflow-y-auto" style={{ background: 'linear-gradient(160deg, #f5f0ee 0%, #ece6e9 100%)', border: '1px solid rgba(200,185,190,0.3)' }}>
                        <div className="px-5 pt-5 pb-3" style={{ borderBottom: '1px solid rgba(200,185,190,0.15)' }}>
                            <div className="flex items-center gap-2">
                                <span className="w-6 h-6 rounded-lg flex items-center justify-center text-[10px] shrink-0" style={{ background: 'rgba(200,185,190,0.2)', color: '#9b8a8e' }}><FlowerLotus size={12} /></span>
                                <span className="text-sm font-bold" style={{ color: '#5a4a50' }}>编辑场景描述</span>
                            </div>
                        </div>
                        <div className="px-5 py-4">
                            <div className="text-[10px] font-bold mb-1.5" style={{ color: '#9b8a8e' }}>GM 会在这个场景基础上展开叙事 (留空则由GM自由发挥)</div>
                            <textarea
                                autoFocus
                                value={editScenarioText}
                                onChange={e => setEditScenarioText(e.target.value)}
                                rows={10}
                                placeholder="比如: 雨天在咖啡馆偶遇 / 一起被困在电梯里 / 在图书馆发现对方的秘密日记..."
                                className="w-full rounded-2xl px-3.5 py-3 text-sm focus:outline-none resize-none"
                                style={{ background: 'rgba(255,255,255,0.8)', border: '1.5px solid rgba(200,185,190,0.4)', color: '#5a4a50', lineHeight: '1.8' }}
                            />
                        </div>
                        <div className="flex gap-2 px-5 pb-5">
                            <button onClick={() => setEditingScenario(false)}
                                className="flex-1 py-2.5 bg-white/80 text-xs font-bold rounded-2xl active:scale-95 transition-transform" style={{ color: '#8b7a7e', border: '1px solid rgba(200,185,190,0.3)' }}>
                                取消
                            </button>
                            <button onClick={() => { setRoundScenario(editScenarioText); setEditingScenario(false); trackEvent('手动编辑本回合场景'); }}
                                className="flex-1 py-2.5 text-white text-xs font-bold rounded-2xl active:scale-95 transition-transform shadow-md" style={{ background: 'linear-gradient(135deg, #b8909a, #a07880)' }}>
                                确认
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Exit Confirm */}
            {showExitConfirm && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
                    <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={() => setShowExitConfirm(false)} />
                    <Card className="relative p-5 max-w-xs w-full space-y-3">
                        <div className="font-bold text-sm text-center" style={{ color: '#5a4a50' }}>退出游戏？</div>
                        <div className="text-xs text-center" style={{ color: '#9b8a8e' }}>进度已自动保存，下次可以继续</div>
                        <div className="flex gap-2">
                            <button onClick={() => setShowExitConfirm(false)}
                                className="flex-1 py-2.5 bg-white/80 text-xs font-bold rounded-xl active:scale-95 transition-transform" style={{ color: '#8b7a7e', border: '1px solid rgba(200,185,190,0.3)' }}>
                                继续玩
                            </button>
                            <button onClick={() => { setShowExitConfirm(false); backToLobby(); }}
                                className="flex-1 py-2.5 text-white text-xs font-bold rounded-xl active:scale-95 transition-transform shadow-md" style={{ background: 'linear-gradient(135deg, #b8909a, #a07880)' }}>
                                退出
                            </button>
                        </div>
                    </Card>
                </div>
            )}

            {/* Round Context Menu */}
            {contextMenuRound !== null && (
                <div className="fixed inset-0 z-40 flex items-end justify-center p-4 pb-8" style={{ paddingBottom: `calc(2rem + var(--safe-bottom))` }}>
                    <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={() => setContextMenuRound(null)} />
                    <Card className="relative w-full max-w-sm overflow-hidden">
                        <div className="text-center text-xs py-2" style={{ color: '#9b8a8e', borderBottom: '1px solid rgba(200,185,190,0.2)' }}>
                            第 {(session?.rounds[contextMenuRound]?.roundNumber) || '?'} 回合
                        </div>
                        <button
                            onClick={() => handleRegenerateFrom(contextMenuRound)}
                            className="w-full py-3.5 text-sm font-bold transition-colors" style={{ color: '#5a4a50' }}
                        >
                            从这里重新生成
                        </button>
                        <div className="h-px" style={{ background: 'rgba(200,185,190,0.2)' }} />
                        <button
                            onClick={() => handleDeleteFrom(contextMenuRound)}
                            className="w-full py-3.5 text-sm text-red-400 font-bold transition-colors"
                        >
                            删除此回合及之后的内容
                        </button>
                        <div className="h-px" style={{ background: 'rgba(200,185,190,0.2)' }} />
                        <button
                            onClick={() => setContextMenuRound(null)}
                            className="w-full py-3 text-sm transition-colors" style={{ color: '#9b8a8e' }}
                        >
                            取消
                        </button>
                    </Card>
                </div>
            )}
        </GameFrame>
    );
};

export default GuidebookApp;
