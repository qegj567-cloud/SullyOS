import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  native: vi.fn(), peek: vi.fn(), ack: vi.fn(), status: vi.fn(), ackRegistration: vi.fn(),
  listener: vi.fn(), ingest: vi.fn(), config: vi.fn(), reconcile: vi.fn(),
}));
vi.mock('./unifiedPushPlugin', () => ({
  isUnifiedPushPlatform: m.native, peekUnifiedPushMessages: m.peek, acknowledgeUnifiedPushMessage: m.ack,
  readUnifiedPushTransportStatus: m.status, acknowledgeUnifiedPushRegistration: m.ackRegistration,
  addUnifiedPushListener: m.listener,
}));
vi.mock('./nativeAmsgInbox', () => ({
  ingestNativeAmsgPayload: m.ingest,
  parseNativeAmsgPayload: (raw: unknown) => typeof raw === 'string' ? JSON.parse(raw) : raw,
}));
vi.mock('./activeMsgStore', () => ({ ActiveMsgStore: { getGlobalConfig: m.config } }));
vi.mock('./activeMsgClient', () => ({ ActiveMsgClient: { reconcilePushSubscription: m.reconcile } }));

describe('native durable queue runtime', () => {
  let callbacks: Record<string, (event?: any) => void>;
  const item = (id: string) => ({ id, payload: id, receivedAt: 1 });
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    callbacks = {};
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('window', new EventTarget());
    m.native.mockReturnValue(true);
    m.peek.mockResolvedValue({ messages: [] });
    m.status.mockResolvedValue({});
    m.ingest.mockResolvedValue(null);
    m.listener.mockImplementation(async (name, callback) => {
      callbacks[name] = callback;
      return { remove: vi.fn().mockResolvedValue(undefined) };
    });
    m.config.mockResolvedValue({ enabled: true, workerUrl: 'https://worker.example' });
    m.reconcile.mockResolvedValue('registered');
  });
  afterEach(() => vi.unstubAllGlobals());
  const start = async () => (await import('./unifiedPushRuntime')).initUnifiedPushRuntime();

  it('只确认已处理的单项；失败不妨碍后续消息，前台恢复时重试', async () => {
    m.peek.mockResolvedValueOnce({ messages: [item('a'), item('b')] }).mockResolvedValue({ messages: [item('a')] });
    m.ingest.mockRejectedValueOnce(new Error('DB unavailable'));
    await start();
    expect(m.ack.mock.calls).toEqual([['b']]);
    callbacks.foreground();
    await vi.waitFor(() => expect(m.ack.mock.calls).toEqual([['b'], ['a']]));
  });

  it('实时事件从持久队列读取，不额外吞一份无 ID 的事件 payload', async () => {
    await start();
    m.peek.mockResolvedValue({ messages: [item('queued')] });
    callbacks.pushReceived({ payload: 'unsafe-copy' });
    await vi.waitFor(() => expect(m.ack).toHaveBeenCalledWith('queued'));
    expect(m.ingest).toHaveBeenCalledWith('queued');
    expect(m.ingest).not.toHaveBeenCalledWith('unsafe-copy');
  });

  it('初始读取失败后仍保留恢复监听', async () => {
    m.peek.mockRejectedValueOnce(new Error('bridge busy'));
    await start();
    m.peek.mockResolvedValue({ messages: [item('later')] });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(m.ack).toHaveBeenCalledWith('later'));
  });

  it('监听初始化失败可重试且移除已安装的监听', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    m.listener.mockResolvedValueOnce({ remove }).mockRejectedValueOnce(new Error('not ready'));
    await expect(start()).rejects.toThrow('not ready');
    expect(remove).toHaveBeenCalledOnce();
    await start();
    expect(callbacks.foreground).toBeTypeOf('function');
  });

  it.each([{ enabled: false }, { enabled: true, pushMode: 'third-party' }])('暂停/第三方模式不自动请求 Worker：%j', async config => {
    m.status.mockResolvedValue({ registrationRevision: 'new', subscription: {} });
    m.config.mockResolvedValue({ workerUrl: 'https://worker.example', ...config });
    await start();
    expect(m.reconcile).not.toHaveBeenCalled();
    expect(m.ackRegistration).not.toHaveBeenCalled();
  });

  it('端点变更仅在成功登记后确认，失败保留待重试', async () => {
    m.status.mockResolvedValue({ registrationRevision: 'rev', subscription: {} });
    m.reconcile.mockResolvedValueOnce('failed');
    await start();
    expect(m.ackRegistration).not.toHaveBeenCalled();
    callbacks.registrationChanged();
    await vi.waitFor(() => expect(m.ackRegistration).toHaveBeenCalledWith('rev'));
  });

  it('已确认端点不重复登记，普通浏览器不加载桥', async () => {
    m.status.mockResolvedValue({ registrationRevision: 'same', acknowledgedRegistration: 'same', subscription: {} });
    await start();
    expect(m.reconcile).not.toHaveBeenCalled();
    vi.resetModules();
    m.native.mockReturnValue(false);
    m.listener.mockClear();
    await start();
    expect(m.listener).not.toHaveBeenCalled();
  });

  it('旧配置未写 enabled 时保持开启语义，重新开启总开关会补登记', async () => {
    m.status.mockResolvedValue({ registrationRevision: 'rev', subscription: {} });
    m.config.mockResolvedValueOnce({ enabled: false, workerUrl: 'https://worker.example' });
    await start();
    expect(m.reconcile).not.toHaveBeenCalled();
    m.config.mockResolvedValue({ workerUrl: 'https://worker.example' });
    window.dispatchEvent(new Event('amsg2-global-config-changed'));
    await vi.waitFor(() => expect(m.ackRegistration).toHaveBeenCalledWith('rev'));
  });
});
