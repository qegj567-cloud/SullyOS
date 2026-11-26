import { describe, expect, it } from 'vitest';
import worker from './index';
import { parseSseToCompletion, extractContent } from '../../../utils/safeApi';

const call = (path: string, init: RequestInit = {}, env: Record<string, string> = {}) =>
    worker.fetch(new Request(`http://fake.test${path}`, init), env);
const chat = (body: object, env: Record<string, string> = {}) =>
    call('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env);
const turn = (model: string, extra: object = {}) => ({ model, messages: [{ role: 'user', content: '在吗' }], ...extra });

describe('HTTP 外壳', () => {
    it('OPTIONS 预检回 CORS 头', async () => {
        const res = await call('/v1/chat/completions', { method: 'OPTIONS' });
        expect(res.status).toBe(204);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(res.headers.get('Access-Control-Allow-Headers')).toBeTruthy();
    });

    it('/v1/models 和 /models 都列出全部场景', async () => {
        for (const path of ['/v1/models', '/models']) {
            const ids = (await (await call(path)).json()).data.map((m: any) => m.id);
            expect(ids).toEqual(expect.arrayContaining(['fake/basic', 'fake/side-effects', 'fake/delay-6m', 'fake/error-429', 'fake/tool-call']));
        }
    });

    it('非流式：普通 JSON，带 usage', async () => {
        const data = await (await chat(turn('fake/basic'))).json();
        expect(data.choices[0].finish_reason).toBe('stop');
        expect(extractContent(data)).toContain('假模型');
        expect(data.usage.total_tokens).toBeGreaterThan(0);
    });

    it('流式：App 的 SSE 解析器能拼回正文、思考和末尾 usage', async () => {
        const res = await chat(turn('fake/thinking-field', { stream: true, stream_options: { include_usage: true } }));
        expect(res.headers.get('Content-Type')).toContain('text/event-stream');
        const text = await res.text();
        expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
        const data = parseSseToCompletion(text);
        expect(data.choices[0].message.content).toContain('假模型');
        expect(data.choices[0].message.reasoning_content).toContain('先想一想');
        expect(data.usage.total_tokens).toBeGreaterThan(0);
    });

    it('流式工具调用：分片能被 App 重组成完整参数', async () => {
        const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
        const data = parseSseToCompletion(await (await chat(turn('fake/tool-call', { stream: true, tools }))).text());
        const callOut = data.choices[0].message.tool_calls[0];
        expect(callOut.function.name).toBe('get_weather');
        expect(JSON.parse(callOut.function.arguments)).toEqual({ city: '假模型' });
    });

    it('错误码原样返回，429 带 Retry-After', async () => {
        const res = await chat(turn('fake/error-429'));
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBe('1');
        expect((await res.json()).error.code).toBe('rate_limit_exceeded');
    });

    it('延迟场景：先吐保活空格，JSON 照样能解析', async () => {
        const res = await chat(turn('fake/delay-30ms'));
        const text = await res.text();
        expect(text.startsWith(' ')).toBe(true);
        expect(JSON.parse(text).choices[0].message.content).toBeTruthy();
    });

    it('坏 JSON 场景确实解析不了', async () => {
        await expect((await chat(turn('fake/bad-json'))).json()).rejects.toThrow();
    });
});

describe('最近请求端点', () => {
    it('没配口令时整个关掉，也不记录', async () => {
        await chat(turn('fake/basic'));
        expect((await call('/_fake/requests')).status).toBe(404);
    });

    it('配了口令：错口令 401，对口令能看到刚才的请求，DELETE 清空', async () => {
        const env = { FAKE_LLM_LOG_TOKEN: 'secret' };
        await chat(turn('fake/side-effects'), env);
        expect((await call('/_fake/requests', { headers: { Authorization: 'Bearer nope' } }, env)).status).toBe(401);
        const auth = { headers: { Authorization: 'Bearer secret' } };
        const log = await (await call('/_fake/requests', auth, env)).json();
        expect(log.requests.at(-1)).toMatchObject({ model: 'fake/side-effects', scenario: 'side-effects', requestKind: 'main' });
        expect(log.requests.at(-1).body.messages[0].content).toBe('在吗');
        await call('/_fake/requests', { method: 'DELETE', ...auth }, env);
        expect((await (await call('/_fake/requests', auth, env)).json()).requests).toEqual([]);
    });
});
