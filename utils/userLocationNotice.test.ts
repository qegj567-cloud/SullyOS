// @vitest-environment jsdom
import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import UserLocationNotice, { USER_LOCATION_NOTICE_KEY } from '../components/os/UserLocationNotice';
import { handleLocalBack } from './localBackHandlers';
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
it('waits for an explicit choice and acknowledges only once without writing location configuration', async () => {
  const onDone = vi.fn(), onConfigure = vi.fn();
  await act(async () => root.render(React.createElement(StrictMode, {}, React.createElement(UserLocationNotice, { onDone, onConfigure }))));
  expect(localStorage.length).toBe(0);
  const button = [...host.querySelectorAll('button')].find(item => item.textContent === '去设置')!;
  await act(async () => { button.click(); button.click(); });
  expect(onConfigure).toHaveBeenCalledOnce(); expect(onDone).not.toHaveBeenCalled();
  expect(localStorage.getItem(USER_LOCATION_NOTICE_KEY)).toBe('1'); expect(localStorage.length).toBe(1);
});
it.each(['cancel', 'back', 'close', 'understood'])('acknowledges %s and remains dismissible when storage is unavailable', async action => {
  const onDone = vi.fn();
  await act(async () => root.render(React.createElement(UserLocationNotice, { onDone, onConfigure: vi.fn() })));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
  await act(async () => {
    if (action === 'cancel') host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true }));
    else if (action === 'back') expect(handleLocalBack()).toBe(true);
    else if (action === 'close') host.querySelector<HTMLButtonElement>('[aria-label="关闭真实定位介绍"]')!.click();
    else [...host.querySelectorAll('button')].find(item => item.textContent === '知道了')!.click();
  });
  expect(onDone).toHaveBeenCalledOnce();
});
