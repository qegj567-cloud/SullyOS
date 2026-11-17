import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { DB, openSpaceDB } from './db';
import { commitSpaceRows, readSpaceStore } from './userSpaceData';
import { listUserSpaces, saveUserSpaces, readSpaceLocal } from './userSpaces';
import { importUserSpaces } from './userSpaceBackup';
import { importLegacyAsIndependentUser } from './legacyIndependentUserImport';
import { writeV2Backup, openLegacyBackup, pendingBackupField } from './backupFormat';
import { openBackupZip } from './backupZipReader';
import { remapIndependentUser } from './independentUserImport';
import { openCollaborationSpace } from '../features/collaboration/store';
import * as activeMsgStore from './activeMsgStore';
import * as spaceData from './userSpaceData';

beforeEach(async () => {
    localStorage.clear();
    saveUserSpaces([{ id: 'default', name: '原用户' }]);
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, Object.fromEntries(Array.from(db.objectStoreNames).map(name => [name, []])), true);
    await commitSpaceRows(db, { characters: [{ id: 'same', name: '原角色' }], messages: [{ id: 1, charId: 'same', content: '原聊天' }] });
    localStorage.setItem('os_api_config', 'original-api');
});
afterEach(() => vi.restoreAllMocks());

async function archive(mode = 'full', malformed = false) {
    const zip = new JSZip();
    const stores: Record<string, string[]> = {};
    const rows: Record<string, any[]> = {
        characters: [{ id: 'same', name: 'same', systemPrompt: 'same', avatar: 'blobref:img_same',
            chatBackground: 'blobref:img_missing', videoAvatar: { format: 'vrm', assetId: 'model_same' },
            awayMessage: { enabled: true, delayMinutes: 120 },
            memories: [{ id: 'long-term', content: 'same' }], activeMsg2Config: { enabled: true, instantChatEnabled: true, tasks: [{ id: 'cloud-task' }], lastSyncedAt: 9 } }],
        user_profile: [{ id: 'me', name: '迁入用户', perCharAvatars: { same: 'blobref:img_same' } }],
        messages: [{ id: 1, charId: 'same', senderName: 'same', type: 'text', content: 'same' }],
        groups: [{ id: 'group', memberIds: ['same'] }],
        memory_nodes: [{ id: 'memory', charId: 'same', content: 'same memory' }],
        memory_vectors: [{ memoryId: 'memory', charId: 'same', vector: [0.5, 0.25] }],
        memory_links: [{ id: 'link', sourceId: 'memory', targetId: 'memory', strength: 0.75 }],
        daily_schedule: [{ id: 'same_2026-11-07', charId: 'same', content: 'same' }],
        assets: [{ id: 'mp_hwm_v1_same', data: '12' }, { id: 'ls_mirror_v1', data: { data: { os_api_config: 'source-api', os_last_active_char_id: 'same', mp_hwm_v1_same: '12' } } }],
        collab_sessions: [{ id: 'session', charId: 'same' }], collab_messages: [{ id: 'reply', sessionId: 'session', text: 'same' }],
    };
    for (const [store, values] of Object.entries(rows)) {
        const path = `spaces/default/${store}.0.json`; zip.file(path, JSON.stringify(values)); stores[store] = [path];
    }
    zip.file('shared/image.bin', 'new-image'); zip.file('shared/model.bin', 'new-model');
    zip.file('user-spaces.json', JSON.stringify({ format: 'sully-user-spaces', version: 1, mode,
        spaces: [{ id: 'default', name: '来源用户', stores, local: { os_last_active_char_id: 'same', mp_hwm_v1_same: '12', amsg2_inbox: 'old-delivery' } }],
        settings: { os_api_config: 'source-api' }, backend: { workerUrl: 'https://source.example' },
        blobs: [{ id: 'img_same', path: 'shared/image.bin', type: 'image/png', size: malformed ? 999 : 9 },
            { id: 'model_same', path: 'shared/model.bin', type: 'model/gltf-binary', size: 9 }],
    }));
    return zip;
}

it('migrates a complete user with colliding character/media IDs, preserving histories and the original user', async () => {
    await DB.putBlobAsset('img_same', new Blob(['old-image']));
    await DB.putBlobAsset('img_missing', new Blob(['unrelated-image']));
    const cloud = vi.spyOn(activeMsgStore, 'importAmsg2GlobalConfig');
    const [space] = await importUserSpaces(await archive(), true, { asNewUsers: true });
    const db = await openSpaceDB(space.id);
    const [char] = await readSpaceStore(db, 'characters');
    expect(space.id).not.toBe('default'); expect(char.id).not.toBe('same');
    expect(char).toMatchObject({ name: 'same', systemPrompt: 'same', memories: [{ content: 'same' }], activeMsg2Config: { enabled: false, instantChatEnabled: false, tasks: [] } });
    expect(char.activeMsg2Config.lastSyncedAt).toBeUndefined();
    expect(char.awayMessage).toEqual({ enabled: false, delayMinutes: 120 });
    expect((await readSpaceStore(db, 'messages'))[0]).toMatchObject({ id: 1, charId: char.id, content: 'same', senderName: 'same' });
    expect((await readSpaceStore(db, 'groups'))[0].memberIds).toEqual([char.id]);
    const [memory] = await readSpaceStore(db, 'memory_nodes');
    expect(memory.id).not.toBe('memory'); expect(memory.content).toBe('same memory');
    expect((await readSpaceStore(db, 'memory_vectors'))[0]).toMatchObject({ memoryId: memory.id, charId: char.id });
    expect((await readSpaceStore(db, 'memory_links'))[0]).toMatchObject({ sourceId: memory.id, targetId: memory.id });
    expect((await readSpaceStore(db, 'daily_schedule'))[0].id).toBe(`${char.id}_2026-11-07`);
    expect((await readSpaceStore(db, 'user_profile'))[0].perCharAvatars).toEqual({ [char.id]: char.avatar });
    expect(await (await DB.getBlobAsset(char.avatar.slice(8)))!.text()).toBe('new-image');
    expect(await (await DB.getBlobAsset(char.videoAvatar.assetId))!.text()).toBe('new-model');
    expect(char.chatBackground).not.toBe('blobref:img_missing');
    expect(await DB.getBlobAsset(char.chatBackground.slice(8))).toBeNull();
    expect(await (await DB.getBlobAsset('img_same'))!.text()).toBe('old-image');
    expect(await DB.getCharacter('same')).toMatchObject({ name: '原角色' });
    expect((await readSpaceStore(await openSpaceDB('default'), 'messages'))[0].content).toBe('原聊天');
    expect(readSpaceLocal(space.id)).toMatchObject({ os_last_active_char_id: char.id, [`mp_hwm_v1_${char.id}`]: '12' });
    expect(readSpaceLocal(space.id).amsg2_inbox).toBeUndefined();
    const mirror = (await readSpaceStore(db, 'assets')).find(row => row.id === 'ls_mirror_v1').data.data;
    expect(mirror.os_api_config).toBeUndefined(); expect(mirror.os_last_active_char_id).toBe(char.id);
    expect(localStorage.getItem('os_api_config')).toBe('original-api'); expect(cloud).not.toHaveBeenCalled();
    expect((await readSpaceStore(await openCollaborationSpace(space.id), 'sessions'))[0].charId).toBe(char.id);
    expect((await readSpaceStore(await openCollaborationSpace(space.id), 'messages'))[0].text).toBe('same');
    expect(listUserSpaces()).toHaveLength(2);
});

it('repeating migration creates another independent history, while normal restore retains its IDs', async () => {
    const zip = await archive();
    const first = await importUserSpaces(zip, false, { asNewUsers: true });
    const second = await importUserSpaces(zip, false, { asNewUsers: true });
    const a = (await readSpaceStore(await openSpaceDB(first[0].id), 'characters'))[0];
    const b = (await readSpaceStore(await openSpaceDB(second[0].id), 'characters'))[0];
    expect(first[0].id).not.toBe(second[0].id); expect(a.id).not.toBe(b.id);
    await importUserSpaces(zip);
    expect(await DB.getCharacter('same')).toMatchObject({ name: 'same' });
});

it('rejects incomplete and media-only migration before changing existing data or publishing a user', async () => {
    for (const zip of [await archive('full', true), await archive('media_only')]) {
        await expect(importUserSpaces(zip, false, { asNewUsers: true })).rejects.toThrow();
        expect(listUserSpaces()).toEqual([{ id: 'default', name: '原用户' }]);
        expect(await DB.getCharacter('same')).toMatchObject({ name: '原角色' });
    }
});

it('migrates legacy image ZIPs, memory vectors, activity state and embedded appearance references', async () => {
    const zip = new JSZip();
    zip.file('assets/avatar.png', new Uint8Array([1, 2, 3]));
    zip.file('blobs/index.json', JSON.stringify([{ id: 'img_legacy', type: 'image/png', size: 3 }]));
    zip.file('blobs/img_legacy', new Uint8Array([4, 5, 6]));
    zip.file('collaboration/assets/file.txt', 'hello');
    const data: any = { version: 3, timestamp: 1, characters: [{ id: 'same', name: '角色', avatar: 'assets/avatar.png', chatBackground: 'blobref:img_legacy' }],
        messages: [{ id: 4, charId: 'same', content: 'same' }], userProfile: { name: '旧账号' },
        memoryNodes: [{ id: 'memory', charId: 'same', content: '过去的经历' }], memoryVectors: [{ memoryId: 'memory', charId: 'same', vector: [0.5, 0.25] }],
        memoryPalaceHighWaterMarks: { same: 4 }, lastActiveCharId: 'same',
        chatTranslateStyleByChar: { same: 'subtitle' },
        chatSubtitleByChar: { same: { fontSize: 23, color: '#ffeecc', outlineColor: '#222222', font: 'serif' } },
        appearancePresets: [{ id: 'theme', name: '主题', theme: { wallpaper: 'assets/avatar.png' } }],
        sarLocalState: { version: 1, club: { retained: true } }, vrMusicRoom: { queue: ['song'] },
        collaborationSessions: [{ id: 'session', charId: 'same' }],
        collaborationAssetIndex: [{ id: 'file', path: 'collaboration/assets/file.txt', size: 5, mimeType: 'text/plain', createdAt: 1 }],
        apiConfig: { apiKey: 'source-key' }, amsg2GlobalConfig: { workerUrl: 'https://source.example' },
    };
    const [space] = await importLegacyAsIndependentUser(data, zip);
    const db = await openSpaceDB(space.id), [char] = await readSpaceStore(db, 'characters');
    expect(char.id).not.toBe('same'); expect(char.avatar).toBe('data:image/png;base64,AQID');
    expect(await (await DB.getBlobAsset(char.chatBackground.slice(8)))!.arrayBuffer()).toEqual(new Uint8Array([4, 5, 6]).buffer);
    const [vector] = await readSpaceStore(db, 'memory_vectors');
    expect(vector.vector).toBeInstanceOf(Uint8Array); expect([...new Float32Array(vector.vector.buffer)]).toEqual([0.5, 0.25]);
    expect(vector.memoryId).toBe((await readSpaceStore(db, 'memory_nodes'))[0].id);
    expect(readSpaceLocal(space.id)[`mp_lastMsgId_${char.id}`]).toBe('4');
    expect(readSpaceLocal(space.id)[`chat_translate_style_${char.id}`]).toBe('subtitle');
    expect(JSON.parse(readSpaceLocal(space.id)[`chat_translate_subtitle_${char.id}`])).toEqual(data.chatSubtitleByChar.same);
    expect(readSpaceLocal(space.id).chat_translate_subtitle_same).toBeUndefined();
    expect(readSpaceLocal(space.id).chat_translate_style_same).toBeUndefined();
    expect((await readSpaceStore(db, 'assets')).find(row => row.id === `mp_hwm_v1_${char.id}`).data).toMatchObject({ version: 1, charId: char.id, msgId: 4 });
    expect(Object.values(readSpaceLocal(space.id))).toContain(JSON.stringify({ retained: true }));
    expect((await readSpaceStore(db, 'vr_music'))[0]).toMatchObject({ id: 'state', queue: ['song'] });
    const preset = (await readSpaceStore(db, 'assets')).find(row => row.id === 'appearance_preset_theme');
    expect(JSON.parse(preset.data).theme.wallpaper).toBe(char.avatar);
    expect(await (await readSpaceStore(await openCollaborationSpace(space.id), 'assets'))[0].blob.text()).toBe('hello');
    expect(localStorage.getItem('os_api_config')).toBe('original-api');
    expect(await DB.getCharacter('same')).toMatchObject({ name: '原角色' });
});

it('migrates a sharded legacy ZIP opened by the on-demand reader, loading every table before renumbering', async () => {
    const source = new JSZip();
    await writeV2Backup(source as any, { version: 3, timestamp: 1,
        characters: [{ id: 'same', name: '分片角色 🐱' }], userProfile: { name: '旧账号' },
        messages: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, charId: 'same', content: `第 ${i} 条 👋` })),
        memoryNodes: [{ id: 'memory', charId: 'same', content: '过去的经历' }],
        collaborationSessions: [{ id: 'session', charId: 'same' }],
    }, { limits: { maxLen: 1 << 30, maxItems: 2, hardMaxLen: 1 << 30 } });
    const zip = await openBackupZip(new Blob([await source.generateAsync({ type: 'arraybuffer' })]));
    const data = await openLegacyBackup(zip);
    expect(pendingBackupField(data.messages)?.field).toBe('messages');

    const [space] = await importLegacyAsIndependentUser(data as any, zip);
    await zip.close();
    const db = await openSpaceDB(space.id), [char] = await readSpaceStore(db, 'characters');
    expect(char).toMatchObject({ name: '分片角色 🐱' }); expect(char.id).not.toBe('same');
    const messages = await readSpaceStore(db, 'messages');
    expect(messages.map(row => row.content)).toEqual([0, 1, 2, 3, 4].map(i => `第 ${i} 条 👋`));
    expect(messages.every(row => row.charId === char.id)).toBe(true);
    expect((await readSpaceStore(db, 'memory_nodes'))[0].charId).toBe(char.id);
    expect((await readSpaceStore(await openCollaborationSpace(space.id), 'sessions'))[0].charId).toBe(char.id);
    expect(await DB.getCharacter('same')).toMatchObject({ name: '原角色' });
});

it('migrates a legacy ZIP whose pictures are corrupt: they are reported and skipped, the history still arrives', async () => {
    const source = new JSZip();
    source.file('assets/avatar.png', 'BROKEN-ASSET-IMAGE-0123456789');
    source.file('blobs/index.json', JSON.stringify([{ id: 'img_legacy', type: 'image/png', size: 28 }, { id: 'img_ok', type: 'image/png', size: 3 }]));
    source.file('blobs/img_legacy', 'BROKEN-BLOB-IMAGE-0123456789');
    source.file('blobs/img_ok', new Uint8Array([4, 5, 6]));
    source.file('data.json', JSON.stringify({ version: 3, timestamp: 1,
        characters: [{ id: 'same', name: '角色', avatar: 'assets/avatar.png', chatBackground: 'blobref:img_legacy', dateBackground: 'blobref:img_ok' }],
        messages: [{ id: 4, charId: 'same', content: '正文还在' }], userProfile: { name: '旧账号' } }));
    const bytes = await source.generateAsync({ type: 'uint8array' });
    for (const needle of ['BROKEN-ASSET-IMAGE', 'BROKEN-BLOB-IMAGE']) bytes[Buffer.from(bytes).indexOf(needle)] ^= 0x01;
    const zip = await openBackupZip(new Blob([bytes as BlobPart]));
    const data = await openLegacyBackup(zip);

    const thrown = new DOMException('file is gone', 'NotReadableError');
    const flaky = { file: (name: string) => (name === 'blobs/img_ok' ? { async: () => Promise.reject(thrown) } : zip.file(name)) };
    await expect(importLegacyAsIndependentUser(structuredClone(data) as any, flaky)).rejects.toBe(thrown);
    expect(listUserSpaces()).toHaveLength(1);

    const damaged: string[] = [];
    const [space] = await importLegacyAsIndependentUser(data as any, zip, { onDamagedAsset: id => { damaged.push(id); } });
    await zip.close();
    expect(damaged.sort()).toEqual(['assets/avatar.png', 'img_legacy']);
    const db = await openSpaceDB(space.id), [char] = await readSpaceStore(db, 'characters');
    expect(char.avatar).toBe('assets/avatar.png');
    expect(await DB.getBlobAsset(char.chatBackground.slice(8))).toBeNull();
    expect(await (await DB.getBlobAsset(char.dateBackground.slice(8)))!.arrayBuffer()).toEqual(new Uint8Array([4, 5, 6]).buffer);
    expect((await readSpaceStore(db, 'messages'))[0].content).toBe('正文还在');
});

it('aborts a legacy migration when the backup file itself stops being readable, instead of reporting every picture as damaged', async () => {
    const source = new JSZip();
    source.file('assets/avatar.png', new Uint8Array([1, 2, 3]));
    source.file('data.json', JSON.stringify({ version: 3, timestamp: 1,
        characters: [{ id: 'same', name: '角色', avatar: 'assets/avatar.png' }], messages: [{ id: 4, charId: 'same', content: '正文' }] }));
    // 文件被系统收回后不报错、只给出全零数据：读到图片的那一刻起每次读都是零。
    class VanishingBlob extends Blob {
        gone = false;
        slice(start?: number, end?: number, contentType?: string): Blob {
            const part = super.slice(start, end, contentType);
            return this.gone ? new Blob([new Uint8Array(part.size)]) : part;
        }
    }
    const blob = new VanishingBlob([await source.generateAsync({ type: 'arraybuffer' })]);
    const reader = await openBackupZip(blob);
    const data = await openLegacyBackup(reader);
    const zip = { verify: () => reader.verify(), file: (name: string) => {
        const entry = reader.file(name);
        return entry && name === 'assets/avatar.png' ? { ...entry, async: (type: any) => { blob.gone = true; return entry.async(type); } } : entry;
    } };
    const onDamagedAsset = vi.fn();
    const error = await importLegacyAsIndependentUser(data as any, zip, { onDamagedAsset }).catch(e => e);
    expect(error).toBeInstanceOf(DOMException);
    expect(error.name).toBe('NotReadableError');
    expect(error.message).toContain('备份文件已经读不出来了');
    expect(onDamagedAsset).not.toHaveBeenCalled();
    expect(listUserSpaces()).toHaveLength(1);
});

it('migrates standalone legacy JSON and rejects a media patch without creating a user', async () => {
    await expect(importLegacyAsIndependentUser({ characters: [], collaborationBackupMode: 'media_only' } as any, null)).rejects.toThrow('整合或文字备份');
    expect(listUserSpaces()).toHaveLength(1);
    const [space] = await importLegacyAsIndependentUser({ characters: [{ id: 'same', name: 'JSON 角色' }], messages: [{ id: 1, charId: 'same', content: '正文' }] } as any, null);
    expect((await readSpaceStore(await openSpaceDB(space.id), 'messages'))[0].content).toBe('正文');
});

it('does not rewrite prose, CSS text or record names that happen to equal an identity', () => {
    const jsonProse = '{ "charId": "same" }';
    const input = { characters: [{ id: 'same', name: 'same', description: 'same', systemPrompt: jsonProse, customCss: '.same { color: red }' }], messages: [{ id: 1, charId: 'same', type: 'text', content: jsonProse }] };
    const result = remapIndependentUser(input, {}, {}, new Map());
    expect(result.tables.characters[0]).toMatchObject({ name: 'same', description: 'same', systemPrompt: jsonProse, customCss: '.same { color: red }' });
    expect(result.tables.characters[0].activeMsg2Config).toMatchObject({ enabled: false, instantChatEnabled: false });
    expect(result.tables.messages[0].content).toBe(jsonProse); expect(input.characters[0].id).toBe('same');
});

it('keeps composite world-home threads and structured cards connected after participant IDs change', () => {
    const result = remapIndependentUser({ characters: [{ id: 'alpha' }, { id: 'beta' }], worlds: [{ id: 'world', threads: [{ id: 'dm_alpha_beta', memberIds: ['alpha', 'beta'] }],
        messages: [{ threadId: 'dm_alpha_beta', fromId: 'alpha', content: '原话' }] }],
        messages: [{ id: 1, type: 'image', content: 'blobref:img_card' }, { id: 2, type: 'social_card', content: JSON.stringify({ authorId: 'alpha', content: 'alpha' }) }],
    }, {}, {}, new Map());
    const [a, b] = result.tables.characters;
    const threadId = `dm_${[a.id, b.id].sort().join('_')}`;
    expect(result.tables.worlds[0].threads[0].id).toBe(threadId);
    expect(result.tables.worlds[0].messages[0]).toMatchObject({ threadId, fromId: a.id, content: '原话' });
    expect(result.tables.messages[0].content).not.toBe('blobref:img_card');
    expect(JSON.parse(result.tables.messages[1].content)).toEqual({ authorId: a.id, content: 'alpha' });
});

it('removes only the newly allocated user if writing fails after collaboration data was staged', async () => {
    const databases = new Set((await indexedDB.databases()).map(db => db.name));
    const original = spaceData.commitSpaceRows;
    vi.spyOn(spaceData, 'commitSpaceRows').mockImplementation(async (db, tables, replace) => {
        if (db.name.startsWith('AetherOS_Data__u_')) throw new DOMException('满了', 'QuotaExceededError');
        return original(db, tables, replace);
    });
    await expect(importUserSpaces(await archive(), false, { asNewUsers: true })).rejects.toThrow('满了');
    expect(listUserSpaces()).toEqual([{ id: 'default', name: '原用户' }]);
    expect((await indexedDB.databases()).filter(db => !databases.has(db.name))).toEqual([]);
    expect(await DB.getCharacter('same')).toMatchObject({ name: '原角色' });
});

it('migration starts the pre-write hook only after every check, and reports a clean rollback after a write failure', async () => {
    const onBeforeWrite = vi.fn();
    const onRolledBack = vi.fn();
    await expect(importLegacyAsIndependentUser({ characters: [], collaborationBackupMode: 'media_only' } as any, null, { onBeforeWrite, onRolledBack })).rejects.toThrow('整合或文字备份');
    // The size mismatch is caught in preflight: the hook never runs, and the users allocated for it are removed again.
    await expect(importUserSpaces(await archive('full', true), false, { asNewUsers: true, onBeforeWrite, onRolledBack })).rejects.toThrow('不完整');
    expect(onBeforeWrite).not.toHaveBeenCalled();
    onRolledBack.mockClear();

    const databases = new Set((await indexedDB.databases()).map(db => db.name));
    const original = spaceData.commitSpaceRows;
    vi.spyOn(spaceData, 'commitSpaceRows').mockImplementation(async (db, tables, replace) => {
        if (db.name.startsWith('AetherOS_Data__u_')) throw new DOMException('满了', 'QuotaExceededError');
        return original(db, tables, replace);
    });
    await expect(importUserSpaces(await archive(), false, { asNewUsers: true, onBeforeWrite, onRolledBack })).rejects.toThrow('满了');
    await expect(importLegacyAsIndependentUser({ characters: [{ id: 'same', name: 'JSON 角色' }] } as any, null, { onBeforeWrite, onRolledBack })).rejects.toThrow('满了');
    expect(onBeforeWrite).toHaveBeenCalledTimes(2);
    expect(onRolledBack).toHaveBeenCalledTimes(2);
    expect(listUserSpaces()).toEqual([{ id: 'default', name: '原用户' }]);
    expect((await indexedDB.databases()).filter(db => !databases.has(db.name))).toEqual([]);
});

it('does not report a rollback when removing the failed new user did not finish', async () => {
    vi.spyOn(spaceData, 'commitSpaceRows').mockRejectedValue(new DOMException('满了', 'QuotaExceededError'));
    vi.spyOn(DB, 'deleteDB').mockRejectedValue(new Error('blocked'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onRolledBack = vi.fn();
    await expect(importLegacyAsIndependentUser({ characters: [{ id: 'same', name: 'JSON 角色' }] } as any, null, { onRolledBack })).rejects.toThrow('满了');
    expect(onRolledBack).not.toHaveBeenCalled();
});
