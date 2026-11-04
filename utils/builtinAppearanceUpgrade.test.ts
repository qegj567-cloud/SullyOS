import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DB, openDB } from './db';
import { getBlobForRef, putImageBlob } from './blobRef';
import { sameSullyIconSnapshot, SULLY_BIBI_UPGRADE_KEY, upgradeBuiltinSullyBibiIcon } from './builtinAppearanceUpgrade';

const bytes = (name: string) => readFileSync(new URL('../public/themes/sully/' + name, import.meta.url));
const iconResponse = () => new Response(bytes('icon-friend_feed.png'), { headers: { 'Content-Type': 'image/png' } });
const fetchMock = vi.fn();
beforeEach(async () => {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('assets', 'readwrite');tx.objectStore('assets').clear();
        tx.oncomplete = () => resolve();tx.onerror = () => reject(tx.error);
    });
    fetchMock.mockReset().mockImplementation(iconResponse);vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
async function oldIcons() {
    const icons: Record<string, string> = {};
    for (const key of ['chat', 'character', 'appearance']) {
        icons[key] = await putImageBlob(new Blob([bytes('icon-' + key + '.webp')], { type: 'image/webp' }));
        await DB.saveAsset('icon_' + key, icons[key]);
    }
    return icons;
}
it('recognizes stored original image bytes, persists the new portable icon once, and preserves all existing assets', async () => {
    const icons = await oldIcons();await DB.saveAsset('wallpaper', 'my-wallpaper');
    const before = await DB.getAllAssets();
    const added = await upgradeBuiltinSullyBibiIcon(icons);
    expect(added).toMatch(/^blobref:/);expect(await DB.getAsset('icon_friend_feed')).toBe(added);
    expect(Buffer.from(await (await getBlobForRef(added!))!.arrayBuffer())).toEqual(bytes('icon-friend_feed.png'));
    expect(await DB.getAsset(SULLY_BIBI_UPGRADE_KEY)).toBe('1');
    for (const row of before) expect(await DB.getAsset(row.id)).toBe(row.data);
    expect(icons.friend_feed).toBeUndefined();
    // Deliberately removed after upgrade: never resurrect it.
    await DB.deleteAsset('icon_friend_feed');
    expect(await upgradeBuiltinSullyBibiIcon(icons)).toBeNull();expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('allows one customised anchor but requires two original icons, without fetching custom URLs', async () => {
    const icons = await oldIcons();icons.appearance = 'https://private.invalid/image';await DB.saveAsset('icon_appearance', icons.appearance);
    expect(await upgradeBuiltinSullyBibiIcon(icons)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);expect(fetchMock.mock.calls[0][0]).toBe('/themes/sully/icon-friend_feed.png');
});
it('does not alter another theme or an existing customised Bibi icon', async () => {
    expect(await upgradeBuiltinSullyBibiIcon({ chat: '/other-theme/chat.png', character: 'https://private.invalid/character' })).toBeNull();
    const icons = await oldIcons();icons.friend_feed = 'my-own-icon';await DB.saveAsset('icon_friend_feed', icons.friend_feed);
    expect(await upgradeBuiltinSullyBibiIcon(icons)).toBeNull();expect(await DB.getAsset('icon_friend_feed')).toBe('my-own-icon');expect(fetchMock).not.toHaveBeenCalled();
});
it.each(['offline', 'invalid-image'])('does not mark failed downloads as upgraded (%s), and retries successfully', async mode => {
    const icons = await oldIcons();
    if (mode === 'offline') fetchMock.mockRejectedValueOnce(new Error('offline'));
    else fetchMock.mockResolvedValueOnce(new Response('wrong bytes', {headers:{'Content-Type':'image/png'}}));
    await expect(upgradeBuiltinSullyBibiIcon(icons)).rejects.toThrow();
    expect(await DB.getAsset(SULLY_BIBI_UPGRADE_KEY)).toBeNull();expect(await DB.getAsset('icon_friend_feed')).toBeNull();
    expect(await upgradeBuiltinSullyBibiIcon(icons)).toBeTruthy();
});
it.each(['icon_friend_feed', 'icon_chat', SULLY_BIBI_UPGRADE_KEY])('does not overwrite a concurrent change to %s', async key => {
    const icons = await oldIcons();
    fetchMock.mockImplementationOnce(async () => {await DB.saveAsset(key, 'user-change');return iconResponse();});
    expect(await upgradeBuiltinSullyBibiIcon(icons)).toBeNull();expect(await DB.getAsset(key)).toBe('user-change');
    if(key !== 'icon_friend_feed') expect(await DB.getAsset('icon_friend_feed')).toBeNull();
});
it('commits at most once when two tabs upgrade together', async () => {
    const icons = await oldIcons();
    const result = await Promise.all([upgradeBuiltinSullyBibiIcon(icons),upgradeBuiltinSullyBibiIcon(icons)]);
    expect(result.filter(Boolean)).toHaveLength(1);expect(await DB.getAsset('icon_friend_feed')).toBe(result.find(Boolean));
});
it('rejects stale UI snapshots after manual edits but permits unrelated icon changes', () => {
    const snapshot = {chat:'a', character:'b', appearance:'c'};
    expect(sameSullyIconSnapshot({...snapshot,bank:'custom'},snapshot)).toBe(true);
    expect(sameSullyIconSnapshot({...snapshot,chat:'new'},snapshot)).toBe(false);
    expect(sameSullyIconSnapshot({...snapshot,friend_feed:'custom'},snapshot)).toBe(false);
});
