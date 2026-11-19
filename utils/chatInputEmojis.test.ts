// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Blob as CloneableBlob } from 'node:buffer';
import ChatInputArea from '../components/chat/ChatInputArea';
import type { Emoji } from '../types';
import { DB } from './db';
import { dataUrlToBlob, putImageBlob } from './blobRef';
import { EMOJI_THUMBNAIL_CACHE_LIMIT } from './useEmojiThumbnailCache';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let objectUrlSeq = 0;
const createObjectURL = vi.fn(() => `blob:emoji-${++objectUrlSeq}`);
const revokeObjectURL = vi.fn();
(URL as any).createObjectURL = createObjectURL;
(URL as any).revokeObjectURL = revokeObjectURL;
let container: HTMLDivElement;
let root: Root;
const onPanelAction = vi.fn();
const categories = [{ id: 'a', name: '分组 A' }, { id: 'b', name: '分组 B' }];

function Panel({ emojis, showPanel = 'emojis' }: { emojis: Emoji[]; showPanel?: 'emojis'|'none'|'actions' }) {
    const [activeCategory, setActiveCategory] = useState('a');
    return createElement(ChatInputArea, {
        input: '', setInput: () => {}, isTyping: false, selectionMode: false,
        showPanel, setShowPanel: () => {}, onSend: () => {},
        onDeleteSelected: () => {}, selectedCount: 0,
        emojis: emojis.filter(e => e.categoryId === activeCategory), suggestionEmojis: emojis, categories, activeCategory,
        onPanelAction: (action, payload) => {
            if (action === 'select-category') setActiveCategory(payload);
            onPanelAction(action, payload);
        },
        onImageSelect: () => {}, isSummarizing: false, onReroll: () => {}, canReroll: false,
    });
}
function thumbnails() {
    return Array.from(container.querySelectorAll<HTMLImageElement>('img.sully-emoji-thumb')).filter(img => !img.closest('button')!.hidden);
}
function names() {
    return thumbnails().map(img => img.closest('button')!.querySelector('span')!.textContent);
}
function clickGroup(name: string) {
    const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === name)!;
    act(() => button.click());
}
function clickLabel(label: string) {
    act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
}
async function render(emojis: Emoji[]) {
    await act(async () => { root.render(createElement(Panel, { emojis })); });
}

beforeEach(() => {
    // fake-indexeddb uses Node's structuredClone; jsdom's Blob loses its bytes there.
    vi.stubGlobal('Blob', CloneableBlob);
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('表情面板的记录身份与图片复用', () => {
    it('首次打开才加载，关闭再打开或切加号不重建图片，退出聊天仍释放引用', async () => {
        const ref = await putImageBlob(dataUrlToBlob(PNG));
        const emojis = [{name: '缓存', url: ref, categoryId: 'a'}];
        const show = async (showPanel: 'none'|'emojis'|'actions') => {
            await act(async () => { root.render(createElement(Panel, {emojis, showPanel})); });
        };
        await show('none'); expect(thumbnails()).toHaveLength(0);
        await show('emojis');
        await act(async () => { await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalled()); });
        const first = thumbnails()[0]; const src = first.src;
        const calls = createObjectURL.mock.calls.length;
        for (const state of ['none','actions','emojis','none','emojis'] as const) {
            await show(state);
            expect(thumbnails()[0]).toBe(first);
            expect(first.src).toBe(src);
            expect(container.querySelector<HTMLElement>('[data-testid="emoji-panel"]')!.style.display).toBe(state === 'emojis' ? 'flex' : 'none');
        }
        expect(createObjectURL).toHaveBeenCalledTimes(calls);
        await act(async () => root.render(null));
        expect(revokeObjectURL).toHaveBeenCalledWith(src);
    });
    it('共用图片令牌的表情反复切分组、重新读取后，都不残留或复制旧格子', async () => {
        const sharedRef = await putImageBlob(dataUrlToBlob(PNG));
        const emojis: Emoji[] = [
            { name: '我吗', url: sharedRef, categoryId: 'a' },
            { name: '疑问', url: sharedRef, categoryId: 'a' },
            { name: '开心', url: 'https://example.com/happy.png', categoryId: 'a' },
            { name: '你好', url: 'https://example.com/hello.png', categoryId: 'b' },
            { name: '问号', url: sharedRef, categoryId: 'b' },
        ];
        for (const e of emojis) await DB.saveEmoji(e.name, e.url, e.categoryId);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        for (let reopen = 0; reopen < 2; reopen++) {
            await render(await DB.getEmojis());
            for (let i = 0; i < 5; i++) {
                expect(names().sort()).toEqual(['我吗', '疑问', '开心'].sort());
                clickGroup('分组 B');
                expect(names().sort()).toEqual(['你好', '问号'].sort());
                clickGroup('分组 A');
            }
            await act(async () => { root.render(null); });
        }
        expect(errors.mock.calls.filter(args => args.join(' ').includes('same key'))).toEqual([]);
        expect(await DB.getEmojis()).toEqual(expect.arrayContaining(emojis));
    });

    it('大量共用 URL 的表情仍每页最多显示 40 张，缓存有上限，翻页和换组数量准确', async () => {
        const emojis: Emoji[] = ['a', 'b'].flatMap(categoryId => Array.from({ length: 85 }, (_, i) => ({
            name: `${categoryId}-${i}`, categoryId, url: `https://example.com/shared-${i % 3}.png`,
        })));
        await render(emojis);
        const expectPage = (category: string, start: number, end: number) => {
            expect(names()).toEqual(emojis.filter(e => e.categoryId === category).slice(start, end).map(e => e.name));
            expect(thumbnails().length).toBeLessThanOrEqual(40);
            expect(container.querySelectorAll('img.sully-emoji-thumb').length).toBeLessThanOrEqual(EMOJI_THUMBNAIL_CACHE_LIMIT);
            for (const img of thumbnails()) {
                expect(img.getAttribute('loading')).toBe('lazy');
                expect(img.getAttribute('decoding')).toBe('async');
            }
        };
        expectPage('a', 0, 40);
        clickLabel('下一页表情');
        expectPage('a', 40, 80);
        clickLabel('下一页表情');
        expectPage('a', 80, 85);
        clickGroup('分组 B');
        expectPage('b', 0, 40);
        clickLabel('下一页表情');
        expectPage('b', 40, 80);
        clickLabel('上一页表情');
        expectPage('b', 0, 40);
        clickGroup('分组 A');
        expectPage('a', 0, 40);
    });

    it('切换分组和翻页后复用原 img 与 Blob URL，超出缓存淘汰旧图，退出释放全部引用', async () => {
        const ref = await putImageBlob(dataUrlToBlob(PNG));
        const emojis: Emoji[] = ['a', 'b'].flatMap(categoryId => Array.from({length: 81}, (_, i) => ({
            name: `${categoryId}-${i}`, categoryId, url: ref,
        })));
        await render(emojis);
        await act(async () => { await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(40)); });
        const first = thumbnails()[0], src = first.src;
        clickGroup('分组 B');
        await act(async () => { await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(80)); });
        clickGroup('分组 A');
        expect(thumbnails()[0]).toBe(first); expect(first.src).toBe(src);
        expect(createObjectURL).toHaveBeenCalledTimes(80); expect(revokeObjectURL).not.toHaveBeenCalled();
        clickLabel('下一页表情');
        await act(async () => { await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(120)); });
        clickLabel('上一页表情');
        expect(thumbnails()[0]).toBe(first); expect(first.src).toBe(src);
        clickGroup('分组 B'); clickLabel('下一页表情');
        await act(async () => { await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(160)); });
        expect(container.querySelectorAll('img.sully-emoji-thumb')).toHaveLength(120);
        expect(revokeObjectURL).toHaveBeenCalledTimes(40);
        expect(revokeObjectURL).not.toHaveBeenCalledWith(src); // recently revisited A survives
        await act(async () => root.render(null));
        expect(revokeObjectURL).toHaveBeenCalledTimes(160);
        expect(revokeObjectURL).toHaveBeenCalledWith(src);
    });

    it('隐藏分组里删除或换图会释放旧图，返回时不会显示已删或过期的表情', async () => {
        const ref = await putImageBlob(dataUrlToBlob(PNG));
        const emojis: Emoji[] = [
            {name:'删除我',categoryId:'a',url:ref}, {name:'替换我',categoryId:'a',url:ref},
            {name:'B',categoryId:'b',url:PNG},
        ];
        await render(emojis);
        await act(async () => { await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2)); });
        const old = thumbnails()[1]; clickGroup('分组 B');
        await render([{...emojis[1],url:PNG},emojis[2]]);
        expect(revokeObjectURL).toHaveBeenCalledTimes(2);
        clickGroup('分组 A');
        expect(names()).toEqual(['替换我']); expect(thumbnails()[0]).not.toBe(old);
        expect(thumbnails()[0].src).toBe(PNG);
    });

    it('同一表情未换图时复用节点，换图时重建图片节点以免保留旧位图', async () => {
        const original: Emoji = { name: '你好', categoryId: 'a', url: 'https://example.com/old.png' };
        await render([original]);
        const oldImage = thumbnails()[0];
        await render([{ ...original }]);
        expect(thumbnails()[0]).toBe(oldImage);
        await render([{ ...original, url: 'https://example.com/new.png' }]);
        expect(thumbnails()[0]).not.toBe(oldImage);
        expect(thumbnails()[0].getAttribute('src')).toBe('https://example.com/new.png');
    });

    it('同图不同名的表情可分别选择，删除只提交实际选中的记录', async () => {
        const emojis: Emoji[] = ['我吗', '疑问'].map(name => ({
            name, categoryId: 'a', url: 'https://example.com/shared.png',
        }));
        await render(emojis);
        clickLabel('批量管理表情');
        const buttons = thumbnails().map(img => img.closest('button')!);
        act(() => buttons[0].click());
        expect(buttons.map(b => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
        act(() => buttons[1].click());
        expect(buttons.map(b => b.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
        act(() => buttons[0].click());
        expect(buttons.map(b => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
        clickLabel('删除选中的表情');
        expect(onPanelAction).toHaveBeenLastCalledWith('delete-emoji-req', [emojis[1]]);
    });
});
