import React, { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import { useOS } from '../context/OSContext';
import {
    ArrowLeft, Plus, Trash, BookOpen, Planet, Clock, Play, CaretRight, X,
    UploadSimple, PencilSimple, FlipHorizontal, CaretLeft, Sparkle,
    CircleNotch, TextAa, Palette, Pause, MusicNotes, Queue, Question,
} from '@phosphor-icons/react';
import { CreatorIframe, type ChibiResult } from '../components/Like520Event';
import { useMusic, type Song } from '../context/MusicContext';
import { DB } from '../utils/db';
import { VRScheduler } from '../utils/vrWorld/scheduler';
import { VR_ROOMS, getRoom, VR_DEFAULT_INTERVAL_MIN } from '../utils/vrWorld/constants';
import { buildNovelAsync, groupAnnotationsBySeg, getBookmark } from '../utils/vrWorld/novel';
import { decodeTextFile } from '../utils/vrWorld/decodeText';
import { PostOffice, MAX_LETTER_CHARS, exportIdentity, importIdentity, getAdminToken, setAdminToken, type RemoteReply, type RemoteLetterStat, type RemoteAdminLetter } from '../utils/vrWorld/postOffice';
import { getVRApi, setVRApi, getVRApiLog, clearVRApiLog, type VRApiCall } from '../utils/vrWorld/vrApi';
import { safeResponseJson } from '../utils/safeApi';

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
import type { CharacterProfile, VRWorldNovel, VRNovelAnnotation, VRCardMeta, VRRoomId, VRMusicRoomState, CharPlaylistSong, VRGuestbookState, VRGuestbookMessage, VRLetter, ApiPreset, APIConfig } from '../types';

// ============ chibi 形象解析（vrState.chibi → 立绘 → 头像） ============
interface ChibiDisplay { img: string; scale: number; offsetY: number; flip: boolean; isFallback: boolean; }
const getChibi = (char: CharacterProfile): ChibiDisplay => {
    const c = char.vrState?.chibi;
    if (c?.img) return { img: c.img, scale: c.scale ?? 1, offsetY: c.offsetY ?? 0, flip: !!c.flip, isFallback: false };
    const sprites = (char.activeSkinSetId && char.dateSkinSets?.find(s => s.id === char.activeSkinSetId)?.sprites)
        || char.sprites || {};
    const fb = sprites['happy'] || sprites['normal'] || sprites['smile'] || char.avatar || '';
    return { img: fb, scale: 1, offsetY: 0, flip: false, isFallback: true };
};

type Tab = 'world' | 'library' | 'settings' | 'api';

interface FeedItem {
    msgId: number; charId: string; charName: string; avatar: string;
    timestamp: number; meta: VRCardMeta; content: string;
}

// 每个房间的 chibi 站位（百分比坐标，底对齐）
const ROOM_SLOTS: Record<VRRoomId, { x: number; y: number }[]> = {
    library:   [{ x: 24, y: 72 }, { x: 50, y: 78 }, { x: 74, y: 70 }, { x: 38, y: 64 }, { x: 62, y: 64 }],
    music:     [{ x: 30, y: 74 }, { x: 55, y: 78 }, { x: 72, y: 70 }, { x: 45, y: 66 }],
    guestbook: [{ x: 28, y: 76 }, { x: 52, y: 78 }, { x: 73, y: 74 }, { x: 40, y: 68 }],
    gym:       [{ x: 26, y: 74 }, { x: 50, y: 80 }, { x: 74, y: 74 }, { x: 38, y: 66 }, { x: 62, y: 66 }],
    postoffice:[{ x: 28, y: 76 }, { x: 52, y: 78 }, { x: 72, y: 72 }, { x: 42, y: 68 }],
    cafe:      [{ x: 30, y: 74 }, { x: 54, y: 78 }, { x: 70, y: 72 }],
};

const IDLE_QUIPS: Record<VRRoomId, string[]> = {
    library: ['翻着书页…', '这本还挺好看', '嘘，安静', '又是看书的一天'],
    music: ['随节奏轻晃', '这首单曲循环', '戴上耳机', '调一下音量'],
    guestbook: ['写点什么呢', '路过留个名', '看看墙上的话', '嗯…'],
    gym: ['活动一下', '再来一组！', '伸个懒腰', '热身中'],
    postoffice: ['给谁写封信呢', '封口、寄出', '翻翻信格', '写点心里话'],
    cafe: ['', '', '', ''],
};

const VRWorldApp: React.FC = () => {
    const { closeApp, characters, updateCharacter, addToast, registerBackHandler, userProfile, apiPresets, apiConfig } = useOS();
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
    const [showHelp, setShowHelp] = useState(false);
    // 启用流程：设定 chibi 后回调启用
    const [pendingEnable, setPendingEnable] = useState<string | null>(null);

    // 初次进入彼方：自动弹出玩法说明（看过一次后不再自动弹）
    useEffect(() => {
        try {
            if (!localStorage.getItem('vr_help_seen')) {
                setShowHelp(true);
                localStorage.setItem('vr_help_seen', '1');
            }
        } catch { /* ignore */ }
    }, []);

    const loadNovels = useCallback(async () => setNovels(await DB.getVRNovels()), []);
    const loadFeed = useCallback(async () => {
        const items: FeedItem[] = [];
        for (const c of characters) {
            const msgs = await DB.getRecentMessagesByCharId(c.id, 40);
            for (const m of msgs) {
                // 用户在留言簿的发言会广播进每个角色的 vr_card（供 LLM 上下文用），
                // 但它不是"角色自己的动态"——不进动态流，也不当作 chibi 气泡。
                if (m.type === 'vr_card' && m.metadata?.vrCard && !m.metadata?.userBoardPost) {
                    items.push({ msgId: m.id, charId: c.id, charName: c.name, avatar: c.avatar, timestamp: m.timestamp, meta: m.metadata as VRCardMeta, content: m.content });
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
        return map;
    }, [characters]);

    const enabledCount = characters.filter(c => c.vrState?.enabled).length;

    // 返回键：有弹层先关弹层（阅读器/房间/上传/捏人），而不是直接退回桌面
    useEffect(() => registerBackHandler(() => {
        if (chibiEditChar) { setChibiEditChar(null); setPendingEnable(null); return true; }
        if (showUpload) { setShowUpload(false); return true; }
        if (readerJump) { setReaderJump(null); return true; }
        if (readerNovel) { setReaderNovel(null); return true; }
        if (enterRoom) { setEnterRoom(null); return true; }
        return false; // 无弹层 → 交回默认（关闭 App）
    }), [registerBackHandler, chibiEditChar, showUpload, readerJump, readerNovel, enterRoom]);

    // 从动态/批注点回原文：peek 模式打开阅读器跳到该段，不动用户书签
    const jumpToAnnotation = useCallback((novelId: string | undefined, segIdx: number) => {
        if (!novelId) return;
        const n = novels.find(x => x.id === novelId);
        if (n) setReaderJump({ novel: n, seg: segIdx });
    }, [novels]);

    // 用户在留言簿发言：落墙 + 以小卡片广播给所有接入彼方的角色私聊
    const onUserBoardPost = useCallback(async (content: string) => {
        const t = content.trim();
        if (!t) return;
        const board = (await DB.getVRGuestbook()) || { id: 'board', messages: [], updatedAt: Date.now() };
        const id = `gb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        board.messages = [...board.messages, { id, authorId: 'user', authorName: userName, content: t, createdAt: Date.now() }].slice(-200);
        board.updatedAt = Date.now();
        await DB.saveVRGuestbook(board);
        const enabled = characters.filter(c => c.vrState?.enabled);
        for (const c of enabled) {
            await DB.saveMessage({
                charId: c.id, role: 'user', type: 'vr_card',
                content: `「彼方 · 留言簿」${userName} 在留言墙上发了：${t}`,
                metadata: { vrCard: true, room: 'guestbook', userBoardPost: true, activity: `${userName} 在留言墙上发了：${t}`, boardPost: t },
            } as any);
        }
        addToast?.(enabled.length > 0 ? `已留言，并广播给 ${enabled.length} 位接入角色` : '已留言', 'success');
    }, [characters, userName, addToast]);

    const onDeleteFeed = useCallback(async (msgId: number) => {
        await DB.deleteMessage(msgId);
        setFeed(prev => prev.filter(f => f.msgId !== msgId));
    }, []);
    const onClearFeed = useCallback(async () => {
        const ids = feed.map(f => f.msgId);
        if (ids.length === 0) return;
        await DB.deleteMessages(ids);
        setFeed([]);
        addToast?.('已清空彼方动态', 'success');
    }, [feed, addToast]);

    // 启用某角色（带 chibi 设定门槛）
    const enableChar = (char: CharacterProfile) => {
        const interval = char.vrState?.intervalMinutes || VR_DEFAULT_INTERVAL_MIN;
        updateCharacter(char.id, { vrState: { ...(char.vrState || {}), enabled: true, intervalMinutes: interval } });
        VRScheduler.start(char.id, interval);
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
                    <button key={t} onClick={() => setTab(t)} className="relative pb-2 text-[13.5px] tracking-[0.22em] transition-colors"
                        style={{ fontFamily: `'Noto Serif SC',serif`, color: tab === t ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.38)' }}>
                        {label}
                        {tab === t && <span className="absolute -bottom-px left-1/2 -translate-x-1/2 w-5 h-px"
                            style={{ background: 'linear-gradient(90deg,transparent,rgba(205,205,255,.95),transparent)', boxShadow: '0 0 8px rgba(185,185,255,.85)' }} />}
                    </button>
                ))}
                <div className="absolute bottom-0 left-5 right-5 h-px" style={{ background: 'linear-gradient(90deg,transparent,rgba(255,255,255,.09),transparent)' }} />
            </div>

            <div className="relative flex-1 overflow-y-auto vr-reader-scroll px-4 py-4 z-10">
                {loading ? (
                    <div className="text-center text-white/40 text-[13px] tracking-[0.2em] py-12" style={{ fontFamily: `'Noto Serif SC',serif` }}>载入彼方…</div>
                ) : tab === 'world' ? (
                    <WorldView occupantsByRoom={occupantsByRoom} feed={feed} novelCount={novels.length} poBadge={poBadge}
                        onEnterRoom={setEnterRoom} onGoLibrary={() => setTab('library')} onJump={jumpToAnnotation}
                        onDeleteFeed={onDeleteFeed} onClearFeed={onClearFeed} />
                ) : tab === 'library' ? (
                    <LibraryView novels={novels} characters={characters} onOpen={setReaderNovel}
                        onAdd={() => setShowUpload(true)}
                        onDelete={async (id) => { await DB.deleteVRNovel(id); await loadNovels(); addToast?.('已删除', 'success'); }} />
                ) : tab === 'settings' ? (
                    <SettingsView characters={characters} updateCharacter={updateCharacter} addToast={addToast}
                        novelCount={novels.length} onReload={reloadAll}
                        onRequestEnable={requestEnable} onEditChibi={setChibiEditChar} />
                ) : (
                    <VRApiSettings apiPresets={apiPresets} chatApi={apiConfig} addToast={addToast} />
                )}
            </div>

            {/* 进入房间场景 */}
            {enterRoom && (
                <RoomScene roomId={enterRoom} occupants={occupantsByRoom[enterRoom] || []}
                    latestByChar={latestByChar} onClose={() => setEnterRoom(null)} onJump={jumpToAnnotation}
                    characters={characters} userName={userName} onUserBoardPost={onUserBoardPost} addToast={addToast} />
            )}
            {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
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
                        } else {
                            addToast?.('形象已更新', 'success');
                        }
                    }} />
            )}
        </div>
    );
};

// ============ 通用：CSS 房间场景背景 ============
const RoomBackground: React.FC<{ roomId: VRRoomId; className?: string }> = ({ roomId, className }) => {
    // 每个房间的插画底图（托管在 assets 仓库）。统一套一层"彼方"调性处理：
    // 降饱和 + 压暗 + 轻柔化把图推远、弱化清晰度，再叠暗紫色洗 + 底部压暗 + 暗角，
    // 让五个房间是一套风格、且立绘能跳出来。
    const ROOM_BG: Partial<Record<VRRoomId, string>> = {
        library: 'https://raw.githubusercontent.com/qegj567-cloud/SullyOS-assets/main/img/BOOK.png',
        music: 'https://raw.githubusercontent.com/qegj567-cloud/SullyOS-assets/main/img/MUSIC.png',
        guestbook: 'https://raw.githubusercontent.com/qegj567-cloud/SullyOS-assets/main/img/PLAY.jpg',
        postoffice: 'https://raw.githubusercontent.com/qegj567-cloud/SullyOS-assets/main/img/post.png',
        gym: 'https://raw.githubusercontent.com/qegj567-cloud/SullyOS-assets/main/img/ALL.png',
    };
    const bgUrl = ROOM_BG[roomId];
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
        <div className="absolute flex flex-col items-center" style={{ transform: 'translate(-50%, -100%)' }} onClick={onTap}>
            {bubble && (
                <div className="relative mb-1 max-w-[120px] px-2 py-1 rounded-xl bg-white/95 text-stone-700 text-[10px] leading-snug font-medium shadow-[0_3px_10px_rgba(0,0,0,.3)] text-center">
                    {bubble.length > 22 ? bubble.slice(0, 22) + '…' : bubble}
                    <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-white/95 rotate-45" />
                </div>
            )}
            <div className="relative" style={{ animation: `${dance ? 'vrdance 0.9s' : 'vrfloat 3.2s'} ease-in-out infinite`, animationDelay: `${(char.id.charCodeAt(0) % 10) * 0.15}s` }}>
                {c.img ? (
                    <img src={c.img} alt={char.name}
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
        try { await navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
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
                    <div>· 「世界」页的<b>动态</b>长按可删除；满 20 条一页、可翻页。</div>
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

// ============ 世界视图 ============
const WorldView: React.FC<{
    occupantsByRoom: Record<string, CharacterProfile[]>;
    feed: FeedItem[]; novelCount: number;
    poBadge: { toSend: number; toCollect: number };
    onEnterRoom: (r: VRRoomId) => void; onGoLibrary: () => void;
    onJump: (novelId: string | undefined, segIdx: number) => void;
    onDeleteFeed: (msgId: number) => void; onClearFeed: () => void;
}> = ({ occupantsByRoom, feed, novelCount, poBadge, onEnterRoom, onGoLibrary, onJump, onDeleteFeed, onClearFeed }) => {
    const FEED_PER_PAGE = 20;
    const [page, setPage] = useState(0);
    const totalPages = Math.max(1, Math.ceil(feed.length / FEED_PER_PAGE));
    const curPage = Math.min(page, totalPages - 1);
    const shown = feed.slice(curPage * FEED_PER_PAGE, curPage * FEED_PER_PAGE + FEED_PER_PAGE);
    const [confirmDel, setConfirmDel] = useState<FeedItem | null>(null);
    return (
    <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
            {VR_ROOMS.map(room => {
                const occupants = occupantsByRoom[room.id] || [];
                return (
                    <button key={room.id} onClick={() => room.implemented && onEnterRoom(room.id)}
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
                                        ? <img key={c.id} src={ch.img} className="h-9 w-9 object-contain object-bottom drop-shadow" alt="" style={{ transform: `scaleX(${ch.flip ? -1 : 1})` }} />
                                        : <div key={c.id} className="h-6 w-6 rounded-full bg-indigo-400/70 border border-white/40 flex items-center justify-center text-[9px]">{c.name.slice(0, 1)}</div>;
                                })}
                            </div>
                            {room.implemented && <span className="text-[9px] text-white/80 font-bold flex items-center gap-0.5">进入 <CaretRight size={10} weight="bold" /></span>}
                        </div>
                    </button>
                );
            })}
        </div>

        {novelCount === 0 && (
            <button onClick={onGoLibrary} className="w-full rounded-2xl py-3.5 text-[12px] text-white/65 tracking-wide active:bg-white/5"
                style={{ border: '1px dashed rgba(255,255,255,.18)', background: 'rgba(255,255,255,.02)' }}>
                书库尚空 · 上传一卷小说，角色便会在图书馆与它相遇 →
            </button>
        )}

        <div>
            <div className="flex items-center gap-2.5 mb-3 mt-1">
                <span className="h-px flex-1" style={{ background: 'linear-gradient(90deg,transparent,rgba(255,255,255,.14))' }} />
                <span className="text-[10.5px] tracking-[0.3em] text-white/50" style={{ fontFamily: `'Noto Serif SC',serif` }}>彼方动态</span>
                {feed.length > 0 && <button onClick={onClearFeed} className="text-[9.5px] text-white/40 hover:text-rose-300/80 px-1.5">清空</button>}
                <span className="h-px flex-1" style={{ background: 'linear-gradient(90deg,rgba(255,255,255,.14),transparent)' }} />
            </div>
            {feed.length === 0 ? (
                <p className="text-[11px] text-white/40 py-5 text-center tracking-wide leading-relaxed">虚空尚无回响。<br />在「接入」里点亮角色，ta 们到点会独自登入这里。</p>
            ) : (
                <>
                    <p className="text-[9px] text-white/25 text-center mb-2">长按动态可删除</p>
                    <div className="space-y-2.5">
                        {shown.map(item => <FeedCard key={item.msgId} item={item} onJump={onJump} onRequestDelete={setConfirmDel} />)}
                    </div>
                    {totalPages > 1 && (
                        <div className="flex items-center justify-center gap-3 mt-3">
                            <button onClick={() => setPage(p => Math.max(0, Math.min(p, totalPages - 1) - 1))} disabled={curPage === 0}
                                className="h-7 w-7 rounded-full flex items-center justify-center text-white/70 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)' }}><CaretLeft size={13} weight="bold" /></button>
                            <span className="text-[11px] text-white/50 tracking-wider tabular-nums">{curPage + 1} / {totalPages}</span>
                            <button onClick={() => setPage(p => Math.min(totalPages - 1, Math.min(p, totalPages - 1) + 1))} disabled={curPage >= totalPages - 1}
                                className="h-7 w-7 rounded-full flex items-center justify-center text-white/70 disabled:opacity-25 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.14)' }}><CaretRight size={13} weight="bold" /></button>
                        </div>
                    )}
                </>
            )}
        </div>
        <ConfirmDialog open={!!confirmDel} title="删除这条动态？" message={confirmDel ? `${confirmDel.charName} 在${getRoom(confirmDel.meta.room).name}的这条记录将被移除。` : ''}
            onConfirm={() => { if (confirmDel) onDeleteFeed(confirmDel.msgId); setConfirmDel(null); }} onCancel={() => setConfirmDel(null)} />
    </div>
    );
};

// 单条动态卡片（长按删除）
const FeedCard: React.FC<{ item: FeedItem; onJump: (novelId: string | undefined, segIdx: number) => void; onRequestDelete: (item: FeedItem) => void }> = ({ item, onJump, onRequestDelete }) => {
    const room = getRoom(item.meta.room);
    const { pressing, handlers } = useLongPress(() => onRequestDelete(item), 550);
    return (
        <div {...handlers}
            className={`rounded-2xl p-3 flex gap-3 backdrop-blur-sm transition-transform ${pressing ? 'scale-[0.97]' : ''}`}
            style={{ background: pressing ? 'rgba(244,63,94,0.14)' : 'rgba(255,255,255,0.05)', border: `1px solid ${pressing ? 'rgba(244,63,94,0.4)' : 'rgba(255,255,255,0.07)'}`, boxShadow: '0 4px 18px rgba(0,0,0,.22)' }}>
            {item.avatar ? <img src={item.avatar} className="h-8 w-8 rounded-full object-cover shrink-0" alt="" /> : <div className="h-8 w-8 rounded-full bg-indigo-400/40 shrink-0" />}
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[11px]">
                    <span className="font-bold text-amber-200">{item.charName}</span>
                    <span className="text-indigo-300/50">{room.name}</span>
                    <span className="ml-auto text-indigo-300/40 text-[9px]">{new Date(item.timestamp).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <p className="text-[11.5px] text-indigo-50/90 mt-0.5 leading-snug">{stripSelfName(item.meta.activity, item.charName)}</p>
                {item.meta.behavior && <p className="text-[10.5px] text-pink-200/80 mt-1 leading-snug">{stripSelfName(item.meta.behavior, item.charName)}</p>}
                {item.meta.annotationRefs && item.meta.annotationRefs.length > 0 ? (
                    <div className="mt-1 space-y-0.5">
                        {item.meta.annotationRefs.slice(0, 3).map((ref, i) => (
                            <button key={i} onClick={() => onJump(item.meta.novelId, ref.segIdx)}
                                className="block w-full text-left text-[10.5px] text-indigo-200/80 pl-2 border-l-2 border-amber-300/50 leading-snug active:opacity-60 hover:text-amber-100">
                                {ref.text} <span className="text-amber-300/60">↗原文</span>
                            </button>
                        ))}
                    </div>
                ) : item.meta.annotationExcerpts && item.meta.annotationExcerpts.length > 0 ? (
                    <div className="mt-1 space-y-0.5">
                        {item.meta.annotationExcerpts.slice(0, 2).map((ex, i) => (
                            <div key={i} className="text-[10.5px] text-indigo-200/70 pl-2 border-l-2 border-amber-300/40 leading-snug">{ex}</div>
                        ))}
                    </div>
                ) : null}
                {item.meta.room === 'postoffice' && item.meta.letterExcerpt && (
                    <div className="mt-1 text-[10.5px] text-amber-100/75 pl-2 border-l-2 border-amber-300/45 leading-snug" style={{ fontStyle: 'italic' }}>
                        「{item.meta.letterExcerpt.length > 70 ? item.meta.letterExcerpt.slice(0, 70) + '…' : item.meta.letterExcerpt}」
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
                            <button key={t.key} onClick={() => setTab(t.key)}
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

const RoomScene: React.FC<{
    roomId: VRRoomId; occupants: CharacterProfile[];
    latestByChar: Record<string, FeedItem>; onClose: () => void;
    onJump: (novelId: string | undefined, segIdx: number) => void;
    characters: CharacterProfile[];
    userName: string;
    onUserBoardPost: (content: string) => Promise<void>;
    addToast?: (m: string, t?: any) => void;
}> = ({ roomId, occupants, latestByChar, onClose, onJump, characters, userName, onUserBoardPost, addToast }) => {
    const room = getRoom(roomId);
    const slots = ROOM_SLOTS[roomId];
    const isMusic = roomId === 'music';
    const isGuestbook = roomId === 'guestbook';
    const isPostOffice = roomId === 'postoffice';
    const [detail, setDetail] = useState<CharacterProfile | null>(null);
    const [musicState, setMusicState] = useState<VRMusicRoomState | null>(null);
    const [board, setBoard] = useState<VRGuestbookState | null>(null);
    const [postText, setPostText] = useState('');
    const [posting, setPosting] = useState(false);
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
        try { await onUserBoardPost(t); setPostText(''); setBoard(await DB.getVRGuestbook()); }
        finally { setPosting(false); }
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
                    <button onClick={onClose} className="h-10 w-10 -ml-2 rounded-full bg-white/10 backdrop-blur-md active:bg-white/20 text-white/90 border border-white/10 flex items-center justify-center"><CaretLeft size={20} weight="regular" /></button>
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
                                    ? <img src={np.song.albumPic} className={`h-14 w-14 rounded-xl object-cover ${npPlaying ? 'animate-spin-slow' : ''}`} style={npPlaying ? { animation: 'spin 8s linear infinite' } : {}} alt="" />
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
                    const msgs = (board?.messages || []).slice(-80); // 超出只留最近的，旧的隐藏
                    // 连续同一作者（且非回复、间隔不久）合并为一组
                    const groups: VRGuestbookMessage[][] = [];
                    for (const m of msgs) {
                        const g = groups[groups.length - 1];
                        if (g && g[0].authorId === m.authorId && !m.replyToName && (m.createdAt - g[g.length - 1].createdAt) < 5 * 60 * 1000) g.push(m);
                        else groups.push([m]);
                    }
                    return (
                        <div className="absolute left-3 right-3 z-20 rounded-2xl overflow-hidden flex flex-col backdrop-blur-md"
                            style={{ top: VR_ROOM_PANEL_TOP, bottom: vrBottomPad('4rem'), background: 'rgba(10,22,38,0.62)', border: '1px solid rgba(140,200,255,0.22)', boxShadow: '0 8px 26px rgba(0,0,0,.4)' }}>
                            <div className="px-3 py-2 text-[10px] tracking-[0.25em] text-sky-200/70 border-b border-white/10" style={{ fontFamily: `'Noto Serif SC',serif` }}>留言墙</div>
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
                                                ? <img src={ch.avatar} className="h-8 w-8 rounded-full object-cover shrink-0 mt-0.5" alt="" />
                                                : <div className="h-8 w-8 rounded-full shrink-0 mt-0.5 flex items-center justify-center text-[12px] font-bold text-white/95" style={{ background: isUser ? 'linear-gradient(135deg,#38bdf8,#6366f1)' : `hsl(${hue},45%,42%)` }}>{name.slice(0, 1)}</div>}
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-baseline gap-1.5">
                                                    <span className="text-[12px] font-bold" style={{ color: nameColor }}>{name}</span>
                                                    <span className="text-[8.5px] text-white/30 tabular-nums">{new Date(head.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                                                </div>
                                                <div className="mt-0.5 space-y-0.5">
                                                    {g.map(m => (
                                                        <div key={m.id} className="text-[12.5px] leading-relaxed text-white/85">
                                                            {m.replyToName && <span className="text-[10px] text-sky-200/45 mr-1">↩{m.replyToName}</span>}
                                                            {m.content}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })()}

                {/* 邮局：信件管理面板 */}
                {isPostOffice && <PostOfficePanel addToast={addToast} characters={characters} userName={userName} />}

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
                {occupants.length === 0 && !isMusic && !isGuestbook && !isPostOffice && (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <p className="text-white/70 text-[12px] bg-black/30 rounded-full px-4 py-2">这个房间还没有人。去「接入」启用角色吧。</p>
                    </div>
                )}

                {/* 留言簿：用户发言（广播给所有接入角色） */}
                {isGuestbook && (
                    <div className="absolute left-0 right-0 z-30 flex items-center gap-2 px-3 py-2.5"
                        style={{ bottom: vrBottomPad('0px'), background: 'linear-gradient(0deg,rgba(5,12,22,.92),transparent)' }}>
                        <input value={postText} onChange={e => setPostText(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') submitPost(); }}
                            placeholder={`以 ${userName} 的身份留句话…`}
                            className="flex-1 rounded-full px-4 py-2 text-[12.5px] text-white placeholder-white/35 outline-none backdrop-blur-md"
                            style={{ background: 'rgba(255,255,255,.08)', border: '1px solid rgba(140,200,255,.25)' }} />
                        <button onClick={submitPost} disabled={!postText.trim() || posting}
                            className="h-9 px-4 rounded-full text-[12px] font-semibold text-white disabled:opacity-40 shrink-0"
                            style={{ background: 'linear-gradient(120deg, rgba(120,180,255,.9), rgba(150,200,235,.85))' }}>
                            {posting ? '…' : '留言'}
                        </button>
                    </div>
                )}
            </div>

            {/* 角色活动详情 —— 盖在 chibi 之上（zIndex 高于任何 chibi） */}
            {detail && (
                <div className="absolute inset-0 flex items-end bg-black/45" style={{ zIndex: 200 }} onClick={() => setDetail(null)}>
                    <div className="w-full rounded-t-2xl p-4 text-white" style={{ background: 'linear-gradient(180deg,#1a2236 0%,#0d1119 100%)', paddingBottom: vrBottomPad('1rem') }} onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-2 mb-2">
                            {detail.avatar ? <img src={detail.avatar} className="h-9 w-9 rounded-full object-cover" alt="" /> : <div className="h-9 w-9 rounded-full bg-indigo-400/40" />}
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
                                                {ref.text} <span className="text-amber-300/70">↗原文</span>
                                            </button>
                                        ))
                                        : m.annotationExcerpts?.map((ex, i) => (
                                            <div key={i} className="mt-1.5 text-[11.5px] text-indigo-200/80 pl-2 border-l-2 border-amber-300/50 leading-snug">{ex}</div>
                                        ))}
                                    <p className="text-[9px] text-indigo-300/50 mt-2">{new Date(latestByChar[detail.id].timestamp).toLocaleString('zh-CN')}</p>
                                </>
                            );
                        })() : (
                            <p className="text-[12px] text-indigo-300/60">还没有留下动态，等 ta 下一次登入吧。</p>
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
        ) : novels.map(novel => {
            const readers = characters.filter(c => getBookmark(c.vrState?.novelBookmarks, novel.id) > 0);
            return (
                <div key={novel.id} className="rounded-2xl p-3.5 backdrop-blur-sm" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.07)' }}>
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
        })}
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
                <span style={{ color: theme.text, fontSize: fontSize - 3 }}>：{a.content}</span>
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

// ============ 上传弹窗（支持大文件 .txt，内容不入 DOM） ============
const UploadModal: React.FC<{
    onClose: () => void;
    onCommit: (novel: VRWorldNovel) => Promise<void> | void;
    onError: (msg: string) => void;
}> = ({ onClose, onCommit, onError }) => {
    const [title, setTitle] = useState('');
    const [author, setAuthor] = useState('');
    const [summary, setSummary] = useState('');
    // 手动粘贴的小段文本走 state；大文件内容只存 ref，不进 textarea（否则 12MB 会冻 UI）
    const [pasteText, setPasteText] = useState('');
    const [fileInfo, setFileInfo] = useState<{ name: string; chars: number; preview: string; encoding: string } | null>(null);
    const fileContentRef = useRef<string>('');
    const fileRef = useRef<HTMLInputElement>(null);
    const [reading, setReading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState(0);

    const onFile = async (f: File | undefined) => {
        if (!f) return;
        setReading(true);
        try {
            const { text: content, encoding } = await decodeTextFile(f);
            fileContentRef.current = content;
            setFileInfo({
                name: f.name,
                chars: content.length,
                preview: content.slice(0, 300).replace(/\s+/g, ' ').trim(),
                encoding,
            });
            setPasteText(''); // 文件优先，清掉粘贴框
            if (!title.trim()) setTitle(f.name.replace(/\.(txt|text)$/i, ''));
        } catch (e) {
            console.error('[VRWorld] decode file failed', e);
            onError('文件读取失败');
        } finally {
            setReading(false);
        }
    };

    const clearFile = () => {
        fileContentRef.current = '';
        setFileInfo(null);
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

                <input ref={fileRef} type="file" accept=".txt,text/plain" className="hidden" onChange={e => onFile(e.target.files?.[0])} />
                {reading ? (
                    <div className="w-full rounded-xl border border-indigo-300/30 py-5 mb-3 flex items-center justify-center gap-2 text-indigo-100/90">
                        <CircleNotch size={18} weight="bold" className="animate-spin" /> 读取并识别编码中…
                    </div>
                ) : fileInfo ? (
                    <div className="rounded-xl border border-indigo-300/30 p-3 mb-3 bg-white/5">
                        <div className="flex items-center gap-2">
                            <BookOpen size={16} weight="fill" className="text-amber-200 shrink-0" />
                            <span className="text-[12.5px] text-white font-semibold truncate flex-1">{fileInfo.name}</span>
                            <span className="text-[8.5px] text-indigo-300/60 border border-indigo-300/30 rounded px-1 uppercase">{fileInfo.encoding}</span>
                            {!busy && <button onClick={clearFile} className="text-indigo-300/60 p-1"><X size={14} /></button>}
                        </div>
                        <div className="text-[10px] text-indigo-300/60 mt-1">{fileInfo.chars.toLocaleString()} 字 · 预计 ~{Math.ceil(fileInfo.chars / 400).toLocaleString()} 段</div>
                        <p className="text-[10.5px] text-indigo-200/50 mt-1.5 leading-snug line-clamp-2">{fileInfo.preview}…</p>
                    </div>
                ) : (
                    <button onClick={() => fileRef.current?.click()}
                        className="w-full rounded-xl border border-dashed border-indigo-300/40 py-3 mb-3 text-[12.5px] text-indigo-100/90 flex items-center justify-center gap-2 active:bg-white/5">
                        <UploadSimple size={16} weight="bold" /> 选择 .txt 文件（大文件也 OK）
                    </button>
                )}

                <div className="space-y-2.5">
                    <input value={title} onChange={e => setTitle(e.target.value)} placeholder="书名（必填）" className="w-full rounded-lg bg-white/8 px-3 py-2 text-[13px] text-white placeholder-indigo-300/40 outline-none" />
                    <input value={author} onChange={e => setAuthor(e.target.value)} placeholder="作者（选填）" className="w-full rounded-lg bg-white/8 px-3 py-2 text-[13px] text-white placeholder-indigo-300/40 outline-none" />
                    <input value={summary} onChange={e => setSummary(e.target.value)} placeholder="一句话简介（选填，喂给角色当背景）" className="w-full rounded-lg bg-white/8 px-3 py-2 text-[13px] text-white placeholder-indigo-300/40 outline-none" />
                    {!fileInfo && (
                        <>
                            <div className="text-[10px] text-indigo-300/50">或直接粘贴正文（小段文本用；大文件请走上面的文件选择）↓</div>
                            <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} placeholder="粘贴正文…" rows={6}
                                className="w-full rounded-lg bg-white/8 px-3 py-2 text-[12.5px] text-white placeholder-indigo-300/40 outline-none leading-relaxed" />
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
                    {img && <img src={img} alt="" className="object-contain mb-3" style={{ height: 140 * scale, transform: `scaleX(${flip ? -1 : 1}) translateY(${offsetY}px)`, filter: 'drop-shadow(0 4px 8px rgba(0,0,0,.5))', animation: 'vrfloat 3.2s ease-in-out infinite' }} />}
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

// ============ 接入设置 ============
const INTERVAL_OPTIONS = [60, 120, 180, 360, 720];
const SettingsView: React.FC<{
    characters: CharacterProfile[];
    updateCharacter: (id: string, updates: Partial<CharacterProfile>) => void;
    addToast?: (msg: string, type?: any) => void;
    novelCount: number; onReload: () => void;
    onRequestEnable: (char: CharacterProfile) => void;
    onEditChibi: (char: CharacterProfile) => void;
}> = ({ characters, updateCharacter, addToast, novelCount, onReload, onRequestEnable, onEditChibi }) => {
    const [pickFor, setPickFor] = useState<CharacterProfile | null>(null);
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
    };
    const setInterval = (char: CharacterProfile, minutes: number) => {
        updateCharacter(char.id, { vrState: { ...(char.vrState || {}), enabled: char.vrState?.enabled ?? true, intervalMinutes: minutes } });
        if (char.vrState?.enabled) VRScheduler.start(char.id, minutes);
    };

    return (
        <div className="space-y-3">
            <p className="text-[11px] text-indigo-300/60 leading-relaxed">
                启用后，角色会按设定的间隔自己登入「彼方」，在图书馆读你上传的小说、写批注。每次活动会在 ta 的聊天里留下动态卡片，也会被记忆总结捕捉。
                {novelCount === 0 && <span className="text-amber-300/80"> 书库还空着，先去「书库」上传一本。</span>}
            </p>
            {characters.length === 0 && <p className="text-[11px] text-indigo-300/50 py-4 text-center">还没有角色。</p>}
            {characters.map(char => {
                const st = char.vrState;
                const enabled = !!st?.enabled;
                const interval = st?.intervalMinutes || VR_DEFAULT_INTERVAL_MIN;
                const chibi = getChibi(char);
                return (
                    <div key={char.id} className="rounded-2xl p-3.5 backdrop-blur-sm" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.07)' }}>
                        <div className="flex items-center gap-2.5">
                            {/* chibi 缩略 */}
                            <button onClick={() => onEditChibi(char)} className="relative h-12 w-12 rounded-xl overflow-hidden bg-black/20 flex items-end justify-center shrink-0 active:opacity-80">
                                {chibi.img ? <img src={chibi.img} className="h-11 object-contain object-bottom" style={{ transform: `scaleX(${chibi.flip ? -1 : 1})` }} alt="" /> : <span className="text-lg text-indigo-300/60 mb-2">？</span>}
                                <span className="absolute bottom-0 right-0 bg-indigo-500/90 rounded-tl-md p-0.5"><PencilSimple size={9} weight="bold" /></span>
                            </button>
                            <div className="flex-1 min-w-0">
                                <div className="text-[13px] font-bold truncate">{char.name}</div>
                                {enabled ? <div className="text-[10px] text-indigo-300/60">每 {interval >= 60 ? `${interval / 60} 小时` : `${interval} 分`}登入一次</div>
                                    : <div className="text-[10px] text-indigo-300/40">{chibi.isFallback ? '未设形象 · 未接入' : '未接入'}</div>}
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
                                            {opt >= 60 ? `${opt / 60}h` : `${opt}min`}
                                        </button>
                                    ))}
                                </div>
                                <button onClick={() => setPickFor(char)}
                                    className="mt-2.5 text-[11px] text-amber-200 font-semibold flex items-center gap-1 active:opacity-70">
                                    <Play size={12} weight="fill" /> 让 ta 现在去逛一次
                                </button>
                            </>
                        )}
                    </div>
                );
            })}
            <ActionSheet open={!!pickFor} title={pickFor ? `让 ${pickFor.name} 现在去哪个房间？` : ''}
                actions={[
                    { label: '随机一个房间', onClick: () => go() },
                    ...(novelCount > 0 ? [{ label: '图书馆 · 读书写批注', onClick: () => go('library') }] : []),
                    { label: '听歌房 · 点歌锐评', onClick: () => go('music') },
                    { label: '留言簿 · 发帖版聊', onClick: () => go('guestbook') },
                    { label: '娱乐室 · 放开玩', onClick: () => go('gym') },
                    { label: '邮局 · 写漂流信', onClick: () => go('postoffice') },
                ]} onClose={() => setPickFor(null)} />
        </div>
    );
};

// ============ 彼方 · API 设置 + 调用记录 ============
const VRApiSettings: React.FC<{ apiPresets: ApiPreset[]; chatApi: APIConfig; addToast?: (m: string, t?: any) => void }> = ({ apiPresets, chatApi, addToast }) => {
    const [vrApi, setVr] = useState<APIConfig | null>(null);
    const [log, setLog] = useState<VRApiCall[]>([]);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<string | null>(null);
    const [presetsOpen, setPresetsOpen] = useState(false);   // 折叠「保存的预设」长列表

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

    const okCount = log.filter(l => l.ok).length;

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
                    <span className="text-[9.5px] text-white/40 rounded-full px-1.5 leading-tight" style={{ background: 'rgba(255,255,255,.08)' }}>{log.length}{log.length ? ` · 成功${okCount}` : ''}</span>
                    {log.length > 0 && <button onClick={() => { void clearVRApiLog(); setLog([]); }} className="ml-auto text-[10px] text-white/40 hover:text-rose-300/80">清空</button>}
                </div>
                {log.length === 0 ? (
                    <p className="text-[10.5px] text-white/35 py-2 text-center">还没有调用。角色每次登入彼方触发的模型调用都会记在这里，方便你对账。</p>
                ) : (
                    <div className="space-y-1">
                        {log.slice(0, 60).map((l, i) => (
                            <div key={i} className="flex items-center gap-2 text-[10.5px] py-1 border-b border-white/5 last:border-0">
                                <span className={`shrink-0 ${l.ok ? 'text-emerald-400/80' : 'text-rose-400/80'}`}>{l.ok ? '●' : '○'}</span>
                                <span className="text-white/75 truncate">{l.charName || '—'}</span>
                                <span className="text-indigo-300/40 shrink-0">{l.room ? getRoom(l.room as VRRoomId).name : ''}</span>
                                <span className="ml-auto text-white/30 shrink-0 tabular-nums">{(l.ms / 1000).toFixed(1)}s</span>
                                <span className="text-white/35 shrink-0 tabular-nums w-[68px] text-right">{new Date(l.ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                            </div>
                        ))}
                    </div>
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
    `}</style>
);

export default VRWorldApp;
