// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MonthlyRecallSetting from '../components/character/MonthlyRecallSetting';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it('默认开启；问号和蓝色小眼睛可查看说明，不误切换开关', () => {
    const change = vi.fn();
    function App() {
        const [enabled, setEnabled] = useState<boolean>();
        return React.createElement(MonthlyRecallSetting, { enabled, onChange: value => { change(value); setEnabled(value); } });
    }
    act(() => root.render(React.createElement(App)));
    const toggle = host.querySelector<HTMLInputElement>('[role=switch]')!;
    expect(toggle.checked).toBe(true);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="自主查阅月度记忆说明"]')!.click());
    expect(host.querySelector('[role=dialog]')?.textContent).toContain('额外调用一次 API');
    const eye = [...host.querySelectorAll('button')].find(b => b.textContent === '小眼睛')!;
    expect(eye.className).toContain('text-blue-600');
    act(() => eye.click());
    expect(host.querySelector('[role=dialog]')?.textContent).toContain('每次聊天都会带上该月已保存的全部详细记忆');
    expect(change).not.toHaveBeenCalled();
    act(() => [...host.querySelectorAll('button')].find(b => b.textContent === '返回查阅说明')!.click());
    act(() => [...host.querySelectorAll('button')].find(b => b.textContent === '关闭')!.click());
    act(() => toggle.click());
    expect(toggle.checked).toBe(false);
    expect(change).toHaveBeenLastCalledWith(false);
});
