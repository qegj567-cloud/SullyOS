/**
 * 定时任务细账：到点没发出去的任务各自卡在哪一步、报了什么错，以及每分钟那一跳自己
 * 出过什么错。给体检面板「定时任务」那一行用（GET /tick-report，要共享密钥）。
 *
 * 回执形状和「一条过期任务算哪种情况」的判定在 utils/amsgTickReport.ts（前端共用）；
 * 这里只管读库、解密出是哪个角色的任务，以及把整轮报错记进库里。
 *
 * **整轮报错为什么要自己记**：上游 scheduled() 挂了只会把原因当返回值交出来、再打一行
 * 日志，库里什么都不留。而「每一跳一开头就挂」恰恰是任务行上一点痕迹都没有的那种坏法
 * ——任务行只记得「我还没发」，说不出为什么。不记进库的话，这句原话只在 Cloudflare 的
 * 日志里，大多数人根本不知道那个入口在哪。
 *
 * 只在出错时写一笔，正常的那一跳什么都不写：心跳式的「每分钟记一次」会让 D1 的写入
 * 次数平白多出一天一千四百多笔，而用户关心的只是出错的那几次。
 */

import {
  decryptFromStorage,
  deriveUserEncryptionKey,
  summarizeErrorCause,
} from '@rei-standard/amsg-server/cloudflare';
import {
  classifyOverdueTasks,
  CLOUD_CLEANUP_STAGE,
  judgeOverdueTasks,
  TICK_FAILURE_SERIES_GAP_MS,
  type AmsgTaskErrorRecord,
  type AmsgTickFailureRecord,
  type AmsgTickReport,
  type AmsgTickReportFailure,
  type AmsgTickReportTask,
  type TickTaskFacts,
} from '../../../utils/amsgTickReport';
import { isInstantChatTask, readTaskKind } from '../../../utils/amsgTaskKinds';

export type TickReportDb = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
      all<T = unknown>(): Promise<{ results?: T[] }>;
      run(): Promise<unknown>;
    };
    first<T = unknown>(): Promise<T | null>;
    all<T = unknown>(): Promise<{ results?: T[] }>;
    run(): Promise<unknown>;
  };
};

/** 同一个角色的任务归一组（跟 worker 配给上游的 serializeBy 是同一个函数）。 */
export type SerializeKeyOf = (task: { metadata?: Record<string, unknown> | null }) => string | null;

/** 一次最多列多少条过期任务。单用户手上正常不会有这么多，多了说明整个都停了，列前面这些就够看。 */
const MAX_OVERDUE_TASKS = 50;
/** 最近失败列多少条、往回看多久。 */
const MAX_RECENT_FAILURES = 10;
const RECENT_FAILURE_WINDOW_MS = 24 * 60 * 60_000;

/** 读过期任务要用的列。retry_after / lease_until / last_error 是后加的列，老库没有的话这条查询会挂。 */
const TASK_COLUMNS = `uuid, user_id, encrypted_payload, message_type, status, next_send_at,
       retry_count, retry_after, lease_until, created_at, updated_at, last_error`;

interface TaskRow {
  uuid: string | null;
  user_id: string | null;
  encrypted_payload: string | null;
  message_type: string | null;
  status: string | null;
  next_send_at: string | null;
  retry_count: number | null;
  retry_after: string | null;
  lease_until: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_error: string | null;
}

const parseMs = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const toIso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** 任务行上的 last_error。存的应该是 JSON；万一不是，整段当原文，不丢。 */
const parseLastError = (raw: string | null): AmsgTaskErrorRecord | null => {
  if (!raw) return null;
  let value: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw);
    value = parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return { at: null, occurrence: null, reason: raw, errorCode: null, pushStatus: null };
  }
  if (!value) return null;
  const pick = (key: string) => (typeof value?.[key] === 'string' && value[key] ? (value[key] as string) : null);
  const pushStatus = Number(value.pushStatus);
  return {
    at: pick('at'),
    occurrence: pick('occurrence'),
    reason: pick('reason') || '',
    errorCode: pick('errorCode'),
    pushStatus: Number.isFinite(pushStatus) && pushStatus > 0 ? pushStatus : null,
  };
};

/** 这条失败记录是不是记的「这一次到点」。循环任务上一次的旧账不算。 */
const isCurrentOccurrence = (error: AmsgTaskErrorRecord, nextSendAtMs: number): boolean => {
  const occurrenceMs = parseMs(error.occurrence);
  if (occurrenceMs !== null) return occurrenceMs === nextSendAtMs;
  const atMs = parseMs(error.at);
  return atMs !== null && atMs >= nextSendAtMs;
};

interface TaskIdentity {
  charId: string | null;
  contactName: string | null;
  kind: string | null;
  serializeKey: string | null;
  instantChat: boolean;
}

/**
 * 解开任务内容，认出是哪个角色的。解不开（主密钥换过、内容坏了）就全是 null——
 * 细账照样出，只是说不出名字；这时候更要紧的是让人看到后面那段报错。
 */
const createIdentityReader = (masterKey: string | undefined, serializeKeyOf: SerializeKeyOf) => {
  const userKeys = new Map<string, Promise<string>>();
  return async (row: TaskRow): Promise<TaskIdentity> => {
    const unknown: TaskIdentity = { charId: null, contactName: null, kind: null, serializeKey: null, instantChat: false };
    if (!masterKey || !row.user_id || !row.encrypted_payload) return unknown;
    try {
      let userKey = userKeys.get(row.user_id);
      if (!userKey) {
        userKey = deriveUserEncryptionKey(row.user_id, masterKey);
        userKeys.set(row.user_id, userKey);
      }
      const payload = JSON.parse(await decryptFromStorage(row.encrypted_payload, await userKey)) as {
        contactName?: unknown;
        metadata?: Record<string, unknown> | null;
      };
      const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : null;
      return {
        charId: typeof metadata?.charId === 'string' ? metadata.charId : null,
        contactName: typeof payload.contactName === 'string' && payload.contactName ? payload.contactName : null,
        kind: readTaskKind(metadata),
        serializeKey: serializeKeyOf({ metadata }),
        instantChat: isInstantChatTask(metadata),
      };
    } catch {
      return unknown;
    }
  };
};

export interface OverdueTasksResult {
  tasks: AmsgTickReportTask[];
  truncated: boolean;
  /** 合起来算什么状态（见 judgeOverdueTasks）。没有过期任务时是 healthy。 */
  verdict: 'stalled' | 'failing' | 'healthy';
}

/**
 * 读出所有到点还没发出去的任务，逐条判定现在算哪种情况。
 *
 * 查询本身挂了（老库还没有 retry_after 这些列）会原样抛出去，由调用方决定怎么退：
 * 体检退回只看「最老那条晚了多久」，细账端点照实报错。
 */
export const readOverdueTasks = async (
  db: TickReportDb,
  options: { masterKey?: string; serializeKeyOf: SerializeKeyOf; nowMs?: number },
): Promise<OverdueTasksResult> => {
  const nowMs = options.nowMs ?? Date.now();
  const rows = (await db
    .prepare(
      `SELECT ${TASK_COLUMNS}
         FROM scheduled_messages
        WHERE status = 'pending' AND next_send_at <= ?
        ORDER BY next_send_at ASC
        LIMIT ?`,
    )
    .bind(new Date(nowMs).toISOString(), MAX_OVERDUE_TASKS + 1)
    .all<TaskRow>()).results || [];

  const truncated = rows.length > MAX_OVERDUE_TASKS;
  const readIdentity = createIdentityReader(options.masterKey, options.serializeKeyOf);

  const prepared = (await Promise.all(rows.slice(0, MAX_OVERDUE_TASKS).map(async (row) => {
    const nextSendAtMs = parseMs(row.next_send_at);
    if (!row.uuid || nextSendAtMs === null) return null;
    const lastError = parseLastError(row.last_error);
    const currentError = lastError && isCurrentOccurrence(lastError, nextSendAtMs) ? lastError : null;
    const identity = await readIdentity(row);
    const facts: TickTaskFacts = {
      nextSendAtMs,
      createdAtMs: parseMs(row.created_at),
      updatedAtMs: parseMs(row.updated_at),
      retryAfterMs: parseMs(row.retry_after),
      leaseUntilMs: parseMs(row.lease_until),
      currentErrorAtMs: currentError ? parseMs(currentError.at) : null,
      serializeKey: identity.serializeKey,
    };
    return { row: { ...row, uuid: row.uuid }, nextSendAtMs, currentError, identity, facts };
  }))).filter((item): item is NonNullable<typeof item> => item !== null);

  const verdicts = classifyOverdueTasks(prepared.map((item) => item.facts), nowMs);

  const tasks = prepared.map(({ row, nextSendAtMs, currentError, identity, facts }, index): AmsgTickReportTask => {
    const verdict = verdicts[index];
    return {
      uuid: row.uuid,
      charId: identity.charId,
      contactName: identity.contactName,
      kind: identity.kind,
      messageType: row.message_type,
      nextSendAt: new Date(nextSendAtMs).toISOString(),
      state: verdict.state,
      stuck: verdict.stuck,
      retryCount: Number(row.retry_count) || 0,
      retryAfter: toIso(facts.retryAfterMs),
      lastStartedAt: toIso(verdict.lastStartedAtMs),
      unfinishedAttempt: verdict.unfinishedAttempt,
      lateStart: verdict.lateStart,
      queuedBehind: verdict.queuedBehind,
      lastError: currentError,
    };
  });

  return {
    tasks,
    truncated,
    verdict: judgeOverdueTasks(tasks.map((task, index) => ({
      verdict: verdicts[index],
      hasCurrentError: task.lastError !== null,
    }))),
  };
};

/**
 * 最近 24 小时彻底没发出去的：一次性任务标成了失败，或者循环任务跳过了这一次
 * （行还是 pending，排期已经推到以后，失败记录留在行上）。
 *
 * 即时对话的不列：它失败时聊天界面自己会说，放在这里是重复的噪音。即时对话和后台任务的
 * message_type 都是 'instant'，只有解开内容才分得出来，所以 SQL 不按类型筛、多取几行，
 * 解开后剔掉即时对话。
 * shortcut: 24 小时里即时对话失败多到占满多取的那几行时，别的失败会被挤掉；真遇到再改成分开查。
 */
export const readRecentFailures = async (
  db: TickReportDb,
  options: { masterKey?: string; serializeKeyOf: SerializeKeyOf; nowMs?: number },
): Promise<AmsgTickReportFailure[]> => {
  const nowMs = options.nowMs ?? Date.now();
  const sinceMs = nowMs - RECENT_FAILURE_WINDOW_MS;
  const rows = (await db
    .prepare(
      `SELECT ${TASK_COLUMNS}
         FROM scheduled_messages
        WHERE last_error IS NOT NULL
          AND updated_at >= ?
          AND (status = 'failed' OR (status = 'pending' AND next_send_at > ?))
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .bind(new Date(sinceMs).toISOString(), new Date(nowMs).toISOString(), MAX_RECENT_FAILURES * 3)
    .all<TaskRow>()).results || [];

  const readIdentity = createIdentityReader(options.masterKey, options.serializeKeyOf);
  const failures = await Promise.all(rows.map(async (row): Promise<AmsgTickReportFailure | null> => {
    const error = parseLastError(row.last_error);
    const atMs = parseMs(error?.at);
    // updated_at 会被后来的开跑刷新，真正「什么时候失败的」看记录自己的时刻。
    if (!row.uuid || !error || atMs === null || atMs < sinceMs) return null;
    const identity = await readIdentity(row);
    if (identity.instantChat) return null;
    return {
      uuid: row.uuid,
      charId: identity.charId,
      contactName: identity.contactName,
      kind: identity.kind,
      messageType: row.message_type,
      outcome: row.status === 'failed' ? 'failed' : 'skipped',
      error,
    };
  }));
  return failures.filter((item): item is AmsgTickReportFailure => item !== null).slice(0, MAX_RECENT_FAILURES);
};

// ─── 整轮报错 ───

/** worker 自己的诊断表：一行一个键，值是 JSON。跟上游的表分开，上游的 schema 自查不管它。 */
export const DIAGNOSTICS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS worker_diagnostics (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`;

/**
 * 读诊断表里的一个键。表还没建、行不在、读不了都当没有——这张表上的每一样都是
 * 「有就显示、没有就算了」的东西，读不到不该拖累任何主流程。
 */
export const readDiagnosticValue = async (db: TickReportDb | undefined, key: string): Promise<string | null> => {
  if (typeof db?.prepare !== 'function') return null;
  try {
    const row = await db
      .prepare('SELECT value FROM worker_diagnostics WHERE key = ?')
      .bind(key)
      .first<{ value: string }>();
    return typeof row?.value === 'string' ? row.value : null;
  } catch {
    return null;
  }
};

/** 写（或盖掉）诊断表里的一个键。表不在就顺手建。抛错交给调用方决定要不要认。 */
export const writeDiagnosticValue = async (db: TickReportDb, key: string, value: string, nowMs = Date.now()): Promise<void> => {
  await db.prepare(DIAGNOSTICS_TABLE_SQL).run();
  await db
    .prepare(
      `INSERT INTO worker_diagnostics (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, nowMs)
    .run();
};

const TICK_FAILURE_KEY = 'tick_failure';

/**
 * 上游收尾时写库失败的那几种状态（见上游 run-tick 的 failedTasks）。这几种不会在任务行上
 * 留下任何痕迹——要写的那一笔本身就没写进去——所以只能记在这里。
 * `post_send_cleanup_failed_marked_sent` / `…_rescheduled` 是补救成功了的，不算。
 */
const TASK_WRITE_FAILURE_STATUSES = new Set([
  'claim_failed',
  'retry_update_failed',
  'stale_update_failed',
  'post_send_cleanup_failed',
]);

type StoredTickFailure = Omit<AmsgTickFailureRecord, 'ongoing'>;

type TickFailureFields = Pick<StoredTickFailure, 'stage' | 'name' | 'message' | 'code'>;
type UpstreamCause = { stage?: unknown; name?: unknown; message?: unknown; code?: unknown };

const failureFromCause = (cause: UpstreamCause | undefined, fallbackStage: string): TickFailureFields => ({
  stage: typeof cause?.stage === 'string' && cause.stage ? cause.stage : fallbackStage,
  name: typeof cause?.name === 'string' && cause.name ? cause.name : 'Error',
  message: typeof cause?.message === 'string' ? cause.message : '',
  code: typeof cause?.code === 'string' && cause.code ? cause.code : null,
});

/**
 * 从上游 scheduled() 的返回值里认出这一跳要记的那个错。没出错返回 null。
 *
 * 一跳里可能同时有两个错：投递消息那一段的，和清理云端数据那一段的（`cloudCleanupCause`，
 * 它不拦投递）。只记一个，投递的优先——那个才是「消息为什么没来」。
 */
export const pickTickFailure = (outcome: unknown): TickFailureFields | null => {
  const value = outcome as {
    ok?: unknown;
    cause?: UpstreamCause;
    cloudCleanupCause?: UpstreamCause;
    summary?: { details?: { failedTasks?: unknown } };
  } | null;
  if (!value || typeof value !== 'object') return null;

  if (value.ok === false) return failureFromCause(value.cause, 'tick');

  const cleanupFailure = value.cloudCleanupCause && typeof value.cloudCleanupCause === 'object'
    ? failureFromCause(value.cloudCleanupCause, CLOUD_CLEANUP_STAGE)
    : null;

  const failedTasks = value.summary?.details?.failedTasks;
  if (!Array.isArray(failedTasks)) return cleanupFailure;
  const hit = failedTasks.find((entry) => TASK_WRITE_FAILURE_STATUSES.has(entry?.status)) as
    | { status: string; reason?: unknown; updateError?: unknown }
    | undefined;
  if (!hit) return cleanupFailure;

  const reason = typeof hit.reason === 'string' ? hit.reason : '';
  const updateError = typeof hit.updateError === 'string' ? hit.updateError : '';
  // 记失败原因那一笔没写进去时，丢的是两样东西：写库的错，和本来要记下的那个失败原因。
  // 两样都留着，后者正是用户想知道的「为什么没发出去」。
  const rawMessage = updateError
    ? `${updateError}（本来要记下的失败原因：${reason || '无'}）`
    : reason;
  // 上游给 failedTasks 的 reason 是没脱敏的原话，这里过一遍跟整轮报错同一套打码。
  const cause = summarizeErrorCause({ name: 'TaskWriteFailed', message: rawMessage }, 'tick');
  return { stage: hit.status, name: cause.name, message: cause.message ?? '', code: null };
};

/**
 * 把这一跳的报错记进库。同一种错连着出现就并成一串（只更新最后一次和次数）。
 *
 * best-effort：库本身挂了的时候这一笔多半也写不进去，那也只能认——不能让记账的错
 * 反过来盖掉 scheduled() 的正常收尾。
 */
export const recordTickOutcome = async (db: TickReportDb | undefined, outcome: unknown, nowMs = Date.now()): Promise<void> => {
  const failure = pickTickFailure(outcome);
  if (!failure || typeof db?.prepare !== 'function') return;
  try {
    const previous = parseStoredTickFailure(await readDiagnosticValue(db, TICK_FAILURE_KEY));
    const sameSeries = previous
      && previous.stage === failure.stage
      && previous.name === failure.name
      && nowMs - Date.parse(previous.lastAt) <= TICK_FAILURE_SERIES_GAP_MS;
    const nowIso = new Date(nowMs).toISOString();
    const record: StoredTickFailure = {
      ...failure,
      firstAt: sameSeries ? previous.firstAt : nowIso,
      lastAt: nowIso,
      count: sameSeries ? previous.count + 1 : 1,
    };
    await writeDiagnosticValue(db, TICK_FAILURE_KEY, JSON.stringify(record), nowMs);
  } catch (error) {
    console.warn('[amsg:tick-report] 这一跳的报错没记进库', error);
  }
};

const parseStoredTickFailure = (raw: string | null | undefined): StoredTickFailure | null => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredTickFailure> | null;
    if (!value || typeof value.stage !== 'string' || typeof value.firstAt !== 'string' || typeof value.lastAt !== 'string') {
      return null;
    }
    return {
      stage: value.stage,
      name: typeof value.name === 'string' ? value.name : 'Error',
      message: typeof value.message === 'string' ? value.message : '',
      code: typeof value.code === 'string' ? value.code : null,
      firstAt: value.firstAt,
      lastAt: value.lastAt,
      count: Number(value.count) || 1,
    };
  } catch {
    return null;
  }
};

/** 读最近一次整轮报错。表还没建（从没出过错）或读不了都当没有。 */
export const readTickFailure = async (db: TickReportDb, nowMs = Date.now()): Promise<AmsgTickFailureRecord | null> => {
  const record = parseStoredTickFailure(await readDiagnosticValue(db, TICK_FAILURE_KEY));
  if (!record) return null;
  return { ...record, ongoing: nowMs - Date.parse(record.lastAt) <= TICK_FAILURE_SERIES_GAP_MS };
};

/** GET /tick-report 的完整回执。 */
export const buildTickReport = async (
  db: TickReportDb,
  options: { masterKey?: string; serializeKeyOf: SerializeKeyOf; nowMs?: number },
): Promise<AmsgTickReport> => {
  const nowMs = options.nowMs ?? Date.now();
  const scoped = { ...options, nowMs };
  const [overdue, recentFailures, tickFailure] = await Promise.all([
    readOverdueTasks(db, scoped),
    readRecentFailures(db, scoped),
    readTickFailure(db, nowMs),
  ]);
  return {
    now: new Date(nowMs).toISOString(),
    tasks: overdue.tasks,
    recentFailures,
    tickFailure,
    truncated: overdue.truncated,
  };
};
