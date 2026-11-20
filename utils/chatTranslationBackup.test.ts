import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { createSpaceStorage, readSpaceLocal, saveUserSpaces } from './userSpaces';
import { exportUserSpaces, importUserSpaces } from './userSpaceBackup';
import { readChatTranslationStyle, readSubtitleSettings, saveSubtitleSettings, normalizeSubtitleSettings, DEFAULT_SUBTITLE_SETTINGS } from './chatTranslationStyle';
import { DB } from './db';
import { assembleV2Backup, writeV2Backup } from './backupFormat';

it('keeps subtitle preferences private to each user and restores them through a real backup', async () => {
    localStorage.clear();
    saveUserSpaces([{ id: 'default', name: '甲' }, { id: 'u_subtitle_other', name: '乙' }]);
    localStorage.setItem('chat_translate_style_a', 'subtitle');
    const subtitle = { fontSize: 22, color: '#ffeeaa', outlineColor: '#333333', font: 'serif' as const };
    saveSubtitleSettings('a', subtitle);
    localStorage.setItem('chat_translate_style_b', 'bubble');
    const other = createSpaceStorage(localStorage, 'u_subtitle_other');
    other.setItem('chat_translate_style_a', 'bubble');
    expect(readChatTranslationStyle('a')).toBe('subtitle');
    expect(readChatTranslationStyle('b')).toBe('bubble');
    expect(readChatTranslationStyle('legacy')).toBe('bubble');
    const zip = await JSZip.loadAsync(await (await exportUserSpaces('text_only', 'current')).arrayBuffer());
    localStorage.setItem('chat_translate_style_a', 'bubble');
    saveSubtitleSettings('a', DEFAULT_SUBTITLE_SETTINGS);
    await importUserSpaces(zip);
    expect(readChatTranslationStyle('a')).toBe('subtitle');
    expect(readSubtitleSettings('a')).toEqual(subtitle);
    expect(readSpaceLocal('u_subtitle_other').chat_translate_style_a).toBe('bubble');
});

it('single-user ZIP carries subtitle size, colors and font, while old and media archives preserve receiving preferences', async () => {
    localStorage.clear();
    const settings = { fontSize: 24, font: 'system' as const, color: '#ffddcc', outlineColor: '#222222' };
    saveSubtitleSettings('subtitle-fixture', settings);
    const data = await DB.exportFullData(), zip = new JSZip();
    const manifest = await writeV2Backup(zip as any, data as any, { mode: 'full' });
    const copy = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
    localStorage.clear();
    await DB.importFullData(await assembleV2Backup(copy as any, manifest) as any);
    expect(readSubtitleSettings('subtitle-fixture')).toEqual(settings);
    await DB.importFullData({ collaborationBackupMode: 'media_only', chatSubtitleByChar: { 'subtitle-fixture': DEFAULT_SUBTITLE_SETTINGS } } as any);
    await DB.importFullData({ characters: [] } as any);
    expect(readSubtitleSettings('subtitle-fixture')).toEqual(settings);
});

it('normalizes untrusted font/color settings and bounds subtitle sizes', () => {
    expect(normalizeSubtitleSettings({ fontSize: 500, color: 'red; background:url(https://example.com)', outlineColor: null, font: '__proto__' })).toEqual({ ...DEFAULT_SUBTITLE_SETTINGS, fontSize: 28 });
    expect(normalizeSubtitleSettings({ fontSize: NaN })).toEqual(DEFAULT_SUBTITLE_SETTINGS);
    expect(normalizeSubtitleSettings({ fontSize: 0 }).fontSize).toBe(12);
});
