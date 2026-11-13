import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ upsertExpiredNotices: vi.fn(async () => []) }));
const db = vi.hoisted(() => ({
  getAllCharacters: vi.fn(async () => [] as unknown[]),
  appendApiCallLog: vi.fn(async () => {}),
}));
vi.mock('./activeMsgStore', () => ({ ActiveMsgStore: store }));
vi.mock('./db', () => ({ DB: db }));

import {
  FIRE_SKIP_RESULT_KIND, buildFireSkipResult, parseFireSkipResult, shouldReportFireSkip,
} from './amsgFireSkipResult';
import { applyFireSkipResult } from './amsgFireSkipResultApply';
import { readResultKind } from './amsgResults';

const base = { charId: 'char-1', taskUuid: 'task-1', occurrenceMs: 1_000, reason: 'declined' as const };

describe('「这次没发」结果的形状', () => {
  it('组出来的结果读得回去，任务概要原样带着', () => {
    const result = buildFireSkipResult({
      ...base, task: { mode: 'prompted', promptHint: '叫他起床', recurrenceType: 'daily' },
    });
    expect(readResultKind(result)).toBe(FIRE_SKIP_RESULT_KIND);
    expect(parseFireSkipResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it('形状对不上 → null：缺任务、缺时刻、不认识的原因', () => {
    const good = buildFireSkipResult(base);
    expect(parseFireSkipResult({ ...good, taskUuid: '' })).toBeNull();
    expect(parseFireSkipResult({ ...good, occurrenceMs: 'soon' })).toBeNull();
    expect(parseFireSkipResult({ ...good, reason: 'because' })).toBeNull();
    expect(parseFireSkipResult({ ...good, v: 2 })).toBeNull();
  });

  it('用户自己关掉的那类不上报，其余都上报', () => {
    expect(shouldReportFireSkip('schedule-off')).toBe(false);
    expect(shouldReportFireSkip('declined')).toBe(true);
    expect(shouldReportFireSkip('daily-limit')).toBe(true);
    expect(shouldReportFireSkip('stale')).toBe(true);
  });
});

describe('客户端消化「这次没发」', () => {
  beforeEach(() => {
    store.upsertExpiredNotices.mockClear();
    db.getAllCharacters.mockReset();
    db.getAllCharacters.mockResolvedValue([]);
    db.appendApiCallLog.mockClear();
  });

  const written = () => (store.upsertExpiredNotices.mock.calls[0] as unknown as [string, any[]]);

  it('一次性任务：按任务记一条回执，带上原因和要说的事', async () => {
    const payload = buildFireSkipResult({ ...base, task: { mode: 'prompted', promptHint: '叫他起床', recurrenceType: 'none' } });
    await expect(applyFireSkipResult(payload)).resolves.toBe(true);
    const [charId, records] = written();
    expect(charId).toBe('char-1');
    expect(records).toEqual([expect.objectContaining({
      id: 'task-1', charId: 'char-1', occurrenceMs: 1_000, kind: 'expired',
      reason: 'declined', mode: 'prompted', promptHint: '叫他起床', recurrenceType: 'none',
    })]);
  });

  it('循环任务：每次触发各记各的', async () => {
    const payload = buildFireSkipResult({ ...base, task: { mode: 'auto', recurrenceType: 'daily' } });
    await applyFireSkipResult(payload);
    expect(written()[1][0].id).toBe('task-1:1000');
  });

  it('云端没带任务概要 → 查本地清单补上', async () => {
    db.getAllCharacters.mockResolvedValue([{
      id: 'char-1',
      activeMsg2Config: { tasks: [{ taskUuid: 'task-1', mode: 'prompted', promptHint: '问问考试结果', recurrenceType: 'weekly' }] },
    }]);
    await expect(applyFireSkipResult(buildFireSkipResult({ ...base, reason: 'stale' }))).resolves.toBe(true);
    expect(written()[1][0]).toMatchObject({
      id: 'task-1:1000', reason: 'stale', promptHint: '问问考试结果', recurrenceType: 'weekly',
    });
  });

  it('没处落的都销账、不记回执：角色不在了、本地没有这条任务、形状坏了', async () => {
    await expect(applyFireSkipResult(buildFireSkipResult(base))).resolves.toBe(true);
    db.getAllCharacters.mockResolvedValue([{ id: 'char-1', activeMsg2Config: { tasks: [] } }]);
    await expect(applyFireSkipResult(buildFireSkipResult(base))).resolves.toBe(true);
    await expect(applyFireSkipResult({ resultKind: FIRE_SKIP_RESULT_KIND })).resolves.toBe(true);
    expect(store.upsertExpiredNotices).not.toHaveBeenCalled();
  });

  it('带回模型用量时把「未发送但已消耗额度」的云端主动轮次写进 API 调用记录', async () => {
    db.getAllCharacters.mockResolvedValue([{
      id: 'char-1',
      name: 'Sully',
      dialogueApi: { baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-x', model: 'gpt-5' },
      activeMsg2Config: { tasks: [{ taskUuid: 'task-1', mode: 'auto', recurrenceType: 'none' }] },
    }]);
    const payload = buildFireSkipResult({
      ...base,
      usage: { promptTokens: 2100, completionTokens: 45 },
      proactiveKind: 'self',
      task: { mode: 'auto', recurrenceType: 'none' },
    });
    await expect(applyFireSkipResult(payload)).resolves.toBe(true);
    await vi.waitFor(() => expect(db.appendApiCallLog).toHaveBeenCalledTimes(1));
    expect((db.appendApiCallLog.mock.calls[0] as any)[0]).toMatchObject({
      id: 'cloud-proactive-skip-task-1:1000',
      route: 'cloud-proactive',
      pending: false,
      ok: true,
      baseUrl: 'https://relay.example.com/v1',
      model: 'gpt-5',
      promptTokens: 2100,
      completionTokens: 45,
      totalTokens: 2145,
      appName: '消息',
      charId: 'char-1',
      charName: 'Sully',
      purpose: '角色自排提醒（未发送）',
    });
  });
});
