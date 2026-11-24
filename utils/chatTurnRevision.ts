import { calibratedDeliveryKey } from './chatDeliveryReceipts';
import type { Message } from '../types';
import { openDB } from './db';
import { isVisibleChatMessage } from './chatMessageVisibility';
import { announceSecretNotesChanged, deleteLinkedSecretNotes } from './secretNote';
import { getLocalMemoryPalaceHighWaterMark } from './memoryPalace/highWaterMark';

export type RevisionMode = 'format' | 'reroll';
export type DraftBubble = Pick<Message, 'type' | 'content' | 'metadata' | 'replyTo'>;
export interface TurnPreview {
    originals: Message[];
    bubbles: DraftBubble[];
    mode: RevisionMode;
    recalledIds?: string[];
}
const editable = (m: Message) => isVisibleChatMessage(m) && m.role === 'assistant'
    && ['text', 'emoji', 'html_card'].includes(m.type);
function turnKey(m: Message): string {
    const cloud = m.metadata?.activeMsg2;
    if (cloud) return String(cloud.messageId || cloud.taskUuid).replace(/_hook_\d+$/, '');
    return m.metadata?.chatTurnId || m.metadata?.source || 'legacy';
}

/** Read the complete editable tail by primary key, independently of the UI's paged window. */
function readTail(store: IDBObjectStore, charId: string, done: (rows: Message[]) => void) {
    const rows: Message[] = [];
    let key: string | undefined;
    const request = store.index('charId').openCursor(IDBKeyRange.only(charId), 'prev');
    request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { done(rows.reverse()); return; }
        const row: Message = cursor.value;
        if (row.groupId || row.type === 'secret_note') { cursor.continue(); return; }
        const sameTurnCard = !!(row.metadata?.chatTurnId || row.metadata?.activeMsg2)
            && isVisibleChatMessage(row) && row.role !== 'user';
        if ((!editable(row) && !sameTurnCard) || (key !== undefined && key !== turnKey(row))) {
            done(rows.reverse()); return;
        }
        key = turnKey(row);
        if (editable(row)) rows.push(row);
        cursor.continue();
    };
}

function checkWaterline(assets: IDBObjectStore, charId: string, first: number, done: (archived: boolean) => void) {
    const read = assets.get(`mp_hwm_v1_${charId}`);
    read.onsuccess = () => {
        const mirror = read.result?.data;
        done(first <= Math.max(getLocalMemoryPalaceHighWaterMark(charId), Number(mirror?.msgId ?? mirror) || 0));
    };
}

export async function loadRevisionTurn(charId: string): Promise<Message[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['messages', 'assets']);
        readTail(tx.objectStore('messages'), charId, rows => {
            if (!rows.length) { reject(new Error('当前对话末尾没有可校准的角色回复。')); return; }
            checkWaterline(tx.objectStore('assets'), charId, rows[0].id, archived => {
                if (archived) reject(new Error('这轮回复已归档。可以在记忆修补里核对已整理的内容。'));
                else resolve(rows);
            });
        });
        tx.onabort = () => reject(tx.error);
    });
}

export async function acceptRevision(preview: TurnPreview): Promise<number[]> {
    const { originals, bubbles } = preview;
    if (!originals.length || (!bubbles.length && preview.mode !== 'format')) throw new Error('没有可采用的回复。');
    const charId = originals[0].charId;
    const db = await openDB();
    const { lockMemoryForTurnRevision } = await import('./memoryPalace/pipeline');
    const release = lockMemoryForTurnRevision(charId);
    if (!release) throw new Error('这位角色正在整理记忆，请在整理完成后重试。');
    try {
        return await commitTurn(db, preview);
    } finally { release(); }
}

function commitTurn(db: IDBDatabase, preview: TurnPreview): Promise<number[]> {
    const { originals, bubbles } = preview;
    const charId = originals[0].charId;
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['messages', 'assets', 'characters'], 'readwrite');
        const store = tx.objectStore('messages'), assets = tx.objectStore('assets');
        let failure: Error;
        const changed: number[] = [];
        const abort = (reason: string) => { failure = new Error(reason); tx.abort(); };
        readTail(store, charId, current => {
            if (JSON.stringify(current) !== JSON.stringify(originals)) {
                abort('本轮消息已经变化，请重新预览。'); return;
            }
            checkWaterline(assets, charId, current[0].id, archived => {
                if (archived) { abort('本轮已在预览期间归档，请重新核对。'); return; }
                const receipts = new Set(current.map(row => row.metadata?.activeMsg2?.messageId)
                    .filter((id): id is string => typeof id === 'string' && !!id));
                const last = current[current.length - 1];
                const profile = tx.objectStore('characters').get(charId);
                profile.onsuccess = () => {
                    const cutoff = profile.result?.contextUserStartMessageId;
                    if ((profile.result?.hideBeforeMessageId ?? 0) > current[0].id) {
                        abort('本轮已归档，请在记忆修补中核对。');
                        return;
                    }
                    if (current.some((row, i) => row.id === cutoff && (preview.mode === 'reroll' || i > 0 || !bubbles.length))) {
                        abort('本轮包含上下文断点，请先在聊天设置里调整断点。');
                    }
                };
                for (const id of receipts) assets.put({ id: calibratedDeliveryKey(charId, id), data: true });
                for (const [index, row] of current.entries()) {
                    const bubble = bubbles[index];
                    if (!bubble || row.content !== bubble.content || row.type !== bubble.type || preview.mode === 'reroll') {
                        changed.push(row.id);
                        assets.delete(`voice_msg_${row.id}`);
                        deleteLinkedSecretNotes(store, row);
                    }
                    // Pending work (e.g. a secret note) addresses the old reply by message ID.
                    if (!bubble || preview.mode === 'reroll') store.delete(row.id);
                }
                for (const [index, bubble] of bubbles.entries()) {
                    const slot = current[index];
                    const meta = { ...bubble.metadata };
                    if (!slot || changed.includes(slot.id)) delete meta.secretNoteIds;
                    if (last.metadata?.chatTurnId) meta.chatTurnId = last.metadata.chatTurnId;
                    if (last.metadata?.source) meta.source = last.metadata.source;
                    if (last.metadata?.activeMsg2) meta.activeMsg2 = slot?.metadata?.activeMsg2 ?? last.metadata.activeMsg2;
                    const value = { charId, role: 'assistant', type: bubble.type, content: bubble.content,
                        timestamp: slot?.timestamp ?? last.timestamp, metadata: meta, replyTo: bubble.replyTo };
                    if (slot && preview.mode === 'format') store.put({ ...value, id: slot.id });
                    else store.add(value);
                }
            });
        });
        tx.oncomplete = () => { announceSecretNotesChanged(charId); resolve(changed); };
        tx.onabort = () => reject(failure || tx.error || new Error('回复未保存，请重试。'));
    });
}
