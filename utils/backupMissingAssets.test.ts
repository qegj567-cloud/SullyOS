// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BackupMissingAssetsNotice, RestoreDamagedAssetsStartupNotice } from '../components/BackupMissingAssetsNotice';
import { RESTORE_DAMAGED_ASSETS_KEY, saveRestoreDamagedAssets } from './backupImportPolicy';
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

it('marks damaged files apart from missing ones in the list file and on screen', () => {
    const items: BackupMissingAsset[] = [{ id: 'img_missing', locations: [] }, { id: 'img_damaged', locations: [], reason: 'damaged' }];
    const files = new Map<string, string | Uint8Array>();
    writeMissingBackupAssets({ file: (name, data) => { files.set(name, data); } }, items);
    const text = String(files.get('缺失素材清单.txt'));
    expect(text).toContain('素材：img_damaged（文件损坏）');
    expect(text).toContain('素材：img_missing\n');
    expect(JSON.parse(String(files.get('diagnostics/missing-assets.json'))).items[1].reason).toBe('damaged');
    const html = renderToStaticMarkup(createElement(BackupMissingAssetsNotice, { items }));
    expect(html).toContain('img_damaged</span>（文件损坏）');
    expect(html).not.toContain('img_missing</span>（文件损坏）');
});

it('shows the restore notice once after start when a list was stored, and clears the stored list as it appears', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const mount = async (blocked: boolean) => {
        const host = document.createElement('div'); document.body.append(host);
        const root = createRoot(host);
        await act(async () => root.render(createElement(RestoreDamagedAssetsStartupNotice, { blocked })));
        return { host, root, rerender: (next: boolean) => act(async () => root.render(createElement(RestoreDamagedAssetsStartupNotice, { blocked: next }))) };
    };

    localStorage.removeItem(RESTORE_DAMAGED_ASSETS_KEY);
    const empty = await mount(false);
    expect(empty.host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => empty.root.unmount());

    const items: BackupMissingAsset[] = Array.from({ length: 3 }, (_, i) => ({ id: `img_${i}`, locations: [], reason: 'damaged' }));
    saveRestoreDamagedAssets(items);
    // 别的启动提示还开着时先不弹，清单也还留着。
    const view = await mount(true);
    expect(view.host.querySelector('[role="dialog"]')).toBeNull();
    expect(localStorage.getItem(RESTORE_DAMAGED_ASSETS_KEY)).not.toBeNull();
    await view.rerender(false);
    const dialog = view.host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('恢复完成');
    expect(dialog.textContent).toContain('有 3 份图片或素材文件已损坏');
    expect(dialog.textContent).toContain('img_0（文件损坏）');
    expect(localStorage.getItem(RESTORE_DAMAGED_ASSETS_KEY)).toBeNull();
    await act(async () => Array.from(dialog.querySelectorAll('button')).find(node => node.textContent === '知道了')!.click());
    expect(view.host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => view.root.unmount());

    // 下一次启动不再弹。
    const next = await mount(false);
    expect(next.host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => next.root.unmount());
});
