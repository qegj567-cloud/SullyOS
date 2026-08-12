// utils/activeMsgClient.test.ts
// 回归守卫：
//   1. 云端状态上传「不降级」。过去这一步失败只 warn，任务照建，到点用排程那刻冻结的
//      prompt 发——用户收到旧上下文却完全不知道。现在网络抖动重试、最终失败必须抛错。
//   2. 取消任务幂等。远端已经没有那一条时（一次性任务发完就删行）不能报「取消失败」。
//   3. 按角色对账要认得出「老 worker 没投影 charId」，不能把它当成「远端一条都没有」。
//   4. 「清除云端状态」清完必须把全局工具凭据补回去（它没有别的补写时机）。
//   5. 推送订阅按用户登记一份，跟本地有没有任务无关——角色在 fire 里给自己排的任务
//      客户端从没见过，照着本地清单刷是刷不到它的。排程载荷也不再带订阅。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// clearClientState 走的是库客户端而不是 fetchWithAuth，这里把整个客户端换成假的。
const { reiClient } = vi.hoisted(() => ({
  reiClient: {
    init: vi.fn(),
    clearClientState: vi.fn(),
    putClientState: vi.fn(),
    getClientState: vi.fn(),
    getCapabilities: vi.fn(),
    getVapidPublicKey: vi.fn(),
    subscribePush: vi.fn(),
    updateMessage: vi.fn(),
    putPushSubscription: vi.fn(),
    getPushSubscription: vi.fn(),
    deletePushSubscription: vi.fn(),
    // 加密信封的封包 / 解包（库的私有方法，客户端通过桥接类型调）。
    _encrypt: vi.fn(),
    _decrypt: vi.fn(),
  },
}));
vi.mock('@rei-standard/amsg-client', () => ({ ReiClient: vi.fn(() => reiClient) }));
// ensurePushSubscription 会先跑 KeepAlive.init()（注册 SW 等浏览器副作用），测里桩掉。
// reregister 是深度重置那条路用的（注销 SW 再装回来），同理。
vi.mock('./keepAlive', () => ({
  KeepAlive: {
    init: vi.fn().mockResolvedValue(undefined),
    reregister: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  ActiveMsgClient, buildFirePack, clearNamespaceValuesOrThrow, compareRemotePushSubscription,
  describeInstantChatFailure, dropStaleSubscription, putClientStateOrThrow, readAmsgFailKind,
  toRemoteAvatarUrl,
} from './activeMsgClient';
import {
  AMSG_FIRE_PACK_KEY,
  AMSG_SLOT_CURRENT_TIME, AMSG_SLOT_REALTIME_WORLD, AMSG_SLOT_SCENE,
  AMSG_SLOT_TASK_LIST, AMSG_SLOT_TIME_SINCE_USER, AMSG_SLOT_USER_CLOCK,
} from './amsgFirePack';
import { clearInstantChatPending, setInstantChatPending } from './amsgInstantChat';
import { AMSG_TOOL_CONFIG_KEY, AMSG_TOOL_PACK_KEY } from './amsgToolPack';
import * as dailySchedule from './dailySchedule';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';
import { KeepAlive } from './keepAlive';

const TEST_USER_ID = '3f2b1c8a-9d4e-4a1b-8c2d-000000000001';

// cancelTask 要走 ensureWorkerReady（读 IndexedDB 里的 worker 地址），测里给一份固定配置。
/** 用例想往全局配置里多塞几个字段时改它（比如「上次已经探到 true」）。用完记得清。 */
const { storeConfigExtra } = vi.hoisted(() => ({ storeConfigExtra: { value: {} as Record<string, unknown> } }));

vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    ensureUserId: async () => TEST_USER_ID,
    getGlobalConfig: async () => ({
      userId: TEST_USER_ID,
      workerUrl: 'https://amsg.example.workers.dev',
      serverToken: '',
      ...storeConfigExtra.value,
    }),
    // connect() 成功那条路会落盘 initializedAt，走失败分支的用例碰不到它。
    saveGlobalConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

const ENTRIES = [{ namespace: 'amsg:char:x', key: 'fire_pack', value: '{}', updatedAt: 1 }];

/** 只需要 putClientState 这一个方法，其余 InternalReiClient 成员用不到。 */
const clientWith = (impl: any) => ({ putClientState: impl } as any);

// 假时钟：重试退避是真的 setTimeout（400ms + 1200ms），实测跑满 4s。
// 用 advanceTimersByTimeAsync 把等待推掉，测的还是同一段逻辑。
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** 起 promise + 把退避时钟推完，返回 promise 供断言。 */
const runWithTimers = <T>(promise: Promise<T>): Promise<T> => {
  void vi.advanceTimersByTimeAsync(5_000);
  return promise;
};

describe('putClientStateOrThrow', () => {
  it('一次成功 → 不重试', async () => {
    const put = vi.fn().mockResolvedValue({ success: true });
    await putClientStateOrThrow(clientWith(put), ENTRIES, '上传云端状态');
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('抛异常后重试，第二次成功 → 不抛错', async () => {
    const put = vi.fn()
      .mockRejectedValueOnce(new Error('network hiccup'))
      .mockResolvedValueOnce({ success: true });
    await runWithTimers(putClientStateOrThrow(clientWith(put), ENTRIES, '上传云端状态'));
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('回 { success: false } 也算失败并重试（只 try/catch 会漏掉这种）', async () => {
    const put = vi.fn()
      .mockResolvedValueOnce({ success: false, error: { message: 'D1 busy' } })
      .mockResolvedValueOnce({ success: true });
    await runWithTimers(putClientStateOrThrow(clientWith(put), ENTRIES, '上传云端状态'));
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('三次都失败 → 抛错（绝不静默降级）', async () => {
    const put = vi.fn().mockRejectedValue(new Error('worker down'));
    await expect(runWithTimers(putClientStateOrThrow(clientWith(put), ENTRIES, '上传云端状态')))
      .rejects.toThrow(/worker down/);
    expect(put).toHaveBeenCalledTimes(3);
  });

  it('条目被 worker 点名 rejected → 立刻抛错、不重试（重试不会变好）', async () => {
    const put = vi.fn().mockResolvedValue({
      success: true,
      data: { rejected: [{ key: 'fire_pack', message: 'value too large' }] },
    });
    await expect(putClientStateOrThrow(clientWith(put), ENTRIES, '上传云端状态'))
      .rejects.toThrow(/fire_pack\(value too large\)/);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('打到网页而不是 Worker（拿到 HTML）时给可读的错误', async () => {
    const put = vi.fn().mockRejectedValue(new Error(`Unexpected token '<'`));
    await expect(runWithTimers(putClientStateOrThrow(clientWith(put), ENTRIES, '上传云端状态')))
      .rejects.toThrow(/没有打到 Worker/);
  });
});

describe('ActiveMsgClient.cancelTask', () => {
  /** safeResponseJson 读 status、text() 和 headers（content-type），假 Response 三样都要有。 */
  const respondWith = (status: number, body: unknown) => {
    const fetchMock = vi.fn().mockResolvedValue({
      status,
      text: async () => JSON.stringify(body),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  afterEach(() => { vi.unstubAllGlobals(); });

  it('远端确实删掉了 → 成功', async () => {
    respondWith(200, { success: true, data: { uuid: 'task-1', message: '任务已成功取消' } });
    await expect(ActiveMsgClient.cancelTask('task-1'))
      .resolves.toMatchObject({ uuid: 'task-1', alreadyGone: false });
  });

  it('远端本来就没有这一条 → 也算取消成功（终态已达成，没什么可重试的）', async () => {
    respondWith(404, {
      success: false,
      error: { code: 'TASK_NOT_FOUND', message: '指定的任务不存在或已被删除' },
    });
    await expect(ActiveMsgClient.cancelTask('task-gone'))
      .resolves.toMatchObject({ uuid: 'task-gone', alreadyGone: true });
  });

  it('其它错误照常抛，别顺手一起吞掉', async () => {
    respondWith(500, {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' },
    });
    await expect(ActiveMsgClient.cancelTask('task-1')).rejects.toThrow(/服务器内部错误/);
  });

  it('鉴权失败照常抛（共享密钥填错时必须看得见）', async () => {
    respondWith(401, {
      success: false,
      error: { code: 'INVALID_CLIENT_TOKEN', message: '客户端令牌无效' },
    });
    await expect(ActiveMsgClient.cancelTask('task-1')).rejects.toThrow(/客户端令牌无效/);
  });
});

// 回归守卫：即时对话「一直等」靠这个判定器决定要不要停下来。三种结论各有各的后果，
// 而「问不到」必须抛错 —— 静悄悄当成 gone 的话，云端还在生成的一轮就被判成没了。
describe('ActiveMsgClient.getRemoteTaskStatus', () => {
  const respondWith = (status: number, body: unknown) => {
    const fetchMock = vi.fn().mockResolvedValue({
      status,
      text: async () => JSON.stringify(body),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient._decrypt.mockReset();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('行还在 → pending，带上远端的重试计数与下次触发时刻', async () => {
    const fetchMock = respondWith(200, {
      success: true,
      encrypted: true,
      version: 1,
      data: { iv: 'iv', authTag: 'tag', encryptedData: 'blob' },
    });
    reiClient._decrypt.mockResolvedValue({
      task: { uuid: 'task-1', status: 'pending', retryCount: 2, nextSendAt: '2026-08-05T10:00:00.000Z' },
    });

    await expect(ActiveMsgClient.getRemoteTaskStatus('task-1')).resolves.toEqual({
      state: 'pending',
      retryCount: 2,
      nextSendAt: '2026-08-05T10:00:00.000Z',
    });
    expect(fetchMock.mock.calls[0][0]).toContain('/message?id=task-1');
  });

  it('行没了（发完被删 / 被取消）→ gone', async () => {
    respondWith(404, {
      success: false,
      error: { code: 'TASK_NOT_FOUND', message: '指定的任务不存在或已被删除' },
    });
    await expect(ActiveMsgClient.getRemoteTaskStatus('task-gone')).resolves.toEqual({ state: 'gone' });
  });

  it('行还在但已出清 → completed（老 worker 不带 details，lastError 报 null）', async () => {
    respondWith(409, {
      success: false,
      error: { code: 'TASK_ALREADY_COMPLETED', message: '任务已完成或已失败，无法更新' },
    });
    await expect(ActiveMsgClient.getRemoteTaskStatus('task-done')).resolves.toEqual({
      state: 'completed', lastError: null,
    });
  });

  it('409 捎带的行级失败摘要透传（amsg-server 2.6.0-next.15 的 details.lastError）', async () => {
    respondWith(409, {
      success: false,
      error: {
        code: 'TASK_ALREADY_COMPLETED',
        message: '任务已完成或已失败，无法更新',
        details: {
          status: 'failed',
          lastError: { at: '2026-08-05T10:00:00.000Z', occurrence: '2026-08-05T09:58:00.000Z', reason: 'LLM_HTTP_500' },
        },
      },
    });
    await expect(ActiveMsgClient.getRemoteTaskStatus('task-failed')).resolves.toEqual({
      state: 'completed',
      lastError: { at: '2026-08-05T10:00:00.000Z', occurrence: '2026-08-05T09:58:00.000Z', reason: 'LLM_HTTP_500' },
    });
  });

  it('网络故障要抛，不能悄悄当成 gone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    // 抛出来的是翻好的整句，不是浏览器那句 "Failed to fetch"（见 amsgDiagnostics）。
    await expect(ActiveMsgClient.getRemoteTaskStatus('task-1')).rejects.toThrow(/连不上你的 Worker/);
  });

  // 地址填错时 worker 对未知路由也回 404，只是错误码不同。照 HTTP 状态判就会把
  // 「压根没问到这台 worker」当成「任务没了」，等着的那一轮就此被判死。
  it('未知路由的 404 要抛，不能当成任务没了', async () => {
    respondWith(404, {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Unknown route' },
    });
    await expect(ActiveMsgClient.getRemoteTaskStatus('task-1')).rejects.toThrow(/Unknown route/);
  });
});

describe('云端 Prompt 审计', () => {
  const respondWith = (status: number, body: unknown) => {
    const fetchMock = vi.fn().mockResolvedValue({
      status,
      text: async () => JSON.stringify(body),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  afterEach(() => { vi.unstubAllGlobals(); });

  it('读取云端 prompt 审计时走 /prompt-audit 并带共享密钥', async () => {
    const fetchMock = respondWith(200, {
      success: true,
      data: {
        entries: [
          {
            id: 'audit-1',
            createdAt: 1,
            expiresAt: 2,
            charId: 'char-1',
            charName: 'Nyah',
            taskUuid: 'task-1',
            taskRowId: '42',
            clientTaskId: 'client-1',
            occurrenceMs: 123,
            status: 'sent',
            model: 'model-1',
            prompt: '完整 prompt',
            promptControls: { timeAwareness: true },
            promptModules: [{ key: 'timeAwareness', label: '时间感知', enabled: true, included: true }],
            rounds: [],
            usage: { totalTokens: 9 },
            outputText: '发出去的话',
            error: null,
          },
        ],
      },
    });

    const entries = await ActiveMsgClient.listPromptAudits(5);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'audit-1', charId: 'char-1', prompt: '完整 prompt' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://amsg.example.workers.dev/prompt-audit?limit=5');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toBeDefined();
  });

  it('清空云端 prompt 审计时走 DELETE /prompt-audit', async () => {
    const fetchMock = respondWith(200, {
      success: true,
      data: { deleted: 3 },
    });

    await expect(ActiveMsgClient.clearPromptAudits()).resolves.toEqual({ deleted: 3 });
    expect(fetchMock.mock.calls[0][0]).toBe('https://amsg.example.workers.dev/prompt-audit');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });
});

// 回归守卫：连接失败的归类。使用统计只发这个代号，不发报错原文——
// 「密钥对不上」「地址不对」「D1 没绑」在图上混成一格的话，看不出该修哪一段引导；
// 而把 error.message 塞进上报又会带出 Worker 地址。两头都得钉住。
describe('连接失败的归类（AmsgFailKind）', () => {
  const respondWith = (status: number, body: unknown) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status,
      text: async () => JSON.stringify(body),
      headers: new Headers({ 'content-type': 'application/json' }),
    }));
  };

  afterEach(() => { vi.unstubAllGlobals(); });

  /** 跑一次 connect，把它抛出来的错交出来。 */
  const connectAndCatch = async (): Promise<unknown> => {
    try {
      await ActiveMsgClient.connect();
      throw new Error('connect 本该失败');
    } catch (error) {
      return error;
    }
  };

  it.each([
    [401, '鉴权失败'],
    [403, '鉴权失败'],
    [404, '端点不存在'],
    [500, '建表失败'],
  ])('init-tenant 回 %i → 代号「%s」', async (status, kind) => {
    respondWith(status, { success: false, error: { message: 'whatever' } });
    expect(readAmsgFailKind(await connectAndCatch())).toBe(kind);
  });

  it('fetch 自己炸了（断网 / DNS / CORS）→ 网络失败', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(readAmsgFailKind(await connectAndCatch())).toBe('网络失败');
  });

  it('地址指到网页而不是 Worker（拿到 HTML）→ 打到网页了', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      text: async () => '<!doctype html><html><body>404 Not Found</body></html>',
      headers: new Headers({ 'content-type': 'text/html' }),
    }));
    expect(readAmsgFailKind(await connectAndCatch())).toBe('打到网页了');
  });

  it('代号只是源码里的字面量，worker 回的报错原文一个字都不带出来', async () => {
    const secret = 'https://my-private-worker.invalid 的密钥 sk-SECRET 无效';
    respondWith(401, { success: false, error: { message: secret } });
    const error = await connectAndCatch();
    // 原文该留在 toast 里给用户看
    expect((error as Error).message).toContain(secret);
    // 但上报只拿得到代号
    expect(readAmsgFailKind(error)).toBe('鉴权失败');
  });

  it('没挂代号的错误一律「其他」，不会把异常对象上的东西漏出去', () => {
    expect(readAmsgFailKind(new Error('sk-LEAKED'))).toBe('其他');
    expect(readAmsgFailKind(undefined)).toBe('其他');
  });
});

// 回归守卫：worker 缺 D1 绑定或 master key 时，上游是抛异常 → 被它的全局 catch 吞成
// 一句「服务器内部错误」，而那个响应不带 CORS 头，浏览器连这句话都不让前端读，用户
// 只看得到 "Failed to fetch"。connect 先问一次 /config-check，把缺的那一样直接说出来。
// 回归守卫：即时对话的能力门槛认的是「运行时真的有起跳器」，不是「代码里有这条路由」。
//
// 自更新由用户那台 Worker 上的**旧代码**执行，而旧代码不认识 Durable Object——它传上去的
// 新 bundle 不带 INSTANT_TICK 绑定。于是会出现「instantChat:true、workerVersion 也对上了、
// 但 /instant-chat 只能回 503」的中间态。认前两样中的任何一样，前端都会一边说「已经是
// 最新版」一边发一条挂一条。
describe('即时对话能力探测（instantTick）', () => {
  const configCheck = (data: Record<string, unknown>) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({
        success: true,
        data: { ok: true, missing: [], message: 'Worker 配置齐全。', warnings: [], ...data },
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
    })));
  };

  afterEach(() => { vi.unstubAllGlobals(); });

  it('起跳器接上了 → 支持', async () => {
    configCheck({ instantChat: true, instantTick: true, workerVersion: '2026-08-09' });
    expect(await ActiveMsgClient.probeInstantChatSupport()).toBe(true);
  });

  it('代码新了但起跳器没接上（更新过一次的中间态）→ 不支持', async () => {
    configCheck({ instantChat: true, instantTick: false, workerVersion: '2026-08-09' });
    expect(await ActiveMsgClient.probeInstantChatSupport()).toBe(false);
  });

  it('老 bundle 根本不报这个字段 → 不支持（哪怕它自称 instantChat:true）', async () => {
    configCheck({ instantChat: true });
    expect(await ActiveMsgClient.probeInstantChatSupport()).toBe(false);
  });

  // 结论要存下来：真正拦下这一轮的是发消息路上的 resolveInstantChatReadiness，
  // 而它不做逐调用网络探测，只认这份存量。不存 = 这道门形同虚设。
  it('每探一次就把结论存进全局配置（发消息那道门只认存量）', async () => {
    const { ActiveMsgStore } = await import('./activeMsgStore');
    (ActiveMsgStore.saveGlobalConfig as any).mockClear();
    configCheck({ instantChat: true, instantTick: false });
    await ActiveMsgClient.probeInstantChatSupport();
    expect(ActiveMsgStore.saveGlobalConfig).toHaveBeenCalledWith({ instantChatSupported: false });

    (ActiveMsgStore.saveGlobalConfig as any).mockClear();
    configCheck({ instantChat: true, instantTick: true });
    await ActiveMsgClient.probeInstantChatSupport();
    expect(ActiveMsgStore.saveGlobalConfig).toHaveBeenCalledWith({ instantChatSupported: true });
  });

  // ★ 核心回归守卫：「探不到」≠「探到了、答案是不行」。
  //
  // 这两种从前混用同一个 false，于是一次网络抖动（切代理节点、CF 边缘抖一下、D1 冷启动
  // 慢）就足以把 instantChatSupported 写死成 false。那份存量是粘的，用户不碰巧打开设置页
  // 就一直卡在本地生成——线上真实故障就是这么来的：Worker 那头全绿（instantTick:true、
  // 库也齐），用户却连着几小时每一轮都在本地直连生成，而他的本地直连根本不通，只看得到
  // 一条读不懂的网络报错，开关还写着「已开启」。
  describe('探不到的时候一个字都不许写进存量', () => {
    afterEach(() => { storeConfigExtra.value = {}; });

    /** 上次已经探到「跑得动」，这次没问到答案 → 存量必须原样保留。 */
    const expectKeepsPreviousTrue = async () => {
      const { ActiveMsgStore } = await import('./activeMsgStore');
      (ActiveMsgStore.saveGlobalConfig as any).mockClear();
      const result = await ActiveMsgClient.probeInstantChatSupportDetailed();
      expect(result.outcome).toBe('unknown');
      expect(result.supported).toBe(true);
      expect(ActiveMsgStore.saveGlobalConfig).not.toHaveBeenCalled();
    };

    it('网络异常（fetch 直接抛）→ 保留上次探到的 true', async () => {
      storeConfigExtra.value = { instantChatSupported: true };
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Load failed'); }));
      await expectKeepsPreviousTrue();
    });

    it('401 → 说明共享密钥没填对，跟 Worker 跑不跑得动没关系', async () => {
      storeConfigExtra.value = { instantChatSupported: true };
      vi.stubGlobal('fetch', vi.fn(async () => ({
        status: 401,
        text: async () => JSON.stringify({ success: false, error: { code: 'INVALID_CLIENT_TOKEN' } }),
        headers: new Headers({ 'content-type': 'application/json' }),
      })));
      await expectKeepsPreviousTrue();
    });

    it('5xx / 中间设备塞回来的网关页 → 说明线路有问题，同样不是答案', async () => {
      storeConfigExtra.value = { instantChatSupported: true };
      vi.stubGlobal('fetch', vi.fn(async () => ({
        status: 503,
        text: async () => '<html>502 Bad Gateway</html>',
        headers: new Headers({ 'content-type': 'text/html' }),
      })));
      await expectKeepsPreviousTrue();
    });

    // 别矫枉过正：真的问到「跑不动」时该写还得写，否则这道门就形同虚设。
    it('200 但没有 instantTick → 这是明确答案，照写 false', async () => {
      storeConfigExtra.value = { instantChatSupported: true };
      const { ActiveMsgStore } = await import('./activeMsgStore');
      (ActiveMsgStore.saveGlobalConfig as any).mockClear();
      configCheck({ instantChat: true });
      const result = await ActiveMsgClient.probeInstantChatSupportDetailed();
      expect(result.outcome).toBe('unsupported');
      expect(ActiveMsgStore.saveGlobalConfig).toHaveBeenCalledWith({ instantChatSupported: false });
    });
  });
});

describe('连接前的 worker 配置自检', () => {
  /** 按路径分流的 fetch：没列到的路径一律当成功，模拟 init-tenant 那步是通的。 */
  const routeFetch = (routes: Record<string, { status: number; body: unknown }>) => {
    const spy = vi.fn(async (url: string) => {
      const hit = Object.entries(routes).find(([path]) => String(url).includes(path));
      const { status, body } = hit?.[1] ?? { status: 200, body: { success: true, data: {} } };
      return {
        status,
        text: async () => JSON.stringify(body),
        headers: new Headers({ 'content-type': 'application/json' }),
      };
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  };

  const report = (patch: Record<string, unknown>) => ({
    success: true,
    data: { ok: true, missing: [], message: 'Worker 配置齐全。', warnings: [], ...patch },
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('worker 说缺 master key → 报「配置缺失」，并把「去哪儿补」原样交给用户', async () => {
    routeFetch({
      'config-check': {
        status: 200,
        body: report({
          ok: false,
          missing: ['AMSG_MASTER_KEY'],
          message: 'Worker 配置不完整：缺 AMSG_MASTER_KEY（在 Settings → Variables and Secrets 里加，类型选 Secret）。',
        }),
      },
    });

    const error = await ActiveMsgClient.connect().then(() => null, (e) => e);
    expect(readAmsgFailKind(error)).toBe('配置缺失');
    expect((error as Error).message).toContain('AMSG_MASTER_KEY');
    expect((error as Error).message).toContain('Secret');
  });

  it('配置缺失时不再去打 init-tenant——那一步注定失败，且只会报回一句更含糊的话', async () => {
    const spy = routeFetch({
      'config-check': { status: 200, body: report({ ok: false, missing: ['DB'], message: '缺 D1 绑定' }) },
    });

    await ActiveMsgClient.connect().catch(() => {});
    expect(spy.mock.calls.some(([url]) => String(url).includes('init-tenant'))).toBe(false);
  });

  it('只有警告（VAPID 没配齐）→ 连接照样成功，但把警告带回去让界面提示', async () => {
    routeFetch({
      'config-check': {
        status: 200,
        body: report({ warnings: [{ code: 'VAPID_MISSING', message: 'VAPID 没配齐，到点消息不会推送出去。' }] }),
      },
    });

    const result = await ActiveMsgClient.connect();
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.code)).toEqual(['VAPID_MISSING']);
  });

  it('旧 worker 没有这个端点（404）→ 当它不支持自检，照常走原来的连接流程', async () => {
    routeFetch({
      'config-check': { status: 404, body: { success: false, error: { code: 'NOT_FOUND' } } },
    });

    await expect(ActiveMsgClient.connect()).resolves.toMatchObject({ ok: true, warnings: [] });
  });

  it('回执形状对不上就不采信：宁可不自检，也不能把一台好 worker 判成「配置缺失」', async () => {
    // 未知路径回 200 + 一个没有 ok/missing 的 body。照 success 采信的话，ok 会是
    // undefined，一台配置完好的 worker 就被判死了，用户照着提示改哪儿都改不对。
    routeFetch({ 'config-check': { status: 200, body: { success: true, data: {} } } });

    await expect(ActiveMsgClient.connect()).resolves.toMatchObject({ ok: true });
  });

  // 回归守卫：握手（get-user-key）按「地址 / 用户 id / 共享密钥」记忆化，可用户密钥能在
  // 这三样都不变的情况下换代——用户在 Cloudflare 上换掉 AMSG_MASTER_KEY 就是。缓存不作废
  // 的话，「重新连接并验证」拿回来的还是握着旧密钥的老 client：init-tenant 成功、界面报
  // 「连接成功」，此后每一次加密调用 worker 都解不开（即时对话每发一条挂一条、任务到点
  // 全失败），只有整页刷新能恢复。
  it('「重新连接并验证」每按一次都真的重新握手（换过 master key 后旧密钥必须被丢掉）', async () => {
    routeFetch({});
    reiClient.init.mockReset().mockResolvedValue(undefined);

    await ActiveMsgClient.connect();
    await ActiveMsgClient.connect();

    expect(reiClient.init).toHaveBeenCalledTimes(2);
  });
});

// 回归守卫：老 worker（< 2.6.0-next.5）的 GET /messages 不投影 charId，按角色过滤会
// 一条都留不下。要是照直返回空数组，面板会把该角色的任务全标成「远端不存在」，
// 「关闭 2.0」也会以为没什么要取消——两处都是拿半份证据下结论。
describe('ActiveMsgClient.listRemoteTasksForChar 的版本护栏', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('worker 有投影 → 只留本角色的行', async () => {
    vi.spyOn(ActiveMsgClient, 'listAllTasks').mockResolvedValue([
      { uuid: 'task-a', charId: 'char-1' },
      { uuid: 'task-b', charId: 'char-2' },
      { charId: 'char-1' },
    ]);
    await expect(ActiveMsgClient.listRemoteTasksForChar('char-1').then((rows) => rows.map((r) => r.uuid)))
      .resolves.toEqual(['task-a']);
  });

  it('老 worker 没投影（远端有任务、charId 全空）→ 抛错交给调用方降级', async () => {
    vi.spyOn(ActiveMsgClient, 'listAllTasks').mockResolvedValue([
      { uuid: 'task-a' },
      { uuid: 'task-b', charId: null },
    ]);
    await expect(ActiveMsgClient.listRemoteTasksForChar('char-1'))
      .rejects.toThrow(/重新粘贴部署/);
  });

  it('远端确实一条任务都没有 → 空数组（跟版本无关，别误伤）', async () => {
    vi.spyOn(ActiveMsgClient, 'listAllTasks').mockResolvedValue([]);
    await expect(ActiveMsgClient.listRemoteTasksForChar('char-1')).resolves.toEqual([]);
  });
});

// 回归守卫：删角色 / 关闭 2.0 都要把该角色的远端任务清干净——worker 上的任务不随本地
// 删除消失，留着会到点照跑一整轮生成 + 推送（角色都没了还在发消息，每次真烧一轮 LLM）。
describe('ActiveMsgClient.cancelAllTasksForChar', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  /** 远端投影的最小形状（只有 uuid 与子类型参与取消判定）。 */
  const remoteRows = (rows: Array<{ uuid: string; messageSubtype?: string }>) =>
    vi.spyOn(ActiveMsgClient, 'listRemoteTasksForChar')
      .mockResolvedValue(rows.map((r) => ({ ...r, lastError: null })) as any);

  it('以远端清单为准（本地漏掉的「已过点未消费」任务也要取消到）', async () => {
    remoteRows([{ uuid: 'remote-1' }, { uuid: 'remote-2' }]);
    const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask')
      .mockResolvedValue({ uuid: '', alreadyGone: false });

    const { targets, failed } = await ActiveMsgClient.cancelAllTasksForChar('char-1', ['local-only']);
    expect(targets).toEqual(['remote-1', 'remote-2']);
    expect(failed.size).toBe(0);
    expect(cancel.mock.calls.map((c) => c[0])).toEqual(['remote-1', 'remote-2']);
  });

  it('远端读不到（老 worker / 断网）→ 退回本地清单，半份证据也比不取消强', async () => {
    vi.spyOn(ActiveMsgClient, 'listRemoteTasksForChar').mockRejectedValue(new Error('offline'));
    const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask')
      .mockResolvedValue({ uuid: '', alreadyGone: false });

    const { targets } = await ActiveMsgClient.cancelAllTasksForChar('char-1', ['local-1', 'local-2']);
    expect(targets).toEqual(['local-1', 'local-2']);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('单条取消失败只记账，剩下的照样取消完', async () => {
    remoteRows([{ uuid: 't1' }, { uuid: 't2' }, { uuid: 't3' }]);
    vi.spyOn(ActiveMsgClient, 'cancelTask').mockImplementation(async (uuid: string) => {
      if (uuid === 't2') throw new Error('D1 busy');
      return { uuid, alreadyGone: false };
    });

    const { failed } = await ActiveMsgClient.cancelAllTasksForChar('char-1', []);
    expect([...failed]).toEqual(['t2']);
  });

  // 回归守卫：即时对话的行不是定时任务，是用户此刻正等着的一轮聊天。以前这里照远端全量
  // 清单逐条取消，关掉角色的 2.0 开关就会把它一起掐掉：worker 那一跳永远不会跑，客户端
  // 的待收记录还留着，60s 点名查到 gone、outbox 也空，最后落一句「云端已处理这条消息，
  // 但回复没能取回」，用户还得把话重发一遍。过滤口径与面板对账同一把尺。
  it('即时对话的行不取消（关掉 2.0 不该掐掉正在跑的那轮聊天）', async () => {
    remoteRows([
      { uuid: 'scheduled-1' },
      { uuid: 'instant-1', messageSubtype: 'instant-chat' },
      { uuid: 'scheduled-2', messageSubtype: 'chat' },
    ]);
    const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask')
      .mockResolvedValue({ uuid: '', alreadyGone: false });

    const { targets } = await ActiveMsgClient.cancelAllTasksForChar('char-1', []);
    expect(targets).toEqual(['scheduled-1', 'scheduled-2']);
    expect(cancel.mock.calls.map((c) => c[0])).not.toContain('instant-1');
  });
});

// 回归守卫：排程建任务前会把整份 fire_pack PUT 上去，而用户刚发出去的那条即时对话还
// 欠着回复时，云端那一份是 POST /instant-chat 带上去的、比常规的包多一段 chat——worker
// 到点全靠它拿这一轮的对话。盖掉的话 onBeforeFire 当场硬失败（fire_pack 里没有 chat 段），
// 重试梯子上每一跳都是同一个错，用户最后拿到一句「即时对话没能完成」，话还得自己重发。
// 现实触发路径：等回复期间打开该角色的 2.0 面板新建 / 编辑一条定时任务（角色在本地轮里
// 给自己排任务同理）。挂起口径与批量同步共用 owesInstantChatReply 这一把尺。
describe('scheduleCharacterTask 与欠着的即时对话 chat 段', () => {
  const CHAR_ID = 'char-schedule-instant';

  let putBatches: Array<Array<{ namespace: string; key: string }>>;

  beforeEach(() => {
    putBatches = [];
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.putClientState.mockReset().mockImplementation(async (entries: any[]) => {
      putBatches.push(entries);
      return { success: true };
    });
    reiClient._encrypt.mockReset().mockResolvedValue({ iv: 'iv', authTag: 'tag', encryptedData: 'enc' });
    // 模板本体、表情全库、推送登记这些都不在被测范围，桩掉。
    vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
    vi.spyOn(DB, 'getEmojis').mockResolvedValue([] as any);
    vi.spyOn(DB, 'getEmojiCategories').mockResolvedValue([] as any);
    vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockResolvedValue('SYS_PROMPT_MARKER');
    vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({ apiMessages: [] } as any);
    vi.spyOn(ChatPrompts, 'filterVisibleEmojis').mockReturnValue({ emojis: [], categories: [] } as any);
    vi.spyOn(ActiveMsgClient, 'registerPushSubscription').mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ success: true, data: { uuid: 'remote-uuid', status: 'pending' } }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }));
    clearInstantChatPending(CHAR_ID);
  });
  afterEach(() => {
    clearInstantChatPending(CHAR_ID);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const schedule = () => ActiveMsgClient.scheduleCharacterTask({
    char: { id: CHAR_ID, name: '小满', memories: [], activeMsg2Config: { enabled: true, tasks: [] } } as any,
    config: { enabled: true, tasks: [] } as any,
    task: {
      mode: 'auto',
      firstSendTime: new Date(Date.now() + 3600_000).toISOString(),
      recurrenceType: 'none',
    },
    userProfile: { name: '小明' } as any,
    groups: [],
    realtimeConfig: {} as any,
    apiConfig: { baseUrl: 'https://api.example.dev', apiKey: 'sk-test', model: 'gpt-test' } as any,
  });

  /** 这次排程往云端写了哪些 key。 */
  const writtenKeys = () => putBatches.flat().map((entry) => entry.key);

  it('没欠着回复 → fire_pack 照常整份覆盖上去', async () => {
    await schedule();
    expect(writtenKeys()).toContain(AMSG_FIRE_PACK_KEY);
  });

  it('欠着回复 → 这一批把 fire_pack 抽掉，tool_pack / tool_config 照写、任务照建', async () => {
    setInstantChatPending(CHAR_ID, 'uuid-waiting');

    const result = await schedule();

    expect(writtenKeys(), '盖掉 chat 段 = 用户正等的那条回复到点必然硬失败')
      .not.toContain(AMSG_FIRE_PACK_KEY);
    expect(writtenKeys()).toContain(AMSG_TOOL_PACK_KEY);
    expect(writtenKeys()).toContain(AMSG_TOOL_CONFIG_KEY);
    // 任务本身照建：等回复不是拒绝排程的理由，抽掉的那份包由销账后的状态同步补上。
    expect(result.uuid).toBe('remote-uuid');
  });
});

// 回归守卫：删角色时清云端 client_state 的清法。
// 一个角色的条目不止 fire_pack / tool_pack —— 还有活跃会话租约，以及键名带 clientTaskId
// 的旁路存储（`xhs_session:<id>`，任务记录被 prune 掉之后就再也拼不出来）。所以清法是
// 「先读回来有什么、再把有内容的写空」，而不是照着已知键名盲写：putClientState 是 upsert，
// 盲写会把本来不存在的条目建出来，清理反倒变成新建。
describe('clearNamespaceValuesOrThrow', () => {
  const clientWithState = (entries: any[], put = vi.fn().mockResolvedValue({ success: true })) => ({
    getClientState: vi.fn().mockResolvedValue({ success: true, data: { entries } }),
    putClientState: put,
  } as any);

  it('读回来有什么清什么，一次请求写空（xhs_session 这种拼不出的键也在内）', async () => {
    const put = vi.fn().mockResolvedValue({ success: true });
    const client = clientWithState([
      { key: 'fire_pack', value: '{"v":2}' },
      { key: 'tool_pack', value: '{}' },
      { key: 'chat_presence', value: '{}' },
      { key: 'xhs_session:2f1c-任务id', value: '{"notes":[]}' },
    ], put);

    const cleared = await clearNamespaceValuesOrThrow(client, 'amsg:char:char-1');

    expect(cleared).toEqual(['fire_pack', 'tool_pack', 'chat_presence', 'xhs_session:2f1c-任务id']);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0].map((e: any) => [e.namespace, e.key, e.value])).toEqual([
      ['amsg:char:char-1', 'fire_pack', ''],
      ['amsg:char:char-1', 'tool_pack', ''],
      ['amsg:char:char-1', 'chat_presence', ''],
      ['amsg:char:char-1', 'xhs_session:2f1c-任务id', ''],
    ]);
  });

  it('namespace 是空的 → 一条都不写（别把不存在的键 upsert 出来）', async () => {
    const put = vi.fn().mockResolvedValue({ success: true });
    await expect(clearNamespaceValuesOrThrow(clientWithState([], put), 'amsg:char:char-1'))
      .resolves.toEqual([]);
    expect(put).not.toHaveBeenCalled();
  });

  it('已经是空壳的条目跳过（重复删同一个角色不白发请求体）', async () => {
    const put = vi.fn().mockResolvedValue({ success: true });
    const client = clientWithState([
      { key: 'fire_pack', value: '' },
      { key: 'tool_pack', value: '{}' },
    ], put);

    await expect(clearNamespaceValuesOrThrow(client, 'amsg:char:char-1')).resolves.toEqual(['tool_pack']);
    expect(put.mock.calls[0][0]).toHaveLength(1);
  });

  it('读不到云端状态 → 抛错（调用方按「没清掉」提示，不能当成清干净了）', async () => {
    const client = {
      getClientState: vi.fn().mockResolvedValue({ success: false, error: { message: 'D1 busy' } }),
      putClientState: vi.fn(),
    } as any;
    await expect(clearNamespaceValuesOrThrow(client, 'amsg:char:char-1')).rejects.toThrow(/D1 busy/);
    expect(client.putClientState).not.toHaveBeenCalled();
  });

  it('写空失败 → 抛错', async () => {
    const client = clientWithState(
      [{ key: 'fire_pack', value: '{"v":2}' }],
      vi.fn().mockRejectedValue(new Error('worker down')),
    );
    await expect(runWithTimers(clearNamespaceValuesOrThrow(client, 'amsg:char:char-1')))
      .rejects.toThrow(/worker down/);
  });
});

// 回归守卫：本地角色头像是 base64，直接塞进排程请求会被 worker 拒掉并 warn
// （`avatarUrl 不合法，已置空`），每排一条任务刷一条。这里按 worker 同一把尺先筛。
describe('toRemoteAvatarUrl', () => {
  it('公网 http(s) 图片 URL → 原样传', () => {
    expect(toRemoteAvatarUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(toRemoteAvatarUrl('http://example.com/a.png')).toBe('http://example.com/a.png');
  });

  it('base64 data URI → 不传（worker 明确拒收 data:）', () => {
    expect(toRemoteAvatarUrl('data:image/png;base64,iVBORw0KGgo=')).toBeUndefined();
    expect(toRemoteAvatarUrl('DATA:image/png;base64,iVBORw0KGgo=')).toBeUndefined();
  });

  it('超过 2048 字符 → 不传（worker 的长度上限）', () => {
    expect(toRemoteAvatarUrl(`https://example.com/${'a'.repeat(2048)}.png`)).toBeUndefined();
  });

  it('空 / 不是 URL / 非 http 协议 → 不传', () => {
    expect(toRemoteAvatarUrl(undefined)).toBeUndefined();
    expect(toRemoteAvatarUrl('   ')).toBeUndefined();
    expect(toRemoteAvatarUrl('./avatars/sully.png')).toBeUndefined();
    expect(toRemoteAvatarUrl('blob:http://localhost/abc')).toBeUndefined();
  });
});

// 回归守卫：「清除云端状态」之后 AI 任务必须还能跑。
//
// 实测踩过：点完那个按钮，聊多少轮天任务都一直失败。云端有三份数据，角色上下文
// (fire_pack) 和角色工具数据 (tool_pack) 每轮聊完都会重新同步，只有全局的 tool_config
// 是「改配置时才传」——清空之后没有任何一条路会补它，而 worker 到点三份缺一就硬失败。
// 弹窗还写着「下次聊天会重新同步」，等于界面在骗人。
//
// 任务表跟 client_state 不在一起、不受清空影响，所以「任务还活着、凭据却没了」
// 只有这一个入口。补传就放在这里，不必让每轮同步都白传一遍。
describe('ActiveMsgClient.clearClientState', () => {
  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.clearClientState.mockReset().mockResolvedValue({ success: true, data: { deleted: 7 } });
    reiClient.putClientState.mockReset().mockResolvedValue({ success: true });
  });

  const toolConfigEntries = () => reiClient.putClientState.mock.calls.flatMap((c: any[]) => c[0]);

  it('清完立刻把全局 tool_config 补回去', async () => {
    const result = await ActiveMsgClient.clearClientState({ newsEnabled: true } as any);

    expect(result).toEqual({ deleted: 7, toolConfigRestored: true });
    const entries = toolConfigEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ namespace: 'amsg:global', key: 'tool_config' });
    expect(JSON.parse(entries[0].value)).toMatchObject({ v: 1, newsEnabled: true });
  });

  it('顺序是先清后补，别把刚补的又清掉', async () => {
    const order: string[] = [];
    reiClient.clearClientState.mockImplementation(async () => {
      order.push('clear');
      return { success: true, data: { deleted: 1 } };
    });
    reiClient.putClientState.mockImplementation(async () => {
      order.push('put');
      return { success: true };
    });

    await ActiveMsgClient.clearClientState(undefined);
    expect(order).toEqual(['clear', 'put']);
  });

  it('没配实时感知也照样补一份（工具全关的凭据也是凭据，缺了 worker 一样硬失败）', async () => {
    await ActiveMsgClient.clearClientState(undefined);
    expect(toolConfigEntries()).toHaveLength(1);
  });

  it('补传失败 → 清空本身仍算成功，用返回值让调用方去提示', async () => {
    reiClient.putClientState.mockRejectedValue(new Error('offline'));
    await expect(runWithTimers(ActiveMsgClient.clearClientState(undefined)))
      .resolves.toEqual({ deleted: 7, toolConfigRestored: false });
  });

  it('清空本身失败 → 抛错，也不去补传（云端还是原样）', async () => {
    reiClient.clearClientState.mockResolvedValue({ success: false, error: { message: 'D1 busy' } });
    await expect(ActiveMsgClient.clearClientState(undefined)).rejects.toThrow(/D1 busy/);
    expect(reiClient.putClientState).not.toHaveBeenCalled();
  });
});

// 云端状态的写口：调用方只给 namespace/key/value，连接与鉴权都在客户端内部备好。
// 钉住「写到指定 namespace/key」，免得别处为了写一条状态自己另建一条连接。
describe('ActiveMsgClient.writeClientStateValue', () => {
  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.putClientState.mockReset().mockResolvedValue({ success: true });
  });

  it('把值写到指定的 namespace/key', async () => {
    await ActiveMsgClient.writeClientStateValue('amsg:char:c1', 'self_log', '{"v":1}');

    expect(reiClient.putClientState).toHaveBeenCalledTimes(1);
    const entries = reiClient.putClientState.mock.calls[0][0];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      namespace: 'amsg:char:c1',
      key: 'self_log',
      value: '{"v":1}',
    });
    expect(entries[0].updatedAt).toEqual(expect.any(Number));
  });

  it('写失败要抛错，不能静默留着云端的旧内容', async () => {
    reiClient.putClientState.mockResolvedValue({ success: false, error: { message: 'D1 busy' } });
    await expect(runWithTimers(ActiveMsgClient.writeClientStateValue('amsg:char:c1', 'self_log', 'x')))
      .rejects.toThrow(/D1 busy/);
  });
});

// 回归守卫：按 namespace 写空的清法只服务「删角色」。要是哪天被顺手用在全局
// namespace 上，tool_config 会被清成空壳 —— 症状跟上面那条一模一样，而且更隐蔽
// （不是删行，是留个空值，读得到但 parse 不出来）。
describe('clearNamespaceValuesOrThrow 的全局 namespace 护栏', () => {
  it('全局 namespace 直接拒绝，一个请求都不发', async () => {
    const getClientState = vi.fn();
    await expect(clearNamespaceValuesOrThrow({ getClientState } as any, 'amsg:global'))
      .rejects.toThrow(/全局云端状态不能按 namespace 清空/);
    expect(getClientState).not.toHaveBeenCalled();
  });
});

// 回归守卫（时区统一 ①）：fire_pack 的时间参照系与「模板不烤时间」。
//   - tzId：角色开了自定义时区用角色的，没开用设备的（worker 渲染一切时间的参照系）；
//   - 烤进模板的 buildSystemPrompt 必须收到 skipTimeAwareness——否则「现在是 X」被
//     烤死在模板里，到点渲染时就是一句过期的时间，和槽位现算的当前时间打架；
//   - 【角色系统设定】之后补一行「设定是快照，与当前时刻矛盾以当前本地时间为准」；
//   - 槽位不动：当前时间仍由 worker 到点用 AMSG_SLOT_CURRENT_TIME 现算填入。
describe('buildFirePack 的时区参照系与模板（①）', () => {
  const baseChar = (over: Record<string, unknown> = {}) => ({
    id: 'char-1',
    name: '小满',
    memories: [],
    ...over,
  }) as any;
  const user = { name: '小明' } as any;

  // 具体的 MockInstance 泛型跟着 buildSystemPrompt 的 11 个参数走，写全没有信息量。
  let systemPromptSpy: { mock: { calls: unknown[][] } };

  beforeEach(() => {
    // 模板本体不在被测范围：桩掉重依赖，测打包逻辑本身。
    vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
    systemPromptSpy = vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockResolvedValue('SYS_PROMPT_MARKER');
    vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({ apiMessages: [] } as any);
    vi.spyOn(ChatPrompts, 'filterVisibleEmojis').mockReturnValue({ emojis: [], categories: [] } as any);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const pack = (char: any) => buildFirePack(char, user, [], undefined, { all: [], categories: [] });

  it('角色开了自定义时区 → tzId 用角色的', async () => {
    const out = await pack(baseChar({ customTimezoneEnabled: true, customTimezone: 'Asia/Tokyo' }));
    expect(out.tzId).toBe('Asia/Tokyo');
  });

  it('没开自定义时区 → tzId 用设备的', async () => {
    const out = await pack(baseChar());
    expect(out.tzId).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('buildSystemPrompt 收到 forFirePack —— 打包时刻的状态一律不烤进模板', async () => {
    await pack(baseChar());
    expect(systemPromptSpy).toHaveBeenCalledTimes(1);
    // 第 12 个位置参数是 promptOptions（见 chatPrompts.buildSystemPrompt 签名）。
    // 这个开关一次性关掉时间块 / 真实世界感知 / 日程 / 音乐 / 刚打完电话 / 群聊相对时间 /
    // 生活记录代记 / [schedule_message] 教学，清单见 ChatPrompts.PromptBuildOptions。
    expect(systemPromptSpy.mock.calls[0][11]).toEqual({ forFirePack: true });
  });

  it('当前时间槽位保留：worker 到点现算填入（1.0 提示块的「现在是」也是槽位）', async () => {
    const out = await pack(baseChar());
    expect(out.template).toContain(`当前本地时间（你所在地）：${AMSG_SLOT_CURRENT_TIME}`);
    expect(out.template).toContain(`现在是 ${AMSG_SLOT_CURRENT_TIME}`);
  });

  it('随包带上用户设的连发上限；没设就不带（worker 侧用默认值）', async () => {
    const withLimit = await pack(baseChar({ activeMsg2Config: { enabled: true, maxUnansweredSends: 5 } }));
    expect(withLimit.maxUnansweredSends).toBe(5);
    const unlimited = await pack(baseChar({ activeMsg2Config: { enabled: true, maxUnansweredSends: 0 } }));
    expect(unlimited.maxUnansweredSends).toBe(0);
    const unset = await pack(baseChar());
    expect(unset.maxUnansweredSends).toBeUndefined();
  });

  // 回归守卫：用户设备的时区以前一个字都没上云。角色只看得到自己那边的钟，
  // 「晚上九点跟他说一声」在异国恋角色手里就是排到用户的凌晨三点，而且它无从察觉。
  it('随包带上用户设备时区，并在当前时间后面留「对方那边几点」的槽位', async () => {
    const out = await pack(baseChar({ customTimezoneEnabled: true, customTimezone: 'America/New_York' }));
    expect(out.userTzId).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // 两个钟必须挨在一起、各自标明主语，别散落在 prompt 两头长成两个打架的时间。
    expect(out.template).toContain(`当前本地时间（你所在地）：${AMSG_SLOT_CURRENT_TIME}`);
    expect(out.template).toContain(AMSG_SLOT_USER_CLOCK);
    expect(out.template.indexOf(AMSG_SLOT_USER_CLOCK))
      .toBeGreaterThan(out.template.indexOf(AMSG_SLOT_CURRENT_TIME));
  });

  // 回归守卫：前台每轮都有「你身处 X 时区……对方可能在不同时区」，而 fire 侧的角色设定是
  // skipTimeAwareness 建的、整块时间感知都被抹掉了。不在打包时补回来的话，最容易撞用户
  // 睡觉的恰恰是主动消息。这段文案是静态的，所以直接烤进模板。
  it('开了自定义时区的角色，时差说明烤进模板', async () => {
    const out = await pack(baseChar({ customTimezoneEnabled: true, customTimezone: 'America/New_York' }));
    expect(out.template).toContain('你身处');
    expect(out.template).toContain('存在时差');
    // 位置在当前时间之后：那句话说的就是「上面的当前时间是你那边的」。
    expect(out.template.indexOf('你身处')).toBeGreaterThan(out.template.indexOf(AMSG_SLOT_CURRENT_TIME));
  });

  it('没开自定义时区的角色不注入时差说明（跟前台一致）', async () => {
    expect((await pack(baseChar())).template).not.toContain('你身处');
  });

  // 回归守卫：1.0 提示块里「生活在继续」和「别查岗」两行。少了它们，连发几条的
  // 主动消息容易退化成催回复和喝水早睡式说教刷屏。
  it('1.0 提示块带「日子也在往前过」与「关心别变成查岗」', async () => {
    const { template } = await pack(baseChar());
    expect(template).toContain('日子也在往前过');
    expect(template).toContain('关心别变成查岗');
  });

  // 回归守卫：timeAwarenessEnabled=false 的架空角色在前台连今天几号都读不到
  // （buildTimeAwarenessBlock 直接返回空串），主动消息这边却精确报出年月日 + 星期。
  // 同一个开关不能有两套行为。
  describe('关掉时间感知的角色：模板里一个钟都不给', () => {
    const noTime = () => pack(baseChar({
      timeAwarenessEnabled: false,
      customTimezoneEnabled: true,
      customTimezone: 'America/New_York',
    }));

    it('当前时间 / 1.0 提示块的「现在是」/ 距上次多久 / 对方那边几点，全都不进模板', async () => {
      const { template } = await noTime();
      expect(template).not.toContain(AMSG_SLOT_CURRENT_TIME);
      expect(template).not.toContain('当前本地时间');
      expect(template).not.toContain('现在是');
      expect(template).not.toContain(AMSG_SLOT_TIME_SINCE_USER);
      expect(template).not.toContain(AMSG_SLOT_USER_CLOCK);
      expect(template).not.toContain('你身处');
    });

    it('跟时间无关的几段照留（别顺手把整个「当前时刻补充」砍掉）', async () => {
      const { template } = await noTime();
      expect(template).toContain('【当前时刻补充】');
      expect(template).toContain(AMSG_SLOT_SCENE);
      expect(template).toContain(AMSG_SLOT_TASK_LIST);
      expect(template).toContain(AMSG_SLOT_REALTIME_WORLD);
      // 1.0 提示块本身还在，只是不报钟了
      expect(template).toContain('【1.0 风格主动消息提示】');
    });

    it('时间感知开着的角色照常有这几行（免得上面几条永远成立）', async () => {
      const { template } = await pack(baseChar());
      expect(template).toContain(AMSG_SLOT_CURRENT_TIME);
      expect(template).toContain(AMSG_SLOT_TIME_SINCE_USER);
      expect(template).toContain(AMSG_SLOT_USER_CLOCK);
    });
  });

  // 「此刻在做什么」不烤成文字，随包带原始作息表让 worker 到点现挑。烤死的话，
  // 凌晨三点触发时角色会照着中午打的包说「我在健身房呢」。
  it('作息表随包带原始数据 + 槽位跟在当前时间后面', async () => {
    vi.spyOn(dailySchedule, 'getDailyScheduleForChar').mockResolvedValue({
      id: 's', charId: 'char-1', date: '2026-08-02', generatedAt: 0,
      slots: [{ startTime: '08:00', activity: '晨跑' }],
    } as any);

    const out = await pack(baseChar({ scheduleFeatureEnabled: true }));
    expect(out.scene?.schedule?.slots).toHaveLength(1);
    expect(out.scene?.charId).toBe('char-1');
    expect(out.template).toContain(`${AMSG_SLOT_USER_CLOCK}${AMSG_SLOT_SCENE}`);
  });

  // 回归守卫：作息表里只有「几点做什么」，没有日期。周五晚打的包周日上午触发时，
  // 光按墙钟时分照样挑得出「09:00 晨会」。带上打包那天的日期，到点先比日期再用。
  it('作息表随包带打包那天的日期（角色当地日历日）', async () => {
    vi.spyOn(dailySchedule, 'getDailyScheduleForChar').mockResolvedValue({
      id: 's', charId: 'char-1', date: '2026-08-02', generatedAt: 0,
      slots: [{ startTime: '08:00', activity: '晨跑' }],
    } as any);

    const out = await pack(baseChar({
      scheduleFeatureEnabled: true,
      customTimezoneEnabled: true,
      customTimezone: 'America/New_York',
    }));
    expect(out.scene?.dateKey).toBe(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()),
    );
  });

  it('角色没开日程 → scene 为 null（槽位到点被抹平）', async () => {
    const out = await pack(baseChar());
    expect(out.scene).toBeNull();
  });

  // 天气 / 热搜 / 今日节日跟当前时间一样是「此刻的读数」：模板里只留槽位，worker 到点
  // 现拉现填。槽位没了的话主动消息就退回到完全感知不到外面世界的样子。
  it('实时世界留槽位，且模板里没有烤死的天气热搜', async () => {
    const out = await pack(baseChar());
    expect(out.template).toContain(AMSG_SLOT_REALTIME_WORLD);
    expect(out.template).not.toContain('真实世界感知系统');
    expect(out.template).not.toContain('实时天气');
  });

  it('【角色系统设定】之后补快照说明行，位置在设定正文与对话上下文之间', async () => {
    const out = await pack(baseChar());
    const noteIdx = out.template.indexOf('最近一次聊天时的快照');
    expect(noteIdx).toBeGreaterThan(out.template.indexOf('SYS_PROMPT_MARKER'));
    expect(noteIdx).toBeLessThan(out.template.indexOf('【最近对话上下文】'));
    expect(out.template).toContain('以下方「当前时刻补充」为准');
  });

  // 回归守卫：历史消息 content 是数组时（视觉模型的 [{type:'text'},{type:'image_url'}] 格式），
  // 转写进【最近对话上下文】的那一行不能把整段 data:image/...;base64,... 塞进模板——真机一张图
  // 轻松几百 KB base64，排程任务的载荷直接被撑成体积炸弹，模型也用不着读 base64 才知道有图。
  // 参照 worker 侧 restoreEvalPrompt 的 flattenContent：文本部分照抄，image_url 部分压成
  // [图片]，别的类型丢弃。
  it('历史里的图片消息压成 [图片] 占位，不把 base64 编进模板', async () => {
    const longBase64 = 'data:image/png;base64,' + 'A'.repeat(500);
    vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({
      apiMessages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '你看这张图' },
            { type: 'image_url', image_url: { url: longBase64 } },
          ],
        },
      ],
    } as any);

    const out = await pack(baseChar());
    expect(out.template).toContain('[图片]');
    expect(out.template).toContain('你看这张图');
    expect(out.template).not.toContain('data:');
  });

  it('纯文本数组内容照常保留原文', async () => {
    vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({
      apiMessages: [
        { role: 'user', content: [{ type: 'text', text: '早上好呀' }] },
      ],
    } as any);

    const out = await pack(baseChar());
    expect(out.template).toContain('早上好呀');
  });
});

// ─── ① 订阅自检 ───
// 回归守卫：旧实现拿到已有订阅**无条件复用**——换过 VAPID 后绑旧公钥的订阅发推必 403，
// 浏览器僵尸化的死端点（permanently-removed.invalid）也照单收。这两种都得先退订再重订。

/** bytesToB64u([1,2,3]) === 'AQID'（btoa('\x01\x02\x03')），下面拿它当 VAPID 公钥比对。 */
const VAPID_AQID = 'AQID';

const makeSub = (endpoint: string, keyBytes: number[] | null) => ({
  endpoint,
  options: { applicationServerKey: keyBytes ? Uint8Array.from(keyBytes).buffer : null },
  unsubscribe: vi.fn().mockResolvedValue(true),
  toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
});

describe('dropStaleSubscription（① 死端点 / 公钥不一致先退订）', () => {
  it('死端点（permanently-removed.invalid）→ 退订并返回 null', async () => {
    const sub = makeSub('https://permanently-removed.invalid/x', [1, 2, 3]);
    await expect(runWithTimers(dropStaleSubscription(sub as any, VAPID_AQID))).resolves.toBeNull();
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('绑的公钥与目标 worker 不一致 → 退订并返回 null', async () => {
    const sub = makeSub('https://fcm.googleapis.com/send/x', [9, 9, 9]);
    await expect(runWithTimers(dropStaleSubscription(sub as any, VAPID_AQID))).resolves.toBeNull();
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('公钥一致的健康订阅 → 原样复用，不退订', async () => {
    const sub = makeSub('https://fcm.googleapis.com/send/x', [1, 2, 3]);
    await expect(dropStaleSubscription(sub as any, VAPID_AQID)).resolves.toBe(sub);
    expect(sub.unsubscribe).not.toHaveBeenCalled();
  });

  it('公钥读不出来（options 抛错）→ 按可复用处理（与 instant/proactive 同款 fall-through）', async () => {
    const sub = {
      endpoint: 'https://fcm.googleapis.com/send/x',
      get options(): any { throw new Error('not exposed'); },
      unsubscribe: vi.fn(),
      toJSON: () => ({}),
    };
    await expect(dropStaleSubscription(sub as any, VAPID_AQID)).resolves.toBe(sub);
    expect(sub.unsubscribe).not.toHaveBeenCalled();
  });

  it('没有订阅 → null', async () => {
    await expect(dropStaleSubscription(null, VAPID_AQID)).resolves.toBeNull();
  });
});

// 回归守卫（补）：建订阅这一步不许走 ReiClient.subscribePush——那是裸的
// pushManager.subscribe()，刚退订完的窗口期里浏览器会吐 permanently-removed.invalid
// 哨兵，它照单收下。死端点一旦被登记进 worker，用户看到「订阅已准备完成」，到点却一条
// 都收不到，两边都没有任何报错。这一组钉住「走带重试的共用实现」。
describe('ActiveMsgClient.ensurePushSubscription（① 不再无条件复用旧订阅）', () => {
  const FRESH_ENDPOINT = 'https://fcm.googleapis.com/send/fresh';

  /** subscribe() 依次吐出 endpoints 里的端点；用尽后一直吐最后一个。 */
  const stubPushEnv = (existing: any, endpoints: string[] = [FRESH_ENDPOINT]) => {
    const queue = [...endpoints];
    const subscribe = vi.fn().mockImplementation(async () => {
      const endpoint = queue.length > 1 ? queue.shift()! : queue[0];
      return {
        endpoint,
        options: { applicationServerKey: Uint8Array.from([1, 2, 3]).buffer },
        unsubscribe: vi.fn().mockResolvedValue(true),
        toJSON: () => ({ endpoint, keys: { p256dh: 'p2', auth: 'a2' } }),
      };
    });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: { getSubscription: vi.fn().mockResolvedValue(existing), subscribe },
        }),
      },
    });
    vi.stubGlobal('window', { PushManager: class {} });
    vi.stubGlobal('Notification', { permission: 'granted' });
    return subscribe;
  };

  beforeEach(() => {
    reiClient.getVapidPublicKey.mockReset().mockResolvedValue(VAPID_AQID);
    reiClient.subscribePush.mockReset();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('已有订阅是死端点 → 退订后重订，返回新订阅', async () => {
    const dead = makeSub('https://permanently-removed.invalid/x', [1, 2, 3]);
    const subscribe = stubPushEnv(dead);

    const result = await runWithTimers(ActiveMsgClient.ensurePushSubscription());

    expect(dead.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect((result as any).endpoint).toBe(FRESH_ENDPOINT);
  });

  it('已有订阅绑着旧 VAPID 公钥 → 退订后按 worker 当前公钥重订', async () => {
    const stale = makeSub('https://fcm.googleapis.com/send/x', [9, 9, 9]);
    const subscribe = stubPushEnv(stale);

    const result = await runWithTimers(ActiveMsgClient.ensurePushSubscription());

    expect(stale.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect((result as any).endpoint).toBe(FRESH_ENDPOINT);
  });

  it('订阅一律不经 ReiClient.subscribePush（它不做僵尸重试）', async () => {
    stubPushEnv(null);

    await runWithTimers(ActiveMsgClient.ensurePushSubscription());

    expect(reiClient.subscribePush).not.toHaveBeenCalled();
  });

  it('重订第一次拿到僵尸哨兵、重试拿到活端点 → 返回活的那个', async () => {
    const subscribe = stubPushEnv(null, ['https://permanently-removed.invalid/x', FRESH_ENDPOINT]);

    const result = await runWithTimers(ActiveMsgClient.ensurePushSubscription());

    expect(subscribe).toHaveBeenCalledTimes(2);
    expect((result as any).endpoint).toBe(FRESH_ENDPOINT);
  });

  it('重试到底还是僵尸 → 抛 端点僵尸，绝不把死端点交出去', async () => {
    stubPushEnv(null, ['https://permanently-removed.invalid/x']);

    const failure = await runWithTimers(ActiveMsgClient.ensurePushSubscription().catch((e) => e));

    expect(failure).toBeInstanceOf(Error);
    expect(readAmsgFailKind(failure)).toBe('端点僵尸');
  });

  it('已有订阅健康且公钥一致 → 原样复用，不重订', async () => {
    const healthy = makeSub('https://fcm.googleapis.com/send/x', [1, 2, 3]);
    stubPushEnv(healthy);

    const result = await ActiveMsgClient.ensurePushSubscription();

    expect(healthy.unsubscribe).not.toHaveBeenCalled();
    expect(reiClient.subscribePush).not.toHaveBeenCalled();
    expect((result as any).endpoint).toBe('https://fcm.googleapis.com/send/x');
  });
});

// ─── ②③ 共用的角色/任务夹具 ───
const FUTURE_ISO = () => new Date(Date.now() + 3600_000).toISOString();
const PAST_ISO = () => new Date(Date.now() - 24 * 3600_000).toISOString();

const remoteTask = (taskUuid: string, extra: Record<string, unknown> = {}) => ({
  taskUuid,
  clientTaskId: `client-${taskUuid}`,
  mode: 'auto',
  firstSendTime: FUTURE_ISO(),
  recurrenceType: 'none',
  expirePolicy: 'expire',
  source: 'user',
  status: 'scheduled',
  createdAt: 1,
  ...extra,
});

describe('ActiveMsgClient.registerPushSubscription（② 订阅按用户登记一份）', () => {
  const SUB_JSON = { endpoint: 'https://fcm.googleapis.com/send/new', keys: { p256dh: 'p', auth: 'a' } };

  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.updateMessage.mockReset().mockResolvedValue({ success: true });
    reiClient.putPushSubscription.mockReset().mockResolvedValue({ success: true, data: { updatedAt: 1 } });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('把当前订阅覆盖写到 worker 上那一份', async () => {
    const ensure = vi.spyOn(ActiveMsgClient, 'ensurePushSubscription').mockResolvedValue(SUB_JSON as any);

    await ActiveMsgClient.registerPushSubscription();

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(reiClient.putPushSubscription).toHaveBeenCalledWith(SUB_JSON);
  });

  // 订阅刷新曾经是「照本地任务清单逐条 PUT」，本地没有任务就直接收工。角色在 fire 里
  // 给自己排的任务客户端从没见过，于是永远刷不到——推不出去、状态记不下、客户端更不
  // 知道它存在。订阅按用户存一份之后，登记跟本地有没有任务彻底无关。
  it('本地一条任务都没有，订阅照样登记上去', async () => {
    vi.spyOn(DB, 'getAllCharacters').mockResolvedValue([{ id: 'char-x' }] as any);
    vi.spyOn(ActiveMsgClient, 'ensurePushSubscription').mockResolvedValue(SUB_JSON as any);

    await ActiveMsgClient.registerPushSubscription();

    expect(reiClient.putPushSubscription).toHaveBeenCalledWith(SUB_JSON);
    // 一条任务都没碰：订阅不再挂在任务行上。
    expect(reiClient.updateMessage).not.toHaveBeenCalled();
  });

  it('登记失败往外抛，调用方据此保留标记下次再试', async () => {
    vi.spyOn(ActiveMsgClient, 'ensurePushSubscription').mockResolvedValue(SUB_JSON as any);
    reiClient.putPushSubscription.mockRejectedValue(new Error('worker 拒绝了订阅'));

    await expect(ActiveMsgClient.registerPushSubscription()).rejects.toThrow('worker 拒绝了订阅');
  });
});

// 回归守卫：换一台 worker 就是换一个空的 D1，而浏览器这侧的订阅一个字都没变——
// SW 的 pushsubscriptionchange 不会响，refreshPushSubscriptionIfMarked 也就没有标记
// 可消费。于是面板全绿、连接验证通过，worker 到点却读不到那份用户级订阅，直接抛
// PUSH_SUBSCRIPTION_MISSING：消息一条都发不出来，用户这侧看不到任何异常。
// 连接这一步必须顺手把当前订阅覆盖写回去。
describe('ActiveMsgClient.connect（连接后补登记推送订阅）', () => {
  const stubConnectEnv = (permission: string, existing: any) => {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: { getSubscription: vi.fn().mockResolvedValue(existing) },
        }),
      },
    });
    vi.stubGlobal('window', { PushManager: class {} });
    vi.stubGlobal('Notification', { permission });
    // init-tenant 一律成功：这一组测的是它之后那步补登记。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ success: true, data: {} }),
      headers: new Headers({ 'content-type': 'application/json' }),
    }));
  };

  beforeEach(() => { reiClient.init.mockReset().mockResolvedValue(undefined); });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('浏览器已有订阅 → 连接后把它覆盖写到这台 worker 上', async () => {
    stubConnectEnv('granted', makeSub('https://fcm.googleapis.com/send/x', [1, 2, 3]));
    const register = vi.spyOn(ActiveMsgClient, 'registerPushSubscription').mockResolvedValue(undefined);

    await expect(ActiveMsgClient.connect()).resolves.toMatchObject({ ok: true });

    expect(register).toHaveBeenCalledTimes(1);
  });

  it('通知权限还没授予 → 不补登记，连接时也不弹权限框', async () => {
    stubConnectEnv('default', null);
    const register = vi.spyOn(ActiveMsgClient, 'registerPushSubscription').mockResolvedValue(undefined);

    await expect(ActiveMsgClient.connect()).resolves.toMatchObject({ ok: true });

    expect(register).not.toHaveBeenCalled();
  });

  it('权限有了但还没订阅 → 那是「开启通知与推送订阅」那步的事，连接不替用户开', async () => {
    stubConnectEnv('granted', null);
    const register = vi.spyOn(ActiveMsgClient, 'registerPushSubscription').mockResolvedValue(undefined);

    await ActiveMsgClient.connect();

    expect(register).not.toHaveBeenCalled();
  });

  // init-tenant 过了、鉴权也通了，连接本身就是成功的。补登记只是顺手的一句自检，
  // 它挂了不该把连接判成失败——否则用户会被指去改一堆根本没错的配置。
  it('补登记失败 → 连接照样算成功', async () => {
    stubConnectEnv('granted', makeSub('https://fcm.googleapis.com/send/x', [1, 2, 3]));
    vi.spyOn(ActiveMsgClient, 'registerPushSubscription').mockRejectedValue(new Error('worker 拒绝了订阅'));

    await expect(ActiveMsgClient.connect()).resolves.toMatchObject({ ok: true });
  });
});

describe('ActiveMsgClient.refreshApiCredentialsForPendingTasks（③ 凭据变更重传）', () => {
  const API = { baseUrl: 'https://api.example.com/v1', apiKey: 'new-key', model: 'gpt-x' } as any;

  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.updateMessage.mockReset().mockResolvedValue({ success: true });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('只刷「开着 2.0 且 pending 的 AI 任务」，三字段载荷；单独 API 的角色写单独 API 的值', async () => {
    vi.spyOn(DB, 'getAllCharacters').mockResolvedValue([
      { id: 'char-a', activeMsg2Config: { enabled: true, tasks: [
        remoteTask('a1'),
        remoteTask('a2', { mode: 'fixed', expirePolicy: 'force' }),   // fixed 不走 LLM，不动
        remoteTask('a3', { firstSendTime: PAST_ISO() }),               // 过点，不动
      ] } },
      { id: 'char-b', activeMsg2Config: { enabled: false, tasks: [remoteTask('b1')] } }, // 关了 2.0，不动
      { id: 'char-c', activeMsg2Config: {
        enabled: true,
        useSecondaryApi: true,
        secondaryApi: { baseUrl: 'https://sec.example.com', apiKey: 'sec-key', model: 'sec-model' },
        tasks: [remoteTask('c1')],
      } },
    ] as any);

    const result = await ActiveMsgClient.refreshApiCredentialsForPendingTasks(API);

    expect(result).toEqual({ status: 'ok', updated: 2, failed: 0 });
    const byUuid = new Map(reiClient.updateMessage.mock.calls.map((c: any[]) => [c[0], c[1]]));
    expect([...byUuid.keys()].sort()).toEqual(['a1', 'c1']);
    expect(byUuid.get('a1')).toEqual({
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'new-key',
      primaryModel: 'gpt-x',
    });
    expect(byUuid.get('c1')).toEqual({
      apiUrl: 'https://sec.example.com/chat/completions',
      apiKey: 'sec-key',
      primaryModel: 'sec-model',
    });
  });

  it('没有 pending AI 任务（只剩 fixed / 全关掉）→ no-tasks，一个请求都不发', async () => {
    vi.spyOn(DB, 'getAllCharacters').mockResolvedValue([
      { id: 'char-a', activeMsg2Config: { enabled: true, tasks: [remoteTask('a2', { mode: 'fixed' })] } },
    ] as any);

    const result = await ActiveMsgClient.refreshApiCredentialsForPendingTasks(API);
    expect(result.status).toBe('no-tasks');
    expect(reiClient.updateMessage).not.toHaveBeenCalled();
  });

  it('某个角色凭据配不齐（单独 API 缺字段）→ 该角色整组记失败，别拦其他角色', async () => {
    vi.spyOn(DB, 'getAllCharacters').mockResolvedValue([
      { id: 'char-broken', activeMsg2Config: {
        enabled: true,
        useSecondaryApi: true,
        secondaryApi: { baseUrl: 'https://sec.example.com', apiKey: '', model: '' }, // 缺 Key/Model
        tasks: [remoteTask('x1')],
      } },
      { id: 'char-ok', activeMsg2Config: { enabled: true, tasks: [remoteTask('y1')] } },
    ] as any);

    const result = await ActiveMsgClient.refreshApiCredentialsForPendingTasks(API);

    expect(result).toEqual({ status: 'partial', updated: 1, failed: 1 });
    expect(reiClient.updateMessage.mock.calls.map((c: any[]) => c[0])).toEqual(['y1']);
  });
});

describe('ActiveMsgClient.refreshCharPendingAiTaskCredentials（③ 面板保存后的单角色版）', () => {
  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.updateMessage.mockReset().mockResolvedValue({ success: true });
  });

  it('fixed 再滤一遍；凭据按传入的 config（面板手里的最新值）算，不读 DB', async () => {
    const result = await ActiveMsgClient.refreshCharPendingAiTaskCredentials({
      char: { id: 'char-a' } as any,
      config: {
        enabled: true,
        useSecondaryApi: true,
        secondaryApi: { baseUrl: 'https://sec.example.com', apiKey: 'sec-key', model: 'sec-model' },
      } as any,
      apiConfig: { baseUrl: 'https://api.example.com', apiKey: 'k', model: 'm' } as any,
      tasks: [remoteTask('t1'), remoteTask('t2', { mode: 'fixed' })] as any,
    });

    expect(result).toEqual({ status: 'ok', updated: 1, failed: 0 });
    expect(reiClient.updateMessage).toHaveBeenCalledTimes(1);
    expect(reiClient.updateMessage.mock.calls[0][0]).toBe('t1');
    expect(reiClient.updateMessage.mock.calls[0][1]).toEqual({
      apiUrl: 'https://sec.example.com/chat/completions',
      apiKey: 'sec-key',
      primaryModel: 'sec-model',
    });
  });

});

// listRemoteTasksForChar 的 lastError 投影（按角色过滤本身的口径由上面那个 describe 钉着）。
describe('ActiveMsgClient.listRemoteTasksForChar 的失败摘要投影', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('带回 status 与收敛后的 lastError（旧 worker 没这字段 → null）', async () => {
    vi.spyOn(ActiveMsgClient, 'listAllTasks').mockResolvedValue([
      { uuid: 'task-a', charId: 'char-1', status: 'failed', lastError: { at: '2026-07-30T15:00:10.000Z', occurrence: '2026-07-30T15:00:00.000Z', reason: 'boom' } },
      { uuid: 'task-b', charId: 'char-1', status: 'pending' },
      { uuid: 'task-c', charId: 'char-2', status: 'pending' },
    ]);

    await expect(ActiveMsgClient.listRemoteTasksForChar('char-1')).resolves.toEqual([
      { uuid: 'task-a', status: 'failed', lastError: { at: '2026-07-30T15:00:10.000Z', occurrence: '2026-07-30T15:00:00.000Z', reason: 'boom' } },
      { uuid: 'task-b', status: 'pending', lastError: null },
    ]);
  });
});

// 上游是按任务行里冻结的 tzId、以墙钟推进循环任务的下次触发时刻的。角色改了时区只刷
// fire_pack 盖不到这份，「每天 9:00」会一直按排程那天的时区走（改到纽约就成了当地晚上）。
describe('ActiveMsgClient.refreshCharPendingTaskRow（角色资料变更后同步任务行）', () => {
  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.updateMessage.mockReset().mockResolvedValue({ success: true });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('全部 pending 任务都刷（含 fixed），载荷只有 tzId', async () => {
    const char = {
      id: 'char-a',
      customTimezoneEnabled: true,
      customTimezone: 'America/New_York',
      activeMsg2Config: {
        enabled: true,
        tasks: [
          remoteTask('a1'),
          // fixed 不走 LLM 用不到凭据，但它的循环推进同样看 tzId，所以这条也得刷。
          remoteTask('a2', { mode: 'fixed', expirePolicy: 'force' }),
          remoteTask('a3', { firstSendTime: PAST_ISO() }),   // 已过点，不动
        ],
      },
    } as any;

    const result = await ActiveMsgClient.refreshCharPendingTaskRow(char, { timeZone: true });

    expect(result).toEqual({ status: 'ok', updated: 2, failed: 0 });
    const byUuid = new Map(reiClient.updateMessage.mock.calls.map((c: any[]) => [c[0], c[1]]));
    expect([...byUuid.keys()].sort()).toEqual(['a1', 'a2']);
    expect(byUuid.get('a1')).toEqual({ tzId: 'America/New_York' });
  });

  it('关掉自定义时区 → 回落设备时区，不把旧的自定义时区留在任务行上', async () => {
    const char = { id: 'char-a', activeMsg2Config: { enabled: true, tasks: [remoteTask('a1')] } } as any;

    await ActiveMsgClient.refreshCharPendingTaskRow(char, { timeZone: true });

    expect(reiClient.updateMessage.mock.calls[0][1]).toEqual({
      tzId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it('没有 pending 任务 → 一个请求都不发', async () => {
    const char = { id: 'char-a', activeMsg2Config: { enabled: true, tasks: [] } } as any;

    expect((await ActiveMsgClient.refreshCharPendingTaskRow(char, { timeZone: true })).status).toBe('no-tasks');
    expect(reiClient.updateMessage).not.toHaveBeenCalled();
  });
});

// contactName 补的是 fixed 模式：AI 任务的推送标题由 worker 从 tool_pack 现取，
// 但 fixed 不走 hooks，标题直接读任务行里冻结的这一份。
describe('ActiveMsgClient.refreshCharPendingTaskRow — contactName', () => {
  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.updateMessage.mockReset().mockResolvedValue({ success: true });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('改名和改时区同时发生 → 一次 PUT 带两个字段，不打两轮', async () => {
    const char = {
      id: 'char-a',
      name: '夜',
      customTimezoneEnabled: true,
      customTimezone: 'America/New_York',
      activeMsg2Config: { enabled: true, tasks: [remoteTask('a1')] },
    } as any;

    await ActiveMsgClient.refreshCharPendingTaskRow(char, { timeZone: true, contactName: true });

    expect(reiClient.updateMessage).toHaveBeenCalledTimes(1);
    expect(reiClient.updateMessage.mock.calls[0][1]).toEqual({
      tzId: 'America/New_York',
      contactName: '夜',
    });
  });

  it('只改名 → 载荷只有 contactName，不顺手动时区', async () => {
    const char = { id: 'char-a', name: '夜', activeMsg2Config: { enabled: true, tasks: [remoteTask('a1')] } } as any;

    await ActiveMsgClient.refreshCharPendingTaskRow(char, { contactName: true });

    expect(reiClient.updateMessage.mock.calls[0][1]).toEqual({ contactName: '夜' });
  });

  it('名字是空的 → 一个请求都不发（上游要求非空，传上去只会被打回 400）', async () => {
    const char = { id: 'char-a', name: '  ', activeMsg2Config: { enabled: true, tasks: [remoteTask('a1')] } } as any;

    expect((await ActiveMsgClient.refreshCharPendingTaskRow(char, { contactName: true })).status).toBe('no-tasks');
    expect(reiClient.updateMessage).not.toHaveBeenCalled();
  });
});

// ─── ⑥ 设置页「推送订阅状态」面板 ───
// 回归守卫：
//   a. 重置订阅必须把新订阅**登记回 worker**。只在浏览器重订不登记的话，worker 的
//      push_subscriptions 里还是旧端点，到点推给一个已经不存在的地址——界面全绿、
//      一条消息都收不到，正是这个按钮要治的病。
//   b. worker 登记的端点跟本机对不上时，面板必须判成异常。这一档正是「换过 worker /
//      在另一台设备登记过」的静默失联，判成正常等于把唯一的线索也抹了。
//   c. 重订仍拿到僵尸哨兵时挂 '端点僵尸' 代号——设置页据此把按钮升级成「深度重置」。
//      裸 pushManager.subscribe() 会把哨兵原样交出来，登记上去就是往库里写死端点。

describe('compareRemotePushSubscription（⑥b worker 登记的是不是本机）', () => {
  const LOCAL = 'https://fcm.googleapis.com/send/local';

  it('问不到 worker → unreachable', () => {
    expect(compareRemotePushSubscription(LOCAL, null)).toBe('unreachable');
  });

  it('worker 上没登记 → missing', () => {
    expect(compareRemotePushSubscription(LOCAL, { exists: false, endpoint: null, updatedAt: null }))
      .toBe('missing');
  });

  it('登记的端点就是本机 → matched', () => {
    expect(compareRemotePushSubscription(LOCAL, { exists: true, endpoint: LOCAL, updatedAt: 1 }))
      .toBe('matched');
  });

  it('登记着别的端点 → other-endpoint（换过 worker / 换过设备的静默失联）', () => {
    expect(compareRemotePushSubscription(LOCAL, {
      exists: true,
      endpoint: 'https://fcm.googleapis.com/send/another-device',
      updatedAt: 1,
    })).toBe('other-endpoint');
  });

  it('本机还没订阅、远端却登记着 → other-endpoint，不许显示成已登记', () => {
    expect(compareRemotePushSubscription(null, {
      exists: true,
      endpoint: 'https://fcm.googleapis.com/send/another-device',
      updatedAt: 1,
    })).toBe('other-endpoint');
  });
});

describe('ActiveMsgClient.resetPushSubscription（⑥a 重置后必须重新登记）', () => {
  const FRESH = 'https://fcm.googleapis.com/send/fresh';

  /** subscribe() 依次吐出这些端点；数组用尽后一直吐最后一个。 */
  const stubResetEnv = (existing: any, endpoints: string[]) => {
    const queue = [...endpoints];
    const subscribe = vi.fn().mockImplementation(async () => {
      const endpoint = queue.length > 1 ? queue.shift()! : queue[0];
      return {
        endpoint,
        options: { applicationServerKey: Uint8Array.from([1, 2, 3]).buffer },
        unsubscribe: vi.fn().mockResolvedValue(true),
        toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
      };
    });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: vi.fn().mockResolvedValue(existing),
            subscribe,
          },
        }),
        getRegistrations: vi.fn().mockResolvedValue([{ unregister: vi.fn().mockResolvedValue(true) }]),
      },
    });
    vi.stubGlobal('window', { PushManager: class {} });
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() });
    return subscribe;
  };

  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.getVapidPublicKey.mockReset().mockResolvedValue(VAPID_AQID);
    reiClient.putPushSubscription.mockReset().mockResolvedValue({ success: true, data: { updatedAt: 1 } });
    reiClient.deletePushSubscription.mockReset().mockResolvedValue({ success: true, data: { deleted: 1 } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('退掉旧订阅、重订一条、并把新的覆盖登记到 worker', async () => {
    const old = makeSub('https://fcm.googleapis.com/send/old', [1, 2, 3]);
    stubResetEnv(old, [FRESH]);

    await runWithTimers(ActiveMsgClient.resetPushSubscription());

    expect(old.unsubscribe).toHaveBeenCalledTimes(1);
    expect(reiClient.putPushSubscription).toHaveBeenCalledTimes(1);
    expect(reiClient.putPushSubscription.mock.calls[0][0].endpoint).toBe(FRESH);
  });

  it('先让 worker 忘掉旧的那行，再登记新的', async () => {
    stubResetEnv(makeSub('https://fcm.googleapis.com/send/old', [1, 2, 3]), [FRESH]);

    await runWithTimers(ActiveMsgClient.resetPushSubscription());

    expect(reiClient.deletePushSubscription).toHaveBeenCalledTimes(1);
    expect(reiClient.deletePushSubscription.mock.invocationCallOrder[0])
      .toBeLessThan(reiClient.putPushSubscription.mock.invocationCallOrder[0]);
  });

  it('删旧行失败不拦路——重新登记本来就是覆盖写', async () => {
    stubResetEnv(makeSub('https://fcm.googleapis.com/send/old', [1, 2, 3]), [FRESH]);
    reiClient.deletePushSubscription.mockRejectedValue(new Error('worker 说没有这一行'));

    await runWithTimers(ActiveMsgClient.resetPushSubscription());

    expect(reiClient.putPushSubscription.mock.calls[0][0].endpoint).toBe(FRESH);
  });

  it('重订第一次拿到僵尸哨兵、重试拿到活端点 → 登记的是活的那个', async () => {
    stubResetEnv(null, ['https://permanently-removed.invalid/x', FRESH]);

    await runWithTimers(ActiveMsgClient.resetPushSubscription());

    expect(reiClient.putPushSubscription).toHaveBeenCalledTimes(1);
    expect(reiClient.putPushSubscription.mock.calls[0][0].endpoint).toBe(FRESH);
  });

  it('⑥c 重试到底还是僵尸 → 抛 端点僵尸，且一个字都不往 worker 上写', async () => {
    stubResetEnv(null, ['https://permanently-removed.invalid/x']);

    const failure = await runWithTimers(ActiveMsgClient.resetPushSubscription().catch((e) => e));

    expect(readAmsgFailKind(failure)).toBe('端点僵尸');
    expect(reiClient.putPushSubscription).not.toHaveBeenCalled();
  });

  it('worker 没配 VAPID → 抛 worker没配VAPID，不去动浏览器订阅', async () => {
    const subscribe = stubResetEnv(makeSub('https://fcm.googleapis.com/send/old', [1, 2, 3]), [FRESH]);
    reiClient.getVapidPublicKey.mockResolvedValue('');

    const failure = await runWithTimers(ActiveMsgClient.resetPushSubscription().catch((e) => e));

    expect(readAmsgFailKind(failure)).toBe('worker没配VAPID');
    expect(subscribe).not.toHaveBeenCalled();
    expect(reiClient.putPushSubscription).not.toHaveBeenCalled();
  });

  it('通知权限被拒 → 抛 权限被拒，不去动浏览器订阅', async () => {
    stubResetEnv(null, [FRESH]);
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: vi.fn().mockResolvedValue('denied'),
    });

    const failure = await runWithTimers(ActiveMsgClient.resetPushSubscription().catch((e) => e));

    expect(readAmsgFailKind(failure)).toBe('权限被拒');
    expect(reiClient.putPushSubscription).not.toHaveBeenCalled();
  });

  it('深度重置：注销 SW 并重装之后，同样要把新订阅登记回 worker', async () => {
    stubResetEnv(makeSub('https://fcm.googleapis.com/send/old', [1, 2, 3]), [FRESH]);

    await runWithTimers(ActiveMsgClient.deepResetPushSubscription());

    expect(navigator.serviceWorker.getRegistrations).toHaveBeenCalledTimes(1);
    expect(KeepAlive.reregister).toHaveBeenCalledTimes(1);
    expect(reiClient.putPushSubscription.mock.calls[0][0].endpoint).toBe(FRESH);
  });
});

describe('ActiveMsgClient.getRemotePushSubscription（⑥b 问不到就说问不到）', () => {
  beforeEach(() => { reiClient.init.mockReset().mockResolvedValue(undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('worker 回了完整回执 → 原样交出来', async () => {
    reiClient.getPushSubscription.mockResolvedValue({
      success: true,
      data: { exists: true, endpoint: 'https://fcm.googleapis.com/send/x', updatedAt: 1700 },
    });

    await expect(ActiveMsgClient.getRemotePushSubscription()).resolves.toEqual({
      exists: true,
      endpoint: 'https://fcm.googleapis.com/send/x',
      updatedAt: 1700,
    });
  });

  it('回执形状对不上（旧 worker）→ null，不猜成「已登记」', async () => {
    reiClient.getPushSubscription.mockResolvedValue({ success: true, data: { ok: 1 } });
    await expect(ActiveMsgClient.getRemotePushSubscription()).resolves.toBeNull();
  });

  it('请求本身炸了 → null，不往外抛（面板会反复调它）', async () => {
    reiClient.getPushSubscription.mockRejectedValue(new Error('offline'));
    await expect(ActiveMsgClient.getRemotePushSubscription()).resolves.toBeNull();
  });
});

// 上游把异常吞成一句写死的「服务器内部错误」，真话只进 worker 的日志。包装层把那行
// 捞出来放进 upstreamLog，这里必须原样端到用户面前——否则他看到的还是那句什么都没说的话，
// 得先知道 Cloudflare 面板里有条日志才查得下去。
describe('describeInstantChatFailure — 后端那句真话要露出来', () => {
  const internalError = (upstreamLog?: string) => ({
    error: {
      code: 'INSTANT_CHAT_STATE_FAILED',
      message: '云端状态没传上去，这条没发出去',
      upstream: { success: false, error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } },
      ...(upstreamLog ? { upstreamLog } : {}),
    },
  });

  it('带了 upstreamLog 就拼进去', () => {
    const text = describeInstantChatFailure(500, internalError('D1_ERROR: no such table: message_outbox'));
    expect(text).toContain('D1_ERROR: no such table: message_outbox');
    // 泛型报文照留：它说明这一步是哪一步，跟真实原因不冲突。
    expect(text).toContain('云端状态没传上去');
  });

  it('没有 upstreamLog 时照旧（老 worker 不会多出一截空白）', () => {
    const text = describeInstantChatFailure(500, internalError());
    expect(text).toBe('即时对话没发出去（HTTP 500 / INSTANT_CHAT_STATE_FAILED）：云端状态没传上去，这条没发出去：服务器内部错误');
  });

  it('有专属指引的错误码不受影响（401 仍然只说该去核对共享密钥）', () => {
    expect(describeInstantChatFailure(401, internalError('D1_ERROR: whatever')))
      .toBe('即时对话没发出去：共享密钥和 Worker 上的对不上，去「主动消息 2.0」设置里核对一下。');
  });
});
