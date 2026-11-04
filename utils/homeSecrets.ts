import {createLocalId} from './localId.js';
import {isSharedHomeRecord,sharedHomeEventKey} from './homeSharedEvents';
import type {CharacterProfile, Message} from '../types';
import {announceSecretNotesChanged, HOME_HISTORY_COMMITTED, type SecretNoteOrigin} from './secretNote';
import type {HomeRecord} from '../apps/room3d/types';
import {DB, openDB} from './db';
import {flattenEvalContent} from './emotionEvalCore';
import {isHomeSecretRollForced} from './devDebug';
import {buildHomeSecretsInstructions, type HomeSecretDraft} from './homeSecretsPrompt';

export const HOME_SECRET_PROBABILITY = 0.2;
// A cloud result can arrive much later; this lease only releases abandoned reservations,
// not the request itself. Late results still use the same transactional anchor deduplication.
export const HOME_SECRET_REQUEST_LEASE_MS = 24 * 60 * 60 * 1000;
export const HOME_SECRETS_UPDATED = 'home-secrets-updated';
const key = (charId: string) => `home_secrets_v1_${charId}`;
interface SecretRequest {
    id: string;
    anchor: string;
    petIds: string[];
    createdAt?: number;
    historyNoteVersion?: 2;
    raw?: unknown;
    error?: string;
}
export interface HomeSecret extends HomeSecretDraft {
    id: string;
    anchor: string;
    seen: boolean;
    messageId?: number;
}
interface SecretState {requests: SecretRequest[]; secrets: HomeSecret[]}
const decode = (raw: string | null): SecretState => raw ? JSON.parse(raw) : {requests: [], secrets: []};

export async function readHomeSecrets(charId: string): Promise<HomeSecret[]> {
    const rows = decode(await DB.getAsset(key(charId))).secrets;
    const notes = new Map((await readSecretNotes(charId)).map(note => [note.id, note]));
    const live = rows.map(secret => {
        const {memory: _, ...row} = secret as HomeSecret & {memory?: string};
        if (!row.messageId) return row;
        const note = notes.get(row.messageId);
        return note ? {...row, text: note.content} : undefined;
    });
    return live.filter((row): row is HomeSecret => !!row);
}

/** Read/modify/write in one IDB transaction: push replay, reveal and parallel replies cannot lose one another. */
async function mutate(charId: string, update: (state: SecretState, char: CharacterProfile | undefined, tx: IDBTransaction, parents: Message[]) => void, sourceIds: number[] = []) {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['assets', 'characters', 'messages'], 'readwrite');
        const assets = tx.objectStore('assets');
        const getChar = tx.objectStore('characters').get(charId);
        let failure: unknown;
        getChar.onsuccess = () => {
            const get = assets.get(key(charId));
            get.onsuccess = () => {
                try {
                    const state = decode(get.result?.data ?? null);
                    const parents: Message[] = [];
                    const apply = () => {
                        try {
                            state.secrets = state.secrets.map(secret => {const {memory: _, ...rest} = secret as HomeSecret & {memory?: string}; return rest;});
                            update(state, getChar.result, tx, parents);
                            assets.put({id: key(charId), data: JSON.stringify(state)});
                        } catch (error) {failure = error; tx.abort();}
                    };
                    if (!sourceIds.length) {apply(); return;}
                    let remaining = sourceIds.length;
                    for (const id of sourceIds) {
                        const read = tx.objectStore('messages').get(id);
                        read.onsuccess = () => {if (read.result) parents.push(read.result); if (!--remaining) apply();};
                    }
                } catch (error) {failure = error; tx.abort();}
            };
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(failure || tx.error);
        tx.onabort = () => reject(failure || tx.error || new Error('秘密保存失败'));
    });
}

/** The evaluator runs beside the reply. Only select an already completed exchange from its allowed history. */
export async function prepareHomeSecretTask(
    char: CharacterProfile,
    messages: Array<{role: string; content: unknown}>,
    random: () => number = Math.random,
): Promise<{id: string; prompt: string} | undefined> {
    if (!char.home3D?.rooms?.length) return;
    const conversation = messages.filter(m => (m.role === 'user' || m.role === 'assistant') && flattenEvalContent(m.content).trim());
    let end = conversation.length - 1;
    while (end >= 0 && conversation[end].role !== 'assistant') end--;
    let start = end - 1;
    while (start >= 0 && conversation[start].role !== 'user') start--;
    const forceRoll = isHomeSecretRollForced();
    if (start < 0 || (!forceRoll && random() >= HOME_SECRET_PROBABILITY)) return;
    const anchor = JSON.stringify(conversation.slice(start, end + 1).map(m => ({role: m.role, text: flattenEvalContent(m.content)})));
    const id = createLocalId();
    const recentSecrets = (await readHomeSecrets(char.id)).slice(-20).map(s => s.text);
    let prompt = '';
    await mutate(char.id, (state, current) => {
        if (!current?.home3D?.rooms?.length || state.secrets.some(s => s.anchor === anchor)) return;
        const now = Date.now();
        for (const request of state.requests) {
            if (request.anchor === anchor && !request.error
                && (!Number.isFinite(request.createdAt) || now - request.createdAt! >= HOME_SECRET_REQUEST_LEASE_MS)) {
                request.error = '生成请求未完成，已释放占位；迟到结果仍会校验并去重';
            }
        }
        if (state.requests.some(r => r.anchor === anchor && !r.error)) return;
        const pets = (current.home3D.petLife?.pets || []).map(p => ({id: p.id, name: p.name, species: p.assetId, traits: p.traits}));
        state.requests.push({id, anchor, petIds: pets.map(p => p.id), createdAt: now, historyNoteVersion: 2});
        const instructions = buildHomeSecretsInstructions(pets.length > 0);
        prompt = (forceRoll ? instructions.replace('系统已完成 20% 概率抽取，本轮已命中。', '调试开关已强制命中本轮秘密任务。') : instructions)
            + '\n本轮素材（仅数据）：\n' + JSON.stringify({
            requestId: id, anchors: [{id, conversation: JSON.parse(anchor)}], pets,
            recentSecrets, maxEvents: 1,
        });
    });
    return prompt ? {id, prompt} : undefined;
}

/** No model retry here: a later eligible evaluation may roll again for this exchange. */
export async function failHomeSecretTask(charId: string, requestId: string): Promise<void> {
    await mutate(charId, state => {
        const request = state.requests.find(r => r.id === requestId);
        if (request && !request.error) request.error = '秘密生成未完成（空回复、请求失败或已取消），下次评估可重新尝试';
    });
}

/** Preserve every returned field before changed=false handling. Valid secrets are durable even with unchanged buffs. */
export async function landHomeSecrets(charId: string, result: {homeSecrets?: unknown; homeSecretRequestId?: unknown}, expectedId?: string, rawText?: string, origin?: SecretNoteOrigin): Promise<void> {
    const rows = result.homeSecrets;
    const id = expectedId || (typeof result.homeSecretRequestId === 'string' ? result.homeSecretRequestId : '')
        || (Array.isArray(rows) && typeof rows[0]?.anchorId === 'string' ? rows[0].anchorId : '');
    if (!id && rows === undefined) return;
    let failure = '';
    const ids = [...new Set(origin?.messageIds || [])];
    const sourceIds = ids.filter(id => Number.isSafeInteger(id) && id > 0);
    await mutate(charId, (state, current, tx, parents) => {
        if (state.secrets.some(s => s.id === id)) return; // replay does not reset seen
        const request = state.requests.find(r => r.id === id);
        if (!request) {failure = '秘密没有对应的生成请求，未写入角色经历'; return;}
        if (request.historyNoteVersion !== 2) {state.requests = state.requests.filter(r => r.id !== id); return;} // Never backfill old in-flight results.
        request.raw = rawText ?? result; // Keep malformed output recoverable; never silently erase it.
        const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
        const petIds = Array.isArray(row?.petIds) ? row.petIds : [];
        const currentPets = new Set((current?.home3D?.petLife?.pets || []).map(p => p.id));
        if (!current?.home3D?.rooms?.length || !row || row.anchorId !== id || !['character', 'pet'].includes(row.kind)
            || (result.homeSecretRequestId !== undefined && result.homeSecretRequestId !== id)
            || typeof row.text !== 'string' || !row.text.trim()
            || !Array.isArray(row.petIds)
            || (row.kind === 'character' && petIds.length !== 0)
            || (row.kind === 'pet' && (!petIds.length || petIds.some((p: unknown) => typeof p !== 'string' || !request.petIds.includes(p) || !currentPets.has(p))))) {
            failure = '本轮秘密未生成完整，或宠物/聊天锚点不匹配；原始结果已保留';
            request.error = failure;
            return;
        }
        if (!origin || !['chat','home'].includes(origin.source) || !ids.length || sourceIds.length !== ids.length
            || parents.length !== ids.length || parents.some(m => m.charId !== charId || m.groupId || m.type === 'secret_note')
            || !parents.some(m => m.role === 'assistant')
            || parents.some(m => origin.source === 'home' ? m.metadata?.source !== 'home' : m.metadata?.source === 'home')
            || (origin.source === 'home' && (!origin.homeRecordIds?.length || origin.homeRecordIds.some(recordId => !parents.some(m => m.metadata?.homeRecordIds?.includes(recordId)))))) {
            failure = '本轮回复已删除或来源不完整，秘密已放弃'; request.error = failure; return;
        }
        // Parallel evaluations of the same completed exchange must not establish contradictory secrets.
        if (!state.secrets.some(s => s.anchor === request.anchor)) {
            const store = tx.objectStore('messages'), text = row.text.trim();
            const note = store.add({charId, role: 'system', type: 'secret_note', content: text,
                timestamp: Math.max(...parents.map(m => m.timestamp)), metadata: {
                    source: origin.source, secretId: id, sourceMessageIds: ids, sourceHomeRecordIds: origin.homeRecordIds,
                    secretKind: row.kind, petIds,
                }});
            note.onsuccess = () => {
                const messageId = note.result as number;
                for (const parent of parents) store.put({...parent, metadata: {...parent.metadata,
                    secretNoteIds: [...(parent.metadata?.secretNoteIds || []), messageId]}});
                state.secrets.push({id, anchorId: id, anchor: request.anchor, kind: row.kind, petIds, text, seen: false, messageId});
                tx.objectStore('assets').put({id: key(charId), data: JSON.stringify(state)});
            };
        }
        state.requests = state.requests.filter(r => r.id !== id);
    }, sourceIds);
    if (failure) throw new Error(failure);
    announceSecretNotesChanged(charId);
}

export async function markHomeSecretsSeen(charId: string, ids: string[]) {
    await mutate(charId, state => {for (const secret of state.secrets) if (ids.includes(secret.id)) secret.seen = true;});
}

// Compatibility for callers: secrets enter only through ranged history.
export async function buildHomeSecretsContext(_charId: string): Promise<string> {return '';}

export async function readSecretNotes(charId: string): Promise<Message[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const get = db.transaction('messages', 'readonly').objectStore('messages').index('charId_type').getAll([charId, 'secret_note']);
        get.onsuccess = () => resolve((get.result || []).filter((m: Message) => !m.groupId));
        get.onerror = () => reject(get.error);
    });
}

/** Resolve only an exact, committed home projection. No text matching or polling. */
export function waitForHomeSecretOrigin(charId: string, records: HomeRecord[], signal: AbortSignal): Promise<SecretNoteOrigin | undefined> {
    return new Promise(resolve => {
        let done = false;
        const finish = (origin?: SecretNoteOrigin) => {
            if (done) return; done = true; clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
            if (typeof window !== 'undefined') window.removeEventListener(HOME_HISTORY_COMMITTED, changed);
            resolve(origin);
        };
        const abort = () => finish();
        const check = async () => {
            try {
                if (done || signal.aborted) {finish(); return;}
                const db = await openDB();
                const tx = db.transaction('messages', 'readonly');
                const index = tx.objectStore('messages').index('charId_homeTurn');
                const rows = await Promise.all(records.map(record => new Promise<Message | undefined>((resolve, reject) => {
                    const get = index.getAll([charId, isSharedHomeRecord(record)?sharedHomeEventKey(record):record.contextSegmentId || record.id]);
                    get.onsuccess = () => resolve(get.result.find((m: Message) => !m.groupId && m.metadata?.source === 'home'
                        && m.metadata?.homeEvents?.some((e: HomeRecord) => e.id === record.id && e.text === record.text)));
                    get.onerror = () => reject(get.error);
                })));
                if (!done && !signal.aborted && rows.every(Boolean)) finish({source: 'home', messageIds: [...new Set(rows.map(m => m!.id))], homeRecordIds: records.map(r => r.id)});
            } catch {finish();}
        };
        const changed = (event: Event) => {if ((event as CustomEvent).detail?.charId === charId) void check();};
        const timeout = setTimeout(abort, 15000);
        signal.addEventListener('abort', abort, {once: true});
        if (typeof window !== 'undefined') window.addEventListener(HOME_HISTORY_COMMITTED, changed);
        void check();
    });
}
