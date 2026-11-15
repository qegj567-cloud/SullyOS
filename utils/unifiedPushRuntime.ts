import type { PluginListenerHandle } from '@capacitor/core';
import { requestNativeNotificationOpen } from './nativeNotificationNavigation';
import { AMSG_GLOBAL_CONFIG_EVENT, isAmsg2WorkerActive } from './amsgGlobalGate';
import { ingestNativeAmsgPayload, parseNativeAmsgPayload } from './nativeAmsgInbox';
import {
  acknowledgeUnifiedPushMessage, acknowledgeUnifiedPushRegistration, addUnifiedPushListener,
  isUnifiedPushPlatform, peekUnifiedPushMessages, readUnifiedPushTransportStatus,
} from './unifiedPushPlugin';

let initialization: Promise<void> | undefined;
let refreshChain: Promise<void> | undefined;
let refreshAgain = false;

const openNotification = (raw: unknown) => {
  const payload = parseNativeAmsgPayload(raw);
  const charId = payload?.metadata?.charId ?? payload?.charId;
  if (typeof charId === 'string' && charId) {
    requestNativeNotificationOpen(charId);
  }
};

const reconcileRegistration = async () => {
  const status = await readUnifiedPushTransportStatus();
  const revision = status.registrationRevision;
  if (!revision || revision === status.acknowledgedRegistration || !status.subscription) return;
  const { ActiveMsgStore } = await import('./activeMsgStore');
  const config = await ActiveMsgStore.getGlobalConfig();
  // Pausing must stop automatic Worker requests; do not replace third-party push.
  if (!isAmsg2WorkerActive(config) || config.pushMode === 'third-party') return;
  const { ActiveMsgClient } = await import('./activeMsgClient');
  if (await ActiveMsgClient.reconcilePushSubscription() === 'registered') {
    await acknowledgeUnifiedPushRegistration(revision);
  }
};

/** Keep native storage until EACH item has been accepted by master's business handlers. */
const refresh = (): Promise<void> => {
  refreshAgain = true;
  if (refreshChain) return refreshChain;
  refreshChain = (async () => {
    do {
      refreshAgain = false;
      const pending = await peekUnifiedPushMessages();
      for (const message of pending.messages || []) {
        try {
          await ingestNativeAmsgPayload(message.payload);
          await acknowledgeUnifiedPushMessage(message.id);
        } catch {
          // Failed DB/result/other-space delivery stays queued; never log private payloads.
        }
      }
      if (pending.launchPayload) openNotification(pending.launchPayload);
      try { await reconcileRegistration(); } catch { /* retry on resume/endpoint event */ }
    } while (refreshAgain);
  })().finally(() => { refreshChain = undefined; });
  return refreshChain;
};

const retry = () => { void refresh().catch(() => console.warn('[UnifiedPush] 原生收件箱暂不可用，下次回到前台重试')); };

export const initUnifiedPushRuntime = (): Promise<void> => {
  if (!isUnifiedPushPlatform()) return Promise.resolve();
  if (initialization) return initialization;
  initialization = (async () => {
    const handles: PluginListenerHandle[] = [];
    const onVisible = () => { if (document.visibilityState === 'visible') retry(); };
    try {
      // Events wake the persistent queue, never deliver an unacknowledgeable copy.
      handles.push(await addUnifiedPushListener('pushReceived', retry));
      handles.push(await addUnifiedPushListener('registrationChanged', retry));
      handles.push(await addUnifiedPushListener('foreground', retry));
      handles.push(await addUnifiedPushListener('notificationTapped', (event) => {
        openNotification(event?.payload);
        retry();
      }));
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener(AMSG_GLOBAL_CONFIG_EVENT, retry);
      await refresh().catch(() => {});
    } catch (error) {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(AMSG_GLOBAL_CONFIG_EVENT, retry);
      await Promise.all(handles.map(handle => handle.remove().catch(() => {})));
      initialization = undefined;
      throw error;
    }
  })();
  return initialization;
};
