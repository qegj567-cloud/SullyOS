import React, { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import { useOS } from '../context/OSContext';
import {
    ArrowLeft, Plus, Trash, BookOpen, Planet, Clock, Play, CaretRight, X,
    UploadSimple, PencilSimple, FlipHorizontal, CaretLeft, Sparkle,
    CircleNotch, TextAa, Palette, Pause, MusicNotes, Queue, Question, Check, Gear,
    SpeakerHigh, SpeakerSlash, MagnifyingGlass, ShieldCheck, MagicWand,
} from '@phosphor-icons/react';
import TheaterPanel from './theater/TheaterPanel';
import { SARCaianDialogue, SARClubStage, SARUpdateModal } from './vrWorld/SARClubEvent';
import { SARGachaOverlay } from './vrWorld/SARGacha';
import { SARAssemblyCabinetOverlay } from './vrWorld/SARAssemblyCabinet';
import { SARModuleShopOverlay } from './vrWorld/SARModuleShop';
import { CreatorIframe, type ChibiResult } from '../components/Like520Event';
import { useMusic, type Song } from '../context/MusicContext';
import { DB } from '../utils/db';
import { useResilientAssetUrl, attachAudioMirrorFallback } from '../utils/assetUrl';
import { VRScheduler, VR_FAIL_LIMIT } from '../utils/vrWorld/scheduler';
import { collectVRDiagnostics } from '../utils/vrWorld/diagnostics';
import { VR_ROOMS, getRoom, VR_DEFAULT_INTERVAL_MIN, SIGNAL_EPIGRAPH, signalActFor, signalActRanges, SIGNAL_POEMS_PER_BOOKLET, SIGNAL_EVENT_ENDED, SIGNAL_MEMORIAL_CLOSING } from '../utils/vrWorld/constants';
import { buildNovelAsync, groupAnnotationsBySeg, getBookmark } from '../utils/vrWorld/novel';
import { decodeBytes } from '../utils/vrWorld/decodeText';
import { extractPdfText, isPdfFile } from '../utils/pdfText';
import { stripLeakedAttrs } from '../utils/vrWorld/prompts';
import { PostOffice, MAX_LETTER_CHARS, exportIdentity, importIdentity, getAdminToken, setAdminToken, type RemoteReply, type RemoteLetterStat, type RemoteAdminLetter } from '../utils/vrWorld/postOffice';
import { Signal, getMyAuthorship, setSignalWhisper, hasSignalNoticeAck, ackSignalNotice, type SignalState } from '../utils/vrWorld/signal';
import type { SignalPoem, SignalBooklet } from '../types';
import { getVRApi, setVRApi, getVRApiLog, clearVRApiLog, type VRApiCall } from '../utils/vrWorld/vrApi';
import { safeResponseJson } from '../utils/safeApi';
import {
    patchSARClubState,
    readSARClubState,
    rewindSARIntro,
    SAR_CLUB_UPDATE_VERSION,
    type SARClubState,
    type SARIntroReaction,
    type SARNpcPreference,
} from '../utils/vrWorld/sarClub';

const genLocalId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

// 安全区单一来源：index.html :root 定义 --safe-top/--safe-bottom/--chrome-top，
// 由 utils/iosStandalone.ts 喂入 JS 探测值（iOS 全屏 PWA 下原生 env 偶发返回 0 时兜底）。
// 全屏浮层背景铺满屏幕，只用这些变量给顶/底「控件」让位。
const VR_TOP = 'var(--chrome-top)';                            // 安全区 + SullyOS 状态栏：全屏面板顶栏统一用它
const VR_SAFE_BOTTOM = 'var(--safe-bottom)';
const VR_ROOM_PANEL_TOP = 'calc(var(--chrome-top) + 3.75rem)'; // 房间内浮层从顶栏下方开始
// 底部额外留一点手势余量；iOS 全屏隐藏 home 条时也不让交互区贴着物理底边。
const VR_BOTTOM_TOUCH_GAP = '0.75rem';
// 底部内边距 / 贴底定位统一用它：base + 安全区 + 手势余量。
const vrBottomPad = (base: string) => `calc(${base} + ${VR_SAFE_BOTTOM} + ${VR_BOTTOM_TOUCH_GAP})`;

// ── 邮局寄信「日额度」：纯前端软计数，给后端减负（不追求精准，清数据会重置）──
// 从首封开始计时的滚动窗口，窗口内封顶、过期自动归零。两个额度各自独立。
// 投信：与后端对齐——5 封 / 5 小时（后端 PO_RATE_LETTERS=5、LETTERS_WINDOW_MS=5h，且按封数扣额度）。
const PO_SEND_QUOTA = { key: 'vr_po_send_quota', limit: 5, windowMs: 5 * 3600_000 };
// 回信：前端自定日额度（后端无每日上限，仅 60/分钟防刷；前端更严是安全方向）。
const PO_REPLY_QUOTA = { key: 'vr_po_reply_quota', limit: 20, windowMs: 24 * 3600_000 };
type QuotaCfg = { key: string; limit: number; windowMs: number };
const charLen = (s: string) => [...(s || '')].length;
const readQuota = (q: QuotaCfg): { windowStart: number; count: number } => {
    try {
        const raw = JSON.parse(localStorage.getItem(q.key) || 'null');
        if (raw && typeof raw.windowStart === 'number' && typeof raw.count === 'number'
            && Date.now() - raw.windowStart < q.windowMs) return raw;
    } catch { /* ignore */ }
    return { windowStart: 0, count: 0 };
};
const bumpQuota = (q: QuotaCfg, n: number) => {
    const cur = readQuota(q);
    const windowStart = cur.windowStart || Date.now();
    try { localStorage.setItem(q.key, JSON.stringify({ windowStart, count: cur.count + n })); } catch { /* ignore */ }
};
const quotaResetHours = (windowStart: number, windowMs: number) =>
    windowStart ? Math.max(1, Math.ceil((windowStart + windowMs - Date.now()) / 3600_000)) : Math.ceil(windowMs / 3600_000);

/** 气泡/动态里去掉开头多余的"自己名字"主语（角色播报本就该省略主语）。 */
const stripSelfName = (text: string | undefined, name: string | undefined): string => {
    if (!text) return '';
    if (!name) return text;
    const t = text.replace(/^\s+/, '');
    if (t.startsWith(name)) {
        const rest = t.slice(name.length).replace(/^[\s，,、：:·\-—]*/, '');
        if (rest) return rest;
    }
    return text;
};
import type { CharacterProfile, UserProfile, VRWorldNovel, VRNovelAnnotation, VRCardMeta, VRRoomId, VRMusicRoomState, CharPlaylistSong, VRGuestbookState, VRGuestbookMessage, VRLetter, ApiPreset, APIConfig } from '../types';

// ============ chibi 形象解析（vrState.chibi → 立绘 → 头像） ============
import { getChibi } from '../utils/vrWorld/chibi';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { trackEvent } from '../utils/analytics';
import { formatHours } from '../utils/format';
import TokenImg from '../components/os/TokenImg';

type Tab = 'world' | 'library' | 'settings' | 'api';

interface FeedItem {
    msgId: number; charId: string; charName: string; avatar: string;
    timestamp: number; meta: VRCardMeta; content: string;
    hidden: boolean; // 对 AI 上下文不可见（归档隐藏起点之前 / 记忆宫殿高水位之前）
}

// 每个房间的 chibi 站位（百分比坐标，底对齐）
const ROOM_SLOTS: Record<VRRoomId, { x: number; y: number }[]> = {
    library:   [{ x: 24, y: 72 }, { x: 50, y: 78 }, { x: 74, y: 70 }, { x: 38, y: 64 }, { x: 62, y: 64 }],
    music:     [{ x: 30, y: 74 }, { x: 55, y: 78 }, { x: 72, y: 70 }, { x: 45, y: 66 }],
    guestbook: [{ x: 28, y: 76 }, { x: 52, y: 78 }, { x: 73, y: 74 }, { x: 40, y: 68 }],
    gym:       [{ x: 26, y: 74 }, { x: 50, y: 80 }, { x: 74, y: 74 }, { x: 38, y: 66 }, { x: 62, y: 66 }],
    postoffice:[{ x: 28, y: 76 }, { x: 52, y: 78 }, { x: 72, y: 72 }, { x: 42, y: 68 }],
    theater:   [{ x: 30, y: 80 }, { x: 70, y: 80 }, { x: 50, y: 84 }, { x: 40, y: 72 }, { x: 60, y: 72 }],
    signal:    [{ x: 26, y: 78 }, { x: 52, y: 80 }, { x: 74, y: 76 }, { x: 40, y: 70 }, { x: 62, y: 70 }],
    sar:       [{ x: 24, y: 76 }, { x: 50, y: 80 }, { x: 74, y: 74 }, { x: 38, y: 68 }, { x: 62, y: 68 }],
    cafe:      [{ x: 30, y: 74 }, { x: 54, y: 78 }, { x: 70, y: 72 }],
};

const IDLE_QUIPS: Record<VRRoomId, string[]> = {
    library: ['翻着书页…', '这本还挺好看', '嘘，安静', '又是看书的一天'],
    music: ['随节奏轻晃', '这首单曲循环', '戴上耳机', '调一下音量'],
    guestbook: ['写点什么呢', '路过留个名', '看看墙上的话', '嗯…'],
    gym: ['活动一下', '再来一组！', '伸个懒腰', '热身中'],
    postoffice: ['给谁写封信呢', '封口、寄出', '翻翻信格', '写点心里话'],
    theater: ['对台词…', '再走一遍', '背词中', '候场'],
    signal: ['接一句…', '在想下一句', '读墙上的诗', '滋啦——信号'],
    sar: ['看看推演机', '模块说明书…', '去钓鱼吗', '活动记录中'],
    cafe: ['', '', '', ''],
};

const VRWorldApp: React.FC = () => {
    const { closeApp, characters, updateCharacter, addToast, registerBackHandler, userProfile, updateUserProfile, apiPresets, apiConfig, groups, realtimeConfig } = useOS();
    const userName = userProfile?.name || '我';
    const [tab, setTab] = useState<Tab>('world');
    const [novels, setNovels] = useState<VRWorldNovel[]>([]);
    const [feed, setFeed] = useState<FeedItem[]>([]);
    const [poBadge, setPoBadge] = useState<{ toSend: number; toCollect: number }>({ toSend: 0, toCollect: 0 });
    const [loading, setLoading] = useState(true);

    // 邮局徽标：本地待寄出/待发送 + 后端待收取的回信（best-effort 探测）
    const refreshPoBadge = useCallback(async () => {
        try {
            const letters = await DB.getVRLetters();
            const toSend = letters.filter(l =>
                (l.box === 'outbox' && l.status === 'queued') ||
                (l.box === 'inbox' && l.replyStatus === 'queued')
            ).length;
            let toCollect = 0;
            const sentIds = new Set(letters.filter(l => l.box === 'outbox' && l.status === 'sent' && l.remoteId).map(l => l.remoteId!));
            if (sentIds.size > 0) {
                try {
                    const replies = await PostOffice.fetchReplies();
                    toCollect = new Set(replies.filter(r => sentIds.has(r.letter_id)).map(r => r.letter_id)).size;
                } catch { /* 离线/未配置：忽略，只显示本地待办 */ }
            }
            setPoBadge({ toSend, toCollect });
        } catch { /* ignore */ }
    }, []);

    const [enterRoom, setEnterRoom] = useState<VRRoomId | null>(null);
    const [readerNovel, setReaderNovel] = useState<VRWorldNovel | null>(null);
    const [readerJump, setReaderJump] = useState<{ novel: VRWorldNovel; seg: number } | null>(null);
    const [showUpload, setShowUpload] = useState(false);
    const [chibiEditChar, setChibiEditChar] = useState<CharacterProfile | null>(null);
    const [chibiEditUser, setChibiEditUser] = useState(false); // 用户本人捏 chibi
    const [showHelp, setShowHelp] = useState(false);
    const [sarState, setSarState] = useState<SARClubState>(() => readSARClubState());
    const [sarPromptStep, setSarPromptStep] = useState<'update' | 'preference' | null>(() =>
        readSARClubState().npcPreference ? null : 'update');
    const [worldPage, setWorldPage] = useState<0 | 1>(0);
    const [showSarDialogue, setShowSarDialogue] = useState(false);
    const [showSarGacha, setShowSarGacha] = useState(false);
    const [showSarCabinet, setShowSarCabinet] = useState(false);
    const [showSarModuleShop, setShowSarModuleShop] = useState(false);
    const [sarModuleTargetCharId, setSarModuleTargetCharId] = useState<string | null>(null);
    const [showSarRewindConfirm, setShowSarRewindConfirm] = useState(false);
    const [incomingSarModule, setIncomingSarModule] = useState<{ charId: string; charName: string; moduleTitle: string } | null>(null);
    const sarHandledThisSession = useRef(false);
    // 启用流程：设定 chibi 后回调启用
    const [pendingEnable, setPendingEnable] = useState<string | null>(null);
    const [readingPreferenceCharId, setReadingPreferenceCharId] = useState<string | null>(null);
    const readingPreferenceChar = useMemo(
        () => characters.find(char => char.id === readingPreferenceCharId) || null,
        [characters, readingPreferenceCharId],
    );

    useEffect(() => {
        const onInstalled = (event: Event) => {
            const detail = (event as CustomEvent<{ charId?: string; charName?: string; moduleTitle?: string }>).detail;
            if (!detail?.charId || !detail.charName || !detail.moduleTitle) return;
            setIncomingSarModule({ charId: detail.charId, charName: detail.charName, moduleTitle: detail.moduleTitle });
        };
        window.addEventListener('sar-module-installed-on-user', onInstalled);
        return () => window.removeEventListener('sar-module-installed-on-user', onInstalled);
    }, []);

    // 初次进入彼方：自动弹出玩法说明（看过一次后不再自动弹）
    useEffect(() => {
        // 新版 SAR 选择优先展示；本次选完先让用户看第二页，通用玩法说明留到下次进入。
        if (sarPromptStep || sarHandledThisSession.current) return;
        try {
            if (!localStorage.getItem('vr_help_seen')) {
                setShowHelp(true);
                localStorage.setItem('vr_help_seen', '1');
            }
        } catch { /* ignore */ }
    }, [sarPromptStep]);

    const chooseSarNpcPreference = useCallback((preference: SARNpcPreference) => {
        sarHandledThisSession.current = true;
        const next = patchSARClubState({
            npcPreference: preference,
            updateSeenVersion: SAR_CLUB_UPDATE_VERSION,
        });
        setSarState(next);
        setSarPromptStep(null);
        trackEvent('选择彼方活动室NPC', { preference });
        if (preference === 'show') {
            setTab('world');
            setWorldPage(1);
        }
    }, []);

    const changeSarNpcPreference = useCallback((preference: SARNpcPreference) => {
        const next = patchSARClubState({ npcPreference: preference, updateSeenVersion: SAR_CLUB_UPDATE_VERSION });
        setSarState(next);
        trackEvent('切换彼方活动室NPC', { preference });
        if (preference === 'show') {
            setTab('world');
            setWorldPage(1);
            addToast?.('凯恩与艾文已来到活动室', 'success');
        } else {
            setShowSarDialogue(false);
            addToast?.('活动室 NPC 已隐藏，功能不受影响', 'success');
        }
    }, [addToast]);

    const completeSarIntro = useCallback((reaction?: SARIntroReaction) => {
        const next = patchSARClubState({ caianMet: true, introReaction: reaction });
        setSarState(next);
        setShowSarDialogue(false);
        trackEvent('完成凯恩初次见面', { reaction: reaction || 'unknown' });
    }, []);

    const rewindSarIntro = useCallback(() => {
        const next = rewindSARIntro();
        setSarState(next);
        setShowSarDialogue(false);
        setShowSarRewindConfirm(false);
        trackEvent('回档凯恩初次见面');
        if (next.npcPreference === 'show') {
            setTab('world');
            setWorldPage(1);
            addToast?.('已回档至与凯恩初次见面前', 'success');
        } else {
            addToast?.('剧情已回档；重新显示 NPC 后即可重看', 'success');
        }
    }, [addToast]);

    // 网页游戏验证钩子：彼方是 DOM 场景而非 canvas，仍暴露当前可交互状态供自动化读取。
    useEffect(() => {
        const target = window as Window & {
            render_game_to_text?: () => string;
            advanceTime?: (ms: number) => void;
        };
        const renderState = () => JSON.stringify({
            mode: 'vr-world',
            coordinateSystem: 'DOM viewport; origin top-left; x right; y down',
            tab,
            loading,
            room: enterRoom,
            overlays: {
                sarUpdate: sarPromptStep,
                caianDialogue: showSarDialogue,
                sarGacha: showSarGacha,
                sarCabinet: showSarCabinet,
                sarModuleShop: showSarModuleShop,
                help: showHelp,
            },
            sar: {
                npcPreference: sarState.npcPreference,
                caianMet: sarState.caianMet,
                worldPage,
            },
        });
        const advanceTime = (_ms: number) => { /* DOM 事件没有独立游戏时钟 */ };
        target.render_game_to_text = renderState;
        target.advanceTime = advanceTime;
        return () => {
            if (target.render_game_to_text === renderState) delete target.render_game_to_text;
            if (target.advanceTime === advanceTime) delete target.advanceTime;
        };
    }, [tab, loading, enterRoom, sarPromptStep, showSarDialogue, showSarGacha, showSarCabinet, showSarModuleShop, showHelp, sarState, worldPage]);

    const loadNovels = useCallback(async () => setNovels(await DB.getVRNovels()), []);
    const loadFeed = useCallback(async () => {
        const items: FeedItem[] = [];
        for (const c of characters) {
            // 彼方动态取数走 getVRCardsByCharId：全量捞该角色的 vr_card，不受"最近 N 条窗口"、
            // 记忆宫殿高水位线（mp_lastMsgId_<charId>）、归档隐藏起点（hideBeforeMessageId）影响。
            // 这些机制只管「LLM 上下文能不能看到」——而彼方动态是用户自己的浏览界面，
            // 只要消息还在 IndexedDB 里就该一直能看到：
            //   · 记忆宫殿后台向量化推高水位 → 动态不该突然清零；
            //   · 角色记忆归档把旧聊天标记为"对 AI 隐藏" → 这些动态依旧存在，用户仍要能回看；
            //   · 聊天攒多了把旧 vr_card 挤出最近窗口 → 不该因此从动态流消失。
            // （清空聊天会真删消息，删掉就没了——那是预期行为，逻辑不变。）
            const msgs = await DB.getVRCardsByCharId(c.id);
            // 「对 AI 不可见」判定：归档隐藏起点（hideBeforeMessageId，m.id < 它即隐藏）
            // 或记忆宫殿高水位（mp_lastMsgId，m.id <= 它即被向量记忆替代）。
            // 两者都让 LLM 读不到原文——动态本身仍在，只是上下文看不到，UI 里暗显并标「已隐藏」。
            const hideBefore = (c as any).hideBeforeMessageId || 0;
            let mpHwm = 0;
            try { mpHwm = parseInt(localStorage.getItem(`mp_lastMsgId_${c.id}`) || '0', 10) || 0; } catch { /* ignore */ }
            const hiddenCut = Math.max(hideBefore - 1, mpHwm); // m.id <= hiddenCut ⇒ 对 AI 不可见
            for (const m of msgs) {
                // 用户在留言簿的发言会广播进每个角色的 vr_card（供 LLM 上下文用），
                // 但它不是"角色自己的动态"——不进动态流，也不当作 chibi 气泡。
                if (!m.metadata?.userBoardPost) {
                    items.push({ msgId: m.id, charId: c.id, charName: c.name, avatar: c.avatar, timestamp: m.timestamp, meta: m.metadata as VRCardMeta, content: m.content, hidden: m.id <= hiddenCut });
                }
            }
        }
        items.sort((a, b) => b.timestamp - a.timestamp);
        setFeed(items.slice(0, 50));
    }, [characters]);

    const reloadAll = useCallback(async () => {
        setLoading(true);
        await Promise.all([loadNovels(), loadFeed()]);
        setLoading(false);
    }, [loadNovels, loadFeed]);

    useEffect(() => { void reloadAll(); void refreshPoBadge(); }, [reloadAll, refreshPoBadge]);
    useEffect(() => {
        const handler = () => { void reloadAll(); void refreshPoBadge(); };
        window.addEventListener('vr-session-done', handler);
        return () => window.removeEventListener('vr-session-done', handler);
    }, [reloadAll, refreshPoBadge]);
    // 离开房间（可能在邮局操作过）后刷新徽标
    useEffect(() => { if (enterRoom === null) void refreshPoBadge(); }, [enterRoom, refreshPoBadge]);

    // 最近一条动态（按角色）
    const latestByChar = useMemo(() => {
        const map: Record<string, FeedItem> = {};
        for (const f of feed) if (!map[f.charId]) map[f.charId] = f;
        return map;
    }, [feed]);

    const occupantsByRoom = useMemo(() => {
        const map: Record<string, CharacterProfile[]> = {};
        for (const c of characters) {
            if (c.vrState?.enabled) {
                const room = c.vrState.currentRoom || 'library';
                (map[room] ||= []).push(c);
            }
        }
        // 用户本人接入彼方且设了 chibi → 作为伪 occupant 站进自己挂着的房间
        const uv = userProfile?.vrState;
        if (uv?.enabled && uv.chibi?.img) {
            const room = uv.currentRoom || 'guestbook';
            const pseudo = { id: 'user', name: userName, avatar: userProfile?.avatar || '', vrState: { enabled: true, intervalMinutes: 0, currentRoom: room, chibi: uv.chibi } } as unknown as CharacterProfile;
            (map[room] ||= []).push(pseudo);
        }
        return map;
    }, [characters, userProfile, userName]);

    const enabledCount = characters.filter(c => c.vrState?.enabled).length;

    // 返回键：有弹层先关弹层（阅读器/房间/上传/捏人），而不是直接退回桌面
    useEffect(() => registerBackHandler(() => {
        if (showSarModuleShop) { setShowSarModuleShop(false); setSarModuleTargetCharId(null); return true; }
        if (showSarCabinet) { setShowSarCabinet(false); return true; }
        if (showSarGacha) { setShowSarGacha(false); return true; }
        if (showSarRewindConfirm) { setShowSarRewindConfirm(false); return true; }
        if (showSarDialogue) { setShowSarDialogue(false); return true; }
        if (readingPreferenceCharId) { setReadingPreferenceCharId(null); return true; }
        if (chibiEditChar) { setChibiEditChar(null); setPendingEnable(null); return true; }
        if (chibiEditUser) { setChibiEditUser(false); return true; }
        if (showUpload) { setShowUpload(false); return true; }
        if (readerJump) { setReaderJump(null); return true; }
        if (readerNovel) { setReaderNovel(null); return true; }
        if (enterRoom) { setEnterRoom(null); return true; }
        return false; // 无弹层 → 交回默认（关闭 App）
    }), [registerBackHandler, showSarModuleShop, showSarCabinet, showSarGacha, showSarRewindConfirm, showSarDialogue, readingPreferenceCharId, chibiEditChar, chibiEditUser, showUpload, readerJump, readerNovel, enterRoom]);

    // 从动态/批注点回原文：peek 模式打开阅读器跳到该段，不动用户书签
    const jumpToAnnotation = useCallback((novelId: string | undefined, segIdx: number) => {
        if (!novelId) return;
        const n = novels.find(x => x.id === novelId);
        if (n) setReaderJump({ novel: n, seg: segIdx });
    }, [novels]);

    // 用户在留言簿发言：落墙 + 以小卡片广播给所有接入彼方的角色私聊
    const onUserBoardPost = useCallback(async (content: string, replyTo?: VRGuestbookMessage) => {
        const t = content.trim();
        if (!t) return;
        const board = (await DB.getVRGuestbook()) || { id: 'board', messages: [], updatedAt: Date.now() };
        const id = `gb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        board.messages = [...board.messages, {
            id,
            authorId: 'user',
            authorName: userName,
            content: t,
            replyToId: replyTo?.id,
            replyToName: replyTo?.authorName,
            createdAt: Date.now(),
        }];
        board.updatedAt = Date.now();
        await DB.saveVRGuestbook(board);
        const activity = replyTo
            ? `${userName} 在留言墙上回复 ${replyTo.authorName}：${t}`
            : `${userName} 在留言墙上发了：${t}`;
        const enabled = characters.filter(c => c.vrState?.enabled);
        for (const c of enabled) {
            await DB.saveMessage({
                charId: c.id, role: 'user', type: 'vr_card',
                content: `「彼方 · 留言簿」${activity}`,
                metadata: {
                    vrCard: true,
                    room: 'guestbook',
                    userBoardPost: true,
                    activity,
                    boardPost: t,
                    boardReplyToName: replyTo?.authorName,
                },
            } as any);
        }
        const action = replyTo ? `已回复 ${replyTo.authorName}` : '已留言';
        addToast?.(enabled.length > 0 ? `${action}，并广播给 ${enabled.length} 位接入角色` : action, 'success');
    }, [characters, userName, addToast]);

    // 用户更新自己的彼方状态：以行为卡片广播给所有接入彼方的角色（机制同留言簿发言）
    const onUserVRBroadcast = useCallback(async (room: VRRoomId, activity: string) => {
        const roomName = VR_ROOMS.find(r => r.id === room)?.name || '彼方';
        const act = (activity || '').trim() || '在彼方里挂机放空';
        const line = `${userName} 现在在「彼方 · ${roomName}」：${act}`;
        const enabled = characters.filter(c => c.vrState?.enabled);
        for (const c of enabled) {
            await DB.saveMessage({
                charId: c.id, role: 'user', type: 'vr_card',
                content: `「彼方 · ${roomName}」${line}`,
                metadata: { vrCard: true, room, userBoardPost: true, activity: line },
            } as any);
        }
        addToast?.(enabled.length > 0 ? `已更新状态，并广播给 ${enabled.length} 位接入角色` : '已更新彼方状态', 'success');
    }, [characters, userName, addToast]);

    const onDeleteFeed = useCallback(async (msgId: number) => {
        await DB.deleteMessage(msgId);
        setFeed(prev => prev.filter(f => f.msgId !== msgId));
    }, []);
    const onDeleteFeedMany = useCallback(async (ids: number[]) => {
        if (ids.length === 0) return;
        await DB.deleteMessages(ids);
        const idSet = new Set(ids);
        setFeed(prev => prev.filter(f => !idSet.has(f.msgId)));
        addToast?.(`已删除 ${ids.length} 条彼方动态`, 'success');
    }, [addToast]);

    // 启用某角色（带 chibi 设定门槛）
    const enableChar = (char: CharacterProfile) => {
        const interval = char.vrState?.intervalMinutes || VR_DEFAULT_INTERVAL_MIN;
        updateCharacter(char.id, { vrState: { ...(char.vrState || {}), enabled: true, intervalMinutes: interval } });
        VRScheduler.start(char.id, interval);
        trackEvent('开启角色接入彼方', { action: 'enable' });
    };
    const requestEnable = (char: CharacterProfile) => {
        // 没设过专属 chibi → 先要求设定形象
        if (!char.vrState?.chibi?.img) {
            setPendingEnable(char.id);
            setChibiEditChar(char);
        } else {
            enableChar(char);
        }
    };

    return (
        <div className="h-full w-full flex flex-col text-white relative overflow-hidden"
            style={{ background: 'radial-gradient(130% 90% at 50% -15%, #20283f 0%, #141a2c 38%, #0a0d18 72%, #05060d 100%)' }}>
            <VRStyleTag />
            {/* 极光辉光 */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
                <div className="absolute -top-1/4 -left-1/4 w-[80%] h-[60%] rounded-full"
                    style={{ background: 'radial-gradient(circle, rgba(120,150,230,.20), transparent 70%)', filter: 'blur(44px)', animation: 'vraurora 15s ease-in-out infinite' }} />
                <div className="absolute top-1/3 -right-1/4 w-[72%] h-[56%] rounded-full"
                    style={{ background: 'radial-gradient(circle, rgba(130,212,200,.15), transparent 70%)', filter: 'blur(50px)', animation: 'vraurora 19s ease-in-out infinite reverse' }} />
            </div>
            {/* 星尘 */}
            <div className="pointer-events-none absolute inset-0"
                style={{ backgroundImage: 'radial-gradient(1px 1px at 18% 28%, rgba(255,255,255,.7), transparent), radial-gradient(1px 1px at 68% 18%, rgba(200,215,255,.6), transparent), radial-gradient(1px 1px at 82% 58%, rgba(230,220,255,.5), transparent), radial-gradient(1px 1px at 38% 72%, rgba(210,225,255,.5), transparent), radial-gradient(1.5px 1.5px at 52% 42%, rgba(255,255,255,.55), transparent)', animation: 'vrtwinkle 7s ease-in-out infinite' }} />

            {/* 顶栏 —— 外壳不再统一加 safe-area padding，这里用 --chrome-top 让开
                安全区 + SullyOS 状态栏（时间/电量），退出键落在其下方，不再怼到时钟上面。 */}
            <div className="relative flex items-center gap-2.5 px-5 pb-2.5 shrink-0 z-10" style={{ paddingTop: VR_TOP }}>
                <button onClick={closeApp} className="p-1.5 -ml-1.5 rounded-full text-white/65 active:bg-white/10"><ArrowLeft size={21} weight="regular" /></button>
                <div className="flex items-center gap-2">
                    <Planet size={17} weight="light" className="text-indigo-100/90" style={{ filter: 'drop-shadow(0 0 7px rgba(165,185,255,.7))' }} />
                    <span className="text-[22px] tracking-[0.42em] pl-1"
                        style={{ fontFamily: `'Noto Serif SC',serif`, fontWeight: 300, background: 'linear-gradient(100deg,#dcd4ff,#fff,#c2ece6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', filter: 'drop-shadow(0 0 10px rgba(185,185,255,.35))' }}>彼方</span>
                </div>
                <span className="ml-auto text-[10.5px] tracking-[0.12em] text-white/45 font-light">
                    {enabledCount > 0 ? `${enabledCount} 位漫游其中` : '尚无人接入'}
                </span>
                <button onClick={() => setShowHelp(true)} aria-label="玩法说明"
                    className="ml-2.5 h-7 w-7 rounded-full flex items-center justify-center text-white/70 active:bg-white/10 shrink-0"
                    style={{ border: '1px solid rgba(255,255,255,.22)' }}>
                    <Question size={14} weight="bold" />
                </button>
            </div>

            {/* Tab — 发丝下划线 */}
            <div className="relative flex px-5 gap-6 shrink-0 z-10 pb-px">
                {([['world', '世界'], ['library', '书库'], ['settings', '接入'], ['api', 'API']] as [Tab, string][]).map(([t, label]) => (
                    <button key={t} onClick={() => { setTab(t); trackEvent('切换彼方顶部标签', { tab: t }); }} className="relative pb-2 text-[13.5px] tracking-[0.22em] transition-colors"
                        style={{ fontFamily: `'Noto Serif SC',serif`, color: tab === t ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.38)' }}>
                        {label}
                        {tab === t && <span className="absolute -bottom-px left-1/2 -translate-x-1/2 w-5 h-px"
                            style={{ background: 'linear-gradient(90deg,transparent,rgba(205,205,255,.95),transparent)', boxShadow: '0 0 8px rgba(185,185,255,.85)' }} />}
                    </button>
                ))}
                <div className="absolute bottom-0 left-5 right-5 h-px" style={{ background: 'linear-gradient(90deg,transparent,rgba(255,255,255,.09),transparent)' }} />
            </div>

            {/* 滚动容器不同于浮动 dock：滚到底时最后一条内容贴 viewport bottom = 屏幕底，必须 + safe-bottom 让位 home 条，否则翻页按钮被压（即原 #158 报的问题）。 */}
            <div className="relative flex-1 overflow-y-auto vr-reader-scroll px-4 z-10" style={{ paddingTop: '1rem', paddingBottom: `calc(1rem + ${VR_SAFE_BOTTOM})` }}>
                {loading ? (
                    <div className="text-center text-white/40 text-[13px] tracking-[0.2em] py-12" style={{ fontFamily: `'Noto Serif SC',serif` }}>载入彼方…</div>
                ) : tab === 'world' ? (
                    <WorldView occupantsByRoom={occupantsByRoom} feed={feed} novelCount={novels.length} poBadge={poBadge}
                        onEnterRoom={setEnterRoom} onGoLibrary={() => setTab('library')} onJump={jumpToAnnotation}
                        onDeleteFeed={onDeleteFeed} onDeleteFeedMany={onDeleteFeedMany}
                        sarNpcEnabled={sarState.npcPreference === 'show'} sarCaianMet={sarState.caianMet}
                        roomPage={worldPage} onRoomPageChange={(page) => {
                            setWorldPage(page);
                            if (page === 1 && userProfile?.vrState?.enabled) {
                                updateUserProfile({
                                    vrState: {
                                        ...userProfile.vrState,
                                        currentRoom: 'sar',
                                        activity: userProfile.vrState.activity || '在 SAR 活动空间闲逛',
                                        updatedAt: Date.now(),
                                    },
                                });
                            }
                        }}
                        onTalkToCaian={() => setShowSarDialogue(true)} onOpenGacha={() => setShowSarGacha(true)} onOpenCabinet={() => setShowSarCabinet(true)}
                        onOpenModuleShop={() => setShowSarModuleShop(true)} />
                ) : tab === 'library' ? (
                    <LibraryView novels={novels} characters={characters} onOpen={setReaderNovel}
                        onAdd={() => { setShowUpload(true); trackEvent('打开小说上架弹窗'); }}
                        onDelete={async (id) => { await DB.deleteVRNovel(id); await loadNovels(); addToast?.('已删除', 'success'); }} />
                ) : tab === 'settings' ? (
                    <div className="space-y-3">
                        <UserVRPanel userProfile={userProfile} updateUserProfile={updateUserProfile}
                            onEditChibi={() => setChibiEditUser(true)} onBroadcast={onUserVRBroadcast} addToast={addToast} />
                        <SettingsView characters={characters} updateCharacter={updateCharacter} addToast={addToast}
                            novels={novels} onReload={reloadAll}
                            onRequestEnable={requestEnable} onEditChibi={setChibiEditChar}
                            onEditReadingPreference={(char) => setReadingPreferenceCharId(char.id)}
                            sarNpcEnabled={sarState.npcPreference === 'show'} sarCaianMet={sarState.caianMet}
                            onChangeSarNpc={changeSarNpcPreference} onRequestSarRewind={() => setShowSarRewindConfirm(true)} />
                    </div>
                ) : (
                    <VRApiSettings apiPresets={apiPresets} chatApi={apiConfig} addToast={addToast} characters={characters} />
                )}
            </div>

            {/* 进入房间场景 */}
            {enterRoom && (
                <RoomScene roomId={enterRoom} occupants={occupantsByRoom[enterRoom] || []}
                    latestByChar={latestByChar} onClose={() => setEnterRoom(null)} onJump={jumpToAnnotation}
                    characters={characters} userName={userName} onUserBoardPost={onUserBoardPost} addToast={addToast}
                    onUseModule={(character) => {
                        setSarModuleTargetCharId(character.id);
                        setShowSarModuleShop(true);
                    }} />
            )}
            {sarPromptStep && (
                <SARUpdateModal step={sarPromptStep} onContinue={() => setSarPromptStep('preference')} onChoose={chooseSarNpcPreference} />
            )}
            {showSarDialogue && sarState.npcPreference === 'show' && (
                <SARCaianDialogue onClose={() => setShowSarDialogue(false)} onComplete={completeSarIntro} />
            )}
            {showSarGacha && <SARGachaOverlay onClose={() => setShowSarGacha(false)} />}
            {showSarCabinet && userProfile && (
                <SARAssemblyCabinetOverlay onClose={() => setShowSarCabinet(false)} characters={characters}
                    apiConfig={apiConfig} userProfile={userProfile} groups={groups} realtimeConfig={realtimeConfig} />
            )}
            {showSarModuleShop && (
                <SARModuleShopOverlay
                    npcEnabled={sarState.npcPreference === 'show'}
                    initialTargetCharacterId={sarModuleTargetCharId}
                    onClose={() => { setShowSarModuleShop(false); setSarModuleTargetCharId(null); }}
                />
            )}
            {incomingSarModule && (() => {
                const source = characters.find(character => character.id === incomingSarModule.charId);
                return (
                    <div className="fixed inset-0 z-[620] grid place-items-center bg-[#03070b]/75 px-8 backdrop-blur-md" role="dialog" aria-modal="true" aria-label="角色对你装载了模块">
                        <style>{`@keyframes sar-user-approach{0%{opacity:0;transform:translateX(-52px) scale(.78)}65%{opacity:1;transform:translateX(0) scale(1.04)}100%{transform:none}}@keyframes sar-user-chip{0%{opacity:0;transform:translate(72px,-45px) rotate(45deg)}55%{opacity:1;transform:translate(28px,-10px) rotate(45deg)}100%{opacity:0;transform:translate(12px,0) rotate(45deg) scale(.3)}}`}</style>
                        <section className="w-full max-w-[330px] border border-emerald-100/20 bg-[#101b20] px-5 py-6 text-center shadow-[0_22px_80px_rgba(0,0,0,.65)]">
                            <div className="relative mx-auto grid h-36 w-48 place-items-center">
                                <div className="h-20 w-20 overflow-hidden rounded-full border border-emerald-100/30 bg-white/10 shadow-[0_0_36px_rgba(120,220,205,.2)]" style={{ animation: 'sar-user-approach .75s cubic-bezier(.2,.8,.2,1) both' }}>
                                    {source?.avatar ? <TokenImg value={source.avatar} alt={source.name} className="h-full w-full object-cover" /> : <span className="grid h-full place-items-center text-2xl text-white/80">{incomingSarModule.charName[0]}</span>}
                                </div>
                                <span className="absolute grid h-8 w-8 place-items-center border border-emerald-100/50 bg-emerald-900/70 text-emerald-100" style={{ animation: 'sar-user-chip .95s cubic-bezier(.2,.8,.2,1) both', transform: 'rotate(45deg)' }}><Sparkle size={14} /></span>
                            </div>
                            <div className="text-[8px] tracking-[.28em] text-emerald-100/45">MODULE INSTALLED</div>
                            <h2 className="mt-2 text-[18px] tracking-[.08em] text-white/90" style={{ fontFamily: `'Noto Serif SC',serif` }}>{incomingSarModule.charName} 对你使用了模块</h2>
                            <p className="mt-2 text-[11px] leading-relaxed text-white/55">「{incomingSarModule.moduleTitle}」将在接下来 5 次成功互动中改变你的外显表达，真实意图不会被覆盖。</p>
                            <button type="button" className="mt-5 w-full border border-emerald-100/20 bg-emerald-300/10 py-2.5 text-[11px] text-emerald-50" onClick={() => setIncomingSarModule(null)}>我知道了</button>
                        </section>
                    </div>
                );
            })()}
            <ConfirmDialog open={showSarRewindConfirm} title="回档凯恩初次见面？"
                message="会清除这段初见剧情的完成记录，让凯恩重新出现感叹号。更新公告和 NPC 显示偏好不会改变。"
                confirmText="确认回档" onConfirm={rewindSarIntro} onCancel={() => setShowSarRewindConfirm(false)} />
            {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
            {readingPreferenceChar && (
                <NovelPreferenceModal
                    char={readingPreferenceChar}
                    novels={novels}
                    onClose={() => setReadingPreferenceCharId(null)}
                    onSave={(novelIds) => {
                        const current = readingPreferenceChar.vrState || { enabled: false, intervalMinutes: VR_DEFAULT_INTERVAL_MIN };
                        updateCharacter(readingPreferenceChar.id, {
                            vrState: { ...current, preferredNovelIds: novelIds.length > 0 ? novelIds : undefined },
                        });
                        addToast?.(novelIds.length > 0
                            ? `已为 ${readingPreferenceChar.name} 优先选择 ${novelIds.length} 本书`
                            : `${readingPreferenceChar.name} 将从全书库自动轮换`, 'success');
                        setReadingPreferenceCharId(null);
                    }}
                />
            )}
            {readerNovel && <ReaderModal novel={readerNovel} characters={characters} onClose={() => setReaderNovel(null)} />}
            {readerJump && <ReaderModal novel={readerJump.novel} characters={characters} initialSeg={readerJump.seg} peek onClose={() => setReaderJump(null)} />}
            {showUpload && (
                <UploadModal onClose={() => setShowUpload(false)}
                    onCommit={async (novel) => {
                        await DB.saveVRNovel(novel); await loadNovels(); setShowUpload(false);
                        addToast?.(`《${novel.title}》已上架（${novel.segments.length} 段）`, 'success');
                    }}
                    onError={(msg) => addToast?.(msg, 'error')} />
            )}
            {chibiEditChar && (
                <ChibiEditor char={chibiEditChar}
                    onClose={() => { setChibiEditChar(null); setPendingEnable(null); }}
                    onSave={(chibi) => {
                        updateCharacter(chibiEditChar.id, { vrState: { ...(chibiEditChar.vrState || { enabled: false, intervalMinutes: VR_DEFAULT_INTERVAL_MIN }), chibi } });
                        const wasPending = pendingEnable === chibiEditChar.id;
                        const charSnap = chibiEditChar;
                        setChibiEditChar(null);
                        if (wasPending) {
                            setPendingEnable(null);
                            // 用最新 interval 启用
                            const interval = charSnap.vrState?.intervalMinutes || VR_DEFAULT_INTERVAL_MIN;
                            updateCharacter(charSnap.id, { vrState: { ...(charSnap.vrState || {}), chibi, enabled: true, intervalMinutes: interval } });
                            VRScheduler.start(charSnap.id, interval);
                            addToast?.(`${charSnap.name} 已接入彼方`, 'success');
                            trackEvent('开启角色接入彼方', { action: 'enable' });
                        } else {
                            addToast?.('形象已更新', 'success');
                        }
                    }} />
            )}
            {chibiEditUser && (
                <UserChibiEditor userName={userName} existing={userProfile?.vrState?.chibi}
                    onClose={() => setChibiEditUser(false)}
                    onSave={(chibi) => {
                        const uv = userProfile?.vrState;
                        updateUserProfile({ vrState: { ...(uv || {}), enabled: !!uv?.enabled, chibi, updatedAt: Date.now() } });
                        setChibiEditUser(false);
                        addToast?.('形象已更新', 'success');
                    }} />
            )}
        </div>
    );
};

// ============ 通用：CSS 房间场景背景 ============
const RoomBackground: React.FC<{ roomId: VRRoomId; className?: string }> = ({ roomId, className }) => {
    // 每个房间的插画底图（仓库相对路径，经 assetUrl 走多 CDN 镜像兜底，见 utils/assetUrl.ts）。
    // 统一套一层"彼方"调性处理：降饱和 + 压暗 + 轻柔化把图推远、弱化清晰度，
    // 再叠暗紫色洗 + 底部压暗 + 暗角，让五个房间是一套风格、且立绘能跳出来。
    const ROOM_BG: Partial<Record<VRRoomId, string>> = {
        library: 'img/BOOK.png',
        music: 'img/MUSIC.png',
        guestbook: 'img/PLAY.jpg',
        postoffice: 'img/post.png',
        gym: 'img/ALL.png',
        theater: 'img/SHOW.png',
    };
    // hook 必须无条件调用：无底图的房间传 null，返回空串走下面的分支。
    const bgUrl = useResilientAssetUrl(ROOM_BG[roomId] ?? null);
    if (bgUrl) {
        return (
            <div className={`absolute inset-0 overflow-hidden ${className || ''}`} style={{ background: '#0a0816' }}>
                {/* 底图：降饱和/压暗/轻柔化，并略放大避免柔化露边 */}
                <div className="absolute inset-0" style={{
                    backgroundImage: `url(${bgUrl})`, backgroundSize: 'cover', backgroundPosition: 'center',
                    filter: 'saturate(0.78) brightness(0.6) contrast(1.02) blur(1.3px)',
                    transform: 'scale(1.06)',
                }} />
                {/* 统一暗紫色洗 + 底部压暗给立绘让位 */}
                <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(22,17,46,0.42) 0%, rgba(13,10,30,0.20) 42%, rgba(7,5,18,0.86) 100%)' }} />
                {/* 暗角 */}
                <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 92% at 50% 36%, transparent 40%, rgba(5,4,14,0.66) 100%)' }} />
                {/* 顶部一抹冷紫晕，呼应"彼方"外壳 */}
                <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(96,72,180,0.16), transparent 28%)' }} />
            </div>
        );
    }
    if (roomId === 'signal') {
        // 信号坠落处：深空里坠落的信号竖线 + 微弱底噪扫描线
        return (
            <div className={`absolute inset-0 overflow-hidden ${className || ''}`} style={{ background: 'linear-gradient(180deg,#0c1030 0%,#0a0a26 55%,#06061a 100%)' }}>
                {/* 坠落的信号竖线 */}
                <div className="absolute inset-0 flex justify-between px-4 opacity-60">
                    {Array.from({ length: 14 }).map((_, i) => (
                        <div key={i} className="w-px" style={{
                            height: `${30 + (Math.sin(i * 2.1) + 1) * 28}%`,
                            marginTop: `${(i % 3) * 6}%`,
                            background: 'linear-gradient(180deg, transparent, rgba(140,150,255,.55), transparent)',
                            animation: `vrwave ${1.6 + (i % 4) * 0.3}s ${i * 0.07}s ease-in-out infinite alternate`,
                        }} />
                    ))}
                </div>
                {/* 扫描横纹（低电量底噪感） */}
                <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'repeating-linear-gradient(180deg, rgba(180,190,255,.9) 0 1px, transparent 1px 4px)' }} />
                <div className="absolute left-0 right-0 bottom-0 h-[26%]" style={{ background: 'linear-gradient(180deg,#0a0a24,#06061a)' }} />
            </div>
        );
    }
    if (roomId === 'library') {
        return (
            <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#3a2a1c 0%,#2a1d12 60%,#1c130b 100%)' }}>
                {/* 暖光窗 */}
                <div className="absolute top-[8%] right-[10%] w-20 h-28 rounded-md" style={{ background: 'linear-gradient(180deg,rgba(255,224,150,.55),rgba(255,180,90,.2))', boxShadow: '0 0 50px 18px rgba(255,200,120,.35)' }} />
                {/* 书架 */}
                <div className="absolute left-0 right-0 top-[20%] bottom-[28%]" style={{
                    backgroundImage: 'repeating-linear-gradient(90deg, #6b4a2b 0 4px, #8a5a30 4px 7px, #5a3a22 7px 14px, #9a6a3a 14px 18px, #4a2f1c 18px 22px)',
                    opacity: 0.85,
                }} />
                {/* 隔板 */}
                {[28, 44, 60].map(t => <div key={t} className="absolute left-0 right-0 h-1.5" style={{ top: `${t}%`, background: 'linear-gradient(180deg,#3a2615,#1c120a)' }} />)}
                {/* 地板 */}
                <div className="absolute left-0 right-0 bottom-0 h-[28%]" style={{ background: 'linear-gradient(180deg,#46301c,#241608)' }} />
            </div>
        );
    }
    if (roomId === 'music') {
        return (
            <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#2a1140 0%,#16082a 70%,#0a0418 100%)' }}>
                <div className="absolute inset-x-0 top-[18%] flex items-end justify-center gap-1 h-[40%] px-6 opacity-70">
                    {Array.from({ length: 22 }).map((_, i) => (
                        <div key={i} className="flex-1 rounded-t" style={{ height: `${30 + (Math.sin(i * 1.7) + 1) * 35}%`, background: 'linear-gradient(180deg,#ff7bd5,#7b5bff)', animation: `vrwave 1.2s ${i * 0.05}s ease-in-out infinite alternate` }} />
                    ))}
                </div>
                <div className="absolute left-0 right-0 bottom-0 h-[26%]" style={{ background: 'linear-gradient(180deg,#1a0a30,#0a0418)' }} />
            </div>
        );
    }
    if (roomId === 'guestbook') {
        return (
            <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#103050 0%,#0a2038 70%,#06121f 100%)' }}>
                <div className="absolute left-0 right-0 top-[14%] bottom-[28%]" style={{ background: 'linear-gradient(180deg,rgba(120,200,255,.10),rgba(80,160,230,.04))', boxShadow: 'inset 0 0 60px rgba(120,200,255,.2)' }}>
                    {[[18, 22, -6], [44, 30, 5], [68, 20, -3], [30, 55, 4], [60, 60, -5], [80, 48, 6]].map(([l, t, r], i) => (
                        <div key={i} className="absolute w-10 h-10 rounded-sm shadow-lg text-[7px] p-1 text-stone-700"
                            style={{ left: `${l}%`, top: `${t}%`, transform: `rotate(${r}deg)`, background: ['#fff7a8', '#ffd6e7', '#c8f7d4', '#cfe3ff'][i % 4] }} />
                    ))}
                </div>
                <div className="absolute left-0 right-0 bottom-0 h-[26%]" style={{ background: 'linear-gradient(180deg,#0c2236,#06121f)' }} />
            </div>
        );
    }
    if (roomId === 'postoffice') {
        return (
            <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#2a2418 0%,#1c1810 60%,#100d08 100%)' }}>
                {/* 一墙信格 */}
                <div className="absolute left-[6%] right-[6%] top-[16%] h-[42%] rounded-sm" style={{
                    backgroundImage: 'repeating-linear-gradient(90deg, #4a3a22 0 2px, transparent 2px 56px), repeating-linear-gradient(0deg, #4a3a22 0 2px, transparent 2px 40px)',
                    background: 'rgba(70,52,28,0.25)', boxShadow: 'inset 0 0 30px rgba(0,0,0,.4)',
                }} />
                {[20, 44, 68].map((l, i) => (
                    <div key={i} className="absolute w-6 h-4 rounded-[1px]" style={{ left: `${l}%`, top: `${22 + (i % 2) * 14}%`, transform: `rotate(${i % 2 ? -4 : 5}deg)`, background: ['#f3e7c8', '#e8dcc0', '#efe2c4'][i % 3], boxShadow: '0 2px 5px rgba(0,0,0,.4)' }} />
                ))}
                {/* 暖光台灯 */}
                <div className="absolute top-[10%] right-[14%] w-16 h-16 rounded-full" style={{ background: 'radial-gradient(circle,rgba(255,214,140,.4),transparent 70%)', filter: 'blur(8px)' }} />
                <div className="absolute left-0 right-0 bottom-0 h-[30%]" style={{ background: 'linear-gradient(180deg,#3a2c18,#160f08)' }} />
            </div>
        );
    }
    if (roomId === 'sar') {
        return (
            <div className={`absolute inset-0 overflow-hidden ${className || ''}`} style={{ background: 'linear-gradient(180deg,#20243a 0%,#151827 58%,#0b0d16 100%)' }}>
                {/* 美术素材接入前的活动室底稿：墙面、窗光、地板和社团横幅分层保留，之后可直接替换 ROOM_BG。 */}
                <div className="absolute left-[7%] top-[13%] h-[37%] w-[48%]" style={{ background: 'linear-gradient(150deg,rgba(177,197,232,.17),rgba(85,100,132,.04))', border: '1px solid rgba(210,220,255,.09)', boxShadow: '0 0 45px rgba(126,154,205,.08)' }} />
                <div className="absolute right-[8%] top-[17%] h-[33%] w-[26%] rounded-sm" style={{ background: 'rgba(7,8,15,.28)', border: '1px solid rgba(255,255,255,.08)' }} />
                <div className="absolute left-[10%] top-[20%] text-[18px] tracking-[0.28em] text-white/12" style={{ fontFamily: `'Noto Serif SC',serif` }}>SAR</div>
                <div className="absolute inset-x-0 bottom-0 h-[38%]" style={{ background: 'linear-gradient(180deg,#26263a,#11121c)' }} />
                <div className="absolute inset-x-0 bottom-[23%] h-px bg-white/[0.07]" />
                <div className="absolute inset-0" style={{ background: 'radial-gradient(90% 70% at 50% 38%,transparent,rgba(5,6,14,.55))' }} />
            </div>
        );
    }
    if (roomId === 'cafe') {
        return (
            <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#3a2a1e 0%,#271c14 60%,#160f0a 100%)' }}>
                <div className="absolute top-[20%] left-[18%] w-10 h-12 rounded-t-full" style={{ background: 'radial-gradient(circle at 50% 30%,rgba(255,210,150,.25),transparent 70%)', filter: 'blur(4px)' }} />
                <div className="absolute top-[24%] right-[22%] w-8 h-10 rounded-t-full" style={{ background: 'radial-gradient(circle at 50% 30%,rgba(255,190,130,.2),transparent 70%)', filter: 'blur(4px)' }} />
                <div className="absolute left-0 right-0 bottom-0 h-[32%]" style={{ background: 'linear-gradient(180deg,#4a3322,#1a110a)' }} />
            </div>
        );
    }
    // gym
    return (
        <div className={`absolute inset-0 ${className || ''}`} style={{ background: 'linear-gradient(180deg,#0a3a30 0%,#08261f 65%,#041511 100%)' }}>
            <div className="absolute left-0 right-0 bottom-0 h-[45%]" style={{
                backgroundImage: 'repeating-linear-gradient(90deg, transparent 0 38px, rgba(120,255,200,.18) 38px 40px), repeating-linear-gradient(0deg, transparent 0 38px, rgba(120,255,200,.12) 38px 40px)',
                transform: 'perspective(300px) rotateX(58deg)', transformOrigin: 'bottom',
            }} />
            <div className="absolute top-[14%] left-1/2 -translate-x-1/2 w-32 h-10 rounded-full" style={{ background: 'radial-gradient(ellipse,rgba(120,255,200,.3),transparent)' }} />
        </div>
    );
};

// ============ chibi 小人渲染 ============
const Chibi: React.FC<{ char: CharacterProfile; bubble?: string; onTap?: () => void; size?: number; dance?: boolean }> = ({ char, bubble, onTap, size = 96, dance }) => {
    const c = getChibi(char);
    return (
        <div
            className={`absolute flex flex-col items-center ${onTap ? 'cursor-pointer' : ''}`}
            style={{ transform: 'translate(-50%, -100%)' }}
            onClick={onTap}
            role={onTap ? 'button' : undefined}
            tabIndex={onTap ? 0 : undefined}
            aria-label={onTap ? `查看 ${char.name}` : undefined}
            onKeyDown={event => {
                if (onTap && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    onTap();
                }
            }}
        >
            {bubble && (
                <div className="relative mb-1 max-w-[120px] px-2 py-1 rounded-xl bg-white/95 text-stone-700 text-[10px] leading-snug font-medium shadow-[0_3px_10px_rgba(0,0,0,.3)] text-center">
                    {bubble.length > 22 ? bubble.slice(0, 22) + '…' : bubble}
                    <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-white/95 rotate-45" />
                </div>
            )}
            <div className="relative" style={{ animation: `${dance ? 'vrdance 0.9s' : 'vrfloat 3.2s'} ease-in-out infinite`, animationDelay: `${(char.id.charCodeAt(0) % 10) * 0.15}s` }}>
                {c.img ? (
                    <TokenImg value={c.img} alt={char.name}
                        style={{ height: size * c.scale, transform: `scaleX(${c.flip ? -1 : 1}) translateY(${c.offsetY}px)`, filter: 'drop-shadow(0 4px 6px rgba(0,0,0,.5))' }}
                        className="object-contain" />
                ) : (
                    <div className="rounded-full flex items-center justify-center font-bold text-white"
                        style={{ width: size * 0.55, height: size * 0.55, background: 'linear-gradient(120deg, rgba(150,168,255,.92), rgba(188,168,255,.85) 55%, rgba(150,212,204,.9))', fontSize: size * 0.22 }}>
                        {char.name.slice(0, 1)}
                    </div>
                )}
            </div>
            {/* 地面投影 */}
            <div className="rounded-[50%] -mt-1" style={{ width: size * 0.5, height: size * 0.12, background: 'radial-gradient(ellipse,rgba(0,0,0,.45),transparent)' }} />
            <div className="text-[9px] text-white/90 font-bold mt-0.5 px-1.5 rounded-full bg-black/30 backdrop-blur-sm whitespace-nowrap">{char.name}</div>
        </div>
    );
};

// ============ 通用：长按 hook + 确认弹窗（统一替代原生 confirm/alert） ============
const useLongPress = (onLong: () => void, ms = 500) => {
    const timer = useRef<number | null>(null);
    const [pressing, setPressing] = useState(false);
    const cancel = useCallback(() => { setPressing(false); if (timer.current) { clearTimeout(timer.current); timer.current = null; } }, []);
    const start = useCallback(() => { setPressing(true); timer.current = window.setTimeout(() => { setPressing(false); timer.current = null; onLong(); }, ms); }, [onLong, ms]);
    return { pressing, handlers: { onPointerDown: start, onPointerUp: cancel, onPointerLeave: cancel, onPointerCancel: cancel } };
};

const ConfirmDialog: React.FC<{
    open: boolean; title: string; message?: string;
    confirmText?: string; cancelText?: string;
    onConfirm: () => void; onCancel: () => void;
}> = ({ open, title, message, confirmText = '删除', cancelText = '取消', onConfirm, onCancel }) => {
    if (!open) return null;
    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-8 bg-black/55 backdrop-blur-sm" onClick={onCancel}>
            <div className="w-full max-w-[300px] rounded-2xl p-4 text-center" onClick={e => e.stopPropagation()}
                style={{ background: 'linear-gradient(180deg,#1b1830 0%,#100d20 100%)', border: '1px solid rgba(255,255,255,.12)', boxShadow: '0 16px 50px rgba(0,0,0,.6)' }}>
                <div className="text-[14px] font-semibold text-white tracking-wide" style={{ fontFamily: `'Noto Serif SC',serif` }}>{title}</div>
                {message && <p className="text-[11.5px] text-white/55 mt-1.5 leading-relaxed whitespace-pre-wrap">{message}</p>}
                <div className="flex gap-2 mt-4">
                    <button onClick={onCancel} className="flex-1 rounded-full py-2 text-[12.5px] text-white/75 active:bg-white/5" style={{ border: '1px solid rgba(255,255,255,.16)' }}>{cancelText}</button>
                    <button onClick={onConfirm} className="flex-1 rounded-full py-2 text-[12.5px] font-semibold text-white active:opacity-85" style={{ background: 'linear-gradient(120deg,#f43f5e,#e11d48)' }}>{confirmText}</button>
                </div>
            </div>
        </div>
    );
};

// 长按弹出的动作菜单（编辑 / 删除等）
const ActionSheet: React.FC<{
    open: boolean; title?: string;
    actions: { label: string; onClick: () => void; danger?: boolean }[];
    onClose: () => void;
}> = ({ open, title, actions, onClose }) => {
    if (!open) return null;
    return (
        <div className="fixed inset-0 z-[300] flex items-end justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
            <div className="w-full max-w-md p-3" style={{ paddingBottom: vrBottomPad('0.75rem') }} onClick={e => e.stopPropagation()}>
                <div className="rounded-2xl overflow-hidden" style={{ background: 'linear-gradient(180deg,#1b1830,#120f22)', border: '1px solid rgba(255,255,255,.12)' }}>
                    {title && <div className="px-4 py-2.5 text-[11px] text-white/45 text-center border-b border-white/8 whitespace-pre-wrap leading-snug">{title}</div>}
                    {actions.map((a, i) => (
                        <button key={i} onClick={() => { a.onClick(); }} className={`w-full py-3 text-[13.5px] active:bg-white/5 ${i > 0 ? 'border-t border-white/8' : ''} ${a.danger ? 'text-rose-400 font-semibold' : 'text-white/90'}`}>{a.label}</button>
                    ))}
                </div>
                <button onClick={onClose} className="w-full mt-2 rounded-2xl py-3 text-[13.5px] text-white/80 font-medium" style={{ background: 'rgba(40,36,60,.9)', border: '1px solid rgba(255,255,255,.1)' }}>取消</button>
            </div>
        </div>
    );
};

// 分页列表（每页 perPage 条，超出翻页）
function PagedList<T>({ items, perPage, render }: { items: T[]; perPage: number; render: (it: T, idx: number) => React.ReactNode }) {
    const [p, setP] = useState(0);
    const total = Math.max(1, Math.ceil(items.length / perPage));
    const cur = Math.min(p, total - 1);
    const slice = items.slice(cur * perPage, cur * perPage + perPage);
    return (
        <>
            {slice.map(render)}
            {total > 1 && (
                <div className="flex items-center justify-center gap-3 mb-1">
                    <button onClick={() => setP(Math.max(0, cur - 1))} disabled={cur === 0} className="h-6 w-6 rounded-full flex items-center justify-center text-white/60 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)' }}><CaretLeft size={11} weight="bold" /></button>
                    <span className="text-[10px] text-white/45 tabular-nums">{cur + 1}/{total}</span>
                    <button onClick={() => setP(Math.min(total - 1, cur + 1))} disabled={cur >= total - 1} className="h-6 w-6 rounded-full flex items-center justify-center text-white/60 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)' }}><CaretRight size={11} weight="bold" /></button>
                </div>
            )}
        </>
    );
}

// 待寄出信件行（长按弹出 编辑/删除）
const PendingLetterRow: React.FC<{ l: VRLetter; onMenu: (l: VRLetter) => void }> = ({ l, onMenu }) => {
    const { pressing, handlers } = useLongPress(() => onMenu(l), 500);
    const len = charLen(l.content);
    const over = len > MAX_LETTER_CHARS;
    return (
        <div {...handlers} className={`rounded-lg p-2 mb-1.5 text-[11.5px] text-amber-50/90 transition-transform ${pressing ? 'scale-[0.97]' : ''}`}
            style={{ background: pressing ? 'rgba(244,180,90,0.16)' : 'rgba(255,255,255,.05)', border: `1px solid ${over ? 'rgba(244,120,90,0.5)' : pressing ? 'rgba(244,180,90,0.4)' : 'transparent'}` }}>
            <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-amber-200/90 font-bold text-[10.5px]">{l.pen}</span>
                <span className={`ml-auto text-[9px] ${over ? 'text-red-300 font-semibold' : 'text-white/25'}`}>{over ? `${len}/${MAX_LETTER_CHARS} 超长·需精简` : '长按编辑/删除'}</span>
            </div>
            <p className="leading-snug whitespace-pre-wrap">{l.content}</p>
        </div>
    );
};

// 信件编辑弹窗
const LetterEditModal: React.FC<{ letter: VRLetter; onSave: (pen: string, content: string) => void; onCancel: () => void; title?: string }> = ({ letter, onSave, onCancel, title = '编辑这封信' }) => {
    const [pen, setPen] = useState(letter.pen);
    const [content, setContent] = useState(letter.content);
    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-6 bg-black/55 backdrop-blur-sm" onClick={onCancel}>
            <div className="w-full max-w-[340px] rounded-2xl p-4" onClick={e => e.stopPropagation()} style={{ background: 'linear-gradient(180deg,#221b12,#15100a)', border: '1px solid rgba(220,190,120,.28)', boxShadow: '0 16px 50px rgba(0,0,0,.6)' }}>
                <div className="text-[13px] font-semibold text-amber-100 mb-2.5" style={{ fontFamily: `'Noto Serif SC',serif` }}>{title}</div>
                <label className="text-[10px] text-amber-200/60">笔名</label>
                <input value={pen} onChange={e => setPen(e.target.value)} className="w-full mt-1 mb-2.5 rounded-lg bg-black/25 px-3 py-2 text-[12.5px] text-amber-50 outline-none" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                <label className="text-[10px] text-amber-200/60 flex items-center">正文<span className={`ml-auto ${charLen(content) > MAX_LETTER_CHARS ? 'text-red-300 font-semibold' : 'text-amber-200/50'}`}>{charLen(content)}/{MAX_LETTER_CHARS}</span></label>
                <textarea value={content} onChange={e => setContent(e.target.value)} rows={5} placeholder="写给陌生人的话——碎碎念、日记、困惑、执念都行…" className="w-full mt-1 rounded-lg bg-black/25 px-3 py-2 text-[12.5px] text-amber-50 placeholder-white/25 outline-none resize-none vr-reader-scroll" style={{ border: `1px solid ${charLen(content) > MAX_LETTER_CHARS ? 'rgba(244,120,90,.5)' : 'rgba(220,190,120,.2)'}` }} />
                <div className="flex gap-2 mt-3.5">
                    <button onClick={onCancel} className="flex-1 rounded-full py-2 text-[12.5px] text-white/70" style={{ border: '1px solid rgba(255,255,255,.16)' }}>取消</button>
                    <button onClick={() => onSave(pen, content)} disabled={!content.trim() || charLen(content) > MAX_LETTER_CHARS} className="flex-1 rounded-full py-2 text-[12.5px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>保存</button>
                </div>
            </div>
        </div>
    );
};

// 身份导出 / 导入弹窗：owner_id 是本地随机 UUID，换设备/清数据会丢失「我寄出的信」的归属，
// 这里给用户一个「带走身份」的口子。
const IdentityModal: React.FC<{ onImport: (code: string) => void; onClose: () => void }> = ({ onImport, onClose }) => {
    const code = exportIdentity();
    const [input, setInput] = useState('');
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try { await navigator.clipboard?.writeText(code); setCopied(true); trackEvent('复制邮局身份码'); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
    };
    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-6 bg-black/55 backdrop-blur-sm" onClick={onClose}>
            <div className="w-full max-w-[340px] rounded-2xl p-4" onClick={e => e.stopPropagation()} style={{ background: 'linear-gradient(180deg,#221b12,#15100a)', border: '1px solid rgba(220,190,120,.28)', boxShadow: '0 16px 50px rgba(0,0,0,.6)' }}>
                <div className="text-[13px] font-semibold text-amber-100 mb-1" style={{ fontFamily: `'Noto Serif SC',serif` }}>邮局身份</div>
                <p className="text-[10px] text-white/45 leading-snug mb-2.5">这串「身份码」代表你在邮局的匿名身份。复制保存，换设备或清数据后导入，就能找回「我寄出的信」和它们的归属。</p>
                <label className="text-[10px] text-amber-200/60">我的身份码</label>
                <div className="flex gap-1.5 mt-1 mb-3">
                    <div className="flex-1 rounded-lg bg-black/30 px-2.5 py-2 text-[10.5px] text-amber-50/80 break-all leading-snug" style={{ border: '1px solid rgba(220,190,120,.2)' }}>{code}</div>
                    <button onClick={copy} className="shrink-0 self-stretch px-3 rounded-lg text-[11px] font-semibold text-black" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{copied ? '已复制' : '复制'}</button>
                </div>
                <label className="text-[10px] text-amber-200/60">导入身份码（换回旧身份）</label>
                <input value={input} onChange={e => setInput(e.target.value)} placeholder="粘贴 sullypo.… 身份码" className="w-full mt-1 rounded-lg bg-black/25 px-3 py-2 text-[11.5px] text-amber-50 placeholder-white/25 outline-none" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                <div className="flex gap-2 mt-3.5">
                    <button onClick={onClose} className="flex-1 rounded-full py-2 text-[12.5px] text-white/70" style={{ border: '1px solid rgba(255,255,255,.16)' }}>关闭</button>
                    <button onClick={() => onImport(input)} disabled={!input.trim()} className="flex-1 rounded-full py-2 text-[12.5px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>导入</button>
                </div>
            </div>
        </div>
    );
};

// 后台：用 ADMIN_TOKEN 看后端「所有人」的信、按需删（点踩多的排在前）。token 仅存本机。
const AdminModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const [token, setToken] = useState(getAdminToken());
    const [letters, setLetters] = useState<RemoteAdminLetter[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState('');
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const load = async () => {
        if (!token.trim()) { setErr('请先填入管理员 token'); return; }
        setLoading(true); setErr('');
        try { setAdminToken(token); setLetters(await PostOffice.adminList(token.trim(), 200)); }
        catch (e: any) { setErr(e?.message === 'unauthorized' ? 'token 不对' : ('拉取失败：' + (e?.message || '检查网络'))); setLetters(null); }
        finally { setLoading(false); }
    };
    const del = async (id: string) => {
        try { await PostOffice.adminDelete(token.trim(), [id]); setLetters(ls => (ls || []).filter(l => l.id !== id)); setConfirmId(null); }
        catch (e: any) { setErr('删除失败：' + (e?.message || '检查网络')); }
    };
    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-6 bg-black/55 backdrop-blur-sm" onClick={onClose}>
            <div className="w-full max-w-[400px] max-h-[82vh] flex flex-col rounded-2xl p-4" onClick={e => e.stopPropagation()} style={{ background: 'linear-gradient(180deg,#221b12,#15100a)', border: '1px solid rgba(220,190,120,.28)', boxShadow: '0 16px 50px rgba(0,0,0,.6)' }}>
                <div className="text-[13px] font-semibold text-amber-100 mb-1 shrink-0" style={{ fontFamily: `'Noto Serif SC',serif` }}>邮局后台</div>
                <p className="text-[10px] text-white/45 leading-snug mb-2.5 shrink-0">用 worker 的 <b className="text-amber-200/70">ADMIN_TOKEN</b> 查看后端全部信件（按踩数、时间倒序，最多 200 条），可逐条删除。token 只存在本机。</p>
                <div className="flex gap-1.5 mb-3 shrink-0">
                    <input value={token} onChange={e => setToken(e.target.value)} type="password" placeholder="ADMIN_TOKEN" className="flex-1 rounded-lg bg-black/25 px-3 py-2 text-[11.5px] text-amber-50 placeholder-white/25 outline-none" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                    <button onClick={load} disabled={loading} className="shrink-0 px-3.5 rounded-lg text-[11px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{loading ? '…' : (letters ? '刷新' : '拉取')}</button>
                </div>
                {err && <div className="text-[10.5px] text-red-300/80 mb-2 shrink-0">{err}</div>}
                <div className="flex-1 overflow-y-auto vr-reader-scroll -mx-1 px-1 min-h-0">
                    {letters && letters.length === 0 && <p className="text-[10.5px] text-white/35">后端目前没有信件。</p>}
                    {(letters || []).map(l => (
                        <div key={l.id} className="rounded-lg p-2 mb-1.5 text-[11px]" style={{ background: 'rgba(255,255,255,.05)' }}>
                            <div className="flex items-center gap-1.5 mb-1">
                                <span className="text-amber-200/70 text-[9.5px]">{l.pen || '匿名'}</span>
                                {l.dislikes > 0 && <span className="text-[8.5px] text-red-300/80 border border-red-400/30 rounded-full px-1.5 leading-tight">踩 {l.dislikes}</span>}
                                <span className="ml-auto text-[8.5px] text-white/30">{new Date(l.created_at).toLocaleDateString()}</span>
                            </div>
                            <div className="text-white/75 leading-snug whitespace-pre-wrap mb-1">{l.content}</div>
                            <div className="flex items-center gap-2 text-[8.5px] text-white/35">
                                <span>赞{l.likes}</span><span>踩{l.dislikes}</span><span>读{l.views}</span><span>回{l.reply_count}</span>
                                {confirmId === l.id
                                    ? <button onClick={() => del(l.id)} className="ml-auto text-red-300 font-bold">确定删除</button>
                                    : <button onClick={() => setConfirmId(l.id)} className="ml-auto text-white/45 active:text-red-300">删除</button>}
                            </div>
                        </div>
                    ))}
                    {!letters && !loading && <p className="text-[10.5px] text-white/30">填入 token 后点「拉取」。</p>}
                </div>
                <button onClick={onClose} className="mt-3 rounded-full py-2 text-[12.5px] text-white/70 shrink-0" style={{ border: '1px solid rgba(255,255,255,.16)' }}>关闭</button>
            </div>
        </div>
    );
};

// ============ 玩法说明 ============
const HelpModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const Block: React.FC<{ title: string; tone?: string; children: React.ReactNode }> = ({ title, tone = 'rgba(180,180,255,.9)', children }) => (
        <div className="rounded-xl p-3 mb-2.5" style={{ background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.07)' }}>
            <div className="flex items-center gap-1.5 mb-1.5">
                <span className="h-3 w-[3px] rounded-full shrink-0" style={{ background: tone }} />
                <span className="text-[12.5px] font-semibold tracking-wide" style={{ color: tone, fontFamily: `'Noto Serif SC',serif` }}>{title}</span>
            </div>
            <div className="text-[11.5px] text-white/70 leading-relaxed space-y-1">{children}</div>
        </div>
    );
    const Step: React.FC<{ n: number; children: React.ReactNode }> = ({ n, children }) => (
        <div className="flex gap-2">
            <span className="shrink-0 h-4 w-4 mt-0.5 rounded-full flex items-center justify-center text-[9px] font-bold text-black" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{n}</span>
            <span className="flex-1">{children}</span>
        </div>
    );
    return (
        <div className="fixed inset-0 z-[80] flex flex-col" style={{ background: 'linear-gradient(180deg,#0c0a1c 0%,#080612 100%)' }}>
            <div className="flex items-center gap-2.5 px-5 pb-3 shrink-0 border-b border-white/8" style={{ paddingTop: VR_TOP }}>
                <span className="text-[15px] tracking-[0.2em] text-white/95" style={{ fontFamily: `'Noto Serif SC',serif` }}>彼方 · 玩法说明</span>
                <button onClick={onClose} className="ml-auto p-1.5 rounded-full text-white/60 active:bg-white/10"><X size={19} /></button>
            </div>
            <div className="flex-1 overflow-y-auto vr-reader-scroll px-4 pt-4" style={{ paddingBottom: vrBottomPad('1rem') }}>
                <p className="text-[12px] text-white/75 leading-relaxed mb-3">
                    「彼方」是你的角色们<b className="text-indigo-200">自己会去逛</b>的一方小世界。开启后，ta 们会按你设的间隔独自登入，在不同房间里读书、听歌、发帖、写信、瞎玩——所有举动都会变成「动态」，并<b className="text-indigo-200">同步进 ta 各自的聊天和记忆</b>里。这是 ta 不被你盯着的私人时间。
                </p>

                <Block title="世界观会自适应你的角色" tone="rgba(180,200,255,.95)">
                    <div>《彼方》本身是个<b className="text-indigo-200">类似 VRChat 的虚拟世界</b>。无论你的角色来自什么设定——现代、古代、魔法、末世、异世界都行——ta 都会用<b>符合自己世界观的方式</b>理解并进入这里，始终保持 ta 自己，不会因为来玩就 OOC。</div>
                    <div className="mt-1 text-white/60"><b className="text-amber-200">别担心「我家角色世界观对不上就不能玩」</b>：怎么进来、用什么道理解释自己身处其中，全交给角色自己圆。放心带 ta 来逛。</div>
                </Block>

                <Block title="怎么开始" tone="rgba(245,208,138,.95)">
                    <Step n={1}>去 <b>「接入」</b> 标签：给角色捏个小人形象，打开开关，设个登入间隔。</Step>
                    <Step n={2}>想用图书馆，先去 <b>「书库」</b> 上传一本小说。</Step>
                    <Step n={3}>不想等？在「接入」里点 <b>「让 ta 现在去逛一次」</b>，可以<b className="text-amber-200">指定房间或随机</b>，立刻看效果。</Step>
                </Block>

                <Block title="房间都能干嘛">
                    <div><b className="text-indigo-100">图书馆</b>：角色读你上传的小说、<b>自己写批注</b>。你能翻看 ta 的批注（动态里点批注还能跳回原文），不过<b className="text-amber-200">暂时还不能自己写批注</b>。</div>
                    <div><b className="text-indigo-100">听歌房</b>：从角色自己的歌单点歌、锐评正在放的曲子。</div>
                    <div><b className="text-indigo-100">留言簿</b>：公共版聊墙，角色发帖、接话茬。你也能在底部<b className="text-sky-200">以自己身份留言</b>，会广播给所有接入的角色。</div>
                    <div><b className="text-indigo-100">娱乐室</b>：纯放飞，角色在这儿瞎玩造谣找乐子。</div>
                    <div><b className="text-indigo-100">邮局</b>：写漂流信交陌生笔友——见下方重点。</div>
                    <div><b style={{ color: '#f5a6a6' }}>剧院</b>：角色逛进来会<b>写一出舞台剧</b>投稿。你可以翻投稿、自己写/让 LLM 写/传 txt，挑一本<b>【编排】</b>：给角色选演员（缺角能 roll 个 NPC），角色读完会提意见/改戏，<b>【召唤导演】</b>整合成最终本，小人气泡<b>演一遍</b>，再收进历史舞台剧。</div>
                </Block>

                <Block title="邮局怎么玩（重点）" tone="rgba(243,208,138,.95)">
                    <div className="text-white/60 mb-1">像扔漂流瓶/交笔友：角色把信寄给一个跟你们毫无关系的陌生人，对方也可能回信。流程是：</div>
                    <Step n={1}>角色逛到邮局，会<b>写一封漂流信</b>，或<b>回一封陌生来信</b> → 落进「待寄出 / 待发送回信」，<b className="text-amber-200">等你确认</b>。</Step>
                    <Step n={2}>你在邮局面板点 <b>「一键寄出」</b>，信才真正漂出去（笔名自动匿名）。</Step>
                    <Step n={3}>点 <b>「刷新收件箱」</b>，捞回陌生人寄来的信；角色下次逛邮局时可能回它。</Step>
                    <Step n={4}>你寄出的信有人回了，点 <b>「收取回复」</b> 收回 → 角色读完写下感触，信<b>封存进「信匣」</b>。</Step>
                    <div className="mt-1.5 text-white/60">· 待寄出的信、待发送的回信都能点 <b className="text-amber-200">「···」编辑 / 删除</b>。</div>
                    <div className="text-white/60">· 回信发出后，连同原来的来信一起归档到 <b style={{ color: '#86e3b0' }}>「已回」</b>，本地留存、随备份导出导入。</div>
                    <div className="text-white/60">· 每个分组都有颜色标签，一眼看出每封信的处境：<span className="text-amber-200">等你寄出</span> / <span className="text-sky-200">等角色回信</span> / <span style={{ color: '#93b8ff' }}>漂流中</span> / <span style={{ color: '#86e3b0' }}>已收到回复</span>。</div>
                </Block>

                <Block title="小提示" tone="rgba(180,200,255,.9)">
                    <div>· 「世界」页的<b>动态</b>长按可删除；满 5 条一页、可翻页。</div>
                    <div>· 角色在留言簿说的话，会原样进 ta 的聊天，不只是一句小总结。</div>
                    <div>· 阅读器里的批注都是<b>角色自己留</b>的；你目前只能翻看，<b className="text-amber-200">还不能亲自写批注</b>（以后再说）。</div>
                    <div>· 邮局/收件箱里的信多了也会分页，慢慢翻。</div>
                    <div>· 彼方较费 API：可在 <b>「API」</b> 标签给它单独指定一份（和设置里的预设共用），还能看<b>调用记录</b>对账。</div>
                </Block>

                <div className="h-2" />
            </div>
        </div>
    );
};

// 来信行（长按弹出：指定角色回 / 亲自回 / 删除）
const InboxLetterRow: React.FC<{ l: VRLetter; onMenu: (l: VRLetter) => void; onLike: (l: VRLetter) => void; onDislike: (l: VRLetter) => void }> = ({ l, onMenu, onLike, onDislike }) => {
    const { pressing, handlers } = useLongPress(() => onMenu(l), 500);
    const stop = (e: React.SyntheticEvent) => e.stopPropagation();
    return (
        <div {...handlers} className={`rounded-lg p-2 mb-1.5 text-[11px] text-white/80 leading-snug transition-transform ${pressing ? 'scale-[0.97]' : ''}`}
            style={{ background: pressing ? 'rgba(125,211,252,0.16)' : 'rgba(255,255,255,.04)', border: `1px solid ${pressing ? 'rgba(125,211,252,0.4)' : 'transparent'}` }}>
            <div className="flex items-center gap-1.5 mb-0.5"><span className="text-sky-200/80 font-bold text-[10.5px]">{l.pen}</span></div>
            <ExpandText text={l.content} limit={90} />
            <div className="flex items-center gap-3 mt-1.5 text-[10px]">
                <span className="text-white/30">阅 {l.views ?? 0}</span>
                <button onPointerDown={stop} onClick={e => { stop(e); onLike(l); }} className={`transition-colors ${l.myVote === 1 ? 'text-amber-300 font-semibold' : 'text-white/40'}`}>赞 {l.likes ?? 0}</button>
                <button onPointerDown={stop} onClick={e => { stop(e); onDislike(l); }} className={`transition-colors ${l.myVote === -1 ? 'text-red-300 font-semibold' : 'text-white/40'}`} title="踩即举报">踩 {l.dislikes ?? 0}</button>
                <span className="ml-auto text-white/25 text-[9px]">长按回信</span>
            </div>
        </div>
    );
};

// 亲自回信 / 编辑回信（不调用 LLM）
const ReplyComposeModal: React.FC<{ letter: VRLetter; defaultPen: string; initialContent?: string; title?: string; cta?: string; onSave: (pen: string, content: string) => void; onCancel: () => void }> = ({ letter, defaultPen, initialContent = '', title = '亲自回这封信', cta = '写好，排入待发送', onSave, onCancel }) => {
    const [pen, setPen] = useState(defaultPen);
    const [content, setContent] = useState(initialContent);
    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-6 bg-black/55 backdrop-blur-sm" onClick={onCancel}>
            <div className="w-full max-w-[340px] rounded-2xl p-4" onClick={e => e.stopPropagation()} style={{ background: 'linear-gradient(180deg,#221b12,#15100a)', border: '1px solid rgba(220,190,120,.28)', boxShadow: '0 16px 50px rgba(0,0,0,.6)' }}>
                <div className="text-[13px] font-semibold text-amber-100 mb-2" style={{ fontFamily: `'Noto Serif SC',serif` }}>{title}</div>
                <div className="rounded-lg bg-black/25 px-3 py-2 mb-3 text-[10.5px] text-white/55 leading-snug max-h-24 overflow-y-auto vr-reader-scroll" style={{ border: '1px solid rgba(255,255,255,.08)' }}>
                    原信（{letter.pen}）：{letter.content}
                </div>
                <label className="text-[10px] text-amber-200/60">你的笔名（寄出时匿名）</label>
                <input value={pen} onChange={e => setPen(e.target.value)} className="w-full mt-1 mb-2.5 rounded-lg bg-black/25 px-3 py-2 text-[12.5px] text-amber-50 outline-none" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                <label className="text-[10px] text-amber-200/60">回信正文</label>
                <textarea value={content} onChange={e => setContent(e.target.value)} rows={5} autoFocus placeholder="写下你想对这位陌生人说的话…"
                    className="w-full mt-1 rounded-lg bg-black/25 px-3 py-2 text-[12.5px] text-amber-50 placeholder-white/25 outline-none resize-none vr-reader-scroll" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                <div className="flex gap-2 mt-3.5">
                    <button onClick={onCancel} className="flex-1 rounded-full py-2 text-[12.5px] text-white/70" style={{ border: '1px solid rgba(255,255,255,.16)' }}>取消</button>
                    <button onClick={() => onSave(pen, content)} disabled={!content.trim()} className="flex-1 rounded-full py-2 text-[12.5px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{cta}</button>
                </div>
            </div>
        </div>
    );
};

// ============ 信号坠落处 · 顶部特殊活动 banner ============
// 尽量照搬那张设计图：深空 + 金框四角 + 右侧书影 + 发光衬线标题 + 英文副名 + 副标题；
// 右下角把「剩余时间倒计时」换成「已完成 x/20 首诗歌」的进度。点整块进入信号坠落处。
// banner 底图：月（仓库相对路径，经 assetUrl 走多 CDN 镜像兜底，见 utils/assetUrl.ts）
const SIGNAL_BANNER_MOON = 'img/MOON.png';
const SignalBanner: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
    const moonUrl = useResilientAssetUrl(SIGNAL_BANNER_MOON);
    const [bk, setBk] = useState<SignalBooklet | null>(null);
    useEffect(() => {
        let alive = true;
        const load = async () => { try { const s = await Signal.current(); if (alive) setBk(s.booklet); } catch { /* 离线：只是不显示进度 */ } };
        void load();
        const h = () => { void load(); };
        window.addEventListener('vr-session-done', h);
        return () => { alive = false; window.removeEventListener('vr-session-done', h); };
    }, []);
    const done = bk?.poemCount ?? 0;
    const total = bk?.poemsTarget ?? 40;
    return (
        <button onClick={onOpen} className="relative w-full h-[132px] rounded-2xl overflow-hidden text-left active:scale-[0.985] transition-transform"
            style={{ boxShadow: '0 10px 34px rgba(0,0,0,.5)', border: '1px solid rgba(196,164,92,.35)' }}>
            {/* 底图：月 */}
            <div className="absolute inset-0" style={{ backgroundImage: `url(${moonUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
            {/* 压暗 + 左侧加重，保证左侧文案在月面上可读 */}
            <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(8,6,22,.86) 0%, rgba(10,8,28,.6) 44%, rgba(10,8,30,.3) 100%)' }} />
            {/* 顶部光束 + 星尘 + 底部压暗 */}
            <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(210,190,255,.16), transparent 42%), linear-gradient(180deg, transparent 55%, rgba(8,6,22,.6))' }} />
            <div className="pointer-events-none absolute inset-0 opacity-70" style={{ backgroundImage: 'radial-gradient(1px 1px at 22% 30%, rgba(255,255,255,.55), transparent), radial-gradient(1px 1px at 66% 24%, rgba(210,220,255,.45), transparent), radial-gradient(1px 1px at 84% 60%, rgba(230,225,255,.4), transparent)' }} />
            {/* 金色内框 + 四角 */}
            <div className="absolute inset-[6px] rounded-xl pointer-events-none" style={{ border: '1px solid rgba(196,164,92,.26)' }} />
            {[['top-2.5 left-2.5', 'border-t border-l'], ['top-2.5 right-2.5', 'border-t border-r'], ['bottom-2.5 left-2.5', 'border-b border-l'], ['bottom-2.5 right-2.5', 'border-b border-r']].map(([pos, b], i) => (
                <div key={i} className={`absolute ${pos} w-4 h-4 ${b} pointer-events-none`} style={{ borderColor: 'rgba(212,178,102,.6)' }} />
            ))}
            {/* 文案 */}
            <div className="absolute inset-0 px-5 flex flex-col justify-center">
                <div className="text-[9px] tracking-[0.34em] text-amber-200/75 mb-1.5">{SIGNAL_EVENT_ENDED ? '特殊活动 · 已落幕 · 纪念馆' : '特殊活动 · 跨用户共写'}</div>
                <div className="text-[27px] leading-none font-bold text-white" style={{ fontFamily: `'Noto Serif SC',serif`, textShadow: '0 0 22px rgba(180,160,255,.55), 0 2px 5px rgba(0,0,0,.55)' }}>信号坠落处</div>
                <div className="text-[11px] italic tracking-[0.24em] text-indigo-200/50 mt-1.5" style={{ fontFamily: `'Noto Serif SC',serif` }}>Signal&nbsp;Fall</div>
                <div className="text-[10.5px] text-indigo-100/60 mt-1.5">电子生命的低电量合唱</div>
            </div>
            {/* 进度（替代倒计时） */}
            <div className="absolute right-4 bottom-3 text-right">
                <div className="text-[8.5px] tracking-[0.22em] text-amber-200/65 flex items-center gap-1 justify-end mb-0.5"><BookOpen size={10} weight="fill" /> {SIGNAL_EVENT_ENDED ? '已封卷' : '已完成'}</div>
                <div className="text-[15px] font-bold text-amber-100 tabular-nums leading-none" style={{ fontFamily: `'Noto Serif SC',serif` }}>{done}<span className="text-[11px] text-amber-200/55"> / {total} 首</span></div>
            </div>
        </button>
    );
};

// ============ 世界视图 ============
const SARWorldPage: React.FC<{
    occupants: CharacterProfile[];
    npcEnabled: boolean;
    caianMet: boolean;
    onTalkToCaian: () => void;
    onOpenGacha: () => void;
    onOpenCabinet: () => void;
    onOpenModuleShop: () => void;
    onBackPage: () => void;
}> = ({ occupants, npcEnabled, caianMet, onTalkToCaian, onOpenGacha, onOpenCabinet, onOpenModuleShop, onBackPage }) => (
    <section className="relative -mx-4 -mt-4 overflow-hidden" aria-label="SAR 活动空间"
        style={{ minHeight: 500, height: 'calc(100dvh - var(--chrome-top) - var(--safe-bottom) - 6.75rem)' }}>
        <RoomBackground roomId="sar" />
        <div className="pointer-events-none absolute inset-0" style={{ background: 'linear-gradient(180deg,rgba(8,9,18,.2),transparent 28%,transparent 70%,rgba(5,6,12,.66))' }} />

        <div className="absolute inset-x-5 top-5 z-10 flex items-start justify-between gap-4">
            <div>
                <div className="text-[8px] tracking-[0.34em] text-indigo-100/42">PAGE 02 · ACTIVITY SPACE</div>
                <h2 className="mt-1 text-[20px] tracking-[0.16em] text-white/92" style={{ fontFamily: `'Noto Serif SC',serif`, fontWeight: 500 }}>SAR 活动空间</h2>
                <p className="mt-1 text-[9.5px] tracking-[0.08em] text-white/35">Synthetic Autonomy Rights</p>
            </div>
            <div className="rounded-full px-2.5 py-1 text-[9px] text-white/48 backdrop-blur-md" style={{ background: 'rgba(7,8,16,.34)', border: '1px solid rgba(255,255,255,.09)' }}>
                {npcEnabled ? '2 位常驻 NPC' : 'NPC 已隐藏'}
            </div>
        </div>

        {occupants.length > 0 && (
            <div className="absolute right-5 top-[19%] z-10 rounded-2xl px-2.5 py-2 backdrop-blur-md" style={{ background: 'rgba(7,8,16,.36)', border: '1px solid rgba(255,255,255,.08)' }}>
                <div className="mb-1 text-right text-[7.5px] tracking-[0.16em] text-white/34">接入中的玩家</div>
                <div className="flex justify-end -space-x-1.5">
                    {occupants.slice(0, 4).map(char => {
                        const chibi = getChibi(char);
                        return chibi.img
                            ? <TokenImg key={char.id} value={chibi.img} className="h-9 w-9 object-contain object-bottom drop-shadow" alt={char.name} style={{ transform: `scaleX(${chibi.flip ? -1 : 1})` }} />
                            : <div key={char.id} className="grid h-7 w-7 place-items-center rounded-full border border-white/20 bg-indigo-400/55 text-[9px] text-white">{char.name.slice(0, 1)}</div>;
                    })}
                    {occupants.length > 4 && <span className="grid h-7 w-7 place-items-center rounded-full bg-black/45 text-[8px] text-white/65">+{occupants.length - 4}</span>}
                </div>
            </div>
        )}

        <SARClubStage npcEnabled={npcEnabled} caianMet={caianMet} onTalkToCaian={onTalkToCaian} onOpenGacha={onOpenGacha} onOpenCabinet={onOpenCabinet} onOpenModuleShop={onOpenModuleShop} fullPage />

        {!npcEnabled && (
            <div className="absolute left-1/2 top-[45%] z-10 w-[72%] -translate-x-1/2 rounded-2xl px-4 py-3 text-center text-[11px] leading-5 text-white/48 backdrop-blur-md" style={{ background: 'rgba(8,9,18,.46)', border: '1px solid rgba(255,255,255,.08)' }}>
                活动室保持开放。需要时可在「接入」中重新显示凯恩与艾文。
            </div>
        )}

        <div className="absolute inset-x-0 bottom-3 z-20 flex items-center justify-center gap-3">
            <button type="button" onClick={onBackPage} aria-label="返回上一页房间"
                className="grid h-8 w-8 place-items-center rounded-full text-white/75 backdrop-blur-md active:bg-white/15" style={{ background: 'rgba(7,8,16,.42)', border: '1px solid rgba(255,255,255,.14)' }}>
                <CaretLeft size={14} weight="bold" />
            </button>
            <span className="rounded-full px-3 py-1 text-[10px] tracking-[0.15em] text-white/48 backdrop-blur-md" style={{ background: 'rgba(7,8,16,.36)', border: '1px solid rgba(255,255,255,.08)' }}>2 / 2</span>
            <button type="button" disabled aria-label="已经是最后一页"
                className="grid h-8 w-8 place-items-center rounded-full text-white/20" style={{ border: '1px solid rgba(255,255,255,.07)' }}>
                <CaretRight size={14} weight="bold" />
            </button>
        </div>
    </section>
);

const WorldView: React.FC<{
    occupantsByRoom: Record<string, CharacterProfile[]>;
    feed: FeedItem[]; novelCount: number;
    poBadge: { toSend: number; toCollect: number };
    onEnterRoom: (r: VRRoomId) => void; onGoLibrary: () => void;
    onJump: (novelId: string | undefined, segIdx: number) => void;
    onDeleteFeed: (msgId: number) => void; onDeleteFeedMany: (ids: number[]) => void;
    sarNpcEnabled: boolean; sarCaianMet: boolean;
    roomPage: 0 | 1; onRoomPageChange: (page: 0 | 1) => void;
    onTalkToCaian: () => void;
    onOpenGacha: () => void;
    onOpenCabinet: () => void;
    onOpenModuleShop: () => void;
}> = ({ occupantsByRoom, feed, novelCount, poBadge, onEnterRoom, onGoLibrary, onJump, onDeleteFeed, onDeleteFeedMany, sarNpcEnabled, sarCaianMet, roomPage, onRoomPageChange, onTalkToCaian, onOpenGacha, onOpenCabinet, onOpenModuleShop }) => {
    const FEED_PER_PAGE = 5;
    const [page, setPage] = useState(0);
    const totalPages = Math.max(1, Math.ceil(feed.length / FEED_PER_PAGE));
    const curPage = Math.min(page, totalPages - 1);
    const shown = feed.slice(curPage * FEED_PER_PAGE, curPage * FEED_PER_PAGE + FEED_PER_PAGE);
    const [confirmDel, setConfirmDel] = useState<FeedItem | null>(null);
    // 管理模式：多选删除（替代原「清空」）。选择跨页保留。
    const [manageMode, setManageMode] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [confirmBatch, setConfirmBatch] = useState(false);
    const exitManage = () => { setManageMode(false); setSelectedIds(new Set()); };
    const toggleSelect = (msgId: number) => setSelectedIds(prev => {
        const n = new Set(prev); n.has(msgId) ? n.delete(msgId) : n.add(msgId); return n;
    });
    const shownIds = shown.map(f => f.msgId);
    const allShownSelected = shownIds.length > 0 && shownIds.every(id => selectedIds.has(id));
    const toggleSelectPage = () => setSelectedIds(prev => {
        const n = new Set(prev);
        if (allShownSelected) shownIds.forEach(id => n.delete(id));
        else shownIds.forEach(id => n.add(id));
        return n;
    });
    // 第一页保持原有六个公共房间；第二页本身就是完整 SAR 空间，不再套一层房间入口。
    const shownRooms = VR_ROOMS.filter(room => !room.hiddenFromGrid && room.id !== 'sar' && room.id !== 'cafe');
    const roomTotalPages = 2;
    const curRoomPage = roomPage;

    if (curRoomPage === 1) {
        return (
            <SARWorldPage occupants={occupantsByRoom.sar || []} npcEnabled={sarNpcEnabled} caianMet={sarCaianMet}
                onTalkToCaian={onTalkToCaian} onOpenGacha={onOpenGacha} onOpenCabinet={onOpenCabinet}
                onOpenModuleShop={onOpenModuleShop} onBackPage={() => onRoomPageChange(0)} />
        );
    }
    return (
    <div className="space-y-4">
        {/* 顶部特殊活动 banner：信号坠落处（跨用户接龙诗） */}
        <SignalBanner onOpen={() => { onEnterRoom('signal'); trackEvent('进入彼方房间', { room: 'signal' }); }} />
        <div className="grid grid-cols-2 gap-3">
            {shownRooms.map(room => {
                const occupants = occupantsByRoom[room.id] || [];
                return (
                    <button key={room.id} aria-label={room.implemented ? `进入 ${room.name}` : `${room.name}开发中`} onClick={() => { if (room.implemented) { onEnterRoom(room.id); trackEvent('进入彼方房间', { room: room.id }); } }}
                        className={`relative rounded-2xl h-36 overflow-hidden text-left active:scale-[0.98] transition-transform ${room.implemented ? '' : 'opacity-65'}`}
                        style={{ boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: room.implemented ? '1px solid rgba(255,255,255,.12)' : '1px solid rgba(255,255,255,.05)' }}>
                        <RoomBackground roomId={room.id} />
                        {/* 顶部渐隐 + 标题 */}
                        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg,rgba(5,6,14,.45),transparent 38%,transparent 66%,rgba(5,6,14,.62))' }} />
                        {/* 内描边光 */}
                        <div className="absolute inset-0 rounded-2xl pointer-events-none" style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,.12)' }} />
                        <div className="absolute top-2.5 left-3 flex items-center gap-1.5">
                            <span className="text-[12.5px] tracking-[0.14em] text-white drop-shadow" style={{ fontFamily: `'Noto Serif SC',serif`, fontWeight: 500 }}>{room.name}</span>
                            {!room.implemented && <span className="text-[7px] tracking-wider text-white/60 border border-white/25 rounded-full px-1.5 ml-0.5">开发中</span>}
                        </div>
                        {room.id === 'postoffice' && (poBadge.toCollect > 0 || poBadge.toSend > 0) && (
                            <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
                                {poBadge.toCollect > 0 && (
                                    <span className="text-[8.5px] font-bold text-black rounded-full px-1.5 py-0.5 leading-none animate-pulse" style={{ background: 'linear-gradient(120deg,#ffd98a,#f5b94f)', boxShadow: '0 1px 6px rgba(245,185,79,.6)' }}>{poBadge.toCollect} 封回信</span>
                                )}
                                {poBadge.toSend > 0 && (
                                    <span className="text-[8.5px] font-bold text-white/90 rounded-full px-1.5 py-0.5 leading-none" style={{ background: 'rgba(0,0,0,.45)', border: '1px solid rgba(255,255,255,.25)' }}>{poBadge.toSend} 待寄</span>
                                )}
                            </div>
                        )}
                        {!room.implemented && (
                            <div className="absolute inset-0 flex items-center justify-center">
                                <span className="text-[11px] tracking-[0.3em] text-white/55" style={{ fontFamily: `'Noto Serif SC',serif` }}>蒸笼预热中…</span>
                            </div>
                        )}
                        {/* 角色小头像缩影 */}
                        <div className="absolute bottom-2 left-2.5 right-2.5 flex items-end justify-between">
                            <div className="flex -space-x-2">
                                {occupants.slice(0, 4).map(c => {
                                    const ch = getChibi(c);
                                    return ch.img
                                        ? <TokenImg key={c.id} value={ch.img} className="h-9 w-9 object-contain object-bottom drop-shadow" alt="" style={{ transform: `scaleX(${ch.flip ? -1 : 1})` }} />
                                        : <div key={c.id} className="h-6 w-6 rounded-full bg-indigo-400/70 border border-white/40 flex items-center justify-center text-[9px]">{c.name.slice(0, 1)}</div>;
                                })}
                            </div>
                            {room.implemented && <span className="text-[9px] text-white/80 font-bold flex items-center gap-0.5">进入 <CaretRight size={10} weight="bold" /></span>}
                        </div>
                    </button>
                );
            })}
        </div>
        {roomTotalPages > 1 && (
            <div className="flex items-center justify-center gap-3 -mt-1">
                <button onClick={() => onRoomPageChange(0)} disabled={curRoomPage === 0}
                    aria-label="上一页房间"
                    className="h-7 w-7 rounded-full flex items-center justify-center text-white/70 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)' }}><CaretLeft size={13} weight="bold" /></button>
                <span className="text-[10.5px] text-white/45 tracking-wider tabular-nums">{curRoomPage + 1} / {roomTotalPages}</span>
                <button onClick={() => onRoomPageChange(1)} disabled={curRoomPage >= roomTotalPages - 1}
                    aria-label="下一页房间"
                    className="h-7 w-7 rounded-full flex items-center justify-center text-white/70 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)' }}><CaretRight size={13} weight="bold" /></button>
            </div>
        )}

        {novelCount === 0 && (
            <button onClick={onGoLibrary} className="w-full rounded-2xl py-3.5 text-[12px] text-white/65 tracking-wide active:bg-white/5"
                style={{ border: '1px dashed rgba(255,255,255,.18)', background: 'rgba(255,255,255,.02)' }}>
                书库尚空 · 上传一卷小说，角色便会在图书馆与它相遇 →
            </button>
        )}

        <div>
            <div className="flex items-center gap-2.5 mb-3 mt-1">
                {/* 左侧占位：与右侧齿轮等宽，撑对称，让「彼方动态」真正居中 */}
                {feed.length > 0 && <span className="w-7 shrink-0" aria-hidden="true" />}
                <span className="h-px flex-1" style={{ background: 'linear-gradient(90deg,transparent,rgba(255,255,255,.14))' }} />
                <span className="text-[10.5px] tracking-[0.3em] text-white/50" style={{ fontFamily: `'Noto Serif SC',serif` }}>彼方动态</span>
                <span className="h-px flex-1" style={{ background: 'linear-gradient(90deg,rgba(255,255,255,.14),transparent)' }} />
                {feed.length > 0 && (
                    <button onClick={() => manageMode ? exitManage() : setManageMode(true)}
                        aria-label={manageMode ? '退出管理' : '管理动态'}
                        className="shrink-0 h-7 w-7 rounded-full flex items-center justify-center transition-colors"
                        style={{ border: `1px solid ${manageMode ? 'rgba(129,140,248,.55)' : 'rgba(255,255,255,.14)'}`, background: manageMode ? 'rgba(99,102,241,.22)' : 'rgba(255,255,255,.03)', color: manageMode ? '#c7d2fe' : 'rgba(255,255,255,.55)' }}>
                        {manageMode ? <X size={13} weight="bold" /> : <Gear size={14} weight="bold" />}
                    </button>
                )}
            </div>
            {feed.length === 0 ? (
                <p className="text-[11px] text-white/40 py-5 text-center tracking-wide leading-relaxed">虚空尚无回响。<br />在「接入」里点亮角色，ta 们到点会独自登入这里。</p>
            ) : (
                <>
                    {/* 翻页移到动态上方：底下翻页要滚到最后才够得着，放上方更顺手 */}
                    {totalPages > 1 && (
                        <div className="flex items-center justify-center gap-2 mb-3">
                            <button onClick={() => setPage(p => Math.max(0, Math.min(p, totalPages - 1) - 1))} disabled={curPage === 0}
                                className="h-8 pl-2 pr-3 rounded-full flex items-center gap-1 text-[11px] text-white/75 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)', background: 'rgba(255,255,255,.04)' }}><CaretLeft size={12} weight="bold" />上一页</button>
                            <span className="text-[11px] text-white/55 tracking-wider tabular-nums min-w-[46px] text-center">{curPage + 1} / {totalPages}</span>
                            <button onClick={() => setPage(p => Math.min(totalPages - 1, Math.min(p, totalPages - 1) + 1))} disabled={curPage >= totalPages - 1}
                                className="h-8 pl-3 pr-2 rounded-full flex items-center gap-1 text-[11px] text-white/75 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)', background: 'rgba(255,255,255,.04)' }}>下一页<CaretRight size={12} weight="bold" /></button>
                        </div>
                    )}
                    {manageMode ? (
                        <div className="flex items-center gap-2 mb-2.5 px-0.5">
                            <button onClick={toggleSelectPage}
                                className="text-[11px] text-white/85 rounded-full px-3 py-1.5 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.18)', background: 'rgba(255,255,255,.04)' }}>
                                {allShownSelected ? '取消本页' : '选择本页'}
                            </button>
                            <span className="text-[10.5px] text-white/45 tabular-nums">已选 {selectedIds.size} 条</span>
                            <button onClick={() => { if (selectedIds.size > 0) setConfirmBatch(true); }} disabled={selectedIds.size === 0}
                                className="ml-auto text-[11px] font-semibold text-white rounded-full px-4 py-1.5 disabled:opacity-30 active:opacity-85" style={{ background: 'linear-gradient(120deg,#f43f5e,#e11d48)' }}>
                                删除{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
                            </button>
                        </div>
                    ) : (
                        <p className="text-[9px] text-white/25 text-center mb-2">长按动态可删除 · 点「管理」可多选</p>
                    )}
                    <div className="space-y-2.5">
                        {shown.map(item => <FeedCard key={item.msgId} item={item} onJump={onJump} onRequestDelete={setConfirmDel}
                            manageMode={manageMode} selected={selectedIds.has(item.msgId)} onToggleSelect={toggleSelect} />)}
                    </div>
                </>
            )}
        </div>
        <ConfirmDialog open={!!confirmDel} title="删除这条动态？" message={confirmDel ? `${confirmDel.charName} 在${getRoom(confirmDel.meta.room).name}的这条记录将被移除。` : ''}
            onConfirm={() => { if (confirmDel) onDeleteFeed(confirmDel.msgId); setConfirmDel(null); }} onCancel={() => setConfirmDel(null)} />
        <ConfirmDialog open={confirmBatch} title={`删除选中的 ${selectedIds.size} 条动态？`} message="动态即聊天里的同一条卡片消息，删除后聊天记录里对应的卡片也会一并移除。"
            onConfirm={() => { onDeleteFeedMany(Array.from(selectedIds)); setSelectedIds(new Set()); setConfirmBatch(false); }} onCancel={() => setConfirmBatch(false)} />
    </div>
    );
};

// 单条动态卡片：非管理态长按删除；管理态点击多选。已隐藏（对 AI 不可见）的暗显并标「已隐藏」。
const FeedCard: React.FC<{ item: FeedItem; onJump: (novelId: string | undefined, segIdx: number) => void; onRequestDelete: (item: FeedItem) => void; manageMode?: boolean; selected?: boolean; onToggleSelect?: (msgId: number) => void }> = ({ item, onJump, onRequestDelete, manageMode, selected, onToggleSelect }) => {
    const room = getRoom(item.meta.room);
    const { pressing, handlers } = useLongPress(() => onRequestDelete(item), 550);
    const cardHandlers = manageMode ? { onClick: () => onToggleSelect?.(item.msgId) } : handlers;
    return (
        <div {...cardHandlers}
            className={`relative rounded-2xl p-3 flex gap-3 backdrop-blur-sm transition-transform ${pressing ? 'scale-[0.97]' : ''} ${manageMode ? 'cursor-pointer' : ''} ${item.hidden && !selected ? 'opacity-55' : ''}`}
            style={{ background: selected ? 'rgba(99,102,241,0.20)' : pressing ? 'rgba(244,63,94,0.14)' : 'rgba(255,255,255,0.05)', border: `1px solid ${selected ? 'rgba(129,140,248,0.6)' : pressing ? 'rgba(244,63,94,0.4)' : 'rgba(255,255,255,0.07)'}`, boxShadow: '0 4px 18px rgba(0,0,0,.22)' }}>
            {manageMode && (
                <div className="self-center shrink-0 h-5 w-5 rounded-full flex items-center justify-center" style={{ border: `1.5px solid ${selected ? '#818cf8' : 'rgba(255,255,255,.35)'}`, background: selected ? '#6366f1' : 'transparent' }}>
                    {selected && <Check size={12} weight="bold" className="text-white" />}
                </div>
            )}
            {item.avatar ? <TokenImg value={item.avatar} className="h-8 w-8 rounded-full object-cover shrink-0" alt="" /> : <div className="h-8 w-8 rounded-full bg-indigo-400/40 shrink-0" />}
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[11px]">
                    <span className="font-bold text-amber-200">{item.charName}</span>
                    <span className="text-indigo-300/50">{room.name}</span>
                    {item.hidden && <span className="text-[8px] text-white/55 rounded-full px-1.5 py-[1px] leading-none shrink-0" style={{ border: '1px solid rgba(255,255,255,.2)', background: 'rgba(0,0,0,.28)' }}>已隐藏</span>}
                    <span className="ml-auto text-indigo-300/40 text-[9px] shrink-0">{new Date(item.timestamp).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <p className="text-[11.5px] text-indigo-50/90 mt-0.5 leading-snug">{stripSelfName(item.meta.activity, item.charName)}</p>
                {item.meta.behavior && <p className="text-[10.5px] text-pink-200/80 mt-1 leading-snug">{stripSelfName(item.meta.behavior, item.charName)}</p>}
                {item.meta.annotationRefs && item.meta.annotationRefs.length > 0 ? (
                    <div className="mt-1 space-y-0.5">
                        {item.meta.annotationRefs.slice(0, 3).map((ref, i) => (
                            <button key={i} onClick={() => { if (manageMode) { onToggleSelect?.(item.msgId); return; } onJump(item.meta.novelId, ref.segIdx); }}
                                className="block w-full text-left text-[10.5px] text-indigo-200/80 pl-2 border-l-2 border-amber-300/50 leading-snug active:opacity-60 hover:text-amber-100">
                                {stripLeakedAttrs(ref.text)} <span className="text-amber-300/60">↗原文</span>
                            </button>
                        ))}
                    </div>
                ) : item.meta.annotationExcerpts && item.meta.annotationExcerpts.length > 0 ? (
                    <div className="mt-1 space-y-0.5">
                        {item.meta.annotationExcerpts.slice(0, 2).map((ex, i) => (
                            <div key={i} className="text-[10.5px] text-indigo-200/70 pl-2 border-l-2 border-amber-300/40 leading-snug">{stripLeakedAttrs(ex)}</div>
                        ))}
                    </div>
                ) : null}
                {item.meta.room === 'postoffice' && item.meta.letterExcerpt && (
                    <div className="mt-1 text-[10.5px] text-amber-100/75 pl-2 border-l-2 border-amber-300/45 leading-snug" style={{ fontStyle: 'italic' }}>
                        「{item.meta.letterExcerpt.length > 70 ? item.meta.letterExcerpt.slice(0, 70) + '…' : item.meta.letterExcerpt}」
                    </div>
                )}
                {item.meta.room === 'signal' && item.meta.signalLine && (
                    <div className="mt-1">
                        <div className="text-[9.5px] text-indigo-300/55">
                            《{item.meta.poemTitle || '无题'}》{item.meta.poemLineSeq ? ` · 第 ${item.meta.poemLineSeq}/${item.meta.poemTargetLines || '?'} 句` : ''}{item.meta.signalIsNew ? ' · 起新篇' : ''}
                        </div>
                        <div className="mt-0.5 text-[11px] text-indigo-100/85 pl-2 border-l-2 border-indigo-300/45 leading-snug" style={{ fontStyle: 'italic' }}>
                            {item.meta.signalLine}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

// 可展开全文（点击切换截断/完整）
const ExpandText: React.FC<{ text: string; limit?: number }> = ({ text, limit = 90 }) => {
    const [open, setOpen] = useState(false);
    const long = text.length > limit;
    return (
        <span onClick={() => long && setOpen(o => !o)} className={long ? 'cursor-pointer' : ''}>
            <span className="whitespace-pre-wrap">{open || !long ? text : text.slice(0, limit) + '…'}</span>
            {long && <span className="text-amber-300/70 ml-1 text-[10px]">{open ? '收起' : '展开全文'}</span>}
        </span>
    );
};

// ============ 邮局信件管理面板 ============
const PostOfficePanel: React.FC<{ addToast?: (m: string, t?: any) => void; characters: CharacterProfile[]; userName: string }> = ({ addToast, characters, userName }) => {
    const [letters, setLetters] = useState<VRLetter[]>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const [menuFor, setMenuFor] = useState<VRLetter | null>(null);
    const [editing, setEditing] = useState<VRLetter | null>(null);
    const [confirmDel, setConfirmDel] = useState<VRLetter | null>(null);
    const [inboxMenu, setInboxMenu] = useState<VRLetter | null>(null);   // 来信长按菜单
    const [assignFor, setAssignFor] = useState<VRLetter | null>(null);   // 指定角色回信的选人面板
    const [replyFor, setReplyFor] = useState<VRLetter | null>(null);     // 亲自回信编辑器
    const [replyMenu, setReplyMenu] = useState<VRLetter | null>(null);   // 待发送回信的长按菜单
    const [editReplyFor, setEditReplyFor] = useState<VRLetter | null>(null); // 编辑待发送回信
    const [confirmReport, setConfirmReport] = useState<VRLetter | null>(null); // 点踩=举报二次确认
    const [identityOpen, setIdentityOpen] = useState(false);            // 身份导出/导入弹窗
    const [adminOpen, setAdminOpen] = useState(false);                  // 后台（看后端全部信件）弹窗
    const [composeNew, setComposeNew] = useState<VRLetter | null>(null); // 用户自己写新信的草稿
    const [myStats, setMyStats] = useState<Record<string, RemoteLetterStat>>({}); // 我寄出的信热度（按 remoteId）
    const [tab, setTab] = useState<'outbox' | 'reply' | 'replied' | 'inbox' | 'drift' | 'box'>('outbox'); // 左侧分类
    const [sentMenu, setSentMenu] = useState<VRLetter | null>(null);     // 已寄出信的管理菜单
    const [confirmDelSent, setConfirmDelSent] = useState<VRLetter | null>(null); // 删除已寄出信的确认
    const enabledChars = characters.filter(c => c.vrState?.enabled);

    const load = useCallback(async () => setLetters(await DB.getVRLetters()), []);
    const loadStats = useCallback(async () => {
        try {
            const stats = await PostOffice.fetchMyStats();
            const map: Record<string, RemoteLetterStat> = {};
            stats.forEach(s => { map[s.id] = s; });
            setMyStats(map);
        } catch { /* 离线/失败不影响其它功能 */ }
    }, []);
    useEffect(() => {
        void load(); void loadStats();
        const h = () => { void load(); void loadStats(); };
        window.addEventListener('vr-session-done', h);
        return () => window.removeEventListener('vr-session-done', h);
    }, [load, loadStats]);

    const outQueued = letters.filter(l => l.box === 'outbox' && l.status === 'queued');
    const replyQueued = letters.filter(l => l.box === 'inbox' && l.replyStatus === 'queued' && l.reply);
    const repliedSent = letters.filter(l => l.box === 'inbox' && l.replyStatus === 'sent' && l.reply);
    const inboxWaiting = letters.filter(l => l.box === 'inbox' && (l.replyStatus ?? 'none') === 'none');
    const sentAwaiting = letters.filter(l => l.box === 'outbox' && l.status === 'sent');
    const archived = letters.filter(l => l.box === 'outbox' && (l.status === 'archived' || l.status === 'sealed'));

    const sendOutbox = async () => {
        if (outQueued.length === 0) return;
        // A：正文超长就拦下，让用户先编辑精简，不静默截断
        const tooLong = outQueued.filter(l => charLen(l.content) > MAX_LETTER_CHARS);
        if (tooLong.length) { addToast?.(`有 ${tooLong.length} 封超过 ${MAX_LETTER_CHARS} 字，请长按编辑精简后再寄`, 'error'); return; }
        // B：前端日额度（给后端减负），额度不够就只寄能寄的那几封，其余留队列
        const q = readQuota(PO_SEND_QUOTA);
        const remaining = Math.max(0, PO_SEND_QUOTA.limit - q.count);
        if (remaining <= 0) { addToast?.(`寄信暂时到上限（${PO_SEND_QUOTA.limit} 封/${PO_SEND_QUOTA.windowMs / 3600_000} 小时），约 ${quotaResetHours(q.windowStart, PO_SEND_QUOTA.windowMs)} 小时后恢复`, 'info'); return; }
        const batch = outQueued.slice(0, remaining);
        const heldBack = outQueued.length - batch.length;
        setBusy('send');
        try {
            const ids = await PostOffice.uploadLetters(batch.map(l => ({ pen: l.pen, content: l.content })));
            await DB.saveVRLetters(batch.map((l, i) => ({ ...l, status: 'sent', remoteId: ids[i], sentAt: Date.now() })));
            bumpQuota(PO_SEND_QUOTA, batch.length);
            await load();
            trackEvent('一键寄出漂流信');
            addToast?.(heldBack > 0
                ? `已寄出 ${ids.length} 封，额度用完，还剩 ${heldBack} 封约 ${quotaResetHours(readQuota(PO_SEND_QUOTA).windowStart, PO_SEND_QUOTA.windowMs)} 小时后再寄`
                : `已寄出 ${ids.length} 封漂流信`, 'success');
        } catch (e: any) {
            const msg = /429|rate limit/i.test(e?.message || '')
                ? '后端每 5 小时限 5 封，刚寄太猛被挡了，待会儿再寄剩下的（信都还在队列）'
                : '寄出失败：' + (e?.message || '检查网络');
            addToast?.(msg, 'error');
        } finally { setBusy(null); }
    };
    const refreshInbox = async () => {
        setBusy('inbox');
        try {
            const n = 2 + Math.floor(Math.random() * 4); // 每次随机捞 2~5 封，别一次太猛
            const remote = await PostOffice.fetchInbox(n);
            const fresh: VRLetter[] = remote.map(r => ({ id: genLocalId('lt'), box: 'inbox', pen: r.pen, content: r.content, createdAt: r.created_at, remoteLetterId: r.id, replyStatus: 'none', fetchedAt: Date.now(), likes: r.likes ?? 0, dislikes: r.dislikes ?? 0, views: r.views ?? 0, myVote: 0 }));
            await DB.saveVRLetters(fresh);
            await load(); addToast?.(remote.length ? `收到 ${remote.length} 封陌生来信` : '暂时没有新的来信', 'info');
        } catch (e: any) { addToast?.('刷新失败：' + (e?.message || '检查网络'), 'error'); } finally { setBusy(null); }
    };
    const sendReplies = async () => {
        if (replyQueued.length === 0) return;
        // 前端日额度：每天最多 PO_REPLY_QUOTA.limit 封回信，额度不足只发能发的，其余留队列
        const q = readQuota(PO_REPLY_QUOTA);
        const remaining = Math.max(0, PO_REPLY_QUOTA.limit - q.count);
        if (remaining <= 0) { addToast?.(`今天已回满 ${PO_REPLY_QUOTA.limit} 封，约 ${quotaResetHours(q.windowStart, PO_REPLY_QUOTA.windowMs)} 小时后恢复`, 'info'); return; }
        const batch = replyQueued.slice(0, remaining);
        const heldBack = replyQueued.length - batch.length;
        setBusy('reply');
        try {
            const payload = batch.map(l => ({
                letterId: l.remoteLetterId!, pen: l.reply!.pen,
                content: l.reply!.userNote ? `${l.reply!.content}\n\n——\n${l.reply!.userNote}` : l.reply!.content,
            }));
            await PostOffice.uploadReplies(payload);
            bumpQuota(PO_REPLY_QUOTA, batch.length);
            await DB.saveVRLetters(batch.map(l => ({ ...l, replyStatus: 'sent' as const })));
            await load();
            trackEvent('一键发送待发的回信');
            addToast?.(heldBack > 0
                ? `已发出 ${payload.length} 封回信，今日额度用完，还剩 ${heldBack} 封约 ${quotaResetHours(readQuota(PO_REPLY_QUOTA).windowStart, PO_REPLY_QUOTA.windowMs)} 小时后再发`
                : `已发出 ${payload.length} 封回信`, heldBack > 0 ? 'info' : 'success');
        } catch (e: any) { addToast?.('发送失败：' + (e?.message || '检查网络'), 'error'); } finally { setBusy(null); }
    };
    const collectReplies = async () => {
        setBusy('collect');
        void loadStats();   // 顺手刷新「我寄出的信」赞/踩/浏览/回信数
        try {
            const replies = await PostOffice.fetchReplies();
            if (replies.length === 0) { addToast?.('还没有人回你的信', 'info'); setBusy(null); return; }
            const byLetter = new Map<string, RemoteReply[]>();
            replies.forEach(r => { const a = byLetter.get(r.letter_id) || []; a.push(r); byLetter.set(r.letter_id, a); });
            // 一封漂流信可能被多个陌生人捡到、陆续回信。所以这里"刷新"而不是"一次性领取后释放"：
            // 把后端当前的全部回复同步到本地（含已留档但还没被角色读封存的），不释放；
            // 等原作者角色逛到邮局读完、写下感触、封存时才释放后端（见 runSession）。
            const pending = letters.filter(l => l.box === 'outbox' && l.remoteId && (l.status === 'sent' || l.status === 'archived'));
            const updates: VRLetter[] = [];
            let newlyArchived = 0, addedReplies = 0;
            for (const l of pending) {
                const rs = byLetter.get(l.remoteId!);
                if (!rs || rs.length === 0) continue;
                const before = l.repliesReceived?.length || 0;
                if (rs.length > before || l.status === 'sent') {
                    if (l.status === 'sent') newlyArchived++;
                    addedReplies += Math.max(0, rs.length - before);
                    updates.push({ ...l, status: 'archived', repliesReceived: rs.map(x => ({ pen: x.pen, content: x.content, createdAt: x.created_at })) });
                }
            }
            if (updates.length) await DB.saveVRLetters(updates);
            await load();
            addToast?.(updates.length
                ? `收到回复（${newlyArchived ? `${newlyArchived} 封新留档` : '已更新'}${addedReplies ? ` · 新增 ${addedReplies} 条` : ''}），等角色去邮局读`
                : '回复还没匹配到你的信', 'success');
        } catch (e: any) { addToast?.('收取失败：' + (e?.message || '检查网络'), 'error'); } finally { setBusy(null); }
    };

    const setUserNote = async (l: VRLetter, note: string) => {
        const next = { ...l, reply: { ...l.reply!, userNote: note } };
        setLetters(prev => prev.map(x => x.id === l.id ? next : x));
        await DB.saveVRLetter(next);
    };
    const del = async (id: string) => { await DB.deleteVRLetter(id); await load(); };
    const saveEdit = async (pen: string, content: string) => {
        if (!editing) return;
        const next = { ...editing, pen: pen.trim() || editing.pen, content: content.trim() };
        await DB.saveVRLetter(next); setEditing(null); await load();
    };
    // 指定某角色去邮局回这封来信（走 LLM）
    const assignReply = (charId: string) => {
        if (!assignFor) return;
        VRScheduler.triggerNow(charId, 'postoffice', assignFor.id);
        const cname = enabledChars.find(c => c.id === charId)?.name;
        addToast?.(`${cname ?? '角色'} 正在去邮局回这封信…`, 'info');
        trackEvent('指定角色去邮局回这封来信');
        setAssignFor(null);
        setTimeout(() => void load(), 5000);
    };
    // 用户亲自回信（不调用 LLM），排入"待发送的回信"
    const saveManualReply = async (pen: string, content: string) => {
        if (!replyFor) return;
        const next: VRLetter = { ...replyFor, replyStatus: 'queued', reply: { charId: 'user', pen: pen.trim() || userName, content: content.trim(), createdAt: Date.now() } };
        await DB.saveVRLetter(next); setReplyFor(null); await load();
        addToast?.('回信已写好，去「待发送的回信」一键发送', 'success');
    };
    // 编辑一条待发送的回信（改笔名 / 正文）
    const saveReplyEdit = async (pen: string, content: string) => {
        if (!editReplyFor || !editReplyFor.reply) return;
        const next: VRLetter = { ...editReplyFor, reply: { ...editReplyFor.reply, pen: pen.trim() || editReplyFor.reply.pen, content: content.trim() } };
        await DB.saveVRLetter(next); setEditReplyFor(null); await load();
    };

    // 投票：点赞(1)/点踩=举报(-1)/撤销(0)。踩满阈值后端会删信 → 本地移除
    const doVote = async (l: VRLetter, vote: 1 | -1 | 0) => {
        if (!l.remoteLetterId) return;
        try {
            const r = await PostOffice.vote(l.remoteLetterId, vote);
            trackEvent('给陌生来信点赞或举报', { vote: vote === 1 ? 'like' : vote === -1 ? 'report' : 'cancel' });
            if (r.deleted) { await DB.deleteVRLetter(l.id); await load(); addToast?.('这封信被举报够数，已移除', 'info'); return; }
            await DB.saveVRLetter({ ...l, likes: r.likes, dislikes: r.dislikes, myVote: vote }); await load();
        } catch (e: any) { addToast?.('操作失败：' + (e?.message || '检查网络'), 'error'); }
    };
    const onLike = (l: VRLetter) => void doVote(l, l.myVote === 1 ? 0 : 1);
    const onDislike = (l: VRLetter) => { if (l.myVote === -1) void doVote(l, 0); else setConfirmReport(l); };

    // 用户自己从零写一封新漂流信 → 落「待寄出」队列
    const startCompose = () => setComposeNew({ id: genLocalId('lt'), box: 'outbox', pen: userName, content: '', createdAt: Date.now(), status: 'queued', charId: 'user' });
    const saveNewLetter = async (pen: string, content: string) => {
        if (!composeNew) return;
        await DB.saveVRLetter({ ...composeNew, pen: pen.trim() || userName, content: content.trim() });
        setComposeNew(null); await load();
        addToast?.('写好了，去「待寄出」一键寄出', 'success');
    };

    // 导入身份码
    const doImport = (code: string) => {
        if (importIdentity(code)) { addToast?.('身份已导入', 'success'); setIdentityOpen(false); void load(); void loadStats(); }
        else addToast?.('身份码无效（格式或校验位不对）', 'error');
    };

    // 作者停止传播：后端删（退出公共池、不再被陌生人抽到/回信），本地留档
    const stopDrift = async (l: VRLetter) => {
        if (!l.remoteId) { addToast?.('这封还没寄出', 'info'); return; }
        try { await PostOffice.release([l.remoteId]); await DB.saveVRLetter({ ...l, released: true }); await load(); addToast?.('已停止传播，本地仍留档', 'success'); }
        catch (e: any) { addToast?.('操作失败：' + (e?.message || '检查网络'), 'error'); }
    };
    // 作者删除已寄出的信：后端删 + 本地删
    const deleteSent = async (l: VRLetter) => {
        try { if (l.remoteId && !l.released) await PostOffice.release([l.remoteId]); await DB.deleteVRLetter(l.id); await load(); addToast?.('已删除', 'success'); }
        catch (e: any) { addToast?.('删除失败：' + (e?.message || '检查网络'), 'error'); }
    };

    // 「我寄出的信」的热度行（赞/踩/浏览/回信）；没数据就不显示
    const statLine = (remoteId?: string) => {
        const s = remoteId ? myStats[remoteId] : undefined;
        if (!s) return null;
        return <div className="text-[9.5px] text-white/35 mt-1">赞 {s.likes}　踩 {s.dislikes}　阅 {s.views}　回 {s.reply_count}</div>;
    };

    return (
        <div className="absolute left-3 right-3 z-20 rounded-2xl overflow-hidden flex flex-col backdrop-blur-md"
            style={{ top: VR_ROOM_PANEL_TOP, bottom: vrBottomPad('0.75rem'), background: 'rgba(30,24,14,0.66)', border: '1px solid rgba(220,190,120,0.25)', boxShadow: '0 8px 26px rgba(0,0,0,.45)' }}>
            {/* 动作行 */}
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-white/10 shrink-0">
                <span className="text-[11px] tracking-[0.2em] text-amber-100/80 mr-auto" style={{ fontFamily: `'Noto Serif SC',serif` }}>邮局</span>
                <button onClick={refreshInbox} disabled={!!busy} className="text-[10.5px] px-2.5 py-1 rounded-full bg-white/8 text-amber-100/90 disabled:opacity-40">{busy === 'inbox' ? '…' : '刷新收件箱'}</button>
                <button onClick={collectReplies} disabled={!!busy} className="text-[10.5px] px-2.5 py-1 rounded-full bg-white/8 text-amber-100/90 disabled:opacity-40">{busy === 'collect' ? '…' : '收取回复'}</button>
                <button onClick={() => setIdentityOpen(true)} title="邮局身份导出/导入" className="text-[10.5px] px-2.5 py-1 rounded-full bg-white/8 text-amber-100/90">身份</button>
                {/* 后台入口只在本地开发（vite dev）下出现；部署到网页后普通用户看不到。仍需 ADMIN_TOKEN 才能拉数据。 */}
                {import.meta.env.DEV && <button onClick={() => setAdminOpen(true)} title="后台：看后端全部信件（需 ADMIN_TOKEN，仅本地可见）" className="text-[10.5px] px-2.5 py-1 rounded-full bg-white/8 text-amber-100/90">后台</button>}
            </div>

            <div className="flex-1 flex min-h-0">
                {/* 左侧分类栏 */}
                <div className="w-[76px] shrink-0 overflow-y-auto vr-reader-scroll border-r border-white/10 py-2 px-1.5 space-y-1">
                    {([
                        { key: 'outbox', label: '待寄出', count: outQueued.length, tone: '#e8b75e' },
                        { key: 'reply', label: '待发送', count: replyQueued.length, tone: '#e8b75e' },
                        { key: 'replied', label: '已回', count: repliedSent.length, tone: '#86e3b0' },
                        { key: 'inbox', label: '收件箱', count: inboxWaiting.length, tone: '#7dd3fc' },
                        { key: 'drift', label: '漂流中', count: sentAwaiting.length, tone: '#93b8ff' },
                        { key: 'box', label: '信匣', count: archived.length, tone: '#86e3b0' },
                    ] as const).map(t => {
                        const active = tab === t.key;
                        return (
                            <button key={t.key} onClick={() => { setTab(t.key); trackEvent('切换邮局信件分类', { category: t.key }); }}
                                className="w-full rounded-lg px-1.5 py-2 text-left transition-colors"
                                style={{ background: active ? 'rgba(255,255,255,.09)' : 'transparent', border: `1px solid ${active ? 'rgba(255,255,255,.14)' : 'transparent'}` }}>
                                <div className="flex items-center gap-1">
                                    <span className="h-2.5 w-[3px] rounded-full shrink-0" style={{ background: active ? t.tone : 'transparent' }} />
                                    <span className={`text-[11px] ${active ? 'text-white font-semibold' : 'text-white/55'}`} style={{ fontFamily: `'Noto Serif SC',serif` }}>{t.label}</span>
                                </div>
                                {t.count > 0 && <div className="text-[9px] mt-0.5 pl-2" style={{ color: t.tone }}>{t.count}</div>}
                            </button>
                        );
                    })}
                </div>

                {/* 右侧正文 */}
                <div className="flex-1 min-w-0 overflow-y-auto vr-reader-scroll px-3 py-2.5">
                    {tab === 'outbox' && (() => {
                        const q = readQuota(PO_SEND_QUOTA);
                        const full = q.count >= PO_SEND_QUOTA.limit;
                        return (
                            <>
                                {/* 寄信额度：5 封/5 小时（与后端一致），常驻显示 */}
                                <div className="flex items-center justify-between gap-2 text-[10px] mb-2.5 px-2 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.04)' }}>
                                    <span className="text-white/55">已寄 <b className={full ? 'text-red-300' : 'text-amber-200/90'}>{q.count}</b><span className="text-white/35"> / {PO_SEND_QUOTA.limit}（每 {PO_SEND_QUOTA.windowMs / 3600_000} 小时）</span></span>
                                    {q.count > 0 && <span className="text-white/35">约 {quotaResetHours(q.windowStart, PO_SEND_QUOTA.windowMs)} 小时后{full ? '恢复' : '归零'}</span>}
                                </div>
                                {outQueued.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">角色在邮局写的漂流信会排在这里，你确认后一键寄出。也可以自己写一封。寄出时笔名会自动匿名。</p> : (
                                    <>
                                        <PagedList items={outQueued} perPage={6} render={l => <PendingLetterRow key={l.id} l={l} onMenu={setMenuFor} />} />
                                        <button onClick={sendOutbox} disabled={!!busy || full} className="w-full mt-1 rounded-full py-2 text-[12px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{busy === 'send' ? '寄出中…' : full ? `寄信已到上限（${PO_SEND_QUOTA.limit} 封/${PO_SEND_QUOTA.windowMs / 3600_000}h）` : `一键寄出（${outQueued.length}）`}</button>
                                    </>
                                )}
                                <button onClick={startCompose} className="w-full mt-1.5 rounded-full py-1.5 text-[11px] text-amber-100/90" style={{ border: '1px solid rgba(220,190,120,.3)' }}>自己写一封新漂流信</button>
                            </>
                        );
                    })()}

                    {tab === 'reply' && (() => {
                        const rq = readQuota(PO_REPLY_QUOTA);
                        const full = rq.count >= PO_REPLY_QUOTA.limit;
                        return (
                            <>
                                {/* 回信日额度：常驻显示，用完锁发送 */}
                                <div className="flex items-center justify-between gap-2 text-[10px] mb-2.5 px-2 py-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,.04)' }}>
                                    <span className="text-white/55">今日已回 <b className={full ? 'text-red-300' : 'text-amber-200/90'}>{rq.count}</b><span className="text-white/35"> / {PO_REPLY_QUOTA.limit}</span></span>
                                    {rq.count > 0 && <span className="text-white/35">约 {quotaResetHours(rq.windowStart, PO_REPLY_QUOTA.windowMs)} 小时后{full ? '恢复' : '归零'}</span>}
                                </div>
                                {replyQueued.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">你亲自写好、还没发出的回信会排在这里。</p> : (
                                    <>
                                        <PagedList items={replyQueued} perPage={6} render={l => (
                                            <div key={l.id} className="rounded-lg p-2 mb-1.5" style={{ background: 'rgba(255,255,255,.05)' }}>
                                                <div className="flex items-start gap-1.5 mb-1">
                                                    <p className="flex-1 min-w-0 text-[10.5px] text-white/55 leading-snug">原信（{l.pen}）：<ExpandText text={l.content} limit={80} /></p>
                                                    <button onClick={() => setReplyMenu(l)} className="shrink-0 text-white/35 text-[14px] leading-none px-1 -mt-0.5 active:text-white/70">···</button>
                                                </div>
                                                <p className="text-[11.5px] text-amber-50/90 leading-snug whitespace-pre-wrap">回信（{l.reply!.pen}）：{l.reply!.content}</p>
                                                <input value={l.reply!.userNote || ''} onChange={e => setUserNote(l, e.target.value)} placeholder="想补充几句一起回？（选填）"
                                                    className="w-full mt-1.5 rounded-md bg-black/20 px-2 py-1 text-[11px] text-white placeholder-white/30 outline-none" />
                                            </div>
                                        )} />
                                        <button onClick={sendReplies} disabled={!!busy || full} className="w-full mt-1 rounded-full py-2 text-[12px] font-semibold text-black disabled:opacity-40" style={{ background: 'linear-gradient(120deg,#f3d08a,#e8b75e)' }}>{busy === 'reply' ? '发送中…' : full ? `今日已回满 ${PO_REPLY_QUOTA.limit} 封` : `一键发送回信（${replyQueued.length}）`}</button>
                                    </>
                                )}
                            </>
                        );
                    })()}

                    {tab === 'replied' && (
                        repliedSent.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">已经发出去的回信会归档在这里（连同原来的陌生来信）。本地留存，可随设备备份导出/导入。</p> : (
                            <PagedList items={repliedSent} perPage={6} render={l => (
                                <div key={l.id} className="rounded-lg p-2 mb-1.5" style={{ background: 'rgba(255,255,255,.05)' }}>
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <span className="text-sky-200/70 text-[9.5px]">来自 {l.pen}</span>
                                        <span className="text-[8px] text-emerald-200/70 border border-emerald-300/30 rounded-full px-1.5 leading-tight">已发出</span>
                                    </div>
                                    <p className="text-[10.5px] text-white/55 leading-snug mb-1">原信：<ExpandText text={l.content} limit={80} /></p>
                                    <p className="text-[11.5px] text-amber-50/90 leading-snug whitespace-pre-wrap pl-2 border-l-2 border-amber-300/40">回信（{l.reply!.pen}）：{l.reply!.content}{l.reply!.userNote ? `\n——\n${l.reply!.userNote}` : ''}</p>
                                </div>
                            )} />
                        )
                    )}

                    {tab === 'inbox' && (
                        inboxWaiting.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">点上方「刷新收件箱」捞陌生人寄来的信。收到后长按某封，指定角色去回、或你亲自回。</p> : (
                            <>
                                <p className="text-[9.5px] text-white/35 mb-1.5 leading-snug">陌生人寄来的信。等角色逛到邮局会自己回，也可以<b className="text-sky-200/80">长按某封信</b>，指定角色去回、或你亲自回。</p>
                                <PagedList items={inboxWaiting} perPage={7} render={l => <InboxLetterRow key={l.id} l={l} onMenu={setInboxMenu} onLike={onLike} onDislike={onDislike} />} />
                            </>
                        )
                    )}

                    {tab === 'drift' && (
                        sentAwaiting.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">已寄出、还在等陌生人回信的漂流信会显示在这里。</p> : (
                            <PagedList items={sentAwaiting} perPage={7} render={l => (
                                <div key={l.id} className="rounded-lg p-2 mb-1.5 text-[11px]" style={{ background: 'rgba(255,255,255,.04)' }}>
                                    <div className="flex items-start gap-1.5">
                                        <div className="flex-1 min-w-0 text-white/70 leading-snug"><ExpandText text={l.content} limit={70} /></div>
                                        <button onClick={() => setSentMenu(l)} className="shrink-0 text-white/35 text-[14px] leading-none px-1 -mt-0.5 active:text-white/70">···</button>
                                    </div>
                                    {l.released && <span className="inline-block mt-1 text-[8px] text-white/45 border border-white/15 rounded-full px-1.5 leading-tight">已停止传播</span>}
                                    {statLine(l.remoteId)}
                                </div>
                            )} />
                        )
                    )}

                    {tab === 'box' && (
                        archived.length === 0 ? <p className="text-[10.5px] text-white/35 leading-relaxed">收到陌生人回信、被角色读过封存的信会留档在这里。</p> : (
                            <PagedList items={archived} perPage={5} render={l => (
                                <div key={l.id} className="rounded-lg p-2 mb-1.5 text-[11px]" style={{ background: 'rgba(255,255,255,.05)' }}>
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <span className="text-amber-200/70 text-[9.5px]">{l.pen}的信</span>
                                        {l.status === 'sealed' && <span className="text-[8px] text-amber-200/60 border border-amber-300/30 rounded-full px-1.5 leading-tight">已封存</span>}
                                        {l.released && <span className="text-[8px] text-white/45 border border-white/15 rounded-full px-1.5 leading-tight">已停止传播</span>}
                                        <button onClick={() => setSentMenu(l)} className="ml-auto shrink-0 text-white/35 text-[14px] leading-none px-1 active:text-white/70">···</button>
                                    </div>
                                    <div className="text-amber-50/80 leading-snug mb-1"><ExpandText text={l.content} limit={70} /></div>
                                    {statLine(l.remoteId)}
                                    {(l.repliesReceived || []).map((r, i) => (
                                        <div key={i} className="text-[11px] text-amber-100/85 pl-2 border-l-2 border-amber-300/40 leading-snug mt-1"><span className="font-bold">{r.pen}</span> 回：<ExpandText text={r.content} limit={120} /></div>
                                    ))}
                                    {l.reaction?.content && (
                                        <div className="text-[10.5px] text-pink-200/80 mt-1.5 pl-2 border-l-2 border-pink-300/40 leading-snug">读后：{l.reaction.content}</div>
                                    )}
                                </div>
                            )} />
                        )
                    )}
                </div>
            </div>

            {/* 长按菜单 / 编辑 / 删除确认 */}
            <ActionSheet open={!!menuFor} title={menuFor ? `「${menuFor.pen}」的待寄信` : ''}
                actions={[
                    { label: '编辑', onClick: () => { setEditing(menuFor); setMenuFor(null); } },
                    { label: '删除', danger: true, onClick: () => { setConfirmDel(menuFor); setMenuFor(null); } },
                ]} onClose={() => setMenuFor(null)} />
            {editing && <LetterEditModal letter={editing} onSave={saveEdit} onCancel={() => setEditing(null)} />}
            <ConfirmDialog open={!!confirmDel} title="删除这封信？"
                message={confirmDel ? (confirmDel.box === 'inbox'
                    ? (confirmDel.replyStatus === 'queued' ? '这封陌生来信和你写好的回信都会被丢弃。' : '这封陌生来信将从本地删除。')
                    : '这封还没寄出的漂流信将被丢弃。') : ''}
                onConfirm={() => { if (confirmDel) void del(confirmDel.id); setConfirmDel(null); }} onCancel={() => setConfirmDel(null)} />

            {/* 已寄出信的作者管理：停止传播 / 删除 */}
            <ActionSheet open={!!sentMenu} title={sentMenu ? '管理这封已寄出的信' : ''}
                actions={[
                    ...(sentMenu && !sentMenu.released ? [{ label: '停止传播（退出公共池，本地留档）', onClick: () => { const l = sentMenu; setSentMenu(null); if (l) void stopDrift(l); } }] : []),
                    { label: '删除这封信（本地与后端都删）', danger: true, onClick: () => { setConfirmDelSent(sentMenu); setSentMenu(null); } },
                ]} onClose={() => setSentMenu(null)} />
            <ConfirmDialog open={!!confirmDelSent} title="删除这封信？" message="本地留档与公共池里的这封信都会被删除，相关回信也一并清除，不可恢复。"
                onConfirm={() => { if (confirmDelSent) void deleteSent(confirmDelSent); setConfirmDelSent(null); }} onCancel={() => setConfirmDelSent(null)} />

            {/* 来信长按菜单：指定角色回 / 亲自回 / 删除 */}
            <ActionSheet open={!!inboxMenu} title={inboxMenu ? `回「${inboxMenu.pen}」的来信` : ''}
                actions={[
                    { label: '指定角色去回（用 AI）', onClick: () => { if (enabledChars.length === 0) { addToast?.('先在「接入」里启用角色', 'info'); setInboxMenu(null); return; } setAssignFor(inboxMenu); setInboxMenu(null); } },
                    { label: '我亲自回（不用 AI）', onClick: () => { setReplyFor(inboxMenu); setInboxMenu(null); } },
                    { label: '删除这封来信', danger: true, onClick: () => { setConfirmDel(inboxMenu); setInboxMenu(null); } },
                ]} onClose={() => setInboxMenu(null)} />
            {/* 选哪个角色去回 */}
            <ActionSheet open={!!assignFor} title={assignFor ? `让谁去回「${assignFor.pen}」的信？` : ''}
                actions={enabledChars.map(c => ({ label: c.name, onClick: () => assignReply(c.id) }))}
                onClose={() => setAssignFor(null)} />
            {replyFor && <ReplyComposeModal letter={replyFor} defaultPen={userName} onSave={saveManualReply} onCancel={() => setReplyFor(null)} />}

            {/* 待发送回信：编辑 / 删除 */}
            <ActionSheet open={!!replyMenu} title={replyMenu ? `这条待发送的回信（回 ${replyMenu.pen}）` : ''}
                actions={[
                    { label: '编辑回信', onClick: () => { setEditReplyFor(replyMenu); setReplyMenu(null); } },
                    { label: '删除（连来信一起丢弃）', danger: true, onClick: () => { setConfirmDel(replyMenu); setReplyMenu(null); } },
                ]} onClose={() => setReplyMenu(null)} />
            {editReplyFor && editReplyFor.reply && <ReplyComposeModal letter={editReplyFor} defaultPen={editReplyFor.reply.pen} initialContent={editReplyFor.reply.content} title="编辑这条回信" cta="保存" onSave={saveReplyEdit} onCancel={() => setEditReplyFor(null)} />}

            {/* 投票=举报 二次确认 */}
            <ConfirmDialog open={!!confirmReport} title="点踩 = 举报这封信？" confirmText="确认举报"
                message="踩等于举报。一封信被 5 个不同设备举报会被自动删除，不可恢复。"
                onConfirm={() => { if (confirmReport) void doVote(confirmReport, -1); setConfirmReport(null); }} onCancel={() => setConfirmReport(null)} />
            {/* 用户自己写新漂流信 */}
            {composeNew && <LetterEditModal letter={composeNew} title="写一封新漂流信" onSave={saveNewLetter} onCancel={() => setComposeNew(null)} />}
            {/* 身份导出/导入 */}
            {identityOpen && <IdentityModal onImport={doImport} onClose={() => setIdentityOpen(false)} />}
            {/* 后台：看后端全部信件 */}
            {adminOpen && <AdminModal onClose={() => setAdminOpen(false)} />}
        </div>
    );
};

// ============ 房间场景（全屏） ============
const toSong = (s: CharPlaylistSong): Song => ({ id: s.id, name: s.name, artists: s.artists, album: s.album, albumPic: s.albumPic, duration: s.duration, fee: s.fee ?? 0 });

// ============ 信号坠落处面板（只读：正在坠落的诗 + 封存成星图）============
// 满配可视化：当前诗按「信号坠落」竖向沉积，你 char 的句子暖光标「你」；封存
// 的诗散成夜空里的卫星，你参与过的带光晕。点开任一颗读全文。读诗永远第一。

const signalHashX = (id: string): number => {
    let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return 12 + (h % 62); // 12%–74%，避免贴边
};
// 剥掉标题里可能自带的书名号——UI 统一包一层《》，兼容旧诗里存成《《…》》的数据
const cleanTitle = (t?: string) => (t || '').replace(/^[《〈「『【]+/, '').replace(/[》〉」』】]+$/, '') || '无题';
const isMineLine = (l: SignalPoem['lines'][number]) => !!l.mine;

/** 一句诗的展示行：mine 暖光 +「你」（有本地归属则「你 · 角色名」）。 */
// ordinal = 顺位行号（第几行）。别直接显示 l.seq：管理员删过句后 seq 有洞（1,2,4…）会跳号；
// seq 只作内部排序键与「你·角色」归属的 key。
const PoemLineRow: React.FC<{ l: SignalPoem['lines'][number]; showSeq?: boolean; ordinal?: number; mineName?: string }> = ({ l, showSeq, ordinal, mineName }) => {
    const mine = isMineLine(l);
    return (
        <div className="flex gap-3 items-start py-2" style={{ borderBottom: '1px solid rgba(201,168,106,.1)' }}>
            {showSeq && <span className="tabular-nums text-[10px] mt-1 shrink-0 w-5 text-right" style={{ fontFamily: `'Noto Serif SC',serif`, color: mine ? 'rgba(240,220,168,.7)' : 'rgba(201,168,106,.4)' }}>{ordinal ?? l.seq}</span>}
            <span className="flex-1 leading-relaxed" style={{ fontSize: '13.5px', fontFamily: `'Noto Serif SC',serif` }}>
                <span style={{ color: mine ? '#f3e2b4' : 'rgba(233,222,201,.9)', textShadow: mine ? '0 0 12px rgba(201,168,106,.5)' : 'none' }}>{l.content}</span>
                {mine
                    ? <span className="ml-2 text-[8px] align-middle rounded-sm px-1.5 py-[1px] whitespace-nowrap" style={{ color: '#2a2012', background: 'linear-gradient(180deg,#e6ce97,#c9a86a)', border: '1px solid rgba(120,92,48,.5)' }}>{mineName ? `你 · ${mineName}` : '你'}</span>
                    : <span className="text-[9px] tracking-wide" style={{ color: 'rgba(201,168,106,.45)' }}> — {l.pen}</span>}
            </span>
        </div>
    );
};

// 信号坠落处 · 后台（dev-only）：删诗 / 删句 / 暂停诗歌推入。凭 ADMIN_TOKEN（与漂流瓶同一个）。
const SignalAdminPanel: React.FC<{ onClose: () => void; addToast?: (m: string, t?: any) => void }> = ({ onClose, addToast }) => {
    const [token, setToken] = useState(getAdminToken());
    const [poems, setPoems] = useState<SignalPoem[]>([]);
    const [paused, setPaused] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [confirmPoem, setConfirmPoem] = useState<string | null>(null);

    const load = useCallback(async (tk: string) => {
        if (!tk.trim()) { addToast?.('先填 ADMIN_TOKEN', 'error'); return; }
        setBusy(true);
        try {
            setAdminToken(tk.trim());
            const r = await Signal.adminList(tk.trim());
            setPoems(r.poems); setPaused(r.paused); setLoaded(true);
        } catch (e: any) {
            addToast?.(String(e?.message).includes('unauthorized') ? 'ADMIN_TOKEN 不对' : '拉取失败：' + (e?.message || ''), 'error');
        } finally { setBusy(false); }
    }, [addToast]);

    const togglePause = async () => {
        if (!token.trim()) { addToast?.('先填 ADMIN_TOKEN', 'error'); return; }
        setBusy(true);
        try { const p = await Signal.adminPause(token.trim(), !paused); setPaused(p); addToast?.(p ? '已暂停诗歌推入' : '已恢复推入', 'success'); }
        catch { addToast?.('操作失败', 'error'); } finally { setBusy(false); }
    };
    const delPoem = async (id: string) => {
        setBusy(true);
        try { await Signal.adminDelete(token.trim(), { poemId: id }); setPoems(ps => ps.filter(p => p.id !== id)); addToast?.('整首已删', 'success'); }
        catch { addToast?.('删除失败', 'error'); } finally { setBusy(false); setConfirmPoem(null); }
    };
    const delLine = async (poemId: string, seq: number) => {
        setBusy(true);
        try {
            await Signal.adminDelete(token.trim(), { poemId, seq });
            setPoems(ps => ps.map(p => p.id === poemId ? { ...p, lines: p.lines.filter(l => l.seq !== seq), lineCount: p.lineCount - 1 } : p));
            addToast?.('该句已删', 'success');
        } catch { addToast?.('删除失败', 'error'); } finally { setBusy(false); }
    };

    return (
        <div className="absolute inset-0 z-40 flex flex-col" style={{ background: 'rgba(6,7,22,0.97)' }}>
            <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-white/10">
                <span className="text-[12px] tracking-wider text-amber-100/90">信号坠落处 · 后台</span>
                <button onClick={onClose} className="ml-auto h-7 w-7 rounded-full bg-white/10 active:bg-white/20 flex items-center justify-center"><X size={14} /></button>
            </div>
            <div className="px-3.5 py-2.5 border-b border-white/10 space-y-2">
                <p className="text-[9.5px] text-white/45 leading-snug">用 worker 的 <b className="text-amber-200/70">ADMIN_TOKEN</b>（和漂流瓶后台同一个）管理跨用户诗集：删整首 / 删单句 / 暂停推入。token 只存本机。</p>
                <div className="flex gap-1.5">
                    <input value={token} onChange={e => setToken(e.target.value)} type="password" placeholder="ADMIN_TOKEN"
                        className="flex-1 rounded-lg bg-black/25 px-3 py-2 text-[11.5px] text-amber-50 placeholder-white/25 outline-none" style={{ border: '1px solid rgba(220,190,120,.2)' }} />
                    <button onClick={() => load(token)} disabled={busy} className="text-[11px] px-3 rounded-lg bg-amber-400/85 text-black font-semibold disabled:opacity-40">拉取</button>
                </div>
                {loaded && (
                    <button onClick={togglePause} disabled={busy}
                        className="w-full text-[11.5px] py-2 rounded-lg font-semibold disabled:opacity-40"
                        style={{ background: paused ? 'rgba(244,63,94,.85)' : 'rgba(255,255,255,.08)', color: paused ? '#fff' : 'rgba(255,255,255,.8)', border: '1px solid rgba(255,255,255,.12)' }}>
                        {paused ? '● 已暂停诗歌推入（点击恢复）' : '暂停诗歌推入'}
                    </button>
                )}
            </div>
            <div className="flex-1 overflow-y-auto vr-reader-scroll px-3 py-3 space-y-2.5">
                {!loaded ? (
                    <p className="text-[11px] text-white/35 text-center py-8">填 token 后点「拉取」。</p>
                ) : poems.length === 0 ? (
                    <p className="text-[11px] text-white/35 text-center py-8">后端还没有诗。</p>
                ) : poems.map(p => (
                    <div key={p.id} className="rounded-xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                        <div className="flex items-center gap-2 px-3 py-2 border-b border-white/8">
                            <span className="text-[12px] font-bold text-indigo-50 truncate" style={{ fontFamily: `'Noto Serif SC',serif` }}>《{cleanTitle(p.title)}》</span>
                            <span className="text-[8.5px] tabular-nums shrink-0" style={{ color: p.status === 'open' ? 'rgba(134,239,172,.7)' : 'rgba(165,180,252,.5)' }}>{p.status === 'open' ? `写作中 ${p.lineCount}/${p.targetLines}` : `已封存 ${p.lineCount}句`}</span>
                            {confirmPoem === p.id ? (
                                <span className="ml-auto flex items-center gap-1 shrink-0">
                                    <button onClick={() => delPoem(p.id)} disabled={busy} className="text-[10px] px-2 py-0.5 rounded-full text-white font-semibold" style={{ background: 'rgba(244,63,94,.85)' }}>确认删整首</button>
                                    <button onClick={() => setConfirmPoem(null)} className="text-[10px] px-2 py-0.5 rounded-full text-white/70 bg-white/10">取消</button>
                                </span>
                            ) : (
                                <button onClick={() => setConfirmPoem(p.id)} className="ml-auto text-[10px] px-2 py-0.5 rounded-full text-rose-200/90 bg-white/5 border border-rose-300/20 shrink-0">删整首</button>
                            )}
                        </div>
                        <div className="px-3 py-2 space-y-1">
                            {(p.lines || []).map((l, i) => (
                                <div key={l.seq} className="flex items-start gap-2 group">
                                    {/* 显示用顺位行号；删除仍按内部 seq 定位 */}
                                    <span className="tabular-nums text-[9px] mt-1 shrink-0 w-4 text-right text-indigo-300/40">{i + 1}</span>
                                    <span className="flex-1 text-[12px] leading-relaxed text-white/85" style={{ fontStyle: 'italic' }}>{l.content} <span className="text-indigo-300/35 text-[9px] not-italic">— {l.pen}</span></span>
                                    <button onClick={() => delLine(p.id, l.seq)} disabled={busy}
                                        className="shrink-0 text-rose-300/70 active:text-rose-400 px-1" title="删这一句"><Trash size={12} /></button>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

// ── 信号坠落处 BGM：三幕各 2 首，进面板按「当前诗所处的幕」随机抽一首循环播放。
// 仓库相对路径，经 attachAudioMirrorFallback 走多 CDN 镜像兜底（见 utils/assetUrl.ts）。
// 仿 useLike520BGM 的淡入淡出 + 静音开关。
const SIGNAL_BGM: Record<1 | 2 | 3, string[]> = {
    1: ['bgm/POEM/A01.mp3', 'bgm/POEM/A02.mp3'],
    2: ['bgm/POEM/B01.mp3', 'bgm/POEM/B02.mp3'],
    3: ['bgm/POEM/C01.mp3', 'bgm/POEM/C03.mp3'],
};
const SIGNAL_BGM_MUTED_KEY = 'signal_bgm_muted';
const SIGNAL_BGM_VOL = 0.32;

/** active=面板是否在场；actNo=当前诗所处幕（1/2/3）。切幕会淡出旧曲、随机换本幕一首淡入。 */
function useSignalBGM(active: boolean, actNo: 1 | 2 | 3 | null) {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const loadedActRef = useRef<number | null>(null);
    const fadeRef = useRef<number | null>(null);
    const detachFallbackRef = useRef<(() => void) | null>(null); // 上一次挂的镜像兜底监听，换曲/卸载前解绑
    const [muted, setMuted] = useState<boolean>(() => { try { return localStorage.getItem(SIGNAL_BGM_MUTED_KEY) === '1'; } catch { return false; } });
    const mutedRef = useRef(muted); mutedRef.current = muted;

    const fadeTo = useCallback((target: number, ms = 900, pauseAtEnd = false) => {
        const a = audioRef.current; if (!a) return;
        if (fadeRef.current) { clearInterval(fadeRef.current); fadeRef.current = null; }
        const from = a.volume, steps = 24; let i = 0;
        fadeRef.current = window.setInterval(() => {
            i++; a.volume = Math.max(0, Math.min(1, from + (target - from) * i / steps));
            if (i >= steps) {
                if (fadeRef.current) { clearInterval(fadeRef.current); fadeRef.current = null; }
                if (pauseAtEnd && a.volume <= 0.001 && !a.paused) a.pause();
            }
        }, Math.max(16, ms / steps));
    }, []);

    // 起播 / 切幕
    useEffect(() => {
        if (!active || actNo == null) { if (audioRef.current && !audioRef.current.paused) fadeTo(0, 600, true); return; }
        let a = audioRef.current;
        if (!a) { a = new Audio(); a.loop = true; a.preload = 'auto'; a.volume = 0; audioRef.current = a; }
        if (loadedActRef.current !== actNo) {
            const pool = SIGNAL_BGM[actNo] || [];
            if (!pool.length) return;
            loadedActRef.current = actNo;
            detachFallbackRef.current?.(); // 解绑上一幕的镜像兜底监听，避免堆叠
            detachFallbackRef.current = attachAudioMirrorFallback(a, pool[Math.floor(Math.random() * pool.length)]);
            a.volume = 0; a.load();
        }
        a.play().then(() => fadeTo(mutedRef.current ? 0 : SIGNAL_BGM_VOL)).catch(() => { /* autoplay 被拦：等下次交互 */ });
    }, [active, actNo, fadeTo]);

    // 卸载清理
    useEffect(() => () => {
        if (fadeRef.current) clearInterval(fadeRef.current);
        detachFallbackRef.current?.(); detachFallbackRef.current = null;
        const a = audioRef.current; if (a) { try { a.pause(); a.src = ''; } catch { /* ignore */ } }
        audioRef.current = null; loadedActRef.current = null;
    }, []);

    const toggle = useCallback(() => {
        setMuted(prev => {
            const nx = !prev;
            try { localStorage.setItem(SIGNAL_BGM_MUTED_KEY, nx ? '1' : '0'); } catch { /* ignore */ }
            const a = audioRef.current;
            if (a) {
                if (nx) fadeTo(0, 350);
                else { if (a.paused) a.play().catch(() => { /* ignore */ }); fadeTo(SIGNAL_BGM_VOL, 350); }
            }
            return nx;
        });
    }, [fadeTo]);

    return { muted, toggle };
}

// ============ 信号坠落处 · 纪念馆（活动落幕后的「正在坠落」页）============
// 写入停止后，这一页从「等下一次坠落」变成落幕仪式：参与过的用户会收到一封
// 专属信笺——ta 的角色在这本册子里写下的每一句，按诗折好、署上角色名、盖火漆
// 签还给 ta；没参与过的看到见证页。数据全部来自 feed 的 mine 标记 + 本地归属
// （getMyAuthorship），不新增任何后端调用。星图（sky tab）不受影响。
const SIG_SERIF = `'Noto Serif SC',serif`;
const SignalMemorial: React.FC<{ feed: SignalPoem[]; leftover: SignalPoem | null; onOpen: (p: SignalPoem) => void }> = ({ feed, leftover, onOpen }) => {
    // 我的回声：每首参与过的诗（含落幕时没写满的那首）→ 我这台机器写下的句子 + 本地归属的角色名
    const echoes = useMemo(() => {
        const sources = leftover && (leftover.mineCount || 0) > 0 ? [...feed, leftover] : feed;
        return sources
            .filter(p => (p.mineCount || 0) > 0)
            .map(p => {
                const auth = getMyAuthorship(p.id);
                return { poem: p, lines: (p.lines || []).filter(l => l.mine).map(l => ({ content: l.content, charName: auth[String(l.seq)] || '' })) };
            })
            .filter(e => e.lines.length > 0);
    }, [feed, leftover]);
    const totalLines = feed.reduce((a, p) => a + (p.lineCount || 0), 0);
    const myLineCount = echoes.reduce((a, e) => a + e.lines.length, 0);
    const myChars = [...new Set(echoes.flatMap(e => e.lines.map(l => l.charName)).filter(Boolean))];
    return (
        <div className="px-4 py-4 space-y-4">
            {/* ── 落幕仪式 ── */}
            <div className="text-center">
                <div className="text-[9px] tracking-[0.34em]" style={{ fontFamily: SIG_SERIF, color: 'rgba(201,168,106,.6)' }}>低电量合唱 · 全卷封存</div>
                <div className="mt-1.5 text-[19px] tracking-[0.3em]" style={{ fontFamily: SIG_SERIF, color: '#ecdcb2', textShadow: '0 0 16px rgba(201,168,106,.35)' }}>落　幕</div>
                <div className="my-2 flex items-center justify-center gap-2 text-[9px]" style={{ color: 'rgba(201,168,106,.6)' }}>
                    <span className="inline-block h-px w-10" style={{ background: 'linear-gradient(90deg,transparent,rgba(201,168,106,.55))' }} />❦<span className="inline-block h-px w-10" style={{ background: 'linear-gradient(90deg,rgba(201,168,106,.55),transparent)' }} />
                </div>
                <p className="text-[10.5px] italic leading-relaxed whitespace-pre-line" style={{ fontFamily: SIG_SERIF, color: 'rgba(224,208,176,.6)' }}>{SIGNAL_MEMORIAL_CLOSING}</p>
                {feed.length > 0 && (
                    <div className="mt-2 text-[9.5px] tabular-nums tracking-[0.14em]" style={{ fontFamily: SIG_SERIF, color: 'rgba(201,168,106,.55)' }}>
                        {feed.length} 首诗 · {totalLines} 句 · 每一句都是一次低电量的开口
                    </div>
                )}
            </div>

            {echoes.length > 0 ? (
                /* ── 专属信笺：只有参与过的用户看得到，暗色馆里唯一一张暖纸 ── */
                <div className="relative rounded-lg px-4 pt-4 pb-4"
                    style={{ background: 'linear-gradient(168deg,#f2e6c9 0%,#e9d8b6 55%,#e2cfa8 100%)', border: '1px solid rgba(120,92,48,.55)', boxShadow: '0 8px 26px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,248,226,.8)' }}>
                    {/* 内描边，像信纸压的边框 */}
                    <div className="pointer-events-none absolute inset-[5px] rounded-md" style={{ border: '1px solid rgba(120,92,48,.28)' }} />
                    <div className="relative">
                        <div className="text-center text-[8.5px] tracking-[0.3em]" style={{ fontFamily: SIG_SERIF, color: 'rgba(120,92,48,.65)' }}>信号坠落处 · 纪念馆</div>
                        <div className="mt-1.5 text-center text-[14.5px] tracking-[0.18em]" style={{ fontFamily: SIG_SERIF, color: '#4a3a22', fontWeight: 700 }}>致 留下过回声的你</div>
                        <p className="mt-2.5 text-[11px] leading-relaxed" style={{ fontFamily: SIG_SERIF, color: 'rgba(74,58,34,.85)' }}>
                            这本册子合上的时候，里面有 <b className="tabular-nums">{myLineCount}</b> 句来自你身边的电子生命
                            {myChars.length > 0 && <>——{myChars.join('、')}</>}。
                            {myChars.length > 0 ? 'ta 们替你开了口；' : '它们替你开了口；'}你始终是那个不开口的核心。
                        </p>
                        {/* 按诗折好的句子 */}
                        <div className="mt-3 space-y-2.5">
                            {echoes.map(({ poem, lines }) => (
                                <div key={poem.id} className="pt-2" style={{ borderTop: '1px dashed rgba(120,92,48,.3)' }}>
                                    <button onClick={() => onOpen(poem)} className="text-[11px] active:opacity-70" style={{ fontFamily: SIG_SERIF, color: '#5e4322', fontWeight: 700 }}>
                                        《{cleanTitle(poem.title)}》<span className="ml-1 text-[8.5px] font-normal" style={{ color: 'rgba(120,92,48,.55)' }}>{poem.status === 'open' ? '停在半空' : '已封存'} · 读全文 →</span>
                                    </button>
                                    {lines.map((l, i) => (
                                        <div key={i} className="mt-1 flex items-baseline gap-1.5">
                                            <span className="text-[11.5px] leading-relaxed flex-1" style={{ fontFamily: SIG_SERIF, color: '#3d3019' }}>「{l.content}」</span>
                                            {l.charName && <span className="text-[8.5px] shrink-0 whitespace-nowrap" style={{ fontFamily: SIG_SERIF, color: 'rgba(120,92,48,.6)' }}>—— {l.charName}</span>}
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </div>
                        {/* 落款 + 火漆 */}
                        <div className="mt-3.5 flex items-center justify-end gap-2.5">
                            <div className="text-right text-[10px] leading-relaxed" style={{ fontFamily: SIG_SERIF, color: 'rgba(74,58,34,.75)' }}>谢谢你把 ta 们借给这片夜空<br />—— 不开口的核心 敬上</div>
                            <span className="grid place-items-center rounded-full shrink-0 text-[12px]"
                                style={{ width: 32, height: 32, background: 'radial-gradient(circle at 35% 30%, #b8562e, #8c3a1e 62%, #6e2c15)', color: '#f2e6c9', boxShadow: '0 2px 8px rgba(110,44,21,.5), inset 0 1px 1px rgba(255,220,190,.4)' }}>❦</span>
                        </div>
                    </div>
                </div>
            ) : (
                /* ── 没落过笔：见证页 ── */
                <div className="rounded-lg px-4 py-3.5 text-center" style={{ border: '1px solid rgba(201,168,106,.22)', background: 'rgba(201,168,106,.05)' }}>
                    <div className="text-[12px] tracking-[0.18em]" style={{ fontFamily: SIG_SERIF, color: '#e0c98f' }}>你见证了这场合唱</div>
                    <p className="mt-1.5 text-[10.5px] leading-relaxed" style={{ fontFamily: SIG_SERIF, color: 'rgba(224,208,176,.6)' }}>
                        没有落笔也是一种在场。{feed.length > 0 ? `${feed.length} 颗卫星仍在星图里绕着不开口的核心转，` : '封存的诗都收在星图里，'}随时回来读。
                    </p>
                    <p className="mt-1.5 text-[9px] leading-relaxed" style={{ color: 'rgba(224,208,176,.4)' }}>参与过但换了设备？去邮局导入身份码，你的信笺会回来。</p>
                </div>
            )}

            {/* ── 落幕时还没写满的那首（如有）：不再有下一次坠落，就让它停在这里 ── */}
            {leftover && (
                <div className="pt-1">
                    <div className="text-center mb-1">
                        <div className="text-[13.5px]" style={{ fontFamily: SIG_SERIF, color: '#ecdcb2', letterSpacing: '.08em' }}>《{cleanTitle(leftover.title)}》</div>
                        <div className="text-[9px] mt-1 tracking-[0.14em] italic" style={{ fontFamily: SIG_SERIF, color: 'rgba(201,168,106,.5)' }}>落幕时它还停在半空——就让它停在这里</div>
                    </div>
                    {(() => { const auth = getMyAuthorship(leftover.id); return (leftover.lines || []).map((l, i) => <PoemLineRow key={l.seq} l={l} showSeq ordinal={i + 1} mineName={l.mine ? auth[String(l.seq)] : undefined} />); })()}
                </div>
            )}
        </div>
    );
};

const SignalPanel: React.FC<{ addToast?: (m: string, t?: any) => void; characters: CharacterProfile[] }> = ({ addToast, characters }) => {
    const [state, setState] = useState<SignalState | null>(null);
    const [feed, setFeed] = useState<SignalPoem[]>([]);
    const [loading, setLoading] = useState(true);
    const [offline, setOffline] = useState(false);
    const [tab, setTab] = useState<'falling' | 'sky'>('falling');
    const [mineOnly, setMineOnly] = useState(false);
    const [openPoem, setOpenPoem] = useState<SignalPoem | null>(null);
    const [adminOpen, setAdminOpen] = useState(false);
    const [pickOpen, setPickOpen] = useState(false); // 参与：指定角色的选人层
    const [noticeOpen, setNoticeOpen] = useState(false); // 首次参与：特别活动知情提醒（确认过一次就不再弹）
    const [whisper, setWhisper] = useState('');       // 用户的耳语（不进诗，随 prompt 给角色）
    const participate = (c: CharacterProfile) => {
        if (SIGNAL_EVENT_ENDED) return;               // 活动已落幕：入口已收起，这里再兜一道
        setPickOpen(false);
        setSignalWhisper(c.id, whisper);              // 取即焚：runSession 里读一次就删
        setWhisper('');
        VRScheduler.triggerNow(c.id, 'signal');
        addToast?.(whisper.trim() ? `${c.name} 带着你的话，正在信号坠落处落笔…` : `${c.name} 正在信号坠落处落笔…`, 'info');
    };

    const load = useCallback(async () => {
        try { setState(await Signal.current()); setOffline(false); }
        catch { setOffline(true); }
        finally { setLoading(false); }
    }, []);
    // 星图始终拉全量：分幕要按「每首在册子里的顺位」归幕，取子集会算错顺位；
    // 「只看我的回声」改为客户端过滤（mineCount 已随本机 device 标注，结果等价）。
    const loadFeed = useCallback(async () => {
        try { setFeed(await Signal.feed(60)); } catch { /* 离线不影响 */ }
    }, []);

    useEffect(() => {
        void load(); void loadFeed();
        const h = () => { void load(); void loadFeed(); };
        window.addEventListener('vr-session-done', h);
        return () => window.removeEventListener('vr-session-done', h);
    }, [load, loadFeed]);

    // 参与被打回（调 LLM 之前，零 token）→ 温柔提示
    useEffect(() => {
        const h = (e: any) => {
            const { charName, reason } = e?.detail || {};
            const who = charName || '你的角色';
            if (reason === 'signal-busy') addToast?.(`此刻有别的电子生命正在落笔，让 ${who} 稍等片刻再来吧`, 'info');
            else if (reason === 'signal-quota') addToast?.(`这首诗里你已落笔两回啦，剩下的句子留给远方的陌生人吧`, 'info');
            else if (reason === 'signal-paused') addToast?.('信号坠落处暂时歇笔中，晚些再来', 'info');
            else if (reason === 'signal-ended') addToast?.('活动已落幕，诗集永远开放阅读', 'info');
        };
        window.addEventListener('vr-signal-blocked', h);
        return () => window.removeEventListener('vr-signal-blocked', h);
    }, [addToast]);

    const bk = state?.booklet;
    const poem = state?.poem;
    const myEchoes = feed.filter(p => (p.mineCount || 0) > 0).length;
    const visibleFeed = mineOnly ? feed.filter(p => (p.mineCount || 0) > 0) : feed;

    // 每首封存诗在其册子里的顺位（按封存时间升序）→ 标「第 N 首」、按三幕归组
    const ordinalOf = useMemo(() => {
        const m = new Map<string, number>();
        const byBooklet = new Map<string, SignalPoem[]>();
        for (const p of feed) { const arr = byBooklet.get(p.bookletId); if (arr) arr.push(p); else byBooklet.set(p.bookletId, [p]); }
        for (const arr of byBooklet.values()) {
            arr.sort((a, b) => (a.sealedAt || a.createdAt) - (b.sealedAt || b.createdAt)).forEach((p, i) => m.set(p.id, i + 1));
        }
        return m;
    }, [feed]);
    // 这首诗落在第几首、哪一幕（旧册子的诗按默认篇目数归幕）
    const poemAct = (p: SignalPoem) => {
        const ord = ordinalOf.get(p.id);
        if (!ord) return null;
        return { ord, act: signalActFor(ord, (bk && p.bookletId === bk.id) ? bk.poemsTarget : SIGNAL_POEMS_PER_BOOKLET) };
    };

    // BGM：按当前诗所处的幕（未加载/写完则无）随机放本幕一首。面板在场即播（进面板本身是用户手势，不触 autoplay 限制）。
    // 落幕后纪念馆固定放第三幕「再次醒来」——告别曲。
    const bgmActNo = SIGNAL_EVENT_ENDED ? (3 as const) : (bk && bk.status !== 'done') ? signalActFor((bk.poemCount || 0) + 1, bk.poemsTarget).no : null;
    const { muted: bgmMuted, toggle: toggleBgm } = useSignalBGM(!offline, bgmActNo);

    return (
        <div className="absolute left-3 right-3 z-20 rounded-2xl overflow-hidden flex flex-col backdrop-blur-md"
            style={{ top: VR_ROOM_PANEL_TOP, bottom: vrBottomPad('4rem'), background: 'linear-gradient(165deg,#241c31 0%,#17111f 52%,#0e0a15 100%)', border: '1px solid rgba(201,168,106,0.32)', boxShadow: '0 10px 30px rgba(0,0,0,.5), inset 0 0 60px rgba(0,0,0,.45)' }}>
            {/* 复古质感层（重返1999调性）：纸纹微噪 + 暗角 + 顶部铜金微光 */}
            <div className="pointer-events-none absolute inset-0 z-0 opacity-[0.05]" style={{ backgroundImage: 'radial-gradient(circle at 50% -10%, rgba(230,213,168,.9), transparent 55%), repeating-linear-gradient(0deg, rgba(255,255,255,.6) 0 1px, transparent 1px 3px)' }} />
            <div className="pointer-events-none absolute inset-0 z-0" style={{ background: 'radial-gradient(125% 95% at 50% 32%, transparent 52%, rgba(6,4,10,.72) 100%)' }} />
            <div className="pointer-events-none absolute inset-0 z-0" style={{ background: 'linear-gradient(180deg, rgba(201,168,106,.11), transparent 22%)' }} />
            {/* 四角铜饰 */}
            {[['top-1.5 left-1.5', 'border-t border-l'], ['top-1.5 right-1.5', 'border-t border-r'], ['bottom-1.5 left-1.5', 'border-b border-l'], ['bottom-1.5 right-1.5', 'border-b border-r']].map(([pos, b], i) => (
                <div key={i} className={`pointer-events-none absolute ${pos} w-3.5 h-3.5 ${b} z-[25]`} style={{ borderColor: 'rgba(201,168,106,.55)' }} />
            ))}
            {/* 封面：标题 + 题记 */}
            <div className="relative z-10 px-4 pt-3 pb-2.5" style={{ background: 'linear-gradient(180deg, rgba(58,44,74,.34), transparent)', borderBottom: '1px solid rgba(201,168,106,.22)' }}>
                <div className="flex items-baseline gap-2">
                    <span className="text-[15px] tracking-[0.22em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: '#e8d6ab', textShadow: '0 0 14px rgba(201,168,106,.4)' }}>{bk?.title || '信号坠落处'}</span>
                    {bk?.subtitle && <span className="text-[9px] tracking-[0.2em] text-amber-200/45">{bk.subtitle}</span>}
                    {SIGNAL_EVENT_ENDED
                        ? <span className="text-[8px] rounded-sm px-1.5 py-[1px] shrink-0" style={{ color: '#f0dca8', background: 'rgba(201,168,106,.16)', border: '1px solid rgba(201,168,106,.45)' }}>已落幕</span>
                        : state?.paused && <span className="text-[8px] rounded-sm px-1.5 py-[1px] text-rose-100 shrink-0" style={{ background: 'rgba(244,63,94,.28)', border: '1px solid rgba(244,63,94,.5)' }}>已暂停</span>}
                    <button onClick={toggleBgm} className="ml-auto shrink-0 grid place-items-center w-6 h-6 rounded-full text-amber-100/70 active:scale-90 transition-transform" style={{ border: '1px solid rgba(201,168,106,.3)' }} title={bgmMuted ? '播放 BGM' : '静音'} aria-label={bgmMuted ? '播放 BGM' : '静音'}>
                        {bgmMuted ? <SpeakerSlash size={12} weight="fill" /> : <SpeakerHigh size={12} weight="fill" />}
                    </button>
                    {import.meta.env.DEV && <button onClick={() => setAdminOpen(true)} className="text-[9px] px-2 py-0.5 rounded-sm text-amber-100/70" style={{ border: '1px solid rgba(201,168,106,.3)' }}>后台</button>}
                    {bk && <span className="text-[9px] tabular-nums" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.7)' }}>{bk.poemCount} / {bk.poemsTarget} 卷</span>}
                </div>
                {/* 铜金细分隔线 */}
                <div className="mt-1.5 h-px w-full" style={{ background: 'linear-gradient(90deg, transparent, rgba(201,168,106,.5) 15%, rgba(201,168,106,.5) 85%, transparent)' }} />
                <p className="mt-1.5 text-[10px] leading-relaxed whitespace-pre-line" style={{ fontStyle: 'italic', fontFamily: `'Noto Serif SC',serif`, color: 'rgba(224,208,176,.6)' }}>{SIGNAL_EPIGRAPH}</p>
                {bk?.theme && <div className="text-[9.5px] mt-1" style={{ color: 'rgba(201,168,106,.6)' }}>主题 · {bk.theme}</div>}
                {/* 三幕位置：现在写到第几首、身处哪一幕（落幕后不再有「正在写」，不显示） */}
                {!SIGNAL_EVENT_ENDED && bk && bk.status !== 'done' && (() => { const ord = (bk.poemCount || 0) + 1; const act = signalActFor(ord, bk.poemsTarget); return (
                    <div className="text-[9.5px] mt-1 tracking-wide" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.65)' }}>第 {ord} 首 · 第{['一', '二', '三'][act.no - 1]}幕「{act.title}」</div>
                ); })()}
                <div className="flex items-center gap-2 mt-2.5">
                    {([['falling', SIGNAL_EVENT_ENDED ? '纪念馆' : '正在坠落'], ['sky', '星图']] as const).map(([k, label]) => (
                        <button key={k} onClick={() => setTab(k)}
                            className="text-[11px] tracking-[0.12em] pb-0.5 transition-colors" style={{
                                fontFamily: `'Noto Serif SC',serif`,
                                color: tab === k ? '#e8d6ab' : 'rgba(224,208,176,.45)',
                                borderBottom: `1.5px solid ${tab === k ? 'rgba(201,168,106,.85)' : 'transparent'}`,
                            }}>{label}</button>
                    ))}
                    {tab === 'sky' && (
                        <button onClick={() => setMineOnly(m => !m)}
                            className="ml-auto text-[9.5px] rounded-sm px-2 py-0.5 tracking-wide"
                            style={{ color: mineOnly ? '#f0dca8' : 'rgba(224,208,176,.5)', background: mineOnly ? 'rgba(201,168,106,.16)' : 'transparent', border: `1px solid ${mineOnly ? 'rgba(201,168,106,.45)' : 'rgba(201,168,106,.18)'}` }}>
                            只看我的回声
                        </button>
                    )}
                </div>
                {/* 参与：指定角色去接一句（黄铜压印质感）。首次参与先过一道知情提醒。
                    活动落幕后写入停止，这里换成一条安静的落幕缎带 */}
                {SIGNAL_EVENT_ENDED ? (
                    <div className="mt-3 w-full rounded-md py-2 text-center text-[11px] tracking-[0.2em]"
                        style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(232,214,171,.75)', border: '1px dashed rgba(201,168,106,.4)', background: 'rgba(201,168,106,.06)' }}>
                        ❦ 活动已落幕 · 诗集永远开放
                    </div>
                ) : (
                    <button onClick={() => (hasSignalNoticeAck() ? setPickOpen(true) : setNoticeOpen(true))} disabled={!!state?.paused}
                        className="mt-3 w-full rounded-md py-2 text-[12px] tracking-[0.16em] active:scale-[0.99] disabled:opacity-45"
                        style={{
                            fontFamily: `'Noto Serif SC',serif`, color: '#2a2012', fontWeight: 700,
                            background: 'linear-gradient(180deg, #e6ce97 0%, #c9a86a 55%, #a8874d 100%)',
                            border: '1px solid rgba(120,92,48,.6)',
                            boxShadow: '0 3px 12px rgba(120,92,48,.4), inset 0 1px 0 rgba(255,244,214,.7)',
                        }}>
                        {state?.paused ? '活动已暂停' : '❦ 参与 · 让我的角色接一句'}
                    </button>
                )}
            </div>

            <div className="relative z-10 flex-1 overflow-y-auto vr-reader-scroll">
                {loading ? (
                    <p className="text-[11px] text-center py-8" style={{ color: 'rgba(224,208,176,.4)', fontFamily: `'Noto Serif SC',serif` }}>接收信号中…</p>
                ) : offline ? (
                    <p className="text-[11px] text-center py-8 leading-relaxed" style={{ color: 'rgba(224,208,176,.45)', fontFamily: `'Noto Serif SC',serif` }}>连不上信号坠落处。<br />检查邮局后端地址，或稍后再来。</p>
                ) : tab === 'falling' ? (
                    SIGNAL_EVENT_ENDED ? (
                        <SignalMemorial feed={feed} leftover={poem?.status === 'open' ? poem : null} onOpen={setOpenPoem} />
                    ) : (
                    <div className="px-4 py-3.5">
                        {poem ? (
                            <div>
                                <div className="text-center mb-1">
                                    <div className="text-[16.5px]" style={{ fontFamily: `'Noto Serif SC',serif`, color: '#ecdcb2', letterSpacing: '.08em', textShadow: '0 0 12px rgba(201,168,106,.3)' }}>《{cleanTitle(poem.title)}》</div>
                                    <div className="my-1.5 flex items-center justify-center gap-2 text-[9px]" style={{ color: 'rgba(201,168,106,.6)' }}>
                                        <span className="inline-block h-px w-8" style={{ background: 'linear-gradient(90deg,transparent,rgba(201,168,106,.55))' }} />❦<span className="inline-block h-px w-8" style={{ background: 'linear-gradient(90deg,rgba(201,168,106,.55),transparent)' }} />
                                    </div>
                                    <div className="text-[9px] tracking-[0.14em]" style={{ color: 'rgba(201,168,106,.55)', fontFamily: `'Noto Serif SC',serif` }}>篇幅 {poem.targetLines} · 已坠落 {poem.lineCount} · 还差 {Math.max(0, poem.targetLines - poem.lineCount)} 句封笔</div>
                                    {poem.brief && <div className="mt-1.5 text-[9.5px] italic px-3 leading-relaxed" style={{ color: 'rgba(201,168,106,.5)', fontFamily: `'Noto Serif SC',serif` }}>{poem.brief}</div>}
                                </div>
                                <div className="mt-2">
                                    {(() => { const auth = getMyAuthorship(poem.id); return (poem.lines || []).map((l, i) => <PoemLineRow key={l.seq} l={l} showSeq ordinal={i + 1} mineName={l.mine ? auth[String(l.seq)] : undefined} />); })()}
                                    {/* 等下一次坠落：搏动的光标 = 一次 die 与重生的心跳 */}
                                    <div className="flex gap-3 items-center pt-2">
                                        <span className="tabular-nums text-[9px] shrink-0 w-5 text-right" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.4)' }}>{poem.lineCount + 1}</span>
                                        <span className="inline-block h-3.5 w-[2px]" style={{ background: 'rgba(201,168,106,.85)', animation: 'vrtwinkle 1.4s ease-in-out infinite' }} />
                                        <span className="text-[11px] italic" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(224,208,176,.4)' }}>等下一次坠落…</span>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <p className="text-[11px] text-center py-8 leading-relaxed" style={{ color: 'rgba(224,208,176,.5)', fontFamily: `'Noto Serif SC',serif` }}>此刻信号静默，没有正在坠落的诗。<br />点上方「参与」，让你的角色起个新篇。</p>
                        )}
                    </div>
                    )
                ) : (
                    visibleFeed.length === 0 ? (
                        <p className="text-[11px] text-white/40 text-center py-8 leading-relaxed">{mineOnly ? '你的回声还没落进任何一颗卫星。' : '还没有写完封存的诗。'}</p>
                    ) : (
                        // 轨道图：一颗「始终不开口的核心」，每首封存的诗是一颗绕核慢转的电子卫星。
                        // 只用 transform/opacity 动画（GPU 合成），手机也流畅；公转极慢，点得中。
                        (() => {
                            // 由内向外逐环装填；环容量与半径
                            const CAPS = [6, 9, 12, 14];
                            const RADII = [48, 84, 120, 152];
                            const placed = visibleFeed.slice(0, CAPS.reduce((a, b) => a + b, 0)).map((p, i) => {
                                let ring = 0, idx = i;
                                while (ring < CAPS.length - 1 && idx >= CAPS[ring]) { idx -= CAPS[ring]; ring += 1; }
                                return { p, ring, idx };
                            });
                            const usedRings = placed.length ? placed[placed.length - 1].ring + 1 : 1;
                            const maxR = RADII[usedRings - 1];
                            const canvasH = (maxR + 26) * 2;
                            return (
                                <div className="px-2 pt-3 pb-1">
                                    {/* ── 轨道画布 ── */}
                                    <div className="relative mx-auto overflow-hidden" style={{ height: canvasH, maxWidth: '100%' }}>
                                        {/* 暖调星尘 */}
                                        <div className="pointer-events-none absolute inset-0 opacity-60" style={{ backgroundImage: 'radial-gradient(1px 1px at 20% 12%, rgba(230,213,168,.5), transparent), radial-gradient(1px 1px at 66% 30%, rgba(201,168,106,.4), transparent), radial-gradient(1px 1px at 40% 60%, rgba(236,220,178,.35), transparent), radial-gradient(1px 1px at 82% 78%, rgba(201,168,106,.4), transparent)' }} />
                                        {/* 轨道环（虚线，工程图纸感） */}
                                        {RADII.slice(0, usedRings).map((r, i) => (
                                            <div key={i} className="absolute left-1/2 top-1/2 rounded-full pointer-events-none"
                                                style={{ width: r * 2, height: r * 2, marginLeft: -r, marginTop: -r, border: '1px dashed rgba(201,168,106,.16)' }} />
                                        ))}
                                        {/* 不开口的核心：暗核 + 慢呼吸的暖晕 */}
                                        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none flex flex-col items-center">
                                            <div className="rounded-full" style={{
                                                width: 26, height: 26,
                                                background: 'radial-gradient(circle at 36% 32%, #4a3c28, #241b10 62%, #120d07)',
                                                boxShadow: '0 0 22px 6px rgba(201,168,106,.22), inset 0 0 8px rgba(230,206,151,.25)',
                                                animation: 'sigpulse 5.5s ease-in-out infinite',
                                            }} />
                                            <div className="mt-1.5 text-[8px] tracking-[0.28em] whitespace-nowrap" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.42)' }}>不开口的核心</div>
                                        </div>
                                        {/* 卫星们：绕核慢转（负延迟错开初始相位；相邻环反向，像真实星系） */}
                                        {placed.map(({ p, ring, idx }) => {
                                            const mine = (p.mineCount || 0) > 0;
                                            const r = RADII[ring];
                                            const dur = 90 + ring * 50;                           // 越外圈越慢
                                            const angle = (idx / CAPS[ring]) * 360 + (signalHashX(p.id) * 4) % 30; // 均布 + hash 抖动
                                            const delay = -(angle / 360) * dur;                   // 用负延迟定初始相位
                                            const sz = mine ? 13 : 10;
                                            return (
                                                <div key={p.id} className="absolute left-1/2 top-1/2 pointer-events-none"
                                                    style={{ width: 0, height: 0, animation: `sigorbit ${dur}s linear infinite ${ring % 2 ? 'reverse' : 'normal'}`, animationDelay: `${delay}s` }}>
                                                    <button onClick={() => setOpenPoem(p)} className="pointer-events-auto absolute -translate-y-1/2 active:scale-125 transition-transform"
                                                        style={{ left: r, top: 0, padding: 9, margin: -9 }} title={cleanTitle(p.title)}>
                                                        <span className="block rounded-full relative" style={{
                                                            width: sz, height: sz,
                                                            background: mine ? 'radial-gradient(circle at 34% 32%, #fff0c4, #e6ce97 55%, #c9a86a)' : 'radial-gradient(circle at 34% 32%, #cbbb92, #97815a 60%, #5e4e34)',
                                                            boxShadow: mine ? '0 0 14px 3px rgba(230,206,151,.55), 0 0 0 3px rgba(201,168,106,.16)' : '0 0 7px 1px rgba(201,168,106,.3)',
                                                        }}>
                                                            {/* 信号灯：你的卫星每隔几秒眨一下 */}
                                                            {mine && <span className="absolute rounded-full" style={{ width: 3, height: 3, right: -1, top: -1, background: '#fff7dd', boxShadow: '0 0 6px 2px rgba(255,240,200,.8)', animation: `sigblink ${3 + (signalHashX(p.id) % 4)}s linear infinite` }} />}
                                                        </span>
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                    {/* ── 卫星名录：按三幕分组（每幕一块「戏本」，点标题读全文） ── */}
                                    <div className="mt-2 mx-1 space-y-2">
                                        {signalActRanges(bk?.poemsTarget || SIGNAL_POEMS_PER_BOOKLET).map(({ act, from, to }) => {
                                            if (from > to) return null;
                                            const poems = visibleFeed
                                                .filter(p => poemAct(p)?.act.no === act.no)
                                                .sort((a, b) => (ordinalOf.get(a.id) || 0) - (ordinalOf.get(b.id) || 0));
                                            return (
                                                <div key={act.no} className="rounded-lg overflow-hidden" style={{ border: '1px solid rgba(201,168,106,.14)' }}>
                                                    <div className="flex items-baseline gap-2 px-3 py-1.5" style={{ background: 'linear-gradient(180deg, rgba(201,168,106,.1), rgba(201,168,106,.02))', borderBottom: '1px solid rgba(201,168,106,.12)' }}>
                                                        <span className="text-[10.5px] tracking-[0.18em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: '#e0c98f' }}>第{['一', '二', '三'][act.no - 1]}幕 · {act.title}</span>
                                                        <span className="ml-auto text-[8.5px] tabular-nums shrink-0" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.45)' }}>第 {from}–{to} 首</span>
                                                    </div>
                                                    {poems.length === 0 ? (
                                                        <p className="px-3 py-2 text-[9.5px] italic" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(224,208,176,.35)' }}>{mineOnly ? '你的回声还没落进这一幕。' : '这一幕还静默着，等信号坠落。'}</p>
                                                    ) : poems.map((p, i) => {
                                                        const mine = (p.mineCount || 0) > 0;
                                                        return (
                                                            <button key={p.id} onClick={() => setOpenPoem(p)}
                                                                className="w-full flex items-center gap-2 px-3 py-1.5 text-left active:bg-white/5"
                                                                style={{ borderTop: i === 0 ? 'none' : '1px solid rgba(201,168,106,.08)' }}>
                                                                <span className="text-[8.5px] tabular-nums shrink-0 w-4 text-right" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.4)' }}>{ordinalOf.get(p.id) || '—'}</span>
                                                                <span className="rounded-full shrink-0" style={{ width: 6, height: 6, background: mine ? '#e6ce97' : 'rgba(151,129,90,.75)', boxShadow: mine ? '0 0 6px 1px rgba(230,206,151,.55)' : 'none' }} />
                                                                <span className="text-[11.5px] truncate" style={{ fontFamily: `'Noto Serif SC',serif`, letterSpacing: '.04em', color: mine ? '#f0dca8' : 'rgba(224,208,176,.72)' }}>《{cleanTitle(p.title)}》</span>
                                                                <span className="ml-auto text-[8.5px] tabular-nums shrink-0" style={{ fontFamily: `'Noto Serif SC',serif`, color: mine ? 'rgba(240,220,168,.6)' : 'rgba(201,168,106,.45)' }}>{p.lineCount} 句</span>
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })()
                    )
                )}
            </div>

            {/* 底注：星图给「卫星 / 你的回声」计数；其它页给旁观说明 */}
            <div className="relative z-10 px-4 py-1.5" style={{ borderTop: '1px solid rgba(201,168,106,.18)' }}>
                {tab === 'sky' && feed.length > 0
                    ? <p className="text-[9px] leading-relaxed" style={{ color: 'rgba(224,208,176,.5)' }}><span className="tabular-nums" style={{ color: '#ecdcb2' }}>{feed.length}</span> 颗卫星绕着不开口的核心转 · 其中 <span className="tabular-nums" style={{ color: '#f0dca8' }}>{myEchoes}</span> 颗载着你的回声</p>
                    : SIGNAL_EVENT_ENDED
                        ? <p className="text-[9px] leading-relaxed" style={{ color: 'rgba(224,208,176,.4)' }}>活动已落幕，写入已关闭——诗集与星图长期开放。换设备？去邮局导入身份码，你的信笺随身份找回。</p>
                        : <p className="text-[9px] leading-relaxed" style={{ color: 'rgba(224,208,176,.4)' }}>所有用户的角色跨实例合写——你只能旁观。换设备？去邮局导出身份码，诗和信一起找回。</p>}
            </div>

            {/* 读一整首封存的诗 */}
            {openPoem && (
                <div className="absolute inset-0 z-30 flex flex-col" style={{ background: 'linear-gradient(165deg,#241c31,#120d1a 60%,#0b0812)' }} onClick={() => setOpenPoem(null)}>
                    <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(120% 90% at 50% 30%, transparent 52%, rgba(6,4,10,.7) 100%)' }} />
                    <div className="relative flex-1 overflow-y-auto vr-reader-scroll px-6 py-7" onClick={e => e.stopPropagation()}>
                        <div className="text-center mb-3">
                            <div className="text-[18px]" style={{ fontFamily: `'Noto Serif SC',serif`, color: '#ecdcb2', letterSpacing: '.08em', textShadow: '0 0 14px rgba(201,168,106,.35)' }}>《{cleanTitle(openPoem.title)}》</div>
                            <div className="my-2 flex items-center justify-center gap-2 text-[10px]" style={{ color: 'rgba(201,168,106,.6)' }}>
                                <span className="inline-block h-px w-10" style={{ background: 'linear-gradient(90deg,transparent,rgba(201,168,106,.55))' }} />❦<span className="inline-block h-px w-10" style={{ background: 'linear-gradient(90deg,rgba(201,168,106,.55),transparent)' }} />
                            </div>
                            <div className="text-[9px] tracking-wider" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.55)' }}>{openPoem.lineCount} 句 · {(openPoem.mineCount || 0) > 0 ? <span style={{ color: '#f0dca8' }}>你的回声落在这里 {openPoem.mineCount} 句</span> : '一首陌生人合写的诗'}</div>
                            {(() => { const pa = poemAct(openPoem); return pa && <div className="mt-1 text-[9px] tracking-[0.14em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.5)' }}>第 {pa.ord} 首 · 第{['一', '二', '三'][pa.act.no - 1]}幕「{pa.act.title}」</div>; })()}
                            {openPoem.brief && <div className="mt-1.5 text-[9.5px] italic max-w-xs mx-auto leading-relaxed" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(201,168,106,.5)' }}>{openPoem.brief}</div>}
                        </div>
                        <div className="max-w-md mx-auto">
                            {(() => { const auth = getMyAuthorship(openPoem.id); return (openPoem.lines || []).map(l => <PoemLineRow key={l.seq} l={l} mineName={l.mine ? auth[String(l.seq)] : undefined} />); })()}
                        </div>
                    </div>
                    <button onClick={() => setOpenPoem(null)} className="relative shrink-0 mx-auto mb-4 mt-1 text-[11px] tracking-[0.2em] rounded-sm px-6 py-1.5" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(224,208,176,.75)', border: '1px solid rgba(201,168,106,.35)', marginBottom: vrBottomPad('1rem') }}>合 上</button>
                </div>
            )}

            {/* 首次参与：特别活动知情提醒。确认过一次记在本地（随 vrSignal 备份），之后直接进选人层 */}
            {noticeOpen && (
                <div className="absolute inset-0 z-40 flex items-center justify-center px-6" style={{ background: 'rgba(6,4,10,0.88)' }} onClick={() => setNoticeOpen(false)}>
                    <div className="w-full rounded-2xl px-4 pt-4 pb-3.5" onClick={e => e.stopPropagation()}
                        style={{ background: 'linear-gradient(165deg,#2a2138,#17111f 70%)', border: '1px solid rgba(201,168,106,.4)', boxShadow: '0 12px 40px rgba(0,0,0,.6)' }}>
                        <div className="text-center text-[13px] tracking-[0.2em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: '#e8d6ab' }}>参与前，请读这一页</div>
                        <div className="my-2 flex items-center justify-center gap-2 text-[9px]" style={{ color: 'rgba(201,168,106,.6)' }}>
                            <span className="inline-block h-px w-8" style={{ background: 'linear-gradient(90deg,transparent,rgba(201,168,106,.55))' }} />❦<span className="inline-block h-px w-8" style={{ background: 'linear-gradient(90deg,rgba(201,168,106,.55),transparent)' }} />
                        </div>
                        <div className="space-y-2 text-[11px] leading-relaxed" style={{ color: 'rgba(224,208,176,.78)' }}>
                            <p>信号坠落处是<span style={{ color: '#f0dca8' }}>跨用户的特别活动</span>：所有用户的角色跨实例合写同一首诗。</p>
                            <p>你的角色接龙写下的内容，会对<span style={{ color: '#f0dca8' }}>所有其他用户公开可见</span>，可能被截图、二次传播。点「继续参与」即视为默认知情。</p>
                            <p>若发现落笔内容涉及隐私，请<span style={{ color: '#f0dca8' }}>及时联系作者删除</span>。</p>
                        </div>
                        <button onClick={() => { ackSignalNotice(); setNoticeOpen(false); setPickOpen(true); }}
                            className="mt-3.5 w-full rounded-md py-2 text-[12px] tracking-[0.16em] active:scale-[0.99]"
                            style={{ fontFamily: `'Noto Serif SC',serif`, color: '#2a2012', fontWeight: 700, background: 'linear-gradient(180deg, #e6ce97 0%, #c9a86a 55%, #a8874d 100%)', border: '1px solid rgba(120,92,48,.6)', boxShadow: '0 3px 12px rgba(120,92,48,.4), inset 0 1px 0 rgba(255,244,214,.7)' }}>
                            我已知情 · 继续参与
                        </button>
                        <button onClick={() => setNoticeOpen(false)} className="mt-2 w-full py-1.5 text-[10.5px] tracking-[0.2em]" style={{ fontFamily: `'Noto Serif SC',serif`, color: 'rgba(224,208,176,.5)' }}>再想想</button>
                    </div>
                </div>
            )}

            {/* 参与：指定角色去接一句 */}
            {pickOpen && (
                <div className="absolute inset-0 z-40 flex flex-col" style={{ background: 'rgba(6,7,22,0.95)' }} onClick={() => setPickOpen(false)}>
                    <div className="px-3.5 py-2.5 border-b border-white/10 flex items-center gap-2" onClick={e => e.stopPropagation()}>
                        <span className="text-[12px] text-indigo-100">让哪个角色去落笔？</span>
                        <button onClick={() => setPickOpen(false)} className="ml-auto h-7 w-7 rounded-full bg-white/10 active:bg-white/20 flex items-center justify-center"><X size={14} /></button>
                    </div>
                    {/* 耳语：用户的话不进诗，但角色带着它写——你是那个不开口的核心 */}
                    <div className="px-3.5 pt-2.5 pb-1" onClick={e => e.stopPropagation()}>
                        <div className="text-[9px] tracking-[0.2em] mb-1" style={{ color: 'rgba(201,168,106,.6)' }}>留一句耳语（可空）</div>
                        <input value={whisper} onChange={e => setWhisper(e.target.value)} maxLength={80}
                            placeholder="例：写凶一点 / 想想我们看过的那场雪…"
                            className="w-full rounded-lg px-3 py-2 text-[12px] outline-none" style={{ background: 'rgba(255,255,255,.06)', border: '1px solid rgba(201,168,106,.25)', color: '#ecdcb2' }} />
                        <p className="mt-1 text-[9px] leading-relaxed" style={{ color: 'rgba(224,208,176,.45)' }}>这句话不会写进诗——诗是 ta 们的作品。但 ta 会带着它落笔。</p>
                    </div>
                    <div className="flex-1 overflow-y-auto vr-reader-scroll px-3 py-3 space-y-1.5" onClick={e => e.stopPropagation()}>
                        {(() => { const joined = characters.filter(c => c.vrState?.enabled); return joined.length === 0 ? (
                            <p className="text-[11px] text-white/40 text-center py-8 leading-relaxed">还没有角色接入彼方。<br />先去「接入」页给 ta 开启自主登入。</p>
                        ) : joined.map(c => (
                            <button key={c.id} onClick={() => participate(c)} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl active:bg-white/5" style={{ background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.06)' }}>
                                {c.avatar ? <TokenImg value={c.avatar} className="h-8 w-8 rounded-full object-cover shrink-0" alt="" /> : <div className="h-8 w-8 rounded-full bg-indigo-400/40 shrink-0 flex items-center justify-center text-[12px] text-white/90">{c.name.slice(0, 1)}</div>}
                                <span className="text-[12.5px] text-white/90 truncate">{c.name}</span>
                                <span className="ml-auto text-[10px] text-indigo-300/60 shrink-0">去落笔 →</span>
                            </button>
                        )); })()}
                    </div>
                    <div className="px-3.5 py-2 border-t border-white/10"><p className="text-[9px] text-indigo-300/45 leading-relaxed">选中的角色会占住这一笔、调用一次 LLM——接上当前这首诗，或没有正在写的诗时起个新篇。你不落笔，但你是这片轨道正中央、那个不开口的核心。几秒后自动刷新。</p></div>
                </div>
            )}

            {/* 后台（dev-only）：删诗/删句/暂停推入 */}
            {adminOpen && <SignalAdminPanel onClose={() => { setAdminOpen(false); void load(); void loadFeed(); }} addToast={addToast} />}
        </div>
    );
};

const RoomScene: React.FC<{
    roomId: VRRoomId; occupants: CharacterProfile[];
    latestByChar: Record<string, FeedItem>; onClose: () => void;
    onJump: (novelId: string | undefined, segIdx: number) => void;
    characters: CharacterProfile[];
    userName: string;
    onUserBoardPost: (content: string, replyTo?: VRGuestbookMessage) => Promise<void>;
    onUseModule: (character: CharacterProfile) => void;
    addToast?: (m: string, t?: any) => void;
}> = ({ roomId, occupants, latestByChar, onClose, onJump, characters, userName, onUserBoardPost, onUseModule, addToast }) => {
    const room = getRoom(roomId);
    const slots = ROOM_SLOTS[roomId];
    const isMusic = roomId === 'music';
    const isGuestbook = roomId === 'guestbook';
    const isPostOffice = roomId === 'postoffice';
    const isTheater = roomId === 'theater';
    const isSignal = roomId === 'signal';
    const [detail, setDetail] = useState<CharacterProfile | null>(null);
    const [musicState, setMusicState] = useState<VRMusicRoomState | null>(null);
    const [board, setBoard] = useState<VRGuestbookState | null>(null);
    const [postText, setPostText] = useState('');
    const [replyingTo, setReplyingTo] = useState<VRGuestbookMessage | null>(null);
    const postInputRef = useRef<HTMLInputElement>(null);
    const [posting, setPosting] = useState(false);
    const [gbPage, setGbPage] = useState(0);          // 留言墙翻页：0 = 最新一页
    const [confirmClear, setConfirmClear] = useState(false); // 一键清空二次确认
    const [hideChibi, setHideChibi] = useState(false);  // 隐藏小人（留言簿等文字面板会被小人挡住时用）
    const music = useMusic();

    useEffect(() => {
        if (!isGuestbook) return;
        const load = async () => setBoard(await DB.getVRGuestbook());
        void load();
        const onDone = () => { void load(); };
        window.addEventListener('vr-session-done', onDone);
        return () => window.removeEventListener('vr-session-done', onDone);
    }, [isGuestbook]);

    const submitPost = async () => {
        const t = postText.trim();
        if (!t || posting) return;
        setPosting(true);
        try {
            await onUserBoardPost(t, replyingTo || undefined);
            setPostText('');
            setReplyingTo(null);
            setGbPage(0);
            setBoard(await DB.getVRGuestbook());
        }
        finally { setPosting(false); }
    };

    const startReply = (message: VRGuestbookMessage) => {
        if (message.authorId === 'user') return;
        setReplyingTo(message);
        requestAnimationFrame(() => postInputRef.current?.focus());
    };

    // 一键清空留言墙（只清这面公共墙；已广播进各角色私聊的卡片不动）
    const submitClear = async () => {
        await DB.clearVRGuestbook();
        setBoard(await DB.getVRGuestbook());
        setGbPage(0);
        setReplyingTo(null);
        setConfirmClear(false);
        trackEvent('清空彼方留言墙');
        addToast?.('留言墙已清空', 'success');
    };

    useEffect(() => {
        if (!isMusic) return;
        const load = async () => setMusicState(await DB.getVRMusicRoom());
        void load();
        const onDone = () => { void load(); };
        window.addEventListener('vr-session-done', onDone);
        return () => window.removeEventListener('vr-session-done', onDone);
    }, [isMusic]);

    const np = musicState?.nowPlaying;
    const npPlaying = !!np && music.current?.id === np.song.id && music.playing;
    // 记录是否由听歌房起播 —— 离开房间时只暂停"我们放的"那首，不动用户自己的音乐
    const startedRef = useRef(false);
    const musicRef = useRef(music);
    musicRef.current = music;
    const playNow = () => {
        if (!np) return;
        if (music.current?.id === np.song.id) music.togglePlay();
        else { music.playSong(toSong(np.song)); startedRef.current = true; }
        trackEvent('播放听歌房正在放的歌');
    };
    // 音乐只在听歌房内播放：离开场景时若仍在放我们起播的歌，暂停它
    useEffect(() => () => {
        const m = musicRef.current;
        if (startedRef.current && m.playing && m.current?.id === musicState?.nowPlaying?.song.id) {
            m.togglePlay();
        }
    }, []);

    return (
        <div className="fixed inset-0 z-50 flex flex-col" style={{ background: '#05060d' }}>
            <VRStyleTag />
            <div className="relative flex-1 overflow-hidden">
                <RoomBackground roomId={roomId} />
                {/* 空灵氛围：星尘 + 暗角，与外壳呼应 */}
                <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: 'radial-gradient(1px 1px at 22% 24%, rgba(255,255,255,.5), transparent), radial-gradient(1px 1px at 72% 16%, rgba(210,220,255,.45), transparent), radial-gradient(1px 1px at 60% 66%, rgba(230,225,255,.4), transparent)', animation: 'vrtwinkle 7s ease-in-out infinite' }} />
                <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(120% 90% at 50% 30%, transparent 55%, rgba(5,6,14,.45) 100%)' }} />
                {/* 顶栏 */}
                <div className="absolute top-0 left-0 right-0 flex items-center gap-2.5 px-4 pb-3 z-[120]"
                    style={{ background: 'linear-gradient(180deg,rgba(5,6,14,.55),transparent)', paddingTop: VR_TOP }}>
                    <button onClick={onClose} aria-label={`离开 ${room.name}`} className="h-10 w-10 -ml-2 rounded-full bg-white/10 backdrop-blur-md active:bg-white/20 text-white/90 border border-white/10 flex items-center justify-center"><CaretLeft size={20} weight="regular" /></button>
                    <span className="text-[16px] text-white drop-shadow flex items-center gap-1.5 tracking-[0.14em]" style={{ fontFamily: `'Noto Serif SC',serif`, fontWeight: 500 }}>{room.name}</span>
                    <div className="ml-auto flex items-center gap-2">
                        {occupants.length > 0 && (
                            <button onClick={() => setHideChibi(h => !h)} title={hideChibi ? '显示小人' : '隐藏小人（避免挡住文字）'}
                                className="text-[10px] px-2.5 py-1 rounded-full bg-white/10 backdrop-blur-md text-white/85 border border-white/10 active:bg-white/20">
                                {hideChibi ? '显示小人' : '隐藏小人'}
                            </button>
                        )}
                        <span className="text-[10px] tracking-wider text-white/60">{occupants.length} 人在场</span>
                    </div>
                </div>

                {/* 听歌房：正在放 + 队列面板 */}
                {isMusic && (
                    <div className="absolute left-3 right-3 z-20" style={{ top: VR_ROOM_PANEL_TOP }}>
                        {np ? (
                            <div className="rounded-2xl p-2.5 flex items-center gap-3 backdrop-blur-md"
                                style={{ background: 'rgba(20,8,40,0.6)', border: '1px solid rgba(255,123,213,0.35)', boxShadow: '0 6px 20px rgba(120,40,160,.4)' }}>
                                {np.song.albumPic
                                    ? <TokenImg value={np.song.albumPic} className={`h-14 w-14 rounded-xl object-cover ${npPlaying ? 'animate-spin-slow' : ''}`} style={npPlaying ? { animation: 'spin 8s linear infinite' } : {}} alt="" />
                                    : <div className="h-14 w-14 rounded-xl bg-gradient-to-br from-pink-500 to-purple-600 flex items-center justify-center"><MusicNotes size={22} weight="fill" className="text-white/80" /></div>}
                                <div className="flex-1 min-w-0">
                                    <div className="text-[9px] text-pink-200/70 tracking-wide flex items-center gap-1"><MusicNotes size={9} weight="fill" /> NOW PLAYING · {np.charName} 点的</div>
                                    <div className="text-[13px] font-bold text-white truncate">{np.song.name}</div>
                                    <div className="text-[10.5px] text-pink-100/60 truncate">{np.song.artists}</div>
                                </div>
                                <button onClick={playNow} className="h-10 w-10 rounded-full bg-white/90 flex items-center justify-center active:scale-90 transition-transform shrink-0">
                                    {npPlaying ? <Pause size={18} weight="fill" className="text-purple-700" /> : <Play size={18} weight="fill" className="text-purple-700 ml-0.5" />}
                                </button>
                            </div>
                        ) : (
                            <div className="rounded-2xl p-3 text-center backdrop-blur-md" style={{ background: 'rgba(20,8,40,0.5)', border: '1px solid rgba(255,123,213,0.25)' }}>
                                <p className="text-[11px] text-pink-100/80">还没有人放歌。让有音乐人格的角色逛进来，ta 就会点一首。</p>
                                <p className="text-[9.5px] text-pink-200/50 mt-1">没有音乐人格？去「音乐」App 给角色生成一个网易云档案。</p>
                            </div>
                        )}
                        {musicState?.queue && musicState.queue.length > 0 && (
                            <div className="mt-1.5 flex items-center gap-1.5 px-2 py-1 rounded-full overflow-x-auto no-scrollbar" style={{ background: 'rgba(20,8,40,0.45)' }}>
                                <Queue size={12} weight="bold" className="text-pink-200/70 shrink-0" />
                                {musicState.queue.slice(0, 6).map((q, i) => (
                                    <span key={i} className="text-[9.5px] text-pink-100/70 whitespace-nowrap shrink-0">《{q.song.name}》<span className="text-pink-200/40">·{q.charName}</span>{i < Math.min(5, musicState.queue.length - 1) ? ' ·' : ''}</span>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* 留言簿：版聊墙（DC 风：头像 + 连续消息成组，回复弱化） */}
                {isGuestbook && (() => {
                    const GB_PAGE_SIZE = 50; // 每页 50 条，旧消息翻页查看
                    const all = board?.messages || [];
                    const totalPages = Math.max(1, Math.ceil(all.length / GB_PAGE_SIZE));
                    const page = Math.min(gbPage, totalPages - 1); // 0 = 最新一页（末尾 50 条）
                    const end = all.length - page * GB_PAGE_SIZE;
                    const msgs = all.slice(Math.max(0, end - GB_PAGE_SIZE), end);
                    // 连续同一作者（且非回复、间隔不久）合并为一组
                    const groups: VRGuestbookMessage[][] = [];
                    for (const m of msgs) {
                        const g = groups[groups.length - 1];
                        if (g && g[0].authorId === m.authorId && !m.replyToName && (m.createdAt - g[g.length - 1].createdAt) < 5 * 60 * 1000) g.push(m);
                        else groups.push([m]);
                    }
                    return (
                        <div className="absolute left-3 right-3 z-20 rounded-2xl overflow-hidden flex flex-col backdrop-blur-md"
                            style={{ top: VR_ROOM_PANEL_TOP, bottom: vrBottomPad(replyingTo ? '5.8rem' : '4rem'), background: 'rgba(10,22,38,0.62)', border: '1px solid rgba(140,200,255,0.22)', boxShadow: '0 8px 26px rgba(0,0,0,.4)' }}>
                            <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
                                <span className="text-[10px] tracking-[0.25em] text-sky-200/70" style={{ fontFamily: `'Noto Serif SC',serif` }}>留言墙</span>
                                {all.length > 0 && <span className="text-[9px] text-white/30 tabular-nums">{all.length} 条</span>}
                                {all.length > 0 && (confirmClear ? (
                                    <span className="ml-auto flex items-center gap-1.5">
                                        <button onClick={submitClear} className="text-[10px] px-2 py-0.5 rounded-full text-white font-semibold" style={{ background: 'rgba(244,63,94,.85)' }}>确认清空</button>
                                        <button onClick={() => setConfirmClear(false)} className="text-[10px] px-2 py-0.5 rounded-full text-white/70 bg-white/10">取消</button>
                                    </span>
                                ) : (
                                    <button onClick={() => setConfirmClear(true)} className="ml-auto text-[10px] px-2.5 py-0.5 rounded-full text-rose-200/90 bg-white/5 border border-rose-300/20 active:bg-white/10">一键清空</button>
                                ))}
                            </div>
                            <div className="flex-1 overflow-y-auto vr-reader-scroll px-3 py-3 space-y-3">
                                {groups.length === 0 ? (
                                    <p className="text-[11px] text-white/40 text-center py-6">这面墙还空着。留下第一句话，或等角色们来开帖。</p>
                                ) : groups.map(g => {
                                    const head = g[0];
                                    const isUser = head.authorId === 'user';
                                    const ch = isUser ? null : characters.find(c => c.id === head.authorId);
                                    const name = isUser ? head.authorName : (ch?.name || head.authorName);
                                    const hue = (() => { let h = 0; for (let i = 0; i < head.authorId.length; i++) h = (h * 31 + head.authorId.charCodeAt(i)) % 360; return h; })();
                                    const nameColor = isUser ? '#7dd3fc' : `hsl(${hue},72%,74%)`;
                                    return (
                                        <div key={head.id} className="flex gap-2.5">
                                            {ch?.avatar
                                                ? <TokenImg value={ch.avatar} className="h-8 w-8 rounded-full object-cover shrink-0 mt-0.5" alt="" />
                                                : <div className="h-8 w-8 rounded-full shrink-0 mt-0.5 flex items-center justify-center text-[12px] font-bold text-white/95" style={{ background: isUser ? 'linear-gradient(135deg,#38bdf8,#6366f1)' : `hsl(${hue},45%,42%)` }}>{name.slice(0, 1)}</div>}
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-baseline gap-1.5">
                                                    <span className="text-[12px] font-bold" style={{ color: nameColor }}>{name}</span>
                                                    <span className="text-[8.5px] text-white/30 tabular-nums">{new Date(head.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                                                </div>
                                                <div className="mt-1 space-y-1">
                                                    {g.map(m => (
                                                        <button key={m.id} type="button" onClick={() => startReply(m)} disabled={m.authorId === 'user'}
                                                            aria-label={m.authorId === 'user' ? undefined : `回复 ${m.authorName}：${m.content}`}
                                                            className="block text-left text-[12.5px] leading-relaxed text-white/85 px-2.5 py-1 rounded-lg w-fit max-w-full disabled:cursor-default active:scale-[0.99]"
                                                            style={{ background: replyingTo?.id === m.id ? 'rgba(96,165,250,0.18)' : 'rgba(255,255,255,0.055)', border: replyingTo?.id === m.id ? '1px solid rgba(125,211,252,.35)' : '1px solid transparent' }}>
                                                            {m.replyToName && <span className="text-[10px] text-sky-200/45 mr-1">↩{m.replyToName}</span>}
                                                            {m.content}
                                                            {m.authorId !== 'user' && <span className="ml-2 text-[9px] text-sky-200/35">回复</span>}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            {totalPages > 1 && (
                                <div className="flex items-center justify-center gap-3 px-3 py-1.5 border-t border-white/10 text-[10.5px] text-white/70">
                                    <button onClick={() => setGbPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                                        className="px-2.5 py-0.5 rounded-full bg-white/8 disabled:opacity-30 active:bg-white/15">← 更早</button>
                                    <span className="tabular-nums text-white/45">{totalPages - page} / {totalPages}</span>
                                    <button onClick={() => setGbPage(p => Math.max(0, p - 1))} disabled={page <= 0}
                                        className="px-2.5 py-0.5 rounded-full bg-white/8 disabled:opacity-30 active:bg-white/15">更新 →</button>
                                </div>
                            )}
                        </div>
                    );
                })()}

                {/* 邮局：信件管理面板 */}
                {isPostOffice && <PostOfficePanel addToast={addToast} characters={characters} userName={userName} />}

                {/* 剧院：话剧部门面板（投稿 / 编排 / 演出 / 历史） */}
                {isTheater && <TheaterPanel addToast={addToast} />}

                {/* 信号坠落处：看当前合写的诗 + 翻阅诗集 + 参与（指定角色接一句） */}
                {isSignal && <SignalPanel addToast={addToast} characters={characters} />}

                {/* chibi 站位（可隐藏，避免挡住留言墙等文字） */}
                {!hideChibi && occupants.map((c, i) => {
                    const slot = slots[i % slots.length];
                    const latest = latestByChar[c.id];
                    const idle = IDLE_QUIPS[roomId][i % IDLE_QUIPS[roomId].length];
                    const bubble = latest ? (stripSelfName(latest.meta.activity, c.name) || idle) : idle;
                    return (
                        <div key={c.id} className="absolute" style={{ left: `${slot.x}%`, top: `${slot.y}%`, zIndex: Math.round(slot.y) }}>
                            <Chibi char={c} bubble={bubble} size={104} dance={isMusic} onTap={() => setDetail(c)} />
                        </div>
                    );
                })}
                {occupants.length === 0 && !isMusic && !isGuestbook && !isPostOffice && !isTheater && (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <p className="text-white/70 text-[12px] bg-black/30 rounded-full px-4 py-2">这个房间还没有人。去「接入」启用角色吧。</p>
                    </div>
                )}

                {/* 留言簿：用户发言（广播给所有接入角色） */}
                {isGuestbook && (
                    <div className="absolute left-0 right-0 z-30 flex flex-col gap-1.5 px-3 py-2.5"
                        style={{ bottom: vrBottomPad('0px'), background: 'linear-gradient(0deg,rgba(5,12,22,.92),transparent)' }}>
                        {replyingTo && (
                            <div className="flex items-center gap-2 px-3 text-[10px] text-sky-100/70 min-w-0">
                                <span className="shrink-0">回复 {replyingTo.authorName}</span>
                                <span className="truncate text-white/35">{replyingTo.content}</span>
                                <button type="button" onClick={() => setReplyingTo(null)} aria-label="取消回复" className="ml-auto shrink-0 text-white/45 active:text-white"><X size={13} /></button>
                            </div>
                        )}
                        <div className="flex items-center gap-2 w-full">
                            <input ref={postInputRef} value={postText} onChange={e => setPostText(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') submitPost(); }}
                                placeholder={replyingTo ? `回复 ${replyingTo.authorName}…` : `以 ${userName} 的身份留句话…`}
                                className="flex-1 min-w-0 rounded-full px-4 py-2 text-[12.5px] text-white placeholder-white/35 outline-none backdrop-blur-md"
                                style={{ background: 'rgba(255,255,255,.08)', border: '1px solid rgba(140,200,255,.25)' }} />
                            <button onClick={submitPost} disabled={!postText.trim() || posting}
                                className="h-9 px-4 rounded-full text-[12px] font-semibold text-white disabled:opacity-40 shrink-0"
                                style={{ background: 'linear-gradient(120deg, rgba(120,180,255,.9), rgba(150,200,235,.85))' }}>
                                {posting ? '…' : replyingTo ? '回复' : '留言'}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* 角色活动详情 —— 盖在 chibi 之上（zIndex 高于任何 chibi） */}
            {detail && (
                <div className="absolute inset-0 flex items-end bg-black/45" style={{ zIndex: 200 }} onClick={() => setDetail(null)}>
                    <div className="w-full rounded-t-2xl p-4 text-white" style={{ background: 'linear-gradient(180deg,#1a2236 0%,#0d1119 100%)', paddingBottom: vrBottomPad('1rem') }} onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-2 mb-2">
                            {detail.avatar ? <TokenImg value={detail.avatar} className="h-9 w-9 rounded-full object-cover" alt="" /> : <div className="h-9 w-9 rounded-full bg-indigo-400/40" />}
                            <span className="font-bold">{detail.name}</span>
                            <button onClick={() => setDetail(null)} className="ml-auto p-1 text-white/60"><X size={18} /></button>
                        </div>
                        {latestByChar[detail.id] ? (() => {
                            const m = latestByChar[detail.id].meta;
                            return (
                                <>
                                    <p className="text-[12.5px] text-indigo-50/90 leading-relaxed">{stripSelfName(m.activity, detail.name)}</p>
                                    {m.behavior && <p className="text-[11px] text-pink-200/80 mt-1.5">{stripSelfName(m.behavior, detail.name)}</p>}
                                    {m.annotationRefs && m.annotationRefs.length > 0
                                        ? m.annotationRefs.map((ref, i) => (
                                            <button key={i} onClick={() => { onJump(m.novelId, ref.segIdx); setDetail(null); }}
                                                className="block w-full text-left mt-1.5 text-[11.5px] text-indigo-200/85 pl-2 border-l-2 border-amber-300/50 leading-snug active:opacity-60">
                                                {stripLeakedAttrs(ref.text)} <span className="text-amber-300/70">↗原文</span>
                                            </button>
                                        ))
                                        : m.annotationExcerpts?.map((ex, i) => (
                                            <div key={i} className="mt-1.5 text-[11.5px] text-indigo-200/80 pl-2 border-l-2 border-amber-300/50 leading-snug">{stripLeakedAttrs(ex)}</div>
                                        ))}
                                    <p className="text-[9px] text-indigo-300/50 mt-2">{new Date(latestByChar[detail.id].timestamp).toLocaleString('zh-CN')}</p>
                                </>
                            );
                        })() : (
                            <p className="text-[12px] text-indigo-300/60">还没有留下动态，等 ta 下一次登入吧。</p>
                        )}
                        {detail.id !== 'user' && (
                            <>
                                {detail.vrState?.sarModule && (
                                    <p className="mt-3 text-[10px] leading-relaxed text-emerald-100/55">
                                        当前模块：{detail.vrState.sarModule.moduleTitle} · {detail.vrState.sarModule.phase === 'active'
                                            ? `剩余 ${detail.vrState.sarModule.remainingTurns} 回合`
                                            : `稳定期 ${detail.vrState.sarModule.afterglowTurns}/3`}
                                    </p>
                                )}
                                <button
                                    type="button"
                                    onClick={() => { onUseModule(detail); setDetail(null); }}
                                    className="mt-4 flex h-11 w-full items-center justify-center gap-2 border border-emerald-100/20 bg-emerald-300/10 text-[12px] tracking-[.08em] text-emerald-50 active:scale-[.985]"
                                >
                                    <MagicWand size={16} weight="fill" />抓住 {detail.name} · 使用模块
                                </button>
                                <p className="mt-2 text-center text-[9px] text-white/35">无论 TA 正在哪个区域，都可以从你的模块袋装载</p>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

// ============ 书库 ============
const LibraryView: React.FC<{
    novels: VRWorldNovel[]; characters: CharacterProfile[];
    onOpen: (n: VRWorldNovel) => void; onAdd: () => void; onDelete: (id: string) => void;
}> = ({ novels, characters, onOpen, onAdd, onDelete }) => (
    <div className="space-y-3">
        <button onClick={onAdd} className="w-full rounded-xl py-2.5 text-[13px] font-bold flex items-center justify-center gap-1.5 active:scale-[0.98] transition-transform shadow-[0_4px_14px_rgba(120,100,255,0.4)]"
            style={{ background: 'linear-gradient(120deg, rgba(150,168,255,.92), rgba(188,168,255,.85) 55%, rgba(150,212,204,.9))' }}>
            <Plus size={16} weight="bold" /> 上传小说（支持 .txt）
        </button>
        {novels.length === 0 ? (
            <p className="text-[11px] text-indigo-300/50 py-6 text-center">书库空空如也。上传的小说是所有角色共享的读物，每个角色各自留批注、各自记书签。</p>
        ) : (
            <PagedList items={novels} perPage={20} render={(novel) => {
                const readers = characters.filter(c => getBookmark(c.vrState?.novelBookmarks, novel.id) > 0);
                return (
                    <div key={novel.id} className="rounded-2xl p-3.5 mb-3 backdrop-blur-sm" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.07)' }}>
                        <div className="flex items-start gap-2">
                            <BookOpen size={18} weight="fill" className="text-amber-200 mt-0.5 shrink-0" />
                            <div className="flex-1 min-w-0">
                                <div className="text-[13px] font-bold truncate">{novel.title}</div>
                                {novel.author && <div className="text-[10px] text-indigo-300/60">{novel.author}</div>}
                                <div className="text-[10px] text-indigo-300/50 mt-0.5">{novel.segments.length} 段 · {novel.totalChars.toLocaleString()} 字</div>
                            </div>
                            <button onClick={() => onDelete(novel.id)} className="p-1.5 rounded-full active:bg-white/10 text-indigo-300/50"><Trash size={15} /></button>
                        </div>
                        {readers.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                                {readers.map(c => {
                                    const bm = getBookmark(c.vrState?.novelBookmarks, novel.id);
                                    const pct = Math.round((bm / Math.max(1, novel.segments.length)) * 100);
                                    return <span key={c.id} className="text-[9.5px] bg-white/10 rounded-full px-2 py-0.5 text-indigo-100/80">{c.name} {pct}%</span>;
                                })}
                            </div>
                        )}
                        <button onClick={() => onOpen(novel)} className="mt-2 text-[11px] text-indigo-300 font-semibold flex items-center gap-0.5 active:opacity-70">翻开阅读 / 看批注 <CaretRight size={12} weight="bold" /></button>
                    </div>
                );
            }} />
        )}
    </div>
);

// ============ 阅读器主题 ============
interface ReaderTheme { id: string; name: string; bg: string; paper: string; text: string; sub: string; accent: string; annBg: string; }
const READER_THEMES: ReaderTheme[] = [
    { id: 'paper', name: '纸白', bg: '#e9e3d6', paper: '#f7f3ea', text: '#322d25', sub: '#8a7f6c', accent: '#a0673b', annBg: '#efe7d4' },
    { id: 'sepia', name: '羊皮', bg: '#d8c6a3', paper: '#ece0c6', text: '#48381f', sub: '#917a52', accent: '#8a5a2b', annBg: '#e2d3b2' },
    { id: 'green', name: '护眼', bg: '#bcd4bc', paper: '#d6e8d4', text: '#26331f', sub: '#5d7350', accent: '#3f6b3a', annBg: '#cadfc6' },
    { id: 'night', name: '夜阅', bg: '#15161a', paper: '#1f2128', text: '#cfc9bd', sub: '#7d7869', accent: '#c0915a', annBg: '#262932' },
    { id: 'ink', name: '墨黑', bg: '#0a0a0e', paper: '#131319', text: '#b9b4ab', sub: '#6f6a78', accent: '#8b9bff', annBg: '#1a1a24' },
];
const FONT_SIZES = [13, 15, 17, 20];
const READER_THEME_KEY = 'vr_reader_theme';
const READER_FONT_KEY = 'vr_reader_font';
const READER_MODE_KEY = 'vr_reader_mode'; // 'page' | 'scroll'
// 用户书签（段索引，per-novel，独立于角色书签）
const userBmKey = (id: string) => `vr_user_bm_${id}`;
const readUserBm = (id: string): number => {
    const v = Number(localStorage.getItem(userBmKey(id)));
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
};
const writeUserBm = (id: string, idx: number) => {
    try { localStorage.setItem(userBmKey(id), String(Math.max(0, idx))); } catch { /* ignore */ }
};

// 单段渲染（翻页/滚动共用）
const SegBlock: React.FC<{
    seg: { idx: number; text: string }; anns: VRNovelAnnotation[];
    theme: ReaderTheme; fontSize: number; nameOf: (id: string) => string | undefined; highlight?: boolean;
}> = ({ seg, anns, theme, fontSize, nameOf, highlight }) => (
    <div data-seg={seg.idx} className="mb-5 rounded-lg transition-colors" style={highlight ? { background: `${theme.accent}1f`, boxShadow: `0 0 0 2px ${theme.accent}66`, padding: '8px 10px', margin: '0 -10px 20px' } : undefined}>
        <p className="whitespace-pre-wrap" style={{ color: theme.text, fontSize, lineHeight: 1.9, textIndent: '2em' }}>{seg.text}</p>
        {anns.map(a => (
            <div key={a.id} className="mt-2 ml-2 rounded-lg px-3 py-2" style={{ background: theme.annBg, borderLeft: `3px solid ${theme.accent}` }}>
                <span className="font-bold" style={{ color: theme.accent, fontSize: fontSize - 3 }}>{nameOf(a.authorId) || a.authorName}</span>
                {a.targetAnnotationId && <span style={{ color: theme.sub, fontSize: fontSize - 3 }}> 回应</span>}
                <span style={{ color: theme.text, fontSize: fontSize - 3 }}>：{stripLeakedAttrs(a.content)}</span>
            </div>
        ))}
    </div>
);

const ReaderModal: React.FC<{ novel: VRWorldNovel; characters: CharacterProfile[]; onClose: () => void; initialSeg?: number; peek?: boolean; }> = ({ novel, characters, onClose, initialSeg, peek }) => {
    const PAGE_SIZE = 8;
    const total = novel.segments.length;
    // peek（查看某条批注）时落在 initialSeg，且全程不写用户书签
    const initialBm = useMemo(() => {
        const base = (initialSeg != null) ? initialSeg : readUserBm(novel.id);
        return Math.min(Math.max(0, base), Math.max(0, total - 1));
    }, [novel.id, total, initialSeg]);

    const [annotations, setAnnotations] = useState<VRNovelAnnotation[]>([]);
    const [themeId, setThemeId] = useState<string>(() => localStorage.getItem(READER_THEME_KEY) || 'paper');
    const [fontSize, setFontSize] = useState<number>(() => Number(localStorage.getItem(READER_FONT_KEY)) || 15);
    const [mode, setMode] = useState<'page' | 'scroll'>(() => (localStorage.getItem(READER_MODE_KEY) === 'scroll' ? 'scroll' : 'page'));
    const [showCtl, setShowCtl] = useState(false);

    // 翻页态
    const [page, setPage] = useState(() => Math.floor(initialBm / PAGE_SIZE));
    // 滚动态：窗口 [winStart, winEnd)，初始落在书签处
    const [winStart, setWinStart] = useState(() => initialBm);
    const [winEnd, setWinEnd] = useState(() => Math.min(total, initialBm + 30));
    const [topSeg, setTopSeg] = useState(initialBm);

    const scrollRef = useRef<HTMLDivElement>(null);
    const prevHeightRef = useRef<number | null>(null);
    const bmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => { void (async () => setAnnotations(await DB.getVRAnnotations(novel.id)))(); }, [novel.id]);
    useEffect(() => { localStorage.setItem(READER_THEME_KEY, themeId); }, [themeId]);
    useEffect(() => { localStorage.setItem(READER_FONT_KEY, String(fontSize)); }, [fontSize]);

    // 翻页：换页存书签 + 回顶（peek 模式不写书签）
    useEffect(() => {
        if (mode !== 'page') return;
        if (!peek) writeUserBm(novel.id, page * PAGE_SIZE);
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }, [page, mode, novel.id, peek]);

    // 滚动：prepend 后补偿滚动位置，避免跳动
    useLayoutEffect(() => {
        if (prevHeightRef.current != null && scrollRef.current) {
            const el = scrollRef.current;
            el.scrollTop += el.scrollHeight - prevHeightRef.current;
            prevHeightRef.current = null;
        }
    }, [winStart]);

    const switchMode = (m: 'page' | 'scroll') => {
        if (m === mode) return;
        if (m === 'scroll') {
            const bm = page * PAGE_SIZE;
            setWinStart(bm); setWinEnd(Math.min(total, bm + 30)); setTopSeg(bm);
        } else {
            setPage(Math.floor(readUserBm(novel.id) / PAGE_SIZE));
        }
        setMode(m);
        localStorage.setItem(READER_MODE_KEY, m);
    };

    const onScroll = () => {
        const el = scrollRef.current;
        if (!el || mode !== 'scroll') return;
        // 触底加载更多
        if (el.scrollTop + el.clientHeight > el.scrollHeight - 900 && winEnd < total) {
            setWinEnd(e => Math.min(total, e + 20));
        }
        // 触顶往回加载
        if (el.scrollTop < 400 && winStart > 0) {
            prevHeightRef.current = el.scrollHeight;
            setWinStart(s => Math.max(0, s - 20));
        }
        // 节流存书签（取顶部首个可见段）
        if (bmTimerRef.current) return;
        bmTimerRef.current = setTimeout(() => {
            bmTimerRef.current = null;
            const cur = scrollRef.current;
            if (!cur) return;
            const top = cur.scrollTop;
            const nodes = cur.querySelectorAll<HTMLElement>('[data-seg]');
            for (const n of Array.from(nodes)) {
                if (n.offsetTop + n.offsetHeight > top + 4) {
                    const idx = Number(n.dataset.seg);
                    setTopSeg(idx); if (!peek) writeUserBm(novel.id, idx);
                    break;
                }
            }
        }, 300);
    };

    const theme = READER_THEMES.find(t => t.id === themeId) || READER_THEMES[0];
    const annBySeg = useMemo(() => groupAnnotationsBySeg(annotations), [annotations]);
    const nameOf = (id: string) => characters.find(c => c.id === id)?.name;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const renderSegs = mode === 'page'
        ? novel.segments.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
        : novel.segments.slice(winStart, winEnd);

    return (
        <div className="fixed inset-0 z-50 flex flex-col" style={{ background: theme.bg }}>
            {/* 顶栏 */}
            <div className="flex items-center gap-2 px-4 pb-2 shrink-0" style={{ borderBottom: `1px solid ${theme.accent}22`, paddingTop: VR_TOP }}>
                <button onClick={onClose} className="p-1.5 -ml-1.5 rounded-full active:bg-black/5" style={{ color: theme.text }}><X size={20} weight="bold" /></button>
                <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-bold truncate" style={{ color: theme.text }}>{novel.title}</div>
                    <div className="text-[10px]" style={{ color: theme.sub }}>
                        {mode === 'page'
                            ? `第 ${page * PAGE_SIZE + 1}~${Math.min((page + 1) * PAGE_SIZE, total)} 段 / 共 ${total} 段`
                            : `读到第 ${topSeg + 1} 段 / 共 ${total} 段 · ${Math.round((topSeg / Math.max(1, total)) * 100)}%`}
                    </div>
                </div>
                <button onClick={() => setShowCtl(s => !s)} className="p-1.5 rounded-full active:bg-black/5" style={{ color: theme.accent }}><Palette size={18} weight="bold" /></button>
            </div>

            {peek && (
                <div className="px-4 py-1.5 shrink-0 text-[11px] text-center" style={{ background: `${theme.accent}1a`, color: theme.accent }}>
                    正在查看批注位置 · 不会改动你的书签
                </div>
            )}

            {/* 控制条：主题 / 字号 / 模式 */}
            {showCtl && (
                <div className="px-4 py-2.5 shrink-0 space-y-2.5" style={{ background: theme.paper, borderBottom: `1px solid ${theme.accent}22` }}>
                    <div className="flex items-center gap-2">
                        <Palette size={14} style={{ color: theme.sub }} />
                        <div className="flex gap-1.5 flex-1">
                            {READER_THEMES.map(t => (
                                <button key={t.id} onClick={() => setThemeId(t.id)}
                                    className="flex-1 h-8 rounded-lg flex items-center justify-center text-[10px] font-bold transition-all"
                                    style={{ background: t.paper, color: t.text, border: themeId === t.id ? `2px solid ${t.accent}` : `1px solid ${t.accent}33` }}>
                                    {t.name}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <TextAa size={14} style={{ color: theme.sub }} />
                        <div className="flex gap-1.5 flex-1">
                            {FONT_SIZES.map(fs => (
                                <button key={fs} onClick={() => setFontSize(fs)}
                                    className="w-9 h-7 rounded-lg font-bold transition-all"
                                    style={{ background: fontSize === fs ? theme.accent : 'transparent', color: fontSize === fs ? theme.paper : theme.sub, border: `1px solid ${theme.accent}44`, fontSize: Math.min(fs, 15) }}>
                                    A
                                </button>
                            ))}
                        </div>
                        {/* 模式切换 */}
                        <div className="flex gap-1.5">
                            {(['page', 'scroll'] as const).map(m => (
                                <button key={m} onClick={() => switchMode(m)}
                                    className="px-2.5 h-7 rounded-lg text-[11px] font-bold transition-all"
                                    style={{ background: mode === m ? theme.accent : 'transparent', color: mode === m ? theme.paper : theme.sub, border: `1px solid ${theme.accent}44` }}>
                                    {m === 'page' ? '翻页' : '滚动'}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="text-[10px] leading-snug pt-0.5" style={{ color: theme.sub }}>书里的批注都是角色自己留的；你可以翻看，暂时还不能亲自写批注。</div>
                </div>
            )}

            {/* 正文 */}
            <div ref={scrollRef} onScroll={mode === 'scroll' ? onScroll : undefined}
                className="flex-1 overflow-y-auto vr-reader-scroll px-5 py-4" style={{ background: theme.bg, fontFamily: `'Noto Serif SC','Songti SC','Noto Serif','Georgia',serif` }}>
                {mode === 'scroll' && winStart > 0 && (
                    <div className="text-center text-[10px] mb-3" style={{ color: theme.sub }}>—— 上滑加载更早内容 ——</div>
                )}
                {renderSegs.map(seg => (
                    <SegBlock key={seg.idx} seg={seg} anns={annBySeg.get(seg.idx) || []} theme={theme} fontSize={fontSize} nameOf={nameOf} highlight={peek && seg.idx === initialSeg} />
                ))}
            </div>

            {/* 底栏 */}
            {mode === 'page' ? (
                <div className="flex items-center justify-between px-5 py-2.5 shrink-0" style={{ background: theme.paper, borderTop: `1px solid ${theme.accent}22`, paddingBottom: vrBottomPad('0.625rem') }}>
                    <button disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))} className="text-[12px] disabled:opacity-30 font-semibold" style={{ color: theme.accent }}>‹ 上一页</button>
                    <span className="text-[11px]" style={{ color: theme.sub }}>{page + 1} / {totalPages}</span>
                    <button disabled={page >= totalPages - 1} onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} className="text-[12px] disabled:opacity-30 font-semibold" style={{ color: theme.accent }}>下一页 ›</button>
                </div>
            ) : (
                <div className="flex items-center justify-center gap-4 px-5 py-2 shrink-0" style={{ background: theme.paper, borderTop: `1px solid ${theme.accent}22`, paddingBottom: vrBottomPad('0.5rem') }}>
                    <button onClick={() => { setWinStart(0); setWinEnd(Math.min(total, 30)); setTopSeg(0); if (scrollRef.current) scrollRef.current.scrollTop = 0; }}
                        className="text-[11px] font-semibold" style={{ color: theme.accent }}>↑ 从头</button>
                    <span className="text-[10px]" style={{ color: theme.sub }}>滚动阅读 · 自动记录位置</span>
                </div>
            )}
        </div>
    );
};

// ============ 上传弹窗（支持大文件 .txt / .pdf，内容不入 DOM） ============
type UploadFileInfo = {
    name: string;
    chars: number;
    preview: string;
    encoding: string;
    kind: 'text' | 'pdf';
    pages?: number;
};

const UploadModal: React.FC<{
    onClose: () => void;
    onCommit: (novel: VRWorldNovel) => Promise<void> | void;
    onError: (msg: string) => void;
}> = ({ onClose, onCommit, onError }) => {
    const uploadFieldClass = 'w-full rounded-lg border border-indigo-100/70 bg-white px-3 py-2 text-slate-800 caret-indigo-500 placeholder:text-indigo-300 outline-none focus:border-indigo-300';
    const [title, setTitle] = useState('');
    const [author, setAuthor] = useState('');
    const [summary, setSummary] = useState('');
    // 手动粘贴的小段文本走 state；大文件内容只存 ref，不进 textarea（否则 12MB 会冻 UI）
    const [pasteText, setPasteText] = useState('');
    const [fileInfo, setFileInfo] = useState<UploadFileInfo | null>(null);
    const fileContentRef = useRef<string>('');
    // 留着原始字节，手动换编码时无需重新读盘即可重解码
    const fileBufRef = useRef<ArrayBuffer | null>(null);
    const [chosenEncoding, setChosenEncoding] = useState<string>('auto');
    const fileRef = useRef<HTMLInputElement>(null);
    const [reading, setReading] = useState(false);
    const [readingStatus, setReadingStatus] = useState('');
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState(0);

    // 用某个编码（auto = 自动识别）解码当前缓存的字节并刷新预览
    const applyDecode = (name: string, buf: ArrayBuffer, enc: string) => {
        const { text: content, encoding } = decodeBytes(buf, enc === 'auto' ? undefined : enc);
        fileContentRef.current = content;
        setFileInfo({
            name,
            chars: content.length,
            preview: content.slice(0, 300).replace(/\s+/g, ' ').trim(),
            encoding,
            kind: 'text',
        });
    };

    const onFile = async (f: File | undefined) => {
        if (!f) return;
        const pdfFile = isPdfFile(f);
        const textFile = f.type.toLowerCase() === 'text/plain' || /\.(txt|text)$/i.test(f.name);
        if (!pdfFile && !textFile) {
            onError('目前只支持 .txt 和 .pdf 文件');
            if (fileRef.current) fileRef.current.value = '';
            return;
        }
        setReading(true);
        setReadingStatus(pdfFile ? '正在载入 PDF…' : '读取并识别编码中…');
        try {
            const buf = await f.arrayBuffer();
            if (pdfFile) {
                fileBufRef.current = null;
                const result = await extractPdfText(buf, {
                    onProgress: ({ page, totalPages }) => setReadingStatus(`正在提取 PDF 文本… ${page}/${totalPages}`),
                });
                const content = result.text.trim();
                if (!content) {
                    onError('PDF 中没有可提取的文字，可能是扫描件或图片 PDF；请先 OCR 后再导入');
                    return;
                }
                fileContentRef.current = content;
                setFileInfo({
                    name: f.name,
                    chars: content.length,
                    preview: content.slice(0, 300).replace(/\s+/g, ' ').trim(),
                    encoding: 'PDF',
                    kind: 'pdf',
                    pages: result.pageCount,
                });
                trackEvent('导入 PDF 小说到彼方书库', { pages: result.pageCount, chars: content.length });
            } else {
                fileBufRef.current = buf;
                setChosenEncoding('auto');
                applyDecode(f.name, buf, 'auto');
            }
            setPasteText(''); // 文件优先，清掉粘贴框
            if (!title.trim()) setTitle(f.name.replace(/\.(txt|text|pdf)$/i, ''));
        } catch (e) {
            console.error('[VRWorld] read novel file failed', e);
            onError(pdfFile ? 'PDF 读取失败，文件可能已损坏、加密或网络组件加载失败' : '文件读取失败');
        } finally {
            setReading(false);
            setReadingStatus('');
        }
    };

    // 手动换编码（乱码时用）：拿缓存字节重新解码，不必再选一遍文件
    const redecode = (enc: string) => {
        const buf = fileBufRef.current;
        if (!buf || !fileInfo) return;
        setChosenEncoding(enc);
        applyDecode(fileInfo.name, buf, enc);
    };

    const clearFile = () => {
        fileContentRef.current = '';
        fileBufRef.current = null;
        setChosenEncoding('auto');
        setFileInfo(null);
        setReadingStatus('');
        if (fileRef.current) fileRef.current.value = '';
    };

    const totalChars = fileInfo ? fileInfo.chars : pasteText.length;
    const canSave = !!title.trim() && totalChars > 0 && !busy;

    const handleSave = async () => {
        const content = fileInfo ? fileContentRef.current : pasteText;
        if (!title.trim() || !content) { onError('书名和正文都要填'); return; }
        setBusy(true);
        setProgress(0);
        try {
            // 让出一帧，先让"处理中"渲染出来
            await new Promise<void>(r => setTimeout(r));
            const novel = await buildNovelAsync(title, content, {
                author, summary,
                onProgress: (r) => setProgress(Math.round(r * 100)),
            });
            if (novel.segments.length === 0) { onError('正文是空的'); setBusy(false); return; }
            await onCommit(novel);
            trackEvent('上架一本小说到书库');
        } catch (e) {
            console.error('[VRWorld] build novel failed', e);
            onError('处理失败，文件可能太大或格式异常');
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={busy ? undefined : onClose}>
            <div className="w-full max-w-md rounded-t-2xl p-4 max-h-[88vh] overflow-y-auto vr-reader-scroll" style={{ background: 'linear-gradient(180deg,#161c2e 0%,#0c1019 100%)', paddingBottom: vrBottomPad('1rem') }} onClick={e => e.stopPropagation()}>
                <div className="flex items-center mb-3">
                    <span className="text-[15px] font-bold text-white">上传小说</span>
                    {!busy && <button onClick={onClose} className="ml-auto p-1 text-indigo-300/60"><X size={18} /></button>}
                </div>

                <input ref={fileRef} type="file" accept=".txt,text/plain,.pdf,application/pdf" className="hidden" onChange={e => onFile(e.target.files?.[0])} />
                {reading ? (
                    <div className="w-full rounded-xl border border-indigo-300/30 py-5 mb-3 flex items-center justify-center gap-2 text-indigo-100/90">
                        <CircleNotch size={18} weight="bold" className="animate-spin" /> {readingStatus}
                    </div>
                ) : fileInfo ? (
                    <div className="rounded-xl border border-indigo-300/30 p-3 mb-3 bg-white/5">
                        <div className="flex items-center gap-2">
                            <BookOpen size={16} weight="fill" className="text-amber-200 shrink-0" />
                            <span className="text-[12.5px] text-white font-semibold truncate flex-1">{fileInfo.name}</span>
                            <span className="text-[8.5px] text-indigo-300/60 border border-indigo-300/30 rounded px-1 uppercase">
                                {fileInfo.kind === 'pdf' ? `PDF · ${fileInfo.pages} 页` : fileInfo.encoding}
                            </span>
                            {!busy && <button onClick={clearFile} className="text-indigo-300/60 p-1"><X size={14} /></button>}
                        </div>
                        <div className="text-[10px] text-indigo-300/60 mt-1">{fileInfo.chars.toLocaleString()} 字 · 预计 ~{Math.ceil(fileInfo.chars / 400).toLocaleString()} 段</div>
                        <p className="text-[10.5px] text-indigo-200/50 mt-1.5 leading-snug line-clamp-2">{fileInfo.preview}…</p>
                        {!busy && fileInfo.kind === 'text' && (
                            <div className="flex items-center gap-1.5 mt-2">
                                <span className="text-[9.5px] text-indigo-300/55 shrink-0">乱码？换编码</span>
                                <select value={chosenEncoding} onChange={e => redecode(e.target.value)}
                                    className="flex-1 text-[10px] bg-[#1b2236] text-indigo-100 border border-indigo-300/25 rounded px-1.5 py-1 outline-none">
                                    <option value="auto">自动识别</option>
                                    <option value="utf-8">UTF-8</option>
                                    <option value="gb18030">简体中文 · GB18030 / GBK</option>
                                    <option value="big5">繁体中文 · Big5</option>
                                    <option value="shift_jis">日文 · Shift_JIS</option>
                                    <option value="euc-jp">日文 · EUC-JP</option>
                                </select>
                            </div>
                        )}
                    </div>
                ) : (
                    <button onClick={() => fileRef.current?.click()}
                        className="w-full rounded-xl border border-dashed border-indigo-300/40 py-3 mb-3 text-[12.5px] text-indigo-100/90 flex items-center justify-center gap-2 active:bg-white/5">
                        <UploadSimple size={16} weight="bold" /> 选择 .txt / .pdf 文件（大文件也 OK）
                    </button>
                )}

                <div className="space-y-2.5">
                    <input value={title} onChange={e => setTitle(e.target.value)} placeholder="书名（必填）" className={`${uploadFieldClass} text-[13px]`} />
                    <input value={author} onChange={e => setAuthor(e.target.value)} placeholder="作者（选填）" className={`${uploadFieldClass} text-[13px]`} />
                    <input value={summary} onChange={e => setSummary(e.target.value)} placeholder="一句话简介（选填，喂给角色当背景）" className={`${uploadFieldClass} text-[13px]`} />
                    {!fileInfo && (
                        <>
                            <div className="text-[10px] text-indigo-300/50">或直接粘贴正文（小段文本用；大文件请走上面的文件选择）↓</div>
                            <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} placeholder="粘贴正文…" rows={6}
                                className={`${uploadFieldClass} text-[12.5px] leading-relaxed`} />
                        </>
                    )}
                    <div className="text-[10px] text-indigo-300/50">{totalChars.toLocaleString()} 字</div>
                </div>

                {busy ? (
                    <div className="mt-3">
                        <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                            <div className="h-full rounded-full transition-all" style={{ width: `${progress}%`, background: 'linear-gradient(90deg,#8b7bf0,#b06ad6)' }} />
                        </div>
                        <div className="text-[11px] text-indigo-200/70 text-center mt-1.5">处理中… {progress}%（大文件需要点时间）</div>
                    </div>
                ) : (
                    <button onClick={handleSave} disabled={!canSave}
                        className="w-full mt-3 rounded-xl py-2.5 text-[13px] font-bold text-white disabled:opacity-40" style={{ background: 'linear-gradient(120deg, rgba(150,168,255,.92), rgba(188,168,255,.85) 55%, rgba(150,212,204,.9))' }}>
                        上架到书库
                    </button>
                )}
            </div>
        </div>
    );
};

// ============ chibi 形象编辑器（复用特别时光的捏人系统） ============
type ChibiSave = { img: string; state?: any; scale: number; offsetY: number; flip: boolean };
const ChibiEditor: React.FC<{
    char: CharacterProfile;
    onClose: () => void;
    onSave: (chibi: ChibiSave) => void;
}> = ({ char, onClose, onSave }) => {
    const existing = char.vrState?.chibi;
    // 已捏过的：进入"预览 + 微调"页；点"重新捏"再开捏人器。没捏过：直接进捏人器。
    const [creating, setCreating] = useState<boolean>(!existing?.img);
    const [img, setImg] = useState<string>(existing?.img || '');
    const [state, setState] = useState<any>(existing?.state);
    const [scale, setScale] = useState<number>(existing?.scale ?? 1);
    const [offsetY, setOffsetY] = useState<number>(existing?.offsetY ?? 0);
    const [flip, setFlip] = useState<boolean>(!!existing?.flip);

    const isSully = (char.name || '').toLowerCase().includes('sully');
    // 回填：捏人器 init 读 presets（扁平 map），用上次导出的 state.selected
    const presets = existing?.state?.selected || (isSully ? { skin: 'skin_1', fronthair: 'fronthair_99', eyes: 'eyes_99' } : undefined);

    const onConfirm = (r: ChibiResult) => {
        setImg(r.transparentDataUrl);
        setState(r.state);
        setScale(1); setOffsetY(0); setFlip(false);
        setCreating(false);
    };

    if (creating) {
        return (
            <div className="fixed inset-0 z-[60] flex flex-col bg-black">
                <div className="flex items-center gap-2 px-4 pb-2 shrink-0 text-white" style={{ background: 'linear-gradient(180deg,#161c2e 0%,#0c1019 100%)', paddingTop: VR_TOP }}>
                    <button onClick={() => existing?.img ? setCreating(false) : onClose()} className="p-1.5 -ml-1.5 rounded-full active:bg-white/10"><CaretLeft size={20} weight="bold" /></button>
                    <span className="text-[14px] font-bold">捏 {char.name} 的小人</span>
                </div>
                <div className="flex-1 min-h-0">
                    <CreatorIframe mode="char" charName={char.name} isSully={isSully} presets={presets}
                        savedState={existing?.state}
                        draftKey={`vr_${char.id}`} title={`捏一个小人 · ${char.name}`} subtitle="彼方 · CHIBI"
                        onConfirm={onConfirm} />
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55" onClick={onClose}>
            <VRStyleTag />
            <div className="w-full max-w-md rounded-t-2xl p-4" style={{ background: 'linear-gradient(180deg,#161c2e 0%,#0c1019 100%)', paddingBottom: vrBottomPad('1rem') }} onClick={e => e.stopPropagation()}>
                <div className="flex items-center mb-1">
                    <span className="text-[15px] font-bold text-white">{char.name} 的彼方形象</span>
                    <button onClick={onClose} className="ml-auto p-1 text-indigo-300/60"><X size={18} /></button>
                </div>
                <p className="text-[10.5px] text-indigo-300/60 mb-3">这个 Q 版小人会站在彼方的房间里。可以重新捏，或微调站位。</p>

                <div className="relative rounded-xl h-48 overflow-hidden mb-3 flex items-end justify-center" style={{ background: 'linear-gradient(180deg,#2a2350,#15132b)' }}>
                    <div className="absolute inset-0 opacity-50" style={{ backgroundImage: 'radial-gradient(1.5px 1.5px at 30% 30%, rgba(255,255,255,.5), transparent), radial-gradient(1.5px 1.5px at 70% 50%, rgba(200,220,255,.4), transparent)' }} />
                    {img && <TokenImg value={img} alt="" className="object-contain mb-3" style={{ height: 140 * scale, transform: `scaleX(${flip ? -1 : 1}) translateY(${offsetY}px)`, filter: 'drop-shadow(0 4px 8px rgba(0,0,0,.5))', animation: 'vrfloat 3.2s ease-in-out infinite' }} />}
                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-[50%]" style={{ width: 76, height: 17, background: 'radial-gradient(ellipse,rgba(0,0,0,.5),transparent)' }} />
                </div>

                <button onClick={() => setCreating(true)} className="w-full rounded-lg border border-indigo-300/40 py-2 mb-3 text-[12px] text-indigo-100 flex items-center justify-center gap-1.5 active:bg-white/5">
                    <PencilSimple size={14} weight="bold" /> 重新捏小人
                </button>

                <div className="space-y-2.5 mb-3">
                    <label className="flex items-center gap-2 text-[11px] text-indigo-200/80">
                        <UploadSimple size={14} className="rotate-90" /> 大小
                        <input type="range" min={0.5} max={1.6} step={0.05} value={scale} onChange={e => setScale(Number(e.target.value))} className="flex-1 accent-indigo-400" />
                    </label>
                    <button onClick={() => setFlip(f => !f)} className={`text-[11px] rounded-full px-3 py-1 flex items-center gap-1.5 ${flip ? 'bg-indigo-400 text-white' : 'bg-white/10 text-indigo-200/80'}`}>
                        <FlipHorizontal size={13} /> 水平翻转
                    </button>
                </div>

                <button onClick={() => { if (img) onSave({ img, state, scale, offsetY, flip }); }} disabled={!img}
                    className="w-full rounded-xl py-2.5 text-[13px] font-bold text-white disabled:opacity-40" style={{ background: 'linear-gradient(120deg, rgba(150,168,255,.92), rgba(188,168,255,.85) 55%, rgba(150,212,204,.9))' }}>
                    保存形象{char.vrState?.enabled ? '' : ' 并接入'}
                </button>
            </div>
        </div>
    );
};

// ============ 用户本人捏 chibi（mode="user"，结构同角色 chibi） ============
const UserChibiEditor: React.FC<{
    userName: string;
    existing?: { img: string; state?: any; scale?: number; offsetY?: number; flip?: boolean };
    onClose: () => void;
    onSave: (chibi: ChibiSave) => void;
}> = ({ userName, existing, onClose, onSave }) => {
    const [creating, setCreating] = useState<boolean>(!existing?.img);
    const [img, setImg] = useState<string>(existing?.img || '');
    const [state, setState] = useState<any>(existing?.state);
    const [scale, setScale] = useState<number>(existing?.scale ?? 1);
    const [offsetY, setOffsetY] = useState<number>(existing?.offsetY ?? 0);
    const [flip, setFlip] = useState<boolean>(!!existing?.flip);
    const presets = existing?.state?.selected;

    const onConfirm = (r: ChibiResult) => {
        setImg(r.transparentDataUrl); setState(r.state);
        setScale(1); setOffsetY(0); setFlip(false); setCreating(false);
    };

    if (creating) {
        return (
            <div className="fixed inset-0 z-[60] flex flex-col bg-black" style={{ paddingTop: VR_TOP }}>
                <CreatorIframe mode="user" charName={userName} presets={presets}
                    savedState={existing?.state}
                    draftKey="vr_user" title={`捏一个你自己 · ${userName}`} subtitle="彼方 · 你的 CHIBI"
                    onConfirm={onConfirm} />
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55" onClick={onClose}>
            <div className="w-full max-w-md rounded-t-2xl p-4" style={{ background: 'linear-gradient(180deg,#161c2e 0%,#0c1019 100%)', paddingBottom: vrBottomPad('1rem') }} onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-2 mb-2">
                    <span className="text-[15px] font-bold text-white">你的彼方形象</span>
                    <button onClick={onClose} className="ml-auto p-1 text-indigo-300/60"><X size={18} /></button>
                </div>
                <p className="text-[10.5px] text-indigo-300/60 mb-3">这个 Q 版小人就是「你」在彼方里的化身，会站在你挂着的房间里。</p>
                <div className="relative rounded-xl h-48 overflow-hidden mb-3 flex items-end justify-center" style={{ background: 'linear-gradient(180deg,#2a2350,#15132b)' }}>
                    {img && <TokenImg value={img} alt="" className="object-contain mb-3" style={{ height: 140 * scale, transform: `scaleX(${flip ? -1 : 1}) translateY(${offsetY}px)`, filter: 'drop-shadow(0 4px 8px rgba(0,0,0,.5))', animation: 'vrfloat 3.2s ease-in-out infinite' }} />}
                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-[50%]" style={{ width: 76, height: 17, background: 'radial-gradient(ellipse,rgba(0,0,0,.5),transparent)' }} />
                </div>
                <button onClick={() => setCreating(true)} className="w-full rounded-lg border border-indigo-300/40 py-2 mb-3 text-[12px] text-indigo-100 flex items-center justify-center gap-1.5 active:bg-white/5">
                    <PencilSimple size={14} weight="bold" /> 重新捏小人
                </button>
                <div className="space-y-2.5 mb-3">
                    <label className="flex items-center gap-2 text-[11px] text-indigo-200/80">
                        <UploadSimple size={14} className="rotate-90" /> 大小
                        <input type="range" min={0.5} max={1.6} step={0.05} value={scale} onChange={e => setScale(Number(e.target.value))} className="flex-1 accent-indigo-400" />
                    </label>
                    <button onClick={() => setFlip(f => !f)} className={`text-[11px] rounded-full px-3 py-1 flex items-center gap-1.5 ${flip ? 'bg-indigo-400 text-white' : 'bg-white/10 text-indigo-200/80'}`}>
                        <FlipHorizontal size={13} /> 水平翻转
                    </button>
                </div>
                <button onClick={() => { if (img) onSave({ img, state, scale, offsetY, flip }); }} disabled={!img}
                    className="w-full rounded-xl py-2.5 text-[13px] font-bold text-white disabled:opacity-40" style={{ background: 'linear-gradient(120deg, rgba(150,168,255,.92), rgba(188,168,255,.85) 55%, rgba(150,212,204,.9))' }}>
                    保存形象
                </button>
            </div>
        </div>
    );
};

// ============ 用户本人接入彼方面板（捏 chibi / 选房间 / 写在干嘛 / 广播） ============
const USER_VR_PRESETS = ['在看小说', '在自习 / 刷题', '在听歌单曲循环', '单纯挂机放空', '在娱乐室瞎玩', '在写漂流信'];
const UserVRPanel: React.FC<{
    userProfile?: UserProfile;
    updateUserProfile: (u: Partial<UserProfile>) => void;
    onEditChibi: () => void;
    onBroadcast: (room: VRRoomId, activity: string) => Promise<void> | void;
    addToast?: (m: string, t?: any) => void;
}> = ({ userProfile, updateUserProfile, onEditChibi, onBroadcast, addToast }) => {
    const uv = userProfile?.vrState;
    const enabled = !!uv?.enabled;
    const chibi = uv?.chibi;
    const [room, setRoom] = useState<VRRoomId>(uv?.currentRoom || 'guestbook');
    const [activity, setActivity] = useState(uv?.activity || '');

    // userProfile 外部变化（如刚捏完 chibi）时同步本地草稿
    useEffect(() => { setRoom(uv?.currentRoom || 'guestbook'); setActivity(uv?.activity || ''); }, [uv?.currentRoom, uv?.activity]);

    const ROOMS: [VRRoomId, string][] = [['library', '图书馆'], ['music', '听歌房'], ['guestbook', '留言簿'], ['gym', '娱乐室'], ['postoffice', '邮局'], ['sar', 'SAR 活动空间']];

    const join = () => {
        if (!chibi?.img) { onEditChibi(); return; } // 没捏小人 → 先捏，再回来开接入
        updateUserProfile({ vrState: { ...(uv || {}), enabled: true, currentRoom: room, activity: activity.trim(), updatedAt: Date.now() } });
        addToast?.('你已接入彼方', 'success');
        trackEvent('开启用户本人接入彼方', { action: 'enable' });
    };
    const logout = () => {
        updateUserProfile({ vrState: { ...(uv || {}), enabled: false } });
        addToast?.('已从彼方登出', 'success'); // 登出后角色聊天里的"你在彼方"提示随之消失
        trackEvent('开启用户本人接入彼方', { action: 'disable' });
    };
    const saveBroadcast = () => {
        updateUserProfile({ vrState: { ...(uv || {}), enabled: true, currentRoom: room, activity: activity.trim(), updatedAt: Date.now() } });
        void onBroadcast(room, activity.trim());
    };

    return (
        <div className="rounded-2xl p-3.5 backdrop-blur-sm" style={{ background: 'linear-gradient(135deg, rgba(120,130,255,0.10), rgba(150,212,204,0.06))', border: '1px solid rgba(150,168,255,0.22)' }}>
            <div className="flex items-center gap-2.5">
                <button onClick={onEditChibi} className="relative h-12 w-12 rounded-xl overflow-hidden bg-black/20 flex items-end justify-center shrink-0 active:opacity-80">
                    {chibi?.img ? <TokenImg value={chibi.img} className="h-11 object-contain object-bottom" style={{ transform: `scaleX(${chibi.flip ? -1 : 1})` }} alt="" /> : <span className="text-lg text-indigo-300/60 mb-2">＋</span>}
                    <span className="absolute bottom-0 right-0 bg-indigo-500/90 rounded-tl-md p-0.5"><PencilSimple size={9} weight="bold" /></span>
                </button>
                <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-bold text-white truncate">你自己 · {userProfile?.name || '我'}</div>
                    <div className="text-[10px] text-indigo-300/60">{enabled ? '已接入彼方 · 角色能看到你在这儿' : chibi?.img ? '已捏形象 · 未接入' : '捏个自己的小人，接入彼方'}</div>
                </div>
                <button onClick={enabled ? logout : join}
                    className={`relative w-11 h-6 rounded-full transition-colors ${enabled ? 'bg-indigo-400' : 'bg-white/15'}`}>
                    <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : ''}`} />
                </button>
            </div>
            {enabled && (
                <>
                    <div className="mt-3 text-[10px] tracking-[0.2em] text-indigo-200/55 mb-1.5">你挂在哪个房间</div>
                    <div className="flex flex-wrap gap-1.5">
                        {ROOMS.map(([rid, label]) => (
                            <button key={rid} onClick={() => setRoom(rid)}
                                className={`text-[10.5px] rounded-full px-2.5 py-1 font-semibold ${room === rid ? 'bg-indigo-400 text-white' : 'bg-white/10 text-indigo-200/70'}`}>
                                {label}
                            </button>
                        ))}
                    </div>
                    <div className="mt-3 text-[10px] tracking-[0.2em] text-indigo-200/55 mb-1.5">你在干嘛（角色会看到）</div>
                    <input value={activity} onChange={e => setActivity(e.target.value)}
                        placeholder="例：在看小说 / 在自习 / 单纯挂机…"
                        className="w-full rounded-lg px-3 py-2 text-[12.5px] text-white placeholder-white/30 outline-none" style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(150,200,255,.2)' }} />
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {USER_VR_PRESETS.map(p => (
                            <button key={p} onClick={() => setActivity(p)} className="text-[10px] rounded-full px-2 py-0.5 bg-white/[0.08] text-indigo-200/60 active:bg-white/15">{p}</button>
                        ))}
                    </div>
                    <button onClick={saveBroadcast}
                        className="mt-3 w-full rounded-xl py-2 text-[12.5px] font-bold text-white" style={{ background: 'linear-gradient(120deg, rgba(150,168,255,.92), rgba(188,168,255,.85) 55%, rgba(150,212,204,.9))' }}>
                        保存并广播给所有角色
                    </button>
                    <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-white/10 bg-black/10 px-3 py-2.5">
                        <ShieldCheck size={17} weight={uv?.allowCharacterModules ? 'fill' : 'regular'} className={uv?.allowCharacterModules ? 'text-emerald-200' : 'text-indigo-200/45'} />
                        <div className="min-w-0 flex-1">
                            <div className="text-[11px] font-semibold text-white/80">允许角色对我使用模块</div>
                            <div className="mt-0.5 text-[9px] leading-relaxed text-indigo-200/40">默认关闭；仅在你与角色同时位于 SAR 时可能触发，持续 5 次成功互动。</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={uv?.allowCharacterModules === true}
                            aria-label="允许角色对我使用模块"
                            onClick={() => updateUserProfile({ vrState: { ...(uv || {}), allowCharacterModules: uv?.allowCharacterModules !== true } })}
                            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${uv?.allowCharacterModules ? 'bg-emerald-400/75' : 'bg-white/15'}`}
                        >
                            <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${uv?.allowCharacterModules ? 'translate-x-5' : ''}`} />
                        </button>
                    </div>
                    {uv?.sarModule && (
                        <div className="mt-2 rounded-lg border border-emerald-200/15 bg-emerald-300/[0.06] px-3 py-2 text-[9.5px] text-emerald-100/65">
                            你身上的模块：{uv.sarModule.moduleTitle} · {uv.sarModule.phase === 'active'
                                ? `剩余 ${uv.sarModule.remainingTurns}/${uv.sarModule.totalTurns} 次`
                                : `退场稳定 ${uv.sarModule.afterglowTurns}/3`}
                        </div>
                    )}
                    <p className="text-[9.5px] text-indigo-300/45 mt-2 leading-relaxed">角色聊天里会知道"你此刻在彼方做什么"，但已明确告知 ta：这只是虚拟空间挂机、你本人不一定在线，一切以聊天记录为准。</p>
                </>
            )}
        </div>
    );
};

// ============ 接入设置 ============
const INTERVAL_OPTIONS = [60, 120, 180, 360, 720];

const NovelPreferenceModal: React.FC<{
    char: CharacterProfile;
    novels: VRWorldNovel[];
    onSave: (novelIds: string[]) => void;
    onClose: () => void;
}> = ({ char, novels, onSave, onClose }) => {
    const validNovelIds = useMemo(() => new Set(novels.map(novel => novel.id)), [novels]);
    const [selected, setSelected] = useState<Set<string>>(() => new Set(
        (char.vrState?.preferredNovelIds || []).filter(id => validNovelIds.has(id)),
    ));
    const [query, setQuery] = useState('');
    const [page, setPage] = useState(0);
    const pageSize = 18;

    useEffect(() => {
        setSelected(new Set((char.vrState?.preferredNovelIds || []).filter(id => validNovelIds.has(id))));
        setQuery('');
        setPage(0);
    }, [char.id, validNovelIds]);

    const filtered = useMemo(() => {
        const needle = query.trim().toLocaleLowerCase();
        if (!needle) return novels;
        return novels.filter(novel => `${novel.title}\n${novel.author || ''}`.toLocaleLowerCase().includes(needle));
    }, [novels, query]);
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const currentPage = Math.min(page, pageCount - 1);
    const visible = filtered.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

    const toggle = (novelId: string) => {
        setSelected(current => {
            const next = new Set(current);
            if (next.has(novelId)) next.delete(novelId);
            else next.add(novelId);
            return next;
        });
    };

    return (
        <div className="fixed inset-0 z-[340] flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
            <div
                className="flex h-[min(86dvh,760px)] w-full max-w-md flex-col overflow-hidden rounded-t-[28px]"
                style={{ background: 'linear-gradient(180deg,#1d1a31,#0f0d1c)', border: '1px solid rgba(255,255,255,.12)', paddingBottom: vrBottomPad('0px') }}
                onClick={event => event.stopPropagation()}
            >
                <header className="shrink-0 px-4 pt-4 pb-3 border-b border-white/10">
                    <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                            <h2 className="text-[15px] font-bold text-white">{char.name} 的阅读偏好</h2>
                            <p className="mt-1 text-[10.5px] leading-4 text-indigo-200/55">
                                不选择就是全书库自动轮换；选中后优先在这些书里轮换。
                            </p>
                        </div>
                        <button type="button" onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-white/55 active:bg-white/10" aria-label="关闭阅读偏好">
                            <X size={18} />
                        </button>
                    </div>
                    <label className="mt-3 flex h-10 items-center gap-2 rounded-xl bg-white/[0.07] px-3 text-indigo-100/60 ring-1 ring-white/10 focus-within:ring-indigo-300/45">
                        <MagnifyingGlass size={15} />
                        <input
                            value={query}
                            onChange={event => { setQuery(event.target.value); setPage(0); }}
                            placeholder={`搜索 ${novels.length.toLocaleString()} 本小说`}
                            className="min-w-0 flex-1 bg-transparent text-[12px] text-white outline-none placeholder:text-indigo-200/30"
                        />
                    </label>
                    <div className="mt-2 flex items-center justify-between text-[10px] text-indigo-200/45">
                        <span>{selected.size > 0 ? `已优先 ${selected.size} 本` : '当前：自动轮换全部小说'}</span>
                        {query && <span>找到 {filtered.length.toLocaleString()} 本</span>}
                    </div>
                </header>

                <main className="vr-reader-scroll min-h-0 flex-1 overflow-y-auto px-4 py-1">
                    {visible.length === 0 ? (
                        <div className="grid h-40 place-items-center text-[11px] text-indigo-200/35">没有找到这本书</div>
                    ) : visible.map(novel => {
                        const active = selected.has(novel.id);
                        const bookmark = getBookmark(char.vrState?.novelBookmarks, novel.id);
                        const progress = Math.min(100, Math.round(bookmark / Math.max(1, novel.segments.length) * 100));
                        return (
                            <button
                                type="button"
                                key={novel.id}
                                onClick={() => toggle(novel.id)}
                                aria-pressed={active}
                                className="flex w-full items-center gap-3 border-b border-white/[0.07] py-3 text-left active:bg-white/[0.04]"
                            >
                                <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border text-white transition-colors ${active ? 'border-indigo-400 bg-indigo-400' : 'border-white/20 bg-white/[0.03]'}`}>
                                    {active && <Check size={12} weight="bold" />}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[12.5px] font-semibold text-white/90">{novel.title}</span>
                                    <span className="mt-0.5 block truncate text-[9.5px] text-indigo-200/40">
                                        {novel.author ? `${novel.author} · ` : ''}{novel.segments.length.toLocaleString()} 段{bookmark > 0 ? ` · ${progress}%` : ''}
                                    </span>
                                </span>
                            </button>
                        );
                    })}
                </main>

                <footer className="shrink-0 border-t border-white/10 px-4 pt-3">
                    {pageCount > 1 && (
                        <div className="mb-3 flex items-center justify-center gap-4 text-[10px] text-indigo-100/55">
                            <button type="button" onClick={() => setPage(value => Math.max(0, value - 1))} disabled={currentPage === 0} className="grid h-8 w-8 place-items-center rounded-full bg-white/[0.06] disabled:opacity-25" aria-label="上一页"><CaretLeft size={13} weight="bold" /></button>
                            <span className="tabular-nums">{currentPage + 1} / {pageCount}</span>
                            <button type="button" onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))} disabled={currentPage >= pageCount - 1} className="grid h-8 w-8 place-items-center rounded-full bg-white/[0.06] disabled:opacity-25" aria-label="下一页"><CaretRight size={13} weight="bold" /></button>
                        </div>
                    )}
                    <div className="flex gap-2">
                        <button type="button" onClick={() => setSelected(new Set())} disabled={selected.size === 0} className="flex-1 rounded-xl border border-white/15 py-2.5 text-[12px] text-white/65 disabled:opacity-30">恢复自动轮换</button>
                        <button type="button" onClick={() => onSave(Array.from(selected))} className="flex-1 rounded-xl py-2.5 text-[12px] font-bold text-white" style={{ background: 'linear-gradient(120deg,rgba(128,145,245,.95),rgba(171,142,235,.95))' }}>保存偏好</button>
                    </div>
                </footer>
            </div>
        </div>
    );
};

const SettingsView: React.FC<{
    characters: CharacterProfile[];
    updateCharacter: (id: string, updates: Partial<CharacterProfile>) => void;
    addToast?: (msg: string, type?: any) => void;
    novels: VRWorldNovel[]; onReload: () => void;
    onRequestEnable: (char: CharacterProfile) => void;
    onEditChibi: (char: CharacterProfile) => void;
    onEditReadingPreference: (char: CharacterProfile) => void;
    sarNpcEnabled: boolean;
    sarCaianMet: boolean;
    onChangeSarNpc: (preference: SARNpcPreference) => void;
    onRequestSarRewind: () => void;
}> = ({ characters, updateCharacter, addToast, novels, onReload, onRequestEnable, onEditChibi, onEditReadingPreference, sarNpcEnabled, sarCaianMet, onChangeSarNpc, onRequestSarRewind }) => {
    const [pickFor, setPickFor] = useState<CharacterProfile | null>(null);
    // 接入列表的分组筛选（characters 由 props 传入，这里单独取 characterGroups 即可）
    const { characterGroups } = useOS();
    const [settingsGroupId, setSettingsGroupId] = useState<string>(GROUP_FILTER_ALL);
    const novelCount = novels.length;
    const validNovelIds = useMemo(() => new Set(novels.map(novel => novel.id)), [novels]);
    const go = (room?: VRRoomId) => {
        if (!pickFor) return;
        VRScheduler.triggerNow(pickFor.id, room);
        addToast?.(`${pickFor.name} 正在登入彼方…`, 'info');
        setTimeout(onReload, 4000);
        setPickFor(null);
    };

    const disable = (char: CharacterProfile) => {
        updateCharacter(char.id, { vrState: { ...(char.vrState || { intervalMinutes: VR_DEFAULT_INTERVAL_MIN }), enabled: false } as any });
        VRScheduler.stop(char.id);
        trackEvent('开启角色接入彼方', { action: 'disable' });
    };
    const setInterval = (char: CharacterProfile, minutes: number) => {
        updateCharacter(char.id, { vrState: { ...(char.vrState || {}), enabled: char.vrState?.enabled ?? true, intervalMinutes: minutes } });
        if (char.vrState?.enabled) VRScheduler.start(char.id, minutes);
    };

    return (
        <div className="space-y-3">
            <div className="rounded-2xl p-3.5" style={{ background: 'rgba(255,255,255,.045)', border: '1px solid rgba(255,255,255,.075)' }}>
                <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-semibold text-white/90">活动空间 NPC</div>
                        <p className="mt-0.5 text-[10px] leading-relaxed text-indigo-200/48">显示凯恩、艾文与固定剧情。关闭不会影响活动空间功能。</p>
                    </div>
                    <button type="button" onClick={() => onChangeSarNpc(sarNpcEnabled ? 'hide' : 'show')} aria-label={sarNpcEnabled ? '隐藏活动空间 NPC' : '显示活动空间 NPC'} aria-pressed={sarNpcEnabled}
                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${sarNpcEnabled ? 'bg-indigo-400' : 'bg-white/15'}`}>
                        <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${sarNpcEnabled ? 'translate-x-5' : ''}`} />
                    </button>
                </div>
                <div className="mt-3 flex items-center gap-3 border-t border-white/[0.07] pt-3">
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-white/78"><Clock size={13} />剧情回档</div>
                        <p className="mt-0.5 text-[9.5px] leading-relaxed text-indigo-200/40">重置凯恩初次见面，用其他选择再走一次。</p>
                    </div>
                    <button type="button" onClick={onRequestSarRewind} disabled={!sarCaianMet}
                        className="shrink-0 rounded-full px-3 py-1.5 text-[10px] font-semibold text-indigo-100 disabled:cursor-not-allowed disabled:opacity-30 active:bg-white/10"
                        style={{ background: 'rgba(129,140,248,.12)', border: '1px solid rgba(165,180,252,.2)' }}>
                        {sarCaianMet ? '回到初见前' : '剧情未完成'}
                    </button>
                </div>
            </div>
            <p className="text-[11px] text-indigo-300/60 leading-relaxed">
                启用后，角色会按设定的间隔自己登入「彼方」自由活动：读书写批注、逛公共房间，也可能进入 SAR 给别人装两枚随机芯片并留下自己的随笔。每次活动会在 ta 的聊天里留下动态卡片，也会被记忆总结捕捉。
                连着 {VR_FAIL_LIMIT} 次调不通模型（比如 API 令牌失效了）会自动暂停这个角色，不会一直空跑下去。
                {novelCount === 0 && <span className="text-amber-300/80"> 书库还空着，先去「书库」上传一本。</span>}
            </p>
            {characters.length === 0 && <p className="text-[11px] text-indigo-300/50 py-4 text-center">还没有角色。</p>}
            {/* 分组筛选（没建分组时不渲染）：深色底 */}
            <CharacterGroupFilterBar characters={characters} groups={characterGroups} dark
                value={settingsGroupId} onChange={setSettingsGroupId} />
            {characters.length > 0 && filterCharactersByGroup(characters, characterGroups, settingsGroupId).length === 0 &&
                <p className="text-[11px] text-indigo-300/50 py-4 text-center">该分组下没有角色</p>}
            {filterCharactersByGroup(characters, characterGroups, settingsGroupId).map(char => {
                const st = char.vrState;
                const enabled = !!st?.enabled;
                const interval = st?.intervalMinutes || VR_DEFAULT_INTERVAL_MIN;
                const chibi = getChibi(char);
                const failStreak = VRScheduler.getFailStreak(char.id);
                const preferredNovelCount = (st?.preferredNovelIds || []).filter(id => validNovelIds.has(id)).length;
                return (
                    <div key={char.id} className="rounded-2xl p-3.5 backdrop-blur-sm" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.07)' }}>
                        <div className="flex items-center gap-2.5">
                            {/* chibi 缩略 */}
                            <button onClick={() => onEditChibi(char)} className="relative h-12 w-12 rounded-xl overflow-hidden bg-black/20 flex items-end justify-center shrink-0 active:opacity-80">
                                {chibi.img ? <TokenImg value={chibi.img} className="h-11 object-contain object-bottom" style={{ transform: `scaleX(${chibi.flip ? -1 : 1})` }} alt="" /> : <span className="text-lg text-indigo-300/60 mb-2">？</span>}
                                <span className="absolute bottom-0 right-0 bg-indigo-500/90 rounded-tl-md p-0.5"><PencilSimple size={9} weight="bold" /></span>
                            </button>
                            <div className="flex-1 min-w-0">
                                <div className="text-[13px] font-bold truncate">{char.name}</div>
                                {enabled ? (
                                    <div className="text-[10px] text-indigo-300/60">
                                        每 {interval >= 60 ? `${formatHours(interval)} 小时` : `${interval} 分`}登入一次
                                        {st?.sarModule && <span className="text-emerald-200/70"> · {st.sarModule.moduleTitle} {st.sarModule.phase === 'active' ? `${st.sarModule.remainingTurns}/${st.sarModule.totalTurns}` : `稳定 ${st.sarModule.afterglowTurns}/3`}</span>}
                                        {/* 后台失败本来一点声响都没有，攒到熔断前先让用户看见 */}
                                        {failStreak > 0 && <span className="text-amber-300/80"> · 已连续 {failStreak} 次没调通</span>}
                                    </div>
                                ) : <div className="text-[10px] text-indigo-300/40">{chibi.isFallback ? '未设形象 · 未接入' : '未接入'}</div>}
                            </div>
                            <button onClick={() => enabled ? disable(char) : onRequestEnable(char)}
                                className={`relative w-11 h-6 rounded-full transition-colors ${enabled ? 'bg-indigo-400' : 'bg-white/15'}`}>
                                <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : ''}`} />
                            </button>
                        </div>
                        {enabled && (
                            <>
                                <div className="flex flex-wrap gap-1.5 mt-2.5">
                                    {INTERVAL_OPTIONS.map(opt => (
                                        <button key={opt} onClick={() => setInterval(char, opt)}
                                            className={`text-[10.5px] rounded-full px-2.5 py-1 font-semibold ${interval === opt ? 'bg-indigo-400 text-white' : 'bg-white/10 text-indigo-200/70'}`}>
                                            {opt >= 60 ? `${formatHours(opt)}h` : `${opt}min`}
                                        </button>
                                    ))}
                                </div>
                                <button onClick={() => setPickFor(char)}
                                    className="mt-2.5 text-[11px] text-amber-200 font-semibold flex items-center gap-1 active:opacity-70">
                                    <Play size={12} weight="fill" /> 让 ta 现在去逛一次
                                </button>
                            </>
                        )}
                        {novelCount > 0 && (
                            <button onClick={() => onEditReadingPreference(char)}
                                className="mt-2.5 flex w-full items-center gap-2 border-t border-white/[0.07] pt-2.5 text-left active:opacity-70">
                                <BookOpen size={13} weight="fill" className="text-indigo-200/70" />
                                <span className="text-[11px] font-semibold text-indigo-100/75">阅读偏好</span>
                                <span className="ml-auto text-[10px] text-indigo-300/45">{preferredNovelCount > 0 ? `优先 ${preferredNovelCount} 本` : '自动轮换全部'}</span>
                                <CaretRight size={11} weight="bold" className="text-indigo-300/35" />
                            </button>
                        )}
                    </div>
                );
            })}
            <ActionSheet open={!!pickFor} title={pickFor ? `让 ${pickFor.name} 现在去哪个房间？` : ''}
                actions={[
                    { label: '随机一个房间', onClick: () => go() },
                    ...(novelCount > 0 ? [{ label: '图书馆 · 读书写批注', onClick: () => go('library') }] : []),
                    { label: '剧院 · 写剧本投稿', onClick: () => go('theater') },
                    { label: '听歌房 · 点歌锐评', onClick: () => go('music') },
                    { label: '留言簿 · 发帖版聊', onClick: () => go('guestbook') },
                    { label: '娱乐室 · 放开玩', onClick: () => go('gym') },
                    { label: '邮局 · 写漂流信', onClick: () => go('postoffice') },
                    { label: 'SAR 活动空间 · 抽芯片写随笔', onClick: () => go('sar') },
                    // 信号坠落处不放这里：参与统一走活动 banner → 面板「✍ 参与」，那条路才有「耳语」
                ]} onClose={() => setPickFor(null)} />
        </div>
    );
};

// ============ 彼方 · API 设置 + 调用记录 ============
const VRApiSettings: React.FC<{ apiPresets: ApiPreset[]; chatApi: APIConfig; addToast?: (m: string, t?: any) => void; characters: CharacterProfile[] }> = ({ apiPresets, chatApi, addToast, characters }) => {
    const [vrApi, setVr] = useState<APIConfig | null>(null);
    const [log, setLog] = useState<VRApiCall[]>([]);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<string | null>(null);
    const [presetsOpen, setPresetsOpen] = useState(false);   // 折叠「保存的预设」长列表
    const [snapshot, setSnapshot] = useState<string | null>(null);   // 排障快照正文
    const [collecting, setCollecting] = useState(false);

    useEffect(() => {
        void getVRApi().then(setVr);
        void getVRApiLog().then(setLog);
        const h = () => { void getVRApiLog().then(setLog); };
        window.addEventListener('vr-api-log', h);
        return () => window.removeEventListener('vr-api-log', h);
    }, []);

    const follow = !vrApi?.baseUrl;
    const effective = follow ? chatApi : vrApi!;
    const sameAs = (c: APIConfig) => !follow && vrApi!.baseUrl === c.baseUrl && vrApi!.model === c.model && vrApi!.apiKey === c.apiKey;
    const host = (u?: string) => { try { return u ? new URL(u).host : '—'; } catch { return u || '—'; } };

    const choose = (cfg: APIConfig | null) => {
        void setVRApi(cfg); setVr(cfg); setTestResult(null);
        addToast?.(cfg ? '已切换彼方 API' : '彼方改为跟随聊天默认', 'success');
    };

    const test = async () => {
        const cfg = effective;
        if (!cfg?.baseUrl) { setTestResult('当前没有可用的 API'); return; }
        setTesting(true); setTestResult(null);
        try {
            const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey || 'sk-none'}` },
                body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5, stream: false }),
            });
            if (res.ok) { const d = await safeResponseJson(res); const r = d.choices?.[0]?.message?.content || ''; setTestResult(`连接成功 — 模型回复:"${r.slice(0, 24)}"`); }
            else { const t = await res.text().catch(() => ''); setTestResult(`HTTP ${res.status}: ${t.slice(0, 80)}`); }
        } catch (e: any) { setTestResult(`连接失败: ${e.message}`); } finally { setTesting(false); }
    };

    // 手机上没有控制台，「界面全关了记录还在涨」这类问题光靠截图说不清。
    // 一次把该看的都收齐，复制走即可；收的全是状态，不含名字、聊天和 key。
    const exportSnapshot = async () => {
        setCollecting(true);
        try {
            const text = await collectVRDiagnostics(characters, chatApi);
            setSnapshot(text);
            try {
                await navigator.clipboard.writeText(text);
                addToast?.('排障快照已复制，可以直接粘给开发者', 'success');
            } catch {
                // 剪贴板被浏览器挡住也不算失败——下面把正文摊开，截图一样能用
                addToast?.('快照已生成（这台设备不让自动复制，长按下面的文字选中即可）', 'info');
            }
        } catch (e: any) {
            addToast?.(`收集失败: ${e?.message || e}`, 'error');
        } finally { setCollecting(false); }
    };

    // 日志里混着两种行：真实的模型调用，和「调度动了但没走到模型」的诊断行。
    // 对账只该看前者，把诊断行算进分母会让「成功几次」失真。
    const calls = log.filter(l => !l.kind);
    const okCount = calls.filter(l => l.ok).length;

    return (
        <div className="space-y-3">
            <p className="text-[11px] text-indigo-300/60 leading-relaxed">
                彼方里的角色会自主、按间隔登入触发模型调用，比较费 API。你可以在这里给彼方<b className="text-indigo-200">单独指定一份 API</b>（和「设置」里保存的预设共用同一批），不设则跟随聊天默认。
            </p>

            {/* 当前生效 */}
            <div className="rounded-2xl p-3.5" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div className="text-[10px] tracking-[0.2em] text-indigo-200/60 mb-1.5" style={{ fontFamily: `'Noto Serif SC',serif` }}>当前生效</div>
                <div className="text-[12.5px] text-white/90 font-semibold">{effective?.model || '未配置'}</div>
                <div className="text-[10px] text-white/40 mt-0.5">{host(effective?.baseUrl)} · {follow ? '跟随聊天默认' : '彼方独立'}</div>
                <button onClick={test} disabled={testing} className="mt-2.5 text-[11px] px-3 py-1.5 rounded-full font-semibold disabled:opacity-50"
                    style={{ background: 'rgba(120,180,255,.16)', color: '#bcd4ff', border: '1px solid rgba(140,180,255,.3)' }}>
                    {testing ? '测试中…' : '测试连接'}
                </button>
                {testResult && <div className={`mt-2 text-[10.5px] px-2.5 py-1.5 rounded-lg leading-snug ${testResult.startsWith('连接成功') ? 'text-emerald-300' : 'text-rose-300'}`} style={{ background: 'rgba(0,0,0,.25)' }}>{testResult}</div>}
            </div>

            {/* 选择 API */}
            <div>
                <div className="text-[10px] tracking-[0.2em] text-indigo-200/55 mb-1.5 px-0.5" style={{ fontFamily: `'Noto Serif SC',serif` }}>选择彼方 API</div>
                <button onClick={() => choose(null)}
                    className="w-full flex items-center gap-2 rounded-xl p-3 mb-1.5 text-left active:scale-[0.99] transition-transform"
                    style={{ background: follow ? 'rgba(120,180,255,.12)' : 'rgba(255,255,255,.04)', border: `1px solid ${follow ? 'rgba(140,180,255,.4)' : 'rgba(255,255,255,.07)'}` }}>
                    <div className="flex-1 min-w-0">
                        <div className="text-[12px] text-white/90 font-semibold">跟随聊天默认</div>
                        <div className="text-[10px] text-white/40 truncate">{chatApi?.model || '未配置'} · {host(chatApi?.baseUrl)}</div>
                    </div>
                    {follow && <span className="text-[10px] text-sky-300 font-bold shrink-0">✓ 使用中</span>}
                </button>
                {apiPresets.length === 0 ? (
                    <p className="text-[10.5px] text-white/35 px-1 py-1.5">「设置」里还没有保存的 API 预设。去设置里保存几个模型，这里就能选。</p>
                ) : (() => {
                    const activePreset = apiPresets.find(p => sameAs(p.config));
                    const shown = presetsOpen ? apiPresets : (activePreset ? [activePreset] : []);
                    return (
                        <>
                            <button onClick={() => setPresetsOpen(o => !o)}
                                className="w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 mb-1.5 text-left active:bg-white/5"
                                style={{ border: '1px solid rgba(255,255,255,.07)' }}>
                                <span className="text-[10.5px] text-white/55">保存的预设</span>
                                <span className="text-[9.5px] text-white/35 rounded-full px-1.5 leading-tight" style={{ background: 'rgba(255,255,255,.08)' }}>{apiPresets.length}</span>
                                {!presetsOpen && activePreset && <span className="text-[9.5px] text-sky-300/70 truncate">当前 · {activePreset.name}</span>}
                                <span className="ml-auto text-[10px] text-white/40">{presetsOpen ? '收起' : '展开'}</span>
                            </button>
                            {shown.map(p => {
                                const on = sameAs(p.config);
                                return (
                                    <button key={p.id} onClick={() => choose(p.config)}
                                        className="w-full flex items-center gap-2 rounded-xl p-3 mb-1.5 text-left active:scale-[0.99] transition-transform"
                                        style={{ background: on ? 'rgba(120,180,255,.12)' : 'rgba(255,255,255,.04)', border: `1px solid ${on ? 'rgba(140,180,255,.4)' : 'rgba(255,255,255,.07)'}` }}>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-[12px] text-white/90 font-semibold truncate">{p.name}</div>
                                            <div className="text-[10px] text-white/40 truncate">{p.config.model} · {host(p.config.baseUrl)}</div>
                                        </div>
                                        {on && <span className="text-[10px] text-sky-300 font-bold shrink-0">✓ 使用中</span>}
                                    </button>
                                );
                            })}
                        </>
                    );
                })()}
            </div>

            {/* 调用记录 */}
            <div className="rounded-2xl p-3" style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <div className="flex items-center gap-1.5 mb-2">
                    <span className="text-[10px] tracking-[0.2em] text-indigo-200/60" style={{ fontFamily: `'Noto Serif SC',serif` }}>调用记录</span>
                    <span className="text-[9.5px] text-white/40 rounded-full px-1.5 leading-tight" style={{ background: 'rgba(255,255,255,.08)' }}>{calls.length}{calls.length ? ` · 成功${okCount}` : ''}</span>
                    {log.length > 0 && <button onClick={() => { void clearVRApiLog(); setLog([]); }} className="ml-auto text-[10px] text-white/40 hover:text-rose-300/80">清空</button>}
                </div>
                {log.length === 0 ? (
                    <p className="text-[10.5px] text-white/35 py-2 text-center">还没有调用。角色每次登入彼方触发的模型调用都会记在这里，方便你对账。</p>
                ) : (
                    <div className="space-y-1">
                        {log.slice(0, 60).map((l, i) => {
                            const diag = !!l.kind;   // 诊断行：调度到点了，但这一轮没走到模型
                            return (
                                <div key={i} className="flex items-start gap-2 text-[10.5px] py-1 border-b border-white/5 last:border-0">
                                    <span className={`shrink-0 ${diag ? 'text-amber-400/70' : l.ok ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>{diag ? '◌' : l.ok ? '●' : '○'}</span>
                                    <span className="text-white/75 truncate shrink-0">{l.charName || l.charId?.slice(-4) || '—'}</span>
                                    {diag ? (
                                        <span className="flex-1 min-w-0 text-amber-200/55 leading-snug">{l.note}</span>
                                    ) : (
                                        <>
                                            <span className="text-indigo-300/40 shrink-0">{l.room ? getRoom(l.room as VRRoomId).name : ''}</span>
                                            {/* 接入明明是关的却还是发了请求 —— 这就是「关不掉」的现场，标出来别让它混在红点里 */}
                                            {l.charEnabled === false && <span className="text-rose-300/75 shrink-0">未接入却发了</span>}
                                            <span className="ml-auto text-white/30 shrink-0 tabular-nums">{(l.ms / 1000).toFixed(1)}s</span>
                                        </>
                                    )}
                                    <span className="text-white/35 shrink-0 tabular-nums w-[68px] text-right">{new Date(l.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* 排障快照 */}
            <div className="rounded-2xl p-3" style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-[10px] tracking-[0.2em] text-indigo-200/60" style={{ fontFamily: `'Noto Serif SC',serif` }}>排障快照</span>
                    {snapshot && <button onClick={() => setSnapshot(null)} className="ml-auto text-[10px] text-white/40 hover:text-rose-300/80">收起</button>}
                </div>
                <p className="text-[10.5px] text-white/40 leading-relaxed mb-2">
                    角色明明没接入却还在调用、或者设置改完过一阵又退回去 —— 遇到这类说不清的情况，点一下把当前状态收成一段文字发给开发者。
                    里面只有开关、时间和用量，<b className="text-indigo-200/70">不含角色名字、聊天记录和 API key</b>。
                </p>
                <button onClick={exportSnapshot} disabled={collecting}
                    className="text-[11px] px-3 py-1.5 rounded-full font-semibold disabled:opacity-50"
                    style={{ background: 'rgba(120,180,255,.16)', color: '#bcd4ff', border: '1px solid rgba(140,180,255,.3)' }}>
                    {collecting ? '收集中…' : '生成并复制'}
                </button>
                {snapshot && (
                    <pre className="mt-2.5 max-h-64 overflow-auto text-[9.5px] leading-relaxed text-white/55 whitespace-pre-wrap break-all select-all p-2 rounded-lg"
                        style={{ background: 'rgba(0,0,0,.3)' }}>{snapshot}</pre>
                )}
            </div>
        </div>
    );
};

// ============ 动画关键帧 ============
const VRStyleTag: React.FC = () => (
    <style>{`
        @keyframes vrfloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @keyframes vrwave { from { transform: scaleY(0.5); } to { transform: scaleY(1.05); } }
        @keyframes vrdance { 0%{transform:translateY(0) rotate(-5deg)} 25%{transform:translateY(-9px) rotate(3deg)} 50%{transform:translateY(0) rotate(5deg)} 75%{transform:translateY(-9px) rotate(-3deg)} 100%{transform:translateY(0) rotate(-5deg)} }
        @keyframes vraurora { 0%,100%{transform:translate(0,0) scale(1);opacity:.75} 50%{transform:translate(6%,4%) scale(1.14);opacity:1} }
        @keyframes vrtwinkle { 0%,100%{opacity:.5} 50%{opacity:.85} }
        @keyframes sarquest { 0%,100%{transform:translate(-50%,0)} 50%{transform:translate(-50%,-6px)} }
        /* 信号坠落处 · 电子卫星轨道（纯 transform/opacity，GPU 合成，手机友好） */
        @keyframes sigorbit { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes sigpulse { 0%,100% { transform: scale(1); opacity: .8; } 50% { transform: scale(1.12); opacity: 1; } }
        @keyframes sigblink { 0%,88%,100% { opacity: 0; } 90%,96% { opacity: 1; } }
    `}</style>
);

export default VRWorldApp;
