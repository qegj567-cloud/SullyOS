// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatAI } from '../hooks/useChatAI';
import { DB } from './db';
import { safeFetchJson } from './safeApi';
import { generateHomeReply, buildHomeScenePrompt } from './homeConversation';
import { ContextBuilder } from './context';

const shared = vi.hoisted(() => ({ music: {} as any }));
vi.mock('../context/MusicContext', () => ({ loadMusicPlaybackSnapshot: () => shared.music, loadMusicHooks: () => null }));
vi.mock('./keepAlive', () => ({ KeepAlive: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('./activeMsgRuntime', () => ({ prepareInboxBeforeChat: vi.fn(async () => 'completed') }));
vi.mock('./safeApi', async original => ({ ...await original<typeof import('./safeApi')>(), safeFetchJson: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
 localStorage.clear();
 vi.useFakeTimers({ toFake: ['Date'] });
 vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); localStorage.clear(); });

it.each(['manual', 'adaptive'] as const)('actual ChatApp and home network requests share %s context and music intro', async mode => {
 const id = 'entry-parity-' + mode, now = Date.now();
 const user: any = { name: '小雨' }, api: any = { baseUrl: 'https://test.invalid/v1', model: 'test', stream: false };
 const records: any[] = [
  { id: 'action', at: now - 3000, actor: 'character', kind: 'action', source: 'local', text: '坐在沙发上', roomId: 'r', roomName: '客厅' },
  { id: 'input', at: now, actor: 'user', kind: 'message', source: 'user', text: '前奏真好听', roomId: 'r', roomName: '客厅' },
 ];
 const char: any = { id, name: 'C', systemPrompt: '共同人设', contextRangePolicyVersion: 1, contextRangeMode: mode, contextLimit: 10,
  autoArchiveEnabled: mode === 'adaptive', emotionConfig: { enabled: false }, home3D: { records } };
 const old = await DB.saveMessage({ charId: id, role: 'user', type: 'text', timestamp: now - 5000, content: '水位前的原文' });
 await DB.saveMessage({ charId: id, role: 'assistant', type: 'text', timestamp: now - 2000, content: '夹在家园记录之间的私聊' });
 await DB.saveCharacter(char);
 localStorage.setItem('mp_lastMsgId_' + id, String(old));
 shared.music = { current: { id: 1, name: '前奏歌曲', artists: '歌手' }, playing: true, lyric: [{ time: 10, text: '还没唱到的歌词' }], activeLyricIdx: -1, listeningTogetherWith: [id], cfg: {} };
 const realtimeConfig: any = { weatherEnabled: false, newsEnabled: false };
 let chat!: ReturnType<typeof useChatAI>;
 function Probe() {
  chat = useChatAI({ worldbookScene: 'chat.private', char, apiConfig: api, userProfile: user, groups: [], emojis: [], categories: [], realtimeConfig,
   addToast: vi.fn(), setMessages: vi.fn(), updateCharacter: vi.fn(), updateUserProfile: vi.fn() });
  return null;
 }
 const root = createRoot(document.createElement('div'));
 vi.mocked(safeFetchJson).mockRejectedValue(new Error('test: captured request'));
 vi.spyOn(console, 'error').mockImplementation(() => {});
 try {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"text":"好听"}' } }] })));
  const scene: any = { roomId: 'r', roomName: '客厅', present: true, busy: false, actions: [] };
  await generateHomeReply({ char, user, api, scene, records, signal: new AbortController().signal, context: { groups: [], emojis: [], categories: [], realtimeConfig, musicSnapshot: shared.music } });
  expect(fetcher).toHaveBeenCalledOnce();
  const homeMessages = JSON.parse(fetcher.mock.calls[0][1]!.body as string).messages;
  // Home's generator returns text without persisting it. Capture ChatApp second:
  // its deliberately rejected transport writes an error row after the request.
  await act(async () => { root.render(createElement(Probe)); });
  await act(async () => { await chat.triggerAI([]); });
  expect(safeFetchJson).toHaveBeenCalledOnce();
  const chatMessages = JSON.parse(vi.mocked(safeFetchJson).mock.calls[0][1]!.body as string).messages;
  expect(homeMessages.slice(1, -1)).toEqual(chatMessages.slice(1, -1));
  expect(homeMessages[0].content).toBe(chatMessages[0].content.split('### 聊天 App 行为规范')[0]);
  expect(homeMessages.at(-1).content.replace(buildHomeScenePrompt(user, scene), '')).toBe(chatMessages.at(-1).content.replace(`\n${ContextBuilder.buildMusicActionGuide(true)}\n`, ''));
  const sent = JSON.stringify(homeMessages);
  expect(sent.includes('水位前的原文')).toBe(mode === 'manual');
  expect(sent).toContain('前奏歌曲');
  expect(sent).not.toContain('还没唱到的歌词');
  expect(sent.indexOf('坐在沙发上')).toBeLessThan(sent.indexOf('夹在家园记录之间的私聊'));
  expect(sent.indexOf('夹在家园记录之间的私聊')).toBeLessThan(sent.indexOf('前奏真好听'));
 } finally { act(() => root.unmount()); }
});
