// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RelayUpdatePopup, { RELAY_UPDATE_KEY, shouldOfferRelayNotice } from '../components/os/RelayUpdatePopup';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('is offered on official sites and the APK but not on forks, which cannot use the relay', () => {
    expect(shouldOfferRelayNotice('https://friedsully.com/')).toBe(true);
    expect(shouldOfferRelayNotice('https://localhost/')).toBe(true);
    expect(shouldOfferRelayNotice('https://someone.github.io/SullyOS/')).toBe(false);
});

it('marks read only on an explicit choice and opens settings from the second button', async () => {
    const onDone = vi.fn(), onVisit = vi.fn();
    await act(async () => root.render(React.createElement(RelayUpdatePopup, { onDone, onVisit })));
    expect(localStorage.getItem(RELAY_UPDATE_KEY)).toBeNull();
    const visit = [...host.querySelectorAll('button')].find(b => b.textContent === '去设置看看')!;
    act(() => { visit.click(); visit.click(); });
    expect(onVisit).toHaveBeenCalledOnce();
    expect(onDone).not.toHaveBeenCalled();
    expect(localStorage.getItem(RELAY_UPDATE_KEY)).toBe('1');
});
