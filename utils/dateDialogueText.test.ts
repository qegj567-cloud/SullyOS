// @vitest-environment jsdom
import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import DateDialogueText, { type DateDialogueTextHandle } from '../components/date/DateDialogueText';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it('逐字更新不通知整个会话；跳过后不会被旧计时器截短，切换行和卸载清理计时器', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const ref = createRef<DateDialogueTextHandle>();
    const changed = vi.fn();
    try {
        await act(async () => root.render(React.createElement(DateDialogueText, { ref, text: '这是一段较长的对白。', onAnimatingChange: changed })));
        changed.mockClear();
        await act(async () => vi.advanceTimersByTime(60));
        expect(host.querySelector('p')?.textContent).toBe('这是一');
        expect(changed).not.toHaveBeenCalled();
        await act(async () => ref.current!.finish());
        expect(changed).toHaveBeenLastCalledWith(false);
        await act(async () => vi.advanceTimersByTime(500));
        expect(host.querySelector('p')?.textContent).toBe('这是一段较长的对白。');
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => root.render(React.createElement(DateDialogueText, { ref, text: '下一句', onAnimatingChange: changed })));
        expect(host.querySelector('p')?.textContent).toBe('');
        await act(async () => vi.advanceTimersByTime(60));
        expect(host.querySelector('p')?.textContent).toBe('下一句');
        expect(changed).toHaveBeenLastCalledWith(false);
        await act(async () => root.render(React.createElement(DateDialogueText, { ref, text: '尚未播放完就退出', onAnimatingChange: changed })));
    } finally {
        await act(async () => root.unmount()); host.remove();
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    }
});

it('减少动态效果时直接显示完整文字，不启动逐字计时器', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
        await act(async () => root.render(React.createElement(DateDialogueText, { text: '完整对白', onAnimatingChange: vi.fn() })));
        expect(host.textContent).toBe('完整对白');
        expect(vi.getTimerCount()).toBe(0);
    } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); vi.useRealTimers(); }
});
