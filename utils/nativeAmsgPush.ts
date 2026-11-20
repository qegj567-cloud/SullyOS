import {
  PushNotifications,
  type ActionPerformed,
  type PushNotificationSchema,
  type Token,
} from '@capacitor/push-notifications';
import type { ActiveMsg2InboxMessage } from '../types';
import { ActiveMsgClient, NATIVE_PUSH_TOKEN_STORAGE_KEY } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { isAmsg2WorkerActive } from './amsgGlobalGate';
import { flushInboxToChat } from './activeMsgRuntime';

const RECEIVED_IDS_KEY = 'amsg2_native_received_ids_v1';
let initialized = false;

const readReceivedIds = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECEIVED_IDS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
};

const rememberReceivedId = (messageId: string) => {
  const next = [messageId, ...readReceivedIds().filter((id) => id !== messageId)].slice(0, 100);
  localStorage.setItem(RECEIVED_IDS_KEY, JSON.stringify(next));
};

export const decodeNativeAmsgPayload = (
  notification: Pick<PushNotificationSchema, 'body' | 'data'>,
): Record<string, any> | null => {
  const raw = notification.data?.amsgPayload;
  if (typeof raw !== 'string') return null;
  try {
    const payload = JSON.parse(raw) as Record<string, any>;
    payload.message = notification.data?.amsgHasBody === '1' ? String(notification.body || '') : '';
    return payload;
  } catch { return null; }
};

const ingestNotification = async (notification: PushNotificationSchema): Promise<void> => {
  const payload = decodeNativeAmsgPayload(notification);
  const charId = payload?.metadata?.charId;
  if (!payload || typeof charId !== 'string' || !charId) return;
  const messageId = String(payload.messageId || `${charId}-${Date.now()}`);
  if (readReceivedIds().includes(messageId)) return;

  const parsedSentAt = payload.timestamp ? new Date(payload.timestamp).getTime() : NaN;
  const body = String(payload.message || '').trim();
  const inbox: ActiveMsg2InboxMessage = {
    messageId,
    charId,
    charName: String(payload.contactName || payload.metadata?.charName || '主动消息'),
    body,
    previewBody: String(notification.body || body).trim(),
    avatarUrl: payload.avatarUrl,
    source: payload.source,
    messageType: payload.messageType,
    messageSubtype: payload.messageSubtype,
    taskId: payload.taskId ?? null,
    taskUuid: payload.taskUuid ?? null,
    recurrenceType: payload.recurrenceType ?? null,
    occurrenceMs: payload.occurrenceMs ?? null,
    metadata: {
      ...(payload.metadata || {}),
      sessionId: payload.sessionId,
      messageIndex: payload.messageIndex,
      totalMessages: payload.totalMessages,
    },
    sentAt: Number.isFinite(parsedSentAt) ? parsedSentAt : Date.now(),
    receivedAt: Date.now(),
  };
  await ActiveMsgStore.saveInboxMessage(inbox);
  rememberReceivedId(messageId);
  await flushInboxToChat('原生推送');
};

const registerToken = async (token: Token) => {
  const value = token.value?.trim();
  if (!value) return;
  localStorage.setItem(NATIVE_PUSH_TOKEN_STORAGE_KEY, value);
  try {
    const config = await ActiveMsgStore.getGlobalConfig();
    if (!isAmsg2WorkerActive(config)) return;
    await ActiveMsgClient.registerNativePushToken(value);
  } catch (error) {
    console.info('[ActiveMsg:native] token 已保存，等待 Worker 连接后补登记', error);
  }
};

export const initNativeAmsgPush = async (): Promise<void> => {
  if (initialized) return;
  initialized = true;
  await PushNotifications.createChannel({
    id: 'amsg2', name: '主动消息', description: '角色主动消息与定时消息',
    importance: 5, visibility: 1, vibration: true,
  }).catch(() => undefined);
  await PushNotifications.addListener('registration', registerToken);
  await PushNotifications.addListener('registrationError', (error) =>
    console.warn('[ActiveMsg:native] FCM registration 失败', error));
  await PushNotifications.addListener('pushNotificationReceived', (notification) =>
    void ingestNotification(notification));
  await PushNotifications.addListener('pushNotificationActionPerformed', (action: ActionPerformed) => {
    void ingestNotification(action.notification).then(() => {
      const charId = decodeNativeAmsgPayload(action.notification)?.metadata?.charId;
      if (typeof charId === 'string' && charId) {
        window.dispatchEvent(new CustomEvent('active-msg-open', { detail: { charId } }));
      }
    });
  });
  const current = await PushNotifications.checkPermissions();
  const permission = current.receive === 'prompt'
    ? await PushNotifications.requestPermissions()
    : current;
  if (permission.receive === 'granted') await PushNotifications.register();
};

