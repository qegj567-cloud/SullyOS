import { expect, it, vi } from 'vitest';
import { CompanionSession, type CompanionLine } from './session';

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

it('a speech failure cancels continuation and reports the real error', async () => {
  const error = vi.fn();
  let signal: AbortSignal | undefined;
  const session = new CompanionSession({ quick: async () => 'a', prepare: async (_, a) => a,
    full: async (_, s) => { signal = s; return 'a′'; },
    play: async () => { throw new Error('TTS failed'); }, change: () => {}, error });
  await session.send('A');
  expect(error).toHaveBeenCalledOnce();
  if (signal) expect(signal.aborted).toBe(true);
});
