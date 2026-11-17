// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CompanionSurface } from '../../apps/CompanionApp';
import { startDoubaoListening } from './doubaoListening';

vi.mock('./doubaoListening', () => ({ canUseDoubaoListening: () => true, startDoubaoListening: vi.fn(() => vi.fn()) }));

vi.mock('../../context/OSContext', () => ({ useOS: () => ({}) }));
vi.mock('./voice', () => ({ CompanionVoice: class { prime() {} close() {} } }));
vi.mock('./requests', () => ({ createCompanionRequests: vi.fn() }));
vi.mock('./vision', async importOriginal => ({ ...await importOriginal<typeof import('./vision')>(), observeCompanionVideo: vi.fn(), observationText: () => '尚无画面' }));
vi.mock('./capture', async importOriginal => ({ ...await importOriginal<typeof import('./capture')>(), companionRecordingMime: () => 'video/mp4', startCompanionVideoLoop: vi.fn() }));
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
