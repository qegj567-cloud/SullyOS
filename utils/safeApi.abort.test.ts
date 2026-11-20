import { afterEach, expect, it, vi } from 'vitest';
import { safeFetchJson } from './safeApi';
afterEach(() => vi.restoreAllMocks());
it.each([false, true])('keeps the caller cancellation reason with timeout wrapping (already stopped: %s)', async alreadyStopped => {
  const controller = new AbortController();
  const reason = new DOMException('同行已停止：识别到新的语音输入', 'AbortError');
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    started();
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  });
  if (alreadyStopped) controller.abort(reason);
  const task = safeFetchJson('https://example.test/v1/chat/completions', { method: 'POST', signal: controller.signal, body: '{}' }, 0, 30_000);
  const cancelled = expect(task).rejects.toBe(reason);
  if (!alreadyStopped) { await ready; controller.abort(reason); }
  await cancelled;
  expect(transport).toHaveBeenCalledTimes(alreadyStopped ? 0 : 1);
});
