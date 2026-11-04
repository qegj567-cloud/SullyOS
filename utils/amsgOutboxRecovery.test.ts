import { afterEach, expect, it, vi } from 'vitest';
import { ActiveMsgClient, type AmsgOutboxEntry } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { AMSG_OUTBOX_ADOPTED_LS_KEY, drainOutbox } from './amsgInstantChat';
import { DB } from './db';

afterEach(() => { vi.restoreAllMocks(); });

const outboxEntry = (charId: string, messageId: string, ageHours = 1): AmsgOutboxEntry => ({
  id: 1, messageId, taskUuid: `task-${messageId}`, sessionId: null,
  messageIndex: 1, totalMessages: 1, createdAt: Date.now() - ageHours * 3_600_000,
  deliveredAt: null,
  push: {
    messageKind: 'content', messageType: 'scheduled', messageId,
    message: '云端仍然保留的消息', metadata: { charId },
  },
});

it.each([1, 49, 21 * 24])('首次自动补收保留 %i 小时前仍在云端的正文，落库前不 ACK', async (ageHours) => {
  localStorage.removeItem(AMSG_OUTBOX_ADOPTED_LS_KEY);
  const messageId = `recovery-unseen-${ageHours}`;
  vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([
    outboxEntry(`recovery-char-${ageHours}`, messageId, ageHours),
  ]);
  const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
  const result = await drainOutbox();
  expect(result.writtenIds).toEqual([messageId]);
  expect(result.ackNow).toEqual([]);
  expect(result.staleDropped).toBe(0);
  expect(ack).not.toHaveBeenCalled();
  expect((await ActiveMsgStore.listInboxMessages()).some(message => message.messageId === messageId)).toBe(true);
});

it('超过最近 200 条并已归档的消息仍能去重，其他角色的同名 ID 不算已收到', async () => {
  localStorage.removeItem(AMSG_OUTBOX_ADOPTED_LS_KEY);
  const charId = 'recovery-archived-char';
  const oldId = 'recovery-persisted-old';
  const missingId = 'recovery-only-in-another-char';
  const archivedId = await DB.saveMessage({ charId, role: 'assistant', type: 'text', content: '已收到',
    metadata: { activeMsg2: { messageId: oldId } } } as any);
  for (let i = 0; i < 210; i += 1) {
    await DB.saveMessage({ charId, role: 'user', type: 'text', content: `后续聊天 ${i}` });
  }
  localStorage.setItem(`mp_lastMsgId_${charId}`, String(archivedId));
  await DB.saveMessage({ charId: `${charId}-other`, role: 'assistant', type: 'text', content: '其他角色',
    metadata: { activeMsg2: { messageId: missingId } } } as any);
  vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([
    outboxEntry(charId, oldId, 49), outboxEntry(charId, missingId, 49),
  ]);
  const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
  const result = await drainOutbox();
  expect(result.ackNow).toEqual([oldId]);
  expect(result.writtenIds).toEqual([missingId]);
  expect(ack).not.toHaveBeenCalled();
  expect((await ActiveMsgStore.listInboxMessages()).some(message => message.messageId === oldId)).toBe(false);
});

it('首次补收写入失败仍保留云端账目，下一次可以重新接收', async () => {
  localStorage.removeItem(AMSG_OUTBOX_ADOPTED_LS_KEY);
  const messageId = 'recovery-write-retry';
  vi.spyOn(ActiveMsgClient, 'listOutboxEntries').mockResolvedValue([
    outboxEntry('recovery-retry-char', messageId, 49),
  ]);
  const ack = vi.spyOn(ActiveMsgClient, 'ackOutboxMessages').mockResolvedValue(undefined);
  vi.spyOn(ActiveMsgStore, 'saveInboxMessage').mockRejectedValueOnce(new Error('quota'));
  const first = await drainOutbox();
  expect(first.written).toBe(0);
  expect(first.ackNow).toEqual([]);
  expect(ack).not.toHaveBeenCalled();
  expect((await drainOutbox()).writtenIds).toEqual([messageId]);
});
