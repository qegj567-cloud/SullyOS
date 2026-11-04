import { DB, openDB } from './db';
import { getBlobForRef, isBlobRef, putImageBlob } from './blobRef';
import { dataUrlToBlob } from '@rei-standard/blob-store';
import sully from '../presets/appearance/sully.json';

export const SULLY_BIBI_UPGRADE_KEY = 'builtin_sully_bibi_icon_v1';
// Byte fingerprints of the shipped artwork, not a guess based on theme colours.
const anchors = {
    chat: '3f7a29d01156a1f02293152ed3e8c45a371c36805de10658b9820278fc7c362c',
    character: '36359153b51e0e9e59e1e11a7fffb9c106c984f92ef28b91bb305ee550fd0722',
    appearance: '05513bb64cc802fe7a0ca756e1840f4d31b09422d63218a828215298e50afa9a',
} as const;
const iconHash = '6468315afb1c7e66766f4e4015896bc7bf876ee095e35551c0f3aa0770ea8633';
const assetUrl = (path: string) => import.meta.env.BASE_URL + path.replace(/^\//, '');
async function fingerprint(blob: Blob) {
    const bytes = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

export function sameSullyIconSnapshot(current: Record<string, string>, snapshot: Record<string, string>) {
    return ['friend_feed', ...Object.keys(anchors)].every(key => current[key] === snapshot[key]);
}

async function matchesOriginal(key: keyof typeof anchors, value?: string) {
    if (!value) return false;
    const path = sully.customIcons[key];
    if (value === path || value === assetUrl(path)) return true;
    // Only read local bytes. Never fetch a user's custom image URL to identify a theme.
    const blob = isBlobRef(value) ? await getBlobForRef(value) : value.startsWith('data:') ? dataUrlToBlob(value) : null;
    return blob ? await fingerprint(blob) === anchors[key] : false;
}

/** Backfill only the missing icon. Run after startup hydration; never delay opening the desktop. */
export async function upgradeBuiltinSullyBibiIcon(snapshot: Record<string, string>): Promise<string | null> {
    if (snapshot.friend_feed || await DB.getAsset(SULLY_BIBI_UPGRADE_KEY)) return null;
    const matches = await Promise.all((Object.keys(anchors) as Array<keyof typeof anchors>).map(key => matchesOriginal(key, snapshot[key])));
    // Allow one customised icon while requiring two independent original images.
    if (matches.filter(Boolean).length < 2) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let blob: Blob;
    try {
        const response = await fetch(assetUrl(sully.customIcons.friend_feed), { signal: controller.signal });
        if (!response.ok) throw new Error('Builtin icon unavailable');
        blob = await response.blob();
        if (!blob.type.startsWith('image/') || await fingerprint(blob) !== iconHash) throw new Error('Builtin icon verification failed');
    } finally { clearTimeout(timeout); }
    const stored = await putImageBlob(blob);
    const db = await openDB();
    // Recheck current persisted values in the same transaction as the write, so a
    // second tab, theme switch or manual icon edit wins over a delayed download.
    return new Promise((resolve, reject) => {
        const tx = db.transaction('assets', 'readwrite'), store = tx.objectStore('assets');
        const expected: Record<string, string | null> = { [SULLY_BIBI_UPGRADE_KEY]: null };
        for (const key of ['friend_feed', ...Object.keys(anchors)]) expected['icon_' + key] = snapshot[key] || null;
        let remaining = Object.keys(expected).length, unchanged = true, committed = false;
        for (const [key, value] of Object.entries(expected)) {
            const request = store.get(key);
            request.onsuccess = () => {
                if ((request.result?.data || null) !== value) unchanged = false;
                if (--remaining === 0 && unchanged) {
                    store.put({ id: 'icon_friend_feed', data: stored });
                    store.put({ id: SULLY_BIBI_UPGRADE_KEY, data: '1' });
                    committed = true;
                }
            };
        }
        tx.oncomplete = () => resolve(committed ? stored : null);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Builtin icon upgrade aborted'));
    });
}
