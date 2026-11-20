import { afterEach, expect, it, vi } from 'vitest';
import { createAmsgReplacementPlan, provisionAmsgBackend, waitForWorkerReady, type AmsgReplacementPlan } from './cfProvision';
import { REDEPLOY_MARKER } from './amsgRedeployGuard';
import { ActiveMsgStore } from './activeMsgStore';
vi.mock('./activeMsgStore', () => ({ ActiveMsgStore: { saveReplacementPlan: vi.fn().mockResolvedValue(undefined), getReplacementPlan: vi.fn().mockResolvedValue(null), getGlobalConfig: vi.fn().mockResolvedValue({}) } }));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const plan = (): AmsgReplacementPlan => ({
  operationId: 'fixture-operation',
  credentialId: 'fixture-credentials',
  accountId: 'selected-account', scriptName: 'selected-worker', databaseName: 'selected-worker-restart-fixture',
  secrets: { AMSG_MASTER_KEY: 'a'.repeat(64), AMSG_SERVER_TOKEN: 'new-server-key', VAPID_PUBLIC_KEY: 'new-public', VAPID_PRIVATE_KEY: 'new-private', VAPID_EMAIL: '' },
});
function mockCloud(options: { badBundle?: boolean; unrelated?: boolean; failUploadOnce?: boolean; failActiveUploadOnce?: boolean; failDatabase?: boolean; remaining?: number } = {}) {
  const calls: { path: string; method: string; metadata?: any }[] = [];
  let uploadFailed = false;
  let bindings: any[] = [{ name: 'AMSG_MASTER_KEY' }, { name: 'DB', type: 'd1', id: 'old-shared-db' }];
  let schedules: unknown[] = [{ cron: '* * * * *' }];
  let remaining = options.remaining ?? 0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('worker.bundle.js')) return new Response(options.badBundle ? 'broken' : 'src_default as default' + ' '.repeat(110000));
    if (url.includes('wrangler.toml')) return new Response('', { status: 404 });
    const path = new URL(url).searchParams.get('path');
    if (!path) return Response.json({ relay: 'cf-api' });
    const method = (init?.headers as Record<string, string>)?.['X-CF-Method'] || 'GET';
    const call: (typeof calls)[number] = { path, method }; calls.push(call);
    let result: unknown = {};
    if (path === '/user/tokens/verify') result = { status: 'active' };
    else if (path.endsWith('/workers/scripts')) result = [{ id: 'selected-worker' }];
    else if (path.endsWith('/settings')) result = { bindings: options.unrelated ? [] : bindings };
    else if (path.endsWith('/workers/subdomain')) result = { subdomain: 'owner' };
    else if (path.endsWith('/d1/database') && method === 'POST') {
      if (options.failDatabase) return Response.json({ success: false }, { status: 403 });
      result = { uuid: 'new-isolated-db' };
    } else if (path.endsWith('/workers/scripts/selected-worker') && method === 'PUT') {
      call.metadata = JSON.parse(await ((init?.body as FormData).get('metadata') as Blob).text());
      const phase = JSON.parse(call.metadata.bindings.find((b: any) => b.name === REDEPLOY_MARKER).text).phase;
      if ((options.failUploadOnce || (options.failActiveUploadOnce && phase === 'active')) && !uploadFailed) { uploadFailed = true; return Response.json({ success: false }, { status: 503 }); }
      bindings = call.metadata.bindings;
    } else if (path.endsWith('/schedules')) {
      if (method === 'PUT') schedules = JSON.parse(init?.body as string);
      result = { schedules };
    } else if (path === '/accounts/selected-account/d1/database/new-isolated-db/query') {
      result = [{ success: true, results: JSON.parse(init?.body as string).sql.startsWith('SELECT') ? [{ remaining }] : [] }];
    } else if (!path.endsWith('/subdomain')) throw new Error('Unexpected CF request: ' + path);
    return Response.json({ success: true, result });
  });
  vi.stubGlobal('fetch', fetcher);
  return { calls, fetcher, finishDrain() { remaining = 0; } };
}
const run = (replacement: AmsgReplacementPlan) => provisionAmsgBackend({ token: 'fixture-token', accountId: replacement.accountId, scriptName: replacement.scriptName, replacement });

it('ordinary deployment still refuses to overwrite an existing Worker', async () => {
  const { calls } = mockCloud();
  expect(await provisionAmsgBackend({ token: 'fixture-token', accountId: 'selected-account', scriptName: 'selected-worker' })).toMatchObject({ ok: false, code: 'SCRIPT_EXISTS' });
  expect(calls.every(call => call.method === 'GET')).toBe(true);
});
it('reuses the persisted recovery checkpoint when the page is opened again', async () => {
  const saved = plan();
  vi.mocked(ActiveMsgStore.getReplacementPlan).mockResolvedValueOnce(saved);
  const restored = await createAmsgReplacementPlan({ account: { id: 'selected-account', name: 'Fixture' }, scriptName: 'selected-worker', urls: [] });
  expect(restored).toBe(saved);
  expect(restored).not.toHaveProperty('token');
});
it('does not mistake a maintenance JSON response for the newly activated Worker', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ code: 'AMSG_REDEPLOY_PAUSED' }, { status: 503 }))
    .mockImplementation(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetcher);
  let settled = false;
  const ready = waitForWorkerReady('https://fixture.invalid', 5000).then(result => { settled = true; return result; });
  await vi.advanceTimersByTimeAsync(1000);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1500);
  expect(await ready).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('a replacement plan cannot be applied to another account or Worker', async () => {
  const { fetcher } = mockCloud();
  expect(await provisionAmsgBackend({ token: 'fixture-token', accountId: 'other', scriptName: 'selected-worker', replacement: plan() })).toMatchObject({ ok: false });
  expect(fetcher).not.toHaveBeenCalled();
});
it('revalidates the selected Worker before creating or replacing anything', async () => {
  const { calls } = mockCloud({ unrelated: true });
  expect(await run(plan())).toMatchObject({ ok: false });
  expect(calls.every(call => call.method === 'GET')).toBe(true);
});
it('creates a fresh database and keys without querying or clearing the old shared database', async () => {
  const replacement = plan(), { calls } = mockCloud();
  replacement.workerUrl = 'https://custom.example.test';
  expect(await run(replacement)).toMatchObject({ ok: true, workerUrl: 'https://custom.example.test', databaseId: 'new-isolated-db', secrets: replacement.secrets });
  const uploads = calls.filter(call => call.metadata);
  expect(uploads).toHaveLength(2);
  expect(uploads[0].metadata.code_update_strategy).toEqual({ mode: 'immediate' });
  expect(JSON.parse(uploads[0].metadata.bindings.find((b: any) => b.name === REDEPLOY_MARKER).text).phase).toBe('draining');
  const upload = uploads[1];
  expect(upload.path).toBe('/accounts/selected-account/workers/scripts/selected-worker');
  expect(upload.metadata.bindings).toContainEqual({ type: 'd1', name: 'DB', id: 'new-isolated-db' });
  expect(upload.metadata.bindings).toContainEqual({ type: 'secret_text', name: 'AMSG_SERVER_TOKEN', text: 'new-server-key' });
  expect(calls.filter(call => call.path.endsWith('/d1/database'))).toEqual([{ path: '/accounts/selected-account/d1/database', method: 'POST' }]);
  expect(JSON.stringify(calls)).not.toContain('old-shared-db');
});
it('retries with the same new database and secrets after an upload failure', async () => {
  const replacement = plan(), { calls } = mockCloud({ failUploadOnce: true });
  expect(await run(replacement)).toMatchObject({ ok: false, code: 'CF_ERROR' });
  expect(replacement.databaseId).toBe('new-isolated-db');
  expect(await run(replacement)).toMatchObject({ ok: true, databaseId: 'new-isolated-db' });
  expect(calls.filter(call => call.path.endsWith('/d1/database'))).toHaveLength(1);
  const uploads = calls.filter(call => call.metadata);
  expect(uploads[0].metadata.bindings).toEqual(uploads[1].metadata.bindings);
});
it('a bad bundle fails before database creation or Worker upload', async () => {
  const { calls } = mockCloud({ badBundle: true });
  expect(await run(plan())).toMatchObject({ ok: false, code: 'BUNDLE_INVALID' });
  expect(calls.every(call => call.method === 'GET')).toBe(true);
});
it('database creation failure leaves the Worker untouched', async () => {
  const replacement = plan(), { calls } = mockCloud({ failDatabase: true });
  expect(await run(replacement)).toMatchObject({ ok: false });
  expect(replacement.databaseId).toBeUndefined();
  expect(calls.some(call => call.method === 'PUT')).toBe(false);
});

it('waits with no new task runner, then resumes after a page/device loses its in-memory plan', async () => {
  const cloud = mockCloud({ remaining: 1860 });
  expect(await run(plan())).toMatchObject({ ok: false, code: 'REPLACEMENT_DRAINING', retryAfterSeconds: 1860 });
  expect(cloud.calls.filter(call => call.metadata)).toHaveLength(1);
  const resumed = { ...plan(), operationId: 'another-device-operation', credentialId: 'another-device-credentials', databaseName: 'unused-new-name' };
  expect(await run(resumed)).toMatchObject({ ok: false, code: 'REPLACEMENT_DRAINING' });
  expect(resumed.operationId).toBe('fixture-operation');
  expect(resumed.databaseId).toBe('new-isolated-db');
  expect(cloud.calls.filter(call => call.path.endsWith('/d1/database'))).toHaveLength(1);
  cloud.finishDrain();
  expect(await run(resumed)).toMatchObject({ ok: true });
  expect(cloud.calls.filter(call => call.metadata)).toHaveLength(2);
  // The first device must not restore its now-obsolete keys over this result.
  expect(await run(plan())).toMatchObject({ ok: false, code: 'REPLACEMENT_COMPLETED_ELSEWHERE' });
  expect(cloud.calls.filter(call => call.metadata)).toHaveLength(2);
});
it('checkpoint storage failure stops before changing the Worker or creating a database', async () => {
  const cloud = mockCloud();
  vi.mocked(ActiveMsgStore.saveReplacementPlan).mockRejectedValueOnce(new Error('disk full'));
  expect(await run(plan())).toMatchObject({ ok: false, message: expect.stringContaining('无法保存') });
  expect(cloud.calls.every(call => call.method === 'GET')).toBe(true);
});
it('failed activation keeps the stopped backend and reuses the same database on retry', async () => {
  const cloud = mockCloud({ failActiveUploadOnce: true }), replacement = plan();
  expect(await run(replacement)).toMatchObject({ ok: false, code: 'UPLOAD_FAILED' });
  const uploads = cloud.calls.filter(call => call.metadata);
  expect(uploads).toHaveLength(2);
  expect(await run(replacement)).toMatchObject({ ok: true });
  expect(cloud.calls.filter(call => call.path.endsWith('/d1/database'))).toHaveLength(1);
  expect(cloud.calls.filter(call => call.metadata)).toHaveLength(3);
});
