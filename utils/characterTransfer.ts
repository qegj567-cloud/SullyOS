import { inheritSpaceCharacters, readSpaceStore } from './userSpaceData';
import { openSpaceDB } from './db';
import { listUserSpaces, userSpaceSessionLock } from './userSpaces';
import { retireCloudCharacter } from './amsgCloudRetirement';
import { ActiveMsgStore } from './activeMsgStore';
import { withSharedAssetLock } from './sharedAssetLock';

export async function transferSpaceCharacters(source: string, ids: string[], options: { chat?: boolean; memory?: boolean; remove?: boolean }) {
    const run = async () => {
        const copies = await inheritSpaceCharacters(source, ids, options);
        if (!options.remove) return { copies, retained: false };
        try {
            await withSharedAssetLock('exclusive', async () => {
                const db = await openSpaceDB(source);
                const originals = (await readSpaceStore(db, 'characters')).filter(c => ids.includes(c.id));
                for (const space of listUserSpaces().filter(s => s.id !== source)) {
                    if ((await readSpaceStore(await openSpaceDB(space.id), 'characters')).some(c => ids.includes(c.id))) throw new Error('角色编号冲突，来源已保留');
                }
                for (const char of originals) {
                    const result = await retireCloudCharacter(char);
                    if (result.status === 'failed' || result.status === 'unsupported') throw new Error('云端清理未确认，来源已保留');
                }
                await ActiveMsgStore.clearCharacters(ids);
                // Match normal character deletion: remove role entries, retain shared assets and archives.
                await new Promise<void>((resolve, reject) => {
                    const tx = db.transaction('characters', 'readwrite');
                    for (const id of ids) tx.objectStore('characters').delete(id);
                    tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error);
                });
            });
            return { copies, retained: false };
        } catch { return { copies, retained: true }; }
    };
    if (!options.remove) return run();
    if (!navigator.locks?.request) throw new Error('此浏览器不支持安全删除来源，请取消删除选项后复制');
    return navigator.locks.request(userSpaceSessionLock(source), { mode: 'exclusive', ifAvailable: true }, lock => {
        if (!lock) throw new Error('来源用户正在其他页面使用，请关闭该页面后重试');
        return run();
    });
}
