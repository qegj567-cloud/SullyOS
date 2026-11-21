// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { companionVideoRouteLabel, testCompanionVideoDirect } from './videoConnection';
import { COMPANION_ARK_PLAN, COMPANION_VIDEO_PROVIDERS } from './videoProviders';
import { setProxyWorkerUrlOverride } from '../proxyWorker';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); setProxyWorkerUrlOverride(null); });
const signal = () => new AbortController().signal;

it('describes the real video route for regular Ark, GLM, the plan and a user proxy', () => {
  const origin = 'https://test.friedsully.com';
  expect(companionVideoRouteLabel(COMPANION_VIDEO_PROVIDERS.doubao, origin)).toBe('浏览器 → ark.cn-beijing.volces.com（不经应用 Worker）');
  expect(companionVideoRouteLabel(COMPANION_VIDEO_PROVIDERS.zhipu, origin)).toBe('浏览器 → open.bigmodel.cn（不经应用 Worker）');
  expect(companionVideoRouteLabel(COMPANION_ARK_PLAN, 'http://127.0.0.1:5175')).toContain('本机转发');
  setProxyWorkerUrlOverride('https://custom-proxy.example/relay');
  expect(companionVideoRouteLabel(COMPANION_ARK_PLAN, origin)).toBe('浏览器 → 应用主代理 custom-proxy.example → 火山套餐接口');
});

it('checks the official plan directly with an empty request, never the application proxy or media API', async () => {
  const cancel = vi.fn(async () => {});
  const fetch = vi.fn(async () => ({ status: 401, type: 'cors', body: { cancel } }));
  vi.stubGlobal('fetch', fetch);
  const result = await testCompanionVideoDirect({ ...COMPANION_ARK_PLAN, apiKey: 'draft-secret' }, signal());
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(`${COMPANION_ARK_PLAN.baseUrl}/chat/completions`, expect.objectContaining({
    mode: 'cors', credentials: 'omit', redirect: 'error', method: 'POST', body: '{}',
    headers: { Authorization: 'Bearer draft-secret', 'Content-Type': 'application/json' },
    __sullyMeta: { appId: 'companion', appName: '同行', purpose: '测试连接' }, __sullyHandlesFailure: true,
  }));
  expect(result.summary).toContain('仅表示浏览器能读取响应');
  expect(result.detail).toContain('不代表 Key');
  expect(JSON.stringify(result)).not.toContain('draft-secret'); expect(cancel).toHaveBeenCalledOnce();
});

it('does not fall back, retry or blame CORS alone when GLM cannot be read', async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  vi.stubGlobal('fetch', fetch);
  await expect(testCompanionVideoDirect({ ...COMPANION_VIDEO_PROVIDERS.zhipu, apiKey: 'k' }, signal())).rejects.toThrow('仅凭此结果无法区分');
  expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][0]).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
});

it('aborts on cancellation or timeout and does not accept late responses', async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  const fetch = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetch);
  const api = { ...COMPANION_VIDEO_PROVIDERS.zhipu, apiKey: '' };
  const controller = new AbortController();
  const pending = testCompanionVideoDirect(api, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); finish({ status: 200 }); await rejected;
  expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true);
  const timed = testCompanionVideoDirect(api, signal());
  const timeout = expect(timed).rejects.toThrow('15 秒');
  await vi.advanceTimersByTimeAsync(15_000); finish({ status: 200 }); await timeout;
  expect((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true);
});
