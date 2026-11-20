import type { APIConfig, CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../types';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { catchUpMissedPushes, pauseActiveMsgRuntime, refreshPushSubscriptionIfMarked } from './activeMsgRuntime';
import { flushPendingCloudRetirements } from './amsgCloudRetirement';
import {
  isAmsg2GloballyEnabled,
  isAmsg2WorkerActive,
  readManualPausedCron,
  readMasterPausedCron,
  writeManualPausedCron,
  writeMasterPausedCron,
} from './amsgGlobalGate';
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
  ok: boolean;
  enabled: boolean;
  cronPaused?: boolean;
  cronResumed?: boolean;
  cronNotice?: string;
  errorMessage?: string;
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
 * 重新开启时先向云端查询定时触发实际状态；若云端定时触发处于暂停态（非用户手动在维护面板暂停），
 * 必须确认云端恢复成功才落盘 `enabled: true` 并冲刷待同步项。网络波动或云端恢复失败时保持关闭态并明确报错，
 * 避免界面显示已开启而云端定时触发实际停摆。
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
      return { ok: true, enabled: false };
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
        return { ok: true, enabled: false };
      }

      const priorCron = await ActiveMsgClient.getCronTriggerState({
        allowWhenDisabled: true,
        timeoutMs: 3_000,
      });
      if (myEpoch !== switchEpoch) {
        return { ok: true, enabled: false };
      }
      // 用户此前已在维护面板手动暂停过后台任务时，记录并保留手动暂停原状，避免总开关恢复时误将其重新打开。
      if (priorCron?.supported && priorCron.enabled === false) {
        if (!readMasterPausedCron()) writeManualPausedCron(true);
        return { ok: true, enabled: false, cronPaused: true };
      }

      try {
        const cronRes = await ActiveMsgClient.setCronTriggerEnabled(false, {
          allowWhenDisabled: true,
          timeoutMs: 5_000,
          source: 'master',
        });
        if (cronRes.ok) {
          // 云端定时触发已由总开关实际摘除：即使请求在途期间用户又连点了开启，也必须记下标记，
          // 紧随其后排在同一队列里的开启步骤才能据此把触发器加回。
          writeMasterPausedCron(true);
          writeManualPausedCron(false);
          return { ok: true, enabled: false, cronPaused: true };
        }
        // Worker 明确返回失败（如缺 CF_API_TOKEN、旧版 404 或 CF 写入报错）时，云端定时触发保持原样未动。
        writeMasterPausedCron(false);
        return {
          ok: true,
          enabled: false,
          cronPaused: false,
          cronNotice: '本机已暂停所有云端连接；未能通知 Worker 暂停定时触发，云端已排任务可能仍会按原计划运行。',
        };
      } catch {
        // 网络层超时或断连无法确认请求是否已到达服务端，按可能已暂停记账，恢复时向云端核实。
        writeMasterPausedCron(true);
        return {
          ok: true,
          enabled: false,
          cronPaused: false,
          cronNotice: '本机已暂停所有云端连接；未能连上 Worker 暂停定时触发，云端已排任务可能仍会按原计划运行。',
        };
      }
    });
  }

  const initialConfig = await ActiveMsgStore.getGlobalConfig();
  if (!initialConfig.workerUrl?.trim()) {
    await ActiveMsgStore.saveGlobalConfig({ enabled: true });
    ActiveMsgClient.resetSessionCache();
    resetInstantChatReprobeCooldown();
    writeMasterPausedCron(false);
    return { ok: true, enabled: true };
  }

  const outcome = await enqueueCronTransition(async (): Promise<AmsgGlobalToggleResult> => {
    const current = await ActiveMsgStore.getGlobalConfig();
    if (myEpoch !== switchEpoch) {
      return { ok: false, enabled: isAmsg2GloballyEnabled(current) };
    }
    if (!current.workerUrl?.trim()) {
      await ActiveMsgStore.saveGlobalConfig({ enabled: true });
      ActiveMsgClient.resetSessionCache();
      resetInstantChatReprobeCooldown();
      writeMasterPausedCron(false);
      return { ok: true, enabled: true };
    }

    let cronResumed = false;
    if (current.initializedAt) {
      let cloudCron: Awaited<ReturnType<typeof ActiveMsgClient.getCronTriggerState>>;
      try {
        cloudCron = await ActiveMsgClient.getCronTriggerState({
          allowWhenDisabled: true,
          timeoutMs: 8_000,
          throwOnNetworkError: true,
        });
      } catch {
        return {
          ok: false,
          enabled: false,
          errorMessage: '网络波动，未能连上云端确认后台状态，主动消息 2.0 未成功开启，请稍后重试。',
        };
      }

      if (myEpoch !== switchEpoch) {
        const latest = await ActiveMsgStore.getGlobalConfig();
        return { ok: false, enabled: isAmsg2GloballyEnabled(latest) };
      }

      if (cloudCron && !cloudCron.supported && (cloudCron.code === 'UNAUTHORIZED' || cloudCron.code === 'SERVER_TOKEN_REQUIRED')) {
        return {
          ok: false,
          enabled: false,
          errorMessage: `未能通过云端验证（${cloudCron.message || '共享密钥不匹配'}），主动消息 2.0 未成功开启，请检查后台连接设置。`,
        };
      }

      if (cloudCron?.supported && cloudCron.enabled === true) {
        writeMasterPausedCron(false);
        writeManualPausedCron(false);
      } else if (cloudCron?.supported && cloudCron.enabled === false) {
        const keepManualPause = readManualPausedCron() && !readMasterPausedCron();
        if (!keepManualPause) {
          try {
            const cronRes = await ActiveMsgClient.setCronTriggerEnabled(true, {
              allowWhenDisabled: true,
              timeoutMs: 10_000,
              source: 'master',
            });
            if (cronRes.ok) {
              cronResumed = true;
            } else if (cronRes.code === 'CF_TOKEN_MISSING' || cronRes.code === 'NOT_FOUND') {
              writeMasterPausedCron(false);
            } else {
              return {
                ok: false,
                enabled: false,
                errorMessage: `未能恢复云端后台定时触发（${cronRes.message}），主动消息 2.0 未成功开启，请稍后重试。`,
              };
            }
          } catch {
            return {
              ok: false,
              enabled: false,
              errorMessage: '网络波动，未能连上云端恢复后台定时触发，主动消息 2.0 未成功开启，请稍后重试。',
            };
          }
        }
      } else {
        if (readMasterPausedCron() && cloudCron?.code === 'CF_ERROR') {
          return {
            ok: false,
            enabled: false,
            errorMessage: `未能确认并恢复云端后台定时触发（${cloudCron.message || 'Cloudflare 接口异常'}），主动消息 2.0 未成功开启，请稍后重试。`,
          };
        }
        writeMasterPausedCron(false);
      }
    } else {
      writeMasterPausedCron(false);
    }

    if (myEpoch !== switchEpoch) {
      const latest = await ActiveMsgStore.getGlobalConfig();
      return { ok: false, enabled: isAmsg2GloballyEnabled(latest) };
    }

    await ActiveMsgStore.saveGlobalConfig({ enabled: true });
    ActiveMsgClient.resetSessionCache();
    resetInstantChatReprobeCooldown();
    return {
      ok: true,
      enabled: true,
      ...(cronResumed ? { cronResumed: true } : {}),
    };
  });

  if (outcome.ok && myEpoch === switchEpoch) {
    void flushAmsg2AfterReenable(scope);
  }

  return outcome;
}
