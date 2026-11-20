import { expect, it, vi } from 'vitest';
import { guardAmsgRedeployment, redeployMarkerBinding, REDEPLOY_STOP_WORKER, REDEPLOY_DRAIN_SECONDS, type RedeploySettings } from './amsgRedeployGuard';
import type { AmsgReplacementPlan } from './cfProvision';

const plan: AmsgReplacementPlan = { operationId: 'fixture-op', credentialId: 'fixture-credentials', accountId: 'account', scriptName: 'script', databaseId: 'new-db', databaseName: 'new-db', secrets: {} as AmsgReplacementPlan['secrets'] };
function fixture() {
  let serverNow = 1000, stoppedAt: number | undefined;
  let settings: RedeploySettings = { bindings: [{ name: 'AMSG_MASTER_KEY' }] };
  const calls: string[] = [];
  const stop = vi.fn(async () => { settings = { bindings: [{ type: 'd1', name: 'DB', id: 'new-db' }, redeployMarkerBinding(plan, 'draining')] }; return { ok: true }; });
  const api = vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    calls.push(path);
    if (path.endsWith('/settings')) return { ok: true, body: { result: settings } };
    if (path.endsWith('/schedules')) return { ok: true, body: { result: { schedules: [] } } };
    expect(path).toBe('/accounts/account/d1/database/new-db/query');
    const sql = JSON.parse(init!.body!).sql as string;
    if (sql.startsWith('INSERT') && (stoppedAt === undefined || sql.includes('DO UPDATE'))) stoppedAt = serverNow;
    return { ok: true, body: { result: [{ success: true, results: sql.startsWith('SELECT') ? [{ remaining: Math.max(0, stoppedAt! + REDEPLOY_DRAIN_SECONDS - serverNow) }] : [] }] } };
  });
  return { stop, api, calls, advance(seconds: number) { serverNow += seconds; },
    run: () => guardAmsgRedeployment({ plan, settings, stop, api }) };
}
it('stops before waiting, persists the server deadline across retries, and only then permits activation', async () => {
  const f = fixture();
  expect(await f.run()).toEqual({ ready: false, remainingSeconds: REDEPLOY_DRAIN_SECONDS });
  f.advance(REDEPLOY_DRAIN_SECONDS - 1);
  expect(await f.run()).toEqual({ ready: false, remainingSeconds: 1 });
  f.advance(1);
  expect(await f.run()).toEqual({ ready: true });
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.calls.every(path => !path.includes('old-db'))).toBe(true);
});
it('cannot proceed when the stopped deployment or cron state cannot be verified', async () => {
  const f = fixture();
  f.api.mockResolvedValueOnce({ ok: false, body: undefined } as any);
  await expect(f.run()).rejects.toThrow('无法确认');
  const other = fixture();
  const original = other.api.getMockImplementation()!;
  other.api.mockImplementation((path, init) => path.endsWith('/schedules') && !init ? Promise.resolve({ ok: true, body: { result: { schedules: [{ cron: '* * * * *' }] } } }) as any : original(path, init));
  await expect(other.run()).rejects.toThrow('定时触发');
});
it('does not treat SQL failure or a missing deadline as a completed drain', async () => {
  for (const result of [[{ success: false, results: [] }], [{ success: true, results: [] }]]) {
    const f = fixture(), original = f.api.getMockImplementation()!;
    f.api.mockImplementation((path, init) => path.endsWith('/query') ? Promise.resolve({ ok: true, body: { result } }) as any : original(path, init));
    await expect(f.run()).rejects.toThrow();
  }
});
it('a changed binding cannot pass the already-activated retry path', async () => {
  await expect(guardAmsgRedeployment({ plan, settings: { bindings: [redeployMarkerBinding(plan, 'active'), { type: 'd1', name: 'DB', id: 'another-db' }] }, api: vi.fn(), stop: vi.fn() })).rejects.toThrow('数据库绑定');
});
it('the maintenance Worker cannot generate messages, register new work or forward old alarms', async () => {
  const code = REDEPLOY_STOP_WORKER.replace("import { DurableObject } from 'cloudflare:workers';", '').replace('export class', 'class').replace('export default', 'const handler =');
  const storage = { deleteAlarm: vi.fn() };
  const module = new Function('DurableObject', `${code}; return { ...handler, InstantTickDO };`)(class { ctx = { storage }; });
  expect((await module.fetch()).status).toBe(503);
  expect(await module.scheduled()).toBeUndefined();
  const alarm = new module.InstantTickDO();
  await alarm.kick('old-task'); await alarm.alarm();
  expect(storage.deleteAlarm).toHaveBeenCalledOnce();
});
