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
    VRGuestbookState, VRGuestbookMessage, VRLetter,
} from '../../types';
import { DB } from '../db';
import { buildChatRequestPayload } from '../chatRequestPayload';
import { safeFetchJson } from '../safeApi';
import { processNewMessages } from '../memoryPalace/pipeline';
import { loadMusicCfgStandalone } from '../../context/MusicContext';
import { getCharLyricSnippet } from '../charLyricCache';
import { getRoom, VR_DEFAULT_INTERVAL_MIN } from './constants';
import { getVRApi, logVRApiCall } from './vrApi';
import { PostOffice } from './postOffice';
import { getReadingWindow, getBookmark, buildAnnotation } from './novel';
import {
    buildVRSystemAddendum, buildLibraryRoomTurn, parseVROutput,
    buildMusicRoomTurn, parseMusicOutput,
    buildGuestbookRoomTurn, parseGuestbookOutput,
    buildGymRoomTurn, parseGymOutput,
    buildPostOfficeRoomTurn, parsePostOfficeOutput,
    buildPostOfficeReadTurn, parsePostOfficeReadOutput,
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
}

export interface VRSessionResult {
    ok: boolean;
    room?: VRRoomId;
    reason?: string;
    activity?: string;
}

const genId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const running = new Set<string>();

/** 选一本要读的书：优先续读未读完的，否则取最近更新的一本。 */
function pickNovel(novels: VRWorldNovel[], char: CharacterProfile): VRWorldNovel | null {
    if (novels.length === 0) return null;
    const bookmarks = char.vrState?.novelBookmarks;
    const unfinished = novels.filter(n => getBookmark(bookmarks, n.id) < n.segments.length);
    const pool = unfinished.length > 0 ? unfinished : novels;
    pool.sort((a, b) => {
        const aStarted = getBookmark(bookmarks, a.id) > 0 ? 1 : 0;
        const bStarted = getBookmark(bookmarks, b.id) > 0 ? 1 : 0;
        if (aStarted !== bStarted) return bStarted - aStarted;
        return b.updatedAt - a.updatedAt;
    });
    return pool[0];
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

/** roll 一个房间：图书馆需有书；听歌房需有歌单或正在放歌；留言簿/娱乐室/邮局恒可去。 */
function rollRoom(char: CharacterProfile, novels: VRWorldNovel[], musicState: VRMusicRoomState | null, prefer?: VRRoomId): VRRoomId | null {
    const pool: VRRoomId[] = ['guestbook', 'gym', 'postoffice'];
    if (novels.length > 0) pool.push('library');
    if (gatherCharSongs(char).length > 0 || musicState?.nowPlaying) pool.push('music');
    if (prefer && pool.includes(prefer)) return prefer; // 指定的房间可用则去，否则回退随机
    return pool[Math.floor(Math.random() * pool.length)];
}

export async function runVRSession(deps: VRSessionDeps): Promise<VRSessionResult> {
    const { char, characters, apiConfig, userProfile, groups, realtimeConfig, memoryPalaceConfig, updateCharacter, forcedRoom, forcedLetterId } = deps;

    if (running.has(char.id)) return { ok: false, reason: 'busy' };

    // API 优先级：角色自带覆盖 > 彼方独立 API > 聊天默认
    const vrGlobalApi = await getVRApi();
    const vrApi = char.vrState?.api?.baseUrl ? char.vrState.api : (vrGlobalApi?.baseUrl ? vrGlobalApi : apiConfig);
    if (!vrApi.baseUrl) return { ok: false, reason: 'no-api' };

    const novels = await DB.getVRNovels();
    const musicState = await DB.getVRMusicRoom();
    const roomId = rollRoom(char, novels, musicState, forcedRoom);
    if (!roomId) return { ok: false, reason: 'no-content' };
    const room = getRoom(roomId);

    running.add(char.id);
    try {
        window.dispatchEvent(new CustomEvent('vr-session-start', {
            detail: { charId: char.id, charName: char.name, room: room.id },
        }));
    } catch { /* SSR */ }

    try {
        // 公共材料
        const emojis = await DB.getEmojis();
        const categories = await DB.getEmojiCategories();
        const contextLimit = char.contextLimit || 500;
        const historyMsgs = await DB.getRecentMessagesByCharId(char.id, contextLimit);

        // 在某房间的在场玩家名（含自己）
        const occupantsOf = (rid: VRRoomId) => {
            const ns = characters.filter(c => c.vrState?.enabled && c.vrState.currentRoom === rid).map(c => c.name);
            if (!ns.includes(char.name)) ns.push(char.name);
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
        const recallNames = new Set<string>();
        const recallExtra: string[] = [];

        if (room.id === 'library') {
            novel = pickNovel(novels, char)!;
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
                roomTurn = buildPostOfficeRoomTurn({ pen: forcedTarget.pen, content: forcedTarget.content }, char.name, true);
            } else if (poReadTarget) {
                roomTurn = buildPostOfficeReadTurn(
                    poReadTarget.content,
                    (poReadTarget.repliesReceived || []).map(r => ({ pen: r.pen, content: r.content })),
                    char.name,
                );
            } else {
                const targets = letters.filter(l => l.box === 'inbox' && (l.replyStatus ?? 'none') === 'none' && l.remoteLetterId);
                poTarget = targets.length > 0 ? targets[Math.floor(Math.random() * targets.length)] : null;
                roomTurn = buildPostOfficeRoomTurn(poTarget ? { pen: poTarget.pen, content: poTarget.content } : null, char.name);
            }
        } else {
            // gym
            occupantsOf('gym').forEach(n => recallNames.add(n));
            roomTurn = buildGymRoomTurn(occupantsOf('gym'), char.name);
        }

        recallNames.delete(char.name);
        const namesArr = Array.from(recallNames).filter(Boolean);
        const recallQueryHint = (namesArr.length > 0 || recallExtra.length > 0)
            ? `${namesArr.length > 0 ? `此刻在《彼方》同场的人：${namesArr.join('、')}。` : ''}${recallExtra.length > 0 ? `相关：${recallExtra.join('、')}。` : ''}`
            : undefined;

        const payload = await buildChatRequestPayload({
            char, userProfile, groups, emojis, categories,
            historyMsgs, contextLimit, realtimeConfig, recallQueryHint,
        });
        const systemPrompt = payload.systemPrompt + buildVRSystemAddendum(room, char.name);

        // 调 LLM（记录一次调用，供"调用记录"对账）
        const baseUrl = vrApi.baseUrl.replace(/\/+$/, '');
        const callStart = Date.now();
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
            logVRApiCall({ ts: callStart, charName: char.name, room: room.id, model: vrApi.model, baseUrl, ok: true, ms: Date.now() - callStart });
        } catch (e: any) {
            logVRApiCall({ ts: callStart, charName: char.name, room: room.id, model: vrApi.model, baseUrl, ok: false, ms: Date.now() - callStart, error: (e?.message || String(e)).slice(0, 160) });
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
                vrState: { ...prevState, novelBookmarks: { ...(prevState.novelBookmarks || {}), [novel!.id]: nextBookmark }, currentRoom: 'library', lastActiveAt: Date.now() },
            });
            activity = parsed.activity || `读了《${novel!.title}》第 ${win!.from + 1}~${win!.to} 段${written ? `，留下了 ${written} 条批注` : '，安静读完没多说什么'}。`;
            cardLines = [`「彼方 · ${room.name}」`, nameLine(char.name, activity)];
            if (savedExcerpts.length) { cardLines.push('批注：'); for (const ex of savedExcerpts) cardLines.push(`· ${ex}`); }
            meta = { vrCard: true, room: 'library', activity, novelId: novel!.id, novelTitle: novel!.title, segRange: [win!.from, win!.to], annotationExcerpts: savedExcerpts, annotationRefs: savedRefs };
        } else if (room.id === 'music') {
            // === 听歌房：点歌进队列 + 乐评 + 推进循环队列 ===
            const parsed = parseMusicOutput(aiContent);
            const state: VRMusicRoomState = musicState || { id: 'state', queue: [], updatedAt: Date.now() };
            const curSong = state.nowPlaying;

            // 点歌进队列
            state.queue = state.queue || [];
            let queuedLabel: string | undefined;
            if (parsed.pickIdx !== undefined && pickable[parsed.pickIdx]) {
                const s = pickable[parsed.pickIdx];
                state.queue = [...state.queue, { song: s, charId: char.id, charName: char.name }];
                queuedLabel = `${s.name} - ${s.artists}`;
            }
            // 没点歌、队列也空，但角色有歌单 → 自动放一首自己的，
            // 免得新到访的角色还停在上一个人（甚至已经离开的人）点的歌上。
            if (state.queue.length === 0 && pickable.length > 0) {
                const curId = state.nowPlaying?.song.id;
                const fresh = pickable.filter(s => s.id !== curId);
                const s = (fresh.length > 0 ? fresh : pickable)[Math.floor(Math.random() * (fresh.length > 0 ? fresh.length : pickable.length))];
                state.queue = [{ song: s, charId: char.id, charName: char.name }];
            }
            // 推进：队列非空则把队首切为正在放（房间随每次到访"往前走"）
            if (state.queue.length > 0) {
                const next = state.queue.shift()!;
                state.nowPlaying = { song: next.song, charId: next.charId, charName: next.charName, since: Date.now() };
            }
            state.updatedAt = Date.now();
            await DB.saveVRMusicRoom(state);

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
            const playingNow = state.nowPlaying;
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
            const board: VRGuestbookState = guestbook || { id: 'board', messages: [], updatedAt: Date.now() };
            const id2 = new Map<string, string>();
            const id2name = new Map<string, string>();
            for (const msg of board.messages) { id2.set(msg.id.slice(-4), msg.id); id2name.set(msg.id, msg.authorName); }
            let firstPost: string | undefined;
            let firstReplyName: string | undefined;
            const mine: { content: string; replyToName?: string }[] = [];
            for (const p of parsed.posts) {
                const replyToId = p.replyLabel ? id2.get(p.replyLabel) : undefined;
                const replyToName = replyToId ? id2name.get(replyToId) : undefined;
                const msg: VRGuestbookMessage = { id: genId('gb'), authorId: char.id, authorName: char.name, content: p.content, replyToId, replyToName, createdAt: Date.now() };
                board.messages.push(msg);
                id2.set(msg.id.slice(-4), msg.id); id2name.set(msg.id, char.name);
                mine.push({ content: p.content, replyToName });
                if (firstPost === undefined) { firstPost = p.content; firstReplyName = replyToName; }
            }
            board.messages = board.messages.slice(-200);
            board.updatedAt = Date.now();
            await DB.saveVRGuestbook(board);
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
                void processNewMessages(recentMsgs, char.id, char.name, mpEmb as any, mpLLM as any, userProfile?.name || '', false).catch(() => {});
            }
        } catch { /* 记忆失败不影响主流程 */ }

        try {
            window.dispatchEvent(new CustomEvent('vr-session-done', { detail: { charId: char.id, room: room.id, activity } }));
        } catch { /* SSR */ }

        return { ok: true, room: room.id, activity };
    } catch (err) {
        console.error('[VRWorld] session error:', err);
        return { ok: false, room: room.id, reason: 'error' };
    } finally {
        running.delete(char.id);
        try { window.dispatchEvent(new CustomEvent('vr-session-end', { detail: { charId: char.id } })); } catch { /* SSR */ }
    }
}
