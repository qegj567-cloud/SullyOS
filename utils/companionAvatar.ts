import type { AvatarEmotion, AvatarFace } from './avatarPerformance';
import type { CharacterProfile, SkinSet } from '../types';

export const COMPANION_DATE_EMOTION_KEYS = ['normal', 'happy', 'angry', 'sad', 'shy'] as const;

export type CompanionAvatarSource = NonNullable<CharacterProfile['companionAvatar']>['source'];

export interface CompanionDateOutfit {
  id: string;
  name: string;
  sprites: Record<string, string>;
  preview?: string;
  expressionCount: number;
}

const DEFAULT_OUTFIT_ID = '__default__';

export const companionAvatarSource = (character?: CharacterProfile | null): CompanionAvatarSource => (
  character?.companionAvatar?.source || 'model'
);

const usableSpriteEntries = (sprites?: Record<string, string>) => (
  Object.entries(sprites || {}).filter(([key, value]) => key !== 'chibi' && Boolean(value))
);

export const hasDatePortraits = (character?: CharacterProfile | null): boolean => (
  usableSpriteEntries(character?.sprites).length > 0
  || (character?.dateSkinSets || []).some(skin => usableSpriteEntries(skin.sprites).length > 0)
);

export const listCompanionDateOutfits = (character?: CharacterProfile | null): CompanionDateOutfit[] => {
  if (!character) return [];
  const outfits: CompanionDateOutfit[] = [];
  if (usableSpriteEntries(character.sprites).length) {
    outfits.push(makeOutfit(DEFAULT_OUTFIT_ID, '默认立绘', character.sprites || {}));
  }
  (character.dateSkinSets || []).forEach(skin => {
    if (usableSpriteEntries(skin.sprites).length) outfits.push(makeOutfit(skin.id, skin.name, skin.sprites));
  });
  return outfits;
};

const makeOutfit = (id: string, name: string, sprites: Record<string, string>): CompanionDateOutfit => ({
  id,
  name,
  sprites,
  preview: pickSprite(sprites, ['normal', 'default', ...COMPANION_DATE_EMOTION_KEYS]),
  expressionCount: COMPANION_DATE_EMOTION_KEYS.filter(key => Boolean(sprites[key])).length,
});

export const normalizeCompanionSkinSetId = (skinSetId?: string): string => (
  skinSetId || DEFAULT_OUTFIT_ID
);

export const companionSkinSetPatchValue = (outfitId: string): string | undefined => (
  outfitId === DEFAULT_OUTFIT_ID ? undefined : outfitId
);

export const getCompanionDateSprites = (
  character: CharacterProfile,
  skinSetId = character.companionAvatar?.skinSetId,
): Record<string, string> => {
  if (skinSetId) {
    const selected = character.dateSkinSets?.find(skin => skin.id === skinSetId);
    if (selected && usableSpriteEntries(selected.sprites).length) return selected.sprites;
  }
  if (usableSpriteEntries(character.sprites).length) return character.sprites || {};
  const firstOutfit = character.dateSkinSets?.find(skin => usableSpriteEntries(skin.sprites).length);
  return firstOutfit?.sprites || {};
};

export const companionExpressionKey = (
  emotion: AvatarEmotion,
  faces: AvatarFace[] = [],
): string => {
  if (faces.includes('blush')) return 'shy';
  if (emotion === 'happy' || faces.includes('smile-eyes') || faces.includes('grin')) return 'happy';
  if (emotion === 'sad' || emotion === 'fearful' || faces.includes('brow-sad')) return 'sad';
  if (emotion === 'angry' || emotion === 'disgusted' || faces.includes('brow-angry')) return 'angry';
  if (emotion === 'surprised') return 'shy';
  return 'normal';
};

export const resolveCompanionPortrait = (
  character: CharacterProfile,
  emotion: AvatarEmotion = 'neutral',
  faces: AvatarFace[] = [],
  source = character.companionAvatar?.source,
): string | undefined => {
  const config = character.companionAvatar;
  if (source === 'upload') return config?.imageRef || character.avatar;
  if (source !== 'date') return undefined;
  const sprites = getCompanionDateSprites(character, config?.skinSetId);
  const emotionKey = companionExpressionKey(emotion, faces);
  return pickSprite(sprites, [emotionKey, 'normal', 'default', ...COMPANION_DATE_EMOTION_KEYS]) || character.avatar;
};

const pickSprite = (sprites: Record<string, string>, keys: readonly string[]): string | undefined => {
  const direct = keys.find(key => sprites[key]);
  if (direct) return sprites[direct];
  return usableSpriteEntries(sprites)[0]?.[1];
};

export const findCompanionDateSkin = (
  character: CharacterProfile,
  outfitId: string,
): SkinSet | undefined => character.dateSkinSets?.find(skin => skin.id === outfitId);

/** Date mode keeps its existing framing; uploaded images no longer inherit it. */
export const companionPortraitConfig = (character?: CharacterProfile | null) => {
  const source = companionAvatarSource(character);
  if (source === 'model') return { scale: 1, x: 0, y: 0 };
  return character?.companionAvatar?.portraitConfigs?.[source]
    || (source === 'date' ? character?.spriteConfig : undefined)
    || { scale: 1, x: 0, y: 0 };
};
