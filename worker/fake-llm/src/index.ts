// SullyOS 假模型：OpenAI 兼容的 chat completions，不请求任何真实模型。
// 用法、场景清单、各链路读哪个 API 槽位见 docs/fake-llm.md。
//
// 这一层只管 HTTP：路由、CORS、把 plan 按时间吐成 JSON 或 SSE。
// 「这一轮该回什么」全在 scenarios.ts 里，是零依赖的纯函数，测试直接调。

import { listModelIds, planResponse, type Plan, type ReplyPlan } from './scenarios';

interface Env {
    FAKE_LLM_LOG_TOKEN?: string;
}

const CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    // 浏览器直连时会带 Authorization 和各种自定义头；预检不回就只看到 Failed to fetch。
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
};

// 延迟期间每隔这么久吐一个保活字节，防边缘网关因为迟迟不出首字节把连接掐掉。
const KEEPALIVE_MS = 5_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const encoder = new TextEncoder();

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extra },
    });
}

// ─── 最近收到的请求（回归时断言提示词用） ───
// shortcut: 只存在这个 isolate 的内存里，CF 会把请求分到不同实例、实例随时回收，
// 所以线上只能看到「打到同一个实例的最近几条」；要稳定断言时改用 Durable Object 或 KV。
const REQUEST_LOG_LIMIT = 20;
const REQUEST_BODY_LIMIT = 512 * 1024;
const requestLog: unknown[] = [];

function remember(entry: Record<string, unknown>, rawBody: string): void {
    const body = rawBody.length <= REQUEST_BODY_LIMIT
        ? safeParse(rawBody)
        : { truncated: true, length: rawBody.length, preview: rawBody.slice(0, 64 * 1024) };
    requestLog.push({ ...entry, body });
    if (requestLog.length > REQUEST_LOG_LIMIT) requestLog.shift();
}

function safeParse(text: string): unknown {
    try { return JSON.parse(text); } catch { return text; }
}

function requestLogAuthorized(request: Request, env: Env): boolean | null {
    const token = env.FAKE_LLM_LOG_TOKEN?.trim();
    if (!token) return null; // 没配口令 = 端点不存在
    return request.headers.get('Authorization') === `Bearer ${token}`;
}

// ─── 把 plan 吐出去 ───

function usageOf(plan: ReplyPlan) {
    return {
        prompt_tokens: plan.promptTokens,
        completion_tokens: plan.completionTokens,
        total_tokens: plan.promptTokens + plan.completionTokens,
    };
}

function completionBody(plan: ReplyPlan, model: string, id: string, created: number) {
    const message: Record<string, unknown> = { role: 'assistant', content: plan.content };
    if (plan.reasoning) message.reasoning_content = plan.reasoning;
    if (plan.toolCalls?.length) message.tool_calls = plan.toolCalls;
    return {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message, finish_reason: plan.finishReason }],
        usage: usageOf(plan),
    };
}

/** 文本按「一个字一块」或「一句一块」切开；慢速逐字流式靠前者。 */
function pieces(text: string, perChar: boolean): string[] {
    if (!text) return [];
    if (perChar) return Array.from(text);
    return text.match(/[^。！？!?\n]*[。！？!?\n]+|[^。！？!?\n]+$/g) ?? [text];
}

function streamBody(write: (text: string) => Promise<void>, plan: ReplyPlan, model: string, id: string, created: number, includeUsage: boolean) {
    const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const perChar = plan.charIntervalMs > 0;
    return (async () => {
        await write(chunk({ role: 'assistant', content: '' }, null));
        for (const piece of pieces(plan.reasoning ?? '', perChar)) {
            await write(chunk({ reasoning_content: piece }, null));
            if (perChar) await sleep(plan.charIntervalMs);
        }
        for (const piece of pieces(plan.content, perChar)) {
            await write(chunk({ content: piece }, null));
            if (perChar) await sleep(plan.charIntervalMs);
        }
        // 工具调用照真实接口的样子分两片：先名字和 id，再参数。
        for (const [index, call] of (plan.toolCalls ?? []).entries()) {
            await write(chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] }, null));
            await write(chunk({ tool_calls: [{ index, function: { arguments: call.function.arguments } }] }, null));
        }
        await write(chunk({}, plan.finishReason));
        if (includeUsage) {
            await write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageOf(plan) })}\n\n`);
        }
        await write('data: [DONE]\n\n');
    })();
}

/** 先回响应头，body 在后台按时间往里写。延迟期间吐保活字节。 */
function timedResponse(contentType: string, status: number, delayMs: number, keepalive: string, run: (write: (text: string) => Promise<void>) => Promise<void>): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const write = (text: string) => writer.write(encoder.encode(text));
    (async () => {
        try {
            const startedAt = Date.now();
            let remaining = delayMs;
            while (remaining > 0) {
                await write(keepalive);
                await sleep(Math.min(KEEPALIVE_MS, remaining));
                remaining = delayMs - (Date.now() - startedAt);
            }
            await run(write);
            await writer.close();
        } catch {
            // 客户端中途断开时写入会抛错，这里没人可报，直接放掉。
            await writer.abort().catch(() => undefined);
        }
    })();
    return new Response(readable, { status, headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store', ...CORS_HEADERS } });
}

async function respond(plan: Plan, wantsStream: boolean, includeUsage: boolean): Promise<Response> {
    const id = `chatcmpl-fake-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    switch (plan.type) {
        case 'http-error':
            return json(plan.body, plan.status, plan.headers);
        case 'hang':
            // 真正的「不回」：连响应头都不给，到点才断。
            await sleep(plan.ms);
            return json({ error: { message: `fake-llm hung for ${plan.ms}ms`, type: 'fake_hang' } }, 504);
        case 'raw':
            if (wantsStream) {
                return new Response(plan.sse, { headers: { 'Content-Type': 'text/event-stream', ...CORS_HEADERS } });
            }
            return new Response(plan.body, { headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS } });
        case 'reply': {
            const model = plan.model;
            if (wantsStream) {
                return timedResponse('text/event-stream; charset=utf-8', 200, plan.delayMs, ': keepalive\n\n',
                    write => streamBody(write, plan, model, id, created, includeUsage));
            }
            const body = JSON.stringify(completionBody(plan, model, id, created));
            if (plan.delayMs <= 0 && plan.charIntervalMs <= 0) {
                return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS } });
            }
            // 非流式的慢速逐字：总耗时照逐字算，最后一次性给 JSON。JSON 允许前导空白，保活用空格。
            const totalMs = plan.delayMs + Array.from(plan.content).length * plan.charIntervalMs;
            return timedResponse('application/json; charset=utf-8', 200, totalMs, ' ', write => write(body));
        }
    }
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const { pathname } = new URL(request.url);

        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

        if (pathname === '/_fake/requests') {
            const ok = requestLogAuthorized(request, env);
            if (ok === null) return json({ error: { message: 'request log is disabled (FAKE_LLM_LOG_TOKEN not set)' } }, 404);
            if (!ok) return json({ error: { message: 'unauthorized' } }, 401);
            if (request.method === 'DELETE') { requestLog.length = 0; return json({ cleared: true }); }
            return json({ requests: requestLog });
        }

        // 调用方按 baseUrl 拼路径，/v1/models、/models、/xxx/v1/models 都认。
        if (request.method === 'GET' && /\/models\/?$/.test(pathname)) {
            return json({ object: 'list', data: listModelIds().map(id => ({ id, object: 'model', created: 0, owned_by: 'sullyos-fake-llm' })) });
        }

        if (request.method === 'POST' && /\/chat\/completions\/?$/.test(pathname)) {
            const rawBody = await request.text();
            const parsed = safeParse(rawBody);
            const body = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, any>;
            const { plan, scenario, requestKind } = planResponse(body);
            if (env.FAKE_LLM_LOG_TOKEN?.trim()) {
                remember({ at: new Date().toISOString(), path: pathname, model: body.model, scenario, requestKind, stream: body.stream === true }, rawBody);
            }
            return respond(plan, body.stream === true, body.stream_options?.include_usage === true);
        }

        return json({ error: { message: `no such route: ${request.method} ${pathname}` } }, 404);
    },
};
