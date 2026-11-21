// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { startCompanionListening } from './listening';
afterEach(() => { vi.useRealTimers(); delete (window as any).SpeechRecognition; });
it('interrupts on interim speech, sends only finalized text and stops restarting after disposal', async () => {
  vi.useFakeTimers();
  let recognition: any;
  (window as any).SpeechRecognition = class {
    start = vi.fn(); abort = vi.fn();
    constructor() { recognition = this; }
  };
  const callbacks = { speech: vi.fn(), partial: vi.fn(), final: vi.fn(), error: vi.fn(), speechEnded: vi.fn() };
  const stop = startCompanionListening(callbacks);
  const result = (text: string, isFinal: boolean) => ({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] });
  recognition.onresult(result('我是说旁边', false));
  expect(callbacks.speech).toHaveBeenCalledOnce(); expect(callbacks.final).not.toHaveBeenCalled();
  recognition.onresult(result('我是说旁边那件', true));
  await vi.advanceTimersByTimeAsync(650);
  expect(callbacks.final).toHaveBeenCalledWith('我是说旁边那件');
  recognition.onresult(result('还想说', false));
  recognition.onend();
  expect(callbacks.partial).toHaveBeenLastCalledWith('');
  expect(callbacks.speechEnded).toHaveBeenCalledOnce();
  expect(callbacks.final).toHaveBeenCalledTimes(1);
  stop(); await vi.advanceTimersByTimeAsync(1000);
  expect(recognition.start).toHaveBeenCalledOnce();
  expect(recognition.abort).toHaveBeenCalledOnce();
});
