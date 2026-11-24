/**
 * 麦当劳 MCP 客户端 (Model Context Protocol over HTTP+SSE)
 *
 * 上游: https://mcp.mcd.cn  (官方麦当劳中国 MCP server)
 * 文档: https://open.mcd.cn/mcp/doc
 * Token: https://open.mcd.cn/mcp 申请, 每个用户独立, 存 localStorage
 *
 * 浏览器无法直连 mcd.cn (CORS), 走中心配置的 Cloudflare Worker 透传 (默认
 * https://proxy.friedsully.com, 用户可在「设置 → 自定义网络代理」里改):
 *   POST  <worker>/mcp/mcd
 *   Authorization: Bearer <user_mcp_token>
 *   body: 标准 JSON-RPC 2.0 报文
 */

import { getProxyWorkerUrl } from './proxyWorker';
import { formatUnknownError } from './errorSelfCheck';
import { summarizeHtmlErrorBody } from './networkFailureDiagnosis';

// 走中心配置的主代理 worker（用户可在设置里换成自部署实例）
const mcpProxyUrl = (): string => `${getProxyWorkerUrl()}/mcp/mcd`;
const MCP_TOKEN_KEY = 'aetheros.mcd.mcpToken';
const MCP_ENABLED_KEY = 'aetheros.mcd.mcpEnabled';

export interface McdToolDef {
    name: string;
    description?: string;
    inputSchema?: any;
}

export interface McdToolResult {
    success: boolean;
    data?: any;
    rawText?: string;
    error?: string;
}

export const normalizeMcdToolName = (toolName: string): string => {
    const raw = (toolName || '').trim();
    if (!raw) return raw;
    let s = raw;
    // 模型经常给工具名加"命名空间前缀"幻觉:
    //   mcd_goodies.query-meal-detail  (像 OpenAI Realtime / Cursor 风格)
    //   mcd.calculate-price
    //   functions.query-meals
    // 真实麦当劳 MCP 工具名都是纯 kebab-case, 不含点号, 所以遇到点直接取最后一段。
    const lastDot = s.lastIndexOf('.');
    if (lastDot >= 0 && lastDot < s.length - 1) {
        s = s.slice(lastDot + 1);
    }
    // 旧规则: 剥 mcd_tools_ / mcd_tool_ / mcd-tools- 这种下划线 / 短横线前缀
    s = s
        .replace(/^mcd[_-]?tools?[_-]/i, '')
        .replace(/^mcd[_-]?goodies[_-]/i, '') // 同义前缀, 兼容点号被换成下划线的情况
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

export const getMcdToken = (): string => {
    try { return localStorage.getItem(MCP_TOKEN_KEY) || ''; } catch { return ''; }
};

export const setMcdToken = (token: string): void => {
    try { localStorage.setItem(MCP_TOKEN_KEY, token.trim()); } catch { /* ignore */ }
};

export const isMcdEnabled = (): boolean => {
    try { return localStorage.getItem(MCP_ENABLED_KEY) === '1'; } catch { return false; }
};

export const setMcdEnabled = (enabled: boolean): void => {
    try { localStorage.setItem(MCP_ENABLED_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
};

export const isMcdConfigured = (): boolean => {
    return isMcdEnabled() && getMcdToken().length > 0;
};

// ── 备份用：把麦当劳的 token + 启用状态随「设置 → 导出/导入备份」一起带走（存 localStorage） ──
export function exportMcdLocal(): Record<string, string> | undefined {
    try {
        const out: Record<string, string> = {};
        const tk = localStorage.getItem(MCP_TOKEN_KEY); if (tk) out[MCP_TOKEN_KEY] = tk;
        const en = localStorage.getItem(MCP_ENABLED_KEY); if (en) out[MCP_ENABLED_KEY] = en;
        return Object.keys(out).length ? out : undefined;
    } catch { return undefined; }
}
export function importMcdLocal(data: Record<string, string> | null | undefined): void {
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
let cachedTools: McdToolDef[] = [];
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

let lastToolsListError: string | null = null;

const formatMcdRpcErr = (err: any): string => {
    if (typeof err === 'string') return err.trim() || '未知错误';
    return formatUnknownError(err, '未知错误');
};

const summarizeMcpText = (txt: string, maxLen: number): string => {
    const trimmed = (txt || '').trim();
    if (!trimmed) return '';
    if (/^\s*<(?:!doctype|html|head|body)\b/i.test(trimmed)) {
        return summarizeHtmlErrorBody(trimmed).headline.slice(0, maxLen);
    }
    return trimmed.slice(0, maxLen);
};

const parseResp = (text: string, contentType: string): McpJsonRpcResponse => {
    if (contentType.includes('text/event-stream') || /^\s*(event:|data:)/.test(text)) {
        const parsed = parseSse(text);
        if (parsed) return parsed;
    }
    try { return JSON.parse(text); } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
        throw new Error(`MCP: 无法解析响应: ${summarizeMcpText(text, 300)}`);
    }
};

const post = async (
    body: McpJsonRpcRequest,
    expectResponse = true
): Promise<{ response: McpJsonRpcResponse | null }> => {
    const token = getMcdToken();
    if (!token) throw new Error('未配置麦当劳 MCP Token，请到设置 → 麦当劳填入');

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${token}`,
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const resp = await fetch(mcpProxyUrl(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    const newSid = resp.headers.get('Mcp-Session-Id') || resp.headers.get('mcp-session-id');
    if (newSid) sessionId = newSid;

    if (resp.status === 401 || resp.status === 403) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`MCP 鉴权失败 (${resp.status}): Token 可能已过期或无效。${summarizeMcpText(txt, 120)}`);
    }
    if (resp.status === 202) return { response: null };
    if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`MCP HTTP ${resp.status}: ${summarizeMcpText(txt, 200)}`);
    }
    if (!expectResponse) return { response: null };

    const ct = resp.headers.get('content-type') || '';
    const text = await resp.text();
    return { response: parseResp(text, ct) };
};

const doInitialize = async (): Promise<void> => {
    lastToolsListError = null;
    const initReq = buildRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'AetherOS-Aetheros', version: '1.0.0' },
    });
    const { response } = await post(initReq);
    if (response?.error) throw new Error(`Initialize 失败: ${formatMcdRpcErr(response.error)}`);

    // 通知 server 初始化完成 (协议要求)
    const notif = buildRequest('notifications/initialized', {}, true);
    await post(notif, false).catch(() => { /* notification 失败不阻塞 */ });

    // 拉取工具清单
    try {
        const { response: toolsResp } = await post(buildRequest('tools/list'));
        if (toolsResp?.error) {
            lastToolsListError = formatMcdRpcErr(toolsResp.error);
        } else if (toolsResp?.result?.tools && Array.isArray(toolsResp.result.tools)) {
            cachedTools = toolsResp.result.tools.map((t: any) => ({
                name: t.name,
                description: t.description || '',
                inputSchema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
            }));
            console.log('[MCD-MCP] 工具清单:', cachedTools.map(t => t.name).join(', '));
        }
    } catch (e) {
        lastToolsListError = formatUnknownError(e, 'tools/list 失败');
        console.warn('[MCD-MCP] tools/list 失败:', e);
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

// ========== 公开 API ==========

/** 拉取工具清单 (会触发首次 initialize, 之后内存缓存) */
export const listMcdTools = async (forceRefresh = false): Promise<McdToolDef[]> => {
    if (forceRefresh) {
        initialized = false;
        sessionId = null;
        cachedTools = [];
        initPromise = null;
    }
    await ensureInitialized();
    return cachedTools;
};

const hasAnyCodeArg = (args: Record<string, any>, keys: string[]): boolean => {
    return keys.some((k) => {
        const v = args?.[k];
        if (Array.isArray(v)) return v.length > 0;
        if (typeof v === 'string') return v.trim().length > 0;
        return false;
    });
};

/**
 * 修复模型常犯的参数形态错误:
 *  - orderType 应该是整数 1 (到店) / 2 (外送), 模型经常给字符串 "1" / "delivery" / "DINE_IN"
 *  - items[].quantity 应该是整数, 模型经常给字符串 "1"
 *  - 到店 (orderType=1) 时 beCode 必须为 null/不传, 模型会顺手带上空串
 * 在客户端做一次温和的归一化, 避免上游 API 因为 1 vs "1" 类型不匹配返回空信封。
 */
const normalizeMcdArgs = (toolName: string, args: Record<string, any>): Record<string, any> => {
    if (!/calculate[-_]?price|create[-_]?order|submit[-_]?order/i.test(toolName)) return args;
    const out = { ...args };
    if (out.orderType != null) {
        const t = out.orderType;
        if (typeof t === 'string') {
            const s = t.trim().toLowerCase();
            if (s === '1' || s === 'pickup' || s === 'dine-in' || s === 'dine_in' || s === 'carryout' || s === 'in-store') out.orderType = 1;
            else if (s === '2' || s === 'delivery' || s === '麦乐送' || s === '外送') out.orderType = 2;
            else if (/^\d+$/.test(s)) out.orderType = parseInt(s, 10);
        }
    }
    if (Array.isArray(out.items)) {
        out.items = out.items.map((it: any) => {
            if (!it || typeof it !== 'object') return it;
            const ni = { ...it };
            if (ni.quantity != null && typeof ni.quantity === 'string' && /^\d+$/.test(ni.quantity.trim())) {
                ni.quantity = parseInt(ni.quantity.trim(), 10);
            }
            // 同义字段: code / sku → productCode (模型偶尔会用错字段名)
            if (!ni.productCode) {
                if (ni.code) ni.productCode = ni.code;
                else if (ni.skuCode) ni.productCode = ni.skuCode;
                else if (ni.mealCode) ni.productCode = ni.mealCode;
            }
            return ni;
        });
    }
    // 到店模式时 beCode 必须为 null/不传, 否则上游会按外送匹配走错路径
    if (out.orderType === 1 && out.beCode === '') delete out.beCode;
    return out;
};

/** 调用一个工具 */
export const callMcdTool = async (toolName: string, args: Record<string, any> = {}): Promise<McdToolResult> => {
    try {
        const normalizedToolName = normalizeMcdToolName(toolName);
        // 某些工具是“按 code 查详情”，空参几乎必定返回“成功但无数据”的空信封，容易误导模型和用户。
        // 在客户端前置兜底成明确错误，引导先走 query/list 拿 code 再查详情。
        // 注意工具名: 上游官方文档列表里只有 `query-meal-detail` 和 `mall-product-detail`,
        //            没有泛 `product-detail`; 而 mall-product-detail 用 spuId, 不是 productCodes,
        //            所以这里精确匹配, 不要再用宽泛的 /product[-_]?detail/。
        // query-meal-detail 入参是单数 string `code`, 不是数组。
        // list-nutrition-foods 按官方文档无需入参 (返回全量), 不要再拦它。
        const codeLookupRules: Array<{ pattern: RegExp; argKeys: string[]; hint: string }> = [
            { pattern: /^query[-_]?meal[-_]?detail$/i, argKeys: ['code', 'productCode', 'mealCode'], hint: 'code (单个餐品编码 string)' },
        ];
        const hit = codeLookupRules.find((r) => r.pattern.test(normalizedToolName));
        if (hit && !hasAnyCodeArg(args, hit.argKeys)) {
            return {
                success: false,
                error: `工具 ${normalizedToolName} 需要先提供餐品 code（参数: ${hit.hint}）。请先调用 query-meals 拿到 code 后再查。`,
            };
        }

        // calculate-price / create-order 的参数前置校验:
        // 文档要求 items 数组每项至少有 productCode + quantity, 没有就直接报错引导模型修正,
        // 而不是让上游静默返回空信封后用户对着空卡片发呆。
        if (/calculate[-_]?price|create[-_]?order|submit[-_]?order/i.test(normalizedToolName)) {
            const items = (args as any)?.items;
            if (!Array.isArray(items) || items.length === 0) {
                return {
                    success: false,
                    error: `工具 ${normalizedToolName} 需要 items 数组（每项至少有 productCode + quantity）。请先 query-meals / list-products 拿到商品 code 再调用。`,
                };
            }
            const bad = items.find((it: any) => !it || !it.productCode || it.quantity == null);
            if (bad) {
                return {
                    success: false,
                    error: `工具 ${normalizedToolName} 的 items 形态不对。每项必须有 productCode (商品编码) 和 quantity (数量)。当前传入: ${JSON.stringify(items).slice(0, 200)}`,
                };
            }
            if (!(args as any)?.storeCode) {
                return {
                    success: false,
                    error: `工具 ${normalizedToolName} 需要 storeCode (门店编码)。到店场景用 query-nearby-stores 找门店, 外送场景用 delivery-query-addresses 拿地址里的 storeCode + beCode。`,
                };
            }
            const ot = (args as any)?.orderType;
            if (ot == null || (typeof ot !== 'number' && !/^[12]$/.test(String(ot).trim()))) {
                return {
                    success: false,
                    error: `工具 ${normalizedToolName} 的 orderType 必须是整数 1 (到店) 或 2 (外送)。当前: ${JSON.stringify(ot)}`,
                };
            }
        }

        // 类型/字段归一化, 修掉 string vs int / 字段名小写差异这类坑
        args = normalizeMcdArgs(normalizedToolName, args);

        await ensureInitialized();
        const body = buildRequest('tools/call', { name: normalizedToolName, arguments: args });
        const { response } = await post(body);
        if (!response) return { success: false, error: '空响应' };
        if (response.error) return { success: false, error: `MCP 错误: ${formatMcdRpcErr(response.error)}` };

        const result = response.result;
        if (result?.content && Array.isArray(result.content)) {
            const textParts = result.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text || '');
            const fullText = textParts.join('\n').trim();
            if (result.isError) return { success: false, error: fullText || '麦当劳工具执行失败', rawText: fullText };

            // 在混合文本(markdown 说明 + JSON)里挖出 JSON。
            // 麦当劳 MCP 习惯在每个响应前塞一段 "## Response Structure" 渲染规范, 然后才接真数据。
            // 数据里有时会有未转义的真换行符 / 制表符, JSON.parse 会直接失败 → 加一道修复尝试。
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
                // 1) 整段直接是 JSON
                const direct = safeParse(text);
                if (direct !== undefined) return direct;
                // 2) ```json 围栏
                const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
                if (fenceMatch) {
                    const fenced = safeParse(fenceMatch[1].trim());
                    if (fenced !== undefined) return fenced;
                }
                // 3) 扫描所有 { 和 [ 起点, 用括号配平找完整结构, 选择最大的那个
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
                                return; // 找到一个合法的就回主循环找下一个起点
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
                        let score = Math.min(len, 4000) / 4000; // 轻微偏好更完整的片段，但不绝对
                        if (!obj || typeof obj !== 'object') return score;
                        if (Array.isArray(obj)) return score + (obj.length > 0 ? 2 : 0);
                        const keys = Object.keys(obj);
                        // 识别麦当劳信封
                        const envKeys = ['success', 'code', 'message', 'datetime', 'traceId', 'data'];
                        const envHits = envKeys.filter(k => k in obj).length;
                        if (envHits >= 4) score += 2;
                        const data = (obj as any).data;
                        // 强烈偏好“有实际 data”的候选，避开 Response Structure 示例壳
                        if (Array.isArray(data)) score += data.length > 0 ? 8 : -2;
                        else if (data && typeof data === 'object') score += Object.keys(data).length > 0 ? 8 : -2;
                        else if (typeof data === 'string') {
                            const s = data.trim();
                            if (s && s !== '{}' && s !== '[]' && s.toLowerCase() !== 'null') score += 3;
                        } else if (data == null) {
                            score -= 3;
                        }
                        // JSON Schema / Response Structure 片段常见字段，适度降权
                        if ('properties' in obj || '$schema' in obj || 'required' in obj) score -= 3;
                        return score;
                    };
                    candidates.sort((a, b) => scoreCandidate(b.parsed, b.len) - scoreCandidate(a.parsed, a.len));
                    return candidates[0].parsed;
                }
                return undefined;
            };
            // 解析: 上游有时把数据再次 stringify 装进 {data: "..."} / {result: "..."} 这类外壳,
            // 这里递归剥一层, 让卡片拿到真正的对象/数组
            const tryDeepParse = (v: any): any => {
                if (typeof v === 'string') {
                    const s = v.trim();
                    if (s.startsWith('{') || s.startsWith('[')) {
                        try { return tryDeepParse(JSON.parse(s)); } catch { return v; }
                    }
                    return v;
                }
                if (v && typeof v === 'object' && !Array.isArray(v)) {
                    // 麦当劳响应都套一层信封: {success, code, message, datetime, traceId, data: {...}}
                    // 自动剥掉, 直接把 data 字段当成数据本体
                    const envelopeKeys = ['success', 'code', 'message', 'datetime', 'traceId', 'msg', 'errorCode', 'errMsg'];
                    if ('data' in v && envelopeKeys.some(k => k in v)) {
                        const inner = v.data;
                        if (inner && typeof inner === 'object') return tryDeepParse(inner);
                        if (typeof inner === 'string') {
                            const s = inner.trim();
                            // 优先尝试当 JSON 解; 解不开就当成普通文本/toon 紧凑字符串直接返回。
                            // 关键: list-nutrition-foods / campaign-calendar / available-coupons 这类工具
                            // data 是 toon 表 / markdown 文本, 不是 JSON, 之前会"剥不掉信封"导致前端
                            // 误判'无数据'。这里无论解不解得开 JSON, 都返回 inner 字符串本体。
                            if (s.startsWith('{') || s.startsWith('[')) {
                                try { return tryDeepParse(JSON.parse(s)); } catch { /* fall through to return string */ }
                            }
                            return s;
                        }
                        // null / undefined / number / boolean 等原始类型也直接返回 inner, 不要把信封带回去
                        return inner;
                    }
                    // 单字段壳: {data: "..."} / {result: "..."} 等
                    const keys = Object.keys(v);
                    const wrapKeys = ['data', 'result', 'response', 'body', 'payload'];
                    if (keys.length === 1 && wrapKeys.includes(keys[0]) && typeof v[keys[0]] === 'string') {
                        const inner = tryDeepParse(v[keys[0]]);
                        if (inner && typeof inner === 'object') return inner;
                    }
                    // 否则对每个 string 字段尝试解 (一层即可, 避免无限递归)
                    const out: any = Array.isArray(v) ? [] : {};
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
            // 先尝试整段直接 parse, 不行再扫描混合文本
            let parsed: any = undefined;
            let parseRoute = 'none';
            try {
                parsed = JSON.parse(fullText);
                parseRoute = 'direct';
            } catch {
                parsed = tryExtractJsonFromMixed(fullText);
                if (parsed !== undefined) parseRoute = 'extracted';
            }
            if (parsed !== undefined) {
                const finalData = tryDeepParse(parsed);
                // 诊断日志: 让用户能看到工具到底返回了什么形态
                try {
                    const topKeys = finalData && typeof finalData === 'object' && !Array.isArray(finalData)
                        ? Object.keys(finalData).slice(0, 10).join(',')
                        : (Array.isArray(finalData) ? `[Array len=${finalData.length}]` : typeof finalData);
                    console.log(`🍔 [MCD-MCP] 工具结果 ${parseRoute} | rawLen=${fullText.length} | topKeys=${topKeys}`);
                } catch { /* ignore log errors */ }
                // calculate-price 按文档应返回对象 (含 productList / price 等), 永远不应是空数组。
                // 一旦上游回了空数组, 几乎可以确定是 storeCode/productCode/orderType/beCode 组合不被接受,
                // 把它显式翻成错误, 让模型在工具循环里能看到并自我纠正, 而不是闷头继续走下单流程。
                if (Array.isArray(finalData) && finalData.length === 0
                    && /calculate[-_]?price|query[-_]?meals/i.test(normalizedToolName)) {
                    let argsEcho = '';
                    try { argsEcho = `\n你这次传的参数: ${JSON.stringify(args)}`; } catch { /* ignore */ }
                    const isCalc = /calculate[-_]?price/i.test(normalizedToolName);
                    // 基于 args 真实形态智能猜根因, 不要写死"到店带了 beCode"这种死结论
                    const ot = (args as any)?.orderType;
                    const beCode = (args as any)?.beCode;
                    const hasBeCode = !!(beCode && String(beCode).trim());
                    const items = (args as any)?.items;
                    const itemArr = Array.isArray(items) ? items : [];
                    let smartHint = '';
                    if (ot === 1 && hasBeCode) {
                        smartHint = ` 看你 args 形态: 到店模式 (orderType=1) 但带了 beCode='${beCode}'。这是错配, 到店模式 beCode 必须不传 / 留空。移除 beCode 重试。`;
                    } else if (ot === 2 && !hasBeCode) {
                        smartHint = ` 看你 args 形态: 外送模式 (orderType=2) 但没传 beCode。外送必须传 beCode (跟 storeCode 同来自 delivery-query-addresses 的同一行)。`;
                    } else if (itemArr.length === 0) {
                        smartHint = ` 看你 args 形态: items 数组为空。`;
                    } else if (isCalc) {
                        // args 表面看没问题, 重点查 productCode 形态
                        const codes = itemArr.map((i: any) => i?.productCode).filter(Boolean);
                        const suspect = codes.find((c: string) => /^[A-Za-z]/.test(c)); // 真实麦当劳 productCode 全是数字, 字母开头多半是券 code
                        if (suspect) {
                            smartHint = ` 看你 args 形态: productCode='${suspect}' 以字母开头, 真实麦当劳商品 code 都是纯数字; 字母开头通常是优惠券商品 spu code, 那种 code 必须**配对 couponId + couponCode** 一起传 (在 items 同一项里), 否则上游不认。要么换成 query-meals 返回的纯数字 code, 要么补上 couponId + couponCode。`;
                        } else {
                            smartHint = ` 看你 args 形态没明显错 (storeCode=${(args as any)?.storeCode}, orderType=${ot}, ${hasBeCode ? 'beCode='+beCode : '无 beCode'}, items=${JSON.stringify(itemArr)})。最可能的根因: productCode 不在该 storeCode 当前模式的菜单里。先用同一组 (storeCode, orderType${ot===2?', beCode':''}) 调一次 query-meals 看实际有什么 code 再回来。`;
                        }
                    } else {
                        // query-meals 空表
                        smartHint = ` 看你 args: storeCode=${(args as any)?.storeCode}, orderType=${ot}, ${hasBeCode ? 'beCode='+beCode : '无 beCode'}。如果 storeCode/beCode 来自不同 address 就会空, 必须用同一行的成对值。`;
                    }
                    const errBody = isCalc
                        ? `calculate-price 上游返回空列表 (按文档应返回对象, 空说明上游拒绝了这组参数)。${smartHint}`
                        : `query-meals 上游返回空列表 (按文档应返回 {categories, meals} 对象, 空说明 storeCode + beCode + orderType 三元组上游不接受)。${smartHint}`;
                    return {
                        success: false,
                        error: `${errBody}${argsEcho}`,
                        rawText: fullText,
                    };
                }
                return { success: true, data: finalData, rawText: fullText };
            }
            console.warn(`🍔 [MCD-MCP] 工具结果 parse 全失败, rawLen=${fullText.length}, 前 200 字: ${fullText.slice(0, 200)}`);
            // 实在挖不到 JSON 就当成纯文本
            return { success: true, data: fullText, rawText: fullText };
        }
        return { success: true, data: result };
    } catch (e: any) {
        return { success: false, error: e?.message || String(e) };
    }
};

/** 测试连接: 仅验证 token 是否能成功 initialize + 拿到 tools */
export const testMcdConnection = async (): Promise<{ ok: boolean; message: string; tools?: McdToolDef[] }> => {
    try {
        // 重置状态以避免缓存的旧 session
        initialized = false;
        sessionId = null;
        cachedTools = [];
        initPromise = null;
        const tools = await listMcdTools(false);
        if (!tools.length && lastToolsListError) {
            return { ok: false, message: `握手成功，但拉取工具清单失败: ${lastToolsListError}` };
        }
        if (!tools.length) return { ok: true, message: '已连接, 但工具清单为空 (可能服务侧未挂载工具)', tools };
        return { ok: true, message: `已连接, 拿到 ${tools.length} 个工具`, tools };
    } catch (e: any) {
        return { ok: false, message: formatUnknownError(e, '连接失败') };
    }
};

/** 强制重置会话 (token 改变 / 退出登录时调用) */
export const resetMcdSession = (): void => {
    initialized = false;
    sessionId = null;
    cachedTools = [];
    initPromise = null;
};
