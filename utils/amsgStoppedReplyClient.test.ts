import { beforeEach, expect, it } from 'vitest';
import {
    ackStoppedReplyReceipts,
    clearStoppedReplyReceipts,
    MAX_STOPPED_REPLY_RECEIPTS_PER_CHAR,
    stageStoppedReplyReceipt,
    STOPPED_REPLY_RECEIPT_TTL_MS,
    stoppedReplyStateEntries,
} from './amsgStoppedReplyClient';
import { stoppedReplyKey } from './amsgStoppedReply';

beforeEach(() => {
    clearStoppedReplyReceipts();
});

it('下一轮等待本地保留正文确定后才打包，避免角色记住被丢弃的全文', async () => {
    let finish!: (text: string) => void;
    const reconciliation = stageStoppedReplyReceipt('receipt-char', 'receipt-round', new Promise(resolve => { finish = resolve; }));
    let packed = false;
    const nextTurn = stoppedReplyStateEntries('receipt-char').then(rows => { packed = true; return rows; });
    await Promise.resolve();
    expect(packed).toBe(false);
    expect(await stoppedReplyStateEntries('unrelated-char')).toEqual([]);
    finish('实际显示到这里');
    await reconciliation;
    expect(await nextTurn).toContainEqual({ key: stoppedReplyKey('receipt-round'), value: JSON.stringify({ text: '实际显示到这里' }) });
});

it('存量超过 200 条停止回执时自动裁剪到单角色上限，且上传成功后销账不再重传', async () => {
    const legacy: Record<string, { charId: string; uuid: string; text: string }> = {};
    for (let i = 1; i <= 250; i += 1) {
        legacy[`u-${i}`] = { charId: 'char-overflow', uuid: `u-${i}`, text: `第${i}次` };
    }
    localStorage.setItem('amsg_stopped_reply_receipts_v1', JSON.stringify(legacy));

    const entries = await stoppedReplyStateEntries('char-overflow');
    expect(entries).toHaveLength(MAX_STOPPED_REPLY_RECEIPTS_PER_CHAR);
    expect(entries.map(e => e.key)).toEqual([
        'chat_stop:u-243',
        'chat_stop:u-244',
        'chat_stop:u-245',
        'chat_stop:u-246',
        'chat_stop:u-247',
        'chat_stop:u-248',
        'chat_stop:u-249',
        'chat_stop:u-250',
    ]);

    ackStoppedReplyReceipts(entries, 'char-overflow');
    expect(await stoppedReplyStateEntries('char-overflow')).toEqual([]);
    expect(localStorage.getItem('amsg_stopped_reply_receipts_v1')).toBeNull();
});

it('过期回执自动淘汰，按角色清理不影响其他角色', async () => {
    const now = Date.now();
    localStorage.setItem('amsg_stopped_reply_receipts_v1', JSON.stringify({
        stale: { charId: 'char-a', uuid: 'stale', text: '旧的', updatedAt: now - STOPPED_REPLY_RECEIPT_TTL_MS - 1000 },
        freshA: { charId: 'char-a', uuid: 'freshA', text: '新的A', updatedAt: now },
        freshB: { charId: 'char-b', uuid: 'freshB', text: '新的B', updatedAt: now },
    }));

    expect(await stoppedReplyStateEntries('char-a')).toEqual([
        { key: stoppedReplyKey('freshA'), value: JSON.stringify({ text: '新的A' }) },
    ]);
    clearStoppedReplyReceipts('char-a');
    expect(await stoppedReplyStateEntries('char-a')).toEqual([]);
    expect(await stoppedReplyStateEntries('char-b')).toEqual([
        { key: stoppedReplyKey('freshB'), value: JSON.stringify({ text: '新的B' }) },
    ]);
});
