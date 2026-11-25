// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionVoice } from './voice';
import { streamElevenLabsSpeech } from '../elevenLabsStream';
import { resolveTtsProvider } from '../ttsProvider';

const pcm = vi.hoisted(() => ({ currentTime: 0, push: vi.fn(), stop: vi.fn() }));
vi.mock('../voiceStream', () => ({ splitSpeechText: (text: string) => [text], PcmVoicePlayer: class {
  get currentTime() { return pcm.currentTime; }
  push = pcm.push; stop = pcm.stop;
  async resume() {} async finish() {}
} }));
vi.mock('../elevenLabsStream', () => ({ streamElevenLabsSpeech: vi.fn() }));
vi.mock('../ttsProvider', () => ({ resolveTtsProvider: vi.fn(() => 'elevenlabs') }));
vi.mock('../ttsRouter', () => ({ assertTtsLanguageSupported: () => {}, synthesizeSpeechDetailed: async () => ({ url: 'blob:voice', blob: new Blob(['audio'], { type: 'audio/mpeg' }) }), stripTtsMarkupForDisplay: (text: string) => text }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); pcm.currentTime = 0; });

it('marks PCM as audible only after playback clock advances, not when network audio arrives', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('AudioContext', class { async resume() {} });
  let resolve!: () => void;
  vi.mocked(streamElevenLabsSpeech).mockImplementation(async (_text, _char, _api, options) => {
    options?.onAudio?.(new Uint8Array([1, 2]));
    await new Promise<void>(r => { resolve = r; });
    return { blob: new Blob(), cues: [], duration: 1 };
  });
  const started = vi.fn(), voice = new CompanionVoice();
  const done = voice.play('a', {} as any, {} as any, new AbortController().signal, () => {}, started);
  await vi.advanceTimersByTimeAsync(80);
  expect(pcm.push).toHaveBeenCalledOnce(); expect(started).not.toHaveBeenCalled();
  pcm.currentTime = 0.05; await vi.advanceTimersByTimeAsync(80);
  expect(started).toHaveBeenCalledOnce();
  resolve(); await done; expect(started).toHaveBeenCalledOnce();
});

it('marks MP3 audible on playing, not synthesis or play() resolving', async () => {
  vi.mocked(resolveTtsProvider).mockReturnValue('minimax');
  let audio: any;
  vi.stubGlobal('Audio', class {
    onplaying?: () => void; onended?: () => void;
    constructor() { audio = this; }
    async play() {} pause() {} removeAttribute() {}
  });
  URL.revokeObjectURL = vi.fn();
  const started = vi.fn();
  const done = new CompanionVoice().play('a', {} as any, {} as any, new AbortController().signal, () => {}, started);
  await Promise.resolve(); await Promise.resolve();
  expect(started).not.toHaveBeenCalled();
  audio.onplaying(); audio.onplaying?.(); expect(started).toHaveBeenCalledOnce();
  audio.onended(); await done; expect(audio.onplaying).toBeNull();
});
