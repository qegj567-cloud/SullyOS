// @vitest-environment jsdom
// 人格模拟接入云端代跑的回归守卫：本机与云端共用同一份请求和校验；云端结果不合格按失败收尾、不落库；
// 落地只并 simLogs 且按 id 去重；指示条状态从代跑登记表派生（重开页面还在）；
// 「云端生成」小条只在 Worker 确认收下且没选不再提醒时出现；重播不盖掉在飞的云端任务。
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, PhoneSimLog, SimScript } from '../types';

const h = vi.hoisted(() => ({
    submit: vi.fn(),
    openApp: vi.fn(),
    addToast: vi.fn(),
    messages: [{ role: 'system', content: '角色设定' }, { role: 'user', content: '导演指令' }],
}));
vi.mock('../context/OSContext', () => ({ useOS: () => ({ openApp: h.openApp, addToast: h.addToast }) }));
vi.mock('./cloudGen/submit', () => ({ trySubmitCloudGeneration: h.submit }));
vi.mock('./chatContextRange', () => ({ loadCharacterContextMessages: async () => [] }));
vi.mock('./memoryPalace/pipeline', () => ({ injectMemoryPalace: vi.fn(async () => {}) }));
vi.mock('./context', () => ({ ContextBuilder: { buildCharacterRequest: vi.fn(async () => h.messages) } }));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

import { generatePersonaScript } from '../apps/PersonaSim';
import PersonaSimIndicator from '../components/os/PersonaSimIndicator';
import { lander } from './cloudGen/landers/personaSim';
import { getCloudGenSheet, closeCloudGenSheet, setCloudGenHintOff } from './cloudGen/hint';
import { markCloudGenJobFailed, getCloudGenJobById, putCloudGenJob, updateCloudGenJob } from './cloudGen/registry';
import { CLOUD_GEN_JOBS_KEY, type CloudGenJobRecord, type CloudGenResponse } from './cloudGen/types';
import { DB } from './db';
import { mergePersonaSimLogs, PERSONA_SIM_CLOUD_FAILED, PERSONA_SIM_LOG_LANDED, validatePersonaScriptResponse } from './personaSimLog';
import { personaSimStore } from './personaSimStore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SCRIPT: SimScript = { title: '雨天', summary: '雨停了', beats: [{ kind: 'lock' }, { kind: 'end' }] };
const NO_END: SimScript = { title: '雨天', summary: '', beats: [{ kind: 'lock' }, { kind: 'thought', monologue: '……' }] };
const response = (content: string, finishReason: string | null = 'stop'): CloudGenResponse => ({
    choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }],
});
const record = (overrides: Partial<CloudGenJobRecord> = {}): CloudGenJobRecord => ({
    jobId: 'job-1', purpose: 'persona-sim', charId: 'c1', charName: '小明', uuid: 'u1',
    submittedAt: Date.now(), snapshotAt: Date.now(), acceptedAt: Date.now(), status: 'running', notify: true,
    context: { mode: 'daily', theme: '雨天' },
    ...overrides,
});
const char = (overrides: Partial<CharacterProfile> = {}) => ({
    id: 'c1', name: '小明', phoneState: { records: [], customApps: [{ id: 'app' }], simLogs: [] }, ...overrides,
} as unknown as CharacterProfile);

beforeEach(async () => {
    localStorage.clear();
    personaSimStore.reset();
    personaSimStore.clearDeepLink();
    closeCloudGenSheet();
    h.submit.mockReset();
    h.openApp.mockClear();
    h.addToast.mockClear();
    await DB.deleteCharacter('c1').catch(() => {});
});

describe('本机与云端共用一份校验', () => {
    it.each([
        ['截断', response(JSON.stringify(SCRIPT), 'length'), '演出生成被截断'],
        ['被安全策略拦下', response(JSON.stringify(SCRIPT), 'content_filter'), '演出生成被模型安全策略中止'],
        ['结尾不是 end', response(JSON.stringify(NO_END)), '演出结尾不完整'],
    ])('%s：抛出与本机相同的错误', (_label, data, message) => {
        expect(() => validatePersonaScriptResponse(data)).toThrow(message);
    });

    it('交云端时消息与参数与本机直连那次一模一样，本机不再发请求', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        h.submit.mockResolvedValue({ route: 'cloud', jobId: 'job-1' });
        const apiConfig = { baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'm', apiType: 'openai' as const };
        const result = await generatePersonaScript({ char: char(), userProfile: { name: '用户' } as any, apiConfig, mode: 'event', theme: '雨天' });
        expect(result).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
        const input = h.submit.mock.calls[0][0];
        expect(input).toMatchObject({
            purpose: 'persona-sim', messages: h.messages, params: { temperature: 0.98, max_tokens: 24000 },
            api: apiConfig, context: { mode: 'event', theme: '雨天' },
            apiMeta: { appId: 'personasim', appName: '人格模拟', purpose: '生成人格模拟剧本' },
        });

        // 没交成时本机直连：同一份消息和参数，结果走同一道校验。
        h.submit.mockResolvedValue({ route: 'local', reason: 'amsg2-off' });
        fetchSpy.mockResolvedValue(new Response(JSON.stringify(response(JSON.stringify(SCRIPT), 'length')), { status: 200 }));
        await expect(generatePersonaScript({ char: char(), userProfile: { name: '用户' } as any, apiConfig, mode: 'event', theme: '雨天' }))
            .rejects.toThrow('演出生成被截断');
        const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
        expect(body).toEqual({ model: 'm', messages: h.messages, temperature: 0.98, max_tokens: 24000 });
        fetchSpy.mockRestore();
    });
});

describe('云端结果落地', () => {
    it.each([
        ['截断', response(JSON.stringify(SCRIPT), 'length')],
        ['结尾不是 end', response(JSON.stringify(NO_END))],
    ])('%s 的结果按失败收尾：不落库、弹失败提示、小条收起', async (_label, data) => {
        await DB.saveCharacter(char());
        putCloudGenJob(record());
        const failed = vi.fn();
        window.addEventListener(PERSONA_SIM_CLOUD_FAILED, failed);
        const outcome = await lander.land(data, record(), { jobId: 'job-1', purpose: 'persona-sim', charId: 'c1' });
        expect(outcome).toEqual({ failed: expect.objectContaining({ code: 'invalid-output' }) });
        // 判失败之后 results.ts 调 onFailed（那条链在 cloudGen/results.test.ts 里钉着），这里只验收尾本身。
        const failure = (outcome as { failed: { code: string; message: string } }).failed;
        await lander.onFailed!(markCloudGenJobFailed('job-1', failure)!, failure);
        window.removeEventListener(PERSONA_SIM_CLOUD_FAILED, failed);
        expect((await DB.getCharacter('c1'))?.phoneState?.simLogs).toEqual([]);
        expect(failed).toHaveBeenCalledTimes(1);
        expect(getCloudGenJobById('job-1')).toBeNull();
        expect(personaSimStore.pill().status).toBe('idle');
    });

    it('合格的结果归档进 simLogs（id 跟着 job），同一份再来一次也只有一条', async () => {
        await DB.saveCharacter(char({ phoneState: { records: [], simLogs: [{ id: 'old' } as PhoneSimLog] } as any }));
        putCloudGenJob(record());
        const landed = vi.fn();
        window.addEventListener(PERSONA_SIM_LOG_LANDED, landed);
        const data = response(JSON.stringify(SCRIPT));
        expect(await lander.land(data, record(), { jobId: 'job-1', purpose: 'persona-sim', charId: 'c1' })).toBe('landed');
        expect(await lander.land(data, getCloudGenJobById('job-1'), { jobId: 'job-1', purpose: 'persona-sim', charId: 'c1' })).toBe('landed');
        window.removeEventListener(PERSONA_SIM_LOG_LANDED, landed);
        const logs = (await DB.getCharacter('c1'))?.phoneState?.simLogs || [];
        expect(logs.map(log => log.id)).toEqual(['sim-job-1', 'old']);
        expect(logs[0]).toMatchObject({ mode: 'daily', theme: '雨天', script: SCRIPT, playback: { beatIndex: 0, status: 'ready' } });
        expect(landed.mock.calls[0][0].detail).toMatchObject({ charId: 'c1', log: { id: 'sim-job-1' } });
        expect(getCloudGenJobById('job-1')?.context).toEqual({ mode: 'daily', theme: '雨天', logId: 'sim-job-1' });
    });

    it('角色已经删了：丢弃', async () => {
        putCloudGenJob(record());
        expect(await lander.land(response(JSON.stringify(SCRIPT)), record(), { jobId: 'job-1', purpose: 'persona-sim', charId: 'c1' })).toBe('discarded');
    });

    it('并回内存只动 simLogs，按 id 去重，没有新的就原样返回', () => {
        const phoneState = { records: [{ id: 'r' }], customApps: [{ id: 'app' }], simLogs: [{ id: 'a' }] } as any;
        const merged = mergePersonaSimLogs(phoneState, [{ id: 'b' } as PhoneSimLog, { id: 'a' } as PhoneSimLog]);
        expect(merged).toEqual({ records: [{ id: 'r' }], customApps: [{ id: 'app' }], simLogs: [{ id: 'b' }, { id: 'a' }] });
        expect(mergePersonaSimLogs(merged, [{ id: 'b' } as PhoneSimLog])).toBe(merged);
    });
});

describe('指示条状态从登记表派生', () => {
    it('重开页面后：在飞的显示生成中，已落地的显示就绪', async () => {
        localStorage.setItem(CLOUD_GEN_JOBS_KEY, JSON.stringify([record()]));
        vi.resetModules();
        const fresh = (await import('./personaSimStore')).personaSimStore;
        expect(fresh.pill()).toMatchObject({ status: 'loading', theme: '雨天', charId: 'c1', cloud: { jobId: 'job-1', hint: true } });
        localStorage.setItem(CLOUD_GEN_JOBS_KEY, JSON.stringify([record({ status: 'landed', context: { mode: 'daily', theme: '雨天', logId: 'sim-job-1' } })]));
        vi.resetModules();
        const reloaded = (await import('./personaSimStore')).personaSimStore;
        expect(reloaded.forChar('c1')).toMatchObject({ status: 'ready', logId: 'sim-job-1', cloud: { jobId: 'job-1' } });
    });

    it('生活记录重播不盖掉在飞的云端任务；播完收走后还是生成中', () => {
        putCloudGenJob(record());
        personaSimStore.set({ status: 'ready', mode: 'daily', theme: '旧的', script: SCRIPT, logId: 'old', charId: 'c1', charName: '小明' });
        const replay = personaSimStore.forChar('c1');
        expect(replay).toMatchObject({ status: 'ready', logId: 'old' });
        personaSimStore.consume(replay);
        expect(personaSimStore.forChar('c1')).toMatchObject({ status: 'loading', cloud: { jobId: 'job-1' } });
    });

    it('播放云端就绪的那份时从登记表收走', () => {
        putCloudGenJob(record());
        updateCloudGenJob('job-1', { status: 'landed', context: { mode: 'daily', theme: '雨天', logId: 'sim-job-1' } });
        personaSimStore.consume(personaSimStore.forChar('c1'));
        expect(getCloudGenJobById('job-1')).toBeNull();
        expect(personaSimStore.forChar('c1').status).toBe('idle');
    });
});

describe('全局指示条', () => {
    let root: Root;
    let host: HTMLDivElement;
    const render = async () => {
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        await act(async () => root.render(React.createElement(PersonaSimIndicator)));
    };
    afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

    it('Worker 确认收下后自己不挂胶囊：「云端生成」提示交给 CloudGenIndicator，弹 3 秒就收起', async () => {
        putCloudGenJob(record({ notify: false }));
        await render();
        expect(host.textContent).toBe('');
        expect(getCloudGenSheet()).toBeNull();
    });

    it.each([
        ['还在上传（Worker 没确认）', () => putCloudGenJob(record({ acceptedAt: undefined }))],
        ['选了本功能不再提醒', () => { setCloudGenHintOff('persona-sim', true); putCloudGenJob(record()); }],
    ])('%s：保持本机文案，点一下深链回到演出', async (_label, setup) => {
        setup();
        await render();
        expect(host.textContent).toContain('演出生成中 · 小明');
        await act(async () => host.querySelector('button')!.click());
        expect(getCloudGenSheet()).toBeNull();
        expect(personaSimStore.getDeepLink()).toBe('c1');
        expect(h.openApp).toHaveBeenCalled();
    });

    it('云端失败时弹出与本机失败相同的提示', async () => {
        await render();
        await act(async () => { window.dispatchEvent(new CustomEvent(PERSONA_SIM_CLOUD_FAILED, { detail: { charId: 'c1' } })); });
        expect(h.addToast).toHaveBeenCalledWith('演出生成失败，请重试', 'error');
    });
});
