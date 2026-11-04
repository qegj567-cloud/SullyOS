import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIConfig, CharacterProfile } from '../types';
import { streamElevenLabsSpeech, streamElevenLabsDialogue, VoiceTextQueue, streamElevenLabsSequence } from './elevenLabsStream';
import { DB } from './db';

vi.mock('./db', () => ({ DB: { getAssetRaw: vi.fn(), saveAssetRaw: vi.fn() } }));
vi.mock('./proxyWorker', () => ({ getProxyWorkerUrl: () => 'https://proxy.example.test' }));
const char = { id: 'a', voiceProfile: { elevenLabsVoiceId: 'voice_abcdefgh' } } as CharacterProfile;
const config = { elevenLabsApiKey: 'test-only', elevenLabsModel: 'eleven_v4' } as APIConfig;
const frame = { audio_base64: 'AAD/fw==', alignment: { characters: ['你', '好'], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.2] } };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(DB.getAssetRaw).mockResolvedValue(null); vi.mocked(DB.saveAssetRaw).mockResolvedValue(undefined); });
afterEach(() => vi.unstubAllGlobals());

describe('ElevenLabs streaming synthesis', () => {
  it('starts speaking the first sentence while more model text is still pending', async () => {
    const queue = new VoiceTextQueue();
    const audio: Uint8Array[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(frame)));
    vi.stubGlobal('fetch', fetcher);
    const pending = streamElevenLabsSequence(queue, char, config, { onAudio: pcm => { audio.push(pcm); } });
    queue.append('你好。');
    await vi.waitFor(() => expect(audio).toHaveLength(1));
    queue.append('第二句。'); queue.finish();
    const result = await pending;
    expect(audio).toHaveLength(2);
    expect(result.blob.size).toBe(52);
    expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).previous_text).toBe('你好。');
  });
  it('stops a sentence queue waiting for model output without making a request', async () => {
    const queue = new VoiceTextQueue();
    const ac = new AbortController();
    const pending = streamElevenLabsSequence(queue, char, config, { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('streams PCM before completion and stores a replayable WAV with timing', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'request-id': 'req-1' } })));
    const audio: Uint8Array[] = [];
    const pending = streamElevenLabsSpeech('你好', char, config, { onAudio: b => { audio.push(b); } });
    await vi.waitFor(() => expect(controller).toBeDefined());
    controller.enqueue(new TextEncoder().encode(JSON.stringify(frame) + '\n'));
    await vi.waitFor(() => expect(audio).toHaveLength(1));
    expect(DB.saveAssetRaw).not.toHaveBeenCalled();
    controller.close();
    const result = await pending;
    expect(result.blob.type).toBe('audio/wav');
    expect(result.cues).toEqual([{ text: '你', start: 0, end: 0.1 }, { text: '好', start: 0.1, end: 0.2 }]);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)).toMatchObject({ text: '你好', model_id: 'eleven_v4' });
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('timestamps=1&output_format=pcm_24000');
    expect(DB.saveAssetRaw).toHaveBeenCalledWith(expect.stringMatching(/^tts_/), expect.objectContaining({ blob: result.blob, cues: result.cues }));
  });

  it('offsets each HTTP chunk by decoded PCM duration and replays identical cached timing', async () => {
    const audioBase64 = Buffer.alloc(24000).toString('base64'); // half a second of 16-bit mono
    const responseFrame = (text: string) => ({ audio_base64: audioBase64, normalized_alignment: { characters: [text], character_start_times_seconds: [.1], character_end_times_seconds: [.4] } });
    const fetcher = vi.fn(async () => new Response([responseFrame('甲'), responseFrame('乙')].map(frame => JSON.stringify(frame)).join('\n')));
    vi.stubGlobal('fetch', fetcher);
    const recorded = await streamElevenLabsSpeech('甲乙', char, config);
    expect(recorded.duration).toBe(1);
    expect(recorded.cues).toEqual([{ text: '甲', start: .1, end: .4 }, { text: '乙', start: .6, end: .9 }]);
    vi.mocked(DB.getAssetRaw).mockResolvedValue(recorded);
    const replayed: Uint8Array[] = [];
    const cached = await streamElevenLabsSpeech('甲乙', char, config, { onAudio: pcm => { replayed.push(pcm); } });
    expect(cached.cues).toEqual(recorded.cues);
    expect(replayed.reduce((sum, pcm) => sum + pcm.length, 0)).toBe(48000);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('splits long text without truncation and stitches the following request', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(frame), { headers: { 'request-id': `req-${vi.mocked(fetch).mock.calls.length}` } }));
    vi.stubGlobal('fetch', fetcher);
    const text = '你好。'.repeat(4000);
    await streamElevenLabsSpeech(text, char, config);
    const bodies = fetcher.mock.calls.map((args: any) => JSON.parse(args[1].body));
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.map(b => b.text).join('')).toBe(text);
    expect(bodies[1].previous_request_ids).toEqual(['req-1']);
    expect(bodies.every(b => Array.from(b.text).length <= 1800)).toBe(true);
  });

  it('uses the dialogue endpoint and preserves ordered per-speaker inputs', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(frame)));
    vi.stubGlobal('fetch', fetcher);
    await streamElevenLabsDialogue([{ text: '你好', character: char }, { text: '你也好', character: { ...char, id: 'b', voiceProfile: { elevenLabsVoiceId: 'voice_ijklmnop' } } }], config);
    expect(String(fetcher.mock.calls[0][0])).toContain('mode=dialogue');
    expect(JSON.parse((fetcher.mock.calls[0] as any)[1].body).inputs).toEqual([
      { text: '你好', voice_id: 'voice_abcdefgh' }, { text: '你也好', voice_id: 'voice_ijklmnop' },
    ]);
  });

  it('rejects unsupported multi-voice Turbo before spending credits', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(streamElevenLabsDialogue([{ text: '你好', character: char }, { text: '好', character: { ...char, voiceProfile: { elevenLabsVoiceId: 'voice_ijklmnop' } } }], { ...config, elevenLabsModel: 'eleven_v4_turbo' })).rejects.toThrow('Turbo');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports exhausted credits clearly and never retries or downgrades', async () => {
    const fetcher = vi.fn(async () => new Response('{"detail":{"message":"quota exceeded"}}', { status: 402 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(streamElevenLabsSpeech('额度检查', char, config)).rejects.toThrow('ElevenLabs 额度不足');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(DB.saveAssetRaw).not.toHaveBeenCalled();
  });

  it('never caches or retries an interrupted generation', async () => {
    const ac = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(frame) + '\n')));
    await expect(streamElevenLabsSpeech('你好', char, config, { signal: ac.signal, onAudio: () => ac.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(DB.saveAssetRaw).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
