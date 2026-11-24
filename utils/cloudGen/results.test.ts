// utils/cloudGen/results.test.ts
// 代跑结果落地的回归守卫：经 amsgResults 分发进来；附件拼回 OpenAI 形状交给落地函数；重放靠底账
// 挡住；失败结果标 failed；登记表里查不到的只交给声明接收的落地函数；落地抛错不销账；点名兜底。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  readAttachment: vi.fn(),
  getRemoteTaskStatus: vi.fn(),
  settleCloudApiCall: vi.fn(),
  lander: {
    land: vi.fn(),
    onFailed: vi.fn(async () => {}),
    acceptsOrphanResults: false,
  },
}));

vi.mock('../activeMsgClient', () => ({
  ActiveMsgClient: { readAttachment: h.readAttachment, getRemoteTaskStatus: h.getRemoteTaskStatus },
}));
vi.mock('../apiCallLog', () => ({
  cloudApiCallLogId: (id: string) => `cloud-${id}`,
  settleCloudApiCall: h.settleCloudApiCall,
}));
vi.mock('../analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('./landers', () => ({ loadCloudGenLander: async () => h.lander }));

import { dispatchAmsgResult } from '../amsgResults';
import { applyCloudGenResult } from './results';
import {
  CLOUD_GEN_STALE_MS, getCloudGenJobById, isCloudGenJobDone, listCloudGenJobs, putCloudGenJob, sweepStaleCloudGenJobs,
} from './registry';

const REF = { version: 1, namespace: 'amsg:attachments', key: 'k', taskUuid: 'tu', occurrenceMs: 1, expiresAt: 2 };
const okResult = (jobId = 'job-1') => ({
  resultKind: 'cloud-gen', v: 1, jobId, purpose: 'persona-sim', charId: 'c1', ok: true, attachment: REF,
  usage: { promptTokens: 100, completionTokens: 900, backendModel: 'served' },
});
const record = (overrides: Record<string, unknown> = {}) => ({
  jobId: 'job-1', purpose: 'persona-sim' as const, charId: 'c1', charName: '小明', uuid: 'tu',
  submittedAt: Date.now(), snapshotAt: Date.now(), status: 'running' as const, notify: true, context: { theme: '雨天' },
  ...overrides,
});
const OUTPUT = JSON.stringify({ v: 1, content: '剧本正文', reasoning: '想了想', finishReason: 'length' });

beforeEach(() => {
  localStorage.clear();
  h.readAttachment.mockReset().mockResolvedValue(OUTPUT);
  h.getRemoteTaskStatus.mockReset();
  h.settleCloudApiCall.mockClear();
  h.lander.land.mockReset().mockResolvedValue('landed');
  h.lander.onFailed.mockClear();
  h.lander.acceptsOrphanResults = false;
});

describe('成功结果', () => {
  it('经分发口进来，附件拼回本机直连的响应形状交给落地函数', async () => {
    putCloudGenJob(record());
    expect(await dispatchAmsgResult(okResult())).toBe(true);

    expect(h.readAttachment).toHaveBeenCalledWith(REF);
    const [response, rec, info] = h.lander.land.mock.calls[0];
    expect(response).toEqual({
      choices: [{ message: { role: 'assistant', content: '剧本正文', reasoning_content: '想了想' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 100, completion_tokens: 900 },
      model: 'served',
    });
    expect(rec).toMatchObject({ jobId: 'job-1', context: { theme: '雨天' } });
    expect(info).toMatchObject({ jobId: 'job-1', purpose: 'persona-sim', charId: 'c1' });
    expect(getCloudGenJobById('job-1')?.status).toBe('landed');
    expect(h.settleCloudApiCall).toHaveBeenCalledWith(expect.objectContaining({ id: 'cloud-job-1', ok: true, promptTokens: 100 }));
  });

  it('同一份结果再来一次（补收、推送各送一遍）→ 直接销账，不再落地', async () => {
    putCloudGenJob(record());
    await applyCloudGenResult(okResult());
    expect(await applyCloudGenResult(okResult())).toBe(true);
    expect(h.lander.land).toHaveBeenCalledTimes(1);
    expect(isCloudGenJobDone('job-1')).toBe(true);
  });

  it('落地函数说不要了 → 登记表里删掉', async () => {
    putCloudGenJob(record());
    h.lander.land.mockResolvedValue('discarded');
    await applyCloudGenResult(okResult());
    expect(getCloudGenJobById('job-1')).toBeNull();
  });

  it('落地函数判结果不合格 → 按失败收尾：标 failed、交给 onFailed、调用记录记失败、销账', async () => {
    putCloudGenJob(record());
    const failed = { code: 'truncated', message: '剧本被截断了' };
    h.lander.land.mockResolvedValue({ failed });
    expect(await applyCloudGenResult(okResult())).toBe(true);
    expect(getCloudGenJobById('job-1')).toMatchObject({ status: 'failed', error: failed });
    expect(h.lander.onFailed).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1' }), failed);
    expect(h.settleCloudApiCall).toHaveBeenCalledWith(expect.objectContaining({ id: 'cloud-job-1', ok: false }));
    expect(isCloudGenJobDone('job-1')).toBe(true);
  });

  it('落地抛错 → 不销账、不记底账，下次再来', async () => {
    putCloudGenJob(record());
    h.lander.land.mockRejectedValue(new Error('IDB 卡住'));
    expect(await applyCloudGenResult(okResult())).toBe(false);
    expect(isCloudGenJobDone('job-1')).toBe(false);
    expect(getCloudGenJobById('job-1')?.status).toBe('running');
  });

  it('读附件网络出错 → 不销账', async () => {
    putCloudGenJob(record());
    h.readAttachment.mockRejectedValue(new Error('offline'));
    expect(await applyCloudGenResult(okResult())).toBe(false);
  });

  it('附件过期取不回来 → 标失败并销账', async () => {
    putCloudGenJob(record());
    h.readAttachment.mockResolvedValue(null);
    expect(await applyCloudGenResult(okResult())).toBe(true);
    expect(getCloudGenJobById('job-1')).toMatchObject({ status: 'failed', error: { code: 'attachment-missing' } });
    expect(h.lander.land).not.toHaveBeenCalled();
  });
});

describe('登记表里查不到的结果', () => {
  it('落地函数没声明接收 → 销账丢弃', async () => {
    expect(await applyCloudGenResult(okResult('stranger'))).toBe(true);
    expect(h.readAttachment).not.toHaveBeenCalled();
    expect(h.lander.land).not.toHaveBeenCalled();
  });

  it('声明接收 → 照样交给它，record 为 null', async () => {
    h.lander.acceptsOrphanResults = true;
    await applyCloudGenResult(okResult('stranger'));
    expect(h.lander.land).toHaveBeenCalledWith(expect.anything(), null, expect.objectContaining({ jobId: 'stranger' }));
  });
});

describe('失败结果', () => {
  it('标成 failed、调用记录记失败、交给 onFailed', async () => {
    putCloudGenJob(record());
    const failed = { ...okResult(), ok: false, attachment: undefined, error: { code: 'LLM_CALL_FAILED', message: '429' } };
    expect(await applyCloudGenResult(failed)).toBe(true);
    expect(getCloudGenJobById('job-1')).toMatchObject({ status: 'failed', error: { code: 'LLM_CALL_FAILED' } });
    expect(h.lander.onFailed).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1' }), { code: 'LLM_CALL_FAILED', message: '429' });
    expect(h.settleCloudApiCall).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(h.lander.land).not.toHaveBeenCalled();
  });
});

describe('点名兜底', () => {
  it('跑太久的去问云端：行没了标失败，还在排队的留着', async () => {
    const old = Date.now() - CLOUD_GEN_STALE_MS - 1000;
    putCloudGenJob(record({ jobId: 'gone', uuid: 'u-gone', submittedAt: old }));
    putCloudGenJob(record({ jobId: 'queued', uuid: 'u-queued', purpose: 'dream', submittedAt: old }));
    h.getRemoteTaskStatus.mockImplementation(async (uuid: string) => ({ state: uuid === 'u-gone' ? 'gone' : 'pending' }));
    await sweepStaleCloudGenJobs();
    expect(getCloudGenJobById('gone')).toMatchObject({ status: 'failed', error: { code: 'lost' } });
    expect(getCloudGenJobById('queued')?.status).toBe('running');
    // 超时判失败也要走落地函数的失败收尾，用户发起的功能才弹得出失败提示。
    expect(h.lander.onFailed).toHaveBeenCalledTimes(1);
    expect(h.lander.onFailed).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'gone' }), expect.objectContaining({ code: 'lost' }));
  });

  it('超过一天的记录不论状态都清掉，免得一直挡着这个功能', () => {
    putCloudGenJob(record({ submittedAt: Date.now() - 25 * 60 * 60_000 }));
    expect(listCloudGenJobs()).toEqual([]);
  });
});
