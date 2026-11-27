import { describe, expect, it } from 'vitest';
import { DB } from './db';

const schedule = (id: string, charId: string, dueAt: number) =>
    DB.saveScheduledMessage({ id, charId, content: `内容 ${id}`, dueAt, createdAt: 1 });

describe('定时消息轮询：一次查询找出有到期消息的角色', () => {
    it('只返回有到期消息的角色，结果与逐个角色查询一致', async () => {
        const past = Date.now() - 1000;
        const future = Date.now() + 60_000;
        await schedule('a1', 'char-a', past);
        await schedule('a2', 'char-a', future);
        await schedule('b1', 'char-b', future);
        await schedule('c1', 'char-c', past);

        const due = await DB.getCharIdsWithDueScheduledMessages();
        expect([...due].sort()).toEqual(['char-a', 'char-c']);
        for (const charId of ['char-a', 'char-b', 'char-c', 'char-none']) {
            expect(due.has(charId)).toBe((await DB.getDueScheduledMessages(charId)).length > 0);
        }
    });

    it('消息投递删除后，该角色不再出现', async () => {
        await DB.deleteScheduledMessage('a1');
        await DB.deleteScheduledMessage('c1');
        expect((await DB.getCharIdsWithDueScheduledMessages()).size).toBe(0);
    });
});
