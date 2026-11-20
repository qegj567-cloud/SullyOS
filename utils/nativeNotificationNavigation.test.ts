import { beforeEach, expect, it, vi } from 'vitest';
beforeEach(() => vi.resetModules());

it('冷启动点击等到 UI 监听就绪才消费，并且只消费一次', async () => {
  const { requestNativeNotificationOpen, subscribeNativeNotificationOpen } = await import('./nativeNotificationNavigation');
  requestNativeNotificationOpen('old');
  requestNativeNotificationOpen('latest');
  const handler = vi.fn();
  const dispose = subscribeNativeNotificationOpen(handler);
  expect(handler.mock.calls).toEqual([['latest']]);
  dispose();
  subscribeNativeNotificationOpen(handler);
  expect(handler).toHaveBeenCalledOnce();
  requestNativeNotificationOpen('new');
  expect(handler).toHaveBeenLastCalledWith('new');
});

it('过期的卸载回调不会删掉新监听器', async () => {
  const { requestNativeNotificationOpen, subscribeNativeNotificationOpen } = await import('./nativeNotificationNavigation');
  const oldDispose = subscribeNativeNotificationOpen(vi.fn());
  const handler = vi.fn();
  subscribeNativeNotificationOpen(handler);
  oldDispose();
  requestNativeNotificationOpen('c');
  expect(handler).toHaveBeenCalledWith('c');
});
