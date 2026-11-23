// utils/activeMsgClient.parity.test.ts
//
// 回归守卫（云端 fire_pack 模板与本地私聊的上下文一致）：
//   T4 历史里的双语译文和 <翻译> 标签跟本地一样剥掉；
//   T5 角色开了表情识图时带识图描述（不带原图）；
//   T6 世界书关键词扫的是排好版的历史（与本地同一份），不是数据库原文；
//   T9 「上次排的那条没发出去」的回执随模板带上；
//   图片没有识图描述时明说别猜；
//   查得到的月份清单跟随「隐藏调取记忆提示」开关；
//   情绪评估模板随包带上（T7）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { notices, globalConfig } = vi.hoisted(() => ({ notices: { value: [] as any[] }, globalConfig: { value: {} as Record<string, unknown> } }));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    getExpiredNotices: async () => notices.value,
    getGlobalConfig: async () => globalConfig.value,
  },
}));
const { contextMessages } = vi.hoisted(() => ({ contextMessages: { value: [] as any[] } }));
vi.mock('./chatContextRange', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./chatContextRange')>()),
  loadCharacterContextMessages: async () => contextMessages.value,
}));

import { buildEmotionEvalPrompt, buildFirePack } from './activeMsgClient';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const user = { name: '小明' } as any;
const baseChar = (over: Record<string, unknown> = {}) => ({ id: 'char-p', name: '小满', memories: [], ...over }) as any;
const msg = (id: number, role: string, content: string, over: Record<string, unknown> = {}) => ({
  id, charId: 'char-p', role, type: 'text', content, timestamp: NOW - (100 - id) * 60_000, ...over,
});

let systemPromptSpy: { mock: { calls: unknown[][] } };
beforeEach(() => {
  notices.value = [];
  globalConfig.value = {};
  contextMessages.value = [];
  vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
  vi.spyOn(DB, 'ensureHomeContextMessages').mockResolvedValue(undefined);
  systemPromptSpy = vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockResolvedValue('SYS');
  vi.spyOn(ChatPrompts, 'filterVisibleEmojis').mockReturnValue({ emojis: [], categories: [] } as any);
});
afterEach(() => { vi.restoreAllMocks(); });

const pack = (char: any) => buildFirePack(char, user, [], undefined, { all: [], categories: [] });

describe('fire_pack 模板的近史转写', () => {
  it('T4 剥掉 %%BILINGUAL%% 译文和 <翻译> 标签，只留原文', async () => {
    contextMessages.value = [
      msg(1, 'assistant', '今天好冷%%BILINGUAL%%It is cold today'),
      msg(2, 'assistant', '<翻译><原文>早点睡</原文><译文>Sleep early</译文></翻译>'),
    ];
    const { template } = await pack(baseChar());
    expect(template).toContain('今天好冷');
    expect(template).not.toContain('It is cold today');
    expect(template).not.toContain('BILINGUAL');
    expect(template).toContain('早点睡');
    expect(template).not.toContain('Sleep early');
    expect(template).not.toContain('<翻译>');
  });

  it('T5 开了表情识图的角色带上识图描述', async () => {
    contextMessages.value = [msg(1, 'user', 'https://img.example/cat.png', {
      type: 'emoji', metadata: { stickerName: '猫猫', visionDescription: '一只捂脸的橘猫' },
    })];
    expect((await pack(baseChar({ stickerVision: true }))).template).toContain('一只捂脸的橘猫');
    expect((await pack(baseChar())).template).not.toContain('一只捂脸的橘猫');
  });

  it('图片没有识图描述时明说别猜', async () => {
    contextMessages.value = [msg(1, 'user', 'https://img.example/a.png', { type: 'image' })];
    const { template } = await pack(baseChar());
    expect(template).toContain('[图片]（配图描述暂不可用，请不要猜测。）');
  });

  it('T6 世界书扫描用排好版、清洗过的历史', async () => {
    contextMessages.value = [
      msg(1, 'user', 'https://img.example/cat.png', { type: 'emoji', metadata: { stickerName: '猫猫' } }),
      msg(2, 'assistant', '好%%BILINGUAL%%ok'),
    ];
    await pack(baseChar());
    const scanned = (systemPromptSpy.mock.calls[0][5] as any[]).map(m => m.content);
    expect(scanned.join('\n')).toContain('发送了表情包: 猫猫');
    expect(scanned.join('\n')).not.toContain('BILINGUAL');
  });
});

describe('T9 到点没发出去的回执', () => {
  const notice = {
    id: 'task-1@1', charId: 'char-p', occurrenceMs: NOW - 3600_000, mode: 'auto',
    recurrenceType: 'none', reason: 'min-gap', createdAt: NOW,
  };

  it('角色开着 2.0 时带上还没告知的回执', async () => {
    notices.value = [notice];
    const out = await pack(baseChar({ activeMsg2Config: { enabled: true, tasks: [] } }));
    expect(out.template).toContain('到点没发出去：');
    // 带进模板的是哪几条，随包记下来，到点发出后客户端按它销账。
    expect(out.noticeIds).toEqual(['task-1@1']);
  });

  it('已告知的、或角色关着 2.0 时不带', async () => {
    notices.value = [{ ...notice, notifiedAt: NOW }];
    expect((await pack(baseChar({ activeMsg2Config: { enabled: true, tasks: [] } }))).template).not.toContain('到点没发出去');
    notices.value = [notice];
    expect((await pack(baseChar())).template).not.toContain('到点没发出去');
  });
});

describe('查得到的月份清单跟随「隐藏调取记忆提示」开关', () => {
  const memories = [{ id: 'm1', date: '2026-06-12', mood: 'happy', summary: '六月一起看过日落' }];
  it('只有显式关掉隐藏（false）才列月份', async () => {
    expect((await pack(baseChar({ memories, hideMonthlyRecallPrompt: false }))).template).toContain('2026-06');
    expect((await pack(baseChar({ memories }))).template).not.toContain('存着这些月份的经历');
    expect((await pack(baseChar({ memories, hideMonthlyRecallPrompt: true }))).template).not.toContain('存着这些月份的经历');
  });

  it('【重要规则】里的「查记忆」跟同一个开关', async () => {
    expect((await pack(baseChar({ memories, hideMonthlyRecallPrompt: false }))).template).toContain('描述的查记忆、读日记');
    expect((await pack(baseChar({ memories }))).template).toContain('描述的读日记');
    expect((await pack(baseChar({ memories, hideMonthlyRecallPrompt: true }))).template).not.toContain('查记忆、');
  });
});

describe('T7 情绪评估模板随包带上', () => {
  it('开了情绪评估（且日程功能开着）才带，模板留两段占位', async () => {
    globalConfig.value = { llmCredentialsSupported: true };
    const on = await pack(baseChar({ scheduleFeatureEnabled: true, emotionConfig: { enabled: true } }));
    expect(on.emotionEval?.prompt).toContain('__EMOTION_EVAL_SYSTEM_PROMPT__');
    expect(on.emotionEval?.prompt).toContain('__EMOTION_EVAL_HISTORY__');
    expect((await pack(baseChar({ scheduleFeatureEnabled: true }))).emotionEval).toBeUndefined();
    expect((await pack(baseChar({ emotionConfig: { enabled: true } }))).emotionEval).toBeUndefined();
  });
});

// T6 后半：概率条目打包时不抽签，随包带上概率，worker 到点重抽。
describe('世界书概率条目随包带上、到点重抽', () => {
  const rainChar = () => baseChar({ mountedWorldbooks: [
    { id: 'wb-rain', title: '雨天', content: '下雨天会犯困', constant: true, key: [], useProbability: true, probability: 35, position: 1 },
  ] });
  beforeEach(() => {
    systemPromptSpy = vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockImplementation(async (c: any) => {
      const { formatWorldbookSection, resolveWorldbookEntries } = await import('./worldbook');
      return formatWorldbookSection(resolveWorldbookEntries(c.mountedWorldbooks, []), '扩展设定集 (Worldbooks)');
    });
  });

  const NEW_WORKER = { workerUrl: 'https://w.example', workerBundleVersion: '2026-11-23', anthropicMessagesWorkerUrl: 'https://w.example' };
  const cloudPack = (c: any) => buildFirePack(c, user, [], undefined, { all: [], categories: [] }, { forCloud: true } as any);

  it('Worker 版本够新：打包不抽签，条目带标记进模板，概率进 worldbookRolls', async () => {
    globalConfig.value = NEW_WORKER;
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const out = await cloudPack(rainChar());
    expect(out.template).toContain('下雨天会犯困');
    expect(out.template).toContain('AMSG_WB_IF');
    expect(out.worldbookRolls).toEqual([{ id: 'wb-rain', probability: 35 }]);
  });

  it('旧版本或没探过的 Worker：退回打包时抽签，模板里没有标记', async () => {
    for (const version of ['2026-11-19', undefined]) {
      globalConfig.value = { ...NEW_WORKER, workerBundleVersion: version };
      vi.spyOn(Math, 'random').mockReturnValue(0.99);
      const out = await cloudPack(rainChar());
      expect(out.template).not.toContain('AMSG_WB_IF');
      expect(out.template).not.toContain('下雨天会犯困');
      expect(out).not.toHaveProperty('worldbookRolls');
    }
  });
});

describe('I5 随包带上 bio 长度', () => {
  it('按「互动对象」段实际写的 bio 算（没填按「无」）', async () => {
    expect((await buildFirePack(baseChar(), { name: '小明', bio: '喜欢猫。\n\n学吉他' } as any, [], undefined, { all: [], categories: [] })).userBioLength).toBe(9);
    expect((await pack(baseChar())).userBioLength).toBe(1);
  });
});

// 审查补丁：标记只给云端；换过 Worker 地址时旧的体检版本不算数；情绪评估只在能评估时带；
// 回执块带上编号标记，worker 记住发过的那几条、下次不再提。
describe('审查补丁', () => {
  const NEW_WORKER = { workerUrl: 'https://w.example', workerBundleVersion: '2026-11-23', anthropicMessagesWorkerUrl: 'https://w.example' };
  const rain = () => baseChar({ mountedWorldbooks: [
    { id: 'wb-rain', title: '雨天', content: '下雨天会犯困', constant: true, key: [], useProbability: true, probability: 35, position: 1 },
  ] });
  const build = (c: any, opts?: any) => buildFirePack(c, user, [], undefined, { all: [], categories: [] }, opts);
  beforeEach(() => {
    systemPromptSpy = vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockImplementation(async (c: any) => {
      const { formatWorldbookSection, resolveWorldbookEntries } = await import('./worldbook');
      return formatWorldbookSection(resolveWorldbookEntries(c.mountedWorldbooks, []), '扩展设定集 (Worldbooks)');
    });
  });

  it('#1 不是上云用的打包（本地版）不出标记', async () => {
    globalConfig.value = NEW_WORKER;
    const out = await build(rain());
    expect(out.template).not.toContain('AMSG_WB_IF');
    expect(out).not.toHaveProperty('worldbookRolls');
  });

  it('#8 体检版本记的是别的 Worker 地址时按不支持处理', async () => {
    globalConfig.value = { ...NEW_WORKER, anthropicMessagesWorkerUrl: 'https://old.example' };
    expect((await build(rain(), { forCloud: true })).template).not.toContain('AMSG_WB_IF');
  });

  it('#4 Worker 不支持凭据存表时不带情绪评估模板', async () => {
    globalConfig.value = { ...NEW_WORKER, llmCredentialsSupported: false };
    expect((await build(baseChar({ scheduleFeatureEnabled: true, emotionConfig: { enabled: true } }), { forCloud: true })).emotionEval).toBeUndefined();
    globalConfig.value = { ...NEW_WORKER, llmCredentialsSupported: true };
    expect((await build(baseChar({ scheduleFeatureEnabled: true, emotionConfig: { enabled: true } }), { forCloud: true })).emotionEval).toBeTruthy();
  });

  it('#5 Worker 够新时回执块带编号标记，旧 Worker 不带', async () => {
    notices.value = [{ id: 'task-1@1', charId: 'char-p', occurrenceMs: NOW - 3600_000, mode: 'auto', recurrenceType: 'none', reason: 'min-gap', createdAt: NOW }];
    const c = baseChar({ activeMsg2Config: { enabled: true, tasks: [] } });
    globalConfig.value = NEW_WORKER;
    expect((await build(c, { forCloud: true })).template).toContain('{{AMSG_NOTICES:task-1%401}}');
    globalConfig.value = { ...NEW_WORKER, workerBundleVersion: '2026-11-19' };
    const old = await build(c, { forCloud: true });
    expect(old.template).toContain('到点没发出去');
    expect(old.template).not.toContain('AMSG_NOTICES');
  });
});
