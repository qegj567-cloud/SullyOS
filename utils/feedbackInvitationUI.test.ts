// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import FeedbackInvitation from '../components/FeedbackInvitation';
import { initializeFeedbackInvitation, recordFeedbackVisit, suppressFeedbackInvitation } from './feedbackInvitation';

let root: Root, host: HTMLDivElement;
const DAY = 86_400_000;
const start = new Date(2026, 8, 20, 12).getTime();
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(start + 7 * DAY);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    initializeFeedbackInvitation(0, false, start);
    [0, 1, 2].forEach(day => recordFeedbackVisit(start + day * DAY));
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
const render = async (blocked: boolean) => { await act(async () => root.render(React.createElement(FeedbackInvitation, { ready: true, blocked }))); };
const wait = async () => { await act(async () => vi.advanceTimersByTimeAsync(1600)); };

it('让位给其他界面与弹窗，解除后只出现一个我知道了按钮', async () => {
    await render(true); await wait(); expect(host.textContent).toBe('');
    await render(false); await wait();
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.querySelectorAll('button')).toHaveLength(1);
    expect(host.querySelector('button')!.textContent).toBe('我知道了');
    expect(host.querySelectorAll('a')).toHaveLength(0);
    expect(host.querySelector('img[alt="Sully 的微信赞赏码"]')).not.toBeNull();
    await act(async () => host.querySelector('button')!.click());
    await wait(); expect(host.textContent).toBe('');
});
it('后台不弹，恢复前台后展示', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await render(false); await wait(); expect(host.textContent).toBe('');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
});
it('导入备份立即关闭已经打开的邀请', async () => {
    await render(false); await wait();
    await act(async () => suppressFeedbackInvitation());
    expect(host.textContent).toBe('');
});
