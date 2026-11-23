// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import MusicApp from '../apps/MusicApp';
import { musicApi, MUSIC_DEFAULT_CFG, MusicProvider, useMusic } from '../context/MusicContext';
import { clearAll } from './musicCache';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const os = { characters: [], userProfile: {}, addToast: vi.fn(), closeApp: vi.fn() };
vi.mock('../context/OSContext', () => ({ useOS: () => os }));

it('只在打开音乐后读取账号，换号时忽略慢响应，读到喜欢状态后才允许取消收藏', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  let music!: ReturnType<typeof useMusic>;
  function Observer() { music = useMusic(); return null; }
  const render = (open: boolean) => act(async () => root.render(createElement(MusicProvider, {
    children: createElement(Fragment, null, createElement(Observer), open && createElement(MusicApp)),
  })));
  const firstCfg = { ...MUSIC_DEFAULT_CFG, cookie: 'test-account-first' };
  localStorage.setItem('sully_music_cfg_v1', JSON.stringify(firstCfg));
  localStorage.setItem('sully_music_state_v1', JSON.stringify({ idx: 0, queue: [{ id: 7, name: '测试曲' }] }));
  let finishFirst!: (result: unknown) => void;
  const firstAccount = new Promise(resolve => { finishFirst = resolve; });
  const request = vi.spyOn(musicApi, '_raw').mockImplementation(async (cfg, path) => {
    if (cfg.cookie === firstCfg.cookie) return firstAccount;
    if (path === '/login/status') return { data: { profile: { userId: 8, nickname: '新账号' } } };
    if (path === '/likelist') return { ids: [7] };
    return { code: 200 };
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  try {
    await render(false);
    expect(request).not.toHaveBeenCalled();
    await render(true);
    expect(request.mock.calls.map(([, path]) => path).sort()).toEqual(['/likelist', '/login/status']);
    expect(host.textContent).toContain('正在读取网易云账号');
    expect(await music.toggleLike()).toBe(false);
    await act(async () => music.setCfg({ ...firstCfg, cookie: 'test-account-second' }));
    expect(music.profile?.nickname).toBe('新账号');
    expect(music.liked).toBe(true);
    await act(async () => finishFirst({ ids: [], data: { profile: { nickname: '旧账号' } } }));
    expect(music.profile?.nickname).toBe('新账号');
    expect(music.liked).toBe(true);
    await act(async () => { expect(await music.toggleLike()).toBe(true); });
    expect(request).toHaveBeenCalledWith(music.cfg, '/like', { id: 7, like: false });
    expect(music.liked).toBe(false);
    await render(false);
    request.mockClear();
    await act(async () => music.setCfg(firstCfg));
    expect(request).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    localStorage.clear();
    clearAll();
  }
});
