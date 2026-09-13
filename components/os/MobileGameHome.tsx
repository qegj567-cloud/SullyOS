import React, { useEffect, useMemo, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { Icons, INSTALLED_APPS } from '../../constants';
import { AppID, CharacterProfile } from '../../types';
import { DB } from '../../utils/db';
import { isChatPreviewMessage } from '../../utils/chatMessageVisibility';
import AppIcon from './AppIcon';
import TokenImg from './TokenImg';
import { getMobileGameArt } from './mobilegameArt';
import { SCHEMES, hsl, schemePreview, type TgStyle } from './gotchiScheme';
import { getChibi } from '../../utils/vrWorld/chibi';
import { isDevDebugAvailable, subscribeDevDebugAvailability } from '../../utils/devDebug';

// ===== 手游主题（mobilegame skin）=====
// 风格：梦幻粉紫二次元手游首页（照搬参考图）。浅粉紫底 + 深紫文字 + 粉色强调，
// 圆润可爱字体、满屏星芒 ✦、时钟 Hero 卡内嵌天空渐变 + 角色立绘贴纸。
// 背景透出用户自设壁纸（默认铺梦幻粉紫渐变壁纸）。
// 等级 / 经验 / 货币为按角色 id 稳定派生的装饰数值。

// —— 调色板：全部指向 CSS 变量（根节点按方案生成；默认 = 经典梦幻粉紫）——
const PAL = {
    ink: 'var(--mg-ink)',     // 主文字
    grape: 'var(--mg-grape)', // 标题
    lilac: 'var(--mg-lilac)', // 次文字
    pink: 'var(--mg-pink)',   // 强调浅
    hot: 'var(--mg-hot)',     // 强调深（+ / NEW / 高光）
    peri: 'var(--mg-peri)',   // 邻色
    mist: 'var(--mg-mist)',   // 极浅底
    cloud: 'var(--mg-cloud)', // 近白底
};

// 方案 → 手游皮肤整套 CSS 变量。明暗两套：亮色=现在的梦幻粉彩（透壁纸），
// 暗色=深烟卡+亮字+夜空 Hero（有用户就好这口）。角色 S/L 定死只转色相。
const makeMgVars = (st: TgStyle): React.CSSProperties => {
    const { hue: h, dark, gold, mute } = st;
    const sat = (s: number) => (mute ? Math.min(s, 10) : s);
    const accH = gold ? 45 : h + 69;
    if (dark) {
        return {
            '--mg-ink': hsl(h, 28, 86),
            '--mg-grape': hsl(h, 42, 90),
            '--mg-lilac': hsl(h, 20, 66),
            '--mg-pink': hsl(accH, gold ? 50 : 62, 74),
            '--mg-hot': hsl(accH, gold ? 54 : 66, 64),
            '--mg-peri': hsl(h - 37, 38, 70),
            '--mg-mist': hsl(h, sat(22), 18),
            '--mg-cloud': hsl(h, sat(22), 23),
            '--mg-card': hsl(h, sat(24), 14, 0.72),
            '--mg-card-line': hsl(h, 40, 72, 0.3),
            '--mg-tile': hsl(h, sat(24), 17),
            '--mg-glow12': 'rgba(0,0,0,0.28)',
            '--mg-glow20': 'rgba(0,0,0,0.38)',
            '--mg-track': 'rgba(255,255,255,0.12)',
            '--mg-badge1': hsl(h, 35, 40),
            '--mg-badge2': hsl(h, 35, 30),
            '--mg-pill': hsl(h, sat(30), 12, 0.55),
            '--mg-sky': 'linear-gradient(180deg, #232045 0%, #3a3560 55%, #4a4379 100%)',
            '--mg-dock': hsl(h, sat(24), 15, 0.85),
            '--mg-dock-line': 'rgba(255,255,255,0.16)',
            '--mg-drawer': hsl(h, sat(24), 12, 0.94),
            '--mg-chip': 'rgba(255,255,255,0.12)',
            '--mg-chip-line': 'rgba(255,255,255,0.25)',
            '--mg-bg': `linear-gradient(180deg, ${hsl(h, sat(26), 13)} 0%, ${hsl(h, sat(24), 9)} 100%)`,
        } as React.CSSProperties;
    }
    return {
        '--mg-ink': hsl(h, sat(23), 47),
        '--mg-grape': hsl(h, sat(30), 56),
        '--mg-lilac': hsl(h, sat(40), 72),
        '--mg-pink': hsl(accH, 78, 81),
        '--mg-hot': hsl(accH, 73, 69),
        '--mg-peri': hsl(h - 37, sat(59), 78),
        '--mg-mist': hsl(h, sat(44), 95),
        '--mg-cloud': hsl(h, sat(56), 98),
        '--mg-card': 'rgba(255,255,255,0.62)',
        '--mg-card-line': hsl(h, 42, 76, 0.32),
        '--mg-tile': hsl(h, sat(60), 99),
        '--mg-glow12': hsl(h, 35, 55, 0.12),
        '--mg-glow20': hsl(h, 38, 58, 0.2),
        '--mg-track': hsl(h, 35, 60, 0.16),
        '--mg-badge1': hsl(h, sat(30), 56),
        '--mg-badge2': hsl(h, sat(23), 47),
        '--mg-pill': 'rgba(255,255,255,0.55)',
        '--mg-sky': 'linear-gradient(180deg, #cfe0f7 0%, #e4d9f3 42%, #f3d9ec 72%, #f7d2e2 100%)',
        '--mg-dock': 'rgba(255,255,255,0.7)',
        '--mg-dock-line': 'rgba(255,255,255,0.9)',
        '--mg-drawer': hsl(h, 40, 95, 0.92),
        '--mg-chip': 'rgba(255,255,255,0.7)',
        '--mg-chip-line': 'rgba(255,255,255,0.9)',
        '--mg-bg': 'transparent', // 亮色保持透出用户壁纸
    } as React.CSSProperties;
};

// 经典梦幻粉紫（本皮肤的出厂默认，亮色）+ 共享 12 方案
const MG_CLASSIC: TgStyle = { id: 'classic', name: '梦幻粉紫', hue: 262, dark: false, gold: false, mute: false };
const MG_CHOICES: TgStyle[] = [MG_CLASSIC, ...SCHEMES];
const MG_STYLE_KEY = 'mg_style_v1';

// 调色盘线描图标（无 emoji）
const MG_PALETTE_ICON = (
    <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3a9 9 0 1 0 0 18c1 0 1.6-.8 1.6-1.6 0-.5-.2-.8-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-3.9-4-7.4-9-7.4Z" /><circle cx="7.5" cy="11" r="1" fill="currentColor" stroke="none" /><circle cx="10.5" cy="7.5" r="1" fill="currentColor" stroke="none" /><circle cx="14.5" cy="7.5" r="1" fill="currentColor" stroke="none" /><circle cx="17" cy="11" r="1" fill="currentColor" stroke="none" /></svg>
);

// 扁平手绘卡（二次元风格）：浅色底 + 轻描边 + 很淡的平面投影，不要鼓凸
const CARD = {
    background: 'var(--mg-card)',
    border: '1.5px solid var(--mg-card-line)',
    boxShadow: '0 5px 14px var(--mg-glow12)',
    backdropFilter: 'blur(10px) saturate(1.05)',
    WebkitBackdropFilter: 'blur(10px) saturate(1.05)',
} as React.CSSProperties;

// 扁平手绘瓷砖（快捷入口图标底）：干净白底 + 轻描边 + 浅平面投影
const TILE = {
    background: 'var(--mg-tile)',
    border: '1.5px solid var(--mg-card-line)',
    boxShadow: '0 5px 12px var(--mg-glow12)',
} as React.CSSProperties;

const FONT_DISPLAY = `'DM Serif Display', serif`;     // 大时钟 / Lv / 日期数字
const FONT_CN = `'ZCOOL KuaiLe', 'Noto Sans SC', sans-serif`; // 中文圆润可爱
const FONT_SCRIPT = `'Caveat', cursive`;              // 问候手写

const QUICK_ENTRIES: { id: AppID; cn: string }[] = [
    { id: AppID.Character, cn: '神经链接' },
    { id: AppID.MemoryPalace, cn: '记忆宫殿' },
    { id: AppID.Call, cn: '电话' },
    { id: AppID.Room, cn: '小小窝' },
];

const GRID_CARDS: { id: AppID; cn: string; en: string }[] = [
    { id: AppID.CheckPhone, cn: '查手机', en: 'PHONE' },
    { id: AppID.Date, cn: '见面', en: 'CONTACTS' },
    { id: AppID.VRWorld, cn: '彼方', en: 'KANATA' },
    { id: AppID.Bank, cn: '存钱罐', en: 'PIGGYBANK' },
    { id: AppID.Schedule, cn: '日程', en: 'SCHEDULE' },
    { id: AppID.Settings, cn: '设置', en: 'SETTINGS' },
];

const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

const renderGlyph = (iconKey: string, className: string) => {
    const Comp = Icons[iconKey] || Icons.Settings;
    return <Comp className={className} />;
};

// 有手游插画就用插画（自带配色），否则回退到 Phosphor 线性图标
const renderAppArt = (id: AppID): React.ReactNode =>
    getMobileGameArt(id) || renderGlyph(INSTALLED_APPS.find(a => a.id === id)?.icon || 'Settings', 'w-full h-full');

// 星芒 ✦ 装饰：按 [x%, y%, 字号px, 颜色, 透明度] 散落
type Sp = [number, number, number, string, number];
const Sparkles: React.FC<{ items: Sp[] }> = ({ items }) => (
    <>
        {items.map(([x, y, s, c, o], i) => (
            <span key={i} className="absolute pointer-events-none select-none leading-none"
                style={{ left: `${x}%`, top: `${y}%`, fontSize: s, color: c, opacity: o, transform: 'translate(-50%,-50%)' }}>✦</span>
        ))}
    </>
);

// 四角星芒 SVG（冒号 / 罗盘用）
const StarBurst: React.FC<{ className?: string; fill?: string }> = ({ className, fill = '#fff' }) => (
    <svg viewBox="0 0 24 24" className={className}>
        <path d="M12 1 L13.8 10.2 L23 12 L13.8 13.8 L12 23 L10.2 13.8 L1 12 L10.2 10.2 Z" fill={fill} />
    </svg>
);

// 时钟卡里的城市 / 小房子剪影（含尖顶房子 + 塔尖 + 暖窗）
const CityScape: React.FC = () => (
    <svg viewBox="0 0 240 70" preserveAspectRatio="none" className="absolute bottom-0 left-0 w-full h-[4.6rem] pointer-events-none">
        <defs><linearGradient id="mg-city" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#cdb8e6" stopOpacity="0.55" /><stop offset="1" stopColor="#c2a9df" stopOpacity="0.32" /></linearGradient></defs>
        <path d="M0 70 L0 46 L16 46 L16 34 L28 34 L28 46 L34 46 L34 24 L42 16 L50 24 L50 46 L58 46 L58 38 L72 38 L72 46 L80 46 L80 26 L90 26 L90 18 L96 18 L96 46 L108 46 L108 40 L122 40 L122 46 L130 46 L130 30 L142 22 L154 30 L154 46 L164 46 L164 36 L178 36 L178 46 L186 46 L186 24 L196 24 L196 46 L206 46 L206 38 L224 38 L224 32 L240 32 L240 70 Z" fill="url(#mg-city)" />
        {/* 暖窗小点 */}
        {[[20, 40], [40, 30], [86, 32], [92, 24], [136, 34], [170, 42], [190, 32], [214, 44]].map(([x, y], i) => (
            <rect key={i} x={x} y={y} width="2.4" height="3" rx="0.6" fill="#fff" opacity="0.5" />
        ))}
    </svg>
);

// 居中分节标题（两侧发丝线 + 星芒）
const SectionLabel: React.FC<{ cn: string; en: string }> = ({ cn, en }) => (
    <div className="flex items-center gap-2.5 mt-7 mb-4">
        <div className="flex-1 h-px" style={{ background: `linear-gradient(90deg, transparent, ${PAL.lilac})`, opacity: 0.5 }} />
        <span className="text-[10px]" style={{ color: PAL.pink }}>✦</span>
        <div className="text-center leading-tight">
            <div className="text-[16px]" style={{ fontFamily: FONT_CN, color: PAL.grape, letterSpacing: '0.06em' }}>{cn}</div>
            <div className="text-[8px] font-bold mt-0.5" style={{ color: PAL.lilac, letterSpacing: '0.34em' }}>{en}</div>
        </div>
        <span className="text-[10px]" style={{ color: PAL.pink }}>✦</span>
        <div className="flex-1 h-px" style={{ background: `linear-gradient(90deg, ${PAL.lilac}, transparent)`, opacity: 0.5 }} />
    </div>
);

const MobileGameHome: React.FC = () => {
    const { openApp, characters, activeCharacterId, virtualTime, unreadMessages, isDataLoaded, lastMsgTimestamp } = useOS();

    const [widgetChar, setWidgetChar] = useState<CharacterProfile | null>(null);
    const [lastMessage, setLastMessage] = useState<string>('');
    const [stat, setStat] = useState({ msgCount: 0, firstTs: 0 });
    const [drawerOpen, setDrawerOpen] = useState(false);
    // 界面配色方案：localStorage 持久化；默认经典梦幻粉紫（亮）
    const [mgStyle, setMgStyle] = useState<TgStyle>(() => {
        try {
            const raw = localStorage.getItem(MG_STYLE_KEY);
            if (raw) {
                const p = JSON.parse(raw);
                if (typeof p?.hue === 'number') return { id: p.id || 'custom', name: p.name || '自定义', hue: p.hue, dark: !!p.dark, gold: !!p.gold, mute: !!p.mute };
            }
        } catch { /* 解析失败走默认 */ }
        return MG_CLASSIC;
    });
    const [mgPaletteOpen, setMgPaletteOpen] = useState(false);
    const applyMgStyle = (s: TgStyle) => {
        setMgStyle(s);
        try { localStorage.setItem(MG_STYLE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
    };
    const mgVars = useMemo(() => makeMgVars(mgStyle), [mgStyle]);

    const [devDebugVisible, setDevDebugVisible] = useState(() => isDevDebugAvailable());
    useEffect(() => subscribeDevDebugAvailability(setDevDebugVisible), []);

    useEffect(() => {
        if (!isDataLoaded) return;
        if (!characters || characters.length === 0) {
            setWidgetChar(null);
            setLastMessage('');
            setStat({ msgCount: 0, firstTs: 0 });
            return;
        }
        const target = characters.find(c => c.id === activeCharacterId) || characters[0];
        setWidgetChar(target);
        let cancelled = false;
        DB.getMessagesByCharId(target.id).then(msgs => {
            if (cancelled) return;
            const visible = msgs.filter(isChatPreviewMessage);
            // 真实数值来源：聊天消息数（Lv/EXP/钻石）+ 最早消息时间（认识天数→星星）
            const interactionMessages = msgs.filter(m => m.role !== 'system');
            setStat({ msgCount: interactionMessages.length, firstTs: interactionMessages[0]?.timestamp || 0 });
            if (visible.length > 0) {
                const last = visible[visible.length - 1];
                const clean = last.content.replace(/\[.*?\]/g, '').trim();
                setLastMessage(clean || (last.type === 'image' ? '[图片]' : '[消息]'));
            } else {
                setLastMessage(target.description || '');
            }
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [activeCharacterId, lastMsgTimestamp, isDataLoaded, characters]);

    const totalUnread = useMemo(
        () => Object.values(unreadMessages).reduce((a, b) => a + b, 0),
        [unreadMessages]
    );

    // 真实数值：等级/经验来自聊天消息数（每条 10 exp，升级所需随等级递增的三角曲线）；
    // 钻石 = 聊天消息数本身；星星 = 认识天数（从最早一条消息算起）。
    const stats = useMemo(() => {
        const msgCount = stat.msgCount;
        const totalExp = msgCount * 10;
        const base = 150; // 第 L 级所需经验 = base×L，累计为三角数
        const level = Math.max(1, Math.floor((1 + Math.sqrt(1 + (8 * totalExp) / base)) / 2));
        const need = (base * level * (level - 1)) / 2;
        const exp = Math.max(0, Math.round(totalExp - need));
        const expMax = base * level;
        const gems = msgCount; // 钻石 = 聊天消息数本身（不放大）
        const daysKnown = stat.firstTs ? Math.max(1, Math.floor((Date.now() - stat.firstTs) / 86400000) + 1) : 1;
        return { level, exp, expMax, gems, stars: daysKnown };
    }, [stat]);

    const greeting = virtualTime.hours < 5 ? 'Good Night'
        : virtualTime.hours < 12 ? 'Good Morning'
        : virtualTime.hours < 18 ? 'Good Afternoon'
        : 'Good Evening';
    const hh = virtualTime.hours.toString().padStart(2, '0');
    const mm = virtualTime.minutes.toString().padStart(2, '0');
    const now = new Date();
    const dayName = DAYS[now.getDay()];
    const monthName = MONTHS[now.getMonth()];
    const dateNum = now.getDate();

    const charName = widgetChar?.name || 'SullyOS·糯米机';
    const tagline = (widgetChar?.description || '不知名种草姬').slice(0, 36);
    const announcement = lastMessage || widgetChar?.description || '一切如常，等待新的故事发生。';
    const expPct = Math.min(100, Math.round((stats.exp / stats.expMax) * 100));
    // 时钟卡角色：优先彼方 chibi 小贴纸（透明立绘），没有就头像融合
    const chibi = widgetChar ? getChibi(widgetChar) : null;

    const drawerApps = useMemo(
        () => INSTALLED_APPS.filter(a => a.id !== AppID.CharCreatorDev || devDebugVisible),
        [devDebugVisible]
    );

    // 货币大卡
    const CoinCard: React.FC<{ icon: React.ReactNode; value: string }> = ({ icon, value }) => (
        <div className="flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-2xl w-[118px]" style={CARD}>
            {icon}
            <span className="flex-1 text-right text-[14px] font-extrabold tabular-nums" style={{ color: PAL.ink }}>{value}</span>
            <span className="w-[20px] h-[20px] rounded-full flex items-center justify-center text-[14px] font-bold leading-none shrink-0"
                style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.hot})`, color: '#fff', boxShadow: '0 2px 6px rgba(234,118,180,0.45)' }}>+</span>
        </div>
    );

    return (
        <div className="h-full w-full relative z-10 overflow-hidden select-none" style={{ ...mgVars, color: PAL.ink, fontFamily: FONT_CN }}>
            {/* 方案底色层：亮色透明（透出壁纸），暗色铺深烟渐变 */}
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'var(--mg-bg)' }} />
            {/* 极淡叠层：顶部提亮 + 底部微沉（仅亮色需要，暗色下几乎不可见，无害） */}
            {!mgStyle.dark && <div className="absolute inset-0 pointer-events-none"
                style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.4) 0%, rgba(255,255,255,0) 22%, rgba(255,255,255,0) 86%, rgba(206,188,232,0.1) 100%)' }} />}

            <div className="relative h-full overflow-y-auto no-scrollbar px-5"
                style={{ paddingTop: 'calc(var(--safe-top, 0px) + 0.75rem)', paddingBottom: '7.5rem' }}>

                {/* ===== 报头 Masthead ===== */}
                <div className="flex items-center justify-between animate-fade-in">
                    <div className="flex items-center gap-2">
                        <span className="text-[11px]" style={{ color: PAL.pink }}>✦</span>
                        <span className="text-[11px] font-bold" style={{ color: PAL.grape, letterSpacing: '0.3em' }}>SullyOS·糯米机&nbsp;STATION</span>
                        <span className="text-[9px]" style={{ color: PAL.peri }}>✦</span>
                    </div>
                    <div className="flex items-center gap-3">
                        <button onClick={() => setMgPaletteOpen(v => !v)} aria-label="界面配色"
                            className="w-7 h-7 rounded-full flex items-center justify-center active:scale-90 transition-transform"
                            style={{ background: 'var(--mg-chip)', border: '1px solid var(--mg-chip-line)', color: PAL.grape }}>
                            <span className="w-4 h-4">{MG_PALETTE_ICON}</span>
                        </button>
                        <button onClick={() => openApp(AppID.Appearance)} aria-label="菜单" className="flex flex-col items-end gap-[3.5px] py-2 active:opacity-60 transition-opacity">
                            <span className="w-5 h-[2px] rounded-full" style={{ background: PAL.grape }} />
                            <span className="w-5 h-[2px] rounded-full" style={{ background: PAL.grape }} />
                            <span className="w-5 h-[2px] rounded-full" style={{ background: PAL.grape }} />
                        </button>
                    </div>
                </div>
                <div className="h-px mt-2" style={{ background: `linear-gradient(90deg, ${PAL.lilac}, transparent)`, opacity: 0.5 }} />

                {/* ===== 🎨 界面配色面板（经典 + 12 方案，含暗色；点外面关闭）===== */}
                {mgPaletteOpen && (
                    <>
                        <div className="fixed inset-0 z-[60]" onClick={() => setMgPaletteOpen(false)} />
                        <div className="absolute right-0 z-[61] w-[16.5rem] rounded-2xl p-3.5 animate-pop-in"
                            style={{ top: 'calc(var(--safe-top, 0px) + 2.9rem)', background: 'var(--mg-drawer)', border: '1.5px solid var(--mg-card-line)', boxShadow: '0 10px 26px var(--mg-glow20)' }}>
                            <div className="flex items-center gap-1.5 mb-2.5">
                                <span className="w-4 h-4" style={{ color: PAL.grape }}>{MG_PALETTE_ICON}</span>
                                <span className="text-[12px] font-bold tracking-wide" style={{ fontFamily: FONT_CN, color: PAL.grape }}>界面配色</span>
                                <span className="text-[8px]" style={{ color: PAL.pink }}>✦</span>
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                                {MG_CHOICES.map(s => {
                                    const pv = schemePreview(s);
                                    const active = mgStyle.id === s.id;
                                    return (
                                        <button key={s.id} onClick={() => applyMgStyle(s)}
                                            className="relative flex flex-col items-center gap-1 active:scale-95 transition-transform">
                                            <span className="relative w-full h-9 rounded-lg overflow-hidden flex items-center justify-center"
                                                style={{ background: pv.bg, border: active ? `2px solid ${pv.line}` : '1.5px solid rgba(150,140,160,0.35)' }}>
                                                <span className="absolute inset-x-2 top-1.5 h-[3px] rounded-full" style={{ background: pv.line, opacity: 0.85 }} />
                                                <span className="absolute inset-x-4 bottom-1.5 h-[2px] rounded-full" style={{ background: pv.line, opacity: 0.5 }} />
                                                {active && <span className="text-[9px]" style={{ color: pv.line }}>✦</span>}
                                            </span>
                                            <span className="text-[8.5px] leading-none" style={{ fontFamily: FONT_CN, color: active ? PAL.grape : PAL.lilac }}>{s.name}</span>
                                        </button>
                                    );
                                })}
                            </div>
                            <p className="text-[8.5px] leading-relaxed mt-2 text-center" style={{ color: PAL.lilac, fontFamily: FONT_CN }}>
                                暗色方案夜里超好看 ✦ 亮色会透出你的壁纸
                            </p>
                        </div>
                    </>
                )}

                {/* ===== 角色档案 Profile ===== */}
                <div className="flex items-center gap-3.5 mt-4 animate-fade-in">
                    <div className="relative shrink-0" onClick={() => openApp(AppID.Character)}>
                        <Sparkles items={[[2, 8, 12, '#fff', 0.95], [96, 22, 10, PAL.pink, 0.9], [6, 92, 9, PAL.peri, 0.85], [92, 88, 11, '#fff', 0.9]]} />
                        <div className="w-[68px] h-[68px] rounded-full p-[2.5px] cursor-pointer active:scale-95 transition-transform"
                            style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.peri}, ${PAL.lilac})`, boxShadow: '0 6px 16px rgba(150,120,200,0.35)' }}>
                            <div className="w-full h-full rounded-full overflow-hidden" style={{ border: '2px solid #fff' }}>
                                {widgetChar?.avatar
                                    ? <TokenImg value={widgetChar.avatar} className="w-full h-full object-cover" alt="char" loading="lazy" />
                                    : <div className="w-full h-full flex items-center justify-center text-2xl" style={{ background: PAL.mist, color: PAL.lilac }}>✦</div>}
                            </div>
                        </div>
                        <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 px-2.5 py-[1px] rounded-md text-[10px] tracking-wide whitespace-nowrap"
                            style={{ background: 'linear-gradient(135deg, var(--mg-badge1), var(--mg-badge2))', color: '#fff', fontFamily: FONT_DISPLAY, boxShadow: '0 2px 8px rgba(60,50,90,0.4)' }}>
                            Lv.{stats.level}
                        </div>
                    </div>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <h2 className="text-[24px] truncate" style={{ fontFamily: FONT_CN, color: PAL.grape }}>{charName}</h2>
                            <span className="flex items-center gap-1 text-[9px] font-bold tracking-[0.12em] shrink-0" style={{ color: PAL.lilac }}>
                                <span className="w-2 h-2 rounded-full" style={{ background: '#7cd992', boxShadow: '0 0 5px #7cd992' }} />ONLINE
                            </span>
                        </div>
                        <p className="text-[12px] leading-snug mt-1 truncate" style={{ color: PAL.lilac }}>{tagline}</p>
                    </div>

                    <div className="flex flex-col items-end gap-2 shrink-0">
                        <CoinCard
                            icon={<svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0"><path d="M6 3h12l3 5-9 13L3 8z" fill={PAL.peri} stroke={PAL.grape} strokeWidth="1" strokeLinejoin="round" /></svg>}
                            value={stats.gems.toLocaleString()}
                        />
                        <CoinCard
                            icon={<svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.8 5.9 20.4l1.5-6.8L2.2 9l6.9-.7z" fill={PAL.pink} stroke={PAL.hot} strokeWidth="0.6" strokeLinejoin="round" /></svg>}
                            value={stats.stars.toString()}
                        />
                    </div>
                </div>

                {/* EXP 条（全宽）*/}
                <div className="flex items-center gap-2.5 mt-3.5 animate-fade-in">
                    <span className="text-[11px] font-bold tracking-[0.16em]" style={{ color: PAL.grape }}>EXP</span>
                    <div className="flex-1 h-[9px] rounded-full overflow-hidden" style={{ background: 'var(--mg-track)', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.12)' }}>
                        <div className="h-full rounded-full" style={{ width: `${expPct}%`, background: `linear-gradient(90deg, ${PAL.peri}, ${PAL.lilac}, ${PAL.pink})`, boxShadow: '0 0 8px rgba(244,166,204,0.6)' }} />
                    </div>
                    <span className="text-[11px] tabular-nums whitespace-nowrap font-bold" style={{ color: PAL.lilac }}>{stats.exp} / {stats.expMax}</span>
                </div>

                {/* ===== 时钟 Hero 卡（内嵌天空 + 立绘）===== */}
                <div className="relative mt-4 rounded-3xl overflow-hidden animate-fade-in"
                    style={{ height: '13rem', border: '1px solid rgba(255,255,255,0.7)', boxShadow: '0 12px 30px rgba(150,120,200,0.25)' }}>
                    {/* 梦幻天空底 */}
                    <div className="absolute inset-0" style={{ background: 'var(--mg-sky)' }} />
                    <div className="absolute inset-0" style={{ background: 'radial-gradient(80% 60% at 50% 18%, rgba(255,255,255,0.5), transparent 70%)' }} />
                    {/* 云朵 */}
                    <div className="absolute top-6 left-5 w-20 h-8 rounded-full" style={{ background: 'rgba(255,255,255,0.55)', filter: 'blur(7px)' }} />
                    <div className="absolute top-12 right-10 w-24 h-9 rounded-full" style={{ background: 'rgba(255,255,255,0.45)', filter: 'blur(8px)' }} />
                    {/* 城市 / 小房子剪影 */}
                    <CityScape />
                    {/* 流星 */}
                    <div className="absolute top-5 left-6 w-16 h-[2px] rotate-[28deg] origin-left" style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.85))' }} />
                    {/* 星芒 */}
                    <Sparkles items={[[12, 22, 16, '#fff', 0.95], [22, 50, 10, '#fff', 0.8], [40, 16, 12, '#fff', 0.85], [86, 26, 14, '#fff', 0.9], [70, 60, 9, PAL.pink, 0.8], [50, 78, 8, '#fff', 0.7]]} />

                    {/* 日期 pill */}
                    <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-[10px] font-bold whitespace-nowrap"
                        style={{ background: 'var(--mg-pill)', color: PAL.grape, letterSpacing: '0.16em', border: '1px solid rgba(255,255,255,0.35)' }}>
                        {dayName} · {dateNum} {monthName}
                    </div>

                    {/* 大时钟 */}
                    <div className="absolute inset-x-0 top-[3.4rem] flex items-center justify-center">
                        <div className="flex items-center" style={{ fontFamily: FONT_DISPLAY, color: '#fff', fontFeatureSettings: '"tnum"', textShadow: '0 2px 0 rgba(168,150,220,0.55), 0 6px 18px rgba(140,110,190,0.45)' }}>
                            <span className="text-[5.2rem] leading-none">{hh}</span>
                            <StarBurst className="w-9 h-9 mx-0.5" fill={PAL.hot} />
                            <span className="text-[5.2rem] leading-none">{mm}</span>
                        </div>
                    </div>

                    {/* 问候（手写）*/}
                    <div className="absolute inset-x-0 bottom-7 flex items-center justify-center gap-2">
                        <span className="text-[12px]" style={{ color: PAL.pink }}>✦</span>
                        <span className="text-[2rem] leading-none italic" style={{ fontFamily: FONT_SCRIPT, fontWeight: 700, color: PAL.hot, textShadow: '0 1px 6px rgba(255,255,255,0.7)' }}>{greeting}</span>
                        <span className="text-[12px]" style={{ color: PAL.pink }}>✦</span>
                    </div>

                    {/* 角色：有彼方 chibi → 小贴纸；否则头像电影感融合（参考日常表/攻略本）*/}
                    {chibi?.img && (chibi.isFallback ? (
                        <div className="absolute right-0 top-0 bottom-0 w-[54%] pointer-events-none"
                            style={{
                                opacity: 0.5,
                                WebkitMaskImage: 'linear-gradient(100deg, transparent 30%, #000 82%)',
                                maskImage: 'linear-gradient(100deg, transparent 30%, #000 82%)',
                            }}>
                            <TokenImg value={chibi.img} className="w-full h-full object-cover" alt="" loading="lazy" style={{ objectPosition: 'center 22%' }} />
                        </div>
                    ) : (
                        <TokenImg value={chibi.img} alt="" loading="lazy"
                            className="absolute right-0 bottom-0 object-contain object-bottom pointer-events-none"
                            style={{
                                height: '64%', // 相对时钟卡高度，避免吃彼方里按 VR 调的绝对 scale 而巨大
                                transform: `scaleX(${chibi.flip ? -1 : 1})`,
                                filter: 'drop-shadow(0 5px 10px rgba(120,90,170,0.45))',
                            }} />
                    ))}
                </div>

                {/* ===== 最新公告（点进去 = 当前聊天）===== */}
                <button onClick={() => openApp(AppID.Chat)}
                    className="relative w-full text-left mt-4 rounded-2xl p-3.5 flex items-center gap-3 active:scale-[0.99] transition-transform animate-fade-in overflow-hidden"
                    style={CARD}>
                    <Sparkles items={[[8, 24, 9, PAL.pink, 0.7], [4, 70, 8, PAL.peri, 0.6]]} />
                    {/* 喇叭徽标 */}
                    <div className="w-11 h-11 shrink-0 rounded-full flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.hot})`, boxShadow: '0 4px 10px rgba(234,118,180,0.4)' }}>
                        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1Z" /><path d="M15 8a4 4 0 0 1 0 8" /></svg>
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                            <span className="text-[14px]" style={{ fontFamily: FONT_CN, color: PAL.grape }}>最新公告</span>
                            <span className="px-1.5 py-px rounded text-[8px] font-bold tracking-wider" style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.hot})`, color: '#fff' }}>NEW</span>
                        </div>
                        <p className="text-[11px] leading-relaxed line-clamp-2" style={{ color: PAL.lilac }}>{announcement}</p>
                    </div>
                    <div className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center" style={{ background: 'var(--mg-chip)', border: '1px solid var(--mg-chip-line)' }}>
                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke={PAL.hot} strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                    </div>
                </button>

                {/* ===== 快捷入口 ===== */}
                <SectionLabel cn="快捷入口" en="SHORTCUTS" />
                <div className="grid grid-cols-4 gap-2.5 animate-fade-in">
                    {QUICK_ENTRIES.map(e => (
                        <button key={e.id} onClick={() => openApp(e.id)} className="flex flex-col items-center gap-2 active:scale-90 transition-transform">
                            <div className="relative w-[3.9rem] h-[3.9rem] rounded-[1.55rem] flex items-center justify-center" style={TILE}>
                                <span className="absolute top-1.5 right-2 text-[8px]" style={{ color: PAL.pink, opacity: 0.85 }}>✦</span>
                                <div className="w-[2.4rem] h-[2.4rem]">{renderAppArt(e.id)}</div>
                            </div>
                            <span className="text-[11px]" style={{ fontFamily: FONT_CN, color: PAL.grape }}>{e.cn}</span>
                        </button>
                    ))}
                </div>

                {/* ===== 应用目录 ===== */}
                <SectionLabel cn="应用目录" en="INDEX" />
                <div className="grid grid-cols-2 gap-3">
                    {GRID_CARDS.map((card, i) => (
                        <button key={card.id} onClick={() => openApp(card.id)}
                            className="relative h-[6.75rem] rounded-2xl p-4 flex flex-col justify-center text-left overflow-hidden active:scale-[0.97] transition-transform animate-fade-in"
                            style={CARD}>
                            <Sparkles items={[[10, 18, 9, PAL.pink, 0.7], [90, 80, 8, PAL.peri, 0.6]]} />
                            <span className="absolute top-2.5 left-3.5 text-[12px] tabular-nums" style={{ fontFamily: FONT_DISPLAY, color: PAL.lilac }}>{String(i + 1).padStart(2, '0')}</span>
                            <div className="absolute right-2.5 top-1/2 -translate-y-1/2 w-[3.9rem] h-[3.9rem] pointer-events-none">
                                {renderAppArt(card.id)}
                            </div>
                            <div className="relative mt-2">
                                <div className="text-[21px] leading-tight" style={{ fontFamily: FONT_CN, color: PAL.grape }}>{card.cn}</div>
                                <div className="text-[9px] font-bold tracking-[0.26em] mt-1" style={{ color: PAL.lilac }}>{card.en}</div>
                            </div>
                        </button>
                    ))}
                </div>
            </div>

            {/* ===== 底部 Dock ===== */}
            <div className="absolute bottom-0 left-0 w-full px-3.5 z-30 pointer-events-none" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 0.75rem)' }}>
                <div className="relative pointer-events-auto rounded-[1.9rem] px-3 py-2.5 flex items-end justify-between"
                    style={{ background: 'var(--mg-dock)', border: '1px solid var(--mg-dock-line)', boxShadow: '0 -6px 30px var(--mg-glow20), inset 0 1px 0 var(--mg-dock-line)', backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)' }}>
                    <DockItem id={AppID.Chat} cn="消息" badge={totalUnread} onClick={() => openApp(AppID.Chat)} />
                    <DockItem id={AppID.Character} cn="好友" onClick={() => openApp(AppID.Character)} />
                    {/* 中央罗盘 */}
                    <button onClick={() => setDrawerOpen(true)} aria-label="全部应用" className="-mt-8 w-[4.2rem] h-[4.2rem] rounded-full flex items-center justify-center active:scale-95 transition-transform shrink-0"
                        style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.peri}, ${PAL.lilac})`, padding: '3px', boxShadow: '0 8px 22px rgba(234,118,180,0.5)' }}>
                        <div className="w-full h-full rounded-full flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #5a4d85, #6b5b95)' }}>
                            <StarBurst className="w-8 h-8" fill="#ffffff" />
                        </div>
                    </button>
                    <DockItem id={AppID.Social} cn="动态" onClick={() => openApp(AppID.Social)} />
                    <DockItem id={AppID.ThemeMaker} cn="创作" onClick={() => openApp(AppID.ThemeMaker)} />
                </div>
            </div>

            {/* ===== 全部应用抽屉 ===== */}
            {drawerOpen && (
                <div className="absolute inset-0 z-40 flex flex-col animate-fade-in" style={{ background: 'var(--mg-drawer)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)' }} onClick={() => setDrawerOpen(false)}>
                    <div className="flex items-center justify-between px-6" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 1.25rem)', paddingBottom: '0.5rem' }}>
                        <h2 className="text-lg tracking-wide" style={{ fontFamily: FONT_CN, color: PAL.grape }}>全部应用</h2>
                        <button onClick={(e) => { e.stopPropagation(); setDrawerOpen(false); }} aria-label="关闭" className="w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition-transform" style={{ background: 'var(--mg-chip)', border: '1px solid var(--mg-chip-line)' }}>
                            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke={PAL.ink} strokeWidth="2.5"><path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" /></svg>
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-8" onClick={(e) => e.stopPropagation()}>
                        <div className="grid grid-cols-4 gap-y-5 gap-x-2 place-items-center">
                            {drawerApps.map(app => (
                                <AppIcon key={app.id} app={app} size="md" onClick={() => { setDrawerOpen(false); openApp(app.id); }} />
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const DockItem: React.FC<{ id: AppID; cn: string; badge?: number; onClick: () => void }> = ({ id, cn, badge = 0, onClick }) => {
    const iconKey = INSTALLED_APPS.find(a => a.id === id)?.icon || 'Settings';
    return (
        <button onClick={onClick} className="relative flex flex-col items-center gap-1 w-14 active:scale-90 transition-transform">
            <div className="relative w-7 h-7" style={{ color: PAL.grape }}>
                {renderGlyph(iconKey, 'w-full h-full')}
                {badge > 0 && (
                    <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center text-[9px] font-bold text-white"
                        style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.hot})`, border: '1px solid #fff' }}>
                        {badge > 99 ? '99+' : badge}
                    </span>
                )}
            </div>
            <span className="text-[10px]" style={{ fontFamily: FONT_CN, color: PAL.grape }}>{cn}</span>
        </button>
    );
};

export default MobileGameHome;
