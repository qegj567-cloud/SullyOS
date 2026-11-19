import { hashBlob } from '@rei-standard/blob-store';
import { emojiCacheName, hasEmojiCacheStorage, isRemoteEmoji } from './emojiOriginals';
import { HELP_HISTORY_KEY } from './sullyHelpBackup';

/** Snapshot the available library originals without contacting image hosts or changing the live library. */
export async function collectEmojiBackup(emojiUrls: string[], spaceId?: string) {
    const tokens = new Map<string, string>();
    const blobs = new Map<string, Blob>();
    const urls = new Set(emojiUrls.filter(isRemoteEmoji));
    if (!urls.size || !hasEmojiCacheStorage()) return { tokens, blobs };
    const name = emojiCacheName(spaceId);
    let cache: Cache;
    try {
        if (!await caches.has(name)) return { tokens, blobs };
        cache = await caches.open(name);
    } catch { return { tokens, blobs }; }
    for (const url of urls) {
        const blob = await cache.match(url).then(response => response?.blob()).catch(() => undefined);
        if (!blob?.size) continue;
        const hash = await hashBlob(blob);
        const token = 'blobref:emoji_' + hash.replace(/[^a-zA-Z0-9_]/g, '_') + '_' + blob.type.replace(/[^a-zA-Z0-9_]/g, '_');
        tokens.set(url, token);
        blobs.set(token, blob);
    }
    return { tokens, blobs };
}

/** Only change image-bearing fields in the exported copy. The same URL in a text message is ordinary text. */
export function portableEmojiRow(store: string, row: any, tokens: Map<string, string>) {
    if (!tokens.size) return row;
    if (store === 'emojis' && tokens.has(row.url)) return { ...row, url: tokens.get(row.url) };
    if (store === 'messages' && row.type === 'emoji' && tokens.has(row.content)) return { ...row, content: tokens.get(row.content) };
    if (store === 'assets' && row.id === HELP_HISTORY_KEY && Array.isArray(row.data)) return { ...row, data: row.data.map((record: any) => {
        const item = record.attachment;
        return item?.kind === 'sticker' && tokens.has(item.url) ? { ...record, attachment: { ...item, url: tokens.get(item.url) } } : record;
    }) };
    return row;
}
