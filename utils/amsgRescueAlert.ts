/**
 * 主动消息 2.0「救援模式」警告的本机留存与判定。
 *
 * Worker 把救援模式的留痕记在自己的 D1 里，`GET /config-check` 报出来（形状见
 * utils/amsgRescueState.ts）。这里把每次拿到的那一段存一份到 localStorage，再决定要不要
 * 强制弹窗（弹窗本体在 components/AmsgRescueAlert.tsx）。
 *
 * 为什么本机副本要「粘」：能开救援模式的人，同样能登录 Cloudflare 面板把 D1 里的留痕删掉、
 * 或者换回一份不报 rescue 字段的旧代码。如果前端只认 Worker 当下报的，那一删就什么都看不见了。
 * 所以合并时只往「更新、更多」的方向走：
 *   - Worker 报回空（episode 为 null / 老代码没有 rescue 字段）→ 保留本机那份；
 *   - 同一段留痕里的次数只取较大的（D1 被改小了也不跟着变小）；
 *   - 换成更早的一段 → 不认，保留本机较新的那段。
 * 是否警告仍以 7 天窗口为准（isRescueAlertDue），过期就不再弹。
 *
 * 本模块只依赖 amsgRescueState（零依赖叶子）和 localStorage：activeMsgClient 会在拿到
 * /config-check 成功响应时调这里记录，反过来引 activeMsgClient 会成环。探测发请求的部分在
 * utils/amsgRescueProbe.ts。
 *
 * 完整的设计与取舍见 docs/amsg2-rescue.md。
 */

import {
  AMSG_RESCUE_ALERT_WINDOW_MS,
  isRescueAlertDue,
  parseAmsgRescueEpisode,
  parseAmsgRescueReport,
  rescueAlertAckKey,
  type AmsgRescueEpisode,
  type AmsgRescueReport,
} from './amsgRescueState';

/**
 * localStorage 键。属于设备状态：不进备份（恢复到新设备后这台设备会自己去问 Worker）。
 * 在 utils/userSpaces.ts 里登记为各用户空间共用——2.0 的后台连接本来就是全局一份，
 * 警告不该因为切了用户空间就消失。
 */
export const AMSG_RESCUE_ALERT_LS_KEY = 'amsg2_rescue_alert_v1';

/** 已确认的 ack key 最多留这么多条，够覆盖一段留痕里反复导出的情形。 */
const MAX_ACKED_KEYS = 20;

/** 早就不在警告窗口里、也很久没再问到的记录，过这么久就清掉，免得换过的旧地址越攒越多。 */
const STALE_RECORD_MS = 30 * 24 * 60 * 60 * 1000;

/** 一台 Worker 在本机的救援留痕副本。 */
export interface StoredRescueRecord {
  /** 合并后的报告：active 是最近一次问到的实况，episode 是本机见过的最新一段。 */
  report: AmsgRescueReport;
  /** 最近一次拿到 Worker 的 rescue 段（或收到开启推送）的时刻。 */
  checkedAt: number;
  /**
   * 本机最近一次知道「救援模式开着」的时刻。留痕被删光（episode 一直是 null）时，
   * 7 天窗口就靠它算。
   */
  lastActiveSeenAt: number | null;
  /**
   * Worker 报回来的留痕和本机保存的对不上（报回空、换成更早的一段、或次数比本机少）。
   * 可能是留痕被人删改过，也可能只是那次读不到 D1，弹窗里如实说明。
   */
  cloudRecordMismatch: boolean;
  /** 用户点过「我已阅读并知晓」的 ack key。 */
  ackedKeys: string[];
}

type RescueAlertStore = Record<string, StoredRescueRecord>;

/** 存储里按 Worker 地址区分；同一地址写法略有出入（尾斜杠、大小写）也算一台。 */
export const rescueWorkerKey = (workerUrl: string): string =>
  workerUrl.trim().replace(/\/+$/, '').toLowerCase();

const maxTime = (a: number | null, b: number | null): number | null => {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
};

/**
 * 两段留痕挑哪段、怎么合。返回合并结果，以及 Worker 这次报的是否比本机少。
 *  - 不同的段：首次发现时刻更晚的那段算新的。Worker 报了更早的一段 → 保留本机的，记一笔对不上。
 *  - 同一段：次数、时刻都取较大值。结束时刻以 Worker 为准（还开着就是 null）。
 */
const mergeEpisodes = (
  local: AmsgRescueEpisode | null,
  incoming: AmsgRescueEpisode | null,
  incomingActive: boolean,
): { episode: AmsgRescueEpisode | null; mismatch: boolean } => {
  if (!incoming) return { episode: local, mismatch: Boolean(local) };
  if (!local) return { episode: incoming, mismatch: false };
  if (incoming.id !== local.id) {
    return incoming.firstSeenAt >= local.firstSeenAt
      ? { episode: incoming, mismatch: false }
      : { episode: local, mismatch: true };
  }
  const mismatch = incoming.exportCount < local.exportCount
    || incoming.itemReads < local.itemReads
    || incoming.failedAttempts < local.failedAttempts
    || incoming.pushTargets < local.pushTargets;
  return {
    episode: {
      id: incoming.id,
      firstSeenAt: Math.min(incoming.firstSeenAt, local.firstSeenAt),
      lastSeenAt: Math.max(incoming.lastSeenAt, local.lastSeenAt),
      endedAt: incomingActive ? null : (incoming.endedAt ?? local.endedAt),
      exportCount: Math.max(incoming.exportCount, local.exportCount),
      lastExportAt: maxTime(incoming.lastExportAt, local.lastExportAt),
      itemReads: Math.max(incoming.itemReads, local.itemReads),
      lastReadAt: maxTime(incoming.lastReadAt, local.lastReadAt),
      failedAttempts: Math.max(incoming.failedAttempts, local.failedAttempts),
      pushedAt: maxTime(incoming.pushedAt, local.pushedAt),
      pushTargets: Math.max(incoming.pushTargets, local.pushTargets),
      pushDelivered: Math.max(incoming.pushDelivered, local.pushDelivered),
    },
    mismatch,
  };
};

/**
 * 把 Worker 这次报的 rescue 段并进本机副本。纯函数，方便钉住粘性规则。
 * incoming 为 null（老 Worker 没有这个字段）时原样返回本机副本，不新建记录。
 */
export const mergeRescueRecord = (
  local: StoredRescueRecord | null,
  incoming: AmsgRescueReport | null,
  nowMs: number,
): StoredRescueRecord | null => {
  if (!incoming) return local;
  const { episode, mismatch } = mergeEpisodes(local?.report.episode ?? null, incoming.episode, incoming.active);
  return {
    report: { active: incoming.active, episode },
    checkedAt: nowMs,
    lastActiveSeenAt: incoming.active ? nowMs : (local?.lastActiveSeenAt ?? null),
    cloudRecordMismatch: mismatch,
    ackedKeys: local?.ackedKeys ?? [],
  };
};

/**
 * 收到「救援模式已开启」的推送、但没问到 Worker 的 rescue 段（断网、超时）时，
 * 至少记下「那个时刻它是开着的」，警告照样能弹。
 * 不把 active 置成 true：推送只说明那一刻开着，现在还开不开不知道；7 天窗口靠 lastActiveSeenAt 算，
 * 否则一条补收回来的陈旧推送会让警告永远不过期。
 */
export const markRescueActiveSeen = (
  local: StoredRescueRecord | null,
  seenAt: number,
  nowMs: number,
): StoredRescueRecord => ({
  report: { active: local?.report.active ?? false, episode: local?.report.episode ?? null },
  checkedAt: Math.max(local?.checkedAt ?? 0, nowMs),
  lastActiveSeenAt: maxTime(local?.lastActiveSeenAt ?? null, seenAt),
  cloudRecordMismatch: local?.cloudRecordMismatch ?? false,
  ackedKeys: local?.ackedKeys ?? [],
});

/** 是否还在 7 天警告窗口里（开着、留痕里最后动静在 7 天内、或本机 7 天内见过它开着）。 */
export const isRescueRecordDue = (record: StoredRescueRecord | null, nowMs: number): boolean => {
  if (!record) return false;
  if (isRescueAlertDue(record.report.active, record.report.episode, nowMs)) return true;
  return record.lastActiveSeenAt !== null && nowMs - record.lastActiveSeenAt <= AMSG_RESCUE_ALERT_WINDOW_MS;
};

/**
 * 当前这份记录对应的 ack key。只凭推送知道开过、手上没有任何留痕时，active 那一档按
 * 「开着、没有记录」算，跟 Worker 留痕被删光时同一个键。
 */
export const rescueRecordAckKey = (record: StoredRescueRecord): string =>
  rescueAlertAckKey(record.report.active || (!record.report.episode && record.lastActiveSeenAt !== null), record.report.episode);

/** 该不该自动弹：在窗口内，且当前 ack key 还没确认过。 */
export const shouldShowRescueAlert = (record: StoredRescueRecord | null, nowMs: number): boolean =>
  Boolean(record) && isRescueRecordDue(record, nowMs) && !record!.ackedKeys.includes(rescueRecordAckKey(record!));

/** 记下用户确认过当前这一版。 */
export const ackRescueRecord = (record: StoredRescueRecord): StoredRescueRecord => {
  const key = rescueRecordAckKey(record);
  if (record.ackedKeys.includes(key)) return record;
  return { ...record, ackedKeys: [...record.ackedKeys, key].slice(-MAX_ACKED_KEYS) };
};

// ===== localStorage 读写 =====

const parseStoredRecord = (raw: unknown): StoredRescueRecord | null => {
  const value = raw as Partial<StoredRescueRecord> | null;
  if (!value || typeof value !== 'object') return null;
  const reportRaw = value.report as Partial<AmsgRescueReport> | undefined;
  const report = parseAmsgRescueReport(reportRaw) ?? (reportRaw && typeof reportRaw === 'object'
    ? { active: false, episode: parseAmsgRescueEpisode(reportRaw.episode) }
    : null);
  if (!report || typeof value.checkedAt !== 'number') return null;
  return {
    report,
    checkedAt: value.checkedAt,
    lastActiveSeenAt: typeof value.lastActiveSeenAt === 'number' ? value.lastActiveSeenAt : null,
    cloudRecordMismatch: value.cloudRecordMismatch === true,
    ackedKeys: Array.isArray(value.ackedKeys) ? value.ackedKeys.filter((key): key is string => typeof key === 'string') : [],
  };
};

const readStore = (): RescueAlertStore => {
  try {
    const raw = localStorage.getItem(AMSG_RESCUE_ALERT_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const store: RescueAlertStore = {};
    for (const [key, value] of Object.entries(parsed)) {
      const record = parseStoredRecord(value);
      if (record) store[key] = record;
    }
    return store;
  } catch {
    return {};
  }
};

const writeStore = (store: RescueAlertStore, nowMs: number): void => {
  const kept: RescueAlertStore = {};
  for (const [key, record] of Object.entries(store)) {
    if (isRescueRecordDue(record, nowMs) || nowMs - record.checkedAt <= STALE_RECORD_MS) kept[key] = record;
  }
  try {
    if (Object.keys(kept).length === 0) localStorage.removeItem(AMSG_RESCUE_ALERT_LS_KEY);
    else localStorage.setItem(AMSG_RESCUE_ALERT_LS_KEY, JSON.stringify(kept));
  } catch {
    // 存不下就只在这次会话的内存快照里生效；下次启动还会再问 Worker。
  }
};

export const readRescueRecord = (workerUrl: string): StoredRescueRecord | null =>
  readStore()[rescueWorkerKey(workerUrl)] ?? null;

const updateRecord = (
  workerUrl: string,
  nowMs: number,
  update: (local: StoredRescueRecord | null) => StoredRescueRecord | null,
): StoredRescueRecord | null => {
  const key = rescueWorkerKey(workerUrl);
  if (!key) return null;
  const store = readStore();
  const next = update(store[key] ?? null);
  if (!next) return store[key] ?? null;
  store[key] = next;
  writeStore(store, nowMs);
  return next;
};

// ===== 订阅（弹窗和设置页的常驻提示都读这一份快照） =====

export interface RescueAlertSnapshot {
  /** 当前连着的 Worker（还不知道时为空串）。 */
  workerUrl: string;
  record: StoredRescueRecord | null;
  /** 在 7 天警告窗口内（设置页的常驻提示看这个）。 */
  due: boolean;
  /** 需要自动强制弹窗。 */
  shouldAlert: boolean;
  /** 用户从设置页点了「查看详情」，要求打开弹窗（已确认过也打开）。 */
  detailsRequested: boolean;
}

const EMPTY_SNAPSHOT: RescueAlertSnapshot = { workerUrl: '', record: null, due: false, shouldAlert: false, detailsRequested: false };

let currentWorkerUrl = '';
let detailsRequested = false;
let snapshot: RescueAlertSnapshot = EMPTY_SNAPSHOT;
let lastRecordedAt = 0;
const listeners = new Set<() => void>();

const rebuildSnapshot = (nowMs = Date.now()): void => {
  const record = currentWorkerUrl ? readRescueRecord(currentWorkerUrl) : null;
  const due = isRescueRecordDue(record, nowMs);
  snapshot = {
    workerUrl: currentWorkerUrl,
    record,
    due,
    shouldAlert: shouldShowRescueAlert(record, nowMs),
    detailsRequested: detailsRequested && due,
  };
  listeners.forEach(listener => listener());
};

export const subscribeRescueAlert = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const getRescueAlertSnapshot = (): RescueAlertSnapshot => snapshot;

/** 告诉警告模块当前连的是哪台 Worker（启动、探测、改配置时调），并按本机副本重算一次。 */
export const setRescueAlertWorker = (workerUrl: string, nowMs = Date.now()): void => {
  currentWorkerUrl = workerUrl.trim();
  rebuildSnapshot(nowMs);
};

/** 不改任何东西，只按当前时间重算（页面回到前台时调，7 天窗口可能刚好过了）。 */
export const refreshRescueAlertSnapshot = (nowMs = Date.now()): void => rebuildSnapshot(nowMs);

/** 最近一次把 Worker 的 rescue 段记进来的时刻（内存，回前台探测的节流用）。 */
export const getRescueLastRecordedAt = (): number => lastRecordedAt;

/**
 * 拿到一次 `GET /config-check` 成功响应时调：把 `body.data.rescue` 并进本机副本。
 * 老 Worker 没有这个字段时什么都不做（不报错、不清掉本机副本）。
 */
export const recordRescueFromConfigCheck = (body: unknown, workerUrl: string | undefined, nowMs = Date.now()): void => {
  if (!workerUrl?.trim()) return;
  const report = parseAmsgRescueReport((body as { data?: { rescue?: unknown } } | null)?.data?.rescue);
  if (!report) return;
  lastRecordedAt = nowMs;
  updateRecord(workerUrl, nowMs, local => mergeRescueRecord(local, report, nowMs));
  if (!currentWorkerUrl) currentWorkerUrl = workerUrl.trim();
  rebuildSnapshot(nowMs);
};

/** 收到开启推送但没问到 rescue 段时调，见 markRescueActiveSeen。 */
export const recordRescuePushWithoutReport = (workerUrl: string, seenAt: number, nowMs = Date.now()): void => {
  if (!workerUrl.trim()) return;
  updateRecord(workerUrl, nowMs, local => markRescueActiveSeen(local, seenAt, nowMs));
  if (!currentWorkerUrl) currentWorkerUrl = workerUrl.trim();
  rebuildSnapshot(nowMs);
};

/** 用户在弹窗里点了「我已阅读并知晓」。 */
export const acknowledgeRescueAlert = (nowMs = Date.now()): void => {
  detailsRequested = false;
  if (currentWorkerUrl) updateRecord(currentWorkerUrl, nowMs, local => (local ? ackRescueRecord(local) : null));
  rebuildSnapshot(nowMs);
};

/** 设置页「查看详情」：重新打开弹窗（同样要读满 10 秒）。 */
export const requestRescueAlertDetails = (nowMs = Date.now()): void => {
  detailsRequested = true;
  rebuildSnapshot(nowMs);
};

/** 弹窗弹出时报的统计属性。全是写死的枚举，见 docs/analytics.md。 */
export const buildRescueAlertAnalytics = (
  record: StoredRescueRecord,
  manual: boolean,
): Record<string, string> => ({
  打开方式: manual ? '设置页' : '自动',
  救援模式: record.report.active ? '仍开着' : '已关闭',
  导出过: (record.report.episode?.exportCount ?? 0) > 0 ? '是' : '否',
  云端留痕: record.cloudRecordMismatch ? '对不上' : '一致',
});

/** 只给测试用：清掉内存里的状态。 */
export const resetRescueAlertMemoryForTest = (): void => {
  currentWorkerUrl = '';
  detailsRequested = false;
  snapshot = EMPTY_SNAPSHOT;
  lastRecordedAt = 0;
  listeners.clear();
};
