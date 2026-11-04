// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDateReadingScroll } from './useDateReadingScroll';

let root: Root;
let host: HTMLDivElement;
let viewport: HTMLDivElement;
let resize: ResizeObserverCallback;
let frames: Map<number, FrameRequestCallback>;
let heights: Map<number, number>;
let ids: number[];
let active: boolean;
let top: number;
let frameId: number;
const loadOlder = vi.fn();
const disconnect = vi.fn();
const totalHeight = () => ids.reduce((sum, id) => sum + (heights.get(id) ?? 100), 40);

function Harness() {
    const scroll = useDateReadingScroll({ active, messages: ids.map(id => ({ id })), onLoadOlder: loadOlder });
    return active ? React.createElement('div', {
        ref: (element: HTMLDivElement | null) => {
            Object.assign(scroll.scrollRef, { current: element });
            if (!element) return;
            viewport = element;
            Object.defineProperties(element, {
                clientHeight: { configurable: true, get: () => 500 },
                scrollHeight: { configurable: true, get: totalHeight },
                scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, totalHeight() - 500)); } },
            });
            element.getBoundingClientRect = () => ({ top: 0, bottom: 500 } as DOMRect);
        },
        onScroll: scroll.onScroll,
    }, React.createElement('div', { ref: scroll.contentRef }, ids.map(id => React.createElement('div', {
        key: id,
        'data-date-message-id': id,
        ref: (element: HTMLDivElement | null) => {
            if (element) element.getBoundingClientRect = () => {
                const offset = ids.slice(0, ids.indexOf(id)).reduce((sum, value) => sum + (heights.get(value) ?? 100), 20) - top;
                return { top: offset, bottom: offset + (heights.get(id) ?? 100) } as DOMRect;
            };
        },
    })))) : null;
}

const render = () => act(async () => root.render(React.createElement(Harness)));
const scrollTo = (value: number) => act(async () => {
    viewport.scrollTop = value;
    viewport.dispatchEvent(new Event('scroll'));
});
const flushResize = () => act(async () => {
    resize([], {} as ResizeObserver);
    const queued = [...frames.values()];
    frames.clear();
    queued.forEach(callback => callback(0));
});
const offsetOf = (id: number) => viewport.querySelector<HTMLElement>(`[data-date-message-id="${id}"]`)!.getBoundingClientRect().top;

beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    heights = new Map(); frames = new Map(); ids = Array.from({ length: 50 }, (_, index) => index + 51);
    active = true; top = 0; frameId = 0;
    loadOlder.mockReset(); disconnect.mockReset();
    vi.stubGlobal('ResizeObserver', class {
        constructor(callback: ResizeObserverCallback) { resize = callback; }
        observe() {}
        disconnect = disconnect;
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove(); vi.unstubAllGlobals();
});

it('进入阅读模式后离屏占位变为长正文，仍跟随末尾；尺寸事件不误判为用户上翻', async () => {
    await render();
    expect(top).toBe(totalHeight() - 500);
    for (const id of ids.slice(0, 30)) heights.set(id, 800);
    await act(async () => viewport.dispatchEvent(new Event('scroll')));
    await flushResize();
    expect(top).toBe(totalHeight() - 500);
    expect(loadOlder).not.toHaveBeenCalled();
    heights.set(100, 2000);
    await flushResize();
    expect(top).toBe(totalHeight() - 500);
});

it('立绘模式生成新回复后再切入，以及退出重进后异步读取历史，都定位到新末尾', async () => {
    await render(); await scrollTo(1200);
    active = false; await render();
    ids = [...ids, 101, 102]; heights.set(102, 1800); await render();
    active = true; await render();
    expect(top).toBe(totalHeight() - 500);
    await act(async () => root.unmount());
    root = createRoot(host); ids = []; top = 0; await render();
    ids = [101, 102]; await render();
    expect(top).toBe(totalHeight() - 500);
    heights.set(102, 2400); await flushResize();
    expect(top).toBe(totalHeight() - 500);
});

it('用户上翻后追加回复不抢位置；同时加载更早记录按消息锚点补偿，后续占位展开也不跳', async () => {
    await render(); await scrollTo(1220);
    const anchorOffset = offsetOf(63);
    ids = [...Array.from({ length: 50 }, (_, index) => index + 1), ...ids, 101, 102];
    heights.set(102, 1800); await render();
    expect(offsetOf(63)).toBe(anchorOffset);
    heights.set(1, 2200); heights.set(102, 4000); await flushResize();
    expect(offsetOf(63)).toBe(anchorOffset);
    expect(top).toBeLessThan(totalHeight() - 500);
});

it('只有用户上翻到顶部触发更早记录，回到底部后恢复跟随', async () => {
    await render(); await scrollTo(20);
    expect(loadOlder).toHaveBeenCalledOnce();
    await flushResize();
    expect(loadOlder).toHaveBeenCalledOnce();
    await scrollTo(totalHeight());
    ids = [...ids, 101]; await render(); heights.set(101, 1600); await flushResize();
    expect(top).toBe(totalHeight() - 500);
});

it('内容收缩自动钳制到新末尾时仍恢复原消息；同帧有真实下滚意图则允许回到末尾', async () => {
    await render(); await scrollTo(totalHeight() - 900);
    const anchorOffset = offsetOf(92);
    for (const id of ids.filter(id => id < 90)) heights.set(id, 10);
    await scrollTo(top); // Browser clamps the now out-of-range scrollTop before resize delivery.
    await flushResize();
    expect(offsetOf(92)).toBe(anchorOffset);
    expect(totalHeight() - 500 - top).toBe(400);

    // Another shrink coincides with a genuine user gesture toward the bottom.
    for (const id of ids.filter(id => id < 90)) heights.set(id, 0);
    heights.set(90, 10);
    await act(async () => {
        viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 500 }));
        viewport.scrollTop = totalHeight();
        viewport.dispatchEvent(new Event('scroll'));
    });
    await flushResize();
    expect(top).toBe(totalHeight() - 500);
});

it('离开阅读模式清理观察器和待执行的布局修正', async () => {
    await render();
    resize([], {} as ResizeObserver);
    expect(frames.size).toBe(1);
    active = false; await render();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
});
