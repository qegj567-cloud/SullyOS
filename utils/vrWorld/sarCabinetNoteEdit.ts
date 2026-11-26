import type { APIConfig, CharacterProfile, Message, SARCharacterCabinetNoteMeta, UserProfile } from '../../types';
import { ContextBuilder } from '../context';
import { openDB } from '../db';
import { injectMemoryPalace } from '../memoryPalace/pipeline';
import { extractContent, safeFetchJson } from '../safeApi';
import { resolveDialogueApi } from '../characterApi';
import { normalizeLlmBaseUrl } from '../llmEndpoint';
import { getVRApi } from './vrApi';

export async function rewriteCabinetNote(actor: CharacterProfile, user: UserProfile, globalApi: APIConfig, note: SARCharacterCabinetNoteMeta, signal: AbortSignal) {
    const vr = await getVRApi();
    const api = resolveDialogueApi(globalApi, actor, vr?.baseUrl ? vr : undefined);
    if (!api.baseUrl || !api.model) throw new Error('请先配置彼方或角色的对话 API。');
    const char = { ...actor };
    await injectMemoryPalace(char, [], note.story, user.name);
    const messages = await ContextBuilder.buildCharacterRequest({ scene: 'apps.vrChipNote', char, user, instructions: '重写这次芯片体验的私人随笔。用角色本人的第一人称写 250–600 字，只输出随笔正文。保持本次对象、芯片及已经发生的剧情。' },
        [{ role: 'user', content: JSON.stringify({ 对象: note.targetName, 芯片: [note.variantTitle, note.storyTitle], 剧情: note.story, 高光: note.highlight, 上一稿: note.notes }) }]);
    const data = await safeFetchJson(normalizeLlmBaseUrl(api.baseUrl, api.apiType) + '/chat/completions', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (api.apiKey || 'sk-none') },
        body: JSON.stringify({ model: api.model, messages, temperature: api.temperature ?? 0.9, stream: false }),
    }, 0, 0, { appId: 'vrworld', appName: '彼方', charId: actor.id, charName: actor.name, purpose: '重写芯片随笔' });
    const text = extractContent(data);
    if (!text) throw new Error('模型没有返回随笔正文，请重试。');
    return text;
}

/** The VR card is the cabinet's source. Commit the visible text and metadata together. */
export async function saveCabinetNoteRevision(messageId: number, before: SARCharacterCabinetNoteMeta, text: string) {
    const db = await openDB();
    return new Promise<void>((resolve, reject) => {
        const tx = db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        const req = store.get(messageId);
        req.onsuccess = () => {
            const message = req.result as Message | undefined;
            const note = message?.metadata?.sarCabinetNote;
            const tail = note && `随笔：${note.notes}\n高光：${note.highlight}`;
            if (!message || !note || !tail || message.charId !== before.actorId || note.id !== before.id
                || note.notes !== before.notes || !message.content.endsWith(tail)) { tx.abort(); return; }
            store.put({ ...message, content: message.content.slice(0, -tail.length) + `随笔：${text}\n高光：${note.highlight}`,
                metadata: { ...message.metadata, sarCabinetNote: { ...note, notes: text } } });
        };
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('原活动卡已删除或变更，请返回柜子重新打开。'));
    });
}
