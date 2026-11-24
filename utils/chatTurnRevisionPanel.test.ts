// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import TurnRevisionPanel from '../components/chat/TurnRevisionPanel';
import { trackEvent } from './analytics';
import type { TurnPreview } from './chatTurnRevision';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('./blobRef', () => ({ useBlobRefUrl: () => undefined }));

it('lets the user keep or accept a preview and reports only fixed failure events', async () => {
    const original = { id: 4, charId: 'private-id', role: 'assistant', type: 'text', timestamp: 12, content: '私人原版' } as const;
    const preview: TurnPreview = { originals: [original], mode: 'reroll', bubbles: [{ type: 'text', content: '私人新版' }] };
    const generate = vi.fn().mockRejectedValueOnce(new Error('私人错误')).mockResolvedValue(preview);
    const accept = vi.fn().mockRejectedValueOnce(new Error('私人写入错误')).mockResolvedValue(undefined);
    const close = vi.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    const click = async (label: string) => {
        const button = [...host.querySelectorAll('button')].find(item => item.textContent === label);
        expect(button).toBeTruthy();
        await act(async () => button!.click());
    };
    try {
        await act(async () => root.render(React.createElement(TurnRevisionPanel, { mode:'reroll', canRevise:true,
            onPreview:generate, onAccept:accept, onDone:close, setSaving:vi.fn() })));
        await click('生成候选回复');
        expect(host.textContent).toContain('私人错误');
        await click('生成候选回复');
        expect(host.querySelector('details')?.textContent).toContain('私人原版');
        expect(host.textContent).toContain('私人新版');
        expect(accept).not.toHaveBeenCalled();
        await click('保留原版');
        expect(close).toHaveBeenCalledTimes(1);
        expect(accept).not.toHaveBeenCalled();
        await click('采用新版');
        expect(close).toHaveBeenCalledTimes(1);
        expect(host.textContent).toContain('私人写入错误');
        await click('采用新版');
        expect(accept).toHaveBeenCalledWith(preview);
        expect(close).toHaveBeenCalledTimes(2);
        expect(vi.mocked(trackEvent).mock.calls).toEqual([['对话校准预览失败'], ['对话校准采用失败']]);
    } finally { await act(async () => root.unmount()); }
});
