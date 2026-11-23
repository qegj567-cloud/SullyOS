// 本地回连链按轮批量执行（跟云端 worker 的工具循环同一种做法）的回归守卫。
// 每一轮回复里写出的回连标签一次性取出、一起执行，结果在下一轮请求里一起交回；
// 总轮数上限、去重、最后一轮收尾都跟 worker/amsg/src/agentic.ts 同口径。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./instantTraceLog', () => ({ appendInstantTraceEntry: vi.fn() }));

import * as agenticTools from './agenticTools';
import { buildDuplicateToolMessage, buildToolResultMessage, toolCallFingerprint } from './agenticToolFeedback';
import { applyAssistantPostProcessing, type PostProcessCtx } from './applyAssistantPostProcessing';
import { DB } from './db';
import { NotionManager } from './realtimeContext';
import { XhsMcpClient } from './xhsMcpClient';
import { appendInstantTraceEntry } from './instantTraceLog';
import { TOOL_LOOP_FINAL_ROUND_PROMPT } from './toolLoopFinalRound';

const makeCtx = (extra: Partial<PostProcessCtx> = {}): PostProcessCtx => ({
  char: { id: `rounds-${Math.random()}`, name: '测试角色', xhsEnabled: true } as any,
  userProfile: { name: '小明' } as any,
  emojis: [],
  realtimeConfig: { xhsMcpConfig: { enabled: true, serverUrl: 'https://xhs-lite.test' } } as any,
  contextMsgs: [],
  fullMessages: [{ role: 'user', content: '在吗' }],
  initialData: {},
  historyMsgCount: 1,
  xhsCaches: {
    xsecTokenCache: new Map(), noteTitleCache: new Map(), commentUserIdCache: new Map(),
    commentAuthorNameCache: new Map(), commentParentIdCache: new Map(),
  },
  api: { baseUrl: 'https://llm.test/v1', headers: {}, effectiveApi: { baseUrl: 'https://llm.test/v1', apiKey: '', model: 'test' } },
  hooks: { setMessages: vi.fn(), addToast: vi.fn() },
  instantRender: true,
  ...extra,
});

/** 每次请求按顺序取一条回复；记下请求里的 messages。 */
let requests: any[][];
const replyQueue = (...contents: string[]) => vi.spyOn(globalThis, 'fetch' as any).mockImplementation((async (_url: any, init: any) => {
  requests.push(JSON.parse(String(init?.body || '{}')).messages || []);
  const content = contents.shift() ?? '';
  return {
    ok: true, status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
  };
}) as any);
const lastUserContent = (i: number): string => String(requests[i]?.at(-1)?.content ?? '');

const searchOk = (query: string) => ({ ok: true, query, resultsText: `1. ${query}的结果`, rawResultCount: 1 } as const);

let saved: string[];
beforeEach(() => {
  vi.clearAllMocks();
  saved = [];
  requests = [];
  vi.spyOn(DB, 'saveMessage').mockImplementation(async (m: any) => { saved.push(String(m.content)); return 1 as any; });
  vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([]);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('同一轮多个回连标签', () => {
  it('同一轮写了 RECALL 和 SEARCH：两种都执行，结果在同一个请求里一起交回', async () => {
    const recall = vi.spyOn(agenticTools, 'runRecall').mockResolvedValue({
      ok: true, alreadyActive: false, yearMonth: '2026-05', logsText: '[2026-05-01] 去海边',
    });
    const search = vi.spyOn(agenticTools, 'runSearch').mockResolvedValue(searchOk('海边天气'));
    const fetchSpy = replyQueue('想起来了，那天晴天');

    await applyAssistantPostProcessing('我想想\n[[RECALL: 2026-05]]\n[[SEARCH: 海边天气]]', makeCtx());

    expect(recall).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(lastUserContent(0)).toContain('去海边');
    expect(lastUserContent(0)).toContain('海边天气的结果');
    expect(saved).toEqual(['我想想', '想起来了，那天晴天']);
  });

  it('同一轮不同渠道的回连并行执行', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = <T,>(value: T) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 30));
      inFlight--;
      return value;
    };
    vi.spyOn(agenticTools, 'runSearch').mockImplementation(slow(searchOk('猫')) as any);
    vi.spyOn(agenticTools, 'runReadNote').mockImplementation(slow({ ok: true, keyword: '旅行', noteText: '去大理', entryCount: 1 }) as any);
    replyQueue('好');

    await applyAssistantPostProcessing('[[SEARCH: 猫]]\n[[READ_NOTE: 旅行]]', makeCtx());

    expect(maxInFlight).toBe(2);
  });

  it('交回模型的结果文本跟云端用同一份格式化', async () => {
    const result = searchOk('猫');
    vi.spyOn(agenticTools, 'runSearch').mockResolvedValue(result);
    replyQueue('好');

    await applyAssistantPostProcessing('[[SEARCH: 猫]]', makeCtx());

    expect(lastUserContent(0)).toBe(buildToolResultMessage({
      name: 'web_search',
      result,
      history: [{ name: 'web_search', fingerprint: toolCallFingerprint('web_search', { query: '猫' }), ran: true }],
    }));
  });
});

describe('多轮', () => {
  it('后续轮写出的回连标签继续执行，直到不再写标签', async () => {
    vi.spyOn(agenticTools, 'runXhsDetail').mockResolvedValue({ ok: true, noteId: 'n1', detailText: '标题：猫', commentsUnavailable: false } as any);
    const search = vi.spyOn(agenticTools, 'runSearch').mockResolvedValue(searchOk('猫咪品种'));
    const fetchSpy = replyQueue('看完啦\n[[SEARCH: 猫咪品种]]', '查到了');

    await applyAssistantPostProcessing('[[XHS_DETAIL: n1]]', makeCtx());

    expect(search).toHaveBeenCalledWith({ query: '猫咪品种' }, expect.anything());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(saved).toEqual(['看完啦', '查到了']);
    expect(appendInstantTraceEntry).not.toHaveBeenCalled();
  });

  it('每一轮正文都在本轮工具执行前落库，中间轮不丢', async () => {
    const seenAt: Record<string, string[]> = {};
    vi.spyOn(agenticTools, 'runSearch').mockImplementation((async () => { seenAt.search = [...saved]; return searchOk('x'); }) as any);
    vi.spyOn(agenticTools, 'runReadNote').mockImplementation((async () => {
      seenAt.note = [...saved];
      return { ok: true, keyword: 'y', noteText: '笔记', entryCount: 1 };
    }) as any);
    replyQueue('B后说\n[[READ_NOTE: y]]', 'C收尾');

    await applyAssistantPostProcessing('A先说\n[[SEARCH: x]]', makeCtx());

    expect(seenAt.search).toEqual(['A先说']);
    expect(seenAt.note).toEqual(['A先说', 'B后说']);
    expect(saved).toEqual(['A先说', 'B后说', 'C收尾']);
  });

  it('总轮数上限 5：倒数第二轮的结果挂收尾提示，最后一轮写出的标签不执行、剥掉并记 trace', async () => {
    const search = vi.spyOn(agenticTools, 'runSearch').mockImplementation((async (args: any) => searchOk(args.query)) as any);
    const fetchSpy = replyQueue(
      '第1轮\n[[SEARCH: q1]]', '第2轮\n[[SEARCH: q2]]', '第3轮\n[[SEARCH: q3]]', '第4轮\n[[SEARCH: q4]]',
    );

    await applyAssistantPostProcessing('第0轮\n[[SEARCH: q0]]', makeCtx());

    // 调用方那一次 + 这里 4 次 = 5 轮 LLM
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(search).toHaveBeenCalledTimes(4);
    expect(search).not.toHaveBeenCalledWith({ query: 'q4' }, expect.anything());
    for (const i of [0, 1, 2]) expect(lastUserContent(i)).not.toContain(TOOL_LOOP_FINAL_ROUND_PROMPT);
    expect(lastUserContent(3).endsWith(TOOL_LOOP_FINAL_ROUND_PROMPT)).toBe(true);
    // 最后一轮的结果消息里不教任何回连标签
    expect(lastUserContent(3)).not.toMatch(/\[\[/);
    expect(saved).toEqual(['第0轮', '第1轮', '第2轮', '第3轮', '第4轮']);
    expect(appendInstantTraceEntry).toHaveBeenCalledOnce();
    expect(vi.mocked(appendInstantTraceEntry).mock.calls[0][0]).toMatchObject({
      event: 'second-pass-tag-unexecuted', tags: { SEARCH: 1 }, count: 1,
    });
  });
});

describe('收尾与空回复', () => {
  it('最后一轮什么都没补时，前几轮的正文就是输出，不补「嗯...」', async () => {
    vi.spyOn(agenticTools, 'runSearch').mockImplementation((async (args: any) => searchOk(args.query)) as any);
    replyQueue('第1轮\n[[SEARCH: q1]]', '第2轮\n[[SEARCH: q2]]', '第3轮\n[[SEARCH: q3]]', '');

    await applyAssistantPostProcessing('第0轮\n[[SEARCH: q0]]', makeCtx());

    expect(saved).toEqual(['第0轮', '第1轮', '第2轮', '第3轮']);
  });

  it('（钉住现有行为）一轮正文已展示、二轮回空时不补「嗯...」', async () => {
    vi.spyOn(agenticTools, 'runSearch').mockResolvedValue(searchOk('x'));
    replyQueue('');

    await applyAssistantPostProcessing('我搜一下\n[[SEARCH: x]]', makeCtx());

    expect(saved).toEqual(['我搜一下']);
  });

  it('整个循环一句正文都没有时才补「嗯...」', async () => {
    vi.spyOn(agenticTools, 'runSearch').mockResolvedValue(searchOk('x'));
    replyQueue('');

    await applyAssistantPostProcessing('[[SEARCH: x]]', makeCtx());

    expect(saved).toEqual(['嗯...']);
  });
});

describe('去重（跟云端同口径）', () => {
  it('同名同参连着再调：不再执行，回喂云端同一句打回', async () => {
    const search = vi.spyOn(agenticTools, 'runSearch').mockResolvedValue(searchOk('猫'));
    const fetchSpy = replyQueue('[[SEARCH: 猫]]', '好');

    await applyAssistantPostProcessing('[[SEARCH: 猫]]', makeCtx());

    expect(search).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(lastUserContent(1)).toBe(buildDuplicateToolMessage('web_search'));
  });

  it('连着打回两次重复调用就收尾，那一轮的半句不发', async () => {
    const search = vi.spyOn(agenticTools, 'runSearch').mockResolvedValue(searchOk('猫'));
    const fetchSpy = replyQueue('r1\n[[SEARCH: 猫]]', 'r2\n[[SEARCH: 猫]]', 'r3半句\n[[SEARCH: 猫]]');

    await applyAssistantPostProcessing('r0\n[[SEARCH: 猫]]', makeCtx());

    expect(search).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(saved).toEqual(['r0', 'r1', 'r2']);
  });
});

describe('去重不受并行影响', () => {
  it('同一轮里中间的调用抛错时，下一次算不算重复跟云端串行的结论一致', async () => {
    // worker 串行：猫 执行 → 狗 抛错（不进历史）→ 猫 跟上一次成功的那个同名同参，打回。
    const search = vi.spyOn(agenticTools, 'runSearch').mockImplementation((async (args: any) => {
      if (args.query === '狗') throw new Error('炸了');
      return searchOk(args.query);
    }) as any);
    replyQueue('好');

    await applyAssistantPostProcessing('[[SEARCH: 猫]]\n[[SEARCH: 狗]]\n[[SEARCH: 猫]]', makeCtx());

    expect(search.mock.calls.filter(([args]: any) => args.query === '猫')).toHaveLength(1);
    expect(lastUserContent(0)).toContain('"reason":"tool_error"');
    expect(lastUserContent(0).endsWith(buildDuplicateToolMessage('web_search'))).toBe(true);
  });
});

describe('长日记跨轮', () => {
  it('DIARY_START / DIARY_END 被回连标签劈到两轮时，按整篇写一次，日记正文不进气泡', async () => {
    vi.spyOn(agenticTools, 'runRecall').mockResolvedValue({
      ok: true, alreadyActive: false, yearMonth: '2026-05', logsText: '[2026-05-01] 看烟花',
    });
    const write = vi.spyOn(NotionManager, 'createDiaryPage').mockResolvedValue({ success: true, url: 'u' } as any);
    const recall = vi.spyOn(agenticTools, 'runRecall');
    replyQueue('还想起了那年的烟花\n[[DIARY_END]]\n写好啦');

    await applyAssistantPostProcessing(
      '我写篇日记\n[[DIARY_START: 海边|开心]]\n今天去了海边\n[[RECALL: 2026-05]]',
      makeCtx({ realtimeConfig: { notionEnabled: true, notionApiKey: 'k', notionDatabaseId: 'db' } as any }),
    );

    expect(recall).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    const [, , entry] = write.mock.calls[0] as any;
    expect(entry.title).toBe('海边');
    expect(entry.content).toContain('今天去了海边');
    expect(entry.content).toContain('还想起了那年的烟花');
    expect(saved.filter(m => !m.startsWith('📔'))).toEqual(['我写篇日记', '写好啦']);
  });
});

describe('副作用跨轮不重复执行（口径同 worker classifier 2.5 节）', () => {
  it('两轮里复述同一笔转账和同一条小红书评论：各只执行一次，金额不同的照常执行', async () => {
    const types: string[] = [];
    vi.mocked(DB.saveMessage).mockImplementation(async (m: any) => { types.push(String(m.type)); saved.push(String(m.content)); return 1 as any; });
    vi.spyOn(agenticTools, 'runSearch').mockResolvedValue(searchOk('x'));
    const comment = vi.spyOn(XhsMcpClient, 'comment').mockResolvedValue({ success: true } as any);
    replyQueue('给你转啦[[ACTION:TRANSFER:520]]\n[[XHS_COMMENT: n1 | 好可爱]]\n再补一点[[ACTION:TRANSFER:100]]');

    await applyAssistantPostProcessing('好呀[[ACTION:TRANSFER:520]]\n[[XHS_COMMENT: n1 | 好可爱]]\n[[SEARCH: x]]', makeCtx());

    expect(types.filter(t => t === 'transfer')).toHaveLength(2);
    expect(comment).toHaveBeenCalledOnce();
    expect(saved.some(m => m.includes('给你转啦'))).toBe(true);
    expect(saved.join('\n')).not.toMatch(/\[\[/);
  });
});

describe('副作用：同一轮写几次执行几次', () => {
  const transferCount = (types: string[]) => types.filter(t => t === 'transfer').length;
  const captureTypes = () => {
    const types: string[] = [];
    vi.mocked(DB.saveMessage).mockImplementation(async (m: any) => { types.push(String(m.type)); saved.push(String(m.content)); return 1 as any; });
    return types;
  };

  it('（钉住现有行为）单轮回复里两笔一模一样的转账 → 两张卡', async () => {
    const types = captureTypes();
    await applyAssistantPostProcessing('一分[[ACTION:TRANSFER:0.01]]\n再一分[[ACTION:TRANSFER:0.01]]', makeCtx());
    expect(transferCount(types)).toBe(2);
  });

  it('后面一轮同时有跨轮复述和同轮连写：复述的去掉，同轮新写的几笔都执行', async () => {
    const types = captureTypes();
    vi.spyOn(agenticTools, 'runSearch').mockResolvedValue(searchOk('x'));
    const comment = vi.spyOn(XhsMcpClient, 'comment').mockResolvedValue({ success: true } as any);
    replyQueue('[[XHS_COMMENT: n1 | 好可爱]]\n一分[[ACTION:TRANSFER:0.01]]\n再一分[[ACTION:TRANSFER:0.01]]');

    await applyAssistantPostProcessing('[[XHS_COMMENT: n1 | 好可爱]]\n[[SEARCH: x]]', makeCtx());

    expect(comment).toHaveBeenCalledOnce();
    expect(transferCount(types)).toBe(2);
  });
});

describe('跨轮长日记收尾时不悄悄丢', () => {
  const notionCtx = () => makeCtx({ realtimeConfig: { notionEnabled: true, notionApiKey: 'k', notionDatabaseId: 'db' } as any });
  const diaryDrops = () => vi.mocked(appendInstantTraceEntry).mock.calls.map(c => c[0]).filter(e => e.event === 'diary-carry-dropped');

  it('重复调用到阈值、整轮丢掉时，已经写完整的日记照常落库', async () => {
    vi.spyOn(agenticTools, 'runSearch').mockResolvedValue(searchOk('猫'));
    const write = vi.spyOn(NotionManager, 'createDiaryPage').mockResolvedValue({ success: true, url: 'u' } as any);
    replyQueue('还在写\n[[SEARCH: 猫]]', '[[SEARCH: 猫]]', '写完了\n[[DIARY_END]]\n[[SEARCH: 猫]]');

    await applyAssistantPostProcessing('r0\n[[DIARY_START: 海边|开心]]\n今天\n[[SEARCH: 猫]]', notionCtx());

    expect(write).toHaveBeenCalledOnce();
    const [, , entry] = write.mock.calls[0] as any;
    expect(entry.content).toContain('今天');
    expect(entry.content).toContain('写完了');
    expect(diaryDrops()).toHaveLength(0);
  });

  it('重复调用到阈值时日记还没写完：不落库，留 trace', async () => {
    vi.spyOn(agenticTools, 'runSearch').mockResolvedValue(searchOk('猫'));
    const write = vi.spyOn(NotionManager, 'createDiaryPage').mockResolvedValue({ success: true, url: 'u' } as any);
    replyQueue('还在写\n[[SEARCH: 猫]]', '[[SEARCH: 猫]]', '[[SEARCH: 猫]]');

    await applyAssistantPostProcessing('r0\n[[DIARY_START: 海边|开心]]\n今天\n[[SEARCH: 猫]]', notionCtx());

    expect(write).not.toHaveBeenCalled();
    expect(diaryDrops()).toEqual([expect.objectContaining({ reason: 'duplicate-limit' })]);
  });

  it('回连请求失败时带着半篇日记：留 trace', async () => {
    vi.spyOn(agenticTools, 'runSearch').mockResolvedValue(searchOk('x'));
    vi.spyOn(globalThis, 'fetch' as any).mockRejectedValue(new Error('断网'));

    await applyAssistantPostProcessing('r0\n[[DIARY_START: 海边|开心]]\n今天\n[[SEARCH: x]]', notionCtx());

    expect(saved).toEqual(['r0']);
    expect(diaryDrops()).toEqual([expect.objectContaining({ reason: 'request-failed' })]);
  });
});

describe('原有行为保留', () => {
  it('中间轮里的副作用照常执行（戳一戳不丢）', async () => {
    vi.spyOn(agenticTools, 'runSearch').mockResolvedValue(searchOk('x'));
    replyQueue('查到了');

    await applyAssistantPostProcessing('[[ACTION:POKE]]等我查查\n[[SEARCH: x]]', makeCtx());

    expect(saved).toContain('[戳一戳]');
    expect(saved).toContain('等我查查');
    expect(saved).toContain('查到了');
  });

  it('（钉住现有行为）RECALL 召回后不丢本轮回复：本轮正文作为 assistant 上文交回', async () => {
    vi.spyOn(agenticTools, 'runRecall').mockResolvedValue({
      ok: true, alreadyActive: false, yearMonth: '2026-05', logsText: '[2026-05-01] 去海边',
    });
    replyQueue('对，那天去了海边');

    await applyAssistantPostProcessing('那次旅行我记得\n[[RECALL: 2026-05]]', makeCtx());

    expect(requests[0]).toContainEqual({ role: 'assistant', content: '那次旅行我记得' });
    expect(saved).toEqual(['那次旅行我记得', '对，那天去了海边']);
  });

  it('（钉住现有行为）关闭自主月度查阅时，后续轮写出的 RECALL 也不执行', async () => {
    vi.spyOn(agenticTools, 'runSearch').mockResolvedValue(searchOk('x'));
    const recall = vi.spyOn(agenticTools, 'runRecall');
    const fetchSpy = replyQueue('B\n[[RECALL: 2026-05]]');
    const ctx = makeCtx();
    ctx.char.monthlyRecallEnabled = false;

    await applyAssistantPostProcessing('[[SEARCH: x]]', ctx);

    expect(recall).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(saved).toEqual(['B']);
  });

  it('（钉住现有行为）云端回放：只有 RECALL 标签时不回连，补一句「嗯...」', async () => {
    const fetchSpy = replyQueue('不应请求');

    await applyAssistantPostProcessing('[[RECALL: 2026-05]]', makeCtx({ skipSecondPassLLM: true }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(saved).toEqual(['嗯...']);
  });

  it('（钉住现有行为）云端回放：数据标签不执行、照常剥掉，也不记 trace', async () => {
    const fetchSpy = replyQueue('不应请求');
    const search = vi.spyOn(agenticTools, 'runSearch');

    await applyAssistantPostProcessing('你好\n[[SEARCH: x]]\n[[XHS_DETAIL: n1]]', makeCtx({ skipSecondPassLLM: true }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(saved).toEqual(['你好']);
    expect(appendInstantTraceEntry).not.toHaveBeenCalled();
  });
});
