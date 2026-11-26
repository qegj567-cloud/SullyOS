import { describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, UserProfile } from '../types';
import { readableContextMemories } from './contextMemories';
import { ContextBuilder } from './context';
import { buildCharacterStats, countContextCharacters, estimateContextTokens } from './characterStats';
import { computeContextRangeSnapshot } from './chatContextRange';

const user = { name: '测试用户', bio: '', avatar: '' } as UserProfile;
const character = (extra: Partial<CharacterProfile> = {}) => ({ id: 'stats', name: '角色', avatar: '', systemPrompt: '设定', contextRangePolicyVersion: 1, contextRangeMode: 'manual', memories: [], ...extra } as CharacterProfile);

describe('read-only character statistics', () => {
    it('keeps monthly summaries with eyes closed; palace does not override open eyes', async () => {
        const char = character({ memoryPalaceEnabled: true, refinedMemories: { '2026-08': '月度' }, memories: [{ date: '2026年9月1日', summary: '日度', mood: '好' }] as CharacterProfile['memories'] });
        expect(readableContextMemories(char).monthly).toHaveLength(1);
        expect(readableContextMemories(char).daily).toHaveLength(0);
        char.activeMemoryMonths = ['2026-09'];
        expect(readableContextMemories(char).daily[0].entries).toHaveLength(1);
        expect((await ContextBuilder.buildCharacterContext({ scene: 'chat.private', char, user })).coreContext).toContain('日度');
        expect(readableContextMemories(char, false).daily).toHaveLength(0);
    });
    it('previews keywords and probability without consuming randomness', () => {
        const char = character({ mountedWorldbooks: [
            { id: 'a', title: '常驻', content: '{{char}}', constant: true },
            { id: 'b', title: '关键词', content: '命中', constant: false, key: ['海边'] },
            { id: 'c', title: '概率', content: '抽签', constant: true, useProbability: true, probability: 30 },
            { id: 'd', title: '停用', content: '关闭', disable: true },
        ] });
        const random = vi.spyOn(Math, 'random');
        try {
            expect(ContextBuilder.inspectWorldbooks(char, user, [], 'chat.private').map(b => b.status)).toEqual(['readable', 'waiting', 'probability', 'disabled']);
            const matched = ContextBuilder.inspectWorldbooks(char, user, [{ content: '海边' }], 'chat.private');
            expect(matched[1].status).toBe('readable');
            expect(matched[0].content).toBe('角色');
            expect(random).not.toHaveBeenCalled();
        } finally { random.mockRestore(); }
    });
    it('counts only the readable range and separates call/date/chat sources', () => {
        const char = character({ memoryPalaceEnabled: false, memoryPalaceInjection: 'stale', roomPlatesInjection: 'stale', contextRangeMode: 'adaptive', contextFollowsMemoryPalaceHwm: true });
        const messages = ['chat', 'call', 'date', 'custom'].map((source, index) => ({ id: index + 1, charId: char.id, role: 'user', type: 'text', content: '你好', timestamp: 1, metadata: { source } })) as any;
        const range = computeContextRangeSnapshot(messages, char, 1);
        const stats = buildCharacterStats(char, user, range);
        expect(stats.sources.map(s => s.name)).toEqual(expect.arrayContaining(['通话 · CallApp', '见面 · DateApp', '其他 · custom']));
        expect(stats.sources.reduce((n, s) => n + s.count, 0)).toBe(3);
        expect(stats.otherRows.some(r => r.content.includes('stale'))).toBe(false);
        expect(stats.total).toBe(stats.historyCharacters + stats.memoryCharacters + stats.worldbookCharacters + stats.otherCharacters);
    });
    it('counts Unicode characters, labels the heuristic separately, and handles empty ranges', () => {
        expect(countContextCharacters('中😀')).toBe(2);
        expect(estimateContextTokens('')).toBe(0);
        expect(estimateContextTokens('中文abcd')).toBe(3);
        const char = character();
        expect(buildCharacterStats(char, user, computeContextRangeSnapshot([], char, 0)).sources).toEqual([]);
    });
});
