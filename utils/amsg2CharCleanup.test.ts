// utils/amsg2CharCleanup.test.ts
// 回归守卫：删角色时那份云端 client_state 必须跟着清掉。
//
// 实测漏过一次：删掉一个测试角色之后，D1 里仍然留着 `amsg:char:<id>/fire_pack`（32KB）
// 和 `tool_pack`。fire_pack 里是完整角色系统提示词 + 最近 30 条对话原文，而删除确认框
// 跟用户说的是「记忆将被清空」——留着就是把聊天记录晾在云端。
//
// 同时钉住几条边界，别为了清得干净把删角色搞坏：
//   1. 从没打开过 2.0 面板的角色（activeMsg2Config 缺失）也要清——全局即时对话开着时
//      它每轮聊天都在往云端写完整对话，按「配没配过」猜就是把聊天原文永久留在 D1 里；
//   2. 压根没填 worker 地址时不发（云端从来没写过东西，报「清理失败」是吓唬人）；
//   3. 清不掉（断网 / worker 挂了）只回报结果，绝不抛错阻塞删除。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: {
    clearCharClientState: vi.fn(),
    deleteLlmCredentials: vi.fn(async () => undefined),
    clearClientStateValue: vi.fn(async () => undefined),
    cancelTask: vi.fn(async (uuid: string) => ({ uuid, alreadyGone: false })),
  },
}));

let workerUrl = 'https://amsg.example.workers.dev';
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { getGlobalConfig: async () => ({ workerUrl }) },
}));

const { inFlight } = vi.hoisted(() => ({
  inFlight: { current: null as { jobId: string; at: number; snapshotAt: number; uuid?: string } | null },
}));
vi.mock('./memoryPalace/roomPlateCloud', () => ({
  readPlateJobInFlightRaw: vi.fn(() => inFlight.current),
  clearPlateJobInFlight: vi.fn(),
  clearPlateJobDone: vi.fn(),
}));
vi.mock('./apiCallLog', () => ({
  cloudApiCallLogId: (id: string) => `cloud-${id}`,
  settleCloudApiCall: vi.fn(),
}));

import { charMayHaveCloudState, disableScheduleCharPurge, purgeCharCloudState } from './amsg2CharCleanup';
import { ActiveMsgClient } from './activeMsgClient';
import { settleCloudApiCall } from './apiCallLog';
import type { CharacterProfile } from '../types';

const charWith = (
  config: CharacterProfile['activeMsg2Config'],
): CharacterProfile => ({ id: 'char-1', name: '测试角色', activeMsg2Config: config } as CharacterProfile);

const clearMock = () => ActiveMsgClient.clearCharClientState as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  workerUrl = 'https://amsg.example.workers.dev';
  inFlight.current = null;
  vi.mocked(settleCloudApiCall).mockClear();
  vi.mocked(ActiveMsgClient.cancelTask).mockClear();
  vi.mocked(ActiveMsgClient.clearClientStateValue).mockClear();
  vi.mocked(ActiveMsgClient.deleteLlmCredentials).mockClear();
  clearMock().mockReset();
  clearMock().mockResolvedValue(['fire_pack', 'tool_pack']);
});

describe('purgeCharCloudState', () => {
  it('配过 amsg2 的角色 → 按角色 id 清云端', async () => {
    const result = await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));
    expect(clearMock()).toHaveBeenCalledWith('char-1');
    expect(result).toEqual({ status: 'cleared', keys: ['fire_pack', 'tool_pack'] });
  });

  it('没有待触发任务了也照清（fire_pack 按角色存，任务发完它还在云端）', async () => {
    await purgeCharCloudState(charWith({ enabled: true }));
    expect(clearMock()).toHaveBeenCalledTimes(1);
  });

  it('用户关掉了 2.0 也照清（关闭只取消任务，不清云端那份上下文）', async () => {
    await purgeCharCloudState(charWith({ enabled: false }));
    expect(clearMock()).toHaveBeenCalledTimes(1);
  });

  // Bug 回归守卫：全局即时对话开着时，从没打开过 2.0 面板的角色（activeMsg2Config
  // 缺失、跟随全局默认开）每轮聊天都会经 POST /instant-chat 把完整对话写进云端
  // client_state。以前这里看「配没配过」直接 skip，一个清理请求都不发——该角色的
  // 聊天原文（含图片 base64）就永久留在 D1 里，删除确认框「记忆将被清空」落空。
  it('从没配过 amsg2 的角色 → 只要 worker 配置在就照清（即时对话可能写过云端）', async () => {
    const result = await purgeCharCloudState({ id: 'char-2', name: '路人' } as CharacterProfile);
    expect(clearMock()).toHaveBeenCalledWith('char-2');
    expect(result).toEqual({ status: 'cleared', keys: ['fire_pack', 'tool_pack'] });
  });

  it('角色本身找不到（并发删两次）→ 同样不发请求', async () => {
    const result = await purgeCharCloudState(undefined);
    expect(clearMock()).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'skipped' });
  });

  // 「压根没配 worker 连接」是唯一的 skip 理由：没有地址就没有云端，一个字节都没写过。
  it('没填 worker 地址 → 跳过，不发请求也不报失败（云端压根没写过东西）', async () => {
    workerUrl = '';
    const result = await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));
    expect(clearMock()).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'skipped' });
  });

  it('worker 地址只有空白字符 → 同样跳过', async () => {
    workerUrl = '   ';
    await expect(purgeCharCloudState(charWith({ enabled: true })))
      .resolves.toEqual({ status: 'skipped' });
    expect(clearMock()).not.toHaveBeenCalled();
  });

  it('没配过 2.0 的角色 + 全局也没配 worker → 才是真的没云端，跳过', async () => {
    workerUrl = '';
    const result = await purgeCharCloudState({ id: 'char-3', name: '路人乙' } as CharacterProfile);
    expect(clearMock()).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'skipped' });
  });

  it('清不掉（断网 / worker 挂了）→ 不抛错，把失败交给调用方提示', async () => {
    const boom = new Error('worker down');
    clearMock().mockRejectedValue(boom);

    const result = await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));
    expect(result).toEqual({ status: 'failed', error: boom });
  });

  // 回归守卫：删角色会把在飞记号清掉，而那个记号是本地唯一记着 job 编号的地方。清完就
  // 没人再去收「设置 → API 调用记录」里那笔「云端生成中」——它会一直转圈到 5 天后被裁掉，
  // 用户分不清是还在跑还是早就没了。在飞记号超时那条路特意绕开的就是这个坑。
  it('删角色时把那笔挂着的「云端生成中」收成失败', async () => {
    inFlight.current = { jobId: 'job-9', at: 1, snapshotAt: 1 };

    await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));

    expect(settleCloudApiCall).toHaveBeenCalledWith({ id: 'cloud-job-9', ok: false });
  });

  it('没有在飞的整理就不多收一笔', async () => {
    await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));

    expect(settleCloudApiCall).not.toHaveBeenCalled();
  });

  // 回归守卫：原先只撤输入、不动任务行。任务到点照样起跑、照着重试梯子重来几轮（读到
  // 空值会安静跳过，但每一轮都是一次调度），而它已经没有任何落脚点了。远端任务编号原先
  // 压根没往本地记，所以想撤也撤不了。
  it('在飞那份的远端任务要真的取消掉，不只是撤输入', async () => {
    inFlight.current = { jobId: 'job-9', at: 1, snapshotAt: 1, uuid: 'task-uuid-9' };

    await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));

    expect(ActiveMsgClient.cancelTask).toHaveBeenCalledWith('task-uuid-9');
    expect(ActiveMsgClient.clearClientStateValue).toHaveBeenCalled();
  });

  it('取消任务失败（远端挂了）→ 输入照撤，也不拦着角色删掉', async () => {
    inFlight.current = { jobId: 'job-9', at: 1, snapshotAt: 1, uuid: 'task-uuid-9' };
    vi.mocked(ActiveMsgClient.cancelTask).mockRejectedValueOnce(new Error('worker down'));

    const result = await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));

    expect(ActiveMsgClient.clearClientStateValue).toHaveBeenCalled();
    expect(result.status).toBe('cleared');
  });

  // 提交的答复丢在路上时拿不到远端编号（任务可能建了、编号却没回来）。那种只能等它自己
  // 跑完——读到空输入会安静跳过。别为了取消它去猜一个 uuid。
  it('没记下远端编号的（答复丢了）→ 不取消，输入照撤', async () => {
    inFlight.current = { jobId: 'job-9', at: 1, snapshotAt: 1 };

    await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));

    expect(ActiveMsgClient.cancelTask).not.toHaveBeenCalled();
    expect(ActiveMsgClient.clearClientStateValue).toHaveBeenCalled();
  });

  it('云端本来就是空的 → cleared + 空清单（不是失败）', async () => {
    clearMock().mockResolvedValue([]);
    await expect(purgeCharCloudState(charWith({ enabled: true })))
      .resolves.toEqual({ status: 'cleared', keys: [] });
  });

  it('默认走全量清单：每种用途的凭据全删（含云端生成那三行）、在飞的门牌整理也撤', async () => {
    inFlight.current = { jobId: 'job-1', at: Date.now(), snapshotAt: Date.now(), uuid: 'u-plate' };
    await purgeCharCloudState(charWith({ enabled: true }));

    expect(ActiveMsgClient.deleteLlmCredentials).toHaveBeenCalledWith({
      credIds: [
        'char:char-1/chat', 'char:char-1/instant', 'char:char-1/emotion', 'char:char-1/memory',
        'char:char-1/gen-schedule', 'char:char-1/gen-persona-sim', 'char:char-1/gen-dream',
      ],
    });
    expect(ActiveMsgClient.cancelTask).toHaveBeenCalledWith('u-plate');
  });
});

// 关掉定时主动消息 ≠ 删角色：即时对话和记忆宫殿的后台活儿可能还活着，照删角色那套
// 清一遍，清掉的是别人正在用的东西。这一组钉的就是两份清单的分界。
describe('关掉定时主动消息时的清单', () => {
  it('即时对话已经不生效：连上下文一起清，但记忆宫殿那行凭据和在飞的后台活儿不碰', async () => {
    inFlight.current = { jobId: 'job-1', at: Date.now(), snapshotAt: Date.now(), uuid: 'u-plate' };

    const result = await purgeCharCloudState(
      charWith({ enabled: false }),
      disableScheduleCharPurge(false),
    );

    expect(clearMock()).toHaveBeenCalledWith('char-1');
    expect(ActiveMsgClient.deleteLlmCredentials).toHaveBeenCalledWith({
      credIds: ['char:char-1/chat', 'char:char-1/instant', 'char:char-1/emotion'],
    });
    // 门牌整理跟主动消息是两条独立的路，关掉这个不该把那个也弄停。
    expect(ActiveMsgClient.cancelTask).not.toHaveBeenCalled();
    expect(result.status).toBe('cleared');
  });

  it('即时对话还开着：上下文是活的（每轮聊天都会重写），只收掉定时任务那行凭据', async () => {
    await purgeCharCloudState(charWith({ enabled: false }), disableScheduleCharPurge(true));

    expect(clearMock()).not.toHaveBeenCalled();
    expect(ActiveMsgClient.deleteLlmCredentials).toHaveBeenCalledWith({
      credIds: ['char:char-1/chat'],
    });
  });

  it('没填 worker 地址时照样一个请求都不发', async () => {
    workerUrl = '';
    const result = await purgeCharCloudState(charWith({ enabled: false }), disableScheduleCharPurge(false));

    expect(result).toEqual({ status: 'skipped' });
    expect(ActiveMsgClient.deleteLlmCredentials).not.toHaveBeenCalled();
  });
});

describe('charMayHaveCloudState', () => {
  // 不做按角色的 capability 预检：即时对话会替「从没配过 2.0」的角色写云端，
  // 猜漏一条写入路就是漏清。角色在就当可能有，真正的门是「配没配 worker 连接」。
  it('角色存在就当可能有云端数据（不看 activeMsg2Config）', () => {
    expect(charMayHaveCloudState(charWith({ enabled: true }))).toBe(true);
    expect(charMayHaveCloudState(charWith({ enabled: false }))).toBe(true);
    expect(charMayHaveCloudState({ id: 'x', name: 'x' } as CharacterProfile)).toBe(true);
    expect(charMayHaveCloudState(undefined)).toBe(false);
  });
});

// 云端生成的输入住在共用的 amsg:cloud-gen 下，角色命名空间那趟清不到它，装的却是整份上下文。
describe('删角色时撤掉在飞的云端生成', () => {
  const running = () => ({
    jobId: 'gen-1', purpose: 'persona-sim' as const, charId: 'char-1', charName: '测试角色', uuid: 'u-gen',
    submittedAt: Date.now(), snapshotAt: Date.now(), status: 'running' as const, notify: true, context: null,
  });

  it('全量清单：取消任务、撤输入、本机登记一并删掉', async () => {
    const { putCloudGenJob, listCloudGenJobs } = await import('./cloudGen/registry');
    localStorage.clear();
    putCloudGenJob(running());
    await purgeCharCloudState(charWith({ enabled: true }));

    expect(ActiveMsgClient.cancelTask).toHaveBeenCalledWith('u-gen');
    expect(ActiveMsgClient.clearClientStateValue).toHaveBeenCalledWith('amsg:cloud-gen', 'gen:gen-1');
    expect(listCloudGenJobs()).toEqual([]);
  });

  it('只关掉定时主动消息时不碰', async () => {
    const { putCloudGenJob, listCloudGenJobs } = await import('./cloudGen/registry');
    localStorage.clear();
    putCloudGenJob(running());
    await purgeCharCloudState(charWith({ enabled: false }), disableScheduleCharPurge(false));

    expect(ActiveMsgClient.cancelTask).not.toHaveBeenCalled();
    expect(listCloudGenJobs()).toHaveLength(1);
  });
});
