// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import DateSession from '../components/date/DateSession';
import { DATE_ACTION_KINDS } from './dateActionChoices';
import { trackEvent } from './analytics';
import { MEETING_CONTINUE_DISPLAY_TEXT } from './meetingContinue';

vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../context/OSContext', () => ({ useOS: () => ({ updateCharacter: vi.fn(), addToast: vi.fn(), userProfile: { name: '用户' }, apiConfig: {}, registerBackHandler: () => () => {} }) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it.each(['', '  \n  '])('空白草稿 %j 使用合并按钮续写；失败可重试而不是新增空白轮', async draft => {
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const send = vi.fn().mockRejectedValueOnce(new Error('测试失败')).mockResolvedValue('[normal] "好。"');
    try {
        await act(async () => root.render(React.createElement(DateSession, {
            char: { id: 'continue', name: '角色', dateAppearance: { preset: 'paper' } }, userProfile: { name: '用户' }, messages: [], peekStatus: '',
            initialState: { draftInput: draft, isNovelMode: true }, onSendMessage: send, onReroll: vi.fn(), onExit: vi.fn(), onSettings: vi.fn(),
        } as any)));
        expect(host.querySelector('[aria-label="继续当前见面"]')).toBeNull();
        await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="展示输入框"]')!.click());
        expect(host.querySelector<HTMLTextAreaElement>('[aria-label="见面输入"]')!.placeholder).toBe('如果留空，则继续当前剧情');
        const button = host.querySelector<HTMLButtonElement>('.date-composer__send')!;
        expect(button.textContent).toBe('继续');
        expect(button.disabled).toBe(false);
        await act(async () => button.click());
        expect(send).toHaveBeenNthCalledWith(1, MEETING_CONTINUE_DISPLAY_TEXT, 'continue');
        expect(host.querySelector('.date-composer__send')!.textContent).toBe('重试');
        await act(async () => host.querySelector<HTMLButtonElement>('.date-composer__send')!.click());
        expect(send).toHaveBeenNthCalledWith(2, MEETING_CONTINUE_DISPLAY_TEXT, undefined);
        expect(host.querySelector('[aria-label="见面输入"]')).toBeNull();
    } finally { await act(async () => root.unmount()); host.remove(); }
});

it.each(['direct', 'opening', 'resume'] as const)('%s 进入时输入框折叠，首次展开消除提示，再进入仍折叠且保留草稿', async mode => {
    localStorage.removeItem('sully-date-entry-guide-v1');
    const host = document.createElement('div'); document.body.append(host);
    let root = createRoot(host);
    const props = { char: { id: 'guide', name: '角色', dateAppearance: { preset: 'paper' } }, userProfile: { name: '用户' }, messages: [],
        peekStatus: mode === 'opening' ? '角色正在读书。' : '', initialState: mode === 'resume' ? { draftInput: '保留草稿。', isNovelMode: true } : undefined,
        onSendMessage: vi.fn(), onReroll: vi.fn(), onExit: vi.fn(), onSettings: vi.fn() } as any;
    try {
        await act(async () => root.render(React.createElement(DateSession, props)));
        expect(host.querySelector('[aria-label="见面输入"]')).toBeNull();
        expect(host.querySelector('.date-input-hint')?.textContent).toBe('点这里展开输入框');
        await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="展示输入框"]')!.click());
        expect(host.querySelector('.date-input-hint')).toBeNull();
        expect(host.querySelector<HTMLTextAreaElement>('[aria-label="见面输入"]')!.value).toBe(mode === 'resume' ? '保留草稿。' : '');
        expect(localStorage.getItem('sully-date-entry-guide-v1')).toBe('input-seen');
        await act(async () => root.unmount());
        root = createRoot(host);
        await act(async () => root.render(React.createElement(DateSession, props)));
        expect(host.querySelector('[aria-label="见面输入"]')).toBeNull();
        expect(host.querySelector('.date-input-hint')).toBeNull();
    } finally { await act(async () => root.unmount()); host.remove(); }
});

it('点选只追加到草稿，补充后按发送；原有草稿不被覆盖', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const send = vi.fn(async () => '[normal] "好。"');
    const choices = DATE_ACTION_KINDS.map(({ id, label }) => ({ kind: id, text: id === 'plot' ? '（请来一个小变数。）' : `${label}的具体建议` }));
    try {
        await act(async () => root.render(React.createElement(DateSession, { char: { id: 'c', name: '角色', dateAppearance: { preset: 'paper' }, dateActionChoicesEnabled: true }, userProfile: { name: '用户' },
            messages: [{ id: 1, charId: 'c', role: 'assistant', type: 'text', content: '[happy] "茶好了。"', timestamp: 1, metadata: { dateActionChoices: choices } }], peekStatus: '',
            initialState: { draftInput: '我先坐下。', isNovelMode: true }, onSendMessage: send, onReroll: vi.fn(), onExit: vi.fn(), onSettings: vi.fn(),
        } as any)));
        expect(host.querySelector('[aria-label="行动建议"]')?.querySelectorAll('button')).toHaveLength(5);
        expect(host.querySelector('[aria-label="行动建议"]')?.getAttribute('role')).toBe('dialog');
        expect(host.querySelector('[aria-label="行动建议"]')?.contains(host.querySelector('[aria-label="见面输入"]'))).toBe(false);
        await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === '收起建议')!.click());
        expect(host.querySelector('[aria-label="行动建议"]')).toBeNull();
        if (!host.querySelector('[aria-label="见面输入"]')) await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="展示输入框"]')!.click());
        await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="重新选择行动建议"]')!.click());
        await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent?.includes('申请变数'))!.click());
        const input = host.querySelector<HTMLTextAreaElement>('[aria-label="见面输入"]')!;
        expect(input.value).toBe('我先坐下。\n（请来一个小变数。）');
        expect(send).not.toHaveBeenCalled();
        expect(trackEvent).toHaveBeenCalledWith('选用见面行动建议', { 方向: 'plot' });
        expect(JSON.stringify(vi.mocked(trackEvent).mock.calls)).not.toContain('小变数');
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, input.value + '\n不要离开房间。');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === '发送')!.click());
        expect(send).toHaveBeenCalledWith('我先坐下。\n（请来一个小变数。）\n不要离开房间。', undefined);
    } finally { await act(async () => root.unmount()); host.remove(); }
});
