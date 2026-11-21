// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import * as transport from '../safeApi';
import * as capture from './capture';
import { DEFAULT_COMPANION_VIDEO, resolveCompanionVideoApi } from './videoProviders';
import { companionVideoReady, observeCompanionVideo, parseVideoObservation } from './vision';

vi.mock('./capture', async importOriginal => ({ ...await importOriginal<typeof import('./capture')>(), extractCompanionFrames: vi.fn(async () => [{ image: 'data:image/jpeg;base64,STILL', at: 5000 }]) }));
const videoApi = { baseUrl: 'https://video.example/v1', apiKey: 'video-key', model: 'video-model' };
const helper = { enabled: true, baseUrl: 'https://images.example/v1', apiKey: 'image-key', model: 'image-model' };
const clip = () => ({ blob: new Blob(['real-clip-bytes'], { type: 'video/mp4' }), from: 1000, to: 9000 });
const response = (content: string) => ({ choices: [{ message: { content } }] });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('submits the entire video via video_url and never calls image understanding by default', async () => {
  const call = vi.spyOn(transport, 'safeFetchJson').mockResolvedValue(response('{"summary":"镜头从红衣移到蓝衣","keyframes":[2,6]}'));
  const result = await observeCompanionVideo(clip(), videoApi, 'c', 'C', new AbortController().signal);
  expect(call).toHaveBeenCalledOnce();
  const [url, init, , , meta] = call.mock.calls[0];
  expect(url).toBe('https://video.example/v1/chat/completions');
  expect(init.headers).toMatchObject({ Authorization: 'Bearer video-key' });
  const body = JSON.parse(init.body as string);
  expect(body.model).toBe('video-model');
  expect(body.messages[0].content[0]).toEqual({ type: 'video_url', video_url: { url: 'data:video/mp4;base64,cmVhbC1jbGlwLWJ5dGVz' } });
  expect(init.body).not.toContain('image_url');
  expect(meta).toMatchObject({ appId: 'companion', purpose: '视频片段理解' });
  expect(result.text).toBe('镜头从红衣移到蓝衣'); expect(result.frames).toBeUndefined();
  expect(capture.extractCompanionFrames).not.toHaveBeenCalled();
});

it('posts camera bytes only to MiniMax with the effective key and refuses a redirect', async () => {
  const transportCall = vi.spyOn(transport, 'safeFetchJson').mockResolvedValue(response('街景'));
  const explicit = { ...DEFAULT_COMPANION_VIDEO, apiKey: 'camera-only' };
  expect(resolveCompanionVideoApi(explicit, 'global')).toEqual(explicit);
  for (const baseUrl of ['https://api.minimax.cn.example/v1', 'https://custom.example/v1', 'https://api.minimax.cn/v1?path=other']) {
    expect(resolveCompanionVideoApi({ ...DEFAULT_COMPANION_VIDEO, baseUrl }, 'global')?.apiKey).toBe('');
  }
  const selected = resolveCompanionVideoApi(undefined, 'global')!;
  await observeCompanionVideo(clip(), selected, 'c', 'C', new AbortController().signal);
  expect(transportCall).toHaveBeenCalledOnce();
  const [endpoint, init] = transportCall.mock.calls[0];
  expect(endpoint).toBe('https://api.minimax.cn/v1/chat/completions');
  expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer global' } });
  expect(JSON.parse(String(init.body)).messages[0].content[0].video_url).toMatchObject({ url: expect.stringMatching(/^data:video\/mp4;base64,/), fps: 1 });
});

it.each(['direct', 'helper'] as const)('extracts video-selected stills only after video understanding: %s', async mode => {
  const call = vi.spyOn(transport, 'safeFetchJson').mockResolvedValueOnce(response('{"summary":"视频摘要","keyframes":[2,6]}')).mockResolvedValueOnce(response('标签是纯棉'));
  const publish = vi.fn();
  const captured = clip();
  const signal = new AbortController().signal;
  const result = await observeCompanionVideo(captured, videoApi, 'c', 'C', signal, { mode, helper }, publish);
  expect(capture.extractCompanionFrames).toHaveBeenCalledWith(captured, [2, 6], signal);
  expect(publish.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(capture.extractCompanionFrames).mock.invocationCallOrder[0]);
  expect(publish).toHaveBeenCalledWith({ text: '视频摘要', from: 1000, to: 9000 });
  expect(call).toHaveBeenCalledTimes(mode === 'helper' ? 2 : 1);
  if (mode === 'helper') {
    expect(call.mock.calls[1][0]).toBe('https://images.example/v1/chat/completions');
    expect(call.mock.calls[1][1].body).toContain('image_url');
    expect(result.frames).toBeUndefined(); expect(result.text).toContain('纯棉');
  } else expect(result.frames?.[0].image).toContain('STILL');
});

it('keeps a valid video summary if optional still extraction fails', async () => {
  const call = vi.spyOn(transport, 'safeFetchJson').mockResolvedValue(response('可读的视频文字'));
  vi.mocked(capture.extractCompanionFrames).mockRejectedValueOnce(new Error('解码失败'));
  const result = await observeCompanionVideo(clip(), videoApi, 'c', 'C', new AbortController().signal, { mode: 'direct' });
  expect(result.text).toBe('可读的视频文字'); expect(result.imageNote).toContain('解码失败'); expect(call).toHaveBeenCalledOnce();
});

it('rejects a late video response after cancellation without extracting or publishing stills', async () => {
  const abort = new AbortController(), publish = vi.fn();
  vi.spyOn(transport, 'safeFetchJson').mockImplementation(async () => { abort.abort(); return response('迟到'); });
  await expect(observeCompanionVideo(clip(), videoApi, 'c', 'C', abort.signal, { mode: 'direct' }, publish)).rejects.toMatchObject({ name: 'AbortError' });
  expect(publish).not.toHaveBeenCalled(); expect(capture.extractCompanionFrames).not.toHaveBeenCalled();
});

it('bounds keyframe timestamps and falls back to the clip end for prose responses', () => {
  expect(parseVideoObservation('{"summary":"变化","keyframes":[-1,2,2,"4",3,10,4,5]}', 8)).toEqual({ text: '变化', seconds: [2,3,4] });
  expect(parseVideoObservation('变化', 8)).toEqual({ text: '变化', seconds: [7.8] });
});

it.each(['doubao', 'minimax'] as const)('sends whole clips with provider-specific parameters: %s', async provider => {
  const call = vi.spyOn(transport, 'safeFetchJson').mockResolvedValue(response('先看红衣，再看蓝衣'));
  await observeCompanionVideo(clip(), { ...videoApi, provider }, 'c', 'C', new AbortController().signal);
  const body = JSON.parse(call.mock.calls[0][1].body as string);
  expect(body.messages[0].content[0].video_url).toMatchObject({ url: expect.stringContaining('data:video/mp4;base64,'), fps: 1 });
  if (provider === 'doubao') expect(body.thinking).toEqual({ type: 'disabled' });
  else {
    expect(body).toMatchObject({ reasoning_effort: 'low', reasoning_split: true, max_completion_tokens: 4096 });
    expect(body).not.toHaveProperty('thinking'); expect(body).not.toHaveProperty('temperature'); expect(body).not.toHaveProperty('max_tokens');
  }
});

const zhipuApi = { ...videoApi, provider: 'zhipu' as const, model: 'glm-5.3-flash' };
it('sends Zhipu video bytes inline without touching any legacy upload service', async () => {
  expect(companionVideoReady(zhipuApi)).toBe(true);
  const otherFetch = vi.fn(); vi.stubGlobal('fetch', otherFetch);
  const call = vi.spyOn(transport, 'safeFetchJson').mockResolvedValue(response('视频理解'));
  const legacy = { ...zhipuApi, upload: { baseUrl: 'https://retired-storage.example', token: 'retired-token' } };
  await observeCompanionVideo(clip(), legacy, 'c', 'C', new AbortController().signal);
  const body = JSON.parse(call.mock.calls[0][1].body as string);
  expect(body.messages[0].content[0].video_url).toEqual({ url: 'data:video/mp4;base64,cmVhbC1jbGlwLWJ5dGVz' });
  expect(body).not.toHaveProperty('thinking');
  expect(otherFetch).not.toHaveBeenCalled(); expect(call).toHaveBeenCalledOnce();
  expect(call.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer video-key' });
  expect(JSON.stringify(call.mock.calls)).not.toContain('retired-');
});

it('never falls back to storage or stills when direct video fails or returns late', async () => {
  const otherFetch = vi.fn(); vi.stubGlobal('fetch', otherFetch);
  const call = vi.spyOn(transport, 'safeFetchJson').mockRejectedValue(new Error('video unsupported'));
  await expect(observeCompanionVideo(clip(), zhipuApi, 'c', 'C', new AbortController().signal)).rejects.toThrow('video unsupported');
  expect(call).toHaveBeenCalledOnce(); expect(otherFetch).not.toHaveBeenCalled(); expect(capture.extractCompanionFrames).not.toHaveBeenCalled();
  const abort = new AbortController(), publish = vi.fn();
  vi.mocked(transport.safeFetchJson).mockImplementation(async () => { abort.abort(); return response('late'); });
  await expect(observeCompanionVideo(clip(), zhipuApi, 'c', 'C', abort.signal, { mode: 'none' }, publish)).rejects.toMatchObject({ name: 'AbortError' });
  expect(publish).not.toHaveBeenCalled(); expect(otherFetch).not.toHaveBeenCalled();
});
