import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import handler from '../api/elevenlabs/tts';

afterEach(() => vi.unstubAllGlobals());
it('Vercel forwards the first timed chunk before the upstream finishes', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'content-type': 'application/json', 'request-id': 'req-test' } })));
  const res: any = new EventEmitter();
  res.setHeader = vi.fn(); res.status = vi.fn(() => res); res.write = vi.fn(() => true);
  res.end = vi.fn(); res.flushHeaders = vi.fn(); res.json = vi.fn();
  const pending = handler({ method: 'POST', headers: { 'xi-api-key': 'test-only' }, query: { mode: 'dialogue', timestamps: '1', output_format: 'pcm_24000' }, body: { inputs: [] } }, res);
  await vi.waitFor(() => expect(controller).toBeDefined());
  controller.enqueue(new TextEncoder().encode('{"audio_base64":"AAA="}\n'));
  await vi.waitFor(() => expect(res.write).toHaveBeenCalledOnce());
  expect(res.end).not.toHaveBeenCalled();
  controller.close(); await pending;
  expect(res.end).toHaveBeenCalledOnce();
  expect(res.setHeader).toHaveBeenCalledWith('request-id', 'req-test');
});

it('cancels an idle upstream reader when the browser disconnects', async () => {
  const cancel = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }))));
  const res: any = new EventEmitter();
  res.setHeader = vi.fn(); res.status = vi.fn(() => res); res.write = vi.fn(() => true);
  res.end = vi.fn(); res.flushHeaders = vi.fn(); res.json = vi.fn(); res.destroy = vi.fn();
  const pending = handler({ method: 'POST', headers: { 'xi-api-key': 'test-only' }, query: { mode: 'dialogue', timestamps: '1' }, body: {} }, res);
  await vi.waitFor(() => expect(res.flushHeaders).toHaveBeenCalled());
  res.emit('close');
  await pending;
  expect(cancel).toHaveBeenCalledOnce();
  expect(res.end).not.toHaveBeenCalled();
  expect(res.listenerCount('close')).toBe(0);
});
