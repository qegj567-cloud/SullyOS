// 回归守卫：功能总览「能力 · 勾叉」表的判定。
//   1. 总开关关掉时所有行都是红叉，不能有绿勾残留（用户会以为还在发）。
//   2. 没开的能力是灰色「没开」，不能因为 Worker 连不上就变红（会误以为自己开过）。
//   3. 开着的能力在 Worker 连不上 / 通知没登记 / 定时暂停时变红，并写出原因。
import { describe, expect, it } from 'vitest';
import { buildAmsgCapabilityRows, type AmsgCapabilityInput } from './amsgCapabilities';

const healthy: AmsgCapabilityInput = {
  enabled: true, worker: 'ok', push: 'ok', cronPaused: false, instantOn: true, instantBlocked: '',
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
  });

  it('Worker 连不上：开着的能力变红，没开的保持灰色', () => {
    expect(states({ ...healthy, worker: 'unreachable', awayChars: 0, mcpServers: 0 })).toEqual({
      worker: 'bad', push: 'ok', schedule: 'bad', instant: 'bad', away: 'off', date: 'bad', mcp: 'off',
    });
  });

  it('通知没登记：要推送的能力变红，MCP 不受影响', () => {
    expect(states({ ...healthy, push: 'none' })).toMatchObject({ push: 'off', schedule: 'bad', instant: 'bad', away: 'bad', mcp: 'ok' });
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
});
