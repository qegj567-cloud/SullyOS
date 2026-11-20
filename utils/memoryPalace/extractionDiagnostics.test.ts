import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../types';
import { selfCheck } from '../errorSelfCheck';
import { ApplicationErrorReport, buildConsoleErrorSystemLog } from '../networkFailureDiagnosis';
import { assembleUpgradedResponse } from '../streamUpgrade';
import type { LlmRequestInit } from '../llmEndpoint';
import { extractMemoriesFromBuffer } from './extraction';

vi.mock('../apiCallLog', async importOriginal => ({
    ...await importOriginal<typeof import('../apiCallLog')>(),
    recordApiCall: vi.fn(),
}));

const config = { baseUrl: 'https://memory.example/v1', model: 'memory-model', apiKey: 'private-test-key' };
const messages: Message[] = [{ id: 7, charId: 'c', role: 'user', type: 'text', content: 'private chat text', timestamp: 12345 }];
const extract = (api = config) => extractMemoriesFromBuffer(messages, 'c', '测试角色', api);

describe('the memory extraction error shown in the status bar', () => {
    beforeEach(() => {
        localStorage.clear();
        localStorage.setItem('os_memory_palace_config', JSON.stringify({ lightLLM: config }));
        localStorage.setItem('os_api_presets', JSON.stringify([
            { name: '另一套凭据', config: { ...config, apiKey: 'different' } },
            { name: '记忆专线', config },
        ]));
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

    function report() {
        const reports = vi.mocked(console.error).mock.calls.map(args => args[0]).filter(r => r instanceof ApplicationErrorReport);
        expect(reports).toHaveLength(1);
        const item = reports[0];
        const log = buildConsoleErrorSystemLog({ message: String(item), report: item, ambientMeta: {appName: '见面'} });
        expect(log.context).toMatchObject({attributionMode: 'explicit', appName: '记忆宫殿', purpose: '记忆提取', model: config.model});
        expect(log.detail).not.toContain('见面');
        expect(JSON.stringify(log)).not.toContain(config.apiKey);
        expect(JSON.stringify(log)).not.toContain(messages[0].content);
        const card = selfCheck(log);
        expect(card.action).toContain(config.model);
        expect(card.action).toContain('memory.example');
        return { card, log };
    }

    it('names the selected API and model on a network failure without inventing a status', async () => {
        const failure = new TypeError('Type error');
        const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);
        await expect(extract()).rejects.toBe(failure);
        const { card, log } = report();
        expect(card.title).toContain('API 请求失败');
        expect(card.action).toContain('记忆宫殿副 API / 记忆专线');
        expect(card.action).not.toContain('HTTP');
        expect(log.context?.httpStatus).toBeUndefined();
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('reports an HTTP rejection even when the error body is malformed', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(messages[0].content, {status: 429}));
        await expect(extract()).rejects.toThrow();
        const { card } = report();
        expect(card.title).toContain('API 请求失败');
        expect(card.action).toContain('HTTP 429');
    });

    it('identifies a main API fallback without copying credentials or query parameters into the card', async () => {
        const main = {...config, baseUrl: 'https://user:secret@memory.example/v1?token=private-query'};
        localStorage.setItem('os_api_config', JSON.stringify(main));
        localStorage.removeItem('os_memory_palace_config');
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(extract(main)).rejects.toThrow();
        const { card, log } = report();
        expect(card.action).toContain('全局主 API / memory.example');
        expect(JSON.stringify(log)).not.toMatch(/user:secret|private-query/);
    });

    it.each([
        ['invalid HTTP body', config, 'private chat text'],
        ['invalid model output', config, JSON.stringify({choices: [{message: {content: 'private chat text'}}]})],
        ['invalid Anthropic envelope', {...config, baseUrl: 'https://memory.example/v1/messages'}, 'private chat text'],
    ] as const)('retains the successful HTTP status when parsing fails: %s', async (_case, api, body) => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, {status: 200}));
        await expect(extract(api)).rejects.toThrow();
        const { card, log } = report();
        expect(card.title).toContain('收到回复后解析失败');
        expect(card.action).toContain('HTTP 200');
        expect(log.context?.httpStatus).toBe(200);
    });

    it.each([false, true])('distinguishes an interrupted response body, stream upgrade = %s', async upgrade => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
            const response = new Response(new ReadableStream({start(controller) { controller.error(new TypeError('Load failed')); }}), {status: 201});
            return upgrade ? assembleUpgradedResponse(response, (init as LlmRequestInit).__sullyResponseInfo) : response;
        });
        await expect(extract()).rejects.toThrow('Load failed');
        const { card } = report();
        expect(card.title).toContain('读取正文失败');
        expect(card.action).toContain('HTTP 201');
    });
});
