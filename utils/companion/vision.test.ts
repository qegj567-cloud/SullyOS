// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import * as transport from '../safeApi';
import * as capture from './capture';
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

const zhipuApi = { ...videoApi, provider: 'zhipu' as const, model: 'glm-4.6v', upload: { baseUrl: 'https://clips.example', token: 'upload-secret' } };
it('requires Zhipu upload configuration and sends the temporary video URL with isolated credentials, then deletes it', async () => {
  expect(companionVideoReady({ ...zhipuApi, upload: undefined })).toBe(false);
  const upload = vi.fn().mockResolvedValue({ ok: true, status: 204 }); vi.stubGlobal('fetch', upload);
  const call = vi.spyOn(transport, 'safeFetchJson').mockResolvedValue(response('视频理解'));
  await observeCompanionVideo(clip(), zhipuApi, 'c', 'C', new AbortController().signal);
  const body = JSON.parse(call.mock.calls[0][1].body as string);
  const url = body.messages[0].content[0].video_url.url;
  expect(url).toMatch(/^https:\/\/clips.example\/clips\/[a-f0-9]{32}$/);
  expect(body.thinking).toEqual({ type: 'disabled' }); expect(body.messages[0].content[0].video_url).not.toHaveProperty('fps');
  expect(upload.mock.calls[0]).toEqual([url, expect.objectContaining({ method: 'PUT', headers: { Authorization: 'Bearer upload-secret', 'Content-Type': 'video/mp4' }, body: expect.any(Blob), redirect: 'error' })]);
  expect(call.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer video-key' });
  expect(upload.mock.calls[1]).toEqual([url, expect.objectContaining({ method: 'DELETE' })]);
  expect(JSON.stringify(call.mock.calls)).not.toContain('upload-secret'); expect(JSON.stringify(upload.mock.calls)).not.toContain('video-key');
});

it('does not call the model after a failed or cancelled upload', async () => {
  const upload = vi.fn().mockResolvedValue({ ok: false, status: 401 }); vi.stubGlobal('fetch', upload);
  const call = vi.spyOn(transport, 'safeFetchJson');
  await expect(observeCompanionVideo(clip(), zhipuApi, 'c', 'C', new AbortController().signal)).rejects.toThrow('401');
  expect(call).not.toHaveBeenCalled();
  const abort = new AbortController();
  upload.mockImplementation(async (_url, init) => { if (init.method === 'PUT') abort.abort(); return { ok: true }; });
  await expect(observeCompanionVideo(clip(), zhipuApi, 'c', 'C', abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(call).not.toHaveBeenCalled(); expect(upload).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ method: 'DELETE' }));
});

it('deletes the temporary clip if model generation fails or returns after cancellation', async () => {
  const upload = vi.fn().mockResolvedValue({ ok: true, status: 204 }); vi.stubGlobal('fetch', upload);
  vi.spyOn(transport, 'safeFetchJson').mockRejectedValue(new Error('model failed'));
  await expect(observeCompanionVideo(clip(), zhipuApi, 'c', 'C', new AbortController().signal)).rejects.toThrow('model failed');
  expect(upload).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ method: 'DELETE' }));
  const abort = new AbortController(), publish = vi.fn();
  vi.mocked(transport.safeFetchJson).mockImplementation(async () => { abort.abort(); return response('late'); });
  await expect(observeCompanionVideo(clip(), zhipuApi, 'c', 'C', abort.signal, { mode: 'none' }, publish)).rejects.toMatchObject({ name: 'AbortError' });
  expect(publish).not.toHaveBeenCalled(); expect(upload).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ method: 'DELETE' }));
});
