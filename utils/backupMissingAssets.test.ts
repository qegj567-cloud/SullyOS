import { expect, it } from 'vitest';
import { backupAssetField, recordMissingBackupAsset, writeMissingBackupAssets, type BackupMissingAsset } from './backupMissingAssets';

it('bounds repeated reference locations while retaining every missing asset', () => {
    const items = new Map<string, BackupMissingAsset>();
    for (let index = 0; index < 20; index++) recordMissingBackupAsset(items, 'one', `位置 ${index}`);
    recordMissingBackupAsset(items, 'two'); recordMissingBackupAsset(items, 'one', '位置 0');
    expect(items.size).toBe(2);
    expect(items.get('one')).toEqual({ id: 'one', locations: ['位置 0', '位置 1', '位置 2', '位置 3', '位置 4'], moreLocations: true });
    const files = new Map<string, string | Uint8Array>();
    writeMissingBackupAssets({ file: (name, data) => { files.set(name, data); } }, [...items.values()]);
    expect(files.get('缺失素材清单.txt')).toContain('2 份');
    expect(files.get('缺失素材清单.txt')).toContain('此导出路径未记录具体位置');
    expect(JSON.parse(String(files.get('diagnostics/missing-assets.json'))).items).toHaveLength(2);
});

it('handles unknown field names without reading inherited object properties', () => {
    expect(backupAssetField('avatar')).toBe('头像');
    expect(backupAssetField('constructor')).toBe('constructor');
    expect(backupAssetField('__proto__')).toBe('__proto__');
});
