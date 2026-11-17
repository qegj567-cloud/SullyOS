import { expect, it } from 'vitest';
import { CompanionDebugStore, overlapMs } from './debug';
import { CompanionSession } from './session';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

it('measures actual overlap on one clock and freezes interrupted turns against late events', () => {
  let now = 100;
  const store = new CompanionDebugStore(() => now), first = new AbortController();
  const trace = store.start(first.signal, 'A');
  trace.begin('quick_request'); now = 120; trace.begin('memory');
  now = 6120; trace.end('memory'); now = 8100; trace.end('quick_request');
  trace.begin('full_request'); trace.request('full', '{"messages":[{"role":"user","content":"A"}]}');
  now = 9100; first.abort();
  const old = store.getSnapshot()[0];
  expect(overlapMs(old.stages.quick_request, old.stages.memory, old.end!)).toBe(6000);
  expect(old.stages.full_request).toMatchObject({ start: 8000, end: 9000, status: 'cancelled' });
  const next = store.start(new AbortController().signal, 'B'); next.begin('quick_request');
  now += 9999; trace.end('full_request'); trace.firstDelta('full'); trace.response('full', '过期'); trace.finish('done');
  expect(store.getSnapshot()[0]).toBe(old);
  expect(store.getSnapshot()[1].requests).toEqual({});
  for (let i = 0; i < 6; i++) store.start(new AbortController().signal, String(i)).finish('done');
  expect(store.getSnapshot()).toHaveLength(5);
  store.clear(); next.end('quick_request'); expect(store.getSnapshot()).toEqual([]);
});

it('includes remaining context preparation in the gap after a, and separates TTS from audible playback', async () => {
  let now = 0;
  const debug = new CompanionDebugStore(() => now);
  const quick = deferred<string>(), prepared = deferred<string>(), audio = deferred<void>(), full = deferred<string>();
  const session = new CompanionSession({ debug,
    quick: () => quick.promise, prepare: () => prepared.promise, full: () => full.promise,
    play: async (text, _, heard, started) => {
      if (text === 'a') { now = 350; started('audio'); await audio.promise; }
      else { now = 1100; started('audio'); now = 1500; }
      heard(text);
    }, change: () => {}, error: error => { throw error; },
  });
  const done = session.send('A'); now = 300; quick.resolve('a'); await tick();
  now = 500; audio.resolve(); await tick();
  now = 600; prepared.resolve('payload'); await tick();
  now = 1000; full.resolve('a′'); await done;
  const turn = debug.getSnapshot()[0];
  expect(turn.status).toBe('done');
  expect(turn.stages.quick_tts).toMatchObject({ start: 300, end: 350 });
  expect(turn.stages.quick_audio).toMatchObject({ start: 350, end: 500 });
  expect(turn.stages.wait_full).toMatchObject({ start: 500, end: 1000 });
  expect(turn.stages.full_tts).toMatchObject({ start: 1000, end: 1100 });
  expect(turn.stages.full_audio!.start - turn.delivery.quick!.end!).toBe(600);
  expect(turn.stages.wait_audio).toBeUndefined();
});

it('records a ready continuation waiting for a, and never invents audio in text mode', async () => {
  let now = 0;
  const debug = new CompanionDebugStore(() => now), audio = deferred<void>();
  const session = new CompanionSession({ debug, quick: async () => 'a', prepare: async (_, a) => a,
    full: async () => { now = 200; return 'a′'; },
    play: async (text, _, heard, started) => {
      started(text === 'a' ? 'audio' : 'text'); if (text === 'a') await audio.promise; heard(text);
    }, change: () => {}, error: error => { throw error; },
  });
  const done = session.send('A'); await tick(); now = 1000; audio.resolve(); await done;
  const turn = debug.getSnapshot()[0];
  expect(turn.stages.wait_audio).toMatchObject({ start: 200, end: 1000 });
  expect(turn.stages.wait_full).toBeUndefined();
  expect(turn.stages.full_tts?.status).toBe('skipped');
  expect(turn.stages.full_audio).toBeUndefined();
});
