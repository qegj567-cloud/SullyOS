// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CompanionVideoSettings } from '../../components/companion/CompanionVideoSettings';
import { CompanionSurface } from '../../apps/CompanionApp';
import { CompanionSessionSlot } from '../../components/companion/CompanionSessionSlot';
import { startDoubaoListening } from './doubaoListening';
import { trackEvent } from '../analytics';
import * as favorites from '../voiceFavorites';
import * as sharing from '../shareExport';
import { DEFAULT_COMPANION_VIDEO } from './videoProviders';
import { createCompanionClipRecorder, startCompanionVideoLoop } from './capture';
import { isCompanionPresent } from './presence';

vi.mock('../analytics', async original => ({ ...await original<typeof import('../analytics')>(), trackEvent: vi.fn() }));
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
beforeEach(() => { localStorage.setItem('sully_companion_intro_v1', 'seen'); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const click = async (label: string) => act(async () => {
  const button = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent?.trim() === label);
  expect(button).toBeTruthy(); button!.click();
});
const chooseCamera = async (id: string) => {
  await click('同行设置'); await click('镜头与形象');
  await act(async () => {
    const select = host.querySelector('select[aria-label="摄像头来源"]') as HTMLSelectElement;
    select.value = id; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('回到通话');
};
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
  await click('同行设置'); await click('镜头与形象');
  expect(host.querySelector('select[aria-label="摄像头来源"]')!.textContent).not.toContain('麦克风'); await click('回到通话');
  await click('开启镜头');
  expect(host.textContent).toContain('可能被占用或驱动尚未就绪');
  expect(getUserMedia).toHaveBeenCalledOnce();
  await click('摄像头来源');
  let selector = host.querySelector<HTMLSelectElement>('select[aria-label="摄像头来源"]')!;
  expect(host.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('镜头与形象');
  expect(document.activeElement).toBe(selector);
  expect(selector.value).toBe('');
  await click('返回');
  expect(host.querySelector('[role=dialog]')).toBeNull();
  expect(document.activeElement?.textContent).toBe('摄像头来源');
  await click('VTubeStudioCam');
  selector = host.querySelector<HTMLSelectElement>('select[aria-label="摄像头来源"]')!;
  expect(document.activeElement).toBe(selector);
  expect(selector.value).toBe('');
  await act(async () => { selector.value = 'vts'; selector.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('回到通话');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('开启镜头');
  expect(getUserMedia).toHaveBeenCalledOnce();
  await click('开启镜头');
  expect(getUserMedia.mock.calls[1][0]).toEqual({ audio: false, video: {
    deviceId: { exact: 'vts' }, width: { ideal: 640 }, frameRate: { ideal: 12 },
  } });
  expect(host.querySelector('video')!.srcObject).toBe(stream);
  await click('同行设置'); await click('镜头与形象'); expect(host.textContent).toContain('当前输入：VTubeStudioCam');
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
  await click('同行设置'); await click('镜头与形象');
  media.enumerateDevices.mockResolvedValue([cameraDevices[0]]);
  await act(async () => { media.dispatchEvent(new Event('devicechange')); });
  const select = host.querySelector('select[aria-label="摄像头来源"]') as HTMLSelectElement;
  expect(select.value).toBe('vts'); expect(select.textContent).toContain('所选设备暂不可见'); await click('回到通话');
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
  await act(async () => root.render(React.createElement(CompanionSurface, { ...props, api: { stream: false, companionQuickReply: true },
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
  expect(quick).not.toHaveBeenCalled(); expect(full).toHaveBeenCalledOnce();
  expect(host.querySelector('.companion-caption')!.textContent).toContain('续答');
  expect(host.textContent).not.toContain('a′'); expect(host.querySelector('.companion-debug')).toBeNull();
  await click('历史记录');
  const history = host.querySelector('[aria-label="本次同行记录"]')!;
  expect(history.textContent).not.toContain('a · 接话'); expect(history.textContent).not.toContain('a′'); expect(history.textContent).toContain('续答');
  await click('返回'); await click('同行设置'); await click('回复与调试'); expect(host.querySelector('.companion-debug')).toBeTruthy();
  const toggle = [...host.querySelectorAll('label')].find(label => label.textContent === '短接话 a')!.querySelector('input')!;
  expect(toggle.checked).toBe(false);
  await act(async () => { toggle.click(); });
  await click('回到通话');
  await act(async () => callbacks.final('现在看看另一件'));
  expect(quick).toHaveBeenCalledOnce(); expect(full).toHaveBeenCalledTimes(2);
  await act(async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(stop).toHaveBeenCalledOnce(); expect(host.textContent).toContain('已暂停');
});

it('keeps one opted-in call through the Sully desktop and a hidden tab, then releases it on hangup', async () => {
  const stop = vi.fn(), answer = deferred<string>();
  const full = vi.fn((_payload: unknown, _signal: AbortSignal) => answer.promise);
  vi.mocked(startDoubaoListening).mockReturnValueOnce(stop);
  const track = { stop: vi.fn(), label: '外置镜头' };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const api = { companionStt: { provider: 'doubao', apiKey: 'test-key' } };
  const Harness = () => {
    const [foreground, select] = React.useState(true);
    return React.createElement(CompanionSessionSlot, { foreground, otherCallBars: 0, resume: () => select(true),
      children: retain => React.createElement(CompanionSurface, { ...props, foreground, onRetentionChange: retain,
        close: () => select(false), api, requestFactory: () => ({ prepare: async () => ({}), full }) }) });
  };
  await act(async () => root.render(React.createElement(Harness)));
  await click('同行设置'); await click('亮屏与暂离');
  const option = host.querySelector<HTMLInputElement>('[aria-label="暂离时继续同行"]')!;
  expect(option.checked).toBe(false);
  await act(async () => option.click());
  await click('回到通话'); await click('开启镜头'); await click('连续听');
  const callbacks = vi.mocked(startDoubaoListening).mock.calls.at(-1)![1];
  await act(async () => callbacks.final('看看这家店'));
  await click('返回桌面');
  expect(host.querySelector('[aria-label="同行"]')?.closest('[hidden]')).toBeTruthy();
  await act(async () => { hidden.mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange')); });
  expect(stop).not.toHaveBeenCalled(); expect(track.stop).not.toHaveBeenCalled();
  expect(full.mock.calls[0][1].aborted).toBe(false);
  await act(async () => { answer.resolve('我看到门口了'); hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')); });
  await click('返回同行');
  expect(host.querySelector('video')!.srcObject).toBe(stream);
  expect(getUserMedia).toHaveBeenCalledOnce(); expect(full).toHaveBeenCalledOnce();
  expect(host.querySelector('.companion-caption')!.textContent).toContain('我看到门口了');
  await click('结束同行');
  expect(stop).toHaveBeenCalledOnce(); expect(track.stop).toHaveBeenCalledOnce();
  expect(host.querySelector('[aria-label="返回同行"]')).toBeNull();
  expect(isCompanionPresent('c')).toBe(false);
});

it('releases the screen lock on hide, reacquires on return and releases a late grant after page exit', async () => {
  const lock = Object.assign(new EventTarget(), { release: vi.fn(async () => {}), released: false });
  const late = Object.assign(new EventTarget(), { release: vi.fn(async () => {}), released: false });
  const grant = deferred<typeof late>();
  const request = vi.fn().mockResolvedValueOnce(lock).mockReturnValueOnce(grant.promise);
  vi.stubGlobal('navigator', { wakeLock: { request } });
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  await act(async () => root.render(React.createElement(CompanionSurface, props)));
  await click('同行设置'); await click('亮屏与暂离');
  const option = host.querySelector<HTMLInputElement>('[aria-label="保持亮屏"]')!;
  expect(option.checked).toBe(false); expect(request).not.toHaveBeenCalled();
  await act(async () => option.click());
  expect(host.textContent).toContain('屏幕正保持常亮'); expect(request).toHaveBeenCalledWith('screen');
  await act(async () => { hidden.mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange')); });
  expect(lock.release).toHaveBeenCalledOnce();
  await act(async () => { hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange')); });
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => { window.dispatchEvent(new Event('pagehide')); grant.resolve(late); });
  expect(late.release).toHaveBeenCalledOnce(); expect(option.checked).toBe(false);
});

it('changes barge-in while the mic is live, keeps typing intact and shows queued speech until the next turn', async () => {
  const firstReply = deferred<string>(), secondReply = deferred<string>();
  const signals: AbortSignal[] = [];
  const prepare = vi.fn(async (history: { text: string }[]) => history.at(-1)!.text);
  const full = vi.fn((text: string, signal: AbortSignal) => {
    signals.push(signal);
    return text === '第一句' ? firstReply.promise : secondReply.promise;
  });
  const saved = vi.fn();
  function Fixture() {
    const [enabled, setEnabled] = React.useState(true);
    return React.createElement(CompanionSurface, { ...props,
      api: { companionBargeIn: enabled, companionStt: { provider: 'doubao', apiKey: 'test', resourceId: 'volc.seedasr.sauc.duration' } },
      saveBargeIn: (value: boolean) => { saved(value); setEnabled(value); },
      requestFactory: () => ({ quick: vi.fn(), prepare, full }),
    });
  }
  await act(async () => root.render(React.createElement(Fixture)));
  await click('连续听');
  const mic = vi.mocked(startDoubaoListening).mock.calls.at(-1)![1];
  await act(async () => mic.final('第一句'));
  await click('同行设置');
  const toggle = host.querySelector<HTMLInputElement>('[aria-label="插话打断"]')!;
  expect(toggle.checked).toBe(true);
  await act(async () => toggle.click());
  expect(saved).toHaveBeenCalledWith(false); await click('回到通话');
  const input = host.querySelector<HTMLInputElement>('[aria-label="对同行伙伴说"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '我也想看蓝色');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    mic.speech(); mic.partial('还有');
  });
  expect(signals[0].aborted).toBe(false);
  expect(host.querySelector('[aria-label="下一轮待发送"]')).toBeNull();
  await act(async () => { mic.partial(''); mic.final('还有红色'); });
  expect(input.value).toBe('我也想看蓝色');
  await click('发送');
  expect(host.querySelector('[aria-label="下一轮待发送"]')?.textContent).toContain('还有红色\n我也想看蓝色');
  expect(prepare).toHaveBeenCalledOnce();
  await act(async () => firstReply.resolve('说完第一句'));
  expect(prepare.mock.calls[1][0].map(line => line.text)).toEqual(['第一句', '说完第一句', '还有红色\n我也想看蓝色']);
  expect(host.querySelector('[aria-label="下一轮待发送"]')).toBeNull();
  await click('同行设置');
  await act(async () => host.querySelector<HTMLInputElement>('[aria-label="插话打断"]')!.click());
  await click('回到通话'); await act(async () => mic.speech());
  expect(signals[1].aborted).toBe(true);
  await act(async () => secondReply.resolve('晚到的答复'));
  expect(host.textContent).not.toContain('晚到的答复');
});

it('renders the independent surface, shows both replies and discards a continuation after interruption', async () => {
  const later = deferred<string>();
  const full = vi.fn(() => later.promise);
  await act(async () => root.render(React.createElement(CompanionSurface, { ...props,
    api: { companionQuickReply: true },
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
  await click('同行设置'); await click('回复与调试'); expect(host.textContent).toContain('最近 50 条');
  await click('回到通话'); await click('结束同行'); expect(props.close).toHaveBeenCalled();
});

it('stops a camera stream whose permission resolves after the user has cancelled', async () => {
  const permission = deferred<MediaStream>();
  const track = { stop: vi.fn() };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(() => permission.promise) } });
  await act(async () => root.render(React.createElement(CompanionSurface, { ...props, api: { companionVideoApi: { baseUrl: 'https://video.test', apiKey: 'test', model: 'video' } } })));
  await click('开启镜头'); await click('取消开启');
  await act(async () => permission.resolve({ getTracks: () => [track] } as any));
  expect(track.stop).toHaveBeenCalledOnce();
  expect(host.querySelector('.companion-stage')?.getAttribute('data-camera')).toBe('off');
  expect(host.querySelector('video')!.srcObject).toBeNull();
});

it('uses the stored domestic key for real camera observations and switches an existing provider only on demand', async () => {
  const track = { stop: vi.fn() }, stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  const observe = vi.fn(async () => ({ text: '街景', from: 0, to: 8000 }));
  const save = vi.fn();
  const render = (api: object) => act(async () => root.render(React.createElement(CompanionSurface, { ...props, api, videoObserver: observe })));
  const currentLoop = () => vi.mocked(startCompanionVideoLoop).mock.calls.at(-1)![0];
  const clip = { blob: new Blob(['clip'], { type: 'video/mp4' }), from: 0, to: 8000 };
  const ark = { provider: 'doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', apiKey: 'plan-key', model: 'old-model' };
  const renderSettings = (config: object) => act(async () => root.render(React.createElement(CompanionVideoSettings, { api: { companionVideoApi: config, minimaxApiKey: 'shared-key' } as any, saveVideoApi: save })));
  await renderSettings(ark);
  await click('切换到 MiniMax 直连');
  const switched = { ...ark, preferSharedMiniMax: true };
  expect(save).toHaveBeenCalledWith(switched);
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  await renderSettings(switched);
  expect(host.querySelector<HTMLSelectElement>('[aria-label="视频服务商"]')!.value).toBe('minimax');
  await click('保存视频 API');
  expect(save).toHaveBeenLastCalledWith(switched);
  await click('恢复之前的视频配置');
  expect(save).toHaveBeenLastCalledWith(ark);
  // Starting with no saved video API is the other normal entry into the same camera loop.
  await render({ minimaxApiKey: 'shared-key' });
  await click('开启镜头');
  const first = currentLoop();
  await act(async () => { await first.observe(clip); });
  expect(observe).toHaveBeenLastCalledWith(clip, { ...DEFAULT_COMPANION_VIDEO, apiKey: 'shared-key' }, 'c', '同行伙伴', first.signal, expect.anything(), expect.any(Function));
  await render({ minimaxApiKey: 'rotated-key', companionVideoApi: switched });
  expect(first.signal.aborted).toBe(true);
  const next = currentLoop();
  await act(async () => { await next.observe(clip); });
  expect(observe).toHaveBeenLastCalledWith(clip, { ...DEFAULT_COMPANION_VIDEO, apiKey: 'rotated-key' }, 'c', '同行伙伴', next.signal, expect.anything(), expect.any(Function));
  await render({ minimaxRegion: 'overseas', minimaxApiKey: 'overseas-key', companionVideoApi: switched });
  expect(next.signal.aborted).toBe(true);
  expect(host.textContent).toContain('仅实时预览');
});

it('keeps the same live preview through recording, analysis failure and retry; closing alone releases camera', async () => {
  const track = { stop: vi.fn(), onended: null }, stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  await act(async () => root.render(React.createElement(CompanionSurface, { ...props,
    characters: [{ ...props.characters[0], companionAvatar: { source: 'date' }, sprites: { normal: '/portrait.png' }, videoCallBackground: '/room.jpg' }],
    api: { companionVideoApi: { baseUrl: 'https://video.test', apiKey: 'test', model: 'video' } },
  })));
  const stage = host.querySelector<HTMLElement>('.companion-stage')!;
  const scene = stage.querySelector<HTMLElement>('.companion-scene')!;
  const video = scene.querySelector('video')!;
  expect(scene.querySelector('.companion-call-background')).toBeTruthy();
  await click('开启镜头');
  Object.defineProperties(video, { videoWidth: { configurable: true, value: 1280 }, videoHeight: { configurable: true, value: 720 } });
  await act(async () => video.dispatchEvent(new Event('resize')));
  expect(scene.style.getPropertyValue('--camera-aspect')).toBe(String(1280 / 720));
  expect(video.srcObject).toBe(stream); expect(video.classList.contains('is-on')).toBe(true);
  expect(createCompanionClipRecorder).toHaveBeenCalledWith(stream, expect.any(AbortSignal));
  const loop = vi.mocked(startCompanionVideoLoop).mock.calls.at(-1)![0];
  expect(scene.querySelector('.companion-call-background')).toBeNull();
  expect(video.nextElementSibling?.querySelector('img')?.getAttribute('src')).toBe('/portrait.png');
  await click('关闭角色镜头');
  expect(scene.querySelector('.companion-foreground')).toBeNull();
  expect(stage.textContent).not.toContain('双方镜头已关闭');
  await click('开启角色镜头');
  expect(scene.querySelector('.companion-foreground img')).toBeTruthy();
  expect(host.querySelector('video')).toBe(video);
  expect(video.srcObject).toBe(stream);
  expect(loop.signal.aborted).toBe(false);
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
  await act(async () => loop.error(new Error('浏览器录制结果为 0 字节'), true));
  expect(loop.signal.aborted).toBe(true);
  expect(host.textContent).toContain('视频理解已暂停'); await click('同行设置'); await click('回复与调试'); expect(host.textContent).toContain('实时预览仍保留'); await click('回到通话');
  expect(video.srcObject).toBe(stream); expect(track.stop).not.toHaveBeenCalled();
  const before = vi.mocked(startCompanionVideoLoop).mock.calls.length;
  await click('重试视频理解');
  expect(vi.mocked(startCompanionVideoLoop).mock.calls.length).toBe(before + 1);
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
  expect(video.srcObject).toBe(stream);
  await click('关闭镜头'); expect(track.stop).toHaveBeenCalledOnce(); expect(video.srcObject).toBeNull();
  expect(scene.querySelector('.companion-foreground img')).toBeTruthy();
  expect(scene.querySelector('.companion-call-background')).toBeTruthy();
  await click('关闭角色镜头');
  expect(scene.querySelector('img')).toBeNull();
  expect(stage.textContent).toContain('双方镜头已关闭');
});

it('moves, scales and rotates just the character with two fingers, committing once and allowing a settings reset', async () => {
  await act(async () => root.render(React.createElement(CompanionSurface, props)));
  const layer = host.querySelector<HTMLElement>('.companion-foreground')!;
  const frame = layer.parentElement!;
  const video = host.querySelector('video');
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({ width: 400, height: 600, left: 0, top: 0 } as DOMRect);
  Object.defineProperties(layer, { offsetWidth: { value: 400 }, offsetHeight: { value: 600 } });
  const finger = (identifier: number, clientX: number, clientY: number) => ({ identifier, target: layer, clientX, clientY });
  const touch = (type: string, touches: ReturnType<typeof finger>[], changedTouches = touches) => act(async () => {
    layer.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { touches, changedTouches }));
  });
  const a = finger(1, 150, 300), b = finger(2, 250, 300);
  await touch('touchstart', [a]); await touch('touchmove', [finger(1, 200, 350)]);
  expect(layer.style.transform).toContain('rotate(0deg) scale(1)');
  await touch('touchstart', [a, b]);
  const c = finger(1, 240, 230), d = finger(2, 240, 430);
  await touch('touchmove', [c, d]);
  expect(layer.style.transform).toBe('translate(10cqw, 5cqh) rotate(90deg) scale(2)');
  await touch('touchcancel', [], [c, d]);
  expect(layer.style.transform).toContain('rotate(0deg) scale(1)');
  vi.mocked(trackEvent).mockClear();
  await touch('touchstart', [a, b]); await touch('touchmove', [c, d]); await touch('touchend', [d], [c]);
  await touch('touchmove', [finger(2, 350, 480)]); await touch('touchend', [], [d]);
  expect(layer.style.transform).toBe('translate(10cqw, 5cqh) rotate(90deg) scale(2)');
  expect(vi.mocked(trackEvent).mock.calls).toEqual([['调整角色构图']]);
  expect(host.querySelector('video')).toBe(video);
  await click('同行设置'); await click('镜头与形象'); await click('恢复默认'); await click('回到通话');
  expect(layer.style.transform).toBe('translate(0cqw, 0cqh) rotate(0deg) scale(1)');
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
  await click('开启镜头'); await click('同行设置'); await click('回复与调试'); expect(host.textContent).toContain('不支持 MP4');
  expect(host.querySelector('video')!.classList.contains('is-on')).toBe(true);
  expect(track.stop).toHaveBeenCalledOnce();
});

it('opens the setup guide without generating, and stops a live turn before navigating to settings', async () => {
  let signal: AbortSignal | undefined;
  const later = deferred<string>(), navigateSetup = vi.fn();
  const quick = vi.fn(async (_history, s: AbortSignal) => { signal = s; return later.promise; });
  await act(async () => root.render(React.createElement(CompanionSurface, { ...props, navigateSetup, api: { companionQuickReply: true },
    requestFactory: () => ({ quick, prepare: async (_: any, a: any) => a, full: async () => 'a′' }),
  })));
  await click('同行设置'); await click('连接与服务'); await click('接入说明与连接测试');
  expect(host.querySelector('[role=dialog]')).toBeTruthy();
  expect(host.textContent).toContain('豆包流式语音识别 2.0');
  expect(quick).not.toHaveBeenCalled();
  await click('返回连接与服务'); await click('回到通话');
  await act(async () => {
    const input = host.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'A');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('发送'); await click('同行设置'); await click('连接与服务'); await click('接入说明与连接测试'); await click('去配置识图 API');
  expect(signal?.aborted).toBe(true);
  expect(navigateSetup).toHaveBeenCalledWith('vision', 'c');
  await act(async () => later.resolve('旧轮的答案'));
  expect(host.textContent).not.toContain('旧轮的答案');
});

it('shows onboarding once, links to system settings and opens no capture devices', async () => {
  localStorage.removeItem('sully_companion_intro_v1');
  const navigateSetup = vi.fn(), getUserMedia = vi.fn();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  const render = () => act(async () => root.render(React.createElement(CompanionSurface, { ...props, navigateSetup })));
  await render();
  expect(host.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('开始同行');
  await act(async () => [...host.querySelectorAll('.companion-services button')].find(el => el.textContent?.includes('视频理解'))!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(navigateSetup).toHaveBeenCalledWith('video', 'c');
  await act(async () => root.render(null)); await render();
  expect(host.querySelector('[role=dialog]')).toBeNull();
  expect(host.querySelector('.companion-services')).toBeNull();
  expect(getUserMedia).not.toHaveBeenCalled();
});

it('counts only fixed role-camera actions and keeps both lenses independent while selecting a source', async () => {
  const secret = 'private-character-or-image';
  await act(async () => root.render(React.createElement(CompanionSurface, { ...props,
    characters: [{ ...props.characters[0], name: secret, sprites: { chibi: secret } }],
  })));
  vi.mocked(trackEvent).mockClear();
  await click('关闭角色镜头'); await click('同行设置'); await click('镜头与形象');
  const select = host.querySelector<HTMLSelectElement>('[aria-label="角色镜头形象"]')!;
  await act(async () => { select.value = 'chibi'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('回到通话');
  expect(host.querySelector('[aria-label="开启角色镜头"]')).toBeTruthy();
  await click('开启角色镜头');
  expect(host.querySelector('[aria-label="开启镜头"]')).toBeTruthy();
  expect(vi.mocked(trackEvent).mock.calls).toEqual([
    ['开关角色镜头', { 状态: '关' }], ['切换角色镜头形象', { 形象: 'Chibi' }], ['开关角色镜头', { 状态: '开' }],
  ]);
});

it.each([
  ['minimax', 'MiniMax'], ['fishaudio', '鱼声 Fish Audio'], ['elevenlabs', 'ElevenLabs'],
])('shows the configured %s role voice separately from Doubao transcription', async (engine, label) => {
  const navigateSetup = vi.fn();
  await act(async () => root.render(React.createElement(CompanionSurface, { ...props, navigateSetup,
    api: { ttsProvider: engine, companionStt: { provider: 'doubao', apiKey: 'test', resourceId: 'volc.seedasr.sauc.duration' } } })));
  await click('同行设置'); await click('连接与服务');
  const services = host.querySelector('[aria-label="服务设置"]')!;
  expect(services.textContent).toContain('语音识别豆包');
  const voice = [...services.querySelectorAll('button')].find(button => button.textContent?.startsWith('角色语音'))!;
  expect(voice.textContent).toContain(label);
  await act(async () => voice.click());
  expect(navigateSetup).toHaveBeenCalledWith('voice', 'c');
});

it('downloads and favorites the already played translation without another synthesis', async () => {
  const sample = new Blob(['spoken bytes'], { type: 'audio/wav' });
  const share = vi.spyOn(sharing, 'shareOrDownloadBlob').mockResolvedValue('downloaded');
  vi.spyOn(favorites, 'listVoiceFavorites').mockResolvedValue([]);
  const favorite = vi.spyOn(favorites, 'saveVoiceFavorite').mockResolvedValue({} as any);
  const playSample = vi.fn(async (text, _signal, heard, started, voice) => { started('audio'); voice.record(sample); heard(text); });
  await act(async () => root.render(React.createElement(CompanionSurface, { ...props, playSample,
    characters: [{ ...props.characters[0], callVoiceLang: 'en' }],
    requestFactory: () => ({ quick: async () => '', prepare: async () => ({}), full: async () => '你好！<语音>Hello!</语音>' }) })));
  await act(async () => {
    const input = host.querySelector('input[aria-label="对同行伙伴说"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '早上好');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('发送'); await click('历史记录');
  expect(host.querySelector('[aria-label="本次同行记录"]')?.textContent).toContain('你好！Hello!');
  await click('下载');
  expect(share).toHaveBeenCalledWith(expect.objectContaining({ blob: sample, fileName: expect.stringMatching(/\.wav$/), preferDownloadOnWeb: true }));
  await click('收藏');
  expect(favorite).toHaveBeenCalledWith(expect.objectContaining({ blob: sample, source: 'companion', originalText: '你好！', translation: 'Hello!', language: 'en' }));
  expect(host.textContent).toContain('已收藏');
  expect(playSample).toHaveBeenCalledOnce();
});

it('keeps the tools overview short and returns from each task to its own entry', async () => {
  const getUserMedia = vi.fn(), enumerateDevices = vi.fn(async () => []);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices } });
  await act(async () => root.render(React.createElement(CompanionSurface, props)));
  await click('同行设置');
  const overview = () => host.querySelector<HTMLElement>('[role=dialog][aria-label="通话工具"]')!;
  expect(overview().querySelectorAll('select')).toHaveLength(1);
  expect(overview().querySelector('.companion-debug, .companion-camera-source, .companion-services')).toBeNull();
  expect(enumerateDevices).not.toHaveBeenCalled();
  for (const name of ['镜头与形象', '连接与服务', '回复与调试']) {
    await click(name);
    const panel = host.querySelector<HTMLElement>('[role=dialog]')!;
    expect(panel.getAttribute('aria-label')).toBe(name);
    await act(async () => { panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(overview().contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toContain(name);
  }
  await click('回到通话');
  expect(host.querySelector('[role=dialog]')).toBeNull();
  expect(getUserMedia).not.toHaveBeenCalled();
});

it('leaves a browser permission error as permission guidance and keeps dismiss separate', async () => {
  const getUserMedia = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  await act(async () => root.render(React.createElement(CompanionSurface, props)));
  await click('开启镜头');
  const notice = host.querySelector('[role=alert]')!;
  expect(notice.textContent).toContain('浏览器地址栏');
  expect(notice.querySelector('.companion-error-action')).toBeNull();
  await click('关闭提示');
  expect(host.querySelector('[role=dialog], [role=alert]')).toBeNull();
  expect(getUserMedia).toHaveBeenCalledOnce();
});

it('links a missing Doubao key directly to STT settings on tap', async () => {
  const navigateSetup = vi.fn();
  await act(async () => root.render(React.createElement(CompanionSurface, { ...props, navigateSetup,
    api: { companionStt: { provider: 'doubao', apiKey: '', resourceId: 'volc.seedasr.sauc.duration' } } })));
  await click('连续听');
  expect(navigateSetup).not.toHaveBeenCalled();
  expect(host.querySelector('[role=dialog]')).toBeNull();
  await click('语音识别设置');
  expect(navigateSetup).toHaveBeenCalledWith('stt', 'c');
});
