import { loadCharacterContextMessages } from '../utils/chatContextRange';

import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { RoomItem, CharacterProfile, RoomTodo, RoomNote, DailySchedule, AppID } from '../types';
import ScheduleCard from '../components/schedule/ScheduleCard';
import { ContextBuilder } from '../utils/context';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { processImageToBlob } from '../utils/file';
import { putImageBlob, useBlobRefUrl, isBlobRef, migrateDataUrlToRef, resolveBlobRefsDeep } from '../utils/blobRef';
import TokenImg from '../components/os/TokenImg';
import Modal from '../components/os/Modal';
import { safeResponseJson, extractJson } from '../utils/safeApi';
import { Door, Sparkle, Image, GearSix, Camera, MoonStars, ArrowUUpLeft, ArrowUUpRight, CopySimple, Images, Eye, EyeSlash } from '@phosphor-icons/react';
import { FURNITURE_ICONS } from '../utils/furnitureIcons';
const Home3DView = React.lazy(() => import('./room3d/Home3DSetupEntry'));
import WorldHomeApp from './WorldHomeApp';
import DreamTheater from './DreamTheater';
import { useDreamSim, dreamSimStore } from '../utils/dreamSimStore';
import { roomLaunch } from '../utils/roomLaunch';
import { characterLaunch } from '../utils/characterLaunch';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { getVirtualDayKey } from '../utils/localDate';
import { resolveCharTimeZone, nowInTimeZone, tzLabel } from '../utils/timezone';
import { getDailyScheduleForChar } from '../utils/dailySchedule';
import { trackEvent } from '../utils/analytics';
import { normalizeBuiltInRoomTemplateAssetsInPlace, toPortableBuiltinRoomAsset } from '../utils/roomTemplateAssets';
import { shareOrDownloadFile } from '../utils/shareExport';
import { readShareText } from '../utils/pngShare';

const TWEMOJI_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72';
const twemojiUrl = (codepoint: string) => `${TWEMOJI_BASE}/${codepoint}.png`;

/** 拜访小屋卡片的柔色底（按序循环，营造每个房间各有色调的奇幻感）。 */
const ROOM_CARD_TINTS = [
    'linear-gradient(180deg,rgba(120,92,170,.42),rgba(34,26,62,.6))',
    'linear-gradient(180deg,rgba(70,80,135,.42),rgba(26,28,56,.62))',
    'linear-gradient(180deg,rgba(150,132,192,.4),rgba(52,42,86,.6))',
    'linear-gradient(180deg,rgba(110,150,200,.4),rgba(34,52,86,.6))',
    'linear-gradient(180deg,rgba(132,96,176,.42),rgba(46,30,78,.6))',
    'linear-gradient(180deg,rgba(70,64,92,.46),rgba(24,22,40,.64))',
];
/** 浅色（小小窝/家园分区）卡片柔色底——粉/薰衣草/浅蓝渐变。 */
const ROOM_CARD_TINTS_LIGHT = [
    'linear-gradient(180deg,rgba(250,212,228,.85),rgba(242,228,246,.8))',
    'linear-gradient(180deg,rgba(232,228,248,.85),rgba(242,238,250,.8))',
    'linear-gradient(180deg,rgba(226,216,246,.85),rgba(238,230,249,.8))',
    'linear-gradient(180deg,rgba(212,230,247,.85),rgba(234,240,250,.8))',
    'linear-gradient(180deg,rgba(226,212,245,.85),rgba(238,228,249,.8))',
    'linear-gradient(180deg,rgba(234,231,242,.88),rgba(242,240,247,.82))',
];

// --- 1. 免版权贴纸素材库 (Sticker Library) ---
// 使用手绘 SVG 图标替代 Twemoji，更精致的视觉体验
const ASSET_LIBRARY = {
    // Sully专属家具 (默认大小已根据你的布局调整)
    sully_special: [
        { name: 'Sully床', image: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/BED.png', defaultScale: 2.4 },
        { name: 'Sully电脑桌', image: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/DNZ.png', defaultScale: 2.4 },
        { name: 'Sully书柜', image: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/SG.png', defaultScale: 2.0 },
        { name: 'Sully洞洞板', image: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/DDB.png', defaultScale: 2.6 },
        { name: 'Sully垃圾桶', image: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/LJT.png', defaultScale: 0.9 },
    ],
    furniture: [
        { name: '床', image: FURNITURE_ICONS.bed, defaultScale: 1.5 },
        { name: '沙发', image: FURNITURE_ICONS.sofa, defaultScale: 1.4 },
        { name: '椅子', image: FURNITURE_ICONS.chair, defaultScale: 1.0 },
        { name: '马桶', image: FURNITURE_ICONS.toilet, defaultScale: 1.0 },
        { name: '浴缸', image: FURNITURE_ICONS.bathtub, defaultScale: 1.5 },
    ],
    rug: [
        { name: '条纹地毯', image: FURNITURE_ICONS.rug, defaultScale: 1.6 },
        { name: '圆形地毯', image: FURNITURE_ICONS.roundRug, defaultScale: 1.6 },
    ],
    decor: [
        { name: '盆栽', image: FURNITURE_ICONS.plant, defaultScale: 0.8 },
        { name: '电脑', image: FURNITURE_ICONS.computer, defaultScale: 0.8 },
        { name: '游戏机', image: FURNITURE_ICONS.gamepad, defaultScale: 0.6 },
        { name: '吉他', image: FURNITURE_ICONS.guitar, defaultScale: 1.0 },
        { name: '画', image: FURNITURE_ICONS.painting, defaultScale: 1.2 },
        { name: '书堆', image: FURNITURE_ICONS.books, defaultScale: 0.8 },
        { name: '台灯', image: FURNITURE_ICONS.lamp, defaultScale: 0.8 },
        { name: '垃圾桶', image: FURNITURE_ICONS.trash, defaultScale: 0.7 },
    ],
    food: [
        { name: '咖啡', image: FURNITURE_ICONS.coffee, defaultScale: 0.5 },
        { name: '蛋糕', image: FURNITURE_ICONS.cake, defaultScale: 0.6 },
        { name: '披萨', image: FURNITURE_ICONS.pizza, defaultScale: 0.8 },
    ]
};

// 预设背景图
const WALLPAPER_PRESETS = [
    { name: '温馨暖白', value: 'radial-gradient(circle at 50% 50%, #fdfbf7 0%, #e2e8f0 100%)' },
    { name: '深夜蓝调', value: 'linear-gradient(to bottom, #1e293b 0%, #0f172a 100%)' },
    { name: '少女粉', value: 'radial-gradient(circle at 50% 50%, #fff1f2 0%, #ffe4e6 100%)' },
    { name: '极简灰', value: 'linear-gradient(135deg, #f3f4f6 0%, #d1d5db 100%)' },
    { name: '木质感', value: 'repeating-linear-gradient(45deg, #f7fee7 0px, #f7fee7 10px, #ecfccb 10px, #ecfccb 20px)' },
];

const FLOOR_PRESETS = [
    { name: '浅色木板', value: 'repeating-linear-gradient(90deg, #e7e5e4 0px, #e7e5e4 20px, #d6d3d1 21px)' },
    { name: '深色木板', value: 'repeating-linear-gradient(90deg, #78350f 0px, #78350f 20px, #451a03 21px)' },
    { name: '格纹地砖', value: 'conic-gradient(from 90deg at 2px 2px, #0000 90deg, #cbd5e1 0) 0 0/30px 30px' },
    { name: '素色地毯', value: '#d1d5db' },
];

const DEFAULT_FURNITURE: RoomItem[] = [
    { id: 'desk', name: '书桌', type: 'furniture', image: ASSET_LIBRARY.furniture[1].image, x: 20, y: 55, scale: 1.2, rotation: 0, isInteractive: true, descriptionPrompt: '这里是书桌，可能乱糟糟的，也可能整整齐齐。' },
    { id: 'plant', name: '盆栽', type: 'decor', image: ASSET_LIBRARY.decor[0].image, x: 85, y: 40, scale: 0.8, rotation: 0, isInteractive: true, descriptionPrompt: '角落里的植物。' },
];

// User-provided layout (Perfectly aligned!)
const SULLY_FURNITURE: RoomItem[] = [
  {
    id: "item-1768927221380",
    name: "Sully床",
    type: "furniture",
    image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/BED.png",
    x: 78.45852578067732,
    y: 97.38889754570907,
    scale: 2.4,
    rotation: 0,
    isInteractive: true,
    descriptionPrompt: "看起来很好睡的猫窝（确信）。"
  },
  {
    id: "item-1768927255102",
    name: "Sully电脑桌",
    type: "furniture",
    image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/DNZ.png",
    x: 28.853756791175588,
    y: 69.9444485439727,
    scale: 2.4,
    rotation: 0,
    isInteractive: true,
    descriptionPrompt: "硬核的电脑桌，上面大概运行着什么毁灭世界的程序。"
  },
  {
    id: "item-1768927271632",
    name: "Sully垃圾桶",
    type: "furniture",
    image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/LJT.png",
    x: 10.276680026943646,
    y: 80.49999880981437,
    scale: 0.9,
    rotation: 0,
    isInteractive: true,
    descriptionPrompt: "不要乱翻垃圾桶！"
  },
  {
    id: "item-1768927286526",
    name: "Sully洞洞板",
    type: "furniture",
    image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/DDB.png",
    x: 32.608697687684455,
    y: 48.72222587415929,
    scale: 2.6,
    rotation: 0,
    isInteractive: true,
    descriptionPrompt: "收纳着各种奇奇怪怪的黑客工具和猫咪周边的洞洞板。"
  },
  {
    id: "item-1768927303472",
    name: "Sully书柜",
    type: "furniture",
    image: "https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/SG.png",
    x: 79.84189945375853,
    y: 68.94444543117953,
    scale: 2,
    rotation: 0,
    isInteractive: true,
    descriptionPrompt: "塞满了技术书籍和漫画书的柜子。"
  }
];

const FLOOR_HORIZON = 65; // Floor starts at 65% from top

type BuiltInRoomTemplate = {
    id: string;
    label: 'A' | 'B';
    name: string;
    description: string;
    templateUrl: string;
    thumbnail: string;
};

// public 资源必须带 BASE_URL 前缀，兼容 GitHub Pages 的仓库子路径部署（见 vite.config.ts base 配置）。
// 写死根绝对路径（/room-templates/...）会打到域名根目录导致 404。
const PUBLIC_BASE = (import.meta as any).env?.BASE_URL ?? '/';
const publicAsset = (p: string) => `${PUBLIC_BASE}${p}`.replace(/\/+/g, '/');

const BUILTIN_ROOM_TEMPLATES: BuiltInRoomTemplate[] = [
    {
        id: 'forest-cottage',
        label: 'A',
        name: '森系小屋',
        description: '绿意、木纹和柔软生活感。',
        templateUrl: publicAsset('room-templates/forest-cottage/template.json'),
        thumbnail: publicAsset('room-templates/forest-cottage/preview.png'),
    },
    {
        id: 'blue-minimal',
        label: 'B',
        name: '蓝色系简约风',
        description: '清爽蓝调和干净利落的布置。',
        templateUrl: publicAsset('room-templates/blue-minimal/template.json'),
        thumbnail: publicAsset('room-templates/blue-minimal/preview.png'),
    },
];

const SAMPLE_ROOM_DISMISS_PREFIX = 'room_sample_offer_dismissed_';

interface ItemInteraction {
    description: string;
    reaction: string;
}

// --- Helper: Enhanced Markdown Renderer for Notebook ---
const renderInlineStyle = (text: string) => {
    // Regular Expression to match:
    // 1. **bold**
    // 2. ~~strikethrough~~
    // 3. *italic*
    // 4. `code`
    const parts = text.split(/(\*\*.*?\*\*|~~.*?~~|\*.*?\*|`.*?`)/g);
    
    return parts.map((part, i) => {
        // Bold
        if (part.startsWith('**') && part.endsWith('**')) {
            return <strong key={i} className="font-bold text-slate-800 bg-yellow-100/50 px-0.5 rounded">{part.slice(2, -2)}</strong>;
        }
        // Strikethrough
        if (part.startsWith('~~') && part.endsWith('~~')) {
            return <span key={i} className="line-through text-slate-400 opacity-80">{part.slice(2, -2)}</span>;
        }
        // Italic (single asterisk)
        if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
            return <em key={i} className="italic text-slate-600">{part.slice(1, -1)}</em>;
        }
        // Inline Code
        if (part.startsWith('`') && part.endsWith('`')) {
             return <code key={i} className="bg-slate-200 text-slate-600 px-1 rounded text-xs font-mono break-all">{part.slice(1, -1)}</code>;
        }
        return part;
    });
};

const renderNotebookContent = (text: string) => {
    // Simple Markdown-ish parser
    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts.map((part, index) => {
        if (part.startsWith('```') && part.endsWith('```')) {
            // Remove code block markers
            const firstLineBreak = part.indexOf('\n');
            let codeContent = part;
            if (firstLineBreak > -1 && firstLineBreak < 10) {
                 codeContent = part.substring(firstLineBreak + 1, part.length - 3);
            } else {
                 codeContent = part.substring(3, part.length - 3);
            }
            
            return (
                <div key={index} className="my-3 w-full max-w-full">
                    {/* Keep horizontal scroll for code blocks, don't wrap */}
                    <pre className="bg-slate-800 text-green-400 p-3 rounded-xl text-[10px] font-mono overflow-x-auto border-l-4 border-green-600 shadow-sm whitespace-pre">
                        {codeContent}
                    </pre>
                </div>
            );
        }
        return (
            <div key={index} className="w-full">
                {part.split('\n').map((line, lineIdx) => {
                    const key = `${index}-${lineIdx}`;
                    const trimLine = line.trim();
                    
                    if (!trimLine) return <div key={key} className="h-2"></div>;

                    if (trimLine.startsWith('# ')) {
                        return <h3 key={key} className="text-lg font-bold text-slate-800 mt-4 mb-2 pb-1 border-b-2 border-slate-200 break-words">{trimLine.substring(2)}</h3>;
                    }
                    if (trimLine.startsWith('## ')) {
                        return <h4 key={key} className="text-sm font-bold text-slate-700 mt-3 mb-1 border-l-4 border-slate-300 pl-2 break-words">{trimLine.substring(3)}</h4>;
                    }
                    if (trimLine.startsWith('> ')) {
                        return <div key={key} className="pl-3 border-l-4 border-slate-300 text-slate-500 italic my-2 py-1 bg-slate-100 rounded-r-lg text-xs break-words">{trimLine.substring(2)}</div>;
                    }
                    if (trimLine.startsWith('- ') || trimLine.startsWith('• ')) {
                        return <div key={key} className="flex gap-2 my-1 pl-1 items-start"><span className="text-slate-400 mt-1 shrink-0">•</span><span className="flex-1 break-words">{renderInlineStyle(trimLine.substring(2))}</span></div>;
                    }
                    
                    if (trimLine.match(/^\[[ x]\]/)) {
                         const isChecked = trimLine.includes('[x]');
                         return (
                             <div key={key} className="flex gap-2 my-1 pl-1 items-center">
                                 <div className={`w-3 h-3 border rounded-sm flex items-center justify-center shrink-0 ${isChecked ? 'bg-slate-600 border-slate-600' : 'border-slate-400'}`}>
                                     {isChecked && <svg className="w-2 h-2 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" /></svg>}
                                 </div>
                                 <span className={`flex-1 break-words ${isChecked ? 'line-through text-slate-400' : 'text-slate-700'}`}>{renderInlineStyle(trimLine.substring(3))}</span>
                             </div>
                         );
                    }

                    return <div key={key} className="min-h-[1.5em] my-0.5 leading-relaxed break-words text-justify">{renderInlineStyle(line)}</div>;
                })}
            </div>
        );
    });
};

const RoomApp: React.FC = () => {
    const { activeApp, closeApp, openApp, characters, characterGroups, activeCharacterId, setActiveCharacterId, updateCharacter, apiConfig, addToast, userProfile } = useOS();

    // 桌面主题的「进小屋意图」：惰性读取（不清空，consume 在下方 effect），首帧就落到
    // 目标视图，避免闪一下 select 页。真正的应用（进房间/开梦境/切角色）在 effect 里做。
    const launchIntent = roomLaunch.peek();
    // 从桌面主题带意图进来的标记：退出时直接回桌面（closeApp），而不是退回 select 页。
    const launchedFromDesktopRef = useRef(!!launchIntent);

    // Core State
    const [viewState, setViewState] = useState<'select' | 'room' | 'home3D'>(() => {
        if (launchIntent?.tab === 'home3D' && launchIntent.charId) return 'home3D';
        if (launchIntent?.charId) return 'room'; // 房间 / 梦境
        return 'select';
    });
    // 小小窝里的三个独立分区：房间 / 3D 拜访 / 家园（家园是另一套体系，单独成区）
    const [homeTab, setHomeTab] = useState<'room' | 'home3D' | 'worldHome'>(() => launchIntent?.tab || 'room');
    // 家园「正式开始玩」（进世界/编辑）时全屏，隐去顶部三栏
    const [worldHomeFull, setWorldHomeFull] = useState(false);
    const [worldShortcut, setWorldShortcut] = useState<{ id?: string; sequence: number }>(() => ({ id: launchIntent?.worldId, sequence: 0 }));
    // 选人页（拜访谁的房间）的分组筛选
    const [visitGroupId, setVisitGroupId] = useState<string>(GROUP_FILTER_ALL);
    // 编辑家具弹窗里「指定角色」多选的分组筛选（只影响显示哪些可选项，不动已勾选）
    const [assignGroupId, setAssignGroupId] = useState<string>(GROUP_FILTER_ALL);
    const [mode, setMode] = useState<'view' | 'edit'>('view');
    const [items, setItems] = useState<RoomItem[]>([]);
    
    // Extended State
    const [todaysTodo, setTodaysTodo] = useState<RoomTodo | null>(null);
    const [notebookEntries, setNotebookEntries] = useState<RoomNote[]>([]);
    const [showSidebar, setShowSidebar] = useState(false);
    const [activePanel, setActivePanel] = useState<'todo' | 'notebook' | 'schedule'>('todo');
    const [roomSchedule, setRoomSchedule] = useState<DailySchedule | null>(null);
    const [notebookPage, setNotebookPage] = useState(0);

    // UI State
    const [isInitializing, setIsInitializing] = useState(false);
    const [initStatusText, setInitStatusText] = useState('正在推开房门...');
    const [showLibrary, setShowLibrary] = useState(false);
    const [showRefreshConfirm, setShowRefreshConfirm] = useState(false);
    const [showDevModal, setShowDevModal] = useState(false); // Developer Mode
    const [showSettingsModal, setShowSettingsModal] = useState(false); // New: Room Settings
    const [showDream, setShowDream] = useState(false); // 查看梦境 · Dream Theater overlay
    const [lastPrompt, setLastPrompt] = useState<string>(''); // Debug: Store last sent prompt
    const [showSampleRoomOffer, setShowSampleRoomOffer] = useState(false);
    const [sampleRoomLoadingId, setSampleRoomLoadingId] = useState<string | null>(null);
    const [showActorArtModal, setShowActorArtModal] = useState(false);
    
    // Actor & Room State
    const [actorState, setActorState] = useState({ x: 50, y: 75, action: 'idle' });
    const [aiBubble, setAiBubble] = useState<{text: string, visible: boolean}>({ text: '', visible: false });
    const [observationText, setObservationText] = useState('');
    const [roomDescriptions, setRoomDescriptions] = useState<Record<string, ItemInteraction>>({});
    
    // Edit Mode State
    const [draggingId, setDraggingId] = useState<string | null>(null);
    // Use Ref to store drag offset context
    const dragStartRef = useRef<{ startX: number, startY: number, initialItemX: number, initialItemY: number, width: number, height: number } | null>(null);
    const draggingIdRef = useRef<string | null>(null); // Non-reactive drag ID for perf
    const dragElementRef = useRef<HTMLElement | null>(null); // Direct DOM ref for dragged element
    const rafRef = useRef<number | null>(null); // requestAnimationFrame handle
    const pendingDragPos = useRef<{ x: number, y: number } | null>(null); // Pending drag position
    const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Debounce DB writes
    const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
    const [isToolbarCollapsed, setIsToolbarCollapsed] = useState(false);
    const [hideActorInEdit, setHideActorInEdit] = useState(false);
    const roomRef = useRef<HTMLDivElement>(null);

    // 装修手感升级：撤销/重做栈（items 全程不可变更新，直接存数组引用即可）
    const [history, setHistory] = useState<RoomItem[][]>([]);
    const [future, setFuture] = useState<RoomItem[][]>([]);
    // 连续手势（滑杆/微调/滚轮）在 1.2s 内合并成一条历史，避免拖一次滑杆塞满撤销栈
    const lastHistoryKeyRef = useRef<{ key: string; t: number }>({ key: '', t: 0 });

    // 双指捏合（缩放+旋转+跟随中点移动）：第一指走原拖拽通道，第二指落下时升级为捏合
    const dragPointerIdRef = useRef<number | null>(null);
    const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
    const pinchRef = useRef<{
        id1: number; id2: number;
        startDist: number; startAngle: number;
        startMidX: number; startMidY: number;
        baseScale: number; baseRotation: number;
        baseX: number; baseY: number;
        width: number; height: number;
    } | null>(null);
    const pendingPinchRef = useRef<{ scale: number; rotation: number } | null>(null);
    // 捏合刚结束时浏览器还会补发一次 click（落在舞台上会误触「取消选中」），记时间戳挡掉
    const lastPinchEndRef = useRef(0);

    // 批量导入素材 / 导入小屋样板房
    const [isBatchImporting, setIsBatchImporting] = useState(false);
    const [isImportingRoom, setIsImportingRoom] = useState(false);
    const [pendingImport, setPendingImport] = useState<any | null>(null);
    const batchAssetInputRef = useRef<HTMLInputElement>(null);
    const importRoomInputRef = useRef<HTMLInputElement>(null);
    
    // File Inputs
    const wallInputRef = useRef<HTMLInputElement>(null);
    const floorInputRef = useRef<HTMLInputElement>(null);
    const actorInputRef = useRef<HTMLInputElement>(null); 
    const customItemInputRef = useRef<HTMLInputElement>(null);

    const char = characters.find(c => c.id === activeCharacterId);

    // chibi 立绘 / 墙 / 地板都可能是 blobref 令牌，先解析成可直接渲染的 url（objectURL / http / data）。
    // ⚠️ 这三个是 hook，必须放在 select/home3D 的 early-return **之前**无条件调用——
    // 放在 early-return 之后会在「选择页 → 进小屋」的切换瞬间改变 hook 数量，
    // 触发 "Rendered more hooks than during the previous render" 崩溃。
    // char 为空时传 undefined，hook 原样返回 undefined，安全。
    const actorImage = useBlobRefUrl(char?.sprites?.['chibi'] || char?.avatar);
    const wallImg = useBlobRefUrl(char?.roomConfig?.wallImage);
    const floorImg = useBlobRefUrl(char?.roomConfig?.floorImage);

    // Custom Item Library State (new: unified with visibility)
    type CustomAsset = { id: string; name: string; image: string; defaultScale: number; description?: string; visibility: 'public' | 'character'; assignedCharIds?: string[]; itemType?: 'furniture' | 'rug' };
    const [allCustomAssets, setAllCustomAssets] = useState<CustomAsset[]>([]);
    const customAssets = useMemo(() => {
        if (!char) return allCustomAssets.filter(a => a.visibility === 'public');
        return allCustomAssets.filter(a => a.visibility === 'public' || (a.assignedCharIds && a.assignedCharIds.includes(char.id)));
    }, [allCustomAssets, char?.id]);
    const [showCustomModal, setShowCustomModal] = useState(false);
    const [customItemName, setCustomItemName] = useState('');
    const [customItemImage, setCustomItemImage] = useState('');
    const [customItemUrl, setCustomItemUrl] = useState('');
    const [customItemDescription, setCustomItemDescription] = useState('');
    const [customItemType, setCustomItemType] = useState<'furniture' | 'rug'>('furniture');

    // Export Room Template State（装修模式导出「当前小屋」为样板房 JSON）
    const [showExportModal, setShowExportModal] = useState(false);
    const [exportName, setExportName] = useState('');
    const [exportDescription, setExportDescription] = useState('');
    const [isExporting, setIsExporting] = useState(false);

    // Asset Edit Modal State
    const [editingAsset, setEditingAsset] = useState<CustomAsset | null>(null);
    const [editName, setEditName] = useState('');
    const [editDescription, setEditDescription] = useState('');
    const [editImage, setEditImage] = useState('');
    const [editVisibility, setEditVisibility] = useState<'public' | 'character'>('public');
    const [editAssignedCharIds, setEditAssignedCharIds] = useState<string[]>([]);
    const [editItemType, setEditItemType] = useState<'furniture' | 'rug'>('furniture');
    const assetLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // PERF: Cleanup rAF and debounce timers on unmount
    useEffect(() => {
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
        };
    }, []);

    // 换了房间就清空撤销/重做栈（历史属于上一间屋子）
    useEffect(() => {
        setHistory([]);
        setFuture([]);
        lastHistoryKeyRef.current = { key: '', t: 0 };
    }, [activeCharacterId]);

    // Load custom assets from global DB (with migration from old format)
    useEffect(() => {
        const loadAssets = async () => {
            const dbData = await DB.getAsset('room_custom_assets_list');
            const lsData = localStorage.getItem('room_custom_assets');
            let assets: any[] = [];
            if (dbData) {
                try { assets = JSON.parse(dbData); } catch {}
            } else if (lsData) {
                try { assets = JSON.parse(lsData); localStorage.removeItem('room_custom_assets'); } catch {}
            }
            // 迁移旧格式：没有 id/visibility 的旧资产标记为公共
            let needsSave = false;
            const migrated = assets.map((a: any) => {
                if (!a.id || !a.visibility) {
                    needsSave = true;
                    return { ...a, id: a.id || `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, visibility: a.visibility || 'public' };
                }
                return a;
            });
            // 惰性迁移：把旧的 base64 图片存量转成 Blob，字段换成 blobref 令牌（省空间、脱离 JS 堆）。
            // 单个 JSON 记录、无并发写者，安全。转换失败原样保留，不丢图。
            for (const a of migrated) {
                if (typeof a.image === 'string' && a.image.startsWith('data:')) {
                    const ref = await migrateDataUrlToRef(a.image);
                    if (isBlobRef(ref)) { a.image = ref; needsSave = true; }
                }
            }
            if (needsSave && migrated.length > 0) {
                await DB.saveAsset('room_custom_assets_list', JSON.stringify(migrated));
            }
            setAllCustomAssets(migrated);
        };
        loadAssets();
    }, []);

    // Helper: Get Virtual "Day" (Reset at 6 AM)
    // 角色开了「自定义时区」就按 ta 自己的时间算这一天——房间是 ta 的房间，
    // 一天的分界（以及今天的日程/todo/待办属于哪天）要跟着 ta 的作息，不是跟着我的手机。
    const getVirtualDay = (c?: CharacterProfile | null): string =>
        getVirtualDayKey(nowInTimeZone(resolveCharTimeZone(c)));

    // Calculate Time Gap - Duplicated logic from other apps for self-containment
    const getTimeGapHint = (lastMsgTimestamp: number | undefined): string => {
        if (!lastMsgTimestamp) return '这是初次见面。';
        const now = Date.now();
        const diffMs = now - lastMsgTimestamp;
        const diffMins = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffHours / 24);

        if (diffMins < 5) return '你们刚刚还在聊天。';
        if (diffMins < 60) return `距离上次互动只有 ${diffMins} 分钟。`;
        if (diffHours < 24) return `距离上次互动已经过了 ${diffHours} 小时。`;
        return `距离上次互动已经过了 ${diffDays} 天。`;
    };

    // --- 1. Selection & Initialization ---

    const handleEnterRoom = async (c: CharacterProfile) => {
        setActiveCharacterId(c.id);
        setViewState('room');
        
        // Load Items: Priority -> Character Config > Sully Defaults > Generic Defaults
        let loadedItems = c.roomConfig?.items;
        
        if (!loadedItems || loadedItems.length === 0) {
            // Check if it's Sully (Preset ID or Name fallback)
            if (c.id === 'preset-sully-v2' || c.name === 'Sully') {
                loadedItems = SULLY_FURNITURE; 
                // Auto-save Sully's furniture to persist it
                updateCharacter(c.id, { roomConfig: { ...c.roomConfig, items: SULLY_FURNITURE } });
                setShowSampleRoomOffer(false);
            } else {
                loadedItems = [];
                const dismissed = localStorage.getItem(`${SAMPLE_ROOM_DISMISS_PREFIX}${c.id}`) === '1';
                setShowSampleRoomOffer(!dismissed);
            }
        } else {
            setShowSampleRoomOffer(false);
        }
        
        setItems(loadedItems || []);
        
        const today = getVirtualDay(c);
        const hasCache = c.lastRoomDate === today && c.savedRoomState;

        if (hasCache && c.savedRoomState) {
            setRoomDescriptions(c.savedRoomState.items || {});
            setAiBubble({ text: c.savedRoomState.welcomeMessage || "...", visible: true });
            
            const existingTodo = await DB.getRoomTodo(c.id, today);
            const existingNotes = await DB.getRoomNotes(c.id);
            // 日程与房间里的“今天”统一跟随角色时区；旧手机日期 key 会由读取层安全迁移。
            const existingSchedule = await getDailyScheduleForChar(c);
            setTodaysTodo(existingTodo);
            setNotebookEntries(existingNotes.sort((a, b) => b.timestamp - a.timestamp));
            setRoomSchedule(existingSchedule);

            addToast('已恢复今日房间状态', 'info');
        } else {
            // 不在进门时阻塞生成——直接进屋（否则用户要干等很久才进得来）。
            // 今天的房间内容交给用户进屋后点「更新这一天」再生成；
            // 这里只把聊天期间可能已生成的 todo / 随笔 / 日程读出来填上。
            const existingTodo = await DB.getRoomTodo(c.id, today);
            const existingNotes = await DB.getRoomNotes(c.id);
            const existingSchedule = await getDailyScheduleForChar(c);
            setTodaysTodo(existingTodo);
            setNotebookEntries(existingNotes.sort((a, b) => b.timestamp - a.timestamp));
            setRoomSchedule(existingSchedule);
            setRoomDescriptions({});
            setAiBubble({ text: '', visible: false });
        }
    };

    const handleForceRefresh = () => {
        setShowRefreshConfirm(false);
        if (char) {
            initializeRoomState(char, items, true);
        }
    };

    // 「更新这一天」：进屋后由用户主动触发今日房间生成（首次生成无需二次确认）
    const handleGenerateToday = () => {
        if (char) initializeRoomState(char, items, true);
        trackEvent('生成今天的房间');
    };

    // 梦境全局指示条深链：点一下 → 直接进入对应角色的房间并打开梦境演出
    const dreamSim = useDreamSim();
    const dreamSimCharId = dreamSim.status === 'idle' ? undefined : dreamSim.charId;
    useEffect(() => {
        if (!dreamSim.deepLink || !dreamSimCharId) return;
        const c = characters.find(x => x.id === dreamSimCharId);
        if (c) {
            setHomeTab('room');
            handleEnterRoom(c);   // 设激活角色 + 进房间 + 载入家具（不阻塞生成）
            setShowDream(true);
        }
        dreamSimStore.clearDeepLink();
    }, [dreamSim.deepLink, dreamSimCharId, characters]);

    // 桌面主题（TamagotchiHome）的世界化入口：挂载时消费一次「进小屋意图」，
    // 落到指定 tab / 指定角色 / 直接开梦境。viewState/homeTab 已由惰性初始化到位，
    // 这里只补做需要副作用的部分（设激活角色、载家具、开梦境），并清空意图。
    // 用 useLayoutEffect 在浏览器绘制前跑完，避免任何中间态闪现。
    useLayoutEffect(() => {
        let initial = true;
        const apply = () => {
            const isInitial = initial; initial = false;
            const intent = roomLaunch.consume();
            if (!intent) return;
            launchedFromDesktopRef.current = true;
            const tab = intent.tab || 'room';
            setHomeTab(tab); setShowDream(false); setWorldHomeFull(false);
            if (tab === 'worldHome') {
                setViewState('select');
                setWorldShortcut(previous => isInitial ? previous : { id: intent.worldId, sequence: previous.sequence + 1 });
                return;
            }
            const c = intent.charId ? characters.find(x => x.id === intent.charId) : null;
            if (!c) { setViewState('select'); return; }
            setActiveCharacterId(c.id);
            if (tab === 'home3D') { setViewState('home3D'); return; }
            handleEnterRoom(c);
            if (intent.openDream) setShowDream(true);
        };
        apply();
        return roomLaunch.subscribe(apply);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [characters]);

    // Fallback Initialization: Used when main generation fails due to Safety Block
    const initializeFallback = async (c: CharacterProfile) => {

        try {
            console.warn("Triggering Room Fallback Initialization");
            const characterContextInput = { char: c, user: userProfile, includeDetailedMemories: false };

            const fallbackPrompt = `\n\nTask: User entered your room. Just say hello. JSON: { "welcomeMessage": "..." }`;
            
            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({ 
                    model: apiConfig.model, 
                    messages: (await ContextBuilder.buildCharacterRequest(characterContextInput, [{ role: "user", content: fallbackPrompt }])),
                    temperature: 0.5,
                    max_tokens: 8000 // Keep it tiny
                })
            });

            if (response.ok) {
                const data = await safeResponseJson(response);
                const rawContent = data.choices?.[0]?.message?.content || '';

                // 简化版只要一句欢迎语。先鲁棒地抽 JSON；抽不出就直接把纯文本当欢迎语
                // ——模型常常直接回一句「你好呀～」而不裹 JSON，这本身就是完美的欢迎语，
                // 没必要因为「不是合法 JSON」就整个失败降级成 (...)。
                const parsed = extractJson(rawContent);
                const cleanText = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
                const welcomeMessage =
                    (parsed && typeof parsed.welcomeMessage === 'string' && parsed.welcomeMessage.trim())
                        ? parsed.welcomeMessage.trim()
                        : (cleanText.slice(0, 200) || "...");

                const todayStr = getVirtualDay(c);
                setAiBubble({ text: welcomeMessage, visible: true });
                // Use generic descriptions for items in fallback mode
                const fallbackItems: Record<string, any> = {};
                items.forEach(i => { fallbackItems[i.id] = { description: `This is a ${i.name}.`, reaction: "..." }; });
                setRoomDescriptions(fallbackItems);

                updateCharacter(c.id, {
                    lastRoomDate: todayStr,
                    savedRoomState: {
                        actorStatus: "Idling...",
                        welcomeMessage,
                        items: fallbackItems,
                        actorAction: 'idle'
                    }
                });
                addToast("这次房间没完全生成好，先用了简化版，可稍后重试。", "info");
            } else {
                throw new Error(`Fallback API Error ${response.status}`);
            }
        } catch (e) {
            console.error("Fallback Failed", e);
            // 连简化版都彻底失败（网络/接口错误）：给个柔和的兜底气泡，别只显示冷冰冰的 (...)
            setAiBubble({ text: "（似乎有点走神……过会儿再来看看吧）", visible: true });
        } finally {
            setIsInitializing(false);
        }
    };

    const initializeRoomState = async (c: CharacterProfile, currentItems: RoomItem[], force: boolean = false) => {

        // 不能静默 return：API 配置缺失时「更新这一天」会变成点了毫无反应的死按钮
        // （用户现场：localStorage 被清 → os_api_config 丢失 → 此处静默退出）。
        if (!apiConfig?.baseUrl || !apiConfig?.apiKey) {
            addToast('请先在设置里配置 API（生成今日房间需要调用模型）', 'error');
            return;
        }

        setIsInitializing(true);
        const loadingTexts = [`正在打扫${c.name}的房间...`, "正在整理思绪...", "正在擦拭家具...", "正在生成全部物品记忆..."];
        let textIdx = 0;
        const textInterval = setInterval(() => {
            setInitStatusText(loadingTexts[textIdx % loadingTexts.length]);
            textIdx++;
        }, 1200);

        try {
            const todayStr = getVirtualDay(c);
            // 时间一律按角色自己的时区读（没开自定义时区就是本机）。
            // 必须和 buildCoreContext 注入的「当前时间」同源：那边早就按角色时区折算了，
            // 这里再塞一份本机时间就等于在同一个 prompt 里给了模型两个互相矛盾的钟。
            const charTz = resolveCharTimeZone(c);
            const now = nowInTimeZone(charTz);
            const nowTimeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const nowDateStr = now.toLocaleDateString();
            const tzSuffix = charTz ? `（你所在时区：${tzLabel(charTz)}，这是你那边的当地时间）` : '';
            
            let existingTodo = await DB.getRoomTodo(c.id, todayStr);
            const existingNotes = await DB.getRoomNotes(c.id);
            const existingSchedule = await getDailyScheduleForChar(c);
            setNotebookEntries(existingNotes.sort((a, b) => b.timestamp - a.timestamp));
            setRoomSchedule(existingSchedule);
            
            const shouldGenerateTodo = !existingTodo;
            if (existingTodo) {
                setTodaysTodo(existingTodo);
            }

            const recentMsgs = await loadCharacterContextMessages(c);
            // Increased context from 20 to 50
            const chatContext = recentMsgs.map(m => {
                const role = m.role === 'user' ? '用户' : c.name;
                return `${role}: ${m.content.substring(0, 50)}`; 
            }).join('\n');

            // Time Gap Calculation
            const lastMsg = recentMsgs[recentMsgs.length - 1];
            const timeGapHint = getTimeGapHint(lastMsg?.timestamp);

            await injectMemoryPalace(c, recentMsgs);
            const characterContextInput = { char: c, user: userProfile, includeDetailedMemories: true };


            // DEBUG FIX: Sanitize and truncate interactables context to prevent huge Base64 leakage
            const interactables = currentItems.filter(i => i.isInteractive).map(i => ({
                id: i.id,
                name: i.name,
                context: (i.descriptionPrompt || '').substring(0, 200)
            }));

            let prompt = `

### [Environment Context - Critical]
**当前现实时间**: ${nowDateStr} ${nowTimeStr}${tzSuffix}
**与用户上次互动距离现在**: ${timeGapHint}
**最近互动记录 (Latest 50)**:
${chatContext}

### [Room Initialization - Batch Generation]
用户进入了**你的**房间。请一次性生成房间的状态、物品交互文本，以及（如果需要）你今天的计划和随笔。

### 1. 房间状态 (Status)
- **ActorStatus**: 你现在在房间里做什么？(请严格基于当前时间${nowTimeStr}和时间差${timeGapHint}来推断。如果是深夜可能在睡觉，如果很久没见可能在发呆。)
- **Welcome**: 看到用户进来，你第一句话说什么？(请结合时间差：如果很久没见，是惊讶、想念还是生气？)

### 2. 物品交互 (Items)
房间里有以下物品：
${JSON.stringify(interactables)}

请为**每一个**物品生成：
- **Description**: 旁白视角的物品外观/状态描写。
- **Reaction**: 当用户查看这个物品时，你(角色)的吐槽或反应。

### 3. [OPTIONAL] 今日待办清单 (Daily To-Do)
${!shouldGenerateTodo ? `(系统: 今日待办已存在，无需生成，请忽略此项)` : `(系统: 请生成 3-5 条你今天打算做的事。)`}

### 4. 记事簿随笔 (Notebook Entry)
请在你的私密记事簿上写点什么。
**要求**：
1. **风格多变**：可以是刚写的歌词、随笔感悟、心情记录、或者是一首短诗、一份购物清单。
2. **严禁代码**：**严禁**生成代码块(Code Blocks)或伪代码，除非你的核心设定明确是程序员。请像正常人写日记一样自然。
3. **格式丰富**：请积极使用 **Markdown** 格式让排版更有趣。
4. **内容新颖**：必须是新的内容，展示你作为独立个体的思考。

### 输出格式 (Strict JSON)
{
  "actorStatus": "...",
  "welcomeMessage": "...",
  "items": {
    "item_id": { "description": "...", "reaction": "..." }
  },
  ${shouldGenerateTodo ? `"todoList": ["task 1", "task 2"],` : ''}
  "notebookEntry": { "content": "markdown string...", "type": "thought" }
}
`;
            // DEBUG: Save prompt for inspection
            setLastPrompt(prompt);
            // CONSOLE LOG REMOVED FOR PRODUCTION CLEANUP

            // FIX: Add Safety Settings & Lower Temperature
            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({ 
                    model: apiConfig.model,
                    messages: (await ContextBuilder.buildCharacterRequest(characterContextInput, [{ role: "user", content: prompt }])),
                    temperature: 0.5, // Lower temp for stability
                    max_tokens: 8000,
                    // Safety Settings injection for Gemini-based proxies
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                    ]
                })
            });

            if (response.ok) {
                const data = await safeResponseJson(response);
                let content = data.choices?.[0]?.message?.content || "";
                
                // CRITICAL FIX: Empty content check triggers fallback
                if (!content) {
                    throw new Error("AI returned empty response (Safety Block suspected).");
                }

                // 用鲁棒的 extractJson 兜底：会处理 markdown 围栏、前后多余文字、尾随逗号、
                // 单引号、未转义的内层引号、被截断的 JSON、{"result":{...}} 包裹等常见掉格式情况。
                const result = extractJson(content);
                if (!result) throw new Error("JSON Parse Failed");
                
                setAiBubble({ text: result.welcomeMessage || "Welcome!", visible: true });
                if (result.items) setRoomDescriptions(result.items);

                updateCharacter(c.id, {
                    lastRoomDate: todayStr,
                    savedRoomState: {
                        actorStatus: result.actorStatus,
                        welcomeMessage: result.welcomeMessage,
                        items: result.items || {},
                        actorAction: 'idle'
                    }
                });

                // 2. Handle To-Do (Only if we requested it)
                if (shouldGenerateTodo && result.todoList && Array.isArray(result.todoList)) {
                    const newTodo: RoomTodo = {
                        id: `${c.id}_${todayStr}`,
                        charId: c.id,
                        date: todayStr,
                        items: result.todoList.map((t: string) => ({ text: t, done: false })),
                        generatedAt: Date.now()
                    };
                    await DB.saveRoomTodo(newTodo);
                    setTodaysTodo(newTodo);
                    
                    await DB.saveMessage({
                        charId: c.id,
                        role: 'system',
                        type: 'text',
                        content: `[系统: ${c.name} 制定了今日计划: ${result.todoList.join(', ')}]`
                    });
                }

                // 3. Handle Notebook
                if (result.notebookEntry) {
                    // Create message first to get ID
                    const msgContent = `[系统: ${c.name} 在记事本上写道: \n"${result.notebookEntry.content}"]`;
                    
                    const msgId = await DB.saveMessage({
                        charId: c.id,
                        role: 'system',
                        type: 'text',
                        content: msgContent
                    });

                    const newNote: RoomNote = {
                        id: `note-${Date.now()}`,
                        charId: c.id,
                        timestamp: Date.now(),
                        content: result.notebookEntry.content,
                        type: result.notebookEntry.type || 'thought',
                        relatedMessageId: msgId
                    };
                    await DB.saveRoomNote(newNote);
                    setNotebookEntries(prev => [newNote, ...prev]);
                }

            } else { throw new Error(`API Error ${response.status}`); }

        } catch (e: any) { 
            console.error("Room Init Failed, switching to Fallback", e); 
            // Trigger Fallback
            await initializeFallback(c);
        } finally { 
            clearInterval(textInterval); 
            setIsInitializing(false); 
        }
    };

    const handleLookAt = async (item: RoomItem, e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        if (mode === 'edit') { setSelectedItemId(item.id); return; }
        if (!char) return;
        
        // Character Movement Constraint: Keep feet below horizon line
        // FIX: Place actor visually "In Front" of furniture (lower Y = closer to camera in 2.5D top-down)
        const targetY = Math.max(FLOOR_HORIZON, item.y + 5); 
        
        setActorState({ x: item.x, y: targetY, action: 'walk' });
        setTimeout(() => setActorState(prev => ({ ...prev, action: 'interact' })), 600);
        trackEvent('观察房间里的家具');

        const cached = roomDescriptions[item.id] || roomDescriptions[item.name];
        if (cached) {
            setObservationText(cached.description);
            setAiBubble({ text: cached.reaction, visible: true });
            
            const contentToCheck = `[${userProfile.name}]在[${char.name}]的${item.name}上看到了：${cached.description}。[${char.name}]表示：${cached.reaction}`;
            const recentMsgs = await DB.getMessagesByCharId(char.id);
            const isDuplicate = recentMsgs.slice(-50).some(m => m.role === 'system' && m.content === contentToCheck);

            if (!isDuplicate) {
                try { 
                    await DB.saveMessage({ charId: char.id, role: 'system', type: 'text', content: contentToCheck }); 
                } catch (err) {}
            }
        } else {
            setObservationText(`${item.name}静静地摆放在那里。`);
            setAiBubble({ text: "(盯...)", visible: true });
        }
    };

    const handlePokeActor = () => {
        if (mode === 'edit') { setShowActorArtModal(true); return; }
        setActorState(prev => ({ ...prev, action: 'bounce' }));
        setTimeout(() => setActorState(prev => ({ ...prev, action: 'idle' })), 500);
        const thoughts = ["嗯？", "别闹...", "我在呢。", "盯着我看干嘛...", "(发呆)"];
        setAiBubble({ text: thoughts[Math.floor(Math.random() * thoughts.length)], visible: true });
        trackEvent('戳一戳角色');
    };

    const handleToggleTodo = async (index: number) => {
        if (!todaysTodo) return;
        const newItems = [...todaysTodo.items];
        newItems[index].done = !newItems[index].done;
        const newTodo = { ...todaysTodo, items: newItems };
        setTodaysTodo(newTodo);
        await DB.saveRoomTodo(newTodo);
    };

    // --- Deletion Handlers (Point 5) ---
    const handleDeleteTodo = async (index: number) => {
        if (!todaysTodo) return;
        const newItems = todaysTodo.items.filter((_, i) => i !== index);
        const newTodo = { ...todaysTodo, items: newItems };
        setTodaysTodo(newTodo);
        await DB.saveRoomTodo(newTodo);
        addToast('条目已删除', 'success');
    };

    const handleDeleteNote = async (id: string) => {
        const note = notebookEntries.find(n => n.id === id);
        if (note && note.relatedMessageId) {
            await DB.deleteMessage(note.relatedMessageId);
        }
        await DB.deleteRoomNote(id);
        setNotebookEntries(prev => prev.filter(n => n.id !== id));
        addToast('笔记已彻底粉碎 (相关记录已清除)', 'success');
    };

    const handleStageClick = (e: React.MouseEvent) => {
        if (mode === 'edit') {
            // 捏合刚松手时浏览器补发的 click 不算「点空白取消选中」
            if (Date.now() - lastPinchEndRef.current < 400) return;
            setSelectedItemId(null);
            return;
        }
        // View mode: Move actor
        if (!roomRef.current) return;
        const rect = roomRef.current.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        
        // Constrain to floor: allow climbing a bit, but mostly keep below horizon
        const targetY = Math.max(FLOOR_HORIZON - 5, y);
        
        setActorState({
            x,
            y: targetY,
            action: 'walk'
        });
        setTimeout(() => setActorState(prev => ({ ...prev, action: 'idle' })), 600);
        
        // Clear bubbles
        setAiBubble({ text: '', visible: false });
        setObservationText('');
    };

    // --- Edit Logic ---
    // 提交一份新 items：立即上屏 + 落库（并作废还没触发的滑杆防抖写，避免旧值覆盖新值）
    const commitItems = (newItems: RoomItem[]) => {
        if (saveDebounceRef.current) { clearTimeout(saveDebounceRef.current); saveDebounceRef.current = null; }
        setItems(newItems);
        if (char) { updateCharacter(char.id, { roomConfig: { ...char.roomConfig, items: newItems } }); }
    };

    // 把「当前 items」推入撤销栈。key 以 cont: 开头的连续手势（滑杆/滚轮/微调）
    // 在 1.2s 内只记一条；离散操作（增删/拖拽落点/导入）每次都记。栈深 40。
    const recordHistory = (key: string = 'op') => {
        const now = Date.now();
        const last = lastHistoryKeyRef.current;
        lastHistoryKeyRef.current = { key, t: now };
        if (key.startsWith('cont:') && key === last.key && now - last.t < 1200) return;
        setHistory(h => [...h.slice(-39), items]);
        setFuture([]);
    };

    const saveRoom = (newItems: RoomItem[]) => { recordHistory('op'); commitItems(newItems); };

    const undo = () => {
        if (!history.length) return;
        const prev = history[history.length - 1];
        setHistory(h => h.slice(0, -1));
        setFuture(f => [...f.slice(-39), items]);
        lastHistoryKeyRef.current = { key: '', t: 0 };
        setSelectedItemId(null);
        commitItems(prev);
    };
    const redo = () => {
        if (!future.length) return;
        const next = future[future.length - 1];
        setFuture(f => f.slice(0, -1));
        setHistory(h => [...h.slice(-39), items]);
        lastHistoryKeyRef.current = { key: '', t: 0 };
        setSelectedItemId(null);
        commitItems(next);
    };

    // Updated addItem to accept description
    // 不再关闭家具库弹窗：可以连点批量摆放；落点带一点随机抖动，避免完全叠死在同一处
    const addItem = (asset: {name: string, image: string, defaultScale: number, description?: string}, type: 'furniture' | 'decor' | 'rug') => {
        const newItem: RoomItem = {
            // 连点批量添加可能落在同一毫秒，加随机后缀防止 id 撞车
            id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: asset.name,
            type: type,
            image: asset.image,
            x: 44 + Math.random() * 12,
            y: 46 + Math.random() * 12,
            scale: asset.defaultScale,
            rotation: 0,
            isInteractive: true,
            descriptionPrompt: asset.description // New Field
        };
        saveRoom([...items, newItem]);
        addToast(`已添加: ${asset.name}`, 'success');
        // 只上报这三个写死的分类，其它一律归到 furniture，别把素材分类名原样透出去
        trackEvent('摆放一件家具', { type: type === 'rug' ? 'rug' : (type === 'decor' ? 'decor' : 'furniture') });
    };

    // PERF: Update items in state immediately (visual), but debounce DB persistence
    const updateSelectedItem = (updates: Partial<RoomItem>, gestureKey: string = 'cont:adjust') => {
        if (!selectedItemId) return;
        recordHistory(gestureKey);
        const newItems = items.map(i => i.id === selectedItemId ? { ...i, ...updates } : i);
        setItems(newItems); // Instant visual update
        // Debounce the DB write (300ms) - prevents IndexedDB thrashing from sliders
        if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
        saveDebounceRef.current = setTimeout(() => {
            if (char) {
                updateCharacter(char.id, { roomConfig: { ...char.roomConfig, items: newItems } });
            }
        }, 300);
    };
    const deleteSelectedItem = () => { if (!selectedItemId) return; saveRoom(items.filter(i => i.id !== selectedItemId)); setSelectedItemId(null); };

    const duplicateSelectedItem = () => {
        const src = items.find(i => i.id === selectedItemId);
        if (!src) return;
        const copy: RoomItem = { ...src, id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, x: Math.min(96, src.x + 4), y: Math.min(100, src.y + 4) };
        saveRoom([...items, copy]);
        setSelectedItemId(copy.id);
        addToast(`已复制: ${src.name}`, 'success');
        trackEvent('复制选中的家具');
    };

    // 十字键微调：拖不准时一格一格挪（每格 1%）
    const nudgeSelectedItem = (dx: number, dy: number) => {
        const sel = items.find(i => i.id === selectedItemId);
        if (!sel) return;
        updateSelectedItem({
            x: Math.max(0, Math.min(100, sel.x + dx)),
            y: Math.max(0, Math.min(100, sel.y + dy)),
        }, 'cont:nudge');
    };
    const handleWallChange = (bg: string) => { if (char) updateCharacter(char.id, { roomConfig: { ...char.roomConfig, items, wallImage: bg } }); };
    const handleFloorChange = (bg: string) => { if (char) updateCharacter(char.id, { roomConfig: { ...char.roomConfig, items, floorImage: bg } }); };
    const openActorStudio = () => {
        if (!char) return;
        characterLaunch.request({ charId: char.id, openChibiStudio: true });
        setActiveCharacterId(char.id);
        setShowActorArtModal(false);
        openApp(AppID.Character);
    };
    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>, target: 'wall' | 'floor' | 'actor' | 'custom_item') => { 
        const file = e.target.files?.[0]; 
        if (file) { 
            try {
                // Force high quality for custom item uploads
                const processOptions = target === 'custom_item' ? { quality: 1.0, maxWidth: 2048 } : undefined;
                // 改存 Blob：压缩后二进制进 blob_assets，字段只存 blobref 令牌（省 ~33% 空间、不占 JS 堆）。
                const blob = await processImageToBlob(file, processOptions);
                const ref = await putImageBlob(blob);

                if (target === 'wall') handleWallChange(ref);
                if (target === 'floor') handleFloorChange(ref);
                if (target === 'actor') {
                    if (char) {
                        const newSprites = { ...(char.sprites || {}), 'chibi': ref };
                        updateCharacter(char.id, { sprites: newSprites });
                        addToast('角色房间立绘已更新', 'success');
                    }
                }
                if (target === 'custom_item') {
                    setCustomItemImage(ref);
                }
            } catch (err: any) {
                addToast(err.message, 'error'); 
            } 
        } 
    };
    
    // Custom Item Save
    // Helper: persist allCustomAssets to DB
    const persistAssets = async (assets: CustomAsset[]) => {
        setAllCustomAssets(assets);
        await DB.saveAsset('room_custom_assets_list', JSON.stringify(assets));
    };

    const saveCustomItem = async () => {
        const imageToUse = customItemUrl || customItemImage;
        if(!customItemName.trim() || !imageToUse) { addToast('请填写完整信息', 'error'); return; }

        addItem({
            name: customItemName,
            image: imageToUse,
            defaultScale: 1.0,
            description: customItemDescription || undefined
        }, customItemType);

        const newAsset: CustomAsset = {
            id: `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: customItemName,
            image: imageToUse,
            defaultScale: 1.0,
            description: customItemDescription || undefined,
            visibility: 'public',
            itemType: customItemType,
        };
        await persistAssets([...allCustomAssets, newAsset]);

        setShowCustomModal(false);
        setCustomItemName('');
        setCustomItemImage('');
        setCustomItemUrl('');
        setCustomItemDescription('');
        setCustomItemType('furniture');
    };

    // Long-press on custom asset → open edit modal
    const handleAssetTouchStart = (asset: CustomAsset) => {
        assetLongPressTimer.current = setTimeout(() => {
            setEditingAsset(asset);
            setEditName(asset.name);
            setEditDescription(asset.description || '');
            setEditImage(asset.image);
            setEditVisibility(asset.visibility);
            setEditAssignedCharIds(asset.assignedCharIds || []);
            setEditItemType(asset.itemType || 'furniture');
        }, 600);
    };

    const handleAssetTouchEnd = () => {
        if (assetLongPressTimer.current) {
            clearTimeout(assetLongPressTimer.current);
            assetLongPressTimer.current = null;
        }
    };

    const saveEditingAsset = async () => {
        if (!editingAsset) return;
        const updated = allCustomAssets.map(a => a.id === editingAsset.id ? {
            ...a,
            name: editName.trim() || a.name,
            description: editDescription || undefined,
            image: editImage || a.image,
            visibility: editVisibility,
            assignedCharIds: editVisibility === 'character' ? editAssignedCharIds : undefined,
            itemType: editItemType,
        } : a);
        await persistAssets(updated);
        setEditingAsset(null);
        addToast('素材已更新', 'success');
    };

    const deleteEditingAsset = async () => {
        if (!editingAsset) return;
        const filtered = allCustomAssets.filter(a => a.id !== editingAsset.id);
        await persistAssets(filtered);
        setEditingAsset(null);
        addToast('素材已删除', 'success');
    };

    // New: Handle Background Config Update
    const updateBgConfig = (updates: Partial<CharacterProfile['roomConfig']>) => {
        if (!char) return;
        updateCharacter(char.id, {
            roomConfig: { ...char.roomConfig, ...updates, items } // Ensure items are preserved
        });
    };

    // New: Reset Sully
    const resetSullyRoom = () => {
        if (!char) return;
        saveRoom(SULLY_FURNITURE);
        setShowSettingsModal(false);
        addToast('Sully 的房间已还原', 'success');
    };

    // --- Export Room Template（装修模式导出「当前小屋」为样板房） ---
    // 位置 x/y 是相对房间的百分比（0-100），任何屏幕尺寸都能按原样复原。
    // 图像：图床/http 链接原样保留；上传图（blobref/base64）统一解析成 data URL 内嵌，
    // 导出文件自包含，不依赖本机 IndexedDB。
    const buildRoomTemplate = async () => {
        const template = {
            schema: 'sullyos.room-template.v1',
            name: exportName.trim() || `${char?.name || '未命名'}的小屋`,
            description: exportDescription.trim(),
            exportedAt: new Date().toISOString(),
            room: {
                wallImage: char?.roomConfig?.wallImage || '',
                wallScale: char?.roomConfig?.wallScale,
                wallRepeat: char?.roomConfig?.wallRepeat,
                floorImage: char?.roomConfig?.floorImage || '',
                floorScale: char?.roomConfig?.floorScale,
                floorRepeat: char?.roomConfig?.floorRepeat,
            },
            items: items.map(i => ({
                name: i.name,
                type: i.type,
                image: i.image,
                x: i.x,
                y: i.y,
                scale: i.scale,
                rotation: i.rotation,
                isInteractive: i.isInteractive,
                description: i.descriptionPrompt || '',
            })),
        };
        // Older builds persisted built-in assets as deployment-specific absolute URLs.
        // Canonicalize them before exporting a standalone room template as well.
        if (template.room) {
            template.room.wallImage = toPortableBuiltinRoomAsset(template.room.wallImage) as string;
            template.room.floorImage = toPortableBuiltinRoomAsset(template.room.floorImage) as string;
        }
        for (const item of template.items) item.image = toPortableBuiltinRoomAsset(item.image) as string;
        await resolveBlobRefsDeep(template);
        return template;
    };

    const handleExportRoom = async (action: 'download' | 'copy') => {
        setIsExporting(true);
        try {
            const template = await buildRoomTemplate();
            const json = JSON.stringify(template, null, 2);
            if (action === 'copy') {
                await navigator.clipboard.writeText(json);
                addToast('小屋 JSON 已复制到剪贴板', 'success');
            } else {
                const result = await shareOrDownloadFile({
                    card: { kind: 'room', title: template.name },
                    content: json,
                    fileName: `${template.name.replace(/[\\/:*?"<>|]/g, '_')}.room.json`,
                    mimeType: 'application/json;charset=utf-8',
                    shareTitle: `小屋样板房：${template.name}`,
                });
                if (result === 'cancelled') return;
                addToast(result === 'shared' ? '已打开小屋样板房分享面板' : '小屋样板房已导出', 'success');
            }
            trackEvent('导出小屋样板房', { action });
        } catch (e: any) {
            addToast(`导出失败: ${e?.message || e}`, 'error');
        } finally {
            setIsExporting(false);
        }
    };

    // --- 批量导入自定义素材（一次选多张图，全部入库为公共素材，名字取文件名） ---
    const handleBatchAssetImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        if (!files.length) return;
        setIsBatchImporting(true);
        const imported: CustomAsset[] = [];
        let failed = 0;
        for (const file of files) {
            try {
                const blob = await processImageToBlob(file, { quality: 1.0, maxWidth: 2048 });
                const ref = await putImageBlob(blob);
                imported.push({
                    id: `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    name: file.name.replace(/\.[^.]+$/, '').slice(0, 24) || '未命名',
                    image: ref,
                    defaultScale: 1.0,
                    visibility: 'public',
                    itemType: 'furniture',
                });
            } catch { failed++; }
        }
        if (imported.length) await persistAssets([...allCustomAssets, ...imported]);
        addToast(
            failed
                ? `已导入 ${imported.length} 件素材，${failed} 件失败`
                : `已批量导入 ${imported.length} 件素材，在「家具超市 · 自定义」里摆放`,
            failed ? 'info' : 'success'
        );
        trackEvent('批量导入家具素材');
        setIsBatchImporting(false);
        if (imported.length) setShowLibrary(true);
    };

    // --- 导入小屋样板房（导出的另一半）：读 .room.json，确认后替换或合并 ---
    const handleImportRoomFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
            const data = JSON.parse(await readShareText(file, 'room'));
            if (!data || !Array.isArray(data.items)) throw new Error('缺少 items，不是有效的小屋样板房文件');
            setPendingImport(data);
        } catch (err: any) {
            addToast(`无法读取小屋文件: ${err?.message || err}`, 'error');
        }
    };

    const loadBuiltInRoomTemplate = async (template: BuiltInRoomTemplate) => {
        const res = await fetch(template.templateUrl);
        if (!res.ok) throw new Error(`无法读取样板房 ${template.name}`);
        const data = await res.json();
        if (!data || !Array.isArray(data.items)) throw new Error('样板房数据无效');
        // Store built-in assets as deployment-independent references. TokenImg/useBlobRefUrl
        // resolves them against the *current* BASE_URL when rendering, so full backups can
        // move between web origins, GitHub Pages sub-paths, and the desktop shell.
        normalizeBuiltInRoomTemplateAssetsInPlace(data, template.id);
        return data;
    };

    const openBuiltInRoomTemplate = async (template: BuiltInRoomTemplate) => {
        setSampleRoomLoadingId(template.id);
        try {
            setPendingImport(await loadBuiltInRoomTemplate(template));
            setShowLibrary(false);
        } catch (err: any) {
            addToast(`无法打开样板房: ${err?.message || err}`, 'error');
        } finally {
            setSampleRoomLoadingId(null);
        }
    };

    const applyRoomTemplateData = async (templateData: any, importMode: 'replace' | 'merge') => {
        if (!templateData || !char) return;
        setIsImportingRoom(true);
        try {
            // 内嵌的 base64 图统一转回 blobref 落库；图床/http 链接原样保留
            const toRef = async (img: any): Promise<string> => {
                if (typeof img !== 'string' || !img) return '';
                return img.startsWith('data:') ? await migrateDataUrlToRef(img) : img;
            };
            const clampNum = (v: any, def: number, min: number, max: number) => {
                const n = Number(v);
                return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
            };
            const stamp = Date.now();
            const importedItems: RoomItem[] = [];
            for (let i = 0; i < templateData.items.length; i++) {
                const it = templateData.items[i] || {};
                const image = await toRef(toPortableBuiltinRoomAsset(it.image));
                if (!image) continue;
                const desc = typeof it.description === 'string' && it.description
                    ? it.description
                    : (typeof it.descriptionPrompt === 'string' && it.descriptionPrompt ? it.descriptionPrompt : undefined);
                importedItems.push({
                    id: `item-${stamp}-${i}`,
                    name: typeof it.name === 'string' && it.name ? it.name : `物品${i + 1}`,
                    type: it.type === 'rug' ? 'rug' : (it.type === 'decor' ? 'decor' : 'furniture'),
                    image,
                    x: clampNum(it.x, 50, 0, 100),
                    y: clampNum(it.y, 60, 0, 100),
                    scale: clampNum(it.scale, 1, 0.2, 6),
                    rotation: clampNum(it.rotation, 0, -180, 180),
                    isInteractive: it.isInteractive !== false,
                    descriptionPrompt: desc,
                });
            }
            recordHistory('op');
            const newItems = importMode === 'merge' ? [...items, ...importedItems] : importedItems;
            if (saveDebounceRef.current) { clearTimeout(saveDebounceRef.current); saveDebounceRef.current = null; }
            setItems(newItems);
            if (importMode === 'replace' && templateData.room) {
                // 替换模式连墙面/地板一起应用（合并模式只追加物品，不动背景）
                const r = templateData.room;
                const wallImage = await toRef(toPortableBuiltinRoomAsset(r.wallImage));
                const floorImage = await toRef(toPortableBuiltinRoomAsset(r.floorImage));
                updateCharacter(char.id, {
                    roomConfig: {
                        ...char.roomConfig,
                        items: newItems,
                        ...(wallImage ? { wallImage, wallScale: Number(r.wallScale) || undefined, wallRepeat: !!r.wallRepeat } : {}),
                        ...(floorImage ? { floorImage, floorScale: Number(r.floorScale) || undefined, floorRepeat: !!r.floorRepeat } : {}),
                    },
                });
            } else {
                updateCharacter(char.id, { roomConfig: { ...char.roomConfig, items: newItems } });
            }
            addToast(`已导入 ${importedItems.length} 件物品${importMode === 'replace' ? '（替换原布局）' : ''}`, 'success');
            return true;
        } catch (err: any) {
            addToast(`导入失败: ${err?.message || err}`, 'error');
            return false;
        } finally {
            setIsImportingRoom(false);
        }
    };

    const applyRoomImport = async (importMode: 'replace' | 'merge') => {
        if (!pendingImport) return;
        const ok = await applyRoomTemplateData(pendingImport, importMode);
        if (ok) {
            setPendingImport(null);
            trackEvent('导入小屋样板房', { mode: importMode });
        }
    };

    const chooseSampleRoom = async (template: BuiltInRoomTemplate) => {
        if (!char) return;
        trackEvent('套用内置样板房', { template: template.id });
        setSampleRoomLoadingId(template.id);
        try {
            const data = await loadBuiltInRoomTemplate(template);
            const ok = await applyRoomTemplateData(data, 'replace');
            if (ok) {
                localStorage.setItem(`${SAMPLE_ROOM_DISMISS_PREFIX}${char.id}`, '1');
                setShowSampleRoomOffer(false);
            }
        } catch (err: any) {
            addToast(`样板房导入失败: ${err?.message || err}`, 'error');
        } finally {
            setSampleRoomLoadingId(null);
        }
    };

    const dismissSampleRoomOffer = () => {
        if (char) localStorage.setItem(`${SAMPLE_ROOM_DISMISS_PREFIX}${char.id}`, '1');
        setShowSampleRoomOffer(false);
    };

    // --- PERF FIX: Direct DOM Dragging (bypasses React re-renders) ---
    // During drag: manipulate DOM directly via element.style
    // On drop: sync final position to React state once
    // 双指捏合：第一指已在拖某件家具时，第二指落下（无论落在哪）即升级为捏合。
    // 需要两指坐标齐全 + 拖拽上下文（房间尺寸）才真正开始。
    const tryStartPinch = () => {
        if (pinchRef.current || !draggingIdRef.current || !dragStartRef.current) return;
        if (activePointersRef.current.size !== 2) return;
        const item = items.find(i => i.id === draggingIdRef.current);
        if (!item) return;
        const ids = [...activePointersRef.current.keys()];
        const [p1, p2] = [...activePointersRef.current.values()];
        pinchRef.current = {
            id1: ids[0], id2: ids[1],
            startDist: Math.max(10, Math.hypot(p2.x - p1.x, p2.y - p1.y)),
            startAngle: Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI,
            startMidX: (p1.x + p2.x) / 2,
            startMidY: (p1.y + p2.y) / 2,
            baseScale: item.scale,
            baseRotation: item.rotation,
            // 位置基准取拖拽中的实时位置（捏合前可能已经拖了一段）
            baseX: pendingDragPos.current?.x ?? item.x,
            baseY: pendingDragPos.current?.y ?? item.y,
            width: dragStartRef.current.width,
            height: dragStartRef.current.height,
        };
    };

    // 旋转角规整到 [-180, 180]
    const normRot = (r: number) => {
        let v = ((r + 180) % 360 + 360) % 360 - 180;
        return Math.round(v);
    };

    // 舞台层 pointerdown：只负责捕捉「拖拽中落下的第二指」（第二指落在空白处时）
    const handleStagePointerDown = (e: React.PointerEvent) => {
        if (mode !== 'edit' || !draggingIdRef.current) return;
        activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        tryStartPinch();
    };

    const handlePointerDown = (e: React.PointerEvent, id: string) => {
        if (mode !== 'edit') return;
        e.preventDefault();
        e.stopPropagation();
        activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

        // 已经有一根手指在拖：这根新手指升级为捏合，不开新的拖拽
        if (draggingIdRef.current && dragPointerIdRef.current !== null && e.pointerId !== dragPointerIdRef.current) {
            tryStartPinch();
            return;
        }

        e.currentTarget.setPointerCapture(e.pointerId);
        dragPointerIdRef.current = e.pointerId;

        const item = items.find(i => i.id === id);
        if (!item || !roomRef.current) return;

        const rect = roomRef.current.getBoundingClientRect();

        dragStartRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            initialItemX: item.x,
            initialItemY: item.y,
            width: rect.width,
            height: rect.height
        };

        // Store refs for direct DOM access (no React re-renders during drag)
        draggingIdRef.current = id;
        dragElementRef.current = e.currentTarget as HTMLElement;
        if (dragElementRef.current) {
            dragElementRef.current.style.transition = 'none';
            dragElementRef.current.style.zIndex = '100';
            dragElementRef.current.style.willChange = 'left, top';
        }

        setDraggingId(id);
        setSelectedItemId(id);
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        // Fast-path: skip entirely if not dragging (avoids any work on passive touch)
        if (!draggingIdRef.current || !dragStartRef.current) return;

        e.preventDefault();
        if (activePointersRef.current.has(e.pointerId)) {
            activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }

        // 捏合中：双指距离→缩放、双指连线转角→旋转（0°/±90°/180° 附近吸附）、中点位移→移动
        const pinch = pinchRef.current;
        if (pinch) {
            const p1 = activePointersRef.current.get(pinch.id1);
            const p2 = activePointersRef.current.get(pinch.id2);
            if (!p1 || !p2) return;
            const d = Math.max(10, Math.hypot(p2.x - p1.x, p2.y - p1.y));
            const a = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI;
            const scale = Math.min(6, Math.max(0.2, pinch.baseScale * (d / pinch.startDist)));
            let rotation = normRot(pinch.baseRotation + (a - pinch.startAngle));
            const snapTo = [-180, -90, 0, 90, 180].find(s => Math.abs(rotation - s) <= 5);
            if (snapTo !== undefined) rotation = normRot(snapTo);
            const midX = (p1.x + p2.x) / 2, midY = (p1.y + p2.y) / 2;
            pendingDragPos.current = {
                x: Math.max(0, Math.min(100, pinch.baseX + ((midX - pinch.startMidX) / pinch.width) * 100)),
                y: Math.max(0, Math.min(100, pinch.baseY + ((midY - pinch.startMidY) / pinch.height) * 100)),
            };
            pendingPinchRef.current = { scale, rotation };
            if (!rafRef.current) {
                rafRef.current = requestAnimationFrame(() => {
                    const el = dragElementRef.current;
                    if (el && pendingDragPos.current && pendingPinchRef.current) {
                        el.style.left = `${pendingDragPos.current.x}%`;
                        el.style.top = `${pendingDragPos.current.y}%`;
                        el.style.width = `${80 * pendingPinchRef.current.scale}px`;
                        el.style.transform = `translate(-50%, -100%) rotate(${pendingPinchRef.current.rotation}deg)`;
                    }
                    rafRef.current = null;
                });
            }
            return;
        }

        // 单指拖拽只认主手指，忽略途中扫过的其它触点
        if (dragPointerIdRef.current !== null && e.pointerId !== dragPointerIdRef.current) return;

        const { startX, startY, initialItemX, initialItemY, width, height } = dragStartRef.current;
        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        const nextX = Math.max(0, Math.min(100, initialItemX + (deltaX / width) * 100));
        const nextY = Math.max(0, Math.min(100, initialItemY + (deltaY / height) * 100));

        // Store pending position
        pendingDragPos.current = { x: nextX, y: nextY };

        // Throttle DOM updates via requestAnimationFrame (once per frame, ~16ms)
        if (!rafRef.current) {
            rafRef.current = requestAnimationFrame(() => {
                if (dragElementRef.current && pendingDragPos.current) {
                    // Direct DOM manipulation - NO React re-render
                    dragElementRef.current.style.left = `${pendingDragPos.current.x}%`;
                    dragElementRef.current.style.top = `${pendingDragPos.current.y}%`;
                }
                rafRef.current = null;
            });
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        activePointersRef.current.delete(e.pointerId);
        if (!draggingIdRef.current) return;

        // Cancel any pending rAF
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }

        // Restore element styles
        if (dragElementRef.current) {
            dragElementRef.current.style.willChange = '';
            dragElementRef.current.style.transition = '';
            dragElementRef.current.style.zIndex = '';
        }

        const wasPinch = !!pinchRef.current;
        const finalPinch = pendingPinchRef.current;

        // Sync final position (and pinch scale/rotation) to React state (only if moved)
        if (pendingDragPos.current || finalPinch) {
            const finalPos = pendingDragPos.current;
            const dragId = draggingIdRef.current;

            recordHistory('op');
            const newItems = items.map(item => item.id === dragId ? {
                ...item,
                ...(finalPos ? { x: finalPos.x, y: finalPos.y } : {}),
                ...(finalPinch ? { scale: finalPinch.scale, rotation: finalPinch.rotation } : {}),
            } : item);
            commitItems(newItems);
        }

        // Cleanup all refs（任意一指抬起都结束整次手势，剩下那根手指不再拖动）
        draggingIdRef.current = null;
        dragElementRef.current = null;
        dragPointerIdRef.current = null;
        pendingDragPos.current = null;
        pendingPinchRef.current = null;
        pinchRef.current = null;
        dragStartRef.current = null;
        activePointersRef.current.clear();
        if (wasPinch) lastPinchEndRef.current = Date.now();
        setDraggingId(null);
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch(_) {}
    };

    // --- Renderers ---

    // 3D VISIT SCREEN
    if (viewState === 'home3D' && char) {
        return <React.Suspense fallback={<div className="h-full grid place-items-center bg-[#e8dde7] text-sm text-purple-700">正在打开小屋…</div>}>
            <Home3DView key={char.id} suspended={activeApp!==AppID.Room} character={char} onDefinitionChange={value => updateCharacter(char.id, { homeDefinition: value })} residents={[...(userProfile.vrState?.chibi?.state?[{id:'user',label:userProfile.name||'你',state:userProfile.vrState.chibi.state}]:[]),...characters.filter(c=>c.id!==char.id&&(c.chibiStudio?.home3D?.state||c.chibiStudio?.room?.state||c.chibiStudio?.vr?.state)).map(c=>({id:c.id,label:c.name,avatar:c.avatar,state:c.chibiStudio?.home3D?.state??c.chibiStudio?.room?.state??c.chibiStudio?.vr?.state,hair:c.chibiStudio?.home3D?.hair}))]} value={char.home3D} onChange={value => updateCharacter(char.id, { home3D: value })} onBack={() => { if (launchedFromDesktopRef.current) closeApp(); else setViewState('select'); }} />
        </React.Suspense>;
    }
    // SELECT SCREEN
    if (viewState === 'select') {
        // 3D 拜访=深色，小小窝/家园=浅色（参考稿）
        const dark = homeTab === 'home3D';
        const th = dark ? {
            pageBg: 'linear-gradient(180deg,#0c1024 0%,#141031 45%,#1a1330 100%)',
            stars: 'radial-gradient(1px 1px at 12% 18%,rgba(255,255,255,.5),transparent),radial-gradient(1px 1px at 78% 12%,rgba(255,230,180,.5),transparent),radial-gradient(1.5px 1.5px at 40% 30%,rgba(207,226,255,.4),transparent),radial-gradient(1px 1px at 88% 40%,rgba(255,255,255,.4),transparent),radial-gradient(1px 1px at 24% 64%,rgba(255,255,255,.35),transparent),radial-gradient(1px 1px at 64% 78%,rgba(255,230,180,.35),transparent)',
            back: 'text-amber-100/70 hover:text-amber-100',
            title: '#fdf6ee', titleShadow: 'rgba(180,160,255,.45)',
            line: 'rgba(212,185,120,.55)', sub: 'text-amber-200/70',
            tabWrapBg: 'rgba(255,255,255,.04)', tabWrapBorder: 'rgba(212,185,120,.25)',
            tabActive: { background: 'linear-gradient(180deg,rgba(124,92,180,.5),rgba(80,60,140,.35))', color: '#f4ecff', border: '1px solid rgba(190,160,255,.4)', boxShadow: '0 0 18px rgba(150,110,220,.4)' } as React.CSSProperties,
            tabIdle: 'rgba(220,215,240,.55)', diamond: '#b89cff',
            desc: 'text-amber-100/45', empty: 'text-amber-100/40',
            tints: ROOM_CARD_TINTS, cardBorder: 'rgba(212,185,120,.28)', cardShadow: '0 10px 26px rgba(0,0,0,.4)',
            inner: 'rgba(212,185,120,.22)', gem: 'rgba(226,200,130,.7)',
            tick: 'rgba(212,185,120,.16)', halo: 'rgba(190,160,235,.22)', ring1: 'rgba(212,185,120,.4)', ring2: 'rgba(212,185,120,.18)', avGlow: 'rgba(160,130,225,.5)',
            badgeBg: 'rgba(246,241,231,.95)', badgeIcon: 'text-amber-700', badgeShadow: '0 1px 5px rgba(0,0,0,.45)',
            name: 'text-amber-50', cardSub: 'text-amber-100/45', footer: 'text-amber-200/35', dot: 'text-amber-200/20',
        } : {
            pageBg: 'linear-gradient(180deg,#efe9f7 0%,#f4eff9 45%,#f7f2fb 100%)',
            stars: 'radial-gradient(1.5px 1.5px at 14% 16%,rgba(190,160,225,.45),transparent),radial-gradient(1px 1px at 80% 12%,rgba(220,190,235,.5),transparent),radial-gradient(1.5px 1.5px at 42% 28%,rgba(180,200,240,.4),transparent),radial-gradient(1px 1px at 86% 42%,rgba(200,175,230,.4),transparent),radial-gradient(1px 1px at 22% 66%,rgba(210,185,235,.35),transparent),radial-gradient(1px 1px at 66% 80%,rgba(200,210,240,.35),transparent)',
            back: 'text-purple-300 hover:text-purple-500',
            title: '#6a5790', titleShadow: 'rgba(170,150,220,.4)',
            line: 'rgba(150,120,190,.5)', sub: 'text-purple-400/70',
            tabWrapBg: 'rgba(255,255,255,.55)', tabWrapBorder: 'rgba(160,130,200,.22)',
            tabActive: { background: 'linear-gradient(180deg,#ffffff,#f0e9fa)', color: '#5b4b7a', border: '1px solid rgba(170,140,210,.5)', boxShadow: '0 2px 12px rgba(160,120,210,.25)' } as React.CSSProperties,
            tabIdle: 'rgba(110,90,140,.6)', diamond: '#a78bd6',
            desc: 'text-purple-400/70', empty: 'text-purple-300/70',
            tints: ROOM_CARD_TINTS_LIGHT, cardBorder: 'rgba(170,140,210,.3)', cardShadow: '0 8px 22px rgba(150,120,200,.18)',
            inner: 'rgba(170,140,210,.22)', gem: 'rgba(190,160,220,.85)',
            tick: 'rgba(170,140,210,.16)', halo: 'rgba(200,175,235,.3)', ring1: 'rgba(180,150,215,.5)', ring2: 'rgba(180,150,215,.25)', avGlow: 'rgba(190,160,235,.4)',
            badgeBg: '#ffffff', badgeIcon: 'text-purple-500', badgeShadow: '0 1px 5px rgba(120,90,170,.3)',
            name: 'text-purple-900', cardSub: 'text-purple-400/70', footer: 'text-purple-300/70', dot: 'text-purple-300/40',
        };
        // 按分组筛出要展示的角色（「全部」时就是原列表）
        const visitChars = filterCharactersByGroup(characters, characterGroups, visitGroupId);
        return (
            <div className="h-full w-full flex flex-col font-light relative overflow-hidden" style={{ background: th.pageBg }}>
                {/* 星点氛围 */}
                <div className="absolute inset-0 pointer-events-none opacity-70" style={{ backgroundImage: th.stars }} />

                {/* 顶部：标题 + Tab（家园正式开始玩——进世界/编辑——时整块隐去，全屏沉浸） */}
                <div className={`relative z-10 px-6 shrink-0 ${homeTab === 'worldHome' && worldHomeFull ? 'hidden' : ''}`} style={{ paddingTop: 'max(3rem, var(--safe-top, 0px))' }}>
                    <button onClick={closeApp} className={`absolute left-4 p-2 rounded-full active:scale-90 transition-all ${th.back}`} style={{ top: 'max(3rem, var(--safe-top, 0px))' }}>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <div className="text-center">
                        <h1 className="text-[26px] tracking-[0.15em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: th.title, textShadow: `0 2px 18px ${th.titleShadow}` }}>拜访谁的房间？</h1>
                        <div className="flex items-center justify-center gap-2 mt-1.5">
                            <span className="h-px w-10" style={{ background: `linear-gradient(90deg,transparent,${th.line})` }} />
                            <span className={`text-[9px] tracking-[0.45em] font-bold ${th.sub}`}>✦ VISIT ROOM ✦</span>
                            <span className="h-px w-10" style={{ background: `linear-gradient(270deg,transparent,${th.line})` }} />
                        </div>
                    </div>

                    {/* Tab 栏：三个分区都在这一页内切换，不跳走 */}
                    <div className="mt-5 rounded-2xl p-1.5 flex gap-1" style={{ background: th.tabWrapBg, border: `1px solid ${th.tabWrapBorder}`, boxShadow: 'inset 0 1px 0 rgba(255,255,255,.06)' }}>
                        {([
                            { id: 'room', label: '🏠 小小窝' },
                            { id: 'worldHome', label: '🌍 家园' },
                            { id: 'home3D', label: '拜访（测试版）3D' },
                        ] as const).map(tab => {
                            const active = homeTab === tab.id;
                            return (
                                <button key={tab.id} aria-label={tab.label} aria-pressed={active}
                                    onClick={() => { setHomeTab(tab.id); trackEvent('切换小小窝分区', { tab: tab.id }); }}
                                    className="relative flex-1 py-2.5 rounded-xl text-[12px] font-bold tracking-wide transition-all"
                                    style={active ? th.tabActive : { color: th.tabIdle }}>
                                    {tab.id === 'home3D' ? <><span className="block">拜访 <span className="text-[9px] tracking-normal opacity-75">3D</span></span><span className="block text-[9px] font-normal tracking-normal opacity-75">（测试版）</span></> : tab.label}
                                    {active && <span className="absolute -bottom-[7px] left-1/2 -translate-x-1/2 w-2 h-2 rotate-45" style={{ background: th.diamond, boxShadow: `0 0 8px ${th.diamond}` }} />}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {homeTab === 'worldHome' ? (
                    /* 家园分区：直接内嵌大世界本体，保持顶部三栏（不再跳走/不再多一层封面） */
                    <div className={`relative z-10 flex-1 min-h-0 overflow-hidden ${worldHomeFull ? '' : 'mt-3'}`}>
                        <WorldHomeApp key={worldShortcut.sequence} embedded launchWorldId={worldShortcut.id}
                            onLaunchConsumed={() => setWorldShortcut(previous => ({ ...previous, id: undefined }))} onFullscreen={setWorldHomeFull} />
                    </div>
                ) : (
                    <>
                        {/* 描述 */}
                        <p className={`relative z-10 text-center text-[11px] mt-4 px-8 leading-relaxed ${th.desc}`}>
                            {homeTab === 'home3D' ? '走进 ta 的 3D 家园，布置小屋、使用家具，也可以邀请你和其他角色一起玩。' : '走进谁的房间，看看 ta 此刻在做什么、翻翻屋里的小物件。'}
                        </p>

                        {/* 分组筛选（没建分组时不渲染）：3D 拜访=深色底，其余浅色 */}
                        <CharacterGroupFilterBar characters={characters} groups={characterGroups} dark={dark}
                            value={visitGroupId} onChange={setVisitGroupId} className="relative z-10 px-5 mt-3 shrink-0" />

                        {/* 角色网格 */}
                        <div className="relative z-10 flex-1 overflow-y-auto no-scrollbar px-5 pt-4 pb-4">
                            {characters.length === 0 ? (
                                <div className={`text-center text-[12px] py-16 ${th.empty}`}>还没有角色，先去「神经链接」创建一个吧。</div>
                            ) : visitChars.length === 0 ? (
                                <div className={`text-center text-[12px] py-16 ${th.empty}`}>该分组下没有角色</div>
                            ) : (
                                <div className="grid grid-cols-2 gap-4">
                                    {visitChars.map((c, i) => {
                                        const visit3D = homeTab === 'home3D';
                                        const tint = th.tints[i % th.tints.length];
                                        return (
                                            <button key={c.id} onClick={() => { if (visit3D) { setActiveCharacterId(c.id); setViewState('home3D'); } else handleEnterRoom(c); }}
                                                className="group relative rounded-2xl px-3 pt-8 pb-5 flex flex-col items-center active:scale-95 transition-all overflow-hidden"
                                                style={{ background: tint, border: `1px solid ${th.cardBorder}`, boxShadow: th.cardShadow }}>
                                                {/* 内描金细框 + 四角宝石 */}
                                                <div className="absolute inset-[7px] rounded-xl pointer-events-none" style={{ border: `1px solid ${th.inner}` }} />
                                                <span className="absolute top-[10px] left-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                                <span className="absolute top-[10px] right-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                                <span className="absolute bottom-[10px] left-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                                <span className="absolute bottom-[10px] right-[10px] w-1.5 h-1.5 rotate-45" style={{ background: th.gem }} />
                                                {/* 头像 + 罗盘纹 + 双层环 */}
                                                <div className="relative w-[92px] h-[92px] flex items-center justify-center">
                                                    <div className="absolute w-[124px] h-[124px] rounded-full" style={{ background: `repeating-conic-gradient(from 0deg, ${th.tick} 0deg 2.4deg, transparent 2.4deg 9deg)`, WebkitMaskImage: 'radial-gradient(circle, transparent 40%, #000 44%, #000 50%, transparent 55%)', maskImage: 'radial-gradient(circle, transparent 40%, #000 44%, #000 50%, transparent 55%)' }} />
                                                    <div className="absolute w-[110px] h-[110px] rounded-full" style={{ background: `radial-gradient(circle, ${th.halo}, transparent 62%)` }} />
                                                    <div className="absolute inset-[8px] rounded-full" style={{ border: `1px solid ${th.ring1}` }} />
                                                    <div className="absolute inset-[12px] rounded-full" style={{ border: `1px solid ${th.ring2}` }} />
                                                    <div className="w-[70px] h-[70px] rounded-full overflow-hidden" style={{ boxShadow: `0 0 18px ${th.avGlow}` }}>
                                                        <TokenImg value={c.avatar} className="w-full h-full object-cover" alt={c.name} />
                                                    </div>
                                                    <div className="absolute bottom-0 right-1.5 w-[22px] h-[22px] rounded-full flex items-center justify-center" style={{ background: th.badgeBg, boxShadow: th.badgeShadow }}>
                                                        {visit3D ? <span className="text-[8px] font-bold">3D</span> : (
                                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={`w-3.5 h-3.5 ${th.badgeIcon}`}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75" /></svg>
                                                        )}
                                                    </div>
                                                </div>
                                                <span className={`mt-3 text-[14px] font-semibold tracking-wide ${th.name}`} style={{ fontFamily: `'Noto Serif SC',serif` }}>{c.name}</span>
                                                <span className={`mt-0.5 text-[10px] ${th.cardSub}`}>{visit3D ? '拜访 ta 的 3D 家园' : '拜访 ta 的房间'}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* 底部装饰 */}
                        <div
                            className={`relative z-10 shrink-0 flex items-center justify-center gap-2.5 text-[8.5px] tracking-[0.35em] font-bold ${th.footer}`}
                            style={{ paddingBottom: 'calc(1rem + var(--safe-bottom, 0px))' }}
                        >
                            <span>EXPLORE</span><span className={th.dot}>◆</span><span>CONNECT</span><span className={th.dot}>◆</span><span>DISCOVER</span>
                        </div>
                    </>
                )}
            </div>
        );
    }

    // ROOM SCREEN
    // PERF: Reduced from 3 drop-shadows to 1 simple shadow -- massive mobile GPU savings
    const stickerClass = "filter drop-shadow-[0_2px_4px_rgba(0,0,0,0.15)]";

    // Background Style Construction (Logic 1: Legacy String vs New Config)
    const getBgStyle = (img: string | undefined, scale: number | undefined, repeat: boolean | undefined) => {
        if (!img) return '';
        // blob: 是令牌解析出的 objectURL，也要按图片(url())处理，否则会被当成 CSS 渐变。
        const isUrl = img.startsWith('http') || img.startsWith('data') || img.startsWith('blob:') || img.startsWith('/');
        const url = isUrl ? `url(${img})` : img; // If it's a CSS gradient, use it directly
        
        // If it's a gradient string (not URL), ignore scale params as they apply to background-size which works on gradients too, but repeat usually doesn't apply the same way.
        // Let's assume adjustments are mostly for Images.
        if (!isUrl) return url;

        // Apply Config
        const size = scale && scale > 0 ? `${scale}%` : 'cover'; // 0 = Cover
        const rep = repeat ? 'repeat' : 'no-repeat';
        const pos = 'center center';
        
        return `${url} ${pos} / ${size} ${rep}`;
    };

    const wallStyle = getBgStyle(wallImg, char?.roomConfig?.wallScale, char?.roomConfig?.wallRepeat) || WALLPAPER_PRESETS[0].value;
    const floorStyle = getBgStyle(floorImg, char?.roomConfig?.floorScale, char?.roomConfig?.floorRepeat) || FLOOR_PRESETS[0].value;

    // Merge Asset Libraries for Modal
    const displayLibrary: Record<string, any[]> = {
        ...ASSET_LIBRARY,
        custom: customAssets
    };

    // Sully Check
    const isSully = char?.id === 'preset-sully-v2' || char?.name === 'Sully';

    // 今天的房间是否已生成（lastRoomDate 命中今日即视为已生成）——决定是否提示「更新这一天」
    const todayGenerated = !!char && char.lastRoomDate === getVirtualDay(char);

    const renderTemplateButton = (template: BuiltInRoomTemplate, onSelect: (template: BuiltInRoomTemplate) => void, actionLabel: string) => (
        <button
            key={template.id}
            onClick={() => onSelect(template)}
            disabled={sampleRoomLoadingId === template.id}
            className="min-w-0 text-left rounded-lg border border-slate-200 bg-white overflow-hidden active:scale-[0.98] transition-transform disabled:opacity-60"
        >
            <div className="relative h-28 bg-slate-100 overflow-hidden">
                <div className="absolute inset-0 bg-center bg-cover" style={{ backgroundImage: `url(${template.thumbnail})` }} />
                <div className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/45 to-transparent" />
                <div className="absolute left-2 top-2 w-6 h-6 rounded-full bg-white/90 text-slate-700 text-xs font-black flex items-center justify-center shadow-sm">
                    {template.label}
                </div>
                <div className="absolute left-2 right-2 bottom-2 text-white">
                    <p className="text-xs font-black leading-tight truncate">{template.name}</p>
                    <p className="text-[9px] leading-tight opacity-85 truncate">{actionLabel}</p>
                </div>
            </div>
            <div className="p-2">
                <p className="text-[10px] text-slate-500 leading-snug">{template.description}</p>
            </div>
        </button>
    );

    return (
        <div className="h-full w-full bg-[#f8fafc] flex flex-col relative overflow-hidden font-sans select-none">

            {/* 「更新这一天」时一趟把整个房间生成出来（按次计费，所以一趟读完，之后逛屋不再等待）。
                慢是必然的，这里用小字向用户解释清楚为什么。进门本身不再触发它。 */}
            {isInitializing && (
                <div className="absolute inset-0 z-[500] bg-white flex flex-col items-center justify-center animate-fade-in px-10 text-center">
                    <div className="text-4xl mb-4 animate-bounce"><Door size={48} className="text-slate-400" /></div>
                    <p className="text-sm font-bold text-slate-500">{initStatusText}</p>
                    <p className="text-[11px] text-slate-400/90 leading-[1.7] mt-3 max-w-[268px]">
                        正在一趟把整个房间「读」出来——ta 此刻的状态、屋里<b className="text-slate-500">每一件物品</b>的样子和 ta 的反应、今天的计划与随笔，都在这一次里生成。
                        <br />物件越多越久，但只生成这一次，生成后就能一口气全看完，之后点哪件都不再等待。
                    </p>
                </div>
            )}

            <Modal
                isOpen={showSampleRoomOffer && !!char}
                title="Sully 的样板房推销"
                onClose={dismissSampleRoomOffer}
                footer={
                    <button onClick={dismissSampleRoomOffer} className="w-full py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl text-xs">
                        谢谢，我不需要
                    </button>
                }
            >
                <div className="space-y-4">
                    <div className="bg-slate-50 border border-slate-100 rounded-lg px-3 py-2.5">
                        <p className="text-sm font-bold text-slate-700">这里看起来空空的，Sully 来给你推销两款样板房：</p>
                        <p className="text-[10px] text-slate-400 leading-relaxed mt-1">样板房收纳在「家具超市 · 样板房」里，可以再次选择并二次调整。</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        {BUILTIN_ROOM_TEMPLATES.map(template => renderTemplateButton(template, chooseSampleRoom, sampleRoomLoadingId === template.id ? '导入中...' : '点我套用'))}
                    </div>
                </div>
            </Modal>

            <Modal
                isOpen={showActorArtModal && !!char}
                title="更改角色立绘"
                onClose={() => setShowActorArtModal(false)}
            >
                <div className="grid grid-cols-2 gap-3">
                    <button
                        onClick={() => { setShowActorArtModal(false); actorInputRef.current?.click(); }}
                        className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 p-4 text-left active:scale-[0.98] transition-transform"
                    >
                        <Image size={26} className="text-blue-500 mb-3" />
                        <p className="text-sm font-bold text-slate-700">上传自定义图片</p>
                        <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">从设备选择一张新的小屋立绘。</p>
                    </button>
                    <button
                        onClick={openActorStudio}
                        className="min-w-0 rounded-lg border border-purple-200 bg-purple-50 p-4 text-left active:scale-[0.98] transition-transform"
                    >
                        <Sparkle size={26} className="text-purple-500 mb-3" />
                        <p className="text-sm font-bold text-slate-700">进入捏人</p>
                        <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">前往神经链接里的手办展示。</p>
                    </button>
                </div>
            </Modal>

            {/* Room Stage */}
            <div ref={roomRef} className="flex-1 relative overflow-hidden transition-all duration-500 touch-none" onPointerDown={handleStagePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp} onClick={handleStageClick}>
                <div className="absolute top-0 left-0 w-full h-[65%] bg-center transition-all duration-500 z-0" style={{ background: wallStyle }}></div>
                <div className="absolute bottom-0 left-0 w-full h-[35%] bg-center transition-all duration-500 z-0" style={{ background: floorStyle }}></div>
                <div className="absolute top-[65%] w-full h-8 bg-gradient-to-b from-black/10 to-transparent pointer-events-none z-0"></div>
                {items.map(item => {
                    const isDragging = draggingId === item.id;
                    return (
                        <div
                            key={item.id}
                            onPointerDown={(e) => handlePointerDown(e, item.id)}
                            onClick={(e) => handleLookAt(item, e)}
                            onWheel={(e) => {
                                // 桌面端：选中后滚轮直接缩放（移动端走双指捏合）
                                if (mode !== 'edit' || selectedItemId !== item.id) return;
                                const next = Math.min(6, Math.max(0.2, item.scale + (e.deltaY < 0 ? 0.08 : -0.08)));
                                updateSelectedItem({ scale: Math.round(next * 100) / 100 }, 'cont:wheel');
                            }}
                            className={`absolute origin-bottom-center ${stickerClass} ${mode === 'edit' ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : (item.isInteractive ? 'cursor-pointer active:scale-95' : '')} ${selectedItemId === item.id ? 'ring-2 ring-blue-400 rounded-lg ring-offset-4' : ''} touch-none select-none`}
                            style={{
                                left: `${item.x}%`,
                                top: `${item.y}%`,
                                width: `${80 * item.scale}px`,
                                transform: `translate(-50%, -100%) rotate(${item.rotation}deg)`,
                                // 地毯压缩到 [1,11] 的底层区间：角色 zIndex ≥ 80（y 钳制在地平线以下再 +20），
                                // 普通家具按 y 排 z，两者都必然盖在地毯上。
                                zIndex: isDragging ? 100 : (item.type === 'rug' ? 1 + Math.floor(item.y / 10) : Math.floor(item.y)),
                                transition: isDragging ? 'none' : 'transform 0.2s ease-out',
                                willChange: isDragging ? 'left, top' : 'auto' // GPU layer only when needed
                            }}
                        >
                            <TokenImg value={item.image} className="w-full h-auto object-contain pointer-events-none select-none" draggable={false} loading="lazy" />
                            {mode === 'edit' && selectedItemId === item.id && <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-blue-500 text-white text-[9px] px-2 py-0.5 rounded-full whitespace-nowrap">选中</div>}
                        </div>
                    );
                })}
                
                {/* Character Actor - Z Index Boosted to simulate standing in front */}
                {!(mode === 'edit' && hideActorInEdit) && <div onClick={(e) => { e.stopPropagation(); handlePokeActor(); }} className={`absolute transition-[left,top] duration-[1000ms] ease-in-out origin-bottom-center ${stickerClass} cursor-pointer active:scale-95 group`} style={{ left: `${actorState.x}%`, top: `${actorState.y}%`, width: '120px', transform: `translate(-50%, -100%) scale(${actorState.action === 'walk' ? 1.05 : (actorState.action === 'bounce' ? 1.1 : 1)})`, zIndex: Math.floor(actorState.y) + 20 }}>
                    <img src={actorImage} className={`w-full h-full object-contain ${actorState.action === 'walk' ? 'animate-bounce' : ''}`} alt="" />
                    {mode === 'edit' && <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-black/60 text-white text-[9px] px-2 py-1 rounded backdrop-blur-sm whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1"><Camera size={12} /> 换装</div>}
                    {/* Fixed: Wider bubble width */}
                    {aiBubble.visible && <div className="absolute bottom-[105%] left-1/2 -translate-x-1/2 bg-white px-4 py-3 rounded-[20px] rounded-bl-none shadow-lg border-2 border-black/5 min-w-[120px] max-w-[300px] animate-pop-in z-50"><p className="text-xs font-bold text-slate-700 leading-tight text-center break-words">{aiBubble.text}</p><button onClick={(e) => { e.stopPropagation(); setAiBubble({ ...aiBubble, visible: false }); }} className="absolute -top-2 -right-2 bg-slate-200 text-slate-500 rounded-full w-4 h-4 flex items-center justify-center text-[8px]">×</button></div>}
                </div>}
            </div>

            {/* 查看梦境入口 · 左中边缘的「月亮」按钮（只在浏览模式露出，与右侧「生活碎片」对称） */}
            {mode === 'view' && (
                <button onClick={() => { setShowDream(true); trackEvent('打开梦境剧场'); }} title="查看梦境"
                    className="absolute left-0 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1 px-2.5 py-3 rounded-r-2xl shadow-lg border border-l-0 z-[300] active:scale-95 transition-transform"
                    style={{ background: 'linear-gradient(135deg, #2a2440, #1a1730)', borderColor: 'rgba(205,214,255,0.25)' }}>
                    <MoonStars size={20} weight="fill" style={{ color: '#cdd6ff' }} />
                    <span className="text-[8px] font-bold tracking-wider text-[#cdd6ff]/80 [writing-mode:vertical-rl]">梦境</span>
                </button>
            )}

            {/* 梦境演出 · 全屏覆盖（角色不记得梦，但用户偷看到了） */}
            {showDream && char && <DreamTheater char={char} onExit={() => { setShowDream(false); if (launchedFromDesktopRef.current) closeApp(); }} />}

            {/* Sidebar Toggle Button */}
            <button onClick={() => setShowSidebar(true)} className={`absolute right-0 top-1/2 -translate-y-1/2 bg-white/90 p-3 rounded-l-2xl shadow-lg border border-r-0 border-slate-200 transition-transform duration-300 z-[300] ${showSidebar ? 'translate-x-full' : 'translate-x-0'}`}>
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 text-slate-500"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
            </button>
            {showSidebar && <div className="absolute inset-0 z-[290] bg-black/20" onClick={() => setShowSidebar(false)}></div>}
            <div className={`absolute right-0 top-0 bottom-0 w-3/4 max-w-sm bg-white shadow-2xl z-[300] transition-transform duration-300 ease-out flex flex-col ${showSidebar ? 'translate-x-0' : 'translate-x-full'}`}>
                <div className="p-6 pb-2 border-b border-slate-100 flex justify-between items-center bg-slate-50" style={{ paddingTop: 'max(1.5rem, var(--safe-top, 0px))' }}>
                    <h3 className="text-lg font-bold text-slate-700 tracking-tight">生活碎片</h3>
                    <button onClick={() => setShowSidebar(false)} className="p-2 -mr-2 text-slate-400 hover:text-slate-600"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg></button>
                </div>
                <div className="flex p-2 bg-slate-50 border-b border-slate-100">
                    <button onClick={() => { setActivePanel('todo'); trackEvent('切换生活碎片面板', { panel: 'todo' }); }} className={`flex-1 py-2 text-xs font-bold rounded-lg transition-colors ${activePanel === 'todo' ? 'bg-white shadow text-primary' : 'text-slate-400 hover:bg-white/50'}`}>今日计划</button>
                    <button onClick={() => { setActivePanel('schedule'); trackEvent('切换生活碎片面板', { panel: 'schedule' }); }} className={`flex-1 py-2 text-xs font-bold rounded-lg transition-colors ${activePanel === 'schedule' ? 'bg-white shadow text-primary' : 'text-slate-400 hover:bg-white/50'}`}>日程</button>
                    <button onClick={() => { setActivePanel('notebook'); trackEvent('切换生活碎片面板', { panel: 'notebook' }); }} className={`flex-1 py-2 text-xs font-bold rounded-lg transition-colors ${activePanel === 'notebook' ? 'bg-white shadow text-primary' : 'text-slate-400 hover:bg-white/50'}`}>私密记事</button>
                </div>
                
                {/* Fixed: Add no-scrollbar class to hide scrollbar */}
                <div className="flex-1 overflow-y-auto p-6 bg-[#fcfcfc] no-scrollbar" style={{ paddingBottom: 'calc(1.5rem + var(--safe-bottom, 0px))' }}>
                    {activePanel === 'todo' && (
                        <div className="space-y-6">
                            <div className="flex items-center justify-between"><span className="text-xs font-bold text-slate-400 uppercase tracking-widest">{todaysTodo?.date || 'Today'}</span><span className="text-[10px] bg-slate-100 px-2 py-1 rounded text-slate-500">完成度: {todaysTodo ? Math.round((todaysTodo.items.filter(i=>i.done).length / todaysTodo.items.length)*100) : 0}%</span></div>
                            {todaysTodo ? <ul className="space-y-3">{todaysTodo.items.map((item, idx) => (
                                <li key={idx} className="flex items-start gap-3 group">
                                    <div onClick={() => handleToggleTodo(idx)} className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors cursor-pointer ${item.done ? 'bg-green-400 border-green-400' : 'border-slate-300 group-hover:border-primary'}`}>
                                        {item.done && <svg className="w-3 h-3 text-white" viewBox="0 0 20 20" fill="currentColor"><path d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"/></svg>}
                                    </div>
                                    <span onClick={() => handleToggleTodo(idx)} className={`text-sm leading-relaxed transition-all flex-1 cursor-pointer ${item.done ? 'text-slate-300 line-through decoration-slate-300' : 'text-slate-700 font-medium'}`}>{item.text}</span>
                                    <button onClick={() => handleDeleteTodo(idx)} className="text-slate-300 hover:text-red-400 px-1 opacity-0 group-hover:opacity-100 transition-opacity">×</button>
                                </li>
                            ))}</ul> : <div className="text-center py-10 text-slate-400 text-xs">生成中...</div>}
                            <div className="mt-8 p-4 bg-yellow-50 rounded-xl border border-yellow-100 text-xs text-yellow-800 leading-relaxed italic relative"><span className="absolute -top-3 left-4"><img src={twemojiUrl('1f4cc')} alt="pin" className="w-6 h-6" /></span>这是 {char?.name} 今天的自动行程表。虽然你不能帮TA做，但可以监督TA哦。</div>
                        </div>
                    )}
                    {activePanel === 'schedule' && (
                        <div className="space-y-4">
                            <ScheduleCard
                                schedule={roomSchedule}
                                character={char || null}
                                compact={true}
                            />
                            {!roomSchedule && (
                                <p className="text-center text-xs text-slate-400 py-4">日程将在首次聊天时自动生成</p>
                            )}
                        </div>
                    )}
                    {activePanel === 'notebook' && (
                        <div className="flex flex-col pb-4">
                            {notebookEntries.length > 0 ? (
                                <div 
                                    className="relative bg-white shadow-md border border-slate-200 p-6 min-h-[400px] flex flex-col rounded-xl" 
                                    style={{ backgroundImage: 'radial-gradient(#e5e7eb 1px, transparent 1px)', backgroundSize: '20px 20px' }}
                                >
                                    {/* Spiral Binding Visual - Adaptive Height */}
                                    <div className="absolute left-4 top-4 bottom-4 w-px border-l-2 border-dotted border-slate-300 pointer-events-none"></div>

                                    <div className="mb-4 ml-6 flex justify-between items-center text-[10px] text-slate-400 font-mono border-b border-slate-100 pb-2">
                                        <span>#{notebookEntries.length - notebookPage}</span>
                                        <div className="flex gap-2 items-center">
                                            <span>{new Date(notebookEntries[notebookPage].timestamp).toLocaleString()}</span>
                                            <button onClick={() => handleDeleteNote(notebookEntries[notebookPage].id)} className="text-red-300 hover:text-red-500 font-bold px-1" title="删除此页">×</button>
                                        </div>
                                    </div>
                                    <div className="flex-1 ml-6 text-slate-700 text-sm whitespace-pre-wrap leading-relaxed">{renderNotebookContent(notebookEntries[notebookPage].content)}</div>
                                    <div className="mt-6 ml-6 flex justify-between items-center pt-4 border-t border-slate-100"><button disabled={notebookPage >= notebookEntries.length - 1} onClick={() => setNotebookPage(p => p + 1)} className="text-slate-400 hover:text-primary disabled:opacity-30">← 旧的</button><span className="text-[10px] text-slate-300">{notebookPage + 1} / {notebookEntries.length}</span><button disabled={notebookPage <= 0} onClick={() => setNotebookPage(p => p - 1)} className="text-slate-400 hover:text-primary disabled:opacity-30">新的 →</button></div>
                                </div>
                            ) : <div className="text-center py-10 text-slate-400 text-xs">记事本是空的...</div>}
                        </div>
                    )}
                </div>
            </div>

            {/* UI Overlay */}
            <div className="absolute top-0 w-full px-4 pb-2 flex justify-between z-30 pointer-events-none" style={{ paddingTop: 'max(3rem, var(--safe-top, 0px))' }}>
                <button onClick={() => { if (launchedFromDesktopRef.current) closeApp(); else setViewState('select'); }} className="bg-white/90 p-2 rounded-full shadow-md pointer-events-auto active:scale-90 transition-transform text-slate-600"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg></button>
                <div className="flex gap-2 pointer-events-auto">
                    {/* 装修模式：撤销 / 重做 */}
                    {mode === 'edit' && (
                        <>
                            <button onClick={() => setHideActorInEdit(v => !v)} className={`p-2 rounded-full shadow-md active:scale-90 transition-all ${hideActorInEdit ? 'bg-blue-500 text-white' : 'bg-white/90 text-slate-500'}`} title={hideActorInEdit ? '显示角色' : '隐藏角色'} aria-label={hideActorInEdit ? '显示角色' : '隐藏角色'}>
                                {hideActorInEdit ? <EyeSlash size={22} weight="bold" /> : <Eye size={22} weight="bold" />}
                            </button>
                            <button onClick={undo} disabled={!history.length} className="p-2 bg-white/90 rounded-full shadow-md text-slate-500 disabled:opacity-40 active:scale-90 transition-transform" title="撤销">
                                <ArrowUUpLeft size={22} weight="bold" />
                            </button>
                            <button onClick={redo} disabled={!future.length} className="p-2 bg-white/90 rounded-full shadow-md text-slate-500 disabled:opacity-40 active:scale-90 transition-transform" title="重做">
                                <ArrowUUpRight size={22} weight="bold" />
                            </button>
                        </>
                    )}
                    {/* REFRESH BUTTON — 仅在今天已生成时露出（未生成时走下方「更新这一天」横幅） */}
                    {mode === 'view' && todayGenerated && (
                        <button onClick={() => setShowRefreshConfirm(true)} className="p-2 bg-white/90 rounded-full shadow-md text-slate-500 hover:text-primary active:scale-90 transition-transform" title="强制刷新今日">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                        </button>
                    )}
                    <button onClick={() => { setMode(mode === 'view' ? 'edit' : 'view'); setSelectedItemId(null); trackEvent('进入房间装修模式', { mode: mode === 'view' ? 'edit' : 'view' }); }} className={`px-4 py-2 rounded-full font-bold text-xs shadow-md transition-all ${mode === 'edit' ? 'bg-blue-500 text-white' : 'bg-white text-slate-600'}`}>{mode === 'edit' ? '完成' : '装修'}</button>
                </div>
            </div>

            {/* Observation Card (Bottom) */}
            {observationText && mode === 'view' && <div className="absolute left-4 right-4 bg-white p-5 rounded-2xl shadow-2xl border border-slate-100 z-[150] animate-slide-up" style={{ bottom: 'calc(1.5rem + var(--safe-bottom, 0px))' }}><div className="flex justify-between items-start mb-2"><span className="text-xs font-bold text-blue-500 uppercase tracking-widest">OBSERVATION</span><button onClick={() => setObservationText('')} className="text-slate-400 hover:text-slate-600">×</button></div><p className="text-sm text-slate-700 leading-relaxed font-medium text-justify">{observationText}</p></div>}

            {/* 「更新这一天」横幅 —— 今天尚未生成时露出（进门不再阻塞，由用户主动触发） */}
            {mode === 'view' && !todayGenerated && !isInitializing && !observationText && (
                <div className="absolute left-4 right-4 bg-white p-4 rounded-2xl shadow-2xl border border-slate-100 z-[150] animate-slide-up flex items-center gap-3" style={{ bottom: 'calc(1.5rem + var(--safe-bottom, 0px))' }}>
                    <div className="w-10 h-10 rounded-xl bg-primary-light flex items-center justify-center shrink-0">
                        <Door size={22} className="text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-slate-700 leading-tight">今天还没走进 {char?.name} 的一天</p>
                        <p className="text-[11px] text-slate-400 leading-snug mt-0.5">物品反应、今日计划与随笔会在这一次里生成，需要一点时间。</p>
                    </div>
                    <button onClick={handleGenerateToday} className="shrink-0 px-4 py-2.5 rounded-xl bg-primary text-white text-xs font-bold shadow-md active:scale-95 transition-transform">
                        更新这一天
                    </button>
                </div>
            )}

            {/* Edit Mode Toolbar - Collapsible */}
            {mode === 'edit' && (
                <div
                    className="absolute bottom-0 w-full bg-white border-t border-slate-200 z-[150] transition-transform duration-300 flex flex-col"
                    style={{
                        paddingBottom: 'var(--safe-bottom, 0px)',
                        maxHeight: isToolbarCollapsed ? 'auto' : '45vh',
                        transform: isToolbarCollapsed ? 'translateY(calc(100% - 2.5rem - var(--safe-bottom, 0px)))' : undefined,
                        boxSizing: 'border-box',
                    }}
                >
                    <div
                        className="w-full flex items-center justify-center cursor-pointer bg-white active:bg-slate-50 border-b border-slate-100"
                        style={{
                            height: isToolbarCollapsed ? 'calc(2.5rem + var(--safe-bottom, 0px))' : '2.5rem',
                            paddingBottom: isToolbarCollapsed ? 'var(--safe-bottom, 0px)' : undefined,
                            boxSizing: 'border-box',
                        }}
                        onClick={() => setIsToolbarCollapsed(!isToolbarCollapsed)}
                    ><div className="w-10 h-1 bg-slate-200 rounded-full"></div></div>
                    <div className="p-4 overflow-y-auto flex-1">
                        {selectedItemId ? (() => {
                            const sel = items.find(i => i.id === selectedItemId);
                            if (!sel) return null;
                            const isRug = sel.type === 'rug';
                            const nudgeBtn = "w-9 h-9 bg-slate-100 rounded-lg text-slate-500 font-bold text-sm active:bg-blue-100 active:text-blue-500 active:scale-95 transition-all";
                            return (
                            <div className="flex flex-col gap-3">
                                <div className="flex justify-between items-center gap-2">
                                    <span className="text-xs font-bold text-slate-500 truncate">调整 · {sel.name}</span>
                                    <div className="flex gap-2 shrink-0">
                                        <button onClick={duplicateSelectedItem} className="text-xs text-blue-500 font-bold bg-blue-50 px-3 py-1 rounded-full flex items-center gap-1"><CopySimple size={13} weight="bold" /> 复制</button>
                                        <button onClick={deleteSelectedItem} className="text-xs text-red-500 font-bold bg-red-50 px-3 py-1 rounded-full">删除</button>
                                    </div>
                                </div>
                                <div className="flex gap-4 items-stretch">
                                    <div className="flex-1 flex flex-col justify-center gap-3 min-w-0">
                                        <div>
                                            <label className="text-[10px] text-slate-400 block mb-1">缩放 <span className="text-slate-600 font-bold">{Math.round(sel.scale * 100)}%</span></label>
                                            <input type="range" min="0.2" max="6" step="0.05" value={sel.scale} onChange={(e) => updateSelectedItem({ scale: parseFloat(e.target.value) }, 'cont:scale')} className="w-full h-1 bg-slate-200 rounded-full accent-blue-500" />
                                        </div>
                                        <div>
                                            <label className="text-[10px] text-slate-400 block mb-1">
                                                旋转 <span className="text-slate-600 font-bold">{Math.round(sel.rotation)}°</span>
                                                {sel.rotation !== 0 && <button onClick={() => updateSelectedItem({ rotation: 0 }, 'op')} className="ml-2 text-[9px] text-blue-500 font-bold bg-blue-50 px-1.5 py-0.5 rounded-full">归零</button>}
                                            </label>
                                            <input type="range" min="-180" max="180" step="1" value={sel.rotation} onChange={(e) => updateSelectedItem({ rotation: parseInt(e.target.value) }, 'cont:rotate')} className="w-full h-1 bg-slate-200 rounded-full accent-blue-500" />
                                        </div>
                                    </div>
                                    {/* 微调十字键：拖不准时一格一格挪 */}
                                    <div className="grid grid-cols-3 gap-1 shrink-0 self-center">
                                        <span />
                                        <button onClick={() => nudgeSelectedItem(0, -1)} className={nudgeBtn}>↑</button>
                                        <span />
                                        <button onClick={() => nudgeSelectedItem(-1, 0)} className={nudgeBtn}>←</button>
                                        <span className="w-9 h-9 flex items-center justify-center text-[8px] text-slate-300 font-bold">1%</span>
                                        <button onClick={() => nudgeSelectedItem(1, 0)} className={nudgeBtn}>→</button>
                                        <span />
                                        <button onClick={() => nudgeSelectedItem(0, 1)} className={nudgeBtn}>↓</button>
                                        <span />
                                    </div>
                                </div>
                                {/* 类型切换：把已摆好的物品就地改成地毯（沉到底层）或改回家具 */}
                                <div className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2 border border-slate-100">
                                    <span className="text-[10px] text-slate-400">图层类型{isRug ? '：地毯（垫底，角色踩在上面）' : ''}</span>
                                    <button onClick={() => updateSelectedItem({ type: isRug ? 'furniture' : 'rug' }, 'op')} className={`text-xs font-bold px-3 py-1 rounded-full transition-colors ${isRug ? 'bg-purple-100 text-purple-600' : 'bg-slate-200 text-slate-500'}`}>
                                        {isRug ? '改回普通家具' : '设为地毯'}
                                    </button>
                                </div>
                                {/* 可互动开关：关掉后角色不再为它生成描写/反应 */}
                                <div className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2 border border-slate-100">
                                    <span className="text-[10px] text-slate-400">可互动（角色会为它生成描写与反应）</span>
                                    <button onClick={() => updateSelectedItem({ isInteractive: !sel.isInteractive }, 'op')} className={`text-xs font-bold px-3 py-1 rounded-full transition-colors ${sel.isInteractive ? 'bg-green-100 text-green-600' : 'bg-slate-200 text-slate-500'}`}>
                                        {sel.isInteractive ? '开' : '关'}
                                    </button>
                                </div>
                                <p className="text-[9px] text-slate-300 text-center">小技巧：单指拖动时再落下第二根手指，可直接捏合缩放 / 旋转；桌面端选中后滚轮也能缩放</p>
                            </div>
                            );
                        })() : (
                            <div className="space-y-4">
                                <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">
                                    <button onClick={() => { setShowLibrary(true); trackEvent('打开家具超市'); }} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-blue-500 rounded-xl flex items-center justify-center text-white shadow-md text-xl">+</div><span className="text-[10px] font-bold text-slate-500">家具库</span></button>
                                    <button onClick={() => setShowCustomModal(true)} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-purple-500 rounded-xl flex items-center justify-center text-white shadow-md"><Sparkle size={24} /></div><span className="text-[10px] font-bold text-slate-500">自定义</span></button>
                                    <button onClick={() => setShowActorArtModal(true)} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-pink-500 rounded-xl flex items-center justify-center text-white shadow-md"><Camera size={24} /></div><span className="text-[10px] font-bold text-slate-500">角色立绘</span></button>
                                    {/* 批量导入：一次选多张图，全部入库为自定义素材 */}
                                    <button onClick={() => batchAssetInputRef.current?.click()} disabled={isBatchImporting} className="flex flex-col items-center gap-1 shrink-0 disabled:opacity-50"><div className="w-12 h-12 bg-fuchsia-500 rounded-xl flex items-center justify-center text-white shadow-md"><Images size={24} /></div><span className="text-[10px] font-bold text-slate-500">{isBatchImporting ? '导入中…' : '批量导入'}</span></button>
                                    <button onClick={() => wallInputRef.current?.click()} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-slate-200 rounded-xl flex items-center justify-center text-slate-500 shadow-sm border border-slate-300"><Image size={24} /></div><span className="text-[10px] font-bold text-slate-500">换墙纸</span></button>
                                    <button onClick={() => floorInputRef.current?.click()} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-slate-200 rounded-xl flex items-center justify-center shadow-sm border border-slate-300"><img src={twemojiUrl('1f9f1')} alt="brick" className="w-6 h-6" /></div><span className="text-[10px] font-bold text-slate-500">换地板</span></button>
                                    {/* Export Room Template Button */}
                                    <button onClick={() => { setExportName(prev => prev || `${char?.name || ''}的小屋`); setShowExportModal(true); }} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-emerald-500 rounded-xl flex items-center justify-center text-white shadow-md"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M7.5 7.5 12 3m0 0 4.5 4.5M12 3v13.5" /></svg></div><span className="text-[10px] font-bold text-slate-500">导出小屋</span></button>
                                    {/* Import Room Template Button（导出的另一半：读 .room.json 样板房） */}
                                    <button onClick={() => importRoomInputRef.current?.click()} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-sky-500 rounded-xl flex items-center justify-center text-white shadow-md"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg></div><span className="text-[10px] font-bold text-slate-500">导入小屋</span></button>
                                    {/* Settings Button */}
                                    <button onClick={() => setShowSettingsModal(true)} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-slate-200 rounded-xl flex items-center justify-center text-slate-600 shadow-sm border border-slate-300"><GearSix size={24} /></div><span className="text-[10px] font-bold text-slate-500">设置</span></button>
                                    {/* Developer Export Button */}
                                    <button onClick={() => setShowDevModal(true)} className="flex flex-col items-center gap-1 shrink-0"><div className="w-12 h-12 bg-slate-800 rounded-xl flex items-center justify-center text-white shadow-sm border border-slate-600">{'{}'}</div><span className="text-[10px] font-bold text-slate-500">Dev</span></button>
                                    
                                    <input type="file" ref={wallInputRef} className="hidden" accept="image/*" onChange={(e) => handleImageUpload(e, 'wall')} />
                                    <input type="file" ref={floorInputRef} className="hidden" accept="image/*" onChange={(e) => handleImageUpload(e, 'floor')} />
                                    <input type="file" ref={actorInputRef} className="hidden" accept="image/*" onChange={(e) => handleImageUpload(e, 'actor')} />
                                </div>
                                <div><h4 className="text-[10px] font-bold text-slate-400 mb-2 uppercase">墙面预设</h4><div className="flex gap-2 overflow-x-auto no-scrollbar">{WALLPAPER_PRESETS.map((wp, i) => <button key={i} onClick={() => handleWallChange(wp.value)} className="w-10 h-10 rounded-lg shadow-sm border border-slate-200 shrink-0" style={{ background: wp.value }}></button>)}</div></div>
                                <div><h4 className="text-[10px] font-bold text-slate-400 mb-2 uppercase">地板预设</h4><div className="flex gap-2 overflow-x-auto no-scrollbar">{FLOOR_PRESETS.map((fp, i) => <button key={i} onClick={() => handleFloorChange(fp.value)} className="w-10 h-10 rounded-lg shadow-sm border border-slate-200 shrink-0" style={{ background: fp.value }}></button>)}</div></div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* 批量导入素材 / 导入小屋样板房 的隐藏文件选择器（放顶层：工具栏和家具超市弹窗都会用到） */}
            <input type="file" ref={batchAssetInputRef} className="hidden" accept="image/*" multiple onChange={handleBatchAssetImport} />
            <input type="file" ref={importRoomInputRef} className="hidden" accept=".json,.png,application/json,image/png" onChange={handleImportRoomFile} />

            {/* Asset Library Modal（点选不再自动关闭，可连点批量摆放） */}
            <Modal isOpen={showLibrary} title="家具超市" onClose={() => setShowLibrary(false)}
                footer={<button onClick={() => setShowLibrary(false)} className="w-full py-3 bg-blue-500 text-white font-bold rounded-2xl text-xs">摆完了，关闭</button>}
            >
                <div className="h-96 overflow-y-auto no-scrollbar">
                    <div className="flex items-center justify-between gap-3 mb-4 bg-purple-50 border border-purple-100 rounded-xl px-3 py-2.5">
                        <p className="text-[10px] text-purple-500 leading-relaxed flex-1">点一下就摆进房间，可以连点批量摆放；自己的图可一次选多张批量入库。</p>
                        <button onClick={() => batchAssetInputRef.current?.click()} disabled={isBatchImporting} className="shrink-0 px-3 py-2 bg-purple-500 text-white text-[10px] font-bold rounded-xl disabled:opacity-50 active:scale-95 transition-transform">{isBatchImporting ? '导入中…' : '＋批量导入'}</button>
                    </div>
                    <div className="mb-6">
                        <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3 sticky top-0 bg-white py-2 z-10 flex justify-between">
                            样板房
                            <span className="text-[9px] bg-slate-100 px-2 rounded-full">{BUILTIN_ROOM_TEMPLATES.length}</span>
                        </h4>
                        <div className="grid grid-cols-2 gap-3">
                            {BUILTIN_ROOM_TEMPLATES.map(template => renderTemplateButton(template, openBuiltInRoomTemplate, sampleRoomLoadingId === template.id ? '读取中...' : '打开导入'))}
                        </div>
                        <p className="text-[9px] text-slate-400 leading-relaxed mt-2">打开后可选择替换当前小屋，或只把样板房物品合并进来。</p>
                    </div>
                    {Object.entries(displayLibrary).map(([category, assets]) => (
                        assets && assets.length > 0 && (
                            <div key={category} className="mb-6">
                                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3 sticky top-0 bg-white py-2 z-10 flex justify-between">
                                    {category === 'sully_special' ? 'Sully 专属 (Special)' : (category === 'custom' ? '自定义 (Custom)' : (category === 'rug' ? '地毯 (Rug)' : category))}
                                    <span className="text-[9px] bg-slate-100 px-2 rounded-full">{assets.length}</span>
                                </h4>
                                <div className="grid grid-cols-4 gap-4">
                                    {assets.map((asset: any, i: number) => {
                                        const isCustom = category === 'custom';
                                        const handlers = isCustom ? {
                                            onTouchStart: () => handleAssetTouchStart(asset),
                                            onTouchEnd: handleAssetTouchEnd,
                                            onMouseDown: () => handleAssetTouchStart(asset),
                                            onMouseUp: handleAssetTouchEnd,
                                            onMouseLeave: handleAssetTouchEnd,
                                            onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); handleAssetTouchStart(asset); assetLongPressTimer.current && clearTimeout(assetLongPressTimer.current); setEditingAsset(asset); setEditName(asset.name); setEditDescription(asset.description || ''); setEditImage(asset.image); setEditVisibility(asset.visibility || 'public'); setEditAssignedCharIds(asset.assignedCharIds || []); setEditItemType(asset.itemType || 'furniture'); }
                                        } : {};

                                        return (
                                            <button
                                                key={asset.id || i}
                                                onClick={() => addItem(asset, category === 'custom' ? (asset.itemType || 'furniture') : (category === 'sully_special' ? 'furniture' : category as any))}
                                                className="flex flex-col items-center gap-2 group relative active:scale-95 transition-transform"
                                                {...handlers}
                                            >
                                                <div className="w-14 h-14 bg-slate-50 rounded-xl flex items-center justify-center border border-slate-100 group-hover:border-blue-300 transition-colors overflow-hidden relative">
                                                    <TokenImg value={asset.image} className="w-full h-full object-contain" />
                                                    {isCustom && asset.visibility === 'character' && <div className="absolute top-0 right-0 w-3 h-3 bg-blue-400 rounded-bl-lg" title="角色专属"></div>}
                                                </div>
                                                <span className="text-[10px] text-slate-500 truncate w-full text-center">{asset.name}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )
                    ))}
                </div>
            </Modal>

            {/* Custom Asset Edit Modal */}
            <Modal isOpen={!!editingAsset} title="编辑家具" onClose={() => setEditingAsset(null)}
                footer={<div className="flex gap-2 w-full"><button onClick={deleteEditingAsset} className="px-4 py-3 bg-red-50 text-red-500 rounded-2xl font-bold text-xs">删除</button><button onClick={saveEditingAsset} className="flex-1 py-3 bg-blue-500 text-white rounded-2xl font-bold text-xs">保存</button></div>}
            >
                {editingAsset && (
                    <div className="space-y-3">
                        <div className="flex gap-3 items-start">
                            <TokenImg value={editImage} className="w-14 h-14 object-contain rounded-lg bg-slate-100 border shrink-0" />
                            <div className="flex-1 space-y-2">
                                <div>
                                    <label className="text-[10px] font-bold text-slate-400 block mb-1">名称</label>
                                    <input value={editName} onChange={e => setEditName(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold focus:outline-blue-500" />
                                </div>
                                <div>
                                    <label className="text-[10px] font-bold text-slate-400 block mb-1">图片 URL</label>
                                    {/* 上传的图片以 blobref 令牌 / data: 存，URL 框里不显示这坨（避免误当成坏链接）；
                                        留空即保留原图，填入新 URL 才覆盖。 */}
                                    <input value={(isBlobRef(editImage) || editImage.startsWith('data:')) ? '' : editImage} onChange={e => setEditImage(e.target.value)} placeholder={(isBlobRef(editImage) || editImage.startsWith('data:')) ? '已上传图片（留空保留）' : 'https://...'} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-blue-500" />
                                </div>
                            </div>
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 block mb-1">描述</label>
                            <input value={editDescription} onChange={e => setEditDescription(e.target.value)} placeholder="物品描述..." className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-blue-500" />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 block mb-1">物品类型</label>
                            <div className="flex gap-2">
                                <button onClick={() => setEditItemType('furniture')} className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-colors ${editItemType === 'furniture' ? 'bg-purple-50 border-purple-300 text-purple-600' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>家具</button>
                                <button onClick={() => setEditItemType('rug')} className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-colors ${editItemType === 'rug' ? 'bg-purple-50 border-purple-300 text-purple-600' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>地毯</button>
                            </div>
                            <p className="text-[9px] text-slate-400 mt-1">类型改动只影响之后新摆放的物品，已摆好的不受影响。</p>
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 block mb-1">分类</label>
                            <div className="flex gap-2">
                                <button onClick={() => setEditVisibility('public')} className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-colors ${editVisibility === 'public' ? 'bg-green-50 border-green-300 text-green-600' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>公共</button>
                                <button onClick={() => setEditVisibility('character')} className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-colors ${editVisibility === 'character' ? 'bg-blue-50 border-blue-300 text-blue-600' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>角色专属</button>
                            </div>
                        </div>
                        {editVisibility === 'character' && (
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 block mb-1">指定角色（可多选）</label>
                                {/* 分组筛选只影响下方显示哪些可选项，已勾选的角色不会因为切组被移除 */}
                                <CharacterGroupFilterBar characters={characters} groups={characterGroups}
                                    value={assignGroupId} onChange={setAssignGroupId} className="mb-2" />
                                <div className="flex flex-wrap gap-2">
                                    {filterCharactersByGroup(characters, characterGroups, assignGroupId).map(c => (
                                        <button key={c.id} onClick={() => setEditAssignedCharIds(prev => prev.includes(c.id) ? prev.filter(id => id !== c.id) : [...prev, c.id])}
                                            className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${editAssignedCharIds.includes(c.id) ? 'bg-blue-100 border-blue-300 text-blue-600' : 'bg-slate-50 border-slate-200 text-slate-400'}`}
                                        >
                                            {c.name}
                                        </button>
                                    ))}
                                </div>
                                {editAssignedCharIds.length === 0 && <p className="text-[9px] text-amber-500 mt-1">请至少选择一个角色</p>}
                            </div>
                        )}
                    </div>
                )}
            </Modal>

            {/* Custom Item Modal */}
            <Modal isOpen={showCustomModal} title="自定义家具" onClose={() => setShowCustomModal(false)} footer={<button onClick={saveCustomItem} className="w-full py-3 bg-purple-500 text-white font-bold rounded-2xl">添加到房间</button>}>
                <div className="space-y-4">
                    <div className="flex gap-4">
                        <div onClick={() => customItemInputRef.current?.click()} className="aspect-square w-24 bg-slate-100 rounded-2xl border-2 border-dashed border-slate-300 flex items-center justify-center cursor-pointer hover:border-purple-400 relative overflow-hidden shrink-0">
                            {customItemImage ? <TokenImg value={customItemImage} className="w-full h-full object-contain" /> : <span className="text-slate-400 text-xs">+ 上传</span>}
                            <input type="file" ref={customItemInputRef} className="hidden" accept="image/*" onChange={(e) => handleImageUpload(e, 'custom_item')} />
                        </div>
                        <div className="flex-1 space-y-2">
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">图片 URL (推荐图床)</label>
                                <input value={customItemUrl} onChange={e => setCustomItemUrl(e.target.value)} placeholder="https://..." className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-purple-500" />
                            </div>
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">物品名称</label>
                                <input value={customItemName} onChange={e => setCustomItemName(e.target.value)} placeholder="例如: 懒人沙发" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-purple-500 font-bold" />
                            </div>
                        </div>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">物品类型</label>
                        <div className="flex gap-2">
                            <button onClick={() => setCustomItemType('furniture')} className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-colors ${customItemType === 'furniture' ? 'bg-purple-50 border-purple-300 text-purple-600' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>家具</button>
                            <button onClick={() => setCustomItemType('rug')} className={`flex-1 py-2 rounded-xl text-xs font-bold border transition-colors ${customItemType === 'rug' ? 'bg-purple-50 border-purple-300 text-purple-600' : 'bg-slate-50 border-slate-200 text-slate-400'}`}>地毯</button>
                        </div>
                        <p className="text-[9px] text-slate-400 mt-1">地毯永远铺在最底层，角色和其它家具都会压在它上面。</p>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">物品描述</label>
                        <input value={customItemDescription} onChange={e => setCustomItemDescription(e.target.value)} placeholder="例如: 一个很软的沙发，坐上去就陷进去了。" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-purple-500" />
                        <p className="text-[9px] text-slate-400 mt-1">这段描述会告诉 AI 这是什么，以及如何互动。</p>
                    </div>
                </div>
            </Modal>

            {/* Room Settings Modal */}
            <Modal isOpen={showSettingsModal} title="装修设置" onClose={() => setShowSettingsModal(false)}>
                <div className="space-y-6">
                    <div className="space-y-4">
                        <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100 pb-2">背景调整</h4>
                        <div>
                            <div className="flex justify-between mb-1"><label className="text-xs font-bold text-slate-600">墙纸缩放 ({char?.roomConfig?.wallScale || 0}%)</label><span className="text-[10px] text-slate-400">{char?.roomConfig?.wallScale ? `${char.roomConfig.wallScale}%` : 'Cover (Default)'}</span></div>
                            <input type="range" min="0" max="200" step="10" value={char?.roomConfig?.wallScale || 0} onChange={e => updateBgConfig({ wallScale: parseInt(e.target.value) })} className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                            <div className="flex items-center gap-2 mt-2">
                                <input type="checkbox" id="wallRepeat" checked={char?.roomConfig?.wallRepeat || false} onChange={e => updateBgConfig({ wallRepeat: e.target.checked })} className="accent-blue-500" />
                                <label htmlFor="wallRepeat" className="text-xs text-slate-600">平铺模式 (Tile)</label>
                            </div>
                        </div>
                        <div>
                            <div className="flex justify-between mb-1"><label className="text-xs font-bold text-slate-600">地板缩放 ({char?.roomConfig?.floorScale || 0}%)</label><span className="text-[10px] text-slate-400">{char?.roomConfig?.floorScale ? `${char.roomConfig.floorScale}%` : 'Cover (Default)'}</span></div>
                            <input type="range" min="0" max="200" step="10" value={char?.roomConfig?.floorScale || 0} onChange={e => updateBgConfig({ floorScale: parseInt(e.target.value) })} className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                            <div className="flex items-center gap-2 mt-2">
                                <input type="checkbox" id="floorRepeat" checked={char?.roomConfig?.floorRepeat || false} onChange={e => updateBgConfig({ floorRepeat: e.target.checked })} className="accent-blue-500" />
                                <label htmlFor="floorRepeat" className="text-xs text-slate-600">平铺模式 (Tile)</label>
                            </div>
                        </div>
                    </div>

                    {isSully && (
                        <div className="pt-4 border-t border-slate-100">
                            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Sully 专属维护</h4>
                            <button onClick={resetSullyRoom} className="w-full py-3 bg-red-50 text-red-500 font-bold rounded-2xl border border-red-100 flex items-center justify-center gap-2 active:scale-95 transition-transform">
                                <img src={twemojiUrl('1f9f9')} alt="broom" className="w-5 h-5" /> 还原初始样板房
                            </button>
                            <p className="text-[9px] text-slate-400 mt-2 text-center">如果不小心弄乱了房间，点此可一键恢复默认布局。</p>
                        </div>
                    )}
                </div>
            </Modal>

            {/* Refresh Confirmation Modal */}
            <Modal isOpen={showRefreshConfirm} title="强制刷新?" onClose={() => setShowRefreshConfirm(false)} footer={<div className="flex gap-2 w-full"><button onClick={() => setShowRefreshConfirm(false)} className="flex-1 py-3 bg-slate-100 text-slate-500 rounded-2xl font-bold">取消</button><button onClick={handleForceRefresh} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl">少管我!</button></div>}>
                <div className="text-center py-4 space-y-2">
                    <div><img src={twemojiUrl('1f570-fe0f')} alt="clock" className="w-10 h-10 mx-auto" /></div>
                    <p className="text-sm text-slate-600 font-bold">每天早上 6:00 自动刷新</p>
                    <p className="text-xs text-slate-400">还没到时间哦，确定要消耗算力强制重新生成今天的房间状态吗？</p>
                </div>
            </Modal>

            {/* Export Room Template Modal（导出当前小屋为样板房） */}
            <Modal
                isOpen={showExportModal}
                title="导出当前小屋"
                onClose={() => !isExporting && setShowExportModal(false)}
                footer={
                    <div className="flex gap-2 w-full">
                        <button onClick={() => handleExportRoom('copy')} disabled={isExporting} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl text-xs disabled:opacity-50">复制 JSON</button>
                        <button onClick={() => handleExportRoom('download')} disabled={isExporting} className="flex-1 py-3 bg-emerald-500 text-white font-bold rounded-2xl text-xs disabled:opacity-50">{isExporting ? '打包中...' : '下载文件'}</button>
                    </div>
                }
            >
                <div className="space-y-4">
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">小屋名称</label>
                        <input value={exportName} onChange={e => setExportName(e.target.value)} placeholder={`${char?.name || ''}的小屋`} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm font-bold focus:outline-emerald-500" />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">小屋描述</label>
                        <textarea value={exportDescription} onChange={e => setExportDescription(e.target.value)} rows={3} placeholder="介绍一下这套样板房：风格、亮点、适合谁住…" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs focus:outline-emerald-500 resize-none" />
                    </div>
                    <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2.5 text-[10px] text-emerald-700 leading-relaxed">
                        导出内容：名称、描述、墙面/地板配置，以及 {items.length} 件物品各自的图像与相对摆放位置（x/y 为房间百分比坐标，任何屏幕都能原样复原）。
                        <br />图床链接原样保留；本机上传的图会转成 base64 内嵌进 JSON，文件自包含、可直接分享。
                    </div>
                </div>
            </Modal>

            {/* Import Room Template Modal（导入样板房：替换 or 合并） */}
            <Modal
                isOpen={!!pendingImport}
                title="导入小屋样板房"
                onClose={() => !isImportingRoom && setPendingImport(null)}
                footer={
                    <div className="flex gap-2 w-full">
                        <button onClick={() => applyRoomImport('merge')} disabled={isImportingRoom} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl text-xs disabled:opacity-50">合并进当前小屋</button>
                        <button onClick={() => applyRoomImport('replace')} disabled={isImportingRoom} className="flex-1 py-3 bg-sky-500 text-white font-bold rounded-2xl text-xs disabled:opacity-50">{isImportingRoom ? '导入中...' : '替换当前小屋'}</button>
                    </div>
                }
            >
                {pendingImport && (
                    <div className="space-y-3">
                        <div className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2.5">
                            <p className="text-sm font-bold text-slate-700">{typeof pendingImport.name === 'string' && pendingImport.name ? pendingImport.name : '未命名小屋'}</p>
                            {typeof pendingImport.description === 'string' && pendingImport.description && (
                                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">{pendingImport.description}</p>
                            )}
                            <p className="text-[10px] text-slate-400 mt-1.5">共 {pendingImport.items.length} 件物品{pendingImport.room?.wallImage || pendingImport.room?.floorImage ? ' · 含墙面/地板' : ''}</p>
                        </div>
                        <div className="bg-sky-50 border border-sky-100 rounded-xl px-3 py-2.5 text-[10px] text-sky-700 leading-relaxed">
                            <b>替换</b>：清掉现有家具，按样板房原样复原（含墙面/地板）。
                            <br /><b>合并</b>：保留现有布局，把样板房的物品追加进来（不动背景）。
                            <br />物品改动可用装修模式左上角的「撤销」恢复。
                        </div>
                    </div>
                )}
            </Modal>

            {/* Dev Export Modal */}
            <Modal 
                isOpen={showDevModal} 
                title="开发者工具 (Dev Tools)" 
                onClose={() => setShowDevModal(false)} 
                footer={<button onClick={() => setShowDevModal(false)} className="w-full py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">关闭</button>}
            >
                <div className="space-y-4">
                    <div>
                        <h4 className="text-[10px] font-bold text-slate-400 uppercase mb-2">布局数据 (Layout JSON)</h4>
                        <div className="bg-slate-100 rounded-xl p-3 border border-slate-200 mb-2">
                            <pre className="text-[10px] text-slate-600 font-mono h-20 overflow-y-auto whitespace-pre-wrap select-all">
                                {JSON.stringify(items, null, 2)}
                            </pre>
                        </div>
                        <button onClick={() => { navigator.clipboard.writeText(JSON.stringify(items, null, 2)); addToast('布局已复制', 'success'); }} className="w-full py-2 bg-slate-800 text-white text-xs font-bold rounded-xl">复制布局 JSON</button>
                    </div>

                    <div>
                        <h4 className="text-[10px] font-bold text-red-400 uppercase mb-2">Prompt 调试 (Debugger)</h4>
                        <div className="bg-slate-100 rounded-xl p-3 border border-slate-200 mb-2">
                            <pre className="text-[10px] text-slate-600 font-mono h-20 overflow-y-auto whitespace-pre-wrap select-all">
                                {lastPrompt || "(暂无数据，请先尝试进入房间)"}
                            </pre>
                        </div>
                        <button onClick={() => { if(lastPrompt) { navigator.clipboard.writeText(lastPrompt); addToast('提示词已复制', 'success'); } else addToast('暂无提示词记录', 'error'); }} className="w-full py-2 bg-red-500 text-white text-xs font-bold rounded-xl">复制 Prompt 到剪贴板</button>
                        <p className="text-[9px] text-slate-400 mt-2 text-center">如果 AI 回复为空，请复制此 Prompt 检查是否有乱码/Base64 混入。</p>
                    </div>
                </div>
            </Modal>

        </div>
    );
};

export default RoomApp;
