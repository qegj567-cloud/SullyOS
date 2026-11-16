/** Shared public addresses; no credentials belong in this module. */
export const BIFANG_BASE = 'https://bifang.friedsully.com/po';
export const LEGACY_POST_OFFICE_BASE = 'https://noir2.cc.cd/po';
export const SIGNAL_ARCHIVE_REVISION = 'noir2-2026-11-16';

export function isBifangBase(base: string): boolean {
    return [BIFANG_BASE, 'https://bifang.qegj567.workers.dev/po'].includes(base.replace(/\/+$/, ''));
}

export function migratePostOfficeBase(base: string): string {
    const clean = base.trim().replace(/\/+$/, '');
    try {
        const url = new URL(clean);
        if (['https:', 'http:'].includes(url.protocol) && url.hostname === 'noir2.cc.cd'
            && !url.port && !url.username && !url.password && !url.search && !url.hash
            && ['', '/', '/po'].includes(url.pathname)) return BIFANG_BASE;
    } catch { /* Preserve explicitly configured third-party addresses. */ }
    return clean;
}
