import { withReplyCancellation, type ReplyRun } from './chatReplyCancellation';

import { DB } from './db';
import { BUILTIN_SULLY_ID } from './sullyIdentity';
import { SULLY_HELP_COMMAND, SULLY_HELP_PREVIEW } from './sullyHelpCommand';
import { LocalNotifications } from '@capacitor/local-notifications';
import { CharacterProfile, CharPlaylistSong } from '../types';
import { sanitizeForBubble } from './sanitize';
import { extractTransferCommands } from './transferFormat';
import { executeLifeDirectives } from './lifeRecords';
import { wallClockToTimestamp } from './timezone';
import { CollaborationStore } from '../features/collaboration/store';
import {
    collaborationFileMessageMetadata,
    extractCollaborationFileDirectives,
    resolveCollaborationFileByTitle,
} from '../features/collaboration/chatLibrary';

export interface MusicActionSnapshot {
    songId: number;
    name: string;
    artists: string;
    album: string;
    albumPic: string;
    duration: number;
    fee: number;
}

/**
 * 把 user 的歌加到 char 的歌单时，char 可以指定目标：
 * - 不传 target → 默认放进第一个歌单（兼容老 [[MUSIC_ACTION:add]]）
 * - target.kind === 'existing' → 按标题模糊匹配现有歌单；匹配不到回落到第一个
 * - target.kind === 'new' → 现场新建一个歌单，把这首作为第一首
 *
 * 不论哪种，存入 char 歌单时都会打上 source: 'user' 标签，让 char 之后"听"
 * 这首歌时知道是从 user 那里收来的（prompt 注入会用到）。
 */
export type AddSongTarget =
    | { kind: 'existing'; title: string }
    | { kind: 'new'; title: string; description?: string };

export interface MusicActionHooks {
    /** 返回 user 此刻正在听的歌快照（chatParser 自己不去碰 MusicContext） */
    getListeningSnapshot: () => MusicActionSnapshot | null;
    /** 将 charId 加入"一起听"名单（chatParser 不维护状态，只通知） */
    joinListeningTogether: (charId: string) => void;
    /**
     * 把 song 加到 char 的歌单。
     * 返回 { playlistTitle, created } —— created=true 表示这次是新建了歌单。
     */
    addSongToCharPlaylist: (
        charId: string,
        song: CharPlaylistSong,
        target?: AddSongTarget,
    ) => Promise<{ playlistTitle: string; created: boolean } | null>;
}

/**
 * 主动消息 2.0 冻在 music_action directive 里的那首歌（见 worker/amsg 的 attachSceneSong）。
 *
 * 为什么要有这一层：定时消息的正文是角色几小时前对着**它自己那时在听的那首**写的，
 * 而 `[[MUSIC_ACTION:add|歌单标题]]` 标签里只有歌单名、没有歌名。重放时若只能取
 * 「用户此刻在听的那首」，用户多半早就没在放歌了 —— 正文聊着这首歌，卡片和加歌单
 * 却整个没发生。worker 到点把那首歌冻进 directive，调用方（applyAssistantPostProcessing）
 * 再显式传进来。本地聊天路径不传，走实时快照。
 */
export interface FrozenMusicSong {
    id?: number;
    name: string;
    artists: string;
}

/** 冻结的那首歌来自推送 metadata，字段形状不保证；歌名都没有就当没传。 */
const normalizeFrozenSong = (song?: FrozenMusicSong | null): FrozenMusicSong | null => {
    if (!song || typeof song.name !== 'string' || !song.name.trim()) return null;
    return {
        id: typeof song.id === 'number' ? song.id : undefined,
        name: song.name,
        artists: typeof song.artists === 'string' ? song.artists : '',
    };
};

/**
 * 把冻结的那首歌还原成一张完整快照 —— 卡片要封面、加歌单要时长/收费这些字段，
 * 而 directive 里只带得动 id / 歌名 / 歌手（推送 payload 就那么点额度）。
 *
 * 那首歌是从角色自己的歌单抽样池里挑的，所以回角色歌单按 id 找基本必中；id 对不上
 * （歌单被改过）再按歌名 + 歌手兜一次。都找不到就只用手上这三个字段，封面空着 ——
 * 也比把用户此刻在听的另一首当成它强。
 */
const resolveFrozenSongSnapshot = async (
    charId: string,
    frozen: FrozenMusicSong,
): Promise<MusicActionSnapshot> => {
    try {
        const chars = await DB.getAllCharacters();
        const songs = (chars.find(c => c.id === charId)?.musicProfile?.playlists || [])
            .flatMap(pl => pl.songs || []);
        const norm = (s: string) => (s || '').trim().toLowerCase();
        const hit = (frozen.id != null ? songs.find(s => s.id === frozen.id) : undefined)
            || songs.find(s => norm(s.name) === norm(frozen.name) && norm(s.artists) === norm(frozen.artists))
            || songs.find(s => norm(s.name) === norm(frozen.name));
        if (hit) {
            return {
                songId: hit.id,
                name: hit.name,
                artists: hit.artists,
                album: hit.album,
                albumPic: hit.albumPic,
                duration: hit.duration,
                fee: hit.fee,
            };
        }
    } catch (e) {
        console.warn('[MusicAction] 回角色歌单补歌曲信息失败，只用推送里带的那几个字段:', e);
    }
    return {
        songId: frozen.id ?? 0,
        name: frozen.name,
        artists: frozen.artists,
        album: '',
        albumPic: '',
        duration: 0,
        fee: 0,
    };
};

// 转账的提取（规范标签 + 模型掉格式的系统日志形态）统一在 utils/transferFormat.ts:
// extractTransferCommands —— 与 worker classifier 共用一份源码。master 上曾有一版
// 独立实现 extractAssistantTransfers, 合并时其能力（全角括号【】/ 主语「我」/ credits
// 后缀）已并入 transferFormat, 测试见 utils/chatParser.transfer.test.ts。

export const ChatParser = {
    // Return cleaned content and perform side effects
    parseAndExecuteActions: async (
        aiContent: string,
        charId: string,
        charName: string,
        addToast: (msg: string, type: 'info'|'success'|'error') => void,
        musicHooks?: MusicActionHooks,
        /** 角色自定义时区；定时消息里的时间是角色照着自己的钟写的，要按这个还原成真实时刻。 */
        charTz?: string,
        /**
         * 这一轮消息该落的时间戳（离线补收时是原始发送时刻）。不传则各条按写库当刻。
         *
         * 必须跟 applyAssistantPostProcessing 的 persistMessage 用同一个值：不然离线补收时
         * 正文气泡显示凌晨三点、同一条消息拆出来的戳一戳/转账/日程系统提示显示「用户打开
         * App 那一刻」，一条消息被劈成两个时间。
         */
        messageTimestamp?: number,
        /**
         * 这一轮消息统一继承的 metadata（主动消息 2.0 的 `source` / `activeMsg2.messageId` 等，
         * 见 applyAssistantPostProcessing 的 mcdInheritMeta）。
         *
         * 副作用产物（戳一戳 / 转账卡 / 收款回执 / 音乐卡 / 新闻卡 / 日程系统提示 / 生活记录卡）
         * 要跟正文气泡带同一个标记：主动消息处理失败后会整条重来，重来前靠
         * metadata.activeMsg2.messageId 认领「这条推送上一趟已经写下的东西」。副作用跑在正文
         * 之前，一条都认不出来就会被当成「上次什么都没做」，整套副作用再跑一遍——同一笔转账
         * 落两张卡、日记写两遍。
         */
        inheritMeta?: Record<string, any>,
        /**
         * 这一轮 `[[MUSIC_ACTION:…]]` 说的是哪首歌（见 FrozenMusicSong）。
         * 只有主动消息 2.0 的定时路径传，其余路径不传 = 取用户此刻在听的那首。
         */
        frozenMusicSong?: FrozenMusicSong,
        replyRun?: ReplyRun,
    ) => {
        const replyStep = <T>(operation: () => Promise<T>) => withReplyCancellation(replyRun, operation);
        replyRun?.check();
        let content = aiContent;
        /** 落库统一走这里，别直接调 DB.saveMessage —— 漏一处就是一条消息两个时间、重试时还认不出来。 */
        const persist = (msg: Parameters<typeof DB.saveMessage>[0]) => (replyRun?.saveMessage ?? DB.saveMessage)({
            ...msg,
            ...(messageTimestamp != null ? { timestamp: messageTimestamp } : {}),
            // 卡片自己的字段优先，inheritMeta 只补它没有的键（两边键名本来就不重叠，这里是防御）
            ...(inheritMeta ? { metadata: { ...inheritMeta, ...(msg.metadata || {}) } } : {}),
        });

        const withoutHandoff = content.replace(SULLY_HELP_COMMAND, '');
        if (withoutHandoff !== content) {
            content = withoutHandoff.trim();
            if (charId === BUILTIN_SULLY_ID) {
                await replyStep(() => persist({
                    charId, role: 'assistant', type: 'sully_help_card', content: SULLY_HELP_PREVIEW,
                }));
            }
        }

        // COLLAB_FILE — current-chat collaboration mode can hand the user an
        // existing file from the sidecar cabinet. The chat message stores only
        // metadata + assetId; the canonical Blob remains in CollaborationStore.
        const fileDirectives = extractCollaborationFileDirectives(content);
        if (fileDirectives.requestedTitles.length > 0) {
            content = fileDirectives.visibleText;
            try {
                const chars = await replyStep(async () => DB.getAllCharacters());
                const collaborationEnabled = !!chars.find(char => char.id === charId)?.chatCollaborationEnabled;
                if (!collaborationEnabled) {
                    console.warn('[CollaborationFileCabinet] 忽略未开启协同能力时的文件标记:', { charId });
                } else {
                    const files = await replyStep(async () => CollaborationStore.listLibraryFiles(charId));
                    for (const requestedTitle of fileDirectives.requestedTitles) {
                        const file = resolveCollaborationFileByTitle(files, requestedTitle);
                        if (!file) {
                            addToast(`文件柜里找不到《${requestedTitle}》，已跳过发送`, 'error');
                            continue;
                        }
                        await replyStep(async () => persist({
                            charId,
                            role: 'assistant',
                            type: 'collaboration_file',
                            content: `[协同文件：${file.name}]`,
                            metadata: collaborationFileMessageMetadata(file),
                        }));
                    }
                }
            } catch (error) {
                replyRun?.check();
                console.warn('[CollaborationFileCabinet] 发送文件失败:', error);
                addToast('协同文件柜暂时读取失败', 'error');
            }
        }

        // POKE
        if (content.includes('[[ACTION:POKE]]')) {
            await replyStep(async () => persist({ charId, role: 'assistant', type: 'interaction', content: '[戳一戳]' }));
            content = content.replace('[[ACTION:POKE]]', '').trim();
        }

        // TRANSFER_ACCEPT / TRANSFER_RETURN — char 收下 / 退回 user 最近一笔待处理的转账。
        // 找最近一条 user 发出、还没被收/退、且不是回执卡本身的转账，标记状态并补一张回执小卡。
        //
        // 找不到待处理转账时**不落回执**：老实现会照样落一张，渲染成「xx已收款」
        // (MessageItem.tsx TransferCard)，等于角色能凭空声明自己收了一笔用户从没发过的钱。
        // 老注释写的「至少 user 能看到反馈」意图是防静默失败，但代价是假账——角色那句话
        // 照常显示，用户看到的最多是句废话，比看到一笔不存在的收款好。
        const resolveUserTransfer = async (action: 'accepted' | 'returned') => {
            let amount: string | number | undefined;
            let refId: number | undefined;
            try {
                const all = await replyStep(async () => DB.getMessagesByCharId(charId, true));
                const pendings = all.filter(
                    x => x.type === 'transfer' && x.role === 'user' && !x.metadata?.receipt
                        && (!x.metadata?.status || x.metadata.status === 'pending'),
                );
                // 角色收的是**它说这句话那一刻**看得到的那笔。主动消息补收会把「生成」和「重放」
                // 拉开几小时：用户早上又转了 1000，按「最新一笔待收」结算就会让角色半夜那句
                // 「这五块我收下啦」把早上那 1000 给收了。所以先在原始发送时刻之前的待收里取最新，
                // 一笔都没有再退回老行为（并留一行日志说明这次是按最新一笔结的）。
                let pending = messageTimestamp != null
                    ? [...pendings].reverse().find(x => (x.timestamp ?? 0) <= messageTimestamp)
                    : undefined;
                if (!pending) {
                    if (messageTimestamp != null && pendings.length > 0) {
                        console.warn(
                            '[Transfer] 这条消息发出时并没有待收的转账，退回按最新一笔结算:',
                            { charId, messageTimestamp, pendingCount: pendings.length },
                        );
                    }
                    pending = pendings[pendings.length - 1];
                }
                if (pending) {
                    amount = pending.metadata?.amount;
                    refId = pending.id;
                    await replyStep(async () => DB.updateMessageMetadata(pending.id, (prev) => ({ ...(prev || {}), status: action, resolvedAt: Date.now() })));
                }
            } catch (e) {
                replyRun?.check();
                console.warn('[Transfer] 查待处理转账失败，跳过回执:', e);
                return;
            }
            if (refId === undefined) {
                console.warn(`[Transfer] 角色想${action === 'accepted' ? '收下' : '退回'}转账，但没有待处理的用户转账，已忽略`);
                return;
            }
            await replyStep(async () => persist({
                charId, role: 'assistant', type: 'transfer',
                content: action === 'accepted' ? '[已收款]' : '[已退回]',
                metadata: { receipt: action, amount, ref: refId },
            }));
        };

        // TRANSFER — 规范标签 + 模仿历史日志的口语形态一起解析，见 utils/transferFormat.ts。
        // 按出现顺序执行，保住角色「先转账再说谢谢」这类语序意图。
        const { text: transferCleanedText, events: transferEvents, consumed: transferConsumed } = extractTransferCommands(content);
        if (transferConsumed > 0) content = transferCleanedText;
        for (const ev of transferEvents) {
            if (ev.kind === 'send') {
                // role 固定 'assistant' —— 方向不由文本决定，文本里的方向信息只在
                // transferFormat 里做过校验（伪造的已被丢弃）。
                await replyStep(async () => persist({ charId, role: 'assistant', type: 'transfer', content: '[转账]', metadata: { amount: ev.amount, status: 'pending' } }));
            } else {
                await replyStep(async () => resolveUserTransfer(ev.kind === 'accept' ? 'accepted' : 'returned'));
            }
        }

        // MUSIC_ACTION — char 对 user 正在听的歌表态（只处理第一次出现，每条消息最多一次插卡）
        // 支持的格式（后两种是为了让 char 自己挑歌单 / 新建歌单）：
        //   [[MUSIC_ACTION:join]]
        //   [[MUSIC_ACTION:add]]                              → 默认放第一个歌单
        //   [[MUSIC_ACTION:add|歌单标题]]                      → 放进现有歌单（标题匹配）
        //   [[MUSIC_ACTION:add_new|新歌单标题|可选描述]]        → 新建歌单
        //   [[MUSIC_ACTION:join_and_add(|...)]]              → 同 add 一套
        //   [[MUSIC_ACTION:join_and_add_new|新歌单标题|描述]]  → 同 add_new
        // 用 | 分隔参数，避免和 : 冲突（标题里很容易出现 :)
        const MUSIC_TAG_RE = /\[\[MUSIC_ACTION:(join|add|add_new|join_and_add|join_and_add_new)(?:\|([^\]]*))?\]\]/;
        const MUSIC_TAG_GLOBAL_RE = /\[\[MUSIC_ACTION:(?:join|add|add_new|join_and_add|join_and_add_new)(?:\|[^\]]*)?\]\]/g;
        const musicMatch = content.match(MUSIC_TAG_RE);
        if (musicMatch && musicHooks) {
            const verb = musicMatch[1] as 'join' | 'add' | 'add_new' | 'join_and_add' | 'join_and_add_new';
            const argsRaw = (musicMatch[2] || '').trim();
            const args = argsRaw ? argsRaw.split('|').map(s => s.trim()).filter(Boolean) : [];
            // 卡片元数据里只用 join / add / join_and_add 三种意图，把 _new 折叠回 add 系
            const intent: 'join' | 'add' | 'join_and_add' =
                verb === 'join' ? 'join'
                : (verb === 'add' || verb === 'add_new') ? 'add'
                : 'join_and_add';
            const wantsJoin = verb === 'join' || verb === 'join_and_add' || verb === 'join_and_add_new';
            const wantsAdd = verb !== 'join';

            let target: AddSongTarget | undefined;
            if (wantsAdd) {
                if (verb === 'add_new' || verb === 'join_and_add_new') {
                    // 至少要有标题；没标题就退化成默认 add
                    if (args[0]) target = { kind: 'new', title: args[0], description: args[1] };
                } else if (args[0]) {
                    target = { kind: 'existing', title: args[0] };
                }
            }

            // 先认「角色写这句话时读到的那首」（定时消息由 worker 冻进 directive、调用方传进来），
            // 没有这一份才退回「用户此刻在听的那首」——本地聊天走的一直是后者。
            const frozen = normalizeFrozenSong(frozenMusicSong);
            const snap = frozen
                ? await replyStep(async () => resolveFrozenSongSnapshot(charId, frozen))
                : musicHooks.getListeningSnapshot();
            if (snap) {
                let addedToPlaylistTitle: string | undefined;
                let playlistCreated = false;
                if (wantsJoin) {
                    musicHooks.joinListeningTogether(charId);
                }
                if (wantsAdd) {
                    try {
                        const playlistSong: CharPlaylistSong = {
                            id: snap.songId,
                            name: snap.name,
                            artists: snap.artists,
                            album: snap.album,
                            albumPic: snap.albumPic,
                            duration: snap.duration,
                            fee: snap.fee,
                            // 'user' 的意思是「这首是从用户那儿听来的」，之后的提示词会照着说
                            // （见 ContextBuilder 那段「从对方那儿收进来的歌」）。冻结的那首是
                            // 角色自己在听的，标成 'user' 等于让它以后认错来路。
                            source: frozen ? 'discovered' : 'user',
                            addedAt: Date.now(),
                        };
                        const added = await replyStep(async () => musicHooks.addSongToCharPlaylist(charId, playlistSong, target));
                        if (added) {
                            addedToPlaylistTitle = added.playlistTitle;
                            playlistCreated = added.created;
                        }
                    } catch { replyRun?.check(); /* 忽略 */ }

                }
                await replyStep(async () => persist({
                    charId,
                    role: 'assistant',
                    type: 'music_card',
                    content: '[音乐卡片]',
                    metadata: {
                        intent,
                        song: snap,
                        addedToPlaylistTitle,
                        playlistCreated,
                    },
                }));
                const playlistSuffix = addedToPlaylistTitle
                    ? (playlistCreated ? `（新建《${addedToPlaylistTitle}》）` : `《${addedToPlaylistTitle}》`)
                    : '';
                addToast(
                    intent === 'join' ? `${charName} 和你一起听` :
                    intent === 'add' ? `${charName} 把这首加到了${playlistSuffix || '自己歌单'}` :
                    `${charName} 和你一起听，也加到了${playlistSuffix || '歌单'}`,
                    'info'
                );
            } else {
                // 两头都空：推送里没冻歌（比如那一刻角色的日程不在听歌的时段，或者是本地
                // 聊天路径），用户此刻也没在放歌。剩下的选择只有跳过 —— 但静默跳过的结果是
                // 「正文在聊这首歌，卡片和歌单动作却整个没发生」，排查时一点线索都没有，
                // 所以至少留一行。
                console.warn(
                    '[MusicAction] 既没有冻结的歌、也取不到"正在听"快照，这条音乐动作跳过:',
                    { charId, verb, args, messageTimestamp },
                );
            }
            content = content.replace(musicMatch[0], '').trim();
            // 同类 tag 全清，防止 LLM 一条消息里插多次
            content = content.replace(MUSIC_TAG_GLOBAL_RE, '').trim();
        } else if (musicMatch) {
            // 没有 hooks（无音乐上下文）— 静默丢弃
            content = content.replace(MUSIC_TAG_GLOBAL_RE, '').trim();
        }

        // NEWS_CARD — char 主动把某条热点当作新闻卡片分享（来源 + 标题）
        //   [[NEWS_CARD: 来源|标题]]    （来源可省略 → [[NEWS_CARD: 标题]]）
        const NEWS_CARD_RE = /\[\[NEWS_CARD:\s*([^\]]*?)\s*\]\]/;
        const NEWS_CARD_GLOBAL_RE = /\[\[NEWS_CARD:[^\]]*\]\]/g;
        const newsCardMatch = content.match(NEWS_CARD_RE);
        if (newsCardMatch) {
            const raw = (newsCardMatch[1] || '').trim();
            if (raw) {
                const segs = raw.split('|').map(s => s.trim());
                let source = '';
                let title = raw;
                if (segs.length >= 2) {
                    source = segs[0];
                    title = segs.slice(1).join('|').trim();
                }
                // char 不知道链接，尝试从最近一次热点快照里按标题补 url / 来源 / 简介
                let url: string | undefined;
                let desc: string | undefined;
                try {
                    const snap = await replyStep(async () => DB.getLatestHotNewsSnapshot());
                    const items = snap?.items || [];
                    // 先精确匹配。模糊匹配只在**唯一命中**时才用：本地这份快照和角色当时看到的
                    // 那份常常不是同一刻，热搜里相似标题成堆（同一件事好几条），挑错一条就是卡片
                    // 标题说 A、点进去是 B。宁可不挂链接——无链接的卡片本来就是既有形态。
                    let hit = items.find(it => it.title === title);
                    if (!hit && title) {
                        const fuzzy = items.filter(it => it.title.includes(title) || title.includes(it.title));
                        if (fuzzy.length === 1) {
                            hit = fuzzy[0];
                        } else if (fuzzy.length > 1) {
                            console.warn(
                                '[NewsCard] 本地热搜里有多条标题对得上，这张卡不挂链接:',
                                { title, matched: fuzzy.map(it => it.title) },
                            );
                        }
                    }
                    if (hit) {
                        url = hit.url;
                        desc = hit.desc;
                        if (!source && hit.source) source = hit.source;
                    }
                } catch { replyRun?.check(); /* 补不到就算了 */ }

                if (title) {
                    await replyStep(async () => persist({
                        charId,
                        role: 'assistant',
                        type: 'news_card',
                        content: `[你分享了一个热点：「${title}」${source ? `（来源：${source}）` : ''}${desc ? `——${desc}` : ''}]`,
                        metadata: { source, title, url, desc },
                    }));
                    addToast(`${charName} 分享了一条热点`, 'info');
                }
            }
            content = content.replace(NEWS_CARD_GLOBAL_RE, '').trim();
        }

        // ADD_EVENT
        const eventMatch = content.match(/\[\[ACTION:ADD_EVENT\s*\|\s*(.*?)\s*\|\s*(.*?)\]\]/);
        if (eventMatch) {
            const title = eventMatch[1].trim();
            const date = eventMatch[2].trim();
            if (title && date) {
                const anni: any = { id: `anni-${Date.now()}`, title: title, date: date, charId };
                await replyStep(async () => DB.saveAnniversary(anni));
                addToast(`${charName} 添加了新日程: ${title}`, 'success');
                await replyStep(async () => persist({ charId, role: 'system', type: 'text', content: `[系统: ${charName} 新增了日程 "${title}" (${date})]` }));
            }
            content = content.replace(eventMatch[0], '').trim();
        }

        // SCHEDULE
        const scheduleRegex = /\[schedule_message \| (.*?) \| fixed \| (.*?)\]/g;
        let match;
        while ((match = scheduleRegex.exec(content)) !== null) {
            const timeStr = match[1].trim();
            const msgContent = match[2].trim();
            // 角色照着自己那边的钟写时间，按设备时区解释会整体偏一个时差：
            // 纽约角色在自己上午说「今晚 21:00 找你」，设备在中国就会算成已经过期。
            const dueTime = wallClockToTimestamp(timeStr, charTz);
            // 时间写歪 / 已经过去的一律不排。这两种情况下角色在正文里往往已经把话说出去了
            // （「我到点叫你」），排不上就是一句空头承诺，所以留一行日志说清是哪条、为什么，
            // 别让它悄无声息地消失。离线补收时尤其常见：消息是凌晨发的，人第二天早上才打开。
            if (isNaN(dueTime)) {
                console.warn('[ScheduledMessage] 时间解析不了，这条不排:', timeStr, '内容:', msgContent);
                continue;
            }
            if (dueTime <= Date.now()) {
                console.warn(
                    '[ScheduledMessage] 时间已经过去，这条不排:', timeStr,
                    `(角色时区 ${charTz ?? '设备默认'}，晚了 ${Math.round((Date.now() - dueTime) / 60000)} 分钟)`,
                    '内容:', msgContent,
                );
                continue;
            }
            await replyStep(async () => DB.saveScheduledMessage({ id: `sched-${Date.now()}-${Math.random()}`, charId, content: msgContent, dueAt: dueTime, createdAt: Date.now() }));
            try {
                const hasPerm = await replyStep(async () => LocalNotifications.checkPermissions());
                if (hasPerm.display === 'granted') {
                    await replyStep(async () => LocalNotifications.schedule({ notifications: [{ title: charName, body: msgContent, id: Math.floor(Math.random() * 100000), schedule: { at: new Date(dueTime) }, smallIcon: 'ic_stat_icon_config_sample' }] }));
                }
            } catch (e) { replyRun?.check(); console.log("Notification schedule skipped (web mode)"); }

            addToast(`${charName} 似乎打算一会儿找你...`, 'info');
        }
        content = content.replace(scheduleRegex, '').trim();

        // LIFE — 生活记录代记（生理期/药盒/记账/锻炼）。开关校验、去重、写库、落 life_card
        // 都在 lifeRecords.ts 里；这里只负责取角色档案。取不到就只剥 tag（静默丢弃）。
        if (content.includes('[[LIFE:')) {
            try {
                const chars = await replyStep(async () => DB.getAllCharacters());
                const charProfile = chars.find(c => c.id === charId);
                content = charProfile
                    ? await replyStep(async () => executeLifeDirectives(content, charProfile, addToast, messageTimestamp, inheritMeta, replyRun))
                    : content.replace(/\[\[LIFE:[^\]]*\]\]/g, '').trim();
            } catch (e) {
                replyRun?.check();
                console.error('[LifeRecord] parse failed:', e);
                content = content.replace(/\[\[LIFE:[^\]]*\]\]/g, '').trim();
            }
        }

        // RECALL tag removal (handling done in main loop logic, but cleaning here just in case)
        content = content.replace(/\[\[RECALL:.*?\]\]/g, '').trim();

        return content;
    },

    /**
     * Comprehensive sanitizer for AI output before saving to DB.
     * Removes AI-specific artifacts that should never appear in chat bubbles.
     * Safe to call multiple times (idempotent). Preserves %%BILINGUAL%% markers.
     * Pass { keepCitations: true } to preserve [QUOTE:..]/[引用:..]/[回复 ".."] tags
     * (used when downstream chunking needs to detect per-bubble citation targets).
     */
    sanitize: (text: string, options?: { keepCitations?: boolean }): string => sanitizeForBubble(text, options),

    /**
     * Check if text has meaningful display content after stripping all markers/junk.
     * Used to decide whether a chunk is worth saving as a message.
     */
    hasDisplayContent: (text: string): boolean => {
        const stripped = text
            .replace(/%%BILINGUAL%%/gi, '')
            .replace(/%%TRANS%%[\s\S]*/gi, '')
            // 容错版 (对齐 MessageItem stripJunk): 截断/全角/简繁的破翻译标签也不算显示内容
            .replace(/[<＜]\s*[/／]?\s*(?:翻[译譯]|原文|[译譯]文)\s*[>＞]?/g, '')
            .replace(/^\s*---\s*$/gm, '')
            .replace(/``+/g, '')
            .replace(/(^|\s)`(\s|$)/gm, '$1$2')
            .replace(/\[\[[\s\S]*?\]\]/g, '')
            .replace(/\[(?:QU[OA]TE|引用)[：:][^\]]*\]/g, '')
            .replace(/\[[^\[\]\n「」]{0,24}引用了[^\[\]\n「」]{0,24}「[^」\n]*?」[^\[\]\n]{0,24}\]\s*/g, '')
            .replace(/\[回复\s*[""\u201C][^""\u201D]*?[""\u201D](?:\.{0,3})\]\s*[：:]?\s*/g, '')
            .replace(/^#{1,6}\s+/gm, '')
            .replace(/^\s*[-*+]\s*$/gm, '')
            .trim();
        return stripped.length > 0;
    },

    // Split text into bubbles (text and emojis)
    splitResponse: (content: string): { type: 'text' | 'emoji', content: string }[] => {
        const emojiPattern = /\[\[SEND_EMOJI:\s*(.*?)\]\]/g;
        const parts: {type: 'text' | 'emoji', content: string}[] = [];
        let lastIndex = 0;
        let emojiMatch;

        while ((emojiMatch = emojiPattern.exec(content)) !== null) {
            if (emojiMatch.index > lastIndex) {
                const textBefore = content.slice(lastIndex, emojiMatch.index).trim();
                if (textBefore) parts.push({ type: 'text', content: textBefore });
            }
            parts.push({ type: 'emoji', content: emojiMatch[1].trim() });
            lastIndex = emojiMatch.index + emojiMatch[0].length;
        }

        if (lastIndex < content.length) {
            const remaining = content.slice(lastIndex).trim();
            if (remaining) parts.push({ type: 'text', content: remaining });
        }

        if (parts.length === 0 && content.trim()) parts.push({ type: 'text', content: content.trim() });
        return parts;
    },

    // Chunking text for typing effect - splits into separate chat bubbles.
    // Only explicit line breaks are bubble boundaries. Ordinary whitespace must stay in the
    // same bubble: models often put spaces inside Japanese/Chinese mixed-language prose, and
    // treating those spaces as implicit newlines cuts a single sentence in half.
    chunkText: (text: string): string[] => {
        // 0. 保护 <语音…>…</语音> 原子块。外语语音字幕对齐模式下 (见 chatPrompts
        //    voiceActingGuide) 标签内部常按空行分成好几段，一旦被下面的换行断句切碎，
        //    <语音> 的开 / 闭标签就会散落到不同气泡里；MessageItem 的 hasVoiceTag 要求
        //    开闭成对，配不上就当纯文字漏出原始标签，语音条和翻译也全不渲染 (掉格式)。
        //    跟 worker 端 sanitize.ts 的 Phase 1.5 一样把整块换成独占一行的占位符，
        //    切分后再原样还原成一个 chunk。
        const ATOM = String.fromCharCode(2);
        const voiceBlocks: string[] = [];
        // 语音块 + 紧邻 <字幕> 块是一个原子单元 (字幕是该语音的中文对照, 拆开就配不上)。
        // 闭合标签容许空格 / 简繁互换 (normalizeVoiceTags 在 sanitize 阶段已修, 这里是保险)
        const guardedText = text.replace(/(?:<字幕>[\s\S]*?<\/字幕>\s*)?<[语語]音[^>]*>[\s\S]*?<\/\s*[语語]音\s*>(?:\s*<字幕>[\s\S]*?<\/字幕>)?/g, m => {
            const idx = voiceBlocks.length;
            voiceBlocks.push(m);
            return `\n${ATOM}${idx}${ATOM}\n`;
        });

        // 1. Split on line breaks (AI decides where to break)
        const lineChunks = guardedText.split(/(?:\r\n|\r|\n|\u2028|\u2029)+/)
            .map(c => c.trim())
            .filter(c => c.length > 0);

        const ATOM_GLOBAL = new RegExp(`${ATOM}(\\d+)${ATOM}`, 'g');
        const restoreVoice = (s: string) => s.replace(ATOM_GLOBAL, (_m, n) => voiceBlocks[Number(n)] ?? '');
        return lineChunks
            .map(restoreVoice)
            .filter(c => c.length > 0);
    }
}
