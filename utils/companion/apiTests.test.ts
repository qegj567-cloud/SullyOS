// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { safeFetchJson } from '../safeApi';
import { companionTestImage, companionTestVideo } from './testMedia';
import { startDoubaoListening } from './doubaoListening';
import { startCompanionListening } from './listening';
import { CompanionVoice } from './voice';
import { redactCompanionTestText, testCompanionDialogue, testCompanionImage, testCompanionStt, testCompanionVideo, testCompanionVoice } from './apiTests';

vi.mock('../safeApi', () => ({ safeFetchJson: vi.fn(async () => ({ choices: [{ message: { content: '返回的正文' } }] })), extractContent: (data: any) => data.choices?.[0]?.message?.content || '' }));
vi.mock('./testMedia', () => ({ companionTestImage: vi.fn(() => 'data:image/png;base64,TEST'), companionTestVideo: vi.fn(async () => ({ blob: new Blob(['synthetic-video'], { type: 'video/mp4' }), from: 0, to: 2000 })) }));
vi.mock('./doubaoListening', () => ({ startDoubaoListening: vi.fn(() => vi.fn()) }));
vi.mock('./listening', () => ({ startCompanionListening: vi.fn(() => vi.fn()) }));
vi.mock('./voice', () => ({ CompanionVoice: class { prime = vi.fn(); close = vi.fn(); async play(...args: any[]) { args[5]?.(); } } }));
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); });
const signal = () => new AbortController().signal;

it('tests the actual character route with atomic credentials and a diagnostic prompt, without persona/history', async () => {
  const api = { baseUrl: 'https://global.test/v1', model: 'global', apiKey: 'global-key', maxTokens: 8000 } as any;
  const char = { id: 'c', name: 'C', systemPrompt: 'must-not-send-persona', dialogueApi: { baseUrl: 'https://role.test/v1', model: 'role', apiKey: 'role-key', maxTokens: 1024 } } as any;
  expect(await testCompanionDialogue(api, char, signal())).toMatchObject({ summary: '已收到对话模型回复' });
  const [url, options, retries, , meta] = vi.mocked(safeFetchJson).mock.calls[0];
  expect(url).toBe('https://role.test/v1/chat/completions'); expect(retries).toBe(0);
  expect(options.headers).toMatchObject({ Authorization: 'Bearer role-key' });
  expect(JSON.parse(String(options.body))).toMatchObject({ model: 'role', max_tokens: 1024 });
  expect(options.body).not.toContain('must-not-send-persona'); expect(options.body).not.toContain('global-key');
  expect(meta).toMatchObject({ appId: 'companion', charId: 'c', purpose: '测试连接' });
});

it('sends a complete MP4 through the selected video protocol, independently from the synthetic image test', async () => {
  const api = { provider: 'doubao', baseUrl: 'https://video.test', model: 'video', apiKey: 'video-key' } as const;
  const result = await testCompanionVideo(api, signal(), vi.fn());
  const options = vi.mocked(safeFetchJson).mock.calls[0][1], body = JSON.parse(String(options.body));
  expect(body.messages[0].content[0]).toMatchObject({ type: 'video_url', video_url: { url: expect.stringMatching(/^data:video\/mp4;base64,/), fps: 1 } });
  expect(body.thinking).toEqual({ type: 'disabled' }); expect(body.messages[0].content).toHaveLength(2);
  expect(companionTestImage).not.toHaveBeenCalled(); expect(result.summary).toContain('红色圆形 → 蓝色方形');
  await testCompanionImage({ baseUrl: 'https://image.test', model: 'image', apiKey: 'image-key' } as any, signal());
  expect(JSON.parse(String(vi.mocked(safeFetchJson).mock.calls[1][1].body)).messages[0].content[1].type).toBe('image_url');
  await testCompanionImage({ baseUrl: 'https://main.test', model: 'reasoning-main', apiKey: 'main-key', maxTokens: 8000, stream: true } as any, signal(), undefined, true);
  expect(JSON.parse(String(vi.mocked(safeFetchJson).mock.calls[2][1].body))).toMatchObject({ model: 'reasoning-main', max_tokens: 8000, stream: true });
});

it('does not count an empty model response or an aborted sample as success', async () => {
  vi.mocked(safeFetchJson).mockResolvedValueOnce({ choices: [{ message: { content: '' } }] });
  await expect(testCompanionDialogue({ baseUrl: 'https://test.test', model: 'm', apiKey: '' } as any, undefined, signal())).rejects.toThrow('没有返回正文');
  vi.mocked(safeFetchJson).mockClear();
  const abort = new AbortController();
  vi.mocked(companionTestVideo).mockImplementationOnce(async () => { abort.abort(); return { blob: new Blob(['test'], { type: 'video/mp4' }), from: 0, to: 2000 }; });
  await expect(testCompanionVideo({ baseUrl: 'https://test.test', model: 'm', apiKey: '' }, abort.signal, vi.fn())).rejects.toMatchObject({ name: 'AbortError' });
  expect(safeFetchJson).not.toHaveBeenCalled();
});

it('waits for a definite STT sentence, rather than passing on connection or interim text', async () => {
  const stop = vi.fn(), progress = vi.fn(), completed = vi.fn();
  vi.mocked(startDoubaoListening).mockReturnValueOnce(stop);
  const task = testCompanionStt({ provider: 'doubao', apiKey: 'speech-key', resourceId: 'volc.seedasr.sauc.duration' }, signal(), progress).then(completed);
  const cb = vi.mocked(startDoubaoListening).mock.calls[0][1];
  cb.state?.('豆包正在听'); cb.partial('测试'); await Promise.resolve();
  expect(completed).not.toHaveBeenCalled(); expect(startCompanionListening).not.toHaveBeenCalled();
  cb.final('测试一句话'); await task;
  expect(stop).toHaveBeenCalledOnce(); expect(completed).toHaveBeenCalledWith({ summary: '已收到最终识别文字', detail: '测试一句话' });
  cb.final('迟到的结果'); expect(completed).toHaveBeenCalledOnce();
});

it('stops STT on cancel and timeout, and never changes recognition providers', async () => {
  vi.useFakeTimers(); const stop = vi.fn(); vi.mocked(startCompanionListening).mockReturnValue(stop);
  const config = { provider: 'browser', apiKey: '', resourceId: 'volc.seedasr.sauc.duration' } as const;
  const abort = new AbortController(), first = testCompanionStt(config, abort.signal, vi.fn());
  const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' }); abort.abort(); await cancelled;
  const second = testCompanionStt(config, signal(), vi.fn());
  const timedOut = expect(second).rejects.toThrow('30 秒'); await vi.advanceTimersByTimeAsync(30_000); await timedOut;
  expect(stop).toHaveBeenCalledTimes(2); expect(startDoubaoListening).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it('requires actual playback for a voice pass and hides echoed keys and URLs in diagnostic output', async () => {
  expect(await testCompanionVoice({} as any, {} as any, signal(), vi.fn())).toMatchObject({ summary: '已合成并完成播放' });
  vi.spyOn(CompanionVoice.prototype, 'play').mockImplementationOnce(async () => {});
  await expect(testCompanionVoice({} as any, {} as any, signal(), vi.fn())).rejects.toThrow('未检测到音频播放');
  const cleaned = redactCompanionTestText('HTTP 401 abc+secret abc%2Bsecret https://proxy.test/?key=hidden', { nested: { apiKey: 'abc+secret' } });
  expect(cleaned).toContain('401'); expect(cleaned).not.toContain('secret'); expect(cleaned).not.toContain('hidden');
});
