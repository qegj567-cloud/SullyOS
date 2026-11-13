/**
 * agenticTools — 二轮 LLM 数据工具的纯函数封装
 *
 * 把 "read 类" 工具的 data-fetch 部分集中起来: 本地聊天的 applyAssistantPostProcessing
 * 直接 import 具体 run* 函数, 主动消息 2.0 的 worker 工具循环走 dispatchAgenticTool。
 *
 * - 每个 run* 返回 `{ ok: true, ... } | { ok: false, reason, message? }`
 * - 不调 2nd-pass LLM (这是 applyAssistantPostProcessing / worker 工具循环的事)
 * - 不修改 aiContent (调用方负责)
 * - 不 toast / setStatus (调用方负责)
 * - XHS 工具会修改 ctx.xhsCaches + ctx.lastXhsNotesRef (跨 tool 共享状态)
 */

// 值 import 只允许环境无关叶子（realtimeFetchCore / xhsMcpClient / localDate）——这份文件会被
// amsg worker bundle 原样打包跑在服务端工具循环里；类型统一 import type，不进 bundle。
import type { CharacterProfile, RealtimeConfig, UserProfile } from '../types';
import type { XhsNote } from './realtimeContext';
import {
    performSearch,
    notionGetDiaryByDate,
    notionReadDiaryContent,
    notionReadNoteContent,
    notionSearchUserNotes,
    feishuGetDiaryByDate,
} from './realtimeFetchCore';
import {
    XhsMcpClient,
    extractNotesFromMcpData,
    normalizeNote,
    normalizeXhsComments,
    normalizeXhsLiteDetail,
} from './xhsMcpClient';
import { getLocalDateKey } from './localDate';

// ─── 共用类型 ────────────────────────────────────────────────────────────────

/** XHS 跨 tool 共享状态 — useRef 持有, 在同一会话内累积 */
export interface XhsCaches {
    xsecTokenCache: Map<string, string>;
    noteTitleCache: Map<string, string>;
    commentUserIdCache: Map<string, string>;
    commentAuthorNameCache: Map<string, string>;
    commentParentIdCache: Map<string, string>;
}

/** 解析 char + realtimeConfig 拿到当前 XHS 配置 (per-character override) */
export interface XhsConfig {
    enabled: boolean;
    mcpUrl: string;
    loggedInUserId?: string;
    loggedInNickname?: string;
    userXsecToken?: string;
}

/**
 * 这些工具真正会读的实时配置字段（RealtimeConfig 的凭据子集）。
 *
 * 与 AgenticToolChar 同一个道理：amsg worker 到点只有云端 tool_config 那点数据，拼不出
 * 完整的 RealtimeConfig。声明成窄接口后，浏览器侧传完整 RealtimeConfig 天然满足（结构化
 * 类型，调用点不用改），worker 侧直接把 AmsgToolConfig 递进来也能被类型检查到。
 *
 * 上云的 AmsgToolConfig 直接 extends 这个接口（见 utils/amsgToolPack.ts），所以这里加字段
 * 那边自动跟上——两份字段表靠人工对齐的话，漏一个就是 worker 侧运行时静默拿 undefined。
 */
export interface AgenticToolRealtimeConfig {
    newsEnabled: boolean;
    newsApiKey?: string;
    notionEnabled: boolean;
    notionApiKey?: string;
    notionDatabaseId?: string;
    notionNotesDatabaseId?: string;
    feishuEnabled: boolean;
    feishuAppId?: string;
    feishuAppSecret?: string;
    feishuBaseId?: string;
    feishuTableId?: string;
    xhsMcpConfig?: {
        enabled?: boolean;
        serverUrl?: string;
        loggedInUserId?: string;
        loggedInNickname?: string;
        userXsecToken?: string;
    };
}

// 只读 char.xhsEnabled 一个字段，所以参数就按这个声明（原来要整个 CharacterProfile，
// 声明的依赖比真实的宽太多，amsg worker 那种拼不出完整角色的调用方就只能硬转）。
export function resolveXhsConfig(
    char: { xhsEnabled?: boolean },
    realtimeConfig?: AgenticToolRealtimeConfig,
): XhsConfig {
    const mcpConfig = realtimeConfig?.xhsMcpConfig;
    const mcpAvailable = !!(mcpConfig?.enabled && mcpConfig?.serverUrl);
    const mcpUrl = mcpConfig?.serverUrl || '';
    const loggedInUserId = mcpConfig?.loggedInUserId;
    const loggedInNickname = mcpConfig?.loggedInNickname;
    const userXsecToken = mcpConfig?.userXsecToken;

    // 必须由角色自己的开关显式打开（UI 默认关闭）；不回退到全局 realtimeConfig.xhsEnabled，
    // 与 chatPrompts.ts 的提示词注入门控保持一致。
    return { enabled: !!char.xhsEnabled && mcpAvailable, mcpUrl, loggedInUserId, loggedInNickname, userXsecToken };
}

/**
 * 这些工具真正会读的角色字段（CharacterProfile 的子集）。
 *
 * 为什么单独声明：amsg worker 到点只有云端 tool_pack 那点数据，拼不出完整的
 * CharacterProfile。以前 worker 侧用 `as unknown as CharacterProfile` 硬转，等于把编译器
 * 关掉——这边哪天多读一个字段，worker 侧就悄悄拿到 undefined，还不会报错。声明成窄接口后
 * 浏览器侧传完整 CharacterProfile 天然满足（结构化类型，调用点不用改），worker 侧拼的
 * 对象也终于能被类型检查到。加字段时记得同步 utils/amsgToolPack.ts 的 AmsgToolPack。
 */
export interface AgenticToolChar {
    name: string;
    xhsEnabled?: boolean;
    activeMemoryMonths?: string[];
    memories?: AgenticToolMemory[];
}

/** runRecall 会读的月度总结字段（上云的 AmsgToolPack.memories 也是这个形状）。 */
export interface AgenticToolMemory {
    date: string;
    summary: string;
    mood?: string;
}

export interface AgenticToolCtx {
    signal?: AbortSignal;
    char: AgenticToolChar;
    userProfile: UserProfile;
    realtimeConfig?: AgenticToolRealtimeConfig;
    /** XHS 跨 tool 共享缓存; XHS_SEARCH/BROWSE 写, XHS_DETAIL/COMMENT/REPLY 读 */
    xhsCaches?: XhsCaches;
    /** 上次浏览/搜索得到的笔记列表 (XHS_DETAIL retry 时复用) */
    lastXhsNotesRef?: { current: XhsNote[] };
    /** 工具内部多步操作 (XHS_DETAIL retry / XHS_MY_PROFILE fallback / DIARY read-loop) 透传状态文案 给调用方 UI. 不传则 noop. */
    onProgress?: (channel: 'xhs' | 'diary', text: string) => void;
}

// ─── RECALL ─────────────────────────────────────────────────────────────────

export type RecallResult =
    | { ok: true; alreadyActive: boolean; yearMonth: string; logsText: string | null }
    | { ok: false; reason: 'no_logs'; yearMonth: string };

/**
 * 记忆库里到底存了哪些月份（`YYYY-MM`，升序去重）。
 *
 * 提示词里 `[[RECALL: 年-月]]` 是无条件注入的，但从来没告诉过角色「哪些月份查得到」。
 * 结果就是它不知道有货，多半懒得查，直接凭空编一段"回忆"——要一句一句点名让它查
 * 某个月，它才会去调。把清单摆出来，它自己就知道什么时候该伸手。
 *
 * 匹配的两种日期写法要跟 runRecall 保持一致（`2026-06-15` 和 `2026年6月15日`），
 * 否则会报出一个查不到的月份，比不报还糟。这两个函数放在同一个文件里就是为了这个。
 */
export function listRecallableMonths(memories: AgenticToolMemory[] | undefined): string[] {
    if (!memories?.length) return [];
    const months = new Set<string>();
    for (const mem of memories) {
        const iso = /(\d{4})-(\d{1,2})/.exec(mem.date);
        if (iso) months.add(`${iso[1]}-${iso[2].padStart(2, '0')}`);
        const cn = /(\d{4})年\s*(\d{1,2})\s*月/.exec(mem.date);
        if (cn) months.add(`${cn[1]}-${cn[2].padStart(2, '0')}`);
    }
    return [...months].sort();
}

export async function runRecall(
    args: { year: string; month: string },
    ctx: AgenticToolCtx,
): Promise<RecallResult> {
    const { char } = ctx;
    const targetMonth = `${args.year}-${args.month.padStart(2, '0')}`;
    const alreadyActive = !!char.activeMemoryMonths?.includes(targetMonth);

    if (alreadyActive) {
        return { ok: true, alreadyActive: true, yearMonth: targetMonth, logsText: null };
    }

    if (!char.memories) {
        return { ok: false, reason: 'no_logs', yearMonth: targetMonth };
    }
    const logs = char.memories.filter(mem => {
        return mem.date.includes(targetMonth) || mem.date.includes(`${args.year}年${parseInt(args.month)}月`);
    });
    if (logs.length === 0) {
        return { ok: false, reason: 'no_logs', yearMonth: targetMonth };
    }
    const logsText = logs.map(mem => `[${mem.date}] (${mem.mood || 'normal'}): ${mem.summary}`).join('\n');
    return { ok: true, alreadyActive: false, yearMonth: targetMonth, logsText };
}

// ─── SEARCH ─────────────────────────────────────────────────────────────────

export type SearchResult =
    | { ok: true; query: string; resultsText: string; rawResultCount: number }
    | { ok: false; reason: 'no_api_key' | 'unreachable' | 'no_results'; query: string; message?: string };

/** 不抛异常：performSearch 连网络异常都会 catch 成 success:false（见 realtimeFetchCore）。 */
export async function runSearch(
    args: { query: string },
    ctx: AgenticToolCtx,
): Promise<SearchResult> {
    const { realtimeConfig } = ctx;
    if (!realtimeConfig?.newsEnabled || !realtimeConfig?.newsApiKey) {
        return { ok: false, reason: 'no_api_key', query: args.query };
    }
    const searchResult = await performSearch(args.query, realtimeConfig.newsApiKey, ctx.signal);
    // 「请求没跑通」和「搜过了但没结果」得分开（同 runXhsSearch）。performSearch 的
    // success:false 两种都包：断网、代理 5xx、返回不是 JSON，跟真的零结果混在一起。
    // 都归 no_results 的话，角色会把一次根本没发出去的搜索说成「我刚搜了下，没什么新鲜的」。
    if (!searchResult.reached) {
        return { ok: false, reason: 'unreachable', query: args.query, message: searchResult.message };
    }
    if (!searchResult.success || searchResult.results.length === 0) {
        return { ok: false, reason: 'no_results', query: args.query, message: searchResult.message };
    }
    const resultsText = searchResult.results.map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.description}`
    ).join('\n\n');
    return { ok: true, query: args.query, resultsText, rawResultCount: searchResult.results.length };
}

// ─── READ_DIARY (Notion) ────────────────────────────────────────────────────

export type ReadDiaryResult =
    | { ok: true; date: string; diaryText: string; entryCount: number }
    | { ok: false; reason: 'not_configured' | 'parse_error' | 'unreachable' | 'not_found' | 'empty_content'; date?: string; dateInput?: string };

/** 不抛异常：notion* 系列连网络异常都会 catch 成 success:false（见 realtimeFetchCore）。 */
export async function runReadDiary(
    args: { date: string },
    ctx: AgenticToolCtx,
): Promise<ReadDiaryResult> {
    const { char, realtimeConfig } = ctx;

    if (!realtimeConfig?.notionEnabled || !realtimeConfig?.notionApiKey || !realtimeConfig?.notionDatabaseId) {
        return { ok: false, reason: 'not_configured', dateInput: args.date };
    }

    const targetDate = parseDiaryDate(args.date);
    if (!targetDate) {
        return { ok: false, reason: 'parse_error', dateInput: args.date };
    }

    const findResult = await notionGetDiaryByDate(
        realtimeConfig.notionApiKey,
        realtimeConfig.notionDatabaseId,
        char.name,
        targetDate, ctx.signal,
    );

    // 「查不动」和「那天真没写」是两回事：Notion 凭据过期 / 代理挂了都会走 success:false，
    // 跟没写日记归成同一个 not_found 的话，角色张口就是「你昨天没写日记呀」——把一次
    // 根本没查成的事说成查过了，还顺带替用户断言了一件没发生的事。
    if (!findResult.success) {
        return { ok: false, reason: 'unreachable', date: targetDate };
    }
    if (findResult.entries.length === 0) {
        return { ok: false, reason: 'not_found', date: targetDate };
    }

    ctx.onProgress?.('diary', `找到 ${findResult.entries.length} 篇日记，正在阅读...`);

    const diaryContents: string[] = [];
    for (const entry of findResult.entries) {
        const readResult = await notionReadDiaryContent(
            realtimeConfig.notionApiKey,
            entry.id, ctx.signal,
        );
        if (readResult.success) {
            diaryContents.push(`📔「${entry.title}」(${entry.date})\n${readResult.content}`);
        }
    }

    // 走到这里说明条目找到了、但一篇正文都没读回来 = 全部读取失败。真的空白日记会带着
    // 「（空白日记）」正常入列，到不了这一步。所以 empty_content 的意思是"读失败"，
    // 不是"日记是空的"——agenticToolFeedback 把它当"这次没跑成"处理就是为了这个。
    if (diaryContents.length === 0) {
        return { ok: false, reason: 'empty_content', date: targetDate };
    }

    const diaryText = diaryContents.join('\n\n---\n\n');
    return { ok: true, date: targetDate, diaryText, entryCount: findResult.entries.length };
}

// ─── FS_READ_DIARY (Feishu) ─────────────────────────────────────────────────

// 没有 empty_content：飞书那边正文跟着条目一起返回，找到条目就一定有内容
// （Notion 要逐篇再读一次正文，才会出现「条目找到了、一篇都没读回来」）。
export type FsReadDiaryResult =
    | { ok: true; date: string; diaryText: string; entryCount: number }
    | { ok: false; reason: 'not_configured' | 'parse_error' | 'unreachable' | 'not_found'; date?: string; dateInput?: string };

/** 不抛异常：feishuGetDiaryByDate 连网络异常都会 catch 成 success:false（见 realtimeFetchCore）。 */
export async function runFsReadDiary(
    args: { date: string },
    ctx: AgenticToolCtx,
): Promise<FsReadDiaryResult> {
    const { char, realtimeConfig } = ctx;

    if (!realtimeConfig?.feishuEnabled || !realtimeConfig?.feishuAppId || !realtimeConfig?.feishuAppSecret || !realtimeConfig?.feishuBaseId || !realtimeConfig?.feishuTableId) {
        return { ok: false, reason: 'not_configured', dateInput: args.date };
    }

    const targetDate = parseDiaryDate(args.date);
    if (!targetDate) {
        return { ok: false, reason: 'parse_error', dateInput: args.date };
    }

    const findResult = await feishuGetDiaryByDate(
        realtimeConfig.feishuAppId,
        realtimeConfig.feishuAppSecret,
        realtimeConfig.feishuBaseId,
        realtimeConfig.feishuTableId,
        char.name,
        targetDate, ctx.signal,
    );

    // 同 runReadDiary：飞书 token 拿不到 / 接口报错都是 success:false，跟「那天没写」分开。
    if (!findResult.success) {
        return { ok: false, reason: 'unreachable', date: targetDate };
    }
    if (findResult.entries.length === 0) {
        return { ok: false, reason: 'not_found', date: targetDate };
    }

    ctx.onProgress?.('diary', `找到 ${findResult.entries.length} 篇飞书日记，正在阅读...`);

    // 飞书那边正文是跟着条目一起返回的，不用再逐篇去读。
    const diaryText = findResult.entries
        .map(entry => `📒「${entry.title}」(${entry.date})\n${entry.content}`)
        .join('\n\n---\n\n');
    return { ok: true, date: targetDate, diaryText, entryCount: findResult.entries.length };
}

// ─── READ_NOTE (Notion notes DB) ────────────────────────────────────────────

export type ReadNoteResult =
    | { ok: true; keyword: string; noteText: string; entryCount: number }
    | { ok: false; reason: 'not_configured' | 'unreachable' | 'not_found' | 'empty_content'; keyword: string };

/** 不抛异常：notion* 系列连网络异常都会 catch 成 success:false（见 realtimeFetchCore）。 */
export async function runReadNote(
    args: { keyword: string },
    ctx: AgenticToolCtx,
): Promise<ReadNoteResult> {
    const { realtimeConfig } = ctx;

    if (!realtimeConfig?.notionEnabled || !realtimeConfig?.notionApiKey || !realtimeConfig?.notionNotesDatabaseId) {
        return { ok: false, reason: 'not_configured', keyword: args.keyword };
    }

    const findResult = await notionSearchUserNotes(
        realtimeConfig.notionApiKey,
        realtimeConfig.notionNotesDatabaseId,
        args.keyword,
        3, ctx.signal,
    );

    // 同 runReadDiary：搜不动 ≠ 对方没写过这篇笔记。
    if (!findResult.success) {
        return { ok: false, reason: 'unreachable', keyword: args.keyword };
    }
    if (findResult.entries.length === 0) {
        return { ok: false, reason: 'not_found', keyword: args.keyword };
    }

    ctx.onProgress?.('diary', `找到 ${findResult.entries.length} 篇笔记，正在阅读...`);

    const noteContents: string[] = [];
    for (const entry of findResult.entries) {
        const readResult = await notionReadNoteContent(
            realtimeConfig.notionApiKey,
            entry.id, ctx.signal,
        );
        if (readResult.success) {
            noteContents.push(`📝「${entry.title}」(${entry.date})\n${readResult.content}`);
        }
    }

    // 同 runReadDiary：找到条目却一篇都没读回来 = 全部读取失败，不是"笔记是空的"。
    if (noteContents.length === 0) {
        return { ok: false, reason: 'empty_content', keyword: args.keyword };
    }

    const noteText = noteContents.join('\n\n---\n\n');
    return { ok: true, keyword: args.keyword, noteText, entryCount: findResult.entries.length };
}

// ─── XHS helpers (private, used by run* below) ──────────────────────────────

async function xhsSearchImpl(conf: { mcpUrl: string }, keyword: string, signal?: AbortSignal): Promise<{ success: boolean; notes: XhsNote[]; message?: string }> {
    const r = await XhsMcpClient.search(conf.mcpUrl, keyword, undefined, signal);
    if (!r.success) return { success: false, notes: [], message: r.error };
    const raw = extractNotesFromMcpData(r.data);
    return { success: true, notes: raw.map(n => normalizeNote(n) as XhsNote) };
}

async function xhsBrowseImpl(conf: { mcpUrl: string }, signal?: AbortSignal): Promise<{ success: boolean; notes: XhsNote[]; message?: string }> {
    const r = await XhsMcpClient.getRecommend(conf.mcpUrl, signal);
    if (!r.success) return { success: false, notes: [], message: r.error };
    const unwrapped = r.data?.data && typeof r.data.data === 'object' && !Array.isArray(r.data.data) ? r.data.data : r.data;
    console.log(`📕 [XHS] getRecommend 响应类型: ${typeof r.data}, 是否有 data 嵌套: ${unwrapped !== r.data}, unwrapped keys: ${unwrapped && typeof unwrapped === 'object' ? Object.keys(unwrapped).join(',') : 'N/A'}`);
    const raw = extractNotesFromMcpData(unwrapped);
    if (raw.length === 0 && unwrapped !== r.data) {
        console.log(`📕 [XHS] getRecommend unwrapped 提取为空，用原始数据重试`);
        const raw2 = extractNotesFromMcpData(r.data);
        return { success: true, notes: raw2.map(n => normalizeNote(n) as XhsNote) };
    }
    return { success: true, notes: raw.map(n => normalizeNote(n) as XhsNote) };
}

/** 将笔记列表的 xsecToken 和 title 存入 xhsCaches */
function cacheXsecTokensImpl(caches: XhsCaches | undefined, notes: XhsNote[]): void {
    if (!caches) return;
    for (const n of notes) {
        if (n.noteId && n.xsecToken) caches.xsecTokenCache.set(n.noteId, n.xsecToken);
        if (n.noteId && n.title) caches.noteTitleCache.set(n.noteId, n.title);
    }
}

/** 从 xhsCaches 或 lastXhsNotes 中查找 xsecToken */
function findXsecToken(caches: XhsCaches | undefined, lastXhsNotes: XhsNote[], noteId: string): string | undefined {
    const fromNotes = lastXhsNotes.find(n => n.noteId === noteId)?.xsecToken;
    if (fromNotes) return fromNotes;
    return caches?.xsecTokenCache.get(noteId);
}

// ─── XHS_SEARCH ─────────────────────────────────────────────────────────────

export type XhsSearchResult =
    | { ok: true; keyword: string; notesText: string; notes: XhsNote[] }
    | { ok: false; reason: 'not_enabled' | 'unreachable' | 'no_results'; keyword: string; message?: string };

/** Throws on network/transport error. */
export async function runXhsSearch(
    args: { keyword: string },
    ctx: AgenticToolCtx,
): Promise<XhsSearchResult> {
    const xhsConf = resolveXhsConfig(ctx.char, ctx.realtimeConfig);
    if (!xhsConf.enabled) {
        return { ok: false, reason: 'not_enabled', keyword: args.keyword };
    }
    const result = await xhsSearchImpl(xhsConf, args.keyword, ctx.signal);
    // 「连不上」和「搜过了但没结果」得分开：两者都归成 no_results 的话，角色会把一次
    // 根本没发生的搜索说成「我刚在小红书搜了下，没啥好东西」——一句没发生的事说成
    // 发生过。后台触发时服务器多半就在用户自己电脑上（关机 / 不在同一网络），这条最常走。
    if (!result.success) {
        return { ok: false, reason: 'unreachable', keyword: args.keyword, message: result.message };
    }
    if (result.notes.length === 0) {
        return { ok: false, reason: 'no_results', keyword: args.keyword, message: result.message };
    }
    if (ctx.lastXhsNotesRef) ctx.lastXhsNotesRef.current = result.notes;
    cacheXsecTokensImpl(ctx.xhsCaches, result.notes);
    const notesText = result.notes.map((n, i) =>
        `${i + 1}. [noteId=${n.noteId}]「${n.title}」by ${n.author} (${n.likes}赞)\n   ${n.desc}`
    ).join('\n\n');
    return { ok: true, keyword: args.keyword, notesText, notes: result.notes };
}

// ─── XHS_BROWSE ─────────────────────────────────────────────────────────────

export type XhsBrowseResult =
    | { ok: true; category?: string; notesText: string; notes: XhsNote[] }
    | { ok: false; reason: 'not_enabled' | 'unreachable' | 'no_results'; category?: string; message?: string };

/** Throws on network/transport error. */
export async function runXhsBrowse(
    args: { category?: string },
    ctx: AgenticToolCtx,
): Promise<XhsBrowseResult> {
    const xhsConf = resolveXhsConfig(ctx.char, ctx.realtimeConfig);
    if (!xhsConf.enabled) {
        return { ok: false, reason: 'not_enabled', category: args.category };
    }
    const result = await xhsBrowseImpl(xhsConf, ctx.signal);
    console.log('📕 [XHS] 浏览结果:', result.success, result.message, result.notes?.length || 0);
    // 同 runXhsSearch：连不上 ≠ 刷了但首页是空的。
    if (!result.success) {
        return { ok: false, reason: 'unreachable', category: args.category, message: result.message };
    }
    if (result.notes.length === 0) {
        return { ok: false, reason: 'no_results', category: args.category, message: result.message };
    }
    if (ctx.lastXhsNotesRef) ctx.lastXhsNotesRef.current = result.notes;
    cacheXsecTokensImpl(ctx.xhsCaches, result.notes);
    const notesText = result.notes.map((n, i) =>
        `${i + 1}. [noteId=${n.noteId}]「${n.title}」by ${n.author} (${n.likes}赞)\n   ${n.desc}`
    ).join('\n\n');
    return { ok: true, category: args.category, notesText, notes: result.notes };
}

// ─── XHS_MY_PROFILE ─────────────────────────────────────────────────────────

export type XhsMyProfileResult =
    | { ok: true; nickname: string; userId: string; profileStr: string; feedsStr: string; gotProfile: boolean; notes: XhsNote[] }
    | { ok: false; reason: 'not_enabled' | 'no_identity' | 'unreachable'; message?: string };

/** getUserProfile 挂了会降级去搜昵称；主页和降级搜索都没跑通时回 unreachable（见下面的注释）。 */
export async function runXhsMyProfile(
    _args: Record<string, never>,
    ctx: AgenticToolCtx,
): Promise<XhsMyProfileResult> {
    const xhsConf = resolveXhsConfig(ctx.char, ctx.realtimeConfig);
    if (!xhsConf.enabled) return { ok: false, reason: 'not_enabled' };

    const nickname = xhsConf.loggedInNickname || '';
    const userId = xhsConf.loggedInUserId || '';

    if (!nickname && !userId) {
        return { ok: false, reason: 'no_identity' };
    }

    let profileStr = '';
    let feedsStr = '（获取笔记失败）';
    let gotProfile = false;
    let collectedNotes: XhsNote[] = [];

    if (userId) {
            console.log(`📕 [XHS] 用 getUserProfile(${userId}) 获取主页...`);
            ctx.onProgress?.('xhs', '正在获取主页信息...');
            try {
                const profileResult = await XhsMcpClient.getUserProfile(xhsConf.mcpUrl, userId, xhsConf.userXsecToken, ctx.signal);
                if (profileResult.success && profileResult.data) {
                    const d = profileResult.data;
                    if (typeof d === 'string') {
                        profileStr = d.slice(0, 3000);
                        gotProfile = true;
                    } else {
                        const basicInfo = d.data?.basic_info || d.basic_info;
                        if (basicInfo) {
                            profileStr = JSON.stringify(basicInfo, null, 2).slice(0, 2000);
                        } else {
                            const { notes: _n, ...rest } = (d.data && typeof d.data === 'object' ? d.data : d) as any;
                            profileStr = Object.keys(rest).length > 0
                                ? JSON.stringify(rest, null, 2).slice(0, 2000)
                                : '（主页基本信息暂时无法获取）';
                        }
                        gotProfile = true;
                        const unwrapped = d.data && typeof d.data === 'object' && !Array.isArray(d.data) ? d.data : d;
                        console.log(`📕 [XHS] profile unwrapped keys:`, Object.keys(unwrapped), 'notes isArray:', Array.isArray(unwrapped.notes), 'notes length:', unwrapped.notes?.length);
                        const notes = extractNotesFromMcpData(unwrapped);
                        console.log(`📕 [XHS] extractNotesFromMcpData 返回 ${notes.length} 条笔记`);
                        if (notes.length > 0) {
                            console.log(`📕 [XHS] 第一条笔记原始 keys:`, Object.keys(notes[0]), 'noteCard?', !!notes[0].noteCard, 'id?', notes[0].id || notes[0].noteId);
                            const normalized = notes.map(n => normalizeNote(n) as XhsNote);
                            console.log(`📕 [XHS] 归一化后第一条:`, JSON.stringify(normalized[0]).slice(0, 300));
                            const validNotes = normalized.filter(n => n.noteId);
                            if (validNotes.length === 0) {
                                console.warn(`📕 [XHS] ⚠️ 所有笔记归一化后 noteId 为空！原始数据:`, JSON.stringify(notes[0]).slice(0, 500));
                            }
                            collectedNotes = validNotes.length > 0 ? validNotes : normalized;
                            cacheXsecTokensImpl(ctx.xhsCaches, collectedNotes);
                            feedsStr = collectedNotes.slice(0, 8).map((n, i) =>
                                `${i + 1}. [noteId=${n.noteId}]「${n.title || '无标题'}」by ${n.author || '未知'} (${n.likes || 0}赞)\n   ${n.desc || '（无描述）'}`
                            ).join('\n\n');
                            console.log(`📕 [XHS] feedsStr 预览:`, feedsStr.slice(0, 300));
                        } else {
                            console.warn(`📕 [XHS] ⚠️ extractNotesFromMcpData 返回空数组! unwrapped:`, JSON.stringify(unwrapped).slice(0, 500));
                        }
                    }
                    console.log(`📕 [XHS] getUserProfile 成功，数据长度: ${profileStr.length}`);
                }
            } catch (e) {
                console.warn('📕 [XHS] getUserProfile 失败，降级到搜索:', e);
            }
        }

    // 主页没打开成功时的退路：拿昵称去搜。这里必须把「搜不动」和「搜过了没有」分开——
    // 以前两种都写成 feedsStr='（没有搜到相关笔记）' 再回 ok:true，护栏只认 ok:false，
    // 于是角色照着说「我翻了下我的小红书，一条都没找到」。小红书服务器多半在用户自己
    // 电脑上，后台到点时人睡了机器关了，这条走得最勤，也就骗得最勤。
    if (!gotProfile) {
        if (!nickname) {
            // 只有 userId，主页请求又挂了，连降级都没得降 —— 这一趟什么都没读到。
            return { ok: false, reason: 'unreachable' };
        }
        console.log(`📕 [XHS] 降级: 用昵称「${nickname}」搜索...`);
        ctx.onProgress?.('xhs', '正在搜索你的笔记...');
        const searchResult = await xhsSearchImpl(xhsConf, nickname, ctx.signal);
        if (!searchResult.success) {
            return { ok: false, reason: 'unreachable', message: searchResult.message };
        }
        if (searchResult.notes.length > 0) {
            collectedNotes = searchResult.notes;
            cacheXsecTokensImpl(ctx.xhsCaches, searchResult.notes);
            feedsStr = searchResult.notes.slice(0, 8).map((n, i) =>
                `${i + 1}. [noteId=${n.noteId}]「${n.title}」by ${n.author} (${n.likes}赞)\n   ${n.desc || '（无描述）'}`
            ).join('\n\n');
        } else {
            // 真的搜了、真的一条都没有，这句才说得出口
            feedsStr = '（没有搜到相关笔记）';
        }
    }

    if (ctx.lastXhsNotesRef && collectedNotes.length > 0) {
        ctx.lastXhsNotesRef.current = collectedNotes;
    }

    return { ok: true, nickname, userId, profileStr, feedsStr, gotProfile, notes: collectedNotes };
}

// ─── XHS_DETAIL ─────────────────────────────────────────────────────────────

export type XhsDetailResult =
    | { ok: true; noteId: string; detailText: string; commentsUnavailable: boolean }
    | { ok: false; reason: 'not_enabled' | 'unreachable'; noteId: string; message?: string };

/** 详情没读到时（一个字都没拿回来 / 回了 200 但正文是一句报错）一律回 unreachable。 */
export async function runXhsDetail(
    args: { noteId: string },
    ctx: AgenticToolCtx,
): Promise<XhsDetailResult> {
    const xhsConf = resolveXhsConfig(ctx.char, ctx.realtimeConfig);
    if (!xhsConf.enabled) return { ok: false, reason: 'not_enabled', noteId: args.noteId };

    const lastNotes = ctx.lastXhsNotesRef?.current ?? [];
    let xsecToken = findXsecToken(ctx.xhsCaches, lastNotes, args.noteId);
    console.log(`📕 [XHS] AI要查看笔记详情:`, args.noteId, xsecToken ? '(有xsecToken)' : '(无xsecToken)');

    let result = await XhsMcpClient.getNoteDetail(xhsConf.mcpUrl, args.noteId, xsecToken, { loadAllComments: true }, ctx.signal);

        if (!result.success || !result.data) {
            const cachedTitle = ctx.xhsCaches?.noteTitleCache.get(args.noteId);
            if (cachedTitle) {
                console.log(`📕 [XHS] 详情失败，尝试重新搜索「${cachedTitle}」以刷新 xsecToken...`);
                ctx.onProgress?.('xhs', '正在刷新访问凭证...');
                const refreshResult = await xhsSearchImpl(xhsConf, cachedTitle, ctx.signal);
                if (refreshResult.success && refreshResult.notes.length > 0) {
                    cacheXsecTokensImpl(ctx.xhsCaches, refreshResult.notes);
                    if (ctx.lastXhsNotesRef) ctx.lastXhsNotesRef.current = refreshResult.notes;
                    const refreshedNote = refreshResult.notes.find(n => n.noteId === args.noteId);
                    if (refreshedNote?.xsecToken) {
                        xsecToken = refreshedNote.xsecToken;
                        console.log(`📕 [XHS] 拿到新 xsecToken，重试 detail...`);
                        ctx.onProgress?.('xhs', '正在查看笔记详情...');
                        result = await XhsMcpClient.getNoteDetail(xhsConf.mcpUrl, args.noteId, xsecToken, { loadAllComments: true }, ctx.signal);
                    } else {
                        console.warn(`📕 [XHS] 重新搜索结果中未找到 noteId=${args.noteId}`);
                    }
                } else {
                    console.warn(`📕 [XHS] 重新搜索「${cachedTitle}」失败:`, refreshResult.message);
                }
            } else {
                console.warn(`📕 [XHS] 详情失败且无缓存标题，无法重试`);
            }
        }

        // detail 自带的 xsecToken / 评论结构 写回缓存
        if (result.success && result.data && typeof result.data === 'object') {
            const d = result.data;
            const noteObj = (d as any).data?.note || (d as any).note || d;
            const detailToken = noteObj?.xsecToken || noteObj?.xsec_token
                || (d as any).data?.xsecToken || (d as any).data?.xsec_token
                || (d as any).xsecToken || (d as any).xsec_token;
            if (detailToken && args.noteId && ctx.xhsCaches) {
                ctx.xhsCaches.xsecTokenCache.set(args.noteId, detailToken);
                console.log(`📕 [XHS] 从 detail 缓存 xsecToken: ${args.noteId}`);
            }

            const normalizedComments = normalizeXhsComments(d);
            if (ctx.xhsCaches) {
                const caches = ctx.xhsCaches;
                const cacheComments = (comments: ReturnType<typeof normalizeXhsComments>) => {
                    for (const c of comments) {
                        if (c.commentId && c.userId) caches.commentUserIdCache.set(c.commentId, c.userId);
                        if (c.commentId && c.author) caches.commentAuthorNameCache.set(c.commentId, c.author);
                        if (c.commentId && c.parentCommentId) {
                            caches.commentParentIdCache.set(c.commentId, c.parentCommentId);
                        }
                        cacheComments(c.subComments);
                    }
                };
                if (normalizedComments.length > 0) {
                    cacheComments(normalizedComments);
                    console.log(`📕 [XHS] 缓存了 ${caches.commentUserIdCache.size} 条评论的 userId, ${caches.commentAuthorNameCache.size} 条 authorName`);
                } else {
                    console.warn(`📕 [XHS] 未找到评论数组, d keys:`, Object.keys(d as any), 'd.note keys:', (d as any).note ? Object.keys((d as any).note) : 'N/A');
                }
            }

            // XHS_DETAIL 已经拿到正文和评论，补回搜索结果中的同一张卡。
            // 后续 XHS_SHARE 直接复用这里的数据，不额外发起详情请求。
            if (ctx.lastXhsNotesRef) {
                const detailNote = normalizeXhsLiteDetail(d);
                const matched = ctx.lastXhsNotesRef.current.find(n => n.noteId === args.noteId);
                const enriched: XhsNote = {
                    ...matched,
                    ...detailNote,
                    noteId: detailNote.noteId || args.noteId,
                    title: detailNote.title || matched?.title || '',
                    desc: detailNote.desc || matched?.desc || '',
                    author: detailNote.author || matched?.author || '',
                    authorId: detailNote.authorId || matched?.authorId || '',
                    xsecToken: detailNote.xsecToken || detailToken || xsecToken || matched?.xsecToken,
                    url: matched?.url || detailNote.url,
                    xsecSource: matched?.xsecSource || detailNote.xsecSource,
                    comments: detailNote.comments || matched?.comments,
                };
                const index = ctx.lastXhsNotesRef.current.findIndex(n => n.noteId === args.noteId);
                if (index >= 0) {
                    ctx.lastXhsNotesRef.current = ctx.lastXhsNotesRef.current.map((note, i) =>
                        i === index ? enriched : note
                    );
                }
            }
        }

        const detailData = result.success ? result.data : null;
        let detailText: string;
        let commentsUnavailable = false;
        if (detailData) {
            if (typeof detailData === 'string') {
                // 服务器回了 200，正文本身却是一句报错。这跟「一个字都没拿回来」是同一件事：
                // 这次没读到笔记。走同一条 unreachable，别包成「成功但正文是一句报错」。
                if (detailData.includes('失败') || detailData.includes('not found')) {
                    return {
                        ok: false,
                        reason: 'unreachable',
                        noteId: args.noteId,
                        message: detailData.slice(0, 200),
                    };
                }
                detailText = detailData.slice(0, 5000);
            } else {
                const innerData = (detailData as any).data && typeof (detailData as any).data === 'object' ? (detailData as any).data : null;
                const note = innerData?.note || (detailData as any).note || detailData;
                const normalizedNote = normalizeNote(note);
                const noteTitle = normalizedNote.title;
                const noteDesc = normalizedNote.desc.slice(0, 1500);
                const noteAuthor = normalizedNote.author;
                const noteLikes = normalizedNote.likes;
                const noteCollects = normalizedNote.collects;
                const noteShareCount = normalizedNote.shareCount;
                const noteCommentCount = normalizedNote.commentCount;
                const noteTime = note.time ? new Date(note.time).toLocaleString('zh-CN') : '';
                const noteIp = note.ipLocation || note.ip_location || '';

                let noteSection = `📝 笔记详情:\n标题: ${noteTitle}\n作者: ${noteAuthor}`;
                if (noteTime) noteSection += `\n发布时间: ${noteTime}`;
                if (noteIp) noteSection += `\n IP: ${noteIp}`;
                noteSection += `\n互动: ${noteLikes}赞 ${noteCollects}收藏 ${noteCommentCount}评论 ${noteShareCount}分享`;
                noteSection += `\n\n正文:\n${noteDesc}`;

                const commentArr = normalizeXhsComments(detailData);
                const commentsStatus = innerData?.comments_status
                    || (detailData as any).comments_status
                    || innerData?.comment_read_status
                    || (detailData as any).comment_read_status;
                commentsUnavailable = commentsStatus === 'unavailable'
                    || !!innerData?.comments_error
                    || !!(detailData as any).comments_error;

                let commentsSection = '';
                if (commentArr.length > 0) {
                    const formatComment = (c: any, indent = '') => {
                        const name = c.author || '匿名';
                        const content = c.content || '';
                        const likes = c.likes || 0;
                        const cid = c.commentId || '';
                        let line = `${indent}${name}: ${content} (${likes}赞) [commentId=${cid}]`;
                        const subs = c.subComments || [];
                        if (Array.isArray(subs) && subs.length > 0) {
                            line += '\n' + subs.slice(0, 10).map((s: any) => formatComment(s, indent + '  ↳ ')).join('\n');
                        }
                        return line;
                    };
                    commentsSection = `\n\n💬 评论区 (${commentArr.length}条):\n` +
                        commentArr.slice(0, 30).map((c: any) => formatComment(c)).join('\n');
                } else if (commentsUnavailable) {
                    commentsSection = '\n\n💬 评论区: （读取失败；不能据此判断为没有评论，也不要编造评论内容）';
                } else {
                    commentsSection = '\n\n💬 评论区: （暂无评论）';
                }

                detailText = (noteSection + commentsSection).slice(0, 8000);
            }
        } else {
            // 详情一个字都没拿回来（连不上 / 没权限 / 刷新 xsecToken 重试后依然是空）。
            // 以前这里回 ok:true，正文塞一句「[加载失败: …]」：护栏只认 ok:false，于是这条
            // 失败被当成正常结果喂给模型——轻则把报错原文抄进消息，重则直接说「我看了这条笔记」。
            return {
                ok: false,
                reason: 'unreachable',
                noteId: args.noteId,
                message: result.error || '无法获取笔记详情，可能需要先在搜索/浏览结果中看到这条笔记',
            };
        }

    // 走到这里 detailText 一定是真读到的内容：拿不回来和「正文是一句报错」都已经在上面
    // 回了 ok:false。
    return { ok: true, noteId: args.noteId, detailText, commentsUnavailable };
}

// ─── 共用日期解析 (READ_DIARY / FS_READ_DIARY 共用) ─────────────────────────

export function parseDiaryDate(dateInput: string): string {
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
}

// ─── Dispatch (worker 工具循环用) ───────────────────────────────────────────

/**
 * 按 tool name 调度。主动消息 2.0 的 worker 工具循环（worker/amsg/src/index.ts）走这里；
 * 本地聊天不经过此入口, 直接 import 具体 run* 函数。
 */
export async function dispatchAgenticTool(
    toolName: string,
    args: any,
    ctx: AgenticToolCtx,
): Promise<unknown> {
    switch (toolName) {
        case 'recall': return runRecall(args, ctx);
        case 'web_search': return runSearch(args, ctx);
        case 'notion_read_diary': return runReadDiary(args, ctx);
        case 'feishu_read_diary': return runFsReadDiary(args, ctx);
        case 'read_note': return runReadNote(args, ctx);
        case 'xhs_search': return runXhsSearch(args, ctx);
        case 'xhs_browse': return runXhsBrowse(args, ctx);
        case 'xhs_my_profile': return runXhsMyProfile(args, ctx);
        case 'xhs_detail': return runXhsDetail(args, ctx);
        default:
            throw new Error(`Unknown agentic tool: ${toolName}`);
    }
}
