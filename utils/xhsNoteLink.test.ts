import {expect, it} from 'vitest';
import {buildXhsNoteLink} from './xhsNoteLink';
import {normalizeNote} from './xhsMcpClient';
import {extractXhsNoteLink} from './webpageExtractor';

const noteId = '6aa4aaf6000000000b00eab5';
it('uses a mobile detail path and preserves search token/source without double encoding', () => {
    const url = new URL(buildXhsNoteLink({noteId,xsecToken:'abc+/=%3D',xsecSource:'pc_search'},true)!);
    expect(url.pathname).toBe(`/discovery/item/${noteId}`);
    expect(url.searchParams.get('xsec_token')).toBe('abc+/=%3D');
    expect(url.searchParams.get('xsec_source')).toBe('pc_search');
    expect(buildXhsNoteLink({noteId})).toBe(`https://www.xiaohongshu.com/explore/${noteId}`);
});
it('keeps a shared RedNote link and its access parameters through parsing and card normalization', () => {
    const original = `https://www.rednote.com/discovery/item/${noteId}?xsec_token=share%2Btoken%3D&xsec_source=app_share&appuid=123`;
    const parsed = extractXhsNoteLink(original)!;
    const normalized = normalizeNote(parsed);
    const url = new URL(buildXhsNoteLink(normalized,true)!);
    expect(url.hostname).toBe('www.rednote.com');
    expect(url.searchParams.get('xsec_token')).toBe('share+token=');
    expect(url.searchParams.get('xsec_source')).toBe('app_share');
    expect(url.searchParams.get('appuid')).toBe('123');
});
it('supports old snake-case cards and the global platform without a saved source URL', () => {
    expect(new URL(buildXhsNoteLink({note_id:noteId,xsec_token:'old'},true)!).searchParams.get('xsec_token')).toBe('old');
    expect(new URL(buildXhsNoteLink(normalizeNote({noteId,platform:'rednote'}),true)!).hostname).toBe('www.rednote.com');
});
it.each(['javascript:alert(1)',`https://evil.invalid/explore/${noteId}`,`https://www.xiaohongshu.com.evil.invalid/explore/${noteId}`,
    `https://www.xiaohongshu.com/explore/${'a'.repeat(24)}`])('does not trust an unrelated or unsafe source link %s', url => {
    expect(buildXhsNoteLink({noteId,url})).toBe(`https://www.xiaohongshu.com/explore/${noteId}`);
});
it('does not make a broken card silently navigate to the platform home page', () => {
    expect(buildXhsNoteLink({})).toBeUndefined();
    expect(buildXhsNoteLink({noteId:'../'})).toBeUndefined();
});
