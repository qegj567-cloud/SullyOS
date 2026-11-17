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
      const select = host.querySelector('select')!; select.value = 'elevenlabs'; select.dispatchEvent(new Event('change', { bubbles: true }));
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
