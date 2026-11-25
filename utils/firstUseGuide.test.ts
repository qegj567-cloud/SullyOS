// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUIDE_KEY, GUIDE_SULLY_ID, initializeFirstUseGuide, readGuideStep, setGuideStep } from './firstUseGuide';
import { AppID } from '../types';
import FirstUseGuide from '../components/FirstUseGuide';
import { MainApiMemoryChoice, SkipVectorMemoryChoice } from '../components/MemoryGuideActions';

const mocked = vi.hoisted(() => ({ os: {} as any }));
vi.mock('../context/OSContext', () => ({ useOS: () => mocked.os }));

let root: Root;
let host: HTMLDivElement;
async function render() { await act(async () => root.render(React.createElement(React.Fragment, null,
    React.createElement(FirstUseGuide), React.createElement(MainApiMemoryChoice), React.createElement(SkipVectorMemoryChoice)))); }
async function click(text: string) {
    const button = [...host.querySelectorAll('button')].find(b => b.textContent === text)!;
    expect(button).toBeTruthy();
    await act(async () => button.click());
}
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    host = document.createElement('div');
    host.id = 'root';
    document.body.append(host);
    root = createRoot(host);
    mocked.os = {
        apiConfig: {}, memoryPalaceConfig: { embedding: {} },
        characters: [{ id: GUIDE_SULLY_ID }], activeApp: AppID.Launcher,
        activeCharacterId: GUIDE_SULLY_ID,
        openApp: vi.fn((id) => { mocked.os.activeApp = id; }),
        setActiveCharacterId: vi.fn(),
        updateMemoryPalaceConfig: vi.fn(patch => Object.assign(mocked.os.memoryPalaceConfig, patch)),
    };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('first-use memory guide', () => {
    it('reveals the main API address after lazy mount and again on return, without scrolling while editing', async () => {
        setGuideStep(0);
        await render();
        await render(); // Commit the mocked navigation to Settings before its lazy content mounts.
        const section = document.createElement('section');
        section.dataset.guide = 'api';
        const address = document.createElement('label');
        address.dataset.apiField = 'base-url';
        section.append(address);
        const scroll = vi.spyOn(address, 'scrollIntoView');
        const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        await act(async () => { host.append(section); await nextFrame(); await nextFrame(); });
        expect(address.classList.contains('first-use-highlight')).toBe(true);
        expect(scroll).toHaveBeenLastCalledWith({ block: 'center', inline: 'nearest' });
        scroll.mockClear();
        await act(async () => { address.append(document.createElement('input')); await nextFrame(); });
        expect(scroll).not.toHaveBeenCalled();
        await click('回到本步页面');
        await act(nextFrame);
        expect(scroll).toHaveBeenCalledOnce();
        expect(document.activeElement).not.toBe(address.firstElementChild);
    });

    it.each([0, 1, 2, 3, 4, 5, 6])('can directly skip step %s without changing configuration or navigating', async step => {
        setGuideStep(step); await render();
        await click('收起');
        const previous = JSON.stringify(mocked.os.memoryPalaceConfig);
        mocked.os.openApp.mockClear(); mocked.os.updateMemoryPalaceConfig.mockClear();
        await click('直接跳过引导');
        expect(localStorage.getItem(GUIDE_KEY)).toBe('done');
        expect(document.querySelector('[aria-label="首次使用引导"]')).toBeNull();
        expect(mocked.os.openApp).not.toHaveBeenCalled();
        expect(mocked.os.updateMemoryPalaceConfig).not.toHaveBeenCalled();
        expect(JSON.stringify(mocked.os.memoryPalaceConfig)).toBe(previous);
        await act(async () => root.unmount()); root = createRoot(host); await render();
        expect(document.querySelector('[aria-label="首次使用引导"]')).toBeNull();
    });

    it('points to Sully first, then moves the highlight to Send message and removes it on skip', async () => {
        const card = document.createElement('button'); card.dataset.guide = 'sully-card';
        card.getBoundingClientRect = () => ({ left: 200, top: 400, bottom: 440, width: 80, height: 40 } as DOMRect);
        document.body.append(card);
        setGuideStep(3); await render();
        expect(card.classList.contains('first-use-highlight')).toBe(true);
        expect(document.body.textContent).toContain('点击 Sully，打开角色详情');
        const send = document.createElement('button'); send.dataset.guide = 'sully-message';
        send.getBoundingClientRect = card.getBoundingClientRect;
        await act(async () => { host.append(send); });
        expect(send.classList.contains('first-use-highlight')).toBe(true);
        expect(card.classList.contains('first-use-highlight')).toBe(false);
        expect(document.body.textContent).toContain('点击「发消息」进入聊天');
        await click('直接跳过引导');
        expect(send.classList.contains('first-use-highlight')).toBe(false);
        expect(document.body.textContent).not.toContain('点击「发消息」进入聊天');
        card.remove(); send.remove();
    });
    it('does not interrupt existing users and preserves an unfinished new-user step', () => {
        initializeFirstUseGuide(3);
        expect(readGuideStep()).toBeNull();
        expect(localStorage.getItem(GUIDE_KEY)).toBe('done');
        localStorage.clear();
        initializeFirstUseGuide(0);
        expect(readGuideStep()).toBe(0);
        setGuideStep(2);
        initializeFirstUseGuide(1);
        expect(readGuideStep()).toBe(2);
    });

    it('requires saved configurations and both Sully switches before continuing', async () => {
        initializeFirstUseGuide(0);
        await render();
        expect(mocked.os.openApp).toHaveBeenCalledWith(AppID.Settings);
        await click('下一步');
        expect(readGuideStep()).toBe(0);
        mocked.os.apiConfig = { baseUrl: 'https://example.test/v1', apiKey: 'test', model: 'chat' };
        await render(); await click('下一步');
        expect(mocked.os.openApp).toHaveBeenLastCalledWith(AppID.MemoryPalace);
        await click('下一步'); expect(readGuideStep()).toBe(1);
        mocked.os.memoryPalaceConfig.embedding = { ...mocked.os.apiConfig, model: 'embedding' };
        await render(); await click('下一步'); expect(readGuideStep()).toBe(1);
        await click('我想暂时只用主 API');
        expect(mocked.os.memoryPalaceConfig.lightLLM).toEqual({ baseUrl: '', apiKey: '', model: '' });
        await render(); await click('下一步');
        await click('下一步'); expect(readGuideStep()).toBe(2);
        mocked.os.characters[0].memoryPalaceEnabled = true;
        await render(); await click('下一步'); expect(readGuideStep()).toBe(2);
        mocked.os.characters[0].autoArchiveEnabled = true;
        await render(); await click('下一步'); expect(readGuideStep()).toBe(3);
        expect(mocked.os.openApp).toHaveBeenLastCalledWith(AppID.Character);
    });

    it('can skip vectors after choosing a secondary API, resumes that path, and can return to setup', async () => {
        mocked.os.apiConfig = { baseUrl: 'https://example.test/v1', apiKey: 'test', model: 'chat' };
        setGuideStep(1); await render();
        await click('暂时跳过向量记忆'); expect(readGuideStep()).toBe(1);
        await click('我想暂时只用主 API'); await render();
        await click('暂时跳过向量记忆');
        expect(readGuideStep()).toBe(3);
        expect(mocked.os.characters[0].autoArchiveEnabled).toBeUndefined();
        expect(mocked.os.memoryPalaceConfig.embedding).toEqual({});
        expect(mocked.os.openApp).toHaveBeenLastCalledWith(AppID.Character);
        await act(async () => root.unmount()); root = createRoot(host); await render();
        expect(host.textContent).toContain('3/6');
        await click('上一步'); expect(readGuideStep()).toBe(1);
        mocked.os.memoryPalaceConfig.embedding = { ...mocked.os.apiConfig, model: 'embedding' };
        await render(); await click('下一步');
        expect(readGuideStep()).toBe(2);
        expect(host.textContent).toContain('3/7');
    });

    it('does not claim automatic memory is enabled after skipping vector setup', async () => {
        mocked.os.memoryPalaceConfig.lightLLM = { baseUrl: 'https://example.test/v1', apiKey: 'test', model: 'chat' };
        setGuideStep(1); await render(); await click('暂时跳过向量记忆');
        await act(async () => setGuideStep(6));
        expect(host.textContent).toContain('本次引导没有为你开启全自动记忆');
        expect(host.textContent).not.toContain('7/7');
        await click('完成引导'); expect(host.textContent).toBe('');
    });

    it('highlights generation without clicking it, then waits for the desktop Chat entry', async () => {
        const generate = document.createElement('button');
        generate.dataset.guide = 'generate';
        const generateRequest = vi.fn(); generate.onclick = generateRequest;
        document.body.append(generate);
        setGuideStep(3); await render(); await render();
        mocked.os.activeApp = AppID.Chat;
        await render();
        expect(readGuideStep()).toBe(4);
        expect(generate.classList.contains('first-use-highlight')).toBe(true);
        await click('知道了，回桌面');
        expect(readGuideStep()).toBe(5);
        expect(mocked.os.openApp).toHaveBeenLastCalledWith(AppID.Launcher);
        await render();
        await click('下一步'); expect(readGuideStep()).toBe(5);
        mocked.os.activeApp = AppID.Chat; await render();
        expect(readGuideStep()).toBe(6);
        expect(host.textContent).toContain('全自动用户大部分时候不需要操作');
        await click('完成引导');
        expect(host.textContent).toBe('');
        expect(generateRequest).not.toHaveBeenCalled();
        expect(generate.classList.contains('first-use-highlight')).toBe(false);
        generate.remove();
    });
});
