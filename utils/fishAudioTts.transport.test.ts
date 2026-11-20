import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { synthesizeSpeechFishDetailed } from './fishAudioTts';
import { getCachedTts, saveCachedTts } from './ttsCache';
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false }, CapacitorHttp: {} }));
vi.mock('./ttsCache', () => ({ hashTtsParams: () => 'fish-test', getCachedTts: vi.fn(), saveCachedTts: vi.fn(async () => {}) }));
vi.mock('./proxyWorker', () => ({ getProxyWorkerUrl: () => 'https://proxy.friedsully.com' }));
const char = { id: 'c', voiceProfile: { fishReferenceId: 'test-reference', fishModel: 's2-pro' } } as any;
const api = { fishAudioApiKey: 'test-only', fishAudioModel: 's2.1-pro', ttsProvider: 'fishaudio' } as any;
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getCachedTts).mockResolvedValue(null); });
afterEach(() => vi.unstubAllGlobals());

it.each(['friedsully.com', 'test.friedsully.com', 'sully-os-test.example.workers.dev'])('uses the existing Worker Fish route on %s', async hostname => {
  vi.stubGlobal('window', { location: { protocol: 'https:', hostname } });
  const transport = vi.fn(async () => new Response(new Blob(['audio'], { type: 'audio/mpeg' })));
  vi.stubGlobal('fetch', transport);
  const result = await synthesizeSpeechFishDetailed('固定测试短句', char, api);
  expect(transport.mock.calls[0][0]).toBe('https://proxy.friedsully.com/fishaudio/tts?model=s2-pro');
  expect(transport.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer test-only' } });
  URL.revokeObjectURL(result.url);
});

it('tests the new key over the network even with cached speech and passes cancellation through', async () => {
  vi.stubGlobal('window', { location: { protocol: 'https:', hostname: 'test.friedsully.com' } });
  vi.mocked(getCachedTts).mockResolvedValue(new Blob(['old-successful-audio']));
  const transport = vi.fn(async () => new Response('Invalid Token', { status: 401 }));
  vi.stubGlobal('fetch', transport);
  const controller = new AbortController();
  await expect(synthesizeSpeechFishDetailed('固定测试短句', char, api, { skipCache: true, signal: controller.signal })).rejects.toThrow('401');
  expect(transport.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
  expect(getCachedTts).not.toHaveBeenCalled(); expect(saveCachedTts).not.toHaveBeenCalled();
  controller.abort();
  await expect(synthesizeSpeechFishDetailed('固定测试短句', char, api, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(transport).toHaveBeenCalledOnce();
});
