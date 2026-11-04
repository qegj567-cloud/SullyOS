// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveMsg2GlobalConfig, RealtimeConfig } from '../types';

const client = vi.hoisted(() => ({
  getGlobalConfig: vi.fn(),
  getPushStatus: vi.fn(),
  getCapabilities: vi.fn().mockResolvedValue(null),
  probeWorkerVersion: vi.fn().mockResolvedValue({ state: 'unknown', deployed: null, expected: 'test', autoUpdate: null }),
  probeInstantChatSupport: vi.fn().mockResolvedValue(false),
  getCronTriggerState: vi.fn().mockResolvedValue(null),
}));
vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: client,
  fetchWorkerDiagnostics: vi.fn().mockResolvedValue({ reachable: false, reason: '测试未连接' }),
  fetchWorkerTickReport: vi.fn().mockResolvedValue({ ok: false, reason: '测试未连接' }),
}));
// Opening the form must not contact a deployment service or save fake test credentials.
vi.mock('./cfProvision', () => ({}));
vi.mock('./amsgStateSync', () => ({ isWorkerUrlCleared: () => false }));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { saveGlobalConfig: vi.fn().mockResolvedValue(undefined) },
  maskActiveMsgUserId: (value: string) => value,
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

import ActiveMsgGlobalSettingsModal from '../components/settings/ActiveMsgGlobalSettingsModal';
import { fetchWorkerDiagnostics } from './activeMsgClient';

const initialConfig: ActiveMsg2GlobalConfig = { userId: 'test-user', workerUrl: '' };
const subscribedPush = {
  supported: true,
  permission: 'granted',
  hasSubscription: true,
  vapidConfigured: false,
  transport: 'web-push',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

async function render(open = true) {
  await act(async () => {
    root.render(React.createElement(ActiveMsgGlobalSettingsModal, {
      isOpen: open,
      onClose,
      addToast: vi.fn(),
      realtimeConfig: {} as RealtimeConfig,
    }));
  });
}

async function click(label: string) {
  const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === label);
  expect(button, `Missing button: ${label}`).toBeTruthy();
  await act(async () => { button!.click(); });
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  client.getGlobalConfig.mockReset().mockResolvedValue(initialConfig);
  client.getPushStatus.mockReset().mockResolvedValue(subscribedPush);
  vi.mocked(fetchWorkerDiagnostics).mockReset().mockResolvedValue({ reachable: false, reason: '测试未连接' });
  onClose.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.useRealTimers();
});

describe('主动消息 2.0 配置入口', () => {
  it('本地配置还没返回时先显示可关闭的加载面板', async () => {
    client.getGlobalConfig.mockReturnValue(new Promise(() => {}));
    await render();
    expect(host.textContent).toContain('主动消息 2.0');
    expect(host.textContent).toContain('正在读取本地配置');
    expect(host.querySelector('input')).toBeNull();
    await click('关闭');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('推送检查一直没返回也能编辑配置', async () => {
    client.getPushStatus.mockReturnValue(new Promise(() => {}));
    await render();
    expect(host.querySelector('input[placeholder="https://amsg.你的账号.workers.dev"]')).not.toBeNull();
    expect(host.textContent).toContain('检查中');
  });

  it('推送尚未查明时不把已连接的设备说成没有推送权限', async () => {
    client.getGlobalConfig.mockResolvedValue({ ...initialConfig, workerUrl: 'https://worker.invalid', initializedAt: 1 });
    client.getPushStatus.mockReturnValue(new Promise(() => {}));
    vi.mocked(fetchWorkerDiagnostics).mockResolvedValue({
      reachable: true,
      report: {
        config: { ok: true, missing: [], message: '配置齐全', warnings: [] },
        storage: {
          reachable: true, schemaReady: true, missingTables: [], missingColumns: [],
          pushSubscriptionRegistered: true,
          pushDelivery: { probed: true, gone: null, registeredAtMs: 1 },
          pendingTasks: 0, overdueTasks: 0, oldestOverdueMinutes: null,
        },
        tick: 'healthy',
        server: { version: '2.6.0-next.36', featureCount: 27 },
        vapidPublicKey: 'test-public-key',
      },
    });
    await render();
    expect(host.textContent).not.toContain('先开启通知与推送：');
    expect(host.textContent).not.toContain('有问题');
    expect(host.textContent).toContain('正在检查推送状态');
  });

  it('推送检查失败后保留配置，并能单独重试', async () => {
    client.getPushStatus.mockRejectedValueOnce(new Error('Push service failed'));
    await render();
    expect(host.textContent).toContain('推送状态读取失败');
    expect(host.querySelector('input')).not.toBeNull();
    await click('重试推送检查');
    expect(host.textContent).not.toContain('推送状态读取失败');
    expect(host.textContent).toContain('已开启');
  });

  it('推送检查超时后可重试，迟到的旧结果不覆盖新状态', async () => {
    const pending = deferred<typeof subscribedPush>();
    client.getPushStatus.mockReturnValueOnce(pending.promise);
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(host.textContent).toContain('推送状态检查超时');
    await click('重试推送检查');
    await act(async () => { pending.resolve({ ...subscribedPush, hasSubscription: false }); });
    expect(host.textContent).toContain('已开启');
    expect(host.textContent).not.toContain('推送状态检查超时');
  });

  it('本地配置读取失败时显示重试，不把空配置当成存档', async () => {
    client.getGlobalConfig.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
    await render();
    expect(host.textContent).toContain('本地配置读取失败');
    expect(host.querySelector('input')).toBeNull();
    await click('重试读取配置');
    expect(host.querySelector('input')).not.toBeNull();
    expect(host.textContent).not.toContain('本地配置读取失败');
  });

  it('本地配置读取超时后可重试，迟到的旧配置不会替换新配置', async () => {
    const pending = deferred<ActiveMsg2GlobalConfig>();
    client.getGlobalConfig.mockReturnValueOnce(pending.promise);
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(host.textContent).toContain('本地配置读取超时');
    await click('重试读取配置');
    await act(async () => { pending.resolve({ userId: 'old', workerUrl: 'https://old.invalid' }); });
    const input = host.querySelector<HTMLInputElement>('input[placeholder="https://amsg.你的账号.workers.dev"]');
    expect(input?.value).toBe('');
  });

  it('关闭再打开时不会接收上次打开的迟到配置', async () => {
    const pending = deferred<ActiveMsg2GlobalConfig>();
    client.getGlobalConfig.mockReturnValueOnce(pending.promise);
    await render();
    await render(false);
    await render();
    await act(async () => { pending.resolve({ userId: 'old', workerUrl: 'https://old.invalid' }); });
    const input = host.querySelector<HTMLInputElement>('input[placeholder="https://amsg.你的账号.workers.dev"]');
    expect(input?.value).toBe('');
  });

  it('关闭再打开时不会接收上次打开的迟到推送状态', async () => {
    const pending = deferred<typeof subscribedPush>();
    client.getPushStatus.mockReturnValueOnce(pending.promise);
    await render();
    await render(false);
    await render();
    await act(async () => { pending.resolve({ ...subscribedPush, hasSubscription: false }); });
    expect(host.textContent).toContain('已开启');
  });

  it('重试推送检查不会重新载入并替换当前表单', async () => {
    client.getPushStatus.mockRejectedValueOnce(new Error('Push service failed'));
    await render();
    client.getGlobalConfig.mockResolvedValue({ userId: 'other', workerUrl: 'https://other.invalid' });
    await click('重试推送检查');
    const input = host.querySelector<HTMLInputElement>('input[placeholder="https://amsg.你的账号.workers.dev"]');
    expect(input?.value).toBe('');
    expect(host.textContent).toContain('已开启');
  });
});
