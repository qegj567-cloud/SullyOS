// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CharacterProfile, Message } from '../types';
import { DB } from './db';
import { ActiveMsgClient } from './activeMsgClient';
import * as amsg2ToolBridge from './amsg2ToolBridge';
import { runLocalAwayMessages, runLocalProactiveTurn, syncCloudAwayTaskFromRecent } from './awayMessage';
import { safeFetchJson } from './safeApi';
import { applyAssistantPostProcessing } from './applyAssistantPostProcessing';
import * as devDebug from './devDebug';
import { evaluateEmotionBackground } from '../hooks/useChatAI';
import * as mcpClient from './mcpClient';
import * as mcpToolBridge from './mcpToolBridge';
import { BILINGUAL_TAIL_REMINDER } from './chatOutputStylePrompt';
import { LEGACY_PROACTIVE_HINT_HEADING } from './amsgFirePack';
import { buildDateLeaveInstruction } from './amsgFireSchedule';
import * as activeMsgClient from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import * as userHolidays from './userHolidays';
import { formatFireTimeFull } from './amsgFirePack';
import { planAwaySlots } from './awayMessageCore';

// Keep the actual context-range and chat-payload pipelines; only external generation/delivery is stubbed.
vi.mock('./activeMsgClient', async importOriginal => ({
  ...await importOriginal<typeof import('./activeMsgClient')>(),
  ActiveMsgClient: {
    scheduleCharacterTask: vi.fn(),
    updatePendingTasksRemote: vi.fn(),
  },
}));
vi.mock('../hooks/useChatAI', () => ({ evaluateEmotionBackground: vi.fn() }));
vi.mock('../context/MusicContext', () => ({ loadMusicPlaybackSnapshot: () => null }));
vi.mock('./applyAssistantPostProcessing', async importOriginal => ({
  ...await importOriginal<typeof import('./applyAssistantPostProcessing')>(),
  applyAssistantPostProcessing: vi.fn(),
}));
vi.mock('./safeApi', async importOriginal => ({ ...await importOriginal<typeof import('./safeApi')>(), safeFetchJson: vi.fn() }));

const NOW = Date.parse('2026-11-07T12:00:00Z');
let char: CharacterProfile;
let rows: Message[];
let serial = 0;
let saved: any[];
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
  saved = [];
  vi.spyOn(DB, 'saveMessage').mockImplementation(async (m: any) => { saved.push(m); return 1000 + saved.length; });
  vi.spyOn(DB, 'deleteMessages').mockResolvedValue(undefined as any);
  vi.mocked(safeFetchJson).mockResolvedValue({ choices: [{ message: { content: '刚看到一朵花\n[[NEXT]]\n又想起件事\n[[NEXT]]\n晚点聊' } }] });
  // 代替真后处理：把这一段原样存一条，走调用方给的落库入口。
  vi.mocked(applyAssistantPostProcessing).mockImplementation(async (text, ctx) => {
    await (ctx.replyRun?.saveMessage ?? DB.saveMessage)({ charId: ctx.char.id, role: 'assistant', type: 'text', content: text, timestamp: ctx.messageTimestamp, metadata: ctx.mcdInheritMeta } as any);
  });
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
const requestBody = () => JSON.parse(String(vi.mocked(safeFetchJson).mock.calls[0][1]?.body));
/** 本地版发出去的全部提示词文字。 */
const generatePrompt = async () => (await generate()).map(m => m.content).join('\n');

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
    // 与云端 fire_pack 模板同形：整份上下文是一条 user 消息。
    expect(messages.map(m => m.role)).toEqual(['user']);
    const prompt = messages[0].content;
    expect(prompt).toContain('【本次任务】');
    expect(prompt.split('请把这 3 次按时间先后分别写出来')).toHaveLength(2);
    expect(prompt).toContain('分享随手拍的照片');
    for (let id = 1; id <= 12; id++) {
      expect(prompt.includes(`HISTORY_${id}_END`)).toBe(id >= firstVisible);
    }
    expect(saved.some(m => String(m.content).includes('【本次任务】'))).toBe(false);
    expect(applyAssistantPostProcessing).toHaveBeenCalledTimes(3);
    expect(vi.mocked(applyAssistantPostProcessing).mock.calls.map(([text]) => text)).toEqual(['刚看到一朵花', '又想起件事', '晚点聊']);
  },
);

it('skips away generation while character is busy (active or suspended meeting/call)', async () => {
  await runLocalAwayMessages({
    getCharacters: () => [char],
    getApiConfig: () => ({ baseUrl: 'https://fixture.invalid/v1', apiKey: '', model: 'fixture' }),
    getUserProfile: () => ({ name: '小明' } as any), getGroups: () => [], getRealtimeConfig: () => ({} as any),
    isBusyWith: id => id === char.id,
  });
  expect(safeFetchJson).not.toHaveBeenCalled();
});

it('does not trigger away generation when recent meeting prose exists without user turns', async () => {
  rows.push({ id: 13, charId: char.id, role: 'assistant', type: 'text', timestamp: NOW - 30 * 60_000,
    content: 'RECENT_DATE_PROSE', metadata: { source: 'date' } });
  await runLocalAwayMessages({
    getCharacters: () => [char],
    getApiConfig: () => ({ baseUrl: 'https://fixture.invalid/v1', apiKey: '', model: 'fixture' }),
    getUserProfile: () => ({ name: '小明' } as any), getGroups: () => [], getRealtimeConfig: () => ({} as any),
    isBusyWith: () => false,
  });
  expect(safeFetchJson).not.toHaveBeenCalled();
});

it('recognizes a recent archived meeting without bringing excluded meeting prose back into the request', async () => {
  rows.push({ id: 13, charId: char.id, role: 'assistant', type: 'text', timestamp: NOW - 100 * 60_000,
    content: 'EXCLUDED_DATE_PROSE', metadata: { source: 'date' } });
  char.contextRangeMode = 'adaptive'; char.autoArchiveEnabled = true;
  localStorage.setItem(`mp_lastMsgId_${char.id}`, '13');
  const allText = await generatePrompt();
  expect(allText).toContain('刚刚在线下见过面，现在暂时分开了');
  expect(allText).toContain('上一次在线下互动是在');
  expect(allText).not.toContain('EXCLUDED_DATE_PROSE');
  expect(saved.some(m => String(m.content).includes('【本次任务】'))).toBe(false);
});

it('schedules or renews 2.0 cloud away task from recent meeting/call records even without user rows', async () => {
  const dateAt = NOW - 5 * 60_000;
  rows.push({ id: 13, charId: char.id, role: 'assistant', type: 'text', timestamp: dateAt,
    content: 'DATE_OPENING', metadata: { source: 'date' } });
  char.activeMsg2Config = { enabled: true, tasks: [] } as any;
  vi.spyOn(amsg2ToolBridge, 'isAmsg2GlobalReady').mockResolvedValue(true);
  vi.mocked(ActiveMsgClient.scheduleCharacterTask).mockResolvedValue({
    uuid: 'away-uuid-1',
    clientTaskId: 'ctid-away-1',
    firstSendAt: new Date(dateAt + 90 * 60_000).toISOString(),
  } as any);
  const updateCharacter = vi.fn();

  await syncCloudAwayTaskFromRecent({
    char,
    userProfile: { name: '小明' } as any,
    groups: [],
    realtimeConfig: {} as any,
    apiConfig: { baseUrl: 'https://fixture.invalid/v1', apiKey: '', model: 'fixture' },
    updateCharacter,
  });

  expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenCalledWith(expect.objectContaining({
    task: expect.objectContaining({
      firstSendTime: new Date(dateAt + 90 * 60_000).toISOString(),
      away: { delayMinutes: 90 },
    }),
  }));
  expect(updateCharacter).toHaveBeenCalledOnce();
});

// ─── 本地版与云端 fire_pack 模板对齐（逐字对照见 awayMessage.parity.test.ts） ───

it('开了双语的角色带上双语格式说明', async () => {
  localStorage.setItem(`chat_translate_enabled_${char.id}`, 'true');
  expect(await generatePrompt()).toContain(BILINGUAL_TAIL_REMINDER);
});

it('模型参数与私聊同一套：带温度和输出上限', async () => {
  await generate();
  const body = requestBody();
  expect(body.temperature).toBe(0.85);
  expect(body.max_tokens).toBe(8000);
  expect(body.thinking).toBeUndefined();
});

it('开了心象时带思考参数、不带温度', async () => {
  char.showThinkingChain = true;
  await generate();
  const body = requestBody();
  expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4000 });
  expect(body.temperature).toBeUndefined();
  expect(body.max_tokens).toBe(8000);
});

it('每段照常跑后处理的二轮工具，思考链只挂第一段', async () => {
  await generate();
  const calls = vi.mocked(applyAssistantPostProcessing).mock.calls;
  expect(calls.map(([, ctx]) => ctx.skipSecondPassLLM)).toEqual([undefined, undefined, undefined]);
  expect(calls.map(([, ctx]) => ctx.initialData === null)).toEqual([false, true, true]);
  expect(calls[0][1].fullMessages).toEqual(JSON.parse(String(vi.mocked(safeFetchJson).mock.calls[0][1]?.body)).messages);
});

it('用到要回连模型的标签时合成一次发，二轮请求按只发一次的指令', async () => {
  vi.mocked(safeFetchJson).mockResolvedValue({ choices: [{ message: { content: '刚看到一朵花\n[[NEXT]]\n[[RECALL: 2026-10]]\n[[NEXT]]\n晚点聊' } }] });
  await generate();
  const calls = vi.mocked(applyAssistantPostProcessing).mock.calls;
  expect(calls).toHaveLength(1);
  const [text, ctx] = calls[0];
  expect(text).toBe('刚看到一朵花\n[[RECALL: 2026-10]]\n晚点聊');
  expect(ctx.skipSecondPassLLM).toBeUndefined();
  expect(ctx.fullMessages).toHaveLength(1);
  expect(ctx.fullMessages[0].content).toContain('【本次任务】');
  expect(ctx.fullMessages[0].content).not.toContain('[[NEXT]]');
});

it('整条只有一个标签时也交给后处理去回连模型', async () => {
  vi.mocked(safeFetchJson).mockResolvedValue({ choices: [{ message: { content: '[[SEARCH: 今天的晚霞]]' } }] });
  await generate();
  expect(applyAssistantPostProcessing).toHaveBeenCalledOnce();
  const [text, ctx] = vi.mocked(applyAssistantPostProcessing).mock.calls[0];
  expect(text).toBe('[[SEARCH: 今天的晚霞]]');
  expect(ctx.skipSecondPassLLM).toBeUndefined();
  expect(ctx.initialData).not.toBeNull();
});

it('不执行 MCP 就不教：不带 MCP 说明，请求也不带工具', async () => {
  vi.spyOn(mcpClient, 'isMcpChatAvailable').mockReturnValue(true);
  vi.spyOn(mcpToolBridge, 'buildMcpSystemBlock').mockReturnValue('\nMCP_BLOCK_MARK\n');
  const prompt = await generatePrompt();
  expect(prompt).not.toContain('MCP_BLOCK_MARK');
  expect(prompt).not.toContain('MCP 工具 ON');
  expect(requestBody().tools).toBeUndefined();
});

it('不带云端模板写明不该带的块', async () => {
  char.chatCollaborationEnabled = true;
  const prompt = await generatePrompt();
  expect(prompt).toContain('### 协同功能');
  expect(prompt).not.toContain('系统另给已有文件标题');
});

it('角色 2.0 关着时不教本地 [schedule_message]（它没有任何上限）', async () => {
  expect(await generatePrompt()).not.toContain('[schedule_message');
});

it('到点必发：不给「这次不说」的选项', async () => {
  expect(await generatePrompt()).not.toContain('【开口之前】');
});

it('见面离开提醒用云端同一份指令，去掉「突然想起对方」的通用提示', async () => {
  const sent = await runLocalProactiveTurn(char, {
    apiConfig: { baseUrl: 'https://fixture.invalid/v1', apiKey: '', model: 'fixture' },
    userProfile: { name: '小明' } as any, groups: [], realtimeConfig: {} as any,
    hint: buildDateLeaveInstruction(), purpose: '见面离开提醒', meta: { dateLeaveReminder: true },
    place: text => [{ text, at: NOW }], stillWanted: async () => true,
  });
  expect(sent).toBe(true);
  const body = requestBody();
  expect(body.messages).toHaveLength(1);
  const prompt = body.messages[0].content as string;
  expect(prompt).toContain(`【本次任务】\n${buildDateLeaveInstruction()}`);
  expect(prompt).not.toContain(LEGACY_PROACTIVE_HINT_HEADING);
  expect(prompt).not.toContain('【开口之前】');
});

it('回复落库后跑一次情绪评估，口径与私聊同一份', async () => {
  char.scheduleFeatureEnabled = true;
  char.emotionConfig = { enabled: true } as any;
  const messages = await generate();
  await vi.waitFor(() => expect(evaluateEmotionBackground).toHaveBeenCalledOnce());
  const [evalChar, evalUser, systemPrompt, history, api] = vi.mocked(evaluateEmotionBackground).mock.calls[0];
  expect(evalChar.id).toBe(char.id);
  expect(evalUser).toMatchObject({ name: '小明' });
  // 与云端定时类一致：整份提示词当作「角色此刻看到的上下文」，没有另外的对话历史。
  expect(systemPrompt).toBe(messages[0].content);
  expect(history).toEqual([]);
  expect(api).toEqual({ baseUrl: 'https://fixture.invalid/v1', apiKey: '', model: 'fixture', stream: false });
  // 落库在前，评估在后。
  expect(vi.mocked(applyAssistantPostProcessing).mock.invocationCallOrder.at(-1)!)
    .toBeLessThan(vi.mocked(evaluateEmotionBackground).mock.invocationCallOrder[0]);
});

it('情绪评估没开时不跑', async () => {
  char.scheduleFeatureEnabled = true;
  char.emotionConfig = { enabled: false } as any;
  await generate();
  await new Promise(r => setTimeout(r, 0));
  expect(evaluateEmotionBackground).not.toHaveBeenCalled();
});

// ─── 作废、出错、时间线、回执 ───

const receivedEvents = () => {
  const got: any[] = [];
  window.addEventListener('active-msg-received', (e) => got.push((e as CustomEvent).detail));
  return got;
};

it('每一段落库前都重新确认：用户回来了就中止，后面的段不再落库，不弹通知、不跑评估', async () => {
  char.scheduleFeatureEnabled = true;
  char.emotionConfig = { enabled: true } as any;
  const got = receivedEvents();
  // 第一次（生成完、落库前）还在离开中；第一段落库后用户回来说了话。
  let checks = 0;
  vi.mocked(applyAssistantPostProcessing).mockImplementation(async (text, ctx) => {
    await (ctx.replyRun?.saveMessage ?? DB.saveMessage)({ charId: ctx.char.id, role: 'assistant', type: 'text', content: text, metadata: ctx.mcdInheritMeta } as any);
    rows.push({ id: 100 + ++checks, charId: char.id, role: 'user', type: 'text', timestamp: NOW, content: '我回来了' } as any);
  });
  await generate();
  expect(applyAssistantPostProcessing).toHaveBeenCalledOnce();
  // 已经落库的那段按私聊「停止回复」的规矩处理：聊天页没展示过的才撤，这里没有聊天页，原样保留。
  expect(DB.deleteMessages).not.toHaveBeenCalled();
  expect(got).toEqual([]);
  await new Promise(r => setTimeout(r, 0));
  expect(evaluateEmotionBackground).not.toHaveBeenCalled();
});

it('回连请求之前也重新确认，后处理拿到能中止的 replyRun', async () => {
  let ctxSeen: any;
  vi.mocked(applyAssistantPostProcessing).mockImplementation(async (_text, ctx) => { ctxSeen = ctx; });
  vi.mocked(safeFetchJson).mockResolvedValue({ choices: [{ message: { content: '[[SEARCH: 晚霞]]' } }] });
  await generate();
  expect(ctxSeen.replyRun).toBeTruthy();
  expect(typeof ctxSeen.beforeSecondPass).toBe('function');
  await ctxSeen.beforeSecondPass();
  rows.push({ id: 200, charId: char.id, role: 'user', type: 'text', timestamp: NOW, content: '我回来了' } as any);
  await expect(ctxSeen.beforeSecondPass()).rejects.toMatchObject({ name: 'AbortError' });
  expect(ctxSeen.replyRun.signal.aborted).toBe(true);
});

it('中途抛错时，已经落库的段照样发通知、照样跑情绪评估', async () => {
  char.scheduleFeatureEnabled = true;
  char.emotionConfig = { enabled: true } as any;
  const got = receivedEvents();
  vi.mocked(applyAssistantPostProcessing)
    .mockImplementationOnce(async (text, ctx) => {
      await (ctx.replyRun?.saveMessage ?? DB.saveMessage)({ charId: ctx.char.id, role: 'assistant', type: 'text', content: text, metadata: ctx.mcdInheritMeta } as any);
    })
    .mockRejectedValueOnce(new Error('第二段落库失败'));
  await generate();
  expect(got).toHaveLength(1);
  expect(got[0].body).toBe('刚看到一朵花');
  await vi.waitFor(() => expect(evaluateEmotionBackground).toHaveBeenCalledOnce());
});

it('补发多次时只有一个「现在」：按第一次发送的时刻渲染，后面几次写成之后才会发', async () => {
  const spy = vi.spyOn(userHolidays, 'getUserHolidayReminder').mockResolvedValue('');
  const prompt = await (async () => {
    await runLocalAwayMessages({
      getCharacters: () => [char],
      getApiConfig: () => ({ baseUrl: 'https://fixture.invalid/v1', apiKey: '', model: 'fixture' }),
      getUserProfile: () => ({ name: '小明' } as any), getGroups: () => [],
      getRealtimeConfig: () => ({ userHolidays: { enabled: true } } as any), isBusyWith: () => false,
    });
    return JSON.parse(String(vi.mocked(safeFetchJson).mock.calls[0][1]?.body)).messages[0].content as string;
  })();
  const lastUserAt = rows.filter(r => r.role === 'user').at(-1)!.timestamp;
  const slots = planAwaySlots(lastUserAt, 90 * 60_000, NOW).map(t => Math.max(t, rows.at(-1)!.timestamp + 1));
  const tz = { tzId: Intl.DateTimeFormat().resolvedOptions().timeZone };
  expect(prompt).toContain(formatFireTimeFull(slots[0], tz));
  expect(prompt).not.toContain(formatFireTimeFull(NOW, tz));
  expect(prompt).toContain('你还会');
  expect(prompt).not.toMatch(/分别在[^\n]*（你那边的时间）。\n后面几次/);
  // 用户所在地节日也按同一个时刻取。
  expect(spy).toHaveBeenCalled();
  expect(spy.mock.calls.every(call => call[2] === slots[0])).toBe(true);
});

it('提示词带进去的「上次排的没发出去」回执，发送成功后标成已告知', async () => {
  const realBuild = activeMsgClient.buildFirePack;
  vi.spyOn(activeMsgClient, 'buildFirePack').mockImplementation(async (...args) => ({ ...await realBuild(...args), noticeIds: ['notice-1'] }));
  const mark = vi.spyOn(ActiveMsgStore, 'markExpiredNoticesNotified').mockResolvedValue(undefined);
  await generate();
  expect(mark).toHaveBeenCalledWith(char.id, ['notice-1']);
});

it('一段都没落库时不销回执', async () => {
  const realBuild = activeMsgClient.buildFirePack;
  vi.spyOn(activeMsgClient, 'buildFirePack').mockImplementation(async (...args) => ({ ...await realBuild(...args), noticeIds: ['notice-1'] }));
  const mark = vi.spyOn(ActiveMsgStore, 'markExpiredNoticesNotified').mockResolvedValue(undefined);
  vi.mocked(applyAssistantPostProcessing).mockResolvedValue(undefined as any);
  await generate();
  expect(mark).not.toHaveBeenCalled();
});
