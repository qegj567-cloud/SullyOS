/**
 * 「家园」—— 同世界观多角色共同生活的大世界。
 *
 * 三个视图：
 *   - list：世界列表 + 新建
 *   - edit：世界编辑器（世界观/模式/成员/居住安排/NPC/关系/离线 tick/API 覆盖）
 *   - world：大世界主视图（观测推进、拜访各家、关系条、NPC 动静、时间线）
 *
 * 视觉：游戏化——天空随剧情时间昼夜切换（白天暖阳/夜晚星空），小屋是带屋顶的
 * 村庄卡片，角色手机用真手机壳弹窗呈现（动态=信息流、私信=聊天气泡）。
 *
 * 演绎引擎跑在 OSContext 全局（WorldScheduler.onTrigger → runWorldEpisode），
 * 本组件只负责触发与观察——用户点完"观测"就算切去和别人私聊，演绎照样完成。
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useOS } from '../context/OSContext';
import {
    ArrowLeft, Plus, GearSix, Trash, House, UsersThree,
    CaretRight, CaretDown, Sparkle, MapPin, DeviceMobile, X,
    MoonStars, SunHorizon, Heart, ChatCircleDots, Article, WifiHigh, BatteryFull, CellSignalFull,
    Lightning, NotePencil, PaperPlaneTilt, EyeSlash,
} from '@phosphor-icons/react';
import { DB } from '../utils/db';
import { getChibi } from '../utils/vrWorld/chibi';
import TokenImg from '../components/os/TokenImg';
import { WorldScheduler, toTickEntries } from '../utils/worldHome/scheduler';
import { isWorldRunning, injectWorldCard } from '../utils/worldHome/engine';
import { worldTimeLabel, worldTzLabel, isNightWorld, houseOf, NARRATIVE_STYLES, buildNpcRollPrompt, parseRolledNpcs, realObserveTarget, clampRealClockToNow, migrateWorldDaySegs, SEGMENTS_PER_DAY } from '../utils/worldHome/prompts';
import { COMMON_TIMEZONES } from '../utils/timezone';
import { SIM_CHAPTER_DAYS, SIM_CHAPTER_CLOCKS } from '../utils/worldHome/chapters';
import { dmThreadsOf, groupThreadOf } from '../utils/worldHome/threads';
import { safeFetchJson } from '../utils/safeApi';
import { WORLD_API_KEY, WORLD_CUSTOM_STYLE_KEY } from '../utils/worldHome/localBackup';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { trackEvent } from '../utils/analytics';
import type { WorldProfile, WorldEpisode, WorldHomeMode, WorldTimeMode, WorldHouse, WorldThread, WorldChatMessage, WorldNarrativeStyle, CharacterProfile, WorldCharBeat, APIConfig, ApiPreset } from '../types';

/**
 * 家园里「生成内容」的可编辑/删除目标（手机里的动态/备忘/聊天）。
 * newText=null 表示删除；否则替换文本。
 *  - post/memo 落在 episode.beats[charId] 上（按 round 定位 episode）
 *  - msg 落在 world.threads[threadId].messages 上（按 msgId 定位）
 */
type WHEditTarget =
    | { type: 'post'; round: number; charId: string; idx: number }
    | { type: 'memo'; round: number; charId: string; idx: number }
    | { type: 'msg'; threadId: string; msgId: string }
    | { type: 'comment'; key: string; idx: number };

/** 自定义文风的本地收藏 / 家园全局 API 的 localStorage key —— 与备份工具共用同一组，避免漂移。 */
const CUSTOM_STYLE_KEY = WORLD_CUSTOM_STYLE_KEY;
const loadSavedStyles = (): string[] => {
    try { const s = localStorage.getItem(CUSTOM_STYLE_KEY); return s ? JSON.parse(s) : []; } catch { return []; }
};
const persistSavedStyles = (list: string[]) => {
    try { localStorage.setItem(CUSTOM_STYLE_KEY, JSON.stringify(list.slice(0, 12))); } catch { /* ignore */ }
};

/** 家园全局 API（所有世界共用一份；不设=跟随全局聊天默认）。存 localStorage。 */
const loadWorldApi = (): { baseUrl: string; apiKey: string; model: string } | null => {
    try { const s = localStorage.getItem(WORLD_API_KEY); const c = s ? JSON.parse(s) : null; return c?.baseUrl ? c : null; } catch { return null; }
};
const persistWorldApi = (cfg: { baseUrl: string; apiKey: string; model: string } | null) => {
    try { if (cfg?.baseUrl) localStorage.setItem(WORLD_API_KEY, JSON.stringify(cfg)); else localStorage.removeItem(WORLD_API_KEY); } catch { /* ignore */ }
};

/** 家园全局 API 设置弹窗（学彼方：跟随全局默认 / 选「设置」里保存的预设；所有世界共用）。 */
const WorldApiSettings: React.FC<{
    apiConfig: APIConfig;
    apiPresets: ApiPreset[];
    current: { baseUrl: string; apiKey: string; model: string } | null;
    onChoose: (cfg: { baseUrl: string; apiKey: string; model: string } | null) => void;
    onClose: () => void;
}> = ({ apiConfig, apiPresets, current, onChoose, onClose }) => {
    const host = (u?: string) => { try { return u ? new URL(u).host : '—'; } catch { return u || '—'; } };
    const follow = !current?.baseUrl;
    const sameAs = (c: APIConfig) => !follow && current!.baseUrl === c.baseUrl && current!.model === c.model && current!.apiKey === c.apiKey;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
            <div className="w-full max-w-md bg-[#f7f3ea] rounded-3xl p-4 max-h-[80%] overflow-y-auto no-scrollbar shadow-2xl" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-1">
                    <h3 className="text-[15px] font-black text-stone-800 font-serif">家园 · API</h3>
                    <button onClick={onClose} className="p-1.5 rounded-full hover:bg-black/5"><X size={16} weight="bold" className="text-stone-500" /></button>
                </div>
                <p className="text-[11px] text-stone-400 leading-relaxed mb-3">家园演绎比较费 API，可在这里单独指定一份（<b className="text-stone-500">所有世界共用</b>）；不设则跟随全局聊天默认。</p>
                <button onClick={() => onChoose(null)} className={`w-full flex items-center gap-2 rounded-xl p-3 mb-1.5 text-left border transition-all ${follow ? 'bg-stone-900 border-stone-900 text-white shadow' : 'bg-white border-stone-200 text-stone-700'}`}>
                    <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-bold">跟随全局默认</div>
                        <div className={`text-[10px] truncate ${follow ? 'text-white/60' : 'text-stone-400'}`}>{apiConfig?.model || '未配置'} · {host(apiConfig?.baseUrl)}</div>
                    </div>
                    {follow && <span className="text-[10px] font-bold shrink-0">✓ 使用中</span>}
                </button>
                {apiPresets.length === 0 ? (
                    <p className="text-[10.5px] text-stone-400 px-1 py-1.5">「设置」里还没有保存的 API 预设——去设置里存几个模型，这里就能直接选。</p>
                ) : apiPresets.map(p => {
                    const on = sameAs(p.config);
                    return (
                        <button key={p.id} onClick={() => onChoose({ baseUrl: p.config.baseUrl, apiKey: p.config.apiKey, model: p.config.model })}
                            className={`w-full flex items-center gap-2 rounded-xl p-3 mb-1.5 text-left border transition-all ${on ? 'bg-stone-900 border-stone-900 text-white shadow' : 'bg-white border-stone-200 text-stone-700'}`}>
                            <div className="flex-1 min-w-0">
                                <div className="text-[12.5px] font-bold truncate">{p.name}</div>
                                <div className={`text-[10px] truncate ${on ? 'text-white/60' : 'text-stone-400'}`}>{p.config.model} · {host(p.config.baseUrl)}</div>
                            </div>
                            {on && <span className="text-[10px] font-bold shrink-0">✓ 使用中</span>}
                        </button>
                    );
                })}
            </div>
        </div>
    );
};

const genId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

const MODE_INFO: Record<WorldHomeMode, { name: string; short: string; desc: string; badge: string }> = {
    light: { name: '轻度 · 以你为主', short: '以你为主', desc: '只是观察角色生活的一个切面。世界里 ta 依旧以你为最重要的人——和聊天里完全一致。', badge: 'bg-sky-400/90 text-sky-950' },
    medium: { name: '中度 · 你是一份子', short: '你是一份子', desc: '你是这个世界的普通一员，存在但不特殊，角色不围着你转。', badge: 'bg-amber-400/90 text-amber-950' },
    heavy: { name: '重度 · 无你世界', short: '无你世界', desc: '你不存在（或只是透明的幽灵）。角色之间自行生活，演绎中完全无视你。', badge: 'bg-rose-400/90 text-rose-950' },
};

const TIME_MODE_INFO: Record<WorldTimeMode, { name: string; short: string; desc: string; hint: string; badge: string }> = {
    real: {
        name: '真实时间', short: '真实时间',
        desc: '早/中/晚/凌晨跟着现实时钟走，演绎写回各角色的聊天与记忆，和你平时的聊天连成一体。',
        hint: '适合「真实系角色」——只能补当天错过的段，过了今天就补不回来；卡片自然不会刷屏。',
        badge: 'bg-emerald-400/90 text-emerald-950',
    },
    sim: {
        name: '模拟时间', short: '模拟时间',
        desc: '自定义起始日期，演绎不进记忆、留在家园里。每 20 天自动结一卷小说体总结并归档原文。',
        hint: '适合给 OC 们开小剧场图一乐——攒一段时间回来读一卷「这些天发生了什么」。',
        badge: 'bg-violet-400/90 text-violet-950',
    },
};

/** 全局动画 keyframes（云朵漂浮 / 星星闪烁 / 微光扫过）。 */
const GameStyles: React.FC = () => (
    <style>{`
        @keyframes wh-drift { 0% { transform: translateX(0); } 50% { transform: translateX(14px); } 100% { transform: translateX(0); } }
        @keyframes wh-twinkle { 0%, 100% { opacity: .9; } 50% { opacity: .25; } }
        @keyframes wh-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
        @keyframes wh-sheen { 0% { transform: translateX(-150%) skewX(-20deg); } 100% { transform: translateX(250%) skewX(-20deg); } }
        .wh-sheen::after { content: ''; position: absolute; top: 0; bottom: 0; width: 40%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,.35), transparent);
            animation: wh-sheen 2.8s ease-in-out infinite; }
    `}</style>
);

/** 夜空星星（纯 CSS，多层 radial-gradient）。 */
const starsBg = `radial-gradient(1.5px 1.5px at 12% 28%, #fff, transparent),
radial-gradient(1px 1px at 28% 62%, #ffeebb, transparent),
radial-gradient(1.5px 1.5px at 44% 18%, #fff, transparent),
radial-gradient(1px 1px at 58% 48%, #cfe2ff, transparent),
radial-gradient(2px 2px at 72% 24%, #fff, transparent),
radial-gradient(1px 1px at 84% 56%, #ffeebb, transparent),
radial-gradient(1.5px 1.5px at 92% 32%, #fff, transparent)`;

/** Q版小人（彼方捏人系统的 chibi，兜底头像）。 */
const ChibiFigure: React.FC<{ char: CharacterProfile; size?: number; bob?: boolean }> = ({ char, size = 56, bob }) => {
    const c = getChibi(char);
    if (!c.img) {
        return <div className="rounded-full bg-emerald-200/60 flex items-center justify-center text-emerald-800 font-bold" style={{ width: size, height: size }}>{char.name.slice(0, 1)}</div>;
    }
    return (
        <div className="flex flex-col items-center" style={{ width: size, animation: bob ? 'wh-bob 2.6s ease-in-out infinite' : undefined }}>
            <TokenImg
                value={c.img}
                alt={char.name}
                className={c.isFallback ? 'rounded-full object-cover' : 'object-contain'}
                style={{
                    width: size, height: size,
                    transform: `${c.flip ? 'scaleX(-1) ' : ''}scale(${c.isFallback ? 1 : c.scale})`,
                    transformOrigin: 'bottom center',
                    filter: 'drop-shadow(0 5px 6px rgba(0,0,0,.30))',
                }}
                draggable={false}
            />
        </div>
    );
};

// ============================================================
// 真手机弹窗：角色的手机（持久的——动态是历史信息流，私信/群聊是
// 跨轮累积的真实会话：A 发的和 B 的回应交替出现）
// ============================================================

/** 会话气泡流：自己右绿、对方左白带头像，剧情时间变化处插分隔条。点按某条气泡可编辑/删除。 */
const ThreadBubbles: React.FC<{
    thread: WorldThread;
    selfId: string;
    members: CharacterProfile[];
    npcs: WorldProfile['npcs'];
    showNames?: boolean;
    onPick?: (m: WorldChatMessage) => void;
}> = ({ thread, selfId, members, npcs, showNames, onPick }) => {
    const avatarOf = (id: string) => members.find(m => m.id === id)?.avatar;
    const emojiOf = (id: string) => npcs.find(n => n.id === id)?.emoji || '🙂';
    const isNpc = (id: string) => npcs.some(n => n.id === id);
    const els: React.ReactNode[] = [];
    let lastTime = '';
    thread.messages.forEach(m => {
        if (m.storyTime !== lastTime) {
            lastTime = m.storyTime;
            els.push(
                <div key={`div_${m.id}`} className="flex items-center gap-2 py-1">
                    <div className="flex-1 h-px bg-white/10" />
                    <span className="text-[8.5px] text-white/40 font-bold tracking-wider">{m.storyTime}</span>
                    <div className="flex-1 h-px bg-white/10" />
                </div>
            );
        }
        const mine = m.fromId === selfId;
        els.push(
            <div key={m.id} className={`flex items-end gap-1.5 ${mine ? 'justify-end' : 'justify-start'}`}>
                {!mine && (
                    avatarOf(m.fromId)
                        ? <TokenImg value={avatarOf(m.fromId)} className="w-[22px] h-[22px] rounded-full object-cover shrink-0" alt="" />
                        : <div className="w-[22px] h-[22px] rounded-full bg-white/15 flex items-center justify-center text-[11px] shrink-0">{isNpc(m.fromId) ? emojiOf(m.fromId) : m.fromName.slice(0, 1)}</div>
                )}
                <div className={`max-w-[78%] ${mine ? 'items-end' : 'items-start'} flex flex-col`}>
                    {!mine && showNames && <div className="text-[8.5px] text-white/45 font-bold mb-0.5 px-1">{m.fromName}{isNpc(m.fromId) ? ' · NPC' : ''}</div>}
                    <div role={onPick ? 'button' : undefined} onClick={onPick ? () => onPick(m) : undefined}
                        className={`px-2.5 py-1.5 text-[11px] leading-[1.5] shadow-sm ${onPick ? 'cursor-pointer active:opacity-80 transition-opacity' : ''} ${mine
                        ? 'rounded-2xl rounded-br-md bg-gradient-to-br from-emerald-400 to-emerald-500 text-white'
                        : 'rounded-2xl rounded-bl-md bg-white/95 text-slate-800'}`}>
                        {m.text}
                    </div>
                </div>
            </div>
        );
    });
    return <>{els}</>;
};

const PhoneModal: React.FC<{
    ownerId: string;
    world: WorldProfile;
    episodes: WorldEpisode[];
    members: CharacterProfile[];
    initialTab?: 'feed' | 'dm' | 'group' | 'memo';
    onClose: () => void;
    /** 编辑/删除生成内容（动态/备忘/聊天）；newText=null 表示删除 */
    onEditContent?: (target: WHEditTarget, newText: string | null) => void | Promise<void>;
}> = ({ ownerId, world, episodes, members, initialTab, onClose, onEditContent }) => {
    const [tab, setTab] = useState<'feed' | 'dm' | 'group' | 'memo'>(initialTab || 'feed');
    const owner = members.find(m => m.id === ownerId);
    const ownerName = owner?.name || '?';
    const avatar = owner?.avatar;
    const dmThreads = dmThreadsOf(world, ownerId);
    const [dmOpenId, setDmOpenId] = useState<string | null>(null); // null = 看联系人列表；非空 = 进了某条会话
    const group = groupThreadOf(world);
    const latestBeat = episodes[0]?.beats.find(b => b.charId === ownerId);
    const nameById = (id: string) => members.find(m => m.id === id)?.name || world.npcs.find(n => n.id === id)?.name || '?';
    const avatarById = (id: string) => members.find(m => m.id === id)?.avatar;

    // 归档线：sim 模式结卷后，被卷进编年史的轮次（round ≤ 此值）不再在手机里展示
    const archivedClock = world.simSummarizedClock || 0;
    const archivedDays = Math.floor(archivedClock / 3);

    // 动态：跨轮聚合该角色发过的 posts（新的在上；归档的不再显示）。key 用于关联点赞/评论；round+idx 用于编辑/删除。
    const feed = useMemo(() => {
        const out: { storyTime: string; location: string; post: string; round: number; idx: number; key: string }[] = [];
        for (const ep of episodes) {
            if (ep.round <= archivedClock) continue;
            const b = ep.beats.find(x => x.charId === ownerId);
            (b?.phone?.posts || []).forEach((p, idx) => out.push({ storyTime: ep.storyTime, location: b!.location, post: p, round: ep.round, idx, key: `${ep.round}_${ownerId}_${idx}` }));
        }
        return out;
    }, [episodes, ownerId, archivedClock]);

    // 备忘录：跨轮聚合（私人，只有屏幕外的玩家翻得到；归档的不再显示）。round+idx 用于编辑/删除。
    const memos = useMemo(() => {
        const out: { storyTime: string; text: string; round: number; idx: number }[] = [];
        for (const ep of episodes) {
            if (ep.round <= archivedClock) continue;
            const b = ep.beats.find(x => x.charId === ownerId);
            (b?.memo || []).forEach((m, idx) => out.push({ storyTime: ep.storyTime, text: m, round: ep.round, idx }));
        }
        return out;
    }, [episodes, ownerId, archivedClock]);

    const dmCount = dmThreads.reduce((s, t) => s + t.messages.length, 0);
    const activeDm = dmOpenId ? dmThreads.find(t => t.id === dmOpenId) : undefined;

    // 动态/备忘翻页（每页 8）；私聊折叠（默认只看最近 30 条）
    const PER = 8;
    const [feedPage, setFeedPage] = useState(0);
    const [memoPage, setMemoPage] = useState(0);
    const FOLD = 50; // 私聊/群聊超过这么多条就折叠，避免一次渲染太多卡顿
    const [dmExpanded, setDmExpanded] = useState(false);
    const [groupExpanded, setGroupExpanded] = useState(false);
    useEffect(() => { setDmExpanded(false); }, [dmOpenId]);

    // 聊天像真手机一样：进会话/切到群聊默认落到底部（最新消息），不必从头往下滑
    const scrollRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if ((tab === 'dm' && dmOpenId) || tab === 'group') {
            const el = scrollRef.current;
            if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
        }
    }, [tab, dmOpenId, dmExpanded, groupExpanded]);

    // 编辑/删除某条生成内容的弹层
    const [editing, setEditing] = useState<{ target: WHEditTarget; text: string; title: string; canDelete: boolean } | null>(null);
    const [confirmDel, setConfirmDel] = useState(false);
    useEffect(() => { setConfirmDel(false); }, [editing]);
    const submitEdit = async (newText: string | null) => {
        if (editing && onEditContent) {
            await onEditContent(editing.target, newText);
            trackEvent('编辑角色手机里的内容', { action: newText === null ? 'delete' : 'edit' });
        }
        setEditing(null);
    };

    // 把手机内容（动态）转发到「和 ta 的聊天」里
    const [sharedKeys, setSharedKeys] = useState<Set<string>>(new Set());
    const shareToChat = async (key: string, text: string) => {
        try {
            await DB.saveMessage({ charId: ownerId, role: 'assistant', type: 'text', content: `【家园 · ${world.name}】${ownerName} 发了条动态：\n${text}` });
            setSharedKeys(prev => new Set(prev).add(key));
            trackEvent('转发角色动态到聊天');
        } catch { /* ignore */ }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
            <div className="relative" onClick={e => e.stopPropagation()}>
                {/* 手机壳 */}
                <div className="w-[min(360px,92vw)] h-[min(760px,86vh)] rounded-[2.6rem] bg-gradient-to-b from-zinc-800 to-zinc-950 p-[7px] shadow-[0_24px_60px_rgba(0,0,0,.6),inset_0_1px_1px_rgba(255,255,255,.18)]">
                    <div className="relative w-full h-full rounded-[2.15rem] overflow-hidden flex flex-col" style={{ background: 'linear-gradient(170deg,#101426 0%,#1b2138 60%,#232a47 100%)' }}>
                        {/* 灵动岛 */}
                        <div className="absolute top-2 left-1/2 -translate-x-1/2 w-20 h-[18px] rounded-full bg-black z-20" />
                        {/* 状态栏 */}
                        <div className="pt-2.5 pb-1 px-5 flex items-center justify-between text-[9px] text-white/80 font-semibold shrink-0">
                            <span>{worldTimeLabel(world)}</span>
                            <span className="flex items-center gap-1"><CellSignalFull size={10} weight="fill" /><WifiHigh size={10} weight="bold" /><BatteryFull size={12} weight="fill" /></span>
                        </div>
                        {/* 机主栏 */}
                        <div className="px-4 pt-2 pb-3 flex items-center gap-2.5 shrink-0">
                            {avatar
                                ? <TokenImg value={avatar} className="w-9 h-9 rounded-2xl object-cover ring-2 ring-white/20" alt="" />
                                : <div className="w-9 h-9 rounded-2xl bg-white/15 flex items-center justify-center text-white font-bold">{ownerName.slice(0, 1)}</div>}
                            <div className="min-w-0">
                                <div className="text-[13px] font-bold text-white truncate">{ownerName} 的手机</div>
                                <div className="text-[9.5px] text-white/50">{latestBeat ? `${latestBeat.location} · ${latestBeat.mood}` : `${world.name} 居民`}</div>
                            </div>
                            <button onClick={onClose} className="ml-auto p-1.5 rounded-full bg-white/10 text-white/70 active:scale-90"><X size={13} weight="bold" /></button>
                        </div>
                        {/* Tab */}
                        <div className="px-3 flex gap-1 shrink-0">
                            {([['feed', '动态', Article, feed.length], ['dm', '私信', ChatCircleDots, dmCount], ['group', '群聊', UsersThree, group?.messages.length || 0], ['memo', '备忘', NotePencil, memos.length]] as const).map(([id, label, Icon, count]) => (
                                <button key={id} onClick={() => { setTab(id); trackEvent('切换角色手机分区', { tab: id }); }}
                                    className={`flex-1 py-1.5 rounded-xl text-[10px] font-bold flex items-center justify-center gap-0.5 transition-colors ${tab === id ? 'bg-white text-slate-900' : 'bg-white/10 text-white/60'}`}>
                                    <Icon size={11} weight="bold" />{label}
                                    <span className={`text-[8px] px-1 rounded-full ${tab === id ? 'bg-slate-900/10' : 'bg-white/10'}`}>{count}</span>
                                </button>
                            ))}
                        </div>
                        {/* 内容 */}
                        <div ref={scrollRef} className="flex-1 overflow-y-auto no-scrollbar px-3.5 py-3 space-y-2">
                            {tab === 'feed' && (
                                feed.length === 0
                                    ? <div className="text-center text-[11px] text-white/40 pt-16">还没发过动态{archivedDays > 0 ? `（更早 ${archivedDays} 天已归档进编年史）` : ''}</div>
                                    : (() => {
                                        const pages = Math.max(1, Math.ceil(feed.length / PER));
                                        const p = Math.min(feedPage, pages - 1);
                                        return (<>
                                            {p === 0 && archivedDays > 0 && <div className="text-center text-[9px] text-white/35 pb-1">更早 {archivedDays} 天已归档进编年史</div>}
                                            {feed.slice(p * PER, p * PER + PER).map((f, i) => (
                                                <div key={i} className="rounded-2xl bg-white/95 p-3 shadow-sm">
                                                    <div className="flex items-center gap-2">
                                                        {avatar
                                                            ? <TokenImg value={avatar} className="w-6 h-6 rounded-full object-cover" alt="" />
                                                            : <div className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center text-[10px] font-bold text-slate-600">{ownerName.slice(0, 1)}</div>}
                                                        <div>
                                                            <div className="text-[10.5px] font-bold text-slate-800 leading-none">{ownerName}</div>
                                                            <div className="text-[8.5px] text-slate-400 mt-0.5">{f.storyTime} · 来自{f.location}</div>
                                                        </div>
                                                    </div>
                                                    <p className="text-[11.5px] leading-[1.6] text-slate-700 mt-2 whitespace-pre-wrap">{f.post}</p>
                                                    {(() => {
                                                        const rx = world.feedReactions?.[f.key];
                                                        const done = sharedKeys.has(f.key);
                                                        return (<>
                                                            <div className="mt-2 pt-1.5 border-t border-slate-100 flex items-center gap-3 text-slate-400">
                                                                <span className="flex items-center gap-0.5 text-[9px]"><Heart size={11} weight={rx?.likes ? 'fill' : 'regular'} className={rx?.likes ? 'text-rose-400' : ''} /> {rx?.likes || 0}</span>
                                                                <span className="flex items-center gap-0.5 text-[9px]"><ChatCircleDots size={11} /> {rx?.comments.length || 0}</span>
                                                                {onEditContent && (
                                                                    <button onClick={() => setEditing({ target: { type: 'post', round: f.round, charId: ownerId, idx: f.idx }, text: f.post, title: '编辑动态', canDelete: true })}
                                                                        className="flex items-center gap-0.5 text-[9px] font-bold text-slate-400 active:scale-95">
                                                                        <NotePencil size={11} />编辑
                                                                    </button>
                                                                )}
                                                                <button onClick={() => !done && shareToChat(f.key, f.post)} disabled={done}
                                                                    className={`ml-auto flex items-center gap-0.5 text-[9px] font-bold ${done ? 'text-emerald-500' : 'text-sky-500 active:scale-95'}`}>
                                                                    <PaperPlaneTilt size={11} weight={done ? 'fill' : 'regular'} />{done ? '已发到聊天' : '发到聊天'}
                                                                </button>
                                                            </div>
                                                            {rx && rx.comments.length > 0 && (
                                                                <div className="mt-1.5 rounded-lg bg-slate-50 px-2.5 py-1.5 space-y-1">
                                                                    {rx.comments.map((c, ci) => (
                                                                        <div key={ci} className="group flex items-start gap-1">
                                                                            <p className="flex-1 text-[10.5px] leading-snug text-slate-600"><span className="font-bold text-slate-700">{c.from}</span>：{c.text}</p>
                                                                            {onEditContent && (
                                                                                <button onClick={() => onEditContent({ type: 'comment', key: f.key, idx: ci }, null)}
                                                                                    className="shrink-0 mt-px text-slate-300 active:text-rose-500 active:scale-90 transition" title="删除这条评论">
                                                                                    <X size={11} weight="bold" />
                                                                                </button>
                                                                            )}
                                                                        </div>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </>);
                                                    })()}
                                                </div>
                                            ))}
                                            {pages > 1 && (
                                                <div className="flex items-center justify-center gap-3 pt-1">
                                                    <button onClick={() => setFeedPage(Math.max(0, p - 1))} disabled={p === 0} className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-white/10 text-white/70 disabled:opacity-30">上一页</button>
                                                    <span className="text-[10px] text-white/50 tabular-nums">{p + 1}/{pages}</span>
                                                    <button onClick={() => setFeedPage(Math.min(pages - 1, p + 1))} disabled={p >= pages - 1} className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-white/10 text-white/70 disabled:opacity-30">下一页</button>
                                                </div>
                                            )}
                                        </>);
                                    })()
                            )}
                            {tab === 'dm' && (
                                dmThreads.length === 0
                                    ? <div className="text-center text-[11px] text-white/40 pt-16">私信里还没有会话</div>
                                    : activeDm
                                        ? (() => {
                                            // 进了某条会话：顶部「← 联系人名」，下面是聊天内容
                                            const otherId = activeDm.memberIds.find(id => id !== ownerId) || '';
                                            const otherName = nameById(otherId);
                                            const folded = !dmExpanded && activeDm.messages.length > FOLD;
                                            const shownThread = folded ? { ...activeDm, messages: activeDm.messages.slice(-FOLD) } : activeDm;
                                            return (
                                                <div className="space-y-1.5">
                                                    <div className="flex items-center justify-between mb-1">
                                                        <button onClick={() => setDmOpenId(null)} className="flex items-center gap-1 text-[11px] font-bold text-white/80 active:scale-95 transition-transform">
                                                            <CaretRight size={12} weight="bold" className="rotate-180" />{otherName}
                                                        </button>
                                                        {onEditContent && <span className="text-[8px] text-white/35">点按消息可编辑/删除</span>}
                                                    </div>
                                                    {folded && (
                                                        <button onClick={() => setDmExpanded(true)} className="w-full text-[10px] font-bold py-1.5 rounded-full bg-white/10 text-white/60 active:scale-95 transition-transform">
                                                            展开更早的 {activeDm.messages.length - FOLD} 条
                                                        </button>
                                                    )}
                                                    <ThreadBubbles thread={shownThread} selfId={ownerId} members={members} npcs={world.npcs}
                                                        onPick={onEditContent ? m => setEditing({ target: { type: 'msg', threadId: activeDm.id, msgId: m.id }, text: m.text, title: '编辑这条私信', canDelete: true }) : undefined} />
                                                </div>
                                            );
                                        })()
                                        : (
                                            // 联系人列表：每个聊过的人一行，点进去看会话
                                            <div className="space-y-1.5">
                                                {dmThreads.map(t => {
                                                    const otherId = t.memberIds.find(id => id !== ownerId) || '';
                                                    const otherName = nameById(otherId);
                                                    const av = avatarById(otherId);
                                                    const isNpc = world.npcs.some(n => n.id === otherId);
                                                    const last = t.messages[t.messages.length - 1];
                                                    return (
                                                        <button key={t.id} onClick={() => setDmOpenId(t.id)}
                                                            className="w-full flex items-center gap-2.5 rounded-2xl bg-white/95 px-3 py-2.5 text-left active:scale-[0.98] transition-transform">
                                                            {av
                                                                ? <TokenImg value={av} className="w-9 h-9 rounded-full object-cover shrink-0" alt="" />
                                                                : <div className="w-9 h-9 rounded-full bg-slate-200 flex items-center justify-center text-[14px] shrink-0">{isNpc ? (world.npcs.find(n => n.id === otherId)?.emoji || '🙂') : otherName.slice(0, 1)}</div>}
                                                            <div className="min-w-0 flex-1">
                                                                <div className="flex items-center gap-1.5">
                                                                    <span className="text-[12.5px] font-bold text-slate-800 truncate">{otherName}</span>
                                                                    {isNpc && <span className="text-[8px] font-bold px-1 rounded bg-slate-100 text-slate-400 shrink-0">NPC</span>}
                                                                </div>
                                                                {last && <div className="text-[10.5px] text-slate-400 truncate">{last.fromId === ownerId ? '我：' : ''}{last.text}</div>}
                                                            </div>
                                                            <span className="text-[9px] text-slate-300 shrink-0">{t.messages.length}</span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )
                            )}
                            {tab === 'group' && (
                                !group || group.messages.length === 0
                                    ? <div className="text-center text-[11px] text-white/40 pt-16">群里还没人说话</div>
                                    : (() => {
                                        const folded = !groupExpanded && group.messages.length > FOLD;
                                        const shownGroup = folded ? { ...group, messages: group.messages.slice(-FOLD) } : group;
                                        return (
                                            <div className="space-y-1.5">
                                                <div className="text-center text-[9px] text-white/40 font-bold pb-1">「{group.name}」 · {group.memberIds.length} 人{world.npcs.length > 0 ? ` + ${world.npcs.length} NPC` : ''}{onEditContent ? ' · 点按消息可编辑/删除' : ''}</div>
                                                {folded && (
                                                    <button onClick={() => setGroupExpanded(true)} className="w-full text-[10px] font-bold py-1.5 rounded-full bg-white/10 text-white/60 active:scale-95 transition-transform">
                                                        展开更早的 {group.messages.length - FOLD} 条
                                                    </button>
                                                )}
                                                <ThreadBubbles thread={shownGroup} selfId={ownerId} members={members} npcs={world.npcs} showNames
                                                    onPick={onEditContent ? m => setEditing({ target: { type: 'msg', threadId: group.id, msgId: m.id }, text: m.text, title: '编辑这条群消息', canDelete: true }) : undefined} />
                                            </div>
                                        );
                                    })()
                            )}
                            {tab === 'memo' && (
                                memos.length === 0
                                    ? <div className="text-center text-[11px] text-white/40 pt-16">备忘录是空的</div>
                                    : (() => {
                                        const pages = Math.max(1, Math.ceil(memos.length / PER));
                                        const p = Math.min(memoPage, pages - 1);
                                        return (<>
                                            {memos.slice(p * PER, p * PER + PER).map((m, i) => (
                                                <div key={i} className="rounded-xl bg-amber-50/95 border-l-4 border-amber-300 px-3 py-2 shadow-sm"
                                                    style={{ transform: `rotate(${i % 2 === 0 ? '-0.4' : '0.4'}deg)` }}>
                                                    <div className="flex items-center gap-1.5">
                                                        <div className="text-[8.5px] text-amber-500 font-bold">{m.storyTime}</div>
                                                        {onEditContent && (
                                                            <button onClick={() => setEditing({ target: { type: 'memo', round: m.round, charId: ownerId, idx: m.idx }, text: m.text, title: '编辑备忘', canDelete: true })}
                                                                className="ml-auto flex items-center gap-0.5 text-[8.5px] font-bold text-amber-500 active:scale-95">
                                                                <NotePencil size={10} />编辑
                                                            </button>
                                                        )}
                                                    </div>
                                                    <p className="text-[11.5px] leading-[1.55] text-amber-950 mt-0.5 whitespace-pre-wrap">{m.text}</p>
                                                </div>
                                            ))}
                                            {pages > 1 && (
                                                <div className="flex items-center justify-center gap-3 pt-1">
                                                    <button onClick={() => setMemoPage(Math.max(0, p - 1))} disabled={p === 0} className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-white/10 text-white/70 disabled:opacity-30">上一页</button>
                                                    <span className="text-[10px] text-white/50 tabular-nums">{p + 1}/{pages}</span>
                                                    <button onClick={() => setMemoPage(Math.min(pages - 1, p + 1))} disabled={p >= pages - 1} className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-white/10 text-white/70 disabled:opacity-30">下一页</button>
                                                </div>
                                            )}
                                        </>);
                                    })()
                            )}
                        </div>
                        {/* home indicator */}
                        <div className="pb-2 pt-1 flex justify-center shrink-0"><div className="w-24 h-1 rounded-full bg-white/30" /></div>

                        {/* 编辑/删除生成内容的底部弹层 */}
                        {editing && (
                            <div className="absolute inset-0 z-30 flex items-end bg-black/40 backdrop-blur-[2px]" onClick={() => setEditing(null)}>
                                <div className="w-full rounded-t-3xl bg-[#f7f3ea] p-4 shadow-2xl" onClick={e => e.stopPropagation()}>
                                    <div className="flex items-center justify-between mb-2">
                                        <h4 className="text-[13px] font-black text-stone-800">{editing.title}</h4>
                                        <button onClick={() => setEditing(null)} className="p-1 rounded-full hover:bg-black/5"><X size={15} weight="bold" className="text-stone-400" /></button>
                                    </div>
                                    <textarea autoFocus value={editing.text} onChange={e => setEditing(ed => ed ? { ...ed, text: e.target.value } : ed)} rows={4}
                                        className="w-full px-3 py-2 rounded-xl bg-white border border-stone-200 text-[12.5px] leading-relaxed text-stone-800 focus:outline-none focus:border-amber-400 resize-none" />
                                    <div className="flex items-center gap-2 mt-3">
                                        {editing.canDelete && (
                                            confirmDel ? (
                                                <button onClick={() => submitEdit(null)} className="flex items-center gap-1 px-3 py-2 rounded-xl bg-rose-500 text-white text-[12px] font-bold active:scale-95 transition-transform">
                                                    <Trash size={13} weight="bold" />确认删除
                                                </button>
                                            ) : (
                                                <button onClick={() => setConfirmDel(true)} className="flex items-center gap-1 px-3 py-2 rounded-xl bg-white border border-rose-200 text-rose-500 text-[12px] font-bold active:scale-95 transition-transform">
                                                    <Trash size={13} weight="bold" />删除
                                                </button>
                                            )
                                        )}
                                        <button onClick={() => setEditing(null)} className="ml-auto px-3 py-2 rounded-xl bg-white border border-stone-200 text-stone-500 text-[12px] font-bold active:scale-95 transition-transform">取消</button>
                                        <button onClick={() => submitEdit(editing.text.trim())} disabled={!editing.text.trim()}
                                            className="px-4 py-2 rounded-xl bg-stone-900 text-white text-[12px] font-bold disabled:opacity-40 active:scale-95 transition-transform">保存</button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// 编辑器
// ============================================================
const WorldEditor: React.FC<{
    draft: WorldProfile;
    characters: CharacterProfile[];
    /** 已解析的家园 API（全局家园设置 ?? 全局聊天默认），AI roll NPC 用 */
    apiConfig: APIConfig;
    addToast: (m: string, t?: any) => void;
    onSave: (w: WorldProfile) => void;
    onCancel: () => void;
    onDelete?: () => void;
}> = ({ draft, characters, apiConfig, addToast, onSave, onCancel, onDelete }) => {
    const [w, setW] = useState<WorldProfile>(draft);
    const upd = (updates: Partial<WorldProfile>) => setW(prev => ({ ...prev, ...updates }));
    // 「住进这个世界的角色」多选的分组筛选（只影响显示哪些可选项，已选成员不受影响）
    const { characterGroups } = useOS();
    const [memberGroupId, setMemberGroupId] = useState<string>(GROUP_FILTER_ALL);
    const members = useMemo(() => w.memberIds.map(id => characters.find(c => c.id === id)).filter(Boolean) as CharacterProfile[], [w.memberIds, characters]);

    // AI roll NPC
    const [rolling, setRolling] = useState(false);
    const rollNpcs = async () => {
        const api = w.api?.baseUrl ? w.api : apiConfig;
        if (!api?.baseUrl) { addToast('还没有可用的 API（先在设置里配一个，或给这个世界选个预设）', 'error'); return; }
        setRolling(true);
        trackEvent('用 AI roll 出 NPC');
        try {
            const baseUrl = api.baseUrl.replace(/\/+$/, '');
            const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey || 'sk-none'}` },
                body: JSON.stringify({
                    model: api.model,
                    messages: [{ role: 'user', content: buildNpcRollPrompt({
                        worldName: w.name || '这个世界',
                        worldview: w.worldview,
                        members: members.map(m => ({ name: m.name, persona: (m.description || m.systemPrompt || '').replace(/\s+/g, ' ').trim().slice(0, 200) })),
                        count: 3,
                        existingNames: w.npcs.map(n => n.name).filter(Boolean),
                    }) }],
                    temperature: 0.95, stream: false,
                }),
            }, 2, 0, { appName: '家园', purpose: `roll NPC · ${w.name || '新世界'}` });
            const rolled = parseRolledNpcs(data.choices?.[0]?.message?.content || '', w.npcs.map(n => n.name));
            if (rolled.length === 0) { addToast('这次没 roll 出新的，再试一次？', 'error'); return; }
            upd({ npcs: [...w.npcs, ...rolled.map(n => ({ id: genId('npc'), name: n.name, persona: n.persona, emoji: n.emoji }))] });
            addToast(`roll 到 ${rolled.length} 个 NPC，可以再改`, 'success');
        } catch (e) {
            addToast('roll 失败了，检查下 API', 'error');
        } finally {
            setRolling(false);
        }
    };

    // 自定义文风收藏
    const [savedStyles, setSavedStyles] = useState<string[]>(loadSavedStyles);
    const saveCurrentStyle = () => {
        const txt = (w.narrativeStyleCustom || '').trim();
        if (!txt) return;
        const next = [txt, ...savedStyles.filter(s => s !== txt)].slice(0, 12);
        setSavedStyles(next); persistSavedStyles(next);
        addToast('文风已收藏，下次创建世界能直接选', 'success');
    };
    const removeSavedStyle = (txt: string) => {
        const next = savedStyles.filter(s => s !== txt);
        setSavedStyles(next); persistSavedStyles(next);
    };

    const toggleMember = (id: string) => {
        if (w.memberIds.includes(id)) {
            upd({
                memberIds: w.memberIds.filter(m => m !== id),
                houses: w.houses.map(h => ({ ...h, residentIds: h.residentIds.filter(r => r !== id) })),
                relationships: w.relationships.filter(r => r.fromId !== id && r.toId !== id),
            });
        } else {
            upd({ memberIds: [...w.memberIds, id] });
        }
    };

    const toggleResident = (houseId: string, charId: string) => {
        upd({
            houses: w.houses.map(h => {
                if (h.id !== houseId) return { ...h, residentIds: h.residentIds.filter(r => r !== charId) };
                return h.residentIds.includes(charId)
                    ? { ...h, residentIds: h.residentIds.filter(r => r !== charId) }
                    : { ...h, residentIds: [...h.residentIds, charId] };
            }),
        });
    };

    // 成员两两关系（编辑用：每对展开成 A→B 和 B→A 两条有向边，可以不对等）
    const pairs = useMemo(() => {
        const out: { aId: string; bId: string; aName: string; bName: string }[] = [];
        for (let i = 0; i < members.length; i++) {
            for (let j = i + 1; j < members.length; j++) {
                out.push({ aId: members[i].id, bId: members[j].id, aName: members[i].name, bName: members[j].name });
            }
        }
        return out;
    }, [members]);

    const relOf = (fromId: string, toId: string) => w.relationships.find(r => r.fromId === fromId && r.toId === toId);
    const updRel = (fromId: string, toId: string, updates: { label?: string; value?: number }) => {
        const existing = relOf(fromId, toId);
        if (existing) {
            upd({ relationships: w.relationships.map(r => (r.fromId === fromId && r.toId === toId) ? { ...r, ...updates } : r) });
        } else {
            upd({ relationships: [...w.relationships, { fromId, toId, value: 0, ...updates }] });
        }
    };

    const inputCls = 'w-full px-3 py-2 rounded-xl bg-white/90 border border-stone-200 text-sm text-stone-800 focus:outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-200/50 transition-shadow';
    const sectionCls = 'bg-white/80 backdrop-blur rounded-2xl p-4 border border-stone-200/80 shadow-[0_2px_12px_rgba(60,50,30,.06)] space-y-2.5';
    const labelCls = 'text-[10.5px] font-black text-stone-500 tracking-[0.12em] uppercase';

    return (
        <div
            className="flex-1 overflow-y-auto no-scrollbar px-4 pt-3 space-y-3"
            style={{ paddingBottom: 'calc(7rem + var(--safe-bottom, 0px))', boxSizing: 'border-box' }}
        >
            <div className={sectionCls}>
                <div className={labelCls}>世界名字</div>
                <input className={inputCls} value={w.name} onChange={e => upd({ name: e.target.value })} placeholder="比如：栗子镇" />
                <div className={labelCls}>世界观（这个世界是什么样的、大家以什么身份生活）</div>
                <textarea className={`${inputCls} h-28 resize-none`} value={w.worldview} onChange={e => upd({ worldview: e.target.value })}
                    placeholder="一个海边小镇，大家是多年的老邻居。镇上有一家面包店和一座旧灯塔……" />
            </div>

            <div className={sectionCls}>
                <div className={labelCls}>时间模式（世界开始后不可改，先想清楚）{w.storyClock > 0 && <span className="text-stone-400 normal-case tracking-normal font-medium">　· 已开始，锁定</span>}</div>
                {(Object.keys(TIME_MODE_INFO) as WorldTimeMode[]).map(tm => {
                    const on = (w.timeMode || 'real') === tm;
                    const locked = w.storyClock > 0;
                    return (
                        <button key={tm} disabled={locked && !on} onClick={() => {
                            if (locked) return;
                            if (tm === 'sim' && !w.simStartDate) {
                                const now = new Date();
                                upd({ timeMode: tm, simStartDate: { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() } });
                            } else {
                                upd({ timeMode: tm });
                            }
                            trackEvent('选择世界时间模式', { timeMode: tm });
                        }}
                            className={`w-full text-left px-3.5 py-2.5 rounded-xl border transition-all disabled:opacity-40 ${on ? 'bg-stone-900 border-stone-900 text-white shadow-lg' : 'bg-white border-stone-200 text-stone-700'}`}>
                            <div className="text-[12px] font-bold flex items-center gap-2">
                                {TIME_MODE_INFO[tm].name}
                                {on && <span className={`text-[8.5px] px-1.5 py-0.5 rounded-full font-black ${TIME_MODE_INFO[tm].badge}`}>已选</span>}
                            </div>
                            <div className={`text-[10.5px] mt-0.5 leading-snug ${on ? 'text-white/70' : 'text-stone-500'}`}>{TIME_MODE_INFO[tm].desc}</div>
                            <div className={`text-[10px] mt-1 leading-snug ${on ? 'text-amber-200/90' : 'text-amber-700/80'}`}>💡 {TIME_MODE_INFO[tm].hint}</div>
                        </button>
                    );
                })}
                {(w.timeMode || 'real') === 'sim' && (
                    <div className="rounded-xl border border-violet-200 bg-violet-50/60 p-2.5 space-y-2">
                        <div className="text-[10.5px] font-bold text-violet-700">起始日期（模拟时间从这天开始走）</div>
                        <div className="flex items-center gap-1.5">
                            <input type="number" min={1} className="w-[72px] px-2 py-1 rounded-lg bg-white border border-violet-200 text-[12px] text-center"
                                value={w.simStartDate?.year ?? new Date().getFullYear()}
                                onChange={e => upd({ simStartDate: { year: parseInt(e.target.value, 10) || 1, month: w.simStartDate?.month ?? 1, day: w.simStartDate?.day ?? 1 } })} />
                            <span className="text-[12px] text-violet-600">年</span>
                            <input type="number" min={1} max={12} className="w-[52px] px-2 py-1 rounded-lg bg-white border border-violet-200 text-[12px] text-center"
                                value={w.simStartDate?.month ?? 1}
                                onChange={e => upd({ simStartDate: { year: w.simStartDate?.year ?? new Date().getFullYear(), month: Math.min(12, Math.max(1, parseInt(e.target.value, 10) || 1)), day: w.simStartDate?.day ?? 1 } })} />
                            <span className="text-[12px] text-violet-600">月</span>
                            <input type="number" min={1} max={31} className="w-[52px] px-2 py-1 rounded-lg bg-white border border-violet-200 text-[12px] text-center"
                                value={w.simStartDate?.day ?? 1}
                                onChange={e => upd({ simStartDate: { year: w.simStartDate?.year ?? new Date().getFullYear(), month: w.simStartDate?.month ?? 1, day: Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 1)) } })} />
                            <span className="text-[12px] text-violet-600">日</span>
                        </div>
                        <div className="text-[9.5px] text-violet-500 leading-snug">每 {SIM_CHAPTER_DAYS} 天（{SIM_CHAPTER_CLOCKS} 次观测/tick）自动结一卷：生成小说体总结 + 每个角色单方面视角，归档原文。不写入聊天与记忆。</div>
                    </div>
                )}
                {(w.timeMode || 'real') === 'real' && (
                    <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-2.5 space-y-2">
                        <div className="text-[10.5px] font-bold text-sky-700">世界所在时区（随时可改）</div>
                        <select className={inputCls} value={w.timezone || ''}
                            onChange={e => {
                                const tz = e.target.value || undefined;
                                const patch: Partial<WorldProfile> = { timezone: tz };
                                // 往西换时区会让世界的「现在」倒退，旧时钟落在未来 → 观测一路判"已追上现实"
                                // 直接卡死。这里顺手把时钟压回当下那一段。
                                const probe: WorldProfile = { ...w, timezone: tz };
                                if (clampRealClockToNow(probe)) patch.realClock = probe.realClock;
                                upd(patch);
                            }}>
                            <option value="">跟随本机时间（默认）</option>
                            {COMMON_TIMEZONES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                        </select>
                        <div className="text-[9.5px] text-sky-600 leading-snug">
                            一个世界只有一把钟：设了之后，早/中/晚/凌晨的段判定、离线运转的触发时刻、以及注入给<b>每个成员</b>的「当前时间」都按这个时区走。
                            它会<b>覆盖</b>成员在「神经链接」里各自设的自定义时区——同一个世界里的人不可能各活一个时区，不覆盖的话世界钟和角色的时间会互相打架。
                        </div>
                    </div>
                )}
            </div>

            <div className={sectionCls}>
                <div className={labelCls}>模式（你在这个世界里的存在感）</div>
                {(Object.keys(MODE_INFO) as WorldHomeMode[]).map(m => (
                    <button key={m} onClick={() => { upd({ mode: m }); trackEvent('选择世界存在感模式', { mode: m }); }}
                        className={`w-full text-left px-3.5 py-2.5 rounded-xl border transition-all ${w.mode === m ? 'bg-stone-900 border-stone-900 text-white shadow-lg' : 'bg-white border-stone-200 text-stone-700'}`}>
                        <div className="text-[12px] font-bold flex items-center gap-2">
                            {MODE_INFO[m].name}
                            {w.mode === m && <span className={`text-[8.5px] px-1.5 py-0.5 rounded-full font-black ${MODE_INFO[m].badge}`}>已选</span>}
                        </div>
                        <div className={`text-[10.5px] mt-0.5 leading-snug ${w.mode === m ? 'text-white/70' : 'text-stone-500'}`}>{MODE_INFO[m].desc}</div>
                    </button>
                ))}
            </div>

            <div className={sectionCls}>
                <div className={labelCls}>正文文风（每轮大段正文按这个写）</div>
                <div className="grid grid-cols-2 gap-1.5">
                    {(Object.keys(NARRATIVE_STYLES) as Exclude<WorldNarrativeStyle, 'custom'>[]).map(s => (
                        <button key={s} onClick={() => upd({ narrativeStyle: s })}
                            className={`text-left px-3 py-2 rounded-xl border transition-all ${(w.narrativeStyle || 'warm') === s ? 'bg-stone-900 border-stone-900 text-white shadow-md' : 'bg-white border-stone-200 text-stone-700'}`}>
                            <div className="text-[12px] font-bold">{NARRATIVE_STYLES[s].name}</div>
                            <div className={`text-[9.5px] mt-0.5 leading-snug line-clamp-2 ${(w.narrativeStyle || 'warm') === s ? 'text-white/65' : 'text-stone-400'}`}>{NARRATIVE_STYLES[s].guide.slice(0, 40)}…</div>
                        </button>
                    ))}
                </div>
                <button onClick={() => upd({ narrativeStyle: 'custom' })}
                    className={`w-full text-left px-3 py-2 rounded-xl border transition-all ${w.narrativeStyle === 'custom' ? 'bg-stone-900 border-stone-900 text-white shadow-md' : 'bg-white border-stone-200 text-stone-700'}`}>
                    <div className="text-[12px] font-bold">自定义文风</div>
                </button>
                {w.narrativeStyle === 'custom' && (
                    <div className="space-y-2">
                        <textarea className={`${inputCls} h-20 resize-none`} value={w.narrativeStyleCustom || ''}
                            onChange={e => upd({ narrativeStyleCustom: e.target.value })}
                            placeholder="描述你想要的文风：比如「古早港风言情，对白多，画面感强，带一点宿命感」" />
                        <div className="flex items-center justify-between">
                            <span className="text-[10px] text-stone-400">收藏后下次创建世界能直接选用</span>
                            <button onClick={saveCurrentStyle} disabled={!(w.narrativeStyleCustom || '').trim()}
                                className="text-[11px] px-2.5 py-1 rounded-lg bg-stone-900 text-white font-bold flex items-center gap-1 disabled:opacity-40 active:scale-95 transition-transform">
                                <Heart size={11} weight="fill" />收藏这个文风</button>
                        </div>
                        {savedStyles.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 pt-0.5">
                                {savedStyles.map((s, i) => (
                                    <span key={i} className={`group flex items-center gap-1 max-w-full text-[10.5px] px-2 py-1 rounded-full border transition-all ${w.narrativeStyleCustom === s ? 'bg-stone-900 border-stone-900 text-white' : 'bg-white border-stone-200 text-stone-600'}`}>
                                        <button onClick={() => upd({ narrativeStyleCustom: s })} className="truncate max-w-[180px] text-left">{s.slice(0, 28)}{s.length > 28 ? '…' : ''}</button>
                                        <button onClick={() => removeSavedStyle(s)} className="opacity-50 hover:opacity-100 shrink-0"><X size={11} weight="bold" /></button>
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                <div className="pt-1">
                    <div className={`${labelCls} mb-1.5`}>叙述人称（大段正文怎么称呼自己）</div>
                    <div className="grid grid-cols-2 gap-1.5">
                        {([['first', '第一人称', '「我推开门…」'], ['third', '第三人称', `「${members[0]?.name || '名字'}推开门…」`]] as const).map(([p, name, hint]) => {
                            const on = (w.narrationPerson || 'first') === p;
                            return (
                                <button key={p} onClick={() => upd({ narrationPerson: p })}
                                    className={`px-2.5 py-2 rounded-xl border text-left transition-all ${on ? 'bg-stone-900 border-stone-900 text-white shadow-md' : 'bg-white border-stone-200 text-stone-700'}`}>
                                    <div className="text-[12px] font-bold">{name}</div>
                                    <div className={`text-[10px] mt-0.5 ${on ? 'text-white/65' : 'text-stone-400'}`}>{hint}</div>
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>

            <div className={sectionCls}>
                <div className={labelCls}>住进这个世界的角色（同一世界观的放一起）</div>
                {/* 分组筛选只影响下方显示哪些可选项，已选成员不会因为切组被移除 */}
                <CharacterGroupFilterBar characters={characters} groups={characterGroups}
                    value={memberGroupId} onChange={setMemberGroupId} />
                <div className="flex flex-wrap gap-2">
                    {filterCharactersByGroup(characters, characterGroups, memberGroupId).map(c => (
                        <button key={c.id} onClick={() => toggleMember(c.id)}
                            className={`flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full border transition-all ${w.memberIds.includes(c.id) ? 'bg-stone-900 border-stone-900 text-white shadow-md' : 'bg-white border-stone-200 text-stone-700'}`}>
                            <TokenImg value={c.avatar} className="w-6 h-6 rounded-full object-cover" alt="" />
                            <span className="text-[12px] font-semibold">{c.name}</span>
                        </button>
                    ))}
                </div>
                {characters.length === 0 && <div className="text-[11px] text-stone-400">还没有角色，先去「神经链接」创建</div>}
                {characters.length > 0 && filterCharactersByGroup(characters, characterGroups, memberGroupId).length === 0 &&
                    <div className="text-[11px] text-stone-400">该分组下没有角色</div>}
            </div>

            <div className={sectionCls}>
                <div className="flex items-center justify-between">
                    <div className={labelCls}>居住安排（没分进小屋的成员独居）</div>
                    <button onClick={() => upd({ houses: [...w.houses, { id: genId('wh'), name: `小屋 ${w.houses.length + 1}`, residentIds: [] }] })}
                        className="text-[11px] px-2.5 py-1 rounded-lg bg-amber-100 text-amber-800 font-bold flex items-center gap-1 border border-amber-200"><Plus size={12} weight="bold" />同居小屋</button>
                </div>
                {w.houses.map(h => (
                    <div key={h.id} className="rounded-xl border border-stone-200 bg-white p-2.5 space-y-2">
                        <div className="flex items-center gap-2">
                            <House size={14} className="text-amber-600 shrink-0" weight="fill" />
                            <input className="flex-1 px-2 py-1 rounded-lg bg-stone-50 border border-stone-100 text-[12px]" value={h.name}
                                onChange={e => upd({ houses: w.houses.map(x => x.id === h.id ? { ...x, name: e.target.value } : x) })} />
                            <button onClick={() => upd({ houses: w.houses.filter(x => x.id !== h.id) })} className="p-1 text-stone-400"><X size={14} /></button>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {members.map(m => (
                                <button key={m.id} onClick={() => toggleResident(h.id, m.id)}
                                    className={`text-[11px] px-2 py-0.5 rounded-full border ${h.residentIds.includes(m.id) ? 'bg-amber-500 border-amber-500 text-white' : 'bg-white border-stone-200 text-stone-600'}`}>
                                    {m.name}
                                </button>
                            ))}
                            {members.length === 0 && <span className="text-[10px] text-stone-400">先在上面选成员</span>}
                        </div>
                    </div>
                ))}
            </div>

            <div className={sectionCls}>
                <div className="flex items-center justify-between gap-2">
                    <div className={labelCls}>NPC（无记忆，只为撑世界观）</div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        <button onClick={rollNpcs} disabled={rolling}
                            className="text-[11px] px-2.5 py-1 rounded-lg bg-violet-100 text-violet-700 font-bold flex items-center gap-1 border border-violet-200 disabled:opacity-50 active:scale-95 transition-transform">
                            <Sparkle size={12} weight="fill" />{rolling ? 'roll 中…' : 'AI roll'}</button>
                        <button onClick={() => upd({ npcs: [...w.npcs, { id: genId('npc'), name: '', persona: '', emoji: '🙂' }] })}
                            className="text-[11px] px-2.5 py-1 rounded-lg bg-amber-100 text-amber-800 font-bold flex items-center gap-1 border border-amber-200"><Plus size={12} weight="bold" />NPC</button>
                    </div>
                </div>
                <div className="text-[10px] text-stone-400 leading-snug -mt-1">AI roll：让模型读一遍世界观和角色们的人设，自动配几个贴合的配角，可再手动改。</div>
                {w.npcs.map(n => (
                    <div key={n.id} className="rounded-xl border border-stone-200 bg-white p-2.5 space-y-1.5">
                        <div className="flex items-center gap-2">
                            <input className="w-10 px-1 py-1 rounded-lg bg-stone-50 border border-stone-100 text-center text-[14px]" value={n.emoji || ''} maxLength={2}
                                onChange={e => upd({ npcs: w.npcs.map(x => x.id === n.id ? { ...x, emoji: e.target.value } : x) })} />
                            <input className="flex-1 px-2 py-1 rounded-lg bg-stone-50 border border-stone-100 text-[12px]" value={n.name} placeholder="名字"
                                onChange={e => upd({ npcs: w.npcs.map(x => x.id === n.id ? { ...x, name: e.target.value } : x) })} />
                            <button onClick={() => upd({ npcs: w.npcs.filter(x => x.id !== n.id) })} className="p-1 text-stone-400"><X size={14} /></button>
                        </div>
                        <input className="w-full px-2 py-1 rounded-lg bg-stone-50 border border-stone-100 text-[12px]" value={n.persona} placeholder="一句话人设（面包店老板娘，热心肠爱塞吃的）"
                            onChange={e => upd({ npcs: w.npcs.map(x => x.id === n.id ? { ...x, persona: e.target.value } : x) })} />
                    </div>
                ))}
            </div>

            {pairs.length > 0 && (
                <div className={sectionCls}>
                    <div className={labelCls}>初始关系（有向：两边可以不对等，比如单恋/单方面死对头；演绎会各自调整）</div>
                    {pairs.map(p => (
                        <div key={`${p.aId}_${p.bId}`} className="rounded-xl border border-stone-200 bg-white p-2.5 space-y-2.5">
                            {([[p.aId, p.bId, p.aName, p.bName], [p.bId, p.aId, p.bName, p.aName]] as const).map(([fromId, toId, fromName, toName]) => {
                                const rel = relOf(fromId, toId);
                                return (
                                    <div key={`${fromId}_${toId}`} className="space-y-1.5">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[12px] font-bold text-stone-700 shrink-0">{fromName} → {toName}</span>
                                            <input className="flex-1 min-w-0 px-2 py-0.5 rounded-lg bg-stone-50 border border-stone-100 text-[11px]" placeholder={`${fromName} 眼中的关系（挚友/单恋/死对头…）`}
                                                value={rel?.label || ''} onChange={e => updRel(fromId, toId, { label: e.target.value })} />
                                            <span className={`text-[11px] font-bold w-8 text-right ${(rel?.value ?? 0) < 0 ? 'text-rose-600' : 'text-amber-700'}`}>{rel?.value ?? 0}</span>
                                        </div>
                                        <input type="range" min={-100} max={100} value={rel?.value ?? 0} className="w-full accent-amber-500"
                                            onChange={e => updRel(fromId, toId, { value: parseInt(e.target.value, 10) })} />
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
            )}

            {(w.timeMode || 'real') === 'real' && (
                <div className={sectionCls}>
                    <div className={labelCls}>记忆与聊天</div>
                    <label className="flex items-center justify-between">
                        <span className="text-[12px] text-stone-700">把这个世界发生的事同步进和角色的聊天、记忆里</span>
                        <input type="checkbox" checked={w.injectToChat !== false} onChange={e => upd({ injectToChat: e.target.checked })} className="w-4 h-4 accent-amber-500" />
                    </label>
                    <div className="text-[10px] text-stone-400 leading-snug">世界靠你主动「观测」推进一段（早/午/晚/凌晨四段时光流逝），需要的时候来点一下就行。</div>
                </div>
            )}

            {onDelete && (
                <button onClick={onDelete} className="w-full py-2.5 rounded-2xl border border-red-200 bg-white/70 text-red-500 text-[12px] font-bold flex items-center justify-center gap-1.5">
                    <Trash size={14} weight="bold" />删除这个世界（连同演绎历史）
                </button>
            )}

            {/* 用量提示：一次观测 ≈ 角色数 + 1 次 API（NPC 引擎 1 次 + 每个角色各 1 次） */}
            <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-3 text-[11px] leading-relaxed text-amber-800">
                ⚠️ 每次「观测」大约会调用 <b>{Math.max(1, w.memberIds.length)}+1</b> 次 API（{w.memberIds.length} 个角色各 1 次 + NPC 世界引擎 1 次{w.timeMode === 'sim' ? '，每 20 天结卷再多 1 次' : ''}）。角色越多越费，请留意用量；建议在右上角 <b>齿轮</b> 给家园单独配一份<b>更轻量/便宜的 API</b>。
            </div>

            <div
                className="fixed bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-[#f3eee3] via-[#f3eee3]/95 to-transparent flex gap-2.5 max-w-md mx-auto"
                style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom, 0px))' }}
            >
                <button onClick={onCancel} className="flex-1 py-2.5 rounded-2xl bg-white border border-stone-200 text-stone-600 text-[13px] font-bold shadow-sm">取消</button>
                <button
                    onClick={() => {
                        const cleaned: WorldProfile = {
                            ...w,
                            name: w.name.trim() || '未命名世界',
                            npcs: w.npcs.filter(n => n.name.trim()),
                            api: w.api?.baseUrl?.trim() ? w.api : undefined,
                            updatedAt: Date.now(),
                        };
                        onSave(cleaned);
                    }}
                    disabled={w.memberIds.length === 0}
                    className="flex-[2] py-2.5 rounded-2xl bg-stone-900 text-white text-[13px] font-bold disabled:opacity-40 shadow-lg">
                    保存世界
                </button>
            </div>
        </div>
    );
};

/** 冲动决策卡：user 帮角色拿主意（写进 world.directives，下一轮以"心里的声音"注入）。 */
const ImpulseCard: React.FC<{
    impulse: { text: string; options?: string[] };
    existing?: { text: string };
    textMain: string;
    onSend: (text: string) => void;
}> = ({ impulse, existing, textMain, onSend }) => {
    const [custom, setCustom] = useState('');
    return (
        <div className="mt-2.5 rounded-xl border border-violet-400/40 bg-violet-400/10 p-2.5">
            <div className="text-[9px] font-black text-violet-500 tracking-wider flex items-center gap-1">
                <Sparkle size={10} weight="fill" />状态背后 · TA 此刻的冲动
            </div>
            <p className={`text-[12px] font-semibold mt-1 ${textMain}`}>{impulse.text}</p>
            {existing ? (
                <div className="mt-1.5 text-[10px] text-violet-500 font-bold flex items-center gap-1">
                    <PaperPlaneTilt size={10} weight="fill" />你的心声已传达：「{existing.text}」——下一轮生效
                </div>
            ) : (
                <>
                    {impulse.options && impulse.options.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {impulse.options.map((o, i) => (
                                <button key={i} onClick={() => onSend(o)}
                                    className="text-[10.5px] font-bold px-2.5 py-1 rounded-full bg-violet-500 text-white active:scale-95 transition-transform">
                                    {o}
                                </button>
                            ))}
                        </div>
                    )}
                    <div className="mt-1.5 flex gap-1.5">
                        <input value={custom} onChange={e => setCustom(e.target.value)}
                            placeholder="或者，悄悄说点别的…"
                            className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-white/80 border border-violet-300/50 text-[11px] text-stone-800 focus:outline-none" />
                        <button disabled={!custom.trim()} onClick={() => { onSend(custom.trim()); setCustom(''); }}
                            className="px-2.5 rounded-lg bg-violet-500 text-white disabled:opacity-40 active:scale-95 transition-transform">
                            <PaperPlaneTilt size={13} weight="fill" />
                        </button>
                    </div>
                    <div className="text-[8.5px] text-violet-400 mt-1">会化作"心里的声音"在下一轮影响 ta 的选择</div>
                </>
            )}
        </div>
    );
};

/**
 * 一个住户「这半天」的折叠卡。
 * 默认只露脸：小人 + 名字 + 心情 + 一行剧透；点开才翻出完整正文/时间轴/对话/备忘/状态，
 * 免得一展开小屋就被一整面墙的正文糊脸（更像翻一本小书的某一页）。
 */
const ResidentDayCard: React.FC<{
    char: CharacterProfile;
    beat?: WorldCharBeat;
    t: any;
    world: WorldProfile;
    onPhone: () => void;
    onDirective: (impulseText: string, text: string) => void;
    onReroll?: () => void;
    onInject?: () => void;
}> = ({ char, beat: b, t, world, onPhone, onDirective, onReroll, onInject }) => {
    const [open, setOpen] = useState(false);
    if (!b) {
        return (
            <div className={`flex items-center gap-2 rounded-xl border px-2.5 py-2 ${t.panelSolid}`}>
                <ChibiFigure char={char} size={30} />
                <span className={`text-[11px] ${t.textSub}`}>{char.name} 这半天还没有故事</span>
                <button onClick={onPhone} className="ml-auto flex items-center gap-1 text-[9.5px] font-black px-2 py-1 rounded-lg bg-slate-900 text-white shadow active:scale-95 transition-transform shrink-0">
                    <DeviceMobile size={11} weight="fill" />手机
                </button>
            </div>
        );
    }
    const teaser = (b.timeline?.find(tl => tl.shared)?.event) || b.narrative.replace(/\s+/g, ' ').trim().slice(0, 30);
    const hasDirective = !!(world.directives || []).find(d => d.charId === b.charId);
    return (
        <div className={`rounded-xl border overflow-hidden ${t.panelSolid}`}>
            {/* 露脸条：可点开/收起 + 看手机 */}
            <div className="flex items-stretch">
                <button onClick={() => setOpen(o => !o)} className="flex-1 min-w-0 text-left flex items-center gap-2 px-2 py-2">
                    <div className="rounded-lg px-1 pt-1 shrink-0" style={{ background: t.lawnBg }}><ChibiFigure char={char} size={36} bob={open} /></div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                            <span className={`text-[12px] font-black ${t.textMain}`}>{b.charName}</span>
                            <span className="text-[8.5px] font-bold px-1.5 py-0.5 rounded-full bg-amber-400/20 text-amber-600 border border-amber-400/30">{b.mood}</span>
                            {b.impulse && <span className="text-[8px] font-black px-1.5 py-0.5 rounded-full bg-violet-400/20 text-violet-500 border border-violet-400/30 flex items-center gap-0.5"><Sparkle size={8} weight="fill" />{hasDirective ? '心声已传' : '有心事'}</span>}
                        </div>
                        <div className={`text-[10px] truncate mt-0.5 flex items-center gap-1 ${t.textSub}`}>
                            <MapPin size={9} weight="fill" className="text-amber-500 shrink-0" />{b.location} · {teaser}{teaser.length >= 30 ? '…' : ''}
                        </div>
                    </div>
                    {open ? <CaretDown size={14} className={`${t.textSub} self-center shrink-0`} /> : <CaretRight size={14} className={`${t.textSub} self-center shrink-0`} />}
                </button>
                <button onClick={onPhone} className={`shrink-0 px-2.5 flex items-center justify-center border-l ${t.divider}`} title="看 ta 的手机">
                    <DeviceMobile size={15} weight="fill" className="text-amber-500" />
                </button>
            </div>

            {open && (
                <div className={`px-2.5 pb-2.5 pt-1 border-t ${t.divider} space-y-2.5`}>
                    {/* 时间轴（shared=false 只有玩家看得到，标"没声张"） */}
                    {b.timeline && b.timeline.length > 0 && (
                        <div className={`mt-2 rounded-xl border p-2.5 ${t.chip}`}>
                            <div className="text-[9px] font-black tracking-wider opacity-60 mb-1.5">这半天的时间轴</div>
                            <div className="space-y-1.5">
                                {b.timeline.map((tl, i) => (
                                    <div key={i} className="flex gap-2 items-baseline">
                                        <span className="text-[9.5px] font-black text-amber-500 w-9 shrink-0 text-right">{tl.time}</span>
                                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 translate-y-[-1px] ${tl.shared ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                                        <span className={`text-[11px] leading-snug ${t.textMain} opacity-85`}>
                                            <b>{tl.place}</b> · {tl.event}
                                            {!tl.shared && <span className="ml-1 inline-flex items-center gap-0.5 text-[8.5px] font-black text-rose-400"><EyeSlash size={9} weight="bold" />没声张</span>}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    {/* 正文：像翻开一页日记 */}
                    <div className={`rounded-xl border p-3 ${t.chip}`}>
                        <div className="text-[9px] font-black tracking-wider opacity-50 mb-1.5 flex items-center gap-1"><Article size={10} weight="fill" />ta 的这一天</div>
                        <div className="space-y-2">
                            {b.narrative.split(/\n+/).filter(Boolean).map((para, i) => (
                                <p key={i} className={`text-[12.5px] leading-[1.85] tracking-[0.01em] ${t.textMain} opacity-90`} style={{ textIndent: '2em' }}>{para}</p>
                            ))}
                        </div>
                    </div>
                    {b.dialogues && b.dialogues.length > 0 && (
                        <div className="space-y-1.5">
                            {b.dialogues.map((d, i) => (
                                <div key={i} className="rounded-lg border-l-2 border-amber-400/70 bg-amber-400/10 px-2.5 py-1.5">
                                    <div className="text-[9px] font-black text-amber-600 mb-0.5">当面对 {d.with} 说</div>
                                    {d.lines.map((l, j) => <div key={j} className={`text-[11.5px] leading-[1.6] ${t.textMain} opacity-90`}>「{l}」</div>)}
                                </div>
                            ))}
                        </div>
                    )}
                    {/* 备忘录（私人，仅玩家可见） */}
                    {b.memo && b.memo.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                            {b.memo.map((m, i) => (
                                <div key={i} className="px-2.5 py-1.5 rounded-lg bg-amber-100 border border-amber-200 text-[10.5px] leading-snug text-amber-900 shadow-sm max-w-full"
                                    style={{ transform: `rotate(${i % 2 === 0 ? '-0.6' : '0.5'}deg)` }}>
                                    <NotePencil size={9} weight="fill" className="inline mr-1 text-amber-500" />{m}
                                </div>
                            ))}
                        </div>
                    )}
                    {/* 冲动 / 待决策（user 可帮忙拿主意） */}
                    {b.impulse && (
                        <ImpulseCard
                            impulse={b.impulse}
                            existing={(world.directives || []).find(d => d.charId === b.charId)}
                            textMain={t.textMain}
                            onSend={text => onDirective(b.impulse!.text, text)}
                        />
                    )}
                    {b.statusPanel && (
                        <div className="grid grid-cols-2 gap-1.5">
                            {Object.entries(b.statusPanel).map(([k, v]) => (
                                <div key={k} className={`rounded-lg px-2 py-1.5 border ${t.chip}`}>
                                    <div className="flex justify-between text-[9px] font-bold opacity-80"><span>{k}</span><span>{String(v)}</span></div>
                                    {typeof v === 'number' && (
                                        <div className={`h-1 rounded-full mt-1 overflow-hidden ${t.barTrack}`}>
                                            <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, v))}%`, background: 'linear-gradient(90deg,#34d399,#fbbf24)' }} />
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                    {(onReroll || onInject) && (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            {onReroll && (
                                <button onClick={onReroll} className={`flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-lg border ${t.chip} active:scale-95 transition-transform`}>
                                    <Sparkle size={11} weight="fill" className="text-violet-500" />重演这一段
                                </button>
                            )}
                            {onInject && (
                                <button onClick={onInject} className={`flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-lg border ${t.chip} active:scale-95 transition-transform`} title="把这段观测补发到和 ta 的聊天里（重 roll 后保底用）">
                                    <PaperPlaneTilt size={11} weight="fill" className="text-sky-500" />发到聊天
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

// ============================================================
// 大世界视图
// ============================================================
const WorldView: React.FC<{
    world: WorldProfile;
    characters: CharacterProfile[];
    onEdit: () => void;
    onWorldUpdated: () => void;
    onBack?: () => void;
    topSafe?: boolean;
}> = ({ world, characters, onEdit, onWorldUpdated, onBack, topSafe }) => {
    const { addToast } = useOS();
    const [episodes, setEpisodes] = useState<WorldEpisode[]>([]);
    const [progress, setProgress] = useState<{ done: number; total: number; charName?: string } | null>(
        isWorldRunning(world.id) ? { done: 0, total: world.memberIds.length } : null
    );
    const [openHouseId, setOpenHouseId] = useState<string | null>(null);
    const [openEpisodeId, setOpenEpisodeId] = useState<string | null>(null);
    const [openChapterId, setOpenChapterId] = useState<string | null>(null);
    const [chapterPage, setChapterPage] = useState(0);
    const [seedPage, setSeedPage] = useState(0);
    const [phoneView, setPhoneView] = useState<{ ownerId: string; tab?: 'feed' | 'dm' | 'group' } | null>(null);
    const [rerollTarget, setRerollTarget] = useState<{ charId: string; charName: string } | null>(null);
    const [rerollDir, setRerollDir] = useState('');

    const members = useMemo(() => world.memberIds.map(id => characters.find(c => c.id === id)).filter(Boolean) as CharacterProfile[], [world.memberIds, characters]);
    const latest = episodes[0];
    // 氛围跟随"即将到来的那一段"：早/中=白天，晚=夜晚
    const isNight = isNightWorld(world);

    // sim（模拟时间）：章节进度 + 已结的卷
    const isSim = world.timeMode === 'sim';
    const chapters = useMemo(() => (world.chapters || []).slice().sort((a, b) => b.index - a.index), [world.chapters]);
    const daysIntoChapter = Math.floor((world.storyClock - (world.simSummarizedClock || 0)) / 3);
    const daysToNextChapter = Math.max(0, SIM_CHAPTER_DAYS - daysIntoChapter);

    const loadEpisodes = useCallback(async () => {
        setEpisodes(await DB.getWorldEpisodes(world.id, 30));
    }, [world.id]);

    useEffect(() => { loadEpisodes(); }, [loadEpisodes]);

    useEffect(() => {
        const onStart = (e: any) => { if (e.detail?.worldId === world.id) setProgress({ done: 0, total: e.detail.total || members.length }); };
        const onBeat = (e: any) => { if (e.detail?.worldId === world.id) setProgress({ done: e.detail.done || 0, total: e.detail.total || members.length, charName: e.detail.charName }); };
        const onDone = (e: any) => { if (e.detail?.worldId === world.id) { loadEpisodes(); onWorldUpdated(); } };
        const onEnd = (e: any) => { if (e.detail?.worldId === world.id) setProgress(null); };
        const onChapterStart = (e: any) => { if (e.detail?.worldId === world.id) addToast(`满 ${SIM_CHAPTER_DAYS} 天了，正在结第 ${e.detail.index} 卷…`, 'success'); };
        const onChapterDone = (e: any) => { if (e.detail?.worldId === world.id) { addToast(`第 ${e.detail.index} 卷总结好了，去翻翻这些天的故事`, 'success'); onWorldUpdated(); } };
        window.addEventListener('world-episode-start', onStart);
        window.addEventListener('world-beat-done', onBeat);
        window.addEventListener('world-episode-done', onDone);
        window.addEventListener('world-episode-end', onEnd);
        window.addEventListener('world-chapter-start', onChapterStart);
        window.addEventListener('world-chapter-done', onChapterDone);
        return () => {
            window.removeEventListener('world-episode-start', onStart);
            window.removeEventListener('world-beat-done', onBeat);
            window.removeEventListener('world-episode-done', onDone);
            window.removeEventListener('world-episode-end', onEnd);
            window.removeEventListener('world-chapter-start', onChapterStart);
            window.removeEventListener('world-chapter-done', onChapterDone);
        };
    }, [world.id, members.length, loadEpisodes, onWorldUpdated, addToast]);

    const observe = () => {
        if (isWorldRunning(world.id)) { addToast('这一轮还在演绎中', 'error'); return; }
        if (members.length === 0) { addToast('这个世界还没有住进角色', 'error'); return; }
        // 真实时间：跟着现实早/中/晚走，已追上现实就先等等（过去错过的当天可补、隔天补不了）
        if (world.timeMode !== 'sim' && !realObserveTarget(world)) {
            addToast('已经跟上现实时间啦——等过了这一段（早/中/晚/凌晨）再来观测', 'info');
            return;
        }
        setProgress({ done: 0, total: members.length });
        WorldScheduler.triggerNow(world.id);
        trackEvent('触发一轮世界观测');
        addToast(world.timeMode === 'sim' ? '观测开始——世界推进一段（早/中/晚/凌晨），可以先去做别的' : '观测开始——演绎现实中刚过去的这一段，可以先去做别的', 'success');
    };

    // 单个角色重 roll（仅对最新一轮）：派发事件给 OSContext 用完整 deps 重演这一拍
    const doReroll = (charId: string, charName: string, direction: string) => {
        if (isWorldRunning(world.id)) { addToast('还在演绎中，稍等', 'error'); return; }
        if (!latest) { addToast('还没有可重演的一轮', 'error'); return; }
        setProgress({ done: 0, total: 1, charName });
        window.dispatchEvent(new CustomEvent('world-reroll-request', { detail: { worldId: world.id, charId, episodeId: latest.id, direction: direction.trim() || undefined } }));
        trackEvent('重演某个角色这一段');
        addToast(`正在重演 ${charName} 这一段…`, 'success');
        setRerollTarget(null); setRerollDir('');
    };

    // 手动补发漏掉的观测卡片；重演会自动原地同步已有卡片。
    const injectBeatToChat = async (charId: string) => {
        if (!latest) { addToast('还没有可发送的观测', 'error'); return; }
        const beat = latest.beats.find(b => b.charId === charId);
        if (!beat) { addToast('这一轮 ta 还没演出来', 'error'); return; }
        try {
            await injectWorldCard(world, beat, latest.round, latest.storyTime);
            trackEvent('补发观测到聊天');
            addToast(`已把这段观测发到和 ${beat.charName} 的聊天里`, 'success');
        } catch {
            addToast('发送失败，稍后再试', 'error');
        }
    };

    // 拜访视图的住房编排：配置的小屋 + 没分配的成员各自独居
    const visitHouses = useMemo(() => {
        const out: { house: WorldHouse; residents: CharacterProfile[] }[] = [];
        for (const h of world.houses) {
            const residents = h.residentIds.map(id => members.find(m => m.id === id)).filter(Boolean) as CharacterProfile[];
            if (residents.length > 0) out.push({ house: h, residents });
        }
        for (const m of members) {
            if (!houseOf(world, m.id)) out.push({ house: { id: `solo_${m.id}`, name: `${m.name} 的小屋`, residentIds: [m.id] }, residents: [m] });
        }
        return out;
    }, [world, members]);

    const beatOf = (charId: string): WorldCharBeat | undefined => latest?.beats.find(b => b.charId === charId);
    const nameOf = (id: string) => members.find(m => m.id === id)?.name || world.npcs.find(n => n.id === id)?.name || '?';

    /** 修改世界并刷新（决策/伏笔引爆都走这里）。 */
    const mutateWorld = async (updates: Partial<WorldProfile>) => {
        await DB.updateWorld(world.id, { ...updates, updatedAt: Date.now() });
        onWorldUpdated();
    };

    /** 编辑/删除手机里的生成内容（动态/备忘落 episode；私聊/群聊落 world.threads）。newText=null 表示删除。 */
    const applyContentEdit = async (target: WHEditTarget, newText: string | null) => {
        if (target.type === 'comment') {
            // 朋友圈评论删除：feedReactions[key].comments 按下标删一条；删空了就把整条反应去掉
            const rx = world.feedReactions?.[target.key];
            if (!rx) return;
            const comments = rx.comments.filter((_, i) => i !== target.idx);
            const fr = { ...world.feedReactions };
            if (comments.length === 0 && !rx.likes) delete fr[target.key];
            else fr[target.key] = { ...rx, comments };
            await DB.updateWorld(world.id, { feedReactions: fr, updatedAt: Date.now() });
            onWorldUpdated();
            addToast('已删除', 'success');
            return;
        }
        if (target.type === 'post' || target.type === 'memo') {
            const ep = episodes.find(e => e.round === target.round);
            const beat = ep?.beats.find(b => b.charId === target.charId);
            if (!ep || !beat) return;
            let newBeat: WorldCharBeat;
            let reactionUpdate: WorldProfile['feedReactions'] | undefined;
            if (target.type === 'post') {
                const posts = [...(beat.phone?.posts || [])];
                if (target.idx < 0 || target.idx >= posts.length) return;
                if (newText === null) {
                    posts.splice(target.idx, 1);
                    // 该动态的点赞/评论按 idx 关联，删一条后把高位的往下挪一格
                    if (world.feedReactions) {
                        const fr = { ...world.feedReactions };
                        delete fr[`${target.round}_${target.charId}_${target.idx}`];
                        for (let i = target.idx + 1; i <= posts.length; i++) {
                            const oldK = `${target.round}_${target.charId}_${i}`;
                            if (fr[oldK]) { fr[`${target.round}_${target.charId}_${i - 1}`] = fr[oldK]; delete fr[oldK]; }
                        }
                        reactionUpdate = fr;
                    }
                } else {
                    posts[target.idx] = newText;
                }
                newBeat = { ...beat, phone: { ...beat.phone, posts } };
            } else {
                const memo = [...(beat.memo || [])];
                if (target.idx < 0 || target.idx >= memo.length) return;
                if (newText === null) memo.splice(target.idx, 1);
                else memo[target.idx] = newText;
                newBeat = { ...beat, memo };
            }
            const updatedEp: WorldEpisode = { ...ep, beats: ep.beats.map(b => b.charId === target.charId ? newBeat : b) };
            await DB.saveWorldEpisode(updatedEp);
            if (reactionUpdate) await DB.updateWorld(world.id, { feedReactions: reactionUpdate, updatedAt: Date.now() });
            await loadEpisodes();
            if (reactionUpdate) onWorldUpdated();
        } else {
            const threads = (world.threads || []).map(tr => {
                if (tr.id !== target.threadId) return tr;
                const messages = newText === null
                    ? tr.messages.filter(m => m.id !== target.msgId)
                    : tr.messages.map(m => m.id === target.msgId ? { ...m, text: newText } : m);
                return { ...tr, messages };
            });
            await mutateWorld({ threads });
        }
        addToast(newText === null ? '已删除' : '已更新', 'success');
    };

    const sendDirective = (charId: string, impulseText: string, text: string) => {
        const d = { id: `wd_${Date.now().toString(36)}`, charId, impulseText, text, createdRound: world.storyClock };
        void mutateWorld({ directives: [...(world.directives || []), d] });
        trackEvent('给角色传一句心声');
        addToast('心声已传达，下一轮生效', 'success');
    };

    const armSeed = (seedId: string) => {
        void mutateWorld({ seeds: (world.seeds || []).map(s => s.id === seedId ? { ...s, status: 'armed' as const } : s) });
        trackEvent('点燃一条伏笔');
        addToast('伏笔已点燃——下一轮观测时爆发', 'success');
    };

    const deleteSeed = (seedId: string) => {
        void mutateWorld({ seeds: (world.seeds || []).filter(s => s.id !== seedId) });
        addToast('伏笔已删除', 'success');
    };
    // 长按删除：按住 ~550ms 弹确认框；手指移动超过 10px（在滚动）就取消，避免误删
    const [pendingSeed, setPendingSeed] = useState<{ id: string; charName: string; text: string } | null>(null);
    const seedPressRef = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
    const cancelSeedPress = () => { if (seedPressRef.current) { clearTimeout(seedPressRef.current.timer); seedPressRef.current = null; } };
    const startSeedPress = (e: React.PointerEvent, seed: { id: string; charName: string; text: string }) => {
        cancelSeedPress();
        const x = e.clientX, y = e.clientY;
        const timer = setTimeout(() => { cancelSeedPress(); setPendingSeed({ id: seed.id, charName: seed.charName, text: seed.text }); }, 550);
        seedPressRef.current = { timer, x, y };
    };
    const moveSeedPress = (e: React.PointerEvent) => {
        const s = seedPressRef.current;
        if (s && (Math.abs(e.clientX - s.x) > 10 || Math.abs(e.clientY - s.y) > 10)) cancelSeedPress();
    };

    // 主题 token：昼/夜两套
    const t = isNight ? {
        pageBg: 'linear-gradient(180deg,#11142a 0%,#171b35 30%,#1b2038 100%)',
        skyBg: 'linear-gradient(180deg,#0e1130 0%,#23284f 70%,#3b3866 100%)',
        panel: 'bg-white/[0.07] border-white/10 backdrop-blur',
        panelSolid: 'bg-[#1f2440]/90 border-white/10',
        textMain: 'text-indigo-50',
        textSub: 'text-indigo-200/60',
        textLabel: 'text-indigo-200/70',
        chip: 'bg-white/10 border-white/10 text-indigo-100',
        divider: 'border-white/10',
        roofBg: 'linear-gradient(135deg,#5a4d82 0%,#3f3560 100%)',
        lawnBg: 'linear-gradient(180deg,#2a2350 0%,#1b1838 100%)',
        barTrack: 'bg-white/10',
    } : {
        pageBg: 'linear-gradient(180deg,#e6def4 0%,#eee9f7 40%,#f6f2fb 100%)',
        skyBg: 'linear-gradient(180deg,#b3a6dd 0%,#cabfe8 55%,#e3def2 100%)',
        panel: 'bg-white/75 border-white/70 backdrop-blur shadow-[0_3px_14px_rgba(120,100,180,.1)]',
        panelSolid: 'bg-white/90 border-purple-200/60',
        textMain: 'text-[#3f3460]',
        textSub: 'text-purple-400',
        textLabel: 'text-purple-400/80',
        chip: 'bg-white/80 border-purple-200/70 text-purple-900',
        divider: 'border-purple-200/60',
        roofBg: 'linear-gradient(135deg,#9a86c8 0%,#7d68ad 100%)',
        lawnBg: 'linear-gradient(180deg,#cdbfe8 0%,#b3a2d8 100%)',
        barTrack: 'bg-purple-200/70',
    };

    return (
        <div
            className="flex-1 overflow-y-auto no-scrollbar"
            style={{
                background: t.pageBg,
                paddingTop: topSafe ? 'max(3rem, var(--safe-top, 0px))' : undefined,
                paddingBottom: 'calc(6rem + var(--safe-bottom, 0px))',
                boxSizing: 'border-box',
            }}
        >
            {/* 伏笔删除确认（自定义弹窗，非原生） */}
            {pendingSeed && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 backdrop-blur-sm p-6" onClick={() => setPendingSeed(null)}>
                    <div className="w-full max-w-[300px] rounded-2xl bg-[#f7f3ea] shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
                        <div className="px-4 pt-4 pb-3">
                            <div className="text-[14px] font-black text-stone-800 flex items-center gap-1.5"><EyeSlash size={15} weight="fill" className="text-rose-400" />删除这个伏笔？</div>
                            <p className="text-[11.5px] text-stone-500 leading-relaxed mt-2">
                                <span className="font-bold text-stone-700">{pendingSeed.charName}</span>：{pendingSeed.text.slice(0, 50)}{pendingSeed.text.length > 50 ? '…' : ''}
                            </p>
                            <p className="text-[10px] text-stone-400 mt-1.5">删了就不会再爆发了，无法恢复。</p>
                        </div>
                        <div className="flex border-t border-stone-200">
                            <button onClick={() => setPendingSeed(null)} className="flex-1 py-2.5 text-[13px] font-bold text-stone-500 active:bg-black/5">取消</button>
                            <button onClick={() => { deleteSeed(pendingSeed.id); setPendingSeed(null); }} className="flex-1 py-2.5 text-[13px] font-bold text-rose-500 border-l border-stone-200 active:bg-rose-50">删除</button>
                        </div>
                    </div>
                </div>
            )}
            {rerollTarget && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 backdrop-blur-sm p-6" onClick={() => { setRerollTarget(null); setRerollDir(''); }}>
                    <div className="w-full max-w-[320px] rounded-2xl bg-[#f7f3ea] shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
                        <div className="px-4 pt-4 pb-3">
                            <div className="text-[14px] font-black text-stone-800 flex items-center gap-1.5"><Sparkle size={15} weight="fill" className="text-violet-500" />重演 {rerollTarget.charName} 这一段</div>
                            <p className="text-[10.5px] text-stone-400 mt-1.5 leading-relaxed">会替换 ta 这一轮的剧情、发出的私信与群消息、伏笔及关系变化，并同步聊天里的观测卡片。其他人的这一段保持原样。可以给个重写方向（选填）。</p>
                            <textarea value={rerollDir} onChange={e => setRerollDir(e.target.value)} rows={3}
                                className="mt-2.5 w-full px-3 py-2 rounded-xl bg-white border border-stone-200 text-[12px] text-stone-800 focus:outline-none focus:border-violet-300 resize-none"
                                placeholder="比如：让 ta 这次主动去找 XX 摊牌 / 心情写得更低落些 / 别提工作的事…" />
                        </div>
                        <div className="flex border-t border-stone-200">
                            <button onClick={() => { setRerollTarget(null); setRerollDir(''); }} className="flex-1 py-2.5 text-[13px] font-bold text-stone-500 active:bg-black/5">取消</button>
                            <button onClick={() => doReroll(rerollTarget.charId, rerollTarget.charName, rerollDir)} className="flex-1 py-2.5 text-[13px] font-bold text-violet-600 border-l border-stone-200 active:bg-violet-50">重新生成</button>
                        </div>
                    </div>
                </div>
            )}
            {/* 本轮没演出来的角色：提示 + 可重 roll */}
            {latest && (latest.failedCharIds?.length || 0) > 0 && !progress && (
                <div className="mx-4 mt-3 rounded-2xl border border-rose-200 bg-rose-50/80 p-3">
                    <div className="text-[11.5px] font-bold text-rose-600">本轮有角色没演出来</div>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                        {latest.failedCharIds!.map(id => {
                            const c = members.find(m => m.id === id);
                            if (!c) return null;
                            return (
                                <button key={id} onClick={() => { setRerollDir(''); setRerollTarget({ charId: id, charName: c.name }); }}
                                    className="flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg bg-rose-500 text-white active:scale-95 transition-transform">
                                    <Sparkle size={11} weight="fill" />重新生成 {c.name}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
            {/* ── 天空舞台：剧情时间 + 观测 ── */}
            <div className="relative mx-4 mt-3 rounded-3xl overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,.18)]" style={{ background: t.skyBg }}>
                {isNight ? (
                    <>
                        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: starsBg, animation: 'wh-twinkle 3.4s ease-in-out infinite' }} />
                        <div className="absolute top-4 right-6 w-10 h-10 rounded-full pointer-events-none"
                            style={{ background: '#f8f3d9', boxShadow: '0 0 24px 6px rgba(248,243,217,.45)', clipPath: 'circle(50%)' }}>
                            <div className="absolute -left-2 -top-1 w-9 h-9 rounded-full" style={{ background: '#23284f' }} />
                        </div>
                    </>
                ) : (
                    <>
                        <div className="absolute top-4 right-6 w-11 h-11 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle,#fff6d8 30%,#ffd76e 70%)', boxShadow: '0 0 30px 10px rgba(255,215,110,.45)' }} />
                        <div className="absolute top-7 left-6 w-16 h-5 rounded-full bg-white/70 blur-[2px] pointer-events-none" style={{ animation: 'wh-drift 7s ease-in-out infinite' }} />
                        <div className="absolute top-12 left-24 w-10 h-3.5 rounded-full bg-white/50 blur-[2px] pointer-events-none" style={{ animation: 'wh-drift 9s ease-in-out infinite reverse' }} />
                    </>
                )}
                <div className="relative px-4 pt-4 pb-4">
                    {onBack && (
                        <button onClick={onBack} className="absolute top-3 right-3 z-10 p-1.5 rounded-full bg-black/25 backdrop-blur text-white/90 active:scale-90 transition-transform" title="返回">
                            <ArrowLeft size={16} weight="bold" />
                        </button>
                    )}
                    <div className="flex items-center gap-1.5">
                        <span className={`text-[8.5px] font-black px-2 py-0.5 rounded-full tracking-wider ${MODE_INFO[world.mode].badge}`}>{MODE_INFO[world.mode].short}</span>
                        <span className={`text-[8.5px] font-black px-2 py-0.5 rounded-full tracking-wider ${TIME_MODE_INFO[world.timeMode || 'real'].badge}`}>{TIME_MODE_INFO[world.timeMode || 'real'].short}</span>
                        {(world.offlineTickSlots?.length || 0) > 0 && (
                            <span className="text-[8.5px] font-bold px-2 py-0.5 rounded-full bg-black/25 text-white/85 tracking-wider">离线运转中</span>
                        )}
                    </div>
                    <div className="mt-2 flex items-end justify-between gap-3">
                        <div>
                            <div className="flex items-center gap-1.5 text-white/85">
                                {isNight ? <MoonStars size={15} weight="fill" /> : <SunHorizon size={15} weight="fill" />}
                                <span className="text-[10px] font-bold tracking-[0.2em]">{latest ? '当前时刻' : '世界尚未开始'}</span>
                            </div>
                            <div className="text-[22px] font-black text-white leading-tight font-serif" style={{ textShadow: '0 2px 10px rgba(0,0,0,.3)' }}>
                                {worldTimeLabel(world)}
                            </div>
                            {/* 设了世界时区就标出来：不然用户看到的段和自己手机时间对不上会以为是 bug */}
                            {worldTzLabel(world) && (
                                <div className="text-[9.5px] font-bold text-white/60 tracking-wide mt-0.5">🌐 {worldTzLabel(world)} 当地时间</div>
                            )}
                        </div>
                        <button onClick={observe} disabled={!!progress}
                            className="relative overflow-hidden wh-sheen shrink-0 px-4 py-2.5 rounded-2xl text-[12.5px] font-black tracking-wide text-amber-950 shadow-[0_6px_18px_rgba(255,180,60,.45)] disabled:opacity-60 active:scale-95 transition-transform"
                            style={{ background: 'linear-gradient(135deg,#ffd76e 0%,#ffb347 100%)' }}>
                            <span className="relative z-10 flex items-center gap-1.5"><Sparkle size={15} weight="fill" />{progress ? '演绎中…' : '观测 · 推进一段'}</span>
                        </button>
                    </div>
                    {progress && (
                        <div className="mt-3 rounded-xl bg-black/25 backdrop-blur px-3 py-2">
                            <div className="flex justify-between text-[10px] text-white/90 mb-1.5 font-semibold">
                                <span className="flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse" />{progress.charName ? `正在演绎：${progress.charName}` : '世界引擎运转中（NPC）…'}</span>
                                <span>{progress.done}/{progress.total}</span>
                            </div>
                            <div className="h-1.5 rounded-full bg-white/15 overflow-hidden">
                                <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%`, background: 'linear-gradient(90deg,#ffd76e,#ffb347)' }} />
                            </div>
                            <div className="text-[9px] text-white/55 mt-1">可以离开这个界面，演绎在后台继续</div>
                        </div>
                    )}
                </div>
            </div>

            <div className="px-4 mt-4 space-y-4">
                {/* ── sim 模式：结卷进度 + 已归档的卷 ── */}
                {isSim && (
                    <div>
                        <div className={`text-[10px] font-black tracking-[0.25em] uppercase px-1 mb-2 flex items-center gap-1.5 ${t.textLabel}`}><Article size={11} weight="fill" />编年史 · 每 {SIM_CHAPTER_DAYS} 天一卷</div>
                        <div className={`rounded-2xl border p-3 ${t.panel}`}>
                            <div className="flex items-center justify-between mb-1.5">
                                <span className={`text-[11px] font-bold ${t.textMain}`}>本卷进度</span>
                                <span className={`text-[10px] ${t.textSub}`}>{daysToNextChapter > 0 ? `还有 ${daysToNextChapter} 天结第 ${chapters.length + 1} 卷` : '即将结卷'}</span>
                            </div>
                            <div className={`h-1.5 rounded-full overflow-hidden ${t.barTrack}`}>
                                <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.round((daysIntoChapter / SIM_CHAPTER_DAYS) * 100)}%`, background: 'linear-gradient(90deg,#a78bfa,#7c3aed)' }} />
                            </div>
                        </div>
                        {chapters.length > 0 && (() => {
                            const CH_PER = 5;
                            const chTotal = Math.max(1, Math.ceil(chapters.length / CH_PER));
                            const chPage = Math.min(chapterPage, chTotal - 1);
                            const shown = chapters.slice(chPage * CH_PER, chPage * CH_PER + CH_PER);
                            return (
                            <div className="space-y-2 mt-2.5">
                                {shown.map(ch => {
                                    const open = openChapterId === ch.id;
                                    return (
                                        <div key={ch.id} className={`rounded-2xl border overflow-hidden ${t.panel}`}>
                                            <button className="w-full text-left px-3 py-2.5 flex items-center gap-2" onClick={() => setOpenChapterId(open ? null : ch.id)}>
                                                <span className="text-[11px] font-black px-2 py-0.5 rounded-full bg-violet-400/90 text-violet-950 shrink-0">第 {ch.index} 卷</span>
                                                <span className={`text-[10.5px] truncate ${t.textSub}`}>{ch.fromLabel} ～ {ch.toLabel}</span>
                                                {open ? <CaretDown size={13} className={`${t.textSub} ml-auto shrink-0`} /> : <CaretRight size={13} className={`${t.textSub} ml-auto shrink-0`} />}
                                            </button>
                                            {open && (
                                                <div className={`px-3.5 pb-3 pt-0.5 border-t ${t.divider}`}>
                                                    <p className={`text-[12px] leading-[1.85] whitespace-pre-wrap mt-2 ${t.textMain}`}>{ch.synopsis}</p>
                                                    {ch.relationshipEval && (
                                                        <div className="mt-3">
                                                            <div className={`text-[9.5px] font-black tracking-wider flex items-center gap-1 ${t.textLabel}`}><Heart size={10} weight="fill" />关系走向</div>
                                                            <p className={`text-[11.5px] leading-[1.8] mt-1 ${t.textSub}`}>{ch.relationshipEval}</p>
                                                        </div>
                                                    )}
                                                    {ch.atmosphere && (
                                                        <div className={`mt-3 text-[10.5px] italic rounded-lg px-2.5 py-1.5 ${isNight ? 'bg-white/5 text-indigo-200/70' : 'bg-violet-50/70 text-violet-700'}`}>氛围：{ch.atmosphere}</div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                                {chTotal > 1 && (
                                    <div className="flex items-center justify-center gap-3 pt-1">
                                        <button onClick={() => setChapterPage(Math.max(0, chPage - 1))} disabled={chPage === 0}
                                            className={`w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-30 active:scale-90 transition-all ${t.chip}`}><CaretRight size={13} className="rotate-180" weight="bold" /></button>
                                        <span className={`text-[11px] font-bold tabular-nums ${t.textSub}`}>{chPage + 1}/{chTotal}</span>
                                        <button onClick={() => setChapterPage(Math.min(chTotal - 1, chPage + 1))} disabled={chPage >= chTotal - 1}
                                            className={`w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-30 active:scale-90 transition-all ${t.chip}`}><CaretRight size={13} weight="bold" /></button>
                                    </div>
                                )}
                            </div>
                            );
                        })()}
                    </div>
                )}

                {/* ── 邻里：各家小屋（去串门） ── */}
                <div>
                    <div className={`text-[10px] font-black tracking-[0.25em] uppercase px-1 mb-2 flex items-center gap-1.5 ${t.textLabel}`}><House size={11} weight="fill" />邻里 · 去串门</div>
                    <div className="space-y-2.5">
                        {visitHouses.map(({ house, residents }) => {
                            const open = openHouseId === house.id;
                            return (
                                <div key={house.id} className={`rounded-2xl border overflow-hidden ${t.panel}`}>
                                    <button className="w-full text-left" onClick={() => setOpenHouseId(open ? null : house.id)}>
                                        {/* 屋顶 */}
                                        <div className="h-2.5" style={{ background: t.roofBg }} />
                                        <div className="flex items-center gap-3 px-3 py-2.5">
                                            {/* 草坪上的小人 */}
                                            <div className="rounded-xl px-2 pt-1.5 flex items-end -space-x-3 shrink-0" style={{ background: t.lawnBg }}>
                                                {residents.map(r => <ChibiFigure key={r.id} char={r} size={46} bob={open} />)}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className={`text-[13.5px] font-black font-serif ${t.textMain}`}>{house.name}</div>
                                                <div className={`text-[10px] truncate mt-0.5 ${t.textSub}`}>
                                                    {residents.map(r => {
                                                        const b = beatOf(r.id);
                                                        return b ? `${r.name} · ${b.location}` : `${r.name} · 还没动静`;
                                                    }).join('　')}
                                                </div>
                                            </div>
                                            {open ? <CaretDown size={14} className={t.textSub} /> : <CaretRight size={14} className={t.textSub} />}
                                        </div>
                                    </button>
                                    {open && (
                                        <div className={`px-2.5 pb-2.5 pt-1 space-y-2 border-t ${t.divider}`}>
                                            {residents.map(r => (
                                                <ResidentDayCard
                                                    key={r.id}
                                                    char={r}
                                                    beat={beatOf(r.id)}
                                                    t={t}
                                                    world={world}
                                                    onPhone={() => { setPhoneView({ ownerId: r.id }); trackEvent('打开角色手机面板'); }}
                                                    onDirective={(impulseText, text) => sendDirective(r.id, impulseText, text)}
                                                    onReroll={latest?.beats.some(b => b.charId === r.id) ? () => { setRerollDir(''); setRerollTarget({ charId: r.id, charName: r.name }); } : undefined}
                                                    onInject={world.timeMode !== 'sim' && world.injectToChat !== false && latest?.beats.some(b => b.charId === r.id) ? () => injectBeatToChat(r.id) : undefined}
                                                />
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* ── 世界群聊（公共空间：成员 + NPC 都在里面冒泡） ── */}
                {(() => {
                    const group = groupThreadOf(world);
                    if (!group || group.messages.length === 0) return null;
                    const recent = group.messages.slice(-3);
                    return (
                        <button onClick={() => members[0] && setPhoneView({ ownerId: members[0].id, tab: 'group' })}
                            className={`w-full text-left rounded-2xl border p-3.5 ${t.panel} active:scale-[0.99] transition-transform`}>
                            <div className={`text-[10px] font-black tracking-[0.25em] uppercase flex items-center gap-1.5 mb-2 ${t.textLabel}`}>
                                <ChatCircleDots size={11} weight="fill" />「{group.name}」
                                <span className="ml-auto normal-case tracking-normal font-bold text-[9px] opacity-70">{group.messages.length} 条 · 点开看全部</span>
                            </div>
                            <div className="space-y-1">
                                {recent.map(m => (
                                    <div key={m.id} className={`text-[11px] leading-snug truncate ${t.textMain} opacity-85`}>
                                        <span className="font-bold">{m.fromName}：</span>{m.text}
                                    </div>
                                ))}
                            </div>
                        </button>
                    );
                })()}

                {/* ── 关系（有向：同一对上下两根，直观看出不对等） ── */}
                {world.relationships.length > 0 && (
                    <div className={`rounded-2xl border p-3.5 ${t.panel}`}>
                        <div className={`text-[10px] font-black tracking-[0.25em] uppercase flex items-center gap-1.5 mb-2.5 ${t.textLabel}`}><UsersThree size={11} weight="fill" />羁绊</div>
                        <div className="space-y-2.5">
                            {(() => {
                                // 同一对的两条有向边排到一起展示
                                const seen = new Set<string>();
                                const groups: { fwd: typeof world.relationships[0]; rev?: typeof world.relationships[0] }[] = [];
                                for (const r of world.relationships) {
                                    const key = [r.fromId, r.toId].sort().join('|');
                                    if (seen.has(key)) continue;
                                    seen.add(key);
                                    groups.push({ fwd: r, rev: world.relationships.find(x => x.fromId === r.toId && x.toId === r.fromId) });
                                }
                                return groups.map(({ fwd, rev }) => (
                                    <div key={`${fwd.fromId}_${fwd.toId}`} className={`rounded-xl border p-2.5 space-y-2 ${t.panelSolid}`}>
                                        {[fwd, rev].filter(Boolean).map(r => (
                                            <div key={`${r!.fromId}_${r!.toId}`}>
                                                <div className={`flex justify-between items-center text-[11px] ${t.textMain}`}>
                                                    <span className="font-bold flex items-center gap-1">
                                                        {nameOf(r!.fromId)} <CaretRight size={9} weight="bold" className="opacity-50" /> {nameOf(r!.toId)}
                                                        {r!.label && <span className="text-[8.5px] font-black px-1.5 py-px rounded-full bg-rose-400/15 text-rose-500 border border-rose-400/25">{r!.label}</span>}
                                                    </span>
                                                    <span className={`font-black flex items-center gap-0.5 ${r!.value < 0 ? 'text-slate-400' : 'text-rose-400'}`}><Heart size={10} weight="fill" />{r!.value}</span>
                                                </div>
                                                {/* 好感 -100~100：中点为 0，向右暖色=好感、向左冷色=负好感 */}
                                                <div className={`relative h-1.5 rounded-full overflow-hidden mt-1 ${t.barTrack}`}>
                                                    <div className="absolute top-0 bottom-0 left-1/2 w-px bg-black/20" />
                                                    <div className="absolute top-0 bottom-0 rounded-full transition-all"
                                                        style={r!.value >= 0
                                                            ? { left: '50%', width: `${(r!.value / 2)}%`, background: 'linear-gradient(90deg,#fb7185,#fbbf24)' }
                                                            : { right: '50%', width: `${(-r!.value / 2)}%`, background: 'linear-gradient(90deg,#64748b,#94a3b8)' }} />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ));
                            })()}
                        </div>
                    </div>
                )}

                {/* ── 伏笔栏：角色们瞒下的事（玩家上帝视角），点击引爆生成冲突 ── */}
                {(world.seeds || []).length > 0 && (
                    <div className={`rounded-2xl border p-3.5 ${t.panel}`}>
                        <div className={`text-[10px] font-black tracking-[0.25em] uppercase flex items-center gap-1.5 mb-2.5 ${t.textLabel}`}>
                            <EyeSlash size={11} weight="fill" />伏笔栏 · 只有你看得到<span className="normal-case tracking-normal font-medium opacity-60 ml-1">（长按删除）</span>
                        </div>
                        {(() => {
                            const activeSeeds = (world.seeds || []).filter(s => s.status !== 'resolved').slice().reverse();
                            const SEED_PER = 4;
                            const sTotal = Math.max(1, Math.ceil(activeSeeds.length / SEED_PER));
                            const sp = Math.min(seedPage, sTotal - 1);
                            const resolvedCount = (world.seeds || []).filter(s => s.status === 'resolved').length;
                            return (
                        <div className="space-y-2">
                            {activeSeeds.slice(sp * SEED_PER, sp * SEED_PER + SEED_PER).map(seed => (
                                <div key={seed.id} className={`rounded-xl border p-2.5 select-none ${seed.status === 'armed' ? 'border-rose-400/60 bg-rose-400/10' : t.panelSolid}`}
                                    onPointerDown={e => startSeedPress(e, seed)} onPointerMove={moveSeedPress} onPointerUp={cancelSeedPress} onPointerLeave={cancelSeedPress} onPointerCancel={cancelSeedPress}>
                                    <div className={`text-[11px] leading-snug ${t.textMain}`}>
                                        <span className="font-black">{seed.charName}</span>
                                        <span className={`text-[9px] ml-1.5 ${t.textSub}`}>{seed.storyTime} · 瞒着{seed.hideFrom.length > 0 ? seed.hideFrom.join('、') : '所有人'}</span>
                                    </div>
                                    <p className={`text-[11.5px] mt-1 ${t.textMain} opacity-90`}>{seed.text}</p>
                                    {seed.status === 'pending' ? (
                                        <button onClick={() => armSeed(seed.id)}
                                            className="mt-1.5 flex items-center gap-1 text-[10px] font-black px-2.5 py-1 rounded-lg bg-rose-500 text-white active:scale-95 transition-transform">
                                            <Lightning size={11} weight="fill" />引爆这个伏笔
                                        </button>
                                    ) : (
                                        <div className="mt-1.5 flex items-center gap-2">
                                            <span className="text-[10px] font-black text-rose-400 flex items-center gap-1"><Lightning size={11} weight="fill" />已点燃 · 下一轮爆发</span>
                                            <button onClick={observe} disabled={!!progress}
                                                className="text-[10px] font-black px-2.5 py-1 rounded-lg bg-rose-500 text-white disabled:opacity-40 active:scale-95 transition-transform">
                                                立即观测
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ))}
                            {sTotal > 1 && (
                                <div className="flex items-center justify-center gap-3 pt-0.5">
                                    <button onClick={() => setSeedPage(Math.max(0, sp - 1))} disabled={sp === 0}
                                        className={`w-7 h-7 rounded-full flex items-center justify-center disabled:opacity-30 active:scale-90 transition-all ${t.chip}`}><CaretRight size={12} className="rotate-180" weight="bold" /></button>
                                    <span className={`text-[10.5px] font-bold tabular-nums ${t.textSub}`}>{sp + 1}/{sTotal}</span>
                                    <button onClick={() => setSeedPage(Math.min(sTotal - 1, sp + 1))} disabled={sp >= sTotal - 1}
                                        className={`w-7 h-7 rounded-full flex items-center justify-center disabled:opacity-30 active:scale-90 transition-all ${t.chip}`}><CaretRight size={12} weight="bold" /></button>
                                </div>
                            )}
                            {resolvedCount > 0 && (
                                <div className={`text-[9.5px] ${t.textSub}`}>
                                    已爆发：{(world.seeds || []).filter(s => s.status === 'resolved').slice(-3).map(s => `${s.charName}·${s.text.slice(0, 16)}…`).join(' / ')}
                                </div>
                            )}
                        </div>
                            );
                        })()}
                    </div>
                )}

                {/* ── 镇上的动静（NPC） ── */}
                {latest?.npcScene && (
                    <div className={`rounded-2xl border p-3.5 ${t.panel}`}>
                        <div className={`text-[10px] font-black tracking-[0.25em] uppercase flex items-center gap-1.5 mb-2 ${t.textLabel}`}>
                            <Sparkle size={11} weight="fill" />镇上的动静 · {latest.storyTime}
                        </div>
                        <p className={`text-[12px] leading-[1.7] whitespace-pre-wrap ${t.textMain} opacity-90`}>{latest.npcScene}</p>
                        {world.npcs.length > 0 && (
                            <div className="mt-2.5 flex flex-wrap gap-1.5">
                                {world.npcs.map(n => (
                                    <span key={n.id} className={`text-[10px] px-2 py-0.5 rounded-full border ${t.chip}`}>{n.emoji || '🙂'} {n.name}</span>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* ── 世界纪事（时间线） ── */}
                {episodes.length > 0 && (
                    <div>
                        <div className={`text-[10px] font-black tracking-[0.25em] uppercase px-1 mb-2 ${t.textLabel}`}>世界纪事</div>
                        <div className="space-y-2">
                            {episodes.map(ep => {
                                const open = openEpisodeId === ep.id;
                                return (
                                    <div key={ep.id} className={`rounded-2xl border overflow-hidden ${t.panel}`}>
                                        <button className="w-full flex items-center gap-2.5 p-3 text-left" onClick={() => setOpenEpisodeId(open ? null : ep.id)}>
                                            <div className="w-8 h-8 rounded-xl shrink-0 flex items-center justify-center font-black text-[11px] text-amber-950" style={{ background: 'linear-gradient(135deg,#ffd76e,#ffb347)' }}>
                                                {ep.observationNumber ?? ep.round}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className={`text-[12px] font-black font-serif ${t.textMain}`}>{ep.storyTime}
                                                    <span className={`text-[9px] font-normal ml-1.5 ${t.textSub}`}>{ep.trigger === 'tick' ? '离线推进' : '观测'} · {new Date(ep.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                                                </div>
                                                {!open && <div className={`text-[10px] truncate mt-0.5 ${t.textSub}`}>{ep.summary}</div>}
                                            </div>
                                            {open ? <CaretDown size={14} className={`${t.textSub} shrink-0`} /> : <CaretRight size={14} className={`${t.textSub} shrink-0`} />}
                                        </button>
                                        {open && (
                                            <div className={`px-3 pb-3 space-y-2 border-t ${t.divider}`}>
                                                {ep.npcScene && <p className={`text-[11px] leading-relaxed italic whitespace-pre-wrap pt-2 ${t.textSub}`}>{ep.npcScene}</p>}
                                                {ep.beats.map(b => (
                                                    <div key={b.charId} className={`rounded-xl border p-2.5 ${t.panelSolid}`}>
                                                        <div className="flex items-center gap-2">
                                                            <span className={`text-[11px] font-black ${t.textMain}`}>{b.charName} · {b.location} · {b.mood}</span>
                                                            <button onClick={() => setPhoneView({ ownerId: b.charId })} className="ml-auto p-1 rounded-md bg-slate-900 text-white active:scale-90 shrink-0"><DeviceMobile size={11} weight="fill" /></button>
                                                        </div>
                                                        <div className="mt-1.5 space-y-1.5">
                                                            {b.narrative.split(/\n+/).filter(Boolean).map((para, i) => (
                                                                <p key={i} className={`text-[11.5px] leading-[1.75] ${t.textMain} opacity-85`} style={{ textIndent: '2em' }}>{para}</p>
                                                            ))}
                                                        </div>
                                                        {b.dialogues && b.dialogues.length > 0 && (
                                                            <div className="mt-2 space-y-1">
                                                                {b.dialogues.map((d, i) => (
                                                                    <div key={i} className="rounded-lg border-l-2 border-amber-400/70 bg-amber-400/10 px-2 py-1">
                                                                        <span className="text-[9px] font-black text-amber-600">对 {d.with}：</span>
                                                                        <span className={`text-[10.5px] ${t.textMain} opacity-85`}>{d.lines.map(l => `「${l}」`).join(' ')}</span>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                <button onClick={onEdit} className={`w-full py-2.5 rounded-2xl border text-[12px] font-bold flex items-center justify-center gap-1.5 ${t.panel} ${t.textSub}`}>
                    <GearSix size={14} weight="bold" />世界设置
                </button>
            </div>

            {/* 真手机弹窗 */}
            {phoneView && (
                <PhoneModal
                    ownerId={phoneView.ownerId}
                    world={world}
                    episodes={episodes}
                    members={members}
                    initialTab={phoneView.tab}
                    onClose={() => setPhoneView(null)}
                    onEditContent={applyContentEdit}
                />
            )}
        </div>
    );
};

// ============================================================
// 主组件
// ============================================================
const WorldHomeApp: React.FC<{ embedded?: boolean; launchWorldId?: string; onLaunchConsumed?: () => void; onFullscreen?: (full: boolean) => void }> = ({ embedded, launchWorldId, onLaunchConsumed, onFullscreen }) => {
    const { closeApp, characters, addToast, apiConfig, apiPresets } = useOS();
    const [worlds, setWorlds] = useState<WorldProfile[]>([]);
    const [worldsLoaded, setWorldsLoaded] = useState(false);
    const appliedLaunch = useRef(false);
    const [view, setView] = useState<'list' | 'edit' | 'world'>('list');
    const [activeId, setActiveId] = useState<string | null>(null);
    const [draft, setDraft] = useState<WorldProfile | null>(null);
    // 家园全局 API（所有世界共用一份；不设=跟随全局聊天默认）
    const [worldApi, setWorldApi] = useState<{ baseUrl: string; apiKey: string; model: string } | null>(loadWorldApi);
    const [showApiSettings, setShowApiSettings] = useState(false);
    const resolvedApi = useMemo(() => (worldApi?.baseUrl ? { ...apiConfig, ...worldApi } : apiConfig), [worldApi, apiConfig]);

    const reload = useCallback(async () => {
        const all = await DB.getWorlds();
        // 旧存档（一天三段制）→ 四段制（含凌晨）一次性迁移并写回
        for (const w of all) {
            if (migrateWorldDaySegs(w)) await DB.saveWorld(w).catch(() => {});
        }
        setWorlds(all);
        setWorldsLoaded(true);
    }, []);
    useEffect(() => { reload(); }, [reload]);
    useEffect(() => {
        if (!worldsLoaded || !launchWorldId || appliedLaunch.current) return;
        appliedLaunch.current = true;
        if (worlds.some(world => world.id === launchWorldId)) { setActiveId(launchWorldId); setView('world'); }
        else addToast('这个家园世界已不存在，请重新设置悬浮球槽位', 'error');
        onLaunchConsumed?.();
    }, [worldsLoaded, worlds, launchWorldId, addToast, onLaunchConsumed]);
    // 内嵌进「小小窝」时：开始玩（进世界/编辑）就让外层隐去三栏，回列表恢复
    useEffect(() => { if (embedded) onFullscreen?.(view !== 'list'); }, [embedded, view, onFullscreen]);

    const active = worlds.find(w => w.id === activeId) || null;

    const startCreate = () => {
        setDraft({
            id: genId('world'), name: '', worldview: '', mode: 'light', timeMode: 'real',
            memberIds: [], npcs: [], houses: [], relationships: [],
            offlineTickSlots: [], storyClock: 0, clockSegs: SEGMENTS_PER_DAY, injectToChat: true,
            createdAt: Date.now(), updatedAt: Date.now(),
        });
        setView('edit');
        trackEvent('新建家园世界');
    };

    const saveWorld = async (w: WorldProfile) => {
        const existing = worlds.some(item => item.id === w.id);
        if (existing && draft) {
            const patch = Object.fromEntries(Object.entries(w).filter(([key, value]) =>
                JSON.stringify(value) !== JSON.stringify((draft as any)[key]))) as Partial<WorldProfile>;
            await DB.updateWorld(w.id, patch);
        } else await DB.saveWorld(w);
        // 调度表对账：所有世界的离线 tick 设置一起重建
        const all = await DB.getWorlds();
        WorldScheduler.reconcile(toTickEntries(all));
        setWorlds(all);
        setActiveId(w.id);
        setDraft(null);
        setView('world');
        addToast('世界已保存', 'success');
    };

    const deleteWorld = async (id: string) => {
        await DB.deleteWorld(id);
        const all = await DB.getWorlds();
        WorldScheduler.reconcile(toTickEntries(all));
        setWorlds(all);
        setDraft(null);
        setActiveId(null);
        setView('list');
        addToast('世界已删除', 'success');
    };

    const headerTitle = view === 'edit' ? (draft && worlds.some(w => w.id === draft.id) ? '世界设置' : '创建世界')
        : view === 'world' ? (active?.name || '家园')
        : '家园';

    const goBack = () => {
        if (view === 'edit') { setDraft(null); setView(activeId && worlds.some(w => w.id === activeId) ? 'world' : 'list'); }
        else if (view === 'world') { setActiveId(null); setView('list'); }
        else closeApp();
    };

    // 世界视图的顶栏要压在深色页底上，配色跟着走
    const worldNight = view === 'world' && active ? isNightWorld(active) : false;
    const darkHeader = view === 'world' && worldNight;
    const headerBg = view === 'world'
        ? (worldNight ? '#11142a' : '#cfe7da')
        : '#f1ebf9';
    // 列表/编辑页用淡紫奇幻底，和「小小窝」选择页一致
    const pageBg = view === 'edit' || view === 'list' ? 'linear-gradient(180deg,#efe9f7 0%,#f4eff9 45%,#f7f2fb 100%)' : undefined;

    return (
        <div className="h-full w-full flex flex-col" style={{ background: pageBg }}>
            <GameStyles />
            {/* 顶栏：内嵌进「小小窝」时，列表页只留齿轮/新建；进世界（正式开始玩）整条隐去做全屏，
                返回靠世界视图里的浮动返回键。 */}
            {!(embedded && view === 'world') && (
            <div className="shrink-0 sticky top-0 z-10" style={{ background: headerBg, paddingTop: embedded && view === 'list' ? undefined : 'var(--safe-top)' }}>
            <div className={embedded ? `${view === 'list' ? 'h-12' : 'h-20'} flex items-end pb-3 px-4` : 'flex items-center px-4 py-3'}>
                <div className="flex items-center gap-2 w-full">
                    {!(embedded && view === 'list') && (
                        <>
                            <button onClick={goBack} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                                <ArrowLeft size={22} weight="bold" className={darkHeader ? 'text-indigo-100' : 'text-stone-800'} />
                            </button>
                            <h1 className={`text-xl font-black tracking-wide font-serif flex items-center gap-2 truncate ${darkHeader ? 'text-indigo-50' : 'text-stone-900'}`}>
                                {headerTitle}
                            </h1>
                        </>
                    )}
                    {view === 'list' && (
                        <div className="ml-auto flex items-center gap-0.5">
                            <button onClick={() => setShowApiSettings(true)} className="p-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform" title="家园 API 设置">
                                <GearSix size={20} weight="bold" className="text-stone-800" />
                            </button>
                            <button onClick={startCreate} className="p-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                                <Plus size={20} weight="bold" className="text-stone-800" />
                            </button>
                        </div>
                    )}
                </div>
            </div>
            </div>
            )}

            {showApiSettings && (
                <WorldApiSettings
                    apiConfig={apiConfig}
                    apiPresets={apiPresets}
                    current={worldApi}
                    onChoose={cfg => { setWorldApi(cfg); persistWorldApi(cfg); }}
                    onClose={() => setShowApiSettings(false)}
                />
            )}

            {view === 'list' && (
                <div
                    className="flex-1 overflow-y-auto no-scrollbar px-4 pt-1 space-y-3"
                    style={{ paddingBottom: 'calc(6rem + var(--safe-bottom, 0px))', boxSizing: 'border-box' }}
                >
                    {/* 游戏封面横幅（淡紫梦幻：月亮 + 云霭 + 星点） */}
                    <div className="relative rounded-3xl overflow-hidden p-5 shadow-[0_10px_30px_rgba(120,100,180,.25)]" style={{ background: 'linear-gradient(150deg,#8e83c4 0%,#a99fd6 52%,#c3c9ea 100%)' }}>
                        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: starsBg, animation: 'wh-twinkle 4s ease-in-out infinite' }} />
                        {/* 月亮 */}
                        <div className="absolute top-5 right-7 w-12 h-12 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle at 38% 35%,#fbf7ff,#d9d2ee 70%)', boxShadow: '0 0 26px 6px rgba(255,255,255,.4)' }} />
                        {/* 云霭 */}
                        <div className="absolute -bottom-3 -left-4 w-40 h-16 rounded-full bg-white/30 blur-xl pointer-events-none" />
                        <div className="absolute bottom-2 right-6 w-28 h-12 rounded-full bg-white/20 blur-lg pointer-events-none" />
                        <div className="relative">
                            <div className="text-[9px] font-black tracking-[0.45em] text-white/70 uppercase">World · Home</div>
                            <div className="text-[26px] font-black text-white font-serif tracking-[0.18em] mt-1" style={{ textShadow: '0 2px 14px rgba(90,60,140,.45)' }}>家　园</div>
                            <p className="text-[10.5px] leading-[1.7] text-white/85 mt-2" style={{ textShadow: '0 1px 6px rgba(80,60,130,.3)' }}>
                                把同一世界观的角色放进一个世界，让他们在你不看的时候慢慢生活。
                                每次<b className="text-amber-100">观测</b>，世界推进一段（早/中/晚/凌晨）——每个角色独立演绎，绝不上帝视角；
                                NPC 由世界引擎一口气演完。所有故事都会写回各自的聊天与记忆。
                            </p>
                        </div>
                    </div>

                    {worlds.map(w => {
                        const ms = w.memberIds.map(id => characters.find(c => c.id === id)).filter(Boolean) as CharacterProfile[];
                        const night = isNightWorld(w);
                        return (
                            <button key={w.id} onClick={() => { setActiveId(w.id); setView('world'); trackEvent('进入家园世界'); }}
                                className="w-full rounded-2xl overflow-hidden text-left shadow-[0_6px_18px_rgba(120,100,180,.18)] active:scale-[0.99] transition-transform border border-white/70">
                                {/* 世界缩略天空（淡紫梦幻） */}
                                <div className="relative h-14 flex items-end px-3.5 pb-1.5" style={{ background: night ? 'linear-gradient(180deg,#3a3566,#5b5590)' : 'linear-gradient(180deg,#b3a6dd,#d8d2ee)' }}>
                                    {night && <div className="absolute inset-0" style={{ backgroundImage: starsBg }} />}
                                    <div className="relative flex -space-x-3 items-end">
                                        {ms.slice(0, 5).map(m => <ChibiFigure key={m.id} char={m} size={42} />)}
                                    </div>
                                    <div className="absolute top-2 right-3 flex items-center gap-1">
                                        <span className={`text-[8.5px] font-black px-2 py-0.5 rounded-full ${TIME_MODE_INFO[w.timeMode || 'real'].badge}`}>{TIME_MODE_INFO[w.timeMode || 'real'].short}</span>
                                        <span className={`text-[8.5px] font-black px-2 py-0.5 rounded-full ${MODE_INFO[w.mode].badge}`}>{MODE_INFO[w.mode].short}</span>
                                    </div>
                                </div>
                                <div className="bg-white/90 px-3.5 py-2.5 flex items-center">
                                    <div className="min-w-0">
                                        <div className="text-[14px] font-black font-serif text-stone-800 truncate">{w.name}</div>
                                        <div className="text-[10px] text-stone-500 mt-0.5">
                                            {ms.length} 位角色{w.npcs.length > 0 ? ` · ${w.npcs.length} 个NPC` : ''} · {worldTimeLabel(w)}
                                        </div>
                                    </div>
                                    <CaretRight size={14} className="text-stone-400 shrink-0 ml-auto" />
                                </div>
                            </button>
                        );
                    })}
                    {worlds.length === 0 && (
                        <button onClick={startCreate} className="w-full rounded-2xl border-2 border-dashed border-stone-300 py-10 text-stone-500 text-[13px] font-bold flex flex-col items-center gap-2 bg-white/40">
                            <Plus size={24} weight="bold" />创建第一个世界
                        </button>
                    )}
                </div>
            )}

            {view === 'edit' && draft && (
                <WorldEditor
                    draft={draft}
                    characters={characters}
                    apiConfig={resolvedApi}
                    addToast={addToast}
                    onSave={saveWorld}
                    onCancel={goBack}
                    onDelete={worlds.some(w => w.id === draft.id) ? () => deleteWorld(draft.id) : undefined}
                />
            )}

            {view === 'world' && active && (
                <WorldView
                    world={active}
                    characters={characters}
                    onEdit={() => { setDraft(active); setView('edit'); }}
                    onWorldUpdated={reload}
                    onBack={goBack}
                    topSafe={!!embedded}
                />
            )}
        </div>
    );
};

export default WorldHomeApp;
