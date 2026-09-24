import { describe, it, expect } from 'vitest';
import { DB } from './db';
import { getReliableMemoryPalaceHighWaterMark, setReliableMemoryPalaceHighWaterMark } from './memoryPalace/highWaterMark';

// 记忆宫殿水位线自愈：浏览器清掉 IndexedDB（消息自增 id 归零重计）但 localStorage
// 幸存时，残留的 mp_lastMsgId_ 高水位会把该角色所有新消息（含刚发的那条）从
// hwm 过滤读取里挡掉 —— 请求只剩 system 消息、上游 400。不变式：合法水位是某条
// 既有消息的 id，新消息的自增 id 必然大于它；出现新 id ≤ 水位即证明水位失效。
describe('saveMessage 记忆宫殿水位线自愈', () => {
    it('推送首次落库清理只有镜像中的失效水位，重复投递不清理合法水位', async () => {
        const charId = 'push-stale-mirror';
        await DB.saveAssetRaw(`mp_hwm_v1_${charId}`, { msgId: 99999 });
        const payload = { charId, role: 'assistant', type: 'text', content: '推送' } as const;
        const id = await DB.saveMessageOnce('delivery-stale', payload);
        expect(await DB.getAssetRaw(`mp_hwm_v1_${charId}`)).toBeNull();
        expect(await getReliableMemoryPalaceHighWaterMark(charId)).toBe(0);
        await setReliableMemoryPalaceHighWaterMark(charId, id);
        expect(await DB.saveMessageOnce('delivery-stale', payload)).toBe(id);
        expect(await getReliableMemoryPalaceHighWaterMark(charId)).toBe(id);
    });

    it('后台校准和新消息并发时，失效镜像不会重新污染本地水位', async () => {
        for (const readFirst of [true, false]) {
            const charId = `concurrent-hwm-${readFirst}`;
            await setReliableMemoryPalaceHighWaterMark(charId, 99999);
            const read = () => getReliableMemoryPalaceHighWaterMark(charId);
            const write = () => DB.saveMessage({ charId, role: 'user', type: 'text', content: '新消息' });
            await Promise.all(readFirst ? [read(), write()] : [write(), read()]);
            expect(await getReliableMemoryPalaceHighWaterMark(charId)).toBe(0);
            expect((await DB.getRecentMessagesByCharId(charId, 10)).map(m => m.content)).toContain('新消息');
        }
    });

    it('残留高水位 ≥ 新消息 id → 落库时自动移除，该消息能被默认读取到', async () => {
        localStorage.setItem('mp_lastMsgId_char-stale', '99999');
        const id = await DB.saveMessage({ charId: 'char-stale', role: 'user', type: 'text', content: '你好' } as any);
        expect(id).toBeLessThan(99999);
        expect(localStorage.getItem('mp_lastMsgId_char-stale')).toBeNull();
        // 水位清掉后，默认（hwm 过滤）读取要能看到这条消息 —— 之前 400 的根因就是这里读出空数组
        const msgs = await DB.getRecentMessagesByCharId('char-stale', 10);
        expect(msgs.map(m => m.content)).toContain('你好');
    });

    it('正常水位（小于新消息 id）原样保留', async () => {
        localStorage.setItem('mp_lastMsgId_char-ok', '1');
        const id = await DB.saveMessage({ charId: 'char-ok', role: 'user', type: 'text', content: 'hi' } as any);
        expect(id).toBeGreaterThan(1);
        expect(localStorage.getItem('mp_lastMsgId_char-ok')).toBe('1');
    });

    it('群聊消息同时校验并清理失效的群水位键', async () => {
        localStorage.setItem('mp_lastMsgId_group_g1', '99999');
        await DB.saveMessage({ charId: 'char-x', groupId: 'g1', role: 'user', type: 'text', content: 'g' } as any);
        expect(localStorage.getItem('mp_lastMsgId_group_g1')).toBeNull();
    });
});
