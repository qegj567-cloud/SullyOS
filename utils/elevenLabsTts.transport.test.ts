import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { APIConfig, CharacterProfile } from '../types';
import { synthesizeSpeechElevenLabsDetailed } from './elevenLabsTts';
import { getCachedTts, saveCachedTts } from './ttsCache';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
  CapacitorHttp: { request: vi.fn() },
}));
vi.mock('./ttsCache', async (importOriginal) => ({
  ...await importOriginal<typeof import('./ttsCache')>(),
  getCachedTts: vi.fn(), saveCachedTts: vi.fn(),
}));
vi.mock('./proxyWorker', () => ({ getProxyWorkerUrl: () => 'https://proxy.example.test' }));

const character = { id: 'char-v4', voiceProfile: { elevenLabsVoiceId: '21m00Tcm4TlvDq8ikWAM', speed: 0.85 } } as CharacterProfile;
const config = { baseUrl: '', apiKey: '', model: '', elevenLabsApiKey: 'test-only-key', elevenLabsModel: 'eleven_v4' } as APIConfig;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
  vi.mocked(getCachedTts).mockResolvedValue(null);
  vi.mocked(saveCachedTts).mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('ElevenLabs v4 transport', () => {
  it.each(['eleven_v4', 'eleven_v4_turbo'])('sends the full script through the web proxy and persists %s audio', async (model) => {
    vi.stubGlobal('window', { location: { protocol: 'https:', hostname: 'localhost' } });
    const fetch = vi.fn().mockResolvedValue(new Response('audio', { headers: { 'content-type': 'audio/mpeg' } }));
    vi.stubGlobal('fetch', fetch);
    const script = '[Warm, conversational tone] 你好 [door slams] [long pause] /ˈsʌli/';
    const result = await synthesizeSpeechElevenLabsDetailed(script, character, { ...config, elevenLabsModel: model });
    expect(fetch.mock.calls[0][0]).toContain('/api/elevenlabs/tts?voice_id=21m00Tcm4TlvDq8ikWAM');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      model_id: model, text: script, voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    });
    expect(result.blob?.size).toBe(5);
    expect(saveCachedTts).toHaveBeenCalledWith(expect.any(String), result.blob);
    URL.revokeObjectURL(result.url);
  });

  it('uses the central Worker for static deployment and keeps models separate in the audio cache', async () => {
    vi.stubGlobal('window', { location: { protocol: 'https:', hostname: 'example.github.io' } });
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('audio')));
    vi.stubGlobal('fetch', fetch);
    const v4 = await synthesizeSpeechElevenLabsDetailed('你好', character, config);
    const turbo = await synthesizeSpeechElevenLabsDetailed('你好', character, { ...config, elevenLabsModel: 'eleven_v4_turbo' });
    expect(fetch.mock.calls[0][0]).toContain('https://proxy.example.test/elevenlabs/tts?');
    expect(vi.mocked(getCachedTts).mock.calls[0][0]).not.toBe(vi.mocked(getCachedTts).mock.calls[1][0]);
    URL.revokeObjectURL(v4.url);
    URL.revokeObjectURL(turbo.url);
  });

  it('uses the same supported v4 payload on native platforms', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(CapacitorHttp.request).mockResolvedValue({ status: 200, data: btoa('audio'), headers: {}, url: '' });
    const result = await synthesizeSpeechElevenLabsDetailed('[whispers] 你好', character, config);
    expect(CapacitorHttp.request).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining('https://api.elevenlabs.io/v1/text-to-speech/'),
      data: { text: '[whispers] 你好', model_id: 'eleven_v4', voice_settings: { stability: 0.5, similarity_boost: 0.8 } },
    }));
    expect(result.blob?.size).toBe(5);
    URL.revokeObjectURL(result.url);
  });

  it('reuses cached audio without making a paid request', async () => {
    const blob = new Blob(['cached'], { type: 'audio/mpeg' });
    vi.mocked(getCachedTts).mockResolvedValue(blob);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await synthesizeSpeechElevenLabsDetailed('你好', character, config);
    expect(result.blob).toBe(blob);
    expect(fetch).not.toHaveBeenCalled();
    URL.revokeObjectURL(result.url);
  });

  it('reports v4 errors without falling back to another model or caching failed output', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('model unavailable', { status: 422 }));
    vi.stubGlobal('fetch', fetch);
    await expect(synthesizeSpeechElevenLabsDetailed('你好', character, config)).rejects.toThrow('HTTP 422');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(saveCachedTts).not.toHaveBeenCalled();
  });

  it('rejects over-limit v4 scripts explicitly without truncation or a paid request', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('audio'));
    vi.stubGlobal('fetch', fetch);
    await expect(synthesizeSpeechElevenLabsDetailed('字'.repeat(10001), character, config)).rejects.toThrow('10000');
    expect(fetch).not.toHaveBeenCalled();
  });
});
