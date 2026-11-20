// utils/activeMsgClient.cronTrigger.test.ts
//
// 「暂停 / 恢复后台任务」前端这一侧的回归守卫（worker 那一侧见 worker/amsg/src/cronTrigger.test.ts）。
//
// 最要紧的一条：旧版 Worker 没有 /cron-trigger 这个端点，问状态回 404 时必须回 null 而不是抛——
// 设置页每次打开都会问一次，抛出去等于让所有还没更新 Worker 的人每次开面板都看到一条报错。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reiClient } = vi.hoisted(() => ({
  reiClient: { init: vi.fn(), getCapabilities: vi.fn(), _encrypt: vi.fn() },
}));
vi.mock('@rei-standard/amsg-client', () => ({ ReiClient: vi.fn(() => reiClient) }));
vi.mock('./keepAlive', () => ({
  KeepAlive: { init: vi.fn().mockResolvedValue(undefined), reregister: vi.fn().mockResolvedValue(undefined) },
}));

const TEST_USER_ID = '3f2b1c8a-9d4e-4a1b-8c2d-000000000088';
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    ensureUserId: async () => TEST_USER_ID,
    getGlobalConfig: async () => ({
      userId: TEST_USER_ID,
      workerUrl: 'https://amsg.example.workers.dev',
      serverToken: 'shared',
    }),
    saveGlobalConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

import { ActiveMsgClient } from './activeMsgClient';

/** 让 worker 回一份固定的 JSON。 */
const workerReplies = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => ({
  status,
  text: async () => JSON.stringify(body),
  headers: new Headers({ 'content-type': 'application/json' }),
})));

/** 最近一次打到 worker 的请求。 */
const lastRequest = () => {
  const calls = (globalThis.fetch as any).mock.calls as Array<[string, RequestInit]>;
  const [url, init] = calls[calls.length - 1];
  return { url: String(url), init, headers: new Headers(init.headers) };
};

beforeEach(() => {
  reiClient.init.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('getCronTriggerState', () => {
  it('旧版 Worker 回 404 → null，不抛', async () => {
    workerReplies(404, null);
    await expect(ActiveMsgClient.getCronTriggerState()).resolves.toBeNull();
  });

  it('上游把它当未知路由回 NOT_FOUND → 同样是 null', async () => {
    workerReplies(200, { success: false, error: { code: 'NOT_FOUND', message: 'no route' } });
    await expect(ActiveMsgClient.getCronTriggerState()).resolves.toBeNull();
  });

  it('连不上 Worker → null，不抛（设置页每次打开都会问，抛出去就是每次一条报错）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));
    await expect(ActiveMsgClient.getCronTriggerState()).resolves.toBeNull();
  });

  it('throwOnNetworkError=true 时：断网或 5xx 向上抛出，旧版 404 仍回 null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));
    await expect(ActiveMsgClient.getCronTriggerState({ throwOnNetworkError: true })).rejects.toThrow();

    workerReplies(502, { success: false });
    await expect(ActiveMsgClient.getCronTriggerState({ throwOnNetworkError: true })).rejects.toThrow('HTTP 502');

    workerReplies(404, null);
    await expect(ActiveMsgClient.getCronTriggerState({ throwOnNetworkError: true })).resolves.toBeNull();
  });

  it('读到了：把 supported / enabled 原样带回，请求走 GET /cron-trigger 并带共享密钥', async () => {
    workerReplies(200, { success: true, data: { supported: true, enabled: false } });
    expect(await ActiveMsgClient.getCronTriggerState()).toEqual({ supported: true, enabled: false });
    const { url, init, headers } = lastRequest();
    expect(url).toBe('https://amsg.example.workers.dev/cron-trigger');
    expect(init.method).toBe('GET');
    expect(headers.get('X-Client-Token')).toBe('shared');
  });

  it('端点在、但 Worker 没配 CF_API_TOKEN：supported:false 带代号，面板据此引导补钥匙', async () => {
    workerReplies(200, {
      success: true,
      data: { supported: false, code: 'CF_TOKEN_MISSING', message: '没配 CF_API_TOKEN。' },
    });
    expect(await ActiveMsgClient.getCronTriggerState()).toEqual({
      supported: false,
      code: 'CF_TOKEN_MISSING',
      message: '没配 CF_API_TOKEN。',
    });
  });

  it('共享密钥对不上（401）：supported:false，代号从 error 里取', async () => {
    workerReplies(401, { success: false, error: { code: 'UNAUTHORIZED', message: '共享密钥对不上。' } });
    expect(await ActiveMsgClient.getCronTriggerState()).toEqual({
      supported: false,
      code: 'UNAUTHORIZED',
      message: '共享密钥对不上。',
    });
  });
});

describe('setCronTriggerEnabled', () => {
  it('暂停：POST /cron-trigger，JSON 体 { enabled: false }', async () => {
    workerReplies(200, { success: true, data: { ok: true, enabled: false } });
    const result = await ActiveMsgClient.setCronTriggerEnabled(false);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('已暂停');
    const { url, init, headers } = lastRequest();
    expect(url).toBe('https://amsg.example.workers.dev/cron-trigger');
    expect(init.method).toBe('POST');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
  });

  it('恢复：JSON 体 { enabled: true }', async () => {
    workerReplies(200, { success: true, data: { ok: true, enabled: true } });
    const result = await ActiveMsgClient.setCronTriggerEnabled(true);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('已恢复');
    expect(JSON.parse(String(lastRequest().init.body))).toEqual({ enabled: true });
  });

  it('worker 报失败：ok:false，把它那句话和代号带回来', async () => {
    workerReplies(400, {
      success: false,
      error: { code: 'CF_TOKEN_MISSING', message: '没配 CF_API_TOKEN，没法改定时触发。' },
    });
    expect(await ActiveMsgClient.setCronTriggerEnabled(false)).toEqual({
      ok: false,
      code: 'CF_TOKEN_MISSING',
      message: '没配 CF_API_TOKEN，没法改定时触发。',
    });
  });

  it('旧版 Worker 回 404 → ok:false 说要先更新，不抛', async () => {
    workerReplies(404, null);
    const result = await ActiveMsgClient.setCronTriggerEnabled(false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('更新 Worker');
  });
});
