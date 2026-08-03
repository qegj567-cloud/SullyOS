/**
 * 微信读书 (WeRead) MCP 客户端
 *
 * 双模式支持（自动根据配置选择）:
 *  1. 官方 API Key 模式  —— 使用 weread.qq.com 官方 Skill 的 wrk- API Key (mcp-weread, Python)
 *     工具: get_bookshelf, get_reading_stats, get_highlights, get_book_progress, search_books, get_recent_reads
 *  2. Cookie / CookieCloud 模式 —— 使用 mcp-server-weread (Node.js)
 *     工具: get_bookshelf, search_books, get_book_notes_and_highlights, get_book_best_reviews
 *
 * 浏览器无法直连 weread.qq.com / npm 包 stdio, 统一走中心配置的 Cloudflare Worker 透传:
 *   POST <worker>/mcp/weread
 *   Authorization: Bearer <user_configured_token_or_key>
 *   X-Weread-Mode: apikey | cookie   (Worker 路由到对应后端)
 *   body: 标准 JSON-RPC 2.0 报文
 */

import { getProxyWorkerUrl } from './proxyWorker';

// 走中心配置的主代理 worker（用户可在设置里换成自部署实例）
const mcpProxyUrl = (): string => `${getProxyWorkerUrl()}/mcp/weread`;

// localStorage keys
const MODE_KEY = 'aetheros.weread.mode';               // 'apikey' | 'cookie'
const APIKEY_KEY = 'aetheros.weread.apiKey';           // wrk-...
const COOKIE_KEY = 'aetheros.weread.cookie';           // weread.qq.com cookie string
const COOKIECLOUD_KEY = 'aetheros.weread.cookieCloud';  // { url, id, password } JSON
const ENABLED_KEY = 'aetheros.weread.enabled';
const SERVERURL_KEY = 'aetheros.weread.serverUrl';     // 用户自建 MCP 服务器（可选，覆盖中心代理）

// ========== 类型定义 ==========

export type WeReadMode = 'apikey' | 'cookie';

export interface WeReadCookieCloud {
    url: string;        // e.g. https://cc.chenge.ink
    id: string;         // UUID
    password: string;
}

export interface WereadToolDef {
    name: string;
    description?: string;
    inputSchema?: any;
}

export interface WereadToolResult {
    success: boolean;
    data?: any;
    rawText?: string;
    error?: string;
}

// ========== 数据结构（微信读书返回的典型字段，用于类型提示） ==========

export interface WeReadBook {
    bookId?: string;
    bookIdStr?: string;
    title?: string;
    bookName?: string;
    author?: string;
    translator?: string;
    cover?: string;
    coverUrl?: string;
    category?: string;
    progress?: number;       // 0-100 或 0-1
    readingStatus?: number;   // 1=在读, 2=已读, 4=未读
    totalPages?: number;
    readPages?: number;
    lastReadTime?: number;    // timestamp ms
    readingTime?: number;     // 累计阅读秒数
    wordCount?: number;
}

export interface WeReadHighlight {
    bookId?: string;
    chapter?: string;
    chapterUid?: number | string;
    range?: string;
    text?: string;
    markText?: string;
    note?: string;
    abstract?: string;
    style?: number;          // 划线样式
    createTime?: number;
}

export interface WeReadReadingStat {
    date?: string;           // YYYY-MM-DD
    durationMinutes?: number;
    durationSeconds?: number;
    bookCount?: number;
}

export interface WeReadBookReview {
    bookId?: string;
    title?: string;
    author?: string;
    content?: string;
    score?: number;
    likes?: number;
    reviewer?: string;
    createTime?: number;
}

// ========== 配置读写 ==========

export const getWereadMode = (): WeReadMode => {
    try { return (localStorage.getItem(MODE_KEY) as WeReadMode) || 'apikey'; }
    catch { return 'apikey'; }
};
export const setWereadMode = (mode: WeReadMode): void => {
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
};

export const getWereadApiKey = (): string => {
    try { return localStorage.getItem(APIKEY_KEY) || ''; }
    catch { return ''; }
};
export const setWereadApiKey = (key: string): void => {
    try { localStorage.setItem(APIKEY_KEY, key.trim()); } catch { /* ignore */ }
};

export const getWereadCookie = (): string => {
    try { return localStorage.getItem(COOKIE_KEY) || ''; }
    catch { return ''; }
};
export const setWereadCookie = (cookie: string): void => {
    try { localStorage.setItem(COOKIE_KEY, cookie.trim()); } catch { /* ignore */ }
};

export const getWereadCookieCloud = (): WeReadCookieCloud | null => {
    try {
        const raw = localStorage.getItem(COOKIECLOUD_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
};
export const setWereadCookieCloud = (cfg: WeReadCookieCloud | null): void => {
    try {
        if (cfg == null) localStorage.removeItem(COOKIECLOUD_KEY);
        else localStorage.setItem(COOKIECLOUD_KEY, JSON.stringify(cfg));
    } catch { /* ignore */ }
};

export const isWereadEnabled = (): boolean => {
    try { return localStorage.getItem(ENABLED_KEY) === '1'; }
    catch { return false; }
};
export const setWereadEnabled = (enabled: boolean): void => {
    try { localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0'); }
    catch { /* ignore */ }
};

export const getWereadServerUrl = (): string => {
    try { return localStorage.getItem(SERVERURL_KEY) || ''; }
    catch { return ''; }
};
export const setWereadServerUrl = (url: string): void => {
    try { localStorage.setItem(SERVERURL_KEY, url.trim()); }
    catch { /* ignore */ }
};

/**
 * 是否配置好（启用 + 任一鉴权方式非空）。
 * 这里只做最弱的"非空"校验，鉴权对不对由 testWereadConnection 真连一次说了算。
 */
export const isWereadConfigured = (): boolean => {
    if (!isWereadEnabled()) return false;
    const mode = getWereadMode();
    if (mode === 'apikey') return getWereadApiKey().length > 0;
    // cookie 模式：cookie 非空 或 cookieCloud 配了
    if (getWereadCookie().length > 0) return true;
    const cc = getWereadCookieCloud();
    return !!(cc && cc.url && cc.id && cc.password);
};

// ── 备份用：随「设置 → 导出/导入备份」一起带走 ──
export function exportWereadLocal(): Record<string, string> | undefined {
    try {
        const out: Record<string, string> = {};
        const copyKeys = [MODE_KEY, APIKEY_KEY, COOKIE_KEY, COOKIECLOUD_KEY, ENABLED_KEY, SERVERURL_KEY];
        for (const k of copyKeys) {
            const v = localStorage.getItem(k);
            if (v != null) out[k] = v;
        }
        return Object.keys(out).length ? out : undefined;
    } catch { return undefined; }
}
export function importWereadLocal(data: Record<string, string> | null | undefined): void {
    if (!data || typeof data !== 'object') return;
    try {
        const copyKeys = [MODE_KEY, APIKEY_KEY, COOKIE_KEY, COOKIECLOUD_KEY, ENABLED_KEY, SERVERURL_KEY];
        for (const k of copyKeys) {
            if (typeof data[k] === 'string') localStorage.setItem(k, data[k]);
        }
    } catch { /* ignore */ }
}

// ========== JSON-RPC 会话状态 (内存) ==========

interface McpJsonRpcRequest {
    jsonrpc: '2.0';
    method: string;
    params?: any;
    id?: number;
}
interface McpJsonRpcResponse {
    jsonrpc: '2.0';
    id?: number;
    result?: any;
    error?: { code: number; message: string; data?: any };
}

let requestIdCounter = 0;
let sessionId: string | null = null;
let initialized = false;
let cachedTools: WereadToolDef[] = [];
let initPromise: Promise<void> | null = null;

const buildRequest = (method: string, params?: any, isNotification = false): McpJsonRpcRequest => {
    const req: McpJsonRpcRequest = { jsonrpc: '2.0', method, params };
    if (!isNotification) req.id = ++requestIdCounter;
    return req;
};

const parseSse = (text: string): McpJsonRpcResponse | null => {
    const dataLines: string[] = [];
    for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) dataLines.push(line.slice(6));
        else if (line.startsWith('data:')) dataLines.push(line.slice(5));
    }
    for (let i = dataLines.length - 1; i >= 0; i--) {
        try { return JSON.parse(dataLines[i]); } catch { /* try previous */ }
    }
    return null;
};

const parseResp = (text: string, contentType: string): McpJsonRpcResponse => {
    if (contentType.includes('text/event-stream') || /^\s*(event:|data:)/.test(text)) {
        const parsed = parseSse(text);
        if (parsed) return parsed;
    }
    try { return JSON.parse(text); } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
        throw new Error(`WeRead MCP: 无法解析响应: ${text.slice(0, 300)}`);
    }
};

/**
 * 组装请求头:
 *  - 中心代理模式：Authorization: Bearer <apikey 或 cookie>,
 *                  X-Weread-Mode: apikey|cookie,
 *                  可选 X-Weread-Cookiecloud: <json>
 *  - 用户自建服务器模式：按用户配置传 token
 */
const buildFetchHeaders = (): Record<string, string> => {
    const customUrl = getWereadServerUrl();
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    if (customUrl) {
        // 用户自建：如果填了 API Key 当 Bearer 传
        const k = getWereadApiKey();
        if (k) headers['Authorization'] = `Bearer ${k}`;
        return headers;
    }

    // 中心代理
    const mode = getWereadMode();
    headers['X-Weread-Mode'] = mode;
    if (mode === 'apikey') {
        const k = getWereadApiKey();
        if (k) headers['Authorization'] = `Bearer ${k}`;
    } else {
        const ck = getWereadCookie();
        const cc = getWereadCookieCloud();
        if (ck) headers['Authorization'] = `Bearer ${ck}`;
        if (cc) headers['X-Weread-Cookiecloud'] = JSON.stringify(cc);
    }
    return headers;
};

const resolveFetchUrl = (): string => {
    const custom = getWereadServerUrl();
    return custom || mcpProxyUrl();
};

const post = async (
    body: McpJsonRpcRequest,
    expectResponse = true,
): Promise<{ response: McpJsonRpcResponse | null }> => {
    // 基础校验: 至少要有一种鉴权配置
    if (!isWereadConfigured()) {
        // 允许 testWereadConnection 之类的入口带了配置但还没写入 localStorage 的情况走 fetch，
        // 大部分情况这里应该报清楚错，避免后端因空鉴权返回含糊的 4xx。
        throw new Error('微信读书未配置: 请在设置里启用并填入 API Key 或 Cookie');
    }
    const headers = buildFetchHeaders();
    const resp = await fetch(resolveFetchUrl(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    const newSid = resp.headers.get('Mcp-Session-Id') || resp.headers.get('mcp-session-id');
    if (newSid) sessionId = newSid;

    if (resp.status === 401 || resp.status === 403) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`WeRead 鉴权失败 (${resp.status}): ${getWereadMode() === 'apikey' ? 'API Key 可能过期或无效' : 'Cookie 可能失效，请重新获取。如果使用 CookieCloud 检查 URL / ID / 密码是否正确'}. ${txt.slice(0, 120)}`);
    }
    if (resp.status === 202) return { response: null };
    if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`WeRead MCP HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }
    if (!expectResponse) return { response: null };

    const ct = resp.headers.get('content-type') || '';
    const text = await resp.text();
    return { response: parseResp(text, ct) };
};

const doInitialize = async (): Promise<void> => {
    const initReq = buildRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'AetherOS-WeRead', version: '1.0.0' },
    });
    const { response } = await post(initReq);
    if (response?.error) throw new Error(`Initialize 失败: ${response.error.message}`);

    const notif = buildRequest('notifications/initialized', {}, true);
    await post(notif, false).catch(() => { /* notification 失败不阻塞 */ });

    try {
        const { response: toolsResp } = await post(buildRequest('tools/list'));
        if (toolsResp?.result?.tools && Array.isArray(toolsResp.result.tools)) {
            cachedTools = toolsResp.result.tools.map((t: any) => ({
                name: t.name,
                description: t.description || '',
                inputSchema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
            }));
            console.log('[WeRead-MCP] 工具清单:', cachedTools.map(t => t.name).join(', '));
        }
    } catch (e) {
        console.warn('[WeRead-MCP] tools/list 失败:', e);
    }

    initialized = true;
};

const ensureInitialized = async (): Promise<void> => {
    if (initialized) return;
    if (!initPromise) {
        initPromise = doInitialize().catch((e) => {
            initPromise = null;
            throw e;
        });
    }
    await initPromise;
};

/** 强制重置会话 (配置改变 / 退出登录时调用) */
export const resetWereadSession = (): void => {
    initialized = false;
    sessionId = null;
    cachedTools = [];
    initPromise = null;
    requestIdCounter = 0;
};

// ========== 公开: 工具列表 & 通用工具调用 ==========

/** 拉工具清单 (会触发首次 initialize, 之后内存缓存) */
export const listWereadTools = async (forceRefresh = false): Promise<WereadToolDef[]> => {
    if (forceRefresh) resetWereadSession();
    await ensureInitialized();
    return cachedTools;
};

/**
 * 通用工具调用。
 * 与瑞幸/麦当劳同款 JSON 提取管线：混合文本里挖 JSON、递归剥信封、tryDeepParse 等。
 */
export const callWereadTool = async (toolName: string, args: Record<string, any> = {}): Promise<WereadToolResult> => {
    try {
        await ensureInitialized();
        const body = buildRequest('tools/call', { name: toolName, arguments: args });
        const { response } = await post(body);
        if (!response) return { success: false, error: '空响应' };
        if (response.error) return { success: false, error: `MCP 错误 [${response.error.code}]: ${response.error.message}` };

        const result = response.result;
        if (result?.content && Array.isArray(result.content)) {
            const textParts = result.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text || '');
            const fullText = textParts.join('\n').trim();
            if (result.isError) return { success: false, error: fullText || '微信读书工具执行失败', rawText: fullText };

            // === 解析: direct → 混合文本提取 → 实在失败当纯文本 ===
            const repairJson = (s: string): string => {
                let inStr = false, esc = false, out = '';
                for (let i = 0; i < s.length; i++) {
                    const ch = s[i];
                    if (esc) { out += ch; esc = false; continue; }
                    if (ch === '\\') { out += ch; esc = true; continue; }
                    if (ch === '"') { inStr = !inStr; out += ch; continue; }
                    if (inStr && ch === '\n') { out += '\\n'; continue; }
                    if (inStr && ch === '\r') { out += '\\r'; continue; }
                    if (inStr && ch === '\t') { out += '\\t'; continue; }
                    out += ch;
                }
                return out;
            };
            const safeParse = (s: string): any => {
                try { return JSON.parse(s); } catch { /* try repair */ }
                try { return JSON.parse(repairJson(s)); } catch { return undefined; }
            };
            const tryExtractJsonFromMixed = (text: string): any => {
                if (!text) return undefined;
                const direct = safeParse(text);
                if (direct !== undefined) return direct;
                const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
                if (fenceMatch) {
                    const fenced = safeParse(fenceMatch[1].trim());
                    if (fenced !== undefined) return fenced;
                }
                const candidates: any[] = [];
                const tryBalanced = (start: number, open: string, close: string) => {
                    let depth = 0, inStr = false, esc = false;
                    for (let i = start; i < text.length; i++) {
                        const ch = text[i];
                        if (esc) { esc = false; continue; }
                        if (ch === '\\') { esc = true; continue; }
                        if (ch === '"') { inStr = !inStr; continue; }
                        if (inStr) continue;
                        if (ch === open) depth++;
                        else if (ch === close) {
                            depth--;
                            if (depth === 0) {
                                const slice = text.slice(start, i + 1);
                                const parsed = safeParse(slice);
                                if (parsed && typeof parsed === 'object') {
                                    candidates.push({ parsed, len: slice.length });
                                }
                                return;
                            }
                        }
                    }
                };
                for (let i = 0; i < text.length; i++) {
                    if (text[i] === '{') tryBalanced(i, '{', '}');
                    else if (text[i] === '[') tryBalanced(i, '[', ']');
                }
                if (candidates.length) {
                    const score = (obj: any, len: number): number => {
                        let s = Math.min(len, 4000) / 4000;
                        if (!obj || typeof obj !== 'object') return s;
                        if (Array.isArray(obj)) return s + (obj.length > 0 ? 3 : 0);
                        const envKeys = ['success', 'code', 'message', 'data', 'books', 'highlights', 'stats'];
                        const envHits = envKeys.filter(k => k in obj).length;
                        if (envHits >= 2) s += 2;
                        const d = (obj as any).data;
                        if (Array.isArray(d)) s += d.length > 0 ? 6 : -1;
                        else if (d && typeof d === 'object') s += Object.keys(d).length > 0 ? 6 : -1;
                        return s;
                    };
                    candidates.sort((a, b) => score(b.parsed, b.len) - score(a.parsed, a.len));
                    return candidates[0].parsed;
                }
                return undefined;
            };
            const tryDeepParse = (v: any): any => {
                if (typeof v === 'string') {
                    const s = v.trim();
                    if (s.startsWith('{') || s.startsWith('[')) {
                        try { return tryDeepParse(JSON.parse(s)); } catch { return v; }
                    }
                    return v;
                }
                if (v && typeof v === 'object' && !Array.isArray(v)) {
                    const envelopeKeys = ['success', 'code', 'message', 'msg', 'datetime', 'traceId', 'errorCode'];
                    if ('data' in v && envelopeKeys.some(k => k in v)) {
                        const inner = v.data;
                        if (inner && typeof inner === 'object') return tryDeepParse(inner);
                        if (typeof inner === 'string') {
                            const s = inner.trim();
                            if (s.startsWith('{') || s.startsWith('[')) {
                                try { return tryDeepParse(JSON.parse(s)); } catch { /* fall through */ }
                            }
                            return s;
                        }
                        return inner;
                    }
                    const keys = Object.keys(v);
                    const wrapKeys = ['data', 'result', 'response', 'body', 'payload'];
                    if (keys.length === 1 && wrapKeys.includes(keys[0]) && typeof v[keys[0]] === 'string') {
                        const inner = tryDeepParse(v[keys[0]]);
                        if (inner && typeof inner === 'object') return inner;
                    }
                    const out: any = {};
                    for (const k of keys) {
                        const cv = v[k];
                        if (typeof cv === 'string') {
                            const s = cv.trim();
                            if (s.startsWith('{') || s.startsWith('[')) {
                                try { out[k] = JSON.parse(s); continue; } catch { /* ignore */ }
                            }
                        }
                        out[k] = cv;
                    }
                    return out;
                }
                return v;
            };

            let parsed: any = undefined;
            try {
                parsed = JSON.parse(fullText);
            } catch {
                parsed = tryExtractJsonFromMixed(fullText);
            }
            if (parsed !== undefined) {
                const finalData = tryDeepParse(parsed);
                try {
                    const top = finalData && typeof finalData === 'object' && !Array.isArray(finalData)
                        ? Object.keys(finalData).slice(0, 10).join(',')
                        : (Array.isArray(finalData) ? `[Array len=${finalData.length}]` : typeof finalData);
                    console.log(`📚 [WeRead-MCP] 工具 ${toolName} 完成 | topKeys=${top}`);
                } catch { /* ignore */ }
                return { success: true, data: finalData, rawText: fullText };
            }
            console.warn(`📚 [WeRead-MCP] 工具 ${toolName} 解析失败, rawLen=${fullText.length}, 前200字: ${fullText.slice(0, 200)}`);
            return { success: true, data: fullText, rawText: fullText };
        }
        return { success: true, data: result };
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
};

// ========== 公开: 类型安全的便捷方法 (按官方 wrk- API Key 模式的工具名命名) ==========
// 注: Cookie 模式工具名略有不同，但 callWereadTool 通用，这里只做语义封装。

/** 获取书架 (limit 可选，默认全部) */
export const wereadGetBookshelf = (limit?: number): Promise<WereadToolResult> =>
    callWereadTool('get_bookshelf', limit != null ? { limit } : {});

/** 按关键词搜索书架 */
export const wereadSearchBooks = (keyword: string, limit?: number): Promise<WereadToolResult> =>
    callWereadTool('search_books', { keyword, ...(limit != null ? { limit } : {}) });

/** 获取某本书的划线/笔记 (可选按书名过滤) */
export const wereadGetHighlights = (bookTitle?: string, bookId?: string): Promise<WereadToolResult> =>
    callWereadTool('get_highlights', {
        ...(bookTitle ? { book_title: bookTitle } : {}),
        ...(bookId ? { book_id: bookId } : {}),
    });

/** 获取某本书的阅读进度 */
export const wereadGetBookProgress = (bookId?: string, bookTitle?: string): Promise<WereadToolResult> =>
    callWereadTool('get_book_progress', {
        ...(bookId ? { book_id: bookId } : {}),
        ...(bookTitle ? { book_title: bookTitle } : {}),
    });

/** 最近 N 天读过的书 */
export const wereadGetRecentReads = (days = 7): Promise<WereadToolResult> =>
    callWereadTool('get_recent_reads', { days });

/** 每日阅读统计 (日期范围 YYYY-MM-DD) */
export const wereadGetReadingStats = (startDate?: string, endDate?: string): Promise<WereadToolResult> =>
    callWereadTool('get_reading_stats', {
        ...(startDate ? { start_date: startDate } : {}),
        ...(endDate ? { end_date: endDate } : {}),
    });

/** Cookie 模式：某本书的笔记+划线 (返回更细的章节结构) */
export const wereadGetBookNotesAndHighlights = (bookId: string): Promise<WereadToolResult> =>
    callWereadTool('get_book_notes_and_highlights', { book_id: bookId });

/** Cookie 模式：某本书的热门书评 */
export const wereadGetBookBestReviews = (bookId: string, limit = 10): Promise<WereadToolResult> =>
    callWereadTool('get_book_best_reviews', { book_id: bookId, limit });

// ========== 备份导入导出 (与 exportLuckinLocal / exportMcdLocal 同构) ==========

export function exportWereadLocal(): Record<string, string> | undefined {
    try {
        const out: Record<string, string> = {};
        const keys = [
            ENABLED_KEY, MODE_KEY, APIKEY_KEY, COOKIE_KEY,
            COOKIECLOUD_KEY, CUSTOM_SERVER_KEY,
        ];
        for (const k of keys) {
            const v = localStorage.getItem(k);
            if (v) out[k] = v;
        }
        return Object.keys(out).length ? out : undefined;
    } catch { return undefined; }
}

export function importWereadLocal(data: Record<string, string> | null | undefined): void {
    if (!data || typeof data !== 'object') return;
    try {
        const keys = [
            ENABLED_KEY, MODE_KEY, APIKEY_KEY, COOKIE_KEY,
            COOKIECLOUD_KEY, CUSTOM_SERVER_KEY,
        ];
        for (const k of keys) {
            const v = data[k];
            if (typeof v === 'string') localStorage.setItem(k, v);
        }
    } catch { /* ignore */ }
}

/** 测试连接: 验证配置能否成功 initialize + 拿到 tools */
export const testWereadConnection = async (): Promise<{ ok: boolean; message: string; tools?: WereadToolDef[]; mode?: WeReadMode }> => {
    try {
        resetWereadSession();
        const tools = await listWereadTools(false);
        const mode = getWereadMode();
        if (!tools.length) return { ok: true, message: '已连接，但工具清单为空（可能服务侧未挂载工具）', tools, mode };
        return { ok: true, message: `已连接（${mode === 'apikey' ? '官方 API Key 模式' : 'Cookie 模式'}），拿到 ${tools.length} 个工具：${tools.map(t => t.name).join('、')}`, tools, mode };
    } catch (e: any) {
        return { ok: false, message: e?.message || String(e) };
    }
};

/**
 * 工具名规范化。
 * 模型经常加 weread.* / weread_tools_* / functions.* 前缀，或把下划线写成短横线。
 * 这里把名字压平，再跟 cachedTools 做一次双向匹配。
 */
export const normalizeWereadToolName = (toolName: string): string => {
    const raw = (toolName || '').trim();
    if (!raw) return raw;
    let s = raw;
    const lastDot = s.lastIndexOf('.');
    if (lastDot >= 0 && lastDot < s.length - 1) s = s.slice(lastDot + 1);
    s = s
        .replace(/^weread[_-]?tools?[_-]/i, '')
        .replace(/^wr[_-]?tools?[_-]/i, '')
        .replace(/^reading[_-]?tools?[_-]/i, '')
        .trim();
    const name = s || raw;
    // 命中缓存就用原名；否则如果 cachedTools 里有"只差下划线/短横线"的变体，用真实名
    if (cachedTools.some(t => t.name === name)) return name;
    const norm = (x: string) => x.replace(/[-_]/g, '').toLowerCase();
    const hit = cachedTools.find(t => norm(t.name) === norm(name));
    if (hit) return hit.name;
    return name;
};

// ========== 聊天会话层面的触发语 / 快照 ==========

/** 主动激活读书搭子 (工具全开模式) 的触发语 */
export const WEREAD_ACTIVATE_TRIGGER = '读书搭子';
/** 关闭读书搭子 (只保留全局被动快照) 的触发语 */
export const WEREAD_DEACTIVATE_TRIGGER = '结束读书搭子';

/** 把 readingTime 秒数 / 分钟数 尽量识别成分钟，给 weeklyMinutes 用 */
const coerceMinutes = (v: any, fallback = 0): number => {
    if (typeof v === 'number' && isFinite(v)) {
        // 读秒→分钟：一般 readingTime > 180 更像秒数 (3 小时以上的分钟数很少)
        return v > 180 ? Math.round(v / 60) : Math.round(v);
    }
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
        const n = parseInt(v.trim(), 10);
        return n > 180 ? Math.round(n / 60) : n;
    }
    return fallback;
};

const pickBooks = (r: WereadToolResult): Array<{ title?: string; author?: string; progress?: number; lastReadTime?: number; cover?: string }> => {
    if (!r.success) return [];
    const d = r.data;
    const arr = Array.isArray(d) ? d : Array.isArray(d?.books) ? d.books : Array.isArray(d?.items) ? d.items : Array.isArray(d?.data) ? d.data : (d && !Array.isArray(d) && (d.bookId || d.title || d.bookName) ? [d] : []);
    return arr.map((m: any) => ({
        title: typeof m?.title === 'string' ? m.title : (typeof m?.bookName === 'string' ? m.bookName : undefined),
        author: typeof m?.author === 'string' ? m.author : undefined,
        progress: typeof m?.progress === 'number' ? m.progress : undefined,
        lastReadTime: typeof m?.lastReadTime === 'number' ? m.lastReadTime : undefined,
        cover: typeof m?.cover === 'string' ? m.cover : (typeof m?.coverImg === 'string' ? m.coverImg : undefined),
    })).filter(x => x.title || x.author);
};

/**
 * 一次性拿最近阅读快照：最近在读 + 本周阅读时长 + 最近划线。
 * 失败不抛，所有字段都是 "best-effort"，允许缺。
 */
export const getWereadSnapshot = async (): Promise<{
    readingNow: Array<{ title?: string; author?: string; progress?: number; lastReadTime?: number; cover?: string }>;
    weeklyMinutes?: number;
    recentHighlights: Array<{ title?: string; chapter?: string; text?: string; note?: string }>;
    updatedAt: number;
}> => {
    const tryRecent = wereadGetRecentReads({ days: 7 }).catch(e => ({ success: false as const, error: String(e) }));
    const tryStats = wereadGetReadingStats({ days: 7 }).catch(e => ({ success: false as const, error: String(e) }));
    const tryHigh = wereadGetHighlights({ limit: 5 }).catch(e => ({ success: false as const, error: String(e) }));
    const [recent, stats, high] = await Promise.all([tryRecent, tryStats, tryHigh]);

    const readingNow = pickBooks(recent).slice(0, 5);

    // stats 里尽量挑总分钟数：常见字段 totalMinutes / total_seconds / minutes / sum
    let weeklyMinutes: number | undefined;
    if (stats.success) {
        const d = stats.data as any;
        if (typeof d?.totalMinutes === 'number') weeklyMinutes = d.totalMinutes;
        else if (typeof d?.totalSeconds === 'number') weeklyMinutes = Math.round(d.totalSeconds / 60);
        else if (typeof d?.minutes === 'number') weeklyMinutes = d.minutes;
        else if (typeof d?.sum === 'number') weeklyMinutes = coerceMinutes(d.sum);
        else if (typeof d?.readingMinutes === 'number') weeklyMinutes = d.readingMinutes;
        else if (Array.isArray(d?.days) || Array.isArray(d?.items)) {
            const arr = Array.isArray(d.days) ? d.days : d.items;
            let total = 0;
            for (const row of arr) total += coerceMinutes(row?.minutes || row?.readingMinutes || row?.duration || row?.seconds || 0);
            weeklyMinutes = total;
        }
    }

    const recentHighlights: Array<{ title?: string; chapter?: string; text?: string; note?: string }> = [];
    if (high.success) {
        const d = high.data as any;
        const arr = Array.isArray(d) ? d : Array.isArray(d?.highlights) ? d.highlights : Array.isArray(d?.items) ? d.items : Array.isArray(d?.data) ? d.data : [];
        for (const row of arr.slice(0, 3)) {
            if (!row || typeof row !== 'object') continue;
            recentHighlights.push({
                title: typeof row.bookTitle === 'string' ? row.bookTitle : (typeof row.book_name === 'string' ? row.book_name : (typeof row.title === 'string' ? row.title : undefined)),
                chapter: typeof row.chapter === 'string' ? row.chapter : (typeof row.chapterTitle === 'string' ? row.chapterTitle : undefined),
                text: typeof row.text === 'string' ? row.text : (typeof row.highlightText === 'string' ? row.highlightText : undefined),
                note: typeof row.note === 'string' ? row.note : (typeof row.comment === 'string' ? row.comment : undefined),
            });
        }
    }

    return {
        readingNow,
        weeklyMinutes,
        recentHighlights,
        updatedAt: Date.now(),
    };
};
