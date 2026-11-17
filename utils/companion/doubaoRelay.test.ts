import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { expect, it } from 'vitest';
import { installDoubaoAsrRelay } from '../../server/doubao-asr-middleware';

it('accepts same-origin browser WebSocket frames in preview and refuses foreign origins/credential URLs', async () => {
  const server = createServer(); installDoubaoAsrRelay(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`, endpoint = `ws://127.0.0.1:${port}/doubao/asr`;
  const clients: WebSocket[] = [];
  try {
    const client = new WebSocket(endpoint, { origin }); clients.push(client);
    await once(client, 'open');
    const message = once(client, 'message'), closed = once(client, 'close');
    client.send(JSON.stringify({ type: 'start', apiKey: '', resourceId: 'volc.seedasr.sauc.duration' }));
    expect(JSON.parse(String((await message)[0]))).toEqual({ type: 'error', code: 'invalid-config' });
    await closed;
    for (const [url, requestOrigin] of [[endpoint, 'https://unrelated.test'], [endpoint + '?apiKey=forbidden', origin]]) {
      const denied = new WebSocket(url, { origin: requestOrigin }); clients.push(denied);
      denied.on('error', () => {});
      const [, response] = await once(denied, 'unexpected-response');
      expect(response.statusCode).toBe(403); response.resume(); denied.terminate();
    }
  } finally {
    for (const client of clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
