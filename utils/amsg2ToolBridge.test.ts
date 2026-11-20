// utils/amsg2ToolBridge.test.ts
// 回归守卫：角色在同一轮工具循环里连续排程/取消/续期时，本地清单必须累加。
// char 是生成开始时的快照，updateCharacter 只更 React state 不回写它——清单要是从
// char 上读写，第二次 schedule 就会读着空清单把第一条覆盖掉（「建俩只显示一个」）。
// 累加由 createAmsg2ToolSession 的本轮局部变量兜住，下面的用例钉的就是这件事。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: { scheduleCharacterTask: vi.fn(), cancelTask: vi.fn() },
}));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { getGlobalConfig: vi.fn() },
}));

import { buildAmsg2Tools, createAmsg2ToolSession, executeAmsg2Tool, executeAmsg2ToolWithOutcome } from './amsg2ToolBridge';
import { resolveAmsgLimits } from './amsgLimits';
import { isAmsg2EnabledForChar } from './amsg2Tasks';
import { ActiveMsgClient } from './activeMsgClient';

const UUIDS = [
  'aaaaaaaa-0000-0000-0000-000000000000',
  'bbbbbbbb-0000-0000-0000-000000000000',
  'cccccccc-0000-0000-0000-000000000000',
];
const shortOf = (uuid: string) => uuid.slice(0, 8);

// 排程接口把角色写的墙钟折成的绝对时刻（上海 2026-08-03 21:00 / 纽约同日 09:00）。
const RESOLVED_ISO = '2026-08-03T13:00:00.000Z';

// persistTasks 会用 Date.now() 跑 48h 清理，一次性任务过期就被清空——夹具里这个
// 绝对时刻写死了，系统时钟往前走两天它就会被当成陈旧任务扫掉，测试跟着莫名其妙全红。
// 这里把时钟钉在 RESOLVED_ISO 之前，让这份夹具时间永远不会「过期」。
beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-08-03T05:00:00.000Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

// 模拟 React：updateCharacter 只记录落盘的 config，绝不回写 char——
// 这样只有「session 自己兜住最新 config」才能让同轮后续调用读到累加结果。
const makeSession = (charOver: Record<string, unknown> = {}) => {
  const char: any = {
    id: 'preset-x', name: 'Nyah', activeMsg2Config: { enabled: true, tasks: [] },
    ...charOver,
  };
  const persisted: any[] = [];
  const updateCharacter = vi.fn((_id: string, updates: any) => {
    if (updates.activeMsg2Config) persisted.push(updates.activeMsg2Config);
  });
  const deps = createAmsg2ToolSession({
    char, userProfile: {} as any, groups: [], realtimeConfig: {} as any,
    apiConfig: {} as any, updateCharacter,
  });
  return { deps, char, persisted };
};

// 默认往后一小时；要在同一轮里排两条**不同**的任务就错开小时数——同名同参的调用
// 现在会被指纹拦下（见文件末尾那组用例），两条都写同一个时刻测不出「累加」。
const future = (hours = 1) => new Date(Date.now() + hours * 3600_000).toISOString();
const lastTasks = (persisted: any[]) => persisted[persisted.length - 1]?.tasks ?? [];

describe('amsg2ToolBridge 同一轮多次调用累加', () => {
  beforeEach(() => {
    let n = 0;
    (ActiveMsgClient.scheduleCharacterTask as any).mockReset();
    (ActiveMsgClient.scheduleCharacterTask as any).mockImplementation(async () => {
      const uuid = UUIDS[n++];
      return {
        uuid, clientTaskId: `cid-${uuid.slice(0, 4)}`, anchorMs: 0, replacedCancelFailed: false,
        // 真接口把 send_at 折成绝对时刻后回传，bridge 该存这一份（见下面的时区用例）。
        firstSendAt: RESOLVED_ISO,
      };
    });
    (ActiveMsgClient.cancelTask as any).mockReset();
    (ActiveMsgClient.cancelTask as any).mockResolvedValue({});
  });

  it('一轮内两次 schedule → 本地保留两条（回归：陈旧快照覆盖）', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);
    await executeAmsg2Tool('schedule_active_message', { send_at: future(2) }, deps);

    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t: any) => t.taskUuid)).toEqual([UUIDS[0], UUIDS[1]]);
  });

  it('一轮内 schedule×2 后按短 id 取消其一 → 剩下的是另一条', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);
    await executeAmsg2Tool('schedule_active_message', { send_at: future(2) }, deps);
    await executeAmsg2Tool('cancel_active_message', { task_id: shortOf(UUIDS[1]) }, deps);

    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskUuid).toBe(UUIDS[0]);
    expect(ActiveMsgClient.cancelTask).toHaveBeenCalledWith(UUIDS[1]);
  });

  it('一轮内 schedule 一次性任务后立刻 renew → 换成新 uuid、旧记录移除、模式沿用', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', {
      send_at: future(), mode: 'prompted', prompt_hint: '问问吃了没',
    }, deps);
    const renewResult = await executeAmsg2Tool('renew_active_message', {
      send_at: future(), task_id: shortOf(UUIDS[0]),
    }, deps);

    // 修复前这里会回「当前角色没有可续期的任务」——renew 也读不到同轮刚建的那条。
    expect(renewResult).not.toContain('没有可续期');
    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskUuid).toBe(UUIDS[1]);
    expect(tasks[0].mode).toBe('prompted');
    expect(tasks[0].promptHint).toBe('问问吃了没');
    expect(tasks[0].recurrenceType).toBe('none');
    // 旧任务的远端取消由 scheduleCharacterTask 内部「先建后删」负责，bridge 的职责是
    // 把要替换的 uuid 传下去——这里钉的是 bridge 这一侧。
    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ replaceTaskUuid: UUIDS[0] }),
    );
  });

  it('角色排的任务带 selfScheduled 标记（连发上限的到点兜底闸认它；面板排的不带）', async () => {
    const { deps } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ task: expect.objectContaining({ selfScheduled: true }) }),
    );
  });

  it('一轮内 schedule 后 list → 列得出刚建的那条', async () => {
    const { deps } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    const listed = await executeAmsg2Tool('list_active_messages', {}, deps);

    expect(listed).toContain(shortOf(UUIDS[0]));
    expect(listed).not.toContain('没有任何定时主动消息任务');
  });

  // 回归守卫：循环任务的 renew 一度是整条改期（recurrence 原样透传 + replaceTaskUuid）。
  // 「每天 9:00 的早安」被角色顺手续到 11:00「晚点补上」，从明天起就永久变成 11:00 了，
  // 编号还跟着换一个。现在改成只补当次，原序列一条不动。
  it('循环任务 renew → 原任务留着，另加一条一次性补发', async () => {
    // 这条测的是补当次的语义：先放开「可以排重复的」，角色才排得出那条每天的。
    const { deps, persisted } = makeSession({
      activeMsg2Config: { enabled: true, tasks: [], allowSelfRecurring: true },
    });
    await executeAmsg2Tool('schedule_active_message', {
      send_at: future(), mode: 'prompted', prompt_hint: '道早安', recurrence: 'daily',
    }, deps);
    const renewResult = await executeAmsg2Tool('renew_active_message', {
      send_at: future(2), task_id: shortOf(UUIDS[0]),
    }, deps);

    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(2);
    // 原来那条每天的还在，编号和节奏都没变
    expect(tasks[0].taskUuid).toBe(UUIDS[0]);
    expect(tasks[0].recurrenceType).toBe('daily');
    // 新加的是一次性补发，方向沿用
    expect(tasks[1].taskUuid).toBe(UUIDS[1]);
    expect(tasks[1].recurrenceType).toBe('none');
    expect(tasks[1].promptHint).toBe('道早安');

    const scheduleArgs = (ActiveMsgClient.scheduleCharacterTask as any).mock.calls[1][0];
    expect(scheduleArgs.replaceTaskUuid).toBeUndefined();
    expect(scheduleArgs.task.recurrenceType).toBe('none');
    // 回执得说清楚原节奏没动，否则角色下一轮会跑去把「原来那条」再取消一遍
    expect(renewResult).toContain(shortOf(UUIDS[0]));
    expect(renewResult).toContain('重复节奏不变');
  });

  it('远端取消失败 → 本地记录保留并标错，不留「看不见的幽灵任务」', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    (ActiveMsgClient.cancelTask as any).mockRejectedValueOnce(new Error('worker 503'));
    const result = await executeAmsg2Tool('cancel_active_message', { task_id: shortOf(UUIDS[0]) }, deps);

    expect(result).toContain('失败');
    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskUuid).toBe(UUIDS[0]);
    expect(tasks[0].lastError).toBeTruthy();
  });

  it('累加不靠就地改 char：React state 里的角色对象不被写脏', async () => {
    const { deps, char } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);
    await executeAmsg2Tool('schedule_active_message', { send_at: future(2) }, deps);

    // 落盘走 updateCharacter，char 快照本身保持原样（它是 React state 里的对象）。
    expect(char.activeMsg2Config.tasks).toEqual([]);
    // 但 session 读得到累加后的两条。
    expect(deps.getConfig()?.tasks).toHaveLength(2);
  });
});

// ─── 角色级开关 ───
// 工具注入这条路要是只看全局 workerUrl，没在面板里开过 2.0 的角色照样拿得到
// schedule_active_message；再加上落盘时强写 enabled:true，一次工具调用就把用户
// 没表态过的功能替他打开了。两头都得钉住。
describe('角色级开关', () => {
  const charWith = (config: any) => ({ id: 'preset-x', name: 'Nyah', activeMsg2Config: config } as any);

  it('关掉的角色不给注入工具', () => {
    expect(isAmsg2EnabledForChar(charWith({ enabled: false, tasks: [] }))).toBe(false);
  });

  it('开着的角色照常注入', () => {
    expect(isAmsg2EnabledForChar(charWith({ enabled: true, tasks: [] }))).toBe(true);
  });

  it('从没配过 2.0 的角色算关闭（要先进面板把开关打开）', () => {
    expect(isAmsg2EnabledForChar(charWith(undefined))).toBe(false);
  });

  it('落盘不把 enabled 改写成 true（工具调用不得替用户重新开启功能）', async () => {
    let n = 0;
    (ActiveMsgClient.scheduleCharacterTask as any).mockImplementation(async () => ({
      uuid: UUIDS[n++], clientTaskId: 'cid', anchorMs: 0, replacedCancelFailed: false,
    }));
    const char: any = charWith({ enabled: false, tasks: [] });
    const persisted: any[] = [];
    const deps = createAmsg2ToolSession({
      char, userProfile: {} as any, groups: [], realtimeConfig: {} as any, apiConfig: {} as any,
      updateCharacter: (_id: string, updates: any) => {
        if (updates.activeMsg2Config) persisted.push(updates.activeMsg2Config);
      },
    });
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);

    expect(persisted[persisted.length - 1].enabled).toBe(false);
  });
});

// 回归守卫：角色写的 send_at 是「它那边的墙钟」，不带时区后缀（工具描述里就是这么教的）。
// 原样落盘的话，本地读它的地方一律 new Date() 按设备时区解析——异国角色的任务卡、待触发
// 判定、以及下面这句回话全都差一个时差。排程接口已经按角色时区把它折成绝对时刻了，
// bridge 存的、说的都得是那一份。
describe('角色排程的时间统一存绝对时刻', () => {
  beforeEach(() => {
    let n = 0;
    (ActiveMsgClient.scheduleCharacterTask as any).mockReset();
    (ActiveMsgClient.scheduleCharacterTask as any).mockImplementation(async () => ({
      uuid: UUIDS[n++], clientTaskId: 'cid', anchorMs: 0, replacedCancelFailed: false,
      firstSendAt: RESOLVED_ISO,
    }));
  });

  it('落盘存排程接口折好的绝对时刻，不是角色写的墙钟原串', async () => {
    const { deps, persisted } = makeSession({
      customTimezoneEnabled: true, customTimezone: 'America/New_York',
    });
    await executeAmsg2Tool(
      'schedule_active_message',
      { send_at: '2026-08-03T09:00:00' },   // 纽约角色写的「明早九点」
      deps,
    );

    expect(lastTasks(persisted)[0].firstSendTime).toBe(RESOLVED_ISO);
  });

  it('回话里的时间按角色的钟说，且只折一次', async () => {
    const { deps } = makeSession({
      customTimezoneEnabled: true, customTimezone: 'America/New_York',
    });
    const reply = await executeAmsg2Tool(
      'schedule_active_message',
      { send_at: '2026-08-03T09:00:00' },
      deps,
    );

    // 纽约角色说的九点，回话里就该是 09:00
    expect(reply).toContain('09:00');
    // 折两次（先按设备解析原串、再换算到纽约）会落在别的钟点上
    expect(reply).not.toContain('21:00');
  });
});

// ─── 打转防护 ───
// 现场：用户说一句「等会找我」，角色一口气排出 5 条一模一样的任务（同时间、同提示词）。
// 5 不是巧合——它是每个角色的待触发上限，也就是模型一路重复调用直到撞上限才停。前台的
// 工具循环最多转 6 轮，每一轮执行一次 schedule 就是远端实打实 5 条任务。
//
// 两层防护，跟 worker 的 fire 循环同一套（见 utils/agenticToolFeedback.ts）：
//   软的 —— 回话末尾明说「这一步做完了，别再调同一个」；
//   硬的 —— 同名同参第二次直接打回，一次网络请求都不发。
describe('同名同参的调用不重复执行', () => {
  beforeEach(() => {
    let n = 0;
    (ActiveMsgClient.scheduleCharacterTask as any).mockReset();
    (ActiveMsgClient.scheduleCharacterTask as any).mockImplementation(async () => ({
      uuid: UUIDS[n++], clientTaskId: 'cid', anchorMs: 0, replacedCancelFailed: false,
      firstSendAt: RESOLVED_ISO,
    }));
    (ActiveMsgClient.cancelTask as any).mockReset();
    (ActiveMsgClient.cancelTask as any).mockResolvedValue({});
  });

  it('第二次完全相同的 schedule → 不建任务、不发请求，只回一句打回', async () => {
    const { deps, persisted } = makeSession();
    const args = { send_at: future(1), mode: 'prompted', prompt_hint: '等会来找你' };
    await executeAmsg2Tool('schedule_active_message', args, deps);
    const second = await executeAmsg2Tool('schedule_active_message', { ...args }, deps);

    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenCalledTimes(1);
    expect(lastTasks(persisted)).toHaveLength(1);
    expect(second).not.toContain('已创建');
    expect(second).toContain('不要');
  });

  it('参数写法变了但内容一样（键序不同）照样算同一次', async () => {
    const { deps } = makeSession();
    const send_at = future(1);
    await executeAmsg2Tool('schedule_active_message', { send_at, mode: 'auto' }, deps);
    await executeAmsg2Tool('schedule_active_message', { mode: 'auto', send_at }, deps);

    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenCalledTimes(1);
  });

  it('换个时间就照常放行（只拦完全一样的，多轮能力不减）', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);
    await executeAmsg2Tool('schedule_active_message', { send_at: future(3) }, deps);

    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenCalledTimes(2);
    expect(lastTasks(persisted)).toHaveLength(2);
  });

  it('renew 同参第二次也拦（它内部走的还是建新任务那条路）', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);
    const renewArgs = { send_at: future(2), task_id: shortOf(UUIDS[0]) };
    await executeAmsg2Tool('renew_active_message', renewArgs, deps);
    const second = await executeAmsg2Tool('renew_active_message', { ...renewArgs }, deps);

    // 首次 schedule + 首次 renew = 2 次；第二次 renew 不该再打一发
    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenCalledTimes(2);
    expect(lastTasks(persisted)).toHaveLength(1);
    expect(second).toContain('不要');
  });

  it('list：清单变化后再次查询照常放行；清单未变原地重查按重复打回，且回话带收尾引导', async () => {
    const { deps } = makeSession();
    const empty = await executeAmsg2ToolWithOutcome('list_active_messages', {}, deps);
    const dupEmpty = await executeAmsg2ToolWithOutcome('list_active_messages', {}, deps);
    await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);
    const afterSchedule = await executeAmsg2ToolWithOutcome('list_active_messages', {}, deps);

    expect(empty.text).toContain('没有任何定时主动消息任务');
    expect(empty.text).toContain('直接留空结束即可');
    expect(empty.outcome.status).toBe('done');
    expect(dupEmpty.outcome.status).toBe('duplicate');
    expect(afterSchedule.text).toContain(shortOf(UUIDS[0]));
    expect(afterSchedule.outcome.status).toBe('done');
  });

  it('排程成功的回话末尾带收尾引导（软的那层）', async () => {
    const { deps } = makeSession();
    const reply = await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);

    // 事实照说
    expect(reply).toContain('已创建');
    // 再明说这一步结束了，别接着调同一个
    expect(reply).toContain('同样的调用不要再来一遍');
  });

  it('远端失败的那次不记账：改不了参数的重试仍放行一次', async () => {
    const { deps } = makeSession();
    (ActiveMsgClient.scheduleCharacterTask as any).mockRejectedValueOnce(new Error('worker 503'));
    const args = { send_at: future(1) };
    const failed = await executeAmsg2Tool('schedule_active_message', args, deps);
    const retried = await executeAmsg2Tool('schedule_active_message', { ...args }, deps);

    expect(failed).toContain('失败');
    expect(retried).toContain('已创建');
    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenCalledTimes(2);
  });
});

// 连发上限的本地排程闸（与 worker fire 侧 unanswered_limit 对齐）：本地排到超限的
// 那几条会被到点兜底闸静默 skip——角色在正文里承诺了「等下再来找你」，到点却凭空
// 蒸发。这里钉住：超限时带回喂打回、一次远端请求都不发；面板任务不占额度。
describe('连发上限·本地排程闸', () => {
  beforeEach(() => {
    (ActiveMsgClient.scheduleCharacterTask as any).mockReset();
    (ActiveMsgClient.scheduleCharacterTask as any).mockImplementation(async () => ({
      uuid: UUIDS[0], clientTaskId: 'ct-limit', firstSendAt: RESOLVED_ISO, anchorMs: null,
    }));
  });

  const selfTask = (uuid: string) => ({
    taskUuid: uuid, clientTaskId: `${uuid}-c`, mode: 'auto', recurrenceType: 'none',
    expirePolicy: 'expire', source: 'character', status: 'scheduled',
    firstSendTime: new Date(Date.now() + 3600_000).toISOString(), createdAt: Date.now(),
  });

  it('挂满自排任务（默认上限 3）再排 → 打回，不发远端请求', async () => {
    const { deps } = makeSession({
      activeMsg2Config: { enabled: true, tasks: [selfTask('u1'), selfTask('u2'), selfTask('u3')] },
    });
    const reply = await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);
    expect(reply).toContain('连发上限');
    expect(ActiveMsgClient.scheduleCharacterTask).not.toHaveBeenCalled();
  });

  it('面板里用户亲手排的任务不占连发额度', async () => {
    const userTask = (uuid: string) => ({ ...selfTask(uuid), source: 'user' });
    const { deps } = makeSession({
      activeMsg2Config: { enabled: true, tasks: [userTask('u1'), userTask('u2'), userTask('u3')] },
    });
    // 错开那几条一小时之外：这条测的是连发额度，别撞上两条之间的间隔要求。
    const reply = await executeAmsg2Tool('schedule_active_message', { send_at: future(3) }, deps);
    expect(reply).toContain('已创建');
  });

  it('默认不许排重复的：带 recurrence=daily 直接打回，不发远端请求', async () => {
    const { deps } = makeSession();
    const reply = await executeAmsg2Tool('schedule_active_message', { send_at: future(2), recurrence: 'daily' }, deps);
    expect(reply).toContain('一次性');
    expect(ActiveMsgClient.scheduleCharacterTask).not.toHaveBeenCalled();
  });

  it('默认没放开「到点必发」：角色要 force 也按普通的排', async () => {
    const { deps } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future(2), expire_policy: 'force' }, deps);
    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ task: expect.objectContaining({ expirePolicy: 'expire' }) }),
    );
  });

  it('跟已经排着的挨得太近 → 打回（默认至少隔 10 分钟）', async () => {
    const { deps } = makeSession({
      activeMsg2Config: { enabled: true, tasks: [{ ...selfTask('u1'), source: 'user' }] },
    });
    const nearby = new Date(Date.now() + 3600_000 + 5 * 60_000).toISOString();
    const reply = await executeAmsg2Tool('schedule_active_message', { send_at: nearby }, deps);
    expect(reply).toContain('太近');
    expect(ActiveMsgClient.scheduleCharacterTask).not.toHaveBeenCalled();
  });

  // 回归守卫：用户自己排的「8 点叫我」被角色改期，还是用户的任务——不打自排标记、
  // 不降成普通的，到点那几道只管角色自排的闸不拦它。
  it('改期用户自己排的「到点必发」：不打自排标记、不降级、仍算用户的', async () => {
    const mine = { ...selfTask('u1'), source: 'user', expirePolicy: 'force' };
    const { deps, persisted } = makeSession({ activeMsg2Config: { enabled: true, tasks: [mine] } });
    await executeAmsg2Tool('renew_active_message', { send_at: future(3), task_id: 'u1' }, deps);
    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({ selfScheduled: false, expirePolicy: 'force' }),
        replaceTaskUuid: 'u1',
      }),
    );
    expect(lastTasks(persisted).find((t: any) => t.taskUuid !== 'u1')?.source).toBe('user');
  });

  it('工具签名与云端即时对话对齐：3 个工具、动态时区示例、克制指引，参数随设置隐藏', () => {
    const tools = buildAmsg2Tools(resolveAmsgLimits({ maxActiveTasks: 3 }), {
      nowMs: Date.parse('2026-11-19T12:00:00Z'),
      tz: { tzId: 'Asia/Tokyo' },
    });
    expect(tools.map((t) => t.function.name)).toEqual([
      'schedule_active_message',
      'cancel_active_message',
      'renew_active_message',
    ]);
    const locked = tools[0].function;
    expect(locked.parameters.properties).not.toHaveProperty('recurrence');
    expect(locked.parameters.properties).not.toHaveProperty('expire_policy');
    expect(locked.description).toContain('最多同时挂 3 个任务');
    expect(locked.description).toContain('不要为了排而排');
    expect(locked.parameters.properties.send_at.description).toContain('2026-11-20T21:00:00');
    expect(locked.parameters.properties.send_at.description).toContain('有时差');

    const open = buildAmsg2Tools(resolveAmsgLimits({ allowSelfRecurring: true, allowSelfForce: true }))[0].function;
    expect(open.parameters.properties).toHaveProperty('recurrence');
    expect(open.parameters.properties).toHaveProperty('expire_policy');
  });

  it('用户把上限设成 1 → 第一条自排就打回第二条，且按聊天语境引导改现有任务', async () => {
    const { deps } = makeSession({
      activeMsg2Config: { enabled: true, maxUnansweredSends: 1, tasks: [selfTask('u1')] },
    });
    const reply = await executeAmsg2Tool('schedule_active_message', { send_at: future(1) }, deps);
    expect(reply).toContain('连发上限是 1 次');
    expect(reply).toContain('renew_active_message');
    expect(reply).not.toContain('对方还没回复');
    expect(ActiveMsgClient.scheduleCharacterTask).not.toHaveBeenCalled();
  });
});

// 工具循环靠结局判断「这一轮办成事没有」、决定要不要逼模型收尾，trace 也照它记。
// 回话是给模型读的散文，拿它判成败靠不住，所以结局必须跟清单的真实变化对上。
describe('工具调用的结局', () => {
  beforeEach(() => {
    (ActiveMsgClient.scheduleCharacterTask as any).mockReset();
    (ActiveMsgClient.scheduleCharacterTask as any).mockImplementation(async () => ({
      uuid: UUIDS[0], clientTaskId: 'ct-outcome', firstSendAt: RESOLVED_ISO, anchorMs: null,
    }));
  });

  const selfTask = (uuid: string, hours = 1) => ({
    taskUuid: uuid, clientTaskId: `${uuid}-c`, mode: 'auto', recurrenceType: 'none',
    expirePolicy: 'expire', source: 'character', status: 'scheduled',
    firstSendTime: new Date(Date.now() + hours * 3600_000).toISOString(), createdAt: Date.now(),
  });

  it('排上了 → done', async () => {
    const { deps } = makeSession();
    const { outcome } = await executeAmsg2ToolWithOutcome('schedule_active_message', { send_at: future(2) }, deps);
    expect(outcome).toEqual({ tool: 'schedule_active_message', status: 'done' });
  });

  it('连发额度满了 → rejected，带原因码', async () => {
    const { deps } = makeSession({
      activeMsg2Config: { enabled: true, tasks: [selfTask('u1'), selfTask('u2', 2), selfTask('u3', 3)] },
    });
    const { outcome } = await executeAmsg2ToolWithOutcome('schedule_active_message', { send_at: future(5) }, deps);
    expect(outcome).toEqual({ tool: 'schedule_active_message', status: 'rejected', reason: 'unanswered_limit' });
  });

  it('离排着的太近 → rejected / min_gap', async () => {
    const { deps } = makeSession({
      activeMsg2Config: { enabled: true, tasks: [{ ...selfTask('u1'), source: 'user' }] },
    });
    const nearby = new Date(Date.now() + 3600_000 + 5 * 60_000).toISOString();
    const { outcome } = await executeAmsg2ToolWithOutcome('schedule_active_message', { send_at: nearby }, deps);
    expect(outcome.status).toBe('rejected');
    expect(outcome.reason).toBe('min_gap');
  });

  it('同名同参再来一次 → duplicate；排程接口抛错 → error 带报错开头', async () => {
    const { deps } = makeSession();
    const args = { send_at: future(2) };
    await executeAmsg2ToolWithOutcome('schedule_active_message', args, deps);
    const second = await executeAmsg2ToolWithOutcome('schedule_active_message', { ...args }, deps);
    expect(second.outcome.status).toBe('duplicate');

    (ActiveMsgClient.scheduleCharacterTask as any).mockRejectedValueOnce(new Error('名额满了'));
    const failed = await executeAmsg2ToolWithOutcome('schedule_active_message', { send_at: future(4) }, deps);
    expect(failed.outcome).toEqual({ tool: 'schedule_active_message', status: 'error', message: '名额满了' });
  });

  it('上一次的打回原因不会串到下一次成功的调用上；远端取消失败记 rejected 且更新签名', async () => {
    const { deps } = makeSession({
      activeMsg2Config: {
        enabled: true,
        tasks: [
          { ...selfTask('u1'), source: 'user' },
          // 过点 >48h 的陈旧任务：persistTasks 会顺手清掉它，但失败的 cancel 仍必须判为 rejected
          { ...selfTask('stale999', -72), firstSendTime: new Date(Date.now() - 72 * 3600_000).toISOString() },
        ],
      },
    });
    const listedBefore = await executeAmsg2ToolWithOutcome('list_active_messages', {}, deps);
    expect(listedBefore.outcome.status).toBe('done');

    (ActiveMsgClient.cancelTask as any).mockRejectedValueOnce(new Error('worker 503'));
    const cancelFailed = await executeAmsg2ToolWithOutcome('cancel_active_message', { task_id: 'u1' }, deps);
    expect(cancelFailed.outcome).toEqual({
      tool: 'cancel_active_message',
      status: 'rejected',
      reason: 'remote_cancel_failed',
    });

    // lastError 已写入，再调 list 不应被当成与失败前完全相同的签名拦掉
    const listedAfterFail = await executeAmsg2ToolWithOutcome('list_active_messages', {}, deps);
    expect(listedAfterFail.outcome.status).toBe('done');
    expect(listedAfterFail.text).toContain('远端取消失败');

    const nearby = new Date(Date.now() + 3600_000 + 5 * 60_000).toISOString();
    await executeAmsg2ToolWithOutcome('schedule_active_message', { send_at: nearby }, deps);
    const ok = await executeAmsg2ToolWithOutcome('schedule_active_message', { send_at: future(3) }, deps);
    expect(ok.outcome).toEqual({ tool: 'schedule_active_message', status: 'done' });
  });
});
