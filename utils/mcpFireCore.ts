/**
 * mcpFireCore — 通用 MCP 的环境无关核心（浏览器 / amsg worker 共用叶子）。
 *
 * mcpClient.ts 管浏览器侧的事（localStorage 配置、代理包装、发现流程）；
 * 这里只放两端都要跑的纯逻辑：工具名映射、JSON-RPC 传输、正文假调用解析、
 * 结果格式化、后台 fire 的提示词块与 tools 数组。
 *
 * 段落顺序是固定的，新东西插进对应分区，别随手往文件尾巴追加：
 *   共用类型 → 工具名与长度预算（含名映射）→ 工具结果回填
 *   → 正文假调用解析 → JSON-RPC 传输层 → 后台 fire 专用
 * 传输层是底座、fire 层是它的消费方，所以 fire 那几个函数收在最后一个分区里。
 *
 * 环境无关叶子模块：不 import 任何带浏览器依赖的东西（会进 worker bundle）。
 */

// ========== 共用类型 ==========

export interface McpFireToolDef {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: any;
    outputSchema?: any;
    /** MCP 2025-03-26+ 的工具行为提示；只把它当安全提示，不能当权限证明。 */
    annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
}

/**
 * 上云 / 进 worker 的服务器形状：McpServerConfig 的结构子集
 * （没有 proxyUrl/proxyKey——worker 侧 fetch 没有 CORS，直连 url）。
 */
export interface McpFireServer {
    id: string;
    name: string;
    url: string;
    /** Bearer Token，可选（Authorization: Bearer <token>） */
    token?: string;
    customHeaders?: Array<{ name: string; value: string }>;
    /** 空/缺省 = 通用；非空 = 只有这些角色可见（与 mcpClient.getEnabledMcpServers 同语义） */
    charIds?: string[];
    tools?: McpFireToolDef[];
}

export interface McpResolvedToolCore<S extends McpFireServer = McpFireServer> {
    server: S;
    toolName: string;
    /** 工具定义本体，建映射时一并带出，省得调用方再按名字回服务器里反查 */
    tool: McpFireToolDef;
}

// ========== 工具名与长度预算 ==========

/** OpenAI 工具名的长度上限。 */
const DEFAULT_MAX_TOOL_NAME_LEN = 64;

/** worker 侧 MCP 工具的暴露名前缀（native 声明与正文解析统一用它路由）。 */
export const MCP_FIRE_NAME_PREFIX = 'mcp__';
/** fire 侧名映射的长度预算：拼前缀后不超 OpenAI 工具名 64 上限。 */
export const MCP_FIRE_NAME_BUDGET = DEFAULT_MAX_TOOL_NAME_LEN - MCP_FIRE_NAME_PREFIX.length;

// OpenAI 工具名只允许 [A-Za-z0-9_-]，最长 64；MCP 工具名可能带点号等。
// maxLen 可收紧：worker 侧要在暴露名前面拼 `mcp__` 前缀，得先给前缀留出位置。
// 预算是算出来的（上限减前缀长度），万一算成 0 或负数，这里兜到至少留 1 个字符，
// 免得返回空串或者被 slice 的负数下标倒着截。
export const sanitizeMcpToolName = (name: string, maxLen = DEFAULT_MAX_TOOL_NAME_LEN): string => {
    const len = Math.max(1, maxLen);
    return (name || 'tool').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, len);
};

/** 重名兜底后缀：基名先截到给 `_<i>` 留位的长度，避免截断吃掉计数器后候选名不再变化。 */
export const withMcpDedupeSuffix = (base: string, i: number, maxLen = DEFAULT_MAX_TOOL_NAME_LEN): string => {
    const suffix = `_${i}`;
    // 预算比后缀本身还短时，留位长度会变负数，slice 会从尾巴倒着截、反而吐出一长串；
    // 夹到 0 之后这种极端情况拿到的是纯后缀，长度仍然可控，计数器也照样能区分。
    return base.slice(0, Math.max(0, maxLen - suffix.length)) + suffix;
};

const serverSlug = (server: McpFireServer, maxLen = DEFAULT_MAX_TOOL_NAME_LEN): string =>
    sanitizeMcpToolName(server.name, maxLen).slice(0, 20);

/**
 * 暴露名 → 真实工具 的映射。暴露名默认用工具原名（sanitize 后）；
 * 跨服务器重名时后者加 <服务器名>_ 前缀。前台 buildMcpOpenAITools 与
 * worker fire 路径都用这一份，保证两端看到同一套名字。
 *
 * maxNameLen：暴露名的长度预算，缺省 64（OpenAI 上限）。worker 侧传更小的值，
 * 好给后面要拼的 `mcp__` 前缀留位。
 */
export const buildMcpNameMap = <S extends McpFireServer>(
    servers: S[],
    opts: { maxNameLen?: number } = {},
): Map<string, McpResolvedToolCore<S>> => {
    const maxLen = opts.maxNameLen ?? DEFAULT_MAX_TOOL_NAME_LEN;
    const resolve = new Map<string, McpResolvedToolCore<S>>();
    for (const server of servers) {
        for (const t of server.tools || []) {
            let exposed = sanitizeMcpToolName(t.name, maxLen);
            if (resolve.has(exposed)) {
                // 带服务器前缀再试；还撞就在后面挂计数器（计数器由 withMcpDedupeSuffix 保位）
                const prefixed = sanitizeMcpToolName(`${serverSlug(server, maxLen)}_${t.name}`, maxLen);
                exposed = prefixed;
                let i = 2;
                while (resolve.has(exposed)) exposed = withMcpDedupeSuffix(prefixed, i++, maxLen);
            }
            resolve.set(exposed, { server, toolName: t.name, tool: t });
        }
    }
    return resolve;
};

// ========== 工具结果回填 ==========

/**
 * MCP 结果（记忆检索、网页抓取等）体量远超瑞幸商品列表，1500 字符会把一条
 * 完整结果拦腰截断。上限放到 20000 只防病态超长结果炸上下文——工具循环每轮
 * 会全量重发消息，真有兆级 JSON 混进来会直接 4xx 或 token 起飞。
 */
export const MCP_RESULT_MAX_CHARS = 20000;

export const formatMcpToolResult = (data: any): string => {
    let s: string;
    try { s = typeof data === 'string' ? data : JSON.stringify(data); } catch { s = String(data); }
    return s.length > MCP_RESULT_MAX_CHARS
        ? `${s.slice(0, MCP_RESULT_MAX_CHARS)}…[结果过长已截断, 全文共 ${s.length} 字符]`
        : s;
};

// ========== 掉格式容错: 正文里的"假工具调用" ==========
//
// 不支持 function calling 的模型（或被中转剥了 tools 参数的）看到系统块里的
// 工具清单后, 会把调用直接"演"在正文里, 常见形态:
//   ask_question("SullyOS")           ← 括号传参
//   ask_question: SullyOS             ← 冒号传参（整行）
//   get_weather({"city": "上海"})     ← 括号传 JSON
// 与见面观测协议同款思路的两层容错: FC 通道是第一层, 这里兜第二层。
// 只认已启用服务器的真实工具名（暴露名/原名都认, 后台还可以额外认带前缀的写法）,
// 避免误伤普通文字。

export interface FakedMcpCall<S extends McpFireServer = McpFireServer> {
    exposedName: string;
    server: S;
    toolName: string;
    args: Record<string, any>;
    matched: string;
}

/** 从正文兼容调用中剥掉调用语法，只留下可以先展示给用户的角色文字。 */
export const stripTextFakedMcpCalls = (content: string, calls: Array<{ matched: string }>): string => {
    let cleaned = content;
    for (const call of calls) cleaned = cleaned.split(call.matched).join('');
    return cleaned.replace(/\n{3,}/g, '\n\n').trim();
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const stripQuotes = (s: string): string => {
    const t = s.trim();
    const m = t.match(/^(['"`「『])([\s\S]*)(['"`」』])$/);
    return m ? m[2] : t;
};

/** schema 的参数名顺序: required 优先, 其余按声明序 —— 用于位置参数落位 */
const positionalKeys = (schema: any): string[] => {
    const props = schema?.properties ? Object.keys(schema.properties) : [];
    const req = Array.isArray(schema?.required) ? schema.required.filter((k: string) => props.includes(k)) : [];
    return [...req, ...props.filter(k => !req.includes(k))];
};

const coerceBySchema = (value: string, schema: any, key: string): any => {
    const type = schema?.properties?.[key]?.type;
    const v = stripQuotes(value);
    if (type === 'number' || type === 'integer') {
        const n = Number(v);
        if (Number.isFinite(n)) return type === 'integer' ? Math.trunc(n) : n;
    }
    if (type === 'boolean') {
        if (/^(true|是|开)$/i.test(v)) return true;
        if (/^(false|否|关)$/i.test(v)) return false;
    }
    return v;
};

/** 顶层逗号切分（尊重引号与花括号嵌套） */
const splitTopLevel = (s: string): string[] => {
    const out: string[] = [];
    let depth = 0, cur = '', quote = '';
    for (const ch of s) {
        if (quote) {
            cur += ch;
            if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
        if (ch === '{' || ch === '[') depth++;
        if (ch === '}' || ch === ']') depth--;
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
};

/** 把括号里的原始文本解析成 args 对象（JSON / kwargs / 位置参数三种形态） */
const parseFakedArgs = (inner: string, schema: any): Record<string, any> => {
    const t = inner.trim();
    if (!t) return {};
    // JSON 形态
    if (t.startsWith('{')) {
        try { return JSON.parse(t); } catch { /* 尝试宽松修复 */ }
        try {
            return JSON.parse(t
                .replace(/,\s*([}\]])/g, '$1')
                .replace(/'/g, '"')
                .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":'));
        } catch { /* 落回单参数 */ }
    }
    const parts = splitTopLevel(t);
    // kwargs 形态: key=value / key: value
    if (parts.every(p => /^\s*[A-Za-z_]\w*\s*[=:]/.test(p))) {
        const args: Record<string, any> = {};
        for (const p of parts) {
            const m = p.match(/^\s*([A-Za-z_]\w*)\s*[=:]\s*([\s\S]*)$/);
            if (m) args[m[1]] = coerceBySchema(m[2], schema, m[1]);
        }
        return args;
    }
    // 位置参数形态: 按 schema 声明顺序落位
    const keys = positionalKeys(schema);
    const args: Record<string, any> = {};
    parts.forEach((p, i) => {
        const key = keys[i];
        if (key) args[key] = coerceBySchema(p, schema, key);
    });
    return args;
};

/**
 * 从 AI 正文里提取"假工具调用"。只匹配 resolve 里已知的工具名（暴露名/真实名）。
 * 返回按出现位置排序、按 matched 文本去重的调用列表。
 *
 * alsoMatchPrefix：额外认「前缀 + 暴露名」这种写法。后台 fire 的 native 模式里，
 * tools 数组给模型看的名字是带 `mcp__` 前缀的（见 buildMcpFireTools），模型掉格式
 * 把调用演进正文时写的多半也是带前缀那个，不认就只能把调用语法原样推给用户。
 * 认出来之后 exposedName 仍然回裸名，下游按暴露名查表的逻辑不用改。
 */
export const extractTextFakedMcpCalls = <S extends McpFireServer>(
    content: string,
    resolve: Map<string, McpResolvedToolCore<S>>,
    opts: { alsoMatchPrefix?: string } = {},
): FakedMcpCall<S>[] => {
    if (!content || !resolve.size) return [];

    // 名字查找表: 暴露名和真实工具名都认（模型两种都可能写）
    const lookup = new Map<string, { exposed: string; hit: McpResolvedToolCore<S> }>();
    for (const [exposed, hit] of resolve) {
        lookup.set(exposed, { exposed, hit });
        lookup.set(hit.toolName, { exposed, hit });
        if (opts.alsoMatchPrefix) lookup.set(`${opts.alsoMatchPrefix}${exposed}`, { exposed, hit });
    }

    const found: Array<FakedMcpCall<S> & { index: number }> = [];
    const seen = new Set<string>();

    for (const [name, { exposed, hit }] of lookup) {
        const schema = hit.tool.inputSchema;
        const esc = escapeRegExp(name);

        // 形态1: name(args) —— 前面不能是单词字符/点/斜杠（防止匹配到更长标识符的一部分）
        const parenRe = new RegExp(`(^|[^\\w./])${esc}\\s*\\(([^)]*)\\)`, 'g');
        for (const m of content.matchAll(parenRe)) {
            const matched = m[0].slice(m[1].length);
            const key = `${exposed}|${matched}`;
            if (seen.has(key)) continue;
            seen.add(key);
            found.push({
                exposedName: exposed,
                server: hit.server,
                toolName: hit.toolName,
                args: parseFakedArgs(m[2], schema),
                matched,
                index: (m.index ?? 0) + m[1].length,
            });
        }

        // 形态2: 行首 name: 值 —— 限定行首, 避免误伤句中"提到"工具名的普通文字
        const colonRe = new RegExp(`(^|\\n)\\s*[>*-]*\\s*\`?${esc}\`?\\s*[:：]\\s*([^\\n]+)`, 'g');
        for (const m of content.matchAll(colonRe)) {
            const matched = m[0].slice(m[1].length);
            const key = `${exposed}|${matched.trim()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const keys = positionalKeys(schema);
            const value = stripQuotes(m[2].replace(/[。！？!?…\s]+$/, ''));
            found.push({
                exposedName: exposed,
                server: hit.server,
                toolName: hit.toolName,
                args: keys.length ? { [keys[0]]: coerceBySchema(value, schema, keys[0]) } : {},
                matched,
                index: (m.index ?? 0) + m[1].length,
            });
        }
    }

    return found
        .sort((a, b) => a.index - b.index)
        .map(({ index: _index, ...call }) => call);
};

// ========== JSON-RPC 传输层 ==========
//
// Streamable HTTP：握手 initialize → 通知 notifications/initialized → tools/list / tools/call。
// 会话状态和请求目标都是显式传参，所以浏览器（配置在 localStorage、请求包代理）
// 和 worker（配置随 tool_config 上云、直连服务器）能共用同一套收发逻辑。

/**
 * SullyOS 现在使用的是单端点 Streamable HTTP，所以不能再宣称只属于旧 HTTP+SSE
 * 双端点时代的 2024-11-05。2026-07-28 是另一套无握手协议；本客户端先把成熟且
 * 广泛部署的 handshake era 做完整，modern era 后续单独接入，不能只换日期冒充支持。
 */
export const MCP_LATEST_HANDSHAKE_PROTOCOL_VERSION = '2025-11-25';
export const MCP_SUPPORTED_HANDSHAKE_PROTOCOL_VERSIONS = [
    '2025-11-25',
    '2025-06-18',
    '2025-03-26',
] as const;

// 远端 MCP / 用户自建代理都可能保持连接不结束。不能让一次 tools/call
// 永久卡住整条聊天链路（外层 isTyping 只有等 Promise 结束后才会清掉）。
export const MCP_REQUEST_TIMEOUT_MS = 60_000;

export interface McpToolResult {
    success: boolean;
    data?: any;
    rawText?: string;
    error?: string;
}

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

/**
 * 一个 MCP 服务器连接的会话状态。持有者自己决定生命周期：
 * 浏览器 = 模块级 Map（跨轮复用）；worker = 挂在单次 fire 的 stash 上。
 */
export interface McpSessionState {
    sessionId: string | null;
    initialized: boolean;
    initPromise: Promise<void> | null;
    /** initialize 由服务端确认的版本；后续 HTTP 请求必须带 MCP-Protocol-Version。 */
    protocolVersion: string | null;
    /** 只用于接线台诊断展示，不参与权限或行为判断。 */
    serverInfo: { name?: string; title?: string; version?: string } | null;
    serverCapabilities: Record<string, any> | null;
    /** JSON-RPC 请求 id，每个会话各数各的 */
    nextId: number;
}

export const createMcpSessionState = (): McpSessionState =>
    ({
        sessionId: null,
        initialized: false,
        initPromise: null,
        protocolVersion: null,
        serverInfo: null,
        serverCapabilities: null,
        nextId: 0,
    });

/** 一次请求的目标：最终 URL + 请求头构造。浏览器侧包代理，worker 侧直连。 */
export interface McpTransportTarget {
    signal?: AbortSignal;
    url: string;
    headers: (
        sessionId: string | null,
        protocolVersion: string | null,
    ) => Headers | Record<string, string>;
    /**
     * fetch 当场抛异常（连不上 / 被浏览器拦下）时，附在报错后面的排查提示。
     * 代理和 CORS 都是浏览器侧才有的概念，话术由调用方给；worker 直连可以不传。
     */
    fetchErrorHint?: string;
}

const buildRpcRequest = (
    session: McpSessionState,
    method: string,
    params?: any,
    isNotification = false,
): McpJsonRpcRequest => {
    const req: McpJsonRpcRequest = { jsonrpc: '2.0', method, params };
    if (!isNotification) req.id = ++session.nextId;
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
        throw new Error(`MCP: 无法解析响应: ${text.slice(0, 300)}`);
    }
};

/** Streamable HTTP 的 SSE 可能保持连接；读到当前 JSON-RPC id 的结果即可返回。 */
const readSseResponse = async (resp: Response, expectedId: number | string | undefined): Promise<McpJsonRpcResponse> => {
    const reader = resp.body?.getReader();
    if (!reader) return parseResp(await resp.text(), 'text/event-stream');
    const decoder = new TextDecoder();
    let buffer = '';
    const parseEvent = (event: string): McpJsonRpcResponse | null => {
        const data = event.split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n');
        if (!data || data === '[DONE]') return null;
        try {
            const parsed = JSON.parse(data) as McpJsonRpcResponse;
            return expectedId == null || parsed.id === expectedId ? parsed : null;
        } catch { return null; }
    };
    try {
        while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value, { stream: !done });
            const events = buffer.split(/\r?\n\r?\n/);
            buffer = events.pop() || '';
            for (const event of events) {
                const parsed = parseEvent(event);
                if (parsed) return parsed;
            }
            if (done) {
                const parsed = parseEvent(buffer);
                if (parsed) return parsed;
                throw new Error('MCP SSE 流结束，但没有收到本次请求的响应');
            }
        }
    } finally {
        await reader.cancel().catch(() => { /* 已结束或已 abort */ });
    }
};

const postCore = async (
    target: McpTransportTarget,
    session: McpSessionState,
    body: McpJsonRpcRequest,
    timeoutMs: number,
    expectResponse = true,
): Promise<{ response: McpJsonRpcResponse | null }> => {
    target.signal?.throwIfAborted();
    const headers = target.headers(session.sessionId, session.protocolVersion);

    let resp: Response;
    const controller = new AbortController();
    const abort = () => controller.abort(target.signal?.reason);
    target.signal?.addEventListener('abort', abort, { once: true });
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        try {
            resp = await fetch(target.url, {
                method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
            });
        } catch (e: any) {
            target.signal?.throwIfAborted();
            if (controller.signal.aborted) {
                throw new Error(`MCP 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
            }
            const hint = target.fetchErrorHint || '';
            throw new Error(`MCP 请求失败: ${e?.message || e}。${hint}`);
        }

        // fetch 拿到响应头不代表 SSE 响应体已经结束；DeepWiki / 代理若一直不关流，
        // resp.text() 同样必须受同一个超时控制。
        const readText = async (): Promise<string> => {
            try { return await resp.text(); }
            catch (e) {
            target.signal?.throwIfAborted();
            if (controller.signal.aborted) {
                    throw new Error(`MCP 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
                }
                throw e;
            }
        };

        const newSid = resp.headers.get('Mcp-Session-Id') || resp.headers.get('mcp-session-id');
        if (newSid) session.sessionId = newSid;

        if (resp.status === 401 || resp.status === 403) {
            const txt = await readText().catch(() => '');
            throw new Error(`MCP 鉴权失败 (${resp.status}): Token 可能无效或过期。${txt.slice(0, 120)}`);
        }
        if (resp.status === 202) return { response: null };
        if (!resp.ok) {
            const txt = await readText().catch(() => '');
            throw new Error(`MCP HTTP ${resp.status}: ${txt.slice(0, 200)}`);
        }
        if (!expectResponse) return { response: null };

        const ct = resp.headers.get('content-type') || '';
        try {
            if (ct.includes('text/event-stream')) {
                return { response: await readSseResponse(resp, body.id) };
            }
            const text = await readText();
            return { response: parseResp(text, ct) };
        } catch (e) {
            target.signal?.throwIfAborted();
            if (controller.signal.aborted) {
                throw new Error(`MCP 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
            }
            throw e;
        }
    } finally {
        clearTimeout(timeoutId);
        target.signal?.removeEventListener('abort', abort);
    }
};

const formatMcpRpcError = (err: { code?: number; message?: string; data?: any }): string => {
    const code = err?.code !== undefined ? `[${err.code}]: ` : '';
    const message = err?.message || '未知错误';
    let dataText = '';
    if (err?.data !== undefined && err?.data !== null && err?.data !== '') {
        if (typeof err.data === 'string') {
            dataText = err.data.trim();
        } else {
            try { dataText = JSON.stringify(err.data); } catch { dataText = String(err.data); }
        }
    }
    const suffix = dataText && !message.includes(dataText) ? `（${dataText}）` : '';
    return `${code}${message}${suffix}`;
};

const initializeCore = async (
    target: McpTransportTarget,
    session: McpSessionState,
    timeoutMs: number,
): Promise<void> => {
    const initReq = buildRpcRequest(session, 'initialize', {
        protocolVersion: MCP_LATEST_HANDSHAKE_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'sullyos', title: 'SullyOS', version: '1.0.0' },
    });
    const { response } = await postCore(target, session, initReq, timeoutMs);
    if (response?.error) throw new Error(`Initialize 失败 ${formatMcpRpcError(response.error)}`);

    const negotiated = String(
        response?.result?.protocolVersion || MCP_LATEST_HANDSHAKE_PROTOCOL_VERSION,
    );
    if (!(MCP_SUPPORTED_HANDSHAKE_PROTOCOL_VERSIONS as readonly string[]).includes(negotiated)) {
        throw new Error(
            `MCP 协议版本不兼容：服务器选择了 ${negotiated}。` +
            `SullyOS 的 Streamable HTTP 接线支持 ${MCP_SUPPORTED_HANDSHAKE_PROTOCOL_VERSIONS.join(' / ')}；` +
            `2024-11-05 属于旧 HTTP+SSE 双端点，2026-07-28 则需要新的无握手生命周期。`,
        );
    }
    session.protocolVersion = negotiated;
    session.serverInfo = response?.result?.serverInfo || null;
    session.serverCapabilities = response?.result?.capabilities || null;

    // 直连模式下读不到 Session-Id 说明 CORS 没暴露响应头（服务器可能有会话但我们拿不到），
    // Streamable HTTP 无状态服务器也可能压根不发。这里不硬报错：tools/list 能通就算能用。
    const notif = buildRpcRequest(session, 'notifications/initialized', {}, true);
    await postCore(target, session, notif, timeoutMs, false).catch(() => { /* notification 失败不阻塞 */ });

    session.initialized = true;
};

const ensureInitializedCore = async (
    target: McpTransportTarget,
    session: McpSessionState,
    timeoutMs: number,
): Promise<void> => {
    if (session.initialized) return;
    if (!session.initPromise) {
        session.initPromise = initializeCore(target, session, timeoutMs).catch((e) => {
            session.initPromise = null;
            throw e;
        });
    }
    await session.initPromise;
};

/**
 * 握手 + tools/list，返回的工具清单由调用方负责持久化。
 * 浏览器的「发现工具」按钮走这里；worker 不需要——工具清单随 tool_config 上云。
 */
export const discoverMcpToolsCore = async (
    target: McpTransportTarget,
    session: McpSessionState,
    timeoutMs: number,
    opts: { onStage?: (stage: 'initialize' | 'tools') => void } = {},
): Promise<McpFireToolDef[]> => {
    opts.onStage?.('initialize');
    await ensureInitializedCore(target, session, timeoutMs);
    opts.onStage?.('tools');
    const { response } = await postCore(target, session, buildRpcRequest(session, 'tools/list'), timeoutMs);
    if (response?.error) throw new Error(`tools/list 失败 ${formatMcpRpcError(response.error)}`);
    const tools = response?.result?.tools;
    if (!Array.isArray(tools)) return [];
    return tools.map((t: any) => ({
        name: t.name,
        title: t.title || t.annotations?.title || '',
        description: t.description || '',
        inputSchema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
        outputSchema: t.outputSchema || t.output_schema,
        annotations: t.annotations,
    }));
};

const isRecord = (value: unknown): value is Record<string, any> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

const resolveLocalSchemaRef = (schema: any, rootSchema: any): any => {
    const ref = typeof schema?.$ref === 'string' ? schema.$ref : '';
    if (!ref.startsWith('#/')) return schema;
    const resolved = ref.slice(2).split('/').reduce((current: any, part: string) => {
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
        return current?.[key];
    }, rootSchema);
    return resolved || schema;
};

const schemaAccepts = (schema: any, kind: 'object' | 'array'): boolean => {
    const types = Array.isArray(schema?.type) ? schema.type : [schema?.type];
    if (types.includes(kind)) return true;
    if (kind === 'object' && schema?.properties) return true;
    if (kind === 'array' && schema?.items) return true;
    return [...(schema?.oneOf || []), ...(schema?.anyOf || [])].some((item: any) => schemaAccepts(item, kind));
};

/**
 * 部分 OpenAI 兼容中转会把 schema 中的 object / array 再编码成 JSON 字符串。
 * 只在 schema 明确要求结构类型时还原，避免把 URL、文本等合法 string 误解析。
 */
const normalizeMcpValueBySchema = (value: any, rawSchema: any, rootSchema: any, depth: number): any => {
    if (!rawSchema || depth > 20) return value;
    const schema = resolveLocalSchemaRef(rawSchema, rootSchema);
    const acceptsObject = schemaAccepts(schema, 'object');
    const acceptsArray = schemaAccepts(schema, 'array');
    let normalized = value;

    if (typeof normalized === 'string' && (acceptsObject || acceptsArray)) {
        // 最多解三层，兼容整个 arguments 双重编码与嵌套字段额外编码。
        for (let i = 0; i < 3 && typeof normalized === 'string'; i++) {
            const text = normalized.trim();
            if (!text) break;
            try { normalized = JSON.parse(text); }
            catch { break; }
        }
        const decodedMatchesSchema = (acceptsObject && isRecord(normalized)) || (acceptsArray && Array.isArray(normalized));
        if (!decodedMatchesSchema) normalized = value;
    }

    const alternatives = [...(schema?.oneOf || []), ...(schema?.anyOf || [])];
    if (alternatives.length) {
        const matching = alternatives.find((item: any) =>
            (isRecord(normalized) && schemaAccepts(item, 'object'))
            || (Array.isArray(normalized) && schemaAccepts(item, 'array')),
        );
        if (matching) normalized = normalizeMcpValueBySchema(normalized, matching, rootSchema, depth + 1);
    }

    if (isRecord(normalized) && acceptsObject) {
        const result = { ...normalized };
        const properties = schema?.properties || {};
        for (const [key, childSchema] of Object.entries(properties)) {
            if (key in result) result[key] = normalizeMcpValueBySchema(result[key], childSchema, rootSchema, depth + 1);
        }
        if (schema?.additionalProperties && typeof schema.additionalProperties === 'object') {
            for (const key of Object.keys(result)) {
                if (!(key in properties)) {
                    result[key] = normalizeMcpValueBySchema(result[key], schema.additionalProperties, rootSchema, depth + 1);
                }
            }
        }
        for (const item of schema?.allOf || []) {
            const merged = normalizeMcpValueBySchema(result, item, rootSchema, depth + 1);
            if (isRecord(merged)) Object.assign(result, merged);
        }
        return result;
    }

    if (Array.isArray(normalized) && acceptsArray && schema?.items) {
        return normalized.map(item => normalizeMcpValueBySchema(item, schema.items, rootSchema, depth + 1));
    }
    return normalized;
};

export const normalizeMcpToolArguments = (args: any, inputSchema: any): any =>
    normalizeMcpValueBySchema(args, inputSchema, inputSchema, 0);

/** 日志里只留主机名：够定位是哪台服务器，又不至于把完整地址打出来。 */
const targetHost = (url: string): string => {
    try { return new URL(url).host; } catch { return ''; }
};

/**
 * 调一个工具（会自动补握手；HTTP 400/404 视为 session 失效，就地重置会话再试一次）。
 * 重置是原地改传进来的那个 session 对象，持有者手里的引用会跟着更新。
 */
export const callMcpToolCore = async (
    target: McpTransportTarget,
    session: McpSessionState,
    toolName: string,
    args: Record<string, any> = {},
    opts: {
        signal?: AbortSignal;
        timeoutMs?: number;
        inputSchema?: any;
        /** 日志里显示的服务器名，缺省用目标 URL 的主机名 */
        serverLabel?: string;
    } = {},
): Promise<McpToolResult> => {
    target = { ...target, signal: opts.signal ?? target.signal };
    target.signal?.throwIfAborted();
    const timeoutMs = opts.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
    const normalizedArgs = normalizeMcpToolArguments(args, opts.inputSchema);
    const finish = (result: McpToolResult): McpToolResult => {
        let resultPreview = '';
        if (result.success) {
            try { resultPreview = JSON.stringify(result.data).slice(0, 800); }
            catch { resultPreview = String(result.data).slice(0, 800); }
        }
        // 不记录 URL / Token，只证明真实 tools/call 的目标、参数与服务端返回。
        console.info('🔌 [MCP] tools/call 完成', {
            server: opts.serverLabel ?? targetHost(target.url),
            tool: toolName,
            args: normalizedArgs,
            success: result.success,
            ...(result.success ? { result: resultPreview } : { error: result.error }),
        });
        return result;
    };
    try {
        await ensureInitializedCore(target, session, timeoutMs);
        const body = buildRpcRequest(session, 'tools/call', { name: toolName, arguments: normalizedArgs });
        let response: McpJsonRpcResponse | null;
        try {
            ({ response } = await postCore(target, session, body, timeoutMs));
        } catch (e: any) {
            // 404/400 常见于服务器重启后 session 失效，重握手再试一次
            if (/HTTP (400|404)/.test(e?.message || '')) {
                Object.assign(session, createMcpSessionState());
                await ensureInitializedCore(target, session, timeoutMs);
                ({ response } = await postCore(
                    target, session,
                    buildRpcRequest(session, 'tools/call', { name: toolName, arguments: normalizedArgs }),
                    timeoutMs,
                ));
            } else {
                throw e;
            }
        }
        if (!response) return finish({ success: false, error: '空响应' });
        if (response.error) return finish({ success: false, error: `MCP 错误 ${formatMcpRpcError(response.error)}` });

        const result = response.result;
        if (result?.resultType === 'input_required') {
            return finish({
                success: false,
                error: '这个工具需要在执行途中补充确认或输入；SullyOS 当前不会替你自动回答，请回到聊天中明确要求后重试。',
                data: result,
            });
        }
        if (result?.content && Array.isArray(result.content)) {
            const textParts = result.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text || '');
            const fullText = textParts.join('\n').trim();
            if (result.isError) return finish({ success: false, error: fullText || 'MCP 工具执行失败', rawText: fullText });
            try {
                return finish({ success: true, data: JSON.parse(fullText), rawText: fullText });
            } catch {
                return finish({ success: true, data: fullText, rawText: fullText });
            }
        }
        return finish({ success: true, data: result });
    } catch (e: any) {
        target.signal?.throwIfAborted();
        return finish({ success: false, error: e?.message || String(e) });
    }
};

/** worker 直连的请求头（浏览器侧那套代理头逻辑留在 mcpClient.buildMcpRequestHeaders）。 */
export const buildMcpDirectHeaders = (
    server: McpFireServer,
    sessionId: string | null,
    protocolVersion: string | null = null,
): Record<string, string> => {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    };
    for (const item of server.customHeaders || []) {
        const name = String(item?.name || '').trim();
        const value = String(item?.value || '').trim();
        if (name && value) headers[name] = value;
    }
    if (server.token) headers['Authorization'] = `Bearer ${server.token}`;
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
    return headers;
};

// ========== 后台 fire 专用 ==========
//
// amsg2 的 worker 到点自己调 LLM，这一段就是那时候要用的三块料：
// 挑出这个角色能看见的服务器 → 拼 tools 数组 → 拼提示词块。

/**
 * fire 时按角色过滤可见服务器（charIds 语义与 getEnabledMcpServers 一致）。
 * 只管 url / tools / charIds 三项：服务器有没有启用由上云侧的
 * collectMcpFireServers 把关，传到这里的清单已经只剩启用的。
 */
export const filterMcpServersForChar = <S extends McpFireServer>(
    servers: S[] | undefined,
    charId: string,
): S[] =>
    (servers || []).filter((s) =>
        !!s.url && (s.tools?.length || 0) > 0 &&
        (!s.charIds?.length || s.charIds.includes(charId)),
    );

export interface McpFireOpenAITool {
    type: 'function';
    function: { name: string; description: string; parameters: any };
}

/**
 * fire 请求的 tools 数组（native 模式）。暴露名直接带 MCP_FIRE_NAME_PREFIX——模型按
 * 这个名字调回来，executeToolCalls 零歧义分流，不会撞内置工具（recall/search/…）的名字。
 * resolve 必须是用 { maxNameLen: MCP_FIRE_NAME_BUDGET } 建的（预算 + 前缀正好是
 * OpenAI 工具名的 64 上限）。
 */
export const buildMcpFireTools = <S extends McpFireServer>(
    resolve: Map<string, McpResolvedToolCore<S>>,
): McpFireOpenAITool[] => {
    // 只有跨服务器时才标来源（同一台服务器的多个工具之间不需要区分来源），
    // 与前台 buildMcpOpenAITools 的 servers.length > 1 同判据。按 server.id 去重
    // ——全仓服务器身份以 id 为准（会话 Map / resetMcpSession 同源）。
    const multiServer = new Set([...resolve.values()].map(({ server }) => server.id)).size > 1;
    const tools: McpFireOpenAITool[] = [];
    for (const [exposed, { server, tool }] of resolve) {
        const desc = (tool.description || '').trim();
        tools.push({
            type: 'function',
            function: {
                name: `${MCP_FIRE_NAME_PREFIX}${exposed}`,
                description: multiServer ? `[${server.name}] ${desc}`.trim() : desc,
                parameters: tool.inputSchema || { type: 'object', properties: {} },
            },
        });
    }
    return tools;
};

/**
 * 后台 fire 的 MCP 工具说明块（worker 到点拼进 user prompt 尾部）。
 *
 * native 模式（默认）：tools 参数已随请求声明，这里只列来源和纪律——与前台
 * buildMcpSystemBlock 的口径一致，不教正文语法（教了反而勾引模型往正文里写）。
 * text 模式（用户在设置里关掉「原生 tools」开关 = 中转拒 tools 时）：请求不带
 * tools 参数，这里教正文协议 tool_name({...})，签名格式与前台
 * buildMcpRejectedToolsFallbackBody 对齐——同一个模型两端见到的长一个样。
 */
export const buildMcpFireBlock = <S extends McpFireServer>(
    resolve: Map<string, McpResolvedToolCore<S>>,
    opts: { mode: 'native' | 'text'; userName?: string },
): string => {
    if (!resolve.size) return '';
    const userName = opts.userName || '用户';
    // 来源标注的判据同 buildMcpFireTools：只有跨服务器时才标（各算各的，不共享状态）
    const multiServer = new Set([...resolve.values()].map(({ server }) => server.id)).size > 1;
    const lines: string[] = [];
    for (const [exposed, { server, tool }] of resolve) {
        const desc = (tool.description || '').trim();
        if (opts.mode === 'native') {
            lines.push(`- ${exposed}${desc ? `：${desc}` : ''}${multiServer ? `（来源: ${server.name}）` : ''}`);
            continue;
        }
        const schema = tool.inputSchema || {};
        const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
        const args = Object.entries(schema.properties || {}).map(([name, d]: [string, any]) =>
            `${name}${required.has(name) ? '*' : ''}:${d?.type || 'any'}`);
        lines.push(`- ${exposed}(${args.join(', ')})${desc ? `：${desc}` : ''}${multiServer ? `（来源: ${server.name}）` : ''}`);
    }
    const howTo = opts.mode === 'native'
        ? '需要时直接通过系统的工具调用接口发起（系统会自动执行并把结果给你），不要把工具名和参数写进正文。'
        : '需要工具时，单独输出一行 tool_name({"参数":"值"})，系统会代为执行并把结果给你，然后你继续写。* 表示必填参数。';
    return [
        '',
        '---',
        `【外部工具 —— ${userName} 在设置里给你连了 MCP 工具服务器，主动消息里也可以用】`,
        howTo,
        '纪律：不需要就别硬调；没收到系统返回前不要声称工具成功，也不要编造结果；工具失败就换个方式或如实带过；结果只挑相关部分用角色语气转述，别复读 JSON。',
        '多步任务：先做必要检查，随后立刻调用能推进目标的动作工具；不要反复读取同一份说明或状态。执行动作后可以再次检查新状态，并继续到目标完成或工具明确失败。',
        `副作用操作：${userName} 本轮已经明确要求执行的视为已确认；没有明确要求时才先确认。`,
        '可用工具：',
        ...lines,
        '---',
    ].join('\n');
};
