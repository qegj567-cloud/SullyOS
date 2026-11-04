import { describe, expect, it, vi } from 'vitest';
import { readVoiceJsonStream, splitSpeechText, pcmToWav, PcmVoicePlayer } from './voiceStream';

describe('voice streaming boundaries', () => {
  it('delivers the first complete JSON before the response closes, across UTF-8 boundaries', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream({ start(c) { controller = c; } }));
    const received: any[] = [];
    const pending = readVoiceJsonStream(response, item => { received.push(item); });
    const bytes = new TextEncoder().encode('{"text":"你好"}\n{"audio_base64":"AAA="}');
    controller.enqueue(bytes.slice(0, 11));
    controller.enqueue(bytes.slice(11, 18));
    await vi.waitFor(() => expect(received).toEqual([{ text: '你好' }]));
    controller.enqueue(bytes.slice(18));
    controller.close();
    await pending;
    expect(received).toEqual([{ text: '你好' }, { audio_base64: 'AAA=' }]);
  });

  it('rejects upstream in-stream errors instead of caching a partial success', async () => {
    await expect(readVoiceJsonStream(new Response('{"error":{"message":"quota exceeded"}}\n'), () => {}))
      .rejects.toThrow('quota exceeded');
  });

  it('cancels an idle reader immediately when stopped', async () => {
    const cancel = vi.fn();
    const ac = new AbortController();
    const response = new Response(new ReadableStream({ cancel }));
    const pending = readVoiceJsonStream(response, () => {}, ac.signal);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('splits long speech without losing spaces, tags, IPA or Unicode characters', () => {
    const original = '[very softly]你好。\n今天读 /həˈləʊ/，然后慢慢说。 A long sentence with words. 𠮷野。';
    const parts = splitSpeechText(original, 24);
    expect(parts.join('')).toBe(original);
    expect(parts.every(p => Array.from(p).length <= 24)).toBe(true);
    expect(parts.some(p => p.includes('[very softly]'))).toBe(true);
    expect(parts.some(p => p.includes('/həˈləʊ/'))).toBe(true);
    expect(() => splitSpeechText('[this direction cannot fit]', 5)).toThrow();
  });

  it('writes a playable WAV header for the complete PCM, without extra chunk headers', async () => {
    const wav = pcmToWav([new Uint8Array([0, 128]), new Uint8Array([255, 127])], 24000);
    const bytes = await wav.arrayBuffer();
    const header = new DataView(bytes);
    expect(wav.type).toBe('audio/wav');
    expect(header.getUint32(24, true)).toBe(24000);
    expect(header.getUint32(40, true)).toBe(4);
    expect([...new Uint8Array(bytes).slice(44)]).toEqual([0, 128, 255, 127]);
  });
});

describe('PCM playback scheduling', () => {
  function fakeContext() {
    const buffers: Float32Array[] = [];
    const sources: any[] = [];
    const context = {
      currentTime: 10, state: 'running', destination: {},
      resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
      createBuffer: (_channels: number, length: number, rate: number) => {
        const data = new Float32Array(length); buffers.push(data);
        return { duration: length / rate, copyToChannel: (samples: Float32Array) => data.set(samples) };
      },
      createBufferSource: () => {
        const source = { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null, buffer: null };
        sources.push(source); return source;
      },
    };
    return { context, buffers, sources };
  }

  it('queues split 16-bit samples once, reports the media clock across underruns and stops all sources', async () => {
    const { context, buffers, sources } = fakeContext();
    const player = new PcmVoicePlayer(context as unknown as AudioContext, 2);
    player.push(new Uint8Array([0]));
    expect(sources).toHaveLength(0);
    player.push(new Uint8Array([128, 255, 127]));
    expect([...buffers[0]]).toEqual([-1, 32767 / 32768]);
    expect(sources[0].start).toHaveBeenCalledWith(10.04);
    context.currentTime = 10.54;
    expect(player.currentTime).toBeCloseTo(0.5);
    context.currentTime = 20;
    expect(player.currentTime).toBe(1);
    player.push(new Uint8Array([0, 0]));
    context.currentTime = 20.29;
    expect(player.currentTime).toBeCloseTo(1.25);
    player.stop();
    expect(sources.every(s => s.stop.mock.calls.length === 1)).toBe(true);
    expect(() => player.push(new Uint8Array([0, 0]))).toThrow();
  });
});

describe('timed captions', () => {
  it('does not highlight a word before its start or leak a direction crossing the display window', async () => {
    const { voiceCaptionAt } = await import('./voiceStream');
    const cues = [...'[very softly]你好'].map((text, i) => ({ text, start: 1 + i / 10, end: 1.1 + i / 10 }));
    expect(voiceCaptionAt(cues, 0)).toEqual({ spoken: '', upcoming: '你好' });
    expect(voiceCaptionAt(cues, 2.35)).toEqual({ spoken: '你', upcoming: '好' });
    expect(voiceCaptionAt(cues, 5)).toEqual({ spoken: '你好', upcoming: '' });
  });
});

it('explains when an old proxy returned MP3 instead of timestamp JSON', async () => {
  await expect(readVoiceJsonStream(new Response('ID3', { headers: { 'Content-Type': 'audio/mpeg' } }), () => {})).rejects.toThrow('代理');
});
