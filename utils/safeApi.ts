/**
 * Safe API response parsing utilities.
 *
 * Prevents "Unexpected token <" crashes that happen when API proxies
 * return HTML error pages (CloudFlare, nginx 502/503, rate limits)
 * instead of JSON responses.
 */

// 同时挂两套日志：
//   - devDebug 的 api 类目（开发者勾「API」复制 / 下载导出）
//   - 全局 fetch 拦截器 + apiCallLog（用户在「设置 → API 调用记录」里看）
// 后者的 meta 通过下面 safeFetchJson 的第 5 个参数挂到 __sullyMeta 上传出去。
import { appendDevDebugApiLog, makeDebugLogger } from './devDebug';
import { getApiCallAmbientContext, recordApiCall, type ApiCallMeta } from './apiCallLog';
import { resolveBlobRefsInRequestBody } from './apiBlobRefs';
import { waitForPalaceRequest } from './memoryPalace/maintenanceMode';
import { fetchLlm } from './anthropicApi';
import { isAnthropicEndpoint } from './llmEndpoint';

const log = makeDebugLogger('api', 'SafeAPI');

export function isChatCompletionUrl(url: string): boolean {
    return url.includes('/chat/completions') || isAnthropicEndpoint(url);
}

/** Parse a fetch Response as JSON safely (text-first, then JSON.parse) */
export async function safeResponseJson(response: Response): Promise<any> {
    const text = await response.text();
    return parseRawBodyText(text, response.status, response.headers.get('content-type'));
}

/** 判断响应是否是 SSE；兼容 OpenRouter 在首个 data 事件前发送的 ": OPENROUTER PROCESSING" 注释。 */
export function isSseResponseText(text: string, contentType?: string | null): boolean {
    const firstLine = text
        .split(/\r?\n/)
        .map(line => line.trimStart())
        .find(line => line.length > 0) || '';
    const hasSseField = firstLine.startsWith('data:')
        || firstLine.startsWith(':')
        || firstLine.startsWith('event:')
        || firstLine.startsWith('id:')
        || firstLine.startsWith('retry:');
    if (hasSseField) return true;
    // 个别代理会把整包 JSON 错标成 text/event-stream；明确的 JSON/HTML 起始符优先。
    if (/^[{["<]/.test(firstLine)) return false;
    return contentType?.toLowerCase().includes('text/event-stream') === true;
}

/** safeResponseJson 的纯文本内核：HTML/空响应/SSE/JSON 判定与解析（流式路径复用） */
function parseRawBodyText(text: string, status: number, contentType?: string | null): any {
    // Detect HTML / XML responses
    const trimmed = text.trimStart();
    if (trimmed.startsWith('<')) {
        // Extract useful info from HTML error pages
        const titleMatch = trimmed.match(/<title>(.*?)<\/title>/i);
        const hint = titleMatch ? titleMatch[1] : trimmed.slice(0, 120);
        throw new Error(
            `API返回了HTML而非JSON (HTTP ${status}): ${hint}`
        );
    }

    // Empty body
    if (!trimmed) {
        throw new Error(`API返回了空响应 (HTTP ${status})`);
    }

    // SSE / 流式响应（有些 OpenAI 兼容代理无视 stream:false 强行流式返回）：
    // 注释/心跳行（以 ":" 开头）由 SseAssembler 忽略，data 事件照常拼成完整 content。
    if (isSseResponseText(text, contentType)) {
        const assembled = parseSseToCompletion(text);
        if (assembled) return assembled;
        const preview = text.slice(0, 200);
        throw new Error(
            `API流式响应未返回有效数据 (HTTP ${status}): ${preview}`
        );
    }

    try {
        return JSON.parse(text);
    } catch (e) {
        // Show a snippet of what we got for debugging
        const preview = text.slice(0, 200);
        throw new Error(
            `API返回了无效JSON (HTTP ${status}): ${preview}`
        );
    }
}

/**
 * 把 OpenAI 兼容的 SSE 流响应合成一个普通 chat/completion 响应对象。
 *
 * 支持两种形态：
 *  1. delta 流：每个 chunk 的 choices[0].delta.content 是增量片段，拼接起来
 *  2. 一次性 SSE：choices[0].message.content 直接就是全部内容（少见）
 *
 * 返回 { choices: [{ message: { content, role }, finish_reason }], ... } 方便上游
 * 用现有的 data.choices[0].message.content 路径消费，无需改调用点。
 */
export function parseSseToCompletion(raw: string): any | null {
    const asm = new SseAssembler();
    // 按行切，逐行找 "data: " 开头（允许 \r\n、空行分隔）
    for (const line of raw.split(/\r?\n/)) asm.feedLine(line);
    return asm.finish();
}

/**
 * OpenAI 兼容 SSE 流的增量拼装器。
 * feedLine 逐行喂入（分别返回本行的正文与思考增量），finish 合成完整 completion 对象。
 * parseSseToCompletion（整包路径）和 readBodyWithStreaming（真流式路径）共用这一份，
 * 保证两条路对 delta / message / tool_calls 分片的处理完全一致。
 */
interface SseFeedDelta {
    content: string;
    reasoning: string;
    /** The provider has explicitly finished this completion. */
    done: boolean;
}

class SseAssembler {
    private anthropicContent: any[] | undefined;
    private anthropicThinking: any[] | undefined;
    content = '';
    private role = 'assistant';
    private finishReason: string | null = null;
    private firstChunk: any = null;
    private usage: any = undefined;
    private gotAnyChunk = false;
    // tool_calls 流式分片: OpenAI 约定按 index 分组, id/name 在首片, arguments 逐片拼接。
    // 不拼的话开了 stream 的工具模式(瑞幸/MCP)会静默丢掉全部工具调用。
    private toolCalls: any[] = [];
    // 思考通道: DeepSeek/Gemini 系走 delta.reasoning_content, OpenRouter 走 delta.reasoning,
    // 部分 Claude 官转(CC 渠道)走 delta.thinking 或分块 content(数组里 type:'thinking')。
    // 丢掉它 = 开思考链的角色"不出思维链"(后处理从 message.reasoning_content 抽取),
    // 且 extractContent / extractAssistantText 的 reasoning 兜底全部失效(思考模型把全部
    // 输出塞进 reasoning 时表现为空回复→重试→巨慢)。2026-07 全局流式上线后被放大成必现。
    private reasoning = '';
    // 取证探针: 记录本条流里 delta 出现过的字段名。渠道的思考字段形状五花八门,
    // 与其一轮一轮猜, 不如把名单打出来(finish() 附带 + 控制台一行)一次看清。
    private deltaKeys = new Set<string>();

    /** 喂一行 SSE 文本，分别返回正文与思考增量（没有则为空串）。 */
    feedLine(line: string): SseFeedDelta {
        if (!line.startsWith('data:')) return { content: '', reasoning: '', done: false };
        const payload = line.slice(5).trim();
        if (!payload) return { content: '', reasoning: '', done: false };
        if (payload === '[DONE]') return { content: '', reasoning: '', done: true };
        let chunk: any;
        try { chunk = JSON.parse(payload); } catch { return { content: '', reasoning: '', done: false }; }
        return this.feedChunk(chunk);
    }

    feedChunk(chunk: any): SseFeedDelta {
        this.gotAnyChunk = true;
        if (!this.firstChunk) this.firstChunk = chunk;
        // OpenAI 流式 usage 在最后一个 chunk（include_usage=true 时），也可能出现在中途；
        // 始终取最后一个非空的 usage，兼容各家代理。
        if (chunk.usage) this.usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) return { content: '', reasoning: '', done: false };
        let delta = '';
        let reasoningDelta = '';
        // delta 路径（OpenAI 流式常见）
        if (choice.delta) {
            if (Array.isArray(choice.delta.anthropic_content)) this.anthropicContent = choice.delta.anthropic_content;
            if (Array.isArray(choice.delta.anthropic_thinking)) this.anthropicThinking = choice.delta.anthropic_thinking;
            for (const k of Object.keys(choice.delta)) this.deltaKeys.add(k);
            if (typeof choice.delta.content === 'string') {
                delta = choice.delta.content;
                this.content += delta;
            }
            // Anthropic 透传形态: delta.content 是分块数组 [{type:'text',text}|{type:'thinking',thinking}]
            else if (Array.isArray(choice.delta.content)) {
                for (const block of choice.delta.content) {
                    if (block?.type === 'text' && typeof block.text === 'string') {
                        delta += block.text;
                        this.content += block.text;
                    } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
                        this.reasoning += block.thinking;
                        reasoningDelta += block.thinking;
                    }
                }
            }
            const dr = choice.delta.reasoning_content ?? choice.delta.reasoning ?? choice.delta.thinking;
            if (typeof dr === 'string') {
                this.reasoning += dr;
                reasoningDelta += dr;
            }
            if (choice.delta.role) this.role = choice.delta.role;
            if (Array.isArray(choice.delta.tool_calls)) {
                for (const frag of choice.delta.tool_calls) {
                    const idx = frag.index ?? 0;
                    if (!this.toolCalls[idx]) this.toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                    if (frag.id) this.toolCalls[idx].id = frag.id;
                    if (frag.type) this.toolCalls[idx].type = frag.type;
                    if (frag.function?.name) this.toolCalls[idx].function.name += frag.function.name;
                    if (frag.function?.arguments) this.toolCalls[idx].function.arguments += frag.function.arguments;
                }
            }
        }
        // message 路径（一次性 SSE，不常见但兼容）
        else if (choice.message) {
            if (typeof choice.message.content === 'string') {
                delta = choice.message.content;
                this.content += delta;
            }
            const mr = choice.message.reasoning_content ?? choice.message.reasoning ?? choice.message.thinking;
            if (typeof mr === 'string') {
                this.reasoning += mr;
                reasoningDelta += mr;
            }
            if (choice.message.role) this.role = choice.message.role;
            if (Array.isArray(choice.message.tool_calls)) this.toolCalls.push(...choice.message.tool_calls);
        }
        if (choice.finish_reason) this.finishReason = choice.finish_reason;
        return { content: delta, reasoning: reasoningDelta, done: Boolean(choice.finish_reason) };
    }

    get reasoningContent(): string {
        return this.reasoning;
    }

    finish(): any | null {
        if (!this.gotAnyChunk) return null;
        // 取证探针: 思考没抓到时把渠道实际用的 delta 字段名单打出来, 下一轮排查直接看名单。
        // (开思考的请求思考却为空 = 大概率又是没见过的字段形状)
        if (!this.reasoning && this.deltaKeys.size > 0) {
            console.log(`🔎 [SSE] 本条流的 delta 字段: ${[...this.deltaKeys].join(', ')}${this.content ? '' : ' (且正文为空!)'}`);
        }
        // 合成兼容结构
        return {
            id: this.firstChunk?.id || 'sse-assembled',
            object: 'chat.completion',
            created: this.firstChunk?.created || Math.floor(Date.now() / 1000),
            model: this.firstChunk?.model || '',
            choices: [{
                index: 0,
                message: {
                    role: this.role,
                    content: this.content,
                    ...(this.reasoning ? { reasoning_content: this.reasoning } : {}),
                    ...(this.anthropicThinking ? { anthropic_thinking: this.anthropicThinking } : {}),
                    ...(this.anthropicContent ? { anthropic_content: this.anthropicContent } : {}),
                    ...(this.toolCalls.length ? {
                        tool_calls: this.toolCalls.filter(Boolean).map((tc, i) => ({ ...tc, id: tc.id || `call_sse_${i}` })),
                    } : {}),
                },
                finish_reason: this.finishReason,
            }],
            usage: this.usage || this.firstChunk?.usage,
        };
    }
}

/** safeFetchJson 的可选流式钩子（只在响应确实是 SSE 流时触发） */
export interface StreamHooks {
    /**
     * 每收到一段正文增量时回调。fullText 是**本次尝试**累计的完整正文——
     * safeFetchJson 内部重试会重新开一条流，fullText 从空串重新累计，
     * 调用方每次都应基于 fullText 全量重算（天然处理重试重置）。
     */
    onDelta?: (delta: string, fullText: string) => void;
    /** 每收到一段原生 reasoning 增量时回调；渠道不发送 reasoning 时不会触发。 */
    onReasoningDelta?: (delta: string, fullReasoning: string) => void;
    /** 收到第一个正文增量时回调一次（TTFT 参考点） */
    onFirstDelta?: () => void;
}

/**
 * 真·流式读取响应体：边到边解析 SSE 行并回调 onDelta。
 * 支持 data 事件前先到达的 SSE 注释/心跳；代理无视 stream:true 返回整包 JSON / HTML
 * 错误页时，自动退化为累积全文后走 parseRawBodyText —— 与非流式路径行为一致。
 */
async function readBodyWithStreaming(
    response: Response,
    hooks: StreamHooks,
    timing?: { firstDeltaMs?: number },
    startedAt?: number,
): Promise<any> {
    if (!response.body?.getReader) return safeResponseJson(response);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const asm = new SseAssembler();
    let raw = '';           // 全量原始文本（退化路径 / SSE 解析失败时兜底）
    let pending = '';       // SSE 模式下未消费完的半行缓冲
    let mode: 'undecided' | 'sse' | 'raw' = 'undecided';
    let sawFirstDelta = false;
    let sawTerminalEvent = false;
    const contentType = response.headers.get('content-type');

    const emit = (delta: SseFeedDelta) => {
        if (delta.done) sawTerminalEvent = true;
        if (delta.content) {
            if (!sawFirstDelta) {
                sawFirstDelta = true;
                if (timing && startedAt) timing.firstDeltaMs = Date.now() - startedAt;
                try { hooks.onFirstDelta?.(); } catch { /* 回调异常不拦截流 */ }
            }
            try { hooks.onDelta?.(delta.content, asm.content); } catch { /* 回调异常不拦截流 */ }
        }
        if (delta.reasoning) {
            try { hooks.onReasoningDelta?.(delta.reasoning, asm.reasoningContent); } catch { /* 回调异常不拦截流 */ }
        }
    };

    const consumeLines = () => {
        const lastNl = pending.lastIndexOf('\n');
        if (lastNl < 0) return;
        const complete = pending.slice(0, lastNl);
        pending = pending.slice(lastNl + 1);
        for (const line of complete.split(/\r?\n/)) emit(asm.feedLine(line));
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const textChunk = decoder.decode(value, { stream: true });
        raw += textChunk;
        if (mode === 'undecided') {
            const t = raw.trimStart();
            if (!t) continue;
            if (isSseResponseText(raw, contentType)) {
                mode = 'sse';
                pending = raw;
            } else if (/^[{["<]/.test(t) || /\r?\n/.test(t)) {
                // 明确是整包 JSON/HTML，或首行已经完整且不是 SSE。
                mode = 'raw';
            } else {
                // 首块可能只含 "d"/"da" 等 SSE 字段名前缀，等下一块再判断。
                continue;
            }
        } else if (mode === 'sse') {
            pending += textChunk;
        }
        if (mode === 'sse') consumeLines();
        if (sawTerminalEvent) {
            // A few OpenAI-compatible Claude proxies send [DONE]/finish_reason but
            // keep the HTTP socket alive. The completion is already whole; waiting
            // for reader.done would leave the Qixi loader spinning forever.
            try { await reader.cancel(); } catch { /* completion is already assembled */ }
            break;
        }
    }
    const tail = decoder.decode();
    if (tail) {
        raw += tail;
        if (mode === 'sse') pending += tail;
    }
    if (mode === 'sse') {
        consumeLines();
        if (pending.trim()) emit(asm.feedLine(pending.trim()));
        const assembled = asm.finish();
        if (assembled) return assembled;
        // 一个 chunk 都没解析出来 → 按原始文本兜底（保留原 preview 报错行为）
    }
    return parseRawBodyText(raw, response.status, contentType);
}

/**
 * 把非 2xx 响应体里的错误详情提取成可读字符串：
 * - 避免 `data.error` 是无 `.message` 的对象时拼出 `[object Object]`；
 * - 保留 `error.code` / `error.type` / `error.param` / `error.details`；
 * - 兼容 FastAPI / vLLM / 自建中转常见的顶层 `detail` / `message` / `msg`。
 */
export function formatApiErrorPayload(data: any, status: number): string {
    if (data == null) return `HTTP ${status}`;
    if (typeof data === 'string') return data.trim() || `HTTP ${status}`;
    if (typeof data !== 'object') return String(data) || `HTTP ${status}`;

    const stringifyExtra = (val: unknown): string => {
        if (val == null || val === '') return '';
        if (typeof val === 'string') return val.trim();
        if (typeof val === 'number' || typeof val === 'boolean') return String(val);
        try {
            return JSON.stringify(val);
        } catch {
            return String(val);
        }
    };

    const err = data.error;
    if (typeof err === 'string' && err.trim()) {
        return err.trim();
    }
    if (err && typeof err === 'object' && !Array.isArray(err)) {
        const message = typeof err.message === 'string' ? err.message.trim() : '';
        const code = typeof err.code === 'string' || typeof err.code === 'number' ? String(err.code).trim() : '';
        const type = typeof err.type === 'string' ? err.type.trim() : '';
        const param = typeof err.param === 'string' && err.param.trim() ? `param=${err.param.trim()}` : '';
        const details = stringifyExtra(err.details ?? err.detail ?? err.data);

        const tags = [code, type !== code ? type : '', param].filter((t) => t && !message.includes(t));
        const tagSuffix = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
        const detailSuffix = details && !message.includes(details) ? ` (${details})` : '';

        if (message) {
            return `${message}${tagSuffix}${detailSuffix}`;
        }
        const fallbackStructured = `${tags.join(', ')}${detailSuffix}`.trim();
        if (fallbackStructured) return fallbackStructured;
        return stringifyExtra(err) || `HTTP ${status}`;
    }

    const topMessage = typeof data.message === 'string' ? data.message.trim()
        : typeof data.msg === 'string' ? data.msg.trim()
            : '';
    const topDetail = stringifyExtra(data.detail ?? data.details);
    const topCode = typeof data.code === 'string' || typeof data.code === 'number' ? String(data.code).trim() : '';
    if (topMessage) {
        const codePart = topCode && !topMessage.includes(topCode) ? ` [${topCode}]` : '';
        const detailPart = topDetail && !topMessage.includes(topDetail) ? ` (${topDetail})` : '';
        return `${topMessage}${codePart}${detailPart}`;
    }
    if (topDetail) {
        return topCode && !topDetail.includes(topCode) ? `${topDetail} [${topCode}]` : topDetail;
    }

    return `HTTP ${status}`;
}

/**
 * Fetch with automatic retry for transient errors on non-billable endpoints.
 * Chat completions never retry automatically: a timeout/network error does not
 * prove the upstream generation stopped, so retrying can charge the user twice.
 * Other endpoints retry on: 429, 500, 502, 503, 504 and network failures.
 * Returns the parsed JSON data directly.
 *
 * `timeoutMs`：每次尝试的硬超时。如果调用方没在 options.signal 里自带 AbortController，
 * 这里会给每次 attempt 起一个内部 AbortController，超时就 abort，避免提供方 stall
 * 住整个页面（用户误以为卡死，只能重新打开网页）。0 / 未传 = 不超时。
 */
export async function safeFetchJson(
    url: string,
    options: RequestInit,
    maxRetries: number = 2,
    timeoutMs: number = 0,
    /** 可选：补充「哪个 App / 哪个角色 / 用途」到 API 调用记录（设置 → API 调用记录）。 */
    meta?: ApiCallMeta,
    /** 可选：流式增量回调（请求体带 stream:true 时传入才有意义；响应不是 SSE 时静默不触发）。 */
    streamHooks?: StreamHooks,
): Promise<any> {
    const retryableStatuses = new Set([429, 500, 502, 503, 504]);
    let lastError: Error | null = null;
    const urlStr = String(url);
    const automaticRetryLimit = isChatCompletionUrl(urlStr)
        ? 0
        : Math.max(0, Math.floor(Number(maxRetries) || 0));
    let lastStatus: number | undefined;

    // 显式 meta 挂到 RequestInit 给全局 fetch 兜底；同时快照环境标签，避免长响应期间
    // 用户切 App 后被错标。safeFetchJson 与全局拦截器以 requestId 原子去重。
    const metaOptions: RequestInit = meta ? { ...options, __sullyMeta: meta } as RequestInit : options;
    const logMeta = meta || getApiCallAmbientContext();

    // 图片在本机存成 `blobref:` 令牌，发出去对面读不懂——在这里统一还原成 data URL。
    // 各处构造请求的地方就不用各记一遍这件事了（详见 utils/apiBlobRefs.ts）。
    // 循环外做一次：重试用的是同一份 body。
    const resolvedBody = await resolveBlobRefsInRequestBody(metaOptions.body);
    const sendOptions: RequestInit = resolvedBody === metaOptions.body
        ? metaOptions
        : { ...metaOptions, body: resolvedBody as BodyInit };

    for (let attempt = 0; attempt <= automaticRetryLimit; attempt++) {
        if (meta?.appName === '记忆宫殿') await waitForPalaceRequest(options.signal ?? undefined);
        // 全局 fetch 拦截器和这里的“已解析响应兜底”共享 ID。前者覆盖裸 fetch，
        // 后者不依赖 Response.clone()，避免部分 iOS/WebView 克隆流不结束时漏记。
        const requestId = `api-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        // 每次 attempt 建一个独立的 AbortController（仅用于 timeout）
        // 调用方自己的 options.signal 仍然有效，两者任一触发就 abort
        let attemptOptions = { ...sendOptions, __sullyApiCallId: requestId } as RequestInit;
        let timeoutHandle: any = null;
        if (timeoutMs > 0) {
            const ac = new AbortController();
            timeoutHandle = setTimeout(() => ac.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
            if (options.signal) {
                // 串联外部 signal：外部 abort 也触发内部
                if (options.signal.aborted) {
                    clearTimeout(timeoutHandle);
                    throw new Error('aborted');
                }
                options.signal.addEventListener('abort', () => ac.abort(), { once: true });
            }
            attemptOptions = { ...attemptOptions, signal: ac.signal };
        }
        const attemptStartedAt = Date.now();
        try {
            const response = await fetchLlm(url, attemptOptions);
            if (timeoutHandle) clearTimeout(timeoutHandle);
            lastStatus = response.status;
            const headersMs = Date.now() - attemptStartedAt;

            if (!response.ok) {
                // For retryable status codes, retry before giving up
                if (retryableStatuses.has(response.status) && attempt < automaticRetryLimit) {
                    const delay = Math.pow(2, attempt) * 1000; // 1s, 2s
                    log.warn('HTTP retry', { status: response.status, attempt: attempt + 1, maxRetries: automaticRetryLimit, delay });
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                // Non-retryable or last attempt: parse body for error details
                const data = await safeResponseJson(response);
                // If we somehow got valid JSON with error info, wrap it
                const errMsg = formatApiErrorPayload(data, response.status);
                throw new Error(`API Error ${response.status}: ${errMsg}`);
            }

            const timing: { firstDeltaMs?: number } = {};
            const data = streamHooks
                ? await readBodyWithStreaming(response, streamHooks, timing, attemptStartedAt)
                : await safeResponseJson(response);
            if (isChatCompletionUrl(urlStr)) {
                // TTFT 拆分埋点：headers = 首包响应头到达（≈排队+prefill 起点），
                // firstDelta = 第一段正文增量（≈真正的 TTFT，仅流式路径有），
                // total = 整包收完。定位「API 慢 20s」到底慢在 prefill 还是生成。
                const totalMs = Date.now() - attemptStartedAt;
                console.log(`⏱ [API timing] headers=${headersMs}ms${timing.firstDeltaMs != null ? ` firstDelta=${timing.firstDeltaMs}ms` : ''} total=${totalMs}ms${streamHooks ? ' streamed=1' : ''}`);
                appendDevDebugApiLog({
                    url: urlStr,
                    method: options.method,
                    status: response.status,
                    requestBody: options.body,
                    response: data,
                    durationMs: totalMs,
                    headersMs,
                    firstDeltaMs: timing.firstDeltaMs,
                });
                // 已解析响应是最可靠的日志来源：不再把记账成败押在异步
                // response.clone().text() 上。全局拦截器仍负责裸 fetch，并以 requestId 去重。
                recordApiCall({
                    requestId,
                    url: urlStr,
                    body: attemptOptions.body,
                    status: response.status,
                    ok: response.ok,
                    response: data,
                    meta: logMeta,
                    durationMs: totalMs,
                });
            }
            return data;
        } catch (e: any) {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            lastError = e;

            // AbortError（含 timeout）：是否重试看上层策略，先按可重试处理（网络层面）
            const isAbort = e?.name === 'AbortError' || /aborted|timeout/i.test(e?.message || '');

            // Network errors (fetch itself failed) are retryable
            if ((e?.name === 'TypeError' || isAbort) && attempt < automaticRetryLimit) {
                const delay = Math.pow(2, attempt) * 1000;
                log.warn(isAbort ? 'Timeout/Abort retry' : 'Network error retry', { attempt: attempt + 1, maxRetries: automaticRetryLimit, delay, message: e?.message });
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            // For HTML/parse errors on non-ok responses during retry, continue
            if (attempt < automaticRetryLimit && e?.message?.includes('API返回了HTML')) {
                const delay = Math.pow(2, attempt) * 1000;
                log.warn('HTML response retry', { attempt: attempt + 1, maxRetries, delay });
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            if (isChatCompletionUrl(urlStr)) {
                appendDevDebugApiLog({
                    url: urlStr,
                    method: options.method,
                    status: lastStatus,
                    requestBody: options.body,
                    error: e,
                    durationMs: Date.now() - attemptStartedAt,
                });
            }
            throw e;
        }
    }

    throw lastError || new Error('API请求失败');
}

/**
 * Safely extract the AI content string from an OpenAI-compatible response.
 * Returns '' instead of crashing when the structure is unexpected.
 *
 * Handles thinking models (DeepSeek-R1, GLM-4.5, QwQ, Qwen3, ...):
 *  - Falls back to `reasoning_content` when `content` is missing/empty
 *  - Strips hidden <think>...</think> chain-of-thought blocks
 */
export function extractContent(data: any): string {
    const msg = data?.choices?.[0]?.message;
    const contentToText = (value: unknown): string => {
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) {
            return value.map(part => {
                if (typeof part === 'string') return part;
                if (!part || typeof part !== 'object') return '';
                const record = part as Record<string, unknown>;
                return contentToText(record.text ?? record.content ?? record.value);
            }).filter(Boolean).join('');
        }
        if (value && typeof value === 'object') {
            const record = value as Record<string, unknown>;
            return contentToText(record.text ?? record.content ?? record.value);
        }
        return '';
    };

    let text = contentToText(msg?.content);
    if (!text.trim()) text = contentToText(msg?.reasoning_content);
    // Strip hidden chain-of-thought blocks: <think> / <thinking> / <thought>
    text = text.replace(/<(think|thinking|thought)>[\s\S]*?<\/\1>/gi, '');
    text = text.replace(/<(?:think|thinking|thought)>[\s\S]*$/gi, '');
    return text.trim();
}

/**
 * Robustly extract a JSON object from AI-generated text.
 *
 * Handles common Claude format instabilities:
 *  - JSON wrapped in ```json ... ``` code blocks
 *  - Extra prose before/after the JSON ("Here is the result: { ... }")
 *  - Trailing commas in arrays/objects  (common Claude habit)
 *  - Single-quoted strings
 *  - Unquoted keys
 *
 * Returns parsed object on success, null on total failure.
 */
/**
 * Walk through a JSON-ish string and re-escape `"` characters that appear inside
 * string values but weren't escaped by the LLM.
 *
 * Common with Claude when the content quotes a phrase ("还不够好" / "我爱你"等)
 * inside a string value — the inner quotes break JSON.parse because they look
 * like closing delimiters.
 *
 * Heuristic for distinguishing "real closing quote" vs "unescaped inner quote":
 *   A `"` is treated as closing iff the next non-whitespace char is one of
 *   , } ] : end-of-input. Otherwise it's an inner quote and gets \-escaped.
 */
function escapeUnescapedInnerQuotes(text: string): string {
    let result = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (escaped) { result += ch; escaped = false; continue; }
        if (ch === '\\' && inString) { result += ch; escaped = true; continue; }

        if (ch === '"') {
            if (!inString) {
                inString = true;
                result += ch;
                continue;
            }
            // We're inside a string. Look ahead to decide: closing or inner?
            let j = i + 1;
            while (j < text.length && /[ \t\r\n]/.test(text[j])) j++;
            const next = j < text.length ? text[j] : '';
            // Closing iff next meaningful char is one of , } ] : or EOF
            if (next === '' || next === ',' || next === '}' || next === ']' || next === ':') {
                inString = false;
                result += ch;
            } else {
                // Inner unescaped quote → escape it
                result += '\\"';
            }
            continue;
        }

        result += ch;
    }

    return result;
}

/**
 * Attempt to repair truncated JSON by closing open strings, arrays, and objects.
 * Handles the common case where LLM output is cut off mid-string.
 */
function repairTruncatedJson(text: string): string | null {
    // If it already ends with } or ], it's probably not truncated in a way we can fix
    const trimmed = text.trim();
    if (trimmed.endsWith('}') || trimmed.endsWith(']')) return null; // let other steps handle it

    // Walk through the string tracking state
    let inString = false;
    let escaped = false;
    const stack: ('{' | '[')[] = [];
    let lastKeyValueEnd = 0; // position after last complete key:value pair

    for (let i = 0; i < trimmed.length; i++) {
        const ch = trimmed[i];

        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }

        if (ch === '"') {
            inString = !inString;
            continue;
        }

        if (inString) continue;

        if (ch === '{') stack.push('{');
        else if (ch === '[') stack.push('[');
        else if (ch === '}') { if (stack.length > 0 && stack[stack.length - 1] === '{') stack.pop(); }
        else if (ch === ']') { if (stack.length > 0 && stack[stack.length - 1] === '[') stack.pop(); }

        // Track positions after complete values at object level
        if (stack.length === 1 && stack[0] === '{' && (ch === ',' || ch === '}')) {
            lastKeyValueEnd = i + 1;
        }
    }

    if (stack.length === 0) return null; // balanced, nothing to repair

    // Strategy: truncate to last complete key:value, then close brackets
    let repaired = '';
    if (lastKeyValueEnd > 0) {
        repaired = trimmed.slice(0, lastKeyValueEnd).replace(/,\s*$/, '');
    } else {
        // No complete key:value found at top level, try closing from current position
        repaired = trimmed;
        // If we're in an open string, close it
        if (inString) repaired += '"';
    }

    // Close remaining open brackets in reverse order
    for (let i = stack.length - 1; i >= 0; i--) {
        repaired += stack[i] === '{' ? '}' : ']';
    }

    return repaired;
}

/** Repair formatting outside strings; preserve apostrophes and literal `, }` in prose. */
function repairJsonPresentation(text: string): string {
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { result += ch; escaped = false; continue; }
        if (inString && ch === '\\') { result += ch; escaped = true; continue; }
        if (ch === '"') inString = !inString;
        if (inString && ch.charCodeAt(0) < 32) {
            result += JSON.stringify(ch).slice(1, -1);
        } else if (!inString && ch === ',' && /^[\s]*[}\]]/.test(text.slice(i + 1))) {
            continue;
        } else result += ch;
    }
    return result;
}

export function extractJson(raw: string, options: { allowTruncated?: boolean; silent?: boolean } = {}): any | null {
    if (!raw) return null;

    // 1. Strip markdown code fences
    let text = raw
        .replace(/^```(?:json|JSON)?\s*\n?/gm, '')
        .replace(/\n?```\s*$/gm, '')
        .trim();

    // 2. Try direct parse first (fast path)
    try { return JSON.parse(text); } catch {}

    // 3. Extract the outermost { ... } or [ ... ]
    const objMatch = text.match(/(\{[\s\S]*\})/);
    const arrMatch = text.match(/(\[[\s\S]*\])/);
    // Prefer whichever starts earlier in the text
    let jsonStr = '';
    if (objMatch && arrMatch) {
        jsonStr = (text.indexOf(objMatch[1]) <= text.indexOf(arrMatch[1]))
            ? objMatch[1] : arrMatch[1];
    } else {
        jsonStr = objMatch?.[1] || arrMatch?.[1] || '';
    }

    if (!jsonStr) return null;

    // 4. Try parsing the extracted substring
    try { return JSON.parse(jsonStr); } catch {}
    try { return JSON.parse(repairJsonPresentation(jsonStr)); } catch {}

    // 5. Fix common AI formatting issues and retry
    let fixed = jsonStr
        // Trailing commas: ,} or ,]
        .replace(/,\s*([}\]])/g, '$1')
        // Single quotes → double quotes (careful with apostrophes in text)
        // Only replace quotes that look like JSON string delimiters
        .replace(/'/g, '"')
        // Unquoted keys:  { foo: "bar" } → { "foo": "bar" }
        .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');

    try { return JSON.parse(fixed); } catch {}

    // 6. Try to repair unescaped inner quotes (LLM writes naked " inside a string value).
    // Common with Claude when the content quotes a phrase like 「埋一句"我爱你"」
    // — the inner " breaks JSON parsing because they're not \-escaped.
    const innerQuoteFixed = escapeUnescapedInnerQuotes(jsonStr);
    if (innerQuoteFixed && innerQuoteFixed !== jsonStr) {
        try { return JSON.parse(repairJsonPresentation(innerQuoteFixed)); } catch {}
        try { return JSON.parse(innerQuoteFixed); } catch {}
        try {
            return JSON.parse(innerQuoteFixed
                .replace(/,\s*([}\]])/g, '$1')
                .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":'));
        } catch {}
    }

    // 7. Try to repair truncated JSON (LLM hit max_tokens)
    // Find the first { and attempt to close any open strings/brackets
    const firstBrace = text.indexOf('{');
    if (firstBrace >= 0 && options.allowTruncated !== false) {
        let truncated = text.slice(firstBrace);
        const repaired = repairTruncatedJson(truncated);
        if (repaired) {
            try { return JSON.parse(repaired); } catch {}
            // Also try with common fixes applied
            try {
                return JSON.parse(repaired
                    .replace(/,\s*([}\]])/g, '$1')
                    .replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":'));
            } catch {}
            // Also try escaping inner quotes on the truncated-repaired version
            const repairedInnerFixed = escapeUnescapedInnerQuotes(repaired);
            if (repairedInnerFixed !== repaired) {
                try { return JSON.parse(repairedInnerFixed); } catch {}
            }
        }
    }

    // 8. Last resort: try to extract individual JSON objects if there are multiple
    // (AI sometimes outputs two JSON blocks, take the larger one)
    const allObjects = [...text.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
    if (allObjects.length > 0) {
        // Sort by length, try the longest first (most likely the full response)
        const sorted = allObjects.sort((a, b) => b[0].length - a[0].length);
        for (const m of sorted) {
            try {
                return JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));
            } catch {}
            try {
                const fixedInner = escapeUnescapedInnerQuotes(m[0]);
                return JSON.parse(fixedInner.replace(/,\s*([}\]])/g, '$1'));
            } catch {}
        }
    }

    // 9. AI sometimes wraps the expected JSON in a wrapper object like {"result": {...}}
    // Try to find the first nested object value and return it
    for (const m of allObjects) {
        try {
            const parsed = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));
            const vals = Object.values(parsed);
            if (vals.length === 1 && typeof vals[0] === 'object' && vals[0] !== null) return vals[0];
        } catch {}
    }

    if (!options.silent) console.error('[extractJson] All attempts failed. Raw:', raw.slice(0, 300));
    return null;
}
