// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import DateExperiencePicker from '../components/date/DateExperiencePicker';
import { DATE_STYLE_PRESETS } from './dateStylePresets';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it('入口列出全部十套文风，切换只改文风并保留当前场景与补充', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const onChange = vi.fn();
    const value = { style: 'cinematic', tone: 'push_pull' as const, extra: '我的补充', sceneSeed: '窗边' };
    try {
        await act(async () => root.render(React.createElement(DateExperiencePicker, { compact: true, value, onChange })));
        expect(host.querySelector('select')).toBeNull();
        await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="选择陪伴文风"]')!.click());
        const options = Array.from(document.querySelectorAll('[role="option"]'));
        expect(options.map(o => o.getAttribute('data-style-id'))).toEqual(DATE_STYLE_PRESETS.map(p => p.id));
        expect(options.map(o => o.getAttribute('aria-label'))).toEqual(DATE_STYLE_PRESETS.map(p => p.title));
        await act(async () => document.querySelector<HTMLButtonElement>('[data-style-id="slice_of_life"]')!.click());
        expect(onChange).toHaveBeenCalledOnce();
        expect(onChange).toHaveBeenCalledWith({ ...value, style: 'slice_of_life' });
        expect(host.textContent).not.toContain('慢镜头约会');
    } finally { await act(async () => root.unmount()); host.remove(); }
});

it('常用项直接展开；文风搜索可按文学风格筛选，关闭不改选择并归还焦点', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host), onChange = vi.fn();
    try {
        await act(async () => root.render(React.createElement(DateExperiencePicker, { value: { style: 'cinematic', tone: 'character' }, onChange })));
        expect(host.querySelector('select')).toBeNull();
        expect(host.querySelector('[aria-label="陪伴场景描述"]')?.closest('details')).toBeNull();
        await act(async () => [...host.querySelectorAll('button')].find(el => el.textContent === '心动推拉')!.click());
        expect(onChange).toHaveBeenLastCalledWith({ style: 'cinematic', tone: 'push_pull' });
        onChange.mockClear();
        const trigger = host.querySelector<HTMLButtonElement>('[aria-label="本次写作风格"]')!;
        await act(async () => trigger.click());
        const input = document.querySelector<HTMLInputElement>('[aria-label="搜索文风"]')!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '日系文学');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(document.querySelector('[data-style-id="playful"]')).not.toBeNull();
        expect(document.querySelector('[data-style-id="intense"]')).toBeNull();
        await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        expect(document.querySelector('[aria-label="选择写作风格"]')).toBeNull();
        expect(onChange).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(trigger);
    } finally { await act(async () => root.unmount()); host.remove(); }
});
