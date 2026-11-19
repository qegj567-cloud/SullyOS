// 全局 fetch 拦截器（context/OSContext.tsx）抓到「请求压根没拿到响应」时，把浏览器那句
// 光秃秃的 `TypeError: Failed to fetch` 翻成一条能照着排查的日志。
//
// 为什么值得单开一份：
//   1. 浏览器出于安全，把「DNS 解析不了」「梯子把连接掐了」「扩展屏蔽了」「对方返回的
//      响应没有 CORS 头」这四件完全不同的事，统统报成同一句 Failed to fetch，不带任何
//      细节。用户把日志复制出来发到群里，信息量是零——这份文件的活就是把能补的旁证
//      （耗时、在线状态、是否跨域、Resource Timing 里那条记录）全补上，再给一句初判。
//   2. 其中最关键的一条旁证是「换 no-cors 再打一次这个域名」：no-cors 不做 CORS 校验，
//      只要网络路径通就会拿到一个 opaque 响应。它成功而原请求失败 ⇒ 网络没问题，是响应
//      头/CORS 的事（多半是对方挡在 Cloudflare 限流页或人机验证页后面）；它也失败 ⇒ 这台
//      设备到这个域名是真的不通，该去查梯子规则 / DNS / 防火墙 / 扩展。这一刀把排查范围
//      直接砍掉一半，是整份文件存在的理由。
//   3. 判定全是纯函数，能脱开浏览器单测；探测那部分把 fetch 当参数传进来，测试塞假的。
//
// ⚠️ 探测必须用**未被拦截的原生 fetch**（拦截器里的 originalFetch），否则探测自己失败会
// 再写一条日志，一条网络错误滚成一屏。

import type { SystemLog, SystemLogContext } from '../types';
import type { ApiCallMeta } from './apiCallLog';
import {
    buildIdentityErrorAdvice,
    formatDiagnosticTimestamp,
    identifyApplicationErrorSource,
    identifyNetworkRequestSource,
    readCompactBuildString,
    redactRelayTokensInText,
    sanitizeUrlForLog,
    type ConfiguredEndpointSnapshot,
    type NetworkRequestIdentity,
} from './networkRequestSource';

/** 连接失败的粗分类。用于选那句初判，也用于决定要不要做 no-cors 复检。 */
export type FetchFailureKind =
    | 'aborted'             // 调用方主动取消（页面/组件卸载、用户点停）
    | 'timeout'             // AbortSignal.timeout() 到点掐的：连接挂住不返回，跟「被拒」是两回事
    | 'stream-interrupted'  // 已收到 HTTP 响应头，在读取正文或 SSE 流式传输中途断开
    | 'offline'             // navigator.onLine === false，浏览器自己知道没网
    | 'mixed-content'       // https 页面打 http 地址，被浏览器直接拦
    | 'bad-url'             // 地址本身就不合法（拼错、少了协议头）
    | 'blocked'             // 拿不到响应：代理/DNS/扩展/CORS 四选一，靠复检再分
    | 'unknown';

export interface ReceivedResponseHeadersInfo {
    status: number;
    headersMs: number;
    contentType?: string;
    streamUpgraded?: boolean;
}

export interface FetchFailureContext {
    url: string;
    /** 请求方法，取不到按 GET 记。 */
    method?: string;
    /** 从发起到抛错的毫秒数。 */
    durationMs?: number;
    error?: unknown;
    /** 以下三项默认读全局，测试里显式传。 */
    online?: boolean;
    pageOrigin?: string;
    pageProtocol?: string;
    /** 只含体积/结构，不含消息正文；用于比较“同 API、不同功能”的请求差异。 */
    requestSummary?: FetchRequestSummary;
    /** 调用方显式标注的用途，例如“剧情见面生成”。 */
    requestPurpose?: string;
    /** 调用方显式传入的完整归属（`__sullyMeta`）。 */
    explicitMeta?: ApiCallMeta;
    /** 发起时刻的前台界面快照（无显式归属时作参考）。 */
    ambientMeta?: ApiCallMeta;
    /** 识别出的具体功能来源（模块、转发链路、配置归属、模型名等）。 */
    identity?: NetworkRequestIdentity;
    /** 发起时与报错时的页面可见性，以及期间是否进入过后台/锁屏。 */
    visibilityAtStart?: string;
    visibilityAtEnd?: string;
    backgroundedDuringRequest?: boolean;
    /** 精简调用栈线索。 */
    caller?: string;
    /** 若请求在拿到响应头后、读取响应体/流中途才抛错，传入当时已收到的响应头信息。 */
    responseHeadersReceived?: ReceivedResponseHeadersInfo;
    /** 同一 method + URL 在本页面生命周期内最近一次成功读完整个响应正文的记录。 */
    recentSuccessfulSameRequest?: { timestamp: number; status: number };
}

export interface FetchRequestSummary {
    bodyBytes: number;
    messageCount?: number;
    contentChars?: number;
    lastMessageRole?: string;
    stream?: boolean;
    optionalParams?: string[];
}

const utf8ByteLength = (value: string): number => {
    try {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
    } catch { /* fall through */ }
    return value.length;
};

/**
 * 提取 chat/completions 请求的安全结构摘要。绝不把 prompt、API key 或角色正文写进日志。
 * 这组旁证专门回答“同一个 API 为什么陪伴能出、剧情不能出”：两边 URL 相同不代表
 * 请求相同，剧情常见差异是更大的 messages、assistant 预填充和额外采样参数。
 */
export const summarizeFetchRequestBody = (body: unknown): FetchRequestSummary | undefined => {
    if (typeof body !== 'string') return undefined;
    const summary: FetchRequestSummary = { bodyBytes: utf8ByteLength(body) };
    try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return summary;
        if (Array.isArray(parsed.messages)) {
            summary.messageCount = parsed.messages.length;
            summary.contentChars = parsed.messages.reduce((total: number, message: any) => {
                const content = message?.content;
                if (typeof content === 'string') return total + content.length;
                if (content == null) return total;
                try { return total + JSON.stringify(content).length; } catch { return total; }
            }, 0);
            const lastRole = parsed.messages.at(-1)?.role;
            if (typeof lastRole === 'string') summary.lastMessageRole = lastRole;
        }
        if (typeof parsed.stream === 'boolean') summary.stream = parsed.stream;
        const optionalParams = ['top_p', 'frequency_penalty', 'presence_penalty', 'reasoning_effort', 'tools']
            .filter(key => parsed[key] !== undefined);
        if (optionalParams.length > 0) summary.optionalParams = optionalParams;
    } catch { /* 非 JSON 只记录字节数 */ }
    return summary;
};

const readError = (error: unknown): { name: string; message: string } => {
    if (error instanceof Error) return { name: error.name || 'Error', message: error.message || String(error) };
    if (error && typeof error === 'object') {
        const anyErr = error as { name?: unknown; message?: unknown };
        return {
            name: typeof anyErr.name === 'string' ? anyErr.name : 'Error',
            message: typeof anyErr.message === 'string' ? anyErr.message : String(error),
        };
    }
    return { name: 'Error', message: String(error ?? '') };
};

/**
 * 各家浏览器对「连不上」的说法不一样，漏认一种就会掉进 unknown：
 * Chrome/Edge 是 Failed to fetch，Safari 是 Load failed，Firefox 是
 * NetworkError when attempting to fetch resource。
 */
const looksLikeNetworkError = (message: string) => (
    /failed to fetch/i.test(message)
    || /load failed/i.test(message)
    || /networkerror/i.test(message)
    || /network request failed/i.test(message)
);

/** 把 URL 拆成 origin/host，拆不动（相对路径、拼错）时用当前页面兜底。 */
export const parseTargetUrl = (url: string, base?: string): { ok: boolean; origin: string; host: string; protocol: string; href: string } => {
    try {
        const parsed = new URL(url, base || (typeof location !== 'undefined' ? location.href : undefined));
        return { ok: true, origin: parsed.origin, host: parsed.host, protocol: parsed.protocol, href: parsed.href };
    } catch {
        return { ok: false, origin: '', host: '', protocol: '', href: url };
    }
};

/** http://localhost / 127.0.0.1 在 Chrome 里算可信来源，不当混合内容拦；Firefox 会拦。 */
const isLoopbackHost = (host: string) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);

export const classifyFetchFailure = (ctx: FetchFailureContext): FetchFailureKind => {
    const { name, message } = readError(ctx.error);
    // AbortSignal.timeout() 抛的是 TimeoutError（"signal timed out"），跟用户/组件主动
    // abort 抛的 AbortError 不是一回事：前者说明连接挂住了，必须继续往下查；后者到此为止。
    // 先按 TimeoutError 判，再判 AbortError——顺序反了会把超时吞进「主动取消」。
    const isTimeout = name === 'TimeoutError' || /timed?\s?out|timeout/i.test(message);
    if (!isTimeout && (name === 'AbortError' || /aborted|abort/i.test(message))) return 'aborted';

    // 已经拿到 HTTP 响应头、在读取正文或 SSE 流式传输中途抛错：说明 DNS、握手和 CORS
    // 响应头都已经过了，不能再混进 blocked 让人去查 DNS 或跨域头。
    if (ctx.responseHeadersReceived) return 'stream-interrupted';
    if (isTimeout) return 'timeout';

    const target = parseTargetUrl(ctx.url);
    if (!target.ok) return 'bad-url';

    const pageProtocol = ctx.pageProtocol ?? (typeof location !== 'undefined' ? location.protocol : '');
    if (pageProtocol === 'https:' && target.protocol === 'http:' && !isLoopbackHost(target.host)) return 'mixed-content';

    const online = ctx.online ?? (typeof navigator !== 'undefined' ? navigator.onLine : true);
    if (online === false) return 'offline';

    if (looksLikeNetworkError(message) || name === 'TypeError') return 'blocked';
    return 'unknown';
};

/** 每种分类给一句「现在能确定什么」+ 一行「可能是什么」。 */
const VERDICTS: Record<FetchFailureKind, { verdict: string; causes: string }> = {
    aborted: {
        verdict: '请求被主动取消（页面/组件卸载了，或调用方自己撤了）。',
        causes: '中途切走了页面 · 手动点了停止',
    },
    timeout: {
        verdict: '请求超时：在截止时间前未完成。仅凭超时无法判断是连接、上游处理还是响应传输阶段。',
        causes: '代理/梯子接下了连接但上游是黑洞 · 这个域名没走代理、直连被拦截丢包 · 解析到的 IP 不可达 · 对方服务器无响应',
    },
    'stream-interrupted': {
        verdict: '已收到服务端响应头，但在读取响应正文或流式传输途中连接断开（DNS、跨域头和初始握手均已通过）。',
        causes: '上游生成耗时过长被网关/中转空闲掐断 · 流式传输中途网络或代理抖动 · 请求期间切后台/锁屏被系统中断连接 · 上游提前关闭了流',
    },
    offline: {
        verdict: '浏览器自己报告当前离线，请求根本没发出去。',
        causes: '网络断了 · 梯子刚切换/掉线 · 设备进了飞行模式',
    },
    'mixed-content': {
        verdict: 'https 页面去打 http 地址，被浏览器的混合内容策略直接拦下，请求没有发出去。',
        causes: '地址少了 s（http:// 应为 https://） · 自建服务没配证书',
    },
    'bad-url': {
        verdict: '这个地址本身不是合法 URL，请求没有发出去。',
        causes: '地址填错/少了 https:// · 复制时带进了空格或中文引号',
    },
    blocked: {
        verdict: '浏览器没有向页面提供可读取的响应；可能是连接失败，也可能已收到响应但被 CORS 拦截，暂时无法确定。',
        causes: '梯子/代理把这个域名的连接掐了 · DNS 解析不到 · 浏览器扩展（广告拦截/隐私盾/脚本管理器）屏蔽了 · 对方返回的是一张不带 CORS 头的页面（限流、人机验证、网关报错）',
    },
    unknown: {
        verdict: '请求失败，且不符合已知的几种失败形态。',
        causes: '看下面的错误原文',
    },
};

const formatVisibilityLabel = (state?: string): string => {
    if (state === 'hidden') return '后台/锁屏(hidden)';
    if (state === 'visible') return '前台(visible)';
    return state || '未知';
};

/**
 * 生成写进 `SystemLog.message` 的单行摘要：不用点开 detail 也能一眼看出「哪个接口、什么动作、为什么失败」。
 */
export const formatFetchFailureHeadline = (ctx: FetchFailureContext): string => {
    const { message } = readError(ctx.error);
    const kind = classifyFetchFailure(ctx);
    const method = (ctx.method || 'GET').toUpperCase();
    const safeUrl = sanitizeUrlForLog(ctx.url);
    const parsed = parseTargetUrl(safeUrl);
    let compactTarget = safeUrl;
    if (parsed.ok) {
        try {
            const u = new URL(parsed.href);
            compactTarget = ctx.identity?.via === 'amsg-relay' && ctx.identity.upstreamTarget
                ? `中转→${ctx.identity.upstreamTarget}${u.pathname.replace(/^\/t\/<redacted>\/[^/]+/, '') || '/'}`
                : `${u.host}${u.pathname}`;
        } catch {
            compactTarget = parsed.host || safeUrl;
        }
    }
    const kindLabel: Record<FetchFailureKind, string> = {
        aborted: '已取消',
        timeout: '超时',
        'stream-interrupted': `流式读取中断(HTTP ${ctx.responseHeadersReceived?.status ?? 200})`,
        offline: '当前离线',
        'mixed-content': '混合内容拦截',
        'bad-url': '地址格式错误',
        blocked: '连接/跨域失败',
        unknown: '请求异常',
    };
    const dur = typeof ctx.durationMs === 'number' ? ` · ${ctx.durationMs}ms` : '';
    const bgTag = ctx.backgroundedDuringRequest && kind !== 'aborted' ? ' · 期间切过后台' : '';
    const rawMsg = redactRelayTokensInText(message || 'Fetch Failed');
    return `${method} ${compactTarget} ${kindLabel[kind]}: ${rawMsg}${dur}${bgTag}`;
};

/**
 * Resource Timing 里那条记录能补两个关键旁证：到底有没有收到响应状态码、传了多少字节。
 *
 * ⚠️ 必须按发起时刻筛。getEntriesByName() 捞的是整个页面生命周期内打过这个地址的**全部**
 * 记录，而像 /client-state 这种反复请求的端点，timeline 里一直躺着早先成功那次的 200。
 * 偏偏「连接压根没建立」的失败什么都不会往 timeline 里写——于是不筛的话，越是老用户、
 * 越是之前一直用得好好的地址，越会拿到一条陈旧的成功记录，并据此打出「对方其实回了 200，
 * 是被 CORS 拦的」，跟同一条日志里的耗时线索和 no-cors 复检结论正面打架。
 *
 * startedAt 用 performance.now() 的基准（跟 entry.startTime 同一条时间轴，不能换成
 * Date.now()）。取不到就整段不出——宁可少说一句，也不能说反。
 */
export const readResourceTimingHint = (
    href: string,
    opts: { startedAt: number; perf?: { getEntriesByName?: (name: string, type?: string) => any[] } },
): string => {
    const { startedAt } = opts;
    if (!Number.isFinite(startedAt)) return '';
    const target = opts.perf ?? (typeof performance !== 'undefined' ? (performance as any) : undefined);
    if (!target?.getEntriesByName) return '';
    let entries: any[] = [];
    try {
        entries = target.getEntriesByName(href, 'resource') || [];
    } catch {
        return '';
    }
    const entry = entries
        .filter(item => typeof item?.startTime === 'number' && item.startTime >= startedAt)
        .pop();
    if (!entry) return 'Resource Timing: 没有这条请求的记录；无法据此判断连接是否建立，或响应是否被浏览器隐藏。';
    // 跨域资源拿不到 Timing-Allow-Origin 授权时，规范要求把 responseStatus、transferSize、
    // 各阶段时间戳统统置 0。这时候「transferSize=0」的意思是「没授权看」，不是「一个字节都
    // 没传」——照字面读会得出跟事实相反的结论，所以这些字段整个不印，改成一句说明。
    // responseStart 是判断有没有授权最稳的探针：它比 responseStatus 老得多，Safari 也有。
    const timingAllowed = (typeof entry.responseStart === 'number' && entry.responseStart > 0)
        || (typeof entry.responseStatus === 'number' && entry.responseStatus > 0);
    const parts: string[] = [];
    if (timingAllowed) {
        if (typeof entry.responseStatus === 'number' && entry.responseStatus > 0) {
            parts.push(`responseStatus=${entry.responseStatus}`);
        }
        if (typeof entry.transferSize === 'number') parts.push(`transferSize=${entry.transferSize}`);
    }
    if (typeof entry.duration === 'number') parts.push(`duration=${Math.round(entry.duration)}ms`);
    let note = '';
    if (timingAllowed && typeof entry.responseStatus === 'number' && entry.responseStatus > 0) {
        note = ` → 对方其实回了 HTTP ${entry.responseStatus}，是响应被 CORS 拦掉的，不是网络不通`;
    } else if (!timingAllowed) {
        note = '（对方没给 Timing-Allow-Origin，状态码和字节数看不到，只有耗时可信）';
    }
    return `Resource Timing: ${parts.join(', ') || '有记录'}${note}`;
};

/**
 * 耗时只能帮助缩小范围，不能区分 DNS、握手、上游处理和响应 CORS 检查。
 */
export const readStallHint = (durationMs?: number, kind?: FetchFailureKind): string => {
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return '';
    if (kind && kind !== 'blocked' && kind !== 'timeout' && kind !== 'unknown') return '';
    if (durationMs >= 5000) {
        return `耗时线索: ${(durationMs / 1000).toFixed(1)}s 后失败，可能涉及代理/连接等待、上游处理或传输中断；也可能是较晚返回的响应被 CORS 拦截，不能仅凭耗时确定失败阶段。`;
    }
    if (durationMs <= 300) {
        return `耗时线索: ${Math.round(durationMs)}ms 就失败，可能是快速的 CORS 拒绝、DNS/代理失败或扩展拦截；不能仅凭耗时认定请求未发出。`;
    }
    return '';
};

/**
 * 拼出写进调试终端 detail 的那一段。同步、无副作用——no-cors 复检结论由
 * describeReachabilityProbe() 单独产出，异步补到这段后面。
 */
export const buildFetchFailureDetail = (
    ctx: FetchFailureContext,
    opts: { startedAt: number; perf?: { getEntriesByName?: (name: string, type?: string) => any[] }; now?: number },
): string => {
    const { name, message } = readError(ctx.error);
    const kind = classifyFetchFailure(ctx);
    const target = parseTargetUrl(ctx.url);
    const safeUrl = sanitizeUrlForLog(ctx.url);
    const pageOrigin = ctx.pageOrigin ?? (typeof location !== 'undefined' ? location.origin : '');
    const online = ctx.online ?? (typeof navigator !== 'undefined' ? navigator.onLine : true);
    const method = (ctx.method || 'GET').toUpperCase();
    const id = ctx.identity;

    const lines: string[] = [];
    if (id?.source) lines.push(`模块来源: ${id.source}`);
    if (id?.operation && id.operation !== id.source) lines.push(`具体操作: ${id.operation}`);
    if (id?.configSource) lines.push(`配置归属: ${id.configSource}`);
    if (id?.via && id.via !== 'direct' && id.via !== 'same-origin') {
        const viaLabel = id.via === 'amsg-relay'
            ? '主动消息 2.0 大陆中转 (amsg-relay)'
            : id.via === 'proxy-worker'
                ? 'SullyOS 网络代理 Worker'
                : 'MCP 代理转发';
        lines.push(`转发链路: ${viaLabel}${id.upstreamTarget ? ` → ${id.upstreamTarget}` : ''}`);
    }
    if (id?.model) lines.push(`请求模型: ${id.model}`);

    lines.push(`URL: ${safeUrl}`);
    const durationText = typeof ctx.durationMs === 'number' ? ` · 失败于 ${ctx.durationMs}ms` : '';
    lines.push(`请求: ${method}${durationText}`);
    lines.push(`错误: ${name}: ${redactRelayTokensInText(message)}`);
    if (ctx.responseHeadersReceived) {
        const hdr = ctx.responseHeadersReceived;
        const ctText = hdr.contentType ? ` (${hdr.contentType})` : '';
        const upgText = hdr.streamUpgraded ? ' · 透明流式升级传输' : '';
        lines.push(`响应阶段: 已于 ${hdr.headersMs}ms 收到 HTTP ${hdr.status} 响应头${ctText}${upgText}，读取响应正文途中中断`);
    }
    if (target.ok) {
        const crossOrigin = pageOrigin && target.origin !== pageOrigin;
        lines.push(`目标域名: ${target.host}${crossOrigin ? '（跨域请求，受 CORS 约束）' : '（同源）'}`);
    }
    if (pageOrigin) lines.push(`本页来源: ${pageOrigin}`);
    lines.push(`浏览器联网状态: ${online === false ? '离线' : '在线'}`);

    const wasBackgrounded = Boolean(
        ctx.backgroundedDuringRequest
        || ctx.visibilityAtStart === 'hidden'
        || ctx.visibilityAtEnd === 'hidden',
    );
    if (wasBackgrounded) {
        const visRange = (ctx.visibilityAtStart || ctx.visibilityAtEnd)
            ? `（发起时${formatVisibilityLabel(ctx.visibilityAtStart)} → 结束时${formatVisibilityLabel(ctx.visibilityAtEnd)}）`
            : '';
        lines.push(`页面状态: 请求期间进入过后台/锁屏${visRange} → 移动端浏览器（尤其 iOS Safari/PWA）常会在后台挂起或掐断进行中的网络连接`);
    } else if (ctx.visibilityAtStart || ctx.visibilityAtEnd) {
        lines.push(`页面状态: 全程前台 (${ctx.visibilityAtStart || 'visible'} → ${ctx.visibilityAtEnd || 'visible'})`);
    }

    const purpose = ctx.requestPurpose || ctx.explicitMeta?.purpose;
    if (purpose) lines.push(`调用用途: ${purpose}`);
    if (ctx.explicitMeta && (ctx.explicitMeta.appName || ctx.explicitMeta.charName)) {
        const parts = [
            ctx.explicitMeta.appName ? `App=${ctx.explicitMeta.appName}` : '',
            ctx.explicitMeta.charName ? `角色=${ctx.explicitMeta.charName}` : '',
        ].filter(Boolean);
        lines.push(`调用归属: ${parts.join(' · ')}（调用点显式标记）`);
    } else if (ctx.ambientMeta && (ctx.ambientMeta.appName || ctx.ambientMeta.charName)) {
        const parts = [
            ctx.ambientMeta.appName ? `界面=${ctx.ambientMeta.appName}` : '',
            ctx.ambientMeta.charName ? `当前角色=${ctx.ambientMeta.charName}` : '',
        ].filter(Boolean);
        lines.push(`当时前台状态: ${parts.join(' · ')}（未显式传归属，可能是后台自动任务）`);
    }
    if (ctx.caller) {
        lines.push(`调用入口: ${ctx.caller}`);
    }

    if (ctx.requestSummary) {
        const requestParts = [`${ctx.requestSummary.bodyBytes} bytes`];
        if (typeof ctx.requestSummary.messageCount === 'number') requestParts.push(`messages=${ctx.requestSummary.messageCount}`);
        if (typeof ctx.requestSummary.contentChars === 'number') requestParts.push(`消息内容=${ctx.requestSummary.contentChars} 字符`);
        if (typeof ctx.requestSummary.lastMessageRole) requestParts.push(`末条 role=${ctx.requestSummary.lastMessageRole}`);
        if (typeof ctx.requestSummary.stream === 'boolean') requestParts.push(`stream=${ctx.requestSummary.stream}`);
        lines.push(`请求体摘要: ${requestParts.join(' · ')}`);
        if (ctx.requestSummary.optionalParams?.length) {
            lines.push(`额外参数: ${ctx.requestSummary.optionalParams.join(', ')}`);
        }
    }
    if (!ctx.responseHeadersReceived) {
        const timing = readResourceTimingHint(target.href, { startedAt: opts.startedAt, perf: opts.perf });
        if (timing) lines.push(timing);
    }
    const stall = readStallHint(ctx.durationMs, kind);
    if (stall) lines.push(stall);
    const now = opts.now ?? Date.now();
    const recentSuccess = ctx.recentSuccessfulSameRequest;
    const successAgeMs = recentSuccess ? now - recentSuccess.timestamp : Number.POSITIVE_INFINITY;
    const hasRecentSameRequestSuccess = kind === 'blocked'
        && successAgeMs >= 0
        && successAgeMs <= 10 * 60 * 1000;
    if (hasRecentSameRequestSuccess && recentSuccess) {
        const ageSeconds = Math.max(1, Math.round(successAgeMs / 1000));
        lines.push(`同接口对照: ${ageSeconds} 秒前，同一个 ${method} 已成功返回 HTTP ${recentSuccess.status}`);
        lines.push('初判: 同一接口刚刚成功过，基本排除域名整体不可达、DNS 错误或代理把整个域名拦掉；这是当前请求/响应特有的失败。');
        if (purpose === '剧情见面生成') {
            lines.push('更可能原因: 剧情上下文或请求体更大 · 服务商不接受末条 assistant 预填充或额外参数 · 上游生成/流式传输中途断开 · 上游错误页漏了 CORS 响应头');
        } else {
            lines.push('更可能原因: 当前请求体或响应与刚才成功的请求不同 · 上游限流或临时故障 · 生成/传输中途断开 · 上游错误页漏了 CORS 响应头');
        }
    } else if (kind === 'blocked' && wasBackgrounded) {
        lines.push('初判: 请求期间页面进入过后台或锁屏，移动端浏览器大概率直接挂起并切断了这条连接；其次才是代理/跨域问题。');
        lines.push(`可能原因: 切后台/锁屏导致浏览器中断连接（优先保持前台重试一次） · ${VERDICTS.blocked.causes}`);
    } else {
        lines.push(`初判: ${VERDICTS[kind].verdict}`);
        lines.push(`可能原因: ${VERDICTS[kind].causes}`);
    }
    if (id?.impactHint) {
        lines.push(`影响范围: ${id.impactHint}`);
    }
    return lines.join('\n');
};

// ─── no-cors 连通性复检 ───

export type ReachabilityVerdict = 'reachable' | 'unreachable' | 'timeout' | 'cooldown' | 'skipped';

/**
 * 只有「拿不到响应」和「超时」两类值得复检：
 * 主动取消 / 混合内容 / 地址非法 / 离线 都已经有确定结论，再打一次纯属浪费。
 */
export const shouldProbeReachability = (kind: FetchFailureKind): boolean => (
    kind === 'blocked' || kind === 'timeout' || kind === 'unknown'
);

/** 同一个域名 30s 内只复检一次，避免一串请求同时炸时打出一片探测流量。 */
const probeCooldown = new Map<string, number>();
const PROBE_COOLDOWN_MS = 30_000;

export const resetReachabilityProbeCooldown = () => probeCooldown.clear();

/**
 * 用 no-cors 打一次目标域名的根路径，只为回答一个问题：这台设备到底能不能碰到这个域名。
 *
 * - 打根路径而不是原地址：原地址可能是有副作用的接口（下单、发消息），复检不该顺手触发它；
 *   而 DNS / 梯子 / 防火墙 / 扩展这几层拦的都是整个域名，打根路径一样能测出来。
 * - no-cors 拿到的是 opaque 响应，读不出状态码——但「拿到了」本身就是结论。
 */
export const probeOriginReachability = async (
    url: string,
    fetchImpl: typeof fetch,
    opts?: { timeoutMs?: number; now?: () => number },
): Promise<ReachabilityVerdict> => {
    const target = parseTargetUrl(url);
    if (!target.ok || !target.origin || target.origin === 'null') return 'skipped';

    const now = opts?.now ?? (() => Date.now());
    const last = probeCooldown.get(target.origin);
    const at = now();
    if (typeof last === 'number' && at - last < PROBE_COOLDOWN_MS) return 'cooldown';
    probeCooldown.set(target.origin, at);

    const timeoutMs = opts?.timeoutMs ?? 6000;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
        await fetchImpl(`${target.origin}/`, {
            method: 'GET',
            mode: 'no-cors',
            cache: 'no-store',
            credentials: 'omit',
            redirect: 'follow',
            signal: controller?.signal,
        });
        return 'reachable';
    } catch (e) {
        const { name } = readError(e);
        return name === 'AbortError' ? 'timeout' : 'unreachable';
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
};

/** 把复检结论翻成给人看的一句话 + 下一步该往哪查。 */
export const describeReachabilityProbe = (verdict: ReachabilityVerdict, host: string, method = 'GET'): string => {
    const who = host || '该域名';
    switch (verdict) {
        case 'reachable':
            return `连通性复检: no-cors 直连 ${who} 成功 → 只能确认这个域名当前可达，不能确认原文件或接口可用；原 ${method.toUpperCase()} 可能被网关关闭、链接失效，或因响应缺少 CORS 头而被浏览器拦截。`
                + (method.toUpperCase() === 'POST' ? '上游若已开始生成，即使页面显示失败也可能计费；请先核对服务商日志，不要连续重发。' : '资源加载失败不等于生成失败；请检查原资源链接的有效期及响应头。');
        case 'unreachable':
            return `连通性复检: no-cors 直连 ${who} 同样失败 → 这台设备到 ${who} 是真的连不上。按顺序查：梯子的分流规则（把该域名放进代理）、DNS、浏览器扩展（广告拦截/隐私盾）、系统或路由器防火墙。`;
        case 'timeout':
            return `连通性复检: no-cors 直连 ${who} 超时（连接挂住不返回）→ 多半是代理/网关把连接吞了，或对方正被限速。优先换一个梯子节点再试。`;
        case 'cooldown':
            return `连通性复检: 30 秒内已对 ${who} 检测过，结论看这条之前那一条日志（同一次故障刷出来的多条，复检结果是一样的）。`;
        default:
            return '';
    }
};

/** 给调试终端用的通用自查清单——网络类错误一律先照这个走一遍。 */
export const NETWORK_SELF_CHECK_STEPS: string[] = [
    '换一个梯子节点，或先关掉梯子直连试一次——两种都失败才说明不是线路问题',
    '把浏览器扩展（广告拦截、隐私盾、脚本管理器）全禁掉再试，或换用无痕窗口',
    '在新标签页直接打开日志里那个 URL：能出 JSON 说明网络通，是页面这边的跨域被拦；打不开就是线路/DNS 的事',
    '换一个浏览器或换手机热点各试一次，能定位到是「这台设备」还是「这个网络」',
    '如果只有部分功能报错，去设置里看对应的服务地址是不是填错了（少 https://、多空格、多结尾斜杠）',
];

/**
 * 终端顶部是否展示「网络连接失败？按这个顺序自查」折叠卡片：
 * 只在确实存在连接层失败（不含 HTTP 4xx/5xx 业务报错与主动取消）时展示。
 * 兼容旧结构（没有 `context.failureKind` 时回退认 `source === 'Network'`）。
 */
export const shouldShowNetworkSelfCheck = (logs: SystemLog[]): boolean => logs.some((log) => {
    if (log.type !== 'network') return false;
    const kind = log.context?.failureKind;
    if (kind) return kind !== 'http-status' && kind !== 'aborted';
    return log.source === 'Network';
});

const RELAY_ERROR_DESCRIPTIONS: Record<string, string> = {
    unofficial_client: '当前来源不是官方网址或官方签名 APK，官方中转拒绝放行（403）',
    invalid_token: '中转令牌无效、超过 30 天未用或已在群里重置，请重新复制粘贴令牌（401）',
    not_relayable: '请求目标或接口路径不在主动消息 2.0 中转白名单内',
    rate_limited: '触发中转请求频率限制，请稍后重试（429）',
    quota_exceeded: '今日经中转流量已超过单账号 1 GB 上限（429）',
    upstream_unreachable: '中转服务器连不上你的 Cloudflare Worker，请检查 Worker 地址是否正确（502）',
};

/**
 * 判断哪些非 2xx HTTP 响应应当主动写进 `systemLogs`（点亮顶部 SYSTEM ERROR）：
 * - 对话模型（OpenAI `/chat/completions`、Anthropic `/messages`、`/models`）、Embedding、Rerank：任何非 2xx 都是明确报错；
 * - 主动消息 2.0 大陆中转明确返回 `X-Amsg-Relay-Error` 或网关级错误（401/403/429/5xx）：用户很难从表象分辨是中转还是 Worker 拒了，直接记上；
 * - 其它接口（如 WebDAV PROPFIND 404 探目录、GitHub 404 探文件、MiniMax 本地代理 404 回退）属于正常控制流，不误报。
 */
export const shouldLogHttpStatusError = (input: {
    status: number;
    identity: NetworkRequestIdentity;
    relayErrorCode?: string;
}): boolean => {
    const { category, via } = input.identity;
    if (category === 'llm' || category === 'embedding' || category === 'rerank') return true;
    if (input.relayErrorCode) return true;
    if (via === 'amsg-relay' && (input.status === 401 || input.status === 403 || input.status === 429 || input.status >= 500)) {
        return true;
    }
    return false;
};

const extractShortHttpErrorMessage = (responseText: string | undefined, status: number): string => {
    const trimmed = (responseText || '').trim();
    if (!trimmed) return `HTTP ${status}`;
    if (trimmed.startsWith('<')) {
        const titleMatch = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim();
        return title ? `HTML 错误页 (${title.slice(0, 80)})` : `HTML 错误页`;
    }
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            const err = parsed?.error;
            if (typeof err === 'string' && err.trim()) return err.trim().slice(0, 140);
            if (err && typeof err === 'object') {
                const msg = typeof err.message === 'string' ? err.message.trim() : '';
                const code = err.code != null ? String(err.code).trim() : '';
                const type = typeof err.type === 'string' ? err.type.trim() : '';
                const tag = [code, type && type !== code ? type : ''].filter(Boolean).join('/');
                if (msg) return `${msg}${tag ? ` [${tag}]` : ''}`.slice(0, 160);
                if (tag) return tag;
            }
            const top = [parsed?.message, parsed?.msg, parsed?.detail]
                .find(v => typeof v === 'string' && v.trim()) as string | undefined;
            if (top) return top.trim().slice(0, 140);
        } catch { /* 非标准 JSON 原样截断 */ }
    }
    return trimmed.replace(/\s+/g, ' ').slice(0, 140);
};

const buildAttributionContext = (
    explicitMeta?: ApiCallMeta,
    ambientMeta?: ApiCallMeta,
): Pick<SystemLogContext, 'attributionMode' | 'appName' | 'charName' | 'purpose'> => {
    const hasExplicit = Boolean(
        explicitMeta && Object.values(explicitMeta).some(v => v != null && v !== ''),
    );
    if (hasExplicit && explicitMeta) {
        return {
            attributionMode: 'explicit',
            ...(explicitMeta.appName ? { appName: explicitMeta.appName } : {}),
            ...(explicitMeta.charName ? { charName: explicitMeta.charName } : {}),
            ...(explicitMeta.purpose ? { purpose: explicitMeta.purpose } : {}),
        };
    }
    if (ambientMeta && (ambientMeta.appName || ambientMeta.charName)) {
        return {
            attributionMode: 'ambient',
            ...(ambientMeta.appName ? { appName: ambientMeta.appName } : {}),
            ...(ambientMeta.charName ? { charName: ambientMeta.charName } : {}),
        };
    }
    return {};
};

export interface BuildFetchFailureSystemLogInput {
    identity?: NetworkRequestIdentity;
    id?: string;
    timestamp?: number;
    url: string;
    method?: string;
    headers?: HeadersInit;
    body?: unknown;
    durationMs?: number;
    error: unknown;
    startedAtPerf: number;
    explicitMeta?: ApiCallMeta;
    ambientMeta?: ApiCallMeta;
    visibilityAtStart?: string;
    visibilityAtEnd?: string;
    backgroundedDuringRequest?: boolean;
    caller?: string;
    responseHeadersReceived?: ReceivedResponseHeadersInfo;
    recentSuccessfulSameRequest?: { timestamp: number; status: number };
    advice?: { title: string; action: string };
    endpoints?: ConfiguredEndpointSnapshot;
    pageOrigin?: string;
    pageProtocol?: string;
    online?: boolean;
    perf?: { getEntriesByName?: (name: string, type?: string) => any[] };
}

export const buildFetchFailureSystemLog = (input: BuildFetchFailureSystemLogInput): {
    log: SystemLog;
    kind: FetchFailureKind;
    identity: NetworkRequestIdentity;
} => {
    const ts = input.timestamp ?? Date.now();
    const id = input.id || `log-${ts}-${Math.random().toString(36).slice(2, 8)}`;
    const method = (input.method || 'GET').toUpperCase();
    const identity = input.identity ?? identifyNetworkRequestSource({
        url: input.url,
        method,
        headers: input.headers,
        body: input.body,
        explicitMeta: input.explicitMeta,
        ambientMeta: input.ambientMeta,
        pageOrigin: input.pageOrigin,
        endpoints: input.endpoints,
    });

    const wasBackgrounded = Boolean(
        input.backgroundedDuringRequest
        || input.visibilityAtStart === 'hidden'
        || input.visibilityAtEnd === 'hidden',
    );
    const diagCtx: FetchFailureContext = {
        url: input.url,
        method,
        durationMs: input.durationMs,
        error: input.error,
        online: input.online,
        pageOrigin: input.pageOrigin,
        pageProtocol: input.pageProtocol,
        requestSummary: summarizeFetchRequestBody(input.body),
        requestPurpose: input.explicitMeta?.purpose,
        explicitMeta: input.explicitMeta,
        ambientMeta: input.ambientMeta,
        identity,
        visibilityAtStart: input.visibilityAtStart,
        visibilityAtEnd: input.visibilityAtEnd,
        backgroundedDuringRequest: wasBackgrounded,
        caller: input.caller,
        responseHeadersReceived: input.responseHeadersReceived,
        recentSuccessfulSameRequest: input.recentSuccessfulSameRequest,
    };

    const kind = classifyFetchFailure(diagCtx);
    const safeUrl = sanitizeUrlForLog(input.url);
    const parsedTarget = parseTargetUrl(safeUrl);
    const detail = buildFetchFailureDetail(diagCtx, {
        startedAt: input.startedAtPerf,
        perf: input.perf,
        now: ts,
    });

    const context: SystemLogContext = {
        build: readCompactBuildString(),
        category: identity.category,
        failureKind: kind,
        ...(identity.operation ? { operation: identity.operation } : {}),
        method,
        url: safeUrl,
        ...(parsedTarget.host ? { host: parsedTarget.host } : {}),
        via: identity.via,
        ...(identity.upstreamTarget ? { upstreamTarget: identity.upstreamTarget } : {}),
        ...(identity.configSource ? { configSource: identity.configSource } : {}),
        ...(identity.model ? { model: identity.model } : {}),
        ...(input.responseHeadersReceived ? {
            httpStatus: input.responseHeadersReceived.status,
            headersMs: input.responseHeadersReceived.headersMs,
        } : {}),
        ...(typeof input.durationMs === 'number' ? { durationMs: input.durationMs } : {}),
        ...buildAttributionContext(input.explicitMeta, input.ambientMeta),
        ...(input.visibilityAtStart || input.visibilityAtEnd
            ? { visibility: `${input.visibilityAtStart || 'unknown'} -> ${input.visibilityAtEnd || 'unknown'}` }
            : {}),
        backgroundedDuringRequest: wasBackgrounded,
        ...(input.caller ? { caller: input.caller } : {}),
    };

    const resolvedAdvice = input.advice ?? buildIdentityErrorAdvice({
        identity,
        failureKind: kind,
        backgroundedDuringRequest: wasBackgrounded,
    });

    return {
        kind,
        identity,
        log: {
            ...(resolvedAdvice ? { advice: resolvedAdvice } : {}),
            id,
            timestamp: ts,
            time: formatDiagnosticTimestamp(ts),
            type: 'network',
            source: identity.source,
            message: formatFetchFailureHeadline(diagCtx),
            context,
            detail,
        },
    };
};

export interface BuildHttpErrorSystemLogInput {
    id?: string;
    timestamp?: number;
    url: string;
    method?: string;
    headers?: HeadersInit;
    body?: unknown;
    status: number;
    responseText?: string;
    unreadableBody?: boolean;
    relayErrorCode?: string;
    durationMs?: number;
    explicitMeta?: ApiCallMeta;
    ambientMeta?: ApiCallMeta;
    caller?: string;
    identity?: NetworkRequestIdentity;
    advice?: { title: string; action: string };
    endpoints?: ConfiguredEndpointSnapshot;
    pageOrigin?: string;
}

export const buildHttpErrorSystemLog = (input: BuildHttpErrorSystemLogInput): SystemLog => {
    const ts = input.timestamp ?? Date.now();
    const id = input.id || `log-${ts}-${Math.random().toString(36).slice(2, 8)}`;
    const method = (input.method || 'GET').toUpperCase();
    const identity = input.identity ?? identifyNetworkRequestSource({
        url: input.url,
        method,
        headers: input.headers,
        body: input.body,
        explicitMeta: input.explicitMeta,
        ambientMeta: input.ambientMeta,
        pageOrigin: input.pageOrigin,
        endpoints: input.endpoints,
    });
    const safeUrl = sanitizeUrlForLog(input.url);
    const parsedTarget = parseTargetUrl(safeUrl);
    const displayHost = identity.via === 'amsg-relay' && identity.upstreamTarget
        ? `中转→${identity.upstreamTarget}`
        : (parsedTarget.host || safeUrl);

    const relayNote = input.relayErrorCode
        ? (RELAY_ERROR_DESCRIPTIONS[input.relayErrorCode] || `中转错误码 ${input.relayErrorCode}`)
        : '';
    const shortErr = input.unreadableBody
        ? '响应体无法读取'
        : redactRelayTokensInText(relayNote || extractShortHttpErrorMessage(input.responseText, input.status));
    const modelPart = identity.model ? ` · ${identity.model}` : '';
    const durPart = typeof input.durationMs === 'number' ? ` · ${input.durationMs}ms` : '';

    const detailLines: string[] = [];
    detailLines.push(`模块来源: ${identity.source}`);
    if (identity.operation && identity.operation !== identity.source) detailLines.push(`具体操作: ${identity.operation}`);
    if (identity.configSource) detailLines.push(`配置归属: ${identity.configSource}`);
    detailLines.push(`URL: ${safeUrl}`);
    detailLines.push(`请求: ${method} → HTTP ${input.status}${durPart}`);
    if (input.relayErrorCode) {
        detailLines.push(`中转错误码: ${input.relayErrorCode}（${relayNote}）`);
    }
    if (input.explicitMeta && (input.explicitMeta.appName || input.explicitMeta.charName || input.explicitMeta.purpose)) {
        const parts = [
            input.explicitMeta.appName ? `App=${input.explicitMeta.appName}` : '',
            input.explicitMeta.purpose ? `用途=${input.explicitMeta.purpose}` : '',
            input.explicitMeta.charName ? `角色=${input.explicitMeta.charName}` : '',
        ].filter(Boolean);
        detailLines.push(`调用归属: ${parts.join(' · ')}（调用点显式标记）`);
    } else if (input.ambientMeta && (input.ambientMeta.appName || input.ambientMeta.charName)) {
        const parts = [
            input.ambientMeta.appName ? `界面=${input.ambientMeta.appName}` : '',
            input.ambientMeta.charName ? `当前角色=${input.ambientMeta.charName}` : '',
        ].filter(Boolean);
        detailLines.push(`当时前台状态: ${parts.join(' · ')}（未显式传归属，可能是后台自动任务）`);
    }
    if (input.caller) detailLines.push(`调用入口: ${input.caller}`);

    if (!input.unreadableBody && input.responseText !== undefined) {
        detailLines.push(`Response: ${redactRelayTokensInText(input.responseText).slice(0, 600)}`);
    }

    if (typeof input.body === 'string' && input.body.trim().startsWith('{')) {
        try {
            const j = JSON.parse(input.body);
            if (Array.isArray(j.messages)) {
                const toolNames = Array.isArray(j.tools) ? j.tools.map((t: any) => t?.function?.name || t?.name).filter(Boolean) : [];
                const roles = j.messages.map((m: any) => m.role + (m.tool_calls ? '(tool_calls)' : '')).join(',');
                detailLines.push(
                    `--- Request ---\nmodel: ${j.model}\ntemperature: ${j.temperature} | top_p: ${j.top_p} | reasoning_effort: ${j.reasoning_effort} | thinking: ${j.thinking ? 'on' : 'off'}\ntools(${toolNames.length}): ${toolNames.join(', ')}\nmessages(${j.messages.length}) roles: ${roles}`,
                );
            } else if (j.model || Array.isArray(j.input)) {
                const batchLen = Array.isArray(j.input) ? j.input.length : (typeof j.input === 'string' ? 1 : undefined);
                detailLines.push(
                    `--- Request ---\nmodel: ${j.model || 'unknown'}${batchLen != null ? ` | inputCount: ${batchLen}` : ''}${j.dimensions ? ` | dimensions: ${j.dimensions}` : ''}`,
                );
            }
        } catch { /* ignore */ }
    }

    if (identity.impactHint) {
        detailLines.push(`影响范围: ${identity.impactHint}`);
    }

    const context: SystemLogContext = {
        build: readCompactBuildString(),
        category: identity.category,
        failureKind: 'http-status',
        httpStatus: input.status,
        ...(identity.operation ? { operation: identity.operation } : {}),
        method,
        url: safeUrl,
        ...(parsedTarget.host ? { host: parsedTarget.host } : {}),
        via: identity.via,
        ...(identity.upstreamTarget ? { upstreamTarget: identity.upstreamTarget } : {}),
        ...(identity.configSource ? { configSource: identity.configSource } : {}),
        ...(identity.model ? { model: identity.model } : {}),
        ...(typeof input.durationMs === 'number' ? { durationMs: input.durationMs } : {}),
        ...buildAttributionContext(input.explicitMeta, input.ambientMeta),
        ...(input.caller ? { caller: input.caller } : {}),
    };

    const resolvedAdvice = input.advice
        ?? (input.relayErrorCode && relayNote
            ? { title: `${identity.source} 请求被拒`, action: relayNote }
            : buildIdentityErrorAdvice({ identity, failureKind: 'http-status', status: input.status }));

    return {
        ...(resolvedAdvice ? { advice: resolvedAdvice } : {}),
        id,
        timestamp: ts,
        time: formatDiagnosticTimestamp(ts),
        type: 'network',
        source: identity.source,
        message: `HTTP ${input.status} (${displayHost}${modelPart}): ${shortErr}${durPart}`,
        context,
        detail: detailLines.join('\n'),
    };
};

/** A caller with known attribution can supply a safe message for the self-check and its export. */
export class ApplicationErrorReport {
    constructor(
        readonly source: string,
        readonly advice: NonNullable<SystemLog['advice']>,
        readonly context: SystemLogContext,
    ) {}
    toString() { return this.advice.title + '\n' + this.advice.action; }
}

export const buildConsoleErrorSystemLog = (input: {
    id?: string;
    timestamp?: number;
    message: string;
    stacks?: string;
    caller?: string;
    ambientMeta?: ApiCallMeta;
    report?: ApplicationErrorReport;
    advice?: { title: string; action: string };
}): SystemLog => {
    const ts = input.timestamp ?? Date.now();
    const id = input.id || `log-${ts}-${Math.random().toString(36).slice(2, 8)}`;
    const source = input.report?.source ?? identifyApplicationErrorSource(input.message, input.ambientMeta, input.caller);
    const detailParts: string[] = [];
    if (!input.report && input.ambientMeta && (input.ambientMeta.appName || input.ambientMeta.charName)) {
        const where = [
            input.ambientMeta.appName ? `界面=${input.ambientMeta.appName}` : '',
            input.ambientMeta.charName ? `当前角色=${input.ambientMeta.charName}` : '',
        ].filter(Boolean).join(' · ');
        detailParts.push(`当时前台状态: ${where}`);
    }
    if (input.caller) {
        detailParts.push(`调用入口: ${input.caller}`);
    }
    const safeMessage = redactRelayTokensInText(input.message);
    const safeStacks = input.stacks ? redactRelayTokensInText(input.stacks) : undefined;
    detailParts.push(safeStacks || safeMessage);

    return {
        advice: input.report?.advice ?? input.advice,
        id,
        timestamp: ts,
        time: formatDiagnosticTimestamp(ts),
        type: 'error',
        source,
        message: safeMessage.slice(0, 160),
        context: {
            build: readCompactBuildString(),
            failureKind: 'console-error',
            ...(input.report?.context ?? buildAttributionContext(undefined, input.ambientMeta)),
            ...(input.caller ? { caller: input.caller } : {}),
        },
        detail: detailParts.join('\n'),
    };
};
