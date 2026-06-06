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
 * 10. --- 分块 + ChatParser.chunkText (换行 / CJK 空格)
 * 11. per-chunk 引用解析 ([[QUOTE:]]/[QUOTE:]/[回复 "..."]) → replyTo
 * 12. hasDisplayContent + per-chunk sanitize
 * 13. 拟人打字延迟 (setTimeout)
 *
 * Phase 0 保证: 本地 fetch 路径 directives=[] / skipSecondPassLLM=false 行为字节级不变。
 * Phase 1 会让 instant push 路径 directives=[] / skipSecondPassLLM=true (worker 已跑过).
 * Phase 2 会让 worker 端把识别出的副作用 (RECALL/SEARCH/...) 结构化传 directives, 这里只重放。
 */

import { CharacterProfile, UserProfile, Message, Emoji, RealtimeConfig } from '../types';
import { DB } from './db';
import { ChatParser } from './chatParser';
import { NotionManager, FeishuManager, XhsNote } from './realtimeContext';
import { enqueuePendingDiary, removePendingDiary } from './pendingDiary';
import { XhsMcpClient } from './xhsMcpClient';
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

// ─── 模块内辅助 ──────────────────────────────────────────────────────────────

/** 第一遍粗洗 — 剥 <think> / 时间戳 / 历史里漏出的 [聊天]/[通话]/[约会] / 表情包反向 tag */
const normalizeAiContent = (raw: string): string => {
    let cleaned = raw || '';
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

// XHS side-effect helpers (POKE-style: 不抽到 agenticTools, 留给 Phase 2 Round 2 的 directive 重放)

async function xhsPublish(conf: { mcpUrl: string }, title: string, content: string, tags: string[]): Promise<{ success: boolean; noteId?: string; message: string }> {
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
    return { success: r.success, noteId: r.data?.noteId, message: r.error || (r.success ? '发布成功' : '发布失败') };
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
    | { type: 'add_event'; title: string; date: string }
    | { type: 'schedule_message'; time: string; text: string }
    | { type: 'music_action'; verb: string; args: string[] }
    | { type: 'xhs_like'; noteId: string }
    | { type: 'xhs_fav'; noteId: string }
    | { type: 'xhs_comment'; noteId: string; text: string }
    | { type: 'xhs_reply'; noteId: string; commentId: string; text: string }
    | { type: 'xhs_post'; title: string; content: string; tags: string }
    | { type: 'xhs_share'; idx: number }
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
            case 'add_event':
                parts.push(`[[ACTION:ADD_EVENT|${d.title}|${d.date}]]`);
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
}

export interface PostProcessCtx {
    char: CharacterProfile;
    userProfile: UserProfile;
    emojis: Emoji[];
    realtimeConfig?: RealtimeConfig;
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
        contextMsgs,
        fullMessages,
        initialData,
        historyMsgCount,
        mcdInheritMeta,
        xhsCaches,
        api,
        hooks,
        skipSecondPassLLM,
        directives,
        reasoningContent: pushReasoningContent,
    } = ctx;
    const { baseUrl, headers, effectiveApi } = api;
    const {
        setMessages,
        addToast,
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

    // ─── Step 1: 初次粗洗 ───
    let aiContent = replayedTagPrefix ? `${replayedTagPrefix}${rawAiContent}` : rawAiContent;
    aiContent = normalizeAiContent(aiContent);

    // ── 渲染基础设施 (提前声明, 供"执行功能前先展示本轮正文 A" + 末尾展示二轮结果 B 复用) ──
    // 引用/回复标签的匹配 + 清理正则 (提前声明避免 lead-in 渲染时落入 TDZ)。
    const QUOTE_RE_DOUBLE = /\[\[(?:QU[OA]TE|引用)[：:]\s*([\s\S]*?)\]\]/;
    const QUOTE_RE_SINGLE = /\[(?:QU[OA]TE|引用)[：:]\s*([^\]]*)\]/;
    const REPLY_RE_CN = /\[回复\s*[""“]([^""”]*?)[""”](?:\.{0,3})\]\s*[：:]?\s*/;
    const QUOTE_CLEAN_DOUBLE = /\[\[(?:QU[OA]TE|引用)[：:][\s\S]*?\]\]/g;
    const QUOTE_CLEAN_SINGLE = /\[(?:QU[OA]TE|引用)[：:][^\]]*\]/g;
    const REPLY_CLEAN_CN = /\[回复\s*[""“][^""”]*?[""”](?:\.{0,3})\]\s*[：:]?\s*/g;

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
    const renderAndPersist = async (rawContent: string, firstThinkingChain: string | null): Promise<void> => {
        let firstMeta: any = firstThinkingChain ? { thinkingChain: firstThinkingChain } : null;
        const takeMeta = (base: any): any => {
            const merged = firstMeta ? { ...(base || {}), ...firstMeta } : base;
            firstMeta = null;
            return merged;
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
            const pushCand = (s?: string) => { const t = (s || '').trim(); if (t && !candidates.includes(t)) candidates.push(t); };
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
            const truncated = targetMsg.content.length > 10 ? targetMsg.content.slice(0, 10) + '...' : targetMsg.content;
            return { id: targetMsg.id, content: truncated, name: userProfile.name };
        };

        // Quote/Reply 目标 (双语路径用)
        let aiReplyTarget: { id: number, content: string, name: string } | undefined;
        const firstQuoteMatch = rawContent.match(QUOTE_RE_DOUBLE) || rawContent.match(QUOTE_RE_SINGLE) || rawContent.match(REPLY_RE_CN);
        if (firstQuoteMatch) aiReplyTarget = resolveQuoteTarget(firstQuoteMatch[1]);

        let content = ChatParser.sanitize(rawContent, { keepCitations: true });
        content = content.replace(/\[\[INNER_STATE:\s*[\s\S]*?\]\]/g, '').trim();
        if (!content) return;

        const hasTranslationTags = /<翻译>\s*<原文>[\s\S]*?<\/原文>\s*<译文>[\s\S]*?<\/译文>\s*<\/翻译>/.test(content);
        let globalMsgIndex = 0;

        if (hasTranslationTags) {
            // ─── 双语 ───
            const bilingualEmojis: string[] = [];
            let bEm;
            const bEmojiPat = /\[\[SEND_EMOJI:\s*(.*?)\]\]/g;
            while ((bEm = bEmojiPat.exec(content)) !== null) {
                const name = bEm[1].trim();
                if (!bilingualEmojis.includes(name)) bilingualEmojis.push(name);
            }
            content = content.replace(/\[\[SEND_EMOJI:\s*.*?\]\]/g, '').trim();
            const tagPattern = /<翻译>\s*<原文>([\s\S]*?)<\/原文>\s*<译文>([\s\S]*?)<\/译文>\s*<\/翻译>/g;
            let lastIndex = 0;
            let tagMatch;

            while ((tagMatch = tagPattern.exec(content)) !== null) {
                const textBefore = content.slice(lastIndex, tagMatch.index).trim();
                if (textBefore) {
                    const cleaned = ChatParser.sanitize(textBefore);
                    if (cleaned && ChatParser.hasDisplayContent(cleaned)) {
                        const chunks = ChatParser.chunkText(cleaned);
                        for (const chunk of chunks) {
                            if (!chunk) continue;
                            const replyData = globalMsgIndex === 0 ? aiReplyTarget : undefined;
                            await new Promise(r => setTimeout(r, Math.min(Math.max(chunk.length * 50, 500), 2000)));
                            await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: chunk, replyTo: replyData, metadata: takeMeta(mcdInheritMeta) } as any);
                            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                            globalMsgIndex++;
                        }
                    }
                }

                const originalText = ChatParser.sanitize(tagMatch[1].trim());
                const translatedText = ChatParser.sanitize(tagMatch[2].trim());
                if (originalText || translatedText) {
                    const biContent = originalText && translatedText
                        ? `${originalText}\n%%BILINGUAL%%\n${translatedText}`
                        : (originalText || translatedText);
                    const replyData = globalMsgIndex === 0 ? aiReplyTarget : undefined;
                    await new Promise(r => setTimeout(r, Math.min(Math.max(biContent.length * 30, 400), 2000)));
                    await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: biContent, replyTo: replyData, metadata: takeMeta(mcdInheritMeta) } as any);
                    setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                    globalMsgIndex++;
                }

                lastIndex = tagMatch.index + tagMatch[0].length;
            }

            const textAfter = content.slice(lastIndex).trim();
            if (textAfter) {
                const cleaned = ChatParser.sanitize(textAfter.replace(/<\/?翻译>|<\/?原文>|<\/?译文>/g, '').trim());
                if (cleaned && ChatParser.hasDisplayContent(cleaned)) {
                    const chunks = ChatParser.chunkText(cleaned);
                    for (const chunk of chunks) {
                        if (!chunk) continue;
                        const replyData = globalMsgIndex === 0 ? aiReplyTarget : undefined;
                        await new Promise(r => setTimeout(r, Math.min(Math.max(chunk.length * 50, 500), 2000)));
                        await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: chunk, replyTo: replyData, metadata: takeMeta(mcdInheritMeta) } as any);
                        setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                        globalMsgIndex++;
                    }
                }
            }

            for (const emojiName of bilingualEmojis) {
                const foundEmoji = emojis.find(e => e.name === emojiName);
                if (foundEmoji) {
                    await new Promise(r => setTimeout(r, Math.random() * 500 + 300));
                    await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'emoji', content: foundEmoji.url, metadata: takeMeta(mcdInheritMeta) } as any);
                    setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                }
            }
        } else {
            // ─── normal path (splitResponse → chunkText → per-chunk save) ───
            const parts = ChatParser.splitResponse(content);
            for (let partIndex = 0; partIndex < parts.length; partIndex++) {
                const part = parts[partIndex];

                if (part.type === 'emoji') {
                    const foundEmoji = emojis.find(e => e.name === part.content);
                    if (foundEmoji) {
                        await new Promise(r => setTimeout(r, Math.random() * 500 + 300));
                        await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'emoji', content: foundEmoji.url, metadata: takeMeta(mcdInheritMeta) } as any);
                        setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                    }
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
                        await new Promise(r => setTimeout(r, delay));

                        let chunkReplyTarget: { id: number, content: string, name: string } | undefined;
                        const chunkQuoteMatch = chunk.match(QUOTE_RE_DOUBLE) || chunk.match(QUOTE_RE_SINGLE) || chunk.match(REPLY_RE_CN);
                        if (chunkQuoteMatch) {
                            chunkReplyTarget = resolveQuoteTarget(chunkQuoteMatch[1]);
                            chunk = chunk.replace(QUOTE_CLEAN_DOUBLE, '').replace(QUOTE_CLEAN_SINGLE, '').replace(REPLY_CLEAN_CN, '').trim();
                        }

                        const replyData = chunkReplyTarget;

                        if (ChatParser.hasDisplayContent(chunk)) {
                            const cleanChunk = ChatParser.sanitize(chunk);
                            if (cleanChunk) {
                                await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: cleanChunk, replyTo: replyData, metadata: takeMeta(mcdInheritMeta) } as any);
                                setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
                                globalMsgIndex++;
                            }
                        }
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
                    await DB.saveMessage({
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
        console.log('📔 [Diary] 检测到日记意图但未配置Notion');
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
        if (dateInput === '今天') return now.toISOString().split('T')[0];
        if (dateInput === '昨天') { const d = new Date(now); d.setDate(d.getDate() - 1); return d.toISOString().split('T')[0]; }
        if (dateInput === '前天') { const d = new Date(now); d.setDate(d.getDate() - 2); return d.toISOString().split('T')[0]; }
        const daysAgo = dateInput.match(/^(\d+)天前$/);
        if (daysAgo) { const d = new Date(now); d.setDate(d.getDate() - parseInt(daysAgo[1])); return d.toISOString().split('T')[0]; }
        const monthDay = dateInput.match(/(\d{1,2})月(\d{1,2})/);
        if (monthDay) return `${now.getFullYear()}-${monthDay[1].padStart(2, '0')}-${monthDay[2].padStart(2, '0')}`;
        const parsed = new Date(dateInput);
        if (!isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0];
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
                    await DB.saveMessage({
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
        console.log('📒 [Feishu] 检测到日记意图但未配置飞书');
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
                    } else if (fsrdr.reason === 'empty_content') {
                        console.log('📖 [Feishu ReadDiary] 日记内容为空');
                        await diaryFallbackCall('你翻开了飞书日记本但页面是空白的', /\[\[FS_READ_DIARY:.*?\]\]/g);
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
                    { role: 'user', content: `[系统: 你在小红书搜索了"${keyword}"，以下是搜索结果]\n\n${xsr.notesText}\n\n[系统: 你已经看完了搜索结果（注意：以上只是摘要，想看某条笔记的完整正文可以用 [[XHS_DETAIL: noteId]]）。现在请你：\n1. 自然地分享你看到的内容，比如"我刚在小红书搜了一下..."、"诶小红书上有人说..."\n2. 可以评价、吐槽、分享感兴趣的内容\n3. 如果觉得某条笔记特别值得分享，可以用 [[XHS_SHARE: 序号]] 把它作为卡片分享给用户（序号从1开始），可以分享多条\n4. 如果想评论某条笔记，可以用 [[XHS_COMMENT: noteId | 评论内容]]\n5. 如果喜欢某条笔记，可以用 [[XHS_LIKE: noteId]] 点赞，[[XHS_FAV: noteId]] 收藏\n6. 如果想看某条笔记的完整内容和评论区，可以用 [[XHS_DETAIL: noteId]]\n7. 严禁再输出[[XHS_SEARCH:...]]标记]` }
                ];

                data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ model: effectiveApi.model, messages: xhsMessages, temperature: 0.8, max_tokens: 8000, stream: false })
                }, 2, 0, { ...apiLogMeta, purpose: '小红书搜索' });
                updateTokenUsage(data, historyMsgCount, 'xhs-search');
                aiContent = data.choices?.[0]?.message?.content || '';
                aiContent = normalizeAiContent(aiContent);
                await DB.saveMessage({
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
                    { role: 'user', content: `[系统: 你刷了一会儿小红书首页，以下是你看到的内容]\n\n${xbr.notesText}\n\n[系统: 你已经看完了（注意：以上只是摘要，想看某条笔记的完整正文可以用 [[XHS_DETAIL: noteId]]）。现在请你：\n1. 像在跟朋友分享一样，随意聊聊你看到了什么有趣的\n2. 不用全部都提，挑你感兴趣的1-3条聊就行\n3. 可以吐槽、感叹、分享想法\n4. 如果觉得某条笔记特别值得分享，可以用 [[XHS_SHARE: 序号]] 把它作为卡片分享给用户（序号从1开始），可以分享多条\n5. 如果想发一条自己的笔记，可以用 [[XHS_POST: 标题 | 内容 | #标签1 #标签2]]\n6. 如果喜欢某条笔记，可以用 [[XHS_LIKE: noteId]] 点赞，[[XHS_FAV: noteId]] 收藏\n7. 如果想看某条笔记的完整内容和评论区，可以用 [[XHS_DETAIL: noteId]]\n8. 严禁再输出[[XHS_BROWSE]]标记]` }
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

    // [[XHS_SHARE: 序号]]
    const xhsShareMatches: Iterable<RegExpMatchArray> = disabledXhsSideEffects ? [] : aiContent.matchAll(/\[\[XHS_SHARE:\s*(\d+)\]\]/g);
    for (const shareMatch of xhsShareMatches) {
        const idx = parseInt(shareMatch[1]) - 1;
        if (idx >= 0 && idx < lastXhsNotesRef.current.length) {
            const note = lastXhsNotesRef.current[idx];
            console.log('📕 [XHS] AI分享笔记卡片:', note.title);
            await DB.saveMessage({
                charId: char.id,
                role: 'assistant',
                type: 'xhs_card',
                content: note.title || '小红书笔记',
                metadata: { xhsNote: note }
            });
            setMessages(await DB.getRecentMessagesByCharId(char.id, 200));
        } else {
            // 笔记缓冲为空 / 越界 → 卡片发不出来. instant 路径靠 saveXhsSessionNotes 持久化恢复,
            // 走到这里说明恢复也没命中 (TTL 过期 / 跨 session), 留日志便于排查, 不再静默吞掉.
            console.warn('📕 [XHS] XHS_SHARE 序号越界, 跳过卡片', { idx: idx + 1, available: lastXhsNotesRef.current.length });
        }
    }
    aiContent = aiContent.replace(/\[\[XHS_SHARE:\s*\d+\]\]/g, '').trim();

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
            const result = await xhsPublish(xhsConf, postTitle, postContent, postTags);
            if (result.success) {
                console.log('📕 [XHS] 发布成功:', result.noteId);
                const tagsStr = postTags.length > 0 ? ` #${postTags.join(' #')}` : '';
                await DB.saveMessage({
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
                    await DB.saveMessage({
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
                            result = await xhsReplyComment(xhsConf, noteId, xsecToken, replyContent, commentId, commentUserId, parentCommentId);
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
            const xmpr = await runXhsMyProfile({}, agenticCtx);

            if (xmpr.ok) {
                const { nickname, userId, profileStr, feedsStr, gotProfile } = xmpr;

                const profileSection = gotProfile
                    ? `\n\n你的主页信息:\n${profileStr}`
                    : '';

                const cleanedForXhs = aiContent.replace(/\[\[XHS_MY_PROFILE\]\]/g, '').trim() || '让我看看我的小红书...';
                const xhsMessages = [
                    ...fullMessages,
                    { role: 'assistant', content: cleanedForXhs },
                    { role: 'user', content: `[系统: 你打开了自己的小红书]\n\n你的小红书账号昵称: ${nickname || '未知'}${userId ? ` (userId: ${userId})` : ''}${profileSection}\n\n${gotProfile ? '你的笔记' : `搜索「${nickname}」找到的相关笔记`}:\n${feedsStr}\n\n[系统: ${gotProfile ? '以上是你的主页数据。' : '注意，搜索结果可能包含别人的帖子，你需要辨别哪些是你自己发的（看作者名字）。'}现在请你：\n1. 自然地聊聊你看到了什么，"我看了看我的小红书..."、"我之前发的那个帖子..."\n2. 如果想发新笔记，可以用 [[XHS_POST: 标题 | 内容 | #标签1 #标签2]]\n3. 如果想看某条笔记的详细内容，可以用 [[XHS_DETAIL: noteId]]\n4. 严禁再输出[[XHS_MY_PROFILE]]标记]` }
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
            // not_enabled 已被外层 if 排除 — xdr 必为 ok
            if (!xdr.ok) {
                // 兜底防御性 — runXhsDetail 在 not_enabled 时返回 ok:false, 但外层 xhsConf.enabled 已保证不会进入
                aiContent = aiContent.replace(xhsDetailMatch[0], '').trim();
                setXhsStatus('');
                aiContent = aiContent.replace(/\[\[XHS_DETAIL:.*?\]\]/g, '').trim();
                // 继续后面的代码 — 不能 return, 因为后面还有别的 tag 处理
            } else {
                const detailStr = xdr.detailText;
                const detailFailed = xdr.failed;
                const cleanedForXhs = aiContent.replace(/\[\[XHS_DETAIL:.*?\]\]/g, '').trim() || '让我看看这条笔记...';
            const xhsMessages = [
                ...fullMessages,
                { role: 'assistant', content: cleanedForXhs },
                { role: 'user', content: detailFailed
                    ? `[系统: 你尝试打开一条小红书笔记（noteId=${noteId}），但加载失败了]\n\n${detailStr}\n\n[系统: 笔记详情页加载失败了。可能的原因：这条笔记需要先通过搜索或浏览才能打开详情。现在请你：\n1. 自然地告知用户"这条笔记打不开/加载不出来"\n2. 可以建议搜索相关关键词再试: [[XHS_SEARCH: 关键词]]\n3. 严禁再输出[[XHS_DETAIL:...]]标记]`
                    : `[系统: 你点开了一条小红书笔记的详情页（noteId=${noteId}）]\n\n${detailStr}\n\n[系统: 你已经看完了这条笔记的完整内容和评论区。现在请你：\n1. 自然地分享你看到的内容和感受\n2. 如果想评论这条笔记，可以用 [[XHS_COMMENT: ${noteId} | 评论内容]]\n3. 如果想回复某条评论，可以用 [[XHS_REPLY: ${noteId} | commentId | 回复内容]]（commentId 在上面的评论区数据里）\n4. 如果想点赞，可以用 [[XHS_LIKE: ${noteId}]]；想收藏可以用 [[XHS_FAV: ${noteId}]]\n5. 严禁再输出[[XHS_DETAIL:...]]标记]` }
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
                    await DB.saveMessage({
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
            const result = await xhsPublish(xhsConf, postTitle, postContent, postTags);
            if (result.success) {
                console.log('📕 [XHS] 发布成功(profile后):', result.noteId);
                const tagsStr = postTags.length > 0 ? ` #${postTags.join(' #')}` : '';
                await DB.saveMessage({
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

    // ─── Step 3: ChatParser.parseAndExecuteActions ───
    aiContent = await ChatParser.parseAndExecuteActions(aiContent, char.id, char.name, addToast, musicHooks);

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
                await DB.saveMessage({
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
