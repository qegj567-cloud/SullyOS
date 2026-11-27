import { beforeEach, expect, it } from 'vitest';
import { DB } from './db';
import { editCharacterEmotion } from './emotionEditing';
import { ContextBuilder } from './context';
import type { CharacterBuff, CharacterProfile } from '../types';

const original: CharacterBuff = { id: 'emotion-one', name: 'old', label: '难过', description: '旧说明', intensity: 2, homeBehavior: { energy: -.5, approach: -.2, interaction: -.3 }, homeBehaviorAt: 1 };
const other: CharacterBuff = { id: 'emotion-two', name: 'calm', label: '平静', intensity: 1 };
const char = { id: 'edit-emotion-role', name: '测试角色', activeBuffs: [original, other], buffInjection: '旧叙事：难过与旧说明', scheduleFeatureEnabled: true, emotionConfig: { enabled: true } } as CharacterProfile;
beforeEach(async () => { localStorage.clear(); await DB.saveCharacter(char); });

it('edits display and actual next-request input together, dropping stale behavior only for the edited emotion', async () => {
    await editCharacterEmotion(char.id, original, { label: '开心', description: '想去散步', intensity: 3 });
    const current = (await DB.getCharacter(char.id))!;
    expect(current.activeBuffs?.[0]).toMatchObject({ id: original.id, label: '开心', description: '想去散步', intensity: 3 });
    expect(current.activeBuffs?.[0]).not.toHaveProperty('homeBehavior');
    expect(current.activeBuffs?.[1]).toEqual(other);
    const context = ContextBuilder.buildEmotionContext(current, { surface: 'chat' });
    expect(context).toContain('开心'); expect(context).toContain('想去散步'); expect(context).toContain('平静');
    expect(context).not.toContain('旧叙事'); expect(context).not.toContain('难过');
});

it('deletes one emotion, clears the last emotion input, and preserves independent heart text', async () => {
    localStorage.setItem(`sully_last_innerstate_${char.id}`, '心声仍保留');
    await editCharacterEmotion(char.id, original, null);
    let current = (await DB.getCharacter(char.id))!;
    expect(current.activeBuffs).toEqual([other]); expect(current.buffInjection).not.toContain('难过');
    await editCharacterEmotion(char.id, other, null);
    current = (await DB.getCharacter(char.id))!;
    expect(current.activeBuffs).toEqual([]); expect(current.buffInjection).toBe('');
    expect(ContextBuilder.buildEmotionContext(current, { surface: 'chat' })).toContain('心声仍保留');
    expect(ContextBuilder.buildEmotionContext(current, { surface: 'chat' })).not.toContain('当前情绪');
});

it('reads current state in the write transaction, preserving unrelated changes and disabled switches', async () => {
    const third = { id: 'three', name: 'expectant', label: '期待', intensity: 1 } as CharacterBuff;
    await DB.saveCharacter({ ...char, scheduleFeatureEnabled: false, emotionConfig: { enabled: false }, description: '刚编辑的人设', activeBuffs: [original, other, third] });
    await editCharacterEmotion(char.id, original, null);
    const current = (await DB.getCharacter(char.id))!;
    expect(current.activeBuffs).toEqual([other, third]);
    expect(current.scheduleFeatureEnabled).toBe(false); expect(current.emotionConfig?.enabled).toBe(false);
    expect(current.description).toBe('刚编辑的人设');
});

it('rejects an outdated editor after evaluation or deletion without overwriting the new state', async () => {
    await DB.saveCharacterEmotion(char.id, [{ ...original, label: '新评估' }], '新评估的情绪');
    await expect(editCharacterEmotion(char.id, original, null)).rejects.toThrow('已更新或删除');
    expect((await DB.getCharacter(char.id))?.buffInjection).toBe('新评估的情绪');
    await DB.saveCharacterEmotion(char.id, [], '');
    await expect(editCharacterEmotion(char.id, original, { label: '旧草稿', intensity: 1 })).rejects.toThrow('已更新或删除');
    expect((await DB.getCharacter(char.id))?.activeBuffs).toEqual([]);
});
