// worker/amsg/src/plateFire.test.ts
// 后台任务（`metadata.amsgKind`）这条路的回归守卫。
//
// 这条路存在的意义就是「绕开聊天那一整套」，所以最该钉住的不是它做了什么，而是它
// **没被什么挡住**：聊天那四道门（活跃会话租约 / fire_pack 必须在场 / 防穿帮闸 /
// 任务指令必填）一道都不该拦它，onLLMOutput 的 stash 断言也不该拦它。分派点往后挪
// 一行，这些用例就会挂。
import { describe, it, expect, vi } from 'vitest';

import { amsgHooks } from './index';
import { AMSG_CHAT_PRESENCE_KEY } from '../../../utils/amsgChatPresence';
import { packStateValue } from '../../../utils/amsgFirePack';
import {
  PLATE_CONSOLIDATE_KIND,
  PLATE_CONSOLIDATE_RESULT_KIND,
  buildPlateJobInput,
  plateJobKey,
} from '../../../utils/amsgPlateJob';
import { AMSG_JOB_ID_KEY, AMSG_JOB_NAMESPACE, AMSG_TASK_KIND_KEY } from '../../../utils/amsgTaskKinds';
import { PLATE_LLM_TIMEOUT_MS } from '../../../utils/memoryPalace/roomPlateCore';

const CHAR_ID = 'preset-nyah';
const JOB_ID = 'job-0001';
const NOW = new Date('2026-08-15T12:00:00.000Z');

const jobInput = (overrides: Record<string, unknown> = {}) => buildPlateJobInput({
  charId: CHAR_ID,
  charName: 'Nyah',
  userName: '小明',
  identityContext: '（身份上下文）',
  rooms: [
    { room: 'user_room', entries: ['小明在读研'], entryIds: ['pe_a'] },
    { room: 'bedroom', entries: [], entryIds: [] },
  ],
  materials: [{ room: 'user_room', lines: ['小明这周搬去和同学合租了'] }],
  ...overrides,
} as any);

/**
 * 造一份跑门牌任务用的 ctx。
 * charRows 默认是**空的**——后台任务不传 fire_pack / tool_pack，这正是要钉的点。
 */
const makeCtx = (opts: {
  metadata?: Record<string, unknown>;
  jobValue?: string | null;
  charRows?: Array<{ key: string; value: string }>;
} = {}) => {
  const jobRows = opts.jobValue === null
    ? []
    : [{ key: plateJobKey(JOB_ID), value: opts.jobValue! }];
  const readState = vi.fn(async (namespace: string) => {
    if (namespace === AMSG_JOB_NAMESPACE) return jobRows;
    if (namespace.startsWith('amsg:char:')) return opts.charRows ?? [];
    return [];
  });
  const writeState = vi.fn(async () => ({ upserted: 1, skipped: 0, deleted: 1 }));
  const scratch: Record<string, unknown> = {};
  return {
    ctx: {
      task: {
        id: 7,
        uuid: 'task-uuid-plate',
        contactName: 'Nyah',
        recurrenceType: 'none',
        nextSendAt: NOW.toISOString(),
        metadata: {
          charId: CHAR_ID,
          [AMSG_TASK_KIND_KEY]: PLATE_CONSOLIDATE_KIND,
          [AMSG_JOB_ID_KEY]: JOB_ID,
          ...opts.metadata,
        },
      },
      userId: 'u1',
      readState,
      writeState,
      now: NOW,
      scratch,
    } as any,
    scratch,
    readState,
    writeState,
  };
};

const makeSessionCtx = (scratch: Record<string, unknown>, llmOutputText: string) => {
  const emitResult = vi.fn(async () => ({ messageId: 'm1', pushed: false }));
  const writeState = vi.fn(async () => ({ upserted: 0, skipped: 0, deleted: 1 }));
  return {
    ctx: {
      sessionId: 'sess-1',
      llmResponse: {},
      llmOutputText,
      contactName: 'Nyah',
      metadata: {},
      scratch,
      writeState,
      emitResult,
      taskId: 7,
      taskUuid: 'task-uuid-plate',
      occurrenceMs: NOW.getTime(),
    } as any,
    emitResult,
    writeState,
  };
};

const REPLY = JSON.stringify([
  { room: 'user_room', text: '小明在读研，最近搬去和同学合租', basedOn: 'U0', tag: '居住' },
]);

describe('门牌结果携带原始快照时间', () => {
  it('输入解析、生成与 emitResult 全程保留客户端快照时间', async () => {
    const snapshotAt = NOW.getTime() - 40 * 60_000;
    const { ctx, scratch } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput({ snapshotAt }))),
    });
    await amsgHooks.onBeforeFire(ctx);
    const session = makeSessionCtx(scratch, REPLY);
    await amsgHooks.onLLMOutput(session.ctx);
    expect(session.emitResult).toHaveBeenCalledWith(expect.objectContaining({ snapshotAt }));
  });
});

describe('后台任务分派：聊天那几道门一道都不该拦它', () => {
  it('没有 fire_pack 也照跑（聊天那条路在这儿是硬失败）', async () => {
    const { ctx } = makeCtx({ jobValue: await packStateValue(JSON.stringify(jobInput())) });
    const result = await amsgHooks.onBeforeFire(ctx) as { messages: Array<{ role: string; content: string }> };

    expect(result).toHaveProperty('messages');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('system');
    // 提示词确实是门牌那份（现有条目带标签、新材料在里面）
    expect(result.messages[0].content).toContain('[U0] 小明在读研');
    expect(result.messages[0].content).toContain('小明这周搬去和同学合租');
  });

  it('用户正在聊天（活跃会话租约新鲜）也照跑——后台整理不发消息，不用让路', async () => {
    const presence = JSON.stringify({
      v: 1, charId: CHAR_ID, activeAt: NOW.getTime(), lastUserMessageAt: NOW.getTime(),
    });
    const { ctx } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
      charRows: [{ key: AMSG_CHAT_PRESENCE_KEY, value: presence }],
      metadata: { amsgExpirePolicy: 'expire' },
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(result).toHaveProperty('messages');
  });

  it('没有 amsgTaskInstruction 也照跑（那是主动消息才要的东西）', async () => {
    const { ctx } = makeCtx({ jobValue: await packStateValue(JSON.stringify(jobInput())) });
    expect(ctx.task.metadata.amsgTaskInstruction).toBeUndefined();
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toHaveProperty('messages');
  });

  it('不认识的 kind 硬失败，报错里说得出该干什么', async () => {
    const { ctx } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
      metadata: { [AMSG_TASK_KIND_KEY]: 'something-new' },
    });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/不认识的任务种类.*重新部署/s);
  });

  it('没标 kind 的任务照旧走聊天主干（存量任务一条都不受影响）', async () => {
    const { ctx } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
      metadata: { [AMSG_TASK_KIND_KEY]: undefined },
    });
    // 走聊天主干 → 撞上「云端没有这个角色的 fire_pack」那道门
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/fire_pack/);
  });
});

describe('门牌整理 handler', () => {
  it('输入过期（job 行不在了）→ 安静跳过，不算失败', async () => {
    const { ctx } = makeCtx({ jobValue: null });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  it('输入形状坏了 → 硬失败（别拿半份材料整理出缺东西的门牌）', async () => {
    const { ctx } = makeCtx({ jobValue: await packStateValue('{"v":99}') });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/解析失败/);
  });

  it('这次 fire 的超时跟浏览器那条路对齐', async () => {
    const { ctx } = makeCtx({ jobValue: await packStateValue(JSON.stringify(jobInput())) });
    const result = await amsgHooks.onBeforeFire(ctx) as { totalTimeoutMs?: number };

    expect(result.totalTimeoutMs, '不交上去就落到库自己的四分钟默认值，改那个常量对云端毫无影响')
      .toBe(PLATE_LLM_TIMEOUT_MS);
  });

  // 回归守卫：beforeFire 认定「这份输入坏了」时原先只抛错，行留着。那几种失败是确定性的
  // （解压不出来、形状对不上、charId 对不上号），重试梯子再跑两遍还是同一份坏数据——行就
  // 这么在共用命名空间里躺满三天 TTL。而每一行都是一个角色的整块门牌原文 + 蒸馏材料 +
  // 身份上下文，且每次后台 fire 都要把整个命名空间读出来解密才能挑出自己那一行。
  describe('确定性的坏输入，认定的同时就把那行删掉', () => {
    const discarded = (writeState: ReturnType<typeof vi.fn>) =>
      expect(writeState).toHaveBeenCalledWith(
        AMSG_JOB_NAMESPACE, [{ key: plateJobKey(JOB_ID), value: null }],
      );

    it('解压不出来（数据损坏）', async () => {
      const { ctx, writeState } = makeCtx({ jobValue: 'gz1:这不是合法的压缩数据' });
      await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/解压失败/);
      discarded(writeState);
    });

    it('形状对不上', async () => {
      const { ctx, writeState } = makeCtx({ jobValue: await packStateValue('{"v":99}') });
      await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/解析失败/);
      discarded(writeState);
    });

    it('charId 跟任务对不上', async () => {
      const { ctx, writeState } = makeCtx({
        jobValue: await packStateValue(JSON.stringify(jobInput({ charId: 'someone-else' }))),
      });
      await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/charId 与任务对不上/);
      discarded(writeState);
    });

    it('一个要整理的房间都没有', async () => {
      const { ctx, writeState } = makeCtx({
        jobValue: await packStateValue(JSON.stringify(jobInput({ rooms: [] }))),
      });
      await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
      discarded(writeState);
    });
  });

  it('跑完把结果送进收件箱、不弹通知，并删掉一次性输入', async () => {
    const { ctx: fireCtx, scratch } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
    });
    await amsgHooks.onBeforeFire(fireCtx);

    const { ctx, emitResult, writeState } = makeSessionCtx(scratch, REPLY);
    const decision = await amsgHooks.onLLMOutput(ctx);

    expect(decision).toEqual({ decision: 'skip-push', reason: 'plate-result-emitted' });
    expect(emitResult).toHaveBeenCalledTimes(1);
    const payload = (emitResult.mock.calls[0] as unknown as [any])[0];
    expect(payload.resultKind).toBe(PLATE_CONSOLIDATE_RESULT_KIND);
    expect(payload.charId).toBe(CHAR_ID);
    expect(payload.items).toHaveLength(1);
    // 背景工作不该把人叫回来看；show:false 时上游只落收件箱、不发推送。
    expect(payload.notification).toEqual({ show: false });
    // 提交时的条目 id 快照原样回传——客户端靠它把 basedOn 重新对准当前条目。
    expect(payload.rooms).toEqual([
      { room: 'user_room', entryIds: ['pe_a'] },
      { room: 'bedroom', entryIds: [] },
    ]);
    // 一次性输入跑完就删
    expect(writeState).toHaveBeenCalledWith(
      AMSG_JOB_NAMESPACE, [{ key: plateJobKey(JOB_ID), value: null }],
    );
  });

  it('LLM 一条都没吐出来 → 不送空结果（空列表会被客户端当成「清空门牌」）', async () => {
    const { ctx: fireCtx, scratch } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
    });
    await amsgHooks.onBeforeFire(fireCtx);

    const { ctx, emitResult, writeState } = makeSessionCtx(scratch, '模型今天不想说话');
    const decision = await amsgHooks.onLLMOutput(ctx);

    expect(decision).toEqual({ decision: 'skip-push', reason: 'plate-empty-generation' });
    expect(emitResult).not.toHaveBeenCalled();
    // 一次性输入照样得删：上游把 skip-push 当办完了（status: 'skipped'），这条
    // recurrenceType: 'none' 的任务再没有第二次机会来读它。留着就是一行没人认领的
    // 孤儿，装着整块门牌原文 + 材料 + 身份上下文，一直占到 TTL。
    expect(writeState, '不删的话每次失败留一行，而 beforeFire 每跳都要把这个命名空间整个读出来解密')
      .toHaveBeenCalledWith(AMSG_JOB_NAMESPACE, [{ key: plateJobKey(JOB_ID), value: null }]);
  });

  // 模型回了东西却一条都解析不出来时，日志里得看得出它回了个什么（被截断？空的？格式跑偏？）。
  it('一条都没解析出来 → 记一行跳过诊断，reason 是 plate-empty-generation', async () => {
    const { ctx: fireCtx, scratch } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
    });
    await amsgHooks.onBeforeFire(fireCtx);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx } = makeSessionCtx(scratch, '模型今天不想说话');
    ctx.llmResponse = { choices: [{ finish_reason: 'length', message: { content: '模型今天不想说话' } }] };
    await amsgHooks.onLLMOutput(ctx);

    const diag = warn.mock.calls.find(([tag]) => tag === '[amsg:skip-diag]')?.[1];
    warn.mockRestore();
    expect(diag, '门牌整理空跑时也该留一行诊断').toMatchObject({
      reason: 'plate-empty-generation', finishReason: 'length', contentChars: 8,
    });
  });

  // 回归守卫：kind 是从任务 metadata 上读出来的字符串。handler 表要是普通对象字面量，
  // `constructor` / `toString` 这些原型链上的键会解析成一个真值，绕过「表里没有这个
  // kind」那道判断，最后炸在 `handler.beforeFire is not a function` 上——那句报错跟真正
  // 的原因（这台 worker 不认识这种任务）毫无关系，排障要多绕一大圈。
  it.each(['constructor', 'toString', 'valueOf', '__proto__'])(
    'kind=%s 走「不认识的任务种类」，不是一句无关的报错',
    async (kind) => {
      const { ctx } = makeCtx({ metadata: { [AMSG_TASK_KIND_KEY]: kind } });
      await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/不认识的任务种类/);
    },
  );

  // 删角色时客户端会把这份输入写成空壳（HTTP 的 PUT /client-state 没有删除语义）。
  // 空壳解析不出来，当「数据损坏」硬失败的话，一个已经被删掉的角色还要把重试梯子走完。
  it('输入被撤销（行还在但值是空的）→ 跟过期一样安静跳过', async () => {
    const { ctx } = makeCtx({ jobValue: '' });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  it('老 worker 没有 emitResult → 说清楚原因，不静默', async () => {
    const { ctx: fireCtx, scratch } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
    });
    await amsgHooks.onBeforeFire(fireCtx);

    const { ctx, writeState } = makeSessionCtx(scratch, REPLY);
    delete (ctx as any).emitResult;
    await expect(amsgHooks.onLLMOutput(ctx)).resolves.toEqual({
      decision: 'skip-push', reason: 'plate-emit-result-unsupported',
    });
    // 这台 worker 永远送不回结果，留着那行也没人会来读
    expect(writeState).toHaveBeenCalledWith(
      AMSG_JOB_NAMESPACE, [{ key: plateJobKey(JOB_ID), value: null }],
    );
  });

  // 回归守卫：方法在、调用炸了（收件箱表缺列——升级 worker 不跑 init-tenant 就这样）。
  // 抛出去的话这一轮算失败，重试梯子会**再跑两次完整生成**：LLM 已经烧过一次，后两次
  // 注定同样送不回来。就地收成跳过，只白跑一次。
  it('emitResult 调用抛错 → 就地收成跳过，不把整轮判失败去重试', async () => {
    const { ctx: fireCtx, scratch } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
    });
    await amsgHooks.onBeforeFire(fireCtx);

    const { ctx, emitResult, writeState } = makeSessionCtx(scratch, REPLY);
    emitResult.mockRejectedValueOnce(new Error('no such column: push_payload'));

    await expect(amsgHooks.onLLMOutput(ctx)).resolves.toEqual({
      decision: 'skip-push', reason: 'plate-emit-result-failed',
    });
    // 结果虽然没送出去，一次性输入照样得删：这一轮已经被上游当办完了，没人会再读它
    expect(writeState).toHaveBeenCalledWith(
      AMSG_JOB_NAMESPACE, [{ key: plateJobKey(JOB_ID), value: null }],
    );
  });
});

describe('worker config', () => {
  it('一次性输入那个命名空间配了 TTL，角色状态那个没配', async () => {
    const { buildWorkerConfig } = await import('./index');
    const config = buildWorkerConfig({
      DB: { prepare: () => {} },
      AMSG_MASTER_KEY: 'k'.repeat(64),
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
    } as any) as any;

    expect(config.clientStateTtl).toEqual({ [AMSG_JOB_NAMESPACE]: 3, 'amsg:instant-input': 30 });
    // 角色状态（fire_pack / tool_pack）绝不能配 TTL——配了就是定时把角色的云端状态抹掉
    expect(Object.keys(config.clientStateTtl)).not.toContain('amsg:char:');
  });
});
