// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { CharacterProfile } from '../types';
import { useChatAI } from '../hooks/useChatAI';
import { DB } from './db';
import { setReliableMemoryPalaceHighWaterMark } from './memoryPalace/highWaterMark';
import { buildChatRequestPayload } from './chatRequestPayload';

vi.mock('../context/MusicContext', () => ({ useMusic: () => ({}), loadMusicHooks: () => null }));
vi.mock('./keepAlive', () => ({ KeepAlive: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('./chatRequestPayload', () => ({ buildChatRequestPayload: vi.fn(async () => { throw new Error('不应构建已归档原文'); }) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let current: ReturnType<typeof useChatAI>;
function Probe({ char }: { char: CharacterProfile }) {
    current = useChatAI({
        worldbookScene: 'chat.private',
        char, userProfile: { name: '用户' } as any,
        apiConfig: { baseUrl: 'https://example.test/v1' }, groups: [], emojis: [], categories: [],
        realtimeConfig: {} as any, addToast: vi.fn(), setMessages: vi.fn(), updateCharacter: vi.fn(), updateUserProfile: vi.fn(),
    });
    return null;
}
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('ChatApp 已归档空范围的发送保护', () => {
    it.each([false, true])('保留主动归档边界，不把旧用户输入捞回（随后有通话回复=%s）', async (callReply) => {
        const char = { id: `archived-chat-${callReply}`, name: '角色', contextRangeMode: 'adaptive',
            contextRangePolicyVersion: 1, contextFollowsMemoryPalaceHwm: true } as CharacterProfile;
        await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: '旧回复' });
        let lastId = await DB.saveMessage({ charId: char.id, role: 'user', type: 'text', content: '已归档输入' });
        if (callReply) lastId = await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'text', content: '通话中已回应', metadata: { source: 'call' } });
        await setReliableMemoryPalaceHighWaterMark(char.id, lastId);
        const history = await DB.getMessagesByCharId(char.id, true);
        const mirror = await DB.getAssetRaw(`mp_hwm_v1_${char.id}`);
        const profileBefore = JSON.stringify(char);
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不应发送请求'));
        const root = createRoot(document.createElement('div'));
        try {
            await act(async () => { root.render(createElement(Probe, { char })); });
            await act(async () => { await current.triggerAI(history); });
            expect(buildChatRequestPayload).not.toHaveBeenCalled();
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(current.isTyping).toBe(false);
            expect(localStorage.getItem(`mp_lastMsgId_${char.id}`)).toBe(String(lastId));
            expect(await DB.getAssetRaw(`mp_hwm_v1_${char.id}`)).toEqual(mirror);
            expect(JSON.stringify(char)).toBe(profileBefore);
            const after = await DB.getMessagesByCharId(char.id, true);
            expect(after.filter(m => m.role !== 'system')).toEqual(history);
            expect(after.at(-1)?.content).toContain('请再发一条消息');
        } finally { act(() => root.unmount()); }
    });
});
