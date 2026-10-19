import { ActiveMsgStore } from './activeMsgStore';
import { DB } from './db';
import { outboxPushToInbox } from './amsgInstantChat';

const inFlight = new Map<string, Promise<boolean>>();

/** 纯动作结果复用收件箱的持久化、重试与卡片落库。只有处理完成才允许云端销账。 */
export async function applyAmsgActionResult(payload: unknown): Promise<boolean> {
  if (!payload || typeof payload !== 'object') return true;
  const result = payload as Record<string, any>;
  if (result.v !== 1 || typeof result.messageId !== 'string' || !result.messageId
    || typeof result.charId !== 'string' || !result.charId
    || !result.push || result.push.metadata?.charId !== result.charId
    || !Array.isArray(result.push.metadata?.directives)) return true;
  const key = JSON.stringify([result.charId, result.messageId]);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const applying = applyOnce(result);
  inFlight.set(key, applying);
  try { return await applying; }
  finally { if (inFlight.get(key) === applying) inFlight.delete(key); }
}

async function applyOnce(result: Record<string, any>): Promise<boolean> {
  if (await ActiveMsgStore.hasAppliedActionResult(result.charId, result.messageId)) return true;
  const persisted = await DB.findPersistedActiveMessageIds(result.charId, [result.messageId]);
  if (persisted.has(result.messageId)) return true;
  const existing = (await ActiveMsgStore.listInboxMessages()).find(row => row.messageId === result.messageId);
  if (!existing) {
    const message = outboxPushToInbox({ ...result.push, messageId: result.messageId,
      metadata: { ...result.push.metadata, amsgActionResult: true },
    }, Date.now());
    if (!message) return true;
    await ActiveMsgStore.saveInboxMessage(message);
  }
  // 纯 result 批次没有正文计数，不能等外层 written > 0 才冲刷。
  const { flushInboxToChat } = await import('./activeMsgRuntime');
  const landed = await flushInboxToChat('动作结果', result.charId);
  return landed.includes(result.messageId)
    || await ActiveMsgStore.hasAppliedActionResult(result.charId, result.messageId);
}
