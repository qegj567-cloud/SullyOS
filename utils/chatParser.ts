
import { DB } from './db';
import { LocalNotifications } from '@capacitor/local-notifications';
import { CharacterProfile, CharPlaylistSong } from '../types';

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

export const ChatParser = {
    // Return cleaned content and perform side effects
    parseAndExecuteActions: async (
        aiContent: string,
        charId: string,
        charName: string,
        addToast: (msg: string, type: 'info'|'success'|'error') => void,
        musicHooks?: MusicActionHooks,
    ) => {
        let content = aiContent;

        // POKE
        if (content.includes('[[ACTION:POKE]]')) {
            await DB.saveMessage({ charId, role: 'assistant', type: 'interaction', content: '[戳一戳]' });
            content = content.replace('[[ACTION:POKE]]', '').trim();
        }

        // TRANSFER
        const transferMatch = content.match(/\[\[ACTION:TRANSFER:(\d+)\]\]/);
        if (transferMatch) {
            await DB.saveMessage({ charId, role: 'assistant', type: 'transfer', content: '[转账]', metadata: { amount: transferMatch[1] } });
            content = content.replace(transferMatch[0], '').trim();
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

            const snap = musicHooks.getListeningSnapshot();
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
                            source: 'user',
                            addedAt: Date.now(),
                        };
                        const added = await musicHooks.addSongToCharPlaylist(charId, playlistSong, target);
                        if (added) {
                            addedToPlaylistTitle = added.playlistTitle;
                            playlistCreated = added.created;
                        }
                    } catch { /* 忽略 */ }
                }
                await DB.saveMessage({
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
                });
                const playlistSuffix = addedToPlaylistTitle
                    ? (playlistCreated ? `（新建《${addedToPlaylistTitle}》）` : `《${addedToPlaylistTitle}》`)
                    : '';
                addToast(
                    intent === 'join' ? `${charName} 和你一起听` :
                    intent === 'add' ? `${charName} 把这首加到了${playlistSuffix || '自己歌单'}` :
                    `${charName} 和你一起听，也加到了${playlistSuffix || '歌单'}`,
                    'info'
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
                    const snap = await DB.getLatestHotNewsSnapshot();
                    const hit = snap?.items?.find(it => it.title === title)
                        || snap?.items?.find(it => !!title && (it.title.includes(title) || title.includes(it.title)));
                    if (hit) {
                        url = hit.url;
                        desc = hit.desc;
                        if (!source && hit.source) source = hit.source;
                    }
                } catch { /* 补不到就算了 */ }
                if (title) {
                    await DB.saveMessage({
                        charId,
                        role: 'assistant',
                        type: 'news_card',
                        content: `[你分享了一个热点：「${title}」${source ? `（来源：${source}）` : ''}${desc ? `——${desc}` : ''}]`,
                        metadata: { source, title, url, desc },
                    });
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
                await DB.saveAnniversary(anni);
                addToast(`${charName} 添加了新日程: ${title}`, 'success');
                await DB.saveMessage({ charId, role: 'system', type: 'text', content: `[系统: ${charName} 新增了日程 "${title}" (${date})]` });
            }
            content = content.replace(eventMatch[0], '').trim();
        }

        // SCHEDULE
        const scheduleRegex = /\[schedule_message \| (.*?) \| fixed \| (.*?)\]/g;
        let match;
        while ((match = scheduleRegex.exec(content)) !== null) {
            const timeStr = match[1].trim();
            const msgContent = match[2].trim();
            const dueTime = new Date(timeStr).getTime();
            if (!isNaN(dueTime) && dueTime > Date.now()) {
                await DB.saveScheduledMessage({ id: `sched-${Date.now()}-${Math.random()}`, charId, content: msgContent, dueAt: dueTime, createdAt: Date.now() });
                try {
                    const hasPerm = await LocalNotifications.checkPermissions();
                    if (hasPerm.display === 'granted') {
                        await LocalNotifications.schedule({ notifications: [{ title: charName, body: msgContent, id: Math.floor(Math.random() * 100000), schedule: { at: new Date(dueTime) }, smallIcon: 'ic_stat_icon_config_sample' }] });
                    }
                } catch (e) { console.log("Notification schedule skipped (web mode)"); }
                addToast(`${charName} 似乎打算一会儿找你...`, 'info');
            }
        }
        content = content.replace(scheduleRegex, '').trim();

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
    sanitize: (text: string, options?: { keepCitations?: boolean }): string => {
        let result = text
            // Convert literal \n (backslash + n) the AI sometimes outputs into real newlines
            .replace(/\\n/g, '\n')
            // Strip source tags [聊天]/[通话]/[约会] leaked from history context → newline to preserve splits
            .replace(/\s*\[(?:聊天|通话|约会)\]\s*/g, '\n')
            // Strip leaked timestamps from chat history context:
            // [2026-02-11 13:52] format (bracketed, from history entries)
            .replace(/\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/g, '')
            // 2026-02-11 13:52 format (unbracketed, at line start)
            .replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s*/gm, '')
            // （下午1:52）or（上午10:30）Chinese 12h parenthetical
            .replace(/（[上下]午\d{1,2}[：:]\d{2}）/g, '')
            // (1:52 PM) or (10:30 AM) English 12h parenthetical
            .replace(/\(\d{1,2}:\d{2}\s*[AP]M\)/gi, '')
            // Strip markdown headers (# ## ### etc) → keep the text
            .replace(/^#{1,6}\s+/gm, '')
            // Strip residual action/system tags that weren't caught earlier
            .replace(/\[\[(?:ACTION|RECALL|SEARCH|DIARY|READ_DIARY|FS_DIARY|FS_READ_DIARY|DIARY_START|DIARY_END|FS_DIARY_START|FS_DIARY_END|MUSIC_ACTION)[:\s][\s\S]*?\]\]/g, '')
            .replace(/\[schedule_message[^\]]*\]/g, '');
        if (!options?.keepCitations) {
            result = result
                .replace(/\[\[(?:QU[OA]TE|引用)[：:][\s\S]*?\]\]/g, '')
                .replace(/\[(?:QU[OA]TE|引用)[：:][^\]]*\]/g, '')
                // [回复 "content"]: format (AI mimics history context format)
                .replace(/\[回复\s*[""\u201C][^""\u201D]*?[""\u201D](?:\.{0,3})\]\s*[：:]?\s*/g, '');
        }
        return result
            // Strip backtick-wrapped action tags and empty backtick pairs
            .replace(/`(\[\[[\s\S]*?\]\])`/g, '$1')
            .replace(/``+/g, '')
            .replace(/(^|\s)`(\s|$)/gm, '$1$2')
            // Strip markdown links → keep text only: [text](url) → text
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            // Strip all ** sequences (orphaned bold markers are common AI artifacts;
            // in chat context, losing bold formatting is acceptable for clean display)
            .replace(/\*{2,}/g, '')
            // Strip standalone separators and bullets
            .replace(/^\s*---\s*$/gm, '')
            .replace(/^\s*[-*+]\s*$/gm, '')
            // Strip legacy translation marker (but keep %%BILINGUAL%% and <翻译> XML tags)
            .replace(/%%TRANS%%[\s\S]*/gi, '')
            // Collapse excessive whitespace
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    },

    /**
     * Check if text has meaningful display content after stripping all markers/junk.
     * Used to decide whether a chunk is worth saving as a message.
     */
    hasDisplayContent: (text: string): boolean => {
        const stripped = text
            .replace(/%%BILINGUAL%%/gi, '')
            .replace(/%%TRANS%%[\s\S]*/gi, '')
            .replace(/<\/?翻译>|<\/?原文>|<\/?译文>/g, '')
            .replace(/^\s*---\s*$/gm, '')
            .replace(/``+/g, '')
            .replace(/(^|\s)`(\s|$)/gm, '$1$2')
            .replace(/\[\[[\s\S]*?\]\]/g, '')
            .replace(/\[(?:QU[OA]TE|引用)[：:][^\]]*\]/g, '')
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

    // Chunking text for typing effect - splits into separate chat bubbles
    // Primary: split on line breaks (AI decides where to break)
    // Fallback: if no line breaks and text is long, split on spaces between CJK characters
    //   (Chinese text normally has no spaces, so "汉字 汉字" means the AI intended a line break)
    chunkText: (text: string): string[] => {
        // CJK character + punctuation ranges (Chinese text normally has no spaces between these)
        const CJK = '\\u4e00-\\u9fff\\u3400-\\u4dbf\\u3000-\\u303f\\uff00-\\uffef\\u2000-\\u206f\\u2e80-\\u2eff\\u3001-\\u3003\\u2018-\\u201f\\u300a-\\u300f\\uff01-\\uff0f\\uff1a-\\uff20';
        const cjkSpaceRe = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`);

        // 1. Split on line breaks (AI decides where to break)
        const lineChunks = text.split(/(?:\r\n|\r|\n|\u2028|\u2029)+/)
            .map(c => c.trim())
            .filter(c => c.length > 0);

        // 2. For each chunk, also split on spaces between CJK chars/punctuation
        //    (中文里不该有空格, so "汉字 汉字" means the AI intended a bubble break)
        const result: string[] = [];
        for (const chunk of lineChunks) {
            const sub = chunk.split(cjkSpaceRe)
                .map(c => c.trim())
                .filter(c => c.length > 0);
            result.push(...sub);
        }

        return result;
    }
}
