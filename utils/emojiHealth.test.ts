import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cachedEmojiOriginal, emojiCacheName, loadEmojiOriginal } from './emojiOriginals';
import { checkEmoji, scanEmojiLibrary } from './emojiHealth';
import { prepareEmojiExport } from './emojiExport';
import { DB } from './db';
import { collectEmojiBackup, portableEmojiRow } from './emojiBackup';

const url = 'https://example.test/cat.gif';
const bytes = 'GIF89a-animated-original';
let entries: Map<string, Response>;
let displayable: (source: string) => boolean;
const network = vi.fn<typeof fetch>();

beforeEach(() => {
    entries = new Map();
    displayable = source => source.startsWith('blob:');
    vi.stubGlobal('caches', { has: async () => true, open: async () => ({
        match: async (key: string) => entries.get(key)?.clone(),
        put: async (key: string, response: Response) => { entries.set(key, response); },
    }) });
    vi.stubGlobal('fetch', network.mockReset());
    vi.stubGlobal('Image', class {
        onload?: () => void;
        onerror?: () => void;
        set src(value: string) { queueMicrotask(() => displayable(value) ? this.onload?.() : this.onerror?.()); }
        removeAttribute() {}
    });
});
afterEach(() => vi.unstubAllGlobals());

it('shares an in-flight fetch and persists original bytes for offline display, scanning and export', async () => {
    network.mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Type': 'image/gif' } }));
    const [a, b] = await Promise.all([loadEmojiOriginal(url), loadEmojiOriginal(url)]);
    expect(a.blob).toBe(b.blob);
    expect(await (await cachedEmojiOriginal(url))!.text()).toBe(bytes);
    network.mockRejectedValue(new Error('offline'));
    expect(await checkEmoji(url)).toBe('usable');
    expect(await (await loadEmojiOriginal(url)).blob!.text()).toBe(bytes);
    expect(await (await prepareEmojiExport([{ name: '猫', url }])).blob.text()).toBe(bytes);
    expect(network).toHaveBeenCalledTimes(1);
    expect(emojiCacheName('u_a')).not.toBe(emojiCacheName('u_b'));
    const { tokens, blobs } = await collectEmojiBackup([url, url]);
    const token = tokens.get(url)!;
    expect(token).toMatch(/^blobref:emoji_/);
    expect(await blobs.get(token)!.text()).toBe(bytes);
    expect(portableEmojiRow('messages', { type: 'emoji', content: url }, tokens).content).toBe(token);
    expect(portableEmojiRow('messages', { type: 'text', content: url }, tokens).content).toBe(url);
    expect(network).toHaveBeenCalledTimes(1);
});

it('keeps display-only links, temporary failures and unreadable local storage out of cleanup', async () => {
    network.mockRejectedValue(new TypeError('CORS'));
    displayable = source => source === url;
    expect(await checkEmoji(url)).toBe('usable');
    expect(entries.size).toBe(0);
    displayable = () => false;
    expect(await checkEmoji(url)).toBe('unknown');
    for (const status of [403, 429, 503]) {
        network.mockResolvedValueOnce(new Response(null, { status }));
        expect(await checkEmoji(url)).toBe('unknown');
    }
    network.mockResolvedValueOnce(new Response('<html>missing</html>'));
    expect(await checkEmoji(url)).toBe('unknown');
    expect(entries.size).toBe(0);
    network.mockResolvedValueOnce(new Response(null, { status: 410 }));
    expect(await checkEmoji(url)).toBe('missing');
    vi.stubGlobal('caches', { open: async () => { throw new Error('storage denied'); } });
    network.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await checkEmoji(url)).toBe('unknown');
});

it('checks each unique URL once across categories and never deletes on scan', async () => {
    network.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const first = { name: '坏图', url, categoryId: 'a' };
    const second = { name: '同一外链', url, categoryId: 'b' };
    const local = { name: '丢失的本机文件', url: 'blobref:b_missing', categoryId: 'b' };
    for (const e of [first, second, local]) await DB.saveEmoji(e.name, e.url, e.categoryId);
    const progress = vi.fn();
    const { missing } = await scanEmojiLibrary([first, second, local], new AbortController().signal, progress);
    expect(missing).toHaveLength(3);
    expect(network).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith(3);
    expect(await DB.getEmojis()).toEqual(expect.arrayContaining([first, second, local]));
    // A second tab repaired one item and reassigned another during confirmation.
    await DB.saveEmoji(first.name, 'https://example.test/repaired', first.categoryId);
    await DB.saveEmoji(second.name, second.url, 'new-category');
    expect(await DB.deleteScannedEmojis(missing)).toBe(1);
    expect(await DB.deleteScannedEmojis(missing)).toBe(0);
    expect((await DB.getEmojis()).find(e => e.name === second.name)?.categoryId).toBe('new-category');
});

it('stopping a scan leaves queued sources untouched', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    network.mockReturnValue(pending);
    const controller = new AbortController();
    const items = Array.from({ length: 20 }, (_, index) => ({ name: String(index), url: url + '?' + index }));
    const progress = vi.fn();
    const scanning = scanEmojiLibrary(items, controller.signal, progress);
    await vi.waitFor(() => expect(network).toHaveBeenCalledTimes(4));
    controller.abort();
    finish(new Response(null, { status: 503 }));
    await scanning;
    expect(network).toHaveBeenCalledTimes(4);
    expect(progress).not.toHaveBeenCalled();
});

it('keeps local originals when IndexedDB fails to read their bytes', async () => {
    const read = vi.spyOn(DB, 'getBlobAsset').mockRejectedValue(new Error('database temporarily unavailable'));
    try { expect(await checkEmoji('blobref:b_local')).toBe('unknown'); }
    finally { read.mockRestore(); }
});
