import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ActiveMsg2GlobalConfig, CharacterGroup, CharacterProfile } from '../../types';
import { AmsgIcon } from './AmsgArtwork';
import AmsgCharacterList from './AmsgCharacterList';
import AmsgCapabilityTable from './AmsgCapabilityTable';
import { buildAmsgCapabilityRows, type AmsgCapabilityInput, type AmsgCapabilityRow } from '../../utils/amsgCapabilities';
import { isAmsg2EnabledForChar } from '../../utils/amsg2Tasks';
import { collectMcpFireServers } from '../../utils/mcpClient';
import { ActiveMsgClient } from '../../utils/activeMsgClient';
import { CLOUD_GEN_PURPOSES, type CloudGenPurpose } from '../../utils/cloudGen/types';
import { resolveCloudGenFeatureSwitches, type CloudGenFeatureSwitches } from '../../utils/cloudGen/settings';
import AmsgCloudGenSettings, { cloudGenSwitchId } from './AmsgCloudGenSettings';

type Props = {
  connected: boolean;
  active: boolean;
  enabled: boolean;
  /**
   * 后台任务（Worker 的定时触发）开着没有。null＝这台 Worker 读不到（旧版或没连上），开关不显示。
   * 关掉后定时主动消息、离开后消息、见面离开提醒的云端任务到点不发，即时对话照常；恢复后只补发晚到一小时以内的。
   */
  cronEnabled: boolean | null;
  instantEnabled: boolean;
  busy: boolean;
  instantBlockedReason: string | null;
  /** 能力表用的探测结果；即时对话被挡的短原因单独给，脚注里那句长的不适合进表格。 */
  worker: AmsgCapabilityInput['worker'];
  push: AmsgCapabilityInput['push'];
  instantCapabilityBlocked: string;
  /** 日程 / 人格模拟 / 梦境的云端生成开关（ActiveMsg2GlobalConfig.cloudGen） */
  cloudGen: ActiveMsg2GlobalConfig['cloudGen'];
  onChangeCloudGen: (purpose: CloudGenPurpose, patch: Partial<CloudGenFeatureSwitches>) => void;
  characters: CharacterProfile[];
  characterGroups: CharacterGroup[];
  onToggleEnabled: () => void;
  onToggleInstant: () => void;
  onToggleCron: () => void;
  onOpenMaintenance?: () => void;
  onOpenPush?: () => void;
  onConfigureCharacter?: (id: string) => void;
};

export default function AmsgOverview({ connected, active, enabled, cronEnabled, instantEnabled, busy, instantBlockedReason, worker, push, instantCapabilityBlocked, cloudGen, onChangeCloudGen, characters, characterGroups, onToggleEnabled, onToggleInstant, onToggleCron, onOpenMaintenance, onOpenPush, onConfigureCharacter }: Props) {
  const prefix = useId();
  const characterList = useRef<HTMLDivElement>(null);
  // MCP 存在 localStorage，换角色列表或回到总览时重读一次就够了。
  const mcpServers = useMemo(() => active ? collectMcpFireServers().length : 0, [active]);
  // 只读探测，和交任务时问的是同一份缓存。总开关暂停时不问（暂停期间不向 Worker 发请求）。
  const [cloudGenSupport, setCloudGenSupport] = useState<AmsgCapabilityInput['cloudGenSupport']>('checking');
  useEffect(() => {
    if (!active || !connected || !enabled || worker !== 'ok') return;
    let live = true;
    setCloudGenSupport('checking');
    ActiveMsgClient.probeCloudGenSupportDetailed()
      .then(outcome => { if (live) setCloudGenSupport(outcome); })
      .catch(() => { if (live) setCloudGenSupport('unknown'); });
    return () => { live = false; };
  }, [active, connected, enabled, worker]);
  const cloudGenSwitches = CLOUD_GEN_PURPOSES.map(purpose => ({ purpose, ...resolveCloudGenFeatureSwitches({ cloudGen }, purpose) }));
  const cloudGenOn = cloudGenSwitches.filter(item => item.enabled).map(item => item.purpose);
  const cloudGenNotify = cloudGenSwitches.some(item => item.enabled && item.notify);
  const capabilityRows = useMemo(() => buildAmsgCapabilityRows({
    enabled: connected && enabled, worker, push, cronPaused: cronEnabled === false, instantOn: instantEnabled, instantBlocked: instantCapabilityBlocked,
    cloudGenOn, cloudGenNotify, cloudGenSupport,
    scheduleChars: characters.filter(isAmsg2EnabledForChar).length,
    awayChars: characters.filter(character => character.awayMessage?.enabled).length,
    dateChars: characters.filter(character => character.dateLeaveReminder?.enabled).length,
    mcpServers,
    // cloudGenOn 每次渲染都是新数组，按内容比较。
  }), [connected, enabled, worker, push, cronEnabled, instantEnabled, instantCapabilityBlocked, cloudGenOn.join(), cloudGenNotify, cloudGenSupport, characters, mcpServers]);
  const focusSwitch = (id: string) => {
    const target = document.getElementById(id);
    target?.scrollIntoView?.({ block: 'nearest' });
    target?.focus({ preventScroll: true });
  };
  // 红叉按原因去对应的开关或页面；其余按这一行自己的设置位置。
  const selectCapability = ({ id, cause }: AmsgCapabilityRow) => {
    const target = cause ?? id;
    if (target === 'master') focusSwitch(`${prefix}-master-switch`);
    else if (target === 'cron') focusSwitch(`${prefix}-cron-switch`);
    else if (target === 'worker') onOpenMaintenance?.();
    else if (target === 'push') onOpenPush?.();
    else if (target === 'instant') focusSwitch(cloudGenSwitchId(prefix, 'instant'));
    else if (target === 'cloudGen') focusSwitch(cloudGenSwitchId(prefix, 'schedule'));
    else if (target === 'schedule') characterList.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };
  return <div className="amsg-overview">
    <div className="amsg-overview-functions">
    <section aria-label="全局功能" className="amsg-overview-controls" data-paused={connected && !enabled || undefined}>
      <div className="amsg-overview-control">
        <h4>主动消息 2.0 总开关</h4>
        <button type="button" id={`${prefix}-master-switch`} role="switch" aria-label="主动消息 2.0 总开关" aria-describedby={`${prefix}-master-description`} aria-checked={connected && enabled} disabled={busy || !connected} onClick={onToggleEnabled} className="amsg-overview-switch"><span /></button>
      </div>
      {cronEnabled !== null && <section aria-labelledby={`${prefix}-cron-title`} className="amsg-overview-instant">
        <div className="amsg-overview-control">
          <h4 id={`${prefix}-cron-title`}>后台任务</h4>
          <button type="button" id={`${prefix}-cron-switch`} role="switch" aria-label="后台任务" aria-describedby={`${prefix}-cron-description`} aria-checked={cronEnabled} disabled={busy || !connected || !enabled} onClick={onToggleCron} className="amsg-overview-switch"><span /></button>
        </div>
      </section>}
    </section>
    <AmsgCloudGenSettings prefix={prefix} instantOn={instantEnabled} instantDisabled={busy || !connected || !enabled || (!instantEnabled && !!instantBlockedReason)} onToggleInstant={onToggleInstant}
      cloudGen={cloudGen} disabled={busy || !connected || !enabled} onChangeCloudGen={onChangeCloudGen} />
    {/* 暂停、未就绪的原因统一由下方能力表的红字说明，这里只留几句简介。 */}
    <div className="amsg-overview-footnote">
      <p id={`${prefix}-master-description`}>主动消息：让 TA 定时来找你。</p>
      <p>云端生成：交给你的后台在云端写，切到后台、锁屏也不中断。</p>
      {cronEnabled !== null && <p id={`${prefix}-cron-description`}>后台任务：到点送出主动消息、离开后消息和见面提醒。</p>}
    </div>
    </div>
    <details className="amsg-overview-explainer"><summary>云端生成和主动消息有什么区别？<AmsgIcon name="chevron" /></summary><div><p>主动消息是 TA 定时来找你；云端生成是把私聊回复、日程、人格模拟、梦境这些原本在页面里写的内容，交给你的后台去写。它不是秒回，模型等待时间与 API 费用照常。</p><p>云端生成属于 2.0，关闭 2.0 总开关会一起暂停，回到本机生成。私聊的角色默认跟随这里的开关，可单独关闭；角色的主动消息开关独立设置。「完成时通知」决定日程、人格模拟、梦境写好时弹不弹通知，不开也能回到应用后看到。</p><p>只想要云端生成、不想被主动找时，可以关掉后台任务。暂停期间到点的消息不发；重新打开后只补发晚到一小时以内的，更早的作废，不会一下子收到一串。</p><p>全局暂停会保留连接和角色选择，恢复后继续沿用。</p></div></details>
    <AmsgCapabilityTable rows={capabilityRows} onSelect={selectCapability} />
    <div ref={characterList}><AmsgCharacterList characters={characters} groups={characterGroups} active={active && connected} onConfigure={onConfigureCharacter} /></div>
  </div>;
}
