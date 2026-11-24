// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import StatusBar from '../components/os/StatusBar';

const state = vi.hoisted(() => ({
    virtualTime: { hours: 9, minutes: 0 }, theme: {},
    systemLogs: [] as { id: string; message: string }[], clearLogs: vi.fn(),
}));
vi.mock('../context/OSContext', () => ({ useOS: () => state }));
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
const render = () => act(() => root.render(React.createElement(StatusBar)));
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label);
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    state.systemLogs = [{ id: 'a', message: 'first error' }];
    host = document.createElement('div'); document.body.appendChild(host);
    root = createRoot(host); render();
});
afterEach(() => {
    act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
it('acknowledges viewed logs without clearing them and alerts again on a new error', () => {
    act(() => button('查看报错')!.click());
    state.systemLogs.unshift({ id: 'b', message: 'arrived while reading' }); render();
    act(() => button('关闭')!.click());
    expect(button('查看报错')).toBeUndefined();
    expect(state.clearLogs).not.toHaveBeenCalled();
    state.systemLogs.unshift({ id: 'c', message: 'new error' }); render();
    act(() => button('查看报错')!.click());
    expect(host.textContent).toContain('first error');
    expect(host.textContent).toContain('new error');
});
it.each([true, false])('shows the actual clipboard outcome (success=%s)', async success => {
    const writeText = vi.fn(async (_text: string) => { if (!success) throw new Error('denied'); });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    act(() => button('查看报错')!.click());
    await act(async () => button('复制全部')!.click());
    expect(writeText).toHaveBeenCalledTimes(1);
    const copiedObj = JSON.parse(writeText.mock.calls[0][0]);
    expect(copiedObj.count).toBe(1);
    expect(copiedObj.build?.appVersion).toBeTruthy();
    expect(copiedObj.environment).toBeTruthy();
    expect(copiedObj.logs).toEqual(state.systemLogs);
    expect(host.querySelector('[role="status"]')?.textContent).toContain(success ? '已复制全部日志' : '自动复制失败');
    if (!success) expect(host.querySelector('textarea')?.value).toContain('first error');
});

it('keeps silent background logs in exportable list without triggering the red alert pill', () => {
    state.systemLogs = [{ id: 'silent-1', message: 'weather 502', silent: true } as any];
    render();
    expect(button('查看报错')).toBeUndefined();
    state.systemLogs = [{ id: 'loud-1', message: 'chat 500' }, ...state.systemLogs];
    render();
    expect(button('查看报错')).toBeTruthy();
    act(() => button('查看报错')!.click());
    expect(host.textContent).toContain('weather 502');
    expect(host.textContent).toContain('chat 500');

    // 即使数组首条随后又插入了新的 silent 日志，点关闭后红条也必须正常收起
    state.systemLogs = [{ id: 'silent-2', message: 'dialog mirror', silent: true } as any, ...state.systemLogs];
    render();
    act(() => button('关闭')!.click());
    expect(button('查看报错')).toBeUndefined();
});
