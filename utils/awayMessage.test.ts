// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CharacterProfile, Message } from '../types';
import { DB } from './db';
import { runLocalAwayMessages } from './awayMessage';
import { safeFetchJson } from './safeApi';
import { applyAssistantPostProcessing } from './applyAssistantPostProcessing';
import * as devDebug from './devDebug';

// Keep the actual context-range and chat-payload pipelines; only external generation/delivery is stubbed.
vi.mock('./activeMsgClient', () => ({ ActiveMsgClient: {} }));
vi.mock('../context/MusicContext', () => ({ loadMusicPlaybackSnapshot: () => null }));
vi.mock('./applyAssistantPostProcessing', () => ({ applyAssistantPostProcessing: vi.fn() }));
vi.mock('./safeApi', async importOriginal => ({ ...await importOriginal<typeof import('./safeApi')>(), safeFetchJson: vi.fn() }));

const NOW = Date.parse('2026-11-07T12:00:00Z');
let char: CharacterProfile;
let rows: Message[];
let serial = 0;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  char = { id: `away-integration-${serial++}`, name: '阿一', awayMessage: { enabled: true, delayMinutes: 90 },
    contextRangePolicyVersion: 1, contextRangeMode: 'manual', contextLimit: 10 } as CharacterProfile;
  rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, charId: char.id,
    role: i % 2 ? 'assistant' : 'user', type: 'text', timestamp: NOW - 6 * 60 * 60_000 + i * 1000,
    content: `HISTORY_${i + 1}_END`,
  }));
  vi.spyOn(DB, 'ensureHomeContextMessages').mockResolvedValue(undefined);
  vi.spyOn(DB, 'getRecentMessagesByCharId').mockImplementation(async (_id, limit) => rows.slice(-limit));
  vi.spyOn(DB, 'getMessagesFromId').mockImplementation(async (_id, fromId) => ({ messages: rows.filter(row => row.id >= fromId), totalCount: rows.length }));
  vi.spyOn(DB, 'getEmojis').mockResolvedValue([]);
  vi.spyOn(DB, 'getEmojiCategories').mockResolvedValue([]);
  vi.spyOn(DB, 'saveMessage');
  vi.mocked(safeFetchJson).mockResolvedValue({ choices: [{ message: { content: '刚看到一朵花\n[[NEXT]]\n又想起件事\n[[NEXT]]\n晚点聊' } }] });
  vi.mocked(applyAssistantPostProcessing).mockResolvedValue(undefined as any);
});
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

const generate = async () => {
  await runLocalAwayMessages({
    getCharacters: () => [char],
    getApiConfig: () => ({ baseUrl: 'https://fixture.invalid/v1', apiKey: '', model: 'fixture' }),
    getUserProfile: () => ({ name: '小明' } as any), getGroups: () => [], getRealtimeConfig: () => ({} as any),
    isBusyWith: () => false,
  });
  expect(safeFetchJson).toHaveBeenCalledOnce();
  return JSON.parse(String(vi.mocked(safeFetchJson).mock.calls[0][1]?.body)).messages as Array<{ role: string; content: string }>;
};

it.each(['adaptive', 'full-window', 'breakpoint', 'fully-archived', 'merged-system'] as const)(
  'delivers the away instruction once through the real API payload with %s history boundaries', async mode => {
    let firstVisible = 3;
    if (mode === 'adaptive' || mode === 'fully-archived') {
      char.contextRangeMode = 'adaptive'; char.autoArchiveEnabled = true;
      localStorage.setItem(`mp_lastMsgId_${char.id}`, mode === 'fully-archived' ? '12' : '8');
      firstVisible = mode === 'fully-archived' ? 13 : 9;
    }
    if (mode === 'breakpoint') { char.contextUserStartMessageId = 8; firstVisible = 8; }
    if (mode === 'merged-system') vi.spyOn(devDebug, 'isSystemMessageMergeEnabled').mockReturnValue(true);
    const messages = await generate();
    const hints = messages.filter(m => m.content.includes('请把这 3 次按时间先后分别写出来'));
    expect(hints).toHaveLength(1);
    expect(hints[0].role).toBe('user');
    expect(hints[0].content).toContain('分享随手拍的照片');
    const allText = messages.map(m => m.content).join('\n');
    for (let id = 1; id <= 12; id++) {
      expect(allText.includes(`HISTORY_${id}_END`)).toBe(id >= firstVisible);
    }
    if (mode !== 'merged-system') expect(messages[messages.indexOf(hints[0]) + 1].role).toBe('system');
    expect(DB.saveMessage).not.toHaveBeenCalled();
    expect(applyAssistantPostProcessing).toHaveBeenCalledTimes(3);
    expect(vi.mocked(applyAssistantPostProcessing).mock.calls.map(([text]) => text)).toEqual(['刚看到一朵花', '又想起件事', '晚点聊']);
  },
);

it('recognizes a recent archived meeting without bringing excluded meeting prose back into the request', async () => {
  rows.push({ id: 13, charId: char.id, role: 'assistant', type: 'text', timestamp: NOW - 30 * 60_000,
    content: 'EXCLUDED_DATE_PROSE', metadata: { source: 'date' } });
  char.contextRangeMode = 'adaptive'; char.autoArchiveEnabled = true;
  localStorage.setItem(`mp_lastMsgId_${char.id}`, '13');
  const messages = await generate();
  const allText = messages.map(m => m.content).join('\n');
  expect(allText).toContain('刚刚在线下见过面，现在暂时分开了');
  expect(allText).not.toContain('EXCLUDED_DATE_PROSE');
  expect(DB.saveMessage).not.toHaveBeenCalled();
});
