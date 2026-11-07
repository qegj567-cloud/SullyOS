import { DB, openSpaceDB } from './db';
import type { CharacterProfile } from '../types';
import { createLocalId } from './localId';
import { migrateDataUrlToRef } from './blobRef';
import { collectCharacterCompanionVoiceAssetIds } from './companionPresets';
import { putSharedImage } from './spaceAssets';
import { withSharedAssetLock } from './sharedAssetLock';
import { VR_LIBRARY_RECORD } from './vrWorld/library';
import { listUserSpaces, saveUserSpaces, selectUserSpace, SESSION_SPACE_ID, rawSpaceStorage, assertUserSpaceAvailable, type UserSpace } from './userSpaces';
import { beginUserSpaceTransition, cancelUserSpaceTransition } from './userSpaceTransition';

export function readSpaceStore<T = any>(db: IDBDatabase, store: string): Promise<T[]> {
    if (!db.objectStoreNames.contains(store)) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store), req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
}
export async function assertUniqueSpaceCharacters(incoming: Map<string, Array<{ id: string }>>) {
    const owners = new Map<string, string>();
    const spaces = new Set([...listUserSpaces().map(s => s.id), ...incoming.keys()]);
    for (const spaceId of spaces) {
        const chars = incoming.get(spaceId) ?? await readSpaceStore(await openSpaceDB(spaceId), 'characters');
        for (const char of chars) {
            if (owners.has(char.id) && owners.get(char.id) !== spaceId) throw new Error('备份中的角色编号已属于另一个用户空间。恢复原存档请回到原用户；从其他网址或 App 搬来，请使用设置里的「迁入独立用户」，自动新建用户并保留聊天和记忆。');
            owners.set(char.id, spaceId);
        }
    }
}
export function commitSpaceRows(db: IDBDatabase, tables: Record<string, any[]>, replace = false): Promise<void> {
    if (!Object.keys(tables).length) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(Object.keys(tables), 'readwrite');
        tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error || new Error('用户空间保存失败'));
        try {
        for (const [name, rows] of Object.entries(tables)) {
            const store = tx.objectStore(name);
            if (replace) store.clear();
            for (const row of rows) store.put(row);
        }
        } catch (error) { tx.abort(); reject(error); }
    });
}
export async function createUserSpace(name: string): Promise<UserSpace> {
    return withSharedAssetLock('exclusive', () => createUserSpaceUnderLease(name));
}
async function createUserSpaceUnderLease(name: string): Promise<UserSpace> {
    if (!name.trim()) throw new Error('请填写用户名称');
    const space = { id: createLocalId(), name: name.trim() };
    // createLocalId uses a hyphen separator; the catalog uses a restricted, portable ID.
    space.id = `u_${space.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const db = await openSpaceDB(space.id);
    await commitSpaceRows(db, { user_profile: [{ id: 'me', name: space.name, bio: '', avatar: '' }] });
    saveUserSpaces([...listUserSpaces(), space]);
    await persistSpaceCatalog();
    return space;
}
export async function persistSpaceCatalog() {
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, { assets: [{ id: 'user_spaces_catalog_v1', data: JSON.stringify(listUserSpaces()) }] });
}
export async function restoreSpaceCatalog() {
    if (rawSpaceStorage?.getItem('sully_user_spaces_v1')) return;
    const db = await openSpaceDB('default');
    const mirror = await new Promise<any>((resolve, reject) => {
        const req = db.transaction('assets').objectStore('assets').get('user_spaces_catalog_v1');
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    if (mirror?.data) saveUserSpaces(JSON.parse(mirror.data));
}
/** Called only by the existing explicit "reset all data" confirmation. */
export async function resetAllUserSpaces() {
    const { deleteCollaborationSpace } = await import('../features/collaboration/store');
    const spaces = listUserSpaces();
    if (!spaces.some(s => s.id === 'default')) spaces.push({ id: 'default', name: '共享素材' });
    // Delete the shared pool last; other spaces can still resolve their files if interrupted.
    for (const space of [...spaces.filter(s => s.id !== 'default'), ...spaces.filter(s => s.id === 'default')]) {
        await deleteCollaborationSpace(space.id);
        await DB.deleteDB(space.id);
    }
    rawSpaceStorage?.clear();
}
export async function switchUserSpace(id: string) {
    if (id === SESSION_SPACE_ID) return;
    const target = listUserSpaces().find(space => space.id === id);
    if (!target) throw new Error('用户空间不存在');
    await persistSpaceCatalog();
    await beginUserSpaceTransition(id, target.name);
    try { window.sessionStorage.setItem('sully_space_switch_notice', id); } catch { /* Optional reminder. */ }
    try {
    selectUserSpace(id);
    // Database and localStorage bindings remain pinned until the old JS environment is destroyed.
    window.location.reload();
    } catch (error) { cancelUserSpaceTransition(); throw error; }
}

const EXPERIENCE_FIELDS = [
    'refinedMemories', 'activeMemoryMonths', 'impression', 'memoryPalaceInjection', 'roomPlatesInjection',
    'activeBuffs', 'buffInjection', 'selfInsights', 'guidebookInsights', 'savedDateState', 'savedRoomState',
    'lastRoomDate', 'dreamLogs', 'specialMomentRecords', 'videoCallPerformancePersona',
    'videoCallPerformancePersonaGeneratedAt', 'homeContextBridgeVersion', 'contextFollowsMemoryPalaceHwm',
    'hideBeforeMessageId', 'contextStartMessageId', 'contextUserStartMessageId', 'userPersona',
    'writerPersona', 'writerPersonaGeneratedAt',
] as const;
export function cloneCharacterForSpace(source: CharacterProfile, id: string): CharacterProfile {
    const copy = structuredClone(source) as CharacterProfile & Record<string, any>;
    const oldChibi = copy.specialMomentRecords?.like520_2026?.customData?.charChibi as { dataUrl?: string; state?: any } | undefined;
    if (oldChibi?.dataUrl) copy.chibiStudio = { ...copy.chibiStudio, like520: { ...copy.chibiStudio?.like520, state: oldChibi.state ?? copy.chibiStudio?.like520?.state, img: oldChibi.dataUrl } };
    copy.id = id; copy.memories = [];
    for (const key of EXPERIENCE_FIELDS) delete copy[key];
    delete copy.groupId;
    if (copy.activeMsg2Config) { copy.activeMsg2Config = { ...copy.activeMsg2Config, enabled: false, tasks: [] }; delete copy.activeMsg2Config.lastSyncedAt; delete copy.activeMsg2Config.lastError; }
    if (copy.musicProfile) { copy.musicProfile.reviews = []; copy.musicProfile.recentPlays = []; delete copy.musicProfile.currentListening; }
    if (copy.phoneState) copy.phoneState = { customApps: copy.phoneState.customApps, sendToChat: copy.phoneState.sendToChat, allowFictionalContacts: copy.phoneState.allowFictionalContacts, ...(copy.phoneState.aiAgent?.cards ? { aiAgent: { cards: copy.phoneState.aiAgent.cards, sessions: [] } } : {}), records: [] };
    if (copy.vrState) {
        copy.vrState.enabled = false;
        for (const key of ['novelBookmarks', 'lastNovelId', 'currentRoom', 'lastActiveAt', 'sarModule', 'sarActivity'] as const) delete copy.vrState[key];
    }
    if (copy.home3D) {
        copy.home3D.records = []; copy.home3D.activityLog = [];
        copy.home3D.socialMemberIds = []; copy.home3D.romanticPairs = []; copy.home3D.userRomanceDisabledIds = [];
        if (copy.home3D.petLife) {
            copy.home3D.petLife.events = [];
            for (const pet of copy.home3D.petLife.pets) { pet.memory = {}; pet.relations = {}; pet.bondCooldown = 0; }
        }
    }
    return copy;
}
async function externalizeImages<T>(value: T): Promise<T> {
    if (typeof value === 'string' && value.startsWith('data:image/')) return await migrateDataUrlToRef(value) as T;
    if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) value[i] = await externalizeImages(value[i]); }
    else if (value && typeof value === 'object') for (const key of Object.keys(value)) {
        // Activity canvases still consume their archived data URLs directly.
        if (key !== 'specialMomentRecords') (value as any)[key] = await externalizeImages((value as any)[key]);
    }
    return value;
}
async function normalizeSourceRow(db: IDBDatabase, table: string, before: any, after: any) {
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(table, 'readwrite'), store = tx.objectStore(table), req = store.get(after.id);
        req.onsuccess = () => {
            if (JSON.stringify(req.result) !== JSON.stringify(before)) { tx.abort(); return; }
            store.put(after);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('来源配置已变化，请重新继承'));
    });
}
export async function inheritSpaceCharacters(sourceId: string, ids: string[]): Promise<CharacterProfile[]> {
    return withSharedAssetLock('exclusive', () => inheritSpaceCharactersUnderLease(sourceId, ids));
}
async function inheritSpaceCharactersUnderLease(sourceId: string, ids: string[]): Promise<CharacterProfile[]> {
    assertUserSpaceAvailable(sourceId);
    if (sourceId === SESSION_SPACE_ID) throw new Error('请选择另一个用户空间');
    const source = await openSpaceDB(sourceId), target = await openSpaceDB(SESSION_SPACE_ID);
    const originals = (await readSpaceStore<CharacterProfile>(source, 'characters')).filter(c => ids.includes(c.id));
    if (originals.length !== new Set(ids).size || !originals.length) throw new Error('来源角色已变化，请重新选择');
    const books = await readSpaceStore(source, 'worldbooks');
    const idMap = new Map(originals.map(c => [c.id, createLocalId()]));
    const groups = (await readSpaceStore(source, 'character_groups')).filter(g => originals.some(c => c.groupId === g.id));
    const groupIds = new Map(groups.map(g => [g.id, createLocalId()]));
    const vrSettings = await readSpaceStore(source, 'vr_settings');
    const sourceCategories: any[] = vrSettings.find(row => row.id === VR_LIBRARY_RECORD)?.categories || [];
    const selectedCategories = new Set(originals.flatMap(c => c.vrState?.preferredNovelCategoryIds || []));
    const selectedBooks = new Set(originals.flatMap(c => c.vrState?.preferredNovelIds || []));
    const novels = (await readSpaceStore(source, 'vr_novels')).filter(n => selectedBooks.has(n.id) || selectedCategories.has(n.categoryId));
    for (const novel of novels) if (novel.categoryId) selectedCategories.add(novel.categoryId);
    const categories = sourceCategories.filter(c => selectedCategories.has(c.id));
    // Missing/deleted selections also receive fresh IDs so they cannot bind to an unrelated target entry.
    const categoryIds = new Map([...selectedCategories].map(id => [id, createLocalId()]));
    const novelIds = new Map([...new Set([...selectedBooks, ...novels.map(n => n.id)])].map(id => [id, createLocalId()]));
    const parts = await readSpaceStore(source, 'cc_custom_parts');
    const themes = await readSpaceStore(source, 'themes');
    const layouts = (await readSpaceStore(source, 'pixel_home_layouts')).filter(row => idMap.has(row.charId))
        .map(row => ({ ...row, charId: idMap.get(row.charId) }));
    const pixelAssets = await readSpaceStore(source, 'pixel_home_assets');
    for (const [storeName, rows] of [['cc_custom_parts', parts], ['themes', themes], ['pixel_home_assets', pixelAssets]] as const) {
        for (const row of rows) {
            const before = JSON.stringify(row);
            await externalizeImages(row);
            if (JSON.stringify(row) !== before) await new Promise<void>((resolve, reject) => {
                const tx = source.transaction(storeName, 'readwrite'), store = tx.objectStore(storeName), req = store.get(row.id);
                req.onsuccess = () => { if (JSON.stringify(req.result) !== before) { tx.abort(); return; } store.put(row); };
                tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error || new Error('来源素材已变化，请重新继承'));
            });
        }
    }
    const sourceAssets = await readSpaceStore(source, 'assets');
    const roomAssetsRow = sourceAssets.find(row => row.id === 'room_custom_assets_list');
    const sourceRoomAssets = roomAssetsRow ? JSON.parse(roomAssetsRow.data) : [];
    const roomAssets = sourceRoomAssets.filter((row: any) => !row.visibility || row.visibility === 'public' || row.assignedCharIds?.some((id: string) => idMap.has(id)));
    for (const room of roomAssets) { room.id ||= createLocalId(); await externalizeImages(room); }
    if (roomAssetsRow && JSON.stringify(sourceRoomAssets) !== roomAssetsRow.data) {
        await normalizeSourceRow(source, 'assets', roomAssetsRow, { ...roomAssetsRow, data: JSON.stringify(sourceRoomAssets) });
    }
    const inheritedAssets: any[] = [];
    const bookIds = new Map<string, string>(), copiedBooks: any[] = [];
    const dependencyMap = new Map<string, string>();
    for (const row of [...parts, ...themes, ...pixelAssets, ...roomAssets]) if (typeof row.id === 'string') dependencyMap.set(row.id, createLocalId());
    for (const voiceId of collectCharacterCompanionVoiceAssetIds(originals)) {
        const row = sourceAssets.find(row => row.id === voiceId);
        const blob = row?.data instanceof Blob ? row.data : row?.data?.blob || await DB.getBlobAsset(voiceId);
        const blobRef = row?.data?.blobRef || (blob instanceof Blob ? await putSharedImage(blob) : undefined);
        if (!blobRef) throw new Error('角色的陪伴语音素材缺失，请先在来源空间检查');
        const data = { ...row?.data, blob: undefined, blobRef, mimeType: blob?.type || row?.data?.mimeType };
        await normalizeSourceRow(source, 'assets', row, { id: voiceId, data });
        const nextId = `${voiceId}:${createLocalId()}`;
        dependencyMap.set(voiceId, nextId); inheritedAssets.push({ id: nextId, data });
    }
    const creatorMaps = new Set(['selected', 'itemColor', 'flipped', 'activeItemFocus']);
    const remap = (value: any, field = '', creatorMap = false): any => {
        // Only references may change: a name/prompt/CSS string equal to a theme ID is still text.
        if (typeof value === 'string') return creatorMap || field === 'id' || field === 'bubbleStyle' || /Ids?$/.test(field) ? dependencyMap.get(value) || value : value;
        if (Array.isArray(value)) return value.map(v => remap(v, field, creatorMap));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [creatorMap ? dependencyMap.get(key) || key : key, remap(v, key, creatorMap || creatorMaps.has(key))]));
        return value;
    };
    const chars: CharacterProfile[] = [];
    for (const original of originals) {
        const copy = cloneCharacterForSpace(original, idMap.get(original.id)!);
        copy.groupId = original.groupId ? groupIds.get(original.groupId) : undefined;
        if (copy.vrState) {
            copy.vrState.preferredNovelIds = copy.vrState.preferredNovelIds?.map(id => novelIds.get(id)!);
            copy.vrState.preferredNovelCategoryIds = copy.vrState.preferredNovelCategoryIds?.map(id => categoryIds.get(id)!);
        }
        copy.mountedWorldbooks = (copy.mountedWorldbooks || []).map(wb => {
            const oldId = wb.id;
            let newId = bookIds.get(oldId);
            if (!newId) {
                newId = createLocalId(); bookIds.set(oldId, newId);
                const book = books.find(b => b.id === oldId);
                if (book) copiedBooks.push({ ...book, id: newId });
            }
            return { ...wb, id: newId };
        });
        chars.push(await externalizeImages(remap(copy)));
    }
    if (roomAssets.length) {
        const targetAssets = await readSpaceStore(target, 'assets');
        const previous = targetAssets.find(row => row.id === 'room_custom_assets_list');
        const migrated = await externalizeImages(remap(roomAssets.map((row: any) => ({ ...row, assignedCharIds: row.assignedCharIds?.filter((id: string) => idMap.has(id)).map((id: string) => idMap.get(id)) }))));
        inheritedAssets.push({ id: 'room_custom_assets_list', data: JSON.stringify([...(previous ? JSON.parse(previous.data) : []), ...migrated]) });
    }
    // Shared bytes already exist; only independent records are committed in this transaction.
    // Source image representations can be normalized without copying its experiences.
    for (const original of originals) {
        const fingerprint = JSON.stringify(original), normalized = await externalizeImages(structuredClone(original));
        if (JSON.stringify(normalized) !== fingerprint) await new Promise<void>((resolve, reject) => {
            const tx = source.transaction('characters', 'readwrite'), store = tx.objectStore('characters'), req = store.get(original.id);
            req.onsuccess = () => { if (JSON.stringify(req.result) !== fingerprint) { tx.abort(); return; } store.put(normalized); };
            tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error || new Error('来源角色已修改，请重新继承'));
        });
    }
    await commitSpaceRows(target, {
        characters: chars, worldbooks: copiedBooks,
        character_groups: groups.map(g => ({ ...g, id: groupIds.get(g.id) })),
        vr_novels: novels.map(n => ({ ...n, id: novelIds.get(n.id), categoryId: categoryIds.get(n.categoryId) })),
        vr_settings: categories.length ? [{ id: VR_LIBRARY_RECORD, categories: [
            ...((await readSpaceStore(target, 'vr_settings')).find(row => row.id === VR_LIBRARY_RECORD)?.categories || []),
            ...categories.map(c => ({ ...c, id: categoryIds.get(c.id) })),
        ] }] : [],
        assets: inheritedAssets,
        cc_custom_parts: await externalizeImages(remap(parts)), themes: await externalizeImages(remap(themes)),
        pixel_home_assets: await externalizeImages(remap(pixelAssets)), pixel_home_layouts: await externalizeImages(remap(layouts)),
    });
    return chars;
}
