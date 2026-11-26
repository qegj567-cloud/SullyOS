import { modelEndpoint, modelRelayPath, siteOrigin } from '../utils/siteModelTransport';

interface RelayEnv {
    MODEL_BUDGET: {
        getByName(name: string): { fetch(url: string): Promise<Response> };
    };
    MODEL_RATE: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

// Only a UTC day and an aggregate count are persisted. No per-user records.
export class ModelRelayBudget {
    constructor(private readonly state: { storage: { sql: {
        exec(query: string, ...values: (number | string)[]): Iterable<{ used: number }>;
    } } }) {}
    async fetch(): Promise<Response> {
        const sql = this.state.storage.sql;
        const day = new Date().toISOString().slice(0, 10);
        sql.exec('CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY, day TEXT, used INTEGER)');
        const rows = [...sql.exec(
            'INSERT INTO budget VALUES (1, ?, 1) ON CONFLICT(id) DO UPDATE SET day=excluded.day, used=CASE WHEN day=excluded.day THEN used+1 ELSE 1 END WHERE day<>excluded.day OR used<20000 RETURNING used',
            day,
        )];
        return new Response(null, { status: rows.length ? 204 : 429 });
    }
}

function failure(status: number, message: string): Response {
    return Response.json({ error: { message } }, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Real files are served by static assets. Only the exact API route and misses reach the script. */
export default {
    async fetch(request: Request, env: RelayEnv): Promise<Response> {
        if (request.url !== siteOrigin + modelRelayPath || request.method !== 'POST') {
            return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
        }
        if (request.headers.get('origin') !== siteOrigin) return failure(403, '仅支持糯米主站请求');
        const target = modelEndpoint(request.headers.get('x-model-endpoint') || '');
        const auth = request.headers.get('authorization') || '';
        if (!target || !/^Bearer\s+\S/i.test(auth)) return failure(400, '请核对模型接口地址和密钥');
        const models = /\/models\/?$/.test(target.pathname);
        if (!models && (!request.body || !/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || ''))) {
            return failure(400, '对话接口需要 JSON 请求');
        }
        const client = request.headers.get('cf-connecting-ip');
        if (!client || !(await env.MODEL_RATE.limit({ key: client })).success) return failure(429, '请求过于频繁，请稍后再试');
        const budget = await env.MODEL_BUDGET.getByName('account').fetch('https://budget/reserve');
        if (!budget.ok) return failure(429, '主站今日模型转发额度已用完');
        // Forward only model credentials and the real web origin. No client cookies, no redirects.
        const headers = new Headers({ authorization: auth, origin: siteOrigin });
        if (!models) headers.set('content-type', 'application/json');
        headers.set('accept', request.headers.get('accept') || 'application/json, text/event-stream');
        let upstream: Response;
        try {
            upstream = await fetch(target.href, {
                method: models ? 'GET' : 'POST', headers, body: models ? undefined : request.body,
                redirect: 'manual', signal: request.signal, cache: 'no-store',
            });
        } catch {
            return failure(502, '主站连接不到这个模型接口');
        }
        if (upstream.status >= 300 && upstream.status < 400) {
            await upstream.body?.cancel();
            return failure(502, '接口发生跳转，请填写最终 API 地址');
        }
        const streaming = upstream.headers.get('content-type')?.split(';')[0].trim() === 'text/event-stream';
        const responseHeaders = new Headers({
            'Content-Type': streaming ? 'text/event-stream' : 'application/json; charset=utf-8',
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        });
        const retryAfter = upstream.headers.get('retry-after');
        if (retryAfter) responseHeaders.set('retry-after', retryAfter);
        return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    },
};
