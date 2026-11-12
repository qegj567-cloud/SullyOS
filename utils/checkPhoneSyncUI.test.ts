// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ shortcut: null as any, toast: vi.fn(), sync: vi.fn(), characters: [] as any[] }));
vi.mock('../context/OSContext', () => ({ useOS: () => ({
    characters: mocks.characters, activeCharacterId: 'c', characterGroups: [], apiConfig: {}, apiPresets: [],
    userProfile: { name: '用户' }, closeApp: vi.fn(), updateCharacter: vi.fn(), addToast: mocks.toast,
}) }));
vi.mock('./appShortcutLaunch', () => ({ useAppShortcut: (_app: unknown, handler: unknown) => { mocks.shortcut = handler; } }));
vi.mock('../apps/PersonaSim', () => ({ default: () => null, generatePersonaScript: vi.fn() }));
vi.mock('./personaSimStore', () => ({ usePersonaSim: () => ({ status: 'idle' }), personaSimStore: {} }));
vi.mock('./emotionApply', () => ({ getLastInnerState: () => '' }));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('./db', async importOriginal => {
    const actual = await importOriginal<typeof import('./db')>();
    return { ...actual, DB: { ...actual.DB, syncPhoneEvidenceToChat: mocks.sync } };
});
import CheckPhone from '../apps/CheckPhone';

let root: Root;
let host: HTMLDivElement;
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(node => node.textContent?.includes(label))!;
beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.characters = [{ id: 'c', name: '机主', avatar: '', phoneState: { sendToChat: false, records: [
        { id: 'r', type: 'order', title: '一杯咖啡', detail: '旧记录', timestamp: 100, systemMessageId: 99 },
    ] } }];
    mocks.sync.mockResolvedValue({ inserted: true, messageId: 100 });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(React.createElement(CheckPhone)));
    await act(async () => mocks.shortcut({ characterId: 'c', entryId: 'taobao' }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it.each(['detail', 'menu'])('%s 入口有旧同步编号也允许补发，不依赖自动同步开关', async entry => {
    const record = host.querySelector('[aria-label="查看一杯咖啡详情，长按可同步到私聊"]')!;
    expect(record).not.toBeNull();
    await act(async () => record.dispatchEvent(new MouseEvent(entry === 'detail' ? 'click' : 'contextmenu', { bubbles: true, cancelable: true })));
    const sync = button('检查并补同步到私聊');
    expect(sync).toBeDefined(); expect(sync.disabled).toBe(false);
    await act(async () => sync.click());
    expect(mocks.sync).toHaveBeenCalledWith('c', 'r', '淘宝');
    expect(mocks.toast).toHaveBeenCalledWith('已把这条查手机记录同步到私聊', 'success');
});

it('同步期间防连点，已有卡片给出提示，失败后仍可再试', async () => {
    const record = host.querySelector('[aria-label="查看一杯咖啡详情，长按可同步到私聊"]')!;
    await act(async () => record.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    let reject!: (error: Error) => void;
    mocks.sync.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    const sync = button('检查并补同步到私聊');
    await act(async () => { sync.click(); sync.click(); });
    expect(mocks.sync).toHaveBeenCalledTimes(1); expect(sync.disabled).toBe(true);
    await act(async () => reject(new Error('保存失败')));
    expect(sync.disabled).toBe(false);
    mocks.sync.mockResolvedValueOnce({ inserted: false, messageId: 99 });
    await act(async () => sync.click());
    expect(mocks.toast).toHaveBeenLastCalledWith('私聊中已有这条记录，无需重复同步', 'info');
});
