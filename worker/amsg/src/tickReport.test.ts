/**
 * 定时任务细账（./tickReport）在真 SQLite 上跑：查询语句、列名是不是跟上游的建表语句对得上，
 * 用假库测不出来——列名写错时 /debug 会静默退回老判据，面板照常，谁也发现不了。
 *
 * 用的是 Node 自带的 node:sqlite（Node 22.5+），外面包一层 D1 的调用形状，表由上游自己的
 * initSchema 建。Node 太老没有它时整组跳过。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  createD1Adapter,
  deriveUserEncryptionKey,
  encryptForStorage,
  SCHEMA_VERSION,
} from '@rei-standard/amsg-server/cloudflare';
import worker, { amsgSerializeKey } from './index';
import {
  buildTickReport,
  pickTickFailure,
  readOverdueTasks,
  readRecentFailures,
  readTickFailure,
  recordTickOutcome,
  writeDiagnosticValue,
  type TickReportDb,
} from './tickReport';

type SqliteModule = { DatabaseSync: new (path: string) => any };
const sqlite: SqliteModule | null = (() => {
  try {
    // 走 require 绕开 Vite：它不认 node:sqlite 这个内置模块。
    return createRequire(import.meta.url)('node:sqlite');
  } catch {
    return null;
  }
})();

/** node:sqlite 包成 D1 的样子：prepare → bind → first / all / run，外加 batch。 */
const createD1 = () => {
  const db = new sqlite!.DatabaseSync(':memory:');
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => {
      const row = db.prepare(sql).get(...params);
      return row ? { ...row } : null;
    },
    all: async () => ({ results: db.prepare(sql).all(...params).map((row: object) => ({ ...row })), success: true, meta: {} }),
    run: async () => {
      const info = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: { run(): Promise<unknown> }[]) => {
      const results = [];
      for (const item of statements) results.push(await item.run());
      return results;
    },
    raw: db,
  };
};

const MASTER_KEY = 'a'.repeat(64);
const USER_ID = '8f0c6a2e-4b1d-4e8a-9c3f-2d7e5b1a6c90';
const NOW = Date.parse('2026-09-18T12:00:00.000Z');
const iso = (minutesFromNow: number) => new Date(NOW + minutesFromNow * 60_000).toISOString();

const createSchemaDb = async () => {
  const d1 = createD1();
  await createD1Adapter(d1 as any).initSchema();
  return d1;
};

let seq = 0;
const insertTask = async (d1: ReturnType<typeof createD1>, row: {
  contactName?: string;
  charId?: string;
  messageType?: string;
  status?: string;
  nextSendAt: string;
  retryCount?: number;
  retryAfter?: string | null;
  leaseUntil?: string | null;
  createdAt?: string;
  updatedAt?: string;
  lastError?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}) => {
  seq += 1;
  const uuid = `task-${seq}`;
  const payload = JSON.stringify({
    contactName: row.contactName ?? '小明',
    messageType: row.messageType ?? 'prompted',
    metadata: { charId: row.charId ?? 'char-a', ...row.metadata },
  });
  const encrypted = await encryptForStorage(payload, await deriveUserEncryptionKey(USER_ID, MASTER_KEY));
  d1.raw.prepare(
    `INSERT INTO scheduled_messages
      (user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count,
       retry_after, lease_until, created_at, updated_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    USER_ID,
    uuid,
    encrypted,
    row.messageType ?? 'prompted',
    row.nextSendAt,
    row.status ?? 'pending',
    row.retryCount ?? 0,
    row.retryAfter ?? null,
    row.leaseUntil ?? null,
    row.createdAt ?? iso(-180),
    row.updatedAt ?? row.createdAt ?? iso(-180),
    row.lastError ? JSON.stringify(row.lastError) : null,
  );
  return uuid;
};

const options = { masterKey: MASTER_KEY, serializeKeyOf: amsgSerializeKey, nowMs: NOW };

describe.skipIf(!sqlite)('定时任务细账（真 SQLite）', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('readOverdueTasks', () => {
    it('认出是哪个角色的任务，失败原文一个字不截地带出来', async () => {
      const d1 = await createSchemaDb();
      const reason = `AI API error: 429 Too Many Requests (https://relay.example/v1/chat/completions) — ${'额度用完了，'.repeat(30)}`;
      await insertTask(d1, {
        contactName: '小明',
        nextSendAt: iso(-40),
        retryCount: 2,
        retryAfter: iso(4),
        updatedAt: iso(-2),
        lastError: { at: iso(-2), occurrence: iso(-40), reason, errorCode: 'LLM_CALL_FAILED' },
      });

      const result = await readOverdueTasks(d1 as unknown as TickReportDb, options);
      expect(result.tasks).toHaveLength(1);
      const [task] = result.tasks;
      expect(task.contactName).toBe('小明');
      expect(task.charId).toBe('char-a');
      expect(task.state).toBe('retry-wait');
      expect(task.retryCount).toBe(2);
      expect(task.lastError?.reason).toBe(reason);
      expect(task.lastError?.errorCode).toBe('LLM_CALL_FAILED');
      expect(result.verdict).toBe('failing');
    });

    it('循环任务上一次到点留下的失败记录，不算这一次的', async () => {
      const d1 = await createSchemaDb();
      await insertTask(d1, {
        nextSendAt: iso(-1),
        lastError: { at: iso(-1440), occurrence: iso(-1441), reason: '昨天那次的错' },
        updatedAt: iso(-1440),
      });
      const [task] = (await readOverdueTasks(d1 as unknown as TickReportDb, options)).tasks;
      expect(task.lastError).toBeNull();
    });

    it('开跑过没下文的认得出来；同一个角色排在它后面的算排队', async () => {
      const d1 = await createSchemaDb();
      await insertTask(d1, { contactName: '小明', nextSendAt: iso(-30), updatedAt: iso(-3), leaseUntil: iso(-1) });
      await insertTask(d1, { charId: 'char-b', nextSendAt: iso(-12), updatedAt: iso(-12), leaseUntil: iso(1) });
      await insertTask(d1, { charId: 'char-b', nextSendAt: iso(-11) });

      const { tasks, verdict } = await readOverdueTasks(d1 as unknown as TickReportDb, options);
      expect(tasks.map((t) => t.state)).toEqual(['ready', 'sending', 'ready']);
      expect(tasks[0].unfinishedAttempt).toBe(true);
      expect(tasks[0].lastStartedAt).toBe(iso(-3));
      expect(tasks[2].queuedBehind).toBe(true);
      expect(tasks[2].stuck).toBe(false);
      expect(verdict).toBe('stalled');
    });

    it('主密钥对不上时说不出名字，但细账照出', async () => {
      const d1 = await createSchemaDb();
      await insertTask(d1, { nextSendAt: iso(-30) });
      const { tasks } = await readOverdueTasks(d1 as unknown as TickReportDb, { ...options, masterKey: 'b'.repeat(64) });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].contactName).toBeNull();
      expect(tasks[0].stuck).toBe(true);
    });
  });

  describe('readRecentFailures', () => {
    it('只列最近 24 小时彻底没发出去的：一次性失败、循环跳过、后台任务；即时对话和还在重试的不列', async () => {
      const d1 = await createSchemaDb();
      const failed = await insertTask(d1, {
        status: 'failed', nextSendAt: iso(-90), updatedAt: iso(-60),
        lastError: { at: iso(-60), occurrence: iso(-90), reason: '401 Invalid token' },
      });
      const skipped = await insertTask(d1, {
        nextSendAt: iso(1380), updatedAt: iso(-50),
        lastError: { at: iso(-50), occurrence: iso(-60), reason: 'stale', skippedCount: 1 },
      });
      await insertTask(d1, {
        messageType: 'instant', status: 'failed', nextSendAt: iso(-20), updatedAt: iso(-10),
        lastError: { at: iso(-10), occurrence: iso(-20), reason: '即时对话的错' },
        metadata: { amsgInstantChat: true },
      });
      // 回归守卫：后台任务也是 instant 行，不能跟着即时对话一起被按类型筛掉。
      const job = await insertTask(d1, {
        messageType: 'instant', status: 'failed', nextSendAt: iso(-40), updatedAt: iso(-30),
        lastError: { at: iso(-30), occurrence: iso(-40), reason: '门牌整理的错' },
        metadata: { amsgKind: 'plate-consolidate' },
      });
      await insertTask(d1, {
        status: 'failed', nextSendAt: iso(-3000), updatedAt: iso(-10),
        lastError: { at: iso(-2000), occurrence: iso(-3000), reason: '太久以前的错' },
      });
      await insertTask(d1, {
        nextSendAt: iso(-20), retryAfter: iso(2), retryCount: 1, updatedAt: iso(-1),
        lastError: { at: iso(-1), occurrence: iso(-20), reason: '还在重试' },
      });

      const failures = await readRecentFailures(d1 as unknown as TickReportDb, options);
      expect(failures.map((f) => [f.uuid, f.outcome])).toEqual([[job, 'failed'], [skipped, 'skipped'], [failed, 'failed']]);
      expect(failures[0].kind).toBe('plate-consolidate');
      expect(failures[2].error.reason).toBe('401 Invalid token');
    });
  });

  describe('整轮报错', () => {
    const tickFailed = (message: string, name = 'Error') => ({
      ok: false,
      cause: { stage: 'tick', name, message },
    });

    it('同一种错连着出现并成一串，隔久了或换了一种就重新起一串', async () => {
      const d1 = await createSchemaDb();
      const db = d1 as unknown as TickReportDb;
      await recordTickOutcome(db, tickFailed('D1_ERROR: no such column: retry_after'), NOW);
      await recordTickOutcome(db, tickFailed('D1_ERROR: no such column: retry_after'), NOW + 60_000);
      let record = await readTickFailure(db, NOW + 60_000);
      expect(record).toMatchObject({ count: 2, firstAt: iso(0), lastAt: iso(1), ongoing: true });
      expect(record?.message).toContain('no such column');

      await recordTickOutcome(db, tickFailed('timed out', 'TimeoutError'), NOW + 120_000);
      record = await readTickFailure(db, NOW + 120_000);
      expect(record).toMatchObject({ name: 'TimeoutError', count: 1, firstAt: iso(2) });

      await recordTickOutcome(db, tickFailed('timed out', 'TimeoutError'), NOW + 30 * 60_000);
      record = await readTickFailure(db, NOW + 40 * 60_000);
      expect(record).toMatchObject({ count: 1, firstAt: iso(30), ongoing: false });
    });

    it('正常的一跳什么都不写（连表都不建）', async () => {
      const d1 = await createSchemaDb();
      await recordTickOutcome(d1 as unknown as TickReportDb, { ok: true, summary: { details: { failedTasks: [] } } }, NOW);
      const table = d1.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'worker_diagnostics'").get();
      expect(table).toBeUndefined();
    });

    it('一跳里任务写库失败（行上留不下痕迹的那种）也记下来，原话过一遍脱敏', () => {
      const failure = pickTickFailure({
        ok: true,
        summary: {
          details: {
            failedTasks: [
              { taskId: 1, reason: '推送 410', retryCount: 1, nextRetryAt: iso(2) },
              {
                taskId: 2,
                reason: 'upstream said Bearer sk-abcdefghijklmnopqrstuvwxyz0123',
                status: 'retry_update_failed',
                updateError: 'D1_ERROR: database is locked',
              },
            ],
          },
        },
      });
      expect(failure?.stage).toBe('retry_update_failed');
      expect(failure?.message).toContain('database is locked');
      expect(failure?.message).toContain('本来要记下的失败原因');
      expect(failure?.message).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    });

    it('补救成功的收尾失败不算', () => {
      expect(pickTickFailure({
        ok: true,
        summary: { details: { failedTasks: [{ taskId: 3, reason: 'x', status: 'post_send_cleanup_failed_marked_sent' }] } },
      })).toBeNull();
    });

    it('清理云端数据那一段出错、消息照常投递的一跳：记清理的错', () => {
      expect(pickTickFailure({
        ok: true,
        summary: { details: { failedTasks: [] } },
        cloudCleanupCause: { stage: 'cloud-cleanup', name: 'D1_ERROR', message: 'no such table: x', code: null },
      })).toEqual({ stage: 'cloud-cleanup', name: 'D1_ERROR', message: 'no such table: x', code: null });
    });

    it('投递和清理同一跳都出错：记投递的那个', () => {
      const cloudCleanupCause = { stage: 'cloud-cleanup', name: 'D1_ERROR', message: 'cleanup boom' };
      expect(pickTickFailure({
        ok: false,
        cause: { stage: 'tick', name: 'D1_ERROR', message: 'tick boom' },
        cloudCleanupCause,
      })?.message).toBe('tick boom');
      expect(pickTickFailure({
        ok: true,
        summary: { details: { failedTasks: [{ taskId: 3, reason: 'write boom', status: 'claim_failed' }] } },
        cloudCleanupCause,
      })?.stage).toBe('claim_failed');
    });

    it('scheduled() 整轮挂了会记进库，细账里读得到原话', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const d1 = createD1(); // 一张表都没有：上游捞任务那一步必挂
      // 每跳开头会自己补表（见 autoUpdate.ensureSchemaOnce），先把「这版查过了」的记号
      // 写好让它跳过，空库才真的空到上游那一步。
      await writeDiagnosticValue(d1 as unknown as TickReportDb, 'schema_ensured', JSON.stringify({ ensuredFor: SCHEMA_VERSION, failedAtMs: null }));
      await (worker as any).scheduled({ scheduledTime: Date.now(), cron: '* * * * *' }, envWith(d1));

      const record = await readTickFailure(d1 as unknown as TickReportDb);
      // 空库上清理云端数据和捞任务两段都会挂，记下来的是拦住投递的那个。
      expect(record?.stage).toBe('tick');
      expect(record?.message).toContain('no such table');
      expect(record?.ongoing).toBe(true);
    });

    /**
     * 回归守卫：换过代码之后的第一跳要自己把表补齐。以前靠前端更新完点一次「重新连接」
     * 建表，后台自动换了代码时页面多半没开着，不自己补的话 cron 会因为缺表每分钟静默挂。
     */
    it('空库跑一跳：表由这一跳自己建出来，整轮不报错', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const d1 = createD1();
      await (worker as any).scheduled({ scheduledTime: Date.now(), cron: '* * * * *' }, envWith(d1));

      const tables = d1.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row: any) => row.name);
      expect(tables).toContain('scheduled_messages');
      expect(await readTickFailure(d1 as unknown as TickReportDb)).toBeNull();
    });
  });

  const envWith = (db: unknown, extra: Record<string, unknown> = {}) => ({
    AMSG_MASTER_KEY: MASTER_KEY,
    VAPID_EMAIL: 'mailto:a@b.c',
    VAPID_PUBLIC_KEY: 'pub-key',
    VAPID_PRIVATE_KEY: 'priv-key',
    AMSG_SERVER_TOKEN: 'shared-secret',
    DB: db,
    ...extra,
  } as any);

  describe('GET /tick-report', () => {
    const request = (headers: Record<string, string> = {}, method = 'GET') =>
      new Request('https://w.example/tick-report', { method, headers });

    it('配了共享密钥就必须带对：不带 401，带错 401，带对才回细账', async () => {
      const d1 = await createSchemaDb();
      await insertTask(d1, {
        nextSendAt: new Date(Date.now() - 40 * 60_000).toISOString(),
        lastError: { at: new Date().toISOString(), occurrence: new Date(Date.now() - 40 * 60_000).toISOString(), reason: '模型不存在' },
      });
      const env = envWith(d1);

      expect((await (worker as any).fetch(request(), env)).status).toBe(401);
      expect((await (worker as any).fetch(request({ 'X-Client-Token': 'wrong' }), env)).status).toBe(401);

      const response = await (worker as any).fetch(request({ 'X-Client-Token': 'shared-secret' }), env);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.tasks).toHaveLength(1);
      expect(body.data.tasks[0].lastError.reason).toBe('模型不存在');
      expect(body.data.tickFailure).toBeNull();
    });

    it('只接受 GET', async () => {
      const d1 = await createSchemaDb();
      const response = await (worker as any).fetch(request({ 'X-Client-Token': 'shared-secret' }, 'POST'), envWith(d1));
      expect(response.status).toBe(405);
    });

    it('buildTickReport 把三块拼在一起', async () => {
      const d1 = await createSchemaDb();
      await recordTickOutcome(d1 as unknown as TickReportDb, { ok: false, cause: { stage: 'config', name: 'VapidNotConfigured', message: 'VAPID / webpush 未配置，本跳跳过' } }, NOW);
      const report = await buildTickReport(d1 as unknown as TickReportDb, options);
      expect(report).toMatchObject({ tasks: [], recentFailures: [], truncated: false });
      expect(report.tickFailure?.name).toBe('VapidNotConfigured');
    });
  });

  describe('GET /debug 的定时任务判定', () => {
    const debug = async (d1: unknown) =>
      (await (await (worker as any).fetch(new Request('https://w.example/debug'), envWith(d1))).json()).data;

    /**
     * 回归守卫：一条在正常重试的任务到点四十分钟很平常（到点时刻在重试期间不会往后挪），
     * 只看晚了多久的话它会被判成 stalled，面板就会说「定时触发器可能没在跑」。
     */
    it('在失败重试的任务判成 failing，不是 stalled；报错原文不出这个端点', async () => {
      const d1 = await createSchemaDb();
      await insertTask(d1, {
        nextSendAt: new Date(Date.now() - 40 * 60_000).toISOString(),
        retryCount: 2,
        retryAfter: new Date(Date.now() + 4 * 60_000).toISOString(),
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
        lastError: {
          at: new Date(Date.now() - 60_000).toISOString(),
          occurrence: new Date(Date.now() - 40 * 60_000).toISOString(),
          reason: 'SECRET_REASON_SENTINEL',
        },
      });
      const data = await debug(d1);
      expect(data.tick).toBe('failing');
      expect(data.storage).toMatchObject({ overdueTasks: 1, stuckTasks: 0, retryingTasks: 1, overdueVerdict: 'failing' });
      const text = JSON.stringify(data);
      expect(text).not.toContain('SECRET_REASON_SENTINEL');
      expect(text).not.toContain('小明');
    });

    it('真没人领的任务照样判 stalled', async () => {
      const d1 = await createSchemaDb();
      await insertTask(d1, { nextSendAt: new Date(Date.now() - 40 * 60_000).toISOString() });
      const data = await debug(d1);
      expect(data.tick).toBe('stalled');
      expect(data.storage.stuckTasks).toBe(1);
    });
  });
});
