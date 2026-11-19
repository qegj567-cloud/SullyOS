import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AMSG_RESCUE_ALERT_LS_KEY,
  acknowledgeRescueAlert,
  buildRescueAlertAnalytics,
  getRescueAlertSnapshot,
  mergeRescueRecord,
  readRescueRecord,
  recordRescueFromConfigCheck,
  recordRescuePushWithoutReport,
  requestRescueAlertDetails,
  resetRescueAlertMemoryForTest,
  setRescueAlertWorker,
  shouldShowRescueAlert,
  type StoredRescueRecord,
} from './amsgRescueAlert';
import { AMSG_RESCUE_ALERT_WINDOW_MS, type AmsgRescueEpisode, type AmsgRescueReport } from './amsgRescueState';
import { isSharedSpaceKey } from './userSpaces';

const WORKER = 'https://amsg.example.workers.dev';
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

const episode = (patch: Partial<AmsgRescueEpisode> = {}): AmsgRescueEpisode => ({
  id: String(T0),
  firstSeenAt: T0,
  lastSeenAt: T0,
  endedAt: null,
  exportCount: 0,
  lastExportAt: null,
  itemReads: 0,
  lastReadAt: null,
  failedAttempts: 0,
  pushedAt: T0,
  pushTargets: 2,
  pushDelivered: 2,
  ...patch,
});

/** 模拟一次 `/config-check` 成功响应。 */
const configCheck = (rescue?: AmsgRescueReport) => ({ success: true, data: { ok: true, workerVersion: 'x', ...(rescue ? { rescue } : {}) } });

beforeEach(() => {
  localStorage.clear();
  resetRescueAlertMemoryForTest();
  setRescueAlertWorker(WORKER, T0);
});
afterEach(() => {
  localStorage.clear();
  resetRescueAlertMemoryForTest();
});

describe('救援警告：从 /config-check 记录并判断要不要弹', () => {
  it('开着 → 记下来并要求弹窗', () => {
    recordRescueFromConfigCheck(configCheck({ active: true, episode: episode() }), WORKER, T0);
    expect(getRescueAlertSnapshot().shouldAlert).toBe(true);
    expect(getRescueAlertSnapshot().due).toBe(true);
    expect(readRescueRecord(WORKER)?.report.episode?.id).toBe(String(T0));
  });

  it('老 Worker（没有 rescue 字段）→ 不记录、不弹、不报错', () => {
    recordRescueFromConfigCheck(configCheck(), WORKER, T0);
    expect(localStorage.getItem(AMSG_RESCUE_ALERT_LS_KEY)).toBeNull();
    expect(getRescueAlertSnapshot().shouldAlert).toBe(false);
    expect(getRescueAlertSnapshot().due).toBe(false);
  });

  it('从没开过（active=false、episode=null）→ 不弹', () => {
    recordRescueFromConfigCheck(configCheck({ active: false, episode: null }), WORKER, T0);
    expect(getRescueAlertSnapshot().shouldAlert).toBe(false);
  });

  /**
   * 回归守卫：能开救援模式的人也能删 D1 留痕、或者换回不报 rescue 的旧代码。
   * 本机副本必须粘住，Worker 报回空之后照样警告。
   */
  it('粘性：Worker 之后报回空留痕，7 天内照样警告', () => {
    recordRescueFromConfigCheck(configCheck({ active: true, episode: episode({ exportCount: 1, lastExportAt: T0 + 1000 }) }), WORKER, T0 + 1000);
    recordRescueFromConfigCheck(configCheck({ active: false, episode: null }), WORKER, T0 + DAY);
    const record = readRescueRecord(WORKER)!;
    expect(record.report.episode?.exportCount).toBe(1);
    expect(record.cloudRecordMismatch).toBe(true);
    expect(getRescueAlertSnapshot().shouldAlert).toBe(true);
  });

  it('粘性：换回老 Worker（不报 rescue）也不清掉本机副本', () => {
    recordRescueFromConfigCheck(configCheck({ active: true, episode: episode() }), WORKER, T0);
    recordRescueFromConfigCheck(configCheck(), WORKER, T0 + DAY);
    expect(readRescueRecord(WORKER)?.report.active).toBe(true);
    expect(getRescueAlertSnapshot().shouldAlert).toBe(true);
  });

  it('粘性：留痕从头到尾都读不到时，靠本机见过它开着的时刻算 7 天', () => {
    recordRescueFromConfigCheck(configCheck({ active: true, episode: null }), WORKER, T0);
    recordRescueFromConfigCheck(configCheck({ active: false, episode: null }), WORKER, T0 + DAY);
    setRescueAlertWorker(WORKER, T0 + 2 * DAY);
    expect(getRescueAlertSnapshot().shouldAlert).toBe(true);
  });

  it('同一段留痕里次数被改小 → 取较大值，标记对不上', () => {
    recordRescueFromConfigCheck(configCheck({ active: false, episode: episode({ exportCount: 3, itemReads: 40, endedAt: T0 + 5000 }) }), WORKER, T0 + 5000);
    recordRescueFromConfigCheck(configCheck({ active: false, episode: episode({ exportCount: 0, itemReads: 0, endedAt: T0 + 5000 }) }), WORKER, T0 + 6000);
    const record = readRescueRecord(WORKER)!;
    expect(record.report.episode?.exportCount).toBe(3);
    expect(record.report.episode?.itemReads).toBe(40);
    expect(record.cloudRecordMismatch).toBe(true);
  });

  it('Worker 换成更早的一段 → 不认，保留本机较新的那段', () => {
    const newer = episode({ id: String(T0 + DAY), firstSeenAt: T0 + DAY, lastSeenAt: T0 + DAY });
    recordRescueFromConfigCheck(configCheck({ active: true, episode: newer }), WORKER, T0 + DAY);
    recordRescueFromConfigCheck(configCheck({ active: false, episode: episode({ endedAt: T0 + 100 }) }), WORKER, T0 + DAY + 1000);
    expect(readRescueRecord(WORKER)?.report.episode?.id).toBe(String(T0 + DAY));
  });

  it('7 天过期后不再警告', () => {
    recordRescueFromConfigCheck(configCheck({ active: false, episode: episode({ endedAt: T0 + 1000 }) }), WORKER, T0 + 1000);
    setRescueAlertWorker(WORKER, T0 + 1000 + AMSG_RESCUE_ALERT_WINDOW_MS - 1);
    expect(getRescueAlertSnapshot().shouldAlert).toBe(true);
    setRescueAlertWorker(WORKER, T0 + 1000 + AMSG_RESCUE_ALERT_WINDOW_MS + 1);
    expect(getRescueAlertSnapshot().shouldAlert).toBe(false);
    expect(getRescueAlertSnapshot().due).toBe(false);
  });

  it('还开着的话，过了 7 天也继续警告', () => {
    recordRescueFromConfigCheck(configCheck({ active: true, episode: episode() }), WORKER, T0 + 10 * DAY);
    expect(getRescueAlertSnapshot().shouldAlert).toBe(true);
  });

  it('按 Worker 地址区分；尾斜杠、大小写不同也算同一台', () => {
    recordRescueFromConfigCheck(configCheck({ active: true, episode: episode() }), `${WORKER.toUpperCase()}/`, T0);
    expect(readRescueRecord(WORKER)).not.toBeNull();
    setRescueAlertWorker('https://other.example.workers.dev', T0);
    expect(getRescueAlertSnapshot().shouldAlert).toBe(false);
  });
});

describe('救援警告：确认之后什么时候重新弹', () => {
  it('确认后不再自动弹，但仍在窗口内（设置页常驻提示要显示）', () => {
    recordRescueFromConfigCheck(configCheck({ active: true, episode: episode() }), WORKER, T0);
    acknowledgeRescueAlert(T0 + 1);
    expect(getRescueAlertSnapshot().shouldAlert).toBe(false);
    expect(getRescueAlertSnapshot().due).toBe(true);
  });

  it('同一段里只是被关掉（endedAt 有了）→ 不重新弹', () => {
    recordRescueFromConfigCheck(configCheck({ active: true, episode: episode() }), WORKER, T0);
    acknowledgeRescueAlert(T0 + 1);
    recordRescueFromConfigCheck(configCheck({ active: false, episode: episode({ endedAt: T0 + 2000, lastSeenAt: T0 + 1000 }) }), WORKER, T0 + 2000);
    expect(getRescueAlertSnapshot().shouldAlert).toBe(false);
  });

  it('导出次数增加 → 重新弹', () => {
    recordRescueFromConfigCheck(configCheck({ active: true, episode: episode() }), WORKER, T0);
    acknowledgeRescueAlert(T0 + 1);
    recordRescueFromConfigCheck(configCheck({ active: true, episode: episode({ exportCount: 1, lastExportAt: T0 + 5000 }) }), WORKER, T0 + 5000);
    expect(getRescueAlertSnapshot().shouldAlert).toBe(true);
  });

  it('新开一段 → 重新弹', () => {
    recordRescueFromConfigCheck(configCheck({ active: false, episode: episode({ endedAt: T0 + 1000 }) }), WORKER, T0 + 1000);
    acknowledgeRescueAlert(T0 + 1001);
    const next = episode({ id: String(T0 + DAY), firstSeenAt: T0 + DAY, lastSeenAt: T0 + DAY });
    recordRescueFromConfigCheck(configCheck({ active: true, episode: next }), WORKER, T0 + DAY);
    expect(getRescueAlertSnapshot().shouldAlert).toBe(true);
  });

  it('设置页「查看详情」在确认过之后也能重新打开，确认后收起', () => {
    recordRescueFromConfigCheck(configCheck({ active: true, episode: episode() }), WORKER, T0);
    acknowledgeRescueAlert(T0 + 1);
    requestRescueAlertDetails(T0 + 2);
    expect(getRescueAlertSnapshot().detailsRequested).toBe(true);
    acknowledgeRescueAlert(T0 + 3);
    expect(getRescueAlertSnapshot().detailsRequested).toBe(false);
  });

  it('确认记录跨会话保留（存进 localStorage）', () => {
    recordRescueFromConfigCheck(configCheck({ active: true, episode: episode() }), WORKER, T0);
    acknowledgeRescueAlert(T0 + 1);
    resetRescueAlertMemoryForTest();
    setRescueAlertWorker(WORKER, T0 + 2);
    expect(getRescueAlertSnapshot().shouldAlert).toBe(false);
    expect(getRescueAlertSnapshot().due).toBe(true);
  });
});

describe('救援警告：只收到开启推送、没问到留痕', () => {
  it('也要弹；补收到的陈旧推送按账本时间算，过了 7 天就不弹', () => {
    recordRescuePushWithoutReport(WORKER, T0, T0 + 1000);
    expect(getRescueAlertSnapshot().shouldAlert).toBe(true);
    localStorage.clear();
    resetRescueAlertMemoryForTest();
    setRescueAlertWorker(WORKER, T0 + 10 * DAY);
    recordRescuePushWithoutReport(WORKER, T0, T0 + 10 * DAY);
    expect(getRescueAlertSnapshot().shouldAlert).toBe(false);
  });
});

describe('mergeRescueRecord', () => {
  it('incoming 为 null 时原样返回本机副本（包括 null）', () => {
    expect(mergeRescueRecord(null, null, T0)).toBeNull();
    const local: StoredRescueRecord = { report: { active: true, episode: episode() }, checkedAt: T0, lastActiveSeenAt: T0, cloudRecordMismatch: false, ackedKeys: [] };
    expect(mergeRescueRecord(local, null, T0 + 1)).toBe(local);
    expect(shouldShowRescueAlert(local, T0 + 1)).toBe(true);
  });
});

describe('救援警告：统计与存储边界', () => {
  it('统计属性只有写死的枚举值', () => {
    const record: StoredRescueRecord = {
      report: { active: true, episode: episode({ id: '<script>poison</script>', exportCount: 7 }) },
      checkedAt: T0, lastActiveSeenAt: T0, cloudRecordMismatch: true, ackedKeys: ['poison-ack'],
    };
    const allowed: Record<string, string[]> = {
      打开方式: ['自动', '设置页'],
      救援模式: ['仍开着', '已关闭'],
      导出过: ['是', '否'],
      云端留痕: ['一致', '对不上'],
    };
    for (const manual of [true, false]) {
      const data = buildRescueAlertAnalytics(record, manual);
      expect(Object.keys(data).sort()).toEqual(Object.keys(allowed).sort());
      for (const [key, value] of Object.entries(data)) expect(allowed[key]).toContain(value);
      expect(JSON.stringify(data)).not.toMatch(/poison|workers\.dev/);
    }
  });

  it('本机副本跨用户空间共用（2.0 后台连接是全局一份）', () => {
    expect(isSharedSpaceKey(AMSG_RESCUE_ALERT_LS_KEY)).toBe(true);
  });
});
