// @vitest-environment jsdom
import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AmsgRecentUpdatePopup, SullySupportNotice } from '../components/os/NovemberUpdatePopups';
import { UpdateNotificationController, shouldShowUpdateNotification } from '../components/UpdateNotificationEvent';
import { AMSG_RECENT_UPDATE_KEY, SULLY_SUPPORT_NOTICE_KEY } from './novemberNotices';
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

it('advances from the recap to support once and preserves two independent global acknowledgements', async () => {
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
    expect(localStorage.length).toBe(2);
});

it('navigating to active-message settings leaves support unread for the next launch', async () => {
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
    // All historical notices were already read; the superseded relay key remains absent.
    const getItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (key) {
        if ([AMSG_RECENT_UPDATE_KEY, SULLY_SUPPORT_NOTICE_KEY, 'sullyos_update_amsg2_relay_v1_seen'].includes(key)) return getItem.call(this, key);
        if (key === 'os_realtime_config') return JSON.stringify({ userHolidays: { introChoice: 'declined' } });
        return '1';
    });
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
