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
const deployment = vi.hoisted(() => ({ source: 'official' as 'official' | 'unofficial' | 'unknown' }));
vi.mock('./deploymentSource', async (importOriginal) => ({
  ...await importOriginal<typeof import('./deploymentSource')>(),
  detectDeploymentSource: async () => deployment.source,
}));

import ActiveMsgGlobalSettingsModal from '../components/settings/ActiveMsgGlobalSettingsModal';
import { fetchWorkerDiagnostics } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';

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

  it('共享密钥默认收着，点开才有输入框和「随机」', async () => {
    client.getGlobalConfig.mockResolvedValue({ ...initialConfig, serverToken: 'deployed-token' });
    await render();
    await skipGuide();
    expect(host.querySelector('input[placeholder="https://amsg.你的账号.workers.dev"]')).not.toBeNull();
    expect(host.querySelector('input[placeholder="worker 配了 AMSG_SERVER_TOKEN 才需要填"]')).toBeNull();
    expect(Array.from(host.querySelectorAll('button')).some((item) => item.textContent === '随机')).toBe(false);
    expect(host.textContent).toContain('共享密钥 · 已填好');
    await expand('共享密钥');
    expect(host.querySelector<HTMLInputElement>('input[placeholder="worker 配了 AMSG_SERVER_TOKEN 才需要填"]')?.value).toBe('deployed-token');
    expect(Array.from(host.querySelectorAll('button')).some((item) => item.textContent === '随机')).toBe(true);
  });

  // 中转看得到明文，打开前必须读完数据边界；倒数没完、点了取消都不能存盘
  it('打开中转要先读完 5 秒提醒，确认后才存盘；关掉直接生效', async () => {
    const save = vi.mocked(ActiveMsgStore.saveGlobalConfig);
    save.mockClear();
    await render();
    await skipGuide();
    const relayBox = () => Array.from(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      .find((item) => item.closest('label')?.textContent?.includes('大陆连接优化'));
    const confirmButton = () => Array.from(host.querySelectorAll('button'))
      .find((item) => item.textContent?.startsWith('我已了解，打开'));
    const tick = async (seconds: number) => {
      for (let i = 0; i < seconds; i += 1) await act(async () => { vi.advanceTimersByTime(1000); });
    };

    expect(relayBox()?.checked).toBe(false);
    await act(async () => { relayBox()!.click(); });
    expect(host.textContent).toContain('维护者自费搭的');
    await click('先不开');
    expect(host.textContent).not.toContain('维护者自费搭的');
    expect(relayBox()?.checked).toBe(false);

    await act(async () => { relayBox()!.click(); });
    // 滥用后果必须写在打开前那道提醒里
    expect(host.textContent).toContain('移出社区');
    expect(confirmButton()?.disabled).toBe(true);
    await tick(4);
    expect(confirmButton()?.disabled).toBe(true);
    expect(relayBox()?.checked).toBe(false);
    await tick(1);
    expect(confirmButton()?.disabled).toBe(false);
    // 打开面板时本来就会存一次别的字段，这里只看有没有提前写入中转开关
    expect(save.mock.calls.some(([updates]) => 'useRelay' in updates)).toBe(false);

    await act(async () => { confirmButton()!.click(); });
    expect(save).toHaveBeenCalledWith({ useRelay: true });
    expect(relayBox()?.checked).toBe(true);

    await act(async () => { relayBox()!.click(); });
    expect(save).toHaveBeenLastCalledWith({ useRelay: false });
    expect(relayBox()?.checked).toBe(false);
    expect(host.textContent).not.toContain('维护者自费搭的');
  });

  it('非官方版本中转开关不能点，并说明原因', async () => {
    const { checkRelayDeployment } = await import('./amsgRelay');
    deployment.source = 'unofficial';
    await checkRelayDeployment();
    try {
      await render();
      await skipGuide();
      const box = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
        .find((item) => item.closest('label')?.textContent?.includes('大陆连接优化'));
      expect(box?.disabled).toBe(true);
      expect(host.textContent).toContain('非官方版本不能使用官方中转');
    } finally {
      deployment.source = 'official';
      await checkRelayDeployment();
    }
  });

  it('开了中转才出现令牌栏：没填时提示仍是直连，填了存盘并查近 30 天用量', async () => {
    const save = vi.mocked(ActiveMsgStore.saveGlobalConfig);
    save.mockClear();
    const usage = { up: 1024 * 1024 * 1.2, down: 1024 * 1024 * 3.4, requests: 128 };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ today: usage, last7: usage, last30: usage, issuedDay: '2026-11-01' })));
    vi.stubGlobal('fetch', fetchMock);
    const tokenInput = () => host.querySelector<HTMLInputElement>('input[placeholder="在 SullyOS 的 Discord 群里发 /中转令牌 领取"]');
    try {
      client.getGlobalConfig.mockResolvedValue({ ...initialConfig, workerUrl: 'https://amsg.example.workers.dev' });
      await render();
      await skipGuide();
      expect(tokenInput()).toBeNull();
      await render(false);

      client.getGlobalConfig.mockResolvedValue({ ...initialConfig, workerUrl: 'https://amsg.example.workers.dev', useRelay: true });
      await render();
      await skipGuide();
      expect(tokenInput()).not.toBeNull();
      expect(host.textContent).toContain('填好令牌后才会走中转，现在仍是直连');

      const token = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
      await act(async () => {
        const input = tokenInput()!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ` ${token} `);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(save).toHaveBeenCalledWith({ relayToken: token });
      expect(host.textContent).not.toContain('填好令牌后才会走中转');
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(fetchMock).toHaveBeenCalledWith(`https://amsg-relay.friedsully.com/t/${token}/_usage`);
      expect(host.textContent).toContain('近 30 天：上传 1.2 MB · 下载 3.4 MB · 128 次请求');
    } finally {
      vi.unstubAllGlobals();
    }
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
