// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SullySupportPage from '../components/settings/SullySupportPage';
import { fetchBlobForShare, shareOrDownloadBlob } from './shareExport';
import { handleLocalBack } from './localBackHandlers';

vi.mock('./shareExport', () => ({ fetchBlobForShare: vi.fn(), shareOrDownloadBlob: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const close = vi.fn();
const button = (text: string) => [...host.querySelectorAll('button')].find(element => element.textContent?.includes(text))!;
const click = async (element: HTMLElement) => { await act(async () => element.click()); };

beforeEach(async () => {
    vi.resetAllMocks();
    vi.mocked(fetchBlobForShare).mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    vi.mocked(shareOrDownloadBlob).mockResolvedValue('downloaded');
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(React.createElement(SullySupportPage, { onClose: close })));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('saves the selected channel and treats a cancelled share as cancellation', async () => {
    await click(button('支付宝'));
    await click(button('保存投喂小票'));
    expect(fetchBlobForShare).toHaveBeenLastCalledWith(expect.stringContaining('alipay-support-card'), 'image/png');
    expect(shareOrDownloadBlob).toHaveBeenLastCalledWith(expect.objectContaining({ fileName: 'Sully-支付宝投喂小票.png' }));
    expect(host.textContent).toContain('已交给浏览器下载');
    vi.mocked(shareOrDownloadBlob).mockResolvedValueOnce('cancelled');
    await click(button('保存投喂小票'));
    expect(host.querySelector('[role=status]')?.textContent).toBe('');
});

it('prepares before the tap and invokes sharing synchronously in the click gesture', async () => {
    let resolve!: (value: Blob) => void;
    vi.mocked(fetchBlobForShare).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await click(button('支付宝'));
    expect(button('正在准备图片').disabled).toBe(true);
    await click(button('微信赞赏'));
    await act(async () => resolve(new Blob(['alipay png'])));
    expect(shareOrDownloadBlob).not.toHaveBeenCalled();
    act(() => {
        button('保存投喂小票').click();
        expect(shareOrDownloadBlob).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'Sully-微信投喂小票.png' }));
    });
    await act(async () => {});
});

it('reports save errors, keeps the original-code fallback and returns one level', async () => {
    vi.mocked(shareOrDownloadBlob).mockRejectedValueOnce(new Error('share unavailable'));
    await click(button('保存投喂小票'));
    expect(host.textContent).toContain('暂时无法保存');
    const trigger = button('打开原始赞赏码');
    await click(trigger);
    expect(host.querySelector('.original-page img')?.getAttribute('src')).toContain('wechat-original');
    await click(button('保存原始码'));
    expect(fetchBlobForShare).toHaveBeenLastCalledWith(expect.stringContaining('wechat-original'), 'image/png');
    await act(async () => { expect(handleLocalBack()).toBe(true); });
    expect(host.querySelector('.original-page')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(close).not.toHaveBeenCalled();
    await click(host.querySelector('[aria-label="返回设置"]')!);
    expect(close).toHaveBeenCalledOnce();
    expect(handleLocalBack()).toBe(false);
});

it('allows preparation to be retried without automatically sharing on completion', async () => {
    vi.mocked(fetchBlobForShare).mockRejectedValueOnce(new Error('offline'));
    await click(button('支付宝'));
    expect(host.textContent).toContain('图片暂未准备好');
    await click(button('重新准备图片'));
    expect(shareOrDownloadBlob).not.toHaveBeenCalled();
    await click(button('保存投喂小票'));
    expect(shareOrDownloadBlob).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'Sully-支付宝投喂小票.png' }));
});
