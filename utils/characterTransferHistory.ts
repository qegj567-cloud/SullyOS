import type { CharacterProfile } from '../types';
import { readSpaceStore } from './userSpaceData';
import { createLocalId } from './localId';

/** Copy only the selected private conversation and memory graph; shared group history stays put. */
export async function prepareInheritedHistory(source: IDBDatabase, target: IDBDatabase, originals: CharacterProfile[], copies: CharacterProfile[], options: { chat?: boolean; memory?: boolean }) {
    const ids = new Map<any, any>(originals.map((c, i) => [c.id, copies[i].id]));
    const tables: Record<string, any[]> = {};
    if (options.chat) {
        tables.messages = (await readSpaceStore(source, 'messages')).filter(m => ids.has(m.charId) && !m.groupId);
        // Allocate above existing keys; final insert-only commit aborts on concurrent collisions.
        const last = await new Promise<number>((resolve, reject) => {
            const req = target.transaction('messages').objectStore('messages').openKeyCursor(null, 'prev');
            req.onsuccess = () => resolve(Number(req.result?.primaryKey || 0)); req.onerror = () => reject(req.error);
        });
        tables.messages.forEach((m, i) => ids.set(m.id, last + i + 1));
    }
    if (options.memory) {
        for (const table of ['memory_nodes', 'memory_vectors', 'memory_batches', 'topic_boxes', 'anticipations', 'event_boxes', 'room_plates', 'digest_reports']) {
            tables[table] = (await readSpaceStore(source, table)).filter(row => ids.has(row.charId));
            for (const row of tables[table]) if (row.id && !ids.has(row.id)) ids.set(row.id, createLocalId());
        }
        const nodes = new Set(tables.memory_nodes.map(n => n.id));
        tables.memory_vectors = (await readSpaceStore(source, 'memory_vectors')).filter(v => nodes.has(v.memoryId));
        tables.memory_links = (await readSpaceStore(source, 'memory_links')).filter(l => nodes.has(l.sourceId) && nodes.has(l.targetId));
        for (const link of tables.memory_links) ids.set(link.id, createLocalId());
    }
    const walk = (value: any, key = ''): any => {
        if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
        if (Array.isArray(value)) return value.map(v => walk(v, key));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
        return /Ids?$/.test(key) || ['id', 'sender', 'speaker'].includes(key) ? ids.get(value) ?? value : value;
    };
    for (let i = 0; i < copies.length; i++) {
        const copy = copies[i] as any, original = originals[i] as any;
        if (options.memory) for (const key of ['memories', 'refinedMemories', 'activeMemoryMonths', 'impression', 'selfInsights', 'guidebookInsights']) copy[key] = walk(structuredClone(original[key]));
        copy.activeMsg2Config = { ...copy.activeMsg2Config, enabled: false, instantChatEnabled: false, tasks: [] };
        if (copy.awayMessage) copy.awayMessage.enabled = false;
        if (copy.dateLeaveReminder) copy.dateLeaveReminder.enabled = false;
    }
    return Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.map(row => walk(row))]));
}
