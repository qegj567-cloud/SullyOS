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
    const writeText = vi.fn(async () => { if (!success) throw new Error('denied'); });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    act(() => button('查看报错')!.click());
    await act(async () => button('复制全部')!.click());
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(state.systemLogs, null, 2));
    expect(host.querySelector('[role="status"]')?.textContent).toContain(success ? '已复制全部日志' : '自动复制失败');
    if (!success) expect(host.querySelector('textarea')?.value).toContain('first error');
});
