// utils/activeMsgClient.stateClock.test.ts
//
// 回归守卫（云端拒收这一轮状态时怎么办）：
//   1. 设备时钟领先过真实时间的话，云端 client_state 那一行会带着一个还没到的时刻，
//      之后每次上传都被条件写判成「旧的」——即时对话表现为每发一句都 409，用户把系统
//      时间调回来也没用（那一行在云端，本地删消息 / 重装 / 重填 Worker 地址都碰不到）。
//      2026-09-01 有用户真的这么卡住了，这里钉住自愈：读回云端那行的时间戳、对齐水位、
//      重新盖戳发第二次。
//   2. 但不能见 409 就重发：云端确实有更新的一份时（多设备竞写）重发也是白发，得先看
//      水位有没有真的抬动。
//   3. 常规批量同步撞上同一道闸只有一行 log，比即时对话那条还难发现，所以它也要对齐
//      水位——只是不在这一轮重传（下一轮打脏同步带着更新的内容盖过去更有道理）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reiClient } = vi.hoisted(() => ({
  reiClient: {
    init: vi.fn(),
    putClientState: vi.fn(),
    getClientState: vi.fn(),
    getCapabilities: vi.fn(),
    putLlmCredentials: vi.fn(),
    deleteLlmCredentials: vi.fn(),
    _encrypt: vi.fn(),
  },
}));
vi.mock('@rei-standard/amsg-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@rei-standard/amsg-client')>(), ReiClient: vi.fn(() => reiClient),
}));
vi.mock('./keepAlive', () => ({
  KeepAlive: { init: vi.fn().mockResolvedValue(undefined), reregister: vi.fn().mockResolvedValue(undefined) },
}));

const TEST_USER_ID = '3f2b1c8a-9d4e-4a1b-8c2d-000000000043';
const globalConfig: Record<string, unknown> = {
  userId: TEST_USER_ID,
  workerUrl: 'https://amsg.example.workers.dev',
  serverToken: '',
  llmCredentialsSupported: true,
};
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    ensureUserId: async () => TEST_USER_ID,
    getGlobalConfig: async () => ({ ...globalConfig }),
    saveGlobalConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

import { ActiveMsgClient } from './activeMsgClient';
import { amsgStateNamespace } from './amsgFirePack';
import { clearInstantChatPending } from './amsgInstantChat';
import { forgetAllCredIds } from './amsgLlmCredentials';
import { readStateClockWatermark, resetStateClock } from './amsgStateClock';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';

const CHAR_ID = 'char-state-clock';
const CHAR = {
  id: CHAR_ID,
  name: '小满',
  memories: [],
  activeMsg2Config: { enabled: true, tasks: [] },
} as any;
const NAMESPACE = amsgStateNamespace(CHAR_ID);

/** 云端那一行记着的时刻：比本机的钟晚一小时（当初设备时钟领先时写进去的）。 */
const FUTURE = Date.now() + 3_600_000;

/** 这一轮 POST 出去的载荷（加密前）。 */
const capturedPayloads: any[] = [];
/** 每次 POST 的返回，按顺序取；用完了就一直回最后一个。 */
let postResponses: Array<{ status: number; body: unknown }> = [];
let postedPaths: string[] = [];

const respond = () => {
  const next = postResponses.length > 1 ? postResponses.shift()! : postResponses[0];
  return {
    status: next.status,
    text: async () => JSON.stringify(next.body),
    headers: new Headers({ 'content-type': 'application/json' }),
  };
};

const STATE_STALE = {
  status: 409,
  body: { success: false, error: { code: 'INSTANT_CHAT_STATE_STALE', message: '云端拒收了这轮的最新状态', step: 'client-state' } },
};
const ACCEPTED = { status: 202, body: { status: 'accepted', uuid: 'instant-retried' } };

beforeEach(() => {
  resetStateClock();
  capturedPayloads.length = 0;
  postedPaths = [];
  postResponses = [ACCEPTED];
  forgetAllCredIds();
  reiClient.init.mockReset().mockResolvedValue(undefined);
  reiClient.putClientState.mockReset().mockImplementation(async (entries) => ({ success: true, data: { upserted: entries.length, skipped: 0, deleted: 0, rejected: [] } }));
  reiClient.getClientState.mockReset().mockResolvedValue({ success: true, data: { entries: [] } });
  reiClient.putLlmCredentials.mockReset().mockResolvedValue({ success: true, data: { upserted: 1 } });
  reiClient.deleteLlmCredentials.mockReset().mockResolvedValue({ success: true, data: { deleted: 0 } });
  reiClient.getCapabilities.mockReset().mockResolvedValue({ serverVersion: '2.6.0-next.23', features: [] });
  reiClient._encrypt.mockReset().mockImplementation(async (json: string) => {
    capturedPayloads.push(JSON.parse(json));
    return { iv: 'iv', authTag: 'tag', encryptedData: 'enc' };
  });
  vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
  vi.spyOn(DB, 'getEmojis').mockResolvedValue([] as any);
  vi.spyOn(DB, 'getEmojiCategories').mockResolvedValue([] as any);
  vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockResolvedValue('SYS');
  vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({ apiMessages: [] } as any);
  vi.spyOn(ChatPrompts, 'filterVisibleEmojis').mockReturnValue({ emojis: [], categories: [] } as any);
  vi.spyOn(ActiveMsgClient, 'registerPushSubscription').mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const target = String(url);
    postedPaths.push(target);
    // 只有即时对话那条路吃这条响应队列。首次调用还会捎带握手/探测那几个请求，
    // 让它们也去队列里取的话，队首那个 409 会被别人吃掉。
    if (target.includes('instant-chat')) return respond();
    return {
      status: 200,
      text: async () => JSON.stringify({ success: true, data: {} }),
      headers: new Headers({ 'content-type': 'application/json' }),
    };
  }));
  clearInstantChatPending(CHAR_ID);
});

afterEach(() => {
  clearInstantChatPending(CHAR_ID);
  resetStateClock();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 云端 GET 回来的那一份：fire_pack 那行记着一个还没到的时刻。 */
const remoteHasFuturePack = () => {
  reiClient.getClientState.mockResolvedValue({
    success: true,
    data: { entries: [{ namespace: NAMESPACE, key: 'fire_pack', value: 'gz1:...', updatedAt: FUTURE }] },
  });
};

const send = () => ActiveMsgClient.sendInstantChat({
  char: CHAR,
  chatMessages: [{ role: 'user', content: '在吗' }],
  api: { baseUrl: 'https://api.example.dev/v1', apiKey: 'sk-global', model: 'gpt-global' },
  userProfile: { name: '小明' } as any,
  groups: [],
  realtimeConfig: {} as any,
} as any);

/** POST 出去的云端状态载荷（任务那份有 messageType，据此分开）。 */
const statePayloads = () => capturedPayloads.filter((p) => p && Array.isArray(p.entries));
const firePackStampOf = (payload: any) => payload.entries.find((e: any) => e.key === 'fire_pack').updatedAt;
const instantChatPosts = () => postedPaths.filter((p) => p.includes('instant-chat'));

describe('即时对话撞上「云端拒收这轮状态」', () => {
  it('云端那行落在未来 → 读回来对齐、重新盖戳、重发一次，这一轮发得出去', async () => {
    postResponses = [STATE_STALE, ACCEPTED];
    remoteHasFuturePack();

    const result = await send();

    expect(result.uuid).toBe('instant-retried');
    expect(instantChatPosts(), '第一次被拒之后要再发一次').toHaveLength(2);
    expect(reiClient.getClientState).toHaveBeenCalledWith(NAMESPACE);

    // 重发那一份的戳必须跨过云端那行，否则条件写还是拦下它。
    const [first, second] = statePayloads();
    expect(firePackStampOf(first)).toBeLessThan(FUTURE);
    expect(firePackStampOf(second)).toBeGreaterThan(FUTURE);
  });

  it('重发只换戳，不重打包（value 原样复用）', async () => {
    postResponses = [STATE_STALE, ACCEPTED];
    remoteHasFuturePack();

    await send();

    const [first, second] = statePayloads();
    expect(second.entries.map((e: any) => e.value)).toEqual(first.entries.map((e: any) => e.value));
  });

  it('云端读回来的都不比本地新 → 不重发，原样报错（重发也是白发）', async () => {
    postResponses = [STATE_STALE, ACCEPTED];
    reiClient.getClientState.mockResolvedValue({
      success: true,
      data: { entries: [{ namespace: NAMESPACE, key: 'fire_pack', value: 'gz1:...', updatedAt: 1 }] },
    });

    await expect(send()).rejects.toThrow('即时对话没发出去');
    expect(instantChatPosts()).toHaveLength(1);
  });

  it('云端状态读不回来 → 不重发也不改口，原来的失败原样报出去', async () => {
    postResponses = [STATE_STALE, ACCEPTED];
    reiClient.getClientState.mockRejectedValue(new Error('网络断了'));

    await expect(send()).rejects.toThrow('即时对话没发出去');
    expect(instantChatPosts()).toHaveLength(1);
  });

  it('对齐过一次之后，别的上传路径也跟着跨过去了（水位是共用的）', async () => {
    postResponses = [STATE_STALE, ACCEPTED];
    remoteHasFuturePack();
    await send();

    reiClient.putClientState.mockClear();
    await ActiveMsgClient.syncToolConfig({} as any);

    const [entries] = reiClient.putClientState.mock.calls.at(-1)!;
    expect(entries[0].updatedAt).toBeGreaterThan(FUTURE);
  });
});

describe('常规批量同步撞上同一道闸', () => {
  const sync = () => ActiveMsgClient.syncCharFirePacks([{
    char: CHAR,
    config: { enabled: true, tasks: [] } as any,
    userProfile: { name: '小明' } as any,
    groups: [],
    realtimeConfig: {} as any,
  }]);

  it('被拦下 → 读回云端时间戳对齐水位（这一轮不重传）', async () => {
    reiClient.putClientState.mockResolvedValue({
      success: true,
      data: { upserted: 1, skippedEntries: [{ namespace: NAMESPACE, key: 'fire_pack' }] },
    });
    remoteHasFuturePack();

    await sync();

    expect(reiClient.getClientState).toHaveBeenCalledWith(NAMESPACE);
    expect(reiClient.putClientState, '对齐就够了，这一轮不重传').toHaveBeenCalledTimes(1);
    expect(readStateClockWatermark()).toBe(FUTURE);
  });

  it('一条都没被拦 → 不白读一次云端', async () => {
    await sync();

    expect(reiClient.getClientState).not.toHaveBeenCalled();
  });
});


describe('工具配置逐项写入回执', () => {
  it('HTTP success但条目被跳过时校准水位并报冲突，不发第二次覆盖', async () => {
    reiClient.putClientState.mockResolvedValue({ success: true, data: {
      upserted: 0, skipped: 1, deleted: 0, rejected: [],
      skippedEntries: [{ namespace: 'amsg:global', key: 'tool_config' }],
    } });
    reiClient.getClientState.mockResolvedValue({ success: true, data: { entries: [
      { key: 'tool_config', value: '{"newsEnabled":true}', updatedAt: FUTURE },
    ] } });
    await expect(ActiveMsgClient.syncToolConfig({ newsEnabled: false } as any))
      .rejects.toMatchObject({ code: 'TOOL_CONFIG_CONFLICT' });
    expect(reiClient.putClientState).toHaveBeenCalledTimes(1);
    expect(readStateClockWatermark()).toBeGreaterThanOrEqual(FUTURE);
  });

  it.each([
    { success: true, data: { upserted: 0, skipped: 0, rejected: [{ index: 0, namespace: 'amsg:global', key: 'tool_config', message: 'too large' }] } },
    { success: true, data: {} },
  ])('拒绝或不完整回执不能当作同步完成', async (response) => {
    reiClient.putClientState.mockResolvedValue(response);
    await expect(ActiveMsgClient.syncToolConfig({} as any)).rejects.toThrow();
  });
});
