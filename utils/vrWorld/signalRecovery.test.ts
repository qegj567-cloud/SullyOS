import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { BIFANG_BASE, SIGNAL_ARCHIVE_REVISION as revision } from './bifangConfig';
import { getPostOfficeBase, importPostOfficeLocal } from './postOffice';
import { recoverSignalOwnership } from './signalRecovery';

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });
it('migrates the exact old default, including imported backups, and preserves custom destinations', () => {
    expect(getPostOfficeBase()).toBe(BIFANG_BASE);
    importPostOfficeLocal({ vr_po_base: 'https://noir2.cc.cd/po/', vr_po_device: 'old-id' });
    expect(getPostOfficeBase()).toBe(BIFANG_BASE); expect(localStorage.getItem('vr_po_device')).toBe('old-id');
    for (const url of ['https://mine.example/po', 'https://noir2.cc.cd.example/po', 'https://noir2.cc.cd/custom', 'https://example.org/noir2.cc.cd']) {
        localStorage.setItem('vr_po_base', url); expect(getPostOfficeBase()).toBe(url);
    }
});
it('skips new identities/custom backends and never creates an identity merely to recover', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(await recoverSignalOwnership()).toBe(false); expect(localStorage.getItem('vr_po_device')).toBeNull();
    localStorage.setItem('vr_po_device', 'old-id'); localStorage.setItem('vr_po_base', 'https://mine.example/po');
    expect(await recoverSignalOwnership()).toBe(false); expect(fetcher).not.toHaveBeenCalled();
});
it('deduplicates concurrent requests, sends only the identity, caches by identity, and preserves role attribution', async () => {
    localStorage.setItem('vr_po_device', 'old-id'); localStorage.setItem('signal_my_authorship', '{"p":{"3":"角色"}}');
    const fetcher = vi.fn(async () => Response.json({ ok: true, completed: true, revision })); vi.stubGlobal('fetch', fetcher);
    expect(await Promise.all([recoverSignalOwnership(), recoverSignalOwnership()])).toEqual([true, true]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetcher.mock.calls[0] as any)[1].body)).toEqual({ device: 'old-id' });
    expect(await recoverSignalOwnership()).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('signal_my_authorship')).toBe('{"p":{"3":"角色"}}');
    localStorage.setItem('vr_po_device', 'other-id'); await recoverSignalOwnership(); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('does not mark failure complete and retries after its cooldown', async () => {
    localStorage.setItem('vr_po_device', 'old-id');
    const fetcher = vi.fn(async () => Response.json({ ok: false }, { status: 503 })); vi.stubGlobal('fetch', fetcher);
    expect(await recoverSignalOwnership()).toBe(false); expect(await recoverSignalOwnership()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const cache = JSON.parse(localStorage.getItem('signal_ownership_recovery')!); expect(cache.completed).toBe(false);
    localStorage.setItem('signal_ownership_recovery', JSON.stringify({ ...cache, retryAt: 0 }));
    fetcher.mockImplementation(async () => Response.json({ ok: true, completed: true, revision }));
    expect(await recoverSignalOwnership()).toBe(true);
});
it('does not overwrite a newly imported identity when the old request resolves', async () => {
    localStorage.setItem('vr_po_device', 'old-id');
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(yes => { resolve = yes; })));
    const task = recoverSignalOwnership(); localStorage.setItem('vr_po_device', 'new-id');
    resolve(Response.json({ ok: true, completed: true, revision })); await task;
    expect(localStorage.getItem('signal_ownership_recovery')).toBeNull();
});
