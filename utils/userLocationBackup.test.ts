import { beforeEach, expect, it } from 'vitest';
import JSZip from 'jszip';
import { DB } from './db';
import { assembleV2Backup, writeV2Backup } from './backupFormat';
import { healLocalStorageMirror, MIRRORED_KEYS, snapshotLocalStorageMirror } from './lsMirror';
import { saveUserLocationConfig } from './userLocation';
import { loadUserLocationConfig, USER_LOCATION_STORAGE_KEY } from './userLocationPrivacy';

beforeEach(async () => {
    localStorage.clear();
    await DB.saveAssetRaw('ls_mirror_v1', null as any);
});

it('real ZIP backup excludes device location secrets; import preserves this device or leaves a new device disabled', async () => {
    const privateConfig = { enabled: true, provider: 'amap' as const, amapKey: 'BACKUP-KEY-POISON-901', regions: [
        { id: 'backup-region-poison-902', name: '私密家庭地址-903', latitude: 31.234567, longitude: 121.765432, radiusKm: 3.765432 },
    ] };
    saveUserLocationConfig(privateConfig);
    localStorage.setItem('os_theme', '{"hue":120}');
    await snapshotLocalStorageMirror();
    expect(MIRRORED_KEYS).not.toContain(USER_LOCATION_STORAGE_KEY);
    expect((await DB.getAssetRaw('ls_mirror_v1')).data).not.toHaveProperty(USER_LOCATION_STORAGE_KEY);

    const exported = await DB.exportFullData();
    const zip = new JSZip(), serialized: string[] = [];
    const manifest = await writeV2Backup(zip as any, exported as any, { mode: 'full', onSerialized: text => { serialized.push(text); } });
    const payload = serialized.join('\n');
    for (const secret of [USER_LOCATION_STORAGE_KEY, privateConfig.amapKey, ...Object.values(privateConfig.regions[0])]) {
        expect(payload).not.toContain(String(secret));
    }
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const restoredZip = await JSZip.loadAsync(bytes);

    const currentConfig = { ...privateConfig, enabled: false, regions: [{ ...privateConfig.regions[0], name: '本机新地点' }] };
    saveUserLocationConfig(currentConfig);
    await DB.importFullData(await assembleV2Backup(restoredZip as any, manifest) as any);
    await healLocalStorageMirror();
    expect(loadUserLocationConfig()).toEqual(currentConfig);

    localStorage.clear(); // New device has neither the old Key nor protected coordinates.
    await DB.importFullData(await assembleV2Backup(restoredZip as any, manifest) as any);
    await healLocalStorageMirror();
    expect(localStorage.getItem(USER_LOCATION_STORAGE_KEY)).toBeNull();
    expect(loadUserLocationConfig()).toEqual({ enabled: false, regions: [] });
});
