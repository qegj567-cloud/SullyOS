// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worldbook } from '../types';

const trackEventMock = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
    worldbooks: [] as Worldbook[],
}));

const osMock = vi.hoisted(() => ({
    closeApp: vi.fn(),
    get worldbooks() { return state.worldbooks; },
    addWorldbook: vi.fn((book: Worldbook) => { state.worldbooks = [...state.worldbooks, book]; }),
    updateWorldbook: vi.fn(async (id: string, patch: Partial<Worldbook>) => {
        state.worldbooks = state.worldbooks.map(wb => wb.id === id ? { ...wb, ...patch } : wb);
    }),
    updateWorldbooks: vi.fn(async (ids: string[], patch: Partial<Worldbook>) => {
        const target = new Set(ids);
        state.worldbooks = state.worldbooks.map(wb => target.has(wb.id) ? { ...wb, ...patch } : wb);
    }),
    deleteWorldbook: vi.fn(async (id: string) => {
        state.worldbooks = state.worldbooks.filter(wb => wb.id !== id);
    }),
    deleteWorldbooks: vi.fn(async (ids: string[]) => {
        const target = new Set(ids);
        state.worldbooks = state.worldbooks.filter(wb => !target.has(wb.id));
    }),
    addToast: vi.fn(),
    registerBackHandler: vi.fn(() => () => {}),
}));

vi.mock('../context/OSContext', () => ({ useOS: () => osMock }));
vi.mock('../utils/appShortcutLaunch', () => ({ useAppShortcut: () => {} }));
vi.mock('../utils/analytics', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/analytics')>()),
    trackEvent: trackEventMock,
}));

import WorldbookApp from '../apps/WorldbookApp';

const makeEntry = (id: string, category: string, extra: Partial<Worldbook> = {}): Worldbook => ({
    id,
    title: `词条-${id}`,
    content: `正文-${id}`,
    category,
    createdAt: 1000,
    updatedAt: 1000,
    constant: true,
    disable: false,
    ...extra,
});

describe('WorldbookApp 分组与全开全关交互', () => {
    let host: HTMLDivElement;
    let root: Root;

    const renderApp = async () => {
        await act(async () => {
            root.render(React.createElement(WorldbookApp));
        });
    };

    const setInputValue = async (input: HTMLInputElement, value: string) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        await act(async () => {
            setter?.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
    };

    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
        state.worldbooks = [
            makeEntry('a1', '世界书A'),
            makeEntry('a2', '世界书A', { disable: true, title: '作者分割线' }),
            makeEntry('b1', '世界书B'),
            makeEntry('c1', '世界书C'),
        ];
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        document.body.innerHTML = '';
    });

    it('未建分组时不套未分组外框；建组后支持整组全开全关、组内单本微调与安全解散', async () => {
        await renderApp();

        // 1) 未建分组时不显示「未分组」外层壳，但每本世界书已有整书开关
        expect(document.querySelector('[data-worldbook-outer-group]')).toBeNull();
        expect(document.querySelector('[role="switch"][aria-label="启用世界书 世界书A"]')?.getAttribute('aria-checked')).toBe('true');

        // 2) 点击顶部「分组」按钮，把 世界书A 与 世界书B 归入「AB组」
        const openGroupBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent?.trim() === '分组');
        expect(openGroupBtn).toBeTruthy();
        await act(async () => { openGroupBtn!.click(); });

        const groupNameInput = document.querySelector('input[aria-label="外层分组名称"]') as HTMLInputElement;
        expect(groupNameInput).toBeTruthy();
        await setInputValue(groupNameInput, 'AB组');

        const checkBook = async (cat: string) => {
            const box = document.querySelector(`[data-group-pick-book="${cat}"]`) as HTMLElement;
            expect(box).toBeTruthy();
            await act(async () => { box.click(); });
        };
        await checkBook('世界书A');
        await checkBook('世界书B');

        const saveGroupBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent?.trim() === '保存分组');
        expect(saveGroupBtn).toBeTruthy();
        await act(async () => { saveGroupBtn!.click(); });
        await renderApp();

        expect(document.querySelector('[data-worldbook-outer-group="AB组"]')).toBeTruthy();
        expect(document.querySelector('[data-worldbook-outer-group="未分组"]')).toBeTruthy();
        expect(trackEventMock).toHaveBeenCalledWith('保存世界书分组', { 动作: '新建' });
        expect(JSON.stringify(trackEventMock.mock.calls)).not.toContain('AB组');

        // 3) 点击「AB组」总开关：同时关闭 世界书A 和 世界书B，但不改动 a2 词条自身的 disable
        const abSwitch = document.querySelector('[role="switch"][aria-label="启用分组 AB组"]') as HTMLElement;
        expect(abSwitch?.getAttribute('aria-checked')).toBe('true');
        await act(async () => { abSwitch.click(); });
        await renderApp();

        expect(state.worldbooks.filter(wb => wb.group === 'AB组').every(wb => wb.bookDisabled === true)).toBe(true);
        expect(state.worldbooks.find(wb => wb.id === 'a1')?.disable).toBe(false);
        expect(state.worldbooks.find(wb => wb.id === 'a2')?.disable).toBe(true);
        expect(state.worldbooks.find(wb => wb.id === 'c1')?.bookDisabled).toBeUndefined();
        expect(document.querySelector('[role="switch"][aria-label="启用分组 AB组"]')?.getAttribute('aria-checked')).toBe('false');

        // 再点「AB组」总开关：同时重新开启 世界书A 和 世界书B，作者分割线 a2 仍然停用
        await act(async () => {
            (document.querySelector('[role="switch"][aria-label="启用分组 AB组"]') as HTMLElement).click();
        });
        await renderApp();
        expect(state.worldbooks.filter(wb => wb.group === 'AB组').every(wb => wb.bookDisabled === false)).toBe(true);
        expect(state.worldbooks.find(wb => wb.id === 'a2')?.disable).toBe(true);

        // 4) 组内单独关闭「世界书B」：世界书A 保持开启，AB组总开关仍为开启（再点会整组全关）
        await act(async () => {
            (document.querySelector('[role="switch"][aria-label="启用世界书 世界书B"]') as HTMLElement).click();
        });
        await renderApp();
        expect(state.worldbooks.find(wb => wb.id === 'a1')?.bookDisabled).toBe(false);
        expect(state.worldbooks.find(wb => wb.id === 'b1')?.bookDisabled).toBe(true);
        expect(document.querySelector('[role="switch"][aria-label="启用分组 AB组"]')?.getAttribute('aria-checked')).toBe('true');

        // 5) 解散「AB组」：取消确认时不改动、不埋点；确认后退回未分组且不删除任何世界书
        trackEventMock.mockClear();
        const dissolveBtn = document.querySelector('[data-dissolve-group="AB组"]') as HTMLElement;
        expect(dissolveBtn).toBeTruthy();
        await act(async () => { dissolveBtn.click(); });

        const cancelBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent?.trim() === '取消');
        expect(cancelBtn).toBeTruthy();
        await act(async () => { cancelBtn!.click(); });
        expect(state.worldbooks.filter(wb => wb.group === 'AB组').length).toBe(3);
        expect(trackEventMock).not.toHaveBeenCalled();

        await act(async () => { dissolveBtn.click(); });
        const confirmBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent?.trim() === '确认解散');
        expect(confirmBtn).toBeTruthy();
        await act(async () => { confirmBtn!.click(); });
        await renderApp();

        expect(state.worldbooks).toHaveLength(4);
        expect(state.worldbooks.every(wb => wb.group === undefined)).toBe(true);
        expect(document.querySelector('[data-worldbook-outer-group]')).toBeNull();
        expect(trackEventMock).toHaveBeenCalledWith('保存世界书分组', { 动作: '解散' });
    });
});
