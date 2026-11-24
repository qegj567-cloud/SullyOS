/**
 * 「云端生成」小条点开后的说明页，以及按功能的「本功能不再提醒」。
 *
 * 小条有两处来源：没有自己进度条的功能（日程）由 CloudGenIndicator 显示；人格模拟、梦境沿用
 * 各自的顶部胶囊，云端生成时改写文案。两处点开都调 openCloudGenSheet，说明页只有 PhoneShell
 * 上挂的那一份。不再提醒是这台设备上的偏好，按功能记，不进备份（见 types.ts 的 isCloudGenStorageKey）。
 */

import { trackCloudGenHint } from './analytics';
import { CLOUD_GEN_HINT_OFF_KEY, type CloudGenPurpose } from './types';

const readHintOff = (): CloudGenPurpose[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLOUD_GEN_HINT_OFF_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is CloudGenPurpose => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

/** 这个功能是不是已经选了「本功能不再提醒」。默认每个功能都提醒。 */
export const isCloudGenHintOff = (purpose: CloudGenPurpose): boolean => readHintOff().includes(purpose);

export const setCloudGenHintOff = (purpose: CloudGenPurpose, off: boolean): void => {
  const rest = readHintOff().filter((item) => item !== purpose);
  const next = off ? [...rest, purpose] : rest;
  try {
    if (next.length === 0) localStorage.removeItem(CLOUD_GEN_HINT_OFF_KEY);
    else localStorage.setItem(CLOUD_GEN_HINT_OFF_KEY, JSON.stringify(next));
  } catch { /* 存不下只是下次照样提醒 */ }
  notifySheet();
};

/** 说明页要显示哪个功能；notify = 这次完成时会不会发通知（决定说明页最后一句）。 */
export interface CloudGenSheetRequest {
  purpose: CloudGenPurpose;
  notify: boolean;
}

let current: CloudGenSheetRequest | null = null;
const listeners = new Set<(req: CloudGenSheetRequest | null) => void>();

function notifySheet() {
  for (const cb of listeners) { try { cb(current); } catch { /* 一个订阅者出错不连累别的 */ } }
}

// 只有用户点小条时才调它，「点开说明」就记在这一个口子上。
export const openCloudGenSheet = (req: CloudGenSheetRequest): void => {
  current = req;
  notifySheet();
  trackCloudGenHint(req.purpose, 'open');
};
export const closeCloudGenSheet = (): void => { current = null; notifySheet(); };
export const getCloudGenSheet = (): CloudGenSheetRequest | null => current;

/** 订阅说明页的开关；不再提醒的设置变了也会通知一次，方便小条跟着收起。 */
export const subscribeCloudGenSheet = (cb: (req: CloudGenSheetRequest | null) => void): (() => void) => {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
};
