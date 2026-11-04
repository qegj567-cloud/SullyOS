// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveMsgClient } from './activeMsgClient';
import * as store from './amsgReproductionStore';
import { collectReproductionReport, startReproduction } from './amsgReproductionClient';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: {
    scheduleReproduction: vi.fn(), readReproductionEvents: vi.fn(),
    getRemoteTaskStatus: async () => ({ state: 'missing' }),
    getRemotePushSubscription: async () => null,
    getGlobalConfig: async () => ({ workerUrl: 'https://worker.example.test' }),
  },
  fetchWorkerDiagnostics: async () => ({ reachable: false }),
  compareRemotePushSubscription: () => 'missing',
}));
vi.mock('./pushSubscribeShared', () => ({ readBrowserPushState: async () => ({ supported: false, permission: 'default', endpoint: null }) }));
vi.mock('./swChannelProbe', () => ({ captureSwRegistrationSnapshot: async () => ({ registrations: [] }) }));
vi.mock('./instantTraceLog', () => ({ readAllInstantTraces: () => [{ event: 'ordinary-chat', ts: new Date().toISOString(), content: 'private conversation' }] }));

const api = { baseUrl: 'https://api.example.test/v1', apiKey: 'secret-key', model: 'cheap' };

describe('复现创建与报告的失败边界', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    for (const run of await store.listDiagnosticRuns()) await store.updateDiagnosticRun(run.runId, { status: 'cancelled' });
  });
  it('云端接单后的本机保存失败保留同一任务身份，阻止再次创建', async () => {
    vi.mocked(ActiveMsgClient.scheduleReproduction).mockImplementation(async runId => ({ uuid: runId, dueAt: Date.now() + 60000 }));
    const update = store.updateDiagnosticRun;
    vi.spyOn(store, 'updateDiagnosticRun').mockImplementation(async (runId, patch) => {
      if (patch.status === 'scheduled') throw new DOMException('storage full', 'QuotaExceededError');
      await update(runId, patch);
    });
    await expect(startReproduction(api, 'background')).rejects.toThrow('云端可能已经接单');
    const run = (await store.listDiagnosticRuns())[0];
    expect(run.status).toBe('uncertain');
    expect(run.taskUuid).toBe(run.runId);
    await expect(startReproduction(api, 'background')).rejects.toThrow('还有一轮');
  });
  it('云端日志不可用时仍导出本机证据，排除凭据和普通聊天', async () => {
    const runId = crypto.randomUUID();
    await store.saveDiagnosticRun({ runId, createdAt: Date.now(), dueAt: Date.now() + 60000, api: { host: 'api.example.test', model: 'cheap' }, status: 'scheduled' });
    await store.appendDiagnosticEvent({ runId, side: 'sw', event: 'notification-resolved', ts: new Date().toISOString() });
    vi.mocked(ActiveMsgClient.readReproductionEvents).mockRejectedValue(new Error('secret-key'));
    const report = await collectReproductionReport(runId);
    expect(report.collection.cloud).toBe('rejected');
    expect(report.events).toContainEqual(expect.objectContaining({ event: 'notification-resolved' }));
    expect(JSON.stringify(report)).not.toMatch(/secret-key|private conversation/);
  });
});
