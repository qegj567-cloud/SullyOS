import { loadCharacterContextMessages } from '../chatContextRange';
/**
 * 「彼方」会话运行器 —— 一次自主登入的完整闭环。
 *
 * 触发某角色后：
 *   1. 在"有意义的已实装房间"里随机 roll 一个（图书馆永远可选；听歌房当角色
 *      有音乐人格、或房里正放着歌时可选）—— 每次只进一个房间、只做一件事，
 *      天然避免不同玩法的提示词互相打架。
 *   2. 取角色既有人设/向量记忆/最近 contextLimit 上下文（buildChatRequestPayload），
 *      叠加「彼方」世界观 + 该房间现场（user turn）。
 *   3. 调一次 LLM（per-char API 覆盖 → 回落全局）。
 *   4. 解析输出，做房间各自的副作用（图书馆：落批注/推书签；听歌房：点歌进队列/
 *      乐评/推进循环队列），更新 vrState。
 *   5. 向 1v1 聊天注入一条 vr_card，天然被上下文与记忆总结捕捉。
 *   6. fire-and-forget 触发记忆管线。
 */

import {
    CharacterProfile, UserProfile, GroupProfile, RealtimeConfig, APIConfig,
    VRWorldNovel, VRCardMeta, VRRoomId, VRMusicRoomState, CharPlaylistSong, CharMusicReview,
    VRGuestbookState, VRGuestbookMessage, VRLetter, VRScript, SignalPoem,
} from '../../types';
import { DB } from '../db';
import { buildChatRequestPayload } from '../chatRequestPayload';
import { safeFetchJson } from '../safeApi';
import { processNewMessagesWithAutoArchive } from '../memoryPalace/autoArchive';
import { loadMusicCfgStandalone } from '../../context/MusicContext';
import { getCharLyricSnippet } from '../charLyricCache';
import { getRoom, VR_DEFAULT_INTERVAL_MIN, rollPoemLines, signalActFor, SIGNAL_EVENT_ENDED } from './constants';
import { getVRApi, logVRApiCall } from './vrApi';
import { PostOffice } from './postOffice';
import { Signal, SignalState, recordMyLine, getMyRecentLines, takeSignalWhisper } from './signal';
import { getReadingWindow, getBookmark, buildAnnotation } from './novel';
import {
    buildVRSystemAddendum, rollSessionVibe, buildLibraryRoomTurn, parseVROutput,
    buildMusicRoomTurn, parseMusicOutput,
    buildGuestbookRoomTurn, parseGuestbookOutput,
    buildGymRoomTurn, parseGymOutput,
    buildPostOfficeRoomTurn, parsePostOfficeOutput,
    buildPostOfficeReadTurn, parsePostOfficeReadOutput,
    buildTheaterRoomTurn, parseScriptOutput,
    buildSignalRoomTurn, parseSignalOutput,
} from './prompts';

/** 记忆管线所需配置的最小形状（避免从 OSContext 反向 import 造成循环依赖）。 */
interface MemoryConfigLike {
    embedding?: { baseUrl?: string; apiKey?: string; model?: string; dimensions?: number };
    lightLLM?: { baseUrl?: string; apiKey?: string; model?: string };
}

export interface VRSessionDeps {
    char: CharacterProfile;
    /** 全部角色（算听歌房在场名单用） */
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig?: RealtimeConfig;
    memoryPalaceConfig?: MemoryConfigLike;
    updateCharacter: (id: string, updates: Partial<CharacterProfile>) => Promise<void> | void;
    /** 用户手动触发时指定的房间；省略 = 随机。不可用（如指定图书馆但无书）时自动回退随机。 */
    forcedRoom?: VRRoomId;
    /** 用户在邮局指定要让该角色回复的来信 id（forcedRoom 应为 postoffice）。 */
    forcedLetterId?: string;
    /** 用户亲手点的（「让 ta 现在去逛一次」这类），不受自动登入的最小间隔闸限制。 */
    manual?: boolean;
}

export interface VRSessionResult {
    ok: boolean;
    room?: VRRoomId;
    reason?: string;
    activity?: string;
}

const genId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const running = new Set<string>();

/**
 * 自动登入的最小间隔闸 —— 一个角色两次真实的模型调用之间，至少要隔够设定间隔的一半。
 *
 * 为什么要有它：熔断只认「一直失败」，可要是调用一直成功、只是被谁催着一分钟跑两趟，
 * 那是安安静静地烧钱，没有任何东西会喊停。这道闸跟成败无关，只看「上一次是什么时候」。
 *
 * 为什么记在内存里而不落存储：它兜的正是「调度状态本身出了问题」——上游的首火时刻写丢了、
 * 或者哪条路绕过了到期判断，靠的都是存储；把闸也存进去，就会跟着一起失效。页面一刷新
 * 计数就归零，而失控循环本来就活在单个页面实例里，内存态足够拦住。
 *
 * 用户手动点「让 ta 现在去逛一次」不受这道闸限制。
 */
const lastAutoCallAt = new Map<string, number>();
/** 被闸拦下的次数（成功跑一轮就归零）。正常调度永远是 0，非 0 本身就是「上游在失控」的证据。 */
const throttledCount = new Map<string, number>();
/** 间隔再怎么短、设定值再怎么脏，两轮之间也不该少于这个数。 */
const MIN_AUTO_GAP_FLOOR_MS = 5 * 60_000;

/**
 * 按角色的设定间隔算出「这一轮最早什么时候才允许再来」。
 *
 * 取设定间隔的一半，是想留出余量：调度本身会被后台节流推迟，掐得跟设定值一样紧
 * 会把正常的补火也误伤掉。设定值缺失或是脏数据（NaN、0、负数）时退回默认间隔，
 * 再由下限兜一道——不这么写的话 NaN 会让所有比较恒为 false，整道闸静悄悄失效。
 */
export function vrAutoGapMs(intervalMinutes?: number): number {
    const raw = Number(intervalMinutes);
    const minutes = Number.isFinite(raw) && raw > 0 ? raw : VR_DEFAULT_INTERVAL_MIN;
    return Math.max((minutes * 60_000) / 2, MIN_AUTO_GAP_FLOOR_MS);
}

/** 各角色当前被最小间隔闸拦下的累计次数，给诊断导出用。 */
export function getVRThrottleCounts(): Record<string, number> {
    return Object.fromEntries(throttledCount);
}

/**
 * 串行化共享房间状态（留言墙等）的 read-modify-write。
 *
 * 背景：留言簿在 session 开头读一次全量 board，LLM 跑完（数秒）后再整体写回。
 * 两个角色并发 session 时，后写的那次会基于"开头的旧快照"覆盖掉先写的角色刚
 * 落墙的留言 —— 表现为"有一个人说的内容不显示"（lost update）。
 *
 * 所有 VR session 都跑在同一个主线程 JS 上下文里（scheduler 驱动），所以一个
 * 内存级 async 锁就能完整消除竞态：LLM 调用照旧并发，只把"重新拉取最新 board
 * → 追加本次新消息 → 落库"这段极短的临界区串起来。
 */
let sharedRoomWriteChain: Promise<unknown> = Promise.resolve();
function withSharedRoomLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = sharedRoomWriteChain.then(fn, fn);
    // 推进链条并吞掉错误，避免某次失败卡死后续所有写入
    sharedRoomWriteChain = result.catch(() => {});
    return result;
}

/**
 * 选一本要读的书：
 * - 默认从所有尚未读完的书里随机轮换，不再因为某本刚开始读就一直黏到结尾；
 * - 用户圈了优先书单时，先在其中的未读完书目里轮换，读完后回到全书库；
 * - 有多个候选时排除上一次选中的书，避免连续两轮重复。
 *
 * random 作为参数是为了让选书规则可以稳定测试；生产环境使用 Math.random。
 */
export function pickNovel(
    novels: VRWorldNovel[],
    char: CharacterProfile,
    random: () => number = Math.random,
): VRWorldNovel | null {
    const readable = novels.filter(novel => novel.segments.length > 0);
    if (readable.length === 0) return null;
    const bookmarks = char.vrState?.novelBookmarks;
    const unfinished = readable.filter(novel => getBookmark(bookmarks, novel.id) < novel.segments.length);
    const available = unfinished.length > 0 ? unfinished : readable;
    const preferred = new Set(char.vrState?.preferredNovelIds || []);
    const preferredAvailable = preferred.size > 0
        ? available.filter(novel => preferred.has(novel.id))
        : [];
    let pool = preferredAvailable.length > 0 ? preferredAvailable : available;

    const lastNovelId = char.vrState?.lastNovelId;
    if (lastNovelId && pool.length > 1) {
        const withoutLast = pool.filter(novel => novel.id !== lastNovelId);
        if (withoutLast.length > 0) pool = withoutLast;
    }

    const rolled = Number(random());
    const normalized = Number.isFinite(rolled) ? Math.max(0, Math.min(0.999999999, rolled)) : 0;
    return pool[Math.floor(normalized * pool.length)] || pool[0] || null;
}

/** 汇总角色可点的歌（歌单 + 最近在听，按 id 去重，最近优先，最多 20）。 */
function gatherCharSongs(char: CharacterProfile): CharPlaylistSong[] {
    const mp = char.musicProfile;
    if (!mp) return [];
    const map = new Map<number, CharPlaylistSong>();
    for (const pl of mp.playlists || []) for (const s of pl.songs || []) if (!map.has(s.id)) map.set(s.id, s);
    for (const r of mp.recentPlays || []) if (r.song && !map.has(r.song.id)) map.set(r.song.id, r.song);
    return Array.from(map.values()).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 20);
}

/** 卡片标题行：活动播报本就该省略主语，若 LLM 已经带了名字就不再重复前缀。 */
function nameLine(name: string, act: string): string {
    const t = (act || '').replace(/^\s+/, '');
    return t.startsWith(name) ? t : `${name}${act}`;
}

/** roll 一个房间：图书馆需有书；听歌房需有歌单或正在放歌；留言簿/娱乐室/邮局/剧院恒可去。 */
export function rollRoom(char: CharacterProfile, novels: VRWorldNovel[], musicState: VRMusicRoomState | null, prefer?: VRRoomId): VRRoomId | null {
    // 信号坠落处【不进随机池】——它是用户自发参与的特殊活动，只在用户点「参与→指定角色」
    // 时以 forcedRoom='signal' 进入，角色不会自己随机逛过去。
    if (prefer === 'signal') return 'signal';
    // 用户手动点“听歌房”时必须尊重选择。即使当前没有歌，听歌房提示词也支持
    // 角色戴着耳机放空；不能因为没有歌单就悄悄随机跳去剧院等其他房间。
    if (prefer === 'music') return 'music';
    const pool: VRRoomId[] = ['guestbook', 'gym', 'postoffice', 'theater'];
    if (novels.length > 0) pool.push('library');
    if (gatherCharSongs(char).length > 0 || musicState?.nowPlaying) pool.push('music');
    if (prefer && pool.includes(prefer)) return prefer; // 指定的房间可用则去，否则回退随机
    return pool[Math.floor(Math.random() * pool.length)];
}

export async function runVRSession(deps: VRSessionDeps): Promise<VRSessionResult> {
    const { char, characters, apiConfig, userProfile, groups, realtimeConfig, memoryPalaceConfig, updateCharacter, forcedRoom, forcedLetterId, manual } = deps;

    if (running.has(char.id)) return { ok: false, reason: 'busy' };

    // 最小间隔闸（见 lastAutoCallAt）。走到这里说明有东西在催，正常调度不会这么密。
    if (!manual) {
        const minGap = vrAutoGapMs(char.vrState?.intervalMinutes);
        const since = Date.now() - (lastAutoCallAt.get(char.id) || 0);
        if (since < minGap) {
            const times = (throttledCount.get(char.id) || 0) + 1;
            throttledCount.set(char.id, times);
            // 被拦这件事本身就是线索，但真拦起来会几十秒一次，全记下来会把真实调用挤出日志。
            // 只在第一次和之后每 20 次留一行，把累计次数写进去。
            if (times === 1 || times % 20 === 0) {
                void logVRApiCall({
                    ts: Date.now(), charId: char.id, charName: char.name, ok: false, ms: 0,
                    kind: 'throttled', charEnabled: !!char.vrState?.enabled,
                    note: `距上次登入才 ${Math.round(since / 1000)} 秒，不到下限 ${Math.round(minGap / 60000)} 分钟，已拦下（累计 ${times} 次）`,
                });
            }
            return { ok: false, reason: 'too-soon' };
        }
    }

    // API 优先级：角色自带覆盖 > 彼方独立 API > 聊天默认
    const vrGlobalApi = await getVRApi();
    const vrApi = char.vrState?.api?.baseUrl ? char.vrState.api : (vrGlobalApi?.baseUrl ? vrGlobalApi : apiConfig);
    if (!vrApi.baseUrl) return { ok: false, reason: 'no-api' };

    const novels = await DB.getVRNovels();
    const musicState = await DB.getVRMusicRoom();
    let roomId = rollRoom(char, novels, musicState, forcedRoom);
    if (!roomId) return { ok: false, reason: 'no-content' };
    let room = getRoom(roomId);

    running.add(char.id);
    // 信号坠落处的写诗会话锁 token（抢到才有值）；finally 里兜底放锁
    let signalLockToken: string | null = null;
    // 这一轮是不是折在「调模型」这一步上。调度器只对这种失败记账做熔断——
    // 解析出错、落库出错都是本机自己的事，重试有意义，不该算到 API 头上。
    let modelCallFailed = false;
    try {
        window.dispatchEvent(new CustomEvent('vr-session-start', {
            detail: { charId: char.id, charName: char.name, room: room.id },
        }));
    } catch { /* SSR */ }

    try {
        // 公共材料
        const emojis = await DB.getEmojis();
        const categories = await DB.getEmojiCategories();
        const historyMsgs = await loadCharacterContextMessages(char);
        const contextLimit = Math.max(1, historyMsgs.length);

        // 在某房间的在场玩家名（含自己；用户本人接入彼方且挂在该房间时也算在场）
        const occupantsOf = (rid: VRRoomId) => {
            const ns = characters.filter(c => c.vrState?.enabled && c.vrState.currentRoom === rid).map(c => c.name);
            if (!ns.includes(char.name)) ns.push(char.name);
            const uv = userProfile?.vrState;
            if (uv?.enabled && uv.currentRoom === rid && userProfile.name && !ns.includes(userProfile.name)) {
                ns.push(userProfile.name);
            }
            return ns;
        };

        // 先加载房间数据 + 攒"记忆召回提示"（在场玩家名/相关上下文）——
        // 在 buildChatRequestPayload 之前算好，让向量召回能带上"对面这些人是谁"，
        // 角色才记得起自己跟他们的关系，而不是只按聊天历史召回。
        let roomTurn: string;
        let novel: VRWorldNovel | null = null;
        let win: ReturnType<typeof getReadingWindow> | null = null;
        let allAnn: Awaited<ReturnType<typeof DB.getVRAnnotations>> = [];
        let pickable: CharPlaylistSong[] = [];
        let guestbook: VRGuestbookState | null = null;
        let poTarget: VRLetter | null = null;
        let poReadTarget: VRLetter | null = null;
        let signalState: SignalState | null = null;
        let signalMode: 'append' | 'start' = 'append';
        let signalRolledLines = 0;
        let signalWhisper = '';
        const recallNames = new Set<string>();
        const recallExtra: string[] = [];

        // 信号坠落处（用户点「参与」发起）：在调 LLM 之前先抢写诗会话锁。
        // 抢到 → 读到锁内最新全文往下写；被打回（别人正在写 / 本首配额满 / 已暂停）→ 本轮作罢，
        // 并广播事件给面板温柔提示用户（此时一个 token 都还没花）。
        if (room.id === 'signal') {
            // 活动已落幕：任何写入在抢锁/调 LLM 之前直接打回（零 token）。诗集仍永远可读。
            if (SIGNAL_EVENT_ENDED) {
                try {
                    window.dispatchEvent(new CustomEvent('vr-signal-blocked', { detail: { charId: char.id, charName: char.name, reason: 'signal-ended' } }));
                } catch { /* SSR */ }
                return { ok: false, room: 'signal', reason: 'signal-ended' };
            }
            let lk: Awaited<ReturnType<typeof Signal.lock>>;
            try { lk = await Signal.lock(); }
            catch { return { ok: false, room: 'signal', reason: 'signal-offline' }; }
            if (!lk.acquired || !lk.state) {
                const reason = lk.paused ? 'signal-paused' : lk.quota ? 'signal-quota' : 'signal-busy';
                try {
                    window.dispatchEvent(new CustomEvent('vr-signal-blocked', { detail: { charId: char.id, charName: char.name, reason } }));
                } catch { /* SSR */ }
                return { ok: false, room: 'signal', reason };
            }
            signalLockToken = lk.token || null;
            signalState = lk.state;
        }

        if (room.id === 'library') {
            novel = pickNovel(novels, char);
            if (!novel) return { ok: false, room: 'library', reason: 'no-readable-novel' };
            const bm = getBookmark(char.vrState?.novelBookmarks, novel.id);
            win = getReadingWindow(novel, bm >= novel.segments.length ? 0 : bm);
            allAnn = await DB.getVRAnnotations(novel.id);
            const windowAnn = allAnn.filter(a => a.segIdx >= win!.from && a.segIdx < win!.to);
            roomTurn = buildLibraryRoomTurn(novel, win, windowAnn, char.id);
            recallExtra.push(`小说《${novel.title}》`);
            windowAnn.forEach(a => { if (a.authorId !== char.id) recallNames.add(a.authorName); });
        } else if (room.id === 'music') {
            pickable = gatherCharSongs(char);
            let nowLyric: string[] = [];
            const np = musicState?.nowPlaying;
            if (np) {
                try {
                    nowLyric = await getCharLyricSnippet(loadMusicCfgStandalone(), np.song.id, `${char.id}-${np.song.id}`, 10);
                } catch { /* 歌词拉取失败不影响 */ }
                recallNames.add(np.charName);
                recallExtra.push(`${np.song.name} ${np.song.artists}`);
            }
            occupantsOf('music').forEach(n => recallNames.add(n));
            roomTurn = buildMusicRoomTurn(musicState, occupantsOf('music'), pickable, char.name, nowLyric);
        } else if (room.id === 'guestbook') {
            guestbook = await DB.getVRGuestbook();
            let hotTopics: string[] = [];
            try {
                const snap: any = await DB.getLatestHotNewsSnapshot();
                const items: any[] = snap?.items || snap?.list || [];
                hotTopics = items.map(it => it?.title || it?.name || it?.desc).filter(Boolean);
            } catch { /* 热点拉不到就不聊 */ }
            occupantsOf('guestbook').forEach(n => recallNames.add(n));
            (guestbook?.messages || []).slice(-50).forEach(m => { if (m.authorId !== char.id) recallNames.add(m.authorName); });
            roomTurn = buildGuestbookRoomTurn(guestbook?.messages || [], occupantsOf('guestbook'), char.name, hotTopics);
        } else if (room.id === 'postoffice') {
            // 取一封"还没回过"的来信给角色看（有就可能回信，没有就写新信）
            const letters = await DB.getVRLetters();
            // 写新信时可借的新闻热点（让"分享新闻/锐评热点"这类信有真实素材，否则模型只能瞎编）
            let poHotTopics: string[] = [];
            try {
                const snap: any = await DB.getLatestHotNewsSnapshot();
                const items: any[] = snap?.items || snap?.list || [];
                poHotTopics = items.map(it => it?.title || it?.name || it?.desc).filter(Boolean);
            } catch { /* 热点拉不到就不聊 */ }
            // 优先：认领自己寄出、已收到回信、还没读过的信 → 读回信、写感触、封存
            poReadTarget = letters.find(l => l.box === 'outbox' && l.status === 'archived'
                && l.charId === char.id && (l.repliesReceived?.length || 0) > 0 && !l.reaction) || null;
            // 用户在邮局指定了某封来信让该角色回 → 直接锁定这封，要求回信
            const forcedTarget = forcedLetterId
                ? letters.find(l => l.id === forcedLetterId && l.box === 'inbox' && (l.replyStatus ?? 'none') === 'none' && l.remoteLetterId)
                : undefined;
            if (forcedTarget) {
                poTarget = forcedTarget;
                poReadTarget = null; // 强制回信优先于"读自己收到的回信"
                roomTurn = buildPostOfficeRoomTurn({ pen: forcedTarget.pen, content: forcedTarget.content }, char.name, true, poHotTopics);
            } else if (poReadTarget) {
                roomTurn = buildPostOfficeReadTurn(
                    poReadTarget.content,
                    (poReadTarget.repliesReceived || []).map(r => ({ pen: r.pen, content: r.content })),
                    char.name,
                );
            } else {
                const targets = letters.filter(l => l.box === 'inbox' && (l.replyStatus ?? 'none') === 'none' && l.remoteLetterId);
                poTarget = targets.length > 0 ? targets[Math.floor(Math.random() * targets.length)] : null;
                roomTurn = buildPostOfficeRoomTurn(poTarget ? { pen: poTarget.pen, content: poTarget.content } : null, char.name, false, poHotTopics);
            }
            // 把"眼前这封信聊的是什么"塞进召回 query —— 邮局没有在场玩家，
            // 召回若只靠聊天历史就抓不到角色对信里话题的相关记忆/观点。
            // 取要回的来信内容（forced > 随机来信）；只在读自己回信时取自己原信，
            // 让角色召回"我当初为什么写这个"。截断到 200 字，够 embedding 抓语义即可。
            const recallLetter = (forcedTarget || poTarget)?.content || poReadTarget?.content;
            if (recallLetter) recallExtra.push(`一封信聊到：${recallLetter.slice(0, 200)}`);
        } else if (room.id === 'theater') {
            occupantsOf('theater').forEach(n => recallNames.add(n));
            roomTurn = buildTheaterRoomTurn(occupantsOf('theater'), char.name);
        } else if (room.id === 'signal') {
            // 写诗会话锁已在 if-chain 之前抢到，signalState（锁内最新全文）已就绪。
            if (!signalState) return { ok: false, room: 'signal', reason: 'signal-busy' };
            const bk = signalState.booklet;
            // 三幕位置：当前这首 = 已封存数 + 1
            const poemOrdinal = (bk.poemCount || 0) + 1;
            const act = signalActFor(poemOrdinal, bk.poemsTarget);
            // 耳语（取即焚）+ 该 char 在本册写过的句子（禁复用意象）
            signalWhisper = takeSignalWhisper(char.id);
            const myPastLines = getMyRecentLines(char.name);
            if (signalState.poem && signalState.poem.status === 'open') {
                signalMode = 'append';
                roomTurn = buildSignalRoomTurn({
                    bookletTitle: bk.title, bookletSubtitle: bk.subtitle || undefined, theme: bk.theme,
                    charsPerLine: bk.charsPerLine, mode: 'append',
                    poemOrdinal, poemsTarget: bk.poemsTarget, act, myPastLines, whisper: signalWhisper,
                    poemTitle: signalState.poem.title, poemBrief: signalState.poem.brief, targetLines: signalState.poem.targetLines,
                    lines: (signalState.poem.lines || []).map(l => ({ seq: l.seq, pen: l.pen, content: l.content })),
                }, char.name);
                recallExtra.push(`一起接龙的诗《${signalState.poem.title}》`);
                if (signalWhisper) recallExtra.push(`用户临行前的嘱咐：${signalWhisper}`);
            } else {
                signalMode = 'start';
                signalRolledLines = rollPoemLines(bk.linesMin, bk.linesMax);
                roomTurn = buildSignalRoomTurn({
                    bookletTitle: bk.title, bookletSubtitle: bk.subtitle || undefined, theme: bk.theme,
                    charsPerLine: bk.charsPerLine, mode: 'start', rolledLines: signalRolledLines,
                    poemOrdinal, poemsTarget: bk.poemsTarget, act, myPastLines, whisper: signalWhisper,
                    recent: (signalState.recent || []).map(r => ({ title: r.title, lines: (r.lines || []).map(l => l.content) })),
                }, char.name);
                recallExtra.push(`现代诗、${act.title}`);
                if (signalWhisper) recallExtra.push(`用户临行前的嘱咐：${signalWhisper}`);
            }
        } else {
            // gym
            occupantsOf('gym').forEach(n => recallNames.add(n));
            roomTurn = buildGymRoomTurn(occupantsOf('gym'), char.name);
        }

        recallNames.delete(char.name);
        const namesArr = Array.from(recallNames).filter(Boolean);
        // 名字权重加重：同场角色的名字在召回 query 里重复多遍，并显式问"我跟这些人的关系/印象"，
        // 否则向量/BM25 容易被房间情景词淹没，召不回角色之间的过往与互相印象。
        const namesBoost = namesArr.length > 0
            ? [
                `此刻在《彼方》同场的人：${namesArr.join('、')}。`,
                `${namesArr.join(' ')} ${namesArr.join(' ')}`,             // 重复以抬高名字词频
                `我对${namesArr.join('、')}的印象、我和${namesArr.join('、')}之间的关系与过往。`,
            ].join('\n')
            : '';
        const recallQueryHint = (namesArr.length > 0 || recallExtra.length > 0)
            ? `${namesBoost}${recallExtra.length > 0 ? `\n相关：${recallExtra.join('、')}。` : ''}`.trim()
            : undefined;

        const payload = await buildChatRequestPayload({
            char, userProfile, groups, emojis, categories,
            historyMsgs, contextLimit, realtimeConfig, recallQueryHint,
            recallEntryPoint: 'vr_world',
            // 彼方可配独立 API（可能不支持视觉，如 DeepSeek 对 image_url 直接 400），
            // 且纯文本情景里历史图片只是撑爆上下文的噪声 → 压平成文本占位
            stripImages: true,
        });
        const systemPrompt = payload.systemPrompt + buildVRSystemAddendum(room, char.name, rollSessionVibe());

        // 调 LLM（记录一次调用，供"调用记录"对账）
        const baseUrl = vrApi.baseUrl.replace(/\/+$/, '');
        const callStart = Date.now();
        // 闸的基准点是「真的发出去了」，而不是「被调度触发了」——没书没歌那些早退的轮次
        // 一个 token 都没花，不该占掉下一次的额度。
        if (!manual) { lastAutoCallAt.set(char.id, callStart); throttledCount.delete(char.id); }
        let data: any;
        try {
            data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${vrApi.apiKey || 'sk-none'}` },
                body: JSON.stringify({
                    model: vrApi.model,
                    messages: [{ role: 'system', content: systemPrompt }, ...payload.cleanedApiMessages, { role: 'user', content: roomTurn }],
                    temperature: 0.9, stream: false,
                }),
            }, 2, 0, { appName: '彼方', charId: char.id, charName: char.name, purpose: '自由活动' });
            logVRApiCall({ ts: callStart, charId: char.id, charName: char.name, charEnabled: !!char.vrState?.enabled, room: room.id, model: vrApi.model, baseUrl, ok: true, ms: Date.now() - callStart });
        } catch (e: any) {
            modelCallFailed = true;
            logVRApiCall({ ts: callStart, charId: char.id, charName: char.name, charEnabled: !!char.vrState?.enabled, room: room.id, model: vrApi.model, baseUrl, ok: false, ms: Date.now() - callStart, error: (e?.message || String(e)).slice(0, 160) });
            throw e;
        }
        let aiContent: string = data.choices?.[0]?.message?.content || '';
        aiContent = aiContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

        const prevState = char.vrState || { enabled: true, intervalMinutes: VR_DEFAULT_INTERVAL_MIN };
        let activity = '';
        let cardLines: string[] = [];
        let meta: VRCardMeta;

        if (room.id === 'library') {
            // === 图书馆：落批注 + 推书签 ===
            const parsed = parseVROutput(aiContent);
            const label2id = new Map<string, string>();
            for (const a of allAnn) label2id.set(a.id.slice(-4), a.id);
            const savedExcerpts: string[] = [];
            const savedRefs: { segIdx: number; text: string }[] = [];
            let written = 0;
            for (const pa of parsed.annotations) {
                if (pa.segIdx < win!.from || pa.segIdx >= win!.to) continue;
                const targetId = pa.refLabel ? label2id.get(pa.refLabel) : undefined;
                const ann = buildAnnotation({ novelId: novel!.id, segIdx: pa.segIdx, authorId: char.id, authorName: char.name, content: pa.content, targetAnnotationId: targetId });
                await DB.saveVRAnnotation(ann);
                label2id.set(ann.id.slice(-4), ann.id);
                const ex = pa.content.length > 60 ? pa.content.slice(0, 60) + '…' : pa.content;
                savedExcerpts.push(ex);
                savedRefs.push({ segIdx: pa.segIdx, text: ex });
                written += 1;
            }
            const nextBookmark = win!.reachedEnd ? novel!.segments.length : win!.to;
            await updateCharacter(char.id, {
                vrState: {
                    ...prevState,
                    novelBookmarks: { ...(prevState.novelBookmarks || {}), [novel!.id]: nextBookmark },
                    lastNovelId: novel!.id,
                    currentRoom: 'library',
                    lastActiveAt: Date.now(),
                },
            });
            activity = parsed.activity || `读了《${novel!.title}》第 ${win!.from + 1}~${win!.to} 段${written ? `，留下了 ${written} 条批注` : '，安静读完没多说什么'}。`;
            cardLines = [`「彼方 · ${room.name}」`, nameLine(char.name, activity)];
            if (savedExcerpts.length) { cardLines.push('批注：'); for (const ex of savedExcerpts) cardLines.push(`· ${ex}`); }
            meta = { vrCard: true, room: 'library', activity, novelId: novel!.id, novelTitle: novel!.title, segRange: [win!.from, win!.to], annotationExcerpts: savedExcerpts, annotationRefs: savedRefs };
        } else if (room.id === 'music') {
            // === 听歌房：点歌进队列 + 乐评 + 推进循环队列 ===
            const parsed = parseMusicOutput(aiContent);
            // 角色在 prompt 里听到 / 锐评的那首，绑定开头快照（乐评、卡片都针对它）
            const curSong = musicState?.nowPlaying;
            const pick = (parsed.pickIdx !== undefined && pickable[parsed.pickIdx]) ? pickable[parsed.pickIdx] : undefined;
            let queuedLabel: string | undefined;
            let playingNow: VRMusicRoomState['nowPlaying'];

            // 串行化写入：临界区内重新拉取最新房间态，再做点歌/自动放/推进队首，
            // 杜绝并发 session 各拿旧快照整体写回而丢点歌、覆盖 nowPlaying。
            await withSharedRoomLock(async () => {
                const state: VRMusicRoomState = (await DB.getVRMusicRoom()) || { id: 'state', queue: [], updatedAt: Date.now() };
                state.queue = state.queue || [];
                // 点歌进队列
                if (pick) {
                    state.queue = [...state.queue, { song: pick, charId: char.id, charName: char.name }];
                    queuedLabel = `${pick.name} - ${pick.artists}`;
                }
                // 没点歌、队列也空，但角色有歌单 → 自动放一首自己的，
                // 免得新到访的角色还停在上一个人（甚至已经离开的人）点的歌上。
                if (state.queue.length === 0 && pickable.length > 0) {
                    const curId = state.nowPlaying?.song.id;
                    const freshSongs = pickable.filter(s => s.id !== curId);
                    const s = (freshSongs.length > 0 ? freshSongs : pickable)[Math.floor(Math.random() * (freshSongs.length > 0 ? freshSongs.length : pickable.length))];
                    state.queue = [{ song: s, charId: char.id, charName: char.name }];
                }
                // 推进：队列非空则把队首切为正在放（房间随每次到访"往前走"）
                if (state.queue.length > 0) {
                    const next = state.queue.shift()!;
                    state.nowPlaying = { song: next.song, charId: next.charId, charName: next.charName, since: Date.now() };
                }
                state.updatedAt = Date.now();
                await DB.saveVRMusicRoom(state);
                playingNow = state.nowPlaying;
            });

            // 乐评落入角色音乐人格（continuity）
            if (parsed.review && curSong && char.musicProfile) {
                const review: CharMusicReview = {
                    id: genId('rev'), targetType: 'song', targetId: String(curSong.song.id),
                    targetTitle: `${curSong.song.name} - ${curSong.song.artists}`, content: parsed.review, createdAt: Date.now(),
                };
                const mp = char.musicProfile;
                await updateCharacter(char.id, { musicProfile: { ...mp, reviews: [...(mp.reviews || []), review].slice(-50), updatedAt: Date.now() } });
            }

            await updateCharacter(char.id, { vrState: { ...prevState, currentRoom: 'music', lastActiveAt: Date.now() } });

            const songLabel = curSong ? `${curSong.song.name} - ${curSong.song.artists}` : undefined;
            activity = parsed.activity || (
                curSong ? `在听歌房听着《${curSong.song.name}》晃了一会儿。`
                : playingNow ? `进了听歌房，放上《${playingNow.song.name}》听了起来。`
                : `进了听歌房，戴上耳机放空。`);
            cardLines = [`「彼方 · ${room.name}」`, nameLine(char.name, activity)];
            if (parsed.review && songLabel) cardLines.push(`评《${songLabel}》：${parsed.review}`);
            if (queuedLabel) cardLines.push(`点了《${queuedLabel}》排进队列`);
            if (parsed.behavior) cardLines.push(`· ${parsed.behavior}`);
            meta = { vrCard: true, room: 'music', activity, songLabel, queuedLabel, behavior: parsed.behavior };
        } else if (room.id === 'guestbook') {
            // === 留言簿：发帖/回帖落墙 ===
            const parsed = parseGuestbookOutput(aiContent);
            // 用开头那份快照解析"回复谁"的 #编号映射（被回复的旧消息仍在最新墙上）
            const id2 = new Map<string, string>();
            const id2name = new Map<string, string>();
            for (const msg of (guestbook?.messages || [])) { id2.set(msg.id.slice(-4), msg.id); id2name.set(msg.id, msg.authorName); }
            let firstPost: string | undefined;
            let firstReplyName: string | undefined;
            const mine: { content: string; replyToName?: string }[] = [];
            const newMsgs: VRGuestbookMessage[] = [];
            for (const p of parsed.posts) {
                const replyToId = p.replyLabel ? id2.get(p.replyLabel) : undefined;
                const replyToName = replyToId ? id2name.get(replyToId) : undefined;
                const msg: VRGuestbookMessage = { id: genId('gb'), authorId: char.id, authorName: char.name, content: p.content, replyToId, replyToName, createdAt: Date.now() };
                newMsgs.push(msg);
                id2.set(msg.id.slice(-4), msg.id); id2name.set(msg.id, char.name); // 同批后续留言可回复前面这条
                mine.push({ content: p.content, replyToName });
                if (firstPost === undefined) { firstPost = p.content; firstReplyName = replyToName; }
            }
            // 串行化写入：临界区内重新拉取最新留言墙再追加本次新消息，杜绝并发覆盖
            if (newMsgs.length > 0) {
                await withSharedRoomLock(async () => {
                    const fresh = (await DB.getVRGuestbook()) || { id: 'board', messages: [], updatedAt: Date.now() };
                    fresh.messages = [...fresh.messages, ...newMsgs];
                    fresh.updatedAt = Date.now();
                    await DB.saveVRGuestbook(fresh);
                });
            }
            await updateCharacter(char.id, { vrState: { ...prevState, currentRoom: 'guestbook', lastActiveAt: Date.now() } });

            activity = parsed.activity || (firstPost
                ? (firstReplyName ? `在留言簿回了 ${firstReplyName} 一句` : `在留言簿发了条帖子`)
                : '在留言簿逛了逛');
            cardLines = [`「彼方 · ${room.name}」`, nameLine(char.name, activity)];
            // 把角色在留言墙上说的每句话原样带进 1v1 聊天/记忆（不再只截一句小总结）
            for (const m of mine) cardLines.push(m.replyToName ? `回复 ${m.replyToName}：${m.content}` : `留言：${m.content}`);
            meta = { vrCard: true, room: 'guestbook', activity, boardPost: firstPost, boardReplyToName: firstReplyName, boardPosts: mine };
        } else if (room.id === 'gym') {
            // === 娱乐室：纯造谣行为 ===
            const parsed = parseGymOutput(aiContent);
            await updateCharacter(char.id, { vrState: { ...prevState, currentRoom: 'gym', lastActiveAt: Date.now() } });
            activity = parsed.activity || '在娱乐室疯玩了一通。';
            cardLines = [`「彼方 · ${room.name}」`, nameLine(char.name, activity)];
            if (parsed.behavior) cardLines.push(`· ${parsed.behavior}`);
            meta = { vrCard: true, room: 'gym', activity, behavior: parsed.behavior };
        } else if (room.id === 'theater') {
            // === 剧院：角色即兴写一出舞台剧投稿 ===
            const parsed = parseScriptOutput(aiContent);
            const script: VRScript = {
                id: genId('scr'), title: parsed.title, logline: parsed.logline,
                roles: parsed.roles, body: parsed.body,
                authorId: char.id, authorName: char.name, source: 'char', createdAt: Date.now(),
            };
            await DB.saveVRScript(script);
            await updateCharacter(char.id, { vrState: { ...prevState, currentRoom: 'theater', lastActiveAt: Date.now() } });
            activity = `创作了一出${parsed.logline ? `关于「${parsed.logline}」的` : ''}舞台剧《${parsed.title}》。`;
            cardLines = [`「彼方 · ${room.name}」`, nameLine(char.name, activity)];
            if (parsed.roles.length) cardLines.push(`登场：${parsed.roles.map(r => r.name).join('、')}`);
            meta = { vrCard: true, room: 'theater', activity };
        } else if (room.id === 'signal') {
            // === 信号坠落处：解析 1~2 行 → 写回后端（起新篇 / 接龙）===
            const bk = signalState!.booklet;
            const parsed = parseSignalOutput(aiContent, signalMode, bk.charsPerLine);
            const myLines = parsed.lines;
            if (myLines.length === 0) return { ok: false, room: 'signal', reason: 'empty' };
            const prevCount = (signalMode === 'append' && signalState!.poem) ? signalState!.poem.lineCount : 0;
            let resultPoem: SignalPoem | undefined;
            let isNew = false;
            try {
                if (signalMode === 'append' && signalState!.poem) {
                    const r = await Signal.append({ poemId: signalState!.poem.id, lines: myLines, pen: char.name });
                    // 配额兜底命中（罕见竞态）：本次未写入，作罢
                    if (r.quota) return { ok: false, room: 'signal', reason: 'signal-quota' };
                    resultPoem = r.poem;
                } else {
                    const r = await Signal.start({ title: parsed.title || '无题', brief: parsed.brief || '', lines: myLines, targetLines: signalRolledLines, pen: char.name });
                    resultPoem = r.poem || undefined;
                    isNew = true;
                }
            } catch (e: any) {
                // 起新篇时撞上别人刚起的头（409 poem-open）→ 不浪费，接到那首末尾
                if (signalMode === 'start' && e?.body?.poem?.id) {
                    try {
                        const r = await Signal.append({ poemId: e.body.poem.id, lines: myLines, pen: char.name });
                        if (r.quota) return { ok: false, room: 'signal', reason: 'signal-quota' };
                        resultPoem = r.poem;
                        isNew = false;
                    } catch { return { ok: false, room: 'signal', reason: 'signal-write-failed' }; }
                } else {
                    return { ok: false, room: 'signal', reason: 'signal-write-failed' };
                }
            }
            // 写完即放锁，让下一个 char 能马上接（不必等 TTL）
            if (signalLockToken) { void Signal.unlock(signalLockToken); signalLockToken = null; }
            // 诗在这期间被删/封存导致没拿到结果 → 跳过，不出空卡
            if (!resultPoem) return { ok: false, room: 'signal', reason: 'signal-gone' };
            await updateCharacter(char.id, { vrState: { ...prevState, currentRoom: 'signal', lastActiveAt: Date.now() } });
            // 记本地精确归属：本轮新写的那 1~2 行（resultPoem 末尾 prevCount 之后的）都是本 char 写的
            // （连正文一起记，下次写诗喂回去禁复用意象）
            const addedLines = (resultPoem.lines || []).slice(prevCount);
            for (const ln of addedLines) recordMyLine(resultPoem.id, ln.seq, char.name, ln.content);
            const linesSoFar = (resultPoem.lines || []).map(l => l.content);
            const lineSeq = linesSoFar.length;
            const poemTitle = (resultPoem.title || parsed.title || '无题').replace(/^[《〈「『【]+/, '').replace(/[》〉」』】]+$/, '');
            const target = resultPoem.targetLines || signalRolledLines || lineSeq;
            const sealed = resultPoem.status === 'sealed';
            const addedText = addedLines.length ? addedLines.map(l => l.content) : myLines;
            activity = parsed.activity || (isNew
                ? `在信号坠落处起了个新篇《${poemTitle}》，定了个调子。`
                : `在信号坠落处给一首陌生人的诗续了 ${addedText.length} 行${sealed ? '，正好写满封笔' : ''}。`);
            cardLines = [`「彼方 · ${room.name}」`, nameLine(char.name, activity)];
            cardLines.push(`《${poemTitle}》（${lineSeq}/${target} 句${sealed ? ' · 已封存' : ''}）`);
            for (const t of addedText) cardLines.push(`${isNew ? '起笔' : '续'}：${t}`);
            // 用户的耳语随卡片进聊天/记忆（诗里没有它，但角色记得「是带着这句话去写的」）
            if (signalWhisper) cardLines.push(`（出发前，用户对 ta 说：「${signalWhisper}」）`);
            meta = {
                vrCard: true, room: 'signal', activity, poemTitle, signalLine: addedText.join(' / '),
                poemLineSeq: lineSeq, poemTargetLines: target, signalIsNew: isNew,
                poemLinesSoFar: linesSoFar, bookletTitle: bk.title,
                ...(signalWhisper ? { signalWhisper } : {}),
            };
        } else if (room.id === 'postoffice' && poReadTarget) {
            // === 邮局：认领自己寄出的信、读陌生人的回信、写感触 → 封存 ===
            const parsed = parsePostOfficeReadOutput(aiContent);
            const now = Date.now();
            await DB.saveVRLetter({ ...poReadTarget, status: 'sealed', reaction: { content: parsed.reaction || '', createdAt: now } });
            // 角色读完并封存 → 现在才释放后端（删除信+回复），在此之前都允许继续累积多方回复
            if (poReadTarget.remoteId) void PostOffice.release([poReadTarget.remoteId]).catch(() => {});
            await updateCharacter(char.id, { vrState: { ...prevState, currentRoom: 'postoffice', lastActiveAt: Date.now() } });
            activity = parsed.activity || '在邮局读完陌生人的回信，怔了几秒，把信收进了信匣。';
            cardLines = [`「彼方 · ${room.name}」`, nameLine(char.name, activity)];
            if (parsed.reaction) cardLines.push(`感触：${parsed.reaction}`);
            meta = { vrCard: true, room: 'postoffice', activity, letterExcerpt: parsed.reaction, behavior: '读完陌生人的回信，那封漂流信封存了。' };
        } else {
            // === 邮局：写漂流信 / 回信，落本地队列等用户一键寄出 ===
            const parsed = parsePostOfficeOutput(aiContent);
            const now = Date.now();
            let letterExcerpt: string | undefined;
            // 回信优先（有来信目标且模型给了回信）
            if (parsed.reply && poTarget) {
                await DB.saveVRLetter({
                    ...poTarget,
                    replyStatus: 'queued',
                    reply: { charId: char.id, pen: char.name, content: parsed.reply, createdAt: now },
                });
                letterExcerpt = parsed.reply;
            } else if (parsed.newLetter || parsed.reply) {
                // 写新信（或模型把回信当新信写了也收下）
                const content = parsed.newLetter || parsed.reply!;
                await DB.saveVRLetter({
                    id: genId('lt'), box: 'outbox', pen: char.name, content, createdAt: now, charId: char.id, status: 'queued',
                });
                letterExcerpt = content;
            }
            await updateCharacter(char.id, { vrState: { ...prevState, currentRoom: 'postoffice', lastActiveAt: Date.now() } });
            const wasReply = !!(parsed.reply && poTarget);
            activity = parsed.activity || (wasReply ? '在邮局回了一封陌生来信。' : '在邮局给陌生人写了封漂流信。');
            cardLines = [`「彼方 · ${room.name}」`, nameLine(char.name, activity)];
            if (letterExcerpt) cardLines.push(`${wasReply ? '回信' : '信'}：${letterExcerpt.length > 80 ? letterExcerpt.slice(0, 80) + '…' : letterExcerpt}`);
            meta = { vrCard: true, room: 'postoffice', activity, letterExcerpt };
        }

        await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'vr_card', content: cardLines.join('\n'), metadata: meta });

        // 记忆管线（fire-and-forget）
        try {
            const mpEmb = memoryPalaceConfig?.embedding;
            const mpLLMConfigured = memoryPalaceConfig?.lightLLM;
            const mpLLM = (mpLLMConfigured?.baseUrl) ? mpLLMConfigured : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
            if (char.memoryPalaceEnabled && mpEmb?.baseUrl && mpEmb?.apiKey && mpLLM.baseUrl) {
                const recentMsgs = await DB.getRecentMessagesByCharId(char.id, 50);
                void processNewMessagesWithAutoArchive(recentMsgs, char.id, char.name, mpEmb as any, mpLLM as any, userProfile?.name || '', false).catch(() => {});
            }
        } catch { /* 记忆失败不影响主流程 */ }

        try {
            window.dispatchEvent(new CustomEvent('vr-session-done', { detail: { charId: char.id, room: room.id, activity } }));
        } catch { /* SSR */ }

        return { ok: true, room: room.id, activity };
    } catch (err) {
        console.error('[VRWorld] session error:', err);
        return { ok: false, room: room.id, reason: modelCallFailed ? 'api-error' : 'error' };
    } finally {
        running.delete(char.id);
        // 兜底放锁：任何提前 return / 异常路径漏放，这里补放（漏了也有 TTL 自动回收）
        if (signalLockToken) void Signal.unlock(signalLockToken).catch(() => {});
        try { window.dispatchEvent(new CustomEvent('vr-session-end', { detail: { charId: char.id } })); } catch { /* SSR */ }
    }
}
