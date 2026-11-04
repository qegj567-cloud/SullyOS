import { describe, expect, it } from 'vitest';
import { buildReproductionTask, diagnosticRunId, safeDiagnosticError, summarizeReproduction } from './amsgReproduction';

const runId = '11111111-1111-4111-8111-111111111111';
describe('主动消息复现的隔离协议', () => {
  it('选中的 API 整套用于一次性任务，不带角色上下文或工具，并保留同一任务身份', () => {
    const task = buildReproductionTask(runId, { baseUrl: 'https://example.test/v1', apiKey: 'cheap-key', model: 'cheap' }, 1792073400000);
    expect(task).toMatchObject({ uuid: runId, apiKey: 'cheap-key', primaryModel: 'cheap', recurrenceType: 'none', messageType: 'auto', messageSubtype: 'job', firstSendTime: '2026-10-15T14:10:00.000Z' });
    expect(diagnosticRunId(task.metadata)).toBe(runId);
    expect(task).not.toHaveProperty('credRefs');
    expect(task).not.toHaveProperty('tools');
    expect(task.metadata.charId).toBe('amsg-diagnostic');
  });
  it('坏标记不能被认成有效诊断编号', () => {
    expect(diagnosticRunId({ amsgDiagnosticRunId: '../private' })).toBeNull();
  });
  it('异常只保留白名单错误类型与状态，不能导出供应商回显的密钥和正文', () => {
    const error = Object.assign(new Error('Bearer secret-key https://push.test/private-token'), { statusCode: 403 });
    expect(safeDiagnosticError(error)).toEqual({ errorName: 'Error', httpStatus: 403 });
  });
  it('模型调用失败时从 llmStatus 读出状态码，Key 错和限流才分得开', () => {
    const error = Object.assign(new Error('upstream'), { code: 'LLM_CALL_FAILED', llmStatus: 429 });
    expect(safeDiagnosticError(error)).toEqual({ errorName: 'Error', errorCode: 'LLM_CALL_FAILED', httpStatus: 429 });
  });
  it('留在前台作对照时，收到消息但没弹通知是正常结果', () => {
    const events = [{ event: 'sw-received' }, { event: 'inbox-content-saved' }];
    expect(summarizeReproduction(events, 'foreground')).toContain('正常');
    expect(summarizeReproduction(events, 'background')).not.toContain('正常');
  });
  it('接口成功不能当成用户看到通知，缺 SW 证据不能断言未送达', () => {
    expect(summarizeReproduction([{ event: 'push-accepted' }])).toContain('设备');
    expect(summarizeReproduction([{ event: 'notification-resolved' }])).toContain('用户');
    expect(summarizeReproduction([])).toContain('证据');
  });
  it('云端已明确失败时不能仍显示等待后续证据，也不能带出原始错误', () => {
    const events = [{ event: 'fire-start' }, { event: 'fire-settled', status: 'failed', httpStatus: 401, errorCode: 'LLM_CALL_FAILED', message: 'secret-key' }];
    expect(summarizeReproduction(events)).toContain('失败');
    expect(summarizeReproduction(events)).toContain('401');
    expect(summarizeReproduction(events)).not.toContain('secret-key');
    expect(summarizeReproduction([{ event: 'fire-settled', status: 'skipped' }])).toContain('跳过');
  });
});
