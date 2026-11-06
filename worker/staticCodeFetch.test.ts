import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODE_IDLE_TIMEOUT_MS, loadStaticCode, StaticCodeBodyError, StaticCodeTimeoutError } from './staticCodeFetch';

afterEach(() => vi.useRealTimers());

describe('static code transfer deadline', () => {
  it('aborts a fetch that never supplies headers, even if it ignores AbortSignal', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const result = loadStaticCode(async next => { signal = next; return new Promise(() => {}); });
    const check = expect(result).rejects.toBeInstanceOf(StaticCodeTimeoutError);
    await vi.advanceTimersByTimeAsync(CODE_IDLE_TIMEOUT_MS);
    await check;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a body that starts but never finishes', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('partial')); }, cancel,
    });
    const result = loadStaticCode(async () => new Response(body));
    const check = expect(result).rejects.toBeInstanceOf(StaticCodeTimeoutError);
    await vi.advanceTimersByTimeAsync(CODE_IDLE_TIMEOUT_MS);
    await check;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows a transfer longer than the timeout while bytes keep arriving', async () => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    const result = loadStaticCode(async () => new Response(body, { headers: { 'Content-Type': 'text/css', 'Content-Encoding': 'gzip' } }));
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      stream.enqueue(new TextEncoder().encode('a'));
    }
    stream.close();
    const response = await result;
    expect(await response.text()).toBe('aaaa');
    expect(response.headers.get('Content-Type')).toBe('text/css');
    expect(response.headers.has('Content-Encoding')).toBe(false);
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves caller cancellation and clears the timer', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const cancel = vi.fn();
    const result = loadStaticCode(async () => new Response(new ReadableStream({ cancel })), abort.signal);
    const check = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await check;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start an already cancelled request', async () => {
    const abort = new AbortController(); abort.abort();
    const source = vi.fn();
    await expect(loadStaticCode(source, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(source).not.toHaveBeenCalled();
  });

  it('retains error statuses and enforces a bounded code buffer', async () => {
    const missing = new Response('missing', { status: 404 });
    expect(await loadStaticCode(async () => missing)).toBe(missing);
    const cancel = vi.fn();
    const huge = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)); }, cancel });
    await expect(loadStaticCode(async () => new Response(huge))).rejects.toBeInstanceOf(StaticCodeBodyError);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
