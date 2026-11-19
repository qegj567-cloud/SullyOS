// @vitest-environment jsdom
import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AmsgRecentUpdatePopup, SullySupportNotice } from '../components/os/NovemberUpdatePopups';
import { UpdateNotificationController, shouldShowUpdateNotification } from '../components/UpdateNotificationEvent';
import { AMSG_RECENT_UPDATE_KEY, HELP_STICKERS_UPDATE_KEY, SULLY_SUPPORT_NOTICE_KEY } from './novemberNotices';
import { appShortcutLaunch } from './appShortcutLaunch';
import { SULLY_HELP_DESK_ID } from './sullyIdentity';
import * as analytics from './analytics';
import { createSpaceStorage } from './userSpaces';
import { handleLocalBack } from './localBackHandlers';
import { requestSettingsFocus } from './settingsNavigation';
import { AppID } from '../types';

const { openApp } = vi.hoisted(() => ({ openApp: vi.fn() }));
vi.mock('../context/OSContext', () => ({ useOS: () => ({ openApp }) }));
vi.mock('./settingsNavigation', () => ({ requestSettingsFocus: vi.fn() }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.clearAllMocks();
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label)!;
const renderQueue = async (onClose = vi.fn()) => {
    await act(async () => root.render(React.createElement(StrictMode, {}, React.createElement(UpdateNotificationController, { onClose }))));
    return onClose;
};

it('shows both features once, opens the help desk, and respects existing support acknowledgements', async () => {
    localStorage.setItem(SULLY_SUPPORT_NOTICE_KEY, '1');
    const track = vi.spyOn(analytics, 'trackEvent').mockImplementation(() => {});
    const close = await renderQueue();
    expect(host.querySelector('h2')?.textContent).toBe('Sully-11 答疑与表情包更新');
    expect(host.textContent).toContain('图床表情只保存链接');
    act(() => button('问 Sully-11').click());
    expect(close).toHaveBeenCalledOnce();
    expect(openApp).toHaveBeenCalledWith(AppID.FAQ);
    expect(appShortcutLaunch.consume(AppID.FAQ)).toEqual({ appId: AppID.FAQ, entryId: SULLY_HELP_DESK_ID });
    expect(track.mock.calls).toEqual([
        ['弹出版本更新提醒', { 版本: 'changelog-2026-11-19-help-stickers' }],
        ['点立刻体验', { 版本: 'changelog-2026-11-19-help-stickers' }],
        ['打开 Sully-11', { 入口: '更新提醒' }],
    ]);
    expect(createSpaceStorage(localStorage, 'u_other').getItem(HELP_STICKERS_UPDATE_KEY)).toBe('1');
    expect(localStorage.getItem(AMSG_RECENT_UPDATE_KEY)).toBeNull();
    await act(async () => root.render(null));
    await renderQueue();
    act(() => button('知道了').click());
    expect(host.querySelector('dialog')).toBeNull();
    expect(shouldShowUpdateNotification()).toBe(false);
});

it('advances from the recap to support once and preserves two independent global acknowledgements', async () => {
    const firstClose = await renderQueue();
    act(() => button('知道了').click());
    expect(firstClose).toHaveBeenCalledOnce();
    await act(async () => root.render(null));
    const close = await renderQueue();
    expect(host.querySelector('h2')?.textContent).toBe('最近的主动消息更新');
    expect(localStorage.getItem(AMSG_RECENT_UPDATE_KEY)).toBeNull();
    expect(localStorage.getItem(SULLY_SUPPORT_NOTICE_KEY)).toBeNull();
    const done = button('知道了');
    act(() => { done.click(); done.click(); });
    expect(host.querySelector('h2')?.textContent).toBe('打赏 Sully');
    expect(localStorage.getItem(AMSG_RECENT_UPDATE_KEY)).toBe('1');
    expect(localStorage.getItem(SULLY_SUPPORT_NOTICE_KEY)).toBeNull();
    act(() => button('知道了').click());
    expect(close).toHaveBeenCalledOnce();
    for (const key of [AMSG_RECENT_UPDATE_KEY, SULLY_SUPPORT_NOTICE_KEY]) {
        expect(createSpaceStorage(localStorage, 'u_other').getItem(key)).toBe('1');
    }
    expect(localStorage.length).toBe(3);
});

it('navigating to active-message settings leaves support unread for the next launch', async () => {
    localStorage.setItem(HELP_STICKERS_UPDATE_KEY, '1');
    const close = await renderQueue();
    act(() => button('去主动消息设置').click());
    expect(requestSettingsFocus).toHaveBeenCalledWith('amsg2');
    expect(openApp).toHaveBeenCalledWith(AppID.Settings);
    expect(close).toHaveBeenCalledOnce();
    expect(localStorage.getItem(SULLY_SUPPORT_NOTICE_KEY)).toBeNull();
    await act(async () => root.render(null));
    await renderQueue();
    expect(host.querySelector('h2')?.textContent).toBe('打赏 Sully');
    act(() => button('去看看').click());
    expect(requestSettingsFocus).toHaveBeenLastCalledWith('support');
    expect(localStorage.getItem(SULLY_SUPPORT_NOTICE_KEY)).toBe('1');
});

it('does not offer either notice again after acknowledgement, or offer the retired standalone relay notice', async () => {
    localStorage.setItem(HELP_STICKERS_UPDATE_KEY, '1');
    expect(shouldShowUpdateNotification()).toBe(true);
    localStorage.setItem(AMSG_RECENT_UPDATE_KEY, '1');
    expect(shouldShowUpdateNotification()).toBe(true);
    localStorage.setItem(SULLY_SUPPORT_NOTICE_KEY, '1');
    expect(shouldShowUpdateNotification()).toBe(false);
    await renderQueue();
    expect(host.querySelector('dialog')).toBeNull();
});

it.each(['close', 'back', 'cancel'])('supports %s when storage is unavailable', async action => {
    const onDone = vi.fn(), onVisit = vi.fn();
    await act(async () => root.render(React.createElement(SullySupportNotice, { onDone, onVisit })));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
    act(() => {
        if (action === 'back') expect(handleLocalBack()).toBe(true);
        else if (action === 'cancel') host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true }));
        else host.querySelector<HTMLButtonElement>('[aria-label="关闭打赏 Sully"]')!.click();
    });
    expect(onDone).toHaveBeenCalledOnce(); expect(onVisit).not.toHaveBeenCalled();
});

it.each([['https://friedsully.com/', true], ['https://fork.example.com/', false]] as const)(
    'only includes the relay section when available on %s', async (href, offered) => {
        vi.stubGlobal('location', { href });
        try {
            await act(async () => root.render(React.createElement(AmsgRecentUpdatePopup, { onDone: vi.fn(), onVisit: vi.fn() })));
            expect(host.textContent?.includes('大陆直连中转上线')).toBe(offered);
            expect(host.textContent).toContain('见面可以暂时挂起了');
        } finally { vi.unstubAllGlobals(); }
    },
);
