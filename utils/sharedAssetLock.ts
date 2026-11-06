/** A transfer holds a shared lease from reading its source through committing references.
 * Deletion waits for all leases, then scans references again. Web Locks span tabs. */
const LOCK = 'sully-shared-asset-references-v1';
let tail: Promise<unknown> = Promise.resolve();
export async function withSharedAssetLock<T>(mode: 'shared' | 'exclusive', action: () => Promise<T>): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator.locks?.request) return navigator.locks.request(LOCK, { mode }, action);
    const run = tail.then(action, action);
    tail = run.catch(() => undefined);
    return run;
}
export const canCoordinateAssetDeletion = () => typeof window === 'undefined' || typeof navigator !== 'undefined' && !!navigator.locks?.request;
