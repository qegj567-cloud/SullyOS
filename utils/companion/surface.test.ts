// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CompanionSurface } from '../../apps/CompanionApp';
import { startDoubaoListening } from './doubaoListening';
import { createCompanionClipRecorder, startCompanionVideoLoop } from './capture';
import { isCompanionPresent } from './presence';

vi.mock('./doubaoListening', () => ({ canUseDoubaoListening: () => true, startDoubaoListening: vi.fn(() => vi.fn()) }));

vi.mock('../../context/OSContext', () => ({ useOS: () => ({}) }));
vi.mock('./voice', () => ({ CompanionVoice: class { prime() {} close() {} } }));
vi.mock('./requests', () => ({ createCompanionRequests: vi.fn() }));
vi.mock('./vision', async importOriginal => ({ ...await importOriginal<typeof import('./vision')>(), observeCompanionVideo: vi.fn(), observationText: () => '尚无画面' }));
vi.mock('./capture', async importOriginal => ({ ...await importOriginal<typeof import('./capture')>(), createCompanionClipRecorder: vi.fn(() => vi.fn()), startCompanionVideoLoop: vi.fn() }));
vi.mock('../visionApi', () => ({ isVisionApiReady: (config: any) => !!config?.enabled }));
vi.mock('../ttsRouter', () => ({ canSynthesizeSpeech: () => false, characterHasVoice: () => false }));
vi.mock('../chatContextRange', () => ({ resolveContextRangeMode: () => 'manual', clampManualContextLimit: (value: number) => value || 500 }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const props: any = { characters: [{ id: 'c', name: '同行伙伴', systemPrompt: '语气设定', contextLimit: 50 }], user: { name: '用户' }, api: {}, close: vi.fn() };
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const click = async (label: string) => act(async () => {
  const button = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent?.trim() === label);
  expect(button).toBeTruthy(); button!.click();
});
const chooseCamera = async (id: string) => act(async () => {
  const select = host.querySelector('select[aria-label="摄像头来源"]') as HTMLSelectElement;
  select.value = id; select.dispatchEvent(new Event('change', { bubbles: true }));
});
const cameraDevices = [
  { kind: 'videoinput', deviceId: 'physical', label: '实体摄像头' },
  { kind: 'videoinput', deviceId: 'vts', label: 'VTubeStudioCam' },
  { kind: 'audioinput', deviceId: 'microphone', label: '麦克风' },
];

it('recovers from a busy automatic camera by explicitly selecting the virtual source', async () => {
  const track = { stop: vi.fn(), onended: null, label: 'VTubeStudioCam' };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const getUserMedia = vi.fn().mockRejectedValueOnce(new DOMException('Device in use', 'NotReadableError')).mockResolvedValue(stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices: vi.fn(async () => cameraDevices) } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  await act(async () => root.render(React.createElement(CompanionSurface, props)));
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(host.querySelector('select[aria-label="摄像头来源"]')?.textContent).not.toContain('麦克风');
  await click('开启镜头');
  expect(host.textContent).toContain('可能被占用或驱动尚未就绪');
  expect(getUserMedia).toHaveBeenCalledOnce();
  await chooseCamera('vts');
  expect(getUserMedia).toHaveBeenCalledOnce();
  await click('开启镜头');
  expect(getUserMedia.mock.calls[1][0]).toEqual({ audio: false, video: {
    deviceId: { exact: 'vts' }, width: { ideal: 640 }, frameRate: { ideal: 12 },
  } });
  expect(host.querySelector('video')!.srcObject).toBe(stream);
  expect(host.textContent).toContain('当前输入：VTubeStudioCam');
  expect(host.querySelector('[role=alert]')).toBeNull();
});

it('keeps a disconnected explicit source selected and never falls back to the physical camera', async () => {
  const media = Object.assign(new EventTarget(), {
    enumerateDevices: vi.fn(async () => cameraDevices),
    getUserMedia: vi.fn().mockRejectedValue(new DOMException('missing', 'NotFoundError')),
  });
  vi.stubGlobal('navigator', { mediaDevices: media });
  await act(async () => root.render(React.createElement(CompanionSurface, props)));
  await chooseCamera('vts');
  media.enumerateDevices.mockResolvedValue([cameraDevices[0]]);
  await act(async () => { media.dispatchEvent(new Event('devicechange')); });
  const select = host.querySelector('select[aria-label="摄像头来源"]') as HTMLSelectElement;
  expect(select.value).toBe('vts'); expect(select.textContent).toContain('所选设备暂不可见');
  await click('开启镜头');
  expect(media.getUserMedia).toHaveBeenCalledOnce();
  expect(media.getUserMedia.mock.calls[0][0].video.deviceId).toEqual({ exact: 'vts' });
  expect(host.textContent).toContain('没有找到所选摄像头');
});

it('releases a late old camera after changing source without replacing the new virtual preview', async () => {
  const old = deferred<any>(), oldTrack = { stop: vi.fn(), onended: null };
  const nextTrack = { stop: vi.fn(), onended: null, label: 'VTubeStudioCam' };
  const nextStream = { getTracks: () => [nextTrack], getVideoTracks: () => [nextTrack] };
  const getUserMedia = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(nextStream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices: vi.fn(async () => cameraDevices) } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  await act(async () => root.render(React.createElement(CompanionSurface, props)));
  await chooseCamera('physical'); await click('开启镜头');
  await chooseCamera('vts'); await click('开启镜头');
  await act(async () => old.resolve({ getTracks: () => [oldTrack], getVideoTracks: () => [oldTrack] }));
  expect(oldTrack.stop).toHaveBeenCalledOnce(); expect(nextTrack.stop).not.toHaveBeenCalled();
  expect(host.querySelector('video')!.srcObject).toBe(nextStream);
  await chooseCamera('physical');
  expect(nextTrack.stop).toHaveBeenCalledOnce(); expect(getUserMedia).toHaveBeenCalledTimes(2);
  expect(host.querySelector('video')!.srcObject).toBeNull();
  expect(host.textContent).not.toContain('当前输入：VTubeStudioCam');
});

it('tracks the actual companion role and releases its presence on switching or unmount', async () => {
  let captured: any, signal!: AbortSignal;
  const factory = vi.fn(ctx => {
    captured = ctx;
    return { quick: async (_: any, s: AbortSignal) => {
      signal = s;
      return new Promise<string>((_, reject) => s.addEventListener('abort', () => reject(s.reason), { once: true }));
    }, prepare: async (_: any, a: Promise<string>) => a, full: async () => 'a′' };
  });
  await act(async () => root.render(React.createElement(CompanionSurface, { ...props, api: { stream: false },
    characters: [...props.characters, { id: 'other', name: '另一位' }], requestFactory: factory })));
  expect(isCompanionPresent('c')).toBe(true); expect(isCompanionPresent('other')).toBe(false);
  await act(async () => {
    const input = host.querySelector('input[aria-label="对同行伙伴说"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'A');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('发送');
  expect(captured.api.stream).toBe(false);
  const select = host.querySelector('select[aria-label="同行角色"]') as HTMLSelectElement;
  await act(async () => { select.value = 'other'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(signal.aborted).toBe(true);
  expect(isCompanionPresent('c')).toBe(false); expect(isCompanionPresent('other')).toBe(true);
  await act(async () => root.render(null));
  expect(isCompanionPresent('other')).toBe(false);
});

it('uses selected Doubao independently of browser recognition and stops listening when the page becomes hidden', async () => {
  const quick = vi.fn(async () => '接话'), full = vi.fn(async () => '续答'), stop = vi.fn();
  vi.mocked(startDoubaoListening).mockReturnValueOnce(stop);
  await act(async () => root.render(React.createElement(CompanionSurface, { ...props,
    api: { companionStt: { provider: 'doubao', apiKey: 'test-key', resourceId: 'volc.seedasr.sauc.duration' } },
    requestFactory: () => ({ quick, prepare: async () => ({}), full }),
  })));
  await click('连续听');
  const callbacks = vi.mocked(startDoubaoListening).mock.calls.at(-1)![1];
  await act(async () => callbacks.final('看看这件'));
  expect(quick).toHaveBeenCalledOnce(); expect(full).toHaveBeenCalledOnce();
  expect(host.querySelector('.companion-caption')!.textContent).toContain('a′ · 完整回复');
  await click('本次记录');
  const history = host.querySelector('[aria-label="本次同行记录"]')!;
  expect(history.textContent).toContain('a · 接话'); expect(history.textContent).toContain('a′ · 完整回复');
  await act(async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(stop).toHaveBeenCalledOnce(); expect(host.textContent).toContain('已暂停');
});

it('renders the independent surface, shows both replies and discards a continuation after interruption', async () => {
  const later = deferred<string>();
  const full = vi.fn(() => later.promise);
  await act(async () => root.render(React.createElement(CompanionSurface, { ...props,
    requestFactory: () => ({ quick: async () => '先看看肩线。', prepare: async (_: any, quick: any) => quick, full }),
  })));
  expect(host.textContent).toContain('未配音色');
  // Form state update and submit must be separate browser events / React commits.
  await act(async () => {
    const input = host.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '这件怎么样');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('发送');
  expect(host.textContent).toContain('先看看肩线'); expect(full).toHaveBeenCalledOnce();
  await click('打断');
  await act(async () => later.resolve('不应该播放的旧答案'));
  expect(host.textContent).not.toContain('不应该播放的旧答案');
  await click('同行设置'); expect(host.textContent).toContain('最近 50 条');
  await click('结束本次同行'); expect(host.textContent).toContain('已结束本次同行');
});

it('stops a camera stream whose permission resolves after the user has cancelled', async () => {
  const permission = deferred<MediaStream>();
  const track = { stop: vi.fn() };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(() => permission.promise) } });
  await act(async () => root.render(React.createElement(CompanionSurface, { ...props, api: { companionVideoApi: { baseUrl: 'https://video.test', apiKey: 'test', model: 'video' } } })));
  await click('开启镜头'); await click('取消开启');
  await act(async () => permission.resolve({ getTracks: () => [track] } as any));
  expect(track.stop).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('镜头关闭');
});

it('keeps the same live preview through recording, analysis failure and retry; closing alone releases camera', async () => {
  const track = { stop: vi.fn(), onended: null }, stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  await act(async () => root.render(React.createElement(CompanionSurface, { ...props,
    api: { companionVideoApi: { baseUrl: 'https://video.test', apiKey: 'test', model: 'video' } },
  })));
  await click('开启镜头');
  const video = host.querySelector('video')!;
  expect(video.srcObject).toBe(stream); expect(video.classList.contains('is-on')).toBe(true);
  const loop = vi.mocked(startCompanionVideoLoop).mock.calls.at(-1)![0];
  await act(async () => loop.error(new Error('浏览器录制结果为 0 字节'), true));
  expect(loop.signal.aborted).toBe(true);
  expect(host.textContent).toContain('视频理解已暂停'); expect(host.textContent).toContain('实时预览仍保留');
  expect(video.srcObject).toBe(stream); expect(track.stop).not.toHaveBeenCalled();
  const before = vi.mocked(startCompanionVideoLoop).mock.calls.length;
  await click('重试视频理解');
  expect(vi.mocked(startCompanionVideoLoop).mock.calls.length).toBe(before + 1);
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
  expect(video.srcObject).toBe(stream);
  await click('关闭镜头'); expect(track.stop).toHaveBeenCalledOnce(); expect(video.srcObject).toBeNull();
});

it('opens preview even without video API or with an unsupported recorder', async () => {
  const track = { stop: vi.fn(), onended: null }, stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  await act(async () => root.render(React.createElement(CompanionSurface, props)));
  await click('开启镜头'); expect(host.textContent).toContain('仅实时预览'); expect(host.querySelector('video')!.srcObject).toBe(stream);
  await click('关闭镜头');
  vi.mocked(createCompanionClipRecorder).mockImplementationOnce(() => { throw new Error('不支持 MP4'); });
  await act(async () => root.render(React.createElement(CompanionSurface, { ...props,
    api: { companionVideoApi: { baseUrl: 'https://video.test', apiKey: 'test', model: 'video' } },
  })));
  await click('开启镜头'); expect(host.textContent).toContain('不支持 MP4');
  expect(host.querySelector('video')!.classList.contains('is-on')).toBe(true);
  expect(track.stop).toHaveBeenCalledOnce();
});

it('opens the setup guide without generating, and stops a live turn before navigating to settings', async () => {
  let signal: AbortSignal | undefined;
  const later = deferred<string>(), navigateSetup = vi.fn();
  const quick = vi.fn(async (_history, s: AbortSignal) => { signal = s; return later.promise; });
  await act(async () => root.render(React.createElement(CompanionSurface, { ...props, navigateSetup,
    requestFactory: () => ({ quick, prepare: async (_: any, a: any) => a, full: async () => 'a′' }),
  })));
  await click('API 接入');
  expect(host.querySelector('[role=dialog]')).toBeTruthy();
  expect(host.textContent).toContain('豆包流式语音识别 2.0');
  expect(quick).not.toHaveBeenCalled();
  await click('返回同行');
  await act(async () => {
    const input = host.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'A');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('发送'); await click('API 接入'); await click('去配置识图 API');
  expect(signal?.aborted).toBe(true);
  expect(navigateSetup).toHaveBeenCalledWith('vision', 'c');
  await act(async () => later.resolve('旧轮的答案'));
  expect(host.textContent).not.toContain('旧轮的答案');
});
