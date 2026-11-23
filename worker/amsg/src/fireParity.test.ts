// worker/amsg/src/fireParity.test.ts
//
// 回归守卫（云端 fire 与本地生成的提示词一致）：
//   A1/A2 离开后消息到点按起点类型现算说法，关了时间感知不报钟、不报等了多少分钟；
//   D1    见面离开提醒去掉「突然想起对方」口吻的通用提示；
//   #13   见面离开提醒这一轮也给排程工具，排出来的子任务不带豁免、照常被上限拦；
//   T7    定时类到点并行跑情绪评估，结果随最后一条推送回去；
//   #14   MCP 说明块带用户名、即时对话抬头不提主动消息、末尾提醒只在 native 模式加。
import { afterEach, describe, expect, it, vi } from 'vitest';

const { holiday } = vi.hoisted(() => ({ holiday: { value: '' } }));
// 小红书搜索要连外部服务，这里只换掉内置工具的执行结果，回喂措辞仍走真的 buildToolResultMessage。
vi.mock('../../../utils/agenticTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/agenticTools')>();
  return {
    ...actual,
    dispatchAgenticTool: async (name: string, ...rest: unknown[]) => (name === 'xhs_search'
      ? { ok: true, notes: [{ noteId: 'n1', title: '雨天咖啡馆' }] }
      : (actual.dispatchAgenticTool as any)(name, ...rest)),
  };
});
vi.mock('./realtimeWorld', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./realtimeWorld')>()),
  buildUserHolidayBlock: async () => holiday.value,
}));
import { amsgFireSettled, amsgHooks, runFireScheduleTool } from './index';
import {
  AMSG_FIRE_PACK_KEY, AMSG_SELF_LOG_KEY, AMSG_SENT_NOTICES_KEY, AMSG_SLOT_TASK_INSTRUCTION, FIRE_PACK_VERSION,
  LEGACY_PROACTIVE_HINT_HEADING, LEGACY_PROACTIVE_TONE_RULE,
} from '../../../utils/amsgFirePack';
import { AMSG_TOOL_CONFIG_KEY, AMSG_TOOL_PACK_KEY } from '../../../utils/amsgToolPack';
import { AMSG_LIMITS_KEY } from '../../../utils/amsgLimits';
import { AMSG_DATE_LEAVE_META, AMSG_FIRE_SCHEDULE_TOOL } from '../../../utils/amsgFireSchedule';
import { MCP_TAIL_REMINDER } from '../../../utils/mcpFireCore';

const CHAR_ID = 'char-parity';
const NOW = new Date('2026-07-25T12:00:00.000Z');
const MIN = 60_000;

const pack = (extra: Record<string, unknown> = {}) => JSON.stringify({
  v: FIRE_PACK_VERSION, template: AMSG_SLOT_TASK_INSTRUCTION, lastUserMessageAt: null,
  tzId: 'Asia/Shanghai', userTzId: 'Asia/Shanghai', targetName: '小明', builtAt: NOW.getTime() - 3 * 3600_000,
  pendingTasks: [], scene: null, selfScheduleEnabled: true, ...extra,
});
const toolPack = (extra: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, charName: 'Nyah', xhsEnabled: false, activeMemoryMonths: [], memories: [], timeAwarenessEnabled: true, ...extra,
});
const toolConfig = (extra: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, proxyWorkerUrl: '', weatherEnabled: false, newsEnabled: false, notionEnabled: false, feishuEnabled: false, ...extra,
});
const mcpServers = [{
  id: 'srv', name: '记忆库', url: 'https://mcp.example.com/mcp',
  tools: [{ name: 'search_memory', description: '查记忆', inputSchema: { type: 'object', properties: {} } }],
}];

const makeCtx = (opts: {
  metadata?: Record<string, unknown>;
  pack?: Record<string, unknown>;
  toolPack?: Record<string, unknown>;
  toolConfig?: Record<string, unknown>;
  extraRows?: Array<{ key: string; value: string }>;
  credRefs?: Record<string, string>;
}) => {
  const charRows = [
    { key: AMSG_FIRE_PACK_KEY, value: pack(opts.pack) },
    { key: AMSG_TOOL_PACK_KEY, value: toolPack(opts.toolPack) },
    ...(opts.extraRows ?? []),
  ];
  const globalRows = [{ key: AMSG_TOOL_CONFIG_KEY, value: toolConfig(opts.toolConfig) }];
  const scratch: Record<string, unknown> = {};
  const writeState = vi.fn(async () => ({ upserted: 1, skipped: 0, deleted: 0 }));
  const ctx = {
    task: {
      id: 7, uuid: 'task-uuid', contactName: 'Nyah', recurrenceType: 'none',
      nextSendAt: NOW.toISOString(), credRefs: opts.credRefs,
      metadata: { charId: CHAR_ID, amsgExpirePolicy: 'expire', amsgTaskInstruction: '旧指令：对方已经超过 90 分钟没跟你说话了', amsgClientTaskId: 'client-1', ...opts.metadata },
    },
    userId: 'u1',
    readState: vi.fn(async (ns: string) => (ns.startsWith('amsg:char:') ? charRows : globalRows)),
    writeState,
    now: NOW,
    scratch,
  } as any;
  return { ctx, scratch, writeState };
};
const prompt = async (ctx: any) => {
  const out = await amsgHooks.onBeforeFire(ctx) as any;
  expect(out).toHaveProperty('messages');
  return out as { messages: Array<{ role: string; content: string }>; tools?: any[] };
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('A1/A2 离开后消息到点现算说法', () => {
  const awayMeta = { amsgAwayMessage: true, amsgAwayDelayMinutes: 90, amsgExpirePolicy: 'force' };

  it('刚见过面：按见面起点说，切到刚分开的语境，不报等了多少分钟', async () => {
    const { ctx } = makeCtx({
      metadata: awayMeta,
      pack: { lastAwayAnchorAt: NOW.getTime() - 100 * MIN, awayAnchor: { source: 'date', lastDateAt: NOW.getTime() - 100 * MIN } },
    });
    const text = (await prompt(ctx)).messages[0].content;
    expect(text).toContain('上一次在线下互动是在 7月25日 18:20');
    expect(text).toContain('刚刚在线下见过面');
    expect(text).not.toContain('超过 90 分钟');
  });

  it('关掉时间感知：不报钟也不报时长', async () => {
    const { ctx } = makeCtx({
      metadata: awayMeta, toolPack: { timeAwarenessEnabled: false },
      pack: { lastAwayAnchorAt: NOW.getTime() - 100 * MIN, awayAnchor: { source: 'call', lastDateAt: null } },
    });
    const text = (await prompt(ctx)).messages[0].content;
    expect(text).toContain('通话结束后这段时间小明没有在线上给你发消息');
    expect(text).not.toMatch(/\d{1,2}:\d{2}/);
    expect(text).not.toMatch(/\d+ 分钟/);
  });

  it('打包之后用户又在线上说过话：按线上发言说，不再算刚分开', async () => {
    const { ctx } = makeCtx({
      metadata: awayMeta,
      pack: { lastUserMessageAt: NOW.getTime() - 95 * MIN, lastAwayAnchorAt: NOW.getTime() - 150 * MIN, awayAnchor: { source: 'date', lastDateAt: NOW.getTime() - 150 * MIN } },
    });
    const text = (await prompt(ctx)).messages[0].content;
    expect(text).toContain('小明最后一次在线上给你发消息是在');
    expect(text).not.toContain('刚刚在线下见过面');
  });

  it('旧包没带起点信息：退回任务 metadata 里那份指令', async () => {
    const { ctx } = makeCtx({ metadata: awayMeta, pack: { lastAwayAnchorAt: NOW.getTime() - 100 * MIN } });
    expect((await prompt(ctx)).messages[0].content).toContain('旧指令');
  });
});

describe('见面离开提醒', () => {
  const dateLeaveMeta = { [AMSG_DATE_LEAVE_META]: true, amsgDateLeaveDelayMinutes: 5, amsgExpirePolicy: 'force' };
  const template = [
    '【重要规则】', LEGACY_PROACTIVE_TONE_RULE, '',
    LEGACY_PROACTIVE_HINT_HEADING, '这不是 小明 正在和你聊天，而是你突然想起了 小明，想主动发条消息给他/她。', '',
    '【本次任务】', AMSG_SLOT_TASK_INSTRUCTION,
  ].join('\n');

  it('D1 去掉「突然想起对方」口吻的通用提示', async () => {
    const { ctx } = makeCtx({ metadata: dateLeaveMeta, pack: { template } });
    const text = (await prompt(ctx)).messages[0].content;
    expect(text).not.toContain('突然想起');
    expect(text).toContain('【本次任务】');
  });

  it('#13 这一轮给排程工具和额度说明', async () => {
    const { ctx } = makeCtx({ metadata: dateLeaveMeta });
    ctx.scheduleTask = vi.fn();
    const out = await prompt(ctx);
    expect(out.tools?.some((t) => t.function.name === AMSG_FIRE_SCHEDULE_TOOL)).toBe(true);
  });

  it('#13 排出来的子任务不带见面豁免，到点按普通自排过连发上限', async () => {
    const { ctx, scratch } = makeCtx({ metadata: dateLeaveMeta });
    const scheduleTask = vi.fn(async () => ({ uuid: 'child-uuid', nextSendAt: new Date(NOW.getTime() + 3600_000).toISOString() }));
    ctx.scheduleTask = scheduleTask;
    await prompt(ctx);
    const res = await runFireScheduleTool(scratch.fire as any, scheduleTask as any,
      { send_at: '2026-07-25T21:30:00' }, NOW.getTime());
    expect(res.ok).toBe(true);
    const childMeta = (scheduleTask.mock.calls[0] as any)[0].metadata;
    expect(childMeta[AMSG_DATE_LEAVE_META]).toBeUndefined();
    expect(childMeta.amsgSelfScheduled).toBe(true);

    const selfLog = JSON.stringify({
      v: 4, basePackAt: NOW.getTime() - 3 * 3600_000, anchorUserMsgAt: null, entries: [], unansweredSends: 3, tasks: [],
    });
    const child = makeCtx({
      metadata: { ...childMeta, amsgTaskInstruction: '子任务' },
      extraRows: [
        { key: AMSG_LIMITS_KEY, value: JSON.stringify({ v: 1, selfScheduleEnabled: true, maxUnansweredSends: 3 }) },
        { key: AMSG_SELF_LOG_KEY, value: selfLog },
      ],
    });
    await expect(amsgHooks.onBeforeFire(child.ctx)).resolves.toEqual({ skip: true });
  });
});

describe('T7 定时类到点并行跑情绪评估', () => {
  const EVAL_PROMPT = '评估 __EMOTION_EVAL_SYSTEM_PROMPT__ | __EMOTION_EVAL_HISTORY__';

  const fire = async (packExtra: Record<string, unknown>, credRefs?: Record<string, string>) => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      seen.push(String(JSON.parse(init.body).messages[0].content));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"changed":true} EVAL-RAW' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const { ctx, scratch, writeState } = makeCtx({ pack: packExtra, credRefs });
    ctx.resolveLlmCredential = vi.fn(async () => ({ apiUrl: 'https://eval.example/v1/chat/completions', apiKey: 'sk-eval', primaryModel: 'eval-mini' }));
    await prompt(ctx);
    const decision = await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_7@1', taskId: 7, taskUuid: 'task-uuid', llmResponse: {}, llmOutputText: '想你了',
      contactName: 'Nyah', metadata: ctx.task.metadata, scratch, writeState, readState: ctx.readState,
    } as any) as any;
    return { seen, payloads: decision.pushPayloads as Array<Record<string, any>> };
  };

  it('包里带评估模板、任务带 emotion 引用 → 评估跑一次，结果挂在最后一条', async () => {
    const { seen, payloads } = await fire({ emotionEval: { prompt: EVAL_PROMPT } }, { chat: 'char:x/chat', emotion: 'char:x/emotion' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('旧指令');
    expect(seen[0]).not.toContain('__EMOTION_EVAL_');
    expect(payloads.at(-1)!.metadata.amsgEmotionUpdate).toContain('EVAL-RAW');
  });

  // 定时类没有人在等回复：评估比主生成慢也要等它跑完，结论照样带上；等满上限才不带并留日志。
  // 评估何时返回由测试手动放行，时间用假定时器按 1 秒一步推，不依赖真实耗时。
  const startOutput = async (fetchImpl: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    const { ctx, scratch, writeState } = makeCtx({ pack: { emotionEval: { prompt: EVAL_PROMPT } }, credRefs: { chat: 'c', emotion: 'e' } });
    ctx.resolveLlmCredential = vi.fn(async () => ({ apiUrl: 'https://eval.example/v1/chat/completions', apiKey: 'k', primaryModel: 'm' }));
    const before = await prompt(ctx) as any;
    let settled = false;
    const pending = (amsgHooks.onLLMOutput({
      sessionId: 's', taskId: 7, taskUuid: 'task-uuid', llmResponse: {}, llmOutputText: '想你了',
      contactName: 'Nyah', metadata: ctx.task.metadata, scratch, writeState, readState: ctx.readState,
    } as any) as Promise<any>).finally(() => { settled = true; });
    const step = async (seconds: number) => {
      for (let i = 0; i < seconds && !settled; i++) await vi.advanceTimersByTimeAsync(1000);
    };
    return { before, pending, step, isSettled: () => settled };
  };

  it('评估比主生成慢：等到结论再发', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const run = await startOutput(async () => {
        await gate;
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"changed":true} SLOW-EVAL' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      });
      expect(run.before.totalTimeoutMs).toBeGreaterThan(240_000);
      await run.step(30);
      expect(run.isSettled(), '评估没出结果之前不发').toBe(false);
      release();
      await run.step(5);
      const decision = await run.pending;
      expect(decision.pushPayloads.at(-1).metadata.amsgEmotionUpdate).toContain('SLOW-EVAL');
    } finally { vi.useRealTimers(); }
  });

  it('评估等满上限：不带结论照发，并留日志', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const run = await startOutput(() => new Promise<Response>(() => {}));
      await run.step(59);
      expect(run.isSettled()).toBe(false);
      await run.step(5);
      const decision = await run.pending;
      expect(decision.decision).toBe('finish');
      expect(decision.pushPayloads.at(-1).metadata.amsgEmotionUpdate).toBeUndefined();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('[amsg:emotion]') && String(c[0]).includes('60s'))).toBe(true);
    } finally { vi.useRealTimers(); warn.mockRestore(); }
  });

  it('旧包没有评估模板 → 不评估', async () => {
    const { seen, payloads } = await fire({}, { chat: 'char:x/chat', emotion: 'char:x/emotion' });
    expect(seen).toHaveLength(0);
    expect(payloads.at(-1)!.metadata.amsgEmotionUpdate).toBeUndefined();
  });
});

describe('#14 MCP 说明块', () => {
  const mcp = { toolConfig: { mcpServers } };

  it('定时任务：抬头带用户名，native 模式末尾接上 MCP 提醒', async () => {
    const { ctx } = makeCtx(mcp);
    const text = (await prompt(ctx)).messages[0].content;
    expect(text).toContain('小明 在设置里给你连了 MCP 工具服务器，主动消息里也可以用');
    expect(text.trimEnd().endsWith(MCP_TAIL_REMINDER) || text.includes(MCP_TAIL_REMINDER)).toBe(true);
  });

  it('text 模式不加末尾提醒', async () => {
    const { ctx } = makeCtx({ toolConfig: { mcpServers, mcpUseNativeTools: false } });
    expect((await prompt(ctx)).messages[0].content).not.toContain(MCP_TAIL_REMINDER);
  });

  it('用户名为空时退回「用户」', async () => {
    const { ctx } = makeCtx({ ...mcp, pack: { targetName: '对方' } });
    expect((await prompt(ctx)).messages[0].content).toContain('用户 在设置里给你连了 MCP 工具服务器');
  });

  it('即时对话：抬头不提主动消息，提醒作为最后一条 system', async () => {
    const { ctx } = makeCtx({
      ...mcp,
      metadata: { amsgInstantChat: true, amsgMode: 'instant' },
      pack: { chat: { messages: [{ role: 'system', content: '你是 Nyah。' }, { role: 'user', content: '在吗' }], builtAt: NOW.getTime() } },
    });
    const { messages } = await prompt(ctx);
    const all = messages.map((m) => String(m.content)).join('\n');
    expect(all).toContain('小明 在设置里给你连了 MCP 工具服务器】');
    expect(all).not.toContain('主动消息里也可以用');
    expect(messages.at(-1)).toEqual({ role: 'system', content: MCP_TAIL_REMINDER });
  });
});

// 回执跟着包进了模板：发出去之后，客户端按这几个 id 销账，下一次定时消息不再重提。
describe('C 模板里带过的回执随推送回去', () => {
  it('包里有 noticeIds → 最后一条带 amsgNoticeIds', async () => {
    const { ctx, scratch, writeState } = makeCtx({ pack: { noticeIds: ['n1', 'n2'] } });
    await prompt(ctx);
    const decision = await amsgHooks.onLLMOutput({
      sessionId: 's', taskId: 7, taskUuid: 'task-uuid', llmResponse: {}, llmOutputText: '想你了',
      contactName: 'Nyah', metadata: ctx.task.metadata, scratch, writeState, readState: ctx.readState,
    } as any) as any;
    expect(decision.pushPayloads.at(-1).metadata.amsgNoticeIds).toEqual(['n1', 'n2']);
  });
});

// T6 后半：worker 到点用同一个抽签函数重抽概率条目。
describe('世界书概率条目到点重抽', () => {
  const template = `前{{AMSG_WB_IF:wb-rain}}下雨天会犯困{{/AMSG_WB_IF}}后\n${AMSG_SLOT_TASK_INSTRUCTION}`;

  it('同一个包连着到点两次，随机源不同结果就不同', async () => {
    const rnd = vi.spyOn(Math, 'random');
    rnd.mockReturnValue(0.1);
    const first = (await prompt(makeCtx({ pack: { template, worldbookRolls: [{ id: 'wb-rain', probability: 35 }] } }).ctx)).messages[0].content;
    rnd.mockReturnValue(0.9);
    const second = (await prompt(makeCtx({ pack: { template, worldbookRolls: [{ id: 'wb-rain', probability: 35 }] } }).ctx)).messages[0].content;
    rnd.mockRestore();
    expect(first).toContain('前下雨天会犯困后');
    expect(second).toContain('前后');
    expect(second).not.toContain('AMSG_WB');
  });
});

// I5：用户所在地节日插在「互动对象」段 bio 后面（与本地同位），找不到那一段时不追加到末尾。
describe('用户所在地节日的插入位置', () => {
  const BIO = '喜欢猫。\n\n最近在学吉他。';
  const run = async (content: string) => {
    holiday.value = '小明所在地今天是元旦。';
    const { ctx } = makeCtx({
      metadata: { amsgInstantChat: true, amsgMode: 'instant' },
      pack: { userBioLength: BIO.length, chat: { messages: [{ role: 'system', content }, { role: 'user', content: '在吗' }], builtAt: NOW.getTime() } },
    });
    try { return (await prompt(ctx)).messages.map((m) => String(m.content)); }
    finally { holiday.value = ''; }
  };

  it('即时对话：插在 bio 后面（bio 里有空行也不插进中间）', async () => {
    const [system] = await run(`### 互动对象 (User)\n- 名字: 小明\n- 设定/备注: ${BIO}\n\n### 下一段`);
    expect(system).toBe(`### 互动对象 (User)\n- 名字: 小明\n- 设定/备注: ${BIO}\n\n- 小明所在地今天是元旦。\n\n### 下一段`);
  });

  it('即时对话：没有「互动对象」段时不追加到末尾', async () => {
    const all = (await run('没有互动对象段')).join('\n');
    expect(all).not.toContain('元旦');
  });
});

// 倒数第二轮交回的结果之后就是最后一轮，不能再回连：那一轮的回喂里不教 XHS_DETAIL / XHS_SEARCH。
describe('倒数第二轮的工具回喂不教回连标签', () => {
  const run = async (iteration: number) => {
    const { ctx, scratch } = makeCtx({});
    await prompt(ctx);
    const max = (scratch.fire as any).maxToolIterations as number;
    const [out] = await amsgHooks.executeToolCalls!(
      [{ id: 'c1', function: { name: 'xhs_search', arguments: JSON.stringify({ keyword: '雨天' }) } }] as any,
      { sessionId: 's', scratch, iteration: iteration < 0 ? max + iteration : iteration } as any,
    );
    return String(out.content);
  };

  it('更早的轮次照常教，倒数第二轮不教', async () => {
    expect(await run(0)).toContain('XHS_DETAIL');
    const last = await run(-2);
    expect(last).not.toContain('XHS_DETAIL');
    expect(last).not.toContain('XHS_SEARCH');
  });
});

describe('审查补丁 · worker', () => {
  const output = (ctx: any, scratch: any, writeState: any) => amsgHooks.onLLMOutput({
    sessionId: 's', taskId: 7, taskUuid: 'task-uuid', llmResponse: {}, llmOutputText: '想你了',
    contactName: 'Nyah', metadata: ctx.task.metadata, scratch, writeState, readState: ctx.readState,
  } as any) as Promise<any>;

  it('#4 取不到副 API 凭据：不评估、不挂评估标记，只留日志', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const { ctx, scratch, writeState } = makeCtx({ pack: { emotionEval: { prompt: '评估 __EMOTION_EVAL_SYSTEM_PROMPT__' } }, credRefs: { chat: 'c' } });
      ctx.resolveLlmCredential = vi.fn(async () => null);
      await prompt(ctx);
      const meta = (await output(ctx, scratch, writeState)).pushPayloads.at(-1).metadata;
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(meta.amsgEmotionDone).toBeUndefined();
      expect(meta.amsgEmotionError).toBeUndefined();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('[amsg:emotion]'))).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it('#5 发出去过的回执不再提：落地前记下，下次渲染时去掉', async () => {
    const template = `前{{AMSG_NOTICES:n1}}【回执】到点没发出去{{/AMSG_NOTICES}}后\n${AMSG_SLOT_TASK_INSTRUCTION}`;
    const first = makeCtx({ pack: { template, noticeIds: ['n1'] } });
    expect((await prompt(first.ctx)).messages[0].content).toContain('前【回执】到点没发出去后');
    await output(first.ctx, first.scratch, first.writeState);
    await amsgFireSettled({ status: 'sent', sentCount: 1, scratch: first.scratch, writeState: first.writeState } as any);
    const written = (first.writeState.mock.calls as any[]).flatMap((c) => c[1]).find((e: any) => e.key === AMSG_SENT_NOTICES_KEY);
    expect(written).toBeTruthy();
    const second = makeCtx({ pack: { template, noticeIds: ['n1'] }, extraRows: [{ key: AMSG_SENT_NOTICES_KEY, value: written.value }] });
    const text = (await prompt(second.ctx)).messages[0].content;
    expect(text).toContain('前后');
    expect(text).not.toContain('AMSG_NOTICES');
  });

  it('#6 主生成已经用掉大半预算时，评估只等剩下的那点，到点照发', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
      const { ctx, scratch, writeState } = makeCtx({ pack: { emotionEval: { prompt: 'P' } }, credRefs: { chat: 'c', emotion: 'e' } });
      ctx.resolveLlmCredential = vi.fn(async () => ({ apiUrl: 'https://eval.example/v1/chat/completions', apiKey: 'k', primaryModel: 'm' }));
      const before = await prompt(ctx) as any;
      // 主生成跑了 280 秒：总预算只剩 20 秒，评估最多再等十来秒。
      vi.setSystemTime(NOW.getTime() + 280_000);
      let settled = false;
      const pending = output(ctx, scratch, writeState).finally(() => { settled = true; });
      for (let i = 0; i < 20 && !settled; i++) await vi.advanceTimersByTimeAsync(1000);
      expect(settled).toBe(true);
      expect(Date.now() - NOW.getTime()).toBeLessThan(before.totalTimeoutMs);
      expect((await pending).decision).toBe('finish');
    } finally { vi.useRealTimers(); warn.mockRestore(); }
  });
});

// 倒数第二轮被打回的重复调用：下一轮不能再调工具，回喂里不教「换一个工具」那半句。
describe('倒数第二轮的重复调用回喂', () => {
  const call = { id: 'c1', function: { name: 'recall', arguments: JSON.stringify({ year: '2026', month: '06' }) } };
  const runDuplicate = async (fromEnd: number | null) => {
    const { ctx, scratch } = makeCtx({});
    await prompt(ctx);
    const max = (scratch.fire as any).maxToolIterations as number;
    const iteration = fromEnd == null ? 0 : max + fromEnd;
    await amsgHooks.executeToolCalls!([call] as any, { sessionId: 's', scratch, iteration } as any);
    const [dup] = await amsgHooks.executeToolCalls!([{ ...call, id: 'c2' }] as any, { sessionId: 's', scratch, iteration } as any);
    return String(dup.content);
  };

  it('早的轮次照常有那半句，倒数第二轮没有', async () => {
    expect(await runDuplicate(null)).toContain('才换一个还没用过的工具');
    const late = await runDuplicate(-2);
    expect(late).toContain('没有再执行');
    expect(late).not.toContain('才换一个还没用过的工具');
  });
});
