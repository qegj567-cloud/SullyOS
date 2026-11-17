// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CompanionSetupGuide } from '../../components/companion/CompanionSetupGuide';
import { companionDialogueReady, openCompanionSetupTarget } from './setup';
import { characterLaunch } from '../characterLaunch';
import { useSettingsFocus } from '../settingsNavigation';
import { AppID } from '../../types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it('configures Doubao STT separately, keeps a saved key hidden and supplies direct registration links', async () => {
  const host = document.createElement('div'), root = createRoot(host); document.body.append(host);
  const saveStt = vi.fn();
  const api = { baseUrl: 'https://chat.test', model: 'chat', apiKey: 'chat-secret',
    companionStt: { provider: 'doubao', apiKey: 'speech-secret', resourceId: 'volc.seedasr.sauc.duration' } } as any;
  const snapshot = JSON.stringify(api);
  try {
    await act(async () => root.render(React.createElement(CompanionSetupGuide, { api, canListen: true, navigate: vi.fn(), close: vi.fn(), saveStt })));
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
    const submit = async () => act(async () => key.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await submit(); expect(saveStt).toHaveBeenLastCalledWith({ provider: 'doubao', apiKey: 'speech-secret', resourceId: 'volc.seedasr.sauc.concurrent' });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(key, ' new-speech-key ');
      key.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await submit(); expect(saveStt).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: 'new-speech-key' }));
    expect(key.value).toBe(''); expect(JSON.stringify(api)).toBe(snapshot);
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
  const vision = vi.fn(), voice = vi.fn(), api = vi.fn(), open = vi.fn();
  function Sections() { useSettingsFocus('vision', vision); useSettingsFocus('voice', voice); useSettingsFocus('api', api); return null; }
  try {
    openCompanionSetupTarget('vision', 'c', open);
    await act(async () => root.render(React.createElement(Sections)));
    expect(vision).toHaveBeenCalledOnce(); expect(voice).not.toHaveBeenCalled();
    act(() => openCompanionSetupTarget('voice', 'c', open)); expect(voice).toHaveBeenCalledOnce();
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
    await act(async () => root.render(React.createElement(CompanionSetupGuide, { api, canListen: false, navigate: vi.fn(), close: vi.fn(), saveVideoApi, changeImageMode })));
    const key = host.querySelector<HTMLInputElement>('[aria-label="视频 API Key"]')!;
    expect(key.value).toBe(''); expect(key.type).toBe('password');
    expect(host.textContent).not.toContain('old-video-secret');
    // Stored-key removal is the first checkbox; the image opt-in is separate and starts off.
    const direct = [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(input => input.parentElement!.textContent!.includes('主对话模型支持图片'))!;
    expect(direct.checked).toBe(false);
    await act(async () => direct.click());
    expect(changeImageMode).toHaveBeenCalledWith('direct'); expect(saveVideoApi).not.toHaveBeenCalled();
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
    await act(async () => root.render(React.createElement(CompanionSetupGuide, { api, canListen: false, navigate: vi.fn(), close: vi.fn(), saveVideoApi })));
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
    expect(host.textContent).toContain('国内接口是否接收仍需实测');
    await fill('视频 API Key', 'zhipu-key'); await submit();
    expect(saveVideoApi).toHaveBeenCalledWith({ provider: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash', apiKey: 'zhipu-key' });
    expect(api.companionVideoApi.apiKey).toBe('old-secret');
  } finally { act(() => root.unmount()); host.remove(); }
});
