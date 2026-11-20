import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@rei-standard/amsg-client', () => ({ ReiClient: vi.fn(() => ({ init: vi.fn() })) }));
vi.mock('./keepAlive', () => ({ KeepAlive: { init: vi.fn(), reregister: vi.fn() } }));
vi.mock('./activeMsgStore', () => ({ ActiveMsgStore: {
  ensureUserId: async () => 'test-user',
  getGlobalConfig: async () => ({ userId: 'test-user', workerUrl: 'https://worker.example', serverToken: 'test-token' }),
  saveGlobalConfig: vi.fn(),
} }));
import { ActiveMsgClient } from './activeMsgClient';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('测试推送保留上游结果', () => {
  it('等待预算超过发送库的 30 秒，仍只发送一次请求并保留鉴权', async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    const fetch = vi.fn().mockResolvedValue(Response.json({ success: true, data: { sent: true } }));
    vi.stubGlobal('fetch', fetch);
    await expect(ActiveMsgClient.sendTestPush()).resolves.toEqual({ sent: true });
    expect(timeout).toHaveBeenCalledWith(45_000);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://worker.example/test-push');
    expect(init.method).toBe('POST');
    expect(init.signal).toBe(signal);
    expect(init.headers.get('X-Client-Token')).toBe('test-token');
    expect(init.headers.get('X-User-Id')).toBe('test-user');
  });

  it('Worker 返回的推送错误不被当成成功，也不自动重试发送', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ success: false,
      error: { code: 'TEST_PUSH_FAILED', message: 'Web Push request timed out' } }, { status: 502 }));
    vi.stubGlobal('fetch', fetch);
    await expect(ActiveMsgClient.sendTestPush()).rejects.toThrow('Web Push request timed out');
    expect(fetch).toHaveBeenCalledOnce();
  });
});
