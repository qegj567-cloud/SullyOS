import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error Standalone Worker is JavaScript.
import worker, { handleCompanionArkPlan } from './index.js';

const path = 'https://proxy.test/api/companion/ark-plan/chat/completions';
const payload = JSON.stringify({ model: 'doubao-seed-2.1-pro', stream: false,
  messages: [{ role: 'user', content: [{ type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } }] }] });
const headers = { Origin: 'https://test.friedsully.com', Authorization: 'Bearer test-key', 'Content-Type': 'application/json' };
const request = (init: RequestInit = {}) => new Request(path, { method: 'POST', headers, body: payload, ...init });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('routes preflight with authorization allowed, without contacting the provider', async () => {
  const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
  const response = await worker.fetch(new Request(path, { method: 'OPTIONS', headers: {
    Origin: headers.Origin, 'Access-Control-Request-Headers': 'authorization,content-type', 'Access-Control-Request-Method': 'POST',
  } }), {}, {});
  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(headers.Origin);
  expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(upstream).not.toHaveBeenCalled();
});

it('preserves the complete MP4, selected model, billing endpoint and useful provider errors while removing credentials', async () => {
  const upstream = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'rejected test-key' } }), { status: 401 }));
  const response = await handleCompanionArkPlan(request(), upstream);
  expect(response.status).toBe(401);
  expect(await response.text()).toContain('[已隐藏凭据]');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(headers.Origin);
  expect(upstream).toHaveBeenCalledOnce();
  expect(upstream).toHaveBeenCalledWith('https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions', expect.objectContaining({
    body: payload, redirect: 'manual', headers: { Authorization: headers.Authorization, 'Content-Type': 'application/json' },
  }));
});

it('rejects credentials in URLs, missing keys, wrong methods, oversized bodies and malformed requests before forwarding', async () => {
  const upstream = vi.fn();
  const cases = [
    [new Request(path + '?target=https://other.test', { method: 'POST', headers, body: payload }), 400],
    [request({ headers: { 'Content-Type': 'application/json' } }), 401],
    [new Request(path, { headers }), 405],
    [request({ headers: { ...headers, 'Content-Type': 'text/plain' } }), 415],
    [request({ headers: { ...headers, 'Content-Length': String(13 * 1024 * 1024) } }), 413],
    [request({ body: 'null' }), 400], [request({ body: '{' }), 400],
    [request({ body: JSON.stringify({ model: 'x', stream: true, messages: [] }) }), 400],
    [request({ body: 'x'.repeat(12 * 1024 * 1024 + 1) }), 413],
  ] as const;
  for (const [req, status] of cases) expect((await handleCompanionArkPlan(req, upstream)).status).toBe(status);
  expect(upstream).not.toHaveBeenCalled();
});

it('aborts the provider when the browser cancels and never retries', async () => {
  const abort = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const upstream = vi.fn((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('cancelled'))); started();
  }));
  const pending = handleCompanionArkPlan(request({ signal: abort.signal }), upstream);
  await ready; abort.abort();
  expect((await pending).status).toBe(504);
  expect(upstream).toHaveBeenCalledOnce();
  expect(upstream.mock.calls[0][1].signal.aborted).toBe(true);
});

it('bounds a stalled incoming upload and oversized provider response', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const stalled = new ReadableStream({ cancel });
  const req = request({ body: stalled, duplex: 'half' } as RequestInit);
  const upstream = vi.fn();
  const pending = handleCompanionArkPlan(req, upstream);
  await vi.advanceTimersByTimeAsync(60_000);
  expect((await pending).status).toBe(504); expect(cancel).toHaveBeenCalledOnce();
  expect(upstream).not.toHaveBeenCalled();
  const response = await handleCompanionArkPlan(request(), async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
  expect(response.status).toBe(413); expect(vi.getTimerCount()).toBe(0);
});

it('returns successful model content with no caching and does not switch endpoints on network failure', async () => {
  const data = { choices: [{ message: { content: '红色圆形变为蓝色方形' } }] };
  const ok = await handleCompanionArkPlan(request(), async () => Response.json(data));
  expect(await ok.json()).toEqual(data); expect(ok.headers.get('Cache-Control')).toBe('no-store');
  const upstream = vi.fn(async () => { throw new Error('private transport detail'); });
  const failed = await handleCompanionArkPlan(request(), upstream);
  expect(failed.status).toBe(502); expect(await failed.text()).not.toContain('private');
  expect(upstream).toHaveBeenCalledOnce();
});

it('stops upstream redirects without returning their location or forwarding a key to a second host', async () => {
  const upstream = vi.fn(async () => new Response('redirect body', { status: 307, headers: { Location: 'https://other.test/?key=test-key' } }));
  const response = await handleCompanionArkPlan(request(), upstream);
  expect(response.status).toBe(502);
  expect(response.headers.get('Location')).toBeNull();
  expect(await response.text()).not.toMatch(/other.test|test-key|redirect body/);
  expect(upstream).toHaveBeenCalledOnce();
});
