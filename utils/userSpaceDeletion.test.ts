import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('./userSpaces', async importOriginal => ({ ...await importOriginal<typeof import('./userSpaces')>(), SESSION_SPACE_ID: 'u_keep' }));
vi.mock('./amsgCloudRetirement', () => ({ retireCloudCharacter: vi.fn(async () => ({ status: 'skipped' })) }));
import { deleteUserSpace } from './userSpaceDeletion';
import { retireCloudCharacter } from './amsgCloudRetirement';
import { DB, openSpaceDB } from './db';
import { commitSpaceRows, readSpaceStore, inheritSpaceCharacters, createUserSpace } from './userSpaceData';
import { createSpaceStorage, listUserSpaces, saveUserSpaces, selectUserSpace, isUserSpaceDeleting, prepareUserSpaceRestore, SPACE_DELETIONS_KEY } from './userSpaces';
import { openCollaborationSpace } from '../features/collaboration/store';
import { ActiveMsgStore } from './activeMsgStore';
import { findCharacterSpace } from './userSpaceNavigation';

beforeEach(async () => {
    localStorage.clear(); vi.mocked(retireCloudCharacter).mockReset().mockResolvedValue({ status: 'skipped' });
    saveUserSpaces([{ id: 'default', name: '原用户' }, { id: 'u_keep', name: '当前用户' }, { id: 'u_delete', name: '待删用户' }]);
    for (const id of ['default', 'u_keep', 'u_delete']) {
        for (const db of [await openSpaceDB(id), await openCollaborationSpace(id)]) {
            await commitSpaceRows(db, Object.fromEntries(Array.from(db.objectStoreNames).map(n => [n, []])), true);
        }
        await commitSpaceRows(await openSpaceDB(id), {
            characters: [{ id: `char_${id}`, name: id, avatar: 'blobref:b_shared' }],
            messages: [{ id: `msg_${id}`, charId: `char_${id}`, content: id }],
            memory_nodes: [{ id: `mem_${id}`, charId: `char_${id}`, content: id }],
            user_profile: [{ id: 'me', name: id }],
        });
        createSpaceStorage(localStorage, id).setItem('private_test', id);
    }
    await ActiveMsgStore.consumeInboxMessages();
    await ActiveMsgStore.saveGlobalConfig({ workerUrl: '', userId: 'shared_connection' });
    localStorage.setItem('os_api_config', JSON.stringify({ model: 'shared' }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('clears all private stores, collaboration, local data and targeted inbox; preserves other users and shared files', async () => {
    await DB.putBlobAsset('b_shared', new Blob(['shared']));
    await DB.putBlobAsset('b_private', new Blob(['private']));
    await commitSpaceRows(await openSpaceDB('u_delete'), { gallery: [{ id: 'private', url: 'blobref:b_private' }] });
    await commitSpaceRows(await openCollaborationSpace('u_delete'), { sessions: [{ id: 'session', charId: 'char_u_delete' }] });
    localStorage.setItem('like520_cc_draft_k_u_delete:char', 'draft');
    for (const charId of ['char_u_delete', 'char_u_keep']) {
        await ActiveMsgStore.saveInboxMessage({ messageId: charId, charId, receivedAt: 1 } as any);
        await ActiveMsgStore.markActionResultApplied(charId, 'result');
    }
    await deleteUserSpace('u_delete');
    const db = await openSpaceDB('u_delete');
    for (const store of Array.from(db.objectStoreNames)) expect(await readSpaceStore(db, store), store).toEqual([]);
    for (const store of Array.from((await openCollaborationSpace('u_delete')).objectStoreNames)) expect(await readSpaceStore(await openCollaborationSpace('u_delete'), store)).toEqual([]);
    expect(createSpaceStorage(localStorage, 'u_delete').getItem('private_test')).toBeNull();
    expect(localStorage.getItem('like520_cc_draft_k_u_delete:char')).toBeNull();
    expect(createSpaceStorage(localStorage, 'u_keep').getItem('private_test')).toBe('u_keep');
    expect(localStorage.getItem('os_api_config')).toContain('shared');
    expect(await DB.getBlobAsset('b_shared')).not.toBeNull();
    expect(await DB.getBlobAsset('b_private')).toBeNull();
    expect((await ActiveMsgStore.consumeInboxMessages()).map(m => m.charId)).toEqual(['char_u_keep']);
    expect(await ActiveMsgStore.hasAppliedActionResult('char_u_delete', 'result')).toBe(false);
    expect(await ActiveMsgStore.hasAppliedActionResult('char_u_keep', 'result')).toBe(true);
    expect((await ActiveMsgStore.getGlobalConfig()).userId).toBe('shared_connection');
    expect(await readSpaceStore(await openSpaceDB('u_keep'), 'memory_nodes')).toHaveLength(1);
    expect(listUserSpaces().map(s => s.id)).not.toContain('u_delete');
});

it('deleting the original default user preserves the shared pool, catalog and another user’s creator draft', async () => {
    await DB.putBlobAsset('b_shared', new Blob(['shared']));
    localStorage.setItem('like520_cc_draft_k_u_keep:char', 'keep');
    localStorage.setItem('like520_cc_draft_char_old', 'remove');
    localStorage.setItem('os_realtime_config', JSON.stringify({ enabled: true, weatherCities: { char_default: 'old' } }));
    await deleteUserSpace('default');
    expect(await DB.getBlobAsset('b_shared')).not.toBeNull();
    expect(await readSpaceStore(await openSpaceDB('default'), 'characters')).toEqual([]);
    expect(await readSpaceStore(await openSpaceDB('default'), 'assets')).toEqual([{ id: 'user_spaces_catalog_v1', data: JSON.stringify(listUserSpaces()) }]);
    expect(localStorage.getItem('like520_cc_draft_k_u_keep:char')).toBe('keep');
    expect(localStorage.getItem('like520_cc_draft_char_old')).toBeNull();
    expect(JSON.parse(localStorage.getItem('os_realtime_config')!)).toEqual({ enabled: true });
    expect(createSpaceStorage(localStorage, 'u_keep').getItem('private_test')).toBe('u_keep');
});

it('keeps local data on partial cloud failure and resumes only unfinished retirements', async () => {
    await commitSpaceRows(await openSpaceDB('u_delete'), { characters: [{ id: 'second', name: 'second' }] });
    vi.mocked(retireCloudCharacter).mockResolvedValueOnce({ status: 'accepted', operationId: 'op', completed: false }).mockResolvedValueOnce({ status: 'failed', detail: 'offline' });
    await expect(deleteUserSpace('u_delete')).rejects.toThrow('本地存档已保留');
    expect(await readSpaceStore(await openSpaceDB('u_delete'), 'characters')).toHaveLength(2);
    expect(isUserSpaceDeleting('u_delete')).toBe(true);
    expect(() => selectUserSpace('u_delete')).toThrow('正在删除');
    expect(await findCharacterSpace('char_u_delete')).toBeNull();
    await expect(inheritSpaceCharacters('u_delete', ['char_u_delete'])).rejects.toThrow('正在删除');
    vi.mocked(retireCloudCharacter).mockClear().mockResolvedValue({ status: 'accepted', operationId: 'op2', completed: true });
    expect((await deleteUserSpace('u_delete')).cloudPending).toBe(true);
    expect(retireCloudCharacter).toHaveBeenCalledTimes(1);
    expect(vi.mocked(retireCloudCharacter).mock.calls[0][0].id).toBe('second');
});

it('blocks current-user deletion, colliding character IDs and an occupied page lease before cloud calls', async () => {
    await expect(deleteUserSpace('u_keep')).rejects.toThrow('先切换');
    await commitSpaceRows(await openSpaceDB('u_delete'), { characters: [{ id: 'char_u_keep', name: 'collision' }] });
    await expect(deleteUserSpace('u_delete')).rejects.toThrow('编号与其他用户重复');
    vi.stubGlobal('navigator', { locks: { request: vi.fn((_name, _options, callback) => callback(null)) } });
    await expect(deleteUserSpace('u_delete')).rejects.toThrow('其他页面');
    expect(retireCloudCharacter).not.toHaveBeenCalled();
});

it('fails closed on old workers or remote vector errors; remote requests target exact owners', async () => {
    vi.mocked(retireCloudCharacter).mockResolvedValue({ status: 'unsupported' });
    await expect(deleteUserSpace('u_delete')).rejects.toThrow('更新主动消息 Worker');
    vi.mocked(retireCloudCharacter).mockResolvedValue({ status: 'skipped' });
    localStorage.setItem('os_remote_vector_config', JSON.stringify({ initialized: true, supabaseUrl: 'https://memory.test', supabaseAnonKey: 'test' }));
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 503 }); vi.stubGlobal('fetch', fetcher);
    await expect(deleteUserSpace('u_delete')).rejects.toThrow('远程记忆清理失败');
    expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('char_id')).toBe('eq.char_u_delete');
    expect(await readSpaceStore(await openSpaceDB('u_delete'), 'memory_nodes')).toHaveLength(1);
});

it('serializes new-user creation with deletion so neither catalog update drops the other', async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(retireCloudCharacter).mockImplementationOnce(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return { status: 'skipped' }; });
    const deleting = deleteUserSpace('u_delete'); await entered;
    const creating = createUserSpace('新用户');
    release(); await deleting; const created = await creating;
    expect(listUserSpaces().map(s => s.id)).toEqual(['default', 'u_keep', created.id]);
    expect((await readSpaceStore(await openSpaceDB(created.id), 'user_profile'))[0].name).toBe('新用户');
});

it('commits deletion before asset GC and never re-tombstones a backup restored during cleanup', async () => {
    await DB.putBlobAsset('b_shared', new Blob(['shared']));
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(DB, 'deleteBlobAsset').mockImplementationOnce(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); });
    const deleting = deleteUserSpace('u_delete'); await entered;
    expect(listUserSpaces().some(s => s.id === 'u_delete')).toBe(false);
    expect(JSON.parse(localStorage.getItem(SPACE_DELETIONS_KEY)!).u_delete).toEqual({ characters: [], retired: {}, assets: [], done: true });
    prepareUserSpaceRestore('u_delete', true);
    release(); await deleting;
    expect(isUserSpaceDeleting('u_delete')).toBe(false);
});
