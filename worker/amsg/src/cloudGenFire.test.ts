// worker/amsg/src/cloudGenFire.test.ts
// 代跑任务（amsgKind: 'cloud-gen'）在 Worker 侧的回归守卫：消息原样交给模型、结果一律走附件、
// 通知开关由客户端给、失败一定送回客户端、按用途分组、不做生成重试、体检报得出这项能力。
import { describe, expect, it, vi } from 'vitest';

import worker, { amsgFireSettled, amsgHooks, amsgSerializeKey, buildWorkerConfig } from './index';
import { packStateValue } from '../../../utils/amsgFirePack';
import {
  CLOUD_GEN_KIND,
  CLOUD_GEN_NAMESPACE,
  CLOUD_GEN_PURPOSE_META_KEY,
  CLOUD_GEN_RESULT_KIND,
  CLOUD_GEN_TOTAL_TIMEOUT_MS,
  buildCloudGenJobInput,
  cloudGenJobKey,
} from '../../../utils/amsgCloudGenJob';
import { AMSG_JOB_ID_KEY, AMSG_TASK_KIND_KEY } from '../../../utils/amsgTaskKinds';

const CHAR_ID = 'char-xm';
const JOB_ID = 'job-gen-1';
const MESSAGES = [
  { role: 'system' as const, content: '你是小明的角色。' },
  { role: 'user' as const, content: '生成今天的日程' },
];
const ATTACHMENT = { version: 1 as const, namespace: 'amsg:attachments', key: 'att-1', taskUuid: 'task-uuid-gen', occurrenceMs: 1, expiresAt: 2 };

const jobValue = (overrides: Record<string, unknown> = {}) => packStateValue(JSON.stringify(buildCloudGenJobInput({
  jobId: JOB_ID, purpose: 'schedule', charId: CHAR_ID, charName: '小明', messages: MESSAGES,
  notify: { title: '小明', body: '日程生成好了' },
  ...overrides,
} as any)));

const makeFireCtx = async (opts: { value?: string | null; purpose?: string } = {}) => {
  const value = opts.value === undefined ? await jobValue() : opts.value;
  const rows = value === null ? [] : [{ key: cloudGenJobKey(JOB_ID), value }];
  const writeState = vi.fn(async () => ({ upserted: 0, skipped: 0, deleted: 1 }));
  const scratch: Record<string, unknown> = {};
  const ctx = {
    task: {
      id: 9, uuid: 'task-uuid-gen', contactName: '小明', recurrenceType: 'none',
      metadata: {
        charId: CHAR_ID, [AMSG_TASK_KIND_KEY]: CLOUD_GEN_KIND, [AMSG_JOB_ID_KEY]: JOB_ID,
        [CLOUD_GEN_PURPOSE_META_KEY]: opts.purpose ?? 'schedule',
      },
    },
    userId: 'u1',
    readState: vi.fn(async (ns: string) => (ns === CLOUD_GEN_NAMESPACE ? rows : [])),
    writeState,
    now: new Date(),
    scratch,
  } as any;
  return { ctx, scratch, writeState };
};

const makeSessionCtx = (scratch: Record<string, unknown>, llmResponse: unknown) => {
  const emitResult = vi.fn(async () => ({ messageId: 'm1', pushed: true }));
  const storeAttachment = vi.fn(async () => ATTACHMENT);
  return {
    ctx: {
      sessionId: 's1', llmResponse, llmOutputText: 'fallback', contactName: '小明', metadata: {},
      scratch, emitResult, storeAttachment, taskId: 9, taskUuid: 'task-uuid-gen', occurrenceMs: 1,
    } as any,
    emitResult,
    storeAttachment,
  };
};

const RESPONSE = {
  model: 'served-model',
  choices: [{ message: { content: '{"slots":[]}', reasoning_content: '想了想' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 120, completion_tokens: 40 },
};

describe('代跑任务 beforeFire', () => {
  it('消息原样交给模型，总超时与即时对话同一档', async () => {
    const { ctx } = await makeFireCtx();
    const plan = await amsgHooks.onBeforeFire(ctx) as { messages: unknown; totalTimeoutMs: number };
    expect(plan.messages).toEqual(MESSAGES);
    expect(plan.totalTimeoutMs).toBe(CLOUD_GEN_TOTAL_TIMEOUT_MS);
  });

  it('输入坏了 → 抛错并当场删输入行', async () => {
    const { ctx, writeState } = await makeFireCtx({ value: await packStateValue('{"v":2}') });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/解析失败/);
    expect(writeState).toHaveBeenCalledWith(CLOUD_GEN_NAMESPACE, [{ key: cloudGenJobKey(JOB_ID), value: null }]);
  });

  it('输入的用途跟任务对不上 → 硬失败', async () => {
    const { ctx } = await makeFireCtx({ purpose: 'dream' });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/对不上/);
  });
});

describe('代跑任务 llmOutput', () => {
  it('正文、思考、结束原因存成附件，结果只带引用和用量', async () => {
    const { ctx, scratch } = await makeFireCtx();
    await amsgHooks.onBeforeFire(ctx);
    const session = makeSessionCtx(scratch, RESPONSE);
    const decision = await amsgHooks.onLLMOutput(session.ctx);

    expect(decision).toMatchObject({ decision: 'skip-push' });
    const [stored, options] = session.storeAttachment.mock.calls[0] as unknown as [string, any];
    expect(JSON.parse(stored)).toEqual({ v: 1, content: '{"slots":[]}', reasoning: '想了想', finishReason: 'stop' });
    expect(options.owner).toEqual({ type: 'character', id: CHAR_ID });
    expect(session.emitResult).toHaveBeenCalledWith({
      resultKind: CLOUD_GEN_RESULT_KIND, v: 1, jobId: JOB_ID, purpose: 'schedule', charId: CHAR_ID,
      ok: true, attachment: ATTACHMENT,
      usage: { promptTokens: 120, completionTokens: 40, backendModel: 'served-model' },
      notification: { show: 'always', title: '小明', body: '日程生成好了' },
    });
  });

  it('客户端关了完成通知 → 只进收件箱不推送', async () => {
    const { ctx, scratch } = await makeFireCtx({ value: await jobValue({ notify: null }) });
    await amsgHooks.onBeforeFire(ctx);
    const session = makeSessionCtx(scratch, RESPONSE);
    await amsgHooks.onLLMOutput(session.ctx);
    expect(session.emitResult).toHaveBeenCalledWith(expect.objectContaining({ notification: { show: false } }));
  });

  it('跑完删输入行，且不再补失败结果', async () => {
    const { ctx, scratch, writeState } = await makeFireCtx();
    await amsgHooks.onBeforeFire(ctx);
    const session = makeSessionCtx(scratch, RESPONSE);
    await amsgHooks.onLLMOutput(session.ctx);
    const settleEmit = vi.fn(async () => ({}));
    await amsgFireSettled({
      status: 'skipped', skipReason: 'skip-push', willRetry: null, metadata: ctx.task.metadata,
      scratch, writeState, emitResult: settleEmit,
    } as any);
    expect(writeState).toHaveBeenCalledWith(CLOUD_GEN_NAMESPACE, [{ key: cloudGenJobKey(JOB_ID), value: null }]);
    expect(settleEmit).not.toHaveBeenCalled();
  });
});

describe('代跑失败一定送回客户端', () => {
  it('模型调用失败 → 收尾补一条 ok:false，不推送', async () => {
    const { ctx, scratch, writeState } = await makeFireCtx();
    await amsgHooks.onBeforeFire(ctx);
    const emitResult = vi.fn(async () => ({}));
    await amsgFireSettled({
      status: 'failed', willRetry: false, metadata: ctx.task.metadata,
      error: Object.assign(new Error('AI API error: 429'), { code: 'LLM_CALL_FAILED' }),
      usage: { prompt_tokens: 10 },
      scratch, writeState, emitResult,
    } as any);
    expect(emitResult).toHaveBeenCalledWith({
      resultKind: CLOUD_GEN_RESULT_KIND, v: 1, jobId: JOB_ID, purpose: 'schedule', charId: CHAR_ID,
      ok: false, error: { code: 'LLM_CALL_FAILED', message: 'AI API error: 429' },
      usage: { promptTokens: 10 },
      notification: { show: false },
    });
    expect(writeState).toHaveBeenCalledWith(CLOUD_GEN_NAMESPACE, [{ key: cloudGenJobKey(JOB_ID), value: null }]);
  });

  it('单次模型调用撞上 5 分钟上限（原样的 TimeoutError）→ 补一条 llm-timeout', async () => {
    const { ctx, scratch, writeState } = await makeFireCtx();
    await amsgHooks.onBeforeFire(ctx);
    const emitResult = vi.fn(async () => ({}));
    await amsgFireSettled({
      status: 'failed', willRetry: false, metadata: ctx.task.metadata,
      error: new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      scratch, writeState, emitResult,
    } as any);
    expect(emitResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'llm-timeout' }) }));
  });

  it('beforeFire 就失败（还没挂上下文）也能靠任务 metadata 认出来', async () => {
    const { ctx, writeState } = await makeFireCtx({ value: await packStateValue('坏的') });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow();
    const emitResult = vi.fn(async () => ({}));
    await amsgFireSettled({
      status: 'failed', willRetry: false, metadata: ctx.task.metadata, error: new Error('坏输入'),
      scratch: {}, writeState, emitResult,
    } as any);
    expect(emitResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false, jobId: JOB_ID }));
  });

  it('输入已不在（beforeFire 跳过）→ 补一条 input-missing', async () => {
    const { ctx, writeState, scratch } = await makeFireCtx({ value: null });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
    const emitResult = vi.fn(async () => ({}));
    await amsgFireSettled({
      status: 'skipped', skipReason: 'before-fire', willRetry: null, metadata: ctx.task.metadata,
      scratch, writeState, emitResult,
    } as any);
    expect(emitResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'input-missing' }) }));
  });

  it('客户端取消的不补（转本机时自己撤的）', async () => {
    const { ctx, writeState, scratch } = await makeFireCtx();
    const emitResult = vi.fn(async () => ({}));
    await amsgFireSettled({
      status: 'cancelled', willRetry: false, metadata: ctx.task.metadata, scratch, writeState, emitResult,
    } as any);
    expect(emitResult).not.toHaveBeenCalled();
  });
});

describe('代跑的调度配置', () => {
  const env = { AMSG_MASTER_KEY: 'a'.repeat(64) } as any;
  const meta = (purpose: string) => ({ charId: CHAR_ID, [AMSG_TASK_KIND_KEY]: CLOUD_GEN_KIND, [CLOUD_GEN_PURPOSE_META_KEY]: purpose });

  it('分组键带上用途：人格模拟挡不住同一角色的日程', () => {
    expect(amsgSerializeKey({ metadata: meta('schedule') })).toBe(`${CHAR_ID}#cloud-gen#schedule`);
    expect(amsgSerializeKey({ metadata: meta('persona-sim') })).toBe(`${CHAR_ID}#cloud-gen#persona-sim`);
  });

  it('不做生成重试', () => {
    expect(buildWorkerConfig(env).maxGenerationRetries({ metadata: meta('dream') })).toBe(0);
  });

  it('输入命名空间配了 TTL', () => {
    expect(buildWorkerConfig(env).clientStateTtl[CLOUD_GEN_NAMESPACE]).toBe(3);
  });

  it('/config-check 报 cloudGen', async () => {
    const response = await (worker as any).fetch(
      new Request('https://w.example/config-check'),
      { ...env, VAPID_EMAIL: 'mailto:a@b.c', VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', DB: { prepare: () => {} } },
      { waitUntil: () => {} },
    );
    expect((await response.json()).data.cloudGen).toBe(true);
  });
});
