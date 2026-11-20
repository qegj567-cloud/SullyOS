import React, { useId } from 'react';
import type { CharacterGroup, CharacterProfile } from '../../types';
import { AmsgIcon } from './AmsgArtwork';
import AmsgCharacterList from './AmsgCharacterList';

type Props = {
  connected: boolean;
  active: boolean;
  enabled: boolean;
  cronPaused?: boolean;
  instantEnabled: boolean;
  busy: boolean;
  instantBlockedReason: string | null;
  characters: CharacterProfile[];
  characterGroups: CharacterGroup[];
  onToggleEnabled: () => void;
  onToggleInstant: () => void;
  onResumeCron?: () => void;
  onOpenMaintenance?: () => void;
  onConfigureCharacter?: (id: string) => void;
};

export default function AmsgOverview({ connected, active, enabled, cronPaused, instantEnabled, busy, instantBlockedReason, characters, characterGroups, onToggleEnabled, onToggleInstant, onResumeCron, onOpenMaintenance, onConfigureCharacter }: Props) {
  const prefix = useId();
  return <div className="amsg-overview">
    {connected && enabled && cronPaused ? (
      <div role="status" className="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 space-y-2.5 text-xs leading-relaxed text-amber-800">
        <div className="font-bold text-amber-950">云端后台任务已被暂停</div>
        <p>
          定时主动消息到点暂不触发（已排任务保存在云端，不会丢失；即时对话不受影响）。恢复后将重新按排期处理。
        </p>
        <div className="flex flex-wrap gap-2">
          {onResumeCron ? (
            <button
              type="button"
              disabled={busy}
              onClick={onResumeCron}
              className="px-3.5 py-2 rounded-xl bg-amber-500 text-white font-bold active:scale-95 transition-transform disabled:opacity-50"
            >
              {busy ? '处理中…' : '立即恢复后台任务'}
            </button>
          ) : null}
          {onOpenMaintenance ? (
            <button
              type="button"
              disabled={busy}
              onClick={onOpenMaintenance}
              className="px-3.5 py-2 rounded-xl bg-white border border-amber-300 text-amber-800 font-bold active:scale-95 transition-transform disabled:opacity-50"
            >
              前往维护设置
            </button>
          ) : null}
        </div>
      </div>
    ) : null}
    <div className="amsg-overview-functions">
    <section aria-label="全局功能" className="amsg-overview-controls" data-paused={connected && !enabled || undefined}>
      <div className="amsg-overview-control">
        <h4>主动消息 2.0 总开关</h4>
        <button type="button" role="switch" aria-label="主动消息 2.0 总开关" aria-describedby={`${prefix}-master-description${!connected || !enabled ? ` ${prefix}-master-state` : ''}`} aria-checked={connected && enabled} disabled={busy || !connected} onClick={onToggleEnabled} className="amsg-overview-switch"><span /></button>
      </div>
      <section aria-labelledby={`${prefix}-instant-title`} className="amsg-overview-instant">
        <div className="amsg-overview-control">
          <h4 id={`${prefix}-instant-title`}>即时对话总开关</h4>
          <button type="button" role="switch" aria-label="即时对话总开关" aria-describedby={`${prefix}-instant-description${!connected || !enabled ? ` ${prefix}-master-state` : ''}`} aria-checked={instantEnabled} disabled={busy || !connected || !enabled || (!instantEnabled && !!instantBlockedReason)} onClick={onToggleInstant} className="amsg-overview-switch"><span /></button>
        </div>
      </section>
    </section>
    <div className="amsg-overview-footnote">
      <p id={`${prefix}-master-description`}>主动消息：让 TA 定时来找你。</p>
      <p id={`${prefix}-instant-description`}>即时对话：切后台后继续生成回复。</p>
      {(!connected || !enabled) && <p id={`${prefix}-master-state`} className="amsg-overview-state">{!connected ? '待连接后台' : '全局已暂停 · 聊天在本机生成'}</p>}
      {connected && enabled && cronPaused && <p className="amsg-overview-blocker">后台定时触发已暂停 · 定时排程暂不发送</p>}
      {connected && enabled && instantBlockedReason && <p className="amsg-overview-blocker">即时对话暂未就绪：{instantBlockedReason}</p>}
    </div>
    </div>
    <details className="amsg-overview-explainer"><summary>即时对话和主动消息有什么区别？<AmsgIcon name="chevron" /></summary><div><p>主动消息是 TA 定时来找你；即时对话是你发消息后，由云端继续生成回复，并不是秒回，模型等待时间与 API 费用照常。</p><p>即时对话属于 2.0，关闭 2.0 总开关会一起暂停。角色默认跟随即时对话总开关，可单独关闭；角色的主动消息开关独立设置。</p><p>全局暂停会保留连接和角色选择，恢复后继续沿用。</p></div></details>
    <AmsgCharacterList characters={characters} groups={characterGroups} active={active && connected} onConfigure={onConfigureCharacter} />
  </div>;
}
