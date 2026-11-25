// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DoubaoSpeechSettings, useDoubaoSpeechDraft } from '../../components/settings/DoubaoSpeechSettings';
import { CompanionVideoSettings } from '../../components/companion/CompanionVideoSettings';
import { CompanionSetupGuide } from '../../components/companion/CompanionSetupGuide';
import { companionDialogueReady, openCompanionSetupTarget } from './setup';
import { characterLaunch } from '../characterLaunch';
import { useSettingsFocus } from '../settingsNavigation';
import { AppID } from '../../types';
import { testCompanionDialogue, testCompanionVideo, testCompanionStt, testMiniMaxReferenceVideo } from './apiTests';
import { testCompanionVideoDirect } from './videoConnection';
vi.mock('./videoConnection', async original => ({ ...await original<typeof import('./videoConnection')>(),
  testCompanionVideoDirect: vi.fn(async () => ({ summary: '直连响应可读，仅检查跨域' })),
}));
vi.mock('./apiTests', async original => ({ ...await original<typeof import('./apiTests')>(),
  testCompanionDialogue: vi.fn(async () => ({ summary: '收到对话正文' })),
  testCompanionVideo: vi.fn(async () => ({ summary: '收到视频描述' })),
  testMiniMaxReferenceVideo: vi.fn(async () => ({ summary: '收到标准样片描述' })),
  testCompanionStt: vi.fn(async () => ({ summary: '收到识别结果' })),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it('only uses the saved domestic MiniMax key after an explicit sample test at the official address', async () => {
  const host = document.createElement('div'), root = createRoot(host);
  document.body.append(host);
  const save = vi.fn();
  const api = { minimaxApiKey: 'saved-minimax-key', companionVideoApi: { provider: 'minimax', baseUrl: 'https://api.minimax.cn/v1', model: 'MiniMax-M3.1-Flash', apiKey: '' } } as any;
  const render = (region: string) => act(async () => root.render(React.createElement(CompanionVideoSettings, { api: { ...api, minimaxRegion: region }, saveVideoApi: save })));
  const button = () => [...host.querySelectorAll('button')].find(el => el.textContent === '用已存 MiniMax Key 测样片');
  try {
    await render('overseas'); expect(button()).toBeUndefined();
    await render('domestic'); expect(testMiniMaxReferenceVideo).not.toHaveBeenCalled();
    await act(async () => button()!.click());
    expect(testMiniMaxReferenceVideo).toHaveBeenCalledWith({ ...api.companionVideoApi, apiKey: 'saved-minimax-key' }, expect.any(AbortSignal), expect.any(Function));
    const testVideo = () => [...host.querySelectorAll('button')].find(el => el.textContent === '测试视频 API')!;
    await act(async () => testVideo().click());
    expect(testCompanionVideo).toHaveBeenLastCalledWith({ ...api.companionVideoApi, apiKey: 'saved-minimax-key' }, expect.any(AbortSignal), expect.any(Function));
    await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(save).toHaveBeenLastCalledWith(api.companionVideoApi);
    save.mockClear();
    const address = host.querySelector<HTMLInputElement>('[aria-label="视频 API Base URL"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(address, 'https://custom.test/v1');
      address.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button()).toBeUndefined(); expect(save).not.toHaveBeenCalled();
    await act(async () => testVideo().click());
    expect(testCompanionVideo).toHaveBeenLastCalledWith(expect.objectContaining({ baseUrl: 'https://custom.test/v1', apiKey: '' }), expect.any(AbortSignal), expect.any(Function));
    expect(host.querySelector<HTMLInputElement>('[aria-label="视频 API Key"]')?.value).toBe('');
  } finally { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); }
});
it('shows the GLM direct route and only checks the unsaved draft after a click', async () => {
  const host = document.createElement('div'), root = createRoot(host); document.body.append(host);
  const saveVideoApi = vi.fn();
  try {
    await act(async () => root.render(React.createElement(CompanionVideoSettings, { api: {} as any, saveVideoApi })));
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('[aria-label="视频服务商"]')!;
      select.value = 'zhipu'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.textContent).toContain('浏览器 → open.bigmodel.cn（不经应用 Worker）');
    expect(host.textContent).toContain('兼容性仍待实测');
    expect(testCompanionVideoDirect).not.toHaveBeenCalled();
    expect(testCompanionVideo).not.toHaveBeenCalled();
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === '检查浏览器直连')!.click());
    expect(testCompanionVideoDirect).toHaveBeenCalledWith(expect.objectContaining({ provider: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '' }), expect.any(AbortSignal));
    expect(host.textContent).toContain('检查完成 · 直连响应可读'); expect(host.textContent).not.toContain('测试通过');
    expect(saveVideoApi).not.toHaveBeenCalled(); expect(testCompanionVideo).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); }
});
it('selects the paid plan credentials separately without calling or saving an API automatically', async () => {
  const host = document.createElement('div'), root = createRoot(host); document.body.append(host);
  const saveVideoApi = vi.fn();
  try {
    await act(async () => root.render(React.createElement(CompanionVideoSettings, { api: { companionVideoApi: { provider: 'doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'regular', apiKey: 'standard-secret' } } as any, saveVideoApi })));
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('[aria-label="豆包接入方式"]')!;
      select.value = 'plan'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.querySelector<HTMLInputElement>('[aria-label="视频 API Base URL"]')!.value).toBe('https://ark.cn-beijing.volces.com/api/plan/v3');
    expect(host.querySelector<HTMLInputElement>('[aria-label="视频模型 ID"]')!.value).toBe('doubao-seed-2.1-pro');
    expect(saveVideoApi).not.toHaveBeenCalled(); expect(testCompanionVideo).not.toHaveBeenCalled();
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === '测试视频 API')!.click());
    expect(testCompanionVideo).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: '', model: 'doubao-seed-2.1-pro' }), expect.any(AbortSignal), expect.any(Function));
  } finally { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); }
});
it('routes to shared video settings and cancels a running dialogue test before testing speech', async () => {
  const host = document.createElement('div'), root = createRoot(host); document.body.append(host);
  const saveVideoApi = vi.fn(), navigate = vi.fn(), beforeTest = vi.fn();
  const api = { baseUrl: 'https://chat.test', model: 'chat', apiKey: 'chat-key', companionStt: { provider: 'doubao', apiKey: 'old-key', resourceId: 'volc.seedasr.sauc.duration' } } as any;
  const click = async (text: string) => act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === text)!.click());
  try {
    await act(async () => root.render(React.createElement(CompanionSetupGuide, { api, canListen: true, navigate, close: vi.fn(), beforeTest })));
    expect(testCompanionDialogue).not.toHaveBeenCalled(); expect(testCompanionStt).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-label="视频 API Key"]')).toBeNull();
    await click('去设置视频理解'); expect(navigate).toHaveBeenCalledWith('video');
    expect(host.querySelector('[aria-label="豆包语音 API Key"]')).toBeNull();
    await click('去设置语音识别'); expect(navigate).toHaveBeenCalledWith('stt');
    await click('测试语音识别');
    expect(testCompanionStt).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'old-key', provider: 'doubao' }), expect.any(AbortSignal), expect.any(Function));
    expect(saveVideoApi).not.toHaveBeenCalled(); expect(beforeTest).toHaveBeenCalledTimes(1);
    let firstSignal!: AbortSignal;
    vi.mocked(testCompanionDialogue).mockImplementationOnce((_api, _char, signal) => { firstSignal = signal; return new Promise(() => {}); });
    await click('测试对话 API'); expect(firstSignal.aborted).toBe(false);
    await click('测试语音识别'); expect(firstSignal.aborted).toBe(true); expect(host.textContent).toContain('已取消');
    expect(host.textContent).not.toContain('draft-speech-key'); expect(api.companionStt.apiKey).toBe('old-key');
  } finally { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); }
});
it('configures Doubao STT separately, keeps a saved key hidden and supplies direct registration links', async () => {
  const host = document.createElement('div'), root = createRoot(host); document.body.append(host);
  const saveStt = vi.fn();
  const api = { baseUrl: 'https://chat.test', model: 'chat', apiKey: 'chat-secret',
    companionStt: { provider: 'doubao', apiKey: 'speech-secret', resourceId: 'volc.seedasr.sauc.duration' } } as any;
  const snapshot = JSON.stringify(api);
  try {
    function Settings() { return React.createElement(DoubaoSpeechSettings, { form: useDoubaoSpeechDraft(api.companionStt), save: saveStt }); }
    await act(async () => root.render(React.createElement(Settings)));
    const key = host.querySelector<HTMLInputElement>('[aria-label="豆包语音 API Key"]')!;
    expect(key.type).toBe('password'); expect(key.value).toBe('');
    expect(host.textContent).not.toMatch(/speech-secret|chat-secret/);
    expect(host.querySelector('a[href="https://console.volcengine.com/speech/new/overview"]')).toBeTruthy();
    expect(host.querySelector('a[href*="speech/new/setting/apikeys"]')).toBeTruthy();
    expect(saveStt).not.toHaveBeenCalled();
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('[aria-label="豆包识别服务规格"]')!;
      select.value = 'volc.seedasr.sauc.concurrent'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const submit = async () => act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === '保存并使用豆包')!.click());
    await submit(); expect(saveStt).toHaveBeenLastCalledWith({ provider: 'doubao', apiKey: 'speech-secret', resourceId: 'volc.seedasr.sauc.concurrent' });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(key, ' new-speech-key ');
      key.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await submit(); expect(saveStt).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'new-speech-key' }));
    expect(key.value).toBe(''); expect(JSON.stringify(api)).toBe(snapshot);
    await act(async () => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
    const remove = [...host.querySelectorAll('button')].find(button => button.textContent === '确认移除豆包 Key')!;
    await act(async () => remove.click());
    expect(saveStt).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'browser', apiKey: '' }));
  } finally { act(() => root.unmount()); host.remove(); }
});
it('uses the character route atomically and leaves a keyless proxy usable', () => {
  const api = { baseUrl: 'https://global.test', model: 'global', apiKey: 'global-secret' } as any;
  expect(companionDialogueReady(api, { dialogueApi: { baseUrl: '', model: '' } } as any)).toBe(false);
  expect(companionDialogueReady({ ...api, apiKey: '' })).toBe(true);
});

it('shows official registration links and current route without exposing keys or switching engines', async () => {
  const host = document.createElement('div'), root = createRoot(host); document.body.append(host);
  const navigate = vi.fn(), close = vi.fn();
  const api = { baseUrl: 'https://global.test', model: 'global', apiKey: 'secret-global', ttsProvider: 'minimax' } as any;
  const char = { id: 'c', name: 'C', dialogueApi: { baseUrl: 'https://role.test', model: 'role-model', apiKey: 'secret-role' } } as any;
  const snapshot = JSON.stringify({ api, char });
  try {
    await act(async () => root.render(React.createElement(CompanionSetupGuide, { api, char, canListen: false, navigate, close })));
    expect(host.textContent).toContain('角色独立 API · role-model');
    expect(host.textContent).not.toMatch(/secret-global|secret-role/);
    expect(host.textContent).toContain('此浏览器不支持');
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('[aria-label="查看语音平台指引"]')!; select.value = 'elevenlabs'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.querySelector('a[href="https://elevenlabs.io/app/sign-up"]')).toBeTruthy();
    expect(host.querySelector('a[href="https://elevenlabs.io/app/developers/api-keys"]')).toBeTruthy();
    expect(JSON.stringify({ api, char })).toBe(snapshot);
    for (const link of host.querySelectorAll('a')) { expect(link.target).toBe('_blank'); expect(link.rel).toContain('noreferrer'); expect(new URL(link.href).protocol).toBe('https:'); }
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === '配置当前角色 API')!.click());
    expect(navigate).toHaveBeenCalledWith('character');
    await act(async () => host.querySelector('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(close).toHaveBeenCalledOnce();
  } finally { act(() => root.unmount()); host.remove(); }
});

it('routes to the intended settings section or selected character without touching configuration', async () => {
  const host = document.createElement('div'), root = createRoot(host);
  const vision = vi.fn(), voice = vi.fn(), stt = vi.fn(), api = vi.fn(), open = vi.fn();
  function Sections() { useSettingsFocus('vision', vision); useSettingsFocus('voice', voice); useSettingsFocus('stt', stt); useSettingsFocus('api', api); return null; }
  try {
    openCompanionSetupTarget('vision', 'c', open);
    await act(async () => root.render(React.createElement(Sections)));
    expect(vision).toHaveBeenCalledOnce(); expect(voice).not.toHaveBeenCalled();
    act(() => openCompanionSetupTarget('voice', 'c', open)); expect(voice).toHaveBeenCalledOnce();
    act(() => openCompanionSetupTarget('stt', 'c', open)); expect(stt).toHaveBeenCalledOnce();
    act(() => openCompanionSetupTarget('api', 'c', open)); expect(api).toHaveBeenCalledOnce();
    expect(open).toHaveBeenLastCalledWith(AppID.Settings);
    openCompanionSetupTarget('character', 'selected-character', open);
    expect(open).toHaveBeenLastCalledWith(AppID.Character);
    expect(characterLaunch.consume()).toEqual({ charId: 'selected-character', detailTab: 'identity' });
  } finally { act(() => root.unmount()); }
});

it('saves a separate video endpoint and does not reuse a stored key after its URL changes', async () => {
  const host = document.createElement('div'), root = createRoot(host); document.body.append(host);
  const saveVideoApi = vi.fn(), changeImageMode = vi.fn();
  const api = { baseUrl: 'https://chat.test', model: 'chat', apiKey: 'chat-secret', companionVideoApi: { baseUrl: 'https://old-video.test/v1', model: 'video', apiKey: 'old-video-secret' } } as any;
  const snapshot = JSON.stringify(api);
  try {
    await act(async () => root.render(React.createElement(CompanionSetupGuide, { api, canListen: false, navigate: vi.fn(), close: vi.fn(), changeImageMode })));
    const direct = [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(input => input.parentElement!.textContent!.includes('主对话模型支持图片'))!;
    expect(direct.checked).toBe(false);
    await act(async () => direct.click());
    expect(changeImageMode).toHaveBeenCalledWith('direct'); expect(saveVideoApi).not.toHaveBeenCalled();
    await act(async () => root.render(React.createElement(CompanionVideoSettings, { api, saveVideoApi })));
    const key = host.querySelector<HTMLInputElement>('[aria-label="视频 API Key"]')!;
    expect(key.value).toBe(''); expect(key.type).toBe('password');
    expect(host.textContent).not.toContain('old-video-secret');

    await act(async () => {
      const url = host.querySelector<HTMLInputElement>('[aria-label="视频 API Base URL"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(url, 'https://new-video.test/v1');
      url.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(saveVideoApi).toHaveBeenCalledWith({ provider: 'custom', baseUrl: 'https://new-video.test/v1', model: 'video', apiKey: '' });
    expect(JSON.stringify(api)).toBe(snapshot);
  } finally { act(() => root.unmount()); host.remove(); }
});

it('switches provider drafts without carrying keys and configures Zhipu direct trials without storage', async () => {
  const host = document.createElement('div'), root = createRoot(host); document.body.append(host);
  const saveVideoApi = vi.fn();
  const api = { baseUrl: '', model: '', apiKey: '', companionVideoApi: { provider: 'doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'selected-model', apiKey: 'old-secret' } } as any;
  const fill = async (label: string, value: string) => act(async () => {
    const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const select = async (value: string) => act(async () => {
    const control = host.querySelector<HTMLSelectElement>('[aria-label="视频服务商"]')!;
    control.value = value; control.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const submit = async () => act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  try {
    await act(async () => root.render(React.createElement(CompanionVideoSettings, { api, saveVideoApi })));
    await fill('视频 API Key', 'draft-secret');
    await select('minimax');
    expect(saveVideoApi).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('[aria-label="视频 API Key"]')!.value).toBe('');
    expect(host.querySelector<HTMLInputElement>('[aria-label="视频模型 ID"]')!.value).toBe('MiniMax-M3.1-Flash');
    expect(host.querySelector('a[href="https://platform.minimax.cn/console/keys"]')).toBeTruthy();
    await submit();
    expect(saveVideoApi).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'minimax', baseUrl: 'https://api.minimax.cn/v1', apiKey: '' }));
    saveVideoApi.mockClear();
    await select('zhipu');
    expect(host.querySelector('[aria-label="临时上传服务地址"]')).toBeNull();
    expect(host.querySelector('[aria-label="临时上传口令"]')).toBeNull();
    expect(host.textContent).toContain('国内接口的本地 MP4 Base64 兼容性仍待实测');
    await fill('视频 API Key', 'zhipu-key'); await submit();
    expect(saveVideoApi).toHaveBeenCalledWith({ provider: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash', apiKey: 'zhipu-key' });
    expect(api.companionVideoApi.apiKey).toBe('old-secret');
  } finally { act(() => root.unmount()); host.remove(); }
});
