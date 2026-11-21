import React, { lazy, Suspense } from 'react';
import type { CharacterProfile } from '../../types';
import { companionAvatarSource, companionPortraitConfig, resolveCompanionPortrait } from '../../utils/companionAvatar';
import { useBlobRefUrl } from '../../utils/blobRef';
import StaticCompanionPortrait from '../os/StaticCompanionPortrait';
import TokenImg from '../os/TokenImg';
import type { AvatarMotionState } from '../call/VRMAvatarCanvas';

const VideoAvatar = lazy(() => import('../call/VRMVideoCallStage'));

export function CompanionCharacterView({ char, motion }: { char?: CharacterProfile; motion: AvatarMotionState }) {
  const background = useBlobRefUrl(char?.videoCallBackground);
  if (!char) return <p className="companion-no-partner">请先选择同行角色</p>;
  const source = companionAvatarSource(char);
  const portrait = resolveCompanionPortrait(char);
  const fallback = <div className="companion-call-avatar">{char.avatar
    ? <TokenImg value={char.avatar} alt={char.name} />
    : <span>{Array.from(char.name || '伴')[0]}</span>}</div>;
  return <>
    {background && <img className="companion-call-background" src={background} alt="" />}
    {source === 'model' && char.videoAvatar
      ? <Suspense fallback={fallback}><VideoAvatar key={char.id} characterName={char.name}
        model={char.videoAvatar} fallbackAvatar={char.avatar} motionState={motion} companionMode maxFps={24} accentColor="#c2b5ee" /></Suspense>
      : portrait ? <StaticCompanionPortrait value={portrait} characterName={char.name} surfaceLabel="同行形象" spriteConfig={companionPortraitConfig(char)}/>
        : fallback}
  </>;
}
