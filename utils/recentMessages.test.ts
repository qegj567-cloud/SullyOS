import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB, openDB } from './db';
import type { Message } from '../types';

const CHAR = 'recent-archived';
const message = (id: number, extra: Partial<Message> = {}): Message => ({
    id, charId: CHAR, role: 'assistant', type: 'text', content: `message ${id}`, timestamp: id, ...extra,
});
async function seed(messages: Message[]) {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        store.clear();
        for (const msg of messages) store.put(msg);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
    });
    // Complete one-time story timeline maintenance before measuring the recent-message cursor.
    await DB.getRecentMessagesByCharId(CHAR, 0, true);
}
function countAdvances() {
    let advances = 0;
    const original = IDBCursor.prototype.continue;
    vi.spyOn(IDBCursor.prototype, 'continue').mockImplementation(function (this: IDBCursor, key?: IDBValidKey) {
        if (this.source instanceof IDBIndex && this.source.name === 'charId' && this.key === CHAR) advances++;
        return original.call(this, key);
    });
    return () => advances;
}
beforeEach(() => localStorage.removeItem(`mp_lastMsgId_${CHAR}`));
afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem(`mp_lastMsgId_${CHAR}`); });

describe('recent messages after a large archive', () => {
    it('reads the unarchived tail without traversing ten thousand archived messages on every bubble refresh', async () => {
        await seed([
            ...Array.from({ length: 10_000 }, (_, i) => message(i + 1)),
            message(10_001, { role: 'user' }),
            message(10_002, { groupId: 'group' }),
            message(10_003, { charId: 'another-character' }),
            message(10_004),
        ]);
        localStorage.setItem(`mp_lastMsgId_${CHAR}`, '10000');
        const advances = countAdvances();
        for (let bubble = 0; bubble < 3; bubble++) {
            expect((await DB.getRecentMessagesByCharId(CHAR, 200)).map(m => m.id)).toEqual([10_001, 10_004]);
        }
        expect(advances()).toBeLessThanOrEqual(9);
        expect(await DB.countMessagesByCharId(CHAR)).toBe(10_003);
    }, 30_000);
    it('returns empty immediately when the entire character history is archived', async () => {
        await seed(Array.from({ length: 100 }, (_, i) => message(i + 1)));
        localStorage.setItem(`mp_lastMsgId_${CHAR}`, '100');
        const advances = countAdvances();
        expect(await DB.getRecentMessagesByCharId(CHAR, 200)).toEqual([]);
        expect(advances()).toBe(0);
    });
    it('still reads archived private messages when explicitly requested, skipping group and other-character rows', async () => {
        await seed([message(1), message(2, { charId: 'other' }), message(3, { groupId: 'group' }), message(4)]);
        localStorage.setItem(`mp_lastMsgId_${CHAR}`, '4');
        expect((await DB.getRecentMessagesByCharId(CHAR, 2, true)).map(m => m.id)).toEqual([1, 4]);
    });
    it('preserves the latest private-message limit and ascending ID order without an archive boundary', async () => {
        await seed([message(1), message(2), message(3, { groupId: 'group' }), message(4), message(5)]);
        expect((await DB.getRecentMessagesByCharId(CHAR, 2)).map(m => m.id)).toEqual([4, 5]);
        expect(await DB.getRecentMessagesByCharId(CHAR, 0)).toEqual([]);
    });
});
