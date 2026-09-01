import { describe, expect, it } from 'vitest';
import {
    DEFAULT_SAR_CLUB_STATE,
    SAR_CAIAN_INTRO_DIALOGUE,
    getSARDialogueNode,
    patchSARClubState,
    readSARClubState,
    rewindSARIntro,
    type SARClubState,
} from './vrWorld/sarClub';

const memoryStorage = () => {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
    };
};

describe('SAR 活动室状态', () => {
    it('没有存档时保持未选择，选择 NPC 后仍与见面状态分离', () => {
        const storage = memoryStorage();
        expect(readSARClubState(storage)).toEqual(DEFAULT_SAR_CLUB_STATE);

        let state = patchSARClubState({ npcPreference: 'show', updateSeenVersion: 1 }, storage);
        expect(state.npcPreference).toBe('show');
        expect(state.caianMet).toBe(false);

        state = patchSARClubState({ caianMet: true, introReaction: 'character-card' }, storage);
        expect(readSARClubState(storage)).toMatchObject<SARClubState>({
            version: 1,
            updateSeenVersion: 1,
            npcPreference: 'show',
            caianMet: true,
            introReaction: 'character-card',
        });

        state = patchSARClubState({ npcPreference: 'hide' }, storage);
        expect(state.caianMet).toBe(true);
    });

    it('角色卡说明会根据前置分支选择正确的第一句', () => {
        const mentioned = getSARDialogueNode('about-character-card', { mentionedCharacterCard: true });
        const notMentioned = getSARDialogueNode('about-character-card', { mentionedCharacterCard: false });
        expect(mentioned.lines[0].text).toBe('对！你刚才提到的。');
        expect(notMentioned.lines[0].text).toBe('对！我在这里听说过。');
        expect(mentioned.lines).toHaveLength(notMentioned.lines.length);
    });

    it('剧情回档只重置凯恩初见，不重播公告也不改 NPC 偏好', () => {
        const storage = memoryStorage();
        patchSARClubState({
            npcPreference: 'show',
            updateSeenVersion: 1,
            caianMet: true,
            introReaction: 'silent',
        }, storage);

        expect(rewindSARIntro(storage)).toEqual({
            version: 1,
            updateSeenVersion: 1,
            npcPreference: 'show',
            caianMet: false,
            introReaction: undefined,
        });
    });

    it('每条可选分支和自动跳转都指向存在的节点，并且都能抵达结束', () => {
        for (const node of Object.values(SAR_CAIAN_INTRO_DIALOGUE)) {
            if (node.next) expect(SAR_CAIAN_INTRO_DIALOGUE[node.next]).toBeTruthy();
            for (const choice of node.choices || []) expect(SAR_CAIAN_INTRO_DIALOGUE[choice.next]).toBeTruthy();
        }

        const canReachEnd = (start: string, seen = new Set<string>()): boolean => {
            if (start === 'end') return true;
            if (seen.has(start)) return false;
            const node = SAR_CAIAN_INTRO_DIALOGUE[start];
            const nextSeen = new Set(seen).add(start);
            const targets = [node.next, ...(node.choices || []).map(choice => choice.next)].filter(Boolean) as string[];
            return targets.length > 0 && targets.some(target => canReachEnd(target, nextSeen));
        };

        expect(canReachEnd('start')).toBe(true);
    });
});
