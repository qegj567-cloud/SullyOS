import React, { useRef, useState } from 'react';
import { AppID, OSTheme, ChatFineTuneFields } from '../../types';
import WhiteboxSoundEditor from '../chat/WhiteboxSoundEditor';
import { WhiteboxSound } from '../../utils/whiteboxSound';
import ChatFineTunePanel from '../chat/ChatFineTunePanel';
import { FadersHorizontal } from '@phosphor-icons/react';

type Props = {
    theme: OSTheme;
    updateTheme: (updates: Partial<OSTheme>) => void;
    /** 「进阶装扮」区块的跳转（如一键去气泡工坊）。 */
    onOpenApp?: (appId: AppID) => void;
};

// 聊天细节微调的默认值快照。切预设时先铺这层再叠预设配置：否则从「沉浸剧场」切回
// 其他预设时，隐藏头像/贴边等残留字段不会被清掉（旧预设没写这些键）——不留残留的既有惯例。
const FINE_TUNE_DEFAULTS: Required<ChatFineTuneFields> = {
    chatAvatarVisibility: 'both',
    chatAvatarPlacement: 'beside',
    chatAvatarAlign: 'bottom',
    chatAvatarOffsetY: 0,
    chatBubbleFontSize: 0,
    chatBubbleLineHeight: 0,
    chatBubbleIndent: 0,
    chatSnapToEdge: false,
    chatModuleAlign: 'center',
};

const presets: Array<{ name: string; desc: string; config: Partial<OSTheme> }> = [
    {
        name: '默认聊天',
        desc: '柔和通用的聊天壳',
        config: {
            chatChromeStyle: 'soft',
            chatBackgroundStyle: 'plain',
            chatHeaderStyle: 'default',
            chatHeaderAlign: 'left',
            chatHeaderDensity: 'default',
            chatStatusStyle: 'subtle',
            chatAvatarShape: 'circle',
            chatAvatarSize: 'medium',
            chatAvatarMode: 'grouped',
            chatBubbleStyle: 'modern',
            chatMessageSpacing: 'default',
            chatInputStyle: 'rounded',
            chatSendButtonStyle: 'circle',
            chatShowTimestamp: 'always',
        },
    },
    {
        name: 'WeChat',
        desc: '平整克制的熟悉感',
        config: {
            chatChromeStyle: 'flat',
            chatBackgroundStyle: 'paper',
            chatHeaderStyle: 'wechat',
            chatHeaderAlign: 'left',
            chatHeaderDensity: 'compact',
            chatStatusStyle: 'dot',
            chatAvatarShape: 'square',
            chatAvatarSize: 'medium',
            chatAvatarMode: 'grouped',
            chatBubbleStyle: 'wechat',
            chatMessageSpacing: 'default',
            chatInputStyle: 'wechat',
            chatSendButtonStyle: 'pill',
            chatShowTimestamp: 'always',
        },
    },
    {
        name: 'Telegram',
        desc: '轻盈通透的玻璃感',
        config: {
            chatChromeStyle: 'floating',
            chatBackgroundStyle: 'mesh',
            chatHeaderStyle: 'telegram',
            chatHeaderAlign: 'center',
            chatHeaderDensity: 'default',
            chatStatusStyle: 'pill',
            chatAvatarShape: 'circle',
            chatAvatarSize: 'medium',
            chatAvatarMode: 'grouped',
            chatBubbleStyle: 'flat',
            chatMessageSpacing: 'spacious',
            chatInputStyle: 'telegram',
            chatSendButtonStyle: 'circle',
            chatShowTimestamp: 'always',
        },
    },
    {
        name: 'Discord',
        desc: '频道感更强的界面',
        config: {
            chatChromeStyle: 'floating',
            chatBackgroundStyle: 'grid',
            chatHeaderStyle: 'discord',
            chatHeaderAlign: 'left',
            chatHeaderDensity: 'default',
            chatStatusStyle: 'pill',
            chatAvatarShape: 'rounded',
            chatAvatarSize: 'medium',
            chatAvatarMode: 'grouped',
            chatBubbleStyle: 'shadow',
            chatMessageSpacing: 'compact',
            chatInputStyle: 'discord',
            chatSendButtonStyle: 'minimal',
            chatShowTimestamp: 'always',
        },
    },
    {
        name: 'iMessage',
        desc: '更圆润、更轻的气质',
        config: {
            chatChromeStyle: 'soft',
            chatBackgroundStyle: 'mesh',
            chatHeaderStyle: 'minimal',
            chatHeaderAlign: 'center',
            chatHeaderDensity: 'airy',
            chatStatusStyle: 'subtle',
            chatAvatarShape: 'circle',
            chatAvatarSize: 'large',
            chatAvatarMode: 'grouped',
            chatBubbleStyle: 'ios',
            chatMessageSpacing: 'spacious',
            chatInputStyle: 'ios',
            chatSendButtonStyle: 'circle',
            chatShowTimestamp: 'always',
        },
    },
    {
        name: '沉浸剧场',
        desc: '无头像+贴边+松行距',
        config: {
            chatChromeStyle: 'flat',
            chatBackgroundStyle: 'plain',
            chatHeaderStyle: 'minimal',
            chatHeaderAlign: 'center',
            chatHeaderDensity: 'compact',
            chatStatusStyle: 'subtle',
            chatAvatarShape: 'circle',
            chatAvatarSize: 'medium',
            chatAvatarMode: 'grouped',
            chatBubbleStyle: 'flat',
            chatMessageSpacing: 'spacious',
            chatInputStyle: 'flat',
            chatSendButtonStyle: 'minimal',
            chatShowTimestamp: 'never',
            chatAvatarVisibility: 'hide_both',
            chatSnapToEdge: true,
            chatBubbleLineHeight: 1.5,
        },
    },
    {
        name: '紧凑密聊',
        desc: '小字紧排+顶对齐头像',
        config: {
            chatChromeStyle: 'flat',
            chatBackgroundStyle: 'plain',
            chatHeaderStyle: 'default',
            chatHeaderAlign: 'left',
            chatHeaderDensity: 'compact',
            chatStatusStyle: 'dot',
            chatAvatarShape: 'rounded',
            chatAvatarSize: 'small',
            chatAvatarMode: 'grouped',
            chatBubbleStyle: 'flat',
            chatMessageSpacing: 'compact',
            chatInputStyle: 'flat',
            chatSendButtonStyle: 'minimal',
            chatShowTimestamp: 'never',
            chatAvatarVisibility: 'both',
            chatAvatarAlign: 'top',
            chatBubbleFontSize: 13,
            chatBubbleLineHeight: 1.35,
        },
    },
    {
        name: '像素终端',
        desc: '伪窗口风格的聊天壳',
        config: {
            chatChromeStyle: 'pixel',
            chatBackgroundStyle: 'grid',
            chatHeaderStyle: 'pixel',
            chatHeaderAlign: 'left',
            chatHeaderDensity: 'compact',
            chatStatusStyle: 'pill',
            chatAvatarShape: 'square',
            chatAvatarSize: 'small',
            chatAvatarMode: 'grouped',
            chatBubbleStyle: 'outline',
            chatMessageSpacing: 'compact',
            chatInputStyle: 'pixel',
            chatSendButtonStyle: 'pill',
            chatShowTimestamp: 'always',
        },
    },
];

const defaults = {
    chatAvatarShape: 'circle',
    chatAvatarSize: 'medium',
    chatAvatarMode: 'grouped',
    chatAvatarPlacement: 'beside',
    chatBubbleStyle: 'modern',
    chatMessageSpacing: 'default',
    chatShowTimestamp: 'always',
    chatHeaderStyle: 'default',
    chatInputStyle: 'default',
    chatChromeStyle: 'soft',
    chatBackgroundStyle: 'plain',
    chatHeaderAlign: 'left',
    chatHeaderDensity: 'default',
    chatStatusStyle: 'subtle',
    chatSendButtonStyle: 'circle',
} as const;

const groupClass = 'rounded-3xl border border-slate-100 bg-white p-5 shadow-sm';


const choices = {
    chrome: [
        { value: 'soft', label: '柔雾', desc: '轻薄玻璃感' },
        { value: 'flat', label: '平面', desc: '更干净利落' },
        { value: 'floating', label: '悬浮', desc: '层次更明显' },
        { value: 'pixel', label: '像素', desc: '硬边伪窗口' },
    ],
    background: [
        { value: 'plain', label: '纯净' },
        { value: 'grid', label: '网格' },
        { value: 'paper', label: '纸面' },
        { value: 'mesh', label: '氛围' },
    ],
    header: [
        { value: 'default', label: '默认' },
        { value: 'minimal', label: '极简' },
        { value: 'gradient', label: '渐变' },
        { value: 'wechat', label: '微信感' },
        { value: 'telegram', label: 'Telegram' },
        { value: 'discord', label: 'Discord' },
        { value: 'pixel', label: '像素窗' },
    ],
    bubble: [
        { value: 'modern', label: '现代' },
        { value: 'flat', label: '扁平' },
        { value: 'outline', label: '描边' },
        { value: 'shadow', label: '立体' },
        { value: 'wechat', label: '微信感' },
        { value: 'ios', label: 'iOS' },
    ],
    input: [
        { value: 'default', label: '默认' },
        { value: 'rounded', label: '圆润' },
        { value: 'flat', label: '扁平' },
        { value: 'wechat', label: '微信感' },
        { value: 'ios', label: 'iOS' },
        { value: 'telegram', label: 'Telegram' },
        { value: 'discord', label: 'Discord' },
        { value: 'pixel', label: '像素窗' },
    ],
    align: [
        { value: 'left', label: '左对齐' },
        { value: 'center', label: '居中' },
    ],
    density: [
        { value: 'compact', label: '紧凑' },
        { value: 'default', label: '默认' },
        { value: 'airy', label: '舒展' },
    ],
    status: [
        { value: 'subtle', label: '弱提示' },
        { value: 'pill', label: '状态胶囊' },
        { value: 'dot', label: '圆点在线' },
    ],
    send: [
        { value: 'circle', label: '圆按钮' },
        { value: 'pill', label: '胶囊按钮' },
        { value: 'minimal', label: '极简图标' },
    ],
    avatarShape: [
        { value: 'circle', label: '圆形' },
        { value: 'rounded', label: '圆角' },
        { value: 'square', label: '方形' },
    ],
    avatarSize: [
        { value: 'small', label: '小' },
        { value: 'medium', label: '中' },
        { value: 'large', label: '大' },
    ],
    avatarMode: [
        { value: 'grouped', label: '连续共用', desc: '一串消息只露一次头像' },
        { value: 'every_message', label: '每条都显示', desc: '每条消息都带头像' },
    ],
    spacing: [
        { value: 'compact', label: '紧凑' },
        { value: 'default', label: '默认' },
        { value: 'spacious', label: '宽松' },
    ],
    timestamp: [
        { value: 'always', label: '始终显示' },
        { value: 'hover', label: '悬停（电脑）' },
        { value: 'never', label: '不显示' },
    ],
    emojiSize: [
        { value: 'small', label: '小', desc: '96px' },
        { value: 'medium', label: '中', desc: '128px' },
        { value: 'large', label: '大', desc: '160px · 旧版' },
    ],
} as const;

const cardButton = (active: boolean) =>
    `rounded-2xl border px-3 py-2 text-left transition-all active:scale-[0.98] ${
        active ? 'border-primary/40 bg-primary/10 text-primary shadow-sm' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
    }`;

const avatarClass = (shape: string, size: string) => {
    const sizeClass = size === 'small' ? 'h-7 w-7' : size === 'large' ? 'h-12 w-12' : 'h-9 w-9';
    const radiusClass = shape === 'square' ? 'rounded-sm' : shape === 'rounded' ? 'rounded-xl' : 'rounded-full';
    return `${sizeClass} ${radiusClass}`;
};

const shellClass = (style: string) => {
    if (style === 'flat') return 'border border-slate-200 shadow-none';
    if (style === 'floating') return 'border border-white/70 shadow-[0_22px_60px_rgba(148,163,184,0.28)]';
    if (style === 'pixel') return 'border-[3px] border-[#7b5a40] shadow-[6px_6px_0_rgba(123,90,64,0.24)]';
    return 'border border-white/70 shadow-[0_15px_40px_rgba(148,163,184,0.18)]';
};

const backgroundStyleForPreview = (style: string, chrome: string): React.CSSProperties => {
    const base = chrome === 'pixel' ? '#efe1cf' : '#f8fafc';
    if (style === 'grid') {
        return {
            backgroundColor: base,
            backgroundImage:
                'linear-gradient(rgba(148,163,184,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.14) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
        };
    }
    if (style === 'paper') {
        return {
            backgroundColor: chrome === 'pixel' ? '#f4e8d9' : '#f9f7f2',
            backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(148,163,184,0.12) 1px, transparent 0)',
            backgroundSize: '16px 16px',
        };
    }
    if (style === 'mesh') {
        return {
            backgroundColor: '#f8fafc',
            backgroundImage:
                'radial-gradient(circle at 15% 20%, rgba(59,130,246,0.18), transparent 28%), radial-gradient(circle at 85% 15%, rgba(244,114,182,0.18), transparent 24%), radial-gradient(circle at 60% 75%, rgba(45,212,191,0.18), transparent 26%)',
        };
    }
    return { backgroundColor: base };
};

const previewBubbleStyle = (bubble: string, isUser: boolean, theme: OSTheme): React.CSSProperties => {
    const hue = theme.hue ?? 216;
    const saturation = theme.saturation ?? 88;
    const lightness = theme.lightness ?? 57;
    const primary = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
    const base: React.CSSProperties = {
        background: isUser ? primary : '#ffffff',
        color: isUser ? '#ffffff' : '#334155',
        borderRadius: bubble === 'ios' ? 24 : bubble === 'wechat' ? 18 : 20,
        padding: '10px 14px',
        maxWidth: '72%',
    };
    if (bubble === 'outline') return { ...base, background: 'transparent', color: isUser ? primary : '#475569', border: `2px solid ${isUser ? primary : '#cbd5e1'}` };
    if (bubble === 'shadow') return { ...base, boxShadow: '0 10px 20px rgba(15,23,42,0.12)' };
    if (bubble === 'flat') return { ...base, boxShadow: 'none' };
    if (bubble === 'wechat') return { ...base, background: isUser ? '#95ec69' : '#ffffff', color: '#0f172a', boxShadow: 'none', border: '1px solid rgba(15,23,42,0.05)' };
    if (bubble === 'ios') return { ...base, background: isUser ? primary : 'rgba(255,255,255,0.86)', boxShadow: '0 8px 16px rgba(148,163,184,0.12)', border: '1px solid rgba(255,255,255,0.75)', backdropFilter: 'blur(12px)' };
    return { ...base, boxShadow: '0 6px 14px rgba(148,163,184,0.12)', border: '1px solid rgba(148,163,184,0.12)' };
};

const ChoiceGroup: React.FC<{
    title: string;
    items: ReadonlyArray<{ value: string; label: string; desc?: string }>;
    value: string;
    onPick: (value: string) => void;
}> = ({ title, items, value, onPick }) => (
    <div>
        <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">{title}</div>
        <div className="flex flex-wrap gap-2">
            {items.map((item) => (
                <button key={item.value} onClick={() => onPick(item.value)} className={cardButton(value === item.value)}>
                    <div className="text-[11px] font-bold">{item.label}</div>
                    {item.desc && <div className="mt-0.5 text-[9px] opacity-70">{item.desc}</div>}
                </button>
            ))}
        </div>
    </div>
);

export const ChatAppearanceEditor: React.FC<Props> = ({ theme, updateTheme, onOpenApp }) => {
    const avatarShape = theme.chatAvatarShape || defaults.chatAvatarShape;
    const avatarSize = theme.chatAvatarSize || defaults.chatAvatarSize;
    const avatarMode = theme.chatAvatarMode || defaults.chatAvatarMode;
    const avatarPlacement = theme.chatAvatarPlacement || defaults.chatAvatarPlacement;
    const bubbleStyle = theme.chatBubbleStyle || defaults.chatBubbleStyle;
    const messageSpacing = theme.chatMessageSpacing || defaults.chatMessageSpacing;
    const showTimestamp = theme.chatShowTimestamp || defaults.chatShowTimestamp;
    const headerStyle = theme.chatHeaderStyle || defaults.chatHeaderStyle;
    const inputStyle = theme.chatInputStyle || defaults.chatInputStyle;
    const chromeStyle = theme.chatChromeStyle || defaults.chatChromeStyle;
    const backgroundStyle = theme.chatBackgroundStyle || defaults.chatBackgroundStyle;
    const headerAlign = theme.chatHeaderAlign || defaults.chatHeaderAlign;
    const headerDensity = theme.chatHeaderDensity || defaults.chatHeaderDensity;
    const statusStyle = theme.chatStatusStyle || defaults.chatStatusStyle;
    const sendButtonStyle = theme.chatSendButtonStyle || defaults.chatSendButtonStyle;
    const pendingIndicator = theme.chatPendingIndicator !== false;
    const showHeaderBuffs = theme.chatHideHeaderBuffs !== true;
    const [showStyleHelp, setShowStyleHelp] = useState(false);

    // 聊天壳设置面板悬浮化——同私聊「聊天装扮」的形态：面板浮在预览上方而不占文档流，
    // 预览不用瘦身也能和设置同屏；点圆气泡收起面板即可看全预览。
    const [panelOpen, setPanelOpen] = useState(true);
    // 圆气泡可自由拖动（按住拖走，松手留在原地）；null = 默认位置（右缘、35vh 高度处）。
    const [bubblePos, setBubblePos] = useState<{ x: number; y: number } | null>(null);
    const bubbleDrag = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
    const BUBBLE_SIZE = 48;
    const clampBubble = (x: number, y: number) => ({
        x: Math.max(8, Math.min(window.innerWidth - BUBBLE_SIZE - 8, x)),
        y: Math.max(56, Math.min(window.innerHeight - BUBBLE_SIZE - 24, y)),
    });
    const onBubblePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        bubbleDrag.current = { startX: e.clientX, startY: e.clientY, originX: rect.left, originY: rect.top, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onBubblePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
        const drag = bubbleDrag.current;
        if (!drag) return;
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        // 6px 内算点按不算拖动，避免手指微颤把点击吞掉
        if (!drag.moved && Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
        setBubblePos(clampBubble(drag.originX + dx, drag.originY + dy));
    };
    const onBubblePointerUp = () => {
        const drag = bubbleDrag.current;
        bubbleDrag.current = null;
        if (drag && !drag.moved) setPanelOpen(v => !v);
    };

    // 悬浮面板内左右翻页：一页一个主题，改哪项都能立刻在后面的预览里看到。
    const PAGE_TITLES = ['快速预设', '聊天壳', '头部', '气泡与头像', '细节微调', '表情包与输入栏'];
    const [page, setPage] = useState(0);
    const swipeStartX = useRef<number | null>(null);
    const goPage = (next: number) => setPage(Math.max(0, Math.min(PAGE_TITLES.length - 1, next)));

    // 聊天细节微调 → 预览联动（近似演示：字号按比例缩小 3px 以配合迷你预览）
    const fineVis = theme.chatAvatarVisibility || 'both';
    const hidePreviewAiAvatar = fineVis === 'hide_ai' || fineVis === 'hide_both';
    const hidePreviewUserAvatar = fineVis === 'hide_user' || fineVis === 'hide_both';
    const previewRowAlign = (theme.chatAvatarAlign || 'bottom') === 'top' ? 'items-start' : theme.chatAvatarAlign === 'center' ? 'items-center' : 'items-end';
    const previewFineTextStyle: React.CSSProperties = {
        ...(theme.chatBubbleFontSize ? { fontSize: `${Math.max(9, theme.chatBubbleFontSize - 3)}px` } : {}),
        ...(theme.chatBubbleLineHeight ? { lineHeight: theme.chatBubbleLineHeight } : {}),
    };

    const headerClass =
        headerStyle === 'minimal'
            ? 'bg-white/90 border-b border-slate-100'
            : headerStyle === 'gradient'
              ? 'bg-gradient-to-r from-primary/20 via-primary/10 to-white border-b border-slate-100'
              : headerStyle === 'wechat'
                ? 'bg-[#f7f7f7] border-b border-black/5'
                : headerStyle === 'telegram'
                  ? 'bg-white/80 backdrop-blur-xl border-b border-sky-100'
                  : headerStyle === 'discord'
                    ? 'bg-slate-900 border-b border-white/10'
                    : headerStyle === 'pixel'
                      ? 'bg-[#c99872] border-b-[3px] border-[#7b5a40]'
                      : 'bg-white/80 border-b border-slate-100';

    const headerTextClass = headerStyle === 'discord' ? 'text-white' : headerStyle === 'pixel' ? 'text-[#fff7ed]' : 'text-slate-700';
    const previewGap = messageSpacing === 'compact' ? 'gap-1.5' : messageSpacing === 'spacious' ? 'gap-4' : 'gap-2.5';
    const previewPad = headerDensity === 'compact' ? 'px-4 py-3' : headerDensity === 'airy' ? 'px-5 py-[18px]' : 'px-4 py-3.5';
    const previewMessages = [
        { id: 'ai-1', role: 'assistant', kind: 'text', text: '今天这套聊天壳已经比之前像样多了。' },
        { id: 'ai-2', role: 'assistant', kind: 'voice', text: '00:08' },
        { id: 'user-1', role: 'user', kind: 'text', text: '对，我想把头像频率也做成可以 DIY 的。' },
        { id: 'user-2', role: 'user', kind: 'text', text: '这样不同软件的味道会更明显。' },
    ] as const;

    return (
        <div className="space-y-5">
            {/* 实时预览：聊天壳设置在悬浮面板里（下方圆气泡），预览保持原尺寸、始终可见。 */}
            <section className="rounded-3xl border border-slate-100 bg-white p-3 shadow-sm">
                <div className="mb-2 flex items-baseline justify-between px-1">
                    <h2 className="text-[11px] font-bold uppercase tracking-widest text-slate-400">实时预览</h2>
                    <span className="text-[9px] text-slate-300">全局设置 · 改动立即反映</span>
                </div>
                <div className={`sully-chat-root overflow-hidden rounded-[28px] ${shellClass(chromeStyle)}`} style={backgroundStyleForPreview(backgroundStyle, chromeStyle)}>
                    {/* 实时套用「白框自定义」CSS：预览各零件挂了同样的 .sully-chat-* 钩子，故能即时反映。
                        注意：预览外壳 overflow-hidden 会裁掉溢出效果（如波浪下沿），真聊天里完整可见。 */}
                    {theme.chatChromeCustomCss && <style>{theme.chatChromeCustomCss}</style>}
                    <div className={`sully-chat-header relative ${headerClass} ${previewPad}`}>
                        <div className={`flex items-center gap-3 ${headerAlign === 'center' ? 'justify-center text-center' : 'justify-between text-left'}`}>
                            <div className={`flex items-center gap-3 ${headerAlign === 'center' ? 'justify-center' : ''}`}>
                                <div
                                    className={`sully-chat-avatar ${avatarClass(avatarShape, avatarSize)} shrink-0`}
                                    style={{
                                        background: headerStyle === 'discord' ? 'linear-gradient(135deg, rgba(99,102,241,0.9), rgba(34,197,94,0.9))' : 'linear-gradient(135deg, rgba(59,130,246,0.18), rgba(244,114,182,0.18))',
                                        border: headerStyle === 'pixel' ? '2px solid #8f674a' : '1px solid rgba(255,255,255,0.5)',
                                    }}
                                />
                                <div className={`sully-chat-status ${headerAlign === 'center' ? 'flex flex-col items-center' : ''}`}>
                                    <div className={`sully-chat-name text-xs font-bold ${headerTextClass}`}>聊天对象</div>
                                    {statusStyle === 'pill' && <div className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${headerStyle === 'discord' ? 'bg-emerald-500/20 text-emerald-200' : headerStyle === 'pixel' ? 'bg-[#fff7ed] text-[#8f674a]' : 'bg-emerald-50 text-emerald-500'}`}>online</div>}
                                    {statusStyle === 'dot' && <div className={`flex items-center gap-1 text-[9px] ${headerStyle === 'discord' ? 'text-slate-300' : headerStyle === 'pixel' ? 'text-[#f3ddc7]' : 'text-slate-400'}`}><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />online</div>}
                                    {statusStyle === 'subtle' && <div className={`text-[9px] uppercase ${headerStyle === 'discord' ? 'text-slate-400' : headerStyle === 'pixel' ? 'text-[#f3ddc7]' : 'text-slate-400'}`}>online</div>}
                                </div>
                            </div>
                            {headerAlign !== 'center' && <div className={`sully-chat-token text-[9px] font-mono ${headerStyle === 'discord' ? 'text-slate-400' : headerStyle === 'pixel' ? 'text-[#f3ddc7]' : 'text-slate-400'}`}>42 tok</div>}
                        </div>
                        {/* 情绪 buff 栏：挂真聊天同款 .sully-chat-buffs 钩子（子元素必须是 button），
                            「显示情绪栏」开关和白框 CSS 的 .sully-chat-buffs button 美化都能即时预览。 */}
                        {showHeaderBuffs && (
                            <div className={`sully-chat-buffs mt-1.5 flex items-center gap-0.5 ${headerAlign === 'center' ? 'justify-center' : ''}`}>
                                {['😌 平静', '☕ 想喝咖啡'].map((buff) => (
                                    <button
                                        key={buff}
                                        type="button"
                                        tabIndex={-1}
                                        className={`pointer-events-none shrink-0 truncate rounded-[10px] border px-1 py-[3px] text-[8px] font-bold leading-none ${
                                            headerStyle === 'discord'
                                                ? 'border-white/15 bg-white/10 text-slate-200'
                                                : headerStyle === 'pixel'
                                                  ? 'border-[#8f674a] bg-[#fff7ed] text-[#8f674a]'
                                                  : 'border-amber-200 bg-amber-50 text-amber-600'
                                        }`}
                                    >
                                        {buff}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                    <div className={`flex min-h-[150px] flex-col p-3 ${previewGap}`}>
                        {previewMessages.map((message, index) => {
                            const isUser = message.role === 'user';
                            const previousRole = index > 0 ? previewMessages[index - 1].role : null;
                            const nextRole = index < previewMessages.length - 1 ? previewMessages[index + 1].role : null;
                            const isFirstInGroup = previousRole !== message.role;
                            const shouldShowAvatar = avatarMode === 'every_message' || nextRole !== message.role;
                            const avatarTone = isUser ? 'bg-primary/25' : 'bg-pink-200';
                            const avatarHidden = isUser ? hidePreviewUserAvatar : hidePreviewAiAvatar;
                            const bubbleNode = message.kind === 'voice' ? (
                                <div className={`sully-voice-bar flex min-w-[190px] items-center gap-2 rounded-2xl border px-3 py-2 ${headerStyle === 'discord' ? 'border-white/10 bg-white/10' : chromeStyle === 'pixel' ? 'border-2 border-[#8f674a] bg-[#fff7ed]' : 'border-black/5 bg-slate-100/90'}`}>
                                    <span className={`sully-voice-bar-button flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[9px] ${chromeStyle === 'pixel' ? 'bg-[#c99872] text-[#fff7ed]' : 'bg-primary/15 text-primary'}`}>▶</span>
                                    <span className="sully-voice-bar-wave flex h-5 flex-1 items-center gap-[3px] overflow-hidden">
                                        {[4, 10, 6, 14, 8, 12, 5, 11, 7, 13].map((height, waveIndex) => (
                                            <i key={waveIndex} className={`sully-voice-bar-wave-segment block w-[2.5px] rounded-full ${headerStyle === 'discord' ? 'bg-white/55' : chromeStyle === 'pixel' ? 'bg-[#8f674a]/70' : 'bg-primary/45'}`} style={{ height: Math.max(2, height * 0.42) }} />
                                        ))}
                                    </span>
                                    <span className={`sully-voice-bar-toggle rounded-lg px-1.5 py-0.5 text-[8px] font-medium ${headerStyle === 'discord' ? 'bg-white/10 text-white/65' : chromeStyle === 'pixel' ? 'bg-[#eadfce] text-[#8f674a]' : 'bg-black/5 text-slate-500'}`}>转文字</span>
                                </div>
                            ) : (
                                <div style={{ ...previewBubbleStyle(bubbleStyle, isUser, theme), ...previewFineTextStyle }}>
                                    {message.text}
                                    {showTimestamp === 'always' && nextRole !== message.role && (
                                        <div className={`mt-1 text-right text-[8px] ${isUser ? 'opacity-70' : 'opacity-55'}`}>{isUser ? '14:33' : '14:32'}</div>
                                    )}
                                </div>
                            );
                            if (avatarPlacement === 'above_group') {
                                return (
                                    <div key={message.id} className={`flex flex-col gap-2 ${isUser ? 'items-end' : 'items-start'}`}>
                                        {isFirstInGroup && !avatarHidden && <div className={`${avatarClass(avatarShape, avatarSize)} shrink-0 ${avatarTone}`} />}
                                        {bubbleNode}
                                    </div>
                                );
                            }
                            return (
                                <div key={message.id} className={`flex ${previewRowAlign} gap-2 ${isUser ? 'justify-end' : ''}`}>
                                    {!isUser && !hidePreviewAiAvatar && <div className={`${avatarClass(avatarShape, avatarSize)} shrink-0 ${avatarTone} ${shouldShowAvatar ? '' : 'opacity-0'}`} />}
                                    {bubbleNode}
                                    {isUser && !hidePreviewUserAvatar && <div className={`${avatarClass(avatarShape, avatarSize)} shrink-0 ${avatarTone} ${shouldShowAvatar ? '' : 'opacity-0'}`} />}
                                </div>
                            );
                        })}
                    </div>
                    <div className={`sully-chat-inputbar border-t px-3 py-3 ${chromeStyle === 'pixel' ? 'border-[#8f674a] bg-[#eadfce]' : headerStyle === 'discord' ? 'border-white/10 bg-slate-900/90' : 'border-slate-100 bg-white/80'}`}>
                        <div className="flex items-end gap-2">
                            <button className={`flex h-10 w-10 shrink-0 items-center justify-center ${chromeStyle === 'pixel' ? 'rounded-[4px] border-2 border-[#8f674a] bg-[#f8f0e0] text-[#8f674a]' : headerStyle === 'discord' ? 'rounded-full bg-slate-800 text-slate-200' : 'rounded-full bg-slate-100 text-slate-500'}`}>+</button>
                            <div className={`flex min-h-10 flex-1 items-center px-4 text-[11px] ${inputStyle === 'flat' ? 'rounded-none border-b border-slate-200 bg-transparent' : inputStyle === 'wechat' ? 'rounded-full border border-slate-200 bg-white' : inputStyle === 'ios' ? 'rounded-[26px] border border-white/80 bg-white/80 shadow-inner' : inputStyle === 'telegram' ? 'rounded-2xl border border-sky-100 bg-white' : inputStyle === 'discord' ? 'rounded-2xl border border-white/10 bg-slate-800 text-white' : inputStyle === 'pixel' ? 'rounded-[4px] border-2 border-[#8f674a] bg-[#f8f0e0]' : inputStyle === 'rounded' ? 'rounded-full bg-slate-100' : 'rounded-[22px] bg-slate-100'}`}>
                                输入消息...
                            </div>
                            <button className={`shrink-0 ${sendButtonStyle === 'pill' ? (chromeStyle === 'pixel' ? 'h-10 min-w-[68px] rounded-[4px] border-2 border-[#8f674a] bg-[#c99872] px-4 text-[11px] font-bold text-[#fff7ed]' : 'h-10 min-w-[68px] rounded-full bg-primary px-4 text-[11px] font-bold text-white') : sendButtonStyle === 'minimal' ? (chromeStyle === 'pixel' ? 'flex h-10 w-10 items-center justify-center rounded-[4px] border-2 border-[#8f674a] bg-[#c99872] text-[#fff7ed]' : 'flex h-10 w-10 items-center justify-center rounded-full bg-transparent text-primary') : (chromeStyle === 'pixel' ? 'flex h-10 w-10 items-center justify-center rounded-[4px] border-2 border-[#8f674a] bg-[#c99872] text-[#fff7ed]' : 'flex h-10 w-10 items-center justify-center rounded-full bg-primary text-white shadow-lg')}`}>
                                {sendButtonStyle === 'pill' ? '发送' : '➤'}
                            </button>
                        </div>
                    </div>
                </div>
            </section>

            {/* 聊天壳设置：同私聊「聊天装扮」的悬浮形态——面板 fixed 贴底、无遮罩，不占文档流，
                预览保持完整尺寸也能边看边调。圆气泡点按 = 收起/展开面板，按住可拖到不挡手的位置。 */}
            <div className="rounded-2xl border border-dashed border-slate-200 bg-white/70 px-4 py-2.5 text-[10px] leading-relaxed text-slate-400">
                聊天壳设置在悬浮小面板里 · 点右侧圆钮收起/展开，按住圆钮可拖到不挡预览的位置
            </div>

            <button
                type="button"
                onPointerDown={onBubblePointerDown}
                onPointerMove={onBubblePointerMove}
                onPointerUp={onBubblePointerUp}
                onPointerCancel={() => { bubbleDrag.current = null; }}
                className={`fixed z-[106] flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-colors active:scale-90 ${panelOpen ? 'bg-primary text-white ring-4 ring-primary/20' : 'bg-white/95 text-primary ring-1 ring-primary/30 backdrop-blur'}`}
                style={bubblePos
                    ? { left: bubblePos.x, top: bubblePos.y, touchAction: 'none' }
                    : { right: 12, top: 'calc(var(--safe-top, 0px) + 35vh)', touchAction: 'none' }}
                aria-label={panelOpen ? '收起聊天壳设置面板' : '展开聊天壳设置面板'}
            >
                <FadersHorizontal className="h-6 w-6" weight="bold" />
            </button>

            {panelOpen && (
            <section
                className="fixed left-1/2 z-[105] w-[94%] max-w-md -translate-x-1/2 overflow-y-auto rounded-3xl border border-white/60 bg-white/95 p-4 shadow-[0_12px_40px_rgba(15,23,42,0.22)] backdrop-blur-xl [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                style={{ bottom: 'calc(16px + var(--safe-bottom, 0px))', maxHeight: '46vh' }}
            >
                <div className="mb-4 flex items-center gap-1.5">
                    <button
                        onClick={() => goPage(page - 1)}
                        disabled={page === 0}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-base text-slate-500 transition-all active:scale-90 disabled:opacity-30"
                        aria-label="上一页"
                    >‹</button>
                    <div className="flex flex-1 gap-1.5 overflow-x-auto no-scrollbar">
                        {PAGE_TITLES.map((title, i) => (
                            <button
                                key={title}
                                onClick={() => setPage(i)}
                                className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold transition-all active:scale-95 ${i === page ? 'bg-primary text-white shadow-sm' : 'bg-slate-100 text-slate-500'}`}
                            >{title}</button>
                        ))}
                    </div>
                    <button
                        onClick={() => goPage(page + 1)}
                        disabled={page === PAGE_TITLES.length - 1}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-base text-slate-500 transition-all active:scale-90 disabled:opacity-30"
                        aria-label="下一页"
                    >›</button>
                </div>
                <div
                    onTouchStart={(e) => {
                        // 滑杆等横向控件里起手的触摸不算翻页手势（否则拖「垂直微调」滑杆会误翻页）
                        swipeStartX.current = (e.target as HTMLElement).closest('input') ? null : (e.touches[0]?.clientX ?? null);
                    }}
                    onTouchEnd={(e) => {
                        const startX = swipeStartX.current;
                        swipeStartX.current = null;
                        const endX = e.changedTouches[0]?.clientX;
                        if (startX == null || endX == null) return;
                        const dx = endX - startX;
                        if (Math.abs(dx) > 48) goPage(page + (dx < 0 ? 1 : -1));
                    }}
                >
                {page === 0 && (<>
                    <p className="mb-3 text-[10px] text-slate-400">一键换整套聊天壳（含头像、气泡、间距与细节微调），切预设会先清掉微调残留。</p>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {presets.map((preset) => (
                            <button
                                key={preset.name}
                                onClick={() => updateTheme({ ...FINE_TUNE_DEFAULTS, ...preset.config })}
                                className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-left transition-all hover:border-primary/30 hover:bg-white active:scale-[0.98]"
                            >
                                <div className="text-xs font-bold text-slate-700">{preset.name}</div>
                                <div className="mt-1 text-[10px] text-slate-400">{preset.desc}</div>
                            </button>
                        ))}
                    </div>
                </>)}

                {page === 1 && (<>
                    <ChoiceGroup title="聊天壳" items={choices.chrome} value={chromeStyle} onPick={(value) => updateTheme({ chatChromeStyle: value as OSTheme['chatChromeStyle'] })} />
                    <div className="mt-4">
                        <ChoiceGroup title="消息区背景" items={choices.background} value={backgroundStyle} onPick={(value) => updateTheme({ chatBackgroundStyle: value as OSTheme['chatBackgroundStyle'] })} />
                    </div>
                </>)}

                {page === 2 && (<>
                <ChoiceGroup title="头部风格" items={choices.header} value={headerStyle} onPick={(value) => updateTheme({ chatHeaderStyle: value as OSTheme['chatHeaderStyle'] })} />
                <div className="mt-4">
                    <ChoiceGroup title="头部对齐" items={choices.align} value={headerAlign} onPick={(value) => updateTheme({ chatHeaderAlign: value as OSTheme['chatHeaderAlign'] })} />
                </div>
                <div className="mt-4">
                    <ChoiceGroup title="头部密度" items={choices.density} value={headerDensity} onPick={(value) => updateTheme({ chatHeaderDensity: value as OSTheme['chatHeaderDensity'] })} />
                </div>
                <div className="mt-4">
                    <ChoiceGroup title="在线状态样式" items={choices.status} value={statusStyle} onPick={(value) => updateTheme({ chatStatusStyle: value as OSTheme['chatStatusStyle'] })} />
                </div>
                <div className="mt-4 flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2.5">
                    <div className="min-w-0 pr-3">
                        <div className="text-[11px] font-bold text-slate-700">显示情绪栏</div>
                        <div className="mt-0.5 text-[10px] text-slate-400">角色名下方的情绪 buff 胶囊；关掉后顶栏更干净（位置/样式也可在「白框自定义」里用 .sully-chat-buffs 调）。</div>
                    </div>
                    <button
                        onClick={() => updateTheme({ chatHideHeaderBuffs: showHeaderBuffs })}
                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${showHeaderBuffs ? 'bg-primary' : 'bg-slate-300'}`}
                        aria-pressed={showHeaderBuffs}
                    >
                        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${showHeaderBuffs ? 'left-[22px]' : 'left-0.5'}`} />
                    </button>
                </div>
                </>)}

                {page === 3 && (<>
                <ChoiceGroup title="消息气泡" items={choices.bubble} value={bubbleStyle} onPick={(value) => updateTheme({ chatBubbleStyle: value as OSTheme['chatBubbleStyle'] })} />
                <div className="mt-4">
                    <ChoiceGroup title="头像形状" items={choices.avatarShape} value={avatarShape} onPick={(value) => updateTheme({ chatAvatarShape: value as OSTheme['chatAvatarShape'] })} />
                </div>
                <div className="mt-4">
                    <ChoiceGroup title="头像尺寸" items={choices.avatarSize} value={avatarSize} onPick={(value) => updateTheme({ chatAvatarSize: value as OSTheme['chatAvatarSize'] })} />
                </div>
                <div className="mt-4">
                    <ChoiceGroup title="头像出现频率" items={choices.avatarMode} value={avatarMode} onPick={(value) => updateTheme({ chatAvatarMode: value as OSTheme['chatAvatarMode'] })} />
                </div>
                <div className="mt-4">
                    <ChoiceGroup title="消息密度" items={choices.spacing} value={messageSpacing} onPick={(value) => updateTheme({ chatMessageSpacing: value as OSTheme['chatMessageSpacing'] })} />
                </div>
                <div className="mt-4">
                    <ChoiceGroup title="时间戳" items={choices.timestamp} value={showTimestamp} onPick={(value) => updateTheme({ chatShowTimestamp: value as OSTheme['chatShowTimestamp'] })} />
                </div>
                <div className="mt-4 flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2.5">
                    <div className="min-w-0 pr-3">
                        <div className="text-[11px] font-bold text-slate-700">发送准备中圆点</div>
                        <div className="mt-0.5 text-[10px] text-slate-400">Instant Push 期间，自己的气泡左侧显示三个跳动的小圆点。</div>
                    </div>
                    <button
                        onClick={() => updateTheme({ chatPendingIndicator: !pendingIndicator })}
                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${pendingIndicator ? 'bg-primary' : 'bg-slate-300'}`}
                        aria-pressed={pendingIndicator}
                    >
                        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${pendingIndicator ? 'left-[22px]' : 'left-0.5'}`} />
                    </button>
                </div>
                </>)}

                {/* 聊天细节微调 —— 收编社区白框美化的可视化版（控件组件与聊天内「聊天装扮」弹窗共用） */}
                {page === 4 && (<>
                    <p className="mb-3 text-[10px] leading-relaxed text-slate-400">
                        头像显隐/对齐、贴边、字号行距——不用再手写 CSS，改动实时反映在上方预览里。
                        手写过美化代码的老用户不受影响：<b>你的自定义 CSS 优先级更高</b>，永远盖得过这里。
                    </p>
                    <ChatFineTunePanel value={theme} onChange={(patch) => updateTheme(patch)} />
                    <button
                        onClick={() => updateTheme({ ...FINE_TUNE_DEFAULTS })}
                        className="mt-4 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] font-bold text-slate-500 transition-all hover:bg-slate-100 active:scale-[0.99]">
                        微调全部回默认（一键清残留）
                    </button>
                    <p className="mt-2 text-[10px] text-slate-400">
                        这里设置的是全局打底。想给某个角色单独一套？进 ta 的聊天 → 「＋」菜单 → 「聊天装扮」。
                    </p>
                </>)}

                {page === 5 && (<>
                    <ChoiceGroup title="表情包大小" items={choices.emojiSize} value={theme.chatEmojiSize || 'small'} onPick={(value) => updateTheme({ chatEmojiSize: value as OSTheme['chatEmojiSize'] })} />
                    <p className="mt-2 text-[10px] text-slate-400">聊天和群聊里发出的表情包图片尺寸。用自定义 CSS 调过尺寸的美化会继续覆盖这里的设置。（表情包尺寸预览里看不到，进聊天发一张试试。）</p>
                    <div className="mt-4">
                        <ChoiceGroup title="输入栏风格" items={choices.input} value={inputStyle} onPick={(value) => updateTheme({ chatInputStyle: value as OSTheme['chatInputStyle'] })} />
                    </div>
                    <div className="mt-4">
                        <ChoiceGroup title="发送按钮" items={choices.send} value={sendButtonStyle} onPick={(value) => updateTheme({ chatSendButtonStyle: value as OSTheme['chatSendButtonStyle'] })} />
                    </div>
                </>)}
                </div>
            </section>
            )}

            <section className={groupClass}>
                <div className="mb-3">
                    <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">全局默认提示音</h2>
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                        某角色没单独设提示音时，收到 ta 的新消息就用这里的默认音。角色自己在「＋」菜单「提示音」里设的会盖过全局。
                    </p>
                </div>
                <WhiteboxSoundEditor
                    sound={(theme.chatSound as WhiteboxSound | undefined) || null}
                    showBind={false}
                    onChangeSound={(s) => updateTheme({ chatSound: s || undefined })}
                    hint={<>🔔 <b>全局默认</b>：某角色未单独设提示音时，收到 ta 新发的最后一条消息就响这个。角色自己设的会盖过它。</>}
                />
            </section>

            {/* 进阶装扮：把外观可视化设置 / 气泡工坊 / 白框 CSS 三个装扮入口串成一条有引导的路 */}
            <section className={groupClass}>
                <div className="mb-3 flex items-start justify-between gap-2">
                    <div>
                        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">进阶装扮 · 去哪儿改什么</h2>
                        <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                            这一页管「整体壳子」和细节微调；气泡长相、深度魔改各有专门的地方。不知道谁生效？点右边「?」。
                        </p>
                    </div>
                    <button
                        onClick={() => setShowStyleHelp(v => !v)}
                        className={`shrink-0 w-5 h-5 rounded-full text-[11px] font-bold leading-none flex items-center justify-center transition-colors ${showStyleHelp ? 'bg-primary text-white' : 'bg-slate-200 text-slate-500'}`}
                        aria-label="装扮优先级说明"
                    >
                        ?
                    </button>
                </div>
                {showStyleHelp && (
                    <div className="mb-3 rounded-2xl bg-amber-50/70 border border-amber-200/60 px-4 py-3 text-[11px] text-slate-600 leading-relaxed space-y-2">
                        <p className="font-bold text-amber-700">「我在三个地方都改了，到底谁生效？」</p>
                        <p>三个装扮入口各管一摊，平时互不打架：</p>
                        <p>
                            <span className="font-semibold">🎛️ 这一页（可视化设置）</span>：聊天壳、头像、间距、细节微调。改整体布局用它，不用写一行代码。
                        </p>
                        <p>
                            <span className="font-semibold">🎨 气泡工坊</span>：气泡本身的长相——颜色、圆角、贴图、装饰。做好的气泡按角色穿戴。
                        </p>
                        <p>
                            <span className="font-semibold">✍️ 白框自定义 CSS</span>：手写代码深度魔改（头部、输入栏、任何零件）。入口在每个角色聊天的「＋」→「白框」。
                        </p>
                        <p className="font-semibold">改了同一个东西撞车时，谁说了算：</p>
                        <p>
                            <span className="font-semibold text-amber-600">可视化设置 &lt; 气泡主题 &lt; 自定义 CSS</span>。
                            也就是：气泡工坊的主题能盖过这一页的设置；你手写的自定义 CSS 权力最大，两边都盖得过——
                            所以老用户手里的美化代码永远不会被这页的开关弄坏。
                        </p>
                        <p>
                            某个角色看起来「设置不生效」时，按这个顺序排查：先看 ta 有没有专属白框 CSS（聊天「＋」→「白框」），再看 ta 穿着哪套气泡（聊天顶栏会话面板 → 气泡样式），最后才是这一页。
                        </p>
                    </div>
                )}
                <div className="space-y-2">
                    <div className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2.5">
                        <div className="min-w-0 pr-3">
                            <div className="text-[11px] font-bold text-slate-700">想改气泡的颜色 / 贴图 / 装饰</div>
                            <div className="mt-0.5 text-[10px] text-slate-400">去气泡工坊捏一套，保存后可以直接给角色穿上。</div>
                        </div>
                        <button
                            onClick={() => onOpenApp?.(AppID.ThemeMaker)}
                            className="shrink-0 rounded-xl bg-primary/10 px-3 py-1.5 text-[11px] font-bold text-primary transition-all active:scale-95">
                            去气泡工坊 →
                        </button>
                    </div>
                    <div className="rounded-2xl bg-slate-50 px-3 py-2.5">
                        <div className="text-[11px] font-bold text-slate-700">想给某个角色单独一套微调</div>
                        <div className="mt-0.5 text-[10px] text-slate-400">进 ta 的聊天 → 「＋」菜单 → 「聊天装扮」，可以只覆盖字号、头像这些细节，其余跟随全局。</div>
                    </div>
                    <div className="rounded-2xl bg-slate-50 px-3 py-2.5">
                        <div className="text-[11px] font-bold text-slate-700">想手写 CSS 深度魔改</div>
                        <div className="mt-0.5 text-[10px] text-slate-400">进角色聊天 → 「＋」菜单 → 「白框」，那里能边写边预览、还能存预设分享。</div>
                    </div>
                </div>
            </section>

            <section className={groupClass}>
                <div className="mb-3">
                    <h2 className="text-sm font-bold uppercase tracking-widest text-slate-400">白框自定义 (CSS)</h2>
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                        聊天白框美化现在按「单个角色」管理：进该角色聊天 →「＋」菜单 →「白框」里设置、预览、存预设。
                        如果 CSS 写坏了导致界面异常，可以到系统设置顶部的「外观急救」还原聊天白框美化。
                    </p>
                </div>
            </section>

            <div className="px-2 pb-2 text-center text-[10px] leading-relaxed text-slate-400">
                这一版先把聊天外观做成模块化换壳。后面如果你想继续往深处玩，我们还可以拆成每个角色单独一套聊天壳，甚至让不同 app 模拟不同平台 UI。
            </div>
        </div>
    );
};
