import React, { lazy, Suspense } from 'react';
import type { CharacterProfile } from '../../types';
import { roleChibi, type RoleCameraView } from '../../utils/roleCamera';
import { companionPortraitConfig, resolveCompanionPortrait } from '../../utils/companionAvatar';
import StaticCompanionPortrait from '../os/StaticCompanionPortrait';
import TokenImg from '../os/TokenImg';
import { inferAvatarPerformanceFromText, type AvatarPerformanceDirection } from '../../utils/avatarPerformance';
import type { AvatarMotionState } from '../call/VRMAvatarCanvas';
import type { Live2DActionTrigger } from '../call/Live2DAvatarCanvas';

const VideoAvatar = lazy(() => import('../call/VRMVideoCallStage'));

export const CompanionCharacterView = React.memo(function CompanionCharacterView({ char, view, motion, spokenText, direction, immersive = false }: { char?: CharacterProfile; view: RoleCameraView; motion: AvatarMotionState; spokenText?: string; direction?: AvatarPerformanceDirection; immersive?: boolean }) {
  const [wardrobeTrigger, setWardrobeTrigger] = React.useState<Live2DActionTrigger | null>(null);
  const inferred = React.useMemo(() => spokenText ? inferAvatarPerformanceFromText(spokenText) : undefined, [spokenText]);
  if (!char) return <p className="companion-no-partner">请先选择同行角色</p>;
  const performance = immersive ? direction ?? inferred : undefined;
  const portrait = view === 'chibi' ? roleChibi(char) : view === 'date' || view === 'upload'
    ? resolveCompanionPortrait(char, performance?.emotion, performance?.faces, view) : undefined;
  const fallback = <div className="companion-call-avatar">{char.avatar
    ? <TokenImg value={char.avatar} alt={char.name} />
    : <span>{Array.from(char.name || '伴')[0]}</span>}</div>;
  return <>
    {view === 'model' && char.videoAvatar
      ? <Suspense fallback={fallback}><VideoAvatar key={char.id} characterName={char.name}
        onModelReady={() => {
          const model = char.videoAvatar;
          if (model?.format !== 'live2d') return;
          const outfit = model.actions.find(action => action.wardrobe && action.id === model.activeWardrobeActionId);
          if (outfit) setWardrobeTrigger(previous => ({ id: outfit.id, nonce: (previous?.nonce ?? 0) + 1 }));
        }} externalManualAction={wardrobeTrigger}
        model={char.videoAvatar} fallbackAvatar={char.avatar} motionState={motion} performance={performance}
        performanceQuality={char.videoCallPerformanceQuality} immersiveCompanion={immersive} companionMode maxFps={30} accentColor="#c2b5ee" /></Suspense>
      : view === 'chibi' && portrait ? <TokenImg value={portrait} alt={char.name + '的 Chibi'} className="companion-chibi"/>
        : portrait ? <StaticCompanionPortrait value={portrait} characterName={char.name} surfaceLabel="同行形象" spriteConfig={companionPortraitConfig(char)}/>
        : fallback}
  </>;
});
