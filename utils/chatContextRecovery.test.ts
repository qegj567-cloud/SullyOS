import { describe, expect, it } from 'vitest';
import type { CharacterProfile, Message } from '../types';
import { recoverPendingChatTurn } from './chatContextRecovery';
import { selectCharacterContextMessages } from './chatContextRange';
import { ChatPrompts } from './chatPrompts';
import { assertChatHasDialogue } from './chatRequestGuard';
import { DB } from './db';
import { loadCharacterContextRange } from './chatContextRange';
import { getReliableMemoryPalaceHighWaterMark, setReliableMemoryPalaceHighWaterMark } from './memoryPalace/highWaterMark';

const char = { id: 'recovery', name: '角色', autoArchiveEnabled: true,
    contextRangeMode: 'adaptive', contextRangePolicyVersion: 1 } as CharacterProfile;
const message = (id: number, role: Message['role'], extra: Partial<Message> = {}): Message => ({
    id, role, charId: char.id, timestamp: id, type: 'text', content: `text-${id}`, ...extra,
});

describe('automatic recovery of an archived pending chat turn', () => {
    it('normally keeps a newly persisted user message without needing recovery', async () => {
        const profile = { ...char, id: 'recovery-normal-new-message' };
        const oldId = await DB.saveMessage({ charId: profile.id, role: 'assistant', type: 'text', content: '旧回复' });
        await setReliableMemoryPalaceHighWaterMark(profile.id, oldId);
        const newId = await DB.saveMessage({ charId: profile.id, role: 'user', type: 'text', content: '新消息' });
        const range = await loadCharacterContextRange(profile);
        expect(newId).toBeGreaterThan(oldId);
        expect(range.messages.map(m => m.id)).toEqual([newId]);
        expect(recoverPendingChatTurn(range.messages, [], profile).recovered).toBe(false);
    });

    it('keeps the new message visible when background code rereads an invalidated mirror', async () => {
        // 人工构造损坏镜像；回归锁住修复，不代表用户现场已经满足这个条件。
        const profile = { ...char, id: 'recovery-stale-mirror' };
        await setReliableMemoryPalaceHighWaterMark(profile.id, 99999);
        const newId = await DB.saveMessage({ charId: profile.id, role: 'user', type: 'text', content: '已落库的新消息' });
        expect((await loadCharacterContextRange(profile)).messages.map(m => m.id)).toContain(newId);
        await getReliableMemoryPalaceHighWaterMark(profile.id);
        expect((await loadCharacterContextRange(profile)).messages.map(m => m.id)).toContain(newId);
    });

    it('restores only unanswered input through both downstream filters without changing saved settings or waterline', () => {
        localStorage.setItem('mp_lastMsgId_recovery', '99999');
        try {
            const original = JSON.stringify(char);
            const history = [message(1, 'user'), message(2, 'assistant'), message(3, 'user'), message(4, 'user'), message(5, 'system')];
            const selected = selectCharacterContextMessages(history, char);
            expect(selected).toEqual([]);
            const result = recoverPendingChatTurn(selected, history, char);
            expect(result.recovered).toBe(true);
            expect(result.messages.map(m => m.id)).toEqual([3, 4]);
            const filtered = selectCharacterContextMessages(result.messages, result.character);
            const { apiMessages } = ChatPrompts.buildMessageHistory(filtered, filtered.length, result.character, { name: '用户' } as any, []);
            expect(apiMessages.map(m => m.role)).toEqual(['user', 'user']);
            expect(() => assertChatHasDialogue(apiMessages)).not.toThrow();
            expect(JSON.stringify(char)).toBe(original);
            expect(localStorage.getItem('mp_lastMsgId_recovery')).toBe('99999');
        } finally { localStorage.removeItem('mp_lastMsgId_recovery'); }
    });

    it('leaves normal and manually selected history untouched', () => {
        const selected = [message(1, 'user')];
        expect(recoverPendingChatTurn(selected, [], char).messages).toBe(selected);
        expect(recoverPendingChatTurn([], selected, { ...char, contextRangeMode: 'manual' }).recovered).toBe(false);
    });

    it('does not resurrect answered turns or system errors', () => {
        expect(recoverPendingChatTurn([], [message(1, 'user'), message(2, 'assistant'), message(3, 'system')], char).recovered).toBe(false);
    });

    it('respects explicit breakpoints and excludes other characters, groups and non-chat sources', () => {
        const history = [message(1, 'user'), message(2, 'user'),
            message(3, 'user', { charId: 'someone-else' }),
            message(4, 'user', { groupId: 'group' }),
            message(5, 'user', { metadata: { source: 'date' } }),
            message(6, 'user', { metadata: { proactiveHint: true } }),
            message(7, 'user', { content: ' ' })];
        const result = recoverPendingChatTurn([], history, { ...char, contextUserStartMessageId: 2 });
        expect(result.messages.map(m => m.id)).toEqual([2]);
        expect(recoverPendingChatTurn([], history, { ...char, contextUserStartMessageId: 10 }).recovered).toBe(false);
    });
});
