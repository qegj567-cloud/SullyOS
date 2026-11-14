import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { createSpaceStorage, readSpaceLocal, saveUserSpaces } from './userSpaces';
import { exportUserSpaces, importUserSpaces } from './userSpaceBackup';
import { readChatTranslationStyle } from './chatTranslationStyle';

it('keeps subtitle preferences private to each user and restores them through a real backup', async () => {
    localStorage.clear();
    saveUserSpaces([{ id: 'default', name: '甲' }, { id: 'u_subtitle_other', name: '乙' }]);
    localStorage.setItem('chat_translate_style_a', 'subtitle');
    localStorage.setItem('chat_translate_style_b', 'bubble');
    const other = createSpaceStorage(localStorage, 'u_subtitle_other');
    other.setItem('chat_translate_style_a', 'bubble');
    expect(readChatTranslationStyle('a')).toBe('subtitle');
    expect(readChatTranslationStyle('b')).toBe('bubble');
    expect(readChatTranslationStyle('legacy')).toBe('bubble');
    const zip = await JSZip.loadAsync(await (await exportUserSpaces('text_only', 'current')).arrayBuffer());
    localStorage.setItem('chat_translate_style_a', 'bubble');
    await importUserSpaces(zip);
    expect(readChatTranslationStyle('a')).toBe('subtitle');
    expect(readSpaceLocal('u_subtitle_other').chat_translate_style_a).toBe('bubble');
});
