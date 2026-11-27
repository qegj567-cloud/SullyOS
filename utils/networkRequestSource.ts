/**
 * 系统调试终端（StatusBar → SYSTEM ERROR）的请求来源识别、URL 脱敏与导出封装。
 *
 * 设计要点：
 * 1. 按「协议特征 + 路径约定 + 已配置端点比对」识别请求所属的具体业务子系统（对话模型、
 *    记忆宫殿 Embedding/Rerank/Supabase、主动消息 2.0 直连或大陆中转、主代理 Worker 各支线、
 *    语音 TTS/STT、云备份、MCP 工具、彼方、装扮服务、本机静态资源等），并附带影响范围说明，
 *    避免旁路请求报错被误认为主对话或推送通道故障。
 * 2. 区分「显式归属（`__sullyMeta`）」与「前台界面快照（`ambientMeta`）」：
 *    后台管线（记忆整理、情绪副评估、主动消息状态同步）未传显式 meta 时，只标注请求发起时刻
 *    停留在哪个前台界面，不混作该界面的主动调用。
 * 3. 脱敏前置：系统调试终端支持一键复制 JSON 排障，主动消息 2.0 大陆中转路径里的个人令牌
 *    （`/t/<令牌>/<worker域名>/...`）、URL 查询串里的密钥参数、嵌套代理参数（`?url=`、`?target=`）
 *    及 `user:pass@` 口令在入库前统一替换为 `<redacted>`，保留上游域名和接口路径供定位问题。
 */

import type { SystemLog } from '../types';
import type { ApiCallMeta } from './apiCallLog';
import { APP_VERSION } from './appVersion';
import { isAnthropicEndpoint } from './llmEndpoint';
import { DEFAULT_PROXY_WORKER, getProxyWorkerUrl, isLegacyProxyWorkerUrl } from './proxyWorker';

export type NetworkRequestVia =
    | 'direct'
    | 'proxy-worker'
    | 'amsg-relay'
    | 'mcp-proxy'
    | 'same-origin';

export interface NetworkRequestIdentity {
    /** 展示在日志卡片头部与 JSON `source` 字段的可读模块来源。 */
    source: string;
    /** 便于筛选的稳定分类代号。 */
    category:
        | 'llm'
        | 'embedding'
        | 'rerank'
        | 'vector-db'
        | 'amsg2'
        | 'music'
        | 'tts'
        | 'stt'
        | 'audio'
        | 'backup'
        | 'mcp'
        | 'weibo'
        | 'xhs'
        | 'realtime'
        | 'bifang'
        | 'beauty'
        | 'replicate'
        | 'webpage'
        | 'engine'
        | 'local-asset'
        | 'external-media'
        | 'other';
    /** 具体动作说明，例如 `提交即时对话 (/instant-chat)`、`PROPFIND`、`tools/call:search`。 */
    operation?: string;
    via: NetworkRequestVia;
    /** 经由代理或中转时的实际目标域名。 */
    upstreamTarget?: string;
    /** 命中的本地配置项说明（仅比对域名/前缀，不读取任何密钥）。 */
    configSource?: string;
    /** 请求体里声明的模型名（仅模型类接口提取）。 */
    model?: string;
    /** 面向用户的故障影响范围提示，防止把旁路接口报错误判成主对话或推送损坏。 */
    impactHint?: string;
}

export interface ConfiguredEndpointSnapshot {
    mainApiBaseUrl?: string;
    apiPresets?: Array<{ name?: string; baseUrl?: string }>;
    checkPhoneApiBaseUrl?: string;
    embeddingBaseUrl?: string;
    lightLlmBaseUrl?: string;
    rerankBaseUrl?: string;
    supabaseUrl?: string;
    webdavUrl?: string;
    proxyWorkerUrl?: string;
    musicWorkerUrl?: string;
    postOfficeBaseUrl?: string;
    amsgWorkerUrl?: string;
    mcpServers?: Array<{ name?: string; url?: string; proxyUrl?: string }>;
}

export interface IdentifyNetworkRequestInput {
    url: string;
    method?: string;
    headers?: HeadersInit;
    body?: unknown;
    /** 调用点显式传入的归属信息（`__sullyMeta`），可信度高。 */
    explicitMeta?: ApiCallMeta;
    /** 发起时刻的前台界面快照，仅在缺少显式归属时作旁证展示。 */
    ambientMeta?: ApiCallMeta;
    pageOrigin?: string;
    endpoints?: ConfiguredEndpointSnapshot;
}

const SENSITIVE_QUERY_KEY_RE = /^(?:(?:[a-z0-9]+[-_])*(?:api[-_]?key|apikey|key|token|auth|authorization|secret|password|passwd|sig|signature|ticket|cookie|session)|(?:access|refresh|app|id|xsec)token|clientsecret|devicekey|app[-_]?id|appid|ak|sk|spt|lat|lon|lng|latitude|longitude)$/i;
const EMBEDDED_URL_QUERY_KEY_RE = /^(?:url|target|redirect|redirect_uri)$/i;
const AMSG_RELAY_PATH_RE = /^\/t\/([^/]+)(?:\/(.*))?$/;
// 第三方推送里把设备密钥/昵称直接放在路径首段的常见官方域名。
const PATH_SECRET_PUSH_HOSTS = new Set(['api.day.app', 'api.chuckfang.com']);
const PATH_SECRET_PUSH_PUBLIC_ROUTES = new Set(['push', 'ping', 'info', 'register', 'healthz']);
// 任意日志文本、报错原文或上游回显里嵌着的中转地址与常见凭据（排除全角中文标点、反引号与反斜杠，避免吞掉中文日志或破坏 JSON 转义）。
const AMSG_RELAY_URL_IN_TEXT_RE = /(https?:\/\/amsg-relay\.friedsully\.com\/t\/)([^/\s"'<>`\\\u3000-\u303F\uFF00-\uFFEF?#]+)/gi;
const FALLBACK_QUERY_SECRET_RE = /([?&](?:api[-_]?key|apikey|key|token|access[-_]?token|xsec[-_]?token|appid|secret|password|passwd|auth|lat|lon|lng|latitude|longitude)=)([^&#\s"'<>`\\\u3000-\u303F\uFF00-\uFFEF]+)/gi;
const URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>`\\\u3000-\u303F\uFF00-\uFFEF]+/gi;
const URL_TRAILING_PUNCT_RE = /[.,;:!?)\]\}，。；：！？（）【】《》「」『』、]+$/;
const PUSH_SCHEME_SECRET_RE = /\b(bark|meow):(https?:\/\/[^\s"'<>`\\\u3000-\u303F\uFF00-\uFFEF]+)/gi;
const WXPUSHER_SCHEME_SECRET_RE = /\bwxpusher:([^\s"'<>`\\\u3000-\u303F\uFF00-\uFFEF]+)/gi;
const INLINE_BEARER_RE = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi;
const INLINE_MUSIC_U_RE = /\b(MUSIC_U=)([^;\s"'<>`\\\u3000-\u303F\uFF00-\uFFEF]+)/gi;
const INLINE_WXPUSHER_SPT_RE = /\bSPT_[A-Za-z0-9_-]{12,}\b/g;

/**
 * 抹掉任意字符串文本中嵌着的主动消息 2.0 大陆中转令牌、敏感 URL 参数、第三方推送链接与内联凭据，
 * 同时保留域名、接口路径等排障信息。
 */
export const redactRelayTokensInText = (text: string): string => {
    if (!text || typeof text !== 'string') return String(text ?? '');
    return text
        .replace(PUSH_SCHEME_SECRET_RE, (_, scheme: string, innerUrl: string) => {
            const trailing = innerUrl.match(URL_TRAILING_PUNCT_RE)?.[0] || '';
            const core = trailing ? innerUrl.slice(0, -trailing.length) : innerUrl;
            // 自建 Bark / MeoW 域名同样把设备密钥/昵称放在路径首段，按推送伪协议强制脱敏首段。
            return `${scheme}:${sanitizeUrlForLog(core, 0, { redactFirstPathSegment: true })}${trailing}`;
        })
        .replace(WXPUSHER_SCHEME_SECRET_RE, 'wxpusher:<redacted>')
        .replace(URL_IN_TEXT_RE, (matched) => {
            const trailing = matched.match(URL_TRAILING_PUNCT_RE)?.[0] || '';
            const core = trailing ? matched.slice(0, -trailing.length) : matched;
            return `${sanitizeUrlForLog(core)}${trailing}`;
        })
        .replace(INLINE_BEARER_RE, '$1<redacted>')
        .replace(INLINE_MUSIC_U_RE, '$1<redacted>')
        .replace(INLINE_WXPUSHER_SPT_RE, '<redacted>');
};

// 主动消息 2.0 Worker 存放在 IndexedDB（ActiveMsg 库），同步拦截器里不能 await 读库；
// 由运行时在已知 workerUrl 时顺手喂一份纯内存镜像，僅保留 origin/host 用于归属识别。
let runtimeAmsgWorkerUrl = '';

export const setDiagnosticAmsgWorkerUrl = (workerUrl: string | null | undefined): void => {
    runtimeAmsgWorkerUrl = typeof workerUrl === 'string' ? workerUrl.trim() : '';
};

export const getDiagnosticAmsgWorkerUrl = (): string => runtimeAmsgWorkerUrl;

const safeParseUrl = (rawUrl: string, baseOrigin?: string): URL | null => {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    try {
        const base = baseOrigin
            || (typeof location !== 'undefined' && location.href ? location.href : 'https://sullyos.local/');
        return new URL(rawUrl, base);
    } catch {
        return null;
    }
};

const normalizeBasePrefix = (value?: string | null): string => {
    if (!value || typeof value !== 'string') return '';
    const trimmed = value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(trimmed)) return '';
    try {
        const parsed = new URL(trimmed);
        return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
        return '';
    }
};

const matchesEndpointPrefix = (targetHrefLower: string, targetOriginLower: string, configuredUrl?: string | null): boolean => {
    const prefix = normalizeBasePrefix(configuredUrl);
    if (!prefix) return false;
    if (targetHrefLower === prefix || targetHrefLower.startsWith(`${prefix}/`) || targetHrefLower.startsWith(`${prefix}?`)) {
        return true;
    }
    try {
        return new URL(prefix).origin.toLowerCase() === targetOriginLower;
    } catch {
        return false;
    }
};

/**
 * 抹掉 URL 中可能出现的个人凭据，同时保留排障所需的域名、接口路径和参数名：
 * - 主动消息 2.0 大陆中转路径 `/t/<令牌>/<worker域名>/...` → `/t/<redacted>/<worker域名>/...`
 * - `https://user:pass@host/...` → 去掉账号密码
 * - 敏感查询参数（key/token/secret 等）值替换为 `<redacted>`
 * - 代理转发参数（`?url=`、`?target=`）内部嵌套的 URL 递归执行同一套脱敏
 */
export const sanitizeUrlForLog = (rawUrl: string, depth = 0, opts?: { redactFirstPathSegment?: boolean }): string => {
    if (!rawUrl || typeof rawUrl !== 'string') return String(rawUrl ?? '');
    if (/^(?:blob:|data:)/i.test(rawUrl)) {
        if (/^data:/i.test(rawUrl)) {
            const commaIdx = rawUrl.indexOf(',');
            const header = commaIdx >= 0 ? rawUrl.slice(0, Math.min(commaIdx, 80)) : rawUrl.slice(0, 80);
            return `${header},<inline-data ${rawUrl.length} chars>`;
        }
        return rawUrl;
    }

    const isRelative = !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(rawUrl);
    let parsed: URL;
    try {
        parsed = isRelative ? new URL(rawUrl, 'https://relative.invalid') : new URL(rawUrl);
    } catch {
        return rawUrl
            .replace(AMSG_RELAY_URL_IN_TEXT_RE, '$1<redacted>')
            .replace(FALLBACK_QUERY_SECRET_RE, '$1<redacted>');
    }

    const hadAuth = Boolean(parsed.username || parsed.password);
    if (hadAuth) {
        parsed.username = '';
        parsed.password = '';
    }

    let pathname = parsed.pathname;
    const hostLower = parsed.hostname.toLowerCase();
    const relayMatch = pathname.match(AMSG_RELAY_PATH_RE);
    if (relayMatch && (hostLower === 'amsg-relay.friedsully.com' || relayMatch[1].length >= 20)) {
        const rest = relayMatch[2] ? `/${relayMatch[2]}` : '';
        pathname = `/t/<redacted>${rest}`;
    } else if (PATH_SECRET_PUSH_HOSTS.has(hostLower) || opts?.redactFirstPathSegment) {
        const pushMatch = pathname.match(/^\/([^/]+)(\/.*)?$/);
        if (pushMatch && !PATH_SECRET_PUSH_PUBLIC_ROUTES.has(pushMatch[1].toLowerCase())) {
            pathname = `/<redacted>${pushMatch[2] || ''}`;
        }
    }

    let queryChanged = false;
    const sanitizedPairs: string[] = [];
    if (parsed.search) {
        const params = new URLSearchParams(parsed.search);
        for (const [k, v] of params.entries()) {
            if (SENSITIVE_QUERY_KEY_RE.test(k)) {
                sanitizedPairs.push(`${encodeURIComponent(k)}=%3Credacted%3E`);
                queryChanged = true;
            } else if (depth < 2 && EMBEDDED_URL_QUERY_KEY_RE.test(k) && /^https?:\/\//i.test(v)) {
                const innerSanitized = sanitizeUrlForLog(v, depth + 1);
                if (innerSanitized !== v) queryChanged = true;
                sanitizedPairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(innerSanitized)}`);
            } else {
                sanitizedPairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
            }
        }
    }

    // 没有任何脱敏改动时原样返回，避免无谓改写查询参数编码格式
    if (!hadAuth && pathname === parsed.pathname && !queryChanged) {
        return rawUrl;
    }

    const searchPart = parsed.search
        ? (queryChanged ? `?${sanitizedPairs.join('&')}` : parsed.search)
        : '';
    const hashPart = parsed.hash || '';
    if (isRelative) {
        return `${pathname}${searchPart}${hashPart}`;
    }
    const authPrefix = hadAuth ? '<redacted>@' : '';
    return `${parsed.protocol}//${authPrefix}${parsed.host}${pathname}${searchPart}${hashPart}`;
};

/** 从本地存储懒读各服务的地址前缀快照（只取 URL 和显示名，绝不触碰任何 key/token/cookie）。 */
export const readConfiguredEndpointsSnapshot = (): ConfiguredEndpointSnapshot => {
    const snap: ConfiguredEndpointSnapshot = {
        proxyWorkerUrl: getProxyWorkerUrl(),
        amsgWorkerUrl: runtimeAmsgWorkerUrl || undefined,
    };
    if (typeof localStorage === 'undefined') return snap;
    const readJson = (key: string): any => {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    };

    const apiCfg = readJson('os_api_config');
    if (typeof apiCfg?.baseUrl === 'string' && apiCfg.baseUrl.trim()) {
        snap.mainApiBaseUrl = apiCfg.baseUrl.trim();
    }

    const presets = readJson('os_api_presets');
    if (Array.isArray(presets)) {
        snap.apiPresets = presets
            .filter((p: any) => typeof p?.baseUrl === 'string' && p.baseUrl.trim())
            .map((p: any) => ({ name: typeof p.name === 'string' ? p.name.trim() : undefined, baseUrl: p.baseUrl.trim() }));
    }

    const checkPhoneCfg = readJson('check_phone_api');
    if (typeof checkPhoneCfg?.baseUrl === 'string' && checkPhoneCfg.baseUrl.trim()) {
        snap.checkPhoneApiBaseUrl = checkPhoneCfg.baseUrl.trim();
    }

    const palaceCfg = readJson('os_memory_palace_config');
    if (palaceCfg && typeof palaceCfg === 'object') {
        if (typeof palaceCfg.embedding?.baseUrl === 'string' && palaceCfg.embedding.baseUrl.trim()) {
            snap.embeddingBaseUrl = palaceCfg.embedding.baseUrl.trim();
        }
        if (typeof palaceCfg.lightLLM?.baseUrl === 'string' && palaceCfg.lightLLM.baseUrl.trim()) {
            snap.lightLlmBaseUrl = palaceCfg.lightLLM.baseUrl.trim();
        }
        if (typeof palaceCfg.rerank?.baseUrl === 'string' && palaceCfg.rerank.baseUrl.trim()) {
            snap.rerankBaseUrl = palaceCfg.rerank.baseUrl.trim();
        }
    }

    const vectorCfg = readJson('os_remote_vector_config');
    if (typeof vectorCfg?.supabaseUrl === 'string' && vectorCfg.supabaseUrl.trim()) {
        snap.supabaseUrl = vectorCfg.supabaseUrl.trim();
    }

    const webdavCfg = readJson('os_cloud_backup_config');
    if (typeof webdavCfg?.webdavUrl === 'string' && webdavCfg.webdavUrl.trim()) {
        snap.webdavUrl = webdavCfg.webdavUrl.trim();
    }

    const musicCfg = readJson('sully_music_cfg_v1');
    if (typeof musicCfg?.workerUrl === 'string' && musicCfg.workerUrl.trim()) {
        snap.musicWorkerUrl = musicCfg.workerUrl.trim();
    }

    try {
        const poBase = localStorage.getItem('vr_po_base');
        if (poBase && poBase.trim()) snap.postOfficeBaseUrl = poBase.trim();
    } catch { /* ignore */ }

    const mcpServers = readJson('sully_mcp_servers_v1');
    if (Array.isArray(mcpServers)) {
        snap.mcpServers = mcpServers
            .filter((s: any) => s && (typeof s.url === 'string' || typeof s.proxyUrl === 'string'))
            .map((s: any) => ({
                name: typeof s.name === 'string' ? s.name.trim() : undefined,
                url: typeof s.url === 'string' ? s.url.trim() : undefined,
                proxyUrl: typeof s.proxyUrl === 'string' ? s.proxyUrl.trim() : undefined,
            }));
    }

    return snap;
};

const getHeaderValue = (headers: HeadersInit | undefined, name: string): string => {
    if (!headers) return '';
    const lower = name.toLowerCase();
    try {
        if (typeof Headers !== 'undefined' && headers instanceof Headers) {
            return headers.get(name) || '';
        }
        if (Array.isArray(headers)) {
            const hit = headers.find(([k]) => String(k).toLowerCase() === lower);
            return hit ? String(hit[1] ?? '') : '';
        }
        if (typeof headers === 'object') {
            for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
                if (k.toLowerCase() === lower) return String(v ?? '');
            }
        }
    } catch { /* ignore */ }
    return '';
};

const hasHeader = (headers: HeadersInit | undefined, name: string): boolean => Boolean(getHeaderValue(headers, name));

interface SafeBodyHints {
    model?: string;
    jsonRpcMethod?: string;
    mcpToolName?: string;
    weiboAction?: string;
    embeddingBatchSize?: number;
}

const inspectRequestBodySafe = (body: unknown): SafeBodyHints => {
    if (typeof body !== 'string' || !body.trim().startsWith('{')) return {};
    try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const hints: SafeBodyHints = {};
        if (typeof parsed.model === 'string' && parsed.model.trim()) {
            hints.model = parsed.model.trim().slice(0, 120);
        }
        if (parsed.jsonrpc === '2.0' && typeof parsed.method === 'string') {
            hints.jsonRpcMethod = parsed.method.trim().slice(0, 80);
            if (parsed.method === 'tools/call' && typeof parsed.params?.name === 'string') {
                hints.mcpToolName = parsed.params.name.trim().slice(0, 80);
            }
        }
        if (typeof parsed.action === 'string' && /^[a-z0-9_-]{1,40}$/i.test(parsed.action)) {
            hints.weiboAction = parsed.action;
        }
        if (Array.isArray(parsed.input)) {
            hints.embeddingBatchSize = parsed.input.length;
        } else if (typeof parsed.input === 'string') {
            hints.embeddingBatchSize = 1;
        }
        return hints;
    } catch {
        return {};
    }
};

const AMSG2_ROUTE_LABELS: Record<string, string> = {
    'instant-chat': '即时对话提交 (/instant-chat)',
    'client-state': '云端状态同步 (/client-state)',
    'client-state/namespaces': '云端命名空间查询 (/client-state/namespaces)',
    'llm-credentials': '模型凭据同步 (/llm-credentials)',
    'outbox': '收件账本拉取 (/outbox)',
    'outbox/ack': '收件确认回执 (/outbox/ack)',
    'schedule-message': '排程任务创建 (/schedule-message)',
    'messages': '排程任务列表 (/messages)',
    'message': '单条任务状态查询 (/message)',
    'update-message': '排程任务更新 (/update-message)',
    'cancel-message': '排程任务取消 (/cancel-message)',
    'push-subscription': '推送订阅登记 (/push-subscription)',
    'vapid-public-key': '获取推送公钥 (/vapid-public-key)',
    'get-user-key': '获取租户密钥 (/get-user-key)',
    'init-tenant': '初始化云端租户 (/init-tenant)',
    'capabilities': '检查 Worker 能力版本 (/capabilities)',
    'config-check': '检查 Worker 配置 (/config-check)',
    'debug': 'Worker 诊断体检 (/debug)',
    'tick-report': '定时执行报告 (/tick-report)',
    'self-update': '一键更新 Worker (/self-update)',
    'self-update/check': '检查 Worker 更新状态 (/self-update/check)',
    'cron-trigger': '手动触发定时检查 (/cron-trigger)',
    'test-push': '测试推送 (/test-push)',
};

const matchAmsg2Route = (pathname: string): { shortName: string; operation: string } | null => {
    const clean = pathname.replace(/^\/+|\/+$/g, '');
    if (!clean) return null;
    if (AMSG2_ROUTE_LABELS[clean]) {
        const shortMap: Record<string, string> = {
            'instant-chat': '即时对话',
            'client-state': '云端状态同步',
            'client-state/namespaces': '云端状态同步',
            'llm-credentials': '模型凭据同步',
            'outbox': '收件账本补收',
            'outbox/ack': '收件确认',
            'schedule-message': '任务排程',
            'messages': '任务清单',
            'message': '任务状态查询',
            'update-message': '任务更新',
            'cancel-message': '任务取消',
            'push-subscription': '推送订阅登记',
            'vapid-public-key': '推送公钥查询',
            'get-user-key': '连接验证',
            'init-tenant': '初始化连接',
            'capabilities': '版本能力探测',
            'config-check': '配置体检',
            'debug': '诊断体检',
            'tick-report': '定时报告',
            'self-update': 'Worker 更新',
            'self-update/check': 'Worker 更新检查',
            'cron-trigger': '定时触发',
            'test-push': '测试推送',
        };
        return {
            shortName: shortMap[clean] || clean,
            operation: AMSG2_ROUTE_LABELS[clean],
        };
    }
    if (clean.startsWith('cloud-data/')) {
        return {
            shortName: '云端数据管理',
            operation: `云端数据操作 (/${clean})`,
        };
    }
    return null;
};

const matchLlmConfigSource = (
    targetHrefLower: string,
    targetOriginLower: string,
    endpoints: ConfiguredEndpointSnapshot,
): string | undefined => {
    const matchedPreset = endpoints.apiPresets?.find(p => matchesEndpointPrefix(targetHrefLower, targetOriginLower, p.baseUrl));
    if (matchesEndpointPrefix(targetHrefLower, targetOriginLower, endpoints.lightLlmBaseUrl)
        && !matchesEndpointPrefix(targetHrefLower, targetOriginLower, endpoints.mainApiBaseUrl)) {
        return '记忆宫殿 → 轻量副模型 API';
    }
    if (matchesEndpointPrefix(targetHrefLower, targetOriginLower, endpoints.checkPhoneApiBaseUrl)
        && !matchesEndpointPrefix(targetHrefLower, targetOriginLower, endpoints.mainApiBaseUrl)) {
        return '查手机 → 独立 API';
    }
    if (matchedPreset?.name) {
        return `对话 API（预设：${matchedPreset.name}）`;
    }
    if (matchesEndpointPrefix(targetHrefLower, targetOriginLower, endpoints.mainApiBaseUrl)) {
        return '设置 → 全局主对话 API';
    }
    return undefined;
};

const describeProxyWorkerConfig = (targetOrigin: string, endpoints: ConfiguredEndpointSnapshot): string => {
    const effective = (endpoints.proxyWorkerUrl || getProxyWorkerUrl()).replace(/\/+$/, '');
    try {
        if (new URL(effective).origin.toLowerCase() === targetOrigin.toLowerCase()) {
            return effective.toLowerCase() === DEFAULT_PROXY_WORKER.toLowerCase()
                ? `主代理 Worker（默认公共实例 ${DEFAULT_PROXY_WORKER}）`
                : `主代理 Worker（自定义地址 ${effective}）`;
        }
    } catch { /* ignore */ }
    if (isLegacyProxyWorkerUrl(targetOrigin)) {
        return '主代理 Worker（旧公共实例地址）';
    }
    return `代理服务 (${targetOrigin})`;
};

/**
 * 根据请求 URL、方法、安全请求头、请求体结构与本机已配置的服务端点，识别这条请求到底来自哪个功能模块。
 */
export const identifyNetworkRequestSource = (input: IdentifyNetworkRequestInput): NetworkRequestIdentity => {
    const endpoints = input.endpoints ?? readConfiguredEndpointsSnapshot();
    const pageOrigin = input.pageOrigin ?? (typeof location !== 'undefined' ? location.origin : '');
    const method = (input.method || 'GET').toUpperCase();
    const bodyHints = inspectRequestBodySafe(input.body);
    const parsed = safeParseUrl(input.url, pageOrigin || undefined);

    if (!parsed) {
        return {
            source: input.explicitMeta?.purpose ? `网络请求 · ${input.explicitMeta.purpose}` : '网络请求 · 非法地址',
            category: 'other',
            via: 'direct',
        };
    }

    if (parsed.protocol === 'blob:' || parsed.protocol === 'data:') {
        return {
            source: '本机资源 · 内联/Blob 数据',
            category: 'local-asset',
            via: 'same-origin',
            operation: `${method} ${parsed.protocol}`,
        };
    }

    const hostLower = parsed.hostname.toLowerCase();
    const originLower = parsed.origin.toLowerCase();
    const hrefLower = parsed.href.toLowerCase();
    const pathname = parsed.pathname;
    const isSameOrigin = Boolean(pageOrigin && originLower === pageOrigin.toLowerCase());

    // 1. 主动消息 2.0 大陆中转 (`amsg-relay.friedsully.com/t/<token>/<workerHost>/<path>`)
    const relayMatch = pathname.match(AMSG_RELAY_PATH_RE);
    if (hostLower === 'amsg-relay.friedsully.com' || (relayMatch && relayMatch[1].length >= 20)) {
        const tail = relayMatch?.[2] || '';
        if (tail === '_usage' || tail.startsWith('_usage/')) {
            return {
                source: '主动消息 2.0 · 大陆中转流量查询',
                category: 'amsg2',
                via: 'amsg-relay',
                operation: '查询中转 30 天用量 (/_usage)',
                configSource: '主动消息 2.0 → 大陆连接优化',
                impactHint: '仅影响设置页显示近 30 天中转流量统计，不影响消息收发。',
            };
        }
        if (tail === '_cf-api' || tail.startsWith('_cf-api/')) {
            return {
                source: '主动消息 2.0 · Cloudflare 部署代理（经大陆中转）',
                category: 'amsg2',
                via: 'amsg-relay',
                upstreamTarget: 'api.cloudflare.com',
                operation: '一键部署/更新 Worker (/_cf-api)',
                configSource: '主动消息 2.0 → 大陆连接优化',
                impactHint: '仅影响在设置页一键部署或更新 Cloudflare Worker，不影响已部署 Worker 的日常运行。',
            };
        }
        if (tail === '_deploy' || tail.startsWith('_deploy/')) {
            return {
                source: '主动消息 2.0 · 部署代码包拉取（经大陆中转）',
                category: 'amsg2',
                via: 'amsg-relay',
                upstreamTarget: 'raw.githubusercontent.com',
                operation: `拉取部署文件 (/${tail})`,
                configSource: '主动消息 2.0 → 大陆连接优化',
                impactHint: '仅影响一键部署拉取 Worker 代码，不影响已部署 Worker 的日常运行。',
            };
        }
        const slashIdx = tail.indexOf('/');
        const workerHost = slashIdx >= 0 ? tail.slice(0, slashIdx) : tail;
        const workerPath = slashIdx >= 0 ? tail.slice(slashIdx) : '/';
        const amsgRoute = matchAmsg2Route(workerPath);
        const subLabel = amsgRoute ? amsgRoute.shortName : (workerPath === '/' ? '连通探测' : workerPath);
        return {
            source: `主动消息 2.0 · ${subLabel}（经大陆中转）`,
            category: 'amsg2',
            via: 'amsg-relay',
            upstreamTarget: workerHost || undefined,
            operation: amsgRoute?.operation || `${method} ${workerPath}`,
            configSource: workerHost
                ? `主动消息 2.0 → 大陆中转 → Worker (${workerHost})`
                : '主动消息 2.0 → 大陆中转',
            impactHint: '浏览器经大陆中转发往你的 2.0 Worker 失败；已排好且到点的云端推送由 Cloudflare 直接发往设备，不经过这条连接。',
        };
    }

    // 2. 通用 MCP 代理约定 (`<proxyUrl>?target=<encodedServerUrl>`)
    const mcpTargetRaw = parsed.searchParams.get('target');
    if (mcpTargetRaw && /^https?:\/\//i.test(mcpTargetRaw)) {
        const targetParsed = safeParseUrl(mcpTargetRaw);
        const matchedServer = endpoints.mcpServers?.find(s => (
            (s.url && targetParsed && matchesEndpointPrefix(targetParsed.href.toLowerCase(), targetParsed.origin.toLowerCase(), s.url))
            || (s.proxyUrl && matchesEndpointPrefix(hrefLower, originLower, s.proxyUrl))
        ));
        const serverLabel = matchedServer?.name || targetParsed?.host || '远程工具';
        const opParts = [bodyHints.jsonRpcMethod, bodyHints.mcpToolName].filter(Boolean).join(':');
        return {
            source: `MCP · ${serverLabel}（经代理）`,
            category: 'mcp',
            via: 'mcp-proxy',
            upstreamTarget: targetParsed?.host || sanitizeUrlForLog(mcpTargetRaw),
            operation: opParts || `${method} MCP 请求`,
            configSource: matchedServer?.name ? `设置 → 扩展连接 → MCP 服务器「${matchedServer.name}」` : '设置 → 扩展连接 → MCP 代理转发',
            impactHint: '仅影响该 MCP 外部工具的握手或调用，不影响不带该工具的普通对话与本地存储。',
        };
    }

    // 3. 对话大模型接口（OpenAI 兼容 `/chat/completions`、`/responses`、Anthropic `/messages`、`/models`）
    const isAnthropic = isAnthropicEndpoint(parsed.href) || hasHeader(input.headers, 'anthropic-version');
    const isChatCompletions = pathname.includes('/chat/completions')
        || /\/responses\/?$/.test(pathname)
        || (isAnthropic && !/\/models\/?$/.test(pathname));
    const isModelsList = /\/models\/?$/.test(pathname);
    if (isChatCompletions || isModelsList) {
        const configSource = matchLlmConfigSource(hrefLower, originLower, endpoints);
        if (isModelsList) {
            const where = input.explicitMeta?.appName || (configSource ? configSource.replace(/^.*→\s*/, '') : parsed.host);
            return {
                source: `对话模型 · 拉取模型列表 (${where})`,
                category: 'llm',
                via: isSameOrigin ? 'same-origin' : 'direct',
                operation: '获取可用模型列表 (/models)',
                configSource: configSource || `模型服务 (${parsed.host})`,
                impactHint: '拉取模型列表或测试连接失败；请检查对应 API 地址（是否多填/少填 /v1）、密钥及跨域/代理设置。',
            };
        }
        const explicitApp = input.explicitMeta?.appName;
        const explicitPurpose = input.explicitMeta?.purpose;
        let subTitle = '';
        if (explicitApp && explicitPurpose) {
            subTitle = explicitPurpose.includes(explicitApp) ? explicitPurpose : `${explicitApp}（${explicitPurpose}）`;
        } else if (explicitPurpose) {
            subTitle = explicitPurpose;
        } else if (explicitApp) {
            subTitle = explicitApp;
        } else if (configSource === '记忆宫殿 → 轻量副模型 API') {
            subTitle = '记忆宫殿副模型';
        } else if (configSource === '查手机 → 独立 API') {
            subTitle = '查手机独立 API';
        } else {
            subTitle = isAnthropic ? `Anthropic Messages (${parsed.host})` : `生成请求 (${parsed.host})`;
        }
        return {
            source: `对话模型 · ${subTitle}`,
            category: 'llm',
            via: isSameOrigin ? 'same-origin' : 'direct',
            operation: isAnthropic ? 'Anthropic Messages 对话生成' : 'Chat Completions 对话生成',
            configSource: configSource || `对话模型服务 (${parsed.host})`,
            model: bodyHints.model,
        };
    }

    // 4. 记忆宫殿 Embedding / Rerank / Supabase 远程向量库
    if (/\/embeddings\/?$/i.test(pathname) || matchesEndpointPrefix(hrefLower, originLower, endpoints.embeddingBaseUrl)) {
        const batchNote = typeof bodyHints.embeddingBatchSize === 'number' ? `（batch=${bodyHints.embeddingBatchSize}）` : '';
        return {
            source: '记忆宫殿 · Embedding 向量化',
            category: 'embedding',
            via: isSameOrigin ? 'same-origin' : 'direct',
            operation: `文本向量化 (/embeddings)${batchNote}`,
            configSource: '记忆宫殿 → 向量化 (Embedding) API',
            model: bodyHints.model,
            impactHint: '仅影响记忆宫殿的向量编码/检索（发送消息前召回记忆或后台归档时会调用），与主动消息推送订阅及对话主 API 不是同一个接口；请去「记忆宫殿 → 设置」检查 Embedding 地址与网络。',
        };
    }

    if (/\/rerank\/?$/i.test(pathname) || matchesEndpointPrefix(hrefLower, originLower, endpoints.rerankBaseUrl)) {
        return {
            source: '记忆宫殿 · Rerank 重排',
            category: 'rerank',
            via: isSameOrigin ? 'same-origin' : 'direct',
            operation: '召回结果重排 (/rerank)',
            configSource: '记忆宫殿 → Rerank 重排 API',
            model: bodyHints.model,
            impactHint: '仅影响记忆宫殿的二次重排增强，与主对话 API 和主动消息推送无关。',
        };
    }

    if (
        pathname.includes('/memory_vectors')
        || pathname.includes('/rpc/match_vectors')
        || matchesEndpointPrefix(hrefLower, originLower, endpoints.supabaseUrl)
    ) {
        const isMatch = pathname.includes('match_vectors');
        return {
            source: '记忆宫殿 · 远程向量库 (Supabase)',
            category: 'vector-db',
            via: 'direct',
            operation: isMatch ? '向量相似度检索 (rpc/match_vectors)' : `${method} 向量表 (${pathname})`,
            configSource: '记忆宫殿 → 远程向量数据库 (Supabase)',
            impactHint: '仅影响 Supabase 远程向量读写与同步，本地聊天数据仍在设备 IndexedDB 中。',
        };
    }

    // 5. 主动消息 2.0 直连 Worker（按专属路由或已知 workerUrl 识别）
    const amsgRoute = matchAmsg2Route(pathname);
    const matchesAmsgWorker = Boolean(
        endpoints.amsgWorkerUrl && matchesEndpointPrefix(hrefLower, originLower, endpoints.amsgWorkerUrl),
    );
    if (amsgRoute || matchesAmsgWorker) {
        const subLabel = amsgRoute ? amsgRoute.shortName : (pathname === '/' ? '连通探测' : pathname);
        return {
            source: `主动消息 2.0 · ${subLabel}`,
            category: 'amsg2',
            via: 'direct',
            operation: amsgRoute?.operation || `${method} ${pathname}`,
            configSource: `主动消息 2.0 → 后端 Worker (${parsed.host})`,
            impactHint: '这是浏览器直连你的 2.0 Cloudflare Worker 的请求；大陆网络若直连 workers.dev 不稳定，可在「主动消息 2.0 → 后端 Worker」里开启「大陆连接优化」或绑定自定义域名。已排好且到点的推送由云端直接发出，不走此连接。',
        };
    }

    // 6. 主代理 Worker 各条业务支线（含默认公共实例、历史实例、用户自部署代理及独立音乐代理）
    const proxyUrl = endpoints.proxyWorkerUrl || DEFAULT_PROXY_WORKER;
    const isProxyWorkerHost = matchesEndpointPrefix(hrefLower, originLower, proxyUrl)
        || originLower === DEFAULT_PROXY_WORKER.toLowerCase()
        || isLegacyProxyWorkerUrl(parsed.origin);

    if (pathname.startsWith('/netease/')) {
        const action = pathname.slice('/netease/'.length) || 'unknown';
        const isCustomMusicWorker = Boolean(
            endpoints.musicWorkerUrl && matchesEndpointPrefix(hrefLower, originLower, endpoints.musicWorkerUrl),
        );
        return {
            source: `音乐 · 网易云代理 (${action})`,
            category: 'music',
            via: 'proxy-worker',
            operation: `网易云接口转发 (/netease/${action})`,
            configSource: isCustomMusicWorker
                ? `音乐 App → 自定义音乐服务 (${parsed.host})`
                : describeProxyWorkerConfig(parsed.origin, endpoints),
            impactHint: '仅影响音乐搜索、歌单或播放直链获取，不影响聊天及其他系统功能。',
        };
    }

    if (pathname === '/weibo' || pathname === '/weibo-image') {
        const isImg = pathname === '/weibo-image';
        const targetImgHost = isImg ? safeParseUrl(parsed.searchParams.get('url') || '')?.host : undefined;
        const actionSuffix = !isImg && bodyHints.weiboAction ? ` (${bodyHints.weiboAction})` : '';
        return {
            source: isImg ? '好友圈 · 微博图片代理' : `好友圈 · 微博同步${actionSuffix}`,
            category: 'weibo',
            via: 'proxy-worker',
            upstreamTarget: targetImgHost || 'weibo.com',
            operation: isImg ? '读取微博配图 (/weibo-image)' : `微博只读桥接 (/weibo${actionSuffix})`,
            configSource: describeProxyWorkerConfig(parsed.origin, endpoints),
            impactHint: '仅影响好友圈（哔哔）的微博动态或配图同步。',
        };
    }

    if (pathname === '/webdav' || hasHeader(input.headers, 'X-WebDAV-Method')) {
        const davMethod = (getHeaderValue(input.headers, 'X-WebDAV-Method') || method).toUpperCase();
        const targetDavUrl = parsed.searchParams.get('url') || '';
        const targetDavHost = safeParseUrl(targetDavUrl)?.host;
        return {
            source: `云备份 · WebDAV 代理 (${davMethod})`,
            category: 'backup',
            via: 'proxy-worker',
            upstreamTarget: targetDavHost || undefined,
            operation: `经 Worker 转发 WebDAV ${davMethod}`,
            configSource: `${describeProxyWorkerConfig(parsed.origin, endpoints)} → 云备份 WebDAV`,
            impactHint: '影响 WebDAV 云备份的连接检测、上传或下载；本地数据不受影响。',
        };
    }

    if (pathname === '/github' && isProxyWorkerHost) {
        const ghTarget = safeParseUrl(parsed.searchParams.get('url') || '')?.host || 'api.github.com';
        return {
            source: '云备份 · GitHub 代理',
            category: 'backup',
            via: 'proxy-worker',
            upstreamTarget: ghTarget,
            operation: `经 Worker 转发 GitHub 请求 (${method})`,
            configSource: `${describeProxyWorkerConfig(parsed.origin, endpoints)} → GitHub 备份`,
        };
    }

    if (pathname === '/cf-api') {
        return {
            source: '主动消息 2.0 · Cloudflare 部署代理',
            category: 'amsg2',
            via: 'proxy-worker',
            upstreamTarget: 'api.cloudflare.com',
            operation: '一键部署/更新 Worker (/cf-api)',
            configSource: describeProxyWorkerConfig(parsed.origin, endpoints),
            impactHint: '仅影响在设置页一键部署或更新 Cloudflare Worker，不影响已部署 Worker 的日常运行。',
        };
    }

    if (pathname === '/amsg-bundle') {
        return {
            source: '主动消息 2.0 · 部署代码包代理',
            category: 'amsg2',
            via: 'proxy-worker',
            upstreamTarget: 'raw.githubusercontent.com',
            operation: '拉取部署代码包 (/amsg-bundle)',
            configSource: describeProxyWorkerConfig(parsed.origin, endpoints),
            impactHint: '仅影响一键部署拉取 Worker 代码，不影响已部署 Worker 的日常运行。',
        };
    }

    if (pathname === '/mcp/mcd' || pathname === '/mcp/luckin') {
        const brand = pathname === '/mcp/mcd' ? '麦当劳点单' : '瑞幸点单';
        const opParts = [bodyHints.jsonRpcMethod, bodyHints.mcpToolName].filter(Boolean).join(':');
        return {
            source: `MCP · ${brand}代理`,
            category: 'mcp',
            via: 'proxy-worker',
            upstreamTarget: pathname === '/mcp/mcd' ? 'mcp.mcd.cn' : 'gwmcp.lkcoffee.com',
            operation: opParts || `${brand} MCP 转发 (${pathname})`,
            configSource: describeProxyWorkerConfig(parsed.origin, endpoints),
        };
    }

    if (pathname.startsWith('/notion/')) {
        return {
            source: '实时感知 · Notion 代理',
            category: 'realtime',
            via: 'proxy-worker',
            upstreamTarget: 'api.notion.com',
            operation: `${method} ${pathname}`,
            configSource: describeProxyWorkerConfig(parsed.origin, endpoints),
        };
    }

    if (pathname.startsWith('/feishu/')) {
        return {
            source: '实时感知 · 飞书多维表格代理',
            category: 'realtime',
            via: 'proxy-worker',
            upstreamTarget: 'open.feishu.cn',
            operation: `${method} ${pathname}`,
            configSource: describeProxyWorkerConfig(parsed.origin, endpoints),
        };
    }

    if (pathname.startsWith('/xhs/') || /^\/api\/xhs-/i.test(pathname) || hasHeader(input.headers, 'x-xhs-cookie')) {
        const sub = pathname.replace(/^\/(?:xhs|api)\//, '') || 'request';
        return {
            source: `小红书 · 桥接/代理 (${sub})`,
            category: 'xhs',
            via: isProxyWorkerHost ? 'proxy-worker' : (isSameOrigin ? 'same-origin' : 'direct'),
            operation: `${method} ${pathname}`,
            configSource: isProxyWorkerHost
                ? describeProxyWorkerConfig(parsed.origin, endpoints)
                : `小红书服务 (${parsed.host})`,
        };
    }

    if (pathname.startsWith('/replicate/')) {
        return {
            source: '写歌 · Replicate 音频生成代理',
            category: 'replicate',
            via: 'proxy-worker',
            upstreamTarget: 'api.replicate.com',
            operation: `${method} ${pathname}`,
            configSource: describeProxyWorkerConfig(parsed.origin, endpoints),
        };
    }

    if (pathname === '/expand-url' || pathname === '/fetch-webpage') {
        return {
            source: '工具 · 网页提取代理',
            category: 'webpage',
            via: 'proxy-worker',
            operation: pathname === '/expand-url' ? '短链展开 (/expand-url)' : '正文抓取 (/fetch-webpage)',
            configSource: describeProxyWorkerConfig(parsed.origin, endpoints),
        };
    }

    if (isProxyWorkerHost && (pathname === '/search' || pathname === '/news' || pathname === '/videos' || hasHeader(input.headers, 'X-Brave-API-Key'))) {
        return {
            source: `实时感知 · 联网搜索代理 (${pathname.slice(1) || 'search'})`,
            category: 'realtime',
            via: 'proxy-worker',
            upstreamTarget: 'api.search.brave.com',
            operation: `Brave 搜索转发 (${pathname})`,
            configSource: describeProxyWorkerConfig(parsed.origin, endpoints),
        };
    }

    if (isProxyWorkerHost && pathname === '/api/health') {
        return {
            source: '网络代理 Worker · 连通性检测 (/api/health)',
            category: 'xhs',
            via: 'proxy-worker',
            operation: '代理探活 (GET /api/health)',
            configSource: describeProxyWorkerConfig(parsed.origin, endpoints),
            impactHint: '这是主代理 Worker（或小红书 Lite 桥接）的连通性探活请求。',
        };
    }

    // 7. 语音合成 (TTS) / 语音识别 (STT) / 音频文件拉取
    if (
        pathname.startsWith('/api/minimax/')
        || pathname === '/minimax/stt'
        || hostLower === 'api.minimaxi.com'
        || hostLower === 'api.minimax.io'
        || hasHeader(input.headers, 'X-MiniMax-Region')
    ) {
        const isStt = pathname.includes('stt') || pathname.includes('speech_to_text');
        const isMusic = pathname.includes('music');
        const sub = isStt ? 'MiniMax 语音识别 (STT)' : isMusic ? 'MiniMax 音乐生成' : 'MiniMax 语音合成 (TTS)';
        return {
            source: `语音 · ${sub}`,
            category: isStt ? 'stt' : 'tts',
            via: isProxyWorkerHost ? 'proxy-worker' : (isSameOrigin ? 'same-origin' : 'direct'),
            operation: `${method} ${pathname}`,
            configSource: `语音设置 → MiniMax (${parsed.host})`,
            model: bodyHints.model,
        };
    }

    if (
        pathname === '/elevenlabs/tts'
        || pathname === '/elevenlabs/stt'
        || hostLower.endsWith('elevenlabs.io')
    ) {
        const isStt = pathname.includes('/stt') || pathname.includes('speech-to-text');
        return {
            source: isStt ? '语音 · ElevenLabs 语音识别' : '语音 · ElevenLabs 语音合成',
            category: isStt ? 'stt' : 'tts',
            via: isProxyWorkerHost ? 'proxy-worker' : 'direct',
            operation: `${method} ${pathname}`,
            configSource: isProxyWorkerHost
                ? `${describeProxyWorkerConfig(parsed.origin, endpoints)} → ElevenLabs`
                : '语音设置 → ElevenLabs 直连',
            model: bodyHints.model,
        };
    }

    if (
        pathname === '/fishaudio/tts'
        || pathname === '/fishaudio/stt'
        || hostLower.endsWith('fish.audio')
    ) {
        const isStt = pathname.includes('/stt') || pathname.includes('asr');
        return {
            source: isStt ? '语音 · Fish Audio 语音识别' : '语音 · Fish Audio 语音合成',
            category: isStt ? 'stt' : 'tts',
            via: isProxyWorkerHost ? 'proxy-worker' : 'direct',
            operation: `${method} ${pathname}`,
            configSource: isProxyWorkerHost
                ? `${describeProxyWorkerConfig(parsed.origin, endpoints)} → Fish Audio`
                : '语音设置 → Fish Audio',
        };
    }

    // 8. 通用 MCP 直连服务器（按已保存服务器 URL 或 JSON-RPC + MCP 协议头识别）
    const matchedMcpDirect = endpoints.mcpServers?.find(s => (
        s.url && matchesEndpointPrefix(hrefLower, originLower, s.url)
    ));
    if (
        matchedMcpDirect
        || hasHeader(input.headers, 'Mcp-Session-Id')
        || (bodyHints.jsonRpcMethod && /^(?:initialize|notifications\/initialized|tools\/list|tools\/call|prompts\/|resources\/)/.test(bodyHints.jsonRpcMethod))
    ) {
        const label = matchedMcpDirect?.name || parsed.host;
        const opParts = [bodyHints.jsonRpcMethod, bodyHints.mcpToolName].filter(Boolean).join(':');
        return {
            source: `MCP · 工具服务器 (${label})`,
            category: 'mcp',
            via: isSameOrigin ? 'same-origin' : 'direct',
            operation: opParts || `${method} ${pathname}`,
            configSource: matchedMcpDirect?.name
                ? `设置 → 扩展连接 → MCP 服务器「${matchedMcpDirect.name}」（直连）`
                : `MCP 服务器直连 (${parsed.host})`,
            impactHint: '浏览器直连远程 MCP 服务器常因对方未配 CORS 响应头而报 Failed to fetch / Load failed；可在 MCP 设置里配置代理地址。',
        };
    }

    // 9. 彼方（虚拟邮局 & 信号坠落处）
    const isBifang = hostLower === 'bifang.friedsully.com'
        || hostLower === 'bifang.qegj567.workers.dev'
        || hostLower === 'noir2.cc.cd'
        || (endpoints.postOfficeBaseUrl && matchesEndpointPrefix(hrefLower, originLower, endpoints.postOfficeBaseUrl));
    if (isBifang || pathname.startsWith('/po/poem/') || pathname.startsWith('/poem/')) {
        const isPoem = pathname.includes('/poem');
        return {
            source: isPoem ? '彼方 · 信号坠落处（跨实例合写诗）' : '彼方 · 虚拟邮局 / 漂流瓶',
            category: 'bifang',
            via: 'direct',
            operation: `${method} ${pathname}`,
            configSource: `彼方公共后端 (${parsed.host})`,
            impactHint: '仅影响彼方内的联机邮局或合写诗房间，不影响本地角色聊天与存档。',
        };
    }

    // 10. 美化分享码与公开装扮库
    if (hostLower === 'beauty.friedsully.com' || pathname.startsWith('/api/shares/')) {
        return {
            source: '装扮 · 美化分享码服务',
            category: 'beauty',
            via: 'direct',
            operation: `${method} ${pathname}`,
            configSource: `美化分享服务 (${parsed.host})`,
        };
    }
    if (hostLower === 'beauty-library.friedsully.com') {
        return {
            source: '装扮 · 公开装扮库目录',
            category: 'beauty',
            via: 'direct',
            operation: `${method} ${pathname}`,
            configSource: `装扮库静态目录 (${parsed.host})`,
        };
    }

    // 11. 云备份直连（WebDAV 原生/直连、GitHub API 直连）
    if (endpoints.webdavUrl && matchesEndpointPrefix(hrefLower, originLower, endpoints.webdavUrl)) {
        return {
            source: `云备份 · WebDAV 直连 (${method})`,
            category: 'backup',
            via: 'direct',
            operation: `WebDAV ${method} ${pathname}`,
            configSource: `设置 → 云备份 WebDAV (${parsed.host})`,
        };
    }
    const isGithubApi = hostLower === 'api.github.com' || hostLower === 'uploads.github.com';
    // A raw GitHub file or weather CDN icon can be display-only even on a recognized host.
    const accept = getHeaderValue(input.headers, 'accept').split(',').map(item => item.split(';')[0].trim().toLowerCase());
    const acceptsVisual = accept.some(type => /^(image|font)\//.test(type))
        && accept.every(type => type === '*/*' || /^(image|font)\//.test(type));
    if (!isSameOrigin && !isGithubApi && (method === 'GET' || method === 'HEAD') && /^https?:$/.test(parsed.protocol) && !input.explicitMeta && (
        /\.(?:apng|avif|bmp|gif|ico|jpe?g|jfif|png|svg|webp|woff2?|ttf|otf|ttc|eot)$/i.test(pathname)
        || (hostLower === 'fonts.googleapis.com' && /^\/(?:css2?|icon)\/?$/.test(pathname))
        || acceptsVisual
    )) {
        return {
            source: `外链资源 · 图片/字体 (${parsed.host})`,
            category: 'external-media',
            via: 'direct',
            operation: `${method} ${parsed.host}${pathname}`,
        };
    }

    if (hostLower === 'raw.githubusercontent.com' && pathname.toLowerCase().includes('/sullyos-workers/')) {
        return {
            source: '主动消息 2.0 · 部署代码包（GitHub 直连）',
            category: 'amsg2',
            via: 'direct',
            operation: `${method} ${parsed.host}${pathname}`,
            configSource: '主动消息 2.0 → 一键部署',
            impactHint: '仅影响一键部署直连 GitHub 拉取代码包，不影响云备份或已部署 Worker 的日常运行。',
        };
    }

    if (isGithubApi || hostLower === 'raw.githubusercontent.com') {
        return {
            source: '云备份 / 资源 · GitHub 直连',
            category: 'backup',
            via: 'direct',
            operation: `${method} ${parsed.host}${pathname}`,
            configSource: 'GitHub 接口直连',
        };
    }

    // 12. 实时感知与外部公共数据源（热榜、天气、节假日、搜索、网页提取）
    if (hostLower.includes('open-meteo.com') || hostLower.includes('wttr.in') || hostLower.includes('weather')) {
        return {
            source: '实时感知 · 天气查询',
            category: 'realtime',
            via: 'direct',
            operation: `${method} ${parsed.host}${pathname}`,
            configSource: '设置 → 扩展连接 → 实时感知（天气）',
            impactHint: '仅影响环境天气背景信息注入，不影响对话主流程。',
        };
    }
    if (hostLower.includes('orz.ai') || hostLower === 'hacker-news.firebaseio.com' || parsed.searchParams.has('platform')) {
        return {
            source: '实时感知 · 热点榜单拉取',
            category: 'realtime',
            via: 'direct',
            operation: `${method} ${parsed.host}${pathname}`,
            configSource: '实时感知 / 热点 App',
            impactHint: '仅影响热榜话题背景更新，不影响正常聊天。',
        };
    }
    if (hostLower.includes('timor.tech') || pathname.includes('/holiday')) {
        return {
            source: '实时感知 · 节假日日历查询',
            category: 'realtime',
            via: 'direct',
            operation: `${method} ${parsed.host}${pathname}`,
            impactHint: '仅影响节假日提醒信息获取，静默降级不影响使用。',
        };
    }
    if (hostLower === 'api.search.brave.com' || hostLower.includes('firecrawl') || hostLower.includes('apizero')) {
        return {
            source: '工具 · 联网搜索 / 网页抓取',
            category: 'webpage',
            via: 'direct',
            operation: `${method} ${parsed.host}${pathname}`,
        };
    }

    // 13. 外部独立引擎 / 本地桥接
    if (pathname.includes('/brain/execute')) {
        return {
            source: '外部引擎 · BrainAgent',
            category: 'engine',
            via: 'direct',
            operation: `${method} ${pathname}`,
        };
    }
    if (pathname.startsWith('/toolbox/')) {
        return {
            source: `外部工具箱 · Toolbox (${pathname.slice('/toolbox/'.length)})`,
            category: 'engine',
            via: 'direct',
            operation: `${method} ${pathname}`,
        };
    }
    if (pathname === '/api/health') {
        return {
            source: `本地/桥接服务 · 连通性探活 (${parsed.host})`,
            category: 'xhs',
            via: isSameOrigin ? 'same-origin' : 'direct',
            operation: `GET ${pathname}`,
        };
    }

    // 14. 本机同源静态资源 vs 外链音频/图片资源
    if (isSameOrigin) {
        if (pathname.includes('/room3d/')) {
            return {
                source: '本机资源 · 3D 家园模型/动作素材',
                category: 'local-asset',
                via: 'same-origin',
                operation: `${method} ${pathname}`,
            };
        }
        if (pathname.includes('/live2d/') || /\.(?:moc3|model3\.json|physics3\.json)$/i.test(pathname)) {
            return {
                source: '本机资源 · Live2D 模型资源',
                category: 'local-asset',
                via: 'same-origin',
                operation: `${method} ${pathname}`,
            };
        }
        if (pathname.includes('character_creator') || pathname.includes('parts/manifest.json') || pathname.includes('/chibi/')) {
            return {
                source: '本机资源 · 捏人/衣橱素材',
                category: 'local-asset',
                via: 'same-origin',
                operation: `${method} ${pathname}`,
            };
        }
        if (/manifest\.webmanifest|manifest\.json|version\.json/i.test(pathname)) {
            return {
                source: '本机资源 · 应用清单 / 版本检查',
                category: 'local-asset',
                via: 'same-origin',
                operation: `${method} ${pathname}`,
            };
        }
        return {
            source: `本机资源 · 静态文件 (${pathname.split('/').pop() || pathname})`,
            category: 'local-asset',
            via: 'same-origin',
            operation: `${method} ${pathname}`,
        };
    }

    if (/\.(?:mp3|wav|ogg|m4a|aac|flac|opus)(?:$|\?)/i.test(pathname) || /audio|voice|tts/i.test(hostLower)) {
        return {
            source: `语音/音频 · 媒体资源下载 (${parsed.host})`,
            category: 'audio',
            via: 'direct',
            operation: `${method} ${parsed.host}${pathname}`,
            impactHint: '音频文件本身加载失败（直链过期、CDN 跨域限制或网络被拦），不等于上游文本生成失败。',
        };
    }

    if (isProxyWorkerHost) {
        return {
            source: `网络代理 Worker · ${pathname === '/' ? '根路径' : pathname}`,
            category: 'other',
            via: 'proxy-worker',
            operation: `${method} ${pathname}`,
            configSource: describeProxyWorkerConfig(parsed.origin, endpoints),
        };
    }

    const purposeSuffix = input.explicitMeta?.purpose ? `（${input.explicitMeta.purpose}）` : '';
    return {
        source: `网络请求 · ${parsed.host || input.url}${purposeSuffix}`,
        category: 'other',
        via: 'direct',
        operation: `${method} ${pathname || '/'}`,
    };
};

const SKIP_CALLER_FRAME_RE = /(?:patchedFetch|fetchLlm|safeFetchJson|captureCallerHint|extractCallerHint|identifyNetworkRequestSource|buildFetchFailureDetail|originalConsoleError|console\.error|node_modules)/i;

/**
 * 从 `Error.stack` 提取最靠近业务调用点的 1~2 帧，剥掉完整的站点域名，保留紧凑文件名与行号。
 */
export const extractCallerHint = (stack?: string | null): string | undefined => {
    if (!stack || typeof stack !== 'string') return undefined;
    const lines = stack
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    const picked: string[] = [];
    for (const rawLine of lines) {
        if (/^(?:Error|TypeError|DOMException|AbortError|TimeoutError)\b/i.test(rawLine) && !rawLine.includes('@') && !rawLine.includes('at ')) {
            continue;
        }
        if (SKIP_CALLER_FRAME_RE.test(rawLine)) continue;

        // V8: "at fnName (https://host/path/file.ts:12:34)" 或 "at https://host/path/file.ts:12:34"
        // WebKit/Firefox: "fnName@https://host/path/file.ts:12:34"
        let fnName = '';
        let loc = rawLine;
        const v8Named = rawLine.match(/^at\s+([^\s(]+)\s+\((.+)\)$/);
        const v8Anon = !v8Named ? rawLine.match(/^at\s+(.+)$/) : null;
        const webkit = !v8Named && !v8Anon ? rawLine.match(/^([^@]*)@(.+)$/) : null;

        if (v8Named) {
            fnName = v8Named[1];
            loc = v8Named[2];
        } else if (v8Anon) {
            loc = v8Anon[1];
        } else if (webkit) {
            fnName = webkit[1];
            loc = webkit[2];
        } else {
            continue;
        }

        if (/^native\b|^\[native code\]$/i.test(loc)) continue;

        // 剥掉协议域名与 Vite 时间戳参数，如 https://x.io/SullyOS/utils/foo.ts?t=123:45:6 -> utils/foo.ts:45:6
        const cleanedLoc = loc
            .replace(/^https?:\/\/[^/]+\/(?:SullyOS\/)?/i, '')
            .replace(/\?[^:)]+(?=:\d+)/g, '');

        if (!cleanedLoc || SKIP_CALLER_FRAME_RE.test(fnName) || SKIP_CALLER_FRAME_RE.test(cleanedLoc)) continue;
        const cleanFn = fnName.replace(/^(?:Object|Module|async)\./, '').trim();
        const formatted = cleanFn && cleanFn !== '<anonymous>'
            ? `${cleanFn} (${cleanedLoc})`
            : cleanedLoc;
        if (!picked.includes(formatted)) picked.push(formatted);
        if (picked.length >= 2) break;
    }

    return picked.length > 0 ? picked.join(' <- ') : undefined;
};

export const captureCallerHint = (): string | undefined => {
    try {
        return extractCallerHint(new Error().stack);
    } catch {
        return undefined;
    }
};

/**
 * 提取 `console.error` 捕获的应用层报错来源（消息标签、调用文件名或当前界面）。
 */
export const identifyApplicationErrorSource = (
    message: string,
    ambientMeta?: ApiCallMeta,
    caller?: string,
): string => {
    // 优先提取消息里的 `[模块标签]`（如 `❌ [Embedding] ...`、`[MemoryPalace]`、`[extractJson]`）
    const tagMatch = String(message || '').match(/\[([A-Za-z0-9_.:/\u4e00-\u9fa5 -]{2,32})\]/);
    if (tagMatch?.[1]) {
        const rawTag = tagMatch[1].trim();
        const friendlyMap: Record<string, string> = {
            Embedding: '记忆宫殿 · Embedding',
            MemoryPalace: '记忆宫殿',
            'DateApp MemoryPalace': '见面 · 记忆宫殿',
            extractJson: '模型响应 JSON 解析',
            'chat-stop': '消息 · 回复收尾',
            ActiveMsg: '主动消息 2.0',
            AmsgInstantChat: '主动消息 2.0 · 即时对话',
        };
        return `应用报错 · ${friendlyMap[rawTag] || rawTag}`;
    }
    if (caller) {
        const fileMatch = caller.match(/([A-Za-z0-9_-]+)\.(?:tsx?|jsx?|mjs|js):/);
        if (fileMatch?.[1] && !/^index$/i.test(fileMatch[1])) {
            return `应用报错 · ${fileMatch[1]}`;
        }
    }
    if (ambientMeta?.appName) {
        return `应用报错（当前界面：${ambientMeta.appName}）`;
    }
    return '应用报错';
};

/** 格式化为带本地时区偏移的可读时间（如 `2026-11-19 14:20:05.123 +09:00`），JSON 里一眼可读。 */
export const formatDiagnosticTimestamp = (epochMs: number): string => {
    const d = new Date(epochMs);
    if (Number.isNaN(d.getTime())) return String(epochMs);
    const pad = (n: number, w = 2) => String(Math.abs(Math.trunc(n))).padStart(w, '0');
    const tzOffsetMin = -d.getTimezoneOffset();
    const sign = tzOffsetMin >= 0 ? '+' : '-';
    const tzHours = pad(Math.floor(Math.abs(tzOffsetMin) / 60));
    const tzMins = pad(Math.abs(tzOffsetMin) % 60);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} `
        + `${sign}${tzHours}:${tzMins}`;
};

const readSafeBuildMeta = (): { appVersion: string; branch: string; commit: string; buildTime?: string } => {
    const branch = typeof __BUILD_BRANCH__ !== 'undefined' ? String(__BUILD_BRANCH__) : 'unknown';
    const commit = typeof __BUILD_COMMIT__ !== 'undefined' ? String(__BUILD_COMMIT__) : 'unknown';
    const buildTime = typeof __BUILD_TIME__ !== 'undefined' ? String(__BUILD_TIME__) : undefined;
    return {
        appVersion: APP_VERSION,
        branch,
        commit,
        ...(buildTime ? { buildTime } : {}),
    };
};

export const readCompactBuildString = (): string => {
    const meta = readSafeBuildMeta();
    return meta.branch !== 'unknown' || meta.commit !== 'unknown'
        ? `${meta.appVersion} (${meta.branch}@${meta.commit})`
        : meta.appVersion;
};

/**
 * 为 `errorSelfCheck.ts` 未覆盖的非对话接口（主动消息 2.0、网易云代理、WebDAV、语音、MCP、向量库、本机素材等）
 * 以及切后台断连 / 流式中断生成具名自检提示，避免状态栏「报错自检」退回笼统的「这次请求没成功」。
 */
export const buildIdentityErrorAdvice = (input: {
    identity: NetworkRequestIdentity;
    failureKind?: string;
    status?: number;
    backgroundedDuringRequest?: boolean;
}): { title: string; action: string } | undefined => {
    const { identity, failureKind, status, backgroundedDuringRequest } = input;
    if (failureKind === 'aborted') return undefined;
    if (backgroundedDuringRequest && failureKind === 'blocked') {
        return {
            title: `${identity.source} 在切后台期间中断`,
            action: '移动端浏览器进入后台或锁屏时会切断进行中的请求，请保持页面在前台重试一次。',
        };
    }
    if (failureKind === 'stream-interrupted') {
        return {
            title: `${identity.source} 传输中途断开`,
            action: '已收到服务商响应头但流式读取中断，请保持前台重试一次；持续出现可尝试更换节点或联系服务商。',
        };
    }
    if (identity.impactHint) {
        return {
            title: `${identity.source} 请求失败${status ? ` (HTTP ${status})` : ''}`,
            action: identity.impactHint,
        };
    }
    if (identity.category !== 'other') {
        const where = identity.configSource ? `可先核对「${identity.configSource}」的地址与当前网络，` : '';
        return {
            title: `${identity.source} 请求失败${status ? ` (HTTP ${status})` : ''}`,
            action: `${where}展开下方「技术详情」可查看初判与连通性复检结果。`,
        };
    }
    return undefined;
};

/**
 * 系统调试终端「复制 JSON」导出的顶层结构：附上版本、构建号与运行环境摘要，避免群里收到裸数组还要追问设备和版本。
 */
export const buildSystemLogsExportPayload = (logs: SystemLog[]) => {
    const now = Date.now();
    let standalone = false;
    try {
        standalone = Boolean(
            (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)')?.matches)
            || (typeof navigator !== 'undefined' && (navigator as any).standalone === true),
        );
    } catch { /* ignore */ }

    return {
        exportedAt: formatDiagnosticTimestamp(now),
        build: readSafeBuildMeta(),
        environment: {
            origin: typeof location !== 'undefined' ? location.origin : undefined,
            online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
            visibilityState: typeof document !== 'undefined' ? document.visibilityState : undefined,
            standalone,
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
        },
        count: logs.length,
        logs,
    };
};
