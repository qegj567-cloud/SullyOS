/**
 * applyAssistantPostProcessing — 抽自 hooks/useChatAI.ts 的 sendMessage 后处理管线
 *
 * Phase 0 重构目标: 把"API 拿到原始 aiContent → 13 步处理 → 逐条落库到 IndexedDB"
 * 这段约 1500 行的流水线抽成可复用函数, 让本地 fetch 和 instant push (Phase 1) 两条
 * 路径都调它, 保证行为字节级一致。
 *
 * 13 步 (与计划编号对应):
 *  1. normalizeAiContent — 剥 <think>/时间戳/[聊天][通话][约会] 等
 *  2. 二轮 LLM 钩子 — RECALL / SEARCH / DIARY / READ_DIARY / FS_* / READ_NOTE / XHS_*
 *  3. ChatParser.parseAndExecuteActions — POKE/TRANSFER/MUSIC/ADD_EVENT/schedule
 *  4. thinking chain 抽取 (reasoning_content + <think>)
 *  5. [html]...[/html] → html_card 消息
 *  6. ChatParser.sanitize(text, {keepCitations:true})
 *  7. [[INNER_STATE:...]] 兜底剥
 *  8. 双语 <翻译><原文>...<译文>... 拆为单独 bubble
 *  9. ChatParser.splitResponse — 拆 [[SEND_EMOJI:]]
 * 10. --- 分块 + ChatParser.chunkText (只按显式换行)
 * 11. per-chunk 引用解析 ([[QUOTE:]]/[QUOTE:]/[回复 "..."]) → replyTo
 * 12. hasDisplayContent + per-chunk sanitize
 * 13. 拟人打字延迟 (setTimeout)
 *
 * Phase 0 保证: 本地 fetch 路径 directives=[] / skipSecondPassLLM=false 行为字节级不变。
 * Phase 1 会让 instant push 路径 directives=[] / skipSecondPassLLM=true (worker 已跑过).
 * Phase 2 会让 worker 端把识别出的副作用 (RECALL/SEARCH/...) 结构化传 directives, 这里只重放。
 */

import { CharacterProfile, UserProfile, Message, Emoji, EmojiCategory, RealtimeConfig, GroupProfile } from '../types';
import { DB } from './db';
import { ChatParser, type FrozenMusicSong } from './chatParser';
import { resolveCharTimeZone } from './timezone';
import { NotionManager, FeishuManager, XhsNote } from './realtimeContext';
import { enqueuePendingDiary, removePendingDiary } from './pendingDiary';
import { parseXhsCount, XhsMcpClient } from './xhsMcpClient';
import { extractPublishedNoteId, ownedPostToNote } from './xhsFreeRoamOwnership';
import { selectOwnedPostsForReference } from './xhsOwnedPostReference';
import { safeFetchJson } from './safeApi';
import { extractHtmlBlocks } from './htmlPrompt';
import {
    AgenticToolCtx,
    resolveXhsConfig,
    runRecall,
    runSearch,
    runReadDiary,
    runFsReadDiary,
    runReadNote,
    runXhsSearch,
    runXhsBrowse,
    runXhsMyProfile,
    runXhsDetail,
} from './agenticTools';
import { getLocalDateKey } from './localDate';
import { normalizeAssistantActionFormatting } from './assistantActionFormat';
import { markAmsgStateDirty } from './amsgStateSync';
import { announceScheduleChanges, applyAssistantScheduleChanges } from './scheduleChange';
import { isBlobRef } from './blobRef';
import { consumeSARChatSurfaceChunk, type SARModuleSurfaceMeta } from './vrWorld/sarModuleRuntime';

// ─── 模块内辅助 ──────────────────────────────────────────────────────────────

/**
 * 引用回复的内容快照 —— 写进 `replyTo.content`，界面上就是引用气泡里那一小行。
 *
 * 被引用的那条是图片 / 表情时给占位符，不能截原值：图片存的是 `blobref:<id>` 令牌，
 * 截前 10 个字刚好是 `blobref:b_`。messages 表是 Blob 孤儿清理的引用面（utils/blobGc.ts
 * 把每条消息 JSON.stringify 后交给 SDK 扫），SDK 从这半截前缀提取出来的 id 是它生成的
 * 每一个 id 的公共前缀，于是判定「引用面像是被截断过，不安全」→ 整库豁免，一个 Blob 都不删，
 * 而且不报任何错（唯一能察觉的信号是 runGc 返回值里的 keptBoundary）。
 */
export function buildReplySnapshotContent(msg: { type?: string; content: string }): string {
    const content = msg.content || '';
    const trimmed = content.trim();
    // 值形态判断跟 chatPrompts 的 isMediaValue 同义：data: / http(s) / blobref 令牌都是"一张图"
    const looksLikeMedia = /^(data:|https?:\/\/)/i.test(trimmed) || isBlobRef(trimmed);
    if (msg.type === 'emoji') return '[表情包]';
    if (msg.type === 'image' || looksLikeMedia) return '[图片]';
    return content.length > 10 ? content.slice(0, 10) + '...' : content;
}

/** 第一遍粗洗 — 剥 <think> / 时间戳 / 历史里漏出的 [聊天]/[通话]/[约会] / 表情包反向 tag */
const normalizeAiContent = (raw: string): string => {
    let cleaned = normalizeAssistantActionFormatting(raw || '');
    // Strip hidden chain-of-thought blocks: <think> / <thinking> / <thought>
    cleaned = cleaned.replace(/<(think|thinking|thought)>[\s\S]*?<\/\1>/gi, '');
    cleaned = cleaned.replace(/<(?:think|thinking|thought)>[\s\S]*$/gi, '');
    cleaned = cleaned.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');
    cleaned = cleaned.replace(/^[\w一-龥]+:\s*/, '');
    // Strip source tags [聊天]/[通话]/[约会] leaked from history context — replace with newline to preserve intended splits
    cleaned = cleaned.replace(/\s*\[(?:聊天|通话|约会)\]\s*/g, '\n');
    cleaned = cleaned.replace(/\[(?:你|User|用户|System)\s*发送了表情包[:：]\s*(.*?)\]/g, '[[SEND_EMOJI: $1]]');
    return cleaned;
};

/**
 * 把 SAR 的 CHAR_SURFACE 按“最终会落库的 Chat 气泡”拆开。
 *
 * 这里不能只按换行切：内置翻译模式的一组 <原文>/<译文> 最终会合并成一条
 * `原文\n%%BILINGUAL%%\n译文` 消息；语音块 + 字幕也必须保持一个原子气泡。
 * 这份拆法刻意和 renderAndPersist 保持一致，surface 才不会在特殊模式里串到下一泡。
 */
export const splitSARChatSurfaceBubbles = (raw: string): string[] => {
    let content = ChatParser.sanitize(raw || '', { keepCitations: true });
    content = content.replace(/\[\[INNER_STATE:\s*[\s\S]*?\]\]/g, '').trim();
    if (!content) return [];

    const chunks: string[] = [];
    const appendPlain = (segment: string) => {
        for (const part of ChatParser.splitResponse(segment)) {
            if (part.type !== 'text') continue;
            const rawBlocks = part.content.split(/^\s*---\s*$/m).filter(block => block.trim());
            const blocks = rawBlocks.length > 0 ? rawBlocks : [part.content];
            for (const block of blocks) {
                for (const chunk of ChatParser.chunkText(block.trim())) {
                    const clean = ChatParser.sanitize(chunk);
                    if (clean && ChatParser.hasDisplayContent(clean)) chunks.push(clean);
                }
            }
        }
    };

    const tagPattern = /<翻译>\s*<原文>([\s\S]*?)<\/原文>\s*<译文>([\s\S]*?)<\/译文>\s*<\/翻译>/g;
    if (!tagPattern.test(content)) {
        appendPlain(content);
        return chunks;
    }

    tagPattern.lastIndex = 0;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(content)) !== null) {
        const textBefore = content.slice(lastIndex, match.index).trim();
        if (textBefore) appendPlain(textBefore);

        // 表情是独立消息，不参与文字 surface 的序号；与真正落库分支保持一致。
        const stripEmoji = (value: string) => value.replace(/\[\[SEND_EMOJI:\s*.*?\]\]/g, '').trim();
        const original = ChatParser.sanitize(stripEmoji(match[1]));
        const translated = ChatParser.sanitize(stripEmoji(match[2]));
        if (original || translated) {
            chunks.push(original && translated
                ? `${original}\n%%BILINGUAL%%\n${translated}`
                : (original || translated));
        }
        lastIndex = match.index + match[0].length;
    }

    const textAfter = content.slice(lastIndex).trim();
    if (textAfter) appendPlain(textAfter.replace(/<\/?翻译>|<\/?原文>|<\/?译文>/g, '').trim());
    return chunks;
};

/**
 * 模型偶尔会把按分类展示的清单 `呆猫: [亲亲额头]` 抄成
 * `[[SEND_EMOJI: 呆猫: 亲亲额头]]`。先保留既有的纯名称精确匹配；只有失败后，
 * 才把前缀当作“当前角色可见分类名”解析，并且仅在候选唯一时接受。
 * 这样不会误伤本来就含冒号的表情名，也不会在同名分类/同名表情间猜 URL。
 */
const resolveEmojiForSend = (
    rawName: string,
    emojis: Emoji[],
    categories: EmojiCategory[] = [],
): Emoji | undefined => {
    const name = rawName.trim();
    const exact = emojis.find(emoji => emoji.name === name);
    if (exact) return exact;

    const separator = name.match(/^(.+?)\s*[:：]\s*(.+)$/u);
    if (!separator) return undefined;
    const categoryName = separator[1].trim();
    const emojiName = separator[2].trim();
    if (!categoryName || !emojiName) return undefined;

    const categoryIds = new Set(categories.map(category => category.id));
    const candidates: Emoji[] = [];
    for (const category of categories) {
        if (category.name !== categoryName) continue;
        candidates.push(...emojis.filter(emoji => (
            emoji.categoryId === category.id && emoji.name === emojiName
        )));
    }
    // buildEmojiContext 给无分类表情使用“通用”，给找不到分类定义的残留使用“其他”。
    if (categoryName === '通用') {
        candidates.push(...emojis.filter(emoji => !emoji.categoryId && emoji.name === emojiName));
    } else if (categoryName === '其他') {
        candidates.push(...emojis.filter(emoji => (
            !!emoji.categoryId && !categoryIds.has(emoji.categoryId) && emoji.name === emojiName
        )));
    }

    const unique = candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);
    return unique.length === 1 ? unique[0] : undefined;
};

interface MimickedXhsShareBlock {
    title: string;
    author: string;
    interactionText: string;
    desc: string;
}

// 模型偶尔会模仿历史上下文里的人类可读卡片摘要，而不是输出 [[XHS_SHARE]].
// 只吃掉完整的五字段形态，避免误伤普通聊天中提到“标题/作者”的句子。
const MIMICKED_XHS_SHARE_RE = /(^|\r?\n)[ \t]*\[[^\]\r\n]{0,32}分享了小红书笔记\][ \t]*(?:\r?\n[ \t]*)+标题\s*[:：]\s*([^\r\n]+?)[ \t]*(?:\r?\n[ \t]*)+作者\s*[:：]\s*([^\r\n]+?)[ \t]*(?:\r?\n[ \t]*)+互动\s*[:：]\s*([^\r\n]*?)[ \t]*(?:\r?\n[ \t]*)+简介\s*[:：]\s*([^\r\n]*)(?=\r?\n|$)/gmu;

const extractMimickedXhsShares = (content: string): { cleanedContent: string; shares: MimickedXhsShareBlock[] } => {
    const shares: MimickedXhsShareBlock[] = [];
    // Some models glue the next history-shaped card directly after the previous
    // description (`简介: 无[你分享了小红书笔记]`). Put the marker back on its own
    // line before scanning so every card is recovered instead of leaking the
    // second card as five ordinary chat bubbles.
    const normalizedBlocks = content.replace(
        /([^\r\n])(\[[^\]\r\n]{0,32}分享了小红书笔记\])/gu,
        '$1\n$2',
    );
    const cleanedContent = normalizedBlocks.replace(
        MIMICKED_XHS_SHARE_RE,
        (_match, leadingBreak: string, title: string, author: string, interactionText: string, desc: string) => {
            shares.push({
                title: title.trim().replace(/^[《【]|[》】]$/g, ''),
                author: author.trim(),
                interactionText: interactionText.trim(),
                desc: desc.trim(),
            });
            return leadingBreak || '';
        },
    ).replace(/\n{3,}/g, '\n\n').trim();
    return { cleanedContent: shares.length > 0 ? cleanedContent : content, shares };
};

const normalizeXhsCardKey = (value: string): string => String(value || '')
    .trim()
    .replace(/^[《【"'“‘]+|[》】"'”’]+$/g, '')
    .replace(/\s+/g, '')
    .toLocaleLowerCase();

const parseMimickedXhsCount = (interactionText: string, label: string): number => {
    const match = interactionText.match(new RegExp(`([\\d.,+万千亿kKmMwW]+)\\s*${label}`));
    return parseXhsCount(match?.[1] || 0);
};
// XHS side-effect helpers (POKE-style: 不抽到 agenticTools, 留给 Phase 2 Round 2 的 directive 重放)

async function xhsPublish(
    conf: { mcpUrl: string },
    owner: Pick<CharacterProfile, 'id' | 'name'>,
    title: string,
    content: string,
    tags: string[],
): Promise<{ success: boolean; noteId?: string; message: string }> {
    let images: string[] = [];
    try {
        const stockImgs = await DB.getXhsStockImages();
        if (stockImgs.length > 0) {
            const keywords = [title, content, ...tags].join(' ').toLowerCase();
            const scored = stockImgs.map(img => ({
                img,
                score: img.tags.reduce((s: number, t: string) => s + (keywords.includes(t.toLowerCase()) ? 10 : 0), 0) + Math.max(0, 5 - (img.usedCount || 0))
            })).sort((a, b) => b.score - a.score);
            if (scored[0]?.img.url) {
                images = [scored[0].img.url];
                DB.updateXhsStockImageUsage(scored[0].img.id).catch(() => {});
            }
        }
    } catch { /* ignore stock failures */ }

    const r = await XhsMcpClient.publishNote(conf.mcpUrl, { title, content, tags, images: images.length > 0 ? images : undefined });
    const noteId = r.success ? extractPublishedNoteId(r) : '';
    if (r.success && noteId) {
        const now = Date.now();
        try {
            await DB.saveXhsOwnedPost({
                id: `${owner.id}:${noteId}`,
                characterId: owner.id,
                noteId,
                title: title || '无标题',
                body: content,
                tags,
                publishedAt: now,
                updatedAt: now,
            });
        } catch (error) {
            // 远端已经发布成功，不能因为本地索引写入失败把它误报成“发帖失败”。
            console.warn('[XHS] 发帖成功，但保存角色主页索引失败:', error);
        }
    }
    return { success: r.success, noteId: noteId || undefined, message: r.error || (r.success ? '发布成功' : '发布失败') };
}

async function xhsComment(conf: { mcpUrl: string }, noteId: string, content: string, xsecToken?: string): Promise<{ success: boolean; message: string }> {
    const r = await XhsMcpClient.comment(conf.mcpUrl, noteId, content, xsecToken);
    return { success: r.success, message: r.error || (r.success ? '评论成功' : '评论失败') };
}

async function xhsLike(conf: { mcpUrl: string }, feedId: string, xsecToken: string): Promise<{ success: boolean; message: string }> {
    const r = await XhsMcpClient.likeFeed(conf.mcpUrl, feedId, xsecToken);
    return { success: r.success, message: r.error || (r.success ? '点赞成功' : '点赞失败') };
}

async function xhsFavorite(conf: { mcpUrl: string }, feedId: string, xsecToken: string): Promise<{ success: boolean; message: string }> {
    const r = await XhsMcpClient.favoriteFeed(conf.mcpUrl, feedId, xsecToken);
    return { success: r.success, message: r.error || (r.success ? '收藏成功' : '收藏失败') };
}

async function xhsReplyComment(conf: { mcpUrl: string }, feedId: string, xsecToken: string, content: string, commentId?: string, userId?: string, parentCommentId?: string): Promise<{ success: boolean; message: string }> {
    const r = await XhsMcpClient.replyComment(conf.mcpUrl, feedId, xsecToken, content, commentId, userId, parentCommentId);
    return { success: r.success, message: r.error || (r.success ? '回复成功' : '回复失败') };
}

// ─── 公开类型 ────────────────────────────────────────────────────────────────

/**
 * worker `onLLMOutput` hook 把识别到的副作用标签结构化传回, 客户端 applyAssistantPostProcessing
 * 反向重建标签后让下游 chatParser / 内联 XHS handler 复用同一份执行逻辑 (避免在客户端再写一遍).
 *
 * 字段形状跟 worker/instant-push/src/classifier.ts:Directive 必须保持一致 — 用 type 做
 * discriminator, 其他字段是 flat 而不是 nested payload (减少 push body 嵌套).
 */
export type PostProcessDirective =
    | { type: 'poke' }
    | { type: 'transfer'; amount: number }
    | { type: 'transfer_accept' }
    | { type: 'transfer_return' }
    | { type: 'add_event'; title: string; date: string }
    | { type: 'change_schedule'; time: string; activity: string }
    | { type: 'schedule_message'; time: string; text: string }
    // song 是主动消息 2.0 的定时路径后补的「角色说的是哪首歌」（见 chatParser 的
    // FrozenMusicSong）；标签里只有歌单名带不动它，所以单独走 directive 字段。
    | { type: 'music_action'; verb: string; args: string[]; song?: FrozenMusicSong }
    | { type: 'xhs_like'; noteId: string }
    | { type: 'xhs_fav'; noteId: string }
    | { type: 'xhs_comment'; noteId: string; text: string }
    | { type: 'xhs_reply'; noteId: string; commentId: string; text: string }
    | { type: 'xhs_post'; title: string; content: string; tags: string }
    | { type: 'xhs_share'; idx: number }
    // 生活记录代记 / 热点卡片 — body 是冒号后的整段原文, 拼回原 tag 交给 chatParser
    // (LIFE → lifeRecords.executeLifeDirectives, NEWS_CARD → 落 news_card 消息)。
    | { type: 'life_record'; body: string }
    | { type: 'news_card'; body: string }
    // Notion / 飞书 写日记 — worker classifier 提取 title/content/mood, 我们拼回原 tag 给
    // line 465 (Notion) / 649 (飞书) 既有 handler 跑. title 可空, 客户端兜底.
    | { type: 'notion_write_diary'; title: string; content: string; mood?: string }
    | { type: 'feishu_write_diary'; title: string; content: string; mood?: string };

/**
 * 把结构化 directive 反向拼回原 tag 字符串. 拼回的目的是让下游 chatParser.parseAndExecuteActions
 * (POKE/TRANSFER/ADD_EVENT/schedule_message/MUSIC_ACTION) + 内联 XHS handler (LIKE/FAV/COMMENT/REPLY/POST/SHARE)
 * 用跟本地 fetch 路径一致的代码执行 — 不在客户端为 push 路径再写一份副作用执行器.
 *
 * 已知边界 case: 字段含 `|` / `]` 时会破坏 tag 边界. worker 端 classifier 已经按 `[^|]+?`
 * 切片, 所以这里反过来拼回去用户自定义内容里如果有 `|` 会重叠. 接受这个 trade-off — 本地
 * fetch 路径里这种内容也有同样问题, 等于 push 路径不增加新 failure mode.
 */
function reconstructDirectiveTags(directives: PostProcessDirective[] | undefined): string {
    if (!directives || directives.length === 0) return '';
    const parts: string[] = [];
    for (const d of directives) {
        switch (d.type) {
            case 'poke':
                parts.push('[[ACTION:POKE]]');
                break;
            case 'transfer':
                parts.push(`[[ACTION:TRANSFER:${d.amount}]]`);
                break;
            // 收/退回执: worker 端已把口语形态 (`[系统: 你接收了xx的转账 520]`) 归一成
            // 这两个 directive, 这里拼回规范标签交给 chatParser 执行 (找不到待处理转账时
            // 它会跳过, 不会落一张假的"已收款")。
            case 'transfer_accept':
                parts.push('[[ACTION:TRANSFER_ACCEPT]]');
                break;
            case 'transfer_return':
                parts.push('[[ACTION:TRANSFER_RETURN]]');
                break;
            case 'add_event':
                parts.push(`[[ACTION:ADD_EVENT|${d.title}|${d.date}]]`);
                break;
            case 'change_schedule':
                parts.push(`[[ACTION:CHANGE_SCHEDULE|${d.time}|${d.activity}]]`);
                break;
            case 'schedule_message':
                parts.push(`[schedule_message | ${d.time} | fixed | ${d.text}]`);
                break;
            case 'music_action': {
                const tail = d.args && d.args.length > 0 ? `|${d.args.join('|')}` : '';
                parts.push(`[[MUSIC_ACTION:${d.verb}${tail}]]`);
                break;
            }
            case 'xhs_like':
                parts.push(`[[XHS_LIKE:${d.noteId}]]`);
                break;
            case 'xhs_fav':
                parts.push(`[[XHS_FAV:${d.noteId}]]`);
                break;
            case 'xhs_comment':
                parts.push(`[[XHS_COMMENT:${d.noteId} | ${d.text}]]`);
                break;
            case 'xhs_reply':
                parts.push(`[[XHS_REPLY:${d.noteId} | ${d.commentId} | ${d.text}]]`);
                break;
            case 'xhs_post':
                parts.push(`[[XHS_POST:${d.title} | ${d.content} | ${d.tags}]]`);
                break;
            case 'xhs_share':
                parts.push(`[[XHS_SHARE:${d.idx}]]`);
                break;
            case 'life_record':
                parts.push(`[[LIFE:${d.body}]]`);
                break;
            case 'news_card':
                parts.push(`[[NEWS_CARD: ${d.body}]]`);
                break;
            case 'notion_write_diary': {
                // 拼回长形态 [[DIARY_START: title|mood]]\n content \n[[DIARY_END]],
                // 因为客户端 line 465 既支持长又支持短, 长形态信息更全 (能区分 mood).
                // title 为空时给客户端空 header, 它内部 line 498-501 会用 char.name + 日期兜底.
                const header = d.mood ? `${d.title}|${d.mood}` : d.title;
                parts.push(`[[DIARY_START: ${header}]]\n${d.content}\n[[DIARY_END]]`);
                break;
            }
            case 'feishu_write_diary': {
                const header = d.mood ? `${d.title}|${d.mood}` : d.title;
                parts.push(`[[FS_DIARY_START: ${header}]]\n${d.content}\n[[FS_DIARY_END]]`);
                break;
            }
            default:
                console.warn('[directive-replay] unknown directive type, skipping', d);
        }
    }
    return parts.length > 0 ? `${parts.join('\n')}\n\n` : '';
}

/** XHS reply-related caches — 跨消息存活, 调用方负责持有 (一般是 useRef 包起来) */
export interface XhsCaches {
    /** noteId → xsecToken */
    xsecTokenCache: Map<string, string>;
    /** noteId → title */
    noteTitleCache: Map<string, string>;
    /** commentId → userId */
    commentUserIdCache: Map<string, string>;
    /** commentId → 评论作者昵称 (降级为 @mention 顶级评论用) */
    commentAuthorNameCache: Map<string, string>;
    /** commentId → parentCommentId */
    commentParentIdCache: Map<string, string>;
}

export interface PostProcessApiCall {
    /** 主 API 调用入口 base, 不含末尾斜杠 (e.g. "https://api.openai.com/v1") */
    baseUrl: string;
    /** Authorization 头等 */
    headers: Record<string, string>;
    /** 当前生效的 API (拿 model / 兜底其他配置用) */
    effectiveApi: { baseUrl: string; apiKey: string; model: string };
}

export interface PostProcessMusicHooks {
    getListeningSnapshot: () => {
        songId: number;
        name: string;
        artists: string;
        album: string;
        albumPic: string;
        duration: number;
        fee: number;
    } | null;
    joinListeningTogether: (charId: string) => void;
    addSongToCharPlaylist: (
        charId: string,
        song: any,
        target?: any,
    ) => Promise<{ playlistTitle: string; created: boolean } | null>;
}

export interface PostProcessHooks {
    setMessages: (msgs: Message[]) => void;
    addToast: (msg: string, type: 'info' | 'success' | 'error') => void;
    setRecallStatus?: (s: string) => void;
    setSearchStatus?: (s: string) => void;
    setDiaryStatus?: (s: string) => void;
    setXhsStatus?: (s: string) => void;
    /** token 计费汇总 (调用方负责把 React state 同步上去) */
    updateTokenUsage?: (data: any, msgCount: number, pass: string) => void;
    /** 给 ChatParser.parseAndExecuteActions 用的音乐钩子 */
    musicHooks?: PostProcessMusicHooks;
    /**
     * 日程改动没能落地时的告知出口。不传就走 addToast（本地聊天：用户正看着屏幕，
     * 一条 toast 就够）。
     *
     * 主动消息路径必须传：那条路上的 addToast 是 console.log（推送随时到达，用户多半
     * 不在看这个角色，狂弹 toast 反而更糟），于是「角色说今晚不睡了、日程卡还写着睡觉」
     * 这件事对用户是完全无声的。那边把它接到 active-msg-process-failed 上——已有的
     * 可见通道，自带每角色 60 秒节流。
     */
    notifyScheduleChangeFailed?: (note: string) => void;
}

export interface PostProcessCtx {
    char: CharacterProfile;
    userProfile: UserProfile;
    emojis: Emoji[];
    /** 已按当前角色可见性过滤的分类；用于容错解析“分类名: 表情名”。 */
    categories?: EmojiCategory[];
    realtimeConfig?: RealtimeConfig;
    /** 日程被角色改写后刷新主动消息 fire_pack；旧调用方可不传。 */
    groups?: GroupProfile[];
    /**
     * 这段话**说出口**的时刻（ms）。只有日程改动用得上：它要按角色说这句话的那一刻
     * 判「哪条时段还能改」，而不是按处理它的这一刻。本地聊天两者差几秒、不用传；
     * 主动消息路径必须传 push 的 sentAt——用户隔夜才打开 App 时，昨晚那句
     * 「22:00 改成陪你聊天」不该落到今天的 22:00 上（scheduleChange 那边还有一道
     * 日历日门槛兜底，隔天的整批丢弃）。
     */
    spokenAt?: number;
    /** 上下文消息窗 — 用来匹配 quote 目标 */
    contextMsgs: Message[];
    /** 发给 API 的完整 messages 数组 — 2nd-pass LLM 调用要带上 */
    fullMessages: any[];
    /** 第一次 API 调用的原始响应, 后续 2nd-pass 会覆盖它 (复制旧实现的局部变量行为) */
    initialData: any;
    /** historyMsgCount — 给 updateTokenUsage 用 */
    historyMsgCount: number;
    /** 当 MCD MiniApp 打开时附加到每条 assistant message 的 metadata patch */
    mcdInheritMeta?: any;
    /** XHS 跨消息缓存 (调用方持有的 ref) */
    xhsCaches: XhsCaches;
    /**
     * XHS 跨工具调用共享的"上一次 search/browse 结果". 给 [[XHS_SHARE: 序号]] 用.
     *
     * 本地 fetch 路径 caller 不传 — 函数内自动创建 fresh, 单次 send 内同 round runXhsBrowse/Search 填充
     * 后立刻被同 round XHS_SHARE replay 读到 (跟历史行为字节级一致).
     *
     * Instant push 路径 caller (utils/activeMsgRuntime.ts) **必传** module-level 单例:
     * runXhsBrowse 在 instantToolRunner round 1 填充 → /continue → worker round 2 LLM 输出 XHS_SHARE
     * → push 落库 → applyAssistantPostProcessing replay 读同一份 ref. 跨 round 共享 = 跟本地路径同 UX.
     */
    lastXhsNotesRef?: { current: XhsNote[] };
    /** API 调用配置 */
    api: PostProcessApiCall;
    /** UI / 业务钩子 */
    hooks: PostProcessHooks;
    /**
     * 置 true = 跳过"拟人打字延迟"（每条 0.5~2s 的 setTimeout），气泡近乎立即回填。
     * 两种情况该置：
     *   1. 流式预览已把气泡实时展示过（hooks/useChatAI 的 streamingBubbles）——否则用户会
     *      看到"预览气泡收回去 → 再一条条慢慢重弹"的二次播放；
     *   2. 主动消息补收（utils/activeMsgRuntime 的 isFreshInboxDelivery 判为否）——内容
     *      几小时前就在云端生成完了，再慢放一遍只会让用户干等着一条条冒。
     * 其余路径（非流式 / 双语 / 工具模式 / 实时送达的主动消息）不传，打字节奏不变。
     */
    instantRender?: boolean;
    /**
     * Phase 1+: 当 worker 已在自己内部跑过 2nd-pass LLM 时, 主线程不该再调一次。
     * Phase 0 始终为 false / undefined。
     */
    skipSecondPassLLM?: boolean;
    /**
     * Phase 2+: worker 端把识别到的副作用结构化传过来; 非空时只重放, 不再扫原文。
     * Phase 0 始终为 [] / undefined。
     */
    directives?: PostProcessDirective[];
    /**
     * Phase 2 Round 2: push 路径 reasoning chain 来源. SW 把 ReasoningPush 写到
     * reasoning_buffer, flushInboxToChat 在处理 sessionId 的第一条 content 时 claim
     * 出来塞到这里. 本地 fetch 路径不传 (Step 4 仍从 initialData.choices[0].message.reasoning_content 读).
     */
    reasoningContent?: string;
    /**
     * 本轮所有落库消息统一使用的时间戳 (毫秒)。不传 = 维持 DB.saveMessage 默认
     * (写库当刻的 Date.now())。主动消息离线补收时由 activeMsgRuntime 传 worker 发送
     * 时刻 (sentAt) 进来: 昨晚推的消息中午打开时气泡显示昨晚, 跟正文里角色说的话
     * 对得上; 同一条 push 拆出的文字 / 表情 / 卡片多条气泡也共用同一个值 (显示顺序
     * 按自增 id, 不看 timestamp, 所以只需一致、不需递增)。
     * 在线送达 vs 离线补收的判定见 activeMsgRuntime.resolveInboxPersistTimestamp。
     */
    messageTimestamp?: number;
    /** SAR 模块的纯展示层。canonical 正文仍走 rawAiContent 的完整后处理与落库。 */
    sarModuleSurface?: SARModuleSurfaceMeta;
}

// ─── 主入口 ─────────────────────────────────────────────────────────────────

/**
 * 与 useChatAI 旧版 inline 实现行为字节级对齐。
 * skipSecondPassLLM=false + directives=[] 时是 Phase 0 默认形态。
 */
export async function applyAssistantPostProcessing(
    rawAiContent: string,
    ctx: PostProcessCtx,
): Promise<void> {
    const {
        char,
        userProfile,
        emojis,
        realtimeConfig,
        groups,
        spokenAt,
        contextMsgs,
        fullMessages,
        initialData,
        historyMsgCount,
        mcdInheritMeta,
        xhsCaches,
        api,
        hooks,
        instantRender,
        skipSecondPassLLM,
        directives,
        reasoningContent: pushReasoningContent,
        messageTimestamp,
        sarModuleSurface,
    } = ctx;
    const { baseUrl, headers, effectiveApi } = api;
    // 拟人打字延迟：流式预览已实时展示过气泡时（instantRender）跳过，避免二次慢放
    const typingPause = (ms: number): Promise<void> =>
        instantRender ? Promise.resolve() : new Promise(r => setTimeout(r, ms));
    // 统一落库入口：ctx.messageTimestamp（若有）盖到每条消息上，保证同一轮拆出的
    // 正文 / 表情 / 卡片 / 系统提示时间戳一致；没传则维持 DB.saveMessage 默认（写库当刻）。
    // 全函数落库一律走这里，别直接调 DB.saveMessage——漏一处就会出现气泡时间戳互相打架。
    const persistMessage: typeof DB.saveMessage = (msg) =>
        DB.saveMessage(messageTimestamp != null ? { ...msg, timestamp: messageTimestamp } : msg);
    const {
        setMessages,
        addToast,
        notifyScheduleChangeFailed,
        setRecallStatus = () => {},
        setSearchStatus = () => {},
        setDiaryStatus = () => {},
        setXhsStatus = () => {},
        updateTokenUsage = () => {},
        musicHooks,
    } = hooks;
    const {
        xsecTokenCache: xsecTokenCacheRef,
        commentUserIdCache: commentUserIdCacheRef,
        commentAuthorNameCache: commentAuthorNameCacheRef,
        commentParentIdCache: commentParentIdCacheRef,
    } = xhsCaches;

    // API 调用记录用 meta：二轮重生 / 调阅 / 日记 / 小红书等都归在「消息」App 下，purpose 见各分支。
    const apiLogMeta = { appName: '消息', charId: char.id, charName: char.name };

    // Phase 1: skipSecondPassLLM=true (instant push 路径) 时, 跳过所有需要回连 LLM 的
    // 二轮分支 (RECALL / SEARCH / READ_DIARY / FS_READ_DIARY / READ_NOTE / XHS_*)。
    // 这些 tag 留在原文里, 由后面 Step 6 的 ChatParser.sanitize 兜底剥掉 (chatParser.ts:225
    // 的正则覆盖 ACTION/RECALL/SEARCH/DIARY/READ_DIARY/FS_DIARY/FS_READ_DIARY/...),
    // XHS_* / READ_NOTE 兜底用 Step 12 的 hasDisplayContent + per-chunk sanitize 再清一遍。
    // 写日记类 (DIARY / FS_DIARY) 不走 LLM, 属于纯副作用 (像 POKE), 客户端可以直接执行。
    // Phase 2 Round 2: directives 非空时, worker 已经把副作用标签结构化传过来 (并从 push body
    // 里剥光了). 我们重建原 tag 字符串塞回 rawAiContent 头部, 让下游 chatParser.parseAndExecuteActions
    // + 后置 XHS_* 内联 handler 用同一份代码执行 — 零重复实现, 跟本地 fetch 路径同一份 source of truth.
    // tag 末尾 +\n\n 保证不跟正文粘连导致 regex 漏匹配; chatParser.sanitize 会把它们清干净.
    const replayedTagPrefix = reconstructDirectiveTags(directives);
    const hasReplayDirectives = !!directives && directives.length > 0;

    // Phase 1 把 XHS 副作用 (LIKE/FAV/COMMENT/REPLY/POST/SHARE) 跟 2nd-pass LLM tools (SEARCH/BROWSE/
    // DETAIL/MY_PROFILE) 一起用 skipSecondPassLLM 关掉了. Round 2 拆开: 副作用类只需要 MCP 调用,
    // 不需要 LLM round-trip, 当 worker 给了 directives 时 (xhs_* in classifier) 这些 tag 已重建回正文,
    // 必须执行. 用 disabledXhsSideEffects = (skipSecondPassLLM && !hasReplayDirectives) 区分:
    //   - 本地 fetch 路径: skipSecondPassLLM=false → false → 不禁用, 跟历史行为一致
    //   - Phase 1 push 路径 (老 worker, 无 directives): true && true → 禁用 (旧 trade-off 不变)
    //   - Phase 2 push 路径 (Round 2 worker, 有 directives): true && false → 不禁用, 副作用照常跑
    const disabledXhsSideEffects = skipSecondPassLLM && !hasReplayDirectives;

    /** 从缓存或 notesPool 中查找 xsecToken — 仅副作用 XHS handler (COMMENT/REPLY/LIKE/FAV) 使用 */
    const findXsecToken = (noteId: string, notesPool: XhsNote[]): string | undefined => {
        const fromNotes = notesPool.find(n => n.noteId === noteId)?.xsecToken;
        if (fromNotes) return fromNotes;
        return xsecTokenCacheRef.get(noteId);
    };

    /**
     * XHS 跨 tool 共享笔记缓冲 — 取代旧版 `let lastXhsNotesRef.current`.
     * Caller (instant push 路径) 传了 module-level 单例就用它 (跨 round 共享让 XHS_SHARE 找到上轮笔记);
     * 没传 (本地 fetch 路径) 自动创建 fresh (单次 send 内 runXhsBrowse → XHS_SHARE 同一函数闭包内共享, 跟历史一致).
     */
    const lastXhsNotesRef = ctx.lastXhsNotesRef ?? { current: [] as XhsNote[] };

    /** agenticTools 入参 ctx — 9 个 run* 函数共享 */
    const agenticCtx: AgenticToolCtx = {
        char,
        userProfile,
        realtimeConfig,
        xhsCaches: ctx.xhsCaches,
        lastXhsNotesRef,
        // 把 setXhsStatus / setDiaryStatus 透传给 agenticTools 内部多步操作 (XHS_DETAIL retry /
        // XHS_MY_PROFILE fallback / DIARY/NOTE 读 N 篇 中间态), 保持跟原 inline 实现的 status 文案一致.
        onProgress: (channel, text) => {
            if (channel === 'xhs') setXhsStatus(text);
            else if (channel === 'diary') setDiaryStatus(text);
        },
    };
    void agenticCtx;

    // 局部 data 副本 — 后续 2nd-pass 会覆盖, 模仿旧版的 let data 行为
    let data: any = initialData;

    let scheduleFailureNotified = false;
    // 这句话**说出口**的时刻。本地聊天没传就是「现在」；主动消息传 push 的 sentAt。
    const utteranceAt = typeof spokenAt === 'number' && Number.isFinite(spokenAt)
        ? new Date(spokenAt)
        : new Date();
    /**
     * `at` 是这段文字说出口的时刻，由调用处按来源给：首轮正文用 utteranceAt，二轮
     * LLM 产出的那段用「现在」——它是刚刚生成的，跟原始那句话隔着几次工具往返，
     * 拿旧钟去判会把新写的日程改动当成隔夜的整批丢掉。
     */
    const consumeScheduleChanges = async (content: string, at: Date): Promise<string> => {
        const result = await applyAssistantScheduleChanges(content, char, at);
        if (result.changes.length > 0 && result.schedule) {
            // 本地聊天直接复用 caller 的 groups；主动消息路径只在真的改了日程时读一次，
            // 不给每一条普通 push 平添 IndexedDB 查询和新的失败点。
            const syncGroups = groups ?? await DB.getGroups().catch(() => undefined);
            // realtimeConfig 缺席也照打脏：快照里它本来就是可选的，而「没开过实时设置」
            // 就是默认状态（localStorage 里压根没这个键）。少打这一次脏，云端 fire_pack
            // 会一直留着旧日程，下一次主动消息还在念角色刚说过不做的那件事。
            if (syncGroups) markAmsgStateDirty({ char, userProfile, groups: syncGroups, realtimeConfig });
            announceScheduleChanges(char.id, result.schedule, result.changes);
        }
        if (!scheduleFailureNotified
            && result.changes.length === 0
            && (result.malformedCount > 0 || result.rejectedCount > 0)) {
            scheduleFailureNotified = true;
            if (result.rejectedReason === 'cross-day') {
                // 隔夜补收：角色昨晚说的话，今天这张表本来就不该跟着动。这是日历日门槛
                // 按设计工作，不是失败——弹提示会让用户以为出了错，接到送达失败那条通道
                // 上还会把「主动消息送达失败」的指标撑起来（送达其实成功了）。留一行日志
                // 就够，界面上什么都不用说：用户看到的消息和今天的日程表本来就不矛盾。
                console.info('[schedule-change] 这批改动是之前说的，今天的表不动', {
                    charId: char.id,
                    count: result.rejectedCount,
                });
            } else {
                // 剩下两种才是真没落地。两种原因分开讲：一种是标签认出来了但今天的表里
                // 没有对得上的时段，一种是标签本身就没写对，用户能做的事不一样。
                const failureNote = result.rejectedCount > 0
                    ? '日程修改没有找到对得上的时段，已安全跳过'
                    : '日程修改的格式没认出来，已安全跳过';
                if (notifyScheduleChangeFailed) notifyScheduleChangeFailed(failureNote);
                else addToast(failureNote, 'info');
            }
        }
        return result.cleanedText;
    };

    // ─── Step 1: 初次粗洗 ───
    let aiContent = replayedTagPrefix ? `${replayedTagPrefix}${rawAiContent}` : rawAiContent;
    aiContent = normalizeAiContent(aiContent);
    // 先于 lead-in / 二轮渲染消费：否则控制标签会作为普通气泡短暂闪给用户看。
    aiContent = await consumeScheduleChanges(aiContent, utteranceAt);
    // 在任何 lead-in/二轮渲染之前先剥掉仿卡片文本，防止它被 chunkText 拆成灰色普通气泡。
    const mimickedXhsShares = extractMimickedXhsShares(aiContent);
    aiContent = mimickedXhsShares.cleanedContent;

    // ── 渲染基础设施 (提前声明, 供"执行功能前先展示本轮正文 A" + 末尾展示二轮结果 B 复用) ──
    // 引用/回复标签的匹配 + 清理正则 (提前声明避免 lead-in 渲染时落入 TDZ)。
    const QUOTE_RE_DOUBLE = /\[\[(?:QU[OA]TE|引用)[：:]\s*([\s\S]*?)\]\]/;
    const QUOTE_RE_SINGLE = /\[(?:QU[OA]TE|引用)[：:]\s*([^\]]*)\]/;
    const REPLY_RE_CN = /\[回复\s*[""“]([^""”]*?)[""”](?:\.{0,3})\]\s*[：:]?\s*/;
    // 历史里引用消息被渲染成 [xx引用了xx说的「…」，并回复了 ↓]（chatPrompts.buildMessageHistory），
    // 模型会模仿这个渲染格式而不是规范的 [[QUOTE:]] —— 把它也认作合法引用，否则既丢引用
    // 又把整段方括号原样漏进气泡。「」是该渲染格式的硬锚点，配合"引用了"双锚降低误报。
    // 引用摘要被截断成单行，「」内用 [^」\n]*? 限制在同一行：缺闭合 」 时不会跨行吞掉正文段落。
    const QUOTE_RE_NL = /\[[^\[\]\n「」]{0,24}引用了[^\[\]\n「」]{0,24}「([^」\n]*?)」[^\[\]\n]{0,24}\]\s*/;
    const QUOTE_CLEAN_DOUBLE = /\[\[(?:QU[OA]TE|引用)[：:][\s\S]*?\]\]/g;
    const QUOTE_CLEAN_SINGLE = /\[(?:QU[OA]TE|引用)[：:][^\]]*\]/g;
    const REPLY_CLEAN_CN = /\[回复\s*[""“][^""”]*?[""”](?:\.{0,3})\]\s*[：:]?\s*/g;
    const QUOTE_CLEAN_NL = /\[[^\[\]\n「」]{0,24}引用了[^\[\]\n「」]{0,24}「[^」\n]*?」[^\[\]\n]{0,24}\]\s*/g;

    // 抽取思考链 (showThinkingChain 开启时): reasoning_content + 内联 <think> 块。
    const extractThinkingChain = (dataObj: any, reasoningOverride?: string): string | null => {
        if (!(char as any).showThinkingChain) return null;
        const lastRaw = dataObj?.choices?.[0]?.message?.content || '';
        const lastReasoning = (
            (reasoningOverride && reasoningOverride.trim())
            || dataObj?.choices?.[0]?.message?.reasoning_content
            || ''
        ).trim();
        const thinkBlocks: string[] = [];
        const thinkPat = /<(think|thinking|thought)>([\s\S]*?)<\/\1>/gi;
        let tm: RegExpExecArray | null;
        while ((tm = thinkPat.exec(lastRaw)) !== null) {
            const t = tm[2].trim();
            if (t) thinkBlocks.push(t);
        }
        if (!/<\/(?:think|thinking|thought)>/i.test(lastRaw)) {
            const openOnly = lastRaw.match(/<(?:think|thinking|thought)>([\s\S]*$)/i);
            if (openOnly && openOnly[1].trim()) thinkBlocks.push(openOnly[1].trim());
        }
        const chain = [lastReasoning, ...thinkBlocks].filter(s => !!s).join('\n\n').trim();
        return chain || null;
    };

    // 把一段文本 (parseAndExecuteActions / HTML 之外的部分) 渲染成气泡并落库 —— 双语 / 表情 / 引用 / 分段
    // 与原 inline 末尾逻辑一致。抽出来是为了让"执行功能前的本轮正文 A"能在二轮前先展示, 二轮结果 B 复用同一套。
    let sarSurfaceClaimed = false;
    const renderAndPersist = async (rawContent: string, firstThinkingChain: string | null): Promise<void> => {
        let firstMeta: any = firstThinkingChain ? { thinkingChain: firstThinkingChain } : null;
        const surfaceChunks = !sarSurfaceClaimed && sarModuleSurface?.surface
            ? splitSARChatSurfaceBubbles(sarModuleSurface.surface)
            : [];
        if (surfaceChunks.length > 0) sarSurfaceClaimed = true;
        let surfaceIndex = 0;
        const takeMeta = (base: any, canonicalChunk?: string): any => {
            let surfaceChunk: string | undefined;
            if (canonicalChunk !== undefined) {
                const aligned = consumeSARChatSurfaceChunk(canonicalChunk, surfaceChunks, surfaceIndex);
                surfaceChunk = aligned.surface;
                surfaceIndex = aligned.nextIndex;
            }
            const sarMeta = surfaceChunk && sarModuleSurface
                ? { sarModuleSurface: { ...sarModuleSurface, surface: surfaceChunk } }
                : undefined;
            const merged = firstMeta || sarMeta
                ? { ...(base || {}), ...(sarMeta || {}), ...(firstMeta || {}) }
                : base;
            firstMeta = null;
            return merged;
        };

        // 表情按模型写的位置原地插发。名字在表情库里找不到时落一条降级文本气泡，不静默丢：
        // 后台主动消息会把每个 [[SEND_EMOJI]] 切成独立一条 push，找不到就是整条 0 气泡，而
        // 系统横幅和未读数照常 +1 —— 用户点进去空空如也。名字对不上有两条常见来路：模型自己
        // 编了个不存在的名字，或者用户在上次打包之后删了 / 改名了这个表情。
        // 降级文案跟横幅那边（sanitizeIntoSegments 的 [表情：x]）对齐，锁屏看到什么点进去就是什么。
        const sendEmojiBubble = async (name: string): Promise<void> => {
            await typingPause(Math.random() * 500 + 300);
            const foundEmoji = resolveEmojiForSend(name, emojis, ctx.categories);
            if (foundEmoji) {
                await persistMessage({ charId: char.id, role: 'assistant', type: 'emoji', content: foundEmoji.url, metadata: takeMeta(mcdInheritMeta) } as any);
            } else {
                console.warn('[emoji] 表情库里没有这个名字，落降级文本气泡', { name, charId: char.id });
                await persistMessage({ charId: char.id, role: 'assistant', type: 'text', content: `[表情：${name}]`, metadata: takeMeta(mcdInheritMeta) } as any);
            }
            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
        };

        // 把 [[QUOTE: ...]] / [回复 "..."] 的引用文本解析成"被回复的那条用户消息"。
        // 开了翻译的外语/粤语角色，引用文本往往是外语、或被 <原文>/<译文> 翻译标签包裹，
        // 跟库里中文用户消息逐字 includes 匹配会失败 → 之前表现为丢引用 / 空引用气泡。
        // 这里先剥掉翻译标签再逐字/前缀精确定位；匹配不到就兜底到「最近一条用户文字消息」
        // （[[QUOTE]] 基本放在回复开头、指代最近一句话，兜底足够稳），杜绝外语角色空引用。
        const resolveQuoteTarget = (quotedTextRaw: string): { id: number, content: string, name: string } | undefined => {
            const raw = (quotedTextRaw || '').trim();
            // 引用文本可能被翻译标签包裹：<原文>(外语) 与 <译文>(本地语) 都可能命中库里的中文用户消息。
            // 不能直接剥标签——那样会把原文+译文拼成一串(如「你好Hello」)导致 includes 永远匹配不上。
            // 这里把两边内容各自当候选逐个匹配；没有成对标签时再退化成「剥掉零散标签」的兜底候选。
            const candidates: string[] = [];
            // 历史渲染的引用摘要超过 60 字会带截断省略号，剥掉再匹配（不剥则 includes 永远失败）。
            const pushCand = (s?: string) => { const t = (s || '').trim().replace(/(?:[…⋯]+|\.{3,})$/, '').trim(); if (t && !candidates.includes(t)) candidates.push(t); };
            pushCand(raw.match(/<原文>([\s\S]*?)<\/原文>/)?.[1]);
            pushCand(raw.match(/<译文>([\s\S]*?)<\/译文>/)?.[1]);
            pushCand(raw.replace(/<\/?翻译>|<\/?原文>|<\/?译文>/g, '').replace(/%%BILINGUAL%%/gi, ''));
            const users = contextMsgs.filter((m: Message) => m.role === 'user' && typeof m.content === 'string' && !!m.content.trim());
            const reversedUsers = users.slice().reverse();
            let targetMsg: Message | undefined;
            for (const q of candidates) {
                targetMsg = reversedUsers.find((m: Message) => m.content.includes(q))
                    || (q.length > 10 ? reversedUsers.find((m: Message) => m.content.includes(q.slice(0, 10))) : undefined);
                if (targetMsg) break;
            }
            // 兜底：精确匹配失败但角色明确想引用 → 取最近一条用户文字消息，避免空引用
            if (!targetMsg) targetMsg = users.filter((m: Message) => m.type === 'text' || !m.type).slice(-1)[0] || users.slice(-1)[0];
            if (!targetMsg) return undefined;
            return { id: targetMsg.id, content: buildReplySnapshotContent(targetMsg), name: userProfile.name };
        };

        // Quote/Reply 目标 (双语路径用)
        let aiReplyTarget: { id: number, content: string, name: string } | undefined;
        const firstQuoteMatch = rawContent.match(QUOTE_RE_DOUBLE) || rawContent.match(QUOTE_RE_SINGLE) || rawContent.match(REPLY_RE_CN) || rawContent.match(QUOTE_RE_NL);
        if (firstQuoteMatch) aiReplyTarget = resolveQuoteTarget(firstQuoteMatch[1]);

        let content = ChatParser.sanitize(rawContent, { keepCitations: true });
        content = content.replace(/\[\[INNER_STATE:\s*[\s\S]*?\]\]/g, '').trim();
        if (!content) return;

        const hasTranslationTags = /<翻译>\s*<原文>[\s\S]*?<\/原文>\s*<译文>[\s\S]*?<\/译文>\s*<\/翻译>/.test(content);
        let globalMsgIndex = 0;

        if (hasTranslationTags) {
            // ─── 双语 ───
            // 表情包按模型写的位置原地插发（sendEmojiBubble 见函数顶部）。旧实现先把所有
            // [[SEND_EMOJI:]] 抽走、正文发完后统一追加到最后（还去了重），表现为「翻译模式下
            // 角色永远最后才发表情包」。
            // 翻译标签之外的普通文本段：splitResponse 按出现顺序拆出文字 / 表情逐条发
            const renderPlainSegment = async (segment: string): Promise<void> => {
                for (const part of ChatParser.splitResponse(segment)) {
                    if (part.type === 'emoji') {
                        await sendEmojiBubble(part.content);
                        continue;
                    }
                    const cleaned = ChatParser.sanitize(part.content);
                    if (!cleaned || !ChatParser.hasDisplayContent(cleaned)) continue;
                    const chunks = ChatParser.chunkText(cleaned);
                    for (const chunk of chunks) {
                        if (!chunk) continue;
                        const replyData = globalMsgIndex === 0 ? aiReplyTarget : undefined;
                        await typingPause(Math.min(Math.max(chunk.length * 50, 500), 2000));
                        await persistMessage({ charId: char.id, role: 'assistant', type: 'text', content: chunk, replyTo: replyData, metadata: takeMeta(mcdInheritMeta, chunk) } as any);
                        setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                        globalMsgIndex++;
                    }
                }
            };
            const tagPattern = /<翻译>\s*<原文>([\s\S]*?)<\/原文>\s*<译文>([\s\S]*?)<\/译文>\s*<\/翻译>/g;
            let lastIndex = 0;
            let tagMatch;

            while ((tagMatch = tagPattern.exec(content)) !== null) {
                const textBefore = content.slice(lastIndex, tagMatch.index).trim();
                if (textBefore) await renderPlainSegment(textBefore);

                // 混进 <原文>/<译文> 里的表情标签剥出来，紧跟这条双语气泡之后发
                const inlineEmojis: string[] = [];
                const stripInlineEmoji = (s: string): string =>
                    s.replace(/\[\[SEND_EMOJI:\s*(.*?)\]\]/g, (_m, n) => { inlineEmojis.push(String(n).trim()); return ''; });
                const originalText = ChatParser.sanitize(stripInlineEmoji(tagMatch[1]).trim());
                const translatedText = ChatParser.sanitize(stripInlineEmoji(tagMatch[2]).trim());
                if (originalText || translatedText) {
                    const biContent = originalText && translatedText
                        ? `${originalText}\n%%BILINGUAL%%\n${translatedText}`
                        : (originalText || translatedText);
                    const replyData = globalMsgIndex === 0 ? aiReplyTarget : undefined;
                    await typingPause(Math.min(Math.max(biContent.length * 30, 400), 2000));
                    await persistMessage({ charId: char.id, role: 'assistant', type: 'text', content: biContent, replyTo: replyData, metadata: takeMeta(mcdInheritMeta, biContent) } as any);
                    setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                    globalMsgIndex++;
                }
                for (const name of inlineEmojis) await sendEmojiBubble(name);

                lastIndex = tagMatch.index + tagMatch[0].length;
            }

            const textAfter = content.slice(lastIndex).trim();
            if (textAfter) await renderPlainSegment(textAfter.replace(/<\/?翻译>|<\/?原文>|<\/?译文>/g, '').trim());
        } else {
            // ─── normal path (splitResponse → chunkText → per-chunk save) ───
            const parts = ChatParser.splitResponse(content);
            // 模型常把 [[QUOTE:]] 单独写一行 (后面紧跟换行或 [[SEND_EMOJI:]]), chunkText/splitResponse
            // 会把它拆成一个"只有标签没有正文"的 chunk — 剥标签后 hasDisplayContent 为 false 不落库,
            // 解析出的引用目标若不暂存就会随之丢失。挂到下一条真正落库的文字气泡上。
            let pendingReplyTarget: { id: number, content: string, name: string } | undefined;
            for (let partIndex = 0; partIndex < parts.length; partIndex++) {
                const part = parts[partIndex];

                if (part.type === 'emoji') {
                    await sendEmojiBubble(part.content);
                } else {
                    const rawBlocks = part.content.split(/^\s*---\s*$/m).filter(b => b.trim());
                    const allChunks: string[] = [];
                    for (const block of rawBlocks) {
                        allChunks.push(...ChatParser.chunkText(block.trim()));
                    }
                    if (allChunks.length === 0 && part.content.trim()) allChunks.push(part.content.trim());

                    for (let i = 0; i < allChunks.length; i++) {
                        let chunk = allChunks[i];
                        const delay = Math.min(Math.max(chunk.length * 50, 500), 2000);
                        await typingPause(delay);

                        let chunkReplyTarget: { id: number, content: string, name: string } | undefined;
                        const chunkQuoteMatch = chunk.match(QUOTE_RE_DOUBLE) || chunk.match(QUOTE_RE_SINGLE) || chunk.match(REPLY_RE_CN) || chunk.match(QUOTE_RE_NL);
                        if (chunkQuoteMatch) {
                            chunkReplyTarget = resolveQuoteTarget(chunkQuoteMatch[1]);
                            chunk = chunk.replace(QUOTE_CLEAN_DOUBLE, '').replace(QUOTE_CLEAN_SINGLE, '').replace(REPLY_CLEAN_CN, '').replace(QUOTE_CLEAN_NL, '').trim();
                        }

                        const replyData = chunkReplyTarget ?? pendingReplyTarget;

                        let chunkSaved = false;
                        if (ChatParser.hasDisplayContent(chunk)) {
                            const cleanChunk = ChatParser.sanitize(chunk);
                            if (cleanChunk) {
                                await persistMessage({ charId: char.id, role: 'assistant', type: 'text', content: cleanChunk, replyTo: replyData, metadata: takeMeta(mcdInheritMeta, cleanChunk) } as any);
                                setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                                globalMsgIndex++;
                                chunkSaved = true;
                            }
                        }
                        pendingReplyTarget = chunkSaved ? undefined : replyData;
                    }
                }
            }
        }
    };

    // 「执行功能前的本轮正文 A」: 在二轮重生开始前先把 A 渲染成气泡, 这样用户看到的顺序是
    // A 气泡 → "正在搜索/调阅…" 状态 → 二轮结果 B 气泡 (而不是等 B 回来才一起冒出来)。
    // XHS_*/READ_NOTE 标签 sanitize 不剥, 这里先剥掉; 其余 RECALL/SEARCH/DIARY... 由 renderAndPersist
    // 内 sanitize 统一清。A 的思考链取一轮 reasoning。
    const round1ThinkingChain = extractThinkingChain(initialData, pushReasoningContent);
    let leadInRendered = false;
    const renderLeadIn = async (raw: string): Promise<void> => {
        if (leadInRendered) return;
        leadInRendered = true;
        await renderAndPersist(
            raw.replace(/\[\[READ_NOTE:[\s\S]*?\]\]/g, '').replace(/\[\[XHS_[A-Z_]+(?::[\s\S]*?)?\]\]/g, ''),
            round1ThinkingChain,
        );
    };

    // ─── Step 2: 二轮 LLM 钩子 ───

    // 本轮回复里只要含"会触发二轮重生"的指令 (RECALL / SEARCH / READ_DIARY / FS_READ_DIARY /
    // READ_NOTE / XHS_SEARCH|BROWSE|MY_PROFILE|DETAIL), 就先把指令之外的本轮正文 A 落库展示。
    // 纯副作用 (XHS_SHARE/COMMENT/LIKE/FAV/POST、写日记) 不重生、不需要先展示, 故不在此列。
    // 之后各分支正常跑功能 + 二轮; 末尾再展示 B。若分支因未配置等原因没真正发起二轮 (data 不变),
    // 末尾会跳过重复渲染 (见下方收尾)。
    if (!skipSecondPassLLM) {
        const willRegenerate =
            /\[\[RECALL:\s*\d{4}[-/年]\d{1,2}\]\]/.test(aiContent)
            || /\[\[SEARCH:\s*.+?\]\]/.test(aiContent)
            || /\[\[READ_DIARY:\s*.+?\]\]/.test(aiContent)
            || /\[\[FS_READ_DIARY:\s*.+?\]\]/.test(aiContent)
            || /\[\[READ_NOTE:\s*.+?\]\]/.test(aiContent)
            || /\[\[XHS_SEARCH:\s*.+?\]\]/.test(aiContent)
            || /\[\[XHS_BROWSE(?::\s*.+?)?\]\]/.test(aiContent)
            || /\[\[XHS_MY_PROFILE\]\]/.test(aiContent)
            || /\[\[XHS_DETAIL:\s*.+?\]\]/.test(aiContent);
        if (willRegenerate) await renderLeadIn(aiContent);
    }

    // 5. Handle Recall (Loop if needed)
    const recallMatch = aiContent.match(/\[\[RECALL:\s*(\d{4})[-/年](\d{1,2})\]\]/);
    if (!skipSecondPassLLM && recallMatch) {
        const year = recallMatch[1];
        const month = recallMatch[2];
        // 模型常把 [[RECALL]] 指令和本轮正文 A 写在同一条回复里 (A 已在 Step 2 开头先行展示)。把 A
        // 作为 assistant 上文喂给二轮, 让二轮结果 B 接着 A 往下说, 更连贯。
        const recallLeadIn = aiContent.replace(/\[\[RECALL:\s*\d{4}[-/年]\d{1,2}\]\]/g, '').trim();
        const rr = await runRecall({ year, month }, agenticCtx);

        if (rr.ok && rr.alreadyActive) {
            console.log(`♻️ [Recall] ${rr.yearMonth} already in activeMemoryMonths, skipping duplicate recall`);
            aiContent = aiContent.replace(/\[\[RECALL:\s*\d{4}[-/年]\d{1,2}\]\]/g, '').trim();
        } else if (rr.ok && rr.logsText) {
            setRecallStatus(`正在调阅 ${year}年${month}月 的详细档案...`);
            const recallMessages = [...fullMessages, ...(recallLeadIn ? [{ role: 'assistant', content: recallLeadIn }] : []), { role: 'user', content: `[系统: 已成功调取 ${year}-${month} 的详细日志]\n${rr.logsText}\n[系统: 现在请结合这些细节回答用户。保持对话自然。]` }];
            try {
                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ model: effectiveApi.model, messages: recallMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                }, 2, 0, { ...apiLogMeta, purpose: '调阅记忆' });
                updateTokenUsage(data, historyMsgCount, 'recall');
                aiContent = data.choices?.[0]?.message?.content || '';
                aiContent = normalizeAiContent(aiContent);
                addToast(`已调用 ${year}-${month} 详细记忆`, 'info');
            } catch (recallErr: any) {
                console.error('Recall API failed:', recallErr.message);
            }
        } else {
            // !rr.ok && rr.reason === 'no_logs' — matches original "set status, no-op, clear" path
            setRecallStatus(`正在调阅 ${year}年${month}月 的详细档案...`);
        }
    }
    setRecallStatus('');

    // 5.5 Handle Active Search (主动搜索)
    const searchMatch = aiContent.match(/\[\[SEARCH:\s*(.+?)\]\]/);
    if (!skipSecondPassLLM && searchMatch) {
        const searchQuery = searchMatch[1].trim();
        console.log('🔍 [Search] AI触发搜索:', searchQuery);
        setSearchStatus(`正在搜索: ${searchQuery}...`);

        try {
            const sr = await runSearch({ query: searchQuery }, agenticCtx);
            console.log('🔍 [Search] 搜索结果:', sr);

            if (sr.ok) {
                console.log('🔍 [Search] 注入结果到AI，重新生成回复...');

                const cleanedForSearch = aiContent.replace(/\[\[SEARCH:.*?\]\]/g, '').trim() || '让我搜一下...';
                const searchMessages = [
                    ...fullMessages,
                    { role: 'assistant', content: cleanedForSearch },
                    { role: 'user', content: `[系统: 搜索完成！以下是关于"${searchQuery}"的搜索结果]\n\n${sr.resultsText}\n\n[系统: 现在请根据这些真实信息回复用户。用自然的语气分享，比如"我刚搜了一下发现..."、"诶我看到说..."。不要再输出[[SEARCH:...]]了。]` }
                ];

                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ model: effectiveApi.model, messages: searchMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                }, 2, 0, { ...apiLogMeta, purpose: '联网搜索' });
                updateTokenUsage(data, historyMsgCount, 'search');
                aiContent = data.choices?.[0]?.message?.content || '';
                console.log('🔍 [Search] AI基于搜索结果生成的新回复:', aiContent.slice(0, 100) + '...');
                aiContent = normalizeAiContent(aiContent);
                addToast(`🔍 搜索完成: ${searchQuery}`, 'success');
            } else if (sr.reason === 'no_api_key') {
                console.log('🔍 [Search] 检测到搜索意图但未配置API Key');
                aiContent = aiContent.replace(searchMatch[0], '').trim();
            } else {
                // sr.reason === 'no_results'
                console.log('🔍 [Search] 搜索失败或无结果:', sr.message);
                addToast(`搜索失败: ${sr.message}`, 'error');
                aiContent = aiContent.replace(searchMatch[0], '').trim();
            }
        } catch (e) {
            console.error('Search execution failed:', e);
            aiContent = aiContent.replace(searchMatch[0], '').trim();
        }
    } else if (searchMatch) {
        console.log('🔍 [Search] 检测到搜索意图但未配置API Key');
        aiContent = aiContent.replace(searchMatch[0], '').trim();
    }
    setSearchStatus('');

    aiContent = aiContent.replace(/\[\[SEARCH:.*?\]\]/g, '').trim();

    // 5.6 Handle Diary Writing (写日记到 Notion)
    const diaryStartMatch = aiContent.match(/\[\[DIARY_START:\s*(.+?)\]\]\n?([\s\S]*?)\[\[DIARY_END\]\]/);
    const diaryMatch = diaryStartMatch || aiContent.match(/\[\[DIARY:\s*(.+?)\]\]/s);

    if (diaryMatch && realtimeConfig?.notionEnabled && realtimeConfig?.notionApiKey && realtimeConfig?.notionDatabaseId) {
        let title = '';
        let content = '';
        let mood = '';

        if (diaryStartMatch) {
            const header = diaryStartMatch[1].trim();
            content = diaryStartMatch[2].trim();

            if (header.includes('|')) {
                const parts = header.split('|');
                title = parts[0].trim();
                mood = parts.slice(1).join('|').trim();
            } else {
                title = header;
            }
            console.log('📔 [Diary] AI写了一篇长日记:', title, '心情:', mood);
        } else {
            const diaryRaw = diaryMatch[1].trim();
            console.log('📔 [Diary] AI想写日记:', diaryRaw);

            if (diaryRaw.includes('|')) {
                const parts = diaryRaw.split('|');
                title = parts[0].trim();
                content = parts.slice(1).join('|').trim();
            } else {
                content = diaryRaw;
            }
        }

        if (!title) {
            const now = new Date();
            title = `${char.name}的日记 - ${now.getMonth() + 1}/${now.getDate()}`;
        }

        // 预写日志: 发请求前先把内容落进待写队列 (localStorage 同步落盘), 这样即使后续 fetch 失败 /
        // app 被杀, 内容也不丢. 前台可见才立即写 (本地路径 + 前台 instant, fetch 可靠); 后台时不发
        // 这个脆弱的请求 (易被冻结打断, 甚至服务端写成功但响应丢失 → 回前台重试会重复写), 直接留在
        // 队列, 等 drainPendingDiaries 在回前台时补打. 写成功就删掉这条.
        const pendingDiaryId = enqueuePendingDiary({ kind: 'notion', charId: char.id, charName: char.name, title, content, mood: mood || undefined });
        const canWriteDiaryNow = typeof document === 'undefined' || document.visibilityState === 'visible';
        if (canWriteDiaryNow) {
            try {
                const result = await NotionManager.createDiaryPage(
                    realtimeConfig.notionApiKey,
                    realtimeConfig.notionDatabaseId,
                    { title, content, mood: mood || undefined, characterName: char.name }
                );

                if (result.success) {
                    removePendingDiary(pendingDiaryId);
                    console.log('📔 [Diary] 写入成功:', result.url);
                    await persistMessage({
                        charId: char.id,
                        role: 'system',
                        type: 'text',
                        content: `📔 ${char.name}写了一篇日记「${title}」`
                    });
                    addToast(`📔 ${char.name}写了一篇日记!`, 'success');
                } else {
                    // API 明确拒绝 (配置/权限问题, 重试也没用) → 丢弃 + 报错.
                    removePendingDiary(pendingDiaryId);
                    console.error('📔 [Diary] 写入失败:', result.message);
                    addToast(`日记写入失败: ${result.message}`, 'error');
                }
            } catch (e) {
                // 网络异常 (可恢复). 保留待写队列, 回前台 drainPendingDiaries 补打.
                console.error('📔 [Diary] 写入异常, 留待回前台重试:', e);
            }
        } else {
            console.log('📔 [Diary] 当前后台, 已入队待写, 回前台补打');
        }

        aiContent = aiContent.replace(diaryMatch[0], '').trim();
    } else if (diaryMatch) {
        // 主动消息是提前几小时打包的，打包时日记服务还连着、送达前用户把它关掉是常态。
        // 角色那句「我去写日记了」已经说满，日记却静默蒸发——留一条系统提示说明为什么没写成。
        console.log('📔 [Diary] 检测到日记意图但未配置Notion');
        await persistMessage({
            charId: char.id,
            role: 'system',
            type: 'text',
            content: `📔 ${char.name}想写日记，但日记服务没连上（未配置或已断开），这篇没写成`,
        });
        aiContent = aiContent.replace(diaryMatch[0], '').trim();
    }

    aiContent = aiContent.replace(/\[\[DIARY:.*?\]\]/gs, '').trim();
    aiContent = aiContent.replace(/\[\[DIARY_START:.*?\]\][\s\S]*?\[\[DIARY_END\]\]/g, '').trim();

    // 5.7 Handle Read Diary (翻阅日记)
    const readDiaryMatch = aiContent.match(/\[\[READ_DIARY:\s*(.+?)\]\]/);

    const diaryFallbackCall = async (reason: string, tagPattern: RegExp) => {
        const cleaned = aiContent.replace(tagPattern, '').trim() || '让我翻翻日记...';
        const msgs = [
            ...fullMessages,
            { role: 'assistant', content: cleaned },
            { role: 'user', content: `[系统: ${reason}。请你：\n1. 先正常回应用户刚才说的话（用户还在等你回复！）\n2. 可以自然地提一下，比如"日记好像打不开诶"、"嗯...好像没找到"\n3. 继续正常聊天，用多条消息回复\n4. 严禁再输出[[READ_DIARY:...]]或[[FS_READ_DIARY:...]]标记]` }
        ];
        try {
            data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                method: 'POST', headers,
                body: JSON.stringify({ model: effectiveApi.model, messages: msgs, temperature: 0.8, max_tokens: 8000, stream: false })
            }, 2, 0, { ...apiLogMeta, purpose: '写日记' });
            updateTokenUsage(data, historyMsgCount, 'diary-fallback');
            aiContent = data.choices?.[0]?.message?.content || '';
            aiContent = normalizeAiContent(aiContent);
        } catch (fallbackErr) {
            console.error('📖 [Diary Fallback] 也失败了:', fallbackErr);
            aiContent = aiContent.replace(tagPattern, '').trim();
        }
    };

    const parseDiaryDate = (dateInput: string): string => {
        const now = new Date();
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) return dateInput;
        if (dateInput === '今天') return getLocalDateKey(now);
        if (dateInput === '昨天') { const d = new Date(now); d.setDate(d.getDate() - 1); return getLocalDateKey(d); }
        if (dateInput === '前天') { const d = new Date(now); d.setDate(d.getDate() - 2); return getLocalDateKey(d); }
        const daysAgo = dateInput.match(/^(\d+)天前$/);
        if (daysAgo) { const d = new Date(now); d.setDate(d.getDate() - parseInt(daysAgo[1])); return getLocalDateKey(d); }
        const monthDay = dateInput.match(/(\d{1,2})月(\d{1,2})/);
        if (monthDay) return `${now.getFullYear()}-${monthDay[1].padStart(2, '0')}-${monthDay[2].padStart(2, '0')}`;
        const parsed = new Date(dateInput);
        if (!isNaN(parsed.getTime())) return getLocalDateKey(parsed);
        return '';
    };

    if (!skipSecondPassLLM && readDiaryMatch) {
        const dateInput = readDiaryMatch[1].trim();
        console.log('📖 [ReadDiary] AI想翻阅日记:', dateInput);

        if (realtimeConfig?.notionEnabled && realtimeConfig?.notionApiKey && realtimeConfig?.notionDatabaseId) {
            const targetDate = parseDiaryDate(dateInput);

            if (targetDate) {
                try {
                    setDiaryStatus(`正在翻阅 ${targetDate} 的日记...`);

                    const rdr = await runReadDiary({ date: dateInput }, agenticCtx);

                    if (rdr.ok) {
                        // 注: "找到 N 篇日记，正在阅读..." 由 runReadDiary 内部 onProgress 触发
                        console.log('📖 [ReadDiary] 成功读取', rdr.entryCount, '篇日记');
                        setDiaryStatus('正在整理日记回忆...');

                        const cleanedForDiary = aiContent.replace(/\[\[READ_DIARY:.*?\]\]/g, '').trim() || '让我翻翻日记...';
                        const diaryMessages = [
                            ...fullMessages,
                            { role: 'assistant', content: cleanedForDiary },
                            { role: 'user', content: `[系统: 你翻开了自己 ${targetDate} 的日记，以下是你当时写的内容]\n\n${rdr.diaryText}\n\n[系统: 你已经看完了日记。现在请你：\n1. 先正常回应用户刚才说的话（这是最重要的！用户还在等你回复）\n2. 自然地把日记中的回忆融入你的回复中，比如"我想起来了那天..."、"看了日记才发现..."等\n3. 可以分享日记中有趣的细节，表达当时的情绪\n4. 用多条消息回复，别只说一句话就结束\n5. 严禁再输出[[READ_DIARY:...]]标记]` }
                        ];

                        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers,
                            body: JSON.stringify({ model: effectiveApi.model, messages: diaryMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                        }, 2, 0, { ...apiLogMeta, purpose: '翻阅日记' });
                        updateTokenUsage(data, historyMsgCount, 'read-diary-notion');
                        aiContent = data.choices?.[0]?.message?.content || '';
                        aiContent = normalizeAiContent(aiContent);
                        addToast(`📖 ${char.name}翻阅了${targetDate}的日记`, 'info');
                    } else if (rdr.reason === 'empty_content') {
                        console.log('📖 [ReadDiary] 日记内容为空');
                        await diaryFallbackCall('你翻开了日记本但页面是空白的', /\[\[READ_DIARY:.*?\]\]/g);
                    } else if (rdr.reason === 'unreachable') {
                        // 「查过了，那天没写」和「压根没查成」是两回事。传输就没跑通时说成
                        // 「那天没写日记」，等于替用户认下一件没发生的事，之后角色还会顺着这个
                        // 假前提聊下去。跟读取异常走同一条圆场路：只说没查成，不下结论。
                        console.log('📖 [ReadDiary] 日记服务连不上，这次没查成:', targetDate);
                        setDiaryStatus('日记服务连不上，继续对话...');
                        await diaryFallbackCall(
                            `你想翻 ${targetDate} 的日记，但日记服务连不上，这次没查成（不知道那天到底写没写）`,
                            /\[\[READ_DIARY:.*?\]\]/g,
                        );
                    } else {
                        // rdr.reason === 'not_found'  (parse_error / not_configured 被外层 if 拦住)
                        console.log('📖 [ReadDiary] 该日期没有日记:', targetDate);
                        setDiaryStatus(`${targetDate} 没有找到日记...`);
                        const cleanedForNoDiary = aiContent.replace(/\[\[READ_DIARY:.*?\]\]/g, '').trim() || '让我翻翻日记...';
                        const nodiaryMessages = [
                            ...fullMessages,
                            { role: 'assistant', content: cleanedForNoDiary },
                            { role: 'user', content: `[系统: 你翻了翻日记本，发现 ${targetDate} 那天没有写日记。请你：\n1. 先正常回应用户刚才说的话（用户还在等你回复！）\n2. 自然地提到没找到那天的日记，比如"嗯...那天好像没写日记"、"翻了翻没找到诶"\n3. 用多条消息回复，保持对话自然\n4. 严禁再输出[[READ_DIARY:...]]标记]` }
                        ];

                        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers,
                            body: JSON.stringify({ model: effectiveApi.model, messages: nodiaryMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                        }, 2, 0, { ...apiLogMeta, purpose: '翻阅日记' });
                        updateTokenUsage(data, historyMsgCount, 'no-diary-notion');
                        aiContent = data.choices?.[0]?.message?.content || '';
                        aiContent = normalizeAiContent(aiContent);
                    }
                } catch (e) {
                    console.error('📖 [ReadDiary] 读取异常:', e);
                    setDiaryStatus('日记读取失败，继续对话...');
                    await diaryFallbackCall('你想翻阅日记但读取出了问题（可能是网络问题）', /\[\[READ_DIARY:.*?\]\]/g);
                }
            } else {
                console.log('📖 [ReadDiary] 无法解析日期:', dateInput);
                await diaryFallbackCall(`你想翻阅日记但没能理解要找哪天的（"${dateInput}"）`, /\[\[READ_DIARY:.*?\]\]/g);
            }
        } else {
            console.log('📖 [ReadDiary] 检测到读日记意图但未配置Notion');
            await diaryFallbackCall('你想翻阅日记但日记本暂时不可用', /\[\[READ_DIARY:.*?\]\]/g);
        }
        setDiaryStatus('');
    }

    aiContent = aiContent.replace(/\[\[READ_DIARY:.*?\]\]/g, '').trim();

    // 5.8 Handle Feishu Diary Writing
    const fsDiaryStartMatch = aiContent.match(/\[\[FS_DIARY_START:\s*(.+?)\]\]\n?([\s\S]*?)\[\[FS_DIARY_END\]\]/);
    const fsDiaryMatch = fsDiaryStartMatch || aiContent.match(/\[\[FS_DIARY:\s*(.+?)\]\]/s);

    if (fsDiaryMatch && realtimeConfig?.feishuEnabled && realtimeConfig?.feishuAppId && realtimeConfig?.feishuAppSecret && realtimeConfig?.feishuBaseId && realtimeConfig?.feishuTableId) {
        let fsTitle = '';
        let fsContent = '';
        let fsMood = '';

        if (fsDiaryStartMatch) {
            const header = fsDiaryStartMatch[1].trim();
            fsContent = fsDiaryStartMatch[2].trim();
            if (header.includes('|')) {
                const parts = header.split('|');
                fsTitle = parts[0].trim();
                fsMood = parts.slice(1).join('|').trim();
            } else {
                fsTitle = header;
            }
            console.log('📒 [Feishu] AI写了一篇长日记:', fsTitle, '心情:', fsMood);
        } else {
            const diaryRaw = fsDiaryMatch[1].trim();
            console.log('📒 [Feishu] AI想写日记:', diaryRaw);
            if (diaryRaw.includes('|')) {
                const parts = diaryRaw.split('|');
                fsTitle = parts[0].trim();
                fsContent = parts.slice(1).join('|').trim();
            } else {
                fsContent = diaryRaw;
            }
        }

        if (!fsTitle) {
            const now = new Date();
            fsTitle = `${char.name}的日记 - ${now.getMonth() + 1}/${now.getDate()}`;
        }

        // 预写日志 + 可见性判断, 同 Notion.
        const pendingFsDiaryId = enqueuePendingDiary({ kind: 'feishu', charId: char.id, charName: char.name, title: fsTitle, content: fsContent, mood: fsMood || undefined });
        const canWriteFsDiaryNow = typeof document === 'undefined' || document.visibilityState === 'visible';
        if (canWriteFsDiaryNow) {
            try {
                const result = await FeishuManager.createDiaryRecord(
                    realtimeConfig.feishuAppId,
                    realtimeConfig.feishuAppSecret,
                    realtimeConfig.feishuBaseId,
                    realtimeConfig.feishuTableId,
                    { title: fsTitle, content: fsContent, mood: fsMood || undefined, characterName: char.name }
                );

                if (result.success) {
                    removePendingDiary(pendingFsDiaryId);
                    console.log('📒 [Feishu] 写入成功:', result.recordId);
                    await persistMessage({
                        charId: char.id,
                        role: 'system',
                        type: 'text',
                        content: `📒 ${char.name}写了一篇日记「${fsTitle}」(飞书)`
                    });
                    addToast(`📒 ${char.name}写了一篇日记! (飞书)`, 'success');
                } else {
                    removePendingDiary(pendingFsDiaryId);
                    console.error('📒 [Feishu] 写入失败:', result.message);
                    addToast(`飞书日记写入失败: ${result.message}`, 'error');
                }
            } catch (e) {
                // 网络异常: 保留待写队列, 回前台 drainPendingDiaries 补打.
                console.error('📒 [Feishu] 写入异常, 留待回前台重试:', e);
            }
        } else {
            console.log('📒 [Feishu] 当前后台, 已入队待写, 回前台补打');
        }

        aiContent = aiContent.replace(fsDiaryMatch[0], '').trim();
    } else if (fsDiaryMatch) {
        // 同 Notion：配置在打包之后被关掉时，别让这篇日记无声无息地消失。
        console.log('📒 [Feishu] 检测到日记意图但未配置飞书');
        await persistMessage({
            charId: char.id,
            role: 'system',
            type: 'text',
            content: `📒 ${char.name}想写日记，但日记服务没连上（未配置或已断开），这篇没写成`,
        });
        aiContent = aiContent.replace(fsDiaryMatch[0], '').trim();
    }

    aiContent = aiContent.replace(/\[\[FS_DIARY:.*?\]\]/gs, '').trim();
    aiContent = aiContent.replace(/\[\[FS_DIARY_START:.*?\]\][\s\S]*?\[\[FS_DIARY_END\]\]/g, '').trim();

    // 5.9 Handle Feishu Read Diary
    const fsReadDiaryMatch = aiContent.match(/\[\[FS_READ_DIARY:\s*(.+?)\]\]/);
    if (!skipSecondPassLLM && fsReadDiaryMatch) {
        const dateInput = fsReadDiaryMatch[1].trim();
        console.log('📖 [Feishu ReadDiary] AI想翻阅飞书日记:', dateInput);

        if (realtimeConfig?.feishuEnabled && realtimeConfig?.feishuAppId && realtimeConfig?.feishuAppSecret && realtimeConfig?.feishuBaseId && realtimeConfig?.feishuTableId) {
            const targetDate = parseDiaryDate(dateInput);

            if (targetDate) {
                try {
                    setDiaryStatus(`正在翻阅 ${targetDate} 的飞书日记...`);

                    const fsrdr = await runFsReadDiary({ date: dateInput }, agenticCtx);

                    if (fsrdr.ok) {
                        // 注: "找到 N 篇飞书日记，正在阅读..." 由 runFsReadDiary 内部 onProgress 触发
                        console.log('📖 [Feishu ReadDiary] 成功读取', fsrdr.entryCount, '篇日记');
                        setDiaryStatus('正在整理日记回忆...');

                        const cleanedForFsDiary = aiContent.replace(/\[\[FS_READ_DIARY:.*?\]\]/g, '').trim() || '让我翻翻日记...';
                        const diaryMessages = [
                            ...fullMessages,
                            { role: 'assistant', content: cleanedForFsDiary },
                            { role: 'user', content: `[系统: 你翻开了自己 ${targetDate} 的日记（飞书），以下是你当时写的内容]\n\n${fsrdr.diaryText}\n\n[系统: 你已经看完了日记。现在请你：\n1. 先正常回应用户刚才说的话（这是最重要的！用户还在等你回复）\n2. 自然地把日记中的回忆融入你的回复中，比如"我想起来了那天..."、"看了日记才发现..."等\n3. 可以分享日记中有趣的细节，表达当时的情绪\n4. 用多条消息回复，别只说一句话就结束\n5. 严禁再输出[[FS_READ_DIARY:...]]标记]` }
                        ];

                        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers,
                            body: JSON.stringify({ model: effectiveApi.model, messages: diaryMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                        }, 2, 0, { ...apiLogMeta, purpose: '翻阅日记' });
                        updateTokenUsage(data, historyMsgCount, 'read-diary-feishu');
                        aiContent = data.choices?.[0]?.message?.content || '';
                        aiContent = normalizeAiContent(aiContent);
                        addToast(`📖 ${char.name}翻阅了${targetDate}的飞书日记`, 'info');
                    } else if (fsrdr.reason === 'unreachable') {
                        // 同 Notion：没查成不等于那天没写，别把没跑成说成没写。
                        console.log('📖 [Feishu ReadDiary] 飞书连不上，这次没查成:', targetDate);
                        setDiaryStatus('飞书日记服务连不上，继续对话...');
                        await diaryFallbackCall(
                            `你想翻 ${targetDate} 的飞书日记，但飞书连不上，这次没查成（不知道那天到底写没写）`,
                            /\[\[FS_READ_DIARY:.*?\]\]/g,
                        );
                    } else {
                        // fsrdr.reason === 'not_found'
                        setDiaryStatus(`${targetDate} 没有找到飞书日记...`);
                        const cleanedForFsNoDiary = aiContent.replace(/\[\[FS_READ_DIARY:.*?\]\]/g, '').trim() || '让我翻翻日记...';
                        const nodiaryMessages = [
                            ...fullMessages,
                            { role: 'assistant', content: cleanedForFsNoDiary },
                            { role: 'user', content: `[系统: 你翻了翻飞书日记本，发现 ${targetDate} 那天没有写日记。请你：\n1. 先正常回应用户刚才说的话（用户还在等你回复！）\n2. 自然地提到没找到那天的日记，比如"嗯...那天好像没写日记"、"翻了翻没找到诶"\n3. 用多条消息回复，保持对话自然\n4. 严禁再输出[[FS_READ_DIARY:...]]标记]` }
                        ];

                        data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                            method: 'POST', headers,
                            body: JSON.stringify({ model: effectiveApi.model, messages: nodiaryMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                        }, 2, 0, { ...apiLogMeta, purpose: '翻阅日记' });
                        updateTokenUsage(data, historyMsgCount, 'no-diary-feishu');
                        aiContent = data.choices?.[0]?.message?.content || '';
                        aiContent = normalizeAiContent(aiContent);
                    }
                } catch (e) {
                    console.error('📖 [Feishu ReadDiary] 读取异常:', e);
                    setDiaryStatus('飞书日记读取失败，继续对话...');
                    await diaryFallbackCall('你想翻阅飞书日记但读取出了问题（可能是网络问题）', /\[\[FS_READ_DIARY:.*?\]\]/g);
                }
            } else {
                console.log('📖 [Feishu ReadDiary] 无法解析日期:', dateInput);
                await diaryFallbackCall(`你想翻阅飞书日记但没能理解要找哪天的（"${dateInput}"）`, /\[\[FS_READ_DIARY:.*?\]\]/g);
            }
        } else {
            console.log('📖 [Feishu ReadDiary] 检测到读日记意图但未配置飞书');
            await diaryFallbackCall('你想翻阅飞书日记但飞书暂时不可用', /\[\[FS_READ_DIARY:.*?\]\]/g);
        }
        setDiaryStatus('');
    }

    aiContent = aiContent.replace(/\[\[FS_READ_DIARY:.*?\]\]/g, '').trim();

    // 5.9b Handle Read User Note
    const readNoteMatch = aiContent.match(/\[\[READ_NOTE:\s*(.+?)\]\]/);
    if (!skipSecondPassLLM && readNoteMatch) {
        const keyword = readNoteMatch[1].trim();
        console.log('📝 [ReadNote] AI想翻阅用户笔记:', keyword);

        if (realtimeConfig?.notionEnabled && realtimeConfig?.notionApiKey && realtimeConfig?.notionNotesDatabaseId) {
            try {
                setDiaryStatus(`正在翻阅笔记: ${keyword}...`);

                const rnr = await runReadNote({ keyword }, agenticCtx);

                if (rnr.ok) {
                    // 注: "找到 N 篇笔记，正在阅读..." 由 runReadNote 内部 onProgress 触发
                    console.log('📝 [ReadNote] 成功读取', rnr.entryCount, '篇笔记');
                    setDiaryStatus('正在整理笔记内容...');

                    const cleanedForNote = aiContent.replace(/\[\[READ_NOTE:.*?\]\]/g, '').trim() || '让我看看...';
                    const noteMessages = [
                        ...fullMessages,
                        { role: 'assistant', content: cleanedForNote },
                        { role: 'user', content: `[系统: 你翻阅了${userProfile.name}的笔记，以下是内容:\n\n${rnr.noteText}\n\n请你：\n1. 先正常回应用户刚才说的话\n2. 自然地提到你看到的笔记内容，语气温馨，像不经意间看到的\n3. 可以对内容表示好奇、关心或共鸣\n4. 用多条消息回复，保持对话自然\n5. 严禁再输出[[READ_NOTE:...]]标记]` }
                    ];

                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers,
                        body: JSON.stringify({ model: effectiveApi.model, messages: noteMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                    }, 2, 0, { ...apiLogMeta, purpose: '翻阅笔记' });
                    updateTokenUsage(data, historyMsgCount, 'read-note');
                    aiContent = data.choices?.[0]?.message?.content || '';
                    aiContent = normalizeAiContent(aiContent);
                    addToast(`📝 ${char.name}翻阅了关于"${keyword}"的笔记`, 'info');
                } else if (rnr.reason === 'empty_content') {
                    console.log('📝 [ReadNote] 笔记内容为空');
                    await diaryFallbackCall('你翻阅了笔记但内容是空的', /\[\[READ_NOTE:.*?\]\]/g);
                } else if (rnr.reason === 'unreachable') {
                    // 同日记：没查成不等于没有这篇笔记。说成「没找到」，用户会以为自己没写过。
                    console.log('📝 [ReadNote] 笔记服务连不上，这次没查成:', keyword);
                    setDiaryStatus('笔记服务连不上，继续对话...');
                    await diaryFallbackCall(
                        `你想翻${userProfile.name}关于"${keyword}"的笔记，但笔记服务连不上，这次没查成（不知道到底有没有这篇）`,
                        /\[\[READ_NOTE:.*?\]\]/g,
                    );
                } else {
                    // rnr.reason === 'not_found'
                    console.log('📝 [ReadNote] 没有找到匹配的笔记:', keyword);
                    setDiaryStatus(`没有找到关于"${keyword}"的笔记...`);
                    const cleanedForNoNote = aiContent.replace(/\[\[READ_NOTE:.*?\]\]/g, '').trim() || '让我看看...';
                    const nonoteMessages = [
                        ...fullMessages,
                        { role: 'assistant', content: cleanedForNoNote },
                        { role: 'user', content: `[系统: 你想看${userProfile.name}关于"${keyword}"的笔记，但没有找到。请你：\n1. 先正常回应用户刚才说的话\n2. 可以自然地提一下，比如"嗯，好像没找到那篇笔记"\n3. 继续正常聊天\n4. 严禁再输出[[READ_NOTE:...]]标记]` }
                    ];

                    data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                        method: 'POST', headers,
                        body: JSON.stringify({ model: effectiveApi.model, messages: nonoteMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                    }, 2, 0, { ...apiLogMeta, purpose: '翻阅笔记' });
                    updateTokenUsage(data, historyMsgCount, 'read-note-empty');
                    aiContent = data.choices?.[0]?.message?.content || '';
                    aiContent = normalizeAiContent(aiContent);
                }
            } catch (e) {
                console.error('📝 [ReadNote] 读取异常:', e);
                setDiaryStatus('笔记读取失败，继续对话...');
                await diaryFallbackCall('你想翻阅笔记但读取出了问题（可能是网络问题）', /\[\[READ_NOTE:.*?\]\]/g);
            }
        } else {
            console.log('📝 [ReadNote] 检测到读笔记意图但未配置笔记数据库');
            await diaryFallbackCall('你想翻阅笔记但笔记功能暂时不可用', /\[\[READ_NOTE:.*?\]\]/g);
        }
        setDiaryStatus('');
    }

    aiContent = aiContent.replace(/\[\[READ_NOTE:.*?\]\]/g, '').trim();

    // 5.10 Handle XHS (小红书) Actions
    const xhsConf = resolveXhsConfig(char, realtimeConfig);

    // [[XHS_SEARCH: 关键词]]
    const xhsSearchMatch = aiContent.match(/\[\[XHS_SEARCH:\s*(.+?)\]\]/);
    if (!skipSecondPassLLM && xhsSearchMatch && xhsConf.enabled) {
        const keyword = xhsSearchMatch[1].trim();
        console.log(`📕 [XHS] AI想搜索小红书:`, keyword);
        setXhsStatus(`正在小红书搜索: ${keyword}...`);

        try {
            const xsr = await runXhsSearch({ keyword }, agenticCtx);
            if (xsr.ok) {
                const cleanedForXhs = aiContent.replace(/\[\[XHS_SEARCH:.*?\]\]/g, '').trim() || '让我去小红书看看...';
                const xhsMessages = [
                    ...fullMessages,
                    { role: 'assistant', content: cleanedForXhs },
                    { role: 'user', content: `[系统: 你在小红书搜索了"${keyword}"，以下是搜索结果]\n\n${xsr.notesText}\n\n[系统: 你已经看完了搜索结果（注意：以上只是摘要，想看某条笔记的完整正文可以用 [[XHS_DETAIL: noteId]]）。现在请你：\n1. 自然地分享你看到的内容，比如"我刚在小红书搜了一下..."、"诶小红书上有人说..."\n2. 可以评价、吐槽、分享感兴趣的内容\n3. 如果觉得某条笔记特别值得分享，可以用 [[XHS_SHARE: 序号]] 把它作为卡片分享给用户（序号从1开始），可以分享多条；不要手写“[你分享了小红书笔记]”及标题/作者/互动/简介，分享卡片必须使用该标记\n4. 如果想评论某条笔记，可以用 [[XHS_COMMENT: noteId | 评论内容]]\n5. 如果喜欢某条笔记，可以用 [[XHS_LIKE: noteId]] 点赞，[[XHS_FAV: noteId]] 收藏\n6. 如果想看某条笔记的完整内容和评论区，可以用 [[XHS_DETAIL: noteId]]\n7. 严禁再输出[[XHS_SEARCH:...]]标记]` }
                ];

                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ model: effectiveApi.model, messages: xhsMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                }, 2, 0, { ...apiLogMeta, purpose: '小红书搜索' });
                updateTokenUsage(data, historyMsgCount, 'xhs-search');
                aiContent = data.choices?.[0]?.message?.content || '';
                aiContent = normalizeAiContent(aiContent);
                await persistMessage({
                    charId: char.id,
                    role: 'system',
                    type: 'text',
                    content: `📕 ${char.name}在小红书搜索了「${keyword}」，看了 ${xsr.notes.length} 条笔记`
                });
                addToast(`📕 ${char.name}搜索了小红书: ${keyword}`, 'info');
            } else {
                // xsr.reason === 'no_results' (not_enabled 已被外层 if 排除)
                console.log('📕 [XHS] 搜索无结果:', xsr.message);
                aiContent = aiContent.replace(xhsSearchMatch[0], '').trim();
            }
        } catch (e) {
            console.error('📕 [XHS] 搜索异常:', e);
            aiContent = aiContent.replace(xhsSearchMatch[0], '').trim();
        }
        setXhsStatus('');
    } else if (!skipSecondPassLLM && xhsSearchMatch) {
        aiContent = aiContent.replace(xhsSearchMatch[0], '').trim();
    }
    aiContent = aiContent.replace(/\[\[XHS_SEARCH:.*?\]\]/g, '').trim();

    // [[XHS_BROWSE]] or [[XHS_BROWSE: 分类]]
    const xhsBrowseMatch = aiContent.match(/\[\[XHS_BROWSE(?::\s*(.+?))?\]\]/);
    if (!skipSecondPassLLM && xhsBrowseMatch && xhsConf.enabled) {
        const category = xhsBrowseMatch[1]?.trim();
        console.log(`📕 [XHS] AI想刷小红书:`, category || '首页推荐');
        setXhsStatus('正在刷小红书...');

        try {
            const xbr = await runXhsBrowse({ category }, agenticCtx);
            if (xbr.ok) {
                const cleanedForXhs = aiContent.replace(/\[\[XHS_BROWSE(?::.*?)?\]\]/g, '').trim() || '让我刷刷小红书...';
                const xhsMessages = [
                    ...fullMessages,
                    { role: 'assistant', content: cleanedForXhs },
                    { role: 'user', content: `[系统: 你刷了一会儿小红书首页，以下是你看到的内容]\n\n${xbr.notesText}\n\n[系统: 你已经看完了（注意：以上只是摘要，想看某条笔记的完整正文可以用 [[XHS_DETAIL: noteId]]）。现在请你：\n1. 像在跟朋友分享一样，随意聊聊你看到了什么有趣的\n2. 不用全部都提，挑你感兴趣的1-3条聊就行\n3. 可以吐槽、感叹、分享想法\n4. 如果觉得某条笔记特别值得分享，可以用 [[XHS_SHARE: 序号]] 把它作为卡片分享给用户（序号从1开始），可以分享多条；不要手写“[你分享了小红书笔记]”及标题/作者/互动/简介，分享卡片必须使用该标记\n5. 如果想发一条自己的笔记，可以用 [[XHS_POST: 标题 | 内容 | #标签1 #标签2]]\n6. 如果喜欢某条笔记，可以用 [[XHS_LIKE: noteId]] 点赞，[[XHS_FAV: noteId]] 收藏\n7. 如果想看某条笔记的完整内容和评论区，可以用 [[XHS_DETAIL: noteId]]\n8. 严禁再输出[[XHS_BROWSE]]标记]` }
                ];

                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ model: effectiveApi.model, messages: xhsMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                }, 2, 0, { ...apiLogMeta, purpose: '小红书浏览' });
                updateTokenUsage(data, historyMsgCount, 'xhs-browse');
                aiContent = data.choices?.[0]?.message?.content || '';
                aiContent = normalizeAiContent(aiContent);
                addToast(`📕 ${char.name}刷了会儿小红书`, 'info');
            } else {
                // xbr.reason === 'no_results' (not_enabled 已被外层 if 排除)
                aiContent = aiContent.replace(xhsBrowseMatch[0], '').trim();
            }
        } catch (e) {
            console.error('📕 [XHS] 浏览异常:', e);
            aiContent = aiContent.replace(xhsBrowseMatch[0], '').trim();
        }
        setXhsStatus('');
    } else if (!skipSecondPassLLM && xhsBrowseMatch) {
        aiContent = aiContent.replace(xhsBrowseMatch[0], '').trim();
    }
    aiContent = aiContent.replace(/\[\[XHS_BROWSE(?::.*?)?\]\]/g, '').trim();

    // Search/browse can replace aiContent with a second-pass LLM response, so scan that result too.
    const secondPassMimickedXhsShares = extractMimickedXhsShares(aiContent);
    aiContent = secondPassMimickedXhsShares.cleanedContent;
    mimickedXhsShares.shares.push(...secondPassMimickedXhsShares.shares);

    // [[XHS_SHARE: 序号]]
    const sharedXhsCardKeys = new Set<string>();
    const xhsShareMatches: Iterable<RegExpMatchArray> = disabledXhsSideEffects ? [] : aiContent.matchAll(/\[\[XHS_SHARE:\s*(\d+)\]\]/g);
    for (const shareMatch of xhsShareMatches) {
        const idx = parseInt(shareMatch[1]) - 1;
        // 注意 truthy 判空: amsg2 push 带回的笔记数组是稀疏重建的 (只有 directive 引用到的
        // 序号有值, 空洞是 null, 见 activeMsgRuntime 的 xhsSession 落库), 越界和空洞同罪.
        const note = idx >= 0 && idx < lastXhsNotesRef.current.length ? lastXhsNotesRef.current[idx] : undefined;
        if (note) {
            sharedXhsCardKeys.add(normalizeXhsCardKey(note.title));
            console.log('📕 [XHS] AI分享笔记卡片:', note.title);
            await persistMessage({
                charId: char.id,
                role: 'assistant',
                type: 'xhs_card',
                content: note.title || '小红书笔记',
                // 跟正文气泡带同一个标记 (mcdInheritMeta): 主动消息重试时靠它认出"这张卡上一趟已经发过了"
                metadata: { xhsNote: note, ...(mcdInheritMeta || {}) }
            });
            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
        } else {
            // 笔记缓冲为空 / 越界 → 卡片发不出来. instant 路径靠 saveXhsSessionNotes 持久化恢复,
            // 走到这里说明恢复也没命中 (TTL 过期 / 跨 session), 留日志便于排查, 不再静默吞掉.
            console.warn('📕 [XHS] XHS_SHARE 序号越界, 跳过卡片', { idx: idx + 1, available: lastXhsNotesRef.current.length });
        }
    }
    aiContent = aiContent.replace(/\[\[XHS_SHARE:\s*\d+\]\]/g, '').trim();

    // 掉格式兜底：把模型模仿历史记录写出的五行纯文本恢复成真正的 xhs_card。
    // 优先复用刚才 search/browse 缓存里的完整 noteId、封面和 xsecToken；缓存丢失时仍给可读卡片。
    for (const parsed of mimickedXhsShares.shares) {
        const parsedKey = normalizeXhsCardKey(parsed.title);
        if (parsedKey && sharedXhsCardKeys.has(parsedKey)) continue;
        const sameTitle = lastXhsNotesRef.current.filter(note => normalizeXhsCardKey(note.title) === parsedKey);
        const parsedAuthorKey = normalizeXhsCardKey(parsed.author);
        const cachedNote = sameTitle.find(note => normalizeXhsCardKey(note.author) === parsedAuthorKey) || sameTitle[0];
        const parsedNote: XhsNote = {
            noteId: '',
            title: parsed.title || '小红书笔记',
            desc: parsed.desc,
            likes: parseMimickedXhsCount(parsed.interactionText, '赞'),
            collects: parseMimickedXhsCount(parsed.interactionText, '收藏'),
            commentCount: parseMimickedXhsCount(parsed.interactionText, '评论'),
            shareCount: parseMimickedXhsCount(parsed.interactionText, '分享'),
            author: parsed.author,
            authorId: '',
        };
        const note: XhsNote = cachedNote ? {
            ...parsedNote,
            ...cachedNote,
            title: cachedNote.title || parsedNote.title,
            desc: cachedNote.desc || parsedNote.desc,
            author: cachedNote.author || parsedNote.author,
            likes: cachedNote.likes ?? parsedNote.likes,
            collects: cachedNote.collects ?? parsedNote.collects,
            commentCount: cachedNote.commentCount ?? parsedNote.commentCount,
            shareCount: cachedNote.shareCount ?? parsedNote.shareCount,
        } : parsedNote;
        console.warn('📕 [XHS] 检测到仿卡片文本，已恢复为 xhs_card:', note.title, cachedNote ? '(命中缓存)' : '(文本兜底)');
        await persistMessage({
            charId: char.id,
            role: 'assistant',
            type: 'xhs_card',
            content: note.title || '小红书笔记',
            metadata: { xhsNote: note, ...(mcdInheritMeta || {}) },
        });
        if (parsedKey) sharedXhsCardKeys.add(parsedKey);
    }
    if (mimickedXhsShares.shares.length > 0) {
        setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
    }
    // [[XHS_POST: 标题 | 内容 | #标签1 #标签2]]
    const xhsPostMatch = aiContent.match(/\[\[XHS_POST:\s*(.+?)\]\]/s);
    if (!disabledXhsSideEffects && xhsPostMatch && xhsConf.enabled) {
        const postRaw = xhsPostMatch[1].trim();
        const parts = postRaw.split('|').map(p => p.trim());
        const postTitle = parts[0] || '';
        const postContent = parts[1] || '';
        const postTags = (parts[2] || '').match(/#(\S+)/g)?.map(t => t.replace('#', '')) || [];

        console.log(`📕 [XHS] AI要发小红书:`, postTitle);
        setXhsStatus(`正在发布小红书: ${postTitle}...`);

        try {
            const result = await xhsPublish(xhsConf, char, postTitle, postContent, postTags);
            if (result.success) {
                console.log('📕 [XHS] 发布成功:', result.noteId);
                const tagsStr = postTags.length > 0 ? ` #${postTags.join(' #')}` : '';
                await persistMessage({
                    charId: char.id,
                    role: 'system',
                    type: 'text',
                    content: `📕 ${char.name}发了一条小红书「${postTitle}」\n${postContent.slice(0, 200)}${postContent.length > 200 ? '...' : ''}${tagsStr}`
                });
                addToast(`📕 ${char.name}发了一条小红书!`, 'success');
            } else {
                console.error('📕 [XHS] 发布失败:', result.message);
                addToast(`小红书发布失败: ${result.message}`, 'error');
            }
        } catch (e) {
            console.error('📕 [XHS] 发布异常:', e);
        }
        aiContent = aiContent.replace(xhsPostMatch[0], '').trim();
        setXhsStatus('');
    } else if (!disabledXhsSideEffects && xhsPostMatch) {
        aiContent = aiContent.replace(xhsPostMatch[0], '').trim();
    }
    aiContent = aiContent.replace(/\[\[XHS_POST:.*?\]\]/gs, '').trim();

    // [[XHS_COMMENT: noteId | 评论内容]]
    const xhsCommentMatch = aiContent.match(/\[\[XHS_COMMENT:\s*(.+?)\]\]/);
    if (!disabledXhsSideEffects && xhsCommentMatch && xhsConf.enabled) {
        const commentRaw = xhsCommentMatch[1].trim();
        const sepIdx = commentRaw.indexOf('|');
        if (sepIdx > 0) {
            const noteId = commentRaw.slice(0, sepIdx).trim();
            const commentContent = commentRaw.slice(sepIdx + 1).trim();
            const xsecToken = findXsecToken(noteId, lastXhsNotesRef.current);
            console.log(`📕 [XHS] AI要评论笔记:`, noteId, commentContent.slice(0, 30), xsecToken ? '(有xsecToken)' : '(无xsecToken)');
            setXhsStatus('正在评论...');

            try {
                const result = await xhsComment(xhsConf, noteId, commentContent, xsecToken);
                if (result.success) {
                    await persistMessage({
                        charId: char.id,
                        role: 'system',
                        type: 'text',
                        content: `📕 ${char.name}在小红书评论了: "${commentContent.slice(0, 100)}${commentContent.length > 100 ? '...' : ''}"`
                    });
                    addToast(`📕 ${char.name}在小红书留了评论`, 'success');
                } else {
                    addToast(`评论失败: ${result.message}`, 'error');
                }
            } catch (e) {
                console.error('📕 [XHS] 评论异常:', e);
            }
        }
        aiContent = aiContent.replace(xhsCommentMatch[0], '').trim();
        setXhsStatus('');
    } else if (!disabledXhsSideEffects && xhsCommentMatch) {
        aiContent = aiContent.replace(xhsCommentMatch[0], '').trim();
    }
    aiContent = aiContent.replace(/\[\[XHS_COMMENT:.*?\]\]/g, '').trim();

    // [[XHS_REPLY: noteId | commentId | 回复内容]] (first pass; before LIKE/FAV)
    const xhsReplyMatch = aiContent.match(/\[\[XHS_REPLY:\s*(.+?)\]\]/);
    if (!disabledXhsSideEffects && xhsReplyMatch && xhsConf.enabled) {
        const parts = xhsReplyMatch[1].split('|').map(s => s.trim());
        if (parts.length >= 3) {
            const [noteId, commentId, ...replyParts] = parts;
            const replyContent = replyParts.join('|').trim();
            const xsecToken = findXsecToken(noteId, lastXhsNotesRef.current);
            const commentUserId = commentUserIdCacheRef.get(commentId);
            const commentAuthorName = commentAuthorNameCacheRef.get(commentId);
            const parentCommentId = commentParentIdCacheRef.get(commentId);
            if (replyContent) {
                console.log(`📕 [XHS] AI要回复评论:`, noteId, commentId, replyContent.slice(0, 30),
                    xsecToken ? '(有xsecToken)' : '(bridge自动获取)',
                    commentUserId ? `(userId=${commentUserId})` : '(无userId)',
                    commentAuthorName ? `(author=${commentAuthorName})` : '',
                    parentCommentId ? `(parentId=${parentCommentId})` : '(顶级评论)');
                setXhsStatus('正在回复评论...');
                try {
                    let result = await xhsReplyComment(xhsConf, noteId, xsecToken || '', replyContent, commentId, commentUserId, parentCommentId);
                    const selectorBroken = !result.success && result.message?.includes('未找到评论');
                    if (selectorBroken) {
                        console.warn(`📕 [XHS] 回复失败(DOM选择器不匹配)，跳过重试直接降级:`, result.message);
                    } else {
                        const replyRetries = [3000, 4000, 5000];
                        for (let i = 0; i < replyRetries.length && !result.success; i++) {
                            console.warn(`📕 [XHS] 回复失败(${i + 1}/${replyRetries.length})，${replyRetries[i] / 1000}秒后重试:`, result.message);
                            await new Promise(r => setTimeout(r, replyRetries[i]));
                            result = await xhsReplyComment(xhsConf, noteId, xsecToken || '', replyContent, commentId, commentUserId, parentCommentId);
                        }
                    }
                    if (result.success) {
                        addToast(`📕 ${char.name}回复了一条评论`, 'success');
                    } else {
                        console.warn(`📕 [XHS] 回复失败，降级为 @提及 评论:`, result.message);
                        const fallbackContent = commentAuthorName
                            ? `@${commentAuthorName} ${replyContent}`
                            : replyContent;
                        let fallback = await xhsComment(xhsConf, noteId, fallbackContent, xsecToken);
                        if (!fallback.success) {
                            console.warn(`📕 [XHS] 顶级评论也失败，3秒后重试:`, fallback.message);
                            await new Promise(r => setTimeout(r, 3000));
                            fallback = await xhsComment(xhsConf, noteId, fallbackContent, xsecToken);
                        }
                        if (fallback.success) {
                            addToast(`📕 ${char.name}评论了一条笔记（@提及回复）`, 'success');
                        } else {
                            addToast(`回复失败: ${result.message}`, 'error');
                        }
                    }
                } catch (e) { console.error('📕 [XHS] 回复异常:', e); }
                setXhsStatus('');
            } else {
                console.warn('📕 [XHS] 回复缺少 xsecToken 或内容');
            }
        }
        aiContent = aiContent.replace(xhsReplyMatch[0], '').trim();
    } else if (!disabledXhsSideEffects && xhsReplyMatch) {
        aiContent = aiContent.replace(xhsReplyMatch[0], '').trim();
    }
    aiContent = aiContent.replace(/\[\[XHS_REPLY:.*?\]\]/g, '').trim();

    // [[XHS_LIKE: noteId]]
    const xhsLikeMatches: Iterable<RegExpMatchArray> = disabledXhsSideEffects ? [] : aiContent.matchAll(/\[\[XHS_LIKE:\s*(.+?)\]\]/g);
    for (const xhsLikeMatch of xhsLikeMatches) {
        if (xhsConf.enabled) {
            const noteId = xhsLikeMatch[1].trim();
            const xsecToken = findXsecToken(noteId, lastXhsNotesRef.current);
            console.log(`📕 [XHS] AI要点赞笔记:`, noteId, xsecToken ? '(有xsecToken)' : '(bridge自动获取)');
            try {
                const result = await xhsLike(xhsConf, noteId, xsecToken || '');
                if (result.success) {
                    addToast(`📕 ${char.name}点赞了一条笔记`, 'success');
                } else {
                    console.warn('📕 [XHS] 点赞失败:', result.message);
                }
            } catch (e) { console.error('📕 [XHS] 点赞异常:', e); }
        }
    }
    aiContent = aiContent.replace(/\[\[XHS_LIKE:.*?\]\]/g, '').trim();

    // [[XHS_FAV: noteId]]
    const xhsFavMatches: Iterable<RegExpMatchArray> = disabledXhsSideEffects ? [] : aiContent.matchAll(/\[\[XHS_FAV:\s*(.+?)\]\]/g);
    for (const xhsFavMatch of xhsFavMatches) {
        if (xhsConf.enabled) {
            const noteId = xhsFavMatch[1].trim();
            const xsecToken = findXsecToken(noteId, lastXhsNotesRef.current);
            console.log(`📕 [XHS] AI要收藏笔记:`, noteId, xsecToken ? '(有xsecToken)' : '(bridge自动获取)');
            try {
                const result = await xhsFavorite(xhsConf, noteId, xsecToken || '');
                if (result.success) {
                    addToast(`📕 ${char.name}收藏了一条笔记`, 'success');
                } else {
                    console.warn('📕 [XHS] 收藏失败:', result.message);
                }
            } catch (e) { console.error('📕 [XHS] 收藏异常:', e); }
        }
    }
    aiContent = aiContent.replace(/\[\[XHS_FAV:.*?\]\]/g, '').trim();

    // [[XHS_MY_PROFILE]]
    const xhsProfileMatch = aiContent.match(/\[\[XHS_MY_PROFILE\]\]/);
    if (!skipSecondPassLLM && xhsProfileMatch && xhsConf.enabled) {
        console.log(`📕 [XHS] AI要查看自己的主页`);
        setXhsStatus('正在查看小红书主页...');

        try {
            let xmpr: Awaited<ReturnType<typeof runXhsMyProfile>>;
            try {
                const ownedPosts = await DB.getXhsOwnedPosts(char.id);
                const latestUserMessage = [...fullMessages].reverse().find(message => message?.role === 'user');
                const latestUserText = typeof latestUserMessage?.content === 'string'
                    ? latestUserMessage.content
                    : Array.isArray(latestUserMessage?.content)
                        ? latestUserMessage.content.map((part: any) => part?.text || '').join('\n')
                        : '';
                const selectedPosts = selectOwnedPostsForReference(ownedPosts, latestUserText, 8);
                const localNotes = selectedPosts.map(post => ownedPostToNote(post, char.name) as XhsNote);
                for (const note of localNotes) {
                    if (note.xsecToken) xsecTokenCacheRef.set(note.noteId, note.xsecToken);
                    if (note.title) ctx.xhsCaches.noteTitleCache.set(note.noteId, note.title);
                }
                if (localNotes.length > 0) lastXhsNotesRef.current = localNotes;
                const feedsStr = selectedPosts.length > 0
                    ? selectedPosts.map((post, index) => {
                        const published = new Date(post.publishedAt).toLocaleString();
                        return `${index + 1}. [noteId=${post.noteId}]「${post.title || '无标题'}」· 发布于 ${published} (${post.likes || 0}赞 ${post.commentCount || 0}评论)\n   ${post.body || '（无正文）'}`;
                    }).join('\n\n')
                    : '（这个角色的主页还没有已归属的笔记）';
                xmpr = {
                    ok: true,
                    nickname: char.name,
                    userId: '',
                    profileStr: `角色独立主页：共 ${ownedPosts.length} 条笔记。真实账号可能与其他角色共用。`,
                    feedsStr,
                    gotProfile: true,
                    notes: localNotes,
                };
            } catch (localProfileError) {
                console.warn('[XHS] 角色主页读取失败，回退到真实账号主页:', localProfileError);
                xmpr = await runXhsMyProfile({}, agenticCtx);
            }

            if (xmpr.ok) {
                const { nickname, userId, profileStr, feedsStr, gotProfile } = xmpr;

                const profileSection = gotProfile
                    ? `\n\n你的主页信息:\n${profileStr}`
                    : '';

                const cleanedForXhs = aiContent.replace(/\[\[XHS_MY_PROFILE\]\]/g, '').trim() || '让我看看我的小红书...';
                const xhsMessages = [
                    ...fullMessages,
                    { role: 'assistant', content: cleanedForXhs },
                    { role: 'user', content: `[系统: 你打开了自己的小红书]\n\n你的小红书账号昵称: ${nickname || '未知'}${userId ? ` (userId: ${userId})` : ''}${profileSection}\n\n${gotProfile ? '你的笔记' : `搜索「${nickname}」找到的相关笔记`}:\n${feedsStr}\n\n[系统: ${gotProfile ? '以上是按角色归属保存的主页数据，序号已根据用户刚才的说法按相关性和时间排序。' : '注意，搜索结果可能包含别人的帖子，你需要辨别哪些是你自己发的（看作者名字）。'}现在请你：\n1. 如果用户说“刚才那个帖子”“之前那篇”或要求查看自己帖子的评论区，选择最符合时间/标题的候选并输出 [[XHS_DETAIL: noteId]]；不要只口头说去看。\n2. 如果多个候选同样符合、无法判断是哪条，就自然地向用户确认，不能猜。\n3. 普通查看主页时，可以自然地聊聊看到的内容。\n4. 如果想发新笔记，可以用 [[XHS_POST: 标题 | 内容 | #标签1 #标签2]]。\n5. 严禁再输出[[XHS_MY_PROFILE]]标记。]` }
                ];

                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ model: effectiveApi.model, messages: xhsMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                }, 2, 0, { ...apiLogMeta, purpose: '小红书主页' });
                updateTokenUsage(data, historyMsgCount, 'xhs-profile');
                aiContent = data.choices?.[0]?.message?.content || '';
                aiContent = normalizeAiContent(aiContent);
                addToast(`📕 ${char.name}看了看自己的小红书`, 'info');
            } else if (xmpr.reason === 'no_identity') {
                console.warn('📕 [XHS] 无昵称也无userId，无法查看主页。请在设置中填写。');
                // 原代码在 no_identity 时仍然走 2nd-pass LLM, feedsStr = '（无法获取主页...）', 这里保持一致
                const profileSection = '';
                const cleanedForXhs = aiContent.replace(/\[\[XHS_MY_PROFILE\]\]/g, '').trim() || '让我看看我的小红书...';
                const xhsMessages = [
                    ...fullMessages,
                    { role: 'assistant', content: cleanedForXhs },
                    { role: 'user', content: `[系统: 你打开了自己的小红书]\n\n你的小红书账号昵称: 未知${profileSection}\n\n搜索「」找到的相关笔记:\n（无法获取主页：请在设置-小红书中填写你的昵称或用户ID）\n\n[系统: 注意，搜索结果可能包含别人的帖子，你需要辨别哪些是你自己发的（看作者名字）。现在请你：\n1. 自然地聊聊你看到了什么，"我看了看我的小红书..."、"我之前发的那个帖子..."\n2. 如果想发新笔记，可以用 [[XHS_POST: 标题 | 内容 | #标签1 #标签2]]\n3. 如果想看某条笔记的详细内容，可以用 [[XHS_DETAIL: noteId]]\n4. 严禁再输出[[XHS_MY_PROFILE]]标记]` }
                ];
                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ model: effectiveApi.model, messages: xhsMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                }, 2, 0, { ...apiLogMeta, purpose: '小红书主页' });
                updateTokenUsage(data, historyMsgCount, 'xhs-profile');
                aiContent = data.choices?.[0]?.message?.content || '';
                aiContent = normalizeAiContent(aiContent);
                addToast(`📕 ${char.name}看了看自己的小红书`, 'info');
            } else if (xmpr.reason === 'unreachable') {
                // 主页没打开、降级搜昵称也没跑通 = 小红书那头连不上, 一条笔记都没拿到。
                // 静默删标记的话, 角色刚说完"我看看我的小红书"就没了下文; 更糟的是它可能
                // 顺嘴编几条自己"看到"的笔记, 所以这里明确交代什么都没加载出来。
                console.warn('📕 [XHS] 小红书连不上，主页这次没打开');
                const cleanedForXhs = aiContent.replace(/\[\[XHS_MY_PROFILE\]\]/g, '').trim() || '让我看看我的小红书...';
                const xhsMessages = [
                    ...fullMessages,
                    { role: 'assistant', content: cleanedForXhs },
                    { role: 'user', content: `[系统: 你想打开自己的小红书，但这次连不上，什么都没加载出来]\n\n[系统: 现在请你：\n1. 先正常回应用户刚才说的话（用户还在等你回复！）\n2. 自然地提一句"小红书打不开/刷不出来"就好\n3. 你这次什么都没看到，不要描述任何笔记、数据或评论\n4. 严禁再输出[[XHS_MY_PROFILE]]标记]` }
                ];
                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ model: effectiveApi.model, messages: xhsMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                }, 2, 0, { ...apiLogMeta, purpose: '小红书主页' });
                updateTokenUsage(data, historyMsgCount, 'xhs-profile-unreachable');
                aiContent = data.choices?.[0]?.message?.content || '';
                aiContent = normalizeAiContent(aiContent);
            }
        } catch (e) {
            console.error('📕 [XHS] 查看主页异常:', e);
            aiContent = aiContent.replace(xhsProfileMatch[0], '').trim();
        }
        setXhsStatus('');
    } else if (!skipSecondPassLLM && xhsProfileMatch) {
        aiContent = aiContent.replace(xhsProfileMatch[0], '').trim();
    }
    aiContent = aiContent.replace(/\[\[XHS_MY_PROFILE\]\]/g, '').trim();

    // [[XHS_DETAIL: noteId]]
    const xhsDetailMatch = aiContent.match(/\[\[XHS_DETAIL:\s*(.+?)\]\]/);
    if (!skipSecondPassLLM && xhsDetailMatch && xhsConf.enabled) {
        const noteId = xhsDetailMatch[1].trim();
        setXhsStatus('正在查看笔记详情...');

        try {
            const xdr = await runXhsDetail({ noteId }, agenticCtx);
            // not_enabled 已被外层 if 排除; 剩下的 ok:false 只有 unreachable —— 详情没读到
            // (小红书服务多半跑在用户自己电脑上, 人睡了机器关了就连不上)。这种情况下角色
            // 往往已经说了"我看看这条", 只删标记就没了下文, 所以复用下面 detailFailed 的
            // 圆场路径: 让它说"这条打不开", 而不是装作什么都没发生。
            if (!xdr.ok && xdr.reason !== 'unreachable') {
                // 兜底防御性 — runXhsDetail 在 not_enabled 时返回 ok:false, 但外层 xhsConf.enabled 已保证不会进入
                aiContent = aiContent.replace(xhsDetailMatch[0], '').trim();
                setXhsStatus('');
                aiContent = aiContent.replace(/\[\[XHS_DETAIL:.*?\]\]/g, '').trim();
                // 继续后面的代码 — 不能 return, 因为后面还有别的 tag 处理
            } else {
                const detailStr = xdr.ok ? xdr.detailText : (xdr.message || '（笔记详情一个字都没加载出来）');
                const detailFailed = !xdr.ok;
                const commentsUnavailable = xdr.ok ? xdr.commentsUnavailable : false;
                const cleanedForXhs = aiContent.replace(/\[\[XHS_DETAIL:.*?\]\]/g, '').trim() || '让我看看这条笔记...';
            const xhsMessages = [
                ...fullMessages,
                { role: 'assistant', content: cleanedForXhs },
                { role: 'user', content: detailFailed
                    ? `[系统: 你尝试打开一条小红书笔记（noteId=${noteId}），但加载失败了]\n\n${detailStr}\n\n[系统: 笔记详情页加载失败了。可能的原因：这条笔记需要先通过搜索或浏览才能打开详情。现在请你：\n1. 自然地告知用户"这条笔记打不开/加载不出来"\n2. 可以建议搜索相关关键词再试: [[XHS_SEARCH: 关键词]]\n3. 严禁再输出[[XHS_DETAIL:...]]标记]`
                    : commentsUnavailable
                        ? `[系统: 你点开了一条小红书笔记的详情页（noteId=${noteId}）]\n\n${detailStr}\n\n[系统: 正文和互动数量已读取，但真实评论区本次读取失败。你只能谈论已经看到的正文和数量；不要声称帖子没有评论，不要编造、模拟或回复任何评论。严禁再输出[[XHS_DETAIL:...]]标记。]`
                        : `[系统: 你点开了一条小红书笔记的详情页（noteId=${noteId}）]\n\n${detailStr}\n\n[系统: 你已经看完了这条笔记的完整内容和真实评论区。现在请你：\n1. 自然地分享你看到的内容和感受\n2. 如果想评论这条笔记，可以用 [[XHS_COMMENT: ${noteId} | 评论内容]]\n3. 如果想回复某条评论，可以用 [[XHS_REPLY: ${noteId} | commentId | 回复内容]]（commentId 在上面的评论区数据里）\n4. 如果想点赞，可以用 [[XHS_LIKE: ${noteId}]]；想收藏可以用 [[XHS_FAV: ${noteId}]]\n5. 严禁再输出[[XHS_DETAIL:...]]标记]` }
            ];

            data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                method: 'POST', headers,
                body: JSON.stringify({ model: effectiveApi.model, messages: xhsMessages, temperature: 0.8, max_tokens: 8000, stream: false })
            }, 2, 0, { ...apiLogMeta, purpose: '小红书详情' });
            updateTokenUsage(data, historyMsgCount, 'xhs-detail');
            aiContent = data.choices?.[0]?.message?.content || '';
            aiContent = normalizeAiContent(aiContent);
            addToast(`📕 ${char.name}${detailFailed ? '尝试查看一条笔记（加载失败）' : '看了一条笔记的详情'}`, 'info');
            }  // end of else (xdr.ok)
        } catch (e) {
            console.error('📕 [XHS] 查看详情异常:', e);
            aiContent = aiContent.replace(xhsDetailMatch[0], '').trim();
        }
        setXhsStatus('');
    } else if (!skipSecondPassLLM && xhsDetailMatch) {
        aiContent = aiContent.replace(xhsDetailMatch[0], '').trim();
    }
    aiContent = aiContent.replace(/\[\[XHS_DETAIL:.*?\]\]/g, '').trim();

    // 5.10.1 Second-round XHS action processing
    // [[XHS_COMMENT: noteId | 评论内容]] (second round)
    const xhsCommentMatch2 = aiContent.match(/\[\[XHS_COMMENT:\s*(.+?)\]\]/);
    if (!disabledXhsSideEffects && xhsCommentMatch2 && xhsConf.enabled) {
        const commentRaw = xhsCommentMatch2[1].trim();
        const sepIdx = commentRaw.indexOf('|');
        if (sepIdx > 0) {
            const noteId = commentRaw.slice(0, sepIdx).trim();
            const commentContent = commentRaw.slice(sepIdx + 1).trim();
            const xsecToken = findXsecToken(noteId, lastXhsNotesRef.current);
            console.log(`📕 [XHS] AI要评论笔记(detail后):`, noteId, commentContent.slice(0, 30), xsecToken ? '(有xsecToken)' : '(无xsecToken)');
            setXhsStatus('正在评论...');
            try {
                const result = await xhsComment(xhsConf, noteId, commentContent, xsecToken);
                if (result.success) {
                    await persistMessage({
                        charId: char.id,
                        role: 'system',
                        type: 'text',
                        content: `📕 ${char.name}在小红书评论了: "${commentContent.slice(0, 100)}${commentContent.length > 100 ? '...' : ''}"`
                    });
                    addToast(`📕 ${char.name}在小红书留了评论`, 'success');
                } else {
                    addToast(`评论失败: ${result.message}`, 'error');
                }
            } catch (e) {
                console.error('📕 [XHS] 评论异常(detail后):', e);
            }
        }
        setXhsStatus('');
    }
    aiContent = aiContent.replace(/\[\[XHS_COMMENT:.*?\]\]/g, '').trim();

    // [[XHS_REPLY]] (second round)
    const xhsReplyMatch2 = aiContent.match(/\[\[XHS_REPLY:\s*(.+?)\]\]/);
    if (!disabledXhsSideEffects && xhsReplyMatch2 && xhsConf.enabled) {
        const parts = xhsReplyMatch2[1].split('|').map(s => s.trim());
        if (parts.length >= 3) {
            const [noteId, commentId, ...replyParts] = parts;
            const replyContent = replyParts.join('|').trim();
            const xsecToken = findXsecToken(noteId, lastXhsNotesRef.current);
            const commentUserId = commentUserIdCacheRef.get(commentId);
            const commentAuthorName = commentAuthorNameCacheRef.get(commentId);
            const parentCommentId = commentParentIdCacheRef.get(commentId);
            if (replyContent) {
                console.log(`📕 [XHS] AI要回复评论(detail后):`, noteId, commentId, replyContent.slice(0, 30),
                    commentUserId ? `(userId=${commentUserId})` : '(无userId)',
                    commentAuthorName ? `(author=${commentAuthorName})` : '',
                    parentCommentId ? `(parentId=${parentCommentId})` : '(顶级评论)',
                    xsecToken ? '(有xsecToken)' : '(bridge自动获取)');
                setXhsStatus('正在回复评论...');
                try {
                    let result = await xhsReplyComment(xhsConf, noteId, xsecToken || '', replyContent, commentId, commentUserId, parentCommentId);
                    const selectorBroken = !result.success && result.message?.includes('未找到评论');
                    if (selectorBroken) {
                        console.warn(`📕 [XHS] 回复失败(detail后)(DOM选择器不匹配)，跳过重试直接降级:`, result.message);
                    } else {
                        const replyRetries = [3000, 4000, 5000];
                        for (let i = 0; i < replyRetries.length && !result.success; i++) {
                            console.warn(`📕 [XHS] 回复失败(detail后)(${i + 1}/${replyRetries.length})，${replyRetries[i] / 1000}秒后重试:`, result.message);
                            await new Promise(r => setTimeout(r, replyRetries[i]));
                            result = await xhsReplyComment(xhsConf, noteId, xsecToken || '', replyContent, commentId, commentUserId, parentCommentId);
                        }
                    }
                    if (result.success) {
                        addToast(`📕 ${char.name}回复了一条评论`, 'success');
                    } else {
                        console.warn(`📕 [XHS] 回复失败(detail后)，降级为 @提及 评论:`, result.message);
                        const fallbackContent = commentAuthorName
                            ? `@${commentAuthorName} ${replyContent}`
                            : replyContent;
                        let fallback = await xhsComment(xhsConf, noteId, fallbackContent, xsecToken || '');
                        if (!fallback.success) {
                            console.warn(`📕 [XHS] 顶级评论也失败(detail后)，3秒后重试:`, fallback.message);
                            await new Promise(r => setTimeout(r, 3000));
                            fallback = await xhsComment(xhsConf, noteId, fallbackContent, xsecToken);
                        }
                        if (fallback.success) {
                            addToast(`📕 ${char.name}评论了一条笔记（@提及回复）`, 'success');
                        } else {
                            addToast(`回复失败: ${result.message}`, 'error');
                        }
                    }
                } catch (e) { console.error('📕 [XHS] 回复异常(detail后):', e); }
                setXhsStatus('');
            } else {
                console.warn('📕 [XHS] 回复缺少 xsecToken 或内容(detail后)');
            }
        }
    }
    aiContent = aiContent.replace(/\[\[XHS_REPLY:.*?\]\]/g, '').trim();

    // [[XHS_LIKE]] (second round)
    const xhsLikeMatches2: Iterable<RegExpMatchArray> = disabledXhsSideEffects ? [] : aiContent.matchAll(/\[\[XHS_LIKE:\s*(.+?)\]\]/g);
    for (const xhsLikeMatch of xhsLikeMatches2) {
        if (xhsConf.enabled) {
            const noteId = xhsLikeMatch[1].trim();
            const xsecToken = findXsecToken(noteId, lastXhsNotesRef.current);
            console.log(`📕 [XHS] AI要点赞笔记(detail后):`, noteId, xsecToken ? '(有xsecToken)' : '(bridge自动获取)');
            try {
                const result = await xhsLike(xhsConf, noteId, xsecToken || '');
                if (result.success) {
                    addToast(`📕 ${char.name}点赞了一条笔记`, 'success');
                } else {
                    console.warn('📕 [XHS] 点赞失败(detail后):', result.message);
                }
            } catch (e) { console.error('📕 [XHS] 点赞异常(detail后):', e); }
        }
    }
    aiContent = aiContent.replace(/\[\[XHS_LIKE:.*?\]\]/g, '').trim();

    // [[XHS_FAV]] (second round)
    const xhsFavMatches2: Iterable<RegExpMatchArray> = disabledXhsSideEffects ? [] : aiContent.matchAll(/\[\[XHS_FAV:\s*(.+?)\]\]/g);
    for (const xhsFavMatch of xhsFavMatches2) {
        if (xhsConf.enabled) {
            const noteId = xhsFavMatch[1].trim();
            const xsecToken = findXsecToken(noteId, lastXhsNotesRef.current);
            console.log(`📕 [XHS] AI要收藏笔记(detail后):`, noteId, xsecToken ? '(有xsecToken)' : '(bridge自动获取)');
            try {
                const result = await xhsFavorite(xhsConf, noteId, xsecToken || '');
                if (result.success) {
                    addToast(`📕 ${char.name}收藏了一条笔记`, 'success');
                } else {
                    console.warn('📕 [XHS] 收藏失败(detail后):', result.message);
                }
            } catch (e) { console.error('📕 [XHS] 收藏异常(detail后):', e); }
        }
    }
    aiContent = aiContent.replace(/\[\[XHS_FAV:.*?\]\]/g, '').trim();

    // [[XHS_POST]] (second round - after MY_PROFILE)
    const xhsPostMatch2 = aiContent.match(/\[\[XHS_POST:\s*(.+?)\]\]/s);
    if (!disabledXhsSideEffects && xhsPostMatch2 && xhsConf.enabled) {
        const postRaw = xhsPostMatch2[1].trim();
        const parts = postRaw.split('|').map(p => p.trim());
        const postTitle = parts[0] || '';
        const postContent = parts[1] || '';
        const postTags = (parts[2] || '').match(/#(\S+)/g)?.map(t => t.replace('#', '')) || [];
        console.log(`📕 [XHS] AI要发小红书(profile后):`, postTitle);
        setXhsStatus(`正在发布小红书: ${postTitle}...`);
        try {
            const result = await xhsPublish(xhsConf, char, postTitle, postContent, postTags);
            if (result.success) {
                console.log('📕 [XHS] 发布成功(profile后):', result.noteId);
                const tagsStr = postTags.length > 0 ? ` #${postTags.join(' #')}` : '';
                await persistMessage({
                    charId: char.id,
                    role: 'system',
                    type: 'text',
                    content: `📕 ${char.name}发了一条小红书「${postTitle}」\n${postContent.slice(0, 200)}${postContent.length > 200 ? '...' : ''}${tagsStr}`
                });
                addToast(`📕 ${char.name}发了一条小红书!`, 'success');
            } else {
                console.error('📕 [XHS] 发布失败(profile后):', result.message);
                addToast(`小红书发布失败: ${result.message}`, 'error');
            }
        } catch (e) {
            console.error('📕 [XHS] 发布异常(profile后):', e);
        }
        setXhsStatus('');
    }
    aiContent = aiContent.replace(/\[\[XHS_POST:.*?\]\]/gs, '').trim();

    // 二轮 LLM 可能新产生日程标签；在统一动作解析前再消费一次。首次那条已经从 aiContent
    // 剥掉且写入幂等（同活动不重复），因此普通单轮回复不会重放副作用。
    //
    // 这一段是刚刚生成的，所以按「现在」判时段，不跟着首轮那句的 spokenAt 走：两者之间
    // 隔着 RECALL / SEARCH / XHS 几趟往返，隔夜补收的 spokenAt 会把新写的改动整批作废。
    aiContent = await consumeScheduleChanges(aiContent, new Date());

    // ─── Step 3: ChatParser.parseAndExecuteActions ───
    // mcdInheritMeta 一起传下去：戳一戳 / 转账卡 / 音乐卡 / 新闻卡 / 日程系统提示 / 生活记录卡
    // 跟正文气泡带同一个标记。主动消息处理失败重来时，靠这个标记才认得出「上一趟已经做过了」，
    // 认不出来就会把整套副作用再跑一遍（同一笔转账落两张卡）。
    //
    // 冻结的那首歌只能顺着 directive 显式递下去：上面拼回的 `[[MUSIC_ACTION:…]]` 标签里
    // 只有歌单名，带不动歌名（见 chatParser 的 FrozenMusicSong）。
    const frozenMusicSong = directives?.find(
        (d): d is Extract<PostProcessDirective, { type: 'music_action' }> =>
            d.type === 'music_action' && !!d.song,
    )?.song;
    aiContent = await ChatParser.parseAndExecuteActions(aiContent, char.id, char.name, addToast, musicHooks, resolveCharTimeZone(char), messageTimestamp, mcdInheritMeta, frozenMusicSong);

    // ─── Step 4: thinking chain 抽取 (本轮末尾展示用) ───
    // 跑过二轮 (data !== initialData) → 取二轮 data 的 reasoning; 没跑二轮 → 取一轮 (round1ThinkingChain,
    // 已含 push 路径 reasoning)。一轮正文 A 的思考链在 Step 2 开头展示时已单独带上。
    let pendingThinkingChain: string | null = data !== initialData ? extractThinkingChain(data) : round1ThinkingChain;
    const mergeAssistantMeta = (base: any): any => {
        if (!pendingThinkingChain) return base;
        const merged = { ...(base || {}), thinkingChain: pendingThinkingChain };
        pendingThinkingChain = null;
        return merged;
    };

    // ─── Step 5: HTML 卡片 ───
    if ((char as any).htmlModeEnabled && /\[html\]/i.test(aiContent)) {
        const { blocks, cleanedContent } = extractHtmlBlocks(aiContent);
        for (const blk of blocks) {
            try {
                await persistMessage({
                    charId: char.id,
                    role: 'assistant',
                    type: 'html_card',
                    content: blk.textPreview ? `[HTML卡片] ${blk.textPreview}` : '[HTML卡片]',
                    metadata: mergeAssistantMeta({
                        htmlSource: blk.html,
                        htmlTextPreview: blk.textPreview,
                        ...(mcdInheritMeta || {}),
                    }),
                } as any);
                setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                await new Promise(r => setTimeout(r, 300));
            } catch (e) {
                console.error('[HTML] 落库 html_card 失败', e);
            }
        }
        aiContent = cleanedContent;
    } else if (/\[html\]/i.test(aiContent)) {
        // HTML 卡片开关关着（打包时开着、送达前用户关掉，或角色本来就没这个能力却硬输出）。
        // 这一段源码 sanitize 和 hasDisplayContent 都不剥，不处理就整块 <div ...> 原样漏进气泡。
        // 降级成占位文本，跟锁屏横幅那边（utils/sanitize.ts 的 [HTML 卡片]）看到的一致。
        console.warn('[HTML] HTML 卡片没开，源码降级成占位文本', { charId: char.id });
        aiContent = aiContent.replace(/\[html\][\s\S]*?\[\/html\]/gi, '[HTML 卡片]').trim();
    }

    // ─── Step 6: 展示本轮回复 (二轮结果 B / 无二轮时的单轮回复) ───
    // - 跑过二轮 (data !== initialData): aiContent 现在是 B; 一轮正文 A 已在 Step 2 开头先行展示, 这里只展示 B。
    // - 有重生指令但没真正发起二轮 (data 不变: 未配置/无结果/无日志/已激活/二轮异常 等): A 已展示, 跳过避免重复。
    // - 没有重生 (普通回复 / instant push): leadInRendered 必为 false, 正常展示本轮唯一回复。
    if (leadInRendered && data === initialData) {
        setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
    } else {
        const sanitizedBody = ChatParser.sanitize(aiContent, { keepCitations: true })
            .replace(/\[\[INNER_STATE:\s*[\s\S]*?\]\]/g, '')
            .trim();
        if (sanitizedBody) {
            await renderAndPersist(aiContent, pendingThinkingChain);
        } else if (!leadInRendered && (data !== initialData || recallMatch || searchMatch || readDiaryMatch || fsReadDiaryMatch)) {
            // 跑过二轮却吐空, 且本轮还没展示过任何内容 → 至少补一句, 避免整轮静默。
            await renderAndPersist('嗯...', pendingThinkingChain);
        } else {
            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
        }
    }
}
