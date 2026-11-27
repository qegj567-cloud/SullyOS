import { withReplyCancellation, type ReplyRun } from './chatReplyCancellation';
import { appendInstantTraceEntry } from './instantTraceLog';
import { stripDisabledMonthlyRecall } from './monthlyRecall';
import { dialogueMaxTokens } from './characterApi';
/**
 * applyAssistantPostProcessing — 抽自 hooks/useChatAI.ts 的 sendMessage 后处理管线
 *
 * 把"API 拿到原始 aiContent → 13 步处理 → 逐条落库到 IndexedDB"这段流水线抽成可复用函数,
 * 本地 fetch 路径 (useChatAI) 和云端回复的冲刷 (activeMsgRuntime) 都调它, 保证行为一致。
 *
 * 13 步 (与计划编号对应):
 *  1. normalizeAiContent — 剥 <think>/时间戳/[聊天][通话][约会] 等
 *  2. 回连循环 — RECALL / SEARCH / READ_DIARY / FS_READ_DIARY / READ_NOTE / XHS 查询类，按轮批量执行，
 *     最多 5 轮（跟 worker 工具循环同口径）；每一轮的正文都走一遍下面 3~13 步
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
 * 本地 fetch 路径: directives=[] / skipSecondPassLLM=false, 跑完整管线。
 * 云端回复: skipSecondPassLLM=true (worker 已跑过工具循环), worker 把识别出的副作用结构化成
 * directives 传过来, 这里只重放。
 */

import { CharacterProfile, UserProfile, Message, Emoji, EmojiCategory, RealtimeConfig, GroupProfile } from '../types';
import { DB } from './db';
import { readAssistantThinking, splitInlineThinking } from './assistantThinking';
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
    parseDiaryDate,
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
import { stripLeakedSourceTags } from './sanitize';
import {consumeFriendFeedMainReply} from './friendFeedMain';
import {consumeHomeVisitReply} from './homeVisitReply';
import { buildDuplicateToolMessage, buildToolResultMessage, neverRan, toolCallFingerprint, type ToolCallRecord } from './agenticToolFeedback';
import { TOOL_ROUND_PLACEHOLDER } from './amsg2ToolLoop';
// 标签识别、轮数上限、去重阈值和收尾提示直接用云端工具循环那几份（都是不带浏览器依赖的叶子），
// 本地回连链跟云端不各写一套。
import { classifyLLMOutput, type ToolCall } from '../worker/amsg/src/classifier';
import { appendFinalRoundNotice, DEFAULT_TOOL_ITERATIONS, MAX_DUPLICATE_TOOL_CALLS } from '../worker/amsg/src/agentic';

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
    cleaned = splitInlineThinking(cleaned).content;
    cleaned = cleaned.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');
    cleaned = cleaned.replace(/^[\w一-龥]+:\s*/, '');
    // Strip source tags leaked from history context, including model-mutated forms such as [聊chat].
    cleaned = stripLeakedSourceTags(cleaned);
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
    // Match canonical preprocessing before splitting. History-style stickers must
    // become emoji tokens, not text chunks that consume the next speech's slot.
    // This only normalizes display text; surface commands are never executed.
    const withoutShares = extractMimickedXhsShares(normalizeAiContent(raw)).cleanedContent;
    const withoutCards = extractHtmlBlocks(withoutShares).cleanedContent;
    let content = ChatParser.sanitize(withoutCards, { keepCitations: true });
    // Only speech takes a surface slot. Card/action directives belong to canonical;
    // keep emoji tokens just long enough for splitResponse to exclude them too.
    content = content.replace(/\[\[(?!SEND_EMOJI:)[\s\S]*?\]\]/g, '').trim();
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
export const resolveEmojiForSend = (
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
// XHS side-effect helpers (POKE-style: 不抽到 agenticTools, 云端回复靠 directive 重放触发)

async function xhsPublish(
    conf: { mcpUrl: string },
    owner: Pick<CharacterProfile, 'id' | 'name'>,
    title: string,
    content: string,
    tags: string[], signal?: AbortSignal,
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

    const r = await XhsMcpClient.publishNote(conf.mcpUrl, { title, content, tags, images: images.length > 0 ? images : undefined }, signal);
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

async function xhsComment(conf: { mcpUrl: string }, noteId: string, content: string, xsecToken?: string, signal?: AbortSignal): Promise<{ success: boolean; message: string }> {
    const r = await XhsMcpClient.comment(conf.mcpUrl, noteId, content, xsecToken, signal);
    return { success: r.success, message: r.error || (r.success ? '评论成功' : '评论失败') };
}

async function xhsLike(conf: { mcpUrl: string }, feedId: string, xsecToken: string, signal?: AbortSignal): Promise<{ success: boolean; message: string }> {
    const r = await XhsMcpClient.likeFeed(conf.mcpUrl, feedId, xsecToken, undefined, signal);
    return { success: r.success, message: r.error || (r.success ? '点赞成功' : '点赞失败') };
}

async function xhsFavorite(conf: { mcpUrl: string }, feedId: string, xsecToken: string, signal?: AbortSignal): Promise<{ success: boolean; message: string }> {
    const r = await XhsMcpClient.favoriteFeed(conf.mcpUrl, feedId, xsecToken, undefined, signal);
    return { success: r.success, message: r.error || (r.success ? '收藏成功' : '收藏失败') };
}

async function xhsReplyComment(conf: { mcpUrl: string }, feedId: string, xsecToken: string, content: string, commentId?: string, userId?: string, parentCommentId?: string, signal?: AbortSignal): Promise<{ success: boolean; message: string }> {
    const r = await XhsMcpClient.replyComment(conf.mcpUrl, feedId, xsecToken, content, commentId, userId, parentCommentId, signal);
    return { success: r.success, message: r.error || (r.success ? '回复成功' : '回复失败') };
}

// ─── 公开类型 ────────────────────────────────────────────────────────────────

/**
 * worker `onLLMOutput` hook 把识别到的副作用标签结构化传回, 客户端 applyAssistantPostProcessing
 * 反向重建标签后让下游 chatParser / 内联 XHS handler 复用同一份执行逻辑 (避免在客户端再写一遍).
 *
 * 字段形状跟 worker/amsg/src/classifier.ts:Directive 必须保持一致 — 用 type 做
 * discriminator, 其他字段是 flat 而不是 nested payload (减少 push body 嵌套).
 */
export type PostProcessDirective =
    | { type: 'friend_feed_reply'; action: unknown }
    | { type: 'home_visit_reply'; action: unknown }
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
            case 'friend_feed_reply':
            case 'home_visit_reply':
                // Consumed through the structured side-action path, never reconstructed into a bubble.
                break;
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
    /** maxTokens：二轮请求的输出上限跟首轮同一个设置（dialogueMaxTokens 读它）。 */
    effectiveApi: { baseUrl: string; apiKey: string; model: string; maxTokens?: number };
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
    /** 落库后刷新界面读哪一截消息；不给就读最近 200 条。 */
    loadRefreshMessages?: () => Promise<Message[]>;
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
    replyRun?: ReplyRun;
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
     * 云端回复的 caller (utils/activeMsgRuntime.ts) **必传** module-level 单例: worker 跑 XHS 工具时
     * 把引用到的笔记随 push 带回来, activeMsgRuntime 先重建进这个单例, 再由这里 replay XHS_SHARE
     * 读同一份 ref. 跨 push 共享 = 跟本地路径同 UX.
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
    /** 用户准备生成下一轮时结束 inbox 的打字等待；仅加速显示，不取消正文或副作用。 */
    skipTypingSignal?: AbortSignal;
    /**
     * worker 已在自己内部跑过 2nd-pass LLM (云端回复) 时置 true, 主线程不该再调一次。
     * 本地 fetch 路径不传。
     */
    skipSecondPassLLM?: boolean;
    /**
     * worker 端把识别到的副作用结构化传过来; 非空时只重放, 不再扫原文。
     * 本地 fetch 路径不传。
     */
    directives?: PostProcessDirective[];
    /**
     * 云端回复的 reasoning chain 来源: flushInboxToChat 从第一条 content push 的
     * metadata.amsgReasoning (或挪进 client_state 的那份) 取出来塞到这里.
     * 本地 fetch 路径不传 (Step 4 从 initialData.choices[0].message.reasoning_content 读).
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
    /**
     * 每一轮回连请求发出前调用。要中止就让 replyRun 停下并抛出（离开后消息用它确认用户还没回来）。
     * 不传 = 不额外确认。
     */
    beforeSecondPass?: () => Promise<void>;
}

/**
 * 会回连模型的标签（RECALL / SEARCH / READ_DIARY / FS_READ_DIARY / READ_NOTE / XHS 查询类），只用来计数和判断有没有。
 * 真正执行时的识别用 worker 的 classifyLLMOutput，正则与这里同口径。
 * 导出给本地离开后消息：它要在切分多次发送之前就知道这一轮会不会重生，见 awayMessage.runLocalProactiveTurn。
 */
const SECOND_PASS_TAGS: ReadonlyArray<[kind: string, re: RegExp]> = [
    ['RECALL', /\[\[RECALL:\s*\d{4}[-/年]\d{1,2}\]\]/g],
    ['SEARCH', /\[\[SEARCH:\s*.+?\]\]/g],
    ['READ_DIARY', /\[\[READ_DIARY:\s*.+?\]\]/g],
    ['FS_READ_DIARY', /\[\[FS_READ_DIARY:\s*.+?\]\]/g],
    ['READ_NOTE', /\[\[READ_NOTE:\s*.+?\]\]/g],
    ['XHS_SEARCH', /\[\[XHS_SEARCH:\s*.+?\]\]/g],
    ['XHS_BROWSE', /\[\[XHS_BROWSE(?::\s*.+?)?\]\]/g],
    ['XHS_MY_PROFILE', /\[\[XHS_MY_PROFILE\]\]/g],
    ['XHS_DETAIL', /\[\[XHS_DETAIL:\s*.+?\]\]/g],
];
/** 各类回连标签出现的次数（没有的不列）。 */
const countSecondPassTags = (text: string): Record<string, number> => Object.fromEntries(
    SECOND_PASS_TAGS.map(([kind, re]) => [kind, text.match(re)?.length ?? 0] as const).filter(([, n]) => n > 0),
);
export const hasSecondPassTag = (text: string): boolean => Object.keys(countSecondPassTags(text)).length > 0;
const stripSecondPassTags = (text: string): string => SECOND_PASS_TAGS.reduce((acc, [, re]) => acc.replace(re, ''), text);

/** 长日记块还没写完（有 START、后面没有对应的 END）时，START 在正文里的位置；没有返回 -1。 */
const findOpenDiaryStart = (text: string): number => {
    const starts = ([['[[DIARY_START:', '[[DIARY_END]]'], ['[[FS_DIARY_START:', '[[FS_DIARY_END]]']] as const)
        .map(([start, end]) => {
            const at = text.lastIndexOf(start);
            return at >= 0 && text.indexOf(end, at) < 0 ? at : -1;
        })
        .filter(at => at >= 0);
    return starts.length > 0 ? Math.min(...starts) : -1;
};
/** 写完整的长日记块（Notion / 飞书）。 */
const COMPLETE_DIARY_BLOCK_RE = /\[\[(FS_)?DIARY_START:[\s\S]*?\[\[\1DIARY_END\]\]/g;

// ─── 主入口 ─────────────────────────────────────────────────────────────────

/**
 * skipSecondPassLLM=false + directives=[] 时是本地 fetch 路径的默认形态。
 */
export async function applyAssistantPostProcessing(
    rawAiContent: string,
    ctx: PostProcessCtx,
): Promise<void> {
    const replyStep = <T>(operation: () => Promise<T>) => withReplyCancellation(ctx.replyRun, operation);
    ctx.replyRun?.check();
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
    const typingPause = (ms: number): Promise<void> => {
        const signal = ctx.skipTypingSignal;
        if (instantRender || signal?.aborted) return Promise.resolve();
        return new Promise(resolve => {
            const finish = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', finish);
                resolve();
            };
            const timer = setTimeout(finish, ms);
            signal?.addEventListener('abort', finish, { once: true });
        });
    };
    // 统一落库入口：ctx.messageTimestamp（若有）盖到每条消息上，保证同一轮拆出的
    // 正文 / 表情 / 卡片 / 系统提示时间戳一致；没传则维持 DB.saveMessage 默认（写库当刻）。
    // 全函数落库一律走这里，别直接调 DB.saveMessage——漏一处就会出现气泡时间戳互相打架。
    const persistMessage: typeof DB.saveMessage = (msg) =>
        (ctx.replyRun?.saveMessage ?? DB.saveMessage)(messageTimestamp != null ? { ...msg, timestamp: messageTimestamp } : msg);
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
    // 每落一条气泡都要刷新界面：调用方给了读法就只读界面画得出来的那一截。
    const readRefreshTail = () => hooks.loadRefreshMessages?.() ?? DB.getRecentMessagesByCharId(char.id, 200);
    const {
        xsecTokenCache: xsecTokenCacheRef,
        commentUserIdCache: commentUserIdCacheRef,
        commentAuthorNameCache: commentAuthorNameCacheRef,
        commentParentIdCache: commentParentIdCacheRef,
    } = xhsCaches;

    // API 调用记录用 meta：二轮重生 / 调阅 / 日记 / 小红书等都归在「消息」App 下，purpose 见各分支。
    const apiLogMeta = { appName: '消息', charId: char.id, charName: char.name };
    // 二轮回连请求统一从这里发，发之前先过调用方的确认。
    const secondPassFetch: typeof safeFetchJson = async (...args) => {
        await ctx.beforeSecondPass?.();
        return safeFetchJson(...args);
    };

    // skipSecondPassLLM=true (云端回复) 时, 跳过所有需要回连 LLM 的
    // 二轮分支 (RECALL / SEARCH / READ_DIARY / FS_READ_DIARY / READ_NOTE / XHS_*)。
    // 这些 tag 留在原文里, 由后面 Step 6 的 ChatParser.sanitize 兜底剥掉 (chatParser.ts:225
    // 的正则覆盖 ACTION/RECALL/SEARCH/DIARY/READ_DIARY/FS_DIARY/FS_READ_DIARY/...),
    // XHS_* / READ_NOTE 兜底用 Step 12 的 hasDisplayContent + per-chunk sanitize 再清一遍。
    // 写日记类 (DIARY / FS_DIARY) 不走 LLM, 属于纯副作用 (像 POKE), 客户端可以直接执行。
    // directives 非空时, worker 已经把副作用标签结构化传过来 (并从 push body
    // 里剥光了). 我们重建原 tag 字符串塞回 rawAiContent 头部, 让下游 chatParser.parseAndExecuteActions
    // + 后置 XHS_* 内联 handler 用同一份代码执行 — 零重复实现, 跟本地 fetch 路径同一份 source of truth.
    // tag 末尾 +\n\n 保证不跟正文粘连导致 regex 漏匹配; chatParser.sanitize 会把它们清干净.
    const replayedTagPrefix = reconstructDirectiveTags(directives);
    const hasReplayDirectives = !!directives && directives.length > 0;

    // XHS 副作用 (LIKE/FAV/COMMENT/REPLY/POST/SHARE) 跟 2nd-pass LLM tools (SEARCH/BROWSE/
    // DETAIL/MY_PROFILE) 分开对待: 副作用类只需要 MCP 调用, 不需要 LLM round-trip, 当 worker 给了
    // directives 时 (xhs_* in classifier) 这些 tag 已重建回正文, 必须执行.
    // 用 disabledXhsSideEffects = (skipSecondPassLLM && !hasReplayDirectives) 区分:
    //   - 本地 fetch 路径: skipSecondPassLLM=false → false → 不禁用
    //   - 云端回复但没带 directives: true && true → 禁用 (原文里的 tag 没经 worker 识别, 不执行)
    //   - 云端回复带 directives: true && false → 不禁用, 副作用照常跑
    const disabledXhsSideEffects = skipSecondPassLLM && !hasReplayDirectives;

    /** 从缓存或 notesPool 中查找 xsecToken — 仅副作用 XHS handler (COMMENT/REPLY/LIKE/FAV) 使用 */
    const findXsecToken = (noteId: string, notesPool: XhsNote[]): string | undefined => {
        const fromNotes = notesPool.find(n => n.noteId === noteId)?.xsecToken;
        if (fromNotes) return fromNotes;
        return xsecTokenCacheRef.get(noteId);
    };

    /**
     * XHS 跨 tool 共享笔记缓冲 — 取代旧版 `let lastXhsNotesRef.current`.
     * Caller (云端回复) 传了 module-level 单例就用它 (跨 push 共享让 XHS_SHARE 找到 worker 带回的笔记);
     * 没传 (本地 fetch 路径) 自动创建 fresh (单次 send 内 runXhsBrowse → XHS_SHARE 同一函数闭包内共享, 跟历史一致).
     */
    const lastXhsNotesRef = ctx.lastXhsNotesRef ?? { current: [] as XhsNote[] };

    /** agenticTools 入参 ctx — 9 个 run* 函数共享 */
    const agenticCtx: AgenticToolCtx = {
        signal: ctx.replyRun?.signal,
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
    const initialRawMessage = initialData?.choices?.[0]?.message || {content:rawAiContent};

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
        const result = await replyStep(async () => applyAssistantScheduleChanges(content, char, at));
        if (result.changes.length > 0 && result.schedule) {
            // 本地聊天直接复用 caller 的 groups；主动消息路径只在真的改了日程时读一次，
            // 不给每一条普通 push 平添 IndexedDB 查询和新的失败点。
            const syncGroups = groups ?? await replyStep(async () => DB.getGroups().catch(() => undefined));
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
    rawAiContent = splitInlineThinking(rawAiContent).content;
    rawAiContent = await replyStep(() => consumeHomeVisitReply(char.id, rawAiContent,
        (directives || []).flatMap(d=>d.type==='home_visit_reply'?[d.action]:[])));
    rawAiContent = await replyStep(() => consumeFriendFeedMainReply(char.id, rawAiContent,
        (directives || []).flatMap(d => d.type === 'friend_feed_reply' ? [d.action] : [])));
    let aiContent = replayedTagPrefix ? `${replayedTagPrefix}${rawAiContent}` : rawAiContent;
    aiContent = normalizeAiContent(aiContent);
    aiContent = stripDisabledMonthlyRecall(aiContent, char);
    // 先于 lead-in / 二轮渲染消费：否则控制标签会作为普通气泡短暂闪给用户看。
    aiContent = await replyStep(async () => consumeScheduleChanges(aiContent, utteranceAt));
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
        return readAssistantThinking(dataObj?.choices?.[0]?.message
            || (dataObj === initialData ? initialRawMessage : undefined), reasoningOverride) || null;
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
            await replyStep(async () => typingPause(Math.random() * 500 + 300));
            const foundEmoji = resolveEmojiForSend(name, emojis, ctx.categories);
            if (foundEmoji) {
                await replyStep(async () => persistMessage({ charId: char.id, role: 'assistant', type: 'emoji', content: foundEmoji.url, metadata: { ...takeMeta(mcdInheritMeta), stickerName: foundEmoji.name } } as any));
            } else {
                console.warn('[emoji] 表情库里没有这个名字，落降级文本气泡', { name, charId: char.id });
                await replyStep(async () => persistMessage({ charId: char.id, role: 'assistant', type: 'text', content: `[表情：${name}]`, metadata: takeMeta(mcdInheritMeta) } as any));
            }
            setMessages(await replyStep(readRefreshTail));
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
                        await replyStep(async () => sendEmojiBubble(part.content));
                        continue;
                    }
                    const cleaned = ChatParser.sanitize(part.content);
                    if (!cleaned || !ChatParser.hasDisplayContent(cleaned)) continue;
                    const chunks = ChatParser.chunkText(cleaned);
                    for (const chunk of chunks) {
                        if (!chunk) continue;
                        const replyData = globalMsgIndex === 0 ? aiReplyTarget : undefined;
                        await replyStep(async () => typingPause(Math.min(Math.max(chunk.length * 50, 500), 2000)));
                        await replyStep(async () => persistMessage({ charId: char.id, role: 'assistant', type: 'text', content: chunk, replyTo: replyData, metadata: takeMeta(mcdInheritMeta, chunk) } as any));
                        setMessages(await replyStep(readRefreshTail));
                        globalMsgIndex++;
                    }
                }
            };
            const tagPattern = /<翻译>\s*<原文>([\s\S]*?)<\/原文>\s*<译文>([\s\S]*?)<\/译文>\s*<\/翻译>/g;
            let lastIndex = 0;
            let tagMatch;

            while ((tagMatch = tagPattern.exec(content)) !== null) {
                const textBefore = content.slice(lastIndex, tagMatch.index).trim();
                if (textBefore) await replyStep(async () => renderPlainSegment(textBefore));

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
                    await replyStep(async () => typingPause(Math.min(Math.max(biContent.length * 30, 400), 2000)));
                    await replyStep(async () => persistMessage({ charId: char.id, role: 'assistant', type: 'text', content: biContent, replyTo: replyData, metadata: takeMeta(mcdInheritMeta, biContent) } as any));
                    setMessages(await replyStep(readRefreshTail));
                    globalMsgIndex++;
                }
                for (const name of inlineEmojis) await replyStep(async () => sendEmojiBubble(name));

                lastIndex = tagMatch.index + tagMatch[0].length;
            }

            const textAfter = content.slice(lastIndex).trim();
            if (textAfter) await replyStep(async () => renderPlainSegment(textAfter.replace(/<\/?翻译>|<\/?原文>|<\/?译文>/g, '').trim()));
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
                    await replyStep(async () => sendEmojiBubble(part.content));
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
                        await replyStep(async () => typingPause(delay));

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
                                await replyStep(async () => persistMessage({ charId: char.id, role: 'assistant', type: 'text', content: cleanChunk, replyTo: replyData, metadata: takeMeta(mcdInheritMeta, cleanChunk) } as any));
                                setMessages(await replyStep(readRefreshTail));
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

    // ─── Step 2: 回连循环 ───
    //
    // 跟云端 worker 的工具循环同一种做法（worker/amsg/src/agentic.ts 的 processLLMRound、
    // index.ts 的 executeToolCalls）：每一轮回复里写出的回连标签（RECALL / SEARCH / 翻日记 /
    // 翻笔记 / 小红书查询类）一次性取出、一起执行，结果在下一轮请求里一起交回模型。标签识别、
    // 轮数上限、去重和收尾提示直接用云端那几份，本地和云端才不会各走各的。
    //
    // 每一轮的正文先走完副作用和展示（processRoundText），再执行这一轮的工具：用户看到的
    // 顺序是「这一轮的话 → 正在查… → 下一轮的话」。云端回放（skipSecondPassLLM）不回连，
    // 只跑一轮 processRoundText，就是原来那条后半段管线。
    const round1ThinkingChain = extractThinkingChain(initialData, pushReasoningContent);
    const xhsConf = resolveXhsConfig(char, realtimeConfig);
    // 跨轮共用：前一轮已经落过的卡，后面几轮再模仿一遍时不重复落。
    const sharedXhsCardKeys = new Set<string>();
    // 首轮的仿卡片文本在 Step 1 就抽走了，交给第一轮展示时落卡。
    let pendingMimickedShares = mimickedXhsShares.shares;
    /** 这次回复里有没有哪一轮展示过正文（整个循环都没话时才补一句）。 */
    let spokeAny = false;
    /** 真正执行过工具、回连过模型的轮数。 */
    let toolRounds = 0;

    // 同一渠道共用一个状态栏，小红书还共用同一个浏览器会话、同一份笔记缓冲（序号要对得上），
    // 所以渠道内串行、渠道之间并行。
    const TOOL_CHANNEL: Record<string, string> = {
        recall: 'recall',
        web_search: 'search',
        notion_read_diary: 'diary',
        feishu_read_diary: 'diary',
        read_note: 'diary',
        xhs_search: 'xhs',
        xhs_browse: 'xhs',
        xhs_my_profile: 'xhs',
        xhs_detail: 'xhs',
    };
    const TOOL_PURPOSE: Record<string, string> = {
        recall: '调阅记忆',
        web_search: '联网搜索',
        notion_read_diary: '翻阅日记',
        feishu_read_diary: '翻阅日记',
        read_note: '翻阅笔记',
        xhs_search: '小红书搜索',
        xhs_browse: '小红书浏览',
        xhs_my_profile: '小红书主页',
        xhs_detail: '小红书详情',
    };

    /** 角色自己的小红书主页先读本机按角色归属的帖子（真实账号可能几个角色共用），读不了才退回真实账号主页。 */
    const readOwnXhsProfile = async (): Promise<Awaited<ReturnType<typeof runXhsMyProfile>> & { ownedPosts?: boolean }> => {
        if (!xhsConf.enabled) return runXhsMyProfile({}, agenticCtx);
        try {
            const ownedPosts = await replyStep(async () => DB.getXhsOwnedPosts(char.id));
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
            return {
                ok: true,
                nickname: char.name,
                userId: '',
                profileStr: `角色独立主页：共 ${ownedPosts.length} 条笔记。真实账号可能与其他角色共用。`,
                feedsStr,
                gotProfile: true,
                notes: localNotes,
                // 回喂引导据此说「这是按角色归属保存的主页」，真实账号主页没有这个标记。
                ownedPosts: true,
            };
        } catch (localProfileError) {
            ctx.replyRun?.check();
            console.warn('[XHS] 角色主页读取失败，回退到真实账号主页:', localProfileError);
            return runXhsMyProfile({}, agenticCtx);
        }
    };

    /** 执行一个回连工具，顺带本机界面上的状态栏、提示和系统消息。返回值原样交回模型。 */
    const runLocalTool = async (name: string, args: any): Promise<unknown> => {
        switch (name) {
            case 'recall': {
                setRecallStatus(`正在调阅 ${args.year}年${Number(args.month)}月 的详细档案...`);
                const r = await runRecall(args, agenticCtx);
                if (r.ok && r.logsText) addToast(`已调用 ${r.yearMonth} 详细记忆`, 'info');
                return r;
            }
            case 'web_search': {
                console.log('🔍 [Search] AI触发搜索:', args.query);
                setSearchStatus(`正在搜索: ${args.query}...`);
                const r = await runSearch(args, agenticCtx);
                if (r.ok) addToast(`🔍 搜索完成: ${args.query}`, 'success');
                else if (r.reason !== 'no_api_key') addToast(`搜索失败: ${r.message}`, 'error');
                return r;
            }
            case 'notion_read_diary': {
                setDiaryStatus(`正在翻阅 ${parseDiaryDate(args.date) || args.date} 的日记...`);
                const r = await runReadDiary(args, agenticCtx);
                if (r.ok) addToast(`📖 ${char.name}翻阅了${r.date}的日记`, 'info');
                return r;
            }
            case 'feishu_read_diary': {
                setDiaryStatus(`正在翻阅 ${parseDiaryDate(args.date) || args.date} 的飞书日记...`);
                const r = await runFsReadDiary(args, agenticCtx);
                if (r.ok) addToast(`📖 ${char.name}翻阅了${r.date}的飞书日记`, 'info');
                return r;
            }
            case 'read_note': {
                setDiaryStatus(`正在翻阅笔记: ${args.keyword}...`);
                const r = await runReadNote(args, agenticCtx);
                if (r.ok) addToast(`📝 ${char.name}翻阅了关于"${args.keyword}"的笔记`, 'info');
                return r;
            }
            case 'xhs_search': {
                setXhsStatus(`正在小红书搜索: ${args.keyword}...`);
                const r = await runXhsSearch(args, agenticCtx);
                if (r.ok) {
                    await replyStep(async () => persistMessage({
                        charId: char.id,
                        role: 'system',
                        type: 'text',
                        content: `📕 ${char.name}在小红书搜索了「${args.keyword}」，看了 ${r.notes.length} 条笔记`,
                    }));
                    addToast(`📕 ${char.name}搜索了小红书: ${args.keyword}`, 'info');
                }
                return r;
            }
            case 'xhs_browse': {
                setXhsStatus('正在刷小红书...');
                const r = await runXhsBrowse(args, agenticCtx);
                if (r.ok) addToast(`📕 ${char.name}刷了会儿小红书`, 'info');
                return r;
            }
            case 'xhs_my_profile': {
                setXhsStatus('正在查看小红书主页...');
                const r = await readOwnXhsProfile();
                if (r.ok) addToast(`📕 ${char.name}看了看自己的小红书`, 'info');
                return r;
            }
            case 'xhs_detail': {
                setXhsStatus('正在查看笔记详情...');
                const r = await runXhsDetail(args, agenticCtx);
                if (r.ok) addToast(`📕 ${char.name}看了一条笔记的详情`, 'info');
                else if (r.reason === 'unreachable') addToast(`📕 ${char.name}尝试查看一条笔记（加载失败）`, 'info');
                return r;
            }
            default:
                throw new Error(`Unknown agentic tool: ${name}`);
        }
    };

    /** 本次回复里已经执行过的回连（去重与回喂里的「已经用过的工具」都按它算，跟 worker 的 session.toolCalls 同义）。 */
    const callHistory: ToolCallRecord[] = [];
    /** 连续被打回的重复调用次数，到 MAX_DUPLICATE_TOOL_CALLS 就收尾。 */
    let duplicateToolCalls = 0;

    /** 执行一轮里的全部回连，返回交回模型的那条消息（各结果按调用顺序拼接）。 */
    const runToolBatch = async (calls: ToolCall[], round: number): Promise<string> => {
        // 去重口径同 worker 的 executeToolCalls（串行）：跟「上一次执行成功的调用」同名同参就打回，
        // 抛错的调用不算数。这里按出现顺序判，跟执行谁先完成无关：一个调用的指纹跟前面每一个都不同
        // （也不同于上一轮最后那次）时，前面谁成谁败它都不是重复，直接开跑；否则等前面的结果出来再判。
        const items = calls.map(call => {
            const name = call.function.name;
            const args = JSON.parse(call.function.arguments || '{}');
            return { name, args, fingerprint: toolCallFingerprint(name, args) };
        });
        // 每个调用的结局：duplicate = 被打回没执行；ok = 执行完（含 ok:false 的结果）；thrown = 抛错。
        type Outcome = { kind: 'duplicate' } | { kind: 'ok'; result: unknown } | { kind: 'thrown'; message: string };
        const settled: Array<Promise<Outcome>> = [];
        const channelTails = new Map<string, Promise<unknown>>();
        const historyTail = callHistory.at(-1)?.fingerprint;
        items.forEach((item, i) => {
            const mayRepeat = item.fingerprint === historyTail
                || items.slice(0, i).some(earlier => earlier.fingerprint === item.fingerprint);
            const isDuplicate = async (): Promise<boolean> => {
                if (!mayRepeat) return false;
                const earlier = await Promise.all(settled.slice(0, i));
                let last = historyTail;
                earlier.forEach((outcome, j) => { if (outcome.kind === 'ok') last = items[j].fingerprint; });
                return last === item.fingerprint;
            };
            const channel = TOOL_CHANNEL[item.name] ?? item.name;
            const run = (channelTails.get(channel) ?? Promise.resolve()).then(async (): Promise<Outcome> => {
                if (await isDuplicate()) return { kind: 'duplicate' };
                try {
                    return { kind: 'ok', result: await replyStep(async () => runLocalTool(item.name, item.args)) };
                } catch (error) {
                    ctx.replyRun?.check();
                    console.warn('[PostProcess] 回连工具执行失败', item.name, error);
                    return { kind: 'thrown', message: error instanceof Error ? error.message : String(error) };
                }
            });
            channelTails.set(channel, run.catch(() => {}));
            settled.push(run);
        });
        const outcomes = await Promise.all(settled);

        // 记账和回喂按调用顺序走一遍，跟 worker 逐个执行时的状态一致：重复 +1，执行成功清零并进历史，
        // 抛错两样都不动、回裸的 tool_error。
        const canCallMoreTools = round < DEFAULT_TOOL_ITERATIONS - 2;
        const contents = outcomes.map((outcome, i) => {
            const { name, fingerprint } = items[i];
            if (outcome.kind === 'duplicate') {
                duplicateToolCalls += 1;
                return buildDuplicateToolMessage(name, { canCallMoreTools });
            }
            if (outcome.kind === 'thrown') {
                return JSON.stringify({ ok: false, reason: 'tool_error', message: outcome.message });
            }
            duplicateToolCalls = 0;
            callHistory.push({ name, fingerprint, ran: !neverRan(outcome.result) });
            return buildToolResultMessage({ name, result: outcome.result, history: [...callHistory], canCallMoreTools });
        });
        // 倒数第二轮的结果末尾挂收尾提示，下一轮就是最后一轮（同 worker 的 appendFinalRoundNotice）。
        return appendFinalRoundNotice(contents.map(content => ({ content })), round, DEFAULT_TOOL_ITERATIONS)
            .map(r => r.content)
            .join('\n\n');
    };

    /**
     * 一轮正文的副作用与展示。aiContent 是这一轮的正文；回连标签在这里只剥不执行。
     * isLastRound 决定这一轮没话时补不补一句。
     */
    const processRoundText = async (roundThinkingChain: string | null, isLastRound: boolean): Promise<void> => {
        // 只给云端回放的空回复兜底用（见 Step 6）。
        const recallMatch = aiContent.match(/\[\[RECALL:\s*(\d{4})[-/年](\d{1,2})\]\]/);
        const searchMatch = aiContent.match(/\[\[SEARCH:\s*(.+?)\]\]/);
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
            // app 被杀, 内容也不丢. 前台可见才立即写 (本地路径 + 前台收到的云端回复, fetch 可靠); 后台时不发
            // 这个脆弱的请求 (易被冻结打断, 甚至服务端写成功但响应丢失 → 回前台重试会重复写), 直接留在
            // 队列, 等 drainPendingDiaries 在回前台时补打. 写成功就删掉这条.
            const pendingDiaryId = enqueuePendingDiary({ kind: 'notion', charId: char.id, charName: char.name, title, content, mood: mood || undefined });
            const canWriteDiaryNow = typeof document === 'undefined' || document.visibilityState === 'visible';
            if (canWriteDiaryNow) {
                try {
                    const result = await replyStep(async () => NotionManager.createDiaryPage(
                        realtimeConfig.notionApiKey,
                        realtimeConfig.notionDatabaseId,
                        { title, content, mood: mood || undefined, characterName: char.name }
                    ));

                    if (result.success) {
                        removePendingDiary(pendingDiaryId);
                        console.log('📔 [Diary] 写入成功:', result.url);
                        await replyStep(async () => persistMessage({
                            charId: char.id,
                            role: 'system',
                            type: 'text',
                            content: `📔 ${char.name}写了一篇日记「${title}」`
                        }));
                        addToast(`📔 ${char.name}写了一篇日记!`, 'success');
                    } else {
                        // API 明确拒绝 (配置/权限问题, 重试也没用) → 丢弃 + 报错.
                        removePendingDiary(pendingDiaryId);
                        console.error('📔 [Diary] 写入失败:', result.message);
                        addToast(`日记写入失败: ${result.message}`, 'error');
                    }
                } catch (e) {
                    ctx.replyRun?.check();
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
            await replyStep(async () => persistMessage({
                charId: char.id,
                role: 'system',
                type: 'text',
                content: `📔 ${char.name}想写日记，但日记服务没连上（未配置或已断开），这篇没写成`,
            }));
            aiContent = aiContent.replace(diaryMatch[0], '').trim();
        }

        aiContent = aiContent.replace(/\[\[DIARY:.*?\]\]/gs, '').trim();
        aiContent = aiContent.replace(/\[\[DIARY_START:.*?\]\][\s\S]*?\[\[DIARY_END\]\]/g, '').trim();

        // 回连标签（READ_DIARY / FS_READ_DIARY / READ_NOTE / XHS 查询类）在这里只剥不执行，执行在回连循环里。
        const readDiaryMatch = aiContent.match(/\[\[READ_DIARY:\s*(.+?)\]\]/);
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
                    const result = await replyStep(async () => FeishuManager.createDiaryRecord(
                        realtimeConfig.feishuAppId,
                        realtimeConfig.feishuAppSecret,
                        realtimeConfig.feishuBaseId,
                        realtimeConfig.feishuTableId,
                        { title: fsTitle, content: fsContent, mood: fsMood || undefined, characterName: char.name }
                    ));

                    if (result.success) {
                        removePendingDiary(pendingFsDiaryId);
                        console.log('📒 [Feishu] 写入成功:', result.recordId);
                        await replyStep(async () => persistMessage({
                            charId: char.id,
                            role: 'system',
                            type: 'text',
                            content: `📒 ${char.name}写了一篇日记「${fsTitle}」(飞书)`
                        }));
                        addToast(`📒 ${char.name}写了一篇日记! (飞书)`, 'success');
                    } else {
                        removePendingDiary(pendingFsDiaryId);
                        console.error('📒 [Feishu] 写入失败:', result.message);
                        addToast(`飞书日记写入失败: ${result.message}`, 'error');
                    }
                } catch (e) {
                    ctx.replyRun?.check();
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
            await replyStep(async () => persistMessage({
                charId: char.id,
                role: 'system',
                type: 'text',
                content: `📒 ${char.name}想写日记，但日记服务没连上（未配置或已断开），这篇没写成`,
            }));
            aiContent = aiContent.replace(fsDiaryMatch[0], '').trim();
        }

        aiContent = aiContent.replace(/\[\[FS_DIARY:.*?\]\]/gs, '').trim();
        aiContent = aiContent.replace(/\[\[FS_DIARY_START:.*?\]\][\s\S]*?\[\[FS_DIARY_END\]\]/g, '').trim();

        const fsReadDiaryMatch = aiContent.match(/\[\[FS_READ_DIARY:\s*(.+?)\]\]/);
        aiContent = aiContent.replace(/\[\[FS_READ_DIARY:.*?\]\]/g, '').trim();

        aiContent = aiContent.replace(/\[\[READ_NOTE:.*?\]\]/g, '').trim();

        aiContent = aiContent.replace(/\[\[XHS_SEARCH:.*?\]\]/g, '').trim();
        aiContent = aiContent.replace(/\[\[XHS_BROWSE(?::.*?)?\]\]/g, '').trim();

        // 后面几轮的正文同样可能模仿历史写出卡片文本，每轮都扫一遍。
        const roundMimicked = extractMimickedXhsShares(aiContent);
        aiContent = roundMimicked.cleanedContent;
        const roundMimickedShares = [...pendingMimickedShares, ...roundMimicked.shares];
        pendingMimickedShares = [];

        // [[XHS_SHARE: 序号]]
        const xhsShareMatches: Iterable<RegExpMatchArray> = disabledXhsSideEffects ? [] : aiContent.matchAll(/\[\[XHS_SHARE:\s*(\d+)\]\]/g);
        for (const shareMatch of xhsShareMatches) {
            const idx = parseInt(shareMatch[1]) - 1;
            // 注意 truthy 判空: amsg2 push 带回的笔记数组是稀疏重建的 (只有 directive 引用到的
            // 序号有值, 空洞是 null, 见 activeMsgRuntime 的 xhsSession 落库), 越界和空洞同罪.
            const note = idx >= 0 && idx < lastXhsNotesRef.current.length ? lastXhsNotesRef.current[idx] : undefined;
            if (note) {
                sharedXhsCardKeys.add(normalizeXhsCardKey(note.title));
                console.log('📕 [XHS] AI分享笔记卡片:', note.title);
                await replyStep(async () => persistMessage({
                    charId: char.id,
                    role: 'assistant',
                    type: 'xhs_card',
                    content: note.title || '小红书笔记',
                    // 跟正文气泡带同一个标记 (mcdInheritMeta): 主动消息重试时靠它认出"这张卡上一趟已经发过了"
                    metadata: { xhsNote: note, ...(mcdInheritMeta || {}) }
                }));
                setMessages(await replyStep(readRefreshTail));
            } else {
                // 笔记缓冲为空 / 越界 → 卡片发不出来. 云端回复靠 saveXhsSessionNotes 持久化恢复,
                // 走到这里说明恢复也没命中 (TTL 过期 / 跨 session), 留日志便于排查, 不再静默吞掉.
                console.warn('📕 [XHS] XHS_SHARE 序号越界, 跳过卡片', { idx: idx + 1, available: lastXhsNotesRef.current.length });
            }
        }
        aiContent = aiContent.replace(/\[\[XHS_SHARE:\s*\d+\]\]/g, '').trim();

        // 掉格式兜底：把模型模仿历史记录写出的五行纯文本恢复成真正的 xhs_card。
        // 优先复用刚才 search/browse 缓存里的完整 noteId、封面和 xsecToken；缓存丢失时仍给可读卡片。
        for (const parsed of roundMimickedShares) {
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
            await replyStep(async () => persistMessage({
                charId: char.id,
                role: 'assistant',
                type: 'xhs_card',
                content: note.title || '小红书笔记',
                metadata: { xhsNote: note, ...(mcdInheritMeta || {}) },
            }));
            if (parsedKey) sharedXhsCardKeys.add(parsedKey);
        }
        if (roundMimickedShares.length > 0) {
            setMessages(await replyStep(readRefreshTail));
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
                const result = await replyStep(async () => xhsPublish(xhsConf, char, postTitle, postContent, postTags, ctx.replyRun?.signal));
                if (result.success) {
                    console.log('📕 [XHS] 发布成功:', result.noteId);
                    const tagsStr = postTags.length > 0 ? ` #${postTags.join(' #')}` : '';
                    await replyStep(async () => persistMessage({
                        charId: char.id,
                        role: 'system',
                        type: 'text',
                        content: `📕 ${char.name}发了一条小红书「${postTitle}」\n${postContent.slice(0, 200)}${postContent.length > 200 ? '...' : ''}${tagsStr}`
                    }));
                    addToast(`📕 ${char.name}发了一条小红书!`, 'success');
                } else {
                    console.error('📕 [XHS] 发布失败:', result.message);
                    addToast(`小红书发布失败: ${result.message}`, 'error');
                }
            } catch (e) {
                ctx.replyRun?.check();
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
                    const result = await replyStep(async () => xhsComment(xhsConf, noteId, commentContent, xsecToken, ctx.replyRun?.signal));
                    if (result.success) {
                        await replyStep(async () => persistMessage({
                            charId: char.id,
                            role: 'system',
                            type: 'text',
                            content: `📕 ${char.name}在小红书评论了: "${commentContent.slice(0, 100)}${commentContent.length > 100 ? '...' : ''}"`
                        }));
                        addToast(`📕 ${char.name}在小红书留了评论`, 'success');
                    } else {
                        addToast(`评论失败: ${result.message}`, 'error');
                    }
                } catch (e) {
                    ctx.replyRun?.check();
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
                        let result = await replyStep(async () => xhsReplyComment(xhsConf, noteId, xsecToken || '', replyContent, commentId, commentUserId, parentCommentId, ctx.replyRun?.signal));
                        const selectorBroken = !result.success && result.message?.includes('未找到评论');
                        if (selectorBroken) {
                            console.warn(`📕 [XHS] 回复失败(DOM选择器不匹配)，跳过重试直接降级:`, result.message);
                        } else {
                            const replyRetries = [3000, 4000, 5000];
                            for (let i = 0; i < replyRetries.length && !result.success; i++) {
                                console.warn(`📕 [XHS] 回复失败(${i + 1}/${replyRetries.length})，${replyRetries[i] / 1000}秒后重试:`, result.message);
                                await replyStep(async () => new Promise(r => setTimeout(r, replyRetries[i])));
                                result = await replyStep(async () => xhsReplyComment(xhsConf, noteId, xsecToken || '', replyContent, commentId, commentUserId, parentCommentId, ctx.replyRun?.signal));
                            }
                        }
                        if (result.success) {
                            addToast(`📕 ${char.name}回复了一条评论`, 'success');
                        } else {
                            console.warn(`📕 [XHS] 回复失败，降级为 @提及 评论:`, result.message);
                            const fallbackContent = commentAuthorName
                                ? `@${commentAuthorName} ${replyContent}`
                                : replyContent;
                            let fallback = await replyStep(async () => xhsComment(xhsConf, noteId, fallbackContent, xsecToken, ctx.replyRun?.signal));
                            if (!fallback.success) {
                                console.warn(`📕 [XHS] 顶级评论也失败，3秒后重试:`, fallback.message);
                                await replyStep(async () => new Promise(r => setTimeout(r, 3000)));
                                fallback = await replyStep(async () => xhsComment(xhsConf, noteId, fallbackContent, xsecToken, ctx.replyRun?.signal));
                            }
                            if (fallback.success) {
                                addToast(`📕 ${char.name}评论了一条笔记（@提及回复）`, 'success');
                            } else {
                                addToast(`回复失败: ${result.message}`, 'error');
                            }
                        }
                    } catch (e) { ctx.replyRun?.check(); console.error('📕 [XHS] 回复异常:', e); }

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
                    const result = await replyStep(async () => xhsLike(xhsConf, noteId, xsecToken || '', ctx.replyRun?.signal));
                    if (result.success) {
                        addToast(`📕 ${char.name}点赞了一条笔记`, 'success');
                    } else {
                        console.warn('📕 [XHS] 点赞失败:', result.message);
                    }
                } catch (e) { ctx.replyRun?.check(); console.error('📕 [XHS] 点赞异常:', e); }

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
                    const result = await replyStep(async () => xhsFavorite(xhsConf, noteId, xsecToken || '', ctx.replyRun?.signal));
                    if (result.success) {
                        addToast(`📕 ${char.name}收藏了一条笔记`, 'success');
                    } else {
                        console.warn('📕 [XHS] 收藏失败:', result.message);
                    }
                } catch (e) { ctx.replyRun?.check(); console.error('📕 [XHS] 收藏异常:', e); }

            }
        }
        aiContent = aiContent.replace(/\[\[XHS_FAV:.*?\]\]/g, '').trim();

        aiContent = aiContent.replace(/\[\[XHS_MY_PROFILE\]\]/g, '').trim();
        aiContent = aiContent.replace(/\[\[XHS_DETAIL:.*?\]\]/g, '').trim();

        // 二轮 LLM 可能新产生日程标签；在统一动作解析前再消费一次。首次那条已经从 aiContent
        // 剥掉且写入幂等（同活动不重复），因此普通单轮回复不会重放副作用。
        //
        // 这一段是刚刚生成的，所以按「现在」判时段，不跟着首轮那句的 spokenAt 走：两者之间
        // 隔着 RECALL / SEARCH / XHS 几趟往返，隔夜补收的 spokenAt 会把新写的改动整批作废。
        aiContent = await replyStep(async () => consumeScheduleChanges(aiContent, new Date()));

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
        aiContent = await replyStep(async () => ChatParser.parseAndExecuteActions(aiContent, char.id, char.name, addToast, musicHooks, resolveCharTimeZone(char), messageTimestamp, mcdInheritMeta, frozenMusicSong, ctx.replyRun));

        // ─── Step 4: thinking chain（这一轮的思考链挂在这一轮的第一条气泡上）───
        let pendingThinkingChain: string | null = roundThinkingChain;
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
                    await replyStep(async () => persistMessage({
                        charId: char.id,
                        role: 'assistant',
                        type: 'html_card',
                        content: blk.textPreview ? `[HTML卡片] ${blk.textPreview}` : '[HTML卡片]',
                        metadata: mergeAssistantMeta({
                            htmlSource: blk.html,
                            htmlTextPreview: blk.textPreview,
                            ...(mcdInheritMeta || {}),
                        }),
                    } as any));
                    setMessages(await replyStep(readRefreshTail));
                    await replyStep(async () => new Promise(r => setTimeout(r, 300)));
                } catch (e) {
                    ctx.replyRun?.check();
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

        // ─── Step 6: 展示这一轮的正文 ───
        const sanitizedBody = ChatParser.sanitize(aiContent, { keepCitations: true })
            .replace(/\[\[INNER_STATE:\s*[\s\S]*?\]\]/g, '')
            .trim();
        if (sanitizedBody) {
            await replyStep(async () => renderAndPersist(aiContent, pendingThinkingChain));
            spokeAny = true;
        } else if (isLastRound && (skipSecondPassLLM
            // 云端回放：工具在 worker 那边跑过了，只剩标签说明这一轮本来是要回连的。
            ? !!(recallMatch || searchMatch || readDiaryMatch || fsReadDiaryMatch)
            // 本地：回连过模型、整个循环却一句话都没说，至少补一句，避免整轮静默。
            // 只是最后一轮没补话时，前几轮的正文就是输出，不算空回复。
            : toolRounds > 0 && !spokeAny)) {
            await replyStep(async () => renderAndPersist('嗯...', pendingThinkingChain));
        } else {
            setMessages(await replyStep(readRefreshTail));
        }
    };

    /**
     * 本回合前几轮已经执行过的副作用，口径同 worker classifier 的 dropCrossRoundRepeats：
     * 整条 directive 的 JSON 一致才算同一件；同一轮里写了几次就执行几次，后面几轮复述前面
     * 做过的那件，那一次不执行、从正文里剥掉。本地每轮当场执行，所以每件事执行的次数就是
     * 它第一次出现那一轮写的次数，跟云端拼全文后按轮去重的结果一致。
     */
    const seenSideEffects = new Set<string>();
    const dropRepeatedSideEffects = (text: string): string => {
        const scanned = classifyLLMOutput(stripSecondPassTags(text));
        if (scanned.kind !== 'finish') return text;
        const keys = scanned.directives.map(d => JSON.stringify(d));
        const fresh = scanned.directives.filter((_, i) => !seenSideEffects.has(keys[i]));
        keys.forEach(key => seenSideEffects.add(key));
        if (fresh.length === scanned.directives.length) return text;
        console.warn('[PostProcess] 这一轮复述了前面几轮已经执行过的副作用，这一次不执行', keys.filter((key, i) => !fresh.includes(scanned.directives[i])));
        // 有重复时整轮按云端回放那条路重建：没重复的副作用拼回规范标签，正文用分类后剥净的那份。
        return `${reconstructDirectiveTags(fresh as PostProcessDirective[])}${scanned.cleanedText}`;
    };
    /** 带过来的半篇长日记没能接上就丢了，留痕（不记日记内容）。 */
    const traceDroppedDiary = (reason: 'duplicate-limit' | 'request-failed', chars: number): void => {
        console.warn('[PostProcess] 跨轮的长日记没写完就收尾了，这篇没写成', reason);
        appendInstantTraceEntry({ ts: new Date().toISOString(), event: 'diary-carry-dropped', charId: char.id, reason, chars });
    };

    const loopMessages: any[] = [...fullMessages];
    let roundThinkingChain = round1ThinkingChain;
    /** 上一轮没写完、留到这一轮接上的长日记块。 */
    let diaryCarry = '';
    for (let round = 0; ; round++) {
        const scan = skipSecondPassLLM ? null : classifyLLMOutput(aiContent);
        if (!scan || scan.kind !== 'tool-request') {
            if (scan) aiContent = dropRepeatedSideEffects(aiContent);
            await replyStep(async () => processRoundText(roundThinkingChain, true));
            break;
        }
        const isFinalRound = round >= DEFAULT_TOOL_ITERATIONS - 1;
        if (isFinalRound || duplicateToolCalls >= MAX_DUPLICATE_TOOL_CALLS) {
            // 最后一轮写出的调用不执行：执行了也没有下一轮让模型看结果。标签在 processRoundText
            // 里剥掉，正文照常是回复的收尾。连着打回重复调用到阈值时（同 processLLMRound），
            // 这一轮的正文是「等我再查查」这种没有下文的半句，整轮丢掉，只留前几轮说完的。
            const tags = countSecondPassTags(aiContent);
            const count = Object.values(tags).reduce((a, b) => a + b, 0);
            const reason = isFinalRound ? 'final-round' : 'duplicate-limit';
            console.warn(`[PostProcess] 回连轮数用完，${count} 个回连标签不执行、从显示文本剥掉`, reason, tags);
            appendInstantTraceEntry({ ts: new Date().toISOString(), event: 'second-pass-tag-unexecuted', charId: char.id, tags, count, reason });
            if (isFinalRound) {
                aiContent = dropRepeatedSideEffects(aiContent);
            } else {
                // 整轮丢掉时，已经写完整的长日记照常落库；还没写完的那篇留痕。
                const completeDiaries = aiContent.match(COMPLETE_DIARY_BLOCK_RE) ?? [];
                const openDiaryAt = findOpenDiaryStart(aiContent);
                if (openDiaryAt >= 0) traceDroppedDiary('duplicate-limit', aiContent.length - openDiaryAt);
                aiContent = dropRepeatedSideEffects(completeDiaries.join('\n'));
            }
            await replyStep(async () => processRoundText(roundThinkingChain, true));
            break;
        }

        // 长日记块被回连标签劈到两轮时，跟 worker 攒全文再扫同一个结果：这一轮里还没收尾的
        // DIARY_START / FS_DIARY_START 那段先不展示、不执行，拼到下一轮正文前面，等 END 出现时
        // 按整篇执行一次。留下的那段先剥掉回连标签，这一轮已经执行过，下一轮不能再执行。
        const openDiaryAt = findOpenDiaryStart(aiContent);
        if (openDiaryAt >= 0) {
            diaryCarry = stripSecondPassTags(aiContent.slice(openDiaryAt));
            aiContent = aiContent.slice(0, openDiaryAt);
        }
        aiContent = dropRepeatedSideEffects(aiContent);
        toolRounds++;
        await replyStep(async () => processRoundText(roundThinkingChain, false));
        const calls = scan.toolCalls;
        const feedback = await replyStep(async () => runToolBatch(calls, round));
        // 这一轮的正文作为 assistant 上文交回（只剥回连标签），下一轮接着往下说，不丢本轮回复。
        loopMessages.push(
            { role: 'assistant', content: scan.prefix || TOOL_ROUND_PLACEHOLDER },
            { role: 'user', content: feedback },
        );
        const purpose = [...new Set(calls.map(c => TOOL_PURPOSE[c.function.name] ?? '回连'))].join('、');
        let roundData: any;
        try {
            roundData = await replyStep(async () => secondPassFetch(`${baseUrl}/chat/completions`, {
                signal: ctx.replyRun?.signal,
                method: 'POST', headers,
                body: JSON.stringify({ model: effectiveApi.model, messages: loopMessages, temperature: 0.8, max_tokens: dialogueMaxTokens(effectiveApi), stream: false }),
            }, 2, 0, { ...apiLogMeta, purpose }));
        } catch (roundErr: any) {
            ctx.replyRun?.check();
            console.error('[PostProcess] 回连请求失败，用已经展示的内容收尾:', roundErr?.message);
            if (diaryCarry) traceDroppedDiary('request-failed', diaryCarry.length);
            break;
        } finally {
            setRecallStatus('');
            setSearchStatus('');
            setDiaryStatus('');
            setXhsStatus('');
        }
        updateTokenUsage(roundData, historyMsgCount, calls.map(c => c.function.name).join('+'));
        const roundContent = roundData.choices?.[0]?.message?.content || '';
        aiContent = normalizeAiContent(await replyStep(async () => consumeHomeVisitReply(char.id, await consumeFriendFeedMainReply(char.id, roundContent))));
        // 首轮在 Step 1 剥过的，后面几轮同样要剥；历史里的占位符偶尔会被模型照抄进正文。
        aiContent = stripDisabledMonthlyRecall(aiContent, char).split(TOOL_ROUND_PLACEHOLDER).join('').trim();
        if (diaryCarry) {
            aiContent = `${diaryCarry}\n${aiContent}`;
            diaryCarry = '';
        }
        roundThinkingChain = extractThinkingChain(roundData);
    }
}
