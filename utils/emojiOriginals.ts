import { spaceDatabaseName } from './userSpaces';

// Per-space, disposable copies. Keep original URLs in the library and in old messages.
export const emojiCacheName = (spaceId?: string) => spaceDatabaseName('sully-emoji-originals-v1', spaceId);
export function hasEmojiCacheStorage(): boolean {
    try { return !!globalThis.caches; } catch { return false; }
}
export async function clearEmojiOriginals(spaceId: string) {
    if (hasEmojiCacheStorage()) await caches.delete(emojiCacheName(spaceId));
}
export const isRemoteEmoji = (url: string) => /^https?:\/\//i.test(url);

export async function cachedEmojiOriginal(url: string): Promise<Blob | undefined> {
    if (!isRemoteEmoji(url) || typeof caches === 'undefined') return;
    const cache = await caches.open(emojiCacheName());
    const response = await cache.match(url);
    if (response) {
        const blob = await response.blob();
        if (blob.size) return blob;
    }
}

const timeoutMs = 12000;
/** Only a definite load error counts as a failed display. Slow/offline clients can retry. */
export function probeEmojiImage(src: string): Promise<'ok' | 'error' | 'timeout'> {
    return new Promise(resolve => {
        const img = new Image();
        const finish = (result: 'ok' | 'error' | 'timeout') => {
            clearTimeout(timer);
            img.onload = img.onerror = null;
            img.removeAttribute('src');
            resolve(result);
        };
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
        img.onload = () => finish('ok');
        img.onerror = () => finish('error');
        img.src = src;
    });
}

export async function probeEmojiBlob(blob: Blob) {
    const url = URL.createObjectURL(blob);
    try { return await probeEmojiImage(url); }
    finally { URL.revokeObjectURL(url); }
}

// Verify that an actual image was delivered before persisting it (some hosts return HTML with HTTP 200).
export async function rememberEmojiOriginal(url: string, blob: Blob): Promise<boolean> {
    if (!blob.size || await probeEmojiBlob(blob) !== 'ok') return false;
    try {
        const cache = await caches.open(emojiCacheName());
        await cache.put(url, new Response(blob));
    } catch { /* Display can still use the downloaded bytes when storage is disabled/full. */ }
    return true;
}

type Original = { blob?: Blob; missing?: boolean };
const pending = new Map<string, Promise<Original>>();

async function resolveOriginal(url: string, retry: boolean): Promise<Original> {
    let cacheReadable = true;
    try {
        const blob = await cachedEmojiOriginal(url);
        if (blob) return { blob };
    } catch { cacheReadable = false; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        // A cross-origin byte read can fail while the same URL still displays in an img.
        const response = await fetch(url, { signal: controller.signal, cache: retry ? 'reload' : 'default', __sullyHandlesFailure: true } as RequestInit);
        if (!response.ok) return { missing: cacheReadable && (response.status === 404 || response.status === 410) };
        const blob = await response.blob();
        return await rememberEmojiOriginal(url, blob) ? { blob } : {};
    } catch { return {}; }
    finally { clearTimeout(timer); }
}

export function loadEmojiOriginal(url: string, retry = false): Promise<Original> {
    const key = (retry ? 'retry:' : '') + url;
    const existing = pending.get(key);
    if (existing) return existing;
    const request = resolveOriginal(url, retry).finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
}
