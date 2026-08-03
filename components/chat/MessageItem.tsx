


import React, { useEffect, useRef, useState } from 'react';
import { Message, ChatTheme } from '../../types';
import { tryParseLifeSimResetCard } from '../../utils/lifeSimChatCard';
import { VALID_INTERJECTION_TAGS, cleanVoiceMarkupForDisplay } from '../../utils/minimaxTts';
import { stripFishCuesForDisplay } from '../../utils/fishAudioTts';
import { formatStatCount } from '../../utils/videoParser';
import McdCard from './McdCard';
import HtmlCard from './HtmlCard';
import LuckinCard from './LuckinCard';
import LuckinCheckoutCard from './LuckinCheckoutCard';
import WereadCard from './WereadCard';

// 思考链卡片支持的 12 种风格预设 — 同时被 MessageItem 与 ThinkingChainSettingsModal 复用
export type ThinkingChainStyleId = 'echo' | 'whisper' | 'minimal' | 'ink' | 'neon' | 'terminal' | 'stellar' | 'tama' | 'pixel' | 'muji' | 'ins' | 'custom';
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
    /** 边框宽度（默认 1px）——像素框/电子鸡壳等拟态风格用粗框 */
    borderWidth?: string;
    /** 卡片投影完全覆盖（不设则走 glow 默认逻辑）——硬像素影/ins 软影/机壳圈 */
    cardShadow?: string;
    /** 卡片内部整面覆盖层：扫描线（CRT）/ 点阵（液晶屏） */
    overlay?: 'scanlines' | 'dotMatrix';
    /** 破格装饰：溢出卡片边框的风格化元素（印章/霓虹括角/终端红绿灯/星子/机壳按钮…），由 PsycheDecor 渲染 */
    decoKind?: 'inkSeal' | 'neonGlitch' | 'termHud' | 'starScatter' | 'tamaShell' | 'pixelArrow' | 'insHeart';
}

const SERIF = '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "STKaiti", "KaiTi", serif';
const SANS = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';
const MONO = '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, "Courier New", monospace';
const PIXEL = '"Zpix", "Fusion Pixel 12px", "DotGothic16", "Silver", "Courier New", monospace';

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
    ink: {
        bg: 'linear-gradient(160deg, #f9f6ee 0%, #f2ecdf 60%, #ece4d4 100%)',
        border: 'rgba(70, 60, 48, 0.28)',
        accent: '#4a4238',
        text: '#3d3830',
        subtext: 'rgba(74, 66, 56, 0.55)',
        fadeColor: '#f4efe3',
        fontFamily: SERIF,
        showCorners: false,
        showDivider: true,
        titleZh: '墨迹',
        titleEn: 'INK',
        listenLabel: '展卷',
        silenceLabel: '收卷',
        quoteLeft: '「',
        quoteRight: '」',
        italic: false,
        radius: '2px',
        decoKind: 'inkSeal',
    },
    neon: {
        bg: 'linear-gradient(135deg, #0b1026 0%, #10173a 55%, #1a0f2e 100%)',
        border: 'rgba(94, 234, 212, 0.4)',
        accent: '#5eead4',
        text: '#c8f4ff',
        subtext: 'rgba(94, 234, 212, 0.6)',
        glow: 'rgba(94, 234, 212, 0.32)',
        fadeColor: '#10173a',
        fontFamily: SANS,
        showCorners: true,
        showDivider: false,
        titleZh: '脑域',
        titleEn: 'NEURO-LINK',
        listenLabel: '接入',
        silenceLabel: '断开',
        quoteLeft: '⟨',
        quoteRight: '⟩',
        italic: false,
        radius: '8px',
        overlay: 'scanlines',
        decoKind: 'neonGlitch',
    },
    terminal: {
        bg: '#0b120d',
        border: 'rgba(74, 222, 128, 0.35)',
        accent: '#4ade80',
        text: '#a7e8b4',
        subtext: 'rgba(74, 222, 128, 0.55)',
        glow: 'rgba(74, 222, 128, 0.18)',
        fadeColor: '#0b120d',
        fontFamily: MONO,
        showCorners: false,
        showDivider: true,
        titleZh: '内核',
        titleEn: 'KERNEL.LOG',
        listenLabel: 'tail -f',
        silenceLabel: '^C',
        quoteLeft: '$ ',
        quoteRight: '',
        italic: false,
        radius: '6px',
        decoKind: 'termHud',
    },
    stellar: {
        bg: 'linear-gradient(180deg, #0d1b2a 0%, #16263c 60%, #22344e 100%)',
        border: 'rgba(168, 199, 250, 0.35)',
        accent: '#a8c7fa',
        text: '#dce8ff',
        subtext: 'rgba(168, 199, 250, 0.62)',
        glow: 'rgba(168, 199, 250, 0.3)',
        fadeColor: '#16263c',
        fontFamily: SERIF,
        showCorners: false,
        showDivider: true,
        titleZh: '星语',
        titleEn: 'STELLAR',
        listenLabel: '仰望',
        silenceLabel: '垂眸',
        quoteLeft: '「',
        quoteRight: '」',
        italic: true,
        radius: '12px',
        decoKind: 'starScatter',
    },
    // 拓麻歌子：粉壳 + 液晶点阵屏，框本身拟态成电子宠物机
    tama: {
        bg: 'linear-gradient(180deg, #d6e2c2 0%, #c8d6b0 100%)',
        border: '#f2a5c4',
        accent: '#44562f',
        text: '#3f5230',
        subtext: 'rgba(68, 86, 47, 0.6)',
        fadeColor: '#cfdbb9',
        fontFamily: PIXEL,
        showCorners: false,
        showDivider: true,
        titleZh: '心宠',
        titleEn: 'TMGC-LOG',
        listenLabel: '喂食',
        silenceLabel: '哄睡',
        quoteLeft: '▶',
        quoteRight: '',
        italic: false,
        radius: '16px',
        borderWidth: '3px',
        cardShadow: '0 0 0 3px rgba(242, 165, 196, 0.35), 0 3px 8px rgba(120, 80, 100, 0.18)',
        overlay: 'dotMatrix',
        decoKind: 'tamaShell',
    },
    // 像素：JRPG 对话框，白粗框 + 硬像素投影
    pixel: {
        bg: '#23255e',
        border: '#ffffff',
        accent: '#ffd75e',
        text: '#f2f3ff',
        subtext: 'rgba(242, 243, 255, 0.65)',
        fadeColor: '#23255e',
        fontFamily: PIXEL,
        showCorners: false,
        showDivider: false,
        titleZh: '任务',
        titleEn: 'QUEST.LOG',
        listenLabel: '继续',
        silenceLabel: '合上',
        quoteLeft: '『',
        quoteRight: '』',
        italic: false,
        radius: '2px',
        borderWidth: '3px',
        cardShadow: '4px 4px 0 rgba(0, 0, 0, 0.4)',
        decoKind: 'pixelArrow',
    },
    // 性冷淡：暖灰米白、细线、留白，什么装饰都不要
    muji: {
        bg: '#f7f6f3',
        border: 'rgba(60, 60, 54, 0.14)',
        accent: '#8a8a84',
        text: '#4d4d48',
        subtext: 'rgba(90, 90, 84, 0.5)',
        fadeColor: '#f7f6f3',
        fontFamily: SANS,
        showCorners: false,
        showDivider: true,
        titleZh: '独白',
        titleEn: 'MONOLOGUE',
        listenLabel: '展开',
        silenceLabel: '收起',
        quoteLeft: '',
        quoteRight: '',
        italic: false,
        radius: '6px',
    },
    // ins：白卡软影 feed 风，右上一颗小红心
    ins: {
        bg: '#ffffff',
        border: 'rgba(0, 0, 0, 0.07)',
        accent: '#e1306c',
        text: '#262626',
        subtext: '#8e8e8e',
        fadeColor: '#ffffff',
        fontFamily: SANS,
        showCorners: false,
        showDivider: false,
        titleZh: '碎碎念',
        titleEn: 'STORIES',
        listenLabel: '查看',
        silenceLabel: '收起',
        quoteLeft: '“',
        quoteRight: '”',
        italic: false,
        radius: '16px',
        cardShadow: '0 4px 16px rgba(0, 0, 0, 0.07)',
        decoKind: 'insHeart',
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

// 心象卡片的「破格」装饰：溢出卡片边框的风格化元素。
// 必须渲染在卡片（overflow-hidden）的兄弟层、且父容器 relative + 不裁剪，才能真的探出边框。
// 被 ThinkingChainBlock 与设置弹窗的 StylePreview 共用；compact 用于迷你预览缩小尺寸。
export const PsycheDecor: React.FC<{ spec: ThinkingChainStyleSpec; compact?: boolean }> = ({ spec, compact }) => {
    switch (spec.decoKind) {
        case 'inkSeal': // 右下角压出边框的朱文印
            return (
                <span
                    aria-hidden
                    className="absolute z-10 pointer-events-none flex items-center justify-center font-bold"
                    style={{
                        bottom: compact ? -4 : -7,
                        right: compact ? -2 : -4,
                        width: compact ? 15 : 23,
                        height: compact ? 15 : 23,
                        background: '#b3382c',
                        color: '#f7ede0',
                        fontSize: compact ? 8 : 12,
                        fontFamily: SERIF,
                        borderRadius: 3,
                        transform: 'rotate(9deg)',
                        boxShadow: '0 1px 3px rgba(80, 20, 10, 0.4)',
                        opacity: 0.92,
                    }}
                >心</span>
            );
        case 'neonGlitch': // 探出四角的霓虹括角（青 × 品红错位残影）
            return (
                <>
                    <span aria-hidden className={`absolute z-10 pointer-events-none border-t-2 border-l-2 ${compact ? '-top-0.5 -left-0.5 w-2 h-2' : '-top-1 -left-1 w-3 h-3'}`} style={{ borderColor: spec.accent, filter: `drop-shadow(0 0 3px ${spec.accent})` }} />
                    <span aria-hidden className={`absolute z-10 pointer-events-none border-b-2 border-r-2 ${compact ? '-bottom-0.5 -right-0.5 w-2 h-2' : '-bottom-1 -right-1 w-3 h-3'}`} style={{ borderColor: '#f0abfc', filter: 'drop-shadow(0 0 3px #f0abfc)' }} />
                </>
            );
        case 'termHud': // 顶出上边框的窗口红绿灯
            return (
                <span aria-hidden className="absolute z-10 pointer-events-none flex gap-1" style={{ top: compact ? -2 : -3, right: compact ? 8 : 12 }}>
                    {['#ff5f56', '#ffbd2e', '#27c93f'].map(c => (
                        <span key={c} className="rounded-full" style={{ width: compact ? 4 : 6, height: compact ? 4 : 6, background: c, boxShadow: `0 0 4px ${c}88` }} />
                    ))}
                </span>
            );
        case 'starScatter': // 缀在边框内外的星子
            return (
                <>
                    <span aria-hidden className="absolute z-10 pointer-events-none animate-pulse" style={{ top: compact ? -5 : -8, right: compact ? 10 : 16, color: spec.accent, fontSize: compact ? 8 : 12, textShadow: spec.glow ? `0 0 6px ${spec.glow}` : undefined }}>✦</span>
                    <span aria-hidden className="absolute z-10 pointer-events-none" style={{ top: compact ? 6 : 10, right: compact ? -4 : -6, color: spec.accent, fontSize: compact ? 6 : 8, opacity: 0.75 }}>✧</span>
                    <span aria-hidden className="absolute z-10 pointer-events-none animate-pulse" style={{ bottom: compact ? -3 : -5, left: compact ? 12 : 20, color: spec.accent, fontSize: compact ? 5 : 7, opacity: 0.6, animationDelay: '0.8s' }}>✦</span>
                </>
            );
        case 'tamaShell': // 底边探出的机壳三按钮（电子宠物机的 A/B/C 键）
            return (
                <span aria-hidden className="absolute z-10 pointer-events-none flex" style={{ bottom: compact ? -5 : -8, left: '50%', transform: 'translateX(-50%)', gap: compact ? 5 : 8 }}>
                    {[0, 1, 2].map(i => (
                        <span
                            key={i}
                            className="rounded-full"
                            style={{
                                width: compact ? 5 : 8,
                                height: compact ? 5 : 8,
                                background: 'radial-gradient(circle at 35% 30%, #fbc9dd, #ee8fb6)',
                                boxShadow: '0 1px 2px rgba(150, 80, 110, 0.45), inset 0 0.5px 1px rgba(255,255,255,0.7)',
                            }}
                        />
                    ))}
                </span>
            );
        case 'pixelArrow': // JRPG「还有下文」的闪烁小三角，压在右下边框上
            return (
                <span
                    aria-hidden
                    className="absolute z-10 pointer-events-none animate-pulse"
                    style={{
                        bottom: compact ? -4 : -7,
                        right: compact ? 8 : 14,
                        color: spec.accent,
                        fontSize: compact ? 8 : 12,
                        textShadow: '1px 1px 0 rgba(0,0,0,0.5)',
                    }}
                >▼</span>
            );
        case 'insHeart': // 右上角一颗小红心，feed 点赞感
            return (
                <span
                    aria-hidden
                    className="absolute z-10 pointer-events-none"
                    style={{
                        top: compact ? -5 : -7,
                        right: compact ? 8 : 14,
                        color: spec.accent,
                        fontSize: compact ? 9 : 13,
                        transform: 'rotate(10deg)',
                        filter: 'drop-shadow(0 1px 2px rgba(225, 48, 108, 0.35))',
                    }}
                >♥</span>
            );
        default:
            return null;
    }
};

// 思考链卡片：可视化 metadata.thinkingChain。
// 内容来源：useChatAI 抽取的 LLM reasoning_content + <think>/<thinking>/<thought>。
// 多风格通过 resolveThinkingChainStyle() 统一渲染；齿轮触发 onOpenSettings 进入设置弹窗。
export const ThinkingChainBlock: React.FC<{
    chain: string;
    styleId?: ThinkingChainStyleId;
    customColors?: { bg?: string; accent?: string; text?: string };
    onOpenSettings?: () => void;
}> = ({ chain, styleId, customColors, onOpenSettings }) => {
    const [expanded, setExpanded] = useState(false);
    const [copyState, setCopyState] = useState<'idle' | 'ready' | 'ok' | 'error'>('idle');
    const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pointerIdRef = useRef<number | null>(null);
    const pointerTypeRef = useRef<React.PointerEvent<HTMLDivElement>['pointerType']>('');
    const pointerStartRef = useRef({ x: 0, y: 0 });
    const longPressReadyRef = useRef(false);
    const suppressNextClickRef = useRef(false);
    const trimmed = (chain || '').trim();
    const spec = resolveThinkingChainStyle(styleId, customColors);
    const firstLine = trimmed.replace(/\s+/g, ' ').slice(0, 38);
    const hasMore = trimmed.length > 38;

    const clearCopyTimer = () => {
        if (copyTimerRef.current) {
            clearTimeout(copyTimerRef.current);
            copyTimerRef.current = null;
        }
    };

    useEffect(() => () => {
        clearCopyTimer();
        if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    }, []);

    if (!trimmed) return null;

    const copyThinkingChain = async () => {
        let success = false;
        try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
            await navigator.clipboard.writeText(trimmed);
            success = true;
        } catch {
            // iOS PWA / 非安全上下文可能拒绝 Clipboard API，保留 textarea 兜底。
            let textarea: HTMLTextAreaElement | null = null;
            try {
                textarea = document.createElement('textarea');
                textarea.value = trimmed;
                textarea.setAttribute('readonly', '');
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                textarea.style.pointerEvents = 'none';
                document.body.appendChild(textarea);
                textarea.select();
                textarea.setSelectionRange(0, textarea.value.length);
                success = document.execCommand('copy');
            } catch {
                success = false;
            } finally {
                textarea?.remove();
            }
        }

        setCopyState(success ? 'ok' : 'error');
        if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = setTimeout(() => setCopyState('idle'), 1600);
    };

    const resetLongPress = () => {
        clearCopyTimer();
        longPressReadyRef.current = false;
        if (copyState === 'ready') setCopyState('idle');
    };

    // 必须由 pointerup / touchend / contextmenu 这类真实用户手势直接调用。
    // Safari 会拒绝在长按 setTimeout 回调里发起的剪贴板写入。
    const finishLongPressCopy = () => {
        if (!longPressReadyRef.current) return false;
        clearCopyTimer();
        longPressReadyRef.current = false;
        suppressNextClickRef.current = true;
        void copyThinkingChain();
        return true;
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.stopPropagation();
        pointerTypeRef.current = e.pointerType;
        if (e.button !== 0) return;
        pointerIdRef.current = e.pointerId;
        pointerStartRef.current = { x: e.clientX, y: e.clientY };
        longPressReadyRef.current = false;
        suppressNextClickRef.current = false;
        clearCopyTimer();
        copyTimerRef.current = setTimeout(() => {
            copyTimerRef.current = null;
            longPressReadyRef.current = true;
            setCopyState('ready');
            try { navigator.vibrate?.(20); } catch { /* vibration is optional */ }
        }, 450);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        e.stopPropagation();
        if (pointerIdRef.current !== e.pointerId) return;
        const dx = e.clientX - pointerStartRef.current.x;
        const dy = e.clientY - pointerStartRef.current.y;
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) resetLongPress();
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        e.stopPropagation();
        if (pointerIdRef.current !== e.pointerId) return;
        pointerIdRef.current = null;
        if (!finishLongPressCopy()) resetLongPress();
    };

    const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
        e.stopPropagation();
        if (pointerIdRef.current !== e.pointerId) return;
        pointerIdRef.current = null;
        clearCopyTimer();
        // iOS 弹出原生选区时可能先派发 pointercancel，随后仍会派发 touchend。
        // 此时保留 ready，让 touchend 仍可在真实用户手势中执行复制。
        if (e.pointerType !== 'touch' || !longPressReadyRef.current) resetLongPress();
    };

    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        e.stopPropagation();
        if (suppressNextClickRef.current) {
            suppressNextClickRef.current = false;
            e.preventDefault();
            return;
        }
        setExpanded(v => !v);
    };

    const copyStatusLabel = copyState === 'ok'
        ? '已复制'
        : copyState === 'ready'
            ? '松开复制'
            : copyState === 'error'
                ? '请用系统复制'
                : expanded ? spec.silenceLabel : spec.listenLabel;

    return (
        <div
            className="sully-psyche relative mb-2 w-full max-w-full select-text cursor-pointer group"
            role="button"
            tabIndex={0}
            aria-label="心象：点击展开，长按复制全文"
            title="长按复制心象全文"
            onClick={handleClick}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onTouchEnd={(e) => {
                e.stopPropagation();
                finishLongPressCopy();
            }}
            onContextMenu={(e) => {
                e.stopPropagation();
                // 触屏保留 Safari 原生蓝色选区与复制菜单，作为剪贴板权限受限时的兜底。
                if (pointerTypeRef.current !== 'mouse') return;
                e.preventDefault();
                suppressNextClickRef.current = false;
                void copyThinkingChain();
            }}
            onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                setExpanded(v => !v);
            }}
            style={{
                touchAction: 'pan-y',
                userSelect: 'text',
                WebkitUserSelect: 'text',
                WebkitTouchCallout: 'default',
            }}
        >
            <div
                className="sully-psyche-card relative overflow-hidden px-4 py-2.5 transition-all duration-300"
                style={{
                    background: spec.bg,
                    border: `${spec.borderWidth || '1px'} solid ${spec.border}`,
                    borderRadius: spec.radius,
                    boxShadow: spec.cardShadow
                        ? spec.cardShadow
                        : spec.glow
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
                {/* 内部整面覆盖层：CRT 扫描线 / 液晶点阵 */}
                {spec.overlay === 'scanlines' && (
                    <div
                        aria-hidden
                        className="absolute inset-0 pointer-events-none opacity-[0.13]"
                        style={{ background: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(94, 234, 212, 0.6) 3px, transparent 4px)' }}
                    />
                )}
                {spec.overlay === 'dotMatrix' && (
                    <div
                        aria-hidden
                        className="absolute inset-0 pointer-events-none opacity-[0.18]"
                        style={{ background: 'radial-gradient(rgba(60, 80, 40, 0.55) 0.5px, transparent 0.6px)', backgroundSize: '3px 3px' }}
                    />
                )}

                {/* 标题行 */}
                <div className="relative flex items-center gap-2">
                    <span
                        className="sully-psyche-title text-[13px] font-semibold tracking-[0.4em]"
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
                        {copyStatusLabel}
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
                        className={`sully-psyche-preview relative mt-1.5 text-[12px] leading-snug truncate ${spec.italic ? 'italic' : ''}`}
                        style={{ color: spec.text, fontFamily: spec.fontFamily }}
                    >
                        <span style={{ color: spec.accent, marginRight: 2 }}>{spec.quoteLeft}</span>
                        {firstLine}{hasMore ? '…' : ''}
                        <span style={{ color: spec.accent, marginLeft: 2 }}>{spec.quoteRight}</span>
                        {spec.decoKind === 'termHud' && <span className="animate-pulse" style={{ color: spec.accent, marginLeft: 3 }}>▊</span>}
                    </div>
                )}
                {expanded && (
                    <div className="relative mt-1.5">
                        {/* 上下软渐变盖掉系统滚动条; fadeColor 跟卡片背景一致 */}
                        {spec.fadeColor && (
                            <>
                                <div aria-hidden className="absolute top-0 left-0 right-0 h-3 pointer-events-none z-10" style={{ background: `linear-gradient(to bottom, ${spec.fadeColor} 0%, transparent 100%)` }} />
                                <div aria-hidden className="absolute bottom-0 left-0 right-0 h-3 pointer-events-none z-10" style={{ background: `linear-gradient(to top, ${spec.fadeColor} 0%, transparent 100%)` }} />
                            </>
                        )}
                        <div
                            className={`sully-psyche-body no-scrollbar relative pl-3 pr-1 py-2 text-[12.5px] leading-[1.85] whitespace-pre-wrap break-words max-h-72 overflow-auto ${spec.italic ? 'italic' : ''}`}
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
            {/* 破格装饰渲染在卡片外层（卡片自身 overflow-hidden 裁不掉它） */}
            <PsycheDecor spec={spec} />
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
                <div className="fixed inset-0 z-[100] bg-slate-50 flex flex-col animate-fade-in" style={{ paddingBottom: 'var(--safe-bottom)' }} onClick={(e) => e.stopPropagation()}>
                    {/* Header */}
                    <div className="pt-[calc(var(--safe-top)+0.75rem)] pb-3 px-4 bg-white border-b border-slate-100 shrink-0 flex items-center gap-3">
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
// 转账卡片：点开看精美详情，可接收 / 退回；回执则渲染成小卡
// ============================================================

type TransferStatus = 'pending' | 'accepted' | 'returned';

const SullyPayMark: React.FC<{ className?: string }> = ({ className }) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M12 7.5a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5Z" />
        <path fillRule="evenodd" d="M1.5 4.875C1.5 3.839 2.34 3 3.375 3h17.25c1.035 0 1.875.84 1.875 1.875v9.75c0 1.036-.84 1.875-1.875 1.875H3.375A1.875 1.875 0 0 1 1.5 14.625v-9.75ZM8.25 9.75a3.75 3.75 0 1 1 7.5 0 3.75 3.75 0 0 1-7.5 0ZM18.75 9a.75.75 0 0 0-.75.75v.008c0 .414.336.75.75.75h.008a.75.75 0 0 0 .75-.75V9.75a.75.75 0 0 0-.75-.75h-.008ZM4.5 9.75A.75.75 0 0 1 5.25 9h.008a.75.75 0 0 1 .75.75v.008a.75.75 0 0 1-.75.75H5.25a.75.75 0 0 1-.75-.75V9.75Z" clipRule="evenodd" />
        <path d="M2.25 18a.75.75 0 0 0 0 1.5c5.4 0 10.63.722 15.6 2.075 1.19.324 2.4-.558 2.4-1.82V18.75a.75.75 0 0 0-.75-.75H2.25Z" />
    </svg>
);

// ─── 生活记录代记卡（角色 [[LIFE:...]] 落库后插入；用户可确认 / 否决）───
const LIFE_CARD_STYLE: Record<string, { icon: string; ring: string; bg: string; label: string }> = {
    period: { icon: '🌙', ring: '#fda4af', bg: 'linear-gradient(135deg,#fff1f2 0%,#ffe4e6 100%)', label: '生理期' },
    med: { icon: '💊', ring: '#7dd3fc', bg: 'linear-gradient(135deg,#f0f9ff 0%,#e0f2fe 100%)', label: '药盒' },
    expense: { icon: '🧾', ring: '#fcd34d', bg: 'linear-gradient(135deg,#fffbeb 0%,#fef3c7 100%)', label: '记账' },
    exercise: { icon: '🏃', ring: '#6ee7b7', bg: 'linear-gradient(135deg,#ecfdf5 0%,#d1fae5 100%)', label: '锻炼' },
};

const LifeRecordCard: React.FC<{
    m: Message;
    charName: string;
    commonLayout: (content: React.ReactNode) => JSX.Element;
    selectionMode: boolean;
    onResolveLifeRecord?: (m: Message, action: 'confirmed' | 'rejected') => void;
}> = ({ m, charName, commonLayout, selectionMode, onResolveLifeRecord }) => {
    const meta = m.metadata || {};
    const style = LIFE_CARD_STYLE[meta.module as string] || LIFE_CARD_STYLE.exercise;
    const summary: string = meta.summary || '生活记录';
    const isDuplicate: boolean = !!meta.duplicate;
    const reviewStatus: 'active' | 'confirmed' | 'rejected' = meta.reviewStatus || 'active';
    const canResolve = !isDuplicate && reviewStatus === 'active' && !!onResolveLifeRecord && !selectionMode;
    const dateLabel = (() => {
        const d = (meta.dateStr || '').split('-');
        return d.length === 3 ? `${parseInt(d[1], 10)}月${parseInt(d[2], 10)}日` : '';
    })();

    return commonLayout(
        <div className="w-64 rounded-2xl overflow-hidden shadow-sm border border-white/70" style={{ background: style.bg }}>
            <div className="px-3.5 pt-3 pb-2.5">
                <div className="flex items-center gap-2.5">
                    <div className="shrink-0 w-9 h-9 rounded-full bg-white/80 flex items-center justify-center text-lg shadow-sm"
                        style={{ boxShadow: `0 0 0 2px ${style.ring}55` }}>
                        {style.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className={`text-xs font-bold text-slate-700 truncate ${reviewStatus === 'rejected' ? 'line-through opacity-50' : ''}`}>
                            {summary}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                            {style.label}{dateLabel ? ` · ${dateLabel}` : ''} · {meta.recordedByName || charName} 代记
                        </div>
                    </div>
                </div>

                {isDuplicate ? (
                    <div className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-500 bg-white/60 rounded-xl px-2.5 py-1.5">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" strokeWidth={2.5} stroke="currentColor" className="w-3 h-3 text-emerald-500 shrink-0"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
                        <span>此前已由「{meta.duplicateBy || '其他角色'}」记录，无需重复</span>
                    </div>
                ) : reviewStatus === 'confirmed' ? (
                    <div className="mt-2 flex items-center gap-1.5 text-[10px] text-emerald-600 font-semibold px-1">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" strokeWidth={3} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
                        已确认
                    </div>
                ) : reviewStatus === 'rejected' ? (
                    <div className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-400 font-semibold px-1">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" strokeWidth={2.5} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                        已否决（记录已撤销，TA 下次会知道弄错了）
                    </div>
                ) : canResolve ? (
                    <div className="mt-2.5 flex gap-2">
                        <button
                            onClick={(e) => { e.stopPropagation(); onResolveLifeRecord?.(m, 'confirmed'); }}
                            className="flex-1 py-1.5 rounded-xl bg-white/85 text-emerald-600 text-[11px] font-bold shadow-sm active:scale-95 transition-transform"
                        >
                            ✓ 确认
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); onResolveLifeRecord?.(m, 'rejected'); }}
                            className="flex-1 py-1.5 rounded-xl bg-white/60 text-slate-500 text-[11px] font-bold shadow-sm active:scale-95 transition-transform"
                        >
                            ✗ 否决
                        </button>
                    </div>
                ) : null}
            </div>
            <div className="px-3.5 py-1.5 bg-white/40 border-t border-white/60 text-[9px] text-slate-400">
                📋 生活记录
            </div>
        </div>
    );
};

const TransferCard: React.FC<{
    m: Message;
    isUser: boolean;
    charName: string;
    commonLayout: (content: React.ReactNode) => JSX.Element;
    selectionMode: boolean;
    onResolveTransfer?: (m: Message, action: 'accepted' | 'returned') => void;
}> = ({ m, isUser, charName, commonLayout, selectionMode, onResolveTransfer }) => {
    const [open, setOpen] = useState(false);
    const meta = m.metadata || {};
    const amount = meta.amount;
    const note: string | undefined = meta.note;
    const receipt: 'accepted' | 'returned' | undefined = meta.receipt;
    const status: TransferStatus = (meta.status as TransferStatus) || 'pending';

    const actor = isUser ? '你' : charName;
    const counterparty = isUser ? charName : '你';

    // ---- 回执小卡：接收 / 退回的轻量结算条 ----
    if (receipt) {
        const accepted = receipt === 'accepted';
        return commonLayout(
            <div className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl shadow-sm border w-fit max-w-[240px] ${
                accepted
                    ? 'bg-gradient-to-br from-emerald-50 to-teal-50 border-emerald-100'
                    : 'bg-gradient-to-br from-slate-50 to-slate-100 border-slate-200'
            }`}>
                <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${accepted ? 'bg-emerald-400/90 text-white' : 'bg-slate-300/90 text-white'}`}>
                    {accepted ? (
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" strokeWidth={3} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
                    ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" strokeWidth={2.5} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" /></svg>
                    )}
                </div>
                <div className="min-w-0">
                    <div className={`text-xs font-semibold ${accepted ? 'text-emerald-700' : 'text-slate-600'}`}>
                        {actor}{accepted ? '已收款' : '退回了转账'}
                    </div>
                    {amount !== undefined && (
                        <div className="text-[10px] text-slate-400">₩ {amount}</div>
                    )}
                </div>
            </div>
        );
    }

    // ---- 主转账卡（可点开）----
    const resolved = status !== 'pending';
    // 用户是「收到方」才出现接收/退回入口：即这条是角色发来的、且仍待处理。
    const canResolve = !isUser && !resolved && !!onResolveTransfer;

    const statusBadge = status === 'accepted' ? '已收款' : status === 'returned' ? '已退还' : '';

    const handleResolve = (action: 'accepted' | 'returned') => {
        onResolveTransfer?.(m, action);
        setOpen(false);
    };

    return (
        <>
            {commonLayout(
                <div
                    onClick={(e) => { if (selectionMode) return; e.stopPropagation(); setOpen(true); }}
                    className={`w-64 rounded-2xl p-4 text-white shadow-lg relative overflow-hidden cursor-pointer active:scale-[0.98] transition-transform ${
                        resolved ? 'bg-gradient-to-br from-amber-300/80 to-orange-400/80' : 'bg-gradient-to-br from-amber-400 to-orange-500'
                    }`}
                >
                    <div className="absolute top-0 right-0 p-4 opacity-20"><SullyPayMark className="w-12 h-12" /></div>
                    <div className="flex items-center gap-3 mb-2">
                        <div className="p-2 bg-white/20 rounded-full"><SullyPayMark className="w-5 h-5" /></div>
                        <span className="font-medium text-white/90">Sully Pay</span>
                    </div>
                    <div className="text-2xl font-bold tracking-tight mb-1">₩ {amount}</div>
                    {note ? (
                        <div className="text-[11px] text-white/80 truncate mb-0.5">{note}</div>
                    ) : null}
                    <div className="flex items-center justify-between">
                        <div className="text-[10px] text-white/70">转账给{counterparty}</div>
                        {statusBadge && (
                            <span className="text-[9px] bg-white/25 backdrop-blur-sm px-1.5 py-0.5 rounded-full">{statusBadge}</span>
                        )}
                    </div>
                </div>
            )}

            {open && (
                <div className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm flex items-center justify-center p-6 animate-fade-in" onClick={(e) => { e.stopPropagation(); setOpen(false); }}>
                    <div
                        className="w-full max-w-[320px] bg-white rounded-3xl overflow-hidden shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* 顶部金额区 */}
                        <div className="bg-gradient-to-br from-amber-400 to-orange-500 px-6 pt-7 pb-8 text-white relative overflow-hidden">
                            <div className="absolute -top-4 -right-4 opacity-15"><SullyPayMark className="w-28 h-28" /></div>
                            <div className="flex items-center gap-2 mb-5">
                                <div className="p-1.5 bg-white/20 rounded-full"><SullyPayMark className="w-4 h-4" /></div>
                                <span className="text-sm font-medium text-white/90">Sully Pay 转账</span>
                            </div>
                            <div className="text-[11px] text-white/70 mb-1">{isUser ? `你向${charName}转账` : `${charName}向你转账`}</div>
                            <div className="text-4xl font-bold tracking-tight">₩ {amount}</div>
                        </div>

                        {/* 详情区 */}
                        <div className="px-6 py-5 space-y-3.5">
                            {note && (
                                <div className="bg-slate-50 rounded-xl px-3.5 py-2.5">
                                    <div className="text-[10px] text-slate-400 mb-0.5">转账留言</div>
                                    <div className="text-sm text-slate-700 break-words">{note}</div>
                                </div>
                            )}
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-slate-400">付款方</span>
                                <span className="text-slate-700 font-medium">{isUser ? '你' : charName}</span>
                            </div>
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-slate-400">收款方</span>
                                <span className="text-slate-700 font-medium">{isUser ? charName : '你'}</span>
                            </div>
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-slate-400">状态</span>
                                <span className={`font-medium ${
                                    status === 'accepted' ? 'text-emerald-600' : status === 'returned' ? 'text-slate-500' : 'text-amber-600'
                                }`}>
                                    {status === 'accepted' ? '已收款' : status === 'returned' ? '已退还' : '等待对方处理'}
                                </span>
                            </div>

                            {canResolve ? (
                                <div className="flex gap-3 pt-2">
                                    <button
                                        onClick={() => handleResolve('returned')}
                                        className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-500 bg-slate-100 active:scale-95 transition-transform"
                                    >退回</button>
                                    <button
                                        onClick={() => handleResolve('accepted')}
                                        className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-amber-400 to-orange-500 shadow-md active:scale-95 transition-transform"
                                    >接收</button>
                                </div>
                            ) : (
                                <button
                                    onClick={() => setOpen(false)}
                                    className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-500 bg-slate-100 active:scale-95 transition-transform mt-1"
                                >关闭</button>
                            )}
                        </div>
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
    onReply: (m: Message) => void;
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
    onPlayVoice?: (id: number) => void;
    // Chat layout customization
    avatarShape?: 'circle' | 'rounded' | 'square';
    avatarSize?: 'small' | 'medium' | 'large';
    avatarMode?: 'grouped' | 'every_message';
    bubbleVariant?: 'modern' | 'flat' | 'outline' | 'shadow' | 'wechat' | 'ios';
    messageSpacing?: 'compact' | 'default' | 'spacious';
    showTimestamp?: 'always' | 'hover' | 'never';
    /** HTML / 心象 / 音乐卡片的出现位置（聊天细节微调 chatModuleAlign 合并后的生效值）。缺省 = 居中 */
    moduleAlign?: 'anchor' | 'center';
    /** 流式预览无缝接棒时，正式消息首帧已经可见，不应再次从透明态淡入。 */
    suppressEntranceAnimation?: boolean;
    /** Instant Push 准备中：在用户气泡左侧渲染 dot pulse */
    isPending?: boolean;
    /** 是否开启 dot pulse 指示。关掉则 pending 期间不显示任何视觉 */
    pendingIndicator?: boolean;
    /** 麦当劳菜单卡里点了"发送给角色"时调用 */
    onMcdSendCart?: (items: import('./McdCard').McdCartItem[]) => void;
    onMcdCandidate?: (item: import('./McdCard').McdCartItem) => void;
    /** 瑞幸菜单卡 (与麦当劳同构) */
    onLuckinSendCart?: (items: import('./LuckinCard').LuckinCartItem[]) => void;
    onLuckinCandidate?: (item: import('./LuckinCard').LuckinCartItem) => void;
    /** 用户点「收到的转账」卡 → 接收 / 退回 */
    onResolveTransfer?: (m: Message, action: 'accepted' | 'returned') => void;
    /** 用户点「生活记录」卡 → 确认 / 否决（角色代记的记录） */
    onResolveLifeRecord?: (m: Message, action: 'confirmed' | 'rejected') => void;
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
    onReply,
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
    showTimestamp = 'always',
    moduleAlign = 'center',
    suppressEntranceAnimation = false,
    isPending = false,
    pendingIndicator = true,
    onMcdSendCart,
    onMcdCandidate,
    onLuckinSendCart,
    onLuckinCandidate,
    onResolveTransfer,
    onResolveLifeRecord,
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
    // 头像绝对定位在气泡底部尖角处，bottom 恒为 0。
    // 时间戳改用绝对定位浮层（见下方渲染处），不再占据行内高度，
    // 于是气泡列底恒等于气泡尖角——头像贴 bottom-0 就始终对齐：
    // 组末/组中、时间戳开或关都一样，发新消息也不会因参考高度变化而位移。
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startPos = useRef({ x: 0, y: 0 });
    const activePointerId = useRef<number | null>(null);
    const activePointerType = useRef<string>('');
    const replyGestureActiveRef = useRef(false);
    const replyReadyRef = useRef(false);

    const styleConfig = isUser ? activeTheme.user : activeTheme.ai;
    const [showVoiceText, setShowVoiceText] = useState(false);
    const [replyOffset, setReplyOffset] = useState(0);
    const [isReplyGestureActive, setIsReplyGestureActive] = useState(false);
    const [isReplyReady, setIsReplyReady] = useState(false);

    const clearLongPressTimer = () => {
        if (!longPressTimer.current) return;
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
    };

    const resetReplyGesture = () => {
        replyGestureActiveRef.current = false;
        replyReadyRef.current = false;
        setIsReplyGestureActive(false);
        setIsReplyReady(false);
        setReplyOffset(0);
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (selectionMode || e.button !== 0) return;
        activePointerId.current = e.pointerId;
        activePointerType.current = e.pointerType;
        startPos.current = { x: e.clientX, y: e.clientY };
        document.getSelection()?.removeAllRanges();

        clearLongPressTimer();
        longPressTimer.current = setTimeout(() => {
            longPressTimer.current = null;
            activePointerId.current = null;
            activePointerType.current = '';
            resetReplyGesture();
            onLongPress(m);
        }, 600);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (activePointerId.current !== e.pointerId) return;
        const diffX = e.clientX - startPos.current.x;
        const diffY = e.clientY - startPos.current.y;
        const isTouchPointer = activePointerType.current !== 'mouse';

        if (!replyGestureActiveRef.current) {
            const startsReplySwipe = isTouchPointer
                && !isSystem
                && diffX < -8
                && Math.abs(diffX) > Math.abs(diffY);
            if (!startsReplySwipe) {
                if (Math.abs(diffX) > 10 || Math.abs(diffY) > 10) clearLongPressTimer();
                return;
            }
            clearLongPressTimer();
            replyGestureActiveRef.current = true;
            setIsReplyGestureActive(true);
        }

        if (Math.abs(diffY) > 24 && Math.abs(diffY) > Math.abs(diffX)) {
            resetReplyGesture();
            return;
        }

        e.preventDefault();
        document.getSelection()?.removeAllRanges();
        const nextOffset = Math.max(-72, Math.min(0, diffX));
        const nextReady = nextOffset <= -52;
        replyReadyRef.current = nextReady;
        setReplyOffset(nextOffset);
        setIsReplyReady(nextReady);
    };

    const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
        if (activePointerId.current !== e.pointerId) return;
        clearLongPressTimer();
        activePointerId.current = null;
        activePointerType.current = '';

        const shouldReply = replyGestureActiveRef.current && replyReadyRef.current;
        resetReplyGesture();

        if (shouldReply) onReply(m);
    };

    const handlePointerCancel = () => {
        clearLongPressTimer();
        activePointerId.current = null;
        activePointerType.current = '';
        resetReplyGesture();
    };

    const handleClick = (e: React.MouseEvent) => {
        if (selectionMode) {
            e.stopPropagation();
            e.preventDefault();
            onToggleSelect(m.id);
        }
    };

    const interactionProps = {
        onPointerDown: handlePointerDown,
        onPointerUp: handlePointerEnd,
        onPointerMove: handlePointerMove,
        onPointerCancel: handlePointerCancel,
        onContextMenu: (e: React.MouseEvent) => {
            e.preventDefault();
            if (selectionMode || replyGestureActiveRef.current) return;
            clearLongPressTimer();
            activePointerId.current = null;
            activePointerType.current = '';
            resetReplyGesture();
            onLongPress(m);
        },
        onDragStart: (e: React.DragEvent) => e.preventDefault(),
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
            if (scoreData?.type === 'diary_card') {
                const dateParts = (scoreData.date || '').split('-');
                const monthDay = dateParts.length === 3 ? `${dateParts[1]}/${dateParts[2]}` : (scoreData.date || '');
                const year = dateParts[0] || '';
                const userText = (scoreData.userText || '').trim();
                const charText = (scoreData.charText || '').trim();
                const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
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
                            <div className="w-72 mx-auto rounded-2xl overflow-hidden shadow-md" style={{ border: '1.5px solid rgba(217,180,120,0.35)', background: 'linear-gradient(180deg, #fff9ec 0%, #fffdf6 35%, #fdf2dc 100%)' }}>
                                {/* Header — date stamp + char avatar */}
                                <div className="px-4 pt-3 pb-2.5 flex items-center gap-2.5" style={{ borderBottom: '1px dashed rgba(200,160,100,0.3)', background: 'linear-gradient(135deg, rgba(245,210,150,0.25), rgba(240,195,130,0.15))' }}>
                                    {scoreData.charAvatar ? (
                                        <img src={scoreData.charAvatar} className="w-9 h-9 rounded-xl object-cover shadow-sm shrink-0" style={{ boxShadow: '0 0 0 2px rgba(220,180,110,0.5)' }} />
                                    ) : (
                                        <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ background: 'linear-gradient(135deg, #d4a55a, #b8843a)' }}>{scoreData.charName?.[0] || '?'}</div>
                                    )}
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[9px] font-bold tracking-widest uppercase" style={{ color: '#a07840' }}>Exchange Diary · 交换日记</div>
                                        <div className="text-xs font-bold truncate" style={{ color: '#5c3e1a' }}>与 {scoreData.charName} · {scoreData.date}</div>
                                    </div>
                                    <div className="shrink-0 text-right leading-none">
                                        <div className="text-[8px] font-mono opacity-60" style={{ color: '#8a6230' }}>{year}</div>
                                        <div className="text-base font-black font-mono" style={{ color: '#7a4e1a' }}>{monthDay}</div>
                                    </div>
                                </div>

                                {/* User page */}
                                <div className="px-4 pt-3 pb-2">
                                    <div className="flex items-center justify-between mb-1.5">
                                        <span className="text-[9px] font-bold tracking-widest uppercase" style={{ color: '#a07840' }}>● {scoreData.userName || '我'} 写道</span>
                                        {scoreData.userPaperName && <span className="text-[8px] font-mono opacity-50" style={{ color: '#a07840' }}>{scoreData.userPaperName}</span>}
                                    </div>
                                    <div className="rounded-xl px-3 py-2.5 text-[11px] leading-relaxed whitespace-pre-wrap" style={{ background: 'rgba(255,253,245,0.85)', border: '1px solid rgba(217,180,120,0.25)', color: '#4a3520', fontFamily: 'ui-serif, Georgia, serif' }}>
                                        {userText ? truncate(userText, 160) : <span className="opacity-40 italic">(空白页)</span>}
                                    </div>
                                </div>

                                {/* Char page */}
                                <div className="px-4 pb-3 pt-1.5">
                                    <div className="flex items-center justify-between mb-1.5">
                                        <span className="text-[9px] font-bold tracking-widest uppercase" style={{ color: '#a07840' }}>● {scoreData.charName} 回道</span>
                                        {scoreData.charPaperName && <span className="text-[8px] font-mono opacity-50" style={{ color: '#a07840' }}>{scoreData.charPaperName}</span>}
                                    </div>
                                    <div className="rounded-xl px-3 py-2.5 text-[11px] leading-relaxed whitespace-pre-wrap" style={{ background: 'linear-gradient(135deg, rgba(255,245,220,0.85), rgba(255,238,200,0.7))', border: '1px solid rgba(217,180,120,0.3)', color: '#4a3520', fontFamily: 'ui-serif, Georgia, serif' }}>
                                        {charText ? truncate(charText, 200) : <span className="opacity-40 italic">(空白页)</span>}
                                    </div>
                                </div>

                                {/* Footer */}
                                <div className="px-4 py-2 flex items-center justify-between" style={{ borderTop: '1px dashed rgba(200,160,100,0.25)', background: 'linear-gradient(135deg, rgba(245,210,150,0.12), rgba(240,195,130,0.06))' }}>
                                    <span className="text-[9px]" style={{ color: '#b89060' }}>
                                        {(scoreData.userStickerCount || 0) + (scoreData.charStickerCount || 0) > 0
                                            ? `贴了 ${(scoreData.userStickerCount || 0) + (scoreData.charStickerCount || 0)} 张贴纸`
                                            : '今天的纸面很干净'}
                                    </span>
                                    <span className="text-[9px] font-bold" style={{ color: '#a07840' }}>交换日记 ✿</span>
                                </div>
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
    // HTML 卡片（280px 定宽模块）默认位置就是"视觉居中"的约定：包装层打上 sully-html-wrap，
    // 让「聊天细节微调」的贴边/缩进规则 :not() 绕开它——美化怎么开卡片都不挪窝。
    const isHtmlCard = m.type === 'html_card';
    // 音乐卡片（一起听 / 收歌单）与 HTML 卡片同为定宽模块，跟随同一套 chatModuleAlign 约定。
    // 条件与下方渲染分支一致：没有 song 元数据会落回普通气泡，不按模块排版。
    const isMusicCard = m.type === 'music_card' && !!m.metadata?.song;
    const isModuleCard = isHtmlCard || isMusicCard;
    // 聊天细节微调 chatModuleAlign：HTML 卡片 / 心象卡片 / 音乐卡片默认水平居中，'anchor' 才贴气泡列。
    // 心象居中时抽出到气泡行上方的独立行（不带 .group 类，注入的钉位 CSS 自然不命中）。
    const centerModules = moduleAlign !== 'anchor';
    // 心象卡片（思考链）：默认渲染在气泡包装层内、气泡上方；居中模式挪到独立行。
    const thinkingChainNode = !isUser && m.metadata?.thinkingChain ? (
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
                    chain={String(m.metadata!.thinkingChain)}
                    styleId={thinkingChainOptions?.styleId}
                    customColors={thinkingChainOptions?.customColors}
                    onOpenSettings={thinkingChainOptions?.onOpenSettings}
                />
            </div>
        </div>
    ) : null;
    const commonLayout = (content: React.ReactNode) => (
        <>
            {centerModules && thinkingChainNode && (
                <div className="px-3 flex justify-center">
                    <div className="w-[72%] max-w-[72%]">{thinkingChainNode}</div>
                </div>
            )}
            <div className={`flex items-end ${isUser ? 'justify-end' : 'justify-start'} ${marginBottom} px-3 group select-none relative transition-[padding] duration-300 ${selectionMode ? 'pl-12' : ''}`}>
                {selectionMode && (
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 cursor-pointer z-20" onClick={() => onToggleSelect(m.id)}>
                        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-slate-300 bg-white/80'}`}>
                            {isSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                        </div>
                    </div>
                )}

                {/* HTML / 音乐卡片是独立模块，不继承普通消息外壳的角色头像。卡片内部自己的头像不受影响。 */}
                {!isUser && !isModuleCard && (
                    <div className={`absolute bottom-0 z-0 ${selectionMode ? 'left-14' : 'left-3'} transition-[left] duration-300`}>
                        {renderAvatar(charAvatar)}
                    </div>
                )}

                {showPendingDots && (
                    <span
                        className="inline-flex items-center gap-[3px] mb-2 mr-0.5 select-none pointer-events-none"
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
                <div className={`relative max-w-[72%] min-w-0 ${isModuleCard && centerModules ? 'mx-auto' : (!isUser ? 'ml-12' : 'mr-12')} ${isModuleCard ? 'sully-html-wrap' : ''}`}>
                    <div
                        aria-hidden="true"
                        className={`absolute -right-10 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full flex items-center justify-center pointer-events-none transition-all duration-150 ${isReplyReady ? 'bg-indigo-500 text-white shadow-md shadow-indigo-200' : 'bg-white/90 text-slate-400 shadow-sm'}`}
                        style={{
                            opacity: Math.min(1, Math.abs(replyOffset) / 36),
                            transform: `translateY(-50%) scale(${isReplyReady ? 1 : 0.86})`,
                        }}
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                            <path d="M9 17 4 12l5-5" />
                            <path d="M4 12h10a6 6 0 0 1 6 6v1" />
                        </svg>
                    </div>
                    <div
                        className={`relative flex flex-col ${isUser ? 'items-end' : 'items-start'} min-w-0`}
                        style={{
                            transform: `translateX(${replyOffset}px)`,
                            transition: isReplyGestureActive ? 'none' : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                            touchAction: 'pan-y',
                            userSelect: 'none',
                            WebkitUserSelect: 'none',
                            WebkitTouchCallout: 'none',
                        } as React.CSSProperties}
                        {...interactionProps}
                    >
                    {!centerModules && thinkingChainNode}
                    <div className={selectionMode ? 'pointer-events-none' : ''}>
                        {content}
                    </div>
                    {isLastInGroup && showTimestamp !== 'never' && (
                        <div className={`absolute top-full ${isUser ? 'right-0' : 'left-0'} mt-0.5 px-1 text-[9px] text-slate-400/80 font-medium whitespace-nowrap pointer-events-none ${showTimestamp === 'hover' ? 'opacity-0 group-hover:opacity-100 transition-opacity' : ''}`}>{formatTime(m.timestamp)}</div>
                    )}
                    </div>
                </div>

                {/* 用户侧若存在导入/历史模块卡，也保持同一条“卡片不带消息外侧头像”规则。 */}
                {isUser && !isModuleCard && (
                    <div className={`absolute right-3 bottom-0 z-0 transition-[left] duration-300`}>
                        {renderAvatar(userAvatar)}
                    </div>
                )}
            </div>
        </>
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
        const openXhsNote = () => {
            const nid = note.noteId || note.note_id || note.id;
            if (!nid) return;
            const token = note.xsecToken || note.xsec_token;
            const url = `https://www.xiaohongshu.com/explore/${nid}${token ? `?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_feed` : ''}`;
            window.open(url, '_blank', 'noopener,noreferrer');
        };
        return commonLayout(
            <div
                onClick={openXhsNote}
                className="w-64 bg-white rounded-xl overflow-hidden shadow-sm border border-slate-100 cursor-pointer active:opacity-90 transition-opacity">
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

    // --- Webpage Share Card (用户分享的网页 / 视频平台链接) ---
    if (m.type === 'webpage_card' && m.metadata?.webpage) {
        const wp = m.metadata.webpage;
        const vd = wp.video; // videoParser 解析路径才有：平台/作者/热度
        let host = (wp.siteName || '').trim();
        try { host = new URL(wp.finalUrl || wp.url).hostname.replace(/^www\./, ''); } catch { /* 用 siteName 兜底 */ }
        const openPage = () => {
            const u = wp.finalUrl || wp.url;
            if (u) window.open(u, '_blank', 'noopener,noreferrer');
        };
        const excerpt = (wp.excerpt || '').trim();
        const vdStats = vd ? [
            vd.playCount ? `▶ ${formatStatCount(vd.playCount)}` : '',
            vd.likeCount ? `♥ ${formatStatCount(vd.likeCount)}` : '',
            vd.commentCount ? `💬 ${formatStatCount(vd.commentCount)}` : '',
        ].filter(Boolean) : [];
        return commonLayout(
            <div
                onClick={openPage}
                className="w-64 bg-white rounded-2xl overflow-hidden border border-slate-200/80 shadow-[0_2px_10px_rgba(0,0,0,0.05)] cursor-pointer active:opacity-90 transition-opacity">
                {/* 封面图（og:image / 正文首图 / 视频封面），加载失败自动隐藏 */}
                {wp.image && (
                    <div className="relative w-full h-32 bg-slate-100 overflow-hidden">
                        <img
                            src={wp.image}
                            alt=""
                            className="w-full h-full object-cover"
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            onError={(e: any) => { const c = e.target?.parentElement; if (c) c.style.display = 'none'; }}
                        />
                        {/* 视频分享：封面加播放角标；图集显示张数 */}
                        {vd && vd.contentType !== 'image' && (
                            <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                <span className="w-10 h-10 rounded-full bg-black/40 backdrop-blur-[2px] flex items-center justify-center">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-white translate-x-[1px]"><path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.34-5.89a1.5 1.5 0 0 0 0-2.54L6.3 2.84Z" /></svg>
                                </span>
                            </span>
                        )}
                        {vd && vd.contentType === 'image' && !!vd.imageCount && (
                            <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-black/45 text-white text-[9px] font-medium pointer-events-none">
                                图集 · {vd.imageCount}张
                            </span>
                        )}
                    </div>
                )}
                <div className="p-3.5">
                    {/* 域名 / 平台行 */}
                    <div className="flex items-center gap-1.5 mb-2">
                        <span className="w-4 h-4 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-2.5 h-2.5 text-slate-400">
                                <path fillRule="evenodd" d="M12.232 4.232a2.5 2.5 0 0 1 3.536 3.536l-1.225 1.224a.75.75 0 0 0 1.061 1.06l1.224-1.224a4 4 0 0 0-5.656-5.656l-3 3a4 4 0 0 0 .225 5.865.75.75 0 0 0 .977-1.138 2.5 2.5 0 0 1-.142-3.667l3-3Z" clipRule="evenodd" />
                                <path fillRule="evenodd" d="M11.603 7.963a.75.75 0 0 0-.977 1.138 2.5 2.5 0 0 1 .142 3.667l-3 3a2.5 2.5 0 0 1-3.536-3.536l1.225-1.224a.75.75 0 0 0-1.061-1.06l-1.224 1.224a4 4 0 1 0 5.656 5.656l3-3a4 4 0 0 0-.225-5.865Z" clipRule="evenodd" />
                            </svg>
                        </span>
                        <span className="text-[11px] text-slate-400 font-medium truncate">{vd?.platformLabel || host || '网页'}</span>
                    </div>
                    {/* 标题 */}
                    <div className="font-semibold text-[15px] text-slate-800 line-clamp-2 leading-snug">{wp.title || host || '网页'}</div>
                    {/* 视频分享：作者 + 热度行 */}
                    {vd ? (
                        <div className="flex items-center justify-between mt-1.5 gap-2">
                            <span className="text-[10px] text-slate-500 truncate">{vd.authorName ? `@${vd.authorName}` : ''}</span>
                            {vdStats.length > 0 && (
                                <span className="text-[10px] text-slate-400 shrink-0">{vdStats.join(' · ')}</span>
                            )}
                        </div>
                    ) : excerpt ? (
                        <p className="text-xs text-slate-500 line-clamp-3 leading-relaxed mt-1.5">{excerpt}</p>
                    ) : (
                        <p className="text-[11px] text-slate-300 mt-1.5">未能提取到正文预览，点开看原网页</p>
                    )}
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

    if (m.type === 'luckin_card') {
        const meta = m.metadata || {};
        const kind = meta.luckinCardKind;
        // 来自小程序的卡片 (proposal / cart / candidate) → 主聊天里只渲染一张"刷卡"占位
        if (kind === 'proposal' || kind === 'cart' || kind === 'candidate' || meta.fromLuckinMiniApp) {
            const label = kind === 'proposal' ? '推荐了几样'
                : kind === 'cart' ? '想下单的购物车'
                : kind === 'candidate' ? '问问意见'
                : '瑞幸卡片';
            const summary = kind === 'proposal' && Array.isArray(meta.luckinProposal?.items)
                ? `${meta.luckinProposal.items.length} 件: ${meta.luckinProposal.items.slice(0, 3).map((i: any) => i.name).join(' / ')}${meta.luckinProposal.items.length > 3 ? '…' : ''}`
                : kind === 'cart' && Array.isArray(meta.luckinCartItems)
                ? `${meta.luckinCartItems.length} 件: ${meta.luckinCartItems.slice(0, 3).map((i: any) => i.name).join(' / ')}${meta.luckinCartItems.length > 3 ? '…' : ''}`
                : kind === 'candidate' && meta.luckinCandidate?.name
                ? `「${meta.luckinCandidate.name}」`
                : '';
            return commonLayout(
                <div className="w-60 rounded-2xl overflow-hidden border border-blue-200 shadow-sm bg-gradient-to-br from-blue-50 to-sky-50 select-none">
                    <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-blue-600 to-sky-500">
                        <span className="text-lg">🦌</span>
                        <div className="flex-1 min-w-0">
                            <div className="text-[10px] text-white/70 leading-none">瑞幸卡片</div>
                            <div className="text-[11px] font-bold text-white leading-tight">{label}</div>
                        </div>
                    </div>
                    <div className="px-3 py-2 text-[10px] text-slate-500 leading-snug min-h-[28px]">
                        {summary || '在瑞幸小程序里查看完整内容'}
                    </div>
                    <div className="px-3 pb-2 text-[9px] text-blue-700/60 italic">
                        💳 已记录在瑞幸记录里
                    </div>
                </div>
            );
        }
        // 结账卡 (聊天点单 previewOrder 的终点): 可改数量 + 直接扫码支付
        if (kind === 'checkout' && meta.luckinToolResult) {
            return commonLayout(
                <LuckinCheckoutCard
                    deptId={meta.luckinToolArgs?.deptId}
                    args={meta.luckinToolArgs}
                    preview={meta.luckinToolResult}
                    loc={meta.luckinLoc}
                />
            );
        }
        // 工具结果卡 (门店/商品/订单) 或老的 luckin_card → 走 LuckinCard 渲染
        return commonLayout(
            <LuckinCard
                toolName={meta.luckinToolName || m.content || 'luckin_tool'}
                args={meta.luckinToolArgs}
                result={meta.luckinToolResult}
                error={meta.luckinToolError}
                rawText={meta.luckinToolRawText}
                kind={kind || 'generic'}
                onSendCart={onLuckinSendCart}
                onCandidate={onLuckinCandidate}
                cartItems={meta.luckinCartItems}
                candidateItem={meta.luckinCandidate}
            />
        );
    }

    if (m.type === 'weread_card') {
        const meta: any = m.metadata || {};
        return commonLayout(
            <WereadCard metadata={meta} />,
        );
    }

    if (m.type === 'vr_card') {
        const md: any = m.metadata || {};
        const roomNameMap: Record<string, string> = {
            library: '图书馆', music: '听歌房', guestbook: '留言簿', gym: '娱乐室', postoffice: '邮局',
        };
        const roomInfo = { name: roomNameMap[md.room] || '彼方' };
        const activity: string = md.activity || '在彼方度过了一段时间。';
        const excerpts: string[] = Array.isArray(md.annotationExcerpts) ? md.annotationExcerpts : [];
        const timeStr = new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        const card = (
            <div className="w-64">
                <div
                    className="rounded-xl overflow-hidden border border-indigo-300/40 shadow-[0_4px_16px_rgba(60,40,120,0.22)]"
                    style={{ background: 'linear-gradient(155deg,#2a2350 0%,#1b1838 100%)' }}
                >
                    {/* 头部：彼方 · 房间 */}
                    <div className="px-3 pt-2.5 pb-2 flex items-center gap-2 border-b border-white/10">
                        <span className="text-base leading-none text-indigo-200/80" style={{ filter: 'drop-shadow(0 0 5px rgba(170,180,255,.6))' }}>✦</span>
                        <div className="flex-1 min-w-0">
                            <div className="text-[9px] tracking-[0.25em] text-indigo-300/80 font-bold uppercase">彼方 · 动态</div>
                            <div className="text-[12px] text-indigo-100 font-semibold truncate">{roomInfo.name}{md.novelTitle ? ` · 《${md.novelTitle}》` : ''}</div>
                        </div>
                        <span className="text-[9px] text-indigo-300/60">{timeStr}</span>
                    </div>
                    {/* 活动播报 */}
                    <div className="px-3 py-2.5">
                        <p className="text-[12.5px] leading-[1.5] text-indigo-50/95">
                            {md.userBoardPost
                                ? activity
                                : <><span className="font-bold text-amber-200">{charName || 'Ta'}</span> {activity}</>}
                        </p>
                        {excerpts.length > 0 && (
                            <div className="mt-2 space-y-1">
                                {excerpts.map((ex, i) => (
                                    <div key={i} className="text-[11px] leading-snug text-indigo-200/80 pl-2 border-l-2 border-amber-300/50">
                                        {ex}
                                    </div>
                                ))}
                            </div>
                        )}
                        {/* 留言簿：把角色在墙上留的原话也显示出来 */}
                        {Array.isArray(md.boardPosts) && md.boardPosts.length > 0 && (
                            <div className="mt-2 space-y-1">
                                {md.boardPosts.map((p: any, i: number) => (
                                    <div key={i} className="text-[11px] leading-snug text-indigo-100/90 pl-2 border-l-2 border-indigo-300/50">
                                        {p?.replyToName && <span className="text-indigo-300/70">回 {p.replyToName}：</span>}{p?.content}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    {/* 页脚 */}
                    <div className="px-3 py-1.5 border-t border-white/10 flex items-center justify-between">
                        <span className="text-[9px] text-indigo-300/60 italic">{md.userBoardPost ? '你发布到留言墙' : 'Ta 独自度过的时间'}</span>
                        <span className="text-[9px] text-amber-200/70 font-bold tracking-wide">{md.userBoardPost ? '彼方' : '＋记忆'}</span>
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'sim_card') {
        const sc: any = m.metadata?.simCard || {};
        const timeStr = new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        const accent = '#b89bff';
        const card = (
            <div className="w-64">
                <div className="relative rounded-2xl overflow-hidden border shadow-[0_8px_28px_rgba(40,30,70,0.45)]"
                    style={{ borderColor: 'rgba(184,155,255,0.3)', background: 'linear-gradient(160deg,#221c33 0%,#171327 55%,#100d1c 100%)' }}>
                    <div className="absolute -top-7 -right-5 w-24 h-24 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle,rgba(184,155,255,.4),transparent 70%)' }} />
                    <div className="absolute inset-0 pointer-events-none opacity-50" style={{ backgroundImage: 'radial-gradient(1px 1px at 22% 24%,#c9b8ec,transparent),radial-gradient(1px 1px at 62% 18%,#e7c9f0,transparent),radial-gradient(1px 1px at 42% 36%,#bcd0f0,transparent)' }} />
                    {/* 头部 */}
                    <div className="relative px-3 pt-2.5 pb-2 flex items-center gap-2 border-b" style={{ borderColor: 'rgba(184,155,255,0.18)' }}>
                        <span className="text-base leading-none" style={{ color: accent, filter: 'drop-shadow(0 1px 4px rgba(184,155,255,.5))' }}>✦</span>
                        <div className="flex-1 min-w-0">
                            <div className="text-[9px] tracking-[0.25em] font-bold uppercase" style={{ color: accent }}>体验卡 · {sc.mode === 'event' ? '事件' : '日常'}</div>
                            <div className="text-[12px] text-white/90 font-semibold truncate" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{sc.title || '一段回忆'}</div>
                        </div>
                        <span className="text-[9px] text-white/35">{timeStr}</span>
                    </div>
                    {/* 正文 */}
                    <div className="relative px-3 py-2.5">
                        {sc.theme && (
                            <span className="inline-block text-[9px] px-2 py-0.5 rounded-full mb-2" style={{ color: accent, background: 'rgba(184,155,255,0.14)' }}>{sc.theme}</span>
                        )}
                        {sc.summary && (
                            <p className="text-[12px] leading-[1.7] text-white/70 whitespace-pre-wrap max-h-44 overflow-y-auto no-scrollbar" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>
                                {sc.summary}
                            </p>
                        )}
                        {sc.ending && <div className="mt-2 text-[10px] text-white/40">结局 · {sc.ending}</div>}
                    </div>
                    {/* 页脚 */}
                    <div className="relative px-3 py-1.5 border-t flex items-center justify-between" style={{ borderColor: 'rgba(184,155,255,0.18)' }}>
                        <span className="text-[9px] italic text-white/35">你真实经历过的一天</span>
                        <span className="text-[9px] font-bold tracking-wide" style={{ color: accent }}>＋ 收藏为回忆</span>
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'group_topic_card') {
        const box: any = m.metadata?.groupTopicBox || {};
        const card = (
            <div className="w-72 rounded-2xl overflow-hidden border border-violet-200/70 bg-gradient-to-br from-violet-50 via-white to-indigo-50 shadow-sm">
                <div className="px-4 pt-3 pb-2 border-b border-violet-100 flex items-center gap-2">
                    <span className="w-8 h-8 rounded-xl bg-violet-100 text-violet-600 flex items-center justify-center">💬</span>
                    <div className="min-w-0 flex-1">
                        <div className="text-[9px] font-bold tracking-[0.18em] text-violet-400 uppercase">群聊公共话题盒</div>
                        <div className="text-[13px] font-bold text-slate-700 truncate">{box.title || '一段群聊回忆'}</div>
                    </div>
                </div>
                <div className="px-4 py-3">
                    <p className="text-[12px] leading-6 text-slate-600 whitespace-pre-wrap max-h-48 overflow-y-auto no-scrollbar">{box.summary || m.content}</p>
                </div>
                <div className="px-4 py-2 border-t border-violet-100 text-[9px] text-violet-400 flex justify-between">
                    <span>{box.groupName || '群聊'} · 共同经历</span>
                    <span>{box.messageCount ? `${box.messageCount} 条原文` : ''}</span>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'phone_card') {
        const pc: any = m.metadata?.phoneCard || {};
        const timeStr = new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

        // 智能体卡片（偷看到 TA 在玩 AI：助手 / 树洞 / 酒馆）
        if (typeof pc.kind === 'string' && pc.kind.startsWith('ai_')) {
            const svc = pc.service || pc.kind.replace('ai_', '');
            const meta: Record<string, { label: string; accent: string; bg: string; glyph: string }> = {
                assistant: { label: 'AI 助手', accent: '#34d399', bg: 'linear-gradient(150deg,#0e2a22 0%,#0b1f1a 55%,#0a1512 100%)', glyph: '🤖' },
                claude: { label: '深度对话', accent: '#a78bfa', bg: 'linear-gradient(150deg,#1e1830 0%,#171228 55%,#100c1c 100%)', glyph: '✻' },
                tavern: { label: '酒馆', accent: '#fb7185', bg: 'linear-gradient(150deg,#2a1620 0%,#1d1018 55%,#130a0f 100%)', glyph: '🎭' },
            };
            const mm = meta[svc] || meta.assistant;
            const card = (
                <div className="w-64">
                    {/* 用原生 <details> 折叠：默认收起，点头部展开（无需 React state，避免在分支里用 hook） */}
                    <details className="group relative rounded-2xl overflow-hidden border shadow-[0_8px_24px_rgba(10,12,20,0.5)] [&_summary]:list-none [&::-webkit-details-marker]:hidden"
                        style={{ borderColor: `${mm.accent}44`, background: mm.bg }}>
                        <div className="absolute -top-8 -right-6 w-28 h-28 rounded-full blur-2xl pointer-events-none" style={{ background: `radial-gradient(circle, ${mm.accent}55, transparent 70%)` }} />
                        <summary className="relative px-3 pt-2.5 pb-2 flex items-center gap-2 border-b cursor-pointer select-none" style={{ borderColor: `${mm.accent}22` }}>
                            <span className="w-6 h-6 rounded-lg flex items-center justify-center text-[13px] shrink-0" style={{ background: `${mm.accent}22` }}>{mm.glyph}</span>
                            <div className="flex-1 min-w-0">
                                <div className="text-[9px] tracking-[0.22em] font-bold uppercase" style={{ color: mm.accent }}>智能体 · {mm.label}</div>
                                <div className="text-[12px] text-white/90 font-semibold truncate">{pc.serviceName ? `${pc.serviceName} · ${pc.title || ''}` : (pc.title || '一段对话')}</div>
                            </div>
                            <span className="shrink-0 text-[12px] font-bold leading-none transition-transform group-open:rotate-90" style={{ color: mm.accent }}>›</span>
                        </summary>
                        <div className="relative px-3 py-2.5">
                            <p className="text-[12px] leading-[1.7] text-white/65 whitespace-pre-wrap max-h-40 overflow-y-auto no-scrollbar">{pc.detail || ''}</p>
                        </div>
                        <div className="relative px-3 py-1.5 border-t flex items-center justify-between" style={{ borderColor: `${mm.accent}1e` }}>
                            <span className="text-[9px] italic text-white/35">TA 自己手机上的 AI · {timeStr}</span>
                            <span className="text-[9px] font-bold tracking-wide" style={{ color: mm.accent }}>来自查手机</span>
                        </div>
                    </details>
                </div>
            );
            return commonLayout(card);
        }

        // 人际关系变动卡片（用户在查手机里删/拉黑了角色的好友）
        if (pc.kind === 'relationship') {
            const isBlock = pc.action === 'blocked';
            const rAccent = isBlock ? '#fca5a5' : '#fb7185';
            const card = (
                <div className="w-64">
                    <div className="relative rounded-2xl overflow-hidden border shadow-[0_8px_24px_rgba(45,20,30,0.45)]"
                        style={{ borderColor: 'rgba(251,113,133,0.3)', background: 'linear-gradient(160deg,#2a1620 0%,#1d1018 55%,#130a0f 100%)' }}>
                        <div className="absolute -top-7 -right-5 w-24 h-24 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle,rgba(251,113,133,.3),transparent 70%)' }} />
                        <div className="relative px-3 pt-2.5 pb-2 flex items-center gap-2 border-b" style={{ borderColor: 'rgba(251,113,133,0.18)' }}>
                            <span className="text-sm leading-none">{isBlock ? '🚫' : '💔'}</span>
                            <div className="flex-1 min-w-0">
                                <div className="text-[9px] tracking-[0.25em] font-bold uppercase" style={{ color: rAccent }}>人际关系 · 关系变动</div>
                                <div className="text-[12px] text-white/90 font-semibold truncate">{pc.title || '好友关系变动'}</div>
                            </div>
                            <span className="text-[9px] text-white/35">{timeStr}</span>
                        </div>
                        <div className="relative px-3 py-2.5">
                            <p className="text-[12px] leading-[1.6] text-white/70 whitespace-pre-wrap">
                                <span className="font-semibold" style={{ color: rAccent }}>{pc.by || '对方'}</span> 把你和
                                <span className="font-semibold text-white/90">「{pc.contactName || '某人'}」</span>
                                的好友关系{isBlock ? '拉黑' : '删除'}了。
                            </p>
                        </div>
                        <div className="relative px-3 py-1.5 border-t flex items-center justify-between" style={{ borderColor: 'rgba(251,113,133,0.16)' }}>
                            <span className="text-[9px] italic text-white/40">你察觉到是 TA 动的手</span>
                            <span className="text-[9px] font-bold tracking-wide" style={{ color: rAccent }}>来自查手机</span>
                        </div>
                    </div>
                </div>
            );
            return commonLayout(card);
        }

        const accent = '#7dd3fc';
        const isChat = pc.kind === 'chat';
        const card = (
            <div className="w-64">
                <div className="relative rounded-2xl overflow-hidden border shadow-[0_8px_24px_rgba(20,30,45,0.4)]"
                    style={{ borderColor: 'rgba(125,211,252,0.28)', background: 'linear-gradient(160deg,#10202b 0%,#0d1822 55%,#0a1019 100%)' }}>
                    <div className="absolute -top-7 -right-5 w-24 h-24 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle,rgba(125,211,252,.3),transparent 70%)' }} />
                    {/* 头部 */}
                    <div className="relative px-3 pt-2.5 pb-2 flex items-center gap-2 border-b" style={{ borderColor: 'rgba(125,211,252,0.16)' }}>
                        <span className="text-sm leading-none" style={{ color: accent }}>🔍</span>
                        <div className="flex-1 min-w-0">
                            <div className="text-[9px] tracking-[0.25em] font-bold uppercase" style={{ color: accent }}>查手机 · {pc.app || '手机'}</div>
                            <div className="text-[12px] text-white/90 font-semibold truncate">{pc.title || '一条痕迹'}</div>
                        </div>
                        <span className="text-[9px] text-white/35">{timeStr}</span>
                    </div>
                    {/* 正文 */}
                    <div className="relative px-3 py-2.5">
                        {pc.value && (
                            <span className="inline-block text-[10px] font-bold px-2 py-0.5 rounded-full mb-1.5" style={{ color: accent, background: 'rgba(125,211,252,0.14)' }}>{pc.value}</span>
                        )}
                        {pc.detail && (
                            <p className="text-[12px] leading-[1.6] text-white/65 whitespace-pre-wrap max-h-40 overflow-y-auto no-scrollbar">{pc.detail}</p>
                        )}
                    </div>
                    {/* 页脚 */}
                    <div className="relative px-3 py-1.5 border-t flex items-center justify-between" style={{ borderColor: 'rgba(125,211,252,0.16)' }}>
                        <span className="text-[9px] italic text-white/35">{isChat ? 'TA 手机里的一段对话' : 'TA 手机里的一条记录'}</span>
                        <span className="text-[9px] font-bold tracking-wide" style={{ color: accent }}>来自查手机</span>
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'theater_card') {
        const tMeta: any = m.metadata || {};
        const t: any = tMeta.theater || {};
        const lines: any[] = Array.isArray(t.lines) ? t.lines : [];
        const timeStr = new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        const HUE = 262;
        const accent = `hsl(${HUE},75%,72%)`;
        const exposed = tMeta.exposed !== false; // 缺省按已暴露（兼容旧卡片）
        // 由该时段起始时间，给每一拍合成「行为轨迹」时间戳（HH:MM:SS），与窥视面板一致。
        const beatClock = (idx: number): string => {
            const [h, mm] = String(tMeta.slotTime || '00:00').split(':').map((n: string) => parseInt(n, 10));
            const base = (Number.isFinite(h) ? h : 0) * 3600 + (Number.isFinite(mm) ? mm : 0) * 60 + idx * 17;
            const pad = (n: number) => String(n).padStart(2, '0');
            return `${pad(Math.floor(base / 3600) % 24)}:${pad(Math.floor((base % 3600) / 60))}:${pad(base % 60)}`;
        };
        const card = (
            <div className="w-64">
                <div className="relative rounded-2xl overflow-hidden border shadow-[0_8px_28px_rgba(30,18,48,0.5)]"
                    style={{ borderColor: `hsla(${HUE},55%,55%,0.32)`, background: `linear-gradient(160deg,hsl(${HUE},38%,20%) 0%,hsl(${HUE},42%,13%) 58%,#0f0a18 100%)` }}>
                    <div className="absolute -top-7 -right-5 w-24 h-24 rounded-full pointer-events-none" style={{ background: `radial-gradient(circle,hsla(${HUE},70%,60%,.35),transparent 70%)` }} />
                    <div className="absolute inset-0 pointer-events-none opacity-50" style={{ backgroundImage: 'radial-gradient(1px 1px at 22% 30%,rgba(200,180,255,.4),transparent),radial-gradient(1px 1px at 78% 18%,rgba(220,200,255,.35),transparent)' }} />
                    {/* 头部：窥视回放 · LIVE */}
                    <div className="relative px-3 pt-2.5 pb-2 flex items-center gap-2 border-b" style={{ borderColor: `hsla(${HUE},55%,55%,0.2)` }}>
                        <span className="text-sm leading-none" style={{ color: accent, filter: `drop-shadow(0 1px 4px hsla(${HUE},70%,60%,.6))` }}>👁</span>
                        <div className="flex-1 min-w-0">
                            <div className="text-[8.5px] tracking-[0.22em] font-bold uppercase flex items-center gap-1.5" style={{ color: accent }}>
                                <span>窥视回放 · {tMeta.slotTime || ''}</span>
                                <span className="w-1 h-1 rounded-full bg-[#ff5a78] animate-pulse" />
                            </div>
                            <div className="text-[12px] text-white/90 font-semibold truncate">{tMeta.emoji ? `${tMeta.emoji} ` : ''}{tMeta.activity || '某个时段'}</div>
                        </div>
                        <span className="text-[9px] text-white/35">{timeStr}</span>
                    </div>
                    {/* 正文：逐拍回放（时间戳 + 氛围图标方块 + 文本） */}
                    <div className="relative px-2.5 py-2.5 max-h-52 overflow-y-auto no-scrollbar space-y-1.5">
                        {lines.length > 0 ? lines.map((l: any, i: number) => (
                            <div key={i} className="flex items-stretch gap-1.5">
                                <span className="flex-shrink-0 w-[42px] pt-1 text-right text-[8px] font-mono leading-tight whitespace-nowrap text-white/28 select-none">{beatClock(i)}</span>
                                <span
                                    className="flex-shrink-0 self-start mt-0.5 w-5 h-5 rounded-md flex items-center justify-center text-[11px]"
                                    style={{ background: `hsl(${HUE},42%,30%)`, border: `1px solid hsla(${HUE},60%,58%,0.45)` }}
                                >
                                    {l?.emotion || '·'}
                                </span>
                                <p
                                    className={`flex-1 min-w-0 text-[12.5px] leading-[1.55] whitespace-pre-wrap break-words ${/[「」“”"]/.test(l?.text || '') ? 'text-white font-medium' : 'text-white/90'}`}
                                >{l?.text || ''}</p>
                            </div>
                        )) : (
                            <p className="text-[11px] text-white/40 italic">（这段窥视没有内容）</p>
                        )}
                    </div>
                    {/* 页脚 */}
                    <div className="relative px-3 py-1.5 border-t flex items-center justify-between" style={{ borderColor: `hsla(${HUE},55%,55%,0.2)` }}>
                        <span className="text-[9px] italic text-white/40">你偷看了 TA 的这一刻</span>
                        <span className="text-[9px] font-bold tracking-wide" style={{ color: exposed ? accent : 'rgba(255,255,255,0.4)' }}>
                            {exposed ? 'TA 已察觉' : 'TA 不知情'}
                        </span>
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'room_card') {
        // 小屋「生活动态」轻量卡片：情绪评估顺风车偶尔捎带的一句小变化（utils/roomAmbient.ts）。
        // content 进上下文，角色自然记得自己干过啥——不额外建 feed，卡片即记录。
        const md: any = m.metadata || {};
        const timeStr = new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        const card = (
            <div className="w-56">
                <div
                    className="relative rounded-2xl overflow-hidden border border-amber-200/70 shadow-[0_4px_14px_rgba(200,160,90,0.18)]"
                    style={{ background: 'linear-gradient(160deg,#fffcf5 0%,#fdf6e8 60%,#faf0dc 100%)' }}
                >
                    <div className="relative px-3 pt-2 pb-1.5 flex items-center gap-2 border-b border-amber-200/50">
                        <span className="text-sm leading-none">{md.emoji || '🏠'}</span>
                        <span className="flex-1 text-[9px] tracking-[0.25em] text-amber-500/90 font-bold uppercase">小屋 · 生活动态</span>
                        <span className="text-[9px] text-amber-400/70">{timeStr}</span>
                    </div>
                    <div className="relative px-3 py-2">
                        <p className="text-[12px] leading-[1.6] text-[#6b5636]">
                            <span className="font-bold text-amber-600">{charName || 'Ta'}</span>
                            {md.text || String(m.content || '').replace(/^\[小屋动态\]\s*/, '')}
                        </p>
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'world_card') {
        const md: any = m.metadata || {};
        const timeStr = new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        const narrative: string = md.narrative || '';
        const panel: Record<string, any> = (md.statusPanel && typeof md.statusPanel === 'object') ? md.statusPanel : {};
        const posts: string[] = Array.isArray(md.phonePosts) ? md.phonePosts : [];
        const card = (
            <div className="w-64">
                <div
                    className="relative rounded-2xl overflow-hidden border border-violet-200/70 shadow-[0_6px_20px_rgba(150,130,200,0.22)]"
                    style={{ background: 'linear-gradient(160deg,#fbf7ff 0%,#f1ebfa 55%,#eae3f6 100%)' }}
                >
                    {/* 顶部淡紫光晕 + 月亮 + 星点（浅色系，和彼方的深色拉开差异） */}
                    <div className="absolute -top-6 -right-4 w-24 h-24 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle,rgba(214,196,244,.55),transparent 70%)' }} />
                    <div className="absolute top-2.5 right-3.5 w-5 h-5 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle at 38% 35%,#ffffff,#d9cdf0 72%)', boxShadow: '0 0 10px 2px rgba(200,180,245,.5)' }} />
                    <div className="absolute inset-0 pointer-events-none opacity-60" style={{ backgroundImage: 'radial-gradient(1px 1px at 20% 22%,#c9b8ec,transparent),radial-gradient(1px 1px at 60% 16%,#e7c9f0,transparent),radial-gradient(1px 1px at 40% 34%,#bcd0f0,transparent)' }} />
                    {/* 头部：家园 · 世界名 · 剧情时间 */}
                    <div className="relative px-3 pt-2.5 pb-2 flex items-center gap-2 border-b border-violet-200/50">
                        <span className="text-base leading-none text-violet-400" style={{ filter: 'drop-shadow(0 1px 3px rgba(180,150,230,.5))' }}>⌂</span>
                        <div className="flex-1 min-w-0">
                            <div className="text-[9px] tracking-[0.25em] text-violet-400/90 font-bold uppercase">家园 · {md.storyTime || '生活记录'}</div>
                            <div className="text-[12px] text-[#5b4b7a] font-semibold truncate font-serif">{md.worldName || '共同世界'}</div>
                        </div>
                        <span className="text-[9px] text-violet-400/60">{timeStr}</span>
                    </div>
                    {/* 行为描述 */}
                    <div className="relative px-3 py-2.5">
                        <p className="text-[11px] text-[#6a5790] mb-1">
                            <span className="font-bold text-rose-400">{charName || 'Ta'}</span>
                            {md.location ? ` 在${md.location}` : ''}{md.mood ? ` · ${md.mood}` : ''}
                        </p>
                        {narrative && (
                            <p className="text-[12px] leading-[1.6] text-[#4a3f63] whitespace-pre-wrap max-h-44 overflow-y-auto no-scrollbar">
                                {narrative}
                            </p>
                        )}
                        {/* 数值面板 */}
                        {Object.keys(panel).length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                                {Object.entries(panel).map(([k, v]) => (
                                    <span key={k} className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-100/80 text-violet-600 border border-violet-200/70">
                                        {k} {String(v)}
                                    </span>
                                ))}
                            </div>
                        )}
                        {/* 发的动态 */}
                        {posts.length > 0 && (
                            <div className="mt-2 space-y-1">
                                {posts.map((p, i) => (
                                    <div key={i} className="text-[11px] leading-snug text-violet-700/85 pl-2 border-l-2 border-rose-300/70">
                                        {p}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    {/* 页脚 */}
                    <div className="relative px-3 py-1.5 border-t border-violet-200/50 flex items-center justify-between">
                        <span className="text-[9px] text-violet-400/70 italic">Ta 在那个世界的生活</span>
                        <span className="text-[9px] text-rose-400/80 font-bold tracking-wide">＋记忆</span>
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'trpg_card') {
        const t: any = m.metadata?.trpg || {};
        const gameTitle: string = t.gameTitle || 'TRPG 跑团';
        const partyNames: string[] = Array.isArray(t.partyNames) ? t.partyNames.filter((n: string) => n && n !== charName) : [];
        const excerpt: Array<{ speaker?: string; text?: string; role?: string }> = Array.isArray(t.excerpt) ? t.excerpt : [];
        const card = (
            <div className="w-72">
                <div
                    className="rounded-2xl overflow-hidden border border-purple-300/30 shadow-[0_6px_20px_rgba(70,40,110,0.28)]"
                    style={{ background: 'linear-gradient(155deg,#2c1c44 0%,#1a1230 100%)' }}
                >
                    {/* 头部 */}
                    <div className="px-3.5 pt-3 pb-2.5 flex items-center gap-2.5 border-b border-white/10">
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'linear-gradient(135deg,#a855f7,#ec4899)' }}>
                            <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4 text-white"><path d="M12 2 4 6v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6l-8-4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-[9px] tracking-[0.25em] text-purple-300/80 font-bold uppercase">TRPG · 一起玩的游戏</div>
                            <div className="text-[13px] text-purple-50 font-semibold truncate font-serif">{gameTitle}</div>
                        </div>
                    </div>
                    {/* 剧情节选 */}
                    <div className="px-3.5 py-3 space-y-2 max-h-60 overflow-hidden">
                        {excerpt.length === 0 && <p className="text-[12px] text-purple-200/70 italic">一段冒险剧情</p>}
                        {excerpt.slice(0, 6).map((e, i) => {
                            const isGM = e.role === 'gm';
                            const text = (e.text || '').replace(/^\*|\*$/g, '').trim();
                            return (
                                <div key={i} className={`text-[12px] leading-relaxed ${isGM ? 'text-purple-100/90 italic' : 'text-purple-50/95'}`}>
                                    {!isGM && e.speaker && <span className="text-pink-300/90 font-semibold mr-1">{e.speaker}:</span>}
                                    <span className={isGM ? 'border-l-2 border-purple-400/40 pl-2 block' : ''}>{text}</span>
                                </div>
                            );
                        })}
                        {excerpt.length > 6 && <div className="text-[10px] text-purple-300/60 text-center pt-0.5">…共 {excerpt.length} 条剧情</div>}
                    </div>
                    {/* 页脚 */}
                    <div className="px-3.5 py-2 border-t border-white/10 flex items-center justify-between">
                        <span className="text-[9px] text-purple-300/70 italic truncate">{partyNames.length ? `与 ${partyNames.join('、')} 同行` : '我们的冒险'}</span>
                        <span className="text-[9px] text-pink-200/80 font-bold tracking-wide shrink-0 ml-2">＋共同回忆</span>
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'novel_card') {
        const n: any = m.metadata?.novel || {};
        const bookTitle: string = n.bookTitle || '无题';
        const isCoauthor = Array.isArray(n.collaboratorNames) && n.collaboratorNames.includes(charName);
        const coauthors: string[] = Array.isArray(n.collaboratorNames) ? n.collaboratorNames.filter((name: string) => name && name !== charName) : [];
        const chapters: Array<{ index?: number; summary?: string }> = Array.isArray(n.chapters) ? n.chapters : [];
        const card = (
            <div className="w-72">
                <div
                    className="rounded-2xl overflow-hidden border border-amber-300/40 shadow-[0_6px_20px_rgba(120,80,20,0.22)]"
                    style={{ background: 'linear-gradient(155deg,#fdf6e3 0%,#f5e9cf 100%)' }}
                >
                    {/* 头部 */}
                    <div className="px-3.5 pt-3 pb-2.5 flex items-center gap-2.5 border-b border-amber-900/10">
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'linear-gradient(135deg,#d97706,#b45309)' }}>
                            <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4 text-white"><path d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-[9px] tracking-[0.25em] text-amber-700/70 font-bold uppercase">笔友会 · {isCoauthor ? '一起写的书' : '分享的书'}</div>
                            <div className="text-[13px] text-amber-950 font-semibold truncate font-serif">《{bookTitle}》{n.subtitle ? <span className="text-amber-800/60 text-[11px] ml-1">{n.subtitle}</span> : null}</div>
                        </div>
                    </div>
                    {/* 章节归档节选 */}
                    <div className="px-3.5 py-3 space-y-2.5 max-h-60 overflow-hidden">
                        {chapters.length === 0 && <p className="text-[12px] text-amber-800/60 italic font-serif">一段手稿</p>}
                        {chapters.slice(0, 3).map((c, i) => (
                            <div key={i} className="text-[12px] leading-relaxed text-amber-950/85">
                                <span className="text-amber-700 font-semibold font-serif mr-1">第{c.index ?? '?'}章</span>
                                <span className="border-l-2 border-amber-600/25 pl-2 block mt-0.5 line-clamp-3 font-serif">{(c.summary || '').trim()}</span>
                            </div>
                        ))}
                        {chapters.length > 3 && <div className="text-[10px] text-amber-700/50 text-center pt-0.5">…共 {chapters.length} 章归档</div>}
                    </div>
                    {/* 页脚 */}
                    <div className="px-3.5 py-2 border-t border-amber-900/10 flex items-center justify-between">
                        <span className="text-[9px] text-amber-700/60 italic truncate">{isCoauthor ? (coauthors.length ? `与 ${coauthors.join('、')} 合著` : '我们合写的手稿') : '递到你手里的手稿'}</span>
                        <span className="text-[9px] text-amber-700/90 font-bold tracking-wide shrink-0 ml-2">＋共同回忆</span>
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
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
        // 渲染逻辑抽到共享组件 components/chat/HtmlCard.tsx（群聊共用），行为不变
        return commonLayout(<HtmlCard html={html} />);
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
        return <TransferCard m={m} isUser={isUser} charName={charName} commonLayout={commonLayout} selectionMode={selectionMode} onResolveTransfer={onResolveTransfer} />;
    }

    if (m.type === 'life_card') {
        return <LifeRecordCard m={m} charName={charName} commonLayout={commonLayout} selectionMode={selectionMode} onResolveLifeRecord={onResolveLifeRecord} />;
    }

    // 表情气泡默认尺寸 160→96（吸收社区美化的共识尺寸）。sully-emoji-msg 是给自定义 CSS 用的
    // 稳定锚点——旧美化代码锚在 .max-w-\[160px\] 类名上，类名一变就失配（恰好无缝退休：
    // 新默认就是它们想要的 96px）；以后想改尺寸请选择器写 .sully-emoji-msg，不再锚类名。
    if (m.type === 'emoji') {
        return commonLayout(
            m.content ? (
                <img src={m.content} className="sully-emoji-msg max-w-[var(--sully-emoji-size,96px)] max-h-[var(--sully-emoji-size,96px)] w-auto h-auto object-contain hover:scale-105 transition-transform drop-shadow-md active:scale-95" loading="lazy" decoding="async" />
            ) : (
                <div className="px-3 py-2 rounded-2xl bg-slate-100 text-slate-400 text-xs italic">[表情已丢失]</div>
            )
        );
    }

    if (m.type === 'image') {
        return commonLayout(
            <div className="relative group">
                {m.content ? (
                    <img src={m.content} className="max-w-[200px] max-h-[300px] rounded-2xl" alt="Uploaded" loading="lazy" decoding="async" />
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
    const stripJunk = (s: string) => stripFishCuesForDisplay(s
        .replace(/%%TRANS%%[\s\S]*/gi, '')           // legacy translation marker
        .replace(/%%BILINGUAL%%/gi, '\n')            // raw bilingual marker → newline
        // stray bilingual XML tags — 容错版：全角括号/斜杠、标签内空格、简繁、少写 `>` 的截断形态
        // (如 `</译文`) 都吃掉。掉格式消息已经按破标签落过库，显示端不容错就会原样漏给用户。
        .replace(/[<＜]\s*[/／]?\s*(?:翻[译譯]|原文|[译譯]文)\s*[>＞]?/g, '')
        .replace(/\s*\[(?:聊天|通话|约会)\]\s*/g, '\n')   // source tags leaked from history context
        .replace(/\[\[(?:QU[OA]TE|引用)[：:][\s\S]*?\]\]/g, '')  // residual double-bracket quotes (incl. typos & Chinese)
        .replace(/\[(?:QU[OA]TE|引用)[：:][^\]]*\]/g, '')     // residual single-bracket quotes (incl. typos & Chinese)
        .replace(/\[[^\[\]\n「」]{0,24}引用了[^\[\]\n「」]{0,24}「[^」\n]*?」[^\[\]\n]{0,24}\]\s*/g, '')  // imitated history render [xx引用了xx说的「…」，并回复了 ↓]
        .replace(/\[回复\s*[""\u201C][^""\u201D]*?[""\u201D](?:\.{0,3})\]\s*[：:]?\s*/g, '')  // [回复 "content"]: format
        // Residual action/system tags that may have leaked through
        .replace(/\[\[(?:ACTION|RECALL|SEARCH|DIARY|READ_DIARY|FS_DIARY|FS_READ_DIARY|SEND_EMOJI|DIARY_START|DIARY_END|FS_DIARY_START|FS_DIARY_END)[:\s][\s\S]*?\]\]/g, '')
        .replace(/\[schedule_message[^\]]*\]/g, '')
        .replace(/<[语語]音[^>]*>[\s\S]*?<\/\s*[语語]音\s*>/g, '')  // strip <语音 ...>...</语音> voice tags (tolerate emotion attr / spaced close)
        .replace(/<[语語]音[^>]*>[\s\S]*$/g, '')             // 未闭合开标签 (历史坏数据): 标签到末尾都是语音内容, 不当正文显示
        .replace(/<\/\s*[语語]音\s*>/g, '')                  // 孤儿闭合标签 (历史坏数据): 剥标签留正文
        .replace(/<字幕>([\s\S]*?)<\/字幕>/g, '$1')          // <字幕>: 剥标签留中文 (字幕就是气泡里该显示的文字)
        .replace(/<\/?字幕>/g, '')                           // 落单字幕标签兜底
        .replace(/^\s*---\s*$/gm, '')                // standalone --- lines
        .replace(/``+/g, '')                          // empty/stray backtick pairs
        .replace(/(^|\s)`(\s|$)/gm, '$1$2')         // lone backticks at boundaries
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')    // markdown links → just text
        // TTS-only markup (<#秒#> 停顿、(sighs) 动作词) must never show in the bubble
        .replace(/<#\s*[\d.]+\s*#>/g, '')
        .replace(/\(([^)]{1,40})\)/g, (m, inner: string) =>
            VALID_INTERJECTION_TAGS.has(inner.trim().toLowerCase()) ? '' : m)
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([，。！？、；：,.!?…])/g, '$1')
        .replace(/\n{3,}/g, '\n\n')                  // collapse excess newlines
        .trim());   // ⚠️ 末尾再洗一遍鱼声情绪 cue（[excited]/[pause]/(laughs) 等），避免漏到气泡/翻译里

    const rawContent = m.content;

    // 语音文字（转文字面板 / 语音条预览）显示前：先洗 MiniMax 标记，再洗鱼声情绪 cue，
    // 两家服务商的演出标记都不会漏给用户看。
    const cleanVoiceText = (t?: string | null) => stripFishCuesForDisplay(cleanVoiceMarkupForDisplay(t ?? ''));

    // 引用快照原样存着 %%BILINGUAL%% 等原始标记（双语消息），预览前先清洗
    const replyPreview = m.replyTo ? stripJunk(m.replyTo.content) : '';

    // Parse %%BILINGUAL%% for bilingual display (langA = "选" language, langB = "译" language)
    const bilingualIdx = rawContent.toLowerCase().indexOf('%%bilingual%%');
    const hasBilingual = bilingualIdx !== -1;
    const langAContent = hasBilingual ? stripJunk(rawContent.substring(0, bilingualIdx)) : stripJunk(rawContent);
    const langBContent = hasBilingual ? stripJunk(rawContent.substring(bilingualIdx + '%%BILINGUAL%%'.length)) : '';

    // Display: "选" language by default, "译" language when toggled
    const displayContent = (isShowingTarget && langBContent) ? langBContent : langAContent;
    const showTranslateButton = translationEnabled && hasBilingual && langBContent;

    // Check if raw content has a <语音> tag (voice-only message that hasn't been TTS'd yet).
    // 未闭合的开标签也算 (历史坏数据: 语音块曾被 chunkText 切碎, 开标签落单) —
    // 当语音条渲染 + 转文字兜底, 而不是把原始标签漏给用户看。
    const hasVoiceTag = !isUser && /<[语語]音[^>]*>/.test(m.content);
    // Spoken text inside the <语音> tag — lets the placeholder bar offer a 转文字 toggle
    // even when no audio was synthesized (e.g. character has no MiniMax voice configured),
    // so fake voice messages stay readable just like real ones.
    // 配对优先; 配不上 (未闭合) 就取开标签之后的全部内容。
    const voiceTagText = hasVoiceTag ? cleanVoiceText((
        m.content.match(/<[语語]音[^>]*>([\s\S]*?)<\/\s*[语語]音\s*>/)?.[1]
        ?? m.content.match(/<[语語]音[^>]*>([\s\S]*)$/)?.[1]
        ?? ''
    ).replace(/<字幕>[\s\S]*?<\/字幕>/g, '').trim()) : '';
    const hasVoiceContent = voiceData?.url || voiceLoading || hasVoiceTag;
    // Don't render empty bubbles (e.g. messages that were just "---"), unless voice data exists or pending
    if (!displayContent && !hasVoiceContent) return null;

    // Voice-only messages (no display text, only voice bar): skip bubble styling
    const isVoiceOnlyMsg = !displayContent && hasVoiceContent && !isUser && m.type === 'text';

    // 外语语音消息：语音条展开区（转文字）本身就完整呈现「口播原文 + 中文翻译」两行，
    // 顶部气泡再渲染一遍 displayContent 就成了重复——翻译模式下顶部是中文、语音条翻译行
    // 也是中文，用户看到两份一样的翻译。这类消息把双语文字统一收进语音条，
    // 顶部不再重复渲染正文，也不再显示（此时已无意义的）译/原文切换按钮。
    const isForeignVoiceMsg = !isUser && m.type === 'text' && !!voiceData?.url && !!voiceData?.lang && !!cleanVoiceText(voiceData?.spokenText);

    return commonLayout(
        <div className={isVoiceOnlyMsg
            ? `relative ${suppressEntranceAnimation ? '' : 'animate-fade-in'}`
            : `relative ${bubbleVariant === 'flat' || bubbleVariant === 'outline' || bubbleVariant === 'wechat' ? '' : 'shadow-sm '}px-5 py-3 ${suppressEntranceAnimation ? '' : 'animate-fade-in'} ${bubbleVariant === 'outline' ? '' : 'border border-black/5 '}active:scale-[0.98] transition-transform overflow-visible ${isUser ? 'sully-bubble-user' : 'sully-bubble-ai'}`}
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
                    <span className="truncate italic">"{replyPreview.length > 10 ? replyPreview.slice(0, 10) + '...' : replyPreview}"</span>
                </div>
            )}

            {/* Layer 4: Text Content — shown when there's visible text after stripping voice tags */}
            {/* 外语语音消息把双语文字交给下方语音条渲染，顶部不再重复正文 */}
            {displayContent && !isForeignVoiceMsg && (
            <div className="relative z-10 text-[15px] leading-relaxed whitespace-pre-wrap break-all select-text" style={{ color: styleConfig.textColor }}>
                {renderContent(displayContent)}
            </div>
            )}

            {/* Layer 5: 双语「翻译/原文」切换 —— 气泡内右下角，细分隔线压层级，小灰字克制易找 */}
            {showTranslateButton && displayContent && !isForeignVoiceMsg && (
                <div
                    className="relative z-10 mt-2 pt-1.5 flex justify-end"
                    style={{ borderTop: '1px solid rgba(127, 127, 127, 0.16)' }}
                >
                    <button
                        onClick={(e) => { e.stopPropagation(); e.preventDefault(); onTranslateToggle?.(m.id); }}
                        className="flex items-center gap-1 text-[10px] font-medium transition-opacity active:opacity-80 select-none"
                        style={{ color: styleConfig.textColor, opacity: 0.45 }}
                    >
                        {isShowingTarget ? (
                            <>
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path fillRule="evenodd" d="M7.793 2.232a.75.75 0 0 1-.025 1.06L3.622 7.25h10.003a5.375 5.375 0 0 1 0 10.75H10.75a.75.75 0 0 1 0-1.5h2.875a3.875 3.875 0 0 0 0-7.75H3.622l4.146 3.957a.75.75 0 0 1-1.036 1.085l-5.5-5.25a.75.75 0 0 1 0-1.085l5.5-5.25a.75.75 0 0 1 1.06.025Z" clipRule="evenodd" /></svg>
                                <span>原文</span>
                            </>
                        ) : (
                            <>
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M7.75 2.75a.75.75 0 0 0-1.5 0v1.258a32.987 32.987 0 0 0-3.599.278.75.75 0 1 0 .198 1.487A31.545 31.545 0 0 1 8.7 5.545 19.381 19.381 0 0 1 7.257 9.04a19.391 19.391 0 0 1-1.727-2.29.75.75 0 1 0-1.29.77 20.9 20.9 0 0 0 2.023 2.684 19.549 19.549 0 0 1-3.158 2.57.75.75 0 1 0 .86 1.229A21.056 21.056 0 0 0 7.5 11.03c1.1.95 2.3 1.79 3.593 2.49a.75.75 0 1 0 .69-1.331A19.545 19.545 0 0 1 8.46 9.89a20.893 20.893 0 0 0 1.91-4.644h2.38a.75.75 0 0 0 0-1.5h-3v-1a.75.75 0 0 0-.75-.75Z" /><path d="M12.75 10a.75.75 0 0 1 .692.462l2.5 6a.75.75 0 1 1-1.384.576l-.532-1.278h-3.052l-.532 1.278a.75.75 0 1 1-1.384-.576l2.5-6A.75.75 0 0 1 12.75 10Zm-1.018 4.26h2.036L12.75 11.6l-1.018 2.66Z" /></svg>
                                <span>翻译</span>
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
                // Voice-only mode: no visible text, voice bar is primary content.
                // 外语语音消息顶部正文已隐藏（交给语音条渲染），同样按纯语音处理，去掉多余上间距。
                const isVoiceOnly = !!voiceData?.url && (!displayContent || isForeignVoiceMsg);
                return (
                <div className={`relative z-10 ${isVoiceOnly ? '' : 'mt-2.5'}`}>
                    {voiceData?.url ? (
                        <div className="max-w-[260px]">
                            <button
                                onClick={(e) => { e.stopPropagation(); e.preventDefault(); onPlayVoice?.(m.id); }}
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
                                                <div className="whitespace-pre-wrap">{cleanVoiceText(voiceData.spokenText)}</div>
                                                {(cleanVoiceText(voiceData.originalText) || displayContent) && (
                                                    <div
                                                        style={{ opacity: 0.65 }}
                                                        className="whitespace-pre-wrap text-[10px] mt-1 pt-1 border-t border-current/10"
                                                    >
                                                        {cleanVoiceText(voiceData.originalText) || displayContent}
                                                    </div>
                                                )}
                                            </>
                                        ) : (
                                            <>
                                                {/* Default: show original text */}
                                                {(cleanVoiceText(voiceData.originalText) || displayContent) && (
                                                    <div className="whitespace-pre-wrap">{cleanVoiceText(voiceData.originalText) || displayContent}</div>
                                                )}
                                                {cleanVoiceText(voiceData.spokenText) && (
                                                    <div
                                                        style={{ opacity: (cleanVoiceText(voiceData.originalText) || displayContent) ? 0.55 : 1 }}
                                                        className={`whitespace-pre-wrap ${(cleanVoiceText(voiceData.originalText) || displayContent) ? 'text-[10px] mt-1 pt-1 border-t border-current/10' : ''}`}
                                                    >
                                                        {cleanVoiceText(voiceData.spokenText)}
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
                        /* Voice tag exists in content but no audio yet — either TTS is still
                           pending (app restart / auto-TTS) or the character has no MiniMax voice
                           configured. Offer a 转文字 toggle here too so the text stays readable,
                           aligning fake voice messages with real ones. */
                        <div className="max-w-[260px]">
                            <div
                                className="flex items-center gap-2 px-3 py-2 rounded-2xl"
                                style={{ background: vbBg || 'linear-gradient(135deg, rgba(0,0,0,0.03) 0%, rgba(0,0,0,0.06) 100%)', border: '1px solid rgba(0,0,0,0.05)' }}
                            >
                                <button
                                    onClick={(e) => { e.stopPropagation(); e.preventDefault(); onPlayVoice?.(m.id); }}
                                    className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center active:scale-[0.92] transition-transform"
                                    style={{ backgroundColor: vbBg ? 'rgba(255,255,255,0.25)' : 'rgba(148,163,184,0.2)' }}
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill={vbBtn || '#64748b'} className="w-3 h-3 ml-0.5"><path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.841Z" /></svg>
                                </button>
                                <div className="flex-1 flex items-center gap-[3px] h-5 overflow-hidden">
                                    {[4, 10, 6, 14, 8, 12, 5, 11, 7, 13, 4, 9, 6, 11, 5, 8, 10, 7, 12, 6].map((h, i) => (
                                        <div key={i} className="w-[2.5px] rounded-full" style={{ height: `${Math.max(2, h * 0.4)}px`, backgroundColor: vbWave ? vbWave + '60' : `rgba(148, 163, 184, ${0.25 + (h / 14) * 0.35})` }} />
                                    ))}
                                </div>
                                {(voiceTagText || displayContent) ? (
                                    <div
                                        className={`shrink-0 ml-0.5 px-1.5 py-0.5 rounded-lg text-[9px] font-medium transition-all ${showVoiceText ? 'ring-1 ring-current/20' : ''}`}
                                        style={{
                                            color: vbText || 'rgba(100,116,139,0.7)',
                                            backgroundColor: showVoiceText ? 'rgba(0,0,0,0.08)' : 'rgba(0,0,0,0.04)',
                                        }}
                                        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setShowVoiceText(v => !v); }}
                                    >
                                        {showVoiceText ? '收起' : '转文字'}
                                    </div>
                                ) : (
                                    <span className="text-[9px] shrink-0" style={{ color: vbText || 'rgba(100,116,139,0.7)' }}>语音</span>
                                )}
                            </div>
                            {showVoiceText && (voiceTagText || displayContent) && (
                                <div className="mt-1.5 px-3 py-2 rounded-xl text-[11px] leading-relaxed whitespace-pre-wrap"
                                    style={{
                                        backgroundColor: vbBg || 'rgba(0,0,0,0.02)',
                                        color: vbText || '#475569',
                                        border: '1px solid rgba(0,0,0,0.04)',
                                    }}
                                >
                                    {voiceTagText || displayContent}
                                </div>
                            )}
                        </div>
                    ) : null}
                </div>
                );
            })()}
        </div>
    );
}, (prev, next) => {
    return prev.msg.id === next.msg.id &&
           prev.msg.content === next.msg.content &&
           // 可交互卡片的状态活在 metadata 里（生活记录卡确认/否决、转账卡收退款）。
           // 这里不深比整个 metadata（可能含大对象），只盯这几个会改变渲染的状态位——
           // 否则用户点了「确认」，DB 已更新、消息已重载，卡片却因 memo 判等而纹丝不动。
           prev.msg.metadata?.reviewStatus === next.msg.metadata?.reviewStatus &&
           prev.msg.metadata?.status === next.msg.metadata?.status &&
           prev.msg.metadata?.receipt === next.msg.metadata?.receipt &&
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
           prev.moduleAlign === next.moduleAlign &&
           prev.suppressEntranceAnimation === next.suppressEntranceAnimation &&
           prev.voiceData?.url === next.voiceData?.url &&
           prev.voiceLoading === next.voiceLoading &&
           prev.isVoicePlaying === next.isVoicePlaying;
});

export default MessageItem;
