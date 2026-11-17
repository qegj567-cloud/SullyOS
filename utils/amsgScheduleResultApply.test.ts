/** 角色在云端改了日程、客户端落库后重打快照：实时配置必须一起带上，否则模板里搜索/翻日记/小红书能力整段消失。 */
import { expect, it, vi } from 'vitest';

const markDirty = vi.fn();
vi.mock('./amsgStateSync', () => ({ markAmsgStateDirty: (...args: unknown[]) => markDirty(...args) }));
vi.mock('./amsgScheduleResult', () => ({
  parseScheduleChangeResult: () => ({ charId: 'sched-char', directives: [], spokenAt: new Date().toISOString() }),
}));
vi.mock('./scheduleChange', () => ({
  applyScheduleChangeDirectives: async () => ({ changes: [{ kind: 'edit' }], schedule: { slots: [] } }),
  announceScheduleChanges: () => {},
}));
vi.mock('./db', () => ({
  DB: {
    getAllCharacters: async () => [{ id: 'sched-char', name: '角色' }],
    getUserProfile: async () => ({ name: '小明' }),
    getGroups: async () => [],
  },
}));

import { applyScheduleChangeResult } from './amsgScheduleResultApply';

it('重打快照时带上本机的实时配置', async () => {
  localStorage.setItem('os_realtime_config', JSON.stringify({ weatherEnabled: true, newsEnabled: true }));
  await applyScheduleChangeResult({});
  expect(markDirty).toHaveBeenCalledTimes(1);
  expect(markDirty.mock.calls[0][0].realtimeConfig).toEqual({ weatherEnabled: true, newsEnabled: true });
});
