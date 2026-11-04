/**
 * Keep-Alive utility — signals the Service Worker to prevent background suspension
 * during long-running AI API calls (especially on mobile / Capacitor).
 *
 * Usage:
 *   import { KeepAlive } from '../utils/keepAlive';
 *
 *   KeepAlive.start();   // before API call
 *   await fetch(...);
 *   KeepAlive.stop();    // after API call completes
 */

import { changeWebUpdateActivity, watchWebUpdates } from './webUpdateSession';
import { recordDatabaseOpen } from './databaseOpenDiagnostics';

let registered = false;
let registering: Promise<void> | null = null;

function ensureRegistered(): Promise<void> {
  if (registered || !('serviceWorker' in navigator)) return Promise.resolve();
  // Startup and a fast first reply share registration instead of issuing it twice.
  if (!registering) registering = register().finally(() => { registering = null; });
  return registering;
}

async function register(): Promise<void> {
  recordDatabaseOpen('sw-requested');
  try {
    const base = import.meta.env.BASE_URL || '/';
    const scriptUrl = base + 'sw-keep-alive.js';
    const reg = await navigator.serviceWorker.register(scriptUrl, { scope: base, updateViaCache: 'none' });
    watchWebUpdates(reg);
    await navigator.serviceWorker.ready;
    registered = true;
    recordDatabaseOpen('sw-ready');
    console.log('[KeepAlive] Service Worker registered', reg.scope);
  } catch (e) {
    recordDatabaseOpen('sw-error', {}, e);
    console.warn('[KeepAlive] SW registration failed, keep-alive disabled:', e);
  }
}

function postToSW(msg: { type: string }) {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
  navigator.serviceWorker.controller.postMessage(msg);
}

export const KeepAlive = {
  /** Register the SW on app startup (idempotent, call early). */
  init: ensureRegistered,

  /** Signal that a long-running request is starting. */
  async start() {
    changeWebUpdateActivity(1);
    await ensureRegistered();
    postToSW({ type: 'keepalive-start' });
  },

  /** Signal that the request has finished. */
  stop() {
    changeWebUpdateActivity(-1);
    postToSW({ type: 'keepalive-stop' });
  },

  /**
   * Force re-register the SW. 调用方 (深度重置订阅) 已经先 unregister 了旧 SW;
   * 这里只负责把内部 `registered` flag 清掉再走一遍 ensureRegistered, 否则
   * 老的 idempotent guard 会以为 "已注册" 直接 return.
   */
  async reregister() {
    registered = false;
    await ensureRegistered();
  },
};
