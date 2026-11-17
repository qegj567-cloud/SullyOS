import { beforeEach, describe, expect, it } from 'vitest';
import { DB } from './db';
import { settleInstantChatApiLog } from './amsgInstantChat';
import { settleInstantModelCalls } from './amsgApiCallLog';
import { INSTANT_API_CALLS_RESULT_KIND, makeModelCall, modelCallCauses, parseModelCalls } from './amsgApiCallRecords';
import { dispatchAmsgResult } from './amsgResults';

const pending = () => ({
    id: 'cloud-turn', timestamp: Date.now(), pending: true, ok: true,
    route: 'cloud-instant-chat', model: 'requested-model', baseUrl: 'https://api.example/v1',
    presetName: '我的 API', charId: 'char-1', charName: '角色甲', appId: 'chat', appName: '消息',
    promptBreakdown: [{ label: '角色设定', chars: 500 }], purpose: '聊天回复',
});
const calls = () => [
    makeModelCall({ index: 1, completedAt: Date.now(), causes: [], ok: true,
        usage: { prompt_tokens: 67000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 40000 } },
        response: { model: 'backend-a' } }),
    makeModelCall({ index: 2, completedAt: Date.now() + 10, causes: ['recall'], ok: true,
        usage: { prompt_tokens: 68000, completion_tokens: 2000, cache_creation_input_tokens: 120 },
        response: { model: 'backend-b' } }),
];

beforeEach(async () => { await DB.clearApiCallLog(); });

describe('instant model requests are logged separately', () => {
    it('replaces the pending aggregate with actual requests; only the first retains its local input breakdown', async () => {
        await DB.appendApiCallLog(pending());
        await settleInstantChatApiLog('turn', {
            amsgModelCalls: calls(), amsgUsage: { promptTokens: 135000, completionTokens: 2500 },
            amsgUsageComplete: true, amsgToolTrace: [{ name: 'recall', count: 1 }],
        });
        const rows = await DB.getApiCallLog();
        expect(rows).toHaveLength(2);
        expect(rows.find(row => row.id === 'cloud-turn')).toMatchObject({
            purpose: '聊天回复', promptTokens: 67000, completionTokens: 500, totalTokens: 67500,
            cacheReadTokens: 40000, backendModel: 'backend-a', cloudCallIndex: 1, pending: false,
            promptBreakdown: pending().promptBreakdown,
        });
        expect(rows.find(row => row.id === 'cloud-turn:call:2')).toMatchObject({
            purpose: '查记忆后回复', promptTokens: 68000, completionTokens: 2000, totalTokens: 70000,
            cacheWriteTokens: 120, backendModel: 'backend-b', cloudCallIndex: 2, pending: false,
        });
        expect(rows.find(row => row.cloudCallIndex === 2)?.promptBreakdown).toBeUndefined();
        expect(rows.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(137500);
        for (const row of rows) {
            expect(row).toMatchObject({ model: 'requested-model', presetName: '我的 API', charId: 'char-1' });
            expect(row.cloudUsageAggregated).toBeUndefined();
        }
    });

    it('push/outbox replay and late aggregate/failure updates cannot double-count or overwrite known requests', async () => {
        await DB.appendApiCallLog(pending());
        const records = calls();
        await Promise.all([settleInstantModelCalls('turn', records), settleInstantModelCalls('turn', records)]);
        await DB.appendApiCallLog({ id: 'cloud-turn', pending: false, ok: false, promptTokens: 135000, totalTokens: 137500, tokensPartial: true });
        const rows = await DB.getApiCallLog();
        expect(rows).toHaveLength(2);
        expect(rows.find(row => row.cloudCallIndex === 1)).toMatchObject({ ok: true, promptTokens: 67000, totalTokens: 67500 });
        expect(rows.find(row => row.cloudCallIndex === 1)?.tokensPartial).toBeUndefined();
    });

    it('preserves calls when a response arrives before pending registration, then fills attribution for both', async () => {
        const records = calls();
        await settleInstantModelCalls('turn', records, { charId: 'char-1', charName: '角色甲' });
        await DB.appendApiCallLog(pending());
        const rows = await DB.getApiCallLog();
        expect(rows).toHaveLength(2);
        for (const row of rows) expect(row).toMatchObject({ pending: false, model: 'requested-model', presetName: '我的 API', baseUrl: 'https://api.example/v1' });
        expect(rows.find(row => row.cloudCallIndex === 2)?.promptBreakdown).toBeUndefined();
        expect(rows.find(row => row.cloudCallIndex === 1)?.timestamp).toBe(records[0].completedAt);
    });

    it('records a failed continuation through the durable result dispatcher without inventing its usage', async () => {
        await DB.appendApiCallLog(pending());
        const first = calls()[0];
        const payload = { resultKind: INSTANT_API_CALLS_RESULT_KIND, taskUuid: 'turn', charId: 'char-1', calls: [first,
            { index: 2, completedAt: Date.now() + 10, causes: ['schedule'], ok: false, status: 429 }], notification: { show: false } };
        expect(await dispatchAmsgResult(payload)).toBe(true);
        expect(await dispatchAmsgResult(payload)).toBe(true);
        const rows = await DB.getApiCallLog();
        expect(rows).toHaveLength(2);
        const failed = rows.find(row => row.cloudCallIndex === 2);
        expect(failed).toMatchObject({ ok: false, status: 429, purpose: '主动消息排程后回复' });
        expect(failed?.promptTokens).toBeUndefined();
        expect(failed?.totalTokens).toBeUndefined();
        expect(rows.find(row => row.cloudCallIndex === 1)?.ok).toBe(true);
    });

    it('keeps one row for a request following multiple tools, including when the provider omits usage', async () => {
        const causes = modelCallCauses(['recall', 'schedule_active_message', 'recall', 'web_search']);
        await settleInstantModelCalls('turn', [calls()[0], makeModelCall({ index: 2, completedAt: Date.now() + 10, causes, ok: true })]);
        const rows = await DB.getApiCallLog();
        expect(rows).toHaveLength(2);
        expect(rows.find(row => row.cloudCallIndex === 2)).toMatchObject({ purpose: '查记忆、主动消息排程、搜索后回复', ok: true });
        expect(rows.find(row => row.cloudCallIndex === 2)?.totalTokens).toBeUndefined();
    });

    it('validates incoming records and drops private provider fields', () => {
        const record = { ...calls()[0], apiKey: 'private', baseUrl: 'private', usage: { secret: 'private' }, toolArguments: 'private' };
        expect(JSON.stringify(parseModelCalls([record]))).not.toContain('private');
        expect(parseModelCalls([{ ...record, promptTokens: -1 }])).toBeNull();
        expect(parseModelCalls([{ ...record, index: 2 }])).toBeNull();
        expect(parseModelCalls([{ ...record, causes: ['untrusted-label'] }])).toBeNull();
    });
});
