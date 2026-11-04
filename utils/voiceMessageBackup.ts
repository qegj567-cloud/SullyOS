/**
 * Voice favorites and saved Live2D companion-preset voices live in IndexedDB's
 * generic `assets` store as metadata plus raw Blob assets.
 * JSON.stringify(Blob) produces `{}`, so the normal JSON backup shards cannot
 * carry the audio bytes by themselves. Full/media backups externalize those
 * Blobs into ZIP entries and leave a small, JSON-safe marker in the asset row.
 * Ordinary speech keeps the existing local behavior and is not copied into
 * portable backups. Only explicit favorites and voice files referenced by a
 * saved Live2D preset are treated as archive items.
 */

import { VOICE_FAVORITE_AUDIO_PREFIX, VOICE_FAVORITES_INDEX_ASSET_ID } from './voiceFavorites';
import { isCompanionVoiceAssetId } from './companionVoiceAssets';

export const VOICE_MESSAGE_ASSET_PREFIX = 'voice_msg_';
export const VOICE_BACKUP_DIR = 'assets/voice-favorites';
export const COMPANION_VOICE_BACKUP_DIR = 'assets/companion-voices';
const LEGACY_VOICE_BACKUP_DIR = 'assets/chat-voices';
export const VOICE_BACKUP_MARKER = '__sullyChatVoiceBlobV1';

export interface VoiceBackupBlobMarker {
    [VOICE_BACKUP_MARKER]: true;
    path: string;
    mimeType: string;
    size: number;
}

type AssetRecord = {
    id?: unknown;
    data?: {
        blob?: unknown;
        [key: string]: unknown;
    };
    [key: string]: unknown;
};

type WriteBinaryFile = (path: string, bytes: Uint8Array) => void | Promise<void>;
type ReadBinaryFile = (path: string) => Promise<Uint8Array | null>;

const isVoiceAsset = (asset: AssetRecord): asset is AssetRecord & { id: string } => {
    if (typeof asset?.id !== 'string') return false;
    if (isCompanionVoiceAssetId(asset.id)) return true;
    if (asset.id.startsWith(VOICE_FAVORITE_AUDIO_PREFIX)) return true;
    return asset.id.startsWith(VOICE_MESSAGE_ASSET_PREFIX) && asset.data?.favorite === true;
};

const isRestorableVoiceAsset = (asset: AssetRecord): asset is AssetRecord & { id: string } => (
    typeof asset?.id === 'string'
    && (isCompanionVoiceAssetId(asset.id) || asset.id.startsWith(VOICE_FAVORITE_AUDIO_PREFIX) || asset.id.startsWith(VOICE_MESSAGE_ASSET_PREFIX))
);

/**
 * Portable backups omit reproducible TTS cache rows and ordinary per-message
 * voice rows. The favorites index, favorite audio, and saved companion-preset
 * dependencies pass through in full/media mode.
 */
export const shouldIncludeVoiceRelatedAssetInBackup = (value: unknown, includeFavorites = true): boolean => {
    const asset = value as AssetRecord | null | undefined;
    if (!asset || typeof asset.id !== 'string') return true;
    if (asset.id.startsWith('tts_')) return false;
    if (isCompanionVoiceAssetId(asset.id)) return includeFavorites;
    if (asset.id === VOICE_FAVORITES_INDEX_ASSET_ID || asset.id.startsWith(VOICE_FAVORITE_AUDIO_PREFIX)) return includeFavorites;
    if (asset.id.startsWith(VOICE_MESSAGE_ASSET_PREFIX)) return includeFavorites && asset.data?.favorite === true;
    return true;
};

export const isVoiceBackupBlobMarker = (value: unknown): value is VoiceBackupBlobMarker => {
    if (!value || typeof value !== 'object') return false;
    const marker = value as Partial<VoiceBackupBlobMarker>;
    return marker[VOICE_BACKUP_MARKER] === true
        && typeof marker.path === 'string'
        && (marker.path.startsWith(`${VOICE_BACKUP_DIR}/`)
            || marker.path.startsWith(`${COMPANION_VOICE_BACKUP_DIR}/`)
            || marker.path.startsWith(`${LEGACY_VOICE_BACKUP_DIR}/`))
        && typeof marker.mimeType === 'string'
        && Number.isSafeInteger(marker.size)
        && (marker.size as number) >= 0;
};

const safeVoiceFilename = (id: string, index: number): string => {
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || `voice_${index}`;
    return `${safeId}_${index}.bin`;
};

/** Synchronous cursor-safe export. Queue the Blob itself; read it only when its
 * ZIP entry is compressed. Marker semantics match the legacy byte writer. */
export function externalizeVoiceMessageBlob(
    value: unknown,
    index: number,
    writeBlob: (path: string, blob: Blob) => void,
): void {
    const asset = value as AssetRecord;
    if (!isVoiceAsset(asset) || !asset.data || !(asset.data.blob instanceof Blob)) return;
    const blob = asset.data.blob;
    const backupDir = isCompanionVoiceAssetId(asset.id) ? COMPANION_VOICE_BACKUP_DIR : VOICE_BACKUP_DIR;
    const path = `${backupDir}/${safeVoiceFilename(asset.id, index)}`;
    writeBlob(path, blob);
    asset.data.blob = { [VOICE_BACKUP_MARKER]: true, path, mimeType: blob.type || 'audio/mpeg', size: blob.size } satisfies VoiceBackupBlobMarker;
}

/**
 * Mutates the export clone in place. Dedicated favorite audio rows, the legacy
 * per-chat favorite shape, and companion-preset dependencies are externalized;
 * shared `tts_*` entries remain reproducible cache and are never copied.
 */
export async function externalizeVoiceMessageBlobs(
    assets: unknown,
    writeFile: WriteBinaryFile,
): Promise<number> {
    if (!Array.isArray(assets)) return 0;

    let written = 0;
    for (let index = 0; index < assets.length; index++) {
        const asset = assets[index] as AssetRecord;
        if (!isVoiceAsset(asset) || !asset.data || !(asset.data.blob instanceof Blob)) continue;

        const blob = asset.data.blob;
        const backupDir = isCompanionVoiceAssetId(asset.id) ? COMPANION_VOICE_BACKUP_DIR : VOICE_BACKUP_DIR;
        const path = `${backupDir}/${safeVoiceFilename(asset.id, index)}`;
        await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
        asset.data.blob = {
            [VOICE_BACKUP_MARKER]: true,
            path,
            mimeType: blob.type || 'audio/mpeg',
            size: blob.size,
        } satisfies VoiceBackupBlobMarker;
        written++;
    }
    return written;
}

/** Restore ZIP-backed markers to real Blobs before IndexedDB import begins. */
export async function restoreVoiceMessageBlobs(
    assets: unknown,
    readFile: ReadBinaryFile,
): Promise<number> {
    if (!Array.isArray(assets)) return 0;

    let restored = 0;
    for (const raw of assets) {
        const asset = raw as AssetRecord;
        if (!isRestorableVoiceAsset(asset) || !asset.data || !isVoiceBackupBlobMarker(asset.data.blob)) continue;

        const marker = asset.data.blob;
        const bytes = await readFile(marker.path);
        if (!bytes) {
            throw new Error(`损坏的备份包：缺少语音文件 ${marker.path}，已中止导入（数据未改动）。`);
        }
        if (bytes.byteLength !== marker.size) {
            throw new Error(`损坏的备份包：语音文件 ${marker.path} 大小不符，已中止导入（数据未改动）。`);
        }
        // Copy into a fresh ArrayBuffer: TS 5.7 models an arbitrary Uint8Array's
        // backing store as ArrayBufferLike (possibly SharedArrayBuffer), while
        // BlobPart deliberately accepts only ordinary ArrayBuffer views.
        const ownedBytes = new Uint8Array(bytes.byteLength);
        ownedBytes.set(bytes);
        asset.data.blob = new Blob([ownedBytes.buffer], { type: marker.mimeType || 'audio/mpeg' });
        restored++;
    }
    return restored;
}
