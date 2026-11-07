import { describe, expect, it } from 'vitest';
import type { CharacterProfile, Message } from '../types';
import { buildLocalAwayHint } from './awayMessagePrompt';

const MIN = 60_000;
const NOW = Date.parse('2026-11-07T12:00:00Z');
const char = { id: 'away', name: '阿一', customTimezoneEnabled: true, customTimezone: 'Asia/Tokyo' } as CharacterProfile;
const lastUserAt = NOW - 240 * MIN;
const slots = [NOW - 150 * MIN, NOW - 60 * MIN];
const hint = (recent: Partial<Message>[] = [], overrides: Partial<CharacterProfile> = {}) =>
  buildLocalAwayHint({ ...char, ...overrides }, '小明', lastUserAt, slots, recent as Message[], NOW);

it('restores casual life sharing without making every segment a demand for a reply', () => {
  const text = hint();
  expect(text).toContain('拿起手机主动找对方');
  expect(text).toContain('分享随手拍的照片');
  expect(text).toContain('刚看到的趣事');
  expect(text).toContain('不要刻意汇报近况');
  expect(text).toContain('不必次次围着“没回复”打转');
  expect(text).toContain('请把这 2 次按时间先后分别写出来');
  expect(text).toContain('[[NEXT]]');
});

describe('recent offline meeting', () => {
  it('uses the after-meeting mood and ignores a later legacy hidden hint without copying archived prose', () => {
    const text = hint([
      { role: 'assistant', timestamp: NOW - 30 * MIN, content: '不可重新送入的归档原文', metadata: { source: 'date' } },
      { role: 'user', timestamp: NOW - MIN, metadata: { proactiveHint: true } },
    ]);
    expect(text).toContain('刚刚在线下见过面，现在暂时分开了');
    expect(text).toContain('补一句当时没说出口的话');
    expect(text).toContain('不要表现得像很久没联系');
    expect(text).toContain('如果具体细节已不在可见上下文里，不要编造');
    expect(text).not.toContain('不可重新送入的归档原文');
    expect(text).not.toContain('之后一直没再找你');
  });

  it.each([180, 181, -1])('does not call a meeting %s minutes ago just finished', minutes => {
    expect(hint([{ role: 'assistant', timestamp: NOW - minutes * MIN, metadata: { source: 'date' } }]))
      .not.toContain('刚刚在线下见过面');
  });

  it('uses ordinary sharing after the conversation has already moved on', () => {
    expect(hint([
      { role: 'assistant', timestamp: NOW - 30 * MIN, metadata: { source: 'date' } },
      { role: 'user', timestamp: NOW - 20 * MIN },
    ])).not.toContain('刚刚在线下见过面');
  });
});

it('formats target moments in the character timezone and omits clocks when time awareness is off', () => {
  expect(hint()).toContain('17:00');
  expect(hint()).toContain('18:30');
  expect(hint()).toContain('20:00');
  expect(hint([], { timeAwarenessEnabled: false })).not.toMatch(/\d{1,2}:\d{2}/);
  expect(hint([{ role: 'assistant', timestamp: NOW - MIN, metadata: { source: 'date' } }], { timeAwarenessEnabled: false }))
    .toContain('刚刚在线下见过面');
});

it('does not request a separator for a single message occasion', () => {
  expect(buildLocalAwayHint(char, '小明', lastUserAt, [slots[0]], [], NOW)).not.toContain('[[NEXT]]');
});
