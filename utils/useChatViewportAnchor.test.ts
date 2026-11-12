// @vitest-environment jsdom
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { useChatViewportAnchor } from './useChatViewportAnchor';

let root: Root;
let host: HTMLDivElement;
let scroller: HTMLDivElement;
let resize: ResizeObserverCallback;
let height: number;
let top: number;
let enabled: boolean;
let charId: string;
const disconnect = vi.fn();
function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    useChatViewportAnchor(ref, charId, enabled);
    return React.createElement('div', { ref: (node: HTMLDivElement | null) => {
        Object.assign(ref, { current: node });
        if (!node) return;
        scroller = node;
        Object.defineProperties(node, {
            clientHeight: { configurable: true, get: () => height },
            scrollHeight: { configurable: true, get: () => 2000 },
            scrollTop: { configurable: true, get: () => top, set: value => { top = Math.max(0, Math.min(value, 2000 - height)); } },
        });
    } });
}
const render = () => act(async () => root.render(React.createElement(Harness)));
const scroll = (value: number) => { scroller.scrollTop = value; scroller.dispatchEvent(new Event('scroll')); };
const resizeTo = (value: number, scrollBeforeObserver = false) => {
    height = value;
    if (scrollBeforeObserver) scroller.dispatchEvent(new Event('scroll'));
    resize([], {} as ResizeObserver);
};
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', class {
        constructor(callback: ResizeObserverCallback) { resize = callback; }
        observe() {}
        disconnect = disconnect;
    });
    height = 700; top = 1300; enabled = true; charId = 'a'; disconnect.mockClear();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it('keeps the newest messages above the keyboard through resize animations and input-method changes', async () => {
    await render();
    for (const nextHeight of [600, 420, 350, 300, 350, 700]) {
        resizeTo(nextHeight, true);
        expect(top + height).toBe(2000);
    }
});

it('keeps older messages in place when the reader has scrolled up', async () => {
    await render(); scroll(450);
    resizeTo(350, true); expect(top).toBe(450);
    resizeTo(700); expect(top).toBe(450);
    scroll(1300); resizeTo(400); expect(top).toBe(1600);
});

it('follows toolbar and multiline-input height changes without forcing a scroll on mount', async () => {
    top = 800; await render(); expect(top).toBe(800);
    scroll(1300); resizeTo(412); expect(top).toBe(1588);
    resizeTo(380); expect(top).toBe(1620);
    resizeTo(700); expect(top).toBe(1300);
});

it('does not interfere with selection or a history-search window, and resets on character changes', async () => {
    await render(); enabled = false; await render();
    expect(disconnect).toHaveBeenCalledTimes(1);
    // 停止观测后改变高度，模拟浏览器不会再发送 observer 回调。
    height = 350; expect(top).toBe(1300);
    charId = 'b'; enabled = true; top = 250; await render();
    resizeTo(700); expect(top).toBe(250);
});

it('ignores a temporary zero-height hidden container', async () => {
    await render(); resizeTo(0); expect(top).toBe(1300);
    resizeTo(350); expect(top).toBe(1650);
});
