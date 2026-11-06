import { DB, openSpaceDB } from './db';
import { openCollaborationSpace } from '../features/collaboration/store';
import { commitSpaceRows, readSpaceStore } from './userSpaceData';
import { clearUserSpaceLocal, listUserSpaces, rawSpaceStorage, readSpaceLocal, saveUserSpaces, SESSION_SPACE_ID, SPACE_DELETIONS_KEY, userSpaceSessionLock } from './userSpaces';
import { withSharedAssetLock, canCoordinateAssetDeletion } from './sharedAssetLock';
import { retireCloudCharacter } from './amsgCloudRetirement';
import { ActiveMsgStore } from './activeMsgStore';

type Deletion = {
    characters: Array<{ id: string; name: string }>;
    retired: Record<string, string[]>;
    assets: string[];
    cloudPending?: boolean;
    done?: boolean;
};
const readJournal = (): Record<string, Deletion> => JSON.parse(rawSpaceStorage?.getItem(SPACE_DELETIONS_KEY) || '{}');
function saveJournal(id: string, value: Deletion) {
    if (!rawSpaceStorage) throw new Error('无法保存删除进度');
    rawSpaceStorage.setItem(SPACE_DELETIONS_KEY, JSON.stringify({ ...readJournal(), [id]: value }));
}

/** Requires the UI's two confirmations. Local data is retained until cloud retirement is accepted. */
export async function deleteUserSpace(id: string, progress: (message: string) => void = () => {}) {
    if (id === SESSION_SPACE_ID) throw new Error('请先切换到另一个用户，再删除这个用户');
    if (!canCoordinateAssetDeletion()) throw new Error('此浏览器暂不支持安全删除用户，请使用支持 Web Locks 的浏览器');
    const run = () => withSharedAssetLock('exclusive', async () => {
        const spaces = listUserSpaces();
        if (spaces.length <= 1) throw new Error('至少需要保留一个用户');
        if (!spaces.some(s => s.id === id)) throw new Error('用户不存在');
        const db = await openSpaceDB(id), collaboration = await openCollaborationSpace(id);
        let journal = readJournal()[id];
        if (!journal) {
            const characters = (await readSpaceStore(db, 'characters')).map(c => ({ id: c.id, name: c.name || '角色' }));
            // Never retire a colliding ID that another user's imported data still owns.
            for (const space of spaces.filter(s => s.id !== id)) {
                const other = await readSpaceStore(await openSpaceDB(space.id), 'characters');
                if (other.some(c => characters.some(own => own.id === c.id))) throw new Error('角色编号与其他用户重复，请先处理冲突再删除');
            }
            const poolDB = await openSpaceDB('default');
            const pool = await new Promise<IDBValidKey[]>((resolve, reject) => {
                const req = poolDB.transaction('blob_assets').objectStore('blob_assets').getAllKeys();
                req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
            });
            const candidates = new Set<string>();
            const collect = (value: unknown) => {
                const text = JSON.stringify(value);
                for (const key of pool) if (typeof key === 'string' && !key.startsWith('pool_') && text.includes(key)) candidates.add(key);
            };
            collect(readSpaceLocal(id));
            for (const source of [db, collaboration]) for (const table of Array.from(source.objectStoreNames)) {
                if (table === 'blob_assets') continue;
                // Stream rows: a large chat/vector archive must not be materialized as one JSON string.
                await new Promise<void>((resolve, reject) => {
                    const tx = source.transaction(table), request = tx.objectStore(table).openCursor();
                    request.onsuccess = () => {
                        const cursor = request.result;
                        if (!cursor) return;
                        try { collect(cursor.value); cursor.continue(); }
                        catch (failure) { tx.abort(); reject(failure); }
                    };
                    tx.oncomplete = () => resolve();
                    tx.onerror = tx.onabort = () => reject(tx.error || new Error('素材引用检查失败，用户数据未删除'));
                });
            }
            journal = { characters, retired: {}, assets: [...candidates] };
            // Durable tombstone also fences notifications, new sessions and inheritance while retrying.
            saveJournal(id, journal);
        }
        const connection = await ActiveMsgStore.getGlobalConfig();
        const connectionKey = JSON.stringify([connection.workerUrl, connection.userId]);
        const retired = journal.retired[connectionKey] ||= [];
        for (const character of journal.characters) {
            if (retired.includes(character.id)) continue;
            progress(`正在清理 ${character.name} 的云端数据…`);
            const result = await retireCloudCharacter(character, connection);
            if (result.status === 'failed') throw new Error(`云端清理未确认，本地存档已保留，请重试。${result.detail}`);
            if (result.status === 'unsupported') throw new Error('请先更新主动消息 Worker，再继续删除。本地存档已保留。');
            if (result.status === 'accepted') journal.cloudPending ||= !result.completed;
            retired.push(character.id); saveJournal(id, journal);
        }
        // The configured remote memory table is shared: delete only exact character owners.
        const remote = JSON.parse(rawSpaceStorage?.getItem('os_remote_vector_config') || 'null');
        if (remote?.initialized && remote.supabaseUrl && remote.supabaseAnonKey) {
            progress('正在清理远程记忆…');
            const { deleteCharacterVectors } = await import('./memoryPalace/supabaseVector');
            for (const character of journal.characters) await deleteCharacterVectors(remote, character.id);
        }
        progress('正在清空用户存档…');
        await ActiveMsgStore.clearCharacters(journal.characters.map(c => c.id));
        await commitSpaceRows(collaboration, Object.fromEntries(Array.from(collaboration.objectStoreNames).map(name => [name, []])), true);
        const remaining = listUserSpaces().filter(s => s.id !== id);
        const tables = Object.fromEntries(Array.from(db.objectStoreNames).filter(name => id !== 'default' || name !== 'blob_assets').map(name => [name, [] as any[]]));
        if (id === 'default') tables.assets = [{ id: 'user_spaces_catalog_v1', data: JSON.stringify(remaining) }];
        await commitSpaceRows(db, tables, true);
        clearUserSpaceLocal(id);
        // Mirror first: a failed write leaves the catalog and journal available for retry.
        if (id !== 'default') await commitSpaceRows(await openSpaceDB('default'), { assets: [{ id: 'user_spaces_catalog_v1', data: JSON.stringify(remaining) }] });
        // Commit a content-free terminal marker before hiding the user. Closing during
        // best-effort asset GC must not leave an invisible, impossible-to-resume deletion.
        saveJournal(id, { characters: [], retired: {}, assets: [], done: true });
        saveUserSpaces(remaining);
        return journal;
    });
    const journal = typeof navigator !== 'undefined' && navigator.locks?.request
        ? await navigator.locks.request(userSpaceSessionLock(id), { mode: 'exclusive', ifAvailable: true }, lock => {
            if (!lock) throw new Error('这个用户还在其他页面打开，请先关闭那些页面再删除');
            return run();
        }) : await run();
    // Each deletion takes its own reference lock, so never nest it inside the lease above.
    progress('正在检查闲置素材…');
    let assetsRetained = false;
    for (const asset of journal.assets) {
        try { await DB.deleteBlobAsset(asset); } catch { assetsRetained = true; }
    }
    return { cloudPending: !!journal.cloudPending, assetsRetained };
}
