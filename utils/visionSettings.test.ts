// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Settings from '../apps/Settings';
import type { APIConfig } from '../types';

vi.mock('../context/OSContext', () => ({ useOS: () => context }));
vi.mock('../components/os/Modal', () => ({ default: () => null }));
vi.mock('../components/settings/VersionInfo', () => ({ default: () => null }));
vi.mock('../components/settings/StorageUsagePanel', () => ({ default: () => null }));
vi.mock('../components/settings/ActiveMsgGlobalSettingsModal', () => ({ default: () => null }));
vi.mock('../components/settings/PushVapidSettingsModal', () => ({ PushVapidSettingsModal: () => null }));
vi.mock('../components/settings/ApiCallLogModal', () => ({ default: () => null }));
vi.mock('./avatarModelBackup', () => ({ getAvatarModelBackupInventory: async () => ({ models: [], totalBytes: 0 }) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let context: any;
let saved: APIConfig;
const container = document.createElement('div');
const root = createRoot(container);
function Harness() {
    const [apiConfig, setApiConfig] = useState(saved);
    context = {
        isDataLoaded: true,
        apiConfig, updateApiConfig: (patch: Partial<APIConfig>) => {
            saved = { ...saved, ...patch };
            localStorage.setItem('os_api_config', JSON.stringify(saved));
            setApiConfig(saved);
        },
        theme: {}, realtimeConfig: {}, cloudBackupConfig: {}, characters: [], groups: [],
        userProfile: {}, apiPresets: [], availableModels: [], sysOperation: { status: 'idle' },
        addToast: vi.fn(),
    };
    return createElement(Settings);
}
function visionSection() {
    return Array.from(container.querySelectorAll('section')).find(section => section.querySelector('h2')?.textContent === '识图 API')!;
}
async function openVision() {
    await act(async () => { visionSection().querySelector('button')!.click(); });
}
afterEach(async () => { await act(async () => { root.render(null); }); vi.restoreAllMocks(); });

describe('识图设置开关', () => {
    it('首次配置未填完整时不接入，关闭也保留尚未保存的输入', async () => {
        saved = { baseUrl: 'https://main.test/v1', apiKey: 'main-key', model: 'main' };
        await act(async () => { root.render(createElement(Harness)); });
        await openVision();
        await act(async () => { visionSection().querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
        expect(saved.visionApi?.enabled).not.toBe(true);
        expect(visionSection().textContent).toContain('未接入');
        const urlInput = visionSection().querySelector<HTMLInputElement>('input[type="text"]')!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(urlInput, 'https://draft.test/v1');
            urlInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => { visionSection().querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
        expect(saved.visionApi?.enabled).toBe(false);
        expect(urlInput.value).toBe('https://draft.test/v1');
    });

    it('关掉立即改变徽标并落盘，重新打开设置保持关闭，凭据保留', async () => {
        saved = { baseUrl: 'https://main.test/v1', apiKey: 'main-key', model: 'main',
            visionApi: { enabled: true, baseUrl: 'https://vision.test/v1', apiKey: 'vision-key', model: 'vision' } };
        await act(async () => { root.render(createElement(Harness)); });
        await openVision();
        expect(visionSection().textContent).toContain('已接入');
        await act(async () => { visionSection().querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
        expect(visionSection().querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
        expect(visionSection().textContent).toContain('未接入');
        expect(JSON.parse(localStorage.getItem('os_api_config')!).visionApi).toEqual({
            enabled: false, baseUrl: 'https://vision.test/v1', apiKey: 'vision-key', model: 'vision',
        });
        await act(async () => { root.render(null); });
        await act(async () => { root.render(createElement(Harness)); });
        await openVision();
        expect(visionSection().querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
        await act(async () => { visionSection().querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
        expect(saved.visionApi?.enabled).toBe(true);
        expect(visionSection().textContent).toContain('已接入');
        expect(saved.model).toBe('main');
    });
});
