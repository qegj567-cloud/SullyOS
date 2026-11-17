import http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { COMPANION_ARK_PATH, companionArkMiddleware } from '../../server/companion-ark-middleware';

const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }))); });
async function setup(transport: typeof fetch) {
  const middleware = companionArkMiddleware(transport);
  const server = http.createServer((req, res) => { void middleware(req, res, () => res.writeHead(404).end()); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
it('preserves MP4 payload, key, model, provider failure and status without switching billing endpoints', async () => {
  const upstream = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'rejected fake-key' } }), { status: 400 }));
  const origin = await setup(upstream as typeof fetch);
  const body = JSON.stringify({ model: 'doubao-seed-2.1-pro', stream: false, messages: [{ role: 'user', content: [{ type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } }] }] });
  const response = await fetch(origin + COMPANION_ARK_PATH, { method: 'POST', headers: { Origin: origin, Authorization: 'Bearer fake-key', 'Content-Type': 'application/json' }, body });
  expect(response.status).toBe(400); expect(await response.text()).toContain('[已隐藏凭据]');
  expect(upstream).toHaveBeenCalledOnce();
  expect(upstream).toHaveBeenCalledWith('https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions', expect.objectContaining({ body, redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fake-key' } }));
});
it('rejects foreign origins, missing keys and query-selected targets before calling upstream', async () => {
  const upstream = vi.fn(); const origin = await setup(upstream);
  for (const [path, headers, status] of [
    [COMPANION_ARK_PATH, { Origin: 'https://foreign.test', Authorization: 'Bearer key' }, 403],
    [COMPANION_ARK_PATH, { Origin: origin }, 401],
    [COMPANION_ARK_PATH + '?target=https://foreign.test', { Origin: origin, Authorization: 'Bearer key' }, 403],
  ] as const) {
    const response = await fetch(origin + path, { method: 'POST', headers }); expect(response.status).toBe(status);
  }
  expect(upstream).not.toHaveBeenCalled();
});
