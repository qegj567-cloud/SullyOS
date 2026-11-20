import type { ActiveMsg2InboxMessage } from '../types';
import { flushInboxToChat, handleInstantErrorPushMessage } from './activeMsgRuntime';
import { ActiveMsgStore } from './activeMsgStore';
import { dispatchAmsgResult } from './amsgResults';
import { listUserSpaces } from './userSpaces';
import { diagnosticRunId } from './amsgReproduction';

const RECEIVED_IDS_KEY = 'amsg2_native_received_ids_v2';

const readReceivedIds = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECEIVED_IDS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
};

const rememberReceivedId = (messageId: string): void => {
  const next = [messageId, ...readReceivedIds().filter((id) => id !== messageId)].slice(0, 100);
  localStorage.setItem(RECEIVED_IDS_KEY, JSON.stringify(next));
};

export const parseNativeAmsgPayload = (raw: unknown): Record<string, any> | null => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, any>;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : null;
  } catch {
    return null;
  }
};

export class NativeAmsgDeferredError extends Error {
  constructor() { super('Native push retained for a later delivery'); }
}

// Live listener, notification click and cold-start queue can deliver the same item together.
let deliveryChain: Promise<unknown> = Promise.resolve();
export const ingestNativeAmsgPayload = (
  raw: unknown,
  previewOverride?: string,
): Promise<{ charId: string; messageId: string } | null> => {
  const run = deliveryChain.then(() => ingest(raw, previewOverride));
  deliveryChain = run.catch(() => {});
  return run;
};

/** Same business routes as the SW; never render a result/error as character dialogue. */
const ingest = async (
  raw: unknown,
  previewOverride?: string,
): Promise<{ charId: string; messageId: string } | null> => {
  const payload = parseNativeAmsgPayload(raw);
  if (!payload) return null;
  const kind = payload.messageKind ?? 'content';
  const charId = payload.metadata?.charId ?? payload.charId;

  if (kind === 'result') {
    // Handler owns dedupe and space checks. false means keep the native queue item.
    if (!await dispatchAmsgResult(payload)) throw new NativeAmsgDeferredError();
    return typeof charId === 'string' ? { charId, messageId: String(payload.messageId || '') } : null;
  }
  if (kind === 'error') {
    if (typeof charId === 'string' && !diagnosticRunId(payload.metadata) && listUserSpaces().length > 1) {
      const { DB } = await import('./db');
      if (!await DB.getCharacter(charId)) throw new NativeAmsgDeferredError();
    }
    await handleInstantErrorPushMessage(payload);
    return typeof charId === 'string' ? { charId, messageId: String(payload.messageId || '') } : null;
  }
  // Reasoning/tools are not standalone chat in SullyOS. Multipart is restored natively.
  if (kind !== 'content' && kind !== 'emotion_update') return null;
  if (typeof charId !== 'string' || !charId) return null;

  const messageId = String(payload.messageId || `${charId}-${Date.now()}`);
  if (readReceivedIds().includes(messageId)) {
    await flushInboxToChat('原生收件箱');
    return { charId, messageId };
  }

  const parsedSentAt = payload.timestamp ? new Date(payload.timestamp).getTime() : NaN;
  const body = kind === 'emotion_update' ? '' : String(payload.message || payload.body || '').trim();
  const inbox: ActiveMsg2InboxMessage = {
    messageId,
    charId,
    charName: String(payload.contactName || payload.metadata?.charName || '主动消息'),
    body,
    previewBody: kind === 'emotion_update' ? '' : String(previewOverride || payload.notification?.body || payload.previewBody || body).trim(),
    avatarUrl: payload.avatarUrl,
    source: payload.source,
    messageType: kind === 'emotion_update' ? 'emotion_update' : payload.messageType,
    messageSubtype: payload.messageSubtype,
    taskId: payload.taskId ?? null,
    taskUuid: payload.taskUuid ?? null,
    recurrenceType: payload.recurrenceType ?? null,
    occurrenceMs: payload.occurrenceMs ?? null,
    metadata: {
      ...(payload.metadata || {}),
      // Android already applied the notification policy, including deliberately not showing one.
      nativeNotificationHandled: true,
      sessionId: payload.sessionId,
      messageIndex: payload.messageIndex,
      totalMessages: payload.totalMessages,
    },
    sentAt: Number.isFinite(parsedSentAt) ? parsedSentAt : Date.now(),
    receivedAt: Date.now(),
  };

  await ActiveMsgStore.saveInboxMessage(inbox);
  rememberReceivedId(messageId);
  await flushInboxToChat('原生收件箱');
  return { charId, messageId };
};
