// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppErrorBoundary from '../components/os/AppErrorBoundary';
import * as recovery from './chunkLoadRecovery';

const mocks = vi.hoisted(() => ({ trackEvent: vi.fn(), reload: vi.fn(), closeApp: vi.fn(), copy: vi.fn() }));
vi.mock('./analytics', () => ({ trackEvent: mocks.trackEvent }));
vi.mock('../constants', () => ({ INSTALLED_APPS: [{ id: 'chat', name: 'Message' }], HIDDEN_APP_NAMES: {} }));

const POISON = 'private-error-should-never-be-uploaded';
const PRIVATE_CHARACTER_ID = 'private-character-id';
const failure = new TypeError(`Failed to fetch dynamically imported module: https://private.invalid/${POISON}`);
let root: Root;
let host: HTMLDivElement;
let network: { onLine: boolean; clipboard: { writeText: typeof mocks.copy } };

function BrokenApp(): never { throw failure; }

function Shell() {
    const [closed, setClosed] = useState(false);
    return React.createElement(AppErrorBoundary, {
        resetKey: closed ? 'launcher:none' : `chat:${PRIVATE_CHARACTER_ID}`,
        onCloseApp: () => { mocks.closeApp(); setClosed(true); },
        children: closed ? React.createElement('main', null, '桌面') : React.createElement(BrokenApp),
    });
}

async function renderFailure() { await act(async () => root.render(React.createElement(Shell))); }

function button(label: string): HTMLButtonElement {
    const found = [...host.querySelectorAll('button')].find(item => item.textContent === label);
    expect(found).toBeTruthy();
    expect(found!.disabled).toBe(false);
    return found!;
}

async function click(label: string) { await act(async () => button(label).click()); }

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    network = { onLine: true, clipboard: { writeText: mocks.copy.mockResolvedValue(undefined) } };
    vi.stubGlobal('navigator', network);
    // Keep real DOM/event APIs while making the user-triggered reload observable without navigating jsdom.
    vi.stubGlobal('window', Object.create(window, { location: { value: { reload: mocks.reload } } }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sessionStorage.clear();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('AppErrorBoundary resource recovery', () => {
    it.each([
        ['/', 'https://app.invalid/?openApp=chat', 'https://app.invalid/recover.html'],
        ['./', 'https://app.invalid/SullyOS/?openApp=chat', 'https://app.invalid/SullyOS/recover.html'],
        ['./', 'https://app.invalid/SullyOS/index.html', 'https://app.invalid/SullyOS/recover.html'],
        ['/SullyOS/', 'https://app.invalid/SullyOS/', 'https://app.invalid/SullyOS/recover.html'],
    ])('offers same-site recovery after a failed refresh (base %s, page %s)', async (base, page, expected) => {
        vi.stubEnv('BASE_URL', base);
        vi.spyOn(recovery, 'tryAutoReloadForChunkError').mockReturnValue('cooldown');
        await renderFailure();

        const link = host.querySelector<HTMLAnchorElement>('a');
        expect(link?.textContent).toBe('检查更新并修复');
        expect(new URL(link!.getAttribute('href')!, page).href).toBe(expected);
        expect(link?.target).toBe('');
        expect(host.textContent).toContain('刷新无效时');
        expect(mocks.reload).not.toHaveBeenCalled();
        button('刷新重试');
        button('复制报错信息');
        button('返回桌面');
    });

    it('does not offer a web worker recovery page in the native app', async () => {
        vi.stubEnv('MODE', 'capacitor');
        vi.spyOn(recovery, 'tryAutoReloadForChunkError').mockReturnValue('cooldown');
        await renderFailure();
        expect(host.querySelector('a')).toBeNull();
        expect(host.textContent).not.toContain('检查更新并修复');
        button('刷新重试');
    });

    it('keeps offline recovery manual, preserves all recovery controls and uploads no exception or character data', async () => {
        network.onLine = false;
        const attempt = vi.spyOn(recovery, 'tryAutoReloadForChunkError');
        await renderFailure();

        expect(host.textContent).toContain('请联网后点击「刷新重试」');
        expect(host.textContent).not.toContain('正在自动刷新恢复');
        button('刷新重试');
        button('复制报错信息');
        button('返回桌面');
        expect(mocks.reload).not.toHaveBeenCalled();
        expect(mocks.trackEvent).toHaveBeenCalledWith('自动刷新恢复资源加载失败', { 恢复方式: '离线不刷' });

        await act(async () => {
            network.onLine = true;
            window.dispatchEvent(new Event('online'));
        });
        expect(mocks.reload).not.toHaveBeenCalled();
        expect(attempt).toHaveBeenCalledTimes(1);

        await click('复制报错信息');
        expect(mocks.copy).toHaveBeenCalledWith(expect.stringContaining(POISON));
        await click('刷新重试');
        expect(mocks.reload).toHaveBeenCalledTimes(1);
        await click('返回桌面');
        expect(mocks.closeApp).toHaveBeenCalledTimes(1);
        expect(host.textContent).toBe('桌面');

        const uploaded = JSON.stringify(mocks.trackEvent.mock.calls);
        expect(uploaded).not.toContain(POISON);
        expect(uploaded).not.toContain(PRIVATE_CHARACTER_ID);
        expect(uploaded).not.toContain('private.invalid');
    });

    it.each([
        ['storage-unavailable', '存储不可用不刷'],
        ['cooldown', '冷却期内不刷'],
    ] as const)('preserves the explicit %s outcome and manual controls', async (result, recoveryMethod) => {
        vi.spyOn(recovery, 'tryAutoReloadForChunkError').mockReturnValue(result);
        await renderFailure();

        expect(mocks.trackEvent).toHaveBeenCalledWith('自动刷新恢复资源加载失败', { 恢复方式: recoveryMethod });
        expect(host.textContent).not.toContain('请联网后点击');
        button('刷新重试');
        button('复制报错信息');
        button('返回桌面');
        expect(mocks.reload).not.toHaveBeenCalled();
    });
});
