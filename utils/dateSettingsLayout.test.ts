// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import DateSettings from '../components/date/DateSettings';
import DateSession from '../components/date/DateSession';

vi.mock('../context/OSContext', () => ({ useOS: () => ({ updateCharacter: vi.fn(), addToast: vi.fn(), userProfile: { name: '用户' }, apiConfig: {}, registerBackHandler: () => () => {} }) }));
vi.mock('../components/date/MeetingAppearanceControl', () => ({ default: () => React.createElement('div', null, '当前美化') }));
vi.mock('../components/date/ObserveSettings', () => ({ default: () => null }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it('opens settings from an active date without measuring the entrance animation as zero height', async () => {
    vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), {scale: 1, offsetTop: 0, height: 800}));
    // Model the browser geometry at the first frame of slideUp (translateY(100%)).
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return {top: this.closest('.animate-slide-up') ? 800 : 0, bottom: 800, height: 800} as DOMRect;
    });
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const char = {id: 'test', name: '角色', avatar: ''};
    try {
        await act(async () => root.render(React.createElement(DateSession, {char, userProfile: {name: '用户'}, messages: [], peekStatus: '',
            onSendMessage: async () => '', onReroll: async () => '', onExit: vi.fn(), onEditMessage: vi.fn(), onDeleteMessage: vi.fn(), onDeleteMessages: async () => {}, onSettings: vi.fn()} as any)));
        await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="打开见面菜单"]')!.click());
        await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.includes('布置场景'))!.click());
        const scroll = host.querySelector('[data-testid="date-settings-scroll"]')!;
        expect((scroll.parentElement as HTMLElement).style.maxHeight).toBe('800px');
        expect(scroll.textContent).toContain('当前美化');
        expect(host.querySelector('button[aria-label="返回"]')?.closest('header')?.style.paddingTop).toBe('var(--chrome-top)');
        await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.includes('保存当前布置'))!.click());
        expect(host.querySelector('[data-testid="date-settings-scroll"]')).toBeNull();
    } finally { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

it('scrolls the preview with the editor, collapses it, and keeps focused input above a reduced viewport', async () => {
    const viewport = Object.assign(new EventTarget(), { scale: 1, offsetTop: 0, height: 380 });
    vi.stubGlobal('visualViewport', viewport);
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(React.createElement(DateSettings, { char: { id: 'test', name: '角色' } as any, onBack: vi.fn() })));
        const scroll = host.querySelector('[data-testid="date-settings-scroll"]') as HTMLElement;
        const toggle = [...host.querySelectorAll('button')].find(el => el.textContent === '收起场景预览')!;
        expect(scroll.contains(toggle)).toBe(true);
        expect(scroll.textContent).toContain('预览 (Preview)');
        await act(async () => toggle.click());
        expect(scroll.textContent).not.toContain('预览 (Preview)');
        expect(toggle.textContent).toBe('展开场景预览');
        const textarea = host.querySelector('textarea[aria-label="自定义补充"]') as HTMLTextAreaElement;
        vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({ top: 64, bottom: 380, height: 316 } as DOMRect);
        vi.spyOn(textarea, 'getBoundingClientRect').mockReturnValue({ top: 500, bottom: 580, height: 80 } as DOMRect);
        await act(async () => {
            textarea.focus(); viewport.dispatchEvent(new Event('resize'));
            await new Promise(resolve => requestAnimationFrame(resolve));
        });
        expect((host.firstElementChild as HTMLElement).style.maxHeight).toBe('380px');
        expect(scroll.scrollTop).toBe(208);
    } finally { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

it('展开和收起场景信息只切换观测内容，点击正文仍可输入', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
        const char = { id: 'observe', name: '角色', dateAppearance: { preset: 'paper' }, dateObserve: { enabled: true } };
        await act(async () => root.render(React.createElement(DateSession, { char, userProfile: {name: '用户'}, messages: [],
            peekStatus: '⟦OBSERVE⟧\n地点｜窗边\n状态｜安静\n⟦/OBSERVE⟧\n窗外下着雨。',
            onSendMessage: async () => '', onReroll: async () => '', onExit: vi.fn(), onSettings: vi.fn(),
        } as any)));
        const summary = host.querySelector('summary')!;
        expect(summary.textContent).toBe('场景信息');
        for (const open of [true, false]) {
            await act(async () => summary.click());
            expect(summary.closest('details')!.open).toBe(open);
            expect(host.querySelector('textarea')).toBeNull();
        }
        await act(async () => host.querySelector<HTMLElement>('.meeting-prose')!.click());
        expect(document.activeElement).toBe(host.querySelector('textarea'));
        expect(host.querySelector('textarea')).toBeTruthy();
    } finally { act(() => root.unmount()); host.remove(); }
});
