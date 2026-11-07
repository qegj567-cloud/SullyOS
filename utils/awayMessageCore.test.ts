import { describe, expect, it } from 'vitest';
import {
  AWAY_SEGMENT_MARK,
  decideAwayTaskAction,
  findAwayGapStart,
  planAwaySlots,
  splitAwaySegments,
} from './awayMessageCore';

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const DELAY = 90 * MIN;

describe('findAwayGapStart（本地版这次上线补不补）', () => {
  it('对方超过等待时长没开口 → 返回最后那次开口的时刻', () => {
    const msgs = [
      { role: 'user', timestamp: NOW - 120 * MIN },
      { role: 'assistant', timestamp: NOW - 119 * MIN },
    ];
    expect(findAwayGapStart(msgs, DELAY, NOW)).toBe(NOW - 120 * MIN);
  });

  it('还没到等待时长 → 不补', () => {
    expect(findAwayGapStart([{ role: 'user', timestamp: NOW - 30 * MIN }], DELAY, NOW)).toBeNull();
  });

  it('一次离开只补一次：最后开口之后已经有补过的消息 → 不再补', () => {
    const msgs = [
      { role: 'user', timestamp: NOW - 300 * MIN },
      { role: 'assistant', timestamp: NOW - 200 * MIN, metadata: { awayMessage: true } },
    ];
    expect(findAwayGapStart(msgs, DELAY, NOW)).toBeNull();
  });

  it('对方开口后重新计时：上一段补过的不影响这一段', () => {
    const msgs = [
      { role: 'assistant', timestamp: NOW - 400 * MIN, metadata: { awayMessage: true } },
      { role: 'user', timestamp: NOW - 200 * MIN },
    ];
    expect(findAwayGapStart(msgs, DELAY, NOW)).toBe(NOW - 200 * MIN);
  });

  it('隐藏提示不算对方开口；从没开过口 → 不补', () => {
    expect(findAwayGapStart([{ role: 'user', timestamp: NOW - 500 * MIN, metadata: { proactiveHint: true } }], DELAY, NOW)).toBeNull();
  });
});

describe('planAwaySlots', () => {
  it('离开不到两个等待时长 → 一次，落在等待时长刚满的时候', () => {
    expect(planAwaySlots(NOW - 100 * MIN, DELAY, NOW)).toEqual([NOW - 10 * MIN]);
  });

  it('离开很久 → 最多三次，按时间先后、都在现在之前', () => {
    const slots = planAwaySlots(NOW - 24 * 60 * MIN, DELAY, NOW);
    expect(slots).toHaveLength(3);
    expect(slots[0]).toBe(NOW - 24 * 60 * MIN + DELAY);
    expect(slots[1]).toBeGreaterThan(slots[0]);
    expect(slots[2]).toBeGreaterThan(slots[1]);
    expect(slots[2]).toBeLessThan(NOW);
  });
});

describe('splitAwaySegments', () => {
  it('按标记切开、去空段', () => {
    expect(splitAwaySegments(`在干嘛\n${AWAY_SEGMENT_MARK}\n\n${AWAY_SEGMENT_MARK}\n人呢`, 3)).toEqual(['在干嘛', '人呢']);
  });

  it('多出来的并进最后一段，不丢内容', () => {
    expect(splitAwaySegments(`a${AWAY_SEGMENT_MARK}b${AWAY_SEGMENT_MARK}c`, 2)).toEqual(['a', 'b\nc']);
  });
});

describe('decideAwayTaskAction（云端版每轮发不发请求）', () => {
  it('没有任务 → 新建', () => {
    expect(decideAwayTaskAction(null, NOW + DELAY, NOW)).toBe('create');
  });

  it('排期离目标不到 10 分钟 → 不发请求，差的由 worker 推迟兜住', () => {
    expect(decideAwayTaskAction(NOW + DELAY - 5 * MIN, NOW + DELAY, NOW)).toBe('keep');
  });

  it('排早了 → 原地改期', () => {
    expect(decideAwayTaskAction(NOW + 30 * MIN, NOW + DELAY, NOW)).toBe('renew');
  });

  it('排期已经过了（可能发过，也可能被 worker 推迟着）→ 去改期，远端没了再新建', () => {
    expect(decideAwayTaskAction(NOW - MIN, NOW + DELAY, NOW)).toBe('renew');
  });
});
