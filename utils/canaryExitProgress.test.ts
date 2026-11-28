// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import CanaryChannelControl from '../components/settings/CanaryChannelControl';
import { createSpaceStorage } from './userSpaces';
import { RELEASE_CHANNEL_STORAGE_KEY } from './releaseChannel';

const f = vi.hoisted(() => ({ config: vi.fn(), update: vi.fn() }));
vi.mock('./activeMsgStore', () => ({ ActiveMsgStore: { getGlobalConfig: f.config } }));
vi.mock('./activeMsgClient', () => ({ ActiveMsgClient: { selfUpdateWorker: f.update } }));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('./amsgGlobalGate', () => ({ isAmsg2WorkerActive: (c: {enabled: boolean}) => c.enabled }));
vi.mock('./releaseChannel', async original => ({ ...await original<object>(), RELEASE_CHANNEL: 'canary' }));

const raw = window.localStorage;
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
    await act(async () => root?.unmount());
    vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
    raw.clear(); document.body.replaceChildren();
});

it.each(['cancel', 'disabled', 'success', 'skip', 'failed', 'slow-config'])('exit through confirmation: %s', async scenario => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    const replace = vi.fn();
    vi.stubGlobal('location', { hostname: 'friedsully.com', replace });
    raw.setItem(RELEASE_CHANNEL_STORAGE_KEY, 'canary');
    vi.stubGlobal('localStorage', createSpaceStorage(raw, 'u_other'));
    let finish!: () => void;
    const config = { enabled: scenario !== 'disabled', initializedAt: 1 };
    if (scenario === 'slow-config') f.config.mockImplementation(() => new Promise(resolve => { finish = () => resolve(config); }));
    else f.config.mockResolvedValue(config);
    if (scenario === 'failed') f.update.mockRejectedValue(Error('offline'));
    else f.update.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ok: true}); }));
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label);
    const click = async (el: HTMLButtonElement) => act(async () => el.click());
    await act(async () => root.render(React.createElement(CanaryChannelControl, { unlocked: true })));
    await click(button('正式版')!);
    await click(button(scenario === 'cancel' ? '取消' : '回到正式版')!);
    if (scenario === 'cancel') {
        expect(f.config).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
        expect(host.querySelector('[role=status]')?.textContent).toBe(''); return;
    }
    const status = host.querySelector('[role=status]')!;
    expect(button('切换中…')?.disabled).toBe(true);
    expect(status.textContent).toContain('正在准备');
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    if (scenario === 'skip' || scenario === 'success' || scenario === 'slow-config') {
        expect(status.textContent).toContain(scenario === 'slow-config' ? '正在准备' : 'Worker');
        expect(button('先回正式版')).toBeUndefined();
        expect(replace).not.toHaveBeenCalled();
        await act(async () => vi.advanceTimersByTimeAsync(8000));
        if (scenario !== 'success') await click(button('先回正式版')!);
        await act(async () => finish());
    }
    expect(status.textContent).toContain('正在打开正式版');
    expect(f.update).toHaveBeenCalledTimes(['disabled', 'slow-config'].includes(scenario) ? 0 : 1);
    expect(replace).toHaveBeenCalledTimes(1); expect(replace).toHaveBeenCalledWith('/');
    // The boot gate on the next page reads unwrapped device storage, not the user-space view.
    expect(raw.getItem(RELEASE_CHANNEL_STORAGE_KEY)).toBe('stable');
});
