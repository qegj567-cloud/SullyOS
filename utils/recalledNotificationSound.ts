import { readRememberedBeautyAuthor } from './beautyAuthorBackup';

// Fingerprint of the 15,096-byte audio accidentally bundled in S-839B0926A7D1.
// Keep only the digest, never ship the private recording with the application.
export const RECALLED_SOUND_HASH = '05dd2c96a5da40e082def00d2717459346d5c7882befcec94c756828d1c5d792';
const OWNER = 'A-AC8B38B60D1CD6B2';
const BYTE_LENGTH = 15096;
export const RECALLED_SOUND_EVENT = 'sully-recalled-notification-sound';
const NOTICE_KEY = 'sullyos_notice_recalled_sound_20261115';
let pendingNotice = false;
let acknowledged = false;
const checks = new Map<string, Promise<boolean>>();

export function isRecalledSoundOwner(): boolean {
    if (readRememberedBeautyAuthor()?.authorCode === OWNER) return true;
    try {
        const session = JSON.parse(localStorage.getItem('sully-beauty-author-session-v1') || 'null');
        return session?.authorCode === OWNER && session.expiresAt > Date.now()
            && typeof session.token === 'string' && /^[a-f0-9]{64}$/.test(session.token);
    } catch { return false; }
}

/** Check only the inline recording about to play. No network, DB, or library scan.
 * Different MIME labels/whitespace still compare the decoded bytes. Other lengths
 * skip hashing; shared promises coalesce concurrent notifications. */
export function isRecalledNotificationSound(src: string): Promise<boolean> {
    const cached = checks.get(src);
    if (cached) return cached;
    if (!/^data:audio\//i.test(src) || src.length > 32768) return Promise.resolve(false);
    const comma = src.indexOf(',');
    if (comma < 0 || !/;base64$/i.test(src.slice(0, comma))) return Promise.resolve(false);
    const encoded = src.slice(comma + 1).replace(/\s/g, '');
    if (encoded.length !== Math.ceil(BYTE_LENGTH / 3) * 4) return Promise.resolve(false);
    const check = (async () => {
        const binary = atob(encoded);
        if (binary.length !== BYTE_LENGTH) return false;
        const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('') === RECALLED_SOUND_HASH;
    })();
    // Bounded by 32 small candidate data URLs, not every sound ever encountered.
    if (checks.size >= 32) checks.delete(checks.keys().next().value!);
    checks.set(src, check);
    // A transient crypto failure may retry next time. Never play an unchecked candidate.
    void check.catch(() => { if (checks.get(src) === check) checks.delete(src); });
    return check;
}

export function hasRecalledSoundNotice(): boolean { return pendingNotice; }
export function acknowledgeRecalledSoundNotice(): void {
    acknowledged = true;
    pendingNotice = false;
    try { localStorage.setItem(NOTICE_KEY, '1'); } catch { /* Memory still suppresses repeats. */ }
}
export function notifyRecalledSound(): void {
    if (acknowledged || pendingNotice) return;
    try { if (localStorage.getItem(NOTICE_KEY) === '1') return; } catch { /* Show once this session. */ }
    pendingNotice = true;
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(RECALLED_SOUND_EVENT));
}

/** Remove only the matching declaration; preserve the rest of the whitebox CSS. */
export function removeRecalledSoundDirective(css: string | undefined, src: string): string | undefined {
    return css?.replace(/\/\*\s*@sully-sound\b[^{}]*(\{[^{}]*\})\s*\*\//gi, (comment, json) => {
        try { return JSON.parse(json)?.src?.trim() === src ? '' : comment; } catch { return comment; }
    });
}

export function resetRecalledSoundSettings(
    settings: { chromeCustomCss?: string; chatChromeCustomCss?: string; chatSound?: { src: string } },
    src: string,
    global = false,
): { chromeCustomCss?: string; chatChromeCustomCss?: string; chatSound?: { src: string }; chatSoundBound?: boolean } | null {
    const key = global ? 'chatChromeCustomCss' : 'chromeCustomCss';
    const css = removeRecalledSoundDirective(settings[key], src);
    if (css === settings[key] && settings.chatSound?.src !== src) return null;
    // Explicit default prevents falling through to another inherited copy.
    return { ...(css !== settings[key] ? { [key]: css } : {}), chatSound: { src: 'none' }, ...(!global ? { chatSoundBound: false } : {}) };
}
