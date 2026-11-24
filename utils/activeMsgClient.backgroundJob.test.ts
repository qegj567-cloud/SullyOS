// utils/activeMsgClient.backgroundJob.test.ts
//
// 回归守卫（后台任务这条路怎么排上去）。两条都是本地端到端跑出来的坑：
//
//   1. 以 instant 任务交上去（到期时间由服务端盖、落库就叫醒起跳器），客户端绝不能自己算一个 firstSendTime。
//      算了的话，那个时刻在「上传输入 → 传凭据 → 加密 → 发请求」这一路上早就过去了，
//      上游一律打回「时间必须在未来」——云端这条路每次都失败、每次都退回本地跑，
//      而用户那边只看得到门牌照常更新，完全不知道它从来没在云端跑过。
//
//   2. 采样温度与输出上限要原样带上去。上游对缺省的这两个字段是整个省略，
//      落到供应商默认值（温度常为 1.0，输出上限远小于四块门牌全量输出需要的量）——
//      同一批材料在本地和在云端会整理出不一样的门牌，而这种漂移界面上看不出来。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reiClient } = vi.hoisted(() => ({
  reiClient: {
    init: vi.fn(),
    putClientState: vi.fn(),
    getCapabilities: vi.fn(),
    putLlmCredentials: vi.fn(),
    _encrypt: vi.fn(),
  },
}));
vi.mock('@rei-standard/amsg-client', () => ({ ReiClient: vi.fn(() => reiClient) }));
vi.mock('./keepAlive', () => ({
  KeepAlive: { init: vi.fn().mockResolvedValue(undefined), reregister: vi.fn().mockResolvedValue(undefined) },
}));

const TEST_USER_ID = '3f2b1c8a-9d4e-4a1b-8c2d-000000000077';
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

import { ActiveMsgClient, forgetBackgroundJobProbe } from './activeMsgClient';
import { forgetAllCredIds } from './amsgLlmCredentials';

const capturedPayloads: any[] = [];

beforeEach(() => {
  capturedPayloads.length = 0;
  globalConfig.llmCredentialsSupported = true;
  forgetAllCredIds();
  forgetBackgroundJobProbe();
  reiClient.init.mockReset().mockResolvedValue(undefined);
  reiClient.putClientState.mockReset().mockResolvedValue({ success: true });
  reiClient.putLlmCredentials.mockReset().mockResolvedValue({ success: true, data: { upserted: 1 } });
  reiClient.getCapabilities.mockReset().mockResolvedValue({ serverVersion: '2.6.0-next.22', features: [] });
  reiClient._encrypt.mockReset().mockImplementation(async (json: string) => {
    capturedPayloads.push(JSON.parse(json));
    return { iv: 'iv', authTag: 'tag', encryptedData: 'enc' };
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    status: 201,
    text: async () => JSON.stringify({ success: true, data: { uuid: 'job-remote-uuid' } }),
    headers: new Headers({ 'content-type': 'application/json' }),
  })));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const CRED_ROW = {
  credId: 'char:c-bg/memory',
  value: { apiUrl: 'https://light.example.dev/v1/chat/completions', apiKey: 'sk-light', primaryModel: 'cheap' },
};

const schedule = (extra: Record<string, unknown> = {}) => ActiveMsgClient.scheduleBackgroundJob({
  kind: 'plate-consolidate',
  charId: 'c-bg',
  charName: '小满',
  jobKey: 'plate:job-1',
  jobId: 'job-1',
  jobInput: { v: 1, hello: 'world' },
  credRow: CRED_ROW,
  ...extra,
} as any);

/** POST 出去的那份任务载荷（云端状态那份没有 messageType，据此认出来）。 */
const scheduledTask = () => capturedPayloads.filter((p) => p && 'messageType' in p).at(-1);

describe('后台任务的到期时间', () => {
  // instant 落库就叫醒起跳器，不用等最长一分钟的 cron；上游拒收 instant 再带 immediate。
  it('用 messageType: instant，不带 immediate，也不自己算 firstSendTime', async () => {
    await schedule();

    const task = scheduledTask();
    expect(task.messageType).toBe('instant');
    expect(task).not.toHaveProperty('immediate');
    expect(task, '客户端算出来的时刻发到服务端已是过去时，上游会打回「时间必须在未来」')
      .not.toHaveProperty('firstSendTime');
  });

  it('一次性任务、带得上 kind 与 job 编号，且用 job 这个 subtype（不进用户的任务清单）', async () => {
    await schedule();

    const task = scheduledTask();
    expect(task.recurrenceType).toBe('none');
    expect(task.messageSubtype).toBe('job');
    expect(task.metadata.amsgKind).toBe('plate-consolidate');
    expect(task.metadata.amsgJobId).toBe('job-1');
    expect(task.credRefs).toEqual({ chat: CRED_ROW.credId });
  });
});

// 回归守卫：探测把「问不到」和「问到了、答案是不行」混成同一个 false，还按 workerUrl
// 缓存了一整个会话。一次代理切换、一次 CF 边缘抖动、一次 D1 冷启动超时，就能把整个会话
// 钉死在本地整理，而且没有任何日志区分这两件事——只有刷新页面才翻得回来。
describe('后台任务能力探测的缓存', () => {
  const configCheck = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => ({
    status,
    text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
  })));
  const fetchCalls = () => (globalThis.fetch as any).mock.calls.length;

  it('拿到明确答复才记缓存（支持 → 第二次不再发请求）', async () => {
    configCheck({ success: true, data: { backgroundJobs: true, instantBackground: true } });

    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(true);
    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(true);
    expect(fetchCalls()).toBe(1);
  });

  it('明确说了不支持也记缓存（老 bundle 不会自己变新）', async () => {
    configCheck({ success: true, data: {} });

    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(false);
    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(false);
    expect(fetchCalls()).toBe(1);
  });

  // 回归守卫：forgetBackgroundJobProbe 只盖得住「在设置页点按钮更新 Worker」这一条路，
  // 而换 bundle 不止这一条——文档里那条 GitHub「Sync fork」→ Cloudflare Workers Builds
  // 更新完，地址没变、整个过程也不经过前端。把「不支持」钉死一整个会话的话，这段时间
  // 每一轮消化都在前台跑那一两分钟的整理，页面一关就死，只有刷新页面才翻得回来。
  it('存量是「不支持」时隔一阵会再问一遍', async () => {
    configCheck({ success: true, data: {} });
    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(false);
    expect(fetchCalls(), '同一轮里连着提交几个 job 不该重复问').toBe(1);

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    configCheck({ success: true, data: { backgroundJobs: true, instantBackground: true } });

    expect(
      await ActiveMsgClient.probeBackgroundJobSupport(),
      'worker 已经换成新 bundle 了，前端还认着换之前那句「不支持」',
    ).toBe(true);
  });

  it('问不到（5xx）→ 这轮当不支持，但不记缓存，下轮重新问', async () => {
    configCheck({ success: false }, 503);

    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(false);
    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(false);
    expect(fetchCalls(), '缓存住的话这个会话之后每一轮消化都退回本地跑').toBe(2);
  });

  it('请求压根没发出去（网络挂了）同样不记缓存', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));

    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(false);
    expect(await ActiveMsgClient.probeBackgroundJobSupport()).toBe(false);
    expect(fetchCalls()).toBe(2);
  });

  // 回归守卫：探测原先把「问不到」和「问到了、答案是不行」压成同一个 false。门牌那道闸
  // 要靠它区分「这条路断了」和「这次没问到」——混着的话，一次代理切换、一次 CF 边缘抖动
  // 就能在任务还在云端跑着的时候把这一轮踢回本地，同一份快照烧两次副 API，两份结果先后
  // 落地互相盖（见 plateCloudGate）。
  it.each([
    ['问到了、认识后台任务', { success: true, data: { backgroundJobs: true, instantBackground: true } }, 200, 'supported'],
    ['问到了、是老 bundle', { success: true, data: {} }, 200, 'unsupported'],
    // 回归守卫：认识后台任务、却还会在请求里当场跑完 instant 任务的老 bundle，不能交。
    ['认识后台任务、但 instant 还在请求里跑', { success: true, data: { backgroundJobs: true } }, 200, 'unsupported'],
    ['问不到（5xx）', { success: false }, 503, 'unknown'],
  ])('%s → %s', async (_name, body, status, expected) => {
    configCheck(body, status as number);

    expect(await ActiveMsgClient.probeBackgroundJobSupportDetailed()).toBe(expected);
  });

  it('请求没发出去也是「问不到」，不是「不支持」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Failed to fetch'); }));

    expect(await ActiveMsgClient.probeBackgroundJobSupportDetailed()).toBe('unknown');
  });

  // 回归守卫：作废那个函数的说明写着「部署/更新 worker 的路径上调一次」，实际只有设置页的
  // 「重新连接并验证」调了它。用户点完「更新 Worker」（同一个地址换了 bundle），前端还认着
  // 升级前那句「不支持」——接下来这几分钟每一轮消化都在前台跑那一两分钟的整理，页面一关就死。
  it('点过「更新 Worker」之后探测结论当场作废', async () => {
    let upgraded = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const isSelfUpdate = String(url).includes('self-update');
      if (isSelfUpdate) upgraded = true;
      const body = isSelfUpdate
        ? { success: true, data: { message: '已经更新到最新版本。' } }
        : { success: true, data: upgraded ? { backgroundJobs: true, instantBackground: true } : {} };
      return {
        status: 200,
        text: async () => JSON.stringify(body),
        headers: new Headers({ 'content-type': 'application/json' }),
      };
    }));

    expect(await ActiveMsgClient.probeBackgroundJobSupport(), '升级前是老 bundle').toBe(false);
    await ActiveMsgClient.selfUpdateWorker();

    expect(await ActiveMsgClient.probeBackgroundJobSupport(), '不作废就得等用户刷新页面').toBe(true);
  });
});

describe('后台任务的采样参数', () => {
  it('传了就原样带上去', async () => {
    await schedule({ temperature: 0.3, maxTokens: 8000 });

    const task = scheduledTask();
    expect(task.temperature).toBe(0.3);
    expect(task.maxTokens).toBe(8000);
  });

  it('没传就一个字段都不写（让上游按它自己的规矩来，别凭空塞默认值）', async () => {
    await schedule();

    const task = scheduledTask();
    expect(task).not.toHaveProperty('temperature');
    expect(task).not.toHaveProperty('maxTokens');
  });
});

// 云端生成（代跑）走同一个入口，多带几样：思考参数、独立命名空间、客户端先定好的 uuid、
// 用途标记，以及「每次都覆盖凭据行」——本机指纹底账记着传过，不代表云端那行还是这一份。
describe('代跑任务的额外字段', () => {
  const genRow = { credId: 'char:c-bg/gen-dream', value: { apiUrl: 'https://api.example/v1/chat/completions', apiKey: 'sk', primaryModel: 'm' } };
  const scheduleGen = () => schedule({
    kind: 'cloud-gen', credRow: genRow, namespace: 'amsg:cloud-gen', jobKey: 'gen:job-1',
    uuid: '6f1c2e8a-3b4d-4c5e-9f60-718293a4b5c6', metadata: { amsgCloudGenPurpose: 'dream' },
    extraBody: { reasoning_effort: 'high' }, forceCredUpload: true,
  });

  it('思考参数进 llmExtraBody，uuid 与用途标记写上任务，输入放进代跑自己的命名空间', async () => {
    await scheduleGen();
    const task = scheduledTask();
    expect(task.llmExtraBody).toEqual({ reasoning_effort: 'high' });
    expect(task.uuid).toBe('6f1c2e8a-3b4d-4c5e-9f60-718293a4b5c6');
    expect(task.metadata).toMatchObject({ amsgKind: 'cloud-gen', amsgCloudGenPurpose: 'dream', amsgJobId: 'job-1' });
    expect(task.credRefs).toEqual({ chat: genRow.credId });
    const statePayload = capturedPayloads.find((p) => Array.isArray(p?.entries)) ?? null;
    const putArgs = reiClient.putClientState.mock.calls.flat();
    expect(JSON.stringify(putArgs) + JSON.stringify(statePayload)).toContain('amsg:cloud-gen');
  });

  it('凭据行每次都传，不看指纹底账', async () => {
    await scheduleGen();
    await scheduleGen();
    expect(reiClient.putLlmCredentials).toHaveBeenCalledTimes(2);
  });
});

describe('代跑能力探测', () => {
  const configCheck = (data: unknown) => vi.stubGlobal('fetch', vi.fn(async () => ({
    status: 200,
    text: async () => JSON.stringify({ success: true, data }),
    headers: new Headers({ 'content-type': 'application/json' }),
  })));

  it('报了 cloudGen 才算支持；跟后台任务共用一次探测', async () => {
    configCheck({ backgroundJobs: true, instantBackground: true, cloudGen: true });
    expect(await ActiveMsgClient.probeCloudGenSupportDetailed()).toBe('supported');
    expect(await ActiveMsgClient.probeBackgroundJobSupportDetailed()).toBe('supported');
    expect((globalThis.fetch as any).mock.calls.length).toBe(1);
  });

  it('认识后台任务、但还不认识代跑的老 bundle → 不支持（门牌整理照常）', async () => {
    configCheck({ backgroundJobs: true, instantBackground: true });
    expect(await ActiveMsgClient.probeCloudGenSupportDetailed()).toBe('unsupported');
    expect(await ActiveMsgClient.probeBackgroundJobSupportDetailed()).toBe('supported');
  });
});
