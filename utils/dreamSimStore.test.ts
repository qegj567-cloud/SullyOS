// utils/dreamSimStore.test.ts
// 梦境接入云端生成的回归守卫：本机与云端共用同一份参数和校验；云端结果落进「还没看的梦」，
// 刷新后还在、只播一次；两个角色的梦互不覆盖；云端小条文案只认 Worker 已收下且没选「不再提醒」；
// 角色删了丢弃；云端失败与没通过校验都走原来的报错界面。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  readAttachment: vi.fn(),
  getCharacter: vi.fn(),
}));

vi.mock('./activeMsgClient', () => ({ ActiveMsgClient: { readAttachment: h.readAttachment } }));
vi.mock('./db', () => ({ DB: { getCharacter: h.getCharacter } }));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('./apiCallLog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./apiCallLog')>()),
  settleCloudApiCall: vi.fn(),
}));

import { applyCloudGenResult } from './cloudGen/results';
import { setCloudGenHintOff } from './cloudGen/hint';
import { readCloudGenPending, writeCloudGenPending } from './cloudGen/pending';
import { getCloudGenJobById, markCloudGenJobFailed, putCloudGenJob } from './cloudGen/registry';
import { lander } from './cloudGen/landers/dream';
import { DREAM_REQUEST_PARAMS, fetchDreamScript } from './dreamScript';
import { dreamSimStore } from './dreamSimStore';

const SCRIPT = {
  archetype: 'ocean', title: '潮汐', afterglow: '喉咙发紧',
  fragments: [{ kind: 'word', text: '海' }, { kind: 'silence', pace: 3 }],
};
// 思考块里带花括号：直接读 message.content 会从思考里的 { 开始截，解析失败
const THINK_CONTENT = `<think>先排结构 {开头, 结尾}</think>\n${JSON.stringify(SCRIPT)}`;
const response = (content: unknown, finishReason: string | null = 'stop') =>
  ({ choices: [{ message: { role: 'assistant' as const, content: content as string }, finish_reason: finishReason }] });

const REF = { version: 1, namespace: 'amsg:attachments', key: 'k', taskUuid: 'tu', occurrenceMs: 1, expiresAt: 2 };
const okResult = (jobId = 'job-1', charId = 'c1') => ({
  resultKind: 'cloud-gen', v: 1, jobId, purpose: 'dream', charId, ok: true, attachment: REF,
});
const output = (content: string, finishReason: string | null = 'stop') =>
  JSON.stringify({ v: 1, content, reasoning: '', finishReason });
const record = (overrides: Record<string, unknown> = {}) => ({
  jobId: 'job-1', purpose: 'dream' as const, charId: 'c1', charName: '小明', uuid: 'tu',
  submittedAt: Date.now(), snapshotAt: Date.now(), status: 'running' as const, notify: true,
  context: { archetype: 'ocean' }, ...overrides,
});

const localFetch = async (data: unknown) => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    return { result: await fetchDreamScript({ baseUrl: 'https://api.test/v1/', apiKey: 'k', model: 'm' }, { id: 'c1', name: '小明' }, [{ role: 'user', content: '做梦' }]), fetchMock };
  } finally {
    vi.unstubAllGlobals();
  }
};

beforeEach(() => {
  localStorage.clear();
  setCloudGenHintOff('dream', false); // 顺带让 store 丢掉上一个用例的快照（直接清 localStorage 它看不见）
  dreamSimStore.clear('c1');
  dreamSimStore.clear('c2');
  dreamSimStore.clearDeepLink();
  dreamSimStore.release('c1');
  dreamSimStore.release('c2');
  h.readAttachment.mockReset();
  h.getCharacter.mockReset().mockImplementation(async (id: string) => ({ id, name: id === 'c1' ? '小明' : '小红' }));
});

describe('本机与云端共用同一份校验', () => {
  it('带思考块（含花括号）的正文：本机直连和云端落地解析出同一场梦', async () => {
    const { result, fetchMock } = await localFetch(response(THINK_CONTENT));
    expect(result).toEqual(SCRIPT);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ model: 'm', ...DREAM_REQUEST_PARAMS });

    expect(await lander.land(response(THINK_CONTENT), record(), { jobId: 'job-1', purpose: 'dream', charId: 'c1' })).toBe('landed');
    expect(readCloudGenPending<any>('dream', 'c1')?.script).toEqual(result);
  });

  it('数组形态的 content 两条路都能解析', async () => {
    const parts = [{ type: 'text', text: JSON.stringify(SCRIPT) }];
    expect((await localFetch(response(parts))).result).toEqual(SCRIPT);
    expect(await lander.land(response(parts), record(), { jobId: 'job-1', purpose: 'dream', charId: 'c1' })).toBe('landed');
  });

  it.each([
    ['被截断', response(JSON.stringify(SCRIPT), 'length'), '梦境生成被截断'],
    ['没有碎片', response(JSON.stringify({ ...SCRIPT, fragments: [] })), '梦境为空'],
    ['不是 JSON', response('今晚没做梦'), '梦境解析失败'],
  ])('%s：本机抛同一条原因，云端按失败收尾、不进还没看的梦', async (_label, data, reason) => {
    await expect(localFetch(data)).rejects.toThrow(reason);
    expect(await lander.land(data, record(), { jobId: 'job-1', purpose: 'dream', charId: 'c1' }))
      .toEqual({ failed: { code: 'invalid-output', message: expect.stringContaining(reason) } });
    expect(readCloudGenPending<any>('dream', 'c1')).toBeNull();
  });

  it('深眠允许没有碎片（两条路一致）', async () => {
    const deep = response(JSON.stringify({ archetype: 'deepsleep', title: '', afterglow: '睡得很沉' }));
    expect((await localFetch(deep)).result.fragments).toEqual([]);
    expect(await lander.land(deep, record(), { jobId: 'job-1', purpose: 'dream', charId: 'c1' })).toBe('landed');
  });

  it('DreamTheater 的本机路径和交云端用的是同一份 messages 与参数', () => {
    const source = readFileSync(fileURLToPath(new URL('../apps/DreamTheater.tsx', import.meta.url)), 'utf8');
    expect(source).toContain('fetchDreamScript(apiConfig, char, messages)');
    expect(source).toMatch(/trySubmitCloudGeneration\(\{[\s\S]*?messages, params: DREAM_REQUEST_PARAMS/);
    expect(source).not.toMatch(/parseDream\(|message\.content/);
  });
});

describe('云端结果落进还没看的梦', () => {
  it('刷新之后还在，指示条显示「好了」；打开只是借出，看完 settle 才收走', async () => {
    putCloudGenJob(record({ acceptedAt: Date.now() }));
    h.readAttachment.mockResolvedValue(output(JSON.stringify(SCRIPT)));
    expect(await applyCloudGenResult(okResult())).toBe(true);
    expect(getCloudGenJobById('job-1')?.status).toBe('landed');

    vi.resetModules(); // 模拟刷新：内存里的进度没了，只剩本机存储
    const { dreamSimStore: fresh } = await import('./dreamSimStore');
    expect(fresh.get()).toMatchObject({ status: 'ready', charId: 'c1' });
    expect(fresh.getFor('c1')).toMatchObject({ status: 'ready', script: SCRIPT });

    expect(fresh.consume('c1')).toMatchObject({ status: 'ready', script: SCRIPT, cloudJobId: 'job-1' });
    expect(fresh.get().status).toBe('idle'); // 正在看，指示条不再挂「梦已成形」
    fresh.settle('c1', 'job-1');
    expect(fresh.consume('c1')).toBeNull();
    expect(readCloudGenPending('dream', 'c1')).toBeNull();
    expect(getCloudGenJobById('job-1')).toBeNull();
    expect(fresh.get().status).toBe('idle');
  });

  it('剧场开着时落地、没看完就刷新：梦还在，指示条重新露出来（回归守卫）', async () => {
    putCloudGenJob(record({ acceptedAt: Date.now() }));
    // 剧场挂着等结果：照 DreamTheater 那样订阅、每次变化都取一次
    const off = dreamSimStore.subscribe(() => { dreamSimStore.consume('c1'); });
    h.readAttachment.mockResolvedValue(output(JSON.stringify(SCRIPT)));
    expect(await applyCloudGenResult(okResult())).toBe(true);
    expect(dreamSimStore.consume('c1')).toMatchObject({ status: 'ready', cloudJobId: 'job-1' });
    off();

    vi.resetModules();
    const { dreamSimStore: fresh } = await import('./dreamSimStore');
    expect(readCloudGenPending<any>('dream', 'c1')?.jobId).toBe('job-1');
    expect(fresh.get()).toMatchObject({ status: 'ready', charId: 'c1' });
  });

  it('剧场关了没看完：release 之后指示条重新露出来', () => {
    putCloudGenJob(record({ status: 'landed', settledAt: Date.now() }));
    writeCloudGenPending('dream', 'c1', { jobId: 'job-1', charName: '小明', script: SCRIPT });
    dreamSimStore.consume('c1');
    expect(dreamSimStore.get().status).toBe('idle');
    dreamSimStore.release('c1');
    expect(dreamSimStore.get()).toMatchObject({ status: 'ready', charId: 'c1' });
  });

  it('settle 只收走自己那份：同一角色后来落地的不动', () => {
    writeCloudGenPending('dream', 'c1', { jobId: 'job-2', charName: '小明', script: SCRIPT });
    dreamSimStore.settle('c1', 'job-1');
    expect(readCloudGenPending<any>('dream', 'c1')?.jobId).toBe('job-2');
  });

  it('DreamTheater 看完写库、确认放弃时才收走，打开时不收', () => {
    const source = readFileSync(fileURLToPath(new URL('../apps/DreamTheater.tsx', import.meta.url)), 'utf8');
    expect(source).toMatch(/return \{ dreamLogs \};\s*\}\);[\s\S]*?settleCloudDream\(\);\s*\}, \[char, updateCharacter/);
    expect(source).toMatch(/if \(!ok\) return;\s*settleCloudDream\(\);\s*onExit\(\);/);
    expect(source).toContain('dreamSimStore.release(char.id)');
  });

  it('登记表那条过了保留期，还没看的梦照样能取走', () => {
    writeCloudGenPending('dream', 'c1', { jobId: 'old', charName: '小明', script: SCRIPT });
    expect(dreamSimStore.consume('c1')).toMatchObject({ status: 'ready', script: SCRIPT });
  });

  it('角色已删：丢弃，不留还没看的梦', async () => {
    h.getCharacter.mockResolvedValue(undefined);
    expect(await lander.land(response(JSON.stringify(SCRIPT)), record(), { jobId: 'job-1', purpose: 'dream', charId: 'c1' })).toBe('discarded');
    expect(readCloudGenPending('dream', 'c1')).toBeNull();
  });

  it('没通过校验：登记表标失败、小条消失，打开时取到失败并收走那条', async () => {
    putCloudGenJob(record({ acceptedAt: Date.now() }));
    h.readAttachment.mockResolvedValue(output(JSON.stringify(SCRIPT), 'length'));
    expect(await applyCloudGenResult(okResult())).toBe(true);
    expect(getCloudGenJobById('job-1')).toMatchObject({ status: 'failed', error: { code: 'invalid-output' } });
    expect(dreamSimStore.get().status).toBe('idle');
    expect(dreamSimStore.consume('c1')).toMatchObject({ status: 'error', cloudJobId: 'job-1' });
    expect(getCloudGenJobById('job-1')).toBeNull();
  });

  it('云端明确失败：小条消失，打开时取到失败并收走那条', () => {
    putCloudGenJob(record({ acceptedAt: Date.now() }));
    markCloudGenJobFailed('job-1', { code: 'x', message: '模型报错' });
    expect(dreamSimStore.get().status).toBe('idle');
    expect(dreamSimStore.getFor('c1').status).toBe('error');
    expect(dreamSimStore.consume('c1')).toMatchObject({ status: 'error', cloudJobId: 'job-1' });
    expect(getCloudGenJobById('job-1')).toBeNull();
  });
});

describe('两个角色的梦互不覆盖', () => {
  it('A 本机的梦好了，B 开始做梦，A 那场还在', () => {
    dreamSimStore.set({ status: 'ready', charId: 'c1', charName: '小明', script: SCRIPT as any });
    dreamSimStore.set({ status: 'loading', charId: 'c2', charName: '小红' });
    expect(dreamSimStore.getFor('c1')).toMatchObject({ status: 'ready', script: SCRIPT });
    expect(dreamSimStore.get()).toMatchObject({ status: 'ready', charId: 'c1' });
    expect(dreamSimStore.consume('c2')).toBeNull(); // B 还在做，不会被取走
    expect(dreamSimStore.consume('c1')).toMatchObject({ status: 'ready', charId: 'c1' });
  });

  it('A 云端还没看的梦，不会被 B 本机的进度冲掉', () => {
    putCloudGenJob(record({ status: 'landed', settledAt: Date.now() }));
    writeCloudGenPending('dream', 'c1', { jobId: 'job-1', charName: '小明', script: SCRIPT });
    dreamSimStore.set({ status: 'loading', charId: 'c2', charName: '小红' });
    dreamSimStore.set({ status: 'error', charId: 'c2', charName: '小红' });
    expect(dreamSimStore.getFor('c1')).toMatchObject({ status: 'ready', script: SCRIPT });
    expect(dreamSimStore.consume('c2')).toMatchObject({ status: 'error', charId: 'c2' });
    expect(dreamSimStore.consume('c1')).toMatchObject({ status: 'ready', charId: 'c1' });
  });

  it('深链指向点的那个角色', () => {
    dreamSimStore.set({ status: 'ready', charId: 'c1', charName: '小明', script: SCRIPT as any });
    dreamSimStore.set({ status: 'loading', charId: 'c2', charName: '小红' });
    dreamSimStore.requestOpen('c2');
    expect(dreamSimStore.get()).toMatchObject({ charId: 'c2', deepLink: true });
  });
});

describe('云端生成小条文案', () => {
  it('Worker 收下之后才改写成云端生成；选了不再提醒就保持本机文案', () => {
    putCloudGenJob(record());
    expect(dreamSimStore.get()).toMatchObject({ status: 'loading', charId: 'c1' });
    expect((dreamSimStore.get() as any).cloudSheet).toBeUndefined(); // 上传中、还没收下

    putCloudGenJob(record({ acceptedAt: Date.now(), notify: false }));
    expect((dreamSimStore.get() as any).cloudSheet).toEqual({ notify: false });

    setCloudGenHintOff('dream', true);
    expect(dreamSimStore.get()).toMatchObject({ status: 'loading', charId: 'c1' });
    expect((dreamSimStore.get() as any).cloudSheet).toBeUndefined();
  });

  it('同一角色本机正在上传时，以本机的进度为准', () => {
    dreamSimStore.set({ status: 'loading', charId: 'c1', charName: '小明' });
    putCloudGenJob(record({ acceptedAt: Date.now() }));
    expect((dreamSimStore.getFor('c1') as any).cloudSheet).toBeUndefined();
    dreamSimStore.clear('c1');
    expect((dreamSimStore.getFor('c1') as any).cloudSheet).toEqual({ notify: true });
  });
});
