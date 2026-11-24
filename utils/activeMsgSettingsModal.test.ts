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
  reconcilePushSubscription: vi.fn().mockResolvedValue(undefined),
  connect: vi.fn(),
}));
vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: client,
  readAmsgFailKind: () => 'network',
  fetchWorkerDiagnostics: vi.fn().mockResolvedValue({ reachable: false, reason: '测试未连接' }),
  fetchWorkerTickReport: vi.fn().mockResolvedValue({ ok: false, reason: '测试未连接' }),
}));
// Opening the form must not contact a deployment service or save fake test credentials.
const provision = vi.hoisted(() => ({ deploy: vi.fn(), discover: vi.fn(), replacement: vi.fn() }));
vi.mock('./cfProvision', () => ({ AMSG_SCRIPT_NAME: 'sullyos-amsg', provisionAmsgBackend: provision.deploy, discoverAmsgBackends: provision.discover, createAmsgReplacementPlan: provision.replacement }));
vi.mock('./amsgStateSync', () => ({ isWorkerUrlCleared: () => false }));
vi.mock('./activeMsgStore', async () => ({
  ActiveMsgStore: { saveGlobalConfig: vi.fn().mockResolvedValue(undefined), saveReplacementPlan: vi.fn().mockResolvedValue(undefined), getReplacementHint: vi.fn().mockResolvedValue(null) },
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

async function render(open = true, workspaceSection?: 'features' | 'overview') {
  await act(async () => {
    root.render(React.createElement(ActiveMsgGlobalSettingsModal, {
      isOpen: open,
      onClose,
      addToast: vi.fn(),
      realtimeConfig: {} as RealtimeConfig,
      workspaceSection,
    }));
  });
}

async function click(label: string) {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input[type="radio"]')).find((item) => item.textContent === label || item.getAttribute('aria-label') === label);
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
  client.reconcilePushSubscription.mockClear();
  client.connect.mockReset().mockResolvedValue({ warnings: [] });
  provision.deploy.mockReset(); provision.discover.mockReset();
  provision.replacement.mockReset();
  vi.mocked(ActiveMsgStore.saveGlobalConfig).mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('主动消息 2.0 配置入口', () => {
  it.each([initialConfig, { ...initialConfig, workerUrl: 'https://worker.invalid', initializedAt: 1 }])('未连上或已经配好的用户都能进入重配选项，取消不改配置', async (config) => {
    client.getGlobalConfig.mockResolvedValue(config);
    await render(true, 'features');
    await click('重新配置');
    expect(host.querySelector('[aria-label="重新配置向导"]')).not.toBeNull();
    await click('后台也重新部署');
    expect(host.querySelector('textarea[aria-label="粘贴连接码"]')).toBeNull();
    expect([...host.querySelectorAll('details')].find(item => item.textContent?.includes('查找要重新部署的后台'))?.open).toBe(true);
    const { handleLocalBack } = await import('./localBackHandlers');
    await act(async () => { expect(handleLocalBack()).toBe(true); });
    expect(host.querySelector('[aria-label="重新配置向导"]')).not.toBeNull();
    await click('取消重新配置');
    expect(host.querySelector('[aria-label="重新配置向导"]')).toBeNull();
    expect(ActiveMsgStore.saveGlobalConfig).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
    expect(provision.deploy).not.toHaveBeenCalled();
    expect(provision.discover).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
  it('重新配置必须验证当前连接，旧成功标记和失败尝试都不能放行', async () => {
    client.getGlobalConfig.mockResolvedValue({ ...initialConfig, workerUrl: 'https://worker.invalid', initializedAt: 1 });
    await render(true, 'features'); await click('重新配置'); await click('保留后台，重新配置');
    const continueButton = () => [...host.querySelectorAll('button')].find(button => ['验证后继续', '下一步'].includes(button.textContent || ''))!;
    expect(continueButton().disabled).toBe(true);
    expect(ActiveMsgStore.saveGlobalConfig).not.toHaveBeenCalled();
    client.connect.mockRejectedValueOnce(new Error('密钥不匹配'));
    await click('重新连接并验证'); expect(continueButton().disabled).toBe(true);
    await click('重新连接并验证'); expect(continueButton().disabled).toBe(false);
    await click('下一步'); expect(host.textContent).toContain('让消息能送到手机上');
    await click('上一步');
    const address = host.querySelector<HTMLInputElement>('input[placeholder="https://amsg.你的账号.workers.dev"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(address, 'https://changed.invalid');
      address.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(continueButton().disabled).toBe(true);
    expect(provision.deploy).not.toHaveBeenCalled();
  });
  it('已连接时重新部署失败仍显示重试和禁用的下一步，不误用旧连接放行', async () => {
    client.getGlobalConfig.mockResolvedValue({ ...initialConfig, workerUrl: 'https://worker.invalid', initializedAt: 1 });
    const backend = { account: { id: 'chosen-account', name: '指定账号' }, scriptName: 'sullyos-amsg', urls: ['https://worker.invalid'] };
    provision.discover.mockResolvedValue({ backends: [backend], warnings: [] });
    provision.replacement.mockResolvedValue({ accountId: 'chosen-account', scriptName: 'sullyos-amsg', databaseName: 'fixture-new-db', secrets: {} });
    provision.deploy.mockResolvedValue({ ok: false, code: 'CF_ERROR', message: '模拟部署失败' });
    await render(true, 'features'); await click('重新配置'); await click('后台也重新部署');
    const token = host.querySelector<HTMLInputElement>('input[placeholder="粘贴 Cloudflare API Token"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(token, 'fixture-cf-token');
      token.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('查找已有后台'); await click('重新部署，不接续旧数据');
    expect(provision.deploy).not.toHaveBeenCalled();
    await click('确认重新部署');
    expect(host.textContent).toContain('模拟部署失败');
    expect(host.querySelector('.amsg-deploy-form')).not.toBeNull();
    expect([...host.querySelectorAll('button')].find(button => button.textContent === '验证后继续')?.disabled).toBe(true);
    expect(ActiveMsgStore.saveGlobalConfig).not.toHaveBeenCalled();
    await click('开始部署'); expect(provision.deploy).toHaveBeenCalledTimes(2);
    expect(provision.replacement).toHaveBeenCalledOnce();
  });
  it('确认重新部署后沿用 Token 和指定后台，失败重试复用同一部署计划', async () => {
    const backend = { account: { id: 'chosen-account', name: '指定账号' }, scriptName: 'sullyos-amsg', urls: [] };
    const plan = { accountId: backend.account.id, scriptName: backend.scriptName, databaseName: 'fixture-new-db', secrets: {} };
    provision.deploy.mockResolvedValueOnce({ ok: false, code: 'SCRIPT_EXISTS', message: '已有部署' }).mockResolvedValue({ ok: false, code: 'CF_ERROR', message: '模拟上传失败，请重试' });
    provision.discover.mockResolvedValue({ backends: [backend], warnings: [] }); provision.replacement.mockResolvedValue(plan);
    await render(true, 'features');
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.includes('第一次使用'))!.click());
    const token = host.querySelector<HTMLInputElement>('.amsg-deploy-form input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(token, 'fixture-cf-token');
      token.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('开始部署'); await click('重新部署，不接续旧数据');
    expect(provision.deploy).toHaveBeenCalledOnce(); expect(provision.replacement).not.toHaveBeenCalled();
    await click('确认重新部署');
    expect(provision.replacement).toHaveBeenCalledWith(backend);
    expect(provision.deploy).toHaveBeenLastCalledWith(expect.objectContaining({ token: 'fixture-cf-token', accountId: 'chosen-account', scriptName: 'sullyos-amsg', replacement: plan, resetExistingDatabase: false }));
    expect(host.textContent).toContain('模拟上传失败');
    await click('开始部署');
    expect(provision.deploy).toHaveBeenCalledTimes(3); expect(provision.replacement).toHaveBeenCalledOnce();
    expect(provision.deploy.mock.calls[2][0].replacement).toBe(plan);
    expect(ActiveMsgStore.saveGlobalConfig).not.toHaveBeenCalled();
  });
  it('已有部署自动带上 Token 进入查找，不保存连接或重新部署', async () => {
    const lookup = deferred<{ backends: never[]; warnings: string[] }>();
    provision.deploy.mockResolvedValue({ ok: false, code: 'SCRIPT_EXISTS', message: '已有部署' });
    provision.discover.mockReturnValue(lookup.promise);
    await render(true, 'features');
    const start = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('第一次使用'))!;
    await act(async () => start.click());
    const token = host.querySelector<HTMLInputElement>('.amsg-deploy-form input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(token, '  fixture-cf-token  ');
      token.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('开始部署');
    expect(provision.deploy).toHaveBeenCalledOnce();
    expect(provision.discover).toHaveBeenCalledOnce();
    expect(provision.discover).toHaveBeenCalledWith('fixture-cf-token', 'sullyos-amsg');
    expect(host.querySelector('.amsg-deploy-form')).toBeNull();
    const discovery = [...host.querySelectorAll('details')].find(element => element.querySelector('summary')?.textContent?.includes('查找已有部署'))!;
    expect(discovery.open).toBe(true);
    expect(discovery.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('fixture-cf-token');
    expect(discovery.textContent).toContain('正在查找');
    await act(async () => lookup.resolve({ backends: [], warnings: [] }));
    expect(discovery.textContent).toContain('没有找到可确认的后台');
    expect(discovery.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('fixture-cf-token');
    expect(ActiveMsgStore.saveGlobalConfig).not.toHaveBeenCalled();
    expect(client.reconcilePushSubscription).not.toHaveBeenCalled();
  });

  it('普通部署错误留在原页，不因报错文案提到已有后台而自动查找', async () => {
    provision.deploy.mockResolvedValue({ ok: false, code: 'CF_ERROR', message: '无法确认账号里是否已有后台，请稍后重试。' });
    await render(true, 'features');
    const start = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('第一次使用'))!;
    await act(async () => start.click());
    const token = host.querySelector<HTMLInputElement>('.amsg-deploy-form input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(token, 'fixture-cf-token');
      token.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('开始部署');
    expect(provision.discover).not.toHaveBeenCalled();
    expect(host.querySelector('.amsg-deploy-form')).not.toBeNull();
    expect(token.value).toBe('fixture-cf-token');
    expect(host.textContent).toContain('无法确认账号里是否已有后台');
  });

  it('APK 通道已连接但系统权限关闭时，摘要提示待允许通知', async () => {
    client.getGlobalConfig.mockResolvedValue({ ...initialConfig, workerUrl: 'https://worker.invalid', initializedAt: 1 });
    client.getPushStatus.mockResolvedValue({ ...subscribedPush, transport: 'unified-push', permission: 'denied' });
    await render();
    expect(host.textContent).toContain('已连接 · 待允许通知');
    await click('通知设置');
    expect(host.textContent).toContain('ntfy（UnifiedPush）');
  });

  it('APK 将 ntfy 显示为第三方并禁用系统推送，打开或点分类不改现有通道', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
    client.getGlobalConfig.mockResolvedValue({ ...initialConfig, workerUrl: 'https://worker.invalid', initializedAt: 1, pushMode: 'web-push' });
    client.getPushStatus.mockResolvedValue({ ...subscribedPush, transport: 'unified-push' });
    await render(); await click('通知设置');
    const system = host.querySelector<HTMLInputElement>('input[aria-label="系统推送"]')!;
    expect(system.disabled).toBe(true);
    expect(system.checked).toBe(false);
    expect(host.querySelectorAll('input[type="radio"]:checked')).toHaveLength(1);
    expect(host.textContent).toContain('当前为 App 版本');
    expect(host.querySelector<HTMLSelectElement>('select')?.value).toBe('ntfy');
    await click('第三方推送 App');
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(client.reconcilePushSubscription).not.toHaveBeenCalled();
    for (const [saved] of vi.mocked(ActiveMsgStore.saveGlobalConfig).mock.calls) expect(saved.pushMode).not.toBe('third-party');
    expect(host.querySelector<HTMLSelectElement>('select')?.value).toBe('ntfy');
  });

  it('APK 已选 Bark 时仍保留它，明确切回 ntfy 才复用原 UnifiedPush 路径', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
    client.getGlobalConfig.mockResolvedValue({ ...initialConfig, workerUrl: 'https://worker.invalid', initializedAt: 1, pushMode: 'third-party', thirdPartyPush: { provider: 'bark', token: 'fixture-bark-key' } });
    client.getPushStatus.mockResolvedValue({ ...subscribedPush, transport: 'third-party', thirdPartyProvider: 'bark' });
    await render(); await click('通知设置');
    const selector = host.querySelector<HTMLSelectElement>('select')!;
    expect(selector.value).toBe('bark');
    expect(client.reconcilePushSubscription).not.toHaveBeenCalled();
    await act(async () => { selector.value = 'ntfy'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(ActiveMsgStore.saveGlobalConfig).toHaveBeenLastCalledWith(expect.objectContaining({ pushMode: 'web-push', thirdPartyPush: { provider: 'bark', token: 'fixture-bark-key' } }));
    expect(client.reconcilePushSubscription).toHaveBeenCalledOnce();
    expect(selector.value).toBe('ntfy');
    await act(async () => { selector.value = 'wxpusher'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(ActiveMsgStore.saveGlobalConfig).toHaveBeenLastCalledWith(expect.objectContaining({ pushMode: 'third-party', thirdPartyPush: expect.objectContaining({ provider: 'wxpusher' }) }));
  });

  it('本地配置还没返回时先显示可关闭的加载面板', async () => {
    client.getGlobalConfig.mockReturnValue(new Promise(() => {}));
    await render();
    expect(host.textContent).toContain('主动消息 2.0');
    expect(host.textContent).toContain('正在读取本地配置');
    expect(host.querySelector('input')).toBeNull();
    await click('返回');
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
    await click('云端生成');
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
  const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input[type="radio"]'))
    .find((item) => item.textContent === label || item.getAttribute('aria-label') === label);

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

  it('已经连上的人进入六个横向分区，切换只展示当前分区', async () => {
    client.getGlobalConfig.mockResolvedValue(connected);
    // 默认的探测结果是「端点不存在」，那会被当成 Worker 过旧、把后端那块弹开；这里要的是一台没毛病的。
    client.getCapabilities.mockRejectedValueOnce(new Error('offline'));
    await render();
    expect(host.textContent).not.toContain('App 关着，TA 也能来找你');
    expect(host.textContent).toContain('已连接');
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(6);
    expect(host.querySelector('input[placeholder="https://amsg.你的账号.workers.dev"]')).not.toBeNull();
    await click('数据去向');
    expect(host.querySelector('input')).toBeNull();
    expect(host.textContent).toContain('数据存在哪儿');
    await click('后端连接');
    expect(host.querySelector<HTMLInputElement>('input[placeholder="https://amsg.你的账号.workers.dev"]')?.value).toBe(connected.workerUrl);
  });

  it('推送没开时标记通知分区，但不会打断当前编辑', async () => {
    client.getGlobalConfig.mockResolvedValue(connected);
    client.getPushStatus.mockResolvedValue({ ...subscribedPush, hasSubscription: false });
    await render();
    expect(button('通知设置')?.querySelector('.amsg-tab-attention')).not.toBeNull();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('后端连接');
    await click('通知设置');
    expect(button('开启通知与推送')).toBeTruthy();
  });

  it.each(['web-push', 'unified-push'])('%s 使用对应平台入口，不自动迁移已有配置', async (transport) => {
    const save = vi.mocked(ActiveMsgStore.saveGlobalConfig);
    save.mockClear();
    client.getGlobalConfig.mockResolvedValue({ ...connected, pushMode: 'web-push' });
    client.getPushStatus.mockResolvedValue({
      ...subscribedPush, transport, hasSubscription: false,
      needsDistributor: transport === 'unified-push',
      detail: '测试用传输状态',
    });
    await render();
    await click('通知设置');
    const native = transport === 'unified-push';
    expect(button('系统推送')?.disabled).toBe(native);
    expect(button('第三方推送 App')).toBeTruthy();
    expect(button(native ? '连接 ntfy 并开启通知' : '开启通知与推送')).toBeTruthy();
    expect(host.textContent).toContain('测试用传输状态');
    expect(Boolean(host.querySelector('a[href="https://docs.ntfy.sh/subscribe/phone/"]'))).toBe(native);
    expect(save.mock.calls.some(([updates]) => 'pushMode' in updates || 'thirdPartyPush' in updates)).toBe(false);

    await click('第三方推送 App');
    if (native) {
      expect(save.mock.calls.some(([updates]) => 'pushMode' in updates)).toBe(false);
      const selector = host.querySelector<HTMLSelectElement>('select')!;
      await act(async () => { selector.value = 'wxpusher'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
    }
    expect(host.textContent).toContain('WxPusher（推荐）');
    expect(host.textContent).toContain('Bark（支持角色头像）');
    expect(host.textContent).toContain('MeoW（纯血鸿蒙备用）');
    expect(button('保存并登记推送')).toBeTruthy();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      pushMode: 'third-party', thirdPartyPush: { provider: 'wxpusher', token: '' },
    }));
  });

  it('打开已有第三方配置不覆盖服务商或凭据', async () => {
    const save = vi.mocked(ActiveMsgStore.saveGlobalConfig);
    save.mockClear();
    client.getGlobalConfig.mockResolvedValue({
      ...connected, pushMode: 'third-party', thirdPartyPush: { provider: 'bark', token: 'fixture-key' },
    });
    client.getPushStatus.mockResolvedValue({ ...subscribedPush, transport: 'third-party', hasSubscription: false });
    await render();
    await click('通知设置');
    expect(host.querySelector<HTMLInputElement>('input[placeholder*="AbCdEfGh"]')?.value).toBe('fixture-key');
    expect(save.mock.calls.some(([updates]) => 'pushMode' in updates || 'thirdPartyPush' in updates)).toBe(false);
  });

  it('网页查看 ntfy 自动连接说明不覆盖现有凭据或登记新订阅', async () => {
    client.getGlobalConfig.mockResolvedValue({ ...connected, pushMode: 'third-party', thirdPartyPush: { provider: 'bark', token: 'keep-existing-key' } });
    client.getPushStatus.mockResolvedValue({ ...subscribedPush, transport: 'third-party' });
    await render(); await click('通知设置');
    vi.mocked(ActiveMsgStore.saveGlobalConfig).mockClear();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="ntfy（APK 自动连接）"]')!.click());
    expect(host.textContent).toContain('网页无法调用 App 的自动连接');
    expect(button('保存并登记推送')).toBeUndefined();
    expect(ActiveMsgStore.saveGlobalConfig).not.toHaveBeenCalled();
    expect(client.reconcilePushSubscription).not.toHaveBeenCalled();
  });

  it('引导说清云端生成不是秒回，最后单独一步讲给角色开启，走完回到面板', async () => {
    client.getGlobalConfig.mockResolvedValue(connected);
    await render();
    await click('这个功能是做什么的？重看介绍');
    await click('开始配置');
    expect(host.textContent).toContain('后端已经连上了');
    await click('下一步');
    await click('下一步');
    expect(host.textContent).toContain('云端生成不是秒回');
    expect(host.textContent).toContain('杀后台');
    await click('下一步');
    expect(host.textContent).toContain('第 4 步，共 4 步');
    expect(host.textContent).toContain('在每个角色那里单独打开');
    expect(host.querySelector('input')).toBeNull();
    await click('完成');
    expect(host.textContent).toContain('重看介绍');
  });

  it('总开关暂停时打开面板不向 Worker 发任何探测请求，且保留已有连接配置', async () => {
    client.getCapabilities.mockClear();
    client.probeWorkerVersion.mockClear();
    client.probeInstantChatSupport.mockClear();
    client.getCronTriggerState.mockClear();
    client.getGlobalConfig.mockResolvedValue({
      ...connected,
      enabled: false,
      serverToken: 'saved-token',
    });
    await render();
    expect(host.textContent).toContain('主动消息 2.0 总开关 · 已暂停');
    expect(host.textContent).toContain('后端已暂停');
    expect(client.getCapabilities).not.toHaveBeenCalled();
    expect(client.probeWorkerVersion).not.toHaveBeenCalled();
    expect(client.probeInstantChatSupport).not.toHaveBeenCalled();
    expect(client.getCronTriggerState).not.toHaveBeenCalled();
    expect(fetchWorkerDiagnostics).not.toHaveBeenCalled();
    // 暂停保留连接字段，切换分区不触发网络探测。
    expect(host.querySelector<HTMLInputElement>('input[placeholder="https://amsg.你的账号.workers.dev"]')?.value)
      .toBe('https://worker.invalid');
    // 展开云端生成：暂停态只报总开关暂停，绝不误报「更新 Worker」或「Worker 过旧」。
    await click('云端生成');
    expect(host.textContent).toContain('总开关已暂停，当前聊天在本机生成');
    expect(host.textContent).not.toContain('点上面的「更新 Worker」');
  });

  // 回归守卫：saveGlobalConfig 只做浅合并，改一个功能的开关时必须把整份 cloudGen 写回，
  // 只写 { cloudGen: { dream } } 会把日程、人格模拟已经关掉的开关冲回默认值。
  it('云端生成按功能的开关：改一项时整份 cloudGen 写回，别的功能原样保留', async () => {
    client.getGlobalConfig.mockResolvedValue({ ...connected, cloudGen: { schedule: { enabled: false }, 'persona-sim': { notify: false } } });
    await render();
    await click('云端生成');
    expect(button('私聊云端生成')?.getAttribute('aria-checked')).toBe('true');
    expect(button('日程云端生成')?.getAttribute('aria-checked')).toBe('false');
    // 功能关着时「完成时通知」置灰，原值保留。
    expect((button('日程完成时通知') as HTMLButtonElement).disabled).toBe(true);
    expect(button('梦境完成时通知')?.getAttribute('aria-checked')).toBe('true');
    vi.mocked(ActiveMsgStore.saveGlobalConfig).mockClear();
    await click('梦境完成时通知');
    expect(ActiveMsgStore.saveGlobalConfig).toHaveBeenCalledWith({
      cloudGen: { schedule: { enabled: false }, 'persona-sim': { notify: false }, dream: { notify: false } },
    });
    expect(button('梦境完成时通知')?.getAttribute('aria-checked')).toBe('false');
    await click('日程云端生成');
    expect(ActiveMsgStore.saveGlobalConfig).toHaveBeenLastCalledWith({
      cloudGen: { schedule: { enabled: true }, 'persona-sim': { notify: false }, dream: { notify: false } },
    });
  });

  it('选过「本功能不再提醒」的功能下面才有「恢复云端生成提醒」，点了只恢复那一项', async () => {
    localStorage.setItem('amsg2_cloud_gen_hint_off_v1', JSON.stringify(['dream', 'schedule']));
    client.getGlobalConfig.mockResolvedValue(connected);
    await render();
    await click('云端生成');
    const restoreButtons = () => Array.from(host.querySelectorAll('button')).filter((item) => item.textContent === '恢复云端生成提醒');
    expect(restoreButtons()).toHaveLength(2);
    await act(async () => { restoreButtons()[1].click(); });
    expect(JSON.parse(localStorage.getItem('amsg2_cloud_gen_hint_off_v1') || '[]')).toEqual(['schedule']);
    expect(restoreButtons()).toHaveLength(1);
    localStorage.clear();
  });

  it('功能总览的云端生成卡片：私聊开关就是即时对话开关，能力表多一行云端生成', async () => {
    client.getGlobalConfig.mockResolvedValue({ ...connected, instantChatEnabled: false });
    await render(true, 'overview');
    expect(host.querySelector('[aria-label="即时对话总开关"]')).toBeNull();
    expect(button('私聊云端生成')?.getAttribute('aria-checked')).toBe('false');
    expect(button('人格模拟云端生成')?.getAttribute('aria-checked')).toBe('true');
    expect(host.textContent).toContain('云端生成（日程 / 人格模拟 / 梦境）');
    expect(host.textContent).not.toContain('即时对话总开关');
  });
});
