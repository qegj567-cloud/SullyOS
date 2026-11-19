import type { Emoji } from '../types';
import { BLOBREF_PREFIX, isBlobRef } from './blobRef';
import { DB } from './db';
import { isRemoteEmoji, loadEmojiOriginal, probeEmojiBlob, probeEmojiImage } from './emojiOriginals';

export type EmojiHealth = 'usable' | 'missing' | 'unknown';
export async function checkEmoji(url: string): Promise<EmojiHealth> {
    try {
        if (isBlobRef(url)) {
            // The display helper returns null on I/O errors too. Only a successful empty read permits removal.
            const blob = await DB.getBlobAsset(url.slice(BLOBREF_PREFIX.length));
            if (!blob) return 'missing';
            return await probeEmojiBlob(blob) === 'ok' ? 'usable' : 'unknown';
        }
        let missing = false;
        if (isRemoteEmoji(url)) {
            const original = await loadEmojiOriginal(url, true);
            if (original.blob) return 'usable';
            missing = !!original.missing;
        }
        if (!url) return 'missing';
        // A host can forbid reading the bytes while still serving a normal <img>.
        const display = await probeEmojiImage(url);
        if (display === 'ok') return 'usable';
        return display === 'error' && missing ? 'missing' : 'unknown';
    } catch { return 'unknown'; }
}

export type EmojiScan = Record<EmojiHealth, Emoji[]>;
export async function scanEmojiLibrary(emojis: Emoji[], signal: AbortSignal, progress: (count: number) => void) {
    const grouped = new Map<string, Emoji[]>();
    for (const emoji of emojis) {
        const group = grouped.get(emoji.url);
        if (group) group.push(emoji);
        else grouped.set(emoji.url, [emoji]);
    }
    const queue = grouped.entries();
    const result: EmojiScan = { usable: [], missing: [], unknown: [] };
    let checked = 0;
    async function worker() {
        while (!signal.aborted) {
            const next = queue.next();
            if (next.done) return;
            const [url, items] = next.value;
            const status = await checkEmoji(url);
            if (signal.aborted) return;
            for (const item of items) result[status].push(item);
            checked += items.length;
            progress(checked);
        }
    }
    await Promise.all(Array.from({ length: Math.min(grouped.size, 4) }, worker));
    return result;
}
