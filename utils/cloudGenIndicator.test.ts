// @vitest-environment jsdom
// 回归守卫：「云端生成」小条和说明页。
//   1. 只认 Worker 确认收下（acceptedAt）的任务：上传那几秒里切走照样会断，不能叫人放心离开。
//   2. 「本功能不再提醒」之后在飞的不再提示；人格模拟、梦境有自己的胶囊，这里不重复显示。
//   3. 同一功能几位角色合成一颗胶囊；落地后点「进入」交给落地函数打开，再收走记录；失败的直接收走。
//   4. 说明页只有「这次会发通知」且「这台设备收得到」时才说会弹通知。
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lander = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('./cloudGen/landers', () => ({ loadCloudGenLander: vi.fn(async () => ({ land: vi.fn(), open: lander.open })) }));
const push = vi.hoisted(() => ({ getPushStatus: vi.fn() }));
vi.mock('./activeMsgClient', () => ({ ActiveMsgClient: push }));

import CloudGenIndicator, { pickCloudGenPill } from '../components/os/CloudGenIndicator';
import CloudGenSheet, { cloudGenSheetCopy } from '../components/os/CloudGenSheet';
import { CLOUD_GEN_JOBS_KEY, type CloudGenJobRecord, type CloudGenPurpose } from './cloudGen/types';
import { listCloudGenJobs } from './cloudGen/registry';
import { closeCloudGenSheet, isCloudGenHintOff, openCloudGenSheet, setCloudGenHintOff } from './cloudGen/hint';

const job = (over: Partial<CloudGenJobRecord> & { jobId: string }): CloudGenJobRecord => ({
  purpose: 'schedule', charId: `char-${over.jobId}`, charName: '小明', uuid: `uuid-${over.jobId}`,
  submittedAt: Date.now(), snapshotAt: Date.now(), status: 'running', notify: false, context: null,
  ...over,
});
const seed = (records: CloudGenJobRecord[]) => localStorage.setItem(CLOUD_GEN_JOBS_KEY, JSON.stringify(records));
const noneOff = (_: CloudGenPurpose) => false;

describe('pickCloudGenPill', () => {
  it('没有 acceptedAt 的在飞任务不显示', () => {
    expect(pickCloudGenPill([job({ jobId: 'a' })], noneOff)).toBeNull();
    expect(pickCloudGenPill([job({ jobId: 'a', acceptedAt: 1 })], noneOff)?.label).toBe('云端生成 · 日程');
  });

  it('选了不再提醒的功能不显示；人格模拟、梦境写好后用各自原来的胶囊', () => {
    expect(pickCloudGenPill([job({ jobId: 'a', acceptedAt: 1 })], (p) => p === 'schedule')).toBeNull();
    expect(pickCloudGenPill([job({ jobId: 'b', status: 'landed', settledAt: 5 })], (p) => p === 'schedule')).toBeNull();
    expect(pickCloudGenPill([
      job({ jobId: 'd', purpose: 'dream', acceptedAt: 1, status: 'landed', settledAt: 2 }),
      job({ jobId: 'p', purpose: 'persona-sim', acceptedAt: 1, status: 'landed', settledAt: 3 }),
    ], noneOff)).toBeNull();
  });

  it('在飞的提示三个功能共用一颗，几个功能同时在跑就并列写出来', () => {
    expect(pickCloudGenPill([job({ jobId: 'p', purpose: 'persona-sim', acceptedAt: 1 })], noneOff)?.label).toBe('云端生成 · 人格模拟');
    expect(pickCloudGenPill([
      job({ jobId: 's', acceptedAt: 1 }),
      job({ jobId: 'd', purpose: 'dream', charId: 'x', acceptedAt: 1 }),
    ], noneOff)).toMatchObject({ label: '云端生成 · 日程、梦境', jobIds: ['s', 'd'] });
  });

  it('几位角色同时在跑合成一颗；有一份不发通知就不承诺通知', () => {
    const pill = pickCloudGenPill([
      job({ jobId: 'a', acceptedAt: 1, notify: true }),
      job({ jobId: 'b', acceptedAt: 1, notify: false }),
    ], noneOff);
    expect(pill).toMatchObject({ kind: 'running', label: '云端生成 · 日程 ×2', notify: false });
  });

  it('落地的优先显示「日程好了 · 进入」，失败的什么都不显示', () => {
    expect(pickCloudGenPill([
      job({ jobId: 'a', acceptedAt: 1 }),
      job({ jobId: 'b', status: 'landed', settledAt: 5 }),
    ], noneOff)).toMatchObject({ kind: 'landed', label: '日程好了 · 进入' });
    expect(pickCloudGenPill([job({ jobId: 'c', status: 'failed', settledAt: 5 })], noneOff)).toBeNull();
  });
});

let host: HTMLDivElement;
let root: Root;
const render = async (node: React.ReactElement) => { await act(async () => { root.render(node); }); };
const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); }); };
const buttonByText = (text: string) => Array.from(host.querySelectorAll('button')).find((item) => item.textContent === text);

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  lander.open.mockReset();
  push.getPushStatus.mockReset();
  closeCloudGenSheet();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe('CloudGenIndicator', () => {
  it('点在飞的胶囊打开说明页；选了不再提醒后胶囊收起', async () => {
    seed([job({ jobId: 'a', acceptedAt: 1, notify: true })]);
    await render(React.createElement(React.Fragment, null, React.createElement(CloudGenIndicator), React.createElement(CloudGenSheet)));
    push.getPushStatus.mockResolvedValue({ hasSubscription: true, permission: 'granted' });
    await act(async () => { buttonByText('云端生成 · 日程')!.click(); });
    await flush();
    expect(host.textContent).toContain('生成完毕会弹出消息通知。');
    await act(async () => { buttonByText('本功能不再提醒')!.click(); });
    expect(isCloudGenHintOff('schedule')).toBe(true);
    expect(host.textContent).not.toContain('云端生成 · 日程');
    expect(host.textContent).not.toContain('这次请求交给了你的主动消息 2.0 后台');
  });

  it('落地后点「进入」交给落地函数打开并收走记录；失败的记录不显示、也不收走（日程的失败退避靠它撑过刷新）', async () => {
    seed([
      job({ jobId: 'done', status: 'landed', settledAt: Date.now() }),
      job({ jobId: 'bad', charId: 'other', status: 'failed', settledAt: Date.now() }),
    ]);
    await render(React.createElement(CloudGenIndicator));
    expect(listCloudGenJobs().map((r) => r.jobId).sort()).toEqual(['bad', 'done']);
    await act(async () => { buttonByText('日程好了 · 进入')!.click(); });
    await flush();
    expect(lander.open).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'done' }));
    expect(listCloudGenJobs().map((r) => r.jobId)).toEqual(['bad']);
    expect(host.textContent).toBe('');
  });
});

describe('CloudGenIndicator · 一次性提示', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('弹出 3 秒后往上收起；同一份任务不再弹，下一份交上去照样弹', async () => {
    vi.useFakeTimers();
    seed([job({ jobId: 't1', acceptedAt: 1 })]);
    await render(React.createElement(CloudGenIndicator));
    expect(host.textContent).toContain('云端生成 · 日程');
    await act(async () => { vi.advanceTimersByTime(2900); });
    expect(host.textContent).toContain('云端生成 · 日程');
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(host.textContent).toBe('');
    // 同一份任务重渲染、重新挂载都不再弹
    await render(React.createElement(CloudGenIndicator));
    expect(host.textContent).toBe('');
    seed([job({ jobId: 't1', acceptedAt: 1 }), job({ jobId: 't2', charId: 'other', acceptedAt: 1 })]);
    await render(React.createElement(React.Fragment, { key: 'again' }, React.createElement(CloudGenIndicator)));
    expect(host.textContent).toContain('云端生成 · 日程 ×2');
  });

  it('上滑立刻收起，不会顺手打开说明页', async () => {
    vi.useFakeTimers();
    seed([job({ jobId: 'sw1', acceptedAt: 1 })]);
    await render(React.createElement(React.Fragment, null, React.createElement(CloudGenIndicator), React.createElement(CloudGenSheet)));
    const pill = host.querySelector('button')!;
    await act(async () => {
      pill.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientY: 100 }));
      pill.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: 60 }));
      pill.click();
    });
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(host.textContent).not.toContain('云端生成 · 日程');
    expect(host.textContent).not.toContain('这次请求交给了你的主动消息 2.0 后台');
  });
});

describe('CloudGenSheet', () => {
  it('文案：会通知才说弹通知', () => {
    expect(cloudGenSheetCopy(true)).toBe('这次请求交给了你的主动消息 2.0 后台，在云端生成。现在可以暂时退出应用，生成不会中断。生成完毕会弹出消息通知。');
    expect(cloudGenSheetCopy(false)).toBe('这次请求交给了你的主动消息 2.0 后台，在云端生成。现在可以暂时退出应用，生成不会中断。生成完毕后，回到应用就能看到。');
  });

  it.each([
    ['这次不发通知', false, { hasSubscription: true, permission: 'granted' }],
    ['这台设备没有推送订阅', true, { hasSubscription: false, permission: 'granted' }],
    ['通知权限没给', true, { hasSubscription: true, permission: 'denied' }],
  ])('%s：最后一句改成回到应用就能看到', async (_, notify, status) => {
    push.getPushStatus.mockResolvedValue(status);
    await render(React.createElement(CloudGenSheet));
    await act(async () => { openCloudGenSheet({ purpose: 'dream', notify }); });
    await flush();
    expect(host.textContent).toContain('生成完毕后，回到应用就能看到。');
    expect(host.textContent).not.toContain('会弹出消息通知');
  });

  it('推送状态读不出来时不承诺通知', async () => {
    push.getPushStatus.mockRejectedValue(new Error('读不到'));
    await render(React.createElement(CloudGenSheet));
    await act(async () => { openCloudGenSheet({ purpose: 'persona-sim', notify: true }); });
    await flush();
    expect(host.textContent).toContain('云端生成 · 人格模拟');
    expect(host.textContent).toContain('回到应用就能看到');
  });

  it('「本功能不再提醒」只关这一项', async () => {
    setCloudGenHintOff('schedule', false);
    await render(React.createElement(CloudGenSheet));
    await act(async () => { openCloudGenSheet({ purpose: 'dream', notify: false }); });
    await act(async () => { buttonByText('本功能不再提醒')!.click(); });
    expect(isCloudGenHintOff('dream')).toBe(true);
    expect(isCloudGenHintOff('schedule')).toBe(false);
    expect(host.textContent).toBe('');
  });
});
