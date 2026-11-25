import { afterEach, expect, it, vi } from 'vitest';
import { companionHistoryAudio } from './historyAudio';

afterEach(() => vi.unstubAllGlobals());

it('downloads a single recorded take with its exact original bytes and MIME type', async () => {
  const audio = new Blob(['original'], { type: 'audio/mpeg' });
  expect(await companionHistoryAudio([audio])).toBe(audio);
  await expect(companionHistoryAudio([])).rejects.toThrow('还没有语音');
});

it('joins independently encoded clips in order into one playable mono WAV', async () => {
  class Decoder {
    async decodeAudioData(bytes: ArrayBuffer) {
      const sample = new Uint8Array(bytes)[0] === 1 ? 0.5 : -1;
      return { numberOfChannels: 1, length: 1, getChannelData: () => [sample] };
    }
  }
  vi.stubGlobal('OfflineAudioContext', Decoder);
  const file = await companionHistoryAudio([1, 2].map(n => new Blob([Uint8Array.of(n)])));
  const bytes = await file.arrayBuffer();
  const view = new DataView(bytes);
  expect(file.type).toBe('audio/wav');
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF');
  expect(view.getUint32(24, true)).toBe(44100);
  expect(view.getUint32(40, true)).toBe(4);
  expect(view.getInt16(44, true)).toBe(16384);
  expect(view.getInt16(46, true)).toBe(-32768);
});
