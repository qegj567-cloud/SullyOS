import type { HelpRecord } from './sullyHelpHistory';

export const HELP_HISTORY_KEY = 'sully-11-history-v1';
export const HELP_HISTORY_LIMIT = 200;

/** Attachment names and text excerpts belong to the conversation. Media archives carry only its image links. */
export function helpTextHistory(rows: HelpRecord[]): HelpRecord[] {
    return rows.map(row => {
        const attachment = row.attachment;
        return attachment && attachment.kind !== 'file' ? { ...row, attachment: { ...attachment, url: '' } } : row;
    });
}

type MediaRow = { id: string; attachment: { kind: 'image' | 'sticker'; url: string } };
export function helpMediaHistory(rows: unknown): MediaRow[] {
    if (!Array.isArray(rows)) throw new Error('客服附件备份格式不正确');
    return rows.flatMap(row => {
        const item = row?.attachment;
        if (typeof row?.id !== 'string' || !item || (item.kind !== 'image' && item.kind !== 'sticker')
            || typeof item.url !== 'string' || !item.url) return [];
        return [{ id: row.id, attachment: { kind: item.kind, url: item.url } }];
    });
}

/** Older media archives may contain whole records. Restore only missing bytes on matching live records. */
export function restoreHelpMedia(existing: HelpRecord[], media: unknown): HelpRecord[] {
    const byId = new Map(helpMediaHistory(media).map(row => [row.id, row.attachment]));
    return existing.map(row => {
        const stored = byId.get(row.id);
        const item = row.attachment;
        return stored && item && item.kind !== 'file' && stored.kind === item.kind && !item.url
            ? { ...row, attachment: { ...item, url: stored.url } } : row;
    });
}
