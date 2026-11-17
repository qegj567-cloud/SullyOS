import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// @ts-expect-error Standalone Worker is JavaScript.
import worker, { attachDoubaoAsrRelay } from './index.js';

class Socket extends EventTarget {
  bufferedAmount = 0;
  send = vi.fn(); close = vi.fn();
  message(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data })); }
}
const start = JSON.stringify({ type: 'start', apiKey: 'test-key', resourceId: 'volc.seedasr.sauc.duration' });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('authenticates the fixed connector, relays binary frames without transforming or persisting them, and closes both ends', async () => {
  const client = new Socket(), upstream = new Socket(), connect = vi.fn(async () => upstream);
  const stop = attachDoubaoAsrRelay(client, connect);
  client.message(start); await flush();
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({ 'X-Api-Key': 'test-key', 'X-Api-Resource-Id': 'volc.seedasr.sauc.duration' }), expect.any(AbortSignal));
  expect(client.send).toHaveBeenCalledWith('{"type":"ready"}');
  const audio = new ArrayBuffer(6408), transcript = new ArrayBuffer(20);
  client.message(audio); upstream.message(transcript);
  expect(upstream.send).toHaveBeenCalledWith(audio); expect(client.send).toHaveBeenCalledWith(transcript);
  stop(); expect(client.close).toHaveBeenCalledOnce(); expect(upstream.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels a pending handshake and closes any late upstream without announcing ready', async () => {
  let resolve!: (socket: Socket) => void;
  const client = new Socket(), upstream = new Socket();
  const connect = vi.fn((_headers, _signal) => new Promise<Socket>(r => { resolve = r; }));
  attachDoubaoAsrRelay(client, connect); client.message(start); client.dispatchEvent(new Event('close'));
  expect(connect.mock.calls[0][1].aborted).toBe(true);
  resolve(upstream); await flush();
  expect(upstream.close).toHaveBeenCalled(); expect(client.send).not.toHaveBeenCalled();
});

it.each(['null', '{}', '{', JSON.stringify({ type: 'start', apiKey: 'secret\r\ninjected', resourceId: 'volc.seedasr.sauc.duration' })])('rejects invalid start %s without connecting', async input => {
  const client = new Socket(), connect = vi.fn(); attachDoubaoAsrRelay(client, connect);
  client.message(input); await flush();
  expect(connect).not.toHaveBeenCalled(); expect(client.close).toHaveBeenCalled();
  expect(JSON.stringify(client.send.mock.calls)).not.toContain('secret');
});

it('bounds stalled handshakes, silence and output backpressure', async () => {
  const stalled = new Socket(); attachDoubaoAsrRelay(stalled, vi.fn());
  vi.advanceTimersByTime(15_000); expect(stalled.close).toHaveBeenCalled();
  const idle = new Socket(), upstream = new Socket(); attachDoubaoAsrRelay(idle, async () => upstream);
  idle.message(start); await flush(); vi.advanceTimersByTime(20_000);
  expect(upstream.close).toHaveBeenCalled();
  const slow = new Socket(), full = new Socket(); full.bufferedAmount = 200_000;
  attachDoubaoAsrRelay(slow, async () => full); slow.message(start); await flush(); slow.message(new ArrayBuffer(6408));
  expect(full.send).not.toHaveBeenCalled(); expect(full.close).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('returns status only on authentication failure, and refuses credential-bearing URLs', async () => {
  const client = new Socket(); attachDoubaoAsrRelay(client, async () => { throw Object.assign(new Error('sensitive provider response'), { status: 401 }); });
  client.message(start); await flush();
  expect(client.send).toHaveBeenCalledWith('{"type":"error","code":"http-401"}');
  expect(await worker.fetch(new Request('https://proxy.test/doubao/asr?apiKey=never-log-this'), {}, {})).toMatchObject({ status: 400 });
  expect(await worker.fetch(new Request('https://proxy.test/doubao/asr'), {}, {})).toMatchObject({ status: 426 });
});
