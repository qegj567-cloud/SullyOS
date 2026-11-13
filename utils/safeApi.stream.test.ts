import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeFetchJson } from './safeApi';

// 锁住流式读取路径 (readBodyWithStreaming) 与整包路径的行为一致性：
//  - SSE 增量正文触发 onDelta，最终拼出与非流式相同结构的 completion 对象
//  - tool_calls 分片按 index 合并（工具模式开 stream 不丢调用）
//  - 代理无视 stream:true 返回整包 JSON 时静默退化，onDelta 不触发

const sseBody = (events: string[]) => new ReadableStream<Uint8Array>({
    start(controller) {
        const enc = new TextEncoder();
        for (const e of events) controller.enqueue(enc.encode(e));
        controller.close();
    },
});

const sseResponse = (events: string[]) => new Response(sseBody(events), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
});

const lingeringSseResponse = (events: string[], onCancel: () => void) => new Response(
    new ReadableStream<Uint8Array>({
        start(controller) {
            const enc = new TextEncoder();
            for (const event of events) controller.enqueue(enc.encode(event));
            // Deliberately never close: some compatible Claude proxies leave the
            // socket alive even after their terminal SSE event.
        },
        cancel() { onCancel(); },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
);

afterEach(() => vi.restoreAllMocks());

describe('compatible thinking response formats', () => {
    it.each(['reasoning', 'thinking', 'reasoning_details', 'content'])(
        'normalizes non-stream %s without putting thoughts in the answer', async field => {
            const message: any = {content:'你好',reasoning_content:''};
            message[field] = field === 'reasoning_details' ? [{type:'reasoning.summary',summary:'摘要'}]
                : field === 'content' ? [{text:'摘要',thought:true},{text:'你好'}] : '摘要';
            vi.stubGlobal('fetch',vi.fn(async () => new Response(JSON.stringify({choices:[{message}]}),
                {headers:{'content-type':'application/json'}})));
            const data = await safeFetchJson('https://api.test/v1/chat/completions',{method:'POST',body:'{}'},0,0);
            expect(data.choices[0].message.content).toBe('你好');
            expect(data.choices[0].message.reasoning_content).toBe('摘要');
        },
    );

    it.each([true,false])('keeps structured SSE summaries separate (stream callbacks: %s)', async streaming => {
        const deltas = ['First',' ','thought'].map(text => ({reasoning_content:'',reasoning:text,
            reasoning_details:[{type:'reasoning.text',text}]}));
        deltas.push({reasoning_details:[{type:'reasoning.encrypted',data:'opaque'}],content:'你好'} as any);
        const events=deltas.map(delta => `data: ${JSON.stringify({choices:[{delta}]})}\n\n`);
        events.push('data: [DONE]\n\n');
        vi.stubGlobal('fetch',vi.fn(async () => sseResponse(events)));
        const onDelta=vi.fn(), onReasoningDelta=vi.fn();
        const data=await safeFetchJson('https://api.test/v1/chat/completions',{method:'POST',body:'{}'},0,0,undefined,
            streaming ? {onDelta,onReasoningDelta} : undefined);
        expect(data.choices[0].message).toMatchObject({content:'你好',reasoning_content:'First thought'});
        if (streaming) {
            expect(onDelta.mock.calls.map(args=>args[0]).join('')).toBe('你好');
            expect(onReasoningDelta.mock.calls.map(args=>args[0]).join('')).toBe('First thought');
        }
    });

    it('reads detail-only increments and one-shot SSE thought content arrays', async () => {
        const events = [
            {delta:{reasoning_details:[{type:'reasoning.summary',summary:'先想'}]}},
            {message:{content:[{text:'后想',thought:true},{type:'text',text:'你好'}]}},
        ].map(choice=>`data: ${JSON.stringify({choices:[choice]})}\n\n`);
        events.push('data: [DONE]\n\n');
        vi.stubGlobal('fetch',vi.fn(async () => sseResponse(events)));
        const onDelta=vi.fn();
        const data=await safeFetchJson('https://api.test/v1/chat/completions',{method:'POST',body:'{}'},0,0,undefined,{onDelta});
        expect(data.choices[0].message).toMatchObject({content:'你好',reasoning_content:'先想后想'});
        expect(onDelta.mock.calls.map(args=>args[0]).join('')).toBe('你好');
    });
});

describe('safeFetchJson streaming', () => {
    it('SSE 增量触发 onDelta 且最终 completion 与整包解析一致', async () => {
        const events = [
            'data: {"id":"x","choices":[{"delta":{"role":"assistant","content":"你好"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"呀\\n在干嘛"}}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":42,"prompt_tokens":30,"completion_tokens":12}}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));

        const deltas: string[] = [];
        let lastFull = '';
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, {
            onDelta: (d, full) => { deltas.push(d); lastFull = full; },
        });

        expect(deltas.join('')).toBe('你好呀\n在干嘛');
        expect(lastFull).toBe('你好呀\n在干嘛');
        expect(data.choices[0].message.content).toBe('你好呀\n在干嘛');
        expect(data.choices[0].finish_reason).toBe('stop');
        expect(data.usage.total_tokens).toBe(42);
    });

    it('收到 [DONE] 后立即收口，不等待代理主动关闭连接', async () => {
        const cancelled = vi.fn();
        vi.stubGlobal('fetch', vi.fn(async () => lingeringSseResponse([
            'data: {"choices":[{"delta":{"content":"已经生成完"}}]}\n\n',
            'data: [DONE]\n\n',
        ], cancelled)));

        const data = await safeFetchJson(
            'https://api.test/v1/chat/completions',
            { method: 'POST', body: '{"stream":true}' },
            0,
            0,
            undefined,
            {},
        );
        expect(data.choices[0].message.content).toBe('已经生成完');
        expect(cancelled).toHaveBeenCalledOnce();
    });

    it('缺少 [DONE] 时也可由 finish_reason 收口长连接', async () => {
        const cancelled = vi.fn();
        vi.stubGlobal('fetch', vi.fn(async () => lingeringSseResponse([
            'data: {"choices":[{"delta":{"content":"最后正文"}}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        ], cancelled)));

        const data = await safeFetchJson(
            'https://api.test/v1/chat/completions',
            { method: 'POST', body: '{"stream":true}' },
            0,
            0,
            undefined,
            {},
        );
        expect(data.choices[0].message.content).toBe('最后正文');
        expect(data.choices[0].finish_reason).toBe('stop');
        expect(cancelled).toHaveBeenCalledOnce();
    });

    it('tool_calls 分片按 index 合并，不因流式丢失', async () => {
        const events = [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"propose_cart_items","arguments":"{\\"items\\""}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":[]}"}}]}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));

        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, { onDelta: () => {} });
        const tc = data.choices[0].message.tool_calls;
        expect(tc).toHaveLength(1);
        expect(tc[0].id).toBe('call_1');
        expect(tc[0].function.name).toBe('propose_cart_items');
        expect(tc[0].function.arguments).toBe('{"items":[]}');
    });

    it('代理返回整包 JSON（无视 stream）时退化解析，onDelta 不触发', async () => {
        const json = { choices: [{ message: { role: 'assistant', content: '整包回复' }, finish_reason: 'stop' }] };
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(json), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        })));

        const deltas: string[] = [];
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, {
            onDelta: (d) => { deltas.push(d); },
        });
        expect(deltas).toEqual([]);
        expect(data.choices[0].message.content).toBe('整包回复');
    });

    it('代理把整包 JSON 错标为 event-stream 时仍按 JSON 解析', async () => {
        const json = { choices: [{ message: { role: 'assistant', content: '错标但有效' }, finish_reason: 'stop' }] };
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(json), {
            status: 200, headers: { 'Content-Type': 'text/event-stream' },
        })));
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0);
        expect(data.choices[0].message.content).toBe('错标但有效');
    });

    it('不传 streamHooks 时对 SSE 响应仍走整包拼接（旧行为不变）', async () => {
        const events = [
            'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0);
        expect(data.choices[0].message.content).toBe('ab');
    });

    it('不传 streamHooks 时忽略 OpenRouter 心跳并继续拼接 data', async () => {
        const events = [
            ': OPENROUTER PROCESSING\n\n',
            ': OPENROUTER PROCESSING\n\n',
            'data: {"choices":[{"delta":{"content":"印象"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"完成"}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0);
        expect(data.choices[0].message.content).toBe('印象完成');
    });

    it('真流式读取时首块只有 OpenRouter 心跳也不会误判为普通文本', async () => {
        const events = [
            ': OPENROUTER PROCESSING\n\n',
            'data: {"choices":[{"delta":{"content":"正常"}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
        const deltas: string[] = [];
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, {
            onDelta: delta => { deltas.push(delta); },
        });
        expect(deltas).toEqual(['正常']);
        expect(data.choices[0].message.content).toBe('正常');
    });

    it('只有心跳就结束时明确报流式无有效数据，不伪造成功结果', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
            ': OPENROUTER PROCESSING\n\n',
            ': OPENROUTER PROCESSING\n\n',
        ])));
        await expect(
            safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0),
        ).rejects.toThrow('API流式响应未返回有效数据');
    });
});

describe('SSE 拼装保留思考通道 (reasoning_content)', () => {
    it('delta.reasoning_content 累积进 message.reasoning_content（思维链显示依赖它）', async () => {
        const events = [
            'data: {"choices":[{"delta":{"reasoning_content":"她这句是在"}}]}\n\n',
            'data: {"choices":[{"delta":{"reasoning_content":"逗我玩…"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"哼，看穿你了"}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
        const reasoningDeltas: string[] = [];
        let fullReasoning = '';
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, {
            onDelta: () => {},
            onReasoningDelta: (delta, full) => { reasoningDeltas.push(delta); fullReasoning = full; },
        });
        expect(data.choices[0].message.reasoning_content).toBe('她这句是在逗我玩…');
        expect(data.choices[0].message.content).toBe('哼，看穿你了');
        expect(reasoningDeltas.join('')).toBe('她这句是在逗我玩…');
        expect(fullReasoning).toBe('她这句是在逗我玩…');
    });

    it('OpenRouter 形态 delta.reasoning 同样保留，并通过独立回调实时吐出思考', async () => {
        const events = [
            'data: {"choices":[{"delta":{"reasoning":"thinking..."}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"回复正文"}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
        const deltas: string[] = [];
        const reasoningDeltas: string[] = [];
        let fullReasoning = '';
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, {
            onDelta: (d) => { deltas.push(d); },
            onReasoningDelta: (d, full) => { reasoningDeltas.push(d); fullReasoning = full; },
        });
        expect(data.choices[0].message.reasoning_content).toBe('thinking...');
        expect(deltas.join('')).toBe('回复正文');
        expect(reasoningDeltas.join('')).toBe('thinking...');
        expect(fullReasoning).toBe('thinking...');
    });

    it('没有思考通道时不产生空的 reasoning_content 字段', async () => {
        const events = ['data: {"choices":[{"delta":{"content":"普通回复"}}]}\n\n', 'data: [DONE]\n'];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, { onDelta: () => {} });
        expect(data.choices[0].message).not.toHaveProperty('reasoning_content');
    });
});

describe('SSE 思考通道的更多字段形状（Claude 官转/CC 渠道）', () => {
    it('delta.thinking 字符串形态保留', async () => {
        const events = [
            'data: {"choices":[{"delta":{"thinking":"内心 os…"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"正文"}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, { onDelta: () => {} });
        expect(data.choices[0].message.reasoning_content).toBe('内心 os…');
        expect(data.choices[0].message.content).toBe('正文');
    });

    it('Anthropic 透传分块 content：text 进正文、thinking 进思考', async () => {
        const events = [
            'data: {"choices":[{"delta":{"content":[{"type":"thinking","thinking":"想一下…"},{"type":"text","text":"你好"}]}}]}\n\n',
            'data: {"choices":[{"delta":{"content":[{"type":"text","text":"呀"}]}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
        const deltas: string[] = [];
        const reasoningDeltas: string[] = [];
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, {
            onDelta: (d) => { deltas.push(d); },
            onReasoningDelta: (d) => { reasoningDeltas.push(d); },
        });
        expect(data.choices[0].message.content).toBe('你好呀');
        expect(data.choices[0].message.reasoning_content).toBe('想一下…');
        expect(deltas.join('')).toBe('你好呀');
        expect(reasoningDeltas.join('')).toBe('想一下…');
    });
});
