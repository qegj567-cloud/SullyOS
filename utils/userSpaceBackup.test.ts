import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { DB, openSpaceDB } from './db';
import { saveUserSpaces, readSpaceLocal, createSpaceStorage, SPACE_DELETIONS_KEY, isUserSpaceDeleting } from './userSpaces';
import { commitSpaceRows, readSpaceStore, inheritSpaceCharacters } from './userSpaceData';
import { exportUserSpaces, importUserSpaces } from './userSpaceBackup';
import { putSharedImage, isSharedAssetReferenced } from './spaceAssets';
import { openCollaborationSpace } from '../features/collaboration/store';

beforeEach(async () => {
    localStorage.clear();
    saveUserSpaces([{ id: 'default', name: '甲' }, { id: 'u_backup', name: '乙' }]);
    for (const id of ['default', 'u_backup']) {
        const db = await openSpaceDB(id);
        await commitSpaceRows(db, Object.fromEntries(Array.from(db.objectStoreNames).filter(n => n !== 'blob_assets').map(n => [n, []])), true);
    }
});

describe('space backup and asset ownership', () => {
    it('restores a completed deletion from a full backup but rejects a pending deletion before writing', async () => {
        await commitSpaceRows(await openSpaceDB('u_backup'), { characters: [{ id: 'restore', name: '保留', memories: [] }] });
        const zip = await JSZip.loadAsync(await (await exportUserSpaces('full', 'all')).arrayBuffer());
        localStorage.setItem(SPACE_DELETIONS_KEY, JSON.stringify({ u_backup: { done: false } }));
        await expect(importUserSpaces(zip)).rejects.toThrow('先完成');
        await commitSpaceRows(await openSpaceDB('u_backup'), { characters: [] }, true);
        localStorage.setItem(SPACE_DELETIONS_KEY, JSON.stringify({ u_backup: { done: true } }));
        await importUserSpaces(zip);
        expect(isUserSpaceDeleting('u_backup')).toBe(false);
        expect((await readSpaceStore(await openSpaceDB('u_backup'), 'characters'))[0].name).toBe('保留');
    });
    it('packs shared bytes once across users and restores independent histories and collaboration', async () => {
        const token = await putSharedImage(new Blob(['shared-image'], { type: 'image/png' }));
        for (const id of ['default', 'u_backup']) {
            await commitSpaceRows(await openSpaceDB(id), {
                characters: [{ id: `c_${id}`, name: id, avatar: token, memories: [] }],
                messages: [{ id: 1, charId: `c_${id}`, content: `${id} private`, role: 'user' }],
                user_profile: [{ id: 'me', name: id, avatar: token, bio: '' }],
            });
        }
        await commitSpaceRows(await openCollaborationSpace('u_backup'), { sessions: [{ id: 'session', charId: 'c_u_backup', title: '乙的协同' }] });
        localStorage.setItem('os_user_location_privacy_v1', JSON.stringify({ latitude: 12, longitude: 34 }));
        const zip = await JSZip.loadAsync(await (await exportUserSpaces('full', 'all')).arrayBuffer());
        expect(Object.keys(zip.files).filter(p => p.startsWith('shared/') && !zip.files[p].dir)).toHaveLength(1);
        const manifest = JSON.parse(await zip.file('user-spaces.json')!.async('string'));
        expect(manifest.spaces).toHaveLength(2);
        expect(JSON.stringify(manifest)).not.toContain('latitude');
        await commitSpaceRows(await openSpaceDB('u_backup'), { messages: [] }, true);
        await importUserSpaces(zip);
        expect((await readSpaceStore(await openSpaceDB('u_backup'), 'messages'))[0].content).toBe('u_backup private');
        expect((await readSpaceStore(await openSpaceDB('default'), 'messages'))[0].content).toBe('default private');
        expect((await readSpaceStore(await openCollaborationSpace('u_backup'), 'sessions'))[0].title).toBe('乙的协同');
    });
    it('current export excludes other users and a truncated archive leaves live data unchanged', async () => {
        await commitSpaceRows(await openSpaceDB('default'), { characters: [{ id: 'c', name: 'keep', memories: [] }] });
        const zip = await JSZip.loadAsync(await (await exportUserSpaces('full', 'current')).arrayBuffer());
        const manifest = JSON.parse(await zip.file('user-spaces.json')!.async('string'));
        expect(manifest.spaces.map((s: any) => s.id)).toEqual(['default']);
        zip.remove(manifest.spaces[0].stores.characters[0]);
        await expect(importUserSpaces(zip)).rejects.toThrow('分片缺失');
        expect((await DB.getCharacter('c'))?.name).toBe('keep');
    });
    it('retains assets used only by another user when deleting the old owner', async () => {
        const token = await putSharedImage(new Blob(['other-owner'], { type: 'image/png' }));
        await commitSpaceRows(await openSpaceDB('u_backup'), { characters: [{ id: 'other', avatar: token }] });
        await DB.deleteBlobAsset(token.slice(8));
        expect(await isSharedAssetReferenced(token.slice(8))).toBe(true);
        expect(await DB.getBlobAsset(token.slice(8))).not.toBeNull();
    });
    it('inherits new IDs, independent worldbooks and reusable visuals', async () => {
        const token = await putSharedImage(new Blob(['inherit'], { type: 'image/png' }));
        await commitSpaceRows(await openSpaceDB('u_backup'), {
            characters: [{ id: 'source', name: 'C', avatar: token, memories: [{ id: 'memory' }], mountedWorldbooks: [{ id: 'w', name: 'book', content: 'setting' }] }],
            worldbooks: [{ id: 'w', name: 'book', content: 'setting' }],
        });
        const [copy] = await inheritSpaceCharacters('u_backup', ['source']);
        expect(copy.id).not.toBe('source'); expect(copy.avatar).toBe(token); expect(copy.memories).toEqual([]);
        expect(copy.mountedWorldbooks?.[0].id).not.toBe('w');
        expect((await readSpaceStore(await openSpaceDB('u_backup'), 'characters'))[0].memories).toHaveLength(1);
    });
});

it('text backup preserves vector types while stripping nested image strings', async () => {
    await commitSpaceRows(await openSpaceDB('default'), {
        memory_vectors: [{ memoryId: 'v', vector: new Float32Array([0.25, 0.5]) }],
        assets: [{ id: 'nested', data: JSON.stringify({ image: 'data:image/png;base64,eA==', text: 'keep' }) }],
    });
    const zip = await JSZip.loadAsync(await (await exportUserSpaces('text_only', 'current')).arrayBuffer());
    await importUserSpaces(zip);
    expect((await readSpaceStore(await openSpaceDB('default'), 'memory_vectors'))[0].vector).toEqual(new Float32Array([0.25, 0.5]));
    expect(JSON.parse(await DB.getAssetRaw('nested'))).toEqual({ image: '', text: 'keep' });
});
it('restores inline images nested in each users local desktop settings', async () => {
    const theme = JSON.stringify({ wallpaper: 'data:image/png;base64,eA==' });
    localStorage.setItem('os_theme', theme);
    const zip = await JSZip.loadAsync(await (await exportUserSpaces('full', 'current')).arrayBuffer());
    localStorage.setItem('os_theme', '{}');
    await importUserSpaces(zip);
    expect(localStorage.getItem('os_theme')).toBe(theme);
});
it('media backup restores feed images and saved voices without overwriting newer posts', async () => {
    const token = await putSharedImage(new Blob(['feed-photo'], { type: 'image/png' }));
    const feed = { version: 1, circles: [], posts: [{ id: 'p', authorId: 'user', authorName: '我', text: 'old text', createdAt: 123, circleId: 'public', audienceIds: [], comments: [], images: [{url: token, thumbnail: token}] }] };
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, { assets: [
        { id: 'friend_feed_v1', data: JSON.stringify(feed) },
        { id: 'voice_msg_saved', data: { favorite: true, blob: new Blob(['favorite']) } },
        { id: 'voice_msg_temporary', data: { blob: new Blob(['temporary']) } },
    ] });
    const zip = await JSZip.loadAsync(await (await exportUserSpaces('media_only', 'current')).arrayBuffer());
    const manifest = JSON.parse(await zip.file('user-spaces.json')!.async('string'));
    const page = await zip.file(manifest.spaces[0].stores.assets[0])!.async('string');
    expect(page).not.toContain('old text'); expect(page).not.toContain('voice_msg_temporary');
    feed.posts[0].text = 'new text'; feed.posts[0].images = [];
    await commitSpaceRows(db, { assets: [{ id: 'friend_feed_v1', data: JSON.stringify(feed) }] });
    await importUserSpaces(zip);
    expect(JSON.parse(await DB.getAssetRaw('friend_feed_v1')).posts[0]).toMatchObject({ text: 'new text', images: [{ url: token }] });
    expect(await (await DB.getAssetRaw('voice_msg_saved')).blob.text()).toBe('favorite');
});
it('media restoration preserves text and metadata on camera messages', async () => {
    const db = await openSpaceDB('default');
    const token = await putSharedImage(new Blob(['photo'], { type: 'image/png' }));
    await commitSpaceRows(db, {
        messages: [{ id: 1, charId: 'c', role: 'user', type: 'text', content: 'private text', metadata: { cameraSnapshotRef: token, memo: 'private memo' } }],
        characters: [{ id: 'c', name: 'C', memories: [], home3D: { version: 1, rooms: [{ id: 'r' }], records: [{ text: 'old home text' }] } }],
        daily_schedule: [{ id: 'schedule', charId: 'c', coverImage: token, slots: ['old plan'] }],
    });
    const zip = await JSZip.loadAsync(await (await exportUserSpaces('media_only', 'current')).arrayBuffer());
    const manifest = JSON.parse(await zip.file('user-spaces.json')!.async('string'));
    const page = await zip.file(manifest.spaces[0].stores.messages[0])!.async('string');
    expect(page).not.toContain('private text'); expect(page).not.toContain('private memo');
    await commitSpaceRows(db, { characters: [{ id: 'c', name: 'C', memories: [], home3D: { version: 1, rooms: [], records: [{ text: 'new home text' }] } }], daily_schedule: [{ id: 'schedule', charId: 'c', slots: ['new plan'] }] });
    await importUserSpaces(zip);
    expect((await readSpaceStore(db, 'messages'))[0]).toMatchObject({ content: 'private text', metadata: { memo: 'private memo', cameraSnapshotRef: token } });
    expect((await DB.getCharacter('c'))?.home3D).toMatchObject({ rooms: [{ id: 'r' }], records: [{ text: 'new home text' }] });
    expect((await readSpaceStore(db, 'daily_schedule'))[0]).toMatchObject({ coverImage: token, slots: ['new plan'] });
});
it('deduplicates inline activity canvases but restores their required data URL representation', async () => {
    const dataUrl = 'data:image/png;base64,eA==';
    await commitSpaceRows(await openSpaceDB('default'), { characters: [{ id: 'c', name: 'canvas', specialMomentRecords: { event: { customData: { charChibi: { dataUrl } } } } }], assets: [{ id: 'nested', data: JSON.stringify({ img: dataUrl }) }] });
    const zip = await JSZip.loadAsync(await (await exportUserSpaces('full', 'current')).arrayBuffer());
    expect(Object.keys(zip.files).filter(p => p.startsWith('shared/') && !zip.files[p].dir)).toHaveLength(1);
    await importUserSpaces(zip);
    expect((await DB.getCharacter('c'))?.specialMomentRecords?.event.customData?.charChibi).toEqual({ dataUrl });
    expect(JSON.parse(await DB.getAssetRaw('nested')).img).toBe(dataUrl);
});
it('exports only the selected users tool audiences, including legacy default selections', async () => {
    localStorage.setItem('aetheros.mcp.servers', JSON.stringify([{ id: 'tool', charIds: ['default-c'], url: 'https://example.test' }]));
    const view = createSpaceStorage(localStorage, 'u_backup');
    view.setItem('aetheros.mcp.servers', JSON.stringify([{ id: 'tool', charIds: ['other-c'], url: 'https://example.test' }]));
    const zip = await JSZip.loadAsync(await (await exportUserSpaces('full', 'current')).arrayBuffer());
    const manifest = JSON.parse(await zip.file('user-spaces.json')!.async('string'));
    expect(JSON.stringify(manifest)).not.toContain('other-c');
    expect(JSON.stringify(manifest)).toContain('default-c');
});
it('aborts an entire space transaction if a later row has an invalid key', async () => {
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, { characters: [{ id: 'good', name: 'keep' }] });
    await expect(commitSpaceRows(db, { characters: [{ id: 'new' }, { id: {} }] }, true)).rejects.toBeTruthy();
    expect((await readSpaceStore(db, 'characters')).map(c => c.id)).toEqual(['good']);
});

it('inherits voice bytes by reference without losing the original voice', async () => {
    const voiceId = 'companion-touch-voice:source:one';
    const source = await openSpaceDB('u_backup');
    await commitSpaceRows(source, {
        characters: [{ id: 'voice-source', name: 'Voice', memories: [], companionTouchSettings: { enabledZones: ['head'], reactions: { head: [{ id: 'r', text: 'hello', voiceAssetId: voiceId }] } } }],
        assets: [{ id: voiceId, data: { blob: new Blob(['voice-bytes'], {type:'audio/mpeg'}), mimeType: 'audio/mpeg', savedAt: 1 } }],
    });
    const [copy] = await inheritSpaceCharacters('u_backup', ['voice-source']);
    const copiedId = copy.companionTouchSettings!.reactions.head![0].voiceAssetId!;
    const original = (await readSpaceStore(source, 'assets')).find(row => row.id === voiceId).data;
    const inherited = await DB.getAssetRaw(copiedId);
    expect(copiedId).not.toBe(voiceId); expect(original.blob).toBeUndefined();
    expect(inherited.blobRef).toBe(original.blobRef);
    expect(await (await DB.getBlobAsset(inherited.blobRef.slice(8)))!.text()).toBe('voice-bytes');
});
