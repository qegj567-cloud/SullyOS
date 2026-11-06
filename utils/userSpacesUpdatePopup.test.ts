// @vitest-environment jsdom
import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import UserSpacesUpdatePopup, { USER_SPACES_UPDATE_KEY } from '../components/os/UserSpacesUpdatePopup';
import { createSpaceStorage } from './userSpaces';
import { handleLocalBack } from './localBackHandlers';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it('waits for an explicit choice and shares acknowledgement across users without changing their data', async () => {
    const onDone = vi.fn(), onVisit = vi.fn();
    await act(async () => root.render(React.createElement(StrictMode, {}, React.createElement(UserSpacesUpdatePopup, { onDone, onVisit }))));
    expect(localStorage.length).toBe(0);
    const visit = [...host.querySelectorAll('button')].find(b => b.textContent === '去档案看看')!;
    act(() => { visit.click(); visit.click(); });
    expect(onVisit).toHaveBeenCalledOnce(); expect(onDone).not.toHaveBeenCalled();
    expect(createSpaceStorage(localStorage, 'default').getItem(USER_SPACES_UPDATE_KEY)).toBe('1');
    expect(createSpaceStorage(localStorage, 'u_other').getItem(USER_SPACES_UPDATE_KEY)).toBe('1');
    expect(localStorage.length).toBe(1);
});

it.each(['close', 'back', 'cancel', 'understood'])('supports %s even if acknowledgement cannot be persisted', async action => {
    const onDone = vi.fn(), onVisit = vi.fn();
    await act(async () => root.render(React.createElement(UserSpacesUpdatePopup, { onDone, onVisit })));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
    act(() => {
        if (action === 'back') expect(handleLocalBack()).toBe(true);
        else if (action === 'cancel') host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true }));
        else if (action === 'close') host.querySelector<HTMLButtonElement>('[aria-label="关闭多用户空间介绍"]')!.click();
        else [...host.querySelectorAll('button')].find(b => b.textContent === '知道了')!.click();
    });
    expect(onDone).toHaveBeenCalledOnce(); expect(onVisit).not.toHaveBeenCalled();
});
