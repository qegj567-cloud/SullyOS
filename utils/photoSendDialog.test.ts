// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import PhotoSendDialog from '../components/chat/PhotoSendDialog';
vi.mock('../hooks/useLocalBackHandler', () => ({ useLocalBackHandler: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it('requires explicit original selection, preserves choice on warning cancellation and remembers opt-out only after confirmation', async () => {
    localStorage.clear();
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host), send = vi.fn(), close = vi.fn();
    await act(async () => root.render(React.createElement(PhotoSendDialog, { file: new File(['photo'], 'photo.png', { type: 'image/png' }), onSend: send, onClose: close })));
    const button = (label: string) => Array.from(document.querySelectorAll('button')).find(b => b.textContent === label)!;
    const original = document.querySelector<HTMLInputElement>('input')!;
    expect(original.checked).toBe(false);
    await act(async () => original.click());
    await act(async () => button('发送').click());
    expect(document.body.textContent).toContain('Token');
    await act(async () => Array.from(document.querySelectorAll('button')).filter(b => b.textContent === '取消')[0].click());
    expect(send).not.toHaveBeenCalled(); expect(original.checked).toBe(true);
    await act(async () => button('发送').click());
    const remember = Array.from(document.querySelectorAll('label')).find(l => l.textContent === '不再提示')!.querySelector('input')!;
    await act(async () => remember.click());
    await act(async () => button('仍然发送原图').click());
    expect(send).toHaveBeenCalledWith(true);
    expect(localStorage.getItem('chat_original_photo_notice_dismissed')).toBe('1');
    act(() => root.unmount()); host.remove();
});
