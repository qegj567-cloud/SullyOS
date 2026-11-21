import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DB } from '../db';
import { buildChatRequestPayload } from '../chatRequestPayload';
import { loadCharacterContextRange } from '../chatContextRange';
import { buildCharacterResponsePrinciples } from '../characterResponsePrinciples';
import { ContextBuilder } from '../context';
import { RealtimeContextManager, NotionManager, FeishuManager } from '../realtimeContext';
import * as palace from '../memoryPalace/pipeline';
import * as schedule from '../dailySchedule';
import * as life from '../lifeRecords';
import * as cabinet from '../../features/collaboration/chatLibrary';
import * as music from '../../context/MusicContext';
import * as api from '../safeApi';
import { createCompanionRequests } from './requests';
import { CompanionDebugStore } from './debug';
import type { CompanionLine } from './session';

vi.mock('../activeMsgRuntime', () => ({ prepareInboxBeforeChat: vi.fn(async () => {}) }));
beforeEach(() => { localStorage.clear(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-20T12:00:00Z')); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear(); });

// Compare real builders, not a mock of buildChatRequestPayload. The ChatApp side
// independently loads the same DB after its user input is saved, as useChatAI does.
it.each(['manual', 'adaptive'] as const)('matches ChatApp shared prompt bytes and history with a 360-row %s conversation', async mode => {
  const id = 'companion-chat-parity-' + mode, now = Date.now();
  const user: any = { name: '小雨' };
  const char: any = { id, name: '林间', contextRangePolicyVersion: 1, contextRangeMode: mode,
    contextLimit: 300, autoArchiveEnabled: mode === 'adaptive', memoryPalaceEnabled: true,
    chatCollaborationEnabled: true, scheduleFeatureEnabled: true, systemPrompt: '基础人设标记',
    worldview: '世界观标记', homeDefinition: { kind: 'between-worlds', notes: '家园定义标记' },
    memoryPalaceInjection: '旧召回不得残留', roomPlatesInjection: '旧门牌不得残留',
    mountedWorldbooks: [{ id: 'constant', title: '常驻', content: '常驻世界书标记', constant: true, position: 1 }],
  };
  const saved: number[] = [];
  for (let i = 0; i < 360; i++) saved.push(await DB.saveMessage({ charId: id,
    role: i % 3 === 0 ? 'user' : 'assistant', type: 'text', timestamp: now - 10000 + i,
    content: `历史序号${i}结束：${'这是一段保留原文的日常交流。'.repeat(12)}`,
    ...(i === 300 ? { metadata: { source: 'date' } } : {}),
  }));
  localStorage.setItem('mp_lastMsgId_' + id, String(saved[99]));
  await DB.saveCharacter(char);
  const groups: any[] = [{ id: id + '-group', name: '朋友群', members: [id] }];
  await DB.saveMessage({ charId: id, groupId: groups[0].id, role: 'user', type: 'text', timestamp: now - 500, content: '群聊背景标记' });
  vi.spyOn(DB, 'getGroups').mockResolvedValue(groups);
  vi.spyOn(RealtimeContextManager, 'buildFullContext').mockResolvedValue('天气热搜标记');
  vi.spyOn(NotionManager, 'getRecentDiaries').mockResolvedValue({ success: true, entries: [{ date: '今天', title: 'Notion日记标记' }] } as any);
  vi.spyOn(NotionManager, 'getUserNotes').mockResolvedValue({ success: true, entries: [{ date: '今天', title: 'Notion笔记标记' }] } as any);
  vi.spyOn(FeishuManager, 'getRecentDiaries').mockResolvedValue({ success: true, entries: [{ date: '今天', title: '飞书日记标记' }] } as any);
  vi.spyOn(schedule, 'getDailyScheduleForChar').mockResolvedValue({ slots: [{ startTime: '00:00', activity: '日程标记' }] } as any);
  vi.spyOn(life, 'buildLifeRecordInjection').mockResolvedValue('生活档案标记');
  vi.spyOn(cabinet, 'loadCollaborationFileCabinetBlock').mockResolvedValue('协同文件柜标记');
  const recall = vi.spyOn(palace, 'injectMemoryPalace').mockImplementation(async c => {
    c.memoryPalaceInjection = '本轮记忆召回标记'; c.roomPlatesInjection = '本轮房间门牌标记'; return { stages: [] } as any;
  });
  const realtimeConfig: any = { weatherEnabled: true, newsEnabled: true, notionEnabled: true, notionApiKey: 'test',
    notionDatabaseId: 'd', notionNotesDatabaseId: 'n', feishuEnabled: true, feishuAppId: 'a', feishuAppSecret: 'b', feishuBaseId: 'c', feishuTableId: 'd' };
  const musicSnapshot: any = { current: { id: 1, name: '共听歌曲标记', artists: '歌手' }, playing: true,
    lyric: [{ time: 0, text: '共听歌词标记' }], activeLyricIdx: 0, listeningTogetherWith: [id], cfg: {} };
  vi.spyOn(music, 'loadMusicPlaybackSnapshot').mockReturnValue(musicSnapshot);
  const debug = new CompanionDebugStore(), signal = new AbortController().signal;
  const current: CompanionLine = { id: 1, text: '本轮问题标记', heard: '本轮问题标记', role: 'user', at: now, status: 'done' };
  const requests = createCompanionRequests({ char, user, realtimeConfig, debug, style: '仅短回复语气', scene: () => '现场标记',
    api: { baseUrl: 'https://example.invalid/v1', apiKey: 'test', model: 'same-model', stream: false } as any });
  debug.start(signal, current.text);
  const companion = await requests.prepare([current], Promise.resolve('本轮短回复标记'), signal);
  expect(recall).toHaveBeenCalledOnce();
  await DB.saveMessage({ charId: id, role: 'user', type: 'text', timestamp: now, content: current.text });
  const range = await loadCharacterContextRange(char);
  const chat = await buildChatRequestPayload({ char, userProfile: user, groups, emojis: [], categories: [],
    historyMsgs: range.messages, recentMsgsHint: range.messages.filter(message => !message.metadata?.source),
    contextLimit: range.messages.length, contextHighWaterMark: range.hwm, recallEntryPoint: 'chat_app', realtimeConfig, musicSnapshot });

  // Synthetic pending IDs may differ from saved IDs; every actual recall field is equal.
  const recallRows = (rows: any[]) => rows.map(({ id: _id, ...row }) => row);
  expect(recallRows(recall.mock.calls[0][1]!)).toEqual(recallRows(recall.mock.calls[1][1]!));
  expect(companion.cleanedApiMessages.slice(0, -2)).toEqual(chat.cleanedApiMessages);
  expect(companion.fullMessages[0].content.split('你正在「同行」中')[0])
    .toBe(chat.fullMessages[0].content.split('### 聊天 App 行为规范')[0]);
  const companionTail = String(companion.fullMessages.at(-1)!.content);
  const coreTail = companionTail.slice(0, companionTail.indexOf('\n你正在「同行」中')) + buildCharacterResponsePrinciples(char.name, user.name);
  expect(coreTail).toBe(String(chat.fullMessages.at(-1)!.content).replace(`\n${ContextBuilder.buildMusicActionGuide(true)}\n`, ''));
  for (const marker of ['基础人设标记', '世界观标记', '家园定义标记', '常驻世界书标记', '天气热搜标记',
    'Notion日记标记', 'Notion笔记标记', '飞书日记标记', '群聊背景标记', '日程标记', '生活档案标记',
    '协同文件柜标记', '本轮记忆召回标记', '本轮房间门牌标记', '共听歌曲标记', '共听歌词标记']) {
    expect(JSON.stringify(companion.fullMessages), marker).toContain(marker);
    expect(JSON.stringify(chat.fullMessages), marker).toContain(marker);
  }
  const send = vi.spyOn(api, 'safeFetchJson').mockResolvedValue({ choices: [{ message: { content: '续答正文' } }] });
  await requests.full(companion, signal);
  const sent = JSON.parse(String(send.mock.calls[0][1].body));
  expect(sent.messages.slice(0, -1)).toEqual(companion.fullMessages);
  expect(sent.messages.at(-1)).toMatchObject({ role: 'user' });
  expect(sent.stream).toBe(false);
  expect(JSON.stringify(sent).match(/本轮短回复标记/g)).toHaveLength(1);
  expect(JSON.stringify(sent).match(/本轮问题标记/g)).toHaveLength(1);
  expect(JSON.stringify(sent)).not.toMatch(/旧召回不得残留|旧门牌不得残留|仅短回复语气/);
  expect(debug.getSnapshot()[0].requests.full?.body).toBe(send.mock.calls[0][1].body);
  expect(companion.flags.promptBuildSkipped).toBe(false);
});
