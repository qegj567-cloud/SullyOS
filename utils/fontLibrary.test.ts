import { beforeEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { DB, openSpaceDB } from './db';
import { commitSpaceRows } from './userSpaceData';
import { saveUserSpaces } from './userSpaces';
import { exportUserSpaces, importUserSpaces } from './userSpaceBackup';
import { exportActivityTextAsset } from './activityBackup';
import { assembleV2Backup, writeV2Backup } from './backupFormat';
import { listSavedFonts, readSavedFont, rememberFontDataUrl } from './fontLibrary';
import { readSubtitleSettings, saveSubtitleSettings, DEFAULT_SUBTITLE_SETTINGS } from './chatTranslationStyle';

const base64 = readFileSync(new URL('../assets/fonts/subtitle-rounded-bold.woff2', import.meta.url)).toString('base64');
const source = 'data:font/woff2;base64,' + base64;
beforeEach(async () => {
    localStorage.clear(); saveUserSpaces([{ id: 'default', name: '测试' }]);
    await commitSpaceRows(await openSpaceDB('default'), { assets: [] }, true);
});
it('deduplicates the same imported file and persists only its ID in subtitle preferences', async () => {
    const [a, b] = await Promise.all([rememberFontDataUrl(source, '我的字体'), rememberFontDataUrl(source, '重命名文件')]);
    expect(a.id).toBe(b.id); expect(await listSavedFonts()).toHaveLength(1);
    saveSubtitleSettings('role', { ...DEFAULT_SUBTITLE_SETTINGS, font: 'custom', fontId: a.id });
    expect(localStorage.getItem('chat_translate_subtitle_role')).not.toContain(base64.slice(0, 50));
    expect((await readSavedFont(a.id))?.base64).toBe(base64);
});
it.each(['full', 'text_only'] as const)('restores actual font bytes and selection through multi-space %s ZIPs', async mode => {
    const font = await rememberFontDataUrl(source, '我的字体');
    saveSubtitleSettings('role', { ...DEFAULT_SUBTITLE_SETTINGS, font: 'custom', fontId: font.id });
    const zip = await JSZip.loadAsync(await (await exportUserSpaces(mode, 'current')).arrayBuffer());
    localStorage.clear(); await commitSpaceRows(await openSpaceDB('default'), { assets: [] }, true);
    await importUserSpaces(zip);
    expect(readSubtitleSettings('role').fontId).toBe(font.id);
    expect((await readSavedFont(font.id))?.base64).toBe(base64);
    expect(await listSavedFonts()).toEqual([font]);
});
it('single-user text ZIP includes font files in its text-assets section and restores them', async () => {
    const font = await rememberFontDataUrl(source, '我的字体');
    const exported = await DB.exportFullData();
    const activityTextAssets = exported.assets!.map(exportActivityTextAsset).filter(Boolean);
    expect(activityTextAssets.some(asset => asset!.id === font.id)).toBe(true);
    const zip = new JSZip();
    const manifest = await writeV2Backup(zip as any, { activityTextAssets }, { mode: 'text_only' });
    await commitSpaceRows(await openSpaceDB('default'), { assets: [] }, true);
    await DB.importFullData(await assembleV2Backup(await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' })) as any, manifest) as any);
    expect((await readSavedFont(font.id))?.base64).toBe(base64);
});
it('invalid source never overwrites the existing font library', async () => {
    const font = await rememberFontDataUrl(source, '我的字体');
    await expect(rememberFontDataUrl('https://example.invalid/font.woff2', 'bad')).rejects.toThrow();
    expect(await listSavedFonts()).toEqual([font]);
});
