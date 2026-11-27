import { openDB } from './db';
import type { Message } from '../types';

export type RecordOwner = { id: string; group?: boolean };
const belongs = (m: Message, owner: RecordOwner) => owner.group ? m.groupId === owner.id : m.charId === owner.id && !m.groupId;
export async function readChatRecordPage(owner: RecordOwner, beforeId?: number) {
    const db = await openDB();
    return new Promise<{ messages: Message[]; hasMore: boolean }>((resolve, reject) => {
        const tx = db.transaction('messages');
        const req = tx.objectStore('messages').index(owner.group ? 'groupId' : 'charId').openCursor(IDBKeyRange.only(owner.id), 'prev');
        const messages: Message[] = [];
        req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) { resolve({ messages: messages.reverse(), hasMore: false }); return; }
            const id = Number(cursor.primaryKey);
            if (beforeId !== undefined && id >= beforeId) {
                if (id > beforeId) cursor.continuePrimaryKey(owner.id, beforeId); else cursor.continue();
                return;
            }
            const message = cursor.value as Message;
            if (belongs(message, owner)) {
                if (messages.length === 50) { resolve({ messages: messages.reverse(), hasMore: true }); return; }
                // Read-only plain text: never execute historical HTML or load media previews.
                messages.push({ id, charId: message.charId, role: message.role, type: message.type, timestamp: message.timestamp,
                    content: /^(?:blobref:|data:|blob:)/.test(message.content || '') || ['image', 'emoji'].includes(message.type) ? '[图片 / 附件]' : message.content || '' });
            }
            cursor.continue();
        };
        req.onerror = () => reject(req.error);
    });
}
export async function countChatRecords(owner: RecordOwner): Promise<number> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const req = db.transaction('messages').objectStore('messages').index(owner.group ? 'groupId' : 'charId').openCursor(IDBKeyRange.only(owner.id));
        let count = 0;
        req.onsuccess = () => { const cursor = req.result; if (!cursor) { resolve(count); return; } if (belongs(cursor.value, owner)) count++; cursor.continue(); };
        req.onerror = () => reject(req.error);
    });
}
export function parseChatRecordText(text: string): Array<Pick<Message, 'role' | 'content' | 'timestamp' | 'type'>> {
    const input = text.replace(/^\uFEFF/, '').trim();
    const pattern = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] (User|AI): /gm;
    const headers = [...input.matchAll(pattern)];
    if (!headers.length || headers[0].index !== 0) throw new Error('请选择本应用导出的聊天记录 TXT 文件');
    return headers.map((h, i) => {
        const timestamp = new Date(h[1].replace(' ', 'T')).getTime();
        if (!Number.isFinite(timestamp)) throw new Error('记录中存在无效时间');
        return { role: h[2] === 'User' ? 'user' : 'assistant', type: 'text', timestamp,
            content: input.slice(h.index! + h[0].length, headers[i + 1]?.index ?? input.length).trimEnd() };
    });
}
export async function importChatRecordText(owner: RecordOwner, text: string) {
    const messages = parseChatRecordText(text);
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('messages', 'readwrite');
        for (const m of messages) tx.objectStore('messages').add({ ...m, charId: owner.id, ...(owner.group ? { groupId: owner.id } : {}) });
        tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error || new Error('导入失败'));
    });
    return messages.length;
}
