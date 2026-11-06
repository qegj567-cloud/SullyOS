// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import Chat from '../apps/Chat';
import { AppID } from '../types';
import { DB } from './db';

const state = vi.hoisted(() => ({ characters: [] as any[], close: vi.fn(), open: vi.fn() }));
vi.mock('../context/OSContext', () => { const context = {
    activeApp: 'chat', activeCharacterId: 'missing',
    theme: {}, userProfile: { name: '测试用户', avatar: '', bio: '' },
    apiConfig: {}, apiPresets: [], availableModels: [], customThemes: [], groups: [], characterGroups: [],
    unreadMessages: {}, realtimeConfig: {}, memoryPalaceConfig: {}, remoteVectorConfig: {},
    closeApp: state.close, openApp: state.open, clearUnread: vi.fn(), setActiveCharacterId: vi.fn(),
    addToast: vi.fn(), updateCharacter: vi.fn(), updateUserProfile: vi.fn(),
}; return { useOS: () => ({ ...context, characters: state.characters }) }; });
vi.mock('../hooks/useChatAI', () => ({ useChatAI: () => ({
    isTyping: false, streamingBubbles: [], streamingThinking: '', streamingHandoverIds: [], triggerAI: vi.fn(),
    setLastTokenUsage: vi.fn(), setLastDigestResult: vi.fn(), setMemoryPalaceResult: vi.fn(),
}) }));
// Keep this UI regression independent of a real IndexedDB favorite read finishing after jsdom teardown.
vi.mock('./contentFavorites', async importOriginal => ({
    ...await importOriginal<typeof import('./contentFavorites')>(),
    listContentFavorites: vi.fn().mockResolvedValue([]),
}));
vi.mock('../hooks/useStreamingVoice', () => ({ useStreamingVoice: () => ({ state: null, stop: vi.fn() }) }));
vi.mock('../components/chat/MemoryContextSelfCheck', () => ({ default: () => null }));
vi.mock('../components/chat/ChatHeaderShell', () => ({ default: () => React.createElement('header', null, '聊天标题') }));
vi.mock('../components/chat/ChatInputArea', () => ({ default: () => React.createElement('footer', null, '聊天输入') }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { state.characters = []; vi.restoreAllMocks(); vi.clearAllMocks(); });

it('renders an empty space and remains stable when characters appear and disappear', async () => {
    vi.spyOn(DB, 'initializeEmojiData').mockResolvedValue(undefined);
    vi.spyOn(DB, 'getEmojis').mockResolvedValue([]);
    vi.spyOn(DB, 'getEmojiCategories').mockResolvedValue([]);
    const host = document.createElement('div'), root = createRoot(host);
    try {
        await act(async () => root.render(React.createElement(Chat)));
        expect(host.textContent).toContain('暂时没有可用的角色');
        const entry = Array.from(host.querySelectorAll('button')).find(b => b.textContent === '前往神经链接');
        expect(entry).toBeDefined();
        await act(async () => entry!.click());
        expect(state.open).toHaveBeenCalledWith(AppID.Character);

        state.characters = [{ id: 'new', name: '新角色', avatar: '', memories: [], description: '', systemPrompt: '' }];
        await act(async () => root.render(React.createElement(Chat)));
        expect(host.querySelector('.sully-chat-root')).not.toBeNull();

        state.characters = [];
        await act(async () => root.render(React.createElement(Chat)));
        expect(host.textContent).toContain('暂时没有可用的角色');
        await act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === '返回桌面')!.click());
        expect(state.close).toHaveBeenCalledOnce();
    } finally { await act(async () => root.unmount()); }
});
