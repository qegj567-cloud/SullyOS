/**
 * 瑞幸 MCP 客户端 (Model Context Protocol over HTTP+SSE, streamable http)
 *
 * 上游: https://gwmcp.lkcoffee.com/order/user/mcp  (官方瑞幸点单 MCP server)
 * 平台: https://open.lkcoffee.com  (瑞幸 AI 开放平台)
 * Token: 登录 open.lkcoffee.com 后复制, 每个用户独立, 有效期约 1 个月, 存 localStorage
 *
 * 浏览器无法直连 lkcoffee.com (CORS), 走中心配置的 Cloudflare Worker 透传 (默认
 * https://proxy.friedsully.com, 用户可在「设置 → 自定义网络代理」里改):
 *   POST  <worker>/mcp/luckin
 *   Authorization: Bearer <user_mcp_token>
 *   body: 标准 JSON-RPC 2.0 报文
 *
 * 传输层与麦当劳 (utils/mcdMcpClient.ts) 完全同构: 同一套 initialize → tools/list →
 * tools/call + Mcp-Session-Id 会话管理。差异只在 URL / localStorage key, 以及参数
 * 归一化这里做得更"通用"(不写死瑞幸独有的字段校验, 等跑通 tools/list 看到真实
 * schema 后再按需收紧)。
 */

import { getProxyWorkerUrl } from './proxyWorker';
import { formatUnknownError } from './errorSelfCheck';
import { summarizeHtmlErrorBody } from './networkFailureDiagnosis';

// 走中心配置的主代理 worker（用户可在设置里换成自部署实例）
const mcpProxyUrl = (): string => `${getProxyWorkerUrl()}/mcp/luckin`;
const MCP_TOKEN_KEY = 'aetheros.luckin.mcpToken';
const MCP_ENABLED_KEY = 'aetheros.luckin.mcpEnabled';

export interface LuckinToolDef {
    name: string;
    description?: string;
    inputSchema?: any;
}

export interface LuckinToolResult {
    success: boolean;
    data?: any;
    rawText?: string;
    error?: string;
}

export const normalizeLuckinToolName = (toolName: string): string => {
    const raw = (toolName || '').trim();
    if (!raw) return raw;
    let s = raw;
    // 模型常给工具名加"命名空间前缀"幻觉:
    //   luckin.query-menu / functions.create-order / luckin_tools_query-stores
    // 真实瑞幸 MCP 工具名都是纯 kebab-case, 不含点号, 遇到点直接取最后一段。
    const lastDot = s.lastIndexOf('.');
    if (lastDot >= 0 && lastDot < s.length - 1) {
        s = s.slice(lastDot + 1);
    }
    s = s
        .replace(/^luckin[_-]?tools?[_-]/i, '')
        .replace(/^lk[_-]?coffee[_-]/i, '')
        .replace(/^coffee[_-]?tools?[_-]/i, '')
        .trim();
    return s || raw;
};

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

// ========== Token / 启用状态 (持久化在 localStorage) ==========

export const getLuckinToken = (): string => {
    try { return localStorage.getItem(MCP_TOKEN_KEY) || ''; } catch { return ''; }
};

export const setLuckinToken = (token: string): void => {
    try { localStorage.setItem(MCP_TOKEN_KEY, token.trim()); } catch { /* ignore */ }
};

export const isLuckinEnabled = (): boolean => {
    try { return localStorage.getItem(MCP_ENABLED_KEY) === '1'; } catch { return false; }
};

export const setLuckinEnabled = (enabled: boolean): void => {
    try { localStorage.setItem(MCP_ENABLED_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
};

export const isLuckinConfigured = (): boolean => {
    return isLuckinEnabled() && getLuckinToken().length > 0;
};

// ── 备份用：把瑞幸的 token + 启用状态随「设置 → 导出/导入备份」一起带走（存 localStorage） ──
export function exportLuckinLocal(): Record<string, string> | undefined {
    try {
        const out: Record<string, string> = {};
        const tk = localStorage.getItem(MCP_TOKEN_KEY); if (tk) out[MCP_TOKEN_KEY] = tk;
        const en = localStorage.getItem(MCP_ENABLED_KEY); if (en) out[MCP_ENABLED_KEY] = en;
        return Object.keys(out).length ? out : undefined;
    } catch { return undefined; }
}
export function importLuckinLocal(data: Record<string, string> | null | undefined): void {
    if (!data || typeof data !== 'object') return;
    try {
        if (typeof data[MCP_TOKEN_KEY] === 'string') localStorage.setItem(MCP_TOKEN_KEY, data[MCP_TOKEN_KEY]);
        if (typeof data[MCP_ENABLED_KEY] === 'string') localStorage.setItem(MCP_ENABLED_KEY, data[MCP_ENABLED_KEY]);
    } catch { /* ignore */ }
}

// ========== JSON-RPC 会话状态 (内存, 进程级) ==========

let requestIdCounter = 0;
let sessionId: string | null = null;
let initialized = false;
let cachedTools: LuckinToolDef[] = [];
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
        const summary = /^\s*<(?:!doctype|html|head|body)\b/i.test(text)
            ? summarizeHtmlErrorBody(text).headline.slice(0, 300)
            : text.slice(0, 300);
        throw new Error(`MCP: 无法解析响应: ${summary}`);
    }
};

let lastToolsListError: string | null = null;

const formatLuckinRpcErr = (err: any): string => {
    if (typeof err === 'string') return err.trim() || '未知错误';
    return formatUnknownError(err, '未知错误');
};

const summarizeLuckinHttpBody = (txt: string, maxLen: number): string => {
    const trimmed = (txt || '').trim();
    if (!trimmed) return '';
    if (/^\s*<(?:!doctype|html|head|body)\b/i.test(trimmed)) {
        return summarizeHtmlErrorBody(trimmed).headline.slice(0, maxLen);
    }
    return trimmed.slice(0, maxLen);
};

const post = async (
    body: McpJsonRpcRequest,
    expectResponse = true,
    signal?: AbortSignal
): Promise<{ response: McpJsonRpcResponse | null }> => {
    signal?.throwIfAborted();
    const token = getLuckinToken();
    if (!token) throw new Error('未配置瑞幸 MCP Token，请到设置 → 瑞幸填入');

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${token}`,
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const resp = await fetch(mcpProxyUrl(), {
        signal,
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    const newSid = resp.headers.get('Mcp-Session-Id') || resp.headers.get('mcp-session-id');
    if (newSid) sessionId = newSid;

    if (resp.status === 401 || resp.status === 403) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`MCP 鉴权失败 (${resp.status}): Token 可能已过期或无效 (瑞幸 token 有效期约 1 个月)。${summarizeLuckinHttpBody(txt, 120)}`);
    }
    if (resp.status === 202) return { response: null };
    if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`MCP HTTP ${resp.status}: ${summarizeLuckinHttpBody(txt, 200)}`);
    }
    if (!expectResponse) return { response: null };

    const ct = resp.headers.get('content-type') || '';
    const text = await resp.text();
    return { response: parseResp(text, ct) };
};

const doInitialize = async (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    lastToolsListError = null;
    const initReq = buildRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'AetherOS-Aetheros', version: '1.0.0' },
    });
    const { response } = await post(initReq, undefined, signal);
    if (response?.error) throw new Error(`Initialize 失败: ${formatLuckinRpcErr(response.error)}`);

    // 通知 server 初始化完成 (协议要求)
    const notif = buildRequest('notifications/initialized', {}, true);
    await post(notif, false, signal).catch(() => { /* notification 失败不阻塞 */ });

    // 拉取工具清单
    try {
        const { response: toolsResp } = await post(buildRequest('tools/list'), undefined, signal);
        if (toolsResp?.error) {
            lastToolsListError = formatLuckinRpcErr(toolsResp.error);
        } else if (toolsResp?.result?.tools && Array.isArray(toolsResp.result.tools)) {
            cachedTools = toolsResp.result.tools.map((t: any) => ({
                name: t.name,
                description: t.description || '',
                inputSchema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
            }));
            console.log('[Luckin-MCP] 工具清单:', cachedTools.map(t => t.name).join(', '));
        }
    } catch (e) {
        signal?.throwIfAborted();
        lastToolsListError = formatUnknownError(e, 'tools/list 失败');
        console.warn('[Luckin-MCP] tools/list 失败:', e);
    }

    initialized = true;
};

const ensureInitialized = async (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (initialized) return;
    if (!initPromise) {
        initPromise = doInitialize(signal).catch((e) => {
            initPromise = null;
            throw e;
        });
    }
    await initPromise;
};

// ========== 公开 API ==========

/** 拉取工具清单 (会触发首次 initialize, 之后内存缓存) */
export const listLuckinTools = async (forceRefresh = false, signal?: AbortSignal): Promise<LuckinToolDef[]> => {
    signal?.throwIfAborted();
    if (forceRefresh) {
        initialized = false;
        sessionId = null;
        cachedTools = [];
        initPromise = null;
    }
    await ensureInitialized(signal);
    return cachedTools;
};

/**
 * 通用参数归一化 (不写死瑞幸专有字段, 只修模型最常犯的形态错):
 *  - 任意名为 quantity / qty / count / num 的字段, 字符串数字 → 整数
 *  - items / products / goods / cartItems 数组里每项同样处理 quantity, 并补 productCode 同义字段
 * 等跑通 tools/list 拿到真实 schema 后, 可以在这里按瑞幸实际字段名收紧校验。
 */
const QTY_KEYS = ['quantity', 'qty', 'count', 'num', 'number', 'amount'];
const ITEM_LIST_KEYS = ['productList', 'items', 'products', 'goods', 'cartItems', 'skuList', 'goodsList', 'list'];
const CODE_ALIASES = ['code', 'skuCode', 'goodsCode', 'productId', 'skuId', 'goodsId', 'spuId'];

const coerceQty = (obj: any): void => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of QTY_KEYS) {
        const v = obj[k];
        if (typeof v === 'string' && /^\d+$/.test(v.trim())) obj[k] = parseInt(v.trim(), 10);
    }
};

const normalizeLuckinArgs = (args: Record<string, any>): Record<string, any> => {
    if (!args || typeof args !== 'object') return args;
    const out = { ...args };
    coerceQty(out);
    for (const listKey of ITEM_LIST_KEYS) {
        if (Array.isArray(out[listKey])) {
            out[listKey] = out[listKey].map((it: any) => {
                if (!it || typeof it !== 'object') return it;
                const ni = { ...it };
                coerceQty(ni);
                // 同义字段 → productCode (模型偶尔用错字段名), 只在没有 productCode 时补
                if (!ni.productCode) {
                    for (const alias of CODE_ALIASES) {
                        if (ni[alias]) { ni.productCode = ni[alias]; break; }
                    }
                }
                return ni;
            });
        }
    }
    return out;
};

/** 调用一个工具 */
export const callLuckinTool = async (toolName: string, args: Record<string, any> = {}, signal?: AbortSignal): Promise<LuckinToolResult> => {
    signal?.throwIfAborted();
    try {
        const normalizedToolName = normalizeLuckinToolName(toolName);
        args = normalizeLuckinArgs(args);

        await ensureInitialized(signal);
        const body = buildRequest('tools/call', { name: normalizedToolName, arguments: args });
        const { response } = await post(body, undefined, signal);
        if (!response) return { success: false, error: '空响应' };
        if (response.error) return { success: false, error: `MCP 错误: ${formatLuckinRpcErr(response.error)}` };

        const result = response.result;
        if (result?.content && Array.isArray(result.content)) {
            const textParts = result.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text || '');
            const fullText = textParts.join('\n').trim();
            if (result.isError) return { success: false, error: fullText || '瑞幸工具执行失败', rawText: fullText };

            // 在混合文本(markdown 说明 + JSON)里挖出 JSON。
            // 这类网关 MCP 习惯在响应前塞一段渲染规范说明, 然后才接真数据。
            // 数据里有时有未转义的真换行符 / 制表符, JSON.parse 会失败 → 加一道修复尝试。
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
                try { return JSON.parse(s); } catch {
        signal?.throwIfAborted(); /* try repair */ }
                try { return JSON.parse(repairJson(s)); } catch {
        signal?.throwIfAborted(); return undefined; }
            };
            const tryExtractJsonFromMixed = (text: string): any => {
                if (!text) return undefined;
                // 1) 整段直接是 JSON
                const direct = safeParse(text);
                if (direct !== undefined) return direct;
                // 2) ```json 围栏
                const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
                if (fenceMatch) {
                    const fenced = safeParse(fenceMatch[1].trim());
                    if (fenced !== undefined) return fenced;
                }
                // 3) 扫描所有 { 和 [ 起点, 用括号配平找完整结构, 选择"最像真数据"的那个
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
                    const scoreCandidate = (obj: any, len: number): number => {
                        let score = Math.min(len, 4000) / 4000;
                        if (!obj || typeof obj !== 'object') return score;
                        if (Array.isArray(obj)) return score + (obj.length > 0 ? 2 : 0);
                        const envKeys = ['success', 'code', 'message', 'msg', 'datetime', 'traceId', 'data'];
                        const envHits = envKeys.filter(k => k in obj).length;
                        if (envHits >= 3) score += 2;
                        const data = (obj as any).data;
                        if (Array.isArray(data)) score += data.length > 0 ? 8 : -2;
                        else if (data && typeof data === 'object') score += Object.keys(data).length > 0 ? 8 : -2;
                        else if (typeof data === 'string') {
                            const s = data.trim();
                            if (s && s !== '{}' && s !== '[]' && s.toLowerCase() !== 'null') score += 3;
                        } else if (data == null) {
                            score -= 3;
                        }
                        if ('properties' in obj || '$schema' in obj || 'required' in obj) score -= 3;
                        return score;
                    };
                    candidates.sort((a, b) => scoreCandidate(b.parsed, b.len) - scoreCandidate(a.parsed, a.len));
                    return candidates[0].parsed;
                }
                return undefined;
            };
            // 递归剥信封: 上游有时把数据再次 stringify 装进 {data: "..."} 外壳
            const tryDeepParse = (v: any): any => {
                if (typeof v === 'string') {
                    const s = v.trim();
                    if (s.startsWith('{') || s.startsWith('[')) {
                        try { return tryDeepParse(JSON.parse(s)); } catch {
        signal?.throwIfAborted(); return v; }
                    }
                    return v;
                }
                if (v && typeof v === 'object' && !Array.isArray(v)) {
                    // 标准网关信封: {success, code, message/msg, data: {...}} → 自动剥到 data
                    const envelopeKeys = ['success', 'code', 'message', 'msg', 'datetime', 'traceId', 'errorCode', 'errMsg'];
                    if ('data' in v && envelopeKeys.some(k => k in v)) {
                        const inner = v.data;
                        if (inner && typeof inner === 'object') return tryDeepParse(inner);
                        if (typeof inner === 'string') {
                            const s = inner.trim();
                            if (s.startsWith('{') || s.startsWith('[')) {
                                try { return tryDeepParse(JSON.parse(s)); } catch {
        signal?.throwIfAborted(); /* fall through */ }
                            }
                            return s;
                        }
                        return inner;
                    }
                    // 单字段壳: {data: "..."} / {result: "..."} 等
                    const keys = Object.keys(v);
                    const wrapKeys = ['data', 'result', 'response', 'body', 'payload'];
                    if (keys.length === 1 && wrapKeys.includes(keys[0]) && typeof v[keys[0]] === 'string') {
                        const inner = tryDeepParse(v[keys[0]]);
                        if (inner && typeof inner === 'object') return inner;
                    }
                    // 否则对每个 string 字段尝试解 (一层即可)
                    const out: any = {};
                    for (const k of keys) {
                        const cv = v[k];
                        if (typeof cv === 'string') {
                            const s = cv.trim();
                            if (s.startsWith('{') || s.startsWith('[')) {
                                try { out[k] = JSON.parse(s); continue; } catch {
        signal?.throwIfAborted(); /* ignore */ }
                            }
                        }
                        out[k] = cv;
                    }
                    return out;
                }
                return v;
            };
            let parsed: any = undefined;
            let parseRoute = 'none';
            try {
                parsed = JSON.parse(fullText);
                parseRoute = 'direct';
            } catch {
                signal?.throwIfAborted();
                parsed = tryExtractJsonFromMixed(fullText);
                if (parsed !== undefined) parseRoute = 'extracted';
            }
            if (parsed !== undefined) {
                const finalData = tryDeepParse(parsed);
                try {
                    const topKeys = finalData && typeof finalData === 'object' && !Array.isArray(finalData)
                        ? Object.keys(finalData).slice(0, 10).join(',')
                        : (Array.isArray(finalData) ? `[Array len=${finalData.length}]` : typeof finalData);
                    console.log(`☕ [Luckin-MCP] 工具结果 ${parseRoute} | rawLen=${fullText.length} | topKeys=${topKeys}`);
                } catch {
        signal?.throwIfAborted(); /* ignore log errors */ }
                return { success: true, data: finalData, rawText: fullText };
            }
            console.warn(`☕ [Luckin-MCP] 工具结果 parse 全失败, rawLen=${fullText.length}, 前 200 字: ${fullText.slice(0, 200)}`);
            return { success: true, data: fullText, rawText: fullText };
        }
        return { success: true, data: result };
    } catch (e: any) {
        signal?.throwIfAborted();
        return { success: false, error: e?.message || String(e) };
    }
};

/** 测试连接: 仅验证 token 是否能成功 initialize + 拿到 tools */
export const testLuckinConnection = async (signal?: AbortSignal): Promise<{ ok: boolean; message: string; tools?: LuckinToolDef[] }> => {
    signal?.throwIfAborted();
    try {
        initialized = false;
        sessionId = null;
        cachedTools = [];
        initPromise = null;
        const tools = await listLuckinTools(false, signal);
        if (!tools.length && lastToolsListError) {
            return { ok: false, message: `握手成功，但拉取工具清单失败: ${lastToolsListError}` };
        }
        if (!tools.length) return { ok: true, message: '已连接, 但工具清单为空 (可能服务侧未挂载工具)', tools };
        return { ok: true, message: `已连接, 拿到 ${tools.length} 个工具`, tools };
    } catch (e: any) {
        signal?.throwIfAborted();
        return { ok: false, message: formatUnknownError(e, '连接失败') };
    }
};

/** 强制重置会话 (token 改变 / 退出登录时调用) */
export const resetLuckinSession = (): void => {
    initialized = false;
    sessionId = null;
    cachedTools = [];
    initPromise = null;
};
