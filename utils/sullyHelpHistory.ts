import { DB, openDB } from './db';
import type { HelpDeskMessage, HelpDeskScope } from './sullyHelpDesk';
import { helpMessageText } from './sullyHelpAttachments';

import { HELP_HISTORY_KEY as recordKey, HELP_HISTORY_LIMIT } from './sullyHelpBackup';
export { HELP_HISTORY_LIMIT } from './sullyHelpBackup';
export const HELP_QUESTION_LIMIT = 3500;

export type HelpRecord = HelpDeskMessage & { id: string; scope: HelpDeskScope; characterId: string; consultationId?: string; sentAt?: number };
export const CONSULTATION_IDLE_MS = 20 * 60_000;
const activeKey = 'sully-11-current-consultation';
export type HelpConsultation = { id: string; lastActive: number };
export function newConsultation(): HelpConsultation {
    return { id: Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join(''), lastActive: Date.now() };
}
export function rememberConsultation(session: HelpConsultation) {
    try { localStorage.setItem(activeKey, JSON.stringify(session)); } catch { /* Current view still works. */ }
}
export function recordConsultation(row: HelpRecord) {
    return row.consultationId || 'legacy:' + JSON.stringify([row.scope.category, row.scope.topic, row.characterId]);
}
export function currentConsultation(rows: HelpRecord[]): HelpConsultation {
    let cursor: HelpConsultation | undefined;
    try { cursor = JSON.parse(localStorage.getItem(activeKey) || 'null'); } catch { /* Use last saved message. */ }
    const last = rows.at(-1);
    if (!cursor && last?.sentAt) cursor = { id: recordConsultation(last), lastActive: last.sentAt };
    return cursor && typeof cursor.id === 'string' && Number.isFinite(cursor.lastActive) && Date.now() - cursor.lastActive < CONSULTATION_IDLE_MS ? cursor : newConsultation();
}
export function sameHelpThread(record: HelpRecord, scope: HelpDeskScope, characterId: string) {
    return record.scope.category === scope.category && record.scope.topic === scope.topic
        && (scope.category === 'community' || record.characterId === characterId);
}
function recordsOf(data: unknown): HelpRecord[] {
    if (!Array.isArray(data)) return [];
    return data.filter(row => row && typeof row.id === 'string' && typeof row.content === 'string'
        && typeof row.characterId === 'string' && ['user', 'assistant'].includes(row.role)
        && ['app', 'system', 'community'].includes(row.scope?.category) && typeof row.scope.topic === 'string');
}
export async function loadHelpHistory() {
    return recordsOf(await DB.getAssetRaw(recordKey));
}

/** Append atomically. A late reply can only complete its own consultation. */
export async function appendHelpRecord(record: HelpRecord, replyTo?: string): Promise<HelpRecord[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('assets', 'readwrite');
        const store = tx.objectStore('assets');
        const read = store.get(recordKey);
        let rows: HelpRecord[] = [];
        read.onsuccess = () => {
            rows = recordsOf(read.result?.data);
            if (rows.some(row => row.id === record.id)) return;
            if (replyTo) {
                const latest = rows.filter(row => recordConsultation(row) === recordConsultation(record) && sameHelpThread(row, record.scope, record.characterId)).pop();
                if (latest?.role !== 'user' || latest.id !== replyTo) return;
            }
            rows.push(record);
            store.put({ id: recordKey, data: rows });
        };
        tx.oncomplete = () => resolve(rows);
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('客服历史保存失败'));
    });
}

/** Only the selected conversation enters here. Leave space for up to two relevant older exchanges. */
export function selectHelpDeskContext(history: HelpDeskMessage[]): HelpDeskMessage[] {
    const rows = history.slice(-HELP_HISTORY_LIMIT);
    const last = rows.length - 1;
    if (last < 0) return [];
    let remaining = 6000;
    const lastReply = rows.map(row => row.role).lastIndexOf('assistant');
    const messages = new Map<number, HelpDeskMessage>();
    const take = (i: number, cap: number) => {
        if (i < 0 || i > last || messages.has(i) || remaining < 40) return;
        const row = rows[i];
        const limit = Math.min(remaining, cap);
        const text = helpMessageText(row, limit);
        const content = text.length <= limit ? text : text.slice(0, limit - 1) + '…';
        const image = i > lastReply && row.role === 'user' && row.attachment?.kind === 'image' && row.attachment.url ? row.attachment : undefined;
        messages.set(i, { role: row.role, content, ...(image ? { attachment: image } : {}) });
        remaining -= content.length;
    };
    for (let i = last; i >= Math.max(0, last - 6); i--) take(i, i === last ? HELP_QUESTION_LIMIT : 900);
    const question = rows[last].content.toLowerCase();
    const query = [...new Set([...(question.match(/[a-z\d]{2,}/g) ?? []),
        ...Array.from(question.matchAll(/(?=([\u3400-\u9fff]{2}))/g), m => m[1])])];
    const earlier = rows.slice(0, Math.max(0, last - 6)).map((row, i) => {
        const text = row.content.toLowerCase();
        const score = row.role === 'user' ? query.reduce((sum, term) =>
            sum + (text.includes(term) ? Math.min(term.length - 1, 3) : 0), 0) : 0;
        return { i, score };
    }).filter(hit => hit.score >= 2).sort((a, b) => b.score - a.score || b.i - a.i);
    for (const { i } of earlier.slice(0, 2)) {
        take(i, 600);
        if (rows[i + 1]?.role === 'assistant') take(i + 1, 600);
    }
    return [...messages].sort(([a], [b]) => a - b).map(([, message]) => message);
}
