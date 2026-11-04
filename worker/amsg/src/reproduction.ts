import { deriveUserEncryptionKey, encryptForStorage } from '@rei-standard/amsg-server/cloudflare';
import { stripReasoningTags } from '@rei-standard/amsg-shared';
import { DIAGNOSTIC_CHAR_ID, DIAGNOSTIC_NAMESPACE, diagnosticRunId, safeDiagnosticError, type DiagnosticEvent } from '../../../utils/amsgReproduction';
import { createFireSessionState, processLLMRound } from './agentic';
import type { FireKindHandler, KindWriteState } from './fireKinds';
import { AMSG_BUNDLE_VERSION } from '../../../utils/amsgBundleVersion';

interface DiagnosticFireState { runId: string; startedAt: number; taskId: string | null }

export async function writeDiagnosticStage(writeState: KindWriteState | undefined, runId: string, event: string, fields: Record<string, unknown> = {}) {
  if (!writeState) return;
  const entry: DiagnosticEvent = { ...fields, runId, side: 'worker', event, ts: new Date().toISOString(), workerVersion: AMSG_BUNDLE_VERSION };
  try {
    await writeState(DIAGNOSTIC_NAMESPACE, [{ key: `${runId}:${crypto.randomUUID()}`, value: JSON.stringify(entry) }]);
  } catch { /* 记录故障不能改变真实生成／推送的结局；导出缺口会保留。 */ }
}

export const reproductionHandler: FireKindHandler = {
  async beforeFire({ ctx, taskMeta }) {
    const runId = diagnosticRunId(taskMeta);
    if (!runId) throw new Error('诊断任务编号缺失或无效');
    const state: DiagnosticFireState = { runId, startedAt: Date.now(), taskId: ctx.task.id == null ? null : String(ctx.task.id) };
    ctx.scratch.diagnostic = state;
    await writeDiagnosticStage(ctx.writeState, runId, 'fire-start', { taskId: state.taskId });
    return {
      state,
      messages: [
        { role: 'system', content: '你正在模拟一次主动消息，用于检查生成、分段和系统通知。你不是用户的角色，不读取或修改任何记忆。只输出三句简短的中文问候，每句单独一段，以空行分隔。不要输出工具调用、动作标签、代码、思考过程或个人信息。总共不超过120字。' },
        { role: 'user', content: '请主动发来这次测试问候，并在最后一句提醒我检查系统通知。' },
      ],
    };
  },
  async llmOutput({ ctx, state }) {
    const diagnostic = state as DiagnosticFireState;
    // 复用正式分类与分段器；最后一轮模式不允许进入工具执行循环。
    const decision = processLLMRound(createFireSessionState(), stripReasoningTags(ctx.llmOutputText || ''), {
      contactName: '主动消息复现', avatarUrl: null, taskId: diagnostic.taskId,
      messageType: 'auto', occurrenceMs: diagnostic.startedAt,
      metadata: { charId: DIAGNOSTIC_CHAR_ID, amsgKind: 'diagnostic', amsgDiagnosticRunId: diagnostic.runId },
    }, null, null, 0, 1);
    await writeDiagnosticStage(ctx.writeState, diagnostic.runId, 'llm-output', {
      durationMs: Date.now() - diagnostic.startedAt,
      outputChars: (ctx.llmOutputText || '').length,
      decision: decision.decision,
      chunks: decision.decision === 'finish' ? decision.pushPayloads.length : 0,
    });
    if (decision.decision === 'tool-request') return { decision: 'skip-push', reason: 'diagnostic-tools-disabled' };
    if (decision.decision === 'skip-push') return { decision: 'skip-push', reason: decision.reason };
    // 只保留诊断所需 metadata，分类器解析出的动作绝不交给客户端执行。
    return { decision: 'finish', pushPayloads: decision.pushPayloads.map(payload => ({
      ...payload,
      metadata: { charId: DIAGNOSTIC_CHAR_ID, amsgKind: 'diagnostic', amsgDiagnosticRunId: diagnostic.runId },
    })) };
  },
};

export async function settleReproduction(info: {
  scratch: Record<string, unknown>; writeState: KindWriteState; status?: string; sentCount?: number;
  error?: unknown; willRetry?: boolean | null; llmCalls?: unknown; outboxed?: unknown;
}): Promise<boolean> {
  const state = info.scratch.diagnostic as DiagnosticFireState | undefined;
  if (!state) return false;
  await writeDiagnosticStage(info.writeState, state.runId, 'fire-settled', {
    status: info.status, sentCount: info.sentCount, willRetry: info.willRetry,
    llmCalls: info.llmCalls, outboxed: info.outboxed,
    ...(info.error ? safeDiagnosticError(info.error) : {}),
  });
  return true;
}

// 投递重试可能不经过 fire hooks，所以在真实 transport 边界留痕。
// 仍存入现有加密 client_state；无新增表，沿用 TTL 和云端清理。
interface DiagnosticDb {
  prepare(sql: string): { bind(...args: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> } };
}
export function traceDiagnosticTransport<T extends { sendNotification(subscription: any, payload: string): Promise<any> }>(
  transport: T, env: { DB?: unknown; AMSG_MASTER_KEY?: string },
): T {
  const record = async (payload: any, event: string, fields: Record<string, unknown>) => {
    const runId = diagnosticRunId(payload?.metadata);
    if (!runId || !env.DB || !env.AMSG_MASTER_KEY || typeof payload.taskUuid !== 'string') return;
    try {
      const db = env.DB as DiagnosticDb;
      const task = await db.prepare('SELECT user_id FROM scheduled_messages WHERE uuid = ?').bind(payload.taskUuid).first<{ user_id: string }>();
      if (!task) return;
      const key = await deriveUserEncryptionKey(task.user_id, env.AMSG_MASTER_KEY);
      const entry: DiagnosticEvent = { ...fields, runId, side: 'worker', event, ts: typeof fields.ts === 'string' ? fields.ts : new Date().toISOString(), messageId: payload.messageId, chunk: payload.messageIndex, total: payload.totalMessages, workerVersion: AMSG_BUNDLE_VERSION };
      const value = await encryptForStorage(JSON.stringify(entry), key);
      // 任务已被删除时不重新写入；日志永远不含订阅、正文和 API 凭据。
      await db.prepare('INSERT INTO client_state (user_id, namespace, key, value, updated_at) SELECT user_id, ?, ?, ?, ? FROM scheduled_messages WHERE uuid = ? AND user_id = ?')
        .bind(DIAGNOSTIC_NAMESPACE, `${runId}:${crypto.randomUUID()}`, value, Date.now(), payload.taskUuid, task.user_id).run();
    } catch { /* 旁路留痕失败不影响发送 */ }
  };
  return { ...transport, async sendNotification(subscription: any, raw: string) {
    let payload: any;
    try { payload = JSON.parse(raw); } catch { /* 非 JSON 载荷照常发送 */ }
    // 先记时刻、发完再落库：D1 冷启动能拖好几秒，不能算进被测的推送耗时。
    const startedAt = Date.now();
    const attempt = { ts: new Date(startedAt).toISOString() };
    try {
      const result = await transport.sendNotification(subscription, raw);
      const durationMs = Date.now() - startedAt;
      await record(payload, 'push-attempt', attempt);
      await record(payload, 'push-accepted', { durationMs, httpStatus: result?.statusCode ?? result?.status ?? null });
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      await record(payload, 'push-attempt', attempt);
      await record(payload, 'push-rejected', { durationMs, ...safeDiagnosticError(error) });
      throw error;
    }
  } };
}
