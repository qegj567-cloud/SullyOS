/** Only platform note links can become a card target; never trust a model-supplied URL. */
export function buildXhsNoteLink(note: {
    noteId?: string; note_id?: string; id?: string;
    xsecToken?: string; xsec_token?: string; xsecSource?: string; xsec_source?: string;
    url?: string; shareUrl?: string; platform?: string;
}, mobile = false): string | undefined {
    const id = note.noteId || note.note_id || note.id;
    if (!id || !/^[a-f\d]{24}$/i.test(id)) return;
    let original: URL | undefined;
    for (const value of [note.url, note.shareUrl]) {
        if (!value) continue;
        try {
            const candidate = new URL(value);
            if (/^https?:$/.test(candidate.protocol) && !candidate.username && !candidate.password
                && ['xiaohongshu.com','www.xiaohongshu.com','rednote.com','www.rednote.com'].includes(candidate.hostname)
                && candidate.pathname.match(/^\/(?:explore|discovery\/item|search_result)\/([a-f\d]{24})\/?$/i)?.[1] === id) {
                original = candidate; break;
            }
        } catch { /* Old cards may not have a usable source link. */ }
    }
    const host = original?.hostname || (note.platform === 'rednote' ? 'www.rednote.com' : 'www.xiaohongshu.com');
    const url = original || new URL(`https://${host}/explore/${id}`);
    url.protocol = 'https:';
    url.port = '';
    if (mobile) url.pathname = `/discovery/item/${id}`;
    const token = note.xsecToken || note.xsec_token || url.searchParams.get('xsec_token');
    const source = note.xsecSource || note.xsec_source || url.searchParams.get('xsec_source');
    if (token) {
        url.searchParams.set('xsec_token', token);
        url.searchParams.set('xsec_source', source || 'pc_feed');
    }
    return url.href;
}
