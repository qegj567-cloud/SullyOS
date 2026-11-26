import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./amsgStateSync', () => ({ syncAmsgLlmCredentials: vi.fn() }));

import type { APIConfig } from '../types';
import { syncAmsgLlmCredentials } from './amsgStateSync';
import { mergeApiConfigUpdate } from './apiConfigNormalize';
import { FAKE_LLM_STORAGE_KEY, isOnFakeLlm, readFakeLlmState, restoreFromFakeLlm, switchToFakeLlm } from './fakeLlmSwitch';
import { isSharedSpaceKey } from './userSpaces';
import { privateLocalExcluded } from './userSpaceBackup';

// 照 OSContext.updateApiConfig 落盘：同一个 mergeApiConfigUpdate，再写 os_api_config。
let current: APIConfig;
const updateApiConfig = (updates: Partial<APIConfig>) => {
    current = mergeApiConfigUpdate(current, updates);
    localStorage.setItem('os_api_config', JSON.stringify(current));
};
// 比内容不比键顺序：恢复时预设引用是重新写回的，JSON 里会排到后面，读出来的配置完全一样。
const stored = () => JSON.parse(localStorage.getItem('os_api_config') || 'null');
const seed = (config: APIConfig) => { current = config; localStorage.setItem('os_api_config', JSON.stringify(config)); };

const REAL: APIConfig = {
    baseUrl: 'https://api.example.com/v1', apiKey: 'sk-real-小明的key', model: 'gpt-real', stream: true, temperature: 0.7, maxTokens: 6000,
    presetId: 'preset-1', presetFp: 'fp-1',
    minimaxApiKey: 'mm-key', emotionApi: { baseUrl: 'https://emo.example.com/v1', apiKey: 'sk-emo', model: 'emo' },
} as APIConfig;

beforeEach(() => {
    localStorage.clear();
    vi.mocked(syncAmsgLlmCredentials).mockClear();
});

describe('换成假模型再换回来', () => {
    it('配置和原来一字不差（含预设引用、语音 Key、情绪副 API）', () => {
        seed(REAL);
        const before = stored();
        switchToFakeLlm(current, 'http://127.0.0.1:8791/v1/', 'fake/side-effects', updateApiConfig);
        expect(current).toMatchObject({ baseUrl: 'http://127.0.0.1:8791/v1', apiKey: 'fake-llm', model: 'fake/side-effects', apiType: 'openai' });
        expect(current.presetId).toBeUndefined();
        expect(current.minimaxApiKey).toBe('mm-key');
        expect(restoreFromFakeLlm(updateApiConfig)).toBe(true);
        expect(stored()).toStrictEqual(before);
        expect(readFakeLlmState().backup).toBeUndefined();
    });

    it('原来没有的字段（apiType、stream）换回来后也没有', () => {
        seed({ baseUrl: 'https://api.anthropic.com/v1/messages', apiKey: 'sk-ant', model: 'claude' } as APIConfig);
        const before = stored();
        switchToFakeLlm(current, 'https://fake.example.workers.dev/v1', 'fake/basic', updateApiConfig);
        restoreFromFakeLlm(updateApiConfig);
        expect(stored()).toStrictEqual(before);
    });

    it('在假模型上连换几个场景，备份仍是最初那套真 Key', () => {
        seed(REAL);
        const before = stored();
        switchToFakeLlm(current, 'http://127.0.0.1:8791/v1', 'fake/basic', updateApiConfig);
        switchToFakeLlm(current, 'http://127.0.0.1:8791/v1', 'fake/delay-6m', updateApiConfig);
        expect(current.model).toBe('fake/delay-6m');
        restoreFromFakeLlm(updateApiConfig);
        expect(stored()).toStrictEqual(before);
    });

    it('换过去和换回来都强制覆盖云端凭据，用的是刚落盘的那份', () => {
        seed(REAL);
        switchToFakeLlm(current, 'http://127.0.0.1:8791/v1', 'fake/basic', updateApiConfig);
        expect(syncAmsgLlmCredentials).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'fake-llm', model: 'fake/basic' }));
        expect(vi.mocked(syncAmsgLlmCredentials).mock.calls[0][1]).toBeUndefined(); // 不带 onlyIfChanged
        restoreFromFakeLlm(updateApiConfig);
        expect(syncAmsgLlmCredentials).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: REAL.apiKey, model: REAL.model }));
    });

    it('备份写不进去时不换 API', () => {
        seed(REAL);
        const before = stored();
        const broken = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
        expect(() => switchToFakeLlm(current, 'http://127.0.0.1:8791/v1', 'fake/basic', updateApiConfig, broken)).toThrow();
        expect(stored()).toStrictEqual(before);
    });

    it('地址或场景不对时直接拒绝', () => {
        seed(REAL);
        expect(() => switchToFakeLlm(current, '127.0.0.1:8791', 'fake/basic', updateApiConfig)).toThrow();
        expect(() => switchToFakeLlm(current, 'http://127.0.0.1:8791/v1', 'gpt-4o', updateApiConfig)).toThrow();
        expect(isOnFakeLlm(current)).toBe(false);
    });

    it('没有备份时恢复什么都不做', () => {
        seed(REAL);
        expect(restoreFromFakeLlm(updateApiConfig)).toBe(false);
        expect(current).toEqual(REAL);
    });
});

it('备份键全局共用、不进备份导出', () => {
    expect(isSharedSpaceKey(FAKE_LLM_STORAGE_KEY)).toBe(true);
    expect(privateLocalExcluded(FAKE_LLM_STORAGE_KEY)).toBe(true);
});

it('面板只经 fakeLlmSwitch 改 API，不直接写 os_api_config', () => {
    const src = readFileSync(new URL('../components/FakeLlmDebugSection.tsx', import.meta.url), 'utf8');
    expect(src).toContain('switchToFakeLlm(');
    expect(src).toContain('restoreFromFakeLlm(');
    expect(src).toContain('updateApiConfig');
    expect(src).not.toMatch(/os_api_config|localStorage\.setItem/);
});
