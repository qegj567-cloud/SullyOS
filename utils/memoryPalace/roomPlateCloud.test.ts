// utils/memoryPalace/roomPlateCloud.test.ts
//
// 回归守卫（交云端整理时带了什么）。本地端到端跑出来的坑：worker 那边发给模型的请求体
// 里只有 model 和 messages，温度和输出上限全没了——本地那条路是 0.3 / 8000，云端落到
// 供应商默认值。同一批材料两条路整理出不一样的门牌，而界面上完全看不出来。
//
// 门牌整理的提示词、解析、合并已经收在 roomPlateCore 这个叶子里两边共用，采样参数
// 也是「同一件活儿的一部分」，同样要从叶子里取、同样要送到云端那条路上。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { scheduleBackgroundJob, probeBackgroundJobSupportDetailed, getCronTriggerState, plateStore, charStore } = vi.hoisted(() => ({
  scheduleBackgroundJob: vi.fn(async () => ({ uuid: 'remote-uuid' })),
  probeBackgroundJobSupportDetailed: vi.fn(async () => 'supported' as string),
  /** 「后台任务」开关（Worker 的 cron）：默认开着；null 是问不到。 */
  getCronTriggerState: vi.fn(async (): Promise<{ supported: boolean; enabled?: boolean } | null> => ({ supported: true, enabled: true })),
  /** 假门牌库：落地那半截要读要写，node 上没有 IndexedDB。 */
  plateStore: { plates: new Map<string, any>(), saveError: null as Error | null },
  /** 假角色库：落地前要确认这个角色还在。 */
  charStore: { chars: [{ id: 'c1', name: '小满' }] as Array<{ id: string; name: string }> },
}));
/** 「这条任务可能已经在远端建起来了」的标记，跟真身同款（见 activeMsgClient）。 */
const MAYBE_CREATED = '__amsgBackgroundJobMaybeCreated';
vi.mock('../activeMsgClient', () => ({
  ActiveMsgClient: { scheduleBackgroundJob, probeBackgroundJobSupportDetailed, getCronTriggerState },
  mayHaveCreatedBackgroundJob: (error: unknown) =>
    (error as Record<string, unknown> | null)?.['__amsgBackgroundJobMaybeCreated'] === true,
}));
vi.mock('../amsg2ToolBridge', () => ({ isAmsg2GlobalReady: vi.fn(async () => true) }));
// 提交要记一笔「API 调用记录」，那份最终写 IndexedDB。这里只关心提交本身。
vi.mock('../apiCallLog', () => ({
  cloudApiCallLogId: (id: string) => `cloud-${id}`,
  recordCloudApiCall: vi.fn(),
  settleCloudApiCall: vi.fn(),
}));
vi.mock('./db', () => {
  const loadOrCreatePlate = vi.fn(async (charId: string, room: string) =>
    plateStore.plates.get(room) ?? { id: `${charId}:${room}`, charId, room, entries: [], updatedAt: 0, version: 0 });
  const save = vi.fn(async (p: any) => {
    if (plateStore.saveError) throw plateStore.saveError;
    plateStore.plates.set(p.room, p);
  });
  return {
    ROOM_PLATES_UPDATED_EVENT: 'room-plates-updated',
    RoomPlateDB: { get: vi.fn(), save },
    loadOrCreatePlate,
    // 真身按门牌排队串行，这里只要保住「现读一份 → 改 → 存回去」这三步的语义
    // （落库失败照抛，闸和幂等那几条断言都压在它上面）。
    mutatePlate: vi.fn(async (charId: string, room: string, change: (p: any) => any) => {
      const next = change(await loadOrCreatePlate(charId, room));
      if (!next) return null;
      await save(next);
      return next;
    }),
    plateId: (charId: string, room: string) => `${charId}:${room}`,
  };
});
// 结果落地前要确认角色还在（删掉的角色不许被一份迟到的结果重新长出四块门牌）。
vi.mock('../db', () => ({
  DB: { getAllCharacters: vi.fn(async () => charStore.chars) },
}));
// 落地成功要广播一条「门牌更新了」，node 上没有 window。
vi.stubGlobal('window', { dispatchEvent: vi.fn() });

import { PLATE_CONSOLIDATE_KIND, PLATE_CONSOLIDATE_RESULT_KIND } from '../amsgPlateJob';
import { PLATE_LLM_MAX_TOKENS, PLATE_LLM_TEMPERATURE } from './roomPlateCore';
import { recordCloudApiCall, settleCloudApiCall } from '../apiCallLog';
import { RoomPlateDB } from './db';
import {
  applyPlateConsolidateResult,
  clearPlateJobDone,
  clearPlateJobInFlight,
  plateCloudGate,
  readPlateJobInFlightRaw,
  submitPlateConsolidation,
} from './roomPlateCloud';
import type { RoomPlate } from './types';

const LIGHT_LLM = { baseUrl: 'https://light.example.dev/v1', apiKey: 'sk-light', model: 'cheap' };

const plate = (room: RoomPlate['room'], texts: string[]): RoomPlate => ({
  id: `c1:${room}`,
  charId: 'c1',
  room,
  entries: texts.map((text, i) => ({
    id: `pe_${room}_${i}`, text, firstLearnedAt: 1, updatedAt: 1, sourceCount: 1,
  })),
  updatedAt: 1,
  version: 1,
});

const submit = (over: Record<string, unknown> = {}) => submitPlateConsolidation({
  charId: 'c1',
  charName: '小满',
  userName: '小明',
  identityContext: '（身份上下文）',
  plates: [plate('user_room', ['小明在读研'])],
  materials: [{ room: 'user_room', lines: ['小明搬去和同学合租了'] }],
  lightLLM: LIGHT_LLM,
  snapshotAt: 1,
  ...over,
} as any);

beforeEach(() => {
  scheduleBackgroundJob.mockClear().mockResolvedValue({ uuid: 'remote-uuid' });
  probeBackgroundJobSupportDetailed.mockClear().mockResolvedValue('supported');
  getCronTriggerState.mockClear().mockResolvedValue({ supported: true, enabled: true });
  vi.mocked(settleCloudApiCall).mockClear();
  vi.mocked(recordCloudApiCall).mockClear();
  vi.mocked(RoomPlateDB.save).mockClear();
  plateStore.plates.clear();
  plateStore.saveError = null;
  charStore.chars = [{ id: 'c1', name: '小满' }];
  clearPlateJobInFlight('c1');
  clearPlateJobDone('c1');
});

/** 本轮提交拿到的 job 编号（提交侧自己生成，只能从调用参数里取）。 */
const lastJobId = (): string => (scheduleBackgroundJob.mock.calls.at(-1) as unknown as [any])[0].jobId;

/** 一份空结果：闸和调用记录那半截照常走，落库那半截直接短路（用不着 IDB）。 */
const emptyResult = (jobId: string) => ({
  resultKind: PLATE_CONSOLIDATE_RESULT_KIND,
  v: 1,
  jobId,
  charId: 'c1',
  items: [],
  rooms: [],
});

/** 一份真会落库的结果：两块门牌，各一条。 */
const twoRoomResult = (jobId: string) => ({
  resultKind: PLATE_CONSOLIDATE_RESULT_KIND,
  v: 1,
  jobId,
  charId: 'c1',
  items: [
    { room: 'user_room', text: '小明搬去和同学合租了' },
    { room: 'study', text: '在学做菜' },
  ],
  rooms: [
    { room: 'user_room', entryIds: [] },
    { room: 'study', entryIds: [] },
  ],
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('交云端整理', () => {
  it('采样参数用叶子里那两个常量（本地那条路用的是同一份）', async () => {
    await submit();

    const [params] = scheduleBackgroundJob.mock.calls[0] as unknown as [any];
    expect(params.temperature).toBe(PLATE_LLM_TEMPERATURE);
    expect(params.maxTokens).toBe(PLATE_LLM_MAX_TOKENS);
  });

  it('带上 kind、每块门牌的条目 id 快照，和记忆宫殿副 API 那行凭据', async () => {
    await submit();

    const [params] = scheduleBackgroundJob.mock.calls[0] as unknown as [any];
    expect(params.kind).toBe(PLATE_CONSOLIDATE_KIND);
    expect(params.credRow.credId).toBe('char:c1/memory');
    expect(params.jobInput.rooms).toEqual([
      { room: 'user_room', entries: ['小明在读研'], entryIds: ['pe_user_room_0'] },
    ]);
  });

  it('记忆宫殿副 API 没配齐就不交（不拿主 API 悄悄跑后台活儿）', async () => {
    await expect(submit({ lightLLM: { baseUrl: '', apiKey: '', model: '' } })).rejects.toThrow(/副 API/);
    expect(scheduleBackgroundJob).not.toHaveBeenCalled();
  });
});

// 回归守卫：两次消化挨得近（手动连点、或者一轮聊得快）会先后交两份 job，而它们拿的是
// 同一份或相邻的旧快照。后回来那份按自己那份快照做合并，先回来那份的整理成果被整块盖掉，
// 还白烧一次 API。
describe('同一角色同时只许一份整理在飞', () => {
  const gate = () => plateCloudGate({ charId: 'c1', lightLLM: LIGHT_LLM });

  it('交出去之后这个角色的门就关上，而且不是「退回本地跑」', async () => {
    expect(await gate()).toBe('submit');
    await submit();

    expect(await gate(), '退回本地会白烧一次 API，结果还跟在飞那份互相盖').toBe('skip');
  });

  it('结果回来（记号清掉）之后照常放行', async () => {
    await submit();
    clearPlateJobInFlight('c1');

    expect(await gate()).toBe('submit');
  });

  it('交不出去（worker 认不得后台任务）是 local，不是 skip', async () => {
    probeBackgroundJobSupportDetailed.mockResolvedValue('unsupported');

    expect(await gate()).toBe('local');
  });

  it('服务端答复了「不行」→ 不留记号（确定没建成，下一轮还能再试）', async () => {
    scheduleBackgroundJob.mockRejectedValueOnce(new Error('worker 说不行'));
    await expect(submit()).rejects.toThrow();

    expect(await gate()).toBe('submit');
    expect(settleCloudApiCall, '这一笔确定没烧，调用记录别一直挂着「云端生成中」')
      .toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  // 回归守卫：请求到了服务端、答复丢在路上。事后才打记号的话这种情形一点痕迹都不留，
  // 任务照跑照扣费，本地却当它没交出去——这一轮退回本地再全量跑一遍（同一份快照烧两次
  // API、两份结果先后落地互相盖），那笔烧掉的副 API 调用也进不了「API 调用记录」。
  it('没等到答复 → 记号留着挡住下一轮，那笔调用记录也不收', async () => {
    scheduleBackgroundJob.mockRejectedValueOnce(
      Object.assign(new Error('Failed to fetch'), { [MAYBE_CREATED]: true }),
    );
    await expect(submit()).rejects.toThrow();

    expect(readPlateJobInFlightRaw('c1'), '当成「没交出去」的话，这一轮会在本地再全量跑一遍').not.toBeNull();
    expect(await gate()).toBe('skip');
    expect(settleCloudApiCall, '任务可能真在跑，别急着把这笔记成失败').not.toHaveBeenCalled();
  });

  it('那笔调用记录在发请求之前就落下（答复丢了也查得到是谁在烧 Key）', async () => {
    scheduleBackgroundJob.mockRejectedValueOnce(
      Object.assign(new Error('Failed to fetch'), { [MAYBE_CREATED]: true }),
    );
    await expect(submit()).rejects.toThrow();

    expect(recordCloudApiCall).toHaveBeenCalledWith(
      expect.objectContaining({ route: 'cloud-plate-consolidate' }),
    );
  });

  // 结果永远没回来（worker 挂了 / 任务被清了）：闸不能一直关着，那笔「云端生成中」
  // 的调用记录也不能一直转圈。
  it('超时之后放行，并把那笔挂着的调用记录收成失败', async () => {
    await submit();
    expect(await gate()).toBe('skip');

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);

    expect(await gate()).toBe('submit');
    expect(settleCloudApiCall).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false }),
    );
  });

  // 回归守卫：在飞那道门原先排在「这条路还通不通」前面，于是一份交出去再没回来的任务
  // 会让接下来半小时既不走云端、也不退回本地——整理一次都不做，而 skip 的语义本来是
  // 「云端正在替我们干这件事」。
  it('云端这条路断了（worker 认不得后台任务）→ 就算有一份在飞也退回本地', async () => {
    await submit();
    expect(await gate()).toBe('skip');

    probeBackgroundJobSupportDetailed.mockResolvedValue('unsupported');

    expect(await gate(), '路都断了还 skip 的话，这半小时门牌一次都不整理').toBe('local');
  });

  // 回归守卫：探测原先把「问不到」和「问到了、答案是不行」混成同一个 false，而它排在
  // 在飞那道门前面。于是一次代理切换、一次 CF 边缘抖动、一次 D1 冷启动超时，就能在任务
  // 还在云端跑着的时候把这一轮踢回本地——同一份快照烧两次副 API，两份结果先后落地互相盖。
  it('探测这次问不到、但手上有一份在飞 → 不许退回本地', async () => {
    await submit();
    probeBackgroundJobSupportDetailed.mockResolvedValue('unknown');

    expect(await gate(), '任务多半好好地在云端跑着，这时候退本地就是撞车').toBe('skip');
  });

  it('探测这次问不到、手上也没有在飞的 → 照常退回本地（别干等着）', async () => {
    probeBackgroundJobSupportDetailed.mockResolvedValue('unknown');

    expect(await gate()).toBe('local');
  });

  // 回归守卫：后台任务只靠 cron 捞，用户在功能总览关掉「后台任务」之后，交上去的整理一直
  // 躺着不跑，在飞记号又让接下来半小时都 skip——整个暂停期间门牌一次都不整理。
  it('后台任务（cron）暂停着 → 不交云端，在本地整理', async () => {
    getCronTriggerState.mockResolvedValue({ supported: true, enabled: false });

    expect(await gate(), '交上去也不会跑').toBe('local');
  });

  it('后台任务（cron）暂停着 → 就算有一份在飞也退回本地', async () => {
    await submit();
    getCronTriggerState.mockResolvedValue({ supported: true, enabled: false });

    expect(await gate(), '在飞那份要等恢复才跑，skip 的话门牌整个暂停期间都不更新').toBe('local');
  });

  it('问不到 cron 状态不算暂停：在飞的照旧 skip，没在飞的照旧交云端', async () => {
    getCronTriggerState.mockResolvedValue(null);
    expect(await gate()).toBe('submit');

    getCronTriggerState.mockResolvedValue({ supported: false });
    await submit();
    expect(await gate(), '一次没问到就退本地，会跟在飞那份撞车').toBe('skip');
  });
});

// 回归守卫：一条迟到的（上一份超时之后才姗姗来迟）或者被重放的（销账失败，下次上线又
// 拉回来一遍）结果，会把另一份**真正还在跑**的任务的闸打开——下一轮又交一份上去，两份
// 带着各自的旧快照先后落地互相盖，正是这道闸要防的那种重叠。
describe('结果落地时只认自己那一份在飞记号', () => {
  const gate = () => plateCloudGate({ charId: 'c1', lightLLM: LIGHT_LLM });

  it('编号对不上的结果不动闸', async () => {
    await submit();
    const jobA = lastJobId();
    clearPlateJobInFlight('c1');   // A 超时被判死
    await submit();                // 换 B 上去，记号 = B
    const jobB = lastJobId();

    await applyPlateConsolidateResult(emptyResult(jobA));

    expect(await gate(), 'B 还在跑，闸被 A 的结果打开就会再交一份 C 上去').toBe('skip');
    expect(readPlateJobInFlightRaw('c1')?.jobId).toBe(jobB);
  });

  it('编号对得上就照常放行', async () => {
    await submit();

    await applyPlateConsolidateResult(emptyResult(lastJobId()));

    expect(await gate()).toBe('submit');
  });

  // 回归守卫：闸原先在落库循环**之前**就放开了。中途某一块存不进去（IDB 配额、事务被
  // 中断）这份结果不销账、下次上线还会重放，而闸已经开着——期间的消化又交了一份新的
  // 上去，两份带着不同的旧快照先后落地互相盖，正是这道闸要防的那种重叠。
  it('落库中途炸了 → 闸不放开（这份结果还要重放）', async () => {
    await submit();
    const jobId = lastJobId();
    plateStore.saveError = new Error('IDB 配额满了');

    await expect(applyPlateConsolidateResult(twoRoomResult(jobId))).rejects.toThrow();

    expect(readPlateJobInFlightRaw('c1')?.jobId, '闸开着的话下一轮又会交一份上去').toBe(jobId);
    expect(await gate()).toBe('skip');
  });

  it('落库全部走完才放闸', async () => {
    await submit();

    await applyPlateConsolidateResult(twoRoomResult(lastJobId()));

    expect(RoomPlateDB.save).toHaveBeenCalledTimes(2);
    expect(readPlateJobInFlightRaw('c1')).toBeNull();
  });
});

// 回归守卫：结果那一支刻意跳过了补收那两天的时效窗（结果晚到本来就是常态），但跳过之后
// 没换上任何上限。服务端账本留 28 天——换设备 / 重装 PWA / 清过 localStorage 的用户第一次
// 接上账本时会把这些老结果一次性拉回来，拿一份月前的快照去改写一块早被翻过几十轮的门牌。
describe('躺太久的结果不再落地', () => {
  const daysAgo = (n: number) => Date.now() - n * 24 * 60 * 60 * 1000;

  it('超过一周的直接销账丢掉，一块门牌都不动', async () => {
    await submit();

    const acked = await applyPlateConsolidateResult(twoRoomResult(lastJobId()), { createdAt: daysAgo(8) });

    expect(acked, '留着不销的话每次上线都拉回来看一眼').toBe(true);
    expect(RoomPlateDB.save).not.toHaveBeenCalled();
  });

  it('一周之内的照常落地（关掉笔记本过个周末不算太久）', async () => {
    await submit();

    await applyPlateConsolidateResult(twoRoomResult(lastJobId()), { createdAt: daysAgo(2) });

    expect(RoomPlateDB.save).toHaveBeenCalled();
  });

  it('不带时间的（推送直达那条腿）照常落地', async () => {
    await submit();

    await applyPlateConsolidateResult(twoRoomResult(lastJobId()));

    expect(RoomPlateDB.save).toHaveBeenCalled();
  });
});

// 回归守卫：同一份结果会被送到两次以上——销账那一步失败（断网）下次上线还会拉回来，
// 推送直达那条腿收下之后压根不销账、补收时又来一遍。而落地不是幂等的：合并对每条保留
// 下来的条目 sourceCount + 1，那个数字就是门牌面板上的「印证 N 次」。
describe('同一份结果落地一次就够了', () => {
  it('重放不再动门牌（「印证 N 次」不会跟着重放虚增）', async () => {
    await submit();
    const jobId = lastJobId();

    await applyPlateConsolidateResult(twoRoomResult(jobId));
    const afterFirst = plateStore.plates.get('user_room');
    vi.mocked(RoomPlateDB.save).mockClear();

    const acked = await applyPlateConsolidateResult(twoRoomResult(jobId));

    expect(acked, '留着不销的话每次上线都重放一遍').toBe(true);
    expect(RoomPlateDB.save, '再合并一遍就是给每条 sourceCount 白加一次').not.toHaveBeenCalled();
    expect(plateStore.plates.get('user_room')).toBe(afterFirst);
  });

  // 落库中途炸掉的那一次不能记成「落过地了」：账没销、下次上线还会重放，而重放会被幂等
  // 闸挡在门外，剩下那几块门牌就再也补不上了。
  it('落库中途炸了 → 不记账，重放照样从头落一遍', async () => {
    await submit();
    const jobId = lastJobId();
    plateStore.saveError = new Error('IDB 配额满了');
    await expect(applyPlateConsolidateResult(twoRoomResult(jobId))).rejects.toThrow();

    plateStore.saveError = null;
    vi.mocked(RoomPlateDB.save).mockClear();
    await applyPlateConsolidateResult(twoRoomResult(jobId));

    expect(RoomPlateDB.save).toHaveBeenCalledTimes(2);
  });
});

// 回归守卫：删角色时清的是云端那份**输入**，而结果回来说明 LLM 早跑完了、输入那会儿已经
// 被 worker 自己删掉。不拦的话，下次上线补收会拿这份结果给一个已经不存在的角色重新建出
// 四块门牌（loadOrCreatePlate 没有就现造），里面装着那个角色蒸馏出来的全部认知——而删除
// 确认框跟用户说的是「记忆将被清空」。
describe('角色已经删掉的结果不落地', () => {
  it('角色不在了 → 销账丢掉，一块门牌都不新建', async () => {
    await submit();
    const jobId = lastJobId();
    charStore.chars = [];

    const acked = await applyPlateConsolidateResult(twoRoomResult(jobId));

    expect(acked, '留着不销的话每次上线都来试一遍').toBe(true);
    expect(RoomPlateDB.save, '存进去就是把删掉的角色的认知又长回来').not.toHaveBeenCalled();
  });

  it('角色库读不出来 → 不结论也不落地，账留着下次再来', async () => {
    await submit();
    const { DB } = await import('../db');
    vi.mocked(DB.getAllCharacters).mockRejectedValueOnce(new Error('IDB 打不开'));

    const acked = await applyPlateConsolidateResult(twoRoomResult(lastJobId()));

    expect(acked, '不知道角色还在不在的时候，宁可晚几分钟也别往库里写').toBe(false);
    expect(RoomPlateDB.save).not.toHaveBeenCalled();
  });
});

// 回归守卫：这一笔原先在落库**之前**就收成 ok 了。被丢掉的结果（太旧、内容空）在「设置
// → API 调用记录」里写着成功，而它其实白烧了一次副 API；落库中途炸掉的那次也写着成功，
// 可一条门牌都没写进去。
describe('云端那笔调用记录说的是实话', () => {
  const settledOk = () => vi.mocked(settleCloudApiCall).mock.calls.map(([c]) => c.ok);

  it('落库真的走完了才记成功', async () => {
    await submit();
    await applyPlateConsolidateResult(twoRoomResult(lastJobId()));

    expect(settledOk()).toEqual([true]);
  });

  it('躺太久被丢掉的记成失败（这一笔白烧了）', async () => {
    await submit();
    await applyPlateConsolidateResult(twoRoomResult(lastJobId()), {
      createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    });

    expect(settledOk()).toEqual([false]);
  });

  it('落库中途炸了 → 这一笔先不收（账没销，重放时再照实收）', async () => {
    await submit();
    plateStore.saveError = new Error('IDB 配额满了');

    await expect(applyPlateConsolidateResult(twoRoomResult(lastJobId()))).rejects.toThrow();

    expect(settledOk(), '记成功的话，用户会以为门牌已经更新了').toEqual([]);
  });
});

// 回归守卫：远端任务编号原先被 submitPlateConsolidation 返回之后就丢掉了，本地没有任何
// 地方记着它——删角色时想撤那条任务都找不到它是哪一行。
describe('远端任务编号要记在在飞记号上', () => {
  it('交出去之后记号上带着那条任务的 uuid', async () => {
    scheduleBackgroundJob.mockResolvedValueOnce({ uuid: 'task-uuid-7' });

    await submit();

    expect(readPlateJobInFlightRaw('c1')?.uuid).toBe('task-uuid-7');
  });

  it('没等到答复（拿不到 uuid）→ 记号照留，只是没有编号', async () => {
    scheduleBackgroundJob.mockRejectedValueOnce(
      Object.assign(new Error('Failed to fetch'), { [MAYBE_CREATED]: true }),
    );
    await expect(submit()).rejects.toThrow();

    const mark = readPlateJobInFlightRaw('c1');
    expect(mark, '记号是这种情形下唯一的痕迹').not.toBeNull();
    expect(mark?.uuid).toBeUndefined();
  });
});

// 回归守卫：「还在飞吗」原先是个**会改状态**的判断——它顺手清记号、把那笔调用记录记成
// 失败。而它在一轮整理里会被问到两次（决定交不交云端时一次、提交抛错后判断「是不是已经
// 建起来了」时一次），TTL 边界正好落在两次之间的话，第二次问会就地把闸删掉，而第一次的
// 决定是照着相反的答案做的。
describe('问「还在飞吗」不该动任何状态', () => {
  it('连问两次答案一样，也不会顺手把记号清掉', async () => {
    await submit();
    const jobId = lastJobId();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);

    const { readPlateJobInFlight } = await import('./roomPlateCloud');
    expect(readPlateJobInFlight('c1')).toBeNull();
    expect(readPlateJobInFlight('c1')).toBeNull();

    expect(readPlateJobInFlightRaw('c1')?.jobId, '判断本身不该收尾').toBe(jobId);
    expect(settleCloudApiCall).not.toHaveBeenCalled();
  });

  it('收尾是每轮开头显式跑一次（plateCloudGate）', async () => {
    await submit();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);

    expect(await plateCloudGate({ charId: 'c1', lightLLM: LIGHT_LLM })).toBe('submit');
    expect(readPlateJobInFlightRaw('c1')).toBeNull();
    expect(settleCloudApiCall).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });
});

// 用真实提交和超时清理走到记号丢失，不直接删除 localStorage 来制造缺口。
describe('迟到结果仍能找到自己的快照时间', () => {
  const startedAt = 1_800_000_000_000;

  const prepareLateResult = async () => {
    vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const original = plate('user_room', ['旧居住信息']);
    // 之前的自动整理改写过这条，但本次提交以后没有改过。
    original.entries[0].updatedAt = startedAt - 10_000;
    plateStore.plates.set('user_room', original);
    await submit({ plates: [original], snapshotAt: startedAt });
    const [params] = scheduleBackgroundJob.mock.calls.at(-1) as unknown as [any];
    const { parsePlateJobInput, buildPlateConsolidateResult } = await import('../amsgPlateJob');
    const job = parsePlateJobInput(JSON.stringify(params.jobInput))!;
    // 与 Worker 一样，先解析上传的输入，再构造返回结果。
    return buildPlateConsolidateResult({
      ...job,
      jobId: params.jobId,
      items: [{ room: 'user_room', text: '搬家后的新居住信息', basedOn: 'U0' }],
    });
  };

  it('只晚到、未触发下一轮整理时，过了 30 分钟仍可用原记号更新', async () => {
    const result = await prepareLateResult();
    delete result.snapshotAt; // 旧 Worker 没回传时间，仍应兼容本地记号。
    vi.mocked(Date.now).mockReturnValue(startedAt + 31 * 60_000);
    await applyPlateConsolidateResult(result);
    expect(plateStore.plates.get('user_room').entries[0].text).toBe('搬家后的新居住信息');
  });

  it.each([false, true])('下一轮清理过期记号后，旧结果照常更新（已提交新任务：%s）', async (submitNext) => {
    const result = await prepareLateResult();
    vi.mocked(Date.now).mockReturnValue(startedAt + 31 * 60_000);
    expect(await plateCloudGate({ charId: 'c1', lightLLM: LIGHT_LLM })).toBe('submit');
    expect(readPlateJobInFlightRaw('c1')).toBeNull();
    if (submitNext) await submit({ snapshotAt: Date.now() });
    const nextJobId = readPlateJobInFlightRaw('c1')?.jobId;

    await applyPlateConsolidateResult(result);

    expect(plateStore.plates.get('user_room').entries[0].text).toBe('搬家后的新居住信息');
    expect(readPlateJobInFlightRaw('c1')?.jobId).toBe(nextJobId);
  });

  it('记号过期以后，提交后真实发生的编辑仍然保留', async () => {
    const result = await prepareLateResult();
    const current = plateStore.plates.get('user_room');
    current.entries[0].text = '提交后用户纠正的居住信息';
    current.entries[0].updatedAt = startedAt + 60_000;
    vi.mocked(Date.now).mockReturnValue(startedAt + 31 * 60_000);
    await plateCloudGate({ charId: 'c1', lightLLM: LIGHT_LLM });

    await applyPlateConsolidateResult(result);

    expect(plateStore.plates.get('user_room').entries[0].text).toBe('提交后用户纠正的居住信息');
  });

  it('旧结果和本地记号都没有快照时间时，不猜测时间或放开编辑保护', async () => {
    const result = await prepareLateResult();
    delete result.snapshotAt;
    vi.mocked(Date.now).mockReturnValue(startedAt + 31 * 60_000);
    await plateCloudGate({ charId: 'c1', lightLLM: LIGHT_LLM });

    await applyPlateConsolidateResult(result);

    expect(plateStore.plates.get('user_room').entries[0].text).toBe('旧居住信息');
  });
});
