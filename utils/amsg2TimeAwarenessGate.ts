/**
 * 主动消息 2.0 与「聊天 · 时间感知强化」开关的互斥门禁及停用清理。
 *
 * 主动消息 2.0 基于现实时间（或角色时区）定时触发、读取当日作息并安排后续联系，无法跟随
 * 架空剧情里的虚拟时间推进。关闭「聊天 · 时间感知强化」时默认应同步停用 2.0；只有用户显式点击
 * 「我知道自己在做什么」确认已知时间错乱风险，才写入 allowWithoutTimeAwareness 放行。
 */

import type { ActiveMsg2CharacterConfig, ActiveMsg2TaskRecord, CharacterProfile } from '../types';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { disableScheduleCharPurge, purgeCharCloudState } from './amsg2CharCleanup';
import { buildUserCancelledNotices } from './amsg2TaskContext';
import { isAmsg2EnabledForChar, keepUncancelledTasks } from './amsg2Tasks';
import { isAmsg2GloballyEnabled, isAmsg2WorkerActive } from './amsgGlobalGate';
import { isInstantChatReady } from './amsgInstantChat';
import { pickPacingSettings } from './amsgLimits';

/** 角色的聊天时间感知是否已显式关闭。 */
export const isChatTimeAwarenessOff = (
  char: Pick<CharacterProfile, 'timeAwarenessEnabled'>,
): boolean => char.timeAwarenessEnabled === false;

/**
 * 在主动消息 2.0 面板里尝试开启（或检查存量已开启状态）时，是否需要用户先确认时间错乱风险。
 *
 * 只要聊天时间感知关着、且当前配置尚未记录过显式确认，就需要拦截并要求用户确认。
 */
export const needsAmsg2TimeAwarenessOverride = (
  char: Pick<CharacterProfile, 'timeAwarenessEnabled' | 'activeMsg2Config'>,
): boolean =>
  isChatTimeAwarenessOff(char) && char.activeMsg2Config?.allowWithoutTimeAwareness !== true;

/**
 * 在神经链接把「聊天 · 时间感知强化」从开启拨为关闭时，是否需要弹窗提示停用主动消息 2.0。
 *
 * 只要该角色当前启用了主动消息 2.0，关闭时间感知时就默认引导一并停用（除非当场点击保留覆盖）。
 */
export const shouldPromptDisableAmsg2OnTimeAwarenessOff = (
  char: Pick<CharacterProfile, 'timeAwarenessEnabled' | 'activeMsg2Config'>,
): boolean =>
  !isChatTimeAwarenessOff(char) && isAmsg2EnabledForChar(char as CharacterProfile);

/** 恢复开启聊天时间感知时清掉旧的覆盖确认，确保日后再次关闭时间感知时重新提示。 */
export const clearTimeAwarenessOverride = (
  prev: ActiveMsg2CharacterConfig | undefined,
): ActiveMsg2CharacterConfig | undefined => {
  if (!prev || prev.allowWithoutTimeAwareness === undefined) return prev;
  const next = { ...prev };
  delete next.allowWithoutTimeAwareness;
  return next;
};

export interface DisableCharacterAmsg2Options {
  /**
   * 已知的远端连接状态；面板已有探测结果时可直接传入，神经链接等外部入口不传则内部现查。
   */
  globalState?: {
    globalReady: boolean;
    globalPaused: boolean;
    globalInstantChatOn: boolean;
  };
  /** 面板中尚未落盘的即时对话开关状态；不传则读角色已保存配置。 */
  instantChatEnabled?: boolean;
}

export interface DisableCharacterAmsg2Result {
  globalReady: boolean;
  globalPaused: boolean;
  failedCount: number;
  cleanupFailed: boolean;
  toastMessage: string;
  toastType: 'info' | 'error';
  /**
   * 将停用结果应用到最新 prev 配置上的纯函数更新器（清除 allowWithoutTimeAwareness，
   * 保留远端取消失败或期间新出现的任务供后续重试，避免造出看不见的幽灵任务）。
   */
  applyToConfig: (
    prev: ActiveMsg2CharacterConfig | undefined,
    overrides?: Partial<ActiveMsg2CharacterConfig>,
  ) => ActiveMsg2CharacterConfig;
}

const buildDisabledBaseConfig = (
  prev: ActiveMsg2CharacterConfig | undefined,
  tasksOf: (prevTasks: ActiveMsg2TaskRecord[]) => ActiveMsg2TaskRecord[],
  overrides?: Partial<ActiveMsg2CharacterConfig>,
): ActiveMsg2CharacterConfig => {
  const next: ActiveMsg2CharacterConfig = {
    enabled: false,
    tasks: tasksOf(prev?.tasks ?? []),
    ...pickPacingSettings(prev),
    instantChatEnabled: prev?.instantChatEnabled,
    lastSyncedAt: prev?.lastSyncedAt,
    ...overrides,
  };
  delete next.allowWithoutTimeAwareness;
  return next;
};

/**
 * 停用单个角色的主动消息 2.0：先通知云端关闸，再取消该角色名下全部远端排期、写取消回执、
 * 按即时对话存活状态清理云端快照，最后返回函数式配置更新器。
 *
 * 聊天面板「关闭 2.0」与神经链接「关闭时间感知并停用 2.0」共用这一条路径，防止外部入口只改
 * 本地 enabled:false 而把已排任务留在 Worker D1 里继续到点推送。
 */
export const disableCharacterAmsg2Schedule = async (
  char: CharacterProfile,
  options: DisableCharacterAmsg2Options = {},
): Promise<DisableCharacterAmsg2Result> => {
  let globalReady: boolean;
  let globalPaused: boolean;
  let globalInstantChatOn: boolean;

  if (options.globalState) {
    ({ globalReady, globalPaused, globalInstantChatOn } = options.globalState);
  } else {
    const [globalConfig, instantReady] = await Promise.all([
      ActiveMsgClient.getGlobalConfig(),
      isInstantChatReady().catch(() => false),
    ]);
    globalReady = isAmsg2WorkerActive(globalConfig);
    globalPaused = Boolean(globalConfig.workerUrl?.trim()) && !isAmsg2GloballyEnabled(globalConfig);
    globalInstantChatOn = instantReady;
  }

  const instantChatOn = options.instantChatEnabled ?? (char.activeMsg2Config?.instantChatEnabled !== false);
  const tasks = char.activeMsg2Config?.tasks ?? [];

  if (!globalReady) {
    return {
      globalReady: false,
      globalPaused,
      failedCount: 0,
      cleanupFailed: false,
      toastMessage: globalPaused
        ? '本机已记录关闭；当前全局总开关处于暂停状态，远端任务将在恢复总开关后重开面板时清理。'
        : '主动消息 2.0 已关闭。',
      toastType: 'info',
      applyToConfig: (prev, overrides) => buildDisabledBaseConfig(prev, (list) => list, {
        ...overrides,
        enabled: false,
      }),
    };
  }

  try {
    await ActiveMsgClient.putCharLimits({
      ...char,
      activeMsg2Config: { ...(char.activeMsg2Config ?? { enabled: false }), enabled: false },
    });
  } catch (error) {
    console.warn('[ActiveMsg2] 关闭 2.0 时没能先通知云端（照常取消任务）', error);
  }

  const { targets, failed } = await ActiveMsgClient.cancelAllTasksForChar(
    char.id,
    tasks.map((t) => t.taskUuid),
  );
  const attempted = new Set(targets);

  const cancelledNotices = buildUserCancelledNotices(
    char.id,
    tasks.filter((t) => attempted.has(t.taskUuid) && !failed.has(t.taskUuid)),
    Date.now(),
  );
  if (cancelledNotices.length > 0) {
    try {
      await ActiveMsgStore.upsertExpiredNotices(char.id, cancelledNotices);
    } catch (error) {
      console.warn('[ActiveMsg2] 取消回执写入失败（角色可能还以为约定有效）', error);
    }
  }

  const cleanup = await purgeCharCloudState(
    char,
    disableScheduleCharPurge(globalInstantChatOn && instantChatOn),
  );
  const cleanupFailed = cleanup.status === 'failed';
  if (cleanupFailed) {
    console.warn('[ActiveMsg2] 关闭 2.0 时清云端上下文失败', cleanup.error);
  }

  const now = Date.now();
  return {
    globalReady: true,
    globalPaused,
    failedCount: failed.size,
    cleanupFailed,
    toastMessage: failed.size
      ? `主动消息 2.0 已关闭，但有 ${failed.size} 个任务远端取消失败，请稍后重开面板重试。`
      : '主动消息 2.0 已关闭，全部任务已取消。',
    toastType: failed.size ? 'error' : 'info',
    applyToConfig: (prev, overrides) => buildDisabledBaseConfig(
      prev,
      (list) => keepUncancelledTasks(list, attempted, failed, {
        failed: '关闭时远端取消失败，可重试',
        appeared: '关闭主动消息时新出现，未被取消，请单独处理',
      }),
      {
        ...overrides,
        enabled: false,
        lastSyncedAt: now,
      },
    ),
  };
};
