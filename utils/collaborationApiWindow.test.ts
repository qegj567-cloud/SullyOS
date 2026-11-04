// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CollaborationWindow from '../features/collaboration/CollaborationWindow';
import { CollaborationStore } from '../features/collaboration/store';
import { DEFAULT_COLLABORATION_SETTINGS } from '../features/collaboration/types';
import { collaborationProfileFromApi } from '../features/collaboration/api';
import { safeFetchJson } from './safeApi';

vi.mock('../features/collaboration/CollaborationBeautyLibrary', () => ({ default: () => null }));
vi.mock('../components/chat/CssCodeEditor', () => ({ default: () => null }));
vi.mock('../components/share/BeautyPresetPreview', () => ({ default: () => null }));
vi.mock('../features/collaboration/chatBridge', () => ({
    loadCollaborationChatHistory: async (character: any) => ({ character, messages: [] }),
    selectCollaborationTransfer: vi.fn(),
}));
vi.mock('../features/collaboration/context', () => ({
    buildCollaborationModelMessages: (context: string, messages: any[]) => [{ role: 'system', content: context }, ...messages],
    buildCollaborationContextSnapshot: async () => '角色背景',
    buildCollaborationTurnMemoryContext: async () => '',
    buildLiveCollaborationChatContext: async () => ({ contextSnapshot: '角色背景', chatContextSnapshot: [] }),
}));
vi.mock('./safeApi', () => ({
    safeFetchJson: vi.fn(),
    safeResponseJson: (response: Response) => response.json(),
    extractContent: (data: any) => data?.choices?.[0]?.message?.content || '',
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const claude = { baseUrl: 'https://old.example/v1', apiKey: 'old-key', model: 'claude-model', stream: false, temperature: 0.8 };
let root: Root;
let host: HTMLDivElement;
let props: any;
beforeEach(async () => {
    vi.mocked(safeFetchJson).mockReset();
    vi.mocked(safeFetchJson).mockResolvedValue({ choices: [{ message: { content: '已完成。' } }] });
    HTMLElement.prototype.scrollTo = vi.fn();
    const character = { id: crypto.randomUUID(), name: '测试角色', avatar: '', emojiIds: [] };
    props = {
        open: true, character, user: { name: '测试用户', avatar: '' }, theme: { user: {}, ai: {} },
        chatApi: claude, apiPresets: [], availableModels: ['claude-model', 'gemini-model'],
        characters: [character], groups: [], emojis: [], emojiCategories: [], recentChatMessages: [],
        chatCollaborationEnabled: false, onClose: vi.fn(), onSendToChat: vi.fn(), onInstallArtifact: vi.fn(),
        onArchiveToMemory: vi.fn(), onToggleChatCollaboration: vi.fn(), notify: vi.fn(),
    };
    await CollaborationStore.saveSettings({
        ...DEFAULT_COLLABORATION_SETTINGS,
        immersive: collaborationProfileFromApi(claude, 'chat', '当前 ChatApp'),
        focused: collaborationProfileFromApi(claude, 'chat', '当前 ChatApp'),
    });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
async function render() {
    await act(async () => { root.render(createElement(CollaborationWindow, props)); });
    await act(async () => { await settle(); });
}
async function click(selector: string) {
    const element = host.querySelector<HTMLButtonElement>(selector);
    expect(element, selector).not.toBeNull();
    await act(async () => { element!.click(); await settle(); });
}
async function button(text: string) {
    const element = [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === text);
    expect(element, text).toBeDefined();
    await act(async () => { element!.click(); await settle(); });
}
async function chooseFocused() {
    await render();
    await vi.waitFor(() => expect(host.querySelector('.collab-mode-option-title')).not.toBeNull());
    await act(async () => {
        [...host.querySelectorAll('button')].find(item => item.textContent?.startsWith('中度协同'))!.click();
        await settle();
    });
    await vi.waitFor(() => expect(host.querySelector('textarea')).not.toBeNull());
}
async function send() {
    const input = host.querySelector('textarea')!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '继续整理文件');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('[aria-label="发送"]');
    await vi.waitFor(() => expect(safeFetchJson).toHaveBeenCalled());
    return JSON.parse(vi.mocked(safeFetchJson).mock.calls.at(-1)![1]!.body as string);
}

it('中度窗口打开对应模式，修改模型后保存、发送及重新打开都保持 Gemini', async () => {
    await chooseFocused();
    await click('[aria-label="协同设置"]');
    const model = host.querySelector<HTMLSelectElement>('[aria-label="中度协同模型"]');
    expect(model).not.toBeNull();
    await act(async () => {
        model!.value = 'gemini-model'; model!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await button('保存');
    const saved = await CollaborationStore.loadSettings();
    expect(saved.focused).toMatchObject({ model: 'gemini-model', source: 'custom' });
    expect(saved.immersive.model).toBe('claude-model');
    props = { ...props, chatApi: { ...claude, model: 'global-other-model' } };
    await render();
    expect((await send()).model).toBe('gemini-model');
    await click('[aria-label="协同设置"]');
    expect(host.querySelector<HTMLSelectElement>('[aria-label="中度协同模型"]')?.value).toBe('gemini-model');
});

it.each(['chat', 'preset'] as const)('保持窗口挂载时更新 %s 连接，下一轮发送新地址、Key 和模型', async source => {
    if (source === 'preset') {
        await CollaborationStore.saveSettings({ ...DEFAULT_COLLABORATION_SETTINGS,
            focused: collaborationProfileFromApi(claude, 'preset', '工作连接', 'preset-1') });
        props.apiPresets = [{ id: 'preset-1', name: '工作连接', config: claude }];
    }
    await chooseFocused();
    const next = { ...claude, baseUrl: 'https://new.example/v1', apiKey: 'new-key', model: 'gemini-model' };
    props = source === 'chat' ? { ...props, chatApi: next }
        : { ...props, apiPresets: [{ id: 'preset-1', name: '工作连接', config: next }] };
    await render();
    expect((await send()).model).toBe('gemini-model');
    const [url, init] = vi.mocked(safeFetchJson).mock.calls.at(-1)!;
    expect(url).toBe('https://new.example/v1/chat/completions');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer new-key' });
});
