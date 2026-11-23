// utils/awayMessage.parity.test.ts
//
// 回归守卫（离开后消息、见面离开提醒的本地版与云端模板一致）：
// 同一个角色、同一份 fire_pack，本地版 runLocalProactiveTurn 发出去的提示词，
// 和 worker onBeforeFire 到点拼出来的那一份逐字相同。
// 这里的 worker 不给排程能力（ctx 没有 scheduleTask）、不连 MCP：本地走的这条路上
// 这两样本来就没有（见 docs/away-message.md「本地」），worker 带上它们时多出的是
// 末尾追加的排程 / MCP 说明块，属于已登记的「排程能力说明」差异。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { globalConfig } = vi.hoisted(() => ({ globalConfig: { value: {} as Record<string, unknown> } }));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { getExpiredNotices: async () => [], getGlobalConfig: async () => globalConfig.value },
}));
const { contextMessages } = vi.hoisted(() => ({ contextMessages: { value: [] as any[] } }));
vi.mock('./chatContextRange', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chatContextRange')>()),
  loadCharacterContextMessages: async () => contextMessages.value,
  loadCharacterContextRange: async () => ({ messages: contextMessages.value }),
}));
vi.mock('./applyAssistantPostProcessing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./applyAssistantPostProcessing')>()),
  applyAssistantPostProcessing: vi.fn(),
}));
vi.mock('./safeApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./safeApi')>()),
  safeFetchJson: vi.fn(),
}));

import * as activeMsgClient from './activeMsgClient';
import { runLocalAwayMessages, runLocalProactiveTurn } from './awayMessage';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';
import { safeFetchJson } from './safeApi';
import { buildAwayTaskInstruction, buildDateLeaveInstruction } from './amsgFireSchedule';
import { AMSG_FIRE_PACK_KEY } from './amsgFirePack';
import { AMSG_TOOL_CONFIG_KEY, AMSG_TOOL_PACK_KEY } from './amsgToolPack';
import { amsgHooks } from '../worker/amsg/src/index';
import { RealtimeContextManager } from './realtimeContext';
import * as userHolidays from './userHolidays';

const MIN = 60_000;
const ANCHOR = Date.parse('2026-11-20T04:00:00Z');
const DELAY = 90;
const user = { name: '小明' } as any;
const char = { id: 'char-away-parity', name: '小满', memories: [], awayMessage: { enabled: true, delayMinutes: DELAY } } as any;
const api = { baseUrl: 'https://fixture.invalid/v1', apiKey: 'k', model: 'fixture' } as any;
const rows = [
  { id: 1, charId: char.id, role: 'assistant', type: 'text', content: '早呀', timestamp: ANCHOR - 5 * MIN },
  { id: 2, charId: char.id, role: 'user', type: 'text', content: '我去上课了', timestamp: ANCHOR },
];

beforeEach(() => {
  globalConfig.value = {};
  contextMessages.value = rows;
  vi.stubGlobal('window', new EventTarget());
  vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue(rows as any);
  vi.spyOn(DB, 'ensureHomeContextMessages').mockResolvedValue(undefined);
  vi.spyOn(DB, 'getEmojis').mockResolvedValue([]);
  vi.spyOn(DB, 'getEmojiCategories').mockResolvedValue([]);
  vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockResolvedValue('SYS\n### 互动对象 (User)\n- 名字：小明\n');
  vi.mocked(safeFetchJson).mockResolvedValue({ choices: [{ message: { content: '下课了没' } }] });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** 按 worker 到点的样子跑一次 onBeforeFire，返回它发给模型的那一条提示词。 */
const cloudPrompt = async (pack: object, nowMs: number, metadata: Record<string, unknown>, opts: {
  timeAware?: boolean; toolConfig?: Record<string, unknown>; globalRows?: Array<{ key: string; value: string }>;
} = {}) => {
  const charRows = [
    // 走云端的角色一定开着 2.0（isAwayCloudRoute），worker 也只给开着的角色到点生成。
    { key: AMSG_FIRE_PACK_KEY, value: JSON.stringify({ ...pack, selfScheduleEnabled: true }) },
    { key: AMSG_TOOL_PACK_KEY, value: JSON.stringify({ v: 1, charName: char.name, xhsEnabled: false, activeMemoryMonths: [], memories: [], timeAwarenessEnabled: opts.timeAware ?? true }) },
  ];
  const globalRows = [
    { key: AMSG_TOOL_CONFIG_KEY, value: JSON.stringify({ v: 1, proxyWorkerUrl: '', weatherEnabled: false, newsEnabled: false, notionEnabled: false, feishuEnabled: false, ...opts.toolConfig }) },
    ...(opts.globalRows ?? []),
  ];
  const out = await amsgHooks.onBeforeFire({
    task: {
      id: 1, uuid: 'task-uuid', contactName: char.name, recurrenceType: 'none', nextSendAt: new Date(nowMs).toISOString(),
      metadata: { charId: char.id, amsgClientTaskId: 'client-1', amsgExpirePolicy: 'force', ...metadata },
    },
    userId: 'u1',
    readState: vi.fn(async (ns: string) => (ns.startsWith('amsg:char:') ? charRows : globalRows)),
    writeState: vi.fn(async () => ({ upserted: 1, skipped: 0, deleted: 0 })),
    now: new Date(nowMs),
    scratch: {},
  } as any) as any;
  expect(out?.messages, JSON.stringify(out)).toHaveLength(1);
  return out.messages[0].content as string;
};

const localRequest = () => JSON.parse(String(vi.mocked(safeFetchJson).mock.calls[0][1]?.body));

describe('本地版与云端模板逐字一致', () => {
  it('离开后消息（只补一次时）', async () => {
    const now = ANCHOR + DELAY * MIN + 10 * MIN;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const packSpy = vi.spyOn(activeMsgClient, 'buildFirePack');
    await runLocalAwayMessages({
      getCharacters: () => [char], getApiConfig: () => api, getUserProfile: () => user,
      getGroups: () => [], getRealtimeConfig: () => ({} as any), isBusyWith: () => false,
    });
    const body = localRequest();
    expect(body.messages).toHaveLength(1);
    expect(body.tools).toBeUndefined();
    const pack = await packSpy.mock.results[0].value;
    const cloud = await cloudPrompt(pack, ANCHOR + DELAY * MIN, { amsgAwayMessage: true, amsgAwayDelayMinutes: DELAY, amsgTaskInstruction: buildAwayTaskInstruction(DELAY) });
    expect(cloud).toContain('我去上课了');
    expect(cloud).toContain('小明最后一次在线上给你发消息是在');
    expect(body.messages[0].content).toBe(cloud);
  });

  it('见面离开提醒', async () => {
    const now = ANCHOR + 10 * MIN;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const packSpy = vi.spyOn(activeMsgClient, 'buildFirePack');
    await runLocalProactiveTurn(char, {
      apiConfig: api, userProfile: user, groups: [], realtimeConfig: {} as any,
      hint: buildDateLeaveInstruction(),
      purpose: '见面离开提醒', meta: { dateLeaveReminder: true },
      place: text => [{ text, at: now }], stillWanted: async () => true,
    });
    const pack = await packSpy.mock.results[0].value;
    const cloud = await cloudPrompt(pack, now, { amsgDateLeave: true, amsgDateLeaveDelayMinutes: 5, amsgTaskInstruction: buildDateLeaveInstruction() });
    expect(cloud).toContain(`【本次任务】\n${buildDateLeaveInstruction()}`);
    expect(localRequest().messages[0].content).toBe(cloud);
  });

  it('离开后消息：关掉时间感知、开着天气', async () => {
    const now = ANCHOR + DELAY * MIN + 10 * MIN;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const weather = { city: '上海', description: '多云', temp: 18, feelsLike: 17, humidity: 60 } as any;
    vi.spyOn(RealtimeContextManager, 'fetchWeather').mockResolvedValue(weather);
    const packSpy = vi.spyOn(activeMsgClient, 'buildFirePack');
    const noClock = { ...char, timeAwarenessEnabled: false };
    await runLocalAwayMessages({
      getCharacters: () => [noClock], getApiConfig: () => api, getUserProfile: () => user, getGroups: () => [],
      getRealtimeConfig: () => ({ weatherEnabled: true, weatherCity: '上海' } as any), isBusyWith: () => false,
    });
    const fireAt = ANCHOR + DELAY * MIN;
    // worker 只该命中快照，不许真去拉天气。
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('测试里不联网'); }));
    const pack = await packSpy.mock.results[0].value;
    const cloud = await cloudPrompt(pack, fireAt, { amsgAwayMessage: true, amsgAwayDelayMinutes: DELAY, amsgTaskInstruction: buildAwayTaskInstruction(DELAY) }, {
      timeAware: false,
      toolConfig: { weatherEnabled: true, weatherCity: '上海' },
      globalRows: [{ key: 'world_weather', value: JSON.stringify({ city: '上海', freeSource: 'wttr', data: weather, fetchedAt: fireAt }) }],
    });
    expect(cloud).toContain('【上海实时天气】');
    expect(cloud).not.toMatch(/\d{1,2}:\d{2}/);
    expect(localRequest().messages[0].content).toBe(cloud);
  });
});

describe('世界书概率条目', () => {
  const run = async (random: number) => {
    globalConfig.value = { workerBundleVersion: '2026-11-24' };
    vi.mocked(ChatPrompts.buildSystemPrompt).mockRestore();
    vi.spyOn(Math, 'random').mockReturnValue(random);
    const now = ANCHOR + 10 * MIN;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await runLocalProactiveTurn({ ...char, mountedWorldbooks: [
      { id: 'wb1', title: 'T', content: 'PROB_ENTRY_TEXT', constant: true, key: [], useProbability: true, probability: 50, position: 1 },
    ] }, {
      apiConfig: api, userProfile: user, groups: [], realtimeConfig: {} as any,
      hint: buildDateLeaveInstruction(), purpose: '见面离开提醒', meta: { dateLeaveReminder: true },
      place: text => [{ text, at: now }], stillWanted: async () => true,
    });
    return localRequest().messages[0].content as string;
  };

  it('本地当场抽签：抽中的留原文，提示词里不剩任何占位标记', async () => {
    const prompt = await run(0.1);
    expect(prompt).toContain('PROB_ENTRY_TEXT');
    expect(prompt).not.toContain('AMSG_WB');
  });

  it('没抽中的整条去掉', async () => {
    const prompt = await run(0.9);
    expect(prompt).not.toContain('PROB_ENTRY_TEXT');
    expect(prompt).not.toContain('AMSG_WB');
  });
});

it('资料里有 bio 时，用户所在地节日插在 bio 后面（与云端同一个插入点）', async () => {
  const now = ANCHOR + 10 * MIN;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockResolvedValue('SYS\n### 互动对象 (User)\n- 名字：小明\n- 设定/备注: 爱猫\n\n### 下一节\n');
  vi.spyOn(userHolidays, 'getUserHolidayReminder').mockResolvedValue('小明那边今天是元旦');
  await runLocalProactiveTurn(char, {
    apiConfig: api, userProfile: { name: '小明', bio: '爱猫' } as any, groups: [],
    realtimeConfig: { userHolidays: { enabled: true } } as any,
    hint: buildDateLeaveInstruction(), purpose: '见面离开提醒', meta: { dateLeaveReminder: true },
    place: text => [{ text, at: now }], stillWanted: async () => true,
  });
  expect(localRequest().messages[0].content).toContain('- 设定/备注: 爱猫\n\n- 小明那边今天是元旦\n\n### 下一节');
});
