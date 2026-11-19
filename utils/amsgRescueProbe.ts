/**
 * 主动消息 2.0「救援模式」的探测时机：什么时候去问 Worker 一次 `GET /config-check`。
 *
 *   - App 冷启动：只要 2.0 Worker 已连接就问一次。不跟冷启动那次「催后端更新」共用 6 小时
 *     节流——更新晚几小时无所谓，安全警告晚几小时就是让人多蒙在鼓里几小时。
 *   - 页面回到前台、且距上次问到超过 30 分钟：再问一次。
 *   - 收到 Worker「救援模式已开启」的推送：立刻问一次（见 utils/amsgResults.ts）。
 *   - 其它代码顺路拿到 /config-check 成功响应时，activeMsgClient 的集中记录点也会顺手并进来。
 *
 * 请求本身借用 ActiveMsgClient.probeWorkerVersion：它打的就是 /config-check，成功时经
 * rememberWorkerBundleVersion 调 recordRescueFromConfigCheck 把 rescue 段记下来。这里不另开
 * 一条请求路径，鉴权、中转、超时都跟着它走。
 *
 * 总开关关着时不发请求（总开关的约定是切断全部自动请求），但本机已有的副本照样警告。
 */

import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { isAmsg2WorkerActive } from './amsgGlobalGate';
import {
  getRescueLastRecordedAt,
  recordRescuePushWithoutReport,
  refreshRescueAlertSnapshot,
  setRescueAlertWorker,
} from './amsgRescueAlert';

/** 回到前台时，离上次问到（或上次尝试）超过这么久才再问。 */
export const RESCUE_FOREGROUND_PROBE_INTERVAL_MS = 30 * 60_000;

/** 单次探测的超时；推送那条腿在结果分发队列里等它，不能拖太久。 */
const RESCUE_PROBE_TIMEOUT_MS = 10_000;

let lastProbeStartedAt = 0;
let probing: Promise<boolean> | null = null;

/**
 * 读当前配置、同步给警告模块，并告诉调用方能不能发请求。
 * 返回 null = 没填 Worker 地址；canProbe = 已连接且总开关开着。
 */
const loadWorkerState = async (): Promise<{ workerUrl: string; canProbe: boolean } | null> => {
  try {
    const config = await ActiveMsgStore.getGlobalConfig();
    const workerUrl = config.workerUrl?.trim() ?? '';
    setRescueAlertWorker(workerUrl);
    if (!workerUrl) return null;
    return { workerUrl, canProbe: isAmsg2WorkerActive(config) && Boolean(config.initializedAt) };
  } catch {
    return null;
  }
};

/**
 * 去问一次。返回这次是否真的拿到并记下了 rescue 段（老 Worker、断网、超时都是 false）。
 * 并发调用合并成一次。
 */
export const probeRescueReport = async (nowMs = Date.now()): Promise<boolean> => {
  if (probing) return probing;
  probing = (async () => {
    const state = await loadWorkerState();
    if (!state?.canProbe) return false;
    lastProbeStartedAt = nowMs;
    const before = getRescueLastRecordedAt();
    try {
      await ActiveMsgClient.probeWorkerVersion({ timeoutMs: RESCUE_PROBE_TIMEOUT_MS });
    } catch {
      return false;
    }
    return getRescueLastRecordedAt() !== before;
  })();
  try {
    return await probing;
  } finally {
    probing = null;
  }
};

/** 冷启动那一下：本机副本先亮出来（断网也能警告），再去问。 */
export const probeRescueOnStartup = async (): Promise<boolean> => probeRescueReport();

/** 回到前台：先按当前时间重算（7 天窗口可能刚过），够久了再问。 */
export const probeRescueOnForeground = async (nowMs = Date.now()): Promise<boolean> => {
  refreshRescueAlertSnapshot(nowMs);
  const last = Math.max(lastProbeStartedAt, getRescueLastRecordedAt());
  if (nowMs - last < RESCUE_FOREGROUND_PROBE_INTERVAL_MS) return false;
  return probeRescueReport(nowMs);
};

/**
 * 收到「救援模式已开启」推送时调。先问 Worker；问不到（断网、Worker 太忙）也至少记下
 * 「那个时刻它开着」，警告照样弹，等下次问到再补全细节。
 *
 * @param seenAt 推送发出的时刻（补收那条腿传账本时间），过期的推送会被 7 天窗口自然挡掉。
 */
export const handleRescuePush = async (seenAt: number, nowMs = Date.now()): Promise<void> => {
  const recorded = await probeRescueReport(nowMs);
  if (recorded) return;
  const state = await loadWorkerState();
  if (state) recordRescuePushWithoutReport(state.workerUrl, seenAt, nowMs);
};

/** 只给测试用。 */
export const resetRescueProbeForTest = (): void => {
  lastProbeStartedAt = 0;
  probing = null;
};
