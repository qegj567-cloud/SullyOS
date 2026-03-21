/// <reference lib="WebWorker" />

import { installReiSW } from '@rei-standard/amsg-sw';

const PING_INTERVAL = 15_000;
const MAX_MANUAL_ALIVE_MS = 5 * 60_000;
const ACTIVE_MSG_DB_NAME = 'ActiveMsg';
const ACTIVE_MSG_DB_VERSION = 1;
const ACTIVE_MSG_INBOX_STORE = 'inbox';

let pingTimer: number | null = null;
let manualKeepAliveCount = 0;
let manualKeepAliveStartedAt = 0;

const proactiveSchedules = new Map<string, { charId: string; intervalMs: number }>();
const proactiveTimers = new Map<string, number>();

const sw = self as unknown as ServiceWorkerGlobalScope;

installReiSW(sw, {
  defaultIcon: './icons/icon-192.png',
  defaultBadge: './icons/icon-192.png',
});

function hasActiveProactiveSchedules() {
  return proactiveTimers.size > 0;
}

function shouldKeepAlive() {
  return manualKeepAliveCount > 0 || hasActiveProactiveSchedules();
}

function stopPingLoop() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function ensurePingLoop() {
  if (pingTimer) return;

  pingTimer = setInterval(() => {
    if (manualKeepAliveCount > 0 && Date.now() - manualKeepAliveStartedAt > MAX_MANUAL_ALIVE_MS) {
      manualKeepAliveCount = 0;
      manualKeepAliveStartedAt = 0;
    }

    if (!shouldKeepAlive()) {
      stopPingLoop();
      return;
    }

    sw.registration.active?.postMessage({ type: 'ping' });
  }, PING_INTERVAL) as unknown as number;
}

function refreshKeepAlive() {
  if (shouldKeepAlive()) ensurePingLoop();
  else stopPingLoop();
}

function startKeepAlive() {
  manualKeepAliveCount += 1;
  if (!manualKeepAliveStartedAt) manualKeepAliveStartedAt = Date.now();
  refreshKeepAlive();
}

function stopKeepAlive() {
  if (manualKeepAliveCount > 0) manualKeepAliveCount -= 1;
  if (manualKeepAliveCount === 0) manualKeepAliveStartedAt = 0;
  refreshKeepAlive();
}

async function notifyClients(data: Record<string, any>) {
  const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage(data);
  }
}

function fireProactiveTrigger(charId: string) {
  void notifyClients({ type: 'proactive-trigger', charId });
}

function stopProactive(charId: string) {
  const timer = proactiveTimers.get(charId);
  if (timer) {
    clearInterval(timer);
    proactiveTimers.delete(charId);
  }
  proactiveSchedules.delete(charId);
}

function upsertProactive(config: { charId: string; intervalMs: number }) {
  const prev = proactiveSchedules.get(config.charId);
  const unchanged = prev && prev.intervalMs === config.intervalMs;
  if (unchanged && proactiveTimers.has(config.charId)) return;

  stopProactive(config.charId);
  proactiveSchedules.set(config.charId, config);

  const timer = setInterval(() => fireProactiveTrigger(config.charId), config.intervalMs) as unknown as number;
  proactiveTimers.set(config.charId, timer);
}

function syncProactive(configs: Array<{ charId: string; intervalMs: number }>) {
  const nextIds = new Set((configs || []).map((config) => config.charId));

  for (const charId of Array.from(proactiveSchedules.keys())) {
    if (!nextIds.has(charId)) stopProactive(charId);
  }

  for (const config of configs || []) {
    if (config && config.charId && config.intervalMs > 0) {
      upsertProactive(config);
    }
  }

  refreshKeepAlive();
}

function readPushPayload(event: PushEvent): any | null {
  if (!event.data) return null;

  try {
    return event.data.json();
  } catch {
    try {
      return { message: event.data?.text() };
    } catch {
      return null;
    }
  }
}

function openInboxDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ACTIVE_MSG_DB_NAME, ACTIVE_MSG_DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ACTIVE_MSG_INBOX_STORE)) {
        db.createObjectStore(ACTIVE_MSG_INBOX_STORE, { keyPath: 'messageId' });
      }
    };
  });
}

async function saveIncomingActiveMessage(payload: any) {
  const charId = payload?.metadata?.charId;
  const charName = payload?.contactName || payload?.metadata?.charName || '主动消息';
  const body = String(payload?.message || payload?.body || '').trim();
  const messageId = String(payload?.messageId || `${charId || 'unknown'}-${Date.now()}`);
  const payloadTimestamp = payload?.timestamp;
  const parsedSentAt = payloadTimestamp ? new Date(payloadTimestamp).getTime() : NaN;
  const sentAt = Number.isFinite(parsedSentAt) ? parsedSentAt : Date.now();

  if (!charId || !body) return;

  const db = await openInboxDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ACTIVE_MSG_INBOX_STORE, 'readwrite');
    tx.objectStore(ACTIVE_MSG_INBOX_STORE).put({
      messageId,
      charId,
      charName,
      body,
      avatarUrl: payload?.avatarUrl,
      source: payload?.source,
      messageType: payload?.messageType,
      messageSubtype: payload?.messageSubtype,
      taskId: payload?.taskId ?? null,
      metadata: payload?.metadata || {},
      sentAt,
      receivedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  await notifyClients({
    type: 'active-msg-received',
    charId,
    charName,
    body,
    avatarUrl: payload?.avatarUrl,
    sentAt,
  });
}

sw.addEventListener('push', (event: PushEvent) => {
  const payload = readPushPayload(event);
  if (!payload) return;

  event.waitUntil(saveIncomingActiveMessage(payload));
});

sw.addEventListener('notificationclick', (event: NotificationEvent) => {
  const payload = event.notification.data?.payload || event.notification.data || {};
  const charId = payload?.metadata?.charId || payload?.charId || '';
  event.notification.close();

  event.waitUntil((async () => {
    const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.length > 0) {
      const client = clients[0];
      await client.focus();
      client.postMessage({ type: 'active-msg-open', charId });
      return;
    }

    const openUrl = new URL(sw.registration.scope || sw.location.origin);
    openUrl.searchParams.set('openApp', 'chat');
    if (charId) openUrl.searchParams.set('activeMsgCharId', charId);
    await sw.clients.openWindow(openUrl.toString());
  })());
});

sw.addEventListener('message', (event: ExtendableMessageEvent) => {
  const { type } = event.data || {};

  switch (type) {
    case 'keepalive-start':
      startKeepAlive();
      break;
    case 'keepalive-stop':
      stopKeepAlive();
      break;
    case 'proactive-start':
      if (event.data.config) {
        syncProactive([...proactiveSchedules.values(), event.data.config]);
      }
      break;
    case 'proactive-stop':
      if (event.data.charId) {
        stopProactive(event.data.charId);
        refreshKeepAlive();
      } else {
        syncProactive([]);
      }
      break;
    case 'proactive-sync':
      syncProactive(event.data.configs || []);
      break;
  }
});

sw.addEventListener('install', () => {
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(sw.clients.claim());
});
