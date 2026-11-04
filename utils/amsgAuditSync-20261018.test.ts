/** Regression coverage for in-flight saves and conditional-write conflicts. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: { syncToolConfig: vi.fn() },
  owesInstantChatReply: () => false,
  isLlmCredentialsReady: async () => false,
}));
vi.mock('./activeMsgStore', () => ({ ActiveMsgStore: { getGlobalConfig: async () => ({ workerUrl: 'https://audit.invalid' }) } }));
import { ActiveMsgClient } from './activeMsgClient';
import { syncAmsgToolConfig, resumePendingAmsgStateSync, flushAmsgState, AMSG2_PENDING_TOOL_CONFIG_LS_KEY } from './amsgStateSync';

beforeEach(() => { vi.useFakeTimers(); vi.mocked(ActiveMsgClient.syncToolConfig).mockReset().mockResolvedValue(undefined); });
afterEach(async () => {
  vi.mocked(ActiveMsgClient.syncToolConfig).mockReset().mockResolvedValue(undefined);
  syncAmsgToolConfig(undefined);
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers(); vi.useRealTimers();
});

it('saving configuration B while A is uploading automatically uploads B after A', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const uploading = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(ActiveMsgClient.syncToolConfig).mockReturnValueOnce(uploading).mockResolvedValue(undefined);
  const first = { newsEnabled: true } as any;
  const second = { newsEnabled: false } as any;
  syncAmsgToolConfig(first);
  await vi.advanceTimersByTimeAsync(0);
  syncAmsgToolConfig(second);
  release();
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledWith(first, expect.objectContaining({ updatedAt: expect.any(Number) }));
  expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(2);
  expect(ActiveMsgClient.syncToolConfig).toHaveBeenLastCalledWith(second, expect.objectContaining({ updatedAt: expect.any(Number) }));
  expect(localStorage.getItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY)).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});


it('重试保留同一保存版本，条件写冲突不会自动变成覆盖远端', async () => {
  const send = vi.mocked(ActiveMsgClient.syncToolConfig);
  send.mockRejectedValue(Object.assign(new Error('remote newer'), { code: 'TOOL_CONFIG_CONFLICT' }));
  syncAmsgToolConfig({ newsEnabled: false } as any);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  await flushAmsgState('conflict-check');
  expect(send).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY)).toBe('1');
  // 自动恢复不会被当作用户新保存，从而偷偷取得一个更高的时间戳。
  resumePendingAmsgStateSync({ characters: [], groups: [], userProfile: {} as any, realtimeConfig: { newsEnabled: false } as any });
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(1);
  send.mockResolvedValue(undefined);
  syncAmsgToolConfig({ newsEnabled: true } as any);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(2);
  expect(localStorage.getItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY)).toBeNull();
});

it('瞬时网络失败的自动重试复用原始时间戳', async () => {
  const send = vi.mocked(ActiveMsgClient.syncToolConfig);
  send.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  syncAmsgToolConfig({ newsEnabled: true } as any);
  await vi.advanceTimersByTimeAsync(31_000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0][1]?.updatedAt).toEqual(expect.any(Number));
  expect(send.mock.calls[1][1]?.updatedAt).toBe(send.mock.calls[0][1]?.updatedAt);
});
