/**
 * 云端生成按功能的开关（存在主动消息 2.0 全局配置的 `cloudGen` 上，随备份走）。
 * 缺省值见 CLOUD_GEN_PURPOSE_META。
 */

import type { ActiveMsg2GlobalConfig } from '../../types';
import { CLOUD_GEN_PURPOSE_META, type CloudGenPurpose } from './types';

export interface CloudGenFeatureSwitches {
  /** 这个功能交不交云端生成。 */
  enabled: boolean;
  /** 云端生成完成时弹不弹通知。 */
  notify: boolean;
}

/** 从一份全局配置里取开关（同步，界面渲染用）。 */
export const resolveCloudGenFeatureSwitches = (
  config: Pick<ActiveMsg2GlobalConfig, 'cloudGen'> | null | undefined,
  purpose: CloudGenPurpose,
): CloudGenFeatureSwitches => {
  const saved = config?.cloudGen?.[purpose];
  return {
    enabled: saved?.enabled ?? true,
    notify: saved?.notify ?? CLOUD_GEN_PURPOSE_META[purpose].defaultNotify,
  };
};

/** 读当前保存的开关；配置读不出来时按缺省值。 */
export const getCloudGenFeatureSwitches = async (purpose: CloudGenPurpose): Promise<CloudGenFeatureSwitches> => {
  try {
    const { ActiveMsgStore } = await import('../activeMsgStore');
    return resolveCloudGenFeatureSwitches(await ActiveMsgStore.getGlobalConfig(), purpose);
  } catch {
    return resolveCloudGenFeatureSwitches(null, purpose);
  }
};
