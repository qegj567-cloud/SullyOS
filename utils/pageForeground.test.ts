import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { subscribePageForeground } from './pageForeground';

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('window', new EventTarget());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(['focus', 'pageshow', 'resume', 'visibilitychange'])('wakes an existing page on %s without needing an app remount', signal => {
    const update = vi.fn(), dispose = subscribePageForeground(update);
    (signal === 'focus' || signal === 'pageshow' ? window : document).dispatchEvent(new Event(signal));
    vi.runAllTimers();
    expect(update).toHaveBeenCalledTimes(1);
    dispose();
});
it('coalesces a burst, ignores hidden pages, and cancels queued work on unmount', () => {
    const update = vi.fn(), dispose = subscribePageForeground(update);
    window.dispatchEvent(new Event('pageshow')); window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('resume'));
    vi.runAllTimers(); expect(update).toHaveBeenCalledTimes(1);
    Object.assign(document, { visibilityState: 'hidden' });
    window.dispatchEvent(new Event('focus')); vi.runAllTimers(); expect(update).toHaveBeenCalledTimes(1);
    Object.assign(document, { visibilityState: 'visible' });
    document.dispatchEvent(new Event('visibilitychange')); dispose(); vi.runAllTimers();
    window.dispatchEvent(new Event('focus')); vi.runAllTimers(); expect(update).toHaveBeenCalledTimes(1);
});
