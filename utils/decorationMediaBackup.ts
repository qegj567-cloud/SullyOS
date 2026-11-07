import type {CharacterProfile} from '../types';

const FIELDS = ['bubbleStyle','chatAppearance','chatFineTune','chatBackground',
  'chromeCustomCss','chatDecorationCssIsolated','chatSound','chatSoundBound','thinkingChainStyle',
  'thinkingChainCustomColors','thinkingChainCustomCss'] as const satisfies ReadonlyArray<keyof CharacterProfile>;
export interface DecorationMediaBackup {version:1;values:Partial<Record<typeof FIELDS[number],unknown>>}

/** Only appearance, never reasoning switches, prompts or character information.
 * Explicit null records inheritance/default so restoring can clear overrides. */
export function exportDecorationMedia(character:CharacterProfile):DecorationMediaBackup {
  return {version:1,values:Object.fromEntries(FIELDS.map(key=>[key,structuredClone(character[key]??null)]))};
}
export function restoreDecorationMedia(value:unknown):Partial<CharacterProfile> {
  if (value===undefined) return {};
  const backup=value as DecorationMediaBackup;
  if (!backup || backup.version!==1 || !backup.values || typeof backup.values!=='object' || Array.isArray(backup.values)) throw Error('角色装扮备份格式无效');
  return Object.fromEntries(FIELDS.filter(key=>Object.prototype.hasOwnProperty.call(backup.values,key)).map(key=>[key,backup.values[key]===null?undefined:structuredClone(backup.values[key])])) as Partial<CharacterProfile>;
}
