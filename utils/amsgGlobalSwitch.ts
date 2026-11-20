import type { APIConfig, CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../types';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { catchUpMissedPushes, pauseActiveMsgRuntime, refreshPushSubscriptionIfMarked } from './activeMsgRuntime';
import { flushPendingCloudRetirements } from './amsgCloudRetirement';
import { isAmsg2WorkerActive, readMasterPausedCron, writeMasterPausedCron } from './amsgGlobalGate';
import { abortAllInstantChatPendingsLocally, resetInstantChatReprobeCooldown } from './amsgInstantChat';
import { AMSG_OWNER_CONFLICT_EVENT } from './amsgOwnerReconcile';
import {
  AMSG2_PENDING_TOOL_CONFIG_LS_KEY,
  flushAmsgState,
  pauseAmsgStateSync,
  resumePendingAmsgStateSync,
  syncAmsgToolConfig,
} from './amsgStateSync';

export interface AmsgGlobalSwitchScope {
  characters?: CharacterProfile[];
  userProfile?: UserProfile;
  groups?: GroupProfile[];
  realtimeConfig?: RealtimeConfig;
  apiConfig?: APIConfig;
}

export interface AmsgGlobalToggleResult {
  enabled: boolean;
  cronPaused?: boolean;
  cronResumed?: boolean;
  cronNotice?: string;
}

let switchEpoch = 0;
let cronTransitionQueue: Promise<unknown> = Promise.resolve();

const enqueueCronTransition = <T>(step: () => Promise<T>): Promise<T> => {
  const next = cronTransitionQueue.then(step, step);
  cronTransitionQueue = next.catch(() => {});
  return next;
};

/**
 * 恢复连接或开启总开关后的统一后台补送：
 * 冲刷暂停期间积压的待停用角色、推送订阅变更标记、云端漏收账本，以及仅在本地打过脏的快照与凭据。
 * 不做全量无条件重传，避免普通开关切换重算并上传全部角色的上下文包。
 */
export async function flushAmsg2AfterReenable(scope?: AmsgGlobalSwitchScope): Promise<void> {
  resetInstantChatReprobeCooldown();
  const current = await ActiveMsgStore.getGlobalConfig();
  if (!isAmsg2WorkerActive(current)) return;

  await flushPendingCloudRetirements();
  await refreshPushSubscriptionIfMarked();
  await catchUpMissedPushes('startup');

  if (scope?.characters && scope.userProfile && scope.groups) {
    resumePendingAmsgStateSync({
      characters: scope.characters,
      userProfile: scope.userProfile,
      groups: scope.groups,
      realtimeConfig: scope.realtimeConfig,
      apiConfig: scope.apiConfig,
    });
    void flushAmsgState('global-reenable');
  } else if (scope?.realtimeConfig !== undefined) {
    let toolPending = false;
    try {
      toolPending = localStorage.getItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY) === '1';
    } catch {
      toolPending = false;
    }
    if (toolPending) syncAmsgToolConfig(scope.realtimeConfig);
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AMSG_OWNER_CONFLICT_EVENT));
  }
}

/**
 * 保留已存连接与角色配置的「主动消息 2.0」全局总开关。
 *
 * 关闭时先在本机切断全部轮询、活跃租约、状态同步队列与在途即时对话等待，并立即落盘 `enabled: false`；
 * 对已配置 Worker 的环境，再按序以短超时尽力通知云端取消在途即时任务并摘掉 Cron 定时触发。
 * 若用户在高级面板里原本就手动暂停了后台任务，总开关不会覆盖该手动暂停标记。
 * 无论 Worker 是否在线、是否具备 `CF_API_TOKEN`，本机暂停都立即成功，绝不因远端失联卡死或抛错。
 *
 * 重新开启时先落盘 `enabled: true` 并重置探测冷却，按序尽力恢复由总开关暂停的 Cron 定时触发，
 * 再在后台冲刷暂停期间攒下的待停用角色、订阅变化标记、云端账本漏收消息以及本地脏快照。
 */
export async function setAmsg2GlobalEnabled(
  enabled: boolean,
  scope?: AmsgGlobalSwitchScope,
): Promise<AmsgGlobalToggleResult> {
  const myEpoch = ++switchEpoch;

  if (!enabled) {
    const pendingUuids = await abortAllInstantChatPendingsLocally();
    pauseAmsgStateSync();
    pauseActiveMsgRuntime();
    const config = await ActiveMsgStore.saveGlobalConfig({ enabled: false });
    ActiveMsgClient.resetSessionCache();

    if (!config.workerUrl?.trim()) {
      writeMasterPausedCron(false);
      return { enabled: false };
    }

    if (pendingUuids.length > 0 && myEpoch === switchEpoch) {
      void Promise.allSettled(
        pendingUuids.map((uuid) =>
          ActiveMsgClient.cancelTask(uuid, { allowWhenDisabled: true, timeoutMs: 4_000 }),
        ),
      );
    }

    return enqueueCronTransition(async (): Promise<AmsgGlobalToggleResult> => {
      if (myEpoch !== switchEpoch) {
        return { enabled: false };
      }

      const priorCron = await ActiveMsgClient.getCronTriggerState({
        allowWhenDisabled: true,
        timeoutMs: 3_000,
      });
      if (myEpoch !== switchEpoch) {
        return { enabled: false };
      }
      // 用户此前已在面板中手动暂停过后台任务时，保留手动暂停原状，避免总开关恢复时误把后台任务重新打开。
      if (priorCron?.supported && priorCron.enabled === false) {
        return { enabled: false, cronPaused: true };
      }

      try {
        const cronRes = await ActiveMsgClient.setCronTriggerEnabled(false, {
          allowWhenDisabled: true,
          timeoutMs: 5_000,
        });
        if (cronRes.ok) {
          if (myEpoch === switchEpoch) writeMasterPausedCron(true);
          return { enabled: false, cronPaused: true };
        }
        if (cronRes.code === 'CF_TOKEN_MISSING' || cronRes.code === 'NOT_FOUND') {
          if (myEpoch === switchEpoch) writeMasterPausedCron(false);
        } else if (myEpoch === switchEpoch) {
          writeMasterPausedCron(true);
        }
        return {
          enabled: false,
          cronPaused: false,
          cronNotice: '本机已暂停所有云端连接；未能通知 Worker 暂停定时触发，云端已排任务可能仍会按原计划运行。',
        };
      } catch {
        if (myEpoch === switchEpoch) writeMasterPausedCron(true);
        return {
          enabled: false,
          cronPaused: false,
          cronNotice: '本机已暂停所有云端连接；未能连上 Worker 暂停定时触发，云端已排任务可能仍会按原计划运行。',
        };
      }
    });
  }

  const config = await ActiveMsgStore.saveGlobalConfig({ enabled: true });
  ActiveMsgClient.resetSessionCache();
  resetInstantChatReprobeCooldown();

  if (!config.workerUrl?.trim()) {
    writeMasterPausedCron(false);
    return { enabled: true };
  }

  const cronOutcome = await enqueueCronTransition(async (): Promise<{
    cronResumed?: boolean;
    cronNotice?: string;
  }> => {
    if (myEpoch !== switchEpoch) {
      return {};
    }
    const shouldResumeCron = readMasterPausedCron();
    if (shouldResumeCron && config.initializedAt) {
      try {
        const cronRes = await ActiveMsgClient.setCronTriggerEnabled(true, { timeoutMs: 6_000 });
        if (cronRes.ok) {
          if (myEpoch === switchEpoch) writeMasterPausedCron(false);
          return { cronResumed: true };
        }
        if (cronRes.code === 'CF_TOKEN_MISSING' || cronRes.code === 'NOT_FOUND') {
          if (myEpoch === switchEpoch) writeMasterPausedCron(false);
          return {};
        }
        return {
          cronResumed: false,
          cronNotice: '本机云端连接已恢复，但未能自动恢复 Worker 定时触发，可在配置面板里点「恢复后台任务」。',
        };
      } catch {
        return {
          cronResumed: false,
          cronNotice: '本机云端连接已恢复，但暂时连不上 Worker 恢复定时触发，稍后可在配置面板里检查。',
        };
      }
    }
    if (!config.initializedAt && myEpoch === switchEpoch) {
      writeMasterPausedCron(false);
    }
    return {};
  });

  if (myEpoch === switchEpoch) {
    void flushAmsg2AfterReenable(scope);
  }

  return { enabled: true, ...cronOutcome };
}
