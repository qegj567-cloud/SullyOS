import React, { useRef } from 'react';
import { ImageSquare } from '@phosphor-icons/react';
import {
  isAvatarTouchGesture,
  resolveAvatarTouchTarget,
  type AvatarTouchHit,
} from '../../utils/avatarTouch';
import { useBlobRefUrl } from '../../utils/blobRef';
import { RolePlacementTouchLock } from '../call/RolePlacement';

interface StaticCompanionPortraitProps {
  value?: string;
  characterName: string;
  spriteConfig?: { scale: number; x: number; y: number };
  /** Accepted for callers that track expressions; the image must not be keyed/remounted by it. */
  expressionKey?: string;
  touchEnabled?: boolean;
  onAvatarTouch?: (hit: AvatarTouchHit) => void;
  surfaceLabel?: string;
  testId?: string;
}

const StaticCompanionPortrait: React.FC<StaticCompanionPortraitProps> = ({
  value,
  characterName,
  spriteConfig,
  touchEnabled = false,
  onAvatarTouch,
  surfaceLabel = '桌面形象',
  testId = 'companion-static-portrait-stage',
}) => {
  const imageUrl = useBlobRefUrl(value);
  const callTouchLock = React.useContext(RolePlacementTouchLock);
  const pointerRef = useRef<{
    id: number;
    x: number;
    y: number;
    startedAt: number;
    maxDistance: number;
    pressure: number;
  } | null>(null);
  const scale = Math.max(0.25, Math.min(3, spriteConfig?.scale || 1));
  const offsetX = spriteConfig?.x || 0;
  const offsetY = spriteConfig?.y || 0;

  if (!imageUrl) return (
    <div className="absolute inset-0 flex items-center justify-center px-8 text-center text-xs text-white/55">
      <div><ImageSquare size={30} className="mx-auto mb-2" />请导入 PNG / GIF，或选择已有的见面立绘</div>
    </div>
  );

  return (
    <div className="pointer-events-none absolute inset-0 flex items-end justify-center overflow-hidden px-[4%] pb-[2%]" data-testid={testId}>
      <img
        src={imageUrl}
        alt={`${characterName}的${surfaceLabel}`}
        draggable={false}
        className={`pointer-events-auto max-h-[96%] max-w-full select-none object-contain drop-shadow-[0_18px_35px_rgba(0,0,0,.38)] ${touchEnabled ? 'cursor-pointer' : 'cursor-default'}`}
        style={{
          transform: `translate(${offsetX}%, ${offsetY}%) scale(${scale})`,
          transformOrigin: 'bottom center',
          touchAction: 'none',
        }}
        onPointerDown={event => {
          if (!touchEnabled || !onAvatarTouch) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          pointerRef.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            startedAt: Date.now(),
            maxDistance: 0,
            pressure: event.pressure || 0,
          };
        }}
        onPointerMove={event => {
          const pointer = pointerRef.current;
          if (!pointer || pointer.id !== event.pointerId) return;
          pointer.maxDistance = Math.max(pointer.maxDistance, Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y));
          pointer.pressure = Math.max(pointer.pressure, event.pressure || 0);
        }}
        onPointerCancel={() => { pointerRef.current = null; }}
        onPointerUp={event => {
          const pointer = pointerRef.current;
          pointerRef.current = null;
          if (!onAvatarTouch || !pointer || pointer.id !== event.pointerId || (event.pointerType === 'touch' && callTouchLock?.current)) return;
          const durationMs = Date.now() - pointer.startedAt;
          if (!isAvatarTouchGesture(pointer.maxDistance, durationMs, true)) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const stageRect = (callTouchLock ? event.currentTarget.closest('.call-placement-host') : event.currentTarget.parentElement)?.getBoundingClientRect() || rect;
          const portraitX = Math.max(0, Math.min(1, callTouchLock
            ? event.nativeEvent.offsetX / Math.max(1, event.currentTarget.clientWidth)
            : (event.clientX - rect.left) / Math.max(1, rect.width)));
          const portraitY = Math.max(0, Math.min(1, callTouchLock
            ? event.nativeEvent.offsetY / Math.max(1, event.currentTarget.clientHeight)
            : (event.clientY - rect.top) / Math.max(1, rect.height)));
          const normalizedX = Math.max(0, Math.min(1, (event.clientX - stageRect.left) / Math.max(1, stageRect.width)));
          const normalizedY = Math.max(0, Math.min(1, (event.clientY - stageRect.top) / Math.max(1, stageRect.height)));
          const target = resolveAvatarTouchTarget([], portraitY, portraitX);
          onAvatarTouch({
            nonce: Date.now() + Math.random(),
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
            normalizedX,
            normalizedY,
            pressure: pointer.pressure,
            durationMs,
            pointerType: event.pointerType === 'mouse' || event.pointerType === 'touch' || event.pointerType === 'pen' ? event.pointerType : 'unknown',
            zone: target.zone,
            part: target.part,
            source: 'portrait-bounds',
            rawAreas: [],
          });
        }}
      />
    </div>
  );
};

export default StaticCompanionPortrait;
