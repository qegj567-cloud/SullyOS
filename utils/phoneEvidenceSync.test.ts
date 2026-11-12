import { afterEach, expect, it, vi } from 'vitest';
import { DB } from './db';
import { applyPhoneEvidenceChatLink, PHONE_EVIDENCE_SYNCED } from './phoneEvidence';
import type { CharacterProfile, PhoneEvidence } from '../types';

let serial = 0;
async function create() {
    const record: PhoneEvidence = { id: 'record', type: 'order', title: '旧订单', detail: '原来的内容', timestamp: 100 };
    const char = { id: `phone-sync-${++serial}`, name: '测试角色', memories: [{ id: 'memory', summary: '保留原记忆' }],
        phoneState: { records: [record], sendToChat: false, contacts: [{ id: 'contact', note: '手写备注' }] } } as CharacterProfile;
    await DB.saveCharacter(char);
    return char;
}
const read = async (charId: string) => (await DB.getAllCharacters()).find(char => char.id === charId)!;
const sync = (charId: string) => DB.syncPhoneEvidenceToChat(charId, 'record', '淘宝');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('allows explicit manual sync with auto sync off and keeps only one live card', async () => {
    const char = await create();
    const first = await sync(char.id), second = await sync(char.id);
    expect(first.inserted).toBe(true);
    expect(second).toEqual({ messageId: first.messageId, inserted: false });
    const rows = await DB.getMessagesByCharId(char.id, true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ timestamp: 100, type: 'phone_card', metadata: { deliveryId: 'phone-evidence:record' } });
    const saved = await read(char.id);
    expect(saved.phoneState!.records[0].systemMessageId).toBe(first.messageId);
    expect(saved.memories).toEqual(char.memories);
    expect(saved.phoneState!.contacts).toEqual(char.phoneState!.contacts);
    expect(saved.phoneState!.sendToChat).toBe(false);
});

it('can restore a deleted card repeatedly without a lifetime sync limit', async () => {
    const char = await create();
    let previous = await sync(char.id);
    for (let i = 0; i < 3; i++) {
        await DB.deleteMessage(previous.messageId);
        expect((await read(char.id)).phoneState!.records[0].systemMessageId).toBe(previous.messageId);
        const next = await sync(char.id);
        expect(next.inserted).toBe(true);
        expect(next.messageId).not.toBe(previous.messageId);
        expect(await DB.getMessagesByCharId(char.id, true)).toHaveLength(1);
        expect((await read(char.id)).phoneState!.records[0].systemMessageId).toBe(next.messageId);
        previous = next;
    }
});

it('serializes overlapping requests from different tabs', async () => {
    const char = await create();
    const results = await Promise.all(Array.from({ length: 6 }, () => sync(char.id)));
    expect(results.filter(result => result.inserted)).toHaveLength(1);
    expect(new Set(results.map(result => result.messageId)).size).toBe(1);
    expect(await DB.getMessagesByCharId(char.id, true)).toHaveLength(1);
});

it('recognizes a first-generation card and repairs a missing link using the delivery ID', async () => {
    const char = await create();
    char.phoneState!.sendToChat = true;
    await DB.saveCharacter(char);
    await DB.savePhoneGeneration(char.id, { records: [{ ...char.phoneState!.records[0], id: 'generated' }] }, '淘宝');
    const current = await read(char.id), row = current.phoneState!.records.find(record => record.id === 'generated')!;
    const messageId = row.systemMessageId;
    delete row.systemMessageId;
    await DB.saveCharacter(current);
    expect(await DB.syncPhoneEvidenceToChat(char.id, 'generated', '淘宝')).toEqual({ messageId, inserted: false });
    expect((await read(char.id)).phoneState!.records.find(record => record.id === 'generated')!.systemMessageId).toBe(messageId);
    expect(await DB.getMessagesByCharId(char.id, true)).toHaveLength(1);
});

it('keeps legacy linked cards without delivery metadata, but rejects links to another character', async () => {
    const a = await create(), b = await create();
    const legacy = await DB.saveMessage({ charId: a.id, role: 'assistant', type: 'phone_card', content: '旧版卡片' });
    a.phoneState!.records[0].systemMessageId = legacy;
    b.phoneState!.records[0].systemMessageId = legacy;
    await DB.saveCharacter(a); await DB.saveCharacter(b);
    expect(await sync(a.id)).toEqual({ messageId: legacy, inserted: false });
    expect((await sync(b.id)).inserted).toBe(true);
    expect(await DB.getMessagesByCharId(a.id, true)).toHaveLength(1);
    expect(await DB.getMessagesByCharId(b.id, true)).toHaveLength(1);
});

it('reads the latest stored content and refuses to resurrect a deleted record', async () => {
    const char = await create();
    char.phoneState!.records[0].detail = '编辑后的内容';
    await DB.saveCharacter(char);
    const result = await sync(char.id);
    expect((await DB.getMessageById(result.messageId))!.content).toContain('编辑后的内容');
    char.phoneState!.records = [];
    await DB.saveCharacter(char);
    await expect(sync(char.id)).rejects.toThrow('不存在');
    expect(await DB.getMessagesByCharId(char.id, true)).toHaveLength(1);
    expect((await read(char.id)).phoneState!.records).toEqual([]);
});

it('rolls back the card and link together on failure and announces only committed changes', async () => {
    const char = await create();
    const target = new EventTarget(), event = vi.fn();
    target.addEventListener(PHONE_EVIDENCE_SYNCED, event);
    vi.stubGlobal('window', target);
    const original = IDBObjectStore.prototype.add;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<typeof original>) {
        const request = original.apply(this, args);
        if (this.name === 'messages') request.addEventListener('success', () => this.transaction.abort());
        return request;
    });
    await expect(sync(char.id)).rejects.toBeTruthy();
    expect((await read(char.id)).phoneState!.records[0].systemMessageId).toBeUndefined();
    expect(await DB.getMessagesByCharId(char.id, true)).toHaveLength(0);
    expect(event).not.toHaveBeenCalled();
    spy.mockRestore();
    const result = await sync(char.id);
    expect(event).toHaveBeenCalledTimes(1);
    expect(event.mock.calls[0][0].detail).toEqual({ charId: char.id, recordId: 'record', messageId: result.messageId });
});

it('updates only the in-memory link, without overwriting edits or resurrecting records', async () => {
    const char = await create(), link = { charId: char.id, recordId: 'record', messageId: 99 };
    const updated = applyPhoneEvidenceChatLink(char, link);
    expect(updated.phoneState!.records[0]).toEqual({ ...char.phoneState!.records[0], systemMessageId: 99 });
    expect(updated.phoneState!.contacts).toBe(char.phoneState!.contacts);
    expect(applyPhoneEvidenceChatLink(char, { ...link, recordId: 'deleted' })).toBe(char);
});
