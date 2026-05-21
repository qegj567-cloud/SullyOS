


import React, { useRef, useState } from 'react';
import { Message, ChatTheme } from '../../types';
import { tryParseLifeSimResetCard } from '../../utils/lifeSimChatCard';
import McdCard from './McdCard';

// 思考链卡片支持的 4 种风格预设 — 同时被 MessageItem 与 ThinkingChainSettingsModal 复用
export type ThinkingChainStyleId = 'echo' | 'whisper' | 'minimal' | 'custom';
export interface ThinkingChainStyleSpec {
    bg: string;            // 卡片背景（可以是 CSS gradient）
    border: string;        // 边框色
    accent: string;        // 标题/装饰点缀
    text: string;          // 正文颜色
    subtext: string;       // 副标题/状态文字
    glow?: string;         // 右上角微光 radial 颜色（可选）
    fadeColor?: string;    // 展开滚动区上下软渐变颜色（可选）
    fontFamily: string;    // 正文字体
    showCorners: boolean;  // 四角装饰括号
    showDivider: boolean;  // 标题下分隔线
    titleZh: string;       // 中文标题
    titleEn: string;       // 英文副标题
    listenLabel: string;   // 折叠态右侧文字
    silenceLabel: string;  // 展开态右侧文字
    quoteLeft: string;     // 折叠态首句左引号
    quoteRight: string;    // 折叠态首句右引号
    italic: boolean;       // 是否斜体
    radius: string;        // 圆角
}

const SERIF = '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "STKaiti", "KaiTi", serif';
const SANS = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';

export const THINKING_CHAIN_PRESETS: Record<Exclude<ThinkingChainStyleId, 'custom'>, ThinkingChainStyleSpec> = {
    echo: {
        bg: 'linear-gradient(135deg, #2a1f3d 0%, #1d1530 45%, #2a1834 100%)',
        border: 'rgba(201, 169, 106, 0.35)',
        accent: '#c9a96a',
        text: '#e9d9b8',
        subtext: 'rgba(233, 217, 184, 0.62)',
        glow: 'rgba(201, 169, 106, 0.28)',
        fadeColor: '#1d1530',
        fontFamily: SERIF,
        showCorners: true,
        showDivider: true,
        titleZh: '心象',
        titleEn: 'PSYCHE',
        listenLabel: '凝望',
        silenceLabel: '移开视线',
        quoteLeft: '「',
        quoteRight: '」',
        italic: true,
        radius: '4px',
    },
    whisper: {
        bg: 'linear-gradient(135deg, rgba(251, 247, 242, 0.96) 0%, rgba(245, 238, 247, 0.86) 50%, rgba(248, 240, 240, 0.92) 100%)',
        border: 'rgba(216, 196, 200, 0.55)',
        accent: '#9a7d83',
        text: '#5b4b50',
        subtext: 'rgba(154, 125, 131, 0.7)',
        glow: 'rgba(212, 184, 192, 0.35)',
        fadeColor: '#fbf7f2',
        fontFamily: SERIF,
        showCorners: false,
        showDivider: true,
        titleZh: '心象',
        titleEn: 'PSYCHE',
        listenLabel: '凝望',
        silenceLabel: '移开视线',
        quoteLeft: '「',
        quoteRight: '」',
        italic: true,
        radius: '14px',
    },
    minimal: {
        bg: '#ffffff',
        border: 'rgba(15, 23, 42, 0.12)',
        accent: '#475569',
        text: '#1e293b',
        subtext: 'rgba(71, 85, 105, 0.6)',
        fadeColor: '#ffffff',
        fontFamily: SANS,
        showCorners: false,
        showDivider: false,
        titleZh: '心象',
        titleEn: 'PSYCHE',
        listenLabel: '凝望',
        silenceLabel: '移开视线',
        quoteLeft: '"',
        quoteRight: '"',
        italic: false,
        radius: '10px',
    },
};

export function resolveThinkingChainStyle(
    styleId?: ThinkingChainStyleId,
    customColors?: { bg?: string; accent?: string; text?: string },
): ThinkingChainStyleSpec {
    if (styleId === 'custom') {
        const bg = customColors?.bg || '#1f2937';
        const accent = customColors?.accent || '#fbbf24';
        const text = customColors?.text || '#f1f5f9';
        return {
            ...THINKING_CHAIN_PRESETS.echo,
            bg,
            border: accent,
            accent,
            text,
            subtext: text,
            glow: accent,
            fadeColor: bg,
            titleZh: '心象',
            titleEn: 'PSYCHE',
            listenLabel: '凝望',
            silenceLabel: '移开视线',
        };
    }
    return THINKING_CHAIN_PRESETS[styleId || 'echo'] || THINKING_CHAIN_PRESETS.echo;
}

// 思考链卡片：可视化 metadata.thinkingChain。
// 内容来源：useChatAI 抽取的 LLM reasoning_content + <think>/<thinking>/<thought>。
// 多风格通过 resolveThinkingChainStyle() 统一渲染；齿轮触发 onOpenSettings 进入设置弹窗。
const ThinkingChainBlock: React.FC<{
    chain: string;
    styleId?: ThinkingChainStyleId;
    customColors?: { bg?: string; accent?: string; text?: string };
    onOpenSettings?: () => void;
}> = ({ chain, styleId, customColors, onOpenSettings }) => {
    const [expanded, setExpanded] = useState(false);
    const trimmed = (chain || '').trim();
    if (!trimmed) return null;
    const spec = resolveThinkingChainStyle(styleId, customColors);
    const firstLine = trimmed.replace(/\s+/g, ' ').slice(0, 38);
    const hasMore = trimmed.length > 38;
    return (
        <div
            className="mb-2 w-full max-w-full select-text cursor-pointer group"
            onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
        >
            <div
                className="relative overflow-hidden px-4 py-2.5 transition-all duration-300"
                style={{
                    background: spec.bg,
                    border: `1px solid ${spec.border}`,
                    borderRadius: spec.radius,
                    boxShadow: spec.glow
                        ? `0 2px 8px rgba(20, 10, 30, 0.18), inset 0 0 24px ${spec.glow.replace(/[\d.]+\)$/, '0.06)')}`
                        : '0 1px 3px rgba(15, 23, 42, 0.08)',
                }}
            >
                {/* 四角装饰括号 */}
                {spec.showCorners && (
                    <>
                        <span aria-hidden className="absolute top-1 left-1 w-2 h-2 border-t border-l pointer-events-none" style={{ borderColor: spec.accent }} />
                        <span aria-hidden className="absolute top-1 right-1 w-2 h-2 border-t border-r pointer-events-none" style={{ borderColor: spec.accent }} />
                        <span aria-hidden className="absolute bottom-1 left-1 w-2 h-2 border-b border-l pointer-events-none" style={{ borderColor: spec.accent }} />
                        <span aria-hidden className="absolute bottom-1 right-1 w-2 h-2 border-b border-r pointer-events-none" style={{ borderColor: spec.accent }} />
                    </>
                )}
                {/* 右上角微光 */}
                {spec.glow && (
                    <div
                        aria-hidden
                        className="absolute -top-8 -right-8 w-20 h-20 rounded-full opacity-40 pointer-events-none"
                        style={{ background: `radial-gradient(circle, ${spec.glow} 0%, transparent 70%)` }}
                    />
                )}

                {/* 标题行 */}
                <div className="relative flex items-center gap-2">
                    <span
                        className="text-[13px] font-semibold tracking-[0.4em]"
                        style={{
                            color: spec.accent,
                            fontFamily: spec.fontFamily,
                            textShadow: spec.glow ? `0 0 8px ${spec.glow}` : undefined,
                        }}
                    >
                        {spec.titleZh}
                    </span>
                    <span className="text-[8.5px] tracking-[0.32em] opacity-70" style={{ color: spec.text }}>
                        {spec.titleEn}
                    </span>
                    {spec.showCorners && (
                        <span aria-hidden className="text-[7px] mx-0.5" style={{ color: spec.border }}>◆</span>
                    )}
                    <span
                        className="ml-auto text-[10px] tracking-[0.18em] transition-opacity opacity-65 group-hover:opacity-100"
                        style={{ color: spec.subtext }}
                    >
                        {expanded ? spec.silenceLabel : spec.listenLabel}
                    </span>
                </div>

                {/* 装饰横线 */}
                {spec.showDivider && (
                    <div className="relative mt-1.5 mb-0.5 flex items-center gap-1.5" aria-hidden>
                        <span className="h-px flex-1" style={{ background: `linear-gradient(to right, transparent, ${spec.border}, transparent)` }} />
                        <span className="text-[6px]" style={{ color: spec.accent }}>◇</span>
                        <span className="h-px flex-1" style={{ background: `linear-gradient(to right, transparent, ${spec.border}, transparent)` }} />
                    </div>
                )}

                {!expanded && (
                    <div
                        className={`relative mt-1.5 text-[12px] leading-snug truncate ${spec.italic ? 'italic' : ''}`}
                        style={{ color: spec.text, fontFamily: spec.fontFamily }}
                    >
                        <span style={{ color: spec.accent, marginRight: 2 }}>{spec.quoteLeft}</span>
                        {firstLine}{hasMore ? '…' : ''}
                        <span style={{ color: spec.accent, marginLeft: 2 }}>{spec.quoteRight}</span>
                    </div>
                )}
                {expanded && (
                    <div className="relative mt-1.5">
                        {/* 上下软渐变盖掉系统滚动条；fadeColor 跟卡片背景一致 */}
                        {spec.fadeColor && (
                            <>
                                <div aria-hidden className="absolute top-0 left-0 right-0 h-3 pointer-events-none z-10" style={{ background: `linear-gradient(to bottom, ${spec.fadeColor} 0%, transparent 100%)` }} />
                                <div aria-hidden className="absolute bottom-0 left-0 right-0 h-3 pointer-events-none z-10" style={{ background: `linear-gradient(to top, ${spec.fadeColor} 0%, transparent 100%)` }} />
                            </>
                        )}
                        <div
                            className={`no-scrollbar relative pl-3 pr-1 py-2 text-[12.5px] leading-[1.85] whitespace-pre-wrap break-words max-h-72 overflow-auto ${spec.italic ? 'italic' : ''}`}
                            style={{
                                color: spec.text,
                                fontFamily: spec.fontFamily,
                                borderLeft: `1px solid ${spec.border}`,
                                textShadow: spec.glow ? '0 0 6px rgba(0, 0, 0, 0.4)' : undefined,
                            }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            {trimmed}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

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
                                            {msg.type === 'image' ? (msg.content ? <img src={msg.content} className="max-w-[200px] rounded-xl" /> : <span className="italic opacity-60">[图片已丢失]</span>) :
                                             msg.type === 'emoji' ? (msg.content ? <img src={msg.content} className="max-w-[100px]" /> : <span className="italic opacity-60">[表情已丢失]</span>) :
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

// ============================================================
// Like520 卡片：520 限定典藏，展开后看完整合照 + 信
// ============================================================

const Like520ChatCard: React.FC<{ data: any }> = ({ data }) => {
    const [open, setOpen] = useState(false);
    const stop = (e: React.MouseEvent | React.TouchEvent) => e.stopPropagation();
    const dateStr = (() => {
        try {
            const d = new Date(data.timestamp || Date.now());
            return `${d.getFullYear()} · ${String(d.getMonth() + 1).padStart(2, '0')} · ${String(d.getDate()).padStart(2, '0')}`;
        } catch { return '5 · 2 · 0'; }
    })();

    return (
        <>
            {/* 拍立得 / 复古剪贴本：照片 + 胶带 + 手写感落款 */}
            <div
                onClick={() => setOpen(true)}
                style={{
                    width: 256,
                    padding: '14px 14px 18px',
                    background: 'linear-gradient(180deg, #fdf6e3 0%, #f7eed4 100%)',
                    boxShadow:
                        '0 1px 2px rgba(74,36,24,0.18), ' +
                        '0 8px 22px rgba(74,36,24,0.22), ' +
                        '0 0 0 1px rgba(184,146,63,0.3)',
                    cursor: 'pointer',
                    position: 'relative',
                    transform: 'rotate(-1.4deg)',
                    transformOrigin: 'center',
                    marginTop: 8,
                }}
            >
                {/* 左上胶带 */}
                <div style={{
                    position: 'absolute', top: -6, left: 18,
                    width: 36, height: 14,
                    background: 'linear-gradient(135deg, rgba(218,190,140,0.55), rgba(184,146,63,0.4))',
                    boxShadow: '0 1px 2px rgba(74,36,24,0.15)',
                    transform: 'rotate(-6deg)',
                    pointerEvents: 'none',
                }} />
                {/* 右上胶带 */}
                <div style={{
                    position: 'absolute', top: -6, right: 18,
                    width: 36, height: 14,
                    background: 'linear-gradient(135deg, rgba(218,190,140,0.55), rgba(184,146,63,0.4))',
                    boxShadow: '0 1px 2px rgba(74,36,24,0.15)',
                    transform: 'rotate(6deg)',
                    pointerEvents: 'none',
                }} />

                {/* 照片本体 */}
                <div style={{
                    position: 'relative',
                    background: '#fff',
                    padding: 0,
                    boxShadow: '0 2px 6px rgba(74,36,24,0.18), inset 0 0 0 1px rgba(184,146,63,0.25)',
                }}>
                    {data.photoDataUrl
                        ? <img src={data.photoDataUrl} alt="合照" style={{ width: '100%', display: 'block' }} />
                        : <div style={{ width: '100%', aspectRatio: '1200 / 780', background: 'linear-gradient(180deg, #FFE0E8, #FFD3DC)' }} />}
                </div>

                {/* 手写感标题 */}
                <div style={{
                    marginTop: 12,
                    textAlign: 'center',
                    fontFamily: '"Cormorant Garamond", "Noto Serif SC", serif',
                    fontStyle: 'italic',
                    fontSize: 14,
                    color: '#7a2e3a',
                    letterSpacing: 1,
                    lineHeight: 1.35,
                }}>
                    「 {data.title || '我们的下午'} 」
                </div>

                {/* 日期 + 落款 */}
                <div style={{
                    marginTop: 6,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    paddingTop: 6,
                    borderTop: '0.5px dashed rgba(184,146,63,0.4)',
                    fontFamily: 'Cinzel, serif',
                    fontSize: 9.5,
                    letterSpacing: 2,
                    color: '#8b6914',
                    fontWeight: 600,
                }}>
                    <span>{dateStr}</span>
                    <span style={{ fontFamily: '"Cormorant Garamond", serif', fontStyle: 'italic', fontWeight: 400, letterSpacing: 1, fontSize: 10 }}>
                        — {data.charName}
                    </span>
                </div>

                {/* 暗示有信 */}
                <div style={{
                    marginTop: 6,
                    textAlign: 'center',
                    fontFamily: '"Cormorant Garamond", "Noto Serif SC", serif',
                    fontStyle: 'italic',
                    fontSize: 10.5,
                    color: '#b8923f',
                    letterSpacing: 2,
                }}>
                    ❦ 点 开 看 信 ❦
                </div>

                {/* 左下角复古火漆/印章："♥ 520" */}
                <div style={{
                    position: 'absolute',
                    bottom: -8, left: -8,
                    width: 44, height: 44,
                    borderRadius: '50%',
                    background: 'radial-gradient(circle at 35% 35%, #d4516a 0%, #a04050 50%, #7a2e3a 100%)',
                    color: '#fff8ec',
                    display: 'grid', placeItems: 'center',
                    fontFamily: '"Cormorant Garamond", serif',
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: 0,
                    lineHeight: 1.1,
                    transform: 'rotate(-12deg)',
                    boxShadow: '0 3px 8px rgba(74,36,24,0.4), inset 0 2px 2px rgba(255,255,255,0.18), inset 0 -2px 2px rgba(0,0,0,0.25)',
                    border: '1px solid rgba(212,177,106,0.5)',
                    textAlign: 'center',
                    pointerEvents: 'none',
                }}>
                    <div>
                        <div style={{ fontSize: 14, lineHeight: 1, fontFamily: 'serif' }}>♥</div>
                        <div style={{ fontSize: 7, letterSpacing: 1, marginTop: 1, fontFamily: 'Cinzel, serif' }}>5·20</div>
                    </div>
                </div>
            </div>

            {open && (
                <div
                    onClick={() => setOpen(false)}
                    style={{
                        position: 'fixed', inset: 0, zIndex: 9999,
                        background: 'rgba(74,36,24,0.55)',
                        backdropFilter: 'blur(8px)',
                        overflowY: 'auto', padding: 16,
                        animation: 'l520-card-mask-in .25s ease',
                    }}
                >
                    <style>{`
                        @keyframes l520-card-mask-in { from { opacity: 0; } to { opacity: 1; } }
                        @keyframes l520-card-pop-in { from { opacity: 0; transform: scale(0.94) translateY(20px); } to { opacity: 1; transform: scale(1) translateY(0); } }
                    `}</style>
                    <div
                        onClick={stop}
                        style={{
                            maxWidth: 420, margin: '24px auto',
                            background: 'linear-gradient(180deg, #fffcf3, #f9efd9)',
                            borderRadius: 4,
                            position: 'relative',
                            padding: '22px 18px 26px',
                            boxShadow: '0 0 0 1px #b8923f, 0 0 0 4px #faf3e7, 0 0 0 5px #d4b16a, 0 20px 60px rgba(74,36,24,0.5)',
                            animation: 'l520-card-pop-in .35s cubic-bezier(.4,1.4,.5,1)',
                        }}
                    >
                        <button
                            onClick={() => setOpen(false)}
                            title="关闭"
                            style={{
                                position: 'absolute', top: 10, right: 10, zIndex: 5,
                                width: 30, height: 30, borderRadius: '50%',
                                background: 'rgba(255,248,236,0.95)',
                                border: '1px solid #b8923f',
                                color: '#7a2e3a',
                                fontSize: 14,
                                fontFamily: '"Cormorant Garamond", serif',
                                cursor: 'pointer',
                                display: 'grid', placeItems: 'center',
                            }}
                        >✕</button>

                        <div style={{ textAlign: 'center', marginBottom: 12 }}>
                            <div style={{ fontSize: 9, letterSpacing: 6, color: '#8b6914', fontFamily: 'Cinzel, serif', fontWeight: 600 }}>5 · 2 · 0 · TRÉSOR</div>
                            <div style={{ fontSize: 13, color: '#7a2e3a', fontFamily: '"Noto Serif SC", serif', fontWeight: 500, letterSpacing: 4, marginTop: 4 }}>{data.title || '我们的下午'}</div>
                        </div>

                        {data.photoDataUrl ? (
                            <>
                                <img src={data.photoDataUrl} alt="合照" draggable={false} style={{ width: '100%', display: 'block', borderRadius: 8, boxShadow: '0 8px 20px rgba(122,46,58,0.2), 0 0 0 1px rgba(184,146,63,0.4)' }} />
                                <div style={{ fontSize: 10, fontStyle: 'italic', color: '#9D7585', textAlign: 'center', marginTop: 4, fontFamily: '"Cormorant Garamond", serif', letterSpacing: 2 }}>长按图片保存到相册</div>
                            </>
                        ) : null}

                        <div style={{
                            marginTop: 18,
                            padding: '22px 18px',
                            background: 'linear-gradient(180deg, #fffcf3, #f9efd9)',
                            border: '1px solid #d4b16a',
                            backgroundImage: 'repeating-linear-gradient(transparent, transparent 28px, rgba(184,146,63,0.05) 28px, rgba(184,146,63,0.05) 29px)',
                            borderRadius: 2,
                            position: 'relative',
                        }}>
                            <div style={{ textAlign: 'center', marginBottom: 14 }}>
                                <div style={{ fontFamily: '"Cormorant Garamond", serif', fontStyle: 'italic', fontSize: 11, color: '#8b6914', letterSpacing: 3 }}>致 · 我的</div>
                                <div style={{ fontFamily: '"Noto Serif SC", serif', fontSize: 20, color: '#7a2e3a', letterSpacing: 6, marginTop: 4 }}>{data.userName}</div>
                                <div style={{ color: '#b8923f', fontSize: 11, letterSpacing: 8, marginTop: 6 }}>❦ ⸙ ❦</div>
                            </div>
                            <div style={{ fontFamily: '"Noto Serif SC", serif', fontSize: 13.5, lineHeight: 2.05, color: '#3a2418', textIndent: '2em', whiteSpace: 'pre-wrap', letterSpacing: 0.5 }}>
                                {data.letter}
                            </div>
                            <div style={{ textAlign: 'right', marginTop: 16, paddingTop: 8, borderTop: '0.5px dashed rgba(184,146,63,0.3)' }}>
                                <div style={{ color: '#b8923f', fontSize: 11, letterSpacing: 6, marginBottom: 4 }}>~ ❦ ~</div>
                                <div style={{ fontFamily: '"Noto Serif SC", serif', fontSize: 13, color: '#7a2e3a', letterSpacing: 3 }}>— {data.charName}</div>
                            </div>
                        </div>
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
    /** 思维链卡片在多选模式下有独立勾选框，与 isSelected 分开。 */
    isThinkingSelected?: boolean;
    onToggleThinkingSelect?: (id: number) => void;
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
    /** Instant Push 准备中：在用户气泡左侧渲染 dot pulse */
    isPending?: boolean;
    /** 是否开启 dot pulse 指示。关掉则 pending 期间不显示任何视觉 */
    pendingIndicator?: boolean;
    /** 麦当劳菜单卡里点了"发送给角色"时调用 */
    onMcdSendCart?: (items: import('./McdCard').McdCartItem[]) => void;
    onMcdCandidate?: (item: import('./McdCard').McdCartItem) => void;
    /** 思考链卡片视觉与交互 */
    thinkingChainOptions?: {
        styleId?: ThinkingChainStyleId;
        customColors?: { bg?: string; accent?: string; text?: string };
        onOpenSettings?: () => void;
    };
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
    isThinkingSelected,
    onToggleThinkingSelect,
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
    isPending = false,
    pendingIndicator = true,
    onMcdSendCart,
    onMcdCandidate,
    thinkingChainOptions,
}: MessageItemProps) => {
    const isUser = m.role === 'user';
    const isSystem = m.role === 'system';
    const spacingClass = messageSpacing === 'compact' ? (isLastInGroup ? 'mb-3' : 'mb-0.5') : messageSpacing === 'spacious' ? (isLastInGroup ? 'mb-8' : 'mb-2.5') : (isLastInGroup ? 'mb-6' : 'mb-1.5');
    const marginBottom = spacingClass;
    const avatarSizeClass = avatarSize === 'small' ? 'w-7 h-7' : avatarSize === 'large' ? 'w-12 h-12' : 'w-9 h-9';
    const avatarRadiusClass = avatarShape === 'square' ? 'rounded-sm' : avatarShape === 'rounded' ? 'rounded-xl' : 'rounded-full';
    const avatarSizePx = avatarSize === 'small' ? 28 : avatarSize === 'large' ? 48 : 36;
    const shouldShowAvatar = avatarMode === 'every_message' || isLastInGroup;
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

    const showPendingDots = isUser && isPending && pendingIndicator;
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

                {showPendingDots && (
                    <span
                        className="inline-flex items-center gap-[3px] mb-2 mr-1.5 select-none pointer-events-none"
                        aria-label="发送准备中"
                        role="status"
                    >
                        <span className="w-1 h-1 rounded-full bg-slate-400/70 animate-dot-pulse" />
                        <span className="w-1 h-1 rounded-full bg-slate-400/70 animate-dot-pulse" style={{ animationDelay: '0.15s' }} />
                        <span className="w-1 h-1 rounded-full bg-slate-400/70 animate-dot-pulse" style={{ animationDelay: '0.3s' }} />
                    </span>
                )}

                {/*
                    UPDATED: Limit bubble max-width to 72% for better spacing.
                    Added min-w-0 to prevent flexbox overflow issues.
                    Added explicit margins to clear absolute avatars.
                */}
                <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} max-w-[72%] min-w-0 ${!isUser ? 'ml-12' : 'mr-12'}`} {...interactionProps}>
                    {!isUser && m.metadata?.thinkingChain && (
                        <div className={`relative w-full ${selectionMode ? 'pl-7' : ''}`}>
                            {selectionMode && onToggleThinkingSelect && (
                                <div
                                    className="absolute left-0 top-3 cursor-pointer z-20 pointer-events-auto"
                                    onClick={(e) => { e.stopPropagation(); onToggleThinkingSelect(m.id); }}
                                >
                                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isThinkingSelected ? 'bg-primary border-primary' : 'border-slate-300 bg-white/80'}`}>
                                        {isThinkingSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                                    </div>
                                </div>
                            )}
                            <div className={selectionMode ? 'pointer-events-none' : ''}>
                                <ThinkingChainBlock
                                    chain={String(m.metadata.thinkingChain)}
                                    styleId={thinkingChainOptions?.styleId}
                                    customColors={thinkingChainOptions?.customColors}
                                    onOpenSettings={thinkingChainOptions?.onOpenSettings}
                                />
                            </div>
                        </div>
                    )}
                    <div className={selectionMode ? 'pointer-events-none' : ''}>
                        {content}
                    </div>
                    {isLastInGroup && showTimestamp !== 'never' && (
                        <div className={`text-[9px] text-slate-400/80 px-1 mt-1 font-medium ${showTimestamp === 'hover' ? 'opacity-0 group-hover:opacity-100 transition-opacity' : ''}`}>{formatTime(m.timestamp)}</div>
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

    // --- Music Card Rendering (一起听 / 加入歌单) ---
    if (m.type === 'music_card' && m.metadata?.song) {
        const song = m.metadata.song as { songId: number; name: string; artists: string; albumPic: string };
        const intent = (m.metadata.intent || 'join') as 'join' | 'add' | 'join_and_add';
        const isTogether = intent === 'join' || intent === 'join_and_add';
        const addedTo = m.metadata.addedToPlaylistTitle as string | undefined;

        // 头像渲染：有图用图，无图显姓名首字
        const renderAvatar = (src: string | undefined, name: string, ring: string) => (
            <div
                className="relative shrink-0 rounded-full overflow-hidden"
                style={{
                    width: 32, height: 32,
                    boxShadow: `0 0 0 2px #fff, 0 0 0 3.5px ${ring}, 0 2px 6px ${ring}66`,
                }}
            >
                {src ? (
                    <img src={src} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer"
                        onError={(e: any) => {
                            const img = e.target;
                            const p = img.parentElement;
                            if (!p || p.querySelector('.ava-fallback')) return;
                            img.style.display = 'none';
                            const fb = document.createElement('div');
                            fb.className = 'ava-fallback w-full h-full flex items-center justify-center text-white text-xs font-semibold';
                            fb.style.background = `linear-gradient(135deg, ${ring}, #c3b2ff)`;
                            fb.textContent = (name || '·').slice(0, 1);
                            p.appendChild(fb);
                        }}
                    />
                ) : (
                    <div className="w-full h-full flex items-center justify-center text-white text-xs font-semibold"
                        style={{ background: `linear-gradient(135deg, ${ring}, #c3b2ff)` }}>
                        {(name || '·').slice(0, 1)}
                    </div>
                )}
            </div>
        );

        return commonLayout(
            <div className="w-64 rounded-2xl overflow-hidden shadow-sm border cursor-pointer active:opacity-90 transition-opacity"
                style={{
                    borderColor: '#f3d9e6',
                    background: 'linear-gradient(135deg, #fff2f7 0%, #f5edff 55%, #eaf1ff 100%)',
                }}>

                {/* 一起听 · 居中双头像头图（仅 join / join_and_add 显示）*/}
                {isTogether && (
                    <div className="relative px-3 pt-3 pb-2 overflow-hidden">
                        {/* 粉紫光晕背景 */}
                        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-70"
                            style={{
                                background: `radial-gradient(ellipse at 30% 50%, rgba(255,170,200,0.32) 0%, transparent 52%),
                                             radial-gradient(ellipse at 70% 50%, rgba(195,178,255,0.32) 0%, transparent 55%)`,
                            }} />
                        {/* 居中：用户头像 · ♥ · 角色头像 */}
                        <div className="relative flex items-center justify-center gap-2">
                            {renderAvatar(userAvatar, '你', '#ffb5cf')}
                            <svg width="16" height="15" viewBox="0 0 24 22" fill="none"
                                className="animate-pulse"
                                style={{ color: '#ff7fae', filter: 'drop-shadow(0 0 5px rgba(255,127,174,0.55))' }}>
                                <path d="M12 21s-8-5.3-8-11.5C4 6 6.5 3.5 9.5 3.5c1.6 0 3 .8 2.5 2.2C11.5 4.3 12.9 3.5 14.5 3.5 17.5 3.5 20 6 20 9.5 20 15.7 12 21 12 21z"
                                    fill="currentColor" />
                            </svg>
                            {renderAvatar(charAvatar, charName, '#c3b2ff')}
                        </div>
                        {/* 标签 */}
                        <div className="relative mt-1.5 text-center text-[9px] tracking-[0.3em] uppercase font-semibold"
                            style={{ color: '#9c6fc2', opacity: 0.8 }}>
                            Listening Together
                        </div>
                        <div className="relative mt-0.5 text-center text-[11px]"
                            style={{ color: '#5a49a8', fontFamily: `'Noto Serif','Georgia',serif` }}>
                            <span className="font-medium">你</span>
                            <span className="mx-1.5 opacity-50">×</span>
                            <span className="font-medium">{charName || 'Ta'}</span>
                            {intent === 'join_and_add' && (
                                <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded-full align-middle"
                                    style={{ background: 'rgba(195,178,255,0.3)', color: '#7a5db0', border: '1px solid rgba(195,178,255,0.5)' }}>
                                    + 歌单
                                </span>
                            )}
                        </div>
                    </div>
                )}

                {/* Cover */}
                <div className="relative w-full h-28 overflow-hidden">
                    {song.albumPic ? (
                        <img
                            src={song.albumPic}
                            alt=""
                            className="w-full h-full object-cover"
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            onError={(e: any) => {
                                const img = e.target;
                                const container = img.parentElement;
                                if (!container) return;
                                img.style.display = 'none';
                                if (container.querySelector('.music-cover-fallback')) return;
                                const fallback = document.createElement('div');
                                fallback.className = 'music-cover-fallback w-full h-full flex items-center justify-center';
                                fallback.style.background = 'linear-gradient(135deg, #8b7ab8 0%, #6b95c7 100%)';
                                fallback.innerHTML = `<div style="color:rgba(255,255,255,0.9);font-size:24px;">♪</div>`;
                                container.appendChild(fallback);
                            }}
                        />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center"
                            style={{ background: 'linear-gradient(135deg, #8b7ab8 0%, #6b95c7 100%)' }}>
                            <span style={{ color: 'rgba(255,255,255,0.9)', fontSize: '28px' }}>♪</span>
                        </div>
                    )}
                    {/* 纯"收入歌单"保留角标；一起听意图已在头部表达，不再重复 */}
                    {!isTogether && (
                        <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded-full backdrop-blur-sm text-[9px] font-medium"
                            style={{ background: 'rgba(255,255,255,0.85)', color: '#5a49a8' }}>
                            📌 收入歌单
                        </div>
                    )}
                </div>
                <div className="p-3">
                    <div className="font-bold text-sm line-clamp-1 leading-snug"
                        style={{ color: '#2a1f4d', fontFamily: `'Noto Serif','Georgia',serif` }}>
                        {song.name || '未命名'}
                    </div>
                    <div className="text-[10px] mt-0.5 truncate" style={{ color: '#6b5b8f' }}>
                        {song.artists || '—'}
                    </div>
                    {addedTo && (
                        <div className="text-[9px] mt-1.5 italic" style={{ color: '#5a49a8' }}>
                            已加入《{addedTo}》
                        </div>
                    )}
                    <div className="mt-2 pt-1.5 flex items-center gap-1 text-[9px] border-t" style={{ color: '#a89bc5', borderColor: '#e0d9f0' }}>
                        <span style={{ color: '#5a49a8', fontWeight: 600 }}>Shizuku Music</span>
                        <span>·</span>
                        <span>{isUser ? '分享' : '互动'}</span>
                    </div>
                </div>
            </div>
        );
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

    if (m.type === 'mcd_card') {
        const meta = m.metadata || {};
        const kind = meta.mcdCardKind;
        // 来自小程序的卡片 (proposal / cart / candidate) → 主聊天里只渲染一张漂亮的"刷卡"占位
        // 真实可交互内容只在小程序界面里展示, 主聊天里点小程序按钮回到那个界面看。
        if (kind === 'proposal' || kind === 'cart' || kind === 'candidate' || meta.fromMcdMiniApp) {
            const label = kind === 'proposal' ? '推荐了几样'
                : kind === 'cart' ? '想下单的购物车'
                : kind === 'candidate' ? '问问意见'
                : '麦当劳卡片';
            const summary = kind === 'proposal' && Array.isArray(meta.mcdProposal?.items)
                ? `${meta.mcdProposal.items.length} 件: ${meta.mcdProposal.items.slice(0, 3).map((i: any) => i.name).join(' / ')}${meta.mcdProposal.items.length > 3 ? '…' : ''}`
                : kind === 'cart' && Array.isArray(meta.mcdCartItems)
                ? `${meta.mcdCartItems.length} 件: ${meta.mcdCartItems.slice(0, 3).map((i: any) => i.name).join(' / ')}${meta.mcdCartItems.length > 3 ? '…' : ''}`
                : kind === 'candidate' && meta.mcdCandidate?.name
                ? `「${meta.mcdCandidate.name}」`
                : '';
            return commonLayout(
                <div className="w-60 rounded-2xl overflow-hidden border border-yellow-200 shadow-sm bg-gradient-to-br from-yellow-50 to-amber-50 select-none">
                    <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-yellow-300 to-amber-300">
                        <span className="text-lg">🍟</span>
                        <div className="flex-1 min-w-0">
                            <div className="text-[10px] text-yellow-900/70 leading-none">麦当劳卡片</div>
                            <div className="text-[11px] font-bold text-yellow-900 leading-tight">{label}</div>
                        </div>
                    </div>
                    <div className="px-3 py-2 text-[10px] text-slate-500 leading-snug min-h-[28px]">
                        {summary || '在麦当劳小程序里查看完整内容'}
                    </div>
                    <div className="px-3 pb-2 text-[9px] text-yellow-700/60 italic">
                        💳 已记录在麦记录里
                    </div>
                </div>
            );
        }
        // 老的 mcd_card (从旧 LLM 工具调用残留 / 无 kind), 保持原有 McdCard 渲染兼容
        return commonLayout(
            <McdCard
                toolName={meta.mcdToolName || m.content || 'mcd_tool'}
                args={meta.mcdToolArgs}
                result={meta.mcdToolResult}
                error={meta.mcdToolError}
                rawText={meta.mcdToolRawText}
                kind={kind || 'generic'}
                onSendCart={onMcdSendCart}
                onCandidate={onMcdCandidate}
                cartItems={meta.mcdCartItems}
                candidateItem={meta.mcdCandidate}
            />
        );
    }

    if (m.type === 'news_card') {
        const md: any = m.metadata || {};
        const title: string = md.title || '热点';
        const source: string = md.source || '热点';
        const url: string | undefined = md.url;
        const desc: string | undefined = (md.desc && md.desc !== title) ? md.desc : undefined;
        const dateStr = new Date(m.timestamp).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
        const card = (
            <div
                className="w-60 cursor-pointer active:scale-[0.98] transition-transform"
                onClick={() => { if (url) window.open(url, '_blank', 'noopener,noreferrer'); }}
                style={{ fontFamily: `'Noto Serif','Songti SC','Georgia',serif` }}
            >
                <div
                    className="rounded-lg overflow-hidden border border-stone-400/70 shadow-[0_3px_12px_rgba(60,50,30,0.18)]"
                    style={{ background: 'linear-gradient(170deg,#faf6ec 0%,#f3ecdb 100%)' }}
                >
                    {/* 报头 */}
                    <div className="px-3 pt-2 pb-1.5 border-b-2 border-double border-stone-500/60">
                        <div className="flex items-center justify-between text-stone-500">
                            <span className="text-[8.5px] tracking-[0.3em] uppercase font-bold">SullyOS Daily</span>
                            <span className="text-[8.5px] tracking-wide">{dateStr} · 号外</span>
                        </div>
                    </div>
                    {/* 栏目标签 */}
                    <div className="px-3 pt-2.5">
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-white bg-red-700 px-1.5 py-[1px] tracking-wide shadow-sm">
                            <span className="text-[8px]">▌</span>{source}
                        </span>
                    </div>
                    {/* 标题 */}
                    <div className="px-3 pt-1.5 pb-2">
                        <p
                            className="text-[15px] leading-[1.35] font-black text-stone-900"
                            style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                        >
                            {title}
                        </p>
                        {desc && (
                            <p
                                className="text-[11px] leading-snug text-stone-600 mt-1"
                                style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                            >
                                {desc}
                            </p>
                        )}
                    </div>
                    {/* 页脚 */}
                    <div className="px-3 py-1.5 flex items-center justify-between border-t border-stone-400/50">
                        <span className="text-[9px] text-stone-500 italic">{charName || 'Ta'} 转给你看</span>
                        {url
                            ? <span className="text-[10px] text-red-700 font-bold tracking-wide">查看原文 ›</span>
                            : <span className="text-[9px] text-stone-400">热点速读</span>}
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'html_card') {
        const meta: any = m.metadata || {};
        const html: string = (typeof meta.htmlSource === 'string' && meta.htmlSource) ? meta.htmlSource : '';
        if (!html) {
            // 元数据丢了 (老消息或导入数据), 给个友好占位
            return commonLayout(
                <div className="px-4 py-3 rounded-2xl bg-fuchsia-50 text-fuchsia-500 text-xs italic border border-fuchsia-100">
                    [HTML 卡片数据缺失]
                </div>
            );
        }
        // 沙盒 iframe：禁用脚本 / 同源 / 表单提交，避免任意 HTML 越权访问父页面。
        // srcDoc 用一个全宽中心化的 wrapper, 让 270px 的卡片在 iframe 里居中、背景透明。
        const srcDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#334155;}body{display:flex;justify-content:center;padding:0;}*{box-sizing:border-box;}img{max-width:100%;}</style></head><body>${html}</body></html>`;
        return commonLayout(
            <div className="rounded-[18px] overflow-hidden bg-white/0 shadow-sm border border-fuchsia-100/60 max-w-[280px]">
                <iframe
                    title="html-card"
                    srcDoc={srcDoc}
                    // allow-same-origin: 让父页面能读 contentDocument 自动调高度
                    // 故意不给 allow-scripts / allow-forms / allow-popups —
                    // AI 输出里的 <script> 不会执行, 表单 / 弹窗 / 顶层跳转 也都被拦。
                    sandbox="allow-same-origin"
                    referrerPolicy="no-referrer"
                    className="block w-[280px] min-h-[120px] border-0 bg-transparent"
                    style={{ height: 200 }}
                    onLoad={(e) => {
                        try {
                            const f = e.currentTarget;
                            const doc = f.contentDocument;
                            if (!doc || !doc.body) return;
                            const h = Math.min(800, Math.max(60, doc.body.scrollHeight + 4));
                            f.style.height = h + 'px';
                        } catch { /* 同源也读不到时静默 */ }
                    }}
                />
            </div>
        );
    }

    if (m.type === 'social_card' && m.metadata?.post) {
        const post = m.metadata.post;
        // If the saved image is a raw twemoji codepoint (eg "2728"), convert it to the actual emoji character;
        // otherwise leave whatever the AI / user picked unchanged.
        const rawImage: string | undefined = post.images?.[0];
        let displayImage: string | undefined = rawImage;
        if (typeof rawImage === 'string' && /^[0-9a-fA-F-]+$/.test(rawImage)) {
            try {
                const points = rawImage.split('-').map(c => parseInt(c, 16)).filter(n => Number.isFinite(n));
                if (points.length > 0) displayImage = String.fromCodePoint(...points);
            } catch {}
        }
        return commonLayout(
            <div className="w-64 bg-white rounded-xl overflow-hidden shadow-sm border border-slate-100 cursor-pointer active:opacity-90 transition-opacity">
                <div className="h-32 w-full flex items-center justify-center text-6xl relative overflow-hidden" style={{ background: post.bgStyle || '#fce7f3' }}>
                    {displayImage || <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4c4.png" alt="document" className="w-12 h-12" />}
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

        // === Like 520 Card === (必须放在 if (scoreData) 兜底前)
        if (scoreData?.type === 'like520_card') {
            return commonLayout(<Like520ChatCard data={scoreData} />);
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
            m.content ? (
                <img src={m.content} className="max-w-[160px] max-h-[160px] hover:scale-105 transition-transform drop-shadow-md active:scale-95" loading="lazy" decoding="async" />
            ) : (
                <div className="px-3 py-2 rounded-2xl bg-slate-100 text-slate-400 text-xs italic">[表情已丢失]</div>
            )
        );
    }

    if (m.type === 'image') {
        return commonLayout(
            <div className="relative group">
                {m.content ? (
                    <img src={m.content} className="max-w-[200px] max-h-[300px] rounded-2xl shadow-sm border border-black/5" alt="Uploaded" loading="lazy" decoding="async" />
                ) : (
                    <div className="px-4 py-6 rounded-2xl bg-slate-100 text-slate-400 text-xs italic text-center min-w-[120px]">[图片已丢失]</div>
                )}
            </div>
        );
    }

    // --- Dynamic Style Generation for Bubble ---
    const radius = styleConfig.borderRadius;
    const borderObj: React.CSSProperties = { borderRadius: `${radius}px` };

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
