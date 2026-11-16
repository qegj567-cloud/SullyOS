import { getPostOfficeBase } from './postOffice';
import { isBifangBase, SIGNAL_ARCHIVE_REVISION as revision } from './bifangConfig';

const KEY = 'signal_ownership_recovery';
export const SIGNAL_OWNERSHIP_RECOVERED = 'vr-signal-ownership-recovered';
const RETRY_MS = 60 * 60_000;
const inFlight = new Map<string, Promise<boolean>>();
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function retryLater(delay: number) {
    if (typeof window === 'undefined' || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = undefined; void recoverSignalOwnership(); }, delay);
}

/** Runs after storage restoration, on memorial reads, and on a failed-attempt timer.
 * It never creates an identity or sends private character names/local authorship maps.
 */
export function recoverSignalOwnership(): Promise<boolean> {
    let device: string, base: string, cached: any;
    try {
        device = localStorage.getItem('vr_po_device') || '';
        base = getPostOfficeBase();
        if (!device || device === 'dev-anonymous' || !isBifangBase(base)) return Promise.resolve(false);
        try { cached = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { cached = null; }
        if (cached?.device === device && cached?.base === base && cached?.revision === revision) {
            if (cached.completed === true) return Promise.resolve(true);
            if (Number.isFinite(cached.retryAt) && cached.retryAt > Date.now()) {
                retryLater(Math.min(cached.retryAt - Date.now(), RETRY_MS));
                return Promise.resolve(false);
            }
        }
    } catch { return Promise.resolve(false); }
    const key = `${base}|${device}`;
    const pending = inFlight.get(key);
    if (pending) return pending;
    const task = (async () => {
        let completed = false;
        let delay = RETRY_MS;
        try {
            const response = await fetch(`${base}/poem/recover-ownership`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ device }), signal: AbortSignal.timeout(20_000),
            });
            const result = await response.json();
            completed = response.ok && result?.ok === true && result.completed === true && result.revision === revision;
            if (Number.isFinite(result?.retryAfterMs)) delay = Math.max(60_000, Math.min(RETRY_MS, result.retryAfterMs));
        } catch { /* Network failure leaves the public archive readable. */ }
        try {
            // A backup import or identity change may have happened while the request was running.
            if (localStorage.getItem('vr_po_device') === device && getPostOfficeBase() === base) {
                localStorage.setItem(KEY, JSON.stringify({ device, base, revision, completed, retryAt: completed ? 0 : Date.now() + delay }));
                if (completed && typeof window !== 'undefined') window.dispatchEvent(new Event(SIGNAL_OWNERSHIP_RECOVERED));
                if (!completed) retryLater(delay);
            }
        } catch { /* Server-side completion is durable even if localStorage is full. */ }
        return completed;
    })().finally(() => { inFlight.delete(key); });
    inFlight.set(key, task);
    return task;
}
