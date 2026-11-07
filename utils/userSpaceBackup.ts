import { hashBlob, dataUrlToBlob, blobToDataUrl } from '@rei-standard/blob-store';
import { DB, openSpaceDB } from './db';
import { createBackupArchive } from './backupArchive';
import { collectBlobRefs } from './backupBlobs';
import { listUserSpaces, SESSION_SPACE_ID, readSpaceLocal, writeSpaceLocal, rawSpaceStorage, isSharedSpaceKey, saveUserSpaces, sharedSettingForBackup, createSpaceStorage, prepareUserSpaceRestore, assertUserSpaceAvailable, type UserSpace } from './userSpaces';
import { exportAmsg2GlobalConfig, importAmsg2GlobalConfig } from './activeMsgStore';
import { openCollaborationSpace, deleteCollaborationSpace } from '../features/collaboration/store';
import { commitSpaceRows, persistSpaceCatalog, assertUniqueSpaceCharacters } from './userSpaceData';
import { collectFriendFeedMedia, applyFriendFeedMedia, isActivityTextAsset } from './activityBackup';
import { parseFriendFeed } from './friendFeed';
import { exportDecorationMedia, restoreDecorationMedia } from './decorationMediaBackup';
import { shouldIncludeVoiceRelatedAssetInBackup } from './voiceMessageBackup';
import { isCompanionVoiceAssetId } from './companionVoiceAssets';
import { collectCharacterCompanionVoiceAssetIds } from './companionPresets';
import { withSharedAssetLock } from './sharedAssetLock';
import { backupAssetField, backupAssetSource, recordMissingBackupAsset, writeMissingBackupAssets, type BackupMissingAsset } from './backupMissingAssets';
import { newImportedSpaceId, newImportedBlobId, remapIndependentUser } from './independentUserImport';

type Mode = 'full' | 'text_only' | 'media_only';
interface SpaceArchive {
    format: 'sully-user-spaces'; version: 1; mode: Mode;
    spaces: Array<UserSpace & { local: Record<string, string>; stores: Record<string, string[]> }>;
    settings: Record<string, string>;
    backend?: Awaited<ReturnType<typeof exportAmsg2GlobalConfig>>;
    blobs: Array<{ id: string; path: string; type: string; size: number }>;
    missingAssets?: BackupMissingAsset[];
}
const mediaStores = new Set(['characters', 'user_profile', 'themes', 'emojis', 'emoji_categories', 'journal_stickers', 'gallery', 'cc_custom_parts', 'pixel_home_assets', 'pixel_home_layouts', 'messages', 'assets', 'collab_assets', 'daily_schedule', 'bank_data']);
const mediaAsset = (id: string) => id === 'friend_feed_v1' || !isActivityTextAsset(id);
const privateLocalExcluded = (key: string) => /location|geolocation|latitude|longitude|privacy|user_spaces_catalog|import.*progress/i.test(key);
export function spaceMediaRow(store: string, row: any) {
    if (store === 'characters') {
        const keys = ['id', 'avatar', 'sprites', 'dateSkinSets', 'activeSkinSetId', 'customDateSprites', 'spriteConfig', 'chibiStudio', 'videoAvatar', 'videoAvatarWardrobe', 'companionAvatar', 'companionTouchSettings', 'companionBackground', 'videoCallBackground', 'dateBackground', 'roomConfig'];
        const homeKeys = ['version', 'assetVersion', 'roomSizeVersion', 'homePalette', 'rooms'];
        return { ...Object.fromEntries(keys.filter(k => row[k] !== undefined).map(k => [k, row[k]])), ...restoreDecorationMedia(exportDecorationMedia(row)), ...(row.vrState?.chibi ? { vrState: { chibi: row.vrState.chibi } } : {}), ...(row.home3D ? { home3D: Object.fromEntries(homeKeys.filter(k => row.home3D[k] !== undefined).map(k => [k, row.home3D[k]])) } : {}) };
    }
    if (store === 'messages') return { id: row.id, charId: row.charId, role: row.role, timestamp: row.timestamp, type: row.type, content: row.type === 'image' || row.type === 'emoji' ? row.content : '', metadata: row.metadata?.cameraSnapshotRef || row.metadata?.cameraSnapshotExpired ? { cameraSnapshotRef: row.metadata.cameraSnapshotRef, cameraSnapshotExpired: row.metadata.cameraSnapshotExpired } : undefined };
    if (store === 'user_profile') return { id: row.id, avatar: row.avatar, perCharAvatars: row.perCharAvatars, chibiStudio: row.chibiStudio };
    if (store === 'daily_schedule') return { id: row.id, coverImage: row.coverImage };
    if (store === 'assets' && row.id === 'friend_feed_v1') return { id: row.id, data: JSON.stringify(collectFriendFeedMedia(parseFriendFeed(row.data))) };
    return row;
}

/** One ZIP for all spaces; metadata is streamed in bounded pages, bytes deduped by content. */
export async function exportUserSpaces(mode: Mode, scope: 'current' | 'all', onProgress?: (text: string) => void, includeBackendConnection = false, onMissingAssets?: (items: BackupMissingAsset[]) => void): Promise<Blob> {
    return withSharedAssetLock('shared', () => exportUserSpacesUnderLease(mode, scope, onProgress, includeBackendConnection, onMissingAssets));
}
async function exportUserSpacesUnderLease(mode: Mode, scope: 'current' | 'all', onProgress: ((text: string) => void) | undefined, includeBackendConnection: boolean, onMissingAssets?: (items: BackupMissingAsset[]) => void): Promise<Blob> {
    const zip = createBackupArchive(), files = new Set<string>(), refs = new Set<string>();
    const manifest: SpaceArchive = { format: 'sully-user-spaces', version: 1, mode, spaces: [], settings: {}, blobs: [] };
    const addBytes = async (blob: Blob): Promise<string> => {
        const hash = await hashBlob(blob), path = `shared/${hash.replace(/[^a-zA-Z0-9_-]/g, '')}.bin`;
        if (!files.has(path)) { zip.fileBlob(path, blob, { compression: 'STORE' }); files.add(path); }
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
        const characters = await new Promise<any[]>((resolve, reject) => { const request = db.transaction('characters').objectStore('characters').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        const voiceIds = collectCharacterCompanionVoiceAssetIds(characters);
        const characterNames = new Map<string, string>(characters.map(character => [character.id, character.name]));
        const local = Object.fromEntries(Object.entries(readSpaceLocal(space.id)).filter(([k]) => !privateLocalExcluded(k) && (mode !== 'media_only' || /^(os_theme|tama_style|companion_frame|companion_layout|mg_style)/.test(k))));
        const entry = { ...space, local: await pack(local, '', backupAssetSource(space.name, 'local')), stores: {} as Record<string, string[]> };
        const collaboration = await openCollaborationSpace(space.id);
        for (const [prefix, database] of [['', db], ['collab_', collaboration]] as const) for (const tableName of Array.from(database.objectStoreNames)) {
            const store = prefix + tableName;
            if (store === 'blob_assets' || store === 'api_call_log' || (mode === 'media_only' && !mediaStores.has(store))) continue;
            let after: IDBValidKey | undefined, part = 0;
            entry.stores[store] = [];
            for (;;) {
                onProgress?.(`正在读取 ${space.name} · ${store}`);
                const page = await new Promise<{ rows: any[]; keys: IDBValidKey[] }>((resolve, reject) => {
                    const tx = database.transaction(tableName), table = tx.objectStore(tableName), range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
                    const rows = table.getAll(range, 100), keys = table.getAllKeys(range, 100);
                    tx.oncomplete = () => resolve({ rows: rows.result, keys: keys.result }); tx.onerror = tx.onabort = () => reject(tx.error);
                });
                const rows = page.rows.filter(r => !(store === 'assets' && (r.id === 'ls_mirror_v1' || r.id === 'user_spaces_catalog_v1')))
                    .filter(r => store !== 'assets' || shouldIncludeVoiceRelatedAssetInBackup(r, mode !== 'text_only') && (!isCompanionVoiceAssetId(r.id) || voiceIds.has(r.id)))
                    .filter(r => mode !== 'media_only' || store !== 'assets' || mediaAsset(r.id))
                    .filter(r => mode !== 'media_only' || store !== 'bank_data' || r.id === 'dollhouse_state')
                    .filter(r => mode !== 'media_only' || store !== 'daily_schedule' || r.coverImage)
                    .filter(r => mode !== 'media_only' || store !== 'messages' || r.type === 'image' || r.type === 'emoji' || r.metadata?.cameraSnapshotRef || r.metadata?.cameraSnapshotExpired);
                const processed = [];
                for (const row of rows) processed.push(await pack(mode === 'media_only' ? spaceMediaRow(store, row) : row, '', backupAssetSource(space.name, store, row, characterNames)));
                const text = JSON.stringify(processed); collectBlobRefs(text, refs);
                const path = `spaces/${space.id}/${store}.${part++}.json`;
                zip.file(path, text); entry.stores[store].push(path);
                if (page.rows.length < 100) break;
                after = page.keys.at(-1);
            }
        }
        collectBlobRefs(JSON.stringify(entry.local), refs); manifest.spaces.push(entry);
    }
    if (mode !== 'media_only' && rawSpaceStorage) {
        for (let i = 0; i < rawSpaceStorage.length; i++) {
            const key = rawSpaceStorage.key(i)!;
            if (isSharedSpaceKey(key) && !privateLocalExcluded(key)) manifest.settings[key] = sharedSettingForBackup(key, rawSpaceStorage.getItem(key)!);
        }
    }
    if (mode !== 'text_only') for (const ref of refs) await addAsset(ref.slice('blobref:'.length));
    if (mode !== 'media_only') manifest.backend = await exportAmsg2GlobalConfig({ includeBackendConnection });
    const missing = [...missingAssets.values()];
    if (missing.length) manifest.missingAssets = missing;
    writeMissingBackupAssets(zip, missing);
    zip.file('user-spaces.json', JSON.stringify(manifest));
    onProgress?.('正在压缩共享素材与用户空间');
    const result = await zip.generateBlob();
    onMissingAssets?.(missing);
    return result;
}

/** Preflight every file and store before any live writes. Each space commits atomically. */
export async function importUserSpaces(zip: any, allowBackendConnection = false, options: { asNewUsers?: boolean } = {}): Promise<UserSpace[]> {
    return withSharedAssetLock('exclusive', async () => {
        const created: string[] = [];
        try { return await importUserSpacesUnderLease(zip, allowBackendConnection, options.asNewUsers === true, created); }
        catch (error) {
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
                    } catch (cleanupError) { console.warn('迁入临时用户清理未完成', cleanupError); }
                }
                const catalog = listUserSpaces();
                if (catalog.some(space => created.includes(space.id))) {
                    saveUserSpaces(catalog.filter(space => !created.includes(space.id)));
                    try { await persistSpaceCatalog(); } catch { /* Preserve the original failure. */ }
                }
            }
            throw error;
        }
    });
}
async function importUserSpacesUnderLease(zip: any, allowBackendConnection: boolean, asNewUsers: boolean, created: string[]): Promise<UserSpace[]> {
    const manifest = JSON.parse(await zip.file('user-spaces.json').async('string')) as SpaceArchive;
    if (manifest.format !== 'sully-user-spaces' || manifest.version !== 1 || !['full', 'text_only', 'media_only'].includes(manifest.mode)
        || !Array.isArray(manifest.spaces) || !manifest.spaces.length || !Array.isArray(manifest.blobs)) throw new Error('用户空间备份格式无效');
    if (asNewUsers && manifest.mode === 'media_only') throw new Error('独立用户迁入需要整合或文字备份，媒体补图包不包含完整存档');
    const blobIds = new Map<string, string>(asNewUsers ? manifest.blobs.map(entry => [entry.id, newImportedBlobId()]) : []);
    const occupiedSpaceIds = new Set(listUserSpaces().map(space => space.id));
    if (asNewUsers && indexedDB.databases) for (const database of await indexedDB.databases()) {
        const match = /^(?:AetherOS_Data|SullyOS_Collaboration)__(u_[a-zA-Z0-9_-]+)$/.exec(database.name || '');
        if (match) occupiedSpaceIds.add(match[1]);
    }
    const unique = new Set<string>();
    const unpack = async (v: any): Promise<any> => {
        if (typeof v === 'string' && /^\s*[\[{]/.test(v)) {
            try {
                const parsed = JSON.parse(v), next = await unpack(parsed);
                return JSON.stringify(next) === JSON.stringify(parsed) ? v : JSON.stringify(next);
            }
            catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        }
        if (v?.__spaceDataURL) {
            if (!/^shared\/[a-zA-Z0-9_-]+\.bin$/.test(v.__spaceDataURL) || !zip.file(v.__spaceDataURL) || typeof v.header !== 'string' || !/^data:[^,]*;base64,$/.test(v.header)) throw new Error('备份内嵌素材无效');
            const url = await blobToDataUrl(new Blob([await zip.file(v.__spaceDataURL).async('uint8array')], { type: v.type || '' }));
            return v.header + url.slice(url.indexOf(',') + 1);
        }
        if (v?.__spaceDate) { const date = new Date(v.__spaceDate); if (!Number.isFinite(date.getTime())) throw new Error('备份日期无效'); return date; }
        if (v?.__spaceBinary) {
            if (!/^shared\/[a-zA-Z0-9_-]+\.bin$/.test(v.__spaceBinary) || !zip.file(v.__spaceBinary)) throw new Error('备份二进制文件缺失');
            const bytes = await zip.file(v.__spaceBinary).async('uint8array');
            if (v.arrayType) {
                if (v.arrayType === 'ArrayBuffer') return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                const constructors = { Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array };
                const Constructor = constructors[v.arrayType as keyof typeof constructors];
                if (!Constructor) throw new Error('备份向量类型无效');
                return new Constructor(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
            }
            return new Blob([bytes], { type: v.type || '' });
        }
        if (Array.isArray(v)) return Promise.all(v.map(unpack));
        if (v && typeof v === 'object') { const out: any = Object.create(null); for (const [k, value] of Object.entries(v)) out[k] = await unpack(value); return out; }
        return v;
    };
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
        if (manifest.mode === 'media_only') assertUserSpaceAvailable(space.id);
        else prepareUserSpaceRestore(space.id);
        const db = await openSpaceDB(space.id), tables: Record<string, any[]> = Object.create(null);
        const collaboration = await openCollaborationSpace(space.id), collabTables: Record<string, any[]> = Object.create(null);
        for (const [store, paths] of Object.entries(space.stores)) {
            const storage = store.startsWith('collab_') ? collaboration : db;
            const table = store.startsWith('collab_') ? store.slice(7) : store;
            if (!storage.objectStoreNames.contains(table) || store === 'blob_assets' || !Array.isArray(paths) || manifest.mode === 'media_only' && !mediaStores.has(store)) throw new Error('备份数据表无效');
            tables[store] = [];
            for (const path of paths) {
                if (!path.startsWith(`spaces/${sourceId}/${store}.`) || !/^spaces\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_]+\.\d+\.json$/.test(path) || !zip.file(path)) throw new Error('备份分片缺失');
                const rows = await unpack(JSON.parse(await zip.file(path).async('string')));
                if (!Array.isArray(rows)) throw new Error('备份分片不是数组');
                const definition = storage.transaction(table).objectStore(table);
                for (const row of rows) {
                    if (!row || typeof row !== 'object') throw new Error('备份记录无效');
                    const field = (key: string) => key.split('.').reduce((value, part) => value?.[part], row);
                    const key = Array.isArray(definition.keyPath) ? definition.keyPath.map(field) : field(String(definition.keyPath));
                    try { if (key !== undefined || !definition.autoIncrement) indexedDB.cmp(key, key); }
                    catch { throw new Error(`备份记录编号无效：${store}`); }
                }
                tables[store].push(...rows);
            }
        }
        for (const key of Object.keys(tables)) if (key.startsWith('collab_')) { collabTables[key.slice(7)] = tables[key]; delete tables[key]; }
        const migrated = asNewUsers ? remapIndependentUser(tables, collabTables, space.local, blobIds) : { tables, collabTables, local: space.local };
        space.local = migrated.local;
        prepared.push({ space, db, tables: migrated.tables, collaboration, collabTables: migrated.collabTables });
    }
    await assertUniqueSpaceCharacters(new Map(prepared.filter(p => p.tables.characters).map(p => [p.space.id, p.tables.characters])));
    const blobs: Array<{ id: string; blob: Blob }> = [];
    for (const entry of manifest.blobs) {
        if (!/^[a-zA-Z0-9_:.-]+$/.test(entry.id) || !/^shared\/[a-zA-Z0-9_-]+\.bin$/.test(entry.path) || !zip.file(entry.path)) throw new Error('共享素材索引无效');
        const bytes = await zip.file(entry.path).async('uint8array');
        if (bytes.byteLength !== entry.size) throw new Error('共享素材文件不完整');
        const blob = new Blob([bytes], { type: entry.type });
        const id = blobIds.get(entry.id) || entry.id;
        const existing = await DB.getBlobAsset(id);
        if (existing && await hashBlob(existing) !== await hashBlob(blob)) throw new Error('素材编号冲突，未覆盖本机素材');
        blobs.push({ id, blob });
    }
    for (const { space, db, tables, collaboration, collabTables } of prepared) {
        if (manifest.mode === 'media_only') {
            for (const [store, rows] of Object.entries(tables)) {
                if (store !== 'characters' && store !== 'user_profile' && store !== 'messages' && store !== 'assets' && store !== 'daily_schedule') continue;
                tables[store] = await Promise.all(rows.map(async row => {
                    const existing = await new Promise<any>((resolve, reject) => { const req = db.transaction(store).objectStore(store).get(row.id); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
                    if (store === 'assets') {
                        if (row.id === 'friend_feed_v1') return { id: row.id, data: JSON.stringify(applyFriendFeedMedia(parseFriendFeed(existing?.data ?? null), JSON.parse(row.data))) };
                        return mediaAsset(row.id) ? row : null;
                    }
                    if (store === 'messages') return existing ? { ...existing, ...(row.type === 'image' || row.type === 'emoji' ? { content: row.content } : {}), metadata: { ...existing.metadata, ...row.metadata } } : null;
                    return existing ? { ...existing, ...spaceMediaRow(store, row), ...(store === 'characters' && row.vrState ? { vrState: { ...existing.vrState, chibi: row.vrState.chibi } } : {}), ...(store === 'characters' && row.home3D ? { home3D: { ...existing.home3D, ...row.home3D } } : {}) } : null;
                })).then(rows => rows.filter(Boolean));
            }
        }
    }
    for (const entry of blobs) if (!await DB.getBlobAsset(entry.id)) await DB.putBlobAsset(entry.id, entry.blob);
    for (const { space, db, tables, collaboration, collabTables } of prepared) {
        if (manifest.mode !== 'media_only') prepareUserSpaceRestore(space.id, true);
        if (Object.keys(collabTables).length) await commitSpaceRows(collaboration, collabTables, manifest.mode !== 'media_only');
        await commitSpaceRows(db, tables, manifest.mode !== 'media_only');
        if (manifest.mode !== 'media_only' && rawSpaceStorage) {
            const view = createSpaceStorage(rawSpaceStorage, space.id);
            for (const key of Object.keys(readSpaceLocal(space.id))) if (!privateLocalExcluded(key)) view.removeItem(key);
        }
        writeSpaceLocal(space.id, Object.fromEntries(Object.entries(space.local as Record<string, string>).filter(([key]) => !privateLocalExcluded(key) && (manifest.mode !== 'media_only' || /^(os_theme|tama_style|companion_frame|companion_layout|mg_style)/.test(key)))));
    }
    const catalog = listUserSpaces();
    for (const { space } of prepared) {
        const index = catalog.findIndex(s => s.id === space.id);
        if (index < 0) catalog.push({ id: space.id, name: space.name }); else catalog[index] = { id: space.id, name: space.name };
    }
    saveUserSpaces(catalog);
    await persistSpaceCatalog();
    if (!asNewUsers && manifest.mode !== 'media_only') await importAmsg2GlobalConfig(manifest.backend, { allowBackendConnection });
    if (!asNewUsers && manifest.mode !== 'media_only') for (const [key, value] of Object.entries(manifest.settings || {})) {
        if (isSharedSpaceKey(key) && !privateLocalExcluded(key) && typeof value === 'string') rawSpaceStorage?.setItem(key, value);
    }
    return prepared.map(({ space }) => ({ id: space.id, name: space.name }));
}
