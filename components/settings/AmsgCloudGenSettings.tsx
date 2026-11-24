import React, { useEffect, useState } from 'react';
import type { ActiveMsg2GlobalConfig } from '../../types';
import { CLOUD_GEN_PURPOSES, CLOUD_GEN_PURPOSE_META, type CloudGenPurpose } from '../../utils/cloudGen/types';
import { resolveCloudGenFeatureSwitches, type CloudGenFeatureSwitches } from '../../utils/cloudGen/settings';
import { isCloudGenHintOff, setCloudGenHintOff, subscribeCloudGenSheet } from '../../utils/cloudGen/hint';

export type CloudGenConfig = NonNullable<ActiveMsg2GlobalConfig['cloudGen']>;

/** 改一个功能的一个开关，其余功能原样带上：saveGlobalConfig 只做浅合并，`cloudGen` 得整份写回。 */
export const mergeCloudGenSwitch = (
  saved: ActiveMsg2GlobalConfig['cloudGen'],
  purpose: CloudGenPurpose,
  patch: Partial<CloudGenFeatureSwitches>,
): CloudGenConfig => ({ ...saved, [purpose]: { ...saved?.[purpose], ...patch } });

/** 在页面里定位开关用的 id（功能总览的能力表点行时跳过来）。 */
export const cloudGenSwitchId = (prefix: string, purpose: CloudGenPurpose | 'instant') =>
  purpose === 'instant' ? `${prefix}-instant-switch` : `${prefix}-cloud-gen-${purpose}-switch`;

type Props = {
  prefix: string;
  /** 私聊这一行就是原来的全局即时对话开关（instantChatEnabled）。 */
  instantOn: boolean;
  instantDisabled: boolean;
  onToggleInstant: () => void;
  cloudGen: ActiveMsg2GlobalConfig['cloudGen'];
  disabled: boolean;
  onChangeCloudGen: (purpose: CloudGenPurpose, patch: Partial<CloudGenFeatureSwitches>) => void;
};

const Switch = ({ id, label, checked, disabled, onClick }: { id?: string; label: string; checked: boolean; disabled: boolean; onClick: () => void }) =>
  <button type="button" id={id} role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={onClick} className="amsg-overview-switch"><span /></button>;

/**
 * 「云端生成」按功能的开关列表：私聊一个开关；日程、人格模拟、梦境各有「云端生成」和「完成时通知」。
 * 功能关着时「完成时通知」置灰但保留原值，重新打开还是原来的选择。
 */
export default function AmsgCloudGenSettings({ prefix, instantOn, instantDisabled, onToggleInstant, cloudGen, disabled, onChangeCloudGen }: Props) {
  // 「本功能不再提醒」存在这台设备的 localStorage；说明页那边点了也会经 subscribeCloudGenSheet 通知过来。
  const [hintOff, setHintOff] = useState(() => CLOUD_GEN_PURPOSES.filter(isCloudGenHintOff));
  useEffect(() => subscribeCloudGenSheet(() => setHintOff(CLOUD_GEN_PURPOSES.filter(isCloudGenHintOff))), []);

  return <section aria-labelledby={`${prefix}-cloud-gen-title`} className="amsg-overview-controls amsg-cloud-gen">
    <h4 id={`${prefix}-cloud-gen-title`} className="amsg-cloud-gen-title">云端生成</h4>
    <div className="amsg-overview-control">
      <h4>私聊</h4>
      <Switch id={cloudGenSwitchId(prefix, 'instant')} label="私聊云端生成" checked={instantOn} disabled={instantDisabled} onClick={onToggleInstant} />
    </div>
    {CLOUD_GEN_PURPOSES.map((purpose) => {
      const { label } = CLOUD_GEN_PURPOSE_META[purpose];
      const switches = resolveCloudGenFeatureSwitches({ cloudGen }, purpose);
      return <div key={purpose} className="amsg-cloud-gen-feature">
        <div className="amsg-overview-control">
          <h4>{label}</h4>
          <Switch id={cloudGenSwitchId(prefix, purpose)} label={`${label}云端生成`} checked={switches.enabled} disabled={disabled} onClick={() => onChangeCloudGen(purpose, { enabled: !switches.enabled })} />
        </div>
        <section aria-label={`${label}完成时通知`} className="amsg-overview-instant">
          <div className="amsg-overview-control">
            <h4>完成时通知</h4>
            <Switch label={`${label}完成时通知`} checked={switches.notify} disabled={disabled || !switches.enabled} onClick={() => onChangeCloudGen(purpose, { notify: !switches.notify })} />
          </div>
        </section>
        {hintOff.includes(purpose) && <button type="button" className="amsg-text-button amsg-cloud-gen-restore" onClick={() => setCloudGenHintOff(purpose, false)}>恢复云端生成提醒</button>}
      </div>;
    })}
  </section>;
}
