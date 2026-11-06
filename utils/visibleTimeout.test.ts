// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setVisibleTimeout } from './visibleTimeout';

let visibility = 'visible';
let cleanup: (() => void) | undefined;
const setVisibility = (value: string) => {
  visibility = value;
  document.dispatchEvent(new Event('visibilitychange'));
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.restoreAllMocks(); vi.useRealTimers(); });

describe('foreground loading timer', () => {
  it('fires once after 15 foreground seconds', () => {
    const callback = vi.fn(); cleanup = setVisibleTimeout(callback, 15_000);
    vi.advanceTimersByTime(14_999); expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(callback).toHaveBeenCalledOnce();
    setVisibility('hidden'); setVisibility('visible'); vi.advanceTimersByTime(30_000);
    expect(callback).toHaveBeenCalledOnce();
  });
  it('excludes time spent backgrounded without discarding foreground progress', () => {
    const callback = vi.fn(); cleanup = setVisibleTimeout(callback, 15_000);
    vi.advanceTimersByTime(5_000); setVisibility('hidden');
    vi.advanceTimersByTime(120_000); expect(callback).not.toHaveBeenCalled();
    setVisibility('visible'); vi.advanceTimersByTime(9_999); expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(callback).toHaveBeenCalledOnce();
  });
  it('does not start counting until an initially hidden document becomes visible', () => {
    setVisibility('hidden');
    const callback = vi.fn(); cleanup = setVisibleTimeout(callback, 15_000);
    vi.advanceTimersByTime(60_000); expect(callback).not.toHaveBeenCalled();
    setVisibility('visible'); vi.advanceTimersByTime(15_000); expect(callback).toHaveBeenCalledOnce();
  });
  it('cancels on unmount and starts a fresh budget for another app', () => {
    const oldApp = vi.fn(); cleanup = setVisibleTimeout(oldApp, 15_000);
    vi.advanceTimersByTime(10_000); cleanup();
    const newApp = vi.fn(); cleanup = setVisibleTimeout(newApp, 15_000);
    vi.advanceTimersByTime(5_000);
    expect(oldApp).not.toHaveBeenCalled(); expect(newApp).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000); expect(newApp).toHaveBeenCalledOnce();
  });
});
