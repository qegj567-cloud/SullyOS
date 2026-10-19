// utils/amsgStateSync.test.ts
// 编排层守卫：打脏 → 立即批量冲刷 → 失败退避重传，以及活跃会话租约的起停。
// 关键取舍：云端那份 fire_pack 是角色到点时唯一的上下文来源，传不上去就意味着它带着
// 旧上下文发消息，所以失败的快照必须留在队列里等重传（早期实现发请求前就清空队列，
// 一次网络抖动那份快照就永远没了）。同时也不能变成无限重排，两头都钉住。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: {
    syncCharFirePacks: vi.fn().mockResolvedValue(undefined),
    syncChatPresence: vi.fn().mockResolvedValue(undefined),
    syncToolConfig: vi.fn().mockResolvedValue(undefined),
    listAllTasks: vi.fn().mockResolvedValue([]),
    cancelTask: vi.fn().mockResolvedValue({ uuid: '', alreadyGone: false }),
    clearClientState: vi.fn().mockResolvedValue({ deleted: 0, toolConfigRestored: true }),
    registerPushSubscription: vi.fn().mockResolvedValue(undefined),
    deleteRemotePushSubscription: vi.fn().mockResolvedValue(undefined),
    refreshApiCredentialsForPendingTasks: vi.fn().mockResolvedValue({ status: 'ok', updated: 0, failed: 0 }),
    putLlmCredentials: vi.fn().mockResolvedValue(0),
    deleteLlmCredentials: vi.fn().mockResolvedValue(0),
  },
  // 凭据引用那条路的版本门槛。默认关着，只有专门测它的用例才打开。
  isLlmCredentialsReady: vi.fn().mockResolvedValue(false),
  // 「欠着即时对话回复」的判定本体住在 activeMsgClient（排程那条路写 fire_pack 前问的
  // 是同一个）。整个 client 在这儿被换成了假的，所以照它的定义把两个原始信号接回来，
  // 用例照旧拿 setInstantChatPending 驱动。判定本身怎么写由 activeMsgClient.test.ts 钉，
  // 这里钉的是「冲刷之前会去问它」。
  // 工厂比 import 先跑，这两个 binding 那会儿还没初始化——所以只能在调用时才解引用。
  owesInstantChatReply: (charId: string) =>
    !!getInstantChatPending(charId) || isInstantChatSendInFlight(charId),
}));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { getGlobalConfig: vi.fn() },
}));

import {
  discardAmsgPendingState,
  FLUSH_DEBOUNCE_MS,
  AMSG2_PENDING_SYNC_LS_KEY,
  AMSG2_PENDING_CRED_SYNC_LS_KEY,
  AMSG2_PENDING_TOOL_CONFIG_LS_KEY,
  cancelAllRemoteAmsgTasks,
  wipeAmsgCloudData,
  wipeAmsgCloudDataForReset,
  flushAmsgState,
  isWorkerUrlCleared,
  markAmsgStateDirty,
  resumePendingAmsgStateSync,
  startAmsgChatPresence,
  stopAmsgChatPresence,
  syncAmsgLlmCredentials,
  syncAmsgToolConfig,
} from './amsgStateSync';
import {
  buildCharChatCredRow,
  forgetAllCredIds,
  rememberCredRows,
} from './amsgLlmCredentials';
import { DB } from './db';
import { ActiveMsgClient, isLlmCredentialsReady } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { CHAT_PRESENCE_HEARTBEAT_MS } from './amsgChatPresence';
import {
  AMSG_INSTANT_CHAT_PENDING_LS_KEY,
  clearInstantChatPending,
  getInstantChatPending,
  isInstantChatSendInFlight,
  setInstantChatPending,
} from './amsgInstantChat';
import type { CharacterProfile } from '../types';

const H = 3600_000;
/**
 * 「一个请求都不该发出」那类用例的观察窗。
 * 特意开到一级退避（30s）之外：不光要看当场没发，连「过一会儿才冒出来」的延迟请求
 * 也一并算漏。假时钟推的，等多久都不花真时间。
 */
const IDLE_WINDOW_MS = 31_000;

/** 带一个「待触发的 auto 任务」的角色 —— 过同步门的最小形态。 */
const charWithAiTask = (id: string): CharacterProfile => ({
  id, name: id,
  activeMsg2Config: {
    enabled: true,
    tasks: [{
      taskUuid: `${id}-uuid`, mode: 'auto',
      firstSendTime: new Date(Date.now() + H).toISOString(),
      recurrenceType: 'none', source: 'character', status: 'scheduled', createdAt: Date.now(),
    }],
  },
} as unknown as CharacterProfile);

const snapshotOf = (char: CharacterProfile) => ({
  char, userProfile: {} as any, groups: [], realtimeConfig: undefined,
});

let charSeq = 0;
/** 每个用例用独立 charId：模块级 dirty Map 跨用例存活，同 id 会互相干扰。 */
const nextCharId = () => `char-${++charSeq}`;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.removeItem(AMSG2_PENDING_SYNC_LS_KEY);
  localStorage.removeItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY);
  localStorage.removeItem('amsg2_pending_tool_config_version');
  localStorage.removeItem(AMSG2_PENDING_CRED_SYNC_LS_KEY);
  localStorage.removeItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY);
  forgetAllCredIds();
  (ActiveMsgClient.syncCharFirePacks as any).mockClear();
  (ActiveMsgClient.syncChatPresence as any).mockClear();
  (ActiveMsgClient.syncToolConfig as any).mockReset();
  (ActiveMsgClient.syncToolConfig as any).mockResolvedValue(undefined);
  (ActiveMsgClient.listAllTasks as any).mockReset();
  (ActiveMsgClient.listAllTasks as any).mockResolvedValue([]);
  (ActiveMsgClient.cancelTask as any).mockReset();
  (ActiveMsgClient.cancelTask as any).mockResolvedValue({ uuid: '', alreadyGone: false });
  (ActiveMsgClient.clearClientState as any).mockReset();
  (ActiveMsgClient.clearClientState as any).mockResolvedValue({ deleted: 0, toolConfigRestored: true });
  (ActiveMsgClient.registerPushSubscription as any).mockReset();
  (ActiveMsgClient.registerPushSubscription as any).mockResolvedValue(undefined);
  (ActiveMsgClient.deleteRemotePushSubscription as any).mockReset();
  (ActiveMsgClient.deleteRemotePushSubscription as any).mockResolvedValue(undefined);
  vi.mocked(ActiveMsgClient.refreshApiCredentialsForPendingTasks).mockReset().mockResolvedValue({ status: 'ok', updated: 0, failed: 0 });
  (ActiveMsgClient.putLlmCredentials as any).mockReset();
  (ActiveMsgClient.putLlmCredentials as any).mockResolvedValue(0);
  (ActiveMsgClient.deleteLlmCredentials as any).mockReset();
  (ActiveMsgClient.deleteLlmCredentials as any).mockResolvedValue(0);
  (isLlmCredentialsReady as any).mockReset();
  (isLlmCredentialsReady as any).mockResolvedValue(false);
  (ActiveMsgStore.getGlobalConfig as any).mockReset();
  (ActiveMsgStore.getGlobalConfig as any).mockResolvedValue({ workerUrl: 'https://amsg.example.dev' });
});
afterEach(async () => {
  // 待传队列和退避计数都是模块级的：失败用例会留下快照 + 一个重排 timer，
  // 不清干净会串进下一个用例的批次里（batch 长度、退避时长都会对不上）。
  // tool_config 的欠账同理，冲刷会顺手把它带走。
  // 先 mockReset 再给默认实现：用例里排的 xxxOnce 如果没被消费掉（比如那几个手动
  // release 的挂起 Promise 碰上用例中途失败），会被下面这次收尾冲刷领走然后一直挂着。
  // 现有用例都自己消费干净了，这行是给以后写的人留的保险。
  (ActiveMsgClient.syncCharFirePacks as any).mockReset();
  (ActiveMsgClient.syncCharFirePacks as any).mockResolvedValue(undefined);
  (ActiveMsgClient.syncToolConfig as any).mockResolvedValue(undefined);
  // 跑两轮：第一轮冲刷可能触发补跑（flushing 期间又打脏那条路），第二轮把补跑落下的收干净。
  await flushAmsgState('cleanup');
  await vi.advanceTimersByTimeAsync(1);
  await flushAmsgState('cleanup');
  await vi.advanceTimersByTimeAsync(1);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('markAmsgStateDirty 同步门', () => {
  it('没有待触发 AI 任务的角色直接忽略（零成本，不排 timer 不发请求）', async () => {
    const plain = { id: nextCharId(), name: 'x' } as unknown as CharacterProfile;
    markAmsgStateDirty(snapshotOf(plain));
    await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
  });

  it('只有 fixed 任务也忽略（fixed 不需要 fire_pack）', async () => {
    const id = nextCharId();
    const fixedOnly = {
      id, name: id,
      activeMsg2Config: {
        enabled: true,
        tasks: [{
          taskUuid: `${id}-uuid`, mode: 'fixed',
          firstSendTime: new Date(Date.now() + H).toISOString(),
          recurrenceType: 'none', source: 'user', status: 'scheduled', createdAt: Date.now(),
        }],
      },
    } as unknown as CharacterProfile;
    markAmsgStateDirty(snapshotOf(fixedOnly));
    await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
  });

  it('enabled=false 忽略', async () => {
    const char = charWithAiTask(nextCharId());
    (char.activeMsg2Config as any).enabled = false;
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
  });

  it('没配 workerUrl → 清空脏标记且不发请求', async () => {
    (ActiveMsgStore.getGlobalConfig as any).mockResolvedValue({ workerUrl: '' });
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
    // 没有去处不算「欠着」：底账也一起清，别让下次启动为它白跑一趟补传。
    expect(JSON.parse(localStorage.getItem(AMSG2_PENDING_SYNC_LS_KEY) || '[]')).not.toContain(char.id);
  });

  it('冲刷失败 → 快照留在队列里，下次冲刷把同一个角色重传', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('worker down'));
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    await flushAmsgState('test-retry');
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(2);
    const retried = (ActiveMsgClient.syncCharFirePacks as any).mock.calls[1][0];
    expect(retried.map((i: any) => i.char.id)).toEqual([char.id]);
  });

  it('失败后自动退避重排（30s），不用干等下一轮聊天', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('worker down'));
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(2);
  });

  it('重排期间又聊了一轮 → 传新快照，别被回队的旧快照盖回去', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('worker down'));
    const id = nextCharId();
    const stale = charWithAiTask(id);
    stale.name = '旧快照';
    markAmsgStateDirty(snapshotOf(stale));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    const fresh = charWithAiTask(id);
    fresh.name = '新快照';
    markAmsgStateDirty(snapshotOf(fresh));
    await flushAmsgState('test-retry');

    const retried = (ActiveMsgClient.syncCharFirePacks as any).mock.calls[1][0];
    expect(retried).toHaveLength(1);
    expect(retried[0].char.name).toBe('新快照');
  });

  it('连续失败到上限后停止重排（离线时不无限排 timer）', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValue(new Error('offline'));
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    // 30s → 60s → 120s 三次重排后放手（快照仍留在队列里等下一轮打脏）
    await vi.advanceTimersByTimeAsync(30_000 + 60_000 + 120_000 + 1_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(4);
  });
});

// 打脏合并窗口回归守卫：一轮聊天的多次打脏（收尾 / 情绪落库 / 记忆写入）不在同一个
// tick，各自触发完整冲刷太贵（重读近史 + 重建提示词 + 加密 + PUT ~40KB）。第一次打脏起
// FLUSH_DEBOUNCE_MS 内的合并成一次上传；固定窗口不顺延，持续打脏也保证窗口到点必冲。
// 数据丢失窗口没有回退：底账在打脏那一刻就写、切后台立即冲刷、启动有补传。
describe('打脏合并窗口', () => {
  it('窗口内不发请求，窗口到点冲刷一次', async () => {
    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS - 1);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
  });

  it('窗口内的连环打脏（隔几个 tick 也算）只合并成一次上传', async () => {
    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));
    // 情绪 buff 落库这类晚半秒才来的打脏，也该并进同一次上传
    await vi.advanceTimersByTimeAsync(500);
    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    expect((ActiveMsgClient.syncCharFirePacks as any).mock.calls[0][0]).toHaveLength(2);
  });

  it('同一个角色窗口内打两次脏只传最新那份', async () => {
    const id = nextCharId();
    const stale = charWithAiTask(id);
    stale.name = '旧快照';
    const fresh = charWithAiTask(id);
    fresh.name = '新快照';

    markAmsgStateDirty(snapshotOf(stale));
    markAmsgStateDirty(snapshotOf(fresh));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    const batch = (ActiveMsgClient.syncCharFirePacks as any).mock.calls[0][0];
    expect(batch).toHaveLength(1);
    expect(batch[0].char.name).toBe('新快照');
  });

  it('冲刷进行中再打脏，冲刷完成后自动补跑一次（不搁浅）', async () => {
    // 旧的丢弃式防重入（if (flushing) return）下这条会挂：第二份快照
    // 会一直躺在队列里，等不到任何人来传。
    let release!: () => void;
    (ActiveMsgClient.syncCharFirePacks as any).mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);   // 第一次冲刷挂起中

    const later = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(later));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);   // 撞上 flushing
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(2);
    expect((ActiveMsgClient.syncCharFirePacks as any).mock.calls[1][0].map((s: any) => s.char.id))
      .toEqual([later.id]);
  });

  it('这次冲刷失败时不立刻补跑，交给退避重传（补跑不许白吃退避额度）', async () => {
    let fail!: () => void;
    (ActiveMsgClient.syncCharFirePacks as any).mockImplementationOnce(
      () => new Promise<void>((_, reject) => { fail = () => reject(new Error('worker down')); }),
    );
    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));  // 在飞期间又打脏
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    fail();
    await vi.advanceTimersByTimeAsync(0);
    // 立刻补跑只会当场重蹈覆辙；退避重传本来就会带上队列里的全部快照（含刚打脏那份）
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(2);
    expect((ActiveMsgClient.syncCharFirePacks as any).mock.calls[1][0]).toHaveLength(2);
  });

  it('退避打光那次冲刷里打的脏，当场补跑并重开一轮退避', async () => {
    const mock = ActiveMsgClient.syncCharFirePacks as any;
    // 前三次直接失败，把 30 / 60 / 120 三级退避走完；第四次（额度已经用光那次）挂在
    // 半空，好在它还在飞的时候打一次脏；第五次是补跑，也让它失败，用来验退避从头重开。
    mock.mockRejectedValueOnce(new Error('offline'));
    mock.mockRejectedValueOnce(new Error('offline'));
    mock.mockRejectedValueOnce(new Error('offline'));
    let failLast!: () => void;
    mock.mockImplementationOnce(
      () => new Promise<void>((_, reject) => { failLast = () => reject(new Error('offline')); }),
    );
    mock.mockRejectedValueOnce(new Error('offline'));

    const doomed = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(doomed));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(30_000 + 60_000 + 120_000 + 1_000);
    expect(mock).toHaveBeenCalledTimes(4);           // 第四次挂在半空

    const later = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(later));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(mock).toHaveBeenCalledTimes(4);           // 撞上 flushing，先记账

    failLast();
    await vi.advanceTimersByTimeAsync(0);
    // 退避打光那条路不留 timer，没有别人会来接手 → 这次必须当场补跑，
    // 并把欠着的两份（回队的旧账 + 刚打的新脏）一起带上。
    expect(mock).toHaveBeenCalledTimes(5);
    expect(mock.mock.calls[4][0].map((s: any) => s.char.id).sort())
      .toEqual([doomed.id, later.id].sort());

    // 补跑再失败的话退避从 30s 重新起步：既不是接着上一轮的 120s，也不是从此没人再试。
    await vi.advanceTimersByTimeAsync(29_000);
    expect(mock).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(mock).toHaveBeenCalledTimes(6);
  });
});

// 欠着即时对话回复的角色，fire_pack 挂起不传：那一轮的包是 POST /instant-chat 带上去
// 的、多一段 chat（worker 到点全靠它），常规重建的包没有 chat 段，覆盖上去 worker 到点
// 只会硬失败。回归守卫：没有这层挂起时，等回复期间任何一次打脏（改人设 / 群聊 / 表情库
// 变更）都会把用户正等着的那条回复变成「fire_pack 里没有 chat 段」。
describe('即时对话挂起（chat 段不许被常规冲刷覆盖）', () => {
  it('欠着回复的角色这次不传；销账后回看那一跳把欠的传掉', async () => {
    const char = charWithAiTask(nextCharId());
    setInstantChatPending(char.id, 'uuid-instant-defer');
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(ActiveMsgClient.syncCharFirePacks, '等回复期间一个包都不许传').not.toHaveBeenCalled();

    clearInstantChatPending(char.id);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    expect((ActiveMsgClient.syncCharFirePacks as any).mock.calls[0][0].map((s: any) => s.char.id))
      .toEqual([char.id]);
  });

  it('同批里没欠着的照传，欠着的不搭车', async () => {
    const owing = charWithAiTask(nextCharId());
    const free = charWithAiTask(nextCharId());
    setInstantChatPending(owing.id, 'uuid-instant-owing');
    markAmsgStateDirty(snapshotOf(owing));
    markAmsgStateDirty(snapshotOf(free));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    const mock = ActiveMsgClient.syncCharFirePacks as any;
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0].map((s: any) => s.char.id)).toEqual([free.id]);

    // 收尾：销账并让回看把欠的传掉，别把挂起的快照留给下一个用例。
    clearInstantChatPending(owing.id);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[1][0].map((s: any) => s.char.id)).toEqual([owing.id]);
  });
});

// 脏标记轻量持久化：localStorage 只存 charId 底账（快照本体启动时从 DB 重建）。
// 回归守卫：没有这层持久化时，「打脏 → 请求还没落地就被杀进程」那份快照就永远丢了。
describe('脏标记持久化与启动补传', () => {
  const readMarks = (): string[] =>
    JSON.parse(localStorage.getItem(AMSG2_PENDING_SYNC_LS_KEY) || '[]');

  it('打脏写入底账，上传成功后移除', async () => {
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    expect(readMarks()).toContain(char.id);

    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    expect(readMarks()).not.toContain(char.id);
  });

  it('过不了同步门的角色不写底账', async () => {
    const plain = { id: nextCharId(), name: 'x' } as unknown as CharacterProfile;
    markAmsgStateDirty(snapshotOf(plain));
    expect(readMarks()).not.toContain(plain.id);
  });

  it('上传失败底账保留，等重试 / 下次启动补传', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('worker down'));
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    expect(readMarks()).toContain(char.id);
  });

  it('杀进程模拟：直接构造底账残留 → 启动补传立即重建上传并清底账', async () => {
    // 上次会话只留下 charId（内存队列已随进程蒸发），启动时用 DB 读回的角色重建快照。
    const char = charWithAiTask(nextCharId());
    localStorage.setItem(AMSG2_PENDING_SYNC_LS_KEY, JSON.stringify([char.id]));

    resumePendingAmsgStateSync({ characters: [char], userProfile: {} as any, groups: [] });
    await vi.advanceTimersByTimeAsync(1); // 补传当场发，advance 只为让异步体落地

    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    const batch = (ActiveMsgClient.syncCharFirePacks as any).mock.calls[0][0];
    expect(batch.map((i: any) => i.char.id)).toEqual([char.id]);
    expect(readMarks()).not.toContain(char.id);
  });

  it('残留角色已删除 / 已关 2.0 → 静默清除底账，不发请求', async () => {
    const disabled = charWithAiTask(nextCharId());
    (disabled.activeMsg2Config as any).enabled = false;
    localStorage.setItem(AMSG2_PENDING_SYNC_LS_KEY, JSON.stringify(['ghost-已删除', disabled.id]));

    resumePendingAmsgStateSync({ characters: [disabled], userProfile: {} as any, groups: [] });
    await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);

    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
    expect(readMarks()).toEqual([]);
  });

  it('补传失败底账不丢：留给退避重试 / 再下次启动', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('offline'));
    const char = charWithAiTask(nextCharId());
    localStorage.setItem(AMSG2_PENDING_SYNC_LS_KEY, JSON.stringify([char.id]));

    resumePendingAmsgStateSync({ characters: [char], userProfile: {} as any, groups: [] });
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    expect(readMarks()).toContain(char.id);
  });
});

// 回归守卫：tool_config（搜索/Notion/飞书/MCP 凭据、代理地址）以前是「单发即忘」——
// 一句 `.catch(() => {})` 就没了，也没有底账。它又不像 fire_pack 那样每轮聊天重传，
// 传丢一次云端就永远是旧的：用户删掉的 MCP 服务器，worker 半夜照旧带着旧 token 直连。
describe('工具凭据（tool_config）的重试与底账', () => {
  const readMark = () => localStorage.getItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY);
  const config = { weatherEnabled: true } as any;

  it('传成功 → 只发一次请求，底账清空', async () => {
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(1);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledWith(config, expect.objectContaining({ updatedAt: expect.any(Number) }));
    expect(readMark()).toBeNull();
  });

  it('传失败 → 底账留存，退避 30s 后自动重传，成功即清账', async () => {
    (ActiveMsgClient.syncToolConfig as any).mockRejectedValueOnce(new Error('worker down'));
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(1);
    expect(readMark()).toBe('1');

    await vi.advanceTimersByTimeAsync(30_000 + 100);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(2);
    expect(readMark()).toBeNull();
  });

  it('退避打光仍失败 → 底账不丢，下次冲刷接着补', async () => {
    (ActiveMsgClient.syncToolConfig as any).mockRejectedValue(new Error('offline'));
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(30_000 + 60_000 + 120_000 + 1_000);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(4);
    expect(readMark()).toBe('1');

    // 网络回来了：下一次 fire_pack 冲刷顺手把它带上去
    (ActiveMsgClient.syncToolConfig as any).mockResolvedValue(undefined);
    await flushAmsgState('test');
    await vi.advanceTimersByTimeAsync(1);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(5);
    expect(readMark()).toBeNull();
  });

  it('没配 workerUrl → 不发请求，底账也不留（没有去处不算欠着）', async () => {
    (ActiveMsgStore.getGlobalConfig as any).mockResolvedValue({ workerUrl: '' });
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncToolConfig).not.toHaveBeenCalled();
    expect(readMark()).toBeNull();
  });

  it('杀进程模拟：底账残留 → 启动补传用当前配置传一次并清账', async () => {
    localStorage.setItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY, '1');
    resumePendingAmsgStateSync({
      characters: [], userProfile: {} as any, groups: [], realtimeConfig: config,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(1);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledWith(config, expect.objectContaining({ updatedAt: expect.any(Number) }));
    expect(readMark()).toBeNull();
  });

  it('上传期间配置又改了 → 不拿旧那份的成功去清新的欠账', async () => {
    let release: () => void = () => {};
    (ActiveMsgClient.syncToolConfig as any).mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }));
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(1);

    const newer = { weatherEnabled: false } as any;
    syncAmsgToolConfig(newer);          // 上一次还没回来
    release();
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(2);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenLastCalledWith(newer, expect.objectContaining({ updatedAt: expect.any(Number) }));
    expect(readMark()).toBeNull();
  });
});

// 回归守卫：清空 Worker 地址以前是静默存盘。前端这边一切同步停摆，D1 里的任务却一条
// 没少——cron 每分钟照常消费、照烧 LLM 照推送，用户以为自己关掉了一切。
describe('清空 Worker 地址前的收尾', () => {
  it('只有「从非空变空」才触发取消流程', () => {
    expect(isWorkerUrlCleared('https://amsg.example.dev', '')).toBe(true);
    expect(isWorkerUrlCleared('https://amsg.example.dev', '   ')).toBe(true);
    // 换地址、首次填写、本来就空：都不是「关掉」
    expect(isWorkerUrlCleared('https://a.dev', 'https://b.dev')).toBe(false);
    expect(isWorkerUrlCleared('', 'https://b.dev')).toBe(false);
    expect(isWorkerUrlCleared('', '')).toBe(false);
    expect(isWorkerUrlCleared(undefined, undefined)).toBe(false);
  });

  it('逐个取消远端任务，单条失败不拖累其余', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([
      { uuid: 'u1' }, { uuid: 'u2' }, { uuid: 'u3' }, { notAUuid: true },
    ]);
    (ActiveMsgClient.cancelTask as any).mockImplementation(async (uuid: string) => {
      if (uuid === 'u2') throw new Error('worker 503');
      return { uuid, alreadyGone: false };
    });

    const result = await cancelAllRemoteAmsgTasks();

    expect(ActiveMsgClient.cancelTask).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ total: 3, failed: 1, listed: true });
  });

  it('清单都读不到 → listed:false，交给界面提示「远端可能还挂着」', async () => {
    (ActiveMsgClient.listAllTasks as any).mockRejectedValue(new Error('unauthorized'));

    const result = await cancelAllRemoteAmsgTasks();

    expect(result.listed).toBe(false);
    expect(ActiveMsgClient.cancelTask).not.toHaveBeenCalled();
  });

  // 这一条刻意跟角色级的 ActiveMsgClient.cancelAllTasksForChar 反着来：那边放过即时对话的
  // 行（关掉角色的 2.0 开关不该掐掉用户正等着的那轮聊天），这边两个调用方要的都是
  // 「我不跟这台 worker 来往了」——地址一清，回复推回来这边也接不住；云端数据一清，
  // 角色上下文没了，那一跳到点也只会硬失败，留着只是多一条要等 7 天才自动消失的失败行。
  it('正在跑的即时对话也一并取消（这里的「全部」是字面意思）', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([
      { uuid: 'u-scheduled', messageSubtype: 'chat' },
      { uuid: 'u-instant', messageSubtype: 'instant-chat' },
    ]);

    const result = await cancelAllRemoteAmsgTasks();

    expect((ActiveMsgClient.cancelTask as any).mock.calls.map((call: unknown[]) => call[0]))
      .toEqual(['u-scheduled', 'u-instant']);
    expect(result).toEqual({ total: 2, failed: 0, listed: true });
  });
});

describe('清空云端数据', () => {
  // 这一组守的是同一条：四样各清各的，谁失败都不许短路后面几样。
  // 换过 AMSG_MASTER_KEY 之后旧密文全解不开，而「列任务」要逐条解密、必然最先炸，
  // 偏偏这时候最需要被清掉的是 client_state —— 串行短路的话用户一样都清不成。
  it('任务清单读不出来时，角色上下文 / 凭据行 / 推送订阅照样收拾干净', async () => {
    (ActiveMsgClient.listAllTasks as any).mockRejectedValue(new Error('decryption failed'));
    (ActiveMsgClient.clearClientState as any).mockResolvedValue({ deleted: 7, toolConfigRestored: true });
    (ActiveMsgClient.deleteLlmCredentials as any).mockResolvedValue(5);

    const result = await wipeAmsgCloudData(undefined, { pushRegistered: true });

    expect(result.tasks.listed).toBe(false);
    expect(ActiveMsgClient.clearClientState).toHaveBeenCalledTimes(1);
    expect(result.stateDeleted).toBe(7);
    expect(ActiveMsgClient.deleteLlmCredentials).toHaveBeenCalledWith({ all: true });
    expect(result.llmCredentialsDeleted).toBe(5);
    expect(ActiveMsgClient.registerPushSubscription).toHaveBeenCalledTimes(1);
    expect(result.push).toBe('reregistered');
  });

  it('凭据行删不掉时，前后几样照样各清各的', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([{ uuid: 'u-1' }]);
    (ActiveMsgClient.clearClientState as any).mockResolvedValue({ deleted: 2, toolConfigRestored: true });
    // 老 worker 上根本没有这张表，这一步注定失败——它一个人失败不能把别的三样拖下水。
    (ActiveMsgClient.deleteLlmCredentials as any).mockRejectedValue(new Error('NOT_FOUND'));

    const result = await wipeAmsgCloudData(undefined, { pushRegistered: true });

    expect(result.tasks).toEqual({ total: 1, failed: 0, listed: true });
    expect(result.stateDeleted).toBe(2);
    expect(result.llmCredentialsDeleted).toBeNull();
    expect(result.push).toBe('reregistered');
  });

  it('角色上下文清不掉时，凭据行照样删（这一步排在它后面，不能被短路）', async () => {
    (ActiveMsgClient.clearClientState as any).mockRejectedValue(new Error('boom'));
    (ActiveMsgClient.deleteLlmCredentials as any).mockResolvedValue(3);

    const result = await wipeAmsgCloudData(undefined, { pushRegistered: false });

    expect(result.stateDeleted).toBeNull();
    expect(result.llmCredentialsDeleted).toBe(3);
  });

  it('角色上下文清不掉时，任务照样取消、推送订阅照样收拾', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([{ uuid: 'u-1' }, { uuid: 'u-2' }]);
    (ActiveMsgClient.clearClientState as any).mockRejectedValue(new Error('boom'));

    const result = await wipeAmsgCloudData(undefined, { pushRegistered: true });

    expect(ActiveMsgClient.cancelTask).toHaveBeenCalledTimes(2);
    expect(result.tasks).toEqual({ total: 2, failed: 0, listed: true });
    expect(result.stateDeleted).toBeNull();
    expect(result.toolConfigRestored).toBe(false);
    expect(result.push).toBe('reregistered');
  });

  it('推送订阅收拾不了也不影响前两样的结果', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([{ uuid: 'u-1' }]);
    (ActiveMsgClient.clearClientState as any).mockResolvedValue({ deleted: 3, toolConfigRestored: true });
    (ActiveMsgClient.registerPushSubscription as any).mockRejectedValue(new Error('no permission'));

    const result = await wipeAmsgCloudData(undefined, { pushRegistered: true });

    expect(result.tasks).toEqual({ total: 1, failed: 0, listed: true });
    expect(result.stateDeleted).toBe(3);
    expect(result.push).toBe('failed');
  });

  // 本机没订阅还去 registerPushSubscription 的话，会当场向用户要通知权限——
  // 「清空数据」不该顺手弹权限框，删掉云端那行留白就是对的。
  it('本机没有推送订阅时只删云端那行，不去重新登记', async () => {
    const result = await wipeAmsgCloudData(undefined, { pushRegistered: false });

    expect(ActiveMsgClient.deleteRemotePushSubscription).toHaveBeenCalledTimes(1);
    expect(ActiveMsgClient.registerPushSubscription).not.toHaveBeenCalled();
    expect(result.push).toBe('deleted');
  });
});

describe('重置全部数据的云端收尾', () => {
  // 这一组守的是「重置之后云端不会继续跑」。删库把 worker 地址一起带走了，本地再没有
  // 任何东西够得着那台 worker，所以云端这一步必须排在删库之前、而且结果要如实回报。
  it('没配过 worker 时一个请求都不发', async () => {
    (ActiveMsgStore.getGlobalConfig as any).mockResolvedValue({ workerUrl: '' });

    const result = await wipeAmsgCloudDataForReset();

    expect(result).toEqual({ status: 'skipped' });
    expect(ActiveMsgClient.listAllTasks).not.toHaveBeenCalled();
    expect(ActiveMsgClient.clearClientState).not.toHaveBeenCalled();
  });

  it('清干净了回 cleared，而且不补传工具凭据、不重新登记推送', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([{ uuid: 'u-1' }]);
    (ActiveMsgClient.clearClientState as any).mockResolvedValue({ deleted: 4, toolConfigRestored: false });

    const result = await wipeAmsgCloudDataForReset();

    expect(result).toEqual({ status: 'cleared' });
    // 本地紧接着就要删库，补上去的凭据谁也不会再读，登记的推送也没人接得住。
    expect(ActiveMsgClient.clearClientState).toHaveBeenCalledWith(undefined, { restoreToolConfig: false });
    expect(ActiveMsgClient.registerPushSubscription).not.toHaveBeenCalled();
    expect(ActiveMsgClient.deleteRemotePushSubscription).toHaveBeenCalledTimes(1);
  });

  it('任务清单读不出来算没清干净，把 worker 地址带回去给用户', async () => {
    (ActiveMsgClient.listAllTasks as any).mockRejectedValue(new Error('decryption failed'));

    const result = await wipeAmsgCloudDataForReset();

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.workerUrl).toBe('https://amsg.example.dev');
    expect(result.detail).toContain('任务清单');
  });

  it('有任务取消失败也算没清干净（它们会继续到点烧 API 额度）', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([{ uuid: 'u-1' }, { uuid: 'u-2' }]);
    (ActiveMsgClient.cancelTask as any)
      .mockResolvedValueOnce({ uuid: 'u-1', alreadyGone: false })
      .mockRejectedValueOnce(new Error('offline'));

    const result = await wipeAmsgCloudDataForReset();

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.detail).toContain('1 个定时任务');
  });

  it('角色上下文清不掉算没清干净（那是聊天原文）', async () => {
    (ActiveMsgClient.clearClientState as any).mockRejectedValue(new Error('boom'));

    const result = await wipeAmsgCloudDataForReset();

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.detail).toContain('角色上下文');
  });

  // 老 worker 上压根没有凭据表，这一步注定失败。拿它当判据会把一批根本没东西可清的人
  // 堵在重置门口，所以它只记一笔、不拦着重置。
  it('凭据行删不掉不算没清干净', async () => {
    (ActiveMsgClient.deleteLlmCredentials as any).mockRejectedValue(new Error('NOT_FOUND'));

    const result = await wipeAmsgCloudDataForReset();

    expect(result).toEqual({ status: 'cleared' });
  });
});

// 云端那张凭据表和 tool_config 处境一样：只在保存配置那一刻传一次，丢了没人补。
// 而它丢了的后果更硬——已排程的任务到点还在用旧 Key，用户只看到「主动消息不来了」。
describe('LLM 凭据行的后台重传', () => {
  const API = { baseUrl: 'https://api.example.dev/v1', apiKey: 'sk-new', model: 'gpt-x' } as any;
  const CHAR = {
    id: 'char-cred-sync',
    name: '小满',
    activeMsg2Config: { enabled: true, tasks: [] },
  } as any as CharacterProfile;

  const primeLedgerWithOldKey = () => {
    // 底账里记着这一行「传过了」，但记的是旧 Key 的指纹 → 现在算出来就是「变了」。
    rememberCredRows([buildCharChatCredRow(
      CHAR as any, CHAR.activeMsg2Config as any, { baseUrl: API.baseUrl, apiKey: 'sk-old', model: API.model } as any,
    )!]);
  };

  beforeEach(() => {
    vi.spyOn(DB, 'getAllCharacters').mockResolvedValue([CHAR] as any);
  });

  it('worker 不支持凭据表 → 一个请求都不发，也不留欠账', async () => {
    (isLlmCredentialsReady as any).mockResolvedValue(false);
    primeLedgerWithOldKey();

    syncAmsgLlmCredentials(API);
    await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);

    expect(ActiveMsgClient.putLlmCredentials).not.toHaveBeenCalled();
    expect(localStorage.getItem(AMSG2_PENDING_CRED_SYNC_LS_KEY)).toBeNull();
  });

  it('换了 Key → 把底账里那几行按新配置重算后传上去', async () => {
    (isLlmCredentialsReady as any).mockResolvedValue(true);
    primeLedgerWithOldKey();

    syncAmsgLlmCredentials(API);
    await vi.advanceTimersByTimeAsync(0);

    const rows = (ActiveMsgClient.putLlmCredentials as any).mock.calls[0][0];
    expect(rows).toEqual([{
      credId: 'char:char-cred-sync/chat',
      value: {
        apiUrl: 'https://api.example.dev/v1/chat/completions',
        apiKey: 'sk-new',
        primaryModel: 'gpt-x',
      },
    }]);
    expect(localStorage.getItem(AMSG2_PENDING_CRED_SYNC_LS_KEY), '传上去了就该销账').toBeNull();
  });

  it('全局换 Key 时角色独立凭据不变，恢复跟随后才更新为全局', async () => {
    vi.mocked(isLlmCredentialsReady).mockResolvedValue(true);
    const roleApi = { baseUrl: 'https://role.example/v1', apiKey: 'role-key', model: 'role-model' };
    vi.mocked(DB.getAllCharacters).mockResolvedValue([{ ...CHAR, dialogueApi: roleApi }] as any);
    syncAmsgLlmCredentials(API);
    await vi.advanceTimersByTimeAsync(0);
    expect(ActiveMsgClient.putLlmCredentials).toHaveBeenLastCalledWith([{
      credId: 'char:char-cred-sync/chat',
      value: { apiUrl: roleApi.baseUrl + '/chat/completions', apiKey: roleApi.apiKey, primaryModel: roleApi.model },
    }]);
    vi.mocked(DB.getAllCharacters).mockResolvedValue([CHAR] as any);
    syncAmsgLlmCredentials({ ...API });
    await vi.advanceTimersByTimeAsync(0);
    expect(ActiveMsgClient.putLlmCredentials).toHaveBeenLastCalledWith([{
      credId: 'char:char-cred-sync/chat',
      value: { apiUrl: API.baseUrl + '/chat/completions', apiKey: API.apiKey, primaryModel: API.model },
    }]);
  });

  it('这次保存没动 API → 值没变，不白发一次请求', async () => {
    (isLlmCredentialsReady as any).mockResolvedValue(true);
    rememberCredRows([buildCharChatCredRow(CHAR as any, CHAR.activeMsg2Config as any, API)!]);

    syncAmsgLlmCredentials(API);
    await vi.advanceTimersByTimeAsync(0);

    expect(ActiveMsgClient.putLlmCredentials).not.toHaveBeenCalled();
    expect(localStorage.getItem(AMSG2_PENDING_CRED_SYNC_LS_KEY)).toBeNull();
  });

  it('传失败 → 退避重传，欠账留在 localStorage 等启动补', async () => {
    (isLlmCredentialsReady as any).mockResolvedValue(true);
    primeLedgerWithOldKey();
    (ActiveMsgClient.putLlmCredentials as any).mockRejectedValue(new Error('offline'));

    syncAmsgLlmCredentials(API);
    await vi.advanceTimersByTimeAsync(0);
    expect(ActiveMsgClient.putLlmCredentials).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(AMSG2_PENDING_CRED_SYNC_LS_KEY)).toBe('1');

    await vi.advanceTimersByTimeAsync(30_000 + 10);
    expect(ActiveMsgClient.putLlmCredentials).toHaveBeenCalledTimes(2);
  });

  it('同步还在进行时再次切换 API，上一轮结束后立即同步最新配置', async () => {
    let release!: () => void;
    vi.mocked(ActiveMsgClient.refreshApiCredentialsForPendingTasks).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { status: 'ok', updated: 1, failed: 0 };
    });
    syncAmsgLlmCredentials(API);
    await vi.advanceTimersByTimeAsync(0);
    const nextApi = { ...API, apiKey: 'sk-next' };
    syncAmsgLlmCredentials(nextApi);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(ActiveMsgClient.refreshApiCredentialsForPendingTasks).toHaveBeenLastCalledWith(nextApi);
    expect(localStorage.getItem(AMSG2_PENDING_CRED_SYNC_LS_KEY)).toBeNull();
  });

  it('旧任务只迁移成功一部分时保留欠账并重试，旧 Worker 也适用', async () => {
    vi.mocked(ActiveMsgClient.refreshApiCredentialsForPendingTasks)
      .mockResolvedValueOnce({ status: 'partial', updated: 1, failed: 1 })
      .mockResolvedValue({ status: 'ok', updated: 2, failed: 0 });
    syncAmsgLlmCredentials(API);
    await vi.advanceTimersByTimeAsync(0);
    expect(localStorage.getItem(AMSG2_PENDING_CRED_SYNC_LS_KEY)).toBe('1');
    await vi.advanceTimersByTimeAsync(30_001);
    expect(ActiveMsgClient.refreshApiCredentialsForPendingTasks).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(AMSG2_PENDING_CRED_SYNC_LS_KEY)).toBeNull();
  });

  it('恢复备份没有本地凭据底账时，也会为启用角色覆盖 chat 行', async () => {
    vi.mocked(isLlmCredentialsReady).mockResolvedValue(true);
    syncAmsgLlmCredentials(API);
    await vi.advanceTimersByTimeAsync(0);
    expect(ActiveMsgClient.putLlmCredentials).toHaveBeenCalledWith([{
      credId: 'char:char-cred-sync/chat',
      value: { apiUrl: 'https://api.example.dev/v1/chat/completions', apiKey: 'sk-new', primaryModel: 'gpt-x' },
    }]);
  });

  it('升级启动没有欠账标记也会替换旧副 API，并刷新存量任务', async () => {
    (isLlmCredentialsReady as any).mockResolvedValue(true);
    primeLedgerWithOldKey();
    resumePendingAmsgStateSync({ characters: [CHAR], userProfile: {} as any, groups: [], apiConfig: API });
    await vi.advanceTimersByTimeAsync(0);
    expect(ActiveMsgClient.putLlmCredentials).toHaveBeenCalledTimes(1);
    expect(ActiveMsgClient.refreshApiCredentialsForPendingTasks).toHaveBeenCalledWith(API);
  });

  it('启动补传：上次没传成的按底账重来一次（没给 apiConfig 就跳过这一项）', async () => {
    (isLlmCredentialsReady as any).mockResolvedValue(true);
    primeLedgerWithOldKey();
    localStorage.setItem(AMSG2_PENDING_CRED_SYNC_LS_KEY, '1');

    resumePendingAmsgStateSync({ characters: [], userProfile: {} as any, groups: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(ActiveMsgClient.putLlmCredentials).not.toHaveBeenCalled();

    resumePendingAmsgStateSync({ characters: [], userProfile: {} as any, groups: [], apiConfig: API });
    await vi.advanceTimersByTimeAsync(0);
    expect(ActiveMsgClient.putLlmCredentials).toHaveBeenCalledTimes(1);
  });
});

describe('活跃会话租约', () => {
  it('启动立即写一次，之后按心跳间隔续租；stop 后不再续', async () => {
    const charId = nextCharId();
    startAmsgChatPresence(charId, Date.now());
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CHAT_PRESENCE_HEARTBEAT_MS + 100);
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(2);

    stopAmsgChatPresence(charId);
    await vi.advanceTimersByTimeAsync(CHAT_PRESENCE_HEARTBEAT_MS * 3);
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(2);
  });

  it('同角色重入只刷新时间戳，不叠第二个心跳', async () => {
    const charId = nextCharId();
    startAmsgChatPresence(charId, Date.now());
    startAmsgChatPresence(charId, Date.now());
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(2); // 两次立即写

    await vi.advanceTimersByTimeAsync(CHAT_PRESENCE_HEARTBEAT_MS + 100);
    // 只有一个 timer 在跑 → 只多一次，而不是两次
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(3);
    stopAmsgChatPresence(charId);
  });
});


it('停用或恢复角色时丢弃旧重试快照，飞行请求失败也不能重新入队', async () => {
  const character = charWithAiTask(nextCharId());
  let rejectUpload!: (error: Error) => void;
  vi.mocked(ActiveMsgClient.syncCharFirePacks).mockImplementationOnce(() => new Promise((_, reject) => { rejectUpload = reject; }));
  markAmsgStateDirty(snapshotOf(character));
  const flushing = flushAmsgState('before-retirement');
  await vi.advanceTimersByTimeAsync(1);
  discardAmsgPendingState(character.id);
  rejectUpload(new Error('旧请求被云端拒绝'));
  await flushing;
  await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);
  expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
  expect(JSON.parse(localStorage.getItem(AMSG2_PENDING_SYNC_LS_KEY) || '[]')).not.toContain(character.id);
  markAmsgStateDirty(snapshotOf(character));
  await flushAmsgState('new-user-change');
  expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(2);
});
