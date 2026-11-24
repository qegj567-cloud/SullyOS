// 回归守卫：功能总览「能力 · 勾叉」表的判定。
//   1. 总开关关掉时所有行都是红叉，不能有绿勾残留（用户会以为还在发）。
//   2. 没开的能力是灰色「没开」，不能因为 Worker 连不上就变红（会误以为自己开过）。
//   3. 开着的能力在 Worker 连不上 / 通知没登记 / 定时暂停时变红，并写出原因。
//   4. 日程 / 人格模拟 / 梦境的云端生成：不靠定时触发；只有开了「完成时通知」才看推送；
//      Worker 不认识代跑时标红（交不上去），这条比通知没开优先。
import { describe, expect, it } from 'vitest';
import { buildAmsgCapabilityRows, type AmsgCapabilityInput } from './amsgCapabilities';

const healthy: AmsgCapabilityInput = {
  enabled: true, worker: 'ok', push: 'ok', cronPaused: false, instantOn: true, instantBlocked: '',
  cloudGenOn: ['schedule', 'persona-sim', 'dream'], cloudGenNotify: true, cloudGenSupport: 'supported',
  scheduleChars: 2, awayChars: 1, dateChars: 1, mcpServers: 1,
};
const states = (input: AmsgCapabilityInput) => Object.fromEntries(buildAmsgCapabilityRows(input).map(row => [row.id, row.state]));

describe('buildAmsgCapabilityRows', () => {
  it('全部就绪时全是绿勾，角色级能力写出几位角色', () => {
    const rows = buildAmsgCapabilityRows(healthy);
    expect(rows.every(row => row.state === 'ok')).toBe(true);
    expect(rows.find(row => row.id === 'schedule')?.note).toBe('2 位角色已开');
  });

  it('总开关关掉时每一行都是红叉，即时对话说明聊天回到本机', () => {
    const rows = buildAmsgCapabilityRows({ ...healthy, enabled: false });
    expect(rows.every(row => row.state === 'bad' && row.cause === 'master')).toBe(true);
    expect(rows.find(row => row.id === 'instant')?.note).toBe('总开关已暂停 · 聊天在本机生成');
    expect(rows.find(row => row.id === 'cloudGen')?.note).toBe('总开关已暂停 · 在本机生成');
  });

  it('Worker 连不上：开着的能力变红，没开的保持灰色', () => {
    expect(states({ ...healthy, worker: 'unreachable', awayChars: 0, mcpServers: 0 })).toEqual({
      worker: 'bad', push: 'ok', schedule: 'bad', instant: 'bad', cloudGen: 'bad', away: 'off', date: 'bad', mcp: 'off',
    });
  });

  it('通知没登记：要推送的能力变红，MCP 不受影响', () => {
    expect(states({ ...healthy, push: 'none' })).toMatchObject({ push: 'off', schedule: 'bad', instant: 'bad', cloudGen: 'bad', away: 'bad', mcp: 'ok' });
  });

  it('暂停后台任务：靠云端任务到点投递的三项变红，即时对话和 MCP 照常', () => {
    const rows = buildAmsgCapabilityRows({ ...healthy, cronPaused: true });
    expect(rows.find(row => row.id === 'schedule')).toMatchObject({ state: 'bad', note: '后台任务已暂停', cause: 'cron' });
    expect(rows.filter(row => row.state === 'bad').map(row => row.id)).toEqual(['schedule', 'away', 'date']);
  });

  it('红叉带上原因，点行时按原因去对应的地方', () => {
    const rows = buildAmsgCapabilityRows({ ...healthy, worker: 'unreachable' });
    expect(rows.find(row => row.id === 'away')?.cause).toBe('worker');
    expect(buildAmsgCapabilityRows({ ...healthy, push: 'none' }).find(row => row.id === 'date')?.cause).toBe('push');
    expect(buildAmsgCapabilityRows(healthy).every(row => row.cause === undefined)).toBe(true);
  });

  it('即时对话：关着是灰色，开着被挡住时写出原因', () => {
    expect(states({ ...healthy, instantOn: false }).instant).toBe('off');
    expect(buildAmsgCapabilityRows({ ...healthy, instantBlocked: '后台版本太旧' }).find(row => row.id === 'instant'))
      .toMatchObject({ state: 'bad', note: '后台版本太旧' });
  });

  it('探测中的依赖不提前下结论', () => {
    expect(states({ ...healthy, worker: 'checking' })).toMatchObject({ worker: 'checking', schedule: 'checking', mcp: 'checking' });
  });

  it('改名后的私聊一行仍是 instant，云端生成那行排在它后面', () => {
    const rows = buildAmsgCapabilityRows(healthy);
    expect(rows.find(row => row.id === 'instant')?.label).toBe('私聊云端生成');
    expect(rows.map(row => row.id).slice(3, 5)).toEqual(['instant', 'cloudGen']);
    expect(rows.find(row => row.id === 'cloudGen')?.label).toBe('云端生成（日程 / 人格模拟 / 梦境）');
  });

  describe('云端生成（日程 / 人格模拟 / 梦境）', () => {
    const cloudGen = (input: Partial<AmsgCapabilityInput>) => buildAmsgCapabilityRows({ ...healthy, ...input }).find(row => row.id === 'cloudGen')!;

    it('三项都关是灰色；部分开写出开了哪几项，全开不写', () => {
      expect(cloudGen({ cloudGenOn: [] })).toMatchObject({ state: 'off', note: '都在本机生成' });
      expect(cloudGen({ cloudGenOn: ['dream', 'schedule'] })).toMatchObject({ state: 'ok', note: '已开：日程 / 梦境' });
      expect(cloudGen({}).note).toBe('');
    });

    it('不靠定时触发：暂停后台任务照常是绿勾', () => {
      expect(cloudGen({ cronPaused: true }).state).toBe('ok');
    });

    it('只有开了完成时通知才看推送；通知没开时写的是弹不出通知，不是送不到', () => {
      expect(cloudGen({ push: 'none', cloudGenNotify: false }).state).toBe('ok');
      expect(cloudGen({ push: 'checking', cloudGenNotify: false }).state).toBe('ok');
      expect(cloudGen({ push: 'none' })).toMatchObject({ state: 'bad', cause: 'push', note: '通知没开，完成时不会弹通知' });
    });

    it('Worker 不认识代跑时标红去后台维护，比通知没开优先', () => {
      expect(cloudGen({ cloudGenSupport: 'unsupported' })).toMatchObject({ state: 'bad', cause: 'worker', note: '后台版本还不支持，需要更新' });
      expect(cloudGen({ cloudGenSupport: 'unsupported', push: 'none' })).toMatchObject({ cause: 'worker' });
      expect(cloudGen({ cloudGenSupport: 'unknown' })).toMatchObject({ state: 'bad', cause: 'worker' });
      expect(cloudGen({ cloudGenSupport: 'checking' }).state).toBe('checking');
    });

    it('没开的不因为 Worker 不支持就变红', () => {
      expect(cloudGen({ cloudGenOn: [], cloudGenSupport: 'unsupported' }).state).toBe('off');
    });
  });
});
