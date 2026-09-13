import type { Message } from '../../types';
import { openDB } from '../db';

export const isSARDeletedReply = (message: Message) => message.role === 'assistant' && message.metadata?.sarDeleted === true;
export const findSARPendingReply = (messages: Message[]) => messages.find(isSARDeletedReply);

export function resolveSARReplyRetry(messages: Message[], replyId: number) {
    const reply = messages.find(message => message.id === replyId && message.role === 'assistant');
    if (!reply) throw new Error('这条回复已经不存在，请重新打开故事');
    const turn = Number(reply.metadata?.sarTurn);
    const user = messages.find(message => message.role === 'user' && Number(message.metadata?.sarTurn) === turn && message.id < reply.id);
    if (!user || !Number.isInteger(turn) || turn < 1 || turn > 50) throw new Error('没有找到这一幕对应的用户输入');
    return { reply, user, turn, history: messages.filter(message => message.id < user.id && !isSARDeletedReply(message)) };
}

/** Preserve the reply slot so delete → generate retries this input, including after reload.
 * Compare and replace in one transaction; invalidate continuity facts derived from the old reply.
 */
export async function replaceSARSimulationReply(runId: string, expected: Message, replacement: {
    content: string; worldNarration?: string; deleted?: boolean; directorState?: unknown;
}) {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        let failure: Error | undefined;
        const request = store.index('charId').getAll(IDBKeyRange.only('sar-simulation:' + runId));
        request.onsuccess = () => {
            const messages = (request.result as Message[]).filter(message => message.metadata?.source === 'sar_simulation' && message.metadata?.sarRunId === runId);
            const current = messages.find(message => message.id === expected.id);
            if (!current || current.role !== 'assistant' || current.content !== expected.content || JSON.stringify(current.metadata) !== JSON.stringify(expected.metadata)) {
                failure = new Error('这条回复已变化，请刷新后再试'); tx.abort(); return;
            }
            if (replacement.deleted) {
                try { resolveSARReplyRetry(messages, current.id); }
                catch (cause) { failure = cause as Error; tx.abort(); return; }
            }
            for (const message of messages) {
                if (message.id < current.id || message.role !== 'assistant') continue;
                const metadata = { ...message.metadata };
                delete metadata.sarDirectorState;
                if (message.id === current.id) {
                    delete metadata.sarGM;
                    metadata.sarWorldNarration = replacement.worldNarration || '';
                    metadata.sarDeleted = replacement.deleted === true;
                    if (replacement.directorState && !replacement.deleted) metadata.sarDirectorState = replacement.directorState;
                    store.put({ ...message, content: replacement.deleted ? '' : replacement.content, metadata });
                } else store.put({ ...message, metadata });
            }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(failure || tx.error || new Error('回复保存失败'));
        tx.onabort = () => reject(failure || tx.error || new Error('回复保存失败'));
    });
}
