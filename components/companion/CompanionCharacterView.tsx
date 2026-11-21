import React, { lazy, Suspense } from 'react';
import type { CharacterProfile } from '../../types';
import { companionAvatarSource, companionPortraitConfig, resolveCompanionPortrait } from '../../utils/companionAvatar';
import { useBlobRefUrl } from '../../utils/blobRef';
import StaticCompanionPortrait from '../os/StaticCompanionPortrait';
import TokenImg from '../os/TokenImg';
import { inferAvatarPerformanceFromText } from '../../utils/avatarPerformance';
import type { AvatarMotionState } from '../call/VRMAvatarCanvas';
import type { Live2DActionTrigger } from '../call/Live2DAvatarCanvas';

const VideoAvatar = lazy(() => import('../call/VRMVideoCallStage'));

export function CompanionCharacterView({ char, motion, spokenText }: { char?: CharacterProfile; motion: AvatarMotionState; spokenText?: string }) {
  const [wardrobeTrigger, setWardrobeTrigger] = React.useState<Live2DActionTrigger | null>(null);
  const background = useBlobRefUrl(char?.videoCallBackground);
  const performance = React.useMemo(() => spokenText ? inferAvatarPerformanceFromText(spokenText) : undefined, [spokenText]);
  if (!char) return <p className="companion-no-partner">请先选择同行角色</p>;
  const source = companionAvatarSource(char);
  const portrait = resolveCompanionPortrait(char, performance?.emotion, performance?.faces);
  const fallback = <div className="companion-call-avatar">{char.avatar
    ? <TokenImg value={char.avatar} alt={char.name} />
    : <span>{Array.from(char.name || '伴')[0]}</span>}</div>;
  return <>
    {background && <img className="companion-call-background" src={background} alt="" />}
    {source === 'model' && char.videoAvatar
      ? <Suspense fallback={fallback}><VideoAvatar key={char.id} characterName={char.name}
        onModelReady={() => {
          const model = char.videoAvatar;
          if (model?.format !== 'live2d') return;
          const outfit = model.actions.find(action => action.wardrobe && action.id === model.activeWardrobeActionId);
          if (outfit) setWardrobeTrigger(previous => ({ id: outfit.id, nonce: (previous?.nonce ?? 0) + 1 }));
        }} externalManualAction={wardrobeTrigger}
        model={char.videoAvatar} fallbackAvatar={char.avatar} motionState={motion} performance={performance} companionMode maxFps={24} accentColor="#c2b5ee" /></Suspense>
      : portrait ? <StaticCompanionPortrait value={portrait} characterName={char.name} surfaceLabel="同行形象" spriteConfig={companionPortraitConfig(char)}/>
        : fallback}
  </>;
}
