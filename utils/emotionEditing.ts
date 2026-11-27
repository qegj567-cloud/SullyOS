import type { CharacterBuff, CharacterProfile } from '../types';
import { openDB } from './db';

export type EmotionDraft = Pick<CharacterBuff, 'label' | 'description' | 'intensity'>;

/** Rebuild the model input too: an old narrative must not reintroduce a removed emotion. */
export function editedEmotionInjection(buffs: CharacterBuff[]): string {
    if (!buffs.length) return '';
    return '### 当前情绪\n' + buffs.map(buff => `- ${buff.label || buff.name}（强度 ${buff.intensity}/3）${buff.description?.trim() ? '：' + buff.description.trim() : ''}`).join('\n')
        + '\n让这些情绪自然影响回应，不必直接复述情绪标签。';
}

export async function editCharacterEmotion(charId: string, original: CharacterBuff, draft: EmotionDraft | null): Promise<{ buffs: CharacterBuff[]; buffInjection: string }> {
    if (draft && (!draft.label.trim() || ![1, 2, 3].includes(draft.intensity))) throw new Error('请填写情绪名称，并选择 1–3 的强度。');
    const db = await openDB();
    const result = await new Promise<{ buffs: CharacterBuff[]; buffInjection: string }>((resolve, reject) => {
        const tx = db.transaction('characters', 'readwrite');
        const store = tx.objectStore('characters');
        const get = store.get(charId);
        let updated: { buffs: CharacterBuff[]; buffInjection: string };
        let failure: Error | undefined;
        get.onsuccess = () => {
            const character = get.result as CharacterProfile | undefined;
            const current = character?.activeBuffs?.find(buff => buff.id === original.id);
            if (!character || !current || JSON.stringify(current) !== JSON.stringify(original)) {
                failure = new Error('这条情绪已更新或删除，请重新长按后操作。'); tx.abort(); return;
            }
            const buffs = (character.activeBuffs || []).flatMap(buff => {
                if (buff.id !== original.id) return [buff];
                if (!draft) return [];
                // A manually changed feeling invalidates its previous model-generated home behavior.
                const { homeBehavior: _behavior, homeBehaviorAt: _at, ...kept } = buff;
                return [{ ...kept, label: draft.label.trim(), description: draft.description?.trim() || '', intensity: draft.intensity }];
            });
            updated = { buffs, buffInjection: editedEmotionInjection(buffs) };
            store.put({ ...character, activeBuffs: buffs, buffInjection: updated.buffInjection });
        };
        tx.oncomplete = () => resolve(updated!);
        tx.onerror = () => reject(tx.error || new Error('情绪保存失败，请重试。'));
        tx.onabort = () => reject(failure || tx.error || new Error('情绪保存失败，请重试。'));
    });
    // Existing OSContext listener refreshes the current role and dirties the cloud snapshot.
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('emotion-updated', { detail: { charId, ...result } }));
    return result;
}
