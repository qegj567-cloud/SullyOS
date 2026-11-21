import { expect, it, vi } from 'vitest';
import { CompanionSession, type CompanionLine } from './session';
import { CompanionDebugStore } from './debug';

const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

it('recalls beside a, generates a′ during 40s audio, and never overlaps the two utterances', async () => {
  const quick = deferred<string>(), recall = deferred<string>(), audio = deferred<void>();
  const order: string[] = [];
  const play = vi.fn(async (text: string) => { order.push('play:' + text); if (text === 'a') await audio.promise; });
  const session = new CompanionSession({
    quick: () => { order.push('quick'); return quick.promise; },
    prepare: async (_, a) => { order.push('recall'); await recall.promise; order.push('recalled'); return await a; },
    full: async a => { order.push('generate:' + a); return 'a′'; }, play, change: () => {}, error: error => { throw error; },
  });
  const done = session.send('A');
  expect(order).toEqual(['quick', 'recall']);
  recall.resolve('memory'); await tick();
  expect(order).not.toContain('generate:a');
  quick.resolve('a'); await tick();
  expect(order).toContain('generate:a');
  expect(play.mock.calls).toHaveLength(1);
  audio.resolve(); await done;
  expect(order).toEqual(['quick', 'recall', 'recalled', 'play:a', 'generate:a', 'play:a′']);
});

it('barge-in keeps only heard text and rejects late a′, including transports ignoring abort', async () => {
  const late = deferred<string>();
  let lines: CompanionLine[] = [];
  const histories: CompanionLine[][] = [];
  let turn = 0;
  const session = new CompanionSession({
    quick: async history => { histories.push(history); return ++turn === 1 ? '已听见。没有听见。' : 'b'; },
    prepare: async (_, a) => a,
    full: a => a.startsWith('已听见') ? late.promise : Promise.resolve('b′'),
    play: async (text, signal, heard) => {
      if (text.startsWith('已听见')) {
        heard('已听见。');
        await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('停止', 'AbortError')), { once: true }));
      } else heard(text);
    },
    change: next => { lines = next; }, error: error => { throw error; },
  });
  const first = session.send('A'); await tick();
  await session.send('B：我是说另一件');
  late.resolve('过期的 a′'); await first;
  expect(histories[1].map(line => line.text)).toEqual(['A', '已听见。', 'B：我是说另一件']);
  expect(lines.map(line => line.text)).not.toContain('过期的 a′');
  expect(lines.at(-1)?.heard).toBe('b′');
});

it('a speech failure keeps the pending continuation alive, shows its text, and reports the real cause', async () => {
  const error = vi.fn();
  const continuation = deferred<string>();
  const debug = new CompanionDebugStore();
  let lines: CompanionLine[] = [];
  let signal: AbortSignal | undefined;
  const session = new CompanionSession({ debug, quick: async () => 'a', prepare: async (_, a) => a,
    full: async (_, s) => { signal = s; return continuation.promise; },
    play: async (text, _, heard, started) => { if (text === 'a') throw new Error('鱼声 HTTP 404'); started('text'); heard(text); },
    change: next => { lines = next; }, error });
  const done = session.send('A'); await tick();
  expect(signal?.aborted).toBe(false);
  expect(error.mock.calls[0][0].message).toContain('a · 接话语音失败：鱼声 HTTP 404');
  expect(lines.at(-1)).toMatchObject({ text: 'a', heard: 'a', voiceFailed: true });
  continuation.resolve('a′'); await done;
  expect(error).toHaveBeenCalledOnce();
  expect(lines.at(-1)).toMatchObject({ text: 'a′', status: 'done' });
  expect(debug.getSnapshot()[0].delivery.quick).toMatchObject({ failed: true });
  expect(debug.getSnapshot()[0].stages.quick_tts?.status).toBe('error');
});

it('does not cancel audible a when full preparation fails, and labels the failed phase', async () => {
  const audio = deferred<void>(), error = vi.fn(), full = vi.fn();
  let signal!: AbortSignal;
  const session = new CompanionSession({ quick: async () => 'a', prepare: async () => { throw new Error('组装失败'); },
    full, play: async (_, s, heard) => { signal = s; await audio.promise; heard('a'); }, change: () => {}, error });
  const done = session.send('A'); await tick();
  expect(signal.aborted).toBe(false); expect(error).not.toHaveBeenCalled();
  audio.resolve(); await done;
  expect(error.mock.calls[0][0].message).toContain('a′ · 完整回复失败：组装失败');
  expect(full).not.toHaveBeenCalled();
});

it('can finish full context after quick generation fails, without inventing an assistant answer', async () => {
  const error = vi.fn(), play = vi.fn(async () => {}), prepared = vi.fn(async (_history, a) => a);
  const session = new CompanionSession({ quick: async () => { throw new Error('HTTP 400'); }, prepare: prepared,
    full: async a => { expect(a).toBe(''); return '完整答复'; }, play, change: () => {}, error });
  await session.send('A');
  expect(play).toHaveBeenCalledOnce(); expect(play.mock.calls[0][0]).toBe('完整答复');
  expect(error.mock.calls[0][0].message).toContain('a · 接话生成失败：HTTP 400');
});
