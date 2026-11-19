/**
 * 救援模式：本地数据被清空、又没有备份时，凭一枚只有账号主人知道的口令，把这台 Worker
 * 存在 D1 里的全部云端数据解密导出成 JSON。
 *
 * 为什么只能做在这台 Worker 里：云端数据用 AMSG_MASTER_KEY 派生的钥匙加密，而 Master Key
 * 的唯一一份副本就在这台 Worker 的 Secret 里——Cloudflare 不让读回来，用户本地那份也随着
 * 数据一起清掉了。所以救援代码必须跑在同一个 Worker 脚本上，才拿得到它。
 *
 * 开关：Secret `AMSG_RESCUE_TOKEN`（≥ AMSG_RESCUE_TOKEN_MIN_LENGTH 个字符）。没设就是关，
 * 所有 /rescue 路由回 404，这份代码在正常使用中什么都不做。
 *
 * 安全上的几条底线（完整考量见 docs/amsg2-rescue.md）：
 *   1. 证明「是账号主人」靠的是能设 Worker Secret 的 Cloudflare 账号权限，口令是第二道锁。
 *      口令只从请求头读，不进网址；比对用常数时间；错得太多就锁一会儿。
 *   2. 只读。救援路由不改、不删任何业务数据，只往诊断表里写留痕。
 *   3. 留痕：首次看到开关时开一段新的记录、立刻推送给用户的所有设备；之后每次导出、
 *      每次读数据、每次口令错误都记账；`GET /config-check` 把这些报给前端，前端强制弹窗
 *      警告 7 天。推送一旦送达就收不回来，这是唯一在 Cloudflare 账号之外的留痕。
 *   4. 这层留痕只防「会登录面板、不会写代码」的人。有脚本编辑权限的人可以直接部署自己的
 *      代码读 Master Key，根本不经过这里——这一点在文档里照实写明，别把它当成防泄露机制。
 *   5. 开着救援模式时 cron 不投递、不清理（见 index.ts 的 scheduled），导出的就是开启那一刻
 *      的样子，不会边导边被过期清理掉。
 */

import { decryptFromStorage, deriveUserEncryptionKey } from '@rei-standard/amsg-server/cloudflare';
import { unpackStateValue } from '../../../utils/amsgFirePack';
import {
  AMSG_RESCUE_RESULT_KIND,
  AMSG_RESCUE_TOKEN_MIN_LENGTH,
  parseAmsgRescueEpisode,
  type AmsgRescueEpisode,
  type AmsgRescueReport,
} from '../../../utils/amsgRescueState';
import { constantTimeEqual } from './instantChat';
import { DIAGNOSTICS_TABLE_SQL, readDiagnosticValue, type TickReportDb } from './tickReport';

export interface RescueEnv {
  AMSG_RESCUE_TOKEN?: string;
  AMSG_MASTER_KEY?: string;
  DB?: unknown;
}

export interface RescueDeps {
  /** 把一条通知推给一份已解密的订阅（index.ts 注入 buildWorkerConfig 的推送通道）。 */
  sendPush: (subscription: unknown, payload: string) => Promise<unknown>;
  /** 测试用：替换「现在」。 */
  now?: () => number;
}

/** 诊断表里存留痕的键。 */
export const RESCUE_EPISODE_KEY = 'rescue_episode';
/** 诊断表里存最近口令错误时刻的键（锁定判断用）。 */
export const RESCUE_FAILURES_KEY = 'rescue_failures';

/** 「最近看到开关还在」最多这么久写一次库：开着的时候每个请求都会路过，没必要次次写。 */
const SEEN_WRITE_INTERVAL_MS = 60_000;
/** 窗口内口令错这么多次就锁住。 */
export const RESCUE_LOCKOUT_FAILURES = 10;
export const RESCUE_LOCKOUT_WINDOW_MS = 15 * 60_000;
/** 单条推送最多等这么久，推不出去也不能把救援挡住（数据被清空的那台设备本来就收不到）。 */
const PUSH_TIMEOUT_MS = 8_000;
/** 小表按页导出，一页这么多行。 */
const TABLE_PAGE_ROWS = 100;

/** D1 里大值分块的格式（上游 amsg-server lib/state-chunks.js，未导出，这里照抄并由测试钉住）。 */
const SEP = '\u001f';
const CHUNK_NS_PREFIX = `${SEP}amsg-chunks${SEP}`;
const ROOT_MARKER_PREFIX = `${SEP}amsg-chunked${SEP}v1${SEP}`;

/**
 * 除 client_state 之外要导出的表，以及各自哪几列是加密的。只认这张白名单里的表名，
 * 表名不会来自请求。lease_token 这类运行时锁不是用户数据，不导出。
 */
const EXPORT_TABLES: Record<string, { encrypted: string[]; drop?: string[] }> = {
  scheduled_messages: { encrypted: ['encrypted_payload'], drop: ['lease_token'] },
  llm_credentials: { encrypted: ['encrypted_value'] },
  message_outbox: { encrypted: ['payload'] },
  push_subscriptions: { encrypted: ['subscription'] },
  cloud_resource_metadata: { encrypted: ['encrypted_value'] },
};

// ─── 开关 ─────────────────────────────────────────────────────────────

export type RescueTokenState =
  | { state: 'off' }
  | { state: 'too-short'; length: number }
  | { state: 'on'; token: string };

export const readRescueToken = (env: RescueEnv): RescueTokenState => {
  const token = env.AMSG_RESCUE_TOKEN?.trim() ?? '';
  if (!token) return { state: 'off' };
  if (token.length < AMSG_RESCUE_TOKEN_MIN_LENGTH) return { state: 'too-short', length: token.length };
  return { state: 'on', token };
};

/** 救援模式是否真的开着（口令够长才算；太短的口令救援页拒绝工作）。 */
export const isRescueActive = (env: RescueEnv): boolean => readRescueToken(env).state === 'on';

const dbOf = (env: RescueEnv): TickReportDb | null => {
  const db = env.DB as TickReportDb | undefined;
  return typeof db?.prepare === 'function' ? db : null;
};

/** D1 的 run() 回执里读「改了几行」；自定义适配器不给就当改成了。 */
const changesOf = (result: unknown): number => {
  const changes = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
  return typeof changes === 'number' ? changes : 1;
};

// ─── 留痕 ─────────────────────────────────────────────────────────────

export const readRescueEpisode = async (db: TickReportDb | null): Promise<AmsgRescueEpisode | null> => {
  if (!db) return null;
  const raw = await readDiagnosticValue(db, RESCUE_EPISODE_KEY);
  if (!raw) return null;
  try {
    return parseAmsgRescueEpisode(JSON.parse(raw));
  } catch {
    return null;
  }
};

const freshEpisode = (nowMs: number): AmsgRescueEpisode => ({
  id: String(nowMs),
  firstSeenAt: nowMs,
  lastSeenAt: nowMs,
  endedAt: null,
  exportCount: 0,
  lastExportAt: null,
  itemReads: 0,
  lastReadAt: null,
  failedAttempts: 0,
  pushedAt: null,
  pushTargets: 0,
  pushDelivered: 0,
});

/**
 * 开一段新留痕。只在「没有记录 / 上一段已结束 / 记录坏了」时写得进去：两个请求同时
 * 发现开关时只有一个赢，只有赢的那个去推送，用户不会收到两条。
 */
const startEpisode = async (db: TickReportDb, episode: AmsgRescueEpisode, nowMs: number): Promise<boolean> => {
  await db.prepare(DIAGNOSTICS_TABLE_SQL).run();
  const result = await db
    .prepare(
      `INSERT INTO worker_diagnostics (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE json_valid(worker_diagnostics.value) = 0
          OR json_extract(worker_diagnostics.value, '$.endedAt') IS NOT NULL`,
    )
    .bind(RESCUE_EPISODE_KEY, JSON.stringify(episode), nowMs)
    .run();
  return changesOf(result) > 0;
};

/**
 * 在当前这段留痕上原子地改几个字段（json_set 在库里改，不是读出来改完再写回去，
 * 并发的两次导出不会互相吞掉计数）。`increments` 里的字段在原值上加一。
 */
const patchEpisode = async (
  db: TickReportDb,
  nowMs: number,
  patch: { set?: Record<string, number>; increments?: string[]; onlyIfOpen?: boolean },
): Promise<void> => {
  const parts: string[] = [];
  const values: unknown[] = [];
  for (const field of patch.increments ?? []) {
    parts.push(`'$.${field}', COALESCE(json_extract(value, '$.${field}'), 0) + 1`);
  }
  for (const [field, value] of Object.entries(patch.set ?? {})) {
    parts.push(`'$.${field}', ?`);
    values.push(value);
  }
  if (!parts.length) return;
  await db
    .prepare(
      `UPDATE worker_diagnostics SET value = json_set(value, ${parts.join(', ')}), updated_at = ?
       WHERE key = ? AND json_valid(value) = 1${patch.onlyIfOpen ? " AND json_extract(value, '$.endedAt') IS NULL" : ''}`,
    )
    .bind(...values, nowMs, RESCUE_EPISODE_KEY)
    .run();
};

/**
 * 看一眼开关，把留痕推进到跟现实一致，返回最新的那段。
 *
 *   - 开着、没有进行中的记录 → 开一段新的，并推送给所有设备（推送跑完才返回，
 *     所以第一次导出一定排在推送之后）；
 *   - 开着、已有进行中的记录 → 刷新「最近看到」（限频）；
 *   - 关着、还有进行中的记录 → 记下结束时刻，下次再开就是新的一段。
 *
 * 调用点：每个请求（开着时）、config-check、每分钟的 cron。读写失败不抛，留痕是附带的，
 * 不该把正常功能拖挂——但救援路由自己会在留痕写不进去时拒绝导出（见 handleRescueRequest）。
 */
export const observeRescue = async (env: RescueEnv, deps: RescueDeps): Promise<AmsgRescueEpisode | null> => {
  const db = dbOf(env);
  if (!db) return null;
  const nowMs = deps.now?.() ?? Date.now();
  const active = isRescueActive(env);
  const current = await readRescueEpisode(db);

  if (active) {
    if (!current || current.endedAt !== null) {
      const episode = freshEpisode(nowMs);
      if (await startEpisode(db, episode, nowMs)) {
        await pushRescueAlert(db, env, deps, episode, nowMs);
      }
      return readRescueEpisode(db);
    }
    if (nowMs - current.lastSeenAt >= SEEN_WRITE_INTERVAL_MS) {
      await patchEpisode(db, nowMs, { set: { lastSeenAt: nowMs }, onlyIfOpen: true });
      return { ...current, lastSeenAt: nowMs };
    }
    return current;
  }

  if (current && current.endedAt === null) {
    await patchEpisode(db, nowMs, { set: { endedAt: nowMs }, onlyIfOpen: true });
    return { ...current, endedAt: nowMs };
  }
  return current;
};

/** observeRescue 的不抛版本，给 config-check / cron / 普通请求用。 */
export const observeRescueQuietly = async (env: RescueEnv, deps: RescueDeps): Promise<AmsgRescueEpisode | null> => {
  try {
    return await observeRescue(env, deps);
  } catch (error) {
    console.warn('[amsg:rescue] 留痕没记上', error);
    return null;
  }
};

/** `GET /config-check` 的 rescue 段。 */
export const buildRescueReport = async (env: RescueEnv, deps: RescueDeps): Promise<AmsgRescueReport> => ({
  active: isRescueActive(env),
  episode: await observeRescueQuietly(env, deps),
});

// ─── 开启时的推送 ─────────────────────────────────────────────────────

export const RESCUE_ALERT_TITLE = 'SullyOS 安全提醒：救援模式已开启';
export const RESCUE_ALERT_BODY =
  '你的主动消息 Worker 刚开启了救援模式，可以导出全部云端数据（含 API Key）。'
  + '若非本人操作，请立刻更换重要凭据，并检查 Cloudflare 账号安全。';

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超过 ${ms}ms 没推出去`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });

/** 读出一份订阅：正常是密文，个别老数据是明文 JSON。 */
const decodeSubscription = async (stored: string, userKey: string): Promise<unknown> => {
  try {
    return JSON.parse(await decryptFromStorage(stored, userKey));
  } catch {
    return JSON.parse(stored);
  }
};

const pushRescueAlert = async (
  db: TickReportDb,
  env: RescueEnv,
  deps: RescueDeps,
  episode: AmsgRescueEpisode,
  nowMs: number,
): Promise<void> => {
  let targets = 0;
  let delivered = 0;
  try {
    const masterKey = env.AMSG_MASTER_KEY?.trim();
    const { results } = await db
      .prepare('SELECT user_id, subscription FROM push_subscriptions')
      .all<{ user_id: string; subscription: string }>();
    const rows = (results ?? []).filter((row) => typeof row.subscription === 'string' && row.subscription);
    targets = rows.length;
    const payload = JSON.stringify({
      messageKind: 'result',
      resultKind: AMSG_RESCUE_RESULT_KIND,
      messageId: `rescue_${episode.id}`,
      timestamp: new Date(nowMs).toISOString(),
      contactName: 'SullyOS 安全提醒',
      message: RESCUE_ALERT_BODY,
      notification: {
        title: RESCUE_ALERT_TITLE,
        body: RESCUE_ALERT_BODY,
        show: 'always',
        tag: 'sullyos-rescue-alert',
        renotify: true,
      },
    });
    const outcomes = await Promise.allSettled(rows.map(async (row) => {
      if (!masterKey) throw new Error('缺 AMSG_MASTER_KEY');
      const userKey = await deriveUserEncryptionKey(row.user_id, masterKey);
      const subscription = await decodeSubscription(row.subscription, userKey);
      await withTimeout(Promise.resolve(deps.sendPush(subscription, payload)), PUSH_TIMEOUT_MS);
    }));
    delivered = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') console.warn('[amsg:rescue] 开启通知有一条没推出去', outcome.reason);
    }
  } catch (error) {
    // 表不在（从没登记过推送）也走这里：推不出去照实记 0，不挡救援。
    console.warn('[amsg:rescue] 开启通知没推出去', error);
  }
  await patchEpisode(db, nowMs, { set: { pushedAt: nowMs, pushTargets: targets, pushDelivered: delivered } });
};

// ─── 口令 ─────────────────────────────────────────────────────────────

const readFailures = async (db: TickReportDb): Promise<number[]> => {
  const raw = await readDiagnosticValue(db, RESCUE_FAILURES_KEY);
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((at): at is number => typeof at === 'number') : [];
  } catch {
    return [];
  }
};

const writeFailures = async (db: TickReportDb, failures: number[], nowMs: number): Promise<void> => {
  await db.prepare(DIAGNOSTICS_TABLE_SQL).run();
  await db
    .prepare(
      `INSERT INTO worker_diagnostics (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(RESCUE_FAILURES_KEY, JSON.stringify(failures), nowMs)
    .run();
};

/** 窗口内错满次数时，返回还要锁多久（毫秒）；没锁返回 0。纯函数，方便钉住。 */
export const rescueLockoutRemainingMs = (failures: number[], nowMs: number): number => {
  const recent = failures.filter((at) => nowMs - at < RESCUE_LOCKOUT_WINDOW_MS).sort((a, b) => a - b);
  if (recent.length < RESCUE_LOCKOUT_FAILURES) return 0;
  const unlockAt = recent[recent.length - RESCUE_LOCKOUT_FAILURES] + RESCUE_LOCKOUT_WINDOW_MS;
  return Math.max(0, unlockAt - nowMs);
};

type GateResult = { ok: true } | { ok: false; status: number; code: string; message: string };

const checkRescueToken = async (
  request: Request,
  db: TickReportDb,
  token: string,
  nowMs: number,
): Promise<GateResult> => {
  const failures = await readFailures(db);
  const lockedMs = rescueLockoutRemainingMs(failures, nowMs);
  if (lockedMs > 0) {
    return {
      ok: false,
      status: 429,
      code: 'RESCUE_LOCKED',
      message: `口令错误次数太多，已锁定。请 ${Math.ceil(lockedMs / 60_000)} 分钟后再试。`,
    };
  }
  const provided = request.headers.get('X-Rescue-Token')?.trim() ?? '';
  if (provided && await constantTimeEqual(provided, token)) {
    if (failures.length) await writeFailures(db, [], nowMs);
    return { ok: true };
  }
  const recent = [...failures.filter((at) => nowMs - at < RESCUE_LOCKOUT_WINDOW_MS), nowMs].slice(-RESCUE_LOCKOUT_FAILURES);
  await writeFailures(db, recent, nowMs);
  await patchEpisode(db, nowMs, { increments: ['failedAttempts'] });
  return { ok: false, status: 401, code: 'RESCUE_TOKEN_INVALID', message: '救援口令不对。' };
};

// ─── 解密导出 ─────────────────────────────────────────────────────────

const base64UrlEncode = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const base64UrlDecode = (value: string): string => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

const listTables = async (db: TickReportDb): Promise<Set<string>> => {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  return new Set((results ?? []).map((row) => row.name));
};

/** 每个用户一把钥匙，同一请求里算过就不再算。 */
const userKeyCache = (masterKey: string) => {
  const cache = new Map<string, Promise<string>>();
  return (userId: string) => {
    let key = cache.get(userId);
    if (!key) {
      key = deriveUserEncryptionKey(userId, masterKey);
      cache.set(userId, key);
    }
    return key;
  };
};

const STORAGE_CIPHERTEXT_RE = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]*$/i;

/** 明文还原：先解 SullyOS 自己的 gzip 包装，再试 JSON；都不是就原样当文本。 */
const decodePlaintext = async (text: string): Promise<{ value: unknown; format: 'json' | 'text' }> => {
  let unpacked = text;
  try {
    unpacked = await unpackStateValue(text);
  } catch {
    unpacked = text;
  }
  let value: unknown;
  try {
    value = JSON.parse(unpacked);
  } catch {
    return { value: unpacked, format: 'text' };
  }
  await unpackNestedFirePacks(value);
  return { value, format: 'json' };
};

/**
 * 即时对话那一轮的快照（`amsg:instant-input` 的值、自排任务的 taskInput）里，fire_pack 又单独
 * 压了一层 `packedFirePack`。不解开的话，导出文件里最完整的那份角色设定和对话就是一串乱码。
 */
const unpackNestedFirePacks = async (value: unknown): Promise<void> => {
  const holders = [value, (value as { taskInput?: unknown } | null)?.taskInput];
  for (const holder of holders) {
    if (!holder || typeof holder !== 'object') continue;
    const record = holder as { packedFirePack?: unknown };
    if (typeof record.packedFirePack !== 'string') continue;
    try {
      record.packedFirePack = JSON.parse(await unpackStateValue(record.packedFirePack));
    } catch {
      // 解不开就保留原串，导出不能因为一格坏数据中断。
    }
  }
};

type DecodedCell =
  | { status: 'decrypted' | 'plain'; format: 'json' | 'text'; value: unknown }
  | { status: 'undecryptable' };

/** 解一格：是密文就解，解不开照实标出来；不像密文的当明文（个别老数据就是明文存的）。 */
const decodeCell = async (raw: unknown, userKey: string): Promise<DecodedCell> => {
  if (typeof raw !== 'string') return { status: 'plain', format: 'json', value: raw ?? null };
  if (STORAGE_CIPHERTEXT_RE.test(raw)) {
    try {
      return { status: 'decrypted', ...(await decodePlaintext(await decryptFromStorage(raw, userKey))) };
    } catch {
      return { status: 'undecryptable' };
    }
  }
  return { status: 'plain', ...(await decodePlaintext(raw)) };
};

export interface RescueManifestItem {
  id: string;
  source: string;
  userId?: string;
  namespace?: string;
  key?: string;
  updatedAt?: number | null;
  /** 库里这一格的字符数（分块存的大值只计根行，标 chunked）。 */
  bytes?: number | null;
  chunked?: boolean;
  /** 表分页：这一页从第几行开始、最多几行。 */
  offset?: number;
  rows?: number;
}

export interface RescueManifest {
  format: 'sullyos-amsg-rescue';
  version: 1;
  generatedAt: string;
  items: RescueManifestItem[];
}

/** 导出清单：client_state 每条一项，其余小表按页一项。只列位置和大小，不含内容。 */
export const buildRescueManifest = async (db: TickReportDb, nowMs: number): Promise<RescueManifest> => {
  const tables = await listTables(db);
  const items: RescueManifestItem[] = [];

  if (tables.has('client_state')) {
    const { results } = await db
      .prepare(
        `SELECT user_id, namespace, key, updated_at, length(value) AS bytes, substr(value, 1, ?) = ? AS chunked
         FROM client_state WHERE substr(namespace, 1, 1) <> ?
         ORDER BY user_id, namespace, key`,
      )
      .bind(ROOT_MARKER_PREFIX.length, ROOT_MARKER_PREFIX, SEP)
      .all<{ user_id: string; namespace: string; key: string; updated_at: number; bytes: number; chunked: number }>();
    for (const row of results ?? []) {
      items.push({
        id: `cs:${base64UrlEncode(JSON.stringify([row.user_id, row.namespace, row.key]))}`,
        source: 'client_state',
        userId: row.user_id,
        namespace: row.namespace,
        key: row.key,
        updatedAt: typeof row.updated_at === 'number' ? row.updated_at : null,
        bytes: typeof row.bytes === 'number' ? row.bytes : null,
        chunked: Boolean(row.chunked),
      });
    }
  }

  for (const table of Object.keys(EXPORT_TABLES)) {
    if (!tables.has(table)) continue;
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<{ n: number }>();
    const total = Number(row?.n ?? 0);
    for (let offset = 0; offset < total; offset += TABLE_PAGE_ROWS) {
      items.push({
        id: `t:${table}:${offset}`,
        source: table,
        offset,
        rows: Math.min(TABLE_PAGE_ROWS, total - offset),
      });
    }
  }

  return { format: 'sullyos-amsg-rescue', version: 1, generatedAt: new Date(nowMs).toISOString(), items };
};

type ItemResult = { ok: true; data: unknown } | { ok: false; status: number; code: string; message: string };

/** 读一条 client_state：拼回分块、解密、解 gzip、认 JSON。 */
const readClientStateItem = async (
  db: TickReportDb,
  keyOf: (userId: string) => Promise<string>,
  userId: string,
  namespace: string,
  key: string,
): Promise<ItemResult> => {
  const root = await db
    .prepare('SELECT value, updated_at FROM client_state WHERE user_id = ? AND namespace = ? AND key = ?')
    .bind(userId, namespace, key)
    .first<{ value: string; updated_at: number }>();
  if (!root) return { ok: false, status: 404, code: 'RESCUE_ITEM_GONE', message: '这一条已经不在库里了。' };
  const base = { source: 'client_state', userId, namespace, key, updatedAt: root.updated_at };
  const userKey = await keyOf(userId);

  let sources: string[] = [root.value];
  if (typeof root.value === 'string' && root.value.startsWith(ROOT_MARKER_PREFIX)) {
    const count = Number(root.value.slice(ROOT_MARKER_PREFIX.length));
    const prefix = `${key}${SEP}`;
    const { results } = await db
      .prepare('SELECT key, value, updated_at FROM client_state WHERE user_id = ? AND namespace = ? AND substr(key, 1, ?) = ?')
      .bind(userId, `${CHUNK_NS_PREFIX}${namespace}`, prefix.length, prefix)
      .all<{ key: string; value: string; updated_at: number }>();
    const byKey = new Map((results ?? []).map((row) => [row.key, row]));
    sources = [];
    for (let i = 0; i < count; i += 1) {
      const chunk = byKey.get(`${prefix}${i}`);
      if (!chunk || chunk.updated_at !== root.updated_at) break;
      sources.push(chunk.value);
    }
    if (!Number.isInteger(count) || count < 1 || sources.length !== count) {
      return { ok: true, data: { ...base, status: 'chunks-incomplete', expectedChunks: count, foundChunks: sources.length } };
    }
  }

  try {
    const plain = (await Promise.all(sources.map((slice) => decryptFromStorage(slice, userKey)))).join('');
    return { ok: true, data: { ...base, status: 'decrypted', ...(await decodePlaintext(plain)) } };
  } catch {
    return { ok: true, data: { ...base, status: 'undecryptable' } };
  }
};

/** 读一页小表：明文列原样，加密列解开放进 decoded。 */
const readTablePage = async (
  db: TickReportDb,
  keyOf: (userId: string) => Promise<string>,
  table: string,
  offset: number,
): Promise<ItemResult> => {
  const spec = EXPORT_TABLES[table];
  const { results } = await db
    .prepare(`SELECT * FROM "${table}" ORDER BY rowid LIMIT ? OFFSET ?`)
    .bind(TABLE_PAGE_ROWS, offset)
    .all<Record<string, unknown>>();
  const rows = [];
  for (const row of results ?? []) {
    const userId = typeof row.user_id === 'string' ? row.user_id : '';
    const userKey = userId ? await keyOf(userId) : '';
    const plain: Record<string, unknown> = {};
    const decoded: Record<string, DecodedCell> = {};
    for (const [column, value] of Object.entries(row)) {
      if (spec.drop?.includes(column)) continue;
      if (spec.encrypted.includes(column)) decoded[column] = userKey ? await decodeCell(value, userKey) : { status: 'undecryptable' };
      else plain[column] = value;
    }
    rows.push({ ...plain, decoded });
  }
  return { ok: true, data: { source: table, offset, rows } };
};

export const readRescueItem = async (db: TickReportDb, masterKey: string, id: string): Promise<ItemResult> => {
  const keyOf = userKeyCache(masterKey);
  if (id.startsWith('cs:')) {
    let parts: unknown;
    try {
      parts = JSON.parse(base64UrlDecode(id.slice(3)));
    } catch {
      parts = null;
    }
    if (!Array.isArray(parts) || parts.length !== 3 || !parts.every((part) => typeof part === 'string')) {
      return { ok: false, status: 400, code: 'RESCUE_ITEM_INVALID', message: '条目编号不对。' };
    }
    return readClientStateItem(db, keyOf, parts[0], parts[1], parts[2]);
  }
  const match = /^t:([a-z_]+):(\d+)$/.exec(id);
  if (match && Object.prototype.hasOwnProperty.call(EXPORT_TABLES, match[1])) {
    const tables = await listTables(db);
    if (!tables.has(match[1])) return { ok: false, status: 404, code: 'RESCUE_ITEM_GONE', message: '这张表不在库里。' };
    return readTablePage(db, keyOf, match[1], Number(match[2]));
  }
  return { ok: false, status: 400, code: 'RESCUE_ITEM_INVALID', message: '条目编号不对。' };
};

// ─── 路由 ─────────────────────────────────────────────────────────────

const RESCUE_SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

/** 救援路由刻意不带 CORS 头：只给同源的救援页用，别的网站拿不到响应。 */
const rescueJson = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...RESCUE_SECURITY_HEADERS },
  });

const rescueError = (status: number, code: string, message: string) =>
  rescueJson(status, { success: false, error: { code, message } });

/** 这个路径是不是救援路由（index.ts 据此分流）。 */
export const matchRescueRoute = (pathname: string): 'page' | 'manifest' | 'item' | null => {
  if (pathname.endsWith('/rescue')) return 'page';
  if (pathname.endsWith('/rescue/manifest')) return 'manifest';
  if (pathname.endsWith('/rescue/item')) return 'item';
  return null;
};

export const handleRescueRequest = async (
  request: Request,
  env: RescueEnv,
  deps: RescueDeps,
  route: 'page' | 'manifest' | 'item',
): Promise<Response> => {
  const tokenState = readRescueToken(env);
  if (tokenState.state === 'off') {
    // 没开就当这条路不存在，不透露任何信息。
    return new Response('Not Found', { status: 404, headers: RESCUE_SECURITY_HEADERS });
  }
  if (tokenState.state === 'too-short') {
    return route === 'page'
      ? rescuePage(`AMSG_RESCUE_TOKEN 太短了（现在 ${tokenState.length} 个字符），至少要 ${AMSG_RESCUE_TOKEN_MIN_LENGTH} 个。为了防止口令被猜中，救援页不会工作。去 Cloudflare 面板把它换成一串更长的随机字符。`)
      : rescueError(403, 'RESCUE_TOKEN_TOO_SHORT', `AMSG_RESCUE_TOKEN 至少要 ${AMSG_RESCUE_TOKEN_MIN_LENGTH} 个字符。`);
  }

  const db = dbOf(env);
  const masterKey = env.AMSG_MASTER_KEY?.trim();
  if (!db || !masterKey) {
    const message = '这台 Worker 没绑 D1 数据库或没有 AMSG_MASTER_KEY，没有可以救回的数据。';
    return route === 'page' ? rescuePage(message) : rescueError(503, 'RESCUE_NOTHING_TO_EXPORT', message);
  }

  // 留痕写不进去就不放数据：宁可救不了，也不能出现「导出了却没留下记录」。
  let episode: AmsgRescueEpisode | null;
  try {
    episode = await observeRescue(env, deps);
  } catch (error) {
    console.warn('[amsg:rescue] 留痕写不进去，拒绝导出', error);
    episode = null;
  }
  if (!episode) {
    const message = '救援记录写不进数据库，为了安全暂不导出。稍后再试，或者检查 D1 是否正常。';
    return route === 'page' ? rescuePage(message) : rescueError(503, 'RESCUE_AUDIT_UNAVAILABLE', message);
  }

  if (route === 'page') {
    if (request.method.toUpperCase() !== 'GET') return rescueError(405, 'METHOD_NOT_ALLOWED', '/rescue 只接受 GET');
    return rescuePage(null);
  }
  if (request.method.toUpperCase() !== 'POST') return rescueError(405, 'METHOD_NOT_ALLOWED', '只接受 POST');

  const nowMs = deps.now?.() ?? Date.now();
  const gate = await checkRescueToken(request, db, tokenState.token, nowMs);
  if (!gate.ok) return rescueError(gate.status, gate.code, gate.message);

  if (route === 'manifest') {
    await patchEpisode(db, nowMs, { increments: ['exportCount'], set: { lastExportAt: nowMs } });
    return rescueJson(200, { success: true, data: await buildRescueManifest(db, nowMs) });
  }

  let id: unknown;
  try {
    id = ((await request.json()) as { id?: unknown } | null)?.id;
  } catch {
    id = undefined;
  }
  if (typeof id !== 'string' || !id) return rescueError(400, 'RESCUE_ITEM_INVALID', '请求体要是 { "id": "…" }');
  await patchEpisode(db, nowMs, { increments: ['itemReads'], set: { lastReadAt: nowMs } });
  const result = await readRescueItem(db, masterKey, id);
  return result.ok
    ? rescueJson(200, { success: true, data: result.data })
    : rescueError(result.status, result.code, result.message);
};

// ─── 救援页 ───────────────────────────────────────────────────────────

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);

const randomNonce = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * 救援页本身不含任何数据，数据全靠页面里的脚本带着口令去取。页面自带全部样式和脚本，
 * 不加载任何外部资源（CSP 只放行本页 nonce 和同源请求）。
 */
const rescuePage = (blockedMessage: string | null): Response => {
  const nonce = randomNonce();
  const blocked = blockedMessage
    ? `<p class="blocked">${escapeHtml(blockedMessage)}</p>`
    : '';
  const form = blockedMessage ? '' : `
  <label for="token">救援口令（就是你填进 AMSG_RESCUE_TOKEN 的那串）</label>
  <input id="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false">
  <button id="start" type="button">开始导出</button>
  <p id="status" class="status"></p>
  <p id="download" class="download"></p>
  <div id="chars"></div>`;
  const script = blockedMessage ? '' : `<script nonce="${nonce}">${RESCUE_PAGE_SCRIPT}</script>`;
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>SullyOS 主动消息 · 数据救援</title>
<style nonce="${nonce}">${RESCUE_PAGE_STYLE}</style></head>
<body><main>
  <h1>主动消息 · 数据救援</h1>
  <p class="warn">这个页面能导出这台 Worker 里的<strong>全部云端数据，包括 API Key 和工具凭据</strong>。导出完成后，请立刻回 Cloudflare 面板删掉 AMSG_RESCUE_TOKEN，并妥善保管下载的文件。</p>
  <p class="note">能救回的只有主动消息 2.0 同步到云端的内容：每个角色的名字、日记、云端凭据和角色发过的消息；开着定时主动消息或挂着排程的角色，还有最后一次同步时的提示词快照（角色卡、世界书、月度总结、最近一段对话）。完整聊天记录、图片和其他 App 的数据不在云端，救不回来。</p>
  <p class="note">下载的文件可以直接导回 SullyOS：设置 → 备份与恢复 → 「从其他网址 / App 迁入独立用户」，会新建一个用户，不碰现有数据。</p>
  ${blocked}${form}
</main>${script}</body></html>`;
  return new Response(html, {
    status: blockedMessage ? 503 : 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      ...RESCUE_SECURITY_HEADERS,
    },
  });
};

const RESCUE_PAGE_STYLE = `
:root{color-scheme:light}
body{margin:0;background:#f6f7f9;color:#1f2933;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 16px}
.warn{background:#fdecea;color:#8a1c12;border:1px solid #f5b5ad;border-radius:10px;padding:12px 14px}
.note{color:#52606d;font-size:14px}
.blocked{background:#fff4e5;color:#7a4100;border:1px solid #f7c98b;border-radius:10px;padding:12px 14px}
label{display:block;margin:20px 0 6px;font-weight:600}
input{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid #cbd2d9;border-radius:8px;font-size:15px;background:#fff;color:#1f2933}
button{margin-top:12px;padding:10px 18px;border:0;border-radius:8px;background:#1f2933;color:#fff;font-size:15px;cursor:pointer}
button[disabled]{opacity:.5;cursor:default}
.status{margin-top:14px;white-space:pre-wrap}
.download a{display:inline-block;margin-top:4px;padding:10px 18px;border-radius:8px;background:#0b6e4f;color:#fff;text-decoration:none}
.char{background:#fff;border:1px solid #e4e7eb;border-radius:10px;padding:12px 14px;margin-top:12px}
.char h2{font-size:16px;margin:0 0 4px}
.char small{color:#7b8794;display:block;margin-bottom:8px;word-break:break-all}
.char button{margin:6px 8px 0 0;padding:6px 12px;font-size:13px;background:#3e4c59}
.char textarea{box-sizing:border-box;width:100%;height:220px;margin-top:8px;font:12px/1.5 ui-monospace,Menlo,monospace;border:1px solid #cbd2d9;border-radius:8px;padding:8px;background:#fff;color:#1f2933}
`;

/** 救援页脚本：拿清单 → 逐条取 → 拼成一个 JSON 下载，并按角色列出可复制的提示词和最近对话。 */
const RESCUE_PAGE_SCRIPT = `
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var base = location.pathname.replace(/\\/+$/, '');
  var token = '';
  function call(path, body){
    return fetch(base + path, {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Rescue-Token': token },
      body: JSON.stringify(body || {})
    }).then(function(res){
      return res.json().catch(function(){ return null; }).then(function(data){
        if (!res.ok || !data || data.success !== true) {
          throw new Error((data && data.error && data.error.message) || ('请求失败（HTTP ' + res.status + '）'));
        }
        return data.data;
      });
    });
  }
  function userOf(out, id){
    if (!out.users[id]) out.users[id] = { clientState: {}, tables: {} };
    return out.users[id];
  }
  function messageText(content){
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(function(part){ return part && part.type === 'text' ? part.text : '[' + (part && part.type) + ']'; }).join('\\n');
    return JSON.stringify(content);
  }
  function copy(text, area){
    area.value = text; area.hidden = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function(){ area.dataset.copied = '1'; }, function(){});
    }
  }
  function renderChars(out){
    var box = $('chars'); box.textContent = '';
    Object.keys(out.users).forEach(function(userId){
      var cs = out.users[userId].clientState;
      Object.keys(cs).forEach(function(ns){
        if (ns.indexOf('amsg:char:') !== 0) return;
        var entry = cs[ns]; var pack = entry.fire_pack; var tool = entry.tool_pack;
        var card = document.createElement('div'); card.className = 'char';
        var title = document.createElement('h2');
        title.textContent = (tool && tool.charName) || '未命名角色';
        var meta = document.createElement('small');
        meta.textContent = '角色 ID：' + ns.slice('amsg:char:'.length) + (pack && pack.builtAt ? ' · 快照时间：' + new Date(pack.builtAt).toLocaleString() : '');
        var area = document.createElement('textarea'); area.readOnly = true; area.hidden = true;
        card.appendChild(title); card.appendChild(meta);
        if (pack && typeof pack.template === 'string') {
          var b1 = document.createElement('button'); b1.type = 'button'; b1.textContent = '查看并复制提示词快照';
          b1.onclick = function(){ copy(pack.template, area); };
          card.appendChild(b1);
        }
        if (pack && pack.chat && Array.isArray(pack.chat.messages)) {
          var b2 = document.createElement('button'); b2.type = 'button'; b2.textContent = '查看并复制最近对话';
          b2.onclick = function(){ copy(pack.chat.messages.map(function(m){ return m.role + '：' + messageText(m.content); }).join('\\n\\n'), area); };
          card.appendChild(b2);
        }
        if (tool && Array.isArray(tool.memories) && tool.memories.length) {
          var b3 = document.createElement('button'); b3.type = 'button'; b3.textContent = '查看并复制日记';
          b3.onclick = function(){ copy(JSON.stringify(tool.memories, null, 2), area); };
          card.appendChild(b3);
        }
        card.appendChild(area);
        box.appendChild(card);
      });
    });
  }
  $('start').onclick = function(){
    token = $('token').value.trim();
    if (!token) { $('status').textContent = '先填救援口令。'; return; }
    var button = $('start'); button.disabled = true;
    $('download').textContent = ''; $('chars').textContent = '';
    var out = { format: 'sullyos-amsg-rescue', version: 1, exportedAt: new Date().toISOString(), worker: location.host,
      notice: '这份文件含 API Key 和工具凭据，请妥善保管，不要发给别人。', users: {}, errors: [] };
    $('status').textContent = '正在读取清单…';
    call('/manifest').then(function(manifest){
      var items = manifest.items || []; var done = 0;
      function next(){
        if (done >= items.length) return Promise.resolve();
        var item = items[done];
        $('status').textContent = '正在导出 ' + (done + 1) + ' / ' + items.length + '…';
        return call('/item', { id: item.id }).then(function(data){
          if (data.source === 'client_state') {
            var user = userOf(out, data.userId);
            if (!user.clientState[data.namespace]) user.clientState[data.namespace] = {};
            user.clientState[data.namespace][data.key] = data.status === 'decrypted' ? data.value : { _rescueStatus: data.status, updatedAt: data.updatedAt };
            if (data.status !== 'decrypted') out.errors.push({ id: item.id, namespace: data.namespace, key: data.key, status: data.status });
          } else {
            (data.rows || []).forEach(function(row){
              var user = userOf(out, row.user_id || '(unknown)');
              if (!user.tables[data.source]) user.tables[data.source] = [];
              user.tables[data.source].push(row);
            });
          }
        }, function(error){
          out.errors.push({ id: item.id, source: item.source, message: String(error && error.message || error) });
        }).then(function(){ done += 1; return next(); });
      }
      return next().then(function(){
        var blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'sullyos-amsg-rescue-' + new Date().toISOString().slice(0, 10) + '.json';
        link.textContent = '下载导出文件（JSON）';
        $('download').appendChild(link);
        $('status').textContent = '导出完成，共 ' + items.length + ' 项' + (out.errors.length ? '，其中 ' + out.errors.length + ' 项没能完整读出（详见文件里的 errors）' : '') + '。\\n下载后请回 Cloudflare 面板删掉 AMSG_RESCUE_TOKEN。';
        renderChars(out);
        link.click();
      });
    }).catch(function(error){
      $('status').textContent = '导出失败：' + (error && error.message || error);
    }).then(function(){ button.disabled = false; });
  };
})();
`;
