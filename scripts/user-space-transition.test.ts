import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
// @ts-expect-error jsdom is installed without its separate declaration package.
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../public/user-space-transition.js', import.meta.url), 'utf8');
const key = 'sully_space_transition_v1';
let dom: JSDOM;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { dom?.window.close(); vi.useRealTimers(); });
function boot(record?: unknown, active = 'u_b', reduced = false) {
    dom?.window.close();
    dom = new JSDOM('<!doctype html><head></head><body><div id="root"></div></body>', { url: 'https://app.invalid/' });
    const { window } = dom;
    window.localStorage.setItem('sully_active_user_space_v1', active);
    if (record) window.sessionStorage.setItem(key, JSON.stringify(record));
    window.matchMedia = () => ({ matches: reduced });
    runInNewContext(source, { window, document: window.document, Date, setTimeout, clearTimeout });
    return { window, api: window.__sullySpaceTransition, cover: () => window.document.getElementById('sully-space-transition') };
}
it('hands a matching transition across reload once, without changing storage ownership', async () => {
    const first = boot(undefined, 'default');
    const pending = first.api.begin('u_b', '<b>小雨</b>');
    expect(first.cover()?.textContent).toContain('<b>小雨</b>');
    expect(first.cover()?.querySelector('b')).toBeNull();
    const record = JSON.parse(first.window.sessionStorage.getItem(key));
    expect(first.window.localStorage.getItem('sully_active_user_space_v1')).toBe('default');
    await vi.advanceTimersByTimeAsync(280); await pending;
    const second = boot(record);
    expect(second.api.arriving('u_b')).toBe(true);
    expect(second.api.arriving('default')).toBe(false);
    expect(second.window.sessionStorage.getItem(key)).toBeNull();
    expect(second.cover()).not.toBeNull();
    second.api.finish(); second.api.finish();
    await vi.advanceTimersByTimeAsync(460);
    expect(second.cover()).toBeNull();
    expect(boot().api.arriving('u_b')).toBe(false);
});
it.each([
    { id: 'u_a', name: '其他空间', age: 0 },
    { id: 'u_b', name: '过期', age: 30001 },
    { id: 'u_b', name: '未来', age: -1 },
])('does not bypass normal startup for invalid handovers: $name', ({ id, name, age }) => {
    const state = boot({ id, name, at: Date.now() - age });
    expect(state.cover()).toBeNull();
    expect(state.api.arriving('u_b')).toBe(false);
});
it('releases a stalled cover and exposes startup errors immediately', async () => {
    let state = boot({ id: 'u_b', name: 'B', at: Date.now() });
    await vi.advanceTimersByTimeAsync(12000);
    expect(state.cover()).toBeNull();
    state = boot({ id: 'u_b', name: 'B', at: Date.now() });
    state.window.dispatchEvent(new state.window.ErrorEvent('error', { message: 'startup failed' }));
    expect(state.cover()).toBeNull();
});
it('honors reduced motion without adding animation delays', async () => {
    const state = boot(undefined, 'default', true);
    const pending = state.api.begin('u_b', 'B');
    await vi.advanceTimersByTimeAsync(0); await pending;
    expect(state.cover()?.style.animation).toBe('');
    state.api.finish();
    await vi.runAllTimersAsync();
    expect(state.cover()).toBeNull();
});
