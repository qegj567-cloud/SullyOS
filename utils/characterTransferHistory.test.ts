import { expect, it } from 'vitest';
import { openSpaceDB } from './db';
import { commitSpaceRows, readSpaceStore } from './userSpaceData';
import { prepareInheritedHistory } from './characterTransferHistory';

it('copies selected private history and a self-contained memory graph without overwriting target records', async () => {
    const source = await openSpaceDB('u_transfer_source'), target = await openSpaceDB('u_transfer_target');
    await commitSpaceRows(source, {
        messages: [{ id: 1, charId: 'a', content: 'a', timestamp: 123 }, { id: 2, charId: 'a', groupId: 'group', content: 'private group' }, { id: 3, charId: 'b' }],
        memory_nodes: [{ id: 'n', charId: 'a', content: 'a', eventBoxId: 'box' }],
        memory_vectors: [{ memoryId: 'n', charId: 'a', vector: new Float32Array([1, 2]) }],
        event_boxes: [{ id: 'box', charId: 'a' }],
    });
    await commitSpaceRows(target, { messages: [{ id: 10, charId: 'existing', content: 'keep' }] });
    const originals: any[] = [{ id: 'a', memories: [{ palaceMemoryId: 'n', summary: 'a' }] }];
    const copies: any[] = [{ id: 'new', memories: [] }];
    const rows = await prepareInheritedHistory(source, target, originals, copies, { chat: true, memory: true });
    expect(rows.messages).toEqual([{ id: 11, charId: 'new', content: 'a', timestamp: 123 }]);
    expect(rows.memory_nodes[0].id).not.toBe('n');
    expect(rows.memory_nodes[0].eventBoxId).toBe(rows.event_boxes[0].id);
    expect(rows.memory_vectors[0].memoryId).toBe(rows.memory_nodes[0].id);
    expect(rows.memory_vectors[0].vector).toEqual(new Float32Array([1, 2]));
    expect(copies[0].memories[0].palaceMemoryId).toBe(rows.memory_nodes[0].id);
    await commitSpaceRows(target, rows, false, ['messages']);
    expect((await readSpaceStore(target, 'messages'))[0].content).toBe('keep');
    await expect(commitSpaceRows(target, rows, false, ['messages'])).rejects.toBeTruthy();
});

it('keeps both optional histories off by default', async () => {
    const db = await openSpaceDB('u_transfer_empty');
    const copies: any[] = [{ id: 'new', memories: [] }];
    expect(await prepareInheritedHistory(db, db, [{ id: 'a' }] as any, copies, {})).toEqual({});
    expect(copies[0].memories).toEqual([]);
    expect(copies[0].activeMsg2Config.instantChatEnabled).toBe(false);
});
