/** Regression coverage for the verified 2026-10-19 integration defects. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { amsgHooks, amsgFireSettled, offloadOversizedPush, runFireRenewTool, runFireScheduleTool } from './index';
import { buildXhsSessionPayload } from './agentic';
import { parseInstantInputRef } from './instantInput';
import { buildToolConfig, buildToolPack, AMSG_TOOL_CONFIG_KEY, AMSG_TOOL_PACK_KEY } from '../../../utils/amsgToolPack';
import { AMSG_FIRE_PACK_KEY, AMSG_SELF_LOG_KEY, FIRE_PACK_VERSION, createSelfLog, appendSelfLogTask, unpackStateValue } from '../../../utils/amsgFirePack';
import { AMSG_LIMITS_KEY } from '../../../utils/amsgLimits';
import { buildAmsg2NoticesText } from '../../../utils/amsg2TaskContext';
import { isPendingTask } from '../../../utils/amsg2Tasks';

const now = Date.parse('2026-10-18T10:00:00Z');
const charId = 'audit-char';
const uuid = '11111111-1111-4111-8111-111111111111';
const makeTask = (index: number, at: number) => ({
  taskUuid: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
  clientTaskId: `client-${index}`, mode: 'auto', source: 'character',
  status: 'scheduled', recurrenceType: 'none', firstSendTime: new Date(at).toISOString(),
  createdAt: at - 60_000, expirePolicy: 'expire',
}) as any;

async function start(over: {
  enabled?: boolean; config?: any; pending?: any[]; selfLog?: any; sharedValue?: string;
  builtAt?: number; limits?: Record<string, unknown>; chatMessages?: any[]; nowMs?: number; task?: any; remote?: any[];
} = {}) {
  const nowMs = over.nowMs ?? now;
  const pack = {
    v: FIRE_PACK_VERSION, template: '角色设定 {{AMSG_TASK_INSTRUCTION}}',
    lastUserMessageAt: null, tzId: 'Asia/Tokyo', userTzId: 'Asia/Tokyo', targetName: '用户',
    builtAt: over.builtAt ?? now - 60_000, pendingTasks: over.pending ?? [], scene: null,
    selfScheduleEnabled: over.enabled ?? true,
    chat: { builtAt: now, messages: over.chatMessages ?? [{ role: 'user', content: '你好' }] },
  };
  const rows = [
    { key: AMSG_FIRE_PACK_KEY, value: over.sharedValue ?? JSON.stringify(pack) },
    { key: AMSG_TOOL_PACK_KEY, value: JSON.stringify(buildToolPack({ id: charId, name: '角色' } as any)) },
    { key: AMSG_LIMITS_KEY, value: JSON.stringify({ v: 1, selfScheduleEnabled: over.enabled ?? true, maxUnansweredSends: 0, minSendGapMinutes: 0, ...over.limits }) },
    ...(over.selfLog ? [{ key: AMSG_SELF_LOG_KEY, value: JSON.stringify(over.selfLog) }] : []),
  ];
  const scheduleTask = vi.fn<NonNullable<Parameters<typeof runFireScheduleTool>[1]>>(async (options) => {
    if (!options.uuid) throw new Error('Expected a deterministic self-scheduled task UUID');
    return { created: true, id: 2, uuid: options.uuid, nextSendAt: options.firstSendTime };
  });
  const ctx: any = {
    task: over.task ?? { id: 1, uuid, contactName: '角色', nextSendAt: new Date(nowMs).toISOString(), recurrenceType: 'none',
      metadata: { charId, amsgClientTaskId: 'instant-client', amsgInstantChat: true, amsgMode: 'instant' } },
    userId: 'audit-user', now: new Date(nowMs), scratch: {}, scheduleTask,
    ...(over.remote ? { listTasks: async () => ({ tasks: over.remote, pagination: { hasMore: false } }) } : {}),
    renewTask: vi.fn(async (_uuid: string, sendAt: string) => ({ renewed: true, nextSendAt: sendAt })),
    cancelTask: vi.fn(async () => ({ cancelled: true })),
    readState: vi.fn(async (namespace: string) => namespace.startsWith('amsg:char:') ? rows : [
      { key: AMSG_TOOL_CONFIG_KEY, value: JSON.stringify(over.config ?? buildToolConfig(undefined)) },
    ]),
    writeState: vi.fn(async () => ({ upserted: 1, skipped: 0, deleted: 0 })),
  };
  const plan: any = await amsgHooks.onBeforeFire(ctx);
  return { ctx, plan, stash: ctx.scratch.fire, scheduleTask, pack };
}

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { vi.restoreAllMocks(); });

describe('amsg2 audit regressions', () => {
  it('native tools OFF survives an empty MCP list and suppresses native tool declarations', async () => {
    const config = buildToolConfig(undefined, { servers: [], useNativeTools: false });
    expect(config.mcpUseNativeTools).toBe(false);
    const { plan } = await start({ config });
    expect(plan.tools).toBeUndefined();
  });

  it('disabled scheduling never executes a code-example scheduling call', async () => {
    const { ctx, plan, scheduleTask } = await start({ enabled: false });
    expect(plan.tools).toBeUndefined();
    const output: any = await amsgHooks.onLLMOutput({
      ...ctx, taskId: 1, sessionId: 'audit-session', iteration: 0,
      metadata: ctx.task.metadata, contactName: '角色',
      llmOutputText: '下面只是调用示例：\n```js\nschedule_active_message({"send_at":"2026-10-18T10:30:00Z"})\n```',
    });
    expect(output.decision).not.toBe('tool-request');
    expect(scheduleTask).not.toHaveBeenCalled();
  });

  it('enabled scheduling ignores fenced and inline examples while accepting an explicit bare call', async () => {
    const { ctx, scheduleTask } = await start();
    const example: any = await amsgHooks.onLLMOutput({
      ...ctx, taskId: 1, sessionId: 'example', iteration: 0, metadata: ctx.task.metadata, contactName: '角色',
      llmOutputText: '示例：`schedule_active_message({"send_at":"2026-10-18T10:30:00Z"})`\n```js\nschedule_active_message({"send_at":"2026-10-18T10:30:00Z"})\n```',
    });
    expect(example.decision).not.toBe('tool-request');
    expect(scheduleTask).not.toHaveBeenCalled();
    const explicit: any = await amsgHooks.onLLMOutput({
      ...ctx, taskId: 1, sessionId: 'explicit', iteration: 0, metadata: ctx.task.metadata, contactName: '角色',
      llmOutputText: 'schedule_active_message({"send_at":"2026-10-18T10:30:00Z"})',
    });
    expect(explicit.decision).toBe('tool-request');
  });

  it('execution rejects scheduling even when a caller supplies a tool call after the user disabled it', async () => {
    const { ctx, scheduleTask } = await start({ enabled: false });
    const result = await amsgHooks.executeToolCalls([{
      id: 'blocked', function: { name: 'schedule_active_message', arguments: '{"send_at":"2026-10-18T10:30:00Z"}' },
    }], ctx);
    expect(result[0].content).toContain('schedule_disabled');
    expect(scheduleTask).not.toHaveBeenCalled();
  });

  it('bound instant input refreshes scheduled context while retaining the legacy shared chat', async () => {
    const base = await start();
    const bound = { ...base.pack, builtAt: now, template: 'LATEST_SCHEDULED_HISTORY', lastUserMessageAt: now,
      chat: { builtAt: now, messages: [{ role: 'user', content: 'BOUND_INSTANT_INPUT' }] } };
    const next = await start({ task: { ...base.ctx.task, taskInput: { firePack: bound, firePackUpdatedAt: now } } });
    expect(JSON.stringify(next.plan.messages)).toContain('BOUND_INSTANT_INPUT');
    const writes = next.ctx.writeState.mock.calls.flatMap((call: any[]) => call[1]);
    const shared = writes.find((entry: any) => entry.key === AMSG_FIRE_PACK_KEY);
    expect(shared?.updatedAt).toBe(now);
    expect(JSON.parse(shared.value)).toMatchObject({ template: 'LATEST_SCHEDULED_HISTORY', lastUserMessageAt: now,
      chat: { messages: [{ role: 'user', content: '你好' }] } });
  });

  it('a corrupt shared snapshot cannot reject an intact bound instant input', async () => {
    const base = await start();
    const bound = { ...base.pack, chat: { builtAt: now, messages: [{ role: 'user', content: 'INTACT_BOUND_INPUT' }] } };
    const next = await start({ sharedValue: 'gz1:not-valid-gzip',
      task: { ...base.ctx.task, taskInput: { firePack: bound } } });
    expect(JSON.stringify(next.plan.messages)).toContain('INTACT_BOUND_INPUT');
    expect(next.ctx.writeState.mock.calls.flatMap((call: any[]) => call[1]).some((entry: any) => entry.key.startsWith('chat_fail:'))).toBe(false);
  });

  it('a missing bound input never falls back to another round in the shared snapshot', async () => {
    const base = await start();
    await expect(start({ task: { ...base.ctx.task, taskInput: { firePackRef: {
      namespace: 'amsg:instant-input', key: uuid,
    } } } })).rejects.toThrow('即时输入缺失');
  });

  it('an older bound task cannot replace a newer shared pack or re-enable disabled scheduling', async () => {
    const base = await start();
    const old = { ...base.pack, builtAt: now - 120_000,
      chat: { builtAt: now - 120_000, messages: [{ role: 'user', content: 'OLDER_BOUND_INPUT' }] } };
    const next = await start({ enabled: false, builtAt: now,
      task: { ...base.ctx.task, taskInput: { firePack: old, firePackUpdatedAt: now - 120_000 } } });
    expect(JSON.stringify(next.plan.messages)).toContain('OLDER_BOUND_INPUT');
    expect(next.plan.tools).toBeUndefined();
    expect(next.ctx.writeState.mock.calls.flatMap((call: any[]) => call[1]).some((entry: any) => entry.key === AMSG_FIRE_PACK_KEY)).toBe(false);
    expect((await runFireScheduleTool(next.stash, next.scheduleTask, { send_at: '2026-10-18T12:00:00Z' }, now)).reason).toBe('schedule_disabled');
  });

  it('a transfer-only output emits a durable action result without marking the reply failed', async () => {
    const { ctx } = await start();
    const emitResult = vi.fn(async () => ({ messageId: 'actions-result', pushed: false }));
    const output = await amsgHooks.onLLMOutput({
      ...ctx, emitResult, taskId: 1, taskUuid: ctx.task.uuid, sessionId: 'actions', iteration: 0,
      metadata: ctx.task.metadata, contactName: '角色', llmOutputText: '[[ACTION:TRANSFER:520]]',
    });
    expect(output.decision).toBe('skip-push');
    expect(emitResult).toHaveBeenCalledWith(expect.objectContaining({
      resultKind: 'assistant-actions', notification: { show: false },
      push: expect.objectContaining({ metadata: expect.objectContaining({ directives: [{ type: 'transfer', amount: 520 }] }) }),
    }));
    expect(ctx.writeState.mock.calls.flatMap((call: any[]) => call[1]).some((entry: any) => entry.key.startsWith('chat_fail:'))).toBe(false);
  });

  it('failed action-result persistence fails the fire so it can be retried', async () => {
    const { ctx } = await start();
    await expect(amsgHooks.onLLMOutput({
      ...ctx, emitResult: async () => { throw new Error('result storage unavailable'); },
      taskId: 1, taskUuid: ctx.task.uuid, sessionId: 'actions-fail', iteration: 0,
      metadata: ctx.task.metadata, contactName: '角色', llmOutputText: '[[ACTION:TRANSFER:520]]',
    })).rejects.toThrow('result storage unavailable');
  });

  it('the authoritative task list removes stale snapshots and keeps a still-pending overdue task', async () => {
    const ghost = makeTask(30, now + 3_600_000);
    const late = makeTask(31, now - 86_400_000);
    const { stash } = await start({ pending: [ghost], remote: [{
      uuid: late.taskUuid, charId, clientTaskId: late.clientTaskId, status: 'pending',
      nextSendAt: late.firstSendTime, recurrenceType: 'none', messageType: 'auto',
      metadata: { charId, amsgSelfScheduled: true, amsgExpirePolicy: 'expire' },
    }, { uuid: 'other-char', charId: 'unrelated', status: 'pending', nextSendAt: late.firstSendTime },
    { uuid: 'instant-task', charId, status: 'pending', nextSendAt: late.firstSendTime, metadata: { amsgInstantChat: true } }] });
    expect(stash.pendingTaskCount).toBe(1);
    expect(stash.pendingTasks.map((task: any) => task.taskUuid)).toEqual([late.taskUuid]);
    expect(stash.plannedSelfSends).toBe(1);
  });

  it('native transport OFF retains execution permission for an explicit text scheduling call', async () => {
    const { plan, ctx } = await start({ config: buildToolConfig(undefined, { servers: [], useNativeTools: false }) });
    expect(plan.tools).toBeUndefined();
    expect(plan.allowedToolNames).toContain('schedule_active_message');
    const output = await amsgHooks.onLLMOutput({ ...ctx, taskId: 1, sessionId: 'text-allowed', iteration: 0,
      metadata: ctx.task.metadata, contactName: '角色', llmOutputText: 'schedule_active_message({"send_at":"2026-10-18T12:00:00Z"})' });
    expect(output.decision).toBe('tool-request');
  });

  it('expired snapshot tasks do not occupy live task slots', async () => {
    const expired = Array.from({ length: 5 }, (_, i) => makeTask(i + 1, now - 86_400_000));
    expect(expired.every(task => !isPendingTask(task, now))).toBe(true);
    let selfLog = createSelfLog(now - 60_000, null);
    for (const task of expired) selfLog = appendSelfLogTask(selfLog, task);
    const { stash, scheduleTask, plan } = await start({ selfLog });
    expect(stash.pendingTaskCount).toBe(0);
    expect(JSON.stringify(plan.messages)).not.toContain('00000001');
    const result = await runFireScheduleTool(stash, scheduleTask, { send_at: '2026-10-18T11:00:00Z' }, now);
    expect(result.ok).toBe(true);
    expect(scheduleTask).toHaveBeenCalledOnce();
  });

  it('a fresh fire pack preserves live cloud-created tasks until adoption', async () => {
    const task = makeTask(8, now + 3_600_000);
    const selfLog = appendSelfLogTask(createSelfLog(now - 120_000, null), task);
    const { stash, plan } = await start({ selfLog, builtAt: now - 60_000 });
    expect(stash.pendingTasks).toEqual([task]);
    expect(JSON.stringify(plan.messages)).toContain('00000008');
  });

  it('an offline self-scheduling chain releases already-fired predecessors', async () => {
    let selfLog: any;
    let task: any;
    for (let step = 0; step <= 6; step += 1) {
      const clock = now + step * 2 * 3_600_000;
      vi.mocked(Date.now).mockReturnValue(clock);
      const { ctx, stash, scheduleTask } = await start({ nowMs: clock, task, selfLog });
      const result = await runFireScheduleTool(stash, scheduleTask, {
        send_at: new Date(clock + 2 * 3_600_000).toISOString(),
      }, clock);
      if (step === 6) {
        expect(result.ok).toBe(true);
        expect(stash.pendingTaskCount).toBe(0);
        break;
      }
      expect(result.ok).toBe(true);
      const next = stash.scheduledTasks[0];
      const finish: any = await amsgHooks.onLLMOutput({
        ...ctx, iteration: 0, taskId: 1, metadata: ctx.task.metadata,
        sessionId: `chain-${step}`, llmOutputText: '晚点再和你聊。',
      });
      expect(finish.decision).toBe('finish');
      await amsgFireSettled({ status: 'sent', sentCount: 1, scratch: ctx.scratch, writeState: ctx.writeState });
      const entries = ctx.writeState.mock.calls.flatMap((call: any[]) => call[1]);
      selfLog = JSON.parse(entries.findLast((entry: any) => entry.key === AMSG_SELF_LOG_KEY).value);
      task = {
        id: step + 2, uuid: next.taskUuid, contactName: '角色', nextSendAt: next.firstSendTime,
        recurrenceType: 'none', metadata: scheduleTask.mock.calls[0][0].metadata,
      };
    }
  });

  it('self-scheduled children carry a compact no-chat input reference, even with a large template', async () => {
    const { ctx, stash, scheduleTask } = await start();
    stash.firePack.template = '完整角色历史'.repeat(120_000);
    const result = await runFireScheduleTool(stash, scheduleTask, { send_at: '2026-10-18T12:00:00Z' }, now);
    expect(result.ok).toBe(true);
    const child = scheduleTask.mock.calls[0][0];
    expect(new TextEncoder().encode(JSON.stringify(child)).length).toBeLessThan(10_000);
    const ref = parseInstantInputRef(child.taskInput?.firePackRef);
    expect(ref).not.toBeNull();
    if (!ref) throw new Error('Expected a valid immutable input reference');
    const input = ctx.writeState.mock.calls.flatMap((call: any[]) => call[1]).find((entry: any) => entry.key === ref.key);
    const pack = JSON.parse(await unpackStateValue(JSON.parse(input.value).packedFirePack));
    expect(pack.chat).toBeUndefined();
    expect(pack.template).toBe(stash.firePack.template);
  });

  it('a scheduled task with current shared context does not need its expired fallback input', async () => {
    const base = await start();
    const next = await start({ task: { ...base.ctx.task,
      metadata: { ...base.ctx.task.metadata, amsgInstantChat: false, amsgMode: 'auto', amsgTaskInstruction: '晚点问问近况' },
      taskInput: { firePackRef: { namespace: 'amsg:instant-input', key: uuid } },
    } });
    expect(next.plan.messages).toBeTruthy();
    expect(next.ctx.readState.mock.calls.every((call: any[]) => call[0] !== 'amsg:instant-input')).toBe(true);
  });

  it('a newly uploaded pack retains an unadopted task from the real scheduling hook', async () => {
    const first = await start();
    const result = await runFireScheduleTool(first.stash, first.scheduleTask, { send_at: '2026-10-18T12:00:00Z' }, now);
    expect(result.ok).toBe(true);
    await amsgFireSettled({ status: 'skipped', scratch: first.ctx.scratch, writeState: first.ctx.writeState });
    const entries = first.ctx.writeState.mock.calls.flatMap((call: any[]) => call[1]);
    const selfLog = JSON.parse(entries.findLast((entry: any) => entry.key === AMSG_SELF_LOG_KEY).value);
    expect(selfLog.tasks).toHaveLength(1);
    // A new client snapshot can arrive before that task's adoption payload is consumed.
    const next = await start({ selfLog, builtAt: now });
    expect(next.stash.pendingTasks).toHaveLength(1);
    expect(first.scheduleTask).toHaveBeenCalledOnce();
  });

  it('renew enforces the same ten-minute gap as schedule', async () => {
    const target = makeTask(9, now + 3_600_000);
    const neighbor = makeTask(10, now + 20 * 60_000);
    const { stash, ctx, scheduleTask } = await start({ pending: [target, neighbor], limits: { minSendGapMinutes: 10 } });
    const sendAt = new Date(now + 22 * 60_000).toISOString();
    const scheduled = await runFireScheduleTool(stash, scheduleTask, { send_at: sendAt }, now);
    expect(scheduled.ok).toBe(false);
    expect(scheduled.reason).toBe('min_gap');
    const renewed = await runFireRenewTool(stash, ctx, { task_id: target.taskUuid, send_at: sendAt }, now);
    expect(renewed.ok).toBe(false);
    expect(renewed.reason).toBe('min_gap');
    expect(ctx.renewTask).not.toHaveBeenCalled();
    // The in-flight pending view also keeps the old timestamp after a successful renewal.
    expect(stash.pendingTasks.find((task: any) => task.taskUuid === target.taskUuid).firstSendTime).toBe(target.firstSendTime);
  });

  it('a skipped one-off is taught to create a new task rather than renew a missing target', async () => {
    const expired = makeTask(11, now - 3_600_000);
    const text = buildAmsg2NoticesText([{
      id: `${expired.taskUuid}:${now - 3_600_000}`, charId, occurrenceMs: now - 3_600_000,
      mode: 'auto', recurrenceType: 'none', reason: 'declined', createdAt: now,
    } as any], 'Asia/Tokyo');
    expect(text).toContain('schedule_active_message');
    expect(text).not.toContain('renew_active_message');
    const { stash, ctx, plan } = await start({ chatMessages: [{ role: 'system', content: text }, { role: 'user', content: '晚点再说' }] });
    expect(JSON.stringify(plan.messages)).toContain('00000011');
    const result = await runFireRenewTool(stash, ctx, { task_id: '00000011', send_at: '2026-10-18T11:00:00Z' }, now);
    expect(result.ok).toBe(false);
    expect(ctx.renewTask).not.toHaveBeenCalled();
    expect(ctx.scheduleTask).not.toHaveBeenCalled();
  });

  it('a subsequent schedule call sees the renewed time and rejects a one-minute conflict', async () => {
    const target = makeTask(12, now + 60 * 60_000);
    const { stash, ctx, scheduleTask } = await start({ pending: [target], limits: { minSendGapMinutes: 10 } });
    expect((await runFireRenewTool(stash, ctx, {
      task_id: target.taskUuid, send_at: new Date(now + 90 * 60_000).toISOString(),
    }, now)).ok).toBe(true);
    const next = await runFireScheduleTool(stash, scheduleTask, {
      send_at: new Date(now + 91 * 60_000).toISOString(),
    }, now);
    expect(next.ok).toBe(false);
    expect(next.reason).toBe('min_gap');
    expect(scheduleTask).not.toHaveBeenCalled();
  });

  it('oversized XHS data uses an owner-scoped immutable attachment when the SDK supports it', async () => {
    const storeAttachment = vi.fn(async () => ({ version: 1 as const, namespace: 'amsg:attachments', key: 'unique-ref',
      taskUuid: uuid, occurrenceMs: now, expiresAt: now + 30 * 86_400_000 }));
    const xhsSession = { notes: [{ note: { desc: '正文'.repeat(3000) } }] };
    const output: any = await offloadOversizedPush({ message: '卡片', metadata: { amsgOccurrenceMs: now, xhsSession } },
      undefined, charId, 'client-task', 0, storeAttachment);
    expect(output.metadata.xhsSession).toBeUndefined();
    expect(output.metadata.xhsSessionAttachment).toMatchObject({ key: 'unique-ref', taskUuid: uuid, occurrenceMs: now });
    expect(storeAttachment).toHaveBeenCalledWith(JSON.stringify(xhsSession), { owner: { type: 'character', id: charId }, kind: 'sidechannel' });
  });

  it('the final output hook routes oversized reasoning through the SDK attachment writer', async () => {
    const { ctx } = await start();
    const ref = { version: 1, namespace: 'amsg:attachments', key: 'reasoning-unique', taskUuid: uuid,
      occurrenceMs: now, expiresAt: now + 30 * 86_400_000 };
    const storeAttachment = vi.fn(async () => ref);
    const output: any = await amsgHooks.onLLMOutput({ ...ctx, storeAttachment, taskId: 1,
      sessionId: 'attachment-session', iteration: 0, metadata: ctx.task.metadata, contactName: '角色',
      llmOutputText: '我在这里。', llmResponse: { choices: [{ message: {
        content: '我在这里。', reasoning_content: '想起今天的事。'.repeat(600),
      } }] },
    });
    expect(output.decision).toBe('finish');
    expect(output.pushPayloads[0].metadata.amsgReasoningAttachment).toEqual(ref);
    expect(storeAttachment).toHaveBeenCalledOnce();
  });

  it('two occurrences of a recurring task retain independent XHS sidechannel values', async () => {
    const state = new Map<string, string>();
    const writeState: any = async (_namespace: string, entries: any[]) => {
      for (const entry of entries) state.set(entry.key, entry.value);
      return { upserted: entries.length, skipped: 0, deleted: 0 };
    };
    const payload = (day: string) => {
      const notes = Array.from({ length: 8 }, (_, index) => ({
        noteId: `${day}-${index}`, title: '今天路过的一家小店，记下这个角落',
        desc: '店里的书和下午的阳光都很好，下次还想来坐一会儿。'.repeat(6),
        author: '旅行记录', authorId: `author-${index}`, likes: 32,
        coverUrl: `https://images.example.com/note-${index}.jpg`,
      }));
      const xhsSession = buildXhsSessionPayload(notes.map((_, index) => ({ type: 'xhs_share', idx: index + 1 })), notes, []);
      expect(xhsSession!.notes.every(item => item.note.desc.length <= 120)).toBe(true);
      return { message: `分享${day}的笔记`, metadata: {
        amsgOccurrenceMs: day === '第一天' ? now : now + 86_400_000, xhsSession,
      } };
    };
    const first: any = await offloadOversizedPush(payload('第一天'), writeState, charId, 'same-recurring-task');
    const second: any = await offloadOversizedPush(payload('第二天'), writeState, charId, 'same-recurring-task');
    expect(first.metadata.xhsSessionRef).not.toBe(second.metadata.xhsSessionRef);
    expect(first.metadata.xhsSessionRef).toBeTruthy();
    expect(JSON.parse(state.get(first.metadata.xhsSessionRef)!).notes[0].note.noteId).toBe('第一天-0');
  });
});
