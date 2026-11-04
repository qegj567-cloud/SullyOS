// @vitest-environment jsdom
import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NavigationBallNotice, { NAVIGATION_BALL_NOTICE_KEY } from '../components/os/NavigationBallNotice';
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
it('does not acknowledge rendering, and routes an explicit settings choice exactly once without enabling the ball', async () => {
  const onDone = vi.fn(), onConfigure = vi.fn();
  await act(async () => root.render(React.createElement(StrictMode, {}, React.createElement(NavigationBallNotice, { onDone, onConfigure }))));
  expect(localStorage.getItem(NAVIGATION_BALL_NOTICE_KEY)).toBeNull();
  const button = [...host.querySelectorAll('button')].find(item => item.textContent === '去设置')!;
  await act(async () => { button.click(); button.click(); });
  expect(onConfigure).toHaveBeenCalledOnce(); expect(onDone).not.toHaveBeenCalled();
  expect(localStorage.getItem(NAVIGATION_BALL_NOTICE_KEY)).toBe('1'); expect(localStorage.getItem('sully_navigation_ball_enabled_v1')).toBeNull();
});
it('acknowledges Escape and remains dismissible when storage rejects access', async () => {
  const onDone = vi.fn();
  await act(async () => root.render(React.createElement(NavigationBallNotice, { onDone, onConfigure: vi.fn() })));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
  await act(async () => host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true })));
  expect(onDone).toHaveBeenCalledOnce();
});
