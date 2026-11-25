import type { CallRolePlacement, CharacterProfile } from '../types';
import { stickerAngle } from './cameraStickerGesture';

export type PlacementSurface = 'companion' | 'video';
export const DEFAULT_PLACEMENT: CallRolePlacement = { x: 0, y: 0, scale: 1, angle: 0 };
export const SCALE_MIN = 0.25, SCALE_MAX = 3, OFFSET_LIMIT = 90;
const limit = (value: number | undefined, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

export function normalizePlacement(value?: Partial<CallRolePlacement>): CallRolePlacement {
  return {
    x: limit(value?.x, 0, -OFFSET_LIMIT, OFFSET_LIMIT),
    y: limit(value?.y, 0, -OFFSET_LIMIT, OFFSET_LIMIT),
    scale: limit(value?.scale, 1, SCALE_MIN, SCALE_MAX),
    angle: typeof value?.angle === 'number' && Number.isFinite(value.angle) ? stickerAngle(value.angle) : 0,
  };
}

export function hasCustomPlacement(value?: CallRolePlacement): boolean {
  const { x, y, scale, angle } = normalizePlacement(value);
  return x !== 0 || y !== 0 || scale !== 1 || angle !== 0;
}

export function patchCallPlacement(char: CharacterProfile, surface: PlacementSurface, placement: CallRolePlacement): Partial<CharacterProfile> {
  const avatar = char.companionAvatar ?? { version: 1 as const, source: 'model' as const };
  return { companionAvatar: { ...avatar, callPlacements: { ...avatar.callPlacements, [surface]: normalizePlacement(placement) } } };
}

/** Recover the original stage coordinates for a tap on a transformed video-call model. */
export function unplacePoint(x: number, y: number, width: number, height: number, placement: CallRolePlacement) {
  const dx = x - width * (0.5 + placement.x / 100), dy = y - height * (0.5 + placement.y / 100);
  const angle = -placement.angle * Math.PI / 180;
  return {
    x: width / 2 + (dx * Math.cos(angle) - dy * Math.sin(angle)) / placement.scale,
    y: height / 2 + (dx * Math.sin(angle) + dy * Math.cos(angle)) / placement.scale,
  };
}
