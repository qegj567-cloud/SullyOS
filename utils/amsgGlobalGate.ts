/**
 * 主动消息 2.0 全局总开关的零依赖判定叶子。
 *
 * 单独拆成纯函数模块是为了让存储层、客户端请求层、状态同步层、运行时轮询层都能直接引用，
 * 不引入模块环，也不改变已有测试对 activeMsgStore / amsgStateSync 的最小桩签名。
 */

/** 全局配置写盘后在浏览器内派发的同步事件，供设置页与见面租约实时感知总开关变化。 */
export const AMSG_GLOBAL_CONFIG_EVENT = 'amsg2-global-config-changed';

/** 云端 Cron 定时触发状态经客户端修改后派发的通知事件，供各设置入口同步刷新展示。 */
export const AMSG_CRON_TRIGGER_EVENT = 'amsg2-cron-trigger-changed';

/** 云端返回的定时触发状态是否明确处于「已暂停」（即支持查询且当前无 Cron 触发器）。 */
export const isCloudCronPaused = (
  state?: { supported?: boolean; enabled?: boolean } | null,
): boolean => Boolean(state && state.supported === true && state.enabled === false);

/** 总开关关闭时客户端统一抛出的错误码（非网络故障，不计入连接异常统计）。 */
export const AMSG_GLOBAL_DISABLED_CODE = 'AMSG_GLOBAL_DISABLED';

/**
 * 全局总开关是否开启。
 * 缺省（undefined）视为开启，存量已配置 Worker 的用户升级后行为不变；只有显式保存 false 才暂停。
 */
export const isAmsg2GloballyEnabled = (
  config?: { enabled?: boolean } | null,
): boolean => config?.enabled !== false;

/**
 * Worker 地址已填写且全局总开关处于开启状态。
 * 后台同步、上线补收、能力探测、在场心跳等自动请求路径统一以此为准。
 */
export const isAmsg2WorkerActive = (
  config?: { enabled?: boolean; workerUrl?: string | null } | null,
): boolean => Boolean(config?.workerUrl?.trim()) && isAmsg2GloballyEnabled(config);

export const createAmsgGlobalDisabledError = (): Error & { code: typeof AMSG_GLOBAL_DISABLED_CODE } =>
  Object.assign(
    new Error('主动消息 2.0 总开关已关闭，请先在设置中开启后再连接云端。'),
    { code: AMSG_GLOBAL_DISABLED_CODE as typeof AMSG_GLOBAL_DISABLED_CODE },
  );

export const isAmsgGlobalDisabledError = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === AMSG_GLOBAL_DISABLED_CODE;

/** 记录「云端 Cron 是被本机总开关暂停的」，用于恢复总开关或重连时自动加回定时触发，而不覆盖用户手动暂停的后台任务。 */
export const MASTER_PAUSED_CRON_LS_KEY = 'amsg2_master_paused_cron';

/** 记录「用户在维护面板显式手动暂停了后台任务」，区分手动暂停与跨设备总开关暂停。 */
export const MANUAL_PAUSED_CRON_LS_KEY = 'amsg2_manual_paused_cron';

export const readMasterPausedCron = (): boolean => {
  try {
    return localStorage.getItem(MASTER_PAUSED_CRON_LS_KEY) === '1';
  } catch {
    return false;
  }
};

export const writeMasterPausedCron = (paused: boolean): void => {
  try {
    if (paused) localStorage.setItem(MASTER_PAUSED_CRON_LS_KEY, '1');
    else localStorage.removeItem(MASTER_PAUSED_CRON_LS_KEY);
  } catch {
    // 隐私模式无法落盘时不阻塞开关本身
  }
};

export const readManualPausedCron = (): boolean => {
  try {
    return localStorage.getItem(MANUAL_PAUSED_CRON_LS_KEY) === '1';
  } catch {
    return false;
  }
};

export const writeManualPausedCron = (paused: boolean): void => {
  try {
    if (paused) localStorage.setItem(MANUAL_PAUSED_CRON_LS_KEY, '1');
    else localStorage.removeItem(MANUAL_PAUSED_CRON_LS_KEY);
  } catch {
    // 隐私模式无法落盘时不阻塞开关本身
  }
};

