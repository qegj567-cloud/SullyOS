import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  AUTO_UPDATE_CLIENT_INTERVAL_MS,
  AUTO_UPDATE_CRON_INTERVAL_MS,
  applySelfUpdateResult,
  ensureSchemaOnce,
  readSelfUpdateState,
  recordManualSelfUpdate,
  runAutoUpdate,
  runScheduledAfterUpdate,
} from './autoUpdate';
import type { TickReportDb } from './tickReport';

// node:sqlite 在 Node 22.5+ 才有；没有就整组跳过（跟 tickReport.test 同一套做法）。
const sqlite = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite');
  } catch {
    return null;
  }
})();

/** node:sqlite 包成 D1 的样子：prepare → bind → first / all / run。 */
const createD1 = () => {
  const db = new sqlite!.DatabaseSync(':memory:');
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => {
      const row = db.prepare(sql).get(...params);
      return row ? { ...row } : null;
    },
    all: async () => ({ results: db.prepare(sql).all(...params).map((row: object) => ({ ...row })) }),
    run: async () => {
      db.prepare(sql).run(...params);
      return { success: true };
    },
  });
  return { prepare: (sql: string) => statement(sql), raw: db } as unknown as TickReportDb & { raw: any };
};

const NOW = Date.parse('2026-09-25T08:00:00.000Z');
const HOUR = 60 * 60_000;

describe('定时任务的更新检查顺序', () => {
  it('即使后续数据库维护失败，也已经尝试检查修复包', async () => {
    let checked = false;
    await expect(runScheduledAfterUpdate(async () => { checked = true; }, async () => {
      expect(checked).toBe(true);
      throw new Error('D1 daily read limit exceeded');
    })).rejects.toThrow('D1 daily read limit exceeded');
    expect(checked).toBe(true);
  });

  it('更新服务暂时失败时仍执行正常投递', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runScheduledAfterUpdate(async () => { throw new Error('update unavailable'); }, async () => 'delivered');
      expect(result).toBe('delivered');
    } finally { warning.mockRestore(); }
  });
});

/** 一份看起来像成品包的假代码；改一个字指纹就变。 */
const bundleWith = (marker: string) => `// src_default as default ${marker}\n${'x'.repeat(200 * 1024)}`;

const FULL_ENV = {
  AMSG_SERVER_TOKEN: 'shared',
  CF_API_TOKEN: 'cf-token',
  CF_SCRIPT_NAME: 'sullyos-amsg',
  CF_ACCOUNT_ID: 'acc-1',
  AMSG_MASTER_KEY: 'mk',
  INSTANT_TICK: {},
};

/**
 * 把 GitHub 和 Cloudflare 两头都桩掉，记下每一发。
 * `bundle` 是 raw.githubusercontent 会回的正文；`uploadOk` 控制 PUT 成不成。
 */
const stubNetwork = (bundle: string, options: { uploadOk?: boolean; bundleStatus?: number } = {}) => {
  const calls: Array<{ method: string; url: string }> = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ method, url });
    if (url.includes('raw.githubusercontent.com')) {
      return new Response(bundle, { status: options.bundleStatus ?? 200 });
    }
    if (method === 'GET' && url.endsWith('/settings')) {
      return Response.json({
        success: true,
        result: {
          bindings: [
            { type: 'secret_text', name: 'AMSG_MASTER_KEY' },
            { type: 'durable_object_namespace', name: 'INSTANT_TICK', class_name: 'InstantTickDO' },
          ],
          compatibility_date: '2026-01-01',
        },
      });
    }
    if (method === 'PUT') {
      return options.uploadOk === false
        ? Response.json({ success: false, errors: [{ code: 10000, message: 'boom' }] }, { status: 400 })
        : Response.json({ success: true, result: {} });
    }
    return Response.json({ success: true, result: {} });
  }) as typeof fetch;
  return calls;
};

const pulledBundle = (calls: Array<{ url: string }>) => calls.filter((c) => c.url.includes('raw.githubusercontent.com')).length;
const uploaded = (calls: Array<{ method: string }>) => calls.filter((c) => c.method === 'PUT').length;

describe.skipIf(!sqlite)('runAutoUpdate', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('没配 CF_API_TOKEN → 没有自更新能力，什么都不写、一个请求都不发', async () => {
    const db = createD1();
    const calls = stubNetwork(bundleWith('a'));
    const run = await runAutoUpdate({ ...FULL_ENV, CF_API_TOKEN: undefined }, db, { source: 'cron', scriptName: 'w', nowMs: NOW });
    expect(run.action).toBe('unsupported');
    expect(calls).toHaveLength(0);
    expect(await readSelfUpdateState(db)).toBeNull();
  });

  it('从没查过 → 拉包、上传、把指纹和时刻记下来', async () => {
    const db = createD1();
    const calls = stubNetwork(bundleWith('a'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = await runAutoUpdate(FULL_ENV, db, { source: 'cron', scriptName: 'sullyos-amsg', nowMs: NOW });
    expect(run.action).toBe('updated');
    expect(uploaded(calls)).toBe(1);
    const state = await readSelfUpdateState(db);
    expect(state?.lastOutcome).toBe('updated');
    expect(state?.lastSource).toBe('cron');
    expect(state?.bundleHash).toMatch(/^[0-9a-f]{12}$/);
    expect(state?.lastUpdatedAt).toBe(new Date(NOW).toISOString());
    expect(state?.lastCheckAt).toBe(new Date(NOW).toISOString());
    expect(state?.lastError).toBeNull();
  });

  it('远端跟上次装的是同一份、绑定也都在 → 只拉包比一下，不上传', async () => {
    const db = createD1();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stubNetwork(bundleWith('a'));
    await runAutoUpdate(FULL_ENV, db, { source: 'cron', scriptName: 'sullyos-amsg', nowMs: NOW });

    const calls = stubNetwork(bundleWith('a'));
    const run = await runAutoUpdate(FULL_ENV, db, { source: 'cron', scriptName: 'sullyos-amsg', nowMs: NOW + AUTO_UPDATE_CRON_INTERVAL_MS });
    expect(run.action).toBe('up_to_date');
    expect(pulledBundle(calls)).toBe(1);
    expect(uploaded(calls)).toBe(0);
    const state = await readSelfUpdateState(db);
    expect(state?.lastOutcome).toBe('up_to_date');
    // 上次真的换代码的时刻不被「没变」那一次盖掉
    expect(state?.lastUpdatedAt).toBe(new Date(NOW).toISOString());
  });

  it('远端换了新内容 → 再上传一次；比的是内容指纹，跟版本号无关', async () => {
    const db = createD1();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stubNetwork(bundleWith('a'));
    await runAutoUpdate(FULL_ENV, db, { source: 'cron', scriptName: 'sullyos-amsg', nowMs: NOW });
    const firstHash = (await readSelfUpdateState(db))?.bundleHash;

    const calls = stubNetwork(bundleWith('b'));
    const run = await runAutoUpdate(FULL_ENV, db, { source: 'cron', scriptName: 'sullyos-amsg', nowMs: NOW + AUTO_UPDATE_CRON_INTERVAL_MS });
    expect(run.action).toBe('updated');
    expect(uploaded(calls)).toBe(1);
    expect((await readSelfUpdateState(db))?.bundleHash).not.toBe(firstHash);
  });

  /**
   * 回归守卫：「要点两次」的老问题要在这里自然消化。
   *
   * 自更新由旧代码执行，新版本新加的绑定第一次装不上——代码新了、指纹也对上了，
   * 但运行时 env.INSTANT_TICK 是 undefined。这时不能因为「指纹没变」就跳过，
   * 得再传一次让新代码把绑定补上。
   */
  it('指纹没变但运行时缺 INSTANT_TICK 绑定 → 照样再传一次把绑定补上', async () => {
    const db = createD1();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stubNetwork(bundleWith('a'));
    await runAutoUpdate(FULL_ENV, db, { source: 'cron', scriptName: 'sullyos-amsg', nowMs: NOW });

    const calls = stubNetwork(bundleWith('a'));
    const run = await runAutoUpdate({ ...FULL_ENV, INSTANT_TICK: undefined }, db, {
      source: 'cron', scriptName: 'sullyos-amsg', nowMs: NOW + AUTO_UPDATE_CRON_INTERVAL_MS,
    });
    expect(run.action).toBe('updated');
    expect(uploaded(calls)).toBe(1);
  });

  it('cron 路上离上次检查不够 6 小时 → 节流，连包都不拉', async () => {
    const db = createD1();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stubNetwork(bundleWith('a'));
    await runAutoUpdate(FULL_ENV, db, { source: 'cron', scriptName: 'sullyos-amsg', nowMs: NOW });

    const calls = stubNetwork(bundleWith('b'));
    const run = await runAutoUpdate(FULL_ENV, db, { source: 'cron', scriptName: 'sullyos-amsg', nowMs: NOW + AUTO_UPDATE_CRON_INTERVAL_MS - 1 });
    expect(run.action).toBe('throttled');
    expect(calls).toHaveLength(0);
  });

  it('冷启动那条路的门槛比 cron 低：过了 30 分钟就肯查，两条路共用同一个时钟', async () => {
    const db = createD1();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stubNetwork(bundleWith('a'));
    await runAutoUpdate(FULL_ENV, db, { source: 'cron', scriptName: 'sullyos-amsg', nowMs: NOW });

    expect(AUTO_UPDATE_CLIENT_INTERVAL_MS).toBeLessThan(AUTO_UPDATE_CRON_INTERVAL_MS);
    const tooSoon = await runAutoUpdate(FULL_ENV, db, { source: 'client', scriptName: 'sullyos-amsg', nowMs: NOW + AUTO_UPDATE_CLIENT_INTERVAL_MS - 1 });
    expect(tooSoon.action).toBe('throttled');

    const calls = stubNetwork(bundleWith('b'));
    const run = await runAutoUpdate(FULL_ENV, db, { source: 'client', scriptName: 'sullyos-amsg', nowMs: NOW + AUTO_UPDATE_CLIENT_INTERVAL_MS });
    expect(run.action).toBe('updated');
    expect(run.action === 'updated' && run.state.lastSource).toBe('client');
    expect(uploaded(calls)).toBe(1);
    // 冷启动那次查过之后，cron 的时钟也从这一刻起算
    const cronRun = await runAutoUpdate(FULL_ENV, db, { source: 'cron', scriptName: 'sullyos-amsg', nowMs: NOW + AUTO_UPDATE_CLIENT_INTERVAL_MS + HOUR });
    expect(cronRun.action).toBe('throttled');
  });

  it('上传失败 → 记下代号和整句，指纹保留上一次成功的那份，下一轮到点再试', async () => {
    const db = createD1();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubNetwork(bundleWith('a'));
    await runAutoUpdate(FULL_ENV, db, { source: 'cron', scriptName: 'sullyos-amsg', nowMs: NOW });
    const goodHash = (await readSelfUpdateState(db))?.bundleHash;

    stubNetwork(bundleWith('b'), { uploadOk: false });
    const run = await runAutoUpdate(FULL_ENV, db, { source: 'cron', scriptName: 'sullyos-amsg', nowMs: NOW + AUTO_UPDATE_CRON_INTERVAL_MS });
    expect(run.action).toBe('failed');
    const state = await readSelfUpdateState(db);
    expect(state?.lastOutcome).toBe('failed');
    expect(state?.lastError?.code).toBe('UPLOAD_FAILED');
    expect(state?.lastError?.message).toContain('boom');
    expect(state?.bundleHash).toBe(goodHash);
    expect(state?.lastUpdatedAt).toBe(new Date(NOW).toISOString());

    // 失败也算查过：到下一个周期之前不再去撞
    const again = await runAutoUpdate(FULL_ENV, db, { source: 'cron', scriptName: 'sullyos-amsg', nowMs: NOW + AUTO_UPDATE_CRON_INTERVAL_MS + HOUR });
    expect(again.action).toBe('throttled');
  });

  it('取包失败（GitHub 回错误页）→ 记 BUNDLE_INVALID，不上传', async () => {
    const db = createD1();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = stubNetwork('<html>404</html>', { bundleStatus: 404 });
    const run = await runAutoUpdate(FULL_ENV, db, { source: 'cron', scriptName: 'sullyos-amsg', nowMs: NOW });
    expect(run.action).toBe('failed');
    expect(run.action === 'failed' && run.state.lastError?.code).toBe('BUNDLE_INVALID');
    expect(uploaded(calls)).toBe(0);
  });

  it('cron 路上认不出脚本名（没配 CF_SCRIPT_NAME）→ 记成失败让设置页看见，不去拉包', async () => {
    const db = createD1();
    const calls = stubNetwork(bundleWith('a'));
    const run = await runAutoUpdate(FULL_ENV, db, { source: 'cron', scriptName: null, nowMs: NOW });
    expect(run.action).toBe('failed');
    expect(run.action === 'failed' && run.state.lastError?.code).toBe('SCRIPT_NAME_UNKNOWN');
    expect(calls).toHaveLength(0);
  });

  /**
   * 回归守卫：先占坑再动手。cron 两跳可能重叠、冷启动的请求也可能跟 cron 撞上，
   * 「查过了」这一笔要在拉包之前就落库，第二个来者才会被节流挡住。
   */
  it('拉包之前就把 lastCheckAt 写进库，同时来的第二个会被挡住', async () => {
    const db = createD1();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let releaseBundle!: () => void;
    const bundleGate = new Promise<void>((resolve) => { releaseBundle = resolve; });
    const calls: string[] = [];
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      calls.push(init.method ?? 'GET');
      if (url.includes('raw.githubusercontent.com')) {
        await bundleGate;
        return new Response(bundleWith('a'));
      }
      if (url.endsWith('/settings')) {
        return Response.json({ success: true, result: { bindings: [{ type: 'secret_text', name: 'AMSG_MASTER_KEY' }] } });
      }
      return Response.json({ success: true, result: {} });
    }) as typeof fetch;

    const first = runAutoUpdate(FULL_ENV, db, { source: 'cron', scriptName: 'sullyos-amsg', nowMs: NOW });
    // 让第一个跑到「正在拉包」那一步
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await readSelfUpdateState(db))?.lastCheckAt).toBe(new Date(NOW).toISOString());

    const second = await runAutoUpdate(FULL_ENV, db, { source: 'client', scriptName: 'sullyos-amsg', nowMs: NOW + 1000 });
    expect(second.action).toBe('throttled');

    releaseBundle();
    expect((await first).action).toBe('updated');
    expect(calls.filter((m) => m === 'PUT')).toHaveLength(1);
  });
});

describe.skipIf(!sqlite)('recordManualSelfUpdate', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('手动更新装上的指纹成为之后自动检查的基准：同一份包不会再传一遍', async () => {
    const db = createD1();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // 手动那次装的正是远端现在这份
    const calls0 = stubNetwork(bundleWith('a'));
    const { fetchLatestBundle } = await import('./selfUpdate');
    const fetched = await fetchLatestBundle();
    expect(fetched.ok).toBe(true);
    const hash = fetched.ok ? fetched.bundle.hash : '';
    expect(calls0).toHaveLength(1);

    await recordManualSelfUpdate(db, { ok: true, code: 'UPDATED', message: '', bundleHash: hash }, NOW);
    const state = await readSelfUpdateState(db);
    expect(state?.lastSource).toBe('manual');
    expect(state?.bundleHash).toBe(hash);

    const calls = stubNetwork(bundleWith('a'));
    const run = await runAutoUpdate(FULL_ENV, db, { source: 'cron', scriptName: 'sullyos-amsg', nowMs: NOW + AUTO_UPDATE_CRON_INTERVAL_MS });
    expect(run.action).toBe('up_to_date');
    expect(uploaded(calls)).toBe(0);
  });

  it('手动更新失败也记下来，但不动上一次成功的指纹', () => {
    const previous = applySelfUpdateResult(null, 'manual', { ok: true, code: 'UPDATED', message: '', bundleHash: 'abc' }, NOW);
    const next = applySelfUpdateResult(previous, 'manual', { ok: false, code: 'UPLOAD_FAILED', message: '上传失败' }, NOW + HOUR);
    expect(next.lastOutcome).toBe('failed');
    expect(next.bundleHash).toBe('abc');
    expect(next.lastUpdatedAt).toBe(previous.lastUpdatedAt);
    expect(next.lastError).toEqual({ code: 'UPLOAD_FAILED', message: '上传失败' });
  });

  it('没绑 D1 时静默跳过，不抛', async () => {
    await expect(recordManualSelfUpdate(undefined, { ok: true, code: 'UPDATED', message: '' })).resolves.toBeUndefined();
  });
});

describe.skipIf(!sqlite)('ensureSchemaOnce', () => {
  afterEach(() => vi.restoreAllMocks());

  it('每个表结构版本只真查一次；换过代码（自更新）之后再查一次', async () => {
    const db = createD1();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ensure = vi.fn(async () => ({ ok: true, migrated: true, missing: [] as string[] }));

    expect(await ensureSchemaOnce(db, '2.6.0', ensure, NOW)).toBe('ok');
    expect(await ensureSchemaOnce(db, '2.6.0', ensure, NOW + 60_000)).toBe('skipped');
    expect(ensure).toHaveBeenCalledTimes(1);

    // 上游抬了表结构版本 → 再查
    expect(await ensureSchemaOnce(db, '2.7.0', ensure, NOW + 120_000)).toBe('ok');
    expect(ensure).toHaveBeenCalledTimes(2);

    // 自更新换了代码（不管版本号变没变）→ 下一跳再查一次
    await recordManualSelfUpdate(db, { ok: true, code: 'UPDATED', message: '', bundleHash: 'abc' }, NOW + 180_000);
    expect(await ensureSchemaOnce(db, '2.7.0', ensure, NOW + 240_000)).toBe('ok');
    expect(ensure).toHaveBeenCalledTimes(3);
  });

  it('查挂了 → 退避一小时再试，别每分钟都去数表', async () => {
    const db = createD1();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ensure = vi.fn(async () => { throw new Error('SQLITE_AUTH'); });

    expect(await ensureSchemaOnce(db, '2.6.0', ensure, NOW)).toBe('failed');
    expect(await ensureSchemaOnce(db, '2.6.0', ensure, NOW + 60_000)).toBe('skipped');
    expect(await ensureSchemaOnce(db, '2.6.0', ensure, NOW + HOUR)).toBe('failed');
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it('补完仍然缺东西（ALTER 被拒）也算失败，同样退避', async () => {
    const db = createD1();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ensure = vi.fn(async () => ({ ok: false, migrated: true, missing: ['column:scheduled_messages.x'] }));
    expect(await ensureSchemaOnce(db, '2.6.0', ensure, NOW)).toBe('failed');
    expect(await ensureSchemaOnce(db, '2.6.0', ensure, NOW + 60_000)).toBe('skipped');
  });

  it('没绑 D1 就跳过', async () => {
    const ensure = vi.fn(async () => ({ ok: true, migrated: false, missing: [] as string[] }));
    expect(await ensureSchemaOnce(undefined, '2.6.0', ensure, NOW)).toBe('skipped');
    expect(ensure).not.toHaveBeenCalled();
  });
});
