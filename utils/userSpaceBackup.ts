import { calibratedDeliveryPrefix } from './chatDeliveryReceipts';
import { hashBlob, dataUrlToBlob, blobToDataUrl } from '@rei-standard/blob-store';
import { DB, openSpaceDB } from './db';
import { openBackupArchiveWriter, type BackupArchiveFile, type BackupArchiveWriter } from './backupArchiveWriter';
import { forEachStorePage } from './backupPageReader';
import { createExportTrace, type ExportTraceWriter } from './backupExportTrace';
import { isTaskTraceKey } from './taskTrace';
import { isCloudGenStorageKey } from './cloudGen/types';
import { LOCAL_GEN_INFLIGHT_KEY } from './localGenInterruption';
import { compactMemoryLink } from './memoryPalace/linkPrecision';
import type { Emoji } from '../types';
import { collectBlobRefs } from './backupBlobs';
import { createDamagedPictureGuard, assertBackupStillReadable, BackupCorruptError } from './backupFormat';
import { listUserSpaces, SESSION_SPACE_ID, readSpaceLocal, writeSpaceLocal, rawSpaceStorage, isSharedSpaceKey, saveUserSpaces, sharedSettingForBackup, createSpaceStorage, prepareUserSpaceRestore, assertUserSpaceAvailable, type UserSpace } from './userSpaces';
import { exportAmsg2GlobalConfig, importAmsg2GlobalConfig } from './activeMsgStore';
import { openCollaborationSpace, deleteCollaborationSpace } from '../features/collaboration/store';
import { commitSpaceRows, persistSpaceCatalog, assertUniqueSpaceCharacters, clearSpaceTable, retryAfterSuspend } from './userSpaceData';
import { collectFriendFeedMedia, applyFriendFeedMedia, isActivityTextAsset } from './activityBackup';
import { HELP_HISTORY_KEY, helpMediaHistory, helpTextHistory, restoreHelpMedia } from './sullyHelpBackup';
import { legacyStickerLinks, portableEmojiRow, patchEmojiOriginal, patchSentSticker } from './emojiBackup';
import { parseFriendFeed } from './friendFeed';
import { exportDecorationMedia, restoreDecorationMedia } from './decorationMediaBackup';
import { shouldIncludeVoiceRelatedAssetInBackup } from './voiceMessageBackup';
import { isCompanionVoiceAssetId } from './companionVoiceAssets';
import { collectCharacterCompanionVoiceAssetIds } from './companionPresets';
import { withSharedAssetLock } from './sharedAssetLock';
import { backupAssetField, backupAssetSource, recordMissingBackupAsset, missingBackupAssetFiles, type BackupMissingAsset } from './backupMissingAssets';
import { newImportedSpaceId, newImportedBlobId } from './independentUserImport';
import { createIndependentUserRemap } from './independentUserRemap';
import { exportUserLocationSettings, validateSpaceLocationBackup, type SpaceLocationBackup } from './userLocationBackup';
import { USER_LOCATION_STORAGE_KEY } from './userLocationPrivacy';

type Mode = 'full' | 'text_only' | 'media_only';
interface SpaceArchive {
    format: 'sully-user-spaces'; version: 1; mode: Mode;
    spaces: Array<UserSpace & { local: Record<string, string>; stores: Record<string, string[]> }>;
    settings: Record<string, string>;
    backend?: Awaited<ReturnType<typeof exportAmsg2GlobalConfig>>;
    userLocation?: SpaceLocationBackup;
    blobs: Array<{ id: string; path: string; type: string; size: number }>;
    missingAssets?: BackupMissingAsset[];
}
const mediaStores = new Set(['characters', 'user_profile', 'themes', 'emojis', 'emoji_categories', 'journal_stickers', 'gallery', 'cc_custom_parts', 'pixel_home_assets', 'pixel_home_layouts', 'messages', 'assets', 'collab_assets', 'daily_schedule', 'bank_data']);
const mediaAsset = (id: string) => !id.startsWith(calibratedDeliveryPrefix) && (id === 'friend_feed_v1' || !isActivityTextAsset(id));
// 导入中标记（(im|ex)port.*progress）、各项长任务的中断留痕（taskTrace.ts 的 isTaskTraceKey）、
// 云端生成的在飞登记（cloudGen/types.ts 的 isCloudGenStorageKey）和本机生成的在飞标记（localGenInterruption.ts）都是本机进度，不进备份。
export const privateLocalExcluded = (key: string) => isTaskTraceKey(key) || isCloudGenStorageKey(key) || key === LOCAL_GEN_INFLIGHT_KEY || /location|geolocation|latitude|longitude|privacy|user_spaces_catalog|(?:im|ex)port.*progress/i.test(key);
export function spaceMediaRow(store: string, row: any) {
    if (store === 'assets' && row.id === HELP_HISTORY_KEY) return { id: row.id, data: helpMediaHistory(row.data) };
    if (store === 'characters') {
        const keys = ['id', 'avatar', 'sprites', 'dateSkinSets', 'activeSkinSetId', 'customDateSprites', 'spriteConfig', 'chibiStudio', 'videoAvatar', 'videoAvatarWardrobe', 'companionAvatar', 'companionTouchSettings', 'companionBackground', 'videoCallBackground', 'dateBackground', 'roomConfig'];
        const homeKeys = ['version', 'assetVersion', 'roomSizeVersion', 'homePalette', 'rooms'];
        return { ...Object.fromEntries(keys.filter(k => row[k] !== undefined).map(k => [k, row[k]])), ...restoreDecorationMedia(exportDecorationMedia(row)), ...(row.vrState?.chibi ? { vrState: { chibi: row.vrState.chibi } } : {}), ...(row.home3D ? { home3D: Object.fromEntries(homeKeys.filter(k => row.home3D[k] !== undefined).map(k => [k, row.home3D[k]])) } : {}) };
    }
    if (store === 'messages') return {
        id: row.id, charId: row.charId, groupId: row.groupId, role: row.role, timestamp: row.timestamp, type: row.type,
        content: row.type === 'image' || row.type === 'emoji' ? row.content : '',
        metadata: row.type === 'emoji' && row.metadata?.stickerName ? { stickerName: row.metadata.stickerName }
            : row.metadata?.cameraSnapshotRef || row.metadata?.cameraSnapshotExpired ? { cameraSnapshotRef: row.metadata.cameraSnapshotRef, cameraSnapshotExpired: row.metadata.cameraSnapshotExpired } : undefined,
    };
    if (store === 'user_profile') return { id: row.id, avatar: row.avatar, perCharAvatars: row.perCharAvatars, chibiStudio: row.chibiStudio };
    if (store === 'daily_schedule') return { id: row.id, coverImage: row.coverImage };
    if (store === 'assets' && row.id === 'friend_feed_v1') return { id: row.id, data: JSON.stringify(collectFriendFeedMedia(parseFriendFeed(row.data))) };
    return row;
}

/**
 * One ZIP for all spaces, written entry by entry into a temp file (docs/backup-pipeline.md「写入：顺序写进临时文件」)：
 * 每页按字节封页读出、打包、写进归档后才读下一页，内存里只有一页记录。
 * 交回的 Blob 是临时文件的一个切片，留到下一次多空间导出开始时才删（`<a download>` 没有完成信号），页面关闭后由启动清理收掉。
 */
export async function exportUserSpaces(mode: Mode, scope: 'current' | 'all', onProgress?: (text: string) => void, includeBackendConnection = false, onMissingAssets?: (items: BackupMissingAsset[]) => void): Promise<Blob> {
    return withSharedAssetLock('shared', () => exportUserSpacesUnderLease(mode, scope, onProgress, includeBackendConnection, onMissingAssets));
}
/** 上一次多空间导出的归档；下一次导出开始时释放。 */
let previousExport: BackupArchiveFile | undefined;
/** 只留总耗时超过这个值的表，几十张空表不刷屏。 */
const SLOW_TABLE_MS = 50;
type ExportTableStats = { space: string; store: string; pages: number; rows: number; ms: number; /** 最大一条记录的粗估字节数 */ maxRowBytes: number };
/** 上一次多空间导出的概况，调试面板用来在真机上确认写到了磁盘还是内存、多大、多久、慢在哪张表。 */
let lastExport: { onDisk: boolean; size: number; ms: number; entries: number; finishedAt: string; tables: ExportTableStats[] } | undefined;
export const lastUserSpaceExport = () => lastExport;

export type RestoreTableStats = { space: string; store: string; pages: number; rows: number; clearMs: number; readMs: number; unpackMs: number; writeMs: number };
/** 上一次多空间恢复的耗时概况。 */
export type UserSpaceRestoreStats = {
    startedAt: string; totalMs: number; ok: boolean; error?: { name: string; message: string };
    checkMs: number; checkReadMs: number; pictureCheckMs: number; pictureWriteMs: number; finishMs: number;
    retries: number; tables: RestoreTableStats[];
};
/** 恢复成功后页面会刷新，概况放 sessionStorage 才留得到调试面板里；不用 localStorage，免得多一个持久键。 */
const RESTORE_STATS_KEY = 'sully_debug_last_space_restore';
export function lastUserSpaceRestore(): UserSpaceRestoreStats | undefined {
    try {
        const text = sessionStorage.getItem(RESTORE_STATS_KEY);
        return text ? JSON.parse(text) : undefined;
    } catch { return undefined; }
}
function saveRestoreStats(stats: UserSpaceRestoreStats) {
    const slow = stats.tables.filter(t => t.clearMs + t.readMs + t.unpackMs + t.writeMs > SLOW_TABLE_MS);
    try {
        // 累计时用小数，存的时候再取整，免得上千页的舍入误差叠起来。
        sessionStorage.setItem(RESTORE_STATS_KEY, JSON.stringify({ ...stats, tables: slow }, (key, value) => typeof value === 'number' && key.endsWith('Ms') ? Math.round(value) : value));
    } catch { /* 写不进去只是少一份调试记录，恢复本身不受影响 */ }
}
const countRows = (db: IDBDatabase, table: string) => new Promise<number>((resolve, reject) => {
    const request = db.transaction(table).objectStore(table).count();
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
async function exportUserSpacesUnderLease(mode: Mode, scope: 'current' | 'all', onProgress: ((text: string) => void) | undefined, includeBackendConnection: boolean, onMissingAssets?: (items: BackupMissingAsset[]) => void): Promise<Blob> {
    const stale = previousExport;
    previousExport = undefined;
    await stale?.dispose();
    const started = Date.now();
    let entries = 0;
    let written = 0;
    const zip = await openBackupArchiveWriter({ onProgress: progress => { entries = progress.entries; written = progress.bytes; } });
    // 只有闪退、被系统杀掉这类走不到 finally 的情况会把留痕留下来。
    const trace = createExportTrace({ mode, scope, onDisk: zip.onDisk, startedAt: started });
    try {
        const file = await writeUserSpaces(zip, mode, scope, onProgress, includeBackendConnection, trace, () => written);
        previousExport = file.archive;
        lastExport = { onDisk: zip.onDisk, size: file.archive.size, ms: Date.now() - started, entries, finishedAt: new Date().toISOString(), tables: file.tables };
        onMissingAssets?.(file.missing);
        // WebKit 319985：落在磁盘上的文件直接上传会发出 0 字节，切片是绕法（不复制数据）。
        return file.archive.blob.slice(0, file.archive.size, 'application/zip');
    } catch (error) {
        await zip.abort().catch(() => undefined);
        throw error;
    } finally {
        trace.clear();
    }
}
async function writeUserSpaces(zip: BackupArchiveWriter, mode: Mode, scope: 'current' | 'all', onProgress: ((text: string) => void) | undefined, includeBackendConnection: boolean, trace: ExportTraceWriter, writtenBytes: () => number) {
    const files = new Set<string>(), refs = new Set<string>();
    const tableStats: ExportTableStats[] = [];
    const manifest: SpaceArchive = { format: 'sully-user-spaces', version: 1, mode, spaces: [], settings: {}, blobs: [] };
    const addBytes = async (blob: Blob): Promise<string> => {
        const hash = await hashBlob(blob), path = `shared/${hash.replace(/[^a-zA-Z0-9_-]/g, '')}.bin`;
        if (!files.has(path)) { files.add(path); await zip.add(path, blob, { compression: 'STORE' }); }
        return path;
    };
    const seenIds = new Set<string>();
    const missingAssets = new Map<string, BackupMissingAsset>();
    const addAsset = async (id: string, location?: string, blob?: Blob | null) => {
        if (missingAssets.has(id)) { recordMissingBackupAsset(missingAssets, id, location); return; }
        if (seenIds.has(id)) return;
        const data = blob ?? await DB.getBlobAsset(id);
        if (!data) { recordMissingBackupAsset(missingAssets, id, location); return; }
        seenIds.add(id);
        manifest.blobs.push({ id, path: await addBytes(data), type: data.type, size: data.size });
    };
    const pack = async (value: any, key = '', location = ''): Promise<any> => {
        if (value instanceof Date) return { __spaceDate: value.toISOString() };
        if (value instanceof Blob) return mode === 'text_only' ? null : { __spaceBinary: await addBytes(value), type: value.type };
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            const bytes = value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            return { __spaceBinary: await addBytes(new Blob([bytes as ArrayBuffer])), arrayType: value instanceof ArrayBuffer ? 'ArrayBuffer' : value.constructor.name };
        }
        if (typeof value === 'string') {
            if (mode === 'text_only' && (value.startsWith('data:') || value.startsWith('blobref:'))) return '';
            if (/^\s*[\[{]/.test(value)) { try { return JSON.stringify(await pack(JSON.parse(value), key, location)); } catch (error) { if (!(error instanceof SyntaxError)) throw error; } }

            if (mode !== 'text_only' && /^data:[^,]*;base64,/.test(value)) {
                const blob = dataUrlToBlob(value);
                return { __spaceDataURL: await addBytes(blob), type: blob.type, header: value.slice(0, value.indexOf(',') + 1) };
            }
            if (mode !== 'text_only') {
                const tokens = new Set<string>(); collectBlobRefs(value, tokens);
                for (const token of tokens) await addAsset(token.slice('blobref:'.length), location);
                if (key === 'assetId') { const data = await DB.getBlobAsset(value); if (data) await addAsset(value, location, data); }
            }
            return value;
        }
        if (Array.isArray(value)) { const out = []; for (const [index, item] of value.entries()) out.push(await pack(item, '', `${location} → 第 ${index + 1} 项`)); return out; }
        if (value && typeof value === 'object') {
            if (mode !== 'text_only' && (value.format === 'live2d' || value.format === 'vrm') && value.assetId && !value.builtIn) await addAsset(value.assetId, `${location} → 素材文件`);
            const out: Record<string, any> = Object.create(null);
            for (const [k, v] of Object.entries(value)) out[k] = await pack(v, k, `${location} → ${backupAssetField(k)}`);
            return out;
        }
        return value;
    };
    for (const space of listUserSpaces().filter(s => scope === 'all' || s.id === SESSION_SPACE_ID)) {
        const db = await openSpaceDB(space.id);
        // 表情和角色先各扫一遍，只留后面要用的几个字段，不整表留在内存里。
        const stickerRows: Array<Pick<Emoji, 'url' | 'backupSourceUrl'>> = [];
        if (db.objectStoreNames.contains('emojis')) await forEachStorePage(db, 'emojis', rows => {
            for (const row of rows) if (row.url?.startsWith('blobref:')) stickerRows.push({ url: row.url, backupSourceUrl: row.backupSourceUrl });
        });
        const stickerLinks = legacyStickerLinks(stickerRows as Emoji[]);
        const voiceIds = new Set<string>(), characterNames = new Map<string, string>();
        await forEachStorePage(db, 'characters', rows => {
            for (const id of collectCharacterCompanionVoiceAssetIds(rows)) voiceIds.add(id);
            for (const character of rows) characterNames.set(character.id, character.name);
        });
        const local = Object.fromEntries(Object.entries(readSpaceLocal(space.id)).filter(([k]) => !privateLocalExcluded(k) && (mode !== 'media_only' || /^(os_theme|tama_style|companion_frame|companion_layout|mg_style)/.test(k))));
        const entry = { ...space, local: await pack(local, '', backupAssetSource(space.name, 'local')), stores: {} as Record<string, string[]> };
        const collaboration = await openCollaborationSpace(space.id);
        for (const [prefix, database] of [['', db], ['collab_', collaboration]] as const) for (const tableName of Array.from(database.objectStoreNames)) {
            const store = prefix + tableName;
            if (store === 'blob_assets' || store === 'api_call_log' || (mode === 'media_only' && !mediaStores.has(store))) continue;
            const paths: string[] = entry.stores[store] = [];
            // 按字节封页，总页数事先不知道，进度用已读 / 总条数表达。
            const total = await countRows(database, tableName), started = performance.now();
            let read = 0, maxRowBytes = 0;
            trace.table(space.name, store, total);
            await forEachStorePage(database, tableName, async (page, index, info) => {
                read += page.length;
                maxRowBytes = Math.max(maxRowBytes, info.maxRowBytes);
                trace.pageRead(info);
                onProgress?.(`正在读取 ${space.name} · ${store}（${read} / ${total} 条）`);
                const rows = page.filter(r => !(store === 'assets' && (r.id === 'ls_mirror_v1' || r.id === 'user_spaces_catalog_v1')))
                    .filter(r => store !== 'assets' || shouldIncludeVoiceRelatedAssetInBackup(r, mode !== 'text_only') && (!isCompanionVoiceAssetId(r.id) || voiceIds.has(r.id)))
                    .filter(r => mode !== 'media_only' || store !== 'assets' || mediaAsset(r.id))
                    .filter(r => mode !== 'media_only' || store !== 'bank_data' || r.id === 'dollhouse_state')
                    .filter(r => mode !== 'media_only' || store !== 'daily_schedule' || r.coverImage)
                    .filter(r => mode !== 'media_only' || store !== 'messages' || r.type === 'image' || r.type === 'emoji' || r.metadata?.cameraSnapshotRef || r.metadata?.cameraSnapshotExpired);
                const processed = [];
                for (const stored of rows) {
                    // 与单用户导出、恢复写库同一口径：关联强度只留 5 位小数。
                    const row = store === 'memory_links' ? compactMemoryLink(stored) : stored;
                    const value = mode === 'media_only' ? spaceMediaRow(store, row)
                        : mode === 'text_only' && store === 'assets' && row.id === HELP_HISTORY_KEY ? { id: row.id, data: helpTextHistory(row.data) } : row;
                    processed.push(await pack(portableEmojiRow(store, value, stickerLinks), '', backupAssetSource(space.name, store, row, characterNames)));
                }
                const text = JSON.stringify(processed); collectBlobRefs(text, refs);
                const path = `spaces/${space.id}/${store}.${index}.json`;
                await zip.add(path, text); paths.push(path);
                trace.written(writtenBytes()); trace.pageWritten();
            }, { total, label: `${space.name} · ${store}` });
            const ms = performance.now() - started;
            if (ms > SLOW_TABLE_MS) tableStats.push({ space: space.name, store, pages: paths.length, rows: read, ms: Math.round(ms), maxRowBytes });
        }
        collectBlobRefs(JSON.stringify(entry.local), refs); manifest.spaces.push(entry);
    }
    if (mode !== 'media_only' && rawSpaceStorage) {
        for (let i = 0; i < rawSpaceStorage.length; i++) {
            const key = rawSpaceStorage.key(i)!;
            if (isSharedSpaceKey(key) && !privateLocalExcluded(key)) manifest.settings[key] = sharedSettingForBackup(key, rawSpaceStorage.getItem(key)!);
        }
    }
    onProgress?.('正在打包共享素材');
    trace.written(writtenBytes()); trace.assets();
    if (mode !== 'text_only') for (const ref of refs) await addAsset(ref.slice('blobref:'.length));
    if (mode !== 'media_only') manifest.backend = await exportAmsg2GlobalConfig({ includeBackendConnection });
    if (mode !== 'media_only' && rawSpaceStorage) {
        for (const space of manifest.spaces) {
            const config = exportUserLocationSettings(createSpaceStorage(rawSpaceStorage, space.id));
            if (!config) continue;
            const { characterIds, ...settings } = config;
            manifest.userLocation ??= { settings, audiences: {} };
            manifest.userLocation.audiences[space.id] = characterIds ?? null;
        }
    }
    const missing = [...missingAssets.values()];
    if (missing.length) manifest.missingAssets = missing;
    for (const [name, text] of missingBackupAssetFiles(missing)) await zip.add(name, text);
    await zip.add('user-spaces.json', JSON.stringify(manifest));
    return { archive: await zip.close(), missing, tables: tableStats };
}

export type ImportUserSpacesOptions = {
    asNewUsers?: boolean;
    /** Called once every read-only check has passed, right before the first database write. */
    onBeforeWrite?: () => void;
    /** asNewUsers only: the failed attempt's new users were removed completely, so existing data is as before. */
    onRolledBack?: () => void;
    /** A picture whose bytes are corrupt inside the archive was skipped like a missing one; the rest still restores. */
    onDamagedAsset?: (id: string) => void;
    /** 每页（图片每张）回调一次；检查阶段也会回调，这时还没写库。 */
    onProgress?: (progress: UserSpaceRestoreProgress) => void;
};
export type UserSpaceRestoreProgress = {
    /** 阶段，如「正在检查」「正在清空」「正在写入图片」「正在收尾」 */
    stage: string;
    /** 「用户 · 表」，图片和收尾阶段没有 */
    current?: string;
    /** 有 current 时是第几页 / 共几页，图片阶段是第几张 / 共几张 */
    done?: number; total?: number;
    /** 总体完成度 0–1，按检查一遍 + 写一遍的页数加图片数估算，单调不减 */
    ratio: number;
    /** 拼好的一行，如「正在写入 小明 · memory_links（第 37 / 1000 页）」 */
    text: string;
};

/** Every check runs before the first write; tables are then written page by page without rollback (see importUserSpacesUnderLease). */
export async function importUserSpaces(zip: any, allowBackendConnection = false, options: ImportUserSpacesOptions = {}): Promise<UserSpace[]> {
    return withSharedAssetLock('exclusive', async () => {
        const created: string[] = [];
        const started = performance.now();
        const stats: UserSpaceRestoreStats = { startedAt: new Date().toISOString(), totalMs: 0, ok: false, checkMs: 0, checkReadMs: 0, pictureCheckMs: 0, pictureWriteMs: 0, finishMs: 0, retries: 0, tables: [] };
        try {
            const restored = await importUserSpacesUnderLease(zip, allowBackendConnection, options.asNewUsers === true, created, options, stats);
            stats.ok = true;
            return restored;
        }
        catch (error) {
            // 只留错误类型和文案，不带堆栈和任何记录内容。
            const thrown = error as { name?: unknown; message?: unknown } | undefined;
            stats.error = { name: String(thrown?.name ?? 'Error'), message: String(thrown?.message ?? error) };
            let cleanedUp = true;
            // Only IDs allocated by this attempt can be removed. Existing spaces are never rollback targets.
            if (created.length) {
                for (const id of created) {
                    try {
                        await deleteCollaborationSpace(id);
                        await DB.deleteDB(id);
                        if (rawSpaceStorage) {
                            const view = createSpaceStorage(rawSpaceStorage, id);
                            for (const key of Object.keys(readSpaceLocal(id))) view.removeItem(key);
                        }
                    } catch (cleanupError) { cleanedUp = false; console.warn('迁入临时用户清理未完成', cleanupError); }
                }
                const catalog = listUserSpaces();
                if (catalog.some(space => created.includes(space.id))) {
                    saveUserSpaces(catalog.filter(space => !created.includes(space.id)));
                    try { await persistSpaceCatalog(); } catch { cleanedUp = false; /* Preserve the original failure. */ }
                }
            }
            if (options.asNewUsers && cleanedUp) options.onRolledBack?.();
            throw error;
        } finally {
            stats.totalMs = performance.now() - started;
            saveRestoreStats(stats);
        }
    });
}

const SHARED_PATH = /^shared\/[a-zA-Z0-9_-]+\.bin$/;
/** 本机专属、导出时被滤掉的 assets 行，替换模式清表时补回（与导出的过滤条件对应）。 */
const LOCAL_ONLY_ASSETS = ['ls_mirror_v1', 'user_spaces_catalog_v1'];
/** 仅媒体包里要和本机已有行合并的表；其余媒体表按行覆盖写入。 */
const MEDIA_MERGE_STORES = new Set(['emojis', 'characters', 'user_profile', 'messages', 'assets', 'daily_schedule']);
const ARRAY_TYPES = { Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array };
type SpaceTable = { store: string; table: string; collab: boolean; paths: string[] };

/**
 * 按 docs/backup-pipeline.md「恢复：逐页写库」的顺序恢复，内存里任何时候最多一页记录：
 * 1. 整体检查：每一页读一遍、验完就丢（存在、CRC、能解析、编号合法、引用的条目在包里），同时只取角色编号做跨空间冲突检查；
 * 2. 迁入为新用户时，同一遍扫描顺带记下旧编号，扫完再分配新编号；
 * 3. 共享图片：先逐张核对（读得到、大小、编号冲突），再逐张写入，只增不覆盖；
 * 4. 逐空间、逐表：清空并补回本机专属行（同一事务），再逐页 读取 → 解包 → 一个事务写一页；
 * 5. 行内缺图、坏图在写那一页时按缺图规则跳过。
 * 中途失败时已写的表是新数据、没写到的是旧数据，不回滚；onBeforeWrite 在第一次写库前才调用。
 */
async function importUserSpacesUnderLease(zip: any, allowBackendConnection: boolean, asNewUsers: boolean, created: string[], options: ImportUserSpacesOptions, stats: UserSpaceRestoreStats): Promise<UserSpace[]> {
    const { onBeforeWrite, onDamagedAsset, onProgress } = options;
    const checkStarted = performance.now();
    const manifest = JSON.parse(await zip.file('user-spaces.json').async('string')) as SpaceArchive;
    if (manifest.format !== 'sully-user-spaces' || manifest.version !== 1 || !['full', 'text_only', 'media_only'].includes(manifest.mode)
        || !Array.isArray(manifest.spaces) || !manifest.spaces.length || !Array.isArray(manifest.blobs)) throw new Error('用户空间备份格式无效');
    // 进度按「检查一遍 + 写一遍」的总页数加图片数（核对、写入各一遍）估算，最后留一格给收尾。
    const pageTotal = manifest.spaces.reduce((sum, space) => sum + Object.values(space?.stores || {}).reduce((n, paths) => n + (Array.isArray(paths) ? paths.length : 0), 0), 0);
    const blobTotal = manifest.blobs.length, unitTotal = 2 * pageTotal + 2 * blobTotal + 1;
    let unit = 0;
    const report = (stage: string, current?: string, done?: number, total?: number) => {
        if (!onProgress) return;
        const count = total === undefined ? '' : current ? `（第 ${done} / ${total} 页）` : `（${done} / ${total}）`;
        onProgress({ stage, current, done, total, ratio: Math.min(1, unit / unitTotal), text: `${stage}${current ? ` ${current}` : ''}${count}` });
    };
    const retry = <T,>(write: () => Promise<T>) => retryAfterSuspend(write, () => { stats.retries++; });
    if (asNewUsers && manifest.mode === 'media_only') throw new Error('独立用户迁入需要整合或文字备份，媒体补图包不包含完整存档');
    const mediaOnly = manifest.mode === 'media_only';
    const blobIds = new Map<string, string>(asNewUsers ? manifest.blobs.map(entry => [entry.id, newImportedBlobId()]) : []);
    const occupiedSpaceIds = new Set(listUserSpaces().map(space => space.id));
    if (asNewUsers && indexedDB.databases) for (const database of await indexedDB.databases()) {
        const match = /^(?:AetherOS_Data|SullyOS_Collaboration)__(u_[a-zA-Z0-9_-]+)$/.exec(database.name || '');
        if (match) occupiedSpaceIds.add(match[1]);
    }
    const unique = new Set<string>();
    // 图片在包里坏了（CRC 不符、解压失败）按缺图跳过并上报；读文件失败、内存不足不是包坏了，照常中止。
    const skipDamaged = createDamagedPictureGuard(zip);
    const readPicture = async (path: string, id: string) => {
        const bytes = await skipDamaged<any>(() => zip.file(path).async('uint8array'));
        if (bytes === null) onDamagedAsset?.(id);
        return bytes;
    };
    // 写库阶段重读的条目在检查阶段都校验通过过，这时读出错多半是文件被收回或移走，先按文件失效确认一次。
    const reread = <T,>(read: () => Promise<T>): Promise<T> => read().catch(async error => {
        if (error instanceof BackupCorruptError) await assertBackupStillReadable(zip);
        throw error;
    });
    const unpack = async (v: any): Promise<any> => {
        if (typeof v === 'string' && /^\s*[\[{]/.test(v)) {
            try {
                const parsed = JSON.parse(v), next = await unpack(parsed);
                return JSON.stringify(next) === JSON.stringify(parsed) ? v : JSON.stringify(next);
            }
            catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        }
        if (v?.__spaceDataURL) {
            if (!SHARED_PATH.test(v.__spaceDataURL) || !zip.file(v.__spaceDataURL) || typeof v.header !== 'string' || !/^data:[^,]*;base64,$/.test(v.header)) throw new Error('备份内嵌素材无效');
            const bytes = await readPicture(v.__spaceDataURL, v.__spaceDataURL);
            if (!bytes) return ''; // 与文字备份里被剥掉的图片同形
            const url = await blobToDataUrl(new Blob([bytes], { type: v.type || '' }));
            return v.header + url.slice(url.indexOf(',') + 1);
        }
        if (v?.__spaceDate) { const date = new Date(v.__spaceDate); if (!Number.isFinite(date.getTime())) throw new Error('备份日期无效'); return date; }
        if (v?.__spaceBinary) {
            if (!SHARED_PATH.test(v.__spaceBinary) || !zip.file(v.__spaceBinary)) throw new Error('备份二进制文件缺失');
            const bytes = await reread<any>(() => zip.file(v.__spaceBinary).async('uint8array'));
            if (v.arrayType) {
                if (v.arrayType === 'ArrayBuffer') return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                if (!Object.hasOwn(ARRAY_TYPES, v.arrayType)) throw new Error('备份向量类型无效');
                return new ARRAY_TYPES[v.arrayType as keyof typeof ARRAY_TYPES](bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
            }
            return new Blob([bytes], { type: v.type || '' });
        }
        if (Array.isArray(v)) return Promise.all(v.map(unpack));
        if (v && typeof v === 'object') { const out: any = Object.create(null); for (const [k, value] of Object.entries(v)) out[k] = await unpack(value); return out; }
        return v;
    };
    // 检查阶段只确认引用合法、条目存在；收藏语音、协同附件、向量这类非图片二进制损坏要在写库前整体拒绝，所以读一遍核对 CRC 后丢掉。
    const checkedBinaries = new Set<string>();
    const checkPacked = async (v: any): Promise<void> => {
        if (typeof v === 'string') {
            if (!/^\s*[\[{]/.test(v)) return;
            let parsed: any;
            try { parsed = JSON.parse(v); } catch (error) { if (!(error instanceof SyntaxError)) throw error; return; }
            return checkPacked(parsed);
        }
        if (!v || typeof v !== 'object') return;
        if (v.__spaceDataURL) {
            if (!SHARED_PATH.test(v.__spaceDataURL) || !zip.file(v.__spaceDataURL) || typeof v.header !== 'string' || !/^data:[^,]*;base64,$/.test(v.header)) throw new Error('备份内嵌素材无效');
            return;
        }
        if (v.__spaceDate) { if (!Number.isFinite(new Date(v.__spaceDate).getTime())) throw new Error('备份日期无效'); return; }
        if (v.__spaceBinary) {
            if (!SHARED_PATH.test(v.__spaceBinary) || !zip.file(v.__spaceBinary)) throw new Error('备份二进制文件缺失');
            if (v.arrayType && v.arrayType !== 'ArrayBuffer' && !Object.hasOwn(ARRAY_TYPES, v.arrayType)) throw new Error('备份向量类型无效');
            if (!checkedBinaries.has(v.__spaceBinary)) {
                const readStarted = performance.now();
                await zip.file(v.__spaceBinary).async('uint8array'); checkedBinaries.add(v.__spaceBinary);
                stats.checkReadMs += performance.now() - readStarted;
            }
            return;
        }
        for (const item of Array.isArray(v) ? v : Object.values(v)) await checkPacked(item);
    };
    const userLocation = !asNewUsers && !mediaOnly
        ? validateSpaceLocationBackup(manifest.userLocation, manifest.spaces.map(space => space.id)) : undefined;

    // 1–2. 整体检查 + 迁入时的编号扫描。
    const prepared = [];
    for (const storedSpace of manifest.spaces) {
        const space = { ...storedSpace, local: await unpack(storedSpace.local) };
        if (!/^(default|u_[a-zA-Z0-9_-]+)$/.test(space.id) || unique.has(space.id) || typeof space.name !== 'string' || !space.name.trim() || !space.stores || !space.local || Array.isArray(space.local) || typeof space.local !== 'object' || Object.values(space.local).some(value => typeof value !== 'string')) throw new Error('用户空间目录无效');
        unique.add(space.id);
        const sourceId = space.id;
        if (asNewUsers) {
            space.id = newImportedSpaceId();
            if (occupiedSpaceIds.has(space.id)) throw new Error('新用户编号冲突，请重试迁入');
            occupiedSpaceIds.add(space.id); created.push(space.id); space.name = `${space.name}（迁入）`;
        }
        if (mediaOnly) assertUserSpaceAvailable(space.id);
        else prepareUserSpaceRestore(space.id);
        const db = await openSpaceDB(space.id), collaboration = await openCollaborationSpace(space.id);
        const remap = asNewUsers ? createIndependentUserRemap(blobIds) : undefined;
        const charIds: string[] | undefined = space.stores.characters ? [] : undefined;
        const tables: SpaceTable[] = [];
        for (const [store, paths] of Object.entries(space.stores)) {
            const collab = store.startsWith('collab_'), storage = collab ? collaboration : db, table = collab ? store.slice(7) : store;
            if (!storage.objectStoreNames.contains(table) || store === 'blob_assets' || !Array.isArray(paths) || mediaOnly && !mediaStores.has(store)) throw new Error('备份数据表无效');
            const { keyPath, autoIncrement } = storage.transaction(table).objectStore(table);
            for (const [index, path] of paths.entries()) {
                report('正在检查', `${space.name} · ${store}`, index + 1, paths.length); unit++;
                if (!path.startsWith(`spaces/${sourceId}/${store}.`) || !/^spaces\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_]+\.\d+\.json$/.test(path) || !zip.file(path)) throw new Error('备份分片缺失');
                const readStarted = performance.now();
                const text = await zip.file(path).async('string');
                stats.checkReadMs += performance.now() - readStarted;
                const rows = JSON.parse(text);
                if (!Array.isArray(rows)) throw new Error('备份分片不是数组');
                for (const row of rows) {
                    if (!row || typeof row !== 'object') throw new Error('备份记录无效');
                    const field = (key: string) => { const value = key.split('.').reduce((value, part) => value?.[part], row); return value?.__spaceDate ? new Date(value.__spaceDate) : value; };
                    const key = Array.isArray(keyPath) ? keyPath.map(field) : field(String(keyPath));
                    try { if (key !== undefined || !autoIncrement) indexedDB.cmp(key, key); }
                    catch { throw new Error(`备份记录编号无效：${store}`); }
                    await checkPacked(row);
                    if (store === 'characters') { charIds!.push(row.id); remap?.noteCharacter(row.id); }
                    if (store === 'memory_nodes' || store === 'memory_vectors') remap?.noteMemory(row);
                }
            }
            tables.push({ store, table, collab, paths });
        }
        remap?.finish();
        if (remap) space.local = remap.local(space.local);
        prepared.push({ space, db, collaboration, tables, remap, charIds: charIds?.map(id => ({ id: remap?.newId(id) ?? id })) });
    }
    await assertUniqueSpaceCharacters(new Map(prepared.filter(p => p.charIds).map(p => [p.space.id, p.charIds!])));
    stats.checkMs = performance.now() - checkStarted;

    // 3. 共享图片先逐张核对一遍：读不到文件、内存不足、大小不符、编号冲突都在第一次写库前暴露；坏图记下，写入时跳过。
    const pictureCheckStarted = performance.now();
    const pictures: Array<{ id: string; path: string; type: string; size: number }> = [];
    for (const [index, entry] of manifest.blobs.entries()) {
        report('正在核对图片', undefined, index + 1, blobTotal); unit++;
        if (!/^[a-zA-Z0-9_:.-]+$/.test(entry.id) || !SHARED_PATH.test(entry.path) || !zip.file(entry.path)) throw new Error('共享素材索引无效');
        const bytes = await readPicture(entry.path, entry.id);
        if (!bytes) continue;
        if (bytes.byteLength !== entry.size) throw new Error('共享素材文件不完整');
        const id = blobIds.get(entry.id) || entry.id;
        const existing = await DB.getBlobAsset(id);
        if (existing) {
            if (await hashBlob(existing) !== await hashBlob(new Blob([bytes], { type: entry.type }))) throw new Error('素材编号冲突，未覆盖本机素材');
            continue; // 本机已有同一份文件
        }
        pictures.push({ id, path: entry.path, type: entry.type, size: entry.size });
    }
    stats.pictureCheckMs = performance.now() - pictureCheckStarted;

    onBeforeWrite?.();
    const pictureWriteStarted = performance.now();
    for (const [index, picture] of pictures.entries()) {
        report('正在写入图片', undefined, index + 1, pictures.length); unit++;
        const bytes = await readPicture(picture.path, picture.id);
        if (!bytes) continue;
        if (bytes.byteLength !== picture.size) throw new Error('共享素材文件不完整');
        const blob = new Blob([bytes], { type: picture.type });
        await retry(async () => { if (!await DB.getBlobAsset(picture.id)) await DB.putBlobAsset(picture.id, blob); });
    }
    stats.pictureWriteMs = performance.now() - pictureWriteStarted;
    // 本机已有、核对时跳过的图片不再写，这些格子直接算完成。
    unit = pageTotal + 2 * blobTotal;

    // 4–5. 逐空间、逐表、逐页写入。
    const mergeMediaRow = async (db: IDBDatabase, store: string, row: any) => {
        const existing = await new Promise<any>((resolve, reject) => { const req = db.transaction(store).objectStore(store).get(store === 'emojis' ? row.name : row.id); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
        if (store === 'emojis') return patchEmojiOriginal(existing, row);
        if (store === 'messages' && row.type === 'emoji') return patchSentSticker(existing, row);
        if (store === 'assets') {
            if (row.id === HELP_HISTORY_KEY) return existing ? { id: row.id, data: restoreHelpMedia(existing.data, row.data) } : null;
            if (row.id === 'friend_feed_v1') return { id: row.id, data: JSON.stringify(applyFriendFeedMedia(parseFriendFeed(existing?.data ?? null), JSON.parse(row.data))) };
            return mediaAsset(row.id) ? row : null;
        }
        if (store === 'messages') return existing ? { ...existing, ...(row.type === 'image' || row.type === 'emoji' ? { content: row.content } : {}), metadata: { ...existing.metadata, ...row.metadata } } : null;
        return existing ? { ...existing, ...spaceMediaRow(store, row), ...(store === 'characters' && row.vrState ? { vrState: { ...existing.vrState, chibi: row.vrState.chibi } } : {}), ...(store === 'characters' && row.home3D ? { home3D: { ...existing.home3D, ...row.home3D } } : {}) } : null;
    };
    for (const { space, db, collaboration, tables, remap } of prepared) {
        if (!mediaOnly) prepareUserSpaceRestore(space.id, true);
        for (const { store, table, collab, paths } of tables) {
            if (mediaOnly && store === 'emoji_categories') { unit += paths.length; continue; } // 分类跟着本机已有的表情走
            const storage = collab ? collaboration : db, current = `${space.name} · ${store}`;
            const timing: RestoreTableStats = { space: space.name, store, pages: paths.length, rows: 0, clearMs: 0, readMs: 0, unpackMs: 0, writeMs: 0 };
            stats.tables.push(timing);
            if (!mediaOnly) {
                // 带索引的大表光清空就要几十秒，单独报一次，免得看起来卡住。
                report('正在清空', current);
                const clearStarted = performance.now();
                await retry(() => clearSpaceTable(storage, table, store === 'assets' ? LOCAL_ONLY_ASSETS : []));
                timing.clearMs = performance.now() - clearStarted;
            }
            for (const [index, path] of paths.entries()) {
                report('正在写入', current, index + 1, paths.length); unit++;
                let since = performance.now();
                const text = await reread<string>(() => zip.file(path).async('string'));
                timing.readMs += performance.now() - since; since = performance.now();
                let rows: any[] = await unpack(JSON.parse(text));
                if (remap) rows = rows.map(row => collab ? remap.collabRow(row) : remap.row(store, row)).filter(Boolean);
                if (mediaOnly && MEDIA_MERGE_STORES.has(store)) rows = (await Promise.all(rows.map(row => mergeMediaRow(db, store, row)))).filter(Boolean);
                timing.unpackMs += performance.now() - since; since = performance.now();
                if (rows.length) await retry(() => commitSpaceRows(storage, { [table]: rows }));
                timing.writeMs += performance.now() - since;
                timing.rows += rows.length;
            }
        }
        if (!mediaOnly && rawSpaceStorage) {
            const view = createSpaceStorage(rawSpaceStorage, space.id);
            for (const key of Object.keys(readSpaceLocal(space.id))) if (!privateLocalExcluded(key)) view.removeItem(key);
        }
        writeSpaceLocal(space.id, Object.fromEntries(Object.entries(space.local as Record<string, string>).filter(([key]) => !privateLocalExcluded(key) && (!mediaOnly || /^(os_theme|tama_style|companion_frame|companion_layout|mg_style)/.test(key)))));
    }
    report('正在收尾');
    const finishStarted = performance.now();
    const catalog = listUserSpaces();
    for (const { space } of prepared) {
        const index = catalog.findIndex(s => s.id === space.id);
        if (index < 0) catalog.push({ id: space.id, name: space.name }); else catalog[index] = { id: space.id, name: space.name };
    }
    saveUserSpaces(catalog);
    await persistSpaceCatalog();
    if (!asNewUsers && !mediaOnly) await importAmsg2GlobalConfig(manifest.backend, { allowBackendConnection });
    if (!asNewUsers && !mediaOnly) for (const [key, value] of Object.entries(manifest.settings || {})) {
        if (isSharedSpaceKey(key) && !privateLocalExcluded(key) && typeof value === 'string') rawSpaceStorage?.setItem(key, value);
    }
    if (userLocation && rawSpaceStorage) {
        for (const { space } of prepared) {
            const audience = userLocation.audiences[space.id];
            createSpaceStorage(rawSpaceStorage, space.id).setItem(USER_LOCATION_STORAGE_KEY, JSON.stringify({
                ...userLocation.settings, ...(audience === null ? {} : { characterIds: audience }),
            }));
        }
        // Invalidate any lookup/cache in the current page while keeping its own audience intact.
        (await import('./userLocation')).invalidateUserLocationContext();
    }
    stats.finishMs = performance.now() - finishStarted;
    return prepared.map(({ space }) => ({ id: space.id, name: space.name }));
}
