import type { Emoji, Message } from '../types';
import { stickerLink } from './emojiOriginals';
import { HELP_HISTORY_KEY } from './sullyHelpBackup';

/** Resolve cached tokens written by old archives only when their origin is unambiguous. */
export function legacyStickerLinks(rows: Emoji[]) {
    const links = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const row of rows) {
        if (!row.url?.startsWith('blobref:')) continue;
        const source = stickerLink(row);
        if (!source || (links.has(row.url) && links.get(row.url) !== source)) ambiguous.add(row.url);
        else links.set(row.url, source);
    }
    for (const token of ambiguous) links.delete(token);
    return links;
}

/** Media patches fill the original on an existing matching sticker; keep live grouping and names. */
export function patchEmojiOriginal(current: any, incoming: any) {
    if (!current || !incoming?.url || current.name !== incoming.name) return undefined;
    if (current.contentHash && incoming.contentHash && current.contentHash !== incoming.contentHash) return undefined;
    if (current.url && current.url !== incoming.url && current.url !== incoming.backupSourceUrl
        && !(current.contentHash && current.contentHash === incoming.contentHash)) return undefined;
    return { ...current, url: stickerLink(incoming) || incoming.url };
}

/** A media-only archive may come from a different history with reused message IDs. */
export function patchSentSticker(current: Message | undefined, incoming: Message): Message | undefined {
    if (!current || current.type !== 'emoji' || incoming.type !== 'emoji' || !incoming.content ||
        current.content || current.id !== incoming.id || current.charId !== incoming.charId ||
        current.role !== incoming.role || current.timestamp !== incoming.timestamp ||
        (incoming.groupId !== undefined && current.groupId !== incoming.groupId)) return;
    const name = incoming.metadata?.stickerName;
    if (name && current.metadata?.stickerName && name !== current.metadata.stickerName) return;
    return { ...current, content: incoming.content };
}

/** Only change image-bearing fields in the exported copy. The same URL in a text message is ordinary text. */
export function portableEmojiRow(store: string, row: any, tokens: Map<string, string>) {
    if (store === 'emojis' && row.backupSourceUrl && stickerLink(row)) {
        const { backupSourceUrl, ...rest } = row;
        return { ...rest, url: stickerLink(row) };
    }
    if (!tokens.size) return row;
    if (store === 'messages' && row.type === 'emoji' && tokens.has(row.content)) return { ...row, content: tokens.get(row.content) };
    if (store === 'assets' && row.id === HELP_HISTORY_KEY && Array.isArray(row.data)) return { ...row, data: row.data.map((record: any) => {
        const item = record.attachment;
        return item?.kind === 'sticker' && tokens.has(item.url) ? { ...record, attachment: { ...item, url: tokens.get(item.url) } } : record;
    }) };
    return row;
}
