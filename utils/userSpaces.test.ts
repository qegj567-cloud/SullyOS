import { describe, it, expect, beforeEach } from 'vitest';
import { createSpaceStorage, spaceDatabaseName } from './userSpaces';
import { openSpaceDB, DB } from './db';
import { cloneCharacterForSpace, commitSpaceRows, readSpaceStore } from './userSpaceData';
import { resolveCharacterUser } from './userPersona';
import { putSharedImage } from './spaceAssets';

beforeEach(() => localStorage.clear());
describe('user spaces', () => {
    it('pins late local writes to their originating space and shares connection settings', () => {
        const a = createSpaceStorage(localStorage, 'default'), b = createSpaceStorage(localStorage, 'u_b');
        a.setItem('os_dream_collection', 'old'); b.setItem('os_dream_collection', 'new');
        a.setItem('os_api_config', '{"model":"shared"}');
        a.setItem('os_dream_collection', 'late old response');
        expect(b.getItem('os_dream_collection')).toBe('new');
        expect(b.getItem('os_api_config')).toContain('shared');
        expect(a.getItem('os_dream_collection')).toBe('late old response');
        b.clear(); expect(a.getItem('os_dream_collection')).toBe('late old response');
        expect(b.getItem('os_api_config')).toContain('shared');
    });
    it('keeps role audiences private, including legacy all vs explicit none', () => {
        const a = createSpaceStorage(localStorage, 'default'), b = createSpaceStorage(localStorage, 'u_b');
        localStorage.setItem('os_user_location_privacy_v1', JSON.stringify({ enabled: true, regions: [], characterIds: ['old'] }));
        expect(JSON.parse(b.getItem('os_user_location_privacy_v1')!).characterIds).toEqual([]);
        b.setItem('os_user_location_privacy_v1', JSON.stringify({ enabled: true, regions: [], characterIds: ['new'] }));
        expect(JSON.parse(a.getItem('os_user_location_privacy_v1')!).characterIds).toEqual(['old']);
        expect(JSON.parse(b.getItem('os_user_location_privacy_v1')!).characterIds).toEqual(['new']);
        a.setItem('aetheros.mcp.servers', JSON.stringify([{ id: 's', url: 'https://example.test', charIds: [] }]));
        expect(JSON.parse(b.getItem('aetheros.mcp.servers')!)[0].charIds).toEqual(['__space_unselected__']);
    });
    it('isolates colliding primary keys at the database boundary', async () => {
        const a = await openSpaceDB('default'), b = await openSpaceDB('u_test');
        await commitSpaceRows(a, { characters: [{ id: 'collision', name: 'old' }] });
        await commitSpaceRows(b, { characters: [{ id: 'collision', name: 'new' }] });
        expect((await readSpaceStore(a, 'characters')).find(c => c.id === 'collision').name).toBe('old');
        expect((await readSpaceStore(b, 'characters')).find(c => c.id === 'collision').name).toBe('new');
        expect(spaceDatabaseName('AetherOS_Data', 'default')).toBe('AetherOS_Data');
        expect(() => spaceDatabaseName('AetherOS_Data', '../bad')).toThrow();
    });
    it('copies configuration and visuals but never the old relationship', () => {
        const original: any = { id: 'old', name: 'C', memories: [{ summary: 'old user' }], impression: { secret: 'old' }, selfInsights: ['old'], userPersona: { name: 'old' }, chibiStudio: { home3D: { state: { x: 2 } } }, chatBackground: 'blobref:b_shared', dialogueApi: { model: 'configured' }, home3D: { records: [{ text: 'old' }], rooms: [{ id: 'room' }] } };
        const copy = cloneCharacterForSpace(original, 'new');
        expect(copy).toMatchObject({ id: 'new', memories: [], chatBackground: 'blobref:b_shared', dialogueApi: { model: 'configured' } });
        expect(copy.impression).toBeUndefined(); expect(copy.userPersona).toBeUndefined(); expect(copy.selfInsights).toBeUndefined();
        expect(copy.home3D?.records).toEqual([]); expect(copy.home3D?.rooms).toEqual(original.home3D.rooms);
        expect(original.home3D.records).toHaveLength(1);
        const vr = cloneCharacterForSpace({ ...original, vrState: { enabled: true, intervalMinutes: 90, api: { model: 'vr-api' }, excludedAutoRooms: ['sar'], novelBookmarks: { book: 4 }, lastNovelId: 'book' } }, 'vr-new');
        expect(vr.vrState).toMatchObject({ enabled: false, intervalMinutes: 90, api: { model: 'vr-api' }, excludedAutoRooms: ['sar'] });
        expect(vr.vrState?.novelBookmarks).toBeUndefined(); expect(vr.vrState?.lastNovelId).toBeUndefined();
    });
    it('uses stable content references for repeated uploads', async () => {
        const blob = new Blob(['same pixels'], { type: 'image/png' });
        const first = await putSharedImage(blob), second = await putSharedImage(blob);
        expect(first).toBe(second);
        expect(await (await DB.getBlobAsset(first.slice(8)))?.text()).toBe('same pixels');
    });
    it('supplements the same user without changing the base profile', () => {
        const user: any = { name: '小雨', bio: '画画' };
        const resolved = resolveCharacterUser(user, { userPersona: { name: 'Rain', supplement: '同学' } });
        expect(resolved.name).toBe('Rain'); expect(resolved.bio).toContain('画画'); expect(resolved.bio).toContain('同学');
        expect(user.name).toBe('小雨');
    });
});
