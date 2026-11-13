// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {describe, it, expect, vi} from 'vitest';
import {DB} from './db';
import {saveLibraryDecoration, writeDecorationOrigin} from './decorationLibrary';
import {replaceWorkshopCss} from './decorationWorkshop';
import {renderChatDecorationSample} from '../components/chat/ChatDecorationSample';

vi.mock('../hooks/useLocalBackHandler', () => ({useLocalBackHandler: () => {}}));
vi.mock('../components/share/BeautyPresetPreview', () => ({default: () => null}));
vi.mock('../components/chat/ChatLayoutSettings', () => ({default: () => null}));
vi.mock('../components/chat/AvatarFrameImageEditor', () => ({default: () => null}));
vi.mock('../components/chat/CssCodeEditor', () => ({default: () => null}));
vi.mock('../components/chat/DecorationPresetThumb', () => ({
    DecorationMiniPreview: () => null,
    default: ({entry, onChoose}: any) => React.createElement('button', {'data-choose': entry.name, onClick: onChoose}, entry.name),
}));

import BeautyShareChannel from '../components/appearance/BeautyShareChannel';
import DecorationDraftEditor from '../components/chat/DecorationDraftEditor';
import {OSPreviewProvider} from '../context/OSContext';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function waitForUi(ready: () => boolean) {
    for (let attempt = 0; attempt < 50 && !ready(); attempt++) {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    }
    expect(ready()).toBe(true);
}

const makeFramePreset = (name: string, url: string) => ({
    format: 'sullyos-chat-decoration' as const,
    version: 1 as const,
    name,
    parts: {css: replaceWorkshopCss('', 'avatar', `.sully-chat-avatar-wrap::after { content: ""; background: url("${url}"); }`)},
});

describe('dual avatar frame wardrobe & outfit workflow', () => {
    it('lets outfit composer pick separate user and role frames and preserves per-side remix locks on sequential apply', async () => {
        const frameRole = makeFramePreset('伤到我了', 'https://example.com/hurt.png');
        const frameUser = makeFramePreset('我的头像框', 'https://example.com/mine.png');
        const idRole = await saveLibraryDecoration(frameRole, {kind: 'imported', credit: '作者甲', allowRemix: false, allowRedistribute: false});
        const idUser = await saveLibraryDecoration(frameUser, {kind: 'self'});
        await writeDecorationOrigin(idRole, {kind: 'imported', credit: '作者甲', allowRemix: false, allowRedistribute: false});
        await writeDecorationOrigin(idUser, {kind: 'self'});

        let currentChar: any = {id: 'sully', name: 'Sully', avatar: '', chromeCustomCss: ''};
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        vi.stubGlobal('IntersectionObserver', class {
            cb: any;
            constructor(cb: any) { this.cb = cb; }
            observe() { this.cb([{isIntersecting: true}]); }
            disconnect() {}
        });

        const makeOs = () => ({
            theme: {},
            characters: [currentChar],
            activeCharacterId: 'sully',
            customThemes: [],
            customIcons: {},
            appearancePresets: [],
            registerBackHandler: () => () => {},
            closeApp: () => {},
            exportAppearancePreset: async () => new Blob(),
            importAppearancePreset: async () => '',
            updateTheme: async () => {},
            updateCharacter: async (_id: string, patch: any) => { currentChar = {...currentChar, ...patch}; },
            addCustomTheme: async () => {},
        } as any);

        HTMLDialogElement.prototype.showModal ??= function () { this.setAttribute('open', ''); };
        HTMLDialogElement.prototype.close ??= function () { this.removeAttribute('open'); };
        const changeSelect = (el: HTMLSelectElement, val: string) => {
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, val);
            el.dispatchEvent(new Event('change', {bubbles: true}));
        };

        try {
            // 1. Outfit composer: pick separate frames for role and user via the target toggle
            const onApply = vi.fn();
            const editableRole = makeFramePreset('角色框', 'https://example.com/role-edit.png');
            const editableUser = makeFramePreset('用户框', 'https://example.com/user-edit.png');
            const sources = [
                {id: 'src-role', name: '角色框', kind: 'chat-decoration' as const, categories: ['chat', 'avatar'] as any, contents: '头像框', attributionKey: async () => 'src-role', read: async () => editableRole},
                {id: 'src-user', name: '用户框', kind: 'chat-decoration' as const, categories: ['chat', 'avatar'] as any, contents: '头像框', attributionKey: async () => 'src-user', read: async () => editableUser},
            ];
            await writeDecorationOrigin('src-role', {kind: 'self'});
            await writeDecorationOrigin('src-user', {kind: 'self'});

            await act(async () => root.render(React.createElement(DecorationDraftEditor, {
                preset: {format: 'sullyos-chat-decoration', version: 1, name: 'Sully的搭配', parts: {css: ''}},
                origin: {kind: 'self'},
                theme: {} as any,
                sources,
                onOpenWorkshop: () => {},
                onClose: () => {},
                onSaved: () => {},
                onApply,
            })));

            const openAvatarShelf = () => Array.from(document.querySelectorAll('.decoration-current-grid button')).find(b => b.textContent?.includes('头像框')) as HTMLButtonElement;
            await act(async () => openAvatarShelf().click());
            const aiToggle = Array.from(document.querySelectorAll('.decoration-avatar-target button')).find(b => b.textContent === '角色使用（TA）') as HTMLButtonElement;
            expect(aiToggle).toBeTruthy();
            await act(async () => aiToggle.click());
            await act(async () => (document.querySelector('[data-choose="角色框"]') as HTMLButtonElement).click());

            await act(async () => openAvatarShelf().click());
            const userToggle = Array.from(document.querySelectorAll('.decoration-avatar-target button')).find(b => b.textContent === '用户使用（我）') as HTMLButtonElement;
            await act(async () => userToggle.click());
            await act(async () => (document.querySelector('[data-choose="用户框"]') as HTMLButtonElement).click());

            const applyOutfitBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === '应用搭配') as HTMLButtonElement;
            await act(async () => applyOutfitBtn.click());
            expect(onApply).toHaveBeenCalledTimes(1);
            const builtCss = onApply.mock.calls[0][0].parts.css as string;
            expect(builtCss).toContain('role-edit.png');
            expect(builtCss).toContain('message-ai');
            expect(builtCss).toContain('user-edit.png');
            expect(builtCss).toContain('message-user');

            // Thumbnail renders both avatars side by side when user and role wear different frames
            const thumb = renderChatDecorationSample(onApply.mock.calls[0][0], 'conversation', 'avatar');
            expect(thumb.markup).toContain('sample-avatar-pair');
            expect(thumb.markup).toContain('sully-chat-message-ai');
            expect(thumb.markup).toContain('sully-chat-message-user');

            // 2. Sequential wardrobe apply preserves both frames AND keeps the first author's no-remix lock
            await act(async () => root.render(React.createElement(OSPreviewProvider, {value: makeOs()}, React.createElement(BeautyShareChannel, {
                presets: [],
                onExport: async () => new Blob(),
                onImport: async () => '',
                onBusyChange: () => {},
                targetCharacterId: 'sully',
                initialCategory: 'avatar',
            }))));
            await waitForUi(() => !!document.querySelector('[aria-label="预览 伤到我了"]'));

            // Apply frame 1 to role (TA)
            await act(async () => (document.querySelector('[aria-label="预览 伤到我了"]') as HTMLButtonElement).click());
            await waitForUi(() => Array.from(document.querySelectorAll('dialog button')).some(b => b.textContent === '立即应用' && !(b as HTMLButtonElement).disabled));
            await act(async () => (Array.from(document.querySelectorAll('dialog button')).find(b => b.textContent === '立即应用') as HTMLButtonElement).click());
            await waitForUi(() => !!document.querySelector('[aria-label="头像框给谁用"]'));
            await act(async () => changeSelect(document.querySelector('[aria-label="头像框给谁用"]') as HTMLSelectElement, 'ai'));
            await act(async () => (Array.from(document.querySelectorAll('[role="dialog"] button')).find(b => b.textContent === '立即应用') as HTMLButtonElement).click());
            await waitForUi(() => currentChar.chromeCustomCss.includes('hurt.png'));

            // Re-render with updated character and apply frame 2 to user (我)
            await act(async () => root.render(React.createElement(OSPreviewProvider, {value: makeOs()}, React.createElement(BeautyShareChannel, {
                presets: [],
                onExport: async () => new Blob(),
                onImport: async () => '',
                onBusyChange: () => {},
                targetCharacterId: 'sully',
                initialCategory: 'avatar',
            }))));
            await act(async () => (document.querySelector('[aria-label="预览 我的头像框"]') as HTMLButtonElement).click());
            await waitForUi(() => Array.from(document.querySelectorAll('dialog button')).some(b => b.textContent === '立即应用' && !(b as HTMLButtonElement).disabled));
            await act(async () => (Array.from(document.querySelectorAll('dialog button')).find(b => b.textContent === '立即应用') as HTMLButtonElement).click());
            await waitForUi(() => !!document.querySelector('[aria-label="头像框给谁用"]'));
            await act(async () => changeSelect(document.querySelector('[aria-label="头像框给谁用"]') as HTMLSelectElement, 'user'));
            await act(async () => (Array.from(document.querySelectorAll('[role="dialog"] button')).find(b => b.textContent === '立即应用') as HTMLButtonElement).click());
            await waitForUi(() => currentChar.chromeCustomCss.includes('mine.png'));

            expect(currentChar.chromeCustomCss).toContain('hurt.png');
            expect(currentChar.chromeCustomCss).toContain('mine.png');
            const savedSlots = JSON.parse((await DB.getAsset('decoration_slots_sully')) || '{}');
            expect(Object.keys(savedSlots)).toEqual(expect.arrayContaining(['css:avatar:ai', 'css:avatar:user']));
            expect(savedSlots['css:avatar:ai']).not.toBe(savedSlots['css:avatar:user']);

            // Re-render with both frames active: both cards show "使用中", and opening "我的搭配" still locks remix because role frame forbids remix
            await act(async () => root.render(React.createElement(OSPreviewProvider, {value: makeOs()}, React.createElement(BeautyShareChannel, {
                presets: [],
                onExport: async () => new Blob(),
                onImport: async () => '',
                onBusyChange: () => {},
                targetCharacterId: 'sully',
                initialCategory: 'avatar',
            }))));
            await waitForUi(() => document.querySelectorAll('.wardrobe-usage').length === 2);
            expect(Array.from(document.querySelectorAll('.wardrobe-usage')).map(el => el.textContent)).toEqual(['使用中', '使用中']);
            await act(async () => (document.querySelector('[aria-label="我 · 当前搭配"]') as HTMLButtonElement).click());
            await waitForUi(() => !!document.body.textContent?.includes('当前搭配包含禁止二改的作品'));

            // Close draft, restore default for avatar category, and confirm "我的搭配" is no longer deadlocked by stale applied lock
            await act(async () => (Array.from(document.querySelectorAll('.decoration-draft header button')).find(b => b.textContent?.includes('返回')) as HTMLButtonElement).click());
            await act(async () => (Array.from(document.querySelectorAll('.wardrobe-file-actions button')).find(b => b.textContent === '恢复默认') as HTMLButtonElement).click());
            await waitForUi(() => !currentChar.chromeCustomCss.includes('hurt.png'));
            await act(async () => root.render(React.createElement(OSPreviewProvider, {value: makeOs()}, React.createElement(BeautyShareChannel, {
                presets: [],
                onExport: async () => new Blob(),
                onImport: async () => '',
                onBusyChange: () => {},
                targetCharacterId: 'sully',
                initialCategory: 'avatar',
            }))));
            await act(async () => (document.querySelector('[aria-label="我 · 当前搭配"]') as HTMLButtonElement).click());
            await waitForUi(() => !!document.querySelector('.decoration-draft'));
            expect(document.body.textContent).not.toContain('当前搭配包含禁止二改的作品');

            // Mixed CSS frame on role + legacy bubble avatarDecoration on user renders dual-avatar preview
            const mixedThumb = renderChatDecorationSample({
                format: 'sullyos-chat-decoration',
                version: 1,
                name: '混搭双框',
                parts: {
                    css: replaceWorkshopCss('', 'avatar', '.sully-chat-avatar-wrap:where(.sully-chat-message-ai *)::after { content: ""; }'),
                    bubbles: {
                        id: 'mixed',
                        name: '混搭气泡',
                        type: 'custom',
                        user: {backgroundColor: '#fff', textColor: '#000', borderRadius: 20, opacity: 1, avatarDecoration: 'https://example.com/bubble-user.png'},
                        ai: {backgroundColor: '#fff', textColor: '#000', borderRadius: 20, opacity: 1},
                    },
                },
            }, 'conversation', 'avatar');
            expect(mixedThumb.markup).toContain('sample-avatar-pair');
            expect(mixedThumb.markup).toContain('https://example.com/bubble-user.png');
        } finally {
            await act(async () => root.unmount());
            host.remove();
            vi.unstubAllGlobals();
        }
    });
});
