/**
 * 代跑的在飞登记表 + 已落地底账（localStorage，按用户空间各存一份）。
 *
 * 登记表：每交一次代跑记一条，界面的「云端生成」小条读它。交任务之前就写下（答复丢在
 * 路上时它是唯一的痕迹），running → landed / failed 之后留着，等界面收走或超过保留期。
 * 同一角色同一功能只留一条：新交的一份顶掉旧的那条已结束记录；running 的那条挡住重复提交。
 *
 * 底账：哪些 job 已经落过地。同一份结果会到达不止一次（推送直达一次、补收又一次），
 * 落地不是幂等的，见过的直接销账。
 *
 * 两个键都是这台设备的进度，不进备份、不随迁入为新用户带走（见 userSpaceBackup 的
 * privateLocalExcluded 与 independentUserRemap 的 canMigrateLocalKey）。
 */

import { cloudApiCallLogId, settleCloudApiCall } from '../apiCallLog';
import { CLOUD_GEN_NAMESPACE, CLOUD_GEN_PURPOSES, cloudGenJobKey, isCloudGenPurpose } from '../amsgCloudGenJob';
import { trackCloudGenOutcome } from './analytics';
import { CLOUD_GEN_DONE_KEY, CLOUD_GEN_JOBS_KEY, type CloudGenJobRecord, type CloudGenPurpose } from './types';

export { CLOUD_GEN_DONE_KEY, CLOUD_GEN_JOBS_KEY, isCloudGenStorageKey } from './types';

/** running 超过这么久就去问一次云端任务状态。 */
export const CLOUD_GEN_STALE_MS = 20 * 60_000;
/** 记录最多留这么久（从结束时算，没结束的从交出时算），界面没收走也清掉。 */
export const CLOUD_GEN_RECORD_MAX_AGE_MS = 24 * 60 * 60_000;
/** 底账留几条：够挡住重放和几份结果先后回来。 */
const DONE_KEEP = 50;

const HEADER = '[cloud-gen]';

// ─── 登记表 ───────────────────────────────────────────

const isRecord = (value: unknown): value is CloudGenJobRecord => {
  const r = value as Partial<CloudGenJobRecord> | null;
  return !!r && typeof r.jobId === 'string' && typeof r.charId === 'string' && isCloudGenPurpose(r.purpose)
    && typeof r.uuid === 'string' && typeof r.submittedAt === 'number' && typeof r.snapshotAt === 'number'
    && (r.status === 'running' || r.status === 'landed' || r.status === 'failed');
};

/** running 的也一样：一份跑了一整天的代跑不可能还在跑，留着只会一直挡住这个功能。 */
const isExpired = (record: CloudGenJobRecord, now: number): boolean =>
  now - (record.settledAt ?? record.submittedAt) > CLOUD_GEN_RECORD_MAX_AGE_MS;

const readAll = (): CloudGenJobRecord[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLOUD_GEN_JOBS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
};

const listeners = new Set<() => void>();
const notify = () => { for (const cb of listeners) { try { cb(); } catch { /* 一个订阅者出错不连累别的 */ } } };

const writeAll = (records: CloudGenJobRecord[]): void => {
  const now = Date.now();
  const kept = records.filter((r) => !isExpired(r, now));
  try {
    if (kept.length === 0) localStorage.removeItem(CLOUD_GEN_JOBS_KEY);
    else localStorage.setItem(CLOUD_GEN_JOBS_KEY, JSON.stringify(kept));
  } catch (error) {
    console.warn(`${HEADER} 登记表写不进去`, error);
  }
  notify();
};

/** 全部记录（已过保留期的不算）。 */
export const listCloudGenJobs = (): CloudGenJobRecord[] => {
  const now = Date.now();
  return readAll().filter((r) => !isExpired(r, now));
};

/** 这个角色这个功能的那一条（每对只留一条）。 */
export const getCloudGenJob = (charId: string, purpose: CloudGenPurpose): CloudGenJobRecord | null =>
  listCloudGenJobs().find((r) => r.charId === charId && r.purpose === purpose) ?? null;

export const getCloudGenJobById = (jobId: string): CloudGenJobRecord | null =>
  listCloudGenJobs().find((r) => r.jobId === jobId) ?? null;

/** 登记表有变化时回调（本页写入和别的标签页写入都算）。返回取消订阅。 */
export const subscribeCloudGenJobs = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
};

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key.endsWith(CLOUD_GEN_JOBS_KEY)) notify();
  });
}

// ─── 期间离开过页面（只给埋点用） ─────────────────────

// 这次页面加载的起点；比它早交出的，中间页面一定关过或被杀过。
const PAGE_STARTED_AT = (typeof performance !== 'undefined' && performance.timeOrigin) || Date.now();

/** 页面进后台时给在飞的记上「离开过」。同步写：页面随时可能被杀，等不到下一拍。 */
export const markRunningCloudGenJobsLeft = (): void => {
  const all = readAll();
  let changed = false;
  for (const r of all) {
    if (r.status === 'running' && !r.leftPage) { r.leftPage = true; changed = true; }
  }
  if (changed) writeAll(all);
};

let leaveWatchInstalled = false;
const installLeaveWatch = (): void => {
  if (leaveWatchInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
  leaveWatchInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') markRunningCloudGenJobsLeft();
  });
  window.addEventListener('pagehide', markRunningCloudGenJobsLeft);
};

/** 交出之后页面进没进过后台。 */
export const cloudGenJobLeftPage = (record: CloudGenJobRecord): boolean =>
  record.leftPage === true || record.submittedAt < PAGE_STARTED_AT;

/** 新交一份：同一角色同一功能的旧记录一并顶掉。 */
export const putCloudGenJob = (record: CloudGenJobRecord): void => {
  installLeaveWatch();
  writeAll([
    ...readAll().filter((r) => r.jobId !== record.jobId && !(r.charId === record.charId && r.purpose === record.purpose)),
    record,
  ]);
};

/** 改一条；不在了（被界面收走、被顶掉）就什么都不做，返回 null。 */
export const updateCloudGenJob = (jobId: string, patch: Partial<CloudGenJobRecord>): CloudGenJobRecord | null => {
  const all = readAll();
  const index = all.findIndex((r) => r.jobId === jobId);
  if (index < 0) return null;
  const next = { ...all[index], ...patch, jobId };
  all[index] = next;
  writeAll(all);
  return next;
};

export const removeCloudGenJob = (jobId: string): void => {
  const all = readAll();
  if (all.some((r) => r.jobId === jobId)) writeAll(all.filter((r) => r.jobId !== jobId));
};

/** 界面收走一条（用户点了「进入」或关掉了小条）。running 的不收：结果回来还要它。 */
export const dismissCloudGenJob = (jobId: string): void => {
  const record = getCloudGenJobById(jobId);
  if (record && record.status !== 'running') removeCloudGenJob(jobId);
};

/** 标成失败（调用记录那笔由调用方收）。记录已不在时返回 null。 */
export const markCloudGenJobFailed = (jobId: string, error: { code: string; message: string }): CloudGenJobRecord | null =>
  updateCloudGenJob(jobId, { status: 'failed', error, settledAt: Date.now() });

// ─── 已落地底账 ───────────────────────────────────────

const readDone = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLOUD_GEN_DONE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
};

export const isCloudGenJobDone = (jobId: string): boolean => readDone().includes(jobId);

export const markCloudGenJobDone = (jobId: string): void => {
  try {
    const next = [jobId, ...readDone().filter((id) => id !== jobId)].slice(0, DONE_KEEP);
    localStorage.setItem(CLOUD_GEN_DONE_KEY, JSON.stringify(next));
  } catch { /* 记不下就退回没有这道闸：重放会再落一次地 */ }
};

// ─── 收尾 ─────────────────────────────────────────────

/**
 * 跑太久的 running 去问一次云端：行没了（结果早该到了却没到）或已出清（失败）就标失败。
 * 还在排队、或这次问不到，都原样留着。交任务前和界面打开时各调一次。
 */
export const sweepStaleCloudGenJobs = async (now = Date.now()): Promise<void> => {
  const stale = readAll().filter((r) => r.status === 'running' && now - r.submittedAt > CLOUD_GEN_STALE_MS);
  if (stale.length === 0) return;
  const { ActiveMsgClient } = await import('../activeMsgClient');
  for (const record of stale) {
    let status;
    try {
      status = await ActiveMsgClient.getRemoteTaskStatus(record.uuid);
    } catch {
      continue;
    }
    if (status.state === 'pending') continue;
    // 结果可能刚好在路上：标失败之后它照样能落地（results.ts 不看这里的状态）。
    const error = status.state === 'completed'
      ? { code: status.lastError?.errorCode || 'generation-failed', message: status.lastError?.reason || '云端生成失败' }
      : { code: 'lost', message: '云端任务已结束，但结果没有送回来' };
    console.warn(`${HEADER} ${record.purpose} 跑了 ${Math.round((now - record.submittedAt) / 60_000)} 分钟没回来，标为失败`, record.jobId);
    const failed = markCloudGenJobFailed(record.jobId, error);
    if (failed) {
      settleCloudApiCall({ id: cloudApiCallLogId(record.jobId), ok: false });
      // 点名时不知道云端是什么时候结束的，用时报「未知」。
      trackCloudGenOutcome(record.purpose, 'failed', { error, leftPage: cloudGenJobLeftPage(failed) });
      // 跟云端报失败走同一个收尾：用户发起的功能要靠它弹失败提示，不然小条悄悄消失。
      try {
        const { loadCloudGenLander } = await import('./landers');
        await (await loadCloudGenLander(record.purpose)).onFailed?.(failed, error);
      } catch (hookError) {
        console.warn(`${HEADER} ${record.purpose} 超时失败收尾出错`, hookError);
      }
    }
  }
};

/**
 * 删角色时：撤掉这个角色还在飞的代跑（取消任务行、清输入），登记表里的记录一并删掉。
 * best-effort，失败只记日志（输入有 TTL 兜底）。
 */
export const purgeCloudGenJobsForChar = async (charId: string): Promise<void> => {
  const { clearCloudGenPending } = await import('./pending');
  for (const purpose of CLOUD_GEN_PURPOSES) clearCloudGenPending(purpose, charId);
  const records = readAll().filter((r) => r.charId === charId);
  if (records.length === 0) return;
  writeAll(readAll().filter((r) => r.charId !== charId));
  const running = records.filter((r) => r.status === 'running');
  if (running.length === 0) return;
  const { ActiveMsgClient } = await import('../activeMsgClient');
  for (const record of running) {
    settleCloudApiCall({ id: cloudApiCallLogId(record.jobId), ok: false });
    try { await ActiveMsgClient.cancelTask(record.uuid); } catch (error) {
      console.warn(`${HEADER} 删角色时取消代跑任务失败（输入照撤）`, error);
    }
    try { await ActiveMsgClient.clearClientStateValue(CLOUD_GEN_NAMESPACE, cloudGenJobKey(record.jobId)); } catch (error) {
      console.warn(`${HEADER} 删角色时撤代跑输入失败（等 TTL 兜底）`, error);
    }
  }
};
