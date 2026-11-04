import type { CharacterProfile } from '../types';
import { DB } from './db';
import { collectCharacterCompanionVoiceAssetIds } from './companionPresets';

export const COMPANION_STARTUP_VOICE_ASSET_PREFIX = 'companion-startup-voice:';
export const COMPANION_TOUCH_VOICE_ASSET_PREFIX = 'companion-touch-voice:';

interface CompanionVoiceAsset {
  blob: Blob;
  mimeType: string;
  savedAt: number;
}

export const isCompanionVoiceAssetId = (id: string): boolean => (
  id.startsWith(COMPANION_STARTUP_VOICE_ASSET_PREFIX)
  || id.startsWith(COMPANION_TOUCH_VOICE_ASSET_PREFIX)
);

export const makeCompanionVoiceAssetId = (
  kind: 'startup' | 'touch',
  characterId: string,
  suffix = '',
): string => {
  const prefix = kind === 'startup'
    ? COMPANION_STARTUP_VOICE_ASSET_PREFIX
    : COMPANION_TOUCH_VOICE_ASSET_PREFIX;
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}${encodeURIComponent(characterId)}:${random}${suffix ? `:${suffix}` : ''}`;
};

export const saveCompanionVoiceBlob = async (assetId: string, blob: Blob): Promise<void> => {
  if (!isCompanionVoiceAssetId(assetId)) throw new Error('无效的陪伴语音资产 ID');
  if (!(blob instanceof Blob) || blob.size <= 0) throw new Error('语音文件为空');
  await DB.saveAssetRaw(assetId, {
    blob,
    mimeType: blob.type || 'audio/mpeg',
    savedAt: Date.now(),
  } satisfies CompanionVoiceAsset);
};

export const getCompanionVoiceBlob = async (assetId: string): Promise<Blob | null> => {
  if (!isCompanionVoiceAssetId(assetId)) return null;
  const raw = await DB.getAssetRaw(assetId).catch(() => null) as CompanionVoiceAsset | Blob | null;
  if (raw instanceof Blob) return raw;
  if (raw?.blob instanceof Blob) return raw.blob;

  // v1 把陪伴语音放在不参与普通备份的 blob_assets。读取时原地迁移到可备份 assets。
  const legacy = await DB.getBlobAsset(assetId).catch(() => null);
  if (!legacy) return null;
  await saveCompanionVoiceBlob(assetId, legacy);
  await DB.deleteBlobAsset(assetId).catch(() => undefined);
  return legacy;
};

export const deleteCompanionVoiceBlob = async (assetId: string): Promise<void> => {
  if (!isCompanionVoiceAssetId(assetId)) return;
  await Promise.all([
    DB.deleteAsset(assetId).catch(() => undefined),
    DB.deleteBlobAsset(assetId).catch(() => undefined),
  ]);
};

/** 在导出读取 assets store 前，把所有旧版 blob_assets 陪伴语音搬进可备份资产表。 */
export const ensureCompanionVoiceAssetsForBackup = async (characters: CharacterProfile[]): Promise<number> => {
  return ensureCompanionVoiceAssetIdsForBackup(collectCharacterCompanionVoiceAssetIds(characters));
};

/** Cursor export retains only referenced IDs, not every full character object. */
export const ensureCompanionVoiceAssetIdsForBackup = async (assetIds: Iterable<string>): Promise<number> => {
  let migrated = 0;
  for (const assetId of assetIds) {
    const current = await DB.getAssetRaw(assetId).catch(() => null) as CompanionVoiceAsset | Blob | null;
    if (current instanceof Blob || current?.blob instanceof Blob) continue;
    const legacy = await DB.getBlobAsset(assetId).catch(() => null);
    if (!legacy) continue;
    await saveCompanionVoiceBlob(assetId, legacy);
    await DB.deleteBlobAsset(assetId).catch(() => undefined);
    migrated++;
  }
  return migrated;
};
