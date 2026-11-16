import { beforeEach, expect, it } from 'vitest';
import JSZip from 'jszip';
import { DB } from './db';
import { assembleV2Backup, writeV2Backup } from './backupFormat';
import { healLocalStorageMirror, MIRRORED_KEYS, snapshotLocalStorageMirror } from './lsMirror';
import { saveUserLocationConfig } from './userLocation';
import { loadUserLocationConfig, USER_LOCATION_STORAGE_KEY } from './userLocationPrivacy';
import { exportUserLocationSettings } from './userLocationBackup';

beforeEach(async () => {
    localStorage.clear();
    await DB.saveAssetRaw('ls_mirror_v1', null as any);
});

it('real ZIP backup restores saved settings on a fresh device without copying live fixes or the localStorage mirror', async () => {
    const privateConfig = { enabled: true, provider: 'amap' as const, amapKey: 'fixture-amap-key', geoapifyKey: 'fixture-geoapify-key', characterIds: ['fixture-role'], regions: [
        { id: 'backup-region-poison-902', name: '私密家庭地址-903', latitude: 31.234567, longitude: 121.765432, radiusKm: 3.765432 },
    ] };
    saveUserLocationConfig(privateConfig);
    localStorage.setItem(USER_LOCATION_STORAGE_KEY, JSON.stringify({ ...privateConfig, lastFix: { latitude: 12.345678, longitude: 45.678901 }, placeCache: 'fixture-live-address' }));
    localStorage.setItem('os_theme', '{"hue":120}');
    await snapshotLocalStorageMirror();
    expect(MIRRORED_KEYS).not.toContain(USER_LOCATION_STORAGE_KEY);
    expect((await DB.getAssetRaw('ls_mirror_v1')).data).not.toHaveProperty(USER_LOCATION_STORAGE_KEY);

    const exported = await DB.exportFullData();
    const zip = new JSZip(), serialized: string[] = [];
    const manifest = await writeV2Backup(zip as any, exported as any, { mode: 'full', onSerialized: text => { serialized.push(text); } });
    const payload = serialized.join('\n');
    expect(exported.userLocationSettings).toEqual(privateConfig);
    expect(payload).not.toContain('12.345678');
    expect(payload).not.toContain('fixture-live-address');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const restoredZip = await JSZip.loadAsync(bytes);

    const currentConfig = { ...privateConfig, enabled: false, regions: [{ ...privateConfig.regions[0], name: '本机新地点' }] };
    saveUserLocationConfig(currentConfig);
    await DB.importFullData(await assembleV2Backup(restoredZip as any, manifest) as any);
    await healLocalStorageMirror();
    expect(loadUserLocationConfig()).toEqual(privateConfig);

    localStorage.clear(); // Fresh browser/device, with no saved configuration.
    await DB.importFullData(await assembleV2Backup(restoredZip as any, manifest) as any);
    await healLocalStorageMirror();
    expect(loadUserLocationConfig()).toEqual(privateConfig);
});

it('old backups preserve receiving settings and media-only restores do not apply location configuration', async () => {
    const config = { enabled: true, provider: 'geoapify' as const, geoapifyKey: 'fixture-key', regions: [], characterIds: [] };
    saveUserLocationConfig(config);
    await DB.importFullData({ characters: [] } as any);
    expect(loadUserLocationConfig()).toEqual(config);
    await DB.importFullData({ collaborationBackupMode: 'media_only', userLocationSettings: { enabled: false, regions: [] } } as any);
    expect(loadUserLocationConfig()).toEqual(config);
    localStorage.clear();
    await DB.importFullData({ characters: [] } as any);
    expect(localStorage.getItem(USER_LOCATION_STORAGE_KEY)).toBeNull();
});

it('rejects broken protection before writing restored characters', async () => {
    const config = { enabled: false, regions: [], characterIds: [] };
    saveUserLocationConfig(config);
    await DB.saveCharacter({ id: 'location-fixture', name: '保留' } as any);
    await expect(DB.importFullData({ characters: [{ id: 'location-fixture', name: '不应写入' }], userLocationSettings: {
        enabled: true, regions: [{ id: 'home', name: '家', latitude: 31, longitude: 121, radiusKm: 0 }],
    } } as any)).rejects.toThrow('隐藏');
    expect((await DB.getCharacter('location-fixture'))?.name).toBe('保留');
    expect(loadUserLocationConfig()).toEqual(config);
});

it('stops export when saved settings cannot be read instead of silently dropping them', async () => {
    localStorage.setItem(USER_LOCATION_STORAGE_KEY, '{broken');
    expect(() => exportUserLocationSettings()).toThrow('真实定位设置无法读取');
    await expect(DB.exportFullData()).rejects.toThrow('真实定位设置无法读取');
});
