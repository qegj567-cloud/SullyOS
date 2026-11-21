import React, { useSyncExternalStore } from 'react';
import type { CompanionDebugStore, CompanionDebugTurn, CompanionPhase } from '../../utils/companion/debug';

export const companionReplyLabel = (phase?: CompanionPhase) => phase === 'quick' ? 'a · 接话' : phase === 'full' ? 'a′ · 完整回复' : '';

function phaseStatus(turn: CompanionDebugTurn, phase: CompanionPhase) {
  const stages = turn.stages, delivery = turn.delivery[phase];
  if (phase === 'quick' && !turn.quickEnabled) return '本轮已关闭';
  if (delivery?.failed) return '语音失败，正文已展示';
  if (delivery?.end !== undefined) return delivery.mode === 'text' ? '已展示（文字模式）' : '已播放';
  const request = stages[`${phase}_request`];
  if (request?.status === 'error') return '生成失败';
  if (turn.status === 'error') return request?.status === 'error' ? '生成失败' : '本轮出错，已停止';
  if (turn.status === 'cancelled') return request ? '已打断' : '已取消，未开始生成';
  if (stages[`${phase}_audio`]?.status === 'running') return '正在播放';
  if (stages[`${phase}_tts`]?.status === 'running') return '正在准备语音';
  if (request?.status === 'running') {
    const transport = turn.requests[phase];
    if (transport?.firstDelta !== undefined) return '已收到正文，正在生成';
    if (transport?.headers) return transport.headers.status >= 400 ? `请求失败（HTTP ${transport.headers.status}）`
      : transport.headers.streaming ? '已连接，等待首段正文' : '已连接，等待完整回复';
    return '请求已提交，等待 API 响应';
  }
  if (request?.status === 'done') return phase === 'full' && turn.quickEnabled && turn.delivery.quick?.end === undefined ? '已生成，等待 a 播完' : '已生成';
  if (phase === 'quick') return '正在准备接话';
  if (stages.memory?.status === 'running') return '正在召回记忆，尚未开始生成';
  if (stages.wait_a?.status === 'running') return '等待 a 全文，尚未开始生成';
  if (stages.full_prepare?.status === 'running') return '正在组装完整上下文，尚未开始生成';
  return '等待开始';
}

/** Always visible and follows the active turn, independently of the expanded debug history. */
export function CompanionReplyProgress({ store }: { store: CompanionDebugStore }) {
  const turn = useSyncExternalStore(store.subscribe, store.getSnapshot).at(-1);
  if (!turn) return null;
  return <div className="companion-reply-progress" role="status" aria-label="本轮回复进度" aria-live="polite">
    {(['quick', 'full'] as const).map(phase => <div key={phase} data-phase={phase}>
      <strong>{companionReplyLabel(phase)}</strong><span>{phaseStatus(turn, phase)}</span>
    </div>)}
  </div>;
}
