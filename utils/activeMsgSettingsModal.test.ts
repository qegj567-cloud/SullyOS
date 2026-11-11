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
vi.mock('./activeMsgStore', async () => ({
  ActiveMsgStore: { saveGlobalConfig: vi.fn().mockResolvedValue(undefined) },
  isInstantChatSwitchedOn: (await vi.importActual<typeof import('./activeMsgStore')>('./activeMsgStore')).isInstantChatSwitchedOn,
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

/** 没连上后端时面板先摆引导；要看表单的用例从介绍页直接跳到全部设置。 */
const skipGuide = () => click('跳过引导，直接看全部设置');

/** 点开面板里收着的一块（标题行的按钮后面还跟着状态和「展开」，所以按开头匹配）。 */
async function expand(title: string) {
  const button = Array.from(host.querySelectorAll('button[aria-expanded="false"]'))
    .find((item) => item.textContent?.startsWith(title)) as HTMLButtonElement | undefined;
  expect(button, `Missing section: ${title}`).toBeTruthy();
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
    await skipGuide();
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
    await expand('即时对话');
    expect(host.textContent).not.toContain('先开启通知与推送：');
    expect(host.textContent).not.toContain('有问题');
    expect(host.textContent).toContain('正在检查推送状态');
  });

  it('推送检查失败后保留配置，并能单独重试', async () => {
    client.getPushStatus.mockRejectedValueOnce(new Error('Push service failed'));
    await render();
    await skipGuide();
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
    await skipGuide();
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
    await skipGuide();
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
    await skipGuide();
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
    await skipGuide();
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
    await skipGuide();
    await act(async () => { pending.resolve({ ...subscribedPush, hasSubscription: false }); });
    expect(host.textContent).toContain('已开启');
  });

  it('重试推送检查不会重新载入并替换当前表单', async () => {
    client.getPushStatus.mockRejectedValueOnce(new Error('Push service failed'));
    await render();
    await skipGuide();
    client.getGlobalConfig.mockResolvedValue({ userId: 'other', workerUrl: 'https://other.invalid' });
    await click('重试推送检查');
    const input = host.querySelector<HTMLInputElement>('input[placeholder="https://amsg.你的账号.workers.dev"]');
    expect(input?.value).toBe('');
    expect(host.textContent).toContain('已开启');
  });
});

describe('主动消息 2.0 引导与面板', () => {
  const connected: ActiveMsg2GlobalConfig = { ...initialConfig, workerUrl: 'https://worker.invalid', initializedAt: 1 };
  const button = (label: string) => Array.from(host.querySelectorAll('button'))
    .find((item) => item.textContent === label) as HTMLButtonElement | undefined;

  it('没连上后端的人先看到介绍，点开始才出现配置，没装好不放行到下一步', async () => {
    await render();
    expect(host.textContent).toContain('App 关着，TA 也能来找你');
    expect(host.querySelector('input')).toBeNull();
    await click('开始配置');
    expect(host.textContent).toContain('第 1 步，共 4 步');
    expect(host.querySelector('input[placeholder="粘贴 Cloudflare API Token"]')).not.toBeNull();
    // 地址和密钥那几栏属于手动配置，没选这条路时不摆出来。
    expect(host.querySelector('input[placeholder="https://amsg.你的账号.workers.dev"]')).toBeNull();
    expect(button('装好后继续')?.disabled).toBe(true);
  });

  it('已经连上的人直接进面板，配好的几块都收着', async () => {
    client.getGlobalConfig.mockResolvedValue(connected);
    // 默认的探测结果是「端点不存在」，那会被当成 Worker 过旧、把后端那块弹开；这里要的是一台没毛病的。
    client.getCapabilities.mockRejectedValueOnce(new Error('offline'));
    await render();
    expect(host.textContent).not.toContain('App 关着，TA 也能来找你');
    expect(host.textContent).toContain('已连接');
    expect(host.querySelector('input')).toBeNull();
    await expand('后端 Worker');
    expect(host.querySelector('input[placeholder="https://amsg.你的账号.workers.dev"]')).not.toBeNull();
  });

  it('推送没开时那一块自己展开', async () => {
    client.getGlobalConfig.mockResolvedValue(connected);
    client.getPushStatus.mockResolvedValue({ ...subscribedPush, hasSubscription: false });
    await render();
    expect(button('开启通知与推送')).toBeTruthy();
  });

  it('引导说清即时对话不是秒回，最后单独一步讲给角色开启，走完回到面板', async () => {
    client.getGlobalConfig.mockResolvedValue(connected);
    await render();
    await click('这个功能是做什么的？重看介绍');
    await click('开始配置');
    expect(host.textContent).toContain('后端已经连上了');
    await click('下一步');
    await click('下一步');
    expect(host.textContent).toContain('「即时」不是秒回');
    expect(host.textContent).toContain('杀后台');
    await click('下一步');
    expect(host.textContent).toContain('第 4 步，共 4 步');
    expect(host.textContent).toContain('在每个角色那里单独打开');
    expect(host.querySelector('input')).toBeNull();
    await click('完成');
    expect(host.textContent).toContain('重看介绍');
  });
});
