import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSessionContext, callLlm, extractAssistantMessage } from '@rei-standard/amsg-shared';
import { amsgHooks } from '../worker/amsg/src/index';
import { buildChatRequestPayload } from './chatRequestPayload';
import { AMSG_FIRE_PACK_KEY, FIRE_PACK_VERSION } from './amsgFirePack';
import { AMSG_TOOL_CONFIG_KEY, AMSG_TOOL_PACK_KEY } from './amsgToolPack';
import { extractApiTokenUsage, scanSseForLog } from './apiCallLog';
import { fetchLlm } from './anthropicApi';

const taskUuid = '3637dae1-1461-4444-a747-34e406f67acc';
const now = new Date('2026-07-25T12:00:00.000Z');
const setting = `UNIQUE_CHARACTER_SETTING\n${'角色设定与已知经历。'.repeat(11000)}`;
const api = { apiUrl: 'https://mock.invalid/v1/chat/completions', apiKey: 'mock', primaryModel: 'gemini-2.5-flash' };

// No live API: inspect the actual SDK request body and return controlled provider usage.
const prepare = async () => {
    const input = {
        scene: 'chat.private' as const,
        char: { id: 'token-audit', name: '阿一', systemPrompt: setting, timeAwarenessEnabled: false, memoryPalaceEnabled: false } as any,
        userProfile: { name: '小明' } as any,
        groups: [], emojis: [], categories: [], contextLimit: 20,
        realtimeConfig: { weatherEnabled: false, newsEnabled: false } as any,
        historyMsgs: [{ id: 1, charId: 'token-audit', role: 'user', type: 'text', content: '我们午饭吃过了，继续聊吧。', timestamp: now.getTime() }] as any[],
    };
    const local = await buildChatRequestPayload({ ...input, timelyByWorker: false });
    const instant = await buildChatRequestPayload({ ...input, timelyByWorker: true });
    const rows = new Map([
        [AMSG_FIRE_PACK_KEY, JSON.stringify({
            v: FIRE_PACK_VERSION, template: 'DO_NOT_SEND_PROACTIVE_TEMPLATE', lastUserMessageAt: now.getTime(),
            tzId: 'Asia/Shanghai', userTzId: 'Asia/Shanghai', targetName: '小明', builtAt: now.getTime(),
            pendingTasks: [], scene: null, selfScheduleEnabled: false,
            chat: { messages: instant.fullMessages, builtAt: now.getTime(), timelyInsertAt: instant.volatileTailIndex },
        })],
        [AMSG_TOOL_PACK_KEY, JSON.stringify({ v: 1, charName: '阿一', xhsEnabled: false, activeMemoryMonths: [], memories: [], timeAwarenessEnabled: false })],
    ]);
    const readState = vi.fn(async (namespace: string) => namespace.startsWith('amsg:char:')
        ? [...rows].map(([key, value]) => ({ key, value }))
        : [{ key: AMSG_TOOL_CONFIG_KEY, value: JSON.stringify({ v: 1, proxyWorkerUrl: '', weatherEnabled: false, newsEnabled: false, notionEnabled: false, feishuEnabled: false }) }]);
    const writeState = vi.fn(async (_namespace: string, entries: Array<{ key: string; value: string | null }>) => {
        for (const { key, value } of entries) value === null ? rows.delete(key) : rows.set(key, value);
        return { upserted: entries.length, skipped: 0, deleted: 0 };
    });
    const scratch = {};
    const metadata = { charId: input.char.id, amsgClientTaskId: 'token-audit-client', amsgMode: 'instant', amsgInstantChat: true };
    const fired: any = await amsgHooks.onBeforeFire({
        task: { id: 42, uuid: taskUuid, contactName: '阿一', recurrenceType: 'none', nextSendAt: now.toISOString(), metadata },
        userId: 'u1', readState, writeState, now, scratch,
    } as any);
    return { local, instant, fired, metadata, scratch, writeState };
};

const finishRound = async (p: Awaited<ReturnType<typeof prepare>>, messages: any[], iteration: number, content: string, usage: object, requests: any[]) => {
    const result = await callLlm({ ...api, messages, tools: p.fired.tools }, {
        requireContent: false,
        fetch: (async (_url, init) => {
            requests.push(JSON.parse(String(init?.body)));
            return new Response(JSON.stringify({ model: 'gemini-2.5-flash-c', choices: [{ message: { role: 'assistant', content } }], usage }));
        }) as typeof fetch,
    });
    const history = [...messages, extractAssistantMessage(result.response)];
    const ctx = buildSessionContext({ sessionId: 'sess_task_42', messages: history, llmResponse: result.response, iteration, contactName: '阿一', metadata: p.metadata, scratch: p.scratch });
    const decision: any = await amsgHooks.onLLMOutput({ ...ctx, taskId: 42, taskUuid, writeState: p.writeState } as any);
    return { decision, history };
};

afterEach(() => vi.restoreAllMocks());

describe('instant SDK request and token accounting', () => {
    it('sends the same long context once; a single provider usage is not doubled', async () => {
        const p = await prepare();
        const requests: any[] = [];
        const localTransport = vi.fn(async (_url: unknown, init?: RequestInit) => {
            requests.push(JSON.parse(String(init?.body)));
            return new Response('{}');
        });
        await fetchLlm(api.apiUrl, { method: 'POST', body: JSON.stringify({ model: api.primaryModel, messages: p.local.fullMessages, stream: true, stream_options: { include_usage: true } }) }, localTransport as typeof fetch);
        const { decision } = await finishRound(p, p.fired.messages, 0, '记得，我们刚吃过午饭。', { prompt_tokens: 67177, completion_tokens: 2098, total_tokens: 69275 }, requests);
        expect(requests).toHaveLength(2); // One ordinary request and one instant request.
        expect(requests[1].messages).toEqual(requests[0].messages);
        expect(JSON.stringify(requests[1]).split('UNIQUE_CHARACTER_SETTING')).toHaveLength(2);
        expect(JSON.stringify(requests[1])).not.toContain('DO_NOT_SEND_PROACTIVE_TEMPLATE');
        expect(requests[0].stream).toBe(true);
        expect(requests[1].stream).toBeUndefined();
        expect(decision.decision).not.toBe('tool-request');
        expect(decision.pushPayloads.at(-1).metadata.amsgUsage).toEqual({ promptTokens: 67177, completionTokens: 2098 });
        expect(decision.pushPayloads.at(-1).metadata.amsgModelCalls).toMatchObject([
            { index: 1, causes: [], promptTokens: 67177, completionTokens: 2098, totalTokens: 69275, backendModel: 'gemini-2.5-flash-c' },
        ]);
    });

    it('counts two genuine API calls after a recall request, with only one copy of context per call', async () => {
        const p = await prepare();
        const requests: any[] = [];
        // Synthetic numbers illustrate the accounting; they do not identify the user's historical requests.
        const first = await finishRound(p, p.fired.messages, 0, '[[RECALL: 2026-07]]', { prompt_tokens: 67177, completion_tokens: 509 }, requests);
        expect(first.decision.decision).toBe('tool-request');
        const secondMessages = [...first.history, { role: 'user', content: '查记忆结果：午饭已经一起吃过。' }];
        const second = await finishRound(p, secondMessages, 1, '想起来了，午饭已经一起吃过。', { prompt_tokens: 67877, completion_tokens: 2098 }, requests);
        expect(requests).toHaveLength(2);
        for (const request of requests) expect(JSON.stringify(request).split('UNIQUE_CHARACTER_SETTING')).toHaveLength(2);
        expect(second.decision.pushPayloads.at(-1).metadata).toMatchObject({
            amsgUsage: { promptTokens: 135054, completionTokens: 2607 }, amsgUsageComplete: true,
            amsgModelCalls: [
                { index: 1, causes: [], promptTokens: 67177, completionTokens: 509 },
                { index: 2, causes: ['recall'], promptTokens: 67877, completionTokens: 2098 },
            ],
        });
    });

    it('reads identical provider usage from JSON and SSE without character-based estimation', () => {
        const usage = { prompt_tokens: 67177, completion_tokens: 2098, total_tokens: 69275 };
        const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: '在的' } }], usage })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`;
        expect(extractApiTokenUsage({ usage })).toEqual(extractApiTokenUsage({ usage: scanSseForLog(sse).usage }));
        expect(extractApiTokenUsage({ usage })).toMatchObject({ prompt: 67177, completion: 2098, total: 69275 });
    });
});
