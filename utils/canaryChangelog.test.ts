import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANARY_CHANGELOG,
  CANARY_CHANGELOG_SEEN_KEY,
  formatCanaryChangelogDate,
  markCanaryChangelogSeen,
  takeCanaryChangelog,
  type CanaryChangelogDay,
} from './canaryChangelog';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

const v1: CanaryChangelogDay[] = [{ date: '2026-11-24', items: ['甲', '乙'] }];
const v2: CanaryChangelogDay[] = [
  { date: '2026-11-25', items: ['丁'] },
  { date: '2026-11-24', items: ['甲', '乙', '丙'] },
];

describe('canary 更新日志', () => {
  it('只弹没看过的条目，按天分组、新的一天在前', () => {
    markCanaryChangelogSeen(v1);
    expect(takeCanaryChangelog(false, v2, 'canary')).toEqual([
      { date: '2026-11-25', items: ['丁'] },
      { date: '2026-11-24', items: ['丙'] },
    ]);
  });

  it('关掉之后同一份日志不再弹', () => {
    markCanaryChangelogSeen(v2);
    expect(takeCanaryChangelog(false, v2, 'canary')).toEqual([]);
  });

  it('刚加入的那次启动不弹，并把现有条目记成看过', () => {
    expect(takeCanaryChangelog(true, v1, 'canary')).toEqual([]);
    expect(takeCanaryChangelog(false, v2, 'canary')).toEqual([
      { date: '2026-11-25', items: ['丁'] },
      { date: '2026-11-24', items: ['丙'] },
    ]);
  });

  it('正式版永远不弹', () => {
    expect(takeCanaryChangelog(false, v2, 'stable')).toEqual([]);
  });

  it('存储读不出来时不弹，免得每次开机都弹', () => {
    store.set(CANARY_CHANGELOG_SEEN_KEY, '{坏掉');
    expect(takeCanaryChangelog(false, v2, 'canary')).toEqual([]);
  });

  it('日志里日期合法、新的在前、同一天没有重复条目', () => {
    const dates = CANARY_CHANGELOG.map((day) => day.date);
    for (const day of CANARY_CHANGELOG) {
      expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(day.items.length).toBeGreaterThan(0);
      expect(new Set(day.items).size).toBe(day.items.length);
    }
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('日期显示成「月 日」', () => {
    expect(formatCanaryChangelogDate('2026-11-04')).toBe('11 月 4 日');
  });
});
