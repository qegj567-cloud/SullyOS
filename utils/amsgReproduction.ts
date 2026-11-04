/** 环境无关的复现协议：真实传输，独立身份，报告只收结构化字段。 */
export const DIAGNOSTIC_KIND = 'diagnostic';
export const DIAGNOSTIC_NAMESPACE = 'amsg:diagnostic';
export const DIAGNOSTIC_CHAR_ID = 'amsg-diagnostic';
export const DIAGNOSTIC_RETENTION_DAYS = 7;
export const DIAGNOSTIC_PROTOCOL = 1;

export interface DiagnosticEvent {
  runId: string;
  side: 'page' | 'sw' | 'worker';
  event: string;
  ts: string;
  [key: string]: unknown;
}

export function diagnosticRunId(metadata: unknown): string | null {
  const value = (metadata as Record<string, unknown> | null)?.amsgDiagnosticRunId;
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

export function safeDiagnosticError(error: unknown): { errorName: string; httpStatus?: number; errorCode?: string } {
  const e = error as { name?: unknown; statusCode?: unknown; status?: unknown; llmStatus?: unknown; code?: unknown; cause?: { status?: unknown; statusCode?: unknown } } | null;
  const names = ['Error', 'TypeError', 'AbortError', 'TimeoutError', 'NotAllowedError', 'InvalidStateError', 'QuotaExceededError', 'VersionError', 'DataError', 'TransactionInactiveError'];
  // 模型调用失败时上游把状态码放在 llmStatus（amsg-shared buildUpstreamError），401／404／429 全靠它区分。
  const status = Number(e?.statusCode ?? e?.status ?? e?.llmStatus ?? e?.cause?.statusCode ?? e?.cause?.status);
  return {
    errorName: typeof e?.name === 'string' && names.includes(e.name) ? e.name : 'Error',
    ...(typeof e?.code === 'string' && ['LLM_CALL_FAILED', 'PUSH_PAYLOAD_TOO_LARGE', 'PUSH_SUBSCRIPTION_MISSING', 'CREDENTIAL_NOT_FOUND', 'INVALID_PARAMETERS', 'TASK_NOT_FOUND', 'TASK_ALREADY_COMPLETED'].includes(e.code) ? { errorCode: e.code } : {}),
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
  };
}

export function buildReproductionTask(
  runId: string,
  api: { baseUrl: string; apiKey: string; model: string; temperature?: number },
  dueAt: number,
) {
  if (!diagnosticRunId({ amsgDiagnosticRunId: runId })) throw new Error('诊断编号无效');
  if (!api.baseUrl.trim() || !api.model.trim()) throw new Error('请先填写 API 地址和模型');
  return {
    uuid: runId,
    contactName: '主动消息复现',
    messageType: 'auto',
    messageSubtype: 'job',
    recurrenceType: 'none',
    firstSendTime: new Date(dueAt).toISOString(),
    apiUrl: api.baseUrl.trim(),
    apiKey: api.apiKey.trim(),
    primaryModel: api.model.trim(),
    temperature: api.temperature ?? 0.7,
    maxTokens: 512,
    messages: [{ role: 'user', content: '诊断任务：由 Worker 在触发时组装测试提示词。' }],
    metadata: {
      charId: DIAGNOSTIC_CHAR_ID,
      amsgKind: DIAGNOSTIC_KIND,
      amsgDiagnosticRunId: runId,
      amsgDiagnosticProtocol: DIAGNOSTIC_PROTOCOL,
    },
  };
}

export function summarizeReproduction(events: Array<{ event?: unknown; status?: unknown; httpStatus?: unknown }>, scenario?: string): string {
  const has = (name: string) => events.some(e => e.event === name);
  if (has('notification-rejected')) return '设备调用系统通知接口失败，请查看通知阶段的错误类型。';
  if (has('notification-resolved')) return '系统通知接口已完成；是否实际出现横幅或声音，仍需用户确认。';
  // 页面开着时 SW 按策略不弹系统通知，没有通知阶段记录是预期结果，不是故障。
  if (scenario === 'foreground' && (has('inbox-content-saved') || has('page-received'))) return '测试消息已经收到。页面开着时系统一般不弹通知，这一轮是正常的。';
  if (has('push-rejected')) return '至少一次推送发送失败；请结合后续重试和设备收件记录判断。';
  if (has('inbox-content-saved')) return '设备已收到并保存测试消息，尚未取得系统通知接口的完成记录。';
  if (has('push-accepted')) return '推送服务已接受请求，尚无设备通知完成的证据。';
  const settled = [...events].reverse().find(e => e.event === 'fire-settled');
  if (settled?.status === 'failed') {
    const status = safeDiagnosticError({ status: settled.httpStatus }).httpStatus;
    return `云端执行失败${status ? `（HTTP ${status}）` : ''}，请查看执行结束记录；尚无通知完成的证据。`;
  }
  if (settled?.status === 'skipped') return '云端已跳过这次执行，尚无通知完成的证据。';
  if (has('llm-output')) return '已取得模型输出，请继续查看发送阶段；生成完成不等于推送送达。';
  if (has('fire-start')) return '云端已开始执行，尚无后续阶段的完整证据。';
  return '目前证据不足；可能尚未到点，也可能有记录未取得。';
}
