// utils/amsgResults.test.ts
//
// 回归守卫（云端结果的分发口要排队）。同一条结果有两条腿会送到这儿：推送直达
// （SW 的 active-msg-result）和上线补收（drainOutbox）。两条腿会撞车——推送刚到、
// 页面正好因为 visibilitychange 跑了一趟补收。而 handler 普遍是「读一份 → 改 →
// 整块存回去」，并发跑就是后写的把先写的整块盖掉，两边日志还都显示成功。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { trace, behavior, seenContexts } = vi.hoisted(() => ({
  trace: [] as string[],
  behavior: { throwOn: null as string | null, hangOn: null as string | null },
  seenContexts: [] as unknown[],
}));

vi.mock('./memoryPalace/roomPlateCloud', () => ({
  applyPlateConsolidateResult: vi.fn(async (payload: any, context?: unknown) => {
    trace.push(`enter:${payload.jobId}`);
    // IDB 连接被别的标签页 block 住时就是这个形态：promise 一辈子不 settle
    if (behavior.hangOn === payload.jobId) return new Promise<boolean>(() => {});
    // 让出一次事件循环：没有排队的话，第二条会在这儿插进来
    await new Promise((resolve) => setTimeout(resolve, 0));
    trace.push(`exit:${payload.jobId}`);
    if (behavior.throwOn === payload.jobId) throw new Error('IDB 抖了一下');
    seenContexts.push(context);
    return true;
  }),
}));

import { PLATE_CONSOLIDATE_RESULT_KIND } from './amsgPlateJob';
import { dispatchAmsgResult } from './amsgResults';

const result = (jobId: string) => ({ resultKind: PLATE_CONSOLIDATE_RESULT_KIND, jobId });

beforeEach(() => {
  trace.length = 0;
  seenContexts.length = 0;
  behavior.throwOn = null;
  behavior.hangOn = null;
});

describe('结果分发口排队', () => {
  it('另一个用户的云端结果不执行也不销账', async () => {
    localStorage.setItem('sully_user_spaces_v1', JSON.stringify([{ id: 'default', name: '甲' }, { id: 'u_other', name: '乙' }]));
    try {
      expect(await dispatchAmsgResult({ ...result('other-user'), charId: 'only-in-other-space' })).toBe(false);
      expect(trace).toEqual([]);
    } finally { localStorage.removeItem('sully_user_spaces_v1'); }
  });
  it('两条同时到达也串行落地，不交错', async () => {
    await Promise.all([dispatchAmsgResult(result('a')), dispatchAmsgResult(result('b'))]);

    expect(trace, '交错的话就是两次读改写撞在一起，后写的整块盖掉先写的')
      .toEqual(['enter:a', 'exit:a', 'enter:b', 'exit:b']);
  });

  it('前一条炸了也不掐断队列（它自己记成「账没销」）', async () => {
    behavior.throwOn = 'a';

    const [first, second] = await Promise.all([
      dispatchAmsgResult(result('a')),
      dispatchAmsgResult(result('b')),
    ]);

    expect(first, '消化失败要留着账，下次上线再拉回来').toBe(false);
    expect(second).toBe(true);
    expect(trace).toEqual(['enter:a', 'exit:a', 'enter:b', 'exit:b']);
  });

  // 回归守卫：worker 可以脱开前端单独更新（fork 的 Sync → Cloudflare Workers Builds），
  // PWA 那边还可能跑着缓存下来的旧包——「worker 比前端新」是这套部署方式必然造得出来的
  // 状态。当场销账的话，这份跑完的活儿在前端更新上来之前就已经从服务端账本上抹掉了。
  it('认不出的结果种类先留着不销账（等前端更新上来还能接着处理）', async () => {
    await expect(
      dispatchAmsgResult({ resultKind: 'something-new' }),
      '销掉的话前端更新完再来找，东西已经没了',
    ).resolves.toBe(false);
    expect(trace).toEqual([]);
  });

  it('压根没有 resultKind 的照旧销账（形状本身就坏了，换个版本也读不出来）', async () => {
    await expect(dispatchAmsgResult({ nothing: true })).resolves.toBe(true);
    expect(trace).toEqual([]);
  });

  it('随身信息（账本上记的时间）原样交给认领它的那一方', async () => {
    await dispatchAmsgResult(result('a'), { createdAt: 1_700_000_000_000 });

    expect(seenContexts.at(-1), 'handler 拿不到时间就没法判「这份产物是不是已经陈到不能用」')
      .toEqual({ createdAt: 1_700_000_000_000 });
  });

  // 回归守卫：队是全局一条、所有 resultKind 共用的，而 handler 干的是 IndexedDB 的活儿。
  // 连接被别的标签页 block 住（IndexedDB 连接风暴时就出过这种事），promise
  // 一辈子不 settle——没有超时的话后面每一条都永远排不上，而且一点动静都没有。
  //
  // 放在最后一条：这一队是模块级的全局状态，卡住那条会一直挂在队尾。
  it('一条卡住不 settle 也不许把整条队钉死', async () => {
    vi.useFakeTimers();
    try {
      behavior.hangOn = 'a';
      const first = dispatchAmsgResult(result('a'));
      const second = dispatchAmsgResult(result('b'));

      await vi.advanceTimersByTimeAsync(60_000);
      expect(await first, '超时那条按「账没销」算，下次上线还会拉回来').toBe(false);

      // 卡住那条让开之后，排在后面的照常轮到（它自己那次让出事件循环也要走完）
      await vi.advanceTimersByTimeAsync(10);
      expect(await second, '排在后面的一条都落不了地，后台产物全静默积压').toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
