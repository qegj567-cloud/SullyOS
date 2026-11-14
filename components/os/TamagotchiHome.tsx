import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useOS } from '../../context/OSContext';
import { INSTALLED_APPS, Icons } from '../../constants';
import { createPortal } from 'react-dom';
import { AppID, CharacterProfile, RoomItem, DailySchedule, ScheduleSlot } from '../../types';
import { DB } from '../../utils/db';
import { isChatPreviewMessage } from '../../utils/chatMessageVisibility';
import { getLastInnerState } from '../../utils/emotionApply';
import { getFlowNarrativeKey } from '../../utils/scheduleInjection';
import { generateSlotTheater } from '../../utils/theaterGenerator';
import { roomLaunch } from '../../utils/roomLaunch';
import TheaterPlayer from '../schedule/TheaterPlayer';
import AppIcon from './AppIcon';
import TokenImg from './TokenImg';
import { useBlobRefUrl, putImageBlob } from '../../utils/blobRef';
import { processImageToBlob } from '../../utils/file';
import { hueFromImage, hueFromGradient } from '../../utils/dominantHue';
import { FURNITURE_ICONS } from '../../utils/furnitureIcons';
import { isDevDebugAvailable, subscribeDevDebugAvailability } from '../../utils/devDebug';
import { SCHEMES, hsl, schemePreview, type TgStyle } from './gotchiScheme';
import { getDailyScheduleForChar } from '../../utils/dailySchedule';
import { useLocalDateKey } from '../../hooks/useLocalDateKey';
import { resolveCharTimeZone } from '../../utils/timezone';
import { getCurrentScheduleSlotIndex, getScheduleWallClock } from '../../utils/scheduleTime';

// ===== 电子宠物主题（tamagotchi skin）=====
// 桌面不再是「放图标的手机」，而是一台华丽丽的二次元养成机：屏幕主体是角色
// **真实的小屋**（小小窝里用户亲手装修的那间，家具/地毯/墙地面/立绘原样搬入，只读舞台），
// 角色在里面呼吸、游荡、被戳会念聊天里说过的话；底部 CARE/TALK/HOME/ALBUM/SETTINGS 五键 dock。
// 视觉基调：梦幻手游风——渐变描边、四角宝石、满屏星芒、发光经验条、扁平手绘贴纸键。
//
// 界面风格可换（🎨 面板）：星云紫/奶油白/暗夜黑金/薄荷青/粉樱梦/深海蓝 六方案 +
// 「提取小窝主色」——由 makeVars 按 {hue, dark, gold, mute} 推导成 CSS 变量，
// 明暗两套渲染规则（暗色=深烟卡+浅线+亮字；亮色=奶白卡+深线+深字；gold 统一金线）。
// 注意：日程木牌/纸卷/地板手机弹窗/气泡这些「世界里的道具」固定用 PAPER 纸质配色，
// 不跟随明暗——木头就是木头、纸就是纸，暗色主题下它们也不该变黑。
//
// 性能红线（此文件的宪法）：
//   · 零常驻 JS 动画 —— 循环动效全部 CSS keyframes 且只碰 transform/opacity；
//     JS 只用 ≥15s 的一次性 setTimeout 换游荡坐标。
//   · 禁 backdrop-filter / blur；星芒云朵全是静态 span 与渐变；每元素阴影 ≤2 层。
//   · 渲染隔离 —— 舞台/状态卡拆 memo 子组件，分钟跳动不触达家具层 reconcile；
//     换主色只改根节点 CSS 变量，子组件零 reconcile。
//   · 图片全走 TokenImg / useBlobRefUrl（blobref 令牌自动解析回收）+ lazy。

// —— 调色板：全部指向 CSS 变量（根节点按方案生成），cream/gold/night 为固定锚色 ——
const PAL = {
    frame: 'var(--tg-frame)',
    frameSoft: 'var(--tg-frame-soft)',
    cream: '#fdf9f2',
    card: 'var(--tg-card)',          // UI 卡面（随明暗）
    cardHi: 'var(--tg-card-strong)',
    ink: 'var(--tg-ink)',
    grape: 'var(--tg-grape)',
    fade: 'var(--tg-fade)',
    pink: 'var(--tg-pink)',
    hot: 'var(--tg-hot)',
    peri: 'var(--tg-peri)',
    gold: '#d9bd85',
    heart: 'var(--tg-heart)',
    heartDeep: 'var(--tg-heart-deep)',
    night: '#3a3560',
};
// —— 纸质锚色：世界里的道具（木牌/纸卷/手机弹窗/气泡）专用，不跟随明暗方案 ——
const PAPER = {
    line: '#b3a3e0',
    lineSoft: 'rgba(179,163,224,0.45)',
    ink: '#7a6cb8',
    hi: '#6b5b9e',
    dim: '#a99bd4',
    cream: '#fdf9f2',
    hot: '#ea76b4',
};
// 渐变描边（华丽框的灵魂）：伴色 → 邻色 → 主色浅调
const RIM = `linear-gradient(135deg, ${PAL.pink}, ${PAL.peri} 55%, var(--tg-rim3))`;
const FONT_PX = `'Courier Prime', monospace`;                   // 像素/LCD 字
const FONT_CN = `'ZCOOL KuaiLe', 'Noto Sans SC', sans-serif`;   // 中文圆润
const FONT_NUM = `'DM Serif Display', serif`;                   // 大数字（时间 / Lv）

// hue → 整套 CSS 变量。主色系（框/文字/底）+ 伴色系（hue+75，粉色位：强调/爱心）
// + 邻色系（hue-31，蓝紫位）。各角色的 S/L 定死，只转色相，保证任何 hue 都和谐。
// ─── 风格方案：见 gotchiScheme.ts（与手游皮肤共用 12 方案）────────────
const STYLE_KEY = 'tama_style_v2';
const LEGACY_HUE_KEY = 'tama_accent_hue'; // 旧版单色相偏好，迁移用

// 方案 → 整套 CSS 变量。变量名与旧版一致（frame/ink/grape/fade/pink/hot/…），
// 全部子组件零改动即可跟随明暗：暗色=深烟卡+浅线+亮字；亮色=奶白卡+深线+深字；
// gold 方案描边/强调统一转金；mute 压饱和（黑金的近黑底）。
const makeVars = (st: TgStyle): React.CSSProperties => {
    const { hue: h, dark, gold, mute } = st;
    const sat = (s: number) => (mute ? Math.min(s, 10) : s);
    const accentH = gold ? 45 : h + 75;
    if (dark) {
        // gold 方案的线/字保持暖金（不压饱和，黑金=香槟字）；非金的 mute 方案（曜夜银）线/字转银灰
        const lineH = gold ? 45 : h;
        const lineS = gold ? 48 : (mute ? 12 : 42);
        const textSat = (s: number) => (gold ? s : sat(s));
        return {
            '--tg-frame': hsl(lineH, lineS, 70),
            '--tg-frame-soft': hsl(lineH, lineS, 70, 0.5),
            '--tg-frame-a30': hsl(lineH, lineS, 70, 0.3),
            '--tg-frame-a22': hsl(lineH, lineS, 70, 0.22),
            '--tg-card': hsl(h, sat(26), 13, 0.8),
            '--tg-card-strong': hsl(h, sat(26), 16, 0.95),
            '--tg-ink': hsl(h, textSat(30), 84),
            '--tg-grape': hsl(h, textSat(45), 93),
            '--tg-fade': hsl(h, textSat(18), 64),
            '--tg-pink': hsl(accentH, gold ? 48 : 60, 76),
            '--tg-hot': hsl(accentH, gold ? 52 : 62, 66),
            '--tg-peri': hsl(h - 31, textSat(38), 72),
            '--tg-macc': hsl(lineH, gold ? 52 : (mute ? 25 : 62), 62),
            '--tg-macc-soft': hsl(lineH, gold ? 48 : (mute ? 22 : 58), 74),
            '--tg-macc-glow60': hsl(lineH, 55, 58, 0.6),
            '--tg-rim3': hsl(h, sat(30), 40),
            '--tg-heart': hsl(accentH, gold ? 48 : 58, 76),
            '--tg-heart-deep': hsl(accentH, gold ? 52 : 60, 68),
            '--tg-gem': hsl(accentH, 55, 70, 0.75),
            '--tg-cloud-shadow': hsl(h, sat(30), 30),
            '--tg-glow16': 'rgba(0,0,0,0.22)',
            '--tg-glow25': 'rgba(0,0,0,0.32)',
            '--tg-glow35': 'rgba(0,0,0,0.42)',
            '--tg-hotglow45': hsl(accentH, 55, 60, 0.45),
            '--tg-hotglow60': hsl(accentH, 55, 60, 0.6),
            '--tg-bg-top': hsl(h, sat(28), 17),
            '--tg-bg-mid': hsl(h, sat(26), 13),
            '--tg-bg-bot': hsl(h, sat(24), 10),
            '--tg-drawer': hsl(h, sat(24), 11, 0.97),
        } as React.CSSProperties;
    }
    const lineH = gold ? 43 : h;
    const lineS = gold ? 42 : sat(49);
    const lineL = gold ? 56 : 72;
    return {
        '--tg-frame': hsl(lineH, lineS, lineL),
        '--tg-frame-soft': hsl(lineH, lineS, lineL, 0.5),
        '--tg-frame-a30': hsl(lineH, lineS, lineL, 0.3),
        '--tg-frame-a22': hsl(lineH, lineS, lineL, 0.22),
        '--tg-card': 'rgba(255,255,255,0.8)',
        '--tg-card-strong': 'rgba(255,255,255,0.95)',
        '--tg-ink': hsl(h, sat(35), 55),
        '--tg-grape': hsl(h, sat(28), 45),
        '--tg-fade': hsl(h, sat(30), 66),
        '--tg-pink': hsl(accentH, 76, 78),
        '--tg-hot': hsl(accentH, 70, 62),
        '--tg-peri': hsl(h - 31, sat(58), 76),
        '--tg-macc': hsl(lineH, gold ? 50 : (mute ? 25 : 62), 55),
        '--tg-macc-soft': hsl(lineH, gold ? 46 : (mute ? 22 : 58), 68),
        '--tg-macc-glow60': hsl(lineH, 55, 52, 0.5),
        '--tg-rim3': hsl(h, sat(42), 84),
        '--tg-heart': hsl(accentH, 70, 78),
        '--tg-heart-deep': hsl(accentH, 66, 70),
        '--tg-gem': hsl(accentH, 70, 72, 0.75),
        '--tg-cloud-shadow': hsl(h, sat(52), 85),
        '--tg-glow16': hsl(h, sat(42), 60, 0.16),
        '--tg-glow25': hsl(h, sat(45), 62, 0.25),
        '--tg-glow35': hsl(h, sat(48), 64, 0.35),
        '--tg-hotglow45': hsl(accentH, 66, 66, 0.45),
        '--tg-hotglow60': hsl(accentH, 66, 66, 0.6),
        '--tg-bg-top': hsl(h, sat(57), 91),
        '--tg-bg-mid': hsl(h, sat(54), 88),
        '--tg-bg-bot': hsl(h, sat(52), 85),
        '--tg-drawer': hsl(h, sat(40), 95, 0.97),
    } as React.CSSProperties;
};


const FLOOR_HORIZON = 65; // 与 RoomApp 一致：地平线 65%

// —— 兜底家具（角色从没装修过小屋时）——
// 注意：不能 import RoomApp（它是 lazy chunk，引了会把整个小屋 App 拽进主包），
// 这里放一份轻量镜像：通用默认 = RoomApp.DEFAULT_FURNITURE；Sully = SULLY_FURNITURE 的
// 摆位副本（去掉了舞台用不到的 descriptionPrompt）。Sully 首次进过小小窝后 roomConfig
// 会自动落库，此副本只服务于「装完还没进过屋」的新档。
const FALLBACK_DEFAULT: RoomItem[] = [
    { id: 'desk', name: '书桌', type: 'furniture', image: FURNITURE_ICONS.sofa, x: 20, y: 55, scale: 1.2, rotation: 0, isInteractive: true },
    { id: 'plant', name: '盆栽', type: 'decor', image: FURNITURE_ICONS.plant, x: 85, y: 40, scale: 0.8, rotation: 0, isInteractive: true },
];
const FALLBACK_SULLY: RoomItem[] = [
    { id: 'item-1768927221380', name: 'Sully床', type: 'furniture', image: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/BED.png', x: 78.46, y: 97.39, scale: 2.4, rotation: 0, isInteractive: true },
    { id: 'item-1768927255102', name: 'Sully电脑桌', type: 'furniture', image: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/DNZ.png', x: 28.85, y: 69.94, scale: 2.4, rotation: 0, isInteractive: true },
    { id: 'item-1768927271632', name: 'Sully垃圾桶', type: 'furniture', image: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/LJT.png', x: 10.28, y: 80.5, scale: 0.9, rotation: 0, isInteractive: true },
    { id: 'item-1768927286526', name: 'Sully洞洞板', type: 'furniture', image: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/DDB.png', x: 32.61, y: 48.72, scale: 2.6, rotation: 0, isInteractive: true },
    { id: 'item-1768927303472', name: 'Sully书柜', type: 'furniture', image: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/SG.png', x: 79.84, y: 68.94, scale: 2, rotation: 0, isInteractive: true },
];
const FALLBACK_WALL = 'radial-gradient(circle at 50% 50%, #fdfbf7 0%, #e2e8f0 100%)';
const FALLBACK_FLOOR = 'repeating-linear-gradient(90deg, #e7e5e4 0px, #e7e5e4 20px, #d6d3d1 21px)';

// 与 RoomApp.getBgStyle 同口径：url 类走 background 简写（含缩放/平铺），渐变串原样返回
const getBgStyle = (img: string | undefined, scale: number | undefined, repeat: boolean | undefined, fallback: string): string => {
    if (!img) return fallback;
    const isUrl = img.startsWith('http') || img.startsWith('data') || img.startsWith('blob:') || img.startsWith('/');
    if (!isUrl) return img;
    const size = scale && scale > 0 ? `${scale}%` : 'cover';
    return `url(${img}) center center / ${size} ${repeat ? 'repeat' : 'no-repeat'}`;
};

// 与 RoomApp 一致的图层法则：地毯压进 [1,11] 底层区间，家具按 y 排 z，角色 y+20 必然在最上
const itemZ = (item: RoomItem) => item.type === 'rug' ? 1 + Math.floor(item.y / 10) : Math.floor(item.y);

const isNightHour = (h: number) => h < 6 || h >= 23;

// 等级口径与 MobileGameHome 完全一致：每条消息 10 exp，三角曲线升级
const deriveStats = (msgCount: number) => {
    const totalExp = msgCount * 10;
    const base = 150;
    const level = Math.max(1, Math.floor((1 + Math.sqrt(1 + (8 * totalExp) / base)) / 2));
    const need = (base * level * (level - 1)) / 2;
    const exp = Math.max(0, Math.round(totalExp - need));
    const expMax = base * level;
    return { level, exp, expMax };
};

// ─── 主色提取（🎨「提取小窝主色」）──────────────────────────────
// 实现抽到 utils/dominantHue.ts，与触感陪伴桌面共用。

// ─── 装饰小件（全静态，零成本）───────────────────────────────
// 星芒 ✦ 散布：按 [x%, y%, 字号px, 颜色, 透明度, 是否闪烁]
type Sp = [number, number, number, string, number, boolean?];
const Sparkles = React.memo<{ items: Sp[] }>(({ items }) => (
    <>
        {items.map(([x, y, s, c, o, tw], i) => (
            <span key={i} className="absolute pointer-events-none select-none leading-none"
                style={{
                    left: `${x}%`, top: `${y}%`, fontSize: s, color: c, opacity: o,
                    transform: 'translate(-50%,-50%)',
                    animation: tw ? `tama-twinkle ${2.4 + (i % 3) * 0.7}s ease-in-out ${(i % 4) * 0.6}s infinite` : undefined,
                }}>✦</span>
        ))}
    </>
));

// 四角宝石（rotate-45 小方块，华丽卡片标配）
const GemCorners = React.memo<{ color?: string; inset?: number }>(({ color = 'var(--tg-gem)', inset = 8 }) => (
    <>
        {[[0, 0], [1, 0], [0, 1], [1, 1]].map(([r, b], i) => (
            <span key={i} className="absolute w-1.5 h-1.5 rotate-45 pointer-events-none"
                style={{ [r ? 'right' : 'left']: inset, [b ? 'bottom' : 'top']: inset, background: color } as React.CSSProperties} />
        ))}
    </>
));

// 页面氛围层：主色底渐变 + 静态星野（多重 radial-gradient 星点）+ 顶部柔光
const BackDecor = React.memo(() => (
    <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, var(--tg-bg-top) 0%, var(--tg-bg-mid) 55%, var(--tg-bg-bot) 100%)' }} />
        <div className="absolute inset-0 opacity-80" style={{
            backgroundImage:
                'radial-gradient(1.5px 1.5px at 12% 8%, rgba(255,255,255,0.9), transparent), radial-gradient(1px 1px at 78% 5%, rgba(255,220,240,0.8), transparent), radial-gradient(1.5px 1.5px at 40% 15%, rgba(255,255,255,0.7), transparent), radial-gradient(1px 1px at 90% 22%, rgba(220,225,255,0.7), transparent), radial-gradient(1px 1px at 6% 38%, rgba(255,255,255,0.6), transparent), radial-gradient(1.5px 1.5px at 95% 55%, rgba(255,230,250,0.6), transparent), radial-gradient(1px 1px at 4% 72%, rgba(255,255,255,0.55), transparent), radial-gradient(1px 1px at 92% 88%, rgba(230,220,255,0.6), transparent)',
        }} />
        <div className="absolute inset-x-0 top-0 h-40" style={{ background: 'radial-gradient(70% 100% at 50% 0%, rgba(255,255,255,0.5), transparent 70%)' }} />
        <Sparkles items={[
            [7, 12, 13, '#fff', 0.9, true], [93, 9, 11, PAL.gold, 0.85, true],
            [85, 30, 9, '#fff', 0.7], [4, 55, 10, PAL.pink, 0.6, true],
            [96, 68, 9, '#fff', 0.6], [8, 88, 11, PAL.gold, 0.7, true],
        ]} />
    </div>
));

// ─── 舞台家具（贴纸，逐件 memo；可点击 = 小屋同款就地交互）─────────
const StageItem = React.memo<{ item: RoomItem; onTap: (item: RoomItem) => void }>(({ item, onTap }) => (
    <div className="absolute select-none cursor-pointer active:opacity-90"
        onClick={(e) => { e.stopPropagation(); onTap(item); }}
        style={{
            left: `${item.x}%`, top: `${item.y}%`,
            width: `${80 * item.scale}px`,
            transform: `translate(-50%, -100%) rotate(${item.rotation}deg)`,
            zIndex: itemZ(item),
        }}>
        <TokenImg value={item.image} className="w-full h-auto object-contain pointer-events-none" draggable={false} loading="lazy" alt="" />
    </div>
));

// ─── 挂在横幅下的小电子钟（时钟功能为主，天色只是表盘氛围）────────────
// 表盘小屏按时段换底：清晨/白天/黄昏/夜晚/夜深啦；SVG 太阳/弯月，无 emoji 无大云窗。
const CLOCK_PHASES = {
    dawn: { label: '清晨', bg: 'linear-gradient(160deg, #ffe9d6, #ffd9e8)', fg: '#9a6f4d', sub: 'rgba(154,111,77,0.75)' },
    day: { label: '白天', bg: 'linear-gradient(160deg, #bfe0f7, #e8f5fd)', fg: '#3f6f9e', sub: 'rgba(63,111,158,0.75)' },
    dusk: { label: '黄昏', bg: 'linear-gradient(160deg, #ffc9a3, #e8a7c8)', fg: '#7d4458', sub: 'rgba(125,68,88,0.8)' },
    night: { label: '夜晚', bg: 'linear-gradient(160deg, #3a3560, #575083)', fg: '#f0edff', sub: 'rgba(240,237,255,0.75)' },
    late: { label: '夜深啦', bg: 'linear-gradient(160deg, #232045, #3a3560)', fg: '#e4defc', sub: 'rgba(228,222,252,0.78)' },
} as const;
type ClockPhase = keyof typeof CLOCK_PHASES;
const clockPhaseOf = (h: number): ClockPhase => (h >= 23 || h < 5) ? 'late' : h < 8 ? 'dawn' : h < 17 ? 'day' : h < 20 ? 'dusk' : 'night';

// ─── 直播看板（云窗位）：一整张 banner——营业中/电子时间都是排版在图上的文字层 ──
// 底：用户上传的横图（存 blob，localStorage 只记 blobref 令牌），或 主题渐变+头像。
// 排版层：营业状态（白天「营业中·ON AIR」呼吸绿点，深夜「休息中·CLOSED」）+
// 裸排电子时间（有图时用户可自定义文字色，默认白+阴影；无图走主题深字）。
const LiveBoard = React.memo<{
    customImg: string; fg: string; avatar?: string; night: boolean; dark: boolean;
    hh: string; mm: string; phase: ClockPhase;
    onClock: () => void;
}>(({ customImg, fg, avatar, night, dark, hh, mm, phase, onClock }) => {
    const darkFace = phase === 'night' || phase === 'late';
    const bgImg = customImg || avatar || '';
    // 跟随明暗：暗主题=暗色玻璃+白字；浅主题=奶白玻璃+主题深字。fg 空=自动，用户选过就用用户的。
    const inkAuto = dark ? '#ffffff' : 'var(--tg-grape)';
    const ink = fg || inkAuto;
    const sub = dark ? 'rgba(255,255,255,0.75)' : 'var(--tg-ink)';
    const dim = dark ? 'rgba(255,255,255,0.45)' : 'var(--tg-fade)';
    const glow = dark
        ? '0 0 10px var(--tg-macc-glow60), 0 1px 3px rgba(0,0,0,0.6)'
        : '0 0 8px rgba(255,255,255,0.9), 0 1px 2px rgba(255,255,255,0.7)';
    const scrim = dark
        ? 'linear-gradient(100deg, rgba(15,11,28,0.88) 0%, rgba(15,11,28,0.55) 48%, rgba(15,11,28,0.82) 100%)'
        : 'linear-gradient(100deg, rgba(253,250,246,0.92) 0%, rgba(253,250,246,0.62) 48%, rgba(253,250,246,0.88) 100%)';
    return (
        <div className="absolute inset-x-4 z-[32] rounded-[1.15rem] overflow-hidden h-[4.8rem]"
            style={{ top: 'calc(var(--chrome-top, var(--safe-top, 0px)) + 4.55rem)', border: `1.5px solid ${PAL.frameSoft}`, boxShadow: dark ? '0 6px 16px rgba(0,0,0,0.35)' : '0 6px 16px var(--tg-glow25)' }}>
            {/* 底：自定义图，或角色头像拉伸铺底（攻略本选人那味儿）；按明暗罩玻璃纱 */}
            {bgImg ? (
                <TokenImg value={bgImg} className="absolute inset-0 w-full h-full object-cover" draggable={false} loading="lazy" alt="" />
            ) : (
                <div className="absolute inset-0" style={{ background: dark ? 'linear-gradient(120deg, var(--tg-bg-top), var(--tg-bg-bot))' : 'linear-gradient(120deg, var(--tg-bg-top), var(--tg-bg-bot))' }} />
            )}
            <div className="absolute inset-0" style={{ background: scrim }} />
            {/* 顶部玻璃高光丝 */}
            <div className="absolute inset-x-0 top-0 h-[40%]" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.09), transparent)' }} />

            {/* 赛博角标装饰层（全静态）：三点 / 角括线 / 准星 / 闪电 / 星芒 / 虚线——点缀全走主题主色 */}
            <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-2 right-2.5 flex gap-1">
                    {[0, 1, 2].map(i => <span key={i} className="w-[5px] h-[5px] rounded-full" style={{ border: `1px solid ${dark ? 'rgba(255,255,255,0.55)' : 'var(--tg-frame)'}` }} />)}
                </div>
                <span className="absolute top-1.5 left-2 w-5 h-3" style={{ borderLeft: '1px solid var(--tg-frame-a30)', borderTop: '1px solid var(--tg-frame-a30)' }} />
                <span className="absolute bottom-1.5 right-2 w-5 h-3" style={{ borderRight: '1px solid var(--tg-frame-a30)', borderBottom: '1px solid var(--tg-frame-a30)' }} />
                <span className="absolute bottom-2 left-2 right-[55%] border-t border-dashed" style={{ borderColor: 'var(--tg-frame-a22)' }} />
                <svg viewBox="0 0 24 24" className="absolute left-2 bottom-4 w-2.5 h-2.5" fill="var(--tg-macc)" opacity="0.85"><path d="M13 2 4.5 13.5h5L10 22l8.5-11.5h-5z" /></svg>
                <svg viewBox="0 0 24 24" className="absolute right-3 bottom-4 w-3 h-3" fill="none" stroke="var(--tg-frame)" strokeWidth="1.4" opacity="0.5"><circle cx="12" cy="12" r="5.5" /><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" /></svg>
                <Sparkles items={[[3.5, 26, 9, dark ? '#fff' : 'var(--tg-macc)', 0.85, true], [30, 16, 7, 'var(--tg-macc-soft)', 0.8], [35, 78, 6, dark ? '#fff' : 'var(--tg-frame)', 0.6], [63, 24, 7, dark ? '#fff' : 'var(--tg-macc)', 0.7, true], [96, 55, 7, 'var(--tg-macc-soft)', 0.7, true]]} />
            </div>

            {/* 排版层：左 LIVE+营业中+ON AIR ／ 右 TIME+大数字+渐变下划线 */}
            <div className="absolute inset-0 flex items-center justify-between pl-4 pr-3.5">
                <div className="relative min-w-0 leading-none">
                    {/* 左上 /// 强调斜线 */}
                    <div className="absolute -top-2.5 -left-1.5 flex gap-[3px]" style={{ transform: 'rotate(-18deg)' }}>
                        {[7, 10, 8].map((h2, i) => <span key={i} className="w-[3px] rounded-full" style={{ height: h2, background: 'var(--tg-macc)', boxShadow: '0 0 5px var(--tg-macc-glow60)' }} />)}
                    </div>
                    <div className="flex items-center gap-1.5 mb-1.5 pl-3">
                        <span className="px-2 py-[2px] rounded-full flex items-center gap-1"
                            style={{ background: night ? 'rgba(140,135,165,0.45)' : 'linear-gradient(135deg, var(--tg-macc-soft), var(--tg-macc))', border: '1px solid rgba(255,255,255,0.55)' }}>
                            <span className="w-1 h-1 rounded-full bg-white" style={{ animation: night ? undefined : 'tama-twinkle 1.8s ease-in-out infinite' }} />
                            <span className="text-[7px] font-bold tracking-[0.22em] text-white" style={{ fontFamily: FONT_PX }}>{night ? 'REST' : 'LIVE'}</span>
                        </span>
                    </div>
                    <div className="text-[19px] font-bold truncate" style={{ fontFamily: FONT_CN, color: ink, textShadow: glow, letterSpacing: '0.12em' }}>{night ? '休息中' : '营业中'}</div>
                    <div className="flex items-center gap-1.5 mt-1.5">
                        <span className="text-[6px] tracking-[0.2em]" style={{ color: dim }}>·····</span>
                        <span className="text-[7px] font-bold tracking-[0.34em]" style={{ fontFamily: FONT_PX, color: sub }}>{night ? 'OFF AIR' : 'ON AIR'}</span>
                        <span className="text-[6px] tracking-[0.2em]" style={{ color: dim }}>·····</span>
                    </div>
                </div>
                {/* 右：电子时间（点一下进日程） */}
                <button onClick={onClock} className="shrink-0 leading-none text-right active:scale-95 transition-transform">
                    <div className="flex items-center justify-end gap-1.5 mb-1">
                        <span className="w-[11px] h-[11px]" style={{ color: sub }}>
                            {darkFace ? ICON.moon : (
                                <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></svg>
                            )}
                        </span>
                        <span className="text-[7px] font-bold tracking-[0.34em]" style={{ fontFamily: FONT_PX, color: sub }}>{phase === 'late' ? '夜深啦' : 'TIME'}</span>
                    </div>
                    <div className="text-[24px] font-bold tabular-nums" style={{ fontFamily: FONT_PX, color: ink, textShadow: glow, letterSpacing: '0.06em' }}>{hh}:{mm}</div>
                    <div className="relative mt-1.5 h-[2px] rounded-full" style={{ background: 'linear-gradient(90deg, transparent, var(--tg-macc) 30%, var(--tg-macc) 70%, transparent)' }}>
                        <span className="absolute -top-[4.5px] right-[18%] text-[9px] leading-none" style={{ color: 'var(--tg-macc-soft)' }}>✦</span>
                    </div>
                </button>
            </div>
        </div>
    );
});

// ─── 天花板小挂饰：从看板下垂两颗 ✦，轻轻摇（transform-only）────────────
const CeilingCharms = React.memo(() => (
    <div className="absolute inset-x-0 z-[28] pointer-events-none" style={{ top: 'calc(var(--chrome-top, var(--safe-top, 0px)) + 9.15rem)' }}>
        {[
            { x: '38%', drop: 13, size: 9, color: PAL.gold },
            { x: '60%', drop: 22, size: 8, color: PAL.frame },
        ].map((c, i) => (
            <div key={i} className="absolute flex flex-col items-center origin-top" style={{ left: c.x, animation: `tama-sway ${6 + i * 1.5}s ease-in-out ${i * 0.8}s infinite alternate` }}>
                <span style={{ width: 1, height: c.drop, background: PAL.frameSoft }} />
                <span className="leading-none select-none" style={{ fontSize: c.size, color: c.color, opacity: 0.9 }}>✦</span>
            </div>
        ))}
    </div>
));

// ─── 角色（呼吸 / 游荡 / 戳一戳念聊天台词 / 夜间飘 Zzz），自治状态不外溢 ─
// nudge/say：家具就地交互的外部指令（走到家具旁 + 念缓存的反应台词），seq 变化才生效——
// 事件驱动的一次性 set，不引入任何常驻动画/interval，不破性能宪法。
const Actor = React.memo<{
    actorImg: string | undefined; night: boolean; pokeLines: string[]; unread: number; onChat: () => void;
    nudge?: { x: number; y: number; seq: number }; say?: { text: string; seq: number };
    /** 当前日程活动（跟随小人的状态小签，diegetic：信息长在世界里而非卡片里） */
    activity?: string;
    /** 一句心声：显示为头顶思绪光点，点开才展开成思绪云 */
    heartLine?: string;
}>(
    ({ actorImg, night, pokeLines, unread, onChat, nudge, say, activity, heartLine }) => {
        const [thoughtOpen, setThoughtOpen] = useState(false);
        const [pos, setPos] = useState({ x: 48, y: 80 });
        const [bounce, setBounce] = useState(false);
        const [pokeText, setPokeText] = useState('');
        const pokeIdx = useRef(0); // 台词按顺序循环（最新一条开始往回念）

        // 游荡：≥18s 一次性的 setTimeout 链（无 rAF / 无短 interval），夜里停下休息
        useEffect(() => {
            if (night) return;
            let t: ReturnType<typeof setTimeout>;
            const wander = () => {
                setPos({ x: 22 + Math.random() * 56, y: 70 + Math.random() * 22 });
                t = setTimeout(wander, 18000 + Math.random() * 22000);
            };
            t = setTimeout(wander, 15000);
            return () => clearTimeout(t);
        }, [night]);

        // 家具交互指令：走过去 + 念一句（气泡复用 pokeText 通道，优先级一致）
        useEffect(() => {
            if (nudge && nudge.seq > 0) setPos({ x: nudge.x, y: nudge.y });
        }, [nudge?.seq]);
        useEffect(() => {
            if (say && say.seq > 0 && say.text) {
                setPokeText(say.text);
                const t = setTimeout(() => setPokeText(''), 4200);
                return () => clearTimeout(t);
            }
        }, [say?.seq]);

        // 戳一戳的爱心迸射（趣味）：一次性 CSS 动画，飘完即卸；连戳攒 combo。
        const [hearts, setHearts] = useState<{ id: number; dx: number }[]>([]);
        const heartSeq = useRef(0);
        const comboRef = useRef({ n: 0, t: 0 });

        const poke = (e: React.MouseEvent) => {
            e.stopPropagation();
            setBounce(true);
            setTimeout(() => setBounce(false), 450);
            // 只复用角色真实说过的话。没有内容时保留戳戳动效，但绝不由主题冒充角色开口。
            if (pokeLines.length > 0) {
                setPokeText(pokeLines[pokeIdx.current % pokeLines.length]);
                pokeIdx.current += 1;
                setTimeout(() => setPokeText(''), 3200);
            } else {
                setPokeText('');
            }
            // 迸射 2-3 颗爱心（连戳越快越多，最多 5 颗）
            const nowT = performance.now?.() ?? 0;
            comboRef.current = nowT - comboRef.current.t < 900 ? { n: comboRef.current.n + 1, t: nowT } : { n: 1, t: nowT };
            const count = Math.min(5, 2 + Math.floor(comboRef.current.n / 2));
            const burst = Array.from({ length: count }, () => ({ id: heartSeq.current++, dx: Math.round((Math.random() - 0.5) * 44) }));
            setHearts(prev => [...prev, ...burst]);
            const ids = new Set(burst.map(b => b.id));
            setTimeout(() => setHearts(prev => prev.filter(h => !ids.has(h.id))), 1100);
        };

        // 气泡优先级：戳一戳台词 > 未读提醒
        const bubble = pokeText || (unread > 0 ? `♥ ${unread} 条新消息!` : '');
        const bubbleIsChat = !pokeText && unread > 0;

        return (
            <div onClick={poke}
                className="absolute cursor-pointer"
                style={{
                    left: `${pos.x}%`, top: `${pos.y}%`, width: '104px',
                    transform: 'translate(-50%, -100%)',
                    zIndex: Math.floor(pos.y) + 20,
                    transition: 'left 1.4s ease-in-out, top 1.4s ease-in-out',
                }}>
                <img src={actorImg} alt="" draggable={false} loading="lazy"
                    className="w-full h-auto object-contain select-none"
                    style={{
                        animation: bounce ? 'tama-bounce 0.45s ease-out' : (night ? 'none' : 'tama-breathe 3.2s ease-in-out infinite'),
                        willChange: 'transform',
                    }} />
                {night && (
                    <span className="absolute -top-4 right-0 text-[13px] font-bold select-none" style={{ fontFamily: FONT_PX, color: PAL.ink, animation: 'tama-zzz 2.6s ease-in-out infinite' }}>Zzz</span>
                )}

                {/* 戳一戳迸射的爱心（一次性上浮，飘完卸载） */}
                {hearts.map(h => (
                    <span key={h.id} className="absolute left-1/2 top-[30%] pointer-events-none leading-none"
                        style={{ color: PAL.hot, fontSize: 13, ['--dx' as any]: `${h.dx}px`, animation: 'tama-heart 1.05s ease-out forwards', textShadow: '0 0 6px var(--tg-hotglow60)' }}>♥</span>
                ))}

                {/* 思绪光点：ta 有心声时头顶飘一朵小云（点开才展开成思绪云；不点只是光点） */}
                {!night && heartLine && !bubble && !thoughtOpen && (
                    <button onClick={(e) => { e.stopPropagation(); setThoughtOpen(true); setTimeout(() => setThoughtOpen(false), 8000); }}
                        className="absolute -top-5 left-[62%] leading-none"
                        style={{ animation: 'tama-twinkle 2.2s ease-in-out infinite', filter: 'drop-shadow(0 0 6px var(--tg-hotglow60))' }}>
                        <svg viewBox="0 0 24 20" className="w-5 h-4" fill="#fff" stroke={PAL.hot} strokeWidth="1.6">
                            <ellipse cx="9" cy="8" rx="7" ry="5.5" />
                            <circle cx="16.5" cy="9.5" r="4" />
                            <circle cx="6" cy="16.5" r="1.6" />
                            <circle cx="3.4" cy="19" r="0.9" />
                        </svg>
                    </button>
                )}

                {/* 气泡「居中锚点」：left:50% + translateX(-50%) 静态放这层，绝不带动画——
                    动画（pop-in 用 transform:scale）放到内层子元素，避免 scale 覆盖掉居中
                    位移导致「先蹦到右边、再瞬移回中间」的抖动。 */}
                {thoughtOpen && heartLine && (
                    <div className="absolute bottom-[104%] left-1/2 z-[61]" style={{ transform: 'translateX(-50%)' }}>
                        <div onClick={(e) => { e.stopPropagation(); setThoughtOpen(false); }}
                            className="relative w-max max-w-[240px] px-3.5 py-2.5 rounded-[18px] animate-pop-in"
                            style={{ background: 'rgba(255,255,255,0.96)', border: `2px dashed ${PAPER.line}`, boxShadow: '0 4px 14px var(--tg-glow35)', transformOrigin: 'bottom center' }}>
                            <p className="text-[10px] leading-[1.7] break-words" style={{ fontFamily: FONT_CN, color: PAPER.hi, fontStyle: 'italic' }}>{heartLine}</p>
                            <span className="absolute -bottom-2 left-[38%] w-2.5 h-2.5 rounded-full" style={{ background: 'rgba(255,255,255,0.96)', border: `1.5px dashed ${PAPER.line}` }} />
                            <span className="absolute -bottom-4 left-[32%] w-1.5 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.96)', border: `1px dashed ${PAPER.line}` }} />
                        </div>
                    </div>
                )}

                {bubble && (
                    <div className="absolute bottom-[102%] left-1/2 z-[60]" style={{ transform: 'translateX(-50%)' }}>
                        <div onClick={(e) => { if (bubbleIsChat) { e.stopPropagation(); onChat(); } }}
                            className="relative w-max max-w-[230px] px-3 py-1.5 rounded-xl rounded-bl-none animate-pop-in"
                            style={{ background: PAPER.cream, border: `2px solid ${PAPER.line}`, boxShadow: '0 3px 10px var(--tg-glow25)', transformOrigin: 'bottom center' }}>
                            <p className="text-[10px] font-bold leading-snug break-words" style={{ fontFamily: FONT_PX, color: PAPER.ink }}>{bubble}</p>
                        </div>
                    </div>
                )}

                {/* 状态小签：ta 此刻在做什么（跟着小人走，游戏 NPC 头顶状态那味儿） */}
                {activity && !night && (
                    <div className="absolute top-[101%] left-1/2 whitespace-nowrap pointer-events-none" style={{ transform: 'translateX(-50%)' }}>
                        <div className="px-2 py-[2px] rounded-full" style={{ background: 'rgba(255,255,255,0.85)', border: `1.5px solid ${PAPER.lineSoft}`, boxShadow: '0 2px 6px var(--tg-glow16)' }}>
                            <span className="text-[8.5px] font-bold" style={{ fontFamily: FONT_CN, color: PAPER.ink }}>{activity}</span>
                        </div>
                    </div>
                )}
            </div>
        );
    }
);

// ─── 满屏小屋（diegetic：屏幕即房间，信息长在世界里而非卡片里）─────────
// 等比例缩放：家具/小人是「位置百分比 + 尺寸固定像素」，按固定 390 宽虚拟画布
// 原样渲染再整体 transform:scale——墙/地板/家具/小人一起缩，与小屋 App 全屏一致；
// 高度跟随屏幕（同全屏舞台行为）。就地交互：点家具走过去看、戳小人念台词。
const STAGE_W = 390;
const FullStage = React.memo<{
    items: RoomItem[]; wallStyle: string; floorStyle: string;
    actorImg: string | undefined; night: boolean; pokeLines: string[]; unread: number;
    activity: string; heartLine: string;
    nudge?: { x: number; y: number; seq: number }; say?: { text: string; seq: number };
    onItemTap: (item: RoomItem) => void; onChat: () => void;
}>(({ items, wallStyle, floorStyle, actorImg, night, pokeLines, unread, activity, heartLine, nudge, say, onItemTap, onChat }) => {
    const boxRef = useRef<HTMLDivElement>(null);
    const [box, setBox] = useState({ w: 0, h: 0 });
    useEffect(() => {
        const el = boxRef.current;
        if (!el) return;
        const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const scale = box.w > 0 ? box.w / STAGE_W : 0;
    const canvasH = scale > 0 ? box.h / scale : 0;
    return (
        <div ref={boxRef} className="absolute inset-0 overflow-hidden" style={{ contain: 'layout paint' }}>
            {scale > 0 && (
                <div className="absolute top-0 left-0" style={{ width: STAGE_W, height: canvasH, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
                    {/* 墙 / 地板（与 RoomApp 同分割线） */}
                    <div className="absolute top-0 left-0 w-full h-[65%] z-0" style={{ background: wallStyle }} />
                    <div className="absolute bottom-0 left-0 w-full h-[35%] z-0" style={{ background: floorStyle }} />
                    <div className="absolute top-[65%] w-full h-6 bg-gradient-to-b from-black/10 to-transparent pointer-events-none z-0" />

                    {items.map(item => <StageItem key={item.id} item={item} onTap={onItemTap} />)}

                    <Actor actorImg={actorImg} night={night} pokeLines={pokeLines} unread={unread} onChat={onChat}
                        nudge={nudge} say={say} activity={activity} heartLine={heartLine} />
                </div>
            )}
        </div>
    );
});

// ─── 墙上的日程挂牌：写着 ta 此刻在干嘛；点开垂下当日全程卷轴 ────────
// 跟随界面风格（细线半透卡 + 内描边），端端正正不摇晃。
const HangingSign = React.memo<{ text: string; onTap: () => void }>(({ text, onTap }) => (
    <div className="absolute left-[6%] z-[30] flex flex-col items-center pointer-events-none"
        style={{ top: 'calc(var(--chrome-top, var(--safe-top, 0px)) + 9.15rem)' }}>
        {/* 两根吊绳（挂在顶部横幅正下方，不悬空） */}
        <div className="flex gap-6">
            <span style={{ width: 1.5, height: 24, background: PAL.frameSoft }} />
            <span style={{ width: 1.5, height: 24, background: PAL.frameSoft }} />
        </div>
        <button onClick={onTap}
            className="pointer-events-auto active:scale-95 relative px-3.5 py-2 rounded-xl -mt-px transition-transform"
            style={{
                background: PAL.card,
                border: `1.5px solid ${PAL.frameSoft}`,
                boxShadow: '0 4px 12px var(--tg-glow25)',
            }}>
            <span className="absolute inset-[3px] rounded-[0.6rem] pointer-events-none" style={{ border: '1px solid var(--tg-frame-a22)' }} />
            <span className="absolute top-[2px] right-[5px] text-[7px] pointer-events-none" style={{ color: PAL.frame, opacity: 0.7 }}>✦</span>
            <span className="text-[10px] font-bold whitespace-nowrap" style={{ fontFamily: FONT_CN, color: PAL.grape }}>{text}</span>
        </button>
    </div>
));

// ─── 当日全程卷轴（点挂牌垂下来）；每个时段可「偷看」调 API 演一段小剧场 ────
// 跟随界面风格：细线半透强卡 + 内描边 + 星芒标题
const DayScroll = React.memo<{ slots: { time: string; text: string; passed: boolean; current: boolean }[]; onPeek: (i: number) => void; onClose: () => void }>(({ slots, onPeek, onClose }) => (
    <>
        <div className="absolute inset-0 z-[85]" onClick={onClose} />
        <div className="absolute left-4 right-[22%] z-[86] rounded-2xl px-4 pt-3 pb-4 animate-pop-in"
            style={{
                top: 'calc(var(--chrome-top, var(--safe-top, 0px)) + 12.6rem)',
                background: PAL.cardHi,
                border: `1.5px solid ${PAL.frameSoft}`,
                boxShadow: '0 10px 26px var(--tg-glow35)',
            }}>
            <div className="absolute inset-[4px] rounded-[0.85rem] pointer-events-none" style={{ border: '1px solid var(--tg-frame-a22)' }} />
            <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-bold" style={{ fontFamily: FONT_CN, color: PAL.grape }}>今天的一天 ✦</span>
                <button onClick={onClose} className="px-1" style={{ color: PAL.fade }}>×</button>
            </div>
            {slots.length > 0 ? (
                <div className="space-y-1 max-h-[42vh] overflow-y-auto no-scrollbar">
                    {slots.map((s, i) => (
                        <div key={i} className="flex items-center gap-2 py-0.5">
                            <span className="text-[9px] tabular-nums shrink-0" style={{ fontFamily: FONT_PX, color: s.passed ? PAL.ink : PAL.fade }}>{s.time}</span>
                            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: s.current ? PAL.hot : (s.passed ? PAL.ink : 'var(--tg-frame-a30)') }} />
                            <span className="flex-1 text-[10.5px] leading-relaxed" style={{ fontFamily: FONT_CN, color: s.passed ? PAL.grape : PAL.fade }}>{s.text}</span>
                            {/* 偷看这一刻：调 API 演一段角色行为（小剧场） */}
                            <button onClick={() => onPeek(i)} className="shrink-0 px-2 py-[3px] rounded-full text-[9px] font-bold active:scale-95"
                                style={{ background: s.current ? `linear-gradient(135deg, ${PAL.pink}, ${PAL.hot})` : PAL.card, color: s.current ? '#fff' : PAL.grape, border: `1.5px solid ${s.current ? 'transparent' : PAL.frameSoft}`, fontFamily: FONT_CN }}>
                                偷看
                            </button>
                        </div>
                    ))}
                </div>
            ) : (
                <p className="text-[10px] leading-relaxed" style={{ fontFamily: FONT_CN, color: PAL.fade }}>今天的日程还没生成——去聊两句，ta 的一天就会长出来。</p>
            )}
        </div>
    </>
));

// ─── 右侧世界之门：家园 / 彼方 / 梦境——细线胶囊，跟随界面风格 + ◆连饰 ───
const WorldPortals = React.memo<{ onHome: () => void; onKanata: () => void; onDream: () => void }>(({ onHome, onKanata, onDream }) => {
    const portals = [
        { key: 'home', label: '家园', en: 'HOME', icon: ICON.door, onClick: onHome },
        { key: 'kanata', label: '彼方', en: 'KANATA', icon: <Icons.VRWorld className="w-full h-full" />, onClick: onKanata },
        { key: 'dream', label: '梦境', en: 'DREAM', icon: ICON.moon, onClick: onDream },
    ];
    return (
        <div className="absolute right-3 z-[35] flex flex-col items-center" style={{ top: 'calc(var(--chrome-top, var(--safe-top, 0px)) + 10rem)' }}>
            {portals.map((p, i) => (
                <React.Fragment key={p.key}>
                    {i > 0 && (
                        <div className="flex flex-col items-center py-0.5 pointer-events-none">
                            <span style={{ width: 1, height: 7, background: PAL.frameSoft }} />
                            <span className="text-[6px] leading-none my-0.5" style={{ color: PAL.frame }}>◆</span>
                            <span style={{ width: 1, height: 7, background: PAL.frameSoft }} />
                        </div>
                    )}
                    <button onClick={p.onClick}
                        className="relative w-[3.1rem] py-2.5 rounded-full flex flex-col items-center gap-1 active:scale-95 transition-transform"
                        style={{ background: PAL.card, border: `1.5px solid ${PAL.frameSoft}`, boxShadow: '0 4px 12px var(--tg-glow25)' }}>
                        <span className="absolute inset-[3px] rounded-full pointer-events-none" style={{ border: '1px solid var(--tg-frame-a22)' }} />
                        <span className="w-[17px] h-[17px]" style={{ color: PAL.frame }}>{p.icon}</span>
                        <span className="text-[10px] leading-none" style={{ fontFamily: FONT_CN, color: PAL.grape }}>{p.label}</span>
                        <span className="text-[5.5px] font-bold leading-none" style={{ fontFamily: FONT_PX, color: PAL.fade, letterSpacing: '0.16em' }}>{p.en}</span>
                    </button>
                </React.Fragment>
            ))}
        </div>
    );
});

// ─── 地板上的手机：ta 的手机躺在屏幕角落，有未读会亮；点开小弹窗、一键去回 ─
const FloorPhone = React.memo<{ unread: number; open: boolean; msgs: { id: number; mine: boolean; text: string }[]; onToggle: () => void; onChat: () => void }>(
    ({ unread, open, msgs, onToggle, onChat }) => (
        <>
            <button onClick={onToggle} aria-label="ta 的手机"
                className="absolute left-4 z-[30] active:scale-90 transition-transform"
                style={{ bottom: 'calc(var(--safe-bottom, 0px) + 7.6rem)' }}>
                <div className="relative w-9 h-12 rounded-[10px] p-[3px] rotate-[-8deg]"
                    style={{
                        background: `linear-gradient(160deg, ${PAL.night}, #575083)`,
                        border: '2.5px solid rgba(255,255,255,0.9)',
                        boxShadow: unread > 0 ? '0 4px 14px var(--tg-hotglow60)' : '0 3px 8px var(--tg-glow25)',
                    }}>
                    {/* 手机屏幕（纯样式，无 emoji）：有未读时屏上亮一条粉光 */}
                    <div className="w-full h-full rounded-[6px] flex flex-col items-center justify-center gap-[3px]"
                        style={{ background: unread > 0 ? `linear-gradient(160deg, ${PAL.pink}, ${PAL.hot})` : 'rgba(255,255,255,0.14)', animation: unread > 0 ? 'tama-twinkle 1.6s ease-in-out infinite' : undefined }}>
                        <span className="w-4 h-[2px] rounded-full" style={{ background: unread > 0 ? '#fff' : 'rgba(255,255,255,0.5)' }} />
                        <span className="w-3 h-[2px] rounded-full" style={{ background: unread > 0 ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.4)' }} />
                    </div>
                    {unread > 0 && (
                        <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-[16px] px-1 rounded-full flex items-center justify-center text-[9px] font-bold text-white"
                            style={{ background: PAL.hot, border: '1.5px solid #fff' }}>{unread > 99 ? '99+' : unread}</span>
                    )}
                </div>
            </button>
            {open && (
                <>
                    <div className="absolute inset-0 z-[85]" onClick={onToggle} />
                    <div className="absolute left-4 right-[24%] z-[86] rounded-2xl px-3.5 py-3 animate-pop-in"
                        style={{
                            bottom: 'calc(var(--safe-bottom, 0px) + 11rem)',
                            background: 'rgba(255,255,255,0.96)', border: `2px solid ${PAPER.line}`, boxShadow: '0 10px 26px var(--tg-glow35)',
                        }}>
                        {msgs.length > 0 ? (
                            <div className="space-y-1.5 mb-2.5">
                                {msgs.map(m => (
                                    <div key={m.id} className={`flex ${m.mine ? 'justify-end' : 'justify-start'}`}>
                                        <div className="max-w-[85%] px-2.5 py-1.5 rounded-xl text-[10.5px] leading-relaxed"
                                            style={m.mine
                                                ? { background: `linear-gradient(135deg, #a8b8e8, #f4a6cc)`, color: '#fff', borderBottomRightRadius: 4, fontFamily: FONT_CN }
                                                : { background: PAPER.cream, color: PAPER.ink, border: `1.5px solid ${PAPER.lineSoft}`, borderBottomLeftRadius: 4, fontFamily: FONT_CN }}>
                                            {m.text}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="text-[10px] mb-2.5" style={{ fontFamily: FONT_CN, color: PAPER.dim }}>还没聊过天，说点什么吧。</p>
                        )}
                        <button onClick={onChat} className="w-full flex items-center gap-2 px-3 py-2 rounded-xl active:scale-[0.99] transition-transform"
                            style={{ background: PAPER.cream, border: `2px solid ${PAPER.lineSoft}` }}>
                            <span className="flex-1 text-left text-[10.5px]" style={{ color: PAPER.dim, fontFamily: FONT_CN }}>回点什么…</span>
                            <span className="w-5.5 h-5.5 w-6 h-6 rounded-full flex items-center justify-center shrink-0"
                                style={{ background: `linear-gradient(135deg, #f4a6cc, ${PAPER.hot})` }}>
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#fff" className="w-3 h-3"><path d="M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z" /></svg>
                            </span>
                        </button>
                    </div>
                </>
            )}
        </>
    )
);

// ─── 底部五键 dock（CARE / TALK / HOME / ALBUM / SETTINGS）──────────
// 图标一律 currentColor：扁平手绘风里图标用描边同色，不用白色
const DOCK_GLYPHS: Record<string, React.ReactNode> = {
    heart: <svg viewBox="0 0 24 24" className="w-full h-full" fill="currentColor"><path d="M12 21s-7.5-4.9-9.8-9.2C.7 8.9 2.4 5.4 5.7 5.1c1.9-.2 3.7.8 4.7 2.4h3.2c1-1.6 2.8-2.6 4.7-2.4 3.3.3 5 3.8 3.5 6.7C19.5 16.1 12 21 12 21z" transform="scale(0.92) translate(1,1)" /></svg>,
    neural: <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="7" r="3" /><circle cx="5" cy="17" r="2" /><circle cx="19" cy="17" r="2" /><path d="M10 9.5 6.3 15M14 9.5l3.7 5.5M7 17h10" /></svg>,
    talk: <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3c-1.4 0-2.8-.3-4-.9L3 20l1.2-4.3a8 8 0 0 1-1.2-4.2A8.4 8.4 0 0 1 11.5 3.2 8.4 8.4 0 0 1 21 11.5z" /><circle cx="8.5" cy="11.5" r="0.6" fill="currentColor" /><circle cx="12" cy="11.5" r="0.6" fill="currentColor" /><circle cx="15.5" cy="11.5" r="0.6" fill="currentColor" /></svg>,
    home: <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10v9h13v-9" /><path d="M10 19v-5h4v5" /></svg>,
    album: <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3.5" width="16" height="17" rx="2.5" /><path d="M8 3.5v17" /><path d="M14.2 8.4l.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z" fill="currentColor" stroke="none" /></svg>,
    gear: <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.5a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.5h4l.4-2.5a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" /></svg>,
    star: <svg viewBox="0 0 24 24" className="w-full h-full" fill="currentColor"><path d="M12 2.6l2.5 5.7 6.2.6-4.7 4.1 1.4 6.1L12 16l-5.4 3.1 1.4-6.1-4.7-4.1 6.2-.6z" /></svg>,
};

// 报头/世界化入口用的线描图标（全 SVG，杜绝 emoji）
const ICON = {
    palette: <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3a9 9 0 1 0 0 18c1 0 1.6-.8 1.6-1.6 0-.5-.2-.8-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-3.9-4-7.4-9-7.4Z" /><circle cx="7.5" cy="11" r="1" fill="currentColor" stroke="none" /><circle cx="10.5" cy="7.5" r="1" fill="currentColor" stroke="none" /><circle cx="14.5" cy="7.5" r="1" fill="currentColor" stroke="none" /><circle cx="17" cy="11" r="1" fill="currentColor" stroke="none" /></svg>,
    door: <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M5 21V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v17" /><path d="M3 21h18" /><circle cx="13" cy="12" r="0.9" fill="currentColor" stroke="none" /></svg>,
    tv: <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><rect x="3" y="7" width="18" height="12" rx="2" /><path d="M8 3l4 4 4-4" /><path d="M17 11v4" /></svg>,
    moon: <svg viewBox="0 0 24 24" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M20 13.5A8 8 0 1 1 10.5 4a6.3 6.3 0 0 0 9.5 9.5Z" /></svg>,
};

// 高级细线 dock 键（参考稿）：线描图标 + 中文 + 英文小标，无底色块——贵在克制
const DockBtn: React.FC<{ glyph: React.ReactNode; cn: string; en: string; badge?: number; onClick: () => void }> = ({ glyph, cn, en, badge = 0, onClick }) => (
    <button onClick={onClick} className="relative flex flex-col items-center gap-1 w-[3.4rem] active:scale-90 transition-transform">
        <div className="relative w-6 h-6" style={{ color: PAL.frame }}>
            {glyph}
            {badge > 0 && (
                <span className="absolute -top-1.5 -right-2.5 min-w-[15px] h-[15px] px-0.5 rounded-full flex items-center justify-center text-[8px] font-bold text-white"
                    style={{ background: PAL.hot, border: `1px solid ${PAL.cardHi}` }}>{badge > 99 ? '99' : badge}</span>
            )}
        </div>
        <div className="flex flex-col items-center leading-none gap-[3px]">
            <span className="text-[11px]" style={{ fontFamily: FONT_CN, color: PAL.grape }}>{cn}</span>
            <span className="text-[6px] font-bold" style={{ fontFamily: FONT_PX, color: PAL.fade, letterSpacing: '0.16em' }}>{en}</span>
        </div>
    </button>
);

// ─── 主组件 ───────────────────────────────────────────────────
const TamagotchiHome: React.FC = () => {
    const { openApp, characters, activeCharacterId, setActiveCharacterId, virtualTime, unreadMessages, isDataLoaded, lastMsgTimestamp, addToast, userProfile, apiConfig } = useOS();
    const char: CharacterProfile | null = useMemo(
        () => characters.find(c => c.id === activeCharacterId) || characters[0] || null,
        [characters, activeCharacterId]
    );
    const charDateKey = useLocalDateKey(resolveCharTimeZone(char));

    const [stat, setStat] = useState<{ msgCount: number; pokeLines: string[]; recent: { id: number; mine: boolean; text: string }[] }>({ msgCount: 0, pokeLines: [], recent: [] });
    const [drawerOpen, setDrawerOpen] = useState(false);
    // 今日日程（当前日程卡 + 心声兜底）：一天一份，进屏取一次
    const [schedule, setSchedule] = useState<DailySchedule | null>(null);
    // 一句心声：localStorage 读取放进 state，避免 virtualTime 每秒 re-render 都同步读盘
    const [heartLine, setHeartLine] = useState('');
    // 家具就地交互：走过去(nudge) + 念反应(say) + 观察旁白（seq 事件驱动，无常驻动画）
    const [nudge, setNudge] = useState<{ x: number; y: number; seq: number }>({ x: 48, y: 80, seq: 0 });
    const [say, setSay] = useState<{ text: string; seq: number }>({ text: '', seq: 0 });
    const [observation, setObservation] = useState('');
    // 世界化挂件的开合：日程纸卷（点墙上木牌）/ 地板手机弹窗
    const [scrollOpen, setScrollOpen] = useState(false);
    const [phoneOpen, setPhoneOpen] = useState(false);
    // 直播看板自定义图：blob 存库，localStorage 只记 blobref 令牌（全局一张，跨角色共用）
    const boardInputRef = useRef<HTMLInputElement>(null);
    const [boardImg, setBoardImg] = useState('');
    const onBoardFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        const charId = char?.id;
        if (!charId) return;
        try {
            const blob = await processImageToBlob(file, { quality: 0.92, maxWidth: 1200 });
            const ref = await putImageBlob(blob);
            setBoardImg(ref);
            try { localStorage.setItem(`tama_board_img_${charId}`, ref); } catch { /* 存不进也能用到刷新前 */ }
            addToast('看板图已更新 ✦', 'success');
        } catch (err: any) {
            addToast(err?.message || '图片处理失败', 'error');
        }
    }, [addToast, char?.id]);
    const clearBoardImg = useCallback(() => {
        setBoardImg('');
        if (char) try { localStorage.removeItem(`tama_board_img_${char.id}`); } catch { /* ignore */ }
        // 旧 blob 不主动删（见 blobRef 注释的防碎图策略），交给后续 GC
    }, [char?.id]);
    // 看板排版层文字色（有自定义图时生效，默认白）：原生取色器，选完即存
    const boardColorRef = useRef<HTMLInputElement>(null);
    const [boardFg, setBoardFg] = useState(''); // 空=自动（暗板白字/浅板深字）
    const onBoardColor = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const v = e.target.value || '#ffffff';
        setBoardFg(v);
        if (char) try { localStorage.setItem(`tama_board_fg_${char.id}`, v); } catch { /* ignore */ }
    }, [char?.id]);
    // 日程详细演绎（小剧场）：点纸卷里「偷看此刻」时生成并播放
    const [theater, setTheater] = useState<{ schedule: DailySchedule; slotIndex: number } | null>(null);
    const [theaterGenerating, setTheaterGenerating] = useState(false);
    const [devDebugVisible, setDevDebugVisible] = useState(() => isDevDebugAvailable());
    useEffect(() => subscribeDevDebugAvailability(setDevDebugVisible), []);

    // 界面风格：localStorage 持久化（皮肤内偏好，不动 OS theme）；默认 星云紫，
    // 兼容旧版单色相偏好（tama_accent_hue → 亮色自定义）
    const [style, setStyle] = useState<TgStyle>(() => {
        try {
            const raw = localStorage.getItem(STYLE_KEY);
            if (raw) {
                const p = JSON.parse(raw);
                if (typeof p?.hue === 'number') return { id: p.id || 'custom', name: p.name || '自定义', hue: p.hue, dark: !!p.dark, gold: !!p.gold, mute: !!p.mute };
            }
            const legacy = localStorage.getItem(LEGACY_HUE_KEY);
            const n = legacy === null ? NaN : parseInt(legacy, 10);
            if (Number.isFinite(n)) return { id: 'custom', name: '自定义', hue: ((n % 360) + 360) % 360, dark: false, gold: false, mute: false };
        } catch { /* 解析失败走默认 */ }
        return SCHEMES[0];
    });
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [extracting, setExtracting] = useState(false);
    const applyStyle = useCallback((s: TgStyle) => {
        setStyle(s);
        try { localStorage.setItem(STYLE_KEY, JSON.stringify(s)); } catch { /* 私密模式等场景失败无妨 */ }
    }, []);
    const rootVars = useMemo(() => makeVars(style), [style]);

    useEffect(() => {
        if (!char) {
            setBoardImg('');
            setBoardFg('');
            return;
        }
        try {
            const imgKey = `tama_board_img_${char.id}`;
            const fgKey = `tama_board_fg_${char.id}`;
            let img = localStorage.getItem(imgKey);
            let fg = localStorage.getItem(fgKey);

            // 旧版是全角色共用；升级后只迁给当前角色一次。
            if (img === null) {
                img = localStorage.getItem('tama_board_img');
                if (img) localStorage.setItem(imgKey, img);
                localStorage.removeItem('tama_board_img');
            }
            if (fg === null) {
                fg = localStorage.getItem('tama_board_fg');
                if (fg) localStorage.setItem(fgKey, fg);
                localStorage.removeItem('tama_board_fg');
            }
            setBoardImg(img || '');
            setBoardFg(fg || '');
        } catch {
            setBoardImg('');
            setBoardFg('');
        }
    }, [char?.id]);

    // 取数：消息数（Lv/经验条）+ ta 最近 30 条文字回复（戳一戳台词，最新在前按顺序循环）
    // + 消息卡的最近 3 条文本气泡预览（同一次查询顺手带出，不多读一次库）
    useEffect(() => {
        if (!isDataLoaded || !char) { setStat({ msgCount: 0, pokeLines: [], recent: [] }); return; }
        let cancelled = false;
        DB.getMessagesByCharId(char.id).then(msgs => {
            if (cancelled) return;
            const visible = msgs.filter(isChatPreviewMessage);
            const lines = visible
                .filter(m => m.role === 'assistant')
                .map(m => m.content.replace(/\[.*?\]/g, '').trim())
                .filter(t => t.length > 0)
                .slice(-30)
                .reverse()
                .map(t => t.length > 42 ? t.slice(0, 42) + '…' : t);
            const recent = visible
                .filter(m => (m.role === 'user' || m.role === 'assistant') && (!m.type || m.type === 'text') && typeof m.content === 'string' && m.content.trim())
                .slice(-3)
                .map(m => ({
                    id: m.id,
                    mine: m.role === 'user',
                    text: m.content.length > 56 ? m.content.slice(0, 56) + '…' : m.content,
                }));
            setStat({ msgCount: msgs.filter(m => m.role !== 'system').length, pokeLines: lines, recent });
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [char?.id, lastMsgTimestamp, isDataLoaded]);

    // 今日日程：换角色 / 有新消息（聊天会触发生成）时刷一次
    useEffect(() => {
        if (!char) { setSchedule(null); return; }
        getDailyScheduleForChar(char).then(s => setSchedule(s || null)).catch(() => setSchedule(null));
    }, [char?.id, char?.customTimezoneEnabled, char?.customTimezone, lastMsgTimestamp, charDateKey]);

    // 一句心声：innerState（情绪评估落的）→ 日程意识流 → 占位
    useEffect(() => {
        if (!char) { setHeartLine('新的一天。'); return; }
        const inner = getLastInnerState(char.id);
        const flow = schedule?.flowNarrative?.[getFlowNarrativeKey(getScheduleWallClock(char).getHours())] || '';
        setHeartLine(inner || flow || '新的一天。');
    }, [char?.id, char?.customTimezoneEnabled, char?.customTimezone, lastMsgTimestamp, schedule]);

    // 桌面小屋只做本地展示交互：走过去 + 念一句 + 观察旁白。
    // 只有真正进入 RoomApp 后发生的家具互动才写入私聊上下文。
    const onItemTap = useCallback((item: RoomItem) => {
        if (!char) return;
        const saved = (char.savedRoomState?.items || {}) as Record<string, { description?: string; reaction?: string }>;
        const cached = saved[item.id] || saved[item.name];
        const reaction = cached?.reaction || '(盯…)';
        const desc = cached?.description || `${item.name}静静地摆在那里。`;
        setNudge(p => ({ x: item.x, y: Math.min(92, Math.max(FLOOR_HORIZON + 5, item.y + 5)), seq: p.seq + 1 }));
        setSay(p => ({ text: reaction.length > 64 ? reaction.slice(0, 64) + '…' : reaction, seq: p.seq + 1 }));
        setObservation(desc);
    }, [char]);

    // 小屋数据：优先角色 roomConfig，兜底镜像样板房（见文件头注释）
    const isSully = char?.id === 'preset-sully-v2' || char?.name === 'Sully';
    const items = useMemo<RoomItem[]>(() => {
        const saved = char?.roomConfig?.items;
        if (saved && saved.length > 0) return saved;
        return isSully ? FALLBACK_SULLY : FALLBACK_DEFAULT;
    }, [char?.roomConfig?.items, isSully]);

    // blobref 令牌 → 可渲染 url（hook 需无条件顶层调用）
    const wallImg = useBlobRefUrl(char?.roomConfig?.wallImage);
    const floorImg = useBlobRefUrl(char?.roomConfig?.floorImage);
    const actorImg = useBlobRefUrl(char?.sprites?.['chibi'] || char?.avatar);
    const wallStyle = getBgStyle(wallImg, char?.roomConfig?.wallScale, char?.roomConfig?.wallRepeat, FALLBACK_WALL);
    const floorStyle = getBgStyle(floorImg, char?.roomConfig?.floorScale, char?.roomConfig?.floorRepeat, FALLBACK_FLOOR);

    // 「提取小窝主色」：依次尝试 墙纸→地板→立绘（图片走 canvas 采样，渐变串直接解析色值）；
    // 只换色相，保留当前方案的明暗/压饱和基调（金线换成取到的颜色）
    const extractRoomHue = useCallback(async () => {
        if (extracting) return;
        setExtracting(true);
        try {
            for (const cand of [wallImg, floorImg, actorImg]) {
                if (!cand) continue;
                const isUrl = cand.startsWith('http') || cand.startsWith('data') || cand.startsWith('blob:');
                const h = isUrl ? await hueFromImage(cand) : hueFromGradient(cand);
                if (h !== null) {
                    applyStyle({ ...style, id: 'custom', name: '小窝色', hue: ((Math.round(h) % 360) + 360) % 360, gold: false, mute: false });
                    addToast('已提取小窝主色 ✦', 'success');
                    return;
                }
            }
            addToast('没提取到明显的主色，试试选个方案', 'info');
        } finally {
            setExtracting(false);
        }
    }, [wallImg, floorImg, actorImg, extracting, style, applyStyle, addToast]);

    // 「角色睡没睡」是 ta 那边的作息，按角色时区判；下面 hh/mm 是给用户看的钟，仍走设备时间。
    // 同文件的心声（getScheduleWallClock）和墙上木牌（getCurrentScheduleSlotIndex）本就按角色时区算，
    // 这里若用设备钟，会出现小人头顶飘 Zzz、木牌上却写着「11:00 工作」。
    const night = isNightHour(getScheduleWallClock(char).getHours());
    const hh = virtualTime.hours.toString().padStart(2, '0');
    const mm = virtualTime.minutes.toString().padStart(2, '0');
    const { level, exp, expMax } = deriveStats(stat.msgCount);

    // 世界化挂件的展示串（纯字符串/原始值 props → memo 组件只在内容真变时 reconcile）
    const currentSlotIndex = schedule ? getCurrentScheduleSlotIndex(schedule.slots, char) : -1;
    const curSlot = schedule && currentSlotIndex >= 0 ? schedule.slots[currentSlotIndex] : null;
    const nextSlot = schedule
        ? schedule.slots[currentSlotIndex >= 0 ? currentSlotIndex + 1 : 0] || null
        : null;
    // 小人脚下的状态小签：ta 此刻在干嘛
    // 状态小签只放活动名（不带 schedule 自带的 emoji，保持桌面清爽）
    const actorActivity = curSlot ? curSlot.activity : '';
    // 墙上木牌：当前时段；还没开始/没日程给引导文案
    const signText = curSlot
        ? `${curSlot.startTime} · ${curSlot.activity}`
        : (schedule ? `稍后 · ${nextSlot?.activity || '…'}（${nextSlot?.startTime || ''}）` : '今天想做什么？');
    // 纸卷：当日全程
    const scrollSlots = useMemo(() => (schedule?.slots || []).map(s => ({
        time: s.startTime,
        text: `${s.emoji ? s.emoji + ' ' : ''}${s.activity}${s.location ? `（${s.location}）` : ''}`,
        passed: curSlot ? s.startTime <= curSlot.startTime : false,
        current: !!curSlot && s.startTime === curSlot.startTime,
    })), [schedule, curSlot?.startTime]);
    const charUnread = char ? (unreadMessages[char.id] || 0) : 0;

    const openRoom = useCallback(() => openApp(AppID.Room), [openApp]);
    const openChat = useCallback(() => openApp(AppID.Chat), [openApp]);
    // 世界化入口：带意图打开小屋 App（RoomApp 挂载时消费，落到对应分区 / 开梦境）
    const openHomeland = useCallback(() => { roomLaunch.request({ tab: 'worldHome' }); openApp(AppID.Room); }, [openApp]);
    const openKanata = useCallback(() => openApp(AppID.VRWorld), [openApp]);
    const openDream = useCallback(() => { if (char) { roomLaunch.request({ charId: char.id, openDream: true }); openApp(AppID.Room); } }, [char, openApp]);
    const switchChar = useCallback(() => {
        if (characters.length < 2 || !char) return;
        const idx = characters.findIndex(c => c.id === char.id);
        setActiveCharacterId(characters[(idx + 1) % characters.length].id);
    }, [characters, char, setActiveCharacterId]);

    // 日程详细演绎（小剧场）：偷看某个时段，调 API 生成一段角色行为演出。
    const runTheater = useCallback(async (slotIndex: number, force = false) => {
        if (!char || !schedule) return;
        setTheater({ schedule, slotIndex });
        setScrollOpen(false);
        setTheaterGenerating(true);
        try {
            const updated = await generateSlotTheater(char, userProfile, schedule, slotIndex, apiConfig, force);
            if (updated) { setSchedule(updated); setTheater({ schedule: updated, slotIndex }); }
        } catch (e) {
            console.warn('[Gotchi] theater gen failed:', e);
        } finally {
            setTheaterGenerating(false);
        }
    }, [char, schedule, userProfile, apiConfig]);

    const drawerApps = useMemo(
        () => INSTALLED_APPS.filter(a => a.id !== AppID.CharCreatorDev || devDebugVisible),
        [devDebugVisible]
    );

    return (
        <div className="h-full w-full relative z-10 overflow-hidden select-none"
            style={{ ...rootVars, color: PAL.ink, fontFamily: FONT_CN }}>
            {/* 本皮肤专用 keyframes（只碰 transform/opacity） */}
            <style>{`
                @keyframes tama-breathe { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
                @keyframes tama-bounce { 0% { transform: scale(1); } 35% { transform: scale(1.12, 0.9); } 70% { transform: scale(0.95, 1.06); } 100% { transform: scale(1); } }
                @keyframes tama-zzz { 0%,100% { opacity: 0.35; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-4px); } }
                @keyframes tama-twinkle { 0%,100% { opacity: 0.25; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.1); } }
                @keyframes tama-sway { 0% { transform: rotate(-3deg); } 100% { transform: rotate(3deg); } }
                @keyframes tama-heart { 0% { opacity: 0; transform: translate(-50%, 0) scale(0.5); } 25% { opacity: 1; } 100% { opacity: 0; transform: translate(calc(-50% + var(--dx, 0px)), -46px) scale(1.1); } }
            `}</style>

            {/* ===== 报头（高级横幅，参考稿）：细线环头像 · 衬线名字 · Lv·时间 · 经验条 · 调色/通话圆钮 ===== */}
            <div className="absolute top-0 inset-x-0 z-[40] px-3" style={{ paddingTop: 'calc(var(--chrome-top, var(--safe-top, 0px)) + 0.7rem)' }}>
                {char ? (
                    <div className="relative flex items-center gap-3 rounded-[1.4rem] pl-2 pr-2.5 py-2"
                        style={{ background: PAL.card, border: `1.5px solid ${PAL.frameSoft}`, boxShadow: '0 5px 16px var(--tg-glow25)' }}>
                        {/* 内描边细框 + 卡内星芒 */}
                        <div className="absolute inset-[4px] rounded-[1.15rem] pointer-events-none" style={{ border: '1px solid var(--tg-frame-a22)' }} />
                        <Sparkles items={[[62, 16, 8, PAL.frame, 0.75, true], [50, 82, 7, PAL.frame, 0.5], [74, 60, 7, PAL.frame, 0.45, true]]} />
                        <button onClick={switchChar} className={`relative w-[46px] h-[46px] rounded-full p-[2px] shrink-0 ${characters.length > 1 ? 'active:scale-90 transition-transform' : ''}`}
                            style={{ border: `1.5px solid ${PAL.frame}`, boxShadow: '0 0 10px var(--tg-frame-a30)' }}>
                            <div className="w-full h-full rounded-full overflow-hidden" style={{ background: PAL.cardHi }}>
                                <TokenImg value={char.avatar} className="w-full h-full object-cover" alt="" loading="lazy" draggable={false} />
                            </div>
                            {characters.length > 1 && <span className="absolute -bottom-0.5 -right-0.5 w-[15px] h-[15px] rounded-full flex items-center justify-center text-[8px]" style={{ background: PAL.cardHi, border: `1px solid ${PAL.frameSoft}`, color: PAL.ink }}>⇄</span>}
                        </button>
                        {/* 衬线名字 + Lv·时间 + 经验条 */}
                        <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2">
                                <span className="text-[17px] leading-none truncate" style={{ fontFamily: FONT_NUM, color: PAL.grape, letterSpacing: '0.03em' }}>{char.name}</span>
                                <span className="text-[9px] tabular-nums shrink-0" style={{ fontFamily: FONT_PX, color: PAL.fade }}>Lv.{level} · {hh}:{mm}{night ? ' ·🌙' : ''}</span>
                            </div>
                            <div className="h-[5px] rounded-full overflow-hidden mt-1.5" style={{ background: 'var(--tg-frame-a22)' }}>
                                <div className="h-full rounded-full" style={{ width: `${Math.max(3, Math.min(100, Math.round((exp / expMax) * 100)))}%`, background: `linear-gradient(90deg, ${PAL.peri}, ${PAL.pink}, ${PAL.hot})`, boxShadow: '0 0 6px var(--tg-frame-a30)' }} />
                            </div>
                        </div>
                        {/* 调色（SVG，不用 emoji） */}
                        <button onClick={() => setPaletteOpen(v => !v)} aria-label="界面风格"
                            className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 active:scale-90 transition-transform"
                            style={{ background: PAL.cardHi, border: `1.5px solid ${PAL.frameSoft}`, color: PAL.grape }}>
                            <span className="w-4 h-4">{ICON.palette}</span>
                        </button>
                        {/* 通话圆钮（聊天入口已经够多：dock/气泡卡/地板手机，这颗给打电话） */}
                        <button onClick={() => openApp(AppID.Call)} aria-label="通话"
                            className="relative w-9 h-9 rounded-full flex items-center justify-center shrink-0 active:scale-90 transition-transform"
                            style={{ background: PAL.cardHi, border: `1.5px solid ${PAL.frame}`, color: PAL.grape }}>
                            <svg viewBox="0 0 24 24" className="w-[17px] h-[17px]" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2z" />
                            </svg>
                        </button>
                    </div>
                ) : (
                    <div className="flex items-center justify-center py-1">
                        <span className="text-[13px] font-bold tracking-[0.26em]" style={{ fontFamily: FONT_PX, color: PAL.grape }}>SULLY·GOTCHI</span>
                    </div>
                )}
            </div>

            {/* ===== 🎨 界面风格面板（六方案 + 提取小窝主色，点外面关闭）===== */}
            {paletteOpen && (
                <>
                    <div className="absolute inset-0 z-[45]" onClick={() => setPaletteOpen(false)} />
                    <div className="absolute right-4 z-50 w-[16.5rem] rounded-2xl p-3.5 animate-pop-in"
                        style={{ top: 'calc(var(--chrome-top, var(--safe-top, 0px)) + 4.6rem)', background: PAL.cardHi, border: `1.5px solid ${PAL.frameSoft}`, boxShadow: '0 10px 26px var(--tg-glow35)' }}>
                        <div className="absolute inset-[4px] rounded-[0.85rem] pointer-events-none" style={{ border: '1px solid var(--tg-frame-a22)' }} />
                        <div className="flex items-center gap-1.5 mb-2.5">
                            <span className="w-4 h-4" style={{ color: PAL.grape }}>{ICON.palette}</span>
                            <span className="text-[12px] font-bold tracking-wide" style={{ fontFamily: FONT_CN, color: PAL.grape }}>界面风格</span>
                            <span className="text-[8px]" style={{ color: PAL.gold }}>✦</span>
                        </div>
                        <div className="grid grid-cols-3 gap-2 mb-3">
                            {SCHEMES.map(s => {
                                const pv = schemePreview(s);
                                const active = style.id === s.id;
                                return (
                                    <button key={s.id} onClick={() => applyStyle(s)}
                                        className="relative flex flex-col items-center gap-1 active:scale-95 transition-transform">
                                        <span className="relative w-full h-9 rounded-lg overflow-hidden flex items-center justify-center"
                                            style={{ background: pv.bg, border: active ? `2px solid ${pv.line}` : '1.5px solid rgba(150,140,160,0.35)' }}>
                                            <span className="absolute inset-x-2 top-1.5 h-[3px] rounded-full" style={{ background: pv.line, opacity: 0.85 }} />
                                            <span className="absolute inset-x-4 bottom-1.5 h-[2px] rounded-full" style={{ background: pv.line, opacity: 0.5 }} />
                                            {active && <span className="text-[9px]" style={{ color: pv.line }}>✦</span>}
                                        </span>
                                        <span className="text-[8.5px] leading-none" style={{ fontFamily: FONT_CN, color: active ? PAL.grape : PAL.fade }}>{s.name}</span>
                                    </button>
                                );
                            })}
                        </div>
                        <button onClick={extractRoomHue} disabled={extracting}
                            className="w-full py-2 rounded-xl text-[11px] font-bold active:scale-95 transition-transform disabled:opacity-60 flex items-center justify-center gap-1.5"
                            style={{ background: PAL.card, border: `1.5px solid ${PAL.frame}`, color: PAL.grape, fontFamily: FONT_CN }}>
                            <span className="w-3.5 h-3.5">{DOCK_GLYPHS.home}</span>{extracting ? '正在打量小窝…' : '提取小窝主色'}
                        </button>
                        <p className="text-[8.5px] leading-relaxed mt-2 text-center" style={{ color: PAL.fade, fontFamily: FONT_CN }}>
                            从 ta 的墙纸 / 地板 / 立绘里找主色，保留当前明暗基调
                        </p>
                        {/* ── 看板 Banner：换图 / 字色 / 恢复默认（铅笔从 banner 上收进来了） ── */}
                        <div className="h-px my-2.5" style={{ background: 'var(--tg-frame-a22)' }} />
                        <div className="flex items-center gap-1.5 mb-2">
                            <span className="text-[11px] font-bold tracking-wide" style={{ fontFamily: FONT_CN, color: PAL.grape }}>看板</span>
                            <span className="text-[6.5px] font-bold tracking-[0.28em]" style={{ fontFamily: FONT_PX, color: PAL.fade }}>BANNER</span>
                        </div>
                        <div className="flex gap-2">
                            <button onClick={() => boardInputRef.current?.click()}
                                className="flex-1 py-2 rounded-xl text-[10.5px] font-bold active:scale-95 transition-transform flex items-center justify-center gap-1.5"
                                style={{ background: PAL.card, border: `1.5px solid ${PAL.frameSoft}`, color: PAL.grape, fontFamily: FONT_CN }}>
                                <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                                {boardImg ? '换一张图' : '上传横图'}
                            </button>
                            {boardImg && (
                                <>
                                    <button onClick={() => boardColorRef.current?.click()} aria-label="看板文字颜色"
                                        className="w-[2.4rem] py-2 rounded-xl flex items-center justify-center active:scale-95 transition-transform"
                                        style={{ background: PAL.card, border: `1.5px solid ${PAL.frameSoft}` }}>
                                        <span className="w-3.5 h-3.5 rounded-full" style={{ background: boardFg || (style.dark ? '#ffffff' : 'var(--tg-grape)'), boxShadow: '0 0 0 1.5px var(--tg-frame-a30)' }} />
                                    </button>
                                    <button onClick={clearBoardImg} aria-label="恢复默认看板"
                                        className="w-[2.4rem] py-2 rounded-xl flex items-center justify-center active:scale-95 transition-transform"
                                        style={{ background: PAL.card, border: `1.5px solid ${PAL.frameSoft}`, color: PAL.fade }}>
                                        <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" /></svg>
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                </>
            )}

            {char ? (
                <>
                    {/* ===== 屏幕即房间：满屏舞台垫底（家具可点、小人带状态签和思绪光点）===== */}
                    <FullStage
                        items={items} wallStyle={wallStyle} floorStyle={floorStyle}
                        actorImg={actorImg} night={night} pokeLines={stat.pokeLines} unread={charUnread}
                        activity={actorActivity} heartLine={heartLine}
                        nudge={nudge} say={say} onItemTap={onItemTap} onChat={openChat}
                    />

                    {/* 直播看板（一整张 banner：图/渐变底 + 营业中/电子时间排版层），下面挂日程牌和 ✦ 挂饰 */}
                    <LiveBoard customImg={boardImg} fg={boardFg} avatar={char.avatar} night={night} dark={style.dark}
                        hh={hh} mm={mm} phase={clockPhaseOf(virtualTime.hours)}
                        onClock={() => openApp(AppID.Schedule)} />
                    <input type="file" ref={boardInputRef} className="hidden" accept="image/*" onChange={onBoardFile} />
                    <input type="color" ref={boardColorRef} className="hidden" value={boardFg} onChange={onBoardColor} />
                    <CeilingCharms />
                    <HangingSign text={signText} onTap={() => setScrollOpen(true)} />
                    {scrollOpen && <DayScroll slots={scrollSlots} onPeek={runTheater} onClose={() => setScrollOpen(false)} />}

                    {/* 右侧世界之门：家园 / 像素家园 / 梦境 */}
                    <WorldPortals onHome={openHomeland} onKanata={openKanata} onDream={openDream} />

                    {/* 地板上的 ta 的手机（未读会亮；点开小弹窗，一键去回） */}
                    <FloorPhone unread={charUnread} open={phoneOpen} msgs={stat.recent}
                        onToggle={() => setPhoneOpen(v => !v)}
                        onChat={() => { setPhoneOpen(false); openChat(); }} />

                    {/* 观察旁白（点家具后出现，贴在 dock 上方） */}
                    {observation && (
                        <div className="absolute inset-x-4 z-[38] px-3.5 py-2.5 rounded-2xl"
                            style={{ bottom: 'calc(var(--safe-bottom, 0px) + 7.4rem)', background: 'rgba(255,255,255,0.92)', border: `1.5px solid ${PAPER.lineSoft}`, boxShadow: '0 4px 12px var(--tg-glow25)' }}>
                            <div className="flex justify-between items-start">
                                <span className="text-[8px] font-bold tracking-[0.28em]" style={{ fontFamily: FONT_PX, color: PAPER.dim }}>OBSERVATION ✦</span>
                                <button onClick={() => setObservation('')} className="px-1 -mt-0.5" style={{ color: PAPER.dim }}>×</button>
                            </div>
                            <p className="text-[11px] leading-relaxed mt-0.5" style={{ fontFamily: FONT_CN, color: PAPER.hi }}>{observation}</p>
                        </div>
                    )}

                    {/* ===== 五键 dock（高级细线双语版，参考稿）：约会 / 聊天 / 全部(星徽) / 记忆 / 设置 ===== */}
                    <div className="absolute inset-x-4 z-[40]" style={{ bottom: 'calc(var(--safe-bottom, 0px) + 0.9rem)' }}>
                        <div className="relative rounded-[1.7rem] px-4 pt-2.5 pb-2 flex items-end justify-between"
                            style={{ background: PAL.card, border: `1.5px solid ${PAL.frameSoft}`, boxShadow: '0 8px 22px var(--tg-glow35)' }}>
                            <div className="absolute inset-[4px] rounded-[1.45rem] pointer-events-none" style={{ border: '1px solid var(--tg-frame-a22)' }} />
                            <Sparkles items={[[7, 14, 7, PAL.frame, 0.6], [93, 18, 7, PAL.frame, 0.55], [50, -8, 8, PAL.frame, 0.8, true]]} />
                            <DockBtn glyph={DOCK_GLYPHS.heart} cn="约会" en="DATE" onClick={() => openApp(AppID.Date)} />
                            <DockBtn glyph={DOCK_GLYPHS.neural} cn="神经链接" en="LINK" onClick={() => openApp(AppID.Character)} />
                            {/* 中央星徽：点开全部应用抽屉 */}
                            <button onClick={() => setDrawerOpen(true)} className="relative flex flex-col items-center gap-1 -mt-8 active:scale-95 transition-transform">
                                <div className="relative w-[3.7rem] h-[3.7rem] rounded-full flex items-center justify-center"
                                    style={{ background: PAL.cardHi, border: `1.5px solid ${PAL.frame}`, boxShadow: '0 0 14px var(--tg-frame-a30), 0 6px 16px var(--tg-glow35)' }}>
                                    <div className="absolute inset-[4px] rounded-full pointer-events-none" style={{ border: '1px solid var(--tg-frame-a30)' }} />
                                    <div className="w-6 h-6" style={{ color: PAL.gold }}>{DOCK_GLYPHS.star}</div>
                                    <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 text-[8px]" style={{ color: PAL.frame, animation: 'tama-twinkle 2s ease-in-out infinite' }}>✦</span>
                                </div>
                                <div className="flex flex-col items-center leading-none gap-[3px]">
                                    <span className="text-[11px]" style={{ fontFamily: FONT_CN, color: PAL.grape }}>全部</span>
                                    <span className="text-[6px] font-bold" style={{ fontFamily: FONT_PX, color: PAL.fade, letterSpacing: '0.16em' }}>ALL</span>
                                </div>
                            </button>
                            <DockBtn glyph={DOCK_GLYPHS.album} cn="记忆" en="MEMORY" onClick={() => openApp(AppID.MemoryPalace)} />
                            <DockBtn glyph={DOCK_GLYPHS.gear} cn="设置" en="SETTING" onClick={() => openApp(AppID.Settings)} />
                        </div>
                    </div>
                </>
            ) : (
                /* 零角色兜底：氛围底 + 像素小蛋 */
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                    <BackDecor />
                    <Sparkles items={[[30, 30, 12, PAL.pink, 0.8, true], [70, 26, 10, PAL.gold, 0.8, true], [24, 62, 9, PAL.peri, 0.7], [76, 66, 11, '#fff', 0.8, true]]} />
                    <div className="relative w-24 h-28 rounded-[50%_50%_46%_46%/58%_58%_42%_42%]"
                        style={{ background: `linear-gradient(180deg, ${PAL.cream}, var(--tg-rim3))`, border: `2.5px solid ${PAL.frame}`, boxShadow: '0 8px 20px var(--tg-glow35)', animation: 'tama-breathe 2.4s ease-in-out infinite' }} />
                    <p className="relative text-[12px] text-center leading-relaxed" style={{ fontFamily: FONT_PX, color: PAL.fade }}>EMPTY EGG…</p>
                    <button onClick={() => openApp(AppID.Character)} className="relative px-5 py-2.5 rounded-2xl text-[13px] font-bold text-white active:scale-95 transition-transform"
                        style={{ background: `linear-gradient(135deg, ${PAL.pink}, ${PAL.hot})`, border: '2px solid rgba(255,255,255,0.8)', boxShadow: '0 5px 14px var(--tg-hotglow45)', fontFamily: FONT_CN }}>
                        去神经链接领养一只
                    </button>
                </div>
            )}

            {/* ===== 日程详细演绎（小剧场）：偷看某个时段，调 API 演一段角色行为 ===== */}
            {theater && char && createPortal(
                <TheaterPlayer
                    character={char}
                    slot={theater.schedule.slots[theater.slotIndex] || null}
                    lines={theater.schedule.slots[theater.slotIndex]?.theater?.lines || null}
                    isGenerating={theaterGenerating}
                    onReplay={() => runTheater(theater.slotIndex, true)}
                    onClose={() => setTheater(null)}
                />,
                document.body,
            )}

            {/* ===== 全部应用抽屉（逃生舱口：外观 / 全部 App 都在这） ===== */}
            {drawerOpen && (
                <div className="absolute inset-0 z-40 flex flex-col animate-fade-in" style={{ background: 'var(--tg-drawer)' }} onClick={() => setDrawerOpen(false)}>
                    <div className="flex items-center justify-between px-6" style={{ paddingTop: 'calc(var(--chrome-top, var(--safe-top, 0px)) + 1.25rem)', paddingBottom: '0.5rem' }}>
                        <h2 className="text-lg tracking-wide" style={{ fontFamily: FONT_CN, color: PAL.ink }}>全部应用</h2>
                        <button onClick={(e) => { e.stopPropagation(); setDrawerOpen(false); }} aria-label="关闭"
                            className="w-9 h-9 rounded-xl flex items-center justify-center active:scale-90 transition-transform"
                            style={{ background: PAL.cardHi, border: `1.5px solid ${PAL.frameSoft}` }}>
                            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ color: PAL.ink }}><path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" /></svg>
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-8" onClick={(e) => e.stopPropagation()}>
                        <div className="grid grid-cols-4 gap-y-5 gap-x-2 place-items-center">
                            {drawerApps.map(app => (
                                <AppIcon key={app.id} app={app} size="md" contentColorOverride={PAL.ink} onClick={() => { setDrawerOpen(false); openApp(app.id); }} />
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TamagotchiHome;
