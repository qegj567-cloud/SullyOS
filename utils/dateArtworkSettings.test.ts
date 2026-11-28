// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import DateArtworkSettings from '../components/date/DateArtworkSettings';

const mocks = vi.hoisted(() => ({ update: vi.fn(), toast: vi.fn(), process: vi.fn(async () => new Blob(['image'])), put: vi.fn(async () => 'blobref:test-image') }));
vi.mock('../context/OSContext', () => ({ useOS: () => ({ updateCharacter: mocks.update, addToast: mocks.toast }) }));
vi.mock('../hooks/useConfirmDialog', () => ({ useConfirmDialog: () => ({ requestConfirm: async () => true, confirmDialog: null }) }));
vi.mock('./file', () => ({ processImageToBlob: mocks.process }));
vi.mock('./blobRef', () => ({ putImageBlob: mocks.put }));
vi.mock('../components/os/TokenImg', () => ({ default: () => null }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it('在同一区管理默认/皮肤情绪，图片链接和本地上传写入正确目标并保留其他素材', async () => {
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    let saved: any;
    function Harness() {
        const [char, setChar] = useState({ id: 'art', name: '角色', sprites: { normal: 'original', chibi: 'room-image' }, customDateSprites: ['excited'],
            dateSkinSets: [{ id: 'winter', name: '冬装', sprites: { happy: 'winter-happy' } }] });
        saved = char;
        mocks.update.mockImplementation((_id, patch) => setChar(previous => ({ ...previous, ...(typeof patch === 'function' ? patch(previous) : patch) })));
        return React.createElement(DateArtworkSettings, { char: char as any });
    }
    const click = async (name: string) => act(async () => {
        const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(el => el.getAttribute('aria-label') === name || el.textContent === name);
        expect(button, name).toBeTruthy(); button!.click();
    });
    const fill = async (label: string, value: string) => act(async () => {
        const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const saveUrl = async (value: string) => { await click('使用图片链接'); await fill('图片链接', value); await click('保存图片'); };
    try {
        await act(async () => root.render(React.createElement(Harness)));
        const section = [...host.querySelectorAll('details')].find(el => el.querySelector('summary')?.textContent === '立绘与皮肤')!;
        await act(async () => { section.open = true; section.dispatchEvent(new Event('toggle')); });
        await click('设置平静立绘');
        await saveUrl('https://example.com/normal.png');
        expect(saved.sprites).toEqual({ normal: 'https://example.com/normal.png', chibi: 'room-image' });
        expect(host.querySelector('select')).toBeNull();
        await click('选择立绘套装');
        await click('冬装');
        expect(saved.activeSkinSetId).toBe('winter');
        expect(host.querySelector('[aria-label="选择立绘套装"]')?.textContent).toContain('当前使用');
        await click('设置excited立绘');
        await saveUrl('https://example.com/excited.png');
        expect(saved.dateSkinSets[0].sprites).toEqual({ happy: 'winter-happy', excited: 'https://example.com/excited.png' });
        expect(saved.sprites.chibi).toBe('room-image');
        await click('更换见面背景');
        await saveUrl('javascript:alert(1)');
        expect(host.querySelector('[role="alert"]')?.textContent).toContain('有效的图片链接');
        expect(saved.dateBackground).toBeUndefined();
        await fill('图片链接', 'https://example.com/bg.jpg'); await click('保存图片');
        expect(saved.dateBackground).toBe('https://example.com/bg.jpg');
        const uploadFile = async () => act(async () => {
            const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
            Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'image.png', { type: 'image/png' })] });
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await click('更换见面背景'); await uploadFile();
        expect(mocks.process).toHaveBeenLastCalledWith(expect.any(File), { skipCompression: true });
        expect(saved.dateBackground).toBe('blobref:test-image');
        await click('设置平静立绘'); await uploadFile();
        expect(mocks.process).toHaveBeenLastCalledWith(expect.any(File), undefined);
        expect(saved.dateSkinSets[0].sprites.normal).toBe('blobref:test-image');
        expect(saved.sprites.normal).toBe('https://example.com/normal.png');
        await click('删除情绪excited');
        expect(saved.customDateSprites).toEqual([]);
        expect(saved.dateSkinSets[0].sprites.excited).toBeUndefined();
        expect(saved.sprites.chibi).toBe('room-image');
        await click('选择立绘套装');
        await click('新建套装');
        await fill('新皮肤名称', '夏装');
        await click('创建');
        expect(saved.dateSkinSets).toHaveLength(2);
        expect(saved.activeSkinSetId).toBe(saved.dateSkinSets[1].id);
        await click('选择立绘套装');
        expect(host.querySelector('[role="radio"][aria-label="夏装"]')?.getAttribute('aria-checked')).toBe('true');
        await click('默认立绘');
        expect(saved.activeSkinSetId).toBeUndefined();
        expect(saved.sprites.chibi).toBe('room-image');
    } finally { await act(async () => root.unmount()); host.remove(); }
});
