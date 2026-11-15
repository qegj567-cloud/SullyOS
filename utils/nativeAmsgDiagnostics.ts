import { diagnosticRunId } from './amsgReproduction';
import { parseNativeAmsgPayload } from './nativeAmsgInbox';
import type { UnifiedPushStoredMessage } from './unifiedPushPlugin';

/** Replay only native-recorded facts, with the original device timestamps, after WebView starts. */
export async function recordNativeDiagnosticReceipt(message: UnifiedPushStoredMessage): Promise<void> {
  const payload = parseNativeAmsgPayload(message.payload);
  const runId = diagnosticRunId(payload?.metadata);
  if (!runId || !Number.isFinite(message.receivedAt)) return;
  const { appendDiagnosticEvent } = await import('./amsgReproductionStore');
  const base = { runId, side: 'native' as const, transport: 'unifiedpush', messageId: payload?.messageId };
  await appendDiagnosticEvent({ ...base, event: 'native-received', ts: new Date(message.receivedAt).toISOString() });
  if (!Number.isFinite(message.notificationAt)) return;
  const ts = new Date(message.notificationAt!).toISOString();
  switch (message.notificationOutcome) {
    case 'requested':
      await appendDiagnosticEvent({ ...base, ts, event: 'notification-resolved' });
      break;
    case 'permission-denied':
    case 'failed':
      await appendDiagnosticEvent({ ...base, ts, event: 'notification-rejected',
        errorName: message.notificationOutcome === 'permission-denied' ? 'NotAllowedError' : 'Error' });
      break;
    case 'policy-skipped':
      await appendDiagnosticEvent({ ...base, ts, event: 'notification-skipped' });
      break;
    // An absent/unknown outcome is not evidence of notification success.
  }
}
