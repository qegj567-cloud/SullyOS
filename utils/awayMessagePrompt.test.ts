import { describe, expect, it } from 'vitest';
import { buildAwayFireInstruction, isJustMetOffline, readAwayAnchorInfo } from './awayMessagePrompt';

const MIN = 60_000;
const NOW = Date.parse('2026-11-07T12:00:00Z');

// 云端离开后消息到点现算说法，与本地同一份逻辑（起点类型、刚分开语境、时间感知开关）。
describe('buildAwayFireInstruction', () => {
  const fire = (over: Partial<Parameters<typeof buildAwayFireInstruction>[0]> = {}) => buildAwayFireInstruction({
    userName: '小明', anchor: { source: null, lastDateAt: null }, anchorAt: NOW - 120 * MIN,
    nowMs: NOW, showClock: true, tzId: 'Asia/Tokyo', ...over,
  });

  it('按起点类型换说法：线上 / 见面 / 通话', () => {
    expect(fire()).toContain('小明最后一次在线上给你发消息是在 11月7日 19:00');
    expect(fire({ anchor: { source: 'date', lastDateAt: NOW - 240 * MIN } })).toContain('上一次在线下互动是在');
    expect(fire({ anchor: { source: 'call-end-popup', lastDateAt: null } })).toContain('上一次通话是在');
  });

  it('3 小时内见过面切到刚分开的语境，超过就回到日常分享', () => {
    expect(fire({ anchor: { source: 'date', lastDateAt: NOW - 30 * MIN } })).toContain('刚刚在线下见过面');
    expect(fire({ anchor: { source: 'date', lastDateAt: NOW - 181 * MIN } })).not.toContain('刚刚在线下见过面');
  });

  it('关掉时间感知时既不报钟也不报隔了多少分钟', () => {
    const text = fire({ showClock: false });
    expect(text).not.toMatch(/\d{1,2}:\d{2}/);
    expect(text).not.toMatch(/超过 \d+ 分钟/);
    expect(text).toContain('这段时间小明没有再在线上给你发消息');
  });

  it('见面恰好过去 180 分钟就不再算刚分开', () => {
    expect(fire({ anchor: { source: 'date', lastDateAt: NOW - 180 * MIN } })).not.toContain('刚刚在线下见过面');
    expect(fire({ anchor: { source: 'date', lastDateAt: NOW - 179 * MIN } })).toContain('刚刚在线下见过面');
  });

  it('见面时间戳在未来（设备时钟跑偏）时不算刚分开', () => {
    expect(isJustMetOffline({ source: 'date', lastDateAt: NOW + 5 * MIN }, NOW)).toBe(false);
    expect(fire({ anchor: { source: 'date', lastDateAt: NOW + 5 * MIN } })).not.toContain('刚刚在线下见过面');
  });
});

describe('readAwayAnchorInfo', () => {
  const m = (role: string, timestamp: number, metadata?: Record<string, unknown>) => ({ role, timestamp, metadata }) as any;

  it('起点取最后一次在场互动的来源；线上发言为 null', () => {
    expect(readAwayAnchorInfo([m('user', 1), m('assistant', 2)])).toEqual({ source: null, lastDateAt: null });
    expect(readAwayAnchorInfo([m('user', 1), m('assistant', 2, { source: 'call-end-popup' })]).source).toBe('call-end-popup');
  });

  it('最后一条真实记录是见面正文时带上它的时刻，之后角色又在线上说过话就不带', () => {
    expect(readAwayAnchorInfo([m('user', 1), m('assistant', 2, { source: 'date' })])).toEqual({ source: 'date', lastDateAt: 2 });
    expect(readAwayAnchorInfo([m('assistant', 2, { source: 'date' }), m('assistant', 3)]).lastDateAt).toBeNull();
  });

  it('隐藏提示 proactiveHint 和系统消息不算真实记录', () => {
    const info = readAwayAnchorInfo([
      m('assistant', 2, { source: 'date' }),
      m('user', 3, { proactiveHint: true }),
      m('system', 4),
    ]);
    expect(info).toEqual({ source: 'date', lastDateAt: 2 });
  });
});
