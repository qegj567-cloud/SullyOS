/**
 * 自动更新：配了 CF_API_TOKEN 的 Worker 自己定期看一眼有没有新代码，有就换上，不用人点。
 *
 * 「怎么换」全在 ./selfUpdate（取包、验包、补齐 binding、覆盖自己），这份文件只管三件事：
 *
 *   1. **什么时候查**——cron 每一跳都会路过这里，但真去 GitHub 拉包要隔够
 *      AUTO_UPDATE_CRON_INTERVAL_MS；App 冷启动顺手发来的 `POST /self-update/check`
 *      门槛低一些（AUTO_UPDATE_CLIENT_INTERVAL_MS），因为前端刚更新往往意味着后端也该更新。
 *      两条路共用同一个「上次检查时刻」，谁先来谁算。
 *   2. **要不要换**——按成品包内容的指纹比：跟上次装上去的一样、而且运行时该有的绑定都在，
 *      就不动。不看版本号：版本号只在「用户不更新就出错」时才手改，而自动更新的意义正是
 *      让用户那台 Worker 跟着仓库走，不必等人记得改号。
 *   3. **把结果记下来**——cron 那条路上没有调用方能看到错误，状态写进诊断表，
 *      `GET /config-check` 原样报给设置页（形状见 utils/amsgSelfUpdateState.ts）。
 *
 * 「要点两次」的老问题在这里自然消化掉：自更新永远由旧代码执行，新版本新加的绑定第一次
 * 装不上（见 selfUpdate.buildDurableObjectPlan 的注释）。下一轮检查跑的是新代码，它发现
 * 指纹没变但绑定缺了，就再传一次把绑定补上。
 *
 * 更新之后表结构由新代码自己补（ensureSchemaOnce）：以前靠前端更新完点一次「重新连接」
 * 建表，后台自动换了代码时页面多半没开着，不自己补的话 cron 会因为缺表缺列每分钟静默挂。
 */

import type { AmsgSelfUpdateOutcome, AmsgSelfUpdateSource, AmsgSelfUpdateState } from '../../../utils/amsgSelfUpdateState';
import { parseAmsgSelfUpdateState } from '../../../utils/amsgSelfUpdateState';
import {
  fetchLatestBundle,
  performSelfUpdate,
  type SelfUpdateEnv,
  type SelfUpdateResult,
} from './selfUpdate';
import { readDiagnosticValue, writeDiagnosticValue, type TickReportDb } from './tickReport';

/** cron 路上两次真正去拉包之间至少隔这么久。发布不勤，再密只是白拉 400 KB。 */
export const AUTO_UPDATE_CRON_INTERVAL_MS = 6 * 60 * 60_000;
/**
 * App 冷启动发来的检查请求，离上一次检查至少隔这么久才真去拉。
 * 比 cron 那档松：前端更新了往往意味着后端也该更新，这时等六小时太久；
 * 但同一台手机一天开十几次 App 也不该次次去拉包。
 *
 * 这个数还兼着一道保险：GitHub raw 的 CDN 是 max-age=300，新包推上去后几分钟内各节点
 * 还会吐旧包。按指纹比的话，「刚换上新的、紧接着又取回旧的」会把新代码换回去
 * （2026-09-25 真机上手动把检查时钟拨回去复现过）。两次检查至少隔半小时，缓存早铺开了，
 * 所以这事在正常节奏下撞不上——**别把这个数调到 5 分钟以下**。
 */
export const AUTO_UPDATE_CLIENT_INTERVAL_MS = 30 * 60_000;

/** 先尝试更新，再进入维护和投递；维护失败不能阻止修复包的检查。 */
export async function runScheduledAfterUpdate<T>(update: () => Promise<unknown>, tick: () => Promise<T>): Promise<T> {
  try {
    await update();
  } catch (error) {
    console.warn('[amsg:auto-update] 这一跳的自动更新检查没跑完', error);
  }
  return tick();
}

/** 诊断表里的两个键。 */
const SELF_UPDATE_KEY = 'self_update';
const SCHEMA_ENSURED_KEY = 'schema_ensured';

/** 表结构自查失败后隔这么久再试，别每分钟都去数一遍表。 */
const SCHEMA_ENSURE_RETRY_MS = 60 * 60_000;


export interface AutoUpdateEnv extends SelfUpdateEnv {
  /** 即时对话的起跳器绑定。运行时没有它 = 上一次更新是旧代码执行的、绑定还没补上。 */
  INSTANT_TICK?: unknown;
}

export type AutoUpdateRun =
  /** 没配 CF_API_TOKEN，这台 Worker 没有自更新能力；什么都不写。 */
  | { action: 'unsupported' }
  /** 离上次检查还不够久，没去拉包。 */
  | { action: 'throttled'; state: AmsgSelfUpdateState }
  | { action: AmsgSelfUpdateOutcome; state: AmsgSelfUpdateState };

/** 读上次检查的状态。表没建 / 行不在 / 形状不对都当从没查过。 */
export const readSelfUpdateState = async (db: TickReportDb | undefined): Promise<AmsgSelfUpdateState | null> => {
  const raw = await readDiagnosticValue(db, SELF_UPDATE_KEY);
  if (!raw) return null;
  try {
    return parseAmsgSelfUpdateState(JSON.parse(raw));
  } catch {
    return null;
  }
};

const writeSelfUpdateState = async (db: TickReportDb, state: AmsgSelfUpdateState, nowMs: number): Promise<void> => {
  await writeDiagnosticValue(db, SELF_UPDATE_KEY, JSON.stringify(state), nowMs);
};

/** 换上新代码之后把「表结构已经查过」的记号抹掉，下一跳由新代码重新查一遍。 */
const markSchemaUnverified = async (db: TickReportDb, nowMs: number): Promise<void> => {
  await writeDiagnosticValue(db, SCHEMA_ENSURED_KEY, '', nowMs);
};

/**
 * 把一次自更新（不管谁发起的）的结果并进状态。
 *
 * 失败时指纹保留上一次成功的值：线上跑的仍是那一份，下次照样拿它比。
 */
export const applySelfUpdateResult = (
  previous: AmsgSelfUpdateState | null,
  source: AmsgSelfUpdateSource,
  result: SelfUpdateResult,
  nowMs: number,
): AmsgSelfUpdateState => {
  const nowIso = new Date(nowMs).toISOString();
  if (result.ok) {
    return {
      lastCheckAt: nowIso,
      lastSource: source,
      lastOutcome: 'updated',
      bundleHash: result.bundleHash ?? previous?.bundleHash ?? null,
      lastUpdatedAt: nowIso,
      lastError: null,
    };
  }
  return {
    lastCheckAt: nowIso,
    lastSource: source,
    lastOutcome: 'failed',
    bundleHash: previous?.bundleHash ?? null,
    lastUpdatedAt: previous?.lastUpdatedAt ?? null,
    lastError: { code: result.code, message: result.message },
  };
};

/**
 * 设置页手动点的那次更新（`POST /self-update`）也记进同一份状态：它装上的那份指纹就是
 * 之后自动检查的比对基准，不记的话下一轮自动检查会把同一份包再传一遍。
 * best-effort：记不进去不改判更新本身。
 */
export const recordManualSelfUpdate = async (
  db: TickReportDb | undefined,
  result: SelfUpdateResult,
  nowMs = Date.now(),
): Promise<void> => {
  if (typeof db?.prepare !== 'function') return;
  try {
    const previous = await readSelfUpdateState(db);
    await writeSelfUpdateState(db, applySelfUpdateResult(previous, 'manual', result, nowMs), nowMs);
    if (result.ok) await markSchemaUnverified(db, nowMs);
  } catch (error) {
    console.warn('[amsg:auto-update] 手动更新的结果没记进库', error);
  }
};

/**
 * 一轮自动检查。cron 每跳调一次（source 'cron'），冷启动的检查请求调一次（source 'client'）。
 *
 * 调用方负责决定 scriptName（cron 路上没有请求，只能靠 CF_SCRIPT_NAME；请求路上还能从
 * workers.dev 域名反推，见 selfUpdate.resolveScriptName）。传 null 表示认不出来，这里会把它
 * 当一次失败记下来，设置页才看得见「要补 CF_SCRIPT_NAME」。
 */
export const runAutoUpdate = async (
  env: AutoUpdateEnv,
  db: TickReportDb,
  options: { source: 'cron' | 'client'; scriptName: string | null; nowMs?: number },
): Promise<AutoUpdateRun> => {
  const token = env.CF_API_TOKEN?.trim();
  if (!token) return { action: 'unsupported' };

  const nowMs = options.nowMs ?? Date.now();
  const previous = await readSelfUpdateState(db);
  const minInterval = options.source === 'cron' ? AUTO_UPDATE_CRON_INTERVAL_MS : AUTO_UPDATE_CLIENT_INTERVAL_MS;
  if (previous && nowMs - Date.parse(previous.lastCheckAt) < minInterval) {
    return { action: 'throttled', state: previous };
  }

  // 先把「查过了」记下来再动手：cron 两跳之间可能重叠，冷启动的请求也可能跟 cron 撞上，
  // 不先占坑的话两边会同时去拉包、同时上传。占坑之后的第二个来者会被上面那道节流挡住。
  const claimed: AmsgSelfUpdateState = {
    lastCheckAt: new Date(nowMs).toISOString(),
    lastSource: options.source,
    lastOutcome: previous?.lastOutcome ?? 'up_to_date',
    bundleHash: previous?.bundleHash ?? null,
    lastUpdatedAt: previous?.lastUpdatedAt ?? null,
    lastError: previous?.lastError ?? null,
  };
  await writeSelfUpdateState(db, claimed, nowMs);

  const settle = async (result: SelfUpdateResult): Promise<AutoUpdateRun> => {
    const state = applySelfUpdateResult(previous, options.source, result, nowMs);
    await writeSelfUpdateState(db, state, nowMs);
    if (result.ok) await markSchemaUnverified(db, nowMs);
    return { action: state.lastOutcome, state };
  };

  if (!options.scriptName) {
    return settle({
      ok: false,
      code: 'SCRIPT_NAME_UNKNOWN',
      message: '认不出这个 Worker 叫什么。给它加一条 CF_SCRIPT_NAME 变量，值填 Worker 的名字，自动更新才知道该更新谁。',
    });
  }

  const fetched = await fetchLatestBundle(env);
  if (!fetched.ok) return settle({ ok: false, code: 'BUNDLE_INVALID', message: fetched.message });

  // 跟上次装的是同一份、运行时该有的绑定也都在 → 不动。
  // 绑定缺了照样再传一次：那正是「上次更新由旧代码执行、绑定没补上」的中间态。
  const bindingsComplete = Boolean(env.INSTANT_TICK);
  if (previous?.bundleHash === fetched.bundle.hash && bindingsComplete) {
    const state: AmsgSelfUpdateState = {
      ...claimed,
      lastOutcome: 'up_to_date',
      bundleHash: fetched.bundle.hash,
      lastError: null,
    };
    await writeSelfUpdateState(db, state, nowMs);
    return { action: 'up_to_date', state };
  }
  if (previous?.bundleHash === fetched.bundle.hash) {
    console.log('[amsg:auto-update] 代码没变但 INSTANT_TICK 绑定不在，再传一次把绑定补上');
  }

  const result = await performSelfUpdate(env, token, options.scriptName, fetched.bundle);
  if (result.ok) {
    console.log(`[amsg:auto-update] 已换上新代码 ${result.bundleHash}（${options.source} 触发）`);
  } else {
    console.warn(`[amsg:auto-update] 更新失败 ${result.code}：${result.message}`);
  }
  return settle(result);
};

// ─── 换完代码自己补表 ───

interface SchemaEnsuredMarker {
  /** 已经按哪一版表结构查过；空串 = 刚换过代码、还没查。 */
  ensuredFor: string;
  /** 上一次查失败的时刻，用来退避。 */
  failedAtMs: number | null;
}

const readSchemaMarker = async (db: TickReportDb): Promise<SchemaEnsuredMarker> => {
  const raw = await readDiagnosticValue(db, SCHEMA_ENSURED_KEY);
  if (!raw) return { ensuredFor: '', failedAtMs: null };
  try {
    const value = JSON.parse(raw) as Partial<SchemaEnsuredMarker> | null;
    return {
      ensuredFor: typeof value?.ensuredFor === 'string' ? value.ensuredFor : '',
      failedAtMs: typeof value?.failedAtMs === 'number' ? value.failedAtMs : null,
    };
  } catch {
    return { ensuredFor: '', failedAtMs: null };
  }
};

/**
 * 这一版代码要的表结构够不够，不够就补——每个表结构版本只查一次，换过代码之后再查一次。
 *
 * `schemaVersion` 传上游的 SCHEMA_VERSION：它只在表 / 列 / 索引变化时抬，所以「跟上次查过
 * 的不一样」就是「上游加了东西」。手动 Sync fork、wrangler deploy 换上来的代码也走这条，
 * 不再依赖前端更新完点一次「重新连接」。
 *
 * 返回值只为单测与日志：'skipped' 没必要查；'ok' 查了（补没补看日志）；'failed' 查挂了，
 * 一小时后再试。
 */
export const ensureSchemaOnce = async (
  db: TickReportDb | undefined,
  schemaVersion: string,
  ensure: () => Promise<{ ok: boolean; migrated: boolean; missing: string[] }>,
  nowMs = Date.now(),
): Promise<'skipped' | 'ok' | 'failed'> => {
  if (typeof db?.prepare !== 'function') return 'skipped';
  const marker = await readSchemaMarker(db);
  if (marker.ensuredFor === schemaVersion) return 'skipped';
  if (marker.failedAtMs !== null && nowMs - marker.failedAtMs < SCHEMA_ENSURE_RETRY_MS) return 'skipped';

  try {
    const result = await ensure();
    if (result.migrated) console.log(`[amsg:auto-update] 表结构已按 ${schemaVersion} 补齐`);
    if (!result.ok) {
      // 补完还缺：多半是 ALTER 被库拒了。记成失败退避，别每分钟都撞一次。
      console.warn(`[amsg:auto-update] 表结构补不齐，还缺：${result.missing.join('、')}`);
      await writeDiagnosticValue(db, SCHEMA_ENSURED_KEY, JSON.stringify({ ensuredFor: '', failedAtMs: nowMs }), nowMs);
      return 'failed';
    }
    await writeDiagnosticValue(db, SCHEMA_ENSURED_KEY, JSON.stringify({ ensuredFor: schemaVersion, failedAtMs: null }), nowMs);
    return 'ok';
  } catch (error) {
    console.warn('[amsg:auto-update] 表结构自查没跑成', error);
    try {
      await writeDiagnosticValue(db, SCHEMA_ENSURED_KEY, JSON.stringify({ ensuredFor: '', failedAtMs: nowMs }), nowMs);
    } catch {
      // 连诊断表都写不了，那就下一跳再来。
    }
    return 'failed';
  }
};
