// worker/amsg/src/index.test.ts
// onBeforeFire 的四道门 —— 这个功能最关键的决策路径，一个判断写错位就是「该拦的没拦」
// 或者「全都不发」。门的顺序本身也是行为的一部分（注释里专门写过），一起钉住。
//
// 顺序：charId 校验 → 活跃会话租约(skip) → fire_pack 存在(否则抛) → 防穿帮闸(skip)
//      → 任务指令存在(否则抛) → 挂 scratch + 填槽返回
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';

import worker, {
  amsgFireSettled, amsgHooks, amsgReasoningKey, amsgStaleSkip, attachScheduledTasks,
  buildWorkerConfig, configureInstantErrorPush, inspectWorkerEnv,
  offloadOversizedPush, resolveVapidEmail, runFireCancelTool, runFireRenewTool,
  inspectPushDelivery,
  isWakeNowAuthorized, parseWakeNowRequest,
  runFireScheduleTool, runMcpFireTool, splitSchemaMissing, classifySchemaProbeError,
} from './index';
import * as workerEntry from './index';
import { MAX_TOOL_ITERATIONS } from './agentic';
import { MAX_PUSH_PAYLOAD_BYTES } from '@rei-standard/amsg-server/cloudflare';
import { amsgEmotionUpdateKey, EMOTION_EVAL_RIDE_ALONG_MS } from './emotionEval';
import { INSTANT_TOTAL_TIMEOUT_MS } from './instantChat';
import {
  AMSG_CHAT_FAIL_KEY,
  AMSG_FIRE_PACK_KEY,
  AMSG_LAST_SKIP_KEY,
  AMSG_SELF_LOG_KEY,
  AMSG_SLOT_CURRENT_TIME,
  AMSG_SLOT_SELF_LOG,
  AMSG_SLOT_TASK_INSTRUCTION,
  AMSG2_INSTANT_STUB_TEMPLATE,
  amsgStateNamespace,
  amsgXhsSessionKey,
  appendSelfLogEntry,
  createSelfLog,
  FIRE_PACK_VERSION,
  packStateValue,
  parseSelfLog,
  SELF_LOG_MAX_ENTRIES,
} from '../../../utils/amsgFirePack';
import { AMSG_CHAT_PRESENCE_KEY } from '../../../utils/amsgChatPresence';
import { AMSG_TOOL_CONFIG_KEY, AMSG_TOOL_PACK_KEY } from '../../../utils/amsgToolPack';
import { buildMcpNameMap, MCP_FIRE_NAME_BUDGET, type McpFireServer } from '../../../utils/mcpFireCore';
import { MAX_FIRE_SCHEDULES } from '../../../utils/amsgFireSchedule';
import { MAX_ACTIVE_TASKS_PER_CHAR, shortTaskId } from '../../../utils/amsg2Tasks';
import { isAmsgServerVersionAtLeast } from '../../../utils/amsgWorkerVersion';

const CHAR_ID = 'preset-nyah';
const TASK_UUID = '3637dae1-1461-4444-a747-34e406f67acc';
const NOW = new Date('2026-07-25T12:00:00.000Z');

const PACK_BUILT_AT = Date.parse('2026-07-25T09:00:00.000Z');

const firePackValue = (
  lastUserMessageAt: number | null = null,
  extra: Record<string, unknown> = {},
) => JSON.stringify({
  // 版本跟着 amsgFirePack 走：升版是前端 + worker 一起动的事，测试跟着走就行。
  v: FIRE_PACK_VERSION,
  template: `现在是 ${AMSG_SLOT_CURRENT_TIME}。\n${AMSG_SLOT_TASK_INSTRUCTION}`,
  lastUserMessageAt,
  tzId: 'Asia/Shanghai',
  userTzId: 'Asia/Shanghai',
  targetName: '小明',
  builtAt: PACK_BUILT_AT,
  pendingTasks: [],
  scene: null,
  selfScheduleEnabled: true,
  ...extra,
});

const presenceValue = (
  activeAt: number,
  opts: { lastUserMessageAt?: number | null; charId?: string } = {},
) => JSON.stringify({
  v: 1,
  charId: opts.charId ?? CHAR_ID,
  activeAt,
  lastUserMessageAt: opts.lastUserMessageAt === undefined ? activeAt : opts.lastUserMessageAt,
});

// tool_pack / tool_config 与 fire_pack 同批原子上传，所以默认造齐——缺任何一份都是
// 云端状态异常，走抛错路径（见下面「缺 tool_pack → 抛错」那条）。
const toolPackValue = JSON.stringify({
  v: 1, charName: 'Nyah', xhsEnabled: false, activeMemoryMonths: [], memories: [],
  timeAwarenessEnabled: true,
});
const toolConfigValue = JSON.stringify({
  v: 1, proxyWorkerUrl: '', weatherEnabled: false, newsEnabled: false,
  notionEnabled: false, feishuEnabled: false,
});

/** 带一台通用 MCP 服务器的 tool_config（extra 用来改开关 / 服务器可见范围）。 */
const mcpToolConfigValue = (extra: Record<string, unknown> = {}) => JSON.stringify({
  v: 1, proxyWorkerUrl: '', newsEnabled: false, notionEnabled: false, feishuEnabled: false,
  mcpServers: [{
    id: 'srv-memory',
    name: '记忆库',
    url: 'https://mcp.example.com/mcp',
    tools: [{
      name: 'search_memory',
      description: '按关键词查记忆',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    }],
  }],
  ...extra,
});

/** 造一个 FireCtx；rows 是 readState 按 namespace 返回的内容。 */
const makePromptAuditDb = (initialRows: any[] = []) => {
  const auditRows = [...initialRows];
  const exec = async (sql: string, values: unknown[] = []) => {
    if (sql.includes('INSERT INTO prompt_audit_log')) {
      const [
        id, createdAt, expiresAt, charId, charName, taskUuid, taskRowId, clientTaskId,
        occurrenceMs, status, model, prompt, promptControlsJson, promptModulesJson,
        roundsJson, usageJson, outputText, error,
      ] = values;
      const row = {
        id, created_at: createdAt, expires_at: expiresAt, char_id: charId,
        char_name: charName, task_uuid: taskUuid, task_row_id: taskRowId,
        client_task_id: clientTaskId, occurrence_ms: occurrenceMs, status, model,
        prompt, prompt_controls_json: promptControlsJson, prompt_modules_json: promptModulesJson,
        rounds_json: roundsJson, usage_json: usageJson, output_text: outputText, error,
      };
      const index = auditRows.findIndex((item) => item.id === id);
      if (index >= 0) auditRows[index] = row;
      else auditRows.push(row);
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes('DELETE FROM prompt_audit_log')) {
      const deleted = sql.includes('WHERE expires_at <= ?')
        ? auditRows.filter((row) => Number(row.expires_at) <= Number(values[0])).length
        : auditRows.length;
      if (sql.includes('WHERE expires_at <= ?')) {
        const cutoff = Number(values[0]);
        for (let i = auditRows.length - 1; i >= 0; i -= 1) {
          if (Number(auditRows[i].expires_at) <= cutoff) auditRows.splice(i, 1);
        }
      } else {
        auditRows.length = 0;
      }
      return { success: true, meta: { changes: deleted } };
    }
    if (sql.includes('SELECT id, created_at')) {
      const limit = Number(values[0]) || 20;
      return { results: auditRows.slice(0, limit).map((row) => ({ ...row })) };
    }
    if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) {
      return { success: true, meta: { changes: 0 } };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  return {
    auditRows,
    prepare(sql: string) {
      return {
        bind: (...values: unknown[]) => ({
          first: async () => exec(sql, values),
          all: async () => exec(sql, values),
          run: async () => exec(sql, values),
        }),
        first: async () => exec(sql, []),
        all: async () => exec(sql, []),
        run: async () => exec(sql, []),
      };
    },
  };
};

const makeCtx = (opts: {
  metadata?: Record<string, unknown>;
  charRows?: Array<{ key: string; value: string }>;
  globalRows?: Array<{ key: string; value: string }>;
  recurrenceType?: string;
  nextSendAt?: string | null;
  /** 写不进 client_state 时的样子：跳过原因写失败不该连累这次 skip。 */
  writeStateFails?: boolean;
}) => {
  const charRows = opts.charRows ?? [
    { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
    { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
  ];
  const globalRows = opts.globalRows ?? [{ key: AMSG_TOOL_CONFIG_KEY, value: toolConfigValue }];
  const readState = vi.fn(async (namespace: string) =>
    namespace.startsWith('amsg:char:') ? charRows : globalRows);
  const writeState = vi.fn(async (
    _namespace: string,
    _entries: Array<{ key: string; value: string | null }>,
  ) => {
    if (opts.writeStateFails) throw new Error('write failed');
    return { upserted: 1, skipped: 0, deleted: 0 };
  });
  const scratch: Record<string, unknown> = {};
  return {
    ctx: {
      task: {
        id: 42,
        uuid: TASK_UUID,
        contactName: 'Nyah',
        recurrenceType: opts.recurrenceType ?? 'none',
        nextSendAt: opts.nextSendAt ?? '2026-07-25T12:00:00.000Z',
        metadata: {
          charId: CHAR_ID,
          amsgExpirePolicy: 'expire',
          amsgTaskInstruction: '问问对方吃了没',
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

/** onBeforeFire 生成路径的返回值：{ messages, tools? }（skip 那一支各测各的）。 */
interface FiredResult {
  messages: Array<{ role: string; content: string }>;
  tools?: Array<{ function: { name: string; parameters: unknown } }>;
}

/** 取生成路径的返回值；顺手确认没退回 skip / null，省得每条用例各自强转。 */
const fired = (result: unknown): FiredResult => {
  expect(result, '生成路径应该返回 { messages, tools? }').toHaveProperty('messages');
  return result as FiredResult;
};

const FIRE_TASK_ID = 42;
const FIRE_NEXT_SEND_AT = '2026-07-25T12:00:00.000Z';

/**
 * 会记账的 client_state 夹具：readState / writeState 打在同一个 Map 上，
 * 这一轮写进去的东西下一轮读得到（outbox 累积、self_log 回写这些都要它）。
 *
 * 给了 chatMessages 就是即时对话那种 fire_pack（带 chat 段），不给就是定时任务那种。
 */
const makeFireStore = (chatMessages?: Array<{ role: string; content: unknown }>) => {
  const rows = new Map<string, string>([
    [AMSG_FIRE_PACK_KEY, firePackValue(null, chatMessages
      ? { chat: { messages: chatMessages, builtAt: PACK_BUILT_AT } }
      : {})],
    [AMSG_TOOL_PACK_KEY, toolPackValue],
  ]);
  const readState = vi.fn(async (namespace: string) => (
    namespace.startsWith('amsg:char:')
      ? [...rows].map(([key, value]) => ({ key, value }))
      : [{ key: AMSG_TOOL_CONFIG_KEY, value: toolConfigValue }]
  ));
  const writeState = vi.fn(async (
    _namespace: string,
    entries: Array<{ key: string; value: string | null }>,
  ) => {
    for (const entry of entries) {
      if (entry.value === null) rows.delete(entry.key);
      else rows.set(entry.key, entry.value);
    }
    return { upserted: entries.length, skipped: 0, deleted: 0 };
  });
  return { rows, readState, writeState };
};

/**
 * 完整跑一次 fire：onBeforeFire → onLLMOutput。
 *
 * metadata 一并交还，而且**两个 hook 收到的是同一个对象引用**——上游就是这么传的
 * （见 chunk-RRWCPPOY 的 buildHookTask 浅拷贝），照搬才验得出「就地删凭据」那类行为。
 */
const runFire = async (
  store: ReturnType<typeof makeFireStore>,
  opts: {
    metadata: Record<string, unknown>;
    llmOutput: string;
    /** 整个响应体；把思考放在 reasoning_content 字段的模型（deepseek-r1 那类）用它塞。 */
    llmResponse?: Record<string, unknown>;
    /** 同一个 store 连跑几轮时换一下，messageId 才跟着变。 */
    taskId?: number;
    sessionId?: string;
  },
) => {
  const scratch: Record<string, unknown> = {};
  const metadata = { charId: CHAR_ID, ...opts.metadata };
  const taskId = opts.taskId ?? FIRE_TASK_ID;
  await amsgHooks.onBeforeFire({
    task: {
      id: taskId, uuid: TASK_UUID, contactName: 'Nyah', recurrenceType: 'none',
      nextSendAt: FIRE_NEXT_SEND_AT, metadata,
    },
    userId: 'u1',
    readState: store.readState,
    writeState: store.writeState,
    now: NOW,
    scratch,
  } as any);
  const decision = await amsgHooks.onLLMOutput({
    sessionId: opts.sessionId ?? `sess_task_${taskId}@1`, taskId, taskUuid: TASK_UUID,
    llmResponse: opts.llmResponse ?? {}, llmOutputText: opts.llmOutput, contactName: 'Nyah',
    metadata, scratch, writeState: store.writeState,
  } as any) as any;
  return { decision, metadata, scratch };
};

describe('Worker 入口的具名导出', () => {
  /**
   * 回归守卫：入口不能导出数字 / 字符串这类原始值。
   *
   * Worker 入口模块的具名导出会被 workerd 当成「命名入口点」——Durable Object 和
   * WorkerEntrypoint 的类就是靠这个认出来的——所以每一个都得是函数（类也是函数）或者
   * ExportedHandler 那样的对象。从入口顺手导出一个数字常量（给测试用的那种），
   * 整个 Worker 直接起不来：`Incorrect type for map entry '<导出名>':
   * the provided value is not of type 'function or ExportedHandler'`。
   * 而这事儿只有真跑 workerd 才看得见，单测和 tsc 全绿，`wrangler dev` 一开才炸。
   *
   * 常量一律住在别的模块里（先例：EMOTION_EVAL_RIDE_ALONG_MS 在 ./emotionEval）。
   */
  it('没有原始值——导出一个数字常量就够让整个 Worker 起不来', () => {
    const offenders = Object.entries(workerEntry)
      .filter(([name]) => name !== 'default')
      .filter(([, value]) => typeof value !== 'function' && (typeof value !== 'object' || value === null))
      .map(([name, value]) => `${name}: ${typeof value}`);
    expect(offenders).toEqual([]);
  });
});

describe('onBeforeFire 四道门', () => {
  it('正常路径：填好槽返回 prompt，并把工具状态挂上 scratch', async () => {
    const { ctx, scratch } = makeCtx({});
    const result = await amsgHooks.onBeforeFire(ctx);

    const messages = fired(result).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    // 槽位必须被填掉，不能把 {{AMSG_*}} 原样发给 LLM
    expect(messages[0].content).not.toContain(AMSG_SLOT_CURRENT_TIME);
    expect(messages[0].content).not.toContain(AMSG_SLOT_TASK_INSTRUCTION);
    expect(messages[0].content).toContain('问问对方吃了没');
    // scratch.fire 必须在返回 messages 之前挂好——onLLMOutput / executeToolCalls 全靠它
    expect(scratch.fire).toBeTruthy();
    expect((scratch.fire as any).occurrenceMs).toBe(Date.parse('2026-07-25T12:00:00.000Z'));
  });

  it('活跃会话租约新鲜 → skip，而且排在 fire_pack 检查之前（缺 fire_pack 也照样 skip）', async () => {
    const { ctx } = makeCtx({
      // 故意不给 fire_pack：如果 presence 门被挪到后面，这里会变成抛错而不是 skip
      charRows: [{ key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 5_000) }],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  it('force 策略不吃活跃租约这道门（闹钟型照发）', async () => {
    const { ctx } = makeCtx({
      metadata: { amsgExpirePolicy: 'force' },
      charRows: [
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 5_000) },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(fired(result).messages).toHaveLength(1);
  });

  it('租约过期（超 TTL）不拦', async () => {
    const { ctx } = makeCtx({
      charRows: [
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 120_000) },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(fired(result).messages).toHaveLength(1);
  });

  it('防穿帮闸：一次性任务在锚点之后有新用户消息 → skip', async () => {
    const anchor = NOW.getTime() - 3600_000;
    const { ctx } = makeCtx({
      metadata: { amsgAnchorMs: anchor },
      // fire_pack 里的 lastUserMessageAt 晚于锚点 = 排程后用户又说话了
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(anchor + 60_000) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  // presence 行是每轮聊天一开场就写的小值，几十字节就发完了；fire_pack 是整包几十 KB，
  // 同样是打脏即发，但传完总要慢一截。只看 fire_pack 的话，用户刚说完话、包还在路上的
  // 那几秒里任务照发，正撞在对话上。
  it('防穿帮闸：presence 记的用户开口时刻比 fire_pack 新 → 用新的那份判，作废', async () => {
    const anchor = NOW.getTime() - 3600_000;
    const { ctx } = makeCtx({
      metadata: { amsgAnchorMs: anchor },
      charRows: [
        // 租约本身已经过期（不吃第一道门），但它记着的「最后一条用户消息」仍然算数
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 120_000, { lastUserMessageAt: anchor + 60_000 }) },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(anchor - 60_000) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  it('防穿帮闸：presence 是别的角色的 → 不拿来当锚点材料', async () => {
    const anchor = NOW.getTime() - 3600_000;
    const { ctx } = makeCtx({
      metadata: { amsgAnchorMs: anchor },
      charRows: [
        {
          key: AMSG_CHAT_PRESENCE_KEY,
          value: presenceValue(NOW.getTime() - 120_000, { lastUserMessageAt: anchor + 60_000, charId: 'other-char' }),
        },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(anchor - 60_000) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(fired(result).messages).toHaveLength(1);
  });

  it('防穿帮闸：锚点之后没有新用户消息 → 照发', async () => {
    const anchor = NOW.getTime() - 3600_000;
    const { ctx } = makeCtx({
      metadata: { amsgAnchorMs: anchor },
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(anchor - 60_000) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(fired(result).messages).toHaveLength(1);
  });

  // ─── 不降级：状态不完整一律抛错，不再退回排程时冻结的 prompt ───

  it('云端没有 fire_pack → 抛错（不降级）', async () => {
    const { ctx } = makeCtx({ charRows: [] });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/AMSG2_FIRE_STATE_MISSING/);
  });

  // 这批失败是确定性的状态问题，重试三次只是让等回复的用户白等六分钟。
  // permanent: true 是上游 isNonRetryableError 认的鸭子契约 → 直接终审处置。
  it('状态类失败标 permanent，上游不再走重试阶梯', async () => {
    const { ctx } = makeCtx({ charRows: [] });
    const error = await amsgHooks.onBeforeFire(ctx).then(() => null, (e: unknown) => e);
    expect((error as { permanent?: boolean }).permanent).toBe(true);
  });

  it('fire_pack 解析失败 → 抛错（不降级）', async () => {
    const { ctx } = makeCtx({ charRows: [{ key: AMSG_FIRE_PACK_KEY, value: '{"v":1,"template":"老格式"}' }] });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/AMSG2_FIRE_STATE_MISSING/);
  });

  // ─── 闸跳过时留一句原因 ───
  //
  // 闸判定该让路就直接跳过，一条 push 都不发，而远端那行任务照样被消费掉——客户端事后
  // 看到的跟「发出去了但没收到」一模一样，用户只会觉得功能坏了。这几条钉住那句解释。

  it('用户正在聊天被拦下 → 写下原因，说明是让路了', async () => {
    const { ctx, writeState } = makeCtx({
      charRows: [
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 5_000) },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });

    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(call, '应该写过 last_skip').toBeTruthy();
    const skip = JSON.parse(String(call![1][0].value));
    expect(skip.reason).toBe('active-chat-presence');
    expect(skip.taskUuid).toBe(TASK_UUID);
  });

  it('对话已经聊到别处被作废 → 原因写成另一种，两者能分开', async () => {
    const anchor = NOW.getTime() - 3600_000;
    const { ctx, writeState } = makeCtx({
      metadata: { amsgAnchorMs: anchor },
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(anchor + 60_000) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });

    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(JSON.parse(String(call![1][0].value)).reason).toBe('conversation-moved-on');
  });

  it('正常触发不留跳过记录（别让上一次的解释赖着不走）', async () => {
    const { ctx, writeState } = makeCtx({});
    await amsgHooks.onBeforeFire(ctx);
    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(call).toBeUndefined();
  });

  it('原因写失败照样把这次拦下来——闸的效果不能取决于能不能写日志', async () => {
    const { ctx } = makeCtx({
      writeStateFails: true,
      charRows: [
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 5_000) },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  // ─── 值压缩：前端压过的 fire_pack 要能读出来，没压过的老数据也要照常读 ───

  it('前端压过的 fire_pack 照常读出来', async () => {
    // 真实的 fire_pack 是几万字的角色设定加聊天记录，这里也得凑到那个量级：
    // 太短的内容压完反而更大，packStateValue 会按设计原样返回、测不到解压路径。
    const bulky = JSON.stringify({
      ...JSON.parse(firePackValue()),
      template: `${'【角色系统设定】你是一个会在深夜突然想起对方的人。\n'.repeat(400)}`
        + `现在是 ${AMSG_SLOT_CURRENT_TIME}。\n${AMSG_SLOT_TASK_INSTRUCTION}`,
    });
    const packed = await packStateValue(bulky);
    expect(packed.startsWith('gz1:'), '这个量级应该压得动').toBe(true);
    const { ctx } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: packed },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const messages = fired(await amsgHooks.onBeforeFire(ctx)).messages;
    expect(messages[0].content).toContain('问问对方吃了没');
    expect(messages[0].content).not.toContain(AMSG_SLOT_CURRENT_TIME);
  });

  it('压过的值坏掉 → 抛错，不拿半截内容当 prompt 发出去', async () => {
    const { ctx } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: 'gz1:bm90LWd6aXAtYXQtYWxs' },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/AMSG2_FIRE_STATE_MISSING/);
  });

  it('前端压过的 tool_pack 照常读出来（带几条月度总结就到压缩量级）', async () => {
    // 空记忆的 tool_pack 一百来字节、压完反而更大，packStateValue 会原样放行；
    // 攒了几条月度总结的角色轻松过千字节、必然被压——正是活跃用户的常态形状。
    const months = ['2026-05', '2026-06', '2026-07'];
    const bulky = JSON.stringify({
      ...JSON.parse(toolPackValue),
      activeMemoryMonths: months,
      memories: months.map((date) => ({
        date,
        summary: '这个月聊了很多工作上的压力，也一起看了两场电影，月底约好下次去海边散心。'.repeat(3),
      })),
    });
    const packed = await packStateValue(bulky);
    expect(packed.startsWith('gz1:'), '这个量级应该压得动').toBe(true);
    const { ctx, scratch } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: packed },
      ],
    });
    fired(await amsgHooks.onBeforeFire(ctx));
    // 光不抛错不够：得确认解出来的是真数据（recall 按这些月份找总结全靠它）
    expect((scratch.fire as any).toolCtx.char.activeMemoryMonths).toEqual(months);
  });

  it('压过的 tool_pack 坏掉 → 抛错（和 fire_pack 同款语义，不降级成无工具数据）', async () => {
    const { ctx } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: 'gz1:bm90LWd6aXAtYXQtYWxs' },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/AMSG2_FIRE_STATE_MISSING/);
  });

  it('压过的 tool_config 也照常读出来（今天前端没压它，但读侧不该赌客户端压哪份）', async () => {
    const bulky = mcpToolConfigValue({
      mcpServers: [{
        id: 'srv-memory',
        name: '记忆库',
        url: 'https://mcp.example.com/mcp',
        tools: [{
          name: 'search_memory',
          description: '按关键词在长期记忆库里检索过往对话的要点，返回最相关的几条。'.repeat(8),
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        }],
      }],
    });
    const packed = await packStateValue(bulky);
    expect(packed.startsWith('gz1:'), '这个量级应该压得动').toBe(true);
    const { ctx, scratch } = makeCtx({
      globalRows: [{ key: AMSG_TOOL_CONFIG_KEY, value: packed }],
    });
    fired(await amsgHooks.onBeforeFire(ctx));
    expect((scratch.fire as any).mcpResolve.get('search_memory').toolName).toBe('search_memory');
  });

  it('云端没有 tool_pack → 抛错（和 fire_pack 同批上传，缺了就是状态异常，不给空壳继续）', async () => {
    const { ctx } = makeCtx({ charRows: [{ key: AMSG_FIRE_PACK_KEY, value: firePackValue() }] });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/tool_pack/);
  });

  it('云端没有 tool_config → 抛错（同上）', async () => {
    const { ctx } = makeCtx({ globalRows: [] });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/tool_config/);
  });

  it('任务行 next_send_at 解析不出时间 → 抛错（occurrence 是闸和缓存键的必需字段）', async () => {
    const { ctx } = makeCtx({ nextSendAt: '不是时间' });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/next_send_at/);
  });

  it('任务缺 amsgTaskInstruction（旧格式）→ 抛错，不能用默认指令凑一个', async () => {
    const { ctx } = makeCtx({ metadata: { amsgTaskInstruction: undefined } });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/amsgTaskInstruction/);
  });

  it('任务 metadata 缺 charId → 抛错', async () => {
    const { ctx } = makeCtx({ metadata: { charId: undefined } });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/charId/);
  });
});

// ─── 连发上限：用户主权硬闸（2026-08 炸屏事故的到点兜底半边）───
//
// 语义：「用户未回复期间，角色自己排的任务最多响 N 次」。只拦 metadata 标了
// amsgSelfScheduled 的任务——用户面板排的是明确意愿，不受自己的防骚扰上限误伤；
// 即时对话是在答用户刚说的话，也不拦。计数随「用户开口」清零，不随 fire_pack
// 重传清零（后者正是当年提醒失效的回路）。
describe('连发上限（到点兜底闸）', () => {
  /**
   * 造一份自述日志：n 条主动 + 可选几条即时回复。
   *
   * 连发条数记在 unansweredSends 上，entries 只是给 prompt 看的上下文（最多留 8 条）；
   * 两者分开正是「上限设 9 / 10 时闸失效」那条的修法，夹具也照真格式造。
   */
  const selfLogValue = (sends: number, opts: { replies?: number; basePackAt?: number } = {}) => {
    const entries = [
      ...Array.from({ length: sends }, (_, i) => ({ id: `s@${i}`, at: NOW.getTime() - (sends - i) * 60_000, text: `主动第${i + 1}条` })),
      ...Array.from({ length: opts.replies ?? 0 }, (_, i) => ({ id: `r@${i}`, at: NOW.getTime() - 30_000, text: `回复${i + 1}`, reply: true })),
    ];
    return JSON.stringify({
      v: 4,
      basePackAt: opts.basePackAt ?? PACK_BUILT_AT,
      anchorUserMsgAt: null,
      entries: entries.slice(-SELF_LOG_MAX_ENTRIES),
      unansweredSends: sends,
      tasks: [],
    });
  };

  const rowsWith = (selfLog: string, packExtra: Record<string, unknown> = {}, lastUserMessageAt: number | null = null) => [
    { key: AMSG_FIRE_PACK_KEY, value: firePackValue(lastUserMessageAt, packExtra) },
    { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
    { key: AMSG_SELF_LOG_KEY, value: selfLog },
  ];

  const lastSkipReason = (writeState: ReturnType<typeof vi.fn>) => {
    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    return call ? JSON.parse(String(call[1][0].value)).reason : undefined;
  };

  it('自排任务到点、连发已达默认上限(3) → skip 并留 unanswered-limit 痕', async () => {
    const { ctx, writeState } = makeCtx({
      metadata: { amsgSelfScheduled: true },
      charRows: rowsWith(selfLogValue(3)),
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
    expect(lastSkipReason(writeState)).toBe('unanswered-limit');
  });

  it('用户面板排的任务不受上限管：同样 3 条连发，照常生成', async () => {
    const { ctx } = makeCtx({ charRows: rowsWith(selfLogValue(3)) });
    fired(await amsgHooks.onBeforeFire(ctx));
  });

  it('用户开口后计数清零：自排任务照常发', async () => {
    // fire_pack 记录的 lastUserMessageAt 比日志锚新 → reconcile 清空 entries。
    const { ctx } = makeCtx({
      metadata: { amsgSelfScheduled: true },
      charRows: rowsWith(selfLogValue(3), {}, NOW.getTime() - 10 * 60_000),
    });
    fired(await amsgHooks.onBeforeFire(ctx));
  });

  it('炸屏回归守卫：客户端认领重传（fire_pack 换代）不清计数，自排任务仍被拦', async () => {
    const { ctx, writeState } = makeCtx({
      metadata: { amsgSelfScheduled: true },
      charRows: rowsWith(selfLogValue(3, { basePackAt: PACK_BUILT_AT - 1000 })),
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
    expect(lastSkipReason(writeState)).toBe('unanswered-limit');
  });

  it('用户自设上限按用户的来：设 5 时第 4 条照常发、0（不限）永不拦', async () => {
    const looser = makeCtx({
      metadata: { amsgSelfScheduled: true },
      charRows: rowsWith(selfLogValue(3), { maxUnansweredSends: 5 }),
    });
    fired(await amsgHooks.onBeforeFire(looser.ctx));

    const unlimited = makeCtx({
      metadata: { amsgSelfScheduled: true },
      charRows: rowsWith(selfLogValue(9), { maxUnansweredSends: 0 }),
    });
    fired(await amsgHooks.onBeforeFire(unlimited.ctx));
  });

  it('即时对话的回复（reply 条目）不算连发', async () => {
    const { ctx } = makeCtx({
      metadata: { amsgSelfScheduled: true },
      charRows: rowsWith(selfLogValue(2, { replies: 3 })),
    });
    fired(await amsgHooks.onBeforeFire(ctx));
  });

  // 回归守卫：设置页的下拉给到 1–10，而连发计数以前是数 entries 数出来的、entries 只留
  // 最近 8 条 —— 9 和 10 两档因此等于「不限」，这道专门为自排链炸屏加的硬闸整个失效。
  // 日志按真实路径攒（appendSelfLogEntry 会削 entries），才验得出这件事。
  it('上限设 10、已连发 10 条 → 照样拦下（计数不被 entries 的 8 条上限压平）', async () => {
    let log = createSelfLog(PACK_BUILT_AT);
    for (let i = 0; i < 10; i += 1) {
      log = appendSelfLogEntry(log, {
        id: `s@${i}`, at: NOW.getTime() - (10 - i) * 60_000, text: `主动第${i + 1}条`,
      });
    }
    expect(log.entries).toHaveLength(SELF_LOG_MAX_ENTRIES);   // 前提：entries 确实被削过

    const { ctx, writeState } = makeCtx({
      metadata: { amsgSelfScheduled: true },
      charRows: rowsWith(JSON.stringify(log), { maxUnansweredSends: 10 }),
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
    expect(lastSkipReason(writeState)).toBe('unanswered-limit');
  });

  it('上限设 10、只连发 9 条 → 还差一条，照常生成', async () => {
    let log = createSelfLog(PACK_BUILT_AT);
    for (let i = 0; i < 9; i += 1) {
      log = appendSelfLogEntry(log, {
        id: `s@${i}`, at: NOW.getTime() - (9 - i) * 60_000, text: `主动第${i + 1}条`,
      });
    }
    const { ctx } = makeCtx({
      metadata: { amsgSelfScheduled: true },
      charRows: rowsWith(JSON.stringify(log), { maxUnansweredSends: 10 }),
    });
    fired(await amsgHooks.onBeforeFire(ctx));
  });
});

// ─── 通用 MCP：到点把工具说明块和 tools 声明一起带上 ───
//
// 提示词块和 tools 数组同源同拍（都来自那一行 tool_config），所以这几条一起钉：
// 教了角色用工具，请求里就得真有工具；没配 MCP 的用户则一个字都不该多出来。

describe('onBeforeFire 注入通用 MCP', () => {
  it('配了 MCP 服务器 → prompt 尾部带工具块，请求带 mcp__ 前缀的 tools', async () => {
    const { ctx, scratch } = makeCtx({
      globalRows: [{ key: AMSG_TOOL_CONFIG_KEY, value: mcpToolConfigValue() }],
    });
    const result = fired(await amsgHooks.onBeforeFire(ctx));

    const prompt = result.messages[0].content;
    expect(prompt).toContain('问问对方吃了没');           // 原来的任务指令还在
    expect(prompt).toContain('【外部工具');
    expect(prompt).toContain('search_memory');

    expect(result.tools?.map((t) => t.function.name)).toEqual(['mcp__search_memory']);
    // 参数表要原样带上，不然模型只能瞎猜字段名
    expect(result.tools?.[0].function.parameters).toMatchObject({
      properties: { query: { type: 'string' } },
    });
    // 名映射进 scratch，executeToolCalls 按暴露名回查是哪台服务器的哪个工具
    expect((scratch.fire as any).mcpResolve.get('search_memory').toolName).toBe('search_memory');
  });

  it('没配 MCP → 一切照旧：不带 tools、prompt 里没有工具块', async () => {
    const { ctx, scratch } = makeCtx({});
    const result = fired(await amsgHooks.onBeforeFire(ctx));

    expect(result).not.toHaveProperty('tools');
    expect(result.messages[0].content).not.toContain('【外部工具');
    expect((scratch.fire as any).mcpResolve).toBeNull();
  });

  it('服务器只对别的角色可见 → 当作没配（凭据不该串到不相干的角色身上）', async () => {
    const { ctx, scratch } = makeCtx({
      globalRows: [{
        key: AMSG_TOOL_CONFIG_KEY,
        value: mcpToolConfigValue({
          mcpServers: [{
            id: 'srv-memory', name: '记忆库', url: 'https://mcp.example.com/mcp',
            charIds: ['别的角色'],
            tools: [{ name: 'search_memory', inputSchema: { type: 'object', properties: {} } }],
          }],
        }),
      }],
    });
    const result = fired(await amsgHooks.onBeforeFire(ctx));

    expect(result).not.toHaveProperty('tools');
    expect(result.messages[0].content).not.toContain('【外部工具');
    expect((scratch.fire as any).mcpResolve).toBeNull();
  });

  it('用户关了兼容模式（中转拒 tools）→ 不带 tools 参数，改用正文协议教一遍', async () => {
    const { ctx, scratch } = makeCtx({
      globalRows: [{
        key: AMSG_TOOL_CONFIG_KEY,
        value: mcpToolConfigValue({ mcpUseNativeTools: false }),
      }],
    });
    const result = fired(await amsgHooks.onBeforeFire(ctx));

    expect(result).not.toHaveProperty('tools');
    const prompt = result.messages[0].content;
    expect(prompt).toContain('tool_name({"参数":"值"})');
    expect(prompt).toContain('search_memory(query*:string)');
    // 工具还是要认识的，只是走正文那条路
    expect((scratch.fire as any).mcpResolve.size).toBe(1);
  });
});

// ─── VAPID 配置兜底 ───
// scheduled() 在 !vapid.email 时会 console.error 后直接 return——整个 tick 一条任务都不处理。
// 而「推送凭据」面板复制出来的 env 里 VAPID_EMAIL 是注释掉的可选项，照着部署必然缺它，
// 表现是「到点了什么都不发、前端没有任何报错」。email 只是 VAPID JWT 的 sub（联系方式），
// 不影响签名有效性，缺省给一个合法 mailto 即可——instant-push worker 一直就是这么做的。
describe('VAPID 配置', () => {
  const baseEnv = {
    AMSG_MASTER_KEY: 'k'.repeat(64),
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    DB: {},
  } as any;

  it('没配 VAPID_EMAIL 时回退到合法 mailto，不能让 scheduled() 整轮跳过', () => {
    const config = buildWorkerConfig({ ...baseEnv, VAPID_EMAIL: undefined });
    expect(config.vapid.email).toMatch(/^mailto:/);
  });

  it('VAPID_EMAIL 只有空白字符时同样回退（空串一样会让 scheduled 跳过）', () => {
    const config = buildWorkerConfig({ ...baseEnv, VAPID_EMAIL: '   ' });
    expect(config.vapid.email).toMatch(/^mailto:/);
  });

  it('配了就用配的那个，不覆盖用户的联系方式', () => {
    const config = buildWorkerConfig({ ...baseEnv, VAPID_EMAIL: 'mailto:me@example.com' });
    expect(config.vapid.email).toBe('mailto:me@example.com');
  });

  it('解析函数本身：缺省/空白回退，配了就原样用', () => {
    expect(resolveVapidEmail(undefined)).toMatch(/^mailto:/);
    expect(resolveVapidEmail('')).toMatch(/^mailto:/);
    expect(resolveVapidEmail('  ')).toMatch(/^mailto:/);
    expect(resolveVapidEmail('mailto:a@b.c')).toBe('mailto:a@b.c');
  });
});

// 回归守卫：一条 Web Push 只装得下 3993 字节明文，而角色一次可能分享六七张笔记。
// 过去的做法是硬砍到 4 张，用户看到的是「说分享了 6 张、只出来 4 张卡」。现在按真实
// 字节算：装得下照装，装不下把整份挪进 client_state、push 只留引用键，一张不少。
describe('offloadOversizedPush — push 装不下时旁路存储', () => {
  const CLIENT_TASK_ID = 'task-uuid-1';
  const bigNote = (n: number) => ({
    idx: n,
    note: {
      noteId: `note-${n}`,
      title: `第 ${n} 篇笔记的标题`.repeat(4),
      desc: '描述'.repeat(60),
      likes: 100 + n,
      author: `作者${n}`,
      authorId: `author-${n}`,
      coverUrl: `https://example.com/cover-${n}-${'x'.repeat(40)}.jpg`,
    },
  });
  const pushWith = (noteCount: number) => ({
    messageKind: 'content',
    message: '看到几个好东西，分享给你～',
    title: '来自 小满',
    metadata: {
      charId: CHAR_ID,
      amsgClientTaskId: CLIENT_TASK_ID,
      directives: Array.from({ length: noteCount }, (_, i) => ({ type: 'xhs_share', idx: i + 1 })),
      xhsSession: {
        notes: Array.from({ length: noteCount }, (_, i) => bigNote(i + 1)),
        xsecTokens: [],
      },
    },
  });

  it('装得下就原样发，不碰云端状态（日常 1-3 张走的就是这条）', async () => {
    const writeState = vi.fn();
    const payload = pushWith(1);
    const out = await offloadOversizedPush(payload as any, writeState, CHAR_ID, CLIENT_TASK_ID);
    expect(out).toBe(payload);
    expect(writeState).not.toHaveBeenCalled();
  });

  it('装不下 → 整份 xhsSession 存进 client_state，push 换成引用键且回到限内', async () => {
    const writeState = vi.fn().mockResolvedValue({ upserted: 1, skipped: 0, deleted: 0 });
    const payload = pushWith(8);
    // 上限按 UTF-8 字节算，不是字符数——中文一个字三个字节，拿 .length 比会算漏一大截。
    const utf8Bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
    expect(utf8Bytes(payload)).toBeGreaterThan(MAX_PUSH_PAYLOAD_BYTES);

    const out = await offloadOversizedPush(payload as any, writeState, CHAR_ID, CLIENT_TASK_ID);

    const key = amsgXhsSessionKey(CLIENT_TASK_ID);
    expect(writeState).toHaveBeenCalledWith(amsgStateNamespace(CHAR_ID), [
      { key, value: JSON.stringify((payload.metadata as any).xhsSession) },
    ]);
    const meta = (out.metadata ?? {}) as Record<string, unknown>;
    expect(meta.xhsSessionRef).toBe(key);
    expect(meta.xhsSession).toBeUndefined();
    expect(meta.directives).toHaveLength(8);          // 引用一条不少，只是数据挪了地方
    expect(utf8Bytes(out)).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
  });

  it('老部署没有写入口 → 抛错走重试，绝不砍掉笔记凑合发出去', async () => {
    await expect(offloadOversizedPush(pushWith(8) as any, undefined, CHAR_ID, CLIENT_TASK_ID))
      .rejects.toThrow(/AMSG2_WRITE_STATE_UNSUPPORTED/);
  });

  // 存储键是按 clientTaskId 编的，缺了就没法旁路。这时候库会抛 PUSH_PAYLOAD_TOO_LARGE
  // 把整条消息卡住，光看那个错认不出根因——所以先吼一声，wrangler tail 上一眼看得见。
  it('超限但没有 clientTaskId → 吼一声说清「旁路用不上」，别只留一个超限错', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const writeState = vi.fn();
    const payload = pushWith(8) as any;

    const out = await offloadOversizedPush(payload, writeState, CHAR_ID, '');

    expect(out).toBe(payload);
    expect(writeState).not.toHaveBeenCalled();
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('没有 clientTaskId'))).toBe(true);
    warn.mockRestore();
  });

  it('超限但没有可旁路的内容 → 原样交给库抛 PUSH_PAYLOAD_TOO_LARGE，不假装成功', async () => {
    const writeState = vi.fn();
    const fat = { messageKind: 'content', message: '正'.repeat(2000), metadata: { charId: CHAR_ID } };
    const out = await offloadOversizedPush(fat as any, writeState, CHAR_ID, CLIENT_TASK_ID);
    expect(out).toBe(fat);
    expect(writeState).not.toHaveBeenCalled();
  });

  // 回归守卫：判定要留余量。这里量的是 hook 交还给库的那份，库之后还会补
  // messageId / sessionId / timestamp / messageIndex / totalMessages（sendHookPushPayloads），
  // 实测多出一百多字节。卡着上限判的话，量出来「刚好装得下」的那一档补完字段就超了：
  // 既没旁路、也发不出去，整条消息丢掉，而且每次重试都死在同一处。
  it('贴着上限（余量不足）也走旁路，别等库补完字段才发现超了', async () => {
    const writeState = vi.fn().mockResolvedValue({ upserted: 1, skipped: 0, deleted: 0 });
    const utf8Bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

    // 拿真实形状撑到「限内、但余量不到 256 字节」这一档，逐字节逼近，不写死魔数。
    const payload = pushWith(1) as any;
    while (utf8Bytes(payload) < MAX_PUSH_PAYLOAD_BYTES - 200) {
      payload.message += '一';
    }
    expect(utf8Bytes(payload)).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);   // 旧判定会说「装得下」

    const out = await offloadOversizedPush(payload, writeState, CHAR_ID, CLIENT_TASK_ID);

    expect(writeState).toHaveBeenCalledTimes(1);
    expect((out.metadata as any).xhsSessionRef).toBe(amsgXhsSessionKey(CLIENT_TASK_ID));
    // 挪走之后要给库补字段留出足够空间。
    expect(MAX_PUSH_PAYLOAD_BYTES - utf8Bytes(out)).toBeGreaterThanOrEqual(256);
  });

  // 云端情绪评估的结果是一整段模型输出，撑爆一条 push 很正常。它得跟 XHS 那份一样能
  // 旁路走，而且**排在前面**：客户端拿它只是落 buff，晚一步取回来不影响这条消息本身，
  // 而 XHS 数据关系到这条消息里的卡片能不能出来。
  it('情绪评估结果撑爆一条 push → 先挪它，push 换成 amsgEmotionRef', async () => {
    const writeState = vi.fn().mockResolvedValue({ upserted: 1, skipped: 0, deleted: 0 });
    const evalRaw = `{"changed":true,"innerState":"${'想'.repeat(1500)}"}`;
    const payload = {
      messageKind: 'content',
      message: '在的。',
      metadata: { charId: CHAR_ID, amsgClientTaskId: CLIENT_TASK_ID, amsgEmotionUpdate: evalRaw },
    };
    const utf8Bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
    expect(utf8Bytes(payload)).toBeGreaterThan(MAX_PUSH_PAYLOAD_BYTES);

    const out = await offloadOversizedPush(payload as any, writeState, CHAR_ID, CLIENT_TASK_ID);

    const key = amsgEmotionUpdateKey(CLIENT_TASK_ID);
    // 存原文（不再包一层 JSON）：客户端取回来直接喂 applyEmotionEvalRaw
    expect(writeState).toHaveBeenCalledWith(amsgStateNamespace(CHAR_ID), [{ key, value: evalRaw }]);
    const meta = (out.metadata ?? {}) as Record<string, unknown>;
    expect(meta.amsgEmotionRef).toBe(key);
    expect(meta.amsgEmotionUpdate).toBeUndefined();
    expect(utf8Bytes(out)).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
  });

  // 思考链也是一整段模型输出，而且常常比评估结果还长，所以排在最前面挪。
  it('思考链撑爆一条 push → 先挪它，push 换成 amsgReasoningRef', async () => {
    const writeState = vi.fn().mockResolvedValue({ upserted: 1, skipped: 0, deleted: 0 });
    const reasoning = '他这句话背后想说的是'.repeat(300);
    const payload = {
      messageKind: 'content',
      message: '在的。',
      metadata: { charId: CHAR_ID, amsgClientTaskId: CLIENT_TASK_ID, amsgReasoning: reasoning },
    };
    const utf8Bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
    expect(utf8Bytes(payload)).toBeGreaterThan(MAX_PUSH_PAYLOAD_BYTES);

    const out = await offloadOversizedPush(payload as any, writeState, CHAR_ID, CLIENT_TASK_ID);

    const key = amsgReasoningKey(CLIENT_TASK_ID);
    // 存原文：客户端取回来直接当思考链渲染
    expect(writeState).toHaveBeenCalledWith(amsgStateNamespace(CHAR_ID), [{ key, value: reasoning }]);
    const meta = (out.metadata ?? {}) as Record<string, unknown>;
    expect(meta.amsgReasoningRef).toBe(key);
    expect(meta.amsgReasoning).toBeUndefined();
    expect(utf8Bytes(out)).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
  });

  // 回归守卫：接力要一棒接一棒。第二棒若是从原始 metadata 重新起算，第一棒挪走的思考链
  // 会被原样塞回 push、引用键也丢——push 照样超限，而日志上看着「两份都挪了」。
  it('思考链和评估结果都得挪 → 两个引用键都在，原文一个不留', async () => {
    const writeState = vi.fn().mockResolvedValue({ upserted: 1, skipped: 0, deleted: 0 });
    const payload = {
      messageKind: 'content',
      message: '在的。',
      metadata: {
        charId: CHAR_ID,
        amsgClientTaskId: CLIENT_TASK_ID,
        // 两份各自都撑得爆一条 push：只挪走一份还是超限，才逼得出接力那一步。
        amsgReasoning: '他这句话背后想说的是'.repeat(300),
        amsgEmotionUpdate: `{"changed":true,"innerState":"${'想'.repeat(1500)}"}`,
      },
    };

    const out = await offloadOversizedPush(payload as any, writeState, CHAR_ID, CLIENT_TASK_ID);

    expect(writeState).toHaveBeenCalledTimes(2);
    const meta = (out.metadata ?? {}) as Record<string, unknown>;
    expect(meta.amsgReasoningRef).toBe(amsgReasoningKey(CLIENT_TASK_ID));
    expect(meta.amsgEmotionRef).toBe(amsgEmotionUpdateKey(CLIENT_TASK_ID));
    expect(meta.amsgReasoning).toBeUndefined();
    expect(meta.amsgEmotionUpdate).toBeUndefined();
    expect(new TextEncoder().encode(JSON.stringify(out)).length)
      .toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
  });

  it('挪完评估还是装不下 → XHS 那份接着挪（两个引用键都留在 push 上）', async () => {
    const writeState = vi.fn().mockResolvedValue({ upserted: 1, skipped: 0, deleted: 0 });
    const payload = pushWith(8) as any;
    payload.metadata.amsgEmotionUpdate = `{"changed":true,"innerState":"${'想'.repeat(300)}"}`;

    const out = await offloadOversizedPush(payload, writeState, CHAR_ID, CLIENT_TASK_ID);

    expect(writeState).toHaveBeenCalledTimes(2);
    const meta = (out.metadata ?? {}) as Record<string, unknown>;
    expect(meta.amsgEmotionRef).toBe(amsgEmotionUpdateKey(CLIENT_TASK_ID));
    expect(meta.xhsSessionRef).toBe(amsgXhsSessionKey(CLIENT_TASK_ID));
    expect(meta.directives).toHaveLength(8);
  });
});

// 服务端工具循环的编排：跑完一个工具之后跟模型说什么，以及重复调用怎么办。
// 这段是「amsg2 和前台行为对齐」的落点——前台每次回喂都明说「别再输出这个标签了」，
// worker 以前只回裸 JSON，模型看不出这一步已经做完，提示词里有句常驻的「先去查 X」
// 就会每轮照做、跑满上限，然后 AGENTIC_LOOP_EXCEEDED、任务不出清、下一分钟整条重跑。
describe('executeToolCalls 的工具编排', () => {
  const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
    id,
    function: { name, arguments: JSON.stringify(args) },
  });

  /** 造一个跑到 executeToolCalls 那一步的 sessionCtx（scratch.fire 由 onBeforeFire 挂好）。 */
  const readySession = async () => {
    const { ctx, scratch } = makeCtx({});
    await amsgHooks.onBeforeFire(ctx);
    return { sessionId: 'sess_task_42', scratch } as any;
  };

  it('回喂的不是裸 JSON，而是带「别重复」引导的一段话', async () => {
    const session = await readySession();
    const [out] = await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      session,
    );
    expect(out.content).not.toMatch(/^\{/);        // 不是裸 JSON
    expect(out.content).toContain('不要再来一遍');
    expect(out.content).toContain('调取某个月的记忆');
  });

  it('同名同参第二次直接打回，不再真跑一遍工具', async () => {
    const session = await readySession();
    const call = toolCall('c1', 'recall', { year: '2026', month: '06' });
    await amsgHooks.executeToolCalls([call], session);
    const [second] = await amsgHooks.executeToolCalls(
      [{ ...call, id: 'c2' }],
      session,
    );
    expect(second.content).toContain('没有再执行');
  });

  // 闸只拦「完全一样」的调用。换个月份是正当的多轮使用，拦了就是把能力砍了。
  it('换了参数照常放行——多轮能力不受影响', async () => {
    const session = await readySession();
    await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      session,
    );
    const [other] = await amsgHooks.executeToolCalls(
      [toolCall('c2', 'recall', { year: '2026', month: '07' })],
      session,
    );
    expect(other.content).not.toContain('没有再执行');
  });

  it('参数字段顺序变了仍算同一次调用', async () => {
    const session = await readySession();
    await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      session,
    );
    const [reordered] = await amsgHooks.executeToolCalls(
      [toolCall('c2', 'recall', { month: '06', year: '2026' })],
      session,
    );
    expect(reordered.content).toContain('没有再执行');
  });

  // 轮次快用完了还在请求工具，上游会抛 AGENTIC_LOOP_EXCEEDED：这次攒的旁白全丢、任务
  // 不出清、下一分钟整条从头重跑。先在回喂里说一声，模型自己收尾最省。
  it('倒数第二轮的回喂末尾加一句「这是最后一轮」', async () => {
    const session = await readySession();
    const [out] = await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      { ...session, iteration: MAX_TOOL_ITERATIONS - 2 },
    );
    expect(out.content).toContain('最后一轮');
  });

  it('还早的轮次不加那句话（别一上来就催着收尾）', async () => {
    const session = await readySession();
    const [out] = await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      { ...session, iteration: 0 },
    );
    expect(out.content).not.toContain('最后一轮');
  });
});

// 轮次预算：worker 判「这是最后一轮了」用的数必须和上游真正跑的轮数是同一个，
// 否则不是提前一轮白收尾、就是照旧撞上 AGENTIC_LOOP_EXCEEDED。
describe('轮次上限与上游共用同一个数', () => {
  const sessionCtx = (scratch: Record<string, unknown>, llmOutputText: string, iteration: number) => ({
    sessionId: 'sess_task_42',
    taskId: 42,
    taskUuid: TASK_UUID,
    llmResponse: {},
    llmOutputText,
    contactName: 'Nyah',
    metadata: { charId: CHAR_ID, amsgMode: 'auto' },
    scratch,
    iteration,
  }) as any;

  it('onBeforeFire 把轮次上限显式回传给上游', async () => {
    const { ctx } = makeCtx({});
    const result = await amsgHooks.onBeforeFire(ctx) as { maxToolIterations?: number };
    expect(result.maxToolIterations).toBe(MAX_TOOL_ITERATIONS);
  });

  it('最后一轮还想调工具 → 直接收尾，不把 tool-request 交回上游', async () => {
    const { ctx, scratch } = makeCtx({});
    await amsgHooks.onBeforeFire(ctx);

    const first = await amsgHooks.onLLMOutput(
      sessionCtx(scratch, '我先想想六月的事。\n[[RECALL: 2026-06]]', 0)) as any;
    expect(first.decision).toBe('tool-request');

    const last = await amsgHooks.onLLMOutput(
      sessionCtx(scratch, '再查一次。\n[[RECALL: 2026-07]]', MAX_TOOL_ITERATIONS - 1)) as any;
    expect(last.decision).toBe('finish');
    expect(last.pushPayloads.map((p: any) => p.message).join('\n')).toContain('我先想想六月的事');
  });
});

// 云端生成的思考链要跟着回复一起回到客户端，否则聊天走即时对话这条路时思考链卡片整个缺席
// （用户开着「显示思考链」，本地路径有、云端路径没有，看上去就是角色这次没想）。
// 它挂在**第一条** push 的 metadata 上：卡片渲染在第一条气泡上，收侧也只在
// messageIndex<=1 时认领。
describe('云端思考链随首条 push 回客户端', () => {
  const CLIENT_TASK_ID = 'client-task-reasoning';
  const CHAT_MESSAGES = [
    { role: 'system', content: '你是 Nyah。' },
    { role: 'user', content: '在吗' },
  ];
  /** 两段正文 → 两条 push，才验得出「只挂第一条」。 */
  const TWO_SEGMENT_OUTPUT = '在的。\n怎么啦？';

  afterEach(() => vi.unstubAllGlobals());

  /** 一轮 LLM：正文 + 可选的思考（放在哪个响应字段里也能挑）。 */
  interface Round {
    output: string;
    reasoning?: string;
    /** 思考放哪个字段，默认 reasoning_content。 */
    field?: 'reasoning_content' | 'reasoning' | 'thinking';
  }

  /**
   * 跑一次即时对话的 fire，可以连喂好几轮（工具循环）；返回最后一轮的 decision。
   * 走即时对话是因为思考链只在这条路回传——定时任务那条见下面单独一条用例。
   */
  const instantFire = async (rounds: Round[], extraMeta: Record<string, unknown> = {}) => {
    const store = makeFireStore(CHAT_MESSAGES);
    const scratch: Record<string, unknown> = {};
    const metadata = {
      charId: CHAR_ID,
      amsgClientTaskId: CLIENT_TASK_ID,
      amsgMode: 'instant',
      amsgInstantChat: true,
      ...extraMeta,
    };
    await amsgHooks.onBeforeFire({
      task: {
        id: FIRE_TASK_ID, uuid: TASK_UUID, contactName: 'Nyah', recurrenceType: 'none',
        nextSendAt: FIRE_NEXT_SEND_AT, metadata,
      },
      userId: 'u1',
      readState: store.readState,
      writeState: store.writeState,
      now: NOW,
      scratch,
    } as any);

    let decision: any;
    for (const [iteration, round] of rounds.entries()) {
      decision = await amsgHooks.onLLMOutput({
        sessionId: `sess_task_${FIRE_TASK_ID}@1`, taskId: FIRE_TASK_ID, taskUuid: TASK_UUID,
        llmResponse: {
          choices: [{
            message: {
              content: round.output,
              ...(round.reasoning ? { [round.field ?? 'reasoning_content']: round.reasoning } : {}),
            },
          }],
        },
        llmOutputText: round.output, contactName: 'Nyah',
        metadata, scratch, writeState: store.writeState, iteration,
      } as any);
    }
    return decision;
  };

  // 字段名各家不一样：reasoning_content 是 deepseek-r1 / GLM 那批，OpenRouter 转出来叫
  // reasoning，还有渠道写 thinking。只认一个的话，换个渠道就静默没有卡片了。
  it.each(['reasoning_content', 'reasoning', 'thinking'] as const)(
    '响应字段 %s 里的思考 → 挂第一条 push，正文不带 <think>',
    async (field) => {
      const decision = await instantFire([{
        output: TWO_SEGMENT_OUTPUT,
        reasoning: '他这句问得很轻，先接住再问一句。',
        field,
      }]);

      expect(decision.decision).toBe('finish');
      const payloads = decision.pushPayloads as Array<Record<string, any>>;
      expect(payloads.length).toBeGreaterThanOrEqual(2);
      expect(payloads[0].metadata.amsgReasoning).toContain('先接住再问一句');
      for (const payload of payloads.slice(1)) {
        expect(payload.metadata.amsgReasoning).toBeUndefined();
      }
      expect(JSON.stringify(payloads)).not.toContain('<think>');
    },
  );

  it('只有正文内联 <think> 的模型也拿得到（正文照旧剥干净）', async () => {
    const decision = await instantFire([{ output: '<think>他好像有点累了。</think>在的。\n怎么啦？' }]);

    expect(decision.decision).toBe('finish');
    const payloads = decision.pushPayloads as Array<Record<string, any>>;
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    expect(payloads[0].metadata.amsgReasoning).toContain('他好像有点累了');
    for (const payload of payloads.slice(1)) {
      expect(payload.metadata.amsgReasoning).toBeUndefined();
    }
    expect(payloads.map((p) => p.message)).toEqual(['在的。', '怎么啦？']);
    expect(JSON.stringify(payloads)).not.toContain('<think>');
  });

  // 工具循环一次 fire 跑好几轮，每轮都有自己的思考。留最后一轮的：用户看到的正文就是
  // 那一轮写的，配上「我先去查一下」的中间轮思考等于答非所问。
  it('多轮工具循环 → 留下产出正文那一轮的思考', async () => {
    const decision = await instantFire([
      { output: '等我想想。\n[[RECALL: 2026-06]]', reasoning: '第一轮：先去翻六月的记忆。' },
      { output: '想起来了，那天你说想去看海。', reasoning: '第二轮：翻到了那天的事，说给他听。' },
    ]);

    expect(decision.decision).toBe('finish');
    const meta = decision.pushPayloads[0].metadata;
    expect(meta.amsgReasoning).toContain('第二轮');
    expect(meta.amsgReasoning).not.toContain('第一轮');
  });

  // 「留最后一轮的」包括最后一轮没思考的情形：这时候一个字段都不挂。拿中间轮那句
  // 「我先去查一下」顶上的话，卡片里写的是查资料，正文说的是看海。
  it('最后一轮没思考 → 中间轮那句不许顶上来', async () => {
    const decision = await instantFire([
      { output: '等我想想。\n[[RECALL: 2026-06]]', reasoning: '第一轮：先去翻六月的记忆。' },
      { output: '想起来了，那天你说想去看海。' },
    ]);

    expect(decision.decision).toBe('finish');
    for (const payload of decision.pushPayloads as Array<Record<string, any>>) {
      expect(payload.metadata.amsgReasoning).toBeUndefined();
    }
  });

  // 定时任务这条路的 prompt 是 renderFirePack 现拼的，没有「心象」那段提示词，模型的
  // thinking 就是原始推理腔（「用户三小时没说话了，我应该……」）。那个当心象卡片放出去
  // 是穿帮，所以这道门先只对即时对话开。
  it('定时任务的那份思考不回传（没有心象提示词，推理腔不当心象）', async () => {
    const { decision } = await runFire(makeFireStore(), {
      metadata: {
        amsgClientTaskId: CLIENT_TASK_ID,
        amsgMode: 'auto',
        amsgTaskInstruction: '想到什么说什么',
      },
      llmOutput: TWO_SEGMENT_OUTPUT,
      llmResponse: {
        choices: [{
          message: {
            content: TWO_SEGMENT_OUTPUT,
            reasoning_content: '用户三小时没说话了，我应该主动关心一下。',
          },
        }],
      },
    });

    expect(decision.decision).toBe('finish');
    const payloads = decision.pushPayloads as Array<Record<string, any>>;
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    for (const payload of payloads) {
      expect(payload.metadata.amsgReasoning).toBeUndefined();
    }
    expect(JSON.stringify(payloads)).not.toContain('我应该主动关心');
  });

  // 只有一段正文时，思考链（挂第一条）和情绪评估（挂最后一条）落在同一条 push 上。
  // 两次挂载各自 spread 一遍 metadata，谁把谁盖掉都是静默的：要么没有心象卡片、
  // 要么情绪永远不更新，而日志上什么都看不出来。
  it('只有一条 push 时思考链和情绪评估同时挂上，谁也不盖谁', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"changed":true,"buffs":[]} EVAL-RAW-MARKER' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const decision = await instantFire(
      [{ output: '在的。', reasoning: '他终于开口了。' }],
      {
        amsgEmotionEval: {
          prompt: '你是一个角色情绪分析系统。',
          api: { baseUrl: 'https://eval.example.com/v1', apiKey: 'sk-eval', model: 'eval-mini' },
        },
      },
    );

    expect(decision.decision).toBe('finish');
    const payloads = decision.pushPayloads as Array<Record<string, any>>;
    expect(payloads).toHaveLength(1);
    const meta = payloads[0].metadata;
    expect(meta.amsgReasoning).toContain('他终于开口了');
    expect(meta.amsgEmotionUpdate).toContain('EVAL-RAW-MARKER');
    expect(meta.amsgEmotionDone).toBe(true);
  });
});

// 即时对话这一轮在云端跑过哪些工具，要跟着回复一起回到客户端，气泡底下才画得出那行灰字
// （「调用了工具：搜索网页 ×2」）。本地那条路全程有搜索状态条，云端这条路全程静默——
// 不带这份的话，角色突然知道了今天的新闻，用户看不出这是查来的。
// 它挂在**最后一条** push 上：跟正文一起收尾，用户读完才看到痕迹。
// 线上传的是原始工具名 + 次数，翻译成人话是客户端的事（见 utils/amsgToolTrace.ts）。
describe('云端工具痕迹随末条 push 回客户端', () => {
  const CLIENT_TASK_ID = 'client-task-tooltrace';
  const CHAT_MESSAGES = [
    { role: 'system', content: '你是 Nyah。' },
    { role: 'user', content: '今天有什么新闻' },
  ];
  /** 两段正文 → 两条 push，才验得出「只挂最后一条」。 */
  const TWO_SEGMENT_OUTPUT = '我看了下。\n没什么大事。';

  const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
    id,
    function: { name, arguments: JSON.stringify(args) },
  });

  /**
   * 跑一次 fire：onBeforeFire → 依次执行工具 → onLLMOutput 收尾，返回 decision。
   *
   * 一次网络请求都不发也能验完整条：这套夹具里 recall 读 tool_pack 里那份记忆（真跑了，
   * 只是没查到）、web_search 缺 key 直接打回（压根没跑）、排程走注进去的 scheduleTask 桩。
   */
  const fireWithTools = async (opts: {
    instant: boolean;
    tools: Array<{ name: string; args: Record<string, unknown> }>;
    /** 给了才注入取消能力（不给的话取消工具会以 not_supported 打回，测不出别的）。 */
    cancelTask?: (uuid: string) => Promise<{ cancelled: boolean }>;
  }) => {
    const store = makeFireStore(opts.instant ? CHAT_MESSAGES : undefined);
    const scratch: Record<string, unknown> = {};
    const scheduleTask = async (o: any) => ({
      created: true as const, id: 7, uuid: o.uuid, nextSendAt: o.firstSendTime,
    });
    const cancelTask = opts.cancelTask;
    const metadata = {
      charId: CHAR_ID,
      amsgClientTaskId: CLIENT_TASK_ID,
      ...(opts.instant
        ? { amsgMode: 'instant', amsgInstantChat: true }
        : { amsgMode: 'auto', amsgTaskInstruction: '想到什么说什么' }),
    };
    await amsgHooks.onBeforeFire({
      task: {
        id: FIRE_TASK_ID, uuid: TASK_UUID, contactName: 'Nyah', recurrenceType: 'none',
        nextSendAt: FIRE_NEXT_SEND_AT, metadata,
      },
      userId: 'u1',
      readState: store.readState,
      writeState: store.writeState,
      now: NOW,
      scratch,
      scheduleTask,
    } as any);

    for (const [i, tool] of opts.tools.entries()) {
      await amsgHooks.executeToolCalls(
        [toolCall(`c${i}`, tool.name, tool.args)],
        {
          sessionId: `sess_task_${FIRE_TASK_ID}@1`, scratch, iteration: 0,
          scheduleTask, cancelTask,
        } as any,
      );
    }

    return await amsgHooks.onLLMOutput({
      sessionId: `sess_task_${FIRE_TASK_ID}@1`, taskId: FIRE_TASK_ID, taskUuid: TASK_UUID,
      llmResponse: {}, llmOutputText: TWO_SEGMENT_OUTPUT, contactName: 'Nyah',
      metadata, scratch, writeState: store.writeState, iteration: 1, scheduleTask,
    } as any) as any;
  };

  // 排程工具校验 send_at 用的是真实时钟（executeToolCalls 传的是 Date.now()，不是
  // ctx.now），所以这里必须相对**现在**取未来时刻——照夹具里那个固定的 NOW 算的话，
  // 这次排程会被 send_at_too_soon 打回，测的就不是「排成功的调用记进痕迹」了。
  const SEND_AT = new Date(Date.now() + 90 * 60_000).toISOString();

  it('同一个工具跑了两次 → 按第一次出现的顺序压成名字 + 次数，只挂最后一条', async () => {
    const decision = await fireWithTools({
      instant: true,
      tools: [
        { name: 'recall', args: { year: '2026', month: '06' } },
        { name: 'schedule_active_message', args: { send_at: SEND_AT } },
        { name: 'recall', args: { year: '2026', month: '07' } },
      ],
    });

    expect(decision.decision).toBe('finish');
    const payloads = decision.pushPayloads as Array<Record<string, any>>;
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    const lastMeta = payloads[payloads.length - 1].metadata;
    expect(lastMeta.amsgToolTrace).toEqual([
      { name: 'recall', count: 2 },
      { name: 'schedule_active_message', count: 1 },
    ]);
    for (const payload of payloads.slice(0, -1)) {
      expect(payload.metadata.amsgToolTrace).toBeUndefined();
    }
  });

  // 这行灰字要防的就是「角色说了句我查过」而其实什么都没发生。没配 key / 连不上 /
  // 服务器没开机的调用一个请求都没发出去，记进痕迹等于自己造了个新的穿帮点。
  it('没配就没跑的调用不算数（web_search 缺 key，一个请求都没发）', async () => {
    const decision = await fireWithTools({
      instant: true,
      tools: [{ name: 'web_search', args: { query: '今天的新闻' } }],
    });

    expect(decision.decision).toBe('finish');
    for (const payload of decision.pushPayloads as Array<Record<string, any>>) {
      expect(payload.metadata.amsgToolTrace).toBeUndefined();
    }
  });

  // 「跑了没查到」跟「压根没跑」是两回事：前者角色说「我翻了下没找到」是实话，
  // 痕迹也该记上——它是真去翻了。
  it('跑了但没查到东西的照样算', async () => {
    const decision = await fireWithTools({
      instant: true,
      // 夹具里 memories 是空的 → recall 返回 no_logs（跑到了，只是这个月没东西）
      tools: [{ name: 'recall', args: { year: '2026', month: '06' } }],
    });

    expect(decision.decision).toBe('finish');
    const payloads = decision.pushPayloads as Array<Record<string, any>>;
    expect(payloads[payloads.length - 1].metadata.amsgToolTrace)
      .toEqual([{ name: 'recall', count: 1 }]);
  });

  // 被打回的调用同样不算。排程 / 取消 / 改期的打回码（no_tasks、task_not_found、
  // ambiguous_task、unanswered_limit…）都不在 neverRan 那个集合里，照它筛的话这些会被
  // 当成「跑起来了」记进痕迹——于是取消失败的那次也在气泡底下写一行「调用了工具：
  // 取消排好的消息」，用户据此以为排程没了，而那条任务原封不动到点照响。
  it('被打回的取消不算数（远端一次都没调，什么都没改）', async () => {
    const cancelTask = vi.fn(async () => ({ cancelled: true }));
    const decision = await fireWithTools({
      instant: true,
      cancelTask,
      // 这个角色现在一条排程都没挂着 → no_tasks 打回
      tools: [{ name: 'cancel_active_message', args: { task_id: 'nosuch12' } }],
    });

    expect(decision.decision).toBe('finish');
    expect(cancelTask, '连远端都没调，更没改动任何东西').not.toHaveBeenCalled();
    for (const payload of decision.pushPayloads as Array<Record<string, any>>) {
      expect(payload.metadata.amsgToolTrace).toBeUndefined();
    }
  });

  it('被打回的排程不算数（send_at 太近，一条任务都没建）', async () => {
    const decision = await fireWithTools({
      instant: true,
      tools: [{
        name: 'schedule_active_message',
        args: { send_at: new Date(Date.now() + 10_000).toISOString() },
      }],
    });

    expect(decision.decision).toBe('finish');
    for (const payload of decision.pushPayloads as Array<Record<string, any>>) {
      expect(payload.metadata.amsgToolTrace).toBeUndefined();
    }
  });

  it('这一轮一个工具都没跑 → 一个字段都不挂（气泡底下不该凭空多一行）', async () => {
    const decision = await fireWithTools({ instant: true, tools: [] });

    expect(decision.decision).toBe('finish');
    for (const payload of decision.pushPayloads as Array<Record<string, any>>) {
      expect(payload.metadata.amsgToolTrace).toBeUndefined();
    }
  });

  // 定时任务那条路的气泡是凭空冒出来的（用户没在等这一轮），底下再挂一行「调用了工具」
  // 等于把后台实现摊开给用户看。这行灰字先只给即时对话。
  it('定时任务那条路不带痕迹', async () => {
    const decision = await fireWithTools({
      instant: false,
      tools: [{ name: 'recall', args: { year: '2026', month: '06' } }],
    });

    expect(decision.decision).toBe('finish');
    for (const payload of decision.pushPayloads as Array<Record<string, any>>) {
      expect(payload.metadata.amsgToolTrace).toBeUndefined();
    }
  });
});

// 通用 MCP 的执行环节：worker 直连用户自己配的服务器（服务端 fetch 没有 CORS，
// 不经代理）。这里钉三件事——真的打到了配置里那个地址并带上凭据、同一次 fire 内
// 握手只做一次、以及任何失败都以 ok:false 回喂而不是把整条 fire 炸掉。
describe('runMcpFireTool', () => {
  const probe: McpFireServer = {
    id: 's1',
    name: '探针',
    url: 'https://probe.example.com/mcp',
    token: 'tok-1',
    tools: [{ name: 'get_secret', inputSchema: { type: 'object', properties: {} } }],
  };
  // maxNameLen 与 onBeforeFire 一致（给前缀留位）。
  const stashFragment = () => ({
    mcpResolve: buildMcpNameMap([probe], { maxNameLen: MCP_FIRE_NAME_BUDGET }),
    mcpSessions: new Map(),
    mcpSpentMs: 0,
  });

  const rpcOk = (id: number, result: unknown) => new Response(
    JSON.stringify({ jsonrpc: '2.0', id, result }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  afterEach(() => vi.unstubAllGlobals());

  it('握手 + tools/call 直连 server.url，带 Bearer，结果 ok', async () => {
    const seen: Array<{ url: string; body: any; auth: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => {
      const body = JSON.parse(init.body);
      seen.push({ url: String(input), body, auth: new Headers(init.headers).get('Authorization') });
      if (body.method === 'initialize') {
        return rpcOk(body.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'p', version: '1' } });
      }
      if (String(body.method).startsWith('notifications/')) return new Response(null, { status: 202 });
      return rpcOk(body.id, { content: [{ type: 'text', text: '暗号 MARKER-123' }] });
    }));

    const result = await runMcpFireTool(stashFragment(), 'mcp__get_secret', {});

    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).toContain('MARKER-123');
    expect(seen.every((s) => s.url.startsWith('https://probe.example.com/mcp'))).toBe(true);
    expect(seen.every((s) => s.auth === 'Bearer tok-1')).toBe(true);
    expect(seen.map((s) => s.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
  });

  // 会话挂在单次 fire 的 stash 上；一次 fire 最多五轮，每轮都重握手就是白烧往返。
  it('同一 fire 内第二次调用复用 session（不重复握手）', async () => {
    let handshakes = 0;
    vi.stubGlobal('fetch', vi.fn(async (_: any, init: any) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        handshakes++;
        return rpcOk(body.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'p', version: '1' } });
      }
      if (String(body.method).startsWith('notifications/')) return new Response(null, { status: 202 });
      return rpcOk(body.id, { content: [{ type: 'text', text: 'x' }] });
    }));

    const stash = stashFragment();
    await runMcpFireTool(stash, 'mcp__get_secret', {});
    await runMcpFireTool(stash, 'mcp__get_secret', { a: 1 });

    expect(handshakes).toBe(1);
  });

  it('未配置的工具名 → ok:false 而不是抛错（回喂给模型圆场）', async () => {
    const result = await runMcpFireTool(stashFragment(), 'mcp__nope', {});
    expect(result).toMatchObject({ ok: false, reason: 'unknown_tool' });
  });

  it('服务器错误 → ok:false 带原因（不炸 fire 链）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const result = await runMcpFireTool(stashFragment(), 'mcp__get_secret', {});
    expect(result).toMatchObject({ ok: false, reason: 'mcp_error', source: '探针' });
  });

  // 单次超时之外还有一条全 fire 共享的总预算：native FC 一轮能吐好几个调用，
  // executeToolCalls 串行 await，只卡单次的话 25s × N 照样能顶穿 240s 总预算，
  // 那就是 AGENTIC_LOOP_EXCEEDED、任务不出清、下一分钟整条从头重跑。
  it('预算用尽 → 直接 ok:false 早退，一个请求都不发', async () => {
    const fetchSpy = vi.fn(async () => new Response('never', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const stash = { ...stashFragment(), mcpSpentMs: 120_000 };
    const result = await runMcpFireTool(stash, 'mcp__get_secret', {});

    expect(result).toMatchObject({ ok: false, reason: 'mcp_budget_exhausted', source: '探针' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('调用完把耗时记进 mcpSpentMs（后续调用才知道还剩多少）', async () => {
    // 假时钟：只在服务器回 tools/call 结果那一刻往前拨 700ms，模拟这次调用真的花了这么久。
    // 不用真等，也不受「这段代码一共读了几次 Date.now」影响。
    let clock = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.stubGlobal('fetch', vi.fn(async (_: any, init: any) => {
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        return rpcOk(body.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'p', version: '1' } });
      }
      if (String(body.method).startsWith('notifications/')) return new Response(null, { status: 202 });
      clock += 700;
      return rpcOk(body.id, { content: [{ type: 'text', text: 'x' }] });
    }));

    const stash = stashFragment();
    await runMcpFireTool(stash, 'mcp__get_secret', {});
    nowSpy.mockRestore();

    expect(stash.mcpSpentMs).toBe(700);
  });
});

// 回归守卫：主动消息的多轮连续性。
//
// fire_pack 的【最近对话上下文】停在「用户最后一次聊天」那一刻，用户离线期间不会刷新。
// 没有这条回写链的话，连着触发两次，角色第二次读到的上下文与第一次逐字一样——它不知道
// 自己刚说过什么，只会把同一句话换个说法再发一遍，而且全程不报错，静默退化成单轮。
// 下面这组用例是端到端的：真的跑两次 fire，第二次的 prompt 里必须出现第一次发的正文。
describe('self_log — 角色自述回写', () => {
  const CLIENT_TASK_ID = 'client-task-1';

  /** 带自述槽位的 fire_pack（当前客户端打的包长这样）。 */
  const slottedFirePack = (builtAt: number = PACK_BUILT_AT) => JSON.stringify({
    v: FIRE_PACK_VERSION,
    template: `【最近对话上下文】\n用户：先睡了${AMSG_SLOT_SELF_LOG}\n\n【本次任务】\n${AMSG_SLOT_TASK_INSTRUCTION}`,
    lastUserMessageAt: null,
    tzId: 'Asia/Shanghai',
    userTzId: 'Asia/Shanghai',
    targetName: '小明',
    builtAt,
    pendingTasks: [],
    scene: null,
    selfScheduleEnabled: true,
  });

  /** 会真的记住写入的假 client_state：第二次 fire 靠它读回第一次写下的自述。 */
  const makeStore = (firePack: string) => {
    const rows = new Map<string, string>([
      [AMSG_FIRE_PACK_KEY, firePack],
      [AMSG_TOOL_PACK_KEY, toolPackValue],
    ]);
    let writeFails = false;
    const readState = vi.fn(async (namespace: string) => (
      namespace.startsWith('amsg:char:')
        ? [...rows].map(([key, value]) => ({ key, value }))
        : [{ key: AMSG_TOOL_CONFIG_KEY, value: toolConfigValue }]
    ));
    const writeState = vi.fn(async (
      _namespace: string,
      entries: Array<{ key: string; value: string | null }>,
    ) => {
      if (writeFails) throw new Error('write failed');
      for (const entry of entries) {
        if (entry.value === null) rows.delete(entry.key);
        else rows.set(entry.key, entry.value);
      }
      return { upserted: entries.length, skipped: 0, deleted: 0 };
    });
    return {
      rows,
      readState,
      writeState,
      failWrites: () => { writeFails = true; },
      selfLog: () => parseSelfLog(rows.get(AMSG_SELF_LOG_KEY) ?? ''),
  };
};

const makePromptAuditDb = (initialRows: any[] = []) => {
  const auditRows = [...initialRows];
  const exec = async (sql: string, values: unknown[] = []) => {
    if (sql.includes('INSERT INTO prompt_audit_log')) {
      const [
        id, createdAt, expiresAt, charId, charName, taskUuid, taskRowId, clientTaskId,
        occurrenceMs, status, model, prompt, promptControlsJson, promptModulesJson,
        roundsJson, usageJson, outputText, error,
      ] = values;
      const row = {
        id, created_at: createdAt, expires_at: expiresAt, char_id: charId,
        char_name: charName, task_uuid: taskUuid, task_row_id: taskRowId,
        client_task_id: clientTaskId, occurrence_ms: occurrenceMs, status, model,
        prompt, prompt_controls_json: promptControlsJson, prompt_modules_json: promptModulesJson,
        rounds_json: roundsJson, usage_json: usageJson, output_text: outputText, error,
      };
      const index = auditRows.findIndex((item) => item.id === id);
      if (index >= 0) auditRows[index] = row;
      else auditRows.push(row);
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes('DELETE FROM prompt_audit_log')) {
      const deleted = sql.includes('WHERE expires_at <= ?')
        ? auditRows.filter((row) => Number(row.expires_at) <= Number(values[0])).length
        : auditRows.length;
      if (sql.includes('WHERE expires_at <= ?')) {
        const cutoff = Number(values[0]);
        for (let i = auditRows.length - 1; i >= 0; i -= 1) {
          if (Number(auditRows[i].expires_at) <= cutoff) auditRows.splice(i, 1);
        }
      } else {
        auditRows.length = 0;
      }
      return { success: true, meta: { changes: deleted } };
    }
    if (sql.includes('SELECT id, created_at')) {
      const limit = Number(values[0]) || 20;
      return { results: auditRows.slice(0, limit).map((row) => ({ ...row })) };
    }
    if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) {
      return { success: true, meta: { changes: 0 } };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  return {
    auditRows,
    prepare(sql: string) {
      return {
        bind: (...values: unknown[]) => ({ first: async () => exec(sql, values), all: async () => exec(sql, values), run: async () => exec(sql, values) }),
        first: async () => exec(sql, []),
        all: async () => exec(sql, []),
        run: async () => exec(sql, []),
      };
    },
  };
};

  /**
   * 跑一次完整的 fire：组 prompt → 交一段 LLM 输出 → 走完 finish → 模拟库发完推送后
   * 调 onAfterSend（amsg-server 2.6.0-next.10 的发送后回执；task 传 D1 行原样的最小
   * 子集，对号只看 id）。sentCount 缺省 = 全部段都送出去了；传数字模拟部分失败。
   * 返回这次实际发给 LLM 的 prompt，第二次调用时用它断言「接上了没有」。
   */
  const runFire = async (
    store: ReturnType<typeof makeStore>,
    opts: { sendAt: string; llmOutput: string; sentCount?: number; skipAfterSend?: boolean },
  ) => {
    const scratch: Record<string, unknown> = {};
    const fireCtx = {
      task: {
        id: 42,
        uuid: TASK_UUID,
        contactName: 'Nyah',
        recurrenceType: 'daily',
        nextSendAt: opts.sendAt,
        metadata: {
          charId: CHAR_ID,
          amsgExpirePolicy: 'force',
          amsgTaskInstruction: '想到什么说什么',
          amsgClientTaskId: CLIENT_TASK_ID,
        },
      },
      userId: 'u1',
      readState: store.readState,
      writeState: store.writeState,
      now: new Date(opts.sendAt),
      scratch,
    } as any;

    const prompt = fired(await amsgHooks.onBeforeFire(fireCtx)).messages[0].content;

    const decision = await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42@1',
      taskId: 42,
      taskUuid: TASK_UUID,
      llmResponse: {},
      llmOutputText: opts.llmOutput,
      contactName: 'Nyah',
      metadata: {
        charId: CHAR_ID,
        amsgClientTaskId: CLIENT_TASK_ID,
        amsgMode: 'auto',
      },
      scratch,
      writeState: store.writeState,
    } as any) as any;

    // 上游的 onFireSettled 无论这次 fire 是发出去了、跳过了还是抛错了都会调一次，
    // 这里照着来——只在 finish 分支调的话，验不到「没正文可发时角色自排的任务还落不落账」。
    if (!opts.skipAfterSend) {
      const sent = decision.decision === 'finish';
      const total = sent ? decision.pushPayloads.length : 0;
      await amsgFireSettled({
        status: sent ? 'sent' : 'skipped',
        sentCount: sent ? (opts.sentCount ?? total) : 0,
        scratch,
        writeState: store.writeState,
      });
    }

    return { prompt, decision, scratch };
  };

  it('第二次触发能看见第一次发了什么（核心回归守卫）', async () => {
    const store = makeStore(slottedFirePack());

    const first = await runFire(store, {
      sendAt: '2026-07-25T12:00:00.000Z',
      llmOutput: '刚看到楼下那只猫又来了',
    });
    expect(first.decision.decision).toBe('finish');
    expect(first.prompt, '第一次当然还没有自述').not.toContain('刚看到楼下那只猫又来了');

    const second = await runFire(store, {
      sendAt: '2026-07-25T14:00:00.000Z',
      llmOutput: '它蹲在那儿一直没走',
    });
    expect(second.prompt).toContain('刚看到楼下那只猫又来了');
    expect(second.prompt).toContain('【这之后你又发过（对方还没回）】');
    // 位置：夹在对话上下文和本次任务之间，别跑到指令后面被当成新指令读。
    expect(second.prompt.indexOf('刚看到楼下那只猫又来了'))
      .toBeLessThan(second.prompt.indexOf('想到什么说什么'));

    // 两次都记下了，第三次能一路接上去。
    expect(store.selfLog()?.entries.map((e) => e.text))
      .toEqual(['刚看到楼下那只猫又来了', '它蹲在那儿一直没走']);
  });

  it('多段消息合成一条记（用户那边是几条气泡，对角色是一次「我说了这些」）', async () => {
    const store = makeStore(slottedFirePack());
    await runFire(store, {
      sendAt: '2026-07-25T12:00:00.000Z',
      llmOutput: '喂\n在吗',
    });
    expect(store.selfLog()?.entries).toHaveLength(1);
    expect(store.selfLog()?.entries[0].text).toBe('喂\n在吗');
  });

  it('同一次触发重跑（投递失败重试）不会记成两条', async () => {
    const store = makeStore(slottedFirePack());
    const sendAt = '2026-07-25T12:00:00.000Z';
    await runFire(store, { sendAt, llmOutput: '第一次生成的话' });
    await runFire(store, { sendAt, llmOutput: '重跑时生成的话' });

    const entries = store.selfLog()?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0].text, '同 id 覆盖，留最后一次真正发出去的那份').toBe('重跑时生成的话');
  });

  it('客户端传了新 fire_pack → 旧正文不再重复渲染，但连发计数保留', async () => {
    const store = makeStore(slottedFirePack());
    await runFire(store, {
      sendAt: '2026-07-25T12:00:00.000Z',
      llmOutput: '刚看到楼下那只猫又来了',
    });

    // 客户端认领那条推送后重新打包上传（打脏即传）：新转写的对话记录里本来就含那条
    // 主动消息，正文不能再抄一遍；但用户并没有开口，连发计数必须留着——
    // 挂在换代上清零正是 2026-08 炸屏时连发提醒失效的回路。
    store.rows.set(AMSG_FIRE_PACK_KEY, slottedFirePack(Date.now() + 60_000));

    const next = await runFire(store, {
      sendAt: '2026-07-25T14:00:00.000Z',
      llmOutput: '那只猫今天还来吗',
    });
    expect(next.prompt).not.toContain('- 刚刚　刚看到楼下那只猫又来了');
    expect(next.prompt).toContain('你已连发 1 条');
    // 锚点跟上新的那份包（tasks 段作废），连发记录两条都在。
    expect(store.selfLog()?.entries.map((e) => e.text))
      .toEqual(['刚看到楼下那只猫又来了', '那只猫今天还来吗']);
  });

  // 对齐锚点是必填的，没有它自述日志无从判断新旧。所以缺锚点的包按「云端状态坏了」
  // 硬失败，而不是悄悄退回单轮——静默降级的话，多轮连续性没了也没人会发现。
  it('包里缺对齐锚点 → 抛错，不静默退回单轮', async () => {
    const store = makeStore(JSON.stringify({
      v: FIRE_PACK_VERSION,
      template: `【最近对话上下文】\n用户：先睡了${AMSG_SLOT_SELF_LOG}\n\n【本次任务】\n${AMSG_SLOT_TASK_INSTRUCTION}`,
      lastUserMessageAt: null,
      tzId: 'Asia/Shanghai',
      userTzId: 'Asia/Shanghai',
      targetName: '小明',
      pendingTasks: [],
      scene: null,
    }));
    await expect(runFire(store, {
      sendAt: '2026-07-25T12:00:00.000Z',
      llmOutput: '在干嘛呢',
    })).rejects.toThrow('AMSG2_FIRE_STATE_MISSING');
    expect(store.rows.has(AMSG_SELF_LOG_KEY)).toBe(false);
  });

  it('自述写不进去不连累这次投递（消息照发，只是下次接不上）', async () => {
    const store = makeStore(slottedFirePack());
    store.failWrites();
    const { decision } = await runFire(store, {
      sendAt: '2026-07-25T12:00:00.000Z',
      llmOutput: '在干嘛呢',
    });
    expect(decision.decision).toBe('finish');
    expect(decision.pushPayloads[0].message).toBe('在干嘛呢');
  });

  // ⑥ 的核心回归守卫：写库时机从「推送发出前」挪到「发出后」。旧实现在 onLLMOutput
  // 里就落盘——推送全挂时云端记了「说过」，下次 fire 角色接着一句用户根本没收到的话说。
  describe('发送后才写（onAfterSend 回执）', () => {
    it('onLLMOutput 只挂到 scratch 上不落盘；onAfterSend 才写库', async () => {
      const store = makeStore(slottedFirePack());
      const { decision, scratch } = await runFire(store, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: '刚看到楼下那只猫又来了',
        skipAfterSend: true,
      });
      expect(decision.decision).toBe('finish');
      expect(store.selfLog(), '推送还没发出去，不能已经记了「说过」').toBeNull();
      expect((scratch.fire as any).selfLogTexts).toEqual(['刚看到楼下那只猫又来了']);

      await amsgFireSettled({ sentCount: 1, scratch, writeState: store.writeState });
      expect(store.selfLog()?.entries.map((e) => e.text)).toEqual(['刚看到楼下那只猫又来了']);
      expect((scratch.fire as any).selfLogTexts, '认领后清空，重复回执不会记两遍').toBeNull();
    });

    it('部分失败：只把真送出去的前 sentCount 段写进日志，没送出去的正文不进', async () => {
      const store = makeStore(slottedFirePack());
      await runFire(store, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: '第一段送出去了\n第二段没送出去',
        sentCount: 1,
      });
      const entries = store.selfLog()?.entries ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0].text).toBe('第一段送出去了');
      expect(entries[0].text).not.toContain('第二段没送出去');
    });

    it('sentCount=0（推送全挂）不写——用户什么都没收到，云端不能记「说过」', async () => {
      const store = makeStore(slottedFirePack());
      const { scratch } = await runFire(store, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: '一段都没送出去的话',
        sentCount: 0,
      });
      expect(store.selfLog()).toBeNull();
      expect((scratch.fire as any).selfLogTexts, '认领过就清空，重试的下一条 fire 会重新生成').toBeNull();
    });

    it('entry.at 是实际发送时刻，不再是名义 occurrenceMs（cron 迟到半小时时名义时刻是谎话）', async () => {
      const store = makeStore(slottedFirePack());
      const before = Date.now();
      await runFire(store, {
        sendAt: '2026-07-25T12:00:00.000Z',   // 名义时刻在 2026 年
        llmOutput: '在干嘛呢',
      });
      const entry = store.selfLog()?.entries[0];
      expect(entry?.at).toBeGreaterThanOrEqual(before);
      expect(entry?.at).not.toBe(Date.parse('2026-07-25T12:00:00.000Z'));
      // 去重语义不动：id 仍是 clientTaskId@occurrenceMs。
      expect(entry?.id).toBe(`${CLIENT_TASK_ID}@${Date.parse('2026-07-25T12:00:00.000Z')}`);
    });

    // scratch 上没挂本次 fire 的记录：onBeforeFire 抛错、或者这次走的是 skip 出口。
    it('scratch 上没有本次 fire 的记录 → 不猜不写，也不炸', async () => {
      const store = makeStore(slottedFirePack());
      await runFire(store, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: '在干嘛呢',
        skipAfterSend: true,
      });
      await expect(amsgFireSettled({ sentCount: 1, scratch: {}, writeState: store.writeState }))
        .resolves.toBeUndefined();
      expect(store.selfLog()).toBeNull();
    });

    it('并发的两次 fire 各写各的——scratch 是每次 fire 独有的一份', async () => {
      const storeA = makeStore(slottedFirePack());
      const storeB = makeStore(slottedFirePack());
      const a = await runFire(storeA, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: 'A 的话',
        skipAfterSend: true,
      });
      const b = await runFire(storeB, {
        sendAt: '2026-07-25T12:00:00.000Z',
        llmOutput: 'B 的话',
        skipAfterSend: true,
      });

      await amsgFireSettled({ sentCount: 1, scratch: b.scratch, writeState: storeB.writeState });
      expect(storeB.selfLog()?.entries.map((e) => e.text)).toEqual(['B 的话']);
      expect(storeA.selfLog(), 'B 的回执不能把 A 的正文带走').toBeNull();

      await amsgFireSettled({ sentCount: 1, scratch: a.scratch, writeState: storeA.writeState });
      expect(storeA.selfLog()?.entries.map((e) => e.text)).toEqual(['A 的话']);
    });
  });
});

// 回归守卫：角色到点给自己排下一条。这是「连续自行回复」的触发端——上面那组 self_log
// 保证第二次知道第一次说了什么，这组保证第二次会自己发生。
describe('自排后续任务', () => {
  const makeStash = (over: Record<string, unknown> = {}) => ({
    session: { narrations: [], toolCalls: [], duplicateToolCalls: 0, mcpCallSeq: 0 },
    occurrenceMs: Date.parse('2026-07-25T12:00:00.000Z'),
    selfLog: {
      v: 4 as const, basePackAt: 1, anchorUserMsgAt: null, entries: [], unansweredSends: 0, tasks: [],
    },
    pendingTaskCount: 0,
    scheduledTasks: [],
    selfScheduleSeq: 0,
    cancelledTasks: [],
    charId: CHAR_ID,
    anchorMs: 1_700_000_000_000,
    tz: { tzId: 'Asia/Shanghai' },
    taskUuid: TASK_UUID,
    taskRowId: '42',
    instant: false,
    // 连发上限相关：单测夹具默认不限，上限行为由「连发上限」那组用例单独钉。
    maxUnansweredSends: Infinity,
    plannedSelfSends: 0,
    plannedSelfSendUuids: [],
    ...over,
  }) as any;

  const okSchedule = vi.fn(async (opts: any) => ({
    created: true as const, id: 7, uuid: opts.uuid, nextSendAt: opts.firstSendTime,
  }));
  const NOW_MS = Date.parse('2026-07-25T12:00:00.000Z');
  const sendAt = new Date(NOW_MS + 90 * 60_000).toISOString();

  afterEach(() => { okSchedule.mockClear(); });

  it('连发到上限：排程工具直接打回，一条任务都不建', async () => {
    const stash = makeStash({
      maxUnansweredSends: 3,
      selfLog: {
        v: 4, basePackAt: 1, anchorUserMsgAt: null, tasks: [], unansweredSends: 3,
        entries: [
          { id: 's@1', at: NOW_MS - 3 * 60_000, text: '一' },
          { id: 's@2', at: NOW_MS - 2 * 60_000, text: '二' },
          { id: 's@3', at: NOW_MS - 60_000, text: '三' },
        ],
      },
    });
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('unanswered_limit');
    expect(okSchedule).not.toHaveBeenCalled();
  });

  it('已发 2 条 + 先前自排的 1 条还没响，上限 3 → 第 4 条打回', async () => {
    const stash = makeStash({
      maxUnansweredSends: 3,
      plannedSelfSends: 1,
      selfLog: {
        v: 4, basePackAt: 1, anchorUserMsgAt: null, tasks: [], unansweredSends: 2,
        entries: [
          { id: 's@1', at: NOW_MS - 2 * 60_000, text: '一' },
          { id: 's@2', at: NOW_MS - 60_000, text: '二' },
        ],
      },
    });
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('unanswered_limit');
  });

  it('即时对话的回复不占连发额度：2 回复 + 2 主动，上限 3 → 还能排', async () => {
    const stash = makeStash({
      maxUnansweredSends: 3,
      selfLog: {
        v: 4, basePackAt: 1, anchorUserMsgAt: null, tasks: [], unansweredSends: 2,
        entries: [
          { id: 'r@1', at: NOW_MS - 4 * 60_000, text: '在的', reply: true },
          { id: 'r@2', at: NOW_MS - 3 * 60_000, text: '嗯嗯', reply: true },
          { id: 's@1', at: NOW_MS - 2 * 60_000, text: '一' },
          { id: 's@2', at: NOW_MS - 60_000, text: '二' },
        ],
      },
    });
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(true);
  });

  it('自排任务的 metadata 带 amsgSelfScheduled 标记（到点兜底闸认它）', async () => {
    const stash = makeStash();
    await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    expect(okSchedule.mock.calls[0][0].metadata.amsgSelfScheduled).toBe(true);
  });

  it('即时对话的回复记进 self_log 带 reply 标记，定时任务的不带', async () => {
    const written = async (stash: any) => {
      const writeState = vi.fn(async (
        _namespace: string,
        _entries: Array<{ key: string; value: string | null }>,
      ) => ({ upserted: 1, skipped: 0, deleted: 0 }));
      await amsgFireSettled({ status: 'sent', sentCount: 1, scratch: { fire: stash }, writeState } as any);
      const entries = writeState.mock.calls[0][1];
      return JSON.parse(String(entries.find((e) => e.key === AMSG_SELF_LOG_KEY)!.value));
    };
    const instantLog = await written(makeStash({ instant: true, selfLogTexts: ['嗯我在'] }));
    expect(instantLog.entries[0].reply).toBe(true);
    const timerLog = await written(makeStash({ selfLogTexts: ['突然想你了'] }));
    expect(timerLog.entries[0].reply).toBeUndefined();
  });

  it('排成功：任务落到远端，也记进自述日志供下次读回', async () => {
    const stash = makeStash();
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);

    expect(out.ok).toBe(true);
    expect(okSchedule).toHaveBeenCalledTimes(1);
    const opts = okSchedule.mock.calls[0][0];
    expect(opts.firstSendTime).toBe(sendAt);
    expect(opts.metadata.charId).toBe(CHAR_ID);
    // 到点那条要能走满血链路：任务指令、归属键、防穿帮字段一个都不能少
    expect(opts.metadata.amsgTaskInstruction).toBeTruthy();
    expect(opts.metadata.amsgClientTaskId).toBeTruthy();
    expect(opts.metadata.amsgExpirePolicy).toBe('expire');
    expect(opts.metadata.amsgAnchorMs).toBe(1_700_000_000_000);

    expect(stash.scheduledTasks).toHaveLength(1);
    expect(stash.selfLog.tasks).toHaveLength(1);
    expect(stash.selfLog.tasks[0].source).toBe('character');
  });

  // 回归守卫：排程清单里印给角色看的短 id 取的是 uuid 前 8 个字符。uuid 要是以固定字样
  // 开头（旧写法 `amsgself-…`），同一次 fire 排下的两条在清单里就印成一模一样的
  // `[amsgself]` —— 角色说「晚上那条不用了」，取消的却是早上那条，两边还都回 ok。
  it('同一次 fire 排的两条，清单里的短 id 不撞车', async () => {
    const stash = makeStash();
    await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    await runFireScheduleTool(
      stash, okSchedule, { send_at: new Date(NOW_MS + 8 * 3600_000).toISOString() }, NOW_MS);

    expect(stash.scheduledTasks).toHaveLength(2);
    const shortIds = stash.scheduledTasks.map((t: any) => shortTaskId(t.taskUuid));
    expect(new Set(shortIds).size, `两条印出来都是 ${shortIds[0]}`).toBe(2);
  });

  // 幽灵任务回归守卫：角色排了任务，但这轮最终一句话都没发出去（只做了副作用 / 空生成 /
  // 推送全挂）。任务在 scheduleTask 那一刻就真的建进 D1 了 —— 账要是没落下来，客户端认领
  // 不到、面板看不见、用户取消不掉，它却会一直按时发下去。
  it('这轮没发出任何正文时，角色自排的任务照样落进 self_log', async () => {
    const stash = makeStash();
    await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    expect(stash.selfLogDirty, '排完任务就该标记有未落盘改动').toBe(true);

    const writeState = vi.fn(async (
      _namespace: string,
      _entries: Array<{ key: string; value: string | null }>,
    ) => ({ upserted: 1, skipped: 0, deleted: 0 }));
    await amsgFireSettled({
      status: 'skipped', sentCount: 0, scratch: { fire: stash }, writeState,
    } as any);

    const entries = writeState.mock.calls[0][1];
    const written = JSON.parse(String(entries.find((e) => e.key === AMSG_SELF_LOG_KEY)!.value));
    expect(written.tasks).toHaveLength(1);
    expect(written.tasks[0].source).toBe('character');
    // 一段都没送出去 = 用户什么都没收到，不能记「我说过什么」
    expect(written.entries ?? []).toHaveLength(0);
  });

  it('什么都没添进日志时不写库（别为一次空 fire 白打一个请求）', async () => {
    const writeState = vi.fn(async (
      _namespace: string,
      _entries: Array<{ key: string; value: string | null }>,
    ) => ({ upserted: 1, skipped: 0, deleted: 0 }));
    await amsgFireSettled({
      status: 'skipped', sentCount: 0, scratch: { fire: makeStash() }, writeState,
    } as any);
    expect(writeState).not.toHaveBeenCalled();
  });

  // 即时对话这一跳挂了 → chat_fail 留痕：客户端点名判到「行已出清」后靠它向用户交代
  // 原因，不再按角色扫全量任务列表逐条解密（几秒起步 + 竞态窗口）。
  it('即时对话 fire 失败 → 原因写进 chat_fail（带 uuid 和重试计数）', async () => {
    const writeState = vi.fn(async (
      _namespace: string,
      _entries: Array<{ key: string; value: string | null }>,
    ) => ({ upserted: 1, skipped: 0, deleted: 0 }));
    await amsgFireSettled({
      status: 'failed', sentCount: 0,
      task: { retry_count: 3 },
      error: new Error('LLM HTTP 502'),
      scratch: { fire: makeStash({ instant: true }) }, writeState,
    } as any);

    const entries = writeState.mock.calls.flatMap((c) => c[1] as Array<{ key: string; value: string }>);
    const record = JSON.parse(String(entries.find((e) => e.key === 'chat_fail')!.value));
    expect(record.uuid).toBe(TASK_UUID);
    expect(record.reason).toBe('LLM HTTP 502');
    expect(record.retryCount).toBe(3);
  });

  it('定时任务 fire 失败不写 chat_fail（那条路走面板对账，不占即时通道）', async () => {
    const writeState = vi.fn(async (
      _namespace: string,
      _entries: Array<{ key: string; value: string | null }>,
    ) => ({ upserted: 1, skipped: 0, deleted: 0 }));
    await amsgFireSettled({
      status: 'failed', sentCount: 0, error: new Error('x'),
      scratch: { fire: makeStash() }, writeState,
    } as any);
    expect(writeState).not.toHaveBeenCalled();
  });

  /** 撞车回执：带上已存在那行的脱敏投影（上游 2.6.0-next.11 起）。 */
  const dupSchedule = (over: Record<string, unknown> = {}) => vi.fn(async (opts: any) => ({
    created: false as const,
    reason: 'duplicate' as const,
    uuid: opts.uuid,
    task: {
      nextSendAt: sendAt,
      recurrenceType: 'none',
      messageType: 'auto',
      clientTaskId: 'client-dup',
      ...over,
    },
  }));

  it('uuid 由触发时刻推出来 —— fire 重跑撞车不多排一条，但这一轮照样记账', async () => {
    const first = makeStash();
    await runFireScheduleTool(first, okSchedule, { send_at: sendAt }, NOW_MS);
    const uuidA = okSchedule.mock.calls[0][0].uuid;

    // 同一次触发重跑：新 stash（fire 重跑会重新挂 scratch），uuid 应该一模一样。
    // 重跑的起因通常是投递失败——上一轮记的账随那次失败一起没了。这一轮再不记，任务
    // 就只活在 D1 里：随 push 带不回客户端、面板列不出来、用户也取消不掉。
    okSchedule.mockClear();
    const retry = makeStash();
    const remoteSendAt = new Date(NOW_MS + 95 * 60_000).toISOString();
    const dup = dupSchedule({ nextSendAt: remoteSendAt });
    const out = await runFireScheduleTool(retry, dup, { send_at: sendAt }, NOW_MS);

    expect(dup.mock.calls[0][0].uuid).toBe(uuidA);
    expect(out.ok, '撞车对模型来说结果一样：那条确实排上了').toBe(true);
    expect(out.already_scheduled).toBe(true);
    expect(retry.scheduledTasks, '这一轮也要记下来').toHaveLength(1);
    expect(retry.selfLog.tasks).toHaveLength(1);
    // 真正会响的是远端那行的时间，不是这一轮模型想改成的那个。
    expect(retry.scheduledTasks[0].firstSendTime).toBe(remoteSendAt);
    expect(out.send_at).toBe(remoteSendAt);
  });

  // uuid 的序号取自「这一轮已经排了几条」。撞车不记账的话序号不涨，同一轮里第二次排
  // 会算出同一个 uuid、再撞一次——模型以为排了两条，实际只有一条。
  it('撞车之后序号照涨：同一轮第二次排的是新任务，不是又撞回同一条', async () => {
    const stash = makeStash();
    const dup = dupSchedule();
    await runFireScheduleTool(stash, dup, { send_at: sendAt }, NOW_MS);
    await runFireScheduleTool(
      stash, dup, { send_at: new Date(NOW_MS + 150 * 60_000).toISOString() }, NOW_MS);

    const uuids = dup.mock.calls.map((c: any[]) => c[0].uuid);
    expect(new Set(uuids).size, '两次调用不能落到同一个 uuid 上').toBe(2);
  });

  it('单次 fire 排满就打回，不再调远端', async () => {
    const stash = makeStash();
    for (let i = 0; i < MAX_FIRE_SCHEDULES; i += 1) {
      await runFireScheduleTool(stash, okSchedule, { send_at: new Date(NOW_MS + (90 + i) * 60_000).toISOString() }, NOW_MS);
    }
    okSchedule.mockClear();
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('fire_limit');
    expect(okSchedule).not.toHaveBeenCalled();
  });

  it('角色挂着的任务已经到上限 → 打回（离线连排也绕不过每角色上限）', async () => {
    const stash = makeStash({ pendingTaskCount: MAX_ACTIVE_TASKS_PER_CHAR });
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('task_limit');
    expect(okSchedule).not.toHaveBeenCalled();
  });

  it('参数写歪 → 回喂一句能照做的话，不抛错（抛错等于整条任务重跑）', async () => {
    const stash = makeStash();
    const out = await runFireScheduleTool(stash, okSchedule, { send_at: '明天' }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(String(out.message)).toContain('墙钟');
    expect(okSchedule).not.toHaveBeenCalled();
  });

  // ③ 在 fire 工具入口的落地：角色写的裸墙钟按 stash.tz（fire_pack 的参照系）解析。
  it('裸 send_at 按角色时区解析（UTC 运行时不再差一个时差）', async () => {
    const stash = makeStash();   // Asia/Shanghai
    const out = await runFireScheduleTool(
      stash, okSchedule, { send_at: '2026-07-26T09:00:00' }, NOW_MS,
    );
    expect(out.ok).toBe(true);
    // 上海墙钟 07-26 09:00 = 01:00Z。旧行为（按 UTC 解析）会给 09:00Z，差 8 小时。
    expect(okSchedule.mock.calls[0][0].firstSendTime).toBe('2026-07-26T01:00:00.000Z');
  });

  it('上游护栏抛错 → 转成回喂，不连累这次投递', async () => {
    const stash = makeStash();
    const boom = vi.fn(async () => { throw new RangeError('firstSendTime 至少要比现在晚 60 秒'); });
    const out = await runFireScheduleTool(stash, boom as any, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('schedule_rejected');
    expect(String(out.message)).toContain('60 秒');
  });

  it('老部署没有这个口子 → 明确告诉角色排不了，别让它承诺了又没下文', async () => {
    const out = await runFireScheduleTool(makeStash(), undefined, { send_at: sendAt }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not_supported');
  });
});

describe('attachScheduledTasks', () => {
  const task = { taskUuid: 'u1', clientTaskId: 'c1' } as any;

  it('挂在最后一条 push 上（与 directives 同位置，收侧只重放一次）', () => {
    const out = attachScheduledTasks(
      [{ message: 'a', metadata: { charId: CHAR_ID } }, { message: 'b', metadata: { charId: CHAR_ID } }],
      [task],
    );
    expect((out[0].metadata as any).amsgSelfScheduled).toBeUndefined();
    expect((out[1].metadata as any).amsgSelfScheduled).toEqual([task]);
    expect((out[1].metadata as any).charId, '原有 metadata 不能被顶掉').toBe(CHAR_ID);
  });

  it('没排任务 / 没有 push 时原样返回', () => {
    const payloads = [{ message: 'a' }];
    expect(attachScheduledTasks(payloads, [])).toBe(payloads);
    expect(attachScheduledTasks([], [task])).toEqual([]);
  });
});

// 取消 / 改期开到 fire 侧（amsg-server 2.6.0-next.15 的 ctx.cancelTask / renewTask）。
// 语义与前台同名工具对齐：短 id 指定、只有一条时可省略；账目两头消
// （selfLog.tasks + 随末条 push 的 amsgTaskMutations 回客户端）。
describe('fire 侧取消 / 改期任务', () => {
  const NOW_MS = Date.parse('2026-07-25T12:00:00.000Z');
  const taskRec = (uuid: string, over: Record<string, unknown> = {}) => ({
    taskUuid: uuid,
    clientTaskId: `${uuid}-c`,
    mode: 'auto',
    firstSendTime: new Date(NOW_MS + 3600_000).toISOString(),
    recurrenceType: 'none',
    expirePolicy: 'expire',
    source: 'user',
    status: 'scheduled',
    createdAt: NOW_MS - 3600_000,
    ...over,
  }) as any;

  const makeStash = (over: Record<string, unknown> = {}) => ({
    session: { narrations: [], toolCalls: [], duplicateToolCalls: 0, mcpCallSeq: 0 },
    toolCtx: { char: { name: 'Nyah' } },
    occurrenceMs: NOW_MS,
    selfLog: {
      v: 4 as const, basePackAt: 1, anchorUserMsgAt: null, entries: [], unansweredSends: 0, tasks: [],
    },
    pendingTaskCount: 0,
    pendingTasks: [],
    scheduledTasks: [],
    selfScheduleSeq: 0,
    cancelledTasks: [],
    renewedTasks: [],
    charId: CHAR_ID,
    anchorMs: 1_700_000_000_000,
    tz: { tzId: 'Asia/Shanghai' },
    taskUuid: TASK_UUID,
    taskRowId: '42',
    instant: false,
    maxUnansweredSends: Infinity,
    plannedSelfSends: 0,
    plannedSelfSendUuids: [],
    ...over,
  }) as any;

  const okCancel = () => vi.fn(async (_uuid: string) => ({ cancelled: true }));
  const okRenew = () => vi.fn(async (uuid: string, nextSendAt: string) => ({
    renewed: true as const, uuid, nextSendAt,
  }));
  const newSendAt = new Date(NOW_MS + 2 * 3600_000).toISOString();

  it('短 id 找目标、全 uuid 传给 ctx.cancelTask，账记进 cancelledTasks', async () => {
    const cancel = okCancel();
    const stash = makeStash({ pendingTasks: [taskRec('11112222-aaaa-4bbb-8ccc-000000000001')] });
    const out = await runFireCancelTool(stash, cancel, { task_id: '11112222' }, NOW_MS);
    expect(out.ok).toBe(true);
    expect(cancel).toHaveBeenCalledWith('11112222-aaaa-4bbb-8ccc-000000000001');
    expect(stash.cancelledTasks).toEqual(['11112222-aaaa-4bbb-8ccc-000000000001']);
  });

  it('只有一条时可省略 task_id；多条时打回 ambiguous、一条都不动', async () => {
    const cancel = okCancel();
    const one = makeStash({ pendingTasks: [taskRec('u-only')] });
    expect((await runFireCancelTool(one, cancel, {}, NOW_MS)).ok).toBe(true);

    const many = makeStash({ pendingTasks: [taskRec('u-a'), taskRec('u-b')] });
    const out = await runFireCancelTool(many, cancel, {}, NOW_MS);
    expect(out.reason).toBe('ambiguous_task');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  // 与前台 resolveTargetTask 对齐的回归守卫：清单快照里混着一条已过点变陈旧的一次性
  // 任务（pack 只在打包那一刻筛过 pending）时，不带 task_id 也能锁定唯一还活着的那条。
  // 不复筛的话，同一句 cancel_active_message 本地能成、云端却被打回 ambiguous_task。
  it('快照里混着过点的陈旧任务 → 不带 task_id 仍锁定唯一 pending 那条', async () => {
    const cancel = okCancel();
    const stale = taskRec('u-stale', { firstSendTime: new Date(NOW_MS - 2 * 3600_000).toISOString() });
    const stash = makeStash({ pendingTasks: [stale, taskRec('u-live')] });
    const out = await runFireCancelTool(stash, cancel, {}, NOW_MS);
    expect(out.ok).toBe(true);
    expect(cancel).toHaveBeenCalledWith('u-live');
  });

  it('当前正在 fire 的这条不在可取消视图里（它的收尾归 run-tick 管）', async () => {
    const cancel = okCancel();
    const stash = makeStash({ pendingTasks: [taskRec(TASK_UUID)] });
    const out = await runFireCancelTool(stash, cancel, { task_id: TASK_UUID.slice(0, 8) }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  // 撞车守卫（配合自排 uuid 那条）：万一哪天两条任务的短 id 又长一样了，宁可打回让角色
  // 重说一次，也不能挑一条删了 —— 删错的那条无声无息地没了，说好要响的那条照样响。
  it('两条任务共用一个短 id → 打回 ambiguous_task，远端一次都不调', async () => {
    const cancel = okCancel();
    const stash = makeStash({
      pendingTasks: [taskRec('samehead-aaaa-1'), taskRec('samehead-bbbb-2')],
    });
    const out = await runFireCancelTool(stash, cancel, { task_id: 'samehead' }, NOW_MS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('ambiguous_task');
    expect(cancel).not.toHaveBeenCalled();
    expect(stash.cancelledTasks).toEqual([]);
    // 打回的话要能照做：带上两条各自的完整 id，角色下一轮指得准
    expect(String(out.message)).toContain('samehead-aaaa-1');
    expect(String(out.message)).toContain('samehead-bbbb-2');
  });

  it('改期同样不猜：短 id 撞车时打回，不去改另一条的时间', async () => {
    const renew = okRenew();
    const stash = makeStash({
      pendingTasks: [taskRec('samehead-aaaa-1'), taskRec('samehead-bbbb-2')],
    });
    const out = await runFireRenewTool(
      stash, { renewTask: renew }, { task_id: 'samehead', send_at: newSendAt }, NOW_MS);
    expect(out.reason).toBe('ambiguous_task');
    expect(renew).not.toHaveBeenCalled();
  });

  it('取消掉 selfLog 里备着账的自排任务：日志同步摘除并打脏', async () => {
    const rec = taskRec('u-selflog', { source: 'character' });
    const stash = makeStash({
      pendingTasks: [rec],
      selfLog: {
        v: 4, basePackAt: 1, anchorUserMsgAt: null, entries: [], unansweredSends: 0, tasks: [rec],
      },
    });
    await runFireCancelTool(stash, okCancel(), { task_id: 'u-selflog' }, NOW_MS);
    expect(stash.selfLog.tasks).toEqual([]);
    expect(stash.selfLogDirty).toBe(true);
  });

  it('本轮刚排的那条允许当场反悔：scheduledTasks 一并摘掉', async () => {
    const rec = taskRec('u-fresh', { source: 'character' });
    const stash = makeStash({ scheduledTasks: [rec] });
    const out = await runFireCancelTool(stash, okCancel(), { task_id: 'u-fresh' }, NOW_MS);
    expect(out.ok).toBe(true);
    expect(stash.scheduledTasks).toEqual([]);
  });

  // uuid 序号只增不减的回归守卫：取消会让 scheduledTasks 回缩，序号要是取数组长度，
  // 「排A→排B→取消A→排C」时 C 会算出和还活着的 B 一样的 uuid——createTask 报 duplicate
  // 被当成 fire 重跑，回 ok:true already_scheduled，C 实际不存在却告诉模型排上了。
  it('排A→排B→取消A→排C：三个 uuid 互不相同，C 是真新建的', async () => {
    const schedule = vi.fn(async (o: any) => ({
      created: true as const, id: 7, uuid: o.uuid, nextSendAt: o.firstSendTime,
    }));
    const stash = makeStash();
    await runFireScheduleTool(
      stash, schedule, { send_at: new Date(NOW_MS + 90 * 60_000).toISOString() }, NOW_MS);
    await runFireScheduleTool(
      stash, schedule, { send_at: new Date(NOW_MS + 120 * 60_000).toISOString() }, NOW_MS);
    const uuidA = schedule.mock.calls[0][0].uuid;
    await runFireCancelTool(stash, okCancel(), { task_id: uuidA }, NOW_MS);
    const outC = await runFireScheduleTool(
      stash, schedule, { send_at: new Date(NOW_MS + 150 * 60_000).toISOString() }, NOW_MS);

    const uuids = schedule.mock.calls.map((c: any[]) => c[0].uuid);
    expect(new Set(uuids).size, 'C 不能撞上还活着的 B 的 uuid').toBe(3);
    expect(outC.ok).toBe(true);
    expect(outC.already_scheduled, 'C 是真新建的，不是被撞车话术糊过去').toBeUndefined();
  });

  // 另一变体：排A→取消A→排B。序号回退的话 B 会复用 A 的 uuid，而 A 已在
  // cancelledTasks 里——客户端消账时会把 B 当成已取消删掉，B 成了幽灵任务。
  it('排A→取消A→排B：B 不复用 A 的 uuid（不落进 cancelledTasks）', async () => {
    const schedule = vi.fn(async (o: any) => ({
      created: true as const, id: 7, uuid: o.uuid, nextSendAt: o.firstSendTime,
    }));
    const stash = makeStash();
    await runFireScheduleTool(
      stash, schedule, { send_at: new Date(NOW_MS + 90 * 60_000).toISOString() }, NOW_MS);
    const uuidA = schedule.mock.calls[0][0].uuid;
    await runFireCancelTool(stash, okCancel(), { task_id: uuidA }, NOW_MS);
    await runFireScheduleTool(
      stash, schedule, { send_at: new Date(NOW_MS + 120 * 60_000).toISOString() }, NOW_MS);

    const uuidB = schedule.mock.calls[1][0].uuid;
    expect(uuidB).not.toBe(uuidA);
    expect(stash.cancelledTasks).toEqual([uuidA]);
    expect(stash.cancelledTasks).not.toContain(uuidB);
  });

  // 连发闸退额度的回归守卫：3 条 pending 打满上限时，提示词教的「cancel + 重排」要能
  // 落地——取消掉快照里的任务把额度还回来，重排 1 条放行；额度只是中性不是解锁，
  // 紧接着第 2 条仍要被闸。
  it('取消退还连发额度：cancel 1 条后重排 1 条放行，第 2 条仍被闸', async () => {
    const schedule = vi.fn(async (o: any) => ({
      created: true as const, id: 7, uuid: o.uuid, nextSendAt: o.firstSendTime,
    }));
    const planned = [
      taskRec('u-plan-1', { source: 'character' }),
      taskRec('u-plan-2', { source: 'character' }),
      taskRec('u-plan-3', { source: 'character' }),
    ];
    const stash = makeStash({
      maxUnansweredSends: 3,
      pendingTasks: planned,
      pendingTaskCount: planned.length,
      plannedSelfSends: planned.length,
      plannedSelfSendUuids: planned.map((t: any) => t.taskUuid),
    });
    const sendAt = new Date(NOW_MS + 90 * 60_000).toISOString();

    // 先钉住闸还在收：打满时直接排要被打回（不然下面的放行可能是闸整个失效）
    const blockedFull = await runFireScheduleTool(stash, schedule, { send_at: sendAt }, NOW_MS);
    expect(blockedFull.reason).toBe('unanswered_limit');

    await runFireCancelTool(stash, okCancel(), { task_id: 'u-plan-1' }, NOW_MS);
    const rescheduled = await runFireScheduleTool(stash, schedule, { send_at: sendAt }, NOW_MS);
    expect(rescheduled.ok, '取消 1 条后额度该还回来').toBe(true);

    const blockedAgain = await runFireScheduleTool(
      stash, schedule, { send_at: new Date(NOW_MS + 120 * 60_000).toISOString() }, NOW_MS);
    expect(blockedAgain.ok).toBe(false);
    expect(blockedAgain.reason).toBe('unanswered_limit');
  });

  it('行已经不在了（cancelled:false）→ 照实说、不记账', async () => {
    const cancel = vi.fn(async () => ({ cancelled: false }));
    const stash = makeStash({ pendingTasks: [taskRec('u-gone')] });
    const out = await runFireCancelTool(stash, cancel, { task_id: 'u-gone' }, NOW_MS);
    expect(out.ok).toBe(true);
    expect(out.already_gone).toBe(true);
    expect(stash.cancelledTasks).toEqual([]);
  });

  it('老部署没有 ctx.cancelTask → not_supported，一句能照做的话', async () => {
    const out = await runFireCancelTool(makeStash({ pendingTasks: [taskRec('u-x')] }), undefined, {}, NOW_MS);
    expect(out.reason).toBe('not_supported');
  });

  it('一次性任务改期：ctx.renewTask 原地换时间，账记进 renewedTasks、selfLog 跟着改', async () => {
    const rec = taskRec('u-renew', { source: 'character' });
    const renew = okRenew();
    const stash = makeStash({
      pendingTasks: [rec],
      selfLog: {
        v: 4, basePackAt: 1, anchorUserMsgAt: null, entries: [], unansweredSends: 0, tasks: [rec],
      },
    });
    const out = await runFireRenewTool(stash, { renewTask: renew }, { send_at: newSendAt }, NOW_MS);
    expect(out.ok).toBe(true);
    expect(renew).toHaveBeenCalledWith('u-renew', newSendAt);
    expect(stash.renewedTasks).toEqual([{ taskUuid: 'u-renew', sendAt: newSendAt }]);
    expect(stash.selfLog.tasks[0].firstSendTime).toBe(newSendAt);
  });

  it('循环任务改期 = 补发一条一次性（走排程工具的完整入口），原序列不动', async () => {
    const renew = okRenew();
    const schedule = vi.fn(async (o: any) => ({
      created: true as const, id: 7, uuid: o.uuid, nextSendAt: o.firstSendTime,
    }));
    const rec = taskRec('u-daily', { recurrenceType: 'daily', promptHint: '说早安' });
    const stash = makeStash({ pendingTasks: [rec] });
    const out = await runFireRenewTool(
      stash, { renewTask: renew, scheduleTask: schedule }, { send_at: newSendAt }, NOW_MS);
    expect(out.ok).toBe(true);
    expect(renew).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][0].recurrenceType).toBe('none');
    expect(schedule.mock.calls[0][0].metadata.amsgTaskInstruction).toContain('说早安');
    // 原序列没被记成取消或改期
    expect(stash.cancelledTasks).toEqual([]);
    expect(stash.renewedTasks).toEqual([]);
  });

  it('fixed 任务不让动；send_at 太近打回；行没了回 task_gone', async () => {
    const fixedOut = await runFireRenewTool(
      makeStash({ pendingTasks: [taskRec('u-fx', { mode: 'fixed' })] }),
      { renewTask: okRenew() }, { send_at: newSendAt }, NOW_MS);
    expect(fixedOut.reason).toBe('fixed_task');

    const soonOut = await runFireRenewTool(
      makeStash({ pendingTasks: [taskRec('u-soon')] }),
      { renewTask: okRenew() }, { send_at: new Date(NOW_MS + 10_000).toISOString() }, NOW_MS);
    expect(soonOut.reason).toBe('send_at_too_soon');

    const gone = vi.fn(async () => ({ renewed: false as const, reason: 'not_found' }));
    const goneOut = await runFireRenewTool(
      makeStash({ pendingTasks: [taskRec('u-gone2')] }),
      { renewTask: gone }, { send_at: newSendAt }, NOW_MS);
    expect(goneOut.reason).toBe('task_gone');
  });

  it('usage 随末条 push 的 amsgUsage 回客户端（只挑两个数，不透传供应商私有字段）', async () => {
    const stash = makeStash({ instant: true });
    const decision = await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42', taskId: FIRE_TASK_ID, taskUuid: TASK_UUID,
      llmResponse: {}, llmOutputText: '在的。', contactName: 'Nyah',
      metadata: { charId: CHAR_ID, amsgClientTaskId: 'ct-u', amsgMode: 'instant', amsgInstantChat: true },
      scratch: { fire: stash },
      usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290, provider_secret_detail: 'x' },
      writeState: vi.fn(async () => ({ upserted: 1, skipped: 0, deleted: 0 })),
    } as any) as any;
    const last = decision.pushPayloads[decision.pushPayloads.length - 1];
    expect(last.metadata.amsgUsage).toEqual({ promptTokens: 1234, completionTokens: 56 });
  });

  it('取消 / 改期的账随末条 push 的 amsgTaskMutations 回客户端（首条不带）', async () => {
    const stash = makeStash({
      cancelledTasks: ['u-cancelled'],
      renewedTasks: [{ taskUuid: 'u-renewed', sendAt: newSendAt }],
    });
    const decision = await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42', taskId: FIRE_TASK_ID, taskUuid: TASK_UUID,
      llmResponse: {}, llmOutputText: '好，改好了。\n到时候见。', contactName: 'Nyah',
      metadata: { charId: CHAR_ID, amsgClientTaskId: 'ct-1', amsgMode: 'auto' },
      scratch: { fire: stash },
      writeState: vi.fn(async () => ({ upserted: 1, skipped: 0, deleted: 0 })),
    } as any) as any;
    expect(decision.pushPayloads).toHaveLength(2);
    expect(decision.pushPayloads[0].metadata.amsgTaskMutations).toBeUndefined();
    expect(decision.pushPayloads[1].metadata.amsgTaskMutations).toEqual({
      cancelled: ['u-cancelled'],
      renewed: [{ taskUuid: 'u-renewed', sendAt: newSendAt }],
    });
  });
});

// ⑤ 没发出去也留痕：模型返回空 / 纯拒答、或者只做了副作用没说话时，上游都把任务当成功
// 消费，面板过去无从解释。现在 skip-push 分支写一条 last_skip，两种成因分开记。
describe('没发出去时写 last_skip', () => {
  const runEmptyFire = async (opts: { writeStateFails?: boolean; llmOutputText?: string } = {}) => {
    const { ctx, scratch, writeState } = makeCtx({ writeStateFails: opts.writeStateFails });
    await amsgHooks.onBeforeFire(ctx);
    const decision = await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42',
      llmResponse: {},
      llmOutputText: opts.llmOutputText ?? '',
      contactName: 'Nyah',
      metadata: { charId: CHAR_ID, amsgClientTaskId: 'client-task-1', amsgMode: 'auto' },
      scratch,
      writeState,
    } as any);
    return { decision: decision as any, writeState };
  };

  it('空输出 → skip-push 且写 last_skip（reason: empty-generation，带任务定位）', async () => {
    const { decision, writeState } = await runEmptyFire();
    expect(decision.decision).toBe('skip-push');

    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(call, '应该写过 last_skip').toBeTruthy();
    const skip = JSON.parse(String(call![1][0].value));
    expect(skip.reason).toBe('empty-generation');
    expect(skip.taskUuid).toBe(TASK_UUID);
    expect(skip.occurrenceMs).toBe(Date.parse('2026-07-25T12:00:00.000Z'));
  });

  // 只做事不说话的那一轮：空正文 push 的 banner body 也是空的，用户锁屏会收到一条
  // 只有标题的空横幅、未读 +1、点进去 0 气泡。整条不发，副作用一起放弃。
  it('只有副作用标签没有正文 → skip-push 且写 last_skip（reason: side-effects-only）', async () => {
    const { decision, writeState } = await runEmptyFire({ llmOutputText: '[[ACTION:POKE]]' });
    expect(decision.decision).toBe('skip-push');

    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(call, '应该写过 last_skip').toBeTruthy();
    expect(JSON.parse(String(call![1][0].value)).reason).toBe('side-effects-only');
  });

  it('留痕写失败不影响 skip 本身（best-effort）', async () => {
    const { decision } = await runEmptyFire({ writeStateFails: true });
    expect(decision.decision).toBe('skip-push');
  });

  // 即时对话被 skip 时一次性行会被上游当成功消费删掉，客户端点名只能看到 gone + 空
  // outbox——不写 chat_fail 的话，给用户的解释是「回复没能取回」，把「没生成出来」说成
  // 了「取不回」。定时任务不用写：那条路没有人在等着销账，last_skip 就够面板解释了。
  it('即时对话空输出 → 除 last_skip 外还写 chat_fail（认 uuid，客户端 gone 分支照实解释）', async () => {
    const { ctx, scratch, writeState } = makeCtx({
      metadata: { amsgInstantChat: true, amsgMode: 'instant', amsgTaskInstruction: undefined },
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(null, { chat: { messages: [{ role: 'user', content: '在吗' }], builtAt: PACK_BUILT_AT } }) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await amsgHooks.onBeforeFire(ctx);
    const decision = await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42',
      llmResponse: {},
      llmOutputText: '',
      contactName: 'Nyah',
      metadata: { charId: CHAR_ID, amsgClientTaskId: 'client-task-1', amsgMode: 'instant', amsgInstantChat: true },
      scratch,
      writeState,
    } as any);
    expect((decision as any).decision).toBe('skip-push');

    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_CHAT_FAIL_KEY));
    expect(call, '应该写过 chat_fail').toBeTruthy();
    const fail = JSON.parse(String(call![1].find((e: { key: string }) => e.key === AMSG_CHAT_FAIL_KEY)!.value));
    expect(fail.uuid).toBe(TASK_UUID);
    expect(fail.reason).toBe('empty-generation');
  });

  it('定时任务空输出 → 只写 last_skip，不写 chat_fail', async () => {
    const { writeState } = await runEmptyFire();
    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_CHAT_FAIL_KEY));
    expect(call).toBeFalsy();
  });

  it('正常出正文的 fire 不写 empty-generation', async () => {
    const { ctx, scratch, writeState } = makeCtx({});
    await amsgHooks.onBeforeFire(ctx);
    await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42',
      llmResponse: {},
      llmOutputText: '在干嘛呢',
      contactName: 'Nyah',
      metadata: { charId: CHAR_ID, amsgClientTaskId: 'client-task-1', amsgMode: 'auto' },
      scratch,
      writeState,
    } as any);
    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e: { key: string }) => e.key === AMSG_LAST_SKIP_KEY));
    expect(call).toBeUndefined();
  });
});

// 推送横幅上的名字：任务行里那份是排程当天冻进去的，用户改名之后不会跟着变（上游
// update-message 的可写字段里也没有它）。tool_pack 每轮聊天都重新上云，所以以它为准。
describe('推送标题跟着当前角色名', () => {
  it('tool_pack 的 charName 盖过任务行冻结的 contactName', async () => {
    const { ctx, scratch, writeState } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        {
          key: AMSG_TOOL_PACK_KEY,
          value: JSON.stringify({
            v: 1, charName: '夜', xhsEnabled: false, activeMemoryMonths: [], memories: [],
            timeAwarenessEnabled: true,
          }),
        },
      ],
    });
    await amsgHooks.onBeforeFire(ctx);
    const decision = await amsgHooks.onLLMOutput({
      sessionId: 'sess_task_42',
      llmResponse: {},
      llmOutputText: '睡了吗',
      contactName: 'Nyah',   // 任务行还顶着改名前的旧名字
      metadata: { charId: CHAR_ID, amsgClientTaskId: 'client-task-1', amsgMode: 'auto' },
      scratch,
      writeState,
    } as any) as any;

    expect(decision.decision).toBe('finish');
    expect(decision.pushPayloads[0].title).toBe('来自 夜');
    expect(decision.pushPayloads[0].contactName).toBe('夜');
  });
});

// ⑥ stale 守卫消费端：上游过期不补发时调 onStaleSkip(task, info)，这里写 last_skip
// 让面板能解释「说好的消息为什么凭空消失」。
describe('stale 跳过留痕（onStaleSkip）', () => {
  const TASK_ROW_UUID = '3637dae1-1461-4444-a747-34e406f67acc';
  type SkipEntry = { key: string; value: string | null };
  const makeWriteState = () => vi.fn(
    async (_namespace: string, _entries: SkipEntry[]) => ({ upserted: 1, skipped: 0, deleted: 0 }));
  const lastSkipOf = (writeState: ReturnType<typeof makeWriteState>) => {
    const call = writeState.mock.calls.find(([, entries]) =>
      entries.some((e) => e.key === AMSG_LAST_SKIP_KEY));
    return call
      ? { namespace: call[0], skip: JSON.parse(String(call[1][0].value)) }
      : null;
  };

  it('charId 取 info.metadata.charId，写 reason: stale + 那一次的名义触发时刻', async () => {
    const writeState = makeWriteState();
    const occurrence = '2026-07-25T09:00:00.000Z';
    await amsgStaleSkip(
      { id: 101, uuid: TASK_ROW_UUID },
      {
        reason: 'stale',
        action: 'expired',
        metadata: { charId: CHAR_ID },
        occurrenceMs: Date.parse(occurrence),
        skippedCount: 1,
        nextSendAt: null,
        writeState,
      },
    );
    const written = lastSkipOf(writeState);
    expect(written, '应该写过 last_skip').toBeTruthy();
    expect(written!.namespace).toBe(amsgStateNamespace(CHAR_ID));
    expect(written!.skip.reason).toBe('stale');
    expect(written!.skip.occurrenceMs).toBe(Date.parse(occurrence));
    expect(written!.skip.staleAction).toBe('expired');
  });

  // 循环任务的快进跳过也会调这个 hook。跟一次性任务的过期混为一谈的话，每日提醒断更
  // 一天会被面板说成「已经彻底没了」——而它下一次照常响。
  it('循环任务快进：记 fast_forwarded + 跳过次数 + 快进到的下一次', async () => {
    const writeState = makeWriteState();
    await amsgStaleSkip(
      { id: 102, uuid: TASK_ROW_UUID },
      {
        reason: 'stale',
        action: 'fast_forwarded',
        metadata: { charId: CHAR_ID },
        occurrenceMs: Date.parse('2026-07-25T09:00:00.000Z'),
        skippedCount: 4,
        nextSendAt: '2026-07-29T09:00:00.000Z',
        writeState,
      },
    );
    const written = lastSkipOf(writeState);
    expect(written!.skip.staleAction).toBe('fast_forwarded');
    expect(written!.skip.skippedCount).toBe(4);
    expect(written!.skip.nextSendAtMs).toBe(Date.parse('2026-07-29T09:00:00.000Z'));
    // 记的是最早被跳过的那一次，不是快进之后的时间。
    expect(written!.skip.occurrenceMs).toBe(Date.parse('2026-07-25T09:00:00.000Z'));
  });

  it('metadata 缺 charId（真异常）→ warn 放弃留痕，不写也不炸', async () => {
    const writeState = makeWriteState();
    await expect(amsgStaleSkip(
      { id: 100, uuid: TASK_ROW_UUID },
      {
        reason: 'stale',
        action: 'expired',
        metadata: null,
        occurrenceMs: Date.parse('2026-07-25T09:00:00.000Z'),
        skippedCount: 1,
        nextSendAt: null,
        writeState,
      },
    )).resolves.toBeUndefined();
    expect(lastSkipOf(writeState)).toBeNull();
  });

  // 写口由回执载荷直接给。攒一份 fire 级写口的老做法在 isolate 冷启动后的第一跳是
  // 空的，而服务停摆恢复后的第一波过期，正是这个 hook 最该留下痕迹的时候。
  it('这一跳一次 fire 都没跑过，照样留得下痕', async () => {
    const writeState = makeWriteState();
    await amsgStaleSkip(
      { id: 103, uuid: TASK_ROW_UUID },
      {
        reason: 'stale',
        action: 'expired',
        metadata: { charId: CHAR_ID },
        occurrenceMs: Date.parse('2026-07-25T09:00:00.000Z'),
        skippedCount: 1,
        nextSendAt: null,
        writeState,
      },
    );
    expect(lastSkipOf(writeState), 'isolate 冷启动的第一跳也要写得下').toBeTruthy();
  });
});

describe('worker 配置接线', () => {
  it('onFireSettled / onStaleSkip 挂在 config 上，且收尾能带 D1 写入 prompt 审计', async () => {
    const auditDb = makePromptAuditDb();
    const cfg = buildWorkerConfig({
      AMSG_MASTER_KEY: 'k'.repeat(64),
      VAPID_EMAIL: 'mailto:a@b.c',
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
      DB: auditDb,
    } as any);
    expect(cfg.onFireSettled).not.toBe(amsgFireSettled);
    expect(cfg.onStaleSkip).toBe(amsgStaleSkip);

    await cfg.onFireSettled({
      status: 'sent',
      sentCount: 1,
      writeState: vi.fn(async () => ({ upserted: 0, skipped: 0, deleted: 0 })),
      scratch: {
        fire: {
          instant: false,
          emotionLatePending: false,
          emotionEvalPromise: null,
          selfLog: createSelfLog(PACK_BUILT_AT),
          selfLogTexts: ['发出的内容'],
          selfLogDirty: false,
          promptAudit: {
            id: 'config-hook-audit',
            createdAt: Date.now(),
            expiresAt: Date.now() + 60_000,
            charId: CHAR_ID,
            charName: 'Nyah',
            taskUuid: TASK_UUID,
            taskRowId: '42',
            clientTaskId: 'client-task-1',
            occurrenceMs: NOW.getTime(),
            status: 'pending',
            prompt: '完整 prompt',
            promptControls: {},
            promptModules: [],
            rounds: [],
            outputText: '',
            error: null,
          },
        },
      },
    } as any);
    expect(auditDb.auditRows).toHaveLength(1);
    expect(auditDb.auditRows[0]).toMatchObject({
      id: 'config-hook-audit',
      status: 'sent',
      output_text: '发出的内容',
    });

    // 同角色的多条任务不并发跑，靠这个分组键。取不到 charId 时返回 null（= 不分组），
    // 别让一批「认不出属于谁」的任务挤成同一组互相堵。
    expect(cfg.serializeBy({ metadata: { charId: 'char-a' } })).toBe('char-a');
    expect(cfg.serializeBy({ metadata: {} })).toBeNull();
    expect(cfg.serializeBy({})).toBeNull();
  });
});

// ─── 配置自检 ───
// 部署这个 worker 最常翻车的两处是「D1 没绑」和「密钥被下一次部署冲掉」。上游遇到
// 这两种都是抛异常 → 被它的全局 catch 吞成一句「服务器内部错误」，且那个响应不带
// CORS 头，浏览器于是连这句话都不给前端读，用户只看得到 "Failed to fetch"——既分不清
// 是哪一样没配，也分不清是不是自己网断了。下面这组把「说清楚缺什么」钉住。
describe('inspectWorkerEnv — 配置自检', () => {
  const fullEnv = {
    AMSG_MASTER_KEY: 'a'.repeat(64),
    VAPID_EMAIL: 'mailto:a@b.c',
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    AMSG_SERVER_TOKEN: 'shared-secret',
    DB: { prepare: () => {} },
  } as any;

  it('配齐了就没有 missing、也没有警告', () => {
    const report = inspectWorkerEnv(fullEnv);
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('D1 没绑时点名 DB，并指向 Bindings（不是 Variables and Secrets，指错地方等于没说）', () => {
    const report = inspectWorkerEnv({ ...fullEnv, DB: undefined });
    expect(report.ok).toBe(false);
    expect(report.missing).toContain('DB');
    expect(report.message).toContain('Bindings');
  });

  it('D1 绑成了别的变量名等同于没绑（上游读的固定是 env.DB）', () => {
    // 绑定存在但不是 D1 实例（比如绑成 KV、或者名字打错导致 env.DB 是 undefined）
    expect(inspectWorkerEnv({ ...fullEnv, DB: {} }).missing).toContain('DB');
  });

  it('master key 缺失时点名它，并说明要存成 Secret（存成明文会被下一次部署冲掉）', () => {
    const report = inspectWorkerEnv({ ...fullEnv, AMSG_MASTER_KEY: '' });
    expect(report.ok).toBe(false);
    expect(report.missing).toContain('AMSG_MASTER_KEY');
    expect(report.message).toContain('Secret');
  });

  it('master key 只有空白字符也算缺（上游只判空，空白串会一路跑到解密才炸）', () => {
    expect(inspectWorkerEnv({ ...fullEnv, AMSG_MASTER_KEY: '   ' }).missing).toContain('AMSG_MASTER_KEY');
  });

  it('master key 格式不对只警告不拦——上游拿它做 SHA-256，长度不对照样能跑，拦了会打挂正常实例', () => {
    const report = inspectWorkerEnv({ ...fullEnv, AMSG_MASTER_KEY: 'short-but-working' });
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.warnings.map((w: any) => w.code)).toContain('MASTER_KEY_FORMAT');
  });

  it('VAPID 缺失只警告不拦：读写任务照常，但到点消息发不出去且界面上毫无异常', () => {
    const report = inspectWorkerEnv({ ...fullEnv, VAPID_PRIVATE_KEY: '' });
    expect(report.ok).toBe(true);
    expect(report.warnings.map((w: any) => w.code)).toContain('VAPID_MISSING');
  });

  it('没配共享密钥时提醒端点是公开的（这种坏法完全静默，不提醒没人会发现）', () => {
    const report = inspectWorkerEnv({ ...fullEnv, AMSG_SERVER_TOKEN: undefined });
    expect(report.ok).toBe(true);
    expect(report.warnings.map((w: any) => w.code)).toContain('SERVER_TOKEN_MISSING');
  });
});

describe('worker 入口 — 配置不全时的响应', () => {
  const brokenEnv = { AMSG_MASTER_KEY: '', DB: undefined } as any;
  const fullEnv = {
    AMSG_MASTER_KEY: 'a'.repeat(64),
    VAPID_EMAIL: 'mailto:a@b.c',
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    DB: { prepare: () => {} },
  } as any;

  const call = (url: string, init: RequestInit = {}, env: any = brokenEnv) =>
    (worker as any).fetch(new Request(url, init), env, { waitUntil: () => {} });

  it('回明确的 WORKER_CONFIG_MISSING，而不是笼统的「服务器内部错误」', async () => {
    const response = await call('https://w.example/messages');
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe('WORKER_CONFIG_MISSING');
    expect(body.error.missing).toEqual(['DB', 'AMSG_MASTER_KEY']);
  });

  it('这个响应必须带 CORS 头，否则浏览器不让前端读，又变回 "Failed to fetch"', async () => {
    const response = await call('https://w.example/messages');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('配置不全时预检照样放行——预检被挡住的话正式请求根本发不出去', async () => {
    const response = await call('https://w.example/messages', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('/config-check 在配置缺一半时也要能答，否则前端没法告诉用户缺的是哪一样', async () => {
    const response = await call('https://w.example/config-check');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.ok).toBe(false);
    expect(body.data.missing).toEqual(['DB', 'AMSG_MASTER_KEY']);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('配置齐全时放行到上游：/vapid-public-key 该由上游回公钥，不能被自检层截胡', async () => {
    const response = await call('https://w.example/vapid-public-key', {}, fullEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, publicKey: 'pub' });
  });

  it('配置齐全时未知路由由上游回 404，不是自检层的 503（否则等于把整个路由表吃掉了）', async () => {
    const response = await call('https://w.example/', {}, fullEnv);
    expect(response.status).toBe(404);
  });
});

// 上游报的 missing 是一摞带类型前缀的串（table: / column: / index:），体检面板按
// 「缺表」「缺列」两类分开说话——两者要用户做的事不一样：缺表点一下连接就建好了，
// 缺列则是升级后没重连的典型症状。
describe('splitSchemaMissing', () => {
  it('按前缀分两摞，列保留表名前缀', () => {
    expect(splitSchemaMissing([
      'table:message_outbox',
      'column:scheduled_messages.last_error',
      'column:client_state.updated_at',
    ])).toEqual({
      missingTables: ['message_outbox'],
      missingColumns: ['scheduled_messages.last_error', 'client_state.updated_at'],
    });
  });

  // 索引缺失对用户来说也是「点一次重新连接」，没必要多造一个词让人分辨。
  it('索引并进「缺表」那一摞', () => {
    expect(splitSchemaMissing(['index:uidx_uuid'])).toEqual({
      missingTables: ['uidx_uuid'],
      missingColumns: [],
    });
  });

  it('什么都不缺时两摞都是空的（这是「一切正常」的判据）', () => {
    expect(splitSchemaMissing([])).toEqual({ missingTables: [], missingColumns: [] });
  });
});

// /debug 是隔着屏幕帮别人看部署时用的：对方只会截图或者把 JSON 贴过来，所以它既要
// 说得足够多（配置、schema、cron），又不能带出任何一样不该外传的东西——它不设防。
describe('classifySchemaProbeError — 自查挂了归到哪一档', () => {
  // 分档的意义全在「用户该做什么」上：unsupported 点一下更新就好，denied 点什么都没用
  // （后端自己的毛病），timeout 再体检一次多半就过。混成一句「查不了」等于什么都没说。
  it('D1 的授权器拒了 → denied', () => {
    expect(classifySchemaProbeError(new Error('D1_ERROR: not authorized: SQLITE_AUTH'))).toBe('denied');
  });

  it('后端太旧、压根没这个方法 → unsupported', () => {
    expect(classifySchemaProbeError(new TypeError('upstream.getSchemaVersion is not a function')))
      .toBe('unsupported');
    expect(classifySchemaProbeError(new Error('[amsg-server] 这个数据库适配器不支持 schema 自查（没实现 describeSchema）。')))
      .toBe('unsupported');
  });

  it('库没在时限内回话 → timeout', () => {
    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    expect(classifySchemaProbeError(aborted)).toBe('timeout');
    expect(classifySchemaProbeError(new Error('D1_ERROR: query timed out'))).toBe('timeout');
  });

  it('归不了类的一律 other，绝不误报成上面三档', () => {
    expect(classifySchemaProbeError(new Error('D1_ERROR: something else entirely'))).toBe('other');
    expect(classifySchemaProbeError('一段字符串')).toBe('other');
    expect(classifySchemaProbeError(null)).toBe('other');
  });
});

describe('/debug — 只读诊断', () => {
  /**
   * 假 D1：按 SQL 关键字给回答，只支持这个端点真正会发的那几条。
   *
   * schema 自查（上游的 describeSchema）会发三种：列表、`PRAGMA table_info(表名)`、
   * 索引列表。`columns` 给每张表配列名，不配的表当成没有列——上游会照着自己的建表语句
   * 比对，缺什么它说了算，这里不再自己抄一份期望清单。
   */
  const fakeDb = ({ tables, columns = {}, indexes = [], pending = [], pushRows = 0 }: {
    tables: string[];
    columns?: Record<string, string[]>;
    indexes?: string[];
    pending?: { next_send_at: string }[];
    pushRows?: number;
  }) => ({
    prepare(sql: string) {
      const answer = async () => {
        const pragma = /PRAGMA table_info\((\w+)\)/.exec(sql);
        if (pragma) return { results: (columns[pragma[1]] || []).map((name) => ({ name })) };
        if (sql.includes("type = 'index'")) return { results: indexes.map((name) => ({ name })) };
        if (sql.includes('sqlite_master')) return { results: tables.map((name) => ({ name })) };
        if (sql.includes('push_subscriptions')) return { n: pushRows };
        const nowIso = new Date().toISOString();
        const overdue = pending.filter((task) => task.next_send_at <= nowIso);
        return {
          pending: pending.length,
          overdue: overdue.length,
          oldest: overdue.map((t) => t.next_send_at).sort()[0] ?? null,
        };
      };
      return { bind: () => ({ first: answer }), first: answer, all: answer };
    },
  });

  const ALL_TABLES = ['scheduled_messages', 'client_state', 'push_subscriptions'];

  const envWith = (db: unknown) => ({
    AMSG_MASTER_KEY: 'a'.repeat(64),
    VAPID_EMAIL: 'mailto:a@b.c',
    VAPID_PUBLIC_KEY: 'pub-key',
    VAPID_PRIVATE_KEY: 'priv-key',
    AMSG_SERVER_TOKEN: 'shared-secret',
    DB: db,
  } as any);

  const debug = async (db: unknown) => {
    const response = await (worker as any).fetch(new Request('https://w.example/debug'), envWith(db));
    return (await response.json()).data;
  };

  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

  it('一个字都不能带出密钥、用户标识或任务正文（这个端点不设防）', async () => {
    const data = await debug(fakeDb({ tables: ALL_TABLES }));
    const dumped = JSON.stringify(data);
    expect(dumped).not.toContain('a'.repeat(64));   // master key
    expect(dumped).not.toContain('priv-key');       // VAPID 私钥
    expect(dumped).not.toContain('shared-secret');  // 共享密钥
    // 公钥是例外：前端订阅时本来就要用它，另有一个公开端点专门返回它。
    // 放进来是为了能一眼比对两边配的是不是同一对。
    expect(data.vapidPublicKey).toBe('pub-key');
  });

  /**
   * 换了 bundle 却没跑 init-tenant 时，已有的表不会自己长出新列，cron 每分钟都会因为
   * 读不到它们而挂——前端一切正常、任务列表也在，就是一条都不发。这一项是那种故障
   * 唯一的可查证据，所以缺列必须点到名（缺哪张表哪一列，而不只是「有问题」）。
   *
   * 「缺哪些」由上游按它自己的建表语句判定，这里只钉住「它说缺，/debug 就得报出来」。
   */
  /**
   * 回归守卫：比对不出来时报 null，**不是 true**。
   *
   * 这一项的全部意义就是查出上面那种漂移。查询本身挂了（个别运行时不让读 sqlite_master /
   * PRAGMA，就是这种长相）却回一句「齐了」，等于在唯一能发现这件事的地方给假绿灯——
   * 库真缺列、cron 每分钟静默挂，而面板一路绿到底。宁可说「不知道」。
   */
  it('schema 比对不出来 → schemaReady 报 null（查不了 ≠ 齐了）', async () => {
    const db = fakeDb({ tables: ALL_TABLES });
    const blind = {
      prepare(sql: string) {
        if (/PRAGMA table_info/.test(sql)) {
          const boom = async () => { throw new Error('D1_ERROR: not authorized: SQLITE_AUTH'); };
          return { bind: () => ({ first: boom }), first: boom, all: boom };
        }
        return db.prepare(sql);
      },
    };
    const data = await debug(blind);
    expect(data.storage.reachable).toBe(true);
    expect(data.storage.schemaReady).toBeNull();
    expect(data.storage.schemaReady).not.toBe(true);
  });

  /**
   * 回归守卫：库里混着 Cloudflare 内部表 `_cf_KV` 时，自查必须绕开它跑完。
   *
   * 2026-08-09 在真机上撞到的：新建的 D1 库自带这张内部表，当时的上游遍历全库逐表
   * 问列，问到它被 D1 一口回绝（SQLITE_AUTH），整个自查断在第一张表上。修复随
   * amsg-server 2.6.0-next.18+ 发布：内部表直接跳过。这个夹具里 `PRAGMA
   * table_info(_cf_KV)` 仍然会炸——上游哪天退回去问它一句，自查就会重新断掉、
   * schemaError 变回 denied，这条就红。
   */
  it('库里混着 _cf_KV 内部表 → 上游跳过它，自查照常跑完', async () => {
    const db = fakeDb({ tables: ['_cf_KV', ...ALL_TABLES] });
    const withInternalTable = {
      prepare(sql: string) {
        if (sql.includes('PRAGMA table_info(_cf_KV)')) {
          const boom = async () => { throw new Error('D1_ERROR: not authorized: SQLITE_AUTH'); };
          return { bind: () => ({ first: boom }), first: boom, all: boom };
        }
        return db.prepare(sql);
      },
    };
    const data = await debug(withInternalTable);
    // 自查没被内部表噎死：跑出了结论（缺不缺另说），且没把 _cf_KV 当成该建的表。
    expect(data.storage.schemaError).toBeNull();
    expect(data.storage.schemaReady).not.toBeNull();
    expect(data.storage.missingTables).not.toContain('_cf_KV');
    // 走完了全程才对得出完整清单：credRefs 那张 llm_credentials 也在比对范围里。
    expect(data.storage.missingTables).toContain('llm_credentials');
  });

  it('自查跑成了就不带 schemaError（有值等于「这次没查成」）', async () => {
    const data = await debug(fakeDb({ tables: ALL_TABLES }));
    expect(data.storage.schemaError).toBeNull();
  });

  /**
   * 回归守卫：一张业务表都没有的库（一键部署完还没点「连接并启用」的样子，只剩
   * `_cf_KV`）绝不许显示成全绿，而且要点得出名来。
   *
   * 旧版上游在这里会被 `_cf_KV` 噎死，「缺哪些表」只能是空数组，界面全靠
   * schemaError 撑着说「查不了」；amsg-server 2.6.0-next.18+ 跳过内部表后，
   * 自查能跑完并点名全部缺表，界面直接说得清「该点重新连接建表」。
   */
  it('库里一张业务表都没有 → 点名全部缺表，空库不算绿', async () => {
    const empty = {
      prepare(sql: string) {
        const answer = async () => {
          if (sql.includes('PRAGMA')) throw new Error('D1_ERROR: not authorized: SQLITE_AUTH');
          if (sql.includes('sqlite_master')) return { results: [{ name: '_cf_KV' }] };
          return { pending: 0, overdue: 0, oldest: null };
        };
        return { bind: () => ({ first: answer }), first: answer, all: answer };
      },
    };
    const data = await debug(empty);
    expect(data.storage.schemaReady).toBe(false);
    expect(data.storage.missingTables).toContain('scheduled_messages');
    expect(data.storage.missingTables).toContain('llm_credentials');
    expect(data.storage.schemaError).toBeNull();
  });

  it('换了 bundle 没跑 init-tenant → 点名缺的那几列（cron 会因此每分钟静默挂）', async () => {
    const data = await debug(fakeDb({
      tables: ALL_TABLES,
      columns: { scheduled_messages: ['id', 'next_send_at', 'status'] },
    }));
    expect(data.storage.schemaReady).toBe(false);
    // 带表名前缀：同名列（created_at 之类）在好几张表里都有，光报列名说不清是哪张。
    expect(data.storage.missingColumns).toContain('scheduled_messages.lease_until');
    expect(data.storage.missingColumns.every((item: string) => item.includes('.'))).toBe(true);
  });

  it('整张表都没有时报的是缺表，不是把它的列一条条列出来', async () => {
    const data = await debug(fakeDb({ tables: ['scheduled_messages'] }));
    expect(data.storage.missingTables).toContain('client_state');
    expect(data.storage.missingColumns.some((item: string) => item.startsWith('client_state.'))).toBe(false);
  });

  /**
   * 回归守卫：schema 查不动的时候不许报假警。
   *
   * 这一项红了意味着「你的库该迁移了」，而用户照着去点「重新连接」并不能解决
   * 「查不了」这件事——反复点、反复红，比不报更糟。
   */
  it('schema 查不了时不报假警（不是所有表都缺）', async () => {
    const brokenDb = {
      prepare(sql: string) {
        const answer = async () => {
          if (sql.includes('PRAGMA')) throw new Error('PRAGMA not supported');
          if (sql.includes('sqlite_master')) return { results: ALL_TABLES.map((name) => ({ name })) };
          return { pending: 0, overdue: 0, oldest: null };
        };
        return { bind: () => ({ first: answer }), first: answer, all: answer };
      },
    };
    const data = await debug(brokenDb);
    expect(data.storage.missingTables).toEqual([]);
    expect(data.storage.missingColumns).toEqual([]);
    expect(data.schema).toBeNull();
  });

  it('任务到点很久还挂着 pending → cron 那侧有问题', async () => {
    const data = await debug(fakeDb({
      tables: ALL_TABLES,
      pending: [{ next_send_at: minutesAgo(47) }],
    }));
    expect(data.tick).toBe('stalled');
    expect(data.storage.oldestOverdueMinutes).toBeGreaterThanOrEqual(47);
  });

  it('刚到点一两分钟不算挂——cron 一分钟一跳，得留重试余量', async () => {
    const data = await debug(fakeDb({
      tables: ALL_TABLES,
      pending: [{ next_send_at: minutesAgo(1) }],
    }));
    expect(data.tick).toBe('healthy');
  });

  it('手上没有待发任务时说 idle，不能拿「没活干」当「挂了」报', async () => {
    const data = await debug(fakeDb({ tables: ALL_TABLES }));
    expect(data.tick).toBe('idle');
  });

  it('云端没有推送订阅时看得出来（换 worker 后最常见的「全绿但收不到」）', async () => {
    const empty = await debug(fakeDb({ tables: ALL_TABLES, pushRows: 0 }));
    expect(empty.storage.pushSubscriptionRegistered).toBe(false);
    const registered = await debug(fakeDb({ tables: ALL_TABLES, pushRows: 1 }));
    expect(registered.storage.pushSubscriptionRegistered).toBe(true);
  });

  it('D1 没绑时照样能答（配置全缺的时候正是最需要它的时候）', async () => {
    const data = await debug(undefined);
    expect(data.storage.reachable).toBe(false);
    expect(data.config.ok).toBe(false);
    expect(data.config.missing).toContain('DB');
    expect(data.tick).toBe('unknown');
  });

  it('查库炸了只报错误类型，不把 SQL 片段漏出去', async () => {
    const data = await debug({
      prepare() { throw Object.assign(new Error('near "FROM scheduled_messages": syntax error'), { name: 'D1Error' }); },
    });
    expect(data.storage).toEqual({ reachable: false, error: 'D1Error' });
    expect(JSON.stringify(data)).not.toContain('syntax error');
  });
});

describe('/prompt-audit — 云端 Prompt 审计接口', () => {
  const envWith = (db: unknown) => ({
    AMSG_MASTER_KEY: 'a'.repeat(64),
    VAPID_EMAIL: 'mailto:a@b.c',
    VAPID_PUBLIC_KEY: 'pub-key',
    VAPID_PRIVATE_KEY: 'priv-key',
    AMSG_SERVER_TOKEN: 'shared-secret',
    DB: db,
  } as any);
  const authed = { headers: { 'X-Client-Token': 'shared-secret' } };

  it('必须带共享密钥读取，不能把完整 prompt 公开到无鉴权端点', async () => {
    const db = makePromptAuditDb();
    const response = await (worker as any).fetch(new Request('https://w.example/prompt-audit'), envWith(db));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('INVALID_CLIENT_TOKEN');
  });

  it('GET 返回最近审计，并在读取前清理超过 5 天的记录', async () => {
    const db = makePromptAuditDb([
      {
        id: 'fresh',
        created_at: Date.now(),
        expires_at: Date.now() + 60_000,
        char_id: CHAR_ID,
        char_name: 'Nyah',
        task_uuid: TASK_UUID,
        task_row_id: '42',
        client_task_id: 'client-task-1',
        occurrence_ms: Date.parse('2026-07-25T12:00:00.000Z'),
        status: 'sent',
        model: 'deepseek-v4-flash',
        prompt: '完整 prompt',
        prompt_controls_json: JSON.stringify({ timeAwareness: false }),
        prompt_modules_json: JSON.stringify([{ key: 'timeAwareness', label: '时间感知', enabled: false, included: false }]),
        rounds_json: JSON.stringify([{ iteration: 0, decision: 'finish' }]),
        usage_json: JSON.stringify({ totalTokens: 7, promptTokens: 5, completionTokens: 2 }),
        output_text: '发出去的话',
        error: null,
      },
      {
        id: 'expired',
        created_at: Date.now() - 10 * 24 * 60 * 60 * 1000,
        expires_at: Date.now() - 1_000,
        char_id: CHAR_ID,
        prompt: '过期 prompt',
        prompt_controls_json: '{}',
        prompt_modules_json: '[]',
        rounds_json: '[]',
        usage_json: '{}',
        output_text: '',
        status: 'sent',
      },
    ]);

    const response = await (worker as any).fetch(new Request('https://w.example/prompt-audit?limit=5', authed), envWith(db));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.entries).toHaveLength(1);
    expect(body.data.entries[0]).toMatchObject({
      id: 'fresh',
      charId: CHAR_ID,
      prompt: '完整 prompt',
      outputText: '发出去的话',
    });
    expect(JSON.stringify(body)).not.toContain('过期 prompt');
    expect(db.auditRows.map((r: any) => r.id)).toEqual(['fresh']);
  });

  it('DELETE 清空审计记录', async () => {
    const db = makePromptAuditDb([
      { id: 'a', created_at: 1, expires_at: Date.now() + 1, prompt: 'p', prompt_controls_json: '{}', prompt_modules_json: '[]', rounds_json: '[]', usage_json: '{}', output_text: '', status: 'sent' },
    ]);
    const response = await (worker as any).fetch(new Request('https://w.example/prompt-audit', { ...authed, method: 'DELETE' }), envWith(db));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.deleted).toBe(1);
    expect(db.auditRows).toHaveLength(0);
  });
});

describe('/wake-now - 专用心跳入口', () => {
  it('只接受共享密钥，并且心跳任务标记为 heartbeat', async () => {
    expect(isWakeNowAuthorized(new Headers({ Authorization: 'Bearer wake-secret' }), 'wake-secret')).toBe(true);
    expect(isWakeNowAuthorized(new Headers({ Authorization: 'Bearer wrong' }), 'wake-secret')).toBe(false);

    const request = new Request('https://w.example/wake-now', {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        type: 'heartbeat',
        userId: 'user-1',
        charId: CHAR_ID,
        instruction: '自主醒来后先查看年轮。',
        profile: {
          apiUrl: 'https://llm.example/v1',
          apiKey: 'secret-key',
          primaryModel: 'model-1',
        },
      }),
    });

    const parsed = await parseWakeNowRequest(request);

    expect(parsed.userId).toBe('user-1');
    expect(parsed.charId).toBe(CHAR_ID);
    expect(parsed.taskPayload.messageType).toBe('auto');
    expect(parsed.taskPayload.metadata).toMatchObject({
      charId: CHAR_ID,
      source: 'heartbeat',
      amsgExpirePolicy: 'keep',
      amsgTaskInstruction: '自主醒来后先查看年轮。',
    });
  });
});

// ─── 即时对话（instant chat） ───
//
// 这条路和主动消息共用同一套 fire 管线，但语义完全相反：用户刚把话说完、正盯着
// 「正在输入…」等回复。三道「到点还该不该发」的门（活跃租约、防穿帮闸、本次任务指令）
// 对它全都不适用，一道没跳过就是「用户发了消息但角色永远不回」；而请求消息要是退回
// 主动消息模板，出来的东西驴唇不对马嘴，用户还看不出这是坏了。下面每条都对着一种。
describe('onBeforeFire — 即时对话分支', () => {
  const CHAT_MESSAGES = [
    { role: 'system', content: '你是 Nyah。' },
    { role: 'user', content: '在吗' },
  ];

  const instantPack = (extra: Record<string, unknown> = {}) => firePackValue(null, {
    chat: { messages: CHAT_MESSAGES, builtAt: PACK_BUILT_AT },
    ...extra,
  });

  /** 即时对话任务：metadata 标 amsgInstantChat，没有 amsgTaskInstruction。 */
  const instantCtx = (opts: {
    charRows?: Array<{ key: string; value: string }>;
    metadata?: Record<string, unknown>;
  } = {}) => makeCtx({
    charRows: opts.charRows ?? [
      { key: AMSG_FIRE_PACK_KEY, value: instantPack() },
      { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
    ],
    metadata: {
      amsgInstantChat: true,
      amsgMode: 'instant',
      amsgTaskInstruction: undefined,
      ...opts.metadata,
    },
  });

  it('请求消息 = 客户端打的那串对话原样 + 末尾追加一块时效信息', async () => {
    const { ctx } = instantCtx();
    const result = fired(await amsgHooks.onBeforeFire(ctx));

    expect(result.messages).toHaveLength(CHAT_MESSAGES.length + 1);
    expect(result.messages.slice(0, 2)).toEqual(CHAT_MESSAGES);
    const appended = result.messages[2];
    expect(appended.role).toBe('system');
    // 到点才知道的东西在这一块里：现在几点
    expect(appended.content).toContain('现在是');
    // 回归守卫：走模板渲染的话这里会出现主动消息那套措辞，用户刚说的话反而没人答
    expect(result.messages.map((m) => m.content).join('\n')).not.toContain('本次任务');
  });

  // 图片消息本地是结构化分段，上游把 onBeforeFire 返回的 messages 整个丢进
  // /chat/completions 的请求体（amsg-shared 的 buildLlmRequestBody 只写
  // `messages: llmMessages`，不看 content 的类型）。这里但凡 String() 一下，
  // 模型收到的就是「[object Object]」——而它照样会答，用户只觉得角色答非所问。
  it('结构化 content（图片）原样进请求消息，一个字都不动', async () => {
    const imagePart = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
    const structured = [
      { role: 'system', content: '你是 Nyah。' },
      { role: 'user', content: [{ type: 'text', text: '08:00 [User sent an image]' }, imagePart] },
    ];
    const { ctx } = instantCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(null, {
          chat: { messages: structured, builtAt: PACK_BUILT_AT },
        }) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const result = fired(await amsgHooks.onBeforeFire(ctx));

    // 逐字相等：不是 [object Object]，也不是被拍平成文字段
    expect(result.messages.slice(0, 2)).toEqual(structured);
    const userMessage = result.messages[1] as unknown as { content: unknown[] };
    expect(Array.isArray(userMessage.content)).toBe(true);
    expect(userMessage.content[1]).toEqual(imagePart);
    // 追加的时效块仍然照挂在最后
    expect(result.messages[2].role).toBe('system');
    expect(result.messages[2].content).toContain('现在是');
  });

  it('给足生成时间（库默认 240s 对一轮带工具的对话不够，用户会以为发失败了）', async () => {
    const { ctx } = instantCtx();
    const result = await amsgHooks.onBeforeFire(ctx) as { totalTimeoutMs?: number };
    expect(result.totalTimeoutMs).toBeGreaterThanOrEqual(600_000);
  });

  it('用户正在热聊也照答（活跃租约那道门是给主动消息让路用的）', async () => {
    const { ctx } = instantCtx({
      charRows: [
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 5_000) },
        { key: AMSG_FIRE_PACK_KEY, value: instantPack() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
      metadata: { amsgExpirePolicy: 'expire' },
    });
    const result = fired(await amsgHooks.onBeforeFire(ctx));
    expect(result.messages[0]).toEqual(CHAT_MESSAGES[0]);
  });

  it('防穿帮闸不拦它（「对话往前走了」正是它要回的那句话）', async () => {
    const anchor = NOW.getTime() - 3600_000;
    const { ctx } = instantCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(anchor + 60_000, {
          chat: { messages: CHAT_MESSAGES, builtAt: PACK_BUILT_AT },
        }) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
      metadata: { amsgAnchorMs: anchor, amsgExpirePolicy: 'expire' },
    });
    const result = fired(await amsgHooks.onBeforeFire(ctx));
    expect(result.messages).toHaveLength(CHAT_MESSAGES.length + 1);
  });

  it('没有 amsgTaskInstruction 不算异常（即时对话没有「本次任务」这回事）', async () => {
    const { ctx } = instantCtx();
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toHaveProperty('messages');
  });

  it('fire_pack 缺 chat 段 → 抛错，绝不退回主动消息模板', async () => {
    const { ctx } = instantCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },   // 只有模板、没有 chat
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow('AMSG2_FIRE_STATE_MISSING');
  });

  it('照常给工具（角色在对话里也能查东西、给自己排后续）', async () => {
    const { ctx } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: instantPack() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
      globalRows: [{ key: AMSG_TOOL_CONFIG_KEY, value: mcpToolConfigValue() }],
      metadata: { amsgInstantChat: true, amsgTaskInstruction: undefined },
    });
    // ctx.scheduleTask 存在才教「给自己排下一条」
    (ctx as any).scheduleTask = async () => ({ created: true, id: 1, uuid: 'u', nextSendAt: 'x' });
    const result = fired(await amsgHooks.onBeforeFire(ctx));
    const appended = result.messages[result.messages.length - 1].content;
    expect(appended).toContain('【外部工具');         // MCP 说明块
    expect(appended).toContain('search_memory');
    expect(appended).toContain('给自己排下一条');      // 排程说明块
    expect(result.tools?.map((t) => t.function.name)).toContain('mcp__search_memory');
  });

  it('定时任务照旧走模板渲染（没被这个分支带跑）', async () => {
    const { ctx } = makeCtx({});
    const result = fired(await amsgHooks.onBeforeFire(ctx));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toContain('问问对方吃了没');
  });
});

// 角色 2.0 关着且无任务时，即时对话上传的轻量包把 template 填成占位串；欠着即时回复
// 期间用户新排的定时任务可能赶在真模板补传之前到点——照渲就是给用户发那句占位自白。
describe('定时轮撞上即时轻量包的占位模板', () => {
  const stubPackRows = (extra: Record<string, unknown> = {}) => [
    { key: AMSG_FIRE_PACK_KEY, value: firePackValue(null, { template: AMSG2_INSTANT_STUB_TEMPLATE, ...extra }) },
    { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
  ];

  afterEach(() => configureInstantErrorPush(null));

  it('定时任务 → 抛可重试错（不渲染占位文本、不发 error push）', async () => {
    // 挂上直发通道才验得出「没发」：不挂的话 sendInstantErrorPush 本来就静默跳过
    const sent: unknown[] = [];
    configureInstantErrorPush({
      webpush: { sendNotification: async (_s: unknown, body: string) => { sent.push(JSON.parse(body)); } },
      db: { prepare: () => ({ bind: () => ({ first: async () => null }), first: async () => null }) },
      masterKey: 'a'.repeat(64),
    } as any);

    const { ctx } = makeCtx({ charRows: stubPackRows() });
    const error = await amsgHooks.onBeforeFire(ctx).then(() => null, (e: unknown) => e);
    expect(error, '占位模板不许被当系统提示词渲染出去').toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain('AMSG2_FIRE_PACK_NOT_READY');
    // 可重试（不带 permanent）：走上游重试梯子，客户端销账后补传真模板自然放行
    expect((error as { permanent?: boolean }).permanent).toBeUndefined();
    // 定时轮不占即时失败通道
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(0);
  });

  it('即时对话不吃这道门：轻量包的 template 本来就是占位串，照常按 chat 段生成', async () => {
    const { ctx } = makeCtx({
      metadata: { amsgMode: 'instant', amsgInstantChat: true, amsgClientTaskId: 'ct-stub' },
      charRows: stubPackRows({ chat: { messages: [{ role: 'user', content: '在吗' }], builtAt: PACK_BUILT_AT } }),
    });
    const result = fired(await amsgHooks.onBeforeFire(ctx));
    expect(result.messages.length).toBeGreaterThan(0);
    // 占位文本一个字都不进请求消息（即时轮不渲染模板）
    expect(JSON.stringify(result.messages)).not.toContain('AMSG2_INSTANT_STUB_TEMPLATE');
  });
});

// 用户正盯着窗口等这条回复时，锁屏横幅是纯打扰（页面自己会上屏）；窗口不可见时又
// 必须弹。SW 的 shouldRenderNotification 按 notification.show 分这两种，worker 表态。
describe('即时对话的推送通知策略', () => {
  const CLIENT_TASK_ID = 'client-instant-1';
  const CHAT_MESSAGES = [{ role: 'user', content: '在吗' }];

  const makeStore = (instant: boolean) => makeFireStore(instant ? CHAT_MESSAGES : undefined);

  /** 这一组只按「即时对话 / 定时任务」分两种任务身份，别的都走模块级那份 runFire。 */
  const fireMeta = (instant: boolean) => ({
    amsgClientTaskId: CLIENT_TASK_ID,
    amsgMode: instant ? 'instant' : 'auto',
    ...(instant ? { amsgInstantChat: true } : { amsgTaskInstruction: '想到什么说什么' }),
  });

  it('即时对话的推送标 when-hidden', async () => {
    const store = makeStore(true);
    const { decision } = await runFire(store, { metadata: fireMeta(true), llmOutput: '在的。怎么啦？' });
    expect(decision.decision).toBe('finish');
    for (const push of decision.pushPayloads) {
      expect((push.notification as any).show).toBe('when-hidden');
      // 横幅文案还在：show 只是加一个字段，不是把 notification 换掉
      expect((push.notification as any).body).toBeTruthy();
    }
  });

  it('定时任务的推送不标 show（主动消息前台可见时更该弹）', async () => {
    const store = makeStore(false);
    const { decision } = await runFire(store, { metadata: fireMeta(false), llmOutput: '在的。' });
    for (const push of decision.pushPayloads) {
      expect(push.notification).toBeTruthy();
      expect((push.notification as any).show).toBeUndefined();
    }
  });
});

// 情绪评估从浏览器搬进 worker：用户发完就能关页面，情绪底色照样更新。
//
// 两条底线各占一条用例：
//   ① 评估结果得随最后一条 push 回到客户端；而带着副 API apiKey 的那份**评估配置**
//      一个字节都不许出现在任何一条 push 的 metadata 里（push 出了这台 worker 就是
//      推送服务的事了，密钥跟着走等于把用户的副 API 送人）。
//   ② 评估挂了不能连累主回复——用户等的是那句话，情绪只是附赠。
describe('即时对话的云端情绪评估', () => {
  const CLIENT_TASK_ID = 'client-instant-eval';
  const CHAT_MESSAGES = [
    { role: 'system', content: '你是 Nyah。' },
    { role: 'user', content: '在吗' },
  ];
  const EVAL_PROMPT = [
    '你是一个角色情绪分析系统。',
    '__EMOTION_EVAL_SYSTEM_PROMPT__',
    '__EMOTION_EVAL_HISTORY__',
  ].join('\n');
  const EVAL_SPEC = {
    prompt: EVAL_PROMPT,
    api: { baseUrl: 'https://eval.example.com/v1', apiKey: 'sk-secondary-KEYLEAK', model: 'eval-mini' },
  };
  /** 两段正文 → 两条 push，才能验「只挂最后一条」。 */
  const TWO_SEGMENT_OUTPUT = '在的。\n怎么啦？';

  afterEach(() => vi.unstubAllGlobals());

  const makeStore = () => makeFireStore(CHAT_MESSAGES);

  /** 这一组的任务身份是固定的即时对话，只有评估配置那部分按用例变。 */
  const evalFire = (
    store: ReturnType<typeof makeStore>,
    extraMeta: Record<string, unknown>,
    llmOutput = TWO_SEGMENT_OUTPUT,
  ) => runFire(store, {
    metadata: {
      amsgClientTaskId: CLIENT_TASK_ID,
      amsgMode: 'instant',
      amsgInstantChat: true,
      ...extraMeta,
    },
    llmOutput,
  });

  it('评估结果随最后一条 push 回去，而副 API 凭据一条都不带出门', async () => {
    const seen: Array<{ url: string; auth: string | null; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: any, init: any) => {
      seen.push({
        url: String(input),
        auth: new Headers(init.headers).get('Authorization'),
        body: JSON.parse(init.body),
      });
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"changed":true,"buffs":[]} EVAL-RAW-MARKER' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const store = makeStore();
    const { decision, metadata } = await evalFire(store, { amsgEmotionEval: EVAL_SPEC });
    expect(decision.decision).toBe('finish');
    const payloads = decision.pushPayloads as Array<Record<string, any>>;
    expect(payloads.length).toBeGreaterThanOrEqual(2);

    // 评估真的发出去了：打给副 API、带副 API 的 key、占位符已经被本次对话还原掉
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://eval.example.com/v1/chat/completions');
    expect(seen[0].auth).toBe('Bearer sk-secondary-KEYLEAK');
    const evalContent = String(seen[0].body.messages[0].content);
    expect(evalContent).not.toContain('__EMOTION_EVAL_SYSTEM_PROMPT__');
    expect(evalContent).not.toContain('__EMOTION_EVAL_HISTORY__');
    expect(evalContent).toContain('你是 Nyah。');
    expect(evalContent).toContain('[用户]: 在吗');
    // 主生成看得到的时效块，评估也得看到（不然它连现在几点都不知道）
    expect(evalContent).toContain('现在是');

    // 结果只挂最后一条
    const last = payloads[payloads.length - 1];
    expect(last.metadata.amsgEmotionUpdate).toContain('EVAL-RAW-MARKER');
    expect(last.metadata.amsgEmotionDone).toBe(true);
    for (const payload of payloads.slice(0, -1)) {
      expect(payload.metadata.amsgEmotionUpdate).toBeUndefined();
      expect(payload.metadata.amsgEmotionDone).toBeUndefined();
    }

    // 红线：任何一条 push 的 metadata 都不许带评估配置（里头是副 API 的 apiKey）
    for (const payload of payloads) {
      expect(payload.metadata).not.toHaveProperty('amsgEmotionEval');
    }
    expect(JSON.stringify(payloads)).not.toContain('sk-secondary-KEYLEAK');

    // 纵深防御第一道：onBeforeFire 在捕获点就把这个键从**任务 metadata 对象本身**删了。
    // 上游把同一个对象按引用喂给「hook 不接手时」那条模板路径，那条路径会 `push.metadata
    // = args.metadata` 直接挂上去——只要哪天 onBeforeFire 在某个分支返回了 undefined，
    // 整份凭据就随每条推送出门。删干净了，那条路径也就无从可漏。
    expect(metadata).not.toHaveProperty('amsgEmotionEval');
    expect(JSON.stringify(metadata)).not.toContain('sk-secondary-KEYLEAK');
  });

  it('评估挂了照发主回复（一条 amsgEmotionUpdate 都不挂）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

    const store = makeStore();
    const { decision, metadata } = await evalFire(store, { amsgEmotionEval: EVAL_SPEC });
    expect(decision.decision).toBe('finish');
    const payloads = decision.pushPayloads as Array<Record<string, any>>;
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    expect(payloads.map((p) => p.message)).toEqual(['在的。', '怎么啦？']);
    for (const payload of payloads) {
      expect(payload.metadata.amsgEmotionUpdate).toBeUndefined();
      expect(payload.metadata).not.toHaveProperty('amsgEmotionEval');
    }
    // 但「这一轮的评估有结论了」照样要带回去 —— 否则客户端那盏「情绪更新中」
    // 要一直亮到十几分钟后才由安全网熄，用户只看到情绪永远不更新。
    const lastMeta = payloads[payloads.length - 1].metadata;
    expect(lastMeta.amsgEmotionDone).toBe(true);
    // 还捎一句短原因给客户端照实说明白（用户自己部署的 worker，「可查日志」等于没说）
    expect(lastMeta.amsgEmotionError).toContain('副 API HTTP 500');
    // 评估跑挂了也照删不误（凭据的去留跟评估成不成功无关）
    expect(metadata).not.toHaveProperty('amsgEmotionEval');
  });

  // 回归守卫：评估以前是无条件 await 的，而它自己的超时是 120 秒（EMOTION_EVAL_TIMEOUT_MS）。
  // 副 API 一限流 / 挂起，写好的回复就被扣在这儿两分钟：用户一直看着「正在输入…」，
  // 同一句话走本地路径十秒就上屏了（本地那条的情绪评估是 fire-and-forget，从不挡回复）。
  // 工具循环吃掉大半预算时，这两分钟还会把整轮 600 秒的预算顶穿 —— fire 失败重跑，
  // 用户拿到的是一句失败说明，而不是那条已经生成好的回复。
  it('副 API 挂起时不挡回复：等够搭车窗口就先把话发出去', async () => {
    vi.useFakeTimers();
    try {
      // 永不回来的副 API（限流 / 挂起时就是这个样子）
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

      const store = makeStore();
      const pending = evalFire(store, { amsgEmotionEval: EVAL_SPEC });
      // 先把 hook 链推到「等评估搭车」那一步（中间还有几个 await），再拨表。
      for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(EMOTION_EVAL_RIDE_ALONG_MS);
      const { decision } = await pending;

      expect(decision.decision).toBe('finish');
      const payloads = decision.pushPayloads as Array<Record<string, any>>;
      // 正文一段不少地发出去了 —— 这才是用户在等的东西
      expect(payloads.map((p) => p.message)).toEqual(['在的。', '怎么啦？']);

      const lastMeta = payloads[payloads.length - 1].metadata;
      // 结果没赶上就不搭这班车，但也不作废：挂引用键 + pending 标记，客户端对着键
      // 轮询补落（灯继续亮着，等 amsgFireSettled 把迟到的结果写进旁路）。
      expect(lastMeta.amsgEmotionUpdate).toBeUndefined();
      expect(lastMeta.amsgEmotionRef).toBe(`emotion_update:${CLIENT_TASK_ID}`);
      expect(lastMeta.amsgEmotionPending).toBe(true);
      expect(lastMeta.amsgEmotionDone).toBeUndefined();
      expect(lastMeta.amsgEmotionError).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // 晚投不丢：没赶上顺风车的评估，收尾（amsgFireSettled）等它出结果写进旁路存储，
  // 客户端按 push 上的引用键轮询补落。回归守卫——以前这一轮评估是直接作废的。
  it('没赶上的评估晚投不丢：收尾时写进旁路存储', async () => {
    vi.useFakeTimers();
    try {
      let resolveEval!: (r: Response) => void;
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveEval = resolve; })));

      const store = makeStore();
      const pending = evalFire(store, { amsgEmotionEval: EVAL_SPEC });
      for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(EMOTION_EVAL_RIDE_ALONG_MS);
      const { decision, scratch } = await pending;
      const lastMeta = (decision.pushPayloads as Array<Record<string, any>>).slice(-1)[0].metadata;
      expect(lastMeta.amsgEmotionPending).toBe(true);

      // 收尾开始后评估才回来 → 结果落进旁路键，客户端轮询取得到
      const settling = amsgFireSettled({
        status: 'sent', sentCount: 2, task: { retry_count: 0 },
        scratch, writeState: store.writeState,
      } as any);
      resolveEval(new Response(JSON.stringify({
        choices: [{ message: { content: '{"changed":true,"buffs":[]} LATE-EVAL-MARKER' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
      for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(0);
      await settling;

      expect(store.rows.get(`emotion_update:${CLIENT_TASK_ID}`)).toContain('LATE-EVAL-MARKER');
    } finally {
      vi.useRealTimers();
    }
  });

  // 一段都没送出去（推送全灭 → 任务整轮重跑）时不写晚投：客户端没收到 pending 标记，
  // 没人会来取这一份，重跑的那轮会带着自己的评估重新走完整流程。评估一直没跑出来时，
  // 失败收尾那段「留给下一跳」的等待也是有界的（搭车窗口那么久），等不到就空手收尾。
  it('推送没送出去时收尾不写晚投评估', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

      const store = makeStore();
      const pending = evalFire(store, { amsgEmotionEval: EVAL_SPEC });
      for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(EMOTION_EVAL_RIDE_ALONG_MS);
      const { scratch } = await pending;

      const settling = amsgFireSettled({
        status: 'failed', sentCount: 0, task: { retry_count: 0 },
        error: new Error('push send failed'),
        scratch, writeState: store.writeState,
      } as any);
      for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(0);
      // 失败收尾那段有界等待（评估结果留给下一跳复用）也要拨过去
      await vi.advanceTimersByTimeAsync(EMOTION_EVAL_RIDE_ALONG_MS);
      await settling;

      expect(store.rows.has(`emotion_update:${CLIENT_TASK_ID}`)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // fire 重试白烧评估费的回归守卫：失败那跳的收尾把已出的评估结果写进旁路键
  // （amsgEmotionUpdateKey，重试跨 tick 唯一能带过来的位置），下一跳 onBeforeFire
  // 读到就直接复用——2/4/6 分钟梯子打满也只烧一次副 API。
  it('fire 失败重试：第二跳复用上一跳的评估结果，副 API 只调 1 次', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"changed":true,"buffs":[]} RETRY-EVAL-MARKER' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);

    const store = makeStore();
    // 第一跳：生成完但这跳失败（比如推送没发出去），任务还会重试
    const first = await evalFire(store, { amsgEmotionEval: EVAL_SPEC });
    await amsgFireSettled({
      status: 'failed', sentCount: 0, task: { retry_count: 0 },
      error: new Error('push send failed'),
      scratch: first.scratch, writeState: store.writeState,
    } as any);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(store.rows.get(`emotion_update:${CLIENT_TASK_ID}`), '失败收尾该把结果留给下一跳')
      .toContain('RETRY-EVAL-MARKER');

    // 第二跳（重试）：评估一个请求都不再发，结果照常随末条 push 回客户端
    const second = await evalFire(store, { amsgEmotionEval: EVAL_SPEC });
    expect(fetchSpy, '第二跳不许再烧一次副 API').toHaveBeenCalledTimes(1);
    const lastMeta = (second.decision.pushPayloads as Array<Record<string, any>>).slice(-1)[0].metadata;
    expect(lastMeta.amsgEmotionUpdate).toContain('RETRY-EVAL-MARKER');
    expect(lastMeta.amsgEmotionDone).toBe(true);
  });

  // 正常情况下评估早就跑完了，搭车窗口一秒都用不上——不能因为加了窗口就变成「每轮都等」。
  it('评估已经跑完时立刻搭上车，不白等那个窗口', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"changed":true,"buffs":[]} FAST-EVAL' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const startedAt = Date.now();
    const { decision } = await evalFire(makeStore(), { amsgEmotionEval: EVAL_SPEC });
    const lastMeta = (decision.pushPayloads as Array<Record<string, any>>).slice(-1)[0].metadata;
    expect(lastMeta.amsgEmotionUpdate).toContain('FAST-EVAL');
    expect(Date.now() - startedAt).toBeLessThan(EMOTION_EVAL_RIDE_ALONG_MS);
  });

  // 报错正文里带回一小段够定位是限流还是鉴权就行，但**绝不能把 key 带出来**：
  // 个别中转会把整个请求（含 Authorization 头）回显在错误页里，而这句话要走 push 出门。
  it('失败原因里的凭据打码（中转把请求回显在错误页里也不漏）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'Unauthorized for Bearer sk-secondary-KEYLEAK on model eval-mini', { status: 401 })));

    const store = makeStore();
    const { decision } = await evalFire(store, { amsgEmotionEval: EVAL_SPEC });
    const payloads = decision.pushPayloads as Array<Record<string, any>>;
    const reason = String(payloads[payloads.length - 1].metadata.amsgEmotionError);

    expect(reason).toContain('副 API HTTP 401');
    expect(reason).toContain('***');
    expect(reason).not.toContain('sk-secondary-KEYLEAK');
    expect(JSON.stringify(payloads)).not.toContain('sk-secondary-KEYLEAK');
  });

  it('评估模型没吐东西 → 原因说清是「没输出」，不是网络问题', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const store = makeStore();
    const { decision } = await evalFire(store, { amsgEmotionEval: EVAL_SPEC });
    const lastMeta = (decision.pushPayloads as Array<Record<string, any>>).slice(-1)[0].metadata;
    expect(lastMeta.amsgEmotionDone).toBe(true);
    expect(lastMeta.amsgEmotionUpdate).toBeUndefined();
    expect(lastMeta.amsgEmotionError).toContain('评估模型没有输出内容');
    expect(lastMeta.amsgEmotionError).toContain('length');
  });

  // 上游判「这次 hook 不接手」的依据就是 onBeforeFire 返回 null/undefined，那之后走的
  // 模板路径会把整份解密 metadata 直接挂上每条推送。即时对话这条路绝不能落到那儿——
  // 一是凭据，二是那条路会拿主动消息的模板去答用户刚说的话。
  it('即时对话永远不返回 undefined（返回了就等于把整轮交给上游模板路径）', async () => {
    // 评估会真发一个请求，这里只关心返回值，随便挡掉（不挡就去解真域名，慢且看网络脸色）
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const store = makeStore();
    const scratch: Record<string, unknown> = {};
    const metadata = {
      charId: CHAR_ID, amsgClientTaskId: CLIENT_TASK_ID,
      amsgMode: 'instant', amsgInstantChat: true,
      amsgEmotionEval: EVAL_SPEC,
    };
    const result = await amsgHooks.onBeforeFire({
      task: {
        id: 42, uuid: TASK_UUID, contactName: 'Nyah', recurrenceType: 'none',
        nextSendAt: '2026-07-25T12:00:00.000Z', metadata,
      },
      userId: 'u1', readState: store.readState, writeState: store.writeState,
      now: NOW, scratch,
    } as any);

    expect(result).not.toBeUndefined();
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('messages');
    // 就算哪天真漏出去了，凭据也已经不在那个对象上了（第一道防线的意义就在这儿）
    expect(metadata).not.toHaveProperty('amsgEmotionEval');
  });

  // 只删这一个键：别的字段（防穿帮闸的锚点、任务归属键、amsgMode…）后面还要用，
  // 顺手删多了会以静默走样的方式坏掉——比如 amsgMode 没了，推送就成了 'auto'。
  it('只摘走评估配置，别的任务字段一个不动', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const store = makeStore();
    const { metadata } = await evalFire(store, {
      amsgEmotionEval: EVAL_SPEC,
      amsgAnchorMs: 1_700_000_000_000,
    });
    expect(metadata).not.toHaveProperty('amsgEmotionEval');
    expect(metadata).toMatchObject({
      charId: CHAR_ID,
      amsgClientTaskId: CLIENT_TASK_ID,
      amsgMode: 'instant',
      amsgInstantChat: true,
      amsgAnchorMs: 1_700_000_000_000,
    });
  });

  it('没配评估就一个请求都不发（老配置 / 没开情绪评估的角色）', async () => {
    const fetchSpy = vi.fn(async () => new Response('never', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const store = makeStore();
    const { decision } = await evalFire(store, {});
    expect(decision.decision).toBe('finish');
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const payload of decision.pushPayloads as Array<Record<string, any>>) {
      expect(payload.metadata.amsgEmotionUpdate).toBeUndefined();
    }
  });
});

describe('即时对话的接线', () => {
  const fullEnv = {
    AMSG_MASTER_KEY: 'a'.repeat(64),
    VAPID_EMAIL: 'mailto:a@b.c',
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    DB: { prepare: () => {} },
  } as any;

  const call = (url: string, init: RequestInit = {}, env: any = fullEnv) =>
    (worker as any).fetch(new Request(url, init), env, { waitUntil: () => {} });

  it('/config-check 带包装层能力标志（设置页拿它当唯一的版本门槛）', async () => {
    const response = await call('https://w.example/config-check');
    const body = await response.json();
    expect(body.data.instantChat).toBe(true);
  });

  /**
   * 回归守卫：「有这条路由」和「这条路真的能用」必须分开报。
   *
   * 自更新是由用户那台 Worker 上的**旧代码**执行的，而旧代码不认识 Durable Object——
   * 它传上去的新 bundle 不带 INSTANT_TICK 绑定。于是有个中间态：代码是新的、
   * workerVersion 也对上了，`/instant-chat` 却只能回 503。只报 instantChat / 版本号的话，
   * 前端会一边说「已经是最新版」一边发一条挂一条。前端的能力门槛认的就是这个字段。
   */
  it('/config-check 单独报起跳器接没接上：没绑定就是 false', async () => {
    const body = await (await call('https://w.example/config-check')).json();
    expect(body.data.instantTick).toBe(false);
    // 中间态的长相：路由在、版本号也是新的，唯独这条路跑不动。
    expect(body.data.instantChat).toBe(true);
    expect(typeof body.data.workerVersion).toBe('string');
  });

  it('/config-check 绑定在就是 true', async () => {
    const withTick = { ...fullEnv, INSTANT_TICK: { idFromName: () => ({}), get: () => ({ kick: async () => {} }) } };
    const body = await (await call('https://w.example/config-check', {}, withTick)).json();
    expect(body.data.instantTick).toBe(true);
  });

  it('/instant-chat 的预检要放行，否则带自定义头的正式请求根本发不出去', async () => {
    const response = await call('https://w.example/instant-chat', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('/instant-chat 只接受 POST', async () => {
    const response = await call('https://w.example/instant-chat', { method: 'GET' });
    expect(response.status).toBe(405);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('配置不全时 /instant-chat 也回 503（不进上游、不半路落状态）', async () => {
    const response = await call(
      'https://w.example/instant-chat',
      { method: 'POST', body: '{}' },
      { AMSG_MASTER_KEY: '', DB: undefined } as any,
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('WORKER_CONFIG_MISSING');
  });

  it('不再显式配 claimLeaseMs：租约交给上游的心跳续租（30s 一跳滚动，isolate 死后 ~90s 接手）', () => {
    // 回归守卫：把 claimLeaseMs 加回来会关不掉心跳（上游按「配置了就用你的」处理的是
    // 无心跳分支的 TTL），isolate 死亡恢复窗又变回按最长 fire 定格的十几分钟。
    // 心跳自己会盖住即时对话 600s 的 fire——fire 跑多久租约就滚多久。
    const cfg = buildWorkerConfig(fullEnv) as Record<string, unknown>;
    expect(cfg.claimLeaseMs).toBeUndefined();
  });
});

// 即时对话终态失败的直发通知：判死那一刻推一条 messageKind:'error'，前台当场收尾、
// 后台弹横幅，不用干等 60s 点名。红线是「还会重试的失败绝不发」——报错完回复又到
// 是双通道老教训里最伤的误报。回归守卫：没有直发通道时这些场合一条 push 都不会有。
describe('即时对话终态失败的直发 error push', () => {
  const CLIENT_TASK_ID = 'client-task-errpush';
  const CHAT_MESSAGES = [
    { role: 'system', content: '你是 Nyah。' },
    { role: 'user', content: '在吗' },
  ];
  const INSTANT_META = {
    amsgClientTaskId: CLIENT_TASK_ID,
    amsgMode: 'instant',
    amsgInstantChat: true,
  };

  const makeErrorPushDeps = () => {
    const sent: Array<{ subscription: any; body: any }> = [];
    const row = {
      user_id: 'u1',
      // 明文兜底路径：解密失败 → 按明文 JSON 再试（老部署的订阅行）
      subscription: JSON.stringify({ endpoint: 'https://push.example/e1', keys: {} }),
    };
    const first = vi.fn(async () => row);
    const deps = {
      webpush: {
        sendNotification: vi.fn(async (subscription: unknown, body: string) => {
          sent.push({ subscription, body: JSON.parse(body) });
        }),
      },
      db: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })), first })) },
      masterKey: 'a'.repeat(64),
    };
    return { deps, sent };
  };

  afterEach(() => configureInstantErrorPush(null));

  it('重试打光（retry_count >= 3）的失败 → 直发 error push（when-hidden）', async () => {
    const { deps, sent } = makeErrorPushDeps();
    configureInstantErrorPush(deps as any);

    const store = makeFireStore(CHAT_MESSAGES);
    const { scratch } = await runFire(store, { metadata: INSTANT_META, llmOutput: '在的。' });
    await amsgFireSettled({
      status: 'failed', sentCount: 0,
      task: { retry_count: 3, user_id: 'u1' },
      error: new Error('LLM 上游 502'),
      scratch, writeState: store.writeState,
    } as any);

    expect(sent).toHaveLength(1);
    const payload = sent[0].body;
    expect(payload.messageKind).toBe('error');
    expect(payload.metadata.taskUuid).toBe(TASK_UUID);
    expect(payload.metadata.charId).toBe(CHAR_ID);
    expect(payload.metadata.reason).toContain('LLM 上游 502');
    expect(payload.notification.show).toBe('when-hidden');
    expect(payload.messageId).toBe(`err_${TASK_UUID}`);
    // 订阅行按 user_id 查、明文兜底解出来
    expect((sent[0].subscription as any).endpoint).toBe('https://push.example/e1');
  });

  // permanent 终态（fireStateError 那族）最典型的发生位置在挂 stash 之前：收尾那份因
  // 读不到 stash 提前走人，一条通知都发不出——只能由 fail() 当场补发。回归守卫：
  // 这族失败以前是零通知，用户锁屏干等到超时。
  it('onBeforeFire 挂 stash 之前的 permanent 失败 → 恰好 1 条 error push（收尾不双发）', async () => {
    const { deps, sent } = makeErrorPushDeps();
    configureInstantErrorPush(deps as any);

    // 即时任务 + 云端没有 fire_pack：fail() 在挂 stash 之前抛 permanent 终态
    const { ctx, scratch } = makeCtx({
      metadata: { amsgMode: 'instant', amsgInstantChat: true, amsgClientTaskId: 'ct-err' },
      charRows: [],
    });
    const error = await amsgHooks.onBeforeFire(ctx).then(() => null, (e: unknown) => e);
    expect((error as { permanent?: boolean }).permanent).toBe(true);

    // fail() 的直发是 fire-and-forget，等它落地
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body.messageKind).toBe('error');
    expect(sent[0].body.metadata.taskUuid).toBe(TASK_UUID);
    expect(sent[0].body.metadata.reason).toContain('fire_pack');
    expect(sent[0].body.messageId).toBe(`err_${TASK_UUID}`);

    // 上游随后照常调收尾（status failed、scratch 上没有 stash）→ 不双发
    await amsgFireSettled({
      status: 'failed', sentCount: 0, task: { retry_count: 0 }, error,
      scratch, writeState: vi.fn(async () => ({ upserted: 0, skipped: 0, deleted: 0 })),
    } as any);
    expect(sent).toHaveLength(1);
  });

  // 挂上 stash 之后才炸出的 permanent 也是终态（上游一跳就把行标 failed），
  // 不能拿「retry 还没打光」当没到终态——那样这族失败同样零通知。
  it('挂上 stash 之后的 permanent 失败 → 收尾直发，不用等重试打光', async () => {
    const { deps, sent } = makeErrorPushDeps();
    configureInstantErrorPush(deps as any);

    const store = makeFireStore(CHAT_MESSAGES);
    const { scratch } = await runFire(store, { metadata: INSTANT_META, llmOutput: '在的。' });
    const error = Object.assign(new Error('状态坏了，重试也没用'), { permanent: true });
    await amsgFireSettled({
      status: 'failed', sentCount: 0, task: { retry_count: 0, user_id: 'u1' }, error,
      scratch, writeState: store.writeState,
    } as any);

    expect(sent).toHaveLength(1);
    expect(sent[0].body.messageKind).toBe('error');
    expect(sent[0].body.metadata.reason).toContain('状态坏了');
  });

  it('还会重试的失败（retry_count < 3）绝不发——报错完回复又到是最伤的误报', async () => {
    const { deps, sent } = makeErrorPushDeps();
    configureInstantErrorPush(deps as any);

    const store = makeFireStore(CHAT_MESSAGES);
    const { scratch } = await runFire(store, { metadata: INSTANT_META, llmOutput: '在的。' });
    await amsgFireSettled({
      status: 'failed', sentCount: 0,
      task: { retry_count: 1, user_id: 'u1' },
      error: new Error('临时抖动'),
      scratch, writeState: store.writeState,
    } as any);

    expect(sent).toHaveLength(0);
  });

  it('skip-push（空输出，一锤定音）→ 直发，横幅文案是人话', async () => {
    const { deps, sent } = makeErrorPushDeps();
    configureInstantErrorPush(deps as any);

    const store = makeFireStore(CHAT_MESSAGES);
    const { decision } = await runFire(store, { metadata: INSTANT_META, llmOutput: '' });
    expect((decision as any).decision).toBe('skip-push');

    expect(sent).toHaveLength(1);
    expect(sent[0].body.metadata.reason).toBe('empty-generation');
    expect(sent[0].body.notification.body).toContain('没有生成内容');
  });

  it('stale 跳过（一锤定音）→ 直发', async () => {
    const { deps, sent } = makeErrorPushDeps();
    configureInstantErrorPush(deps as any);

    const writeState = vi.fn(async () => ({ upserted: 1, skipped: 0, deleted: 0 }));
    await amsgStaleSkip(
      { id: 1, uuid: TASK_UUID },
      {
        reason: 'stale', action: 'expired',
        metadata: { charId: CHAR_ID, amsgInstantChat: true },
        occurrenceMs: Date.now(), skippedCount: 1, nextSendAt: null,
        writeState,
      } as any,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].body.metadata.reason).toBe('stale');
  });

  it('直发通道没配（deps 为 null）时静默跳过，收尾不炸', async () => {
    const store = makeFireStore(CHAT_MESSAGES);
    const { scratch } = await runFire(store, { metadata: INSTANT_META, llmOutput: '在的。' });
    await expect(amsgFireSettled({
      status: 'failed', sentCount: 0,
      task: { retry_count: 3, user_id: 'u1' },
      error: new Error('LLM 上游 502'),
      scratch, writeState: store.writeState,
    } as any)).resolves.toBeUndefined();
  });
});

// 回归守卫：「登记状态全绿、到点一条都不来」的唯一出口。
//
// 浏览器有订阅、库里也登记着同一条 endpoint，两边都自洽，但那条 endpoint 在推送服务
// 那侧已经作废——推过去只换回一个 410。这件事只有推送服务知道，所以事实由上游
// amsg-server 结构化写进 last_error.pushStatus，这里只负责读出来。
//
// 关键约束：**只认 pushStatus 这个结构化字段，不去解析 reason 那句人话**。reason 是
// 给用户看的自由文本，拿它当接口用的话，上游改个措辞这里就静默失效，而且不会有任何
// 测试挂——那正是「全绿但一条不来」重新长出来的方式。
describe('inspectPushDelivery — 推送有没有真的送出去', () => {
  const REGISTERED_AT = Date.parse('2026-08-10T04:00:00.000Z');

  /** 一个只回 last_error 列的假 D1。 */
  const fakeDb = (rows: Array<{ last_error: string | null }>, explode = false) => ({
    prepare: () => ({
      all: async () => {
        if (explode) throw new Error('no such column: last_error');
        return { results: rows };
      },
      bind: () => ({ first: async () => null }),
      first: async () => null,
    }),
  }) as any;

  const failureRow = (at: string, extra: Record<string, unknown>) => ({
    last_error: JSON.stringify({ at, occurrence: at, reason: '随便什么人话摘要', ...extra }),
  });

  it('认结构化的 410，交出状态码和时刻', async () => {
    const result = await inspectPushDelivery(
      fakeDb([failureRow('2026-08-10T05:06:00.000Z', { pushStatus: 410 })]),
      REGISTERED_AT,
    );
    expect(result).toEqual({
      gone: { status: 410, atMs: Date.parse('2026-08-10T05:06:00.000Z') },
      registeredAtMs: REGISTERED_AT,
    });
  });

  it('404（端点根本不存在）同样算失效', async () => {
    const result = await inspectPushDelivery(
      fakeDb([failureRow('2026-08-10T05:06:00.000Z', { pushStatus: 404 })]),
      REGISTERED_AT,
    );
    expect(result?.gone?.status).toBe(404);
  });

  it('reason 里写着 410 但没有 pushStatus → 不认', async () => {
    // 这条就是「别把人话当接口」的守卫：上游给不出结构化字段时，宁可报「没查到」，
    // 也不去正则匹配一句随时会变的错误摘要。
    const result = await inspectPushDelivery(
      fakeDb([{
        last_error: JSON.stringify({
          at: '2026-08-10T05:06:00.000Z',
          reason: 'Web Push delivery failed: 410 Gone — push subscription has unsubscribed or expired.',
        }),
      }]),
      REGISTERED_AT,
    );
    expect(result).toEqual({ gone: null, registeredAtMs: REGISTERED_AT });
  });

  it('别的推送失败（403 / 500）不算订阅失效——重置订阅治不了那些', async () => {
    const result = await inspectPushDelivery(
      fakeDb([
        failureRow('2026-08-10T05:06:00.000Z', { pushStatus: 403 }),
        failureRow('2026-08-10T05:07:00.000Z', { pushStatus: 500 }),
      ]),
      REGISTERED_AT,
    );
    expect(result?.gone).toBeNull();
  });

  it('多条里挑最近的那次——用户要判断的是「现在还坏不坏」', async () => {
    const result = await inspectPushDelivery(
      fakeDb([
        failureRow('2026-08-10T05:06:00.000Z', { pushStatus: 410 }),
        failureRow('2026-08-10T06:30:00.000Z', { pushStatus: 410 }),
        failureRow('2026-08-10T02:00:00.000Z', { pushStatus: 410 }),
      ]),
      REGISTERED_AT,
    );
    expect(result?.gone?.atMs).toBe(Date.parse('2026-08-10T06:30:00.000Z'));
  });

  it('坏 JSON / 时刻解析不出来的行跳过，不带崩整次自查', async () => {
    const result = await inspectPushDelivery(
      fakeDb([
        { last_error: '不是 JSON' },
        { last_error: null },
        failureRow('不是时间', { pushStatus: 410 }),
      ]),
      REGISTERED_AT,
    );
    expect(result).toEqual({ gone: null, registeredAtMs: REGISTERED_AT });
  });

  it('查询本身挂了（老库没有 last_error 列）→ null = 这一项没查出来', async () => {
    // 界面拿 null 显示「没查成」，不是绿灯——假绿灯正是这一整条链要治的病。
    expect(await inspectPushDelivery(fakeDb([], true), REGISTERED_AT)).toBeNull();
  });
});

// 交付顺序守卫（这条挂着 = 这活还没干完，不是坏了）。
//
// 上面那段 inspectPushDelivery 读的是上游写进 last_error 的 pushStatus，而**上游从
// 2.6.0-next.20 才开始写它**。依赖还锁在更早的版本时打出来的 bundle 是最坏的组合：
// 「查了这一项」（probed: true）+「一次都没被退回」（gone 永远是 null）= 一个理直气壮
// 的绿灯，而整条改动的存在意义就是干掉这个绿灯。
//
// 所以这条测试就是发布门禁：上游发版、这边 pnpm up 到 next.20 之后它自己会变绿。
describe('打包进来的 amsg-server 得会写 pushStatus', () => {
  it('依赖版本 >= 2.6.0-next.20（低于它 inspectPushDelivery 会一路绿灯说谎）', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf-8'),
    );
    const version = String(
      pkg.devDependencies?.['@rei-standard/amsg-server']
      ?? pkg.dependencies?.['@rei-standard/amsg-server'],
    );
    expect(
      isAmsgServerVersionAtLeast(version, '2.6.0-next.20'),
      `package.json 里还锁着 ${version}：那个版本的上游不写 last_error.pushStatus，`
      + '打出来的 worker 会把「推送投递」这一项一路报绿。等上游发版后升到 next.20 再打 bundle。',
    ).toBe(true);
  });
});
