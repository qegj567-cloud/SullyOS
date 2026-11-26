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

// 回归守卫：只在部分主动消息类型生效的条目（scenes），云端一份包到点按类型去掉，
// 结果与本地已知类型直接挑条目渲染逐字一致。
describe('按主动消息类型生效的条目', () => {
  const a = book({ id: 'a', title: 'A', content: '甲', useProbability: false, category: '地点', order: 1 });
  const b = book({ id: 'b', title: 'B', content: '乙', useProbability: false, category: '人物', order: 2, scenes: ['proactive.away'] });
  const c = book({ id: 'c', title: 'C', content: '丙', useProbability: false, category: '地点', order: 3 });
  const pack = (books: any[]) => {
    const deferred = (wb as any).deferWorldbookRolls(books);
    return { template: sectionOf(deferred), rolls: (wb as any).collectDeferredWorldbookRolls(deferred) };
  };
  const localOf = (books: any[], kind: string) => sectionOf((wb as any).filterWorldbooksForProactive(books, kind));

  it('打包带上生效类型，概率按 100；四类全开的条目不推迟', () => {
    expect(pack([a, b, c]).rolls).toEqual([{ id: 'b', probability: 100, proactiveKinds: ['away'] }]);
  });

  it('中间那条被类型去掉时，前后同名分类标题合并，与本地逐字一致', () => {
    const { template, rolls } = pack([a, b, c]);
    for (const kind of ['away', 'dateLeave', 'scheduled', 'self']) {
      expect((wb as any).renderWorldbookRolls(template, rolls, undefined, kind)).toBe(localOf([a, b, c], kind));
    }
    expect((wb as any).renderWorldbookRolls(template, rolls, undefined, 'dateLeave')).toBe(sectionOf([a, c]));
  });

  it('不是这一类的条目不耗随机数；是这一类的照常按概率抽', () => {
    const p = book({ id: 'p', scenes: ['proactive.away'] });
    const { template, rolls } = pack([p]);
    expect(rolls).toEqual([{ id: 'p', probability: 35, proactiveKinds: ['away'] }]);
    const random = vi.fn(() => 0.1);
    expect((wb as any).renderWorldbookRolls(template, rolls, random, 'scheduled')).toBe('');
    expect(random).not.toHaveBeenCalled();
    expect((wb as any).renderWorldbookRolls(template, rolls, () => 0.1, 'away')).toContain('下雨天会犯困');
    expect((wb as any).renderWorldbookRolls(template, rolls, () => 0.9, 'away')).toBe('');
  });

  it('不传类型（旧 Worker / 救援导回）时按四类都生效处理', () => {
    const { template, rolls } = pack([a, b, c]);
    expect((wb as any).renderWorldbookRolls(template, rolls)).toBe(sectionOf([a, b, c]));
  });

  it('概率 0 的限定类型条目不推迟，打包时照常排除、不把正文带上云', () => {
    const zero = book({ id: 'z', probability: 0, scenes: ['proactive.away'] });
    const { template, rolls } = pack([a, zero]);
    expect(rolls).toEqual([]);
    expect(template).not.toContain('下雨天会犯困');
  });

  it('四类主动消息都不生效的条目打包前就去掉', () => {
    const off = book({ id: 'off', scenes: ['chat.private'] });
    expect((wb as any).filterWorldbooksForProactive([a, off, b])).toEqual([a, b]);
    expect((wb as any).filterWorldbooksForProactive([a, off, b], 'scheduled')).toEqual([a]);
  });
});
