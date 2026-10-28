import { expect, it } from 'vitest';
import {
    MAX_CLOUD_STOPPED_REPLY_KEYS,
    pickStaleStoppedReplyKeys,
    reconcileStoppedReplies,
    STOPPED_REPLY_CLOUD_TTL_MS,
    stoppedReplyKey,
} from './amsgStoppedReply';

it('停止后的云端自述只保留用户收到的正文，其他轮不变', () => {
    const log = { entries: [{ id: 'a', taskUuid: 'one', text: '全文' }, { id: 'b', taskUuid: 'two', text: '另一轮' }], tasks: [] } as any;
    const rows = [{ key: stoppedReplyKey('one'), value: JSON.stringify({ text: '已显示' }) }];
    expect(reconcileStoppedReplies(log, rows)?.entries.map(e => e.text)).toEqual(['已显示', '另一轮']);
    expect(log.entries[0].text).toBe('全文');
    expect(reconcileStoppedReplies(log, [{ ...rows[0], value: '{"text":""}' }])?.entries.map(e => e.id)).toEqual(['b']);
});

it('云端停止回执超出上限或过期时挑出待删键，且不误删本轮正在执行的键', () => {
    const now = 1_700_000_000_000;
    const rows = [
        { key: 'fire_pack', updatedAt: now - STOPPED_REPLY_CLOUD_TTL_MS - 5000 },
        { key: stoppedReplyKey('expired'), updatedAt: now - STOPPED_REPLY_CLOUD_TTL_MS - 1 },
        ...Array.from({ length: MAX_CLOUD_STOPPED_REPLY_KEYS + 2 }, (_, i) => ({
            key: stoppedReplyKey(`r-${i + 1}`),
            updatedAt: now - 10_000 + i * 100,
        })),
    ];
    const stale = pickStaleStoppedReplyKeys(rows, now, stoppedReplyKey('r-1'));
    expect(stale).toEqual([
        stoppedReplyKey('expired'),
        stoppedReplyKey('r-2'),
    ]);
});
