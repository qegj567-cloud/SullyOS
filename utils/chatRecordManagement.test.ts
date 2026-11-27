import { expect, it } from 'vitest';
import { openDB } from './db';
import { commitSpaceRows } from './userSpaceData';
import { countChatRecords, readChatRecordPage, parseChatRecordText, importChatRecordText } from './chatRecordManagement';
import { formatChatTextExport } from './chatTextExport';

it('pages exactly fifty records without leaking other roles or group records', async () => {
    const db = await openDB();
    await commitSpaceRows(db, { messages: [
        ...Array.from({ length: 121 }, (_, i) => ({ id: i + 1, charId: 'page-role', role: 'user', type: 'text', content: String(i), timestamp: i + 1 })),
        { id: 122, charId: 'other', content: 'secret' }, { id: 123, charId: 'page-role', groupId: 'g', content: 'group-secret' },
    ] }, true);
    const owner = { id: 'page-role' };
    expect(await countChatRecords(owner)).toBe(121);
    const first = await readChatRecordPage(owner);
    expect(first.messages).toHaveLength(50); expect(first.messages[0].id).toBe(72);
    const second = await readChatRecordPage(owner, first.messages[0].id);
    expect(second.messages).toHaveLength(50); expect(second.messages[0].id).toBe(22);
    const third = await readChatRecordPage(owner, second.messages[0].id);
    expect(third.messages).toHaveLength(21); expect(third.hasMore).toBe(false);
});
it('round trips exported multiline text and appends with new IDs', async () => {
    const text = formatChatTextExport([{ id: 1, charId: 'old', role: 'user', type: 'text', timestamp: 1700000000000, content: 'first\nsecond\n\nthird' }]);
    expect(parseChatRecordText(text)[0].content).toBe('first\nsecond\n\nthird');
    await importChatRecordText({ id: 'import-role' }, text);
    await importChatRecordText({ id: 'import-role' }, text);
    expect(await countChatRecords({ id: 'import-role' })).toBe(2);
    expect(() => parseChatRecordText('unrecognized')).toThrow();
});
