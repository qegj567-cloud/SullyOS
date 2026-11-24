import { describe, it, expect } from 'vitest';
import { upgradeChatBodyToStream, assembleUpgradedResponse } from './streamUpgrade';

// 透明流式升级：请求体改写 + SSE 响应拼回 JSON。
// 关键不变量：调用方拿到的最终 JSON 与不升级时结构等价（choices/usage/model）。

describe('upgradeChatBodyToStream', () => {
    it('stream:false → 升级为 stream:true + include_usage，其余字段不动', () => {
        const out = upgradeChatBodyToStream(JSON.stringify({ model: 'm', messages: [], stream: false, max_tokens: 8000 }));
        const parsed = JSON.parse(out!);
        expect(parsed.stream).toBe(true);
        expect(parsed.stream_options).toEqual({ include_usage: true });
        expect(parsed.max_tokens).toBe(8000);
    });

    it('缺省 stream → 同样升级', () => {
        const out = upgradeChatBodyToStream(JSON.stringify({ model: 'm', messages: [] }));
        expect(JSON.parse(out!).stream).toBe(true);
    });

    it('已是 stream:true（聊天主路径等自行开流的调用）→ 不碰，返回 null', () => {
        expect(upgradeChatBodyToStream(JSON.stringify({ model: 'm', stream: true }))).toBeNull();
    });

    it('非 JSON / 非对象 body → 返回 null 原样放行', () => {
        expect(upgradeChatBodyToStream('not-json')).toBeNull();
        expect(upgradeChatBodyToStream('[1,2]')).toBeNull();
    });
});

describe('assembleUpgradedResponse', () => {
    it('SSE 响应 → 拼回标准 chat.completion JSON', async () => {
        const sse = [
            'data: {"id":"c1","model":"real-backend","choices":[{"delta":{"role":"assistant","content":"你好"}}]}',
            'data: {"choices":[{"delta":{"content":"呀"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
            'data: [DONE]',
            '',
        ].join('\n');
        const upstream = new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        const out = await assembleUpgradedResponse(upstream);
        expect(out.headers.get('content-type')).toContain('application/json');
        const data = await out.json();
        expect(data.choices[0].message.content).toBe('你好呀');
        expect(data.model).toBe('real-backend');
        expect(data.usage.total_tokens).toBe(12);
    });

    it('OpenRouter 心跳先于 data 时仍拼回标准 JSON', async () => {
        const sse = [
            ': OPENROUTER PROCESSING',
            '',
            'data: {"id":"c2","choices":[{"delta":{"content":"心跳后"}}]}',
            'data: {"choices":[{"delta":{"content":"正常"}}]}',
            'data: [DONE]',
            '',
        ].join('\n');
        const upstream = new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        const out = await assembleUpgradedResponse(upstream);
        const data = await out.json();
        expect(data.choices[0].message.content).toBe('心跳后正常');
    });

    it('代理无视 stream 返回整包 JSON → 原文透传（重新包装）', async () => {
        const json = JSON.stringify({ choices: [{ message: { content: '整包' } }] });
        const upstream = new Response(json, { status: 200, headers: { 'Content-Type': 'application/json' } });
        const out = await assembleUpgradedResponse(upstream);
        expect((await out.json()).choices[0].message.content).toBe('整包');
    });

    it('上游用 200 SSE 返回内嵌 error 事件时，还原为非 2xx JSON 响应供诊断与调用方识别', async () => {
        const sse = [
            'data: {"error":{"message":"Model overloaded","type":"server_error","code":503}}',
            'data: [DONE]',
            '',
        ].join('\n');
        const upstream = new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        const out = await assembleUpgradedResponse(upstream);
        expect(out.ok).toBe(false);
        expect(out.status).toBe(503);
        const body = await out.json();
        expect(body.error.message).toContain('Model overloaded');
    });

    it('网关在正常流式 chunk 上附带空占位 error 对象（message 为空、code 为 null/0）时不误判为报错', async () => {
        const sse = [
            'data: {"id":"c3","error":{"message":"","type":"","param":null,"code":null},"choices":[{"delta":{"content":"正常正文"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
            'data: [DONE]',
            '',
        ].join('\n');
        const upstream = new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        const out = await assembleUpgradedResponse(upstream);
        expect(out.ok).toBe(true);
        const body = await out.json();
        expect(body.choices[0].message.content).toBe('正常正文');
    });

    it('底层流式读取抛出 __sullyUpstreamStreamError 时还原为非 2xx JSON 响应而非流中断异常', async () => {
        const errStream = new ReadableStream({
            start(controller) {
                controller.error(Object.assign(new Error('API Error: Overloaded [overloaded_error]'), {
                    __sullyUpstreamStreamError: true,
                    httpStatus: 529,
                }));
            },
        });
        const upstream = new Response(errStream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        const info: { status?: number } = { status: 200 };
        const out = await assembleUpgradedResponse(upstream, info);
        expect(out.ok).toBe(false);
        expect(out.status).toBe(529);
        expect(info.status).toBe(529);
        const body = await out.json();
        expect(body.error.message).toContain('Overloaded');
    });
});
