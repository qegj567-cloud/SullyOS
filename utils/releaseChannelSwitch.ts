/**
 * 加入 / 退出 canary 的流程。设计见 docs/canary-channel.md。
 *
 * 顺序是刻意的：加入时先把 Worker 换成 canary 包、成功了才换前端；退出时 Worker 降级失败也照样退出。
 * 两种中间态都是「Worker 比前端新」，正是总纲「Worker 先部署」允许的方向。
 */
import { Capacitor } from '@capacitor/core';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { isAmsg2WorkerActive } from './amsgGlobalGate';
import {
  channelHomeUrl,
  describeCanaryJoinBlocker,
  writeChosenChannel,
  type CanaryJoinContext,
  type ReleaseChannel,
} from './releaseChannel';

/** 开着主动消息 2.0 且已经连上过 Worker 吗。 */
const isAmsgInUse = async (): Promise<boolean> => {
  try {
    const config = await ActiveMsgStore.getGlobalConfig();
    return isAmsg2WorkerActive(config) && Boolean(config.initializedAt);
  } catch {
    return false;
  }
};

/** 收集判断「能不能加入」要的信息。开着 2.0 时会探一次 Worker。 */
export const loadCanaryJoinContext = async (): Promise<CanaryJoinContext> => {
  const base = { hostname: globalThis.location?.hostname ?? '', native: Capacitor.isNativePlatform() };
  if (!await isAmsgInUse()) return { ...base, amsg: null };
  const probe = await ActiveMsgClient.probeWorkerVersion({ timeoutMs: 8000 });
  return {
    ...base,
    amsg: { selfUpdateSupported: probe.autoUpdate?.supported === true, workerChannel: probe.channel },
  };
};

export type ChannelSwitchResult = { ok: true } | { ok: false; message: string };

const goTo = (channel: ReleaseChannel): void => {
  writeChosenChannel(channel);
  globalThis.location.replace(channelHomeUrl(channel));
};

/**
 * 加入 canary。Worker 换不成 canary 包就不加入。
 * beforeRedirect 在真正跳走前调用并等它结束：埋点，以及让加入动画至少扫完一遍。
 */
export const joinCanary = async (beforeRedirect?: () => void | Promise<void>): Promise<ChannelSwitchResult> => {
  const context = await loadCanaryJoinContext();
  const blocker = describeCanaryJoinBlocker(context);
  if (blocker) return { ok: false, message: blocker };
  if (context.amsg) {
    const result = await ActiveMsgClient.selfUpdateWorker('canary').catch((error: Error) => ({
      ok: false as const, message: error?.message || '连不上 Worker。',
    }));
    if (!result.ok) return { ok: false, message: `Worker 没能换成 canary 版本，这次没有加入：${result.message}` };
  }
  await beforeRedirect?.();
  goTo('canary');
  return { ok: true };
};

/** 退出 canary。Worker 降级失败也照样退出：页面马上就跳走了，失败由正式版下次冷启动再对齐。 */
export type LeaveStage = 'checking' | 'worker' | 'opening';
export const leaveCanary = async (onStage: (stage: LeaveStage) => void, skipWait: AbortSignal): Promise<void> => {
  onStage('checking');
  // Skip only the wait, not the remote operation: the Worker may already be updating.
  // A late result must never trigger a second navigation.
  let skip!: () => void;
  const skipped = new Promise<void>(resolve => { skip = resolve; });
  skipWait.addEventListener('abort', skip, { once: true });
  if (skipWait.aborted) skip();
  try {
    const sync = async () => {
      if (skipWait.aborted || !await isAmsgInUse() || skipWait.aborted) return;
      onStage('worker');
      const result = await ActiveMsgClient.selfUpdateWorker('stable').catch(() => null);
      if (!result?.ok) console.warn('[canary] Worker 这次没能换回正式版，正式版冷启动时会再试', result?.message);
    };
    await Promise.race([sync(), skipped]);
  } finally {
    skipWait.removeEventListener('abort', skip);
  }
  onStage('opening');
  goTo('stable');
};
