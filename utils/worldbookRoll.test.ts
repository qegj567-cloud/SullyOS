// utils/worldbookRoll.test.ts
//
// 回归守卫：世界书里按概率触发的条目，云端每次到点重新抽签（与本地每轮都抽一致）。
// 打包时不抽，条目用占位标记包起来、概率随 fire_pack 带上，worker 到点用同一个函数抽。
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as wb from './worldbook';

const book = (over: Record<string, unknown> = {}) => ({
  id: 'wb-rain', title: '雨天', content: '下雨天会犯困', constant: true, key: [],
  useProbability: true, probability: 35, position: 1, ...over,
}) as any;
const sectionOf = (books: any[]) =>
  (wb as any).formatWorldbookSection(wb.resolveWorldbookEntries(books, [], '小满', '小明'), '扩展设定集 (Worldbooks)');

afterEach(() => { vi.restoreAllMocks(); });

describe('rollWorldbookProbability', () => {
  it('概率 0 和 100 时结果确定，与随机源无关', () => {
    const roll = (wb as any).rollWorldbookProbability;
    for (const r of [0, 0.5, 0.9999]) {
      expect(roll(0, () => r)).toBe(false);
      expect(roll(100, () => r)).toBe(true);
    }
    expect(roll(35, () => 0.34)).toBe(true);
    expect(roll(35, () => 0.35)).toBe(false);
  });
});

describe('打包时推迟抽签、到点重抽', () => {
  const pack = () => {
    const deferred = (wb as any).deferWorldbookRolls([book(), book({ id: 'wb-fixed', title: '常驻', content: '住在海边', probability: 100 })]);
    return { template: sectionOf(deferred), rolls: (wb as any).collectDeferredWorldbookRolls(deferred) };
  };

  it('打包不调随机源，概率条目带上概率，概率 100 的不推迟', () => {
    const random = vi.spyOn(Math, 'random');
    const { template, rolls } = pack();
    expect(random).not.toHaveBeenCalled();
    expect(rolls).toEqual([{ id: 'wb-rain', probability: 35 }]);
    expect(template).toContain('下雨天会犯困');
  });

  it('同一个包连着到点两次，可控随机源能抽出不同结果；渲染与本地同格式', () => {
    const { template, rolls } = pack();
    const hit = (wb as any).renderWorldbookRolls(template, rolls, () => 0.1);
    const miss = (wb as any).renderWorldbookRolls(template, rolls, () => 0.9);
    expect(hit).not.toBe(miss);
    // 与本地「这一轮抽中 / 没抽中」直接渲染的结果逐字一致
    expect(hit).toBe(sectionOf([book({ useProbability: false }), book({ id: 'wb-fixed', title: '常驻', content: '住在海边', useProbability: false })]));
    expect(miss).toBe(sectionOf([book({ id: 'wb-fixed', title: '常驻', content: '住在海边', useProbability: false })]));
  });

  it('整段都没抽中时连标题一起消失（与本地没有条目时一样）', () => {
    const deferred = (wb as any).deferWorldbookRolls([book()]);
    const template = `前${sectionOf(deferred)}后`;
    expect((wb as any).renderWorldbookRolls(template, (wb as any).collectDeferredWorldbookRolls(deferred), () => 0.9)).toBe('前后');
  });

  it('本地与云端用同一个抽签函数：同一个随机值，两边结论一致', () => {
    const { template, rolls } = pack();
    for (const r of [0.2, 0.6]) {
      vi.spyOn(Math, 'random').mockReturnValue(r);
      const local = wb.isWorldbookEntryActive(book(), []);
      const cloud = (wb as any).renderWorldbookRolls(template, rolls).includes('下雨天会犯困');
      expect(cloud).toBe(local);
      vi.restoreAllMocks();
    }
  });
});

describe('不同分类交错、中间那条没抽中', () => {
  const a = book({ id: 'a', title: 'A', content: '甲', useProbability: false, category: '地点', order: 1 });
  const b = book({ id: 'b', title: 'B', content: '乙', category: '人物', order: 2 });
  const c = book({ id: 'c', title: 'C', content: '丙', useProbability: false, category: '地点', order: 3 });

  it('前后两个同名分类标题合并成一个，与本地逐字一致', () => {
    const deferred = (wb as any).deferWorldbookRolls([a, b, c]);
    const rolls = (wb as any).collectDeferredWorldbookRolls(deferred);
    const template = sectionOf(deferred);
    expect((wb as any).renderWorldbookRolls(template, rolls, () => 0.9)).toBe(sectionOf([a, c]));
    expect((wb as any).renderWorldbookRolls(template, rolls, () => 0.1)).toBe(sectionOf([a, { ...b, useProbability: false }, c]));
  });
});
