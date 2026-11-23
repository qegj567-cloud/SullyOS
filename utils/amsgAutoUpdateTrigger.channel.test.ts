import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  probeWorkerVersion: vi.fn(),
  selfUpdateWorker: vi.fn(),
  requestWorkerUpdateCheck: vi.fn(),
  registerPushSubscription: vi.fn(),
}));
vi.mock('./activeMsgClient', () => ({ ActiveMsgClient: client }));
vi.mock('./activeMsgStore', () => ({ ActiveMsgStore: { getGlobalConfig: vi.fn().mockResolvedValue({ initializedAt: 1 }) } }));
vi.mock('./amsgGlobalGate', () => ({ isAmsg2WorkerActive: () => true }));

import { requestStartupUpdateCheck } from './amsgAutoUpdateTrigger';
import { CHANNEL_ARRIVAL_KEY, RELEASE_CHANNEL_STORAGE_KEY } from './releaseChannel';

describe('requestStartupUpdateCheck · 通道（docs/canary-channel.md）', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    client.selfUpdateWorker.mockResolvedValue({ ok: true, supported: true, message: '' });
  });

  /**
   * 回归守卫：正式版正要跳去 canary 的那一下，不许动 Worker——否则会把 canary 用户的 Worker
   * 降回正式版，紧接着 canary 一启动又升回去。
   */
  it('本地选的通道跟这份前端不一致 → 一个请求都不发', async () => {
    localStorage.setItem(RELEASE_CHANNEL_STORAGE_KEY, 'canary');
    expect(await requestStartupUpdateCheck(Date.now(), 'build@a')).toBe('skipped');
    expect(client.probeWorkerVersion).not.toHaveBeenCalled();
    expect(client.selfUpdateWorker).not.toHaveBeenCalled();
  });

  it('Worker 还跟着 canary、前端是正式版 → 带着正式版通道更新一次', async () => {
    client.probeWorkerVersion.mockResolvedValue({ state: 'current', deployed: 'x', expected: 'x', autoUpdate: { supported: true, state: null }, channel: 'canary' });
    expect(await requestStartupUpdateCheck(Date.now(), 'build@b')).toBe('updated');
    expect(client.selfUpdateWorker).toHaveBeenCalledTimes(1);
    expect(client.requestWorkerUpdateCheck).not.toHaveBeenCalled();
  });

  it('刚切过通道且已授权通知 → 把这一边的推送订阅登记上去', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    localStorage.setItem(CHANNEL_ARRIVAL_KEY, '1');
    client.probeWorkerVersion.mockResolvedValue({ state: 'unknown', deployed: null, expected: 'x', autoUpdate: null, channel: null });
    await requestStartupUpdateCheck(Date.now(), 'build@c');
    expect(client.registerPushSubscription).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(CHANNEL_ARRIVAL_KEY)).toBeNull();
    vi.unstubAllGlobals();
  });
});
