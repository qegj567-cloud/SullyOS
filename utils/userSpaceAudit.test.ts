import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DB, openSpaceDB } from './db';
import { commitSpaceRows, inheritSpaceCharacters, readSpaceStore } from './userSpaceData';
import { createSpaceStorage, saveUserSpaces, spaceCreatorDraftKey, spaceStorageEventKey, SESSION_SPACE_ID } from './userSpaces';
import { findCharacterSpace, routeCharacterNotification, takeSpaceNotificationTarget } from './userSpaceNavigation';
import { putSharedImage } from './spaceAssets';
import { withSharedAssetLock } from './sharedAssetLock';
import { allSpaceCharacters, collectSpaceToolSettings } from './userSpaceCloudSettings';
import * as blobRefs from './blobRef';

beforeEach(async () => {
    localStorage.clear();
    saveUserSpaces([{ id: 'default', name: 'A' }, { id: 'u_audit', name: 'B' }]);
    for (const id of ['default', 'u_audit']) {
        const db = await openSpaceDB(id);
        await commitSpaceRows(db, Object.fromEntries(Array.from(db.objectStoreNames).filter(n => n !== 'blob_assets').map(n => [n, []])), true);
    }
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('pins late memory/vector/high-water writes to their original space', async () => {
    const a = await openSpaceDB('default'), b = await openSpaceDB('u_audit');
    const storageA = createSpaceStorage(localStorage, 'default'), storageB = createSpaceStorage(localStorage, 'u_audit');
    for (const [db, value] of [[a, 'A'], [b, 'B']] as const) {
        await commitSpaceRows(db, {
            memory_nodes: [{ id: 'same', charId: value, content: value }],
            memory_vectors: [{ memoryId: 'same', charId: value, vector: new Float32Array([value === 'A' ? 1 : 2]) }],
            assets: [{ id: 'mp_hwm_v1_same', data: value }],
        });
    }
    storageB.setItem('mp_hwm_v1_same', '20');
    localStorage.setItem('sully_active_user_space_v1', 'u_audit');
    await commitSpaceRows(a, { memory_nodes: [{ id: 'same', charId: 'A', content: 'late A' }] });
    storageA.setItem('mp_hwm_v1_same', '99');
    expect((await readSpaceStore(b, 'memory_nodes'))[0].content).toBe('B');
    expect((await readSpaceStore(b, 'memory_vectors'))[0].vector).toEqual(new Float32Array([2]));
    expect((await readSpaceStore(b, 'assets'))[0].data).toBe('B');
    expect(storageB.getItem('mp_hwm_v1_same')).toBe('20');
    expect(SESSION_SPACE_ID).toBe('default');
});

it('filters cross-tab storage events and scopes same-name embedded creator drafts', () => {
    expect(spaceStorageEventKey('os_dream_collection', 'u_audit')).toBeUndefined();
    expect(spaceStorageEventKey('sully_space:u_audit:os_dream_collection', 'u_audit')).toBe('os_dream_collection');
    expect(spaceStorageEventKey('sully_space:u_audit:os_dream_collection', 'default')).toBeUndefined();
    expect(spaceStorageEventKey('os_api_config', 'u_audit')).toBe('os_api_config');
    expect(spaceStorageEventKey('sully_active_user_space_v1', 'default')).toBeUndefined();
    expect(spaceCreatorDraftKey('same', 'char', 'C', 'u_audit')).not.toBe(spaceCreatorDraftKey('same', 'char', 'C', 'default'));
});

it('routes notification to its owner without changing any character schedule or making requests', async () => {
    const source = await openSpaceDB('u_audit');
    const char = { id: 'notified', activeMsg2Config: { enabled: true, tasks: [{ id: 7, text: 'keep' }] } };
    await commitSpaceRows(source, { characters: [char] });
    const sessionStorage = createSpaceStorage(localStorage, 'default');
    const reload = vi.fn(), fetch = vi.fn();
    vi.stubGlobal('window', { sessionStorage, location: { reload } }); vi.stubGlobal('fetch', fetch);
    expect(await findCharacterSpace('notified')).toBe('u_audit');
    expect(await routeCharacterNotification('notified')).toBe('switching');
    expect(reload).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
    expect(localStorage.getItem('sully_active_user_space_v1')).toBe('u_audit');
    expect(JSON.parse(sessionStorage.getItem('sully_space_notification_target_v1')!)).toEqual({ spaceId: 'u_audit', charId: 'notified' });
    expect(await readSpaceStore(source, 'characters')).toEqual([char]);
    expect(takeSpaceNotificationTarget()).toBeNull(); // old page cannot consume the new page's destination
    sessionStorage.setItem('sully_space_notification_target_v1', JSON.stringify({ spaceId: 'default', charId: 'here' }));
    expect(takeSpaceNotificationTarget()).toBe('here'); expect(takeSpaceNotificationTarget()).toBeNull();
    sessionStorage.setItem('sully_space_notification_target_v1', '{bad');
    expect(takeSpaceNotificationTarget()).toBeNull();
});

it('refuses ambiguous notification ownership and leaves missing characters alone', async () => {
    expect(await routeCharacterNotification('gone')).toBe('missing');
    for (const id of ['default', 'u_audit']) await commitSpaceRows(await openSpaceDB(id), { characters: [{ id: 'duplicate' }] });
    await expect(findCharacterSpace('duplicate')).rejects.toThrow('两个用户空间');
});

it('copies reading dependencies and legacy public furniture, keeping prose intact and experiences absent', async () => {
    const source = await openSpaceDB('u_audit');
    await commitSpaceRows(source, {
        characters: [{ id: 'source', name: 'default', description: 'default', systemPrompt: 'default', groupId: 'folder', memories: [{ summary: 'old' }],
            vrState: { preferredNovelIds: ['book'], preferredNovelCategoryIds: ['cat', 'empty'], novelReadingMode: 'categories', novelBookmarks: { book: 3 } },
            chibiStudio: { like520: { state: { selected: { hair: 'part' }, itemColor: { part: { hueIdx: 3 } } } } },
            bubbleStyle: 'default' }],
        themes: [{ id: 'default', name: 'default', css: 'default' }],
        cc_custom_parts: [{ id: 'part', name: 'part' }],
        character_groups: [{ id: 'folder', name: 'friends' }],
        vr_novels: [{ id: 'book', title: 'Novel', categoryId: 'cat', segments: [{ idx: 0, text: 'original' }] }],
        vr_settings: [{ id: 'library-categories-v1', categories: [{ id: 'cat', name: 'C' }, { id: 'empty', name: 'Empty' }] }],
        vr_annotations: [{ id: 'old-annotation', novelId: 'book', text: 'old experience' }],
        assets: [{ id: 'room_custom_assets_list', data: JSON.stringify([{ name: 'legacy', image: 'data:image/png;base64,eA==' }]) }],
    });
    const [copy] = await inheritSpaceCharacters('u_audit', ['source']);
    const target = await openSpaceDB('default');
    expect(copy).toMatchObject({ name: 'default', description: 'default', systemPrompt: 'default', memories: [] });
    expect(copy.groupId).toBe((await readSpaceStore(target, 'character_groups'))[0].id);
    expect(copy.vrState?.novelBookmarks).toBeUndefined();
    const [book] = await readSpaceStore(target, 'vr_novels');
    expect(copy.vrState?.preferredNovelIds).toEqual([book.id]); expect(book.id).not.toBe('book');
    expect(copy.vrState?.preferredNovelCategoryIds).toContain(book.categoryId);
    expect((await readSpaceStore(target, 'vr_settings'))[0].categories).toHaveLength(2);
    expect(await readSpaceStore(target, 'vr_annotations')).toEqual([]);
    const [theme] = await readSpaceStore(target, 'themes');
    expect(theme.name).toBe('default'); expect(theme.css).toBe('default'); expect(copy.bubbleStyle).toBe(theme.id);
    const [part] = await readSpaceStore(target, 'cc_custom_parts');
    expect((copy.chibiStudio?.like520?.state as any).selected.hair).toBe(part.id);
    expect((copy.chibiStudio?.like520?.state as any).itemColor[part.id]).toEqual({ hueIdx: 3 });
    const rooms = JSON.parse(await DB.getAssetRaw('room_custom_assets_list'));
    const sourceRooms = JSON.parse((await readSpaceStore(source, 'assets')).find(r => r.id === 'room_custom_assets_list').data);
    expect(rooms[0].id).not.toBe(sourceRooms[0].id); expect(rooms[0].image).toBe(sourceRooms[0].image);
});

it('does not overwrite an alias even when two different files race for the same ID', async () => {
    const result = await Promise.allSettled([
        DB.putBlobAsset('audit-race', new Blob(['one'])), DB.putBlobAsset('audit-race', new Blob(['two'])),
    ]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const original = await (await DB.getBlobAsset('audit-race'))!.text();
    await expect(DB.putBlobAsset('audit-race', new Blob(['replacement']))).rejects.toThrow();
    expect(await (await DB.getBlobAsset('audit-race'))!.text()).toBe(original);
});

it('aborts inheritance if the source is edited during image normalization', async () => {
    const source = await openSpaceDB('u_audit');
    const original = { id: 'editing', name: 'before', avatar: 'data:image/png;base64,eA==', memories: [] };
    await commitSpaceRows(source, { characters: [original] });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(blobRefs, 'migrateDataUrlToRef').mockImplementationOnce(async () => { entered(); await gate; return 'blobref:fixture'; });
    const copying = inheritSpaceCharacters('u_audit', ['editing']);
    const rejected = expect(copying).rejects.toThrow('来源角色已修改');
    await ready;
    await commitSpaceRows(source, { characters: [{ ...original, name: 'edited meanwhile' }] });
    release(); await rejected;
    expect((await readSpaceStore(source, 'characters'))[0].name).toBe('edited meanwhile');
    expect(await readSpaceStore(await openSpaceDB('default'), 'characters')).toEqual([]);
});

it('keeps global worker tools and credential maintenance available to characters in all spaces', async () => {
    await commitSpaceRows(await openSpaceDB('default'), { characters: [{ id: 'a', name: 'A' }] });
    await commitSpaceRows(await openSpaceDB('u_audit'), { characters: [{ id: 'b', name: 'B' }] });
    const a = createSpaceStorage(localStorage, 'default'), b = createSpaceStorage(localStorage, 'u_audit');
    const server: any = { id: 'tool', name: 'T', enabled: true, url: 'https://tool.example', tools: [{ name: 'read' }], charIds: [] };
    a.setItem('aetheros.mcp.servers', JSON.stringify([server]));
    a.setItem('os_realtime_config', JSON.stringify({ weatherEnabled: true, weatherCities: { a: 'A-city' } }));
    const initial = await collectSpaceToolSettings(JSON.parse(a.getItem('os_realtime_config')!), [server]);
    expect(initial.servers[0].charIds).toEqual(['a']); // legacy all does not authorize a new space
    b.setItem('aetheros.mcp.servers', JSON.stringify([{ ...server, charIds: ['b'] }]));
    b.setItem('os_realtime_config', JSON.stringify({ weatherEnabled: true, weatherCities: { b: 'B-city' } }));
    const merged = await collectSpaceToolSettings(JSON.parse(a.getItem('os_realtime_config')!), [server]);
    expect(merged.servers[0].charIds).toEqual(['a', 'b']);
    expect(merged.realtime?.weatherCities).toEqual({ a: 'A-city', b: 'B-city' });
    expect((await allSpaceCharacters()).map(c => c.id)).toEqual(['a', 'b']);
    a.setItem('amsg2_pending_llm_creds', '1'); expect(b.getItem('amsg2_pending_llm_creds')).toBe('1');
});

it('finds references in surviving databases even if the space catalog was lost', async () => {
    const token = await putSharedImage(new Blob(['lost-catalog'], { type: 'image/png' }));
    await commitSpaceRows(await openSpaceDB('u_audit'), { characters: [{ id: 'hidden', avatar: token }] });
    localStorage.removeItem('sully_user_spaces_v1');
    await DB.deleteBlobAsset(token.slice(8));
    expect(await DB.getBlobAsset(token.slice(8))).not.toBeNull();
});

it('waits for in-flight inheritance references before deciding to remove shared bytes', async () => {
    const token = await putSharedImage(new Blob(['leased-asset'], { type: 'image/png' }));
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const inheritance = withSharedAssetLock('shared', async () => {
        entered(); await gate;
        await commitSpaceRows(await openSpaceDB('u_audit'), { characters: [{ id: 'new-owner', avatar: token }] });
    });
    await ready;
    const deletion = DB.deleteBlobAsset(token.slice(8));
    release(); await inheritance; await deletion;
    expect(await DB.getBlobAsset(token.slice(8))).not.toBeNull();
});
