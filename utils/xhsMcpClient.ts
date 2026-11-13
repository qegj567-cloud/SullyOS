
/**
 * XHS Client — 双模式小红书自动化客户端
 *
 * 自动检测后端类型:
 * - MCP 模式 (URL 含 /mcp): 使用 xiaohongshu-mcp Go 服务器 (JSON-RPC 2.0)
 * - Bridge 模式 (URL 含 /api): 使用 xiaohongshu-skills Python CLI (REST)
 *
 * MCP Server:   https://github.com/xpzouying/xiaohongshu-mcp
 * Skills Server: https://github.com/autoclaw-cc/xiaohongshu-skills
 */

import { classifyFetchFailure, parseTargetUrl } from './networkFailureDiagnosis';
import { buildXhsNoteLink } from './xhsNoteLink';

export interface McpToolResult {
    success: boolean;
    data?: any;
    error?: string;
}
export const XHS_SPIDER_V3_EXPERIMENT = Object.freeze({
    optInValue: 'spider-v3-isolated-cookie',
    strategyKey: 'os_xhs_spider_v3_strategy',
    sessionKey: 'os_xhs_spider_v3_session',
    circuitKey: 'os_xhs_spider_v3_circuit',
});


// ==================== Wire Protocol Detection ====================

type BackendProtocol = 'mcp' | 'bridge';
type XhsPlatform = 'xhs' | 'rednote';

// 这里只识别传输协议，不代表部署位置：本地 Skills 与云端 Lite 都走 bridge /api。
const detectMode = (serverUrl: string): BackendProtocol => {
    if (serverUrl.includes('/api')) return 'bridge';
    return 'mcp'; // default: MCP (backwards compatible)
};

// Lite-Worker cookie: set from settings, sent as x-xhs-cookie on bridge calls.
// Local Bridge/Skills servers ignore the header; the cloud Worker requires it.
let liteCookie = '';
let litePlatform: XhsPlatform | 'auto' = 'auto';

// Resolve the XHS cookie for bridge requests: prefer the explicitly-set value,
// otherwise read it straight from persisted realtime config. This keeps chat-
// driven XHS calls authenticated without any call site having to push it in.
const resolveLiteCookie = (): string => {
    if (liteCookie) return liteCookie;
    try {
        const raw = localStorage.getItem('os_realtime_config');
        if (raw) return JSON.parse(raw)?.xhsMcpConfig?.cookie || '';
    } catch { /* ignore */ }
    return '';
};

const resolvePersistedLitePlatform = (): XhsPlatform | 'auto' => {
    try {
        const raw = localStorage.getItem('os_realtime_config');
        const platform = raw ? JSON.parse(raw)?.xhsMcpConfig?.platform : undefined;
        return platform === 'xhs' || platform === 'rednote' ? platform : 'auto';
    } catch {
        return 'auto';
    }
};


const spiderStorage = (): Storage | null => {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
};

const readSpiderJson = (key: string): any => {
    try {
        const raw = spiderStorage()?.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
};

const writeSpiderJson = (key: string, value: any): void => {
    try {
        spiderStorage()?.setItem(key, JSON.stringify(value));
    } catch { /* localStorage unavailable or full */ }
};

const removeSpiderValue = (key: string): void => {
    try {
        spiderStorage()?.removeItem(key);
    } catch { /* ignore */ }
};

const spiderCookieTag = async (cookie: string): Promise<string> => {
    const a1 = cookie.match(/(?:^|;\s*)a1=([^;]+)/)?.[1] || '';
    if (!a1) return '';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(a1));
    return Array.from(new Uint8Array(digest).slice(0, 8), byte => byte.toString(16).padStart(2, '0')).join('');
};

const withSpiderCircuitError = (detail: any, message: string): any => ({
    ...detail,
    data: {
        ...(detail?.data || {}),
        comments_status: 'unavailable',
        comments_error: {
            code: 'SPIDER_V3_CIRCUIT_OPEN',
            message,
        },
    },
});

const trySpiderV3CommentPatch = async (
    baseUrl: string,
    requestBody: Record<string, any>,
    cookie: string,
    detail: any,
    signal?: AbortSignal,
): Promise<any> => {
    signal?.throwIfAborted();
    const storage = spiderStorage();
    if (
        !storage
        || detail?.data?.comments_status === 'loaded'
        || detail?.platform === 'rednote'
        || detail?.data?.platform === 'rednote'
    ) {
        return detail;
    }

    const a1Tag = await spiderCookieTag(cookie);
    if (!a1Tag) return detail;
    let sessionState = readSpiderJson(XHS_SPIDER_V3_EXPERIMENT.sessionKey);
    if (sessionState?.a1Tag !== a1Tag) {
        sessionState = null;
        removeSpiderValue(XHS_SPIDER_V3_EXPERIMENT.sessionKey);
        removeSpiderValue(XHS_SPIDER_V3_EXPERIMENT.circuitKey);
    }
    const circuit = readSpiderJson(XHS_SPIDER_V3_EXPERIMENT.circuitKey);
    if (circuit?.a1Tag === a1Tag) {
        return withSpiderCircuitError(detail, 'Spider v3 received HTTP 406 earlier and is circuit-broken for this cookie.');
    }

    const requestedStrategy = storage.getItem(XHS_SPIDER_V3_EXPERIMENT.strategyKey) || 'no-client-hints';
    const strategy = ['no-client-hints', 'browser-hints', 'legacy-transport'].includes(requestedStrategy)
        ? requestedStrategy
        : 'no-client-hints';
    try {
        const response = await fetch(`${baseUrl}/api/xhs-experimental-comments`, {
            signal,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-xhs-cookie': cookie,
                ...(litePlatform !== 'auto' ? { 'x-xhs-platform': litePlatform } : {}),
                'x-xhs-experiment-ack': XHS_SPIDER_V3_EXPERIMENT.optInValue,
            },
            body: JSON.stringify({
                acknowledge_risk: true,
                feed_id: requestBody.feed_id,
                xsec_token: requestBody.xsec_token || '',
                strategy,
                session_state: sessionState || undefined,
            }),
        });
        const experiment = await response.json().catch(() => null);
        if (experiment?.session_state) {
            writeSpiderJson(XHS_SPIDER_V3_EXPERIMENT.sessionKey, experiment.session_state);
        }
        if (experiment?.error_code === 'XHS_EXPERIMENT_HTTP_406') {
            writeSpiderJson(XHS_SPIDER_V3_EXPERIMENT.circuitKey, {
                a1Tag,
                openedAt: Date.now(),
                reason: experiment.error_code,
            });
            return withSpiderCircuitError(detail, 'Spider v3 was rejected with HTTP 406; automatic comment attempts are now stopped.');
        }
        if (!response.ok || !experiment?.success || !experiment?.data) return detail;
        removeSpiderValue(XHS_SPIDER_V3_EXPERIMENT.circuitKey);
        return {
            ...detail,
            data: {
                ...(detail?.data || {}),
                ...experiment.data,
                comments_error: undefined,
            },
        };
    } catch {
        signal?.throwIfAborted();
        return detail;
    }
};

// ==================== Bridge Mode (REST) ====================

const bridgePost = async (
    serverUrl: string,
    endpoint: string,
    body: Record<string, any> = {},
    signal?: AbortSignal,
): Promise<McpToolResult> => {
    signal?.throwIfAborted();
    const baseUrl = serverUrl.replace(/\/+$/, '').replace(/\/api$/, '');
    const url = `${baseUrl}/api/${endpoint}`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const ck = resolveLiteCookie();
    if (ck) headers['x-xhs-cookie'] = ck;
    const requestPlatform = endpoint === 'check-login'
        ? litePlatform
        : (litePlatform === 'auto' ? resolvePersistedLitePlatform() : litePlatform);
    if (requestPlatform !== 'auto') headers['x-xhs-platform'] = requestPlatform;

    try {
        const resp = await fetch(url, {
            signal,
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (resp.status === 401) {
            return { success: false, error: '未登录，请先登录小红书' };
        }

        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            return { success: false, error: errData.error || `HTTP ${resp.status}` };
        }

        let data = await resp.json();
        if (data.error) {
            return { success: false, error: data.error };
        }
        const detectedPlatform = data?.platform || data?.data?.platform;
        if (detectedPlatform === 'xhs' || detectedPlatform === 'rednote') {
            litePlatform = detectedPlatform;
        }
        if (endpoint === 'get-feed-detail' && ck) {
            data = await trySpiderV3CommentPatch(baseUrl, body, ck, data, signal);
        }
        return { success: true, data };
    } catch (e: any) {
        signal?.throwIfAborted();
        return { success: false, error: e.message };
    }
};

// ==================== MCP Mode (JSON-RPC 2.0) ====================

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

let mcpRequestIdCounter = 0;
let mcpSessionId: string | null = null;
let mcpInitialized = false;
/** 在途的握手（并发去重用；见 mcpEnsureInitialized）。 */
let mcpInitPromise: Promise<void> | null = null;
let mcpDiscoveredTools: { name: string; description?: string }[] = [];

const TOOL_NAME_ALIASES: Record<string, string[]> = {
    'check_login':     ['check_login', 'checkLogin', 'check_login_status', 'checkLoginStatus'],
    'search':          ['search', 'search_notes', 'searchNotes', 'search_feeds', 'searchFeeds'],
    'get_recommend':   ['get_recommend', 'getRecommend', 'list_feeds', 'listFeeds', 'get_feed_list', 'getFeedList', 'list_notes', 'listNotes'],
    'get_note_detail': ['get_note_detail', 'getNoteDetail', 'get_feed_detail', 'getFeedDetail'],
    'publish_note':    ['publish_note', 'publishNote', 'publish_post', 'publishPost', 'publish_content', 'publishContent'],
    'comment':         ['comment', 'post_comment', 'postComment', 'post_comment_to_feed', 'postCommentToFeed'],
    'get_user_info':   ['get_user_info', 'getUserInfo', 'get_user_profile', 'getUserProfile', 'user_profile', 'userProfile'],
    'like_feed':       ['like_feed', 'likeFeed', 'like_note', 'likeNote'],
    'favorite_feed':   ['favorite_feed', 'favoriteFeed', 'favorite_note', 'favoriteNote', 'collect_note', 'collectNote'],
    'reply_comment':   ['reply_comment', 'replyComment', 'reply_comment_in_feed', 'replyCommentInFeed'],
};

const mcpResolveToolName = (desiredName: string): string => {
    if (!mcpDiscoveredTools.length) return desiredName;
    if (mcpDiscoveredTools.some(t => t.name === desiredName)) return desiredName;
    const aliases = TOOL_NAME_ALIASES[desiredName];
    if (aliases) {
        for (const alias of aliases) {
            if (mcpDiscoveredTools.some(t => t.name === alias)) return alias;
        }
    }
    const norm = (s: string) => s.replace(/[_-]/g, '').toLowerCase();
    const desired = norm(desiredName);
    const match = mcpDiscoveredTools.find(t => norm(t.name) === desired);
    if (match) return match.name;
    console.warn(`[MCP] 未找到工具 "${desiredName}" 的匹配，可用: ${mcpDiscoveredTools.map(t => t.name).join(', ')}`);
    return desiredName;
};

const mcpAdaptParams = (resolvedName: string, args: Record<string, any>): Record<string, any> => {
    const norm = resolvedName.replace(/[_-]/g, '').toLowerCase();
    if (args.url && !args.feed_id) {
        const feedIdTools = ['getfeeddetail', 'getnotedetail', 'postcomment', 'postcommenttofeed', 'replycommentinfeed'];
        if (feedIdTools.some(n => norm === n)) {
            const adapted = { ...args };
            adapted.feed_id = extractNoteIdFromUrl(args.url);
            if (!adapted.xsec_token) {
                const token = extractXsecTokenFromUrl(args.url);
                if (token) adapted.xsec_token = token;
            }
            delete adapted.url;
            return adapted;
        }
    }
    return args;
};

const mcpBuildRequest = (method: string, params?: any, isNotification = false): McpJsonRpcRequest => {
    const req: McpJsonRpcRequest = { jsonrpc: '2.0', method, params };
    if (!isNotification) req.id = ++mcpRequestIdCounter;
    return req;
};

const mcpParseSseResponse = (text: string): McpJsonRpcResponse | null => {
    const lines = text.split('\n');
    const dataLines: string[] = [];
    for (const line of lines) {
        if (line.startsWith('data: ')) dataLines.push(line.slice(6));
        else if (line.startsWith('data:')) dataLines.push(line.slice(5));
    }
    if (dataLines.length === 0) return null;
    for (let i = dataLines.length - 1; i >= 0; i--) {
        try { return JSON.parse(dataLines[i]); } catch { continue; }
    }
    return null;
};

const mcpParseResponse = (text: string, contentType: string): McpJsonRpcResponse => {
    if (contentType.includes('text/event-stream') || text.trimStart().startsWith('event:') || text.trimStart().startsWith('data:')) {
        const parsed = mcpParseSseResponse(text);
        if (parsed) return parsed;
    }
    try { return JSON.parse(text); } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) { try { return JSON.parse(match[0]); } catch { /* fall through */ } }
        throw new Error(`MCP: 无法解析响应: ${text.slice(0, 300)}`);
    }
};

const mcpPost = async (
    serverUrl: string,
    body: McpJsonRpcRequest,
    expectResponse = true,
    signal?: AbortSignal,
): Promise<{ response: McpJsonRpcResponse | null; sessionId: string | null }> => {
    signal?.throwIfAborted();
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    };
    if (mcpSessionId) headers['Mcp-Session-Id'] = mcpSessionId;

    const resp = await fetch(serverUrl, { signal, method: 'POST', headers, body: JSON.stringify(body) });
    const sessionId = resp.headers.get('Mcp-Session-Id') || resp.headers.get('mcp-session-id');

    if (resp.status === 202) return { response: null, sessionId };
    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`MCP HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }
    if (!expectResponse) return { response: null, sessionId };

    const contentType = resp.headers.get('content-type') || '';
    const text = await resp.text();
    return { response: mcpParseResponse(text, contentType), sessionId };
};

const mcpInitialize = async (serverUrl: string, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    const initReq = mcpBuildRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'AetherOS-XhsFreeRoam', version: '1.0.0' },
    });
    const { response, sessionId } = await mcpPost(serverUrl, initReq, undefined, signal);
    if (sessionId) mcpSessionId = sessionId;
    if (response?.error) throw new Error(`MCP Initialize failed: ${response.error.message}`);

    if (!mcpSessionId) {
        console.warn(
            '[MCP] ⚠️ 无法读取 Mcp-Session-Id 响应头（CORS 限制）。\n' +
            '请使用 CORS 代理: node scripts/mcp-proxy.mjs\n' +
            '然后把 MCP URL 改为 http://localhost:18061/mcp'
        );
        throw new Error(
            'MCP 连接失败: 浏览器 CORS 限制无法读取 Session ID。\n' +
            '请运行 CORS 代理: node scripts/mcp-proxy.mjs\n' +
            '然后把设置里的 MCP URL 改为 http://localhost:18061/mcp'
        );
    }

    const notifReq = mcpBuildRequest('notifications/initialized', {}, true);
    await mcpPost(serverUrl, notifReq, false, signal);

    try {
        const toolsReq = mcpBuildRequest('tools/list');
        const { response: toolsResp } = await mcpPost(serverUrl, toolsReq, undefined, signal);
        if (toolsResp?.result?.tools) {
            mcpDiscoveredTools = toolsResp.result.tools.map((t: any) => ({ name: t.name, description: t.description }));
            console.log('[MCP] 发现工具:', mcpDiscoveredTools.map(t => t.name).join(', '));
        }
    } catch (e) {
        signal?.throwIfAborted();
        console.warn('[MCP] tools/list 调用失败，将使用默认工具名', e);
    }

    mcpInitialized = true;
};

/**
 * 并发去重的握手：同时进来的调用共用同一次 initialize。
 *
 * 直接写 `if (!mcpInitialized) await mcpInitialize()` 是 check-then-act：两个调用会都
 * 看到 false 各握一次手，后完成的那个把模块级 mcpSessionId 覆盖掉，先发起的那个再拿它
 * 发 tools/call 就用了别人的 session。worker 到点最多并发跑 8 个任务，两个任务同一分钟
 * 都用小红书就会踩到。失败时清掉在途 promise，下一次调用可以重新握手。
 */
const mcpEnsureInitialized = async (serverUrl: string, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (mcpInitialized) return;
    if (!mcpInitPromise) {
        mcpInitPromise = mcpInitialize(serverUrl, signal).finally(() => { mcpInitPromise = null; });
    }
    await mcpInitPromise;
};

const mcpCallTool = async (serverUrl: string, toolName: string, args: Record<string, any> = {}, signal?: AbortSignal): Promise<McpToolResult> => {
    signal?.throwIfAborted();
    try {
        await mcpEnsureInitialized(serverUrl, signal);
        const resolved = mcpResolveToolName(toolName);
        const adapted = mcpAdaptParams(resolved, args);
        if (resolved !== toolName) console.log(`[MCP] 工具名映射: ${toolName} → ${resolved}`);

        const body = mcpBuildRequest('tools/call', { name: resolved, arguments: adapted });
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
        };
        if (mcpSessionId) headers['Mcp-Session-Id'] = mcpSessionId;

        const resp = await fetch(serverUrl, { signal, method: 'POST', headers, body: JSON.stringify(body) });
        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            return { success: false, error: `MCP HTTP ${resp.status}: ${errText.slice(0, 200)}` };
        }

        const contentType = resp.headers.get('content-type') || '';
        const text = await resp.text();
        const parsed = mcpParseResponse(text, contentType);

        if (parsed.error) return { success: false, error: `MCP Error [${parsed.error.code}]: ${parsed.error.message}` };

        const result = parsed.result;
        if (result?.content) {
            const textParts = result.content.filter((c: any) => c.type === 'text').map((c: any) => c.text);
            const fullText = textParts.join('\n');
            if (result.isError) return { success: false, error: fullText || 'MCP 工具执行失败' };
            try {
                const parsed = JSON.parse(fullText);
                console.log(`[MCP] 工具 ${toolName} 返回 JSON, 顶层 keys: ${typeof parsed === 'object' && parsed ? Object.keys(parsed).join(',') : typeof parsed}`);
                return { success: true, data: parsed };
            } catch {
                signal?.throwIfAborted();
                console.log(`[MCP] 工具 ${toolName} 返回纯文本 (${fullText.length} chars)`);
                return { success: true, data: fullText };
            }
        }
        return { success: true, data: result };
    } catch (e: any) {
        signal?.throwIfAborted();
        return { success: false, error: e.message };
    }
};

// ==================== URL Helpers ====================

const extractNoteIdFromUrl = (url: string): string => {
    const match = url.match(/\/explore\/([a-f0-9]+)/i) || url.match(/\/discovery\/item\/([a-f0-9]+)/i) || url.match(/\/([a-f0-9]{24})/);
    return match ? match[1] : url;
};

const extractXsecTokenFromUrl = (url: string): string | undefined => {
    try {
        const u = new URL(url);
        return u.searchParams.get('xsec_token') || undefined;
    } catch {
        return undefined;
    }
};

// ==================== Auto-extract helpers ====================

/**
 * 从 feed/recommend 响应中提取第一个可用的 xsec_token
 * 支持多种嵌套格式: [{ xsec_token }], { data: [{ xsec_token }] }, { items: [...] }, 纯文本等
 */
const extractFirstXsecToken = (data: any): string | undefined => {
    if (!data) return undefined;

    // 从数组中找第一个有 xsec_token 的
    const scanArray = (arr: any[]): string | undefined => {
        for (const item of arr) {
            const token = item?.xsec_token || item?.xsecToken
                || item?.noteCard?.xsec_token || item?.noteCard?.xsecToken;
            if (token) return token;
        }
        return undefined;
    };

    if (Array.isArray(data)) return scanArray(data);

    // 在常见 key 下查找数组
    for (const key of ['items', 'notes', 'feeds', 'data', 'list', 'results', 'note_list', 'noteList']) {
        if (Array.isArray(data[key])) {
            const token = scanArray(data[key]);
            if (token) return token;
        }
    }

    // 解包一层 data: { data: { items: [...] } }
    if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
        for (const key of ['items', 'notes', 'feeds', 'list', 'results', 'note_list', 'noteList']) {
            if (Array.isArray(data.data[key])) {
                const token = scanArray(data.data[key]);
                if (token) return token;
            }
        }
        if (Array.isArray(data.data)) return scanArray(data.data);
    }

    // 纯文本中正则匹配
    if (typeof data === 'string') {
        const match = data.match(/xsec_token[=:]["']?\s*([A-Za-z0-9+/=]+)/);
        if (match) return match[1];
    }

    return undefined;
};

/**
 * 连接测试失败时给一句人话。裸传 e.message 的话，用户在设置页只会看到
 * 「Failed to fetch」——那句话不区分「地址填错」「梯子拦了」「对方在限流页后面」，
 * 到头来只能来问作者。分类逻辑复用调试终端那份，两处口径保持一致。
 */
const describeXhsConnectFailure = (e: any, serverUrl: string): string => {
    const host = parseTargetUrl(serverUrl).host || serverUrl;
    const kind = classifyFetchFailure({ url: serverUrl, error: e });
    switch (kind) {
        case 'timeout':
            return `连接 ${host} 超时（10 秒一个字节都没回）。连接是挂住不返回、不是被拒——多半是该域名没走代理走了直连，或代理节点到上游是黑洞。优先换个梯子节点、或把这个域名显式加进代理规则。`;
        case 'aborted':
            return '连接被取消（页面切走了或手动停止）。';
        case 'offline':
            return '当前处于离线状态，请检查网络或梯子是否掉线。';
        case 'mixed-content':
            return `SullyOS 跑在 https 上，不能连 http 地址（${host}）。请把服务地址改成 https://，或用本地 http 打开 SullyOS。`;
        case 'bad-url':
            return `服务器地址不是合法 URL：${serverUrl}。检查有没有漏掉 https://、多了空格或用了中文标点。`;
        case 'blocked':
            return `连不上 ${host}：浏览器在拿到响应前就失败了。常见原因——梯子/代理拦了这个域名、DNS 解析不到、浏览器扩展（广告拦截/隐私盾）屏蔽了，或对方正返回限流/人机验证页。可在新标签页直接打开 ${serverUrl.replace(/\/+$/, '')}/health 验证；详细旁证见「系统调试终端」。`;
        default:
            return e?.message || '连接失败';
    }
};

// ==================== Public API (双模式) ====================

export const XhsMcpClient = {

    resetSession: () => {
        mcpSessionId = null;
        mcpInitialized = false;
        mcpRequestIdCounter = 0;
        mcpDiscoveredTools = [];
    },

    // Lite Worker auth: register the XHS cookie used for x-xhs-cookie header.
    setCookie: (cookie?: string) => {
        const nextCookie = cookie || '';
        if (nextCookie !== liteCookie) litePlatform = 'auto';
        liteCookie = nextCookie;
    },


    testConnection: async (serverUrl: string, cookie?: string, signal?: AbortSignal): Promise<{ connected: boolean; tools?: string[]; error?: string; nickname?: string; userId?: string; loggedIn?: boolean; xsecToken?: string; platform?: XhsPlatform }> => {
        signal?.throwIfAborted();
        if (cookie !== undefined) XhsMcpClient.setCookie(cookie);
        const mode = detectMode(serverUrl);

        if (mode === 'bridge') {
            try {
                const baseUrl = serverUrl.replace(/\/+$/, '').replace(/\/api$/, '');
                // 探活必须自带超时：代理/网关把连接吞掉时裸 fetch 会一直挂着，界面永远停在
                // 「连接中」，用户只能当成卡死。10s 到点主动断，走下面的 catch 出一句人话。
                const healthResp = await fetch(`${baseUrl}/api/health`, {
                    signal: signal ?? (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined),
                });
                if (!healthResp.ok) return { connected: false, error: `Bridge 服务未响应 (HTTP ${healthResp.status})` };

                const loginResult = await bridgePost(serverUrl, 'check-login', undefined, signal);
                const tools = ['check-login', 'search', 'list-feeds', 'get-feed-detail', 'publish', 'publish-video', 'long-article', 'post-comment', 'reply-comment', 'like-feed', 'favorite-feed', 'user-profile', 'login', 'get-qrcode'];
                let loggedIn = false, nickname: string | undefined, userId: string | undefined, platform: XhsPlatform | undefined;
                if (loginResult.success && loginResult.data) {
                    const d = loginResult.data;
                    if (typeof d === 'string') {
                        loggedIn = d.includes('已登录') || d.includes('logged');
                        const nameMatch = d.match(/用户名[:：]\s*(.+)/);
                        if (nameMatch) nickname = nameMatch[1].trim();
                        const idMatch = d.match(/(?:用户ID|user_id|userId|red_id|ID)[:：]\s*(\S+)/i);
                        if (idMatch) userId = idMatch[1].trim();
                    } else {
                        loggedIn = !!(d.logged_in || d.loggedIn || d.is_logged_in || d.isLoggedIn || d.logged);
                        nickname = d.nickname || d.name || d.username || d.user_name || undefined;
                        userId = d.user_id || d.userId || d.id || d.red_id || undefined;
                        platform = d.platform === 'xhs' || d.platform === 'rednote' ? d.platform : undefined;
                    }
                }
                // 自动获取 xsecToken：从首页推荐中提取
                let xsecToken: string | undefined;
                if (loggedIn) {
                    try {
                        const feedResult = await bridgePost(serverUrl, 'list-feeds', undefined, signal);
                        if (feedResult.success) xsecToken = extractFirstXsecToken(feedResult.data);
                    } catch {
        signal?.throwIfAborted(); /* 非关键，静默忽略 */ }
                }
                return { connected: true, tools, nickname, userId, loggedIn, xsecToken, platform };
            } catch (e: any) {
                signal?.throwIfAborted();
                return { connected: false, error: describeXhsConnectFailure(e, serverUrl) };
            }
        }

        // MCP mode
        try {
            XhsMcpClient.resetSession();
            await mcpInitialize(serverUrl, signal);
            const tools = mcpDiscoveredTools.map(t => t.name);
            let nickname: string | undefined, userId: string | undefined, loggedIn = false;
            try {
                const loginResult = await mcpCallTool(serverUrl, 'check_login', undefined, signal);
                if (loginResult.success && loginResult.data) {
                    const d = loginResult.data;
                    if (typeof d === 'string') {
                        loggedIn = d.includes('已登录');
                        const nameMatch = d.match(/用户名[:：]\s*(.+)/);
                        if (nameMatch) nickname = nameMatch[1].trim();
                        const idMatch = d.match(/(?:用户ID|user_id|userId|red_id|ID)[:：]\s*(\S+)/i);
                        if (idMatch) userId = idMatch[1].trim();
                    } else {
                        loggedIn = !!(d.logged_in || d.loggedIn || d.is_logged_in || d.isLoggedIn);
                        nickname = d.nickname || d.name || d.username || undefined;
                        userId = d.user_id || d.userId || d.id || d.red_id || undefined;
                    }
                }
            } catch (e) {
                signal?.throwIfAborted();
                console.warn('[MCP] 获取登录状态失败，跳过:', e);
            }
            // 自动获取 xsecToken：从首页推荐中提取（同时验证 get_recommend 工具可用性）
            let xsecToken: string | undefined;
            if (loggedIn) {
                try {
                    console.log('[MCP] 自动获取 xsecToken: 调用 get_recommend...');
                    const feedResult = await mcpCallTool(serverUrl, 'get_recommend', undefined, signal);
                    if (feedResult.success) {
                        xsecToken = extractFirstXsecToken(feedResult.data);
                        console.log(`[MCP] 自动获取 xsecToken: ${xsecToken ? '成功' : '未找到'}`);
                    }
                } catch (e) {
                    signal?.throwIfAborted();
                    console.warn('[MCP] 自动获取 xsecToken 失败（不影响连接）:', e);
                }
            }
            return { connected: true, tools, nickname, userId, loggedIn, xsecToken };
        } catch (e: any) {
            signal?.throwIfAborted();
            return { connected: false, error: e.message };
        }
    },

    ensureInitialized: async (serverUrl: string, signal?: AbortSignal): Promise<void> => {
        signal?.throwIfAborted();
        if (detectMode(serverUrl) === 'mcp' && !mcpInitialized) {
            XhsMcpClient.resetSession();
            await mcpInitialize(serverUrl, signal);
        }
    },

    checkLogin: async (serverUrl: string, signal?: AbortSignal): Promise<McpToolResult> => {
        signal?.throwIfAborted();
        return detectMode(serverUrl) === 'bridge'
            ? bridgePost(serverUrl, 'check-login', undefined, signal)
            : mcpCallTool(serverUrl, 'check_login', undefined, signal);
    },

    search: async (serverUrl: string, keyword: string, options?: {
        sort_by?: string; note_type?: string; publish_time?: string; search_scope?: string; location?: string;
    }, signal?: AbortSignal): Promise<McpToolResult> => {
        signal?.throwIfAborted();
        const result = await (detectMode(serverUrl) === 'bridge'
            ? bridgePost(serverUrl, 'search', { keyword, ...options }, signal)
            : mcpCallTool(serverUrl, 'search', { keyword }, signal));
        if (result.success) for (const note of extractNotesFromMcpData(result.data)) {
            if (note && typeof note === 'object' && !note.xsecSource && !note.xsec_source
                && !note.url && !note.note_url && !note.shareUrl && !note.share_url) note.xsecSource = 'pc_search';
        }
        return result;
    },

    getRecommend: async (serverUrl: string, signal?: AbortSignal): Promise<McpToolResult> => {
        signal?.throwIfAborted();
        return detectMode(serverUrl) === 'bridge'
            ? bridgePost(serverUrl, 'list-feeds', undefined, signal)
            : mcpCallTool(serverUrl, 'get_recommend', undefined, signal);
    },

    getNoteDetail: async (serverUrl: string, noteUrl: string, xsecToken?: string, options?: { loadAllComments?: boolean; xsecSource?: string }, signal?: AbortSignal): Promise<McpToolResult> => {
        signal?.throwIfAborted();
        const feedId = extractNoteIdFromUrl(noteUrl);
        const token = xsecToken || extractXsecTokenFromUrl(noteUrl) || '';
        const loadAllComments = !!options?.loadAllComments;
        let xsecSource = options?.xsecSource || 'pc_feed';
        try {
            xsecSource = new URL(noteUrl).searchParams.get('xsec_source') || xsecSource;
        } catch {
        signal?.throwIfAborted(); /* keep the share-link default */ }

        if (detectMode(serverUrl) === 'bridge') {
            return bridgePost(serverUrl, 'get-feed-detail', {
                feed_id: feedId, xsec_token: token,
                xsec_source: xsecSource,
                load_all_comments: loadAllComments,
                click_more_replies: loadAllComments,
            }, signal);
        }
        const args: Record<string, any> = { url: noteUrl };
        if (xsecToken) args.xsec_token = xsecToken;
        if (loadAllComments) { args.load_all_comments = true; args.click_more_replies = true; }
        return mcpCallTool(serverUrl, 'get_note_detail', args, signal);
    },

    publishNote: async (serverUrl: string, params: {
        title: string; content: string; images?: string[]; tags?: string[]; is_private?: boolean;
    }, signal?: AbortSignal): Promise<McpToolResult> => {
        signal?.throwIfAborted();
        if (detectMode(serverUrl) === 'bridge') {
            return bridgePost(serverUrl, 'publish', {
                title: params.title, content: params.content,
                images: params.images || [], tags: params.tags || [],
                visibility: params.is_private ? 'private' : undefined,
            }, signal);
        }
        return mcpCallTool(serverUrl, 'publish_note', { ...params, images: params.images || [] }, signal);
    },

    publishVideo: async (serverUrl: string, params: {
        title: string; content: string; video: string; tags?: string[];
    }, signal?: AbortSignal): Promise<McpToolResult> => {
        signal?.throwIfAborted();
        if (detectMode(serverUrl) === 'bridge') {
            return bridgePost(serverUrl, 'publish-video', {
                title: params.title, content: params.content, video: params.video, tags: params.tags || [],
            }, signal);
        }
        return { success: false, error: '视频发布仅在 Skills (Bridge) 模式下可用' };
    },

    publishLongArticle: async (serverUrl: string, params: {
        title: string; content: string; images?: string[];
    }, signal?: AbortSignal): Promise<McpToolResult> => {
        signal?.throwIfAborted();
        if (detectMode(serverUrl) === 'bridge') {
            return bridgePost(serverUrl, 'long-article', {
                title: params.title, content: params.content, images: params.images || [],
            }, signal);
        }
        return { success: false, error: '长文发布仅在 Skills (Bridge) 模式下可用' };
    },

    comment: async (serverUrl: string, noteUrl: string, content: string, xsecToken?: string, signal?: AbortSignal): Promise<McpToolResult> => {
        signal?.throwIfAborted();
        if (detectMode(serverUrl) === 'bridge') {
            const feedId = extractNoteIdFromUrl(noteUrl);
            const token = xsecToken || extractXsecTokenFromUrl(noteUrl) || '';
            return bridgePost(serverUrl, 'post-comment', { feed_id: feedId, xsec_token: token, content }, signal);
        }
        const args: Record<string, any> = { url: noteUrl, content };
        if (xsecToken) args.xsec_token = xsecToken;
        return mcpCallTool(serverUrl, 'comment', args, signal);
    },

    likeFeed: async (serverUrl: string, feedId: string, xsecToken: string, unlike = false, signal?: AbortSignal): Promise<McpToolResult> => {
        signal?.throwIfAborted();
        if (detectMode(serverUrl) === 'bridge') {
            return bridgePost(serverUrl, 'like-feed', { feed_id: feedId, xsec_token: xsecToken, unlike }, signal);
        }
        return mcpCallTool(serverUrl, 'like_feed', { feed_id: feedId, xsec_token: xsecToken, ...(unlike ? { unlike: true } : {}) }, signal);
    },

    favoriteFeed: async (serverUrl: string, feedId: string, xsecToken: string, unfavorite = false, signal?: AbortSignal): Promise<McpToolResult> => {
        signal?.throwIfAborted();
        if (detectMode(serverUrl) === 'bridge') {
            return bridgePost(serverUrl, 'favorite-feed', { feed_id: feedId, xsec_token: xsecToken, unfavorite }, signal);
        }
        return mcpCallTool(serverUrl, 'favorite_feed', { feed_id: feedId, xsec_token: xsecToken, ...(unfavorite ? { unfavorite: true } : {}) }, signal);
    },

    replyComment: async (serverUrl: string, feedId: string, xsecToken: string, content: string, commentId?: string, userId?: string, parentCommentId?: string, signal?: AbortSignal): Promise<McpToolResult> => {
        signal?.throwIfAborted();
        if (detectMode(serverUrl) === 'bridge') {
            return bridgePost(serverUrl, 'reply-comment', {
                feed_id: feedId, xsec_token: xsecToken, content, comment_id: commentId, user_id: userId,
            }, signal);
        }
        const args: Record<string, any> = { feed_id: feedId, xsec_token: xsecToken, content };
        if (commentId) args.comment_id = commentId;
        if (userId) args.user_id = userId;
        if (parentCommentId) args.parent_comment_id = parentCommentId;
        return mcpCallTool(serverUrl, 'reply_comment', args, signal);
    },

    getUserProfile: async (serverUrl: string, userId: string, xsecToken?: string, signal?: AbortSignal): Promise<McpToolResult> => {
        signal?.throwIfAborted();
        if (detectMode(serverUrl) === 'bridge') {
            return bridgePost(serverUrl, 'user-profile', { user_id: userId, xsec_token: xsecToken || '' }, signal);
        }
        const args: Record<string, any> = { user_id: userId };
        if (xsecToken) args.xsec_token = xsecToken;
        return mcpCallTool(serverUrl, 'get_user_info', args, signal);
    },

    login: async (serverUrl: string, signal?: AbortSignal): Promise<McpToolResult> => {
        signal?.throwIfAborted();
        if (detectMode(serverUrl) === 'bridge') return bridgePost(serverUrl, 'login', undefined, signal);
        return { success: false, error: '登录功能仅在 Skills (Bridge) 模式下可用' };
    },

    getQrcode: async (serverUrl: string, signal?: AbortSignal): Promise<McpToolResult> => {
        signal?.throwIfAborted();
        if (detectMode(serverUrl) === 'bridge') return bridgePost(serverUrl, 'get-qrcode', undefined, signal);
        return { success: false, error: '二维码功能仅在 Skills (Bridge) 模式下可用' };
    },

    logout: async (serverUrl: string, signal?: AbortSignal): Promise<McpToolResult> => {
        signal?.throwIfAborted();
        if (detectMode(serverUrl) === 'bridge') return bridgePost(serverUrl, 'delete-cookies', undefined, signal);
        return { success: false, error: '登出功能仅在 Skills (Bridge) 模式下可用' };
    },
};

// ==================== Helpers ====================

export const extractNotesFromMcpData = (data: any): any[] => {
    if (!data) return [];
    if (Array.isArray(data)) {
        // 如果是嵌套数组（数组的数组），展平后过滤出笔记对象
        if (data.length > 0 && Array.isArray(data[0])) {
            console.log(`[XHS] extractNotes: 检测到嵌套数组，展平 (${data.length} 组)`);
            return data.flat().filter((n: any) => n && typeof n === 'object' && !Array.isArray(n));
        }
        return data;
    }
    // 直接查找常见 key
    for (const key of ['notes', 'items', 'feeds', 'data', 'list', 'results', 'note_list', 'noteList']) {
        if (Array.isArray(data[key])) {
            const arr = data[key];
            // 嵌套数组处理
            if (arr.length > 0 && Array.isArray(arr[0])) {
                console.log(`[XHS] extractNotes: data.${key} 是嵌套数组，展平`);
                return arr.flat().filter((n: any) => n && typeof n === 'object' && !Array.isArray(n));
            }
            return arr;
        }
    }
    // Bridge 模式嵌套: { code: 0, data: { notes: [...] } } — 解包一层再查
    if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
        for (const key of ['notes', 'items', 'feeds', 'list', 'results', 'note_list', 'noteList']) {
            if (Array.isArray(data.data[key])) {
                console.log(`[XHS] extractNotes: 从 data.data.${key} 找到数组, length=${data.data[key].length}`);
                return data.data[key];
            }
        }
    }
    if (typeof data === 'object') {
        // Skip keys that are definitely not notes
        const skipKeys = new Set(['interactions', 'tags', 'images', 'comments', 'replies']);
        for (const [key, val] of Object.entries(data)) {
            if (skipKeys.has(key)) continue;
            if (Array.isArray(val) && (val as any[]).length > 0) {
                // Verify the first element looks like a note (has note-like fields)
                const first = (val as any[])[0];
                if (first && typeof first === 'object' &&
                    (first.noteId || first.note_id || first.id || first.noteCard ||
                     first.displayTitle || first.title || first.desc || first.cover)) {
                    console.log(`[XHS] extractNotes: 在 key "${key}" 中找到笔记数组, length=${(val as any[]).length}`);
                    return val as any[];
                }
            }
        }
    }
    if (typeof data === 'string') {
        console.warn('[XHS] extractNotes: data 是纯文本，无法提取笔记:', data.slice(0, 200));
        return [];
    }
    console.warn('[XHS] extractNotes: 未找到笔记数组, data keys:', Object.keys(data));
    return [];
};

export const parseXhsCount = (value: unknown): number => {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
    }
    if (typeof value !== 'string') return 0;

    const normalized = value.trim().replace(/[,\s+]/g, '');
    if (!normalized) return 0;
    const match = normalized.match(/^(-?\d+(?:\.\d+)?)(万|億|亿|千|[kKmMwW])?/);
    if (!match) return 0;

    const base = Number(match[1]);
    if (!Number.isFinite(base) || base < 0) return 0;
    const unit = match[2]?.toLowerCase();
    const multiplier = unit === '万' || unit === 'w' ? 10_000
        : unit === '億' || unit === '亿' ? 100_000_000
        : unit === '千' || unit === 'k' ? 1_000
        : unit === 'm' ? 1_000_000
        : 1;
    return Math.round(base * multiplier);
};

export interface NormalizedXhsComment {
    commentId: string;
    userId: string;
    author: string;
    content: string;
    likes: number;
    parentCommentId?: string;
    subComments: NormalizedXhsComment[];
}

export type XhsCommentReadStatus = 'loaded' | 'empty' | 'unavailable' | 'not_requested';

const firstArray = (...values: any[]): any[] | undefined => {
    for (const value of values) {
        if (Array.isArray(value)) return value;
    }
    return undefined;
};

export const normalizeXhsComments = (payload: any): NormalizedXhsComment[] => {
    const root = payload?.data && typeof payload.data === 'object' ? payload.data : payload || {};
    const note = root.note || payload?.note || {};
    const rawComments = firstArray(
        root.comments?.list,
        root.comments?.comment_list,
        root.comment_list,
        Array.isArray(root.comments) ? root.comments : undefined,
        payload?.comments?.list,
        payload?.comments?.comment_list,
        payload?.comment_list,
        Array.isArray(payload?.comments) ? payload.comments : undefined,
        note.comments?.list,
        note.comments?.comment_list,
        note.comment_list,
        Array.isArray(note.comments) ? note.comments : undefined,
    ) || [];

    const normalizeComment = (comment: any, parentCommentId?: string): NormalizedXhsComment => {
        const user = comment?.userInfo || comment?.user_info || comment?.user || {};
        const commentId = String(comment?.id || comment?.commentId || comment?.comment_id || '');
        const replies = firstArray(
            comment?.subComments,
            comment?.sub_comments,
            comment?.sub_comment_list,
            comment?.replies,
        ) || [];
        return {
            commentId,
            userId: String(user.userId || user.user_id || comment?.userId || comment?.user_id || ''),
            author: String(
                user.nickname || user.name || comment?.nickname || comment?.userName
                || comment?.user_name || comment?.author_name || comment?.author || '匿名',
            ),
            content: String(comment?.content || '').trim(),
            likes: parseXhsCount(comment?.likeCount ?? comment?.like_count ?? comment?.likes ?? 0),
            parentCommentId,
            subComments: replies.map((reply: any) => normalizeComment(reply, commentId || parentCommentId)),
        };
    };

    return rawComments.map((comment: any) => normalizeComment(comment));
};

export const normalizeNote = (n: any): {
    noteId: string;
    title: string;
    desc: string;
    author: string;
    authorId: string;
    likes: number;
    collects: number;
    commentCount: number;
    shareCount: number;
    xsecToken?: string;
    xsecSource?: string;
    url?: string;
    platform?: 'xhs' | 'rednote';
    coverUrl?: string;
    type?: string;
} => {
    const card = n.noteCard || n.note_card || n.notecard;
    // 封面：cover 对象 / 字符串，或笔记图片列表首图（feed detail 返回 image_list）。
    const coverObj = card?.cover || n.cover || n.image_list?.[0] || card?.image_list?.[0];
    const rawCoverUrl = typeof coverObj === 'string' ? coverObj
        : coverObj?.urlDefault || coverObj?.url_default || coverObj?.url || coverObj?.urlPre
        || coverObj?.info_list?.[0]?.url || undefined;
    const coverUrl = rawCoverUrl?.replace(/^http:\/\//, 'https://');
    // 点赞数：支持 interactInfo.likedCount (profile notes) 和 interact_info.liked_count (search results)
    const interact = n.interact_info || n.interactInfo
        || card?.interact_info || card?.interactInfo || {};
    const likesRaw = n.likes ?? n.liked_count ?? interact.liked_count ?? interact.likedCount ?? 0;
    const collectsRaw = n.collects ?? n.collected_count ?? interact.collected_count ?? interact.collectedCount ?? 0;
    const commentCountRaw = n.commentCount ?? n.comment_count ?? interact.comment_count ?? interact.commentCount ?? 0;
    const shareCountRaw = n.shareCount ?? n.share_count ?? interact.share_count ?? interact.shareCount ?? 0;
    const noteId = n.noteId || n.note_id || n.id || card?.note_id || card?.noteId || '';
    const platform = n.platform === 'rednote' || n.platform === 'xhs' ? n.platform : litePlatform === 'rednote' ? 'rednote' : 'xhs';
    const xsecToken = n.xsecToken || n.xsec_token || card?.xsec_token || card?.xsecToken || undefined;
    const xsecSource = n.xsecSource || n.xsec_source || card?.xsec_source || card?.xsecSource || undefined;
    const url = buildXhsNoteLink({noteId, platform, xsecToken, xsecSource, url:n.url || n.note_url,
        shareUrl:n.shareUrl || n.share_url || card?.share_url});
    return {
        noteId,
        title: n.title || n.display_title || n.displayTitle || card?.display_title || card?.displayTitle || '',
        desc: (n.desc || n.description || n.content || card?.desc || card?.description || card?.title || '').slice(0, 500),
        author: n.author || n.nickname || n.user?.nickname || n.user?.name || card?.user?.nickname || card?.user?.name || '',
        authorId: n.authorId || n.author_id || n.user?.user_id || n.user?.userId || card?.user?.user_id || card?.user?.userId || '',
        likes: parseXhsCount(likesRaw),
        collects: parseXhsCount(collectsRaw),
        commentCount: parseXhsCount(commentCountRaw),
        shareCount: parseXhsCount(shareCountRaw),
        xsecToken, xsecSource, url, platform,
        coverUrl,
        type: n.type || card?.type || undefined,
    };
};

export const normalizeXhsLiteDetail = (payload: any, commentLimit = 15): ReturnType<typeof normalizeNote> & {
    comments?: { author: string; content: string; likes: number; commentId?: string; userId?: string }[];
    commentReadStatus: XhsCommentReadStatus;
} => {
    const root = payload?.data && typeof payload.data === 'object' ? payload.data : payload || {};
    const note = normalizeNote(root.note || payload?.note || payload || {});
    const comments: { author: string; content: string; likes: number; commentId?: string; userId?: string }[] = [];
    const appendComments = (items: NormalizedXhsComment[]) => {
        for (const item of items) {
            if (comments.length >= commentLimit) return;
            if (item.content) {
                comments.push({
                    author: item.author,
                    content: item.content,
                    likes: item.likes,
                    commentId: item.commentId || undefined,
                    userId: item.userId || undefined,
                });
            }
            appendComments(item.subComments);
        }
    };
    appendComments(normalizeXhsComments(payload));

    const rawCommentArray = firstArray(
        root.comments?.list,
        root.comments?.comment_list,
        root.comment_list,
        Array.isArray(root.comments) ? root.comments : undefined,
    );
    const explicitStatus = root.comments_status || root.comment_read_status || payload?.comments_status;
    const commentError = root.comments_error || payload?.comments_error;
    const commentReadStatus: XhsCommentReadStatus = comments.length > 0 || explicitStatus === 'loaded'
        ? 'loaded'
        : explicitStatus === 'unavailable' || commentError
            ? 'unavailable'
            : rawCommentArray
                ? 'empty'
                : 'not_requested';

    return comments.length
        ? { ...note, comments, commentReadStatus }
        : { ...note, commentReadStatus };
};
