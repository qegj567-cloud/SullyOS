// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const WORKER = 'https://amsg.example.workers.dev';
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { getGlobalConfig: async () => ({ workerUrl: WORKER, enabled: true, initializedAt: 1 }) },
}));

import AmsgRescueAlert from '../components/AmsgRescueAlert';
import { handleLocalBack } from './localBackHandlers';
import {
  getRescueAlertSnapshot,
  recordRescueFromConfigCheck,
  requestRescueAlertDetails,
  resetRescueAlertMemoryForTest,
  setRescueAlertWorker,
} from './amsgRescueAlert';

let root: Root;
let host: HTMLDivElement;
let visibility: DocumentVisibilityState = 'visible';

const dialog = () => document.body.querySelector('dialog');
const confirmButton = () => dialog()?.querySelector('button') as HTMLButtonElement | null;
const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
};
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

const openAlert = async () => {
  const now = Date.now();
  recordRescueFromConfigCheck({
    success: true,
    data: {
      rescue: {
        active: true,
        episode: {
          id: String(now), firstSeenAt: now, lastSeenAt: now, endedAt: null,
          exportCount: 1, lastExportAt: now, itemReads: 12, lastReadAt: now,
          failedAttempts: 3, pushedAt: now, pushTargets: 2, pushDelivered: 1,
        },
      },
    },
  }, WORKER, now);
  await act(async () => { root.render(React.createElement(AmsgRescueAlert)); });
  // 让挂载时读配置那一下落地。
  await act(async () => { await Promise.resolve(); });
};

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  localStorage.clear();
  resetRescueAlertMemoryForTest();
  setRescueAlertWorker(WORKER);
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  localStorage.clear();
  resetRescueAlertMemoryForTest();
});

/**
 * 回归守卫：救援警告是强制的。返回键（浏览器 / Android / 悬浮球都走 handleLocalBack）、
 * Esc（dialog 的 cancel）都关不掉；确认按钮要读满 10 秒才能点。
 */
it('强制弹出：返回和 Esc 关不掉，10 秒后才能确认，确认后收起', async () => {
  await openAlert();
  expect(dialog()?.hasAttribute('open')).toBe(true);
  expect(dialog()?.textContent).toContain('救援模式（RESCUE）');
  expect(dialog()?.textContent).toContain('2 台设备，成功 1 台');
  expect(confirmButton()?.disabled).toBe(true);
  expect(confirmButton()?.textContent).toBe('请阅读（10）');

  expect(handleLocalBack()).toBe(true);
  const cancel = new Event('cancel', { cancelable: true });
  act(() => { dialog()!.dispatchEvent(cancel); });
  expect(cancel.defaultPrevented).toBe(true);
  expect(dialog()?.hasAttribute('open')).toBe(true);

  // 被浏览器强行关掉也会马上重新打开。
  act(() => { dialog()!.close(); });
  advance(0);
  expect(dialog()?.hasAttribute('open')).toBe(true);

  advance(9_000);
  expect(confirmButton()?.disabled).toBe(true);
  advance(1_250);
  expect(confirmButton()?.disabled).toBe(false);
  expect(confirmButton()?.textContent).toBe('我已阅读并知晓');

  act(() => { confirmButton()!.click(); });
  expect(dialog()).toBeNull();
  expect(getRescueAlertSnapshot().shouldAlert).toBe(false);
  expect(getRescueAlertSnapshot().due).toBe(true);
  // 关掉之后返回键交还给底下的 App。
  expect(handleLocalBack()).toBe(false);
});

it('页面在后台时倒计时暂停，回到前台接着数', async () => {
  await openAlert();
  advance(4_000);
  setVisibility('hidden');
  advance(60_000);
  expect(confirmButton()?.disabled).toBe(true);
  setVisibility('visible');
  advance(5_000);
  expect(confirmButton()?.disabled).toBe(true);
  advance(1_250);
  expect(confirmButton()?.disabled).toBe(false);
});

it('设置页「查看详情」重新打开时同样要从头读 10 秒', async () => {
  await openAlert();
  advance(10_500);
  act(() => { confirmButton()!.click(); });
  expect(dialog()).toBeNull();

  act(() => { requestRescueAlertDetails(); });
  expect(dialog()?.hasAttribute('open')).toBe(true);
  expect(confirmButton()?.disabled).toBe(true);
  advance(10_500);
  expect(confirmButton()?.disabled).toBe(false);
});
