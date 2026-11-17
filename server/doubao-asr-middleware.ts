import type { Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
// @ts-expect-error Shared standalone Worker runtime is JavaScript.
import { attachDoubaoAsrRelay } from '../worker/index.js';

/** Dev and preview share the production relay. Audio passes through memory only. */
export function installDoubaoAsrRelay(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname !== '/doubao/asr') return;
    // A localhost relay is accessible only from the app served by this listener.
    let allowed = false;
    try { allowed = new URL(request.headers.origin || '').host === request.headers.host; } catch {}
    if (!allowed || url.search) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(request, socket, head, client => {
      client.binaryType = 'arraybuffer';
      attachDoubaoAsrRelay(client, (headers: Record<string, string>, signal: AbortSignal) => new Promise<WebSocket>((resolve, reject) => {
        const upstream = new WebSocket('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async', {
          headers, handshakeTimeout: 12_000, maxPayload: 1024 * 1024, followRedirects: false,
        });
        upstream.binaryType = 'arraybuffer';
        const abort = () => { upstream.terminate(); reject(new Error('ASR connection cancelled')); };
        signal.addEventListener('abort', abort, { once: true });
        upstream.once('open', () => { signal.removeEventListener('abort', abort); resolve(upstream); });
        upstream.once('close', () => signal.removeEventListener('abort', abort));
        upstream.on('error', () => reject(new Error('ASR connection failed')));
        upstream.once('unexpected-response', (_req, response) => {
          response.resume(); reject(Object.assign(new Error('ASR handshake rejected'), { status: response.statusCode })); upstream.terminate();
        });
        if (signal.aborted) abort();
      }));
    });
  });
  server.once('close', () => { for (const client of wss.clients) client.terminate(); wss.close(); });
}
