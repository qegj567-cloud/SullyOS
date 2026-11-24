/**
 * 已落地、还没被用户打开的代跑结果，按功能 + 角色各存一份。
 *
 * 有的功能生成完不直接写库，要等用户打开看完才写（梦境：播完才进 dreamLogs）。云端结果可能在
 * 页面关着、重开之后才到，内存里的进度 store 早没了，所以落地函数先把结果放在这里，入口打开时取走。
 * 这是这台设备上的临时数据，不进备份（见 types.ts 的 isCloudGenStorageKey）。
 */

import { CLOUD_GEN_PENDING_PREFIX, type CloudGenPurpose } from './types';

const keyOf = (purpose: CloudGenPurpose, charId: string) => `${CLOUD_GEN_PENDING_PREFIX}${purpose}:${charId}`;

export const readCloudGenPending = <T>(purpose: CloudGenPurpose, charId: string): T | null => {
  try {
    const raw = localStorage.getItem(keyOf(purpose, charId));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

/** 写不进去时抛出，让落地函数报失败、结果留在收件箱等下次再落，而不是悄悄丢掉。 */
export const writeCloudGenPending = (purpose: CloudGenPurpose, charId: string, value: unknown): void => {
  localStorage.setItem(keyOf(purpose, charId), JSON.stringify(value));
};

export const clearCloudGenPending = (purpose: CloudGenPurpose, charId: string): void => {
  try { localStorage.removeItem(keyOf(purpose, charId)); } catch { /* 清不掉下次再清 */ }
};
