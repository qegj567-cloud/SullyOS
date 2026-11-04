import { describe, it, expect, vi } from 'vitest';
import { ActiveMsgStore, importAmsg2GlobalConfig } from './activeMsgStore';
import type { Amsg2ExpiredNoticeRecord } from '../types';

// fake-indexeddb 已通过 test-setup.ts 自动注入. 跨测试 deleteDatabase 会被单例连接
// block — 改用每个 case 唯一 key 隔离.

let _sid = 0;

it('恢复备份不会把旧 Worker 原生能力结论当成当前状态', async () => {
  const previous=await ActiveMsgStore.getGlobalConfig();
  try {
    await importAmsg2GlobalConfig({userId:'restore-test',workerUrl:'https://worker.test',anthropicMessagesSupported:true,anthropicMessagesWorkerUrl:'https://worker.test'},{allowBackendConnection:true});
    const config=await ActiveMsgStore.getGlobalConfig();
    expect(config.workerUrl).toBe('https://worker.test');
    expect(config.anthropicMessagesSupported).toBeUndefined();
    expect(config.anthropicMessagesWorkerUrl).toBeUndefined();
  } finally {await ActiveMsgStore.saveGlobalConfig(previous);}
});

describe('ActiveMsgStore 连接', () => {
  it('连接复用: 单例建立后后续操作不再新开 indexedDB 连接', async () => {
    // 先跑一次确保单例已建立, 这里幂等。
    await ActiveMsgStore.getGlobalConfig();
    const openSpy = vi.spyOn(indexedDB, 'open');
    try {
      await ActiveMsgStore.getGlobalConfig();
      await ActiveMsgStore.listInboxMessages();
      await ActiveMsgStore.consumeInboxMessages();
      // 3 个操作都复用单例, 0 次 open。
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });
});

describe('ActiveMsgStore 作废回执台账', () => {
  const uniqueChar = (label: string) => `${label}-${++_sid}-${Date.now()}`;
  const rec = (id: string, charId: string, extra: Partial<Amsg2ExpiredNoticeRecord> = {}): Amsg2ExpiredNoticeRecord => ({
    id, charId, occurrenceMs: Date.now() - 1000, mode: 'auto', recurrenceType: 'none',
    createdAt: Date.now(), ...extra,
  });

  it('upsert 按 id 去重，getExpiredNotices 读回', async () => {
    const charId = uniqueChar('n1');
    await ActiveMsgStore.upsertExpiredNotices(charId, [rec('a', charId)]);
    await ActiveMsgStore.upsertExpiredNotices(charId, [rec('a', charId), rec('b', charId)]);
    expect((await ActiveMsgStore.getExpiredNotices(charId)).map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('markExpiredNoticesNotified 只标指定 id，不覆盖已有 notifiedAt', async () => {
    const charId = uniqueChar('n2');
    await ActiveMsgStore.upsertExpiredNotices(charId, [rec('a', charId), rec('b', charId)]);
    await ActiveMsgStore.markExpiredNoticesNotified(charId, ['a']);
    const list = await ActiveMsgStore.getExpiredNotices(charId);
    expect(list.find((r) => r.id === 'a')?.notifiedAt).toBeTypeOf('number');
    expect(list.find((r) => r.id === 'b')?.notifiedAt).toBeUndefined();
  });

  it('48h 前的老记录在 upsert 时被清掉', async () => {
    const charId = uniqueChar('n3');
    await ActiveMsgStore.upsertExpiredNotices(charId, [rec('old', charId, { createdAt: Date.now() - 49 * 3600_000 })]);
    await ActiveMsgStore.upsertExpiredNotices(charId, [rec('new', charId)]);
    expect((await ActiveMsgStore.getExpiredNotices(charId)).map((r) => r.id)).toEqual(['new']);
  });

  it('超上限时先淘汰已告知的，未告知的保留（作废 ≠ 消失）', async () => {
    const charId = uniqueChar('n4');
    const notified = Array.from({ length: 10 }, (_, i) =>
      rec(`old-${i}`, charId, { notifiedAt: Date.now(), occurrenceMs: Date.now() - i * 1000 }));
    await ActiveMsgStore.upsertExpiredNotices(charId, notified);
    await ActiveMsgStore.upsertExpiredNotices(charId, [rec('fresh', charId)]);
    const list = await ActiveMsgStore.getExpiredNotices(charId);
    expect(list.find((r) => r.id === 'fresh')).toBeTruthy();
    expect(list.length).toBeLessThanOrEqual(10);
  });
});
