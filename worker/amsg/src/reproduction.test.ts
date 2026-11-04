import { describe, expect, it } from 'vitest';
import { amsgHooks, amsgFireSettled } from './index';

const runId = '11111111-1111-4111-8111-111111111111';
describe('AI 复现任务走生成和正式分段，但不进入角色业务', () => {
  it('不读取角色状态，产物携带诊断标记，收尾只写诊断命名空间', async () => {
    const writes: Array<{ namespace: string; entries: any[] }> = [];
    const scratch = {};
    const writeState = async (namespace: string, entries: any[]) => { writes.push({ namespace, entries }); return { upserted: entries.length, skipped: 0, deleted: 0 }; };
    const plan = await amsgHooks.onBeforeFire({ task: { id: 7, uuid: runId, metadata: { charId: 'amsg-diagnostic', amsgKind: 'diagnostic', amsgDiagnosticRunId: runId } }, userId: 'user', scratch, now: new Date(), writeState,
      readState: async () => { throw new Error('不应读取任何真实角色状态'); },
    } as any);
    expect(plan).toHaveProperty('messages');
    const result = await amsgHooks.onLLMOutput({ scratch, writeState, llmOutputText: '这是一条诊断消息。\n\n请检查系统通知。', iteration: 0 } as any);
    expect(result.decision).toBe('finish');
    if (result.decision !== 'finish') throw new Error('没有产生推送');
    expect(result.pushPayloads.length).toBeGreaterThan(0);
    expect(result.pushPayloads[0]).toMatchObject({ messageKind: 'content', metadata: { amsgDiagnosticRunId: runId } });
    await amsgFireSettled({ scratch, writeState, status: 'sent', sentCount: 2, llmCalls: 1 });
    expect(writes.length).toBeGreaterThanOrEqual(3);
    expect(writes.every(row => row.namespace === 'amsg:diagnostic')).toBe(true);
    expect(JSON.stringify(writes)).toContain('fire-settled');
  });
});

import { traceDiagnosticTransport } from './reproduction';
import { decryptFromStorage, deriveUserEncryptionKey } from '@rei-standard/amsg-server/cloudflare';

describe('投递边界记录', () => {
  it('用任务所属用户的密钥加密记录；发送失败原样抛出，不存端点和原文', async () => {
    const masterKey = 'ab'.repeat(32);
    const rows: unknown[][] = [];
    const env = { AMSG_MASTER_KEY: masterKey, DB: { prepare(sql: string) { return { bind(...args: unknown[]) { return {
      async first() { return { user_id: 'user-1' }; },
      async run() { rows.push(args); },
    }; } }; } } };
    const failure = Object.assign(new Error('secret-key https://push.test/private-token'), { statusCode: 410 });
    const transport = traceDiagnosticTransport({ async sendNotification(_subscription: unknown, _payload: string) { throw failure; } }, env);
    await expect(transport.sendNotification({ endpoint: 'https://push.test/private-token' }, JSON.stringify({ taskUuid: runId, messageId: 'm1', message: 'private-body', metadata: { amsgDiagnosticRunId: runId } }))).rejects.toBe(failure);
    expect(rows).toHaveLength(2);
    const key = await deriveUserEncryptionKey('user-1', masterKey);
    const events = await Promise.all(rows.map(row => decryptFromStorage(row[2] as string, key).then(JSON.parse)));
    expect(events.map(e => e.event)).toEqual(['push-attempt', 'push-rejected']);
    expect(events[1].httpStatus).toBe(410);
    expect(JSON.stringify(events)).not.toMatch(/secret-key|private-token|private-body/);
  });
});
