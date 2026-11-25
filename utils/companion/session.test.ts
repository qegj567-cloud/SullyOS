import { expect, it, vi } from 'vitest';
import { CompanionSession, type CompanionLine } from './session';
import { CompanionDebugStore } from './debug';

const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

it('combines confirmed inputs only after both replies have played and the user finishes speaking', async () => {
  const quickAudio = deferred<void>(), fullAudio = deferred<void>(), fullResult = deferred<string>();
  const prepare = vi.fn(async (history: CompanionLine[]) => history.at(-1)!.text);
  const quick = vi.fn(async () => '短接话');
  const play = vi.fn(async (text: string) => {
    if (text === '短接话') await quickAudio.promise;
    if (text === '完整回答') await fullAudio.promise;
  });
  const pendingInput = vi.fn();
  const session = new CompanionSession({ quick, prepare, full: input => input === 'A' ? fullResult.promise : Promise.resolve('下一轮回答'),
    play, pendingInput, change: () => {}, error: error => { throw error; } });
  const first = session.send('A');
  await tick();
  session.speechStarted(false);
  await session.send('先看袖子', false, 'queue');
  session.speechEnded();
  expect(pendingInput).toHaveBeenLastCalledWith('先看袖子');
  fullResult.resolve('完整回答');
  await tick();
  expect(play.mock.calls.map(call => call[0])).toEqual(['短接话']);
  quickAudio.resolve();
  await tick();
  expect(play.mock.calls.map(call => call[0])).toEqual(['短接话', '完整回答']);
  await session.send('还有衣领', false, 'queue');
  session.speechStarted(false);
  fullAudio.resolve();
  await first;
  expect(prepare).toHaveBeenCalledTimes(1);
  await session.send('最后看口袋', false, 'queue');
  await session.speechEnded();
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(prepare.mock.calls[1][0].map(line => line.text)).toEqual(['A', '短接话', '完整回答', '先看袖子\n还有衣领\n最后看口袋']);
  expect(quick).toHaveBeenCalledOnce();
  expect(pendingInput).toHaveBeenLastCalledWith('');
});

it.each(['skip', 'leave', 'failure'] as const)('handles pending input exactly once after %s', async reason => {
  const old = deferred<string>(), error = vi.fn();
  const prepare = vi.fn(async (history: CompanionLine[]) => history.at(-1)!.text);
  const full = vi.fn((input: string) => input === 'A' ? old.promise : Promise.resolve('收到'));
  const play = vi.fn();
  const session = new CompanionSession({ quick: vi.fn(), prepare, full, play, change: () => {}, error });
  const first = session.send('A', false); await tick();
  await session.send('B', false, 'queue');
  expect(prepare).toHaveBeenCalledOnce();
  if (reason === 'leave') session.interrupt('切换角色');
  if (reason === 'skip') await session.skipReply();
  if (reason === 'failure') old.reject(new Error('暂时失败')); else old.resolve('旧结果');
  await first; await tick();
  expect(full.mock.calls.map(call => call[0])).toEqual(reason === 'leave' ? ['A'] : ['A', 'B']);
  expect(play.mock.calls.map(call => call[0])).toEqual(reason === 'leave' ? [] : ['收到']);
  expect(error).toHaveBeenCalledTimes(reason === 'failure' ? 1 : 0);
});

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

it('can interrupt full-only generation and only play the newest answer', async () => {
  const late = deferred<string>(), quick = vi.fn(), play = vi.fn(), debug = new CompanionDebugStore();
  const full = vi.fn(async (input: string) => input === '第一件' ? late.promise : '第二件的回答');
  const session = new CompanionSession({
    quick, prepare: async history => history.at(-1)!.text, full, play,
    debug, change: () => {}, error: error => { throw error; },
  });
  const first = session.send('第一件', false);
  await tick();
  await session.send('第二件', false);
  late.resolve('过期回答'); await first;
  expect(quick).not.toHaveBeenCalled();
  expect(full).toHaveBeenCalledTimes(2);
  expect(play.mock.calls.map(call => call[0])).toEqual(['第二件的回答']);
  for (const turn of debug.getSnapshot()) {
    expect(turn.quickEnabled).toBe(false);
    expect(turn.stages.quick_tts).toBeUndefined();
    expect(turn.stages.wait_audio).toBeUndefined();
  }
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
  expect(error.mock.calls[0][0].message).toContain('接话语音失败：鱼声 HTTP 404');
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
  expect(error.mock.calls[0][0].message).toContain('回复失败：组装失败');
  expect(full).not.toHaveBeenCalled();
});

it('can finish full context after quick generation fails, without inventing an assistant answer', async () => {
  const error = vi.fn(), play = vi.fn(async (_text: string) => {}), prepared = vi.fn(async (_history, a) => a);
  const session = new CompanionSession({ quick: async () => { throw new Error('HTTP 400'); }, prepare: prepared,
    full: async a => { expect(a).toBe(''); return '完整答复'; }, play, change: () => {}, error });
  await session.send('A');
  expect(play).toHaveBeenCalledOnce(); expect(play.mock.calls[0][0]).toBe('完整答复');
  expect(error.mock.calls[0][0].message).toContain('接话生成失败：HTTP 400');
});

it('keeps performance cues on the displayed line and only carries spoken words into speech and continuation', async () => {
  const play = vi.fn(async (_text: string) => {});
  const full = vi.fn(async (spoken: string) => '[[AVATAR: emotion=happy]] 收到' + spoken);
  let displayed: CompanionLine[] = [];
  const session = new CompanionSession({ quick: async () => '[[AVATAR: emotion=sad]] 等等',
    prepare: async (_history, quick) => quick, full, play, change: lines => { displayed = lines; }, error: e => { throw e; } });
  await session.send('这件呢');
  expect(full).toHaveBeenCalledWith('等等', expect.any(AbortSignal), true, undefined);
  expect(play.mock.calls.map(args => args[0])).toEqual(['等等', '收到等等']);
  expect(displayed[1]).toMatchObject({ text: '等等', performance: { emotion: 'sad' } });
  expect(displayed[2]).toMatchObject({ heard: '收到等等', performance: { emotion: 'happy' } });
});

it('keeps translated audio on the history line, uses the original for a′ and locks the language for the turn', async () => {
  const recording = new Blob(['original'], { type: 'audio/wav' });
  let lang = 'en';
  let history: CompanionLine[] = [];
  const preparedHistories: CompanionLine[][] = [];
  const spoken: (string | undefined)[][] = [];
  const full = vi.fn(async (a: string, _signal: AbortSignal, _enabled?: boolean, language?: string) => {
    expect(language).toBe('en');
    expect(a).toBe('看这里。');
    return '这件好看。<语音>It suits you.</语音>';
  });
  const first = new CompanionSession({
    language: () => lang,
    quick: async () => { lang = 'ja'; return '看这里。<语音 emotion="happy">Look here.</语音>'; },
    prepare: async (_, quick) => quick, full,
    play: async (text, _, heard, started, voice) => {
      spoken.push([text, voice.language, voice.emotion]);
      started('audio'); voice.record(recording); heard(text);
    },
    change: next => { history = next; }, error: e => { throw e; },
  });
  await first.send('看哪件？');
  expect(spoken).toEqual([['Look here.', 'en', 'happy'], ['It suits you.', 'en', undefined]]);
  expect(history[2]).toMatchObject({ text: '这件好看。', heard: '这件好看。', translation: 'It suits you.', audio: [recording] });
  const resumed = new CompanionSession({
    quick: async () => '', prepare: async (lines) => { preparedHistories.push(lines); return ''; },
    full: async () => '换一件。', play: async () => {}, change: next => { history = next; }, error: e => { throw e; },
  }, history);
  await resumed.send('还有吗？', false);
  expect(history.map(line => line.id)).toEqual([1, 2, 3, 4, 5]);
  expect(history[2].audio?.[0]).toBe(recording);
  expect(preparedHistories[0][2]).toMatchObject({ text: '这件好看。' });
  expect(preparedHistories[0][2]).not.toHaveProperty('audio');
  expect(preparedHistories[0][2]).not.toHaveProperty('translation');
});
