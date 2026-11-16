import type { AmsgReplacementPlan } from './cfProvision';

export const REDEPLOY_MARKER = 'SULLY_AMSG_REDEPLOY';
// Cron changes may propagate for 15 min; a last old invocation may run for
// another 15 min. The extra minute covers ordinary deployment propagation.
// https://developers.cloudflare.com/workers/configuration/cron-triggers/
// https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
export const REDEPLOY_DRAIN_SECONDS = 31 * 60;
export interface RedeployMarker {
  version: 1; operationId: string; credentialId: string; accountId: string; scriptName: string;
  databaseId: string; databaseName: string; phase: 'draining' | 'active';
}
export interface RedeploySettings { bindings?: Array<{ name: string; type?: string; id?: string; text?: string }> }
interface Reply { ok: boolean; body?: any; error?: string }
type Api = (path: string, init?: { method?: string; body?: string; contentType?: string }) => Promise<Reply>;

/** No model calls, forwarding, database reads or auto-updates in this temporary
 * Worker. The same DO class remains exported so existing alarms become no-ops. */
export const REDEPLOY_STOP_WORKER = `import { DurableObject } from 'cloudflare:workers';
export class InstantTickDO extends DurableObject {
  async kick() {}
  async alarm() { await this.ctx.storage.deleteAlarm(); }
}
export default {
  async fetch() { return Response.json({ ok: false, code: 'AMSG_REDEPLOY_PAUSED', message: '后台正在重新配置，请在连接与迁移中继续。' }, { status: 503, headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } }); },
  async scheduled() {}
};`;

export function readRedeployMarker(settings: RedeploySettings): RedeployMarker | null {
  const raw = settings.bindings?.find(binding => binding.name === REDEPLOY_MARKER)?.text;
  if (!raw) return null;
  try {
    const marker = JSON.parse(raw) as RedeployMarker;
    if (marker.version !== 1 || !['draining', 'active'].includes(marker.phase)
      || !/^[a-zA-Z0-9-]{1,80}$/.test(marker.operationId)
      || !/^[a-zA-Z0-9-]{1,80}$/.test(marker.credentialId)
      || !marker.accountId || !marker.scriptName || !marker.databaseId || !marker.databaseName) return null;
    return marker;
  } catch { return null; }
}

export function redeployMarkerBinding(plan: AmsgReplacementPlan, phase: RedeployMarker['phase']) {
  const marker: RedeployMarker = { version: 1, operationId: plan.operationId, credentialId: plan.credentialId, accountId: plan.accountId,
    scriptName: plan.scriptName, databaseId: plan.databaseId!, databaseName: plan.databaseName, phase };
  return { type: 'plain_text', name: REDEPLOY_MARKER, text: JSON.stringify(marker) };
}

export async function guardAmsgRedeployment(input: {
  plan: AmsgReplacementPlan; settings: RedeploySettings; api: Api;
  stop: () => Promise<Reply>;
}): Promise<{ ready: true } | { ready: false; remainingSeconds: number }> {
  const { plan, api } = input;
  const base = `/accounts/${plan.accountId}/workers/scripts/${encodeURIComponent(plan.scriptName)}`;
  const matches = (marker: RedeployMarker | null) => marker?.operationId === plan.operationId
    && marker.accountId === plan.accountId && marker.scriptName === plan.scriptName && marker.databaseId === plan.databaseId;
  const marker = readRedeployMarker(input.settings);
  // A lost response after activation must not pause the new backend again.
  if (matches(marker) && marker?.phase === 'active') {
    if (marker.credentialId !== plan.credentialId) throw new Error('后台已在其他设备完成重配，不能用旧恢复计划覆盖新密钥。');
    if (!input.settings.bindings?.some(binding => binding.type === 'd1' && binding.id === plan.databaseId)) throw new Error('数据库绑定已被其他操作修改，不能沿用这次重配。');
    return { ready: true };
  }
  const alreadyStopped = matches(marker) && marker?.phase === 'draining';
  if (!alreadyStopped) {
    const stopped = await input.stop();
    if (!stopped.ok) throw new Error(`未能确认旧后台已暂停，本次不会启用新后台。请重试。${stopped.error || ''}`);
  }
  const current = await api(`${base}/settings`);
  const settings = current.body?.result as RedeploySettings | undefined;
  const currentMarker = settings && readRedeployMarker(settings);
  if (!current.ok || !matches(currentMarker || null) || currentMarker?.phase !== 'draining'
    || !settings?.bindings?.some(binding => binding.type === 'd1' && binding.id === plan.databaseId)) {
    throw new Error('无法确认后台的停止状态，可能有其他部署正在修改它。尚未启用新后台，请重新查找后继续。');
  }
  const paused = await api(`${base}/schedules`, { method: 'PUT', body: '[]', contentType: 'application/json' });
  if (!paused.ok) throw new Error(`后台已进入维护状态，但定时触发尚未确认停用。请重试。${paused.error || ''}`);
  const read = await api(`${base}/schedules`);
  const schedules = read.body?.result?.schedules ?? read.body?.result;
  if (!read.ok || !Array.isArray(schedules) || schedules.length !== 0) throw new Error('未能确认定时触发已停用，不能继续启用新后台。请重试。');
  // Only the newly created database is queried. Its server clock survives page
  // closure and device clock changes; old/shared databases remain untouched.
  const query = async (sql: string) => {
    const reply = await api(`/accounts/${plan.accountId}/d1/database/${plan.databaseId}/query`, {
      method: 'POST', body: JSON.stringify({ sql }), contentType: 'application/json',
    });
    const result = reply.body?.result;
    if (!reply.ok || !Array.isArray(result) || result.length !== 1 || result[0]?.success === false || !Array.isArray(result[0]?.results)) {
      throw new Error(`后台保持暂停，无法读取重配进度。请重试。${reply.error || ''}`);
    }
    return result[0].results;
  };
  await query('CREATE TABLE IF NOT EXISTS sully_redeploy_guard (operation_id TEXT PRIMARY KEY, stopped_at INTEGER NOT NULL)');
  // operationId is generated locally or strictly validated by readRedeployMarker.
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(plan.operationId)) throw new Error('无效的重配操作编号。');
  await query(`INSERT INTO sully_redeploy_guard (operation_id, stopped_at) VALUES ('${plan.operationId}', CAST(strftime('%s','now') AS INTEGER)) ON CONFLICT(operation_id) DO ${alreadyStopped ? 'NOTHING' : "UPDATE SET stopped_at = CAST(strftime('%s','now') AS INTEGER)"}`);
  const rows = await query(`SELECT MAX(0, stopped_at + ${REDEPLOY_DRAIN_SECONDS} - CAST(strftime('%s','now') AS INTEGER)) AS remaining FROM sully_redeploy_guard WHERE operation_id = '${plan.operationId}'`);
  const remaining = rows[0]?.remaining;
  if (rows.length !== 1 || !Number.isFinite(remaining) || remaining < 0 || remaining > REDEPLOY_DRAIN_SECONDS) throw new Error('无法确认旧任务已结束，后台保持暂停。请稍后重试。');
  return remaining > 0 ? { ready: false, remainingSeconds: remaining } : { ready: true };
}
