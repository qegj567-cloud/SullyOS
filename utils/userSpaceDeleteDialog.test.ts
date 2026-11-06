// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import UserSpaceDeleteDialog from '../components/user/UserSpaceDeleteDialog';
import { deleteUserSpace } from './userSpaceDeletion';
vi.mock('./userSpaceDeletion', () => ({ deleteUserSpace: vi.fn(async () => ({ cloudPending: false, assetsRetained: false })) }));
vi.mock('../hooks/useLocalBackHandler', () => ({ useLocalBackHandler: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, visibility = 'visible';
const onClose = vi.fn(), onDeleted = vi.fn();
const render = () => act(() => root.render(React.createElement(UserSpaceDeleteDialog, { space: { id: 'u_delete', name: '待删用户' }, onClose, onDeleted })));
const confirm = () => Array.from(document.querySelectorAll('button')).find(b => /继续|永久删除/.test(b.textContent!))!;
const seconds = async (count: number) => { for (let i = 0; i < count; i++) await act(async () => { vi.advanceTimersByTime(1000); }); };
beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    visibility = 'visible'; vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
    host = document.createElement('div'); document.body.append(host); root = createRoot(host); render();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('requires two distinct ten-second foreground waits, excluding background time', async () => {
    await seconds(9); expect(confirm().disabled).toBe(true); act(() => confirm().click()); expect(deleteUserSpace).not.toHaveBeenCalled();
    visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); await seconds(30); expect(confirm().disabled).toBe(true);
    visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); await seconds(1); expect(confirm().disabled).toBe(false);
    act(() => confirm().click()); expect(document.body.textContent).toContain('2 / 2'); expect(confirm().disabled).toBe(true);
    await seconds(9); expect(confirm().disabled).toBe(true); expect(deleteUserSpace).not.toHaveBeenCalled();
    await seconds(1); await act(async () => confirm().click());
    expect(deleteUserSpace).toHaveBeenCalledTimes(1); expect(onDeleted).toHaveBeenCalledOnce();
});
it('cancelling never deletes, and reopening starts the first countdown again', async () => {
    await seconds(10); act(() => confirm().click()); await seconds(7);
    act(() => Array.from(document.querySelectorAll('button')).find(b => b.textContent === '取消')!.click());
    expect(onClose).toHaveBeenCalledOnce(); expect(deleteUserSpace).not.toHaveBeenCalled();
    act(() => root.render(null)); render(); expect(confirm().textContent).toBe('继续（10s）');
});
