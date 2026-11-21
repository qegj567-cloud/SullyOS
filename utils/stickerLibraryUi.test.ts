// @vitest-environment jsdom
import React, { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Blob as NativeBlob, File as NativeFile } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import { DB, openDB } from './db';
import { commitSpaceRows } from './userSpaceData';
import type { APIConfig, CharacterProfile, Emoji, EmojiCategory } from '../types';
import StickerLibrary from '../components/chat/StickerLibrary';
import { handleLocalBack } from './localBackHandlers';
import * as analytics from './analytics';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it('imports files and a downloaded ZIP through the manager controls and only reports fixed analytics values', async () => {
    vi.stubGlobal('Blob', NativeBlob);
    vi.stubGlobal('File', NativeFile);
    vi.stubGlobal(
        'Image',
        class {
            onload?: () => void;
            set src(_: string) {
                queueMicrotask(() => this.onload?.());
            }
            removeAttribute() {}
        }
    );
    const urls = new Map<string, Blob>();
    URL.createObjectURL = (blob) => {
        const url = 'blob:test-' + urls.size;
        urls.set(url, blob as Blob);
        return url;
    };
    URL.revokeObjectURL = () => {};
    const vision = vi.fn(
        async (_url: RequestInfo | URL, _init?: RequestInit) =>
            new Response(
                JSON.stringify({
                    choices: [{ message: { content: JSON.stringify([{ id: 1, name: '新建议名' }]) } }],
                }),
                { headers: { 'Content-Type': 'application/json' } }
            )
    );
    vi.stubGlobal('fetch', vision);
    const track = vi.spyOn(analytics, 'trackEvent').mockImplementation(() => {});
    let downloaded: File | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        if (this.download)
            downloaded = new File([urls.get(this.href)!], this.download, { type: 'application/zip' });
    });
    await commitSpaceRows(await openDB(), { emojis: [], emoji_categories: [] }, true);
    const character = {
        id: 'test',
        name: '角色私密名称',
        dialogueApi: { baseUrl: 'https://private.test', apiKey: 'private', model: '角色模型' },
    } as CharacterProfile;
    const otherRole = {
        ...character,
        id: 'other', groupId: 'last',
        dialogueApi: { baseUrl: 'https://other.test/v1', apiKey: 'other', model: '另一个模型' },
    };
    function Manager() {
        const [rows, setRows] = useState<Emoji[]>([]),
            [groups, setGroups] = useState<EmojiCategory[]>([]);
        async function refresh() {
            setRows(await DB.getEmojis());
            setGroups(await DB.getEmojiCategories());
        }
        useEffect(() => {
            void refresh();
        }, []);
        return React.createElement(StickerLibrary, {
            emojis: rows,
            groups,
            characters: [character, ...Array.from({ length: 220 }, (_, i) => ({ ...character, id: 'c' + i, name: '角色' + i })), otherRole],
            characterGroups: [{ id: 'last', name: '最后一个分组' }],
            characterId: character.id,
            api: { baseUrl: 'https://model.test/v1', apiKey: 'fixture', model: '测试模型' } as APIConfig,
            onChange: refresh,
            onClose: () => {},
            onVision: async () => {},
        });
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const button = (name: string) =>
        Array.from(document.querySelectorAll('button')).find((b) => b.textContent === name);
    const click = async (name: string) => {
        await act(async () => {
            const target = button(name);
            expect(target?.disabled, name).toBe(false);
            target!.click();
        });
    };
    const wait = async (check: () => void) => {
        await vi.waitFor(async () => {
            await act(async () => {
                await new Promise((r) => setTimeout(r, 5));
            });
            check();
        });
    };
    const pick = async (accept: string, files: File[], folderName?: string) => {
        const input = document.querySelector<HTMLInputElement>('input[accept="' + accept + '"]')!;
        Object.defineProperty(input, 'files', { value: files, configurable: true });
        await act(async () => {
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await wait(() => expect(button('确认导入')).toBeDefined());
        if (folderName) {
            const target = document.querySelector<HTMLSelectElement>('.st-work select')!;
            await act(async () => {
                target.value = Array.from(target.options).find(option => option.textContent?.includes('新建文件夹'))!.value;
                target.dispatchEvent(new Event('change', { bubbles: true }));
            });
            const name = document.querySelector<HTMLInputElement>('.st-new-folder input')!;
            await act(async () => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, folderName);
                name.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await click('创建并选用');
            await wait(() => expect(target.selectedOptions[0].textContent).toBe(folderName));
        }
        await click('确认导入');
        await wait(() => expect(button('完成')).toBeDefined());
        expect(button('为新导入的 2 张看图起名')).toBeDefined();
        await click('完成');
    };
    try {
        await act(async () => {
            root.render(React.createElement(Manager));
        });
        const a = new File([Uint8Array.of(137, 80, 78, 71, 1)], '一个私密名字.png', { type: 'image/png' });
        const b = new File([Uint8Array.of(137, 80, 78, 71, 2)], '一个私密名字.png', { type: 'image/png' });
        await click('导入');
        await pick('image/*', [a, b, a], '我的文件夹');
        const [folder] = await DB.getEmojiCategories();
        expect(folder).toMatchObject({ name: '我的文件夹', personalOnly: true });
        expect((await DB.getEmojis()).every(e => e.categoryId === folder.id)).toBe(true);
        expect((await DB.getEmojis()).map((row) => row.name)).toEqual(['一个私密名字', '一个私密名字 2']);
        await click('选择');
        await click('全选当前结果');
        await click('导出');
        await wait(() => expect(button('分享 / 保存文件')?.disabled).toBe(false));
        await click('分享 / 保存文件');
        expect(downloaded?.name).toMatch(/\.zip$/);
        const before = await DB.getEmojis();
        await click('删除');
        await click('确认删除');
        await wait(() => expect(document.body.textContent).toContain('已删除 2 张'));
        expect(await DB.getEmojis()).toHaveLength(0);
        await click('导入');
        await pick('.zip,application/zip', [downloaded!]);
        expect(await DB.getEmojis()).toEqual(before);
        await click('角色分配');
        const roleGroup = document.querySelector<HTMLInputElement>('.st-check input')!;
        expect(roleGroup.checked).toBe(false);
        await act(async () => {
            roleGroup.click();
        });
        await wait(() => expect(roleGroup.checked).toBe(true));
        expect((await DB.getEmojiCategories())[0].allowedCharacterIds).toEqual(['test']);
        await click('选择角色角色私密名称');
        expect(document.querySelectorAll('.st-picker-list button')).toHaveLength(30);
        await click('按分组筛选 · 全部角色');
        await click('最后一个分组');
        await click('角色私密名称最后一个分组');
        expect(roleGroup.checked).toBe(false);
        expect(document.body.textContent).toContain('另一个模型');
        expect(vision).not.toHaveBeenCalled();
        await click('表情库');
        await click('选择');
        await click('全选当前结果');
        await click('看图起名');
        expect(vision).not.toHaveBeenCalled();
        // jsdom's FileReader cannot read Node Blobs in fake IndexedDB. Use the browser's equivalent data URL.
        vi.stubGlobal(
            'FileReader',
            class {
                result = '';
                onload?: () => void;
                async readAsDataURL(blob: Blob) {
                    this.result =
                        'data:' +
                        blob.type +
                        ';base64,' +
                        Buffer.from(await blob.arrayBuffer()).toString('base64');
                    this.onload?.();
                }
            }
        );
        await click('一键起名');
        await wait(() =>
            expect(document.querySelector<HTMLInputElement>('[aria-label="一个私密名字的新名称"]')?.value).toBe(
                '新建议名'
            )
        );
        expect(vision).toHaveBeenCalledTimes(1);
        const imagesSent = (index: number) =>
            JSON.parse(String(vision.mock.calls[index][1]?.body)).messages[0].content.filter(
                (part: { type: string }) => part.type === 'image_url'
            ).length;
        expect(imagesSent(0)).toBe(2);
        await click('重试剩余 1 张');
        await wait(() =>
            expect(
                document.querySelector<HTMLInputElement>('[aria-label="一个私密名字 2的新名称"]')?.value
            ).toBe('新建议名 2')
        );
        expect(vision).toHaveBeenCalledTimes(2);
        expect(imagesSent(1)).toBe(1);
        expect(JSON.stringify(vision.mock.calls)).toContain('https://model.test/v1/chat/completions');
        expect(JSON.stringify(vision.mock.calls)).toContain('data:image/png;base64,');
        await click('保存选定名称');
        await wait(() => expect(document.querySelector('[aria-label="新建议名"]')).toBeTruthy());
        expect(track.mock.calls).toContainEqual(['表情看图起名', { 结果: '完成' }]);
        expect(track.mock.calls).toContainEqual(['批量导入表情', { 方式: '本地选图', 结果: '完成' }]);
        expect(track.mock.calls).toContainEqual(['批量导入表情', { 方式: 'ZIP', 结果: '完成' }]);
        expect(track.mock.calls).toContainEqual(['批量删除表情']);
        expect(track.mock.calls.filter(([event]) => event === '打开表情管理')).toHaveLength(1);
        await click('导入');
        await click('粘贴链接');
        await act(async () => { expect(handleLocalBack()).toBe(true); });
        expect(button('粘贴链接')).toBeDefined();
        await click('粘贴链接');
        const dest = document.querySelector<HTMLSelectElement>('.st-work select')!;
        await act(async () => {
            dest.value = folder.id;
            dest.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const paste = async (text: string) => {
            const field = document.querySelector('textarea')!;
            await act(async () => {
                Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text);
                field.dispatchEvent(new Event('input', { bubbles: true }));
            });
        };
        await paste('坏格式\n新建议名--https://private.example/a--b.png');
        await click('导入链接');
        await wait(() => expect(document.querySelector('textarea')?.value).toBe('坏格式'));
        expect(document.body.textContent).toContain('1 行格式有误');
        const restored = (await DB.getEmojis()).find(row => row.name === '新建议名');
        expect(restored).toMatchObject({ url: 'https://private.example/a--b.png', categoryId: folder.id });
        await paste('修好--https://private.example/ok.gif');
        await click('导入链接');
        await wait(() => expect(document.querySelector('.st-library .st-top h1')?.textContent).toBe('表情管理'));
        expect(document.querySelector('.st-picker-trigger strong')?.textContent).toBe('我的文件夹');
        expect(button('修好')).toBeDefined();
        expect(track.mock.calls).toContainEqual(['批量导入表情', { 方式: '粘贴链接', 结果: '部分完成' }]);
        expect(track.mock.calls).toContainEqual(['批量导入表情', { 方式: '粘贴链接', 结果: '完成' }]);
        expect(JSON.stringify(track.mock.calls)).not.toContain('private.example');
        expect(JSON.stringify(track.mock.calls)).not.toContain('私密');
    } finally {
        act(() => root.unmount());
        host.remove();
    }
});
