import { describe, expect, it, vi } from 'vitest';
import { applyDateExperiencePreset, DATE_EXPERIENCE_PRESETS, savedDatePresetExperience, snapshotDateExperience, withDateExperience } from './dateExperience';
import { DatePrompts, DATE_STYLE_PRESETS } from './datePrompts';
import { stripSensitiveCardFields } from './characterCard';
import type { CharacterProfile, UserProfile } from '../types';

const char = { id: 'date-exp', name: '角色', avatar: '', description: '', systemPrompt: '自己的世界观与信念。', memories: [],
    dateStyleConfig: { style: 'lyrical', pov: 'first-you', extra: '原补充', sceneSeed: '原场景' },
    dateVoiceEnabled: true, dateVoiceLang: 'ja', dateObserve: { enabled: true },
    memoryPalaceInjection: '不应复用的召回', roomPlatesInjection: '不应复用的门牌',
} as CharacterProfile;
const user = { name: '用户', bio: '自选身份' } as UserProfile;

describe('date experience boundaries', () => {
    it('从 master 编辑补充后返回，保留新体验字段并使用旧版更新过的正文', () => {
        const preset = { id: 'shared', name: '预设', content: '旧正文', experience: { style: 'syrup', tone: 'push_pull' as const, sceneSeed: '书房', extra: '旧正文' } };
        // master 的更新路径保留 ...preset，只改 name/content。
        const updatedByMaster = { ...preset, name: '改过名称', content: '在 master 修改的正文' };
        expect(savedDatePresetExperience(updatedByMaster)).toMatchObject({ style: 'syrup', tone: 'push_pull', sceneSeed: '书房', extra: '在 master 修改的正文' });
        expect(savedDatePresetExperience({ ...updatedByMaster, content: '' })?.extra).toBe('');
        expect(savedDatePresetExperience({ id: 'legacy', name: '旧预设', content: '只有补充' })).toBeUndefined();
        expect(preset.experience.extra).toBe('旧正文');
    });
    it('complete presets replace only experience fields; legacy presets only replace the supplement', () => {
        const original = structuredClone(char);
        const experience = applyDateExperiencePreset(snapshotDateExperience(char.dateStyleConfig), DATE_EXPERIENCE_PRESETS[0]);
        const request = withDateExperience(char, experience);
        expect(request.dateStyleConfig).toMatchObject({ style: 'plain', pov: 'first-you', tone: 'daily_warm', sceneSeed: '', digDeeper: false });
        expect(request.dateObserve).toEqual(char.dateObserve);
        expect(request.dateVoiceLang).toBe('ja');
        expect(request.memoryPalaceInjection).toBeUndefined();
        expect(request.roomPlatesInjection).toBeUndefined();
        expect(char).toEqual(original);
        expect(applyDateExperiencePreset(experience, { id: 'old', name: '旧', content: '旧补充' }))
            .toEqual({ ...experience, extra: '旧补充' });
        expect(withDateExperience(char, { ...experience, extra: '', sceneSeed: '' }).dateStyleConfig?.extra).toBe('');
    });

    it('private experience contents cannot leave through a character card', () => {
        const result = stripSensitiveCardFields({ ...char, dateActionChoicesEnabled: true, dateExtraPresets: DATE_EXPERIENCE_PRESETS });
        expect(result).not.toHaveProperty('dateActionChoicesEnabled');
        expect(result).not.toHaveProperty('dateStyleConfig');
        expect(result).not.toHaveProperty('dateExtraPresets');
        expect(result.systemPrompt).toBe(char.systemPrompt);
    });

    it('行动建议覆盖开场、发送和重生成；未选建议不进入历史正文', async () => {
        const source = { ...char, dateActionChoicesEnabled: true };
        expect(withDateExperience(source, DATE_EXPERIENCE_PRESETS[0].experience).dateActionChoicesEnabled).toBe(true);
        const peek = await DatePrompts.buildPeekPayload({ char: source, userProfile: user, allMsgs: [], emojis: [] });
        expect(JSON.stringify(peek.messages)).toContain('⟦ACTIONS⟧');
        for (const variant of ['send', 'reroll'] as const) {
            const history = [{ id: 1, charId: source.id, role: 'assistant', type: 'text', timestamp: 1, content: '[normal] "茶好了。"', metadata: { source: 'date', dateActionChoices: [{ kind: 'daily', text: 'UNSELECTED_PRIVATE_OPTION' }] } }] as any;
            const result = await DatePrompts.buildSessionPayload({ char: source, userProfile: user, allMsgs: history, emojis: [], userText: '好的', variant });
            expect(JSON.stringify(result.messages)).toContain('⟦ACTIONS⟧');
            expect(JSON.stringify(result.messages)).not.toContain('UNSELECTED_PRIVATE_OPTION');
            expect(JSON.stringify(result.messages)).toContain('每一行都必须以');
        }
        const off = await DatePrompts.buildPeekPayload({ char, userProfile: user, allMsgs: [], emojis: [] });
        expect(JSON.stringify(off.messages)).not.toContain('⟦ACTIONS⟧');
    });

    it.each(['approach', 'invite'] as const)('%s uses prose observation/translation and the full opening style without mutating the profile', async openingMode => {
        const original = structuredClone(char);
        for (const preset of DATE_STYLE_PRESETS) {
            const source = withDateExperience(char, { ...snapshotDateExperience(char.dateStyleConfig), style: preset.id, tone: 'push_pull', sceneSeed: '用户选定的新场景' });
            const { messages } = await DatePrompts.buildPeekPayload({ char: source, userProfile: user, allMsgs: [], emojis: [], openingMode });
            const prompt = messages.map(m => m.content).join('\n');
            expect(prompt).toContain(preset.peekRule);
            expect(prompt).not.toContain(preset.block);
            for (const other of DATE_STYLE_PRESETS.filter(p => p.id !== preset.id)) expect(prompt).not.toContain(other.peekRule);
            expect(prompt).toContain('用户选定的新场景');
            expect(prompt).toContain('不使用立绘标签');
            expect(prompt).not.toContain('再写 VN 正文');
            expect(prompt).not.toContain('[happy] "原文台词');
            expect(prompt).not.toContain('没说出口的，你尽管读');
            expect(prompt).not.toContain('不应复用的召回');
            expect(prompt).toContain('也不代表用户已经认同某种解释');
            expect(prompt).toContain('不强行改写其世界观');
            expect(prompt).toContain('这份基础约定不是角色必须复述的台词');
            expect(prompt).toContain('自选身份');
        }
        expect(char).toEqual(original);
    });

    it.each(['send', 'reroll'] as const)('%s combines the same tone, scene and style with VN tags and preserves the user input', async variant => {
        const userText = '不用替我解释，我只想安静坐会儿。';
        const source = withDateExperience(char, { style: 'plain', tone: 'push_pull', sceneSeed: '房间里有张长凳', digDeeper: false, extra: '本场私人补充' });
        const { messages } = await DatePrompts.buildSessionPayload({ char: source, userProfile: user, allMsgs: [], emojis: [], userText, variant });
        const prompt = messages.map(m => m.content).join('\n');
        expect(prompt).toContain(DATE_STYLE_PRESETS[1].block);
        expect(prompt).toContain('房间里有张长凳');
        expect(prompt).toContain('本场私人补充');
        expect(prompt).toContain('不要求对方证明自己“认真拒绝”');
        expect(prompt).toContain('已有且愿意的亲近也可以自然延续');
        expect(prompt).toContain(userText);
        expect(prompt).toContain('每一行都必须以');
        expect(prompt).not.toContain('表达底线 (Anti-Filler)');
        expect(prompt).not.toContain('深挖，别填充');
        expect(prompt.split('### 陪伴空间的基础约定')).toHaveLength(2);
    });
});
