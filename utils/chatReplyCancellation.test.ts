import { describe, expect, it } from 'vitest';
import { DB } from './db';
import { createReplyRun, publishReplyDisplay, stopReplyRuns, isReplyStopped, markReplyStopped, MAX_STOPPED_REPLY_UUIDS } from './chatReplyCancellation';

describe('停止回复', () => {
    it('保留已提交到界面的气泡，删除已落库但还没显示的气泡', async () => {
        const run = createReplyRun('stop-visible');
        const first = await run.saveMessage({ charId: run.charId, role: 'assistant', type: 'text', content: '已经显示' });
        await run.saveMessage({ charId: run.charId, role: 'assistant', type: 'text', content: '未显示' });
        publishReplyDisplay(run.charId, [first], []);
        stopReplyRuns(run.charId);
        await run.settle();
        expect((await DB.getRecentMessagesByCharId(run.charId, 20)).map(m => m.content)).toEqual(['已经显示']);
        await expect(run.saveMessage({ charId: run.charId, role: 'assistant', type: 'text', content: '迟到' })).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('流式停止只保存界面已显示的安全正文，不保存后续增量', async () => {
        const run = createReplyRun('stop-stream');
        publishReplyDisplay(run.charId, [], ['第一句', '显示到一半']);
        stopReplyRuns(run.charId);
        publishReplyDisplay(run.charId, [], ['第一句', '显示到一半之后的内容']);
        await run.settle();
        await run.settle();
        expect((await DB.getRecentMessagesByCharId(run.charId, 20)).map(m => m.content)).toEqual(['第一句', '显示到一半']);
    });

    it('取消立即结束等待，旧轮清理不会取消新轮', async () => {
        const old = createReplyRun('stop-wait');
        const waiting = old.wait(new Promise(() => {}));
        stopReplyRuns(old.charId);
        await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
        const next = createReplyRun(old.charId);
        await old.settle();
        expect(next.signal.aborted).toBe(false);
        await next.settle();
    });

    it('按uuid持久化停止记录，新轮不受影响，重建处理器也不能接收旧轮', async () => {
        markReplyStopped('stopped-cloud-uuid');
        expect(isReplyStopped('stopped-cloud-uuid')).toBe(true);
        expect(isReplyStopped('next-cloud-uuid')).toBe(false);
        const late = createReplyRun('cloud-char', 'stopped-cloud-uuid');
        await expect(late.wait(Promise.resolve('late'))).rejects.toMatchObject({ name: 'AbortError' });
        await late.settle();
    });

    it('停止记录按上限滚动淘汰最旧 uuid，防止 localStorage 无限增长', () => {
        for (let i = 0; i < MAX_STOPPED_REPLY_UUIDS + 25; i++) {
            markReplyStopped(`cap-uuid-${i}`);
        }
        const stored = JSON.parse(localStorage.getItem('chat_stopped_reply_uuids_v1') || '[]') as string[];
        expect(stored.length).toBe(MAX_STOPPED_REPLY_UUIDS);
        expect(isReplyStopped('cap-uuid-0')).toBe(false);
        expect(isReplyStopped(`cap-uuid-${MAX_STOPPED_REPLY_UUIDS + 24}`)).toBe(true);
    });
});

it('翻历史以后，先前已经上屏的本轮气泡仍然保留', async () => {
    const run = createReplyRun('stop-scrolled');
    const id = await run.saveMessage({ charId: run.charId, role: 'assistant', type: 'text', content: '看过了' });
    publishReplyDisplay(run.charId, [id], []);
    publishReplyDisplay(run.charId, [], []);
    stopReplyRuns(run.charId);
    await run.settle();
    expect((await DB.getRecentMessagesByCharId(run.charId, 20)).map(m => m.content)).toEqual(['看过了']);
});
