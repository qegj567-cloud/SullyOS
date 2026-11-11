// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CharacterProfile } from '../types';
import { DB } from './db';
import { ActiveMsgClient } from './activeMsgClient';
import { isAwayCloudRoute, runLocalProactiveTurn } from './awayMessage';
import {
  armDateLeaveReminder, disarmDateLeaveReminder, resolveDateLeaveDelayMinutes, startLocalDateLeaveTimer,
} from './dateLeaveReminder';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: { scheduleCharacterTask: vi.fn(), updatePendingTasksRemote: vi.fn(), cancelTask: vi.fn() },
}));
vi.mock('./awayMessage', () => ({ isAwayCloudRoute: vi.fn(), runLocalProactiveTurn: vi.fn() }));

const NOW = Date.parse('2026-11-11T12:00:00Z');
let serial = 0;
let char: CharacterProfile;
let updateCharacter: ReturnType<typeof vi.fn>;
const deps = () => ({
  char, updateCharacter, apiConfig: {} as any, userProfile: { name: '小明' } as any, groups: [], realtimeConfig: {} as any,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  char = {
    id: `date-leave-${serial++}`, name: '阿一', dateLeaveReminder: { enabled: true, delayMinutes: 5 },
    activeMsg2Config: { enabled: true, tasks: [] },
  } as unknown as CharacterProfile;
  updateCharacter = vi.fn();
  vi.mocked(ActiveMsgClient.scheduleCharacterTask).mockResolvedValue({ uuid: 'u-new', clientTaskId: 'c-new', firstSendAt: 'x' } as any);
  vi.mocked(ActiveMsgClient.updatePendingTasksRemote).mockResolvedValue({ updated: 0, failed: [] } as any);
  vi.mocked(ActiveMsgClient.cancelTask).mockResolvedValue(undefined as any);
  vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([]);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const flush = async () => { await vi.runOnlyPendingTimersAsync(); await Promise.resolve(); };

it('等待时长限定在 1 到 60 分钟，缺省 5 分钟', () => {
  expect(resolveDateLeaveDelayMinutes({})).toBe(5);
  expect(resolveDateLeaveDelayMinutes({ dateLeaveReminder: { enabled: true, delayMinutes: 0 } })).toBe(1);
  expect(resolveDateLeaveDelayMinutes({ dateLeaveReminder: { enabled: true, delayMinutes: 999 } })).toBe(60);
});

it('开着 2.0：进入见面对话时建一条到点必发的云端任务，不占名额、带等待时长', async () => {
  vi.mocked(isAwayCloudRoute).mockResolvedValue(true);
  await armDateLeaveReminder(deps());
  const call = vi.mocked(ActiveMsgClient.scheduleCharacterTask).mock.calls[0][0];
  expect(call.task).toMatchObject({ expirePolicy: 'force', recurrenceType: 'none', dateLeave: { delayMinutes: 5 } });
  expect(Date.parse(call.task.firstSendTime)).toBe(NOW + 5 * 60_000);
  const update = updateCharacter.mock.calls[0][1](char);
  expect(update.activeMsg2Config.tasks).toEqual([expect.objectContaining({ taskUuid: 'u-new', dateLeave: true })]);
});

it('已经备好的：回到对话时原地改期，不重复新建；远端没了才新建', async () => {
  vi.mocked(isAwayCloudRoute).mockResolvedValue(true);
  char.activeMsg2Config!.tasks = [{ taskUuid: 'u-old', dateLeave: true } as any];
  vi.mocked(ActiveMsgClient.updatePendingTasksRemote).mockResolvedValueOnce({ updated: 1, failed: [] } as any);
  await armDateLeaveReminder(deps());
  expect(ActiveMsgClient.updatePendingTasksRemote).toHaveBeenCalledWith(['u-old'], { nextSendAt: new Date(NOW + 5 * 60_000).toISOString() });
  expect(ActiveMsgClient.scheduleCharacterTask).not.toHaveBeenCalled();

  await armDateLeaveReminder(deps());
  expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenCalledOnce();
});

it('主动结束：取消刚建好、角色记录里还没有的那条', async () => {
  vi.mocked(isAwayCloudRoute).mockResolvedValue(true);
  void armDateLeaveReminder(deps());
  await disarmDateLeaveReminder({ char, updateCharacter });
  expect(ActiveMsgClient.cancelTask).toHaveBeenCalledWith('u-new');
});

it('没有待发的提醒时撤掉不发请求', async () => {
  await disarmDateLeaveReminder({ char, updateCharacter });
  expect(ActiveMsgClient.cancelTask).not.toHaveBeenCalled();
});

it('关着这项：什么都不做', async () => {
  char.dateLeaveReminder = { enabled: false };
  vi.mocked(isAwayCloudRoute).mockResolvedValue(true);
  await armDateLeaveReminder(deps());
  await startLocalDateLeaveTimer(deps(), NOW);
  expect(ActiveMsgClient.scheduleCharacterTask).not.toHaveBeenCalled();
  expect(isAwayCloudRoute).not.toHaveBeenCalled();
});

it('没开 2.0：在 SullyOS 里走开 5 分钟后本地生成一条', async () => {
  vi.mocked(isAwayCloudRoute).mockResolvedValue(false);
  await startLocalDateLeaveTimer(deps(), NOW);
  await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
  expect(runLocalProactiveTurn).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await flush();
  expect(runLocalProactiveTurn).toHaveBeenCalledOnce();
  expect(vi.mocked(runLocalProactiveTurn).mock.calls[0][1]).toMatchObject({ purpose: '见面离开提醒', meta: { dateLeaveReminder: true } });
});

it('没开 2.0：页面隐藏后不再计时，回来也不补', async () => {
  vi.mocked(isAwayCloudRoute).mockResolvedValue(false);
  await startLocalDateLeaveTimer(deps(), NOW);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  await flush();
  expect(runLocalProactiveTurn).not.toHaveBeenCalled();
});

it('没开 2.0：回到见面就撤掉计时', async () => {
  vi.mocked(isAwayCloudRoute).mockResolvedValue(false);
  await startLocalDateLeaveTimer(deps(), NOW);
  await armDateLeaveReminder(deps());
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  await flush();
  expect(runLocalProactiveTurn).not.toHaveBeenCalled();
});

it('开着 2.0：在 SullyOS 里走开时不开本地计时（云端那条已经备好）', async () => {
  vi.mocked(isAwayCloudRoute).mockResolvedValue(true);
  await startLocalDateLeaveTimer(deps(), NOW);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  await flush();
  expect(runLocalProactiveTurn).not.toHaveBeenCalled();
});
