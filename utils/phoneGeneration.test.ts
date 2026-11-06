import { afterEach, expect, it, vi } from 'vitest';
import { DB, openDB } from './db';
import { mergePhoneGeneration } from './phoneGeneration';
import { upsertContact } from './relationshipChat';
import type { CharacterProfile, PhoneEvidence } from '../types';

let serial = 0;
const record = (id: string): PhoneEvidence => ({ id, type: 'delivery', title: '咖啡', detail: '冰美式', timestamp: 100 });
async function create(sendToChat = true) {
    const char = { id: `phone-generation-${++serial}`, name: '测试角色', phoneState: { records: [record('old')], sendToChat } } as CharacterProfile;
    await DB.saveCharacter(char);
    return char;
}
const read = async (id: string) => (await DB.getAllCharacters()).find(char => char.id === id)!;
afterEach(() => vi.restoreAllMocks());

it('commits records and linked chat cards to the originating character, surviving UI teardown/reload', async () => {
    const a = await create(), b = await create();
    await DB.savePhoneGeneration(b.id, { records: [record('new-1'), record('new-2')] }, '外卖');
    const reloaded = await read(b.id), messages = await DB.getMessagesByCharId(b.id, true);
    expect(reloaded.phoneState!.records.map(row => row.id)).toEqual(['old', 'new-1', 'new-2']);
    expect(messages).toHaveLength(2);
    expect(reloaded.phoneState!.records.slice(1).map(row => row.systemMessageId)).toEqual(messages.map(row => row.id));
    expect(messages[0]).toMatchObject({ charId: b.id, type: 'phone_card', metadata: { phoneCard: { app: '外卖', title: '咖啡' } } });
    expect((await read(a.id)).phoneState!.records).toEqual(a.phoneState!.records);
    expect(await DB.getMessagesByCharId(a.id, true)).toHaveLength(0);
});

it('merges overlapping batches and makes retries idempotent', async () => {
    const char = await create();
    await Promise.all(['one', 'two'].map(id => DB.savePhoneGeneration(char.id, { records: [record(id)] }, '外卖')));
    await DB.savePhoneGeneration(char.id, { records: [record('one')] }, '外卖');
    expect((await read(char.id)).phoneState!.records.map(row => row.id).sort()).toEqual(['old', 'one', 'two']);
    expect(await DB.getMessagesByCharId(char.id, true)).toHaveLength(2);
});

it('uses the latest send-to-chat setting and preserves unrelated phone state', async () => {
    const char = await create(false);
    char.phoneState = { ...char.phoneState!, simLogs: [{ id: 'kept' }] as any };
    await DB.saveCharacter(char);
    await DB.savePhoneGeneration(char.id, { records: [record('new')] }, '外卖');
    expect((await read(char.id)).phoneState).toMatchObject({ sendToChat: false, simLogs: [{ id: 'kept' }] });
    expect(await DB.getMessagesByCharId(char.id, true)).toHaveLength(0);
});

it('rolls back both outputs if the transaction fails after inserting a chat card', async () => {
    const char = await create(), original = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<typeof original>) {
        const request = original.apply(this, args);
        if (this.name === 'messages') request.addEventListener('success', () => this.transaction.abort());
        return request;
    });
    await expect(DB.savePhoneGeneration(char.id, { records: [record('new')] }, '外卖')).rejects.toBeTruthy();
    expect((await read(char.id)).phoneState!.records).toEqual(char.phoneState!.records);
    expect(await DB.getMessagesByCharId(char.id, true)).toHaveLength(0);
});

it('does not resurrect a deleted character or leave orphan chat cards', async () => {
    const char = await create(), db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('characters', 'readwrite'); tx.objectStore('characters').delete(char.id);
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    await expect(DB.savePhoneGeneration(char.id, { records: [record('new')] }, '外卖')).rejects.toThrow('不存在');
    expect(await read(char.id)).toBeUndefined();
    expect(await DB.getMessagesByCharId(char.id, true)).toHaveLength(0);
});

it('preserves concurrent contact edits, topic boxes and unrelated contacts', () => {
    const baseContacts = upsertContact([], { name: '朋友', kind: 'npc', note: '旧备注' });
    const contacts = baseContacts.map(contact => ({ ...contact, affinity: 5, note: '生成备注' }));
    const liveContacts = upsertContact(baseContacts.map(contact => ({ ...contact, note: '手写的新备注', affinity: 20,
        topicBox: [{ id: 'topic', text: '历史', createdAt: 1, span: 100 }] })), { name: '新朋友', kind: 'npc' });
    const result = mergePhoneGeneration({ records: [], contacts: liveContacts }, { records: [record('new')], contacts, baseContacts });
    expect(result.contacts).toEqual(liveContacts);
    expect(result.records).toHaveLength(1);
});
