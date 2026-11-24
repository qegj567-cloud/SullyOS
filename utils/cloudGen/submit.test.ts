// utils/cloudGen/submit.test.ts
// 代跑提交口的回归守卫：门的顺序、在飞登记先于网络请求、确定失败要撤回、起跳失败要撤任务
// 转本机、凭据行按用途命名且每次覆盖、请求体按本机出口的规则整理、埋点只报写死的枚举。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ready: true,
  config: {} as Record<string, unknown>,
  support: 'supported' as 'supported' | 'unsupported' | 'unknown',
  schedule: vi.fn(),
  cancelTask: vi.fn(async () => ({ alreadyGone: false })),
  clearClientStateValue: vi.fn(async () => {}),
  getRemoteTaskStatus: vi.fn(async () => ({ state: 'pending' })),
  maybeCreated: false,
  recordCloudApiCall: vi.fn(),
  settleCloudApiCall: vi.fn(),
  trackEvent: vi.fn(),
}));

vi.mock('../amsg2ToolBridge', () => ({ isAmsg2GlobalReady: async () => h.ready }));
vi.mock('../activeMsgStore', () => ({ ActiveMsgStore: { getGlobalConfig: async () => h.config } }));
vi.mock('../activeMsgClient', () => ({
  ActiveMsgClient: {
    probeCloudGenSupportDetailed: async () => h.support,
    scheduleBackgroundJob: h.schedule,
    cancelTask: h.cancelTask,
    clearClientStateValue: h.clearClientStateValue,
    getRemoteTaskStatus: h.getRemoteTaskStatus,
  },
  mayHaveCreatedBackgroundJob: () => h.maybeCreated,
  resolveChatMessagesForUpload: async (messages: unknown[]) => messages.map((m) => ({ ...(m as object) })),
}));
vi.mock('../apiCallLog', () => ({
  cloudApiCallLogId: (id: string) => `cloud-${id}`,
  recordCloudApiCall: h.recordCloudApiCall,
  settleCloudApiCall: h.settleCloudApiCall,
}));
vi.mock('../analytics', () => ({ trackEvent: h.trackEvent }));

import { trySubmitCloudGeneration } from './submit';
import { getCloudGenJob, getCloudGenJobById, isCloudGenJobDone, putCloudGenJob } from './registry';
import { buildCloudGenAnalytics } from './analytics';
import { CLOUD_GEN_NAMESPACE } from '../amsgCloudGenJob';

const API = { baseUrl: 'https://api.example/v1', apiKey: 'sk-test', model: 'some-model' };
const input = (overrides: Record<string, unknown> = {}) => ({
  purpose: 'schedule' as const,
  char: { id: 'c1', name: '小明' },
  messages: [{ role: 'system', content: '设定' }, { role: 'user', content: '生成日程' }],
  params: { temperature: 0.85, max_tokens: 8000 },
  api: API,
  context: { dateKey: '2026-11-24' },
  apiMeta: { appName: '日程系统', charId: 'c1', charName: '小明', purpose: '生成当日日程' },
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  h.ready = true;
  h.config = {};
  h.support = 'supported';
  h.maybeCreated = false;
  h.schedule.mockReset().mockResolvedValue({ uuid: 'ignored', dispatch: 'kicked' });
  h.cancelTask.mockClear();
  h.clearClientStateValue.mockClear();
  h.recordCloudApiCall.mockClear();
  h.settleCloudApiCall.mockClear();
  h.trackEvent.mockClear();
});
afterEach(() => vi.restoreAllMocks());

const running = (overrides: Record<string, unknown> = {}) => ({
  jobId: 'old-job', purpose: 'schedule' as const, charId: 'c1', charName: '小明', uuid: 'u-old',
  submittedAt: Date.now(), snapshotAt: Date.now(), status: 'running' as const, notify: false, context: null,
  ...overrides,
});

describe('门的顺序', () => {
  it('这套 API 没配齐 → 本机，连 2.0 开没开都不问', async () => {
    h.ready = false;
    expect(await trySubmitCloudGeneration(input({ api: { ...API, apiKey: '' } }))).toEqual({ route: 'local', reason: 'no-credentials' });
  });

  it('2.0 没开 → 本机；功能的云端生成关着 → 本机', async () => {
    h.ready = false;
    expect(await trySubmitCloudGeneration(input())).toEqual({ route: 'local', reason: 'amsg2-off' });
    h.ready = true;
    h.config = { cloudGen: { schedule: { enabled: false } } };
    expect(await trySubmitCloudGeneration(input())).toEqual({ route: 'local', reason: 'feature-off' });
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it('Worker 不认识代跑 → 本机（哪怕有在飞的：路断了就该本机干活）', async () => {
    h.support = 'unsupported';
    putCloudGenJob(running());
    expect(await trySubmitCloudGeneration(input())).toEqual({ route: 'local', reason: 'worker-unsupported' });
  });

  it('有在飞的 → busy；问不到 Worker 时也先看在飞', async () => {
    putCloudGenJob(running());
    expect(await trySubmitCloudGeneration(input())).toEqual({ route: 'busy', jobId: 'old-job' });
    h.support = 'unknown';
    expect(await trySubmitCloudGeneration(input())).toEqual({ route: 'busy', jobId: 'old-job' });
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it('问不到 Worker 且没有在飞的 → 本机', async () => {
    h.support = 'unknown';
    expect(await trySubmitCloudGeneration(input())).toEqual({ route: 'local', reason: 'worker-unreachable' });
  });

  it('另一个功能在飞不挡这个功能', async () => {
    putCloudGenJob(running({ purpose: 'persona-sim' }));
    expect((await trySubmitCloudGeneration(input())).route).toBe('cloud');
  });

  it('消息里有图片这类非纯文本 → 本机', async () => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: '看图' }] }];
    expect(await trySubmitCloudGeneration(input({ messages }))).toEqual({ route: 'local', reason: 'unsupported-content' });
  });
});

describe('交出去', () => {
  it('登记在发请求之前就写好，uuid 与任务一致；凭据行按用途命名、强制覆盖', async () => {
    let seenAtSubmit: ReturnType<typeof getCloudGenJob> = null;
    h.schedule.mockImplementation(async () => {
      seenAtSubmit = getCloudGenJob('c1', 'schedule');
      return { uuid: 'ignored', dispatch: 'kicked' };
    });
    const outcome = await trySubmitCloudGeneration(input());

    expect(outcome.route).toBe('cloud');
    expect(seenAtSubmit).toMatchObject({ status: 'running', notify: false, context: { dateKey: '2026-11-24' } });
    // 「可以切出去」只认 Worker 确认之后：上传那一刻还没有 acceptedAt，起跳成功后才有。
    expect(seenAtSubmit!.acceptedAt).toBeUndefined();
    expect(getCloudGenJob('c1', 'schedule')?.acceptedAt).toEqual(expect.any(Number));
    const args = h.schedule.mock.calls[0][0];
    expect(args).toMatchObject({
      kind: 'cloud-gen',
      namespace: CLOUD_GEN_NAMESPACE,
      uuid: seenAtSubmit!.uuid,
      jobId: (outcome as { jobId: string }).jobId,
      forceCredUpload: true,
      metadata: { amsgCloudGenPurpose: 'schedule' },
      credRow: { credId: 'char:c1/gen-schedule', value: { apiUrl: 'https://api.example/v1/chat/completions', apiKey: 'sk-test', primaryModel: 'some-model' } },
      temperature: 0.85,
      maxTokens: 8000,
    });
    expect(args.jobInput).toMatchObject({ purpose: 'schedule', charId: 'c1', notify: null, messages: input().messages });
    expect(h.recordCloudApiCall).toHaveBeenCalledWith(expect.objectContaining({ route: 'cloud-generation' }));
  });

  it('完成通知开着时把文案交给 Worker', async () => {
    await trySubmitCloudGeneration(input({ purpose: 'dream', notifyCopy: { title: '小明', body: '梦做好了' } }));
    expect(h.schedule.mock.calls[0][0].jobInput.notify).toEqual({ title: '小明', body: '梦做好了' });
    expect(h.schedule.mock.calls[0][0].credRow.credId).toBe('char:c1/gen-dream');
  });

  it('服务端明确拒了 → 撤掉登记、调用记录标已顶替、转本机', async () => {
    h.schedule.mockRejectedValue(new Error('400'));
    expect(await trySubmitCloudGeneration(input())).toEqual({ route: 'local', reason: 'submit-failed' });
    expect(getCloudGenJob('c1', 'schedule')).toBeNull();
    expect(h.settleCloudApiCall).toHaveBeenCalledWith(expect.objectContaining({ ok: false, superseded: true }));
  });

  it('请求发出去没等到答复 → 登记留着、按已交出处理，不在本机重复生成', async () => {
    h.schedule.mockRejectedValue(new Error('timeout'));
    h.maybeCreated = true;
    const outcome = await trySubmitCloudGeneration(input());
    expect(outcome.route).toBe('cloud');
    expect(getCloudGenJobById((outcome as { jobId: string }).jobId)?.status).toBe('running');
  });

  it('起跳器没叫醒 → 撤任务、撤输入、转本机，漏网结果也不再落地', async () => {
    h.schedule.mockResolvedValue({ uuid: 'ignored', dispatch: 'kick_failed' });
    let uuid = '';
    let jobId = '';
    h.schedule.mockImplementation(async (args: any) => { uuid = args.uuid; jobId = args.jobId; return { uuid, dispatch: 'kick_failed' }; });
    expect(await trySubmitCloudGeneration(input())).toEqual({ route: 'local', reason: 'kick-failed' });
    expect(h.cancelTask).toHaveBeenCalledWith(uuid);
    expect(h.clearClientStateValue).toHaveBeenCalledWith(CLOUD_GEN_NAMESPACE, `gen:${jobId}`);
    expect(getCloudGenJob('c1', 'schedule')).toBeNull();
    expect(isCloudGenJobDone(jobId)).toBe(true);
  });
});

describe('与本机请求一致', () => {
  it('Claude 温度按本机出口规则封顶到 1；其余字段原样进 extraBody', async () => {
    await trySubmitCloudGeneration(input({
      api: { ...API, model: 'claude-sonnet-4-5' },
      params: { temperature: 1.1, max_tokens: 8192, reasoning_effort: 'high' },
    }));
    expect(h.schedule.mock.calls[0][0]).toMatchObject({ temperature: 1, maxTokens: 8192, extraBody: { reasoning_effort: 'high' } });
  });

  it('弃用采样参数的模型不带温度（本机出口也会摘掉）', async () => {
    await trySubmitCloudGeneration(input({ api: { ...API, model: 'gpt-5-mini' }, params: { temperature: 0.98, max_tokens: 24000, top_p: 0.9 } }));
    const args = h.schedule.mock.calls[0][0];
    expect(args).not.toHaveProperty('temperature');
    expect(args.extraBody).toBeUndefined();
    expect(args.maxTokens).toBe(24000);
  });
});

describe('埋点只报写死的枚举', () => {
  it('配置状态类的原因不报，Worker 类的报', () => {
    expect(buildCloudGenAnalytics('schedule', 'local', 'amsg2-off')).toBeNull();
    expect(buildCloudGenAnalytics('schedule', 'local', 'feature-off')).toBeNull();
    expect(buildCloudGenAnalytics('schedule', 'local', 'no-credentials')).toBeNull();
    expect(buildCloudGenAnalytics('dream', 'local', 'kick-failed')).toEqual({ 功能: '梦境', 结果: '转本机', 原因: '没能开跑' });
    expect(buildCloudGenAnalytics('persona-sim', 'landed')).toEqual({ 功能: '人格模拟', 结果: '已落地' });
  });

  it('运行时字符串混进来也不会出现在上报里', () => {
    const poison = 'POISON-小明-sk-test';
    expect(buildCloudGenAnalytics(poison as any, 'submitted')).toBeNull();
    expect(buildCloudGenAnalytics('schedule', poison as any)).toBeNull();
    expect(buildCloudGenAnalytics('schedule', 'local', poison as any)).toBeNull();
  });

  it('一次成功提交只发一条，属性里没有角色、模型或地址', async () => {
    await trySubmitCloudGeneration(input());
    expect(h.trackEvent).toHaveBeenCalledTimes(1);
    expect(h.trackEvent).toHaveBeenCalledWith('云端生成', { 功能: '日程', 结果: '已交云端' });
    expect(JSON.stringify(h.trackEvent.mock.calls)).not.toMatch(/小明|sk-test|api\.example|some-model/);
  });
});
