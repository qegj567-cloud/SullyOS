import React, { useState } from 'react';
import type { CharacterProfile } from '../../types';
import { hasDatePortraits } from '../../utils/companionAvatar';
import { roleCameraView, roleChibi, type RoleCameraChoice } from '../../utils/roleCamera';
import { trackEvent } from '../../utils/analytics';

const sourceNames = { configured: '跟随角色', date: '见面立绘', chibi: 'Chibi', model: '动态模型' } as const;

export function useRoleCamera(char?: CharacterProfile | null) {
  const [setting, setSetting] = useState<{ id?: string; choice: RoleCameraChoice; enabled: boolean }>();
  const { choice, enabled } = setting && setting.id === char?.id ? setting : { choice: 'configured' as const, enabled: true };
  return { choice, enabled, view: roleCameraView(char, choice, enabled),
    select: (next: RoleCameraChoice) => {
      if (!Object.prototype.hasOwnProperty.call(sourceNames, next) || choice === next) return;
      setSetting({ id: char?.id, choice: next, enabled });
      trackEvent('切换角色镜头形象', { 形象: sourceNames[next] });
    },
    toggle: () => {
      setSetting({ id: char?.id, choice, enabled: !enabled });
      trackEvent('开关角色镜头', { 状态: enabled ? '关' : '开' });
    } };
}

export function RoleCameraSelect({ char, camera }: { char?: CharacterProfile | null; camera: ReturnType<typeof useRoleCamera> }) {
  return <select aria-label="角色镜头形象" value={camera.choice} onChange={event => camera.select(event.target.value as RoleCameraChoice)}>
    <option value="configured">跟随角色设置</option>
    <option value="date" disabled={!hasDatePortraits(char)}>见面立绘</option>
    <option value="chibi" disabled={!roleChibi(char)}>Chibi 小人</option>
    <option value="model" disabled={!char?.videoAvatar}>{char?.videoAvatar?.format === 'vrm' ? 'VRM 模型' : 'Live2D 模型'}</option>
  </select>;
}
