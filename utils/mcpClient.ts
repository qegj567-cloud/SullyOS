/**
 * 通用 MCP 客户端 (Model Context Protocol, Streamable HTTP)
 *
 * 与 mcdMcpClient / luckinMcpClient 的「一家一个客户端」不同，这里是用户
 * 自配的任意远程 MCP 服务器：设置里填 URL（+ 可选 Bearer Token / 自定义头），发现工具后
 * 以 OpenAI function-calling 格式注入聊天请求，工具循环见 useChatAI。
 *
 * 网络路径（用户三选一，见 docs/mcp-client.md）：
 * 1. 直连 —— MCP 服务器 CORS 配置正确时（能读到 Mcp-Session-Id 响应头）
 * 2. 本地代理 —— node scripts/mcp-proxy.mjs，代理 URL 填 http://localhost:18061
 * 3. 用户自己的 Cloudflare Worker —— worker/mcp-proxy/，部署到用户自己的账号
 * 代理约定统一为 <代理URL>?target=<url-encoded 服务器URL>，可选 X-Proxy-Key 头。
 * 刻意不走中心 sfworker：MCP 流量（含用户的 Bearer Token）不该过项目方的服务器。
 *
 * JSON-RPC 收发本体（握手、SSE、tools/call、参数还原）住在环境无关叶子
 * mcpFireCore，浏览器和 amsg worker 共用；这里只补浏览器侧的配置、代理包装和会话表。
 */

import {
    callMcpToolCore,
    createMcpSessionState,
    discoverMcpToolsCore,
    normalizeMcpToolArguments,
    MCP_REQUEST_TIMEOUT_MS,
    type McpFireServer,
    type McpSessionState,
    type McpToolResult,
    type McpTransportTarget,
} from './mcpFireCore';
import { isWorkerReachableUrl } from './amsgToolPack';

export { MCP_REQUEST_TIMEOUT_MS, normalizeMcpToolArguments };
export type { McpToolResult };

export interface McpToolDef {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: any;
    outputSchema?: any;
    annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
}

export interface McpCustomHeader {
    name: string;
    value: string;
}

export interface McpServerConfig {
    id: string;
    name: string;
    url: string;
    /** Bearer Token，可选（Authorization: Bearer <token>） */
    token?: string;
    /** 额外请求头，可选（例如 X-API-Key / XBY-APIKEY） */
    customHeaders?: McpCustomHeader[];
    /** 代理 URL，可选。空 = 浏览器直连 */
    proxyUrl?: string;
    /** 自部署 Worker 的防白嫖密钥，可选（X-Proxy-Key 头） */
    proxyKey?: string;
    enabled: boolean;
    /** 「发现工具」后持久化的工具清单（聊天注入直接读这里，不用每次握手） */
    tools?: McpToolDef[];
    /** 最近一次真实握手的诊断快照；连接字段变化时会清掉，避免展示假绿灯。 */
    lastConnection?: {
        testedAt: number;
        protocolVersion: string;
        serverName?: string;
        serverVersion?: string;
    };
    /**
     * 绑定聊天：空/缺省 = 通用（所有私聊和群聊可用）；非空 = 只有这些角色/群聊能用。
     * 为兼容已有本地配置沿用 charIds 字段名，数组项也可以是 GroupProfile.id。
     * 老配置没有该字段，天然落在通用语义上。
     */
    charIds?: string[];
    updatedAt: number;
}

const MCP_SERVERS_KEY = 'aetheros.mcp.servers';
const MCP_USE_NATIVE_TOOLS_KEY = 'aetheros.mcp.useNativeTools';
const MCP_ALLOW_CLOUD_DESTRUCTIVE_KEY = 'aetheros.mcp.allowCloudDestructive';

// ========== 服务器配置 (持久化在 localStorage) ==========

export const loadMcpServers = (): McpServerConfig[] => {
    try {
        const raw = localStorage.getItem(MCP_SERVERS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
};

export const saveMcpServers = (servers: McpServerConfig[]): void => {
    try { localStorage.setItem(MCP_SERVERS_KEY, JSON.stringify(servers)); } catch { /* ignore */ }
};

/** 当前聊天模型/中转是否支持 OpenAI function calling；默认支持。 */
export const getMcpUseNativeTools = (): boolean => {
    try { return localStorage.getItem(MCP_USE_NATIVE_TOOLS_KEY) !== '0'; }
    catch { return true; }
};

export const setMcpUseNativeTools = (enabled: boolean): void => {
    try { localStorage.setItem(MCP_USE_NATIVE_TOOLS_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
};

/**
 * 是否允许云端（主动消息 2.0 的 Worker）执行服务端标了 destructiveHint 的工具。默认关：
 * 本地调这类工具前会弹窗确认，云端没有这一步，所以要用户自己明确打开。
 */
export const getMcpAllowCloudDestructive = (): boolean => {
    try { return localStorage.getItem(MCP_ALLOW_CLOUD_DESTRUCTIVE_KEY) === '1'; }
    catch { return false; }
};

export const setMcpAllowCloudDestructive = (enabled: boolean): void => {
    try { localStorage.setItem(MCP_ALLOW_CLOUD_DESTRUCTIVE_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
};

export const createMcpServer = (name: string, url: string): McpServerConfig => ({
    id: `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    url,
    enabled: false,
    updatedAt: Date.now(),
});

/**
 * 启用且已发现工具、且对当前聊天可见的服务器。
 * charId 可传角色 ID 或群聊 ID；缺省时只返回通用服务器，保证没有聊天上下文
 * 的调用点不会泄漏绑定服务器的工具。
 */
export const getEnabledMcpServers = (charId?: string): McpServerConfig[] =>
    loadMcpServers().filter(s =>
        s.enabled && s.url && (s.tools?.length || 0) > 0 &&
        (!s.charIds?.length || (charId != null && s.charIds.includes(charId))),
    );

/** 有任何一个启用且已发现工具、对该角色可见的服务器 → 聊天进入 MCP 工具模式 */
export const isMcpChatAvailable = (charId?: string): boolean => getEnabledMcpServers(charId).length > 0;

// CF worker 够不够得着的判断搬去了 utils/amsgToolPack.ts —— 小红书配置那边要用同一份。

/**
 * 这个聊天里有没有「本地用得上、但 worker 够不着」的服务器（localhost / 私网 / *.local
 * 这类，判据见 amsgToolPack.isWorkerReachableUrl）。
 *
 * 谁在乎：即时对话那一轮的 prompt 是交给 worker 补 MCP 说明的，前端这份整段不注入
 * （chatRequestPayload 的 timelyByWorker 分支）；而上云的清单 collectMcpFireServers
 * 恰好把这类地址过滤掉了。两边都不说 = 角色这一轮彻底不知道自己有工具，设置页却还
 * 显示「已连接」。所以有这种服务器时那一轮别上云，留在本地跑（本地连得上 localhost，
 * 工具照常用），见 useChatAI 的 instantChatVeto。
 *
 * 口径跟 isMcpChatAvailable 同源（都走 getEnabledMcpServers）：本地这一轮真会写进
 * prompt 的是哪几台，就拿哪几台来判，别把别的角色绑定的服务器算进来。
 */
export const hasWorkerUnreachableMcpServer = (charId?: string): boolean =>
    getEnabledMcpServers(charId).some((s) => !isWorkerReachableUrl(s.url));

/**
 * 上云给 amsg worker 用的服务器子集。注意不走 getEnabledMcpServers：
 * 那个函数缺 charId 时只回通用服务器，而这里要的是全部 enabled（含绑定角色的），
 * charIds 原样带上、由 worker 在 fire 时按角色过滤。
 *
 * 带上 token/customHeaders：走的是 client_state 端到端加密通道、落在用户自己的
 * amsg worker（不是项目方服务器，与文件头「不走中心 sfworker」的原则不冲突），
 * 与 notion/飞书凭据同一信任模型。
 */
export const collectMcpFireServers = (): McpFireServer[] => {
    // 云端执行前没法弹窗确认：服务端标成 destructive 的工具默认只留在前台（调用前询问），
    // 用户打开「允许云端执行破坏性工具」后才上云，即时对话和定时 / 后台任务都不再确认。
    const allowDestructive = getMcpAllowCloudDestructive();
    return loadMcpServers()
        .filter((s) => s.enabled && s.url && (s.tools?.length || 0) > 0 && isWorkerReachableUrl(s.url))
        .map((s) => {
            const backgroundTools = allowDestructive
                ? (s.tools || [])
                : (s.tools || []).filter((t) => t.annotations?.destructiveHint !== true);
            return {
                id: s.id, name: s.name, url: s.url,
                ...(s.token ? { token: s.token } : {}),
                ...(s.customHeaders?.length ? { customHeaders: s.customHeaders } : {}),
                ...(s.charIds?.length ? { charIds: s.charIds } : {}),
                tools: backgroundTools.map((t) => ({
                    name: t.name,
                    title: t.title,
                    description: t.description,
                    inputSchema: t.inputSchema,
                    outputSchema: t.outputSchema,
                    annotations: t.annotations,
                })),
            };
        })
        .filter((s) => s.tools.length > 0);
};

// ── 备份用：随「设置 → 导出/导入备份」一起带走（存 localStorage） ──
export function exportMcpLocal(): Record<string, string> | undefined {
    try {
        const out: Record<string, string> = {};
        const servers = localStorage.getItem(MCP_SERVERS_KEY);
        const useNativeTools = localStorage.getItem(MCP_USE_NATIVE_TOOLS_KEY);
        const allowCloudDestructive = localStorage.getItem(MCP_ALLOW_CLOUD_DESTRUCTIVE_KEY);
        if (servers) out[MCP_SERVERS_KEY] = servers;
        if (useNativeTools) out[MCP_USE_NATIVE_TOOLS_KEY] = useNativeTools;
        if (allowCloudDestructive) out[MCP_ALLOW_CLOUD_DESTRUCTIVE_KEY] = allowCloudDestructive;
        return Object.keys(out).length ? out : undefined;
    } catch { return undefined; }
}
export function importMcpLocal(data: Record<string, string> | null | undefined): void {
    if (!data || typeof data !== 'object') return;
    try {
        if (typeof data[MCP_SERVERS_KEY] === 'string') localStorage.setItem(MCP_SERVERS_KEY, data[MCP_SERVERS_KEY]);
        if (typeof data[MCP_USE_NATIVE_TOOLS_KEY] === 'string') localStorage.setItem(MCP_USE_NATIVE_TOOLS_KEY, data[MCP_USE_NATIVE_TOOLS_KEY]);
        if (typeof data[MCP_ALLOW_CLOUD_DESTRUCTIVE_KEY] === 'string') localStorage.setItem(MCP_ALLOW_CLOUD_DESTRUCTIVE_KEY, data[MCP_ALLOW_CLOUD_DESTRUCTIVE_KEY]);
    } catch { /* ignore */ }
}

// ========== JSON-RPC 会话状态 (内存, 每服务器一份) ==========

const sessions = new Map<string, McpSessionState>();

const getSession = (serverId: string): McpSessionState => {
    let s = sessions.get(serverId);
    if (!s) {
        s = createMcpSessionState();
        sessions.set(serverId, s);
    }
    return s;
};

export const resetMcpSession = (serverId: string): void => {
    sessions.delete(serverId);
};

/** 实际请求地址：配了代理就包成 <proxy>?target=<url>，没配就直连 */
export const buildMcpFetchUrl = (server: Pick<McpServerConfig, 'url' | 'proxyUrl'>): string => {
    const proxy = (server.proxyUrl || '').trim().replace(/\/+$/, '');
    if (!proxy) return server.url;
    const sep = proxy.includes('?') ? '&' : '?';
    return `${proxy}${sep}target=${encodeURIComponent(server.url)}`;
};

/**
 * 组装 MCP 请求头。自定义头在 Bearer / session 等托管字段之前写入，因此用户
 * 可以在不填 Bearer Token 时自定义 Authorization，但不会意外覆盖当前 session。
 * 走代理时额外带一份“需要透传的头名”清单，代理据此只放行用户明确配置的头。
 */
export const buildMcpRequestHeaders = (
    server: Pick<McpServerConfig, 'token' | 'customHeaders' | 'proxyUrl' | 'proxyKey'>,
    sessionId?: string | null,
    protocolVersion?: string | null,
): Headers => {
    const headers = new Headers({
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    });
    const customNames: string[] = [];
    for (const item of server.customHeaders || []) {
        const name = String(item?.name || '').trim();
        const value = String(item?.value || '').trim();
        if (!name || !value) continue;
        try {
            headers.set(name, value);
            customNames.push(name);
        } catch {
            // 非法 HTTP 头名/值留给设置页继续编辑，不让整条 MCP 请求在 fetch 前崩掉。
        }
    }
    if (server.token) headers.set('Authorization', `Bearer ${server.token}`);
    if (server.proxyUrl && server.proxyKey) headers.set('X-Proxy-Key', server.proxyKey);
    if (server.proxyUrl && customNames.length) headers.set('X-MCP-Forward-Headers', customNames.join(','));
    if (sessionId) headers.set('Mcp-Session-Id', sessionId);
    if (protocolVersion) headers.set('MCP-Protocol-Version', protocolVersion);
    return headers;
};

/** 一次请求的目标：代理包装和请求头都是浏览器侧独有的，在这里落地后交给 core。 */
const targetFor = (server: McpServerConfig): McpTransportTarget => ({
    url: buildMcpFetchUrl(server),
    headers: (sessionId, protocolVersion) => buildMcpRequestHeaders(server, sessionId, protocolVersion),
    // 直连时 fetch 抛 TypeError 十有八九是 CORS，把排查方向直接告诉用户
    fetchErrorHint: server.proxyUrl
        ? '请检查代理 URL 是否可访问、代理密钥是否正确。'
        : '很可能是浏览器 CORS 限制。请在这个服务器的「代理 URL」里配置代理（本地 node scripts/mcp-proxy.mjs 或自部署 worker/mcp-proxy）。',
});

// ========== 公开 API ==========

/** 握手 + tools/list。调用方负责把返回的工具清单存回 McpServerConfig.tools */
export type McpConnectionStage = 'initialize' | 'tools';

export const discoverMcpTools = async (
    server: McpServerConfig,
    onStage?: (stage: McpConnectionStage) => void,
): Promise<McpToolDef[]> => {
    resetMcpSession(server.id);
    return discoverMcpToolsCore(targetFor(server), getSession(server.id), MCP_REQUEST_TIMEOUT_MS, { onStage });
};

/**
 * 调用一个工具（会自动补握手；session 失效自动重试一次）。
 * 重试前的会话重置是 core 就地做的，改的就是这张表里的那个对象，两边不会走岔。
 */
export const callMcpTool = async (
    server: McpServerConfig,
    toolName: string,
    args: Record<string, any> = {},
    signal?: AbortSignal,
): Promise<McpToolResult> => {
    const tool = (server.tools || []).find(item => item.name === toolName);
    const needsApproval = tool?.annotations?.destructiveHint === true;
    if (needsApproval && typeof window !== 'undefined') {
        let argsPreview = '';
        try { argsPreview = JSON.stringify(args, null, 2).slice(0, 600); }
        catch { argsPreview = String(args).slice(0, 600); }
        const approved = window.confirm(
            `Sully 想通过「${server.name || '未命名服务器'}」调用 ${tool?.title || toolName}。\n\n` +
            `${argsPreview || '这次调用没有参数。'}\n\n允许这一次吗？`,
        );
        if (!approved) return { success: false, error: '用户拒绝了这次 MCP 调用。' };
    }
    return callMcpToolCore(targetFor(server), getSession(server.id), toolName, args, {
        signal,
        inputSchema: (server.tools || []).find(tool => tool.name === toolName)?.inputSchema,
        serverLabel: server.name,
    });
};

/** 测试连接: 验证握手 + tools/list 能通，返回工具清单供持久化 */
export const testMcpConnection = async (
    server: McpServerConfig,
    onStage?: (stage: McpConnectionStage) => void,
): Promise<{
    ok: boolean;
    message: string;
    tools?: McpToolDef[];
    connection?: NonNullable<McpServerConfig['lastConnection']>;
}> => {
    try {
        const tools = await discoverMcpTools(server, onStage);
        const session = getSession(server.id);
        const info = session.serverInfo;
        const connection: NonNullable<McpServerConfig['lastConnection']> = {
            testedAt: Date.now(),
            protocolVersion: session.protocolVersion || '未知',
            ...(info?.title || info?.name ? { serverName: info.title || info.name } : {}),
            ...(info?.version ? { serverVersion: info.version } : {}),
        };
        const serverLabel = connection.serverName
            ? `${connection.serverName}${connection.serverVersion ? ` ${connection.serverVersion}` : ''}`
            : '服务器';
        if (!tools.length) return {
            ok: true,
            message: `${serverLabel}已响应 · 协议 ${connection.protocolVersion} · 工具清单为空`,
            tools,
            connection,
        };
        return {
            ok: true,
            message: `${serverLabel}已响应 · 协议 ${connection.protocolVersion} · 发现 ${tools.length} 个工具`,
            tools,
            connection,
        };
    } catch (e: any) {
        return { ok: false, message: e?.message || String(e) };
    }
};
