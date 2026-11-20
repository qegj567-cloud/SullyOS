// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RemoteVectorUpgradeNotice from '../../components/RemoteVectorUpgradeNotice';
import { MemoryNodeDB } from './db';
import type { MemoryNode } from './types';
import { readUpgrade } from './supabaseVector';

const { config, trackEvent, updateRemoteVectorConfig } = vi.hoisted(() => ({
    config: { enabled: true, initialized: true, supabaseUrl: 'https://notice.invalid', supabaseAnonKey: 'private-key' },
    trackEvent: vi.fn(), updateRemoteVectorConfig: vi.fn(),
}));
vi.mock('../../context/OSContext', () => ({ useOS: () => ({
    remoteVectorConfig: config, isDataLoaded: true, openApp: vi.fn(), updateRemoteVectorConfig,
}) }));
vi.mock('../analytics', () => ({ trackEvent }));
const node: MemoryNode = { id: 'n', charId: 'c', content: '私人内容', embedded: true, room: 'study',
    tags: [], importance: 5, mood: '', createdAt: 2, lastAccessedAt: 2, accessCount: 0 };
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    config.enabled = config.initialized = true;
    localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks();
    root = createRoot(document.createElement('div'));
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

it('启用的旧库打开即补传，可关闭提醒继续使用，完成后重开不再弹窗或发请求', async () => {
    await MemoryNodeDB.saveVectorizedMany([{ node, vector: { memoryId: node.id, charId: 'c', vector: [1, 0], dimensions: 2 } }]);
    let ack!: (res: Response) => void;
    const pending = new Promise<Response>(resolve => { ack = resolve; });
    const http = vi.fn(async (url: string, init: RequestInit = {}) => {
        if (url.includes('entities')) return Response.json({ code: '42703' }, { status: 400 });
        if (init.method === 'POST') return pending;
        return Response.json([]);
    });
    vi.stubGlobal('fetch', http);
    await act(async () => { root.render(React.createElement(RemoteVectorUpgradeNotice)); });
    await act(async () => { await vi.waitFor(() => expect(http.mock.calls.some(([, req]) => req?.method === 'POST')).toBe(true)); });
    const notice = document.querySelector('[aria-label="远程记忆更新"]')!;
    expect(notice.textContent).toContain('0/1');
    act(() => notice.querySelector('button')!.click());
    expect(document.querySelector('[aria-label="远程记忆更新"]')).toBeNull();
    await act(async () => {
        ack(new Response(null, { status: 201 }));
        await vi.waitFor(() => expect(readUpgrade(config).done).toBe(true));
    });
    expect(trackEvent.mock.calls).toEqual([['远程记忆自动适配结果', { 结果: '完成' }]]);
    const calls = http.mock.calls.length;
    act(() => root.render(null));
    await act(async () => root.render(React.createElement(RemoteVectorUpgradeNotice)));
    expect(http.mock.calls.length).toBe(calls);
    expect(document.querySelector('[aria-label="远程记忆更新"]')).toBeNull();
});

it('停用时不检查，已启用但待验证的连接通过后自动恢复', async () => {
    const http = vi.fn(async () => Response.json([]));
    vi.stubGlobal('fetch', http);
    config.enabled = false;
    await act(async () => root.render(React.createElement(RemoteVectorUpgradeNotice)));
    expect(http).not.toHaveBeenCalled();
    config.enabled = true;
    config.initialized = false;
    await act(async () => root.render(React.createElement(RemoteVectorUpgradeNotice)));
    await vi.waitFor(() => expect(updateRemoteVectorConfig).toHaveBeenCalledWith({ initialized: true }));
});

it('断线时给出重试入口，网络恢复后自动完成并清除失败提示', async () => {
    await MemoryNodeDB.saveVectorizedMany([{ node, vector: { memoryId: node.id, charId: 'c', vector: [1, 0], dimensions: 2 } }]);
    let offline = true;
    const http = vi.fn(async (_url: string, init: RequestInit = {}) => {
        if (offline) throw new TypeError('private-project-network-detail');
        return init.method === 'POST' ? new Response(null, { status: 201 }) : Response.json([]);
    });
    vi.stubGlobal('fetch', http);
    await act(async () => { root.render(React.createElement(RemoteVectorUpgradeNotice)); });
    await act(async () => { await vi.waitFor(() => expect(trackEvent).toHaveBeenCalledWith('远程记忆自动适配结果', { 结果: '暂停' })); });
    expect(document.body.textContent).toContain('重试');
    expect(document.body.textContent).not.toContain('private-project-network-detail');
    offline = false;
    await act(async () => {
        window.dispatchEvent(new Event('online'));
        await vi.waitFor(() => expect(readUpgrade(config).done).toBe(true));
    });
    expect(document.body.textContent).toContain('已适配完成');
    expect(document.body.textContent).not.toContain('同步已暂停');
});
