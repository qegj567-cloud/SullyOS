import { beforeEach, expect, it, vi } from 'vitest';
const append = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('./amsgReproductionStore', () => ({ appendDiagnosticEvent: append }));
vi.mock('./nativeAmsgInbox', () => ({ parseNativeAmsgPayload: (raw: string) => JSON.parse(raw) }));
import { recordNativeDiagnosticReceipt } from './nativeAmsgDiagnostics';
const runId = '00000000-0000-4000-8000-000000000001';
const message = { id: 'queue-id', payload: JSON.stringify({ messageId: 'message', message: 'private text', metadata: { amsgDiagnosticRunId: runId } }), receivedAt: 1000, notificationAt: 2000 };
beforeEach(() => append.mockReset().mockResolvedValue(undefined));

it('使用原生时间与真实通道，报告不包含 payload 或正文', async () => {
  await recordNativeDiagnosticReceipt({ ...message, notificationOutcome: 'requested' });
  expect(append.mock.calls.map(([e]) => [e.side, e.event, e.ts])).toEqual([
    ['native', 'native-received', '1970-01-01T00:00:01.000Z'],
    ['native', 'notification-resolved', '1970-01-01T00:00:02.000Z'],
  ]);
  expect(JSON.stringify(append.mock.calls)).not.toContain('private text');
  expect(JSON.stringify(append.mock.calls)).not.toContain('payload');
});

it.each(['policy-skipped', 'permission-denied', 'failed', undefined] as const)('不把 %s 报成通知调用成功', async notificationOutcome => {
  await recordNativeDiagnosticReceipt({ ...message, notificationOutcome });
  expect(append.mock.calls.some(([e]) => e.event === 'notification-resolved')).toBe(false);
});

it('普通消息不写诊断库', async () => {
  await recordNativeDiagnosticReceipt({ ...message, payload: JSON.stringify({ message: 'private', metadata: { charId: 'c' } }) });
  expect(append).not.toHaveBeenCalled();
});

it('诊断库失败时保留队列重试，不虚构成功', async () => {
  append.mockRejectedValueOnce(new Error('DB unavailable'));
  await expect(recordNativeDiagnosticReceipt(message)).rejects.toThrow('DB unavailable');
});
