// @vitest-environment jsdom
import React, { act, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { handleLocalBack, registerLocalBackHandler } from './localBackHandlers';
import { useLocalBackHandler } from '../hooks/useLocalBackHandler';
let root: Root | undefined;
const cleanup: (() => void)[] = [];
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; cleanup.splice(0).forEach(remove => remove()); document.body.innerHTML = ''; });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it('handles the inner layer first regardless of effect order and restores the parent after removal', () => {
  const child = vi.fn(() => true), parent = vi.fn(() => true);
  const remove = registerLocalBackHandler(child, 20); cleanup.push(remove);
  cleanup.push(registerLocalBackHandler(parent, 10));
  expect(handleLocalBack()).toBe(true); expect(child).toHaveBeenCalledOnce(); expect(parent).not.toHaveBeenCalled();
  remove(); expect(handleLocalBack()).toBe(true); expect(parent).toHaveBeenCalledOnce();
});
it('falls through declined layers, cleans up out of order and leaves the app fallback available', () => {
  const parent = vi.fn(() => true), child = vi.fn(() => false);
  const removeParent = registerLocalBackHandler(parent, 10), removeChild = registerLocalBackHandler(child, 20);
  cleanup.push(removeParent, removeChild);
  expect(handleLocalBack()).toBe(true); expect(parent).toHaveBeenCalledOnce();
  removeParent(); expect(handleLocalBack()).toBe(false); removeChild(); expect(handleLocalBack()).toBe(false);
});
it('uses current panel state through StrictMode without stale or duplicate handlers', async () => {
  const leave = vi.fn();
  function Panel() {
    const [inner, setInner] = useState(true);
    useLocalBackHandler(() => { if (inner) setInner(false); else leave(); return true; }, 20);
    return React.createElement('p', null, inner ? '详情' : '列表');
  }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(React.createElement(StrictMode, null, React.createElement(Panel))));
  await act(async () => { expect(handleLocalBack()).toBe(true); }); expect(host.textContent).toBe('列表'); expect(leave).not.toHaveBeenCalled();
  await act(async () => { handleLocalBack(); }); expect(leave).toHaveBeenCalledOnce();
  await act(async () => root!.unmount()); root = undefined; expect(handleLocalBack()).toBe(false);
});
