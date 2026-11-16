// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  native: true,
  config: vi.fn(), status: vi.fn(), browser: vi.fn(), remote: vi.fn(), diagnostics: vi.fn(),
  compare: vi.fn(), reset: vi.fn(), catchUp: vi.fn(),
}));
vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: { getGlobalConfig: mock.config, getPushStatus: mock.status, getRemotePushSubscription: mock.remote, resetPushSubscription: mock.reset },
  compareRemotePushSubscription: mock.compare, fetchWorkerDiagnostics: mock.diagnostics,
  readAmsgFailKind: () => 'unknown',
}));
vi.mock('./pushSubscribeShared', () => ({ detectCapacitorNative: () => mock.native, readBrowserPushState: mock.browser }));
vi.mock('./activeMsgRuntime', () => ({ catchUpMissedPushesManually: mock.catchUp }));
vi.mock('./analytics', () => ({ trackEvent: vi.fn(), bucketRetryCount: vi.fn() }));
import PushSubscriptionPanel from '../components/settings/PushSubscriptionPanel';

const nativeReady = { supported: true, permission: 'granted', hasSubscription: true, transport: 'unified-push', localEndpoint: 'https://ntfy.example.test/device', distributor: 'io.heckel.ntfy' };
let root: Root;
let host: HTMLDivElement;
const onOpenSettings = vi.fn();
const addToast = vi.fn();
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mock.native = true;
  mock.config.mockResolvedValue({ workerUrl: 'https://worker.example.test' });
  mock.status.mockResolvedValue(nativeReady);
  mock.remote.mockResolvedValue({ exists: true, endpoint: nativeReady.localEndpoint, updatedAt: 1 });
  mock.compare.mockReturnValue('matched');
  mock.diagnostics.mockResolvedValue({ reachable: true, report: { storage: { pushDelivery: { probed: true, gone: null } } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async () => { await act(async () => root.render(React.createElement(PushSubscriptionPanel, { addToast, onOpenSettings }))); };
const click = async (text: string) => {
  const button = [...host.querySelectorAll('button')].find(button => button.textContent === text);
  expect(button).toBeTruthy(); await act(async () => button!.click());
};

describe('通知状态按实际通道展示', () => {
  it('总开关暂停后打开原生设备状态不发起云端检查', async () => {
    mock.config.mockResolvedValue({ workerUrl: 'https://worker.example.test', enabled: false });
    await render();
    expect(mock.remote).not.toHaveBeenCalled();
    expect(mock.diagnostics).not.toHaveBeenCalled();
    expect(mock.reset).not.toHaveBeenCalled();
    expect(host.textContent).toContain('总开关已暂停');
  });
  it('正常 APK 读取原生状态和端点，不用缺失的浏览器接口判红', async () => {
    await render();
    expect(mock.browser).not.toHaveBeenCalled();
    expect(mock.compare).toHaveBeenCalledWith(nativeReady.localEndpoint, expect.objectContaining({ endpoint: nativeReady.localEndpoint }));
    expect(host.textContent).toContain('已连接');
    expect(host.textContent).toContain('已登记（就是这台设备）');
    expect(host.querySelector('.text-rose-600')).toBeNull();
    expect(host.textContent).not.toContain('重置订阅');
    await click('打开配置与通知测试');
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(mock.reset).not.toHaveBeenCalled();
  });
  it('APK 真的缺少 ntfy 或通知权限时给出可处理的提示', async () => {
    mock.status.mockResolvedValue({ ...nativeReady, hasSubscription: false, permission: 'denied', needsDistributor: true, localEndpoint: null });
    mock.compare.mockReturnValue('missing');
    await render();
    expect(host.textContent).toContain('等待连接 ntfy');
    expect(host.textContent).toContain('系统没有允许 App 显示通知');
    expect(host.textContent).not.toContain('浏览器的站点设置');
    expect(host.textContent).not.toContain('已连接');
  });
  it('原生桥失败不会误报为无权限或没有登记，也可以重试', async () => {
    mock.status.mockRejectedValueOnce(new Error('bridge unavailable'));
    await render();
    expect(host.textContent).toContain('暂时无法读取');
    expect(host.textContent).not.toContain('没有登记');
    expect(host.textContent).not.toContain('已连接');
    await click('刷新');
    expect(host.textContent).toContain('已连接');
    expect(host.textContent).not.toContain('暂时无法读取');
  });
  it('APK 使用第三方 App 时仍展示选中的第三方通道', async () => {
    mock.config.mockResolvedValue({ workerUrl: 'https://worker.example.test', pushMode: 'third-party', thirdPartyPush: { provider: 'bark', token: 'test-device', serverUrl: 'https://api.day.app' } });
    await render();
    expect(host.textContent).toContain('第三方推送 App');
    expect(host.textContent).toContain('重新登记到 Worker');
    expect(mock.status).not.toHaveBeenCalled();
    expect(mock.browser).not.toHaveBeenCalled();
  });
  it('网页仍检查浏览器权限、Service Worker 和订阅，保留真实故障', async () => {
    mock.native = false;
    mock.browser.mockResolvedValue({ supported: true, permission: 'denied', swState: 'activated', endpoint: null, endpointDead: false, channel: 'FCM', capacitorNative: false });
    mock.compare.mockReturnValue('missing');
    await render();
    expect(host.textContent).toContain('浏览器支持');
    expect(host.textContent).toContain('Service Worker');
    expect(host.textContent).toContain('重置订阅');
    expect(host.querySelector('.text-rose-600')).not.toBeNull();
    expect(mock.status).not.toHaveBeenCalled();
  });
  it('补收为空不据此宣称推送连接正常', async () => {
    mock.catchUp.mockResolvedValue({ written: 0, scanned: 0, stale: 0 });
    await render(); await click('找回没收到的消息');
    expect(addToast).toHaveBeenCalledWith('云端暂时没有可补收的消息。', 'info');
  });
});
