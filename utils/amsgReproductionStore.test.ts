import { describe, expect, it } from 'vitest';
import { appendDiagnosticEvent, listDiagnosticEvents, saveDiagnosticRun, listDiagnosticRuns, recordDiagnosticInbox } from './amsgReproductionStore';
import { diagnosticNotificationScope } from '../worker/diagnosticNotification';
const runId = '22222222-2222-4222-8222-222222222222';

describe('复现记录持久化与通知观测', () => {
  it('重开可读，按 run 隔离，同一消息补收不会增加第二条结果', async () => {
    await saveDiagnosticRun({ runId, createdAt: Date.now(), dueAt: Date.now() + 60000, api: { host: 'api.test', model: 'cheap' }, status: 'scheduled' });
    const message = { metadata: { amsgDiagnosticRunId: runId }, messageId: 'msg-1', body: '测试问候', receivedAt: Date.now() };
    expect(await recordDiagnosticInbox(message, '启动')).toBe(true);
    expect(await recordDiagnosticInbox(message, '轮询补收')).toBe(true);
    expect(await recordDiagnosticInbox({ metadata: {}, body: '正常聊天' }, '启动')).toBe(false);
    expect((await listDiagnosticRuns()).find(r => r.runId === runId)?.messages).toHaveLength(1);
    expect((await listDiagnosticEvents(runId)).filter(e => e.event === 'page-received')).toHaveLength(2);
    await appendDiagnosticEvent({ runId: '33333333-3333-4333-8333-333333333333', side: 'page', event: 'other', ts: new Date().toISOString() });
    expect((await listDiagnosticEvents(runId)).some(e => e.event === 'other')).toBe(false);
  });
  it('观测器保持原始通知参数、this 和失败语义，普通通知不增加记录', async () => {
    const events: any[] = [];
    const registration = { async showNotification(title: string, options: any) { expect(this).toBe(registration); if (title === 'fail') throw new DOMException('sensitive data', 'NotAllowedError'); return options; } };
    const scope = { registration, clients: { matchAll: async () => [] } };
    const wrapped = diagnosticNotificationScope(scope as any, async e => { events.push(e); });
    const options = { data: { payload: { metadata: { amsgDiagnosticRunId: runId }, messageId: 'msg-1' } }, silent: false, tag: 'same-tag' };
    expect(await wrapped.registration.showNotification('ok', options)).toBe(options);
    await expect(wrapped.registration.showNotification('fail', options)).rejects.toMatchObject({ name: 'NotAllowedError' });
    await wrapped.registration.showNotification('normal', {});
    expect(events.map(e => e.event)).toEqual(['notification-call', 'notification-resolved', 'notification-call', 'notification-rejected']);
    expect(JSON.stringify(events)).not.toContain('sensitive data');
  });
});
