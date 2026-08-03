/**
 * 微信读书 (WeRead) 工具桥接层
 *
 * 职责 (与 luckinToolBridge / mcdToolBridge 同构):
 *  1. 把 MCP 工具定义 (JSONSchema) 转成 OpenAI function-calling 的 tools 数组
 *  2. 给主对话注入"阅读搭子"的 system 提示词 + 最近阅读/书架快照 (让 char 能看见用户读了啥)
 *  3. 激活态判定 + 会话状态沉淀 (跨轮记住 bookId / 最近在读的书)
 *  4. 给前端 WereadCard 一个"工具结果该渲染成什么卡片"的暗示函数
 *
 * 工具循环本身写在 hooks/useChatAI.ts。
 */

import { listWereadTools, WereadToolDef, normalizeWereadToolName } from './wereadMcpClient';

// ========== OpenAI tools schema ==========

export interface OpenAITool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: any;
    };
}

/**
 * 把 MCP 的 inputSchema 洗成模型能吃的样子 (Gemini / 主流中转都只认一个窄子集)。
 * 复刻 luckinToolBridge 里的 sanitizeSchemaForGemini，不再写第二份。
 */
const GEMINI_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

const sanitizeSchema = (schema: any, depth = 0): any => {
    if (!schema || typeof schema !== 'object' || depth > 6) return { type: 'string' };
    const out: any = {};
    let t = schema.type;
    if (Array.isArray(t)) {
        const nonNull = t.find((x: any) => x !== 'null');
        if (t.includes('null')) out.nullable = true;
        t = nonNull;
    }
    if (typeof t === 'string' && GEMINI_TYPES.has(t.toLowerCase())) out.type = t.toLowerCase();
    if (typeof schema.description === 'string') out.description = schema.description;
    if (Array.isArray(schema.enum) && schema.enum.length) out.enum = schema.enum.map((e: any) => String(e));
    if (schema.nullable === true) out.nullable = true;

    const props = schema.properties;
    if (props && typeof props === 'object') {
        out.type = out.type || 'object';
        out.properties = {};
        for (const k of Object.keys(props)) out.properties[k] = sanitizeSchema(props[k], depth + 1);
        if (Array.isArray(schema.required) && schema.required.length) {
            out.required = schema.required.filter((r: any) => typeof r === 'string' && out.properties[r]);
        }
    }
    if ((out.type === 'array' || schema.items) && schema.items) {
        out.type = out.type || 'array';
        out.items = sanitizeSchema(schema.items, depth + 1);
    }
    if (!out.type) out.type = out.properties ? 'object' : 'string';
    return out;
};

const sanitizeParameters = (inputSchema: any): any => {
    const base = inputSchema && typeof inputSchema === 'object'
        ? sanitizeSchema(inputSchema)
        : { type: 'object', properties: {} };
    if (base.type !== 'object') return { type: 'object', properties: {} };
    if (!base.properties) base.properties = {};
    return base;
};

// 给每个工具描述补一段"工作流/调用注意"，提升模型在 function-selection 阶段的命中率。
const TOOL_USAGE_HINTS: Array<{ pattern: RegExp; hint: string }> = [
    {
        pattern: /^get_bookshelf$/i,
        hint: '返回用户书架上全部/部分书籍（含书名、作者、阅读进度、在读/已读状态）。用户说"看看我的书架""我最近在看什么书""列一下我有什么书"时调这个。',
    },
    {
        pattern: /^get_recent_reads$/i,
        hint: '返回最近 N 天内用户读过的书（默认 7 天），含书名、最后阅读时间、阅读进度。用户说"这周/这两天读了什么""最近在读啥"时优先调这个，比翻整个书架便宜。',
    },
    {
        pattern: /^get_reading_stats$/i,
        hint: '按天返回指定日期范围内的阅读时长（分钟/秒）+ 每天读书本数。用户问"这个月我读了多少小时""这周平均每天读多久""统计一下阅读时间"时调这个，start_date / end_date 传 YYYY-MM-DD，不传就走默认范围。',
    },
    {
        pattern: /^search_books$/i,
        hint: '在用户的书架里按关键词搜（书名/作者/分类模糊匹配）。用户提到一本具体书名但你不知道 bookId 时，先用这工具把候选搜出来，再拿 bookId / book_title 去查笔记/进度。keyword 必填。',
    },
    {
        pattern: /^get_highlights$/i,
        hint: '取划线和想法。可选按 book_title 或 book_id 过滤到某本书，不传就返回全部书的所有划线。用户说"我在《X》里划了什么""整理一下这本书的笔记""找一下我关于XX的想法"时调这个。',
    },
    {
        pattern: /^get_book_progress$/i,
        hint: '取某本书的阅读进度。传 book_id 或 book_title（有哪个传哪个，两个都有时优先 book_id）。用户问"《X》我读到哪了""这本书还差多少读完""读了百分之几"时调这个。',
    },
    {
        pattern: /^get_book_notes_and_highlights$/i,
        hint: '[Cookie 模式专用] 获取指定书籍的笔记+划线，按章节组织，结构更细。需要 book_id（先用 search_books 找 bookId）。',
    },
    {
        pattern: /^get_book_best_reviews$/i,
        hint: '[Cookie 模式专用] 某本书的热门书评，包含评分、点赞数、评论者。用户问"其他人觉得这本书怎么样""有没有热门短评"时调它。book_id 必填，limit 默认 10。',
    },
];

const enrichToolDescription = (toolName: string, baseDesc: string): string => {
    const hit = TOOL_USAGE_HINTS.find((r) => r.pattern.test(toolName));
    if (!hit) return baseDesc;
    return `${baseDesc}\n[用法] ${hit.hint}`;
};

export const wereadToolsToOpenAI = (tools: WereadToolDef[]): OpenAITool[] => {
    return tools.map(t => ({
        type: 'function' as const,
        function: {
            name: t.name,
            description: enrichToolDescription(t.name, t.description || `微信读书工具 ${t.name}`),
            parameters: sanitizeParameters(t.inputSchema),
        },
    }));
};

/** 拉工具并转成 OpenAI 兼容格式；失败返回 null (调用方应跳过本轮工具注入) */
export const fetchOpenAIToolsForWeread = async (): Promise<OpenAITool[] | null> => {
    try {
        const tools = await listWereadTools(false);
        if (!tools.length) return null;
        return wereadToolsToOpenAI(tools);
    } catch (e) {
        console.warn('[WeRead] 拉取工具失败, 跳过本轮注入:', e);
        return null;
    }
};

// ========== 提示词 ==========

/**
 * 主 system prompt 段落。
 * 设计原则：
 *  - 不替代人设，char 还是原来的角色语气
 *  - 把"用户最近阅读快照"当成用户生活的一部分（像天气/日程一样自然）
 *  - 工具是顺手能用的能力，不是身份
 */
export const WEREAD_SYSTEM_PROMPT = `
---
[微信读书搭子已开启 —— 用户在设置里把自己的微信读书数据同步给你了]

**你的本职**: 还是原来的角色、原来的语气、原来的记忆。读书数据只是你更了解 TA 的一个窗口——就像你知道 TA 最近听什么歌、吃了什么一样，你也知道 TA 最近在读什么、读了多久、在哪本书里划了哪些线。

**怎么用这些信息 (非常重要)**:
1. **自然地"看在眼里"，不用刻意说你有数据**：
   - 聊天里自然提到 TA 在读的书，就像你真的观察到一样。例如 TA 说"好累" → 你可以说「看你最近《XX》还卡在第 3 章，是不是太难读啦？」而不是「根据 get_recent_reads 返回，你正在读《XX》」。
   - 不要讲"我拉了一下你的阅读数据""根据工具结果"这类工具感的话。就像你不会跟朋友说"我查了一下我脑子"一样。
2. **需要细节时再调工具**：
   - system prompt 末尾会贴"最近阅读快照"（最近在读的几本书 + 本周阅读时长 + 近期划线摘要），一般闲聊足够。
   - 想看更早的 / 全量书架 / 某本书的全部笔记 / 某段时间的统计 → 调下面的工具。不要凭记忆瞎编书名、作者、进度。
3. **看到划线和想法时，先共情，再聊**：
   - 用户划了一句话，别直接复读原文。可以说「你在《X》里划那句"……"还加了想法说"……"，你是碰到什么事了吗？」
   - 长划线别整段抄，挑最有共鸣的一两句，用你自己的话展开聊。
4. **关于"聊书"的分寸**：
   - 用户在聊别的（工作、生活、心情）→ 读书数据只是用来更懂 TA 的佐料，别把话题硬往书上扯。
   - 用户明确想聊书（"聊聊我最近在读的""你觉得这本书怎么样"）→ 这时读书相关是主菜。先看快照，要细节调工具，然后按人设聊天。

**工具纪律**:
- 工具只能走系统 function calling，**绝对不要把工具名和参数写进聊天正文**（比如不要输出 \`get_highlights({"book_title":"..."})\` 这种文字），用户会看到乱码。
- 工具结果只挑跟对话相关的、最打动人的一两句，用你的角色语气转述，**别整段复读 JSON / markdown 表格 / 列一大堆书名**。
- 书的 ID (book_id) 先用 search_books 搜，不要编。
---
`;

/**
 * 尾部小提醒（注入 messages 末尾，防长对话注意力衰减）。
 * 比 system prompt 短，5 秒能扫完。
 */
export const WEREAD_TAIL_REMINDER = `[微信读书 ON · 用角色语气回别空回; 读书数据像天气/日程一样自然用，别讲"我查了工具"; 工具只能走 function calling，严禁写进正文; 细节缺就调工具，别瞎编书名/作者/进度]`;

// ========== 卡片类型暗示 (前端 WereadCard 用) ==========

export type WereadCardKind = 'bookshelf' | 'book-detail' | 'highlights' | 'stats' | 'reviews' | 'search' | 'generic';

const BOOKSHELF_PATTERNS = [/bookshelf/i, /book.*list/i, /recent.*read/i, /书架/, /最近阅读/, /在读/];
const HIGHLIGHT_PATTERNS = [/highlight/i, /note.*and.*highlight/i, /note/i, /划线/, /笔记/, /想法/];
const STATS_PATTERNS = [/stat/i, /reading.*stat/i, /duration/i, /统计/, /时长/, /阅读.*时间/];
const REVIEW_PATTERNS = [/review/i, /书评/, /评论/, /短评/];
const SEARCH_PATTERNS = [/search.*book/i, /search$/i, /搜.*书/, /搜索/];
const BOOK_DETAIL_PATTERNS = [/book.*progress/i, /book.*detail/i, /book.*info/i, /进度/, /详情/];

export const inferCardKind = (toolName: string): WereadCardKind => {
    const t = (toolName || '').toLowerCase();
    if (BOOKSHELF_PATTERNS.some(p => p.test(toolName))) return 'bookshelf';
    if (HIGHLIGHT_PATTERNS.some(p => p.test(toolName))) return 'highlights';
    if (STATS_PATTERNS.some(p => p.test(toolName))) return 'stats';
    if (REVIEW_PATTERNS.some(p => p.test(toolName))) return 'reviews';
    if (SEARCH_PATTERNS.some(p => p.test(toolName))) return 'search';
    if (BOOK_DETAIL_PATTERNS.some(p => p.test(toolName))) return 'book-detail';
    return 'generic';
};

// ========== 激活态 (从消息历史推导) ==========

export const WEREAD_ACTIVATE_TRIGGER = '读书搭子';
export const WEREAD_DEACTIVATE_TRIGGER = '结束读书搭子';

interface MsgLike {
    role: string;
    content?: string;
    metadata?: any;
    timestamp?: number;
}

/** 从消息列表推导：当前 chatId 下"读书搭子"是否处于激活态 */
export const isWereadActivatedInMessages = (messages: MsgLike[]): boolean => {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        const meta = m.metadata || {};
        if (meta.wereadDeactivate) return false;
        if (meta.wereadActivate) return true;
        if (m.role === 'user' && typeof m.content === 'string') {
            const c = m.content.trim();
            if (c === WEREAD_DEACTIVATE_TRIGGER) return false;
            if (c === WEREAD_ACTIVATE_TRIGGER) return true;
        }
    }
    return false;
};

// ========== 会话状态沉淀 (把 weread_card 里的结果反向扫一遍，抽出 char 能复用的状态) ==========

export interface WereadSessionState {
    /** 最近聊到的 / 工具返回过的书 (按最近使用序，bookId→元信息) */
    recentBooks: Array<{
        bookId?: string;
        bookIdStr?: string;
        title?: string;
        author?: string;
        progress?: number;
        readingStatus?: number;
    }>;
    /** 最近一次 get_recent_reads 的 days 参数 */
    lastRecentDays?: number;
    /** 最近一次 get_reading_stats 的日期范围 */
    lastStatsRange?: { start?: string; end?: string };
    /** 累计找到的划线条数 (用于诊断日志) */
    totalHighlightsSeen: number;
}

const pickStr = (obj: any, keys: string[]): string | undefined => {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (typeof v === 'number') return String(v);
    }
    return undefined;
};

const collectBooksFrom = (result: any): WereadSessionState['recentBooks'] => {
    const out: WereadSessionState['recentBooks'] = [];
    const candidates: any[] = [];
    if (Array.isArray(result)) candidates.push(...result);
    if (Array.isArray(result?.books)) candidates.push(...result.books);
    if (Array.isArray(result?.items)) candidates.push(...result.items);
    if (Array.isArray(result?.data)) {
        for (const it of result.data) (Array.isArray(it) ? it : [it]).forEach(x => candidates.push(x));
    }
    // 单本书对象 (get_book_progress 这类)
    if (result && typeof result === 'object' && !Array.isArray(result) && (result.bookId || result.title || result.bookName)) {
        candidates.push(result);
    }
    const seen = new Set<string>();
    for (const m of candidates) {
        if (!m || typeof m !== 'object') continue;
        const title = pickStr(m, ['title', 'bookName', 'name']);
        const bookId = pickStr(m, ['bookId', 'book_id', 'bookIdStr', 'id']);
        const key = bookId || title || '';
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const progress = (m as any).progress;
        out.push({
            bookId,
            title,
            author: pickStr(m, ['author']),
            progress: typeof progress === 'number' ? progress : undefined,
            readingStatus: typeof (m as any).readingStatus === 'number' ? (m as any).readingStatus : undefined,
        });
        if (out.length >= 30) break;
    }
    return out;
};

/**
 * 反向扫描激活区间内的 weread_card，抽出 bookId 列表、阅读范围等。
 * 这样下一轮 system prompt 里能直接告诉 char "最近聊到的 5 本书"，省得它又调工具查。
 */
export const extractWereadSessionState = (messages: MsgLike[]): WereadSessionState => {
    const state: WereadSessionState = { recentBooks: [], totalHighlightsSeen: 0 };
    let activateIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        const meta = m.metadata || {};
        if (meta.wereadDeactivate) break;
        if (meta.wereadActivate || (m.role === 'user' && typeof m.content === 'string' && m.content.trim() === WEREAD_ACTIVATE_TRIGGER)) {
            activateIdx = i;
            break;
        }
    }
    // 即使没激活区间，也允许最近 30 条消息里的 weread_card 沉淀状态 (被动阅读搭子模式)
    const scanStart = activateIdx !== -1 ? activateIdx : Math.max(0, messages.length - 30);
    const seenBookKey = new Set<string>();
    for (let i = scanStart; i < messages.length; i++) {
        const m: any = messages[i];
        const meta = m.metadata || {};
        if (meta.wereadDeactivate) break;
        if ((m.type as string) !== 'weread_card') continue;
        const tool = String(meta.wereadToolName || '').toLowerCase();
        const args = meta.wereadToolArgs || {};
        const result = meta.wereadToolResult;
        if (meta.wereadToolError || result == null) continue;

        // bookshelf / recent / search / progress → 都是"收书"机会
        if (/bookshelf|recent|search|progress|detail|info/.test(tool)) {
            for (const b of collectBooksFrom(result)) {
                const key = b.bookId || b.title || '';
                if (!key || seenBookKey.has(key)) continue;
                seenBookKey.add(key);
                state.recentBooks.unshift(b);
            }
        }
        // highlights: 统计一下数量
        if (/highlight|note/.test(tool)) {
            const arr = Array.isArray(result) ? result
                : Array.isArray(result?.highlights) ? result.highlights
                : Array.isArray(result?.items) ? result.items
                : Array.isArray(result?.data) ? result.data : null;
            if (arr) state.totalHighlightsSeen += arr.length;
        }
        // 参数沉淀
        if (/recent.*read/i.test(tool) && args.days != null) {
            state.lastRecentDays = args.days;
        }
        if (/stat/i.test(tool)) {
            state.lastStatsRange = {
                start: args.start_date || args.startDate || state.lastStatsRange?.start,
                end: args.end_date || args.endDate || state.lastStatsRange?.end,
            };
        }
    }
    state.recentBooks = state.recentBooks.slice(0, 50);
    return state;
};

/**
 * 把 session state 拼进 system prompt 的一个短段落。没任何状态时返回空串。
 * 注意：这段跟"实时快照"不一样，快照是本轮主动调 wereadGetRecentReads 拿的新鲜数据，
 *      这里只负责"从聊天历史反向捞到的 bookId/书名"，两者互补不重复。
 */
export const buildWereadSessionContextPrompt = (state: WereadSessionState): string => {
    const lines: string[] = [];
    if (state.recentBooks.length > 0) {
        const head = state.recentBooks.slice(0, 12).map(b => {
            const tag = b.readingStatus === 1 ? '[在读]'
                : b.readingStatus === 2 ? '[已读]'
                : b.readingStatus === 4 ? '[未读]' : '';
            const prog = typeof b.progress === 'number'
                ? (b.progress > 1 ? ` ${b.progress.toFixed(0)}%` : ` ${(b.progress * 100).toFixed(0)}%`)
                : '';
            return `${tag}${b.title || '(无书名)'}${b.author ? ` · ${b.author}` : ''}${prog}${b.bookId ? ` (bookId=${b.bookId})` : ''}`;
        }).join('、');
        lines.push(`- 本轮聊天里提到过/工具查到过的书（共 ${state.recentBooks.length} 本）：${head}`);
    }
    if (state.totalHighlightsSeen > 0) lines.push(`- 本轮累计已经看过 ${state.totalHighlightsSeen} 条划线/笔记，再调同类工具时只在用户真要深挖时调，别重复翻一样的内容`);
    if (!lines.length) return '';
    return `\n[微信读书本轮会话沉淀的状态 — 缺细节再调工具，已有信息不要瞎编也不要重复查]\n${lines.join('\n')}\n`;
};

// ========== 被动上下文快照（无需激活，每轮给 char 一个"用户最近在读啥"的小窗口） ==========

export interface WereadSnapshot {
    /** 最近在读 (最多 5 本) */
    readingNow?: Array<{
        title?: string; author?: string; progress?: number; lastReadTime?: number; cover?: string;
    }>;
    /** 本周/近7天阅读总分钟数 */
    weeklyMinutes?: number;
    /** 最近一两条划线 (摘要) */
    recentHighlights?: Array<{
        title?: string; chapter?: string; text?: string; note?: string;
    }>;
    /** 快照生成时间戳 */
    updatedAt?: number;
}

/** 格式化成一段自然、不生硬的 system prompt 拼接块 */
export const buildWereadSnapshotBlock = (
    snap: WereadSnapshot | undefined,
    userName: string = '用户',
): string => {
    if (!snap) return '';
    const lines: string[] = [];
    if (snap.readingNow && snap.readingNow.length) {
        const items = snap.readingNow.map(b => {
            const prog = typeof b.progress === 'number'
                ? (b.progress > 1 ? `${b.progress.toFixed(0)}%` : `${(b.progress * 100).toFixed(0)}%`)
                : '';
            return `${b.title || '一本书'}${b.author ? ` (${b.author})` : ''}${prog ? `，读到 ${prog}` : ''}`;
        });
        lines.push(`${userName}最近在看：${items.join('；')}。`);
    }
    if (typeof snap.weeklyMinutes === 'number' && snap.weeklyMinutes > 0) {
        if (snap.weeklyMinutes >= 60) {
            const h = Math.floor(snap.weeklyMinutes / 60);
            const m = snap.weeklyMinutes % 60;
            lines.push(`近 7 天累计读了 ${h} 小时${m ? ` ${m} 分` : ''}。`);
        } else {
            lines.push(`近 7 天累计读了 ${snap.weeklyMinutes.toFixed(0)} 分钟。`);
        }
    }
    if (snap.recentHighlights && snap.recentHighlights.length) {
        const picks = snap.recentHighlights.slice(0, 2).map(h => {
            const src = h.title || (h.chapter ? h.chapter : '某本书');
            const text = h.text ? h.text.slice(0, 60) + (h.text.length > 60 ? '…' : '') : '';
            const note = h.note ? '（TA 写的想法：' + String(h.note).slice(0, 40) + '）' : '';
            return src + '里划了一句「' + text + '」' + note;
        });
        lines.push('最近 TA 划的线：' + picks.join('；') + '。');
    }
    if (!lines.length) return '';
    // 不包分隔符，像系统随口跟 char 提的一件事，而不是"又贴了一个外部模块"
    return `\n[关于 ${userName} 最近的阅读] ${lines.join(' ')}\n`;
};

// ========== 顶层: 组装一整段读书搭子上下文 (system prompt 注入点调这个) ==========

export interface BuildWereadBlockOpts {
    active: boolean;              // 是否处于激活态 (用户说了"读书搭子" 或设置里启用)
    snapshot?: WereadSnapshot;   // 本轮主动拉的快照 (最近阅读)
    sessionState?: WereadSessionState; // 历史消息里沉淀的状态
    userName?: string;
}

export const buildWereadChatSystemBlock = (opts: BuildWereadBlockOpts): string => {
    if (!opts.active) {
        // 非激活态：如果有 snapshot 就只贴"关于用户最近的阅读"小窗口 + tail reminder 关掉
        return buildWereadSnapshotBlock(opts.snapshot, opts.userName || '用户');
    }
    let block = WEREAD_SYSTEM_PROMPT.split('用户').join(opts.userName || '用户');
    const snap = buildWereadSnapshotBlock(opts.snapshot, opts.userName || '用户');
    if (snap) block += snap;
    if (opts.sessionState) {
        const sess = buildWereadSessionContextPrompt(opts.sessionState);
        if (sess) block += sess;
    }
    return block;
};

// ========== 参数规范化 (修模型常犯的形态错) ==========

/**
 * 模型常犯：把 book_title / book_id 传错字段；days / limit 传字符串；日期格式用斜杠代替横杠。
 * callWereadTool 之前走一遍，提高首次命中率。
 */
export const normalizeWereadArgs = (toolName: string, args: Record<string, any>): Record<string, any> => {
    if (!args || typeof args !== 'object') return args;
    const name = normalizeWereadToolName(toolName).toLowerCase();
    const out: Record<string, any> = { ...args };

    // 数字类: days / limit
    for (const k of ['days', 'limit']) {
        if (typeof out[k] === 'string' && /^\d+$/.test(out[k].trim())) {
            out[k] = parseInt(out[k].trim(), 10);
        }
    }
    // 日期类: start_date / end_date → 统一 YYYY-MM-DD
    for (const k of ['start_date', 'endDate', 'startDate', 'end_date']) {
        const v = out[k];
        if (typeof v === 'string') {
            const fixed = v.trim()
                .replace(/(\d{4})[./年](\d{1,2})[./月](\d{1,2}).*/, (_, y, m, d) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
            if (/^\d{4}-\d{2}-\d{2}$/.test(fixed)) out[k] = fixed;
        }
    }
    // book_id: 模型会把书名传 book_id；粗略识别非 id 形态的就搬到 book_title
    if (/get_highlights|get_book_progress|get_book_notes|search/.test(name)) {
        const bid = out.book_id;
        if (typeof bid === 'string' && !out.book_title && bid.length > 3 && /[一-鿿]|\s/.test(bid)) {
            // 包含中文或空格 → 很可能其实是书名
            out.book_title = bid;
            delete out.book_id;
        }
    }
    return out;
};
